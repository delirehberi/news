import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../cli.ts';
import { validateEnv } from '../config/env.ts';
import { readJson } from '../lib/paths.ts';
import type { UsedStoryIdentity, WeeklyCandidateRow, WorkerClient } from '../lib/workerClient.ts';
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

function makeUsed(overrides: Partial<UsedStoryIdentity> = {}): UsedStoryIdentity {
  return {
    week: '2026-W41',
    url: 'https://example.com/old',
    normalized_url: 'https://example.com/old',
    cluster_id: null,
    title_tr: 'Eski haber',
    ...overrides,
  };
}

function makeMockWorkerClient(
  candidates: WeeklyCandidateRow[],
  used: UsedStoryIdentity[] = []
): WorkerClient {
  return {
    getCandidates: vi.fn().mockResolvedValue(candidates),
    getUsedStories: vi.fn().mockResolvedValue(used),
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
  describe('cross-week deduplication', () => {
    function makeCtx(count: string): CommandContext {
      return {
        week: '2026-W42',
        env: validateEnv({ INGESTION_SECRET: 'test-secret', VIDEO_ITEM_COUNT: count }),
        signal: new AbortController().signal,
      };
    }

    it('excludes exact normalized URL and shared cluster matches, backfills, and reports source weeks', async () => {
      const candidates = [
        makeCandidate({ url: 'https://example.com/old/?utm_source=x#frag', importance_score: 9 }),
        makeCandidate({ url: 'https://other.com/same-story', importance_score: 8, cluster_id: 'cluster-9' }),
        makeCandidate({ url: 'https://example.com/fresh-1', importance_score: 3 }),
        makeCandidate({ url: 'https://example.com/fresh-2', importance_score: 2 }),
      ];
      const used = [
        makeUsed(),
        makeUsed({ week: '2026-W40', url: 'https://news.com/orig', normalized_url: 'https://news.com/orig', cluster_id: 'cluster-9' }),
      ];
      const logs: string[] = [];

      const result = await runSelectCommand(makeCtx('2'), {
        workerClient: makeMockWorkerClient(candidates, used),
        outRoot: tempDir,
        stdout: (msg) => logs.push(msg),
      });

      expect(result.items.map((i) => i.url)).toEqual([
        'https://example.com/fresh-1',
        'https://example.com/fresh-2',
      ]);
      expect(result.excluded_used).toEqual([
        { url: 'https://example.com/old/?utm_source=x#frag', prior_url: 'https://example.com/old', prior_week: '2026-W41', reason: 'normalized_url' },
        { url: 'https://other.com/same-story', prior_url: 'https://news.com/orig', prior_week: '2026-W40', reason: 'cluster_id' },
      ]);
      expect(logs.join('\n')).toContain('used in 2026-W40');
    });

    it('keeps distinct follow-up stories with similar titles eligible', async () => {
      const candidates = [
        makeCandidate({ url: 'https://example.com/follow-up', title: 'Big Launch: Part 2', cluster_id: 'cluster-new' }),
      ];
      const used = [makeUsed({ url: 'https://example.com/launch', normalized_url: 'https://example.com/launch', cluster_id: 'cluster-old', title_tr: 'Big Launch' })];

      const result = await runSelectCommand(makeCtx('1'), {
        workerClient: makeMockWorkerClient(candidates, used),
        outRoot: tempDir,
        stdout: () => {},
      });

      expect(result.excluded_used).toEqual([]);
      expect(result.items).toHaveLength(1);
    });

    it('fails clearly when too few unique candidates remain and writes no selection', async () => {
      const candidates = [
        makeCandidate({ url: 'https://example.com/old' }),
        makeCandidate({ url: 'https://example.com/fresh' }),
      ];

      await expect(
        runSelectCommand(makeCtx('2'), {
          workerClient: makeMockWorkerClient(candidates, [makeUsed()]),
          outRoot: tempDir,
          stdout: () => {},
        })
      ).rejects.toThrowError(/Only 1 unique candidate\(s\) remain.*1 were excluded/);
      await expect(fs.access(path.join(tempDir, '2026-W42', 'selection.json'))).rejects.toThrow();
    });
  });
});

