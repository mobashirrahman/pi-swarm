import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { readBody, readJsonBody } from "../src/server.ts";

function requestFrom(chunks: string[]): IncomingMessage {
	return Readable.from(chunks.map((chunk) => Buffer.from(chunk, "utf8"))) as unknown as IncomingMessage;
}

async function errorFrom(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
		throw new Error("expected rejection");
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

describe("server request body parsing", () => {
	it("parses JSON objects", async () => {
		await expect(readJsonBody(requestFrom(['{"spec":{"task":"x"}}']))).resolves.toEqual({ spec: { task: "x" } });
	});

	it("treats an empty body as an empty object", async () => {
		await expect(readJsonBody(requestFrom(["   "]))).resolves.toEqual({});
	});

	it("rejects malformed JSON with a client error", async () => {
		const error = await errorFrom(readJsonBody(requestFrom(['{"spec":'])));
		expect(error.message).toContain("invalid JSON body");
	});

	it("rejects non-object JSON bodies", async () => {
		const error = await errorFrom(readJsonBody(requestFrom(["[]"])));
		expect(error.message).toContain("must be a JSON object");
	});

	it("rejects oversized request bodies", async () => {
		const tooLarge = "x".repeat(1_048_577);
		const error = await errorFrom(readBody(requestFrom([tooLarge])));
		expect(error.message).toContain("request body too large");
	});
});
