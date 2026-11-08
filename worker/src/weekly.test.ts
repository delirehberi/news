import { describe, it, expect, beforeEach } from 'vitest';
import {
  isValidIsoWeek,
  canTransitionStatus,
  isValidWeeklyEditionPayload,
  WeeklyEditionPayload,
  normalizeWeeklyUrl,
  buildWeeklyUsedIdentities,
  findWeeklyDuplicateConflicts,
} from './weekly';

describe('isValidIsoWeek', () => {
  it('accepts valid ISO week formats', () => {
    expect(isValidIsoWeek('2026-W42')).toBe(true);
    expect(isValidIsoWeek('2026-W01')).toBe(true);
    expect(isValidIsoWeek('2025-W52')).toBe(true);
    expect(isValidIsoWeek('1999-W09')).toBe(true);
  });

  it('rejects invalid ISO week formats', () => {
    expect(isValidIsoWeek('2026-42')).toBe(false);
    expect(isValidIsoWeek('2026-w42')).toBe(false);
    expect(isValidIsoWeek('2026-W4')).toBe(false);
    expect(isValidIsoWeek('2026-W00')).toBe(false);
    expect(isValidIsoWeek('2026-W54')).toBe(false);
    expect(isValidIsoWeek('2026-W99')).toBe(false);
    expect(isValidIsoWeek('2026-W123')).toBe(false);
    expect(isValidIsoWeek('2026/W42')).toBe(false);
    expect(isValidIsoWeek('')).toBe(false);
    expect(isValidIsoWeek('random-string')).toBe(false);
    expect(isValidIsoWeek(null)).toBe(false);
    expect(isValidIsoWeek(undefined)).toBe(false);
    expect(isValidIsoWeek(12345)).toBe(false);
  });
});

describe('canTransitionStatus', () => {
  it('allows setting any initial status when no status is currently set', () => {
    expect(canTransitionStatus(null, 'draft')).toBe(true);
    expect(canTransitionStatus(null, 'approved')).toBe(true);
    expect(canTransitionStatus(null, 'published')).toBe(true);
    expect(canTransitionStatus(undefined, 'draft')).toBe(true);
  });

  it('allows same-status updates', () => {
    expect(canTransitionStatus('draft', 'draft')).toBe(true);
    expect(canTransitionStatus('approved', 'approved')).toBe(true);
    expect(canTransitionStatus('published', 'published')).toBe(true);
  });

  it('allows forward transitions: draft -> approved -> published', () => {
    expect(canTransitionStatus('draft', 'approved')).toBe(true);
    expect(canTransitionStatus('draft', 'published')).toBe(true);
    expect(canTransitionStatus('approved', 'published')).toBe(true);
  });

  it('rejects backward transitions', () => {
    expect(canTransitionStatus('approved', 'draft')).toBe(false);
    expect(canTransitionStatus('published', 'approved')).toBe(false);
    expect(canTransitionStatus('published', 'draft')).toBe(false);
  });

  it('rejects unknown or invalid statuses', () => {
    expect(canTransitionStatus('unknown' as any, 'draft')).toBe(false);
    expect(canTransitionStatus('draft', 'unknown' as any)).toBe(false);
  });
});

describe('isValidWeeklyEditionPayload', () => {
  it('accepts an empty object as valid partial payload', () => {
    expect(isValidWeeklyEditionPayload({})).toBe(true);
  });

  it('accepts a complete valid payload', () => {
    const payload: WeeklyEditionPayload = {
      title_tr: 'Haftalık Yapay Zeka Özeti',
      intro_tr: 'Bu haftanın en önemli gelişmeleri.',
      status: 'draft',
      youtube_video_id: 'dQw4w9WgXcQ',
      script: { intro: 'Merhaba', stories: [] },
      items: [
        {
          url: 'https://example.com/story-1',
          title_tr: 'Yeni Model Tanıtıldı',
          summary_tr: 'Model tüm testlerde başarılı sonuçlar aldı.',
          source: 'Hacker News',
          image_url: 'https://example.com/img.png',
        },
        {
          url: 'https://example.com/story-2',
          title_tr: 'Açık Kaynak Gelişmesi',
          summary_tr: 'Topluluk yeni araçlar geliştirdi.',
          source: 'GitHub',
          image_url: null,
        },
      ],
    };

    expect(isValidWeeklyEditionPayload(payload)).toBe(true);
  });

  it('accepts null for optional string fields', () => {
    expect(
      isValidWeeklyEditionPayload({
        title_tr: null,
        intro_tr: null,
        youtube_video_id: null,
      })
    ).toBe(true);
  });

  it('rejects primitives and null/array root inputs', () => {
    expect(isValidWeeklyEditionPayload(null)).toBe(false);
    expect(isValidWeeklyEditionPayload(undefined)).toBe(false);
    expect(isValidWeeklyEditionPayload('string')).toBe(false);
    expect(isValidWeeklyEditionPayload(123)).toBe(false);
    expect(isValidWeeklyEditionPayload([])).toBe(false);
  });

  it('rejects invalid status values', () => {
    expect(isValidWeeklyEditionPayload({ status: 'invalid_status' })).toBe(false);
    expect(isValidWeeklyEditionPayload({ status: 123 })).toBe(false);
  });

  it('rejects invalid title_tr or intro_tr types', () => {
    expect(isValidWeeklyEditionPayload({ title_tr: 123 })).toBe(false);
    expect(isValidWeeklyEditionPayload({ intro_tr: ['not a string'] })).toBe(false);
    expect(isValidWeeklyEditionPayload({ youtube_video_id: {} })).toBe(false);
  });

  it('rejects non-array items property', () => {
    expect(isValidWeeklyEditionPayload({ items: 'not-an-array' })).toBe(false);
    expect(isValidWeeklyEditionPayload({ items: {} })).toBe(false);
  });

  it('rejects items missing required fields', () => {
    expect(
      isValidWeeklyEditionPayload({
        items: [{ title_tr: 'Test', summary_tr: 'Test', source: 'HN' }], // missing url
      })
    ).toBe(false);

    expect(
      isValidWeeklyEditionPayload({
        items: [{ url: '', title_tr: 'Test', summary_tr: 'Test', source: 'HN' }], // empty url
      })
    ).toBe(false);

    expect(
      isValidWeeklyEditionPayload({
        items: [{ url: 'https://test.com', summary_tr: 'Test', source: 'HN' }], // missing title_tr
      })
    ).toBe(false);

    expect(
      isValidWeeklyEditionPayload({
        items: [{ url: 'https://test.com', title_tr: 'Test', source: 'HN' }], // missing summary_tr
      })
    ).toBe(false);

    expect(
      isValidWeeklyEditionPayload({
        items: [{ url: 'https://test.com', title_tr: 'Test', summary_tr: 'Test' }], // missing source
      })
    ).toBe(false);

    expect(
      isValidWeeklyEditionPayload({
        items: [
          {
            url: 'https://test.com',
            title_tr: 'Test',
            summary_tr: 'Test',
            source: 'HN',
            image_url: 123, // invalid image_url type
          },
        ],
      })
    ).toBe(false);

    expect(
      isValidWeeklyEditionPayload({
        items: [
          {
            url: 'javascript:alert(1)',
            title_tr: 'Test',
            summary_tr: 'Test',
            source: 'HN',
          },
        ],
      })
    ).toBe(false);

    expect(
      isValidWeeklyEditionPayload({
        items: [
          {
            url: 'https://test.com',
            title_tr: 'Test',
            summary_tr: 'Test',
            source: 'HN',
            image_url: 'javascript:alert(1)',
          },
        ],
      })
    ).toBe(false);

    expect(
      isValidWeeklyEditionPayload({
        youtube_video_id: 'bad/id? onload=alert(1)',
      })
    ).toBe(false);
  });
});

