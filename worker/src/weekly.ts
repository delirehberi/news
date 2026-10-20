export type WeeklyStatus = 'draft' | 'approved' | 'published';

export interface WeeklyItem {
  url: string;
  title_tr: string;
  summary_tr: string;
  source: string;
  image_url?: string | null;
}

export interface WeeklyEditionPayload {
  title_tr?: string | null;
  intro_tr?: string | null;
  items?: WeeklyItem[];
  script?: any;
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

/**
 * Validates ISO 8601 week string format (e.g. 2026-W42).
 */
export function isValidIsoWeek(week: unknown): week is string {
  if (typeof week !== 'string') return false;
  return ISO_WEEK_REGEX.test(week);
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

  if (typeof record.url !== 'string' || record.url.trim().length === 0) return false;
  if (typeof record.title_tr !== 'string') return false;
  if (typeof record.summary_tr !== 'string') return false;
  if (typeof record.source !== 'string') return false;

  if (
    record.image_url !== undefined &&
    record.image_url !== null &&
    typeof record.image_url !== 'string'
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
    typeof record.youtube_video_id !== 'string'
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

