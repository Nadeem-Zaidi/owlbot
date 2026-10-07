import "dotenv/config";  
import dotenv from "dotenv";
import { InvalidSession, SessionValidationError, ValidationError } from "../error_handling/app_error";
import { BaseRouter } from "./base_router";
import { MessageService } from "../service/message_service";
import { ILLM } from "../interfaces/illm";
import { LLMMessage } from "../types/llm_message";
import { LLMProvider } from "../llms/llm_factory";
import { AgentService } from "../service/agents/agent_service";
import { ChatRunOptions } from "../interfaces/illm";
import { NativeAgentService } from "../service/native_agents/native_agent_service";
import { KnowledgeBase } from "../service/knowledge_base";
import { withAttachmentText } from "../service/attachment_text";
import { BillingService } from "../service/billing/billing_service";
import { ModelRegistry } from "../service/model_registry";
dotenv.config();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const MAX_PINNED = 50;

const PROVIDER_LABELS: Partial<Record<LLMProvider, string>> = {
    openai: "ChatGPT",
    anthropic: "Claude",
};

// "claude-sonnet-5-5" → "Claude Sonnet 5.5", "gpt-4o-mini" → "GPT-4o mini".
// Anything unrecognised is shown as its raw id.
function modelLabel(id: string): string {
    const claude = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?$/);
    if (claude) {
        const [, family, major, minor] = claude;
        return `Claude ${family[0].toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}`;
    }
    if (id.startsWith("gpt-")) return `GPT-${id.slice(4).replace(/-/g, " ")}`;
    return id;
}

export class ChatMessages extends BaseRouter<MessageService> {
    providers: Map<LLMProvider, ILLM>;
    defaultProvider: LLMProvider;

    agents?: AgentService;
    nativeAgents?: NativeAgentService;
    kb?: KnowledgeBase;
    billing?: BillingService;
    // Server providers + the user's own keys (BYOK). Set from main.ts.
    registry?: ModelRegistry;

