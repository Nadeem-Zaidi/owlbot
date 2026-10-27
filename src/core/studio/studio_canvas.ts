import { randomUUID } from "node:crypto";
import type { AgentRow } from "../../repository/agent_repository";
import { BUILTIN_TOOL_IDS } from "../../service/agents/agent_tools";
import { ScheduleTiming, validateTiming } from "../../service/agents/schedule_time";
import type { FlowNode } from "../flows/flow_types";
import { MAX_PARALLEL_BRANCHES } from "../flows/flow_validate";
import { AgentDraft, Port, StudioCanvas, StudioEdge, StudioNode, SUB_PORT, SubNodeType, TriggerConfig } from "./studio_types";

export const MAX_STUDIO_NODES = 90;      // everything on the canvas
export const MAX_STUDIO_STEPS = 25;      // trigger + agents + flow steps (the workflow allows 30; replies are added)
export const MAX_STUDIO_EDGES = 200;
export const MAX_DOCS_PER_NODE = 50;
const ID_RE = /^(?!__)[A-Za-z0-9_-]{1,40}$/;
const COMMAND_RE = /^[a-z][a-z0-9_]{1,30}$/;
// Commands the chat bridge already uses.
export const RESERVED_COMMANDS = new Set(["help", "start", "new", "docs", "explain", "model", "agents", "agent", "unlink", "flows", "stop", "cancel"]);
const SUB_TYPES = new Set<string>(["model", "tool", "knowledge", "skill"]);
const STEP_TYPES = new Set<string>(["condition", "router", "approval", "notify", "end"]);

export class StudioError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
    }
}

const text = (v: unknown, max: number, what: string, required = false) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (required && !s) throw new StudioError(`${what} is required`);
    if (s.length > max) throw new StudioError(`${what} must be at most ${max} characters`);
    return s;
};
const pos = (p: any) => ({ x: Number.isFinite(Number(p?.x)) ? Math.round(Number(p.x)) : 0, y: Number.isFinite(Number(p?.y)) ? Math.round(Number(p.y)) : 0 });
export const isSub = (n: { type: string }): n is Extract<StudioNode, { type: SubNodeType }> => SUB_TYPES.has(n.type);

