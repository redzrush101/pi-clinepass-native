import type {
	Model,
	ModelsStoreEntry,
	OAuthCredentials,
	OAuthLoginCallbacks,
	RefreshModelsContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "cline-pass";
const CLINE_API = "https://api.cline.bot/api/v1";
const MODELS_URL = `${CLINE_API}/ai/cline/recommended-models`;
const USAGE_LIMITS_URL = `${CLINE_API}/users/me/plan/usage-limits`;
const MODELS_DEV_URL = "https://models.dev/api.json";
const WORKOS_API = "https://api.workos.com";

// Public OAuth client id from Cline's own device-login flow (production env).
const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";
const WORKOS_PREFIX = "workos:";

// Same 10-minute catalog TTL as Cline's live provider catalog.
const MODEL_CACHE_TTL_MS = 10 * 60_000;
const CATALOG_REQUEST_TIMEOUT_MS = 5_000;
const AUTH_REQUEST_TIMEOUT_MS = 30_000;
const USAGE_REQUEST_TIMEOUT_MS = 10_000;

const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 8_192;

// The feed spells the same model with a Vercel id (zai/…) while models.dev
// keys it under the OpenRouter alias (z-ai/…). Check both.
const ID_ALIAS_PREFIXES: ReadonlyArray<readonly [string, string]> = [["zai/", "z-ai/"]];

const PI_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type PiThinkingLevel = "off" | (typeof PI_THINKING_LEVELS)[number];
type PiThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;

type PiModel = {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: PiThinkingLevelMap;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
};

type StoredPiModel = Model<"openai-completions">;

type RecommendedEntry = {
	id?: string;
	name?: string;
	description?: string;
};

type RecommendedModelsResponse = {
	clinePass?: RecommendedEntry[];
	free?: RecommendedEntry[];
};

type ModelsDevReasoningEffort = null | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "default";

type ModelsDevReasoningOption =
	| { type?: "toggle" }
	| { type?: "effort"; values?: ModelsDevReasoningEffort[] }
	| { type?: "budget_tokens"; min?: number; max?: number };

type ModelsDevModel = {
	id?: string;
	name?: string;
	tool_call?: boolean;
	reasoning?: boolean;
	reasoning_options?: ModelsDevReasoningOption[];
	status?: string;
	limit?: { context?: number; input?: number; output?: number };
	cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
	modalities?: { input?: string[]; output?: string[] };
};

type ModelsDevCatalog = Record<string, { models?: Record<string, ModelsDevModel> } | undefined>;

type ClineAuthResponse = {
	success?: boolean;
	data?: {
		accessToken?: string;
		refreshToken?: string;
		expiresAt?: string;
	};
};

type UsageLimit = {
	type?: string;
	percentUsed?: number;
	resetsAt?: string;
};

type UsageLimitsResponse = {
	success?: boolean;
	data?: { limits?: UsageLimit[] };
};

type DeviceResponse = {
	device_code?: string;
	user_code?: string;
	verification_uri?: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
	error?: string;
	error_description?: string;
};

type WorkOSTokenResponse = {
	access_token?: string;
	refresh_token?: string;
	error?: string;
	error_description?: string;
};

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function clineHeaders(contentType = "application/json"): Record<string, string> {
	return {
		Accept: "application/json",
		"Content-Type": contentType,
		"User-Agent": "pi-clinepass-native",
	};
}

async function errorText(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	if (!text) return `${response.status} ${response.statusText}`;
	try {
		const json = JSON.parse(text) as { error?: string; error_description?: string; message?: string };
		return json.error_description ?? json.message ?? json.error ?? text;
	} catch {
		return text;
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(signal.reason);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason);
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const USAGE_LABELS: Record<string, string> = {
	five_hour: "5-hour",
	weekly: "Weekly",
	monthly: "Monthly",
};

function usageLabel(type: string | undefined): string {
	if (!type) return "Unknown";
	return USAGE_LABELS[type] ?? type.replace(/_/g, " ");
}

const USAGE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const USAGE_DAY_FORMAT = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	hour: "2-digit",
	minute: "2-digit",
});
const USAGE_DATE_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function relativeReset(minutes: number): string {
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) {
		const m = minutes % 60;
		return m ? `${hours}h ${m}m` : `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	const h = hours % 24;
	return h ? `${days}d ${h}h` : `${days}d`;
}

// Absolute format shrinks as the reset gets further out: time today, weekday
// this week, date beyond that.
function usageReset(resetsAt: string | undefined, now: number): string {
	const time = resetsAt ? Date.parse(resetsAt) : NaN;
	if (!Number.isFinite(time)) return "";
	const minutes = Math.round((time - now) / 60_000);
	if (minutes < 1) return "resets soon";
	const date = new Date(time);
	const absolute =
		minutes < 60 * 24
			? USAGE_TIME_FORMAT.format(date)
			: minutes < 60 * 24 * 7
				? USAGE_DAY_FORMAT.format(date)
				: USAGE_DATE_FORMAT.format(date);
	return `resets ${absolute} (in ${relativeReset(minutes)})`;
}

function usageBar(percent: number): string {
	const width = 10;
	const PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
	const eighths = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width * 8);
	const full = Math.floor(eighths / 8);
	const bar = "█".repeat(full) + (full < width ? PARTIALS[eighths % 8] : "");
	return bar.padEnd(width, "░");
}

function formatUsageLimits(limits: readonly UsageLimit[], now: number): string {
	return limits
		.map((limit) => {
			const percent = nonNegativeNumber(limit.percentUsed) ?? 0;
			const pct = Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
			const reset = usageReset(limit.resetsAt, now);
			const line = `${usageLabel(limit.type).padEnd(7)} ${usageBar(percent)} ${pct.padStart(3)}%`;
			return reset ? `${line} · ${reset}` : line;
		})
		.join("\n");
}

function modelSlug(id: string): string {
	return id.split("/").at(-1) ?? id;
}

// The id itself plus any Vercel/OpenRouter alias spelling.
function idAliases(id: string): string[] {
	const ids = [id];
	for (const [a, b] of ID_ALIAS_PREFIXES) {
		if (id.startsWith(a)) ids.push(b + id.slice(a.length));
		else if (id.startsWith(b)) ids.push(a + id.slice(b.length));
	}
	return ids;
}

export function toCredentials(payload: ClineAuthResponse, fallback?: OAuthCredentials): OAuthCredentials {
	const data = payload.data;
	if (!payload.success || !data?.accessToken || !data.expiresAt) {
		throw new Error("Invalid token response from Cline");
	}

	const refresh = data.refreshToken ?? fallback?.refresh;
	if (!refresh) throw new Error("Cline did not return a refresh token");

	const expires = Date.parse(data.expiresAt);
	if (!Number.isFinite(expires)) {
		throw new Error(`Invalid token expiration from Cline: ${data.expiresAt}`);
	}

	return { access: data.accessToken, refresh, expires };
}

// Cline sends the access token as a `workos:`-prefixed bearer.
export function getApiKey(credentials: OAuthCredentials): string {
	return credentials.access.toLowerCase().startsWith(WORKOS_PREFIX)
		? credentials.access
		: `${WORKOS_PREFIX}${credentials.access}`;
}

// Index the tool-capable, non-deprecated models from a models.dev provider
// section by both full id and slug. ClinePass ids omit the upstream vendor, so
// lookups fall back to the slug.
type ModelIndex = {
	byId: Record<string, ModelsDevModel>;
	bySlug: Record<string, ModelsDevModel>;
};

function indexSection(section: { models?: Record<string, ModelsDevModel> } | undefined): ModelIndex {
	const byId: Record<string, ModelsDevModel> = {};
	const bySlug: Record<string, ModelsDevModel> = {};
	for (const [id, raw] of Object.entries(section?.models ?? {})) {
		if (raw.status === "deprecated" || raw.tool_call !== true) continue;
		const resolvedId = raw.id?.trim() || id;
		const model = { ...raw, id: resolvedId };
		byId[resolvedId] = model;
		bySlug[modelSlug(resolvedId)] = model;
	}
	return { byId, bySlug };
}

export function buildCatalog(payload: ModelsDevCatalog | undefined): {
	cline: ModelIndex;
	clinePass: ModelIndex;
	openRouter: ModelIndex;
} {
	return {
		cline: indexSection(payload?.cline),
		clinePass: indexSection(payload?.["cline-pass"]),
		openRouter: indexSection(payload?.openrouter),
	};
}

export function reasoningLevelMap(
	options: readonly ModelsDevReasoningOption[] | undefined,
): PiThinkingLevelMap | undefined {
	const efforts = options?.flatMap((option) => (option.type === "effort" ? (option.values ?? []) : [])) ?? [];
	if (efforts.length === 0) return undefined;

	const supported = new Set(efforts);
	if (!supported.has("none") && !PI_THINKING_LEVELS.some((level) => supported.has(level))) {
		return undefined;
	}

	const map: PiThinkingLevelMap = { off: supported.has("none") ? "none" : null };
	for (const level of PI_THINKING_LEVELS) {
		map[level] = supported.has(level) ? level : null;
	}
	return map;
}

function genericModel(entry: RecommendedEntry, existing?: PiModel): PiModel | undefined {
	const id = entry.id?.trim();
	if (!id) return undefined;

	if (existing) return { ...existing, id };

	return {
		id,
		name: entry.name?.trim() || id,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: FALLBACK_CONTEXT_WINDOW,
		maxTokens: FALLBACK_MAX_TOKENS,
	};
}

function enrichModel(base: PiModel, metadata: ModelsDevModel | undefined): PiModel {
	if (!metadata) return base;

	const inputs = metadata.modalities?.input;
	const supportsImages = Array.isArray(inputs) ? inputs.includes("image") : base.input.includes("image");
	const thinkingLevelMap = reasoningLevelMap(metadata.reasoning_options);

	return {
		...base,
		name: metadata.name?.trim() || base.name,
		reasoning: metadata.reasoning ?? base.reasoning,
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
		input: supportsImages ? ["text", "image"] : ["text"],
		cost: {
			input: nonNegativeNumber(metadata.cost?.input) ?? base.cost.input,
			output: nonNegativeNumber(metadata.cost?.output) ?? base.cost.output,
			cacheRead: nonNegativeNumber(metadata.cost?.cache_read) ?? base.cost.cacheRead,
			cacheWrite: nonNegativeNumber(metadata.cost?.cache_write) ?? base.cost.cacheWrite,
		},
		contextWindow: positiveNumber(metadata.limit?.context) ?? base.contextWindow,
		maxTokens: positiveNumber(metadata.limit?.output) ?? base.maxTokens,
	};
}

// Try each alias spelling against a section, full id first, then slug.
function lookup(index: ModelIndex, id: string): ModelsDevModel | undefined {
	for (const alias of idAliases(id)) {
		const hit = index.byId[alias] ?? index.bySlug[modelSlug(alias)];
		if (hit) return hit;
	}
	return undefined;
}

// Subscription models resolve against the cline-pass section then openrouter;
// free models against cline then openrouter (Cline's own lookup order).
function metadataFor(id: string, free: boolean, catalog: ReturnType<typeof buildCatalog>): ModelsDevModel | undefined {
	if (free) {
		return lookup(catalog.cline, id) ?? lookup(catalog.openRouter, id);
	}
	return lookup(catalog.clinePass, id) ?? lookup(catalog.openRouter, id);
}

export function mapCatalog(
	payload: RecommendedModelsResponse,
	catalog: ReturnType<typeof buildCatalog> = buildCatalog(undefined),
	cached: readonly PiModel[] = [],
): PiModel[] {
	const cachedById = new Map(cached.map((model) => [model.id, model]));
	const models: PiModel[] = [];
	const seen = new Set<string>();

	const append = (entry: RecommendedEntry, free: boolean) => {
		const id = entry.id?.trim();
		if (!id || seen.has(id)) return;

		const base = genericModel(entry, cachedById.get(id));
		if (!base) return;

		const metadata = metadataFor(id, free, catalog);
		let model = enrichModel(base, metadata);

		// Free-tier models bill at $0 through Cline regardless of the upstream
		// list price in the metadata.
		if (free) {
			const displayName = metadata?.name?.trim() || entry.name?.trim() || model.name || id;
			model = {
				...model,
				name: id.startsWith("cline-free/") ? `${displayName.replace(/\s*\(free\)\s*$/i, "")} (free)` : displayName,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
		}

		seen.add(id);
		models.push(model);
	};

	for (const entry of payload.clinePass ?? []) append(entry, false);
	for (const entry of payload.free ?? []) append(entry, true);
	return models;
}

function toStoredModels(models: readonly PiModel[]): StoredPiModel[] {
	return models.map((model) => ({
		...model,
		provider: PROVIDER_ID,
		api: "openai-completions" as const,
		baseUrl: CLINE_API,
	}));
}

function fromStoredModels(entry: Readonly<ModelsStoreEntry> | undefined): PiModel[] {
	return (entry?.models ?? [])
		.filter((model) => model.provider === PROVIDER_ID && typeof model.id === "string")
		.map((model) => ({
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
			input: [...model.input],
			cost: { ...model.cost },
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		}));
}

async function fetchModelCatalog(
	fetchImpl: typeof fetch,
	signal: AbortSignal,
): Promise<ReturnType<typeof buildCatalog> | undefined> {
	try {
		const response = await fetchImpl(MODELS_DEV_URL, {
			headers: { Accept: "application/json" },
			signal: requestSignal(signal, CATALOG_REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) return undefined;
		return buildCatalog((await response.json()) as ModelsDevCatalog);
	} catch (error) {
		if (signal.aborted) throw error;
		return undefined;
	}
}

type CatalogFetchResult = {
	payload?: RecommendedModelsResponse;
	catalog?: ReturnType<typeof buildCatalog>;
	etag?: string;
	lastModified?: number;
	notModified: boolean;
};

async function fetchCatalog(
	fetchImpl: typeof fetch,
	signal: AbortSignal,
	validators?: { etag?: string; lastModified?: number },
): Promise<CatalogFetchResult> {
	const headers: Record<string, string> = { Accept: "application/json" };
	if (validators?.etag) headers["If-None-Match"] = validators.etag;
	if (validators?.lastModified) headers["If-Modified-Since"] = new Date(validators.lastModified).toUTCString();

	// Membership comes from the Cline feed; if it is down there is nothing to
	// enrich, so check it before spending a request on models.dev.
	const response = await fetchImpl(MODELS_URL, {
		headers,
		signal: requestSignal(signal, CATALOG_REQUEST_TIMEOUT_MS),
	});

	if (response.status !== 304 && !response.ok) {
		throw new Error(`Failed to fetch ClinePass models: ${await errorText(response)}`);
	}

	const catalog = await fetchModelCatalog(fetchImpl, signal);
	if (response.status === 304) return { catalog, notModified: true };

	const parsedLastModified = Date.parse(response.headers.get("last-modified") ?? "");
	return {
		payload: (await response.json()) as RecommendedModelsResponse,
		catalog,
		etag: response.headers.get("etag") ?? undefined,
		lastModified: Number.isNaN(parsedLastModified) ? undefined : parsedLastModified,
		notModified: false,
	};
}

export async function refreshClinePassModels(
	context: RefreshModelsContext,
	fetchImpl: typeof fetch = fetch,
): Promise<PiModel[]> {
	const cached = fromStoredModels(context.stored);

	// Cache-only phase restores the persisted list with no network or auth.
	if (!context.allowNetwork) return cached;

	if (
		!context.force &&
		cached.length > 0 &&
		context.stored?.checkedAt !== undefined &&
		Date.now() - context.stored.checkedAt < MODEL_CACHE_TTL_MS
	) {
		return cached;
	}

	const result = await fetchCatalog(fetchImpl, context.signal, {
		etag: cached.length ? context.stored?.etag : undefined,
		lastModified: cached.length ? context.stored?.lastModified : undefined,
	});
	context.signal.throwIfAborted();
	const checkedAt = Date.now();

	if (result.notModified && context.stored) {
		// Feed unchanged; re-enrich in case models.dev metadata improved, but
		// keep each cached model's cost so a free model is not re-priced.
		const models = result.catalog
			? cached.map((model) => ({
					...enrichModel(model, metadataFor(model.id, false, result.catalog!)),
					cost: model.cost,
				}))
			: cached;
		await context.publish({
			persist: { ...context.stored, models: toStoredModels(models), checkedAt },
		});
		return models;
	}

	const models = mapCatalog(result.payload ?? {}, result.catalog, cached);
	if (models.length === 0) {
		throw new Error("Cline returned no ClinePass models");
	}

	await context.publish({
		persist: {
			models: toStoredModels(models),
			checkedAt,
			etag: result.etag,
			lastModified: result.lastModified,
		},
	});
	return models;
}

async function startDeviceAuthorization(signal?: AbortSignal): Promise<{
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	verificationUriComplete?: string;
	expiresInSeconds: number;
	intervalSeconds: number;
}> {
	const response = await fetch(`${WORKOS_API}/user_management/authorize/device`, {
		method: "POST",
		headers: clineHeaders("application/x-www-form-urlencoded"),
		body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
		signal: requestSignal(signal, AUTH_REQUEST_TIMEOUT_MS),
	});
	const data = (await response.json().catch(() => ({}))) as DeviceResponse;

	if (!response.ok || !data.device_code || !data.user_code || !data.verification_uri) {
		throw new Error(
			`Cline device authorization failed: ${data.error_description ?? data.error ?? response.statusText}`,
		);
	}

	return {
		deviceCode: data.device_code,
		userCode: data.user_code,
		verificationUri: data.verification_uri,
		verificationUriComplete: data.verification_uri_complete,
		expiresInSeconds: positiveNumber(data.expires_in) ?? 300,
		intervalSeconds: positiveNumber(data.interval) ?? 5,
	};
}

async function pollDeviceAuthorization(
	device: { deviceCode: string; expiresInSeconds: number; intervalSeconds: number },
	signal?: AbortSignal,
): Promise<{ accessToken: string; refreshToken: string }> {
	const deadline = Date.now() + device.expiresInSeconds * 1000;
	let intervalSeconds = Math.max(1, device.intervalSeconds);

	while (Date.now() <= deadline) {
		signal?.throwIfAborted();
		const response = await fetch(`${WORKOS_API}/user_management/authenticate`, {
			method: "POST",
			headers: clineHeaders("application/x-www-form-urlencoded"),
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: device.deviceCode,
				client_id: WORKOS_CLIENT_ID,
			}),
			signal: requestSignal(signal, AUTH_REQUEST_TIMEOUT_MS),
		});
		const data = (await response.json().catch(() => ({}))) as WorkOSTokenResponse;

		if (response.ok && data.access_token && data.refresh_token) {
			return { accessToken: data.access_token, refreshToken: data.refresh_token };
		}

		if (data.error === "authorization_pending") {
			await sleep(intervalSeconds * 1000, signal);
			continue;
		}
		if (data.error === "slow_down") {
			intervalSeconds += 1;
			await sleep(intervalSeconds * 1000, signal);
			continue;
		}

		throw new Error(
			`Cline device authorization failed: ${data.error_description ?? data.error ?? response.statusText}`,
		);
	}

	throw new Error("Cline device authorization timed out");
}

async function registerWorkOSTokens(
	tokens: { accessToken: string; refreshToken: string },
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	const response = await fetch(`${CLINE_API}/auth/register`, {
		method: "POST",
		headers: clineHeaders(),
		body: JSON.stringify(tokens),
		signal: requestSignal(signal, AUTH_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`Cline token registration failed: ${await errorText(response)}`);
	}
	return toCredentials((await response.json()) as ClineAuthResponse);
}

// Not part of Cline's login. This makes usage-limit reads land on the personal
// account; a failure here does not affect authentication.
async function selectPersonalAccount(credentials: OAuthCredentials, signal?: AbortSignal): Promise<void> {
	try {
		const response = await fetch(`${CLINE_API}/users/active-account`, {
			method: "PUT",
			headers: {
				...clineHeaders(),
				Authorization: `Bearer ${getApiKey(credentials)}`,
			},
			body: JSON.stringify({ organizationId: null }),
			signal: requestSignal(signal, AUTH_REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) await response.body?.cancel().catch(() => {});
	} catch (error) {
		if (signal?.aborted) throw error;
	}
}

export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const signal = callbacks.signal;
	const device = await startDeviceAuthorization(signal);

	callbacks.onDeviceCode({
		userCode: device.userCode,
		verificationUri: device.verificationUri,
		intervalSeconds: device.intervalSeconds,
		expiresInSeconds: device.expiresInSeconds,
	});
	callbacks.onAuth({ url: device.verificationUriComplete ?? device.verificationUri });

	const workosTokens = await pollDeviceAuthorization(device, signal);
	const credentials = await registerWorkOSTokens(workosTokens, signal);
	await selectPersonalAccount(credentials, signal);
	callbacks.onProgress?.("ClinePass authenticated");
	return credentials;
}

export async function refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	const response = await fetch(`${CLINE_API}/auth/refresh`, {
		method: "POST",
		headers: clineHeaders(),
		body: JSON.stringify({
			refreshToken: credentials.refresh,
			grantType: "refresh_token",
		}),
		signal: requestSignal(signal, AUTH_REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`Cline token refresh failed: ${await errorText(response)}`);
	}
	return toCredentials((await response.json()) as ClineAuthResponse, credentials);
}

export default function clinePassExtension(pi: ExtensionAPI) {
	pi.registerCommand("clinepass-usage", {
		description: "Show ClinePass usage limits (5-hour / weekly / monthly)",
		handler: async (_args, ctx) => {
			// getProviderAuth refreshes the stored OAuth token if near expiry and
			// returns it already workos:-prefixed.
			const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID).catch((error: unknown) => {
				ctx.ui.notify(`ClinePass auth failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return undefined;
			});
			if (!auth) return;
			if (!auth.auth.apiKey) {
				ctx.ui.notify("Not logged in to ClinePass — run /login", "warning");
				return;
			}

			try {
				const response = await fetch(USAGE_LIMITS_URL, {
					headers: { ...clineHeaders(), Authorization: `Bearer ${auth.auth.apiKey}` },
					signal: requestSignal(ctx.signal, USAGE_REQUEST_TIMEOUT_MS),
				});
				if (!response.ok) {
					ctx.ui.notify(`ClinePass usage check failed: ${await errorText(response)}`, "error");
					return;
				}
				const payload = (await response.json()) as UsageLimitsResponse;
				const limits = payload.data?.limits ?? [];
				if (limits.length === 0) {
					ctx.ui.notify("ClinePass returned no usage limits", "warning");
					return;
				}
				const level = limits.some((limit) => (limit.percentUsed ?? 0) >= 90) ? "warning" : "info";
				ctx.ui.notify(`ClinePass usage\n${formatUsageLimits(limits, Date.now())}`, level);
			} catch (error) {
				if (ctx.signal?.aborted) return;
				ctx.ui.notify(
					`ClinePass usage check failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.registerProvider(PROVIDER_ID, {
		name: "ClinePass",
		baseUrl: CLINE_API,
		api: "openai-completions",
		authHeader: true,
		headers: {
			"User-Agent": "pi-clinepass-native",
		},
		refreshModels: (context) => refreshClinePassModels(context),
		oauth: {
			name: "ClinePass",
			isSubscription: true,
			login,
			refreshToken,
			getApiKey,
		},
	});
}