import { app } from './index';

describe('Weekly Admin API Endpoints', () => {
  const SECRET = 'test-ingestion-secret';
  let articlesTable: any[] = [];
  let candidatesTable: any[] = [];
  let editionsTable = new Map<string, any>();

  const mockDb: any = {
    prepare(query: string) {
      const createRunner = (params: any[] = []) => ({
        query,
        params,
        async all() {
          if (query.includes('FROM articles')) {
            return { results: articlesTable };
          }
          if (query.includes('weekly_candidates') && query.includes('week IN (SELECT week FROM weekly_editions')) {
            const usedWeeks = Array.from(editionsTable.values())
              .filter((e) => (e.status === 'approved' || e.status === 'published') && e.week !== params[0])
              .map((e) => e.week);
            return { results: candidatesTable.filter((c) => c.cluster_id && usedWeeks.includes(c.week)) };
          }
          if (query.includes('weekly_candidates')) {
            const week = params[0];
            const rows = candidatesTable.filter((c) => c.week === week);
            return { results: rows };
          }
          if (query.includes('FROM weekly_editions') || query.includes('weekly_editions')) {
            let editions = Array.from(editionsTable.values());
            if (query.includes("status IN ('approved', 'published')")) {
              editions = editions.filter((e) => e.status === 'approved' || e.status === 'published');
            }
            if (query.includes('week != ?')) {
              editions = editions.filter((e) => e.week !== params[0]);
            }
            editions.sort((a, b) => b.week.localeCompare(a.week));
            return { results: editions };
          }
          return { results: [] };
        },
        async first() {
          if (query.includes('weekly_editions')) {
            const week = params[0];
            const edition = editionsTable.get(week) || null;
            if (!edition) return null;
            if (query.includes("status IN ('approved', 'published')")) {
              if (edition.status !== 'approved' && edition.status !== 'published') {
                return null;
              }
            }
            return edition;
          }
          return null;
        },
        async run() {
          if (query.includes('INSERT INTO weekly_editions')) {
            const [week, status, title_tr, intro_tr, items_json, script_json, youtube_video_id, published_at] = params;
            editionsTable.set(week, {
              week,
              status,
              title_tr,
              intro_tr,
              items_json,
              script_json,
              youtube_video_id,
              published_at,
              updated_at: new Date().toISOString(),
            });
            return { success: true };
          }
          if (query.includes('UPDATE weekly_editions')) {
            const [status, title_tr, intro_tr, items_json, script_json, youtube_video_id, published_at, week] = params;
            const existing = editionsTable.get(week) || {};
            editionsTable.set(week, {
              ...existing,
              status,
              title_tr,
              intro_tr,
              items_json,
              script_json,
              youtube_video_id,
              published_at,
              updated_at: new Date().toISOString(),
            });
            return { success: true };
          }
          return { success: true };
        },
      });

      return {
        ...createRunner([]),
        bind(...params: any[]) {
          return createRunner(params);
        },
      };
    },
    async batch(statements: any[]) {
      for (const stmt of statements) {
        if (stmt.query && stmt.query.includes('weekly_candidates')) {
          const [
            week,
            url,
            article_id,
            title,
            source,
            summary,
            image_url,
            is_liked,
            follower_likes,
            importance_score,
            source_count,
            seen_count,
            cluster_id,
            curator_comment
          ] = stmt.params;

          const existing = candidatesTable.find((c) => c.week === week && c.url === url);
          if (existing) {
            existing.is_liked = Math.max(existing.is_liked, is_liked);
            existing.follower_likes = Math.max(existing.follower_likes, follower_likes);
            existing.importance_score = Math.max(existing.importance_score, importance_score);
            existing.source_count = Math.max(existing.source_count, source_count);
            existing.seen_count = Math.max(existing.seen_count, seen_count);
            existing.curator_comment = curator_comment ?? existing.curator_comment ?? null;
          } else {
            candidatesTable.push({
              week,
              url,
              article_id,
              title,
              source,
              summary,
              image_url,
              is_liked,
              follower_likes,
              importance_score,
              source_count,
              seen_count,
              cluster_id,
              curator_comment: curator_comment ?? null
            });
          }
        }
      }
      return [];
    }
  };

  const env: any = {
    news_db: mockDb,
    INGESTION_SECRET: SECRET,
  };

  beforeEach(() => {
    articlesTable = [];
    candidatesTable = [
      {
        week: '2026-W42',
        url: 'https://example.com/story1',
        title: 'Story 1',
        source: 'hn',
        is_liked: 1,
        follower_likes: 5,
        importance_score: 2.5,
      },
    ];
    editionsTable.clear();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.request('https://news.emre.xyz/api/admin/weekly/2026-W42/candidates', {}, env);
    expect(res.status).toBe(401);
    const json = (await res.json()) as any;
    expect(json.error).toBe('Unauthorized');
  });

  it('rejects invalid week format with 400', async () => {
    const res = await app.request(
      'https://news.emre.xyz/api/admin/weekly/not-a-week/candidates',
      {
        headers: { Authorization: `Bearer ${SECRET}` },
      },
      env
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error).toBe('Bad Request');
  });

  it('returns candidate rows for a valid week', async () => {
    const res = await app.request(
      'https://news.emre.xyz/api/admin/weekly/2026-W42/candidates',
      {
        headers: { Authorization: `Bearer ${SECRET}` },
      },
      env
    );
    expect(res.status).toBe(200);
    const candidates = (await res.json()) as any;
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].url).toBe('https://example.com/story1');
  });

  it('returns 404 when getting non-existent edition', async () => {
    const res = await app.request(
      'https://news.emre.xyz/api/admin/weekly/2026-W42',
      {
        headers: { Authorization: `Bearer ${SECRET}` },
      },
      env
    );
    expect(res.status).toBe(404);
  });

  it('rejects PUT with invalid payload with 400', async () => {
    const res = await app.request(
      'https://news.emre.xyz/api/admin/weekly/2026-W42',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'invalid_status' }),
      },
      env
    );
    expect(res.status).toBe(400);
  });

  it('creates draft edition with PUT and fetches with GET', async () => {
    const putRes = await app.request(
      'https://news.emre.xyz/api/admin/weekly/2026-W42',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: 'draft',
          title_tr: 'Haftalık Haberler',
          intro_tr: 'Giriş yazısı',
          items: [
            {
              url: 'https://example.com/story1',
              title_tr: 'Haber Başlığı',
              summary_tr: 'Özet',
              source: 'hn',
            },
          ],
        }),
      },
      env
    );
    expect(putRes.status).toBe(200);
    const putData = (await putRes.json()) as any;
    expect(putData.status).toBe('draft');
    expect(putData.title_tr).toBe('Haftalık Haberler');
    expect(putData.items).toHaveLength(1);

    const getRes = await app.request(
      'https://news.emre.xyz/api/admin/weekly/2026-W42',
      {
        headers: { Authorization: `Bearer ${SECRET}` },
      },
      env
    );
    expect(getRes.status).toBe(200);
    const getData = (await getRes.json()) as any;
    expect(getData.title_tr).toBe('Haftalık Haberler');
    expect(getData.status).toBe('draft');
    expect(getData.items[0].title_tr).toBe('Haber Başlığı');
  });

  it('advances status from draft to approved to published, setting published_at', async () => {
    // 1. Create draft
    await app.request(
      'https://news.emre.xyz/api/admin/weekly/2026-W42',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'draft', title_tr: 'Draft Title' }),
      },
      env
    );

    // 2. Advance to approved
    const approvedRes = await app.request(
      'https://news.emre.xyz/api/admin/weekly/2026-W42',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'approved' }),
      },
      env
    );
    expect(approvedRes.status).toBe(200);
    const approvedData = (await approvedRes.json()) as any;
    expect(approvedData.status).toBe('approved');
    expect(approvedData.title_tr).toBe('Draft Title'); // preserved

    // 3. Advance to published
    const publishedRes = await app.request(
      'https://news.emre.xyz/api/admin/weekly/2026-W42',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'published', youtube_video_id: 'vid123' }),
      },
      env
    );
    expect(publishedRes.status).toBe(200);
    const publishedData = (await publishedRes.json()) as any;
    expect(publishedData.status).toBe('published');
    expect(publishedData.youtube_video_id).toBe('vid123');
    expect(publishedData.published_at).toBeTruthy();
  });

  it('rejects backward status transition with 409 Conflict', async () => {
    // Seed approved edition
    await app.request(
      'https://news.emre.xyz/api/admin/weekly/2026-W42',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'approved', title_tr: 'Approved' }),
      },
      env
    );

    // Try moving back to draft
    const backwardRes = await app.request(
      'https://news.emre.xyz/api/admin/weekly/2026-W42',
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status: 'draft' }),
      },
      env
    );
    expect(backwardRes.status).toBe(409);
    const json = (await backwardRes.json()) as any;
    expect(json.error).toBe('Conflict');
  });

  describe('cross-week duplicate guard', () => {
    const PRIOR_WEEK = '2026-W41';
    const putEdition = (week: string, body: Record<string, unknown>) =>
      app.request(
        `https://news.emre.xyz/api/admin/weekly/${week}`,
        {
          method: 'PUT',
          headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        env
      );
    const makeItem = (url: string, extra: Record<string, unknown> = {}) => ({
      url,
      title_tr: 'Başlık',
      summary_tr: 'Özet',
      source: 'hn',
      ...extra,
    });
    const seedEdition = (week: string, status: string, items: unknown[]) =>
      editionsTable.set(week, {
        week,
        status,
        title_tr: null,
        intro_tr: null,
        items_json: JSON.stringify(items),
        script_json: null,
        youtube_video_id: null,
        published_at: null,
      });

    it.each(['approved', 'published'])('rejects an exact normalized URL already in a %s edition', async (priorStatus) => {
      seedEdition(PRIOR_WEEK, priorStatus, [makeItem('https://example.com/story')]);
      const res = await putEdition('2026-W42', {
        status: 'approved',
        items: [makeItem('http://example.com/story/?utm_source=x#top')],
      });
      expect(res.status).toBe(409);
      const json = (await res.json()) as any;
      expect(json.conflicts).toEqual([
        {
          current_url: 'http://example.com/story/?utm_source=x#top',
          prior_url: 'https://example.com/story',
          prior_week: PRIOR_WEEK,
          reason: 'normalized_url',
        },
      ]);
      expect(editionsTable.has('2026-W42')).toBe(false);
    });

    it('rejects a different URL that shares a stored item cluster id', async () => {
      seedEdition(PRIOR_WEEK, 'published', [makeItem('https://a.com/one', { cluster_id: 'cluster-7' })]);
      const res = await putEdition('2026-W42', {
        status: 'approved',
        items: [makeItem('https://b.com/two', { cluster_id: 'cluster-7' })],
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as any).conflicts[0].reason).toBe('cluster_id');
    });

    it('derives cluster ids from candidate snapshots for legacy items and incoming items', async () => {
      seedEdition(PRIOR_WEEK, 'approved', [makeItem('https://a.com/one')]);
      candidatesTable.push(
        { week: PRIOR_WEEK, url: 'https://a.com/one', cluster_id: 'cluster-3' },
        { week: '2026-W42', url: 'https://b.com/two', cluster_id: 'cluster-3' }
      );
      const res = await putEdition('2026-W42', { status: 'approved', items: [makeItem('https://b.com/two')] });
      expect(res.status).toBe(409);
    });

    it('allows distinct follow-up stories with similar titles', async () => {
      seedEdition(PRIOR_WEEK, 'published', [makeItem('https://a.com/launch', { cluster_id: 'cluster-1' })]);
      const res = await putEdition('2026-W42', {
        status: 'approved',
        items: [makeItem('https://a.com/launch-part-2', { cluster_id: 'cluster-2', title_tr: 'Başlık' })],
      });
      expect(res.status).toBe(200);
    });

    it('ignores draft editions when checking history', async () => {
      seedEdition(PRIOR_WEEK, 'draft', [makeItem('https://example.com/story')]);
      const res = await putEdition('2026-W42', { status: 'approved', items: [makeItem('https://example.com/story')] });
      expect(res.status).toBe(200);
    });

    it('allows saving duplicates while the edition stays a draft', async () => {
      seedEdition(PRIOR_WEEK, 'published', [makeItem('https://example.com/story')]);
      const res = await putEdition('2026-W42', { status: 'draft', items: [makeItem('https://example.com/story')] });
      expect(res.status).toBe(200);
    });

    it('blocks advancing a draft whose stored items repeat history (no items in payload)', async () => {
      seedEdition(PRIOR_WEEK, 'published', [makeItem('https://example.com/story')]);
      seedEdition('2026-W42', 'draft', [makeItem('https://example.com/story')]);
      const res = await putEdition('2026-W42', { status: 'approved' });
      expect(res.status).toBe(409);
      expect(editionsTable.get('2026-W42').status).toBe('draft');
    });

    it('blocks reintroducing a historical story into an already approved edition', async () => {
      seedEdition(PRIOR_WEEK, 'published', [makeItem('https://example.com/story')]);
      seedEdition('2026-W42', 'approved', [makeItem('https://example.com/fresh')]);
      const res = await putEdition('2026-W42', { items: [makeItem('https://example.com/story')] });
      expect(res.status).toBe(409);
    });

    it('does not re-validate an approved edition on metadata-only updates and ignores its own week', async () => {
      seedEdition('2026-W42', 'approved', [makeItem('https://example.com/story')]);
      const res = await putEdition('2026-W42', { status: 'published', youtube_video_id: 'abc123' });
      expect(res.status).toBe(200);
      const same = await putEdition('2026-W42', { status: 'published', items: [makeItem('https://example.com/story')] });
      expect(same.status).toBe(200);
    });

    it('requires admin auth and a valid week for the used-stories endpoint', async () => {
      const unauth = await app.request('https://news.emre.xyz/api/admin/weekly/2026-W42/used-stories', {}, env);
      expect(unauth.status).toBe(401);
      const bad = await app.request(
        'https://news.emre.xyz/api/admin/weekly/nope/used-stories',
        { headers: { Authorization: `Bearer ${SECRET}` } },
        env
      );
      expect(bad.status).toBe(400);
    });

    it('lists only approved/published identities from other weeks', async () => {
      seedEdition(PRIOR_WEEK, 'published', [makeItem('https://example.com/story/')]);
      seedEdition('2026-W40', 'draft', [makeItem('https://example.com/draft')]);
      seedEdition('2026-W42', 'approved', [makeItem('https://example.com/self')]);
      const res = await app.request(
        'https://news.emre.xyz/api/admin/weekly/2026-W42/used-stories',
        { headers: { Authorization: `Bearer ${SECRET}` } },
        env
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as any[];
      expect(json.map((i) => [i.week, i.normalized_url])).toEqual([[PRIOR_WEEK, 'https://example.com/story']]);
    });
  });

  describe('POST /api/admin/weekly/snapshot', () => {
    it('rejects unauthenticated snapshot requests with 401', async () => {
      const res = await app.request('https://news.emre.xyz/api/admin/weekly/snapshot', { method: 'POST' }, env);
      expect(res.status).toBe(401);
      const json = (await res.json()) as any;
      expect(json.error).toBe('Unauthorized');
    });

    it('captures live articles into weekly_candidates and is idempotent', async () => {
      // Seed live articles in articlesTable
      articlesTable = [
        {
          id: 'story-1',
          url: 'https://example.com/live-story-1',
          title: 'Top Story 1',
          source: 'hn',
          summary: 'Summary 1',
          image_url: 'https://example.com/img1.png',
          is_liked: 0,
          follower_likes: 2,
          importance_score: 3.0,
          source_count: 2,
          seen_count: 1,
          cluster_id: 'c1',
          created_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          expires_at: '2026-10-25 00:00:00'
        },
        {
          id: 'story-2',
          url: 'https://example.com/live-story-2',
          title: 'Liked Story 2',
          source: 'reddit',
          summary: 'Summary 2',
          image_url: null,
          is_liked: 1,
          follower_likes: 0,
          importance_score: 1.0,
          source_count: 1,
          seen_count: 1,
          cluster_id: null,
          created_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          expires_at: '2026-10-25 00:00:00'
        }
      ];

      // Initial snapshot call
      const res1 = await app.request(
        'https://news.emre.xyz/api/admin/weekly/snapshot',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${SECRET}` }
        },
        env
      );
      expect(res1.status).toBe(200);
      const data1 = (await res1.json()) as any;
      expect(data1.success).toBe(true);
      expect(data1.candidateCount).toBe(2);
      expect(data1.week).toMatch(/^\d{4}-W\d{2}$/);

      // Verify candidates stored in candidatesTable
      const week = data1.week;
      const initialRows = candidatesTable.filter(c => c.week === week);
      expect(initialRows).toHaveLength(2);
      expect(initialRows.map(r => r.url)).toContain('https://example.com/live-story-1');
      expect(initialRows.map(r => r.url)).toContain('https://example.com/live-story-2');

      // Update articlesTable with increased signals (e.g. more follower_likes, now liked)
      articlesTable[0].follower_likes = 10;
      articlesTable[0].is_liked = 1;
      articlesTable[0].importance_score = 4.5;

      // Second snapshot call
      const res2 = await app.request(
        'https://news.emre.xyz/api/admin/weekly/snapshot',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${SECRET}` }
        },
        env
      );
      expect(res2.status).toBe(200);
      const data2 = (await res2.json()) as any;
      expect(data2.candidateCount).toBe(2);

      // Verify no duplicates were created, and MAX() values were preserved
      const updatedRows = candidatesTable.filter(c => c.week === week);
      expect(updatedRows).toHaveLength(2);
      const row1 = updatedRows.find(r => r.url === 'https://example.com/live-story-1');
      expect(row1).toBeDefined();
      expect(row1!.follower_likes).toBe(10);
      expect(row1!.is_liked).toBe(1);
      expect(row1!.importance_score).toBe(4.5);
    });
  });
});

