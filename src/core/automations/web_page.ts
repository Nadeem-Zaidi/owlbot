import { createHash } from "node:crypto";
import { assertPublicUrl } from "../../service/agents/url_guard";

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 40_000;
const MAX_REDIRECTS = 3;

export class PageError extends Error {}

// Fetches a public page (every redirect hop is re-checked, so a page can't
// bounce the fetch to an internal address) and returns its readable text.
export async function fetchPageText(rawUrl: string): Promise<{ url: string; text: string }> {
    let url = await assertPublicUrl(rawUrl).catch((e) => { throw new PageError(e.message); });
    for (let hop = 0; ; hop++) {
        let res: Response;
        try {
            res = await fetch(url, {
                redirect: "manual",
                signal: AbortSignal.timeout(TIMEOUT_MS),
                headers: { "user-agent": "Mozilla/5.0 (compatible; OwlBot-Watcher/1.0)", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
            });
        } catch (e: any) {
            throw new PageError(e?.name === "TimeoutError" ? "The page took too long to respond" : "The page couldn't be reached");
        }
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
            if (hop >= MAX_REDIRECTS) throw new PageError("Too many redirects");
            url = await assertPublicUrl(new URL(res.headers.get("location")!, url).toString()).catch((e) => { throw new PageError(e.message); });
            continue;
        }
        if (!res.ok) throw new PageError(`The page answered ${res.status}`);
        const type = res.headers.get("content-type") ?? "";
        if (type && !/text\/|json|xml/i.test(type)) throw new PageError("That isn't a web page (it's a file or image)");
        const body = await readLimited(res);
        const text = /html|xml/i.test(type) || /^\s*</.test(body) ? htmlToText(body) : body;
        return { url: url.toString(), text: text.slice(0, MAX_TEXT) };
    }
}

async function readLimited(res: Response): Promise<string> {
    if (!res.body) return "";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…", rupee: "₹" };

// Visible text of a page, one block per line (scripts, styles and navigation chrome dropped).
export function htmlToText(html: string): string {
    return html
        .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article|\/td|\/th)\b[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
            if (e[0] === "#") {
                const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
                return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
            }
            return ENTITIES[e.toLowerCase()] ?? m;
        })
        .split("\n")
        .map((l) => l.replace(/[ \t\f\v ]+/g, " ").trim())
        .filter(Boolean)
        .join("\n");
}

export const hashText = (t: string) => createHash("sha256").update(t).digest("hex");

// Lines added and removed between two versions of a page.
export function diffLines(before: string, after: string): { added: string[]; removed: string[] } {
    const a = new Set(before.split("\n")), b = new Set(after.split("\n"));
    return { added: [...b].filter((l) => !a.has(l)), removed: [...a].filter((l) => !b.has(l)) };
}
