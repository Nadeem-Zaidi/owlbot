import { NativeAgentInput, NativeProvider } from "../../repository/native_agent_repository";
import { TokenCounts } from "../../repository/usage_repository";

// What the provider needs to build its agent object.
export type NativeAgentSpec = Omit<NativeAgentInput, "provider" | "icon">;

// A tool our server runs on the agent's behalf (the provider calls it, we
// answer). Used for the knowledge base, which lives in our database.
export type NativeTool = {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    run: (args: Record<string, unknown>) => Promise<string>;
};

// The hosted browser asking before it continues (OpenAI computer use).
export type ApprovalField = { id: string; label: string; required: boolean; type: string };
export type ApprovalRequest =
    | { kind: "origin"; requestId: string; origin: string; reason: string | null }
    | { kind: "signin"; requestId: string; origin: string | null; reason: string | null; fields: ApprovalField[]; options: { id: string; label: string; field_ids: string[] }[] };
export type ApprovalAnswer =
    | { kind: "origin"; decision: "approve" | "deny" | "cancel" }
    | { kind: "signin"; action: "submit"; fields: { field_id: string; value: string }[]; selected_option?: string | null }
    | { kind: "signin"; action: "cancel" };

export const cancelAnswer = (req: ApprovalRequest): ApprovalAnswer =>
    req.kind === "origin" ? { kind: "origin", decision: "cancel" } : { kind: "signin", action: "cancel" };

// One turn, as a provider-neutral stream.
export type NativeTurnEvent =
    | { type: "text"; text: string }
    | { type: "approval_request"; request: ApprovalRequest }
    | { type: "approval_resolved"; requestId: string; outcome: string }
    | { type: "screenshot"; id: string; image: string }
    | { type: "tool_start"; id: string; name: string; input?: unknown }
    | { type: "tool_end"; id: string; name: string; output?: string; isError?: boolean }
    | { type: "usage"; usage: Partial<TokenCounts>; model?: string }
    | { type: "error"; message: string };

export type NativeTurnOptions = {
    remoteAgentId: string;
    remoteSessionId: string | null;
    spec: NativeAgentSpec;
    title: string;
    text: string;
    tools: NativeTool[];
    signal: AbortSignal;
    // Called once a new remote session exists, so it can be reused next turn.
    onSession: (remoteSessionId: string) => Promise<void>;
    // Asks the user to answer a browser approval; omitted → requests are cancelled.
    approve?: (req: ApprovalRequest) => Promise<ApprovalAnswer>;
};

export interface NativeBackend {
    readonly provider: NativeProvider;
    readonly label: string;
    models(): string[];
    createAgent(spec: NativeAgentSpec, tools: NativeTool[]): Promise<{ remoteId: string; version: number | null }>;
    updateAgent(remoteId: string, spec: NativeAgentSpec, tools: NativeTool[]): Promise<{ version: number | null }>;
    // Claude has no delete (archive is permanent and blocks new sessions); OpenAI deletes.
    removeAgent(remoteId: string): Promise<void>;
    removeSession(remoteSessionId: string): Promise<void>;
    runTurn(opts: NativeTurnOptions): AsyncGenerator<NativeTurnEvent>;
}

export function envList(name: string, fallback: string[]): string[] {
    const raw = process.env[name];
    const list = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    return list.length ? list : fallback;
}

export const short = (v: unknown, max = 4000): string => {
    const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
    return s.length > max ? `${s.slice(0, max)}…` : s;
};
