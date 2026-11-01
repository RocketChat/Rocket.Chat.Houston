import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ValidationError } from '../../../src/lib/errors';
import * as presets from '../../../src/lib/presets/index';
import type { Resolved } from '../../../src/lib/versions';
import type * as PolicyNS from '../../testsetup-policy';
import { packaged as packagedSkill } from '../../../src/core/skill';
import { workspace } from '../../../src/core/runner/paths';
import { type Metadata, metadata, writeRecord } from '../../../src/core/runner/record';

import type * as CreateDockerNS from '../../../src/core/lifecycle/create-docker';
import type * as PreconditionsNS from '../../../src/core/lifecycle/preconditions';
import type * as TypesNS from '../../../src/core/lifecycle/types';

import {
  checkStateRequest,
  checkTeardownRequest,
  reachableBeyondLoopback,
  refuseUnsupportedOnKubernetes,
  unsupportedFields,
} from '../../../src/core/lifecycle/preconditions';
import { createReq } from '../../../src/core/lifecycle/types';

function caught(work: () => Promise<unknown>): Promise<{ kind: string; message: string } | null> {
  return work().then(
    () => null,
    (error: Error) => ({ kind: error.constructor.name, message: error.message }),
  );
}

/**
 * `lifecycle/ports.claimSidePorts` on a machine where every preferred side and monitoring port
 * is free: the preset as built, nothing moved, monitoring on its preferred pair.
 */
async function preferredSidePorts(
  _name: string,
  pre: unknown,
  _rebuild: unknown,
  options: { monitoring?: readonly string[] } = {},
) {
  return {
    pre,
    side: {},
    monitoring: (options.monitoring ?? []).map((slot) => (slot === 'prometheus' ? 9090 : 5050)),
    moved: [],
  };
}

describe('the preconditions that refuse', () => {
  it('says what a runtime cannot honour, and what reaching off-box means', () => {
    // What earlier releases answered, recorded.
    const recorded = {
      unsupported: [
        [
          {
            field: 'fresh',
            why: "--fresh means DELETE this workspace's data, and the Kubernetes path keeps the PersistentVolumeClaim — use `houston down --name <n> --volumes` first, which does delete it",
          },
        ],
        [],
        [],
      ],
      reachable: [false, false, false, true, true, true, false],
      acme: true,
      local: false,
    };
    expect(['kubernetes', 'docker', ''].map(unsupportedFields)).toEqual(recorded.unsupported);
    expect(
      ['', '127.0.0.1', 'localhost', '0.0.0.0', '::', '192.168.1.5', '::1'].map((bindHost) =>
        reachableBeyondLoopback({ bindHost }),
      ),
    ).toEqual(recorded.reachable);
    // Agreement alone would pass two answers that both said "no" everywhere, so the answers
    // are stated: a local-CA name resolves to 127.0.0.1, and treating it as exposed would
    // rotate the password for the ordinary local case, for nothing.
    expect(
      ['', '127.0.0.1', 'localhost', '0.0.0.0', '::', '192.168.1.5', '::1'].map((bindHost) =>
        reachableBeyondLoopback({ bindHost }),
      ),
    ).toEqual([false, false, false, true, true, true, false]);
    expect(reachableBeyondLoopback({ tlsspec: { mode: 'acme' }, bindHost: '127.0.0.1' })).toBe(
      recorded.acme,
    );
    expect(reachableBeyondLoopback({ tlsspec: { mode: 'local' }, bindHost: '127.0.0.1' })).toBe(
      recorded.local,
    );
  });

  it('refuses an unknown or non-string action with earlier releases word for word', async () => {
    // What earlier releases refused each action with, recorded.
    const recorded = [
      {
        kind: 'ValidationError',
        message: 'action must be a string (want start|stop|restart), got an integer',
      },
      {
        kind: 'ValidationError',
        message: 'action must be a string (want start|stop|restart), got null',
      },
      {
        kind: 'ValidationError',
        message: 'action must be a string (want start|stop|restart), got an object',
      },
      { kind: 'ValidationError', message: "unknown action 'jump' (want start|stop|restart)" },
    ];
    const ours = [];
    for (const action of [7, null, { a: 1 }, 'jump']) {
      ours.push(await caught(() => checkStateRequest('x', action)));
    }
    expect(ours).toEqual(recorded);
  });

  it('refuses a Kubernetes create that cannot be honoured, before anything is written', async () => {
    const req = createReq({ version: '8.5.1', fresh: true });
    // The refusal earlier releases raised for the same request, recorded.
    const recorded =
      "--fresh is not supported on Kubernetes yet: --fresh means DELETE this workspace's data, and the Kubernetes path keeps the PersistentVolumeClaim — use `houston down --name <n> --volumes` first, which does delete it. Use --runtime docker for a workspace that needs it.";
    expect(() => refuseUnsupportedOnKubernetes(req)).toThrow(recorded);
    expect(() => refuseUnsupportedOnKubernetes(req)).toThrow(
      /--fresh is not supported on Kubernetes yet/,
    );
    // Resolving is not the same as working: the refusal names what DOES work.
    expect(() => refuseUnsupportedOnKubernetes(req)).toThrow(/--runtime docker/);
    expect(() => refuseUnsupportedOnKubernetes(createReq({ version: '8.5.1' }))).not.toThrow();
  });

  it('refuses a combined preset’s Docker-only setting as early, and as fully, as one alone', () => {
    // Each preset of a set was checked with no params, so `voice.sip=on` passed here and was
    // refused only after the release lookup, without the way out this refusal names.
    const alone = createReq({
      version: '8.8.1',
      preset: 'voice',
      params: { sip_integration: 'on' },
    });
    const combined = createReq({
      version: '8.8.1',
      preset: 'email+voice',
      params: { 'voice.sip_integration': 'on' },
    });
    for (const req of [alone, combined]) {
      expect(() => refuseUnsupportedOnKubernetes(req)).toThrow(
        /voice sip_integration=on runs on Docker only.*Or use --runtime docker/u,
      );
    }
    const usersOnly = createReq({ version: '8.8.1', preset: 'email+voice', params: {} });
    expect(() => refuseUnsupportedOnKubernetes(usersOnly)).not.toThrow();
  });

  it('refuses an unconfirmed volume teardown before it is queued', async () => {
    await writeRecord('w', metadata({ name: 'w', project: 'houston-w' }));
    // The refusal earlier releases raised for the same request, recorded.
    const recorded = {
      kind: 'ValidationError',
      message: "deleting 'w''s data volume and record is irreversible - pass confirm=true",
    };
    expect(
      await caught(() => checkTeardownRequest('w', { volumes: true, confirm: false })),
    ).toEqual(recorded);
    // Confirmed, no volume: nothing irreversible, so nothing to gate here.
    expect(await checkTeardownRequest('w', {})).toBe('w');
  });
});

