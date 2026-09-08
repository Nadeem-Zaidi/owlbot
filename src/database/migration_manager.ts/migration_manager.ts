
import { Migration, MigrationRecord, MigrationResult, MigrationStatus } from "../../types/type";
import { IDatabaseAdapter } from "../idatabaseadapter";


export class MigrationManager {
  private tableName = 'schema_migrations';

  constructor(private db: IDatabaseAdapter) {}

  /**
   * Initialize the migrations table
   */
  async initialize(): Promise<void> {
    const dbType = this.db.getType();
    
    let createTableSQL: string;
    
    if (dbType === 'MySQL') {
      createTableSQL = `
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id INT AUTO_INCREMENT PRIMARY KEY,
          version VARCHAR(14) NOT NULL UNIQUE,
          description VARCHAR(255) NOT NULL,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          execution_time_ms INT NOT NULL,
          INDEX idx_version (version)
        )
      `;
    } else if (dbType === 'PostgreSQL') {
      createTableSQL = `
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id SERIAL PRIMARY KEY,
          version VARCHAR(14) NOT NULL UNIQUE,
          description VARCHAR(255) NOT NULL,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          execution_time_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_version ON ${this.tableName}(version);
      `;
    } else if (dbType === 'Oracle') {
      createTableSQL = `
        BEGIN
          EXECUTE IMMEDIATE 'CREATE TABLE ${this.tableName} (
            id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            version VARCHAR2(14) NOT NULL UNIQUE,
            description VARCHAR2(255) NOT NULL,
            applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            execution_time_ms NUMBER NOT NULL
          )';
        EXCEPTION
          WHEN OTHERS THEN
            IF SQLCODE != -955 THEN
              RAISE;
            END IF;
        END;
      `;
    } else {
      throw new Error(`Unsupported database type: ${dbType}`);
    }

    await this.db.query(createTableSQL);
    console.log('✅ Migrations table initialized');
  }

  /**
   * Get all applied migrations
   */
  async getAppliedMigrations(): Promise<MigrationRecord[]> {
    const result = await this.db.query<MigrationRecord>(
      `SELECT * FROM ${this.tableName} ORDER BY version ASC`
    );
    return result.rows;
  }

  /**
   * Get the current migration version
   */
  async getCurrentVersion(): Promise<string | null> {
    const dbType = this.db.getType();
    
    // PostgreSQL and MySQL use LIMIT, Oracle uses FETCH FIRST
    const limitClause = dbType === 'Oracle' 
      ? 'FETCH FIRST 1 ROWS ONLY' 
      : 'LIMIT 1';
    
    const result = await this.db.query<MigrationRecord>(
      `SELECT version FROM ${this.tableName} ORDER BY version DESC ${limitClause}`
    );
    return result.rows.length > 0 ? result.rows[0].version : null;
  }

  /**
   * Check if a migration has been applied
   */
  async isMigrationApplied(version: string): Promise<boolean> {
    const dbType = this.db.getType();
    
    // FIXED: Use correct placeholder syntax for each database
    let placeholder: string;
    if (dbType === 'Oracle') {
      placeholder = ':1';
    } else if (dbType === 'PostgreSQL') {
      placeholder = '$1';
    } else {
      placeholder = '?';
    }
    
    const result = await this.db.query<MigrationRecord>(
      `SELECT version FROM ${this.tableName} WHERE version = ${placeholder}`,
      [version]
    );
    return result.rows.length > 0;
  }

  /**
   * Get migration status
   */
  async getStatus(migrations: Migration[]): Promise<MigrationStatus> {
    const applied = await this.getAppliedMigrations();
    const appliedVersions = new Set(applied.map(m => m.version));
    
    const pending = migrations.filter(m => !appliedVersions.has(m.version));
    const current = await this.getCurrentVersion();

    return { pending, applied, current };
  }

