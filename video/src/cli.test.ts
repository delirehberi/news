import { describe, expect, it, vi } from 'vitest';
import { parseCliArgs, runCli } from './cli.ts';

describe('src/cli.ts', () => {
  it('defaults --week to the previous ISO week when omitted', () => {
    const now = new Date('2026-10-19T12:00:00Z'); // 2026-W43
    const parsed = parseCliArgs(['select'], now);

    expect(parsed.command).toBe('select');
    expect(parsed.week).toBe('2026-W42');
    expect(parsed.help).toBe(false);
  });

  it('parses explicit --week argument in both space and equals forms', () => {
    const parsed1 = parseCliArgs(['translate', '--week', '2026-W10']);
    expect(parsed1.command).toBe('translate');
    expect(parsed1.week).toBe('2026-W10');

    const parsed2 = parseCliArgs(['--week=2026-W11', 'approve']);
    expect(parsed2.command).toBe('approve');
    expect(parsed2.week).toBe('2026-W11');
  });

  it('rejects unknown commands or malformed weeks', () => {
    expect(() => parseCliArgs(['unknown-cmd'])).toThrowError(/Unknown command/);
    expect(() => parseCliArgs(['select', '--week', '2026-10'])).toThrowError(
      /Invalid --week value/
    );
  });

  it('prints help text without requiring environment variables when --help is passed', async () => {
    const lines: string[] = [];
    const controller = new AbortController();

    await runCli({
      argv: ['--help'],
      signal: controller.signal,
      rawEnv: {},
      stdout: (msg) => lines.push(msg),
    });

    expect(lines.join('\n')).toContain('Usage: cli.ts <command>');
  });

  it('dispatches to the matching command handler with validated env and signal', async () => {
    const controller = new AbortController();
    const selectHandler = vi.fn().mockResolvedValue(undefined);

    await runCli({
      argv: ['select', '--week', '2026-W42'],
      signal: controller.signal,
      rawEnv: { INGESTION_SECRET: 'test-secret' },
      dotEnvPath: '/nonexistent/.env',
      handlers: { select: selectHandler },
    });

    expect(selectHandler).toHaveBeenCalledTimes(1);
    expect(selectHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        week: '2026-W42',
        signal: controller.signal,
        env: expect.objectContaining({
          INGESTION_SECRET: 'test-secret',
        }),
      })
    );
  });
});

