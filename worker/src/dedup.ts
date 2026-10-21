// Cross-source duplicate confirmation and cluster planning.
// Kept free of Worker bindings: the LLM call is injected so the judge can be unit-tested.

import { ClusterMember, ConfirmedPair, DuplicateCandidate, assignClusters } from './scoring';
import { stripMarkdownCodeFences } from './newsletter';

export const DUPLICATE_JUDGE_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast' as const;
export const DUPLICATE_JUDGE_BATCH_SIZE = 15;
export const DUPLICATE_JUDGE_SNIPPET_CHARS = 300;
export const DUPLICATE_JUDGE_MAX_TOKENS = 512;

export const DUPLICATE_JUDGE_SYSTEM_PROMPT = `You deduplicate a tech news feed that aggregates Hacker News, Lobsters, Reddit, Stacker News and newsletters.
For each numbered pair, decide whether both entries report the SAME specific event, announcement, release, incident or publication.

Mark a pair as duplicate only when a reader would see the second entry as the same news again, for example:
- The same release announced on two sites ("PHP 8.5 security release" on php.net and on a mailing list).
- Two write-ups of the same incident, vulnerability or launch.

Do NOT mark as duplicate when the entries merely share a topic, technology, company or theme, for example:
- Two different Bitcoin opinion pieces, two different Rust blog posts, or two different security bugs.
- A news item and an unrelated discussion thread in the same community.

Return ONLY a valid JSON object listing the pair numbers that are duplicates.
Format:
{"duplicate_pairs": [0, 3]}`;

export interface JudgeArticle {
  id: string;
  title: string;
  url: string;
  summary?: string | null;
}

// Sends one system prompt plus one user message to an LLM and resolves with its raw response.
export type TextCompletion = (systemPrompt: string, userContent: string) => Promise<unknown>;

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // A malformed URL just gives the judge no domain hint; the title still carries the signal.
    return '';
  }
}

function describeForJudge(article: JudgeArticle): { title: string; domain: string; summary: string } {
  return {
    title: article.title,
    domain: domainOf(article.url),
    summary: (article.summary || '').trim().substring(0, DUPLICATE_JUDGE_SNIPPET_CHARS)
  };
}

/**
 * Reads `{"duplicate_pairs": [...]}` from a pre-parsed object or a JSON string.
 * Anything malformed yields an empty set: an unreadable verdict must never merge stories.
 */
export function parseDuplicateVerdicts(rawResponse: unknown, pairCount: number): Set<number> {
  const verdicts = new Set<number>();
  let parsed: unknown = rawResponse;
  if (typeof rawResponse === 'string') {
    try {
      parsed = JSON.parse(stripMarkdownCodeFences(rawResponse));
    } catch (e) {
      console.error('parseDuplicateVerdicts: malformed judge response, merging nothing', e);
      return verdicts;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return verdicts;

  const indices = (parsed as Record<string, unknown>).duplicate_pairs;
  if (!Array.isArray(indices)) return verdicts;
  for (const index of indices) {
    if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < pairCount) {
      verdicts.add(index);
    }
  }
  return verdicts;
}

/**
 * Asks the LLM which candidate pairs cover the same event, in batches.
 * A failed batch confirms nothing (fail safe), and an aborted signal stops before the next batch.
 */
export async function confirmDuplicatesWithLLM(
  complete: TextCompletion,
  candidates: DuplicateCandidate[],
  articlesById: ReadonlyMap<string, JudgeArticle>,
  signal?: AbortSignal
): Promise<ConfirmedPair[]> {
  const judgeable = candidates.filter(c => articlesById.has(c.aId) && articlesById.has(c.bId));
  const confirmed: ConfirmedPair[] = [];

  for (let offset = 0; offset < judgeable.length; offset += DUPLICATE_JUDGE_BATCH_SIZE) {
    if (signal?.aborted) break;
    const batch = judgeable.slice(offset, offset + DUPLICATE_JUDGE_BATCH_SIZE);
    const payload = batch.map((pair, index) => ({
      pair: index,
      a: describeForJudge(articlesById.get(pair.aId)!),
      b: describeForJudge(articlesById.get(pair.bId)!)
    }));

    try {
      const response = await complete(DUPLICATE_JUDGE_SYSTEM_PROMPT, JSON.stringify(payload));
      for (const index of parseDuplicateVerdicts(response, batch.length)) {
        confirmed.push({ aId: batch[index].aId, bId: batch[index].bId });
      }
    } catch (e) {
      console.error(`Duplicate judge failed for batch at offset ${offset}, leaving ${batch.length} pairs unmerged`, e);
    }
  }
  return confirmed;
}

export interface PlanMember extends ClusterMember {
  source: string;
  sources: string[];
}

export interface ClusterPlanEntry {
  clusterId: string;
  sources: string[];
}

/**
 * Resolves clusters for `members` and gives every grouped member the union of its group's sources,
 * so cross-source coverage counts toward each member's importance.
 */
export function buildClusterPlan(members: PlanMember[], confirmedPairs: ConfirmedPair[]): Map<string, ClusterPlanEntry> {
  const assignment = assignClusters(members, confirmedPairs);
  const sourcesByCluster = new Map<string, Set<string>>();
  for (const member of members) {
    const clusterId = assignment.get(member.id);
    if (!clusterId) continue;
    const set = sourcesByCluster.get(clusterId) ?? new Set<string>();
    for (const s of member.sources.length > 0 ? member.sources : [member.source]) set.add(s);
    sourcesByCluster.set(clusterId, set);
  }

  const plan = new Map<string, ClusterPlanEntry>();
  for (const [id, clusterId] of assignment) {
    plan.set(id, { clusterId, sources: Array.from(sourcesByCluster.get(clusterId) ?? []) });
  }
  return plan;
}
