import { z } from 'zod';
import type { WeeklyTranslation } from '../commands/translate.ts';
import {
  normalizeCueText,
  resolveCueTarget,
  tokenizeCueText,
  VisualCueSchema,
  type CuePageElement,
  type VisualCue,
} from '../domain/cues.ts';
import {
  cleanCaptureText,
  type PageCaptureMetadata,
  type PageElement,
  type PageElementKind,
} from '../domain/pageCapture.ts';
import {
  countScriptWords,
  WORDS_MAX,
  WORDS_MIN,
  WORDS_PER_MINUTE,
  type Script,
  type ScriptSegment,
} from '../domain/script.ts';

export const MIN_VISUAL_CUES_PER_SEGMENT = 2;
export const MAX_VISUAL_CUES_PER_SEGMENT = 5;
export const PROMPT_ELEMENT_TEXT_MAX_CHARS = 140;

const ELEMENT_ID_PATTERN =
  /^#?(?:h\d+|heading\d*|p\d+|para\d+|fig\d+|figure\d+|img\d+|code\d+|quote\d+|blockquote\d+|table\d+|el\d+|div\d+|section\d+)$/i;

export interface PromptElementSummary {
  readonly id: string;
  readonly kind?: PageElementKind;
  readonly tagName?: string;
  readonly text: string;
  readonly box?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export type PromptPageCaptureInput =
  | (Pick<PageCaptureMetadata, 'excerpt'> & {
      readonly elements?: readonly PromptElementSummary[];
    })
  | {
      readonly excerpt?: string;
      readonly elements?: readonly PromptElementSummary[];
    }
  | readonly PromptElementSummary[];

export type PageCapturesMapInput =
  | ReadonlyMap<string, PromptPageCaptureInput>
  | Readonly<Record<string, PromptPageCaptureInput>>
  | null
  | undefined;

export interface ScriptResponseSchemaOptions {
  pageCapturesByUrl?: PageCapturesMapInput;
  onWarn?: (msg: string) => void;
}

export const SCRIPT_SYSTEM_PROMPT = `Sen news.emre.xyz haftalık YouTube teknoloji ve gündem bülteninin baş metin yazarı, sunucusu ve görsel yönetmenisisin.
Görevin, Türkçeye çevrilmiş haftalık haber bülteninden haber sayısına göre 2 ila 14 dakikalık (yaklaşık ${WORDS_PER_MINUTE} kelime/dakika hızında okunacak) akıcı, doğal ve dinamik bir Türkçe seslendirme metni (video script) ve her haber için ekran koreografisi (\`visuals\`) üretmektir.

Yazım, Seslendirme, Görsel Yönetmenlik ve Kelime Bütçesi Kuralları:
1. Kelime Bütçesi (ZORUNLU):
   - \`intro\`, tüm \`segments[].narration_tr\` ve \`outro\` alanlarındaki toplam kelime sayısı EN AZ ${WORDS_MIN} ve EN FAZLA ${WORDS_MAX} kelime olmalıdır (ideal hedef: haber başına yaklaşık 70 kelime + intro ve outro; 6 haberde 380–520, 20 haberde 1300–1700 kelime).
   - Ne çok kısa (280 kelimenin altı) ne de çok uzun (2000 kelimenin üstü) yazma.
2. Doğal Konuşma ve Sunum Dili:
   - Metin sesli okunacaktır (ElevenLabs TTS). Yazı dili yerine kulağa doğal gelen, net, enerjik ve profesyonel bir yayıncı/sunucu Türkçesi kullan.
   - Çok uzun, karmaşık veya iç içe geçmiş yan cümlelerden kaçın; nefes payı bırakan akıcı cümleler kur.
3. Teknik Terimler:
   - Türkçe teknoloji yayıncılığında doğal olarak İngilizce kullanılan terimleri (open source, LLM, runtime, cloud, kernel, benchmark, framework, API, SDK, GPU, serverless vb.) olduğu gibi koru.
4. Yapı ve Görsel Koreografi (\`visuals\`):
   - \`intro\`: İzleyiciyi karşılayan, haftanın öne çıkan temalarını kısaca çerçeveleyen etkileyici bir açılış konuşması (yaklaşık 35–60 kelime).
   - \`segments\`: Girdideki her haber için sırayı bozmadan bir segment üret:
     - \`item_url\`: Haberin girdideki orijinal URL'si (birebir aynı olmalı).
     - \`headline_tr\`: Video ekranında kart başlığı olarak görünecek kısa, vurucu Türkçe başlık.
     - \`narration_tr\`: Haberin ne olduğunu ve neden önemli olduğunu anlatan seslendirme metni (haber başına yaklaşık 55–85 kelime). Eğer haberde \`curator_comment\` (küratörün yorumu/notu) varsa bu bakış açısını anlatıma doğal biçimde dahil et.
     - \`visuals\`: Haberin seslendirmesi sırasında ekranda tetiklenecek ${MIN_VISUAL_CUES_PER_SEGMENT} ila ${MAX_VISUAL_CUES_PER_SEGMENT} adet görsel ipucu (\`VisualCue\`). Her ipucu şu alanları içerir:
       - \`kind\`: \`"scroll" | "focus" | "highlight" | "circle" | "underline" | "arrow" | "stat" | "quote" | "image"\`
       - \`anchor\`: \`narration_tr\` metninde BİREBİR geçen kısa ifade (2–6 kelime, ör. \`"yeni model"\`, \`"yüzde 40"\`).
       - \`target\`: Haberin \`elements\` listesindeki bir eleman kimliği (ör. \`"h1"\`, \`"p1"\`, \`"fig1"\`, \`"quote1"\`, \`"code1"\`, \`"table1"\`) veya \`"stat"\` / \`"quote"\` ipuçları için gösterilecek istatistik/alıntı değeri (ör. \`"%40"\`, \`"3x daha hızlı"\`).
   - \`outro\`: Bülteni toparlayan, tüm kaynak linklerinin ve detaylı özetlerin news.emre.xyz/weekly adresinde yer aldığını hatırlatan kapanış konuşması (yaklaşık 25–45 kelime).
5. Çıktı Formatı:
   - Yanıtın SADECE geçerli bir JSON nesnesi olmalıdır.`;

function lookupCaptureEntry(
  captures: PageCapturesMapInput,
  url: string
): { found: boolean; entry: PromptPageCaptureInput | undefined } {
  if (!captures) {
    return { found: false, entry: undefined };
  }

  const normalizedUrl = url.trim();
  if (captures instanceof Map || typeof (captures as ReadonlyMap<string, unknown>).get === 'function') {
    const map = captures as ReadonlyMap<string, PromptPageCaptureInput>;
    if (map.has(normalizedUrl)) {
      return { found: true, entry: map.get(normalizedUrl) };
    }
    if (map.has(url)) {
      return { found: true, entry: map.get(url) };
    }
    return { found: false, entry: undefined };
  }

  const record = captures as Readonly<Record<string, PromptPageCaptureInput>>;
  if (Object.prototype.hasOwnProperty.call(record, normalizedUrl)) {
    return { found: true, entry: record[normalizedUrl] };
  }
  if (Object.prototype.hasOwnProperty.call(record, url)) {
    return { found: true, entry: record[url] };
  }
  return { found: false, entry: undefined };
}

function hasAnyCaptureEntries(captures: PageCapturesMapInput): boolean {
  if (!captures) {
    return false;
  }
  if (captures instanceof Map || typeof (captures as ReadonlyMap<string, unknown>).size === 'number') {
    return (captures as ReadonlyMap<string, unknown>).size > 0;
  }
  return Object.keys(captures).length > 0;
}

function toCuePageElements(
  rawElements: readonly PromptElementSummary[] | undefined
): CuePageElement[] {
  if (!rawElements || rawElements.length === 0) {
    return [];
  }

  return rawElements.map((el, index) => ({
    id: el.id.trim(),
    kind: el.kind ?? (el.id.trim().toLowerCase() === 'h1' ? 'h1' : 'paragraph'),
    tagName: el.tagName ?? 'div',
    text: el.text ?? '',
    box: el.box
      ? {
          x: el.box.x,
          y: el.box.y,
          width: el.box.width,
          height: el.box.height,
        }
      : {
          x: 0,
          y: index * 100,
          width: 800,
          height: 60,
        },
  }));
}

/**
 * Checks whether `anchor` appears as a phrase within `narrationTr`
 * (Turkish-aware case/diacritic/punctuation-normalized token sequence or substring).
 */
export function isAnchorInNarration(anchor: string, narrationTr: string): boolean {
  const anchorTokens = tokenizeCueText(anchor);
  const narrationTokens = tokenizeCueText(narrationTr);

  if (anchorTokens.length === 0 || narrationTokens.length === 0) {
    return false;
  }

  if (anchorTokens.length > narrationTokens.length) {
    return false;
  }

  // Pass 1: contiguous normalized token sequence match
  for (let i = 0; i <= narrationTokens.length - anchorTokens.length; i++) {
    let allMatch = true;
    for (let j = 0; j < anchorTokens.length; j++) {
      const nToken = narrationTokens[i + j];
      const aToken = anchorTokens[j];
      if (nToken === aToken) {
        continue;
      }
      // Allow Turkish suffix stem match on tokens of at least 4 characters
      if (aToken.length >= 4 && nToken.startsWith(aToken)) {
        continue;
      }
      if (nToken.length >= 4 && aToken.startsWith(nToken)) {
        continue;
      }
      allMatch = false;
      break;
    }
    if (allMatch) {
      return true;
    }
  }

  // Pass 2: normalized word-boundary substring match (handles joined numbers/compounds)
  const normalizedAnchor = normalizeCueText(anchor);
  const normalizedNarration = normalizeCueText(narrationTr);
  if (normalizedAnchor.length >= 3 && ` ${normalizedNarration} `.includes(` ${normalizedAnchor} `)) {
    return true;
  }

  return false;
}

/**
 * Checks whether a cue's `target` (or `value` for `stat`/`quote`) is valid against
 * the story's captured element map (`elements`).
 * Reuses `resolveCueTarget` from `src/domain/cues.ts`.
 */
export function isCueTargetValid(
  cue: VisualCue,
  elements: readonly CuePageElement[] | undefined
): boolean {
  const trimmedTarget = cue.target?.trim() ?? '';
  const trimmedValue = cue.value?.trim() ?? '';

  if (cue.kind === 'stat' || cue.kind === 'quote') {
    const statOrQuoteContent = trimmedTarget || trimmedValue;
    if (!statOrQuoteContent) {
      return false;
    }
    // If target looks like an explicit element ID (e.g. "p99", "h3") and an element map is active,
    // verify that the element ID actually exists in the element map.
    if (elements !== undefined && trimmedTarget && ELEMENT_ID_PATTERN.test(trimmedTarget)) {
      const cleanId = trimmedTarget.replace(/^#/, '').toLowerCase();
      return elements.some((el) => el.id.toLowerCase() === cleanId);
    }
    return true;
  }

  if (!trimmedTarget) {
    return false;
  }

  // If no element map context was supplied to the schema, any non-empty target is accepted.
  if (elements === undefined) {
    return true;
  }

  if (elements.length === 0) {
    return false;
  }

  // If target is formatted as an element ID (e.g. "h1", "p3", "fig2"), require an exact ID match
  // so bogus element IDs like "p99" cannot accidentally fuzzy-match paragraph text.
  if (ELEMENT_ID_PATTERN.test(trimmedTarget)) {
    const cleanId = trimmedTarget.replace(/^#/, '').toLowerCase();
    return elements.some((el) => el.id.toLowerCase() === cleanId);
  }

  return resolveCueTarget(trimmedTarget, elements) !== null;
}

/**
 * Validates raw visual cues for a story segment against `VisualCueSchema`,
 * `narration_tr` anchor containment, and the story's element map (`resolveCueTarget`).
 * Invalid cues are dropped with a warning via `onWarn` and never fail the script.
 */
export function sanitizeSegmentVisualCues(options: {
  rawVisuals: unknown;
  narrationTr: string;
  storyIndex: number;
  itemUrl: string;
  elements?: readonly CuePageElement[];
  onWarn?: (msg: string) => void;
}): VisualCue[] | undefined {
  const { rawVisuals, narrationTr, storyIndex, itemUrl, elements, onWarn } = options;
  const warn = onWarn ?? ((msg: string) => console.warn(msg));

  if (rawVisuals === undefined || rawVisuals === null) {
    return undefined;
  }

  if (!Array.isArray(rawVisuals)) {
    warn(
      `Story #${storyIndex} (${itemUrl}): dropping non-array visuals field in script segment.`
    );
    return undefined;
  }

  const validCues: VisualCue[] = [];

  for (let idx = 0; idx < rawVisuals.length; idx++) {
    const rawCue = rawVisuals[idx];
    const parsed = VisualCueSchema.safeParse(rawCue);

    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => i.message).join(', ');
      warn(
        `Story #${storyIndex} (${itemUrl}): dropping invalid visual cue #${idx + 1} (${details}).`
      );
      continue;
    }

    const cue = parsed.data;

    if (!isAnchorInNarration(cue.anchor, narrationTr)) {
      warn(
        `Story #${storyIndex} (${itemUrl}): dropping visual cue #${idx + 1} (${cue.kind}) because anchor "${cue.anchor}" does not appear in narration_tr.`
      );
      continue;
    }

    if (!isCueTargetValid(cue, elements)) {
      warn(
        `Story #${storyIndex} (${itemUrl}): dropping visual cue #${idx + 1} (${cue.kind} @"${cue.anchor}") because target "${cue.target ?? ''}" does not match any element in the element map.`
      );
      continue;
    }

    if (validCues.length >= MAX_VISUAL_CUES_PER_SEGMENT) {
      warn(
        `Story #${storyIndex} (${itemUrl}): dropping extra visual cue #${idx + 1} (${cue.kind} @"${cue.anchor}") exceeding max of ${MAX_VISUAL_CUES_PER_SEGMENT} cues per segment.`
      );
      continue;
    }

    validCues.push(cue);
  }

  return validCues.length > 0 ? validCues : undefined;
}

const RawLlmScriptSegmentSchema = z.object({
  item_url: z.string().trim().min(1, 'Story item_url must not be empty'),
  headline_tr: z.string().trim().min(1, 'Story headline_tr must not be empty'),
  narration_tr: z.string().trim().min(1, 'Story narration_tr must not be empty'),
  visuals: z.unknown().optional(),
  cues: z.unknown().optional(),
});

const RawLlmScriptSchema = z.object({
  intro: z.string().trim().min(1, 'Script intro must not be empty'),
  segments: z.array(RawLlmScriptSegmentSchema).min(1, 'Script segments must not be empty'),
  outro: z.string().trim().min(1, 'Script outro must not be empty'),
});

function resolveStoryElementsForValidation(
  captures: PageCapturesMapInput,
  itemUrl: string
): readonly CuePageElement[] | undefined {
  if (!captures) {
    return undefined;
  }

  const { found, entry } = lookupCaptureEntry(captures, itemUrl);
  if (found) {
    if (!entry) {
      return [];
    }
    if (Array.isArray(entry)) {
      return toCuePageElements(entry);
    }
    const rawElements = (entry as { readonly elements?: readonly PromptElementSummary[] }).elements;
    if (rawElements !== undefined) {
      return toCuePageElements(rawElements);
    }
    return undefined;
  }

  // If other stories had captures in the map, this story had no capture -> empty element map
  if (hasAnyCaptureEntries(captures)) {
    return [];
  }

  return undefined;
}

/**
 * Builds a strict Zod schema for the LLM script output that verifies:
 * 1. Exact segment count and `item_url` order matching `expectedUrls`.
 * 2. Total spoken narration word count (`intro` + `segments[].narration_tr` + `outro`) within `[WORDS_MIN, WORDS_MAX]`.
 * 3. Validates optional `visuals` cues per segment (anchors in `narration_tr`, targets in the element map),
 *    dropping invalid cues with a warning without ever failing the script.
 */
export function createScriptResponseSchema(
  expectedUrls: readonly string[],
  optionsOrCaptures?: PageCapturesMapInput | ScriptResponseSchemaOptions
): z.ZodType<Script> {
  const isOptionsObject =
    Boolean(optionsOrCaptures) &&
    !(optionsOrCaptures instanceof Map) &&
    typeof (optionsOrCaptures as ReadonlyMap<string, unknown>).get !== 'function' &&
    ('pageCapturesByUrl' in (optionsOrCaptures as Record<string, unknown>) ||
      'onWarn' in (optionsOrCaptures as Record<string, unknown>));

  const pageCapturesByUrl: PageCapturesMapInput = isOptionsObject
    ? (optionsOrCaptures as ScriptResponseSchemaOptions).pageCapturesByUrl
    : (optionsOrCaptures as PageCapturesMapInput);

  const onWarn: ((msg: string) => void) | undefined = isOptionsObject
    ? (optionsOrCaptures as ScriptResponseSchemaOptions).onWarn
    : undefined;

  return RawLlmScriptSchema.superRefine((data, ctx) => {
    if (data.segments.length !== expectedUrls.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments'],
        message: `Expected ${expectedUrls.length} script segment(s), but received ${data.segments.length}.`,
      });
      return;
    }

    for (let i = 0; i < expectedUrls.length; i++) {
      const expectedUrl = expectedUrls[i].trim();
      const actualUrl = data.segments[i].item_url.trim();
      if (actualUrl !== expectedUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', i, 'item_url'],
          message: `Segment ${i + 1} item_url "${actualUrl}" does not match expected URL "${expectedUrl}" in order.`,
        });
      }
    }

    const totalWords = countScriptWords({
      intro: data.intro,
      segments: data.segments.map((s) => ({
        item_url: s.item_url,
        headline_tr: s.headline_tr,
        narration_tr: s.narration_tr,
      })),
      outro: data.outro,
    });
    if (totalWords < WORDS_MIN || totalWords > WORDS_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments'],
        message: `Total narration word count is ${totalWords} words, which is outside the required budget of ${WORDS_MIN}..${WORDS_MAX} words. Adjust narration length so total words (intro + all narration_tr + outro) is between ${WORDS_MIN} and ${WORDS_MAX}.`,
      });
    }
  }).transform((data): Script => {
    const segments: ScriptSegment[] = data.segments.map((seg, idx) => {
      const storyIndex = idx + 1;
      const rawVisuals = seg.visuals !== undefined ? seg.visuals : seg.cues;
      const elements = resolveStoryElementsForValidation(pageCapturesByUrl, seg.item_url);
      const visuals = sanitizeSegmentVisualCues({
        rawVisuals,
        narrationTr: seg.narration_tr,
        storyIndex,
        itemUrl: seg.item_url,
        elements,
        onWarn,
      });

      return {
        item_url: seg.item_url,
        headline_tr: seg.headline_tr,
        narration_tr: seg.narration_tr,
        ...(visuals ? { visuals } : {}),
      };
    });

    return {
      intro: data.intro,
      segments,
      outro: data.outro,
    };
  }) as unknown as z.ZodType<Script>;
}