describe('Public Turkish Weekly SSR Pages', () => {
  let editionsTable = new Map<string, any>();

  const mockDb: any = {
    prepare(query: string) {
      const createRunner = (params: any[] = []) => ({
        query,
        params,
        async all() {
          if (query.includes('FROM weekly_editions') || query.includes('weekly_editions')) {
            let editions = Array.from(editionsTable.values());
            if (query.includes("status IN ('approved', 'published')")) {
              editions = editions.filter((e) => e.status === 'approved' || e.status === 'published');
            }
            editions.sort((a, b) => b.week.localeCompare(a.week));
            return { results: editions };
          }
          return { results: [] };
        },
        async first() {
          if (query.includes('weekly_editions')) {
            const week = params[0];
            const edition = editionsTable.get(week) || null;
            if (!edition) return null;
            if (query.includes("status IN ('approved', 'published')")) {
              if (edition.status !== 'approved' && edition.status !== 'published') {
                return null;
              }
            }
            return edition;
          }
          return null;
        }
      });

      return {
        ...createRunner([]),
        bind(...params: any[]) {
          return createRunner(params);
        }
      };
    }
  };

  const env: any = {
    news_db: mockDb,
    USE_EMRE_THEME: 'false'
  };

  beforeEach(() => {
    editionsTable.clear();
    // Seed test editions
    editionsTable.set('2026-W42', {
      week: '2026-W42',
      status: 'approved',
      title_tr: 'Haftalık Sistem Mimarisi Raporu',
      intro_tr: 'Bu hafta yapay zeka ve dağıtık sistemler gündemdeydi.',
      items_json: JSON.stringify([
        {
          url: 'https://example.com/story-1',
          title_tr: 'Rust ile Dağıtık Konsensüs',
          summary_tr: 'Raft algoritmasının güvenli ve hızlı uygulanması.',
          source: 'hackernews',
          image_url: 'https://example.com/img1.png'
        }
      ]),
      youtube_video_id: 'abc123xyz',
      published_at: '2026-10-18T10:00:00Z',
      updated_at: '2026-10-18T10:00:00Z'
    });

    editionsTable.set('2026-W41', {
      week: '2026-W41',
      status: 'published',
      title_tr: 'Veritabanı İndeksleme Teknikleri',
      intro_tr: 'PostgreSQL ve SQLite optimizasyonları.',
      items_json: JSON.stringify([
        {
          url: 'https://example.com/story-2',
          title_tr: 'B-Tree vs LSM-Tree Karşılaştırması',
          summary_tr: 'Depolama motorlarının performans dinamikleri.',
          source: 'lobsters'
        }
      ]),
      youtube_video_id: null,
      published_at: '2026-10-11T10:00:00Z',
      updated_at: '2026-10-11T10:00:00Z'
    });

    editionsTable.set('2026-W43', {
      week: '2026-W43',
      status: 'draft',
      title_tr: 'Taslak Bülten',
      intro_tr: 'Henüz onaylanmamış taslak.',
      items_json: '[]',
      youtube_video_id: null,
      published_at: null,
      updated_at: '2026-10-19T10:00:00Z'
    });
  });

  describe('GET /weekly', () => {
    it('returns 200 with HTML list of approved and published editions in descending order', async () => {
      const res = await app.request('https://news.emre.xyz/weekly', {}, env);
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain('lang="tr"');
      expect(html).toContain('Haftalık Bültenler');
      expect(html).toContain('2026-W42');
      expect(html).toContain('Haftalık Sistem Mimarisi Raporu');
      expect(html).toContain('2026-W41');
      expect(html).toContain('Veritabanı İndeksleme Teknikleri');

      // Draft editions must NOT be included
      expect(html).not.toContain('2026-W43');
      expect(html).not.toContain('Taslak Bülten');

      // Video badge indicator check
      expect(html).toContain('Video');

      // Navigation check
      expect(html).toContain('href="/weekly"');
      expect(html).toContain('Haftalık');
    });

    it('displays empty state when no approved or published editions exist', async () => {
      editionsTable.clear();
      const res = await app.request('https://news.emre.xyz/weekly', {}, env);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Henüz yayınlanmış bülten bulunmuyor');
    });
  });

  describe('GET /weekly/:week', () => {
    it('returns 200 with full edition details for approved edition', async () => {
      const res = await app.request('https://news.emre.xyz/weekly/2026-W42', {}, env);
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain('lang="tr"');
      expect(html).toContain('Haftalık Sistem Mimarisi Raporu');
      expect(html).toContain('Bu hafta yapay zeka ve dağıtık sistemler gündemdeydi.');
      expect(html).toContain('Rust ile Dağıtık Konsensüs');
      expect(html).toContain('Raft algoritmasının güvenli ve hızlı uygulanması.');
      expect(html).toContain('https://example.com/story-1');

      // YouTube embed check
      expect(html).toContain('https://www.youtube-nocookie.com/embed/abc123xyz');
      expect(html).toContain('iframe');
    });

    it('returns 200 without YouTube embed when youtube_video_id is null', async () => {
      const res = await app.request('https://news.emre.xyz/weekly/2026-W41', {}, env);
      expect(res.status).toBe(200);
      const html = await res.text();

      expect(html).toContain('Veritabanı İndeksleme Teknikleri');
      expect(html).toContain('B-Tree vs LSM-Tree Karşılaştırması');
      expect(html).not.toContain('youtube-nocookie.com/embed');
    });

    it('returns 404 for draft edition', async () => {
      const res = await app.request('https://news.emre.xyz/weekly/2026-W43', {}, env);
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain('Bülten Bulunamadı');
      expect(html).toContain('lang="tr"');
    });

    it('returns 404 for non-existent week', async () => {
      const res = await app.request('https://news.emre.xyz/weekly/2026-W01', {}, env);
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain('Bülten Bulunamadı');
    });

    it('returns 404 for invalid week string format', async () => {
      const res = await app.request('https://news.emre.xyz/weekly/invalid-week-format', {}, env);
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain('Bülten Bulunamadı');
    });

    it('returns 404 for out-of-range week numbers like W00 and W54', async () => {
      const resW00 = await app.request('https://news.emre.xyz/weekly/2026-W00', {}, env);
      expect(resW00.status).toBe(404);

      const resW54 = await app.request('https://news.emre.xyz/weekly/2026-W54', {}, env);
      expect(resW54.status).toBe(404);
    });
  });

  describe('Security Audit: Admin & Bootstrap Route Guards', () => {
    const guardedRoutes: Array<{ method: string; path: string }> = [
      { method: 'GET', path: '/api/debug' },
      { method: 'GET', path: '/api/admin/ingest' },
      { method: 'POST', path: '/api/admin/ingest' },
      { method: 'GET', path: '/test-ingestion' },
      { method: 'POST', path: '/test-ingestion' },
      { method: 'GET', path: '/api/admin/weekly/2026-W42/candidates' },
      { method: 'GET', path: '/api/admin/weekly/2026-W42' },
      { method: 'PUT', path: '/api/admin/weekly/2026-W42' },
      { method: 'POST', path: '/api/admin/weekly/snapshot' },
      { method: 'GET', path: '/bootstrap-reddit-history' },
      { method: 'GET', path: '/bootstrap-lobsters-history?token=abc' },
      { method: 'GET', path: '/bootstrap-hn-history?id=testuser' },
      { method: 'POST', path: '/bootstrap-hn-json' },
    ];

    it('guards every admin and bootstrap route with 401 when unauthenticated', async () => {
      for (const route of guardedRoutes) {
        const res = await app.request(
          `https://news.emre.xyz${route.path}`,
          {
            method: route.method,
            headers:
              route.method === 'POST' || route.method === 'PUT'
                ? { 'Content-Type': 'application/json' }
                : undefined,
            body:
              route.method === 'POST' || route.method === 'PUT'
                ? JSON.stringify({})
                : undefined,
          },
          { ...env, INGESTION_SECRET: 'test-secret' }
        );
        expect(res.status, `Expected 401 for ${route.method} ${route.path}`).toBe(401);
      }
    });
  });
});





