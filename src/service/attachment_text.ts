import { LLMMessage } from "../types/llm_message";
import { KnowledgeBase } from "./knowledge_base";

// Both providers read PDFs (and images) natively from the attachment itself.
const NATIVE_EXTENSIONS = new Set(["pdf"]);

const extensionOf = (part: any): string =>
    String(part.fileExtension || String(part.fileName ?? "").split(".").pop() || "").toLowerCase();

// Word, Excel, PowerPoint, text… attachments: add the text extracted at
// upload (stored next to the file as Markdown) as a document part, so the
// model can actually read them. Same shape as "Explain this document", so
// the web app shows it as a document card and search skips it.
export async function withAttachmentText(message: LLMMessage, userId: string, kb: KnowledgeBase): Promise<LLMMessage> {
    if (!Array.isArray(message.content)) return message;
    const parts = message.content as any[];
    const extra: any[] = [];

    for (const part of parts) {
        if (part?.type !== "input_file") continue;
        const name = String(part.fileName ?? "").trim();
        if (!name || NATIVE_EXTENSIONS.has(extensionOf(part))) continue;
        if (parts.some((p) => p?.documentName === name)) continue; // already attached

        const doc = await kb.readDocument(userId, name).catch(() => null);
        if (doc) {
            extra.push({
                type: "text",
                text: `<document name="${doc.name.replace(/"/g, "'")}">\n${doc.content}\n</document>`,
                documentName: doc.name,
                documentKey: doc.key,
                truncated: doc.truncated,
                totalChars: doc.totalChars,
            });
            if (doc.truncated) {
                extra.push({ type: "text", hidden: true, text: `[Only the first ${doc.content.length.toLocaleString()} of ${doc.totalChars.toLocaleString()} characters of "${doc.name}" are included; say so if it matters.]` });
            }
        } else {
            console.warn(`[attachments] no extracted text for "${name}" — is the Python document converter running?`);
            extra.push({ type: "text", hidden: true, text: `[The attached file "${name}" couldn't be read as text. Tell the user it couldn't be opened and that they can try re-uploading it.]` });
        }
    }
    return extra.length ? { ...message, content: [...parts, ...extra] } : message;
}
