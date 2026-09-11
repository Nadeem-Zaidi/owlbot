import "dotenv/config";  
import dotenv from "dotenv";
import { InvalidSession, SessionValidationError, ValidationError } from "../error_handling/app_error";
import { BaseRouter } from "./base_router";
import { MessageService } from "../service/message_service";
import { ILLM } from "../interfaces/illm";
import { LLMMessage } from "../types/llm_message";
dotenv.config();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

export class ChatMessages extends BaseRouter<MessageService> {
    llm: ILLM;

    constructor(messsageService: MessageService, llm: ILLM) {
        super("/session", messsageService)
        this.llm = llm
    }
    registerRouter() {
        this.router.get("/messages", this.asyncHandler(async (req, res) => {
            res.send({ message: "working" });


        }));

        this.router.get("/get_session/:sessionId", this.asyncHandler(async (req, res) => {
            const { sessionId } = req.params; 
            try {
                if (!sessionId) throw new InvalidSession();
                const id = await this.service.getSession(sessionId as string);
                return res.status(200).json(id);
            } catch (err) {
                throw err;
            }
        }));

        this.router.get("/load_messages/:sessionId", this.asyncHandler(async (req, res) => {
            const { sessionId } = req.params; // was req.query.sessionId



            if (!sessionId) throw new InvalidSession();

            const isSessionValid: boolean = await this.service.isSessionValid(sessionId as string);
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



        this.router.delete("/delete/:sessionId", this.asyncHandler(async (req, res) => {
            const { sessionId } = req.params;

            if (typeof sessionId !== "string") {
                throw new InvalidSession();

            }
            if (!sessionId) {
                throw new InvalidSession();
            }

            const isSessionValid: boolean = await this.service.isSessionValid(sessionId as string);
            if (!isSessionValid) {
                throw new SessionValidationError();
            }

            await this.service.deleteSession(sessionId as string, req.user!.sub);
            return res.status(204).send(sessionId);
        }));





        this.router.post("/chat_stream", this.asyncHandler(async (req, res) => {
            const { llmMessage, currentSessionId }: { llmMessage: LLMMessage, currentSessionId: any} = req.body;
            if (!currentSessionId) {
                throw new InvalidSession()
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
            ]);

            for await (const chunk of this.llm.chatStream([llmMessage], req.user!.sub, currentSessionId,OPENAI_API_KEY,abortController.signal)) {
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