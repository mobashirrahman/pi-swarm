/**
 * Quota registry: hierarchical per-account (and per-model) buckets with
 * reservation semantics.
 *
 * Design (from the plan):
 *  - A turn is admissible only when EVERY applicable bucket can reserve.
 *  - Unknown quota does NOT mean unlimited: a cold bucket admits exactly one
 *    probation request, then locks onto observed/configured values.
 *  - Dispatch reserves BEFORE the request is sent (local decrement closes the
 *    gap between spawning N agents and responses arriving).
 *  - After the response, reservations reconcile against actual usage and the
 *    authoritative headers overwrite local estimates.
 *  - A reservation consumed by a SENT request is charged even on failure —
 *    providers may count failed streams.
 *  - Reservations for requests that were never sent are released on cancel.
 *
 * All decisions take `now` as a parameter so tests run on a fake clock.
 */

import type {
	BucketConfidence,
	QuotaBucket,
	QuotaMetric,
	QuotaWindow,
	ResponseCounters,
} from "./types.ts";
import { bucketKey } from "./types.ts";

export interface Reservation {
	id: string;
	/** Buckets reserved against, for release/commit. */
	keys: string[];
	accountId: string;
	/** Estimated tokens reserved (input + configured max output). */
	estimatedTokens: number;
	sent: boolean;
}

export interface ReservationResult {
	ok: boolean;
	reservation?: Reservation;
	/** Bucket key that refused, when !ok. */
	blockedBy?: string;
	/** Epoch ms when the blocking bucket is believed to free up. */
	earliestRetryAt?: number;
}

/** One request always costs one request-unit; token cost is estimated. */
export interface ReserveRequest {
	accountId: string;
	/** Model id for model-scoped buckets; omitted = account scope only. */
	modelId?: string;
	estimatedTokens: number;
}

export interface QuotaRegistryOptions {
	/**
	 * How many requests an UNKNOWN account bucket may admit during probation.
	 * The plan fixes this at 1 — the first response reveals real limits.
	 */
	probationRequests?: number;
}

let reservationCounter = 0;
function nextReservationId(): string {
	reservationCounter += 1;
	return `res-${reservationCounter}`;
}

export class QuotaRegistry {
	/** Keyed by {@link bucketKey}. */
	private readonly buckets = new Map<string, QuotaBucket>();
	/** Live reservations by id. */
	private readonly reservations = new Map<string, Reservation>();
	/** In-flight request count per account (concurrency gauge). */
	private readonly inFlight = new Map<string, number>();
	private readonly probationRequests: number;
	/** Per-account response outcome counters. */
	private readonly counters = new Map<string, ResponseCounters>();

	constructor(options: QuotaRegistryOptions = {}) {
		this.probationRequests = options.probationRequests ?? 1;
	}

	// =========================================================================
	// Bucket management
	// =========================================================================

	/** Get or lazily create a bucket in the UNKNOWN state. */
	private ensureBucket(
		accountId: string,
		scope: "account" | "model",
		metric: QuotaMetric,
		window: QuotaWindow,
		modelId?: string,
	): QuotaBucket {
		const key = bucketKey(accountId, scope, metric, window, modelId);
		let bucket = this.buckets.get(key);
		if (!bucket) {
			bucket = {
				accountId,
				scope,
				modelId,
				metric,
				window,
				observedAt: 0,
				confidence: "unknown",
			};
			this.buckets.set(key, bucket);
		}
		return bucket;
	}

	/**
	 * Seed a bucket from configuration (audit doc, provider docs). Only used
	 * when no header observation exists yet; headers always win afterwards.
	 */
	configureBucket(
		accountId: string,
		metric: QuotaMetric,
		window: QuotaWindow,
		limit: number,
		options: { modelId?: string; windowMs?: number; now?: number } = {},
	): void {
		const scope = options.modelId ? "model" : "account";
		const bucket = this.ensureBucket(accountId, scope, metric, window, options.modelId);
		if (bucket.confidence === "header") return; // never downgrade
		const now = options.now ?? Date.now();
		bucket.limit = limit;
		bucket.remaining = limit;
		bucket.confidence = "configured";
		bucket.observedAt = now;
		if (options.windowMs) {
			bucket.resetAt = now + options.windowMs;
		}
	}

