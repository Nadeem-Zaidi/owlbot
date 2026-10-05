// src/utils/chunking.ts
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { unified } from "unified";
import { Chunk } from "../interfaces/ifilestore";

// Sizes are in characters (~4 chars per token). A chunk should hold one idea:
// big enough to carry context, small enough that its embedding isn't a blur
// of several topics (which is what lets unrelated documents score highly).
const TARGET_CHARS = Number(process.env.KB_CHUNK_TARGET_CHARS ?? 1000);
const MAX_CHARS = Math.max(TARGET_CHARS, Number(process.env.KB_CHUNK_MAX_CHARS ?? 1400));
// Sections shorter than this are merged into a neighbour instead of being
// embedded alone — a lone "Overview" line matches everything a little.
const MIN_CHARS = Number(process.env.KB_CHUNK_MIN_CHARS ?? 300);
// When a section is split, the next piece repeats this much of the previous
// one so a sentence that straddles the cut is still findable.
const OVERLAP_CHARS = Number(process.env.KB_CHUNK_OVERLAP_CHARS ?? 150);

type Block = { text: string; code?: { lang: string; value: string }; table?: { headers: string[]; rows: string[][] } };
type Section = { path: string[]; level: number; blocks: Block[] };

export function chunkMarkdown(content: string, sourceFile: string): Chunk[] {
  const tree: any = unified().use(remarkParse).use(remarkGfm).parse(content);

  // 1) Group top-level nodes into sections keyed by their heading path.
  const sections: Section[] = [];
  const headingStack: { depth: number; text: string }[] = [];
  let current: Section = { path: [], level: 0, blocks: [] };
  const openSection = () => {
    if (current.blocks.length) sections.push(current);
    current = { path: headingStack.map((h) => h.text), level: headingStack.at(-1)?.depth ?? 0, blocks: [] };
  };

  for (const node of tree.children) {
    switch (node.type) {
      case "heading": {
        const text = clean(extractNode(node));
        if (!text) break;
        while (headingStack.length && headingStack[headingStack.length - 1].depth >= node.depth) headingStack.pop();
        headingStack.push({ depth: node.depth, text });
        openSection();
        break;
      }
      case "paragraph":
        current.blocks.push({ text: extractNode(node) });
        break;
      case "code":
        current.blocks.push({ text: "", code: { lang: node.lang ?? "", value: node.value } });
        break;
      case "list":
        current.blocks.push({ text: extractList(node).trimEnd() });
        break;
      case "table": {
        const parsed = extractTable(node);
        current.blocks.push({ text: tableText(parsed.headers, parsed.rows), table: parsed });
        break;
      }
      case "blockquote": {
        const quoteText = (node.children as any[]).map((c) => extractNode(c)).join(" ");
        current.blocks.push({ text: `> ${quoteText}` });
        break;
      }
      case "html": {
        const text = node.value.replace(/<[^>]+>/g, "").trim();
        if (text) current.blocks.push({ text });
        break;
      }
      case "thematicBreak":
        openSection();
        break;
      case "definition":
      case "footnoteDefinition":
      case "yaml":
        break;
      default:
        console.warn(`[chunkMarkdown] unhandled node type: "${node.type}"`);
    }
  }
  openSection();

  // 2) Pack each section into size-bounded chunks, then 3) merge tiny ones.
  const packed = sections.flatMap((s) => packSection(s, sourceFile));
  return mergeSmall(packed);
}

/** Paragraph chunker for plain .txt uploads — same size rules as Markdown. */
export function chunkPlainText(content: string, sourceFile: string): Chunk[] {
  const blocks = content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((text) => ({ text }));
  return mergeSmall(packSection({ path: [], level: 0, blocks }, sourceFile));
}