  /**
   * Run a single migration up
   */
  async up(migration: Migration): Promise<MigrationResult> {
    const startTime = Date.now();
    
    try {
      // Check if already applied
      if (await this.isMigrationApplied(migration.version)) {
        throw new Error(`Migration ${migration.version} has already been applied`);
      }

      await this.db.beginTransaction();

      try {
        // Execute up migration
        const sqlStatements = Array.isArray(migration.up) ? migration.up : [migration.up];
        
        for (const sql of sqlStatements) {
          if (sql.trim()) {
            console.log(`Executing: ${sql.substring(0, 80)}...`);
            await this.db.query(sql);
          }
        }

        // Record the migration
        const executionTime = Date.now() - startTime;
        const dbType = this.db.getType();
        
        // FIXED: Use correct placeholder syntax for each database
        let placeholder: string;
        if (dbType === 'Oracle') {
          placeholder = ':1, :2, :3';
        } else if (dbType === 'PostgreSQL') {
          placeholder = '$1, $2, $3';
        } else {
          placeholder = '?, ?, ?';
        }
        
        await this.db.query(
          `INSERT INTO ${this.tableName} (version, description, execution_time_ms) VALUES (${placeholder})`,
          [migration.version, migration.description, executionTime]
        );

        await this.db.commit();

        console.log(`✅ Applied migration ${migration.version}: ${migration.description}`);
        
        return {
          success: true,
          version: migration.version,
          description: migration.description,
          executionTime,
        };
      } catch (error) {
        await this.db.rollback();
        throw error;
      }
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Failed to apply migration ${migration.version}:`, errorMessage);
      
      return {
        success: false,
        version: migration.version,
        description: migration.description,
        executionTime,
        error: errorMessage,
      };
    }
  }

  /**
   * Run a single migration down
   */
  async down(migration: Migration): Promise<MigrationResult> {
    const startTime = Date.now();
    
    try {
      // Check if migration is applied
      if (!(await this.isMigrationApplied(migration.version))) {
        throw new Error(`Migration ${migration.version} has not been applied`);
      }

      await this.db.beginTransaction();

      try {
        // Execute down migration
        const sqlStatements = Array.isArray(migration.down) ? migration.down : [migration.down];
        
        for (const sql of sqlStatements) {
          if (sql.trim()) {
            console.log(`Executing rollback: ${sql.substring(0, 80)}...`);
            await this.db.query(sql);
          }
        }

        // Remove the migration record
        const dbType = this.db.getType();
        
        // FIXED: Use correct placeholder syntax for each database
        let placeholder: string;
        if (dbType === 'Oracle') {
          placeholder = ':1';
        } else if (dbType === 'PostgreSQL') {
          placeholder = '$1';
        } else {
          placeholder = '?';
        }
        
        await this.db.query(
          `DELETE FROM ${this.tableName} WHERE version = ${placeholder}`,
          [migration.version]
        );

        await this.db.commit();

        const executionTime = Date.now() - startTime;
        console.log(`✅ Rolled back migration ${migration.version}: ${migration.description}`);
        
        return {
          success: true,
          version: migration.version,
          description: migration.description,
          executionTime,
        };
      } catch (error) {
        await this.db.rollback();
        throw error;
      }
    } catch (error) {
      const executionTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ Failed to rollback migration ${migration.version}:`, errorMessage);
      
      return {
        success: false,
        version: migration.version,
        description: migration.description,
        executionTime,
        error: errorMessage,
      };
    }
  }

  /**
   * Run all pending migrations
   */
  async migrateUp(migrations: Migration[]): Promise<MigrationResult[]> {
    await this.initialize();
    
    const status = await this.getStatus(migrations);
    
    if (status.pending.length === 0) {
      console.log('✅ No pending migrations');
      return [];
    }

    console.log(`Running ${status.pending.length} pending migrations...`);
    
    const results: MigrationResult[] = [];
    
    for (const migration of status.pending) {
      const result = await this.up(migration);
      results.push(result);
      
      if (!result.success) {
        console.error('❌ Migration failed, stopping...');
        break;
      }
    }

    return results;
  }

  /**
   * Rollback the last N migrations
   */
  async migrateDown(migrations: Migration[], steps: number = 1): Promise<MigrationResult[]> {
    const applied = await this.getAppliedMigrations();
    
    if (applied.length === 0) {
      console.log('✅ No migrations to rollback');
      return [];
    }

    // Get the last N applied migrations
    const toRollback = applied
      .slice(-steps)
      .reverse();

    console.log(`Rolling back ${toRollback.length} migrations...`);
    
    const results: MigrationResult[] = [];
    
    for (const record of toRollback) {
      const migration = migrations.find(m => m.version === record.version);
      
      if (!migration) {
        console.error(`❌ Migration ${record.version} not found in migration files`);
        continue;
      }

      const result = await this.down(migration);
      results.push(result);
      
      if (!result.success) {
        console.error('❌ Rollback failed, stopping...');
        break;
      }
    }

    return results;
  }

  /**
   * Rollback to a specific version
   */
  async migrateTo(migrations: Migration[], targetVersion: string): Promise<MigrationResult[]> {
    const applied = await this.getAppliedMigrations();
    const current = await this.getCurrentVersion();

    if (!current) {
      console.log('No migrations applied yet');
      return [];
    }

    // Determine direction
    if (targetVersion > current) {
      // Migrate up
      const toApply = migrations.filter(
        m => m.version > current && m.version <= targetVersion
      );
      
      const results: MigrationResult[] = [];
      for (const migration of toApply) {
        const result = await this.up(migration);
        results.push(result);
        if (!result.success) break;
      }
      return results;
    } else if (targetVersion < current) {
      // Migrate down
      const toRollback = applied
        .filter(m => m.version > targetVersion)
        .reverse();
      
      const results: MigrationResult[] = [];
      for (const record of toRollback) {
        const migration = migrations.find(m => m.version === record.version);
        if (migration) {
          const result = await this.down(migration);
          results.push(result);
          if (!result.success) break;
        }
      }
      return results;
    }

    console.log(`Already at version ${targetVersion}`);
    return [];
  }

  /**
   * Reset database (rollback all migrations)
   */
  async reset(migrations: Migration[]): Promise<MigrationResult[]> {
    const applied = await this.getAppliedMigrations();
    return this.migrateDown(migrations, applied.length);
  }
}