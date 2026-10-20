import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CommandContext } from '../cli.ts';
import { requireYouTubeAuthEnv } from '../config/env.ts';
import {
  buildYouTubeAuthUrl,
  computeCodeChallenge,
  exchangeAuthCodeForTokens,
  generateCodeVerifier,
  generateOAuthState,
  YOUTUBE_UPLOAD_SCOPE,
} from '../lib/youtube.ts';

export const LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_AUTH_CALLBACK_TIMEOUT_MS = 300_000;

export interface AuthCommandDeps {
  port?: number;
  codeVerifier?: string;
  state?: string;
  callbackTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  stdout?: (msg: string) => void;
  onServerListening?: (info: {
    port: number;
    redirectUri: string;
    authUrl: string;
    state: string;
  }) => void | Promise<void>;
}

export interface AuthCommandResult {
  refreshToken: string;
  redirectUri: string;
  authUrl: string;
}

interface CallbackPayload {
  code: string;
}

function sendHtmlResponse(
  res: http.ServerResponse,
  statusCode: number,
  heading: string,
  detail: string
): void {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${heading}</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 2rem; max-width: 36rem; margin: 0 auto; color: #0f172a; }
      h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
      p { color: #475569; line-height: 1.5; }
    </style>
  </head>
  <body>
    <h1>${heading}</h1>
    <p>${detail}</p>
  </body>
</html>`;
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

/**
 * Runs a one-time loopback OAuth 2.0 PKCE flow on `http://127.0.0.1:<port>`
 * with scope `https://www.googleapis.com/auth/youtube.upload`, exchanges the
 * authorization code for a refresh token, and prints the refresh token to stdout.
 * Nothing is persisted automatically.
 */
export async function runAuthCommand(
  ctx: CommandContext,
  deps: AuthCommandDeps = {}
): Promise<AuthCommandResult> {
  const authEnv = requireYouTubeAuthEnv(ctx.env);
  const stdout = deps.stdout ?? ((msg: string) => console.log(msg));
  const codeVerifier = deps.codeVerifier ?? generateCodeVerifier();
  const codeChallenge = computeCodeChallenge(codeVerifier);
  const expectedState = deps.state ?? generateOAuthState();
  const callbackTimeoutMs = deps.callbackTimeoutMs ?? DEFAULT_AUTH_CALLBACK_TIMEOUT_MS;

  if (ctx.signal.aborted) {
    throw ctx.signal.reason ?? new DOMException('Aborted', 'AbortError');
  }

  let settleCallback: ((payload: CallbackPayload) => void) | undefined;
  let rejectCallback: ((err: Error) => void) | undefined;
  let callbackHandled = false;

  const callbackPromise = new Promise<CallbackPayload>((resolve, reject) => {
    settleCallback = resolve;
    rejectCallback = reject;
  });
  callbackPromise.catch(() => undefined);

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}`);
    if (reqUrl.pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (callbackHandled) {
      sendHtmlResponse(res, 400, 'Already processed', 'This OAuth callback was already used.');
      return;
    }
    callbackHandled = true;

    const oauthError = reqUrl.searchParams.get('error');
    if (oauthError) {
      const errorDesc = reqUrl.searchParams.get('error_description') ?? oauthError;
      sendHtmlResponse(
        res,
        400,
        'Authorization failed',
        'Google returned an authorization error. Check your terminal for details.'
      );
      rejectCallback?.(
        new Error(`Google OAuth authorization failed: ${oauthError} (${errorDesc})`)
      );
      return;
    }

    const returnedState = reqUrl.searchParams.get('state');
    if (!returnedState || returnedState !== expectedState) {
      sendHtmlResponse(
        res,
        400,
        'Invalid state parameter',
        'OAuth state verification failed. Please retry the auth command.'
      );
      rejectCallback?.(new Error('OAuth callback state mismatch.'));
      return;
    }

    const code = reqUrl.searchParams.get('code')?.trim();
    if (!code) {
      sendHtmlResponse(
        res,
        400,
        'Missing authorization code',
        'No code parameter was present in the callback request.'
      );
      rejectCallback?.(new Error('OAuth callback did not include an authorization code.'));
      return;
    }

    sendHtmlResponse(
      res,
      200,
      'YouTube authorization complete',
      'You can close this browser tab and return to your terminal.'
    );
    settleCallback?.({ code });
  });

  const listenPort = deps.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, LOOPBACK_HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address.port !== 'number') {
    server.close();
    throw new Error('Failed to bind loopback OAuth server on 127.0.0.1.');
  }

  const redirectUri = `http://${LOOPBACK_HOST}:${address.port}`;
  const authUrl = buildYouTubeAuthUrl({
    clientId: authEnv.YOUTUBE_CLIENT_ID,
    redirectUri,
    codeChallenge,
    state: expectedState,
    scope: YOUTUBE_UPLOAD_SCOPE,
  });

  stdout('Open the following URL in your browser to authorize YouTube uploads:');
  stdout(authUrl);
  stdout(`Waiting for OAuth callback on ${redirectUri} ...`);

  const timeoutSignal = AbortSignal.timeout(callbackTimeoutMs);
  const combinedSignal = AbortSignal.any([ctx.signal, timeoutSignal]);

  const onAbort = (): void => {
    const reason =
      combinedSignal.reason instanceof Error
        ? combinedSignal.reason
        : new Error('OAuth loopback flow aborted or timed out.');
    rejectCallback?.(reason);
  };

  combinedSignal.addEventListener('abort', onAbort, { once: true });

  let callbackResult: CallbackPayload;
  try {
    await deps.onServerListening?.({
      port: address.port,
      redirectUri,
      authUrl,
      state: expectedState,
    });
    callbackResult = await callbackPromise;
  } finally {
    combinedSignal.removeEventListener('abort', onAbort);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  const tokenData = await exchangeAuthCodeForTokens({
    clientId: authEnv.YOUTUBE_CLIENT_ID,
    clientSecret: authEnv.YOUTUBE_CLIENT_SECRET,
    code: callbackResult.code,
    codeVerifier,
    redirectUri,
    signal: ctx.signal,
    fetchImpl: deps.fetchImpl,
  });

  stdout('');
  stdout('YouTube OAuth refresh token (save this manually in video/.env):');
  stdout(`YOUTUBE_REFRESH_TOKEN=${tokenData.refresh_token}`);

  return {
    refreshToken: tokenData.refresh_token,
    redirectUri,
    authUrl,
  };
}
