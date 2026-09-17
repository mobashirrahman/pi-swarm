import { describe, expect, it } from "vitest";
import { rerouteDecision, selectTurnCandidate, type SelectorContext, type TurnRequirements } from "../src/selector.ts";
import type { Candidate } from "../src/types.ts";

const NOW = 1_000_000;

function candidate(overrides: Partial<Candidate> & { accountId: string; modelId: string }): Candidate {
	return {
		providerId: overrides.accountId.split(":")[0] ?? "p",
		name: overrides.modelId,
		ciScore: 50,
		contextWindow: 128_000,
		capabilities: { text: true, vision: false, tools: true },
		...overrides,
	};
}

function context(overrides: Partial<SelectorContext> = {}): SelectorContext {
	return {
		now: NOW,
		nextCapacityAt: new Map(),
		inFlight: new Map(),
		maxConcurrency: new Map(),
		remainingRequests: new Map(),
		ewmaLatencyMs: new Map(),
		successRate: new Map(),
		blacklisted: new Set(),
		circuitOpen: new Set(),
		estimatedTokens: 1_000,
		...overrides,
	};
}

const REQ: TurnRequirements = {
	capabilities: ["text", "tools"],
	minimumContextTokens: 2_000,
	qualityFloor: null,
	allowUnknownQuality: true,
	allowPaid: false,
};

describe("selector: stage A eligibility", () => {
	it("rejects circuit-open accounts with a reason", () => {
		const candidates = [candidate({ accountId: "a:1", modelId: "m" })];
		const ctx = context({ circuitOpen: new Set(["a:1"]) });
		const result = selectTurnCandidate(candidates, ctx, REQ);
		expect(result.best).toBeNull();
		expect(result.rejected[0]?.reason).toBe("circuit_open");
	});

	it("rejects blacklisted account/model pairs", () => {
		const candidates = [candidate({ accountId: "a:1", modelId: "m" })];
		const ctx = context({ blacklisted: new Set(["a:1/m"]) });
		const result = selectTurnCandidate(candidates, ctx, REQ);
		expect(result.rejected[0]?.reason).toBe("blacklisted");
	});

	it("rejects candidates missing required capabilities", () => {
		const candidates = [candidate({ accountId: "a:1", modelId: "m", capabilities: { text: true, vision: false, tools: false } })];
		const result = selectTurnCandidate(candidates, context(), { ...REQ, capabilities: ["text", "tools"] });
		expect(result.rejected[0]?.reason).toBe("missing_capability_tools");
	});

	it("rejects context windows smaller than the transcript estimate", () => {
		const candidates = [candidate({ accountId: "a:1", modelId: "m", contextWindow: 1_000 })];
		const result = selectTurnCandidate(candidates, context(), REQ);
		expect(result.rejected[0]?.reason).toBe("context_window");
	});

	it("enforces the quality floor for scored models", () => {
		const candidates = [candidate({ accountId: "a:1", modelId: "m", ciScore: 30 })];
		const result = selectTurnCandidate(candidates, context(), { ...REQ, qualityFloor: 50 });
		expect(result.rejected[0]?.reason).toBe("quality_floor");
	});

	it("rejects quota-exhausted accounts", () => {
		const candidates = [candidate({ accountId: "a:1", modelId: "m" })];
		const ctx = context({ remainingRequests: new Map([["a:1", 0]]) });
		const result = selectTurnCandidate(candidates, ctx, REQ);
		expect(result.rejected[0]?.reason).toBe("quota_exhausted");
	});

	it("respects allowedProviders and deniedProviders", () => {
		const candidates = [candidate({ accountId: "a:1", modelId: "m" })];
		const denied = selectTurnCandidate(candidates, context(), { ...REQ, deniedProviders: new Set(["a"]) });
		expect(denied.rejected[0]?.reason).toBe("provider_denied");
		const notAllowed = selectTurnCandidate(candidates, context(), { ...REQ, allowedProviders: new Set(["other"]) });
		expect(notAllowed.rejected[0]?.reason).toBe("provider_not_allowed");
	});
});

