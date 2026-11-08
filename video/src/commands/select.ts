import type { CommandContext } from '../cli.ts';
import { excludeUsedStories, type ExcludedCandidate } from '../domain/history.ts';
import { rankWeekly, type RankedCandidate } from '../domain/rank.ts';
import { getWeekPaths, writeJsonAtomic } from '../lib/paths.ts';
import { createWorkerClient, type WorkerClient } from '../lib/workerClient.ts';

export interface WeeklySelection {
  week: string;
  selected_at: string;
  total_candidates: number;
  selected_count: number;
  excluded_used: ExcludedCandidate[];
  items: RankedCandidate[];
}

export interface SelectCommandDeps {
  workerClient?: WorkerClient;
  outRoot?: string;
  now?: () => Date;
  stdout?: (msg: string) => void;
}

/**
 * Fetches weekly candidates for `ctx.week` from the Worker Admin API,
 * ranks and deduplicates them up to `ctx.env.VIDEO_ITEM_COUNT`, and
 * atomically writes `out/<week>/selection.json`.
 *
 * Throws an error (causing non-zero CLI exit) when no candidates exist for the week.
 */
export async function runSelectCommand(
  ctx: CommandContext,
  deps: SelectCommandDeps = {}
): Promise<WeeklySelection> {
  const stdout = deps.stdout ?? ((msg: string) => console.log(msg));
  const nowFn = deps.now ?? (() => new Date());
  const workerClient =
    deps.workerClient ??
    createWorkerClient({
      baseUrl: ctx.env.NEWS_API_BASE_URL,
      ingestionSecret: ctx.env.INGESTION_SECRET,
    });

  const candidates = await workerClient.getCandidates(ctx.week, ctx.signal);
  if (candidates.length === 0) {
    throw new Error(
      `No weekly candidates found for week ${ctx.week}. Trigger a weekly candidate snapshot before running select.`
    );
  }

  // Drop stories already used in other approved/published weeks before ranking so the
  // configured item count is backfilled from the remaining ranked candidates.
  const used = await workerClient.getUsedStories(ctx.week, ctx.signal);
  const { eligible, excluded } = excludeUsedStories(candidates, used);
  for (const entry of excluded) {
    stdout(`Excluded already-used story ${entry.url} (${entry.reason}, used in ${entry.prior_week}: ${entry.prior_url})`);
  }

  const ranked = rankWeekly(eligible, ctx.env.VIDEO_ITEM_COUNT);
  if (ranked.length === 0) {
    throw new Error(
      `No valid ranked candidates produced for week ${ctx.week} from ${candidates.length} raw row(s) (${excluded.length} excluded as already used).`
    );
  }
  if (ranked.length < ctx.env.VIDEO_ITEM_COUNT && excluded.length > 0) {
    throw new Error(
      `Only ${ranked.length} unique candidate(s) remain for week ${ctx.week}, but ${ctx.env.VIDEO_ITEM_COUNT} are required; ${excluded.length} were excluded as already used in earlier editions.`
    );
  }

  const selection: WeeklySelection = {
    week: ctx.week,
    selected_at: nowFn().toISOString(),
    total_candidates: candidates.length,
    selected_count: ranked.length,
    excluded_used: excluded,
    items: ranked,
  };

  const paths = getWeekPaths(ctx.week, deps.outRoot);
  await writeJsonAtomic(paths.selectionJson, selection);

  stdout(
    `Selected ${selection.selected_count} of ${selection.total_candidates} candidate(s) for ${ctx.week} -> ${paths.selectionJson}`
  );

  return selection;
}

