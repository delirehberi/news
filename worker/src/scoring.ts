// Pure scoring, retention and ranking logic shared by ingestion and read paths.
// Kept free of Worker bindings so it can be unit-tested in isolation.

export const NEWSLETTER_SOURCE = 'newsletter';

export const RETENTION_DAYS = {
  default: 2,
  newsletter: 4,
  hot: 7
} as const;

// Two distinct sources yield 1.0 * (1 + 1 * SOURCE_MULTIPLIER_STEP) = 2.5, so any
// cross-source story (or a strongly re-sighted, high-affinity one) is kept for RETENTION_DAYS.hot.
export const HOT_PROMOTION_THRESHOLD = 2.5;

export const BASE_IMPORTANCE = 1.0;
export const SOURCE_MULTIPLIER_STEP = 1.5;
export const AFFINITY_WEIGHT = 0.4;
export const SAME_SOURCE_REPEAT_WEIGHT = 0.5;
export const SCORE_DECIMALS = 2;

export const CLUSTER_SIMILARITY_THRESHOLD = 0.82;
export const CLUSTER_LOOKBACK_HOURS = 48;
// Bounds per-run CPU: new items x candidates x 768-dim dot products.
export const CLUSTER_MAX_CANDIDATES = 300;
// 6 decimals keeps cosine similarity stable while roughly halving stored JSON size.
export const EMBEDDING_PRECISION = 6;

export const HOT_GRAVITY = 1.5;
export const HOT_AGE_OFFSET_HOURS = 2;
export const FOLLOWER_LIKE_WEIGHT = 2.0;
export const FEED_LIMIT = 100;

export const DIGEST_DAYS = 3;
export const DIGEST_PER_DAY = 15;
export const DEFAULT_DIGEST_TIME_ZONE = 'UTC';

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export function parseSources(sourcesJson?: string | null, fallbackSource?: string): string[] {
  if (sourcesJson) {
    try {
      const parsed: unknown = JSON.parse(sourcesJson);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter((s): s is string => typeof s === 'string' && s.length > 0);
        if (valid.length > 0) return valid;
      }
    } catch (e) {
      console.error('parseSources: malformed sources JSON, falling back to primary source', e);
    }
  }
  return fallbackSource ? [fallbackSource] : [];
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length === 0 || vecA.length !== vecB.length) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function parseEmbedding(embeddingJson?: string | null): number[] | null {
  if (!embeddingJson) return null;
  try {
    const parsed: unknown = JSON.parse(embeddingJson);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(v => typeof v === 'number')) {
      return parsed as number[];
    }
  } catch (e) {
    console.error('parseEmbedding: malformed embedding JSON', e);
  }
  return null;
}

export function calculateImportanceScore(sourceCount: number, affinityScore: number = 0, seenCount: number = 1): number {
  // Each distinct source after the first adds SOURCE_MULTIPLIER_STEP; repeat sightings add a diminishing (log) boost.
  const sourceMultiplier = 1.0 + Math.max(0, sourceCount - 1) * SOURCE_MULTIPLIER_STEP;
  const affinityBonus = Math.max(0, affinityScore) * AFFINITY_WEIGHT;
  const repeatMultiplier = 1.0 + SAME_SOURCE_REPEAT_WEIGHT * Math.log(Math.max(1, seenCount));
  return Number(((BASE_IMPORTANCE + affinityBonus) * sourceMultiplier * repeatMultiplier).toFixed(SCORE_DECIMALS));
}

// Re-sighted articles skip the AI pipeline, so their affinity is unknown. Since the score is a
// product of factors, the stored score divided by its signal-only part recovers the affinity factor.
export function rescoreWithSignals(
  previousScore: number | null | undefined,
  previousSourceCount: number,
  previousSeenCount: number,
  sourceCount: number,
  seenCount: number
): number {
  const previousBase = calculateImportanceScore(previousSourceCount, 0, previousSeenCount);
  const affinityFactor = previousScore && previousBase > 0 ? Math.max(1, previousScore / previousBase) : 1;
  const nextBase = calculateImportanceScore(sourceCount, 0, seenCount);
  return Number((nextBase * affinityFactor).toFixed(SCORE_DECIMALS));
}

