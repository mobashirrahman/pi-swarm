/**
 * Structured logger. Namespaced, level-filtered, no color codes in output —
 * every provider/account/model identifier is safe to log; keys and header
 * VALUES never are (pi-free convention 17).
 *
 * Deliberately minimal: JSON-lines to console so a supervisor (pm2, launchd,
 * Docker) can ship them. File logging comes later with the persistence layer.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

function envLevel(): LogLevel {
	const raw = process.env.PI_SWARM_LOG_LEVEL ?? process.env.LOG_LEVEL;
	switch (raw?.toLowerCase()) {
		case "debug":
			return "debug";
		case "warn":
			return "warn";
		case "error":
			return "error";
		default:
			return "info";
	}
}

let minLevel: LogLevel = envLevel();

/** Override the level (tests use this to silence output). */
export function setLogLevel(level: LogLevel): void {
	minLevel = level;
}

function emit(level: LogLevel, ns: string, message: string, fields?: Record<string, unknown>): void {
	if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
	const entry = {
		ts: new Date().toISOString(),
		level,
		ns,
		msg: message,
		pid: process.pid,
		...fields,
	};
	// ALWAYS stderr. stdout belongs to the program's actual output — for the
	// MCP stdio server that stream carries JSON-RPC frames, and a single log
	// line there corrupts the protocol.
	process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export interface Logger {
	debug(message: string, fields?: Record<string, unknown>): void;
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(namespace: string): Logger {
	return {
		debug: (message, fields) => emit("debug", namespace, message, fields),
		info: (message, fields) => emit("info", namespace, message, fields),
		warn: (message, fields) => emit("warn", namespace, message, fields),
		error: (message, fields) => emit("error", namespace, message, fields),
	};
}
