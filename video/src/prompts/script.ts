import { z } from 'zod';
import type { WeeklyTranslation } from '../commands/translate.ts';
import type { PageCaptureMetadata } from '../domain/pageCapture.ts';
import {
  countScriptWords,
  ScriptSchema,
  WORDS_MAX,
  WORDS_MIN,
  WORDS_PER_MINUTE,
  type Script,
} from '../domain/script.ts';

export const SCRIPT_SYSTEM_PROMPT = `Sen news.emre.xyz haftalık YouTube teknoloji ve gündem bülteninin baş metin yazarı ve sunucususun.
Görevin, Türkçeye çevrilmiş haftalık haber bülteninden 2 ila 5 dakikalık (yaklaşık ${WORDS_PER_MINUTE} kelime/dakika hızında okunacak) akıcı, doğal ve dinamik bir Türkçe seslendirme metni (video script) üretmektir.

Yazım, Seslendirme ve Kelime Bütçesi Kuralları:
1. Kelime Bütçesi (ZORUNLU):
   - \`intro\`, tüm \`segments[].narration_tr\` ve \`outro\` alanlarındaki toplam kelime sayısı EN AZ ${WORDS_MIN} ve EN FAZLA ${WORDS_MAX} kelime olmalıdır (ideal hedef: 380–520 kelime).
   - Ne çok kısa (280 kelimenin altı) ne de çok uzun (700 kelimenin üstü) yazma.
2. Doğal Konuşma ve Sunum Dili:
   - Metin sesli okunacaktır (ElevenLabs TTS). Yazı dili yerine kulağa doğal gelen, net, enerjik ve profesyonel bir yayıncı/sunucu Türkçesi kullan.
   - Çok uzun, karmaşık veya iç içe geçmiş yan cümlelerden kaçın; nefes payı bırakan akıcı cümleler kur.
3. Teknik Terimler:
   - Türkçe teknoloji yayıncılığında doğal olarak İngilizce kullanılan terimleri (open source, LLM, runtime, cloud, kernel, benchmark, framework, API, SDK, GPU, serverless vb.) olduğu gibi koru.
4. Yapı:
   - \`intro\`: İzleyiciyi karşılayan, haftanın öne çıkan temalarını kısaca çerçeveleyen etkileyici bir açılış konuşması (yaklaşık 35–60 kelime).
   - \`segments\`: Girdideki her haber için sırayı bozmadan bir segment üret:
     - \`item_url\`: Haberin girdideki orijinal URL'si (birebir aynı olmalı).
     - \`headline_tr\`: Video ekranında kart başlığı olarak görünecek kısa, vurucu Türkçe başlık.
     - \`narration_tr\`: Haberin ne olduğunu ve neden önemli olduğunu anlatan seslendirme metni (haber başına yaklaşık 55–85 kelime).
   - \`outro\`: Bülteni toparlayan, tüm kaynak linklerinin ve detaylı özetlerin news.emre.xyz/weekly adresinde yer aldığını hatırlatan kapanış konuşması (yaklaşık 25–45 kelime).
5. Çıktı Formatı:
   - Yanıtın SADECE geçerli bir JSON nesnesi olmalıdır.`;

/**
 * Builds a strict Zod schema for the LLM script output that verifies:
 * 1. Exact segment count and `item_url` order matching `expectedUrls`.
 * 2. Total spoken narration word count (`intro` + `segments[].narration_tr` + `outro`) within `[WORDS_MIN, WORDS_MAX]`.
 */
export function createScriptResponseSchema(
  expectedUrls: readonly string[]
): z.ZodType<Script> {
  return ScriptSchema.superRefine((data, ctx) => {
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

    const totalWords = countScriptWords(data);
    if (totalWords < WORDS_MIN || totalWords > WORDS_MAX) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments'],
        message: `Total narration word count is ${totalWords} words, which is outside the required budget of ${WORDS_MIN}..${WORDS_MAX} words. Adjust narration length so total words (intro + all narration_tr + outro) is between ${WORDS_MIN} and ${WORDS_MAX}.`,
      });
    }
  });
}

/**
 * Builds the user prompt supplying the translated weekly edition (and optional
 * captured article excerpts from `out/<week>/pages/<n>.json`) for Turkish video script generation.
 */
export function buildScriptUserPrompt(
  week: string,
  translation: Pick<WeeklyTranslation, 'title_tr' | 'intro_tr' | 'items'>,
  pageCapturesByUrl?: ReadonlyMap<string, Pick<PageCaptureMetadata, 'excerpt'>>
): string {
  const inputPayload = {
    week,
    title_tr: translation.title_tr,
    intro_tr: translation.intro_tr,
    stories: translation.items.map((item, idx) => {
      const normalizedUrl = item.url.trim();
      const capture = pageCapturesByUrl?.get(normalizedUrl);
      const excerpt = capture?.excerpt?.trim();
      return {
        index: idx + 1,
        item_url: item.url,
        title_tr: item.title_tr,
        summary_tr: item.summary_tr,
        source: item.source,
        ...(excerpt ? { excerpt } : {}),
      };
    }),
  };

  return [
    `${week} haftası için hazırlanan aşağıdaki Türkçe bültenden YouTube video seslendirme metni (script) üret.`,
    `Toplam seslendirme kelime sayısı (intro + tüm segments[].narration_tr + outro) ${WORDS_MIN} ile ${WORDS_MAX} kelime arasında olmalıdır.`,
    '',
    'Beklenen JSON şeması:',
    '{',
    '  "intro": "Açılış seslendirme metni (Türkçe)",',
    '  "segments": [',
    '    {',
    '      "item_url": "Girdideki item_url ile birebir aynı URL",',
    '      "headline_tr": "Video kartında gösterilecek kısa Türkçe başlık",',
    '      "narration_tr": "Haberin seslendirme metni (Türkçe)"',
    '    }',
    '  ],',
    '  "outro": "Kapanış seslendirme metni (Türkçe)"',
    '}',
    '',
    'Bülten Verisi (JSON):',
    JSON.stringify(inputPayload, null, 2),
  ].join('\n');
}

