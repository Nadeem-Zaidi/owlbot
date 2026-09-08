import { PostgreSQLAdapter } from "./db_adapters/postgreadapter";
import { DatabaseConfig, IDatabaseAdapter } from "./idatabaseadapter";


export enum DatabaseType{
    MySQL='mysql',
    PostgreSQL='postgresql',
    Oracle='oracle',
    SQLLite='sqllite'
}

export class DatabaseFactory{
    static createAdapter(type:DatabaseType,config:DatabaseConfig){
        switch(type){
            case DatabaseType.PostgreSQL:
                return new PostgreSQLAdapter(config);
            
            default:
                throw new Error(`Unsupported database type :${type}`);
        }
    }
    static async createAndConnect(type:DatabaseType,config:DatabaseConfig):Promise<IDatabaseAdapter>{
        const adapter=DatabaseFactory.createAdapter(type,config);
        await adapter.connect();
        return adapter;


    }
}