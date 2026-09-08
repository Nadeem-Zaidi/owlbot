import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { IFileStore } from "./ifilestore";
import { processFiles } from "./concurrent_processor";

// ── Plain text: paragraph splitting ─────────────────────────────────────────

export interface TextParagraph {
  file: string;
  paragraph: string;
}

export function readTxtFiles(store: IFileStore,prefix: string,workerCount = 4,signal?: AbortSignal
): AsyncGenerator<TextParagraph> {
  return processFiles<TextParagraph>(
    store,
    prefix,
    ".txt",
    async function* (file, stream) {
      let carry = "";
      for await (const rawChunk of stream) {
        carry += rawChunk.toString("utf-8");
        const parts = carry.split("\n\n");
        carry = parts.pop()!; // last part may be incomplete
        for (const p of parts) {
          if (p.trim()) yield { file, paragraph: p };
        }
      }
      if (carry.trim()) yield { file, paragraph: carry };
    },
    { workerCount, signal }
  );
}

// ── Markdown: heading-based chunking ────────────────────────────────────────
// buildChunks / extractNode / extractTable / extractList never touched S3 in
// the original S3Reader — they operated purely on the parsed remark tree.
// They move here verbatim and now work against any IFileStore.

export interface Chunk {
  heading: string;
  level: number;
  content: string;
  codeBlocks: { lang: string; value: string }[];
  tables: { headers: string[]; rows: string[][] }[];
  sourceFile: string;
}

export function readMarkdownFiles(
  store: IFileStore,
  prefix: string,
  workerCount = 4,
  signal?: AbortSignal
): AsyncGenerator<Chunk> {
  return processFiles<Chunk>(
    store,
    prefix,
    ".md",
    async function* (file, stream) {
      const parts: Buffer[] = [];
      for await (const rawChunk of stream) parts.push(rawChunk);
      const content = Buffer.concat(parts).toString("utf-8");

      const tree = unified().use(remarkParse).use(remarkGfm).parse(content);
      yield* buildChunks(tree, file);
    },
    { workerCount, signal }
  );
}

function* buildChunks(tree: any, sourceFile: string): Generator<Chunk> {
  let current: Chunk = emptyChunk(sourceFile);
  let contentParts: string[] = [];
  const flushContent = () => {
    current.content = contentParts.join("");
    contentParts = [];
  };

  for (const node of tree.children) {
    switch (node.type) {
      case "heading": {
        flushContent();
        const flushed = flush(current);
        if (flushed) yield flushed;
        current = emptyChunk(sourceFile);
        contentParts = [];
        current.heading = extractNode(node);
        current.level = node.depth;
        break;
      }
      case "paragraph":
        contentParts.push(extractNode(node), "\n");
        break;
      case "code":
        current.codeBlocks.push({ lang: node.lang ?? "", value: node.value });
        break;
      case "list":
        contentParts.push(extractList(node), "\n");
        break;
      case "table": {
        const parsed = extractTable(node);
        current.tables.push(parsed);
        const headerLine = parsed.headers.join(" | ");
        const rowLines = parsed.rows.map((r) => r.join(" | ")).join("\n");
        contentParts.push(`Table: ${headerLine}\n${rowLines}\n`);
        break;
      }
      case "blockquote": {
        const quoteText = (node.children as any[])
          .map((c) => extractNode(c))
          .join(" ");
        contentParts.push(`> ${quoteText}\n`);
        break;
      }
      case "html":
        contentParts.push(node.value.replace(/<[^>]+>/g, "").trim(), "\n");
        break;
      case "thematicBreak": {
        flushContent();
        const flushed = flush(current);
        if (flushed) yield flushed;
        current = emptyChunk(sourceFile);
        contentParts = [];
        break;
      }
      case "definition":
      case "footnoteDefinition":
      case "yaml":
        break;
      default:
        console.warn(`[buildChunks] unhandled node type: "${node.type}"`);
    }
  }

  flushContent();
  const last = flush(current);
  if (last) yield last;
}

function emptyChunk(sourceFile: string): Chunk {
  return { heading: "", level: 0, content: "", codeBlocks: [], tables: [], sourceFile };
}

function flush(current: Chunk): Chunk | null {
  return current.content.trim() || current.codeBlocks.length > 0 || current.tables.length > 0
    ? { ...current }
    : null;
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
    (row.children as any[]).map(
      (cell: any) => (cell.children as any[])?.map((c) => extractNode(c)).join("").trim() ?? ""
    )
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