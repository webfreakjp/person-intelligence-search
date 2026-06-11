// Seeds demo data directly through the service layer (works for both
// STORE_PROVIDER=pglite and =postgres):  npm run seed
import './lib/disableInlineWorker.ts';
import { createAppContext } from '../packages/core/bootstrap.ts';
import { drainQueue } from '../packages/core/jobService.ts';
import { createPerson } from '../packages/core/personService.ts';
import { createField, createSchema } from '../packages/core/schemaService.ts';
import { ingestSource, type SourceCreateSchema } from '../packages/core/sourceService.ts';
import { config } from '../packages/shared/config.ts';
import type { z } from 'zod';

const ctx = await createAppContext();
const tenant = config.tenantId;

// --- schema & fields ---
let schema = await ctx.store.findOne('schemas', { tenant_id: tenant, key: 'talent_profile' });
if (!schema) {
  schema = await createSchema(ctx, tenant, { key: 'talent_profile', name: 'タレント基本情報', target_entity: 'person' });
  await createField(ctx, tenant, schema.id, {
    key: 'height_cm',
    label: '身長(cm)',
    type: 'number',
    filterable: true,
    searchable: true,
    extraction_hints: { prompt: '身長をcm単位の整数で抽出する（例: 身長182cm -> 182）' }
  } as Parameters<typeof createField>[3]);
  await createField(ctx, tenant, schema.id, {
    key: 'keywords',
    label: 'キーワード',
    type: 'tag_list',
    filterable: true,
    searchable: true,
    embedding_target: true
  } as Parameters<typeof createField>[3]);
  console.log('seeded schema talent_profile');
}

// --- persons ---
async function ensurePerson(input: Parameters<typeof createPerson>[2]) {
  const { results } = await ctx.store.searchPersonsByName(tenant, input.canonical_name, 1);
  if (results[0]) return results[0];
  const person = await createPerson(ctx, tenant, input);
  console.log(`seeded person ${person.canonical_name}`);
  return person;
}

const tsubametani = await ensurePerson({
  canonical_name: '燕谷千尋',
  person_type: 'actor',
  aliases: ['Tsubametani Chihiro', '燕谷さん'],
  profile: { short_bio: '俳優・モデル。清潔感のある広告出演が多く、環境保全活動にも関心がある。' },
  sns_accounts: [{ platform: 'instagram', handle: 'chihiro_tsubametani', follower_count: 1_200_000 }]
} as Parameters<typeof createPerson>[2]);

const minase = await ensurePerson({
  canonical_name: '水瀬里奈',
  person_type: 'influencer',
  aliases: ['Rina Minase'],
  profile: { short_bio: '美容・ライフスタイル系インフルエンサー。Z世代から支持を集める。' },
  sns_accounts: [
    { platform: 'instagram', handle: 'rina_minase', follower_count: 850_000 },
    { platform: 'tiktok', handle: 'rinaminase', follower_count: 2_100_000 }
  ]
} as Parameters<typeof createPerson>[2]);

const takamura = await ensurePerson({
  canonical_name: '高村健一',
  person_type: 'expert',
  aliases: ['Kenichi Takamura'],
  profile: { short_bio: 'AI倫理とデータガバナンスの専門家。大学で教鞭を執りつつ企業のアドバイザーを務める。' },
  sns_accounts: [{ platform: 'x', handle: 'takamura_ai', follower_count: 95_000 }]
} as Parameters<typeof createPerson>[2]);

// --- sources ---
type SourceInput = z.infer<typeof SourceCreateSchema>;
const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
const sources: SourceInput[] = [
  {
    source_type: 'news',
    source_subtype: 'entertainment',
    source_name: 'PR TIMES',
    title: '燕谷千尋、環境保全プロジェクトのアンバサダーに就任',
    body: '燕谷千尋が海岸清掃ボランティアに参加し、環境保全プロジェクトのアンバサダーに就任。身長182cmの長身を生かしたCM出演でも知られ、Instagram @chihiro_tsubametani でも活動を発信し、若年層への啓発を目指す。',
    url: 'https://example.com/news/tsubametani-ambassador',
    published_at: daysAgo(5),
    language: 'ja',
    target_person_ids: [tsubametani.id],
    idempotency_key: 'seed:tsubametani:ambassador'
  },
  {
    source_type: 'news',
    source_subtype: 'beauty',
    source_name: 'Beauty News',
    title: '水瀬里奈プロデュースのスキンケアブランドが発売即完売',
    body: '水瀬里奈が手がけるスキンケアブランドが発売初日に完売。サステナブルなパッケージも話題で、TikTokでの紹介動画は再生回数500万回を突破した。',
    url: 'https://example.com/news/minase-skincare',
    published_at: daysAgo(12),
    language: 'ja',
    target_person_ids: [minase.id],
    idempotency_key: 'seed:minase:skincare'
  },
  {
    source_type: 'news',
    source_subtype: 'technology',
    source_name: 'Tech Journal',
    title: '高村健一氏、政府のAI倫理ガイドライン策定委員に',
    body: 'AI倫理の専門家である高村健一氏が、政府の新しいAI倫理ガイドライン策定委員会の委員に就任した。生成AIの透明性と説明責任について慎重な制度設計を訴えている。',
    url: 'https://example.com/news/takamura-committee',
    published_at: daysAgo(20),
    language: 'ja',
    target_person_ids: [takamura.id],
    idempotency_key: 'seed:takamura:committee'
  },
  {
    source_type: 'social_post',
    source_subtype: 'x_post',
    source_name: 'X',
    body: '燕谷千尋の新しい環境CM、メッセージが押し付けがましくなくて良い。清潔感もある。',
    url: 'https://x.com/example/status/1001',
    published_at: daysAgo(2),
    language: 'ja',
    idempotency_key: 'seed:post:tsubametani-cm'
  }
];

for (const source of sources) {
  const result = await ingestSource(ctx, tenant, source);
  console.log(`source ${source.title ?? source.body?.slice(0, 24)}: ${result.duplicate ? 'duplicate' : result.source_id}`);
}

const processed = await drainQueue(ctx, { maxJobs: 50 });
console.log(`processed ${processed} jobs`);
await ctx.store.close();
console.log('seed complete');