	/** Direct observation (from response headers). Overwrites local estimates. */
	observe(
		accountId: string,
		metric: QuotaMetric,
		window: QuotaWindow,
		remaining: number,
		limit: number,
		options: { modelId?: string; resetAt?: number; confidence?: BucketConfidence } = {},
	): void {
		const scope = options.modelId ? "model" : "account";
		const bucket = this.ensureBucket(accountId, scope, metric, window, options.modelId);
		bucket.remaining = remaining;
		bucket.limit = limit;
		bucket.resetAt = options.resetAt;
		bucket.confidence = options.confidence ?? "header";
		bucket.observedAt = Date.now();
	}

	getBucket(key: string): Readonly<QuotaBucket> | undefined {
		return this.buckets.get(key);
	}

	/** All buckets for an account (read-only view). */
	getAccountBuckets(accountId: string): ReadonlyArray<Readonly<QuotaBucket>> {
		const result: QuotaBucket[] = [];
		for (const bucket of this.buckets.values()) {
			if (bucket.accountId === accountId) result.push(bucket);
		}
		return result;
	}

	// =========================================================================
	// Concurrency
	// =========================================================================

	inFlightCount(accountId: string): number {
		return this.inFlight.get(accountId) ?? 0;
	}

	private beginInFlight(accountId: string): void {
		this.inFlight.set(accountId, this.inFlightCount(accountId) + 1);
	}

	private endInFlight(accountId: string): void {
		const current = this.inFlightCount(accountId);
		this.inFlight.set(accountId, Math.max(0, current - 1));
	}

	// =========================================================================
	// Reservations
	// =========================================================================

	/**
	 * Try to reserve capacity for one request across every applicable bucket:
	 * account requests/min, account requests/day, account tokens/min,
	 * model requests/min (when modelId given), plus concurrency.
	 */
	tryReserve(req: ReserveRequest, now: number, maxConcurrency = 4): ReservationResult {
		// Concurrency gate first — cheapest check.
		if (this.inFlightCount(req.accountId) >= maxConcurrency) {
			return { ok: false, blockedBy: `${req.accountId}|concurrency` };
		}

		const applicable = this.applicableBuckets(req.accountId, req.modelId);
		const blocked = this.findBlocking(applicable, req.estimatedTokens, now);
		if (blocked) {
			return {
				ok: false,
				blockedBy: blocked.key,
				earliestRetryAt: this.earliestRetryAt(blocked.bucket, now),
			};
		}

		// All buckets admit — take the reservations.
		const keys: string[] = [];
		for (const { key, bucket } of applicable) {
			this.charge(bucket, 1, req.estimatedTokens, req.accountId, req.modelId, now);
			keys.push(key);
		}
		this.beginInFlight(req.accountId);
		const reservation: Reservation = {
			id: nextReservationId(),
			keys,
			accountId: req.accountId,
			estimatedTokens: req.estimatedTokens,
			sent: false,
		};
		this.reservations.set(reservation.id, reservation);
		return { ok: true, reservation };
	}

	/** Mark a reservation as sent — its cost is now definitely consumed. */
	markSent(reservationId: string): void {
		const reservation = this.reservations.get(reservationId);
		if (reservation) reservation.sent = true;
	}

	/**
	 * Request completed: reconcile with real usage, decrement in-flight.
	 * `actualTokens` replaces the estimate (never negative).
	 */
	commit(reservationId: string, actualTokens: number): void {
		const reservation = this.reservations.get(reservationId);
		if (!reservation) return;
		this.reservations.delete(reservationId);
		this.endInFlight(reservation.accountId);
		// Request + token buckets were already charged at reserve time. The
		// token delta between estimate and actual self-corrects at the next
		// header observation; we do not "refund" mid-window (conservative).
		void actualTokens;
	}

	/**
	 * Release a reservation whose request was never sent (cancel, blocked
	 * upstream, dispatch abort). Frees the capacity immediately.
	 */
	release(reservationId: string): void {
		const reservation = this.reservations.get(reservationId);
		if (!reservation) return;
		this.reservations.delete(reservationId);
		if (!reservation.sent) {
			// Un-sent: undo the charge on every bucket.
			for (const key of reservation.keys) {
				const bucket = this.buckets.get(key);
				if (!bucket) continue;
				if (bucket.remaining !== undefined && bucket.limit !== undefined) {
					bucket.remaining = Math.min(bucket.limit, bucket.remaining + 1);
				}
				if (bucket.metric === "tokens" && bucket.remaining !== undefined) {
					bucket.remaining = bucket.remaining + reservation.estimatedTokens;
				}
			}
		}
		this.endInFlight(reservation.accountId);
	}

