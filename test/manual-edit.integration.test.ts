import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../packages/core/context.ts';
import {
  createRelationship,
  deleteContext,
  deleteRelationship,
  listRelationships,
  updateContext
} from '../packages/core/contextService.ts';
import { drainQueue } from '../packages/core/jobService.ts';
import { createPerson, deleteAlias, deleteSnsAccount, updateSnsAccount } from '../packages/core/personService.ts';
import { ingestSource, reprocessSource } from '../packages/core/sourceService.ts';
import { config } from '../packages/shared/config.ts';
import type { HydratedPerson } from '../packages/shared/types.ts';
import { createStore } from '../packages/store/sqlStore.ts';
import { stubEmbeddings, stubLlm } from './fixtures/providers.ts';

const silentLog = { info() {}, warn() {}, error() {} };
let ctx: AppContext;
let personA: HydratedPerson;
let personB: HydratedPerson;
const tenant = config.tenantId;

beforeAll(async () => {
  const store = await createStore({ provider: 'pglite', pgliteDataDir: null });
  ctx = {
    store,
    embeddings: stubEmbeddings(config.embeddingDimension),
    llm: stubLlm({
      mentions: [{ mention: '山田太郎', confidence: 0.9 }],
      contexts: [
        {
          person: '山田太郎',
          role: 'main_subject',
          context_text: '山田太郎が新作映画の主演に決定した。',
          context_tags: ['movie'],
          sentiment: 'positive',
          importance: 0.8,
          evidence_text: '新作映画の主演に決定'
        }
      ],
      summary: { summary_text: '映画出演が話題の人物。', summary_tags: ['movie'] }
    }),
    log: silentLog
  };
  personA = await createPerson(ctx, tenant, {
    canonical_name: '山田太郎',
    person_type: 'actor',
    aliases: ['やまだ'],
    sns_accounts: [{ platform: 'instagram', handle: 'yamada_taro', follower_count: 1000 }]
  } as Parameters<typeof createPerson>[2]);
  personB = await createPerson(ctx, tenant, { canonical_name: '山田次郎', person_type: 'actor' } as Parameters<typeof createPerson>[2]);
});

afterAll(async () => {
  await ctx.store.close();
});

async function ingestAndProcess(url: string) {
  const result = await ingestSource(ctx, tenant, {
    source_type: 'news',
    title: '山田太郎、新作映画に主演',
    body: '山田太郎が新作映画の主演に決定した。',
    url,
    language: 'ja'
  } as Parameters<typeof ingestSource>[2]);
  await drainQueue(ctx);
  return result.source_id;
}

