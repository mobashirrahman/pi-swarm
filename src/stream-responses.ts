/**
 * Responses driver: one turn against an OpenAI Responses-API endpoint
 * (`POST {baseUrl}/responses`), streamed via SSE with named events.
 *
 * Needed for models served ONLY on this protocol (verified live: OpenCode
 * Go's Grok/GPT-Luna/Muse-Spark answer `ModelProtocolUnsupported` on
 * chat/completions). Returns the SAME TurnOutcome shape as the chat driver,
 * so quota, leases, journaling, and transcripts are untouched.
 *
 * Security: never logs header values, keys, prompts, or response bodies.
 */

import { fetchWithTimeout, PI_SWARM_USER_AGENT } from "./fetch.ts";
import { createLogger } from "./logger.ts";
import { extractQuotaHeaders, type HeaderParseResult } from "./quota-headers.ts";
import type { ChatMessage, ToolSpec, TurnOutcome, TurnRequest, TurnTiming, TurnUsage } from "./stream.ts";

const _logger = createLogger("stream-responses");

/** Same guards as the chat driver: rate needs a real window; impossible rates are unmeasured. */
const MIN_STREAM_WINDOW_MS = 200;
const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 1_000;

/** Extra request field: bypass message conversion with ready-made input items (vision probe). */
export interface ResponsesTurnRequest extends TurnRequest {
	rawInput?: unknown[] | undefined;
}

/** Parse `event: ...` / `data: ...` SSE frames from a response body. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let event = "message";
	let dataLines: string[] = [];
	const flush = function* (): Generator<{ event: string; data: string }> {
		if (dataLines.length === 0) return;
		const payload = dataLines.join("\n");
		dataLines = [];
		if (payload === "[DONE]") return;
		yield { event, data: payload };
		event = "message";
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
				buffer = buffer.slice(newlineIndex + 1);
				if (line === "") {
					yield* flush();
				} else if (line.startsWith(":")) {
					continue; // SSE comment / keepalive
				} else if (line.startsWith("event:")) {
					event = line.slice(6).trim();
				} else if (line.startsWith("data:")) {
					dataLines.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
				}
			}
		}
		buffer += decoder.decode();
		if (buffer.length > 0 && !buffer.startsWith(":") && !buffer.startsWith("event:") && buffer.startsWith("data:")) {
			dataLines.push(buffer.startsWith("data: ") ? buffer.slice(6) : buffer.slice(5));
		}
		yield* flush();
	} finally {
		reader.releaseLock();
	}
}

/** Convert the durable transcript into Responses input items. */
function toResponseInput(messages: ReadonlyArray<ChatMessage>): unknown[] {
	const items: unknown[] = [];
	for (const message of messages) {
		if (message.role === "tool") {
			items.push({ type: "function_call_output", call_id: message.tool_call_id ?? "", output: message.content ?? "" });
			continue;
		}
		if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
			if (message.content) {
				items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: message.content }] });
			}
			for (const call of message.tool_calls) {
				items.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
			}
			continue;
		}
		if (message.content === null) continue;
		items.push({ type: "message", role: message.role, content: [{ type: "input_text", text: message.content }] });
	}
	return items;
}

function toResponseTools(tools: ReadonlyArray<ToolSpec>): unknown[] {
	return tools.map((tool) => ({
		type: "function",
		name: tool.function.name,
		description: tool.function.description,
		parameters: tool.function.parameters,
	}));
}

/** Extract a human message from either error envelope the gateway emits. */
function errorMessageFromBody(bodyText: string, status: number): string {
	try {
		const parsed = JSON.parse(bodyText) as
			| { error?: { message?: unknown } | undefined }
			| { type?: unknown; error?: { message?: unknown } | undefined };
		const message = (parsed as { error?: { message?: unknown } }).error?.message;
		if (typeof message === "string" && message.length > 0) return message.slice(0, 200);
	} catch {
		// Not JSON — fall through to the status form.
	}
	return `HTTP ${status}`;
}

interface FunctionCallBuffer {
	callId: string;
	name: string;
	arguments: string;
}

/**
 * Execute one streamed Responses turn. Same contract as `streamTurn`:
 * stages everything, commits nothing; caller decides. NEVER logs content.
 */
