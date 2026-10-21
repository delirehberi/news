import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  calculateImportanceScore,
  rescoreWithSignals,
  computeExpiresAt,
  cosineSimilarity,
  parseSources,
  parseEmbedding,
  serializeEmbedding,
  parseSqliteDateTime,
  toSqliteDateTime,
  hotScore,
  rankHot,
  groupDigest,
  isoWeek,
  pickSnapshotCandidates,
  findDuplicateCandidates,
  assignClusters,
  pickClusterPrimary,
  collapseClusters,
  collapseForFeed,
  resolveClusterView,
  pairKey,
  DUPLICATE_CANDIDATE_THRESHOLD,
  HOT_PROMOTION_THRESHOLD,
  RETENTION_DAYS
} from './scoring'

const NOW = new Date('2026-10-15T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function daysFromNow(expiresAt: string): number {
  return (parseSqliteDateTime(expiresAt)!.getTime() - NOW.getTime()) / DAY_MS;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('calculateImportanceScore', () => {
  it('keeps the baseline of 1.0 for a single unseen-again source', () => {
    expect(calculateImportanceScore(1)).toBe(1);
  });

  it('grows with distinct sources', () => {
    expect(calculateImportanceScore(2)).toBe(2.5);
    expect(calculateImportanceScore(3)).toBe(4);
  });

  it('adds a diminishing boost for repeat sightings', () => {
    const seen2 = calculateImportanceScore(1, 0, 2);
    const seen4 = calculateImportanceScore(1, 0, 4);
    const seen8 = calculateImportanceScore(1, 0, 8);
    expect(seen2).toBeGreaterThan(1);
    expect(seen4).toBeGreaterThan(seen2);
    expect(seen8 - seen4).toBeCloseTo(seen4 - seen2, 1);
    expect(seen8).toBeLessThan(calculateImportanceScore(2));
  });

  it('ignores negative affinity and non-positive seen counts', () => {
    expect(calculateImportanceScore(1, -5, 0)).toBe(1);
  });

  it('promotes any two-source story to hot', () => {
    expect(calculateImportanceScore(2)).toBeGreaterThanOrEqual(HOT_PROMOTION_THRESHOLD);
  });
});

describe('rescoreWithSignals', () => {
  it('preserves the affinity factor earned at ingestion', () => {
    const original = calculateImportanceScore(1, 1, 1);
    const rescored = rescoreWithSignals(original, 1, 1, 1, 2);
    expect(rescored).toBeCloseTo(calculateImportanceScore(1, 1, 2), 1);
  });

  it('falls back to signal-only scoring without a previous score', () => {
    expect(rescoreWithSignals(null, 1, 1, 2, 1)).toBe(2.5);
  });

  it('never drops below the signal-only score', () => {
    expect(rescoreWithSignals(0.1, 1, 1, 1, 1)).toBe(1);
  });
});

describe('computeExpiresAt', () => {
  it('keeps regular articles for the default retention', () => {
    expect(daysFromNow(computeExpiresAt(['hackernews'], 1, NOW))).toBe(RETENTION_DAYS.default);
  });

  it('keeps newsletter articles longer', () => {
    expect(daysFromNow(computeExpiresAt(['newsletter'], 1, NOW))).toBe(RETENTION_DAYS.newsletter);
  });

  it('extends hot articles', () => {
    expect(daysFromNow(computeExpiresAt(['hackernews', 'lobsters'], 2.5, NOW))).toBe(RETENTION_DAYS.hot);
  });

  it('never shortens an existing expiry', () => {
    const later = toSqliteDateTime(new Date(NOW.getTime() + 10 * DAY_MS));
    expect(computeExpiresAt(['hackernews'], 1, NOW, later)).toBe(later);
  });

  it('replaces an earlier or unparseable expiry', () => {
    const earlier = toSqliteDateTime(new Date(NOW.getTime() - DAY_MS));
    expect(daysFromNow(computeExpiresAt(['hackernews'], 1, NOW, earlier))).toBe(RETENTION_DAYS.default);
    expect(daysFromNow(computeExpiresAt(['hackernews'], 1, NOW, 'garbage'))).toBe(RETENTION_DAYS.default);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical direction', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
  });

  it('is 0 for zero vectors, empty input and length mismatch', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe('parseSources', () => {
  it('parses a JSON array of strings', () => {
    expect(parseSources('["hackernews","lobsters"]', 'x')).toEqual(['hackernews', 'lobsters']);
  });

  it('falls back on malformed JSON and logs the error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseSources('{not json', 'reddit')).toEqual(['reddit']);
    expect(spy).toHaveBeenCalled();
  });

  it('falls back on empty or non-string arrays', () => {
    expect(parseSources('[]', 'reddit')).toEqual(['reddit']);
    expect(parseSources('[1,2]', 'reddit')).toEqual(['reddit']);
    expect(parseSources(null)).toEqual([]);
  });
});

describe('embedding serialization', () => {
  it('round-trips with bounded precision', () => {
    const parsed = parseEmbedding(serializeEmbedding([0.123456789, -0.5]));
    expect(parsed).toEqual([0.123457, -0.5]);
  });

  it('rejects malformed payloads', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(parseEmbedding('nope')).toBeNull();
    expect(parseEmbedding('["a"]')).toBeNull();
    expect(parseEmbedding(null)).toBeNull();
  });
});

describe('sqlite datetime helpers', () => {
  it('round-trips the D1 format as UTC', () => {
    const sql = toSqliteDateTime(NOW);
    expect(sql).toBe('2026-10-15 12:00:00');
    expect(parseSqliteDateTime(sql)!.getTime()).toBe(NOW.getTime());
  });

  it('returns null for invalid input', () => {
    expect(parseSqliteDateTime('')).toBeNull();
    expect(parseSqliteDateTime('not a date')).toBeNull();
  });
});

describe('hot ranking', () => {
  const hoursAgo = (h: number) => toSqliteDateTime(new Date(NOW.getTime() - h * 60 * 60 * 1000));

  it('measures age from the latest sighting', () => {
    const stale = { importance_score: 1, created_at: hoursAgo(20) };
    const resighted = { importance_score: 1, created_at: hoursAgo(20), last_seen_at: hoursAgo(1) };
    expect(hotScore(resighted, NOW)).toBeGreaterThan(hotScore(stale, NOW));
  });

  it('keeps a multi-source story above a fresh single-source one for longer than the old gravity of 2', () => {
    // At 2.5h the old (age + 2)^2 decay ranked the fresh item first (4 / 20.25 < 1 / 4); gravity 1.5 does not.
    const multiSource = { id: 'a', importance_score: 4, created_at: hoursAgo(2.5) };
    const fresh = { id: 'b', importance_score: 1, created_at: hoursAgo(0) };
    const ranked = rankHot([fresh, multiSource], NOW);
    expect(ranked[0].id).toBe('a');
  });

  it('weights follower likes and respects the limit', () => {
    const liked = { id: 'liked', importance_score: 1, follower_likes: 2, created_at: hoursAgo(3) };
    const plain = { id: 'plain', importance_score: 1, created_at: hoursAgo(3) };
    const ranked = rankHot([plain, liked], NOW, 1);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].id).toBe('liked');
  });
});

describe('groupDigest', () => {
  it('groups by calendar day and ranks by importance without time decay', () => {
    const articles = [
      { id: 'today-low', importance_score: 1, created_at: '2026-10-15 11:00:00' },
      { id: 'today-high', importance_score: 4, created_at: '2026-10-15 01:00:00' },
      { id: 'yesterday', importance_score: 2.5, created_at: '2026-10-14 09:00:00' },
      { id: 'too-old', importance_score: 9, created_at: '2026-10-10 09:00:00' },
      { id: 'no-date', importance_score: 9, created_at: null }
    ];
    const groups = groupDigest(articles, NOW, 'UTC', 3, 15);
    expect(groups.map(g => g.label)).toEqual(['Today', 'Yesterday', 'Tuesday, Oct 13']);
    expect(groups[0].articles.map(a => a.id)).toEqual(['today-high', 'today-low']);
    expect(groups[1].articles.map(a => a.id)).toEqual(['yesterday']);
    expect(groups[2].articles).toEqual([]);
  });

  it('uses the configured time zone for day boundaries', () => {
    // 22:30 UTC on Oct 14 is already Oct 15 in Istanbul (UTC+3).
    const articles = [{ id: 'late', importance_score: 1, created_at: '2026-10-14 22:30:00' }];
    const groups = groupDigest(articles, NOW, 'Europe/Istanbul', 2, 15);
    expect(groups[0].articles.map(a => a.id)).toEqual(['late']);
  });

  it('caps each day at perDay', () => {
    const articles = Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, importance_score: i, created_at: '2026-10-15 10:00:00' }));
    const groups = groupDigest(articles, NOW, 'UTC', 1, 2);
    expect(groups[0].articles.map(a => a.id)).toEqual(['a4', 'a3']);
  });
});

