import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  chat,
  LlmValidationError,
  resolveChatCompletionsUrl,
  stripMarkdownJsonFences,
} from './llm.ts';

function makeOpenAiResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test-1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content,
          },
          finish_reason: 'stop',
        },
      ],
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

describe('src/lib/llm.ts', () => {
  const SampleSchema = z.object({
    title_tr: z.string().min(1),
    count: z.number().int().positive(),
  });

  it('normalizes base URLs and strips optional markdown json fences', () => {
    expect(resolveChatCompletionsUrl('https://ai.workouse.com/v1')).toBe(
      'https://ai.workouse.com/v1/chat/completions'
    );
    expect(resolveChatCompletionsUrl('https://ai.workouse.com/v1/')).toBe(
      'https://ai.workouse.com/v1/chat/completions'
    );
    expect(resolveChatCompletionsUrl('https://ai.workouse.com/v1/chat/completions')).toBe(
      'https://ai.workouse.com/v1/chat/completions'
    );

    expect(stripMarkdownJsonFences('```json\n{"title_tr":"Merhaba","count":2}\n```')).toBe(
      '{"title_tr":"Merhaba","count":2}'
    );
  });

  it('sends OpenAI-compatible request with response_format: json_object and parses output with Zod', async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        makeOpenAiResponse(JSON.stringify({ title_tr: 'Haftalık Özet', count: 5 }))
      );

    const result = await chat({
      baseUrl: 'https://ai.workouse.com/v1',
      apiKey: 'gateway-secret-key',
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a Turkish editor.' },
        { role: 'user', content: 'Translate this week.' },
      ],
      schema: SampleSchema,
      fetchImpl: mockFetch,
    });

    expect(result).toEqual({ title_tr: 'Haftalık Özet', count: 5 });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [calledUrl, calledInit] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe('https://ai.workouse.com/v1/chat/completions');
    expect(calledInit?.method).toBe('POST');

    const headers = calledInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer gateway-secret-key');
    expect(headers['cf-aig-authorization']).toBe('Bearer gateway-secret-key');

    const sentBody = JSON.parse(String(calledInit?.body)) as Record<string, unknown>;
    expect(sentBody.model).toBe('gpt-4o-mini');
    expect(sentBody.response_format).toEqual({ type: 'json_object' });
    expect(sentBody.messages).toEqual([
      { role: 'system', content: 'You are a Turkish editor.' },
      { role: 'user', content: 'Translate this week.' },
    ]);
  });

  it('retries once when Zod validation fails and includes the validation error in the retry prompt', async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        makeOpenAiResponse(JSON.stringify({ title_tr: '', count: -1 }))
      )
      .mockResolvedValueOnce(
        makeOpenAiResponse(JSON.stringify({ title_tr: 'Düzeltilmiş Başlık', count: 3 }))
      );

    const result = await chat({
      baseUrl: 'https://ai.workouse.com/v1',
      apiKey: 'gateway-secret-key',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Produce JSON' }],
      schema: SampleSchema,
      fetchImpl: mockFetch,
    });

    expect(result).toEqual({ title_tr: 'Düzeltilmiş Başlık', count: 3 });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const retryBody = JSON.parse(
      String(mockFetch.mock.calls[1][1]?.body)
    ) as { messages: Array<{ role: string; content: string }> };

    expect(retryBody.messages).toHaveLength(3);
    expect(retryBody.messages[1]).toEqual({
      role: 'assistant',
      content: JSON.stringify({ title_tr: '', count: -1 }),
    });
    expect(retryBody.messages[2].role).toBe('user');
    expect(retryBody.messages[2].content).toContain('Validation error: Schema validation failed');
    expect(retryBody.messages[2].content).toContain('title_tr');
    expect(retryBody.messages[2].content).toContain('count');
  });

  it('retries once when JSON syntax is malformed and succeeds on the second attempt', async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeOpenAiResponse('{not valid json'))
      .mockResolvedValueOnce(
        makeOpenAiResponse(JSON.stringify({ title_tr: 'Geçerli JSON', count: 1 }))
      );

    const result = await chat({
      baseUrl: 'https://ai.workouse.com/v1',
      apiKey: 'gateway-secret-key',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Produce JSON' }],
      schema: SampleSchema,
      fetchImpl: mockFetch,
    });

    expect(result).toEqual({ title_tr: 'Geçerli JSON', count: 1 });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const retryBody = JSON.parse(
      String(mockFetch.mock.calls[1][1]?.body)
    ) as { messages: Array<{ role: string; content: string }> };
    expect(retryBody.messages[2].content).toContain('Invalid JSON syntax');
  });

  it('throws LlmValidationError when both the initial attempt and the single retry fail validation', async () => {
    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeOpenAiResponse(JSON.stringify({ title_tr: '' })))
      .mockResolvedValueOnce(makeOpenAiResponse(JSON.stringify({ title_tr: '' })));

    await expect(
      chat({
        baseUrl: 'https://ai.workouse.com/v1',
        apiKey: 'gateway-secret-key',
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Produce JSON' }],
        schema: SampleSchema,
        fetchImpl: mockFetch,
      })
    ).rejects.toThrowError(LlmValidationError);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

