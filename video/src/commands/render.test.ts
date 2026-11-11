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
  assertNotAllCards,
  countMissingPageCaptures,
  countStoryVisualModes,
  downloadStoryImage,
  matchesImageMagicBytes,
  MAX_IMAGE_BYTES,
  resolveStoryImageUrl,
  runRenderCommand,
  type RemotionRendererAdapter,
  type RenderCaptureRunner,
} from './render.ts';
import type { DnsLookupAllFn } from '../lib/ssrf.ts';

const VALID_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const VALID_JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PUBLIC_DNS_LOOKUP: DnsLookupAllFn = async () => [{ address: '93.184.216.34', family: 4 }];

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

      const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(VALID_JPEG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/jpeg; charset=binary' },
        })
      );

      const relPath = await downloadStoryImage({
        imageUrl: 'https://cdn.example.com/og-story-1.jpg',
        storyIndex: 1,
        imagesDir,
        dnsLookup: PUBLIC_DNS_LOOKUP,
        fetchImpl: mockFetch,
      });

      expect(relPath).toBe('images/1.jpg');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://cdn.example.com/og-story-1.jpg',
        expect.objectContaining({ redirect: 'manual' })
      );
      const savedBytes = await fs.readFile(path.join(imagesDir, '1.jpg'));
      expect(new Uint8Array(savedBytes)).toEqual(VALID_JPEG_BYTES);
    });

    it('falls back to null when image download fails, returns non-image content-type, or has empty URL', async () => {
      const imagesDir = path.join(tempDir, 'images');
      const warnings: string[] = [];

      // 1. Null / empty URL -> null without warning
      const emptyResult = await downloadStoryImage({
        imageUrl: null,
        storyIndex: 1,
        imagesDir,
        dnsLookup: PUBLIC_DNS_LOOKUP,
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
        dnsLookup: PUBLIC_DNS_LOOKUP,
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
        dnsLookup: PUBLIC_DNS_LOOKUP,
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
        dnsLookup: PUBLIC_DNS_LOOKUP,
        fetchImpl: errorFetch,
        onWarn: (msg) => warnings.push(msg),
      });
      expect(errorResult).toBeNull();
      expect(warnings.at(-1)).toContain('ETIMEDOUT');
    });

    it('rejects private-IP, loopback, link-local, and DNS-rebound hosts before making a network request', async () => {
      const imagesDir = path.join(tempDir, 'images');
      const mockFetch = vi.fn<typeof fetch>();
      const warnings: string[] = [];

      const blockedUrls = [
        'http://127.0.0.1:8080/internal.png',
        'http://192.168.1.42/router.jpg',
        'http://169.254.169.254/latest/meta-data/iam',
        'http://localhost:3000/secret.png',
      ];

      for (const url of blockedUrls) {
        const res = await downloadStoryImage({
          imageUrl: url,
          storyIndex: 1,
          imagesDir,
          dnsLookup: PUBLIC_DNS_LOOKUP,
          fetchImpl: mockFetch,
          onWarn: (msg) => warnings.push(msg),
        });
        expect(res).toBeNull();
      }

      // Also reject a hostname that resolves via DNS to a private/loopback IP
      const rebindRes = await downloadStoryImage({
        imageUrl: 'https://rebind.attacker.example/og.png',
        storyIndex: 2,
        imagesDir,
        dnsLookup: async () => [{ address: '10.0.0.12', family: 4 }],
        fetchImpl: mockFetch,
        onWarn: (msg) => warnings.push(msg),
      });
      expect(rebindRes).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
      expect(warnings).toHaveLength(blockedUrls.length + 1);
      expect(warnings.at(-1)).toContain('10.0.0.12');
    });

    it('follows safe redirects manually, rejects a redirect to a private IP without fetching it, and enforces the hop limit', async () => {
      const imagesDir = path.join(tempDir, 'images');
      const warnings: string[] = [];

      // 1. Redirect from a public URL to a private IP -> blocked before second fetch
      const redirectToPrivateFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input);
        if (url === 'https://cdn.example.com/start.png') {
          return new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          });
        }
        return new Response(VALID_PNG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      });

      const privateRedirectResult = await downloadStoryImage({
        imageUrl: 'https://cdn.example.com/start.png',
        storyIndex: 1,
        imagesDir,
        dnsLookup: PUBLIC_DNS_LOOKUP,
        fetchImpl: redirectToPrivateFetch,
        onWarn: (msg) => warnings.push(msg),
      });

      expect(privateRedirectResult).toBeNull();
      expect(redirectToPrivateFetch).toHaveBeenCalledTimes(1);
      expect(redirectToPrivateFetch).toHaveBeenCalledWith(
        'https://cdn.example.com/start.png',
        expect.objectContaining({ redirect: 'manual' })
      );
      expect(warnings.at(-1)).toContain('169.254.169.254');

      // 2. Redirect to a hostname that resolves to loopback -> blocked before second fetch
      const redirectToInternalHostFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://internal.corp.example/og.png' },
        });
      });

      const internalHostResult = await downloadStoryImage({
        imageUrl: 'https://cdn.example.com/hop.png',
        storyIndex: 2,
        imagesDir,
        dnsLookup: async (hostname) =>
          hostname === 'internal.corp.example'
            ? [{ address: '127.0.0.1', family: 4 }]
            : [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: redirectToInternalHostFetch,
        onWarn: (msg) => warnings.push(msg),
      });

      expect(internalHostResult).toBeNull();
      expect(redirectToInternalHostFetch).toHaveBeenCalledTimes(1);
      expect(warnings.at(-1)).toContain('127.0.0.1');

      // 3. Valid public redirect hop succeeds
      const safeRedirectFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input);
        if (url === 'https://cdn.example.com/redirect-ok') {
          return new Response(null, {
            status: 302,
            headers: { location: '/assets/final.png' },
          });
        }
        return new Response(VALID_PNG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      });

      const safeRedirectResult = await downloadStoryImage({
        imageUrl: 'https://cdn.example.com/redirect-ok',
        storyIndex: 3,
        imagesDir,
        dnsLookup: PUBLIC_DNS_LOOKUP,
        fetchImpl: safeRedirectFetch,
      });

      expect(safeRedirectResult).toBe('images/3.png');
      expect(safeRedirectFetch).toHaveBeenCalledTimes(2);

      // 4. Redirect loop exceeding maxRedirects falls back to null
      const loopFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.com/loop' },
        });
      });

      const loopResult = await downloadStoryImage({
        imageUrl: 'https://cdn.example.com/loop',
        storyIndex: 4,
        imagesDir,
        maxRedirects: 3,
        dnsLookup: PUBLIC_DNS_LOOKUP,
        fetchImpl: loopFetch,
        onWarn: (msg) => warnings.push(msg),
      });

      expect(loopResult).toBeNull();
      expect(loopFetch).toHaveBeenCalledTimes(4); // initial + 3 hops
      expect(warnings.at(-1)).toContain('exceeded max redirects (3)');
    });

    it('streams chunked responses without Content-Length and aborts as soon as MAX_IMAGE_BYTES is exceeded without buffering the rest', async () => {
      const imagesDir = path.join(tempDir, 'images');
      const warnings: string[] = [];

      // Each chunk is 6 MiB; MAX_IMAGE_BYTES is 15 MiB.
      // Chunk 1 (6 MiB) + Chunk 2 (12 MiB) + Chunk 3 (18 MiB -> exceeds 15 MiB limit!).
      // Chunk 4 and Chunk 5 must NEVER be pulled.
      const chunkSize = 6 * 1024 * 1024;
      const totalChunks = 6;
      let pulledChunks = 0;
      let streamCancelled = false;

      const chunkedStream = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulledChunks++;
            const chunk = new Uint8Array(chunkSize);
            if (pulledChunks === 1) {
              chunk.set(VALID_PNG_BYTES, 0);
            }
            controller.enqueue(chunk);
            if (pulledChunks >= totalChunks) {
              controller.close();
            }
          },
          cancel() {
            streamCancelled = true;
          },
        },
        { highWaterMark: 0 }
      );

      let capturedSignal: AbortSignal | null | undefined;
      const chunkedFetch = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
        capturedSignal = init?.signal;
        return new Response(chunkedStream, {
          status: 200,
          headers: { 'content-type': 'image/png' }, // No content-length header!
        });
      });

      const result = await downloadStoryImage({
        imageUrl: 'https://cdn.example.com/huge-chunked.png',
        storyIndex: 1,
        imagesDir,
        dnsLookup: PUBLIC_DNS_LOOKUP,
        fetchImpl: chunkedFetch,
        onWarn: (msg) => warnings.push(msg),
      });

      expect(result).toBeNull();
      expect(streamCancelled).toBe(true);
      expect(capturedSignal?.aborted).toBe(true);
      // Stopped at chunk 3 (18 MiB > 15 MiB MAX_IMAGE_BYTES), never pulled chunks 4..6
      expect(pulledChunks).toBe(3);
      expect(warnings.at(-1)).toContain('exceeds max size');
      await expect(fs.stat(path.join(imagesDir, '1.png'))).rejects.toThrow();
    });

    it('verifies leading magic bytes against claimed MIME type and rejects spoofed bodies', async () => {
      const imagesDir = path.join(tempDir, 'images');
      const warnings: string[] = [];

      // Claimed image/png but payload is HTML
      const spoofedHtmlFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new TextEncoder().encode('<!DOCTYPE html><html></html>'), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      );

      const spoofedResult = await downloadStoryImage({
        imageUrl: 'https://cdn.example.com/fake.png',
        storyIndex: 1,
        imagesDir,
        dnsLookup: PUBLIC_DNS_LOOKUP,
        fetchImpl: spoofedHtmlFetch,
        onWarn: (msg) => warnings.push(msg),
      });

      expect(spoofedResult).toBeNull();
      expect(warnings.at(-1)).toContain('magic bytes do not match Content-Type "image/png"');
      await expect(fs.stat(path.join(imagesDir, '1.png'))).rejects.toThrow();

      // Claimed image/jpeg but payload has PNG magic bytes
      const mismatchedMimeFetch = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(VALID_PNG_BYTES, {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
      );

      const mismatchedResult = await downloadStoryImage({
        imageUrl: 'https://cdn.example.com/mismatch.jpg',
        storyIndex: 2,
        imagesDir,
        dnsLookup: PUBLIC_DNS_LOOKUP,
        fetchImpl: mismatchedMimeFetch,
        onWarn: (msg) => warnings.push(msg),
      });

      expect(mismatchedResult).toBeNull();
      expect(warnings.at(-1)).toContain('magic bytes do not match Content-Type "image/jpeg"');

      // Direct unit checks for supported magic byte signatures
      expect(matchesImageMagicBytes(VALID_JPEG_BYTES, 'image/jpeg')).toBe(true);
      expect(matchesImageMagicBytes(VALID_JPEG_BYTES, 'image/jpg')).toBe(true);
      expect(matchesImageMagicBytes(VALID_PNG_BYTES, 'image/png')).toBe(true);
      expect(
        matchesImageMagicBytes(
          new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
          'image/gif'
        )
      ).toBe(true);
      expect(
        matchesImageMagicBytes(
          new Uint8Array([
            0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
          ]),
          'image/webp'
        )
      ).toBe(true);
      expect(
        matchesImageMagicBytes(
          new Uint8Array([
            0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66,
          ]),
          'image/avif'
        )
      ).toBe(true);
      expect(MAX_IMAGE_BYTES).toBe(15 * 1024 * 1024);
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
        getUsedStories: vi.fn().mockResolvedValue([]),
        getEdition: vi.fn().mockResolvedValue(createApprovedEdition(week, 'approved')),
        putEdition: vi.fn(),
        triggerSnapshot: vi.fn(),
      };

      const mockFetch = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith('story-1.png')) {
          return new Response(VALID_PNG_BYTES, {
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
          await writeBytesAtomic(thumbnailOutputPath, VALID_PNG_BYTES);
        });

      const controller = new AbortController();
      const ctx: CommandContext = {
        week,
        env: createTestEnv(),
        signal: controller.signal,
      };

      const logs: string[] = [];
      const captureRunner = vi.fn<RenderCaptureRunner>().mockResolvedValue(undefined);
      const result = await runRenderCommand(ctx, {
        workerClient,
        outRoot: tempDir,
        dnsLookup: PUBLIC_DNS_LOOKUP,
        fetchImpl: mockFetch,
        remotionAdapter: {
          bundleComposition,
          renderComposition,
        },
        captureRunner,
        stdout: (msg) => logs.push(msg),
      });

      // Neither story has a page capture on disk, so render runs capture once first.
      expect(captureRunner).toHaveBeenCalledTimes(1);
      expect(result.visualModes).toEqual({ page: 0, og: 1, card: 1 });
      expect(logs).toContain('Story visuals for 2026-W42: page 0, og 1, card 1.');

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
        getUsedStories: vi.fn().mockResolvedValue([]),
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
        getUsedStories: vi.fn().mockResolvedValue([]),
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
        VALID_PNG_BYTES
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
        getUsedStories: vi.fn().mockResolvedValue([]),
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
          await writeBytesAtomic(thumbnailOutputPath, VALID_PNG_BYTES);
        });

      const controller = new AbortController();
      const result = await runRenderCommand(
        { week, env: createTestEnv(), signal: controller.signal },
        {
          workerClient,
          outRoot: tempDir,
          dnsLookup: PUBLIC_DNS_LOOKUP,
          fetchImpl: mockFetch,
          remotionAdapter: {
            bundleComposition,
            renderComposition,
          },
          captureRunner: async () => {},
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

    it('stops before bundling when every story would be a branded card, unless allowCards is set', async () => {
      await seedWeekArtifacts(tempDir);

      const workerClient: WorkerClient = {
        getCandidates: vi.fn(),
        getUsedStories: vi.fn().mockResolvedValue([]),
        getEdition: vi.fn().mockResolvedValue(createApprovedEdition(week, 'approved')),
        putEdition: vi.fn(),
        triggerSnapshot: vi.fn(),
      };
      // Every image download fails and no page capture exists -> all stories are cards.
      const failingFetch = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('Upstream error', { status: 502 }));
      const bundleComposition = vi
        .fn<RemotionRendererAdapter['bundleComposition']>()
        .mockResolvedValue('/tmp/fake-remotion-bundle');
      const renderComposition = vi
        .fn<RemotionRendererAdapter['renderComposition']>()
        .mockImplementation(async ({ videoOutputPath, thumbnailOutputPath }) => {
          await fs.writeFile(videoOutputPath, Buffer.from('mp4'));
          await fs.writeFile(thumbnailOutputPath, Buffer.from('png'));
        });
      const deps = {
        workerClient,
        outRoot: tempDir,
        dnsLookup: PUBLIC_DNS_LOOKUP,
        fetchImpl: failingFetch,
        remotionAdapter: { bundleComposition, renderComposition },
        captureRunner: async () => {},
        stdout: () => {},
      };

      await expect(
        runRenderCommand(
          { week, env: createTestEnv(), signal: new AbortController().signal },
          deps
        )
      ).rejects.toThrowError(/All 2 stories for 2026-W42 would render as branded cards/);
      expect(bundleComposition).not.toHaveBeenCalled();

      const allowed = await runRenderCommand(
        { week, env: createTestEnv(), signal: new AbortController().signal, allowCards: true },
        deps
      );
      expect(allowed.visualModes).toEqual({ page: 0, og: 0, card: 2 });
      expect(bundleComposition).toHaveBeenCalledTimes(1);
    });

    it('keeps rendering with a warning when the capture runner throws', async () => {
      await seedWeekArtifacts(tempDir);

      const workerClient: WorkerClient = {
        getCandidates: vi.fn(),
        getUsedStories: vi.fn().mockResolvedValue([]),
        getEdition: vi.fn().mockResolvedValue(createApprovedEdition(week, 'approved')),
        putEdition: vi.fn(),
        triggerSnapshot: vi.fn(),
      };
      const imageFetch = vi.fn<typeof fetch>().mockImplementation(
        async () =>
          new Response(VALID_PNG_BYTES, {
            status: 200,
            headers: { 'content-type': 'image/png' },
          })
      );
      const logs: string[] = [];

      const result = await runRenderCommand(
        { week, env: createTestEnv(), signal: new AbortController().signal },
        {
          workerClient,
          outRoot: tempDir,
          dnsLookup: PUBLIC_DNS_LOOKUP,
          fetchImpl: imageFetch,
          remotionAdapter: {
            bundleComposition: vi.fn().mockResolvedValue('/tmp/fake-remotion-bundle'),
            renderComposition: vi.fn().mockResolvedValue(undefined),
          },
          captureRunner: async () => {
            throw new Error('chrome not found');
          },
          stdout: (msg) => logs.push(msg),
        }
      );

      expect(logs.some((l) => l.includes('[warn] Page capture failed (chrome not found)'))).toBe(true);
      expect(result.visualModes.card).toBeLessThan(2);
    });
  });

  describe('visual mode helpers', () => {
    it('counts page / og / card modes and only rejects an all-card set', () => {
      const counts = countStoryVisualModes([
        { imageSrc: 'images/1.png' },
        { imageSrc: null },
        { imageSrc: '   ' },
      ]);
      expect(counts).toEqual({ page: 0, og: 1, card: 2 });

      expect(() => assertNotAllCards(counts, '2026-W45', false)).not.toThrow();
      expect(() => assertNotAllCards({ page: 0, og: 0, card: 3 }, '2026-W45', false)).toThrowError(
        /--allow-cards/
      );
      expect(() => assertNotAllCards({ page: 0, og: 0, card: 3 }, '2026-W45', true)).not.toThrow();
      expect(() => assertNotAllCards({ page: 0, og: 0, card: 0 }, '2026-W45', false)).not.toThrow();
    });

    it('counts stories whose page capture is missing on disk', async () => {
      const pagesDir = path.join(tempDir, 'pages');
      expect(
        await countMissingPageCaptures(pagesDir, ['https://example.com/a', 'https://example.com/b'])
      ).toBe(2);
    });
  });

  describe('resolveStoryImageUrl', () => {
    const publicLookup: DnsLookupAllFn = async () => [{ address: '93.184.216.34', family: 4 }];
    const privateLookup: DnsLookupAllFn = async () => [{ address: '169.254.169.254', family: 4 }];

    it('prefers the translation image_url over the captured og:image', async () => {
      await expect(
        resolveStoryImageUrl({
          translatedImageUrl: 'https://cdn.example.com/og.png',
          capturedOgImageUrl: 'https://example.com/captured.png',
          storyIndex: 1,
          dnsLookup: publicLookup,
        })
      ).resolves.toBe('https://cdn.example.com/og.png');
    });

    it('falls back to the captured og:image when it resolves to a public host', async () => {
      await expect(
        resolveStoryImageUrl({
          translatedImageUrl: null,
          capturedOgImageUrl: 'https://example.com/captured.png',
          storyIndex: 1,
          dnsLookup: publicLookup,
        })
      ).resolves.toBe('https://example.com/captured.png');
    });

    it('drops a captured og:image that points at a private or metadata address', async () => {
      const warnings: string[] = [];
      await expect(
        resolveStoryImageUrl({
          translatedImageUrl: null,
          capturedOgImageUrl: 'https://attacker.example/meta.png',
          storyIndex: 4,
          dnsLookup: privateLookup,
          onWarn: (msg) => warnings.push(msg),
        })
      ).resolves.toBeNull();
      expect(warnings[0]).toMatch(/Story #4: skipping captured og:image/);
    });

    it('returns null when neither source has an image', async () => {
      await expect(
        resolveStoryImageUrl({
          translatedImageUrl: null,
          capturedOgImageUrl: null,
          storyIndex: 1,
        })
      ).resolves.toBeNull();
    });
  });
});
