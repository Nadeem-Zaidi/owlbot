import { ArtifactKind, ArtifactRepository } from "../repository/artifact_repository";
import { ToolDefinition } from "../types/type";

// Lets any model put substantial standalone content (a report, a document, a
// web page or dashboard) in a side panel next to the chat — like artifacts in
// Claude or canvas in ChatGPT. The content is stored (with versions); the
// model only gets a short receipt back, so it doesn't re-read the whole thing.

const MAX_CONTENT_CHARS = 400_000;
const MAX_TITLE_CHARS = 120;
export const ARTIFACT_TOOL_NAMES = ["create_artifact", "update_artifact"];

const HTML_GUIDE =
    "For kind \"html\": write ONE complete, self-contained HTML document (<!doctype html>, <style> inline, no external CSS files). " +
    "It renders in a sandboxed frame that blocks network requests, except scripts from https://cdn.jsdelivr.net, https://cdnjs.cloudflare.com and https://unpkg.com " +
    "(e.g. Chart.js: <script src=\"https://cdn.jsdelivr.net/npm/chart.js@4.4.1\"></script>). Embed all data inline. " +
    "Draw every chart with Chart.js on a <canvas> inside a container with a fixed height — never build bars or charts out of divs, " +
    "and never put long text inside bars; labels go on the axes and in tooltips. Use a clean sans-serif font, generous spacing, " +
    "and format numbers consistently (thousand separators, the right currency symbol). " +
    "Make it responsive, readable and polished: clear headings, summary first, tables and charts where they help.";

const receipt = (a: { id: string; title: string; kind: string; current_version: number }) => ({
    artifact_id: a.id,
    title: a.title,
    kind: a.kind,
    version: a.current_version,
    shown_to_user: true,
    note: "The user sees this in a side panel. Don't repeat its content in chat; reply with one or two sentences about it.",
});

function validate(args: Record<string, any>, requireKind: boolean): { kind?: ArtifactKind; title: string; content: string } {
    const title = String(args.title ?? "").trim().slice(0, MAX_TITLE_CHARS);
    const content = typeof args.content === "string" ? args.content : "";
    if (!content.trim()) throw new Error("`content` is required");
    if (content.length > MAX_CONTENT_CHARS) throw new Error(`Content is too long (max ${MAX_CONTENT_CHARS.toLocaleString()} characters) — split it or shorten it`);
    let kind: ArtifactKind | undefined;
    if (requireKind || args.kind !== undefined) {
        if (args.kind !== "html" && args.kind !== "markdown") throw new Error('`kind` must be "html" or "markdown"');
        kind = args.kind;
    }
    return { kind, title, content };
}

export function createArtifactTools(repo: ArtifactRepository): ToolDefinition[] {
    return [
        {
            name: "create_artifact",
            description:
                "Shows a document in a side panel next to the chat, where the user can read, copy and download it. " +
                "Use it for substantial standalone content the user asked for — a report, document, article, plan, " +
                "web page, dashboard or HTML visualisation (roughly 20+ lines). Don't use it for short answers or quick snippets. " +
                "kind \"markdown\" for text documents; \"html\" for pages, dashboards and reports with charts or styling. " +
                "To just visualise some data as one chart, use show_chart instead — it renders inline and cleanly. " + HTML_GUIDE,
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "Short title, e.g. \"Q3 Sales Report\"" },
                    kind: { type: "string", enum: ["html", "markdown"], description: "html or markdown" },
                    content: { type: "string", description: "The complete document" },
                },
                required: ["title", "kind", "content"],
            },
            execute: async (args, ctx) => {
                if (!ctx.userId) throw new Error("Creating documents needs a signed-in user.");
                const { kind, title, content } = validate(args, true);
                const art = await repo.create(ctx.userId, ctx.sessionId ?? null, kind!, title || "Untitled", content);
                return receipt(art);
            },
        },
        {
            name: "update_artifact",
            description:
                "Saves a new version of a document you created with create_artifact (the user can still see earlier versions). " +
                "Use it when the user asks to change, fix or extend that document. Always send the COMPLETE new content, not a diff.",
            parameters: {
                type: "object",
                properties: {
                    artifact_id: { type: "string", description: "The artifact_id returned by create_artifact" },
                    content: { type: "string", description: "The complete updated document" },
                    title: { type: "string", description: "New title (optional; keeps the current one)" },
                    change_summary: { type: "string", description: "What changed, in a few words" },
                },
                required: ["artifact_id", "content"],
            },
            execute: async (args, ctx) => {
                if (!ctx.userId) throw new Error("Editing documents needs a signed-in user.");
                const id = String(args.artifact_id ?? "");
                const current = /^[0-9a-f-]{36}$/i.test(id) ? await repo.get(ctx.userId, id) : null;
                if (!current) throw new Error("That document doesn't exist — create it with create_artifact instead.");
                const { title, content } = validate(args, false);
                const summary = typeof args.change_summary === "string" ? args.change_summary.slice(0, 300) : null;
                const art = await repo.addVersion(ctx.userId, id, title || current.title, content, summary);
                return receipt(art!);
            },
        },
    ];
}
