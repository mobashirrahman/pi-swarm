/**
 * Probe provider credentials for reachability, WITHOUT printing any secret.
 *
 * For every credential present in the environment (loaded from
 * PI_SWARM_ENV_FILE or ambient), try the known OpenAI-compatible endpoints for
 * that provider family and report: status, whether /models answered, and how
 * many free-looking chat models it exposes.
 *
 * Usage: npx tsx scripts/probe-credentials.ts [--env-file path]
 *
 * Only variable NAMES and HTTP statuses appear in the output.
 */

import { loadEnvFile } from "../src/env-file.ts";

const envFileIndex = process.argv.indexOf("--env-file");
const envFile = envFileIndex !== -1 ? process.argv[envFileIndex + 1] : process.env["PI_SWARM_ENV_FILE"];
if (envFile) loadEnvFile(envFile, { target: process.env });

interface Candidate {
	/** Environment variable holding the key. */
	credential: string;
	providerId: string;
	baseUrl: string;
	/** Extra headers some gateways require. */
	headers?: Record<string, string>;
}

const CANDIDATES: Candidate[] = [
	{ credential: "TOKENROUTER_API_KEY", providerId: "tokenrouter", baseUrl: "https://api.tokenrouter.com/v1" },
	{ credential: "BAI_API_KEY", providerId: "bai", baseUrl: "https://api.b.ai/v1" },
	{ credential: "CLINE_API_KEY", providerId: "cline", baseUrl: "https://api.cline.bot/api/v1" },
	{ credential: "KILO_API_KEY", providerId: "kilo", baseUrl: "https://api.kilocode.ai/api/openrouter/v1" },
	{ credential: "OPENROUTER_FREE_API_KEY", providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1" },
	{ credential: "GROQ_API_KEY", providerId: "groq", baseUrl: "https://api.groq.com/openai/v1" },
	{ credential: "NVIDIA_API_KEY", providerId: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1" },
	{ credential: "GEMINI_API_KEY", providerId: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
	{ credential: "GOOGLE_GENERATIVE_AI_API_KEY", providerId: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
	{ credential: "ZAI_API_KEY", providerId: "zai", baseUrl: "https://api.z.ai/api/paas/v4" },
	{ credential: "OPENAI_API_KEY", providerId: "openai", baseUrl: "https://api.openai.com/v1" },
	{ credential: "CLOUDFLARE_API_KEY", providerId: "cloudflare", baseUrl: "https://api.cloudflare.com/client/v4/accounts" },
	{ credential: "ORCAROUTER_API_KEY", providerId: "orcarouter", baseUrl: "https://api.orcarouter.ai/v1" },
	{ credential: "TIUM_API_KEY", providerId: "tium", baseUrl: "https://api.tium.ai/v1" },
	{ credential: "SAIL_API_KEY", providerId: "sail", baseUrl: "https://api.sail.ai/v1" },
	{ credential: "ABOVE_API_KEY", providerId: "above", baseUrl: "https://api.above.ai/v1" },
	{ credential: "TIYUVTA_API_KEY", providerId: "tiyuvta", baseUrl: "https://api.tiyuvta.com/v1" },
	{ credential: "XKIRO_API_KEY", providerId: "xkiro", baseUrl: "https://api.xkiro.ai/v1" },
	{ credential: "BYNARA_API_KEY", providerId: "bynara", baseUrl: "https://api.bynara.ai/v1" },
	{ credential: "KAGGLE_API_KEY", providerId: "kaggle", baseUrl: "https://www.kaggle.com/api/v1" },
];

interface WireModel {
	id?: string;
	model_type?: string;
	pricing?: { input?: number | string; output?: number | string; prompt?: number | string; completion?: number | string };
}

function countFree(models: WireModel[]): number {
	return models.filter((model) => {
		if (model.model_type !== undefined && model.model_type !== "chat") return false;
		const pricing = model.pricing;
		if (!pricing) return true;
		const num = (value: number | string | undefined): number => (typeof value === "string" ? Number.parseFloat(value) : (value ?? 0));
		return num(pricing.input ?? pricing.prompt) === 0 && num(pricing.output ?? pricing.completion) === 0;
	}).length;
}

for (const candidate of CANDIDATES) {
	const key = process.env[candidate.credential];
	if (key === undefined || key.length === 0) {
		process.stdout.write(`${candidate.providerId.padEnd(22)} ${candidate.credential.padEnd(32)} no key\n`);
		continue;
	}
	try {
		const response = await fetch(`${candidate.baseUrl.replace(/\/$/, "")}/models`, {
			headers: { Accept: "application/json", Authorization: `Bearer ${key}`, ...(candidate.headers ?? {}) },
			signal: AbortSignal.timeout(15_000),
		});
		let modelCount = 0;
		let freeCount = 0;
		let note = "";
		if (response.ok) {
			const body = (await response.json()) as { data?: WireModel[] } | WireModel[];
			const models = Array.isArray(body) ? body : (body.data ?? []);
			modelCount = models.length;
			freeCount = countFree(models);
		} else {
			note = (await response.text()).slice(0, 80).replace(/\s+/g, " ");
		}
		process.stdout.write(
			`${candidate.providerId.padEnd(22)} ${candidate.credential.padEnd(32)} ${String(response.status).padEnd(4)} models=${String(modelCount).padEnd(4)} free-chat=${String(freeCount).padEnd(4)} ${note}\n`,
		);
	} catch (error) {
		process.stdout.write(
			`${candidate.providerId.padEnd(22)} ${candidate.credential.padEnd(32)} ERR  ${error instanceof Error ? error.message.slice(0, 60) : "unknown"}\n`,
		);
	}
}