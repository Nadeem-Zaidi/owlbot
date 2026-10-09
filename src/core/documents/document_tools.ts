import { ToolDefinition } from "../../types/type";
import { DocumentService, GeneratedFileDto } from "./document_service";

// What a tool result carries so the chat shows a download card and
// WhatsApp/Telegram send the file itself (see collectReply / ChatBridge).
export type GeneratedFileMarker = { generated_file: GeneratedFileDto & { kind: "word" | "excel" } };

const receipt = (file: GeneratedFileDto) => ({
    generated_file: file,
    note: "The user gets a download card for this file (and the file itself on WhatsApp/Telegram). Reply in one or two sentences; don't paste the content again.",
});

export function createDocumentTools(docs: DocumentService): ToolDefinition[] {
    return [
        {
            name: "create_word_document",
            description:
                "Creates a Word (.docx) file the user can download, with ANY content they ask for — e.g. reports, proposals, letters, resumes/CVs, " +
                "essays, articles, notes, minutes, policies, manuals, guides, contracts, invoices, lesson plans, study notes, specs, checklists. " +
                "Use it when the user wants a Word/.docx/document file (or a skill says to). Shape the content to what they asked for — don't force a fixed template. " +
                "Write the content as Markdown: # headings (Word headings + navigation pane), paragraphs, **bold**, *italic*, `code`, [links](https://…), " +
                "- bullet and 1. numbered lists (indent to nest), GitHub tables (| a | b |), ``` code blocks, > quotes, --- lines, and <!-- pagebreak --> for a new page. " +
                "Pick the layout options that suit the document: branding=false for personal documents (resume, personal letter, essay) or when the user wants no company branding; " +
                "show_title=false / show_date=false for letters or documents that carry their own heading; cover_page for long formal documents; toc for long documents with many sections; " +
                "orientation=landscape for wide tables; page_size Letter for US users. " +
                "When branding is on, the user's company name, logo, colours and font are applied automatically — don't write them yourself. Don't repeat the title as a heading.",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "Document title (shown at the top unless show_title is false; also the file name)" },
                    subtitle: { type: "string", description: "Optional subtitle, e.g. 'Quarterly review · Draft 2'" },
                    markdown: { type: "string", description: "The full content as Markdown" },
                    filename: { type: "string", description: "Optional file name without extension" },
                    branding: { type: "boolean", description: "Company header/logo/footer (default true). false for personal documents or when asked for no branding" },
                    show_title: { type: "boolean", description: "Show the title block at the top (default true)" },
                    show_date: { type: "boolean", description: "Show today's date under the title (default true)" },
                    cover_page: { type: "boolean", description: "Put the title on its own cover page (default false)" },
                    toc: { type: "boolean", description: "Add a table of contents after the title (default false)" },
                    page_numbers: { type: "boolean", description: "Page numbers in the footer (default true)" },
                    orientation: { type: "string", enum: ["portrait", "landscape"], description: "Page orientation (default portrait)" },
                    page_size: { type: "string", enum: ["A4", "Letter"], description: "Paper size (default A4)" },
                },
                required: ["title", "markdown"],
            },
            execute: async (args, ctx) => {
                if (!ctx.userId) throw new Error("Creating files needs a signed-in user.");
                return receipt(await docs.createWord(ctx.userId, ctx.sessionId ?? null, args));
            },
        },
        {
            name: "create_excel_file",
            description:
                "Creates an Excel (.xlsx) file the user can download, with ANY tabular content — e.g. budgets, expense or sales trackers, invoices, " +
                "schedules/timetables, inventories, contact lists, project plans, attendance, comparisons, data exports, test cases, price lists. " +
                "Use it when the user wants Excel/a spreadsheet/.xlsx (or a skill says to). Design the sheets around their request. Give one or more sheets; each has columns " +
                "(header, optional type: text|number|integer|currency|percent|date|boolean|formula, optional width, optional options = dropdown values) " +
                "and rows = lists of values in column order. Dates as YYYY-MM-DD; percents as 0.85 or '85%'; formula columns hold Excel formulas " +
                "like '=D2*E2' (row numbers start at 2 under the header) and can set format: number|integer|currency|percent|date for their results. Optional totals = headers of numeric columns to sum. " +
                "Headers are styled, frozen and filterable by default (freeze_header / autofilter per sheet can turn that off). " +
                "style: \"branded\" (default — the user's brand colour on headers, striped rows) or \"plain\" (Excel's standard look).",
            parameters: {
                type: "object",
                properties: {
                    title: { type: "string", description: "What the workbook is (used as the file name)" },
                    filename: { type: "string", description: "Optional file name without extension" },
                    style: { type: "string", enum: ["branded", "plain"], description: "Look of the sheets (default branded)" },
                    sheets: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                name: { type: "string" },
                                columns: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            header: { type: "string" },
                                            type: { type: "string", enum: ["text", "number", "integer", "currency", "percent", "date", "boolean", "formula"] },
                                            format: { type: "string", enum: ["number", "integer", "currency", "percent", "date"], description: "Formula columns only: how results are formatted" },
                                            width: { type: "number" },
                                            options: { type: "array", items: { type: "string" } },
                                        },
                                        required: ["header"],
                                    },
                                },
                                rows: { type: "array", items: { type: "array", items: {} } },
                                totals: { type: "array", items: { type: "string" } },
                                freeze_header: { type: "boolean", description: "Keep the header row visible while scrolling (default true)" },
                                autofilter: { type: "boolean", description: "Filter buttons on the header (default true)" },
                            },
                            required: ["name", "columns", "rows"],
                        },
                    },
                },
                required: ["title", "sheets"],
            },
            execute: async (args, ctx) => {
                if (!ctx.userId) throw new Error("Creating files needs a signed-in user.");
                return receipt(await docs.createExcel(ctx.userId, ctx.sessionId ?? null, args));
            },
        },
    ];
}
