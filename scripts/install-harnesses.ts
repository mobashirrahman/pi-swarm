/**
 * Install pi-swarm into the three harnesses on this laptop — OpenCode,
 * Claude Code, and Codex — including provider API keys.
 *
 * What it does, in order:
 *   1. `npm install` (the `prepare` hook rebuilds `dist/`, so the harnesses
 *      spawn a fresh bundle, never a stale one).
 *   2. Merges provider keys from this shell's environment into `secrets.env`
 *      (existing values are kept unless the environment provides a non-empty
 *      one; unknown lines and comments are preserved byte-for-byte).
 *   3. Writes the `swarm` MCP entry into each harness config, pointing at
 *      the local `dist/mcp-server.js` via this Node binary with
 *      `PI_SWARM_ENV_FILE`/`PI_SWARM_DB`/`PI_SWARM_WORKSPACE` set.
 *      A `<file>.bak` is kept the first time a config is touched.
 *   4. Spawns the server exactly as each harness would, runs the MCP
 *      handshake plus `tools/list` and a quota-free `swarm_capacity`, and
 *      reports tool and account counts. No agent is spawned, so no provider
 *      quota is spent.
 *
 * Key values are NEVER printed. Status lines say only `updated`, `kept`,
 * or `MISSING`.
 *
 * Usage:
 *   npm run install:harnesses                        # build + keys + wire + check
 *   npm run install:harnesses -- --dry-run           # print the plan, change nothing
 *   npm run install:harnesses -- --skip-build        # skip npm install (dist assumed fresh)
 *   npm run install:harnesses -- --verify            # also run the full spawn+wait
 *                                                     # verify per harness (spends a little quota)
 *
 * Key precedence is shell-over-file: export e.g. `OPENCODE_API_KEY` before
 * running to (re)install it; omit it to keep whatever `secrets.env` has.
 */

import { spawn, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_SEEDS } from "../src/providers.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST_SERVER = join(REPO_ROOT, "dist", "mcp-server.js");
const ENV_FILE = join(REPO_ROOT, "secrets.env");
const DB_FILE = join(REPO_ROOT, ".pi-swarm.db");
const WORKSPACE_DIR = join(REPO_ROOT, ".pi-swarm-workspace");
/**
 * Node binary for the harness commands. `process.execPath` on Homebrew
 * points into the versioned Cellar path, which breaks on every `brew
 * upgrade node`; the `/opt/homebrew/bin/node` symlink survives upgrades,
 * so prefer it when it exists.
 */
const BREW_NODE = "/opt/homebrew/bin/node";
const NODE_BIN = process.execPath.includes("/Cellar/") && existsSync(BREW_NODE) ? BREW_NODE : process.execPath;

const OPENCODE_CONFIG = join(homedir(), ".config", "opencode", "opencode.jsonc");
const CLAUDE_CONFIG = join(homedir(), ".claude.json");
const CODEX_CONFIG = join(homedir(), ".codex", "config.toml");

const WANTED_ENV: Record<string, string> = {
	PI_SWARM_ENV_FILE: ENV_FILE,
	PI_SWARM_DB: DB_FILE,
	PI_SWARM_WORKSPACE: WORKSPACE_DIR,
};

/** Provider key names, derived from the seed catalog so this never drifts. */
const PROVIDER_KEYS: string[] = [...new Set(PROVIDER_SEEDS.map((seed) => seed.credentialRef))].sort();

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const SKIP_BUILD = args.has("--skip-build");
const FULL_VERIFY = args.has("--verify");

function log(message: string): void {
	process.stdout.write(`${message}\n`);
}

/** Never print values — only whether a key is set, and from where. */
function keyStatus(name: string, fromEnv: boolean, fromFile: boolean): string {
	if (fromEnv) return "updated (from shell)";
	if (fromFile) return "kept (already in secrets.env)";
	return "MISSING";
}

// ---------------------------------------------------------------------------
// secrets.env merge (line-preserving, values never logged)
// ---------------------------------------------------------------------------

interface EnvLine {
	raw: string;
	key?: string | undefined;
}

function splitEnvLine(line: string): EnvLine {
	const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
	if (!match) return { raw: line };
	return { raw: line, key: match[1] };
}

