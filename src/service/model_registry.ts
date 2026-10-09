import { ChatRunOptions, ILLM } from "../interfaces/illm";
import { LLMProvider } from "../llms/llm_factory";
import { OpenAIProvider } from "../llms/openai_provider";
import { AnthropicProvider } from "../llms/anthropic_provider";
import { OpenAICompatibleProvider, errorMessage } from "../llms/openai_compatible_provider";
import { UsageTrackingLLM } from "../llms/usage_tracking";
import { LLMKeyInput, LLMKeyKind, LLMKeyRepository, LLMKeyRow } from "../repository/llm_key_repository";
import { UsageRepository } from "../repository/usage_repository";
import { MessageService } from "./message_service";
import { LLMTool } from "../tools/tool_registry";
import { IFileStore } from "../interfaces/ifilestore";
import { LLMConfig } from "../types/lmconfig";
import { LLMMessage } from "../types/llm_message";
import { decryptSecret, encryptSecret } from "./agents/secrets";
import { assertPublicUrl } from "./agents/url_guard";
import type { MarketplaceService } from "../core/marketplace/marketplace_service";
import { WalletLLM } from "../core/marketplace/wallet_llm";
import { FailoverLLM } from "../core/marketplace/failover_llm";
import type { Route } from "../core/marketplace/router";

// Every place that runs a model (web chat, agents, WhatsApp) asks this
// registry for it. It merges the server's own providers (.env keys) with
// each user's own keys (BYOK), so one id names any choice:
//   "openai" / "anthropic"   — the server's keys (count toward the plan)
//   "key:<uuid>"             — the user's own key (never counts toward the plan)

const KEY_PREFIX = "key:";
const MAX_KEYS_PER_USER = 20;
const MAX_MODELS_PER_KEY = 300;
const MODEL_ID = /^[\w.:/@+\-]{1,200}$/;
const LABEL_MAX = 60;
const LLM_CACHE_MAX = 500;
const TEST_TIMEOUT_MS = 15_000;

const PLATFORM_LABELS: Record<string, string> = { openai: "ChatGPT", anthropic: "Claude" };
const KIND_LABELS: Record<LLMKeyKind, string> = { openai: "OpenAI", anthropic: "Anthropic", openai_compatible: "OpenAI-compatible" };
const DEFAULT_BASE: Partial<Record<LLMKeyKind, string>> = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com/v1",
};

export class RegistryError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
    }
}

export type ModelOption = { id: string; label: string };
export type ProviderOption = {
    id: string;                 // "openai" | "anthropic" | "key:<uuid>"
    label: string;
    kind: string;
    byok: boolean;
    defaultModel: string;
    models: ModelOption[];
};
export type Resolved = { llm: ILLM; provider: string; model: string; byok: boolean };

