// import { SessionRepository } from "../authentication/sessiopn_repository";
// import { IDatabaseAdapter } from "../database/idatabaseadapter";
// import { ILLM } from "../types/llm_message";



// export class AppState {
//     private static instance: AppState;
//     private _currentSessionId: string | null = null;
//     private sessionRepo: SessionRepository;
//     private db:IDatabaseAdapter
//     public activeLLM: ILLM | null = null; 
//     private constructor(db:IDatabaseAdapter) {
//         this.db=db;
//         this.sessionRepo = new SessionRepository(this.db);
//     }

//     static getInstance() {
//         if (!AppState.instance) {
//             AppState.instance = new AppState(this.db);
//         }
//         return AppState.instance;
//     }

//     get currentSessionId(): string | null {
//         return this._currentSessionId;
//     }

//     set currentSessionId(session_id: string) {
//         this._currentSessionId = session_id;

//     }

//     async createNewSession() {
//         const session = await this.sessionRepo.newSession();
//         this._currentSessionId = session.id;
//         return this._currentSessionId;

//     }

//     async switchSession(id: string) {
//         const session = await this.sessionRepo.getSession(id);
//         if (!session) throw new Error(`Session ${id} not found`);
//         this._currentSessionId = session.id;


//     }

//     clearSession(): void {
//         this._currentSessionId = null;
//     }
// }