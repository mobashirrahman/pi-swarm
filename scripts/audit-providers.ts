/**
 * Live provider audit: probe every provider's /models endpoint and record
 * the evidence the plan requires before a provider joins the pool:
 *
 *   - catalog reachability (anonymous and/or credentialed)
 *   - free/paid classification of its chat models
 *   - WHICH rate-limit headers the provider actually sends (the quota
 *     ledger's only authoritative input)
 *   - chat reachability (one minimal request) where a credential exists or
 *     the provider serves anonymous chat
 *
 * Output: docs/provider-audit.md (dated snapshot, never a guarantee) plus a
 * machine-readable JSON summary on stdout.
 *
 * Usage: npx tsx scripts/audit-providers.ts [--only id,id] [--chat]
 *
 * Keys are read from the environment and NEVER printed. Header NAMES are
 * printed; header VALUES never are.
 */

import { writeFileSync } from "node:fs";
import { PROVIDER_SEEDS, type ProviderSeed } from "../src/providers.ts";
import { extractQuotaHeaders } from "../src/quota-headers.ts";

interface AuditResult {
	providerId: string;
	category: ProviderSeed["category"];
	baseUrl: string;
	credentialPresent: boolean;
	catalogStatus: number | "network_error";
	chatModels: number;
	freeChatModels: number;
	/** Rate-limit header NAMES seen on the catalog response. */
	quotaHeaderNames: string[];
	/** True when a known quota pair was parsed. */
	quotaParsed: boolean;
	/** Anonymous chat candidates that answered 200. */
	anonymousChatWorking: string[];
	chatStatus?: number | "not_attempted";
	chatModel?: string;
	notes: string[];
}

const args = new Set(process.argv.slice(2));
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex !== -1 ? (process.argv[onlyIndex + 1] ?? "").split(",").filter(Boolean) : [];
const tryChat = args.has("--chat");

/** Rate-limit-ish header names, for the drift report. */
function quotaHeaderNames(headers: Headers): string[] {
	const names: string[] = [];
	headers.forEach((_value, name) => {
		const lower = name.toLowerCase();
		if (/ratelimit|retry-after|quota|limit/.test(lower)) names.push(lower);
	});
	return names.sort();
}

interface WireModel {
	id: string;
	model_type?: string | undefined;
	tier?: string | undefined;
	pricing?: { input?: number | string; output?: number | string; prompt?: number | string; completion?: number | string } | undefined;
}

function isChatModel(model: WireModel): boolean {
	return model.model_type === undefined || model.model_type === "chat";
}

function isFreeModel(model: WireModel): boolean {
	const pricing = model.pricing;
	if (!pricing) return true;
	const num = (value: number | string | undefined): number => (typeof value === "string" ? Number.parseFloat(value) : (value ?? 0));
	return num(pricing.input ?? pricing.prompt) === 0 && num(pricing.output ?? pricing.completion) === 0;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: unknown; response: Response } | "network_error"> {
	try {
		const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
		const text = await response.text();
		let body: unknown = undefined;
		try {
			body = JSON.parse(text);
		} catch {
			body = undefined;
		}
		return { status: response.status, body, response };
	} catch {
		return "network_error";
	}
}

