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
        this.messageRepository.rawDb();
    }

    async getUserSessions(userId:string):Promise<Session[]>{
        const userSessions=await this.sessionRepository.getUserSessions(userId)
        return userSessions;
    }

    async isSessionValid(sessionId:string):Promise<boolean>{
        const id =   await this.sessionRepository.getSession(sessionId)
        console.log(id)
        if(!id){
            return false
        }
        return true
    }

    async getSession(sessionId:string):Promise<Session>{
        const valid=await this.isSessionValid(sessionId);
        if(!valid){
            throw new InvalidSession();
        }
        const session=await this.sessionRepository.getSession(sessionId);
        return session;
    }



    async createSession(userId:string):Promise<Session>{
        const createdSession=await this.sessionRepository.createSession(userId);
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

    async loadMessages(sessionId:string):Promise<LLMMessage[]>{
        const messages=await this.messageRepository.getSessionMessages(sessionId)
        return messages
    }

    

}