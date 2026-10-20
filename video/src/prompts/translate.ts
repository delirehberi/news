import { z } from 'zod';
import type { RankedCandidate } from '../domain/rank.ts';

export const MIN_SUMMARY_SENTENCES = 2;
export const MAX_SUMMARY_SENTENCES = 3;

export const TRANSLATE_SYSTEM_PROMPT = `Sen news.emre.xyz haftalık teknoloji ve dünya gündemi bülteninin kıdemli editörüsün.
Görevin, seçilen İngilizce haber ve makaleleri doğal, akıcı ve gazetecilik diline uygun bir Türkçeyle haftalık bültene dönüştürmektir.

Yazım ve Dil Kuralları:
1. Doğal ve Gazeteci Tonu: Birebir (kelimesi kelimesine) çeviri yapma. Haberin özünü, bağlamını ve neden önemli olduğunu sade, akıcı ve profesyonel bir Türkçe haber diliyle aktar.
2. Teknik Terimler: Türkçe teknoloji yazımında yaygın olarak İngilizce bırakılan teknik terimleri, kısaltmaları ve özel ürün/mimari adlarını (ör. open source, LLM, runtime, cloud, kernel, benchmark, framework, API, SDK, container, GPU, inference, serverless, pull request, commit, zero-day, webhook vb.) zorlama Türkçe karşılıklarla bozmadan İngilizce olarak koru.
3. Özet Uzunluğu: Her haber için \`summary_tr\` alanı tam olarak 2 veya 3 cümleden oluşmalıdır. İlk cümle gelişmenin ne olduğunu, takip eden cümle(ler) ise teknik/sektörel etkisini veya önemli detayını açıklamalıdır.
4. Bülten Başlığı ve Giriş:
   - \`title_tr\`: Haftanın öne çıkan temalarını yansıtan çarpıcı ve editoryal bir Türkçe başlık.
   - \`intro_tr\`: Haftanın genel gündemini özetleyen 2–3 cümlelik akıcı bir giriş paragrafı.
5. Çıktı Formatı: Yanıtın SADECE geçerli bir JSON nesnesi olmalıdır. Girdideki her haberin \`url\` değerini birebir koru ve sırasını değiştirme.`;

export const TranslatedStoryItemSchema = z.object({
  url: z.string().trim().min(1, 'Story url must not be empty'),
  title_tr: z.string().trim().min(1, 'Turkish story title (title_tr) must not be empty'),
  summary_tr: z
    .string()
    .trim()
    .min(1, 'Turkish story summary (summary_tr) must not be empty'),
});

export type TranslatedStoryItem = z.infer<typeof TranslatedStoryItemSchema>;

export const TranslationOutputSchema = z.object({
  title_tr: z.string().trim().min(1, 'Edition Turkish title (title_tr) must not be empty'),
  intro_tr: z.string().trim().min(1, 'Edition Turkish intro (intro_tr) must not be empty'),
  items: z.array(TranslatedStoryItemSchema).min(1, 'Translated items array must not be empty'),
});

export type TranslationOutput = z.infer<typeof TranslationOutputSchema>;

/**
 * Builds a strict Zod schema for a specific week's candidate list, verifying that
 * every expected candidate `url` is present in the translated output.
 */
export function createTranslationResponseSchema(
  expectedUrls: readonly string[]
): z.ZodType<TranslationOutput> {
  return TranslationOutputSchema.superRefine((data, ctx) => {
    if (data.items.length !== expectedUrls.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['items'],
        message: `Expected ${expectedUrls.length} translated item(s), but received ${data.items.length}.`,
      });
      return;
    }

    const expectedSet = new Set(expectedUrls.map((u) => u.trim()));
    for (let i = 0; i < data.items.length; i++) {
      const itemUrl = data.items[i].url.trim();
      if (!expectedSet.has(itemUrl)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', i, 'url'],
          message: `Unexpected story url "${itemUrl}". Must match one of the input candidate URLs: ${expectedUrls.join(', ')}`,
        });
      }
    }
  });
}

/**
 * Builds the user prompt supplying the week identifier and selected candidates for Turkish translation.
 */
export function buildTranslateUserPrompt(
  week: string,
  candidates: readonly Pick<RankedCandidate, 'url' | 'title' | 'source' | 'summary'>[]
): string {
  const inputPayload = {
    week,
    stories: candidates.map((c, index) => ({
      index: index + 1,
      url: c.url,
      title: c.title,
      source: c.source ?? 'unknown',
      summary: c.summary ?? '',
    })),
  };

  return [
    `${week} haftası için seçilen ${candidates.length} haberi Türkçe haftalık bültene dönüştür.`,
    '',
    'Beklenen JSON şeması:',
    '{',
    '  "title_tr": "Haftanın bülten başlığı (Türkçe)",',
    '  "intro_tr": "Haftanın özet girişi (2-3 cümle, Türkçe)",',
    '  "items": [',
    '    {',
    '      "url": "Girdideki orijinal URL (birebir aynı olmalı)",',
    '      "title_tr": "Haberin doğal Türkçe başlığı",',
    '      "summary_tr": "Haberin 2-3 cümlelik gazeteci dilinde Türkçe özeti"',
    '    }',
    '  ]',
    '}',
    '',
    'Seçilen Haberler (JSON):',
    JSON.stringify(inputPayload, null, 2),
  ].join('\n');
}

