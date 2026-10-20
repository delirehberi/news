import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../cli.ts';
import { validateEnv } from '../config/env.ts';
import type { Script } from '../domain/script.ts';
import { getWeekPaths, readJson, writeJsonAtomic } from '../lib/paths.ts';
import type { WeeklyEdition, WorkerClient } from '../lib/workerClient.ts';
import {
  computeNarrationHash,
  runVoiceCommand,
  type SegmentAudioMetadata,
} from './voice.ts';

function buildSampleScript(): Script {
  return {
    intro: 'Merhaba, haftalık teknoloji özetimize hoş geldiniz.',
    segments: [
      {
        item_url: 'https://example.com/story-1',
        headline_tr: 'Yapay Zeka ve Açık Kaynak',
        narration_tr:
          'Bu hafta açık kaynak yapay zeka modellerinde önemli bir performans artışı yaşandı.',
      },
      {
        item_url: 'https://example.com/story-2',
        headline_tr: 'Cloudflare Workers Güncellemesi',
        narration_tr:
          'Cloudflare, uç noktada çalışan uygulamalar için yeni depolama özelliklerini duyurdu.',
      },
    ],
    outro: 'İzlediğiniz için teşekkürler, haftaya görüşmek üzere!',
  };
}

function buildApprovedEdition(week: string, script: Script): WeeklyEdition {
  return {
    week,
    status: 'approved',
    title_tr: 'Haftalık Teknoloji Özeti',
    intro_tr: 'Giriş metni',
    items: [],
    script,
    youtube_video_id: null,
    published_at: null,
    updated_at: '2026-10-20T16:00:00.000Z',
  };
}