    constructor(messsageService: MessageService, providers: Map<LLMProvider, ILLM>, defaultProvider: LLMProvider, agents?: AgentService, nativeAgents?: NativeAgentService, kb?: KnowledgeBase) {
        super("/session", messsageService)
        this.providers = providers
        this.defaultProvider = defaultProvider
        this.agents = agents
        this.nativeAgents = nativeAgents
        this.kb = kb
    }
    registerRouter() {
        this.router.get("/messages", this.asyncHandler(async (req, res) => {
            res.send({ message: "working" });


        }));

        // Lists the providers that have an API key configured, so the UI's
        // model picker only offers ones that will actually work.
        this.router.get("/providers", this.asyncHandler(async (req, res) => {
            if (this.registry) return res.status(200).json(await this.registry.listFor(req.user!.sub));
            const providers = [...this.providers.entries()].map(([id, llm]) => ({
                id,
                label: PROVIDER_LABELS[id] ?? id,
                defaultModel: llm.getModel(),
                models: (llm.getModels?.() ?? [llm.getModel()]).map((m) => ({ id: m, label: modelLabel(m) })),
            }));
            return res.status(200).json({ providers, defaultProvider: this.defaultProvider });
        }));

        this.router.get("/get_session/:sessionId", this.asyncHandler(async (req, res) => {
            const { sessionId } = req.params; 
            try {
                if (!sessionId) throw new InvalidSession();
                const id = await this.service.getSession(sessionId as string, req.user!.sub);
                return res.status(200).json(id);
            } catch (err) {
                throw err;
            }
        }));

        this.router.get("/load_messages/:sessionId", this.asyncHandler(async (req, res) => {
            const { sessionId } = req.params; // was req.query.sessionId



            if (!sessionId) throw new InvalidSession();

            const isSessionValid: boolean = await this.service.isSessionValid(sessionId as string, req.user!.sub);
            if (!isSessionValid) throw new SessionValidationError();

            const sessions = await this.service.loadMessages(sessionId as string);
            return res.status(200).json(sessions);
        }));
        this.router.post("/new_session", this.asyncHandler(async (req, res) => {
            const userId = req.user!.sub;
            if (!userId) throw new ValidationError("user Id missing")
            const createdSessionId = await this.service.createSession(userId);
            return res.status(200).json(createdSessionId);

        }));

        this.router.get("/load_sessions", this.asyncHandler(async (req, res) => {
            const sessions = await this.service.getUserSessions(req.user!.sub);
            return res.status(200).json(sessions);
        }));



        // Pin (favourite) or unpin a chat: { pinned: true | false }.
        this.router.put("/sessions/:sessionId/pin", this.asyncHandler(async (req, res) => {
            const sessionId = String(req.params.sessionId ?? "");
            if (typeof req.body?.pinned !== "boolean") return res.status(400).json({ message: "pinned must be true or false" });
            if (req.body.pinned && (await this.service.countPinned(req.user!.sub)) >= MAX_PINNED) {
                return res.status(400).json({ message: `You can pin up to ${MAX_PINNED} chats — unpin one first.` });
            }
            const result = await this.service.setPinned(sessionId, req.user!.sub, req.body.pinned).catch(() => null);
            if (!result) return res.status(404).json({ message: "Chat not found" });
            return res.status(200).json(result);
        }));

        this.router.delete("/delete/:sessionId", this.asyncHandler(async (req, res) => {
            const { sessionId } = req.params;

            if (typeof sessionId !== "string") {
                throw new InvalidSession();

            }
            if (!sessionId) {
                throw new InvalidSession();
            }

            const isSessionValid: boolean = await this.service.isSessionValid(sessionId as string, req.user!.sub);
            if (!isSessionValid) {
                throw new SessionValidationError();
            }

            await this.service.deleteSession(sessionId as string, req.user!.sub);
            return res.status(204).send(sessionId);
        }));





        this.router.post("/chat_stream", this.asyncHandler(async (req, res) => {
            const { llmMessage: rawMessage, currentSessionId, provider, model: requestedModel, agentId, nativeAgentId }: { llmMessage: LLMMessage, currentSessionId: any, provider?: string, model?: string, agentId?: string, nativeAgentId?: string } = req.body;
            let model = requestedModel;
            if (!currentSessionId) {
                throw new InvalidSession()
            }
            // Never read or append to another user's conversation.
            if (!(await this.service.isSessionValid(String(currentSessionId), req.user!.sub))) {
                throw new SessionValidationError();
            }
            void this.billing?.rememberUser(req.user!.sub, req.user!.email);
            // Attached Word/Excel/PowerPoint/text files: include their extracted text.
            const llmMessage = this.kb && rawMessage ? await withAttachmentText(rawMessage, req.user!.sub, this.kb) : rawMessage;
            // Only models configured for the server, or on the user's own key —
            // the client can't pick an arbitrary (possibly expensive) model.
            let llm: ILLM;
            if (this.registry) {
                const resolved = await this.registry.resolve(req.user!.sub, provider, model, true).catch((err) => {
                    throw new ValidationError(err instanceof Error ? err.message : String(err));
                });
                llm = resolved.llm;
                model = resolved.model;
            } else {
                const found = this.providers.get((provider ?? this.defaultProvider) as LLMProvider);
                if (!found) throw new ValidationError(`LLM provider "${provider}" is not available`);
                if (model && !(found.getModels?.() ?? [found.getModel()]).includes(model)) {
                    throw new ValidationError(`Model "${model}" is not available for ${found.getProvider()}`);
                }
                llm = found;
            }

            // A chat that belongs to an agent (or the first message of a new
            // agent chat) runs with that agent's model, instructions and tools.
            let run: ChatRunOptions | undefined;
            // A chat with a provider-native agent runs on Claude Managed Agents /
            // the OpenAI Agents API instead of this server's own loop.
            const native = this.nativeAgents
                ? await this.nativeAgents.agentForSession(String(currentSessionId), req.user!.sub, typeof nativeAgentId === "string" ? nativeAgentId : undefined)
                    .catch((err) => { if (err?.status === 409) return { blocked: String(err.message) } as const; throw err; })
                : null;
            if (native && "blocked" in native) {
                res.write(`event: error\ndata: ${JSON.stringify({ type: "error", message: native.blocked })}\n\n`);
                return res.end();
            }
            if (native) {
                llm = this.nativeAgents!.llmFor(native.agent, native.remoteSessionId);
                model = native.agent.model;
            } else if (this.agents) {
                const agent = await this.agents.agentForSession(String(currentSessionId), req.user!.sub, agentId);
                if (agent) {
                    const resolved = await this.agents.resolveLLM(agent);
                    llm = resolved.llm;
                    model = resolved.model;
                    run = await this.agents.buildRun(agent);
                }
            }
            const abortController= new AbortController();
            // FIX — this used to listen on req.on("close"), which fires as
            // soon as the REQUEST body finishes being read (which Express
            // does almost instantly for a small JSON payload), not when the
            // client actually disconnects. That meant abortController.abort()
            // was firing within milliseconds of every single request, well
            // before chatStream() ever got to call OpenAI — the user message
            // would get persisted (that happens before the abort check) and
            // then nothing else would ever run, which is why every request
            // silently produced no reply at all.
            // res.on("close") fires when the underlying connection actually
            // closes; guarding on res.writableEnded stops it from firing a
            // false "abort" after we've already finished the response normally.
            res.on("close", () => {
                if (!res.writableEnded) {
                    abortController.abort();
                }
            });

            const KNOWN_EVENTS = new Set([
                "message",
                "function_call",
                "function_call_arguments",
                "function_call_output",
                "session_title",
                "error",
                "mcp_call",
                "mcp_call_arguments",
                "mcp_call_output",
                "mcp_list_tools",
                "mcp_approval_request",
                "sources",
                "cancelled",
                "code_interpreter_call",
                "code_interpreter_call_code_delta",
                "code_interpreter_call_code_done",
                "code_interpreter_call_status",
                "code_interpreter_file",
                "usage",
                "approval_request",
                "approval_resolved",
                "browser_screenshot",
            ]);

            for await (const chunk of llm.chatStream([llmMessage], req.user!.sub, currentSessionId,OPENAI_API_KEY,abortController.signal,model,run)) {
                // NEW — this used to be a switch with one hardcoded case per
                // event type. Every type the provider yields that wasn't
                // listed there (mcp_*, sources, cancelled, and now the new
                // code_interpreter_* events) was silently dropped here and
                // never reached the browser — the client would see the
                // stream just end with no content and no error. Forwarding
                // by chunk.type directly means a future event type the
                // provider adds gets to the client automatically instead of
                // needing a matching case added here too.
                if (chunk.type && KNOWN_EVENTS.has(chunk.type)) {
                    res.write(
                        `event: ${chunk.type}\n` +
                        `data: ${JSON.stringify(chunk)}\n\n`
                    );
                }
            }
            res.end();
        }));

        // Proxies a file the code interpreter wrote inside its ephemeral
        // container back to the client. This has to go through the server —
        // the container file endpoints need the OpenAI API key, which must
        // never reach the browser. See:
        // https://developers.openai.com/api/docs/guides/tools-code-interpreter
        this.router.get("/code_interpreter/files/:containerId/:fileId", this.asyncHandler(async (req, res) => {
            // Express types route params as `string | string[]` (a route can
            // repeat a param segment), even though :containerId/:fileId here
            // only ever produce a single string each. Normalizing with
            // String() (rather than destructuring req.params directly) is
            // what tsc actually needs to allow encodeURIComponent(filename)
            // and filename.replace(...) below — this was failing the build
            // once it got far enough to type-check this file.
            const containerId = req.params.containerId ? String(req.params.containerId) : "";
            const fileId = req.params.fileId ? String(req.params.fileId) : "";
            if (!containerId || !fileId) {
                return res.status(400).json({ message: "containerId and fileId are required" });
            }

            // The container file content endpoint returns raw bytes with no
            // filename, so fetch metadata first purely for a human-readable
            // Content-Disposition. Best-effort only — if this fails (e.g. the
            // container already expired) we still try the content fetch below
            // and let its own error surface to the client.
            let filename = fileId;
            try {
                const metaRes = await fetch(`https://api.openai.com/v1/containers/${containerId}/files/${fileId}`, {
                    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
                });
                if (metaRes.ok) {
                    const meta: any = await metaRes.json();
                    if (meta?.path) filename = String(meta.path).split("/").pop() ?? filename;
                }
            } catch {
                // best-effort — fall through with the file_id as the filename
            }

            const contentRes = await fetch(`https://api.openai.com/v1/containers/${containerId}/files/${fileId}/content`, {
                headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
            });

            if (!contentRes.ok || !contentRes.body) {
                const notFound = contentRes.status === 404;
                return res.status(notFound ? 404 : 502).json({
                    message: notFound
                        ? "This file is no longer available — code interpreter containers expire after 20 minutes of inactivity."
                        : "Failed to fetch the file from OpenAI.",
                });
            }

            res.setHeader("Content-Type", contentRes.headers.get("content-type") ?? "application/octet-stream");
            res.setHeader("X-File-Name", encodeURIComponent(filename));
            res.setHeader("Content-Disposition", `inline; filename="${filename.replace(/"/g, "")}"`);

            const reader = contentRes.body.getReader();
            req.on("close", () => { reader.cancel().catch(() => {}); });
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    res.write(Buffer.from(value));
                }
            } finally {
                res.end();
            }
        }));

    }

}