import { describe, expect, it, vi } from 'vitest';
import { fetchJson, HttpError } from './http.ts';

describe('src/lib/http.ts', () => {
  it('returns parsed JSON on HTTP 200', async () => {
    const mockFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, count: 3 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const data = await fetchJson<{ ok: boolean; count: number }>(
      'https://news.emre.xyz/api/test',
      { fetchImpl: mockFetch }
    );

    expect(data).toEqual({ ok: true, count: 3 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on HTTP 429 and 5xx and succeeds when subsequent attempt returns 200', async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('Rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('Bad gateway', { status: 502 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ recovered: true }), { status: 200 })
      );

    const result = await fetchJson<{ recovered: boolean }>(
      'https://news.emre.xyz/api/retry',
      {
        fetchImpl: mockFetch,
        maxRetries: 3,
        baseBackoffMs: 1,
      }
    );

    expect(result).toEqual({ recovered: true });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry on 4xx client errors (other than 429) and throws HttpError', async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'Not Found' }), { status: 404 })
      );

    await expect(
      fetchJson('https://news.emre.xyz/api/missing', {
        fetchImpl: mockFetch,
        maxRetries: 3,
        baseBackoffMs: 1,
      })
    ).rejects.toThrowError(HttpError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('aborts immediately when caller AbortSignal is aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('User cancelled'));

    const mockFetch = vi.fn<typeof fetch>();

    await expect(
      fetchJson('https://news.emre.xyz/api/abort', {
        signal: controller.signal,
        fetchImpl: mockFetch,
      })
    ).rejects.toThrowError('User cancelled');

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

