import { describe, expect, it } from 'vitest';
import {
  countScriptWords,
  countWords,
  fromMarkdown,
  toMarkdown,
  validateScriptWordBudget,
  WORDS_MAX,
  WORDS_MIN,
  type Script,
} from './script.ts';

function generateWords(count: number, prefix: string = 'kelime'): string {
  return Array.from({ length: count }, (_, idx) => `${prefix}${idx + 1}`).join(' ');
}

function makeBudgetScript(totalWordTarget: number = 350): Script {
  const introWords = 40;
  const outroWords = 30;
  const remaining = totalWordTarget - introWords - outroWords;
  const seg1Words = Math.floor(remaining / 2);
  const seg2Words = remaining - seg1Words;

  return {
    intro: generateWords(introWords, 'giris'),
    segments: [
      {
        item_url: 'https://example.com/linux-kernel-rust',
        headline_tr: 'Linux Kernel Rust Desteği Genişliyor',
        narration_tr: generateWords(seg1Words, 'birinci'),
      },
      {
        item_url: 'https://example.com/cloudflare-workers-sql',
        headline_tr: 'Serverless Edge Önbellekleme Mimarileri',
        narration_tr: generateWords(seg2Words, 'ikinci'),
      },
    ],
    outro: generateWords(outroWords, 'kapanis'),
  };
}

