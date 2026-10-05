// Converts the model's Markdown into WhatsApp's formatting and splits long
// replies into message-sized pieces.
//
// WhatsApp:  *bold*  _italic_  ~strike~  `code`  ```block```  — no headings,
// no link syntax, no tables. Code blocks are passed through untouched.

const MAX_MESSAGE_CHARS = 3500; // WhatsApp's hard limit is ~4096

function convertProse(text: string): string {
    return text
        // bullets first, so "* item" isn't mistaken for italics
        .replace(/^(\s*)[*+-]\s+/gm, "$1• ")
        // headings → bold line
        .replace(/^#{1,6}\s+(.+?)\s*#*$/gm, "**$1**")
        // horizontal rules
        .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, "")
        // table separator rows (|---|:---:|)
        .replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/gm, "")
        // links: [text](url) → text (url); bare when text is the url
        .replace(/\[([^\]]+)\]\((\S+?)\)/g, (_m, label: string, url: string) => (label === url ? url : `${label} (${url})`))
        // italics *x* (single star) → _x_ — before bold so ** isn't touched
        .replace(/(?<![*\w])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![*\w])/g, "_$1_")
        // bold **x** / __x__ → *x*
        .replace(/\*\*(.+?)\*\*/g, "*$1*")
        .replace(/__(.+?)__/g, "*$1*")
        // strikethrough
        .replace(/~~(.+?)~~/g, "~$1~")
        .replace(/\n{3,}/g, "\n\n");
}

export function toWhatsApp(markdown: string): string {
    // Split on fenced code blocks; odd segments are code.
    const parts = markdown.split(/(```[^\n]*\n[\s\S]*?```)/g);
    return parts
        .map((part, i) => (i % 2 === 1 ? part.replace(/^```[^\n]*\n/, "```\n") : convertProse(part)))
        .join("")
        .trim();
}

// Splits at paragraph, then line, then hard boundaries.
export function chunkMessage(text: string, max: number = MAX_MESSAGE_CHARS): string[] {
    const chunks: string[] = [];
    let current = "";
    const push = () => {
        if (current.trim()) chunks.push(current.trim());
        current = "";
    };
    for (const para of text.split(/\n{2,}/)) {
        const piece = current ? `\n\n${para}` : para;
        if (current.length + piece.length <= max) {
            current += piece;
            continue;
        }
        push();
        if (para.length <= max) {
            current = para;
            continue;
        }
        for (const line of para.split("\n")) {
            if (current.length + line.length + 1 > max) push();
            if (line.length > max) {
                for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
            } else {
                current += current ? `\n${line}` : line;
            }
        }
    }
    push();
    return chunks;
}
