import { describe, expect, it } from 'vitest';
import { parseQuery } from '../packages/search/parser.ts';
import { ApiError } from '../packages/shared/errors.ts';
import { failingLlm, sequenceLlm, stubLlm } from './fixtures/providers.ts';

const FOLLOWER_DSL = {
  target: 'person',
  filters: [{ field: 'core.sns.instagram.follower_count', op: 'gte', value: 1_000_000 }],
  semantic: [{ fields: ['core.search_document'], query: '環境保全の文脈で最近話題' }],
  time_range: { field: 'person_contexts.occurred_at', relative: 'recent_90d' },
  ranking: ['semantic_similarity', 'sns_reach', 'recent_relevance']
};

describe('parseQuery (LLM query planning)', () => {
  it('validates and returns the LLM-produced DSL', async () => {
    const result = await parseQuery(stubLlm({ dsl: FOLLOWER_DSL }), 'Instagramフォロワー100万人以上で環境保全の人物');
    expect(result.parser).toBe('stub');
    expect(result.dsl.filters[0]).toMatchObject({ field: 'core.sns.instagram.follower_count', op: 'gte', value: 1_000_000 });
    expect(result.dsl.time_range?.relative).toBe('recent_90d');
  });

  it('retries once when the first DSL is invalid', async () => {
    const llm = sequenceLlm([{ filters: [{ field: 'core.person.no_such', op: 'eq', value: 1 }] }, FOLLOWER_DSL]);
    const result = await parseQuery(llm, 'クエリ');
    expect(result.dsl.filters).toHaveLength(1);
  });

  it('fails explicitly when the LLM keeps producing invalid DSL', async () => {
    const llm = stubLlm({ dsl: { filters: [{ field: 'custom.unknown_field', op: 'eq', value: 1 }] } });
    await expect(parseQuery(llm, 'クエリ')).rejects.toMatchObject({ code: 'LLM_PARSE_FAILED', status: 502 });
  });

  it('fails explicitly when the provider errors (no silent fallback)', async () => {
    const error = await parseQuery(failingLlm('rate limited'), 'クエリ').catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.message).toContain('rate limited');
  });
});