function mergeEnvFile(): { updated: string[]; kept: string[]; missing: string[] } {
	const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8").split("\n") : [];
	const fileValues = new Map<string, string>();
	for (const line of existing) {
		const parsed = splitEnvLine(line.trim());
		if (parsed.key !== undefined && !fileValues.has(parsed.key)) {
			fileValues.set(parsed.key, "present");
		}
	}
	const updated: string[] = [];
	const kept: string[] = [];
	const missing: string[] = [];
	const wanted = new Map<string, string>();
	for (const key of PROVIDER_KEYS) {
		const fromShell = process.env[key];
		if (fromShell !== undefined && fromShell.length > 0) {
			wanted.set(key, fromShell);
			updated.push(key);
		} else if (fileValues.has(key)) {
			kept.push(key);
		} else {
			missing.push(key);
		}
	}
	if (!DRY_RUN) {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const line of existing) {
			const parsed = splitEnvLine(line.trim());
			if (parsed.key !== undefined && wanted.has(parsed.key) && !seen.has(parsed.key)) {
				seen.add(parsed.key);
				out.push(`${parsed.key}=${wanted.get(parsed.key) ?? ""}`);
				continue;
			}
			out.push(line);
		}
		for (const [key, value] of wanted) {
			if (!seen.has(key)) out.push(`${key}=${value}`);
		}
		writeFileSync(ENV_FILE, out.join("\n"), { mode: 0o600 });
		chmodSync(ENV_FILE, 0o600);
	}
	return { updated, kept, missing };
}

// ---------------------------------------------------------------------------
// Harness config writers (back up once, never log values)
// ---------------------------------------------------------------------------

function backupOnce(path: string): void {
	const backup = `${path}.bak`;
	if (!DRY_RUN && existsSync(path) && !existsSync(backup)) {
		copyFileSync(path, backup);
		log(`  backup: ${backup}`);
	}
}

function writeText(path: string, content: string): void {
	if (DRY_RUN) return;
	writeFileSync(path, content);
}

/** Minimal TOML string escaper for paths that hold no quotes or backslashes. */
function tomlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Set command/args and the env subsection of `[mcp_servers.swarm]` in a
 * Codex TOML file, preserving every other line. Appends the section when
 * it is absent.
 */
function patchCodexToml(source: string, command: string, argsList: string[], env: Record<string, string>): string {
	const lines = source.split("\n");
	const swarmHeader = "[mcp_servers.swarm]";
	const envHeader = "[mcp_servers.swarm.env]";
	const isSwarmHeader = (line: string): boolean => line.trim() === swarmHeader;
	const isEnvHeader = (line: string): boolean => line.trim() === envHeader;
	const isAnyHeader = (line: string): boolean => /^\[.*\]\s*$/.test(line.trim());

	let swarmIndex = lines.findIndex(isSwarmHeader);
	if (swarmIndex === -1) {
		const block = [
			"",
			swarmHeader,
			`command = ${tomlString(command)}`,
			`args = [${argsList.map((a) => tomlString(a)).join(", ")}]`,
			"",
			envHeader,
			...Object.entries(env).map(([k, v]) => `${k} = ${tomlString(v)}`),
			"",
		];
		return `${source.replace(/\n*$/, "\n")}${block.join("\n")}`;
	}

	// End of the swarm section: the next header that is not the env subsection.
	let sectionEnd = lines.length;
	for (let i = swarmIndex + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) break;
		if (isAnyHeader(line) && !isEnvHeader(line)) {
			sectionEnd = i;
			break;
		}
	}
	let sawCommand = false;
	let sawArgs = false;
	for (let i = swarmIndex + 1; i < sectionEnd; i++) {
		const line = lines[i];
		if (line === undefined || isEnvHeader(line)) continue;
		if (/^\s*command\s*=/.test(line)) {
			lines[i] = `command = ${tomlString(command)}`;
			sawCommand = true;
		} else if (/^\s*args\s*=/.test(line)) {
			lines[i] = `args = [${argsList.map((a) => tomlString(a)).join(", ")}]`;
			sawArgs = true;
		}
	}
	const insertAt = sectionEnd;
	const additions: string[] = [];
	if (!sawCommand) additions.push(`command = ${tomlString(command)}`);
	if (!sawArgs) additions.push(`args = [${argsList.map((a) => tomlString(a)).join(", ")}]`);
	lines.splice(insertAt, 0, ...additions);

	// Env subsection, wherever it lives (or appended right after the swarm block).
	let envIndex = lines.findIndex(isEnvHeader);
	if (envIndex === -1) {
		let end = lines.length;
		for (let i = swarmIndex + 1; i < lines.length; i++) {
			const line = lines[i];
			if (line === undefined) break;
			if (isAnyHeader(line)) {
				end = i;
				break;
			}
		}
		lines.splice(end, 0, "", envHeader, ...Object.entries(env).map(([k, v]) => `${k} = ${tomlString(v)}`));
	} else {
		let envEnd = lines.length;
		for (let i = envIndex + 1; i < lines.length; i++) {
			const line = lines[i];
			if (line === undefined) break;
			if (isAnyHeader(line)) {
				envEnd = i;
				break;
			}
		}
		const have = new Set<string>();
		for (let i = envIndex + 1; i < envEnd; i++) {
			const line = lines[i];
			if (line === undefined) continue;
			const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
			if (match?.[1] !== undefined && match[1] in env) {
				lines[i] = `${match[1]} = ${tomlString(env[match[1]] ?? "")}`;
				have.add(match[1]);
			}
		}
		const missing = Object.entries(env).filter(([k]) => !have.has(k));
		lines.splice(envEnd, 0, ...missing.map(([k, v]) => `${k} = ${tomlString(v)}`));
	}
	return lines.join("\n");
}

