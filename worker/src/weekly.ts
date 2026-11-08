export type WeeklyStatus = 'draft' | 'approved' | 'published';

export interface WeeklyItem {
  url: string;
  cluster_id?: string | null;
  title_tr: string;
  summary_tr: string;
  source: string;
  image_url?: string | null;
  curator_comment?: string | null;
}

export interface WeeklyUsedIdentity {
  week: string;
  url: string;
  normalized_url: string;
  cluster_id: string | null;
  title_tr: string;
}

export interface WeeklyEditionIdentitySource {
  week: string;
  items_json: string;
}

export interface WeeklyCandidateIdentitySource {
  week: string;
  url: string;
  cluster_id: string | null;
}

export interface WeeklyDuplicateConflict {
  current_url: string;
  prior_url: string;
  prior_week: string;
  reason: 'normalized_url' | 'cluster_id';
}

export interface WeeklyEditionPayload {
  title_tr?: string | null;
  intro_tr?: string | null;
  items?: WeeklyItem[];
  script?: unknown;
  youtube_video_id?: string | null;
  status?: WeeklyStatus;
}

export interface WeeklyCandidateRow {
  week: string;
  url: string;
  article_id: string | null;
  title: string;
  source: string | null;
  summary: string | null;
  image_url: string | null;
  is_liked: number;
  follower_likes: number;
  importance_score: number;
  source_count: number;
  seen_count: number;
  cluster_id: string | null;
  curator_comment?: string | null;
  captured_at: string;
}

export interface WeeklyEditionRow {
  week: string;
  status: WeeklyStatus;
  title_tr: string | null;
  intro_tr: string | null;
  items_json: string;
  script_json: string | null;
  youtube_video_id: string | null;
  published_at: string | null;
  updated_at: string;
}

const ISO_WEEK_REGEX = /^\d{4}-W\d{2}$/;
const MIN_ISO_WEEK = 1;
const MAX_ISO_WEEK = 53;
const YOUTUBE_VIDEO_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const TRACKING_QUERY_PARAMETERS = new Set([
  'dclid',
  'fbclid',
  'gclid',
  'msclkid',
]);

export function normalizeWeeklyUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    parsed.protocol = 'https:';
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_QUERY_PARAMETERS.has(key.toLowerCase())) {
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

export function buildWeeklyUsedIdentities(
  editions: WeeklyEditionIdentitySource[],
  candidates: WeeklyCandidateIdentitySource[]
): WeeklyUsedIdentity[] {
  const clustersByEditionUrl = new Map<string, string>();
  for (const candidate of candidates) {
    const normalizedUrl = normalizeWeeklyUrl(candidate.url);
    if (normalizedUrl && candidate.cluster_id) {
      clustersByEditionUrl.set(`${candidate.week}\n${normalizedUrl}`, candidate.cluster_id);
    }
  }

  const identities: WeeklyUsedIdentity[] = [];
  for (const edition of editions) {
    let items: unknown;
    try {
      items = JSON.parse(edition.items_json);
    } catch (error) {
      throw new Error(`Parsing weekly edition items for ${edition.week}: ${String(error)}`);
    }
    if (!Array.isArray(items)) {
      throw new Error(`Parsing weekly edition items for ${edition.week}: expected an array`);
    }

    for (const item of items) {
      if (!isValidWeeklyItem(item)) {
        throw new Error(`Parsing weekly edition items for ${edition.week}: invalid item`);
      }
      const normalizedUrl = normalizeWeeklyUrl(item.url);
      if (!normalizedUrl) continue;
      identities.push({
        week: edition.week,
        url: item.url,
        normalized_url: normalizedUrl,
        cluster_id: item.cluster_id ?? clustersByEditionUrl.get(`${edition.week}\n${normalizedUrl}`) ?? null,
        title_tr: item.title_tr,
      });
    }
  }
  return identities;
}

export function findWeeklyDuplicateConflicts(
  items: WeeklyItem[],
  usedIdentities: WeeklyUsedIdentity[]
): WeeklyDuplicateConflict[] {
  const conflicts: WeeklyDuplicateConflict[] = [];
  for (const item of items) {
    const normalizedUrl = normalizeWeeklyUrl(item.url);
    const match = usedIdentities.find((identity) =>
      (normalizedUrl !== null && identity.normalized_url === normalizedUrl) ||
      (item.cluster_id !== undefined && item.cluster_id !== null && identity.cluster_id === item.cluster_id)
    );
    if (!match) continue;
    conflicts.push({
      current_url: item.url,
      prior_url: match.url,
      prior_week: match.week,
      reason: normalizedUrl !== null && match.normalized_url === normalizedUrl ? 'normalized_url' : 'cluster_id',
    });
  }
  return conflicts;
}

/**
 * Validates ISO 8601 week string format (e.g. 2026-W42, week 01..53).
 */
export function isValidIsoWeek(week: unknown): week is string {
  if (typeof week !== 'string' || !ISO_WEEK_REGEX.test(week)) return false;
  const weekNum = Number.parseInt(week.slice(6), 10);
  return weekNum >= MIN_ISO_WEEK && weekNum <= MAX_ISO_WEEK;
}

/**
 * Validates that a string is a well-formed HTTP or HTTPS URL.
 */
export function isValidHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validates that a string is a safe YouTube video ID (`[A-Za-z0-9_-]{1,64}`).
 */
export function isValidYouTubeVideoId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return YOUTUBE_VIDEO_ID_REGEX.test(value.trim());
}

