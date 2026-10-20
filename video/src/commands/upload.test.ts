import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoEnv } from '../config/env.ts';
import { buildVideoTimeline, VIDEO_FPS, type WeeklyVideoProps } from '../domain/timeline.ts';
import { getWeekPaths, writeJsonAtomic } from '../lib/paths.ts';
import type { WeeklyEdition, WorkerClient } from '../lib/workerClient.ts';
import {
  buildYouTubeChapters,
  buildYouTubeDescription,
  buildYouTubeTags,
  buildYouTubeTitle,
  formatChapterTimestamp,
  formatYouTubeChapters,
  runUploadCommand,
  YOUTUBE_MAX_TITLE_LENGTH,
} from './upload.ts';

function makeUploadEnv(overrides: Partial<VideoEnv> = {}): VideoEnv {
  return {
    NEWS_API_BASE_URL: 'https://news.emre.xyz',
    INGESTION_SECRET: 'test-secret',
    AI_GATEWAY_BASE_URL: undefined,
    AI_GATEWAY_API_KEY: undefined,
    AI_MODEL: undefined,
    ELEVENLABS_API_KEY: undefined,
    ELEVENLABS_VOICE_ID: undefined,
    ELEVENLABS_MODEL_ID: 'eleven_multilingual_v2',
    YOUTUBE_CLIENT_ID: 'client-id',
    YOUTUBE_CLIENT_SECRET: 'client-secret',
    YOUTUBE_REFRESH_TOKEN: 'refresh-token',
    YOUTUBE_PRIVACY: 'private',
    VIDEO_ITEM_COUNT: 6,
    ...overrides,
  };
}

function makeApprovedEdition(overrides: Partial<WeeklyEdition> = {}): WeeklyEdition {
  return {
    week: '2026-W42',
    status: 'approved',
    title_tr: 'Yapay Zeka Ajanları ve SQLite Yenilikleri',
    intro_tr: 'Bu hafta yazılım dünyasında öne çıkan gelişmeleri inceliyoruz.',
    items: [
      {
        url: 'https://example.com/story-1',
        title_tr: 'Birinci Haber Başlığı',
        summary_tr: 'Birinci haber özeti.',
        source: 'hackernews',
        image_url: null,
      },
      {
        url: 'https://example.com/story-2',
        title_tr: 'İkinci Haber Başlığı',
        summary_tr: 'İkinci haber özeti.',
        source: 'lobsters',
        image_url: null,
      },
    ],
    script: {},
    youtube_video_id: null,
    published_at: null,
    updated_at: '2026-10-20T17:00:00.000Z',
    ...overrides,
  };
}

