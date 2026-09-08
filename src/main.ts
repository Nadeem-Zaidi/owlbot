import "dotenv/config";   // ← add this at the very top
import { WhatsAppChannel } from "./channels/whatsapp_channel";
import { VGateway } from "./gateway/vanilla_gateway";
import { ToolRegistry } from "./tools/tool";
import { DatabaseManager } from "./database/databasemanager";
import { DatabaseType } from "./database/databasefactory";
import { MigrationManager } from "./database/migration_manager.ts/migration_manager";
import { migrations } from "./database/migration_manager.ts/migration";
import { S3Config } from "./types/type";
import dotenv from "dotenv";
import { S3Reader } from "./file_reader/s3_reader";
import { PostgresqlVectorDb } from "./vector_db/postgresql_vector_db"; // adjust to wherever you actually saved this file
import { Embedder } from "./database/vector_db/embedding";
import { ChatMessages } from "./routes/session_routes";
import { MessageService } from "./service/message_service";
import { LLMFactory } from "./llms/llm_factory";
import { SessionRepository } from "./repository/sessiopn_repository";
import { MessageRepository } from "./repository/message_repository";
import { StorageRoutes } from "./routes/storage_routes";
import { S3FileStore } from "./s3_client/s3_client";
import { LLMTool } from "./tools/tool_registry";
import { createVectorSearchTool, EmbedderAdapter } from "./tools/vector_tool";
dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const EMBEDDING_MODEL = "text-embedding-3-small";

async function wa() {
    const port = Number(process.env.PORT ?? 3000);
    const dbManager = DatabaseManager.getInstance();
    await dbManager.addConnection('pg', DatabaseType.PostgreSQL, {
        host: process.env.POSTGRES_HOST ?? 'localhost',
        port: Number(process.env.POSTGRES_PORT ?? 5432),
        database: process.env.POSTGRES_DATABASE ?? 'testerp',
        username: process.env.POSTGRES_USERNAME ?? 'postgres',
        password: process.env.POSTGRES_PASSWORD ?? '',
    });
    const db = dbManager.getConnection('pg');
    const migrationManager = new MigrationManager(db);
    await migrationManager.migrateUp(migrations);

    // Vector storage now lives in the same Postgres database as everything
    // else (via pgvector), reusing the connection above instead of a
    // separate Qdrant instance. initialize() creates the extension/table/
    // index if they don't exist yet — safe to call every startup.
    const vectorDb = new PostgresqlVectorDb(db, "doc_vecs");
    await vectorDb.initialize();

    const s3Config: S3Config = { region: process.env.AWS_REGION!, accesskeyid: process.env.AWS_ACCESS_KEY_ID!, secretaccesskey: process.env.AWS_SECRET_ACCESS_KEY! };
    const s3Client = new S3FileStore("nadeem-bucket-9891", s3Config);
    const embedder = new Embedder(OPENAI_API_KEY, EMBEDDING_MODEL, s3Client, vectorDb);
    const chatMessageService = new MessageService(new SessionRepository(db), new MessageRepository(db));

    const embed = new EmbedderAdapter(embedder);
    const toolRegistry = new LLMTool();
    toolRegistry.registerBuiltin(createVectorSearchTool(vectorDb, embed));
    const llmService = LLMFactory.createFromEnv(chatMessageService, toolRegistry);
    const chatRoutes = new ChatMessages(chatMessageService, llmService);
    const storageRoutes = new StorageRoutes(s3Client, embedder);
    const gateway = new VGateway(3000, db, chatRoutes, storageRoutes);
    gateway.init();
    gateway.listen();

    console.log("[app] ready");
}

wa().catch((err) => {
    console.error("[app] fatal error:", err);
    process.exit(1);
});