/**
 * Tool executor: named tool implementations + the safe execution wrapper.
 *
 * Contract (plan §10):
 *  - Every execution goes through the journal: begin → run → complete/fail.
 *  - A completed prior result replays (no second side effect).
 *  - An "uncertain" prior entry (crash between begin and finish) NEVER
 *    re-runs by default — the call returns an explicit error the agent can
 *    surface, honoring "no duplicated side effects" over convenience.
 *  - Timeouts are enforced per call via AbortController.
 *  - Tool errors are returned as message content for the model to react to —
 *    a failed tool is agent-visible data, not a provider failure (never a
 *    strike, never a reroute).
 */

import { createLogger } from "./logger.ts";
import { InMemoryToolJournal, toolExecutionId, type ToolJournal } from "./tool-journal.ts";
import { WorkspaceError, type Workspace } from "./workspace.ts";
import type { ToolSpec } from "./stream.ts";

const _logger = createLogger("tools");

export interface ToolContext {
	agentId: string;
	turnIndex: number;
	signal: AbortSignal;
}

export interface ToolImplementation {
	description: string;
	parameters: Record<string, unknown>;
	/** Pure-ish execution; MUST be idempotent or journaled by the wrapper. */
	execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export class ToolExecutor {
	private readonly tools = new Map<string, ToolImplementation>();
	private readonly journal: ToolJournal;
	private readonly timeoutMs: number;

	constructor(options: { journal?: ToolJournal | undefined; timeoutMs?: number } = {}) {
		this.journal = options.journal ?? new InMemoryToolJournal();
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
	}

	register(name: string, implementation: ToolImplementation): void {
		this.tools.set(name, implementation);
	}

	has(name: string): boolean {
		return this.tools.has(name);
	}

	/** Wire-format tool specs for the chat-completions request. */
	specs(): ToolSpec[] {
		return [...this.tools.entries()].map(([name, impl]) => ({
			type: "function" as const,
			function: { name, description: impl.description, parameters: impl.parameters },
		}));
	}

	/**
	 * Execute one tool call with journaling + idempotent replay.
	 * Returns the message content for the tool result role.
	 */
	async execute(agentId: string, turnIndex: number, callId: string, tool: string, argsJson: string, signal: AbortSignal): Promise<string> {
		const implementation = this.tools.get(tool);
		const id = toolExecutionId(agentId, turnIndex, callId);

		// Idempotent replay: a completed prior execution returns its result.
		const prior = this.journal.lookup(id);
		if (prior?.status === "completed" && prior.resultJson !== undefined) {
			_logger.debug("tool_replayed", { agentId, tool });
			return prior.resultJson;
		}
		if (prior?.status === "uncertain") {
			// Crash window: the side effect MAY have run. Never re-run silently.
			return JSON.stringify({ error: "uncertain_state", detail: "previous attempt did not report completion; refusing to re-run a possibly-executed side effect" });
		}

		if (!implementation) {
			return JSON.stringify({ error: "unknown_tool", tool });
		}

		let args: Record<string, unknown>;
		try {
			args = argsJson.length === 0 ? {} : (JSON.parse(argsJson) as Record<string, unknown>);
		} catch {
			return JSON.stringify({ error: "invalid_arguments", detail: "arguments are not valid JSON" });
		}

		// Claim the id atomically. A lookup followed by an unconditional begin
		// lets two workers execute the same side effect at once.
		if (!this.journal.begin(id, tool, argsJson, Date.now())) {
			const current = this.journal.lookup(id);
			if (current?.status === "completed" && current.resultJson !== undefined) return current.resultJson;
			return JSON.stringify({ error: "uncertain_state", detail: "another worker owns this execution or its outcome is unknown; refusing to duplicate a side effect" });
		}
		// Timeout wrapper: per-call controller linked to the agent signal.
		const controller = new AbortController();
		const abortFromUpstream = () => controller.abort(signal.reason);
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", abortFromUpstream, { once: true });
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);

		try {
			const result = await implementation.execute(args, { agentId, turnIndex, signal: controller.signal });
			this.journal.complete(id, result, Date.now());
			return result;
		} catch (error) {
			if (signal.aborted) {
				// Agent cancelled: side-effect state is unknown; do not re-run.
				_logger.info("tool_cancelled", { agentId, tool });
				return JSON.stringify({ error: "cancelled" });
			}
			// Timeout (only the per-call controller aborted) is a TOOL failure
			// the model must see — not a silent cancel.
			const timedOut = controller.signal.aborted;
			this.journal.fail(id, timedOut ? "timeout" : "execution_error", Date.now());
			const message = timedOut
				? `tool exceeded ${this.timeoutMs}ms`
				: error instanceof Error
					? error.message
					: String(error);
			return JSON.stringify({ error: "tool_failed", detail: message.slice(0, 500) });
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", abortFromUpstream);
		}
	}
}

