import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type * as ContextNS from '../../src/lib/context';
import type * as ErrorsNS from '../../src/lib/errors';
import type * as PolicyNS from '../testsetup-policy';
import type * as KubeOperatorNS from '../../src/core/kube/operator';
import type * as RecordNS from '../../src/core/runner/record';
import type * as UpgradeNS from '../../src/core/upgrade';

// The namespace identity check asks the cluster, and this suite has none: it is tested on its
// own in test/core/kube/tier3.test.ts.
jest.mock('../../src/core/kube/namespace', () => ({
  ...jest.requireActual('../../src/core/kube/namespace'),
  requireOwnNamespace: async () => undefined,
}));

/** `plan`'s inputs, stubbed: a running Docker workspace `w` holding `meta`. */
function stubPlanInputs(meta: Record<string, unknown>): void {
  jest.resetModules();
  jest.doMock('../../src/core/lifecycle/naming', () => ({
    resolveName: async (n: string) => n,
    refuseAmbiguous: async () => undefined,
  }));
  jest.doMock('../../src/core/lifecycle/preconditions', () => ({
    requireEngine: async () => undefined,
  }));
  jest.doMock('../../src/core/runner/record', () => ({
    ...jest.requireActual('../../src/core/runner/record'),
    readMeta: async () => ({
      name: 'w',
      project: 'houston-w',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3000',
      hostPort: 3000,
      versionSource: 'map',
      ...meta,
    }),
  }));
  jest.doMock('../../src/core/runner/queries', () => ({
    ...jest.requireActual('../../src/core/runner/queries'),
    rcState: async () => 'running',
    containerDetails: async () => [],
  }));
  jest.doMock('../../src/core/topology', () => ({
    ...jest.requireActual('../../src/core/topology'),
    ofRepro: async () => 'docker',
  }));
}

describe('planning an upgrade', () => {
  afterEach(() => {
    jest.resetModules();
  });

  const BASE_META = {
    rcVersion: '8.5.1',
    rcImage: 'registry.rocket.chat/rocketchat/rocket.chat',
    mongoTag: '8.0',
    extra: {} as Record<string, unknown>,
  };

  /** An allowed 8.5.1 -> 8.6.1 plan on MongoDB 8.0, offline; a row overrides what moves. */
  const PLANNED = {
    name: 'w',
    from_version: '8.5.1',
    to_version: '8.6.1',
    rc_image: 'registry.rocket.chat/rocketchat/rocket.chat',
    from_mongo: '8.0',
    to_mongo: '8.0',
    mongo_blocked: '',
    direction: 'upgrade',
    allowed: true,
    blocked_reason: '',
    warnings: [],
    oplog: false,
    source: 'map (fallback)',
  };

  // The way forward is named, with flags that exist: a dump restored into a new workspace.
  const SEVEN_TO_EIGHT =
    "Rocket.Chat 8.6.1 pairs with MongoDB 8.0, but 'w' runs MongoDB 7.0. MongoDB majors " +
    'have to be stepped one at a time (7 -> 8), which houston does not do in place. To carry ' +
    'the data across: houston backup --name w, then houston up --version 8.6.1 --name w-new, ' +
    'then houston restore <bundle> --name w-new --allow-upgrade';
  // Two majors away: the refusal spells out every step, because each needs its own fCV
  // bump and guessing loses data.
  const SIX_TO_EIGHT =
    "Rocket.Chat 8.6.1 pairs with MongoDB 8.0, but 'w' runs MongoDB 6.0. MongoDB majors " +
    'have to be stepped one at a time (6 -> 7 -> 8), which houston does not do in place. To ' +
    'carry the data across: houston backup --name w, then houston up --version 8.6.1 --name ' +
    'w-new, then houston restore <bundle> --name w-new --allow-upgrade';

  it.each<[string, string, Partial<typeof BASE_META>, Record<string, unknown>]>([
    [
      'same version',
      '8.5.1',
      {},
      {
        to_version: '8.5.1',
        direction: 'same',
        allowed: false,
        blocked_reason: "'w' is already at 8.5.1",
      },
    ],
    ['a newer release', '8.6.1', {}, {}],
    [
      'an older release',
      '7.4.1',
      {},
      {
        to_version: '7.4.1',
        to_mongo: '7.0',
        mongo_blocked:
          "Rocket.Chat 7.4.1 pairs with MongoDB 7.0, but 'w' runs MongoDB 8.0. MongoDB " +
          'majors have to be stepped one at a time (), which houston does not do in place',
        direction: 'downgrade',
        allowed: false,
        blocked_reason:
          'downgrading 8.5.1 -> 7.4.1 is not supported: Rocket.Chat does not migrate a ' +
          'database backwards, so the workspace will very likely fail to boot',
        oplog: true,
      },
    ],
    [
      'a MongoDB major crossing',
      '8.6.1',
      { mongoTag: '7.0' },
      {
        from_mongo: '7.0',
        mongo_blocked: SEVEN_TO_EIGHT,
        allowed: false,
        blocked_reason: SEVEN_TO_EIGHT,
      },
    ],
    [
      'two MongoDB majors away',
      '8.6.1',
      { mongoTag: '6.0' },
      {
        from_mongo: '6.0',
        mongo_blocked: SIX_TO_EIGHT,
        allowed: false,
        blocked_reason: SIX_TO_EIGHT,
      },
    ],
    [
      'a MongoDB minor move',
      '8.6.1',
      { mongoTag: '8.1' },
      {
        from_mongo: '8.1',
        warnings: [
          'MongoDB minor moves 8.1 -> 8.0; the container keeps its data volume and is not ' +
            'recreated by this upgrade',
        ],
      },
    ],
    [
      'an unreadable current version',
      '8.6.1',
      { rcVersion: 'nightly' },
      {
        from_version: 'nightly',
        direction: 'same',
        warnings: ["cannot compare 'nightly' with '8.6.1'; proceeding blind"],
      },
    ],
    [
      'a TLS workspace',
      '8.6.1',
      { extra: { tls: true } },
      {
        warnings: [
          'this workspace terminates TLS; its certificate and Traefik configuration are left ' +
            'exactly as they are',
        ],
      },
    ],
  ])('plans %s', async (_label, to, overrides, expected) => {
    stubPlanInputs({ ...BASE_META, ...overrides });
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    expect(await upgrade.plan('w', to, { offline: true })).toEqual({ ...PLANNED, ...expected });
  });

  it('keeps a MongoDB the target still runs on: 7.12 -> 7.13 on 7.0', async () => {
    // The map pairs a FRESH 7.13 with 8.0, and the plan demanded that move: "(7 -> 8)",
    // although 7.13 runs on 7.0 and an upgrade only replaces Rocket.Chat.
    stubPlanInputs({ ...BASE_META, rcVersion: '7.12.0', mongoTag: '7.0' });
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const planned = await upgrade.plan('w', '7.13.0', { offline: true });
    expect(planned).toMatchObject({ allowed: true, to_mongo: '7.0', mongo_blocked: '' });
    expect(planned.warnings).toContain(
      'MongoDB stays at 7.0: Rocket.Chat 7.13.0 runs on it (a new 7.13.0 workspace would get 8.0)',
    );
  });

  it("says what 9.0 will ask of an oidc workspace's sign-in, before the upgrade and once", async () => {
    // An http oidc workspace upgraded 8.9.1 -> 9.0.0 came up with a sign-in that returns to
    // the login page and a licence gate, and nothing said so until someone tried it.
    const { load } = jest.requireActual<{ load: (n: string) => { postReady: unknown[] } }>(
      '../../src/lib/presets/index',
    );
    const oidc = {
      preset: 'oidc',
      extra: { runtime: 'docker', post_ready: load('oidc').postReady },
    };
    stubPlanInputs({ ...BASE_META, rcVersion: '8.9.1', ...oidc });
    let upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const warnings = (await upgrade.plan('w', '9.0.0', { offline: true })).warnings as string[];
    expect(warnings.join('\n')).toContain(
      'after the upgrade to 9.0.0: Rocket.Chat 9.0 and later refuse Custom OAuth sign-in',
    );
    // On 9.0.x one line: neither plain http nor houston's HTTPS finishes it, so no rebuild advice.
    expect(warnings.join('\n')).toContain(
      'after the upgrade to 9.0.0: Rocket.Chat 9.0 cannot finish this OAuth sign-in through houston',
    );
    expect(warnings.join('\n')).not.toContain('Rebuild it');
    // Already on 9.0: its notes say it, so a patch upgrade does not repeat it.
    stubPlanInputs({ ...BASE_META, rcVersion: '9.0.0', ...oidc });
    upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    expect((await upgrade.plan('w', '9.0.1', { offline: true })).warnings).toEqual([]);
  });

  it('refuses a version releases.rocket.chat does not have', async () => {
    // From the map alone any x.y.z in a known series looked real: the GUI planned, and
    // enabled, an upgrade to 8.99.0 that would have taken a backup and failed on the pull.
    stubPlanInputs(BASE_META);
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const planned = await upgrade.plan('w', '8.99.0', {
      fetcher: () => ({ status: 404, json: () => ({}) }),
    });
    expect(planned.allowed).toBe(false);
    expect(String(planned.blocked_reason)).toContain('releases.rocket.chat has no 8.99.0');
  });

  it('says what a CI build needs, not flags upgrade does not have', async () => {
    // The refusal offered `--rc-image ... --version ...`, which are `up`'s flags.
    stubPlanInputs(BASE_META);
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const refusal = upgrade.plan('w', 'develop', { offline: true });
    await expect(refusal).rejects.toThrow('needs the network: run the upgrade without --offline');
    await expect(upgrade.plan('w', 'develop', { offline: true })).rejects.not.toThrow('--rc-image');
  });

  it('refuses a garbage target as a validation error', async () => {
    stubPlanInputs(BASE_META);
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const errors = require('../../src/lib/errors') as typeof ErrorsNS;
    const refusal = upgrade.plan('w', 'not-a-version', { offline: true });
    await expect(refusal).rejects.toBeInstanceOf(errors.ValidationError);
    await expect(refusal).rejects.toThrow(
      "'not-a-version' is not a valid version (want e.g. 6.5.3)",
    );
  });

  it('names the port-forward a Kubernetes workspace would need, not Docker', async () => {
    // `require_running` used `require_docker()` above the resolve, so an upgrade of a
    // Kubernetes workspace on a Docker-less host refused with "Docker isn't running".
    jest.resetModules();
    jest.doMock('../../src/core/lifecycle/naming', () => ({
      resolveName: async (n: string) => n,
      refuseAmbiguous: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      requireEngine: async () => undefined,
    }));
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => 'kubernetes',
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => ({
        name: 'k',
        rcVersion: '8.5.1',
        mongoTag: '8.0',
        extra: { runtime: 'kubernetes' },
      }),
    }));
    jest.doMock('../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../src/core/runner/queries'),
      rcState: async () => 'absent',
    }));
    jest.doMock('../../src/core/kube/status', () => ({ workloadExists: async () => false }));
    jest.doMock('../../src/core/kube/names', () => ({ CONTEXT: 'kind-houston-local' }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    let mine: unknown;
    try {
      await upgrade.requireRunning('k');
      mine = null;
    } catch (exc) {
      mine = { kind: (exc as Error).constructor.name, message: (exc as Error).message };
    }
    expect((mine as { message: string }).message).toContain('houston start');
    expect((mine as { message: string }).message).not.toContain('Docker');
    expect(mine).toEqual({
      kind: 'NotReadyError',
      message:
        "'k' is not running. Upgrades run Rocket.Chat's migrations on boot and the " +
        'pre-upgrade backup needs MongoDB up: `houston start --name k`',
    });
  });
});

