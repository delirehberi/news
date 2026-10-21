import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  parseDuplicateVerdicts,
  confirmDuplicatesWithLLM,
  buildClusterPlan,
  DUPLICATE_JUDGE_BATCH_SIZE,
  JudgeArticle
} from './dedup'
import { DuplicateCandidate } from './scoring'

const PHP_HN: JudgeArticle = {
  id: 'hn-50172041',
  title: 'Upcoming critical PHP security release',
  url: 'https://news-web.php.net/php.announce/509'
};
const PHP_LOBSTERS: JudgeArticle = {
  id: 'lobsters-ekxoyt',
  title: 'Upcoming Critical PHP Security Release',
  url: 'https://www.php.net/archive/2026.php'
};
const BITCOIN: JudgeArticle = {
  id: 'stacker-1',
  title: 'Is Bitcoin already freedom money?',
  url: 'https://stacker.news/items/1'
};

const ARTICLES = new Map([PHP_HN, PHP_LOBSTERS, BITCOIN].map(a => [a.id, a]));
const CANDIDATES: DuplicateCandidate[] = [
  { aId: PHP_HN.id, bId: PHP_LOBSTERS.id, similarity: 0.906 },
  { aId: PHP_HN.id, bId: BITCOIN.id, similarity: 0.89 }
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseDuplicateVerdicts', () => {
  it('reads pre-parsed objects and fenced JSON strings', () => {
    expect(parseDuplicateVerdicts({ duplicate_pairs: [0, 2] }, 3)).toEqual(new Set([0, 2]));
    expect(parseDuplicateVerdicts('```json\n{"duplicate_pairs": [1]}\n```', 2)).toEqual(new Set([1]));
  });

  it('drops out-of-range, negative and non-integer indices', () => {
    expect(parseDuplicateVerdicts({ duplicate_pairs: [0, 5, -1, 1.5, '1'] }, 2)).toEqual(new Set([0]));
  });

  it('merges nothing for malformed or missing verdicts', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseDuplicateVerdicts('{"duplicate_pairs": [0', 2).size).toBe(0);
    expect(parseDuplicateVerdicts({ selected_ids: ['x'] }, 2).size).toBe(0);
    expect(parseDuplicateVerdicts([0, 1], 2).size).toBe(0);
    expect(parseDuplicateVerdicts(undefined, 2).size).toBe(0);
  });
});

describe('confirmDuplicatesWithLLM', () => {
  it('confirms the pairs the judge marks and leaves rejected pairs separate', async () => {
    const complete = vi.fn().mockResolvedValue({ duplicate_pairs: [0] });
    const confirmed = await confirmDuplicatesWithLLM(complete, CANDIDATES, ARTICLES);
    expect(confirmed).toEqual([{ aId: PHP_HN.id, bId: PHP_LOBSTERS.id }]);

    const payload = JSON.parse(complete.mock.calls[0][1]);
    expect(payload[0].a).toEqual({ title: PHP_HN.title, domain: 'news-web.php.net', summary: '' });
    expect(payload[0].b.domain).toBe('php.net');
  });

  it('confirms nothing when the AI call fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const complete = vi.fn().mockRejectedValue(new Error('AI unavailable'));
    expect(await confirmDuplicatesWithLLM(complete, CANDIDATES, ARTICLES)).toEqual([]);
  });

  it('batches pairs and maps indices back per batch', async () => {
    const many: DuplicateCandidate[] = Array.from({ length: DUPLICATE_JUDGE_BATCH_SIZE + 1 }, () => CANDIDATES[0]);
    const complete = vi.fn()
      .mockResolvedValueOnce({ duplicate_pairs: [] })
      .mockResolvedValueOnce({ duplicate_pairs: [0] });
    const confirmed = await confirmDuplicatesWithLLM(complete, many, ARTICLES);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(confirmed).toHaveLength(1);
  });

  it('skips pairs with unknown articles and stops when aborted', async () => {
    const complete = vi.fn().mockResolvedValue({ duplicate_pairs: [0] });
    const unknown: DuplicateCandidate[] = [{ aId: 'missing', bId: PHP_HN.id, similarity: 0.95 }];
    expect(await confirmDuplicatesWithLLM(complete, unknown, ARTICLES)).toEqual([]);

    const controller = new AbortController();
    controller.abort();
    expect(await confirmDuplicatesWithLLM(complete, CANDIDATES, ARTICLES, controller.signal)).toEqual([]);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('buildClusterPlan', () => {
  it('gives every confirmed member the union of the cluster sources', () => {
    const plan = buildClusterPlan(
      [
        { id: 'lobsters-ekxoyt', source: 'lobsters', sources: ['lobsters'], created_at: '2026-10-21 01:00:41' },
        { id: 'hn-50172041', source: 'hackernews', sources: [], created_at: '2026-10-21 05:00:57' },
        { id: 'stacker-1', source: 'stackernews', sources: ['stackernews'], created_at: '2026-10-21 02:00:00' }
      ],
      [{ aId: 'hn-50172041', bId: 'lobsters-ekxoyt' }]
    );
    expect(Object.fromEntries(plan)).toEqual({
      'lobsters-ekxoyt': { clusterId: 'cluster-lobsters-ekxoyt', sources: ['lobsters', 'hackernews'] },
      'hn-50172041': { clusterId: 'cluster-lobsters-ekxoyt', sources: ['lobsters', 'hackernews'] }
    });
  });
});
