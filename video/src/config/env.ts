import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const DEFAULT_NEWS_API_BASE_URL = 'https://news.emre.xyz';
export const DEFAULT_ELEVENLABS_MODEL_ID = 'eleven_multilingual_v2';
export const DEFAULT_YOUTUBE_PRIVACY = 'private' as const;
export const DEFAULT_VIDEO_ITEM_COUNT = 6;
export const MIN_VIDEO_ITEM_COUNT = 1;
export const MAX_VIDEO_ITEM_COUNT = 15;

export const YouTubePrivacySchema = z.enum(['private', 'unlisted', 'public']);
export type YouTubePrivacy = z.infer<typeof YouTubePrivacySchema>;

const NonEmptyString = z.string().trim().min(1, 'Must not be empty');
const UrlString = z.string().trim().url('Must be a valid HTTP/HTTPS URL');

const OptionalNonEmptyString = z
  .string()
  .optional()
  .transform((val) => {
    const trimmed = val?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  });

const OptionalUrlString = z
  .string()
  .optional()
  .transform((val) => {
    const trimmed = val?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : undefined;
  })
  .pipe(z.string().url('Must be a valid HTTP/HTTPS URL').optional());

export const VideoEnvSchema = z.object({
  NEWS_API_BASE_URL: OptionalUrlString.default(DEFAULT_NEWS_API_BASE_URL),
  INGESTION_SECRET: NonEmptyString,
  AI_GATEWAY_BASE_URL: OptionalUrlString,
  AI_GATEWAY_API_KEY: OptionalNonEmptyString,
  AI_MODEL: OptionalNonEmptyString,
  ELEVENLABS_API_KEY: OptionalNonEmptyString,
  ELEVENLABS_VOICE_ID: OptionalNonEmptyString,
  ELEVENLABS_MODEL_ID: OptionalNonEmptyString.default(DEFAULT_ELEVENLABS_MODEL_ID),
  YOUTUBE_CLIENT_ID: OptionalNonEmptyString,
  YOUTUBE_CLIENT_SECRET: OptionalNonEmptyString,
  YOUTUBE_REFRESH_TOKEN: OptionalNonEmptyString,
  YOUTUBE_PRIVACY: z
    .string()
    .optional()
    .transform((val) => {
      const trimmed = val?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_YOUTUBE_PRIVACY;
    })
    .pipe(YouTubePrivacySchema),
  VIDEO_ITEM_COUNT: z
    .union([z.string(), z.number()])
    .optional()
    .transform((val) => {
      if (val === undefined || val === '') return DEFAULT_VIDEO_ITEM_COUNT;
      const parsed = typeof val === 'number' ? val : Number.parseInt(val.trim(), 10);
      return parsed;
    })
    .pipe(
      z
        .number({ invalid_type_error: 'VIDEO_ITEM_COUNT must be an integer' })
        .int('VIDEO_ITEM_COUNT must be an integer')
        .min(MIN_VIDEO_ITEM_COUNT, `VIDEO_ITEM_COUNT must be at least ${MIN_VIDEO_ITEM_COUNT}`)
        .max(MAX_VIDEO_ITEM_COUNT, `VIDEO_ITEM_COUNT must be at most ${MAX_VIDEO_ITEM_COUNT}`)
    ),
});

export type VideoEnv = z.infer<typeof VideoEnvSchema>;

export const FullVideoEnvSchema = VideoEnvSchema.extend({
  AI_GATEWAY_BASE_URL: UrlString,
  AI_GATEWAY_API_KEY: NonEmptyString,
  AI_MODEL: NonEmptyString,
  ELEVENLABS_API_KEY: NonEmptyString,
  ELEVENLABS_VOICE_ID: NonEmptyString,
  YOUTUBE_CLIENT_ID: NonEmptyString,
  YOUTUBE_CLIENT_SECRET: NonEmptyString,
  YOUTUBE_REFRESH_TOKEN: NonEmptyString,
});

export type FullVideoEnv = z.infer<typeof FullVideoEnvSchema>;

/**
 * Parses a `.env` file content into a plain key-value dictionary without mutating `process.env`.
 */
export function parseDotEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIndex = normalized.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = normalized.slice(0, eqIndex).trim();
    let value = normalized.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

/**
 * Reads an optional `.env` file and merges it with the provided environment dictionary
 * (giving precedence to explicit environment variables), without mutating `process.env`.
 */
export function buildRawEnv(
  rawEnv: Readonly<Record<string, string | undefined>> = process.env,
  dotEnvPath: string = path.resolve(process.cwd(), '.env')
): Record<string, string | undefined> {
  let fileVars: Record<string, string> = {};
  try {
    if (fs.existsSync(dotEnvPath)) {
      const content = fs.readFileSync(dotEnvPath, 'utf8');
      fileVars = parseDotEnvContent(content);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read .env file at ${dotEnvPath}: ${message}`);
  }

  const merged: Record<string, string | undefined> = { ...fileVars };
  for (const [key, value] of Object.entries(rawEnv)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const field = issue.path.join('.') || 'env';
      return `  - ${field}: ${issue.message}`;
    })
    .join('\n');
}

/**
 * Validates the core environment variables required by the CLI using Zod.
 * Fails fast with a descriptive error message listing all invalid or missing variables.
 */
export function validateEnv(
  rawEnv: Readonly<Record<string, string | undefined>> = process.env,
  dotEnvPath?: string
): VideoEnv {
  const merged = dotEnvPath !== undefined ? buildRawEnv(rawEnv, dotEnvPath) : { ...rawEnv };
  const parsed = VideoEnvSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment configuration:\n${formatZodIssues(parsed.error.issues)}`
    );
  }
  return parsed.data;
}

/**
 * Validates the full pipeline environment variables (Worker + AI Gateway + ElevenLabs + YouTube).
 */
export function validateFullEnv(
  rawEnv: Readonly<Record<string, string | undefined>> = process.env,
  dotEnvPath?: string
): FullVideoEnv {
  const merged = dotEnvPath !== undefined ? buildRawEnv(rawEnv, dotEnvPath) : { ...rawEnv };
  const parsed = FullVideoEnvSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(
      `Invalid full pipeline environment configuration:\n${formatZodIssues(parsed.error.issues)}`
    );
  }
  return parsed.data;
}

