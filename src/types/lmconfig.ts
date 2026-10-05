

export type LLMConfig={
    model:string;
    temperature:number;
    maxTokens:number;
    // Models the user may pick for this provider; `model` is the default.
    models?:string[];
}
