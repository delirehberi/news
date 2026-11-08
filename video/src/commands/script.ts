import type { CommandContext } from '../cli.ts';
import { requireAiEnv } from '../config/env.ts';
import { countScriptWords, toMarkdown, type Script } from '../domain/script.ts';
import { chat } from '../lib/llm.ts';
import {
  getWeekPaths,
  readJson,
  writeJsonAtomic,
  writeTextAtomic,
} from '../lib/paths.ts';
import {
  buildScriptUserPrompt,
  createScriptResponseSchema,
  SCRIPT_SYSTEM_PROMPT,
} from '../prompts/script.ts';
import { loadWeekPageCapturesByUrl } from './capture.ts';
import type { WeeklyTranslation } from './translate.ts';

export interface ScriptCommandDeps {
  outRoot?: string;
  stdout?: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

/**
 * Reads `out/<week>/translation.json` (and any captured article excerpts from
 * `out/<week>/pages/<n>.json`), requests a Turkish narration script from the
 * AI Gateway (`chat()`) within `[WORDS_MIN, WORDS_MAX]`, and writes both
 * `out/<week>/script.json` and editable `out/<week>/script.md`.
 */
export async function runScriptCommand(
  ctx: CommandContext,
  deps: ScriptCommandDeps = {}
): Promise<{ script: Script; markdown: string; wordCount: number }> {
  const stdout = deps.stdout ?? ((msg: string) => console.log(msg));
  const aiEnv = requireAiEnv(ctx.env);

  const paths = getWeekPaths(ctx.week, deps.outRoot);
  const translation = await readJson<WeeklyTranslation>(paths.translationJson);

  if (!translation || !Array.isArray(translation.items) || translation.items.length === 0) {
    throw new Error(
      `No translated items found in ${paths.translationJson} for week ${ctx.week}. Run "translate" first.`
    );
  }

  const expectedUrls = translation.items.map((item) => item.url.trim());
  const pageCapturesByUrl = await loadWeekPageCapturesByUrl(paths.pagesDir, expectedUrls);
  const responseSchema = createScriptResponseSchema(expectedUrls, {
    pageCapturesByUrl,
    onWarn: (msg) => stdout(`[warn] ${msg}`),
  });
  const userPrompt = buildScriptUserPrompt(ctx.week, translation, pageCapturesByUrl);

  const script = await chat({
    baseUrl: aiEnv.AI_GATEWAY_BASE_URL,
    apiKey: aiEnv.AI_GATEWAY_API_KEY,
    access: aiEnv.CF_ACCESS_CLIENT_ID && aiEnv.CF_ACCESS_CLIENT_SECRET
      ? { clientId: aiEnv.CF_ACCESS_CLIENT_ID, clientSecret: aiEnv.CF_ACCESS_CLIENT_SECRET }
      : undefined,
    model: aiEnv.AI_MODEL,
    messages: [
      { role: 'system', content: SCRIPT_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    schema: responseSchema,
    signal: ctx.signal,
    fetchImpl: deps.fetchImpl,
  });

  const markdown = toMarkdown(script);
  const wordCount = countScriptWords(script);

  await writeJsonAtomic(paths.scriptJson, script);
  await writeTextAtomic(paths.scriptMd, markdown);

  stdout(
    `Generated script (${wordCount} words, ${script.segments.length} segment(s)) for ${ctx.week} -> ${paths.scriptMd} and ${paths.scriptJson}`
  );

  return { script, markdown, wordCount };
}
