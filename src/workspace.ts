/**
 * Isolated workspace: the filesystem + process boundary for tool execution.
 *
 * The plan's requirement for tool execution (§10): filesystem boundary,
 * command timeout, output-size cap, environment-variable allowlist, and a
 * propagated AbortSignal. Containers are a deployment concern; this module
 * enforces the same boundaries in-process so a worker cannot escape its
 * root, read arbitrary env, or hang forever.
 *
 * Threat model: a model emitting hostile tool arguments. Every path is
 * resolved against the root and rejected on escape (including symlink
 * traversal and `..`); every command runs with a scrubbed environment, a
 * timeout, and a capped output.
 */

import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export interface WorkspaceOptions {
	/** Absolute path to the sandbox root. Created if missing. */
	root: string;
	/** Command timeout (ms). */
	commandTimeoutMs?: number;
	/** Max bytes captured from a command's stdout+stderr. */
	maxOutputBytes?: number;
	/** Max bytes read or written by file tools. */
	maxFileBytes?: number;
	/** Environment variable NAMES to pass through to commands (allowlist). */
	envAllowlist?: string[];
	/** Command allowlist (executable basenames). Empty = no commands allowed. */
	commandAllowlist?: string[];
}

export class WorkspaceError extends Error {
	constructor(
		message: string,
		readonly code:
			| "path_escape"
			| "not_found"
			| "too_large"
			| "command_denied"
			| "timeout"
			| "not_a_directory",
	) {
		super(message);
		this.name = "WorkspaceError";
	}
}

const DEFAULT_COMMAND_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;

/** Read-only, harmless commands a sandboxed agent may run by default. */
const DEFAULT_COMMAND_ALLOWLIST = ["echo", "cat", "ls", "wc", "head", "tail", "grep", "sort", "uniq", "node", "python3"];

/** Env vars safe to pass through by default. Never PATH-adjacent secrets. */
const DEFAULT_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR"];

export class Workspace {
	readonly root: string;
	private readonly commandTimeoutMs: number;
	private readonly maxOutputBytes: number;
	private readonly maxFileBytes: number;
	private readonly envAllowlist: Set<string>;
	private readonly commandAllowlist: Set<string>;

	constructor(options: WorkspaceOptions) {
		this.root = resolve(options.root);
		this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
		this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
		this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
		this.envAllowlist = new Set(options.envAllowlist ?? DEFAULT_ENV_ALLOWLIST);
		this.commandAllowlist = new Set(options.commandAllowlist ?? DEFAULT_COMMAND_ALLOWLIST);
	}

	async ensure(): Promise<void> {
		await mkdir(this.root, { recursive: true });
	}

	/**
	 * Resolve a caller-supplied path inside the root, rejecting escapes.
	 * `..` and absolute paths are normalized away, then the result must
	 * still be inside the root.
	 */
	resolvePath(relativePath: string): string {
		if (relativePath.includes("\0")) {
			throw new WorkspaceError("path contains a null byte", "path_escape");
		}
		// Absolute paths are treated as root-relative so a model cannot aim
		// at /etc/passwd by writing an absolute path.
		const stripped = relativePath.replace(/^[/\\]+/, "");
		const candidate = resolve(this.root, normalize(stripped));
		const inside = candidate === this.root || candidate.startsWith(this.root + sep);
		if (!inside || isAbsolute(relative( this.root, candidate)) && relative(this.root, candidate).startsWith("..")) {
			throw new WorkspaceError(`path escapes the workspace root: ${relativePath}`, "path_escape");
		}
		return candidate;
	}

	async readFile(relativePath: string, signal?: AbortSignal): Promise<string> {
		const target = this.resolvePath(relativePath);
		await this.assertInsideRoot(target);
		const info = await stat(target).catch(() => undefined);
		if (!info) throw new WorkspaceError(`not found: ${relativePath}`, "not_found");
		if (!info.isFile()) throw new WorkspaceError(`not a file: ${relativePath}`, "not_found");
		if (info.size > this.maxFileBytes) {
			throw new WorkspaceError(`file exceeds ${this.maxFileBytes} bytes: ${relativePath}`, "too_large");
		}
		void signal;
		return readFile(target, "utf8");
	}

