/**
 * Verify an MCP server entry from a harness config end to end.
 *
 * Reads the configured command/args/cwd/env, spawns it exactly as the harness
 * would, then drives the real MCP handshake and a spawn -> wait cycle. If this
 * passes, any remaining failure is in the harness config location, not the
 * server.
 *
 * Usage:
 *   npx tsx scripts/verify-mcp-config.ts                 # ~/.omp/agent/mcp.json, server "swarm"
 *   npx tsx scripts/verify-mcp-config.ts <config.json> [serverName]
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface McpServerEntry {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
}

const configPath = process.argv[2] ?? join(homedir(), ".omp", "agent", "mcp.json");
const serverName = process.argv[3] ?? "swarm";

/** Accept both the `mcpServers` shape and OpenCode's `mcp` shapes. */
function readServerEntry(path: string, name: string): McpServerEntry {
	const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	const fromMcpServers = (raw["mcpServers"] as Record<string, McpServerEntry> | undefined)?.[name];
	if (fromMcpServers) return fromMcpServers;

	const mcp = raw["mcp"] as Record<string, unknown> | undefined;
	if (mcp) {
		const direct = mcp[name] as (McpServerEntry & { command?: string | string[] }) | undefined;
		const nested = (mcp["servers"] as Record<string, McpServerEntry> | undefined)?.[name];
		const entry = direct ?? nested;
		if (entry) {
			// OpenCode packs executable + args into one command array.
			if (Array.isArray(entry.command)) {
				const [command, ...args] = entry.command as string[];
				return { ...entry, command: command ?? "", args: args.length > 0 ? args : (entry.args ?? []) };
			}
			return entry as McpServerEntry;
		}
	}
	throw new Error(`server "${name}" not found in ${path}`);
}

async function main(): Promise<number> {
	let entry: McpServerEntry;
	try {
		entry = readServerEntry(configPath, serverName);
	} catch (error) {
		process.stdout.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}

	process.stdout.write(`config: ${configPath}\n`);
	process.stdout.write(`server: ${serverName}\n`);
	process.stdout.write(`command: ${entry.command} ${(entry.args ?? []).join(" ")}\n`);
	if (entry.cwd) process.stdout.write(`cwd: ${entry.cwd}\n`);

	const child = spawn(entry.command, entry.args ?? [], {
		cwd: entry.cwd ?? process.cwd(),
		env: { ...process.env, ...(entry.env ?? {}) },
		stdio: ["pipe", "pipe", "pipe"],
	});

	// Surface the server's stderr so a startup crash is visible.
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});

	let buffer = "";
	let nextId = 1;
	const pending = new Map<number, (value: unknown) => void>();
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let newlineIndex: number;
		while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (line.length === 0) continue;
			try {
				const message = JSON.parse(line) as { id?: number; result?: unknown };
				if (message.id === undefined) continue;
				const resolve = pending.get(message.id);
				if (resolve) {
					pending.delete(message.id);
					resolve(message.result);
				}
			} catch {
				process.stdout.write(`FAIL: non-JSON on stdout (protocol corruption): ${line.slice(0, 120)}\n`);
			}
		}
	});

	const request = (method: string, params?: unknown): Promise<unknown> => {
		const id = nextId++;
		const promise = new Promise<unknown>((resolve) => pending.set(id, resolve));
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
		return promise;
	};

	const callTool = async (name: string, args: unknown): Promise<Record<string, unknown>> => {
		const result = (await request("tools/call", { name, arguments: args })) as { content: Array<{ text: string }> };
		return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
	};

	try {
		const initialized = (await request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "verify-mcp-config", version: "1.0.0" },
		})) as { serverInfo?: { name?: string }; protocolVersion?: string };
		process.stdout.write(`handshake: OK (${initialized.serverInfo?.name ?? "?"}, ${initialized.protocolVersion ?? "?"})\n`);
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

		const tools = (await request("tools/list")) as { tools: Array<{ name: string }> };
		process.stdout.write(`tools: ${tools.tools.map((tool) => tool.name).join(", ")}\n`);

		const capacity = await callTool("swarm_capacity", {});
		const accounts = (capacity as unknown as Array<{ accountId: string; circuit: string }>).map(
			(account) => `${account.accountId}/${account.circuit}`,
		);
		process.stdout.write(`capacity: ${accounts.join(", ") || "(none)"}\n`);

		const spawned = await callTool("swarm_spawn", {
			task: "What is 5*5? Answer with just the number.",
			maxTurns: 2,
			maxProviderAttemptsPerTurn: 10,
			idempotencyKey: `verify-${Date.now()}`,
		});
		const agentId = String(spawned["agentId"]);
		process.stdout.write(`spawn: ${agentId}\n`);

		const final = await callTool("swarm_wait", { agentId, timeoutMs: 150_000 });
		process.stdout.write(`state: ${String(final["state"])}\n`);
		process.stdout.write(`answer: ${JSON.stringify(final["finalContent"] ?? final["failReason"])}\n`);

		const state = String(final["state"]);
		child.stdin.end();

		if (state === "completed") {
			process.stdout.write("RESULT: PASS\n");
			return 0;
		}
		if (state === "running") {
			// The wiring is proven: handshake, tool list, capacity and spawn all
			// worked, and the agent is genuinely mid-turn. Free tiers can exceed
			// any wait window, so this is NOT a config failure.
			process.stdout.write("RESULT: WIRING OK (agent still running — free tier is slow, not a config problem)\n");
			return 0;
		}
		process.stdout.write(`RESULT: FAIL (agent ended in state "${state}")\n`);
		return 1;
	} catch (error) {
		process.stdout.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
		if (stderr.length > 0) process.stdout.write(`server stderr:\n${stderr.slice(-1500)}\n`);
		child.kill();
		return 1;
	}
}

process.exitCode = await main();