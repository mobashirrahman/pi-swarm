/**
 * Egress proxies: geo-distributed exits for model turns.
 *
 * Bring-your-own exits: pi-swarm cannot mint real USA/NL/FR/DE IPs from code.
 * Point it at per-country SOCKS5/HTTP proxies (commercial VPN converted to
 * local SOCKS5, SSH -D tunnels, or a residential proxy with country
 * selection) and every turn picks a random exit. See docs/egress-proxies.md.
 *
 * Security: proxy URLs contain credentials. NEVER log `url` — use
 * `redactProxyUrl` / `redacted` / `proxyId + country` only.
 */

import { readFileSync } from "node:fs";
import { ProxyAgent, Socks5ProxyAgent } from "undici";

export type EgressProtocol = "http" | "https" | "socks5" | "socks5h";

export interface EgressProxy {
	/** Stable id, e.g. "egress-0". Safe to log. */
	id: string;
	/** Full proxy URL including credentials. NEVER log. */
	url: string;
	/** ISO-3166-1 alpha-2 upper, e.g. "US". Undefined = global pool. */
	country?: string | undefined;
	protocol: EgressProtocol;
}

export interface EgressSelection {
	proxyId: string;
	/** Full URL — pass to the dispatcher cache, never log. */
	url: string;
	country?: string | undefined;
	protocol: EgressProtocol;
	/** Redacted host for logs/events. */
	redacted: string;
}

/** Quota-style TTL: a failed exit re-admits after the window refills. */
export const EGRESS_BLACKLIST_TTL_MS = 30_000;

/** Max proxy retries per provider attempt (bounded, like capability probes). */
export const MAX_EGRESS_RETRIES_PER_ATTEMPT = 3;

/** Hide credentials, query, and fragment: `protocol://host:port`. */
export function redactProxyUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const host = parsed.hostname.toLowerCase();
		const port = parsed.port.length > 0 ? `:${parsed.port}` : "";
		const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
		return `${protocol}://${host}${port}`;
	} catch {
		return "(invalid-proxy-url)";
	}
}

function normalizeCountry(raw: string | null | undefined): string | undefined {
	if (!raw) return undefined;
	const upper = raw.trim().toUpperCase();
	return /^[A-Z]{2}$/.test(upper) ? upper : undefined;
}

function normalizeProtocol(protocol: string): EgressProtocol | undefined {
	const lower = protocol.replace(/:$/, "").toLowerCase();
	if (lower === "http") return "http";
	if (lower === "https") return "https";
	if (lower === "socks5" || lower === "socks5h") return lower;
	// `socks://` is a common alias for SOCKS5.
	if (lower === "socks") return "socks5";
	return undefined;
}

/**
 * Parse one proxy entry. Accepted forms (country is always optional):
 *   socks5://127.0.0.1:1080#US
 *   socks5://127.0.0.1:1080#country=DE
 *   socks5://127.0.0.1:1080?country=FR
 *   US=socks5://127.0.0.1:1080
 *   https://user:pass@proxy.example:8080
 */
export function parseEgressEntry(entry: string, index: number): EgressProxy | undefined {
	const trimmed = entry.trim();
	if (trimmed.length === 0) return undefined;

	let country: string | undefined;
	let urlText = trimmed;

	// `CC=url` prefix (URLs never contain `=` before `://`, so this is safe).
	const prefixMatch = /^([A-Za-z]{2})=(.+)$/.exec(trimmed);
	if (prefixMatch?.[1] && prefixMatch[2]) {
		country = normalizeCountry(prefixMatch[1]);
		urlText = prefixMatch[2].trim();
	}

	// `#CC` / `#country=CC` fragment suffix.
	const hashIndex = urlText.indexOf("#");
	if (hashIndex !== -1) {
		const fragment = urlText.slice(hashIndex + 1);
		const fragCountry = fragment.startsWith("country=")
			? normalizeCountry(fragment.slice("country=".length))
			: normalizeCountry(fragment);
		if (fragCountry) country = fragCountry;
		urlText = urlText.slice(0, hashIndex);
	}

	let parsed: URL;
	try {
		parsed = new URL(urlText);
	} catch {
		return undefined;
	}
	const protocol = normalizeProtocol(parsed.protocol);
	if (!protocol) return undefined;
	if (!parsed.hostname) return undefined;

	// `?country=CC` query param (removed so it never reaches the proxy).
	const queryCountry = normalizeCountry(parsed.searchParams.get("country"));
	if (queryCountry) {
		country = queryCountry;
		parsed.searchParams.delete("country");
	}
	const url = parsed.toString();

	return {
		id: `egress-${index}`,
		url,
		...(country ? { country } : {}),
		protocol,
	};
}

