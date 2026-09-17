/**
 * Agent store: SQLite-backed durable state (agents + turns + attempts).
 * Phase-1 scope: node:sqlite (built-in, no native deps) with WAL mode.
 * Supports warm restart: running agents are recovered as interrupted.
 *
 * Secrets NEVER touch this store — only credentialRef names.
 */

import { DatabaseSync } from "node:sqlite";
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
		this.db = new DatabaseSync(path);
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA synchronous = NORMAL;");
		this.migrate();
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
		`);
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

	close(): void {
		this.db.close();
	}
}