function packSection(section: Section, sourceFile: string): Chunk[] {
  const heading = section.path.join(" > ");
  const chunks: Chunk[] = [];
  let parts: string[] = [];
  let length = 0;
  let codeBlocks: Chunk["codeBlocks"] = [];
  let tables: Chunk["tables"] = [];

  const flush = (carryOverlap: boolean) => {
    const text = parts.join("\n").trim();
    if (text || codeBlocks.length || tables.length) {
      chunks.push({ heading, level: section.level, content: text, sourceFile, codeBlocks, tables });
    }
    const overlap = carryOverlap ? tail(text, OVERLAP_CHARS) : "";
    parts = overlap ? [overlap] : [];
    length = overlap.length;
    codeBlocks = [];
    tables = [];
  };

  const add = (text: string) => {
    if (length > 0 && length + text.length + 1 > MAX_CHARS) flush(true);
    parts.push(text);
    length += text.length + 1;
    if (length >= TARGET_CHARS) flush(true);
  };

  for (const block of section.blocks) {
    if (block.code) {
      // Code counts toward the size too (it's embedded with the chunk).
      const codeLen = Math.min(block.code.value.length, MAX_CHARS);
      if (length > 0 && length + codeLen > MAX_CHARS) flush(true);
      codeBlocks.push(block.code);
      length += codeLen;
      if (length >= TARGET_CHARS) flush(false);
      continue;
    }
    if (block.table) tables.push(block.table);
    const text = block.text.trim();
    if (!text) continue;
    // An oversized block (PDF text often arrives as one giant paragraph)
    // is cut at sentence/line boundaries instead of becoming one chunk.
    for (const piece of text.length > MAX_CHARS ? splitLongText(text, TARGET_CHARS) : [text]) add(piece);
  }
  // Don't emit a trailing chunk that is nothing but the overlap we carried.
  if (parts.join("\n").trim().length > OVERLAP_CHARS || codeBlocks.length || tables.length || chunks.length === 0) flush(false);
  return chunks;
}

// Merges a chunk below MIN_CHARS into its neighbour from the same document.
// The absorbed section keeps its heading inline so nothing is lost, and the
// merged chunk's heading becomes the shared parent path.
function mergeSmall(chunks: Chunk[]): Chunk[] {
  const out: Chunk[] = [];
  for (const chunk of chunks) {
    const prev = out[out.length - 1];
    if (prev && (size(prev) < MIN_CHARS || size(chunk) < MIN_CHARS) && size(prev) + size(chunk) <= MAX_CHARS) {
      out[out.length - 1] = mergeTwo(prev, chunk);
    } else {
      out.push(chunk);
    }
  }
  return out;
}

function mergeTwo(a: Chunk, b: Chunk): Chunk {
  const heading = commonPath(a.heading, b.heading);
  const label = (c: Chunk) => (c.heading && c.heading !== heading ? `${lastSegment(c.heading)}:\n` : "");
  return {
    heading,
    level: Math.min(a.level, b.level),
    content: `${label(a)}${a.content}\n\n${label(b)}${b.content}`.trim(),
    sourceFile: a.sourceFile,
    codeBlocks: [...a.codeBlocks, ...b.codeBlocks],
    tables: [...a.tables, ...b.tables],
  };
}

const size = (c: Chunk) => c.content.length + c.codeBlocks.reduce((n, cb) => n + cb.value.length, 0);

function commonPath(a: string, b: string): string {
  const pa = a ? a.split(" > ") : [];
  const pb = b ? b.split(" > ") : [];
  const shared: string[] = [];
  for (let i = 0; i < Math.min(pa.length, pb.length) && pa[i] === pb[i]; i++) shared.push(pa[i]);
  return shared.join(" > ");
}

const lastSegment = (path: string) => path.split(" > ").pop() ?? path;

// Splits at sentence ends and line breaks, then packs the pieces up to
// `target`; a single run-on "sentence" longer than that is cut at a space.
function splitLongText(text: string, target: number): string[] {
  const sentences = text.split(/(?<=[.!?;:])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = "";
  for (let sentence of sentences) {
    while (sentence.length > target) {
      const cut = sentence.lastIndexOf(" ", target);
      const at = cut > target / 2 ? cut : target;
      if (buf) { out.push(buf); buf = ""; }
      out.push(sentence.slice(0, at).trim());
      sentence = sentence.slice(at).trim();
    }
    if (buf && buf.length + sentence.length + 1 > target) { out.push(buf); buf = ""; }
    buf = buf ? `${buf} ${sentence}` : sentence;
  }
  if (buf) out.push(buf);
  return out;
}

// The last ~n characters of `text`, starting at a sentence (or word) boundary.
function tail(text: string, n: number): string {
  // A chunk shorter than the overlap would just be repeated whole — skip it.
  if (n <= 0 || text.length <= n) return "";
  const slice = text.slice(-n);
  const sentence = slice.search(/(?<=[.!?])\s+\S/);
  if (sentence >= 0) return slice.slice(sentence).trim();
  const space = slice.indexOf(" ");
  return (space >= 0 ? slice.slice(space) : slice).trim();
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

function tableText(headers: string[], rows: string[][]): string {
  return `Table: ${headers.join(" | ")}\n${rows.map((r) => r.join(" | ")).join("\n")}`;
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
  if (node.type === "break") return "\n";
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
