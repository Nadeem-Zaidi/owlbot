-- pgvector/pgvector image ships the extension but doesn't enable it by
-- default. The app also defensively runs this same statement on startup
-- (see src/vector_db/postgresql_vector_db.ts), so this is here only to make
-- sure the extension exists before anything else in this file (if you add
-- more init SQL later) can rely on the `vector` type.
CREATE EXTENSION IF NOT EXISTS vector;
