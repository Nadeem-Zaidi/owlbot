import { Migration } from "../../types/type";


export const migration_20260607120000: Migration = {
  version: "20260607120000",
  description: "Create sessions and chat_messages tables",

  up: [
    `CREATE TABLE sessions (
      id         TEXT PRIMARY KEY,
      title      TEXT NOT NULL DEFAULT 'New Chat',
      model      TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE chat_messages (
      id          SERIAL PRIMARY KEY,
      session_id  TEXT NOT NULL,
      role        TEXT,
      type        TEXT,
      content     JSONB,
      metadata    JSONB,
      name        TEXT,
      arguments   JSONB,
      tool_call_id TEXT,
      output      JSONB,
      created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_session
        FOREIGN KEY (session_id)
        REFERENCES sessions(id)
        ON DELETE CASCADE
    )`,

    `CREATE INDEX idx_chat_messages_session_id ON chat_messages(session_id)`,
    `CREATE INDEX idx_chat_messages_role       ON chat_messages(role)`,
    `CREATE INDEX idx_chat_messages_type       ON chat_messages(type)`,
    `CREATE INDEX idx_chat_messages_created_at ON chat_messages(created_at)`,

    `CREATE INDEX idx_chat_messages_content  ON chat_messages USING GIN (content)`,
    `CREATE INDEX idx_chat_messages_metadata ON chat_messages USING GIN (metadata)`
  ],

  down: [
    `DROP TABLE IF EXISTS chat_messages CASCADE`,
    `DROP TABLE IF EXISTS sessions CASCADE`
  ]
};
export const migration_20260626090000: Migration = {
  version: "20260626090000",
  description: "Add userid column to sessions table",

  up: [
    // Add the column — nullable so existing rows are not broken
    `ALTER TABLE sessions ADD COLUMN userid TEXT`,
    `CREATE INDEX idx_sessions_userid ON sessions(userid)`
  ],

  down: [
    `DROP INDEX IF EXISTS idx_sessions_userid`,
    `ALTER TABLE sessions DROP COLUMN IF EXISTS userid`
  ]
};


export const migration_20261004120000: Migration = {
  version: "20261004120000",
  description: "Replace unused chat_messages indexes with ones matching real queries",

  // Every message query is "this session's messages in order" and the
  // sidebar is "this user's sessions, newest first". The GIN indexes on
  // content/metadata and the role/type indexes were never used by a query
  // but slowed down every insert.
  up: [
    `DROP INDEX IF EXISTS idx_chat_messages_content`,
    `DROP INDEX IF EXISTS idx_chat_messages_metadata`,
    `DROP INDEX IF EXISTS idx_chat_messages_role`,
    `DROP INDEX IF EXISTS idx_chat_messages_type`,
    `DROP INDEX IF EXISTS idx_chat_messages_session_id`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_session_order ON chat_messages(session_id, id)`,
    `DROP INDEX IF EXISTS idx_sessions_userid`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_userid_updated ON sessions(userid, updated_at DESC)`
  ],

  down: [
    `DROP INDEX IF EXISTS idx_sessions_userid_updated`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_userid ON sessions(userid)`,
    `DROP INDEX IF EXISTS idx_chat_messages_session_order`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_type ON chat_messages(type)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_role ON chat_messages(role)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_metadata ON chat_messages USING GIN (metadata)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_content ON chat_messages USING GIN (content)`
  ]
};


