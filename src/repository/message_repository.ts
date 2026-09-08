// src/database/message_repository.ts

import { IDatabaseAdapter } from "../database/idatabaseadapter";
import { LLMMessage } from "../types/llm_message";
import pino from "pino";

// ── Logger ────────────────────────────────────────────────────────────────────
export const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

// ── Types ─────────────────────────────────────────────────────────────────────
type SanitizeResult =
    | { ok: true; message: LLMMessage }
    | { ok: false; message: LLMMessage; reason: string };

interface ContentPart {
    type: string;
    text?: string;
}

// ── Repository ────────────────────────────────────────────────────────────────
export class MessageRepository {
    private db: IDatabaseAdapter;

    constructor(db: IDatabaseAdapter) {
        this.db = db;
    }

    rawDb(){
        return this.db
    }

    async getSessionMessages(sessionId: string): Promise<LLMMessage[]> {
        const result = await this.db.query(
            `SELECT * FROM chat_messages WHERE session_id = $1 ORDER BY id ASC`,
            [sessionId]
        );

        const messages: LLMMessage[] = [];
        let corruptCount = 0;

        for (const row of result.rows) {
            const sanitized = this.sanitizeRow(row, sessionId);
            if (!sanitized.ok) {
                corruptCount++;
                log.warn({
                    sessionId,
                    rowId: row.id,
                    role: row.role,
                    reason: sanitized.reason,
                }, "corrupt row replaced with placeholder");
            }
            messages.push(sanitized.message);
        }

        if (corruptCount > 0) {
            log.warn({
                sessionId,
                corruptCount,
                total: result.rows.length,
            }, "session had corrupt messages");
        }

        return messages;
    }

