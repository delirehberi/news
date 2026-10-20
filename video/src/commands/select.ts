import type { CommandContext } from '../cli.ts';
import { rankWeekly, type RankedCandidate } from '../domain/rank.ts';
import { getWeekPaths, writeJsonAtomic } from '../lib/paths.ts';
import { createWorkerClient, type WorkerClient } from '../lib/workerClient.ts';

export interface WeeklySelection {
  week: string;
  selected_at: string;
  total_candidates: number;
  selected_count: number;
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

  const ranked = rankWeekly(candidates, ctx.env.VIDEO_ITEM_COUNT);
  if (ranked.length === 0) {
    throw new Error(
      `No valid ranked candidates produced for week ${ctx.week} from ${candidates.length} raw row(s).`
    );
  }

  const selection: WeeklySelection = {
    week: ctx.week,
    selected_at: nowFn().toISOString(),
    total_candidates: candidates.length,
    selected_count: ranked.length,
    items: ranked,
  };

  const paths = getWeekPaths(ctx.week, deps.outRoot);
  await writeJsonAtomic(paths.selectionJson, selection);

  stdout(
    `Selected ${selection.selected_count} of ${selection.total_candidates} candidate(s) for ${ctx.week} -> ${paths.selectionJson}`
  );

  return selection;
}

