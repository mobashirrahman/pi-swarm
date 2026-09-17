/**
 * Provider catalog: account registry + model catalog fetch with the
 * cache-first pattern (pi-free: 1h TTL disk cache, 8s startup deadline).
 *
 * v1 ships the three keyless-catalog providers from the plan (llm7, cline,
 * fastrouter) as the default seed; production deployments extend via config.
 * Credentials resolve env-first (credentialRef is an env var name in v1);
 * the VALUE never crosses this module's boundary — callers receive it only
 * for direct header construction.
 */

import { fetchWithRetry } from "./fetch.ts";
import { createLogger } from "./logger.ts";
import type { ProviderAccount } from "./types.ts";

const _logger = createLogger("catalog");

/** Wire model entry from an OpenAI-compatible /models endpoint. */
export interface WireModel {
	id: string;
	/** Some gateways put a display name here. */
	name?: string | undefined;
	/** OpenRouter-style per-token pricing; zero/absent ⇒ treated free. */
	pricing?: { prompt?: string | number; completion?: string | number; input?: string | number; output?: string | number } | undefined;
	context_length?: number | undefined;
	/** llm7-style model type: "chat" is text-completions capable. */
	model_type?: string | undefined;
	/** llm7-style access tier: "turbo" works anonymously, "pro" needs a key. */
	tier?: string | undefined;
}

export interface CatalogFetchResult {
	models: WireModel[];
	/** "network" = fetch failed; "empty" = 200 but zero models. */
	error?: "network" | "empty";
}

export const CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour (pi-free cache-first)
export const CATALOG_FETCH_TIMEOUT_MS = 8_000; // pi-free startup deadline

export interface AccountRegistryEntry extends ProviderAccount {
	baseUrl: string;
	/** For anonymous accounts: the only tier reachable without a key. */
	anonymousTier?: string | undefined;
	/**
	 * Declared provider category. Drives the free-only policy when a catalog
	 * exposes no pricing: a paid provider's unpriced models must NOT be treated
	 * as free (OpenAI's /models lists no prices, so the pricing heuristic alone
	 * would happily route to paid models).
	 */
	category?: "free" | "freemium" | "paid" | undefined;
}

/** In-memory account registry. Persistence arrives with the store layer. */
export class AccountRegistry {
	private readonly accounts = new Map<string, AccountRegistryEntry>();

	register(entry: AccountRegistryEntry): void {
		this.accounts.set(entry.accountId, entry);
	}

	get(accountId: string): AccountRegistryEntry | undefined {
		return this.accounts.get(accountId);
	}

	all(): ReadonlyArray<AccountRegistryEntry> {
		return [...this.accounts.values()];
	}

	enabled(): ReadonlyArray<AccountRegistryEntry> {
		return this.all().filter((a) => a.enabled);
	}
}

/** Fetch the model catalog for an account. Anonymous when no key resolves. */
export async function fetchCatalog(
	account: AccountRegistryEntry,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<CatalogFetchResult> {
	const url = `${account.baseUrl.replace(/\/$/, "")}/models`;
	const headers: Record<string, string> = { Accept: "application/json" };
	const key = resolveKey(account);
	if (key) headers.Authorization = `Bearer ${key}`;

	try {
		const response = await fetchWithRetry(url, { headers, signal: options.signal }, 2, 500, options.timeoutMs ?? CATALOG_FETCH_TIMEOUT_MS);
		if (!response.ok) {
			_logger.warn("catalog fetch non-ok", { provider: account.providerId, status: response.status });
			return { models: [], error: "network" };
		}
		const body = (await response.json()) as { data?: WireModel[] } | WireModel[];
		const models = Array.isArray(body) ? body : (body.data ?? []);
		if (models.length === 0) {
			return { models: [], error: "empty" };
		}
		return { models };
	} catch (error) {
		if (options.signal?.aborted) return { models: [], error: "network" };
		_logger.warn("catalog fetch failed", {
			provider: account.providerId,
			error: error instanceof Error ? error.message : String(error),
		});
		return { models: [], error: "network" };
	}
}

/**
 * Resolve the credential for an account. Returns undefined when absent —
 * the account then runs anonymous (keyless allowlist providers only).
 */
export function resolveKey(account: AccountRegistryEntry): string | undefined {
	const value = process.env[account.credentialRef];
	return value && value.length > 0 ? value : undefined;
}

/** Is a wire model free? Ported pi-free logic: zero prompt AND completion price. */
export function wireModelIsFree(model: WireModel): boolean {
	const pricing = model.pricing;
	if (!pricing) return true; // no pricing info — anonymous catalogs are free-tier
	const num = (v: string | number | undefined): number | undefined =>
		typeof v === "string" ? Number.parseFloat(v) : v;
	const input = num(pricing.prompt ?? pricing.input) ?? 0;
	const completion = num(pricing.completion ?? pricing.output) ?? 0;
	return Number.isFinite(input) && Number.isFinite(completion) && input === 0 && completion === 0;
}

/**
 * Is this a usable TEXT-CHAT model? Filters image/video/audio generators
 * (llm7 exposes them over the same /v1/models endpoint).
 */
export function wireModelIsChat(model: WireModel): boolean {
	if (model.model_type === undefined) return true; // no type info — assume chat
	return model.model_type === "chat";
}
