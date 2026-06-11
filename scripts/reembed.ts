// Regenerates all embeddings with the currently configured provider/model:
//   npm run reembed
//
// Use this after switching EMBEDDING_MODEL (vectors from different models are
// not comparable). The vector dimension must stay the same; changing
// EMBEDDING_DIMENSION requires a fresh database (the migration guard will
// explain this on boot).
import { createAppContext } from '../packages/core/bootstrap.ts';
import { rebuildSearchDocument } from '../packages/core/personService.ts';
import { config } from '../packages/shared/config.ts';
import { chunk } from '../packages/shared/utils.ts';

const ctx = await createAppContext();
const tenant = config.tenantId;
const BATCH = 50;

async function* pages<T>(fetch: (limit: number, offset: number) => Promise<T[]>): AsyncGenerator<T[]> {
  for (let offset = 0; ; offset += BATCH) {
    const rows = await fetch(BATCH, offset);
    if (!rows.length) return;
    yield rows;
  }
}

let profiles = 0;
for await (const rows of pages((limit, offset) =>
  ctx.store.find('person_profiles', { tenant_id: tenant }, { orderBy: 'person_id', dir: 'asc', limit, offset })
)) {
  const targets = rows.filter((row) => row.profile_text || row.short_bio);
  for (const batch of chunk(targets, BATCH)) {
    const vectors = await ctx.embeddings.embed(batch.map((row) => `${row.short_bio ?? ''}\n${row.profile_text ?? ''}`));
    await Promise.all(batch.map((row, index) => ctx.store.update('person_profiles', row.person_id, { profile_embedding: vectors[index] })));
    profiles += batch.length;
  }
}
console.log(`re-embedded ${profiles} profiles`);

let contexts = 0;
for await (const rows of pages((limit, offset) =>
  ctx.store.find('person_contexts', { tenant_id: tenant }, { orderBy: 'id', dir: 'asc', limit, offset })
)) {
  const targets = rows.filter((row) => row.context_text);
  for (const batch of chunk(targets, BATCH)) {
    const vectors = await ctx.embeddings.embed(batch.map((row) => row.context_text ?? ''));
    await Promise.all(batch.map((row, index) => ctx.store.update('person_contexts', row.id, { context_embedding: vectors[index] })));
    contexts += batch.length;
  }
}
console.log(`re-embedded ${contexts} contexts`);

let summaries = 0;
for await (const rows of pages((limit, offset) =>
  ctx.store.find('person_summaries', { tenant_id: tenant }, { orderBy: 'id', dir: 'asc', limit, offset })
)) {
  for (const batch of chunk(rows, BATCH)) {
    const vectors = await ctx.embeddings.embed(batch.map((row) => row.summary_text));
    await Promise.all(batch.map((row, index) => ctx.store.update('person_summaries', row.id, { summary_embedding: vectors[index] })));
    summaries += batch.length;
  }
}
console.log(`re-embedded ${summaries} summaries`);

let docs = 0;
for await (const rows of pages((limit, offset) =>
  ctx.store.find('persons', { tenant_id: tenant, status: 'active' }, { orderBy: 'created_at', dir: 'asc', limit, offset })
)) {
  for (const person of rows) {
    await rebuildSearchDocument(ctx, tenant, person.id);
    docs += 1;
  }
}
console.log(`rebuilt ${docs} search documents`);

await ctx.store.close();
console.log(`done (provider=${ctx.embeddings.name}, model=${config.embeddingModel}, dimension=${ctx.embeddings.dimension})`);