/** Parse comma/newline-separated proxy list into valid proxies (invalid skipped). */
export function parseEgressProxies(raw: string): EgressProxy[] {
	const entries = raw.split(/[,\n]+/);
	const proxies: EgressProxy[] = [];
	let index = 0;
	for (const entry of entries) {
		const proxy = parseEgressEntry(entry, index);
		if (proxy) {
			proxies.push(proxy);
			index += 1;
		}
	}
	return proxies;
}

/** Parse a default country filter like "US,NL,FR,DE". Invalid codes dropped. */
export function parseCountryFilter(raw: string | undefined): string[] | undefined {
	if (!raw || raw.trim().length === 0) return undefined;
	const codes = raw
		.split(/[,\s]+/)
		.map((code) => code.trim().toUpperCase())
		.filter((code) => /^[A-Z]{2}$/.test(code));
	return codes.length > 0 ? [...new Set(codes)] : undefined;
}

export interface EgressEnvConfig {
	proxies: EgressProxy[];
	defaultCountries?: string[] | undefined;
	/** Non-fatal config problems (bad file, invalid entries) — no secrets. */
	problems: string[];
}

/** Read proxy pool + default filter from the environment (never logs values). */
export function loadEgressConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EgressEnvConfig {
	const problems: string[] = [];
	const proxies: EgressProxy[] = [];

	const filePath = env["PI_SWARM_PROXIES_FILE"];
	if (filePath && filePath.length > 0) {
		try {
			const content = readFileSync(filePath, "utf8");
			const parsed: unknown = JSON.parse(content);
			const items = Array.isArray(parsed) ? parsed : [];
			let index = proxies.length;
			for (const item of items) {
				if (typeof item === "string") {
					const proxy = parseEgressEntry(item, index);
					if (proxy) {
						proxies.push(proxy);
						index += 1;
					} else {
						problems.push("proxies file: skipped an invalid entry");
					}
				} else if (typeof item === "object" && item !== null) {
					const record = item as Record<string, unknown>;
					const url = typeof record["url"] === "string" ? record["url"] : "";
					const country = typeof record["country"] === "string" ? record["country"] : "";
					const proxy = parseEgressEntry(country ? `${country}=${url}` : url, index);
					if (proxy) {
						proxies.push(proxy);
						index += 1;
					} else {
						problems.push("proxies file: skipped an invalid entry");
					}
				}
			}
		} catch {
			problems.push(`proxies file unreadable: ${filePath}`);
		}
	}

	const inline = env["PI_SWARM_PROXIES"];
	if (inline && inline.length > 0) {
		const startIndex = proxies.length;
		const parsed = parseEgressProxies(inline);
		// Re-id after the file entries so ids stay dense.
		for (let i = 0; i < parsed.length; i++) {
			const proxy = parsed[i];
			if (proxy) proxies.push({ ...proxy, id: `egress-${startIndex + i}` });
		}
	}

	return {
		proxies,
		defaultCountries: parseCountryFilter(env["PI_SWARM_EGRESS_COUNTRIES"]),
		problems,
	};
}

