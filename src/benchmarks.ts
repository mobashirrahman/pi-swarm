/**
 * Model intelligence benchmarks.
 *
 * Two sources, in priority order:
 *
 *  1. LIVE OpenRouter scores — its public `/models` endpoint embeds Artificial
 *     Analysis `intelligence_index` / `coding_index` / `agentic_index` for
 *     ~250 models, including free ones. No API key. Auto-updating.
 *  2. VENDORED table — 611 entries (Artificial Analysis data, dated) with
 *     `codingIndex`, `gpqa`, and `hle`. Covers models OpenRouter does not
 *     serve, and is the only source for providers whose catalogs carry no
 *     scores at all (gemini, nvidia, zai, tiyuvta, …).
 *
 * Why both: the live source is authoritative where it applies but only covers
 * OpenRouter's catalog; the vendored table is stale but broad. A model matched
 * by neither is UNSCORED — which routing must treat as "unknown quality", not
 * as "bad" (see the selector's quality band).
 *
 * Matching is fuzzy by necessity: the same model appears as `GLM-5.3-Flash`,
 * `z-ai/glm-5.3-flash`, `glm-5.3-flash:free`, `glm-5.3-flash-20260826`, etc.
 * The matcher canonicalizes those forms and reports its confidence so a weak
 * match never silently outranks a strong one.
 */

import { readFileSync } from "node:fs";
import { createLogger } from "./logger.ts";

const _logger = createLogger("benchmarks");

export interface ModelScore {
	/** Artificial Analysis coding index (0–100), when known. */
	codingIndex?: number | undefined;
	/** Artificial Analysis intelligence index (0–100), when known. */
	intelligenceIndex?: number | undefined;
	/** Agentic index — most relevant for tool-using swarm agents. */
	agenticIndex?: number | undefined;
	gpqa?: number | undefined;
	hle?: number | undefined;
	contextWindow?: number | undefined;
	/** Where the score came from. */
	source: "openrouter" | "vendored";
	/** How the match was made; `exact` is trustworthy, `prefix` less so. */
	confidence: "exact" | "alias" | "prefix" | "tokens";
}

interface VendoredEntry {
	contextWindow?: number;
	codingIndex?: number;
	gpqa?: number;
	hle?: number;
	originalModel?: string;
	lastUpdated?: string;
}

/** Canonicalize a model id/name for cross-provider matching. */
export function canonicalModelKey(raw: string): string {
	let value = raw.toLowerCase().trim();
	// Strip a vendor/org prefix (`z-ai/glm-5.3-flash`, `meta-llama/Llama-3`).
	value = value.replace(/^[^/]+\//g, "");
	// Free-tier markers.
	value = value.replace(/:(free|beta|extended|nitro|floor)$/g, "");
	value = value.replace(/[-_](free|beta|latest|preview|experimental)$/g, "");
	// Date / build qualifiers: `-20260826`, `-2026-08-26`.
	value = value.replace(/[-_]\d{8}$/g, "");
	value = value.replace(/[-_]\d{4}[-_]\d{2}[-_]\d{2}$/g, "");
	// Trailing version dots used by some gateways: `glm-5.3.1` → keep, but
	// drop a trailing `-v1`/`-v2` style tag.
	value = value.replace(/[-_]v\d+$/g, "");
	// Unify separators: dots and underscores become dashes so `glm-5.3-flash`
	// and `glm_5_3_flash` agree.
	value = value.replace(/[._]/g, "-");
	// Collapse repeats and trim.
	value = value.replace(/-+/g, "-").replace(/^-|-$/g, "");
	return value;
}

/** Alias pairs where canonicalization alone will not bridge the naming. */
const ALIASES: Record<string, string> = {
	"claude-3-5-sonnet": "claude-3-5-sonnet-latest",
	"gpt-4o-mini": "gpt-4o-mini",
	"llama-3-3-70b": "llama-3-3-70b-instruct",
	"deepseek-v3": "deepseek-v3-chat",
	"qwen-2-5-72b": "qwen-2-5-72b-instruct",
	"gemini-2-0-flash": "gemini-2-0-flash-001",
};

interface IndexedEntry {
	key: string;
	entry: VendoredEntry;
}

let vendoredIndex: IndexedEntry[] | undefined;
let prefixIndex: Map<string, IndexedEntry[]> | undefined;
let liveScores: Map<string, ModelScore> | undefined;

function loadVendored(): IndexedEntry[] {
	if (vendoredIndex) return vendoredIndex;
	try {
		const raw = readFileSync(new URL("./data/benchmarks.json", import.meta.url), "utf8");
		const parsed = JSON.parse(raw) as Record<string, VendoredEntry>;
		vendoredIndex = Object.entries(parsed).map(([key, entry]) => ({
			key: canonicalModelKey(entry.originalModel ?? key),
			entry,
		}));
	} catch (error) {
		_logger.warn("benchmark_table_unavailable", {
			error: error instanceof Error ? error.message : String(error),
		});
		vendoredIndex = [];
	}
	return vendoredIndex;
}

/** Prefix index: every leading segment combination → entries starting with it. */
function loadPrefixIndex(): Map<string, IndexedEntry[]> {
	if (prefixIndex) return prefixIndex;
	const index = new Map<string, IndexedEntry[]>();
	for (const item of loadVendored()) {
		const segments = item.key.split("-");
		for (let end = 1; end <= segments.length; end++) {
			const prefix = segments.slice(0, end).join("-");
			const bucket = index.get(prefix) ?? [];
			bucket.push(item);
			index.set(prefix, bucket);
		}
	}
	prefixIndex = index;
	return index;
}

/** Token-overlap fallback: share enough significant tokens to be the same model. */
function tokenScore(a: string, b: string): number {
	const left = new Set(a.split("-").filter((token) => token.length > 1));
	const right = new Set(b.split("-").filter((token) => token.length > 1));
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const token of left) if (right.has(token)) shared += 1;
	return shared / Math.max(left.size, right.size);
}

