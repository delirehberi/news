import { describe, expect, it, vi } from 'vitest';
import type { VideoEnv } from '../config/env.ts';
import { runAuthCommand } from './auth.ts';

function makeBaseEnv(overrides: Partial<VideoEnv> = {}): VideoEnv {
  return {
    NEWS_API_BASE_URL: 'https://news.emre.xyz',
    INGESTION_SECRET: 'test-secret',
    AI_GATEWAY_BASE_URL: undefined,
    AI_GATEWAY_API_KEY: undefined,
    AI_MODEL: undefined,
    ELEVENLABS_API_KEY: undefined,
    ELEVENLABS_VOICE_ID: undefined,
    ELEVENLABS_MODEL_ID: 'eleven_multilingual_v2',
    YOUTUBE_CLIENT_ID: 'test-yt-client-id.apps.googleusercontent.com',
    YOUTUBE_CLIENT_SECRET: 'test-yt-client-secret',
    YOUTUBE_REFRESH_TOKEN: undefined,
    YOUTUBE_PRIVACY: 'private',
    VIDEO_ITEM_COUNT: 6,
    ...overrides,
  };
}

describe('src/commands/auth.ts', () => {
  it('runs a one-time loopback OAuth flow on 127.0.0.1:<port> with PKCE and prints the refresh token without persisting', async () => {
    const controller = new AbortController();
    const lines: string[] = [];

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'ya29.test-access',
          refresh_token: '1//0g-returned-refresh-token',
          expires_in: 3599,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await runAuthCommand(
      {
        week: '2026-W42',
        env: makeBaseEnv(),
        signal: controller.signal,
      },
      {
        codeVerifier: 'fixed-pkce-verifier-for-test-0123456789abcdef',
        state: 'fixed-state-123',
        fetchImpl: mockFetch,
        stdout: (msg) => lines.push(msg),
        onServerListening: async ({ redirectUri, state }) => {
          expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
          const callbackRes = await fetch(
            `${redirectUri}/?code=4/0A-loopback-code&state=${encodeURIComponent(state)}`
          );
          expect(callbackRes.status).toBe(200);
          const html = await callbackRes.text();
          expect(html).toContain('YouTube authorization complete');
        },
      }
    );

    expect(result.refreshToken).toBe('1//0g-returned-refresh-token');
    expect(result.authUrl).toContain('scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fyoutube.upload');
    expect(result.authUrl).toContain('code_challenge_method=S256');
    expect(lines.join('\n')).toContain('YOUTUBE_REFRESH_TOKEN=1//0g-returned-refresh-token');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects when the OAuth callback state does not match', async () => {
    const controller = new AbortController();

    await expect(
      runAuthCommand(
        {
          week: '2026-W42',
          env: makeBaseEnv(),
          signal: controller.signal,
        },
        {
          state: 'expected-state',
          stdout: () => undefined,
          onServerListening: async ({ redirectUri }) => {
            const res = await fetch(`${redirectUri}/?code=abc&state=wrong-state`);
            expect(res.status).toBe(400);
          },
        }
      )
    ).rejects.toThrowError(/state mismatch/);
  });

  it('fails fast when YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET is missing', async () => {
    const controller = new AbortController();

    await expect(
      runAuthCommand({
        week: '2026-W42',
        env: makeBaseEnv({ YOUTUBE_CLIENT_ID: undefined }),
        signal: controller.signal,
      })
    ).rejects.toThrowError(/YOUTUBE_CLIENT_ID/);
  });
});

