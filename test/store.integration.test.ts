import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../packages/core/context.ts';
import { drainQueue } from '../packages/core/jobService.ts';
import { createPerson } from '../packages/core/personService.ts';
import { createField, createSchema } from '../packages/core/schemaService.ts';
import { searchPersons } from '../packages/core/searchService.ts';
import { ingestSource } from '../packages/core/sourceService.ts';
import { config } from '../packages/shared/config.ts';
import { createStore } from '../packages/store/sqlStore.ts';
import { stubEmbeddings, stubLlm } from './fixtures/providers.ts';

const silentLog = { info() {}, warn() {}, error() {} };
let ctx: AppContext;
const tenant = config.tenantId;

const SEARCH_DSL = {
  filters: [{ field: 'core.sns.instagram.follower_count', op: 'gte', value: 1_000_000 }],
  semantic: [{ fields: ['core.search_document'], query: '環境保全 アンバサダー' }],
  time_range: { field: 'person_contexts.occurred_at', relative: 'recent_90d' },
  ranking: ['semantic_similarity', 'sns_reach', 'recent_relevance']
};

beforeAll(async () => {
  const store = await createStore({ provider: 'pglite', pgliteDataDir: null });
  ctx = {
    store,
    embeddings: stubEmbeddings(config.embeddingDimension),
    llm: stubLlm({
      mentions: [{ mention: '燕谷千尋', confidence: 0.95 }],
      contexts: [
        {
          person: '燕谷千尋',
          role: 'main_subject',
          context_text: '燕谷千尋が海岸清掃ボランティアに参加し、環境保全プロジェクトのアンバサダーに就任した。',
          context_tags: ['environment', 'ambassador'],
          sentiment: 'positive',
          importance: 0.9,
          evidence_text: '海岸清掃ボランティアに参加し、アンバサダーに就任'
        }
      ],
      summary: { summary_text: '環境保全活動に積極的に取り組む俳優。アンバサダー就任が話題。', summary_tags: ['environment'] },
      fields: [{ field_key: 'height_cm', value: 182, confidence: 0.9 }],
      dsl: SEARCH_DSL
    }),
    log: silentLog
  };
});

afterAll(async () => {
  await ctx.store.close();
});

