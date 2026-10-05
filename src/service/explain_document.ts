import { DocumentText } from "./knowledge_base";

type TextPart = {
    type: "text";
    text: string;
    hidden?: boolean;
    documentName?: string;
    documentKey?: string;
    truncated?: boolean;
    totalChars?: number;
};

// Message parts for "explain this document in detail": a visible request,
// hidden guidance for the model, and the document itself. Same shape the web
// app builds (owlbot_frontend chat_utils.ts), so a chat started on WhatsApp
// renders the same way on the web — the document shows as a card.
export function buildExplainDocumentParts(doc: DocumentText): TextPart[] {
    const escapedName = doc.name.replace(/"/g, "'");
    return [
        { type: "text", text: `Explain the topics covered in “${doc.name}” in detail.` },
        {
            type: "text",
            hidden: true,
            text:
                "[Instruction: the full text of the document is attached below. Walk through every main topic " +
                "and section in order. For each one, explain the concepts clearly, define key terms, give a " +
                "concrete example, and say how it connects to the other topics. Use a heading per topic and " +
                "finish with a short summary of the key takeaways. Base the explanation on the document; if you " +
                "add background from general knowledge, say so." +
                (doc.truncated
                    ? ` Only the first ${doc.content.length.toLocaleString()} of ${doc.totalChars.toLocaleString()} characters are included; mention that the rest wasn't covered.`
                    : "") +
                "]",
        },
        {
            type: "text",
            text: `<document name="${escapedName}">\n${doc.content}\n</document>`,
            documentName: doc.name,
            documentKey: doc.key,
            truncated: doc.truncated,
            totalChars: doc.totalChars,
        },
    ];
}