export const migration_20261004130000: Migration = {
  version: "20261004130000",
  description: "WhatsApp: linked numbers, one-time link codes, session source",

  up: [
    // One WhatsApp chat (jid) per web user. active_session_id is the chat
    // that new WhatsApp messages continue.
    `CREATE TABLE IF NOT EXISTS whatsapp_links (
      jid               TEXT PRIMARY KEY,
      user_id           TEXT NOT NULL UNIQUE,
      display_name      TEXT,
      active_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      provider          TEXT,
      model             TEXT,
      linked_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // Short-lived, single-use codes the web app hands out; sending one from
    // WhatsApp proves the number belongs to that user. session_id is set by
    // "Continue in WhatsApp" to pick up a specific web chat.
    `CREATE TABLE IF NOT EXISTS whatsapp_link_codes (
      code       TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at    TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_whatsapp_link_codes_user ON whatsapp_link_codes(user_id)`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'web'`
  ],

  down: [
    `ALTER TABLE sessions DROP COLUMN IF EXISTS source`,
    `DROP TABLE IF EXISTS whatsapp_link_codes`,
    `DROP TABLE IF EXISTS whatsapp_links`
  ]
};


export const migration_20261004140000: Migration = {
  version: "20261004140000",
  description: "Agents: agents, HTTP functions, MCP servers, schedules, runs",

  up: [
    // A user-defined assistant: instructions + model + tools + documents.
    `CREATE TABLE IF NOT EXISTS agents (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL,
      name          TEXT NOT NULL,
      icon          TEXT NOT NULL DEFAULT '🤖',
      description   TEXT NOT NULL DEFAULT '',
      instructions  TEXT NOT NULL DEFAULT '',
      provider      TEXT,
      model         TEXT,
      builtin_tools JSONB NOT NULL DEFAULT '[]',
      document_keys JSONB NOT NULL DEFAULT '[]',
      starters      JSONB NOT NULL DEFAULT '[]',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id, updated_at DESC)`,

    // HTTP functions the agent can call. Secret header values are encrypted.
    `CREATE TABLE IF NOT EXISTS agent_functions (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      method      TEXT NOT NULL DEFAULT 'GET',
      url         TEXT NOT NULL,
      parameters  JSONB NOT NULL DEFAULT '[]',
      headers     JSONB NOT NULL DEFAULT '[]',
      enabled     BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (agent_id, name)
    )`,

    // Remote MCP servers; `tools` caches the discovered tool list + on/off.
    `CREATE TABLE IF NOT EXISTS agent_mcp_servers (
      id         TEXT PRIMARY KEY,
      agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      url        TEXT NOT NULL,
      auth_token TEXT,
      tools      JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,

    // Recurring tasks: run `prompt` through the agent on a timetable.
    `CREATE TABLE IF NOT EXISTS agent_schedules (
      id               TEXT PRIMARY KEY,
      agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      user_id          TEXT NOT NULL,
      name             TEXT NOT NULL,
      prompt           TEXT NOT NULL,
      frequency        TEXT NOT NULL,
      interval_hours   INTEGER,
      time_of_day      TEXT,
      weekday          INTEGER,
      timezone         TEXT NOT NULL DEFAULT 'UTC',
      deliver_whatsapp BOOLEAN NOT NULL DEFAULT false,
      enabled          BOOLEAN NOT NULL DEFAULT true,
      session_id       TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      next_run_at      TIMESTAMPTZ,
      last_run_at      TIMESTAMPTZ,
      last_status      TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_schedules_due ON agent_schedules(next_run_at) WHERE enabled`,

    // One row per scheduled (or "run now") execution.
    `CREATE TABLE IF NOT EXISTS agent_runs (
      id          SERIAL PRIMARY KEY,
      schedule_id TEXT REFERENCES agent_schedules(id) ON DELETE CASCADE,
      agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      session_id  TEXT,
      status      TEXT NOT NULL,
      output      TEXT,
      error       TEXT,
      started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_agent_runs_agent ON agent_runs(agent_id, started_at DESC)`,

    // Which agent a chat belongs to (null = plain chat).
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL`,
  ],

  down: [
    `ALTER TABLE sessions DROP COLUMN IF EXISTS agent_id`,
    `DROP TABLE IF EXISTS agent_runs`,
    `DROP TABLE IF EXISTS agent_schedules`,
    `DROP TABLE IF EXISTS agent_mcp_servers`,
    `DROP TABLE IF EXISTS agent_functions`,
    `DROP TABLE IF EXISTS agents`,
  ]
};


export const migration_20261004150000: Migration = {
  version: "20261004150000",
  description: "Agents: instruction files (.md) attached to an agent",

  up: [
    // [{ name, content, enabled }] — appended to the agent's instructions.
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS instruction_files JSONB NOT NULL DEFAULT '[]'`
  ],

  down: [
    `ALTER TABLE agents DROP COLUMN IF EXISTS instruction_files`
  ]
};


export const migration_20261004160000: Migration = {
  version: "20261004160000",
  description: "Agent code functions (Python) and agent pipelines",

  up: [
    // Owner-written Python functions an agent can call (run by the Python gRPC service).
    `CREATE TABLE IF NOT EXISTS agent_code_functions (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      code        TEXT NOT NULL,
      parameters  JSONB NOT NULL DEFAULT '[]',
      secrets     JSONB NOT NULL DEFAULT '[]',
      timeout_ms  INTEGER NOT NULL DEFAULT 15000,
      enabled     BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (agent_id, name)
    )`,

    // A chain of agents: each step's output becomes the next step's input.
    `CREATE TABLE IF NOT EXISTS pipelines (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      steps       JSONB NOT NULL DEFAULT '[]',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pipelines_user ON pipelines(user_id, updated_at DESC)`,

    // One execution of a pipeline, with every step's output.
    `CREATE TABLE IF NOT EXISTS pipeline_runs (
      id          SERIAL PRIMARY KEY,
      pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
      user_id     TEXT NOT NULL,
      status      TEXT NOT NULL,
      input       TEXT NOT NULL DEFAULT '',
      steps       JSONB NOT NULL DEFAULT '[]',
      output      TEXT,
      error       TEXT,
      started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline ON pipeline_runs(pipeline_id, started_at DESC)`,
  ],

  down: [
    `DROP TABLE IF EXISTS pipeline_runs`,
    `DROP TABLE IF EXISTS pipelines`,
    `DROP TABLE IF EXISTS agent_code_functions`,
  ]
};


export const migration_20261004170000: Migration = {
  version: "20261004170000",
  description: "Token usage per chat turn, title and agent draft",

  up: [
    // One row per chat turn (all model calls in it, summed), per title
    // generation, and per agent draft. `source` and `agent_id` are copied from
    // the session at the time so reports survive the chat being deleted.
    `CREATE TABLE IF NOT EXISTS token_usage (
      id                 SERIAL PRIMARY KEY,
      user_id            TEXT NOT NULL,
      session_id         TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      agent_id           TEXT,
      source             TEXT,
      kind               TEXT NOT NULL DEFAULT 'chat',
      provider           TEXT,
      model              TEXT,
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      requests           INTEGER NOT NULL DEFAULT 1,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_token_usage_user_time ON token_usage(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_token_usage_session ON token_usage(session_id)`,
  ],

  down: [
  `DROP TABLE IF EXISTS token_usage`
  ]
};


// Provider-native agents: agents created in Claude Managed Agents or the
// OpenAI Agents API. The provider stores the agent; we keep a copy of its
// settings, the remote id, and which provider each user has switched on.
export const migration_20261005100000: Migration = {
  version: "20261005100000",
  description: "Provider-native agents (Claude Managed Agents, OpenAI Agents API)",
  up: [
    `CREATE TABLE IF NOT EXISTS native_agents (
      id               TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      provider         TEXT NOT NULL CHECK (provider IN ('anthropic', 'openai')),
      remote_agent_id  TEXT,
      remote_version   INTEGER,
      name             TEXT NOT NULL,
      icon             TEXT NOT NULL DEFAULT '🤖',
      description      TEXT NOT NULL DEFAULT '',
      instructions     TEXT NOT NULL DEFAULT '',
      model            TEXT NOT NULL,
      web_search       BOOLEAN NOT NULL DEFAULT false,
      code_sandbox     BOOLEAN NOT NULL DEFAULT false,
      knowledge_base   BOOLEAN NOT NULL DEFAULT false,
      mcp_servers      JSONB NOT NULL DEFAULT '[]',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_native_agents_user ON native_agents(user_id, provider)`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS native_agent_id TEXT REFERENCES native_agents(id) ON DELETE SET NULL`,
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS remote_session_id TEXT`,
    `CREATE TABLE IF NOT EXISTS user_settings (
      user_id          TEXT PRIMARY KEY,
      native_provider  TEXT CHECK (native_provider IN ('anthropic', 'openai')),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS native_provider_state (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    )`,
  ],

  down: [
    `DROP TABLE IF EXISTS native_provider_state`,
    `DROP TABLE IF EXISTS user_settings`,
    `ALTER TABLE sessions DROP COLUMN IF EXISTS remote_session_id`,
    `ALTER TABLE sessions DROP COLUMN IF EXISTS native_agent_id`,
    `DROP TABLE IF EXISTS native_agents`,
  ]
};


export const migration_20261005110000: Migration = {
  version: "20261005110000",
  description: "Provider agents: HTTP functions and code functions",
  up: [
    // Same shape as agent_functions / agent_code_functions, so the same row
    // types, runners and editor work for provider agents.
    `CREATE TABLE IF NOT EXISTS native_agent_functions (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL REFERENCES native_agents(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      method      TEXT NOT NULL DEFAULT 'GET',
      url         TEXT NOT NULL,
      parameters  JSONB NOT NULL DEFAULT '[]',
      headers     JSONB NOT NULL DEFAULT '[]',
      enabled     BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (agent_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS native_agent_code_functions (
      id          TEXT PRIMARY KEY,
      agent_id    TEXT NOT NULL REFERENCES native_agents(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      code        TEXT NOT NULL,
      parameters  JSONB NOT NULL DEFAULT '[]',
      secrets     JSONB NOT NULL DEFAULT '[]',
      timeout_ms  INTEGER NOT NULL DEFAULT 15000,
      enabled     BOOLEAN NOT NULL DEFAULT true,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (agent_id, name)
    )`,
  ],

  down: [
    `DROP TABLE IF EXISTS native_agent_code_functions`,
    `DROP TABLE IF EXISTS native_agent_functions`,
  ]
};


export const migration_20261005120000: Migration = {
  version: "20261005120000",
  description: "WhatsApp away message (self-chat mode)",
  up: [
    // One row: the away message for the bot's WhatsApp number (self-chat mode).
    `CREATE TABLE IF NOT EXISTS whatsapp_away (
      id               INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled          BOOLEAN NOT NULL DEFAULT false,
      message          TEXT NOT NULL DEFAULT '',
      cooldown_minutes INTEGER NOT NULL DEFAULT 720,
      until            TIMESTAMPTZ,
      updated_by       TEXT,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // When each person last got the away message, so they get it once per
    // cooldown even across restarts.
    `CREATE TABLE IF NOT EXISTS whatsapp_away_replies (
      jid         TEXT PRIMARY KEY,
      name        TEXT,
      replied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      reply_count INTEGER NOT NULL DEFAULT 1
    )`,
  ],

  down: [
    `DROP TABLE IF EXISTS whatsapp_away_replies`,
    `DROP TABLE IF EXISTS whatsapp_away`,
  ]
};


export const migration_20261005130000: Migration = {
  version: "20261005130000",
  description: "Provider agents: browser (OpenAI computer use)",
  up: [
    `ALTER TABLE native_agents ADD COLUMN IF NOT EXISTS browser BOOLEAN NOT NULL DEFAULT false`
  ],

  down: [
    `ALTER TABLE native_agents DROP COLUMN IF EXISTS browser`
  ]
};


export const migration_20261005140000: Migration = {
  version: "20261005140000",
  description: "Billing: Razorpay subscriptions, payments, webhook events",
  up: [
    // One row per user who has opened billing (email kept for exemptions/receipts).
    `CREATE TABLE IF NOT EXISTS billing_accounts (
      user_id     TEXT PRIMARY KEY,
      email       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // One row per Razorpay subscription; the newest entitled one sets the plan.
    `CREATE TABLE IF NOT EXISTS billing_subscriptions (
      id                    TEXT PRIMARY KEY,
      user_id               TEXT NOT NULL,
      plan                  TEXT NOT NULL,
      period                TEXT NOT NULL CHECK (period IN ('monthly', 'yearly')),
      razorpay_plan_id      TEXT NOT NULL,
      status                TEXT NOT NULL,
      current_start         TIMESTAMPTZ,
      current_end           TIMESTAMPTZ,
      cancel_at_cycle_end   BOOLEAN NOT NULL DEFAULT false,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_user ON billing_subscriptions(user_id, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS billing_payments (
      payment_id       TEXT PRIMARY KEY,
      user_id          TEXT NOT NULL,
      subscription_id  TEXT,
      plan             TEXT,
      amount           INTEGER NOT NULL DEFAULT 0,
      currency         TEXT NOT NULL DEFAULT 'INR',
      status           TEXT NOT NULL,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_billing_payments_user ON billing_payments(user_id, created_at DESC)`,
    // Razorpay webhook event ids already handled (webhooks can arrive twice).
    `CREATE TABLE IF NOT EXISTS billing_events (
      event_id     TEXT PRIMARY KEY,
      type         TEXT NOT NULL,
      received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  ],

  down: [
    `DROP TABLE IF EXISTS billing_events`,
    `DROP TABLE IF EXISTS billing_payments`,
    `DROP TABLE IF EXISTS billing_subscriptions`,
    `DROP TABLE IF EXISTS billing_accounts`,
  ]
};


export const migration_20261005150000: Migration = {
  version: "20261005150000",
  description: "Performance indexes: HNSW vectors, trigram chat search, agent FKs",
  up: [
    // Agent deletion sets these to NULL on their chats; without an index that's
    // a full scan of sessions per delete.
    `CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id) WHERE agent_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_native_agent ON sessions(native_agent_id) WHERE native_agent_id IS NOT NULL`,

    // Document search: HNSW keeps good recall as documents grow (IVFFlat built
    // on an empty table doesn't). The table is created at startup, so only
    // touch it if it exists.
    `DO $$ BEGIN
       IF to_regclass('public.doc_vecs') IS NOT NULL THEN
         DROP INDEX IF EXISTS doc_vecs_embedding_idx;
         CREATE INDEX IF NOT EXISTS doc_vecs_embedding_hnsw ON doc_vecs USING hnsw (embedding vector_cosine_ops);
       END IF;
     END $$`,

    // Chat search ("contains" text): trigram indexes. Skipped quietly where the
    // database doesn't allow the pg_trgm extension.
    `DO $$ BEGIN
       CREATE EXTENSION IF NOT EXISTS pg_trgm;
     EXCEPTION WHEN insufficient_privilege OR feature_not_supported OR undefined_file THEN
       RAISE NOTICE 'pg_trgm not available; chat search runs without trigram indexes';
     END $$`,
    `DO $$ BEGIN
       IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
         CREATE INDEX IF NOT EXISTS idx_chat_messages_content_trgm ON chat_messages USING gin ((content::text) gin_trgm_ops);
         CREATE INDEX IF NOT EXISTS idx_sessions_title_trgm ON sessions USING gin (title gin_trgm_ops);
       END IF;
     END $$`,
  ],

  down: [
    `DROP INDEX IF EXISTS idx_sessions_title_trgm`,
    `DROP INDEX IF EXISTS idx_chat_messages_content_trgm`,
    `DROP INDEX IF EXISTS doc_vecs_embedding_hnsw`,
    `DROP INDEX IF EXISTS idx_sessions_native_agent`,
    `DROP INDEX IF EXISTS idx_sessions_agent`,
  ]
};


export const migration_20261007100000: Migration = {
  version: "20261007100000",
  description: "BYOK: users' own model API keys; usage flagged as BYOK; app settings (WhatsApp)",
  up: [
    // A user's own provider key. The key itself is AES-256-GCM encrypted
    // (service/agents/secrets.ts); only its last characters are ever shown.
    `CREATE TABLE IF NOT EXISTS user_llm_keys (
       id UUID PRIMARY KEY,
       user_id TEXT NOT NULL,
       kind TEXT NOT NULL CHECK (kind IN ('openai', 'anthropic', 'openai_compatible')),
       label TEXT NOT NULL,
       base_url TEXT,
       api_key_enc TEXT NOT NULL,
       key_hint TEXT NOT NULL,
       models JSONB NOT NULL DEFAULT '[]'::jsonb,
       default_model TEXT,
       enabled BOOLEAN NOT NULL DEFAULT true,
       last_verified_at TIMESTAMPTZ,
       last_error TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       UNIQUE (user_id, label)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_user_llm_keys_user ON user_llm_keys(user_id)`,
    // Usage on a user's own key is recorded (and shown) but never counts
    // toward the plan's monthly token quota.
    `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS byok BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS key_id UUID`,
    // Server-wide settings editable in the web app (owner only).
    `CREATE TABLE IF NOT EXISTS app_settings (
       key TEXT PRIMARY KEY,
       value JSONB NOT NULL,
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_by TEXT
     )`,
  ],
  down: [
    `DROP TABLE IF EXISTS app_settings`,
    `ALTER TABLE token_usage DROP COLUMN IF EXISTS key_id`,
    `ALTER TABLE token_usage DROP COLUMN IF EXISTS byok`,
    `DROP TABLE IF EXISTS user_llm_keys`,
  ]
};


export const migration_20261008100000: Migration = {
  version: "20261008100000",
  description: "Artifacts: documents/reports the assistant creates in chat, with versions",
  up: [
    `CREATE TABLE IF NOT EXISTS artifacts (
       id UUID PRIMARY KEY,
       user_id TEXT NOT NULL,
       session_id UUID,
       title TEXT NOT NULL,
       kind TEXT NOT NULL CHECK (kind IN ('html', 'markdown')),
       current_version INTEGER NOT NULL DEFAULT 1,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
    `CREATE INDEX IF NOT EXISTS idx_artifacts_user ON artifacts(user_id, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id) WHERE session_id IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS artifact_versions (
       artifact_id UUID NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
       version INTEGER NOT NULL,
       title TEXT NOT NULL,
       content TEXT NOT NULL,
       change_summary TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       PRIMARY KEY (artifact_id, version)
     )`,
  ],
  down: [
    `DROP TABLE IF EXISTS artifact_versions`,
    `DROP TABLE IF EXISTS artifacts`,
  ]
};


export const migration_20261009100000: Migration = {
  version: "20261009100000",
  description: "Pinned (favourite) chats",
  up: [
    `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_pinned ON sessions(userid, pinned_at DESC) WHERE pinned_at IS NOT NULL`,
  ],
  down: [
    `DROP INDEX IF EXISTS idx_sessions_pinned`,
    `ALTER TABLE sessions DROP COLUMN IF EXISTS pinned_at`,
  ]
};


export const migration_20261010100000: Migration = {
  version: "20261010100000",
  description: "Context engine: running summary of each long chat",
  up: [
    // One row per session: a summary of its stored messages [0, upto_index).
    `CREATE TABLE IF NOT EXISTS session_summaries (
      session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      summary     TEXT NOT NULL,
      upto_index  INTEGER NOT NULL CHECK (upto_index >= 0),
      model       TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  ],
  down: [
    `DROP TABLE IF EXISTS session_summaries`,
  ]
};


export const migration_20261011100000: Migration = {
  version: "20261011100000",
  description: "Long-term memory: facts the assistant remembers about each user",
  up: [
    `CREATE TABLE IF NOT EXISTS user_memories (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      content     TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 500),
      -- active: recalled in every chat; proposed: waiting for the user's OK ("Ask me first")
      status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'proposed')),
      -- chat: saved by the assistant; user: typed on the Memory page
      source      TEXT NOT NULL DEFAULT 'chat' CHECK (source IN ('chat', 'user')),
      session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_user_memories_user ON user_memories(user_id, status, updated_at DESC)`,
    `CREATE TABLE IF NOT EXISTS user_memory_settings (
      user_id     TEXT PRIMARY KEY,
      mode        TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto', 'review', 'off')),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  ],
  down: [
    `DROP TABLE IF EXISTS user_memory_settings`,
    `DROP TABLE IF EXISTS user_memories`,
  ]
};


export const migration_20261012100000: Migration = {
  version: "20261012100000",
  description: "Chat channels (Telegram, …): linked chats and one-time link codes",
  up: [
    // A chat on a messaging app linked to a web account (WhatsApp keeps its own tables).
    `CREATE TABLE IF NOT EXISTS channel_links (
      channel            TEXT NOT NULL,
      chat_id            TEXT NOT NULL,
      user_id            TEXT NOT NULL,
      display_name       TEXT,
      active_session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      provider           TEXT,
      model              TEXT,
      linked_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (channel, chat_id),
      UNIQUE (channel, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS channel_link_codes (
      code        TEXT PRIMARY KEY,
      channel     TEXT NOT NULL,
      user_id     TEXT NOT NULL,
      session_id  TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_channel_link_codes_user ON channel_link_codes(channel, user_id)`,
  ],
  down: [
    `DROP TABLE IF EXISTS channel_link_codes`,
    `DROP TABLE IF EXISTS channel_links`,
  ]
};


export const migration_20261013100000: Migration = {
  version: "20261013100000",
  description: "Skills (reusable instruction packs) and workflow flows (branches, conditions, approvals)",
  up: [
    // A user's skill library. Only name + description go into each request;
    // the content is loaded on demand (load_skill tool).
    `CREATE TABLE IF NOT EXISTS skills (
      id           TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      name         TEXT NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
      description  TEXT NOT NULL,
      content      TEXT NOT NULL,
      enabled      BOOLEAN NOT NULL DEFAULT true,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (user_id, name)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_skills_user ON skills(user_id, updated_at DESC)`,
    // Which skills an agent may use: all of the owner's, a chosen list, or none.
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS skill_mode TEXT NOT NULL DEFAULT 'all' CHECK (skill_mode IN ('all', 'selected', 'none'))`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS skill_ids JSONB NOT NULL DEFAULT '[]'`,
    // Workflows: a graph of nodes (pipelines without it are linear "steps").
    `ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS flow JSONB`,
    // Where a paused run (waiting for approval) continues from.
    `ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS state JSONB`,
    `CREATE INDEX IF NOT EXISTS idx_pipeline_runs_waiting ON pipeline_runs(user_id) WHERE status = 'waiting'`,
  ],
  down: [
    `DROP INDEX IF EXISTS idx_pipeline_runs_waiting`,
    `ALTER TABLE pipeline_runs DROP COLUMN IF EXISTS state`,
    `ALTER TABLE pipelines DROP COLUMN IF EXISTS flow`,
    `ALTER TABLE agents DROP COLUMN IF EXISTS skill_ids`,
    `ALTER TABLE agents DROP COLUMN IF EXISTS skill_mode`,
    `DROP TABLE IF EXISTS skills`,
  ]
};


export const migration_20261014100000: Migration = {
  version: "20261014100000",
  description: "Generated Word/Excel files and each user's document style",
  up: [
    // Files the assistant created (create_word_document / create_excel_file),
    // stored in S3 under generated/<user>/… (outside the knowledge base).
    `CREATE TABLE IF NOT EXISTS generated_files (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      kind        TEXT NOT NULL CHECK (kind IN ('word', 'excel')),
      filename    TEXT NOT NULL,
      mime        TEXT NOT NULL,
      s3_key      TEXT NOT NULL,
      size        INTEGER NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_generated_files_user ON generated_files(user_id, created_at DESC)`,
    // Branding applied to every generated document.
    `CREATE TABLE IF NOT EXISTS document_styles (
      user_id     TEXT PRIMARY KEY,
      company     TEXT NOT NULL DEFAULT '',
      color       TEXT NOT NULL DEFAULT '#2A74A8',
      font        TEXT NOT NULL DEFAULT 'Calibri',
      footer      TEXT NOT NULL DEFAULT '',
      currency    TEXT NOT NULL DEFAULT '₹',
      logo        BYTEA,
      logo_mime   TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  ],
  down: [
    `DROP TABLE IF EXISTS document_styles`,
    `DROP TABLE IF EXISTS generated_files`,
  ]
};


export const migration_20261015100000: Migration = {
  version: "20261015100000",
  description: "Model marketplace: prepaid credits, ledger, credit orders, developer API keys, favourite models",
  up: [
    // Prepaid balance per user, in nano-dollars (1 USD = 1e9) so per-token prices stay exact.
    `CREATE TABLE IF NOT EXISTS market_wallets (
      user_id        TEXT PRIMARY KEY,
      balance_nanos  BIGINT NOT NULL DEFAULT 0,
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // Every change to a balance: purchases (+), usage (-), refunds and admin adjustments.
    `CREATE TABLE IF NOT EXISTS market_ledger (
      id                  BIGSERIAL PRIMARY KEY,
      user_id             TEXT NOT NULL,
      kind                TEXT NOT NULL CHECK (kind IN ('purchase', 'usage', 'refund', 'adjustment')),
      amount_nanos        BIGINT NOT NULL,
      balance_after_nanos BIGINT NOT NULL,
      upstream_nanos      BIGINT NOT NULL DEFAULT 0,
      fee_paise           BIGINT NOT NULL DEFAULT 0,
      paid_paise          BIGINT NOT NULL DEFAULT 0,
      model               TEXT,
      source              TEXT,
      api_key_id          UUID,
      session_id          TEXT,
      generation_id       TEXT,
      payment_id          TEXT,
      input_tokens        BIGINT NOT NULL DEFAULT 0,
      output_tokens       BIGINT NOT NULL DEFAULT 0,
      note                TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_market_ledger_user ON market_ledger(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_market_ledger_time ON market_ledger(created_at)`,
    // A payment can only ever be credited once.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_market_ledger_payment ON market_ledger(payment_id) WHERE payment_id IS NOT NULL`,
    // Razorpay orders for credit top-ups.
    `CREATE TABLE IF NOT EXISTS market_orders (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL,
      credits_nanos  BIGINT NOT NULL,
      amount_paise   BIGINT NOT NULL,
      fee_paise      BIGINT NOT NULL,
      usd_inr        NUMERIC(10, 4) NOT NULL,
      status         TEXT NOT NULL DEFAULT 'created',
      payment_id     TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at        TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_market_orders_user ON market_orders(user_id, created_at DESC)`,
    // Developer API keys (sk-owl-…). Only a SHA-256 of the key is stored.
    `CREATE TABLE IF NOT EXISTS market_api_keys (
      id            UUID PRIMARY KEY,
      user_id       TEXT NOT NULL,
      name          TEXT NOT NULL,
      key_hash      TEXT NOT NULL UNIQUE,
      key_prefix    TEXT NOT NULL,
      key_last4     TEXT NOT NULL,
      limit_nanos   BIGINT,
      usage_nanos   BIGINT NOT NULL DEFAULT 0,
      disabled      BOOLEAN NOT NULL DEFAULT false,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at  TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_market_api_keys_user ON market_api_keys(user_id, created_at DESC)`,
    // Models a user added to their chat model picker.
    `CREATE TABLE IF NOT EXISTS market_favorites (
      user_id     TEXT NOT NULL,
      model_id    TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, model_id)
    )`,
  ],
  down: [
    `DROP TABLE IF EXISTS market_favorites`,
    `DROP TABLE IF EXISTS market_api_keys`,
    `DROP TABLE IF EXISTS market_orders`,
    `DROP TABLE IF EXISTS market_ledger`,
    `DROP TABLE IF EXISTS market_wallets`,
  ]
};


export const migration_20261016100000: Migration = {
  version: "20261016100000",
  description: "Marketplace phase 1: own provider accounts, own model catalogue and offers (model × provider × price)",
  up: [
    // The owner's upstream accounts (OpenAI, Anthropic, DeepInfra, Groq, …). Keys are encrypted.
    `CREATE TABLE IF NOT EXISTS market_providers (
      id          UUID PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      kind        TEXT NOT NULL CHECK (kind IN ('openai_compatible', 'anthropic', 'openrouter')),
      base_url    TEXT NOT NULL,
      api_key_enc TEXT NOT NULL,
      key_hint    TEXT NOT NULL,
      region      TEXT,
      priority    INTEGER NOT NULL DEFAULT 100,
      enabled     BOOLEAN NOT NULL DEFAULT true,
      notes       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // The models the owner sells.
    `CREATE TABLE IF NOT EXISTS market_models (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      author            TEXT NOT NULL,
      description       TEXT NOT NULL DEFAULT '',
      context_length    INTEGER,
      max_output        INTEGER,
      input_modalities  TEXT[] NOT NULL DEFAULT '{text}',
      tools             BOOLEAN NOT NULL DEFAULT false,
      reasoning         BOOLEAN NOT NULL DEFAULT false,
      structured_output BOOLEAN NOT NULL DEFAULT false,
      released          DATE,
      hugging_face_id   TEXT,
      featured          BOOLEAN NOT NULL DEFAULT false,
      india_hosted      BOOLEAN NOT NULL DEFAULT false,
      enabled           BOOLEAN NOT NULL DEFAULT true,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // Which provider serves which model, under what name, at what upstream price (USD per 1M tokens).
    `CREATE TABLE IF NOT EXISTS market_offers (
      id              UUID PRIMARY KEY,
      model_id        TEXT NOT NULL REFERENCES market_models(id) ON DELETE CASCADE,
      provider_id     UUID NOT NULL REFERENCES market_providers(id) ON DELETE CASCADE,
      upstream_model  TEXT NOT NULL,
      input_per_m     NUMERIC(14, 6) NOT NULL DEFAULT 0,
      output_per_m    NUMERIC(14, 6) NOT NULL DEFAULT 0,
      cache_read_per_m NUMERIC(14, 6),
      request_price   NUMERIC(14, 8) NOT NULL DEFAULT 0,
      markup_pct      NUMERIC(6, 2),
      context_length  INTEGER,
      max_output      INTEGER,
      quantization    TEXT,
      priority        INTEGER NOT NULL DEFAULT 100,
      enabled         BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (model_id, provider_id, upstream_model)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_market_offers_model ON market_offers(model_id)`,
    // Which provider served each charged request (cost and margin per provider).
    `ALTER TABLE market_ledger ADD COLUMN IF NOT EXISTS provider TEXT`,
  ],
  down: [
    `ALTER TABLE market_ledger DROP COLUMN IF EXISTS provider`,
    `DROP TABLE IF EXISTS market_offers`,
    `DROP TABLE IF EXISTS market_models`,
    `DROP TABLE IF EXISTS market_providers`,
  ]
};


export const migration_20261017100000: Migration = {
  version: "20261017100000",
  description: "Marketplace phase 2: hourly provider health stats (requests, errors, latency) shared by every server",
  up: [
    `CREATE TABLE IF NOT EXISTS market_provider_stats (
      provider_id     TEXT NOT NULL,
      model_id        TEXT NOT NULL,
      hour            TIMESTAMPTZ NOT NULL,
      requests        INTEGER NOT NULL DEFAULT 0,
      errors          INTEGER NOT NULL DEFAULT 0,
      latency_ms_sum  BIGINT NOT NULL DEFAULT 0,
      latency_count   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (provider_id, model_id, hour)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_market_provider_stats_hour ON market_provider_stats(hour)`,
  ],
  down: [
    `DROP TABLE IF EXISTS market_provider_stats`,
  ]
};


export const migration_20261018100000: Migration = {
  version: "20261018100000",
  description: "Marketplace phase 3: models discovered from providers (for approval), provider sync status and monthly budgets",
  up: [
    // Model names each provider lists, found by the nightly sync — the owner adds or ignores them.
    `CREATE TABLE IF NOT EXISTS market_discovered (
      provider_id     UUID NOT NULL REFERENCES market_providers(id) ON DELETE CASCADE,
      upstream_model  TEXT NOT NULL,
      input_per_m     NUMERIC(14, 6),
      output_per_m    NUMERIC(14, 6),
      context_length  INTEGER,
      status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'ignored', 'added')),
      first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen       TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (provider_id, upstream_model)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_market_discovered_status ON market_discovered(status)`,
    `ALTER TABLE market_providers ADD COLUMN IF NOT EXISTS budget_usd NUMERIC(12, 2)`,
    `ALTER TABLE market_providers ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ`,
    `ALTER TABLE market_providers ADD COLUMN IF NOT EXISTS sync_error TEXT`,
  ],
  down: [
    `ALTER TABLE market_providers DROP COLUMN IF EXISTS sync_error`,
    `ALTER TABLE market_providers DROP COLUMN IF EXISTS last_synced_at`,
    `ALTER TABLE market_providers DROP COLUMN IF EXISTS budget_usd`,
    `DROP TABLE IF EXISTS market_discovered`,
  ]
};


export const migrations: Migration[] = [

  migration_20260607120000,
  migration_20260626090000,
  migration_20261004120000,
  migration_20261004130000,
  migration_20261004140000,
  migration_20261004150000,
  migration_20261004160000,
  migration_20261004170000,
  migration_20261005100000,
  migration_20261005110000,
  migration_20261005120000,
  migration_20261005130000,
  migration_20261005140000,
  migration_20261005150000,
  migration_20261007100000,
  migration_20261008100000,
  migration_20261009100000,
  migration_20261010100000,
  migration_20261011100000,
  migration_20261012100000,
  migration_20261013100000,
  migration_20261014100000,
  migration_20261015100000,
  migration_20261016100000,
  migration_20261017100000,
  migration_20261018100000
];