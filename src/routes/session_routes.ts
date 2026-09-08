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
            
            for await (const chunk of this.llm.chatStream([llmMessage], req.user!.sub, currentSessionId,OPENAI_API_KEY)) {
                switch (chunk.type) {
                    case "message":
                        res.write(
                            `event: message\n` +
                            `data: ${JSON.stringify(chunk)}\n\n`
                        )
                        break;
                    case "function_call":
                        res.write(
                            `event: function_call\n` +
                            `data: ${JSON.stringify(chunk)}\n\n`
                        );
                        break;

                    case "function_call_arguments":
                        res.write(
                            `event: function_call_arguments\n` +
                            `data: ${JSON.stringify(chunk)}\n\n`
                        );
                        break;
                    case "function_call_output":
                        res.write(
                            `event: function_call_output\n` +
                            `data: ${JSON.stringify(chunk)}\n\n`
                        );
                        break;

                    case "session_title":
                        res.write(
                            `event: session_title\n` +
                            `data: ${JSON.stringify(chunk)}\n\n`
                        )
                        break;

                    case "error":
                        res.write(
                            `event: error\n` +
                            `data: ${JSON.stringify(chunk)}\n\n`
                        );
                        break;
                }

            }
            res.end();
        }));

    }

}