import type { WeeklyCandidateRow } from '../lib/workerClient.ts';

export const LIKED_WEIGHT = 1_000_000;
export const FOLLOWER_LIKES_WEIGHT = 50;
export const IMPORTANCE_SCORE_WEIGHT = 10;
export const SOURCE_COUNT_WEIGHT = 5;
export const SEEN_COUNT_WEIGHT = 1;
export const SCORE_DECIMALS = 2;

const DEFAULT_IMPORTANCE_SCORE = 1;
const DEFAULT_COUNT_VALUE = 1;
const ZERO = 0;

export interface RankedCandidate extends WeeklyCandidateRow {
  rank_score: number;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isCandidateLiked(candidate: WeeklyCandidateRow): boolean {
  return toFiniteNumber(candidate.is_liked, ZERO) > ZERO;
}

/**
 * Computes a deterministic weighted ranking score for a weekly candidate.
 * `LIKED_WEIGHT` dominates, followed by `follower_likes`, `importance_score`,
 * `source_count`, and `seen_count`.
 */
export function computeCandidateScore(candidate: WeeklyCandidateRow): number {
  const likedBoost = isCandidateLiked(candidate) ? LIKED_WEIGHT : ZERO;
  const followerLikes = Math.max(ZERO, toFiniteNumber(candidate.follower_likes, ZERO));
  const importanceScore = Math.max(
    ZERO,
    toFiniteNumber(candidate.importance_score, DEFAULT_IMPORTANCE_SCORE)
  );
  const sourceCount = Math.max(
    DEFAULT_COUNT_VALUE,
    toFiniteNumber(candidate.source_count, DEFAULT_COUNT_VALUE)
  );
  const seenCount = Math.max(
    DEFAULT_COUNT_VALUE,
    toFiniteNumber(candidate.seen_count, DEFAULT_COUNT_VALUE)
  );

  const rawScore =
    likedBoost +
    followerLikes * FOLLOWER_LIKES_WEIGHT +
    importanceScore * IMPORTANCE_SCORE_WEIGHT +
    sourceCount * SOURCE_COUNT_WEIGHT +
    seenCount * SEEN_COUNT_WEIGHT;

  return Number(rawScore.toFixed(SCORE_DECIMALS));
}

function compareRankedCandidates(a: RankedCandidate, b: RankedCandidate): number {
  const aLiked = isCandidateLiked(a);
  const bLiked = isCandidateLiked(b);
  if (aLiked !== bLiked) {
    return aLiked ? -1 : 1;
  }

  const scoreDiff = b.rank_score - a.rank_score;
  if (scoreDiff !== ZERO) {
    return scoreDiff;
  }

  const followerDiff =
    toFiniteNumber(b.follower_likes, ZERO) - toFiniteNumber(a.follower_likes, ZERO);
  if (followerDiff !== ZERO) {
    return followerDiff;
  }

  const importanceDiff =
    toFiniteNumber(b.importance_score, DEFAULT_IMPORTANCE_SCORE) -
    toFiniteNumber(a.importance_score, DEFAULT_IMPORTANCE_SCORE);
  if (importanceDiff !== ZERO) {
    return importanceDiff;
  }

  const capturedDiff = (b.captured_at ?? '').localeCompare(a.captured_at ?? '');
  if (capturedDiff !== ZERO) {
    return capturedDiff;
  }

  return a.url.localeCompare(b.url);
}

/**
 * Ranks weekly candidates by weighted score with liked items strictly preceding unliked ones,
 * removes duplicate URLs and duplicate `cluster_id` entries (preserving the highest-ranked
 * candidate per cluster), and returns up to `count` items.
 */
export function rankWeekly(
  candidates: readonly WeeklyCandidateRow[],
  count: number
): RankedCandidate[] {
  if (!Array.isArray(candidates) || candidates.length === ZERO || count <= ZERO) {
    return [];
  }

  const scored: RankedCandidate[] = candidates.map((candidate) => ({
    ...candidate,
    rank_score: computeCandidateScore(candidate),
  }));

  scored.sort(compareRankedCandidates);

  const seenUrls = new Set<string>();
  const seenClusters = new Set<string>();
  const deduplicated: RankedCandidate[] = [];

  for (const candidate of scored) {
    const normalizedUrl = candidate.url.trim();
    if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
      continue;
    }

    const clusterId = candidate.cluster_id?.trim() ?? '';
    if (clusterId.length > ZERO && seenClusters.has(clusterId)) {
      continue;
    }

    seenUrls.add(normalizedUrl);
    if (clusterId.length > ZERO) {
      seenClusters.add(clusterId);
    }
    deduplicated.push(candidate);

    if (deduplicated.length >= count) {
      break;
    }
  }

  return deduplicated;
}