describe('isoWeek', () => {
  it('correctly formats normal weeks in the middle of the year', () => {
    expect(isoWeek(new Date('2026-10-15T12:00:00Z'))).toBe('2026-W42');
  });

  it('handles Mondays and Sundays correctly', () => {
    // 2026-10-18 is Sunday (still W42)
    expect(isoWeek(new Date('2026-10-18T23:59:59Z'))).toBe('2026-W42');
    // 2026-10-19 is Monday (start of W43)
    expect(isoWeek(new Date('2026-10-19T00:00:00Z'))).toBe('2026-W43');
  });

  it('handles year boundaries where end of year belongs to next year week 1', () => {
    // 2024-12-31 is Tuesday; nearest Thursday is 2025-01-02 -> 2025-W01
    expect(isoWeek(new Date('2024-12-31T12:00:00Z'))).toBe('2025-W01');
    expect(isoWeek(new Date('2025-01-01T00:00:00Z'))).toBe('2025-W01');
  });

  it('handles year boundaries where beginning of year belongs to previous year week 53', () => {
    // 2021-01-01 is Friday; nearest Thursday is 2020-12-31 -> 2020-W53
    expect(isoWeek(new Date('2021-01-01T12:00:00Z'))).toBe('2020-W53');
    expect(isoWeek(new Date('2021-01-03T23:59:59Z'))).toBe('2020-W53');
    // 2021-01-04 is Monday -> 2021-W01
    expect(isoWeek(new Date('2021-01-04T00:00:00Z'))).toBe('2021-W01');
  });

  it('handles 53-week years at the end of the year', () => {
    // 2026-12-31 is Thursday -> 2026-W53
    expect(isoWeek(new Date('2026-12-31T23:59:59Z'))).toBe('2026-W53');
    // 2027-01-01 is Friday -> 2026-W53
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    // 2027-01-03 is Sunday -> 2026-W53
    expect(isoWeek(new Date('2027-01-03T23:59:59Z'))).toBe('2026-W53');
    // 2027-01-04 is Monday -> 2027-W01
    expect(isoWeek(new Date('2027-01-04T00:00:00Z'))).toBe('2027-W01');
  });
});

