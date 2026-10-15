// A workflow is a small graph: nodes connected by edges, run from "start"
// to an "end". Branching nodes label their outgoing edges.
//
//   start      → the run's input
//   agent      → one of your agents (or provider agents) does a task
//   condition  → true/false: a rule on text ("contains", "number > 50000")
//                or a yes/no question answered by the AI
//   router     → many ways: named routes checked in order (each a group of
//                rules, ALL or ANY), or the AI picks the best route; anything
//                that matches no route goes to "Otherwise"
//   approval   → pauses until you approve or reject (optionally notifies you)
//   notify     → sends a message to your WhatsApp / Telegram
//   end        → finishes with an output
//
// Text fields are templates: {{input}} (the run's input), {{previous}} (the
// last step's output) and {{node.<id>}} (any earlier node's output; for a
// router, the name of the route it took).
//
// Rules can read a JSON field of the text ("status", "order.total",
// "items[0].sku") when an agent answers in JSON, fenced or not.

export type Position = { x: number; y: number };

export type RuleOp =
    | "contains" | "not_contains" | "equals" | "matches"
    | "number_gt" | "number_gte" | "number_lt" | "number_lte"
    | "is_empty" | "not_empty"
    | "starts_with" | "ends_with" | "one_of" | "number_between"
    | "exists" | "not_exists";

// One check. `field` is an optional JSON path into the text.
export type Rule = { field?: string; op: RuleOp; value: string };
export type RuleGroup = { match: "all" | "any"; rules: Rule[] };

// A router's outgoing path. Rule mode uses `when`; AI mode uses `description`
// ("when to pick this route") to classify.
export type Route = { id: string; label: string; when: RuleGroup; description?: string };

export type FlowNode =
    | { id: string; type: "start"; position: Position; label?: string }
    | { id: string; type: "agent"; position: Position; label?: string; agent_kind: "agent" | "native"; agent_id: string; instruction: string }
    | { id: string; type: "condition"; position: Position; label?: string; mode: "rule"; source: string; field?: string; op: RuleOp; value: string }
    | { id: string; type: "condition"; position: Position; label?: string; mode: "ai"; source: string; question: string }
    | { id: string; type: "router"; position: Position; label?: string; mode: "rule" | "ai"; source: string; routes: Route[]; instructions?: string }
    | { id: string; type: "approval"; position: Position; label?: string; message: string; notify: boolean }
    | { id: string; type: "notify"; position: Position; label?: string; message: string }
    | { id: string; type: "end"; position: Position; label?: string; output: string };

export type NodeType = FlowNode["type"];
// Router edges use "route:<route id>" and "default" (Otherwise).
export type Branch = "true" | "false" | "approved" | "rejected" | "default" | `route:${string}`;

export type FlowEdge = { id: string; from: string; to: string; branch?: Branch };

export type Flow = { version: 1; nodes: FlowNode[]; edges: FlowEdge[] };

// One executed node in a run (stored in pipeline_runs.steps).
export type FlowTraceEntry = {
    node_id: string;
    type: NodeType;
    label: string;
    status: "running" | "succeeded" | "failed" | "waiting" | "rejected" | "skipped";
    // Agent steps (same fields the pipeline run view shows).
    kind?: "agent" | "native";
    agent_id?: string;
    agent_name?: string;
    agent_icon?: string;
    prompt?: string;
    output?: string;
    error?: string;
    branch?: Branch;
    branch_label?: string;      // router: the route's name at run time
    decided_by?: string;
    comment?: string;
    started_at?: string;
    finished_at?: string;
};

// Where a run is, so it can pause (approval) and continue later — on any server.
export type FlowRunState = {
    current: string | null;
    input: string;
    previous: string;
    outputs: Record<string, string>;
    executed: number;
    touched_at: string;
};
