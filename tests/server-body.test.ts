import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { readBody, readJsonBody } from "../src/server.ts";

function requestFrom(chunks: string[]): IncomingMessage {
	return Readable.from(chunks.map((chunk) => Buffer.from(chunk, "utf8"))) as unknown as IncomingMessage;
}

describe("server request body parsing", () => {
	it("parses JSON objects", async () => {
		await expect(readJsonBody(requestFrom(['{"spec":{"task":"x"}}']))).resolves.toEqual({ spec: { task: "x" } });
	});

	it("treats an empty body as an empty object", async () => {
		await expect(readJsonBody(requestFrom(["   "]))).resolves.toEqual({});
	});

	it("rejects malformed JSON with a client error", async () => {
		const error = await readJsonBody(requestFrom(['{"spec":'])).catch((value) => value as Error);
		expect(error.message).toContain("invalid JSON body");
	});

	it("rejects non-object JSON bodies", async () => {
		const error = await readJsonBody(requestFrom(["[]"])).catch((value) => value as Error);
		expect(error.message).toContain("must be a JSON object");
	});

	it("rejects oversized request bodies", async () => {
		const tooLarge = "x".repeat(1_048_577);
		const error = await readBody(requestFrom([tooLarge])).catch((value) => value as Error);
		expect(error.message).toContain("request body too large");
	});
});