async function auditProvider(seed: ProviderSeed): Promise<AuditResult> {
	const key = process.env[seed.credentialRef];
	const result: AuditResult = {
		providerId: seed.providerId,
		category: seed.category,
		baseUrl: seed.baseUrl,
		credentialPresent: key !== undefined && key.length > 0,
		catalogStatus: "network_error",
		chatModels: 0,
		freeChatModels: 0,
		quotaHeaderNames: [],
		quotaParsed: false,
		anonymousChatWorking: [],
		notes: [],
	};

	const headers: Record<string, string> = { Accept: "application/json" };
	if (result.credentialPresent) headers.Authorization = `Bearer ${key}`;

	const catalog = await fetchJson(`${seed.baseUrl.replace(/\/$/, "")}/models`, headers);
	if (catalog === "network_error") {
		result.notes.push("catalog unreachable");
		return result;
	}
	result.catalogStatus = catalog.status;
	result.quotaHeaderNames = quotaHeaderNames(catalog.response.headers);
	const parsed = extractQuotaHeaders(Object.fromEntries(catalog.response.headers.entries()), seed.providerId);
	result.quotaParsed = parsed.quotas.length > 0;
	if (result.quotaHeaderNames.length > 0 && !result.quotaParsed) {
		result.notes.push("rate-limit headers present but no known pair matched (drift)");
	}
	if (result.quotaHeaderNames.length === 0) {
		result.notes.push("no rate-limit headers on catalog response");
	}

	const body = catalog.body as { data?: WireModel[] } | WireModel[] | undefined;
	const models = Array.isArray(body) ? body : (body?.data ?? []);
	const chat = models.filter(isChatModel);
	result.chatModels = chat.length;
	// Billing-layer free: a provider that serves chat anonymously bills those
	// models at zero for anonymous callers even when list pricing is nonzero
	// (verified live: llm7 turbo models show $0.01-0.05/1M and still answer
	// keyless). Count the anonymous tier as free.
	const freeByTier = seed.anonymousChat && seed.anonymousTier !== undefined
		? chat.filter((model) => model.tier === seed.anonymousTier).length
		: 0;
	result.freeChatModels = Math.max(chat.filter(isFreeModel).length, freeByTier);
	if (chat.length === 0) result.notes.push("no chat-capable models listed");

	if (!tryChat) {
		result.chatStatus = "not_attempted";
		return result;
	}

	// Chat probe: only when a credential exists or the provider is
	// anonymously chattable. One minimal request, never a body echo.
	const canChat = result.credentialPresent || seed.anonymousChat;
	if (!canChat) {
		result.chatStatus = "not_attempted";
		result.notes.push("chat needs a credential");
		return result;
	}

	// Anonymous access is per-MODEL, not per-tier (verified live: llm7 lists
	// several "turbo" models and only some answer keyless). Probe several
	// candidates so the audit records which ones actually work.
	const candidates = (result.credentialPresent
		? chat.filter(isFreeModel)
		: chat.filter((model) => seed.anonymousTier === undefined || model.tier === seed.anonymousTier)
	).slice(0, 4);
	if (candidates.length === 0) {
		result.chatStatus = "not_attempted";
		result.notes.push("no candidate model for chat probe");
		return result;
	}

	const probeOne = async (modelId: string): Promise<number | "network_error"> => {
		try {
			const response = await fetch(`${seed.baseUrl.replace(/\/$/, "")}/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...(result.credentialPresent ? { Authorization: `Bearer ${key}` } : {}) },
				body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
				signal: AbortSignal.timeout(30_000),
			});
			// Chat responses are where quota headers actually appear.
			for (const name of quotaHeaderNames(response.headers)) {
				if (!result.quotaHeaderNames.includes(name)) result.quotaHeaderNames.push(name);
			}
			if (extractQuotaHeaders(Object.fromEntries(response.headers.entries()), seed.providerId).quotas.length > 0) {
				result.quotaParsed = true;
			}
			return response.status;
		} catch {
			return "network_error";
		}
	};

	const statuses: number[] = [];
	for (const candidate of candidates) {
		const status = await probeOne(candidate.id);
		result.chatModel = candidate.id;
		result.chatStatus = status;
		if (status === 200) {
			result.anonymousChatWorking.push(candidate.id);
			statuses.push(200);
			break; // one working model is enough evidence
		}
		if (typeof status === "number") statuses.push(status);
	}
	if (result.anonymousChatWorking.length === 0 && statuses.length > 0) {
		result.notes.push(`no probed model answered 200 (statuses: ${statuses.join(", ")})`);
	}
	return result;
}

function renderMarkdown(results: AuditResult[], auditedAt: string): string {
	const lines: string[] = [];
	lines.push("# Provider audit");
	lines.push("");
	lines.push(`Dated snapshot — audited ${auditedAt}. Counts drift as providers change their catalogs; treat this as verified evidence, not a guarantee.`);
	lines.push("");
	lines.push("Generated by `npx tsx scripts/audit-providers.ts --chat`. Credential values are never printed; only header NAMES are recorded.");
	lines.push("");
	lines.push("| Provider | Category | Credential | Catalog | Chat models | Free chat | Quota headers | Parsed | Chat probe | Anonymous chat OK |");
	lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
	for (const result of results) {
		lines.push(
			`| ${result.providerId} | ${result.category} | ${result.credentialPresent ? "present" : "absent"} | ${result.catalogStatus} | ${result.chatModels} | ${result.freeChatModels} | ${result.quotaHeaderNames.length > 0 ? `\`${result.quotaHeaderNames.join("`, `")}\`` : "—"} | ${result.quotaParsed ? "yes" : "no"} | ${result.chatStatus ?? "—"} | ${result.anonymousChatWorking.length > 0 ? `\`${result.anonymousChatWorking.join("`, `")}\`` : "—"} |`,
		);
	}
	lines.push("");
	lines.push("## Notes");
	lines.push("");
	for (const result of results) {
		if (result.notes.length === 0) continue;
		lines.push(`- **${result.providerId}** — ${result.notes.join("; ")}`);
	}
	lines.push("");
	lines.push("## How to read this");
	lines.push("");
	lines.push("- **Quota headers** are the quota ledger's only authoritative input. A provider with none runs in inferred mode: conservative local accounting corrected by 429 feedback.");
	lines.push("- **Parsed = no** with headers present means the header format is unknown to `extractQuotaHeaders` — the drift counter will flag it in production.");
	lines.push("- **Chat probe 401/403** for a provider with `anonymousCatalog` is expected: listing is public, chat needs a key.");
	lines.push("");
	return lines.join("\n");
}

const seeds = only.length > 0 ? PROVIDER_SEEDS.filter((seed) => only.includes(seed.providerId)) : PROVIDER_SEEDS;
const auditedAt = new Date().toISOString();
const results: AuditResult[] = [];
for (const seed of seeds) {
	process.stderr.write(`auditing ${seed.providerId}...\n`);
	results.push(await auditProvider(seed));
}

writeFileSync("docs/provider-audit.md", renderMarkdown(results, auditedAt), "utf8");
process.stdout.write(`${JSON.stringify({ auditedAt, results }, null, 1)}\n`);