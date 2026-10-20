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
      /265 words \(under minimum; allowed budget is 280\.\.700 words/
    );

    const overScript = makeBudgetScript(WORDS_MAX + 42); // 742 words
    expect(() => validateScriptWordBudget(overScript)).toThrowError(
      /742 words \(over maximum; allowed budget is 280\.\.700 words/
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
});

