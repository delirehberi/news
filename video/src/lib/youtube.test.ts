import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildYouTubeAuthUrl,
  computeCodeChallenge,
  exchangeAuthCodeForTokens,
  exchangeRefreshTokenForAccessToken,
  generateCodeVerifier,
  generateOAuthState,
  setVideoThumbnail,
  uploadVideoResumable,
  YOUTUBE_UPLOAD_SCOPE,
} from './youtube.ts';

describe('src/lib/youtube.ts', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-lib-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('generates valid PKCE verifier/challenge and builds the YouTube upload authorization URL', () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);

    const challenge = computeCodeChallenge(verifier);
    const expectedChallenge = crypto
      .createHash('sha256')
      .update(verifier, 'ascii')
      .digest('base64url');
    expect(challenge).toBe(expectedChallenge);

    const state = generateOAuthState();
    const authUrl = buildYouTubeAuthUrl({
      clientId: 'client-123.apps.googleusercontent.com',
      redirectUri: 'http://127.0.0.1:54321',
      codeChallenge: challenge,
      state,
    });

    const parsed = new URL(authUrl);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth'
    );
    expect(parsed.searchParams.get('client_id')).toBe(
      'client-123.apps.googleusercontent.com'
    );
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:54321');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toBe(YOUTUBE_UPLOAD_SCOPE);
    expect(parsed.searchParams.get('code_challenge')).toBe(challenge);
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('state')).toBe(state);
    expect(parsed.searchParams.get('access_type')).toBe('offline');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
  });

  it('exchanges an authorization code + code_verifier for tokens', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'ya29.access',
          refresh_token: '1//0g-refresh-token',
          expires_in: 3599,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await exchangeAuthCodeForTokens({
      clientId: 'cid',
      clientSecret: 'csecret',
      code: '4/0A-auth-code',
      codeVerifier: 'verifier-xyz',
      redirectUri: 'http://127.0.0.1:41234',
      fetchImpl: mockFetch,
    });

    expect(result.refresh_token).toBe('1//0g-refresh-token');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    const bodyParams = new URLSearchParams(String(init.body));
    expect(bodyParams.get('grant_type')).toBe('authorization_code');
    expect(bodyParams.get('code')).toBe('4/0A-auth-code');
    expect(bodyParams.get('code_verifier')).toBe('verifier-xyz');
    expect(bodyParams.get('redirect_uri')).toBe('http://127.0.0.1:41234');
  });

  it('exchanges a refresh token for an access token', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'ya29.fresh-access-token',
          expires_in: 3599,
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const accessToken = await exchangeRefreshTokenForAccessToken({
      clientId: 'cid',
      clientSecret: 'csecret',
      refreshToken: '1//refresh',
      fetchImpl: mockFetch,
    });

    expect(accessToken).toBe('ya29.fresh-access-token');
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const params = new URLSearchParams(String(init.body));
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('1//refresh');
  });

  it('initiates a resumable upload session and streams the video file via stream/promises pipeline', async () => {
    const videoPath = path.join(tempDir, 'video.mp4');
    const videoBytes = Buffer.from('FAKE_MP4_STREAM_PAYLOAD_1234567890', 'utf8');
    await fs.writeFile(videoPath, videoBytes);

    let streamedBytes = Buffer.alloc(0);
    const sessionUri =
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-abc';

    const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('part=snippet%2Cstatus') || url.includes('part=snippet,status')) {
        return new Response('', {
          status: 200,
          headers: {
            Location: sessionUri,
          },
        });
      }

      if (url === sessionUri) {
        if (init?.body) {
          const ab = await new Response(init.body as BodyInit).arrayBuffer();
          streamedBytes = Buffer.from(ab);
        }
        return new Response(JSON.stringify({ id: 'yt_vid_999' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const videoId = await uploadVideoResumable({
      accessToken: 'ya29.token',
      videoPath,
      metadata: {
        title: 'Haftalık Teknoloji Özeti (2026-W42)',
        description: '00:00 Giriş\n00:15 Haber 1',
        tags: ['teknoloji', '2026-W42'],
        privacyStatus: 'private',
      },
      fetchImpl: mockFetch,
    });

    expect(videoId).toBe('yt_vid_999');
    expect(streamedBytes.equals(videoBytes)).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [initCallUrl, initCallReq] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(initCallUrl).toContain('uploadType=resumable');
    const initHeaders = initCallReq.headers as Record<string, string>;
    expect(initHeaders.Authorization).toBe('Bearer ya29.token');
    expect(initHeaders['X-Upload-Content-Length']).toBe(String(videoBytes.byteLength));
    expect(initHeaders['X-Upload-Content-Type']).toBe('video/mp4');

    const parsedInitBody = JSON.parse(String(initCallReq.body)) as {
      snippet: { title: string; defaultLanguage: string };
      status: { privacyStatus: string; selfDeclaredMadeForKids: boolean };
    };
    expect(parsedInitBody.snippet.title).toBe('Haftalık Teknoloji Özeti (2026-W42)');
    expect(parsedInitBody.snippet.defaultLanguage).toBe('tr');
    expect(parsedInitBody.status.privacyStatus).toBe('private');
    expect(parsedInitBody.status.selfDeclaredMadeForKids).toBe(false);

    const [putCallUrl, putCallReq] = mockFetch.mock.calls[1] as [string, RequestInit];
    expect(putCallUrl).toBe(sessionUri);
    expect(putCallReq.method).toBe('PUT');
  });

  it('sets the custom thumbnail via thumbnails.set', async () => {
    const thumbnailPath = path.join(tempDir, 'thumbnail.png');
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(thumbnailPath, pngBytes);

    let uploadedThumb = Buffer.alloc(0);
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.body) {
        const ab = await new Response(init.body as BodyInit).arrayBuffer();
        uploadedThumb = Buffer.from(ab);
      }
      return new Response(JSON.stringify({ items: [{}] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await setVideoThumbnail({
      accessToken: 'ya29.token',
      videoId: 'yt_vid_999',
      thumbnailPath,
      fetchImpl: mockFetch,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [thumbUrl, thumbReq] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(thumbUrl).toContain('thumbnails/set');
    expect(thumbUrl).toContain('videoId=yt_vid_999');
    expect(thumbUrl).toContain('uploadType=media');
    expect((thumbReq.headers as Record<string, string>)['Content-Type']).toBe('image/png');
    expect(uploadedThumb.equals(pngBytes)).toBe(true);
  });
});

