import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCliArgs, type CommandContext } from './cli.ts';
import { runApproveCommand } from './commands/approve.ts';
import { runCaptureCommand } from './commands/capture.ts';
import { runRenderCommand, type RemotionRendererAdapter } from './commands/render.ts';
import { runScriptCommand } from './commands/script.ts';
import { runSelectCommand } from './commands/select.ts';
import { runTranslateCommand } from './commands/translate.ts';
import { runUploadCommand } from './commands/upload.ts';
import { runVoiceCommand } from './commands/voice.ts';
import { validateFullEnv } from './config/env.ts';
import { buildSilentMp3Bytes } from './lib/elevenlabs.ts';
import { getWeekPaths, isValidIsoWeek, readText, writeTextAtomic } from './lib/paths.ts';
import {
  createWorkerClient,
  type WeeklyCandidateRow,
  type WeeklyEdition,
  type WeeklyStatus,
} from './lib/workerClient.ts';

const CANARY_SECRETS = {
  INGESTION_SECRET: 'CANARY_INGESTION_SECRET_991_DO_NOT_LEAK',
  AI_GATEWAY_API_KEY: 'CANARY_AI_API_KEY_992_DO_NOT_LEAK',
  ELEVENLABS_API_KEY: 'CANARY_ELEVENLABS_KEY_993_DO_NOT_LEAK',
  YOUTUBE_CLIENT_SECRET: 'CANARY_YT_CLIENT_SECRET_994_DO_NOT_LEAK',
  YOUTUBE_REFRESH_TOKEN: 'CANARY_YT_REFRESH_TOKEN_995_DO_NOT_LEAK',
  YOUTUBE_ACCESS_TOKEN: 'CANARY_YT_ACCESS_TOKEN_996_DO_NOT_LEAK',
} as const;

const STATUS_ORDER: Record<WeeklyStatus, number> = {
  draft: 1,
  approved: 2,
  published: 3,
};

function generateTurkishWords(count: number, prefix: string): string {
  return Array.from({ length: count }, (_, idx) => `${prefix}${idx + 1}`).join(' ');
}

function buildMockAlignment(text: string): {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
} {
  const chars = Array.from(text.trim());
  const characters: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let cursor = 0;

  for (const ch of chars) {
    const start = Number(cursor.toFixed(4));
    cursor += ch === ' ' ? 0.05 : 0.04;
    const end = Number(cursor.toFixed(4));
    characters.push(ch);
    starts.push(start);
    ends.push(end);
  }

  return {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  };
}

