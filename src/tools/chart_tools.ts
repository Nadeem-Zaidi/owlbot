import { logContext } from "../infra/observability/context";
import { ToolDefinition } from "../types/type";

// Charts drawn by the web app, inline in the chat (with a table view) — the
// model sends the data, not HTML, so charts always come out clean. The spec
// is the tool result itself, so it's saved with the chat's history.

export const CHART_TOOL_NAME = "show_chart";

const TYPES = ["bar", "line", "area", "pie", "donut"] as const;
const FORMATS = ["number", "currency", "percent"] as const;
const MAX_CATEGORIES = 60;
const MAX_SLICES = 12;
const MAX_SERIES = 8;
const MAX_LABEL = 60;

export type ChartSpec = {
    type: (typeof TYPES)[number];
    title: string;
    subtitle?: string;
    categories: string[];
    series: { name: string; values: (number | null)[] }[];
    stacked?: boolean;
    horizontal?: boolean;
    format: (typeof FORMATS)[number];
    currency?: string;
    x_label?: string;
    y_label?: string;
};

const text = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function toNumber(v: unknown): number | null {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    const n = Number(String(v).replace(/[,\s₹$€£%]/g, ""));
    return Number.isFinite(n) ? n : null;
}

export function validateChart(args: Record<string, any>): ChartSpec {
    const type = String(args.type ?? "bar").toLowerCase() as ChartSpec["type"];
    if (!TYPES.includes(type)) throw new Error(`type must be one of: ${TYPES.join(", ")}`);
    const format = String(args.format ?? "number").toLowerCase() as ChartSpec["format"];
    if (!FORMATS.includes(format)) throw new Error(`format must be one of: ${FORMATS.join(", ")}`);

    const categories = Array.isArray(args.categories) ? args.categories.map((c: unknown) => text(c, MAX_LABEL)) : [];
    if (!categories.length) throw new Error("categories is required — the x-axis labels (or slice names for pie/donut)");
    const round = type === "pie" || type === "donut";
    if (categories.length > (round ? MAX_SLICES : MAX_CATEGORIES)) {
        throw new Error(round ? `A ${type} chart can have at most ${MAX_SLICES} slices — use a bar chart, or group the small ones into "Other"` : `At most ${MAX_CATEGORIES} categories — aggregate the data first`);
    }

    const rawSeries = Array.isArray(args.series) ? args.series : [];
    if (!rawSeries.length) throw new Error("series is required — e.g. [{\"name\": \"Sales\", \"values\": [10, 20]}]");
    if (rawSeries.length > MAX_SERIES) throw new Error(`At most ${MAX_SERIES} series — split into several charts`);
    if (round && rawSeries.length > 1) throw new Error(`A ${type} chart shows one series — use a bar chart to compare several`);
    const series = rawSeries.map((s: any, i: number) => {
        const values = Array.isArray(s?.values) ? s.values.map(toNumber) : [];
        if (values.length !== categories.length) {
            throw new Error(`Series "${text(s?.name, MAX_LABEL) || i + 1}" has ${values.length} values but there are ${categories.length} categories — give one value per category (null for missing)`);
        }
        if (round && values.some((v: number | null) => v !== null && v < 0)) throw new Error(`A ${type} chart can't show negative values — use a bar chart`);
        return { name: text(s?.name, MAX_LABEL) || `Series ${i + 1}`, values };
    });
    if (series.every((s: { values: (number | null)[] }) => s.values.every((v) => v === null))) throw new Error("All values are empty");

    const spec: ChartSpec = { type, title: text(args.title, 120) || "Chart", categories, series, format };
    const subtitle = text(args.subtitle, 160);
    if (subtitle) spec.subtitle = subtitle;
    if (format === "currency") spec.currency = text(args.currency, 4) || "₹";
    if (!round && args.stacked === true && series.length > 1) spec.stacked = true;
    if (type === "bar" && args.horizontal === true) spec.horizontal = true;
    const x = text(args.x_label, MAX_LABEL), y = text(args.y_label, MAX_LABEL);
    if (x) spec.x_label = x;
    if (y) spec.y_label = y;
    return spec;
}

export function createChartTools(): ToolDefinition[] {
    return [
        {
            name: CHART_TOOL_NAME,
            description:
                "Shows a chart inline in the chat (the user can switch to a table view and hover for values). " +
                "Use it whenever the user asks to see data visually/as a chart/graph/plot, or when a chart makes numbers clearer. " +
                "Prefer this over writing HTML charts. Types: bar (compare categories; horizontal for long labels; stacked for parts of a whole), " +
                "line (trends over time), area (volume over time), pie/donut (share of a total, max 12 slices, one series). " +
                "Give categories (x-axis labels) and one or more series with one numeric value per category. " +
                "Use the data as given — if you computed or corrected values, say so in the subtitle or in your reply.",
            parameters: {
                type: "object",
                properties: {
                    type: { type: "string", enum: [...TYPES], description: "Chart type" },
                    title: { type: "string", description: "What the chart shows, e.g. \"Total sales by product (1–10 Oct 2023)\"" },
                    subtitle: { type: "string", description: "Optional: unit or context, e.g. \"Amount (₹) by product\"" },
                    categories: { type: "array", items: { type: "string" }, description: "x-axis labels, or slice names for pie/donut" },
                    series: {
                        type: "array",
                        description: "One or more data series (one value per category; null for missing)",
                        items: {
                            type: "object",
                            properties: {
                                name: { type: "string", description: "Legend name, e.g. \"Total sales\"" },
                                values: { type: "array", items: { type: "number" } },
                            },
                            required: ["name", "values"],
                        },
                    },
                    format: { type: "string", enum: [...FORMATS], description: "How values are shown (default number). percent expects 0–100." },
                    currency: { type: "string", description: "Currency symbol when format is currency (default ₹)" },
                    stacked: { type: "boolean", description: "bar/area with several series: stack them" },
                    horizontal: { type: "boolean", description: "bar only: horizontal bars (good for long labels)" },
                    x_label: { type: "string", description: "Optional x-axis title" },
                    y_label: { type: "string", description: "Optional y-axis title" },
                },
                required: ["type", "title", "categories", "series"],
            },
            execute: async (args) => {
                const chart = validateChart(args);
                const channel = logContext()?.channel;
                const web = !channel || channel === "web";
                return {
                    chart,
                    shown_to_user: web,
                    note: web
                        ? "The user sees this chart in the chat. Don't draw it again or paste the data as a table; reply with 1–3 sentences on what stands out."
                        : "This chat app can't show charts. Describe the key numbers and the main takeaway in a few short lines instead.",
                };
            },
        },
    ];
}
