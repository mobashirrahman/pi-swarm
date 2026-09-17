import { describe, expect, it, vi } from "vitest";
import { InMemoryToolJournal, PersistentToolJournal, toolExecutionId } from "../src/tool-journal.ts";
import { AgentStore } from "../src/store.ts";
import { ToolExecutor, evalArithmetic, registerBuiltinTools } from "../src/tools.ts";

const NO_SIGNAL = new AbortController().signal;

describe("tool journal: idempotency contract", () => {
	it("a completed execution replays its recorded result", async () => {
		const journal = new InMemoryToolJournal();
		let executions = 0;
		const executor = new ToolExecutor({ journal });
		executor.register("counter", {
			description: "counts executions",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				executions += 1;
				return JSON.stringify({ n: executions });
			},
		});

		const first = await executor.execute("a1", 0, "call-1", "counter", "{}", NO_SIGNAL);
		const second = await executor.execute("a1", 0, "call-1", "counter", "{}", NO_SIGNAL);
		expect(JSON.parse(first)).toEqual({ n: 1 });
		expect(second).toBe(first);
		expect(executions).toBe(1); // side effect ran exactly once
	});

	it("an uncertain (crashed mid-flight) entry refuses to re-run", async () => {
		const journal = new InMemoryToolJournal();
		let executions = 0;
		const executor = new ToolExecutor({ journal });
		executor.register("danger", {
			description: "side effect",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				executions += 1;
				return JSON.stringify({ ok: true });
			},
		});

		// Simulate a crash: begin() recorded, complete() never ran.
		journal.begin(toolExecutionId("a1", 0, "call-1"), "danger", "{}", Date.now());
		const result = await executor.execute("a1", 0, "call-1", "danger", "{}", NO_SIGNAL);
		expect(JSON.parse(result).error).toBe("uncertain_state");
		expect(executions).toBe(0); // never re-ran a possibly-executed side effect
	});

	it("distinct call ids on the same turn are independent", async () => {
		const journal = new InMemoryToolJournal();
		let executions = 0;
		const executor = new ToolExecutor({ journal });
		executor.register("t", {
			description: "t",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				executions += 1;
				return "ok";
			},
		});
		await executor.execute("a1", 0, "call-1", "t", "{}", NO_SIGNAL);
		await executor.execute("a1", 0, "call-2", "t", "{}", NO_SIGNAL);
		expect(executions).toBe(2);
	});

	it("a failed execution is not replayed (retry allowed)", async () => {
		const journal = new InMemoryToolJournal();
		let attempts = 0;
		const executor = new ToolExecutor({ journal });
		executor.register("flaky", {
			description: "fails once",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("boom");
				return JSON.stringify({ ok: true });
			},
		});
		const first = await executor.execute("a1", 0, "c", "flaky", "{}", NO_SIGNAL);
		expect(JSON.parse(first).error).toBe("tool_failed");
		const second = await executor.execute("a1", 0, "c", "flaky", "{}", NO_SIGNAL);
		expect(JSON.parse(second)).toEqual({ ok: true });
		expect(attempts).toBe(2);
	});
	it("atomically refuses a concurrent duplicate side effect", async () => {
		const journal = new InMemoryToolJournal();
		const executor = new ToolExecutor({ journal });
		let executions = 0;
		const gate = Promise.withResolvers<string>();
		executor.register("side_effect", {
			description: "side effect",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				executions += 1;
				return gate.promise;
			},
		});

		const first = executor.execute("a1", 0, "same-call", "side_effect", "{}", NO_SIGNAL);
		await Promise.resolve();
		const second = await executor.execute("a1", 0, "same-call", "side_effect", "{}", NO_SIGNAL);
		expect(JSON.parse(second).error).toBe("uncertain_state");
		gate.resolve("committed");
		expect(await first).toBe("committed");
		expect(executions).toBe(1);
	});
});

