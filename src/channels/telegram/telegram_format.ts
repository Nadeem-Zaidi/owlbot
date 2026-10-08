import { chunkMessage } from "../whatsapp_format";

// Converts the model's Markdown into Telegram's HTML formatting
// (parse_mode "HTML": <b> <i> <s> <code> <pre> <a>) and splits long replies.
// Telegram's limit is 4096 characters after formatting is applied; chunks
// are cut from the Markdown first, with room to spare.

const MAX_CHUNK_CHARS = 3500;

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string) => escape(s).replace(/"/g, "&quot;");

function convertProse(text: string): string {
    // Inline code first, kept aside so nothing inside it is formatted.
    const codes: string[] = [];
    let out = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
        codes.push(`<code>${escape(code)}</code>`);
        return `\u0000${codes.length - 1}\u0000`;
    });
    // Links, also kept aside (their URL must not be formatted).
    const links: string[] = [];
    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label: string, url: string) => {
        links.push(`<a href="${escapeAttr(url)}">${escape(label)}</a>`);
        return `\u0001${links.length - 1}\u0001`;
    });
    out = escape(out)
        // bullets first, so "* item" isn't mistaken for italics
        .replace(/^(\s*)[*+-]\s+/gm, "$1• ")
        // headings → bold line
        .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, "<b>$1</b>")
        // horizontal rules and table separator rows
        .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, "")
        .replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/gm, "")
        // bold before italics; a single line at a time so tags always pair up
        .replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>")
        .replace(/__([^\n]+?)__/g, "<b>$1</b>")
        .replace(/(?<![*\w])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![*\w])/g, "<i>$1</i>")
        .replace(/~~([^\n]+?)~~/g, "<s>$1</s>")
        .replace(/\n{3,}/g, "\n\n");
    return out
        .replace(/\u0001(\d+)\u0001/g, (_m, i: string) => links[Number(i)])
        .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]);
}

export function toTelegramHtml(markdown: string): string {
    // Split on fenced code blocks; odd segments are code.
    const parts = markdown.split(/(```[^\n]*\n[\s\S]*?```)/g);
    return parts
        .map((part, i) => {
            if (i % 2 === 0) return convertProse(part);
            const lang = part.match(/^```([\w+-]*)/)?.[1];
            const code = part.replace(/^```[^\n]*\n/, "").replace(/```$/, "").replace(/\n$/, "");
            return `<pre><code${lang ? ` class="language-${escapeAttr(lang)}"` : ""}>${escape(code)}</code></pre>`;
        })
        .join("")
        .trim();
}

export function renderTelegram(markdown: string): string[] {
    return chunkMessage(markdown, MAX_CHUNK_CHARS).map(toTelegramHtml).filter((s) => s.length > 0);
}

// Plain-text fallback if Telegram rejects the HTML.
export function stripHtml(html: string): string {
    return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
}
