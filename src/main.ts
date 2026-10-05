import "dotenv/config";   // ← add this at the very top
import { VGateway } from "./gateway/vanilla_gateway";
import { DatabaseManager } from "./database/databasemanager";
import { DatabaseType } from "./database/databasefactory";
import { MigrationManager } from "./database/migration_manager.ts/migration_manager";
import { migrations } from "./database/migration_manager.ts/migration";
import { S3Config } from "./types/type";
import dotenv from "dotenv";
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
import { KnowledgeBase } from "./service/knowledge_base";
import { WhatsAppRepository } from "./repository/whatsapp_repository";
import { WhatsAppChannel } from "./channels/whatsapp_channel";
import { WhatsAppBridge } from "./service/whatsapp_bridge";
import { WhatsAppRoutes } from "./routes/whatsapp_routes";
import { AgentRepository } from "./repository/agent_repository";
import { AgentService } from "./service/agents/agent_service";
import { AgentScheduler } from "./service/agents/agent_scheduler";
import { AgentRoutes } from "./routes/agent_routes";
import { PipelineRepository } from "./repository/pipeline_repository";
import { PipelineService } from "./service/agents/pipeline_service";
import { PipelineRoutes } from "./routes/pipeline_routes";
import { UsageRepository } from "./repository/usage_repository";
import { UsageTrackingLLM } from "./llms/usage_tracking";
import { SearchRepository } from "./repository/search_repository";
import { createInsightsRouters } from "./routes/insights_routes";
import { NativeAgentRepository, NativeProvider } from "./repository/native_agent_repository";
import { NativeAgentService } from "./service/native_agents/native_agent_service";
import { NativeBackend } from "./service/native_agents/native_types";
import { ClaudeNativeBackend } from "./service/native_agents/claude_native";
import { OpenAINativeBackend } from "./service/native_agents/openai_native";
import { createNativeAgentRouter } from "./routes/native_agent_routes";
import { BillingRepository } from "./repository/billing_repository";
import { BillingService } from "./service/billing/billing_service";
import { createBillingRouter, createBillingWebhookRouter } from "./routes/billing_routes";
import { closeRedis } from "./infra/redis";
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
        // Per process. Several processes × this must stay under Postgres's
        // max_connections — or put PgBouncer in front (see docker-compose.prod.yml).
        maxConnections: Number(process.env.PG_POOL_MAX ?? 10),
    } as any);
    const db = dbManager.getConnection('pg');
    // One process at a time runs migrations / schema setup (others wait), so
    // several workers or servers can start together safely.
    await db.withTransaction(async () => {
        await db.query("SELECT pg_advisory_xact_lock(727274001)");
        await new MigrationManager(db).migrateUp(migrations);
    });
    const vectorDb = new PostgresqlVectorDb(db, "doc_vecs");
    await db.withTransaction(async () => {
        await db.query("SELECT pg_advisory_xact_lock(727274002)");
        await vectorDb.initialize();
    });

    // Some jobs must run in exactly one process: WhatsApp (one login session)
    // and, by default, the agent scheduler. In cluster mode only worker 0 runs them.
    const primaryWorker = !process.env.WORKER_INDEX || process.env.WORKER_INDEX === "0";

    const s3Config: S3Config = { region: process.env.AWS_REGION!, accesskeyid: process.env.AWS_ACCESS_KEY_ID!, secretaccesskey: process.env.AWS_SECRET_ACCESS_KEY! };
    const s3Client = new S3FileStore(process.env.S3_BUCKET || "nadeem-bucket-9891", s3Config);
    const embedder = new Embedder(OPENAI_API_KEY, EMBEDDING_MODEL, s3Client, vectorDb);
    const chatMessageService = new MessageService(new SessionRepository(db), new MessageRepository(db));

    const embed = new EmbedderAdapter(embedder);
    const toolRegistry = new LLMTool();
    toolRegistry.registerBuiltin(createVectorSearchTool(vectorDb, embed));
    const { providers, defaultProvider } = LLMFactory.createAllFromEnv(chatMessageService, toolRegistry, s3Client);
    // Record token usage for every chat turn, whichever feature started it.
    const usageRepo = new UsageRepository(db);
    // Subscriptions (Razorpay) and the monthly token quota of each plan.
    const billing = new BillingService(new BillingRepository(db));
    UsageTrackingLLM.quotaGate = (userId) => billing.checkAllowed(userId);
    console.log(`[billing] payments ${billing.paymentsEnabled ? "on" : "off (no Razorpay keys)"}; quotas ${process.env.BILLING_ENABLED === "true" ? "enforced" : "not enforced (BILLING_ENABLED != true)"}`);
    for (const [id, llm] of providers) providers.set(id, new UsageTrackingLLM(llm, usageRepo));
    console.log(`[app] LLM providers: ${[...providers.keys()].join(", ")} (default: ${defaultProvider})`);
    const knowledgeBase = new KnowledgeBase(s3Client, embedder, vectorDb);
    const agentRepo = new AgentRepository(db);
    const agentService = new AgentService({
        repo: agentRepo,
        messageService: chatMessageService,
        providers,
        defaultProvider,
        kb: knowledgeBase,
        vectorDb,
        embed,
        usage: usageRepo,
    });
    // Provider-native agents (Claude Managed Agents / OpenAI Agents API), for
    // each provider that has an API key.
    const nativeRepo = new NativeAgentRepository(db);
    const nativeBackends = new Map<NativeProvider, NativeBackend>();
    if (process.env.ANTHROPIC_API_KEY) nativeBackends.set("anthropic", new ClaudeNativeBackend(process.env.ANTHROPIC_API_KEY, nativeRepo));
    if (OPENAI_API_KEY) nativeBackends.set("openai", new OpenAINativeBackend(OPENAI_API_KEY));
    const nativeAgentService = new NativeAgentService({
        repo: nativeRepo,
        backends: nativeBackends,
        messageService: chatMessageService,
        usage: usageRepo,
        vectorDb,
        embed,
        agents: agentService,
    });
    const chatRoutes = new ChatMessages(chatMessageService, providers, defaultProvider, agentService, nativeAgentService, knowledgeBase);
    chatRoutes.billing = billing;
    const storageRoutes = new StorageRoutes(s3Client, embedder, knowledgeBase);

    // WhatsApp is opt-in: set WHATSAPP_ENABLED=true. On first run the server
    // prints a QR in the terminal — scan it from the bot's phone (WhatsApp →
    // Linked devices) once; the session is then kept in WHATSAPP_AUTH_DIR.
    const whatsappRepo = new WhatsAppRepository(db);
    let whatsappBridge: WhatsAppBridge | null = null;
    if (process.env.WHATSAPP_ENABLED === "true" && primaryWorker) {
        const channel = new WhatsAppChannel();
        whatsappBridge = new WhatsAppBridge({
            channel,
            repo: whatsappRepo,
            messageService: chatMessageService,
            providers,
            defaultProvider,
            kb: knowledgeBase,
        });
        whatsappBridge.start();
        // Don't block or crash the web app if WhatsApp can't connect.
        channel.start().catch((err) => console.error("[whatsapp] failed to start:", err));
    }
    const whatsappRoutes = new WhatsAppRoutes(chatMessageService, whatsappRepo, whatsappBridge);

    // Scheduled agent runs; results can also go to the user's WhatsApp.
    const agentScheduler = new AgentScheduler(
        agentRepo,
        agentService,
        whatsappBridge ? (userId, text) => whatsappBridge!.notifyUser(userId, text) : undefined,
    );
    // Safe on several servers (each slot is claimed atomically); turn off with
    // SCHEDULER_ENABLED=false to run it only on chosen instances.
    if (primaryWorker && process.env.SCHEDULER_ENABLED !== "false") agentScheduler.start();
    const agentRoutes = new AgentRoutes(agentService);
    agentRoutes.setScheduler(agentScheduler);

    const pipelineService = new PipelineService(new PipelineRepository(db), agentRepo, agentService, chatMessageService, nativeAgentService);
    await pipelineService.init();
    const pipelineRoutes = new PipelineRoutes(pipelineService);

    const { searchRouter, usageRouter } = createInsightsRouters(new SearchRepository(db), usageRepo);

    const gateway = new VGateway(Number(process.env.PORT ?? 3000), db, chatRoutes, storageRoutes, whatsappRoutes, agentRoutes, pipelineRoutes, [
        { path: "/api/search", router: searchRouter },
        { path: "/api/usage", router: usageRouter },
        { path: "/api/native-agents", router: createNativeAgentRouter(nativeAgentService) },
        { path: "/api/billing", router: createBillingRouter(billing) },
    ], [
        { path: "/api/billing/webhook", router: createBillingWebhookRouter(billing) },
    ]);
    gateway.init();
    gateway.listen();

    // Graceful shutdown (deploys, scale-in, Ctrl+C): stop taking traffic, let
    // streaming replies finish, then close connections.
    let stopping = false;
    const shutdown = async (signal: string) => {
        if (stopping) return;
        stopping = true;
        console.log(`[app] ${signal} — shutting down`);
        agentScheduler.stop();
        await gateway.close(Number(process.env.SHUTDOWN_GRACE_MS ?? 25_000));
        await Promise.allSettled([closeRedis(), db.disconnect()]);
        process.exit(0);
    };
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));

    console.log("[app] ready");
}

wa().catch((err) => {
    console.error("[app] fatal error:", err);
    process.exit(1);
});