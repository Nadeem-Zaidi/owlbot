import fs from "fs";
import path from "path";
import chokidar, { FSWatcher } from "chokidar";
import { createRequire } from 'module';
import { IDatabaseAdapter } from "../database/idatabaseadapter";



export interface ToolContext {
    db: IDatabaseAdapter;
}

export interface ToolDefinition {
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: Record<string, {
            type: string;
            description?: string;
            enum?: any[];
        }>;
        required: string[];
    };
    execute: (
        args: Record<string, any>,
        ctx: ToolContext
    ) => Promise<any> | any;
}

export class DynamicToolLoader {
    private toolsDir: string;
    private loadedTools: Map<string, ToolDefinition> = new Map();
    private watcher: FSWatcher | null = null;

    constructor(toolsDir: string) {
        this.toolsDir = toolsDir;
        this.ensureToolsDir();
    }

    private ensureToolsDir(): void {
        if (!fs.existsSync(this.toolsDir)) {
            fs.mkdirSync(this.toolsDir, { recursive: true });
            console.log(`[ToolLoader] Created tools directory: ${this.toolsDir}`);
            this.writeExampleTools();
        }
    }

    private writeExampleTools(): void {
        const examples: Array<{ file: string; content: string }> = [
            {
                file: "_example_get_time.js",
                content: `/**
                    * Example Strix Tool — get current time
                    */
                    module.exports = {
                    name: "get_current_time",
                    description: "Returns the current date and time in ISO 8601 format.",
                    parameters: {
                        type: "object",
                        properties: {
                        timezone: {
                            type: "string",
                            description: "IANA timezone name, e.g. 'Asia/Kolkata'. Optional."
                        }
                        },
                        required: []
                    },
                    execute: async ({ timezone } = {}) => {
                        const now = new Date();
                        if (timezone) {
                        return now.toLocaleString("en-US", { timeZone: timezone });
                        }
                        return now.toISOString();
                    }
                    };
                    `,
                                },
                                {
                                    file: "_example_add_numbers.js",
                                    content: `/**
                    * Example Strix Tool — add two numbers
                    */
                    module.exports = {
                    name: "add_two_numbers",
                    description: "Adds two numbers and returns the sum.",
                    parameters: {
                        type: "object",
                        properties: {
                        a: { type: "number", description: "First number" },
                        b: { type: "number", description: "Second number" }
                        },
                        required: ["a", "b"]
                    },
                    execute: ({ a, b }) => a + b
                    };
                    `,
            },
        ];

        for (const ex of examples) {
            fs.writeFileSync(path.join(this.toolsDir, ex.file), ex.content, "utf8");
        }

        console.log(`[ToolLoader] Wrote example tool files to ${this.toolsDir}`);
    }

    async loadAll(): Promise<ToolDefinition[]> {
        this.loadedTools.clear();

        const files = fs
            .readdirSync(this.toolsDir)
            .filter((f) => f.endsWith(".js") && !f.startsWith("_"));

        for (const file of files) {
            await this.loadFile(path.join(this.toolsDir, file));
        }

        console.log(`[ToolLoader] Loaded ${this.loadedTools.size} tool(s) from ${this.toolsDir}`);
        return this.getTools();
    }

    private async loadFile(filePath: string): Promise<void> {
        try {
            // Try ES Module import first
            try {
                const fileUrl = `file://${path.resolve(filePath)}?t=${Date.now()}`;
                console.log('hurray ')
                console.log(`[ToolLoader] Attempting to load: ${filePath}`);

                console.log("hurray")
                const module = await import(fileUrl);
                const tool = module.default || module;

                
                
                if (this.validate(tool, filePath)) {
                    this.loadedTools.set(tool.name, tool);
                    console.log(`[ToolLoader] ✓ ${tool.name} (ES Module) (${path.basename(filePath)})`);
                    return;
                }
            } catch (esmError) {
                // If ES Module import fails, try CommonJS
                console.log(`[ToolLoader] ES Module import failed for ${filePath}, trying CommonJS...`);
            }

            // Try CommonJS require
            try {
                // Clear require cache for hot reload
                const resolvedPath = require.resolve(filePath);
                delete require.cache[resolvedPath];
                
                // Use require to load CommonJS module
                const tool = require(filePath);
                
                if (this.validate(tool, filePath)) {
                    this.loadedTools.set(tool.name, tool);
                    console.log(`[ToolLoader] ✓ ${tool.name} (CommonJS) (${path.basename(filePath)})`);
                    return;
                }
            } catch (cjsError) {
                console.error(`[ToolLoader] Both ES Module and CommonJS loading failed for ${filePath}:`, cjsError);
            }
        } catch (err) {
            console.error(`[ToolLoader] ✗ Failed to load ${filePath}:`, err);
        }
    }

    private unloadFile(filePath: string): void {
        const base = path.basename(filePath, ".js");
        for (const [name] of this.loadedTools) {
            if (name.replace(/_/g, "") === base.replace(/_/g, "")) {
                this.loadedTools.delete(name);
                console.log(`[ToolLoader] Unloaded tool: ${name}`);
            }
        }
    }

    private validate(tool: any, filePath: string): tool is ToolDefinition {
        const missing: string[] = [];
        if (!tool.name) missing.push("name");
        if (!tool.description) missing.push("description");
        if (!tool.parameters) missing.push("parameters");
        if (typeof tool.execute !== "function") missing.push("execute");

        if (missing.length) {
            console.warn(`[ToolLoader] Skipping ${filePath}: missing fields: ${missing.join(", ")}`);
            return false;
        }
        return true;
    }

    watch(onChange: (tools: ToolDefinition[]) => void): void {
        if (this.watcher) return;

        this.watcher = chokidar.watch(this.toolsDir, {
            ignoreInitial: true,
            awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
        });

        const reload = async (p: string) => {
            if (!p.endsWith(".js") || path.basename(p).startsWith("_")) return;
            await this.loadFile(p);
            onChange(this.getTools());
        };

        const unload = (p: string) => {
            if (!p.endsWith(".js") || path.basename(p).startsWith("_")) return;
            this.unloadFile(p);
            onChange(this.getTools());
        };

        this.watcher.on("add", reload);
        this.watcher.on("change", reload);
        this.watcher.on("unlink", unload);

        console.log(`[ToolLoader] Watching ${this.toolsDir}`);
    }

    stopWatching(): void {
        this.watcher?.close();
        this.watcher = null;
    }

    getTools(): ToolDefinition[] {
        return [...this.loadedTools.values()];
    }

    getToolsDir(): string {
        return this.toolsDir;
    }
}