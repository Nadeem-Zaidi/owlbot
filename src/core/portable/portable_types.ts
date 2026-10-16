// The Owl Bot export file: agents and Agent Studio projects as plain JSON,
// portable between accounts and servers. Nothing in it is tied to one
// database — agents are referenced by `ref`, documents and skills by name —
// and it never contains secrets (tokens and secret header values are left
// out; the importer types them in).

export const EXPORT_FORMAT = "owlbot-export";
export const EXPORT_VERSION = 1;

export type PortableFunction = {
    name: string;
    description: string;
    method: string;
    url: string;
    parameters: unknown[];
    // Secret headers have value null: the importer supplies them.
    headers: { key: string; value: string | null; secret: boolean }[];
    enabled: boolean;
};

export type PortableAgent = {
    ref: string;                                   // unique in the file; projects point at it
    name: string;
    icon: string;
    description: string;
    instructions: string;
    starters: string[];
    instruction_files: { name: string; content: string; enabled: boolean }[];
    model: { provider: string; model: string | null } | null;
    builtin_tools: string[];
    documents: string[];                           // knowledge documents, by name
    // "all" = all of the importer's skills; "selected" = these (created if missing).
    skills: { mode: "all" | "selected" | "none"; items: { name: string; description: string; content: string }[] };
    functions: PortableFunction[];
    mcp_servers: { name: string; url: string; enabled_tools: string[]; needs_token: boolean }[];
    // Other agents it can ask, by name (matched on import to agents in the
    // file or the importer's own agents).
    helpers?: string[];
    not_exported?: string[];                       // e.g. "2 Python code functions"
};

// A Studio canvas with agents by `agent_ref`, knowledge by document name
// and skills by skill name.
export type PortableProject = {
    name: string;
    description: string;
    deliver_result: boolean;
    nodes: Record<string, unknown>[];
    edges: Record<string, unknown>[];
};

export type PortableFile = {
    format: typeof EXPORT_FORMAT;
    version: number;
    exported_at: string;
    agents: PortableAgent[];
    projects: PortableProject[];
};

// What the importer chooses per agent in the preview.
export type AgentChoice = {
    mode: "create" | "existing";
    existing_id?: string;
    mcp_tokens?: Record<string, string>;           // server name → token
    skip_mcp?: string[];                           // server names not to connect
    secrets?: Record<string, string>;              // "function:Header" → value
};
export type ImportChoices = { agents?: Record<string, AgentChoice> };