describe('the image rewrite', () => {
  it.each([
    [
      'every Rocket.Chat service, and the oplog variable dropped from a list',
      {
        services: {
          'rocketchat-2': { image: 'old', environment: { PORT: '3000' } },
          rocketchat: { image: 'old', environment: ['MONGO_OPLOG_URL=x', 'KEEP=1'] },
          mongodb: { image: 'mongo' },
        },
      },
      false,
      2,
      {
        services: {
          'rocketchat-2': { image: 'registry.example/rc:8.6.1', environment: { PORT: '3000' } },
          rocketchat: { image: 'registry.example/rc:8.6.1', environment: { KEEP: '1' } },
          mongodb: { image: 'mongo' },
        },
      },
    ],
    [
      'the oplog variable added to a mapping',
      { services: { rocketchat: { image: 'old', environment: { KEEP: '1' } } } },
      true,
      1,
      {
        services: {
          rocketchat: {
            image: 'registry.example/rc:8.6.1',
            environment: {
              KEEP: '1',
              MONGO_OPLOG_URL: 'mongodb://mongodb:27017/local?replicaSet=rs0',
            },
          },
        },
      },
    ],
    [
      'no Rocket.Chat service',
      { services: { mongodb: {} } },
      true,
      0,
      { services: { mongodb: {} } },
    ],
    ['no services at all', { services: {} }, false, 0, { services: {} }],
  ])('rewrites %s', (_label, doc, oplog, changed, expected) => {
    const { applyImage } = require('../../src/core/upgrade') as typeof UpgradeNS;
    const edited = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
    expect(applyImage(edited, 'registry.example/rc', '8.6.1', oplog)).toBe(changed);
    expect(edited).toEqual(expected);
  });
});

describe('an image that already names its tag', () => {
  it('is applied as given, never as repo:tag:version', () => {
    const { applyImage } = require('../../src/core/upgrade') as typeof UpgradeNS;
    const doc = { services: { rocketchat: { image: 'old' }, 'rocketchat-2': { image: 'old' } } };
    applyImage(doc, 'ghcr.io/rocketchat/rocket.chat:develop', '8.10.0.dev0', false);
    expect(Object.values(doc.services).map((svc) => svc.image)).toEqual([
      'ghcr.io/rocketchat/rocket.chat:develop',
      'ghcr.io/rocketchat/rocket.chat:develop',
    ]);
  });
});

describe('the migration-error filter', () => {
  afterEach(() => {
    jest.dontMock('../../src/core/topology');
    jest.dontMock('../../src/core/runner/engine');
    jest.resetModules();
  });

  it('keeps every line naming both an error and a migration', async () => {
    const LOG = [
      'Starting Rocket.Chat',
      'Migrations: 12 applied',
      'ERROR migration 5 failed: duplicate key',
      'FATAL: a migration could not run',
      'migration error: bad document',
      'MIGRATION FAILED on 3',
      'unrelated error on migrationless line',
      'error while processing migration batch 9',
    ].join('\n');
    jest.resetModules();
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => 'docker',
    }));
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../src/core/runner/engine'),
      composeLogsCapture: async () => LOG,
      stopServices: async () => 0,
      up: async () => 0,
    }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    expect(await upgrade.migrationErrors('w')).toEqual([
      'ERROR migration 5 failed: duplicate key',
      'FATAL: a migration could not run',
      'migration error: bad document',
      'MIGRATION FAILED on 3',
      'unrelated error on migrationless line',
      'error while processing migration batch 9',
    ]);
  });

  it("reads Rocket.Chat's own logs, every instance of it, and not Grafana's", async () => {
    // Every service's logs were read, and Grafana logs `msg="Migration successfully executed"
    // id="add snapshot error_string column"` at info level on each start: a clean upgrade
    // with monitoring reported four "migration error(s)", all of them Grafana's.
    const LOGS: Record<string, string> = {
      grafana:
        'grafana-1  | logger=migrator level=info msg="Migration successfully executed" ' +
        'id="add snapshot error_string column"',
      'rocketchat-1': 'rocketchat-1-1  | Migration 312 failed',
      'rocketchat-2': 'rocketchat-2-1  | FATAL migration',
    };
    jest.resetModules();
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => 'docker',
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      rcServices: async () => ['rocketchat-1', 'rocketchat-2'],
    }));
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../src/core/runner/engine'),
      // As `docker compose logs [SERVICE...]` answers: no service named is every service.
      composeLogsCapture: async (
        _name: string,
        { services = [] }: { services?: readonly string[] } = {},
      ) =>
        Object.entries(LOGS)
          .filter(([service]) => services.length === 0 || services.includes(service))
          .map(([, line]) => line)
          .join('\n'),
    }));
    try {
      const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
      expect(await upgrade.migrationErrors('w')).toEqual([
        'rocketchat-1-1  | Migration 312 failed',
        'rocketchat-2-1  | FATAL migration',
      ]);
    } finally {
      jest.dontMock('../../src/core/runner/record');
    }
  });
});