// "claude-sonnet-5-5" → "Claude Sonnet 5.5", "gpt-4o-mini" → "GPT-4o mini";
// "meta-llama/llama-3.3-70b-instruct" → "llama-3.3-70b-instruct".
export function modelLabel(id: string): string {
    const claude = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/);
    if (claude) {
        const [, family, major, minor] = claude;
        return `Claude ${family[0].toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
    }
    if (id.startsWith("gpt-")) return `GPT-${id.slice(4).replace(/-/g, " ")}`;
    return id.includes("/") ? id.split("/").pop()! : id;
}

// What the API returns about a key — never the key itself.
export function keyDto(k: LLMKeyRow) {
    return {
        id: k.id,
        providerId: KEY_PREFIX + k.id,
        kind: k.kind,
        kindLabel: KIND_LABELS[k.kind],
        label: k.label,
        baseUrl: k.base_url,
        keyHint: k.key_hint,
        models: k.models,
        defaultModel: k.default_model,
        enabled: k.enabled,
        lastVerifiedAt: k.last_verified_at,
        lastError: k.last_error,
        createdAt: k.created_at,
        updatedAt: k.updated_at,
    };
}

const hint = (key: string) => (key.length > 8 ? `••••${key.slice(-4)}` : "••••");
const hostName = (base: string) => {
    try {
        const h = new URL(base).hostname.replace(/^(www|api)\./, "");
        return h.split(".")[0] || "openai_compatible";
    } catch {
        return "openai_compatible";
    }
};

type Deps = {
    platform: Map<LLMProvider, ILLM>;
    defaultProvider: LLMProvider;
    repo: LLMKeyRepository;
    usage: UsageRepository;
    messageService: MessageService;
    tools: LLMTool;
    fileStore?: IFileStore;
    // The model marketplace (OpenRouter models paid from the user's credits).
    marketplace?: MarketplaceService;
};

export const MARKET_PROVIDER = "market";

export class ModelRegistry {
    private cache = new Map<string, { stamp: number; llm: ILLM }>();

    constructor(private deps: Deps) {}

    get defaultProvider(): string { return this.deps.defaultProvider; }

    // The server's own providers (no user context) — used where BYOK can't apply.
    platformProvider(id?: string | null): ILLM {
        return this.deps.platform.get((id ?? this.deps.defaultProvider) as LLMProvider) ?? this.deps.platform.get(this.deps.defaultProvider)!;
    }

    // ── what a user can pick ──
    async listFor(userId: string): Promise<{ providers: ProviderOption[]; defaultProvider: string }> {
        const platform: ProviderOption[] = [...this.deps.platform.entries()].map(([id, llm]) => ({
            id,
            label: PLATFORM_LABELS[id] ?? id,
            kind: id,
            byok: false,
            defaultModel: llm.getModel(),
            models: (llm.getModels?.() ?? [llm.getModel()]).map((m) => ({ id: m, label: modelLabel(m) })),
        }));
        const keys = (await this.deps.repo.list(userId)).filter((k) => k.enabled && k.models.length);
        const own: ProviderOption[] = keys.map((k) => ({
            id: KEY_PREFIX + k.id,
            label: `${k.label} · your key`,
            kind: k.kind,
            byok: true,
            defaultModel: k.default_model && k.models.includes(k.default_model) ? k.default_model : k.models[0],
            models: k.models.map((m) => ({ id: m, label: modelLabel(m) })),
        }));
        const market = await this.marketOption(userId).catch(() => null);
        return { providers: [...platform, ...own, ...(market ? [market] : [])], defaultProvider: this.deps.defaultProvider };
    }

    // The user's marketplace models (added from the Models page), if any.
    private async marketOption(userId: string): Promise<ProviderOption | null> {
        const m = this.deps.marketplace;
        if (!m?.enabled) return null;
        const ids = await m.favorites(userId);
        if (!ids.length) return null;
        const models = await Promise.all(ids.map(async (id) => ({ id, label: (await m.catalog.get(id).catch(() => null))?.name ?? id })));
        return { id: MARKET_PROVIDER, label: "Marketplace · credits", kind: MARKET_PROVIDER, byok: false, defaultModel: ids[0], models };
    }

    // A marketplace model for a chat turn, billed to the user's credits.
    private async resolveMarket(userId: string, model: string | null | undefined, strict: boolean): Promise<Resolved | null> {
        const m = this.deps.marketplace;
        if (!m?.enabled) {
            if (strict) throw new RegistryError("The model marketplace isn't available on this server", 404);
            return null;
        }
        const known = async (id: string | null | undefined) => !!id && !!(await m.catalog.get(id).catch(() => null));
        let chosen: string | null = model ?? null;
        if (chosen && !(await known(chosen))) {
            if (strict) throw new RegistryError(`Model "${chosen}" isn't in the marketplace`);
            chosen = null;
        }
        // No (valid) model given: the user's first marketplace model still offered.
        if (!chosen) {
            for (const id of await m.favorites(userId)) if (await known(id)) { chosen = id; break; }
        }
        if (!chosen) {
            if (strict) throw new RegistryError("Pick a marketplace model on the Models page first");
            return null;
        }
        const modelId = chosen;
        const { messageService, tools } = this.deps;
        // One provider per route: Claude through the native Claude provider,
        // everything else (OpenAI, Google, DeepInfra, Groq, OpenRouter…) OpenAI-compatible.
        const build = (route: Route): ILLM => {
            const config: LLMConfig = {
                model: route.upstreamModel, models: [route.upstreamModel],
                temperature: Number(process.env.LLM_TEMPERATURE ?? 0.7),
                maxTokens: route.kind === "anthropic" ? Number(process.env.ANTHROPIC_MAX_TOKENS ?? 64000) : Number(process.env.BYOK_MAX_TOKENS ?? 8192),
            };
            const inner = route.kind === "anthropic"
                ? new AnthropicProvider(route.apiKey, config, messageService, tools)
                : new OpenAICompatibleProvider(route.apiKey, route.baseUrl, config, messageService, tools, "marketplace");
            return new WalletLLM(inner, m, route, modelId);
        };
        const failover = new FailoverLLM(modelId, (sessionId) => m.routes(modelId, sessionId), build, m.router);
        // Paid from credits, so it doesn't count toward the plan's token quota.
        const llm = new UsageTrackingLLM(failover, this.deps.usage, { keyId: null });
        return { llm, provider: MARKET_PROVIDER, model: chosen, byok: true };
    }

    // ── picking a model for a request ──
    // `strict`: reject an unknown provider/model (web requests). Otherwise fall
    // back to the server default (stored choices that went stale, e.g. a key
    // the user deleted).
    async resolve(userId: string, providerId?: string | null, model?: string | null, strict = false): Promise<Resolved> {
        if (providerId === MARKET_PROVIDER) {
            const market = await this.resolveMarket(userId, model, strict);
            if (market) return market;
            providerId = null;
            model = null;
        }
        if (providerId && providerId.startsWith(KEY_PREFIX)) {
            const key = await this.deps.repo.get(userId, providerId.slice(KEY_PREFIX.length));
            if (key && key.enabled && key.models.length) {
                if (model && !key.models.includes(model)) {
                    if (strict) throw new RegistryError(`Model "${model}" isn't on your "${key.label}" key's list`);
                    model = null;
                }
                const chosen = model ?? (key.default_model && key.models.includes(key.default_model) ? key.default_model : key.models[0]);
                return { llm: this.llmForKey(key), provider: providerId, model: chosen, byok: true };
            }
            if (strict) throw new RegistryError("That API key was removed or turned off — pick another model", 404);
            providerId = null;
            model = null;
        }

        const id = (providerId && this.deps.platform.has(providerId as LLMProvider) ? providerId : null)
            ?? (strict && providerId ? null : this.deps.defaultProvider);
        if (!id) throw new RegistryError(`Provider "${providerId}" isn't available`);
        const llm = this.deps.platform.get(id as LLMProvider)!;
        const models = llm.getModels?.() ?? [llm.getModel()];
        if (model && !models.includes(model)) {
            if (strict) throw new RegistryError(`Model "${model}" isn't available for ${PLATFORM_LABELS[id] ?? id}`);
            model = null;
        }
        return { llm, provider: id, model: model ?? llm.getModel(), byok: false };
    }

    // Checks a provider/model pair a user wants to store (e.g. on an agent).
    async validateChoice(userId: string, providerId: string, model: string | null): Promise<void> {
        await this.resolve(userId, providerId, model, true);
    }

    // ── building a provider on a user's key (cached until the key changes) ──
    private llmForKey(key: LLMKeyRow): ILLM {
        const stamp = new Date(key.updated_at).getTime();
        const hit = this.cache.get(key.id);
        if (hit && hit.stamp === stamp) {
            this.cache.delete(key.id);
            this.cache.set(key.id, hit);   // most recently used last
            return hit.llm;
        }
        const apiKey = decryptSecret(key.api_key_enc);
        const config: LLMConfig = {
            model: key.default_model && key.models.includes(key.default_model) ? key.default_model : key.models[0],
            models: key.models,
            temperature: Number(process.env.LLM_TEMPERATURE ?? 0.7),
            maxTokens: key.kind === "anthropic"
                ? Number(process.env.ANTHROPIC_MAX_TOKENS ?? 64000)
                : key.kind === "openai"
                    ? Number(process.env.LLM_MAX_TOKENS ?? 16384)
                    // Model limits vary across services; requests that exceed one are retried without a cap.
                    : Number(process.env.BYOK_MAX_TOKENS ?? 8192),
        };
        const { messageService, tools, fileStore } = this.deps;
        let inner: ILLM;
        if (key.kind === "openai") inner = new OpenAIProvider(apiKey, config, messageService, tools, fileStore);
        else if (key.kind === "anthropic") inner = new AnthropicProvider(apiKey, config, messageService, tools);
        else inner = new OpenAICompatibleProvider(apiKey, key.base_url!, config, messageService, tools, hostName(key.base_url!));

        const llm = new UsageTrackingLLM(new OwnKeyLLM(inner, apiKey, key.id, this.deps.repo), this.deps.usage, { keyId: key.id });
        this.cache.set(key.id, { stamp, llm });
        while (this.cache.size > LLM_CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
        return llm;
    }

    // ── managing keys ──
    async listKeys(userId: string) {
        return (await this.deps.repo.list(userId)).map(keyDto);
    }

    // Tests a key (new, or an existing one by id) and lists the models it can use.
    async test(userId: string, body: any): Promise<{ ok: true; models: string[] }> {
        const existing = body?.id ? await this.deps.repo.get(userId, String(body.id)) : null;
        if (body?.id && !existing) throw new RegistryError("Key not found", 404);
        const kind = this.kind(body?.kind ?? existing?.kind);
        const baseUrl = await this.baseUrl(kind, body?.baseUrl ?? existing?.base_url);
        const apiKey = this.apiKeyFrom(body, existing, kind);
        const models = await listRemoteModels(kind, baseUrl, apiKey);
        return { ok: true, models };
    }

    async createKey(userId: string, body: any) {
        if ((await this.deps.repo.count(userId)) >= MAX_KEYS_PER_USER) {
            throw new RegistryError(`You can save up to ${MAX_KEYS_PER_USER} API keys`);
        }
        const input = await this.input(body, null);
        await this.assertNameFree(userId, input.label, null);
        // Saved only if the key works — and every model is one the provider has.
        const available = await listRemoteModels(input.kind, input.base_url ?? DEFAULT_BASE[input.kind]!, decryptSecret(input.api_key_enc));
        assertModelsExist(available, input.models);
        try {
            return keyDto(await this.deps.repo.create(userId, input));
        } catch (err: any) {
            if (err?.code === "23505" || /unique/i.test(String(err?.message))) throw new RegistryError(`You already have a key named "${input.label}"`, 409);
            throw err;
        }
    }

    async updateKey(userId: string, id: string, body: any) {
        const existing = await this.deps.repo.get(userId, id);
        if (!existing) throw new RegistryError("Key not found", 404);
        const input = await this.input(body, existing);
        await this.assertNameFree(userId, input.label, id);
        // Re-verify when anything that affects the connection changed.
        const connectionChanged = input.api_key_enc !== existing.api_key_enc || input.base_url !== existing.base_url || input.kind !== existing.kind;
        const added = input.models.filter((m) => !existing.models.includes(m));
        if (connectionChanged || added.length) {
            const available = await listRemoteModels(input.kind, input.base_url ?? DEFAULT_BASE[input.kind]!, decryptSecret(input.api_key_enc));
            // A new connection re-checks every model; otherwise only the newly added ones.
            assertModelsExist(available, connectionChanged ? input.models : added);
        }
        try {
            const row = await this.deps.repo.update(userId, id, input, connectionChanged);
            this.cache.delete(id);
            return keyDto(row!);
        } catch (err: any) {
            if (err?.code === "23505" || /unique/i.test(String(err?.message))) throw new RegistryError(`You already have a key named "${input.label}"`, 409);
            throw err;
        }
    }

    async deleteKey(userId: string, id: string): Promise<void> {
        if (!(await this.deps.repo.remove(userId, id))) throw new RegistryError("Key not found", 404);
        this.cache.delete(id);
    }

    // ── validation ──
    private async assertNameFree(userId: string, label: string, exceptId: string | null): Promise<void> {
        const taken = (await this.deps.repo.list(userId)).some((k) => k.id !== exceptId && k.label.toLowerCase() === label.toLowerCase());
        if (taken) throw new RegistryError(`You already have a key named "${label}"`, 409);
    }

    private kind(raw: unknown): LLMKeyKind {
        if (raw === "openai" || raw === "anthropic" || raw === "openai_compatible") return raw;
        throw new RegistryError("Choose a provider: openai, anthropic or openai_compatible");
    }

    private async baseUrl(kind: LLMKeyKind, raw: unknown): Promise<string> {
        if (kind !== "openai_compatible") return DEFAULT_BASE[kind]!;
        const value = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
        if (!value) throw new RegistryError("Enter the service's base URL, e.g. https://openrouter.ai/api/v1");
        let url: URL;
        try {
            url = await assertPublicUrl(value);
        } catch (err) {
            throw new RegistryError(err instanceof Error ? err.message : "That URL isn't allowed");
        }
        // Keys only travel over HTTPS, except to a local server in development.
        if (url.protocol !== "https:" && process.env.AGENT_ALLOW_PRIVATE_URLS !== "true") {
            throw new RegistryError("Use an https:// address so your key is sent encrypted");
        }
        if (value.length > 300) throw new RegistryError("Base URL is too long");
        return value;
    }

    private apiKeyFrom(body: any, existing: LLMKeyRow | null, kind: LLMKeyKind): string {
        const raw = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
        if (raw) {
            if (raw.length > 500 || /\s/.test(raw)) throw new RegistryError("That doesn't look like an API key");
            return raw;
        }
        if (existing) return decryptSecret(existing.api_key_enc);
        // A local server (e.g. Ollama) may not need a key at all.
        if (kind === "openai_compatible") return "";
        throw new RegistryError("Paste your API key");
    }

    private async input(body: any, existing: LLMKeyRow | null): Promise<LLMKeyInput> {
        const kind = this.kind(body?.kind ?? existing?.kind);
        const label = (typeof body?.label === "string" ? body.label : existing?.label ?? "").trim();
        if (!label) throw new RegistryError("Give the key a name, e.g. \"My OpenRouter\"");
        if (label.length > LABEL_MAX) throw new RegistryError(`Keep the name under ${LABEL_MAX} characters`);
        const base = await this.baseUrl(kind, body?.baseUrl ?? existing?.base_url);
        const apiKey = this.apiKeyFrom(body, existing, kind);

        const rawModels: unknown[] = Array.isArray(body?.models) ? body.models : existing?.models ?? [];
        const models = [...new Set(rawModels.map((m) => String(m).trim()).filter(Boolean))];
        if (!models.length) throw new RegistryError("Pick at least one model");
        if (models.length > MAX_MODELS_PER_KEY) throw new RegistryError(`Up to ${MAX_MODELS_PER_KEY} models per key`);
        const bad = models.find((m) => !MODEL_ID.test(m));
        if (bad) throw new RegistryError(`"${bad.slice(0, 60)}" isn't a valid model id`);
        const requestedDefault = typeof body?.defaultModel === "string" ? body.defaultModel : existing?.default_model ?? null;
        const default_model = requestedDefault && models.includes(requestedDefault) ? requestedDefault : models[0];

        const reuse = existing && !body?.apiKey ? existing.api_key_enc : null;
        return {
            kind,
            label,
            base_url: kind === "openai_compatible" ? base : null,
            api_key_enc: reuse ?? encryptSecret(apiKey),
            key_hint: reuse ? existing!.key_hint : apiKey ? hint(apiKey) : "no key",
            models,
            default_model,
            enabled: typeof body?.enabled === "boolean" ? body.enabled : existing?.enabled ?? true,
        };
    }
}

