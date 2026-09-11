import { WebSocketServer, WebSocket } from "ws";
import { IChannel} from "../interfaces/ichannel";
import chalk from "chalk";
import { LLMMessage } from "../types/llm_message";
import express from "express";
import http from "http";
import { ToolRegistry } from "../tools/tool";
import cors from "cors";
import { verifyToken } from "../authentication/authentication_middleware";
import { IDatabaseAdapter } from "../database/idatabaseadapter";
import multer from 'multer';
import { ChatMessages } from "../routes/session_routes";
import { StorageRoutes } from "../routes/storage_routes";
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 } // 50mb per file
});

type RPCRequest = {
    jsonrpc: "2.0";
    id: number;
    method: string;
    params: any;
};

type RPCEvent = {
    jsonrpc: "2.0";
    method: string;
    params: any;
};

type HandlerCtx = {
    send: (result: any) => void;
    error: (message: string) => void;
    broadcast: (method: string, params: any) => void;
};
const registry = new ToolRegistry()


export class VGateway {
    private port?: number;
    private app = express();
    private server = http.createServer(this.app);
    private db: IDatabaseAdapter;
    private chatRoutes:ChatMessages;
    private storageRoutes:StorageRoutes;
    private wss = new WebSocketServer({ server: this.server });
    private channels = new Map<string, IChannel>();
    private registry = new Map<string, any>();
    private history = new Map<string, LLMMessage[]>();

    constructor(
        port: number, 
        db: IDatabaseAdapter,
        chatRoutes:ChatMessages,
        storageRoutes:StorageRoutes
    ) {
        this.port = port;
        this.db = db;
        this.registerBuiltins();
        this.chatRoutes=chatRoutes;
        this.storageRoutes=storageRoutes


    }

