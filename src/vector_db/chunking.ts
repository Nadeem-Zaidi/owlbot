// src/utils/chunking.ts
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";
import { Chunk } from "../interfaces/ifilestore";

const MAX_CHUNK_CHARS = 1500; // flush a chunk once it grows past this, even without a heading

export function chunkMarkdown(content: string, sourceFile: string): Chunk[] {
  const tree: any = unified().use(remarkParse).use(remarkGfm).parse(content);
  const chunks: Chunk[] = [];

  let current: Chunk = emptyChunk(sourceFile);
  let contentParts: string[] = [];
  let currentLength = 0;

  const flushContent = () => {
    current.content = contentParts.join("");
    contentParts = [];
    currentLength = 0;
  };
  const flush = (c: Chunk): Chunk | null =>
    c.content.trim() || c.codeBlocks.length > 0 || c.tables.length > 0 ? { ...c } : null;

  const startNewChunk = () => {
    flushContent();
    const flushed = flush(current);
    if (flushed) chunks.push(flushed);
    current = emptyChunk(sourceFile);
    contentParts = [];
    currentLength = 0;
  };

  const pushContent = (...parts: string[]) => {
    for (const part of parts) {
      contentParts.push(part);
      currentLength += part.length;
    }
    // Size-based fallback split: if we've built up a large blob of content
    // with no heading in sight (common with PDF-converted markdown that has
    // no real heading structure), flush it as its own chunk anyway.
    if (currentLength >= MAX_CHUNK_CHARS) {
      flushContent();
      const flushed = flush(current);
      if (flushed) chunks.push(flushed);
      const carryHeading = current.heading;
      const carryLevel = current.level;
      current = emptyChunk(sourceFile);
      // carry the heading/level forward so a mid-section split still
      // knows which section it came from
      current.heading = carryHeading;
      current.level = carryLevel;
      contentParts = [];
      currentLength = 0;
    }
  };

  for (const node of tree.children) {
    switch (node.type) {
      case "heading": {
        startNewChunk();
        current.heading = extractNode(node);
        current.level = node.depth;
        break;
      }
      case "paragraph":
        pushContent(extractNode(node), "\n");
        break;
      case "code":
        current.codeBlocks.push({ lang: node.lang ?? "", value: node.value });
        break;
      case "list":
        pushContent(extractList(node), "\n");
        break;
      case "table": {
        const parsed = extractTable(node);
        current.tables.push(parsed);
        const headerLine = parsed.headers.join(" | ");
        const rowLines = parsed.rows.map((r) => r.join(" | ")).join("\n");
        pushContent(`Table: ${headerLine}\n${rowLines}\n`);
        break;
      }
      case "blockquote": {
        const quoteText = (node.children as any[]).map((c) => extractNode(c)).join(" ");
        pushContent(`> ${quoteText}\n`);
        break;
      }
      case "html":
        pushContent(node.value.replace(/<[^>]+>/g, "").trim(), "\n");
        break;
      case "thematicBreak":
        startNewChunk();
        break;
      case "definition":
      case "footnoteDefinition":
      case "yaml":
        break;
      default:
        console.warn(`[chunkMarkdown] unhandled node type: "${node.type}"`);
    }
  }

  flushContent();
  const last = flush(current);
  if (last) chunks.push(last);

  return chunks;
}

/** Simple paragraph-split chunker for plain .txt uploads. */
export function chunkPlainText(content: string, sourceFile: string): Chunk[] {
  return content
    .split("\n\n")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((paragraph) => ({
      heading: "",
      level: 0,
      content: paragraph,
      codeBlocks: [],
      tables: [],
      sourceFile,
    }));
}

function emptyChunk(sourceFile: string): Chunk {
  return { heading: "", level: 0, content: "", codeBlocks: [], tables: [], sourceFile };
}

function extractNode(node: any): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value as string;
  if (["strong", "emphasis", "delete"].includes(node.type)) {
    return (node.children as any[])?.map((c) => extractNode(c)).join("") ?? "";
  }
  if (node.type === "link") {
    const text = (node.children as any[])?.map((c) => extractNode(c)).join("") ?? "";
    return node.url ? `${text} (${node.url})` : text;
  }
  if (!node.children) return "";
  return (node.children as any[]).map((c) => extractNode(c)).join("");
}

function extractTable(node: any): { headers: string[]; rows: string[][] } {
  const [headerRow, ...dataRows] = node.children as any[];
  const headers: string[] = headerRow.children.map(
    (cell: any) => (cell.children as any[])?.map((c) => extractNode(c)).join("").trim() ?? ""
  );
  const rows: string[][] = dataRows.map((row: any) =>
    (row.children as any[]).map((cell: any) => (cell.children as any[])?.map((c) => extractNode(c)).join("").trim() ?? "")
  );
  return { headers, rows };
}

function extractList(node: any, depth = 0): string {
  const parts: string[] = [];
  const indent = "  ".repeat(depth);
  for (const item of node.children as any[]) {
    for (const child of item.children as any[]) {
      if (child.type === "paragraph") {
        parts.push(`${indent}- ${extractNode(child)}\n`);
      } else if (child.type === "list") {
        parts.push(extractList(child, depth + 1));
      }
    }
  }
  return parts.join("");
}