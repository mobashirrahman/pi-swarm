import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	clearDispatcherCache,
	dispatcherFor,
	EgressExhaustedError,
	EgressPool,
	loadEgressConfigFromEnv,
	parseCountryFilter,
	parseEgressEntry,
	parseEgressProxies,
	redactProxyUrl,
} from "../src/egress.ts";
import { parseEgressCountries, parseSpec } from "../src/specs.ts";
import { AccountRegistry, type AccountRegistryEntry } from "../src/catalog.ts";
import { Dispatcher } from "../src/dispatcher.ts";
import type { ChatMessage } from "../src/stream.ts";

describe("egress parsing", () => {
	it("accepts fragment, query, prefix, and bare forms", () => {
		expect(parseEgressEntry("socks5://127.0.0.1:1080#US", 0)).toMatchObject({ id: "egress-0", country: "US", protocol: "socks5" });
		expect(parseEgressEntry("socks5://127.0.0.1:1080#country=de", 1)).toMatchObject({ country: "DE" });
		expect(parseEgressEntry("socks5://127.0.0.1:1080?country=FR", 2)).toMatchObject({ country: "FR" });
		expect(parseEgressEntry("US=socks5://127.0.0.1:1080", 3)).toMatchObject({ country: "US" });
		expect(parseEgressEntry("https://user:pass@proxy.example:8080", 4)?.country).toBeUndefined();
		expect(parseEgressEntry("https://user:pass@proxy.example:8080", 4)).toMatchObject({ protocol: "https" });
	});

	it("normalizes socks alias and lowercases countries", () => {
		expect(parseEgressEntry("socks://127.0.0.1:1080#nl", 0)).toMatchObject({ protocol: "socks5", country: "NL" });
	});

	it("skips invalid entries", () => {
		expect(parseEgressEntry("", 0)).toBeUndefined();
		expect(parseEgressEntry("not a url", 0)).toBeUndefined();
		expect(parseEgressEntry("ftp://example.com:21#US", 0)).toBeUndefined();
		// Invalid country keeps the proxy as a global exit (never drops it).
		expect(parseEgressEntry("socks5://127.0.0.1:1080#USA", 0)?.country).toBeUndefined();
	});

	it("parses comma/newline lists with dense ids", () => {
		const proxies = parseEgressProxies("socks5://127.0.0.1:1080#US, garbage\nhttp://127.0.0.1:8080#NL");
		expect(proxies.map((proxy) => proxy.id)).toEqual(["egress-0", "egress-1"]);
		expect(proxies.map((proxy) => proxy.country)).toEqual(["US", "NL"]);
	});

	it("strips the country query so it never reaches the proxy", () => {
		const proxy = parseEgressEntry("http://127.0.0.1:8080?country=DE&foo=bar", 0)!;
		expect(proxy.country).toBe("DE");
		expect(proxy.url).not.toContain("country=");
		expect(proxy.url).toContain("foo=bar");
	});
});

describe("egress redaction", () => {
	it("hides credentials, query, and fragment", () => {
		expect(redactProxyUrl("https://user:pass@proxy.example:8080?country=US#US")).toBe("https://proxy.example:8080");
		expect(redactProxyUrl("socks5://127.0.0.1:1080")).toBe("socks5://127.0.0.1:1080");
		expect(redactProxyUrl("garbage")).toBe("(invalid-proxy-url)");
	});
});

describe("country filter parsing", () => {
	it("uppercases, dedupes, and drops invalid codes", () => {
		expect(parseCountryFilter("us, DE, us, XX1,")).toEqual(["US", "DE", "XX1"].filter((code) => code.length === 2));
		expect(parseCountryFilter(undefined)).toBeUndefined();
		expect(parseCountryFilter("")).toBeUndefined();
		expect(parseCountryFilter("12")).toBeUndefined();
	});
});