describe('when an upgrade cannot be offered', () => {
  it('answers can_upgrade false with the refusal as the reason', async () => {
    jest.resetModules();
    const { NotFoundError } = require('../../src/lib/errors') as typeof ErrorsNS;
    jest.doMock('../../src/core/lifecycle/naming', () => ({
      resolveName: async () => {
        throw new NotFoundError('no workspace named');
      },
    }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const result = await upgrade.canUpgrade('nope');
    expect(result['can_upgrade']).toBe(false);
    expect(String(result['reason'])).toContain('no workspace named');
    expect(result['current']).toBe('');
  });
});

describe('running an upgrade', () => {
  afterEach(() => {
    jest.resetModules();
  });

  interface RunResult {
    order: string[];
    meta: Record<string, unknown>;
    result: Record<string, unknown> | null;
    error: string | null;
  }

  function prepareWorkspace(): void {
    const paths = jest.requireActual('../../src/core/runner/paths') as {
      workspace: (n: string) => string;
    };
    const fs = jest.requireActual('node:fs') as {
      mkdirSync: (p: string, o: { recursive: boolean }) => void;
      writeFileSync: (p: string, body: string, enc: string) => void;
    };
    const path = jest.requireActual('node:path') as { join: (...parts: string[]) => string };
    fs.mkdirSync(paths.workspace('w'), { recursive: true });
    fs.writeFileSync(
      path.join(paths.workspace('w'), 'docker-compose.yml'),
      'services: {}\n',
      'utf8',
    );
  }

  async function runTypescript(
    fail: boolean,
    noBackup = false,
    failRestore = false,
    fakeClock = false,
    stopRc = 0,
  ): Promise<RunResult & { recordedExtra: Record<string, unknown> | undefined }> {
    jest.resetModules();
    if (fakeClock) {
      jest.spyOn(performance, 'now').mockReturnValueOnce(100_000).mockReturnValueOnce(101_250);
    }
    const order: string[] = [];
    let writersRunning = true;
    const recorded: Record<string, unknown> = {};
    const meta: Record<string, unknown> = {
      name: 'w',
      project: 'houston-w',
      rcVersion: '8.5.1',
      rcImage: 'registry.rocket.chat/rocketchat/rocket.chat',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3000',
      hostPort: 3000,
      versionSource: 'map',
      extra: { last_upgrade_backup: '/tmp/stale.rcbak', upgraded_from: '8.0.0' },
    };
    const doc = { services: { rocketchat: { image: 'old', environment: { KEEP: '1' } } } };

    jest.doMock('../../src/core/lifecycle/naming', () => ({
      resolveName: async (n: string) => n,
      refuseAmbiguous: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      requireEngine: async () => undefined,
    }));
    jest.doMock('../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../src/core/runner/queries'),
      rcState: async () => 'running',
      containerDetails: async () => [],
      runningWriterServices: async () => (writersRunning ? ['rocketchat'] : []),
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => meta,
      readCompose: async () => doc,
      rcServices: async () => ['rocketchat'],
      write: async (_n: string, yaml: string, m: { extra: Record<string, unknown> }) => {
        order.push('write');
        recorded['yaml'] = yaml;
        recorded['extra'] = { ...m.extra };
      },
    }));
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => 'docker',
    }));
    jest.doMock('../../src/core/backup', () => ({
      ...jest.requireActual('../../src/core/backup'),
      createLocked: async () => {
        order.push('backup');
        return { path: '/tmp/pre.rcbak' };
      },
      restoreLocked: async () => {
        order.push('restore');
        if (failRestore) throw new Error('restore broke');
        return { name: 'w' };
      },
      readManifest: async () => ({ schema: 1 }),
    }));
    let upCalls = 0;
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../src/core/runner/engine'),
      stopServices: async () => {
        order.push('stopServices');
        if (stopRc === 0) writersRunning = false;
        return stopRc;
      },
      startServices: async () => {
        order.push('startServices');
        writersRunning = true;
        return 0;
      },
      up: async () => {
        upCalls += 1;
        order.push('up');
        return fail && upCalls === 1 ? 1 : 0;
      },
      composeLogsCapture: async () => '',
    }));
    jest.doMock('../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../src/core/lifecycle/ready'),
      waitAndFinalize: async () => {
        order.push('waitAndFinalize');
        return { url: 'http://localhost:3000' };
      },
    }));
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      apiInfo: async () => ({ version: '8.6.1' }),
      getSetting: async () => true,
    }));

    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    let result: Record<string, unknown> | null = null;
    let error: string | null = null;
    try {
      result = await upgrade.runLocked('w', '8.6.1', {
        offline: true,
        force: false,
        noBackup,
        rollbackOnFailure: true,
        emit: (() => undefined) as never,
      });
    } catch (exc) {
      error = `${(exc as Error).constructor.name}: ${(exc as Error).message}`;
    }
    const extra = meta.extra as Record<string, unknown>;
    return {
      order,
      meta: {
        rc_version: meta.rcVersion,
        rc_image: meta.rcImage,
        extra: Object.fromEntries(
          Object.entries(extra).filter(([key]) => key !== 'last_upgrade_backup'),
        ),
      },
      result:
        result === null
          ? null
          : {
              from_version: result.from_version,
              to_version: result.to_version,
              running_version: result.running_version,
              backup: result.backup,
              migration_errors: result.migration_errors,
              ...(fakeClock ? { boot_seconds: result.boot_seconds } : {}),
            },
      error,
      recordedExtra: recorded['extra'] as Record<string, unknown> | undefined,
    } as unknown as RunResult & { recordedExtra: Record<string, unknown> | undefined };
  }

  it('refuses a returned writer-stop failure before changing the image or record', async () => {
    prepareWorkspace();
    const mine = await runTypescript(false, false, false, false, 47);
    expect(mine.error).toMatch(/could not stop Rocket.Chat writers/u);
    expect(mine.order).toEqual(['backup', 'stopServices', 'startServices']);
    expect(mine.meta.rc_version).toBe('8.5.1');
    expect(mine.result).toBeNull();
  });

  it('backs up, stops, rewrites and recreates, in that order', async () => {
    prepareWorkspace();
    const mine = await runTypescript(false);
    expect(mine.order).toEqual(['backup', 'stopServices', 'write', 'up', 'waitAndFinalize']);
    expect(mine.meta).toEqual({
      rc_version: '8.6.1',
      rc_image: 'registry.rocket.chat/rocketchat/rocket.chat',
      extra: { upgraded_from: '8.5.1' },
    });
    expect(mine.result).toEqual({
      from_version: '8.5.1',
      to_version: '8.6.1',
      running_version: '8.6.1',
      backup: '/tmp/pre.rcbak',
      migration_errors: [],
    });
    expect(mine.error).toBeNull();
    // The one side effect the result does not carry: the recorded pre-upgrade bundle.
    expect(mine.recordedExtra).toEqual({
      last_upgrade_backup: '/tmp/pre.rcbak',
      upgraded_from: '8.5.1',
    });
  });

  it('rolls back the compose document and the record when `up` fails', async () => {
    prepareWorkspace();
    const mine = await runTypescript(true);
    expect(mine.order).toEqual(['backup', 'stopServices', 'write', 'up', 'write', 'up', 'restore']);
    expect(mine.meta).toEqual({
      rc_version: '8.5.1',
      rc_image: 'registry.rocket.chat/rocketchat/rocket.chat',
      extra: {},
    });
    expect(mine.result).toBeNull();
    expect(mine.error).toBe(
      'DockerError: upgrade to 8.6.1 failed and was rolled back to 8.5.1: ' +
        '`docker compose up` failed applying the new image',
    );
    expect(mine.recordedExtra).toEqual({ last_upgrade_backup: '/tmp/pre.rcbak' });
  });

  it('reports both faults and the bundle when the rollback restore itself fails', async () => {
    // The worst case: `up` failed and the rollback's own restore failed. The message must
    // name BOTH, and the bundle the operator can recover from -- letting the rollback's
    // error propagate would hide why the upgrade failed while leaving the workspace in a
    // state that is neither version.
    prepareWorkspace();
    const mine = await runTypescript(true, false, true);
    expect(mine.result).toBeNull();
    expect(String(mine.error)).toContain('restore broke');
    expect(String(mine.error)).toContain('indeterminate state');
    expect(mine.order).toEqual(['backup', 'stopServices', 'write', 'up', 'write', 'up', 'restore']);
    expect(mine.error).toBe(
      'DockerError: upgrade to 8.6.1 failed (`docker compose up` failed applying the new ' +
        "image) AND the rollback failed (restore broke). 'w' is now in an indeterminate " +
        'state; its pre-upgrade backup is at /tmp/pre.rcbak - restore it with ' +
        '`houston restore /tmp/pre.rcbak --force`.',
    );
  });

  it('measures with a monotonic clock and rounds half to even', async () => {
    // `round(time.monotonic() - started, 1)`: a 1.25s duration is 1.2 (half to EVEN)
    // where `Math.round` gives 1.3, and the clock cannot step backwards.
    prepareWorkspace();
    const mine = await runTypescript(false, false, false, true);
    expect((mine.result as Record<string, unknown>)['boot_seconds']).toBe(1.2);
    expect(mine.result).toEqual({
      from_version: '8.5.1',
      to_version: '8.6.1',
      running_version: '8.6.1',
      backup: '/tmp/pre.rcbak',
      migration_errors: [],
      boot_seconds: 1.2,
    });
  });

  it('clears the recorded pre-upgrade bundle when --no-backup is used', async () => {
    // `--no-backup` used to leave the PREVIOUS upgrade's bundle recorded while
    // `upgraded_from` was updated regardless -- and a later `--rollback` then restored it
    // with force, so "undo the last upgrade" landed on data two versions back.
    prepareWorkspace();
    const mine = await runTypescript(false, true);
    expect(mine.order).not.toContain('backup');
    expect(mine.recordedExtra?.['last_upgrade_backup']).toBeUndefined();
    expect(mine.recordedExtra?.['upgraded_from']).toBe('8.5.1');
    expect(mine.order).toEqual(['stopServices', 'write', 'up', 'waitAndFinalize']);
    expect(mine.meta).toEqual({
      rc_version: '8.6.1',
      rc_image: 'registry.rocket.chat/rocketchat/rocket.chat',
      extra: { upgraded_from: '8.5.1' },
    });
    expect(mine.recordedExtra).toEqual({ upgraded_from: '8.5.1' });
  });
});

