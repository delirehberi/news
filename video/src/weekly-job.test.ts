import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(new URL('../../scripts/weekly.sh', import.meta.url));
const cronScriptPath = fileURLToPath(new URL('../../scripts/weekly-cron.sh', import.meta.url));

describe('scheduled weekly preparation and approval', () => {
  let projectRoot: string;
  let scriptCopy: string;
  let callsPath: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'weekly-job-'));
    const scriptsDir = path.join(projectRoot, 'scripts');
    const binDir = path.join(projectRoot, 'bin');
    await fs.mkdir(scriptsDir);
    await fs.mkdir(binDir);
    scriptCopy = path.join(scriptsDir, 'weekly.sh');
    callsPath = path.join(projectRoot, 'calls');
    await fs.copyFile(scriptPath, scriptCopy);
    await fs.writeFile(path.join(binDir, 'make'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$WEEKLY_TEST_CALLS"
if [[ " $* " == *" $WEEKLY_TEST_FAIL_STAGE "* && -n "$WEEKLY_TEST_FAIL_STAGE" ]]; then exit 1; fi
`, { mode: 0o700 });
    await fs.writeFile(path.join(binDir, 'notify-send'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o700 });
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  function run(action: string, week?: string, failStage = '') {
    return spawnSync('bash', [scriptCopy, action, ...(week ? [week] : [])], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${path.join(projectRoot, 'bin')}:${process.env.PATH}`,
        WEEKLY_TEST_CALLS: callsPath,
        WEEKLY_TEST_FAIL_STAGE: failStage,
      },
    });
  }

  async function pending() {
    return fs.readFile(path.join(projectRoot, 'video/out/pending-week'), 'utf8');
  }

  it('prepares a week and approves that same week without repeating its date', async () => {
    expect(run('prepare', '2026-W44').status).toBe(0);
    expect(await pending()).toBe('2026-W44\n');
    expect(run('approve').status).toBe(0);
    const calls = (await fs.readFile(callsPath, 'utf8')).trim().split('\n');
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('video-draft WEEK=2026-W44');
    expect(calls[1]).toContain('video-approve WEEK=2026-W44');
    expect(calls[2]).toContain('video-produce WEEK=2026-W44');
    await expect(pending()).rejects.toThrow();
  });

  it('preserves an unreviewed week when the next scheduled preparation runs', async () => {
    run('prepare', '2026-W44');
    expect(run('prepare', '2026-W45').status).toBe(0);
    expect(await pending()).toBe('2026-W44\n');
    expect((await fs.readFile(callsPath, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('keeps pending approval after production fails, allowing a retry', async () => {
    run('prepare', '2026-W44');
    expect(run('approve', undefined, 'video-produce').status).toBe(1);
    expect(await pending()).toBe('2026-W44\n');
    expect(run('approve').status).toBe(0);
  });

  it('does not mark a failed preparation as ready for review', async () => {
    expect(run('prepare', '2026-W44', 'video-draft').status).toBe(1);
    await expect(pending()).rejects.toThrow();
  });

  it('rejects approval without a prepared week and rejects mismatched weeks', () => {
    expect(run('approve').status).toBe(1);
    expect(run('prepare', '2026-W44').status).toBe(0);
    expect(run('approve', '2026-W45').status).toBe(1);
  });

  it('refuses to overwrite an existing script', async () => {
    const weekDir = path.join(projectRoot, 'video/out/2026-W44');
    await fs.mkdir(weekDir, { recursive: true });
    await fs.writeFile(path.join(weekDir, 'script.md'), 'Editorial changes');
    expect(run('prepare', '2026-W44').status).toBe(1);
    expect(await fs.readFile(path.join(weekDir, 'script.md'), 'utf8')).toBe('Editorial changes');
  });

  it('uses the current UTC ISO week by default', async () => {
    expect(run('prepare').status).toBe(0);
    expect(await pending()).toMatch(/^\d{4}-W\d{2}\n$/);
    expect(await fs.readFile(callsPath, 'utf8')).toContain(`WEEK=${(await pending()).trim()}`);
  });

  it('rejects invalid requested and stored week values', async () => {
    expect(run('prepare', '../other').status).toBe(1);
    await fs.writeFile(path.join(projectRoot, 'video/out/pending-week'), '../other\n');
    expect(run('approve').status).toBe(1);
  });

  it('installs one cron entry while preserving existing jobs on repeated installation', async () => {
    const cronCopy = path.join(projectRoot, 'scripts/weekly-cron.sh');
    const cronFile = path.join(projectRoot, 'crontab');
    await fs.copyFile(cronScriptPath, cronCopy);
    await fs.writeFile(cronFile, '15 2 * * * /usr/bin/true\n');
    await fs.writeFile(path.join(projectRoot, 'bin/crontab'), `#!/usr/bin/env bash
if [[ "$1" == -l ]]; then cat "$WEEKLY_TEST_CRONTAB"; else cp "$1" "$WEEKLY_TEST_CRONTAB"; fi
`, { mode: 0o700 });

    for (const attempt of [1, 2]) {
      const result = spawnSync('bash', [cronCopy], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${path.join(projectRoot, 'bin')}:${process.env.PATH}`,
          WEEKLY_TEST_CRONTAB: cronFile,
        },
      });
      expect(result.status, `Installation ${attempt}: ${result.stderr}`).toBe(0);
    }
    const cron = await fs.readFile(cronFile, 'utf8');
    expect(cron).toContain('15 2 * * * /usr/bin/true');
    expect(cron.match(/0 9 \* \* 6/g)).toHaveLength(1);
    expect(cron).toContain(`-C "${projectRoot}" prepare`);
    expect(cron).not.toContain(' approve');
  });
});

const makefilePath = fileURLToPath(new URL('../../Makefile', import.meta.url));
const repoRoot = path.dirname(makefilePath);

describe('Makefile weekly video target week validation', () => {
  function runMake(args: string[], extraEnv: Record<string, string | undefined> = {}) {
    const env = { ...process.env, ...extraEnv };
    delete env.MAKEFLAGS;
    delete env.MFLAGS;
    delete env.MAKELEVEL;
    if (!('WEEK' in extraEnv)) {
      delete env.WEEK;
    }
    return spawnSync('make', ['--no-print-directory', '-C', repoRoot, '-f', makefilePath, ...args], {
      encoding: 'utf8',
      env,
    });
  }

  it('retains the previous-week default when WEEK is omitted', () => {
    for (const target of ['video-draft', 'video-capture', 'video-approve', 'video-produce', 'shorts-draft', 'shorts-produce']) {
      const res = runMake(['-n', target]);
      expect(res.status, `${target} failed: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain('src/cli.ts');
      expect(res.stdout).not.toContain('--week');
    }
  });

  it('passes explicit WEEK=YYYY-Www to CLI and weekly scripts', () => {
    for (const target of ['video-draft', 'video-capture', 'video-approve', 'video-produce', 'shorts-draft', 'shorts-produce']) {
      const res = runMake(['-n', target, 'WEEK=2026-W44']);
      expect(res.status, `${target} failed: ${res.stderr}`).toBe(0);
      expect(res.stdout).toContain('--week 2026-W44');
    }

    const prepRes = runMake(['-n', 'prepare', 'WEEK=2026-W44']);
    expect(prepRes.status).toBe(0);
    expect(prepRes.stdout).toContain('bash scripts/weekly.sh prepare 2026-W44');

    const appRes = runMake(['-n', 'approve', 'WEEK=2026-W44']);
    expect(appRes.status).toBe(0);
    expect(appRes.stdout).toContain('bash scripts/weekly.sh approve 2026-W44');
  });

  it('fails fast with a clear WEEK=YYYY-Www instruction when given a positional week argument', () => {
    for (const [target, arg] of [
      ['video-draft', '2026-44'],
      ['video-draft', '2026-W44'],
      ['video-capture', '2026-W44'],
      ['video-approve', '2026-W44'],
      ['video-produce', '2026-W44'],
      ['shorts-draft', '2026-W44'],
      ['shorts-produce', '2026-W44'],
      ['prepare', '2026-W44'],
      ['approve', '2026-W44'],
    ] as const) {
      const res = runMake([target, arg]);
      expect(res.status).not.toBe(0);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain(`Unexpected positional argument(s) "${arg}"`);
      expect(res.stderr).toContain(`WEEK=YYYY-Www (e.g. make ${target} WEEK=2026-W44)`);
    }
  });

  it('fails fast when WEEK is malformed or contains shell metacharacters', () => {
    for (const badWeek of [
      '2026-44',
      '2026-W4',
      '2026-W00',
      '2026-W54',
      '26-W44',
      '2026-w44',
      '-2026-W44',
      '2026-W44-',
      '2026-W44 extra',
      '../other',
      '2026-W44; echo injected',
    ]) {
      const res = runMake(['video-draft', `WEEK=${badWeek}`]);
      expect(res.status, `Expected WEEK=${badWeek} to fail`).not.toBe(0);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('Expected WEEK=YYYY-Www');
    }
  });
});

