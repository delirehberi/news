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

// bge-base puts unrelated same-topic stories at 0.82-0.92, so cosine only nominates candidates;
// an LLM judge confirms that a pair covers the same event before anything is merged.
export const DUPLICATE_CANDIDATE_THRESHOLD = 0.88;
export const DUPLICATE_MAX_MATCHES_PER_ARTICLE = 3;
// Bounds LLM judge cost per ingestion run or re-cluster call.
export const DUPLICATE_MAX_PAIRS_PER_RUN = 60;
// Cross-source coverage of one story lands within a day or two; a wider gap is a different event
// (e.g. the same recurring "Daily Discussion Thread" title posted on another day).
export const DUPLICATE_MAX_GAP_HOURS = 48;
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

export const SNAPSHOT_LIMIT = 30;
export const SNAPSHOT_HOUR_UTC = 3;

export interface SnapshotCandidate extends RankableArticle {
  url: string;
  is_liked?: number | boolean | null;
}

/**
 * Returns the ISO 8601 week string for a given date in UTC (e.g. '2026-W42').
 * Correctly assigns dates at year boundaries to their ISO week.
 */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / MS_PER_DAY) + 1) / 7);
  return `${year}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Selects the top `limit` live articles by hot ranking, plus every liked article.
 * Deduplicates articles by URL, preserving the first occurrence (highest rank).
 */
export function pickSnapshotCandidates<T extends SnapshotCandidate>(
  articles: T[],
  now: Date,
  limit: number = SNAPSHOT_LIMIT
): T[] {
  const hot = rankHot(articles, now, limit);
  const liked = articles.filter(a => Boolean(a.is_liked));
  const seenUrls = new Set<string>();
  const candidates: T[] = [];

  for (const article of [...hot, ...liked]) {
    if (!article.url || seenUrls.has(article.url)) continue;
    seenUrls.add(article.url);
    candidates.push(article);
  }

  return candidates;
}


export interface EmbeddedArticle {
  id: string;
  url: string;
  source: string;
  created_at?: string | null;
  embedding: number[];
}

export interface DuplicateCandidate {
  aId: string;
  bId: string;
  similarity: number;
}

export interface ConfirmedPair {
  aId: string;
  bId: string;
}

// Order-independent key so (a, b) and (b, a) describe the same pair.
export function pairKey(aId: string, bId: string): string {
  return aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
}

function hoursApart(a?: string | null, b?: string | null): number | null {
  const aTime = parseSqliteDateTime(a)?.getTime();
  const bTime = parseSqliteDateTime(b)?.getTime();
  if (aTime === undefined || bTime === undefined) return null;
  return Math.abs(aTime - bTime) / MS_PER_HOUR;
}

/**
 * Nominates likely duplicates of `items` within `pool` (which may include `items` themselves).
 * Only each item's strongest neighbours are kept so one generic article cannot fan out across the pool.
 * Skipped pairs:
 * - Same URL: URL deduplication already merges those before clustering.
 * - Same source: two distinct posts on one site are different submissions (recurring threads,
 *   different users reporting similar problems), and a true repost of one link is caught by URL.
 * - Posted more than DUPLICATE_MAX_GAP_HOURS apart.
 */
export function findDuplicateCandidates(
  items: EmbeddedArticle[],
  pool: EmbeddedArticle[],
  threshold: number = DUPLICATE_CANDIDATE_THRESHOLD,
  maxPerItem: number = DUPLICATE_MAX_MATCHES_PER_ARTICLE
): DuplicateCandidate[] {
  const byKey = new Map<string, DuplicateCandidate>();
  for (const item of items) {
    const matches: Array<{ other: EmbeddedArticle; similarity: number }> = [];
    for (const other of pool) {
      if (other.id === item.id || other.url === item.url || other.source === item.source) continue;
      const gap = hoursApart(item.created_at, other.created_at);
      if (gap !== null && gap > DUPLICATE_MAX_GAP_HOURS) continue;
      const similarity = cosineSimilarity(item.embedding, other.embedding);
      if (similarity >= threshold) matches.push({ other, similarity });
    }
    matches.sort((a, b) => b.similarity - a.similarity);
    for (const { other, similarity } of matches.slice(0, maxPerItem)) {
      const key = pairKey(item.id, other.id);
      if (!byKey.has(key)) byKey.set(key, { aId: item.id, bId: other.id, similarity });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => b.similarity - a.similarity);
}

export interface ClusterMember {
  id: string;
  source?: string;
  cluster_id?: string | null;
  created_at?: string | null;
}

function compareByFirstSeen(a: ClusterMember, b: ClusterMember): number {
  const aTime = parseSqliteDateTime(a.created_at)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const bTime = parseSqliteDateTime(b.created_at)?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return (aTime - bTime) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// The earliest sighting is the primary, so permalinks and redirects never flip as a cluster grows.
export function pickClusterPrimary<T extends ClusterMember>(members: T[]): T | undefined {
  return [...members].sort(compareByFirstSeen)[0];
}

/**
 * Groups members connected by confirmed pairs or by an already shared cluster_id (union-find),
 * and returns memberId -> clusterId for every member of a multi-member group.
 * The oldest member's existing cluster_id is reused so stored clusters keep their id.
 * A confirmed pair is refused when it would put two members of the same source into one group:
 * this stops one wrong verdict from chaining unrelated stories (A~B, B~C making A~C). Pairs are
 * applied in the given order, so pass the strongest first.
 */
export function assignClusters(members: ClusterMember[], confirmedPairs: ConfirmedPair[]): Map<string, string> {
  const parent = new Map<string, string>();
  for (const m of members) parent.set(m.id, m.id);

  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let node = id;
    while (node !== root) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const sourcesByRoot = new Map<string, Set<string>>();
  for (const m of members) sourcesByRoot.set(m.id, new Set(m.source ? [m.source] : []));

  const union = (a: string, b: string, allowSourceOverlap: boolean): void => {
    if (!parent.has(a) || !parent.has(b)) return;
    const rootA = find(a);
    const rootB = find(b);
    if (rootA === rootB) return;
    const sourcesA = sourcesByRoot.get(rootA)!;
    const sourcesB = sourcesByRoot.get(rootB)!;
    if (!allowSourceOverlap && [...sourcesB].some(source => sourcesA.has(source))) return;
    parent.set(rootB, rootA);
    for (const source of sourcesB) sourcesA.add(source);
  };

  const firstByCluster = new Map<string, string>();
  for (const m of members) {
    if (!m.cluster_id) continue;
    const first = firstByCluster.get(m.cluster_id);
    // Stored clusters were already confirmed; keep them whole.
    if (first) union(first, m.id, true);
    else firstByCluster.set(m.cluster_id, m.id);
  }
  for (const pair of confirmedPairs) union(pair.aId, pair.bId, false);

  const groups = new Map<string, ClusterMember[]>();
  for (const m of members) {
    const root = find(m.id);
    const group = groups.get(root);
    if (group) group.push(m);
    else groups.set(root, [m]);
  }

  const assignment = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort(compareByFirstSeen);
    const clusterId = ordered.find(m => m.cluster_id)?.cluster_id || `cluster-${ordered[0].id}`;
    for (const m of group) assignment.set(m.id, clusterId);
  }
  return assignment;
}

export interface RelatedArticle {
  id: string;
  title: string;
  url: string;
  source: string;
}

export interface CollapsibleArticle extends ClusterMember {
  title: string;
  url: string;
  source: string;
  sources?: string[];
  source_count?: number;
}

/**
 * Collapses cluster members into one entry per story. Each cluster keeps the position of its
 * best-ranked member (input order is the rank) but renders its stable primary, with the
 * other members attached as `related` coverage.
 */
export function collapseClusters<T extends CollapsibleArticle>(ranked: T[]): Array<T & { related: RelatedArticle[] }> {
  const groups = new Map<string, T[]>();
  for (const article of ranked) {
    if (!article.cluster_id) continue;
    const group = groups.get(article.cluster_id);
    if (group) group.push(article);
    else groups.set(article.cluster_id, [article]);
  }

  const emitted = new Set<string>();
  const result: Array<T & { related: RelatedArticle[] }> = [];
  for (const article of ranked) {
    const group = article.cluster_id ? groups.get(article.cluster_id) : undefined;
    if (!group || group.length < 2) {
      result.push({ ...article, related: [] });
      continue;
    }
    if (emitted.has(article.cluster_id!)) continue;
    emitted.add(article.cluster_id!);

    const primary = pickClusterPrimary(group)!;
    const sources = Array.from(new Set(group.flatMap(m => m.sources && m.sources.length > 0 ? m.sources : [m.source])));
    result.push({
      ...primary,
      sources,
      source_count: Math.max(primary.source_count ?? 0, sources.length),
      related: group
        .filter(m => m.id !== primary.id)
        .map(m => ({ id: m.id, title: m.title, url: m.url, source: m.source }))
    });
  }
  return result;
}

/**
 * Feed ordering with duplicate stories collapsed. Hot ranking runs over the whole live set before
 * collapsing so a cluster's lower-ranked members still attach as related coverage; the limit then
 * applies to stories, not rows.
 */
export function collapseForFeed<T extends RankableArticle & CollapsibleArticle>(
  articles: T[],
  rankByHot: boolean,
  now: Date,
  limit: number = FEED_LIMIT
): Array<T & { related: RelatedArticle[] }> {
  const ordered: T[] = rankByHot ? rankHot(articles, now, articles.length) : articles;
  return collapseClusters(ordered).slice(0, limit);
}

export type ClusterView<T> =
  | { kind: 'render'; article: T & { related: RelatedArticle[] } }
  | { kind: 'redirect'; primaryId: string };

/**
 * Decides how a permalink renders: the cluster's primary renders with its siblings as related
 * coverage, and any other member redirects to it. `siblings` are the live cluster members; the
 * requested article is always considered, so a lone or expired-sibling article renders as itself.
 */
export function resolveClusterView<T extends CollapsibleArticle>(article: T, siblings: T[]): ClusterView<T> {
  const members = [article, ...siblings.filter(s => s.id !== article.id)];
  const [story] = collapseClusters(members.map(m => ({ ...m, cluster_id: article.cluster_id })));
  if (story.id !== article.id) return { kind: 'redirect', primaryId: story.id };
  return { kind: 'render', article: story };
}