describe('the duration an upgrade reports', () => {
  const MOCKED = [
    '../../src/core/topology',
    '../../src/core/runner/engine',
    '../../src/core/rcapi',
  ];

  afterEach(() => {
    for (const id of MOCKED) jest.dontMock(id);
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('says an integral duration as earlier releases do, 3.0s and not 3s', async () => {
    // The elapsed time is rounded to one decimal and keeps its point, so 3.0 is `3.0`.
    // `String` of the JavaScript number printed `3s` in the `done` event.
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => 'docker',
    }));
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../src/core/runner/engine'),
      composeLogsCapture: async () => '',
    }));
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      apiInfo: async () => ({ version: '8.6.1' }),
    }));
    const record = jest.requireActual('../../src/core/runner/record') as typeof RecordNS;
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const meta = record.metadata({
      name: 'w',
      project: 'houston-w',
      rcVersion: '8.5.1',
      rcImage: 'registry.rocket.chat/rocketchat/rocket.chat',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3000',
      hostPort: 3000,
      versionSource: 'map',
    });
    jest.spyOn(performance, 'now').mockReturnValue(103_000);
    const seen: string[] = [];
    const mine = await upgrade.confirmTheUpgrade(
      ((event: { message: string }) => void seen.push(event.message)) as never,
      meta,
      { to_version: '8.6.1' },
      100_000,
      'w',
    );

    expect(mine.elapsed).toBe(3);
    expect(seen).toContain("'w' upgraded to 8.6.1 in 3.0s");
    expect(seen).toEqual(["'w' upgraded to 8.6.1 in 3.0s"]);
  });
});

describe('the values.yaml a Kubernetes upgrade rewrites', () => {
  afterEach(() => {
    jest.resetModules();
  });

  const VALUES = (tag: string, chart: string) =>
    'image:\n  repository: registry.rocket.chat/rocketchat/rocket.chat\n' +
    `  tag: ${tag}\n` +
    'extraEnv:\n- name: OVERWRITE_SETTING_Show_Setup_Wizard\n  value: completed\n' +
    "- name: FEATURE\n  value: 'no'\n" +
    "- name: NOTE\n  value: 'a value long enough that writer folds it a value long enough that writer\n" +
    "    folds it a value long enough that writer folds it '\n" +
    "mongodb:\n  enabled: false\n  image:\n    tag: '8.0'\n" +
    `_chart_version: ${chart}\n`;
  const IMAGE =
    'image:\n  repository: registry.rocket.chat/rocketchat/rocket.chat\n  tag: 8.6.1\n' +
    '_chart_version: 6.29.0\n';

  it.each([
    // What `up` records for a real workspace: an env list, a YAML 1.1 boolean word as a
    // string -- the misread an earlier version caused was `'no'` back as a boolean -- and a
    // value long enough to fold.
    ['a recorded workspace', VALUES('8.5.1', '6.28.0'), VALUES('8.6.1', '6.29.0')],
    // No image yet, a date, and a key that is not a string: each written back as read.
    ['no image yet', 'a: 2026-01-01\n1: one\n', `a: 2026-01-01\n1: one\n${IMAGE}`],
    // Nothing at all is an empty mapping.
    ['an empty file', '', IMAGE],
  ])('reads and writes %s as earlier releases do', (_label, input, output) => {
    const paths = require('../../src/core/runner/paths') as { workspace: (n: string) => string };
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const file = path.join(paths.workspace('w'), 'kubernetes', 'values.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, input, 'utf8');
    upgrade.recordNewTag('w', 'registry.rocket.chat/rocketchat/rocket.chat', '8.6.1', '6.29.0');
    expect(fs.readFileSync(file, 'utf8')).toBe(output);
  });

  it('refuses a non-mapping document where a mapping is needed, in recorded words', async () => {
    // What the caller warns with: a TypeError saying what each document held where a
    // mapping belongs.
    const paths = require('../../src/core/runner/paths') as { workspace: (n: string) => string };
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const file = path.join(paths.workspace('w'), 'kubernetes', 'values.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const ours = ['image: null\n', '- a\n', 'image:\n- a\n', 'image: foo\n'].map((input) => {
      fs.writeFileSync(file, input, 'utf8');
      try {
        upgrade.recordNewTag('w', 'registry.rocket.chat/rocketchat/rocket.chat', '8.6.1', '6.29.0');
        return { input, text: fs.readFileSync(file, 'utf8') };
      } catch (exc) {
        return { input, error: (exc as Error).message };
      }
    });
    expect(ours.map(({ error }) => error)).toEqual([
      'expected a mapping, got null',
      'expected a mapping, got a list',
      'expected a mapping, got a list',
      'expected a mapping, got a string',
    ]);
  });
});

describe("the refusal text when a version's resolver fails", () => {
  afterEach(() => {
    // A registered factory survives `resetModules`; without this the throwing resolver
    // below leaks into every later test in this file.
    jest.unmock('../../src/lib/versions');
    jest.resetModules();
  });

  it('lets anything but InvalidVersionError through', async () => {
    // Only an `InvalidVersionError` from the version resolver is a refusal. An earlier version that
    // caught everything retyped a programmer error as a 400.
    jest.resetModules();
    jest.doMock('../../src/core/lifecycle/naming', () => ({
      resolveName: async (n: string) => n,
      refuseAmbiguous: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      requireEngine: async () => undefined,
    }));
    jest.doMock('../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../src/core/runner/queries'),
      rcState: async () => 'running',
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => ({
        name: 'w',
        rcVersion: '8.5.1',
        mongoTag: '8.0',
        extra: {},
      }),
    }));
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => 'docker',
    }));
    jest.doMock('../../src/lib/versions', () => ({
      ...jest.requireActual('../../src/lib/versions'),
      resolve: () => {
        throw new TypeError('a programmer error, not a version');
      },
    }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    let mine: { ok: boolean; kind?: string; message?: string };
    try {
      await upgrade.plan('w', '8.6.1', { offline: true });
      mine = { ok: true };
    } catch (exc) {
      mine = { ok: false, kind: (exc as Error).constructor.name, message: (exc as Error).message };
    }
    expect(mine.ok).toBe(false);
    expect(mine.kind).toBe('TypeError');
    expect(mine.message).toBe('a programmer error, not a version');
  });
});