/** Fail-closed error: pool configured but no exit matched. Never carries a URL. */
export class EgressExhaustedError extends Error {
	readonly code = "egress_exhausted";
	constructor(
		readonly reason: "no_proxies_configured" | "no_country_match" | "all_blacklisted",
		readonly countries?: readonly string[],
	) {
		super(
			reason === "no_country_match"
				? `no egress proxy for country filter: ${(countries ?? []).join(",") || "(empty)"}`
				: reason === "all_blacklisted"
					? "all egress proxies temporarily blacklisted"
					: "egress required but no proxies configured",
		);
		this.name = "EgressExhaustedError";
	}
}

/**
 * Random-per-turn exit pool with TTL blacklisting (mirrors quota strikes:
 * failures age out fast so a flaky exit rejoins on its own).
 */
export class EgressPool {
	private readonly proxies: EgressProxy[];
	private readonly blacklist = new Map<string, { until: number; strikes: number }>();
	private readonly blacklistTtlMs: number;
	private readonly random: () => number;

	constructor(proxies: readonly EgressProxy[], options: { blacklistTtlMs?: number; random?: () => number } = {}) {
		this.proxies = [...proxies];
		this.blacklistTtlMs = options.blacklistTtlMs ?? EGRESS_BLACKLIST_TTL_MS;
		this.random = options.random ?? Math.random;
	}

	get size(): number {
		return this.proxies.length;
	}

	get configured(): boolean {
		return this.proxies.length > 0;
	}

	/** Distinct countries in the pool (sorted). */
	countries(): string[] {
		const set = new Set<string>();
		for (const proxy of this.proxies) {
			if (proxy.country) set.add(proxy.country);
		}
		return [...set].sort();
	}

	get(proxyId: string): EgressProxy | undefined {
		return this.proxies.find((proxy) => proxy.id === proxyId);
	}

	isBlacklisted(proxyId: string, now: number = Date.now()): boolean {
		const entry = this.blacklist.get(proxyId);
		if (!entry) return false;
		if (now >= entry.until) {
			this.blacklist.delete(proxyId);
			return false;
		}
		return true;
	}

	/**
	 * Pick a random eligible exit. Country filter is fail-closed: when a
	 * filter is given, only matching countries qualify (global exits do not
	 * silently substitute for a requested geo). Returns null when nothing is
	 * eligible — the caller converts to EgressExhaustedError with the reason.
	 */
	pick(countries?: readonly string[], now: number = Date.now()): EgressSelection | null {
		const wanted = (countries ?? []).map((code) => code.toUpperCase()).filter((code) => /^[A-Z]{2}$/.test(code));
		const eligible = this.proxies.filter((proxy) => {
			if (this.isBlacklisted(proxy.id, now)) return false;
			if (wanted.length > 0) return proxy.country !== undefined && wanted.includes(proxy.country);
			return true;
		});
		if (eligible.length === 0) return null;
		const choice = eligible[Math.floor(this.random() * eligible.length)]!;
		return {
			proxyId: choice.id,
			url: choice.url,
			...(choice.country ? { country: choice.country } : {}),
			protocol: choice.protocol,
			redacted: redactProxyUrl(choice.url),
		};
	}

	/** Throw the precise fail-closed reason instead of returning null. */
	require(countries?: readonly string[], now: number = Date.now()): EgressSelection {
		if (this.proxies.length === 0) throw new EgressExhaustedError("no_proxies_configured", countries);
		const selection = this.pick(countries, now);
		if (selection) return selection;
		const wanted = (countries ?? []).filter((code) => code.trim().length > 0);
		const anyCountryMatch = wanted.length === 0 || this.proxies.some((proxy) => proxy.country && wanted.map((c) => c.toUpperCase()).includes(proxy.country));
		if (!anyCountryMatch) throw new EgressExhaustedError("no_country_match", wanted);
		throw new EgressExhaustedError("all_blacklisted", wanted.length > 0 ? wanted : undefined);
	}

