import { ZodTypeAny } from "zod";

export interface IServer {
  registerTools(
    toolName: string,
    configuration: {
      description: string;
      inputSchema: ZodTypeAny;
    },
    func: (args: any) => Promise<{
      content: { type: "text"; text: string }[];
      isError?: boolean;
    }>
  ): void;

  start(): Promise<void>;
}