// Binds a provider to the user's key and notes auth failures on the key, so
// the API keys page can say "this key stopped working".
class OwnKeyLLM implements ILLM {
    constructor(private inner: ILLM, private apiKey: string, private keyId: string, private repo: LLMKeyRepository) {}
    chat(m: LLMMessage[], t: any) { return this.inner.chat(m, t); }
    summarizeChat(m: any, u: string, s: string) { return this.inner.summarizeChat(m, u, s); }
    getProvider() { return this.inner.getProvider(); }
    getModel() { return this.inner.getModel(); }
    getModels() { return this.inner.getModels?.() ?? [this.inner.getModel()]; }
    supportsTools() { return this.inner.supportsTools(); }

    async *chatStream(messages: LLMMessage[], userId: string, sessionId: string, _apiKey: string, signal: AbortSignal, model?: string, run?: ChatRunOptions): AsyncGenerator<LLMMessage, void, unknown> {
        // Callers pass the server's OpenAI key; the user's key replaces it.
        for await (const chunk of this.inner.chatStream(messages, userId, sessionId, this.apiKey, signal, model, run)) {
            if (chunk.type === "error" && (chunk as any).code === "auth") {
                void this.repo.recordError(this.keyId, String((chunk as any).message ?? "Authentication failed")).catch(() => {});
            }
            yield chunk;
        }
    }
}

