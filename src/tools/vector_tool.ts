import { Embedder } from "../database/vector_db/embedding";
import { IVectorDb } from "../interfaces/vectordb/ivector";
import { ToolContext, ToolDefinition } from "./load_tools";

/**
 * Embedding is a separate concern from the vector store — IVectorDb only
 * stores/searches numbers, it never turns text into them. Depending on
 * this narrow interface (not a concrete class) means swapping embedding
 * providers later doesn't touch the tool or the DB layer.
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
}

/**
 * NEW — replaces the placeholder OpenAIEmbeddingProvider. Your Embedder
 * already has embedText(text): Promise<number[]>, which is this interface
 * exactly, just named differently. Wrapping it (instead of standing up a
 * second OpenAI client) guarantees the model/dimension used to embed a
 * query is the SAME one your ingestion pipeline used to embed the corpus
 * — that consistency is what a query-time-only client couldn't guarantee
 * for you automatically.
 */
export class EmbedderAdapter implements EmbeddingProvider {
  constructor(private embedder: Embedder) {}

  embed(text: string): Promise<number[]> {
    return this.embedder.embedText(text);
  }
}

const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 5;
// Relevance cut-offs (cosine similarity, text-embedding-3-small). Measured on
// real documents: on-topic chunks score ~0.4–0.7, unrelated ones ~0.1–0.2.
// Tune per corpus with KB_MIN_SCORE / KB_RELATIVE_MARGIN.
const MIN_SCORE = Number(process.env.KB_MIN_SCORE ?? 0.3);
const RELATIVE_MARGIN = Number(process.env.KB_RELATIVE_MARGIN ?? 0.2);

/**
 * The core RAG retrieval tool: the model gives you a natural-language
 * query, you embed it with the SAME model used at ingestion time, and
 * hand back the nearest chunks. This is a builtin (register via
 * `registry.registerBuiltin(...)`), not a dynamic/hot-reloadable tool —
 * it needs the live vectorDb + embedder injected, which the file-based
 * DynamicToolLoader has no way to do.
 */
// `documentKeys` limits an agent to specific documents; results are always
// limited to the calling user's own folder (ctx.userId).
export function createVectorSearchTool(vectorDb: IVectorDb, embed: EmbeddingProvider, documentKeys: string[] = []): ToolDefinition {
  return {
    name: "search_knowledge_base",
    description:
      "Semantic search over the indexed document store. Use this whenever the user asks about " +
      "content that might live in ingested documents rather than general knowledge — e.g. " +
      "'what does our doc say about X', 'find the section on Y'. Returns the most relevant chunks " +
      "with their source file, heading, and text. Always cite source_file when quoting a result. " +
      "Only relevant chunks are returned; if `results` is empty, the documents don't cover the " +
      "topic — say so plainly and don't cite any document for it.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The natural-language question or topic to search for. Do not pass raw keywords only — a full question retrieves better than isolated terms.",
        },
        limit: {
          type: "number",
          description: `Max chunks to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        },
      },
      required: ["query"],
    },
    execute: async (args: Record<string, any>, ctx: ToolContext) => {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        throw new Error("`query` is required and must be a non-empty string.");
      }

      const limit = Math.min(Math.max(Number(args.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

      const vector = await embed.embed(query);
      if (!ctx.userId) throw new Error("Knowledge base search needs a signed-in user.");
      const results = await vectorDb.search(vector, limit, true, {
        prefix: `${ctx.userId}/`,
        sourceFiles: documentKeys.length ? documentKeys : undefined,
        text: query,
        minScore: MIN_SCORE,
        relativeMargin: RELATIVE_MARGIN,
      });

      if (results.length === 0) {
        return {
          results: [],
          note: "Nothing in the knowledge base is relevant to this query. Tell the user their documents don't cover it; do not cite any document.",
        };
      }

      return {
        results: results.map((r) => ({
          source_file: r.payload?.source_file,
          heading: r.payload?.heading,
          score: Number(r.score.toFixed(4)),
          content: (r.payload as any)?.content ?? null,
        })),
      };
    },
  };
}

/**
 * Optional second tool: lets the model check what's actually indexed
 * before searching (useful for "what documents do you have access to?").
 * IVectorDb as shown has no "list distinct source files" method, so this
 * needs one small addition to PostgresqlVectorDb:
 *
 *   async listSourceFiles(): Promise<string[]> {
 *     const result = await this.db.query<{ source_file: string }>(
 *       `SELECT DISTINCT source_file FROM ${this.table} ORDER BY source_file`
 *     );
 *     return result.rows.map((r) => r.source_file);
 *   }
 *
 * ...added to IVectorDb's interface too. Drop this tool if you don't want
 * that surface area yet — search_knowledge_base above is the one that matters.
 */
export function createListSourceFilesTool(vectorDb: IVectorDb & { listSourceFiles(): Promise<string[]> }): ToolDefinition {
  return {
    name: "list_knowledge_base_sources",
    description: "Lists the distinct source documents currently indexed in the knowledge base. Use this to check what's available before searching, or when the user asks what documents you have access to.",
    parameters: { type: "object", properties: {}, required: [] },
    execute: async () => {
      const files = await vectorDb.listSourceFiles();
      return { source_files: files, count: files.length };
    },
  };
}

/**
 * Wiring, at startup — reuse the SAME Embedder instance your ingestion
 * pipeline already constructs (same apiKey, model, storage, vectorDb):
 *
 *   const embed = new EmbedderAdapter(embedder);
 *   llmToolRegistry.registerBuiltin(createVectorSearchTool(vectorDb, embed));
 *
 * No provider-specific code anywhere in this file — the same registered
 * tool is offered identically to OpenAI, Anthropic, Gemini, and Gemma via
 * toCanonicalTools() from tool_registry_bridge.ts.
 */