describe('the refusal-or-warning gate', () => {
  afterEach(() => {
    jest.resetModules();
  });

  async function gate(
    rc: string,
    mongo: string,
    to: string,
    force: boolean,
  ): Promise<{ answer: unknown; events: { message: string; level: string }[] }> {
    stubPlanInputs({ rcVersion: rc, rcImage: 'i', mongoTag: mongo, extra: {} });
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const events: { message: string; level: string }[] = [];
    try {
      const p = await upgrade.refuseOrWarn(
        ((event: { message: string; level: string }) => {
          events.push({ message: event.message, level: event.level });
        }) as never,
        force,
        true,
        'w',
        to,
      );
      return {
        answer: {
          allowed: p['allowed'],
          blocked: p['blocked_reason'],
          mongo_blocked: p['mongo_blocked'],
        },
        events,
      };
    } catch (exc) {
      return {
        answer: { kind: (exc as Error).constructor.name, message: (exc as Error).message },
        events,
      };
    }
  }

  const CROSSING =
    "Rocket.Chat 8.6.1 pairs with MongoDB 8.0, but 'w' runs MongoDB 7.0. MongoDB majors " +
    'have to be stepped one at a time (7 -> 8), which houston does not do in place. To carry ' +
    'the data across: houston backup --name w, then houston up --version 8.6.1 --name w-new, ' +
    'then houston restore <bundle> --name w-new --allow-upgrade';

  it('refuses the same version unless forced', async () => {
    expect(await gate('8.5.1', '8.0', '8.5.1', false)).toEqual({
      answer: {
        kind: 'ValidationError',
        message: "'w' is already at 8.5.1. Pass --force to try anyway.",
      },
      events: [],
    });
  });

  it('lets the same version through when forced, silently', async () => {
    expect(await gate('8.5.1', '8.0', '8.5.1', true)).toEqual({
      answer: { allowed: false, blocked: "'w' is already at 8.5.1", mongo_blocked: '' },
      events: [],
    });
  });

  it('refuses a MongoDB major crossing unless forced', async () => {
    expect(await gate('8.5.1', '7.0', '8.6.1', false)).toEqual({
      // Not "try anyway": --force does something else here, and says so.
      answer: {
        kind: 'ValidationError',
        message: `${CROSSING}. \`--force\` upgrades Rocket.Chat only and leaves MongoDB where it is.`,
      },
      events: [],
    });
  });

  it('lets a forced MongoDB major crossing through with a warning', async () => {
    expect(await gate('8.5.1', '7.0', '8.6.1', true)).toEqual({
      answer: { allowed: false, blocked: CROSSING, mongo_blocked: CROSSING },
      events: [
        {
          message:
            `--force: upgrading Rocket.Chat ONLY. ${CROSSING}. MongoDB stays at its current ` +
            'version and the record keeps naming it, so this workspace is a combination ' +
            'houston does not pair by itself.',
          level: 'warn',
        },
      ],
    });
  });
});