    public async init() {
        // exposedHeaders — NEW. Without this, the browser's CORS policy
        // silently hides custom response headers from JS entirely; the
        // code interpreter file download endpoint sets X-File-Name so the
        // frontend can show a real filename instead of the raw file_id,
        // and fetch()'s response.headers.get("X-File-Name") would just
        // return null across origins without this.
        this.app.use(cors({ exposedHeaders: ["X-File-Name", "Content-Disposition"] }));
        this.app.use(verifyToken);
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ limit: '10mb', extended: true }));
        this.chatRoutes.registerRouter()
        this.app.use("/api", this.chatRoutes.getRouter());
        this.storageRoutes.registerRouter();
        this.app.use("/",this.storageRoutes.getRouter());
    }
    private registerBuiltins() {

        this.register("ping", async (_: any, ctx: HandlerCtx) => {
            ctx.send({ pong: true, ts: Date.now() });
        });
        this.register("whatsapp.connect", async (_: any, ctx: HandlerCtx) => {
            await this.startWAChannel("whatsapp");
            ctx.send({ started: true });
        });

        // this.register("llm.stream", async (params: any, ctx: HandlerCtx) => {
        //     const { requestId } = params;
        //     this.cancelFlags.set(requestId, false);
        //     console.log(params);  // ← init to false

        //     const messages: LLMMessage[] = params.messages.map((m: any) => ({
        //         role: m.role,
        //         content: m.content,
        //         tool_call_id: m.tool_call_id,
        //     }));

        //     const tools = this.llm.supportsTools()
        //         ? this.toolRegistry.getRegisteredTools().map((t) => ({
        //             type: "function" as const,
        //             function: {
        //                 name: t.name,
        //                 description: t.description,
        //                 parameters: t.parameters

        //             }

        //         }))
        //         : undefined;

        //     let continueLoop = true;
        //     let maxIterations = 10;

        //     while (continueLoop && maxIterations-- > 0) {

        //         if (this.cancelFlags.get(requestId)) break;  // ← check at loop start

        //         for await (const chunk of this.llm.chatStream(messages, tools)) {
        //             await new Promise(resolve => setImmediate(resolve));

        //             if (this.cancelFlags.get(requestId)) {   // ← check each chunk
        //                 continueLoop = false;
        //                 break;
        //             }

        //             if (chunk.isDone && chunk.isToolCall && tools) {
        //                 messages.push({ role: "assistant", content: "", tool_calls: chunk.toolCalls } as any);
        //                 for (const toolCall of chunk.toolCalls ?? []) {
        //                     if (this.cancelFlags.get(requestId)) break;
        //                     let args: Record<string, unknown> = {};
        //                     try { args = JSON.parse(toolCall.function.arguments); } catch { }
        //                     const result = await this.toolRegistry.execute(toolCall.function.name, args);
        //                     messages.push({
        //                         role: "tool",
        //                         content: JSON.stringify(result),
        //                         tool_call_id: toolCall.id
        //                     } as any);
        //                 }
        //                 break;
        //             }

        //             if (!chunk.isToolCall && chunk.content) {
        //                 ctx.send({ type: "chunk", content: chunk.content });
        //             }

        //             if (chunk.isDone && !chunk.isToolCall) {
        //                 continueLoop = false;
        //                 break;
        //             }
        //         }
        //     }

        //     const wasCancelled = this.cancelFlags.get(requestId);
        //     this.cancelFlags.delete(requestId);

        //     // ← actually send "cancelled" when cancelled, not always "done"
        //     ctx.send({ type: wasCancelled ? "cancelled" : "done" });
        // });

        // ── whatsapp.send ──
        this.register("whatsapp.send", async (params: any, ctx: HandlerCtx) => {
            const channel = this.channels.get("whatsapp");
            if (!channel) {
                return ctx.error("WhatsApp channel not registered.");
            }
            await channel.send(`whatsapp:${params.jid}`, params.text);
            ctx.send({ sent: true });
        });

        this.register("channel.list", async (_: any, ctx: HandlerCtx) => {
            ctx.send({ channels: [...this.channels.keys()] });
        });

        this.register("history.clear", async (params: any, ctx: HandlerCtx) => {
            if (this.history.has(params.sessionKey)) {
                this.history.delete(params.sessionKey);
                ctx.send({ cleared: true });
            } else {
                ctx.send({ cleared: false, reason: "session not found" });
            }
        });
        // this.register("mcp.tools", async (_: any, ctx: HandlerCtx) => {
           
        //     ctx.send({ tools: tools.map(t => t.name) });
        // });
    }

    public async connectMcp(url: string): Promise<void> {


    }

    // public registerChannel(channel: IChannel) {
    //     this.channels.set(channel.id, channel);
    //     channel.onMessage((msg) => this.handleIncoming(msg));
    //     if ("onBroadcast" in channel) {
    //         (channel as any).onBroadcast((method: string, params: any) => {
    //             this.broadcast(method, params);
    //         });
    //     }

    //     console.log(chalk.cyan(`[gateway] registered channel: ${channel.id}`));
    // }

    public async startWAChannel(id: string) {
        const channel = this.channels.get(id);
        if (!channel) {
            console.error(`[gateway] no channel found with id: ${id}`);
            return;
        }
        console.log(chalk.cyan(`[gateway] starting channel: ${id}`));
        await channel.start();
    }

    public register(method: string, handler: any) {
        this.registry.set(method, handler);
    }
    public listen() {
        this.server.listen(this.port, () => {
            console.log(`HTTP Server listening on port ${this.port}`);
        });

        this.wss.on("connection", (ws) => {
            this.onConnection(ws);
        });
    }

    // private async handleIncoming(msg: IncomingMessage) {

    //     const channel = this.channels.get(msg.channelId);
    //     if (!channel) {
    //         console.error(`[gateway] no channel found for id: ${msg.channelId}`);
    //         return;
    //     }

    //     if (!this.history.has(msg.sessionKey)) {
    //         this.history.set(msg.sessionKey, [
    //             {
    //                 role: "system",
    //                 content: this.systemPrompt,
    //             },
    //         ]);
    //     }

    //     const convo = this.history.get(msg.sessionKey)!;
    //     const urls = (typeof msg.content === "string" ? msg.content : "").match(/https?:\/\/[^\s]+/gi) ?? [];
    //     for (const url of urls) {
    //         const text = await fetchPageText(url);
    //         if (text) {
    //             convo.push({
    //                 role: "system",
    //                 content: `The user shared this web page:\n\n${text}`,
    //             });
    //         }
    //     }
    //     convo.push({ role: "user", content: msg.content as any });

    //     try {
    //         let reply = "";
    //         let continueLoop = true;
    //         const tools = this.llm.supportsTools()
    //             ? this.toolRegistry.getRegisteredTools().map((t) => ({
    //                 type: "function" as const,
    //                 function: {
    //                     name: t.name,
    //                     description: t.description,
    //                     parameters: t.parameters
    //                 }

    //             }))
    //             : undefined;

    //         while (continueLoop) {
    //             reply = "";

    //             for await (const chunk of this.llm.chatStream(convo, tools as any)) {
    //                 if (chunk.isDone && chunk.isToolCall && chunk.toolCalls && chunk.toolCalls.length > 0) {
    //                     convo.push({
    //                         role: "assistant",
    //                         content: "",
    //                         tool_calls: chunk.toolCalls,
    //                     } as any);
    //                     for (const toolCall of chunk.toolCalls) {
    //                         console.log(chalk.cyan(`[gateway] tool requested: ${toolCall.function.name}`
    //                         ));
    //                         let args: Record<string, unknown> = {};
    //                         try {
    //                             args = JSON.parse(toolCall.function.arguments);
    //                         } catch {
    //                             args = {};
    //                         }


    //                         const result = await this.toolRegistry.execute(
    //                             toolCall.function.name,  // ← function.name
    //                             args,
    //                         );
    //                         convo.push({
    //                             role: "tool",
    //                             content: JSON.stringify(result),
    //                             tool_call_id: toolCall.id,  // ← match the id
    //                         } as any);
    //                     }

    //                     break;

    //                 }
    //                 if (!chunk.isToolCall) {
    //                     reply += chunk.content;
    //                 }

    //                 if (chunk.isDone && !chunk.isToolCall) {
    //                     continueLoop = false;
    //                     break;
    //                 }
    //             }
    //         }

    //         reply = reply.trim() || "Sorry, I could not understand.";
    //         convo.push({ role: "assistant", content: reply });

    //         await channel.send(msg.sessionKey, `[**By Owl_Agent**]-${reply}`);
    //         console.log(chalk.green(
    //             `[gateway] replied on ${msg.channelId} to ${msg.senderId}`
    //         ));

    //     } catch (error: any) {
    //         console.error(chalk.red("[gateway] LLM error:"), error.message);
    //         await channel.send(msg.sessionKey, "Sorry, something went wrong.");
    //     }
    // }

    private onConnection(ws: WebSocket) {
        console.log(chalk.yellow("[gateway] client connected"));

        ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                this.dispatch(msg, ws);
            } catch {
                this.rawSend(ws, {
                    jsonrpc: "2.0",
                    id: null,
                    error: { message: "Invalid JSON" },
                });
            }
        });

        ws.on("close", () =>
            console.log(chalk.yellow("[gateway] client disconnected"))
        );
        ws.on("error", (err) =>
            console.error(chalk.red("[gateway] WS error:"), err.message)
        );
    }

    private async dispatch(msg: RPCRequest, ws: WebSocket) {
        const handler = this.registry.get(msg.method);

        if (!handler) {
            return this.rawSend(ws, {
                jsonrpc: "2.0",
                id: msg.id,
                error: { message: `Method not found: ${msg.method}` },
            });
        }

        const ctx: HandlerCtx = {
            send: (result: any) =>
                this.rawSend(ws, { jsonrpc: "2.0", id: msg.id, result }),
            error: (message: string) =>
                this.rawSend(ws, {
                    jsonrpc: "2.0",
                    id: msg.id,
                    error: { message },
                }),
            broadcast: (method: string, params: any) =>
                this.broadcast(method, params),
        };

        try {
            await handler(msg.params, ctx);
        } catch (err: any) {
            ctx.error(err.message ?? "Internal error");
        }
    }

    private rawSend(ws: WebSocket, payload: any) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
        }
    }

    private broadcast(method: string, params: any) {
        const raw = JSON.stringify({
            jsonrpc: "2.0",
            method,
            params,
        } as RPCEvent);
        this.wss.clients.forEach((c) => {
            if (c.readyState === WebSocket.OPEN) c.send(raw);
        });
    }
}