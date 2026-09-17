import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";

/**
 * MCP request concurrency.
 *
 * A long-running tool call (swarm_wait can block for its whole window) must
 * NOT block the server: when the stdio loop awaited each handler, every later
 * request sat unprocessed until the slow one finished, so even an instant
 * swarm_spawn hit the client's 30s timeout. This drives a real server process
 * through a fake HTTP backend and asserts a fast call answers while a slow one
 * is still pending.
 */

interface Harness {
	server: Server;
	child: ChildProcess;
	call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
	close: () => void;
}

/** Fake pi-swarm HTTP backend: fast spawn/capacity, slow status. */
async function startHarness(): Promise<Harness> {
	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const json = (body: unknown): void => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
		};

		if (req.method === "POST" && url.pathname === "/v1/agents") {
			req.resume();
			req.on("end", () => json({ agentId: "agent-1", duplicate: false }));
			return;
		}
		if (url.pathname === "/v1/capacity") {
			json([{ accountId: "fake:primary", circuit: "closed" }]);
			return;
		}
		if (url.pathname.startsWith("/v1/agents/")) {
			// A REAL delay is the point of this test: the property under test is
			// that a separate OS process serving stdio keeps answering while one
			// request is in flight. Fake timers cannot reach across the process
			// boundary, so the slow path is a genuine wall-clock wait.
			setTimeout(() => json({ state: "running", events: [] }), 3_000);
			return;
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	const child = spawn(
		`${process.cwd()}/node_modules/.bin/tsx`,
		["src/mcp-server.ts"],
		{
			cwd: process.cwd(),
			env: { ...process.env, PI_SWARM_URL: `http://127.0.0.1:${port}` },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	// Keep stderr so a startup crash is diagnosable instead of a silent hang.
	let stderr = "";
	child.stderr!.setEncoding("utf8");
	child.stderr!.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child.on("exit", (code) => {
		if (code !== 0 && pendingInit !== undefined) {
			pendingInit.reject(new Error(`MCP server exited with code ${code}\n${stderr.slice(-800)}`));
		}
	});

	let buffer = "";
	let nextId = 1;
	const pending = new Map<number, (value: unknown) => void>();
	/** Tracks the initialize request so a startup crash fails fast. */
	let pendingInit: { reject: (error: Error) => void } | undefined;
	child.stdout!.setEncoding("utf8");
	child.stdout!.on("data", (chunk: string) => {
		buffer += chunk;
		let newlineIndex: number;
		while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (line.length === 0) continue;
			const message = JSON.parse(line) as { id?: number; result?: unknown };
			if (message.id === undefined) continue;
			const resolve = pending.get(message.id);
			if (resolve) {
				pending.delete(message.id);
				resolve(message.result);
			}
		}
	});

	const request = (method: string, params?: unknown): Promise<unknown> => {
		const id = nextId++;
		const promise = new Promise<unknown>((resolve, reject) => {
			pending.set(id, resolve);
			if (method === "initialize") pendingInit = { reject };
		});
		child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
		return promise;
	};

	try {
		await request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "concurrency-test", version: "1.0.0" },
		});
	} catch (error) {
		child.kill();
		server.close();
		throw error;
	}
	pendingInit = undefined;
	child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
		const result = (await request("tools/call", { name, arguments: args })) as { content: Array<{ text: string }> };
		return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
	};

	return {
		server,
		child,
		call,
		close: () => {
			child.kill();
			server.close();
		},
	};
}

let harness: Harness | undefined;

afterEach(() => {
	harness?.close();
	harness = undefined;
});

describe("MCP request concurrency", () => {
	it("answers a fast call while a slow call is still pending", async () => {
		harness = await startHarness();

		// Start a wait that will block on the slow status endpoint.
		const slow = harness.call("swarm_wait", { agentId: "agent-1", timeoutMs: 10_000 });

		// A fast call must not queue behind it.
		const startedAt = Date.now();
		const capacity = await harness.call("swarm_capacity", {});
		const elapsed = Date.now() - startedAt;

		expect(Array.isArray(capacity)).toBe(true);
		expect(elapsed).toBeLessThan(2_000); // NOT serialized behind the 3s+ wait

		// The slow call still completes normally afterwards.
		const final = await slow;
		expect(final["state"]).toBe("running");
		expect(final["timedOut"]).toBe(true);
	}, 30_000);

	it("handles several concurrent tool calls without cross-talk", async () => {
		harness = await startHarness();
		const results = await Promise.all([
			harness.call("swarm_capacity", {}),
			harness.call("swarm_capacity", {}),
			harness.call("swarm_capacity", {}),
		]);
		for (const result of results) {
			expect(Array.isArray(result)).toBe(true);
		}
	}, 30_000);

	it("spawn responds immediately (it must not wait for a running agent)", async () => {
		harness = await startHarness();
		const startedAt = Date.now();
		const spawned = await harness.call("swarm_spawn", { task: "hello" });
		expect(Date.now() - startedAt).toBeLessThan(2_000);
		expect(spawned["agentId"]).toBe("agent-1");
	}, 30_000);
});