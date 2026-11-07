import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../cli.ts';
import type { VideoEnv } from '../config/env.ts';
import type { Script } from '../domain/script.ts';
import { getWeekPaths, writeBytesAtomic, writeJsonAtomic } from '../lib/paths.ts';
import type { WeeklyEdition, WorkerClient } from '../lib/workerClient.ts';
import {
  downloadStoryImage,
  runRenderCommand,
  type RemotionRendererAdapter,
} from './render.ts';

function createTestEnv(): VideoEnv {
  return {
    NEWS_API_BASE_URL: 'https://news.emre.xyz',
    INGESTION_SECRET: 'test-secret',
    AI_GATEWAY_BASE_URL: '',
    AI_GATEWAY_API_KEY: '',
    AI_MODEL: 'gpt-4o-mini',
    ELEVENLABS_API_KEY: '',
    ELEVENLABS_VOICE_ID: '',
    ELEVENLABS_MODEL_ID: 'eleven_multilingual_v2',
    YOUTUBE_CLIENT_ID: '',
    YOUTUBE_CLIENT_SECRET: '',
    YOUTUBE_REFRESH_TOKEN: '',
    YOUTUBE_PRIVACY: 'private',
    VIDEO_ITEM_COUNT: 5,
  };
}

function createApprovedEdition(
  week: string,
  status: 'approved' | 'published' | 'draft' = 'approved'
): WeeklyEdition {
  return {
    week,
    status,
    title_tr: 'Haftalık Teknoloji Özeti: 2026-W42',
    intro_tr: 'Bu haftanın öne çıkan gelişmeleri.',
    items: [],
    script: {},
    youtube_video_id: null,
    published_at: null,
    updated_at: '2026-10-20T16:00:00.000Z',
  };
}

