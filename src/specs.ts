import type { AgentSpec } from "./agent.ts";
import type { QualityMetric, TierHint } from "./types.ts";
import { MAX_PLAN_CHILDREN, type PlanRequest, type PlanSubtask } from "./swarm.ts";

const TIER_HINTS: ReadonlySet<string> = new Set(["fast", "balanced", "frontier"]);
const QUALITY_METRICS: ReadonlySet<string> = new Set(["codingIndex", "intelligenceIndex", "agenticIndex"]);

export function parseSpec(input: Record<string, unknown>): Omit<AgentSpec, "agentId"> & { agentId?: string | undefined } {
	const spec: Omit<AgentSpec, "agentId"> & { agentId?: string | undefined } = {
		task: String(input["task"] ?? ""),
		maxTurns: Number(input["maxTurns"] ?? 12),
		maxWallTimeMs: Number(input["maxWallTimeMs"] ?? 600_000),
		maxProviderAttemptsPerTurn: Number(input["maxProviderAttemptsPerTurn"] ?? 3),
		capabilities: Array.isArray(input["capabilities"])
			? (input["capabilities"].filter((c): c is AgentSpec["capabilities"][number] => typeof c === "string") as AgentSpec["capabilities"])
			: ["text", "tools"],
		qualityFloor: typeof input["qualityFloor"] === "number" ? input["qualityFloor"] : null,
		allowUnknownQuality: input["allowUnknownQuality"] === undefined ? true : Boolean(input["allowUnknownQuality"]),
	};
	if (typeof input["system"] === "string") spec.system = input["system"];
	if (typeof input["agentId"] === "string") spec.agentId = input["agentId"];
	if (typeof input["parentAgentId"] === "string") spec.parentAgentId = input["parentAgentId"];
	if (typeof input["tierHint"] === "string" && TIER_HINTS.has(input["tierHint"])) spec.tierHint = input["tierHint"] as TierHint;
	if (typeof input["qualityMetric"] === "string" && QUALITY_METRICS.has(input["qualityMetric"])) spec.qualityMetric = input["qualityMetric"] as QualityMetric;
	return spec;
}

function parsePlanOverrides(input: Record<string, unknown>): Omit<PlanSubtask, "task" | "idempotencyKey"> {
	const spec = parseSpec({ ...input, task: "plan" });
	const { task: _task, agentId: _agentId, parentAgentId: _parent, ...overrides } = spec as Record<string, unknown>;
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
