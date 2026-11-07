import { z } from 'zod';
import { VisualCueSchema, type VisualCue } from './cues.ts';

export const WORDS_MIN = 280;
export const WORDS_MAX = 700;
export const WORDS_PER_MINUTE = 140;

const HEADING_INTRO = '## Intro';
const HEADING_OUTRO = '## Outro';
const HEADING_STORY_PREFIX = '## Story ';
const STORY_HEADING_REGEX = /^## Story (\d+):\s*(\S+)\s*$/;
const HEADLINE_HEADING_PREFIX = '### ';
const HEADLINE_LABEL_PREFIX = 'Headline:';
const BOLD_HEADLINE_LABEL_PREFIX = '**Headline:**';

const CUE_LINE_DOUBLE_QUOTE_REGEX =
  /^>\s*(\S+)\s+@"((?:[^"\\]|\\.)*)"(?:\s*(?:->\s*(.*?))?(?:\s*\|\s*(.+))?|\s*=>\s*(.+))?\s*$/;
const CUE_LINE_SINGLE_QUOTE_REGEX =
  /^>\s*(\S+)\s+@'((?:[^'\\]|\\.)*)'(?:\s*(?:->\s*(.*?))?(?:\s*\|\s*(.+))?|\s*=>\s*(.+))?\s*$/;

export const ScriptSegmentSchema = z.object({
  item_url: z.string().trim().min(1, 'Story item_url must not be empty'),
  headline_tr: z.string().trim().min(1, 'Story headline_tr must not be empty'),
  narration_tr: z.string().trim().min(1, 'Story narration_tr must not be empty'),
  visuals: z.array(VisualCueSchema).optional(),
});

export type ScriptSegment = z.infer<typeof ScriptSegmentSchema>;

export const ScriptSchema = z.object({
  intro: z.string().trim().min(1, 'Script intro must not be empty'),
  segments: z.array(ScriptSegmentSchema).min(1, 'Script segments must not be empty'),
  outro: z.string().trim().min(1, 'Script outro must not be empty'),
});

export type Script = z.infer<typeof ScriptSchema>;

export interface FromMarkdownOptions {
  onWarn?: (msg: string) => void;
}

/**
 * Counts whitespace-delimited words in a string.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return 0;
  }
  return trimmed.split(/\s+/).length;
}

/**
 * Counts the total spoken narration words across `intro`, every segment's `narration_tr`,
 * and `outro`.
 */
export function countScriptWords(script: Script): number {
  let total = countWords(script.intro) + countWords(script.outro);
  for (const segment of script.segments) {
    total += countWords(segment.narration_tr);
  }
  return total;
}

/**
 * Validates that a `Script` meets structural requirements and its spoken narration
 * word count falls within `[WORDS_MIN, WORDS_MAX]`.
 * Returns the validated total word count, or throws a descriptive Error including the exact word count.
 */
