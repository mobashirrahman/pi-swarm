import { beforeEach, describe, expect, it } from "vitest";
import { AccountRegistry, type AccountRegistryEntry, type WireModel } from "../src/catalog.ts";
import { Dispatcher } from "../src/dispatcher.ts";

function registry(entries: AccountRegistryEntry[]): AccountRegistry {
	const accounts = new AccountRegistry();
	for (const entry of entries) accounts.register(entry);
	return accounts;
}

function account(overrides: Partial<AccountRegistryEntry> & { accountId: string }): AccountRegistryEntry & { baseUrl: string } {
	return {
		providerId: overrides.accountId.split(":")[0] ?? "p",
		credentialRef: "PI_SWARM_MISSING_TEST_KEY",
		enabled: true,
		maxConcurrency: 4,
		baseUrl: "https://test.invalid/v1",
		...overrides,
	};
}

describe("strict free-only candidate filtering", () => {
	let models: WireModel[];

	beforeEach(() => {
		models = [
			{ id: "zero-priced", pricing: { prompt: "0", completion: 0 }, context_length: 128_000 },
			{ id: "priced", pricing: { prompt: "0.001", completion: 0 }, context_length: 128_000 },
			{ id: "unpriced", context_length: 128_000 },
		];
	});

	it("admits known-free llm7 anonymously", async () => {
		const dispatcher = new Dispatcher({
			accounts: registry([account({ accountId: "llm7:primary", category: "free", anonymousTier: "turbo" })]),
			fetchModels: async () => [
				{ id: "glm", model_type: "chat", tier: "turbo", context_length: 128_000 },
				{ id: "pro-only", model_type: "chat", tier: "pro", context_length: 128_000 },
				{ id: "image", model_type: "image", tier: "turbo", context_length: 128_000 },
			],
		});
		const candidates = await dispatcher.loadCandidates();
		expect(candidates.map((c) => c.modelId)).toEqual(["glm"]);
		expect(candidates[0]?.freeBasis).toBe("provider_category");
	});

	it("keeps zero-priced models free regardless of category", async () => {
		const dispatcher = new Dispatcher({
			accounts: registry([account({ accountId: "freemium:1", category: "freemium" })]),
			fetchModels: async () => models,
		});
		const candidates = await dispatcher.loadCandidates();
		expect(candidates.map((c) => c.modelId)).toEqual(["zero-priced"]);
		expect(candidates[0]?.freeBasis).toBe("catalog");
	});

	it("fails closed for a freemium provider with no pricing and no entitlement", async () => {
		const dispatcher = new Dispatcher({
			accounts: registry([account({ accountId: "freemium:1", category: "freemium" })]),
			fetchModels: async () => models,
		});
		const candidates = await dispatcher.loadCandidates();
		expect(candidates.map((c) => c.modelId)).toEqual(["zero-priced"]);
	});

	it("admits unpriced models on a keyed freemium account", async () => {
		process.env.PI_SWARM_TEST_FREEMIUM_KEY = "test-key";
		try {
			const dispatcher = new Dispatcher({
				accounts: registry([account({ accountId: "freemium:1", category: "freemium", credentialRef: "PI_SWARM_TEST_FREEMIUM_KEY" })]),
				fetchModels: async () => models,
			});
			const candidates = await dispatcher.loadCandidates();
			expect(candidates.map((c) => c.modelId)).toEqual(["zero-priced", "unpriced"]);
			expect(candidates[1]?.freeBasis).toBe("entitlement");
		} finally {
			delete process.env.PI_SWARM_TEST_FREEMIUM_KEY;
		}
	});

	it("still fails closed for a keyed paid provider with an unpriced catalog", async () => {
		process.env.PI_SWARM_TEST_PAID_KEY = "test-key";
		try {
			const dispatcher = new Dispatcher({
				accounts: registry([account({ accountId: "paid:1", category: "paid", credentialRef: "PI_SWARM_TEST_PAID_KEY" })]),
				fetchModels: async () => models,
			});
			const candidates = await dispatcher.loadCandidates();
			expect(candidates.map((c) => c.modelId)).toEqual(["zero-priced"]);
		} finally {
			delete process.env.PI_SWARM_TEST_PAID_KEY;
		}
	});

	it("fails closed for a paid provider even when the catalog is unpriced", async () => {
		const dispatcher = new Dispatcher({
			accounts: registry([account({ accountId: "paid:1", category: "paid" })]),
			fetchModels: async () => models,
		});
		const candidates = await dispatcher.loadCandidates();
		expect(candidates.map((c) => c.modelId)).toEqual(["zero-priced"]);
	});

	it("honors an explicit free entitlement on a freemium provider", async () => {
		const dispatcher = new Dispatcher({
		accounts: registry([account({
			accountId: "freemium:1",
			category: "freemium",
			freeEntitlement: { models: ["unpriced"] },
		})]),
			fetchModels: async () => models,
		});
		const candidates = await dispatcher.loadCandidates();
		expect(candidates.map((c) => c.modelId)).toEqual(["zero-priced", "unpriced"]);
		expect(candidates[1]?.freeBasis).toBe("entitlement");
	});

	it("entitlement tiers gate by the wire tier", async () => {
		const dispatcher = new Dispatcher({
			accounts: registry([account({ accountId: "freemium:1", category: "freemium", freeEntitlement: { tiers: ["anon"] } })]),
			fetchModels: async () => [
				{ id: "tiered", tier: "anon", context_length: 128_000 },
				{ id: "other", tier: "vip", context_length: 128_000 },
			],
		});
		const candidates = await dispatcher.loadCandidates();
		expect(candidates.map((c) => c.modelId)).toEqual(["tiered"]);
	});

	it("dropping the entitlement drops the unpriced model again", async () => {
		const dispatcher = new Dispatcher({
			accounts: registry([account({ accountId: "freemium:1", category: "freemium", freeEntitlement: { allModels: true } })]),
			fetchModels: async () => models,
		});
		const entitled = await dispatcher.loadCandidates();
		expect(entitled.map((c) => c.modelId)).toEqual(["zero-priced", "unpriced"]);
	});
});
