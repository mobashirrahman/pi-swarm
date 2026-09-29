/**
 * Provider health: the pool rots, and nothing in the routing path reports it.
 *
 * A reachable `/models` endpoint is NOT proof a provider can serve a turn.
 * Verified live: Cline lists 460 models and answers chat with
 * `insufficient_credits`; Gemini's OpenAI-compat endpoint lists 61 model ids
 * and 404s every one of them. Catalog reachability alone therefore proves
 * nothing, so the doctor sends ONE tiny real chat request per account.
 *
 * Verdicts are diagnostic only: they never change routing. The dispatcher
 * already learns the same facts from live failures, more slowly.
 */

import { resolveKey, type AccountRegistryEntry, type WireModel } from "./catalog.ts";
import { createLogger } from "./logger.ts";
import { streamTurn } from "./stream.ts";
import { wireModelIsChat } from "./catalog.ts";

const _logger = createLogger("doctor");

/** Default wall-clock budget for a whole sweep. */
export const DOCTOR_BUDGET_MS = 60_000;
/** Per-request timeout: a health check must never outlive its usefulness. */
const PROBE_TIMEOUT_MS = 20_000;

export type DoctorVerdict =
	| "ok"
	| "no_credential"
	| "catalog_unreachable"
	| "no_routable_models"
	| "balance_exhausted"
	| "chat_failed"
	| "unreachable";

export interface DoctorReport {
	accountId: string;
	providerId: string;
	category: string | undefined;
	verdict: DoctorVerdict;
	/** True when the account has a credential (never the value). */
	keyed: boolean;
	/** Models the catalog exposes. */
	catalogModels: number;
	/** Models the swarm would actually route to for this account. */
	routableModels: number;
	/** HTTP status of the chat probe, when one was sent. */
	probeStatus?: number | undefined;
	/** Model the probe used, when one was sent. */
	probeModel?: string | undefined;
	/** Short, secret-free explanation. */
	detail?: string | undefined;
}

export interface DoctorOptions {
	fetchModels?: ((account: AccountRegistryEntry) => Promise<WireModel[]>) | undefined;
	timeoutMs?: number | undefined;
	signal?: AbortSignal | undefined;
}

/** Short, single-line, credential-free detail for the operator. */
function safeDetail(body: string): string {
	return body
		.replace(/\s+/g, " ")
		.replace(/[A-Za-z0-9_-]{24,}/g, "…")
		.slice(0, 120)
		.trim();
}

interface CatalogProbe {
	ok: boolean;
	models: WireModel[];
	status?: number | undefined;
	detail?: string | undefined;
}