/**
 * Install live scores keyed by canonical id. Called with the OpenRouter
 * catalog's `benchmarks.artificial_analysis` payload.
 */
export function setLiveScores(entries: Array<{ modelId: string; intelligenceIndex?: number; codingIndex?: number; agenticIndex?: number }>): number {
	const map = new Map<string, ModelScore>();
	for (const entry of entries) {
		if (entry.intelligenceIndex === undefined && entry.codingIndex === undefined && entry.agenticIndex === undefined) continue;
		map.set(canonicalModelKey(entry.modelId), {
			codingIndex: entry.codingIndex,
			intelligenceIndex: entry.intelligenceIndex,
			agenticIndex: entry.agenticIndex,
			source: "openrouter",
			confidence: "exact",
		});
	}
	liveScores = map;
	return map.size;
}

/** Test seam: drop cached indices and live scores. */
export function resetBenchmarkCaches(): void {
	vendoredIndex = undefined;
	prefixIndex = undefined;
	liveScores = undefined;
}

/**
 * Score a model. Returns undefined when nothing matches — callers must treat
 * that as unknown, never as zero.
 */
export function lookupModelScore(modelId: string, displayName?: string): ModelScore | undefined {
	const candidates = [modelId, displayName].filter((value): value is string => typeof value === "string" && value.length > 0);

	for (const candidate of candidates) {
		const key = canonicalModelKey(candidate);

		// 1. Live OpenRouter score (authoritative where present).
		const live = liveScores?.get(key);
		if (live) return live;

		// 2. Exact canonical match against the vendored table.
		const vendored = loadVendored();
		const exact = vendored.find((item) => item.key === key);
		if (exact) return toScore(exact.entry, "exact");

		// 3. Explicit alias.
		const aliased = ALIASES[key];
		if (aliased) {
			const viaAlias = vendored.find((item) => item.key === canonicalModelKey(aliased));
			if (viaAlias) return toScore(viaAlias.entry, "alias");
		}

		// 4. Longest-prefix match: the lookup key starts with a known model key
		//    (handles trailing qualifiers canonicalization missed).
		const buckets = loadPrefixIndex();
		const segments = key.split("-");
		for (let end = segments.length; end >= 2; end--) {
			const bucket = buckets.get(segments.slice(0, end).join("-"));
			if (!bucket || bucket.length === 0) continue;
			const best = bucket.find((item) => item.key === key) ?? bucket[0];
			if (best) return toScore(best.entry, "prefix");
		}

		// 5. Token overlap, requiring a strong majority to avoid nonsense.
		let best: { item: IndexedEntry; score: number } | undefined;
		for (const item of vendored) {
			const score = tokenScore(key, item.key);
			if (score >= 0.75 && (!best || score > best.score)) best = { item, score };
		}
		if (best) return toScore(best.item.entry, "tokens");
	}

	return undefined;
}

function toScore(entry: VendoredEntry, confidence: ModelScore["confidence"]): ModelScore {
	return {
		codingIndex: entry.codingIndex,
		gpqa: entry.gpqa,
		hle: entry.hle,
		contextWindow: entry.contextWindow,
		source: "vendored",
		confidence,
	};
}

/** Benchmark table size, for diagnostics. */
export function benchmarkTableSize(): number {
	return loadVendored().length;
}

/** Live-score coverage, for diagnostics. */
export function liveScoreCount(): number {
	return liveScores?.size ?? 0;
}

/**
 * Fetch Artificial Analysis scores from OpenRouter's PUBLIC /models endpoint.
 * No API key, no auth — and it covers free models, which is what the swarm
 * routes to. Best-effort: a failure leaves the vendored table in charge.
 */
export async function fetchOpenRouterScores(
	options: { baseUrl?: string; signal?: AbortSignal } = {},
): Promise<{ installed: number; error?: string }> {
	const baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
	try {
		const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
			headers: { Accept: "application/json" },
			signal: options.signal ?? AbortSignal.timeout(20_000),
		});
		if (!response.ok) return { installed: 0, error: `HTTP ${response.status}` };

		const body = (await response.json()) as {
			data?: Array<{
				id?: string;
				benchmarks?: { artificial_analysis?: { intelligence_index?: number | null; coding_index?: number | null; agentic_index?: number | null } };
			}>;
		};
		const entries: Array<{ modelId: string; intelligenceIndex?: number; codingIndex?: number; agenticIndex?: number }> = [];
		for (const model of body.data ?? []) {
			const scores = model.benchmarks?.artificial_analysis;
			if (!model.id || !scores) continue;
			entries.push({
				modelId: model.id,
				...(typeof scores.intelligence_index === "number" ? { intelligenceIndex: scores.intelligence_index } : {}),
				...(typeof scores.coding_index === "number" ? { codingIndex: scores.coding_index } : {}),
				...(typeof scores.agentic_index === "number" ? { agenticIndex: scores.agentic_index } : {}),
			});
		}
		const installed = setLiveScores(entries);
		_logger.info("openrouter_scores_installed", { models: installed });
		return { installed };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		_logger.warn("openrouter_scores_unavailable", { error: message });
		return { installed: 0, error: message };
	}
}