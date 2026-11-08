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
