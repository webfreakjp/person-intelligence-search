import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import pg from 'pg';
import { config } from '../shared/config.ts';

export interface QueryResultLike<R> {
  rows: R[];
  rowCount?: number | null;
}

export interface Queryable {
  // biome-ignore lint/suspicious/noExplicitAny: row shape is asserted by callers
  query<R = any>(sql: string, params?: unknown[]): Promise<QueryResultLike<R>>;
  /** Runs multi-statement SQL (migrations). No parameters, no result rows. */
  exec(sql: string): Promise<void>;
}

export interface DbDriver extends Queryable {
  kind: 'postgres' | 'pglite';
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// numeric / int8 -> Number, date -> 'YYYY-MM-DD' string: keeps API output
// JSON-friendly and identical across drivers.
pg.types.setTypeParser(1700, (value) => (value == null ? null : Number(value)));
pg.types.setTypeParser(20, (value) => (value == null ? null : Number(value)));
pg.types.setTypeParser(1082, (value) => value);

class PostgresDriver implements DbDriver {
  readonly kind = 'postgres' as const;
  private pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    this.pool.on('error', (error) => console.error('[db] idle client error', error.message));
  }

  // biome-ignore lint/suspicious/noExplicitAny: see Queryable
  async query<R = any>(sql: string, params: unknown[] = []): Promise<QueryResultLike<R>> {
    const result = await this.pool.query(sql, params);
    return { rows: result.rows as R[], rowCount: result.rowCount };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: Queryable = {
      query: async <R>(sql: string, params: unknown[] = []) => {
        const res = await client.query(sql, params);
        return { rows: res.rows as R[], rowCount: res.rowCount };
      },
      exec: async (sql: string) => {
        await client.query(sql);
      }
    };
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PgliteDriver implements DbDriver {
  readonly kind = 'pglite' as const;
  private db: PGlite;

  constructor(dataDir?: string) {
    // PGlite ignores the options argument when the first argument is not a
    // string, so the in-memory form must pass options first.
    this.db = dataDir ? new PGlite(dataDir, { extensions: { vector } }) : new PGlite({ extensions: { vector } });
  }

  // biome-ignore lint/suspicious/noExplicitAny: see Queryable
  async query<R = any>(sql: string, params: unknown[] = []): Promise<QueryResultLike<R>> {
    const result = await this.db.query<R>(sql, params as never[]);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction(async (pgliteTx) => {
      const tx: Queryable = {
        query: async <R>(sql: string, params: unknown[] = []) => {
          const result = await pgliteTx.query<R>(sql, params as never[]);
          return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        },
        exec: async (sql: string) => {
          await pgliteTx.exec(sql);
        }
      };
      return fn(tx);
    }) as Promise<T>;
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

export async function createDriver(
  options: { provider?: 'postgres' | 'pglite'; databaseUrl?: string; pgliteDataDir?: string | null } = {}
): Promise<DbDriver> {
  const provider = options.provider ?? config.storeProvider;
  if (provider === 'postgres') return new PostgresDriver(options.databaseUrl ?? config.databaseUrl);
  const dataDir = options.pgliteDataDir === null ? undefined : (options.pgliteDataDir ?? config.pgliteDataDir);
  if (dataDir) await mkdir(dataDir, { recursive: true });
  return new PgliteDriver(dataDir);
}
