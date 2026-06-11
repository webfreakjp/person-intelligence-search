import { describe, expect, it } from 'vitest';
import { extractFollowerCounts, extractSnsHandles } from '../packages/extraction/heuristics.ts';
import { fuseScores, fusionWeights } from '../packages/search/fusion.ts';

describe('extractSnsHandles', () => {
  it('finds handles from urls and inline mentions', () => {
    const text = '公式: https://www.instagram.com/chihiro_tsubametani と X @tsubametani_staff、https://x.com/tsubametani_x で発信';
    const hits = extractSnsHandles(text);
    expect(hits).toContainEqual({ platform: 'instagram', handle: 'chihiro_tsubametani' });
    expect(hits).toContainEqual({ platform: 'x', handle: 'tsubametani_x' });
    expect(hits).toContainEqual({ platform: 'x', handle: 'tsubametani_staff' });
  });
});

describe('extractFollowerCounts', () => {
  it('parses Japanese units near platform words', () => {
    const hits = extractFollowerCounts('Instagramのフォロワーは120万人。YouTube登録者50万人を突破。');
    expect(hits).toContainEqual({ platform: 'instagram', follower_count: 1_200_000 });
    expect(hits).toContainEqual({ platform: 'youtube', follower_count: 500_000 });
  });
});

describe('score fusion', () => {
  it('uses the fixed fusion weights', () => {
    expect(fusionWeights(true)).toEqual({ structured: 0.25, vector: 0.55, full_text: 0.2 });
    expect(fusionWeights(false)).toEqual({ structured: 0.3, vector: 0.7 });
    const { fused } = fuseScores(new Map([['p1', { structured: 1, vector: 0.5 }]]), false);
    expect(fused.get('p1')).toBeCloseTo(0.3 + 0.35, 5);
  });
});
