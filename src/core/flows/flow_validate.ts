import { Branch, Flow, FlowEdge, FlowNode, Route, Rule, RuleOp } from "./flow_types";
import { FIELD_RE, firstNumber, listValues, numberRange, safeRegex } from "./flow_rules";

export const MAX_FLOW_NODES = 30;
export const MAX_ROUTES = 10;
export const MAX_RULES_PER_ROUTE = 10;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const BRANCH_RE = /^(true|false|approved|rejected|default|route:[A-Za-z0-9_-]{1,40})$/;
const RULE_OPS: RuleOp[] = [
    "contains", "not_contains", "equals", "matches", "starts_with", "ends_with", "one_of",
    "number_gt", "number_gte", "number_lt", "number_lte", "number_between",
    "is_empty", "not_empty", "exists", "not_exists",
];
const NO_VALUE: RuleOp[] = ["is_empty", "not_empty", "exists", "not_exists"];

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

// One rule: a known operator, a value it can use, and an optional JSON field.
function validateRule(r: any, where: string): Rule {
    const op = r?.op as RuleOp;
    if (!RULE_OPS.includes(op)) throw new FlowError(`${where}: choose a rule`);
    const field = text(r?.field, 100, `${where} field`);
    if (field && !FIELD_RE.test(field)) throw new FlowError(`${where}: "${field}" isn't a valid field — use names like status, order.total or items[0].sku`);
    if ((op === "exists" || op === "not_exists") && !field) throw new FlowError(`${where}: "exists" needs a JSON field to check`);
    const value = NO_VALUE.includes(op) ? "" : text(r?.value, 500, `${where} value`);
    if (!NO_VALUE.includes(op) && !value) throw new FlowError(`${where}: enter a value for the rule`);
    if (op === "matches" && !safeRegex(value)) throw new FlowError(`${where}: that pattern isn't allowed (too long, invalid, or too slow)`);
    if (op.startsWith("number_") && op !== "number_between" && firstNumber(value) === null) throw new FlowError(`${where}: enter a number to compare with`);
    if (op === "number_between" && !numberRange(value)) throw new FlowError(`${where}: enter a range like 100..500 (lowest first)`);
    if (op === "one_of" && !listValues(value).length) throw new FlowError(`${where}: list the values, separated by commas`);
    return field ? { field, op, value } : { op, value };
}

function validateRoutes(raw: unknown, mode: "rule" | "ai", name: string): Route[] {
    const list = Array.isArray(raw) ? raw : [];
    if (!list.length) throw new FlowError(`${name}: add at least one route`);
    if (list.length > MAX_ROUTES) throw new FlowError(`${name}: at most ${MAX_ROUTES} routes`);
    const ids = new Set<string>(), labels = new Set<string>();
    return list.map((r: any, i: number) => {
        const id = String(r?.id ?? "");
        if (!ID_RE.test(id) || ids.has(id)) throw new FlowError(`${name}: route ${i + 1} has an invalid or duplicate id`);
        ids.add(id);
        const label = text(r?.label, 40, `${name} route ${i + 1} name`, true);
        const key = label.toLowerCase();
        if (key === "otherwise" || key === "none") throw new FlowError(`${name}: "${label}" is reserved — pick another route name`);
        if (labels.has(key)) throw new FlowError(`${name}: two routes are called "${label}"`);
        labels.add(key);
        const where = `${name} → ${label}`;
        if (mode === "ai") {
            const description = text(r?.description, 300, `${where} description`);
            return { id, label, when: { match: "all", rules: [] }, ...(description ? { description } : {}) };
        }
        const rules = Array.isArray(r?.when?.rules) ? r.when.rules : [];
        if (!rules.length) throw new FlowError(`${where}: add at least one rule`);
        if (rules.length > MAX_RULES_PER_ROUTE) throw new FlowError(`${where}: at most ${MAX_RULES_PER_ROUTE} rules`);
        return { id, label, when: { match: r?.when?.match === "any" ? "any" : "all", rules: rules.map((x: any) => validateRule(x, where)) } };
    });
}

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
                    const rule = validateRule(n, `"${name}"`);
                    nodes.push({ id, type: "condition", position, label, mode: "rule", source, ...rule });
                }
                break;
            }
            case "router": {
                const source = text(n.source, 60, `"${name}" source`) || "previous";
                if (!/^(previous|input|node\.[A-Za-z0-9_-]{1,40})$/.test(source)) throw new FlowError(`"${name}": unknown source "${source}"`);
                const mode = n.mode === "ai" ? "ai" : "rule";
                const routes = validateRoutes(n.routes, mode, `"${name}"`);
                const instructions = mode === "ai" ? text(n.instructions, 1000, `"${name}" instructions`) : "";
                nodes.push({ id, type: "router", position, label, mode, source, routes, ...(instructions ? { instructions } : {}) });
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
        const branch = typeof e?.branch === "string" && BRANCH_RE.test(e.branch) ? (e.branch as Branch) : undefined;
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
        } else if (n.type === "router") {
            // Every route and Otherwise lead somewhere, so no run can dead-end.
            const expected = [...n.routes.map((r) => `route:${r.id}`), "default"];
            const missing = n.routes.find((r) => !branches.includes(`route:${r.id}`));
            if (missing) throw new FlowError(`${name}: connect the "${missing.label}" route`);
            if (!branches.includes("default")) throw new FlowError(`${name}: connect the Otherwise route`);
            if (out.some((e) => !expected.includes(e.branch ?? ""))) throw new FlowError(`${name}: a connection belongs to a route that was removed — delete it`);
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
