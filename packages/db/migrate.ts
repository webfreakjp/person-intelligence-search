import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../shared/config.ts';
import type { DbDriver, Queryable } from './driver.ts';

type LogFn = (message: string) => void;

// biome-ignore-start lint/suspicious/noTemplateCurlyInString: ${...} placeholders are migration template syntax, not JS templates
function renderSql(sql: string): string {
  return sql.replaceAll('${EMBEDDING_DIMENSION}', String(config.embeddingDimension)).replaceAll('${DEFAULT_TENANT_ID}', config.tenantId);
}

async function appliedMigrations(db: Queryable): Promise<Set<string>> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations');
  return new Set(rows.map((row) => row.name));
}

async function listSqlFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort();
  } catch {
    return [];
  }
}

async function applyDir(driver: DbDriver, dir: string, prefix: string, applied: Set<string>, log: LogFn): Promise<void> {
  for (const file of await listSqlFiles(dir)) {
    const name = `${prefix}/${file}`;
    if (applied.has(name)) continue;
    const sql = renderSql(await readFile(path.join(dir, file), 'utf8'));
    log(`migrate: applying ${name}`);
    try {
      await driver.transaction(async (tx) => {
        await tx.exec(sql);
        await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      });
    } catch (error) {
      throw new Error(`Migration ${name} failed: ${(error as Error).message}`);
    }
  }
}

async function pgroongaAvailable(db: Queryable): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM pg_available_extensions WHERE name = $1', ['pgroonga']);
  return rows.length > 0;
}

// Arbitrary fixed key so concurrently booting api/worker processes serialize
// their migration runs instead of racing on schema_migrations.
const MIGRATION_LOCK_KEY = 7_245_122_001;

export async function runMigrations(driver: DbDriver, { log = console.log }: { log?: LogFn } = {}): Promise<void> {
  if (driver.kind === 'postgres') await driver.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  try {
    await runMigrationsLocked(driver, log);
  } finally {
    if (driver.kind === 'postgres') await driver.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
  }
}

async function runMigrationsLocked(driver: DbDriver, log: LogFn): Promise<void> {
  try {
    await driver.exec('CREATE EXTENSION IF NOT EXISTS vector');
  } catch (error) {
    throw new Error(
      `pgvector extension is required but could not be enabled: ${(error as Error).message}. ` +
        'Use a PostgreSQL image with pgvector installed (see docker-compose.yml).'
    );
  }
  const applied = await appliedMigrations(driver);
  await applyDir(driver, path.join(config.migrationsDir, 'core'), 'core', applied, log);

  if (config.pgroongaEnabled && (await pgroongaAvailable(driver))) {
    await applyDir(driver, path.join(config.migrationsDir, 'optional', 'pgroonga'), 'optional/pgroonga', applied, log);
  } else if (config.pgroongaEnabled && driver.kind === 'postgres') {
    log('migrate: pgroonga extension is not available; full-text search stays disabled.');
  }

  const { rows } = await driver.query<{ value: number | string }>(`SELECT value FROM platform_meta WHERE key = 'embedding_dimension'`);
  const dbDimension = rows[0] ? Number(rows[0].value) : null;
  if (dbDimension != null && dbDimension !== config.embeddingDimension) {
    throw new Error(
      `EMBEDDING_DIMENSION=${config.embeddingDimension} does not match the database (vector(${dbDimension})). ` +
        'Changing dimensions requires a new migration and embedding regeneration.'
    );
  }
}
