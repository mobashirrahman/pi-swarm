/**
 * HTTP server: thin wrapper over SwarmService (node:http, zero deps).
 * Endpoints:
 *   POST /v1/agents            spawn (idempotencyKey honored)
 *   GET  /v1/agents/:id        status + transcript
 *   DELETE /v1/agents/:id      cancel
 *   GET  /v1/capacity          per-account quota/circuit view
 *   POST /v1/capacity/reset    close circuits + clear model bans (recovery)
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { AgentStore } from "./store.ts";
import { SwarmService } from "./swarm.ts";
import type { AgentSpec } from "./agent.ts";
import type { QualityMetric, TierHint } from "./types.ts";
import { MAX_PLAN_CHILDREN, type PlanRequest, type PlanSubtask } from "./swarm.ts";
import { SqliteLeaseStore } from "./leases.ts";
import { Workspace } from "./workspace.ts";
import { recoverInterrupted } from "./recovery.ts";
import { loadConfiguredEnvFile } from "./env-file.ts";
import { createLogger } from "./logger.ts";

const _logger = createLogger("server");

const PORT = Number.parseInt(process.env.PI_SWARM_PORT ?? "7463", 10);
const DB_PATH = process.env.PI_SWARM_DB ?? ".pi-swarm.db";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
	res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

const TIER_HINTS: ReadonlySet<string> = new Set(["fast", "balanced", "frontier"]);
const QUALITY_METRICS: ReadonlySet<string> = new Set(["codingIndex", "intelligenceIndex", "agenticIndex"]);

export function parseSpec(input: Record<string, unknown>): Omit<AgentSpec, "agentId"> & { agentId?: string | undefined } {
	const spec: Omit<AgentSpec, "agentId"> & { agentId?: string | undefined } = {
		task: String(input["task"] ?? ""),
		maxTurns: Number(input["maxTurns"] ?? 12),
		maxWallTimeMs: Number(input["maxWallTimeMs"] ?? 600_000),
		maxProviderAttemptsPerTurn: Number(input["maxProviderAttemptsPerTurn"] ?? 3),
		capabilities: Array.isArray(input["capabilities"])
			? (input["capabilities"].filter((c): c is AgentSpec["capabilities"][number] => typeof c === "string") as AgentSpec["capabilities"])
			: ["text", "tools"],
		qualityFloor: typeof input["qualityFloor"] === "number" ? input["qualityFloor"] : null,
		allowUnknownQuality: input["allowUnknownQuality"] === undefined ? true : Boolean(input["allowUnknownQuality"]),
	};
	if (typeof input["system"] === "string") spec.system = input["system"];
	if (typeof input["agentId"] === "string") spec.agentId = input["agentId"];
	if (typeof input["parentAgentId"] === "string") spec.parentAgentId = input["parentAgentId"];
	if (typeof input["tierHint"] === "string" && TIER_HINTS.has(input["tierHint"])) spec.tierHint = input["tierHint"] as TierHint;
	if (typeof input["qualityMetric"] === "string" && QUALITY_METRICS.has(input["qualityMetric"])) spec.qualityMetric = input["qualityMetric"] as QualityMetric;
	return spec;
}

function parsePlanOverrides(input: Record<string, unknown>): Omit<PlanSubtask, "task" | "idempotencyKey"> {
	const spec = parseSpec({ ...input, task: "plan" });
	const { task: _task, agentId: _agentId, parentAgentId: _parent, ...overrides } = spec as Record<string, unknown>;
	return overrides as Omit<PlanSubtask, "task" | "idempotencyKey">;
}

export function parsePlanRequest(input: Record<string, unknown>): PlanRequest {
	const subtasks = input["subtasks"];
	if (!Array.isArray(subtasks) || subtasks.length < 1 || subtasks.length > MAX_PLAN_CHILDREN) {
		throw new Error(`plan needs 1..${MAX_PLAN_CHILDREN} subtasks`);
	}
	return {
		...(typeof input["goal"] === "string" ? { goal: input["goal"] } : {}),
		subtasks: subtasks.map((entry) => {
			if (typeof entry !== "object" || entry === null) throw new Error("plan subtask must be an object");
			const record = entry as Record<string, unknown>;
			if (typeof record["task"] !== "string" || record["task"].length === 0) throw new Error("plan subtask needs a non-empty task");
			return {
				...parsePlanOverrides(record),
				task: record["task"],
				...(typeof record["idempotencyKey"] === "string" ? { idempotencyKey: record["idempotencyKey"] } : {}),
			};
		}),
		...(typeof input["defaults"] === "object" && input["defaults"] !== null
			? { defaults: parsePlanOverrides(input["defaults"] as Record<string, unknown>) }
			: {}),
		...(typeof input["idempotencyKey"] === "string" ? { idempotencyKey: input["idempotencyKey"] } : {}),
	};
}

async function main(): Promise<number> {
	// Credentials from PI_SWARM_ENV_FILE, loaded before any provider is seeded.
	const envReport = loadConfiguredEnvFile();
	if (envReport.path !== undefined) {
		_logger.info("env_file_loaded", {
			path: envReport.path,
			loaded: envReport.loaded.length,
			skipped: envReport.skipped.length,
			problems: envReport.problems.length,
		});
	}
	const store = new AgentStore(DB_PATH);
	// Cross-process capacity gate: several worker processes sharing one
	// database cannot overspend an account's concurrency.
	const leases = new SqliteLeaseStore(store.database);
	// Sandbox root for workspace tools (read/write/list/run_command).
	const workspace = new Workspace({ root: process.env.PI_SWARM_WORKSPACE ?? join(process.cwd(), ".pi-swarm-workspace") });
	await workspace.ensure();
	const service = new SwarmService({ store, workspace, leases });

	// Recover agents from a previous run: interrupted agents are failed with
	// their durable transcript preserved; uncertain tool calls are reported
	// and never auto-re-run.
	const report = recoverInterrupted(store);
	_logger.info("recovery_complete", {
		interrupted: report.interruptedAgents.length,
		uncertainToolCalls: report.uncertainToolCalls.length,
	});
	for (const uncertain of report.uncertainToolCalls) {
		_logger.warn("uncertain_tool_call", { agent: uncertain.agentId, tool: uncertain.tool });
	}

	const candidates = await service.refreshCatalogs();
	_logger.info("swarm_ready", { candidates, port: PORT });
	service.startAutoRefresh();

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
		try {
			if (req.method === "POST" && url.pathname === "/v1/agents") {
				const body = JSON.parse(await readBody(req)) as { spec: Record<string, unknown>; idempotencyKey?: string };
				const result = service.spawnAgent({ spec: parseSpec(body.spec ?? {}), idempotencyKey: body.idempotencyKey });
				sendJson(res, result.duplicate ? 200 : 201, result);
				return;
			}
			if (req.method === "POST" && url.pathname === "/v1/plans") {
				const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
				try {
					const result = service.spawnPlan(parsePlanRequest(body));
					sendJson(res, result.duplicate ? 200 : 201, result);
				} catch (error) {
					sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
				}
				return;
			}
			const planMatch = /^\/v1\/plans\/([^/]+)$/.exec(url.pathname);
			if (req.method === "GET" && planMatch?.[1]) {
				const planId = decodeURIComponent(planMatch[1]);
				const timeoutRaw = url.searchParams.get("timeoutMs");
				const timeoutMs = timeoutRaw !== null ? Number.parseInt(timeoutRaw, 10) : undefined;
				sendJson(res, 200, await service.gatherPlan(planId, timeoutMs !== undefined && Number.isFinite(timeoutMs) ? timeoutMs : undefined));
				return;
			}
			const eventsMatch = /^\/v1\/agents\/([^/]+)\/events$/.exec(url.pathname);
			if (req.method === "GET" && eventsMatch?.[1]) {
				const agentId = decodeURIComponent(eventsMatch[1]);
				// Replay history (so a late consumer sees the whole run), then
				// stream live. `?since=<seq>` resumes after a reconnect.
				const since = Number.parseInt(url.searchParams.get("since") ?? "0", 10) || 0;
				res.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
					"X-Accel-Buffering": "no",
				});
				const write = (event: { seq: number; type: string; at: number; data?: Record<string, unknown> }): void => {
					res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
				};
				for (const event of service.eventBus.eventsSince(agentId, since)) write(event);

				// A terminal agent needs no subscription: history is complete.
				const terminal = ["completed", "failed", "cancelled"].includes(service.getAgent(agentId)?.state ?? "");
				if (terminal) {
					res.end();
					return;
				}
				const subscription = service.eventBus.subscribe(agentId, (event) => {
					write(event);
					if (event.type === "agent.completed" || event.type === "agent.failed" || event.type === "agent.cancelled") {
						subscription.unsubscribe();
						res.end();
					}
				});
				// Heartbeat keeps intermediaries from closing an idle stream.
				const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
				req.on("close", () => {
					clearInterval(heartbeat);
					subscription.unsubscribe();
				});
				return;
			}
			const agentMatch = /^\/v1\/agents\/([^/]+)$/.exec(url.pathname);
			if (agentMatch?.[1]) {
				const agentId = decodeURIComponent(agentMatch[1]);
				if (req.method === "GET") {
					const agent = service.getAgent(agentId);
					if (!agent) {
						sendJson(res, 404, { error: "not_found" });
						return;
					}
					sendJson(res, 200, agent);
					return;
				}
				if (req.method === "DELETE") {
					const cancelled = service.cancelAgent(agentId);
					sendJson(res, cancelled ? 200 : 404, { cancelled });
					return;
				}
			}
			if (req.method === "GET" && url.pathname === "/v1/capacity") {
				sendJson(res, 200, { accounts: service.capacity() });
				return;
			}
			if (req.method === "POST" && url.pathname === "/v1/capacity/reset") {
				const body = JSON.parse(await readBody(req).catch(() => "{}")) as { accountId?: unknown };
				const accountId = typeof body.accountId === "string" ? body.accountId : undefined;
				sendJson(res, 200, service.resetCapacity(accountId));
				return;
			}
			if (req.method === "GET" && url.pathname === "/v1/models") {
				// The routing view: what decides which backend serves a turn.
				const limitRaw = url.searchParams.get("limit");
				const accountId = url.searchParams.get("accountId");
				let rows = service.routingView(limitRaw !== null ? { limit: Number.parseInt(limitRaw, 10) } : {});
				if (accountId !== null) rows = rows.filter((row) => row.accountId === accountId);
				sendJson(res, 200, { models: rows });
				return;
			}
			sendJson(res, 404, { error: "not_found" });
		} catch (error) {
			_logger.error("request_failed", {
				path: url.pathname,
				error: error instanceof Error ? error.message : String(error),
			});
			sendJson(res, 500, { error: "internal" });
		}
	});

	server.listen(PORT, () => {
		_logger.info("listening", { port: PORT });
	});
	return 0;
}

// Only listen when executed as a program (imported in tests otherwise).
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
	process.exitCode = await main();
}
