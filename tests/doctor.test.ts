import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AccountRegistry, type AccountRegistryEntry, type WireModel } from "../src/catalog.ts";
import { doctor, type DoctorVerdict } from "../src/doctor.ts";

interface Behavior {
	catalog?: number | "throw";
	chat?: number | "throw";
	models?: WireModel[];
}

function account(id: string, category: AccountRegistryEntry["category"], baseUrl: string, credentialRef: string): AccountRegistryEntry & { baseUrl: string } {
	return {
		accountId: id,
		providerId: id.split(":")[0] ?? id,
		credentialRef,
		enabled: true,
		maxConcurrency: 4,
		baseUrl,
		category,
	};
}

function startProvider(behaviors: Record<string, Behavior>): Promise<{ server: Server; baseUrl: (name: string) => string }> {
	const server = createServer((req, res) => {
		const name = (req.url ?? "").replace(/^\/v1\//, "").split("/")[0] ?? "";
		const behavior = behaviors[name] ?? { catalog: 404 };
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			if (req.url?.endsWith("/models")) {
				if (behavior.catalog === "throw") {
					req.destroy();
					return;
				}
				if (typeof behavior.catalog === "number" && behavior.catalog !== 200) {
					res.writeHead(behavior.catalog, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: { message: "insufficient_credits" }, key: "sk-should-never-appear-anywhere-1234567890" }));
					return;
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ data: behavior.models ?? [{ id: "m1", model_type: "chat" }] }));
				return;
			}
			if (behavior.chat === "throw") {
				req.destroy();
				return;
			}
			if (typeof behavior.chat === "number" && behavior.chat !== 200) {
				res.writeHead(behavior.chat, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { message: "insufficient_credits", balance: "sk-leak-attempt-abcdefghijklmnop" } }));
				return;
			}
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
			res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve({ server, baseUrl: (name) => `http://127.0.0.1:${port}/v1/${name}` });
		});
	});
}

const KEY = "PI_SWARM_DOCTOR_TEST_KEY";
process.env[KEY] = "test-key";

