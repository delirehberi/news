import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ELEVENLABS_MODEL_ID,
  DEFAULT_NEWS_API_BASE_URL,
  DEFAULT_VIDEO_ITEM_COUNT,
  DEFAULT_YOUTUBE_PRIVACY,
  parseDotEnvContent,
  validateEnv,
  validateFullEnv,
} from './env.ts';

describe('src/config/env.ts', () => {
  it('parses minimal required variables and applies defaults', () => {
    const env = validateEnv({
      INGESTION_SECRET: 'secret-token-123',
    });

    expect(env.NEWS_API_BASE_URL).toBe(DEFAULT_NEWS_API_BASE_URL);
    expect(env.INGESTION_SECRET).toBe('secret-token-123');
    expect(env.ELEVENLABS_MODEL_ID).toBe(DEFAULT_ELEVENLABS_MODEL_ID);
    expect(env.YOUTUBE_PRIVACY).toBe(DEFAULT_YOUTUBE_PRIVACY);
    expect(env.VIDEO_ITEM_COUNT).toBe(DEFAULT_VIDEO_ITEM_COUNT);
  });

  it('parses custom values and validates integer item count', () => {
    const env = validateEnv({
      NEWS_API_BASE_URL: 'http://localhost:8787',
      INGESTION_SECRET: 'my-secret',
      YOUTUBE_PRIVACY: 'unlisted',
      VIDEO_ITEM_COUNT: '7',
    });

    expect(env.NEWS_API_BASE_URL).toBe('http://localhost:8787');
    expect(env.YOUTUBE_PRIVACY).toBe('unlisted');
    expect(env.VIDEO_ITEM_COUNT).toBe(7);
  });

  it('fails fast with clear error messages when required variables are missing or invalid', () => {
    expect(() =>
      validateEnv({
        NEWS_API_BASE_URL: 'not-a-url',
        INGESTION_SECRET: '   ',
        VIDEO_ITEM_COUNT: '99',
        YOUTUBE_PRIVACY: 'invalid-privacy',
      })
    ).toThrowError(/Invalid environment configuration:/);
  });

  it('validates full pipeline environment variables', () => {
    expect(() =>
      validateFullEnv({
        INGESTION_SECRET: 'secret',
      })
    ).toThrowError(/AI_GATEWAY_BASE_URL/);

    const full = validateFullEnv({
      INGESTION_SECRET: 'secret',
      AI_GATEWAY_BASE_URL: 'https://ai.workouse.com/v1',
      AI_GATEWAY_API_KEY: 'ai-key',
      AI_MODEL: 'gpt-4o-mini',
      ELEVENLABS_API_KEY: 'xi-key',
      ELEVENLABS_VOICE_ID: 'voice-1',
      YOUTUBE_CLIENT_ID: 'yt-id',
      YOUTUBE_CLIENT_SECRET: 'yt-secret',
      YOUTUBE_REFRESH_TOKEN: 'yt-refresh',
    });

    expect(full.AI_MODEL).toBe('gpt-4o-mini');
    expect(full.ELEVENLABS_VOICE_ID).toBe('voice-1');
  });

  it('parses .env files without mutating process.env and gives precedence to explicit env vars', async () => {
    const parsedContent = parseDotEnvContent(`
      # Comment line
      export INGESTION_SECRET="from-dotenv"
      VIDEO_ITEM_COUNT='5'
      EMPTY_VAR=
    `);
    expect(parsedContent).toEqual({
      INGESTION_SECRET: 'from-dotenv',
      VIDEO_ITEM_COUNT: '5',
      EMPTY_VAR: '',
    });

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-env-test-'));
    const dotEnvFile = path.join(tmpDir, '.env');
    await fs.writeFile(
      dotEnvFile,
      'INGESTION_SECRET=dotenv-secret\nVIDEO_ITEM_COUNT=5\n',
      'utf8'
    );

    try {
      const envFromFile = validateEnv({}, dotEnvFile);
      expect(envFromFile.INGESTION_SECRET).toBe('dotenv-secret');
      expect(envFromFile.VIDEO_ITEM_COUNT).toBe(5);

      const envWithOverride = validateEnv(
        { INGESTION_SECRET: 'override-secret' },
        dotEnvFile
      );
      expect(envWithOverride.INGESTION_SECRET).toBe('override-secret');
      expect(envWithOverride.VIDEO_ITEM_COUNT).toBe(5);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

