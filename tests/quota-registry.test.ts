import { describe, expect, it } from "vitest";
import { QuotaRegistry } from "../src/quota-registry.ts";

const NOW = 1_000_000;

describe("QuotaRegistry reservation semantics", () => {
	it("unknown buckets cap concurrent probation requests", () => {
		const qr = new QuotaRegistry();
		const first = qr.tryReserve({ accountId: "a", estimatedTokens: 100 }, NOW);
		expect(first.ok).toBe(true);
		const second = qr.tryReserve({ accountId: "a", estimatedTokens: 100 }, NOW);
		expect(second.ok).toBe(false);
		expect(second.blockedBy).toContain("requests/minute");
		qr.release(first.reservation!.id);
		expect(qr.tryReserve({ accountId: "a", estimatedTokens: 100 }, NOW).ok).toBe(true);
	});

	it("configured buckets block when exhausted and report reset time", () => {
		const qr = new QuotaRegistry();
		qr.configureBucket("a", "requests", "minute", 2, { windowMs: 60_000 });
		expect(qr.tryReserve({ accountId: "a", estimatedTokens: 10 }, NOW).ok).toBe(true);
		expect(qr.tryReserve({ accountId: "a", estimatedTokens: 10 }, NOW).ok).toBe(true);
		const third = qr.tryReserve({ accountId: "a", estimatedTokens: 10 }, NOW);
		expect(third.ok).toBe(false);
		expect(third.blockedBy).toContain("requests/minute");
		expect(third.earliestRetryAt).toBeGreaterThan(NOW);
	});

	it("resets the minute window after resetAt passes", () => {
		const qr = new QuotaRegistry();
		qr.configureBucket("a", "requests", "minute", 1, { windowMs: 60_000, now: NOW });
		expect(qr.tryReserve({ accountId: "a", estimatedTokens: 10 }, NOW).ok).toBe(true);
		expect(qr.tryReserve({ accountId: "a", estimatedTokens: 10 }, NOW).ok).toBe(false);
		// After the window: refilled.
		expect(qr.tryReserve({ accountId: "a", estimatedTokens: 10 }, NOW + 61_000).ok).toBe(true);
	});

	it("token buckets block when the estimate exceeds remaining", () => {
		const qr = new QuotaRegistry();
		qr.configureBucket("a", "tokens", "minute", 1_000, { windowMs: 60_000 });
		expect(qr.tryReserve({ accountId: "a", estimatedTokens: 800 }, NOW).ok).toBe(true);
		const second = qr.tryReserve({ accountId: "a", estimatedTokens: 500 }, NOW);
		expect(second.ok).toBe(false);
		expect(second.blockedBy).toContain("tokens/minute");
	});

	it("release refunds unsent reservations; commit does not refund", () => {
		const qr = new QuotaRegistry();
		qr.configureBucket("a", "requests", "minute", 1, { windowMs: 60_000 });
		const res = qr.tryReserve({ accountId: "a", estimatedTokens: 10 }, NOW);
		expect(res.ok).toBe(true);
		qr.release(res.reservation!.id);
		expect(qr.tryReserve({ accountId: "a", estimatedTokens: 10 }, NOW).ok).toBe(true);

		qr.markSent(res.reservation!.id === "" ? "x" : res.reservation!.id);
	});

	it("sent-then-failed requests stay charged (conservative)", () => {
		const qr = new QuotaRegistry();
		qr.configureBucket("a", "requests", "minute", 1, { windowMs: 60_000 });
		const res = qr.tryReserve({ accountId: "a", estimatedTokens: 10 }, NOW);
		qr.markSent(res.reservation!.id);
		qr.commit(res.reservation!.id, 0);
		// Still exhausted — the provider may have counted the failed request.
		expect(qr.tryReserve({ accountId: "a", estimatedTokens: 10 }, NOW).ok).toBe(false);
	});

	it("header observations overwrite configured values and win over estimates", () => {
		const qr = new QuotaRegistry();
		qr.configureBucket("a", "requests", "minute", 2, { windowMs: 60_000 });
		qr.observe("a", "requests", "minute", 50, 100, { resetAt: NOW + 60_000 });
		const bucket = qr.getBucket("a|account|requests/minute");
		expect(bucket?.remaining).toBe(50);
		expect(bucket?.limit).toBe(100);
		expect(bucket?.confidence).toBe("header");
	});

	it("concurrency gate blocks beyond maxConcurrency", () => {
		const qr = new QuotaRegistry();
		qr.configureBucket("a", "requests", "minute", 100, { windowMs: 60_000 });
		const r1 = qr.tryReserve({ accountId: "a", estimatedTokens: 10 }, NOW, 1);
		expect(r1.ok).toBe(true);
		const r2 = qr.tryReserve({ accountId: "a", estimatedTokens: 10 }, NOW, 1);
		expect(r2.ok).toBe(false);
		expect(r2.blockedBy).toContain("concurrency");
		qr.release(r1.reservation!.id);
		expect(qr.tryReserve({ accountId: "a", estimatedTokens: 10 }, NOW, 1).ok).toBe(true);
	});

	it("records per-account outcome counters including quota payment failures and drift", () => {
		const qr = new QuotaRegistry();
		qr.recordOutcome("a", 429, false);
		qr.recordOutcome("a", 402, false);
		qr.recordOutcome("a", 401, false);
		qr.recordOutcome("a", 0, true);
		const counters = qr.responseCounters("a");
		expect(counters.rateLimited).toBe(2);
		expect(counters.authFailures).toBe(1);
		expect(counters.quotaHeaderDrift).toBe(1);
	});

	it("caps unsent refunds at the observed bucket limit", () => {
		const qr = new QuotaRegistry();
		qr.configureBucket("a", "tokens", "minute", 100, { windowMs: 60_000, now: NOW });
		const reservation = qr.tryReserve({ accountId: "a", estimatedTokens: 20 }, NOW);
		expect(reservation.ok).toBe(true);
		// A newer observation may refill the bucket before the old unsent
		// reservation is released; the refund must not create 120 tokens.
		qr.observe("a", "tokens", "minute", 100, 100, { resetAt: NOW + 60_000 });
		qr.release(reservation.reservation!.id);
		expect(qr.getBucket("a|account|tokens/minute")?.remaining).toBe(100);
	});
});
