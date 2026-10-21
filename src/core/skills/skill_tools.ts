import { ToolDefinition } from "../../types/type";
import { metrics } from "../../infra/observability";
import { SkillService } from "./skill_service";

// load_skill: the assistant reads a skill's full instructions when its
// description (listed in every request) matches the task.
export function createSkillTools(skills: SkillService): ToolDefinition[] {
    return [
        {
            name: "load_skill",
            description:
                "Loads the full instructions of one of the user's skills (listed under 'Skills you can load'). " +
                "Call it before doing a task that a skill's description matches, then follow the skill's instructions.",
            parameters: {
                type: "object",
                properties: { name: { type: "string", description: "The skill's name, exactly as listed" } },
                required: ["name"],
            },
            execute: async (args, ctx) => {
                if (!ctx.userId) throw new Error("Skills need a signed-in user.");
                const skill = await skills.load(ctx.userId, String(args.name ?? ""));
                metrics.skillLoads.inc();
                return {
                    name: skill.name,
                    instructions: skill.content,
                    // Files bundled with the skill; open one with read_skill_file when the instructions refer to it.
                    ...(skill.files.length ? {
                        files: skill.files.map((f) => `${f.path}${f.kind === "script" ? " (script — read only, it can't be run here)" : ""}`),
                    } : {}),
                };
            },
        },
        {
            name: "read_skill_file",
            description:
                "Reads one file bundled with a skill (reference docs, templates, examples, scripts). Use it when a loaded " +
                "skill's instructions mention a file, e.g. 'see reference/forms.md'. Scripts can be read but not run.",
            parameters: {
                type: "object",
                properties: {
                    skill: { type: "string", description: "The skill's name" },
                    path: { type: "string", description: "The file's path as listed by load_skill, e.g. reference/forms.md" },
                },
                required: ["skill", "path"],
            },
            execute: async (args, ctx) => {
                if (!ctx.userId) throw new Error("Skills need a signed-in user.");
                const file = await skills.readFile(ctx.userId, String(args.skill ?? ""), String(args.path ?? ""));
                return { skill: String(args.skill), path: file.path, kind: file.kind, content: file.content };
            },
        },
    ];
}