describe("selector: stage C projection", () => {
	it("prefers the account that can start NOW over one waiting on cooldown", () => {
		const candidates = [
			candidate({ accountId: "fast:1", modelId: "m1", ciScore: 90 }),
			candidate({ accountId: "slow:1", modelId: "m2", ciScore: 90 }),
		];
		const ctx = context({
			nextCapacityAt: new Map([["fast:1", 0], ["slow:1", NOW + 60_000]]),
			ewmaLatencyMs: new Map([["fast:1/m1", 1_000], ["slow:1/m2", 1_000]]),
		});
		const result = selectTurnCandidate(candidates, ctx, REQ);
		expect(result.best?.candidate.accountId).toBe("fast:1");
	});

	it("projects finish = max(now, nextCapacity) + EWMA latency", () => {
		const candidates = [candidate({ accountId: "a:1", modelId: "m" })];
		const ctx = context({
			nextCapacityAt: new Map([["a:1", NOW + 5_000]]),
			ewmaLatencyMs: new Map([["a:1/m", 2_000]]),
		});
		const result = selectTurnCandidate(candidates, ctx, REQ);
		expect(result.best?.projectedFinishAt).toBe(NOW + 7_000);
	});

	it("unproven candidates use the pessimistic default latency", () => {
		const candidates = [candidate({ accountId: "a:1", modelId: "m" })];
		const result = selectTurnCandidate(candidates, context(), REQ);
		expect(result.best?.diag.latencyMs).toBe(30_000);
	});

	it("tie-breaks deterministically via stable hash", () => {
		const candidates = [
			candidate({ accountId: "a:1", modelId: "m1", ciScore: 50 }),
			candidate({ accountId: "a:2", modelId: "m2", ciScore: 50 }),
		];
		const ctx = context({
			ewmaLatencyMs: new Map([["a:1/m1", 1_000], ["a:2/m2", 1_000]]),
		});
		const r1 = selectTurnCandidate(candidates, ctx, REQ);
		const r2 = selectTurnCandidate([...candidates].reverse(), ctx, REQ);
		expect(r1.best?.candidate.accountId).toBe(r2.best?.candidate.accountId);
	});
});

describe("rerouteDecision policy", () => {
	it("reroutes quota and server failures", () => {
		expect(rerouteDecision("quota", 1, 3)).toBe("reroute");
		expect(rerouteDecision("server", 1, 3)).toBe("reroute");
	});

	it("fails fast on auth/policy/bad_request", () => {
		expect(rerouteDecision("auth", 1, 3)).toBe("fail");
		expect(rerouteDecision("policy", 1, 3)).toBe("fail");
		expect(rerouteDecision("bad_request", 1, 3)).toBe("fail");
	});

	it("spreads concurrent agents across candidates via agentId hash", () => {
		const candidates = [
			candidate({ accountId: "a:1", modelId: "m1" }),
			candidate({ accountId: "a:1", modelId: "m2" }),
			candidate({ accountId: "a:1", modelId: "m3" }),
		];
		const ctx = context({
			ewmaLatencyMs: new Map([["a:1/m1", 1_000], ["a:1/m2", 1_000], ["a:1/m3", 1_000]]),
		});
		// Same account, same latency: agentId in the tie-break must decorrelate.
		const picks = new Set<string>();
		for (let i = 0; i < 20; i++) {
			const result = selectTurnCandidate(candidates, ctx, { ...REQ, agentId: `agent-${i}` });
			if (result.best) picks.add(result.best.candidate.modelId);
		}
		expect(picks.size).toBeGreaterThan(1);
	});

	it("excludes already-tried models but keeps the account eligible", () => {
		const candidates = [
			candidate({ accountId: "a:1", modelId: "m1" }),
			candidate({ accountId: "a:1", modelId: "m2" }),
		];
		const ctx = context({ excludeModels: new Set(["a:1/m1"]) });
		const result = selectTurnCandidate(candidates, ctx, REQ);
		expect(result.best?.candidate.modelId).toBe("m2");
		expect(result.rejected.map((r) => r.reason)).toContain("already_tried_model");
	});
});
