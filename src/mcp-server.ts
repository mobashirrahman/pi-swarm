/**
 * MCP stdio server: exposes the swarm to MCP-capable coding agents
 * (Oh My Pi, OpenCode, Claude Code, …) as native tools.
 *
 * Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout — the MCP
 * stdio transport. Nothing but protocol frames may go to stdout; all logging
 * goes to stderr (the logger already writes there for warn/error, and this
 * module silences console output entirely).
 *
 * Two backends:
 *  - EMBEDDED (default): constructs the SwarmService in-process, so the agent
 *    gets a working swarm with no daemon to start.
 *  - PROXY: when PI_SWARM_URL is set, forwards to an already-running server
 *    (share one swarm across sessions/machines).
 *
 * Tools: swarm_spawn, swarm_wait, swarm_status, swarm_cancel, swarm_capacity.
 */

import { AgentStore } from "./store.ts";
import { SwarmService } from "./swarm.ts";
import { Workspace } from "./workspace.ts";
import { SqliteLeaseStore } from "./leases.ts";
import { recoverInterrupted } from "./recovery.ts";
import { loadConfiguredEnvFile } from "./env-file.ts";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { AgentSpec } from "./agent.ts";

const SERVER_NAME = "pi-swarm";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2024-11-05";
/**
 * Default `swarm_wait` budget. MUST stay under the MCP client's request
 * timeout, which is 30s by default in OMP (and similar elsewhere): a longer
 * block gets cut off client-side with an opaque "Request timeout" and the
 * outcome unknown (observed live). When the agent is still running we return
 * `timedOut: true` so the caller simply waits again — no config required.
 * Harnesses configured with a longer `timeout` can pass a larger `timeoutMs`.
 */
const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
const WAIT_POLL_MS = 500;

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id?: number | string | null;
	method: string;
	params?: Record<string, unknown>;
}

interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDefinition[] = [
	{
		name: "swarm_spawn",
		description:
			"Spawn a background agent on the swarm. Returns immediately with an agent id; the agent runs concurrently on the best available provider account. Use swarm_wait to collect its answer.",
		inputSchema: {
			type: "object",
			properties: {
				task: { type: "string", description: "The task prompt for the agent." },
				system: { type: "string", description: "Optional system prompt." },
				capabilities: {
					type: "array",
					items: { type: "string", enum: ["text", "vision", "tools"] },
					description: "Required model capabilities. Include \"tools\" to enable tool use.",
				},
				maxTurns: { type: "number", description: "Max model turns (default 12)." },
				maxWallTimeMs: { type: "number", description: "Wall-clock budget in ms (default 600000)." },
				maxProviderAttemptsPerTurn: {
					type: "number",
					description: "How many provider reroutes per turn (default 3; raise on flaky free tiers).",
				},
				parentAgentId: { type: "string", description: "Parent agent id; cancelling the parent cancels this agent." },
				idempotencyKey: { type: "string", description: "Dedupe key — re-spawning with the same key returns the existing agent." },
			},
			required: ["task"],
		},
	},
	{
		name: "swarm_wait",
		description:
			"Wait for an agent to reach a terminal state and return its final answer. Returns {state, finalContent} on completion, or {state: \"running\", timedOut: true} if the wait window elapsed — in that case simply call swarm_wait again (free providers can take minutes).",
		inputSchema: {
			type: "object",
			properties: {
				agentId: { type: "string", description: "Agent id returned by swarm_spawn." },
				timeoutMs: {
					type: "number",
					description: `How long to wait before returning timedOut (default ${DEFAULT_WAIT_TIMEOUT_MS}; keep under your MCP client's request timeout).`,
				},
			},
			required: ["agentId"],
		},
	},
	{
		name: "swarm_status",
		description: "Read an agent's current state, final answer or failure reason, and recent progress events.",
		inputSchema: {
			type: "object",
			properties: { agentId: { type: "string", description: "Agent id returned by swarm_spawn." } },
			required: ["agentId"],
		},
	},
	{
		name: "swarm_cancel",
		description: "Cancel an agent and every agent it spawned (cancellation propagates to descendants).",
		inputSchema: {
			type: "object",
			properties: { agentId: { type: "string", description: "Agent id to cancel." } },
			required: ["agentId"],
		},
	},
	{
		name: "swarm_capacity",
		description: "Show per-account provider capacity: circuit state, in-flight turns, and remaining quota where known.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "swarm_models",
		description:
			"Inspect the routing view: every routable model with the signals that decide selection — intelligence score, measured latency/TTFT/tokens-per-second, success rate, sample count, and account circuit state. Use this to see which backends the swarm will pick and why.",
		inputSchema: {
			type: "object",
			properties: {
				limit: { type: "number", description: "Return only the top N candidates (default: all)." },
				accountId: { type: "string", description: "Filter to one account, e.g. \"nvidia:primary\"." },
			},
		},
	},
	{
		name: "swarm_reset",
		description:
			"Administrative capacity reset: close circuits and clear model bans for one account (or all when omitted). Recovers the pool after a credential rotation or a false-positive trip without restarting.",
		inputSchema: {
			type: "object",
			properties: {
				accountId: { type: "string", description: "Reset only this account (default: all accounts)." },
			},
		},
	},
];

