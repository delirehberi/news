import type { CommandContext } from '../cli.ts';
import {
  fromMarkdown,
  validateScriptWordBudget,
  type Script,
} from '../domain/script.ts';
import { getWeekPaths, readText, writeJsonAtomic } from '../lib/paths.ts';
import {
  createWorkerClient,
  type WeeklyEdition,
  type WorkerClient,
} from '../lib/workerClient.ts';

export interface ApproveCommandDeps {
  workerClient?: WorkerClient;
  outRoot?: string;
  stdout?: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

/**
 * Verifies that the weekly edition in the Worker is in `approved` or `published` status.
 * Throws a descriptive error if the edition does not exist or is still `draft`.
 */
export async function assertEditionApproved(
  workerClient: WorkerClient,
  week: string,
  stepName: 'voice' | 'render' | 'upload',
  signal?: AbortSignal
): Promise<WeeklyEdition> {
  const edition = await workerClient.getEdition(week, signal);
  if (!edition) {
    throw new Error(
      `Cannot run "${stepName}" for week ${week}: edition does not exist on Worker. Run "approve" first.`
    );
  }

  if (edition.status !== 'approved' && edition.status !== 'published') {
    throw new Error(
      `Cannot run "${stepName}" for week ${week}: edition status is "${edition.status}", but must be "approved" or "published". Run "approve" first.`
    );
  }

  return edition;
}

/**
 * Parses `out/<week>/script.md`, validates its structure and word budget
 * (`WORDS_MIN = 280`..`WORDS_MAX = 2000`), updates `out/<week>/script.json`,
 * and PUTs `script` and `status: 'approved'` to the Worker Admin API (publishing `/weekly/<week>`).
 */
export async function runApproveCommand(
  ctx: CommandContext,
  deps: ApproveCommandDeps = {}
): Promise<{ script: Script; wordCount: number; edition: WeeklyEdition }> {
  const stdout = deps.stdout ?? ((msg: string) => console.log(msg));
  const paths = getWeekPaths(ctx.week, deps.outRoot);

  const markdown = await readText(paths.scriptMd);
  const script = fromMarkdown(markdown, {
    onWarn: (msg) => stdout(`[warn] ${msg}`),
  });
  const wordCount = validateScriptWordBudget(script);

  await writeJsonAtomic(paths.scriptJson, script);

  const workerClient =
    deps.workerClient ??
    createWorkerClient({
      baseUrl: ctx.env.NEWS_API_BASE_URL,
      ingestionSecret: ctx.env.INGESTION_SECRET,
      fetchImpl: deps.fetchImpl,
    });

  const edition = await workerClient.putEdition(
    ctx.week,
    {
      script,
      status: 'approved',
    },
    ctx.signal
  );

  stdout(
    `Approved script (${wordCount} words, ${script.segments.length} segment(s)) for ${ctx.week}. Edition is now "${edition.status}" at /weekly/${ctx.week}.`
  );

  return { script, wordCount, edition };
}

