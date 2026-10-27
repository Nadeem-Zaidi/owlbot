import { Route, Rule, RuleGroup, RuleOp } from "./flow_types";

const MAX_REGEX_CHARS = 200;
const MAX_JSON_CHARS = 200_000;
export const FIELD_RE = /^[A-Za-z_$][\w$-]*(?:\.[\w$-]+|\[\d{1,4}\])*$/;

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
        case "starts_with": return { result: t.trim().toLowerCase().startsWith(v.trim().toLowerCase()), detail: `starts with "${v}"` };
        case "ends_with": return { result: t.trim().toLowerCase().endsWith(v.trim().toLowerCase()), detail: `ends with "${v}"` };
        case "one_of": {
            const options = listValues(v);
            const hit = options.find((o) => o.toLowerCase() === t.trim().toLowerCase());
            return { result: !!hit, detail: hit ? `is "${hit}"` : `isn't one of ${options.map((o) => `"${o}"`).join(", ")}` };
        }
        case "number_between": {
            const range = numberRange(v);
            const n = firstNumber(t);
            if (!range) return { result: false, detail: "the range isn't valid" };
            if (n === null) return { result: false, detail: "no number found in the text" };
            return { result: n >= range[0] && n <= range[1], detail: `${n} between ${range[0]} and ${range[1]}` };
        }
        // Without a JSON field these mean "has text" / "has no text".
        case "exists": return { result: !!t.trim(), detail: "exists" };
        case "not_exists": return { result: !t.trim(), detail: "doesn't exist" };
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
        .replace(/\{\{\s*node\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)\s*\}\}/g, (_m, id: string) => outputs[id] ?? "");
}

// The text a condition looks at: "previous", "input", "node.<id>" or
// "node.<id>.<branch id>" (one branch of a parallel step).
export function conditionSource(source: string, input: string, previous: string, outputs: Record<string, string>): string {
    if (source === "input") return input;
    const m = source.match(/^node\.([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?)$/);
    if (m) return outputs[m[1]] ?? "";
    return previous;
}

// "YES." / "no — because…" → true / false; anything else → null.
export function parseYesNo(answer: string): boolean | null {
    const m = answer.trim().toLowerCase().match(/^[^a-z]*(yes|no)\b/);
    return m ? m[1] === "yes" : null;
}

// "a, b ; c" or one per line → ["a", "b", "c"].
export function listValues(value: string): string[] {
    return value.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 50);
}

// "100..500", "100 to 500" → [100, 500]; null when it isn't a valid range.
export function numberRange(value: string): [number, number] | null {
    const m = value.match(/^\s*(-?[\d,]*\.?\d+)\s*(?:\.\.|to)\s*(-?[\d,]*\.?\d+)\s*$/i);
    if (!m) return null;
    const lo = Number(m[1].replace(/,/g, "")), hi = Number(m[2].replace(/,/g, ""));
    return Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi ? [lo, hi] : null;
}

// The JSON an agent answered with: the whole text, a ```json fence, or the
// outermost {...} / [...] inside prose. Undefined when there is none.
export function extractJson(text: string): unknown {
    const t = (text ?? "").trim();
    if (!t || t.length > MAX_JSON_CHARS) return undefined;
    const attempts = [t];
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) attempts.push(fence[1].trim());
    for (const [open, close] of [["{", "}"], ["[", "]"]]) {
        const a = t.indexOf(open), b = t.lastIndexOf(close);
        if (a !== -1 && b > a) attempts.push(t.slice(a, b + 1));
    }
    for (const candidate of attempts) {
        if (!/^[[{]/.test(candidate)) continue;
        try {
            return JSON.parse(candidate);
        } catch {
            // try the next shape
        }
    }
    return undefined;
}

// Reads "order.items[0].sku" (or "order.items.0.sku") from parsed JSON.
export function readField(data: unknown, path: string): { found: boolean; value: unknown } {
    let cur: unknown = data;
    for (const key of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
        if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, key)) return { found: false, value: undefined };
        cur = (cur as Record<string, unknown>)[key];
    }
    return { found: cur !== undefined, value: cur };
}

const fieldText = (v: unknown) => (v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

// The text a rule sees, parsed lazily once per subject (rules share it).
export class RuleSubject {
    private parsed: unknown;
    private didParse = false;
    constructor(readonly text: string) {}

    json(): unknown {
        if (!this.didParse) {
            this.parsed = extractJson(this.text);
            this.didParse = true;
        }
        return this.parsed;
    }
}

// One rule, optionally on a JSON field.
export function evaluateOne(subject: RuleSubject, rule: Rule): { result: boolean; detail: string } {
    if (!rule.field) return evaluateRule(subject.text, rule.op, rule.value);
    const data = subject.json();
    const { found, value } = data === undefined ? { found: false, value: undefined } : readField(data, rule.field);
    if (rule.op === "exists") return { result: found, detail: `${rule.field} ${found ? "exists" : "is missing"}` };
    if (rule.op === "not_exists") return { result: !found, detail: `${rule.field} ${found ? "exists" : "is missing"}` };
    if (!found) return { result: false, detail: data === undefined ? `no JSON found to read ${rule.field}` : `${rule.field} is missing` };
    const r = evaluateRule(fieldText(value), rule.op, rule.value);
    return { result: r.result, detail: `${rule.field} ${r.detail}` };
}

// ALL: every rule must pass (stops at the first failure). ANY: one is enough
// (stops at the first pass). The detail explains the deciding rule(s).
export function evaluateGroup(subject: RuleSubject, group: RuleGroup): { result: boolean; detail: string } {
    const details: string[] = [];
    for (const rule of group.rules) {
        const r = evaluateOne(subject, rule);
        details.push(`${r.result ? "✓" : "✗"} ${r.detail}`);
        if (group.match === "all" && !r.result) return { result: false, detail: details.join("; ") };
        if (group.match === "any" && r.result) return { result: true, detail: details.join("; ") };
    }
    return { result: group.match === "all", detail: details.join("; ") };
}

// Matches the AI's answer to one route: exact name, "2" / "2." (its number),
// or the one route name the answer contains. "NONE" or anything unclear →
// null (the router then takes Otherwise).
export function parseRoutePick(answer: string, routes: Route[]): Route | null {
    const clean = answer.trim().replace(/^[\s"'`*_#>-]+|[\s"'`*_.!]+$/g, "").toLowerCase();
    if (!clean || /^none\b/.test(clean)) return null;
    const exact = routes.find((r) => r.label.toLowerCase() === clean);
    if (exact) return exact;
    const num = clean.match(/^(?:route\s*)?(\d{1,2})\b/);
    if (num) return routes[Number(num[1]) - 1] ?? null;
    const contained = routes.filter((r) => new RegExp(`(^|[^a-z0-9])${escapeRegex(r.label.toLowerCase())}([^a-z0-9]|$)`).test(clean));
    if (contained.length === 1) return contained[0];
    // Several names mentioned: take the longest only if no other is part of it ("High" vs "Very high").
    if (contained.length > 1) {
        const longest = [...contained].sort((a, b) => b.label.length - a.label.length)[0];
        return contained.every((r) => r === longest || longest.label.toLowerCase().includes(r.label.toLowerCase())) ? longest : null;
    }
    return null;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
