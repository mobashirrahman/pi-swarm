import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, WorkspaceError } from "../src/workspace.ts";
import { ToolExecutor, registerWorkspaceTools } from "../src/tools.ts";

const NO_SIGNAL = new AbortController().signal;

describe("workspace boundaries", () => {
	let root: string;
	let outside: string;
	let workspace: Workspace;

	beforeEach(() => {
		const base = mkdtempSync(join(tmpdir(), "pi-swarm-ws-"));
		root = join(base, "root");
		outside = join(base, "outside");
		workspace = new Workspace({ root });
	});

	afterEach(() => {
		rmSync(join(root, ".."), { recursive: true, force: true });
	});

	it("rejects parent-directory escapes", () => {
		expect(() => workspace.resolvePath("../secrets.txt")).toThrow(WorkspaceError);
		expect(() => workspace.resolvePath("a/../../secrets.txt")).toThrow(WorkspaceError);
		expect(() => workspace.resolvePath("..")).toThrow(WorkspaceError);
	});

	it("treats absolute paths as root-relative instead of honouring them", () => {
		// A model aiming at /etc/passwd must land inside the sandbox.
		const resolved = workspace.resolvePath("/etc/passwd");
		expect(resolved.startsWith(workspace.root)).toBe(true);
		expect(resolved.endsWith(join("etc", "passwd"))).toBe(true);
	});

	it("rejects null bytes", () => {
		expect(() => workspace.resolvePath("a\0b")).toThrow(WorkspaceError);
	});

	it("rejects a symlink that points outside the root", async () => {
		await workspace.ensure();
		writeFileSync(outside, "secret", "utf8");
		symlinkSync(outside, join(root, "escape"));
		await expect(workspace.readFile("escape")).rejects.toThrow(/escapes the workspace root/);
	});

	it("reads and writes inside the root", async () => {
		await workspace.ensure();
		const bytes = await workspace.writeFile("nested/dir/file.txt", "hello");
		expect(bytes).toBe(5);
		await expect(workspace.readFile("nested/dir/file.txt")).resolves.toBe("hello");
		const entries = await workspace.listDir("nested/dir");
		expect(entries.map((entry) => entry.name)).toEqual(["file.txt"]);
	});

	it("enforces the file size cap", async () => {
		const small = new Workspace({ root, maxFileBytes: 8 });
		await small.ensure();
		await expect(small.writeFile("big.txt", "x".repeat(9))).rejects.toThrow(/exceeds 8 bytes/);
	});

	it("lists directories and reports types", async () => {
		await workspace.ensure();
		await workspace.writeFile("a.txt", "a");
		await workspace.writeFile("sub/b.txt", "b");
		const entries = await workspace.listDir(".");
		expect(entries.map((entry) => `${entry.name}:${entry.type}`)).toEqual(["a.txt:file", "sub:dir"]);
	});

	it("denies commands outside the allowlist", async () => {
		await workspace.ensure();
		await expect(workspace.runCommand("rm", ["-rf", "/"])).rejects.toThrow(/command not allowed/);
		await expect(workspace.runCommand("curl", ["http://example.com"])).rejects.toThrow(/command not allowed/);
	});

	it("runs an allowlisted command with a scrubbed environment", async () => {
		await workspace.ensure();
		process.env.PI_SWARM_TEST_SECRET = "should-not-leak";
		const result = await workspace.runCommand("echo", ["hello"]);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("hello");

		const envResult = await workspace.runCommand("node", ["-e", "process.stdout.write(process.env.PI_SWARM_TEST_SECRET ?? 'absent')"]);
		expect(envResult.stdout).toBe("absent"); // allowlist excluded it
		delete process.env.PI_SWARM_TEST_SECRET;
	});

	it("caps command output", async () => {
		const capped = new Workspace({ root, maxOutputBytes: 64 });
		await capped.ensure();
		const result = await capped.runCommand("node", ["-e", "process.stdout.write('x'.repeat(500))"]);
		expect(result.truncated).toBe(true);
		expect(result.stdout.length).toBeLessThanOrEqual(64);
	});

	it("kills a command that exceeds its timeout", async () => {
		const quick = new Workspace({ root, commandTimeoutMs: 150 });
		await quick.ensure();
		const result = await quick.runCommand("node", ["-e", "setTimeout(() => {}, 10_000)"]);
		expect(result.timedOut).toBe(true);
	});

	it("kills a command when the agent aborts", async () => {
		const controller = new AbortController();
		await workspace.ensure();
		const pending = workspace.runCommand("node", ["-e", "setTimeout(() => {}, 10_000)"], controller.signal);
		controller.abort();
		const result = await pending;
		expect(result.timedOut).toBe(false); // cancelled, not a timeout
	});
});

describe("workspace tools surface errors as content", () => {
	it("returns path_escape instead of throwing", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-swarm-wt-"));
		const workspace = new Workspace({ root });
		await workspace.ensure();
		const executor = new ToolExecutor();
		registerWorkspaceTools(executor, workspace);

		const result = await executor.execute("a1", 0, "c1", "read_file", JSON.stringify({ path: "../../etc/passwd" }), NO_SIGNAL);
		expect(JSON.parse(result).error).toBe("path_escape");

		const write = await executor.execute("a1", 0, "c2", "write_file", JSON.stringify({ path: "ok.txt", content: "hi" }), NO_SIGNAL);
		expect(JSON.parse(write)).toEqual({ path: "ok.txt", bytesWritten: 2 });

		const read = await executor.execute("a1", 0, "c3", "read_file", JSON.stringify({ path: "ok.txt" }), NO_SIGNAL);
		expect(JSON.parse(read).content).toBe("hi");

		const denied = await executor.execute("a1", 0, "c4", "run_command", JSON.stringify({ command: "rm" }), NO_SIGNAL);
		expect(JSON.parse(denied).error).toBe("command_denied");

		const listed = await executor.execute("a1", 0, "c5", "list_dir", JSON.stringify({}), NO_SIGNAL);
		expect(JSON.parse(listed).entries.map((entry: { name: string }) => entry.name)).toContain("ok.txt");

		rmSync(root, { recursive: true, force: true });
	});
});