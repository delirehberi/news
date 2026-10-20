#!/usr/bin/env -S node --experimental-strip-types
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEnv, type VideoEnv } from './config/env.ts';
import { assertEditionApproved, runApproveCommand } from './commands/approve.ts';
import { runScriptCommand } from './commands/script.ts';
import { runSelectCommand } from './commands/select.ts';
import { runTranslateCommand } from './commands/translate.ts';
import { runVoiceCommand } from './commands/voice.ts';
import { isValidIsoWeek, previousIsoWeek } from './lib/paths.ts';
import { createWorkerClient, type WorkerClient } from './lib/workerClient.ts';

export const CLI_COMMANDS = [
  'select',
  'translate',
  'script',
  'approve',
  'voice',
  'render',
  'upload',
  'auth',
] as const;

export type CliCommand = (typeof CLI_COMMANDS)[number];

export interface ParsedCliArgs {
  help: boolean;
  mock?: boolean;
  command?: CliCommand;
  week: string;
}

export interface CommandContext {
  week: string;
  env: VideoEnv;
  signal: AbortSignal;
  mock?: boolean;
}

export type CommandHandler = (ctx: CommandContext) => Promise<void>;

export function isCliCommand(value: string): value is CliCommand {
  return (CLI_COMMANDS as readonly string[]).includes(value);
}

export function formatHelpText(): string {
  return [
    'Usage: cli.ts <command> [--week YYYY-Www] [--help]',
    '',
    'Commands:',
    '  select      Fetch and rank weekly candidates into out/<week>/selection.json',
    '  translate   Translate selected stories into Turkish and save draft edition',
    '  script      Generate Turkish narration script (script.json + editable script.md)',
    '  approve     Validate edited script.md and mark weekly edition as approved',
    '  voice       Synthesize ElevenLabs Turkish audio and word alignments per segment',
    '  render      Bundle Remotion composition and render video.mp4 + thumbnail.png',
    '  upload      Upload rendered video and thumbnail to YouTube and publish edition',
    '  auth        Run one-time loopback YouTube PKCE OAuth flow',
    '',
    'Options:',
    '  --week <YYYY-Www>  Target ISO week (defaults to previous ISO week in UTC)',
    '  --mock             Use deterministic mock synthesis in voice command',
    '  -h, --help         Show this help message',
  ].join('\n');
}

/**
 * Parses CLI arguments (`<command>`, `--week <YYYY-Www>`, `--mock`, `--help` / `-h`).
 * Defaults `week` to `previousIsoWeek(now)`.
 */
export function parseCliArgs(
  argv: readonly string[],
  now: Date = new Date()
): ParsedCliArgs {
  let help = false;
  let mock = false;
  let command: CliCommand | undefined;
  let week: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }

    if (arg === '--mock') {
      mock = true;
      continue;
    }

    if (arg === '--week') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --week. Expected YYYY-Www (e.g. 2026-W42).');
      }
      week = next;
      i++;
      continue;
    }

    if (arg.startsWith('--week=')) {
      week = arg.slice('--week='.length);
      continue;
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}". Run with --help for usage.`);
    }

    if (!command) {
      if (!isCliCommand(arg)) {
        throw new Error(
          `Unknown command "${arg}". Valid commands: ${CLI_COMMANDS.join(', ')}`
        );
      }
      command = arg;
      continue;
    }

    throw new Error(`Unexpected positional argument "${arg}".`);
  }

  const resolvedWeek = week ?? previousIsoWeek(now);
  if (!isValidIsoWeek(resolvedWeek)) {
    throw new Error(
      `Invalid --week value "${resolvedWeek}". Expected YYYY-Www (e.g. 2026-W42).`
    );
  }

  return {
    help,
    ...(mock ? { mock: true } : {}),
    command,
    week: resolvedWeek,
  };
}

function unimplementedCommandHandler(command: CliCommand): CommandHandler {
  return async ({ week }) => {
    throw new Error(
      `Command "${command}" (target week ${week}) is not implemented yet.`
    );
  };
}

