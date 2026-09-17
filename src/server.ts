/**
 * HTTP server: thin wrapper over SwarmService (node:http, zero deps).
 * Endpoints:
 *   POST /v1/agents            spawn (idempotencyKey honored)
 *   GET  /v1/agents/:id        status + transcript
 *   DELETE /v1/agents/:id      cancel
 *   GET  /v1/capacity          per-account quota/circuit view
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AgentStore } from "./store.ts";
import { SwarmService } from "./swarm.ts";
import { recoverInterrupted } from "./recovery.ts";
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
	const store = new AgentStore(DB_PATH);
	const service = new SwarmService({ store });

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

process.exitCode = await main();
