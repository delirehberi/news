import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../cli.ts';
import { validateEnv } from '../config/env.ts';
import { toMarkdown, type Script } from '../domain/script.ts';
import { getWeekPaths, readJson, writeTextAtomic } from '../lib/paths.ts';
import type { WeeklyEdition, WorkerClient } from '../lib/workerClient.ts';
import { assertEditionApproved, runApproveCommand } from './approve.ts';

function generateWords(count: number, prefix: string = 'kelime'): string {
  return Array.from({ length: count }, (_, idx) => `${prefix}${idx + 1}`).join(' ');
}

function makeEditedScript(totalWords: number = 350): Script {
  const introWords = 40;
  const outroWords = 30;
  const remaining = totalWords - introWords - outroWords;
  const seg1Words = Math.floor(remaining / 2);
  const seg2Words = remaining - seg1Words;

  return {
    intro: generateWords(introWords, 'merhaba'),
    segments: [
      {
        item_url: 'https://example.com/linux-kernel-rust',
        headline_tr: 'Linux Kernel Rust Sürücüleri',
        narration_tr: generateWords(seg1Words, 'detaybir'),
      },
      {
        item_url: 'https://example.com/cloudflare-workers-sql',
        headline_tr: 'Sıfır Gecikmeli Edge Önbellekleme',
        narration_tr: generateWords(seg2Words, 'detayiki'),
      },
    ],
    outro: generateWords(outroWords, 'gorusuruz'),
  };
}

function makeMockWorkerClient(status: WeeklyEdition['status'] = 'approved'): WorkerClient {
  return {
    getCandidates: vi.fn(),
    getUsedStories: vi.fn().mockResolvedValue([]),
    getEdition: vi.fn().mockImplementation(async (week) => ({
      week,
      status,
      title_tr: 'Haftalık Teknoloji Özeti',
      intro_tr: 'Giriş özeti',
      items: [],
      script: null,
      youtube_video_id: null,
      published_at: null,
      updated_at: '2026-10-20T15:30:00.000Z',
    })),
    putEdition: vi.fn().mockImplementation(async (week, payload) => ({
      week,
      status: payload.status ?? 'approved',
      title_tr: 'Haftalık Teknoloji Özeti',
      intro_tr: 'Giriş özeti',
      items: [],
      script: payload.script ?? null,
      youtube_video_id: null,
      published_at: null,
      updated_at: '2026-10-20T15:30:00.000Z',
    })),
    triggerSnapshot: vi.fn(),
  };
}

