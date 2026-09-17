/**
 * Agent store: SQLite-backed durable state (agents + turns + attempts).
 * Phase-1 scope: node:sqlite (built-in, no native deps) with WAL mode.
 * Supports warm restart: running agents are recovered as interrupted.
 *
 * Secrets NEVER touch this store — only credentialRef names.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentSpec, AgentState } from "./agent.ts";

export interface AgentRow {
	agentId: string;
	spec: AgentSpec;
	state: AgentState;
	createdAt: number;
	updatedAt: number;
	finalContent?: string | undefined;
	failReason?: string | undefined;
}

export interface AttemptRow {
	attemptId: string;
	agentId: string;
	turnIndex: number;
	accountId: string;
	modelId: string;
	sentAt: number;
	status: "sent" | "committed" | "failed";
	latencyMs?: number | undefined;
	errorClass?: string | undefined;
}

export class AgentStore {
	private readonly db: DatabaseSync;

	constructor(path: string) {
		// The DB path may point into a directory that does not exist yet
		// (e.g. a fresh ~/.pi-swarm). SQLite will not create parents.
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.db = new DatabaseSync(path);
		// busy_timeout FIRST: several worker processes share this file, and
		// switching to WAL itself takes a lock — without a timeout the second
		// process to start fails immediately (observed in the multi-process
		// lease test).
		this.db.exec("PRAGMA busy_timeout = 5000;");
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA synchronous = NORMAL;");
		this.migrate();
	}

	/** Raw handle for cooperating stores (leases) on the same database. */
	get database(): DatabaseSync {
		return this.db;
	}

	private migrate(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS agents (
				agent_id TEXT PRIMARY KEY,
				spec TEXT NOT NULL,
				state TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				final_content TEXT,
				fail_reason TEXT
			);
			CREATE TABLE IF NOT EXISTS attempts (
				attempt_id TEXT PRIMARY KEY,
				agent_id TEXT NOT NULL,
				turn_index INTEGER NOT NULL,
				account_id TEXT NOT NULL,
				model_id TEXT NOT NULL,
				sent_at INTEGER NOT NULL,
				status TEXT NOT NULL,
				latency_ms INTEGER,
				error_class TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_attempts_agent ON attempts(agent_id, turn_index);
			CREATE TABLE IF NOT EXISTS idempotency (
				key TEXT PRIMARY KEY,
				agent_id TEXT NOT NULL,
				created_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS transcript (
				agent_id TEXT NOT NULL,
				seq INTEGER NOT NULL,
				role TEXT NOT NULL,
				content TEXT,
				tool_call_id TEXT,
				tool_calls_json TEXT,
				PRIMARY KEY (agent_id, seq)
			);
			CREATE TABLE IF NOT EXISTS tool_journal (
				id TEXT PRIMARY KEY,
				tool TEXT NOT NULL,
				args_json TEXT NOT NULL,
				status TEXT NOT NULL,
				result_json TEXT,
				error_class TEXT,
				started_at INTEGER NOT NULL,
				finished_at INTEGER
			);
		`);
		// Older databases were created before tool failures stored their class.
		// Upgrade them in place so a persistent tool failure cannot crash the
		// journal writer on the first UPDATE.
		const toolColumns = this.db.prepare("PRAGMA table_info(tool_journal)").all() as Array<{ name: string }>;
		if (!toolColumns.some((column) => column.name === "error_class")) {
			this.db.exec("ALTER TABLE tool_journal ADD COLUMN error_class TEXT");
		}
	}

	// =========================================================================
	// Agents
	// =========================================================================

	upsertAgent(row: AgentRow): void {
		const existing = this.db.prepare("SELECT agent_id FROM agents WHERE agent_id = ?").get(row.agentId);
		if (existing) {
			this.db
				.prepare("UPDATE agents SET state = ?, updated_at = ?, final_content = ?, fail_reason = ? WHERE agent_id = ?")
				.run(row.state, row.updatedAt, row.finalContent ?? null, row.failReason ?? null, row.agentId);
		} else {
			this.db
				.prepare("INSERT INTO agents (agent_id, spec, state, created_at, updated_at, final_content, fail_reason) VALUES (?, ?, ?, ?, ?, ?, ?)")
				.run(row.agentId, JSON.stringify(row.spec), row.state, row.createdAt, row.updatedAt, row.finalContent ?? null, row.failReason ?? null);
		}
	}

	getAgent(agentId: string): AgentRow | undefined {
		const row = this.db.prepare("SELECT * FROM agents WHERE agent_id = ?").get(agentId) as
			| { agent_id: string; spec: string; state: string; created_at: number; updated_at: number; final_content: string | null; fail_reason: string | null }
			| undefined;
		if (!row) return undefined;
		return {
			agentId: row.agent_id,
			spec: JSON.parse(row.spec) as AgentSpec,
			state: row.state as AgentState,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			finalContent: row.final_content ?? undefined,
			failReason: row.fail_reason ?? undefined,
		};
	}

	listAgents(): AgentRow[] {
		const rows = this.db.prepare("SELECT * FROM agents ORDER BY created_at DESC").all() as Array<{
			agent_id: string; spec: string; state: string; created_at: number; updated_at: number; final_content: string | null; fail_reason: string | null;
		}>;
		return rows.map((row) => ({
			agentId: row.agent_id,
			spec: JSON.parse(row.spec) as AgentSpec,
			state: row.state as AgentState,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			finalContent: row.final_content ?? undefined,
			failReason: row.fail_reason ?? undefined,
		}));
	}

	/** Agents found `running` after a restart — recover as interrupted/failed. */
	recoverableAgents(): AgentRow[] {
		return this.listAgents().filter((a) => a.state === "running" || a.state === "queued" || a.state === "waiting_capacity");
	}

	// =========================================================================
	// Attempts
	// =========================================================================

	recordAttempt(attempt: AttemptRow): void {
		this.db
			.prepare("INSERT OR REPLACE INTO attempts (attempt_id, agent_id, turn_index, account_id, model_id, sent_at, status, latency_ms, error_class) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
			.run(attempt.attemptId, attempt.agentId, attempt.turnIndex, attempt.accountId, attempt.modelId, attempt.sentAt, attempt.status, attempt.latencyMs ?? null, attempt.errorClass ?? null);
	}

	attemptsFor(agentId: string): AttemptRow[] {
		const rows = this.db.prepare("SELECT * FROM attempts WHERE agent_id = ? ORDER BY sent_at").all(agentId) as Array<{
			attempt_id: string; agent_id: string; turn_index: number; account_id: string; model_id: string; sent_at: number; status: string; latency_ms: number | null; error_class: string | null;
		}>;
		return rows.map((row) => ({
			attemptId: row.attempt_id,
			agentId: row.agent_id,
			turnIndex: row.turn_index,
			accountId: row.account_id,
			modelId: row.model_id,
			sentAt: row.sent_at,
			status: row.status as AttemptRow["status"],
			latencyMs: row.latency_ms ?? undefined,
			errorClass: row.error_class ?? undefined,
		}));
	}

	// =========================================================================
	// Idempotency
	// =========================================================================

	/** Returns the existing agentId when this key was already used. */
	checkIdempotency(key: string): string | undefined {
		const row = this.db.prepare("SELECT agent_id FROM idempotency WHERE key = ?").get(key) as { agent_id: string } | undefined;
		return row?.agent_id;
	}

	recordIdempotency(key: string, agentId: string, now: number): void {
		this.db.prepare("INSERT OR IGNORE INTO idempotency (key, agent_id, created_at) VALUES (?, ?, ?)").run(key, agentId, now);
	}

	// =========================================================================
	// Transcript durability (crash recovery)
	// =========================================================================

	/** Append one committed message to the durable transcript. */
	appendTranscriptMessage(agentId: string, seq: number, message: { role: string; content: string | null; tool_call_id?: string | undefined; tool_calls?: unknown }): void {
		this.db
			.prepare("INSERT OR REPLACE INTO transcript (agent_id, seq, role, content, tool_call_id, tool_calls_json) VALUES (?, ?, ?, ?, ?, ?)")
			.run(agentId, seq, message.role, message.content, message.tool_call_id ?? null, message.tool_calls ? JSON.stringify(message.tool_calls) : null);
	}

	/** Load the durable transcript in order. */
	loadTranscript(agentId: string): Array<{ role: string; content: string | null; tool_call_id?: string | undefined; tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> | undefined }> {
		const rows = this.db.prepare("SELECT seq, role, content, tool_call_id, tool_calls_json FROM transcript WHERE agent_id = ? ORDER BY seq").all(agentId) as Array<{
			seq: number; role: string; content: string | null; tool_call_id: string | null; tool_calls_json: string | null;
		}>;
		return rows.map((row) => ({
			role: row.role,
			content: row.content,
			tool_call_id: row.tool_call_id ?? undefined,
			tool_calls: row.tool_calls_json ? (JSON.parse(row.tool_calls_json) as Array<{ id: string; type: string; function: { name: string; arguments: string } }>) : undefined,
		}));
	}

	// =========================================================================
	// Tool journal persistence (side-effect safety across restarts)
	// =========================================================================

	/** Atomically claim a tool execution id. */
	toolBegin(id: string, tool: string, argsJson: string, now: number): boolean {
		const inserted = this.db
			.prepare("INSERT INTO tool_journal (id, tool, args_json, status, started_at) VALUES (?, ?, ?, 'running', ?) ON CONFLICT(id) DO NOTHING")
			.run(id, tool, argsJson, now);
		if (Number(inserted.changes ?? 0) === 1) return true;

		// A failed tool is safe to retry, but the transition must still be
		// conditional so concurrent retries cannot both acquire the side effect.
		const retried = this.db
			.prepare("UPDATE tool_journal SET tool = ?, args_json = ?, status = 'running', result_json = NULL, error_class = NULL, started_at = ?, finished_at = NULL WHERE id = ? AND status = 'failed'")
			.run(tool, argsJson, now, id);
		return Number(retried.changes ?? 0) === 1;
	}

	toolComplete(id: string, resultJson: string, now: number): void {
		this.db
			.prepare("UPDATE tool_journal SET status = 'completed', result_json = ?, finished_at = ? WHERE id = ?")
			.run(resultJson, now, id);
	}

	toolFail(id: string, errorClass: string, now: number): void {
		this.db
			.prepare("UPDATE tool_journal SET status = 'failed', error_class = ?, finished_at = ? WHERE id = ?")
			.run(errorClass, now, id);
	}

	toolLookup(id: string): { status: "running" | "completed" | "failed"; resultJson?: string | undefined } | undefined {
		const row = this.db.prepare("SELECT status, result_json FROM tool_journal WHERE id = ?").get(id) as
			| { status: "running" | "completed" | "failed"; result_json: string | null }
			| undefined;
		if (!row) return undefined;
		return { status: row.status, resultJson: row.result_json ?? undefined };
	}

	/**
	 * Tool calls left in "running" — the process died between the side-effect
	 * attempt and its outcome. Never auto-re-run (side effect may have fired).
	 * The execution id is `${agentId}:${turnIndex}:${callId}`.
	 */
	uncertainToolCalls(): Array<{ agentId: string; executionId: string; tool: string }> {
		const rows = this.db.prepare("SELECT id, tool FROM tool_journal WHERE status = 'running'").all() as Array<{ id: string; tool: string }>;
		return rows.map((row) => ({
			agentId: row.id.split(":")[0] ?? "unknown",
			executionId: row.id,
			tool: row.tool,
		}));
	}

	close(): void {
		this.db.close();
	}
}