describe('SqlStore on in-memory PGlite', () => {
  it('reports capabilities (vector on, full-text off)', async () => {
    const capabilities = await ctx.store.capabilities();
    expect(capabilities.vector).toBe(true);
    expect(capabilities.full_text.enabled).toBe(false);
  });

  it('runs the full vertical: schema -> person -> source -> pipeline -> hybrid search', async () => {
    const schema = await createSchema(ctx, tenant, { key: 'talent', name: 'Talent', target_entity: 'person' });
    await createField(ctx, tenant, schema.id, {
      key: 'height_cm',
      label: '身長(cm)',
      type: 'number',
      filterable: true,
      searchable: true,
      extraction_hints: { prompt: '身長をcm単位の数値で抽出する' }
    } as Parameters<typeof createField>[3]);

    const person = await createPerson(ctx, tenant, {
      canonical_name: '燕谷千尋',
      person_type: 'actor',
      aliases: ['Tsubametani Chihiro'],
      profile: { short_bio: '俳優・モデル。環境保全活動にも関心がある。' },
      sns_accounts: [{ platform: 'instagram', handle: 'chihiro_tsubametani', follower_count: 1_200_000 }]
    } as Parameters<typeof createPerson>[2]);
    expect(person.aliases.length).toBe(2);
    expect(person.sns_accounts[0]?.latest_metric?.follower_count).toBe(1_200_000);

    const ingest = await ingestSource(ctx, tenant, {
      source_type: 'news',
      title: '燕谷千尋、環境保全プロジェクトのアンバサダーに就任',
      body: '燕谷千尋が海岸清掃ボランティアに参加し、アンバサダーに就任。身長182cmの長身を生かす。',
      url: 'https://example.com/news/1',
      published_at: new Date().toISOString(),
      language: 'ja',
      target_person_ids: [person.id]
    } as Parameters<typeof ingestSource>[2]);
    expect(ingest.duplicate).toBe(false);
    expect(ingest.jobs).toHaveLength(1);

    const processed = await drainQueue(ctx);
    expect(processed).toBe(1);
    const source = await ctx.store.get('source_documents', ingest.source_id);
    expect(source?.processing_status).toBe('processed');

    // pipeline outputs (from the LLM extraction, schema-validated)
    const contexts = await ctx.store.find('person_contexts', { tenant_id: tenant, person_id: person.id });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.context_tags).toContain('environment');
    expect(contexts[0]?.role).toBe('main_subject');
    const summaries = await ctx.store.find('person_summaries', { tenant_id: tenant, person_id: person.id });
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    const doc = await ctx.store.get('person_search_documents', person.id);
    expect(doc?.searchable_text).toContain('燕谷千尋');

    // LLM-extracted field applied automatically (no prior value, conf 0.9 >= 0.8)
    const fieldCandidates = await ctx.store.find('extracted_field_candidates', { tenant_id: tenant, person_id: person.id });
    expect(fieldCandidates[0]?.status).toBe('auto_applied');
    const values = await ctx.store.find('person_field_values', { tenant_id: tenant, person_id: person.id });
    expect(values[0]?.value_number).toBe(182);

    // natural-language search goes through LLM planning -> validated DSL -> DB
    const result = await searchPersons(ctx, tenant, { query: 'Instagramフォロワー100万人以上で環境保全の文脈で最近話題の人物' });
    expect(result.results[0]?.person_id).toBe(person.id);
    expect(result.results[0]?.matched_reasons.join(' ')).toContain('follower_count');
    expect(result.results[0]?.matched_contexts.length).toBeGreaterThanOrEqual(1);

    // custom field DSL filter
    const byHeight = await searchPersons(ctx, tenant, {
      dsl: { filters: [{ field: 'custom.height_cm', op: 'between', value: [180, 190] }] }
    });
    expect(byHeight.results.some((r) => r.person_id === person.id)).toBe(true);
    const tooTall = await searchPersons(ctx, tenant, { dsl: { filters: [{ field: 'custom.height_cm', op: 'gte', value: 190 }] } });
    expect(tooTall.results.some((r) => r.person_id === person.id)).toBe(false);
  });

  it('deduplicates and versions sources (idempotency / url versioning)', async () => {
    const base = {
      source_type: 'news',
      title: 'v1',
      body: 'first body',
      url: 'https://example.com/versioned',
      idempotency_key: 'dedup-test'
    } as Parameters<typeof ingestSource>[2];
    const first = await ingestSource(ctx, tenant, base);
    expect(first.duplicate).toBe(false);
    const same = await ingestSource(ctx, tenant, base);
    expect(same.duplicate).toBe(true);
    expect(same.source_id).toBe(first.source_id);

    const updated = await ingestSource(ctx, tenant, { ...base, body: 'updated body' });
    expect(updated.duplicate).toBe(false);
    expect(updated.source_id).toBe(first.source_id);
    expect(updated.version).toBe(2);
    const versions = await ctx.store.find('source_document_versions', { tenant_id: tenant, source_id: first.source_id });
    expect(versions).toHaveLength(2);

    const differentUrl = await ingestSource(ctx, tenant, {
      ...base,
      body: 'updated body',
      url: 'https://example.com/other',
      idempotency_key: undefined
    });
    expect(differentUrl.source_id).not.toBe(first.source_id);
    const flagged = await ctx.store.get('source_documents', differentUrl.source_id);
    expect(flagged?.metadata.possible_duplicate_of).toBe(first.source_id);
    await drainQueue(ctx);
  });

  it('claims jobs exclusively and leaves none behind', async () => {
    const job = await ctx.store.insert('processing_jobs', {
      id: crypto.randomUUID(),
      tenant_id: tenant,
      source_id: null,
      job_type: 'document_processing',
      status: 'queued',
      priority: 5,
      attempts: 0,
      error_message: null,
      scheduled_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      metadata: {},
      created_at: new Date().toISOString()
    });
    const claimed = await ctx.store.claimNextJob();
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe('running');
    expect(await ctx.store.claimNextJob()).toBeNull();
    await ctx.store.update('processing_jobs', job.id, { status: 'cancelled', finished_at: new Date().toISOString() });
  });

  it('filters by core fields, sns metrics, tags and time range', async () => {
    const ids = await ctx.store.filterPersonIds(
      tenant,
      [
        { field: 'core.person.person_type', op: 'eq', value: 'actor', resolved: { kind: 'core', operators: ['eq'] } },
        {
          field: 'core.sns.instagram.follower_count',
          op: 'gte',
          value: 1_000_000,
          resolved: { kind: 'sns_metric', platform: 'instagram', metric: 'follower_count', operators: ['gte'] }
        },
        { field: 'core.context.context_tags', op: 'contains', value: 'environment', resolved: { kind: 'core', operators: ['contains'] } },
        {
          field: 'core.sns.instagram',
          op: 'exists',
          value: null,
          resolved: { kind: 'sns_account', platform: 'instagram', operators: ['exists'] }
        }
      ],
      { field: 'person_contexts.occurred_at', relative: 'recent_7d' }
    );
    expect(ids?.length).toBe(1);
    const none = await ctx.store.filterPersonIds(
      tenant,
      [{ field: 'core.person.person_type', op: 'eq', value: 'politician', resolved: { kind: 'core', operators: ['eq'] } }],
      null
    );
    expect(none).toEqual([]);
    const unconstrained = await ctx.store.filterPersonIds(tenant, [], null);
    expect(unconstrained).toBeNull();
  });
});
