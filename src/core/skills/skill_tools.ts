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
                return { name: skill.name, instructions: skill.content };
            },
        },
    ];
}