export function validateScriptWordBudget(script: Script): number {
  const parsed = ScriptSchema.safeParse(script);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid script structure: ${details}`);
  }

  const wordCount = countScriptWords(parsed.data);
  if (wordCount < WORDS_MIN || wordCount > WORDS_MAX) {
    const constraint = wordCount < WORDS_MIN ? 'under minimum' : 'over maximum';
    throw new Error(
      `Script narration word count is ${wordCount} words (${constraint}; allowed budget is ${WORDS_MIN}..${WORDS_MAX} words for 2-5 min at ~${WORDS_PER_MINUTE} wpm).`
    );
  }

  return wordCount;
}

/**
 * Serializes a single `VisualCue` into an editable Markdown line:
 * e.g. `> focus @"yeni model" -> h1` or `> circle @"yüzde 40" -> p3`.
 */
export function formatVisualCueLine(cue: VisualCue): string {
  const escapedAnchor = cue.anchor.trim().replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const target = cue.target?.trim();
  const value = cue.value?.trim();

  if (target && value) {
    return `> ${cue.kind} @"${escapedAnchor}" -> ${target} | ${value}`;
  }
  if (target) {
    return `> ${cue.kind} @"${escapedAnchor}" -> ${target}`;
  }
  if (value) {
    return `> ${cue.kind} @"${escapedAnchor}" => ${value}`;
  }
  return `> ${cue.kind} @"${escapedAnchor}"`;
}

/**
 * Parses a single `> <kind> @"<anchor>" -> <target>` Markdown line into a validated `VisualCue`,
 * or returns `null` if the line is malformed or fails `VisualCueSchema`.
 */
export function parseVisualCueLine(line: string): VisualCue | null {
  const trimmed = line.trim();
  const match =
    CUE_LINE_DOUBLE_QUOTE_REGEX.exec(trimmed) ??
    CUE_LINE_SINGLE_QUOTE_REGEX.exec(trimmed);

  if (!match) {
    return null;
  }

  const rawKind = match[1]?.trim() ?? '';
  const rawAnchor = (match[2] ?? '')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, '\\')
    .trim();
  const rawTarget = match[3]?.trim();
  const rawPipeValue = match[4]?.trim();
  const rawArrowValue = match[5]?.trim();
  const rawValue = rawPipeValue || rawArrowValue;

  const candidate: Record<string, unknown> = {
    kind: rawKind,
    anchor: rawAnchor,
    ...(rawTarget ? { target: rawTarget } : {}),
    ...(rawValue ? { value: rawValue } : {}),
  };

  const parsed = VisualCueSchema.safeParse(candidate);
  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

/**
 * Serializes a `Script` into an editable Markdown document using fixed
 * `## Intro`, `## Story N: <url>`, and `## Outro` headings, plus optional
 * `> <kind> @"<anchor>" -> <target>` visual cue lines under each story.
 */
export function toMarkdown(script: Script): string {
  const lines: string[] = [
    HEADING_INTRO,
    '',
    script.intro.trim(),
    '',
  ];

  script.segments.forEach((segment, index) => {
    const storyNumber = index + 1;
    lines.push(`${HEADING_STORY_PREFIX}${storyNumber}: ${segment.item_url.trim()}`);
    lines.push(`${HEADLINE_HEADING_PREFIX}${segment.headline_tr.trim()}`);
    lines.push('');
    lines.push(segment.narration_tr.trim());
    if (segment.visuals && segment.visuals.length > 0) {
      lines.push('');
      for (const cue of segment.visuals) {
        lines.push(formatVisualCueLine(cue));
      }
    }
    lines.push('');
  });

  lines.push(HEADING_OUTRO);
  lines.push('');
  lines.push(script.outro.trim());
  lines.push('');

  return lines.join('\n');
}

interface RawMarkdownSection {
  heading: string;
  bodyLines: string[];
}

function splitMarkdownSections(md: string): RawMarkdownSection[] {
  const normalized = md.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const sections: RawMarkdownSection[] = [];
  let current: RawMarkdownSection | null = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmedLine = rawLine.trim();

    if (trimmedLine.startsWith('## ')) {
      if (current) {
        sections.push(current);
      }
      current = {
        heading: trimmedLine,
        bodyLines: [],
      };
      continue;
    }

    if (!current) {
      if (trimmedLine.length === 0) {
        continue;
      }
      throw new Error(
        `Malformed script markdown at line ${i + 1}: unexpected content before "${HEADING_INTRO}".`
      );
    }

    current.bodyLines.push(rawLine);
  }

  if (current) {
    sections.push(current);
  }

  return sections;
}

