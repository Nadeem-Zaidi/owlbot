// A workflow is a small graph: nodes connected by edges, run from "start"
// to an "end". Branching nodes label their outgoing edges.
//
//   start      → the run's input
//   agent      → one of your agents (or provider agents) does a task
//   condition  → true/false: a rule on text ("contains", "number > 50000")
//                or a yes/no question answered by the AI
//   approval   → pauses until you approve or reject (optionally notifies you)
//   notify     → sends a message to your WhatsApp / Telegram
//   end        → finishes with an output
//
// Text fields are templates: {{input}} (the run's input), {{previous}} (the
// last step's output) and {{node.<id>}} (any earlier node's output).

export type Position = { x: number; y: number };

export type RuleOp =
    | "contains" | "not_contains" | "equals" | "matches"
    | "number_gt" | "number_gte" | "number_lt" | "number_lte"
    | "is_empty" | "not_empty";

export type FlowNode =
    | { id: string; type: "start"; position: Position; label?: string }
    | { id: string; type: "agent"; position: Position; label?: string; agent_kind: "agent" | "native"; agent_id: string; instruction: string }
    | { id: string; type: "condition"; position: Position; label?: string; mode: "rule"; source: string; op: RuleOp; value: string }
    | { id: string; type: "condition"; position: Position; label?: string; mode: "ai"; source: string; question: string }
    | { id: string; type: "approval"; position: Position; label?: string; message: string; notify: boolean }
    | { id: string; type: "notify"; position: Position; label?: string; message: string }
    | { id: string; type: "end"; position: Position; label?: string; output: string };

export type NodeType = FlowNode["type"];
export type Branch = "true" | "false" | "approved" | "rejected";

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