describe('pickSnapshotCandidates', () => {
  it('respects the limit when all articles are unliked', () => {
    const articles = Array.from({ length: 10 }, (_, i) => ({
      id: `art-${i}`,
      url: `https://example.com/article-${i}`,
      importance_score: 1.0,
      created_at: NOW.toISOString(),
      is_liked: 0
    }));

    const candidates = pickSnapshotCandidates(articles, NOW, 5);
    expect(candidates).toHaveLength(5);
  });

  it('always includes liked articles even if ranked outside the top limit', () => {
    const unliked = Array.from({ length: 10 }, (_, i) => ({
      id: `top-${i}`,
      url: `https://example.com/top-${i}`,
      importance_score: 10 - i, // high scores
      created_at: NOW.toISOString(),
      is_liked: 0
    }));

    const likedArticle = {
      id: 'liked-old',
      url: 'https://example.com/liked-story',
      importance_score: 0.1, // low score
      created_at: '2026-10-10 00:00:00', // old
      is_liked: 1
    };

    const candidates = pickSnapshotCandidates([...unliked, likedArticle], NOW, 5);
    // Top 5 unliked plus the 1 liked article = 6 candidates
    expect(candidates).toHaveLength(6);
    expect(candidates.some(c => c.url === likedArticle.url)).toBe(true);
  });

  it('removes duplicate URLs, keeping the highest ranked occurrence', () => {
    const article1 = {
      id: 'art-1',
      url: 'https://example.com/shared-url',
      importance_score: 5.0,
      created_at: NOW.toISOString(),
      is_liked: 0
    };
    const duplicateArticle = {
      id: 'art-dup',
      url: 'https://example.com/shared-url',
      importance_score: 1.0,
      created_at: NOW.toISOString(),
      is_liked: 1
    };
    const otherArticle = {
      id: 'art-2',
      url: 'https://example.com/other-url',
      importance_score: 3.0,
      created_at: NOW.toISOString(),
      is_liked: 0
    };

    const candidates = pickSnapshotCandidates([article1, duplicateArticle, otherArticle], NOW, 10);
    expect(candidates).toHaveLength(2);
    expect(candidates[0].id).toBe('art-1');
  });
});


