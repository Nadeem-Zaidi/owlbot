import { MarketConfig } from "./market_config";

// Thin client for OpenRouter (https://openrouter.ai/docs). The model list and
// each model's providers are public; chat and account calls use the owner's key.

export type ORModel = {
    id: string;
    name: string;
    created?: number;
    description?: string;
    context_length?: number | null;
    architecture?: { input_modalities?: string[]; output_modalities?: string[]; modality?: string };
    pricing?: Record<string, string | number | undefined>;
    top_provider?: { context_length?: number | null; max_completion_tokens?: number | null; is_moderated?: boolean };
    supported_parameters?: string[];
    hugging_face_id?: string | null;
    expiration_date?: string | null;
};

export type OREndpoint = {
    name?: string;
    provider_name: string;
    tag?: string;
    quantization?: string | null;
    context_length?: number | null;
    max_completion_tokens?: number | null;
    pricing?: Record<string, string | number | undefined>;
    supported_parameters?: string[];
    status?: number;
    uptime_last_1d?: number | null;
    uptime_last_30m?: number | null;
    latency_last_30m?: unknown;
    throughput_last_30m?: unknown;
};

export class OpenRouterError extends Error {
    constructor(public status: number, message: string) {
        super(message);
    }
}

export class OpenRouterClient {
    constructor(private cfg: Pick<MarketConfig, "apiKey" | "baseUrl">) {}

    get configured() { return !!this.cfg.apiKey; }

    headers(json = true): Record<string, string> {
        return {
            ...(json ? { "Content-Type": "application/json" } : {}),
            ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
            "X-Title": "Owl Bot",
            ...(process.env.WEB_APP_URL ? { "HTTP-Referer": process.env.WEB_APP_URL } : {}),
        };
    }

    private async getJson<T>(path: string, auth = false, timeoutMs = 20_000): Promise<T> {
        const res = await fetch(`${this.cfg.baseUrl}${path}`, { headers: auth ? this.headers(false) : { "X-Title": "Owl Bot" }, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new OpenRouterError(res.status, `OpenRouter ${path} failed (${res.status})`);
        return res.json() as Promise<T>;
    }

    async models(): Promise<ORModel[]> {
        return (await this.getJson<{ data: ORModel[] }>("/models")).data ?? [];
    }

    async endpoints(modelId: string): Promise<OREndpoint[]> {
        const path = `/models/${modelId.split("/").map(encodeURIComponent).join("/")}/endpoints`;
        return (await this.getJson<{ data: { endpoints?: OREndpoint[] } }>(path)).data?.endpoints ?? [];
    }

    // The owner's OpenRouter balance (to keep it topped up).
    async credits(): Promise<{ total: number; used: number }> {
        const d = (await this.getJson<{ data: { total_credits: number; total_usage: number } }>("/credits", true)).data;
        return { total: Number(d?.total_credits ?? 0), used: Number(d?.total_usage ?? 0) };
    }

    // Cost of a finished generation (when the response's usage didn't arrive, e.g. a dropped stream).
    async generationCost(id: string): Promise<{ cost: number; input: number; output: number } | null> {
        try {
            const d = (await this.getJson<{ data: any }>(`/generation?id=${encodeURIComponent(id)}`, true)).data;
            if (!d) return null;
            return { cost: Number(d.total_cost ?? d.usage ?? 0), input: Number(d.tokens_prompt ?? d.native_tokens_prompt ?? 0), output: Number(d.tokens_completion ?? d.native_tokens_completion ?? 0) };
        } catch {
            return null;
        }
    }

    // Raw chat completion request (the caller streams or parses the response).
    chat(body: unknown, signal: AbortSignal): Promise<Response> {
        return fetch(`${this.cfg.baseUrl}/chat/completions`, {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify(body),
            signal,
        });
    }
}
