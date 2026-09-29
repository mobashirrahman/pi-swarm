/**
 * Live reliability run: real providers, real credentials, real answers.
 *
 * The scheduler benchmark measures throughput against a fake provider. This
 * measures the only question that decides whether the product works: of the
 * tasks you hand the swarm, how many come back correct, how fast, and which
 * backend served them.
 *
 * Each task ships with a JUDGE (an exact string or a predicate) so a task
 * cannot pass by returning something plausible but wrong.
 *
 * Usage:
 *   npx tsx scripts/bench-reliability.ts [--tasks N] [--concurrency N] [--suite smoke|full]
 */

import { AgentStore } from "../src/store.ts";
import { SwarmService } from "../src/swarm.ts";
import { runReliability, type BenchTask } from "../src/reliability.ts";
import { loadConfiguredEnvFile } from "../src/env-file.ts";
import type { TierHint } from "../src/types.ts";

function flag(name: string, fallback: number): number {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1) return fallback;
	const value = Number.parseInt(process.argv[index + 1] ?? "", 10);
	return Number.isFinite(value) ? value : fallback;
}

const totalTasks = flag("tasks", 8);
const concurrency = flag("concurrency", 4);
const suite = (process.argv.includes("--suite") ? process.argv[process.argv.indexOf("--suite") + 1] : "smoke") ?? "smoke";

interface TaskTemplate {
	name: string;
	task: string;
	answer: string;
	tierHint?: TierHint;
}

/**
 * Exact-answer tasks. `expect` compares the normalized final content, so
 * "323" passes for `17*19` but "about 323" does not — a lenient judge would
 * make the whole benchmark meaningless.
 */
const TEMPLATES: TaskTemplate[] = [
	{ name: "multiply-17x19", task: "Compute 17 * 19. Reply with only the integer result and nothing else.", answer: "323" },
	{ name: "multiply-43x29", task: "Compute 43 * 29. Reply with only the integer result and nothing else.", answer: "1247" },
	{ name: "capital-france", task: "What is the capital city of France? Reply with only the city name.", answer: "paris" },
	{ name: "capital-japan", task: "What is the capital city of Japan? Reply with only the city name.", answer: "tokyo" },
	{ name: "largest-ocean", task: "Which is the largest ocean on Earth by surface area? Reply with only the name.", answer: "pacific" },
	{ name: "element-79", task: "What is the chemical symbol for gold? Reply with only the symbol.", answer: "au" },
	{ name: "prime-check-97", task: "Is 97 a prime number? Reply with only 'yes' or 'no'.", answer: "yes" },
	{ name: "word-count", task: "How many words are in this sentence: the quick brown fox jumps? Reply with only the number.", answer: "5" },
	{ name: "add-large", task: "Compute 12345 + 54321. Reply with only the integer result.", answer: "66666" },
	{ name: "reverse-word", task: "Reverse the word 'stressed' and reply with only the result.", answer: "desserts" },
	{ name: "fact-7x8", task: "Compute 7 * 8. Reply with only the integer result.", answer: "56" },
	{ name: "hex-ff", task: "Convert 255 to hexadecimal. Reply with only the hex value, no prefix.", answer: "ff" },
];

function normalize(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildTasks(count: number): BenchTask[] {
	const tasks: BenchTask[] = [];
	for (let i = 0; i < count; i++) {
		const template = TEMPLATES[i % TEMPLATES.length] as TaskTemplate;
		const round = Math.floor(i / TEMPLATES.length);
		tasks.push({
			name: round === 0 ? template.name : `${template.name}#${round}`,
			task: template.task,
			tierHint: template.tierHint ?? (i % 3 === 0 ? "frontier" : "fast"),
			expect: (finalContent) => normalize(finalContent) === template.answer,
		});
	}
	return tasks;
}

loadConfiguredEnvFile();
const dbPath = process.env.PI_SWARM_BENCH_DB ?? "/tmp/pi-swarm-reliability.db";
const store = new AgentStore(dbPath);
const service = new SwarmService({ store });
const candidates = await service.refreshCatalogs();
const accounts = service.accounts.all().length;
process.stderr.write(
	`pool: ${candidates} routable models across ${accounts} accounts | suite=${suite} tasks=${totalTasks} concurrency=${concurrency}\n`,
);

const report = await runReliability(service, buildTasks(totalTasks), {
	concurrency,
	taskTimeoutMs: 120_000,
	maxProviderAttemptsPerTurn: 6,
	maxTurns: 2,
});

const { outcomes, ...summary } = report;
process.stdout.write(`${JSON.stringify(summary, null, 1)}\n`);
if (outcomes.some((outcome) => !outcome.passed)) {
	process.stdout.write("\nfailures:\n");
	for (const outcome of outcomes.filter((o) => !o.passed)) {
		process.stdout.write(
			`  ${outcome.name}: state=${outcome.state} reason=${outcome.failReason ?? "wrong_answer"} ` +
				`served=${outcome.served.map((t) => `${t.account}/${t.model}`).join(",") || "none"} in ${outcome.durationMs}ms\n`,
		);
	}
}
service.stopAutoRefresh();
store.close();