describe('src/commands/render.ts', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-render-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('downloadStoryImage', () => {
    it('downloads valid image/* responses to images/<storyIndex>.<ext> and returns relative path', async () => {
      const imagesDir = path.join(tempDir, 'images');
      const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(fakeJpeg, {
          status: 200,
          headers: { 'content-type': 'image/jpeg; charset=binary' },
        })
      );

      const relPath = await downloadStoryImage({
        imageUrl: 'https://cdn.example.com/og-story-1.jpg',
        storyIndex: 1,
        imagesDir,
        fetchImpl: mockFetch,
      });

      expect(relPath).toBe('images/1.jpg');
      const savedBytes = await fs.readFile(path.join(imagesDir, '1.jpg'));
      expect(new Uint8Array(savedBytes)).toEqual(fakeJpeg);
    });

    it('falls back to null when image download fails, returns non-image content-type, or has empty URL', async () => {
      const imagesDir = path.join(tempDir, 'images');
      const warnings: string[] = [];

      // 1. Null / empty URL -> null without warning
      const emptyResult = await downloadStoryImage({
        imageUrl: null,
        storyIndex: 1,
        imagesDir,
        onWarn: (msg) => warnings.push(msg),
      });
      expect(emptyResult).toBeNull();
      expect(warnings).toHaveLength(0);

      // 2. HTTP 404 -> falls back to null with warning
      const notFoundFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('Not Found', { status: 404 }));
      const notFoundResult = await downloadStoryImage({
        imageUrl: 'https://cdn.example.com/missing.png',
        storyIndex: 2,
        imagesDir,
        fetchImpl: notFoundFetch,
        onWarn: (msg) => warnings.push(msg),
      });
      expect(notFoundResult).toBeNull();
      expect(warnings.at(-1)).toContain('HTTP 404');

      // 3. Non-image Content-Type (text/html) -> falls back to null with warning
      const htmlFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('<html>not an image</html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      );
      const htmlResult = await downloadStoryImage({
        imageUrl: 'https://cdn.example.com/page',
        storyIndex: 3,
        imagesDir,
        fetchImpl: htmlFetch,
        onWarn: (msg) => warnings.push(msg),
      });
      expect(htmlResult).toBeNull();
      expect(warnings.at(-1)).toContain('unsupported Content-Type');

      // 4. Network error / timeout -> falls back to null with warning
      const errorFetch = vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error('ETIMEDOUT'));
      const errorResult = await downloadStoryImage({
        imageUrl: 'https://cdn.example.com/slow.webp',
        storyIndex: 4,
        imagesDir,
        fetchImpl: errorFetch,
        onWarn: (msg) => warnings.push(msg),
      });
      expect(errorResult).toBeNull();
      expect(warnings.at(-1)).toContain('ETIMEDOUT');
    });
  });

  describe('runRenderCommand', () => {
    const week = '2026-W42';

    async function seedWeekArtifacts(outRoot: string): Promise<void> {
      const paths = getWeekPaths(week, outRoot);

      await writeJsonAtomic(paths.translationJson, {
        week,
        translated_at: '2026-10-20T15:00:00.000Z',
        title_tr: 'Haftalık Teknoloji Özeti: 2026-W42',
        intro_tr: 'Bu hafta yapay zeka ve sistem programlama öne çıktı.',
        items: [
          {
            url: 'https://example.com/story-1',
            title_tr: 'Birinci Haber',
            summary_tr: 'Birinci haberin Türkçe özeti.',
            source: 'hn',
            image_url: 'https://cdn.example.com/story-1.png',
          },
          {
            url: 'https://lobste.rs/s/story-2',
            title_tr: 'İkinci Haber',
            summary_tr: 'İkinci haberin Türkçe özeti.',
            source: 'lobsters',
            image_url: 'https://cdn.example.com/broken-image.jpg',
          },
        ],
      });

      const script: Script = {
        intro: 'Merhaba, haftalık bültene hoş geldiniz.',
        segments: [
          {
            item_url: 'https://example.com/story-1',
            headline_tr: 'Birinci Haber Başlığı',
            narration_tr: 'Birinci haber anlatımı burada yer alıyor.',
          },
          {
            item_url: 'https://lobste.rs/s/story-2',
            headline_tr: 'İkinci Haber Başlığı',
            narration_tr: 'İkinci haber anlatımı burada yer alıyor.',
          },
        ],
        outro: 'İzlediğiniz için teşekkürler, haftaya görüşmek üzere.',
      };
      await writeJsonAtomic(paths.scriptJson, script);

      const segmentDurations = [14.4, 54.4, 59.4, 12.4];
      for (let idx = 0; idx < segmentDurations.length; idx++) {
        await writeBytesAtomic(
          path.join(paths.audioDir, `${idx}.mp3`),
          new Uint8Array([0xff, 0xfb, 0x90, 0x64])
        );
        await writeJsonAtomic(path.join(paths.audioDir, `${idx}.json`), {
          index: idx,
          kind: idx === 0 ? 'intro' : idx === 3 ? 'outro' : 'story',
          narration_tr: 'Test',
          narration_hash: 'abc12345',
          mock: true,
          duration_seconds: segmentDurations[idx],
          alignment: {
            characters: ['T'],
            character_start_times_seconds: [0],
            character_end_times_seconds: [segmentDurations[idx]],
          },
          words: [{ word: 'Test', start: 0, end: 0.5 }],
          captions: [
            {
              text: 'Test',
              words: [{ word: 'Test', start: 0, end: 0.5 }],
              start: 0,
              end: 0.5,
            },
          ],
        });
      }
    }

    it('downloads OG images with fallback, builds WeeklyVideoProps, and invokes Remotion bundle + renderMedia + renderStill', async () => {
      await seedWeekArtifacts(tempDir);

      const workerClient: WorkerClient = {
        getCandidates: vi.fn(),
        getEdition: vi.fn().mockResolvedValue(createApprovedEdition(week, 'approved')),
        putEdition: vi.fn(),
        triggerSnapshot: vi.fn(),
      };

      const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith('story-1.png')) {
          return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
            status: 200,
            headers: { 'content-type': 'image/png' },
          });
        }
        return new Response('Upstream error', { status: 502 });
      });

      const bundleComposition = vi
        .fn<RemotionRendererAdapter['bundleComposition']>()
        .mockResolvedValue('/tmp/fake-remotion-bundle');
      const renderComposition = vi
        .fn<RemotionRendererAdapter['renderComposition']>()
        .mockImplementation(async ({ videoOutputPath, thumbnailOutputPath }) => {
          await writeBytesAtomic(videoOutputPath, new Uint8Array([0x00, 0x00, 0x00, 0x18]));
          await writeBytesAtomic(thumbnailOutputPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
        });

      const controller = new AbortController();
      const ctx: CommandContext = {
        week,
        env: createTestEnv(),
        signal: controller.signal,
      };

      const logs: string[] = [];
      const result = await runRenderCommand(ctx, {
        workerClient,
        outRoot: tempDir,
        fetchImpl: mockFetch,
        remotionAdapter: {
          bundleComposition,
          renderComposition,
        },
        stdout: (msg) => logs.push(msg),
      });

      expect(result.downloadedImagesCount).toBe(1);
      expect(result.fallbackCardCount).toBe(1);
      expect(result.props.stories[0].imageSrc).toBe('images/1.png');
      expect(result.props.stories[1].imageSrc).toBeNull();

      // Total duration: (14.4+0.6) + (54.4+0.6) + (59.4+0.6) + (12.4+0.6) = 15 + 55 + 60 + 13 = 143s (4290 frames) minus 1 story transition overlap (15 frames = 0.5s) = 142.5s (4275 frames)
      expect(result.timeline.totalDurationSeconds).toBe(142.5);
      expect(result.timeline.totalDurationInFrames).toBe(4275);

      expect(bundleComposition).toHaveBeenCalledTimes(1);
      expect(renderComposition).toHaveBeenCalledTimes(1);
      expect(renderComposition).toHaveBeenCalledWith(
        expect.objectContaining({
          serveUrl: '/tmp/fake-remotion-bundle',
          compositionId: 'WeeklyVideo',
          videoOutputPath: path.join(tempDir, week, 'video.mp4'),
          thumbnailOutputPath: path.join(tempDir, week, 'thumbnail.png'),
        })
      );
    });

    it('refuses to run when edition is still draft', async () => {
      await seedWeekArtifacts(tempDir);

      const draftWorkerClient: WorkerClient = {
        getCandidates: vi.fn(),
        getEdition: vi.fn().mockResolvedValue(createApprovedEdition(week, 'draft')),
        putEdition: vi.fn(),
        triggerSnapshot: vi.fn(),
      };

      const controller = new AbortController();
      await expect(
        runRenderCommand(
          { week, env: createTestEnv(), signal: controller.signal },
          { workerClient: draftWorkerClient, outRoot: tempDir }
        )
      ).rejects.toThrowError(/must be "approved" or "published"/);
    });

    it('fails fast with a clear message when synthesized audio files are missing', async () => {
      await seedWeekArtifacts(tempDir);
      const paths = getWeekPaths(week, tempDir);
      await fs.unlink(path.join(paths.audioDir, '1.mp3'));

      const workerClient: WorkerClient = {
        getCandidates: vi.fn(),
        getEdition: vi.fn().mockResolvedValue(createApprovedEdition(week, 'approved')),
        putEdition: vi.fn(),
        triggerSnapshot: vi.fn(),
      };

      const controller = new AbortController();
      await expect(
        runRenderCommand(
          { week, env: createTestEnv(), signal: controller.signal },
          { workerClient, outRoot: tempDir }
        )
      ).rejects.toThrowError(/Run "voice" first/);
    });

    it('populates story.page (pages/<n>.png + element map) and optional cues when captures exist, and omits them when missing', async () => {
      await seedWeekArtifacts(tempDir);
      const paths = getWeekPaths(week, tempDir);
      const { computeUrlHash } = await import('../domain/pageCapture.ts');

      // Seed page capture only for story #1 (story #2 has no capture -> falls back to OG/card)
      await writeBytesAtomic(
        path.join(paths.pagesDir, '1.png'),
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
      await writeJsonAtomic(path.join(paths.pagesDir, '1.json'), {
        index: 1,
        url: 'https://example.com/story-1',
        url_hash: computeUrlHash('https://example.com/story-1'),
        captured_at: '2026-10-20T15:30:00.000Z',
        screenshot_path: 'pages/1.png',
        viewport: {
          width: 1440,
          height: 900,
          deviceScaleFactor: 1,
        },
        page_height: 2450,
        excerpt: 'Captured story 1 excerpt text.',
        elements: [
          {
            id: 'h1',
            kind: 'h1',
            tagName: 'h1',
            text: 'Birinci Haber Başlığı',
            box: { x: 120, y: 110, width: 880, height: 76 },
          },
          {
            id: 'p1',
            kind: 'paragraph',
            tagName: 'p',
            text: 'Birinci haber anlatımı burada yer alıyor.',
            box: { x: 120, y: 220, width: 840, height: 96 },
          },
        ],
      });

      // Also include optional cues in script.json for story #1
      await writeJsonAtomic(paths.scriptJson, {
        intro: 'Merhaba, haftalık bültene hoş geldiniz.',
        segments: [
          {
            item_url: 'https://example.com/story-1',
            headline_tr: 'Birinci Haber Başlığı',
            narration_tr: 'Birinci haber anlatımı burada yer alıyor.',
            cues: [
              {
                kind: 'focus',
                anchor: 'Birinci haber',
                target: 'h1',
              },
            ],
          },
          {
            item_url: 'https://lobste.rs/s/story-2',
            headline_tr: 'İkinci Haber Başlığı',
            narration_tr: 'İkinci haber anlatımı burada yer alıyor.',
          },
        ],
        outro: 'İzlediğiniz için teşekkürler, haftaya görüşmek üzere.',
      });

      const workerClient: WorkerClient = {
        getCandidates: vi.fn(),
        getEdition: vi.fn().mockResolvedValue(createApprovedEdition(week, 'approved')),
        putEdition: vi.fn(),
        triggerSnapshot: vi.fn(),
      };

      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response('Upstream error', { status: 502 })
      );

      const bundleComposition = vi
        .fn<RemotionRendererAdapter['bundleComposition']>()
        .mockResolvedValue('/tmp/fake-remotion-bundle');
      const renderComposition = vi
        .fn<RemotionRendererAdapter['renderComposition']>()
        .mockImplementation(async ({ videoOutputPath, thumbnailOutputPath }) => {
          await writeBytesAtomic(videoOutputPath, new Uint8Array([0x00, 0x00, 0x00, 0x18]));
          await writeBytesAtomic(thumbnailOutputPath, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
        });

      const controller = new AbortController();
      const result = await runRenderCommand(
        { week, env: createTestEnv(), signal: controller.signal },
        {
          workerClient,
          outRoot: tempDir,
          fetchImpl: mockFetch,
          remotionAdapter: {
            bundleComposition,
            renderComposition,
          },
          stdout: () => {},
        }
      );

      expect(result.pageCapturesCount).toBe(1);
      expect(result.props.stories[0].page).toBeDefined();
      expect(result.props.stories[0].page).toMatchObject({
        screenshot_path: 'pages/1.png',
        page_height: 2450,
      });
      expect(result.props.stories[0].page?.elements).toHaveLength(2);
      expect(result.props.stories[0].cues).toEqual([
        {
          kind: 'focus',
          anchor: 'Birinci haber',
          target: 'h1',
        },
      ]);

      // Story #2 had no page capture and no cues
      expect(result.props.stories[1].page).toBeUndefined();
      expect(result.props.stories[1].cues).toBeUndefined();
    });
  });
});


