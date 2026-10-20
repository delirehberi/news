import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { YouTubePrivacy } from '../config/env.ts';
import { HttpError } from './http.ts';

export const GOOGLE_OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const YOUTUBE_UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
export const YOUTUBE_VIDEOS_UPLOAD_URL =
  'https://www.googleapis.com/upload/youtube/v3/videos';
export const YOUTUBE_THUMBNAILS_SET_URL =
  'https://www.googleapis.com/upload/youtube/v3/thumbnails/set';
export const YOUTUBE_SCIENCE_TECH_CATEGORY_ID = '28';

const DEFAULT_PKCE_VERIFIER_BYTES = 32;
const DEFAULT_OAUTH_STATE_BYTES = 16;
const DEFAULT_OAUTH_TIMEOUT_MS = 30_000;
const DEFAULT_UPLOAD_INIT_TIMEOUT_MS = 30_000;
const DEFAULT_VIDEO_UPLOAD_TIMEOUT_MS = 600_000;
const DEFAULT_THUMBNAIL_TIMEOUT_MS = 60_000;

const OAuthRefreshTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

export type OAuthRefreshTokenResponse = z.infer<typeof OAuthRefreshTokenResponseSchema>;

const OAuthAccessTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

export type OAuthAccessTokenResponse = z.infer<typeof OAuthAccessTokenResponseSchema>;

const YouTubeVideoUploadResponseSchema = z.object({
  id: z.string().min(1),
});

export type YouTubeVideoUploadResponse = z.infer<typeof YouTubeVideoUploadResponseSchema>;

export interface BuildYouTubeAuthUrlOptions {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scope?: string;
  authEndpoint?: string;
}