// =============================================================================
// Backends
// =============================================================================

interface SwarmBackend {
	spawn(args: Record<string, unknown>): Promise<{ agentId: string; duplicate: boolean }>;
	status(agentId: string): Promise<{ state: string; finalContent?: string | undefined; failReason?: string | undefined; events: string[] }>;
	cancel(agentId: string): Promise<boolean>;
	capacity(): Promise<unknown>;
	models(args: Record<string, unknown>): Promise<unknown>;
	reset(args: Record<string, unknown>): Promise<unknown>;
}

/** In-process swarm (no daemon required). */
class EmbeddedBackend implements SwarmBackend {
	constructor(private readonly service: SwarmService) {}

	async spawn(args: Record<string, unknown>): Promise<{ agentId: string; duplicate: boolean }> {
		const spec = {
			task: String(args["task"] ?? ""),
			...(args["system"] !== undefined ? { system: String(args["system"]) } : {}),
			...(args["capabilities"] !== undefined ? { capabilities: args["capabilities"] as AgentSpec["capabilities"] } : {}),
			...(args["maxTurns"] !== undefined ? { maxTurns: Number(args["maxTurns"]) } : {}),
			...(args["maxWallTimeMs"] !== undefined ? { maxWallTimeMs: Number(args["maxWallTimeMs"]) } : {}),
			...(args["maxProviderAttemptsPerTurn"] !== undefined
				? { maxProviderAttemptsPerTurn: Number(args["maxProviderAttemptsPerTurn"]) }
				: {}),
			...(args["parentAgentId"] !== undefined ? { parentAgentId: String(args["parentAgentId"]) } : {}),
		} as unknown as Omit<AgentSpec, "agentId">;
		return this.service.spawnAgent({
			spec,
			idempotencyKey: args["idempotencyKey"] !== undefined ? String(args["idempotencyKey"]) : undefined,
		});
	}

	async status(agentId: string): Promise<{ state: string; finalContent?: string | undefined; failReason?: string | undefined; events: string[] }> {
		const agent = this.service.getAgent(agentId);
		if (!agent) return { state: "unknown", events: [] };
		return {
			state: agent.state,
			finalContent: agent.finalContent,
			failReason: agent.failReason,
			events: this.service.eventBus.historyFor(agentId).map((event) => event.type),
		};
	}

	async cancel(agentId: string): Promise<boolean> {
		return this.service.cancelAgent(agentId);
	}

	async capacity(): Promise<unknown> {
		return this.service.capacity();
	}

	async models(args: Record<string, unknown>): Promise<unknown> {
		const limit = args["limit"] !== undefined ? Number(args["limit"]) : undefined;
		const accountId = args["accountId"] !== undefined ? String(args["accountId"]) : undefined;
		let rows = this.service.routingView(limit !== undefined && Number.isFinite(limit) ? { limit } : {});
		if (accountId !== undefined) rows = rows.filter((row) => row.accountId === accountId);
		return { models: rows };
	}