describe("EgressPool", () => {
	const proxies = () => parseEgressProxies("socks5://127.0.0.1:1080#US,socks5://127.0.0.1:1081#NL,http://127.0.0.1:8080");

	it("picks uniformly and reports countries", () => {
		const pool = new EgressPool(proxies(), { random: () => 0 });
		expect(pool.pick()?.proxyId).toBe("egress-0");
		expect(pool.countries()).toEqual(["NL", "US"]);
		expect(pool.size).toBe(3);
	});

	it("is fail-closed on country filters: globals never substitute", () => {
		const pool = new EgressPool(proxies());
		expect(pool.pick(["DE"])).toBeNull();
		expect(pool.pick(["US"])?.country).toBe("US");
		// No filter admits everything, including the global exit.
		expect(pool.pick()).not.toBeNull();
	});

	it("blacklists failures with TTL and heals", () => {
		const pool = new EgressPool(proxies(), { blacklistTtlMs: 1_000 });
		pool.recordFailure("egress-0", 0);
		expect(pool.isBlacklisted("egress-0", 500)).toBe(true);
		expect(pool.pick(["US"], 500)).toBeNull();
		expect(pool.isBlacklisted("egress-0", 1_001)).toBe(false);
		pool.recordFailure("egress-0", 0);
		pool.recordSuccess("egress-0");
		expect(pool.isBlacklisted("egress-0", 500)).toBe(false);
	});

	it("require() throws precise fail-closed reasons", () => {
		expect(() => new EgressPool([]).require(["US"])).toThrowError(EgressExhaustedError);
		try {
			new EgressPool([]).require(["US"]);
			expect.unreachable();
		} catch (error) {
			expect((error as EgressExhaustedError).reason).toBe("no_proxies_configured");
		}
		const pool = new EgressPool(proxies());
		try {
			pool.require(["DE"]);
			expect.unreachable();
		} catch (error) {
			expect((error as EgressExhaustedError).reason).toBe("no_country_match");
		}
		pool.recordFailure("egress-0", 0);
		pool.recordFailure("egress-1", 0);
		pool.recordFailure("egress-2", 0);
		try {
			pool.require([], 1);
			expect.unreachable();
		} catch (error) {
			expect((error as EgressExhaustedError).reason).toBe("all_blacklisted");
		}
	});

	it("snapshot never contains credentials", () => {
		const pool = new EgressPool(parseEgressProxies("https://user:secret@proxy.example:8080#US"));
		const json = JSON.stringify(pool.snapshot());
		expect(json).not.toContain("secret");
		expect(json).not.toContain("user");
		expect(json).toContain("proxy.example:8080");
	});
});

describe("egress env config", () => {
	it("merges file + inline entries and reads the default filter", () => {
		const dir = mkdtempSync(join(tmpdir(), "egress-"));
		const file = join(dir, "proxies.json");
		writeFileSync(file, JSON.stringify([{ url: "socks5://127.0.0.1:1080", country: "US" }, "http://127.0.0.1:8080#NL", "garbage"]));
		const config = loadEgressConfigFromEnv({
			PI_SWARM_PROXIES_FILE: file,
			PI_SWARM_PROXIES: "socks5://127.0.0.1:1082#DE",
			PI_SWARM_EGRESS_COUNTRIES: "US,DE",
		});
		expect(config.proxies.map((proxy) => proxy.country)).toEqual(["US", "NL", "DE"]);
		expect(config.proxies.map((proxy) => proxy.id)).toEqual(["egress-0", "egress-1", "egress-2"]);
		expect(config.defaultCountries).toEqual(["US", "DE"]);
		expect(config.problems).toHaveLength(1);
	});

	it("reports an unreadable file without throwing", () => {
		const config = loadEgressConfigFromEnv({ PI_SWARM_PROXIES_FILE: "/nonexistent/proxies.json" });
		expect(config.proxies).toEqual([]);
		expect(config.problems).toHaveLength(1);
	});
});

describe("egress dispatchers", () => {
	it("builds cached dispatchers for http and socks5 without network", async () => {
		clearDispatcherCache();
		const http = await dispatcherFor("http://127.0.0.1:8080");
		const socks = await dispatcherFor("socks5://127.0.0.1:1080");
		expect(http).toBeDefined();
		expect(socks).toBeDefined();
		expect(await dispatcherFor("http://127.0.0.1:8080")).toBe(http);
		clearDispatcherCache();
	});
});

describe("spec parsing", () => {
	it("parses egressCountries and egressMode", () => {
		expect(parseEgressCountries(["us", "de", "bad", "US"])).toEqual(["US", "DE"]);
		expect(parseEgressCountries(undefined)).toBeUndefined();
		const spec = parseSpec({ task: "hi", egressCountries: ["nl"], egressMode: "off" });
		expect(spec.egressCountries).toEqual(["NL"]);
		expect(spec.egressMode).toBe("off");
		expect(parseSpec({ task: "hi" }).egressMode).toBeUndefined();
	});
});

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hello" }];

