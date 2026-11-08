import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../cli.ts';
import { validateEnv } from '../config/env.ts';
import {
  CAPTURE_MAX_HEIGHT_PX,
  computeUrlHash,
  type PageCaptureMetadata,
} from '../domain/pageCapture.ts';
import { fileExists, getWeekPaths, readJson, writeJsonAtomic } from '../lib/paths.ts';
import {
  buildNumberedPageElements,
  normalizeOgImageUrl,
  runCaptureCommand,
  type CaptureBrowserFactory,
  type CaptureBrowserSession,
} from './capture.ts';
import { runScriptCommand } from './script.ts';
import type { WeeklyTranslation } from './translate.ts';

const FAKE_PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makeSampleTranslation(week: string = '2026-W42'): WeeklyTranslation {
  return {
    week,
    translated_at: '2026-10-20T15:00:00.000Z',
    title_tr: 'Linux Kernel Rust ve SQLite Edge Mimarisi',
    intro_tr: 'Bu haftanın öne çıkan gelişmeleri.',
    items: [
      {
        url: 'https://example.com/story-1',
        title_tr: 'Birinci Haber',
        summary_tr: 'Birinci haberin özeti.',
        source: 'hackernews',
        image_url: 'https://example.com/og-1.png',
      },
      {
        url: 'https://example.com/story-2',
        title_tr: 'İkinci Haber',
        summary_tr: 'İkinci haberin özeti.',
        source: 'lobsters',
        image_url: 'https://example.com/og-2.png',
      },
    ],
  };
}

