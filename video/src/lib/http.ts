export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_BASE_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 10_000;
export const ERROR_BODY_MAX_LENGTH = 500;
export const HTTP_TOO_MANY_REQUESTS = 429;
export const HTTP_SERVER_ERROR_MIN = 500;
export const HTTP_SERVER_ERROR_MAX = 599;

export class HttpError extends Error {
  public readonly status: number;
  public readonly url: string;
  public readonly method: string;
  public readonly responseBody: string;

  constructor(params: {
    status: number;
    url: string;
    method: string;
    responseBody: string;
    message?: string;
  }) {
    const snippet =
      params.responseBody.length > ERROR_BODY_MAX_LENGTH
        ? `${params.responseBody.slice(0, ERROR_BODY_MAX_LENGTH)}...`
        : params.responseBody;
    const defaultMessage = `HTTP ${params.status} for ${params.method} ${params.url}${
      snippet ? `: ${snippet}` : ''
    }`;
    super(params.message ?? defaultMessage);
    this.name = 'HttpError';
    this.status = params.status;
    this.url = params.url;
    this.method = params.method;
    this.responseBody = params.responseBody;
  }
}

export interface FetchJsonOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  fetchImpl?: typeof fetch;
}

export function isRetryableStatus(status: number): boolean {
  return (
    status === HTTP_TOO_MANY_REQUESTS ||
    (status >= HTTP_SERVER_ERROR_MIN && status <= HTTP_SERVER_ERROR_MAX)
  );
}

export function computeBackoffDelayMs(
  attempt: number,
  baseBackoffMs: number = DEFAULT_BASE_BACKOFF_MS,
  jitterRatio: number = Math.random()
): number {
  const exponential = baseBackoffMs * Math.pow(2, attempt);
  const capped = Math.min(MAX_BACKOFF_MS, exponential);
  const jitter = capped * 0.2 * jitterRatio;
  return Math.round(capped + jitter);
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Performs an HTTP request expecting a JSON response, combining caller `AbortSignal`
 * and `AbortSignal.timeout(timeoutMs)` via `AbortSignal.any`, with exponential backoff
 * retries on HTTP 429 and 5xx responses.
 */
export async function fetchJson<T>(
  url: string,
  options: FetchJsonOptions = {}
): Promise<T> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const fetchFn = options.fetchImpl ?? globalThis.fetch;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...options.headers,
  };

  let serializedBody: string | undefined;
  if (options.body !== undefined) {
    if (typeof options.body === 'string') {
      serializedBody = options.body;
    } else {
      serializedBody = JSON.stringify(options.body);
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  for (let attempt = 0; ; attempt++) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    let response: Response;
    try {
      response = await fetchFn(url, {
        method,
        headers,
        body: serializedBody,
        signal: combinedSignal,
      });
    } catch (err) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Network request failed for ${method} ${url}: ${message}`, {
        cause: err,
      });
    }

    const text = await response.text();

    if (!response.ok) {
      if (attempt < maxRetries && isRetryableStatus(response.status)) {
        const delayMs = computeBackoffDelayMs(attempt, baseBackoffMs);
        await sleepWithSignal(delayMs, options.signal);
        continue;
      }

      throw new HttpError({
        status: response.status,
        url,
        method,
        responseBody: text,
      });
    }

    if (!text.trim()) {
      throw new Error(`Empty JSON response body from ${method} ${url}`);
    }

    try {
      return JSON.parse(text) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to parse JSON response from ${method} ${url}: ${message}`, {
        cause: err,
      });
    }
  }
}

