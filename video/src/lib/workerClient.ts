import { fetchJson, HttpError } from './http.ts';
import { isValidIsoWeek } from './paths.ts';

export type WeeklyStatus = 'draft' | 'approved' | 'published';

export interface WeeklyItem {
  url: string;
  title_tr: string;
  summary_tr: string;
  source: string;
  image_url?: string | null;
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

export interface WeeklyEdition {
  week: string;
  status: WeeklyStatus;
  title_tr: string | null;
  intro_tr: string | null;
  items: WeeklyItem[];
  script: unknown;
  youtube_video_id: string | null;
  published_at: string | null;
  updated_at: string;
}

export interface WeeklyEditionPayload {
  title_tr?: string | null;
  intro_tr?: string | null;
  items?: WeeklyItem[];
  script?: unknown;
  youtube_video_id?: string | null;
  status?: WeeklyStatus;
}

export interface SnapshotResult {
  success: boolean;
  week: string;
  candidateCount: number;
  snapshotAt: string;
}

export interface WorkerClientConfig {
  baseUrl: string;
  ingestionSecret: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export interface WorkerClient {
  getCandidates(week: string, signal?: AbortSignal): Promise<WeeklyCandidateRow[]>;
  getEdition(week: string, signal?: AbortSignal): Promise<WeeklyEdition | null>;
  putEdition(
    week: string,
    payload: WeeklyEditionPayload,
    signal?: AbortSignal
  ): Promise<WeeklyEdition>;
  triggerSnapshot(signal?: AbortSignal): Promise<SnapshotResult>;
}

const HTTP_NOT_FOUND = 404;

function assertValidWeek(week: string): void {
  if (!isValidIsoWeek(week)) {
    throw new Error(`Invalid week format "${week}". Expected YYYY-Www (e.g. 2026-W42).`);
  }
}

/**
 * Creates a typed client for the Phase 3 Worker weekly admin API endpoints.
 * Authenticates every request with `Authorization: Bearer <ingestionSecret>`.
 */
export function createWorkerClient(config: WorkerClientConfig): WorkerClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const authHeaders: Record<string, string> = {
    Authorization: `Bearer ${config.ingestionSecret}`,
  };

  return {
    async getCandidates(week: string, signal?: AbortSignal): Promise<WeeklyCandidateRow[]> {
      assertValidWeek(week);
      const url = `${baseUrl}/api/admin/weekly/${encodeURIComponent(week)}/candidates`;
      return fetchJson<WeeklyCandidateRow[]>(url, {
        method: 'GET',
        headers: authHeaders,
        signal,
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
        fetchImpl: config.fetchImpl,
      });
    },

    async getEdition(week: string, signal?: AbortSignal): Promise<WeeklyEdition | null> {
      assertValidWeek(week);
      const url = `${baseUrl}/api/admin/weekly/${encodeURIComponent(week)}`;
      try {
        return await fetchJson<WeeklyEdition>(url, {
          method: 'GET',
          headers: authHeaders,
          signal,
          timeoutMs: config.timeoutMs,
          maxRetries: config.maxRetries,
          fetchImpl: config.fetchImpl,
        });
      } catch (err) {
        if (err instanceof HttpError && err.status === HTTP_NOT_FOUND) {
          return null;
        }
        throw err;
      }
    },

    async putEdition(
      week: string,
      payload: WeeklyEditionPayload,
      signal?: AbortSignal
    ): Promise<WeeklyEdition> {
      assertValidWeek(week);
      const url = `${baseUrl}/api/admin/weekly/${encodeURIComponent(week)}`;
      return fetchJson<WeeklyEdition>(url, {
        method: 'PUT',
        headers: authHeaders,
        body: payload,
        signal,
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
        fetchImpl: config.fetchImpl,
      });
    },

    async triggerSnapshot(signal?: AbortSignal): Promise<SnapshotResult> {
      const url = `${baseUrl}/api/admin/weekly/snapshot`;
      return fetchJson<SnapshotResult>(url, {
        method: 'POST',
        headers: authHeaders,
        signal,
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
        fetchImpl: config.fetchImpl,
      });
    },
  };
}