function testAccount(id: string): AccountRegistryEntry {
	return {
		accountId: id,
		providerId: "alpha",
		credentialRef: "ALPHA_API_KEY",
		enabled: true,
		maxConcurrency: 4,
		baseUrl: "https://alpha.test/v1",
		category: "free",
	};
}

describe("dispatcher egress integration", () => {
	it("fails closed with egress_exhausted on country mismatch (no network)", async () => {
		const registry = new AccountRegistry();
		registry.register(testAccount("a:1"));
		const dispatcher = new Dispatcher({
			accounts: registry,
			fetchModels: async () => [{ id: "m1", context_length: 128_000 }],
			egress: new EgressPool(parseEgressProxies("socks5://127.0.0.1:1080#US")),
		});
		await dispatcher.loadCandidates();
		const result = await dispatcher.executeTurn(MESSAGES, {
			agentId: "agent-1",
			turnIndex: 0,
			capabilities: ["text"],
			qualityFloor: null,
			allowUnknownQuality: true,
			maxAttempts: 1,
			signal: AbortSignal.timeout(10_000),
			egressCountries: ["DE"],
		});
		expect(result).toEqual({ ok: false, reason: "egress_exhausted" });
		// Fail-closed touched no provider budget.
		expect(dispatcher.quota.inFlightCount("a:1")).toBe(0);
		expect(dispatcher.circuit.get("a:1").state).toBe("closed");
	});

	it("dead exits blacklist without striking the provider", async () => {
		const registry = new AccountRegistry();
		registry.register(testAccount("a:1"));
		const pool = new EgressPool(parseEgressProxies("http://127.0.0.1:9#US"));
		const dispatcher = new Dispatcher({ accounts: registry, fetchModels: async () => [{ id: "m1", context_length: 128_000 }], egress: pool });
		await dispatcher.loadCandidates();
		const result = await dispatcher.executeTurn(MESSAGES, {
			agentId: "agent-1",
			turnIndex: 0,
			capabilities: ["text"],
			qualityFloor: null,
			allowUnknownQuality: true,
			maxAttempts: 1,
			signal: AbortSignal.timeout(30_000),
		});
		expect(result).toEqual({ ok: false, reason: "egress_exhausted" });
		// The exit is blacklisted; the PROVIDER is untouched.
		expect(pool.isBlacklisted("egress-0")).toBe(true);
		expect(dispatcher.circuit.get("a:1").state).toBe("closed");
		expect(dispatcher.blacklist.snapshot().size).toBe(0);
		expect(dispatcher.quota.inFlightCount("a:1")).toBe(0);
	}, 30_000);

	it("egressDisabled bypasses the pool", async () => {
		// Local mock provider answering a complete SSE turn: proves the turn
		// went DIRECT (pool demands DE, mock serves anyway) with no real net.
		const content = JSON.stringify({ choices: [{ delta: { content: "ok" } }] });
		const finish = JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] });
		const server: Server = createServer((_req, res) => {
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(`data: ${content}\n\n`);
			res.write(`data: ${finish}\n\n`);
			res.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		try {
			const port = (server.address() as AddressInfo).port;
			const registry = new AccountRegistry();
			registry.register({ ...testAccount("a:1"), baseUrl: `http://127.0.0.1:${port}/v1` });
			const dispatcher = new Dispatcher({
				accounts: registry,
				fetchModels: async () => [{ id: "m1", context_length: 128_000 }],
				egress: new EgressPool(parseEgressProxies("socks5://127.0.0.1:1080#US")),
			});
			await dispatcher.loadCandidates();
			const result = await dispatcher.executeTurn(MESSAGES, {
				agentId: "agent-1",
				turnIndex: 0,
				capabilities: ["text"],
				qualityFloor: null,
				allowUnknownQuality: true,
				maxAttempts: 1,
				signal: AbortSignal.timeout(30_000),
				egressCountries: ["DE"],
				egressDisabled: true,
			});
			// Bypassed the pool, so the direct turn succeeds — never
			// egress_exhausted despite the DE filter matching no exit.
			expect(result.ok).toBe(true);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	}, 30_000);
});
