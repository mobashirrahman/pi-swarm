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

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
		try {
			if (req.method === "POST" && url.pathname === "/v1/agents") {
				const body = JSON.parse(await readBody(req)) as { spec: Record<string, unknown>; idempotencyKey?: string };
				const result = service.spawnAgent({ spec: body.spec as never, idempotencyKey: body.idempotencyKey });
				sendJson(res, result.duplicate ? 200 : 201, result);
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