function buildMockElevenLabsFetch() {
  const fakeMp3 = Buffer.from([0xff, 0xfb, 0x90, 0xc4, 0x11, 0x22]).toString('base64');

  return vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { text: string; model_id: string };
    const chars = Array.from(body.text);
    const starts = chars.map((_, i) => Number((i * 0.04).toFixed(4)));
    const ends = chars.map((_, i) => Number(((i + 1) * 0.04).toFixed(4)));

    return new Response(
      JSON.stringify({
        audio_base64: fakeMp3,
        alignment: {
          characters: chars,
          character_start_times_seconds: starts,
          character_end_times_seconds: ends,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  });
}

describe('src/commands/voice.ts', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'news-video-voice-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('synthesizes <n>.mp3 and <n>.json for intro, each story, and outro, and skips unchanged segments on re-run', async () => {
    const week = '2026-W42';
    const script = buildSampleScript();
    const paths = getWeekPaths(week, tempDir);
    await writeJsonAtomic(paths.scriptJson, script);

    const workerClient: WorkerClient = {
      getCandidates: vi.fn(),
      getEdition: vi.fn().mockResolvedValue(buildApprovedEdition(week, script)),
      putEdition: vi.fn(),
      triggerSnapshot: vi.fn(),
    };

    const mockFetch = buildMockElevenLabsFetch();
    const controller = new AbortController();
    const env = validateEnv(
      {
        INGESTION_SECRET: 'secret-token',
        ELEVENLABS_API_KEY: 'el-key-123',
        ELEVENLABS_VOICE_ID: 'voice-id-tr',
      },
      '/nonexistent/.env'
    );

    const ctx: CommandContext = {
      week,
      env,
      signal: controller.signal,
    };

    // First run: all 4 segments (0: intro, 1: story 1, 2: story 2, 3: outro) are synthesized
    const firstRun = await runVoiceCommand(ctx, {
      workerClient,
      outRoot: tempDir,
      fetchImpl: mockFetch,
      stdout: () => {},
    });

    expect(firstRun.synthesizedCount).toBe(4);
    expect(firstRun.skippedCount).toBe(0);
    expect(firstRun.mock).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(4);

    for (let idx = 0; idx < 4; idx++) {
      const mp3Stat = await fs.stat(path.join(paths.audioDir, `${idx}.mp3`));
      expect(mp3Stat.size).toBeGreaterThan(0);

      const meta = await readJson<SegmentAudioMetadata>(
        path.join(paths.audioDir, `${idx}.json`)
      );
      expect(meta.index).toBe(idx);
      expect(meta.words.length).toBeGreaterThan(0);
      expect(meta.captions.length).toBeGreaterThan(0);
      expect(meta.duration_seconds).toBeGreaterThan(0);
    }

    // Second run with identical script: all 4 segments are skipped (0 ElevenLabs API calls)
    mockFetch.mockClear();
    const secondRun = await runVoiceCommand(ctx, {
      workerClient,
      outRoot: tempDir,
      fetchImpl: mockFetch,
      stdout: () => {},
    });

    expect(secondRun.synthesizedCount).toBe(0);
    expect(secondRun.skippedCount).toBe(4);
    expect(mockFetch).not.toHaveBeenCalled();

    // Third run after editing Story 1 narration: only segment 1 is re-synthesized
    script.segments[0].narration_tr =
      'Bu hafta açık kaynak yapay zeka dünyasında yepyeni gelişmeler kaydedildi.';
    await writeJsonAtomic(paths.scriptJson, script);

    const thirdRun = await runVoiceCommand(ctx, {
      workerClient,
      outRoot: tempDir,
      fetchImpl: mockFetch,
      stdout: () => {},
    });

    expect(thirdRun.synthesizedCount).toBe(1);
    expect(thirdRun.skippedCount).toBe(3);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const updatedMeta = await readJson<SegmentAudioMetadata>(
      path.join(paths.audioDir, '1.json')
    );
    expect(updatedMeta.narration_hash).toBe(
      computeNarrationHash(script.segments[0].narration_tr)
    );
  });

  it('uses mock voice synthesis when ElevenLabs credentials are not configured', async () => {
    const week = '2026-W42';
    const script = buildSampleScript();
    const paths = getWeekPaths(week, tempDir);
    await writeJsonAtomic(paths.scriptJson, script);

    const workerClient: WorkerClient = {
      getCandidates: vi.fn(),
      getEdition: vi.fn().mockResolvedValue(buildApprovedEdition(week, script)),
      putEdition: vi.fn(),
      triggerSnapshot: vi.fn(),
    };

    const controller = new AbortController();
    const env = validateEnv(
      {
        INGESTION_SECRET: 'secret-token',
      },
      '/nonexistent/.env'
    );

    const result = await runVoiceCommand(
      {
        week,
        env,
        signal: controller.signal,
      },
      {
        workerClient,
        outRoot: tempDir,
        stdout: () => {},
      }
    );

    expect(result.mock).toBe(true);
    expect(result.synthesizedCount).toBe(4);
    expect(result.skippedCount).toBe(0);

    const seg0Mp3 = await fs.readFile(path.join(paths.audioDir, '0.mp3'));
    expect(seg0Mp3.byteLength % 417).toBe(0);
    expect(Array.from(seg0Mp3.subarray(0, 4))).toEqual([0xff, 0xfb, 0x90, 0xc4]);
  });

  it('refuses to run if edition is not approved or if ElevenLabs credentials are only partially configured', async () => {
    const week = '2026-W42';
    const script = buildSampleScript();
    const paths = getWeekPaths(week, tempDir);
    await writeJsonAtomic(paths.scriptJson, script);

    const draftWorkerClient: WorkerClient = {
      getCandidates: vi.fn(),
      getEdition: vi.fn().mockResolvedValue({
        ...buildApprovedEdition(week, script),
        status: 'draft',
      }),
      putEdition: vi.fn(),
      triggerSnapshot: vi.fn(),
    };

    const controller = new AbortController();
    const envWithPartialKey = validateEnv(
      {
        INGESTION_SECRET: 'secret-token',
        ELEVENLABS_API_KEY: 'only-key-no-voice-id',
      },
      '/nonexistent/.env'
    );

    await expect(
      runVoiceCommand(
        { week, env: envWithPartialKey, signal: controller.signal },
        { workerClient: draftWorkerClient, outRoot: tempDir, stdout: () => {} }
      )
    ).rejects.toThrowError(/must be "approved" or "published"/);

    const approvedWorkerClient: WorkerClient = {
      ...draftWorkerClient,
      getEdition: vi.fn().mockResolvedValue(buildApprovedEdition(week, script)),
    };

    await expect(
      runVoiceCommand(
        { week, env: envWithPartialKey, signal: controller.signal },
        { workerClient: approvedWorkerClient, outRoot: tempDir, stdout: () => {} }
      )
    ).rejects.toThrowError(/Missing or invalid ElevenLabs environment configuration/);
  });
});