describe('weekly story identity helpers', () => {
  const item = (url: string, cluster_id?: string | null) => ({
    url,
    cluster_id,
    title_tr: 't',
    summary_tr: 's',
    source: 'hn',
  });

  it('normalizes scheme, tracking params, fragments, query order and trailing slashes', () => {
    expect(normalizeWeeklyUrl(' http://Example.com/a/?b=2&utm_medium=x&a=1&gclid=z#f ')).toBe('https://example.com/a?a=1&b=2');
    expect(normalizeWeeklyUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('rejects non-http and malformed URLs', () => {
    expect(normalizeWeeklyUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeWeeklyUrl('not a url')).toBeNull();
  });

  it('throws contextual errors for corrupt stored edition items', () => {
    expect(() => buildWeeklyUsedIdentities([{ week: '2026-W41', items_json: '{' }], [])).toThrow(/2026-W41/);
    expect(() => buildWeeklyUsedIdentities([{ week: '2026-W41', items_json: '{}' }], [])).toThrow(/expected an array/);
    expect(() => buildWeeklyUsedIdentities([{ week: '2026-W41', items_json: '[{"url":"x"}]' }], [])).toThrow(/invalid item/);
  });

  it('matches by URL first, then by cluster, and ignores items without identity overlap', () => {
    const used = buildWeeklyUsedIdentities(
      [{ week: '2026-W41', items_json: JSON.stringify([item('https://a.com/1', 'c1')]) }],
      []
    );
    const conflicts = findWeeklyDuplicateConflicts(
      [item('https://a.com/1/', 'c9'), item('https://b.com/2', 'c1'), item('https://c.com/3', 'c3'), item('https://d.com/4')],
      used
    );
    expect(conflicts.map((c) => c.reason)).toEqual(['normalized_url', 'cluster_id']);
  });
});

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
import { extractCuratorComment, buildEmbeddingText, snapshotWeeklyCandidates } from './index';
import { generateRssFeed } from './views/rss';

describe('Curator Comments, Nostr Highlight Flow, SSR & RSS Rendering', () => {
  it('extracts curator comment from explicit payload or Nostr event content and ignores generic Liked prefix', () => {
    expect(
      extractCuratorComment(
        'Great deep-dive into zero-copy IO.',
        'Liked article: Foo\nhttps://example.com/a',
        ['https://example.com/a']
      )
    ).toBe('Great deep-dive into zero-copy IO.');

    expect(
      extractCuratorComment(
        undefined,
        'Crucial read on SQLite WAL internals.\n\nhttps://news.ycombinator.com/item?id=42',
        ['https://example.com/sqlite', 'https://news.ycombinator.com/item?id=42']
      )
    ).toBe('Crucial read on SQLite WAL internals.');

    expect(
      extractCuratorComment(
        '',
        'Liked article: Some Story\nhttps://example.com/story',
        ['https://example.com/story']
      )
    ).toBeNull();
  });

  it('includes curatorComment in buildEmbeddingText when provided', () => {
    const text = buildEmbeddingText({
      title: 'Rust Kernel Abstractions',
      source: 'hackernews',
      curatorComment: 'Clean PCI driver safety model.',
      description: 'Kernel update',
    });
    expect(text).toContain('Curator Comment: Clean PCI driver safety model.');
  });

  it('persists curator_comment on POST /api/articles/:id/like for authorized curator and updates AI taste profile', async () => {
    const curatorSk = generateSecretKey();
    const curatorPubkey = getPublicKey(curatorSk);
    const followerSk = generateSecretKey();

    const storedArticle: any = {
      id: 'hn-777',
      title: 'Deterministic Simulation Testing in Production',
      url: 'https://example.com/dst',
      source: 'hackernews',
      summary: 'How deterministic simulation catches distributed bugs.',
      is_liked: 0,
      follower_likes: 2,
      curator_comment: null,
      created_at: new Date().toISOString(),
      expires_at: '2099-01-01 00:00:00',
    };
    const storedCandidate: any = {
      week: '2026-W45',
      url: 'https://example.com/dst',
      article_id: 'hn-777',
      title: storedArticle.title,
      source: 'hackernews',
      is_liked: 0,
      follower_likes: 2,
      curator_comment: null,
    };

    const embeddedTexts: string[] = [];
    const tastePrompts: string[] = [];
    let savedTasteProfile: string | null = null;

    const mockDb: any = {
      prepare(query: string) {
        const runner = (params: any[] = []) => ({
          async first() {
            if (query.includes('FROM articles WHERE id = ?')) {
              return params[0] === storedArticle.id ? storedArticle : null;
            }
            if (query.includes('MAX(created_at)')) {
              return { last_curated_at: storedArticle.created_at };
            }
            return null;
          },
          async all() {
            if (query.includes('WHERE is_liked = 1')) {
              return { results: storedArticle.is_liked ? [storedArticle] : [] };
            }
            if (query.includes('FROM articles')) {
              return { results: [storedArticle] };
            }
            return { results: [] };
          },
          async run() {
            if (query.includes('UPDATE articles SET is_liked = 1')) {
              const [comment] = params;
              storedArticle.is_liked = 1;
              storedArticle.follower_likes += 1;
              storedArticle.curator_comment = comment ?? storedArticle.curator_comment;
            } else if (query.includes('UPDATE weekly_candidates SET is_liked = 1')) {
              const [comment] = params;
              storedCandidate.is_liked = 1;
              storedCandidate.follower_likes += 1;
              storedCandidate.curator_comment = comment ?? storedCandidate.curator_comment;
            } else if (query.includes('UPDATE articles SET follower_likes = follower_likes + 1')) {
              storedArticle.follower_likes += 1;
            } else if (query.includes("INSERT INTO user_preferences (key, value")) {
              savedTasteProfile = params[0];
            }
            return { success: true };
          },
        });
        return {
          ...runner([]),
          bind(...params: any[]) {
            return runner(params);
          },
        };
      },
      async batch(statements: any[]) {
        return statements;
      },
    };

    const env: any = {
      news_db: mockDb,
      AUTHORIZED_NOSTR_PUBKEY: curatorPubkey,
      USE_EMRE_THEME: 'false',
      AI: {
        async run(model: string, input: any) {
          if (model.includes('bge-base')) {
            embeddedTexts.push(...(input.text || []));
            return { data: [[0.1, 0.2, 0.3]] };
          }
          if (input?.messages) {
            const userMsg = input.messages.find((m: any) => m.role === 'user')?.content || '';
            tastePrompts.push(userMsg);
          }
          return { response: 'Prefers deterministic systems and simulation testing.' };
        },
      },
      VECTORIZE: {
        async upsert() {
          return { mutationId: 'm1' };
        },
      },
    };

    // 1. Follower like increments follower_likes without setting curator_comment
    const followerEvent = finalizeEvent(
      {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['r', 'https://news.ycombinator.com/item?id=777']],
        content: 'Check out this curated article: Deterministic Simulation Testing in Production\nhttps://news.ycombinator.com/item?id=777',
      },
      followerSk
    );
    const followerRes = await app.request(
      'https://news.emre.xyz/api/articles/hn-777/like',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: followerEvent }),
      },
      env
    );
    expect(followerRes.status).toBe(200);
    expect(storedArticle.is_liked).toBe(0);
    expect(storedArticle.follower_likes).toBe(3);
    expect(storedArticle.curator_comment).toBeNull();

    // 2. Curator highlight with commentary persists curator_comment and trains AI
    const curatorNote = 'FoundationDB-style deterministic testing should be standard for stateful edge services.';
    const curatorEvent = finalizeEvent(
      {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['r', 'https://news.ycombinator.com/item?id=777']],
        content: `${curatorNote}\n\nhttps://news.ycombinator.com/item?id=777`,
      },
      curatorSk
    );

    const curatorRes = await app.request(
      'https://news.emre.xyz/api/articles/hn-777/like',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: curatorEvent }),
      },
      env
    );
    expect(curatorRes.status).toBe(200);
    const curatorJson = (await curatorRes.json()) as any;
    expect(curatorJson.success).toBe(true);
    expect(curatorJson.curator_comment).toBe(curatorNote);
    expect(storedArticle.is_liked).toBe(1);
    expect(storedArticle.follower_likes).toBe(4);
    expect(storedArticle.curator_comment).toBe(curatorNote);
    expect(storedCandidate.curator_comment).toBe(curatorNote);
    expect(embeddedTexts[0]).toContain(`Curator Comment: ${curatorNote}`);
    expect(tastePrompts[0]).toContain(curatorNote);
    expect(savedTasteProfile).toContain('deterministic systems');

    // 3. SSR Home Feed and Article Permalink render .curator-note callout
    const feedRes = await app.request('https://news.emre.xyz/', {}, env);
    expect(feedRes.status).toBe(200);
    const feedHtml = await feedRes.text();
    expect(feedHtml).toContain('curator-note');
    expect(feedHtml).toContain('Curator Note');
    expect(feedHtml).toContain(curatorNote);

    const detailRes = await app.request('https://news.emre.xyz/article/hn-777', {}, env);
    expect(detailRes.status).toBe(200);
    const detailHtml = await detailRes.text();
    expect(detailHtml).toContain('curator-note');
    expect(detailHtml).toContain(curatorNote);

    // 4. RSS feed includes curator note in item description
    const rssXml = generateRssFeed([storedArticle], 'https://news.emre.xyz');
    expect(rssXml).toContain(`Curator note: ${curatorNote}`);
    expect(rssXml).toContain(storedArticle.summary);
  });

  it('propagates curator_comment into weekly_candidates during snapshotWeeklyCandidates and preserves via COALESCE', async () => {
    const candidatesTable: any[] = [];
    let liveArticles: any[] = [
      {
        id: 'hn-501',
        url: 'https://example.com/curated-link',
        title: 'Curated Link With Note',
        source: 'hackernews',
        summary: 'Summary text',
        is_liked: 1,
        follower_likes: 3,
        importance_score: 3.2,
        source_count: 2,
        seen_count: 2,
        cluster_id: null,
        curator_comment: 'Must-read architecture postmortem.',
        created_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        expires_at: '2099-01-01 00:00:00',
      },
    ];

    const mockDb: any = {
      prepare(query: string) {
        return {
          bind(...params: any[]) {
            return {
              query,
              params,
              async all() {
                return { results: liveArticles };
              },
            };
          },
          async all() {
            return { results: liveArticles };
          },
        };
      },
      async batch(statements: any[]) {
        for (const stmt of statements) {
          const [
            week,
            url,
            article_id,
            title,
            source,
            summary,
            image_url,
            is_liked,
            follower_likes,
            importance_score,
            source_count,
            seen_count,
            cluster_id,
            curator_comment,
          ] = stmt.params;
          const existing = candidatesTable.find((c) => c.week === week && c.url === url);
          if (existing) {
            existing.curator_comment = curator_comment ?? existing.curator_comment ?? null;
          } else {
            candidatesTable.push({
              week,
              url,
              article_id,
              title,
              source,
              summary,
              image_url,
              is_liked,
              follower_likes,
              importance_score,
              source_count,
              seen_count,
              cluster_id,
              curator_comment,
            });
          }
        }
        return [];
      },
    };

    await snapshotWeeklyCandidates({ news_db: mockDb } as any, new Date('2026-10-18T03:00:00Z'));
    expect(candidatesTable).toHaveLength(1);
    expect(candidatesTable[0].curator_comment).toBe('Must-read architecture postmortem.');

    // Re-snapshot when live row has null curator_comment preserves existing stored comment
    liveArticles[0] = { ...liveArticles[0], curator_comment: null };
    await snapshotWeeklyCandidates({ news_db: mockDb } as any, new Date('2026-10-18T03:00:00Z'));
    expect(candidatesTable[0].curator_comment).toBe('Must-read architecture postmortem.');
  });
});

