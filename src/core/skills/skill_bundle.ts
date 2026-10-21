import { inflateRawSync } from "node:zlib";

// Skill folders, as published in skill marketplaces (Claude Agent Skills,
// OpenClaw…): a SKILL.md plus reference files and scripts, usually shared
// as a .zip. This reads the zip (no dependency; Office-style ZIP reader),
// finds SKILL.md and keeps the text files next to it. Scripts are kept as
// text the assistant can read — they are never run.

export const MAX_ZIP_BYTES = 5 * 1024 * 1024;
const MAX_ENTRIES = 500;
export const MAX_FILES = 60;
export const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

const SCRIPT_EXT = new Set(["py", "js", "mjs", "cjs", "ts", "sh", "bash", "ps1", "rb", "pl"]);
const TEXT_EXT = new Set(["md", "markdown", "txt", "csv", "tsv", "json", "jsonl", "yaml", "yml", "xml", "html", "htm", "sql", "toml", "ini", "cfg", ...SCRIPT_EXT]);

export class BundleError extends Error {}

export type BundleFile = { path: string; kind: "reference" | "script"; content: string; bytes: number };
export type SkillBundle = { skillMd: string; folder: string; files: BundleFile[]; skipped: { path: string; reason: string }[] };

// ── minimal ZIP reader ──
type Entry = { name: string; method: number; compressedSize: number; size: number; offset: number; flags: number };

