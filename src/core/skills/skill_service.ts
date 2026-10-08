import { SkillInput, SkillRepository, SkillRow } from "../../repository/skill_repository";

export const MAX_SKILLS = 100;
export const MAX_SKILL_CHARS = 50_000;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// The index (name + description of each skill) added to every request.
const INDEX_BUDGET_CHARS = 6_000;

export class SkillError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
    }
}

// Which skills a chat may use: all of the user's (plain chats, agents set to
// "all"), a chosen list, or none.
export type SkillScope = { mode: "all" | "selected" | "none"; ids: string[] };

export type SkillIndexEntry = { name: string; description: string };

// Skills: reusable instruction packs ("how to write a Maximo FDD", "our
// code-review checklist"). Each request only lists them (name + when to
// use); the assistant loads one with load_skill when it's relevant, so a
// big library doesn't cost tokens on every message.
export class SkillService {
    constructor(private repo: SkillRepository) {}

    async index(userId: string, scope?: SkillScope): Promise<SkillIndexEntry[]> {
        if (scope?.mode === "none") return [];
        let skills = await this.repo.list(userId, true);
        if (scope?.mode === "selected") {
            const allowed = new Set(scope.ids);
            skills = skills.filter((s) => allowed.has(s.id));
        }
        const out: SkillIndexEntry[] = [];
        let chars = 0;
        for (const s of skills) {
            chars += s.name.length + s.description.length + 8;
            if (chars > INDEX_BUDGET_CHARS) break;
            out.push({ name: s.name, description: s.description });
        }
        return out;
    }

    // For load_skill: an enabled skill of this user.
    async load(userId: string, name: string): Promise<SkillRow> {
        const skill = await this.repo.getByName(userId, String(name ?? "").trim().toLowerCase());
        if (!skill || !skill.enabled) throw new SkillError(`No skill named "${name}". Use one of the names listed in your skills.`, 404);
        return skill;
    }

    // ── library ──
    list(userId: string) {
        return this.repo.list(userId);
    }

    async get(userId: string, id: string) {
        const s = await this.repo.get(userId, id);
        if (!s) throw new SkillError("Skill not found", 404);
        return s;
    }

    async create(userId: string, body: unknown) {
        const input = parseSkill(body);
        if ((await this.repo.count(userId)) >= MAX_SKILLS) throw new SkillError(`You can have up to ${MAX_SKILLS} skills.`);
        if (await this.repo.getByName(userId, input.name)) throw new SkillError(`You already have a skill named "${input.name}".`, 409);
        return this.repo.create(userId, input);
    }

    async update(userId: string, id: string, body: unknown) {
        const current = await this.get(userId, id);
        const input = parseSkill({ ...current, ...(body as object) });
        const clash = await this.repo.getByName(userId, input.name);
        if (clash && clash.id !== id) throw new SkillError(`You already have a skill named "${input.name}".`, 409);
        return (await this.repo.update(userId, id, input))!;
    }

    async remove(userId: string, id: string) {
        if (!(await this.repo.delete(userId, id))) throw new SkillError("Skill not found", 404);
    }

    // Imports a SKILL.md (front matter with name/description + body) — the
    // format Claude and OpenClaw skills use. Without front matter, the name
    // comes from the file name and the first paragraph is the description.
    async importMarkdown(userId: string, markdown: unknown, fileName?: unknown) {
        return this.create(userId, parseSkillMarkdown(String(markdown ?? ""), typeof fileName === "string" ? fileName : undefined));
    }
}

export function parseSkill(b: any): SkillInput {
    const name = String(b?.name ?? "").trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new SkillError("Name: lowercase letters, numbers and dashes, up to 64 characters (e.g. maximo-fdd).");
    const description = String(b?.description ?? "").replace(/\s+/g, " ").trim();
    if (!description) throw new SkillError("Add a description: when should the assistant use this skill?");
    if (description.length > 300) throw new SkillError("Keep the description under 300 characters — it's what the assistant reads to decide when to use the skill.");
    const content = String(b?.content ?? "").trim();
    if (!content) throw new SkillError("The skill's instructions can't be empty.");
    if (content.length > MAX_SKILL_CHARS) throw new SkillError(`A skill can be at most ${MAX_SKILL_CHARS.toLocaleString()} characters.`);
    return { name, description, content, enabled: b?.enabled !== false };
}

export function parseSkillMarkdown(markdown: string, fileName?: string) {
    const text = markdown.replace(/^﻿/, "").replace(/\r\n/g, "\n");
    const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
    const meta: Record<string, string> = {};
    if (fm) {
        for (const line of fm[1].split("\n")) {
            const m = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
            if (m) meta[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, "");
        }
    }
    const body = (fm ? text.slice(fm[0].length) : text).trim();
    const fromFile = (fileName ?? "").replace(/\.(md|markdown|txt)$/i, "").replace(/^skill$/i, "");
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    const firstHeading = body.match(/^#\s+(.+)$/m)?.[1] ?? "";
    const firstPara = body.replace(/^#.*$/gm, "").trim().split(/\n{2,}/)[0]?.replace(/\s+/g, " ").slice(0, 300) ?? "";
    return { name: slug(meta.name || fromFile || firstHeading), description: meta.description || firstPara, content: body, enabled: true };
}
