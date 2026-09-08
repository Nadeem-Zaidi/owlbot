
type Content = { type: string; text: any }[];


type ToolFunction = (args: any) => Promise<Content>;

interface Tool {
    name: string;
    description: string;
    parameters: Record<string, any>;
    execute: ToolFunction;
}

export class ToolRegistry{
    private tools=new Map<string,Tool>();

    public registerTool(t:Tool){
        this.tools.set(t.name,t);
    }

    public get(name:string){
        const tool=this.tools.get(name);
        if(!tool) throw new Error("Tool not found");
        return {
            name:tool.name,
            description:tool.description,
            parameters:tool.parameters
        }

    }

    public isToolExists(name:string){
        let result=false;
        const tool=this.tools.get(name);
        if(!tool) return false;
        return true;
    }

    public getRegisteredTools(){
        return [...this.tools.values()].map((tool)=>({
            name:tool.name,
            description:tool.description,
            parameters:tool.parameters
        }))
    }
    public async execute(name:string,args:any){
        const tool=this.tools.get(name);
        if(!tool) throw Error(`Unknown Tool ${name}`);
         return tool.execute(args);
    }

}