describe('src/commands/capture.ts', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'news-video-capture-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('buildNumberedPageElements', () => {
    it('assigns sequential per-kind IDs, filters tiny/out-of-bounds boxes, and clamps height to maxPageHeight', () => {
      const elements = buildNumberedPageElements(
        [
          {
            kind: 'h1',
            tagName: 'H1',
            text: '  Main   Article   Title ',
            box: { x: 120.4, y: 80.2, width: 800.6, height: 64.1 },
          },
          {
            kind: 'paragraph',
            tagName: 'P',
            text: 'Lede paragraph one.',
            box: { x: 120, y: 170, width: 760, height: 48 },
          },
          {
            kind: 'paragraph',
            tagName: 'P',
            text: 'Tiny hidden element should be skipped',
            box: { x: 120, y: 230, width: 10, height: 5 },
          },
          {
            kind: 'figure',
            tagName: 'FIGURE',
            text: 'Benchmark chart',
            box: { x: 120, y: 300, width: 760, height: 400 },
          },
          {
            kind: 'code',
            tagName: 'PRE',
            text: 'fn main() {}',
            box: { x: 120, y: 11800, width: 760, height: 500 }, // extends past 12000px cap
          },
          {
            kind: 'paragraph',
            tagName: 'P',
            text: 'Beyond cap should be dropped',
            box: { x: 120, y: 12500, width: 760, height: 60 },
          },
        ],
        CAPTURE_MAX_HEIGHT_PX
      );

      expect(elements).toEqual([
        {
          id: 'h1',
          kind: 'h1',
          tagName: 'h1',
          text: 'Main Article Title',
          box: { x: 120, y: 80, width: 801, height: 64 },
        },
        {
          id: 'p1',
          kind: 'paragraph',
          tagName: 'p',
          text: 'Lede paragraph one.',
          box: { x: 120, y: 170, width: 760, height: 48 },
        },
        {
          id: 'fig1',
          kind: 'figure',
          tagName: 'figure',
          text: 'Benchmark chart',
          box: { x: 120, y: 300, width: 760, height: 400 },
        },
        {
          id: 'code1',
          kind: 'code',
          tagName: 'pre',
          text: 'fn main() {}',
          box: { x: 120, y: 11800, width: 760, height: 200 },
        },
      ]);
    });
  });

  describe('normalizeOgImageUrl', () => {
    it('keeps absolute http(s) URLs and rejects other schemes, credentials, and oversized values', () => {
      expect(normalizeOgImageUrl(' https://cdn.example.com/a.png ')).toBe('https://cdn.example.com/a.png');
      expect(normalizeOgImageUrl('http://example.com/a.jpg')).toBe('http://example.com/a.jpg');
      expect(normalizeOgImageUrl('data:image/png;base64,AAAA')).toBeNull();
      expect(normalizeOgImageUrl('javascript:alert(1)')).toBeNull();
      expect(normalizeOgImageUrl('https://user:pass@example.com/a.png')).toBeNull();
      expect(normalizeOgImageUrl('/relative/path.png')).toBeNull();
      expect(normalizeOgImageUrl(`https://example.com/${'a'.repeat(3000)}`)).toBeNull();
      expect(normalizeOgImageUrl(null)).toBeNull();
      expect(normalizeOgImageUrl(undefined)).toBeNull();
    });
  });

  describe('runCaptureCommand', () => {
    it('captures pages/<n>.png and pages/<n>.json on cache miss and skips browser launch on cache hit', async () => {
      const week = '2026-W42';
      const paths = getWeekPaths(week, tempDir);
      await writeJsonAtomic(paths.translationJson, makeSampleTranslation(week));

      const captureUrlMock = vi.fn<CaptureBrowserSession['captureUrl']>().mockImplementation(
        async ({ url }) => ({
          screenshotPng: FAKE_PNG_BYTES,
          extraction: {
            pageHeight: 3400,
            excerpt: `Main article excerpt for ${url} with detailed engineering context.`,
            ogImageUrl: url.endsWith('story-1') ? 'https://cdn.example.com/story-1-og.png' : null,
            elements: [
              {
                kind: 'h1',
                tagName: 'h1',
                text: `Headline for ${url}`,
                box: { x: 160, y: 100, width: 800, height: 60 },
              },
              {
                kind: 'paragraph',
                tagName: 'p',
                text: 'Lede paragraph with benchmark numbers: 40% faster latency.',
                box: { x: 160, y: 190, width: 760, height: 52 },
              },
            ],
          },
        })
      );

      const closeMock = vi.fn<CaptureBrowserSession['close']>().mockResolvedValue(undefined);
      const browserFactory = vi.fn<CaptureBrowserFactory>().mockResolvedValue({
        captureUrl: captureUrlMock,
        close: closeMock,
      });

      const publicDnsLookup = vi
        .fn()
        .mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

      const ctx: CommandContext = {
        week,
        env: validateEnv({ INGESTION_SECRET: 'test-secret' }),
        signal: new AbortController().signal,
      };

      // 1. First run: cache miss -> captures both stories
      const firstRun = await runCaptureCommand(ctx, {
        outRoot: tempDir,
        browserFactory,
        dnsLookup: publicDnsLookup,
        now: () => new Date('2026-10-20T15:30:00.000Z'),
        stdout: () => {},
      });

      expect(firstRun.capturedCount).toBe(2);
      expect(firstRun.cachedCount).toBe(0);
      expect(firstRun.failedCount).toBe(0);
      expect(browserFactory).toHaveBeenCalledTimes(1);
      expect(captureUrlMock).toHaveBeenCalledTimes(2);
      expect(closeMock).toHaveBeenCalledTimes(1);

      expect(await fileExists(path.join(paths.pagesDir, '1.png'))).toBe(true);
      expect(await fileExists(path.join(paths.pagesDir, '2.png'))).toBe(true);

      const meta1 = await readJson<PageCaptureMetadata>(path.join(paths.pagesDir, '1.json'));
      expect(meta1.url).toBe('https://example.com/story-1');
      expect(meta1.url_hash).toBe(computeUrlHash('https://example.com/story-1'));
      expect(meta1.viewport).toEqual({ width: 1440, height: 900, deviceScaleFactor: 1 });
      expect(meta1.elements[0]?.id).toBe('h1');
      expect(meta1.elements[1]?.id).toBe('p1');
      expect(meta1.og_image_url).toBe('https://cdn.example.com/story-1-og.png');
      const meta2 = await readJson<PageCaptureMetadata>(path.join(paths.pagesDir, '2.json'));
      expect(meta2.og_image_url).toBeNull();

      // 2. Second run with same URLs: cache hit -> skips browser launch completely
      const secondRun = await runCaptureCommand(ctx, {
        outRoot: tempDir,
        browserFactory,
        dnsLookup: publicDnsLookup,
        stdout: () => {},
      });

      expect(secondRun.capturedCount).toBe(0);
      expect(secondRun.cachedCount).toBe(2);
      expect(secondRun.failedCount).toBe(0);
      expect(browserFactory).toHaveBeenCalledTimes(1); // still 1 — not called again!

      // 3. Third run after story #2 URL changes -> re-captures only story #2
      const updatedTranslation = makeSampleTranslation(week);
      updatedTranslation.items[1] = {
        ...updatedTranslation.items[1],
        url: 'https://example.com/story-2-updated',
      };
      await writeJsonAtomic(paths.translationJson, updatedTranslation);

      const thirdRun = await runCaptureCommand(ctx, {
        outRoot: tempDir,
        browserFactory,
        dnsLookup: publicDnsLookup,
        stdout: () => {},
      });

      expect(thirdRun.capturedCount).toBe(1);
      expect(thirdRun.cachedCount).toBe(1);
      expect(thirdRun.failedCount).toBe(0);
      expect(browserFactory).toHaveBeenCalledTimes(2);
      expect(captureUrlMock).toHaveBeenCalledTimes(3);
    });

    it('treats a captured 403 / not-found page as a failed capture and writes no files for it', async () => {
      const week = '2026-W42';
      const paths = getWeekPaths(week, tempDir);
      await writeJsonAtomic(paths.translationJson, makeSampleTranslation(week));

      const captureUrlMock = vi.fn<CaptureBrowserSession['captureUrl']>().mockImplementation(
        async ({ url }) => ({
          screenshotPng: FAKE_PNG_BYTES,
          extraction: url.endsWith('story-1')
            ? {
                pageHeight: 900,
                excerpt: '403 Forbidden',
                ogImageUrl: null,
                elements: [
                  {
                    kind: 'h1',
                    tagName: 'h1',
                    text: '403',
                    box: { x: 0, y: 0, width: 1440, height: 291 },
                  },
                ],
              }
            : {
                pageHeight: 2400,
                excerpt: `Main article excerpt for ${url} with detailed engineering context.`,
                ogImageUrl: null,
                elements: [
                  {
                    kind: 'h1',
                    tagName: 'h1',
                    text: `Headline for ${url}`,
                    box: { x: 160, y: 100, width: 800, height: 60 },
                  },
                ],
              },
        })
      );
      const browserFactory = vi.fn<CaptureBrowserFactory>().mockResolvedValue({
        captureUrl: captureUrlMock,
        close: vi.fn<CaptureBrowserSession['close']>().mockResolvedValue(undefined),
      });

      const logs: string[] = [];
      const result = await runCaptureCommand(
        {
          week,
          env: validateEnv({ INGESTION_SECRET: 'test-secret' }),
          signal: new AbortController().signal,
        },
        {
          outRoot: tempDir,
          browserFactory,
          dnsLookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
          stdout: (msg) => logs.push(msg),
        }
      );

      expect(result.capturedCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(await fileExists(path.join(paths.pagesDir, '1.png'))).toBe(false);
      expect(await fileExists(path.join(paths.pagesDir, '1.json'))).toBe(false);
      expect(await fileExists(path.join(paths.pagesDir, '2.json'))).toBe(true);
      expect(logs.some((l) => l.includes('error or block page'))).toBe(true);
    });

    it('never fails the run when a story hits SSRF guard or navigation timeout (falls back to OG image)', async () => {
      const week = '2026-W42';
      const paths = getWeekPaths(week, tempDir);
      const translation = makeSampleTranslation(week);
      // Story 1 points to a domain that resolves to loopback (SSRF), Story 2 times out in browser
      translation.items[0].url = 'https://internal.example.com/admin';
      translation.items[1].url = 'https://slow.example.com/article';
      await writeJsonAtomic(paths.translationJson, translation);

      const captureUrlMock = vi
        .fn<CaptureBrowserSession['captureUrl']>()
        .mockRejectedValue(new Error('Navigation timeout of 25000 ms exceeded'));
      const closeMock = vi.fn<CaptureBrowserSession['close']>().mockResolvedValue(undefined);

      const browserFactory = vi.fn<CaptureBrowserFactory>().mockResolvedValue({
        captureUrl: captureUrlMock,
        close: closeMock,
      });

      const dnsLookup = vi.fn().mockImplementation(async (hostname: string) => {
        if (hostname === 'internal.example.com') {
          return [{ address: '127.0.0.1', family: 4 }];
        }
        return [{ address: '93.184.216.34', family: 4 }];
      });

      const logs: string[] = [];
      const result = await runCaptureCommand(
        {
          week,
          env: validateEnv({ INGESTION_SECRET: 'test-secret' }),
          signal: new AbortController().signal,
        },
        {
          outRoot: tempDir,
          browserFactory,
          dnsLookup,
          stdout: (msg) => logs.push(msg),
        }
      );

      expect(result.capturedCount).toBe(0);
      expect(result.cachedCount).toBe(0);
      expect(result.failedCount).toBe(2);
      expect(result.captures).toEqual([null, null]);

      // Story 1 was blocked by SSRF before browser navigation; Story 2 failed inside browser navigation
      expect(captureUrlMock).toHaveBeenCalledTimes(1);
      expect(closeMock).toHaveBeenCalledTimes(1);

      const combinedLogs = logs.join('\n');
      expect(combinedLogs).toContain('SSRF guard rejected URL');
      expect(combinedLogs).toContain('Navigation timeout');
      expect(combinedLogs).toContain('falling back to OG image');
    });

    it('feeds captured plain-text excerpt into runScriptCommand prompt when pages/<n>.json exists', async () => {
      const week = '2026-W42';
      const paths = getWeekPaths(week, tempDir);
      await writeJsonAtomic(paths.translationJson, makeSampleTranslation(week));

      const browserFactory: CaptureBrowserFactory = async () => ({
        captureUrl: async ({ url }) => ({
          screenshotPng: FAKE_PNG_BYTES,
          extraction: {
            pageHeight: 2000,
            excerpt: `EXTRACTED_EXCERPT_FOR_${url}`,
            elements: [],
          },
        }),
        close: async () => {},
      });

      const env = validateEnv({
        INGESTION_SECRET: 'test-secret',
        AI_GATEWAY_BASE_URL: 'https://ai.workouse.com/v1',
        AI_GATEWAY_API_KEY: 'ai-key-123',
        AI_MODEL: 'gpt-4o-mini',
      });

      const ctx: CommandContext = {
        week,
        env,
        signal: new AbortController().signal,
      };

      await runCaptureCommand(ctx, {
        outRoot: tempDir,
        browserFactory,
        dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
        stdout: () => {},
      });

      const words = (n: number, p: string) =>
        Array.from({ length: n }, (_, i) => `${p}${i + 1}`).join(' ');

      const mockFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    intro: words(40, 'intro'),
                    segments: [
                      {
                        item_url: 'https://example.com/story-1',
                        headline_tr: 'Başlık 1',
                        narration_tr: words(130, 'seg1'),
                      },
                      {
                        item_url: 'https://example.com/story-2',
                        headline_tr: 'Başlık 2',
                        narration_tr: words(130, 'seg2'),
                      },
                    ],
                    outro: words(30, 'outro'),
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await runScriptCommand(ctx, {
        outRoot: tempDir,
        fetchImpl: mockFetch,
        stdout: () => {},
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const requestBody = JSON.parse(String(mockFetch.mock.calls[0][1]?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const userPrompt = requestBody.messages[1]?.content ?? '';
      expect(userPrompt).toContain('EXTRACTED_EXCERPT_FOR_https://example.com/story-1');
      expect(userPrompt).toContain('EXTRACTED_EXCERPT_FOR_https://example.com/story-2');
    });
  });
});
