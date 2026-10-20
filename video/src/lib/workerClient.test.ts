import { describe, expect, it, vi } from 'vitest';
import { createWorkerClient } from './workerClient.ts';

describe('src/lib/workerClient.ts', () => {
  it('fetches weekly candidates with Authorization Bearer header', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            week: '2026-W42',
            url: 'https://example.com/1',
            article_id: 'hn-1',
            title: 'Example Story',
            source: 'hackernews',
            summary: 'Summary',
            image_url: null,
            is_liked: 1,
            follower_likes: 2,
            importance_score: 4.5,
            source_count: 2,
            seen_count: 3,
            cluster_id: 'c1',
            captured_at: '2026-10-18 03:00:00',
          },
        ]),
        { status: 200 }
      )
    );

    const client = createWorkerClient({
      baseUrl: 'https://news.emre.xyz/',
      ingestionSecret: 'super-secret',
      fetchImpl: mockFetch,
    });

    const rows = await client.getCandidates('2026-W42');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.url).toBe('https://example.com/1');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://news.emre.xyz/api/admin/weekly/2026-W42/candidates',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer super-secret',
        }),
      })
    );
  });

  it('returns null when getEdition receives 404 Not Found', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 })
    );

    const client = createWorkerClient({
      baseUrl: 'https://news.emre.xyz',
      ingestionSecret: 'super-secret',
      fetchImpl: mockFetch,
    });

    const edition = await client.getEdition('2026-W42');
    expect(edition).toBeNull();
  });

  it('upserts an edition via PUT /api/admin/weekly/:week', async () => {
    const savedEdition = {
      week: '2026-W42',
      status: 'draft' as const,
      title_tr: 'Haftalık Özeti',
      intro_tr: 'Giriş metni',
      items: [
        {
          url: 'https://example.com/1',
          title_tr: 'Başlık',
          summary_tr: 'Özet',
          source: 'hackernews',
        },
      ],
      script: null,
      youtube_video_id: null,
      published_at: null,
      updated_at: '2026-10-19 12:00:00',
    };

    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(savedEdition), { status: 200 }));

    const client = createWorkerClient({
      baseUrl: 'https://news.emre.xyz',
      ingestionSecret: 'super-secret',
      fetchImpl: mockFetch,
    });

    const res = await client.putEdition('2026-W42', {
      status: 'draft',
      title_tr: 'Haftalık Özeti',
      intro_tr: 'Giriş metni',
      items: savedEdition.items,
    });

    expect(res.title_tr).toBe('Haftalık Özeti');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://news.emre.xyz/api/admin/weekly/2026-W42',
      expect.objectContaining({
        method: 'PUT',
      })
    );
  });
});

