import { describe, expect, it } from "vitest";
import { Blacklist } from "../src/blacklist.ts";

describe("Blacklist (ported TTL + strikes semantics)", () => {
	it("soft-bans inside the TTL window and expires after it", () => {
		const bl = new Blacklist({ ttlMs: 10_000, maxStrikes: 3 });
		const t0 = 1_000_000;
		// "server" class uses the full TTL.
		bl.recordFailure("a/m", "server", t0);
		expect(bl.isBlacklisted("a/m", t0 + 5_000)).toBe(true);
		// Past the window: streak reset, key is free again.
		expect(bl.isBlacklisted("a/m", t0 + 10_001)).toBe(false);
	});

	it("quota strikes expire on the shorter quotaTtlMs", () => {
		const bl = new Blacklist({ ttlMs: 60_000, quotaTtlMs: 5_000, maxStrikes: 3 });
		const t0 = 1_000_000;
		bl.recordFailure("a/m", "quota", t0);
		expect(bl.isBlacklisted("a/m", t0 + 1_000)).toBe(true);
		// Quota window refilled — model eligible again long before the
		// session TTL would allow.
		expect(bl.isBlacklisted("a/m", t0 + 6_000)).toBe(false);
	});

	it("hard-bans permanently after maxStrikes in the window", () => {
		const bl = new Blacklist({ ttlMs: 10_000, maxStrikes: 3 });
		const t0 = 1_000_000;
		bl.recordFailure("a/m", "quota", t0);
		bl.recordFailure("a/m", "quota", t0 + 1_000);
		bl.recordFailure("a/m", "server", t0 + 2_000);
		// Far beyond TTL — hard ban persists.
		expect(bl.isBlacklisted("a/m", t0 + 1_000_000)).toBe(true);
	});

	it("resets the streak when the window expires between strikes", () => {
		const bl = new Blacklist({ ttlMs: 10_000, maxStrikes: 3 });
		const t0 = 1_000_000;
		bl.recordFailure("a/m", "server", t0);
		bl.recordFailure("a/m", "server", t0 + 1_000);
		// Window expires, then one new failure: count restarts at 1.
		bl.recordFailure("a/m", "server", t0 + 20_000);
		expect(bl.snapshot().get("a/m")?.count).toBe(1);
		expect(bl.isBlacklisted("a/m", t0 + 20_000)).toBe(true);
	});

	it("clear and clearAll behave idempotently", () => {
		const bl = new Blacklist();
		bl.recordFailure("a/m", "quota", 0);
		bl.clear("a/m");
		bl.clear("a/m");
		expect(bl.isBlacklisted("a/m", 1)).toBe(false);
		expect(bl.clearAll()).toBe(0);
	});
});