// Unit vectors at a chosen cosine to the x axis make similarities exact and readable.
function vecAt(similarity: number): number[] {
  return [similarity, Math.sqrt(1 - similarity * similarity), 0];
}

describe('findDuplicateCandidates', () => {
  const art = (id: string, source: string, embedding: number[], created_at?: string) => ({
    id, url: `https://${id}`, source, embedding, created_at
  });

  it('nominates pairs at or above the threshold and skips those below', () => {
    const items = [art('a', 'hackernews', [1, 0, 0])];
    const pool = [
      art('b', 'lobsters', vecAt(DUPLICATE_CANDIDATE_THRESHOLD)),
      art('c', 'lobsters', vecAt(DUPLICATE_CANDIDATE_THRESHOLD - 0.01))
    ];
    expect(findDuplicateCandidates(items, pool).map(p => p.bId)).toEqual(['b']);
  });

  it('keeps only the strongest neighbours per item', () => {
    const items = [art('a', 'hackernews', [1, 0, 0])];
    const pool = [0.9, 0.95, 0.99, 0.93].map((s, i) => art(`p${i}`, 'lobsters', vecAt(s)));
    const pairs = findDuplicateCandidates(items, pool, DUPLICATE_CANDIDATE_THRESHOLD, 2);
    expect(pairs.map(p => p.bId)).toEqual(['p2', 'p1']);
  });

  it('skips self and same-URL matches and reports each pair once', () => {
    const a = { ...art('a', 'hackernews', [1, 0, 0]), url: 'https://same' };
    const b = { ...art('b', 'lobsters', [1, 0, 0]), url: 'https://same' };
    const c = art('c', 'reddit', [1, 0, 0]);
    const pairs = findDuplicateCandidates([a, b, c], [a, b, c]);
    expect(pairs.map(p => pairKey(p.aId, p.bId)).sort()).toEqual(['a|c', 'b|c']);
  });

  it('never pairs two posts from the same source, such as recurring daily threads', () => {
    const monday = art('stacker-1', 'stackernews', [1, 0, 0], '2026-10-19 08:00:00');
    const tuesday = art('stacker-2', 'stackernews', [1, 0, 0], '2026-10-20 08:00:00');
    expect(findDuplicateCandidates([monday], [monday, tuesday])).toEqual([]);
  });

  it('skips pairs posted more than DUPLICATE_MAX_GAP_HOURS apart', () => {
    const early = art('hn-1', 'hackernews', [1, 0, 0], '2026-10-15 00:00:00');
    const inWindow = art('lobsters-1', 'lobsters', [1, 0, 0], '2026-10-16 23:00:00');
    const tooLate = art('reddit-1', 'reddit', [1, 0, 0], '2026-10-17 01:00:00');
    expect(findDuplicateCandidates([early], [inWindow, tooLate]).map(p => p.bId)).toEqual(['lobsters-1']);
  });

  it('returns nothing for empty input', () => {
    expect(findDuplicateCandidates([], [])).toEqual([]);
  });
});

