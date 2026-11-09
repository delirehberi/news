import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { runShortsRenderCommand, safeShortImageFetch, type ShortsRenderer } from './shorts-render.ts';
import { runShortsVoiceCommand } from './shorts-voice.ts';
import { runShortsPostingCommand } from './shorts-posting.ts';
import { sampleShort } from '../testFixtures/shorts.ts';
import { shortsToMarkdown } from '../domain/shorts.ts';
import { getShortsPaths } from '../lib/shortsPaths.ts';
import { writeJsonAtomic, writeTextAtomic } from '../lib/paths.ts';
import { validateEnv } from '../config/env.ts';
import type { WeeklyEdition, WorkerClient } from '../lib/workerClient.ts';

it('bundles once for multiple shorts and writes covers and posting notes without Worker mutations', async () => {
  const outRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-render-'));
  const week = '2026-W45';
  const paths = getShortsPaths(week, outRoot);
  const shorts = [sampleShort, { ...sampleShort, topics: sampleShort.topics.map((topic) => ({ ...topic, item_url: topic.item_url + '-second' })) }];
  const items = shorts.flatMap((short) => short.topics.map((topic) => ({ url: topic.item_url, source: 'Source', title_tr: 'Title', summary_tr: 'Summary' })));
  const edition: WeeklyEdition = { week, status: 'approved', items, script: { intro: 'intro', outro: 'outro', segments: items.map((item) => ({ item_url: item.url, headline_tr: item.title_tr, narration_tr: item.summary_tr })) }, title_tr: null, intro_tr: null, youtube_video_id: null, published_at: null, updated_at: '' };
  const workerClient: WorkerClient = { getEdition: async () => edition, getCandidates: vi.fn(), getUsedStories: vi.fn(), putEdition: vi.fn(), triggerSnapshot: vi.fn() };
  const ctx = { week, mock: true, env: validateEnv({ INGESTION_SECRET: 'test' }, '/dev/null'), signal: new AbortController().signal };
  const renderer: ShortsRenderer = {
    bundle: vi.fn(async (publicDir) => { expect(await fs.readdir(publicDir)).toEqual(['audio']); return 'test-bundle'; }),
    render: vi.fn(async (_url, props, video, cover) => { expect(props.timing.sections).toHaveLength(5); await fs.writeFile(video, 'test'); await fs.writeFile(cover, 'test'); }),
  };
  const deps = { outRoot, workerClient, renderer, stdout: vi.fn(), musicFile: path.join(outRoot, 'missing-music.mp3') };
  try {
    await writeTextAtomic(paths.markdown, shortsToMarkdown({ shorts }));
    await writeJsonAtomic(paths.weekly.uploadJson, { video_id: '4wAwR9J1Z4E' });
    await expect(runShortsRenderCommand(ctx, deps)).rejects.toThrow('missing or stale');
    await runShortsVoiceCommand(ctx, deps);
    await runShortsRenderCommand(ctx, deps);
    expect(renderer.bundle).toHaveBeenCalledTimes(1);
    expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('rendering without it'));
    expect(vi.mocked(renderer.render).mock.calls[0][1].musicSrc).toBeUndefined();
    expect(renderer.render).toHaveBeenCalledTimes(2);
    await runShortsPostingCommand(ctx, deps);
    expect(await fs.readFile(paths.posting, 'utf8')).toContain('https://youtu.be/4wAwR9J1Z4E');
    expect(workerClient.putEdition).not.toHaveBeenCalled();
    expect(workerClient.triggerSnapshot).not.toHaveBeenCalled();
    const failingRenderer: ShortsRenderer = { ...renderer, render: async () => { throw new Error('test render failed'); } };
    await expect(runShortsRenderCommand(ctx, { ...deps, renderer: failingRenderer })).rejects.toThrow('test render failed');
    expect(await fs.readFile(path.join(paths.dir, '1.mp4'), 'utf8')).toBe('test');
    await expect(fs.stat(paths.posting)).rejects.toThrow();
  } finally {
    await fs.rm(outRoot, { recursive: true, force: true });
  }
});
it('stages the background music bed and passes it to every short when present', async () => {
  const outRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'shorts-music-'));
  const week = '2026-W45';
  const paths = getShortsPaths(week, outRoot);
  const items = sampleShort.topics.map((topic) => ({ url: topic.item_url, source: 'Source', title_tr: 'Title', summary_tr: 'Summary' }));
  const edition: WeeklyEdition = { week, status: 'approved', items, script: { intro: 'intro', outro: 'outro', segments: items.map((item) => ({ item_url: item.url, headline_tr: item.title_tr, narration_tr: item.summary_tr })) }, title_tr: null, intro_tr: null, youtube_video_id: null, published_at: null, updated_at: '' };
  const workerClient: WorkerClient = { getEdition: async () => edition, getCandidates: vi.fn(), getUsedStories: vi.fn(), putEdition: vi.fn(), triggerSnapshot: vi.fn() };
  const ctx = { week, mock: true, env: validateEnv({ INGESTION_SECRET: 'test' }, '/dev/null'), signal: new AbortController().signal };
  const musicFile = path.join(outRoot, 'bed.mp3');
  const renderer: ShortsRenderer = {
    bundle: vi.fn(async (publicDir) => { expect(await fs.readFile(path.join(publicDir, 'music', 'bed.mp3'), 'utf8')).toBe('music'); return 'test-bundle'; }),
    render: vi.fn(async (_url, _props, video, cover) => { await fs.writeFile(video, 'test'); await fs.writeFile(cover, 'test'); }),
  };
  const deps = { outRoot, workerClient, renderer, stdout: vi.fn(), musicFile };
  try {
    await fs.writeFile(musicFile, 'music');
    await writeTextAtomic(paths.markdown, shortsToMarkdown({ shorts: [sampleShort] }));
    await writeJsonAtomic(paths.weekly.uploadJson, { video_id: '4wAwR9J1Z4E' });
    await runShortsVoiceCommand(ctx, deps);
    await runShortsRenderCommand(ctx, deps);
    expect(renderer.bundle).toHaveBeenCalledTimes(1);
    expect(vi.mocked(renderer.render).mock.calls[0][1].musicSrc).toBe('music/bed.mp3');
    expect(deps.stdout).not.toHaveBeenCalledWith(expect.stringContaining('rendering without it'));
  } finally {
    await fs.rm(outRoot, { recursive: true, force: true });
  }
});
it('blocks private image URLs before making a request', async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  await expect(safeShortImageFetch(fetchImpl)('http://127.0.0.1/secret')).rejects.toThrow('SSRF');
  expect(fetchImpl).not.toHaveBeenCalled();
});