	recordFailure(proxyId: string, now: number = Date.now()): void {
		const previous = this.blacklist.get(proxyId);
		this.blacklist.set(proxyId, {
			until: now + this.blacklistTtlMs,
			strikes: (previous?.strikes ?? 0) + 1,
		});
	}

	recordSuccess(proxyId: string): void {
		this.blacklist.delete(proxyId);
	}

	/** Operator view: ids + countries + redacted hosts only, never URLs. */
	snapshot(now: number = Date.now()): Array<{
		proxyId: string;
		country?: string | undefined;
		protocol: EgressProtocol;
		redacted: string;
		blacklisted: boolean;
		strikes: number;
	}> {
		return this.proxies.map((proxy) => {
			const entry = this.blacklist.get(proxy.id);
			const blacklisted = entry !== undefined && now < entry.until;
			return {
				proxyId: proxy.id,
				...(proxy.country ? { country: proxy.country } : {}),
				protocol: proxy.protocol,
				redacted: redactProxyUrl(proxy.url),
				blacklisted,
				strikes: entry?.strikes ?? 0,
			};
		});
	}
}

// =============================================================================
// ProxyAgent cache (HTTP + SOCKS5 via proxy-agent, reused per exit)
// =============================================================================

const dispatcherCache = new Map<string, unknown>();

/** Dispatcher for one exit URL, cached per URL (URLs never leave this module). */
export async function dispatcherFor(proxyUrl: string): Promise<unknown> {
	const cached = dispatcherCache.get(proxyUrl);
	if (cached) return cached;
	const protocol = new URL(proxyUrl).protocol.replace(/:$/, "").toLowerCase();
	// Undici splits the surface: ProxyAgent for HTTP(S), Socks5ProxyAgent
	// for SOCKS5 (experimental upstream, verified working for CONNECT + fetch).
	const agent = protocol === "socks5" || protocol === "socks5h" || protocol === "socks"
		? new Socks5ProxyAgent(proxyUrl)
		: new ProxyAgent(proxyUrl);
	dispatcherCache.set(proxyUrl, agent);
	return agent;
}

/** Clear the cache (tests only). */
export function clearDispatcherCache(): void {
	dispatcherCache.clear();
}

export interface EgressCheckResult {
	proxyId: string;
	country?: string | undefined;
	redacted: string;
	ok: boolean;
	exitIp?: string | undefined;
	error?: string | undefined;
	latencyMs: number;
}

/**
 * Verify one exit without spending provider quota: fetch a tiny IP-echo
 * endpoint THROUGH the proxy and report the visible exit IP. Secrets are
 * never included in the result.
 */
export async function checkEgressProxy(
	proxy: EgressProxy,
	options: { timeoutMs?: number; endpoint?: string } = {},
): Promise<EgressCheckResult> {
	const startedAt = Date.now();
	const redacted = redactProxyUrl(proxy.url);
	const base = {
		proxyId: proxy.id,
		...(proxy.country ? { country: proxy.country } : {}),
		redacted,
	};
	try {
		const dispatcher = await dispatcherFor(proxy.url);
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
		try {
			const response = await fetch(options.endpoint ?? "https://api.ipify.org?format=json", {
				// Undici dispatcher — supported by Node's fetch.
				...(dispatcher ? { dispatcher: dispatcher as never } : {}),
				signal: controller.signal,
			} as RequestInit);
			if (!response.ok) {
				return { ...base, ok: false, error: `HTTP ${response.status}`, latencyMs: Date.now() - startedAt };
			}
			const body = (await response.json().catch(() => ({}))) as { ip?: unknown };
			return {
				...base,
				ok: true,
				...(typeof body.ip === "string" ? { exitIp: body.ip } : {}),
				latencyMs: Date.now() - startedAt,
			};
		} finally {
			clearTimeout(timeoutId);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ...base, ok: false, error: message.slice(0, 120), latencyMs: Date.now() - startedAt };
	}
}