describe('the compose project collision guard', () => {
  afterEach(() => {
    jest.dontMock('../../../src/core/runner/queries');
    jest.resetModules();
  });

  it('refuses a foreign project with our name, and allows our own or none', async () => {
    // Creating here would hijack another workspace's containers and data volume. Our own
    // project -- a --force recreate -- is allowed, and "docker cannot be asked" skips,
    // because the guard is best-effort.
    const answers: (Record<string, string> | null)[] = [
      { 'houston-rc8-5-1': '/Users/real/.houston/repros/rc8-5-1/docker-compose.yml' },
      { 'houston-rc8-5-1': `${workspace('rc8-5-1')}/docker-compose.yml` },
      null,
      {},
    ];
    const seen: (string | null)[] = [];
    for (const answer of answers) {
      jest.resetModules();
      jest.doMock('../../../src/core/runner/queries', () => ({
        ...jest.requireActual('../../../src/core/runner/queries'),
        projectConfigFiles: async () => answer,
        projectDataVolumes: async () => [],
      }));
      const fresh = require('../../../src/core/lifecycle/preconditions') as typeof PreconditionsNS;
      seen.push(
        await fresh.guardProjectCollision('rc8-5-1').then(
          () => null,
          (error: Error) => error.constructor.name,
        ),
      );
    }
    expect(seen).toEqual(['ConflictError', null, null, null]);
  });

  it('refuses a MongoDB another home left behind, which `compose ls` cannot see', async () => {
    // A project `down`ed without --volumes is absent from `compose ls`, so a second home on
    // the machine (`sudo houston` is root's) passed the guard, Compose mounted the volume the
    // first one left, and the second home served -- and then deleted -- the first one's data.
    const asked: string[] = [];
    const run = async (answer: string[] | null): Promise<string> => {
      jest.resetModules();
      jest.doMock('../../../src/core/runner/queries', () => ({
        ...jest.requireActual('../../../src/core/runner/queries'),
        projectConfigFiles: async () => ({}),
        projectDataVolumes: async (project: string) => {
          asked.push(project);
          return answer;
        },
      }));
      const fresh = require('../../../src/core/lifecycle/preconditions') as typeof PreconditionsNS;
      return await fresh.guardProjectCollision('rc8-5-1').then(
        () => 'allowed',
        (error: Error) => `${error.constructor.name}: ${error.message}`,
      );
    };
    const refused = await run(['houston-rc8-5-1_mongodb_data']);
    expect(refused).toMatch(/^ConflictError: the Docker volume houston-rc8-5-1_mongodb_data/u);
    expect(refused).toContain('docker volume rm houston-rc8-5-1_mongodb_data');
    expect(asked).toEqual(['houston-rc8-5-1']);
    expect(await run([])).toBe('allowed');
    // Could not ask is not "none": a create that mounts another home's data is the harm.
    expect(await run(null)).toMatch(
      /^DockerError: could not ask Docker whether another houston home/u,
    );
    // This home's own workspace keeps its own data across a --force or --fresh rebuild.
    await writeRecord('rc8-5-1', metadata({ name: 'rc8-5-1' }));
    expect(await run(['houston-rc8-5-1_mongodb_data'])).toBe('allowed');
    fs.rmSync(workspace('rc8-5-1'), { recursive: true, force: true });
  });
});

