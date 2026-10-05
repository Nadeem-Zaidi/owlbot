# Owl Bot — backend

Node.js + TypeScript API for Owl Bot: chat with ChatGPT or Claude over your own
documents (RAG), from the web app or WhatsApp.

Frontend: `../../javascript_prac/owlbot_frontend`

## Run it

```bash
npm install
cp .env.example .env      # fill in the required block
npm run dev               # http://localhost:3000, restarts on change
```

Needs PostgreSQL with the `pgvector` extension and the Python gRPC service
(`python_prac/owlbot`) for file conversion and code functions. Tables are created by
migrations on startup. Uploads also need the gRPC Markdown converter running
at `GRPC_SERVER_ADDRESS`, and Firebase Admin credentials at
`src/authentication/serviceAccountKey.json` (never commit that file).

| Script | Does |
|---|---|
| `npm run dev` | Dev server with auto-restart |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build |

## How it fits together

```
web app ──HTTP──▶ gateway ──▶ routes ──▶ services ──▶ repositories ──▶ Postgres
WhatsApp ──────▶ channel ──▶ WhatsApp bridge ─┘           │
                                     llms (OpenAI / Claude) ── RAG tool ──▶ pgvector
```

- **Chat**: `routes/session_routes.ts` streams replies from a provider in
  `llms/`. History is stored per session in `chat_messages`; only the newest
  part is sent to the model (`llms/history_window.ts`).
- **Knowledge base**: uploads are converted to Markdown, chunked, embedded and
  stored in pgvector (`service/knowledge_base.ts`). The model searches it with
  the `search_knowledge_base` tool (`tools/vector_tool.ts`).
- **Agents**: user-built assistants with their own instructions, model,
  documents, built-in tools, HTTP functions and remote MCP servers, plus
  schedules (`service/agents/`, `routes/agent_routes.ts`). Secrets saved on
  agents are encrypted; agent URLs can't reach private networks.
- **Code functions**: the owner (`OWNER_EMAILS`) can write Python functions an
  agent may call. They run in the Python gRPC service (`CodeRunner.RunPython`,
  same address as the Markdown converter), one short-lived process per call.
- **Pipelines**: chain agents so each step's output feeds the next
  (`service/agents/pipeline_service.ts`, `routes/pipeline_routes.ts`). A step
  can be a regular agent or a provider agent; provider steps need their
  provider switched on, which is checked before a run starts.
- **WhatsApp**: `channels/whatsapp_channel.ts` (Baileys) moves messages;
  `service/whatsapp_bridge.ts` links numbers to accounts and runs the same
  chat engine. Enable with `WHATSAPP_ENABLED=true`, then pair from the web
  app → Connect WhatsApp.
  With `WHATSAPP_SELF_CHAT=true` the bot runs on your own number and only
  answers you in "Message yourself"; the one exception is the optional
  **away message** (Connect WhatsApp → Away message), a fixed reply sent to
  people who message you directly, once per person per chosen interval.
- **Provider agents**: agents stored and run by the provider itself:
  Claude Managed Agents or the OpenAI Agents API (beta, via the `openai-agents-v7`
  alias of `openai@7`). Each user switches one provider on; the other's agents
  are kept but disabled (`service/native_agents/`, `routes/native_agent_routes.ts`).
  Chats with them use the normal chat route, so history, search and token
  usage work the same. Regular agents are unchanged. Provider agents can
  also have HTTP functions and (owner-only) Python code functions: the
  provider decides when to call them, they run on this server, and each
  change updates the agent's tool list at the provider.
  ChatGPT provider agents can also get a **browser** (OpenAI computer use on
  a hosted desktop). When it wants to open a new site or sign in, the chat
  shows Allow/Deny or a sign-in form; answers go to `POST
  /api/native-agents/approvals/:id` and straight on to OpenAI (sign-in
  values are never stored). Unattended runs (pipelines) cancel such requests.
- **Token usage**: every provider is wrapped in `llms/usage_tracking.ts`, so
  web chat, WhatsApp, agents, schedules and pipelines all write one
  `token_usage` row per turn. The turn's total is also stored on the reply
  (`metadata.usage`) and shown under it. `GET /api/usage/summary` powers the
  Usage page; costs are estimates from `service/usage_pricing.ts`.
- **Search**: `GET /api/search?q=` (`repository/search_repository.ts`) matches
  chat titles and visible message text (not hidden instructions, attached
  documents or pipeline runs). The Search chats page also opens with Ctrl/Cmd+K.

- **Billing**: Razorpay subscriptions (Free / Pro / Business, monthly or
  yearly) with a monthly token allowance per plan (`service/billing/`,
  `routes/billing_routes.ts`). Quotas are checked in `UsageTrackingLLM`, so
  every feature is covered; enforcement starts with `BILLING_ENABLED=true`.
  Razorpay calls `POST /api/billing/webhook` (no Firebase auth, signature
  checked on the raw body; event ids de-duplicated). Create the Razorpay
  plans once with `npm run billing:create-plans`.
- **Sign-in**: Firebase. The API requires a verified phone number on the
  token (`REQUIRE_VERIFIED_PHONE`, default on), matching the sign-up flow.

## Production & scaling

- **Stateless API**: Firebase tokens, Postgres, S3. Run many copies behind a
  load balancer; `node dist/cluster.js` also uses every CPU core per server.
- **Redis** (`REDIS_URL`) shares rate limits and browser approvals between
  processes/servers. Without it, state is per process (fine for one).
- **Single-instance jobs**: WhatsApp (one login session) and, by default, the
  scheduler run only in worker 0 / the `jobs` service.
- **Startup**: migrations run under a Postgres advisory lock, so instances can
  start together. `GET /healthz` (alive) and `GET /readyz` (DB + Redis) are
  public for load balancers; SIGTERM drains open streams before exiting.
- **Limits**: per-user rate limits (`RATE_LIMIT_PER_MINUTE`,
  `CHAT_RATE_LIMIT_PER_MINUTE`) plus the plan quotas. AI providers' own rate
  limits are the real ceiling for model calls.
- **Deploy**: `docker compose -f docker-compose.prod.yml up -d --build`
  (nginx → API replicas, jobs, Redis, PgBouncer, Postgres, converter).
  Scale with `--scale api=N`. Load test with `npm run loadtest -- <url>`.

## Layout

```
src/
  main.ts                  startup and wiring
  gateway/                 Express + WebSocket server
  routes/                  HTTP endpoints (chat, storage, WhatsApp)
  service/                 business logic (messages, knowledge base, WhatsApp bridge)
  service/agents/          agents: tools, MCP client, scheduler, encryption, URL guard
  repository/              SQL for sessions, messages, WhatsApp links
  llms/                    OpenAI and Claude providers, factory, history window
  channels/                WhatsApp transport and message formatting
  tools/                   tools the model can call (RAG search)
  database/                Postgres adapter, migrations, embeddings
  vector_db/               chunking and pgvector store
  s3_client/, file_reader/ file storage (S3)
  protos/                  gRPC client: Markdown converter + Python code runner
  authentication/          Firebase token check
  interfaces/, types/      shared types
docs/sample-data/          sample documents for trying the knowledge base
```