export async function streamResponsesTurn(request: ResponsesTurnRequest): Promise<TurnOutcome> {
	const startedAt = Date.now();
	const url = `${request.baseUrl.replace(/\/$/, "")}/responses`;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		"User-Agent": PI_SWARM_USER_AGENT,
	};
	if (request.apiKey) headers.Authorization = `Bearer ${request.apiKey}`;
	if (request.sessionIdHeader && request.sessionId) headers[request.sessionIdHeader] = request.sessionId;

	const bodyPayload: Record<string, unknown> = {
		model: request.modelId,
		input: request.rawInput ?? toResponseInput(request.messages),
		stream: true,
	};
	if (request.maxTokens) bodyPayload.max_output_tokens = request.maxTokens;
	if (request.tools && request.tools.length > 0) bodyPayload.tools = toResponseTools(request.tools);

	const egressAttr = request.egress !== undefined
		? { proxyId: request.egress.proxyId, ...(request.egress.country !== undefined ? { country: request.egress.country } : {}) }
		: undefined;
	const egressOption = egressAttr ? { egress: egressAttr } : {};

	let response: Response;
	try {
		response = await fetchWithTimeout(url, {
			method: "POST",
			headers,
			body: JSON.stringify(bodyPayload),
			signal: request.signal,
			...(request.dispatcher !== undefined ? { dispatcher: request.dispatcher } : {}),
		}, 120_000);
	} catch (error) {
		const latencyMs = Date.now() - startedAt;
		const emptyQuota: HeaderParseResult = { quotas: [], drift: false };
		if (request.signal?.aborted === true) {
			return { ok: false, status: undefined, errorMessage: "aborted", quota: emptyQuota, latencyMs, ...egressOption };
		}
		return {
			ok: false,
			status: undefined,
			errorMessage: error instanceof Error ? error.message : String(error),
			quota: emptyQuota,
			latencyMs,
			...(request.dispatcher !== undefined ? { proxyError: true } : {}),
			...egressOption,
		};
	}

	const headerNames: string[] = [];
	response.headers.forEach((_value, name) => headerNames.push(name));
	_logger.debug("wire", {
		provider: new URL(url).host,
		model: request.modelId,
		headerNames,
		protocol: "responses",
		...(request.egress !== undefined ? { egress: request.egress.proxyId, egressCountry: request.egress.country ?? null } : {}),
	});

	const accountId = new URL(url).host;
	const quota = extractQuotaHeaders(Object.fromEntries(response.headers.entries()), accountId);

	if (!response.ok) {
		const latencyMs = Date.now() - startedAt;
		const bodyText = await response.text().catch(() => "");
		return {
			ok: false,
			status: response.status,
			errorMessage: errorMessageFromBody(bodyText, response.status),
			quota,
			latencyMs,
			...(response.status === 407 ? { proxyError: true } : {}),
			...egressOption,
		};
	}
	if (!response.body) {
		return { ok: false, status: response.status, errorMessage: "empty body", quota, latencyMs: Date.now() - startedAt, ...egressOption };
	}

	let content = "";
	const callBuffers = new Map<number, FunctionCallBuffer>();
	const finishedCalls: Array<{ id: string; name: string; arguments: string }> = [];
	let usage: TurnUsage | undefined;
	let sawCompleted = false;
	let failedMessage: string | undefined;
	let firstTokenAt: number | undefined;
	let lastTokenAt: number | undefined;

	const bufferFor = (outputIndex: number): FunctionCallBuffer => {
		let buffer = callBuffers.get(outputIndex);
		if (!buffer) {
			buffer = { callId: "", name: "", arguments: "" };
			callBuffers.set(outputIndex, buffer);
		}
		return buffer;
	};

	try {
		for await (const { event, data } of sseEvents(response.body)) {
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(data) as Record<string, unknown>;
			} catch {
				continue;
			}
			if (event === "response.output_text.delta") {
				const delta = parsed["delta"];
				if (typeof delta === "string" && delta.length > 0) {
					content += delta;
					const now = Date.now();
					firstTokenAt ??= now;
					lastTokenAt = now;
				}
			} else if (event === "response.output_item.added") {
				const item = parsed["item"] as Record<string, unknown> | undefined;
				if (item?.["type"] === "function_call") {
					const buffer = bufferFor(typeof parsed["output_index"] === "number" ? (parsed["output_index"] as number) : 0);
					if (typeof item["call_id"] === "string") buffer.callId = item["call_id"] as string;
					if (typeof item["name"] === "string") buffer.name = item["name"] as string;
				}
			} else if (event === "response.function_call_arguments.delta") {
				const delta = parsed["delta"];
				if (typeof delta === "string") {
					bufferFor(typeof parsed["output_index"] === "number" ? (parsed["output_index"] as number) : 0).arguments += delta;
				}
			} else if (event === "response.output_item.done") {
				const item = parsed["item"] as Record<string, unknown> | undefined;
				if (item?.["type"] === "function_call") {
					const index = typeof parsed["output_index"] === "number" ? (parsed["output_index"] as number) : 0;
					const buffer = bufferFor(index);
					const callId = (typeof item["call_id"] === "string" && (item["call_id"] as string)) || buffer.callId || (typeof item["id"] === "string" ? (item["id"] as string) : "") || `call_${index}`;
					const name = (typeof item["name"] === "string" && (item["name"] as string)) || buffer.name;
					const args = (typeof item["arguments"] === "string" && (item["arguments"] as string)) || buffer.arguments;
					if (name) finishedCalls.push({ id: callId, name, arguments: args });
					callBuffers.delete(index);
				} else if (item?.["type"] === "message" && content.length === 0) {
					// Fallback: some gateways send full text only in the done item.
					const parts = item["content"];
					if (Array.isArray(parts)) {
						for (const part of parts) {
							const text = (part as Record<string, unknown>)["text"];
							if (typeof text === "string") content += text;
						}
					}
				}
			} else if (event === "response.completed") {
				sawCompleted = true;
				const inner = parsed["response"] as Record<string, unknown> | undefined;
				const rawUsage = inner?.["usage"] as Record<string, unknown> | undefined;
				if (rawUsage) {
					const prompt = typeof rawUsage["input_tokens"] === "number" ? (rawUsage["input_tokens"] as number) : 0;
					const completion = typeof rawUsage["output_tokens"] === "number" ? (rawUsage["output_tokens"] as number) : 0;
					const total = typeof rawUsage["total_tokens"] === "number"
						? (rawUsage["total_tokens"] as number)
						: prompt + completion;
					usage = { promptTokens: prompt, completionTokens: completion, totalTokens: total };
					if (completion > 0) {
						const now = Date.now();
						firstTokenAt ??= now;
						lastTokenAt = now;
					}
				}
			} else if (event === "response.failed" || event === "response.incomplete") {
				const inner = parsed["response"] as Record<string, unknown> | undefined;
				const error = inner?.["error"] as Record<string, unknown> | undefined;
				const message = error?.["message"];
				failedMessage = typeof message === "string" && message.length > 0 ? message.slice(0, 200) : `response ${event}`;
				if (event === "response.incomplete") sawCompleted = true; // truncated but valid partial
			} else if (event === "error") {
				const message = parsed["message"];
				failedMessage = typeof message === "string" && message.length > 0 ? message.slice(0, 200) : "stream error event";
			}
		}
	} catch (error) {
		return {
			ok: false,
			status: undefined,
			errorMessage: error instanceof Error ? error.message : String(error),
			quota,
			latencyMs: Date.now() - startedAt,
			...(request.dispatcher !== undefined ? { proxyError: true } : {}),
			...egressOption,
		};
	}

	const latencyMs = Date.now() - startedAt;
	if (failedMessage !== undefined && !sawCompleted) {
		return { ok: false, status: undefined, errorMessage: failedMessage, quota, latencyMs, ...egressOption };
	}
	if (!sawCompleted && request.signal?.aborted !== true) {
		return { ok: false, status: undefined, errorMessage: "stream ended before finish", quota, latencyMs, ...egressOption };
	}
	// Flush any argument buffers whose done item never arrived.
	for (const [index, buffer] of callBuffers) {
		if (buffer.name) finishedCalls.push({ id: buffer.callId || `call_${index}`, name: buffer.name, arguments: buffer.arguments });
	}

	const toolCalls = finishedCalls.filter((call) => call.id && call.name);
	const message: ChatMessage = {
		role: "assistant",
		content: content.length > 0 ? content : null,
		tool_calls: toolCalls.length > 0
			? toolCalls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } }))
			: undefined,
	};

	const streamWindowMs = firstTokenAt !== undefined && lastTokenAt !== undefined ? lastTokenAt - firstTokenAt : 0;
	const completionTokens = usage?.completionTokens ?? 0;
	const rawRate = completionTokens > 0 && streamWindowMs >= MIN_STREAM_WINDOW_MS ? (completionTokens / streamWindowMs) * 1000 : undefined;
	const tokensPerSecond = rawRate !== undefined && rawRate <= MAX_PLAUSIBLE_TOKENS_PER_SECOND ? Math.round(rawRate) : undefined;
	const timing: TurnTiming = {
		latencyMs,
		ttftMs: firstTokenAt !== undefined ? firstTokenAt - startedAt : undefined,
		tokensPerSecond,
	};

	return { ok: true, message, content, toolCalls, usage, quota, latencyMs, timing, ...egressOption };
}
