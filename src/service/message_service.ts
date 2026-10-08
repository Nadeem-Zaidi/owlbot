import { InvalidSession } from "../error_handling/app_error";
import { MessageRepository } from "../repository/message_repository";
import { SessionRepository } from "../repository/sessiopn_repository";
import { LLMMessage } from "../types/llm_message";
import { Session } from "../types/type";


export class  MessageService{
    private sessionRepository:SessionRepository;
    private messageRepository:MessageRepository;
    constructor(sessionRepository:SessionRepository,messageRepository:MessageRepository){
        this.sessionRepository=sessionRepository;
        this.messageRepository=messageRepository;
    }

    async rawDb(){
        return this.messageRepository.rawDb();
    }

    async getUserSessionsPage(userId: string, limit: number, after?: { ts: string; id: string }) {
        return this.sessionRepository.getUserSessionsPage(userId, limit, after);
    }

    async getUserSessions(userId:string):Promise<Session[]>{
        const userSessions=await this.sessionRepository.getUserSessions(userId)
        return userSessions;
    }

    // True only if the session exists AND belongs to this user.
    async isSessionValid(sessionId:string,userId:string):Promise<boolean>{
        const session = await this.sessionRepository.getSession(sessionId,userId)
        return !!session
    }

    async getSession(sessionId:string,userId:string):Promise<Session>{
        const session=await this.sessionRepository.getSession(sessionId,userId);
        if(!session){
            throw new InvalidSession();
        }
        return session;
    }



    async createSession(userId:string, source:"web"|"whatsapp"|"telegram"|"pipeline"="web", title?:string):Promise<Session>{
        const createdSession=await this.sessionRepository.createSession(userId, source, title);
        return createdSession;
    }

    async updateTitle(sessionId:string,userId:string,title:string){
        await this.sessionRepository.updateTitle(sessionId,userId,title)

    }

    async createLLMMessage(sessionId:string,message:LLMMessage){
        await this.messageRepository.insertLLMMessage(sessionId,message);

    }

    async runTransaction(sessionId:string,llmMessages:LLMMessage[]){
        await this.messageRepository.insertMultipleMessages(sessionId,llmMessages);
    
    }

    async deleteSession(sessionId:string,userId:string){
        await this.sessionRepository.deleteSession(sessionId,userId)
    }

    // Favourite chats, shown under "Pinned" in the sidebar.
    async setPinned(sessionId: string, userId: string, pinned: boolean) {
        return this.sessionRepository.setPinned(sessionId, userId, pinned);
    }

    async countPinned(userId: string) {
        return this.sessionRepository.countPinned(userId);
    }

    async loadMessages(sessionId:string):Promise<LLMMessage[]>{
        const messages=await this.messageRepository.getSessionMessages(sessionId)
        return messages
    }

    

}