describe('src/commands/approve.ts', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'news-video-approve-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('parses edited script.md, updates script.json, and PUTs script with status: approved', async () => {
    const week = '2026-W42';
    const paths = getWeekPaths(week, tempDir);
    const editedScript = makeEditedScript(360);
    await writeTextAtomic(paths.scriptMd, toMarkdown(editedScript));

    const workerClient = makeMockWorkerClient('approved');
    const controller = new AbortController();
    const logs: string[] = [];

    const ctx: CommandContext = {
      week,
      env: validateEnv({ INGESTION_SECRET: 'test-secret' }),
      signal: controller.signal,
    };

    const result = await runApproveCommand(ctx, {
      workerClient,
      outRoot: tempDir,
      stdout: (msg) => logs.push(msg),
    });

    expect(result.wordCount).toBe(360);
    expect(result.script).toEqual(editedScript);
    expect(result.edition.status).toBe('approved');

    const syncedScriptJson = await readJson<Script>(paths.scriptJson);
    expect(syncedScriptJson).toEqual(editedScript);

    expect(workerClient.putEdition).toHaveBeenCalledWith(
      week,
      {
        script: editedScript,
        status: 'approved',
      },
      controller.signal
    );
    expect(logs[0]).toContain('Approved script (360 words, 2 segment(s)) for 2026-W42');
  });

  it('rejects script.md when narration word count is under 280 or over 2000 and does not call putEdition', async () => {
    const week = '2026-W42';
    const paths = getWeekPaths(week, tempDir);
    const workerClient = makeMockWorkerClient('draft');

    const underScript = makeEditedScript(210);
    await writeTextAtomic(paths.scriptMd, toMarkdown(underScript));

    const ctx: CommandContext = {
      week,
      env: validateEnv({ INGESTION_SECRET: 'test-secret' }),
      signal: new AbortController().signal,
    };

    await expect(
      runApproveCommand(ctx, {
        workerClient,
        outRoot: tempDir,
        stdout: () => {},
      })
    ).rejects.toThrowError(/210 words \(under minimum; allowed budget is 280\.\.2000 words/);

    const overScript = makeEditedScript(2035);
    await writeTextAtomic(paths.scriptMd, toMarkdown(overScript));

    await expect(
      runApproveCommand(ctx, {
        workerClient,
        outRoot: tempDir,
        stdout: () => {},
      })
    ).rejects.toThrowError(/2035 words \(over maximum; allowed budget is 280\.\.2000 words/);

    expect(workerClient.putEdition).not.toHaveBeenCalled();
  });

  it('assertEditionApproved refuses voice, render, and upload when edition is missing or draft', async () => {
    const week = '2026-W42';
    const missingClient = makeMockWorkerClient();
    vi.mocked(missingClient.getEdition).mockResolvedValueOnce(null);

    await expect(assertEditionApproved(missingClient, week, 'voice')).rejects.toThrowError(
      /Cannot run "voice" for week 2026-W42: edition does not exist/
    );

    const draftClient = makeMockWorkerClient('draft');
    for (const step of ['voice', 'render', 'upload'] as const) {
      await expect(assertEditionApproved(draftClient, week, step)).rejects.toThrowError(
        new RegExp(`Cannot run "${step}" for week 2026-W42: edition status is "draft"`)
      );
    }

    const approvedClient = makeMockWorkerClient('approved');
    const approvedEdition = await assertEditionApproved(approvedClient, week, 'voice');
    expect(approvedEdition.status).toBe('approved');

    const publishedClient = makeMockWorkerClient('published');
    const publishedEdition = await assertEditionApproved(publishedClient, week, 'upload');
    expect(publishedEdition.status).toBe('published');
  });

  it('preserves human-edited visual cues from script.md into script.json and Worker putEdition', async () => {
    const week = '2026-W42';
    const paths = getWeekPaths(week, tempDir);
    const scriptWithEditedCues: Script = {
      ...makeEditedScript(350),
      segments: [
        {
          item_url: 'https://example.com/linux-kernel-rust',
          headline_tr: 'Linux Kernel Rust Sürücüleri',
          narration_tr:
            'Yeni model sürücü katmanı yüzde 40 daha hızlı çalışıyor. ' +
            generateWords(130, 'detaybir'),
          visuals: [
            { kind: 'focus', anchor: 'yeni model', target: 'h1' },
            { kind: 'circle', anchor: 'yüzde 40', target: 'p3' },
          ],
        },
        {
          item_url: 'https://example.com/cloudflare-workers-sql',
          headline_tr: 'Sıfır Gecikmeli Edge Önbellekleme',
          narration_tr: generateWords(140, 'detayiki'),
        },
      ],
    };

    await writeTextAtomic(paths.scriptMd, toMarkdown(scriptWithEditedCues));
    const workerClient = makeMockWorkerClient('approved');

    const result = await runApproveCommand(
      {
        week,
        env: validateEnv({ INGESTION_SECRET: 'test-secret' }),
        signal: new AbortController().signal,
      },
      {
        workerClient,
        outRoot: tempDir,
        stdout: () => {},
      }
    );

    expect(result.script.segments[0].visuals).toEqual([
      { kind: 'focus', anchor: 'yeni model', target: 'h1' },
      { kind: 'circle', anchor: 'yüzde 40', target: 'p3' },
    ]);
    expect(result.script.segments[1].visuals).toBeUndefined();

    const syncedScriptJson = await readJson<Script>(paths.scriptJson);
    expect(syncedScriptJson).toEqual(scriptWithEditedCues);
  });
});


