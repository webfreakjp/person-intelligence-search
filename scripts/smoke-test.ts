// End-to-end smoke test against a running API (PGlite or PostgreSQL mode):
//   PORT=3001 npm start            # terminal 1
//   SMOKE_BASE_URL=http://127.0.0.1:3001 npm run smoke
const baseUrl = process.env.SMOKE_BASE_URL ?? 'http://127.0.0.1:3000';
const apiKey = process.env.API_KEY ?? '';

async function api<T = Record<string, unknown>>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
    ...options
  });
  const data = (await response.json()) as T;
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`SMOKE FAILED: ${message}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. health & capabilities
const health = await api<{ ok: boolean; capabilities: { vector: boolean; full_text: { enabled: boolean } } }>('/v1/health');
assert(health.ok, 'health should be ok');
assert(health.capabilities.vector, 'vector capability is required');

// 2. validation error shape
const invalid = await fetch(`${baseUrl}/v1/persons`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
  body: JSON.stringify({})
});
assert(invalid.status === 400, `invalid person should return 400 (got ${invalid.status})`);
const invalidBody = (await invalid.json()) as { error?: { code?: string } };
assert(invalidBody.error?.code === 'VALIDATION_ERROR', 'should return VALIDATION_ERROR');

// 3. schema + custom field
const suffix = Date.now();
const schema = await api<{ id: string }>('/v1/schemas', {
  method: 'POST',
  body: JSON.stringify({ key: `smoke_${suffix}`, name: `Smoke Schema ${suffix}` })
});
const heightField = await api<{ id: string }>(`/v1/schemas/${schema.id}/fields`, {
  method: 'POST',
  body: JSON.stringify({
    key: `height_cm_${suffix}`,
    label: '身長(cm)',
    type: 'number',
    filterable: true,
    searchable: true,
    extraction_hints: { prompt: '身長をcm単位の整数で抽出する' }
  })
});
assert(heightField.id, 'field definition should be created');

// 4. person with SNS + custom field value
const person = await api<{ id: string }>('/v1/persons', {
  method: 'POST',
  body: JSON.stringify({
    canonical_name: `スモーク太郎${suffix}`,
    person_type: 'creator',
    aliases: [`smoke_taro_${suffix}`],
    profile: { short_bio: '環境保全について発信するクリエイター。' },
    sns_accounts: [{ platform: 'instagram', handle: `smoke_${suffix}`, follower_count: 1_500_000 }]
  })
});
assert(person.id, 'person id should be returned');
await api(`/v1/persons/${person.id}/fields`, {
  method: 'PATCH',
  body: JSON.stringify({ values: [{ field_key: `height_cm_${suffix}`, value: 182 }] })
});

// 5. source ingestion -> async processing
const source = await api<{ source_id: string; jobs: Array<{ job_id: string }> }>('/v1/sources', {
  method: 'POST',
  body: JSON.stringify({
    source_type: 'news',
    title: `スモーク太郎${suffix}、環境保全イベントに登壇`,
    body: `スモーク太郎${suffix}が環境保全イベントでアンバサダーとして登壇。身長182cmの長身を生かしたパフォーマンスも披露した。`,
    url: `https://example.com/smoke/${suffix}`,
    published_at: new Date().toISOString(),
    language: 'ja',
    target_person_ids: [person.id],
    idempotency_key: `smoke:${suffix}`
  })
});
assert(source.source_id, 'source id should be returned');
assert(source.jobs.length === 1, 'one processing job should be enqueued');

let processed = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  const current = await api<{ processing_status: string }>(`/v1/sources/${source.source_id}`);
  if (current.processing_status === 'processed') {
    processed = true;
    break;
  }
  assert(current.processing_status !== 'failed', 'source processing should not fail');
  await sleep(500);
}
assert(processed, 'source should be processed within 30s');

// 6. duplicate detection (same idempotency key + content)
const duplicate = await api<{ duplicate: boolean; source_id: string }>('/v1/sources', {
  method: 'POST',
  body: JSON.stringify({
    source_type: 'news',
    title: `スモーク太郎${suffix}、環境保全イベントに登壇`,
    body: `スモーク太郎${suffix}が環境保全イベントでアンバサダーとして登壇。身長182cmの長身を生かしたパフォーマンスも披露した。`,
    url: `https://example.com/smoke/${suffix}`,
    idempotency_key: `smoke:${suffix}`
  })
});
assert(duplicate.duplicate === true, 'identical source should be deduplicated');
assert(duplicate.source_id === source.source_id, 'duplicate should reference the original source');

// 7. extractions exist
const extractions = await api<{ contexts: unknown[]; mentions: unknown[] }>(`/v1/sources/${source.source_id}/extractions`);
assert(extractions.contexts.length >= 1, 'a person context should be extracted');

// 8. natural-language search (structured + semantic)
const search = await api<{
  results: Array<{ person_id: string; matched_reasons: string[]; matched_contexts: unknown[] }>;
  dsl: { filters: unknown[] };
  search_capabilities: { full_text: boolean };
}>('/v1/search/persons', {
  method: 'POST',
  body: JSON.stringify({ query: 'Instagramフォロワー100万人以上で、環境保全の文脈で最近話題になっている人物' })
});
assert(search.dsl.filters.length >= 1, 'parser should produce a follower filter');
const hit = search.results.find((result) => result.person_id === person.id);
assert(hit, 'created person should be found by hybrid search');
assert(hit.matched_reasons.length >= 1, 'matched_reasons should be present');
assert(hit.matched_contexts.length >= 1, 'matched_contexts (evidence) should be present');

// 9. custom field structured search via DSL
const fieldSearch = await api<{ results: Array<{ person_id: string }> }>('/v1/search/persons', {
  method: 'POST',
  body: JSON.stringify({
    dsl: { filters: [{ field: `custom.height_cm_${suffix}`, op: 'gte', value: 180 }] }
  })
});
assert(
  fieldSearch.results.some((result) => result.person_id === person.id),
  'custom field filter should match the person'
);

// 10. invalid DSL is rejected
const badDsl = await fetch(`${baseUrl}/v1/search/persons`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
  body: JSON.stringify({ dsl: { filters: [{ field: 'core.person.no_such_field', op: 'eq', value: 1 }] } })
});
assert(badDsl.status === 400, 'invalid DSL should be rejected with 400');

console.log(
  JSON.stringify(
    {
      ok: true,
      baseUrl,
      store: (health as { store?: string }).store,
      person_id: person.id,
      source_id: source.source_id,
      results: search.results.length
    },
    null,
    2
  )
);