export function validateTrigger(raw: any): TriggerConfig {
    switch (raw?.type) {
        case "manual":
        case undefined:
            return { type: "manual" };
        case "webhook":
            return { type: "webhook" };
        case "schedule": {
            const t = raw.timing ?? {};
            const timing: ScheduleTiming = {
                frequency: t.frequency,
                interval_hours: t.frequency === "hourly" ? Number(t.interval_hours) : null,
                time_of_day: t.frequency === "hourly" ? null : typeof t.time_of_day === "string" ? t.time_of_day : null,
                weekday: t.frequency === "weekly" ? Number(t.weekday) : null,
                timezone: typeof t.timezone === "string" && t.timezone ? t.timezone : "UTC",
            };
            try {
                validateTiming(timing);
            } catch (err) {
                throw new StudioError(`Schedule: ${err instanceof Error ? err.message : String(err)}`);
            }
            return { type: "schedule", timing, input: text(raw.input, 4000, "The scheduled input") };
        }
        case "chat": {
            const command = String(raw.command ?? "").trim().toLowerCase().replace(/^\//, "");
            if (!COMMAND_RE.test(command)) throw new StudioError("Chat command: 2–31 letters, numbers or _ — starting with a letter (e.g. triage)");
            if (RESERVED_COMMANDS.has(command)) throw new StudioError(`/${command} is already a built-in command — pick another`);
            return { type: "chat", command };
        }
        default:
            throw new StudioError("Unknown trigger");
    }
}

function validateDraft(raw: any, where: string): AgentDraft {
    return {
        name: text(raw?.name, 60, `${where}: agent name`, true),
        icon: text(raw?.icon, 8, `${where}: icon`) || "🤖",
        description: text(raw?.description, 300, `${where}: description`),
        instructions: text(raw?.instructions, 20_000, `${where}: instructions`),
    };
}

// Shape checks for the canvas. Flow steps (conditions, routers, approvals,
// notify, end) are passed through here and fully checked by validateFlow
// on the compiled workflow.
export function parseCanvas(raw: any, userId: string): StudioCanvas {
    const rawNodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
    const rawEdges = Array.isArray(raw?.edges) ? raw.edges : [];
    if (rawNodes.length > MAX_STUDIO_NODES) throw new StudioError(`A project can have at most ${MAX_STUDIO_NODES} nodes`);
    if (rawEdges.length > MAX_STUDIO_EDGES) throw new StudioError(`A project can have at most ${MAX_STUDIO_EDGES} connections`);

    const nodes: StudioNode[] = [];
    const ids = new Set<string>();
    for (const n of rawNodes) {
        const id = String(n?.id ?? "");
        if (!ID_RE.test(id) || ids.has(id)) throw new StudioError(`Invalid or duplicate node id "${id}"`);
        ids.add(id);
        const position = pos(n?.position);
        const label = text(n?.label, 60, "Node name") || undefined;
        switch (n?.type) {
            case "trigger":
                nodes.push({ id, type: "trigger", position, label, trigger: validateTrigger(n.trigger) });
                break;
            case "agent": {
                const agent = validateDraft(n.agent, `"${label ?? n?.agent?.name ?? id}"`);
                const agent_id = typeof n.agent_id === "string" && n.agent_id ? n.agent_id.slice(0, 80) : null;
                nodes.push({ id, type: "agent", position, label, agent_id, instruction: text(n.instruction, 4000, `"${label ?? agent.name}" task`), agent });
                break;
            }
            case "model":
                nodes.push({ id, type: "model", position, provider: text(n.provider, 80, "Model provider", true), model: text(n.model, 200, "Model") || null });
                break;
            case "tool": {
                const tool = String(n.tool ?? "");
                if (!BUILTIN_TOOL_IDS.has(tool)) throw new StudioError(`Unknown tool "${tool}"`);
                nodes.push({ id, type: "tool", position, tool });
                break;
            }
            case "knowledge": {
                const keys = Array.isArray(n.document_keys) ? n.document_keys : [];
                if (keys.length > MAX_DOCS_PER_NODE) throw new StudioError(`A knowledge node can hold at most ${MAX_DOCS_PER_NODE} documents`);
                const document_keys = [...new Set<string>(keys.filter((k: unknown): k is string => typeof k === "string" && k.startsWith(`${userId}/`) && !k.includes("..")))];
                nodes.push({ id, type: "knowledge", position, document_keys });
                break;
            }
            case "skill":
                nodes.push({ id, type: "skill", position, skill_id: text(n.skill_id, 80, "Skill", true) });
                break;
            default:
                if (!STEP_TYPES.has(n?.type)) throw new StudioError(`Unknown node type "${n?.type}"`);
                nodes.push({ ...n, id, position, label } as StudioNode);
        }
    }
    if (nodes.filter((n) => n.type === "trigger").length !== 1) throw new StudioError("A project needs exactly one trigger");
    const steps = nodes.filter((n) => !isSub(n)).length;
    if (steps > MAX_STUDIO_STEPS) throw new StudioError(`A project can have at most ${MAX_STUDIO_STEPS} agents and steps`);

    const byId = new Map(nodes.map((n) => [n.id, n]));
    const edges: StudioEdge[] = [];
    const plugged = new Map<string, string>();      // sub-node → agent
    for (const e of rawEdges) {
        const from = byId.get(String(e?.from ?? "")), to = byId.get(String(e?.to ?? ""));
        if (!from || !to) throw new StudioError("A connection points to a node that doesn't exist");
        const id = String(e?.id ?? `${from.id}-${to.id}`).slice(0, 80);
        if (isSub(from) || isSub(to)) {
            // A sub-node plugs into the matching port of one agent.
            if (!isSub(from) || to.type !== "agent") throw new StudioError("Models, tools, knowledge and skills plug into an agent");
            const port = SUB_PORT[from.type];
            if (e?.port && e.port !== port) throw new StudioError(`A ${from.type} goes into an agent's ${port} port`);
            if (plugged.has(from.id)) throw new StudioError(`A ${from.type} can plug into only one agent`);
            plugged.set(from.id, to.id);
            edges.push({ id, from: from.id, to: to.id, port });
            continue;
        }
        edges.push({ id, from: from.id, to: to.id, ...(typeof e?.branch === "string" ? { branch: e.branch } : {}) });
    }
    for (const n of nodes) {
        if (isSub(n) && !plugged.has(n.id)) throw new StudioError(`A ${n.type === "tool" ? "tool" : n.type} node isn't plugged into an agent — connect it or delete it`);
    }
    for (const a of nodes) {
        if (a.type !== "agent") continue;
        const models = edges.filter((e) => e.to === a.id && e.port === "model");
        if (models.length > 1) throw new StudioError(`"${a.label ?? a.agent.name}" has more than one model plugged in`);
    }
    return { version: 1, nodes, edges };
}

export type Attachments = { model: { provider: string; model: string | null } | null; tools: string[]; documentKeys: string[]; skills: string[] };

// What's plugged into an agent node.
export function attachments(canvas: StudioCanvas, agentNodeId: string): Attachments {
    const byId = new Map(canvas.nodes.map((n) => [n.id, n]));
    const subs = canvas.edges.filter((e) => e.to === agentNodeId && e.port).map((e) => byId.get(e.from)).filter((n): n is StudioNode => !!n);
    const model = subs.find((n): n is Extract<StudioNode, { type: "model" }> => n.type === "model");
    const uniq = (xs: string[]) => [...new Set(xs)];
    return {
        model: model ? { provider: model.provider, model: model.model } : null,
        tools: uniq(subs.flatMap((n) => (n.type === "tool" ? [n.tool] : []))),
        documentKeys: uniq(subs.flatMap((n) => (n.type === "knowledge" ? n.document_keys : []))),
        skills: uniq(subs.flatMap((n) => (n.type === "skill" ? [n.skill_id] : []))),
    };
}

// The body AgentService validates and saves. Fields the canvas doesn't edit
// (instruction files, starters) come from the existing agent.
export function agentBody(draft: AgentDraft, att: Attachments, existing: AgentRow | null) {
    const skillIds = att.skills.filter((s) => s !== "*");
    return {
        name: draft.name,
        icon: draft.icon,
        description: draft.description,
        instructions: draft.instructions,
        provider: att.model?.provider ?? null,
        model: att.model?.model ?? null,
        builtin_tools: att.tools,
        document_keys: att.documentKeys,
        starters: existing?.starters ?? [],
        instruction_files: existing?.instruction_files ?? [],
        skill_mode: att.skills.includes("*") ? "all" : skillIds.length ? "selected" : "none",
        skill_ids: skillIds,
    };
}

export const REPLY_PREFIX = "__reply_";

// The workflow that runs the canvas: trigger → Start, agent nodes → agent
// steps (by their real agent id), flow steps as they are. Sub-nodes live in
// the agents' own settings. With `deliver`, a "send the result" step goes in
// front of every End.
export function compileFlow(canvas: StudioCanvas, agentIdOf: (nodeId: string) => string, deliver: { projectName: string } | null) {
    let nodes: any[] = [];
    for (const n of canvas.nodes) {
        if (isSub(n)) continue;
        if (n.type === "trigger") nodes.push({ id: n.id, type: "start", position: n.position, label: n.label ?? "Trigger" });
        else if (n.type === "agent") nodes.push({ id: n.id, type: "agent", position: n.position, label: (n.label || n.agent.name).slice(0, 60), agent_kind: "agent", agent_id: agentIdOf(n.id), instruction: n.instruction });
        else nodes.push(n as FlowNode);
    }
    let edges: any[] = canvas.edges.filter((e) => !e.port).map((e) => ({ id: e.id, from: e.from, to: e.to, ...(e.branch ? { branch: e.branch } : {}) }));
    ({ nodes, edges } = groupParallel(nodes, edges));
    if (deliver) {
        const ends = canvas.nodes.filter((n): n is Extract<StudioNode, { type: "end" }> => n.type === "end");
        ends.forEach((end, i) => {
            const id = `${REPLY_PREFIX}${i}`;
            const title = deliver.projectName.replace(/[{}]/g, "");
            nodes.push({ id, type: "notify", position: { x: end.position.x - 40, y: end.position.y }, label: "Send the result", message: `✅ **${title}**\n\n${end.output || "{{previous}}"}`.slice(0, 2000) });
            edges = edges.map((e) => (e.to === end.id ? { ...e, to: id } : e));
            edges.push({ id: `${id}-${end.id}`, from: id, to: end.id });
        });
    }
    return { version: 1, nodes, edges };
}

export const PARALLEL_PREFIX = "__par_";

// One output wired to several agents that all lead into the same next step
// runs those agents at the same time: they become one parallel step (each
// agent a branch, keyed by its node id). {{node.<agent node>}} elsewhere
// then points at that branch's answer.
function groupParallel(nodes: any[], edges: any[]): { nodes: any[]; edges: any[] } {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const outOf = (id: string) => edges.filter((e) => e.from === id);
    const name = (id: string): string => byId.get(id)?.label ?? id;
    const groups = new Map<string, any[]>();       // "from:branch" → its edges
    for (const e of edges) groups.set(`${e.from}:${e.branch ?? ""}`, [...(groups.get(`${e.from}:${e.branch ?? ""}`) ?? []), e]);

    const renamed = new Map<string, string>();     // agent node id → "<parallel id>.<agent node id>"
    let k = 0;
    for (const fan of groups.values()) {
        if (fan.length < 2) continue;
        const from = `"${name(fan[0].from)}"`;
        const agents = fan.map((e) => byId.get(e.to));
        if (agents.some((a) => a?.type !== "agent")) throw new StudioError(`${from} connects to several steps — only agents can run side by side. Keep one connection, or connect it only to agents`);
        if (fan.length > MAX_PARALLEL_BRANCHES) throw new StudioError(`${from}: at most ${MAX_PARALLEL_BRANCHES} agents can run at the same time`);
        let join: string | null = null;
        for (const a of agents) {
            if (edges.filter((e) => e.to === a.id).length !== 1) throw new StudioError(`"${name(a.id)}" runs alongside other agents, so only ${from} can connect into it`);
            const out = outOf(a.id);
            if (out.length !== 1) throw new StudioError(`"${name(a.id)}" runs alongside other agents — connect it to exactly one next step`);
            join ??= out[0].to;
            if (out[0].to !== join) throw new StudioError(`The agents after ${from} run at the same time, so they must all connect into the same next step`);
        }

        const id = `${PARALLEL_PREFIX}${k++}`;
        const used = new Set<string>();
        const branches = agents.map((a) => {
            let label = (a.label as string).slice(0, 40);
            for (let i = 2; used.has(label.toLowerCase()); i++) label = `${(a.label as string).slice(0, 36)} ${i}`;
            used.add(label.toLowerCase());
            renamed.set(a.id, `${id}.${a.id}`);
            return { id: a.id, label, agent_kind: "agent", agent_id: a.agent_id, instruction: a.instruction };
        });
        const position = { x: Math.round(agents.reduce((s, a) => s + a.position.x, 0) / agents.length), y: Math.round(agents.reduce((s, a) => s + a.position.y, 0) / agents.length) };
        const gone = new Set(agents.map((a) => a.id));
        nodes = [...nodes.filter((n) => !gone.has(n.id)), { id, type: "parallel", position, label: "Agents in parallel", branches, require_all: true }];
        edges = [
            ...edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
            { id: `${id}-in`, from: fan[0].from, to: id, ...(fan[0].branch ? { branch: fan[0].branch } : {}) },
            { id: `${id}-out`, from: id, to: join },
        ];
    }
    if (!renamed.size) return { nodes, edges };
    // {{node.<agent node>}} and "node.<agent node>" sources → that branch's answer.
    const ref = /node\.([A-Za-z0-9_-]+)(?![A-Za-z0-9_.-])/g;
    nodes = nodes.map((n) => JSON.parse(JSON.stringify(n).replace(ref, (m, id: string) => (renamed.has(id) ? `node.${renamed.get(id)}` : m))));
    return { nodes, edges };
}

// An agent can appear several times (e.g. Jira at the start and the end).
// Its settings — what's plugged into it — live on one "primary" node: the
// occurrence with the most sub-nodes (first one on ties). The others share
// them and only have their own task.
export function primaryAgentNodes(canvas: StudioCanvas): Map<string, string> {
    const subCount = (id: string) => canvas.edges.filter((e) => e.to === id && e.port).length;
    const primary = new Map<string, { id: string; subs: number }>();
    for (const n of canvas.nodes) {
        if (n.type !== "agent" || !n.agent_id) continue;
        const subs = subCount(n.id);
        const cur = primary.get(n.agent_id);
        if (!cur || subs > cur.subs) primary.set(n.agent_id, { id: n.id, subs });
    }
    return new Map([...primary].map(([agentId, p]) => [agentId, p.id]));
}

// Keeps the canvas true to the agents as they are now (they can also be
// edited on the Agents page): refreshes each agent node's draft and
// re-creates its sub-nodes from the agent's settings, keeping the positions
// of sub-nodes that still apply. Deleted agents get agent_id null (the next
// save creates them again).
export function syncFromAgents(canvas: StudioCanvas, rows: Map<string, AgentRow>): StudioCanvas {
    const nodes = [...canvas.nodes];
    let edges = [...canvas.edges];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const drop = new Set<string>();
    const primary = primaryAgentNodes(canvas);

    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n.type !== "agent" || !n.agent_id) continue;
        const row = rows.get(n.agent_id);
        if (!row) {
            nodes[i] = { ...n, agent_id: null };
            continue;
        }
        nodes[i] = { ...n, agent: { name: row.name, icon: row.icon || "🤖", description: row.description ?? "", instructions: row.instructions ?? "" } };
        // Repeats of an agent share the primary's sub-nodes.
        if (primary.get(n.agent_id) !== n.id) {
            for (const e of edges) if (e.to === n.id && e.port) drop.add(e.from);
            continue;
        }

        const want: { type: SubNodeType; key: string; make: (id: string, position: { x: number; y: number }) => StudioNode }[] = [];
        if (row.provider) want.push({ type: "model", key: `${row.provider}|${row.model ?? ""}`, make: (id, position) => ({ id, type: "model", position, provider: row.provider!, model: row.model ?? null }) });
        for (const t of row.builtin_tools ?? []) want.push({ type: "tool", key: t, make: (id, position) => ({ id, type: "tool", position, tool: t }) });
        if ((row.document_keys ?? []).length) {
            const keys = [...row.document_keys].sort().join("|");
            want.push({ type: "knowledge", key: keys, make: (id, position) => ({ id, type: "knowledge", position, document_keys: row.document_keys }) });
        }
        if (row.skill_mode === "all") want.push({ type: "skill", key: "*", make: (id, position) => ({ id, type: "skill", position, skill_id: "*" }) });
        else if (row.skill_mode === "selected") for (const s of row.skill_ids ?? []) want.push({ type: "skill", key: s, make: (id, position) => ({ id, type: "skill", position, skill_id: s }) });

        const keyOf = (s: StudioNode) => s.type === "model" ? `${s.provider}|${s.model ?? ""}` : s.type === "tool" ? s.tool : s.type === "knowledge" ? [...s.document_keys].sort().join("|") : s.type === "skill" ? s.skill_id : "";
        const current = edges.filter((e) => e.to === n.id && e.port).map((e) => byId.get(e.from)).filter((s): s is StudioNode => !!s && isSub(s));
        const kept = new Set<string>();
        let added = 0;
        for (const w of want) {
            const match = current.find((s) => s.type === w.type && !kept.has(s.id) && keyOf(s) === w.key)
                // A knowledge node whose documents changed keeps its place.
                ?? (w.type === "knowledge" ? current.find((s) => s.type === "knowledge" && !kept.has(s.id)) : undefined);
            if (match) {
                kept.add(match.id);
                if (match.type === "knowledge" && keyOf(match) !== w.key) {
                    const idx = nodes.findIndex((x) => x.id === match.id);
                    nodes[idx] = w.make(match.id, match.position);
                }
                continue;
            }
            const id = `${w.type}_${randomUUID().slice(0, 8)}`;
            const position = { x: n.position.x + 20 + (current.length + added) * 90, y: n.position.y + 170 };
            added++;
            nodes.push(w.make(id, position));
            edges.push({ id: `${id}-${n.id}`, from: id, to: n.id, port: SUB_PORT[w.type] as Port });
        }
        for (const s of current) if (!kept.has(s.id)) drop.add(s.id);
    }
    edges = edges.filter((e) => !drop.has(e.from) && !drop.has(e.to));
    return { version: 1, nodes: nodes.filter((n) => !drop.has(n.id)), edges };
}
