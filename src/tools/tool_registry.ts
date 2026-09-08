import { ToolContext, ToolDefinition } from "../types/type";


export class LLMTool {
  private tools: Map<string, ToolDefinition> = new Map();
  private builtinNames: Set<string> = new Set();
  registerBuiltin(def: ToolDefinition): void {
    this.tools.set(def.name, def);
    this.builtinNames.add(def.name);
  }


  registerDynamic(defs: ToolDefinition[]): void {
    this.clearDynamic();
    for (const def of defs) {
      this.tools.set(def.name, def);
    }
    console.log(
      `[ToolRegistry] ${defs.length} dynamic tool(s) registered: ${defs.map((d) => d.name).join(", ") || "(none)"}`
    );
  }

  clearDynamic(): void {
    for (const name of [...this.tools.keys()]) {
      if (!this.builtinNames.has(name)) {
        this.tools.delete(name);
      }
    }
  }


  async executeTool(
    name: string,
    args: Record<string, any>,
    ctx: ToolContext
  ): Promise<any> {

    const tool = this.tools.get(name);

    if (!tool) {
      throw new Error(
        `Unknown tool: ${name}`
      );
    }

    return await tool.execute(
      args,
      ctx
    );
  }

  getAll(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }
}