function parseStorySectionBody(
  storyNumber: number,
  itemUrl: string,
  bodyLines: readonly string[],
  onWarn?: (msg: string) => void
): ScriptSegment {
  let startIdx = 0;
  while (startIdx < bodyLines.length && bodyLines[startIdx].trim().length === 0) {
    startIdx++;
  }

  if (startIdx >= bodyLines.length) {
    throw new Error(
      `Malformed script markdown in Story ${storyNumber} (${itemUrl}): missing headline and narration.`
    );
  }

  const firstLine = bodyLines[startIdx].trim();
  let headlineTr = '';

  if (firstLine.startsWith(HEADLINE_HEADING_PREFIX)) {
    headlineTr = firstLine.slice(HEADLINE_HEADING_PREFIX.length).trim();
  } else if (firstLine.startsWith(BOLD_HEADLINE_LABEL_PREFIX)) {
    headlineTr = firstLine.slice(BOLD_HEADLINE_LABEL_PREFIX.length).trim();
  } else if (firstLine.startsWith(HEADLINE_LABEL_PREFIX)) {
    headlineTr = firstLine.slice(HEADLINE_LABEL_PREFIX.length).trim();
  } else {
    throw new Error(
      `Malformed script markdown in Story ${storyNumber} (${itemUrl}): expected "### <headline_tr>" immediately inside story section.`
    );
  }

  if (!headlineTr) {
    throw new Error(
      `Malformed script markdown in Story ${storyNumber} (${itemUrl}): story headline must not be empty.`
    );
  }

  const narrationLines: string[] = [];
  const visuals: VisualCue[] = [];
  const warn = onWarn ?? ((msg: string) => console.warn(msg));

  for (let i = startIdx + 1; i < bodyLines.length; i++) {
    const rawLine = bodyLines[i];
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('>')) {
      const parsedCue = parseVisualCueLine(trimmed);
      if (parsedCue) {
        visuals.push(parsedCue);
      } else {
        warn(
          `Story #${storyNumber} (${itemUrl}): dropping invalid markdown visual cue line "${trimmed}".`
        );
      }
    } else {
      narrationLines.push(rawLine);
    }
  }

  const narrationTr = narrationLines.join('\n').trim();

  if (!narrationTr) {
    throw new Error(
      `Malformed script markdown in Story ${storyNumber} (${itemUrl}): story narration must not be empty.`
    );
  }

  return {
    item_url: itemUrl,
    headline_tr: headlineTr,
    narration_tr: narrationTr,
    ...(visuals.length > 0 ? { visuals } : {}),
  };
}

/**
 * Parses an editable `script.md` string back into a validated `Script` object.
 * Requires fixed `## Intro`, sequential `## Story N: <url>` (1..N), and `## Outro` headings.
 * Optional `> <kind> @"<anchor>" -> <target>` lines under each story are parsed into `visuals`.
 * Invalid cue lines are dropped with a warning without failing the script.
 */
export function fromMarkdown(md: string, options?: FromMarkdownOptions): Script {
  const sections = splitMarkdownSections(md);

  if (sections.length === 0) {
    throw new Error(`Malformed script markdown: document is empty or has no "##" headings.`);
  }

  if (sections[0].heading !== HEADING_INTRO) {
    throw new Error(
      `Malformed script markdown: first section must be "${HEADING_INTRO}", found "${sections[0].heading}".`
    );
  }

  const lastSection = sections[sections.length - 1];
  if (lastSection.heading !== HEADING_OUTRO) {
    throw new Error(
      `Malformed script markdown: last section must be "${HEADING_OUTRO}", found "${lastSection.heading}".`
    );
  }

  const storySections = sections.slice(1, -1);
  if (storySections.length === 0) {
    throw new Error(
      `Malformed script markdown: expected at least one "## Story N: <url>" section between "${HEADING_INTRO}" and "${HEADING_OUTRO}".`
    );
  }

  const intro = sections[0].bodyLines.join('\n').trim();
  if (!intro) {
    throw new Error(`Malformed script markdown: "${HEADING_INTRO}" narration must not be empty.`);
  }

  const outro = lastSection.bodyLines.join('\n').trim();
  if (!outro) {
    throw new Error(`Malformed script markdown: "${HEADING_OUTRO}" narration must not be empty.`);
  }

  const segments: ScriptSegment[] = [];
  for (let i = 0; i < storySections.length; i++) {
    const expectedStoryNum = i + 1;
    const section = storySections[i];
    const match = STORY_HEADING_REGEX.exec(section.heading);

    if (!match) {
      throw new Error(
        `Malformed script markdown: invalid story heading "${section.heading}". Expected "## Story ${expectedStoryNum}: <url>".`
      );
    }

    const actualStoryNum = Number.parseInt(match[1], 10);
    const itemUrl = match[2].trim();

    if (actualStoryNum !== expectedStoryNum) {
      throw new Error(
        `Malformed script markdown: expected Story ${expectedStoryNum} but found Story ${actualStoryNum} in heading "${section.heading}".`
      );
    }

    segments.push(
      parseStorySectionBody(expectedStoryNum, itemUrl, section.bodyLines, options?.onWarn)
    );
  }

  return {
    intro,
    segments,
    outro,
  };
}