describe('rolling back without a recorded bundle', () => {
  afterEach(() => {
    jest.dontMock('../../src/core/lifecycle/ownership');
    jest.resetModules();
  });

  it('refuses, naming --bundle and `houston backups`', async () => {
    jest.resetModules();
    jest.doMock('../../src/core/lifecycle/naming', () => ({
      resolveName: async (n: string) => n,
      refuseAmbiguous: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      requireEngine: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/ownership', () => ({
      mayDestroy: async () => [true, ''],
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => ({
        name: 'w',
        rcVersion: '8.5.1',
        rcImage: 'i',
        mongoTag: '8.0',
        extra: {},
      }),
    }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const errors = require('../../src/lib/errors') as typeof ErrorsNS;
    const refusal = upgrade.rollback('w');
    await expect(refusal).rejects.toBeInstanceOf(errors.ValidationError);
    await expect(refusal).rejects.toThrow(
      "no pre-upgrade backup recorded for 'w'; pass one explicitly with --bundle, or see " +
        '`houston backups`',
    );
  });
});

describe('rolling a Kubernetes rollback back', () => {
  it('does not add the oplog variable for a version nobody can parse', async () => {
    // Only a version that parses and is below 8 is a pre-8 release -- an unparseable one is
    // NOT a pre-8 release, and treating it as one added MONGO_OPLOG_URL to a workspace
    // whose version nobody can name.
    jest.resetModules();
    const options: Record<string, unknown>[] = [];
    jest.doMock('../../src/core/kube/names', () => ({ CONTEXT: 'kind-houston-local' }));
    jest.doMock('../../src/core/kube/namespace', () => ({
      namespaceFor: async (n: string) => `houston-${n}`,
    }));
    jest.doMock('../../src/core/kube/chart', () => ({
      resolveChartVersion: async () => 'chart-1',
    }));
    // A tagless image, as the real one splits it: the tag is the version.
    jest.doMock('../../src/core/kube/manifests', () => ({
      splitImage: (_image: string, version: string) => ['repo', version],
    }));
    jest.doMock('../../src/core/kube/release', () => ({
      upgradeImage: async (opts: Record<string, unknown>) => {
        options.push(opts);
      },
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => ({ name: 'w', extra: {} }),
      updateMeta: async (_n: string, mutate: (m: { extra: Record<string, unknown> }) => void) => {
        mutate({ extra: {} });
      },
    }));
    jest.doMock('../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../src/core/lifecycle/ready'),
      waitAndFinalize: async () => ({}),
    }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    await upgrade.rollbackKubernetes(
      'w',
      { rcVersion: 'garbage', rcImage: 'img' },
      '',
      (() => undefined) as never,
    );
    expect(options).toHaveLength(1);
    expect(options[0]?.oplog).toBe(false);
    expect(options[0]?.tag).toBe('garbage');
  });
});

/**
 * The running gate, and an upgrade on the runtime Docker does not run: the cases that write
 * a real record and reach the service through it.
 */
describe('an upgrade against a real record', () => {
  // Every module a case in THIS FILE replaces, including the cases above: a registered
  // factory survives `resetModules`, so theirs would otherwise answer for these records.
  const MOCKED = [
    '../../src/lib/versions',
    '../../src/core/backup',
    '../../src/core/kube/chart',
    '../../src/core/kube/exec',
    '../../src/core/kube/manifests',
    '../../src/core/kube/names',
    '../../src/core/kube/namespace',
    '../../src/core/kube/release',
    '../../src/core/kube/status',
    '../../src/core/lifecycle/naming',
    '../../src/core/lifecycle/ownership',
    '../../src/core/lifecycle/preconditions',
    '../../src/core/lifecycle/ready',
    '../../src/core/rcapi',
    '../../src/core/runner/engine',
    '../../src/core/runner/queries',
    '../../src/core/runner/record',
    '../../src/core/topology',
  ];
  let home = '';
  let previous: string | undefined;
  beforeEach(() => {
    for (const id of MOCKED) jest.dontMock(id);
    // Except the namespace identity check, which asks a cluster this suite does not have.
    jest.doMock('../../src/core/kube/namespace', () => ({
      ...jest.requireActual('../../src/core/kube/namespace'),
      requireOwnNamespace: async () => undefined,
    }));
    previous = process.env.HOUSTON_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-upgrade-'));
    process.env.HOUSTON_HOME = home;
    jest.resetModules();
  });
  afterEach(() => {
    for (const id of MOCKED) jest.dontMock(id);
    jest.doMock('../../src/core/runner/host', () =>
      (require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    jest.doMock('../../src/core/kube/tools', () =>
      (require('../testsetup-policy') as typeof PolicyNS).guardedTools(),
    );
    jest.resetModules();
    process.env.HOUSTON_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function composeWorkspace(name: string): Promise<void> {
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    await record.write(
      name,
      'services:\n  rocketchat:\n    image: i\n',
      record.metadata({
        name,
        project: `houston-${name}`,
        rcVersion: '8.5.1',
        rcImage: 'registry.rocket.chat/rocketchat/rocket.chat',
        mongoTag: '8.0',
        mongoFlavor: 'official',
        preset: 'default',
        rootUrl: 'http://localhost:3000',
        hostPort: 3000,
        versionSource: 'map',
      }),
    );
  }

  async function kubeWorkspace(
    name: string,
    values: Partial<RecordNS.Metadata> = {},
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    await record.writeRecord(
      name,
      record.metadata({
        name,
        project: 'p',
        rcVersion: '8.5.1',
        rcImage: 'registry.rocket.chat/rocketchat/rocket.chat',
        mongoTag: '8.0',
        mongoFlavor: 'official',
        preset: 'default',
        rootUrl: 'http://localhost:3000',
        hostPort: 3000,
        versionSource: 't',
        ...values,
        extra: { runtime: 'kubernetes', context: 'kind-houston-local', ...extra },
      }),
    );
  }

  function anyEngine(): void {
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../src/core/lifecycle/preconditions'),
      requireEngine: async () => undefined,
    }));
  }

  function neverCompose(): void {
    // A Kubernetes workspace has no compose document, which is what the old refusal was
    // protecting: nothing on this path may reach for one.
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readCompose: async () => {
        throw new Error('it read a compose document');
      },
    }));
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../src/core/runner/engine'),
      up: async () => {
        throw new Error('it ran `docker compose up`');
      },
    }));
  }

  it('is offered only for a running workspace, and says start or up', async () => {
    await composeWorkspace('rc8-5-1');
    anyEngine();
    let state = 'running';
    let containers: unknown[] = [];
    jest.doMock('../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../src/core/runner/queries'),
      rcState: async () => state,
      containerDetails: async () => containers,
    }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    expect(await upgrade.canUpgrade('rc8-5-1')).toEqual({
      can_upgrade: true,
      reason: '',
      current: '8.5.1',
    });
    // `rcState` omits --all, so a merely STOPPED repro also reports "absent". Containers
    // existing is what separates "start it" from "up it" -- and getting that wrong sends
    // someone to rebuild a repro that only needed starting.
    state = 'absent';
    containers = [{ service: 'mongodb' }];
    let answer = await upgrade.canUpgrade('rc8-5-1');
    expect(answer.can_upgrade).toBe(false);
    expect(String(answer.reason)).toContain('houston start');
    expect(String(answer.reason)).not.toContain('down');
    containers = [];
    answer = await upgrade.canUpgrade('rc8-5-1');
    expect(answer.can_upgrade).toBe(false);
    // With the version: `up` requires one, so a bare `houston up --name` was a usage error.
    expect(String(answer.reason)).toContain('houston up --version 8.5.1 --name rc8-5-1');
  });

  it('refuses a stopped workspace as not ready, pointing at start', async () => {
    await composeWorkspace('rc8-5-1');
    anyEngine();
    jest.doMock('../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../src/core/runner/queries'),
      rcState: async () => 'absent',
      containerDetails: async () => [{ service: 'mongodb' }],
    }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const errors = require('../../src/lib/errors') as typeof ErrorsNS;
    const refusal = upgrade.requireRunning('rc8-5-1');
    await expect(refusal).rejects.toBeInstanceOf(errors.NotReadyError);
    await expect(refusal).rejects.toThrow(/houston start/u);
  });

  it('reaches a healthy Kubernetes workspace on a box with no Docker', async () => {
    // `requireRunning` called `requireDocker()` before resolving the name, so it could not
    // tell a Kubernetes workspace from a Compose one when it mattered most.
    await kubeWorkspace('k');
    jest.doMock('../../src/core/runner/host', () => ({
      ...(require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
      dockerAvailable: async () => false,
    }));
    jest.doMock('../../src/core/kube/tools', () => ({
      ...(require('../testsetup-policy') as typeof PolicyNS).guardedTools(),
      which: (name: string) => `/usr/bin/${name}`,
    }));
    jest.doMock('../../src/core/kube/status', () => ({
      ...jest.requireActual('../../src/core/kube/status'),
      workloadExists: async () => true,
    }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const meta = await upgrade.requireRunning('k');
    expect([meta.name, meta.extra.runtime]).toEqual(['k', 'kubernetes']);
  });

  it("refuses to upgrade or roll back a name that could be somebody else's or the caller's own", async () => {
    // `down` refused it, and these did not: both change, and a rollback drops, the data of
    // whichever `test` answered while alice meant her own `alice-test`.
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    await record.writeRecord('test', record.metadata({ name: 'test' }));
    await record.writeRecord(
      'alice-test',
      record.metadata({ name: 'alice-test', extra: { created_by: 'alice' } }),
    );
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const { runWithContext } = require('../../src/lib/context') as typeof ContextNS;
    for (const run of [() => upgrade.requireRunning('test'), () => upgrade.rollback('test')]) {
      const said = await runWithContext({ actor: 'alice' }, () =>
        run().then(
          () => 'ran',
          (error: Error) => error.message,
        ),
      );
      expect(said).toContain("'test' could mean 'test' (nobody's) or your own 'alice-test'");
    }
  });

  it('asks again under the lock before an upgrade moves the chart', async () => {
    // Once before the wait and again in the plan made under the lock, even with --no-backup:
    // a namespace made in this one's place while the upgrade waited must not have its chart
    // moved.
    await kubeWorkspace('k');
    let asked = 0;
    jest.doMock('../../src/core/kube/namespace', () => ({
      ...jest.requireActual('../../src/core/kube/namespace'),
      requireOwnNamespace: async () => {
        asked += 1;
        if (asked > 1) throw new Error('namespace houston-k was made by another houston home');
      },
    }));
    jest.doMock('../../src/core/kube/tools', () => ({
      ...(require('../testsetup-policy') as typeof PolicyNS).guardedTools(),
      which: (name: string) => `/usr/bin/${name}`,
    }));
    jest.doMock('../../src/core/kube/status', () => ({
      ...jest.requireActual('../../src/core/kube/status'),
      workloadExists: async () => true,
    }));
    const chart: string[] = [];
    jest.doMock('../../src/core/kube/release', () => ({
      ...jest.requireActual('../../src/core/kube/release'),
      upgradeImage: async () => {
        chart.push('moved');
      },
    }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    await expect(upgrade.run('k', '8.6.1', { noBackup: true })).rejects.toThrow(
      /another houston home/u,
    );
    // Refused before the chart moved, not by the readiness check after it.
    expect(chart).toEqual([]);
    expect(asked).toBe(2);
  });

  it("upgrades and rolls back only a namespace that is still this workspace's own", async () => {
    // By name, they reached a namespace another home had made in this one's place.
    const bundle = path.join(home, 'pre.rcbak');
    fs.writeFileSync(bundle, 'x');
    await kubeWorkspace('k', {}, { last_upgrade_backup: bundle });
    const asked: string[] = [];
    jest.doMock('../../src/core/kube/namespace', () => ({
      ...jest.requireActual('../../src/core/kube/namespace'),
      requireOwnNamespace: async (name: string) => {
        asked.push(name);
        throw new Error('namespace houston-k was made by another houston home');
      },
    }));
    jest.doMock('../../src/core/kube/tools', () => ({
      ...(require('../testsetup-policy') as typeof PolicyNS).guardedTools(),
      which: (name: string) => `/usr/bin/${name}`,
    }));
    const touched: string[] = [];
    jest.doMock('../../src/core/kube/status', () => ({
      ...jest.requireActual('../../src/core/kube/status'),
      workloadExists: async () => {
        touched.push('workload');
        return true;
      },
    }));
    jest.doMock('../../src/core/backup', () => ({
      ...jest.requireActual('../../src/core/backup'),
      readManifest: async () => ({ rc_version: '8.5.1' }),
      restoreLocked: async () => {
        touched.push('restore');
        return {};
      },
    }));
    jest.doMock('../../src/core/kube/release', () => ({
      ...jest.requireActual('../../src/core/kube/release'),
      upgradeImage: async () => {
        touched.push('chart');
      },
    }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    await expect(upgrade.requireRunning('k')).rejects.toThrow(/another houston home/u);
    await expect(upgrade.rollback('k')).rejects.toThrow(/another houston home/u);
    expect(asked).toEqual(['k', 'k']);
    expect(touched).toEqual([]);
  });

  it('reads migration errors from the Kubernetes logs on a Kubernetes workspace', async () => {
    // It always read Compose logs and swallowed every failure: on Kubernetes that answer is
    // "no configuration file provided", the catch turned it into an empty list, and a
    // migration failure reported no diagnostics at all.
    await kubeWorkspace('k');
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../src/core/runner/engine'),
      composeLogsCapture: async () => {
        throw new Error('compose logs must not be read for a k8s workspace');
      },
    }));
    // AS THE REAL ONE DOES: the lines through `onLine`, and no `stdout` -- `stream` retains
    // nothing. This stub used to return the text as `stdout`, which the real `logProcess`
    // never does, and so it hid that a Kubernetes upgrade read '' here.
    jest.doMock('../../src/core/kube/status', () => ({
      ...jest.requireActual('../../src/core/kube/status'),
      logProcess: async (_name: string, options: { onLine?: (line: string) => void }) => {
        for (const line of ['ok', 'Migration failed: could not apply 305', 'FATAL migration'])
          options.onLine?.(line);
        return { argv: ['kubectl'], exitCode: 0, signal: null, stdout: null, stderr: null };
      },
    }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    expect(await upgrade.migrationErrors('k')).toEqual([
      'Migration failed: could not apply 305',
      'FATAL migration',
    ]);
  });

  it('leaves the record where the cluster is when a Kubernetes upgrade fails', async () => {
    // `rc_version` was advanced before `helm upgrade` was called, so when the call failed
    // the workspace kept serving the OLD release while `list`, `info` and the GUI all
    // reported the new one. The cluster changes first and the record follows.
    await kubeWorkspace('k');
    anyEngine();
    jest.doMock('../../src/core/kube/status', () => ({
      ...jest.requireActual('../../src/core/kube/status'),
      workloadExists: async () => true,
    }));
    jest.doMock('../../src/core/backup', () => ({
      ...jest.requireActual('../../src/core/backup'),
      createLocked: async () => ({ path: path.join(home, 'b.rcbak') }),
    }));
    jest.doMock('../../src/core/kube/chart', () => ({
      ...jest.requireActual('../../src/core/kube/chart'),
      resolveChartVersion: async () => '7.0.2',
    }));
    // The exact failure that was hit: helm is never reached. A rollback cannot help when
    // the apply never happened, and it fails the same way here -- which must not mask the
    // state either.
    jest.doMock('../../src/core/kube/release', () => ({
      ...jest.requireActual('../../src/core/kube/release'),
      upgradeImage: async () => {
        throw new Error("module 'houston.services.k8s' has no attribute 'upgrade_image'");
      },
    }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const errors = require('../../src/lib/errors') as typeof ErrorsNS;
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    await expect(upgrade.run('k', '8.6.1', { offline: true })).rejects.toBeInstanceOf(
      errors.DockerError,
    );
    expect((await record.readMeta('k')).rcVersion).toBe('8.5.1');
  });

  it('rolls a Kubernetes workspace back explicitly, without a compose document', async () => {
    // The automatic rollback was made runtime-aware and this entry point -- the one a person
    // types -- was not: it threw a bare ENOENT naming `docker-compose.yml` and
    // left the workspace on the NEW version with the old data, the worst of both.
    const bundle = path.join(home, 'pre.rcbak');
    fs.writeFileSync(bundle, 'x');
    await kubeWorkspace(
      'k',
      { rcVersion: '8.6.1' },
      { last_upgrade_backup: bundle, upgraded_from: '8.5.1' },
    );
    expect(fs.existsSync(path.join(home, 'repros', 'k', 'docker-compose.yml'))).toBe(false);
    anyEngine();
    neverCompose();
    const applied: Record<string, unknown>[] = [];
    const restored: string[] = [];
    jest.doMock('../../src/core/backup', () => ({
      ...jest.requireActual('../../src/core/backup'),
      readManifest: async () => ({
        rc_version: '8.5.1',
        rc_image: 'registry.rocket.chat/rocketchat/rocket.chat',
      }),
      restoreLocked: async (_target: string, from: string) => {
        restored.push(from);
        return { restored: true };
      },
    }));
    jest.doMock('../../src/core/kube/chart', () => ({
      ...jest.requireActual('../../src/core/kube/chart'),
      resolveChartVersion: async () => '6.9.0',
    }));
    jest.doMock('../../src/core/kube/release', () => ({
      ...jest.requireActual('../../src/core/kube/release'),
      upgradeImage: async (options: Record<string, unknown>) => {
        applied.push(options);
      },
    }));
    jest.doMock('../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../src/core/lifecycle/ready'),
      waitAndFinalize: async () => ({}),
    }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    const out = await upgrade.rollback('k');
    // It goes back to the bundle's version, and restores the pre-upgrade data.
    expect(applied.map((options) => options.tag)).toEqual(['8.5.1']);
    expect(restored).toEqual([bundle]);
    expect(out.rolled_back_to).toBe('8.5.1');
    // The "this was upgraded" marker must not survive the undo.
    expect((await record.readMeta('k')).extra).not.toHaveProperty(upgrade.UPGRADE_FROM_KEY);
  });

  it('upgrades a Kubernetes workspace with the chart pinned to the target release', async () => {
    // The official guide's one command does not pin a chart -- it "installs the latest
    // Rocket.Chat Helm chart", which for a tool reproducing an exact version deploys
    // different software than asked for -- and it carries `externalMongodbOplogUrl`
    // forward across the 8.0 line that removed it.
    //
    // MongoDB is 8.0 on both sides here. A 7.0 pairing would need `plan` stubbed past the
    // major-version refusal, and `plan` is this module's own function, so it cannot be
    // replaced from outside; the pairing is chosen so the real plan allows it.
    await kubeWorkspace('k', { rcVersion: '7.9.3', rcImage: 'i' }, { namespace: 'houston-k' });
    expect(fs.existsSync(path.join(home, 'repros', 'k', 'docker-compose.yml'))).toBe(false);
    anyEngine();
    neverCompose();
    const applied: Record<string, unknown>[] = [];
    jest.doMock('../../src/core/kube/status', () => ({
      ...jest.requireActual('../../src/core/kube/status'),
      // A running Kubernetes workspace is one whose workload exists, not one Docker knows.
      workloadExists: async () => true,
      logProcess: async () => ({ stdout: '' }),
    }));
    jest.doMock('../../src/core/backup', () => ({
      ...jest.requireActual('../../src/core/backup'),
      createLocked: async () => ({ path: path.join(home, 'b.rcbak') }),
    }));
    jest.doMock('../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../src/core/lifecycle/ready'),
      waitAndFinalize: async () => ({}),
    }));
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      apiInfo: async () => ({ version: '8.5.1' }),
    }));
    jest.doMock('../../src/core/kube/chart', () => ({
      ...jest.requireActual('../../src/core/kube/chart'),
      resolveChartVersion: async () => '7.0.0',
    }));
    jest.doMock('../../src/core/kube/release', () => ({
      ...jest.requireActual('../../src/core/kube/release'),
      upgradeImage: async (options: Record<string, unknown>) => {
        applied.push(options);
      },
    }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    expect((await upgrade.requireRunning('k')).name).toBe('k');
    const out = await upgrade.run('k', '8.5.1', { offline: true });
    expect(out.to_version).toBe('8.5.1');
    expect(applied).toHaveLength(1);
    // The chart moves WITH the app, pinned.
    expect(applied[0]?.chartVersion).toBe('7.0.0');
    expect([applied[0]?.tag, applied[0]?.namespace]).toEqual(['8.5.1', 'houston-k']);
    // Rocket.Chat 8 dropped oplog tailing and chart 7.0.0 removed the key.
    expect(applied[0]?.oplog).toBe(false);
    // The record moved on even though there is no compose file to rewrite.
    expect((await record.readMeta('k')).rcVersion).toBe('8.5.1');
  });

  it('keeps the port-forward its pre-upgrade backup re-established', async () => {
    // The record was read before the backup, which stops the forward and records the one it
    // starts again; the upgrade then wrote its whole old copy back, dead pid and all. Every
    // readiness check after that started another forward onto the port the live one held:
    // the upgrade and its rollback timed out, and the live one outlived `down`. Seen live
    // on k3s, on 2.1.1 as on 2.1.2's branch.
    await kubeWorkspace(
      'k',
      { rcVersion: '7.9.3', rcImage: 'i' },
      { namespace: 'houston-k', port_forward_pid: 111 },
    );
    anyEngine();
    neverCompose();
    const waitedWith: unknown[] = [];
    jest.doMock('../../src/core/kube/status', () => ({
      ...jest.requireActual('../../src/core/kube/status'),
      workloadExists: async () => true,
      logProcess: async () => ({ stdout: '' }),
    }));
    jest.doMock('../../src/core/backup', () => ({
      ...jest.requireActual('../../src/core/backup'),
      createLocked: async () => {
        const record = require('../../src/core/runner/record') as typeof RecordNS;
        await record.updateMeta('k', (m) => {
          m.extra.port_forward_pid = 222;
        });
        return { path: path.join(home, 'b.rcbak') };
      },
    }));
    jest.doMock('../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../src/core/lifecycle/ready'),
      waitAndFinalize: async (meta: RecordNS.Metadata) => {
        waitedWith.push(meta.extra.port_forward_pid);
        return {};
      },
    }));
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      apiInfo: async () => ({ version: '8.5.1' }),
    }));
    jest.doMock('../../src/core/kube/chart', () => ({
      ...jest.requireActual('../../src/core/kube/chart'),
      resolveChartVersion: async () => '7.0.0',
    }));
    jest.doMock('../../src/core/kube/release', () => ({
      ...jest.requireActual('../../src/core/kube/release'),
      upgradeImage: async () => undefined,
    }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    await upgrade.run('k', '8.5.1', { offline: true });
    expect(waitedWith).toEqual([222]);
    const after = await record.readMeta('k');
    expect([after.rcVersion, after.extra.port_forward_pid]).toEqual(['8.5.1', 222]);
    expect(after.extra[upgrade.UPGRADE_FROM_KEY]).toBe('7.9.3');
  });

  it('installs the MongoDB operator with its telemetry off', async () => {
    // The chart sends the cluster UID, the Kubernetes version and deployment UIDs to
    // MongoDB on a weekly timer, enabled by default. Nobody using a support reproduction
    // tool opted into third-party analytics about the cluster they are debugging.
    const seen: string[][] = [];
    jest.doMock('../../src/core/kube/exec', () => {
      const actual = jest.requireActual<Record<string, unknown>>('../../src/core/kube/exec');
      return {
        ...actual,
        kube: {
          ...(actual.kube as object),
          run: async (argv: readonly string[]) => {
            seen.push([...argv]);
            return { returncode: 0, stdout: '', stderr: '' };
          },
        },
      };
    });
    const operator = require('../../src/core/kube/operator') as typeof KubeOperatorNS;
    try {
      await operator.ensureOperator({ context: 'c' });
    } catch {
      // the install is not the subject; the argv it was about to run is
    }
    const install = seen.filter((argv) => argv.includes('upgrade') && argv.includes('--install'));
    expect(install.length).toBeGreaterThan(0);
    expect((install[0] ?? []).join(' ')).toContain('operator.telemetry.send.enabled=false');
  });

  /**
   * A Compose rollback held up behind another command on the workspace, with `change` made to
   * its record while it waits -- what a hand-over, a pin or an env change does meanwhile.
   */
  async function rollbackThatWaited(
    actor: string,
    change: (meta: RecordNS.Metadata) => void,
  ): Promise<{ outcome: string; record: typeof RecordNS }> {
    const bundle = path.join(home, 'pre.rcbak');
    fs.writeFileSync(bundle, 'x');
    await composeWorkspace('d');
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    const meta = await record.readMeta('d');
    meta.rcVersion = '8.6.1';
    Object.assign(meta.extra, {
      last_upgrade_backup: bundle,
      upgraded_from: '8.5.1',
      created_by: 'bob',
    });
    await record.writeRecord('d', meta);
    anyEngine();
    jest.doMock('../../src/core/backup', () => ({
      ...jest.requireActual('../../src/core/backup'),
      readManifest: async () => ({
        rc_version: '8.5.1',
        rc_image: 'registry.rocket.chat/rocketchat/rocket.chat',
      }),
      restoreLocked: async () => ({ restored: true }),
    }));
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../src/core/runner/engine'),
      up: async () => 0,
    }));
    const upgrade = require('../../src/core/upgrade') as typeof UpgradeNS;
    const { reproLock } = require('../../src/core/runner/locks') as {
      reproLock: <T>(name: string, body: () => Promise<T>) => Promise<T>;
    };
    const { runWithContext } = require('../../src/lib/context') as {
      runWithContext: <T>(values: { actor: string }, fn: () => T) => T;
    };
    const gate = { release: (): void => undefined, taken: false };
    const held = reproLock(
      'd',
      () =>
        new Promise<void>((done) => {
          gate.release = done;
          gate.taken = true;
        }),
    );
    for (let wait = 0; wait < 200 && !gate.taken; wait += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    const rolling = runWithContext({ actor }, () => upgrade.rollback('d')).then(
      () => '',
      (error: Error) => error.message,
    );
    await new Promise((done) => setTimeout(done, 200));
    const now = await record.readMeta('d');
    change(now);
    await record.writeRecord('d', now);
    gate.release();
    await held;
    return { outcome: await rolling, record };
  }

  it('asks again under the lock, so a workspace handed over while the rollback waited is left alone', async () => {
    const { outcome } = await rollbackThatWaited('bob', (meta) => {
      meta.extra.owner = 'alice';
    });
    expect(outcome).toContain('d belongs to alice');
  });

  it('keeps what changed in the record while the rollback waited', async () => {
    // The record was read before the wait and written back after it, so a hand-over or a
    // pin made in between was quietly undone.
    const { outcome, record } = await rollbackThatWaited('', (meta) => {
      meta.pinned = true;
      meta.extra.owner = 'carol';
    });
    expect(outcome).toBe('');
    const after = await record.readMeta('d');
    expect([after.rcVersion, after.pinned, after.extra.owner]).toEqual(['8.5.1', true, 'carol']);
  });
});