async function listAllFilesRecursively(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listAllFilesRecursively(fullPath);
      files.push(...nested);
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('Weekly Video Pipeline End-to-End & Security Audit', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'news-video-e2e-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('runs select -> translate -> script -> edit script.md -> approve -> voice -> render -> upload with zero secret leaks', async () => {
    const week = '2026-W42';
    const logs: string[] = [];
    const stdout = (msg: string): void => {
      logs.push(msg);
    };

    const env = validateFullEnv({
      NEWS_API_BASE_URL: 'https://news.emre.xyz',
      INGESTION_SECRET: CANARY_SECRETS.INGESTION_SECRET,
      AI_GATEWAY_BASE_URL: 'https://ai.workouse.com/v1',
      AI_GATEWAY_API_KEY: CANARY_SECRETS.AI_GATEWAY_API_KEY,
      AI_MODEL: 'gpt-4o-mini',
      ELEVENLABS_API_KEY: CANARY_SECRETS.ELEVENLABS_API_KEY,
      ELEVENLABS_VOICE_ID: 'voice_tr_test',
      ELEVENLABS_MODEL_ID: 'eleven_multilingual_v2',
      YOUTUBE_CLIENT_ID: 'yt-client-id.apps.googleusercontent.com',
      YOUTUBE_CLIENT_SECRET: CANARY_SECRETS.YOUTUBE_CLIENT_SECRET,
      YOUTUBE_REFRESH_TOKEN: CANARY_SECRETS.YOUTUBE_REFRESH_TOKEN,
      YOUTUBE_PRIVACY: 'private',
      VIDEO_ITEM_COUNT: '2',
    });

    const candidateRows: WeeklyCandidateRow[] = [
      {
        week,
        url: 'https://example.com/story-rust-kernel',
        article_id: 'hn-101',
        title: 'Rust in the Linux Kernel Reaches Major Milestone',
        source: 'hackernews',
        summary: 'New Rust abstractions land in mainline kernel.',
        image_url: 'https://img.example.com/rust.png',
        is_liked: 1,
        follower_likes: 6,
        importance_score: 3.4,
        source_count: 3,
        seen_count: 4,
        cluster_id: 'c-rust',
        captured_at: '2026-10-18T10:00:00.000Z',
      },
      {
        week,
        url: 'https://example.com/story-sqlite-edge',
        article_id: 'lobsters-202',
        title: 'Distributed SQLite Replication at the Edge',
        source: 'lobsters',
        summary: 'Low-latency read replicas with deterministic conflict resolution.',
        image_url: null,
        is_liked: 0,
        follower_likes: 4,
        importance_score: 2.8,
        source_count: 2,
        seen_count: 2,
        cluster_id: 'c-sqlite',
        captured_at: '2026-10-18T11:00:00.000Z',
      },
      {
        week,
        url: 'https://example.com/story-extra',
        article_id: 'hn-303',
        title: 'Lower Ranked Extra Story',
        source: 'hackernews',
        summary: 'Should be trimmed by VIDEO_ITEM_COUNT=2.',
        image_url: null,
        is_liked: 0,
        follower_likes: 0,
        importance_score: 1.0,
        source_count: 1,
        seen_count: 1,
        cluster_id: null,
        captured_at: '2026-10-18T09:00:00.000Z',
      },
    ];

    const editionsStore = new Map<string, WeeklyEdition>();
    let resumableUploadCalls = 0;
    let thumbnailUploadCalls = 0;

    // Unified mock fetch covering Worker Admin API, AI Gateway, ElevenLabs, OG Image, and YouTube APIs
    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = new Headers(init?.headers);

      // 1. Worker Admin API
      if (url.startsWith('https://news.emre.xyz/api/admin/weekly/')) {
        const auth = headers.get('Authorization');
        if (auth !== `Bearer ${CANARY_SECRETS.INGESTION_SECRET}`) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }

        const suffix = url.slice('https://news.emre.xyz/api/admin/weekly/'.length);
        if (suffix.endsWith('/candidates')) {
          const targetWeek = decodeURIComponent(suffix.slice(0, -'/candidates'.length));
          if (!isValidIsoWeek(targetWeek)) {
            return new Response(JSON.stringify({ error: 'Bad Request' }), { status: 400 });
          }
          const rows = candidateRows.filter((r) => r.week === targetWeek);
          return new Response(JSON.stringify(rows), { status: 200 });
        }

        const targetWeek = decodeURIComponent(suffix);
        if (!isValidIsoWeek(targetWeek)) {
          return new Response(JSON.stringify({ error: 'Bad Request' }), { status: 400 });
        }

        if (method === 'GET') {
          const existing = editionsStore.get(targetWeek);
          if (!existing) {
            return new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 });
          }
          return new Response(JSON.stringify(existing), { status: 200 });
        }

        if (method === 'PUT') {
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          const existing = editionsStore.get(targetWeek);
          const nextStatus = (body.status as WeeklyStatus | undefined) ?? existing?.status ?? 'draft';

          if (existing && body.status) {
            if (STATUS_ORDER[nextStatus] < STATUS_ORDER[existing.status]) {
              return new Response(JSON.stringify({ error: 'Conflict' }), { status: 409 });
            }
          }

          const updated: WeeklyEdition = {
            week: targetWeek,
            status: nextStatus,
            title_tr:
              body.title_tr !== undefined
                ? (body.title_tr as string | null)
                : (existing?.title_tr ?? null),
            intro_tr:
              body.intro_tr !== undefined
                ? (body.intro_tr as string | null)
                : (existing?.intro_tr ?? null),
            items:
              body.items !== undefined
                ? (body.items as WeeklyEdition['items'])
                : (existing?.items ?? []),
            script: body.script !== undefined ? body.script : (existing?.script ?? null),
            youtube_video_id:
              body.youtube_video_id !== undefined
                ? (body.youtube_video_id as string | null)
                : (existing?.youtube_video_id ?? null),
            published_at:
              nextStatus === 'published'
                ? (existing?.published_at ?? '2026-10-20T15:00:00.000Z')
                : (existing?.published_at ?? null),
            updated_at: '2026-10-20T15:00:00.000Z',
          };
          editionsStore.set(targetWeek, updated);
          return new Response(JSON.stringify(updated), { status: 200 });
        }
      }

      // 2. AI Gateway (/chat/completions)
      if (url === 'https://ai.workouse.com/v1/chat/completions') {
        const auth = headers.get('Authorization');
        if (auth !== `Bearer ${CANARY_SECRETS.AI_GATEWAY_API_KEY}`) {
          return new Response(JSON.stringify({ error: 'Unauthorized AI key' }), { status: 401 });
        }

        const reqBody = JSON.parse(String(init?.body ?? '{}')) as {
          messages: Array<{ role: string; content: string }>;
        };
        const systemContent = reqBody.messages[0]?.content ?? '';

        if (systemContent.includes('title_tr') && systemContent.includes('summary_tr')) {
          const translationPayload = {
            title_tr: 'Linux Çekirdeğinde Rust ve Dağıtık SQLite Mimarisinde Yeni Dönem',
            intro_tr:
              'Bu haftanın öne çıkan mühendislik gelişmelerinde Linux çekirdeğindeki Rust sürücüleri ve kenar sunucularda SQLite replikasyonu yer alıyor.',
            items: [
              {
                url: 'https://example.com/story-rust-kernel',
                title_tr: 'Linux Çekirdeğinde Rust Soyutlamaları Ana Ağaca Eklendi',
                summary_tr:
                  'Bellek güvenliği sağlayan yeni Rust sürücü katmanları ana çekirdek sürümüne kabul edildi.',
              },
              {
                url: 'https://example.com/story-sqlite-edge',
                title_tr: 'Edge Üzerinde Dağıtık SQLite Replikasyonu',
                summary_tr:
                  'Düşük gecikmeli okuma kopyaları ve deterministik çakışma çözümü sunan yeni mimari tanıtıldı.',
              },
            ],
          };
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: JSON.stringify(translationPayload) } }],
            }),
            { status: 200 }
          );
        }

        const generatedScript = {
          intro: generateTurkishWords(45, 'acilis'),
          segments: [
            {
              item_url: 'https://example.com/story-rust-kernel',
              headline_tr: 'Linux Çekirdeğinde Rust Soyutlamaları',
              narration_tr: generateTurkishWords(140, 'rusthaber'),
            },
            {
              item_url: 'https://example.com/story-sqlite-edge',
              headline_tr: 'Edge Üzerinde Dağıtık SQLite',
              narration_tr: generateTurkishWords(140, 'sqlitehaber'),
            },
          ],
          outro: generateTurkishWords(35, 'kapanis'),
        };
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(generatedScript) } }],
          }),
          { status: 200 }
        );
      }

      // 3. ElevenLabs TTS with-timestamps
      if (url.startsWith('https://api.elevenlabs.io/v1/text-to-speech/')) {
        if (headers.get('xi-api-key') !== CANARY_SECRETS.ELEVENLABS_API_KEY) {
          return new Response(JSON.stringify({ error: 'Unauthorized ElevenLabs key' }), {
            status: 401,
          });
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as { text: string };
        const alignment = buildMockAlignment(body.text);
        const mp3Bytes = buildSilentMp3Bytes(2.0);
        return new Response(
          JSON.stringify({
            audio_base64: Buffer.from(mp3Bytes).toString('base64'),
            alignment,
          }),
          { status: 200 }
        );
      }

      // 4. Story OG Image download
      if (url === 'https://img.example.com/rust.png') {
        return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }

      // 5. Google OAuth2 Token Refresh
      if (url === 'https://oauth2.googleapis.com/token') {
        const params = new URLSearchParams(String(init?.body ?? ''));
        if (
          params.get('client_secret') !== CANARY_SECRETS.YOUTUBE_CLIENT_SECRET ||
          params.get('refresh_token') !== CANARY_SECRETS.YOUTUBE_REFRESH_TOKEN
        ) {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
        }
        return new Response(
          JSON.stringify({
            access_token: CANARY_SECRETS.YOUTUBE_ACCESS_TOKEN,
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200 }
        );
      }

      // 6. YouTube Resumable Upload Init
      if (url.startsWith('https://www.googleapis.com/upload/youtube/v3/videos')) {
        if (headers.get('Authorization') !== `Bearer ${CANARY_SECRETS.YOUTUBE_ACCESS_TOKEN}`) {
          return new Response(JSON.stringify({ error: 'Unauthorized YouTube token' }), {
            status: 401,
          });
        }
        return new Response(null, {
          status: 200,
          headers: {
            location: 'https://www.googleapis.com/upload/youtube/v3/resumable-session-42',
          },
        });
      }

      // 7. YouTube Resumable Upload Stream PUT
      if (url === 'https://www.googleapis.com/upload/youtube/v3/resumable-session-42') {
        resumableUploadCalls++;
        return new Response(JSON.stringify({ id: 'yt_e2e_video_42' }), { status: 200 });
      }

      // 8. YouTube Thumbnail Set
      if (url.startsWith('https://www.googleapis.com/upload/youtube/v3/thumbnails/set')) {
        thumbnailUploadCalls++;
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }

      return new Response(`Unhandled mock URL: ${method} ${url}`, { status: 500 });
    };

    const workerClient = createWorkerClient({
      baseUrl: env.NEWS_API_BASE_URL,
      ingestionSecret: env.INGESTION_SECRET,
      fetchImpl: mockFetch,
    });

    const ctx: CommandContext = {
      week,
      env,
      signal: new AbortController().signal,
    };

    // --- STAGE 1: make video-draft (select -> translate -> capture -> script) ---
    const selection = await runSelectCommand(ctx, {
      workerClient,
      outRoot: tempDir,
      stdout,
    });
    expect(selection.selected_count).toBe(2);

    const { edition: draftEdition } = await runTranslateCommand(ctx, {
      workerClient,
      outRoot: tempDir,
      fetchImpl: mockFetch,
      stdout,
    });
    expect(draftEdition.status).toBe('draft');

    const captureResult = await runCaptureCommand(ctx, {
      outRoot: tempDir,
      dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
      browserFactory: async () => ({
        captureUrl: async ({ url }) => ({
          screenshotPng: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          extraction: {
            pageHeight: 2400,
            excerpt: `Captured article text for ${url}`,
            elements: [
              {
                kind: 'h1',
                tagName: 'h1',
                text: `Title for ${url}`,
                box: { x: 160, y: 100, width: 800, height: 60 },
              },
            ],
          },
        }),
        close: async () => {},
      }),
      stdout,
    });
    expect(captureResult.capturedCount).toBe(2);

    const { wordCount: initialWordCount } = await runScriptCommand(ctx, {
      outRoot: tempDir,
      fetchImpl: mockFetch,
      stdout,
    });
    expect(initialWordCount).toBe(360);

    // Verify production commands refuse to run while edition is still in 'draft'
    await expect(
      runVoiceCommand(ctx, {
        workerClient,
        outRoot: tempDir,
        fetchImpl: mockFetch,
        stdout,
      })
    ).rejects.toThrowError(/edition status is "draft", but must be "approved" or "published"/);

    // --- STAGE 2: Manual editorial review & edit of out/<week>/script.md ---
    const paths = getWeekPaths(week, tempDir);
    const originalMd = await readText(paths.scriptMd);
    const editedMd = originalMd.replace(
      '### Linux Çekirdeğinde Rust Soyutlamaları',
      '### Linux Çekirdeğinde Rust Sürücü Mimarisi (Editoryal İnceleme)'
    );
    await writeTextAtomic(paths.scriptMd, editedMd);

    // --- STAGE 3: make video-approve ---
    const approveResult = await runApproveCommand(ctx, {
      workerClient,
      outRoot: tempDir,
      fetchImpl: mockFetch,
      stdout,
    });
    expect(approveResult.edition.status).toBe('approved');
    expect(approveResult.script.segments[0]?.headline_tr).toBe(
      'Linux Çekirdeğinde Rust Sürücü Mimarisi (Editoryal İnceleme)'
    );

    // --- STAGE 4: make video-produce (voice -> render -> upload) ---
    const voiceResult = await runVoiceCommand(ctx, {
      workerClient,
      outRoot: tempDir,
      fetchImpl: mockFetch,
      stdout,
    });
    expect(voiceResult.synthesizedCount).toBe(4);
    expect(voiceResult.skippedCount).toBe(0);

    const remotionAdapter: RemotionRendererAdapter = {
      async bundleComposition({ publicDir }) {
        return publicDir;
      },
      async renderComposition({ videoOutputPath, thumbnailOutputPath }) {
        await fs.writeFile(videoOutputPath, Buffer.from('mock-rendered-h264-video-stream'));
        await fs.writeFile(thumbnailOutputPath, Buffer.from('mock-rendered-png-thumbnail'));
      },
    };

    const renderResult = await runRenderCommand(ctx, {
      workerClient,
      outRoot: tempDir,
      fetchImpl: mockFetch,
      remotionAdapter,
      stdout,
    });
    expect(renderResult.downloadedImagesCount).toBe(1);
    expect(renderResult.fallbackCardCount).toBe(1);

    const uploadResult = await runUploadCommand(ctx, {
      workerClient,
      outRoot: tempDir,
      fetchImpl: mockFetch,
      stdout,
    });
    expect(uploadResult.skipped).toBe(false);
    expect(uploadResult.videoId).toBe('yt_e2e_video_42');
    expect(uploadResult.edition.status).toBe('published');
    expect(uploadResult.edition.youtube_video_id).toBe('yt_e2e_video_42');
    expect(uploadResult.chapters?.[0]?.timestamp).toBe('00:00');
    expect(resumableUploadCalls).toBe(1);
    expect(thumbnailUploadCalls).toBe(1);

    // Re-running upload is idempotent
    const secondUpload = await runUploadCommand(ctx, {
      workerClient,
      outRoot: tempDir,
      fetchImpl: mockFetch,
      stdout,
    });
    expect(secondUpload.skipped).toBe(true);
    expect(resumableUploadCalls).toBe(1);

    // --- STAGE 5: Security Audit Assertions ---
    // 1. No canary secrets appear in any log message
    const combinedLogs = logs.join('\n');
    for (const [name, secretValue] of Object.entries(CANARY_SECRETS)) {
      expect(combinedLogs, `Secret ${name} leaked into CLI logs`).not.toContain(secretValue);
    }

    // 2. No canary secrets appear in any file inside out/<week>/
    const outFiles = await listAllFilesRecursively(paths.dir);
    expect(outFiles.length).toBeGreaterThanOrEqual(12);
    for (const filePath of outFiles) {
      const content = await fs.readFile(filePath, 'utf8');
      for (const [name, secretValue] of Object.entries(CANARY_SECRETS)) {
        expect(
          content,
          `Secret ${name} leaked into output artifact ${filePath}`
        ).not.toContain(secretValue);
      }
    }
  });

  it('validates :week input across CLI argument parsing, path resolution, and WorkerClient calls', async () => {
    const invalidWeeks = [
      '2026-W00',
      '2026-W54',
      '2026-W99',
      '2026-42',
      '2026-w42',
      '../2026-W42',
      '2026-W42/../../etc',
      '',
    ];

    const client = createWorkerClient({
      baseUrl: 'https://news.emre.xyz',
      ingestionSecret: 'test-secret',
    });

    for (const badWeek of invalidWeeks) {
      expect(isValidIsoWeek(badWeek)).toBe(false);
      expect(() => getWeekPaths(badWeek, tempDir)).toThrowError(/Invalid ISO week format/);
      if (badWeek.length > 0 && !badWeek.startsWith('-')) {
        expect(() => parseCliArgs(['select', '--week', badWeek])).toThrowError(
          /Invalid --week value/
        );
      }
      await expect(client.getCandidates(badWeek)).rejects.toThrowError(/Invalid week format/);
      await expect(client.getEdition(badWeek)).rejects.toThrowError(/Invalid week format/);
      await expect(client.putEdition(badWeek, { status: 'draft' })).rejects.toThrowError(
        /Invalid week format/
      );
    }
  });
});
