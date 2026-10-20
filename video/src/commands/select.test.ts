import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../cli.ts';
import { validateEnv } from '../config/env.ts';
import { readJson } from '../lib/paths.ts';
import type { WeeklyCandidateRow, WorkerClient } from '../lib/workerClient.ts';
import { runSelectCommand, type WeeklySelection } from './select.ts';

function makeCandidate(overrides: Partial<WeeklyCandidateRow> = {}): WeeklyCandidateRow {
  return {
    week: '2026-W42',
    url: 'https://example.com/story-1',
    article_id: 'art-1',
    title: 'Story One',
    source: 'hackernews',
    summary: 'Summary of story one',
    image_url: 'https://example.com/img1.png',
    is_liked: 0,
    follower_likes: 0,
    importance_score: 2.0,
    source_count: 1,
    seen_count: 1,
    cluster_id: null,
    captured_at: '2026-10-18 03:00:00',
    ...overrides,
  };
}

function makeMockWorkerClient(candidates: WeeklyCandidateRow[]): WorkerClient {
  return {
    getCandidates: vi.fn().mockResolvedValue(candidates),
    getEdition: vi.fn().mockResolvedValue(null),
    putEdition: vi.fn(),
    triggerSnapshot: vi.fn(),
  };
}

describe('src/commands/select.ts', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'news-video-select-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('fetches candidates, ranks and deduplicates them, and writes out/<week>/selection.json', async () => {
    const candidates: WeeklyCandidateRow[] = [
      makeCandidate({
        url: 'https://example.com/unliked-1',
        title: 'Unliked High',
        importance_score: 5.0,
        cluster_id: 'cluster-1',
      }),
      makeCandidate({
        url: 'https://example.com/unliked-cluster-dup',
        title: 'Unliked Cluster Duplicate',
        importance_score: 2.0,
        cluster_id: 'cluster-1',
      }),
      makeCandidate({
        url: 'https://example.com/liked-1',
        title: 'Liked Story',
        is_liked: 1,
        importance_score: 1.5,
      }),
      makeCandidate({
        url: 'https://example.com/unliked-2',
        title: 'Unliked Low',
        importance_score: 1.2,
      }),
    ];

    const workerClient = makeMockWorkerClient(candidates);
    const controller = new AbortController();
    const env = validateEnv({
      INGESTION_SECRET: 'test-secret',
      VIDEO_ITEM_COUNT: '2',
    });

    const logs: string[] = [];
    const fixedNow = new Date('2026-10-19T15:00:00.000Z');

    const ctx: CommandContext = {
      week: '2026-W42',
      env,
      signal: controller.signal,
    };

    const result = await runSelectCommand(ctx, {
      workerClient,
      outRoot: tempDir,
      now: () => fixedNow,
      stdout: (msg) => logs.push(msg),
    });

    expect(workerClient.getCandidates).toHaveBeenCalledWith('2026-W42', controller.signal);
    expect(result.week).toBe('2026-W42');
    expect(result.selected_at).toBe('2026-10-19T15:00:00.000Z');
    expect(result.total_candidates).toBe(4);
    expect(result.selected_count).toBe(2);
    expect(result.items.map((i) => i.url)).toEqual([
      'https://example.com/liked-1',
      'https://example.com/unliked-1',
    ]);

    const selectionFilePath = path.join(tempDir, '2026-W42', 'selection.json');
    const persisted = await readJson<WeeklySelection>(selectionFilePath);
    expect(persisted).toEqual(result);
    expect(logs[0]).toContain('Selected 2 of 4 candidate(s) for 2026-W42');
  });

  it('throws a descriptive error when no candidates exist for the target week', async () => {
    const workerClient = makeMockWorkerClient([]);
    const controller = new AbortController();
    const env = validateEnv({
      INGESTION_SECRET: 'test-secret',
    });

    const ctx: CommandContext = {
      week: '2026-W42',
      env,
      signal: controller.signal,
    };

    await expect(
      runSelectCommand(ctx, {
        workerClient,
        outRoot: tempDir,
        stdout: () => {},
      })
    ).rejects.toThrowError(/No weekly candidates found for week 2026-W42/);
  });
});