describe('assignClusters', () => {
  const members = [
    { id: 'a', created_at: '2026-10-21 01:00:00' },
    { id: 'b', created_at: '2026-10-21 05:00:00' },
    { id: 'c', created_at: '2026-10-21 06:00:00' }
  ];

  it('does not cluster anything without a confirmed pair', () => {
    expect(assignClusters(members, []).size).toBe(0);
  });

  it('names a new cluster after its earliest member', () => {
    const assignment = assignClusters(members, [{ aId: 'b', bId: 'a' }]);
    expect(Object.fromEntries(assignment)).toEqual({ a: 'cluster-a', b: 'cluster-a' });
  });

  it('reuses the existing cluster id and pulls in its stored members', () => {
    const stored = [
      { id: 'a', created_at: '2026-10-21 01:00:00', cluster_id: 'cluster-old' },
      { id: 'b', created_at: '2026-10-21 05:00:00', cluster_id: 'cluster-old' },
      { id: 'c', created_at: '2026-10-21 06:00:00' }
    ];
    const assignment = assignClusters(stored, [{ aId: 'c', bId: 'b' }]);
    expect(Object.fromEntries(assignment)).toEqual({ a: 'cluster-old', b: 'cluster-old', c: 'cluster-old' });
  });

  it('refuses a confirmed pair that would chain two items of one source together', () => {
    // Timestral (hn) ~ Clairic (reddit) ~ Voxtral (hn): the second verdict would put two HN posts in one story.
    const chain = [
      { id: 'hn-timestral', source: 'hackernews', created_at: '2026-10-20 10:00:00' },
      { id: 'reddit-clairic', source: 'reddit', created_at: '2026-10-20 11:00:00' },
      { id: 'hn-voxtral', source: 'hackernews', created_at: '2026-10-20 15:00:00' }
    ];
    const assignment = assignClusters(chain, [
      { aId: 'hn-timestral', bId: 'reddit-clairic' },
      { aId: 'reddit-clairic', bId: 'hn-voxtral' }
    ]);
    expect(Object.fromEntries(assignment)).toEqual({
      'hn-timestral': 'cluster-hn-timestral',
      'reddit-clairic': 'cluster-hn-timestral'
    });
  });

  it('ignores pairs that reference unknown members', () => {
    expect(assignClusters(members, [{ aId: 'a', bId: 'zzz' }]).size).toBe(0);
  });
});

describe('pickClusterPrimary', () => {
  it('picks the earliest sighting and breaks ties by id', () => {
    expect(pickClusterPrimary([
      { id: 'b', created_at: '2026-10-21 01:00:00' },
      { id: 'a', created_at: '2026-10-21 01:00:00' },
      { id: 'c', created_at: '2026-10-20 23:00:00' }
    ])?.id).toBe('c');
    expect(pickClusterPrimary([
      { id: 'b', created_at: '2026-10-21 01:00:00' },
      { id: 'a', created_at: '2026-10-21 01:00:00' }
    ])?.id).toBe('a');
  });

  it('returns undefined for an empty cluster', () => {
    expect(pickClusterPrimary([])).toBeUndefined();
  });
});

