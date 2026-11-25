import * as fs from 'node:fs';
import * as path from 'node:path';

import type * as AppNS from '../../src/cli/app';
import type * as HandlersNS from '../../src/cli/handlers';
import type * as EventsNS from '../../src/lib/events';

interface Printed {
  argv: string[];
  code?: number;
  stdout: string;
  stderr: string;
}

/**
 * What earlier releases printed for each case of the two tables below, in table order, with
 * the argv each was recorded for: the backup and restore lines (stdout and stderr), and the
 * upgrade lines with their exit code.
 *
 * One recorded value is moved on purpose: `upgrade` with no `--to` exited 1 there and is 2
 * here (L7-07), because a missing argument is a usage error under the exit-code contract and
 * 1.x parity no longer binds the code. Its lines are unchanged.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cli', 'backup-commands.json'), 'utf8'),
) as { backupRestore: Printed[]; upgrade: Printed[] };

/**
 * The backup, restore and upgrade commands bound to the real service signatures.
 *
 * A live run caught `backup` passing `label=` after the service parameter was renamed to
 * `note=` -- invisible to every service test, because they call the service directly, and
 * to the CLI tests that only rendered `--help`. These drive the actual argv through the
 * actual command table into a stated service, and read what arrived.
 */
async function command(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const app = require('../../src/cli/app') as typeof AppNS;
  const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
  let stdout = '';
  let stderr = '';
  const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  try {
    const code = await app.runCli(argv, {
      execute: handlers.createExecutor({
        writeOut: (value) => {
          stdout += value;
        },
        writeErr: (value) => {
          stderr += value;
        },
      }),
      io: {
        writeOut: (value) => {
          stdout += value;
        },
        writeErr: (value) => {
          stderr += value;
        },
      },
    });
    return { code, stdout, stderr };
  } finally {
    write.mockRestore();
  }
}

afterEach(() => {
  jest.dontMock('../../src/core/backup');
  jest.dontMock('../../src/core/upgrade');
  jest.restoreAllMocks();
  jest.resetModules();
});

const PLAN = {
  name: 'x',
  from_version: '8.5.1',
  to_version: '8.6.1',
  rc_image: 'img',
  from_mongo: '8.0',
  to_mongo: '8.0',
  mongo_blocked: '',
  direction: 'upgrade',
  allowed: true,
  blocked_reason: '',
  warnings: [],
  oplog: false,
  source: 'map',
};

describe('backup', () => {
  it('calls the service with the arguments it accepts', async () => {
    const seen: unknown[][] = [];
    jest.doMock('../../src/core/backup', () => ({
      ...jest.requireActual('../../src/core/backup'),
      create: async (name: string, options: Record<string, unknown>) => {
        seen.push([name, { out: options.out, note: options.note, live: options.live }]);
        return {
          name,
          path: '/tmp/b.rcbak',
          bytes: 10,
          manifest: { rc_version: '8.5.1', sidecar_volumes: [] },
        };
      },
    }));
    const result = await command(['backup', '-n', 'x', '--label', 'note text', '--live']);
    expect(result.code).toBe(0);
    expect(seen).toEqual([['x', { out: '', note: 'note text', live: true }]]);
  });
});

