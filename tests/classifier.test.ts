import { describe, expect, it } from "vitest";
import { classifyAbort, classifyErrorMessage, classifyFailure, classifyStatus } from "../src/classifier.ts";

describe("classifier (ported from pi-free auto-fallback)", () => {
	it("maps quota statuses to recoverable", () => {
		expect(classifyStatus(429)).toEqual({ kind: "recoverable", cls: "quota" });
		expect(classifyStatus(402)).toEqual({ kind: "recoverable", cls: "quota" });
	});

	it("maps auth/policy/legal/model-gone to unrecoverable", () => {
		expect(classifyStatus(401).cls).toBe("auth");
		expect(classifyStatus(403).cls).toBe("policy");
		expect(classifyStatus(451).cls).toBe("policy");
		expect(classifyStatus(404).cls).toBe("model_gone");
		expect(classifyStatus(400).cls).toBe("bad_request");
	});

	it("maps server errors to recoverable", () => {
		expect(classifyStatus(500).cls).toBe("server");
		expect(classifyStatus(529).cls).toBe("server");
	});

	it("treats unknown statuses as recoverable-by-default", () => {
		expect(classifyStatus(599).kind).toBe("unknown");
	});

	it("classifies provider-limit message text as recoverable", () => {
		expect(classifyErrorMessage("usage limit error: monthly cap reached")).toBe("recoverable");
		expect(classifyErrorMessage("insufficient_quota for this key")).toBe("recoverable");
	});

	it("classifies fatal message text as unrecoverable", () => {
		expect(classifyErrorMessage("invalid api key supplied")).toBe("unrecoverable");
		expect(classifyErrorMessage("context_length_exceeded")).toBe("unrecoverable");
	});

	it("classifies transient text as recoverable", () => {
		expect(classifyErrorMessage("socket hang up")).toBe("recoverable");
		expect(classifyErrorMessage("ETIMEDOUT")).toBe("recoverable"); // timeout pattern
	});

	it("status wins over message; message fills network gaps", () => {
		// 402 + fatal text → status decides (quota/recoverable).
		expect(classifyFailure(402, "invalid api key").cls).toBe("quota");
		// No status + transient text → recoverable server.
		expect(classifyFailure(undefined, "fetch failed").cls).toBe("server");
		// No status, unknown message → default recoverable.
		expect(classifyFailure(undefined, "mystery").cls).toBe("server");
	});

	it("abort refinement: 5xx-ish abort is a strike, clean abort is not", () => {
		expect(classifyAbort(503)).toBe("recoverable");
		expect(classifyAbort(undefined)).toBeNull();
		expect(classifyAbort(200)).toBeNull();
	});
});
