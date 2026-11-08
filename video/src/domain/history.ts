import type { UsedStoryIdentity, WeeklyCandidateRow } from '../lib/workerClient.ts';

const TRACKING_QUERY_PARAMETERS = new Set(['dclid', 'fbclid', 'gclid', 'msclkid']);
const UTM_PREFIX = 'utm_';

export interface ExcludedCandidate {
  url: string;
  prior_url: string;
  prior_week: string;
  reason: 'normalized_url' | 'cluster_id';
}

export interface HistoryFilterResult<T extends WeeklyCandidateRow> {
  eligible: T[];
  excluded: ExcludedCandidate[];
}

/** Mirrors the Worker's normalizeWeeklyUrl so both sides agree on story identity. */
export function normalizeStoryUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    parsed.protocol = 'https:';
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (lower.startsWith(UTM_PREFIX) || TRACKING_QUERY_PARAMETERS.has(lower)) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.searchParams.sort();
    if (parsed.pathname !== '/') parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Removes candidates whose normalized URL or cluster id already appears in an approved or
 * published edition. Title similarity is deliberately ignored so follow-up coverage stays eligible.
 */
export function excludeUsedStories<T extends WeeklyCandidateRow>(
  candidates: readonly T[],
  used: readonly UsedStoryIdentity[]
): HistoryFilterResult<T> {
  const byUrl = new Map<string, UsedStoryIdentity>();
  const byCluster = new Map<string, UsedStoryIdentity>();
  for (const identity of used) {
    if (!byUrl.has(identity.normalized_url)) byUrl.set(identity.normalized_url, identity);
    if (identity.cluster_id && !byCluster.has(identity.cluster_id)) {
      byCluster.set(identity.cluster_id, identity);
    }
  }

  const eligible: T[] = [];
  const excluded: ExcludedCandidate[] = [];
  for (const candidate of candidates) {
    const normalizedUrl = normalizeStoryUrl(candidate.url);
    const clusterId = candidate.cluster_id?.trim() ?? '';
    const urlMatch = normalizedUrl ? byUrl.get(normalizedUrl) : undefined;
    const clusterMatch = clusterId ? byCluster.get(clusterId) : undefined;
    const match = urlMatch ?? clusterMatch;
    if (!match) {
      eligible.push(candidate);
      continue;
    }
    excluded.push({
      url: candidate.url,
      prior_url: match.url,
      prior_week: match.week,
      reason: urlMatch ? 'normalized_url' : 'cluster_id',
    });
  }
  return { eligible, excluded };
}
