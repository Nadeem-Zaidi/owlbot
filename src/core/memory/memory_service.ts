import { MemoryMode, MemoryRepository, MemoryRow } from "../../repository/memory_repository";

export const MAX_MEMORY_CHARS = 300;
export const MAX_MEMORIES = 200;
// Memories recalled into one request, in characters (newest first).
const RECALL_BUDGET_CHARS = 4_000;
const MODES: MemoryMode[] = ["auto", "review", "off"];

export class MemoryError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
    }
}

export type RecalledMemory = { id: string; content: string };

export type SaveResult =
    | { status: "saved" | "updated" | "proposed" | "unchanged"; memory: MemoryRow }
    | { status: "off" };

// Long-term memory: short facts about a user that carry over to every chat
// (web, WhatsApp, agents). Saved by the assistant (save_memory tool) or by
// the user on the Memory page; the user can see, edit and delete all of them.
//
// Modes: "auto" — the assistant's saves are active at once (the chat shows
// "Memory updated" with a link to undo); "review" — they wait as
// suggestions until the user approves them; "off" — nothing is saved or
// recalled.
export class MemoryService {
    constructor(private repo: MemoryRepository) {}

    // ── for the context engine ──
    async recall(userId: string): Promise<RecalledMemory[]> {
        if ((await this.repo.getMode(userId)) === "off") return [];
        const out: RecalledMemory[] = [];
        let chars = 0;
        for (const m of await this.repo.list(userId, "active")) {
            chars += m.content.length + 16;
            if (chars > RECALL_BUDGET_CHARS) break;
            out.push({ id: m.id, content: m.content });
        }
        return out;
    }

    // ── for the assistant's tools ──
    async saveFromChat(userId: string, content: string, sessionId: string | null, replacesId?: string): Promise<SaveResult> {
        const mode = await this.repo.getMode(userId);
        if (mode === "off") return { status: "off" };
        const text = clean(content);
        if (replacesId) {
            const old = await this.repo.findByPrefix(userId, replacesId);
            if (!old) throw new MemoryError(`No memory with id ${replacesId}`);
            const memory = await this.repo.update(userId, old.id, { content: text, status: mode === "review" ? "proposed" : "active" });
            return { status: mode === "review" ? "proposed" : "updated", memory: memory! };
        }
        const same = await this.repo.findSame(userId, text);
        if (same) {
            await this.repo.touch(userId, same.id);
            return { status: "unchanged", memory: same };
        }
        await this.checkRoom(userId);
        const memory = await this.repo.create(userId, text, mode === "review" ? "proposed" : "active", "chat", sessionId);
        return { status: mode === "review" ? "proposed" : "saved", memory };
    }

    async forgetFromChat(userId: string, idPrefix: string): Promise<MemoryRow> {
        const m = await this.repo.findByPrefix(userId, idPrefix);
        if (!m) throw new MemoryError(`No memory with id ${idPrefix}`);
        await this.repo.delete(userId, m.id);
        return m;
    }

    // ── for the Memory page ──
    async overview(userId: string) {
        const [mode, memories] = await Promise.all([this.repo.getMode(userId), this.repo.list(userId)]);
        return { mode, limit: MAX_MEMORIES, maxChars: MAX_MEMORY_CHARS, memories: memories.map(dto) };
    }

    async add(userId: string, content: unknown) {
        const text = clean(content);
        const same = await this.repo.findSame(userId, text);
        if (same) return dto(same);
        await this.checkRoom(userId);
        return dto(await this.repo.create(userId, text, "active", "user", null));
    }

    // Edit the text and/or approve a suggestion (status "active").
    async edit(userId: string, id: string, body: { content?: unknown; status?: unknown }) {
        const patch: { content?: string; status?: "active" } = {};
        if (body.content !== undefined) patch.content = clean(body.content);
        if (body.status !== undefined) {
            if (body.status !== "active") throw new MemoryError('status can only be set to "active" (approve)');
            patch.status = "active";
        }
        const m = await this.repo.update(userId, id, patch);
        if (!m) throw new MemoryError("Memory not found", 404);
        return dto(m);
    }

    async remove(userId: string, id: string) {
        if (!(await this.repo.delete(userId, id))) throw new MemoryError("Memory not found", 404);
    }

    async clear(userId: string) {
        return this.repo.deleteAll(userId);
    }

    async setMode(userId: string, mode: unknown) {
        if (!MODES.includes(mode as MemoryMode)) throw new MemoryError('mode must be "auto", "review" or "off"');
        await this.repo.setMode(userId, mode as MemoryMode);
        return { mode };
    }

    private async checkRoom(userId: string) {
        if ((await this.repo.count(userId)) >= MAX_MEMORIES) {
            throw new MemoryError(`Memory is full (${MAX_MEMORIES} items). Delete some on the Memory page first.`);
        }
    }
}

function clean(content: unknown): string {
    const text = String(typeof content === "string" ? content : "").replace(/\s+/g, " ").trim();
    if (!text) throw new MemoryError("A memory can't be empty");
    if (text.length > MAX_MEMORY_CHARS) throw new MemoryError(`A memory can be at most ${MAX_MEMORY_CHARS} characters — keep it to one short fact`);
    return text;
}

function dto(m: MemoryRow) {
    return { id: m.id, content: m.content, status: m.status, source: m.source, session_id: m.session_id, created_at: m.created_at, updated_at: m.updated_at };
}