    async insertLLMMessage(sessionId: string, message: LLMMessage): Promise<void> {


        try {
             await this.db.query(
                `INSERT INTO chat_messages (session_id, role, type, content, name,arguments, tool_call_id, output
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                [
                    sessionId,
                    message.role ?? null,
                    message.type ?? null,
                    // FIX: previously a plain string was stored as-is (raw, unwrapped
                    // text), which sanitizeRow's JSON.parse(row.content) can never
                    // parse back — every such row was permanently marked corrupt.
                    // Now a plain string gets wrapped into the expected
                    // ContentPart[] shape before being stringified, same as any
                    // other content value.
                    message.content
                        ? (typeof message.content === 'string'
                            ? JSON.stringify([{ type: "text", text: message.content }])
                            : JSON.stringify(message.content))
                        : null,
                    message.name ?? null,
                    message.arguments ? JSON.stringify(message.arguments) : null,
                    message.tool_call_id ?? null,
                    // FIX: message.output is already a plain string in practice
                    // (e.g. the JSON.stringify'd tool result built in
                    // openai_provider.ts). JSON.stringify-ing it again here would
                    // double-encode it, and sanitizeRow's read side never decodes
                    // it back — so store it as-is when it's already a string, and
                    // only stringify non-string values.
                    message.output != null
                        ? (typeof message.output === 'string' ? message.output : JSON.stringify(message.output))
                        : null,
                ]
            );
        } catch (err) {
            log.error({ err, sessionId, role: message.role }, "failed to insert LLM message");
            throw err;
        }
    }

    async insertMultipleMessages(sessionId: string,messages: LLMMessage[]
    ): Promise<void> {
        if (messages.length === 0) return;

        try {
            await this.db.withTransaction(async () => {
                for (const message of messages) {
                    await this.insertLLMMessage(sessionId,message)
                }
            });

            log.info({
                sessionId,
                count: messages.length
            }, "batch messages inserted successfully");

        } catch (err) {
            log.error({ err, sessionId, count: messages.length }, "failed to insert batch messages");
            throw err;
        }
    }

    async saveConversation(
        sessionId: string,
        messages: LLMMessage[]
    ): Promise<void> {
        if (messages.length === 0) return;

        try {
            await this.db.withTransaction(async () => {
                // Optionally clear existing messages for this session
                await this.db.query(
                    `DELETE FROM chat_messages WHERE session_id = $1`,
                    [sessionId]
                );
                // place that decides how content/output get encoded.
                for (const message of messages) {
                    await this.insertLLMMessage(sessionId, message);
                }
            });

            log.info({
                sessionId,
                count: messages.length
            }, "conversation saved successfully");

        } catch (err) {
            log.error({ err, sessionId, count: messages.length }, "failed to save conversation");
            throw err;
        }
    }

    async deleteSessionMessages(sessionId: string): Promise<void> {
        try {
            await this.db.withTransaction(async () => {
                await this.db.query(
                    `DELETE FROM chat_messages WHERE session_id = $1`,
                    [sessionId]
                );
            });

            log.info({ sessionId }, "session messages deleted successfully");

        } catch (err) {
            log.error({ err, sessionId }, "failed to delete session messages");
            throw err;
        }
    }

    async copySessionMessages(
        sourceSessionId: string,
        targetSessionId: string
    ): Promise<number> {
        try {
            const result = await this.db.withTransaction(async () => {
                // Get source messages
                const sourceMessages = await this.db.query(
                    `SELECT type, role, content FROM chat_messages 
                     WHERE session_id = $1 ORDER BY id ASC`,
                    [sourceSessionId]
                );

                if (sourceMessages.rows.length === 0) {
                    return 0;
                }

                // Insert into target session
                for (const row of sourceMessages.rows) {
                    await this.db.query(
                        `INSERT INTO chat_messages (session_id, type, role, content) 
                         VALUES ($1, $2, $3, $4)`,
                        [targetSessionId, row.type, row.role, row.content]
                    );
                }

                return sourceMessages.rows.length;
            });

            log.info({
                sourceSessionId,
                targetSessionId,
                count: result
            }, "session messages copied successfully");

            return result;

        } catch (err) {
            log.error({
                err,
                sourceSessionId,
                targetSessionId
            }, "failed to copy session messages");
            throw err;
        }
    }
    private sanitizeRow(row: any, sessionId: string): SanitizeResult {
        if (!row.role) {
            return this.corrupt(row, "missing role",
                this.placeholderMessage("user", "message had no role"));
        }

        if (row.role === "tool_call") {
            return {
                ok: true,
                message: {
                    role: "tool_call",
                    type: "tool_call",
                    tool_call_id: row.tool_call_id,
                    name: row.name,
                    arguments: this.safeParseArgs(row.arguments, row.id, sessionId),
                } as LLMMessage,
            };
        }

        if (row.role === "tool_call_output") {
            return {
                ok: true,
                message: {
                    role: "tool_call_output",
                    type: "tool_call_output",
                    tool_call_id: row.tool_call_id,
                    output: row.output ?? "{}",
                } as LLMMessage,
            };
        }
        let content: ContentPart[];
        try {
            const parsed = row.content;
            if (!Array.isArray(parsed)) throw new Error("content is not an array");
            content = parsed;
        } catch {
            return this.corrupt(
                row,
                `content JSON parse failed (row id=${row.id})`,
                this.placeholderMessage(row.role, "message content was corrupted")
            );
        }

        if (content.length === 0) {
            return this.corrupt(row, "empty content array",
                this.placeholderMessage(row.role, "message was empty"));
        }

        const KNOWN_TYPES = ["text", "input_text", "output_text",
            "input_file", "input_base64_image", "input_url_image"];
        const badParts = content.filter((p) => !KNOWN_TYPES.includes(p?.type));

        if (badParts.length > 0) {
            content = content.filter((p) => KNOWN_TYPES.includes(p?.type));
            const reason = `unknown content types filtered: ${badParts.map(p => p?.type).join(", ")}`;

            if (content.length === 0) {
                return this.corrupt(row, reason,
                    this.placeholderMessage(row.role, "all content parts were unreadable"));
            }

            // Partial corruption — keep surviving parts, still flag as not ok
            return this.corrupt(row, reason, {
                role: row.role,
                type: "message",
                content,
            } as LLMMessage);
        }

        return {
            ok: true,
            message: { role: row.role, type: "message", content } as LLMMessage,
        };
    }

    private placeholderMessage(role: string, reason: string): LLMMessage {
        const textMap: Record<string, string> = {
            user: `[System notice: a previous message could not be loaded — ${reason}]`,
            assistant: `[Previous response unavailable — ${reason}]`,
            system: `[System notice: an instruction could not be loaded — ${reason}]`,
        };
        return {
            role: role as any,
            type: "message",
            content: [{ type: "text", text: textMap[role] ?? `[Unreadable message — ${reason}]` }],
        } as LLMMessage;
    }

    private corrupt(row: any, reason: string, message: LLMMessage): SanitizeResult {
        log.warn({ rowId: row.id, role: row.role, reason }, "sanitizing corrupt row");
        return { ok: false, reason, message };
    }

    private safeParseArgs(raw: string, rowId: number, sessionId: string): Record<string, any> {
        try {
            return JSON.parse(raw);
        } catch {
            log.warn({ rowId, sessionId }, "tool_call arguments JSON parse failed");
            return {};
        }
    }
}