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


export const migrations: Migration[] = [

  migration_20260607120000,
  migration_20260626090000
];