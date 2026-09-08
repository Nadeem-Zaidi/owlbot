
export interface DatabaseConfig{
    host:string;
    port :number;
    database:string;
    username:string;
    password:string;
    ssl?:boolean;
    connectionTimeout?:number;
    maxConnections?:number;
}

export interface QueryResult<T=any>{
    rows:T[];
    rowCount:number;
    fields?:string[];
}

export interface IDatabaseAdapter{
    connect():Promise<void>;
    disconnect():Promise<void>;
    isInTransaction(): boolean;
    query<T=any>(sql:string,params?:any[]):Promise<QueryResult<T>>;
    beginTransaction():Promise<void>;
    commit():Promise<void>
    rollback():Promise<void>;
    withTransaction<T>(callback: () => Promise<T>, isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'
    ): Promise<T>
    executeTransactionQueries<T = any>(queries: Array<{ sql: string; params?: any[] }>,isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE'
    ): Promise<QueryResult<T>[]>
    getTransactionClient():any
    isConnected():boolean;
    getType():string;

}