function listEntries(buf: Buffer): Entry[] {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new BundleError("That isn't a valid .zip file");
    const count = buf.readUInt16LE(eocd + 10);
    if (count > MAX_ENTRIES) throw new BundleError(`The zip has too many files (max ${MAX_ENTRIES})`);
    let p = buf.readUInt32LE(eocd + 16);
    if (p === 0xffffffff) throw new BundleError("ZIP64 archives aren't supported");
    const out: Entry[] = [];
    for (let i = 0; i < count; i++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new BundleError("The zip file is damaged");
        const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
        out.push({
            flags: buf.readUInt16LE(p + 8),
            method: buf.readUInt16LE(p + 10),
            compressedSize: buf.readUInt32LE(p + 20),
            size: buf.readUInt32LE(p + 24),
            offset: buf.readUInt32LE(p + 42),
            name: buf.toString("utf8", p + 46, p + 46 + nameLen),
        });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}

function readEntry(buf: Buffer, e: Entry, limit: number): Buffer {
    if (e.flags & 0x1) throw new BundleError("Password-protected zips aren't supported");
    if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new BundleError("The zip file is damaged");
    const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
    const data = buf.subarray(start, start + e.compressedSize);
    if (e.method === 0) return Buffer.from(data.subarray(0, limit + 1));
    // The output cap stops "zip bombs" whatever the header claims.
    if (e.method === 8) {
        try { return inflateRawSync(data, { maxOutputLength: limit + 1 }); } catch { return Buffer.alloc(limit + 1); }
    }
    throw new BundleError(`Unsupported compression in ${e.name}`);
}

// "a/b/../c" and absolute or Windows paths are refused; backslashes become "/".
function cleanPath(p: string): string | null {
    const parts = p.replace(/\\/g, "/").split("/").filter((x) => x && x !== ".");
    if (!parts.length || parts.some((x) => x === ".." || /^[a-z]:$/i.test(x))) return null;
    return parts.join("/");
}

const extOf = (p: string) => (p.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
const hidden = (p: string) => p.split("/").some((x) => x.startsWith(".") || x === "__MACOSX" || x === "node_modules" || x === "__pycache__");

export function readSkillZip(buf: Buffer): SkillBundle {
    if (buf.length > MAX_ZIP_BYTES) throw new BundleError(`The zip is too big (max ${MAX_ZIP_BYTES / 1024 / 1024} MB)`);
    const entries = listEntries(buf)
        .map((e) => ({ e, path: cleanPath(e.name) }))
        .filter((x): x is { e: Entry; path: string } => !!x.path && !x.e.name.endsWith("/") && !hidden(x.path));

    // SKILL.md decides the folder: the shallowest one wins.
    const skillEntry = entries
        .filter((x) => /(^|\/)skill\.md$/i.test(x.path))
        .sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0];
    if (!skillEntry) throw new BundleError("No SKILL.md found in the zip");
    const folder = skillEntry.path.includes("/") ? skillEntry.path.slice(0, skillEntry.path.lastIndexOf("/") + 1) : "";
    const skillBuf = readEntry(buf, skillEntry.e, MAX_FILE_BYTES);
    if (skillBuf.length > MAX_FILE_BYTES) throw new BundleError("SKILL.md is too big");
    const skillMd = skillBuf.toString("utf8");

    const files: BundleFile[] = [];
    const skipped: SkillBundle["skipped"] = [];
    let total = 0;
    for (const { e, path } of entries) {
        if (e === skillEntry.e || !path.startsWith(folder)) continue;
        const rel = path.slice(folder.length);
        const ext = extOf(rel);
        if (!TEXT_EXT.has(ext)) { skipped.push({ path: rel, reason: "not a text file" }); continue; }
        if (files.length >= MAX_FILES) { skipped.push({ path: rel, reason: `more than ${MAX_FILES} files` }); continue; }
        if (e.size > MAX_FILE_BYTES) { skipped.push({ path: rel, reason: "larger than 256 KB" }); continue; }
        const data = readEntry(buf, e, MAX_FILE_BYTES);
        if (data.length > MAX_FILE_BYTES) { skipped.push({ path: rel, reason: "larger than 256 KB" }); continue; }
        if (data.subarray(0, 8000).includes(0)) { skipped.push({ path: rel, reason: "binary file" }); continue; }
        if (total + data.length > MAX_TOTAL_BYTES) { skipped.push({ path: rel, reason: "skill folder over 3 MB" }); continue; }
        if (rel.length > 200) { skipped.push({ path: rel.slice(0, 60) + "…", reason: "path too long" }); continue; }
        total += data.length;
        files.push({ path: rel, kind: SCRIPT_EXT.has(ext) ? "script" : "reference", content: data.toString("utf8").replace(/^﻿/, ""), bytes: data.length });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { skillMd, folder: folder.replace(/\/$/, ""), files, skipped };
}

// ── front matter ──
// The YAML subset skills use: `key: value`, quoted values, folded/literal
// blocks (`description: >` / `|`), indented continuation lines and simple
// lists (allowed-tools). Nested maps are ignored.
export function parseFrontMatter(markdown: string): { meta: Record<string, string>; body: string } {
    const text = markdown.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    const fm = text.match(/^---\n([\s\S]*?)\n---[ \t]*(\n|$)/);
    if (!fm) return { meta: {}, body: text.trim() };
    const meta: Record<string, string> = {};
    const lines = fm[1].split("\n");
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(/^([A-Za-z_][\w-]*):[ \t]*(.*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        let value = m[2].trim();
        const block = /^[>|][+-]?$/.test(value) ? value[0] : value === "" ? "plain" : null;
        if (block) {
            const parts: string[] = [];
            const list: string[] = [];
            while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
                const next = lines[++i];
                const item = next.match(/^\s*-\s+(.*)$/);
                if (item) list.push(unquote(item[1].trim()));
                else parts.push(next.trim());
            }
            value = list.length ? list.join(", ") : block === "|" ? parts.join("\n").trim() : parts.filter(Boolean).join(" ");
        } else if (/^\[.*\]$/.test(value)) {
            value = value.slice(1, -1).split(",").map((x) => unquote(x.trim())).filter(Boolean).join(", ");
        } else {
            value = unquote(value);
        }
        if (value) meta[key] = value;
    }
    return { meta, body: text.slice(fm[0].length).trim() };
}

const unquote = (v: string) => v.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1").replace(/\\n/g, " ");