// Lists the models a key can use — also how a key is verified.
export async function listRemoteModels(kind: LLMKeyKind, baseUrl: string, apiKey: string): Promise<string[]> {
    const headers: Record<string, string> = kind === "anthropic"
        ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
        : apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    let res: Response;
    try {
        res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models${kind === "anthropic" ? "?limit=1000" : ""}`, {
            headers,
            signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
        });
    } catch (err) {
        const timeout = err instanceof Error && err.name === "TimeoutError";
        throw new RegistryError(timeout ? "The provider didn't answer in time" : "Couldn't reach the provider — check the base URL", 502);
    }
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new RegistryError(errorMessage(res.status, body), res.status === 401 || res.status === 403 ? 400 : 502);
    }
    const json: any = await res.json().catch(() => ({}));
    const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : Array.isArray(json) ? json : [];
    let ids = list.map((m) => String(m?.id ?? m?.name ?? "")).filter((id) => id && MODEL_ID.test(id));
    // OpenAI's list includes embeddings, audio, images… keep the chat models.
    if (kind === "openai") ids = ids.filter((id) => /^(gpt-|o\d|chatgpt-|ft:)/.test(id) && !/(audio|realtime|transcribe|tts|image|search|embedding)/.test(id));
    return [...new Set(ids)].sort();
}

// Rejects model ids the provider doesn't offer (typos like "openAI-4o-mini"),
// suggesting the closest real one. Skipped when the provider lists no models.
export function assertModelsExist(available: string[], models: string[]): void {
    if (!available.length) return;
    const have = new Set(available);
    const unknown = models.filter((m) => !have.has(m));
    if (!unknown.length) return;
    const first = unknown[0];
    const hint = closest(first, available);
    throw new RegistryError(
        `"${first}" isn't a model on this key${unknown.length > 1 ? ` (nor ${unknown.length - 1} more)` : ""}.` +
        (hint ? ` Did you mean "${hint}"?` : " Use \"Check key & load models\" to pick from the provider's list."),
    );
}

function closest(target: string, options: string[]): string | null {
    const norm = (x: string) => x.toLowerCase().replace(/^openai[-/]?/, "gpt-");
    const t = norm(target);
    let best: string | null = null;
    let bestScore = Infinity;
    for (const o of options) {
        const d = editDistance(t, o.toLowerCase());
        if (d < bestScore) { bestScore = d; best = o; }
    }
    return best && bestScore <= Math.max(3, Math.floor(target.length / 3)) ? best : null;
}

function editDistance(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        let prev = row[0]++;
        for (let j = 1; j <= b.length; j++) {
            const cur = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
            prev = cur;
        }
    }
    return row[b.length];
}
