import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../cli.ts';
import { validateEnv } from '../config/env.ts';
import { getWeekPaths, readJson, writeJsonAtomic } from '../lib/paths.ts';
import type { WeeklyEdition, WorkerClient } from '../lib/workerClient.ts';
import type { WeeklySelection } from './select.ts';
import { runTranslateCommand, type WeeklyTranslation } from './translate.ts';

function makeOpenAiChatResponse(payload: unknown): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-translate-test',
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

function makeSampleSelection(week: string = '2026-W42'): WeeklySelection {
  return {
    week,
    selected_at: '2026-10-19T12:00:00.000Z',
    total_candidates: 5,
    selected_count: 2,
    excluded_used: [],
    items: [
      {
        week,
        url: 'https://example.com/linux-kernel-rust',
        article_id: 'art-1',
        title: 'Linux Kernel Expands Rust Runtime Support',
        source: 'hackernews',
        summary: 'Mainline Linux kernel merged new Rust abstractions for PCI drivers.',
        image_url: 'https://example.com/kernel.png',
        is_liked: 1,
        follower_likes: 3,
        importance_score: 4.5,
        source_count: 2,
        seen_count: 3,
        cluster_id: 'c1',
        captured_at: '2026-10-18 03:00:00',
        rank_score: 1000213,
      },
      {
        week,
        url: 'https://example.com/cloudflare-workers-sql',
        article_id: 'art-2',
        title: 'Zero-Latency Edge Caching Strategies',
        source: 'lobsters',
        summary: 'How modern serverless runtimes optimize read-heavy workloads.',
        image_url: null,
        is_liked: 0,
        follower_likes: 1,
        importance_score: 3.8,
        source_count: 1,
        seen_count: 2,
        cluster_id: null,
        captured_at: '2026-10-18 04:00:00',
        rank_score: 95,
      },
    ],
  };
}

function makeMockWorkerClient(): WorkerClient {
  return {
    getCandidates: vi.fn(),
    getUsedStories: vi.fn().mockResolvedValue([]),
    getEdition: vi.fn(),
    putEdition: vi.fn().mockImplementation(async (week, payload) => {
      const edition: WeeklyEdition = {
        week,
        status: payload.status ?? 'draft',
        title_tr: payload.title_tr ?? null,
        intro_tr: payload.intro_tr ?? null,
        items: payload.items ?? [],
        script: null,
        youtube_video_id: null,
        published_at: null,
        updated_at: '2026-10-20T12:00:00.000Z',
      };
      return edition;
    }),
    triggerSnapshot: vi.fn(),
  };
}