describe('manual corrections', () => {
  it('edits a context, survives reprocessing, and reassignment excludes the old person', async () => {
    const sourceId = await ingestAndProcess('https://example.com/manual/1');
    const [context] = await ctx.store.find('person_contexts', { tenant_id: tenant, source_id: sourceId });
    expect(context?.person_id).toBe(personA.id);

    // edit text/tags -> flagged as manually edited
    const edited = await updateContext(ctx, tenant, context!.id, { context_text: '修正済みの説明文。', context_tags: ['edited'] });
    expect(edited.metadata.manually_edited).toBe(true);
    expect(edited.context_text).toBe('修正済みの説明文。');

    // reprocess keeps the manual edit instead of regenerating it
    await reprocessSource(ctx, tenant, sourceId);
    await drainQueue(ctx);
    const afterReprocess = await ctx.store.find('person_contexts', { tenant_id: tenant, source_id: sourceId });
    expect(afterReprocess).toHaveLength(1);
    expect(afterReprocess[0]?.context_text).toBe('修正済みの説明文。');

    // reassign to B -> A is excluded from this source even after reprocess
    await updateContext(ctx, tenant, context!.id, { person_id: personB.id });
    const source = await ctx.store.get('source_documents', sourceId);
    expect(source?.metadata.excluded_person_ids).toContain(personA.id);

    await reprocessSource(ctx, tenant, sourceId);
    await drainQueue(ctx);
    const finalContexts = await ctx.store.find('person_contexts', { tenant_id: tenant, source_id: sourceId });
    expect(finalContexts).toHaveLength(1);
    expect(finalContexts[0]?.person_id).toBe(personB.id);
    expect(finalContexts[0]?.context_text).toBe('修正済みの説明文。');
  });

  it('deletes a context with exclude_person so reprocessing does not recreate it', async () => {
    const sourceId = await ingestAndProcess('https://example.com/manual/2');
    const [context] = await ctx.store.find('person_contexts', { tenant_id: tenant, source_id: sourceId });
    await deleteContext(ctx, tenant, context!.id, { excludePerson: true });

    await reprocessSource(ctx, tenant, sourceId);
    await drainQueue(ctx);
    expect(await ctx.store.find('person_contexts', { tenant_id: tenant, source_id: sourceId })).toHaveLength(0);
  });

  it('deletes aliases but protects the canonical name alias', async () => {
    const aliases = await ctx.store.find('person_aliases', { tenant_id: tenant, person_id: personA.id });
    const nickname = aliases.find((alias) => alias.alias === 'やまだ');
    const canonical = aliases.find((alias) => alias.alias === '山田太郎');
    await expect(deleteAlias(ctx, tenant, personA.id, canonical!.id)).rejects.toMatchObject({ status: 400 });
    await deleteAlias(ctx, tenant, personA.id, nickname!.id);
    const remaining = await ctx.store.find('person_aliases', { tenant_id: tenant, person_id: personA.id });
    expect(remaining.some((alias) => alias.alias === 'やまだ')).toBe(false);
  });

  it('updates and deletes SNS accounts (metrics removed with the account)', async () => {
    const [account] = await ctx.store.find('person_sns_accounts', { tenant_id: tenant, person_id: personA.id });
    const updated = await updateSnsAccount(ctx, tenant, personA.id, account!.id, { handle: 'yamada_official', status: 'inactive' });
    expect(updated.handle).toBe('yamada_official');
    expect(updated.status).toBe('inactive');

    await deleteSnsAccount(ctx, tenant, personA.id, account!.id);
    expect(await ctx.store.find('person_sns_accounts', { tenant_id: tenant, person_id: personA.id })).toHaveLength(0);
    expect(await ctx.store.find('person_sns_metrics', { tenant_id: tenant, account_id: account!.id })).toHaveLength(0);
  });

  it('manages group membership through relationships', async () => {
    const group = await createPerson(ctx, tenant, { canonical_name: 'ふたつぼし', person_type: 'group' } as Parameters<
      typeof createPerson
    >[2]);
    const membership = await createRelationship(ctx, tenant, personA.id, {
      related_person_id: group.id,
      relationship_type: 'member_of',
      metadata: { role: '原作' }
    });
    // duplicates collapse to the existing row
    const again = await createRelationship(ctx, tenant, personA.id, { related_person_id: group.id, relationship_type: 'member_of' });
    expect(again.id).toBe(membership.id);
    // self-relations are rejected
    await expect(
      createRelationship(ctx, tenant, personA.id, { related_person_id: personA.id, relationship_type: 'member_of' })
    ).rejects.toMatchObject({ status: 400 });

    const fromMember = await listRelationships(ctx, tenant, personA.id);
    expect(fromMember.find((rel) => rel.direction === 'outgoing')?.other_person_name).toBe('ふたつぼし');
    const fromGroup = await listRelationships(ctx, tenant, group.id);
    const incoming = fromGroup.find((rel) => rel.direction === 'incoming');
    expect(incoming?.other_person_name).toBe('山田太郎');
    expect(incoming?.metadata.role).toBe('原作');

    await deleteRelationship(ctx, tenant, membership.id);
    expect(await listRelationships(ctx, tenant, group.id)).toHaveLength(0);
  });
});
