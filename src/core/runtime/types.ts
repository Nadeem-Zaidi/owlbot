import { ChatRunOptions, ILLM } from "../../interfaces/illm";
import { LLMMessage } from "../../types/llm_message";

// Where a turn came from. Every surface (web app, WhatsApp, schedules, …)
// runs turns through the same AgentRuntime; the channel only changes small
// things such as whether a human is there to answer approval prompts.
export type RunChannel = "web" | "whatsapp" | "telegram" | "schedule" | "pipeline" | "api";

// One user turn to run in a session.
export type RunRequest = {
    channel: RunChannel;
    userId: string;
    sessionId: string;
    input: LLMMessage;
    // Model choice. `strictModel` (web) rejects an unknown provider/model with
    // a 400; otherwise (WhatsApp's saved choice) it falls back to the default.
    provider?: string | null;
    model?: string | null;
    strictModel?: boolean;
    // First message of a chat started from an agent's card: attach the chat
    // to that agent. Later turns use whatever the session is attached to.
    agentId?: string;
    nativeAgentId?: string;
};

// What a session's turn runs on, after resolving its agent and model.
export type RunTarget =
    | { kind: "chat"; llm: ILLM; model: string; run?: undefined }
    | { kind: "agent"; llm: ILLM; model: string; run: ChatRunOptions; agentId: string }
    | { kind: "native"; llm: ILLM; model: string; run?: undefined; agentId: string };

// The reply of a non-interactive turn (WhatsApp, schedules), collected from
// the stream.
export type CollectedReply = {
    text: string;
    sources: string[];
    error: string | null;
    cancelled: boolean;
    // Word/Excel files the assistant created in this turn.
    files?: { id: string; filename: string; kind: string; size: number }[];
};
