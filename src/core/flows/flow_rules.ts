import { RuleOp } from "./flow_types";

const MAX_REGEX_CHARS = 200;

// An amount with a currency: "₹62,000", "$1,500.50", "Rs. 900", "INR 5000", "5000 USD".
const CURRENCY_BEFORE = /(?:₹|\$|€|£|\b(?:rs\.?|inr|usd|eur|gbp)\s?)\s*(-?\d[\d,]*(?:\.\d+)?)/i;
const CURRENCY_AFTER = /(-?\d[\d,]*(?:\.\d+)?)\s?(?:inr|usd|eur|gbp|rupees|dollars)\b/i;
// A standalone number — not part of an id like "INV-7" or "A12".
const STANDALONE = /(?<![\w.-])-?\d[\d,]*(?:\.\d+)?(?![\w])|(?<![\w.-])\d[\d,]*(?:\.\d+)?(?![\w])/;

// The number a rule compares: the first amount with a currency if there is
// one, otherwise the first standalone number.
//   "Invoice INV-7 total ₹62,000" → 62000    "Total ₹52,300.50 due" → 52300.5
//   "Order 12 items for $1,500"   → 1500     "Score -3.2%" → -3.2
export function firstNumber(text: string): number | null {
    const m = text.match(CURRENCY_BEFORE)?.[1] ?? text.match(CURRENCY_AFTER)?.[1] ?? text.match(STANDALONE)?.[0];
    if (!m) return null;
    const n = Number(m.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
}

// Evaluates a condition rule on text. Text comparisons ignore case.
export function evaluateRule(text: string, op: RuleOp, value: string): { result: boolean; detail: string } {
    const t = text ?? "";
    const v = value ?? "";
    switch (op) {
        case "contains": return { result: t.toLowerCase().includes(v.toLowerCase()), detail: `contains "${v}"` };
        case "not_contains": return { result: !t.toLowerCase().includes(v.toLowerCase()), detail: `doesn't contain "${v}"` };
        case "equals": return { result: t.trim().toLowerCase() === v.trim().toLowerCase(), detail: `equals "${v}"` };
        case "is_empty": return { result: !t.trim(), detail: "is empty" };
        case "not_empty": return { result: !!t.trim(), detail: "isn't empty" };
        case "matches": {
            const re = safeRegex(v);
            return { result: re ? re.test(t) : false, detail: `matches /${v}/` };
        }
        default: {
            const n = firstNumber(t);
            const limit = firstNumber(v);
            if (n === null || limit === null) return { result: false, detail: n === null ? "no number found in the text" : "no number in the rule" };
            const sym = { number_gt: ">", number_gte: "≥", number_lt: "<", number_lte: "≤" }[op];
            const result = op === "number_gt" ? n > limit : op === "number_gte" ? n >= limit : op === "number_lt" ? n < limit : n <= limit;
            return { result, detail: `${n} ${sym} ${limit}` };
        }
    }
}

// User-written patterns: length-capped, and rejected if they look like
// catastrophic-backtracking shapes ("(a+)+").
export function safeRegex(pattern: string): RegExp | null {
    if (!pattern || pattern.length > MAX_REGEX_CHARS) return null;
    if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) return null;
    try {
        return new RegExp(pattern, "i");
    } catch {
        return null;
    }
}

// Fills {{input}}, {{previous}} and {{node.<id>}}.
export function renderTemplate(template: string, input: string, previous: string, outputs: Record<string, string>): string {
    return template
        .replace(/\{\{\s*input\s*\}\}/g, input)
        .replace(/\{\{\s*previous\s*\}\}/g, previous)
        .replace(/\{\{\s*node\.([A-Za-z0-9_-]+)\s*\}\}/g, (_m, id: string) => outputs[id] ?? "");
}

// The text a condition looks at: "previous", "input" or "node.<id>".
export function conditionSource(source: string, input: string, previous: string, outputs: Record<string, string>): string {
    if (source === "input") return input;
    const m = source.match(/^node\.([A-Za-z0-9_-]+)$/);
    if (m) return outputs[m[1]] ?? "";
    return previous;
}

// "YES." / "no — because…" → true / false; anything else → null.
export function parseYesNo(answer: string): boolean | null {
    const m = answer.trim().toLowerCase().match(/^[^a-z]*(yes|no)\b/);
    return m ? m[1] === "yes" : null;
}
