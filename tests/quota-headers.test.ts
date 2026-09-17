import { describe, expect, it } from "vitest";
import { extractQuotaHeaders, parseResetHeader } from "../src/quota-headers.ts";

describe("quota header extraction", () => {
	it("parses the standard x-ratelimit request pair", () => {
		const result = extractQuotaHeaders(
			{ "X-RateLimit-Remaining-Requests": "7", "X-RateLimit-Limit-Requests": "10" },
			"acct",
		);
		expect(result.quotas).toHaveLength(1);
		expect(result.quotas[0]).toMatchObject({ metric: "requests", window: "minute", remaining: 7, limit: 10 });
		expect(result.drift).toBe(false);
	});

	it("parses token pairs", () => {
		const result = extractQuotaHeaders(
			{ "x-ratelimit-remaining-tokens": "1000", "x-ratelimit-limit-tokens": "5000" },
			"acct",
		);
		expect(result.quotas[0]).toMatchObject({ metric: "tokens", window: "minute", remaining: 1000, limit: 5000 });
	});

	it("keeps first match per (metric, window) in priority order", () => {
		const result = extractQuotaHeaders(
			{
				"x-ratelimit-remaining-requests": "5",
				"x-ratelimit-limit-requests": "10",
				"ratelimit-remaining": "9",
				"ratelimit-limit": "20",
			},
			"acct",
		);
		expect(result.quotas).toHaveLength(1);
		expect(result.quotas[0]?.remaining).toBe(5);
	});

	it("flags drift when limit+remaining headers exist but no pair matches", () => {
		const result = extractQuotaHeaders(
			{ "x-weird-remaining": "3", "x-weird-limit": "9" },
			"acct",
		);
		expect(result.quotas).toHaveLength(0);
		expect(result.drift).toBe(true);
	});

	it("no drift for a remaining-only half signal", () => {
		const result = extractQuotaHeaders({ "x-ratelimit-remaining": "3" }, "acct");
		expect(result.drift).toBe(false);
	});

	it("parses Retry-After seconds and HTTP-date forms", () => {
		const now = 1_000_000_000_000;
		const seconds = extractQuotaHeaders({ "Retry-After": "30" }, "acct", now);
		expect(seconds.retryAfterMs).toBe(30_000);
		const dateForm = extractQuotaHeaders({ "Retry-After": new Date(now + 15_000).toUTCString() }, "acct", now);
		expect(dateForm.retryAfterMs).toBeGreaterThanOrEqual(14_000);
		expect(dateForm.retryAfterMs).toBeLessThanOrEqual(16_000);
	});

	it("parseResetHeader handles epoch-s, epoch-ms, delta, and 1m30s", () => {
		const now = 1_000_000_000_000;
		expect(parseResetHeader("30", now)).toBe(now + 30_000);
		// 1758000000 > 1e9 → epoch-seconds → ms.
		expect(parseResetHeader("1758000000", now)).toBe(1_758_000_000_000);
		// 1758000000000 > 1e12 → already epoch-ms.
		expect(parseResetHeader("1758000000000", now)).toBe(1_758_000_000_000);
		expect(parseResetHeader("1m30s", now)).toBe(now + 90_000);
		expect(parseResetHeader("garbage", now)).toBeUndefined();
	});

	it("rejects nonsensical remaining>limit pairs", () => {
		const result = extractQuotaHeaders(
			{ "x-ratelimit-remaining": "50", "x-ratelimit-limit": "10" },
			"acct",
		);
		expect(result.quotas).toHaveLength(0);
	});
});