interface HarnessResult {
	name: string;
	path: string;
	changed: boolean;
	skipped?: string | undefined;
}

/** Write the swarm entry into a JSON harness config, preserving other keys. */
function wireJsonConfig(name: string, path: string, entry: Record<string, unknown>, rootKey: string): HarnessResult {
	if (!existsSync(path)) return { name, path, changed: false, skipped: "config file not found" };
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch {
		return { name, path, changed: false, skipped: "not plain JSON (has comments?) — edit by hand" };
	}
	const root = (raw[rootKey] as Record<string, unknown> | undefined) ?? {};
	const before = JSON.stringify(root["swarm"] ?? null);
	(root as Record<string, unknown>)["swarm"] = entry;
	(raw as Record<string, unknown>)[rootKey] = root;
	const after = JSON.stringify(root["swarm"] ?? null);
	if (before === after) return { name, path, changed: false };
	backupOnce(path);
	writeText(path, `${JSON.stringify(raw, null, 2)}\n`);
	return { name, path, changed: true };
}

function wireHarnesses(): HarnessResult[] {
	const results: HarnessResult[] = [];
	const command = NODE_BIN;
	const argsList = [DIST_SERVER];

	results.push(
		wireJsonConfig("opencode", OPENCODE_CONFIG, {
			type: "local",
			command: [command, ...argsList],
			environment: { ...WANTED_ENV },
			timeout: 60000,
		}, "mcp"),
	);
	results.push(
		wireJsonConfig("claude", CLAUDE_CONFIG, {
			type: "stdio",
			command,
			args: argsList,
			env: { ...WANTED_ENV },
		}, "mcpServers"),
	);

	if (!existsSync(CODEX_CONFIG)) {
		results.push({ name: "codex", path: CODEX_CONFIG, changed: false, skipped: "config file not found" });
	} else {
		const before = readFileSync(CODEX_CONFIG, "utf8");
		const after = patchCodexToml(before, command, argsList, WANTED_ENV);
		if (before === after) {
			results.push({ name: "codex", path: CODEX_CONFIG, changed: false });
		} else {
			backupOnce(CODEX_CONFIG);
			writeText(CODEX_CONFIG, after);
			results.push({ name: "codex", path: CODEX_CONFIG, changed: true });
		}
	}
	return results;
}

// ---------------------------------------------------------------------------
// Quota-free check: handshake + tools/list + swarm_capacity, no agent spawn
// ---------------------------------------------------------------------------

interface CheckOutcome {
	ok: boolean;
	detail: string;
}

