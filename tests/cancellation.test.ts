import { describe, expect, it } from "vitest";
import { CancellationTree } from "../src/cancellation.ts";
import type { AgentRuntime } from "../src/agent.ts";

/** Minimal runtime double: records cancel() calls and exposes state. */
function fakeRuntime(id: string): AgentRuntime & { cancelCalls: number } {
	const runtime = {
		cancelCalls: 0,
		cancel(): void {
			runtime.cancelCalls += 1;
		},
		getState: () => "running" as const,
		getTranscript: () => [],
	};
	void id;
	return runtime as unknown as AgentRuntime & { cancelCalls: number };
}

describe("cancellation tree", () => {
	it("cancels children before the parent", () => {
		const tree = new CancellationTree();
		const parent = fakeRuntime("p");
		const child = fakeRuntime("c");
		tree.register("p", undefined, parent);
		tree.register("c", "p", child);

		const order = tree.cancelTree("p");
		expect(order).toEqual(["c", "p"]);
		expect(child.cancelCalls).toBe(1);
		expect(parent.cancelCalls).toBe(1);
	});

	it("cancels the whole descendant subtree, depth-first", () => {
		const tree = new CancellationTree();
		const root = fakeRuntime("root");
		const mid = fakeRuntime("mid");
		const leaf = fakeRuntime("leaf");
		const grandleaf = fakeRuntime("grandleaf");
		tree.register("root", undefined, root);
		tree.register("mid", "root", mid);
		tree.register("leaf", "mid", leaf);
		tree.register("grandleaf", "leaf", grandleaf);

		const order = tree.cancelTree("root");
		expect(new Set(order)).toEqual(new Set(["root", "mid", "leaf", "grandleaf"]));
		// Post-order: every node is cancelled AFTER its own descendants, and
		// the root last — so each child observed its abort before the parent's
		// terminal transition.
		expect(order).toEqual(["grandleaf", "leaf", "mid", "root"]);
	});

	it("cancelling a mid-node leaves the root alone", () => {
		const tree = new CancellationTree();
		const root = fakeRuntime("root");
		const mid = fakeRuntime("mid");
		const leaf = fakeRuntime("leaf");
		tree.register("root", undefined, root);
		tree.register("mid", "root", mid);
		tree.register("leaf", "mid", leaf);

		const order = tree.cancelTree("mid");
		expect(new Set(order)).toEqual(new Set(["mid", "leaf"]));
		expect(root.cancelCalls).toBe(0);
	});

	it("cancelling an unknown or already-finished agent is a no-op", () => {
		const tree = new CancellationTree();
		expect(tree.cancelTree("ghost")).toEqual([]);
		const done = fakeRuntime("done");
		tree.register("done", undefined, done);
		tree.unregister("done");
		expect(tree.cancelTree("done")).toEqual([]);
		expect(done.cancelCalls).toBe(0);
	});

	it("unregistering a parent orphans children without crashing", () => {
		const tree = new CancellationTree();
		const parent = fakeRuntime("p");
		const child = fakeRuntime("c");
		tree.register("p", undefined, parent);
		tree.register("c", "p", child);
		tree.unregister("p");
		expect(tree.cancelTree("p")).toEqual([]);
		expect(child.cancelCalls).toBe(0);
	});

	it("descendants() lists the live subtree only", () => {
		const tree = new CancellationTree();
		tree.register("a", undefined, fakeRuntime("a"));
		tree.register("b", "a", fakeRuntime("b"));
		tree.register("c", "b", fakeRuntime("c"));
		tree.register("x", undefined, fakeRuntime("x"));
		expect(new Set(tree.descendants("a"))).toEqual(new Set(["b", "c"]));
		expect(tree.descendants("x")).toEqual([]);
	});
});