export interface ExchangeAuthCodeOptions {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  tokenEndpoint?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ExchangeRefreshTokenOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  tokenEndpoint?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface YouTubeVideoMetadata {
  title: string;
  description: string;
  tags: string[];
  privacyStatus: YouTubePrivacy;
  categoryId?: string;
  defaultLanguage?: string;
  defaultAudioLanguage?: string;
}

export interface UploadVideoResumableOptions {
  accessToken: string;
  videoPath: string;
  metadata: YouTubeVideoMetadata;
  uploadEndpoint?: string;
  signal?: AbortSignal;
  initTimeoutMs?: number;
  uploadTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SetVideoThumbnailOptions {
  accessToken: string;
  videoId: string;
  thumbnailPath: string;
  thumbnailEndpoint?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type StreamingRequestInit = RequestInit & {
  duplex?: 'half';
};

function combineSignalWithTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

/**
 * Generates a cryptographically random PKCE `code_verifier` (base64url-encoded).
 */
export function generateCodeVerifier(
  byteLength: number = DEFAULT_PKCE_VERIFIER_BYTES
): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}

/**
 * Computes the `S256` PKCE `code_challenge` (`BASE64URL(SHA256(code_verifier))`).
 */
export function computeCodeChallenge(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

/**
 * Generates a random OAuth `state` parameter for CSRF protection.
 */
export function generateOAuthState(
  byteLength: number = DEFAULT_OAUTH_STATE_BYTES
): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}

/**
 * Builds the Google OAuth 2.0 authorization URL with PKCE (`S256`) and `youtube.upload` scope.
 */
export function buildYouTubeAuthUrl(options: BuildYouTubeAuthUrlOptions): string {
  const {
    clientId,
    redirectUri,
    codeChallenge,
    state,
    scope = YOUTUBE_UPLOAD_SCOPE,
    authEndpoint = GOOGLE_OAUTH_AUTH_URL,
  } = options;

  const url = new URL(authEndpoint);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scope);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

/**
 * Exchanges a one-time OAuth authorization code and PKCE `code_verifier` for a refresh token.
 */
export async function exchangeAuthCodeForTokens(
  options: ExchangeAuthCodeOptions
): Promise<OAuthRefreshTokenResponse> {
  const {
    clientId,
    clientSecret,
    code,
    codeVerifier,
    redirectUri,
    tokenEndpoint = GOOGLE_OAUTH_TOKEN_URL,
    signal,
    timeoutMs = DEFAULT_OAUTH_TIMEOUT_MS,
    fetchImpl = fetch,
  } = options;

  const combinedSignal = combineSignalWithTimeout(signal, timeoutMs);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: combinedSignal,
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new HttpError({
      method: 'POST',
      url: tokenEndpoint,
      status: response.status,
      responseBody: rawText,
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Invalid JSON in Google OAuth token response: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const parsed = OAuthRefreshTokenResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(
      `Google OAuth response did not include a valid refresh_token (${details}). Ensure prompt=consent and access_type=offline were used.`
    );
  }

  return parsed.data;
}

/**
 * Exchanges a stored OAuth `refresh_token` for a short-lived `access_token`.
 */
export async function exchangeRefreshTokenForAccessToken(
  options: ExchangeRefreshTokenOptions
): Promise<string> {
  const {
    clientId,
    clientSecret,
    refreshToken,
    tokenEndpoint = GOOGLE_OAUTH_TOKEN_URL,
    signal,
    timeoutMs = DEFAULT_OAUTH_TIMEOUT_MS,
    fetchImpl = fetch,
  } = options;

  const combinedSignal = combineSignalWithTimeout(signal, timeoutMs);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });

  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: combinedSignal,
  });

  const rawText = await response.text();
  if (!response.ok) {
    throw new HttpError({
      method: 'POST',
      url: tokenEndpoint,
      status: response.status,
      responseBody: rawText,
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Invalid JSON in Google OAuth refresh response: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const parsed = OAuthAccessTokenResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid Google OAuth access token response: ${details}`);
  }

  return parsed.data.access_token;
}

async function streamFileRequest(options: {
  url: string;
  method: 'POST' | 'PUT';
  headers: Record<string, string>;
  filePath: string;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<Response> {
  const { url, method, headers, filePath, signal, fetchImpl } = options;

  const fileStream = createReadStream(filePath);
  const passThrough = new PassThrough();

  const pipelinePromise = pipeline(fileStream, passThrough, { signal });
  // Attach a no-op catch handler immediately so unhandled rejections cannot fire before await
  pipelinePromise.catch(() => undefined);

  const webReadable = Readable.toWeb(passThrough) as unknown as ReadableStream<Uint8Array>;
  const requestInit: StreamingRequestInit = {
    method,
    headers,
    body: webReadable,
    duplex: 'half',
    signal,
  };

  let response: Response;
  try {
    response = await fetchImpl(url, requestInit);
  } finally {
    // Ensure passThrough drains cleanly if a test mock fetchImpl did not consume the body stream
    passThrough.resume();
  }

  await pipelinePromise;
  return response;
}

/**
 * Initiates a YouTube Data API v3 resumable upload session (`uploadType=resumable`)
 * and streams `videoPath` to the session `Location` URL using `stream/promises` `pipeline`.
 * Returns the uploaded YouTube video ID.
 */
export async function uploadVideoResumable(
  options: UploadVideoResumableOptions
): Promise<string> {
  const {
    accessToken,
    videoPath,
    metadata,
    uploadEndpoint = YOUTUBE_VIDEOS_UPLOAD_URL,
    signal,
    initTimeoutMs = DEFAULT_UPLOAD_INIT_TIMEOUT_MS,
    uploadTimeoutMs = DEFAULT_VIDEO_UPLOAD_TIMEOUT_MS,
    fetchImpl = fetch,
  } = options;

  const stat = await fs.stat(videoPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Video file at ${videoPath} is empty or not a regular file.`);
  }

  const initUrl = new URL(uploadEndpoint);
  initUrl.searchParams.set('uploadType', 'resumable');
  initUrl.searchParams.set('part', 'snippet,status');

  const initBody = {
    snippet: {
      title: metadata.title,
      description: metadata.description,
      tags: metadata.tags,
      categoryId: metadata.categoryId ?? YOUTUBE_SCIENCE_TECH_CATEGORY_ID,
      defaultLanguage: metadata.defaultLanguage ?? 'tr',
      defaultAudioLanguage: metadata.defaultAudioLanguage ?? 'tr',
    },
    status: {
      privacyStatus: metadata.privacyStatus,
      selfDeclaredMadeForKids: false,
    },
  };

  const initSignal = combineSignalWithTimeout(signal, initTimeoutMs);
  const initResponse = await fetchImpl(initUrl.toString(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json',
      'X-Upload-Content-Length': String(stat.size),
      'X-Upload-Content-Type': 'video/mp4',
    },
    body: JSON.stringify(initBody),
    signal: initSignal,
  });

  if (!initResponse.ok) {
    const errBody = await initResponse.text();
    throw new HttpError({
      method: 'POST',
      url: initUrl.toString(),
      status: initResponse.status,
      responseBody: errBody,
    });
  }

  const uploadLocation = initResponse.headers.get('location')?.trim();
  if (!uploadLocation) {
    throw new Error(
      `YouTube resumable upload initiation succeeded (HTTP ${initResponse.status}) but returned no Location header.`
    );
  }

  const uploadSignal = combineSignalWithTimeout(signal, uploadTimeoutMs);
  const uploadResponse = await streamFileRequest({
    url: uploadLocation,
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Length': String(stat.size),
      'Content-Type': 'video/mp4',
      Accept: 'application/json',
    },
    filePath: videoPath,
    signal: uploadSignal,
    fetchImpl,
  });

  const rawText = await uploadResponse.text();
  if (!uploadResponse.ok) {
    throw new HttpError({
      method: 'PUT',
      url: uploadLocation,
      status: uploadResponse.status,
      responseBody: rawText,
    });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (err) {
    throw new Error(
      `Invalid JSON in YouTube video upload response: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const parsed = YouTubeVideoUploadResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`YouTube upload response missing video id: ${details}`);
  }

  return parsed.data.id;
}

/**
 * Sets a custom PNG thumbnail on a YouTube video via `thumbnails.set` (`uploadType=media`),
 * streaming the file with `stream/promises` `pipeline`.
 */
export async function setVideoThumbnail(
  options: SetVideoThumbnailOptions
): Promise<void> {
  const {
    accessToken,
    videoId,
    thumbnailPath,
    thumbnailEndpoint = YOUTUBE_THUMBNAILS_SET_URL,
    signal,
    timeoutMs = DEFAULT_THUMBNAIL_TIMEOUT_MS,
    fetchImpl = fetch,
  } = options;

  const stat = await fs.stat(thumbnailPath);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Thumbnail file at ${thumbnailPath} is empty or not a regular file.`);
  }

  const url = new URL(thumbnailEndpoint);
  url.searchParams.set('videoId', videoId);
  url.searchParams.set('uploadType', 'media');

  const combinedSignal = combineSignalWithTimeout(signal, timeoutMs);
  const response = await streamFileRequest({
    url: url.toString(),
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'image/png',
      'Content-Length': String(stat.size),
      Accept: 'application/json',
    },
    filePath: thumbnailPath,
    signal: combinedSignal,
    fetchImpl,
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new HttpError({
      method: 'POST',
      url: url.toString(),
      status: response.status,
      responseBody: errBody,
    });
  }
}
