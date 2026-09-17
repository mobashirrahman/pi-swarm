/**
 * Minimal `.env` loader for provider credentials.
 *
 * Why this exists: the swarm needs provider keys, and copying them into a
 * second file (the harness MCP config, a shell profile) means two places to
 * leak and two places to rotate. Pointing `PI_SWARM_ENV_FILE` at the one
 * secrets file keeps a single source of truth.
 *
 * Security rules:
 *  - Values are NEVER logged or returned. Only variable NAMES are reported.
 *  - An already-set process variable always wins (`override: false` default),
 *    so a shell export or the harness's own env block takes precedence.
 *  - A missing file is not an error: most deployments use ambient env vars.
 */

import { readFileSync } from "node:fs";

export interface LoadEnvFileResult {
	/** Variable names that were set (never their values). */
	loaded: string[];
	/** Variable names present in the file but skipped because env already had them. */
	skipped: string[];
	/** Parse problems, as `line N: reason` — no content included. */
	problems: string[];
}

/**
 * Load KEY=VALUE pairs into `target` (default `process.env`).
 * Supports `export KEY=VALUE`, `#` comments, blank lines, and quoted values.
 */
export function loadEnvFile(
	path: string,
	options: { target?: NodeJS.ProcessEnv; override?: boolean } = {},
): LoadEnvFileResult {
	const target = options.target ?? process.env;
	const override = options.override ?? false;
	const result: LoadEnvFileResult = { loaded: [], skipped: [], problems: [] };

	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch {
		// Absent file is a normal configuration state, not a failure.
		return result;
	}

	const lines = content.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		const withoutExport = line.trim().startsWith("export ") ? line.trim().slice(7) : line;
		const trimmed = withoutExport.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

		const separator = trimmed.indexOf("=");
		if (separator <= 0) {
			result.problems.push(`line ${index + 1}: not a KEY=VALUE assignment`);
			continue;
		}

		const name = trimmed.slice(0, separator).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			result.problems.push(`line ${index + 1}: invalid variable name`);
			continue;
		}

		// Surrounding quotes are stripped so `KEY="a b"` yields `a b`.
		const rawValue = trimmed.slice(separator + 1).trim();
		const value =
			rawValue.length >= 2 &&
			((rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'")))
				? rawValue.slice(1, -1)
				: rawValue;
		if (value.length === 0) {
			result.problems.push(`line ${index + 1}: empty value for ${name}`);
			continue;
		}

		const existing = target[name];
		if (existing !== undefined && existing.length > 0 && !override) {
			result.skipped.push(name);
			continue;
		}

		target[name] = value;
		result.loaded.push(name);
	}

	return result;
}

/**
 * Load the file named by `PI_SWARM_ENV_FILE`, if set. Returns the report so a
 * caller can log the NAMES (never values).
 */
export function loadConfiguredEnvFile(target: NodeJS.ProcessEnv = process.env): LoadEnvFileResult & { path?: string } {
	const path = target["PI_SWARM_ENV_FILE"];
	if (path === undefined || path.length === 0) return { loaded: [], skipped: [], problems: [] };
	const result = loadEnvFile(path, { target });
	return { ...result, path };
}