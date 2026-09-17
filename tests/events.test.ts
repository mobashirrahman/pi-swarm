import { describe, expect, it } from "vitest";
import { EventBus } from "../src/events.ts";
import type { AgentEvent } from "../src/events.ts";

describe("event bus", () => {
	it("assigns monotonic sequence numbers and preserves order", () => {
		const bus = new EventBus();
		const first = bus.emit("a", "agent.queued");
		const second = bus.emit("a", "agent.started");
		const third = bus.emit("a", "agent.completed");
		expect([first.seq, second.seq, third.seq]).toEqual([first.seq, second.seq, third.seq]);
		expect(second.seq).toBeGreaterThan(first.seq);
		expect(third.seq).toBeGreaterThan(second.seq);
		expect(bus.historyFor("a").map((event) => event.type)).toEqual(["agent.queued", "agent.started", "agent.completed"]);
	});

	it("keeps agents isolated from each other", () => {
		const bus = new EventBus();
		bus.emit("a", "agent.queued");
		bus.emit("b", "agent.queued");
		expect(bus.historyFor("a")).toHaveLength(1);
		expect(bus.historyFor("b")).toHaveLength(1);
		expect(bus.historyFor("c")).toHaveLength(0);
	});

	it("delivers live events to subscribers and stops after unsubscribe", () => {
		const bus = new EventBus();
		const seen: AgentEvent[] = [];
		const subscription = bus.subscribe("a", (event) => seen.push(event));
		bus.emit("a", "agent.queued");
		bus.emit("a", "turn.committed");
		subscription.unsubscribe();
		bus.emit("a", "agent.completed");
		expect(seen.map((event) => event.type)).toEqual(["agent.queued", "turn.committed"]);
		expect(bus.subscriberCount("a")).toBe(0);
	});

	it("a throwing subscriber cannot break the emitting path", () => {
		const bus = new EventBus();
		const seen: string[] = [];
		bus.subscribe("a", () => {
			throw new Error("consumer exploded");
		});
		bus.subscribe("a", (event) => seen.push(event.type));
		expect(() => bus.emit("a", "agent.started")).not.toThrow();
		expect(seen).toEqual(["agent.started"]);
	});

	it("eventsSince supports SSE resume by sequence", () => {
		const bus = new EventBus();
		const first = bus.emit("a", "agent.queued");
		bus.emit("a", "agent.started");
		const third = bus.emit("a", "turn.committed");
		const resumed = bus.eventsSince("a", first.seq);
		expect(resumed.map((event) => event.type)).toEqual(["agent.started", "turn.committed"]);
		expect(bus.eventsSince("a", third.seq)).toEqual([]);
	});

	it("bounds history per agent (ring) without dropping recent events", () => {
		const bus = new EventBus();
		for (let i = 0; i < 250; i++) bus.emit("a", "agent.state", { i });
		const history = bus.historyFor("a");
		expect(history).toHaveLength(200);
		// The newest event survived; the oldest were evicted.
		expect(history[history.length - 1]?.data?.["i"]).toBe(249);
		expect(history[0]?.data?.["i"]).toBe(50);
	});

	it("forget() drops history and listeners", () => {
		const bus = new EventBus();
		bus.subscribe("a", () => undefined);
		bus.emit("a", "agent.queued");
		bus.forget("a");
		expect(bus.historyFor("a")).toHaveLength(0);
		expect(bus.subscriberCount("a")).toBe(0);
	});
});