/**
 * Internal performance telemetry — the deployment's OWN benchmark.
 *
 * Published vendor numbers describe an average over everyone's traffic. What
 * actually matters for routing is what THIS deployment observes right now: a
 * gateway can be fast in a vendor table and slow for us (region, upstream
 * load, a throttled free tier). So every turn records:
 *
 *   - TTFT (time to first token) — the dominant perceived-latency cost
 *   - tokens/sec — generation speed
 *   - total latency
 *   - outcome (success/failure) with its failure class
 *
 * Aggregates are EWMA + percentile-free running stats per (accountId, modelId),
 * persisted to the shared store so several worker processes and restarts share
 * one picture. Routing reads `latencyMs`/`tokensPerSecond` from here.
 *
 * Only numbers are stored. Never prompts, completions, or error bodies.
 */

import type { DatabaseSync } from "node:sqlite";
import { createLogger } from "./logger.ts";

const _logger = createLogger("telemetry");

/** EWMA smoothing factor: recent turns dominate, history still counts. */
const ALPHA = 0.3;

export interface ModelTelemetry {
	accountId: string;
	modelId: string;
	/** Successful turns observed. */
	samples: number;
	failures: number;
	/** EWMA of total turn latency (ms). */
	latencyMs: number | undefined;
	/** EWMA of time-to-first-token (ms). */
	ttftMs: number | undefined;
	/** EWMA of output tokens/sec. */
	tokensPerSecond: number | undefined;
	lastUpdated: number;
}

interface Row {
	account_id: string;
	model_id: string;
	samples: number;
	failures: number;
	latency_ms: number | null;
	ttft_ms: number | null;
	tokens_per_second: number | null;
	last_updated: number;
}

/** Fold a new observation into an EWMA, treating the first sample as the base. */
function ewma(previous: number | null | undefined, next: number, samples: number): number {
	if (previous === null || previous === undefined || samples <= 0) return next;
	return ALPHA * next + (1 - ALPHA) * previous;
}

export class TelemetryStore {
	private readonly cache = new Map<string, ModelTelemetry>();

	constructor(private readonly db: DatabaseSync) {
		this.migrate();
		this.load();
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS model_telemetry (
				account_id TEXT NOT NULL,
				model_id TEXT NOT NULL,
				samples INTEGER NOT NULL DEFAULT 0,
				failures INTEGER NOT NULL DEFAULT 0,
				latency_ms REAL,
				ttft_ms REAL,
				tokens_per_second REAL,
				last_updated INTEGER NOT NULL,
				PRIMARY KEY (account_id, model_id)
			);
		`);
	}

	private load(): void {
		const rows = this.db.prepare("SELECT * FROM model_telemetry").all() as unknown as Row[];
		for (const row of rows) {
			this.cache.set(`${row.account_id}/${row.model_id}`, {
				accountId: row.account_id,
				modelId: row.model_id,
				samples: row.samples,
				failures: row.failures,
				latencyMs: row.latency_ms ?? undefined,
				ttftMs: row.ttft_ms ?? undefined,
				tokensPerSecond: row.tokens_per_second ?? undefined,
				lastUpdated: row.last_updated,
			});
		}
	}

	/** Record a successful turn. Missing measurements leave prior values intact. */
	recordSuccess(
		accountId: string,
		modelId: string,
		measurement: { latencyMs: number; ttftMs?: number | undefined; tokensPerSecond?: number | undefined },
		now: number = Date.now(),
	): void {
		const key = `${accountId}/${modelId}`;
		const existing = this.cache.get(key);
		const samples = (existing?.samples ?? 0) + 1;
		const next: ModelTelemetry = {
			accountId,
			modelId,
			samples,
			failures: existing?.failures ?? 0,
			latencyMs: ewma(existing?.latencyMs, measurement.latencyMs, existing?.samples ?? 0),
			ttftMs:
				measurement.ttftMs !== undefined
					? ewma(existing?.ttftMs, measurement.ttftMs, existing?.samples ?? 0)
					: existing?.ttftMs,
			tokensPerSecond:
				measurement.tokensPerSecond !== undefined
					? ewma(existing?.tokensPerSecond, measurement.tokensPerSecond, existing?.samples ?? 0)
					: existing?.tokensPerSecond,
			lastUpdated: now,
		};
		this.cache.set(key, next);
		this.persist(next);
	}

	/** Record a failed turn: counts only — failures carry no speed signal. */
	recordFailure(accountId: string, modelId: string, now: number = Date.now()): void {
		const key = `${accountId}/${modelId}`;
		const existing = this.cache.get(key);
		const next: ModelTelemetry = {
			accountId,
			modelId,
			samples: existing?.samples ?? 0,
			failures: (existing?.failures ?? 0) + 1,
			latencyMs: existing?.latencyMs,
			ttftMs: existing?.ttftMs,
			tokensPerSecond: existing?.tokensPerSecond,
			lastUpdated: now,
		};
		this.cache.set(key, next);
		this.persist(next);
	}

	private persist(entry: ModelTelemetry): void {
		try {
			this.db
				.prepare(
					`INSERT INTO model_telemetry (account_id, model_id, samples, failures, latency_ms, ttft_ms, tokens_per_second, last_updated)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(account_id, model_id) DO UPDATE SET
					   samples = excluded.samples, failures = excluded.failures,
					   latency_ms = excluded.latency_ms, ttft_ms = excluded.ttft_ms,
					   tokens_per_second = excluded.tokens_per_second, last_updated = excluded.last_updated`,
				)
				.run(
					entry.accountId,
					entry.modelId,
					entry.samples,
					entry.failures,
					entry.latencyMs ?? null,
					entry.ttftMs ?? null,
					entry.tokensPerSecond ?? null,
					entry.lastUpdated,
				);
		} catch (error) {
			// Telemetry must never break a turn.
			_logger.debug("telemetry_persist_failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	get(accountId: string, modelId: string): ModelTelemetry | undefined {
		return this.cache.get(`${accountId}/${modelId}`);
	}

	/** All entries, for the routing view and diagnostics. */
	all(): ModelTelemetry[] {
		return [...this.cache.values()];
	}

	/** EWMA latency per "accountId/modelId" for the selector. */
	latencyMap(): Map<string, number> {
		const map = new Map<string, number>();
		for (const [key, entry] of this.cache) {
			if (entry.samples > 0 && entry.latencyMs !== undefined) map.set(key, entry.latencyMs);
		}
		return map;
	}

	/** EWMA throughput per "accountId/modelId" for the selector. */
	throughputMap(): Map<string, number> {
		const map = new Map<string, number>();
		for (const [key, entry] of this.cache) {
			if (entry.samples > 0 && entry.tokensPerSecond !== undefined) map.set(key, entry.tokensPerSecond);
		}
		return map;
	}

	/** Observed success rate per "accountId/modelId". */
	successRateMap(): Map<string, number> {
		const map = new Map<string, number>();
		for (const [key, entry] of this.cache) {
			const total = entry.samples + entry.failures;
			if (total > 0) map.set(key, entry.samples / total);
		}
		return map;
	}
}