import { classifyFailure } from "./classifier.ts";
import { fetchWithTimeout, PI_SWARM_USER_AGENT } from "./fetch.ts";
import { createLogger } from "./logger.ts";
import { streamTurn, type ToolSpec } from "./stream.ts";

const _logger = createLogger("capabilities");

export const CAPABILITY_TTL_MS = 24 * 3600 * 1000;
const PROBE_TIMEOUT_MS = 30_000;

/**
 * Ceiling on capability probes ONE turn may issue. A turn must never spend
 * more provider requests verifying models than doing the work: an unbounded
 * probe fan-out over a large pool is indistinguishable from an attack on a
 * rate-limited free tier. Past the budget a turn sends on the assumed
 * capabilities and lets the response correct the verdict.
 */
export const MAX_PROBES_PER_TURN = 3;

export interface VerifiedCapabilities {
	tools?: boolean | undefined;
	vision?: boolean | undefined;
}

export interface CapabilityRecord extends VerifiedCapabilities {
	probedAt: number;
}

export interface CapabilityStore {
	getCapability(accountId: string, modelId: string): CapabilityRecord | undefined;
	setCapability(accountId: string, modelId: string, record: CapabilityRecord): void;
}

const PROBE_TOOL: ToolSpec = {
	type: "function",
	function: { name: "probe_capability", description: "Capability probe; never call it.", parameters: { type: "object", properties: {} } },
};

export interface ProbeEndpoint {
	baseUrl: string;
	modelId: string;
	apiKey?: string | undefined;
	signal?: AbortSignal | undefined;
	dispatcher?: unknown | undefined;
	egress?: { proxyId: string; country?: string | undefined; redacted?: string | undefined } | undefined;
	sessionIdHeader?: string | undefined;
	sessionId?: string | undefined;
	/** Wire protocol of the candidate (drives chat vs responses probes). */
	protocol?: "chat-completions" | "responses" | undefined;
}

function unsupported(status: number | undefined, errorMessage: string): boolean | null {
	if (status === undefined) return null;
	return classifyFailure(status, errorMessage).cls === "bad_request" ? false : null;
}

/** Probe requests are bounded well below a real turn's own timeout. */
export function probeSignal(upstream?: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
	return upstream ? AbortSignal.any([upstream, timeout]) : timeout;
}

export async function probeToolsSupport(endpoint: ProbeEndpoint): Promise<boolean | null> {
	if (endpoint.protocol === "responses") {
		const { streamResponsesTurn } = await import("./stream-responses.ts");
		const outcome = await streamResponsesTurn({
			baseUrl: endpoint.baseUrl,
			modelId: endpoint.modelId,
			apiKey: endpoint.apiKey,
			messages: [{ role: "user", content: "Reply with the word ok." }],
			tools: [PROBE_TOOL],
			maxTokens: 1,
			signal: probeSignal(endpoint.signal),
			...(endpoint.dispatcher !== undefined ? { dispatcher: endpoint.dispatcher } : {}),
			...(endpoint.egress !== undefined ? { egress: endpoint.egress } : {}),
			...(endpoint.sessionIdHeader !== undefined && endpoint.sessionId !== undefined
				? { sessionIdHeader: endpoint.sessionIdHeader, sessionId: endpoint.sessionId }
				: {}),
		});
		if (outcome.ok) return true;
		if (!outcome.ok && outcome.proxyError) return null;
		return unsupported(outcome.status, outcome.errorMessage);
	}
	const outcome = await streamTurn({
		baseUrl: endpoint.baseUrl,
		modelId: endpoint.modelId,
		apiKey: endpoint.apiKey,
		messages: [{ role: "user", content: "Reply with the word ok." }],
		tools: [PROBE_TOOL],
		maxTokens: 1,
		signal: probeSignal(endpoint.signal),
		...(endpoint.dispatcher !== undefined ? { dispatcher: endpoint.dispatcher } : {}),
		...(endpoint.egress !== undefined ? { egress: endpoint.egress } : {}),
		...(endpoint.sessionIdHeader !== undefined && endpoint.sessionId !== undefined
			? { sessionIdHeader: endpoint.sessionIdHeader, sessionId: endpoint.sessionId }
			: {}),
	});
	if (outcome.ok) return true;
	// A dead exit tells us nothing about the model's capabilities.
	if (!outcome.ok && outcome.proxyError) return null;
	return unsupported(outcome.status, outcome.errorMessage);
}