export const PRODUCTION_GATED_COMMANDS = ['voice', 'render', 'upload'] as const;
export type ProductionGatedCommand = (typeof PRODUCTION_GATED_COMMANDS)[number];

export function isProductionGatedCommand(
  command: CliCommand
): command is ProductionGatedCommand {
  return (PRODUCTION_GATED_COMMANDS as readonly string[]).includes(command);
}

function gatedProductionCommandHandler(
  step: ProductionGatedCommand,
  innerHandler: CommandHandler
): CommandHandler {
  return async (ctx) => {
    const workerClient = createWorkerClient({
      baseUrl: ctx.env.NEWS_API_BASE_URL,
      ingestionSecret: ctx.env.INGESTION_SECRET,
    });
    await assertEditionApproved(workerClient, ctx.week, step, ctx.signal);
    await innerHandler(ctx);
  };
}

export const defaultCommandHandlers: Record<CliCommand, CommandHandler> = {
  select: async (ctx) => {
    await runSelectCommand(ctx);
  },
  translate: async (ctx) => {
    await runTranslateCommand(ctx);
  },
  script: async (ctx) => {
    await runScriptCommand(ctx);
  },
  approve: async (ctx) => {
    await runApproveCommand(ctx);
  },
  voice: async (ctx) => {
    await runVoiceCommand(ctx);
  },
  render: gatedProductionCommandHandler('render', unimplementedCommandHandler('render')),
  upload: gatedProductionCommandHandler('upload', unimplementedCommandHandler('upload')),
  auth: unimplementedCommandHandler('auth'),
};

export interface RunCliOptions {
  argv: readonly string[];
  signal: AbortSignal;
  rawEnv?: Readonly<Record<string, string | undefined>>;
  dotEnvPath?: string;
  now?: Date;
  handlers?: Partial<Record<CliCommand, CommandHandler>>;
  workerClient?: WorkerClient;
  stdout?: (msg: string) => void;
}

/**
 * Executes the CLI with parsed arguments, environment validation, and shared AbortSignal.
 */
export async function runCli(options: RunCliOptions): Promise<void> {
  const stdout = options.stdout ?? ((msg: string) => console.log(msg));
  const parsed = parseCliArgs(options.argv, options.now);

  if (parsed.help || !parsed.command) {
    stdout(formatHelpText());
    return;
  }

  const dotEnvPath =
    options.dotEnvPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  const env = validateEnv(options.rawEnv ?? process.env, dotEnvPath);

  if (isProductionGatedCommand(parsed.command) && options.workerClient) {
    await assertEditionApproved(
      options.workerClient,
      parsed.week,
      parsed.command,
      options.signal
    );
  }

  const handler =
    options.handlers?.[parsed.command] ?? defaultCommandHandlers[parsed.command];

  await handler({
    week: parsed.week,
    env,
    signal: options.signal,
    ...(parsed.mock ? { mock: true } : {}),
  });
}

function registerProcessHandlers(): AbortController {
  const controller = new AbortController();

  const onSignal = (sig: NodeJS.Signals) => {
    if (!controller.signal.aborted) {
      console.error(`\nReceived ${sig}, aborting active operations...`);
      controller.abort(new Error(`Process terminated by ${sig}`));
    }
  };

  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  process.once('unhandledRejection', (reason: unknown) => {
    const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    console.error(`Unhandled promise rejection: ${message}`);
    controller.abort(reason instanceof Error ? reason : new Error(String(reason)));
    process.exitCode = 1;
  });

  process.once('uncaughtException', (err: Error) => {
    console.error(`Uncaught exception: ${err.stack ?? err.message}`);
    controller.abort(err);
    process.exitCode = 1;
  });

  return controller;
}

export function runMain(): void {
  const controller = registerProcessHandlers();
  runCli({
    argv: process.argv.slice(2),
    signal: controller.signal,
  }).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runMain();
}