describe('the Compose create path', () => {
  let bin = '';
  let previousPath: string | undefined;
  afterEach(() => {
    process.env.PATH = previousPath;
    fs.rmSync(bin, { recursive: true, force: true });
    jest.doMock('../../../src/core/runner/host', () =>
      (require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    for (const id of [
      '../../../src/core/lifecycle/preconditions',
      '../../../src/core/lifecycle/sizing',
      '../../../src/core/lifecycle/ports',
      '../../../src/core/lifecycle/tlsplan',
      '../../../src/lib/versions',
      '../../../src/core/runner/record',
    ]) {
      jest.dontMock(id);
    }
    jest.resetModules();
  });

  it('stamps the runtime on a compose workspace, at the write seam', async () => {
    // The stamp has to happen on the REAL create path, not only be available as a helper.
    // Compose workspaces are stamped too: if only Kubernetes ones were, "absent" would
    // mean two things -- an old workspace and a new compose one. Captured at the record
    // write, the last thing to see the metadata before it becomes repro.json, which then
    // stops the create so nothing after it can reach an engine. PATH holds only an empty
    // directory for the same reason: a launch this test did not state cannot happen.
    previousPath = process.env.PATH;
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-nobin-'));
    process.env.PATH = bin;
    const written: Metadata[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/runner/host', () => ({
      ...(require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
      dockerKernelVersion: async () => '6.1.0',
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      requireDocker: async () => undefined,
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/sizing', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/sizing'),
      checkCapacity: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      pickHostPort: async () => 3000,
      claimSidePorts: preferredSidePorts,
    }));
    jest.doMock('../../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/tlsplan'),
      resolveTls: async () => null,
    }));
    jest.doMock('../../../src/lib/versions', () => ({
      ...jest.requireActual('../../../src/lib/versions'),
      resolve: (version: string): Resolved => ({
        rcVersion: version,
        rcImage: 'img',
        mongoTag: '8.0',
        mongoFlavor: 'official',
        mongoShell: 'mongosh',
        oplog: false,
        source: 'test',
        note: '',
      }),
    }));
    jest.doMock('../../../src/core/runner/record', () => ({
      ...jest.requireActual('../../../src/core/runner/record'),
      write: async (_name: string, _yaml: string, meta: Metadata) => {
        written.push(meta);
        throw new Error('stopped at the write seam');
      },
    }));
    const { createReproLocked } =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    await expect(
      createReproLocked(createReq({ version: '8.6.1', name: 'stamped', offline: true })),
    ).rejects.toThrow('stopped at the write seam');
    expect(written).toHaveLength(1);
    expect(written[0]?.extra.runtime).toBe('docker');
  });
});

