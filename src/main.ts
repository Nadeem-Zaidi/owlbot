import "dotenv/config";   // ← add this at the very top
import { installConsoleBridge, registerGauge } from "./infra/observability";
import { EventBus } from "./infra/events/event_bus";
import { LiveSocketServer } from "./gateway/live_socket";
import { verifySocketToken } from "./authentication/authentication_middleware";
import { redis, redisSubscriber } from "./infra/redis";
// Before anything logs: console output becomes structured (LOG_FORMAT=json,
// default in production) with request/user/run ids, and secrets are masked.
installConsoleBridge();
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
import { LLMKeyRepository } from "./repository/llm_key_repository";
import { ModelRegistry } from "./service/model_registry";
import { createLLMKeyRouter } from "./routes/llm_key_routes";
import { SettingsRepository } from "./repository/settings_repository";
import { SettingsService } from "./service/settings_service";
import { WhatsAppManager } from "./service/whatsapp_manager";
import { createAdminRouter } from "./routes/admin_routes";
import { ArtifactRepository } from "./repository/artifact_repository";
import { createArtifactTools } from "./tools/artifact_tools";
import { createArtifactRouter } from "./routes/artifact_routes";
import { AgentRuntime } from "./core/runtime";
import { contextEngine, setContextEngine, SummaryContextEngine } from "./core/context";
import { createMemoryTools, MemoryRecallEngine, MemoryService } from "./core/memory";
import { MemoryRepository } from "./repository/memory_repository";
import { createMemoryRouter } from "./routes/memory_routes";
import { createSkillTools, SkillIndexEngine, SkillService } from "./core/skills";
import { SkillRepository } from "./repository/skill_repository";
import { createSkillRouter } from "./routes/skill_routes";
import { ChatBridge } from "./channels/core/chat_bridge";
import { AgentDirectory } from "./channels/core/chat_adapter";
import { telegramBotInfo } from "./channels/telegram/telegram_adapter";
import { ChannelLinkRepository } from "./repository/channel_link_repository";
import { TelegramManager } from "./service/telegram_manager";
import { ChannelControlHub } from "./channels/core/channel_control";
import { createTelegramRouter } from "./routes/telegram_routes";
import { SessionSummaryRepository } from "./repository/session_summary_repository";
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
    // ROLE=all (default): one process does everything (the primary worker
    // hosts WhatsApp, Telegram and the scheduler). ROLE=api: HTTP only, scale
    // freely. ROLE=jobs: also hosts WhatsApp, Telegram and the scheduler —
    // run exactly one. api and jobs reach each other through Redis.
    const role = (process.env.ROLE ?? "all").toLowerCase();
    if (!["all", "api", "jobs"].includes(role)) throw new Error(`ROLE must be all, api or jobs (got "${role}")`);
    if (role !== "all" && !process.env.REDIS_URL) console.warn(`[app] ROLE=${role} without REDIS_URL: API servers can't reach WhatsApp/Telegram in the jobs process`);
    const hostsJobs = primaryWorker && role !== "api";
    console.log(`[app] role: ${role}${hostsJobs ? " (hosts messaging apps and the scheduler)" : ""}`);

    const s3Config: S3Config = { region: process.env.AWS_REGION!, accesskeyid: process.env.AWS_ACCESS_KEY_ID!, secretaccesskey: process.env.AWS_SECRET_ACCESS_KEY! };
    const s3Client = new S3FileStore(process.env.S3_BUCKET || "nadeem-bucket-9891", s3Config);
    const embedder = new Embedder(OPENAI_API_KEY, EMBEDDING_MODEL, s3Client, vectorDb);
    const chatMessageService = new MessageService(new SessionRepository(db), new MessageRepository(db));

    const embed = new EmbedderAdapter(embedder);
    const toolRegistry = new LLMTool();
    toolRegistry.registerBuiltin(createVectorSearchTool(vectorDb, embed));
    // Documents/reports shown in a side panel (any model that supports tools).
    const artifactRepo = new ArtifactRepository(db);
    const artifactTools = createArtifactTools(artifactRepo);
    for (const t of artifactTools) toolRegistry.registerBuiltin(t);
    // Long-term memory: facts about each user, saved by the assistant
    // (save_memory) or on the Memory page, recalled in every chat.
    // MEMORY_ENABLED=false turns the feature off for everyone.
    const memoryEnabled = process.env.MEMORY_ENABLED !== "false";
    const memoryService = new MemoryService(new MemoryRepository(db));
    const memoryTools = memoryEnabled ? createMemoryTools(memoryService) : [];
    for (const t of memoryTools) toolRegistry.registerBuiltin(t);
    // Skills: reusable instruction packs, listed in each request and loaded on demand.
    const skillService = new SkillService(new SkillRepository(db));
    const skillTools = createSkillTools(skillService);
    for (const t of skillTools) toolRegistry.registerBuiltin(t);
    const { providers, defaultProvider } = LLMFactory.createAllFromEnv(chatMessageService, toolRegistry, s3Client);
    // Record token usage for every chat turn, whichever feature started it.
    const usageRepo = new UsageRepository(db);
    // Subscriptions (Razorpay) and the monthly token quota of each plan.
    const billing = new BillingService(new BillingRepository(db));
    UsageTrackingLLM.quotaGate = (userId) => billing.checkAllowed(userId);
    console.log(`[billing] payments ${billing.paymentsEnabled ? "on" : "off (no Razorpay keys)"}; quotas ${process.env.BILLING_ENABLED === "true" ? "enforced" : "not enforced (BILLING_ENABLED != true)"}`);
    for (const [id, llm] of providers) providers.set(id, new UsageTrackingLLM(llm, usageRepo));
    console.log(`[app] LLM providers: ${[...providers.keys()].join(", ")} (default: ${defaultProvider})`);
    // The server's providers plus each user's own API keys (BYOK).
    const modelRegistry = new ModelRegistry({
        platform: providers,
        defaultProvider,
        repo: new LLMKeyRepository(db),
        usage: usageRepo,
        messageService: chatMessageService,
        tools: toolRegistry,
        fileStore: s3Client,
    });
    const knowledgeBase = new KnowledgeBase(s3Client, embedder, vectorDb);
    // What part of a chat's history each request carries: recent messages
    // plus a running summary of older ones (CONTEXT_ENGINE=window keeps the
    // old behaviour: newest messages only, older ones dropped).
    if ((process.env.CONTEXT_ENGINE ?? "summary") !== "window") {
        const historyTokens = Number(process.env.CONTEXT_HISTORY_TOKENS) || 24_000;
        setContextEngine(new SummaryContextEngine(new SessionSummaryRepository(db), { historyTokens }));
        console.log(`[context] summary engine on (history budget ~${historyTokens} tokens per request)`);
    }
    setContextEngine(new SkillIndexEngine(contextEngine(), skillService));
    if (memoryEnabled) setContextEngine(new MemoryRecallEngine(contextEngine(), memoryService));
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
        registry: modelRegistry,
        alwaysTools: [...artifactTools, ...memoryTools, ...skillTools],
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
    // Every user turn — web chat, WhatsApp, schedules — runs through this one
    // runtime: session check, agent/model resolution, one turn at a time per
    // chat (across workers when REDIS_URL is set), one log line per turn.
    // Live events (turns starting/finishing) to the web app, across every
    // process and server through Redis when REDIS_URL is set.
    const events = new EventBus(redis, redisSubscriber);
    await events.start();
    const runtime = new AgentRuntime({
        events,
        messageService: chatMessageService,
        providers,
        defaultProvider,
        registry: modelRegistry,
        agents: agentService,
        nativeAgents: nativeAgentService,
        kb: knowledgeBase,
        apiKey: OPENAI_API_KEY,
    });
    const chatRoutes = new ChatMessages(chatMessageService, providers, defaultProvider, agentService, nativeAgentService, knowledgeBase);
    chatRoutes.billing = billing;
    chatRoutes.registry = modelRegistry;
    chatRoutes.runtime = runtime;
    const storageRoutes = new StorageRoutes(s3Client, embedder, knowledgeBase);

    // WhatsApp is turned on/off in Server settings (stored in Postgres; .env
    // only seeds the first value). The first time, open the web app → Connect
    // WhatsApp and scan the QR from the bot's phone; the login is kept in
    // WHATSAPP_AUTH_DIR. One login can't run in two processes, so only the
    // primary worker hosts it — and in a multi-server setup only the instance
    // without WHATSAPP_HOST=false.
    // /agents and /agent in WhatsApp and Telegram.
    const agentDirectory: AgentDirectory = {
        list: async (userId) => (await agentService.list(userId)).map((a) => ({ id: a.id, name: a.name, icon: a.icon ?? null })),
        startChat: async (userId, agentId, source) => {
            const label = source === "telegram" ? "Telegram" : "WhatsApp";
            const session = await chatMessageService.createSession(userId, source as "whatsapp" | "telegram", `${label} chat`);
            await agentService.agentForSession(session.id, userId, agentId);
            return session.id;
        },
    };
    const whatsappRepo = new WhatsAppRepository(db);
    const settingsService = new SettingsService(new SettingsRepository(db));
    await settingsService.seedFromEnv();
    const whatsappManager = new WhatsAppManager({
        settings: settingsService,
        canHost: hostsJobs && process.env.WHATSAPP_HOST !== "false",
        makeBridge: (channel) => new WhatsAppBridge({
            channel,
            repo: whatsappRepo,
            messageService: chatMessageService,
            providers,
            defaultProvider,
            kb: knowledgeBase,
            registry: modelRegistry,
            runtime,
            agents: agentDirectory,
        }),
    });
    await whatsappManager.init();

    // Telegram bot: turned on and given its token in Server settings. Like
    // WhatsApp, one process polls it (TELEGRAM_HOST=false on other servers).
    const telegramLinks = new ChannelLinkRepository(db, "telegram");
    const telegramManager = new TelegramManager({
        settings: settingsService,
        canHost: hostsJobs && process.env.TELEGRAM_HOST !== "false",
        makeBridge: (adapter) => new ChatBridge({
            adapter,
            links: telegramLinks,
            messageService: chatMessageService,
            providers,
            defaultProvider,
            kb: knowledgeBase,
            registry: modelRegistry,
            runtime,
            agents: agentDirectory,
        }),
    });
    await telegramManager.init();

    // Status and commands for WhatsApp/Telegram from any process: direct when
    // hosted here, through Redis when they run in the jobs process.
    const channelHub = new ChannelControlHub(redis, redisSubscriber);
    if (whatsappManager.hosted) channelHub.registerHost("whatsapp", {
        snapshot: () => whatsappManager.snapshot(),
        pair: async () => { await whatsappManager.bridge?.pairBot(); },
        continueSession: async (u, s) => (await whatsappManager.bridge?.continueSession(u, s)) ?? false,
        notifyUser: async (u, text) => (await whatsappManager.bridge?.notifyUser(u, text)) ?? false,
    });
    if (telegramManager.hosted) channelHub.registerHost("telegram", {
        snapshot: () => telegramManager.snapshot(),
        continueSession: async (u, s) => (await telegramManager.bridge?.continueSession(u, s)) ?? false,
        notifyUser: async (u, text) => (await telegramManager.bridge?.notifyUser(u, text)) ?? false,
    });
    await channelHub.start();
    const whatsappControl = channelHub.control("whatsapp");
    const telegramControl = channelHub.control("telegram");
    const whatsappRoutes = new WhatsAppRoutes(chatMessageService, whatsappRepo, whatsappControl, settingsService);

    // Scheduled agent runs; results can also go to the user's WhatsApp.
    const agentScheduler = new AgentScheduler(
        agentRepo,
        agentService,
        (userId, text) => whatsappManager.bridge ? whatsappManager.bridge.notifyUser(userId, text) : Promise.resolve(false),
    );
    // Safe on several servers (each slot is claimed atomically); turn off with
    // SCHEDULER_ENABLED=false to run it only on chosen instances.
    if (hostsJobs && process.env.SCHEDULER_ENABLED !== "false") agentScheduler.start();
    agentScheduler.useRuntime(runtime);
    const agentRoutes = new AgentRoutes(agentService);
    agentRoutes.setScheduler(agentScheduler);

    // Workflows: AI conditions use the user's default model in a hidden chat;
    // approvals and Notify steps reach the user's WhatsApp, else Telegram.
    const notifyLinkedApp = async (userId: string, text: string) =>
        (await whatsappControl.notifyUser(userId, text).catch(() => false))
        || (await telegramControl.notifyUser(userId, text).catch(() => false));
    const pipelineService = new PipelineService(new PipelineRepository(db), agentRepo, agentService, chatMessageService, nativeAgentService, {
        askModel: (userId, sessionId, prompt, signal) => runtime.runToText({
            channel: "pipeline", userId, sessionId, input: { type: "message", role: "user", content: [{ type: "text", text: prompt }] },
        }, signal).then((r) => ({ text: r.text, error: r.error ?? (r.cancelled ? "timed out" : null) })),
        notify: notifyLinkedApp,
        webAppUrl: process.env.WEB_APP_URL,
    });
    await pipelineService.init();
    const pipelineRoutes = new PipelineRoutes(pipelineService);

    const { searchRouter, usageRouter } = createInsightsRouters(new SearchRepository(db), usageRepo);

    const gateway = new VGateway(Number(process.env.PORT ?? 3000), db, chatRoutes, storageRoutes, whatsappRoutes, agentRoutes, pipelineRoutes, [
        { path: "/api/search", router: searchRouter },
        { path: "/api/usage", router: usageRouter },
        { path: "/api/native-agents", router: createNativeAgentRouter(nativeAgentService) },
        { path: "/api/billing", router: createBillingRouter(billing) },
        { path: "/api/llm-keys", router: createLLMKeyRouter(modelRegistry) },
        { path: "/api/artifacts", router: createArtifactRouter(artifactRepo) },
        { path: "/api/memory", router: createMemoryRouter(memoryService) },
        { path: "/api/skills", router: createSkillRouter(skillService) },
        { path: "/api/admin", router: createAdminRouter(settingsService, whatsappManager, { manager: telegramManager, verify: (t) => telegramBotInfo(t) }, { whatsapp: whatsappControl, telegram: telegramControl }) },
        { path: "/api/telegram", router: createTelegramRouter(chatMessageService, telegramLinks, telegramControl, settingsService) },
    ], [
        { path: "/api/billing/webhook", router: createBillingWebhookRouter(billing) },
    ]);
    gateway.setStatus(() => ({ activeRuns: runtime.activeRuns(), busySessions: runtime.lanes.activeSessions() }));
    registerGauge("owl_active_turns", "Chat turns running in this process", () => runtime.activeRuns());
    registerGauge("owl_busy_chats", "Chats with a turn running or queued in this process", () => runtime.lanes.activeSessions());
    registerGauge("owl_channel_up", "1 when a messaging app is connected in this process", () => [
        [{ channel: "whatsapp" }, whatsappManager.status().state === "connected" ? 1 : 0],
        [{ channel: "telegram" }, telegramManager.status().state === "connected" ? 1 : 0],
    ]);
    gateway.init();
    gateway.addUpgradeHandler(new LiveSocketServer(events, verifySocketToken,
        (process.env.CORS_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean)));
    gateway.listen();

    // Graceful shutdown (deploys, scale-in, Ctrl+C): stop taking traffic, let
    // streaming replies finish, then close connections.
    let stopping = false;
    const shutdown = async (signal: string) => {
        if (stopping) return;
        stopping = true;
        console.log(`[app] ${signal} — shutting down`);
        agentScheduler.stop();
        channelHub.stop();
        await whatsappManager.stop().catch(() => {});
        await telegramManager.stop().catch(() => {});
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