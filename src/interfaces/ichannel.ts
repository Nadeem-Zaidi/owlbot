export type IncomingMessage={
    channelId:string;
    sessionKey:string;
    senderId:string;
    content:string|any[];
    raw:any;
}

export interface IChannel{
    readonly id:string;
    start():Promise<void>;
    stop():Promise<void>;
    send(sessionKey:string,text:string):Promise<void>;
    onMessage(handler:(msg:IncomingMessage)=>Promise<void>):void
}