const PROBE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export async function probeVisionSupport(endpoint: ProbeEndpoint): Promise<boolean | null> {
	if (endpoint.protocol === "responses") {
		const { streamResponsesTurn } = await import("./stream-responses.ts");
		const outcome = await streamResponsesTurn({
			baseUrl: endpoint.baseUrl,
			modelId: endpoint.modelId,
			apiKey: endpoint.apiKey,
			rawInput: [
				{
					type: "message",
					role: "user",
					content: [
						{ type: "input_text", text: "What is in this image? Reply with one word." },
						{ type: "input_image", image_url: `data:image/png;base64,${PROBE_PIXEL_PNG}` },
					],
				},
			],
			messages: [],
			maxTokens: 1,
			signal: probeSignal(endpoint.signal),
			...(endpoint.dispatcher !== undefined ? { dispatcher: endpoint.dispatcher } : {}),
			...(endpoint.sessionIdHeader !== undefined && endpoint.sessionId !== undefined
				? { sessionIdHeader: endpoint.sessionIdHeader, sessionId: endpoint.sessionId }
				: {}),
		});
		if (outcome.ok) return true;
		if (!outcome.ok && outcome.proxyError) return null;
		return unsupported(outcome.status, outcome.errorMessage);
	}
	let response: Response;
	try {
		response = await fetchWithTimeout(
			`${endpoint.baseUrl.replace(/\/$/, "")}/chat/completions`,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"User-Agent": PI_SWARM_USER_AGENT,
					...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
					...(endpoint.sessionIdHeader !== undefined && endpoint.sessionId !== undefined
						? { [endpoint.sessionIdHeader]: endpoint.sessionId }
						: {}),
				},
				body: JSON.stringify({
					model: endpoint.modelId,
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "What is in this image? Reply with one word." },
								{ type: "image_url", image_url: { url: `data:image/png;base64,${PROBE_PIXEL_PNG}` } },
							],
						},
					],
					max_tokens: 1,
				}),
				signal: probeSignal(endpoint.signal),
				...(endpoint.dispatcher !== undefined ? { dispatcher: endpoint.dispatcher } : {}),
			},
			PROBE_TIMEOUT_MS,
		);
	} catch {
		return null;
	}
	if (response.ok) {
		await response.body?.cancel().catch(() => undefined);
		return true;
	}
	return unsupported(response.status, `HTTP ${response.status}`);
}

export class CapabilityCache {
	private readonly memory = new Map<string, CapabilityRecord>();

	constructor(private readonly store?: CapabilityStore | undefined) {}

	static key(accountId: string, modelId: string): string {
		return `${accountId}/${modelId}`;
	}

	get(accountId: string, modelId: string, now: number = Date.now()): VerifiedCapabilities | undefined {
		const key = CapabilityCache.key(accountId, modelId);
		const cached = this.memory.get(key) ?? this.store?.getCapability(accountId, modelId);
		if (!cached) return undefined;
		if (now - cached.probedAt > CAPABILITY_TTL_MS) {
			this.memory.delete(key);
			return undefined;
		}
		this.memory.set(key, cached);
		const verified: VerifiedCapabilities = {};
		if (cached.tools !== undefined) verified.tools = cached.tools;
		if (cached.vision !== undefined) verified.vision = cached.vision;
		return verified;
	}

	set(accountId: string, modelId: string, verified: VerifiedCapabilities, now: number = Date.now()): void {
		const key = CapabilityCache.key(accountId, modelId);
		const previous = this.memory.get(key) ?? this.store?.getCapability(accountId, modelId);
		const record: CapabilityRecord = {
			probedAt: now,
			...(previous?.tools !== undefined ? { tools: previous.tools } : {}),
			...(previous?.vision !== undefined ? { vision: previous.vision } : {}),
			...(verified.tools !== undefined ? { tools: verified.tools } : {}),
			...(verified.vision !== undefined ? { vision: verified.vision } : {}),
		};
		this.memory.set(key, record);
		try {
			this.store?.setCapability(accountId, modelId, record);
		} catch (error) {
			_logger.warn("capability_store_write_failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}
}