describe("swarm_doctor", () => {
	it("classifies every health state and never leaks a credential", async () => {
		const { server, baseUrl } = await startProvider({
			healthy: { catalog: 200, chat: 200 },
			depleted: { catalog: 200, chat: 402 },
			chatBroken: { catalog: 200, chat: 500 },
			gone: { catalog: 404 },
			forbidden: { catalog: 403 },
			dying: { catalog: "throw" },
			dark: { catalog: 200, chat: 200, models: [{ id: "m1", model_type: "chat", pricing: { prompt: "1.5", completion: "3" } }] },
		});
		try {
			const accounts = [
				account("healthy:1", "free", baseUrl("healthy"), KEY),
				account("depleted:1", "freemium", baseUrl("depleted"), KEY),
				account("chatBroken:1", "free", baseUrl("chatBroken"), KEY),
				account("gone:1", "free", baseUrl("gone"), KEY),
				account("forbidden:1", "free", baseUrl("forbidden"), KEY),
				account("dying:1", "free", baseUrl("dying"), KEY),
				account("dark:1", "paid", baseUrl("dark"), KEY),
			];
			const routable = new Map<string, string[]>([
				["healthy:1", ["m1", "m2"]],
				["depleted:1", ["m1"]],
				["chatBroken:1", ["m1"]],
				["gone:1", ["m1"]],
				["forbidden:1", ["m1"]],
				["dying:1", ["m1"]],
			]);
			// The dead socket case is bounded by the sweep deadline, not the
			// per-request timeout — a health check must never hang on one host.
			const sweep = await doctor(accounts, routable, { timeoutMs: 1_500 });
			const verdict = (id: string): DoctorVerdict =>
				sweep.reports.find((report) => report.accountId === id)?.verdict as DoctorVerdict;

			expect(verdict("healthy:1")).toBe("ok");
			expect(verdict("depleted:1")).toBe("balance_exhausted");
			expect(verdict("chatBroken:1")).toBe("chat_failed");
			expect(verdict("gone:1")).toBe("catalog_unreachable");
			expect(verdict("forbidden:1")).toBe("catalog_unreachable");
			expect(verdict("dying:1")).toBe("unreachable");

			expect(sweep.usable).toBe(1);
			expect(sweep.total).toBe(7);
			const healthy = sweep.reports.find((report) => report.accountId === "healthy:1");
			expect(healthy?.routableModels).toBe(2);
			expect(healthy?.probeModel).toBe("m1");

			// An exhausted balance is the exact failure a reachable catalog hides.
			const depleted = sweep.reports.find((report) => report.accountId === "depleted:1");
			expect(depleted?.probeStatus).toBe(402);
			expect(depleted?.usable).toBe(false);
		} finally {
			server.close();
		}
	});

	it("reports an account with nothing routable and an account with no key", async () => {
		const { server, baseUrl } = await startProvider({ healthy: { catalog: 200, chat: 200 } });
		try {
			const sweep = await doctor(
				[account("healthy:1", "free", baseUrl("healthy"), KEY), account("dark:1", "free", baseUrl("healthy"), KEY)],
				new Map([["healthy:1", ["m1"]]]),
			);
			// Reachable, keyed, but nothing free to route: no request spent.
			expect(sweep.reports.find((r) => r.accountId === "dark:1")?.verdict).toBe("no_routable_models");
			expect(sweep.reports.find((r) => r.accountId === "dark:1")?.keyed).toBe(true);
			expect(sweep.usable).toBe(1);
		} finally {
			server.close();
		}
	});

	it("flags a logged-out account that needs a key as uncredentialed", async () => {
		const { server, baseUrl } = await startProvider({ healthy: { catalog: 200, chat: 200 } });
		try {
			const sweep = await doctor(
				[account("keyless:1", "freemium", baseUrl("healthy"), "PI_SWARM_DOCTOR_ABSENT_KEY")],
				new Map([["keyless:1", ["m1"]]]),
			);
			expect(sweep.reports[0]?.verdict).toBe("no_credential");
			expect(sweep.usable).toBe(0);
		} finally {
			server.close();
		}
	});

	it("redacts long opaque strings from provider error text", async () => {
		const { server, baseUrl } = await startProvider({ leaky: { catalog: 402 } });
		try {
			const sweep = await doctor([account("leaky:1", "freemium", baseUrl("leaky"), KEY)], new Map());
			const report = sweep.reports[0];
			expect(report?.verdict).toBe("balance_exhausted");
			expect(report?.detail ?? "").not.toContain("sk-should-never-appear");
			expect(report?.detail ?? "").not.toContain("test-key");
		} finally {
			server.close();
		}
	});

	it("exposes the sweep through the service and the MCP tool", async () => {
		const { server, baseUrl } = await startProvider({ healthy: { catalog: 200, chat: 200 } });
		try {
			const { SwarmService } = await import("../src/swarm.ts");
			const accounts = [account("healthy:1", "free", baseUrl("healthy"), KEY)];
			const service = new SwarmService({ accounts });
			service.dispatcher["candidatesCache"] = [{
				accountId: "healthy:1", providerId: "healthy", modelId: "m1", name: "m1",
				ciScore: null, contextWindow: 128_000, capabilities: { text: true, vision: false, tools: true },
			}];
			const result = await service.doctor();
			expect(result.usable).toBe(1);
			expect(result.reports[0]?.verdict).toBe("ok");

			const calls: Array<Record<string, unknown>> = [];
			const backend = {
				doctor: async (args: Record<string, unknown>) => {
					calls.push(args);
					return { usable: 1, total: 1, reports: [] };
				},
				spawn: async () => ({ agentId: "a", duplicate: false }),
				plan: async () => ({ planId: "p", childIds: [], duplicate: false }),
				gather: async () => ({}),
				status: async () => ({ state: "completed", events: [] }),
				cancel: async () => true,
				capacity: async () => [],
				models: async () => [],
				reset: async () => ({}),
			};
			const { handleMessage } = await import("../src/mcp-server.ts");
			const result2 = (await handleMessage(backend as never, {
				jsonrpc: "2.0", id: 1, method: "tools/call",
				params: { name: "swarm_doctor", arguments: { timeoutMs: 30_000 } },
			})) as { content: Array<{ text: string }> };
			expect(JSON.parse(result2.content[0]?.text ?? "{}")).toMatchObject({ usable: 1 });
			expect(calls[0]).toMatchObject({ timeoutMs: 30_000 });
			const tools = (await handleMessage(backend as never, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
				tools: Array<{ name: string }>;
			};
			expect(tools.tools.map((tool) => tool.name)).toContain("swarm_doctor");
		} finally {
			server.close();
		}
	});
});
