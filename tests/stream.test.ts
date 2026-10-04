import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { streamTurn } from "../src/stream.ts";

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

afterEach(async () => {
	if (!server) return;
	const active = server;
	server = undefined;
	await new Promise<void>((resolve) => active.close(() => resolve()));
});

describe("stream SSE framing", () => {
	it("accepts data without a space and flushes a final frame without newline", async () => {
		const content = JSON.stringify({ choices: [{ delta: { content: "hello" } }] });
		const finish = JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] });
		const baseUrl = await startProvider([
			Buffer.from(`data:${content}\n\n`),
			Buffer.from(`data:${finish}`),
		]);

		const result = await streamTurn({ baseUrl, modelId: "mock", messages: [{ role: "user", content: "hi" }] });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.content).toBe("hello");
			expect(result.message.content).toBe("hello");
		}
	});

	it("joins multiline data fields and flushes split UTF-8 bytes", async () => {
		const content = JSON.stringify({ choices: [{ delta: { content: "multi 🌊" } }] });
		const splitAt = content.indexOf("{\"delta\"");
		expect(splitAt).toBeGreaterThan(0);
		const first = Buffer.from(`data: ${content.slice(0, splitAt)}\n`);
		const second = Buffer.from(`data:${content.slice(splitAt)}\n\n`);
		const finish = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`);
		const emoji = Buffer.from("🙂");
		const splitEmoji = [emoji.subarray(0, 2), emoji.subarray(2)];
		const baseUrl = await startProvider([
			first,
			second,
			Buffer.from("data: {\"choices\":[{\"delta\":{\"content\":\""),
			splitEmoji[0]!,
			splitEmoji[1]!,
			Buffer.from("\"}}]}\n\n"),
			finish,
		]);

		const result = await streamTurn({ baseUrl, modelId: "mock", messages: [{ role: "user", content: "hi" }] });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.content).toBe("multi 🌊🙂");
	});

	it("sends the client user agent and the provider session header", async () => {
		const seen: Record<string, string | undefined> = {};
		const capturing = createServer((req, res) => {
			seen["user-agent"] = req.headers["user-agent"];
			seen["x-opencode-session"] = req.headers["x-opencode-session"] as string | undefined;
			res.writeHead(200, { "Content-Type": "text/event-stream" });
			res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
		});
		const baseUrl = await new Promise<string>((resolve) => {
			capturing.listen(0, "127.0.0.1", () => {
				const address = capturing.address();
				const port = typeof address === "object" && address ? address.port : 0;
				resolve(`http://127.0.0.1:${port}/v1`);
			});
		});
		try {
			// Empty content with finish: the outcome shape is irrelevant,
			// only that the request (and its headers) arrived.
			await streamTurn({
				baseUrl,
				modelId: "mock",
				messages: [{ role: "user", content: "hi" }],
				sessionIdHeader: "x-opencode-session",
				sessionId: "agent-7",
			});
			expect(seen["user-agent"]).toMatch(/^pi-swarm\//);
			expect(seen["x-opencode-session"]).toBe("agent-7");
		} finally {
			await new Promise<void>((resolve) => capturing.close(() => resolve()));
		}
	});
});