describe('what Kubernetes refuses', () => {
  afterEach(() => {
    jest.dontMock('../../../src/lib/presets/index');
    jest.resetModules();
  });

  it('refuses only what it would silently drop, and lets everything it honours through', () => {
    // `--https` and `--domain` have LEFT the table: they are honoured now, and refused per
    // cluster in the TLS plan rather than per runtime here. The table catches what would
    // be ACCEPTED AND DROPPED, and it is down to one option.
    const req = (values: Parameters<typeof createReq>[0]) =>
      createReq({ ...values, runtime: 'kubernetes' });
    expect(() =>
      refuseUnsupportedOnKubernetes(req({ version: '8.5.1', https: true })),
    ).not.toThrow();
    expect(() =>
      refuseUnsupportedOnKubernetes(
        req({ version: '8.5.1', domain: 'x.example', acmeEmail: 'ops@example.com' }),
      ),
    ).not.toThrow();
    expect(unsupportedFields('kubernetes').map((row) => row.field)).toEqual(['fresh']);
    // What IS supported passes straight through, or this becomes a wall...
    expect(() =>
      refuseUnsupportedOnKubernetes(
        req({
          version: '8.5.1',
          preset: 'default',
          name: 'x',
          pin: true,
          monitor: true,
          seed: true,
          wait: true,
          mongoOperator: true,
          replicas: 3,
          regToken: 'abc',
        }),
      ),
    ).not.toThrow();
    // ...and `ldap` passes BECAUSE it has an adapter: the refusal is per preset.
    expect(() =>
      refuseUnsupportedOnKubernetes(
        req({ version: '8.5.1', preset: 'ldap', params: { users: '3' } }),
      ),
    ).not.toThrow();
    // Every listed preset is honest about it and works here. `multi-instance` is a
    // DEPLOYMENT on this runtime -- no longer listed as a preset -- and its legacy spelling
    // still refuses here.
    const verdicts = presets.listPresets().map((preset) => {
      try {
        refuseUnsupportedOnKubernetes(req({ version: '8.5.1', preset: preset.name }));
        return [preset.name, 'ok'];
      } catch (error) {
        return [preset.name, (error as Error).constructor.name];
      }
    });
    expect(verdicts.filter(([, verdict]) => verdict !== 'ok')).toEqual([]);
    expect(() =>
      refuseUnsupportedOnKubernetes(req({ version: '8.5.1', preset: 'multi-instance' })),
    ).toThrow("preset 'multi-instance'");
  });

  it.each([
    [{ policy: 'strict' }, "--set policy='strict' expects one of: optional, default, enforced"],
    [
      { colour: 'red' },
      "unknown --set param(s) for preset 'e2ee': colour - valid: allow_unencrypted, files, policy, users",
    ],
  ])(
    "refuses a single preset's bad --set %j in Docker's words, not as a missing adapter",
    (params, said) => {
      const req = createReq({ version: '8.5.1', runtime: 'kubernetes', preset: 'e2ee', params });
      let caught: unknown;
      try {
        refuseUnsupportedOnKubernetes(req);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ValidationError);
      expect((caught as Error).message).toBe(said);
    },
  );

  it('still refuses a preset whose backing services have no adapter, naming them', () => {
    // The guard is what keeps a future preset from being recorded and never applied.
    jest.resetModules();
    const actual = jest.requireActual<typeof presets>('../../../src/lib/presets/index');
    const broken = { ...actual.load('email', {}), kubernetesManifests: [] };
    jest.doMock('../../../src/lib/presets/index', () => ({
      ...jest.requireActual('../../../src/lib/presets/index'),
      resolve: () => broken,
    }));
    const fresh = require('../../../src/core/lifecycle/preconditions') as typeof PreconditionsNS;
    const types = require('../../../src/core/lifecycle/types') as typeof TypesNS;
    expect(() =>
      fresh.refuseUnsupportedOnKubernetes(
        types.createReq({ version: '8.5.1', runtime: 'kubernetes', preset: 'email' }),
      ),
    ).toThrow(/mailpit/u);
  });

  it('is not contradicted by the agent skill, in either direction', () => {
    // SKILL.md instructs something that is not a person and cannot notice being told the
    // wrong thing. It went on saying --https "does not create an Ingress for a Kubernetes
    // workspace yet" long after it did. The registry is the truth; the skill must claim a
    // refusal exactly where the registry makes one.
    const text = fs.readFileSync(packagedSkill(), 'utf8');
    const refused = new Set(unsupportedFields('kubernetes').map((row) => row.field));
    expect(refused.size).toBeGreaterThan(0);
    const start = text.indexOf('### What Kubernetes refuses, and why');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = text.slice(start, text.indexOf('###', start + 10));
    const wrong: string[] = [];
    for (const field of ['https', 'domain', 'fresh', 'reg_token']) {
      const flag = `--${field.replace(/_/gu, '-')}`;
      const claimed = block.includes(`- \`${flag}\``) || block.includes(`\`${flag}\` /`);
      if (claimed !== refused.has(field)) wrong.push(`${flag}: skill=${String(claimed)}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('the engine preflight', () => {
  afterEach(() => {
    jest.doMock('../../../src/core/runner/host', () =>
      (require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    jest.resetModules();
  });

  it('refuses a missing or v1 compose plugin as a preflight, and passes v2', async () => {
    // `docker info` says nothing about the compose plugin, and a box can have one without
    // the other. Reported from a fresh EC2 instance where `docker ps` worked and both entry
    // points died mid-work with docker's own "'compose' is not a docker command".
    const outcome = async (version: string | null) => {
      jest.resetModules();
      jest.doMock('../../../src/core/runner/host', () => ({
        ...(require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
        composeVersion: async () => version,
        // No standalone binary either, so the refusal is the "not installed" one.
        composeStandaloneVersion: async () => null,
      }));
      const fresh = require('../../../src/core/lifecycle/preconditions') as typeof PreconditionsNS;
      return await fresh.requireDocker().then(
        () => null,
        (error: Error & { exitCode?: number }) => ({
          kind: error.constructor.name,
          exit: error.exitCode,
          message: error.message,
        }),
      );
    };
    const absent = await outcome(null);
    expect(absent?.kind).toBe('PreflightError');
    expect(absent?.message).toContain('not installed');
    // Name the package to install...
    expect(absent?.message).toContain('docker-compose-plugin');
    // ...because an unusable environment is a preflight, not a crash.
    expect(absent?.exit).toBe(3);
    // v1 is not enough either, and it says which version it found.
    expect((await outcome('1.29.2'))?.message).toContain('1.29.2');
    // And v2 passes, which is every working box.
    expect(await outcome('2.29.1')).toBeNull();
  });
});

describe('an engine that runs no healthchecks', () => {
  afterEach(() => {
    jest.doMock('../../../src/core/runner/host', () =>
      (require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    jest.resetModules();
  });

  /** preconditions, over a host whose engine is the one given. */
  function withEngine(found: Record<string, unknown> | null, compose = '2.32.4') {
    jest.resetModules();
    jest.doMock('../../../src/core/runner/host', () => ({
      ...(require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
      engine: async () => found,
      composeVersion: async () => compose,
    }));
    return require('../../../src/core/lifecycle/preconditions') as typeof PreconditionsNS;
  }

  const podman = { kind: 'podman', cgroupDriver: 'cgroupfs', healthchecks: false };
  const waits = { services: { a: {}, b: { depends_on: { a: { condition: 'service_healthy' } } } } };
  const plain = { services: { a: {}, b: { depends_on: ['a'] } } };

  it('refuses a document that waits on health, says why and how, and lets --force try', async () => {
    const pre = withEngine(podman);
    await expect(pre.refuseHealthWaitsTheEngineCannotRun(waits, false, () => {})).rejects.toThrow(
      /Podman here runs no container healthchecks \(cgroup manager 'cgroupfs'.*cgroup_manager = "systemd"/su,
    );
    const said: string[] = [];
    await pre.refuseHealthWaitsTheEngineCannotRun(waits, true, (event) => said.push(event.message));
    expect(said.join('\n')).toContain('--force: trying anyway');
  });

  it('lets a document that waits on nothing through, and every document on Docker', async () => {
    await expect(
      withEngine(podman).refuseHealthWaitsTheEngineCannotRun(plain, false, () => {}),
    ).resolves.toBeUndefined();
    await expect(
      withEngine({ kind: 'docker', healthchecks: true }).refuseHealthWaitsTheEngineCannotRun(
        waits,
        false,
        () => {},
      ),
    ).resolves.toBeUndefined();
  });

  it('names podman-compose, which is not Compose v2', async () => {
    await expect(
      withEngine(null, 'podman-compose version 1.2.0').requireTheComposePlugin(),
    ).rejects.toThrow(
      '`docker compose` is podman-compose (podman-compose version 1.2.0), which houston does not support',
    );
  });
});
