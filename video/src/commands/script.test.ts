import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../cli.ts';
import { validateEnv } from '../config/env.ts';
import { fromMarkdown, type Script } from '../domain/script.ts';
import { getWeekPaths, readJson, readText, writeJsonAtomic } from '../lib/paths.ts';
import { runScriptCommand } from './script.ts';
import type { WeeklyTranslation } from './translate.ts';

function generateWords(count: number, prefix: string = 'kelime'): string {
  return Array.from({ length: count }, (_, idx) => `${prefix}${idx + 1}`).join(' ');
}

function makeOpenAiChatResponse(payload: unknown): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-script-test',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: JSON.stringify(payload),
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

function makeSampleTranslation(week: string = '2026-W42'): WeeklyTranslation {
  return {
    week,
    translated_at: '2026-10-20T15:00:00.000Z',
    title_tr: 'Linux Kernel Rust Desteği ve Edge Mimarileri',
    intro_tr: 'Bu haftanın öne çıkan sistem programlama ve cloud gelişmeleri.',
    items: [
      {
        url: 'https://example.com/linux-kernel-rust',
        title_tr: 'Linux Kernel PCI Sürücüleri İçin Rust Soyutlamaları',
        summary_tr:
          'Mainline Linux kernel sürümüne PCI sürücüleri için yeni Rust soyutlamaları eklendi. Bu adım C yerine Rust kullanımını hızlandırıyor.',
        source: 'hackernews',
        image_url: 'https://example.com/kernel.png',
      },
      {
        url: 'https://example.com/cloudflare-workers-sql',
        title_tr: 'Serverless Runtime Ortamlarında Sıfır Gecikmeli Edge Önbellekleme',
        summary_tr:
          'Modern serverless runtime mimarilerinin okuma ağırlıklı iş yüklerini nasıl optimize ettiği incelendi. Küresel API yanıt süreleri düşüyor.',
        source: 'lobsters',
        image_url: null,
      },
    ],
  };
}

describe('src/commands/script.ts', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'news-video-script-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('generates a Turkish narration script within the word budget and writes script.json and script.md', async () => {
    const week = '2026-W42';
    const paths = getWeekPaths(week, tempDir);
    await writeJsonAtomic(paths.translationJson, makeSampleTranslation(week));

    const validScript: Script = {
      intro: generateWords(45, 'acilis'),
      segments: [
        {
          item_url: 'https://example.com/linux-kernel-rust',
          headline_tr: 'Linux Kernel Rust Soyutlamaları',
          narration_tr: generateWords(130, 'haberbir'),
        },
        {
          item_url: 'https://example.com/cloudflare-workers-sql',
          headline_tr: 'Edge Önbellekleme Stratejileri',
          narration_tr: generateWords(130, 'haberiki'),
        },
      ],
      outro: generateWords(35, 'kapanis'),
    };

    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeOpenAiChatResponse(validScript));

    const env = validateEnv({
      INGESTION_SECRET: 'test-secret',
      AI_GATEWAY_BASE_URL: 'https://ai.workouse.com/v1',
      AI_GATEWAY_API_KEY: 'ai-key-123',
      AI_MODEL: 'gpt-4o-mini',
    });

    const ctx: CommandContext = {
      week,
      env,
      signal: new AbortController().signal,
    };

    const logs: string[] = [];
    const result = await runScriptCommand(ctx, {
      outRoot: tempDir,
      stdout: (msg) => logs.push(msg),
      fetchImpl: mockFetch,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.wordCount).toBe(340);
    expect(result.script).toEqual(validScript);

    const savedJson = await readJson<Script>(paths.scriptJson);
    expect(savedJson).toEqual(validScript);

    const savedMd = await readText(paths.scriptMd);
    expect(fromMarkdown(savedMd)).toEqual(validScript);
    expect(logs[0]).toContain('Generated script (340 words, 2 segment(s))');
  });

  it('retries once when the initial LLM script output is outside the [280, 700] word budget', async () => {
    const week = '2026-W42';
    const paths = getWeekPaths(week, tempDir);
    await writeJsonAtomic(paths.translationJson, makeSampleTranslation(week));

    const tooShortScript: Script = {
      intro: generateWords(15, 'kisa'),
      segments: [
        {
          item_url: 'https://example.com/linux-kernel-rust',
          headline_tr: 'Linux Kernel Rust',
          narration_tr: generateWords(30, 'kisa1'),
        },
        {
          item_url: 'https://example.com/cloudflare-workers-sql',
          headline_tr: 'Edge Önbellekleme',
          narration_tr: generateWords(30, 'kisa2'),
        },
      ],
      outro: generateWords(15, 'kisaoutro'),
    };

    const correctedScript: Script = {
      intro: generateWords(40, 'tam'),
      segments: [
        {
          item_url: 'https://example.com/linux-kernel-rust',
          headline_tr: 'Linux Kernel Rust',
          narration_tr: generateWords(130, 'tam1'),
        },
        {
          item_url: 'https://example.com/cloudflare-workers-sql',
          headline_tr: 'Edge Önbellekleme',
          narration_tr: generateWords(130, 'tam2'),
        },
      ],
      outro: generateWords(30, 'tamoutro'),
    };

    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeOpenAiChatResponse(tooShortScript))
      .mockResolvedValueOnce(makeOpenAiChatResponse(correctedScript));

    const env = validateEnv({
      INGESTION_SECRET: 'test-secret',
      AI_GATEWAY_BASE_URL: 'https://ai.workouse.com/v1',
      AI_GATEWAY_API_KEY: 'ai-key-123',
      AI_MODEL: 'gpt-4o-mini',
    });

    const result = await runScriptCommand(
      {
        week,
        env,
        signal: new AbortController().signal,
      },
      {
        outRoot: tempDir,
        stdout: () => {},
        fetchImpl: mockFetch,
      }
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.wordCount).toBe(330);

    const secondCallBody = JSON.parse(String(mockFetch.mock.calls[1][1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(secondCallBody.messages[3].content).toContain(
      'Total narration word count is 90 words, which is outside the required budget of 280..700 words.'
    );
  });
});

