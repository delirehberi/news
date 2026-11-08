import type { CommandContext } from '../cli.ts';
import { requireAiEnv } from '../config/env.ts';
import type { RankedCandidate } from '../domain/rank.ts';
import { chat } from '../lib/llm.ts';
import { getWeekPaths, readJson, writeJsonAtomic } from '../lib/paths.ts';
import {
  createWorkerClient,
  type WeeklyEdition,
  type WeeklyItem,
  type WorkerClient,
} from '../lib/workerClient.ts';
import {
  buildTranslateUserPrompt,
  createTranslationResponseSchema,
  TRANSLATE_SYSTEM_PROMPT,
  type TranslationOutput,
} from '../prompts/translate.ts';
import type { WeeklySelection } from './select.ts';

const DEFAULT_SOURCE_FALLBACK = 'unknown';

export interface WeeklyTranslation {
  week: string;
  translated_at: string;
  title_tr: string;
  intro_tr: string;
  items: WeeklyItem[];
}

export interface TranslateCommandDeps {
  workerClient?: WorkerClient;
  outRoot?: string;
  now?: () => Date;
  stdout?: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

function buildWeeklyItems(
  candidates: readonly RankedCandidate[],
  translated: TranslationOutput
): WeeklyItem[] {
  const translatedByUrl = new Map<string, { title_tr: string; summary_tr: string }>();
  for (const item of translated.items) {
    translatedByUrl.set(item.url.trim(), {
      title_tr: item.title_tr.trim(),
      summary_tr: item.summary_tr.trim(),
    });
  }

  return candidates.map((candidate) => {
    const normalizedUrl = candidate.url.trim();
    const match = translatedByUrl.get(normalizedUrl);
    if (!match) {
      throw new Error(
        `Missing Turkish translation for selected candidate URL "${normalizedUrl}".`
      );
    }

    const source =
      candidate.source && candidate.source.trim().length > 0
        ? candidate.source.trim()
        : DEFAULT_SOURCE_FALLBACK;

    const curatorComment =
      typeof candidate.curator_comment === 'string' && candidate.curator_comment.trim().length > 0
        ? candidate.curator_comment.trim()
        : undefined;

    return {
      url: normalizedUrl,
      cluster_id: candidate.cluster_id?.trim() || null,
      title_tr: match.title_tr,
      summary_tr: match.summary_tr,
      source,
      image_url: candidate.image_url ?? null,
      ...(curatorComment ? { curator_comment: curatorComment } : {}),
    };
  });
}

/**
 * Reads `out/<week>/selection.json`, translates the selected weekly stories into
 * journalistic Turkish via the OpenAI-compatible AI Gateway (`chat()`), writes
 * `out/<week>/translation.json`, and PUTs the edition to the Worker Admin API as `draft`.
 */
export async function runTranslateCommand(
  ctx: CommandContext,
  deps: TranslateCommandDeps = {}
): Promise<{ translation: WeeklyTranslation; edition: WeeklyEdition }> {
  const stdout = deps.stdout ?? ((msg: string) => console.log(msg));
  const nowFn = deps.now ?? (() => new Date());
  const aiEnv = requireAiEnv(ctx.env);

  const paths = getWeekPaths(ctx.week, deps.outRoot);
  const selection = await readJson<WeeklySelection>(paths.selectionJson);

  if (!selection || !Array.isArray(selection.items) || selection.items.length === 0) {
    throw new Error(
      `No selected items found in ${paths.selectionJson} for week ${ctx.week}. Run "select" first.`
    );
  }

  const expectedUrls = selection.items.map((item) => item.url.trim());
  const responseSchema = createTranslationResponseSchema(expectedUrls);
  const userPrompt = buildTranslateUserPrompt(ctx.week, selection.items);

  const llmOutput = await chat({
    baseUrl: aiEnv.AI_GATEWAY_BASE_URL,
    apiKey: aiEnv.AI_GATEWAY_API_KEY,
    access: aiEnv.CF_ACCESS_CLIENT_ID && aiEnv.CF_ACCESS_CLIENT_SECRET
      ? { clientId: aiEnv.CF_ACCESS_CLIENT_ID, clientSecret: aiEnv.CF_ACCESS_CLIENT_SECRET }
      : undefined,
    model: aiEnv.AI_MODEL,
    messages: [
      { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    schema: responseSchema,
    signal: ctx.signal,
    fetchImpl: deps.fetchImpl,
  });

  const items = buildWeeklyItems(selection.items, llmOutput);
  const translation: WeeklyTranslation = {
    week: ctx.week,
    translated_at: nowFn().toISOString(),
    title_tr: llmOutput.title_tr,
    intro_tr: llmOutput.intro_tr,
    items,
  };

  await writeJsonAtomic(paths.translationJson, translation);

  const workerClient =
    deps.workerClient ??
    createWorkerClient({
      baseUrl: ctx.env.NEWS_API_BASE_URL,
      ingestionSecret: ctx.env.INGESTION_SECRET,
      fetchImpl: deps.fetchImpl,
    });

  const edition = await workerClient.putEdition(
    ctx.week,
    {
      title_tr: translation.title_tr,
      intro_tr: translation.intro_tr,
      items: translation.items,
      status: 'draft',
    },
    ctx.signal
  );

  stdout(
    `Translated ${translation.items.length} story(ies) for ${ctx.week} -> ${paths.translationJson} and saved draft edition.`
  );

  return { translation, edition };
}
