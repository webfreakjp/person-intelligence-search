import { normalizeText, toNumber } from '../shared/utils.ts';

// Deterministic SNS extraction. URL/handle patterns are more
// reliable than an LLM here, so this is rule-based by design.

export interface SnsHandleHit {
  platform: string;
  handle: string;
}

const SNS_URL_PATTERNS: Array<[RegExp, string]> = [
  [/(?:https?:\/\/)?(?:www\.)?instagram\.com\/([a-zA-Z0-9_.]{2,30})/g, 'instagram'],
  [/(?:https?:\/\/)?(?:www\.)?(?:twitter|x)\.com\/([a-zA-Z0-9_]{2,15})/g, 'x'],
  [/(?:https?:\/\/)?(?:www\.)?tiktok\.com\/@([a-zA-Z0-9_.]{2,24})/g, 'tiktok'],
  [/(?:https?:\/\/)?(?:www\.)?youtube\.com\/@([a-zA-Z0-9_.-]{2,30})/g, 'youtube'],
  [/(?:https?:\/\/)?(?:www\.)?github\.com\/([a-zA-Z0-9-]{2,39})/g, 'github'],
  [/(?:https?:\/\/)?(?:www\.)?note\.com\/([a-zA-Z0-9_]{2,30})/g, 'note']
];

const SNS_WORD_PATTERN = /(instagram|インスタ|x|twitter|ツイッター|tiktok|youtube|github|note)[:：\s/]*[@＠]([a-zA-Z0-9_.-]{2,30})/gi;
const WORD_PLATFORM_MAP: Record<string, string> = {
  instagram: 'instagram',
  インスタ: 'instagram',
  x: 'x',
  twitter: 'x',
  ツイッター: 'x',
  tiktok: 'tiktok',
  youtube: 'youtube',
  github: 'github',
  note: 'note'
};

export function extractSnsHandles(text: string): SnsHandleHit[] {
  const hits: SnsHandleHit[] = [];
  const push = (platform: string, handle: string) => {
    if (!hits.some((hit) => hit.platform === platform && hit.handle === handle)) hits.push({ platform, handle });
  };
  for (const [pattern, platform] of SNS_URL_PATTERNS) {
    for (const match of text.matchAll(pattern)) if (match[1]) push(platform, match[1]);
  }
  for (const match of text.matchAll(SNS_WORD_PATTERN)) {
    const platform = WORD_PLATFORM_MAP[normalizeText(match[1])];
    if (platform && match[2]) push(platform, match[2]);
  }
  return hits.slice(0, 10);
}

export interface FollowerHit {
  platform: string;
  follower_count: number;
}

/** "Instagramフォロワー120万人" style metric statements (profile sources mainly). */
export function extractFollowerCounts(text: string): FollowerHit[] {
  const hits: FollowerHit[] = [];
  const pattern =
    /(instagram|インスタ|x|twitter|ツイッター|tiktok|youtube)[^。\n]{0,24}?(?:フォロワー|フォロワー数|followers?|登録者)[^0-9]{0,8}([0-9][0-9,.]*)\s*(億|百万|万|千|million|m|k)?\s*(?:人|名)?/gi;
  for (const match of text.matchAll(pattern)) {
    const platform = WORD_PLATFORM_MAP[normalizeText(match[1])];
    const base = toNumber(match[2]);
    if (!platform || base == null) continue;
    const unit = normalizeText(match[3] ?? '');
    const multiplier =
      unit === '億'
        ? 100_000_000
        : unit === '百万' || unit === 'm' || unit === 'million'
          ? 1_000_000
          : unit === '万'
            ? 10_000
            : unit === '千' || unit === 'k'
              ? 1_000
              : 1;
    if (!hits.some((hit) => hit.platform === platform)) {
      hits.push({ platform, follower_count: Math.trunc(base * multiplier) });
    }
  }
  return hits;
}
