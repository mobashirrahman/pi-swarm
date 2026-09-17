/**
 * Stream driver: one chat-completion turn against an OpenAI-compatible
 * endpoint, streamed via SSE. Direct fetch (v1) — pi-ai integration is a
 * later phase; the wire format for all seed providers is chat/completions.
 *
 * Security: never logs header values, keys, prompts, or response bodies.
 * Returns status + usage + quota headers so the scheduler can reconcile.
 */

import { fetchWithTimeout } from "./fetch.ts";
import { createLogger } from "./logger.ts";
import { extractQuotaHeaders, type HeaderParseResult } from "./quota-headers.ts";

const _logger = createLogger("stream");

export interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string | null;
	/** For role=tool. */
	tool_call_id?: string | undefined;
	/** For role=assistant with tool calls. */
	tool_calls?: Array<{
		id: string;
		type: "function";
		function: { name: string; arguments: string };
	}> | undefined;
}

export interface TurnRequest {
	baseUrl: string;
	modelId: string;
	apiKey?: string | undefined;
	messages: ReadonlyArray<ChatMessage>;
	tools?: ReadonlyArray<ToolSpec> | undefined;
	maxTokens?: number | undefined;
	signal?: AbortSignal | undefined;
}

export interface ToolSpec {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface TurnUsage {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
}

/**
 * Speed measurements for one turn. These are the INTERNAL benchmark: what this
 * deployment actually observes, as opposed to what a vendor publishes.
 */
export interface TurnTiming {
	/** Total wall time of the turn. */
	latencyMs: number;
	/** Request sent → first content token. The dominant UX cost. */
	ttftMs: number | undefined;
	/** Output tokens per second, measured over the streaming window. */
	tokensPerSecond: number | undefined;
}

/**
 * Minimum streaming interval before a tokens/sec figure is meaningful; below
 * this the denominator is noise.
 */
const MIN_STREAM_WINDOW_MS = 200;

/**
 * Ceiling for a believable generation rate. No hosted model streams anywhere
 * near this; a larger figure means the provider's `completion_tokens` counted
 * tokens that never appeared in the visible stream.
 */
const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 1_000;

export type TurnOutcome =
	| {
			ok: true;
			/** Staged assistant message — commit ONLY after full validation. */
			message: ChatMessage;
			content: string;
			toolCalls: Array<{ id: string; name: string; arguments: string }>;
			usage: TurnUsage | undefined;
			quota: HeaderParseResult;
			latencyMs: number;
			/** Internal speed measurements for routing. */
			timing: TurnTiming;
	  }
	| {
			ok: false;
			status: number | undefined; // undefined = network-level failure
			errorMessage: string;
			quota: HeaderParseResult;
			latencyMs: number;
	  };

/** Parse `data: {...}` SSE lines from a response body. */
async function* sseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
				buffer = buffer.slice(newlineIndex + 1);
				if (line.startsWith("data: ")) yield line.slice(6);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

interface StreamDelta {
	choices?: Array<{
		delta?: { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
		finish_reason?: string | null;
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
}

/**
 * Execute one streamed turn. Stages content in memory; caller decides
 * commit vs discard. NEVER logs message content.
 */
export async function streamTurn(request: TurnRequest): Promise<TurnOutcome> {
	const startedAt = Date.now();
	const url = `${request.baseUrl.replace(/\/$/, "")}/chat/completions`;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
	};
	if (request.apiKey) headers.Authorization = `Bearer ${request.apiKey}`;

	const bodyPayload: Record<string, unknown> = {
		model: request.modelId,
		messages: request.messages,
		stream: true,
		stream_options: { include_usage: true },
	};
	if (request.maxTokens) bodyPayload.max_tokens = request.maxTokens;
	if (request.tools && request.tools.length > 0) {
		bodyPayload.tools = request.tools;
		bodyPayload.tool_choice = "auto";
	}

	let response: Response;
	try {
		response = await fetchWithTimeout(url, {
			method: "POST",
			headers,
			body: JSON.stringify(bodyPayload),
			signal: request.signal,
		}, 120_000);
	} catch (error) {
		const aborted = request.signal?.aborted === true;
		const latencyMs = Date.now() - startedAt;
		const emptyQuota: HeaderParseResult = { quotas: [], drift: false };
		if (aborted) {
			return { ok: false, status: undefined, errorMessage: "aborted", quota: emptyQuota, latencyMs };
		}
		return {
			ok: false,
			status: undefined,
			errorMessage: error instanceof Error ? error.message : String(error),
			quota: emptyQuota,
			latencyMs,
		};
	}

	// Header names for the wire signature — VALUES never logged.
	const headerNames: string[] = [];
	response.headers.forEach((_value, name) => headerNames.push(name));
	_logger.debug("wire", {
		provider: new URL(url).host,
		model: request.modelId,
		headerNames,
	});

	const accountId = new URL(url).host;
	const quota = extractQuotaHeaders(Object.fromEntries(response.headers.entries()), accountId);

	if (!response.ok) {
		const latencyMs = Date.now() - startedAt;
		return {
			ok: false,
			status: response.status,
			errorMessage: `HTTP ${response.status}`,
			quota,
			latencyMs,
		};
	}
	if (!response.body) {
		return { ok: false, status: response.status, errorMessage: "empty body", quota, latencyMs: Date.now() - startedAt };
	}

	// Stage everything; nothing commits until the stream completes cleanly.
	let content = "";
	const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();
	let usage: TurnUsage | undefined;
	let sawFinish = false;
	// Internal speed measurements: first content token, and the window over
	// which output actually streamed (so tokens/sec reflects generation, not
	// queueing before the first token).
	let firstTokenAt: number | undefined;
	let lastTokenAt: number | undefined;

	try {
		for await (const data of sseChunks(response.body)) {
			if (data === "[DONE]") break;
			let parsed: StreamDelta;
			try {
				parsed = JSON.parse(data) as StreamDelta;
			} catch {
				continue; // malformed chunk — skip, stream continues
			}
			const choice = parsed.choices?.[0];
			if (choice?.delta?.content) {
				content += choice.delta.content;
				const now = Date.now();
				firstTokenAt ??= now;
				lastTokenAt = now;
			}
			const toolDeltas = choice?.delta?.tool_calls;
			if (toolDeltas) {
				for (const delta of toolDeltas) {
					const index = delta.index ?? 0;
					const existing = toolCallMap.get(index) ?? { id: "", name: "", arguments: "" };
					if (delta.id) existing.id = delta.id;
					if (delta.function?.name) existing.name += delta.function.name;
					if (delta.function?.arguments) existing.arguments += delta.function.arguments;
					toolCallMap.set(index, existing);
				}
			}
			if (choice?.finish_reason) sawFinish = true;
			if (parsed.usage) {
				usage = {
					promptTokens: parsed.usage.prompt_tokens ?? 0,
					completionTokens: parsed.usage.completion_tokens ?? 0,
					totalTokens: parsed.usage.total_tokens ?? 0,
				};
			}
		}
	} catch (error) {
		return {
			ok: false,
			status: undefined,
			errorMessage: error instanceof Error ? error.message : String(error),
			quota,
			latencyMs: Date.now() - startedAt,
		};
	}

	const latencyMs = Date.now() - startedAt;
	if (!sawFinish && !request.signal?.aborted) {
		// Stream ended without a finish_reason — treat as a failed stream.
		// (pi-free classifier: "stream ended before" = transient.)
		return { ok: false, status: undefined, errorMessage: "stream ended before finish", quota, latencyMs };
	}

	const toolCalls = [...toolCallMap.values()].filter((tc) => tc.id && tc.name);
	const message: ChatMessage = {
		role: "assistant",
		content: content.length > 0 ? content : null,
		tool_calls: toolCalls.length > 0
			? toolCalls.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.arguments } }))
			: undefined,
	};

	// Throughput over the streaming window only, and only when the measurement is
	// physically plausible. Two guards, both needed:
	//   - window: a rate needs a real streaming interval to divide by.
	//   - ceiling: gateways report completion_tokens that can include reasoning
	//     or cached tokens, so a short visible answer can imply tens of
	//     thousands of tokens/sec (measured live: 25,708 tps). An impossible
	//     rate would win every routing tie-break, so it is treated as
	//     unmeasured rather than recorded.
	const streamWindowMs = firstTokenAt !== undefined && lastTokenAt !== undefined ? lastTokenAt - firstTokenAt : 0;
	const completionTokens = usage?.completionTokens ?? 0;
	const rawRate = completionTokens > 0 && streamWindowMs >= MIN_STREAM_WINDOW_MS ? (completionTokens / streamWindowMs) * 1000 : undefined;
	const tokensPerSecond = rawRate !== undefined && rawRate <= MAX_PLAUSIBLE_TOKENS_PER_SECOND ? Math.round(rawRate) : undefined;
	const timing: TurnTiming = {
		latencyMs,
		ttftMs: firstTokenAt !== undefined ? firstTokenAt - startedAt : undefined,
		tokensPerSecond,
	};

	return { ok: true, message, content, toolCalls, usage, quota, latencyMs, timing };
}
