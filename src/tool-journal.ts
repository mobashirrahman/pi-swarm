/**
 * Tool-call journal: idempotency for side effects (the plan's acceptance
 * criterion #8 — restart must not duplicate tool side effects).
 *
 * Contract:
 *  - Every execution gets a STABLE id: `${agentId}:${turnIndex}:${callId}`.
 *  - `begin` records intent BEFORE the side effect runs; `complete`/`fail`
 *    record the outcome. A crash between the two is detected on recovery as
 *    an "uncertain" entry — callers decide (default: do NOT re-run).
 *  - `lookup` returns a prior COMPLETED result for an idempotent replay:
 *    re-running a committed tool call returns the recorded result instead of
 *    executing again.
 *
 * The journal is in-memory with an injectable sink (SQLite arrives via the
 * store layer); the stable-id contract is what makes persistence safe.
 */

export type ToolStatus = "running" | "completed" | "failed" | "uncertain";

export interface ToolJournalEntry {
	id: string;
	tool: string;
	/** Arguments as given — NEVER logged (may contain user data). */
	argsJson: string;
	status: ToolStatus;
	/** Completed result (JSON) — replayed on duplicate invocation. */
	resultJson?: string | undefined;
	/** Failure class label; not the raw error body. */
	errorClass?: string | undefined;
	startedAt: number;
	finishedAt?: number | undefined;
}

export interface ToolJournal {
	begin(id: string, tool: string, argsJson: string, now: number): void;
	/** Mark finished; resultJson required for "completed". */
	complete(id: string, resultJson: string, now: number): void;
	fail(id: string, errorClass: string, now: number): void;
	/**
	 * Prior entry for this id. "completed" entries authorize replay;
	 * "running" entries (crash between begin and complete) surface as
	 * "uncertain" to the caller.
	 */
	lookup(id: string): { status: ToolStatus; resultJson?: string | undefined } | undefined;
	/** Entries for one agent, for the events/status API. */
	forAgent(agentId: string): ReadonlyArray<ToolJournalEntry>;
}

export class InMemoryToolJournal implements ToolJournal {
	private readonly entries = new Map<string, ToolJournalEntry>();

	begin(id: string, tool: string, argsJson: string, now: number): void {
		const existing = this.entries.get(id);
		if (existing && existing.status === "completed") return; // keep the replay source
		this.entries.set(id, { id, tool, argsJson, status: "running", startedAt: now });
	}

	complete(id: string, resultJson: string, now: number): void {
		const entry = this.entries.get(id);
		if (!entry) return; // complete without begin is a caller bug; ignore
		entry.status = "completed";
		entry.resultJson = resultJson;
		entry.finishedAt = now;
	}

	fail(id: string, errorClass: string, now: number): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.status = "failed";
		entry.errorClass = errorClass;
		entry.finishedAt = now;
	}

	lookup(id: string): { status: ToolStatus; resultJson?: string | undefined } | undefined {
		const entry = this.entries.get(id);
		if (!entry) return undefined;
		// A "running" entry that is re-queried after a crash window is
		// uncertain: the side effect MAY have happened.
		const status: ToolStatus = entry.status === "running" ? "uncertain" : entry.status;
		return { status, resultJson: entry.resultJson };
	}

	forAgent(agentId: string): ReadonlyArray<ToolJournalEntry> {
		const result: ToolJournalEntry[] = [];
		for (const entry of this.entries.values()) {
			if (entry.id.startsWith(`${agentId}:`)) result.push(entry);
		}
		return result;
	}
}

/** Stable execution id — the dedupe key across restarts. */
export function toolExecutionId(agentId: string, turnIndex: number, callId: string): string {
	return `${agentId}:${turnIndex}:${callId}`;
}

/**
 * Minimal persistence surface the SQLite journal needs (implemented by
 * AgentStore); kept as an interface so tests can use in-memory doubles.
 */
export interface ToolJournalStore {
	toolBegin(id: string, tool: string, argsJson: string, now: number): void;
	toolComplete(id: string, resultJson: string, now: number): void;
	toolFail(id: string, errorClass: string, now: number): void;
	toolLookup(id: string): { status: "running" | "completed" | "failed"; resultJson?: string | undefined } | undefined;
}

/** Journal backed by the AgentStore — survives restarts. */
export class PersistentToolJournal implements ToolJournal {
	constructor(private readonly store: ToolJournalStore) {}

	begin(id: string, tool: string, argsJson: string, now: number): void {
		const prior = this.store.toolLookup(id);
		if (prior?.status === "completed") return; // keep the replay source
		this.store.toolBegin(id, tool, argsJson, now);
	}

	complete(id: string, resultJson: string, now: number): void {
		this.store.toolComplete(id, resultJson, now);
	}

	fail(id: string, errorClass: string, now: number): void {
		this.store.toolFail(id, errorClass, now);
	}

	lookup(id: string): { status: ToolStatus; resultJson?: string | undefined } | undefined {
		const row = this.store.toolLookup(id);
		if (!row) return undefined;
		const status: ToolStatus = row.status === "running" ? "uncertain" : row.status;
		return { status, resultJson: row.resultJson };
	}

	forAgent(agentId: string): ReadonlyArray<ToolJournalEntry> {
		// SQLite listing arrives with the events API; live queries use lookup.
		void agentId;
		return [];
	}
}
