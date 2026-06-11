import { config } from '../shared/config.ts';
import type { Capabilities } from '../shared/types.ts';
import type { Queryable } from './driver.ts';

async function extensionInstalled(db: Queryable, name: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM pg_extension WHERE extname = $1', [name]);
  return rows.length > 0;
}

export async function detectCapabilities(db: Queryable, kind: 'postgres' | 'pglite'): Promise<Capabilities> {
  if (!(await extensionInstalled(db, 'vector'))) {
    throw new Error('pgvector extension is required. Run migrations against a database with pgvector available.');
  }
  const pgroonga = config.pgroongaEnabled && (await extensionInstalled(db, 'pgroonga'));
  return {
    database: kind === 'postgres' ? 'postgresql' : 'pglite',
    vector: true,
    full_text: { enabled: pgroonga, provider: pgroonga ? 'pgroonga' : null },
    llm: { enabled: true, provider: config.llmProvider, model: config.llmModel || null },
    embeddings: {
      enabled: true,
      provider: config.embeddingProvider,
      model: config.embeddingModel,
      dimension: config.embeddingDimension
    }
  };
}
