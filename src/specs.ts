import type { AgentSpec } from "./agent.ts";
import type { QualityMetric, TierHint } from "./types.ts";
import { MAX_PLAN_CHILDREN, type PlanRequest, type PlanSubtask } from "./swarm.ts";

const TIER_HINTS: ReadonlySet<string> = new Set(["fast", "balanced", "frontier"]);
const QUALITY_METRICS: ReadonlySet<string> = new Set(["codingIndex", "intelligenceIndex", "agenticIndex"]);
const CAPABILITIES: ReadonlySet<string> = new Set(["text", "vision", "tools"]);

/**
 * Coerce to a positive integer, falling back when the value is missing,
 * non-numeric, or out of range. `Number("abc")` is NaN, which silently
 * became a zero-turn agent and an instant `max_turns_exceeded`.
 */
function positiveInt(value: unknown, fallback: number, max: number): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(1, Math.trunc(parsed)));
}

export function parseSpec(input: Record<string, unknown>): Omit<AgentSpec, "agentId"> & { agentId?: string | undefined } {
	const requested = Array.isArray(input["capabilities"])
		? input["capabilities"].filter((cap): cap is string => typeof cap === "string" && CAPABILITIES.has(cap))
		: [];
	const spec: Omit<AgentSpec, "agentId"> & { agentId?: string | undefined } = {
		task: String(input["task"] ?? ""),
		maxTurns: positiveInt(input["maxTurns"], 12, 200),
		maxWallTimeMs: positiveInt(input["maxWallTimeMs"], 600_000, 3_600_000),
		maxProviderAttemptsPerTurn: positiveInt(input["maxProviderAttemptsPerTurn"], 3, 50),
		capabilities: (requested.length > 0 ? requested : ["text", "tools"]) as AgentSpec["capabilities"],
		qualityFloor: typeof input["qualityFloor"] === "number" && Number.isFinite(input["qualityFloor"])
			? Math.min(100, Math.max(0, input["qualityFloor"]))
			: null,
		allowUnknownQuality: input["allowUnknownQuality"] === undefined ? true : Boolean(input["allowUnknownQuality"]),
	};
	if (typeof input["system"] === "string") spec.system = input["system"];
	if (typeof input["agentId"] === "string") spec.agentId = input["agentId"];
	if (typeof input["parentAgentId"] === "string") spec.parentAgentId = input["parentAgentId"];
	if (typeof input["tierHint"] === "string" && TIER_HINTS.has(input["tierHint"])) spec.tierHint = input["tierHint"] as TierHint;
	if (typeof input["qualityMetric"] === "string" && QUALITY_METRICS.has(input["qualityMetric"])) spec.qualityMetric = input["qualityMetric"] as QualityMetric;
	return spec;
}

/**
 * Parse plan-level and per-subtask overrides WITHOUT materializing spawn
 * defaults. Running overrides through `parseSpec` injected its defaults
 * (maxTurns 12, capabilities ["text","tools"]), which then overrode the
 * plan's own `defaults` — a documented knob that silently did nothing.
 */
function parsePlanOverrides(input: Record<string, unknown>): Omit<PlanSubtask, "task" | "idempotencyKey"> {
	const overrides: Record<string, unknown> = {};
	if (typeof input["system"] === "string") overrides["system"] = input["system"];
	if (input["capabilities"] !== undefined) {
		const requested = Array.isArray(input["capabilities"])
			? input["capabilities"].filter((cap): cap is string => typeof cap === "string" && CAPABILITIES.has(cap))
			: [];
		if (requested.length > 0) overrides["capabilities"] = requested;
	}
	for (const key of ["maxTurns", "maxWallTimeMs", "maxProviderAttemptsPerTurn"] as const) {
		if (input[key] === undefined) continue;
		const limits = { maxTurns: [12, 200], maxWallTimeMs: [600_000, 3_600_000], maxProviderAttemptsPerTurn: [3, 50] } as const;
		const [fallback, max] = limits[key];
		overrides[key] = positiveInt(input[key], fallback, max);
	}
	if (input["qualityFloor"] !== undefined) {
		const floor = typeof input["qualityFloor"] === "number" ? input["qualityFloor"] : Number.NaN;
		overrides["qualityFloor"] = Number.isFinite(floor) ? Math.min(100, Math.max(0, floor)) : null;
	}
	if (input["allowUnknownQuality"] !== undefined) {
		overrides["allowUnknownQuality"] = Boolean(input["allowUnknownQuality"]);
	}
	if (typeof input["tierHint"] === "string" && TIER_HINTS.has(input["tierHint"])) overrides["tierHint"] = input["tierHint"];
	if (typeof input["qualityMetric"] === "string" && QUALITY_METRICS.has(input["qualityMetric"])) {
		overrides["qualityMetric"] = input["qualityMetric"];
	}
	return overrides as Omit<PlanSubtask, "task" | "idempotencyKey">;
}

export function parsePlanRequest(input: Record<string, unknown>): PlanRequest {
	const subtasks = input["subtasks"];
	if (!Array.isArray(subtasks) || subtasks.length < 1 || subtasks.length > MAX_PLAN_CHILDREN) {
		throw new Error(`plan needs 1..${MAX_PLAN_CHILDREN} subtasks`);
	}
	return {
		...(typeof input["goal"] === "string" ? { goal: input["goal"] } : {}),
		subtasks: subtasks.map((entry) => {
			if (typeof entry !== "object" || entry === null) throw new Error("plan subtask must be an object");
			const record = entry as Record<string, unknown>;
			if (typeof record["task"] !== "string" || record["task"].length === 0) throw new Error("plan subtask needs a non-empty task");
			return {
				...parsePlanOverrides(record),
				task: record["task"],
				...(typeof record["idempotencyKey"] === "string" ? { idempotencyKey: record["idempotencyKey"] } : {}),
			};
		}),
		...(typeof input["defaults"] === "object" && input["defaults"] !== null
			? { defaults: parsePlanOverrides(input["defaults"] as Record<string, unknown>) }
			: {}),
		...(typeof input["idempotencyKey"] === "string" ? { idempotencyKey: input["idempotencyKey"] } : {}),
	};
}
