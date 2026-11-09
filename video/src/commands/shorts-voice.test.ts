import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { runShortsVoiceCommand } from './shorts-voice.ts';
import { sampleShort } from '../testFixtures/shorts.ts';
import { shortsToMarkdown } from '../domain/shorts.ts';
import { getShortsPaths } from '../lib/shortsPaths.ts';
import { writeJsonAtomic, writeTextAtomic } from '../lib/paths.ts';
import { validateEnv } from '../config/env.ts';
import type { WeeklyEdition, WorkerClient } from '../lib/workerClient.ts';

it('gates synthesis on approval/upload and caches explicit mock audio', async () => {
  const outRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-voice-'));
  const week = '2026-W45';
  const paths = getShortsPaths(week, outRoot);
  const items = sampleShort.topics.map((topic) => ({ url: topic.item_url, source: 'Source', title_tr: 'Title', summary_tr: 'Summary' }));
  const edition: WeeklyEdition = { week, status: 'approved', items, script: { intro: 'intro', outro: 'outro', segments: items.map((item) => ({ item_url: item.url, headline_tr: item.title_tr, narration_tr: item.summary_tr })) }, title_tr: null, intro_tr: null, youtube_video_id: null, published_at: null, updated_at: '' };
  const workerClient: WorkerClient = { getEdition: async () => edition, getCandidates: vi.fn(), getUsedStories: vi.fn(), putEdition: vi.fn(), triggerSnapshot: vi.fn() };
  const ctx = { week, mock: true, env: validateEnv({ INGESTION_SECRET: 'test' }, '/dev/null'), signal: new AbortController().signal };
  const fetchImpl = vi.fn<typeof fetch>();
  const deps = { outRoot, workerClient, fetchImpl, stdout: vi.fn() };
  try {
    await writeTextAtomic(paths.markdown, shortsToMarkdown({ shorts: [sampleShort] }));
    await expect(runShortsVoiceCommand(ctx, deps)).rejects.toThrow('before voice synthesis');
    expect(fetchImpl).not.toHaveBeenCalled();
    await writeJsonAtomic(paths.weekly.uploadJson, { video_id: '4wAwR9J1Z4E' });
    await runShortsVoiceCommand(ctx, deps);
    const before = await fs.stat(path.join(paths.audioDir, '1.mp3'));
    await runShortsVoiceCommand(ctx, deps);
    expect((await fs.stat(path.join(paths.audioDir, '1.mp3'))).mtimeMs).toBe(before.mtimeMs);
    await expect(runShortsVoiceCommand({ ...ctx, mock: false }, deps)).rejects.toThrow();
    edition.status = 'draft';
    await expect(runShortsVoiceCommand(ctx, deps)).rejects.toThrow('must be');
  } finally {
    await fs.rm(outRoot, { recursive: true, force: true });
  }
});
