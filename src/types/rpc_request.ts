export type RPCRequest={
    jsonrpc:"2.0";
    id:string;
    method:string;
    params:Record<string,unknown>
    
}

type RPCResponse<T = unknown> =
  | { jsonrpc: "2.0"; id: number; result: T }
  | { jsonrpc: "2.0"; id: number; error: { code: number; message: string } };



export type RPCEvent={
    jsonprc:"2.0";
    method:string;
    params:unknown;
}

export type HandlerContext = {
  ws: WebSocket;
  send: <T>(id: number, result: T) => void;
  sendError: (id: number, code: number, message: string) => void;
  pushEvent: (method: string, params: unknown) => void;
  stream: (id: number, chunk: string, done: boolean) => void;
};
 
export type Handler = (params: Record<string, unknown>, ctx: HandlerContext) => Promise<void>;