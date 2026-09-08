// import { Chunk, IFilereader } from "../llm/interfaces/filereader/ifilereader";
// import fs from "fs";
// import path from "path";
// import readline from "readline";
// import remarkParse from "remark-parse";
// import { unified } from "unified";

// export class LocalFileReader implements IFilereader {
//     private directory: string;
//     constructor(directory: string) {
//         this.directory = directory;
//     }
//     async list_files(continuationToken?: string | undefined,prefix?:string): Promise<Array<string>> {
//         return fs.promises.readdir(this.directory);
        
//     }


//     private extractNode(node: any): string {
//         if (node.type === "text") {
//             return node.value;
//         }
//         if (node.type === "inlineCode") {
//             return node.value;
//         }
//         if (!node.children) {
//             return "";
//         }
//         return node.children.map((child: any) => this.extractNode(child)).join("");
//     }

//     async *read_txt_files(workerCount: number = 4): AsyncGenerator<{ file: string, paragraph: string }> {
//         const files = (await this.list_files()).filter(f => f.endsWith(".txt"));
//         const fileQueue = [...files];

//         const paragraphQueue: Array<{ file: string, paragraph: string }> = [];
//         let done = false;
//         let resolve: (() => void) | null = null;

//         function push(item: { file: string, paragraph: string }) {
//             paragraphQueue.push(item);
//             resolve?.();
//         }

//         async function worker(self: LocalFileReader) {
//             while (fileQueue.length > 0) {
//                 const file = fileQueue.shift();
//                 if (!file) break;

//                 const filepath = path.join(self.directory, file);
//                 const fileStream = fs.createReadStream(filepath, { encoding: "utf-8" });
//                 const r = readline.createInterface({
//                     input: fileStream,
//                     crlfDelay: Infinity
//                 });

//                 try {
//                     let buffer: string[] = [];

//                     for await (const line of r) {
//                         if (line.trim()) {
//                             buffer.push(line.trimEnd());
//                         } else if (buffer.length > 0) {
//                             push({ file, paragraph: buffer.join(" ") });
//                             buffer = [];
//                         }
//                     }

//                     if (buffer.length > 0) {
//                         push({ file, paragraph: buffer.join(" ") });
//                     }
//                 } finally {
//                     r.close();
//                     fileStream.destroy();
//                 }
//             }
//         }

//         const workersPromise = Promise.all(
//             Array.from({ length: workerCount }, () => worker(this))
//         ).then(() => {
//             done = true;
//             resolve?.();
//         });

//         while (!done || paragraphQueue.length > 0) {
//             if (paragraphQueue.length > 0) {
//                 yield paragraphQueue.shift()!;
//             } else {
//                 await new Promise<void>(r => (resolve = r));
//             }
//         }

//         await workersPromise;
//     }
//     async *read_md_files(): AsyncGenerator<Chunk> {


//         const paragraphQueue: Array<Chunk> = [];
//         let done = false;
//         let resolve: (() => void) | null = null;
//         function push(item: Chunk) {
//             paragraphQueue.push(item);
//             resolve?.();
//         }

//         const files = (await fs.promises.readdir(this.directory)).filter((file: string) => file.endsWith(".md"));
//         const fileQueue = [...files];

//         async function worker(self: LocalFileReader) {
//             while (fileQueue.length > 0) {
//                 const file = fileQueue.shift();
//                 if (!file) break;

//                 const filepath = path.join(self.directory, file);
//                 const content = await fs.promises.readFile(filepath, "utf-8");

//                 const tree = unified().use(remarkParse).parse(content);

//                 let currentChunk: Chunk = {
//                     heading: "",
//                     level: 0,
//                     content: "",
//                     codeBlocks: []
//                 };

//                 for (const node of tree.children) {
//                     if (node.type === "heading") {
//                         if (currentChunk.content.trim() || currentChunk.codeBlocks.length > 0) {
//                             push(currentChunk);
//                         }
//                         currentChunk = {
//                             heading: self.extractNode(node),
//                             level: node.depth,
//                             content: "",
//                             codeBlocks: []
//                         };
//                     }
//                     if (node.type === "paragraph") {
//                         currentChunk.content += self.extractNode(node) + "\n";
//                     }
//                     if (node.type === "code") {
//                         currentChunk.codeBlocks.push({
//                             lang: (node as any).lang || "",
//                             value: node.value
//                         });
//                     }
//                     if (node.type === "list") {
//                         for (const item of (node as any).children) {
//                             const itemText = item.children
//                                 .map((child: any) => self.extractNode(child))
//                                 .join(" ");
//                             currentChunk.content += `- ${itemText}\n`;
//                         }
//                     }
//                 }

//                 if (currentChunk.content.trim() || currentChunk.codeBlocks.length > 0) {
//                     push(currentChunk);
//                 }
//             }
//         }

//         const workersPromise = Promise.all(
//             Array.from({ length: 4 }, () => worker(this))
//         ).then(() => {
//             done = true;
//             resolve?.();
//         });

//         while (!done || paragraphQueue.length > 0) {
//             if (paragraphQueue.length > 0) {
//                 yield paragraphQueue.shift()!;
//             } else {
//                 await new Promise<void>(r => (resolve = r));
//             }
//         }

//         await workersPromise;
//     }

// }



// // helper to reconstruct full content to send to LLM
// export function reconstructContent(chunk: Chunk): string {
//     let result = chunk.heading ? `## ${chunk.heading}\n` : "";
//     result += chunk.content;
//     for (const code of chunk.codeBlocks) {
//         result += `\`\`\`${code.lang}\n${code.value}\n\`\`\`\n`;
//     }
//     return result;
// }

// async function testing() {
//     const md = new LocalFileReader(path.join(__dirname, "../"));
//     for await (const chunk of md.read_md_files()) {
//         console.log("=== Chunk ===");
//         console.log("Heading:", chunk.heading);
//         console.log("Level:", chunk.level);
//         console.log("Content (for embedding):", chunk.content);
//         console.log("Code Blocks (for metadata):", chunk.codeBlocks);
//         console.log("Reconstructed (for LLM):", reconstructContent(chunk));
//         console.log("=============");
//     }
// }

// testing();