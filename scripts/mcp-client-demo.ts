/**
 * Minimal MCP stdio client: drives the pi-swarm MCP server exactly the way a
 * coding agent (Oh My Pi, OpenCode, …) does, and prints the answer.
 *
 * Usage: npx tsx scripts/mcp-client-demo.ts "your task here"
 *
 * Doubles as the integration proof for the MCP surface: it performs the
 * initialize handshake, then swarm_spawn → swarm_wait and reports the result.
 */

import { spawn } from "node:child_process";

const task = process.argv.slice(2).join(" ") || "What is 7*6? Answer with just the number.";

const child = spawn("npx", ["tsx", "src/mcp-server.ts"], {
	cwd: process.cwd(),
	stdio: ["pipe", "pipe", "inherit"], // stderr passes through for diagnostics
});

let buffer = "";
let nextId = 1;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
	buffer += chunk;
	let newlineIndex: number;
	while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, newlineIndex).trim();
		buffer = buffer.slice(newlineIndex + 1);
		if (line.length === 0) continue;
		const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
		if (message.id === undefined) continue; // notification
		const waiter = pending.get(message.id);
		if (!waiter) continue;
		pending.delete(message.id);
		if (message.error) waiter.reject(new Error(message.error.message));
		else waiter.resolve(message.result);
	}
});

/** Send a JSON-RPC request and await its response. */
function request(method: string, params?: Record<string, unknown>): Promise<unknown> {
	const id = nextId++;
	const message = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
	const promise = new Promise<unknown>((resolve, reject) => pending.set(id, { resolve, reject }));
	child.stdin.write(`${message}\n`);
	return promise;
}

/** Call an MCP tool and parse its JSON payload. */
async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const result = (await request("tools/call", { name, arguments: args })) as {
		content: Array<{ type: string; text: string }>;
		isError?: boolean;
	};
	const text = result.content[0]?.text ?? "{}";
	const parsed = JSON.parse(text) as Record<string, unknown>;
	if (result.isError) throw new Error(`tool ${name} failed: ${text}`);
	return parsed;
}

async function main(): Promise<number> {
	await request("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "pi-swarm-demo-client", version: "1.0.0" },
	});
	child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

	const tools = (await request("tools/list")) as { tools: Array<{ name: string }> };
	process.stdout.write(`tools: ${tools.tools.map((tool) => tool.name).join(", ")}\n`);

	const capacity = (await callTool("swarm_capacity", {})) as unknown as Array<{ accountId: string; circuit: string }>;
	process.stdout.write(`capacity: ${capacity.map((account) => `${account.accountId}/${account.circuit}`).join(", ")}\n`);

	process.stdout.write(`spawning: ${JSON.stringify(task)}\n`);
	const spawned = await callTool("swarm_spawn", {
		task,
		maxTurns: 4,
		maxWallTimeMs: 180_000,
		maxProviderAttemptsPerTurn: 10,
		capabilities: ["text"],
		idempotencyKey: `mcp-demo-${Date.now()}`,
	});
	const agentId = String(spawned["agentId"]);
	process.stdout.write(`agent: ${agentId}\n`);

	const final = await callTool("swarm_wait", { agentId, timeoutMs: 180_000 });
	process.stdout.write(`state: ${String(final["state"])}\n`);
	process.stdout.write(`answer: ${JSON.stringify(final["finalContent"] ?? final["failReason"])}\n`);
	if (final["timedOut"] === true) process.stdout.write("(timed out waiting)\n");

	child.stdin.end();
	return final["state"] === "completed" ? 0 : 1;
}

process.exitCode = await main();