describe('a MongoDB move below 5.0', () => {
  type Move = typeof UpgradeNS.mongoMove;
  const move = (from: string, to: string): { blocked: string; warnings: string[] } => {
    const { mongoMove } = require('../../src/core/upgrade') as typeof UpgradeNS;
    const warnings: string[] = [];
    const { blocked } = mongoMove(
      '',
      { mongoTag: from } as unknown as Parameters<Move>[1],
      'w',
      { rcVersion: '6.0.0', mongoTag: to } as unknown as Parameters<Move>[3],
      warnings,
    );
    return { blocked, warnings };
  };

  it('refuses 4.0 -> 4.4: before 5.0 each of 4.0, 4.2 and 4.4 is its own fCV step', () => {
    const { blocked, warnings } = move('4.0', '4.4');
    expect(blocked).toContain('stepped one at a time (4.0 -> 4.2 -> 4.4)');
    expect(warnings).toEqual([]);
  });

  it('spells the steps out of 4.4 into the majors, and leaves 5.0 and later as they were', () => {
    expect(move('4.4', '6.0').blocked).toContain('(4.4 -> 5 -> 6)');
    expect(move('3.6', '4.2').blocked).toContain('(3.6 -> 4.0 -> 4.2)');
    expect(move('6.0', '8.0').blocked).toContain('(6 -> 7 -> 8)');
    expect(move('8.2', '8.0')).toEqual({
      blocked: '',
      warnings: [
        'MongoDB minor moves 8.2 -> 8.0; the container keeps its data volume and is not ' +
          'recreated by this upgrade',
      ],
    });
  });
});
