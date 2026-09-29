/**
 * Reliability benchmark: what does the swarm actually DELIVER, end to end,
 * against real providers?
 *
 * Every other harness here measures the scheduler (turns/sec, latency
 * percentiles) against a fake provider. None of them answer the question that
 * actually matters in production: of the tasks you hand the swarm, how many
 * come back with a correct answer, how long does it take, and which backend
 * earned the credit?
 *
 * This measures exactly that:
 *   - per-task PASS/FAIL judged by a caller's own oracle (not by HTTP status)
 *   - time-to-completion distribution
 *   - attribution of every served turn to an account and model
 *   - failure reasons, so the remaining failures can be located
 *
 * Attribution is read from the agent's own `model.changed` events, so no extra
 * bookkeeping is required of the caller.
 */

import { createLogger } from "./logger.ts";
import type { SwarmService } from "./swarm.ts";
import type { AgentState } from "./agent.ts";
import type { TierHint } from "./types.ts";

const _logger = createLogger("reliability");

export interface BenchTask {
	/** Short label for the report. */
	name: string;
	/** The task prompt. */
	task: string;
	/**
	 * Judges the final answer. Return `true` for a pass. Runs in-process on
	 * the model's final content, so keep it cheap and deterministic.
	 */
	expect?: (finalContent: string) => boolean;
	tierHint?: TierHint | undefined;
	system?: string | undefined;
	capabilities?: Array<"text" | "vision" | "tools"> | undefined;
}

export interface TaskOutcome {
	name: string;
	agentId: string;
	passed: boolean;
	/** False when the task produced no final content to judge. */
	judged: boolean;
	state: AgentState | string;
	failReason?: string | undefined;
	durationMs: number;
	/** Accounts that served a turn, in order, with their model. */
	served: Array<{ account: string; model: string; latencyMs?: number | undefined; reroute?: string | undefined }>;
	reroutes: number;
}

export interface AccountAttribution {
	accountId: string;
	turnsServed: number;
	tasksServed: number;
	medianLatencyMs: number;
}

export interface ReliabilityReport {
	tasks: number;
	passed: number;
	failed: number;
	/** Fraction of tasks that produced a passing answer (0..1). */
	passRate: number;
	wallMs: number;
	concurrency: number;
	/** Duration percentiles across all tasks (ms). */
	durationMs: { p50: number; p95: number; max: number };
	/** Wall-clock time per task when run at this concurrency. */
	throughputPerMinute: number;
	byAccount: AccountAttribution[];
	byModel: Array<{ model: string; turnsServed: number; medianLatencyMs: number }>;
	/** Distinct accounts that served at least one turn. */
	accountsUsed: number;
	reroutes: number;
	/** Failure reason → count. Empty when everything passed. */
	failures: Record<string, number>;
	outcomes: TaskOutcome[];
}

export interface ReliabilityOptions {
	/** Max tasks in flight at once. */
	concurrency?: number | undefined;
	/** Per-task wall-clock ceiling. */
	taskTimeoutMs?: number | undefined;
	/** Provider attempts per turn for benchmark tasks (free tiers churn). */
	maxProviderAttemptsPerTurn?: number | undefined;
	maxTurns?: number | undefined;
	/** Injectable clock, for deterministic tests. */
	now?: (() => number) | undefined;
	pollMs?: number | undefined;
}

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[index] ?? 0;
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
	return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Read a task's routing attribution from its own event history. */
function servedTurns(service: SwarmService, agentId: string): TaskOutcome["served"] {
	return service.eventBus
		.historyFor(agentId)
		.filter((event) => event.type === "model.changed")
		.map((event) => {
			const data = event.data ?? {};
			return {
				account: String(data["account"] ?? "unknown"),
				model: String(data["model"] ?? "unknown"),
				...(typeof data["latencyMs"] === "number" ? { latencyMs: data["latencyMs"] } : {}),
				...(typeof data["reroutedFrom"] === "string" ? { reroute: data["reroutedFrom"] } : {}),
			};
		});
}

/**
 * Run the task set through the swarm and report what was delivered.
 *
 * Concurrency is a first-class knob: a swarm that succeeds serially and fails
 * at concurrency 8 has a capacity problem, not a quality problem, and only a
 * concurrent run reveals that.
 */
