/**
 * Focused probe: what does an anonymous chat request to a specific provider
 * model actually return, and which quota headers come with it?
 *
 * Usage: npx tsx scripts/probe-chat.ts <providerId> [modelId]
 */

import { seedById } from "../src/providers.ts";

const providerId = process.argv[2] ?? "llm7";
const requestedModel = process.argv[3];

const seed = seedById(providerId);
if (!seed) {
	console.error(`unknown provider: ${providerId}`);
	process.exit(1);
}

const base = seed.baseUrl.replace(/\/$/, "");
const key = process.env[seed.credentialRef];
const headers: Record<string, string> = { Accept: "application/json" };
if (key) headers.Authorization = `Bearer ${key}`;

const catalogResponse = await fetch(`${base}/models`, { headers });
const catalog = (await catalogResponse.json()) as { data?: Array<{ id: string; model_type?: string; tier?: string }> };
const models = catalog.data ?? [];
console.log(`catalog ${catalogResponse.status}, ${models.length} entries`);

const chat = models.filter((model) => model.model_type === undefined || model.model_type === "chat");
const turbo = chat.filter((model) => model.tier === undefined || model.tier === (seed.anonymousTier ?? "turbo"));
console.log(`chat ${chat.length}, matching tier ${seed.anonymousTier ?? "(any)"}: ${turbo.length}`);
console.log(`first few: ${turbo.slice(0, 5).map((model) => model.id).join(", ")}`);

const model = requestedModel ?? turbo[0]?.id;
if (!model) {
	console.log("no candidate model");
	process.exit(0);
}

const probe = await fetch(`${base}/chat/completions`, {
	method: "POST",
	headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
	body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
});
const text = await probe.text();
console.log(`chat ${model} → ${probe.status}`);
console.log(`quota-ish headers: ${[...probe.headers.keys()].filter((name) => /ratelimit|retry|limit|quota/i.test(name)).join(", ") || "(none)"}`);
console.log(`body head: ${text.slice(0, 200)}`);