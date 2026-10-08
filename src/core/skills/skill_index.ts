import { LLMMessage } from "../../types/llm_message";
import { AssembledContext, AssembleOptions, ContextEngine } from "../context/context_engine";
import { SkillIndexEntry, SkillScope } from "./skill_service";

export type SkillSource = { index(userId: string, scope?: SkillScope): Promise<SkillIndexEntry[]> };

// Context-engine step that lists the skills the chat may use (name + when to
// use it). The full instructions stay out of the request until the assistant
// calls load_skill.
export class SkillIndexEngine implements ContextEngine {
    readonly id: string;

    constructor(private inner: ContextEngine, private skills: SkillSource) {
        this.id = `${inner.id}+skills`;
    }

    async assemble(history: LLMMessage[], opts: AssembleOptions): Promise<AssembledContext> {
        const [context, index] = await Promise.all([
            this.inner.assemble(history, opts),
            opts.userId
                ? this.skills.index(opts.userId, opts.skillScope).catch((err) => {
                    console.error("[skills] couldn't list skills (continuing without):", err);
                    return [] as SkillIndexEntry[];
                })
                : Promise.resolve([] as SkillIndexEntry[]),
        ]);
        if (!index.length) return context;
        const block = { type: "message", role: "system", content: [{ type: "text", text: skillIndexPrompt(index) }] } as LLMMessage;
        return { ...context, messages: [block, ...context.messages] };
    }
}

export function skillIndexPrompt(index: SkillIndexEntry[]): string {
    return [
        "Skills you can load: the user's own instruction packs. When a task matches a skill's description, " +
        "call load_skill with its name first and follow those instructions. Don't load skills that aren't relevant.",
        ...index.map((s) => `- ${s.name}: ${s.description}`),
    ].join("\n");
}