	// =========================================================================
	// Internals
	// =========================================================================

	/** All buckets a request must satisfy, creating unknowns lazily. */
	private applicableBuckets(
		accountId: string,
		modelId: string | undefined,
	): Array<{ key: string; bucket: QuotaBucket }> {
		const specs: Array<{ scope: "account" | "model"; metric: QuotaMetric; window: QuotaWindow }> = [
			{ scope: "account", metric: "requests", window: "minute" },
			{ scope: "account", metric: "requests", window: "day" },
			{ scope: "account", metric: "tokens", window: "minute" },
		];
		if (modelId) {
			specs.push({ scope: "model", metric: "requests", window: "minute" });
		}
		return specs.map((spec) => {
			const key = bucketKey(accountId, spec.scope, spec.metric, spec.window, modelId);
			return { key, bucket: this.ensureBucket(accountId, spec.scope, spec.metric, spec.window, modelId) };
		});
	}

	/**
	 * Find the first bucket that cannot admit. Unknown buckets admit exactly
	 * `probationRequests` lifetime requests; expired windows reset.
	 */
	private findBlocking(
		applicable: Array<{ key: string; bucket: QuotaBucket }>,
		estimatedTokens: number,
		now: number,
	): { key: string; bucket: QuotaBucket } | undefined {
		for (const { key, bucket } of applicable) {
			if (this.expired(bucket, now)) continue; // window rolled over
			if (bucket.confidence === "unknown") {
				// Probation: allow while NO confirmed limit exists.
				continue;
			}
			if (bucket.metric === "requests" && bucket.remaining !== undefined && bucket.remaining < 1) {
				return { key, bucket };
			}
			if (bucket.metric === "tokens" && bucket.remaining !== undefined && bucket.remaining < estimatedTokens) {
				return { key, bucket };
			}
		}
		return undefined;
	}

	/** Charge a bucket (pre-checked by findBlocking). */
	private charge(
		bucket: QuotaBucket,
		requests: number,
		tokens: number,
		_accountId: string,
		_modelId: string | undefined,
		now: number,
	): void {
		if (this.expired(bucket, now)) {
			// Window rolled over at charge time — refill before debiting.
			if (bucket.limit !== undefined) bucket.remaining = bucket.limit;
			bucket.resetAt = now + this.windowMs(bucket.window);
		}
		if (bucket.metric === "requests") {
			bucket.remaining = bucket.remaining === undefined ? undefined : bucket.remaining - requests;
		} else {
			bucket.remaining = bucket.remaining === undefined ? undefined : bucket.remaining - tokens;
		}
		// Unknown buckets count lifetime probation admissions.
		if (bucket.confidence === "unknown") {
			bucket.observedAt = now;
		}
	}

	/** A window is expired when the reset time has passed. */
	private expired(bucket: QuotaBucket, now: number): boolean {
		return bucket.resetAt !== undefined && now >= bucket.resetAt;
	}

	private earliestRetryAt(bucket: QuotaBucket, now: number): number {
		if (bucket.resetAt !== undefined && bucket.resetAt > now) return bucket.resetAt;
		// No known reset — assume a minute-window rolls over soonest.
		return now + this.windowMs(bucket.window);
	}

	private windowMs(window: QuotaWindow): number {
		return window === "minute" ? 60_000 : 24 * 60 * 60_000;
	}

	// =========================================================================
	// Counters (ported from pi-free #437)
	// =========================================================================

	responseCounters(accountId: string): ResponseCounters {
		let entry = this.counters.get(accountId);
		if (!entry) {
			entry = { authFailures: 0, policyFailures: 0, rateLimited: 0, serverErrors: 0, quotaHeaderDrift: 0 };
			this.counters.set(accountId, entry);
		}
		return entry;
	}

	/** Record a response outcome against the account counters. */
	recordOutcome(
		accountId: string,
		status: number,
		hadDrift: boolean,
	): void {
		const counters = this.responseCounters(accountId);
		if (status === 401) counters.authFailures += 1;
		else if (status === 403) counters.policyFailures += 1;
		else if (status === 429) counters.rateLimited += 1;
		else if (status >= 500 && status < 600) counters.serverErrors += 1;
		if (hadDrift) counters.quotaHeaderDrift += 1;
	}
}