export async function runReliability(
	service: SwarmService,
	tasks: ReadonlyArray<BenchTask>,
	options: ReliabilityOptions = {},
): Promise<ReliabilityReport> {
	if (tasks.length === 0) throw new Error("reliability run needs at least one task");
	const now = options.now ?? Date.now;
	const pollMs = options.pollMs ?? 100;
	const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, tasks.length));
	const taskTimeoutMs = options.taskTimeoutMs ?? 120_000;
	const startedAt = now();

	const runOne = async (benchTask: BenchTask): Promise<TaskOutcome> => {
		const begin = now();
		let agentId: string;
		try {
			agentId = service.spawnAgent({
				spec: {
					task: benchTask.task,
					...(benchTask.system !== undefined ? { system: benchTask.system } : {}),
					...(benchTask.tierHint !== undefined ? { tierHint: benchTask.tierHint } : {}),
					capabilities: benchTask.capabilities ?? ["text"],
					maxTurns: options.maxTurns ?? 3,
					maxWallTimeMs: taskTimeoutMs,
					maxProviderAttemptsPerTurn: options.maxProviderAttemptsPerTurn ?? 6,
					qualityFloor: null,
					allowUnknownQuality: true,
				},
				idempotencyKey: `bench:${benchTask.name}:${begin}`,
			}).agentId;
		} catch (error) {
			return {
				name: benchTask.name,
				agentId: "",
				passed: false,
				judged: false,
				state: "failed",
				failReason: error instanceof Error ? error.message : String(error),
				durationMs: now() - begin,
				served: [],
				reroutes: 0,
			};
		}

		const deadline = begin + taskTimeoutMs;
		for (;;) {
			const agent = service.getAgent(agentId);
			const state = agent?.state ?? "unknown";
			if (TERMINAL.has(state)) {
				const served = servedTurns(service, agentId);
				const finalContent = agent?.finalContent;
				// No content means there was nothing to judge: a completed
				// agent with an empty answer is a FAILURE, not a pass.
				const judged = state === "completed" && finalContent !== undefined && finalContent.length > 0;
				const passed = judged && (benchTask.expect === undefined ? true : benchTask.expect(finalContent as string));
				return {
					name: benchTask.name,
					agentId,
					passed,
					judged,
					state,
					...(agent?.failReason !== undefined ? { failReason: agent.failReason } : {}),
					durationMs: now() - begin,
					served,
					reroutes: served.filter((turn) => turn.reroute !== undefined).length,
				};
			}
			if (now() >= deadline) {
				service.cancelAgent(agentId);
				const served = servedTurns(service, agentId);
				return {
					name: benchTask.name,
					agentId,
					passed: false,
					judged: false,
					state: "cancelled",
					failReason: "benchmark_timeout",
					durationMs: now() - begin,
					served,
					reroutes: served.filter((turn) => turn.reroute !== undefined).length,
				};
			}
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
	};

	// Bounded concurrency: a swarm measured at unbounded fan-out measures its
	// own queueing, not the pool.
	const outcomes: TaskOutcome[] = [];
	let cursor = 0;
	const workers = Array.from({ length: concurrency }, async () => {
		for (;;) {
			const index = cursor++;
			if (index >= tasks.length) return;
			const benchTask = tasks[index] as BenchTask;
			outcomes.push(await runOne(benchTask));
		}
	});
	await Promise.all(workers);

	const wallMs = Math.max(1, now() - startedAt);
	const passed = outcomes.filter((outcome) => outcome.passed).length;
	const failures: Record<string, number> = {};
	for (const outcome of outcomes) {
		if (outcome.passed) continue;
		const reason = outcome.state === "completed" ? "wrong_answer" : (outcome.failReason ?? outcome.state);
		failures[reason] = (failures[reason] ?? 0) + 1;
	}

	const accountMap = new Map<string, { turns: number; tasks: Set<string>; latencies: number[] }>();
	const modelMap = new Map<string, { turns: number; latencies: number[] }>();
	let reroutes = 0;
	for (const outcome of outcomes) {
		for (const turn of outcome.served) {
			reroutes += turn.reroute !== undefined ? 1 : 0;
			const account = accountMap.get(turn.account) ?? { turns: 0, tasks: new Set<string>(), latencies: [] };
			account.turns += 1;
			account.tasks.add(outcome.name);
			if (turn.latencyMs !== undefined) account.latencies.push(turn.latencyMs);
			accountMap.set(turn.account, account);
			const model = modelMap.get(turn.model) ?? { turns: 0, latencies: [] };
			model.turns += 1;
			if (turn.latencyMs !== undefined) model.latencies.push(turn.latencyMs);
			modelMap.set(turn.model, model);
		}
	}

	const durations = [...outcomes].map((outcome) => outcome.durationMs).sort((a, b) => a - b);
	const report: ReliabilityReport = {
		tasks: tasks.length,
		passed,
		failed: tasks.length - passed,
		passRate: Number((passed / tasks.length).toFixed(3)),
		wallMs,
		concurrency,
		durationMs: {
			p50: percentile(durations, 50),
			p95: percentile(durations, 95),
			max: durations[durations.length - 1] ?? 0,
		},
		throughputPerMinute: Number(((tasks.length / wallMs) * 60_000).toFixed(1)),
		byAccount: [...accountMap.entries()]
			.map(([accountId, stats]) => ({
				accountId,
				turnsServed: stats.turns,
				tasksServed: stats.tasks.size,
				medianLatencyMs: Math.round(median(stats.latencies)),
			}))
			.sort((a, b) => b.turnsServed - a.turnsServed),
		byModel: [...modelMap.entries()]
			.map(([model, stats]) => ({ model, turnsServed: stats.turns, medianLatencyMs: Math.round(median(stats.latencies)) }))
			.sort((a, b) => b.turnsServed - a.turnsServed),
		accountsUsed: accountMap.size,
		reroutes,
		failures,
		outcomes,
	};
	_logger.info("reliability_complete", {
		tasks: report.tasks,
		passed: report.passed,
		passRate: report.passRate,
		accountsUsed: report.accountsUsed,
	});
	return report;
}
