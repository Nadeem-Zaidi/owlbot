// Re-chunks and re-embeds every indexed document with the current chunker
// and embedding text. Run after changing chunking.ts or embedding.ts:
//   npm run kb:reindex                 (all documents)
//   npm run kb:reindex -- <key-prefix> (e.g. one user's folder "<uid>/")
// Safe to re-run: unchanged chunks keep their id, outdated ones are removed.
import "dotenv/config";
import { DatabaseManager } from "../src/database/databasemanager";
import { DatabaseType } from "../src/database/databasefactory";
import { PostgresqlVectorDb } from "../src/vector_db/postgresql_vector_db";
import { S3FileStore } from "../src/s3_client/s3_client";
import { Embedder } from "../src/database/vector_db/embedding";
import { KnowledgeBase } from "../src/service/knowledge_base";

(async () => {
    const prefix = process.argv[2] ?? "";
    if (!process.env.OPENAI_API_KEY) {
        console.error("OPENAI_API_KEY is required (embeddings).");
        process.exit(1);
    }
    const dbManager = DatabaseManager.getInstance();
    await dbManager.addConnection("pg", DatabaseType.PostgreSQL, {
        host: process.env.POSTGRES_HOST ?? "localhost",
        port: Number(process.env.POSTGRES_PORT ?? 5432),
        database: process.env.POSTGRES_DATABASE ?? "testerp",
        username: process.env.POSTGRES_USERNAME ?? "postgres",
        password: process.env.POSTGRES_PASSWORD ?? "",
    } as any);
    const db = dbManager.getConnection("pg");
    const vectorDb = new PostgresqlVectorDb(db, "doc_vecs");
    await db.withTransaction(async () => {
        await db.query("SELECT pg_advisory_xact_lock(727274002)");
        await vectorDb.initialize();
    });
    const s3 = new S3FileStore(process.env.S3_BUCKET || "nadeem-bucket-9891", {
        region: process.env.AWS_REGION!,
        accesskeyid: process.env.AWS_ACCESS_KEY_ID!,
        secretaccesskey: process.env.AWS_SECRET_ACCESS_KEY!,
    });
    const embedder = new Embedder(process.env.OPENAI_API_KEY, process.env.EMBEDDING_MODEL ?? "text-embedding-3-small", s3, vectorDb);
    const kb = new KnowledgeBase(s3, embedder, vectorDb);

    const docs = await vectorDb.listSourceFiles(prefix);
    console.log(`Re-indexing ${docs.length} document(s)…`);
    let failed = 0;
    for (const doc of docs) {
        const name = doc.source_file.split("/").pop();
        try {
            const r = await kb.reindexDocument(doc.source_file);
            console.log(r ? `  ✓ ${name}: ${r.before} → ${r.after} chunks (from ${r.from})` : `  – ${name}: nothing to index`);
        } catch (error) {
            failed++;
            console.error(`  ✗ ${name}:`, error instanceof Error ? error.message : error);
        }
    }
    await dbManager.closeAll();
    process.exit(failed ? 1 : 0);
})();
