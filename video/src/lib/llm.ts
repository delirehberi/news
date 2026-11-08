import { z } from 'zod';
import { fetchJson } from './http.ts';

export const DEFAULT_LLM_TIMEOUT_MS = 60_000;
export const DEFAULT_LLM_TEMPERATURE = 0.3;
export const MAX_VALIDATION_RETRIES = 1;
const CHAT_COMPLETIONS_SUFFIX = '/chat/completions';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface LlmChatOptions<T> {
  baseUrl: string;
  apiKey: string;
  access?: { clientId: string; clientSecret: string };
  model: string;
  messages: readonly ChatMessage[];
  schema: z.ZodType<T>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  fetchImpl?: typeof fetch;
}

interface OpenAiChatCompletionResponse {
  id?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
    };
    finish_reason?: string | null;
  }>;
}

export class LlmValidationError extends Error {
  public readonly rawOutput: string;
  public readonly validationDetails: string;

  constructor(params: { message: string; rawOutput: string; validationDetails: string }) {
    super(params.message);
    this.name = 'LlmValidationError';
    this.rawOutput = params.rawOutput;
    this.validationDetails = params.validationDetails;
  }
}

/**
 * Resolves the OpenAI-compatible `/chat/completions` URL from a base URL
 * (e.g. `https://ai.workouse.com/v1` -> `https://ai.workouse.com/v1/chat/completions`).
 */
export function resolveChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith(CHAT_COMPLETIONS_SUFFIX)) {
    return trimmed;
  }
  return `${trimmed}${CHAT_COMPLETIONS_SUFFIX}`;
}

/**
 * Strips optional markdown code fences (e.g. ```json ... ```) from LLM text output.
 */
export function stripMarkdownJsonFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenceMatch && fenceMatch[1] !== undefined) {
    return fenceMatch[1].trim();
  }
  return trimmed;
}

function formatZodValidationIssues(issues: readonly z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const pathStr = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${pathStr}: ${issue.message}`;
    })
    .join('; ');
}

function parseAndValidateOutput<T>(
  rawContent: string,
  schema: z.ZodType<T>
): { ok: true; data: T } | { ok: false; errorDetail: string } {
  const cleaned = stripMarkdownJsonFences(rawContent);
  if (!cleaned) {
    return {
      ok: false,
      errorDetail: 'Assistant response content was empty.',
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cleaned);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorDetail: `Invalid JSON syntax: ${message}`,
    };
  }

  const result = schema.safeParse(parsedJson);
  if (!result.success) {
    return {
      ok: false,
      errorDetail: `Schema validation failed: ${formatZodValidationIssues(result.error.issues)}`,
    };
  }

  return {
    ok: true,
    data: result.data,
  };
}

function buildValidationRetryPrompt(errorDetail: string): string {
  return [
    'Your previous response did not pass JSON schema validation.',
    `Validation error: ${errorDetail}`,
    'Please fix the issue and respond ONLY with a valid JSON object that strictly conforms to the requested schema.',
  ].join('\n');
}

/**
 * Calls an OpenAI-compatible `/chat/completions` endpoint (Cloudflare AI Gateway `ai.workouse.com`)
 * with `response_format: { type: 'json_object' }` and validates the response against `options.schema`.
 *
 * If JSON parsing or Zod schema validation fails on the initial call, it retries once
 * (`MAX_VALIDATION_RETRIES = 1`) and includes the validation error in the retry prompt.
 */
export async function chat<T>(options: LlmChatOptions<T>): Promise<T> {
  const url = resolveChatCompletionsUrl(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const temperature = options.temperature ?? DEFAULT_LLM_TEMPERATURE;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.apiKey}`,
    'cf-aig-authorization': `Bearer ${options.apiKey}`,
  };

  if (options.access) {
    headers['CF-Access-Client-Id'] = options.access.clientId;
    headers['CF-Access-Client-Secret'] = options.access.clientSecret;
  }

  let currentMessages: ChatMessage[] = [...options.messages];

  for (let validationAttempt = 0; validationAttempt <= MAX_VALIDATION_RETRIES; validationAttempt++) {
    const requestBody: Record<string, unknown> = {
      model: options.model,
      messages: currentMessages,
      response_format: { type: 'json_object' },
      temperature,
    };

    if (options.maxTokens !== undefined) {
      requestBody.max_tokens = options.maxTokens;
    }

    const completion = await fetchJson<OpenAiChatCompletionResponse>(url, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: options.signal,
      timeoutMs,
      maxRetries: options.maxRetries,
      baseBackoffMs: options.baseBackoffMs,
      fetchImpl: options.fetchImpl,
    });

    const rawContent = completion.choices?.[0]?.message?.content ?? '';
    const outcome = parseAndValidateOutput(rawContent, options.schema);

    if (outcome.ok) {
      return outcome.data;
    }

    if (validationAttempt < MAX_VALIDATION_RETRIES) {
      currentMessages = [
        ...currentMessages,
        {
          role: 'assistant',
          content: rawContent || '{}',
        },
        {
          role: 'user',
          content: buildValidationRetryPrompt(outcome.errorDetail),
        },
      ];
      continue;
    }

    throw new LlmValidationError({
      message: `LLM output failed validation after ${validationAttempt + 1} attempt(s): ${outcome.errorDetail}`,
      rawOutput: rawContent,
      validationDetails: outcome.errorDetail,
    });
  }

  throw new Error('Unexpected end of LLM validation loop.');
}
