import { describe, expect, it } from "vitest";
import { SwarmService } from "../src/swarm.ts";

function serviceWithStubbedRefresh(behavior: () => Promise<number>): { service: SwarmService; calls: () => number } {
	const service = new SwarmService({ accounts: [] });
	let calls = 0;
	service.refreshCatalogs = async () => {
		calls += 1;
		return behavior();
	};
	return { service, calls: () => calls };
}

describe("catalog auto-refresh", () => {
	it("re-runs refresh on the interval until stopped", async () => {
		const { service, calls } = serviceWithStubbedRefresh(async () => 3);
		const stop = service.startAutoRefresh(30);
		try {
			await new Promise((resolve) => setTimeout(resolve, 120));
			expect(calls()).toBeGreaterThanOrEqual(2);
			const frozen = calls();
			stop();
			await new Promise((resolve) => setTimeout(resolve, 80));
			expect(calls()).toBe(frozen);
		} finally {
			stop();
		}
	});

	it("never overlaps a slow refresh and survives refresh errors", async () => {
		let concurrent = 0;
		let maxConcurrent = 0;
		let failOnce = true;
		const { service, calls } = serviceWithStubbedRefresh(async () => {
			concurrent += 1;
			maxConcurrent = Math.max(maxConcurrent, concurrent);
			try {
				if (failOnce) {
					failOnce = false;
					throw new Error("transient");
				}
				await new Promise((resolve) => setTimeout(resolve, 60));
				return 1;
			} finally {
				concurrent -= 1;
			}
		});
		const stop = service.startAutoRefresh(20);
		try {
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(calls()).toBeGreaterThanOrEqual(2);
			expect(maxConcurrent).toBe(1);
		} finally {
			stop();
		}
	});

	it("starting twice keeps a single timer", async () => {
		const { service, calls } = serviceWithStubbedRefresh(async () => 1);
		const stop = service.startAutoRefresh(30);
		service.startAutoRefresh(30);
		try {
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(calls()).toBeLessThanOrEqual(4);
		} finally {
			stop();
		}
	});

	it("reads the interval from PI_SWARM_REFRESH_MS with a sane fallback", () => {
		expect(SwarmService.refreshIntervalMs({ PI_SWARM_REFRESH_MS: "60000" } as NodeJS.ProcessEnv)).toBe(60_000);
		expect(SwarmService.refreshIntervalMs({} as NodeJS.ProcessEnv)).toBe(3_600_000);
		expect(SwarmService.refreshIntervalMs({ PI_SWARM_REFRESH_MS: "bogus" } as NodeJS.ProcessEnv)).toBe(3_600_000);
	});
});