describe('restore', () => {
  it('passes its flags through', async () => {
    const seen: Record<string, unknown>[] = [];
    jest.doMock('../../src/core/backup', () => ({
      ...jest.requireActual('../../src/core/backup'),
      restore: async (bundle: string, options: Record<string, unknown>) => {
        seen.push({ bundle, ...options });
        return {
          name: 'x',
          bundle,
          created: options.new,
          restore_seconds: 1.0,
          direction: 'same',
          from_version: '8.5.1',
          to_version: '8.5.1',
          warnings: [],
          url: '',
        };
      },
    }));
    const result = await command(['restore', '/tmp/b.rcbak', '--new', '--allow-upgrade']);
    expect(result.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect([seen[0]?.bundle, seen[0]?.new, seen[0]?.allowUpgrade]).toEqual([
      '/tmp/b.rcbak',
      true,
      true,
    ]);
  });
});

describe("the backup and restore lines, against earlier releases'", () => {
  // `backup` and `restore` over a stated service: what each prints, on which stream.
  type Bag = Record<string, unknown>;
  const made = (bundlePath: string, sidecars: string[]): Bag => ({
    name: 'alpha',
    path: bundlePath,
    bytes: 20480,
    manifest: { rc_version: '8.5.1', sidecar_volumes: sidecars },
  });
  const restored = (bundle: string, extra: Bag = {}): Bag => ({
    name: 'alpha',
    bundle,
    created: false,
    database: 'rocketchat',
    restore_seconds: 2.5,
    from_version: '8.5.1',
    to_version: '8.5.1',
    direction: 'same',
    warnings: [],
    url: 'http://localhost:3000',
    ...extra,
  });
  // [the argv, what the service returned]
  const CASES: [string[], Bag][] = [
    // Every backup's hint, two spaces after `roll back to it:`.
    [['backup', '--name', 'alpha', '--out', 'b.rcbak'], made('b.rcbak', [])],
    // A preset with named volumes, warned without a `⚠`.
    [
      ['backup', '--name', 'alpha', '--out', 'b.rcbak'],
      made('/home/u/.houston/backups/alpha.rcbak', ['grafana_data', 'minio_data']),
    ],
    // The bundle's file name, not the path it was given.
    [['restore', 'sub/b.rcbak'], restored('sub/b.rcbak')],
    // The `~`-expanded home, into a workspace newer than the data, and created.
    [
      ['restore', '~/bk/old.rcbak'],
      restored('/home/u/bk/old.rcbak', {
        created: true,
        from_version: '8.4.0',
        direction: 'upgrade',
        url: '',
      }),
    ],
    // Earlier releases drop a trailing `/` and a `.` part before they name the file.
    [['restore', 'sub/b.rcbak/'], restored('sub/b.rcbak/.')],
  ];

  it('prints every line as earlier releases did', async () => {
    expect(RECORDED.backupRestore.map((printed) => printed.argv)).toEqual(
      CASES.map(([argv]) => argv),
    );
    const recorded = RECORDED.backupRestore.map(({ stdout, stderr }) => ({ stdout, stderr }));

    const ours: { stdout: string; stderr: string }[] = [];
    for (const [argv, result] of CASES) {
      jest.resetModules();
      jest.doMock('../../src/core/backup', () => ({
        ...jest.requireActual('../../src/core/backup'),
        create: async () => result,
        restore: async () => result,
      }));
      const ran = await command(argv);
      expect(ran.code).toBe(0);
      ours.push({ stdout: ran.stdout, stderr: ran.stderr });
    }
    // All at once, so a failure shows every case that differs rather than the first.
    expect(ours).toEqual(recorded);
    // What an earlier version printed differently, named so a failure says which line regressed.
    expect(recorded[0]?.stdout).toContain(
      "\n  roll back to it:  houston restore b.rcbak   (replaces alpha's data; add --new",
    );
    expect(recorded[1]?.stdout).toContain('\n  sidecar data is NOT included: grafana_data, ');
    expect(recorded[2]?.stdout).toContain("✓ restored 'alpha' from b.rcbak in 2.5s\n");
    expect(recorded[3]?.stdout).toContain(
      "✓ created and restored 'alpha' from old.rcbak in 2.5s\n" +
        '  8.4.0 data now runs on 8.5.1 — Rocket.Chat has migrated it\n',
    );
    expect(recorded[4]?.stdout).toContain(' from b.rcbak in ');
  });
});

describe('the seconds a restore or an upgrade took', () => {
  // Earlier releases round the seconds to one decimal and print them as a float, so a
  // restore's and a boot's seconds read `1.0s` for an integral duration -- about one real
  // restore in ten. `display` of the JavaScript number printed `1s`.
  it('prints an integral restore time as 1.0s', async () => {
    jest.doMock('../../src/core/backup', () => ({
      ...jest.requireActual('../../src/core/backup'),
      restore: async (bundle: string) => ({
        name: 'x',
        bundle,
        created: false,
        restore_seconds: 1.0,
        direction: 'same',
        from_version: '8.5.1',
        to_version: '8.5.1',
        warnings: [],
        url: '',
      }),
    }));
    const result = await command(['restore', 'b.rcbak']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("✓ restored 'x' from b.rcbak in 1.0s\n");
  });

  it('prints an integral boot time as 1.0s', async () => {
    jest.doMock('../../src/core/upgrade', () => ({
      ...jest.requireActual('../../src/core/upgrade'),
      plan: async (_name: string, to: string) => ({ ...PLAN, to_version: to }),
      run: async (name: string, to: string) => ({
        name,
        from_version: '8.5.1',
        to_version: to,
        running_version: to,
        boot_seconds: 1.0,
        backup: '',
        migration_errors: [],
        warnings: [],
      }),
    }));
    const result = await command(['upgrade', '-n', 'x', '--to', '8.6.1']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("✓ 'x' upgraded 8.5.1 -> 8.6.1 in 1.0s\n");
  });
});

describe("the upgrade command's lines, against earlier releases'", () => {
  // `upgrade` over a stated plan and run: every line, its stream, and the exit code. The
  // service's seconds are a float there, so the recorded `3.0s` is what a 3 prints as.
  type Bag = Record<string, unknown>;
  const plan = (extra: Bag = {}): Bag => ({ ...PLAN, name: 'alpha', ...extra });
  const ran = (extra: Bag = {}): Bag => ({
    name: 'alpha',
    from_version: '8.5.1',
    to_version: '8.6.1',
    running_version: '8.6.1',
    boot_seconds: 41.3,
    backup: '/home/u/.houston/backups/alpha-pre-upgrade.rcbak',
    migration_errors: [],
    warnings: [],
    ...extra,
  });
  const ALREADY = {
    allowed: false,
    to_version: '8.5.1',
    blocked_reason: "'alpha' is already at 8.5.1",
  };
  const TO = (version: string, ...rest: string[]): string[] => [
    'upgrade',
    '--name',
    'alpha',
    '--to',
    version,
    ...rest,
  ];
  // [the argv, the plan, what `run` returned]
  const CASES: [string[], Bag, Bag][] = [
    // No target at all.
    [['upgrade', '--name', 'alpha'], plan(), ran()],
    // The panel's arrows, and a MongoDB tag that does not move.
    [TO('8.6.1', '--dry-run'), plan(), ran()],
    // A MongoDB minor move, and each warning as `ui.warn` writes it.
    [
      TO('8.5.1', '--dry-run'),
      plan({
        from_version: '8.1.0',
        to_version: '8.5.1',
        from_mongo: '8.2',
        to_mongo: '8.0',
        warnings: ['MongoDB minor moves 8.2 -> 8.0; the container keeps its data volume', 'TLS'],
      }),
      ran(),
    ],
    // A refusal says why, and what overrides it.
    [TO('8.5.1'), plan(ALREADY), ran()],
    // And a refused dry run is not "nothing changed".
    [TO('8.5.1', '--dry-run'), plan(ALREADY), ran()],
    // A forced plan keeps its reason, on stdout.
    [TO('8.5.1', '--dry-run', '--force'), plan(ALREADY), ran()],
    // The panel BEFORE a real upgrade, and the way back after it.
    [TO('8.6.1'), plan({ warnings: ['this workspace terminates TLS'] }), ran()],
    // The version Rocket.Chat answers with disagrees, and no backup was taken.
    [TO('8.6.1', '--no-backup'), plan(), ran({ running_version: '8.5.1', backup: '' })],
    // Migration errors under the header that counts them.
    [
      TO('8.6.1', '--no-backup'),
      plan(),
      ran({
        backup: '',
        migration_errors: ['rocketchat  | Migration 312 failed', 'rocketchat  | FATAL migration'],
      }),
    ],
    // Agreement is not printed, nor is a minor-only answer, nor an unknown one.
    [TO('8.6.1'), plan(), ran({ running_version: '8.6' })],
    [TO('8.6.1'), plan(), ran({ running_version: '?', boot_seconds: 3.0 })],
    // A forced real upgrade past a refusal says the reason before it runs.
    [TO('8.5.1', '--force'), plan(ALREADY), ran({ to_version: '8.5.1', running_version: '' })],
  ];

  it('prints every line as earlier releases did, on the same stream, with the same exit', async () => {
    expect(RECORDED.upgrade.map((printed) => printed.argv)).toEqual(CASES.map(([argv]) => argv));
    const recorded = RECORDED.upgrade.map(({ code, stdout, stderr }) => ({ code, stdout, stderr }));

    const ours: { code: number; stdout: string; stderr: string }[] = [];
    for (const [argv, planned, result] of CASES) {
      jest.resetModules();
      jest.doMock('../../src/core/upgrade', () => ({
        ...jest.requireActual('../../src/core/upgrade'),
        plan: async () => planned,
        run: async () => result,
      }));
      ours.push(await command(argv));
    }
    // All at once, so a failure shows every case that differs rather than the first.
    expect(ours).toEqual(recorded);
    // What an earlier version printed differently, named so a failure says which line regressed.
    expect(recorded[0]?.stderr).toBe(
      'error: no target version given — use `--to 8.6.1` (or `--rollback` to undo)\n',
    );
    expect(recorded[1]?.stdout).toContain('|  Rocket.Chat  8.5.1  ->  8.6.1');
    expect(recorded[1]?.stdout).toMatch(/\| {2}MongoDB {6}8\.0 +\|/u);
    expect(recorded[2]?.stdout).toContain('\n  MongoDB minor moves 8.2 -> 8.0;');
    expect(recorded[3]).toEqual({
      code: 1,
      stdout: expect.stringContaining('\n  --force overrides this, but expect it to fail\n'),
      stderr: "  'alpha' is already at 8.5.1\n",
    });
    expect(recorded[4]?.stdout).not.toContain('--dry-run: nothing changed');
    expect(recorded[5]?.stdout).toContain(
      "\n  'alpha' is already at 8.5.1\n  --dry-run: nothing changed\n",
    );
    expect(recorded[6]?.stdout).toMatch(/^\+- upgrade: alpha -+\+\n/u);
    expect(recorded[6]?.stdout).toMatch(
      / {2}roll back: {2}houston upgrade --rollback --name alpha\n$/u,
    );
    expect(recorded[7]?.stdout).toContain(
      '    but Rocket.Chat reports 8.5.1 — the upgrade did not land the image you asked for\n',
    );
    expect(recorded[8]?.stdout).toContain(
      '  2 migration error(s) in the boot log:\n      rocketchat  | Migration 312 failed\n',
    );
  });
});

describe('backups', () => {
  it('lists without crashing', async () => {
    jest.doMock('../../src/core/backup', () => ({
      ...jest.requireActual('../../src/core/backup'),
      listBackups: async () => [
        {
          path: '/tmp/a.rcbak',
          bytes: 2048,
          repro: 'x',
          label: 'note',
          rc_version: '8.5.1',
          created_at: '2026-01-01T00:00:00Z',
          error: '',
        },
      ],
    }));
    const result = await command(['backups']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('a.rcbak');
  });

  it('survives an unreadable bundle, and names it', async () => {
    jest.doMock('../../src/core/backup', () => ({
      ...jest.requireActual('../../src/core/backup'),
      listBackups: async () => [{ path: '/tmp/bad.rcbak', bytes: 1, error: 'corrupt' }],
    }));
    const result = await command(['backups']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('UNREADABLE');
  });
});

describe('upgrade', () => {
  it('requires a target', async () => {
    const result = await command(['upgrade', '-n', 'x']);
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('--to');
  });

  it('stops after the plan on --dry-run', async () => {
    const ran: unknown[] = [];
    jest.doMock('../../src/core/upgrade', () => ({
      ...jest.requireActual('../../src/core/upgrade'),
      plan: async (_name: string, to: string) => ({ ...PLAN, to_version: to }),
      run: async (...args: unknown[]) => {
        ran.push(args);
        return {};
      },
    }));
    const result = await command(['upgrade', '-n', 'x', '--to', '8.6.1', '--dry-run']);
    expect(result.code).toBe(0);
    expect(ran).toEqual([]);
  });

  it('calls run with the arguments it accepts', async () => {
    const seen: unknown[][] = [];
    jest.doMock('../../src/core/upgrade', () => ({
      ...jest.requireActual('../../src/core/upgrade'),
      plan: async (_name: string, to: string) => ({ ...PLAN, to_version: to }),
      run: async (name: string, to: string, options: Record<string, unknown>) => {
        seen.push([name, to, options.noBackup, options.rollbackOnFailure]);
        return {
          name,
          from_version: '8.5.1',
          to_version: to,
          running_version: to,
          boot_seconds: 1.0,
          backup: '/tmp/b.rcbak',
          migration_errors: [],
          warnings: [],
        };
      },
    }));
    const result = await command(['upgrade', '-n', 'x', '--to', '8.6.1', '--no-rollback']);
    expect(result.code).toBe(0);
    expect(seen).toEqual([['x', '8.6.1', false, false]]);
  });

  it("says each of the plan's warnings once, and a warning only the run raises", async () => {
    // The panel draws the plan's warnings; the run raises them again as it starts.
    const { warn } = jest.requireActual('../../src/lib/events') as typeof EventsNS;
    jest.doMock('../../src/core/upgrade', () => ({
      ...jest.requireActual('../../src/core/upgrade'),
      plan: async (_name: string, to: string) => ({
        ...PLAN,
        to_version: to,
        warnings: ['after the upgrade: sign in over HTTPS'],
      }),
      run: async (name: string, to: string, options: { emit: EventsNS.Emit }) => {
        warn(options.emit, 'after the upgrade: sign in over HTTPS', { phase: 'upgrade' });
        warn(options.emit, '--no-backup: nothing to roll back to', { phase: 'upgrade' });
        return { ...PLAN, name, to_version: to, running_version: to, boot_seconds: 1.0 };
      },
    }));
    const result = await command(['upgrade', '-n', 'x', '--to', '8.6.1']);
    const out = result.stdout + result.stderr;
    expect(result.code).toBe(0);
    expect(out.split('after the upgrade: sign in over HTTPS')).toHaveLength(2);
    expect(out.split('--no-backup: nothing to roll back to')).toHaveLength(2);
  });

  it('calls the service for --rollback', async () => {
    const seen: unknown[][] = [];
    jest.doMock('../../src/core/upgrade', () => ({
      ...jest.requireActual('../../src/core/upgrade'),
      rollback: async (name: string, options: Record<string, unknown>) => {
        seen.push([name, options.bundle]);
        return { name, rolled_back_to: '8.5.1', bundle: options.bundle, restore: {} };
      },
    }));
    const result = await command(['upgrade', '-n', 'x', '--rollback']);
    expect(result.code).toBe(0);
    expect(seen).toEqual([['x', '']]);
  });
});