describe('src/domain/script.ts', () => {
  it('round-trips a Script through toMarkdown and fromMarkdown losslessly', () => {
    const original = makeBudgetScript(360);
    const md = toMarkdown(original);

    expect(md).toContain('## Intro');
    expect(md).toContain('## Story 1: https://example.com/linux-kernel-rust');
    expect(md).toContain('### Linux Kernel Rust Desteği Genişliyor');
    expect(md).toContain('## Story 2: https://example.com/cloudflare-workers-sql');
    expect(md).toContain('### Serverless Edge Önbellekleme Mimarileri');
    expect(md).toContain('## Outro');

    const parsed = fromMarkdown(md);
    expect(parsed).toEqual(original);
    expect(toMarkdown(parsed)).toBe(md);
  });

  it('counts words accurately and validates scripts within [WORDS_MIN, WORDS_MAX]', () => {
    expect(countWords('   ')).toBe(0);
    expect(countWords('Merhaba   dünya\nbugün   nasılsınız')).toBe(4);

    const minScript = makeBudgetScript(WORDS_MIN);
    expect(countScriptWords(minScript)).toBe(WORDS_MIN);
    expect(validateScriptWordBudget(minScript)).toBe(WORDS_MIN);

    const maxScript = makeBudgetScript(WORDS_MAX);
    expect(countScriptWords(maxScript)).toBe(WORDS_MAX);
    expect(validateScriptWordBudget(maxScript)).toBe(WORDS_MAX);
  });

  it('rejects scripts under WORDS_MIN and over WORDS_MAX with exact word counts in the error', () => {
    const underScript = makeBudgetScript(WORDS_MIN - 15); // 265 words
    expect(() => validateScriptWordBudget(underScript)).toThrowError(
      /265 words \(under minimum; allowed budget is 280\.\.2000 words/
    );

    const overScript = makeBudgetScript(WORDS_MAX + 42); // 2042 words
    expect(() => validateScriptWordBudget(overScript)).toThrowError(
      /2042 words \(over maximum; allowed budget is 280\.\.2000 words/
    );
  });

  it('rejects malformed markdown files with clear structural errors', () => {
    expect(() => fromMarkdown('   \n  ')).toThrowError(/empty or has no "##" headings/);

    expect(() =>
      fromMarkdown('Önsöz metni\n## Intro\nMerhaba\n## Outro\nHoşçakalın')
    ).toThrowError(/unexpected content before "## Intro"/);

    expect(() =>
      fromMarkdown('## Story 1: https://example.com/a\n### Başlık\nMetin\n## Outro\nBitiş')
    ).toThrowError(/first section must be "## Intro"/);

    expect(() =>
      fromMarkdown('## Intro\nAçılış\n## Story 1: https://example.com/a\n### Başlık\nMetin')
    ).toThrowError(/last section must be "## Outro"/);

    expect(() => fromMarkdown('## Intro\nAçılış\n\n## Outro\nKapanış')).toThrowError(
      /expected at least one "## Story N: <url>"/
    );

    expect(() =>
      fromMarkdown(
        [
          '## Intro',
          'Açılış konuşması',
          '## Story 2: https://example.com/a',
          '### Başlık',
          'Anlatım metni',
          '## Outro',
          'Kapanış konuşması',
        ].join('\n')
      )
    ).toThrowError(/expected Story 1 but found Story 2/);

    expect(() =>
      fromMarkdown(
        [
          '## Intro',
          'Açılış konuşması',
          '## Story 1: https://example.com/a',
          'Başlık satırı unutuldu',
          '## Outro',
          'Kapanış konuşması',
        ].join('\n')
      )
    ).toThrowError(/expected "### <headline_tr>" immediately inside story section/);

    expect(() =>
      fromMarkdown(
        [
          '## Intro',
          'Açılış konuşması',
          '## Story 1: https://example.com/a',
          '### Sadece Başlık Var',
          '   ',
          '## Outro',
          'Kapanış konuşması',
        ].join('\n')
      )
    ).toThrowError(/story narration must not be empty/);
  });

  it('serializes and parses visual cues in Markdown round-trip (> focus @"..." -> h1) and preserves legacy scripts without cues', () => {
    const base = makeBudgetScript(360);
    const scriptWithCues: Script = {
      ...base,
      segments: [
        {
          ...base.segments[0],
          narration_tr:
            'Yeni model açık kaynak dünyasında yüzde 40 daha hızlı çıkarım sağlıyor. ' +
            base.segments[0].narration_tr,
          visuals: [
            { kind: 'focus', anchor: 'yeni model', target: 'h1' },
            { kind: 'circle', anchor: 'yüzde 40', target: 'p3' },
            { kind: 'stat', anchor: 'daha hızlı', target: '%40', value: '+40%' },
          ],
        },
        {
          // Legacy / cue-less story segment in the same script
          ...base.segments[1],
        },
      ],
    };

    const md = toMarkdown(scriptWithCues);
    expect(md).toContain('> focus @"yeni model" -> h1');
    expect(md).toContain('> circle @"yüzde 40" -> p3');
    expect(md).toContain('> stat @"daha hızlı" -> %40 | +40%');

    const roundTripped = fromMarkdown(md);
    expect(roundTripped).toEqual(scriptWithCues);
    expect(roundTripped.segments[0].visuals).toEqual([
      { kind: 'focus', anchor: 'yeni model', target: 'h1' },
      { kind: 'circle', anchor: 'yüzde 40', target: 'p3' },
      { kind: 'stat', anchor: 'daha hızlı', target: '%40', value: '+40%' },
    ]);
    expect(roundTripped.segments[1].visuals).toBeUndefined();
    expect(toMarkdown(roundTripped)).toBe(md);

    // Cue lines are not counted in spoken narration word count
    expect(countScriptWords(roundTripped)).toBe(countScriptWords({
      ...scriptWithCues,
      segments: scriptWithCues.segments.map(({ item_url, headline_tr, narration_tr }) => ({
        item_url,
        headline_tr,
        narration_tr,
      })),
    }));
  });

  it('drops invalid visual cue lines in fromMarkdown with a warning and never fails the script', () => {
    const base = makeBudgetScript(340);
    const md = [
      '## Intro',
      '',
      base.intro,
      '',
      `## Story 1: ${base.segments[0].item_url}`,
      `### ${base.segments[0].headline_tr}`,
      '',
      base.segments[0].narration_tr,
      '',
      '> focus @"birinci1 birinci2" -> h1',
      '> unknown_kind @"birinci3" -> p1',
      '> circle @"" -> p2',
      '> malformed line without anchor syntax',
      '> highlight @"birinci4 birinci5" -> p3',
      '',
      `## Story 2: ${base.segments[1].item_url}`,
      `### ${base.segments[1].headline_tr}`,
      '',
      base.segments[1].narration_tr,
      '',
      '> totally broken cue',
      '',
      '## Outro',
      '',
      base.outro,
      '',
    ].join('\n');

    const warnings: string[] = [];
    const parsed = fromMarkdown(md, { onWarn: (msg) => warnings.push(msg) });

    expect(warnings).toHaveLength(4);
    expect(parsed.segments[0].visuals).toEqual([
      { kind: 'focus', anchor: 'birinci1 birinci2', target: 'h1' },
      { kind: 'highlight', anchor: 'birinci4 birinci5', target: 'p3' },
    ]);
    // Story 2 had only an invalid cue -> dropped cleanly, leaving visuals undefined (default choreography)
    expect(parsed.segments[1].visuals).toBeUndefined();
  });
});