async function checkHarness(name: string, command: string, argsList: string[], env: Record<string, string>): Promise<CheckOutcome> {
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(command, argsList, {
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (error) {
		return { ok: false, detail: `spawn failed: ${error instanceof Error ? error.message : String(error)}` };
	}
	const done = new Promise<CheckOutcome>((resolve) => {
		const stdin = child.stdin;
		const stdout = child.stdout;
		const stderr = child.stderr;
		if (!stdin || !stdout || !stderr) {
			child.kill();
			resolve({ ok: false, detail: "stdio pipes unavailable" });
			return;
		}
		const timer = setTimeout(() => {
			child.kill();
			resolve({ ok: false, detail: "timed out after 60s" });
		}, 60_000);
		let buffer = "";
		let nextId = 1;
		const pending = new Map<number, (value: unknown) => void>();
		stdout.setEncoding("utf8");
		stdout.on("data", (chunk: string) => {
			buffer += chunk;
			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (line.length === 0) continue;
				try {
					const message = JSON.parse(line) as { id?: number; result?: unknown };
					if (message.id === undefined) continue;
					pending.get(message.id)?.(message.result);
					pending.delete(message.id);
				} catch {
					// Non-JSON on stdout (server logs go to stderr, so ignore).
				}
			}
		});
		stderr.on("data", () => {
			// Drain; startup diagnostics live here.
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ ok: false, detail: `process error: ${error.message}` });
		});
		const request = (method: string, params?: unknown): Promise<unknown> => {
			const id = nextId++;
			return new Promise((response) => {
				pending.set(id, response);
				stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
			});
		};
		(async () => {
			try {
				const initialized = (await request("initialize", {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "install-harnesses", version: "1.0.0" },
				})) as { serverInfo?: { name?: string; version?: string } };
				stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
				const tools = (await request("tools/list")) as { tools?: Array<{ name?: string }> };
				const names = (tools.tools ?? []).map((tool) => tool.name ?? "?");
				if (!names.includes("swarm_spawn") || !names.includes("swarm_capacity")) {
					throw new Error(`unexpected tool list: ${names.join(", ")}`);
				}
				const capacity = (await request("tools/call", {
					name: "swarm_capacity",
					arguments: {},
				})) as { content?: Array<{ text?: string }> };
				const accounts = JSON.parse(capacity.content?.[0]?.text ?? "[]") as Array<unknown>;
				clearTimeout(timer);
				child.kill();
				resolve({
					ok: true,
					detail: `handshake OK (${initialized.serverInfo?.name ?? "?"} ${initialized.serverInfo?.version ?? "?"}), ${names.length} tools, ${accounts.length} accounts`,
				});
			} catch (error) {
				clearTimeout(timer);
				child.kill();
				resolve({ ok: false, detail: error instanceof Error ? error.message : String(error) });
			}
		})();
	});
	return done;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
	log(`pi-swarm harness installer${DRY_RUN ? " (dry run — nothing will be written)" : ""}`);
	log(`repo: ${REPO_ROOT}`);
	log(`node: ${NODE_BIN}`);

	if (!SKIP_BUILD) {
		log("step 1/4: npm install (prepare hook rebuilds dist/)");
		if (DRY_RUN) {
			log("  would run: npm install");
		} else {
			execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: REPO_ROOT, stdio: "inherit" });
		}
	} else {
		log("step 1/4: skipped (--skip-build)");
	}
	if (!DRY_RUN && !existsSync(DIST_SERVER)) {
		log(`FAIL: ${DIST_SERVER} missing — run npm run build first`);
		return 1;
	}

	log("step 2/4: provider keys -> secrets.env (values never printed)");
	const { updated, kept, missing } = mergeEnvFile();
	for (const key of [...updated, ...kept, ...missing]) {
		log(`  ${key}: ${keyStatus(key, updated.includes(key), kept.includes(key))}`);
	}
	if (missing.includes("OPENCODE_API_KEY")) {
		log("  warning: OPENCODE_API_KEY missing — OpenCode Go routing will have no credential");
	}

	log("step 3/4: swarm entry -> opencode, claude, codex");
	const wired = wireHarnesses();
	for (const result of wired) {
		if (result.skipped !== undefined) {
			log(`  ${result.name}: skipped (${result.skipped})`);
		} else if (DRY_RUN) {
			log(`  ${result.name}: ${result.changed ? "would write (differs)" : "already current"} — ${result.path}`);
		} else {
			log(`  ${result.name}: ${result.changed ? "wrote" : "already current"} — ${result.path}`);
		}
	}

	log("step 4/4: quota-free check (handshake + tools/list + swarm_capacity)");
	let failed = 0;
	for (const result of wired) {
		if (result.skipped !== undefined) continue;
		if (DRY_RUN) {
			log(`  ${result.name}: would spawn ${NODE_BIN} ${DIST_SERVER}`);
			continue;
		}
		const outcome = await checkHarness(result.name, NODE_BIN, [DIST_SERVER], WANTED_ENV);
		log(`  ${result.name}: ${outcome.ok ? "OK" : "FAIL"} — ${outcome.detail}`);
		if (!outcome.ok) failed += 1;
	}

	if (FULL_VERIFY && !DRY_RUN) {
		log("full verify per harness (spends a little quota: one tiny spawn each)");
		const targets: Array<[string, string]> = [
			["opencode", OPENCODE_CONFIG],
			["claude", CLAUDE_CONFIG],
			["codex", CODEX_CONFIG],
		];
		for (const [name, path] of targets) {
			if (!existsSync(path)) {
				log(`  ${name}: skipped (no config)`);
				continue;
			}
			try {
				execFileSync("npx", ["tsx", "scripts/verify-mcp-config.ts", path, "swarm"], {
					cwd: REPO_ROOT,
					stdio: "inherit",
				});
			} catch {
				log(`  ${name}: verify script exited non-zero (see output above)`);
				failed += 1;
			}
		}
	}

	if (failed > 0) {
		log(`RESULT: FAIL (${failed} harness check${failed === 1 ? "" : "es"} failed)`);
		return 1;
	}
	log("RESULT: OK — restart each harness so it picks up the new server process");
	return 0;
}

process.exitCode = await main();
