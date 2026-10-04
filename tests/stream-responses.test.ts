import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { streamResponsesTurn } from "../src/stream-responses.ts";

let server: Server | undefined;

function startProvider(chunks: Buffer[]): Promise<string> {
	server = createServer((_req, res) => {
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		for (const chunk of chunks) res.write(chunk);
		res.end();
	});
	return new Promise((resolve) => {
		server?.listen(0, "127.0.0.1", () => {
			const address = server?.address();
			const port = typeof address === "object" && address ? address.port : 0;
			resolve(`http://127.0.0.1:${port}/v1`);
		});
	});
}

function line(event: string, payload: unknown): Buffer {
	return Buffer.from(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

afterEach(async () => {
	if (!server) return;
	const active = server;
	server = undefined;
	await new Promise<void>((resolve) => active.close(() => resolve()));
});

describe("stream-responses SSE driver", () => {
	it("streams output_text deltas and maps usage", async () => {
		const baseUrl = await startProvider([
			line("response.created", { type: "response.created", response: {} }),
			line("response.output_text.delta", { type: "response.output_text.delta", delta: "ok" }),
			line("response.output_text.delta", { type: "response.output_text.delta", delta: "!" }),
			line("response.completed", { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } }),
		]);
		const result = await streamResponsesTurn({ baseUrl, modelId: "mock", messages: [{ role: "user", content: "hi" }] });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.content).toBe("ok!");
			expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
		}
	});

	it("parses function_call items into toolCalls", async () => {
		const baseUrl = await startProvider([
			line("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "echo" } }),
			line("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"x\":1}" }),
			line("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_1", name: "echo", arguments: "{\"x\":1}" } }),
			line("response.completed", { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }),
		]);
		const result = await streamResponsesTurn({ baseUrl, modelId: "mock", messages: [{ role: "user", content: "hi" }] });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.toolCalls).toEqual([{ id: "call_1", name: "echo", arguments: "{\"x\":1}" }]);
			expect(result.message.tool_calls?.[0]?.function.name).toBe("echo");
		}
	});

	it("surfaces upstream error bodies on non-ok statuses", async () => {
		server = createServer((_req, res) => {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { message: "Model does not support this protocol." } }));
		});
		const baseUrl = await new Promise<string>((resolve) => {
			server?.listen(0, "127.0.0.1", () => {
				const address = server?.address();
				const port = typeof address === "object" && address ? address.port : 0;
				resolve(`http://127.0.0.1:${port}/v1`);
			});
		});
		const result = await streamResponsesTurn({ baseUrl, modelId: "mock", messages: [{ role: "user", content: "hi" }] });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(400);
			expect(result.errorMessage).toContain("Model does not support this protocol.");
		}
	});

	it("sends the request body and headers Go requires", async () => {
		let seenBody = "";
		const headers: Record<string, string | undefined> = {};
		server = createServer((req, res) => {
			headers["user-agent"] = req.headers["user-agent"];
			headers["x-opencode-session"] = req.headers["x-opencode-session"] as string | undefined;
			headers["authorization"] = req.headers["authorization"];
			let body = "";
			req.on("data", (chunk) => { body += chunk; });
			req.on("end", () => {
				seenBody = body;
				res.writeHead(200, { "Content-Type": "text/event-stream" });
				res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`);
			});
		});
		const baseUrl = await new Promise<string>((resolve) => {
			server?.listen(0, "127.0.0.1", () => {
				const address = server?.address();
				const port = typeof address === "object" && address ? address.port : 0;
				resolve(`http://127.0.0.1:${port}/v1`);
			});
		});
		await streamResponsesTurn({
			baseUrl,
			modelId: "mock",
			apiKey: "k",
			messages: [{ role: "user", content: "hi" }],
			tools: [{ type: "function", function: { name: "echo", description: "d", parameters: { type: "object" } } }],
			sessionIdHeader: "x-opencode-session",
			sessionId: "agent-9",
		});
		const payload = JSON.parse(seenBody) as { tools?: unknown; input?: unknown; stream?: boolean };
		expect(payload.stream).toBe(true);
		expect(Array.isArray(payload.tools)).toBe(true);
		const tool = (payload.tools as Array<Record<string, unknown>>)[0]!;
		expect(tool["type"]).toBe("function");
		expect(tool["name"]).toBe("echo");
		expect(headers["user-agent"]).toMatch(/^pi-swarm\//);
		expect(headers["x-opencode-session"]).toBe("agent-9");
		expect(headers["authorization"]).toBe("Bearer k");
	});
});
