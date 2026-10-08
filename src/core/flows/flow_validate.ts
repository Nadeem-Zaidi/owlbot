import { Branch, Flow, FlowEdge, FlowNode, RuleOp } from "./flow_types";
import { safeRegex } from "./flow_rules";

export const MAX_FLOW_NODES = 30;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const RULE_OPS: RuleOp[] = ["contains", "not_contains", "equals", "matches", "number_gt", "number_gte", "number_lt", "number_lte", "is_empty", "not_empty"];

export class FlowError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
    }
}

const text = (v: unknown, max: number, what: string, required = false) => {
    const s = typeof v === "string" ? v.trim() : "";
    if (required && !s) throw new FlowError(`${what} is required`);
    if (s.length > max) throw new FlowError(`${what} must be at most ${max} characters`);
    return s;
};
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : 0);

// Checks and normalizes a workflow from the editor. `agentExists` confirms
// each agent step points at one of the user's agents.
export async function validateFlow(raw: any, agentExists: (kind: "agent" | "native", id: string) => Promise<boolean>): Promise<Flow> {
    const rawNodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
    const rawEdges = Array.isArray(raw?.edges) ? raw.edges : [];
    if (rawNodes.length > MAX_FLOW_NODES) throw new FlowError(`A workflow can have at most ${MAX_FLOW_NODES} steps`);

    const nodes: FlowNode[] = [];
    const ids = new Set<string>();
    for (const n of rawNodes) {
        const id = String(n?.id ?? "");
        if (!ID_RE.test(id) || ids.has(id)) throw new FlowError(`Invalid or duplicate step id "${id}"`);
        ids.add(id);
        const position = { x: num(n?.position?.x), y: num(n?.position?.y) };
        const label = text(n?.label, 60, "Step name") || undefined;
        const name = label ?? id;
        switch (n?.type) {
            case "start":
                nodes.push({ id, type: "start", position, label });
                break;
            case "agent": {
                const agent_kind = n.agent_kind === "native" ? "native" : "agent";
                const agent_id = String(n.agent_id ?? "");
                if (!agent_id || !(await agentExists(agent_kind, agent_id))) throw new FlowError(`"${name}": choose one of your agents`);
                nodes.push({ id, type: "agent", position, label, agent_kind, agent_id, instruction: text(n.instruction, 4000, `"${name}" instruction`) });
                break;
            }
            case "condition": {
                const source = text(n.source, 60, `"${name}" source`) || "previous";
                if (!/^(previous|input|node\.[A-Za-z0-9_-]{1,40})$/.test(source)) throw new FlowError(`"${name}": unknown source "${source}"`);
                if (n.mode === "ai") {
                    nodes.push({ id, type: "condition", position, label, mode: "ai", source, question: text(n.question, 500, `"${name}" question`, true) });
                } else {
                    const op = n.op as RuleOp;
                    if (!RULE_OPS.includes(op)) throw new FlowError(`"${name}": choose a rule`);
                    const value = text(n.value, 500, `"${name}" value`);
                    if (op === "matches" && !safeRegex(value)) throw new FlowError(`"${name}": that pattern isn't allowed (too long, invalid, or too slow)`);
                    if (!["is_empty", "not_empty"].includes(op) && !value) throw new FlowError(`"${name}": enter a value for the rule`);
                    nodes.push({ id, type: "condition", position, label, mode: "rule", source, op, value });
                }
                break;
            }
            case "approval":
                nodes.push({ id, type: "approval", position, label, message: text(n.message, 2000, `"${name}" message`) || "Approve to continue?", notify: n.notify !== false });
                break;
            case "notify":
                nodes.push({ id, type: "notify", position, label, message: text(n.message, 2000, `"${name}" message`, true) });
                break;
            case "end":
                nodes.push({ id, type: "end", position, label, output: text(n.output, 2000, `"${name}" output`) || "{{previous}}" });
                break;
            default:
                throw new FlowError(`Unknown step type "${n?.type}"`);
        }
    }
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const starts = nodes.filter((n) => n.type === "start");
    if (starts.length !== 1) throw new FlowError("A workflow needs exactly one Start");
    if (!nodes.some((n) => n.type === "end")) throw new FlowError("Add an End step");

    const edges: FlowEdge[] = [];
    const seen = new Set<string>();
    for (const e of rawEdges) {
        const from = String(e?.from ?? ""), to = String(e?.to ?? "");
        if (!byId.has(from) || !byId.has(to)) throw new FlowError("A connection points to a step that doesn't exist");
        if (from === to) throw new FlowError("A step can't connect to itself");
        const branch = ["true", "false", "approved", "rejected"].includes(e?.branch) ? (e.branch as Branch) : undefined;
        const key = `${from}:${branch ?? ""}`;
        if (seen.has(key)) throw new FlowError(`"${byId.get(from)!.label ?? from}" has two connections for the same outcome`);
        seen.add(key);
        edges.push({ id: String(e?.id ?? key).slice(0, 80), from, to, branch });
    }

    // Each step type has fixed outgoing connections.
    for (const n of nodes) {
        const out = edges.filter((e) => e.from === n.id);
        const name = `"${n.label ?? n.id}"`;
        const branches = out.map((e) => e.branch ?? "");
        if (n.type === "end") {
            if (out.length) throw new FlowError(`${name}: End can't continue to another step`);
        } else if (n.type === "condition") {
            if (!(branches.includes("true") && branches.includes("false") && out.length === 2)) throw new FlowError(`${name}: connect both the Yes and the No outcome`);
        } else if (n.type === "approval") {
            if (!branches.includes("approved") || out.some((e) => e.branch !== "approved" && e.branch !== "rejected")) throw new FlowError(`${name}: connect the Approved outcome (Rejected is optional)`);
        } else if (out.length !== 1 || out[0].branch) {
            throw new FlowError(`${name}: connect it to exactly one next step`);
        }
        if (edges.some((e) => e.to === n.id) && n.type === "start") throw new FlowError("Nothing can connect into Start");
    }

    // No loops, and every step reachable from Start.
    const next = (id: string) => edges.filter((e) => e.from === id).map((e) => e.to);
    const state = new Map<string, 1 | 2>();
    const visit = (id: string) => {
        if (state.get(id) === 1) throw new FlowError("The workflow has a loop — steps can't lead back to an earlier step");
        if (state.get(id) === 2) return;
        state.set(id, 1);
        for (const t of next(id)) visit(t);
        state.set(id, 2);
    };
    visit(starts[0].id);
    const unreachable = nodes.filter((n) => !state.has(n.id));
    if (unreachable.length) throw new FlowError(`"${unreachable[0].label ?? unreachable[0].id}" isn't connected to the workflow`);

    return { version: 1, nodes, edges };
}

// Old linear pipelines as a flow: Start → step 1 → … → End.
export function stepsToFlow(steps: { kind?: "agent" | "native"; agent_id: string; instruction: string }[]): Flow {
    const nodes: FlowNode[] = [{ id: "start", type: "start", position: { x: 0, y: 0 } }];
    const edges: FlowEdge[] = [];
    let prev = "start";
    steps.forEach((s, i) => {
        const id = `step${i + 1}`;
        nodes.push({ id, type: "agent", position: { x: 0, y: (i + 1) * 140 }, agent_kind: s.kind ?? "agent", agent_id: s.agent_id, instruction: s.instruction });
        edges.push({ id: `${prev}-${id}`, from: prev, to: id });
        prev = id;
    });
    nodes.push({ id: "end", type: "end", position: { x: 0, y: (steps.length + 1) * 140 }, output: "{{previous}}" });
    edges.push({ id: `${prev}-end`, from: prev, to: "end" });
    return { version: 1, nodes, edges };
}
