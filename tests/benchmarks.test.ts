import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	benchmarkTableSize,
	canonicalModelKey,
	liveScoreCount,
	lookupModelScore,
	resetBenchmarkCaches,
	setLiveScores,
} from "../src/benchmarks.ts";
import { TelemetryStore } from "../src/telemetry.ts";
import { AgentStore } from "../src/store.ts";

describe("model name canonicalization", () => {
	it("unifies the forms the same model appears in across providers", () => {
		const forms = [
			"GLM-5.3-Flash",
			"z-ai/glm-5.3-flash",
			"glm-5.3-flash:free",
			"glm-5.3-flash-20260826",
			"glm_5_3_flash",
		];
		const keys = new Set(forms.map(canonicalModelKey));
		expect(keys.size).toBe(1);
		expect([...keys][0]).toBe("glm-5-3-flash");
	});

	it("strips vendor prefixes and free-tier markers", () => {
		expect(canonicalModelKey("meta-llama/Llama-3.3-70B-Instruct:free")).toBe("llama-3-3-70b-instruct");
		expect(canonicalModelKey("deepseek-ai/deepseek-v4.1-flash")).toBe("deepseek-v4-1-flash");
	});

	it("leaves an already-canonical id unchanged", () => {
		expect(canonicalModelKey("gpt-oss-120b-high")).toBe("gpt-oss-120b-high");
	});
});

describe("benchmark lookup", () => {
	beforeEach(() => {
		resetBenchmarkCaches();
	});

	it("loads the vendored table", () => {
		expect(benchmarkTableSize()).toBeGreaterThan(500);
	});

	it("scores a model regardless of the provider's naming form", () => {
		const a = lookupModelScore("GLM-5.3-Flash");
		const b = lookupModelScore("z-ai/glm-5.3-flash");
		const c = lookupModelScore("glm-5.3-flash:free");
		expect(a?.codingIndex).toBeGreaterThan(0);
		expect(b?.codingIndex).toBe(a?.codingIndex);
		expect(c?.codingIndex).toBe(a?.codingIndex);
		expect(a?.confidence).toBe("exact");
	});

	it("returns undefined for an unknown model rather than a zero score", () => {
		// Unknown must stay unscored: the selector treats that as its own band,
		// and a fabricated 0 would rank it below genuinely bad models.
		expect(lookupModelScore("totally-made-up-model-zzz")).toBeUndefined();
	});

	it("prefers a live score over the vendored table", () => {
		const installed = setLiveScores([{ modelId: "glm-5.3-flash", intelligenceIndex: 88, codingIndex: 91 }]);
		expect(installed).toBe(1);
		expect(liveScoreCount()).toBe(1);
		const score = lookupModelScore("GLM-5.3-Flash");
		expect(score?.source).toBe("openrouter");
		expect(score?.codingIndex).toBe(91);
	});

	it("falls back to the vendored table when no live score matches", () => {
		setLiveScores([{ modelId: "some-other-model", codingIndex: 50 }]);
		const score = lookupModelScore("GLM-5.3-Flash");
		expect(score?.source).toBe("vendored");
	});

	it("reports lower confidence for fuzzy matches", () => {
		// A trailing qualifier the canonicalizer does not know about still
		// resolves, but must not claim exact confidence.
		const fuzzy = lookupModelScore("glm-5.3-flash-somethingextra");
		expect(fuzzy?.confidence).not.toBe("exact");
	});
});

describe("telemetry store", () => {
	let dir: string;
	let store: AgentStore;
	let telemetry: TelemetryStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-swarm-telemetry-"));
		store = new AgentStore(join(dir, "t.db"));
		telemetry = new TelemetryStore(store.database);
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("records latency, TTFT and throughput and smooths them with EWMA", () => {
		telemetry.recordSuccess("a:1", "m1", { latencyMs: 1000, ttftMs: 200, tokensPerSecond: 50 });
		telemetry.recordSuccess("a:1", "m1", { latencyMs: 2000, ttftMs: 400, tokensPerSecond: 100 });

		const entry = telemetry.get("a:1", "m1");
		expect(entry?.samples).toBe(2);
		// First sample seeds the EWMA; the second pulls it 30% of the way.
		expect(entry?.latencyMs).toBeCloseTo(0.3 * 2000 + 0.7 * 1000, 5);
		expect(entry?.ttftMs).toBeCloseTo(0.3 * 400 + 0.7 * 200, 5);
		expect(entry?.tokensPerSecond).toBeCloseTo(0.3 * 100 + 0.7 * 50, 5);
	});

	it("keeps a prior measurement when a later turn lacks one", () => {
		telemetry.recordSuccess("a:1", "m1", { latencyMs: 1000, ttftMs: 300, tokensPerSecond: 60 });
		// A turn that streamed too briefly to measure a rate.
		telemetry.recordSuccess("a:1", "m1", { latencyMs: 1200 });
		const entry = telemetry.get("a:1", "m1");
		expect(entry?.tokensPerSecond).toBeCloseTo(60, 5);
		expect(entry?.latencyMs).toBeCloseTo(0.3 * 1200 + 0.7 * 1000, 5);
	});

	it("counts failures separately without polluting speed", () => {
		telemetry.recordSuccess("a:1", "m1", { latencyMs: 500, tokensPerSecond: 80 });
		telemetry.recordFailure("a:1", "m1");
		const entry = telemetry.get("a:1", "m1");
		expect(entry?.samples).toBe(1);
		expect(entry?.failures).toBe(1);
		expect(entry?.tokensPerSecond).toBeCloseTo(80, 5);
		expect(telemetry.successRateMap().get("a:1/m1")).toBeCloseTo(0.5, 5);
	});

	it("persists across a store reopen (shared across processes and restarts)", () => {
		telemetry.recordSuccess("a:1", "m1", { latencyMs: 750, ttftMs: 150, tokensPerSecond: 42 });

		const reopened = new AgentStore(join(dir, "t.db"));
		const restored = new TelemetryStore(reopened.database);
		const entry = restored.get("a:1", "m1");
		expect(entry?.samples).toBe(1);
		expect(entry?.latencyMs).toBeCloseTo(750, 5);
		expect(entry?.ttftMs).toBeCloseTo(150, 5);
		expect(entry?.tokensPerSecond).toBeCloseTo(42, 5);
		reopened.close();
	});

	it("exposes only measured entries in the routing maps", () => {
		telemetry.recordFailure("a:1", "never-succeeded");
		expect(telemetry.latencyMap().has("a:1/never-succeeded")).toBe(false);
		expect(telemetry.throughputMap().has("a:1/never-succeeded")).toBe(false);
		expect(telemetry.successRateMap().get("a:1/never-succeeded")).toBe(0);
	});
});