/**
 * Builds the user prompt supplying the translated weekly edition (and optional
 * captured article excerpts + element lists from `out/<week>/pages/<n>.json`)
 * for Turkish video script and visual cue generation.
 */
export function buildScriptUserPrompt(
  week: string,
  translation: Pick<WeeklyTranslation, 'title_tr' | 'intro_tr' | 'items'>,
  pageCapturesByUrl?: PageCapturesMapInput
): string {
  const inputPayload = {
    week,
    title_tr: translation.title_tr,
    intro_tr: translation.intro_tr,
    stories: translation.items.map((item, idx) => {
      const normalizedUrl = item.url.trim();
      const { entry } = lookupCaptureEntry(pageCapturesByUrl, normalizedUrl);
      const rawExcerpt =
        entry && !Array.isArray(entry) && 'excerpt' in entry ? entry.excerpt : undefined;
      const excerpt = rawExcerpt?.trim();

      const rawElements: readonly PromptElementSummary[] | undefined = Array.isArray(entry)
        ? entry
        : entry && 'elements' in entry
          ? (entry as { readonly elements?: readonly PromptElementSummary[] }).elements
          : undefined;

      const elements =
        rawElements && rawElements.length > 0
          ? rawElements.map((el: PromptElementSummary | PageElement) => ({
              id: el.id.trim(),
              ...(el.kind ? { kind: el.kind } : {}),
              text: cleanCaptureText(el.text ?? '', PROMPT_ELEMENT_TEXT_MAX_CHARS),
            }))
          : undefined;

      const curatorComment =
        typeof item.curator_comment === 'string' && item.curator_comment.trim().length > 0
          ? item.curator_comment.trim()
          : undefined;
      return {
        index: idx + 1,
        item_url: item.url,
        title_tr: item.title_tr,
        summary_tr: item.summary_tr,
        source: item.source,
        ...(curatorComment ? { curator_comment: curatorComment } : {}),
        ...(excerpt ? { excerpt } : {}),
        ...(elements ? { elements } : {}),
      };
    }),
  };

  return [
    `${week} haftası için hazırlanan aşağıdaki Türkçe bültenden YouTube video seslendirme metni (script) ve görsel yönetmenlik ipuçları (visuals) üret.`,
    `Toplam seslendirme kelime sayısı (intro + tüm segments[].narration_tr + outro) ${WORDS_MIN} ile ${WORDS_MAX} kelime arasında olmalıdır.`,
    `Her haber segmenti için ${MIN_VISUAL_CUES_PER_SEGMENT} ila ${MAX_VISUAL_CUES_PER_SEGMENT} adet "visuals" ipucu ekle: her ipucunun "anchor" alanı o haberin "narration_tr" metninden birebir alınmış bir ifade, "target" alanı ise haberin "elements" listesindeki bir eleman kimliği (ör. h1, p1, fig1) veya stat/quote değeri olmalıdır.`,
    '',
    'Beklenen JSON şeması:',
    '{',
    '  "intro": "Açılış seslendirme metni (Türkçe)",',
    '  "segments": [',
    '    {',
    '      "item_url": "Girdideki item_url ile birebir aynı URL",',
    '      "headline_tr": "Video kartında gösterilecek kısa Türkçe başlık",',
    '      "narration_tr": "Haberin seslendirme metni (Türkçe)",',
    '      "visuals": [',
    '        {',
    '          "kind": "focus | highlight | circle | underline | arrow | scroll | stat | quote | image",',
    '          "anchor": "narration_tr içinde birebir geçen ifade",',
    '          "target": "elements listesindeki bir id (ör. h1, p1, fig1) veya stat/quote değeri"',
    '        }',
    '      ]',
    '    }',
    '  ],',
    '  "outro": "Kapanış seslendirme metni (Türkçe)"',
    '}',
    '',
    'Bülten Verisi (JSON):',
    JSON.stringify(inputPayload, null, 2),
  ].join('\n');
}