// =============================================================================
// Built-in tools (v1): safe, deterministic, dependency-free
// =============================================================================

/** Deterministic calculator via a restricted expression evaluator. */
export function evalArithmetic(expression: string): number {
	// Shunting-yard-lite: only digits, operators, parens, decimals allowed.
	if (!/^[0-9+\-*/(). %e]+$/.test(expression)) {
		throw new Error("expression contains disallowed characters");
	}
	// eslint-disable-next-line no-new-func -- restricted charset checked above
	const value = Function(`"use strict"; return (${expression});`)() as unknown;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error("expression did not evaluate to a finite number");
	}
	return value;
}

/** Register the v1 built-in set on an executor. */
export function registerBuiltinTools(executor: ToolExecutor): void {
	executor.register("calculator", {
		description: "Evaluate an arithmetic expression. Input: {\"expression\": \"2+2\"}.",
		parameters: {
			type: "object",
			properties: { expression: { type: "string", description: "Arithmetic expression using digits and + - * / ( )." } },
			required: ["expression"],
		},
		execute: async (args) => {
			const expression = String(args["expression"] ?? "");
			const value = evalArithmetic(expression);
			return JSON.stringify({ expression, value });
		},
	});

	executor.register("echo", {
		description: "Echo text back. Useful for tests and structured replies.",
		parameters: {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		},
		execute: async (args) => JSON.stringify({ echoed: String(args["text"] ?? "") }),
	});

	executor.register("fetch_text", {
		description: "Fetch a URL and return the first N characters of the body as plain text.",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "http(s) URL to fetch." },
				max_chars: { type: "number", description: "Truncate body to this many characters (default 2000)." },
			},
			required: ["url"],
		},
		execute: async (args, ctx) => {
			const url = String(args["url"] ?? "");
			const parsed = new URL(url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
				return JSON.stringify({ error: "invalid_url", detail: "only http/https allowed" });
			}
			const maxChars = Math.min(Number(args["max_chars"] ?? 2000) || 2000, 20_000);
			const response = await fetch(url, { signal: ctx.signal, headers: { Accept: "text/*,application/json;q=0.9" } });
			const body = await response.text();
			return JSON.stringify({ status: response.status, truncated: body.length > maxChars, text: body.slice(0, maxChars) });
		},
	});
}

/**
 * Register the workspace-scoped tool set: filesystem access and command
 * execution confined to one sandbox root. Errors come back as JSON content
 * (the model reacts to them) — never as thrown failures.
 */
export function registerWorkspaceTools(executor: ToolExecutor, workspace: Workspace): void {
	/** Uniform error-to-content mapping for every workspace tool. */
	const guard = async (fn: () => Promise<unknown>): Promise<string> => {
		try {
			return JSON.stringify(await fn());
		} catch (error) {
			if (error instanceof WorkspaceError) {
				return JSON.stringify({ error: error.code, detail: error.message });
			}
			return JSON.stringify({ error: "workspace_error", detail: error instanceof Error ? error.message : String(error) });
		}
	};

	executor.register("read_file", {
		description: "Read a UTF-8 text file from the workspace. Paths are relative to the workspace root.",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Workspace-relative file path." } },
			required: ["path"],
		},
		execute: async (args, ctx) =>
			guard(async () => {
				const path = String(args["path"] ?? "");
				const content = await workspace.readFile(path, ctx.signal);
				return { path, content };
			}),
	});

	executor.register("write_file", {
		description: "Write a UTF-8 text file in the workspace, creating parent directories.",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "Workspace-relative file path." },
				content: { type: "string", description: "File contents." },
			},
			required: ["path", "content"],
		},
		execute: async (args, ctx) =>
			guard(async () => {
				const path = String(args["path"] ?? "");
				const bytes = await workspace.writeFile(path, String(args["content"] ?? ""), ctx.signal);
				return { path, bytesWritten: bytes };
			}),
	});

	executor.register("list_dir", {
		description: "List a directory in the workspace (defaults to the root).",
		parameters: {
			type: "object",
			properties: { path: { type: "string", description: "Workspace-relative directory path." } },
		},
		execute: async (args) =>
			guard(async () => {
				const path = String(args["path"] ?? ".");
				const entries = await workspace.listDir(path);
				return { path, entries };
			}),
	});

	executor.register("run_command", {
		description: "Run an allowlisted shell command inside the workspace with a timeout and capped output.",
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Executable name (allowlisted)." },
				args: { type: "array", items: { type: "string" }, description: "Arguments." },
			},
			required: ["command"],
		},
		execute: async (args, ctx) =>
			guard(async () => {
				const command = String(args["command"] ?? "");
				const commandArgs = Array.isArray(args["args"]) ? (args["args"] as unknown[]).map(String) : [];
				const result = await workspace.runCommand(command, commandArgs, ctx.signal);
				return result;
			}),
	});
}
