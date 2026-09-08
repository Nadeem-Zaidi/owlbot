import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

import { ILLM } from "../interfaces/illm";
import { LLMConfig } from "../types/lmconfig";
import { OpenAIProvider } from "./openai_provider";
import { MessageService } from "../service/message_service";
import { LLMTool } from "../tools/tool_registry";

export type LLMProvider = "openai" | "ollama" | "gemma";

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
}

export class LLMFactory {
    static create({
        provider,
        config,
        messageService,
        toolRegistry,
        context = { userId: "", sessionId: "" }, // still unused below — fine as a forward-looking default, drop it if you don't need it soon
    }: CreateOptions): ILLM {
        switch (provider) {
            case "openai": {
                const apiKey = process.env.OPENAI_API_KEY;
                if (!apiKey) {
                    // NEW — fails here with a clear message instead of
                    // deep inside the OpenAI SDK on the first real request
                    throw new Error("OPENAI_API_KEY is not set");
                }
                return new OpenAIProvider(apiKey, config, messageService, toolRegistry);
            }
            case "gemma":
            case "ollama":
                throw new Error(`Provider "${provider}" is not yet implemented`);

            default:
                throw new Error(`Unknown LLM provider: ${provider}`);
        }
    }

    static createFromEnv(messageService: MessageService, toolRegistry: LLMTool): ILLM {
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

        return LLMFactory.create({
            provider: "openai",
            config: {
                model: process.env.OPENAI_MODEL || "gpt-4o-mini",
                temperature,
                maxTokens,
                // NEW — toolRegistry no longer smuggled in here. LLMConfig
                // stays pure model config; it's not a dependency bag.
            },
            messageService,
            toolRegistry, // NEW — passed where OpenAIProvider's constructor actually reads it
        });
    }
}