export function serializeEmbedding(embedding: number[]): string {
  return JSON.stringify(embedding.map(v => Number(v.toFixed(EMBEDDING_PRECISION))));
}

// D1/SQLite stores CURRENT_TIMESTAMP as 'YYYY-MM-DD HH:MM:SS' in UTC.
export function toSqliteDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

export function parseSqliteDateTime(value?: string | null): Date | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function computeExpiresAt(
  sources: string[],
  importanceScore: number,
  now: Date,
  currentExpiresAt?: string | null
): string {
  const baseDays = sources.includes(NEWSLETTER_SOURCE) ? RETENTION_DAYS.newsletter : RETENTION_DAYS.default;
  const days = importanceScore >= HOT_PROMOTION_THRESHOLD ? Math.max(baseDays, RETENTION_DAYS.hot) : baseDays;
  const candidate = new Date(now.getTime() + days * MS_PER_DAY);

  // Retention only ever extends: a re-sighting must never shorten a previously granted lifetime.
  const current = parseSqliteDateTime(currentExpiresAt);
  const effective = current && current.getTime() > candidate.getTime() ? current : candidate;
  return toSqliteDateTime(effective);
}

export interface RankableArticle {
  importance_score?: number | null;
  follower_likes?: number | null;
  created_at?: string | null;
  last_seen_at?: string | null;
}

function weightedImportance(article: RankableArticle): number {
  return (article.importance_score ?? BASE_IMPORTANCE) + (article.follower_likes ?? 0) * FOLLOWER_LIKE_WEIGHT;
}

export function hotScore(article: RankableArticle, now: Date): number {
  // Age is measured from the latest sighting so stories that keep trending stay near the top.
  const reference = parseSqliteDateTime(article.last_seen_at) ?? parseSqliteDateTime(article.created_at);
  const ageHours = reference ? Math.max(0, (now.getTime() - reference.getTime()) / MS_PER_HOUR) : 0;
  return weightedImportance(article) / Math.pow(ageHours + HOT_AGE_OFFSET_HOURS, HOT_GRAVITY);
}

function compareByRecency(a: RankableArticle, b: RankableArticle): number {
  const aTime = parseSqliteDateTime(a.created_at)?.getTime() ?? 0;
  const bTime = parseSqliteDateTime(b.created_at)?.getTime() ?? 0;
  return bTime - aTime;
}

export function rankHot<T extends RankableArticle>(articles: T[], now: Date, limit: number = FEED_LIMIT): Array<T & { hot_score: number }> {
  return articles
    .map(a => ({ ...a, hot_score: hotScore(a, now) }))
    .sort((a, b) => (b.hot_score - a.hot_score) || compareByRecency(a, b))
    .slice(0, limit);
}

export interface DigestGroup<T> {
  label: string;
  dayKey: string;
  articles: T[];
}

function dayKeyInZone(date: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD, which sorts and compares lexically.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function digestLabel(offset: number, date: Date, timeZone: string): string {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'short', day: 'numeric' }).format(date);
}

export function groupDigest<T extends RankableArticle>(
  articles: T[],
  now: Date,
  timeZone: string = DEFAULT_DIGEST_TIME_ZONE,
  days: number = DIGEST_DAYS,
  perDay: number = DIGEST_PER_DAY
): DigestGroup<T>[] {
  // Digest ranks by importance with no time decay: the point is surfacing what mattered each day.
  const groups: DigestGroup<T>[] = [];
  const byKey = new Map<string, DigestGroup<T>>();
  for (let offset = 0; offset < days; offset++) {
    const dayDate = new Date(now.getTime() - offset * MS_PER_DAY);
    const key = dayKeyInZone(dayDate, timeZone);
    if (byKey.has(key)) continue;
    const group: DigestGroup<T> = { label: digestLabel(offset, dayDate, timeZone), dayKey: key, articles: [] };
    byKey.set(key, group);
    groups.push(group);
  }

  for (const article of articles) {
    const created = parseSqliteDateTime(article.created_at);
    if (!created) continue;
    const group = byKey.get(dayKeyInZone(created, timeZone));
    if (group) group.articles.push(article);
  }

  for (const group of groups) {
    group.articles = group.articles
      .sort((a, b) => (weightedImportance(b) - weightedImportance(a)) || compareByRecency(a, b))
      .slice(0, perDay);
  }
  return groups;
}
