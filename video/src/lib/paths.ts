import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ISO_WEEK_REGEX = /^\d{4}-W\d{2}$/;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAYS_PER_WEEK = 7;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_OUT_ROOT = path.resolve(__dirname, '..', '..', 'out');

/**
 * Validates that a value is an ISO 8601 week string (e.g. `2026-W42`, week 01..53).
 */
export function isValidIsoWeek(week: unknown): week is string {
  if (typeof week !== 'string' || !ISO_WEEK_REGEX.test(week)) {
    return false;
  }
  const weekNum = Number.parseInt(week.slice(6), 10);
  return weekNum >= 1 && weekNum <= 53;
}

/**
 * Computes the ISO 8601 week string for a given UTC date (e.g. `2026-W42`).
 * Handles year boundaries accurately according to ISO-8601.
 */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || DAYS_PER_WEEK;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / DAYS_PER_WEEK);
  return `${year}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Returns the ISO 8601 week string for the week immediately preceding `now` (7 days earlier in UTC).
 */
export function previousIsoWeek(now: Date = new Date()): string {
  const prevDate = new Date(now.getTime() - DAYS_PER_WEEK * MS_PER_DAY);
  return isoWeek(prevDate);
}

export interface WeekPaths {
  week: string;
  dir: string;
  selectionJson: string;
  translationJson: string;
  scriptJson: string;
  scriptMd: string;
  audioDir: string;
  imagesDir: string;
  videoMp4: string;
  thumbnailPng: string;
}

/**
 * Resolves all standard output paths for a given ISO week under `out/<week>/`.
 * Throws if `week` is not a valid `YYYY-Www` string to prevent path traversal.
 */
export function getWeekPaths(week: string, outRoot: string = DEFAULT_OUT_ROOT): WeekPaths {
  if (!isValidIsoWeek(week)) {
    throw new Error(`Invalid ISO week format "${week}". Expected YYYY-Www (e.g. 2026-W42).`);
  }

  const dir = path.resolve(outRoot, week);
  return {
    week,
    dir,
    selectionJson: path.join(dir, 'selection.json'),
    translationJson: path.join(dir, 'translation.json'),
    scriptJson: path.join(dir, 'script.json'),
    scriptMd: path.join(dir, 'script.md'),
    audioDir: path.join(dir, 'audio'),
    imagesDir: path.join(dir, 'images'),
    videoMp4: path.join(dir, 'video.mp4'),
    thumbnailPng: path.join(dir, 'thumbnail.png'),
  };
}

/**
 * Atomically writes UTF-8 text to `filePath` by writing to a sibling temporary file
 * and renaming it into place. Creates parent directories if needed.
 */
export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const suffix = crypto.randomBytes(6).toString('hex');
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${suffix}.tmp`);

  try {
    await fs.writeFile(tempPath, content, 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (err) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup failure if temp file was never created
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to atomically write ${filePath}: ${message}`, { cause: err });
  }
}

/**
 * Atomically serializes `data` as pretty-printed JSON (with trailing newline) to `filePath`.
 */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  await writeTextAtomic(filePath, serialized);
}

/**
 * Reads and parses a JSON file from `filePath` with contextual error reporting.
 */
export async function readJson<T>(filePath: string): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read JSON file at ${filePath}: ${message}`, { cause: err });
  }

  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`, { cause: err });
  }
}