	async reset(args: Record<string, unknown>): Promise<unknown> {
		const accountId = args["accountId"] !== undefined ? String(args["accountId"]) : undefined;
		return this.service.resetCapacity(accountId);
	}
}

/** Proxy to a running pi-swarm HTTP server (PI_SWARM_URL). */
class HttpBackend implements SwarmBackend {
	constructor(private readonly baseUrl: string) {}

	async spawn(args: Record<string, unknown>): Promise<{ agentId: string; duplicate: boolean }> {
		const response = await fetch(`${this.baseUrl}/v1/agents`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				spec: {
					task: args["task"],
					system: args["system"],
					capabilities: args["capabilities"],
					maxTurns: args["maxTurns"],
					maxWallTimeMs: args["maxWallTimeMs"],
					maxProviderAttemptsPerTurn: args["maxProviderAttemptsPerTurn"],
					parentAgentId: args["parentAgentId"],
				},
				idempotencyKey: args["idempotencyKey"],
			}),
		});
		return (await response.json()) as { agentId: string; duplicate: boolean };
	}

	async status(agentId: string): Promise<{ state: string; finalContent?: string | undefined; failReason?: string | undefined; events: string[] }> {
		const response = await fetch(`${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}`);
		if (!response.ok) return { state: "unknown", events: [] };
		const agent = (await response.json()) as { state: string; finalContent?: string; failReason?: string };
		return { state: agent.state, finalContent: agent.finalContent, failReason: agent.failReason, events: [] };
	}

	async cancel(agentId: string): Promise<boolean> {
		const response = await fetch(`${this.baseUrl}/v1/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
		const body = (await response.json()) as { cancelled?: boolean };
		return body.cancelled === true;
	}

	async capacity(): Promise<unknown> {
		const response = await fetch(`${this.baseUrl}/v1/capacity`);
		return await response.json();
	}

	async models(args: Record<string, unknown>): Promise<unknown> {
		const params = new URLSearchParams();
		if (args["limit"] !== undefined) params.set("limit", String(Number(args["limit"])));
		if (args["accountId"] !== undefined) params.set("accountId", String(args["accountId"]));
		const query = params.size > 0 ? `?${params.toString()}` : "";
		const response = await fetch(`${this.baseUrl}/v1/models${query}`);
		return await response.json();
	}

	async reset(args: Record<string, unknown>): Promise<unknown> {
		const response = await fetch(`${this.baseUrl}/v1/capacity/reset`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ accountId: args["accountId"] }),
		});
		return await response.json();
	}
}

/** Build the backend the environment asks for. */
export async function createBackend(): Promise<SwarmBackend> {
	// Load provider credentials from PI_SWARM_ENV_FILE before anything reads
	// them. Only NAMES are reported — values never reach the log.
	const envReport = loadConfiguredEnvFile();
	if (envReport.path !== undefined) {
		process.stderr.write(
			`${JSON.stringify({ ns: "mcp", msg: "env_file_loaded", path: envReport.path, loaded: envReport.loaded.length, skipped: envReport.skipped.length, problems: envReport.problems.length })}\n`,
		);
	}

	const url = process.env["PI_SWARM_URL"];
	if (url !== undefined && url.length > 0) return new HttpBackend(url.replace(/\/$/, ""));

	const dbPath = process.env["PI_SWARM_DB"] ?? ".pi-swarm.db";
	const workspaceRoot = process.env["PI_SWARM_WORKSPACE"] ?? `${process.cwd()}/.pi-swarm-workspace`;
	const store = new AgentStore(dbPath);
	recoverInterrupted(store);
	const workspace = new Workspace({ root: workspaceRoot });
	await workspace.ensure();
	const service = new SwarmService({ store, workspace, leases: new SqliteLeaseStore(store.database) });
	await service.refreshCatalogs();
	return new EmbeddedBackend(service);
}

// =============================================================================
// Tool dispatch
// =============================================================================

const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);

async function callTool(backend: SwarmBackend, name: string, args: Record<string, unknown>): Promise<string> {
	switch (name) {
		case "swarm_spawn": {
			const result = await backend.spawn(args);
			return JSON.stringify(result);
		}
		case "swarm_status": {
			const status = await backend.status(String(args["agentId"] ?? ""));
			return JSON.stringify(status);
		}
		case "swarm_wait": {
			const agentId = String(args["agentId"] ?? "");
			const timeoutMs = Number(args["timeoutMs"] ?? DEFAULT_WAIT_TIMEOUT_MS);
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const status = await backend.status(agentId);
				if (TERMINAL_STATES.has(status.state)) return JSON.stringify(status);
				if (Date.now() >= deadline) {
					return JSON.stringify({ ...status, timedOut: true });
				}
				await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
			}
		}
		case "swarm_cancel": {
			const cancelled = await backend.cancel(String(args["agentId"] ?? ""));
			return JSON.stringify({ cancelled });
		}
		case "swarm_capacity": {
			return JSON.stringify(await backend.capacity());
		}
		case "swarm_models": {
			return JSON.stringify(await backend.models(args));
		}
		case "swarm_reset": {
			return JSON.stringify(await backend.reset(args));
		}
		default:
			throw new Error(`unknown tool: ${name}`);
	}
}

// =============================================================================
// JSON-RPC loop
// =============================================================================

function write(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writeResult(id: JsonRpcRequest["id"], result: unknown): void {
	write({ jsonrpc: "2.0", id: id ?? null, result });
}

function writeError(id: JsonRpcRequest["id"], code: number, message: string): void {
	write({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

/** Handle one parsed JSON-RPC message. Exported for tests. */
export async function handleMessage(backend: SwarmBackend, request: JsonRpcRequest): Promise<unknown | undefined> {
	switch (request.method) {
		case "initialize":
			return {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
			};
		case "notifications/initialized":
		case "notifications/cancelled":
			return undefined; // notifications take no response
		case "ping":
			return {};
		case "tools/list":
			return { tools: TOOLS };
		case "tools/call": {
			const params = request.params ?? {};
			const name = String(params["name"] ?? "");
			const args = (params["arguments"] as Record<string, unknown> | undefined) ?? {};
			try {
				const text = await callTool(backend, name, args);
				return { content: [{ type: "text", text }] };
			} catch (error) {
				// Tool errors are reported IN-BAND so the model can react.
				return {
					content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
					isError: true,
				};
			}
		}
		default:
			throw new Error(`method not found: ${request.method}`);
	}
}

/** Run the stdio loop until stdin closes. */
export async function runServer(): Promise<void> {
	const backend = await createBackend();
	let buffer = "";

	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) {
		buffer += chunk;
		let newlineIndex: number;
		while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (line.length === 0) continue;

			let request: JsonRpcRequest;
			try {
				request = JSON.parse(line) as JsonRpcRequest;
			} catch {
				writeError(null, -32700, "parse error");
				continue;
			}

			// Dispatch WITHOUT awaiting. A long-running call (swarm_wait can
			// block for its whole window) must not block the server: awaiting
			// here meant every later request sat unprocessed until the slow one
			// finished, so even an instant swarm_spawn hit the client's 30s
			// timeout (observed live). MCP clients pipeline requests.
			void (async () => {
				try {
					const result = await handleMessage(backend, request);
					if (result !== undefined) writeResult(request.id, result);
				} catch (error) {
					writeError(request.id, -32601, error instanceof Error ? error.message : String(error));
				}
			})();
		}
	}

	// stdin EOF means the MCP client is gone. Exit explicitly: the embedded
	// backend holds an open SQLite handle and may have agents in flight, so
	// the event loop would otherwise keep the process alive after the client
	// disconnected.
	process.exit(0);
}

// Only run the loop when executed as a program (imported in tests otherwise).
// The realpath comparison matters: package managers invoke the binary through
// a symlink (node_modules/.bin), while import.meta.url is already resolved.
function isMainModule(): boolean {
	try {
		const invoked = process.argv[1];
		return !!invoked && import.meta.url === pathToFileURL(realpathSync(invoked)).href;
	} catch {
		return false;
	}
}

if (isMainModule()) {
	await runServer();
}