const STATUS_RANKS: Record<WeeklyStatus, number> = {
  draft: 1,
  approved: 2,
  published: 3,
};

/**
 * Validates that status only moves forward: draft -> approved -> published.
 * Setting the same status or moving to a higher status is allowed.
 * Moving backwards returns false.
 */
export function canTransitionStatus(
  current: WeeklyStatus | null | undefined,
  next: WeeklyStatus
): boolean {
  if (!current) return true;
  const currentRank = STATUS_RANKS[current];
  const nextRank = STATUS_RANKS[next];
  if (!currentRank || !nextRank) return false;
  return nextRank >= currentRank;
}

function isValidWeeklyItem(item: unknown): item is WeeklyItem {
  if (!item || typeof item !== 'object') return false;
  const record = item as Record<string, unknown>;

  if (!isValidHttpUrl(record.url)) return false;
  if (typeof record.title_tr !== 'string') return false;
  if (typeof record.summary_tr !== 'string') return false;
  if (typeof record.source !== 'string') return false;
  if (
    record.cluster_id !== undefined &&
    record.cluster_id !== null &&
    (typeof record.cluster_id !== 'string' || record.cluster_id.trim().length === 0)
  ) {
    return false;
  }

  if (
    record.image_url !== undefined &&
    record.image_url !== null &&
    !isValidHttpUrl(record.image_url)
  ) {
    return false;
  }

  if (
    record.curator_comment !== undefined &&
    record.curator_comment !== null &&
    typeof record.curator_comment !== 'string'
  ) {
    return false;
  }

  return true;
}

/**
 * Hand-written type guard validating WeeklyEditionPayload without external dependencies.
 */
export function isValidWeeklyEditionPayload(obj: unknown): obj is WeeklyEditionPayload {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return false;
  }

  const record = obj as Record<string, unknown>;

  if (record.status !== undefined) {
    if (typeof record.status !== 'string' || !(record.status in STATUS_RANKS)) {
      return false;
    }
  }

  if (
    record.title_tr !== undefined &&
    record.title_tr !== null &&
    typeof record.title_tr !== 'string'
  ) {
    return false;
  }

  if (
    record.intro_tr !== undefined &&
    record.intro_tr !== null &&
    typeof record.intro_tr !== 'string'
  ) {
    return false;
  }

  if (
    record.youtube_video_id !== undefined &&
    record.youtube_video_id !== null &&
    !isValidYouTubeVideoId(record.youtube_video_id)
  ) {
    return false;
  }

  if (record.items !== undefined) {
    if (!Array.isArray(record.items)) return false;
    for (const item of record.items) {
      if (!isValidWeeklyItem(item)) return false;
    }
  }

  return true;
}

