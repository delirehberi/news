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
