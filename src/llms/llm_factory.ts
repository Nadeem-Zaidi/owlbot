import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { ILLM } from "../interfaces/illm";
import { LLMConfig } from "../types/lmconfig";
import { OpenAIProvider } from "./openai_provider";
import { AnthropicProvider } from "./anthropic_provider";
import { MessageService } from "../service/message_service";
import { LLMTool } from "../tools/tool_registry";
import { IFileStore } from "../interfaces/ifilestore";

export type LLMProvider = "openai" | "anthropic" | "ollama" | "gemma";

interface LLMContext {
    userId: string;   // NEW — was userid/sessionid, now matches chatStream's casing elsewhere
    sessionId: string;
}

// NEW — named options instead of 5 positional params. The bug you hit
// (toolRegistry silently dropped in one branch, stuffed into the wrong
// object in the other) is exactly the failure mode positional args of
// similar shape invite — this makes both mistakes a compile error instead
// of a silent no-op.
interface CreateOptions {
    provider: LLMProvider;
    config: LLMConfig;
    messageService: MessageService;
    toolRegistry: LLMTool;
    context?: LLMContext;
    // Optional — lets OpenAIProvider mirror code-interpreter-generated
    // files to S3 so chat history stays viewable after OpenAI's container
    // recycles. Omit it and that mirroring is just silently skipped.
    fileStore?: IFileStore;
}

export class LLMFactory {
    static create({
        provider,
        config,
        messageService,
        toolRegistry,
        context = { userId: "", sessionId: "" }, // still unused below — fine as a forward-looking default, drop it if you don't need it soon
        fileStore,
    }: CreateOptions): ILLM {
        switch (provider) {
            case "openai": {
                const apiKey = process.env.OPENAI_API_KEY;
                if (!apiKey) {
                    // NEW — fails here with a clear message instead of
                    // deep inside the OpenAI SDK on the first real request
                    throw new Error("OPENAI_API_KEY is not set");
                }
                return new OpenAIProvider(apiKey, config, messageService, toolRegistry, fileStore);
            }
            case "anthropic": {
                const apiKey = process.env.ANTHROPIC_API_KEY;
                if (!apiKey) {
                    throw new Error("ANTHROPIC_API_KEY is not set");
                }
                return new AnthropicProvider(apiKey, config, messageService, toolRegistry);
            }
            case "gemma":
            case "ollama":
                throw new Error(`Provider "${provider}" is not yet implemented`);

            default:
                throw new Error(`Unknown LLM provider: ${provider}`);
        }
    }

    static createFromEnv(messageService: MessageService, toolRegistry: LLMTool, fileStore?: IFileStore): ILLM {
        const useLocalLLM = process.env.USE_LOCAL_LLM === "true";
        const temperature = process.env.LLM_TEMPERATURE
            ? parseFloat(process.env.LLM_TEMPERATURE)
            : 0.7;
        const maxTokens = process.env.LLM_MAX_TOKENS
            ? parseInt(process.env.LLM_MAX_TOKENS, 10)
            : 4096;

        if (useLocalLLM) {
            return LLMFactory.create({
                provider: "gemma",
                config: {
                    model: process.env.OLLAMA_MODEL || "gemma:1b",
                    temperature,
                    maxTokens,
                },
                messageService,
                toolRegistry, // NEW — was missing entirely, causing a compile error
            });
        }

        const provider = (process.env.LLM_PROVIDER || "openai") as LLMProvider;
        return LLMFactory.create({
            provider,
            config: LLMFactory.configFromEnv(provider),
            messageService,
            toolRegistry,
            fileStore,
        });
    }

    // Builds every cloud provider whose API key is set, so the user can pick
    // one per chat. The default (LLM_PROVIDER, falling back to whichever is
    // available) is what a request gets when it doesn't name a provider.
    static createAllFromEnv(messageService: MessageService, toolRegistry: LLMTool, fileStore?: IFileStore): { providers: Map<LLMProvider, ILLM>; defaultProvider: LLMProvider } {
        const providers = new Map<LLMProvider, ILLM>();
        const keys: Partial<Record<LLMProvider, string | undefined>> = {
            openai: process.env.OPENAI_API_KEY,
            anthropic: process.env.ANTHROPIC_API_KEY,
        };

        for (const [provider, key] of Object.entries(keys) as [LLMProvider, string | undefined][]) {
            if (!key) continue;
            providers.set(provider, LLMFactory.create({
                provider,
                config: LLMFactory.configFromEnv(provider),
                messageService,
                toolRegistry,
                fileStore,
            }));
        }

        if (!providers.size) {
            throw new Error("No LLM provider configured — set OPENAI_API_KEY and/or ANTHROPIC_API_KEY");
        }

        const preferred = process.env.LLM_PROVIDER as LLMProvider | undefined;
        const defaultProvider = preferred && providers.has(preferred) ? preferred : providers.keys().next().value!;
        return { providers, defaultProvider };
    }

    private static configFromEnv(provider: LLMProvider): LLMConfig {
        const temperature = process.env.LLM_TEMPERATURE
            ? parseFloat(process.env.LLM_TEMPERATURE)
            : 0.7;

        if (provider === "anthropic") {
            const model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
            return {
                model,
                models: LLMFactory.modelList(model, process.env.ANTHROPIC_MODELS ?? "claude-opus-5-5,claude-sonnet-5-5,claude-haiku-4-5"),
                // Not sent to Claude — current Claude models reject sampling params.
                temperature,
                // Streaming, so a generous cap is safe; 4096 truncates long answers.
                maxTokens: process.env.ANTHROPIC_MAX_TOKENS
                    ? parseInt(process.env.ANTHROPIC_MAX_TOKENS, 10)
                    : 64000,
            };
        }

        const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
        return {
            model,
            models: LLMFactory.modelList(model, process.env.OPENAI_MODELS ?? ""),
            temperature,
            maxTokens: process.env.LLM_MAX_TOKENS
                ? parseInt(process.env.LLM_MAX_TOKENS, 10)
                : 4096,
        };
    }

    // Comma-separated env list → de-duplicated array with the default model first.
    private static modelList(defaultModel: string, csv: string): string[] {
        const listed = csv.split(",").map((m) => m.trim()).filter(Boolean);
        return [...new Set([defaultModel, ...listed])];
    }
}