/**
 * Provider catalog: every provider pi-free knows about, as swarm account
 * seeds. Base URLs and credential variable names are taken from pi-free's
 * constants.ts / docs/providers.md (the same wire surface: OpenAI-compatible
 * chat completions, except where noted).
 *
 * `anonymousCatalog` marks providers whose `/models` endpoint answers
 * without a credential. It does NOT imply keyless chat — verified live:
 * Cline and FastRouter list keyless but 401 on chat, while llm7 serves
 * chat anonymously on its "turbo" tier.
 */

export interface ProviderSeed {
	providerId: string;
	baseUrl: string;
	/** Environment variable holding the credential. */
	credentialRef: string;
	/**
	 * True when /models answers anonymously. Keyless chat additionally
	 * requires `anonymousChat`.
	 */
	anonymousCatalog: boolean;
	/** True when chat works with NO credential at all (llm7 turbo tier). */
	anonymousChat: boolean;
	/** Models reachable anonymously are limited to this tier, when known. */
	anonymousTier?: string | undefined;
	/** Provider category, for audits and docs. */
	category: "free" | "freemium" | "paid";
}

/**
 * Seeds for every provider the swarm can route to. Ordering matters only for
 * documentation; selection is quota/quality driven.
 */
export const PROVIDER_SEEDS: ReadonlyArray<ProviderSeed> = [
	// --- Free / free-tier -----------------------------------------------------
	{ providerId: "llm7", baseUrl: "https://api.llm7.io/v1", credentialRef: "LLM7_API_KEY", anonymousCatalog: true, anonymousChat: true, anonymousTier: "turbo", category: "free" },
	{ providerId: "cline", baseUrl: "https://api.cline.bot/api/v1", credentialRef: "CLINE_API_KEY", anonymousCatalog: true, anonymousChat: false, category: "free" },
	{ providerId: "fastrouter", baseUrl: "https://api.fastrouter.ai/api/v1", credentialRef: "FASTROUTER_API_KEY", anonymousCatalog: true, anonymousChat: false, category: "free" },
	{ providerId: "kilo", baseUrl: "https://api.kilocode.ai/api/openrouter/v1", credentialRef: "KILO_API_KEY", anonymousCatalog: true, anonymousChat: false, category: "free" },
	{ providerId: "tokenrouter", baseUrl: "https://api.tokenrouter.com/v1", credentialRef: "TOKENROUTER_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "free" },
	{ providerId: "agnes", baseUrl: "https://apihub.agnes-ai.com/v1", credentialRef: "AGNES_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "free" },

	// --- Freemium -------------------------------------------------------------
	{ providerId: "anyapi", baseUrl: "https://api.anyapi.ai/v1", credentialRef: "ANYAPI_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "freemium" },
	{ providerId: "ollama-cloud", baseUrl: "https://ollama.com/v1", credentialRef: "OLLAMA_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "freemium" },
	{ providerId: "sambanova", baseUrl: "https://api.sambanova.ai/v1", credentialRef: "SAMBANOVA_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "freemium" },
	{ providerId: "requesty", baseUrl: "https://router.requesty.ai/v1", credentialRef: "REQUESTY_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "freemium" },

	// --- Paid / trial ---------------------------------------------------------
	{ providerId: "zenmux", baseUrl: "https://zenmux.ai/api/v1", credentialRef: "ZENMUX_API_KEY", anonymousCatalog: true, anonymousChat: false, category: "paid" },
	{ providerId: "crofai", baseUrl: "https://crof.ai/v1", credentialRef: "CROFAI_API_KEY", anonymousCatalog: true, anonymousChat: false, category: "paid" },
	{ providerId: "deepinfra", baseUrl: "https://api.deepinfra.com/v1/openai", credentialRef: "DEEPINFRA_TOKEN", anonymousCatalog: true, anonymousChat: false, category: "paid" },
	{ providerId: "novita", baseUrl: "https://api.novita.ai/openai/v1", credentialRef: "NOVITA_API_KEY", anonymousCatalog: true, anonymousChat: false, category: "paid" },
	{ providerId: "routeway", baseUrl: "https://api.routeway.ai/v1", credentialRef: "ROUTEWAY_API_KEY", anonymousCatalog: true, anonymousChat: false, category: "paid" },
	{ providerId: "opengateway", baseUrl: "https://opengateway.gitlawb.com/v1", credentialRef: "OPENGATEWAY_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "paid" },
	{ providerId: "bai", baseUrl: "https://api.b.ai/v1", credentialRef: "BAI_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "paid" },
	{ providerId: "stepfun", baseUrl: "https://api.stepfun.ai/step_plan/v1", credentialRef: "STEPFUN_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "paid" },
	{ providerId: "gmi", baseUrl: "https://api.gmi-serving.com/v1", credentialRef: "GMI_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "paid" },
	{ providerId: "venice", baseUrl: "https://api.venice.ai/api/v1", credentialRef: "VENICE_API_KEY", anonymousCatalog: true, anonymousChat: false, category: "paid" },
	{ providerId: "infron", baseUrl: "https://llm.onerouter.pro/v1", credentialRef: "INFRON_API_KEY", anonymousCatalog: true, anonymousChat: false, category: "paid" },
	{ providerId: "merge", baseUrl: "https://api-gateway.merge.dev/v1/openai", credentialRef: "MERGE_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "paid" },
	{ providerId: "commandcode", baseUrl: "https://api.commandcode.ai/provider/v1", credentialRef: "COMMAND_CODE_API_KEY", anonymousCatalog: true, anonymousChat: false, category: "paid" },

	// --- Added after live credential probing (2026-09-17) ---------------------
	// Each verified: /models answered 200 with a real chat catalog.
	{ providerId: "openrouter", baseUrl: "https://openrouter.ai/api/v1", credentialRef: "OPENROUTER_FREE_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "freemium" },
	{ providerId: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1", credentialRef: "NVIDIA_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "freemium" },
	{ providerId: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", credentialRef: "GEMINI_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "freemium" },
	{ providerId: "zai", baseUrl: "https://api.z.ai/api/paas/v4", credentialRef: "ZAI_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "freemium" },
	{ providerId: "orcarouter", baseUrl: "https://api.orcarouter.ai/v1", credentialRef: "ORCAROUTER_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "freemium" },
	{ providerId: "tium", baseUrl: "https://api.tium.ai/v1", credentialRef: "TIUM_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "freemium" },
	// Base URLs taken from the harness's own models.yml, which is authoritative
	// for these gateways (my first guesses at the hostnames were wrong for five
	// of six — api.sail.ai vs api.sailresearch.com, api.above.ai vs
	// api.above.dev, api.tiyuvta.com vs api.tiyuvta.ai, api.xkiro.ai vs
	// api.xkiro.com, api.bynara.ai vs router.bynara.id).
	{ providerId: "sail", baseUrl: "https://api.sailresearch.com/v1", credentialRef: "SAIL_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "freemium" },
	{ providerId: "above", baseUrl: "https://api.above.dev/v1", credentialRef: "ABOVE_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "freemium" },
	{ providerId: "tiyuvta", baseUrl: "https://api.tiyuvta.ai/v1", credentialRef: "TIYUVTA_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "freemium" },
	{ providerId: "xkiro", baseUrl: "https://api.xkiro.com/v1", credentialRef: "XKIRO_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "freemium" },
	{ providerId: "bynara", baseUrl: "https://router.bynara.id/v1", credentialRef: "BYNARA_API_KEY", anonymousCatalog: false, anonymousChat: false, category: "freemium" },
];

export function seedById(providerId: string): ProviderSeed | undefined {
	return PROVIDER_SEEDS.find((seed) => seed.providerId === providerId);
}

/**
 * Providers usable with the credentials present in the environment, plus
 * anonymously-chattable ones. A provider is included when:
 *  - a credential resolves, OR
 *  - it serves chat anonymously (llm7 turbo).
 * Everything else is skipped: a listed-but-unauthenticated provider would
 * only produce 401s and burn attempts (pi-free #530).
 */
export function availableSeeds(env: NodeJS.ProcessEnv = process.env): ProviderSeed[] {
	return PROVIDER_SEEDS.filter((seed) => {
		const key = env[seed.credentialRef];
		if (key !== undefined && key.length > 0) return true;
		return seed.anonymousChat;
	});
}