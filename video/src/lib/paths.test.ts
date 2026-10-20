import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getWeekPaths,
  isoWeek,
  isValidIsoWeek,
  previousIsoWeek,
  readJson,
  writeJsonAtomic,
} from './paths.ts';

describe('src/lib/paths.ts', () => {
  it('validates ISO week strings accurately', () => {
    expect(isValidIsoWeek('2026-W42')).toBe(true);
    expect(isValidIsoWeek('2026-W01')).toBe(true);
    expect(isValidIsoWeek('2026-W53')).toBe(true);
    expect(isValidIsoWeek('2026-W00')).toBe(false);
    expect(isValidIsoWeek('2026-W54')).toBe(false);
    expect(isValidIsoWeek('2026-42')).toBe(false);
    expect(isValidIsoWeek('../2026-W42')).toBe(false);
  });

  it('computes isoWeek and previousIsoWeek including across year boundaries', () => {
    expect(isoWeek(new Date('2026-10-19T12:00:00Z'))).toBe('2026-W43');
    expect(previousIsoWeek(new Date('2026-10-19T12:00:00Z'))).toBe('2026-W42');

    // 2026-01-05 is Monday of 2026-W02; previous week is 2026-W01
    expect(isoWeek(new Date('2026-01-05T00:00:00Z'))).toBe('2026-W02');
    expect(previousIsoWeek(new Date('2026-01-05T00:00:00Z'))).toBe('2026-W01');

    // 2026-01-01 is Thursday of 2026-W01; 7 days prior is 2025-12-25 (2025-W52)
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(previousIsoWeek(new Date('2026-01-01T00:00:00Z'))).toBe('2025-W52');
  });

  it('builds standard week paths and rejects invalid week names', () => {
    const paths = getWeekPaths('2026-W42', '/tmp/video-out');
    expect(paths.dir).toBe('/tmp/video-out/2026-W42');
    expect(paths.selectionJson).toBe('/tmp/video-out/2026-W42/selection.json');
    expect(paths.translationJson).toBe('/tmp/video-out/2026-W42/translation.json');
    expect(paths.scriptJson).toBe('/tmp/video-out/2026-W42/script.json');
    expect(paths.scriptMd).toBe('/tmp/video-out/2026-W42/script.md');
    expect(paths.audioDir).toBe('/tmp/video-out/2026-W42/audio');
    expect(paths.imagesDir).toBe('/tmp/video-out/2026-W42/images');
    expect(paths.videoMp4).toBe('/tmp/video-out/2026-W42/video.mp4');
    expect(paths.thumbnailPng).toBe('/tmp/video-out/2026-W42/thumbnail.png');

    expect(() => getWeekPaths('bad-week', '/tmp/video-out')).toThrowError(
      /Invalid ISO week format/
    );
  });

  it('writes and reads JSON atomically without leaving temporary files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-paths-test-'));
    try {
      const paths = getWeekPaths('2026-W42', tmpDir);
      const payload = { week: '2026-W42', items: [{ url: 'https://emre.xyz' }] };

      await writeJsonAtomic(paths.selectionJson, payload);

      const loaded = await readJson<typeof payload>(paths.selectionJson);
      expect(loaded).toEqual(payload);

      const entries = await fs.readdir(paths.dir);
      expect(entries).toEqual(['selection.json']);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