describe('src/commands/translate.ts', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'news-video-translate-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('translates selected stories, writes translation.json, and PUTs edition as draft', async () => {
    const week = '2026-W42';
    const paths = getWeekPaths(week, tempDir);
    const selection = makeSampleSelection(week);
    await writeJsonAtomic(paths.selectionJson, selection);

    const validLlmOutput = {
      title_tr: 'Linux Kernel Rust Desteği ve Edge Mimarilerinde Yeni Dönem',
      intro_tr:
        'Bu hafta sistem programlama dünyasında Linux kernel içindeki Rust entegrasyonu hız kazanırken, cloud ve serverless tarafında düşük gecikmeli önbellekleme mimarileri öne çıktı. Haftanın en dikkat çeken gelişmelerini derledik.',
      items: [
        {
          url: 'https://example.com/linux-kernel-rust',
          title_tr: 'Linux Kernel PCI Sürücüleri İçin Rust Soyutlamalarını Genişletti',
          summary_tr:
            'Mainline Linux kernel sürümüne PCI sürücüleri için yeni Rust soyutlamaları eklendi. Bu adım, bellek güvenliği kritik donanım sürücülerinin open source ekosisteminde C yerine Rust ile yazılmasının önünü açıyor.',
        },
        {
          url: 'https://example.com/cloudflare-workers-sql',
          title_tr: 'Serverless Runtime Ortamlarında Sıfır Gecikmeli Edge Önbellekleme',
          summary_tr:
            'Modern serverless runtime mimarilerinin okuma ağırlıklı iş yüklerini nasıl optimize ettiği incelendi. Dağıtık veri katmanlarında uygulanan yeni önbellekleme stratejileri küresel API yanıt sürelerini önemli ölçüde düşürüyor.',
        },
      ],
    };

    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeOpenAiChatResponse(validLlmOutput));
    const workerClient = makeMockWorkerClient();
    const controller = new AbortController();
    const fixedNow = new Date('2026-10-20T15:00:00.000Z');
    const logs: string[] = [];

    const env = validateEnv({
      INGESTION_SECRET: 'test-secret',
      AI_GATEWAY_BASE_URL: 'https://ai.workouse.com/v1',
      AI_GATEWAY_API_KEY: 'ai-key-123',
      AI_MODEL: 'gpt-4o-mini',
    });

    const ctx: CommandContext = {
      week,
      env,
      signal: controller.signal,
    };

    const { translation, edition } = await runTranslateCommand(ctx, {
      workerClient,
      outRoot: tempDir,
      now: () => fixedNow,
      stdout: (msg) => logs.push(msg),
      fetchImpl: mockFetch,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(translation.week).toBe(week);
    expect(translation.translated_at).toBe('2026-10-20T15:00:00.000Z');
    expect(translation.title_tr).toBe(validLlmOutput.title_tr);
    expect(translation.intro_tr).toBe(validLlmOutput.intro_tr);
    expect(translation.items).toEqual([
      {
        url: 'https://example.com/linux-kernel-rust',
        title_tr: validLlmOutput.items[0].title_tr,
        summary_tr: validLlmOutput.items[0].summary_tr,
        source: 'hackernews',
        image_url: 'https://example.com/kernel.png',
        cluster_id: 'c1',
      },
      {
        url: 'https://example.com/cloudflare-workers-sql',
        title_tr: validLlmOutput.items[1].title_tr,
        summary_tr: validLlmOutput.items[1].summary_tr,
        source: 'lobsters',
        image_url: null,
        cluster_id: null,
      },
    ]);

    const persisted = await readJson<WeeklyTranslation>(paths.translationJson);
    expect(persisted).toEqual(translation);

    expect(workerClient.putEdition).toHaveBeenCalledWith(
      week,
      {
        title_tr: validLlmOutput.title_tr,
        intro_tr: validLlmOutput.intro_tr,
        items: translation.items,
        status: 'draft',
      },
      controller.signal
    );
    expect(edition.status).toBe('draft');
    expect(logs[0]).toContain('Translated 2 story(ies) for 2026-W42');
  });

  it('retries once when the initial LLM response is missing an expected story URL', async () => {
    const week = '2026-W42';
    const paths = getWeekPaths(week, tempDir);
    const selection = makeSampleSelection(week);
    await writeJsonAtomic(paths.selectionJson, selection);

    const incompleteOutput = {
      title_tr: 'Eksik Bülten',
      intro_tr: 'Yalnızca tek haber döndürüldü.',
      items: [
        {
          url: 'https://example.com/linux-kernel-rust',
          title_tr: 'Tek Haber',
          summary_tr: 'İlk cümle. İkinci cümle.',
        },
      ],
    };

    const correctedOutput = {
      title_tr: 'Tamamlanmış Bülten Başlığı',
      intro_tr: 'Her iki haber de eksiksiz çevrildi. Haftanın özeti hazır.',
      items: [
        {
          url: 'https://example.com/linux-kernel-rust',
          title_tr: 'Linux Kernel Rust Gelişmesi',
          summary_tr: 'Birinci cümle özeti. İkinci cümle teknik detayı.',
        },
        {
          url: 'https://example.com/cloudflare-workers-sql',
          title_tr: 'Edge Önbellekleme Stratejileri',
          summary_tr: 'İlk cümle açıklaması. İkinci cümle performans etkisi.',
        },
      ],
    };

    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeOpenAiChatResponse(incompleteOutput))
      .mockResolvedValueOnce(makeOpenAiChatResponse(correctedOutput));

    const workerClient = makeMockWorkerClient();
    const env = validateEnv({
      INGESTION_SECRET: 'test-secret',
      AI_GATEWAY_BASE_URL: 'https://ai.workouse.com/v1',
      AI_GATEWAY_API_KEY: 'ai-key-123',
      AI_MODEL: 'gpt-4o-mini',
    });

    const { translation } = await runTranslateCommand(
      {
        week,
        env,
        signal: new AbortController().signal,
      },
      {
        workerClient,
        outRoot: tempDir,
        stdout: () => {},
        fetchImpl: mockFetch,
      }
    );

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(translation.items).toHaveLength(2);

    const secondCallBody = JSON.parse(String(mockFetch.mock.calls[1][1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(secondCallBody.messages[3].content).toContain(
      'Expected 2 translated item(s), but received 1.'
    );
  });

  it('fails fast with a clear error when AI environment variables or selection.json are missing', async () => {
    const week = '2026-W42';
    const workerClient = makeMockWorkerClient();

    const envWithoutAi = validateEnv({
      INGESTION_SECRET: 'test-secret',
    });

    await expect(
      runTranslateCommand(
        {
          week,
          env: envWithoutAi,
          signal: new AbortController().signal,
        },
        {
          workerClient,
          outRoot: tempDir,
          stdout: () => {},
        }
      )
    ).rejects.toThrowError(/Missing or invalid AI Gateway environment configuration/);

    const envWithAi = validateEnv({
      INGESTION_SECRET: 'test-secret',
      AI_GATEWAY_BASE_URL: 'https://ai.workouse.com/v1',
      AI_GATEWAY_API_KEY: 'ai-key-123',
      AI_MODEL: 'gpt-4o-mini',
    });

    await expect(
      runTranslateCommand(
        {
          week,
          env: envWithAi,
          signal: new AbortController().signal,
        },
        {
          workerClient,
          outRoot: tempDir,
          stdout: () => {},
        }
      )
    ).rejects.toThrowError(/Failed to read JSON file/);
  });

  it('includes curator_comment in the translation prompt and preserves it on translated WeeklyItem', async () => {
    const week = '2026-W42';
    const paths = getWeekPaths(week, tempDir);
    const selection = makeSampleSelection(week);
    selection.items[0].curator_comment = 'Harika bir Rust kernel soyutlama örneği, özellikle DMA güvenliği açısından kritik.';
    await writeJsonAtomic(paths.selectionJson, selection);

    const validLlmOutput = {
      title_tr: 'Linux Kernel Rust Desteği',
      intro_tr: 'Bu hafta Linux kernel içindeki Rust entegrasyonu öne çıktı. Önemli gelişmeleri derledik.',
      items: [
        {
          url: 'https://example.com/linux-kernel-rust',
          title_tr: 'Linux Kernel PCI Sürücüleri İçin Rust Soyutlamaları',
          summary_tr: 'Mainline Linux kernel sürümüne PCI sürücüleri için yeni Rust soyutlamaları eklendi. Özellikle DMA güvenliği açısından kritik bir adım.',
        },
        {
          url: 'https://example.com/cloudflare-workers-sql',
          title_tr: 'Edge Önbellekleme',
          summary_tr: 'Modern serverless runtime mimarileri incelendi. Küresel API yanıt süreleri düşüyor.',
        },
      ],
    };

    const mockFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(makeOpenAiChatResponse(validLlmOutput));
    const workerClient = makeMockWorkerClient();
    const env = validateEnv({
      INGESTION_SECRET: 'test-secret',
      AI_GATEWAY_BASE_URL: 'https://ai.workouse.com/v1',
      AI_GATEWAY_API_KEY: 'ai-key-123',
      AI_MODEL: 'gpt-4o-mini',
    });

    const { translation } = await runTranslateCommand(
      { week, env, signal: new AbortController().signal },
      { workerClient, outRoot: tempDir, stdout: () => {}, fetchImpl: mockFetch }
    );

    const callBody = JSON.parse(String(mockFetch.mock.calls[0][1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(callBody.messages[1].content).toContain(
      'Harika bir Rust kernel soyutlama örneği, özellikle DMA güvenliği açısından kritik.'
    );
    expect(translation.items[0].curator_comment).toBe(
      'Harika bir Rust kernel soyutlama örneği, özellikle DMA güvenliği açısından kritik.'
    );
    expect(translation.items[1].curator_comment).toBeUndefined();
  });
});