async function probeCatalog(
	account: AccountRegistryEntry,
	signal: AbortSignal | undefined,
): Promise<CatalogProbe> {
	const key = resolveKey(account);
	try {
		const response = await fetch(`${account.baseUrl.replace(/\/$/, "")}/models`, {
			headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
			signal: signal ?? AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		if (!response.ok) {
			return { ok: false, models: [], status: response.status, detail: safeDetail(await response.text().catch(() => "")) };
		}
		const body = (await response.json()) as { data?: WireModel[] } | WireModel[];
		return { ok: true, models: Array.isArray(body) ? body : (body.data ?? []) };
	} catch (error) {
		return {
			ok: false,
			models: [],
			detail: error instanceof Error ? safeDetail(error.message) : "network error",
		};
	}
}

/**
 * Send the smallest possible real chat request. This is the check that
 * actually answers "can this account serve a turn", and it is the only
 * reliable signal for depleted balances and catalog/chat mismatches.
 */
async function probeChat(
	account: AccountRegistryEntry,
	modelId: string,
	signal: AbortSignal | undefined,
): Promise<{ ok: boolean; status?: number | undefined; detail?: string | undefined }> {
	const outcome = await streamTurn({
		baseUrl: account.baseUrl,
		modelId,
		apiKey: resolveKey(account),
		messages: [{ role: "user", content: "Reply with ok." }],
		maxTokens: 1,
		signal: signal ?? AbortSignal.timeout(PROBE_TIMEOUT_MS),
	});
	if (outcome.ok) return { ok: true };
	return { ok: false, status: outcome.status, detail: safeDetail(outcome.errorMessage) };
}

/** Diagnose one account against the live provider. */
export async function diagnoseAccount(
	account: AccountRegistryEntry,
	routableModels: ReadonlyArray<string>,
	options: DoctorOptions = {},
): Promise<DoctorReport> {
	const keyed = resolveKey(account) !== undefined;
	const base: Omit<DoctorReport, "verdict" | "catalogModels" | "routableModels"> = {
		accountId: account.accountId,
		providerId: account.providerId,
		category: account.category,
		keyed,
	};

	if (!keyed && account.anonymousTier === undefined) {
		return { ...base, verdict: "no_credential", catalogModels: 0, routableModels: 0 };
	}

	const catalog: CatalogProbe = options.fetchModels
		? await options
				.fetchModels(account)
				.then((models): CatalogProbe => ({ ok: true, models }))
				.catch((error): CatalogProbe => ({
					ok: false,
					models: [],
					detail: error instanceof Error ? safeDetail(error.message) : "network error",
				}))
		: await probeCatalog(account, options.signal);

	if (!catalog.ok) {
		const exhausted = catalog.status === 402;
		return {
			...base,
			verdict: exhausted ? "balance_exhausted" : catalog.status !== undefined ? "catalog_unreachable" : "unreachable",
			catalogModels: 0,
			routableModels: 0,
			...(catalog.status !== undefined ? { probeStatus: catalog.status } : {}),
			...(catalog.detail !== undefined && catalog.detail.length > 0 ? { detail: catalog.detail } : {}),
		};
	}

	// Only a model the swarm would actually route to is worth a chat probe.
	// Probing something it will never pick spends a request to learn nothing
	// (an all-paid catalog, an account with no free entitlement).
	const probeTarget = routableModels[0];
	if (probeTarget === undefined) {
		return { ...base, verdict: "no_routable_models", catalogModels: catalog.models.length, routableModels: 0 };
	}

	const chat = await probeChat(account, probeTarget, options.signal);
	if (chat.ok) {
		return {
			...base,
			verdict: "ok",
			catalogModels: catalog.models.length,
			routableModels: routableModels.length,
			probeStatus: 200,
			probeModel: probeTarget,
		};
	}
	return {
		...base,
		verdict: chat.status === 402 ? "balance_exhausted" : "chat_failed",
		catalogModels: catalog.models.length,
		routableModels: routableModels.length,
		...(chat.status !== undefined ? { probeStatus: chat.status } : {}),
		probeModel: probeTarget,
		...(chat.detail !== undefined && chat.detail.length > 0 ? { detail: chat.detail } : {}),
	};
}

export interface DoctorSweep extends DoctorReport {
	/** True when the account can serve real work right now. */
	usable: boolean;
}

/**
 * Diagnose every account concurrently, bounded by one shared deadline so a
 * hung provider cannot stall the sweep.
 */
export async function doctor(
	accounts: ReadonlyArray<AccountRegistryEntry>,
	routableByAccount: ReadonlyMap<string, ReadonlyArray<string>>,
	options: DoctorOptions = {},
): Promise<{ reports: DoctorSweep[]; usable: number; total: number }> {
	const deadline = AbortSignal.timeout(options.timeoutMs ?? DOCTOR_BUDGET_MS);
	const results = await Promise.all(
		accounts.map(async (account): Promise<DoctorSweep> => {
			try {
				const report = await diagnoseAccount(account, routableByAccount.get(account.accountId) ?? [], {
					...options,
					signal: options.signal ?? deadline,
				});
				return { ...report, usable: report.verdict === "ok" };
			} catch (error) {
				return {
					accountId: account.accountId,
					providerId: account.providerId,
					category: account.category,
					verdict: "unreachable" as const,
					keyed: resolveKey(account) !== undefined,
					catalogModels: 0,
					routableModels: 0,
					detail: error instanceof Error ? safeDetail(error.message) : "probe failed",
					usable: false,
				};
			}
		}),
	);
	const usable = results.filter((report) => report.usable).length;
	_logger.info("doctor_complete", { accounts: results.length, usable });
	return { reports: results, usable, total: results.length };
}
