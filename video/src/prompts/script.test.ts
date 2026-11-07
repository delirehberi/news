import { describe, expect, it } from 'vitest';
import {
  buildScriptUserPrompt,
  createScriptResponseSchema,
  isAnchorInNarration,
  isCueTargetValid,
  PROMPT_ELEMENT_TEXT_MAX_CHARS,
  SCRIPT_SYSTEM_PROMPT,
} from './script.ts';

function generateWords(count: number, prefix: string = 'kelime'): string {
  return Array.from({ length: count }, (_, idx) => `${prefix}${idx + 1}`).join(' ');
}

describe('src/prompts/script.ts', () => {
  describe('buildScriptUserPrompt & SCRIPT_SYSTEM_PROMPT', () => {
    it('includes captured element lists (ids + short text) and excerpt per story when captures exist', () => {
      const longElementText = 'A'.repeat(220);
      const userPrompt = buildScriptUserPrompt(
        '2026-W42',
        {
          title_tr: 'Haftalık Teknoloji Özeti',
          intro_tr: 'Bu haftanın öne çıkan gelişmeleri.',
          items: [
            {
              url: 'https://example.com/story-1',
              title_tr: 'Birinci Haber',
              summary_tr: 'Birinci haber özeti.',
              source: 'hackernews',
              image_url: null,
            },
            {
              url: 'https://example.com/story-2',
              title_tr: 'İkinci Haber',
              summary_tr: 'İkinci haber özeti.',
              source: 'lobsters',
              image_url: null,
            },
          ],
        },
        new Map([
          [
            'https://example.com/story-1',
            {
              excerpt: 'Yakalanan makale metni özeti.',
              elements: [
                {
                  id: 'h1',
                  kind: 'h1',
                  tagName: 'h1',
                  text: 'Yeni Model Mimarisi Tanıtıldı',
                  box: { x: 100, y: 80, width: 900, height: 60 },
                },
                {
                  id: 'p1',
                  kind: 'paragraph',
                  tagName: 'p',
                  text: longElementText,
                  box: { x: 100, y: 180, width: 880, height: 120 },
                },
              ],
            },
          ],
        ])
      );

      expect(SCRIPT_SYSTEM_PROMPT).toContain('visuals');
      expect(userPrompt).toContain('"visuals"');
      expect(userPrompt).toContain('"id": "h1"');
      expect(userPrompt).toContain('"Yeni Model Mimarisi Tanıtıldı"');
      expect(userPrompt).toContain('"id": "p1"');

      // Extract serialized JSON payload from user prompt and verify element text truncation & story 2 omission
      const jsonMarker = 'Bülten Verisi (JSON):\n';
      const payloadJson = userPrompt.slice(userPrompt.indexOf(jsonMarker) + jsonMarker.length);
      const parsedPayload = JSON.parse(payloadJson) as {
        stories: Array<{
          item_url: string;
          excerpt?: string;
          elements?: Array<{ id: string; kind?: string; text: string }>;
        }>;
      };

      expect(parsedPayload.stories[0].excerpt).toBe('Yakalanan makale metni özeti.');
      expect(parsedPayload.stories[0].elements).toHaveLength(2);
      expect(parsedPayload.stories[0].elements?.[0]).toEqual({
        id: 'h1',
        kind: 'h1',
        text: 'Yeni Model Mimarisi Tanıtıldı',
      });
      expect(parsedPayload.stories[0].elements?.[1].text.length).toBeLessThanOrEqual(
        PROMPT_ELEMENT_TEXT_MAX_CHARS
      );
      expect(parsedPayload.stories[0].elements?.[1].text.endsWith('…')).toBe(true);

      // Story 2 had no page capture -> neither excerpt nor elements
      expect(parsedPayload.stories[1].excerpt).toBeUndefined();
      expect(parsedPayload.stories[1].elements).toBeUndefined();
    });
  });

  describe('createScriptResponseSchema refinement & cue validation', () => {
    const urls = ['https://example.com/story-1', 'https://example.com/story-2'];
    const captures = new Map([
      [
        'https://example.com/story-1',
        {
          excerpt: 'Story 1 excerpt',
          elements: [
            {
              id: 'h1',
              kind: 'h1' as const,
              text: 'Yeni Model Performans Sonuçları',
            },
            {
              id: 'p1',
              kind: 'paragraph' as const,
              text: 'Testlerde yüzde 40 daha hızlı sonuç alındı.',
            },
            {
              id: 'fig1',
              kind: 'figure' as const,
              text: 'Bellek karşılaştırma grafiği',
            },
          ],
        },
      ],
      [
        'https://example.com/story-2',
        {
          excerpt: 'Story 2 excerpt',
          elements: [
            {
              id: 'h1',
              kind: 'h1' as const,
              text: 'Dağıtık SQLite Replikasyonu',
            },
            {
              id: 'quote1',
              kind: 'blockquote' as const,
              text: 'Sıfır gecikmeli okuma kopyaları artık mümkün.',
            },
          ],
        },
      ],
    ]);

    it('keeps valid cues (2-5 per segment) matching narration_tr anchors and element map targets or stat/quote values', () => {
      const warnings: string[] = [];
      const schema = createScriptResponseSchema(urls, {
        pageCapturesByUrl: captures,
        onWarn: (msg) => warnings.push(msg),
      });

      const narration1 =
        `Bu hafta tanıtılan yeni model özellikle çıkarım hızında yüzde 40 artış sağlıyor ve bellek grafiği bunu kanıtlıyor. ` +
        generateWords(115, 'birinci');
      const narration2 =
        `Kenar sunucularda dağıtık mimari sayesinde sıfır gecikmeli okuma performansı elde ediliyor. ` +
        generateWords(120, 'ikinci');

      const parsed = schema.parse({
        intro: generateWords(40, 'intro'),
        segments: [
          {
            item_url: 'https://example.com/story-1',
            headline_tr: 'Yeni Model Performansı',
            narration_tr: narration1,
            visuals: [
              { kind: 'focus', anchor: 'yeni model', target: 'h1' },
              { kind: 'circle', anchor: 'yüzde 40', target: 'p1' },
              { kind: 'stat', anchor: 'yüzde 40 artış', target: '%40' },
              { kind: 'highlight', anchor: 'bellek grafiği', target: 'fig1' },
            ],
          },
          {
            item_url: 'https://example.com/story-2',
            headline_tr: 'Dağıtık SQLite Mimarisi',
            narration_tr: narration2,
            visuals: [
              { kind: 'focus', anchor: 'dağıtık mimari', target: 'h1' },
              {
                kind: 'quote',
                anchor: 'sıfır gecikmeli okuma',
                target: 'Sıfır gecikmeli okuma kopyaları',
              },
            ],
          },
        ],
        outro: generateWords(30, 'outro'),
      });

      expect(warnings).toHaveLength(0);
      expect(parsed.segments[0].visuals).toHaveLength(4);
      expect(parsed.segments[1].visuals).toHaveLength(2);
    });

    it('drops invalid cues (missing anchor in narration, missing target in element map, invalid kind, >5 cues) with warnings and never fails the script', () => {
      const warnings: string[] = [];
      const schema = createScriptResponseSchema(urls, {
        pageCapturesByUrl: captures,
        onWarn: (msg) => warnings.push(msg),
      });

      const narration1 =
        `Bu hafta tanıtılan yeni model özellikle çıkarım hızında yüzde 40 artış sağlıyor ve bellek grafiği bunu kanıtlıyor. ` +
        generateWords(115, 'birinci');
      const narration2 =
        `Kenar sunucularda dağıtık mimari sayesinde sıfır gecikmeli okuma performansı elde ediliyor. ` +
        generateWords(120, 'ikinci');

      const parsed = schema.parse({
        intro: generateWords(40, 'intro'),
        segments: [
          {
            item_url: 'https://example.com/story-1',
            headline_tr: 'Yeni Model Performansı',
            narration_tr: narration1,
            visuals: [
              // 1. Valid
              { kind: 'focus', anchor: 'yeni model', target: 'h1' },
              // 2. Invalid: anchor does not exist in narration_tr
              { kind: 'circle', anchor: 'metinde hiç geçmeyen cümle', target: 'p1' },
              // 3. Invalid: target element ID p99 does not exist in element map
              { kind: 'highlight', anchor: 'yüzde 40', target: 'p99' },
              // 4. Invalid: unknown cue kind
              { kind: 'explode', anchor: 'yeni model', target: 'h1' },
              // 5. Valid
              { kind: 'circle', anchor: 'yüzde 40', target: 'p1' },
            ],
          },
          {
            item_url: 'https://example.com/story-2',
            headline_tr: 'Dağıtık SQLite Mimarisi',
            narration_tr: narration2,
            visuals: [
              // All cues invalid for story 2 -> visuals should be omitted cleanly without failing
              { kind: 'focus', anchor: 'uydurma anchor', target: 'h1' },
              { kind: 'underline', anchor: 'dağıtık mimari', target: 'fig99' },
            ],
          },
        ],
        outro: generateWords(30, 'outro'),
      });

      expect(warnings).toHaveLength(5);
      expect(warnings.some((w) => w.includes('metinde hiç geçmeyen cümle'))).toBe(true);
      expect(warnings.some((w) => w.includes('p99'))).toBe(true);
      expect(warnings.some((w) => w.includes('fig99'))).toBe(true);

      // Valid cues in segment 1 are preserved; segment 2 has visuals omitted
      expect(parsed.segments[0].visuals).toEqual([
        { kind: 'focus', anchor: 'yeni model', target: 'h1' },
        { kind: 'circle', anchor: 'yüzde 40', target: 'p1' },
      ]);
      expect(parsed.segments[1].visuals).toBeUndefined();
    });

    it(' remains backward compatible when segments omit visuals altogether', () => {
      const schema = createScriptResponseSchema(urls, captures);
      const legacyScript = {
        intro: generateWords(40, 'intro'),
        segments: [
          {
            item_url: 'https://example.com/story-1',
            headline_tr: 'Birinci Başlık',
            narration_tr: generateWords(130, 'birinci'),
          },
          {
            item_url: 'https://example.com/story-2',
            headline_tr: 'İkinci Başlık',
            narration_tr: generateWords(130, 'ikinci'),
          },
        ],
        outro: generateWords(30, 'outro'),
      };

      const parsed = schema.parse(legacyScript);
      expect(parsed).toEqual(legacyScript);
      expect(parsed.segments[0].visuals).toBeUndefined();
      expect(parsed.segments[1].visuals).toBeUndefined();
    });

    it('unit-tests isAnchorInNarration and isCueTargetValid directly', () => {
      expect(
        isAnchorInNarration(
          'Yüzde 40',
          'Bu hafta yeni model yüzde 40 daha hızlı çalışıyor.'
        )
      ).toBe(true);
      expect(
        isAnchorInNarration(
          'kuantum bilgisayar',
          'Bu hafta yeni model yüzde 40 daha hızlı çalışıyor.'
        )
      ).toBe(false);

      const sampleElements = [
        {
          id: 'h1',
          kind: 'h1' as const,
          tagName: 'h1',
          text: 'Başlık',
          box: { x: 0, y: 0, width: 800, height: 60 },
        },
      ];

      expect(
        isCueTargetValid({ kind: 'focus', anchor: 'yeni model', target: 'h1' }, sampleElements)
      ).toBe(true);
      expect(
        isCueTargetValid({ kind: 'focus', anchor: 'yeni model', target: 'p3' }, sampleElements)
      ).toBe(false);
      expect(
        isCueTargetValid({ kind: 'stat', anchor: 'yüzde 40', target: '%40' }, sampleElements)
      ).toBe(true);
    });
  });
});
