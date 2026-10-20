import { describe, expect, it } from 'vitest';
import type { WeeklyCandidateRow } from '../lib/workerClient.ts';
import {
  computeCandidateScore,
  FOLLOWER_LIKES_WEIGHT,
  IMPORTANCE_SCORE_WEIGHT,
  LIKED_WEIGHT,
  rankWeekly,
  SEEN_COUNT_WEIGHT,
  SOURCE_COUNT_WEIGHT,
} from './rank.ts';

function makeCandidate(overrides: Partial<WeeklyCandidateRow> = {}): WeeklyCandidateRow {
  return {
    week: '2026-W42',
    url: 'https://example.com/default',
    article_id: 'art-1',
    title: 'Default Article',
    source: 'hackernews',
    summary: 'Default summary',
    image_url: null,
    is_liked: 0,
    follower_likes: 0,
    importance_score: 1.0,
    source_count: 1,
    seen_count: 1,
    cluster_id: null,
    captured_at: '2026-10-18 03:00:00',
    ...overrides,
  };
}

describe('src/domain/rank.ts', () => {
  it('computes weighted candidate scores with named weight hierarchy', () => {
    const base = makeCandidate({
      is_liked: 0,
      follower_likes: 2,
      importance_score: 3.5,
      source_count: 2,
      seen_count: 4,
    });

    const expected =
      2 * FOLLOWER_LIKES_WEIGHT +
      3.5 * IMPORTANCE_SCORE_WEIGHT +
      2 * SOURCE_COUNT_WEIGHT +
      4 * SEEN_COUNT_WEIGHT;

    expect(computeCandidateScore(base)).toBe(expected);

    const liked = makeCandidate({ ...base, is_liked: 1 });
    expect(computeCandidateScore(liked)).toBe(expected + LIKED_WEIGHT);
  });

  it('orders liked items strictly before unliked items and respects weight dominance', () => {
    const candidates: WeeklyCandidateRow[] = [
      makeCandidate({
        url: 'https://example.com/unliked-high-importance',
        is_liked: 0,
        follower_likes: 0,
        importance_score: 8.0,
        source_count: 3,
        seen_count: 5,
      }),
      makeCandidate({
        url: 'https://example.com/liked-low-metrics',
        is_liked: 1,
        follower_likes: 0,
        importance_score: 1.0,
        source_count: 1,
        seen_count: 1,
      }),
      makeCandidate({
        url: 'https://example.com/unliked-with-follower-likes',
        is_liked: 0,
        follower_likes: 3,
        importance_score: 2.0,
        source_count: 1,
        seen_count: 1,
      }),
      makeCandidate({
        url: 'https://example.com/liked-higher-metrics',
        is_liked: 1,
        follower_likes: 1,
        importance_score: 4.0,
        source_count: 2,
        seen_count: 2,
      }),
    ];

    const ranked = rankWeekly(candidates, 10);

    expect(ranked.map((r) => r.url)).toEqual([
      'https://example.com/liked-higher-metrics',
      'https://example.com/liked-low-metrics',
      'https://example.com/unliked-with-follower-likes',
      'https://example.com/unliked-high-importance',
    ]);
  });

  it('deduplicates by cluster_id keeping the highest-ranked item in each cluster', () => {
    const candidates: WeeklyCandidateRow[] = [
      makeCandidate({
        url: 'https://example.com/cluster-a-low',
        cluster_id: 'cluster-alpha',
        is_liked: 0,
        importance_score: 2.0,
      }),
      makeCandidate({
        url: 'https://example.com/cluster-a-high',
        cluster_id: 'cluster-alpha',
        is_liked: 0,
        importance_score: 6.5,
      }),
      makeCandidate({
        url: 'https://example.com/cluster-b-liked',
        cluster_id: 'cluster-beta',
        is_liked: 1,
        importance_score: 1.2,
      }),
      makeCandidate({
        url: 'https://example.com/cluster-b-unliked-high',
        cluster_id: 'cluster-beta',
        is_liked: 0,
        follower_likes: 5,
        importance_score: 9.0,
      }),
      makeCandidate({
        url: 'https://example.com/no-cluster-1',
        cluster_id: null,
        is_liked: 0,
        importance_score: 4.0,
      }),
      makeCandidate({
        url: 'https://example.com/no-cluster-2',
        cluster_id: null,
        is_liked: 0,
        importance_score: 3.0,
      }),
    ];

    const ranked = rankWeekly(candidates, 10);

    expect(ranked.map((r) => r.url)).toEqual([
      'https://example.com/cluster-b-liked',
      'https://example.com/cluster-a-high',
      'https://example.com/no-cluster-1',
      'https://example.com/no-cluster-2',
    ]);
  });

  it('returns all unique items when fewer candidates than count exist, and slices when more exist', () => {
    const twoCandidates: WeeklyCandidateRow[] = [
      makeCandidate({ url: 'https://example.com/1', importance_score: 5.0 }),
      makeCandidate({ url: 'https://example.com/2', importance_score: 3.0 }),
    ];

    const fewerResult = rankWeekly(twoCandidates, 6);
    expect(fewerResult).toHaveLength(2);
    expect(fewerResult.map((r) => r.url)).toEqual([
      'https://example.com/1',
      'https://example.com/2',
    ]);

    const slicedResult = rankWeekly(twoCandidates, 1);
    expect(slicedResult).toHaveLength(1);
    expect(slicedResult[0]?.url).toBe('https://example.com/1');
  });

  it('returns an empty array for an empty week or non-positive count', () => {
    expect(rankWeekly([], 6)).toEqual([]);
    expect(
      rankWeekly([makeCandidate({ url: 'https://example.com/1' })], 0)
    ).toEqual([]);
    expect(
      rankWeekly([makeCandidate({ url: 'https://example.com/1' })], -3)
    ).toEqual([]);
  });
});