describe('collapseClusters', () => {
  const article = (id: string, created_at: string, cluster_id: string | null, source: string) => ({
    id, created_at, cluster_id, source, sources: [source], source_count: 1, title: `t-${id}`, url: `https://${id}`
  });

  it('renders the primary at the best-ranked position with related coverage', () => {
    const ranked = [
      article('x', '2026-10-21 02:00:00', null, 'reddit'),
      article('hn-1', '2026-10-21 05:00:00', 'cluster-php', 'hackernews'),
      article('y', '2026-10-21 03:00:00', null, 'reddit'),
      article('lobsters-1', '2026-10-21 01:00:00', 'cluster-php', 'lobsters')
    ];
    const collapsed = collapseClusters(ranked);
    expect(collapsed.map(a => a.id)).toEqual(['x', 'lobsters-1', 'y']);
    expect(collapsed[1].related).toEqual([{ id: 'hn-1', title: 't-hn-1', url: 'https://hn-1', source: 'hackernews' }]);
    expect(collapsed[1].sources).toEqual(['hackernews', 'lobsters']);
    expect(collapsed[1].source_count).toBe(2);
  });

  it('leaves a single live member of a cluster as a normal entry', () => {
    const collapsed = collapseClusters([article('a', '2026-10-21 01:00:00', 'cluster-a', 'hackernews')]);
    expect(collapsed).toEqual([{ ...article('a', '2026-10-21 01:00:00', 'cluster-a', 'hackernews'), related: [] }]);
  });

  it('returns an empty list for empty input', () => {
    expect(collapseClusters([])).toEqual([]);
  });
});

describe('collapseForFeed', () => {
  const row = (id: string, created_at: string, importance_score: number, cluster_id: string | null) => ({
    id, created_at, importance_score, cluster_id, source: 'hackernews', title: id, url: `https://${id}`
  });

  it('collapses a hot-ranked cluster into one story and limits by stories', () => {
    const articles = [
      row('hn-php', '2026-10-15 10:00:00', 10, 'cluster-php'),
      row('lobsters-php', '2026-10-15 08:00:00', 1, 'cluster-php'),
      row('other-1', '2026-10-15 09:00:00', 5, null),
      row('other-2', '2026-10-15 09:30:00', 0.1, null)
    ];
    const feed = collapseForFeed(articles, true, NOW, 2);
    expect(feed.map(a => a.id)).toEqual(['lobsters-php', 'other-1']);
    expect(feed[0].related.map(r => r.id)).toEqual(['hn-php']);
  });

  it('keeps the given order when not ranking by hot', () => {
    const articles = [row('b', '2026-10-15 09:00:00', 1, null), row('a', '2026-10-15 10:00:00', 1, null)];
    expect(collapseForFeed(articles, false, NOW).map(a => a.id)).toEqual(['b', 'a']);
  });
});

describe('resolveClusterView', () => {
  const member = (id: string, created_at: string, cluster_id: string | null = 'cluster-php') => ({
    id, created_at, cluster_id, source: id.split('-')[0], sources: [id.split('-')[0]], title: id, url: `https://${id}`
  });
  const lobsters = member('lobsters-ekxoyt', '2026-10-21 01:00:41');
  const hn = member('hn-50172041', '2026-10-21 05:00:57');

  it('redirects a secondary member to the primary', () => {
    expect(resolveClusterView(hn, [lobsters, hn])).toEqual({ kind: 'redirect', primaryId: 'lobsters-ekxoyt' });
  });

  it('renders the primary with its siblings as related coverage', () => {
    const view = resolveClusterView(lobsters, [lobsters, hn]);
    expect(view.kind).toBe('render');
    if (view.kind !== 'render') return;
    expect(view.article.related.map(r => r.id)).toEqual(['hn-50172041']);
    expect(view.article.sources).toEqual(['lobsters', 'hn']);
  });

  it('renders a lone member, or an unclustered article, as itself', () => {
    expect(resolveClusterView(hn, [])).toEqual({ kind: 'render', article: { ...hn, related: [] } });
    const solo = member('reddit-1', '2026-10-21 01:00:00', null);
    expect(resolveClusterView(solo, [])).toEqual({ kind: 'render', article: { ...solo, related: [] } });
  });
});