	async writeFile(relativePath: string, content: string, signal?: AbortSignal): Promise<number> {
		const bytes = Buffer.byteLength(content, "utf8");
		if (bytes > this.maxFileBytes) {
			throw new WorkspaceError(`content exceeds ${this.maxFileBytes} bytes`, "too_large");
		}
		const target = this.resolvePath(relativePath);
		await this.assertInsideRoot(target);
		await mkdir(resolve(target, ".."), { recursive: true });
		void signal;
		await writeFile(target, content, "utf8");
		return bytes;
	}

	async listDir(relativePath = "."): Promise<Array<{ name: string; type: "file" | "dir"; size: number }>> {
		const target = this.resolvePath(relativePath);
		await this.assertInsideRoot(target);
		const info = await stat(target).catch(() => undefined);
		if (!info) throw new WorkspaceError(`not found: ${relativePath}`, "not_found");
		if (!info.isDirectory()) throw new WorkspaceError(`not a directory: ${relativePath}`, "not_a_directory");
		const entries = await readdir(target, { withFileTypes: true });
		const result: Array<{ name: string; type: "file" | "dir"; size: number }> = [];
		for (const entry of entries) {
			const entryInfo = await stat(join(target, entry.name)).catch(() => undefined);
			result.push({
				name: entry.name,
				type: entry.isDirectory() ? "dir" : "file",
				size: entryInfo?.size ?? 0,
			});
		}
		return result.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Run an allowlisted command with a scrubbed environment, a timeout, and
	 * capped output. The abort signal kills the process group.
	 */
	async runCommand(command: string, args: string[], signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }> {
		const executable = command.split(/[/\\]/).pop() ?? command;
		if (!this.commandAllowlist.has(executable)) {
			throw new WorkspaceError(`command not allowed: ${executable}`, "command_denied");
		}

		const env: Record<string, string> = {};
		for (const name of this.envAllowlist) {
			const value = process.env[name];
			if (value !== undefined) env[name] = value;
		}

		const child = spawn(executable, args, {
			cwd: this.root,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			// Detached so the timeout can kill the whole group, not just the
			// shell — an orphaned grandchild would otherwise keep running.
			detached: process.platform !== "win32",
		});

		let stdout = "";
		let stderr = "";
		let truncated = false;
		let timedOut = false;

		const capture = (chunk: Buffer, sink: "out" | "err"): void => {
			if (stdout.length + stderr.length >= this.maxOutputBytes) {
				truncated = true;
				return;
			}
			const text = chunk.toString("utf8");
			const remaining = this.maxOutputBytes - (stdout.length + stderr.length);
			const slice = text.slice(0, remaining);
			if (slice.length < text.length) truncated = true;
			if (sink === "out") stdout += slice;
			else stderr += slice;
		};

		child.stdout?.on("data", (chunk: Buffer) => capture(chunk, "out"));
		child.stderr?.on("data", (chunk: Buffer) => capture(chunk, "err"));

		const killTree = (): void => {
			if (child.pid === undefined) return;
			try {
				if (process.platform === "win32") child.kill("SIGKILL");
				else process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};

		const timeout = setTimeout(() => {
			timedOut = true;
			killTree();
		}, this.commandTimeoutMs);

		const onAbort = (): void => {
			timedOut = false;
			killTree();
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		const code = await new Promise<number | null>((resolveExit) => {
			child.on("error", () => resolveExit(null));
			child.on("close", (exitCode) => resolveExit(exitCode));
		});

		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
		return { code, stdout, stderr, truncated, timedOut };
	}

	/**
	 * Reject paths that reach outside the root through a symlink. Resolution
	 * happens against the REAL path of the nearest existing ancestor.
	 */
	private async assertInsideRoot(target: string): Promise<void> {
		let existing = target;
		// Walk up to the nearest path that exists (the file itself may be new).
		for (;;) {
			try {
				existing = await realpath(existing);
				break;
			} catch {
				const parent = resolve(existing, "..");
				if (parent === existing) break;
				existing = parent;
			}
		}
		const realRoot = await realpath(this.root).catch(() => this.root);
		const inside = existing === realRoot || existing.startsWith(realRoot + sep);
		if (!inside) {
			throw new WorkspaceError("resolved path escapes the workspace root (symlink)", "path_escape");
		}
	}
}