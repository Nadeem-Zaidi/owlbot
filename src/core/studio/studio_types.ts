import type { Branch, FlowNode, Position } from "../flows/flow_types";
import type { ScheduleTiming } from "../../service/agents/schedule_time";

// Agent Studio: an n8n-style canvas. Agents are big nodes with sub-nodes
// plugged into their ports (a model, tools, knowledge, skills); agents and
// flow steps are chained left → right from one trigger.
//
// Saving turns every agent node into a real agent (also on the Agents page)
// and compiles the canvas into a hidden workflow, which runs it.

export type TriggerConfig =
    | { type: "manual" }
    | { type: "schedule"; timing: ScheduleTiming; input: string }
    | { type: "webhook" }
    | { type: "chat"; command: string };

export type TriggerType = TriggerConfig["type"];

// The parts of an agent edited on the canvas. Everything else (instruction
// files, starters, HTTP/code functions, MCP servers) is kept as it is.
export type AgentDraft = { name: string; icon: string; description: string; instructions: string };

export type Port = "model" | "tools" | "knowledge" | "skills";

// Flow steps shared with Workflows (same settings, same engine).
export type StudioStepNode = Extract<FlowNode, { type: "condition" | "router" | "approval" | "notify" | "end" }>;

export type StudioNode =
    | { id: string; type: "trigger"; position: Position; label?: string; trigger: TriggerConfig }
    // agent_id: the real agent; null until the first save creates it.
    | { id: string; type: "agent"; position: Position; label?: string; agent_id: string | null; instruction: string; agent: AgentDraft }
    // Sub-nodes, each wired to one agent's port.
    | { id: string; type: "model"; position: Position; provider: string; model: string | null }
    | { id: string; type: "tool"; position: Position; tool: string }
    | { id: string; type: "knowledge"; position: Position; document_keys: string[] }
    // skill_id "*" = all of the user's skills.
    | { id: string; type: "skill"; position: Position; skill_id: string }
    | StudioStepNode;

export type StudioNodeType = StudioNode["type"];
export type SubNodeType = "model" | "tool" | "knowledge" | "skill";
export const SUB_PORT: Record<SubNodeType, Port> = { model: "model", tool: "tools", knowledge: "knowledge", skill: "skills" };

// Main edges link flow nodes (branch for conditions/routers/approvals);
// port edges link a sub-node (from) to an agent (to).
export type StudioEdge = { id: string; from: string; to: string; branch?: Branch; port?: Port };

export type StudioCanvas = { version: 1; nodes: StudioNode[]; edges: StudioEdge[] };