describe("tool executor: error and cancellation semantics", () => {
	it("tool errors become agent-visible content, not provider failures", async () => {
		const executor = new ToolExecutor();
		executor.register("bad", {
			description: "throws",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				throw new Error("disk on fire");
			},
		});
		const result = await executor.execute("a1", 0, "c", "bad", "{}", NO_SIGNAL);
		const parsed = JSON.parse(result);
		expect(parsed.error).toBe("tool_failed");
		expect(parsed.detail).toContain("disk on fire");
	});

	it("unknown tools return an error instead of throwing", async () => {
		const executor = new ToolExecutor();
		const result = await executor.execute("a1", 0, "c", "nope", "{}", NO_SIGNAL);
		expect(JSON.parse(result).error).toBe("unknown_tool");
	});

	it("invalid JSON arguments return an error", async () => {
		const executor = new ToolExecutor();
		registerBuiltinTools(executor);
		const result = await executor.execute("a1", 0, "c", "calculator", "{not json", NO_SIGNAL);
		expect(JSON.parse(result).error).toBe("invalid_arguments");
	});

	it("an aborted agent signal yields a cancelled result without a strike", async () => {
		const controller = new AbortController();
		const executor = new ToolExecutor();
		executor.register("slow", {
			description: "waits",
			parameters: { type: "object", properties: {} },
			execute: async (_args, ctx) => {
				controller.abort();
				// A well-behaved tool observes its signal.
				if (ctx.signal.aborted) throw new Error("aborted");
				return "should not reach";
			},
		});
		const result = await executor.execute("a1", 0, "c", "slow", "{}", controller.signal);
		expect(JSON.parse(result).error).toBe("cancelled");
	});

	it("enforces the per-call timeout", async () => {
		vi.useFakeTimers();
		try {
			const executor = new ToolExecutor({ timeoutMs: 30 });
			executor.register("hang", {
				description: "hangs until aborted",
				parameters: { type: "object", properties: {} },
				execute: async (_args, ctx) => {
					// Rejects only when the executor's timeout aborts the call.
					const { promise, reject } = Promise.withResolvers<string>();
					ctx.signal.addEventListener("abort", () => reject(new Error("aborted by timeout")), { once: true });
					return promise;
				},
			});
			const pending = executor.execute("a1", 0, "c", "hang", "{}", NO_SIGNAL);
			await vi.advanceTimersByTimeAsync(31);
			const result = await pending;
			expect(JSON.parse(result).error).toBe("tool_failed");
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("builtin tools", () => {
	it("calculator evaluates arithmetic and rejects injection", async () => {
		expect(evalArithmetic("2+2")).toBe(4);
		expect(evalArithmetic("(3*4)+1")).toBe(13);
		expect(() => evalArithmetic("process.exit(1)")).toThrow();
		expect(() => evalArithmetic("require('fs')")).toThrow();
	});

	it("calculator is exposed as a wire spec", () => {
		const executor = new ToolExecutor();
		registerBuiltinTools(executor);
		const names = executor.specs().map((spec) => spec.function.name);
		expect(names).toContain("calculator");
		expect(names).toContain("echo");
		expect(names).toContain("fetch_text");
	});
});

describe("persistent journal adapter", () => {
	it("maps a running row to uncertain and passes through completed results", () => {
		const rows = new Map<string, { status: "running" | "completed" | "failed"; resultJson?: string | undefined }>();
		const store = {
			toolBegin: (id: string) => {
				if (rows.has(id)) return false;
				rows.set(id, { status: "running" });
				return true;
			},
			toolComplete: (id: string, resultJson: string) => {
				rows.set(id, { status: "completed", resultJson });
			},
			toolFail: (id: string) => {
				rows.set(id, { status: "failed" });
			},
			toolLookup: (id: string) => rows.get(id),
		};
		const journal = new PersistentToolJournal(store);
		journal.begin("a:0:c", "t", "{}", 1);
		expect(journal.lookup("a:0:c")?.status).toBe("uncertain");
		journal.complete("a:0:c", JSON.stringify({ ok: true }), 2);
		expect(journal.lookup("a:0:c")).toEqual({ status: "completed", resultJson: JSON.stringify({ ok: true }) });
	});

	it("begin() does not clobber a completed record", () => {
		const rows = new Map<string, { status: "running" | "completed" | "failed"; resultJson?: string | undefined }>();
		const store = {
			toolBegin: (id: string) => {
				if (rows.has(id)) return false;
				rows.set(id, { status: "running" });
				return true;
			},
			toolComplete: (id: string, resultJson: string) => {
				rows.set(id, { status: "completed", resultJson });
			},
			toolFail: (id: string) => {
				rows.set(id, { status: "failed" });
			},
			toolLookup: (id: string) => rows.get(id),
		};
		const journal = new PersistentToolJournal(store);
		journal.begin("a:0:c", "t", "{}", 1);
		journal.complete("a:0:c", "result", 2);
		journal.begin("a:0:c", "t", "{}", 3);
		expect(journal.lookup("a:0:c")?.status).toBe("completed");
	});
	it("SQLite journal claims a duplicate side effect across executor instances", async () => {
		const store = new AgentStore(":memory:");
		try {
			const gate = Promise.withResolvers<string>();
			let executions = 0;
			const first = new ToolExecutor({ journal: new PersistentToolJournal(store) });
			const second = new ToolExecutor({ journal: new PersistentToolJournal(store) });
			const implementation = {
				description: "side effect",
				parameters: { type: "object", properties: {} },
				execute: async () => {
					executions += 1;
					return gate.promise;
				},
			};
			first.register("side_effect", implementation);
			second.register("side_effect", implementation);

			const pending = first.execute("a1", 0, "shared", "side_effect", "{}", NO_SIGNAL);
			await Promise.resolve();
			const duplicate = await second.execute("a1", 0, "shared", "side_effect", "{}", NO_SIGNAL);
			expect(JSON.parse(duplicate).error).toBe("uncertain_state");
			gate.resolve("committed");
			expect(await pending).toBe("committed");
			expect(executions).toBe(1);
		} finally {
			store.close();
		}
	});
	it("persists failed tool outcomes without a missing-column error", async () => {
		const store = new AgentStore(":memory:");
		try {
			const executor = new ToolExecutor({ journal: new PersistentToolJournal(store) });
			executor.register("fails", {
				description: "fails",
				parameters: { type: "object", properties: {} },
				execute: async () => { throw new Error("expected"); },
			});
			const result = await executor.execute("a1", 0, "failed", "fails", "{}", NO_SIGNAL);
			expect(JSON.parse(result).error).toBe("tool_failed");
			expect(store.toolLookup("a1:0:failed")?.status).toBe("failed");
		} finally {
			store.close();
		}
	});
});