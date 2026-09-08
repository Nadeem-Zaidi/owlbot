import { Pool, PoolClient } from "pg";
import { DatabaseConfig, IDatabaseAdapter, QueryResult } from "../idatabaseadapter";

export class PostgreSQLAdapter implements IDatabaseAdapter {
    private pool: Pool | null = null;
    private client: PoolClient | null = null;
    private config: DatabaseConfig;
    private inTransaction = false;

    constructor(config: DatabaseConfig) {
        this.config = config;
    }

    async connect(): Promise<void> {
        try {
            this.pool = new Pool({
                host: this.config.host,
                port: this.config.port,
                user: this.config.username,
                password: this.config.password,
                database: this.config.database,
                max: this.config.maxConnections || 10,
                connectionTimeoutMillis: this.config.connectionTimeout || 10000,
                ssl: this.config.ssl ? { rejectUnauthorized: false } : false,
            });

            const client = await this.pool.connect();
            await client.query("SELECT 1");
            client.release();

            console.log(`Connected to PostgreSQL database: ${this.config.database}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`PostgreSQL connection failed: ${errorMessage}`);
        }
    }

    async disconnect(): Promise<void> {
        try {
            if (this.inTransaction && this.client) {
                await this.rollback();
            }

            if (this.pool) {
                await this.pool.end();
                this.pool = null;
                this.client = null;
                this.inTransaction = false;
                console.log("Disconnected from PostgreSQL database");
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`PostgreSQL disconnection failed: ${errorMessage}`);
        }
    }

    // ─────────────────────────────────────────────
    // Query
    // ─────────────────────────────────────────────

    async query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
        if (!this.pool) {
            throw new Error("Database not connected");
        }

        try {
            const client = this.inTransaction && this.client ? this.client : this.pool;
            const result =
                params && params.length > 0
                    ? await client.query(sql, params)
                    : await client.query(sql);

            return {
                rows: result.rows as T[],
                rowCount: result.rowCount || 0,
                fields: result.fields ? result.fields.map((f) => f.name) : [],
            };
        } catch (error) {
            console.error("QUERY ERROR:", error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`PostgreSQL query failed: ${errorMessage}`);
        }
    }

    async queryOne<T = any>(sql: string, params?: any[]): Promise<T | null> {
        const result = await this.query<T>(sql, params);
        return result.rows.length > 0 ? result.rows[0] : null;
    }

   
    async beginTransaction(
        isolationLevel?: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE"
    ): Promise<void> {
        if (!this.pool) {
            throw new Error("Database not connected");
        }

        if (this.inTransaction) {
            throw new Error(
                "Already in a transaction. Nested transactions are not supported."
            );
        }

        try {
            this.client = await this.pool.connect();
            const beginSQL = isolationLevel
                ? `BEGIN ISOLATION LEVEL ${isolationLevel}`
                : "BEGIN";

            await this.client.query(beginSQL);
            this.inTransaction = true;

            console.log(
                `Transaction started${isolationLevel ? ` [${isolationLevel}]` : ""}`
            );
        } catch (error) {
            // FIX 2: if BEGIN fails after connect() succeeded, release the client
            // so it is returned to the pool and not leaked.
            if (this.client) {
                this.client.release();
                this.client = null;
            }

            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to begin transaction: ${errorMessage}`);
        }
    }

    async commit(): Promise<void> {
        if (!this.client || !this.inTransaction) {
            throw new Error("No active transaction to commit");
        }

        try {
            await this.client.query("COMMIT");
            console.log("Transaction committed");
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to commit transaction: ${errorMessage}`);
        } finally {
            // Always release the client and reset state, even if COMMIT fails.
            this.client.release();
            this.client = null;
            this.inTransaction = false;
        }
    }

    async rollback(): Promise<void> {
        if (!this.client || !this.inTransaction) {
            throw new Error("No active transaction to rollback");
        }

        try {
            await this.client.query("ROLLBACK");
            console.log("Transaction rolled back");
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to rollback transaction: ${errorMessage}`);
        } finally {
            // Always release the client and reset state, even if ROLLBACK fails.
            this.client.release();
            this.client = null;
            this.inTransaction = false;
        }
    }


    async withTransaction<T>(callback: () => Promise<T>,isolationLevel?: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE"
    ): Promise<T> {
        if (this.inTransaction) {
            throw new Error(
                "Cannot start a nested transaction. Use the existing transaction instead."
            );
        }

        await this.beginTransaction(isolationLevel);

        try {
            const result = await callback();
            await this.commit();
            return result;
        } catch (error) {
            await this.rollback();
            throw error;
        }
    }
    async executeTransactionQueries<T = any>(
        queries: Array<{ sql: string; params?: any[] }>,
        isolationLevel?: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE"
    ): Promise<QueryResult<T>[]> {
        if (queries.length === 0) {
            return [];
        }

        return this.withTransaction(async () => {
            const results: QueryResult<T>[] = [];

            for (const q of queries) {
                const result = await this.query<T>(q.sql, q.params);
                results.push(result);
            }

            return results;
        }, isolationLevel);
    }

    // ─────────────────────────────────────────────
    // Introspection helpers
    // ─────────────────────────────────────────────

    isInTransaction(): boolean {
        return this.inTransaction;
    }

    /** Returns the active PoolClient only while a transaction is open. */
    getTransactionClient(): PoolClient | null {
        return this.inTransaction ? this.client : null;
    }

    isConnected(): boolean {
        return this.pool !== null;
    }

    getType(): string {
        return "PostgreSQL";
    }
}