describe('src/commands/upload.ts', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-cmd-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('chapter formatting and description builder', () => {
    it('formats chapter timestamps as MM:SS and HH:MM:SS for >= 1 hour', () => {
      expect(formatChapterTimestamp(0)).toBe('00:00');
      expect(formatChapterTimestamp(-5)).toBe('00:00');
      expect(formatChapterTimestamp(9.8)).toBe('00:09');
      expect(formatChapterTimestamp(65)).toBe('01:05');
      expect(formatChapterTimestamp(195.4)).toBe('03:15');
      expect(formatChapterTimestamp(3600)).toBe('01:00:00');
      expect(formatChapterTimestamp(3665)).toBe('01:01:05');
    });

    it('builds chapters from VideoTimeline with 00:00 first and accurate scene start timestamps', () => {
      const props: WeeklyVideoProps = {
        week: '2026-W42',
        title_tr: 'Yapay Zeka ve Sistem Mimarisi',
        siteUrl: 'news.emre.xyz',
        intro: {
          audioSrc: 'audio/0.mp3',
          audioDurationSeconds: 11.4, // + 0.6s padding = 12.0s
          captions: [],
        },
        stories: [
          {
            index: 1,
            url: 'https://example.com/1',
            domain: 'example.com',
            source: 'hackernews',
            headline_tr: 'SQLite Üzerinde Dağıtık İşlemler',
            summary_tr: 'Özet 1',
            imageSrc: null,
            audioSrc: 'audio/1.mp3',
            audioDurationSeconds: 47.4, // + 0.6s padding = 48.0s -> ends at 60.0s
            captions: [],
          },
          {
            index: 2,
            url: 'https://example.com/2',
            domain: 'example.com',
            source: 'lobsters',
            headline_tr: 'Linux Çekirdeğinde Rust Sürücüleri',
            summary_tr: 'Özet 2',
            imageSrc: null,
            audioSrc: 'audio/2.mp3',
            audioDurationSeconds: 54.4, // + 0.6s padding = 55.0s -> ends at 115.0s
            captions: [],
          },
        ],
        outro: {
          audioSrc: 'audio/3.mp3',
          audioDurationSeconds: 9.4,
          captions: [],
        },
      };

      const timeline = buildVideoTimeline(props, VIDEO_FPS);
      const chapters = buildYouTubeChapters(timeline);

      expect(chapters).toEqual([
        { timestamp: '00:00', startSeconds: 0, label: 'Giriş' },
        {
          timestamp: '00:12',
          startSeconds: 12,
          label: 'SQLite Üzerinde Dağıtık İşlemler',
        },
        {
          timestamp: '01:00',
          startSeconds: 60,
          label: 'Linux Çekirdeğinde Rust Sürücüleri',
        },
        { timestamp: '01:55', startSeconds: 115, label: 'Kapanış' },
      ]);

      expect(formatYouTubeChapters(chapters)).toBe(
        [
          '00:00 Giriş',
          '00:12 SQLite Üzerinde Dağıtık İşlemler',
          '01:00 Linux Çekirdeğinde Rust Sürücüleri',
          '01:55 Kapanış',
        ].join('\n')
      );
    });

    it('builds the Turkish title, deduplicated tags, and full description with chapters, source links, and /weekly/<week>', () => {
      const title = buildYouTubeTitle(
        '2026-W42',
        'Yapay Zeka Ajanları ve SQLite Yenilikleri'
      );
      expect(title).toBe(
        'Yapay Zeka Ajanları ve SQLite Yenilikleri | Haftalık Teknoloji Özeti (2026-W42)'
      );
      expect(title.length).toBeLessThanOrEqual(YOUTUBE_MAX_TITLE_LENGTH);

      const longTitle = buildYouTubeTitle('2026-W42', 'Ç'.repeat(120));
      expect(longTitle.length).toBeLessThanOrEqual(YOUTUBE_MAX_TITLE_LENGTH);
      expect(longTitle).toContain('(2026-W42)');

      const tags = buildYouTubeTags('2026-W42', [
        { source: 'hackernews' },
        { source: 'HackerNews' },
        { source: 'lobsters' },
      ]);
      expect(tags).toContain('teknoloji');
      expect(tags).toContain('2026-W42');
      expect(tags).toContain('hackernews');
      expect(tags).toContain('lobsters');
      expect(tags.filter((t) => t.toLowerCase() === 'hackernews')).toHaveLength(1);

      const description = buildYouTubeDescription({
        week: '2026-W42',
        introTr: 'Bu hafta öne çıkan yazılım ve teknoloji gelişmelerini derledik.',
        chapters: [
          { timestamp: '00:00', startSeconds: 0, label: 'Giriş' },
          { timestamp: '00:14', startSeconds: 14, label: 'Birinci Haber Başlığı' },
          { timestamp: '01:02', startSeconds: 62, label: 'İkinci Haber Başlığı' },
          { timestamp: '01:48', startSeconds: 108, label: 'Kapanış' },
        ],
        items: [
          { headline_tr: 'Birinci Haber Başlığı', url: 'https://example.com/story-1' },
          { headline_tr: 'İkinci Haber Başlığı', url: 'https://example.com/story-2' },
        ],
        siteBaseUrl: 'https://news.emre.xyz/',
      });

      expect(description).toContain(
        'Bu hafta öne çıkan yazılım ve teknoloji gelişmelerini derledik.'
      );
      expect(description).toContain('https://news.emre.xyz/weekly/2026-W42');
      expect(description).toContain(
        'Bölümler:\n00:00 Giriş\n00:14 Birinci Haber Başlığı\n01:02 İkinci Haber Başlığı\n01:48 Kapanış'
      );
      expect(description).toContain('1. Birinci Haber Başlığı\nhttps://example.com/story-1');
      expect(description).toContain('2. İkinci Haber Başlığı\nhttps://example.com/story-2');
    });
  });

  describe('runUploadCommand', () => {
    async function seedRenderedWeekFiles(week: string): Promise<void> {
      const paths = getWeekPaths(week, tempDir);
      await fs.mkdir(paths.audioDir, { recursive: true });
      await fs.writeFile(paths.videoMp4, Buffer.from('FAKE_MP4_DATA_BYTES'));
      await fs.writeFile(paths.thumbnailPng, Buffer.from('FAKE_PNG_DATA_BYTES'));

      await writeJsonAtomic(paths.translationJson, {
        week,
        title_tr: 'Yapay Zeka Ajanları ve SQLite Yenilikleri',
        intro_tr: 'Bu hafta yazılım dünyasında öne çıkan gelişmeleri inceliyoruz.',
        items: [
          {
            url: 'https://example.com/story-1',
            title_tr: 'Birinci Haber Başlığı',
            summary_tr: 'Birinci haber özeti.',
            source: 'hackernews',
            image_url: null,
          },
          {
            url: 'https://example.com/story-2',
            title_tr: 'İkinci Haber Başlığı',
            summary_tr: 'İkinci haber özeti.',
            source: 'lobsters',
            image_url: null,
          },
        ],
      });

      await writeJsonAtomic(paths.scriptJson, {
        intro: 'Merhaba, haftalık teknoloji özetine hoş geldiniz.',
        segments: [
          {
            item_url: 'https://example.com/story-1',
            headline_tr: 'Birinci Haber Başlığı',
            narration_tr: 'Birinci haber anlatımı.',
          },
          {
            item_url: 'https://example.com/story-2',
            headline_tr: 'İkinci Haber Başlığı',
            narration_tr: 'İkinci haber anlatımı.',
          },
        ],
        outro: 'İzlediğiniz için teşekkürler.',
      });

      await writeJsonAtomic(path.join(paths.audioDir, '0.json'), {
        index: 0,
        duration_seconds: 9.4,
        captions: [],
      });
      await writeJsonAtomic(path.join(paths.audioDir, '1.json'), {
        index: 1,
        duration_seconds: 44.4,
        captions: [],
      });
      await writeJsonAtomic(path.join(paths.audioDir, '2.json'), {
        index: 2,
        duration_seconds: 51.4,
        captions: [],
      });
      await writeJsonAtomic(path.join(paths.audioDir, '3.json'), {
        index: 3,
        duration_seconds: 8.4,
        captions: [],
      });
    }

    it('uploads video and thumbnail, then PUTs youtube_video_id and status: published', async () => {
      await seedRenderedWeekFiles('2026-W42');
      const controller = new AbortController();
      const lines: string[] = [];

      const workerClient: WorkerClient = {
        getCandidates: vi.fn(),
        getEdition: vi.fn().mockResolvedValue(makeApprovedEdition()),
        putEdition: vi.fn().mockImplementation(async (_week, payload) => ({
          ...makeApprovedEdition(),
          youtube_video_id: payload.youtube_video_id ?? null,
          status: payload.status ?? 'published',
          published_at: '2026-10-20T18:00:00.000Z',
        })),
        triggerSnapshot: vi.fn(),
      };

      const sessionUri =
        'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=sess-42';

      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (url === 'https://oauth2.googleapis.com/token') {
          return new Response(
            JSON.stringify({ access_token: 'ya29.upload-token', expires_in: 3600 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (url.includes('part=snippet%2Cstatus') || url.includes('part=snippet,status')) {
          return new Response('', {
            status: 200,
            headers: { Location: sessionUri },
          });
        }
        if (url === sessionUri) {
          if (init?.body) {
            await new Response(init.body as BodyInit).arrayBuffer();
          }
          return new Response(JSON.stringify({ id: 'dQw4w9WgXcQ' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('thumbnails/set')) {
          if (init?.body) {
            await new Response(init.body as BodyInit).arrayBuffer();
          }
          return new Response(JSON.stringify({ items: [{}] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      });

      const result = await runUploadCommand(
        {
          week: '2026-W42',
          env: makeUploadEnv(),
          signal: controller.signal,
        },
        {
          workerClient,
          outRoot: tempDir,
          fetchImpl: mockFetch,
          stdout: (msg) => lines.push(msg),
        }
      );

      expect(result.skipped).toBe(false);
      expect(result.videoId).toBe('dQw4w9WgXcQ');
      expect(result.privacyStatus).toBe('private');
      expect(result.metadata?.description).toContain('00:00 Giriş');
      expect(result.metadata?.description).toContain('00:10 Birinci Haber Başlığı');
      expect(result.metadata?.description).toContain('https://news.emre.xyz/weekly/2026-W42');

      expect(workerClient.putEdition).toHaveBeenCalledTimes(1);
      expect(workerClient.putEdition).toHaveBeenCalledWith(
        '2026-W42',
        {
          youtube_video_id: 'dQw4w9WgXcQ',
          status: 'published',
        },
        controller.signal
      );
    });

    it('is idempotent: exits without uploading again if the edition already has a youtube_video_id', async () => {
      const controller = new AbortController();
      const lines: string[] = [];
      const mockFetch = vi.fn();

      const workerClient: WorkerClient = {
        getCandidates: vi.fn(),
        getEdition: vi.fn().mockResolvedValue(
          makeApprovedEdition({
            status: 'published',
            youtube_video_id: 'existing_yt_id_123',
          })
        ),
        putEdition: vi.fn(),
        triggerSnapshot: vi.fn(),
      };

      const result = await runUploadCommand(
        {
          week: '2026-W42',
          env: makeUploadEnv({ YOUTUBE_REFRESH_TOKEN: undefined }),
          signal: controller.signal,
        },
        {
          workerClient,
          outRoot: tempDir,
          fetchImpl: mockFetch,
          stdout: (msg) => lines.push(msg),
        }
      );

      expect(result.skipped).toBe(true);
      expect(result.videoId).toBe('existing_yt_id_123');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(workerClient.putEdition).not.toHaveBeenCalled();
      expect(lines.join('\n')).toContain('already has YouTube video ID "existing_yt_id_123"');
    });

    it('refuses to run if the edition is still draft', async () => {
      const controller = new AbortController();
      const workerClient: WorkerClient = {
        getCandidates: vi.fn(),
        getEdition: vi.fn().mockResolvedValue(
          makeApprovedEdition({
            status: 'draft',
          })
        ),
        putEdition: vi.fn(),
        triggerSnapshot: vi.fn(),
      };

      await expect(
        runUploadCommand(
          {
            week: '2026-W42',
            env: makeUploadEnv(),
            signal: controller.signal,
          },
          {
            workerClient,
            outRoot: tempDir,
          }
        )
      ).rejects.toThrowError(/must be "approved" or "published"/);
    });
  });
});

