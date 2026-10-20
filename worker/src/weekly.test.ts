import { describe, it, expect, beforeEach } from 'vitest';
import {
  isValidIsoWeek,
  canTransitionStatus,
  isValidWeeklyEditionPayload,
  WeeklyEditionPayload,
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
            cluster_id
          ] = stmt.params;

          const existing = candidatesTable.find((c) => c.week === week && c.url === url);
          if (existing) {
            existing.is_liked = Math.max(existing.is_liked, is_liked);
            existing.follower_likes = Math.max(existing.follower_likes, follower_likes);
            existing.importance_score = Math.max(existing.importance_score, importance_score);
            existing.source_count = Math.max(existing.source_count, source_count);
            existing.seen_count = Math.max(existing.seen_count, seen_count);
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
              cluster_id
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
  });
});



