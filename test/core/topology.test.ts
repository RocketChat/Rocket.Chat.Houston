import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as config from '../../src/lib/config';
import { ValidationError } from '../../src/lib/errors';
import type * as ErrorsNS from '../../src/lib/errors';
import type * as EventsNS from '../../src/lib/events';
import { nullEmit } from '../../src/lib/events';
import type * as PresetsNS from '../../src/lib/presets/index';
import type * as PresetRegistryNS from '../../src/lib/presets/registry';
import type * as PolicyNS from '../testsetup-policy';

import type * as DataNS from '../../src/core/data';
import type * as DoctorNS from '../../src/core/doctor';
import type * as EdgePathsNS from '../../src/core/edge/paths';
import type * as EnvvarsNS from '../../src/core/envvars';
import type * as CreateDockerNS from '../../src/core/lifecycle/create-docker';
import type * as CreateK8sNS from '../../src/core/lifecycle/create-k8s';
import type * as DestroyNS from '../../src/core/lifecycle/destroy';
import type * as InspectNS from '../../src/core/lifecycle/inspect';
import type * as PreconditionsNS from '../../src/core/lifecycle/preconditions';
import type * as PruningNS from '../../src/core/lifecycle/pruning';
import type * as ReadyNS from '../../src/core/lifecycle/ready';
import type * as LifecycleTypesNS from '../../src/core/lifecycle/types';
import type * as RecordNS from '../../src/core/runner/record';
import type * as TopologyNS from '../../src/core/topology';

import {
  ALIASES,
  DEPLOYMENTS,
  DOCKER,
  KUBERNETES,
  LEGACY_MULTI_PRESET,
  LEGACY_REPLICA_PARAM,
  MICROSERVICES,
  MONOLITH,
  MULTI_INSTANCE,
  REGISTERED,
  axesOfMeta,
  isRegistered,
  label,
  normalize,
  normalizeDeployment,
  ofMeta,
  requireRegistered,
  resolveAxes,
  stamp,
} from '../../src/core/topology';

/**
 * What earlier releases answered for the larger cases below, recorded: the axes of each
 * request, the axes rebuilt from each recorded workspace, the alias tables, and the
 * outcome of each Object.prototype name.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'core', 'topology.json'), 'utf8'),
) as {
  axes: Record<string, unknown>[];
  axesOfMeta: unknown[];
  tables: Record<string, unknown>;
  protoNames: unknown[];
};

describe('runtime names', () => {
  it('takes every spelling a person actually types', () => {
    expect(normalize('')).toBe(DOCKER);
    expect(normalize(null)).toBe(DOCKER);
    expect(normalize('  K8S  ')).toBe(KUBERNETES);
    expect(normalize('compose')).toBe(DOCKER);
    expect(normalize('kube')).toBe(KUBERNETES);
  });

  it('throws on a typo rather than booting the wrong topology', () => {
    expect(() => normalize('kubernets')).toThrow(ValidationError);
    expect(() => normalize('kubernets')).toThrow(/Known runtimes: docker, kubernetes\./u);
  });

  it('agrees with earlier releases on every alias and on the refusal message', () => {
    const spellings = ['', '  ', 'K8S', 'compose', 'kube', 'docker-compose', 'dockercompose'];
    // What earlier releases answered for each spelling, and their refusal, recorded.
    const recorded = ['docker', 'docker', 'kubernetes', 'docker', 'kubernetes', 'docker', 'docker'];
    expect(recorded).toEqual(spellings.map(normalize));

    const refusal = "unknown runtime 'kubernets'. Known runtimes: docker, kubernetes.";
    expect(() => normalize('kubernets')).toThrow(refusal);
  });

  it('labels a runtime it has never heard of as itself rather than as empty', () => {
    expect(label(DOCKER)).toBe('Docker Compose');
    expect(label('nomad')).toBe('nomad');
    expect(label('')).toBe(DOCKER);
  });

  it('separates "can be named" from "can be created"', () => {
    // A GUI has to be able to show Kubernetes as an option that is visible but not
    // available, which folding these together would prevent.
    expect(isRegistered(DOCKER)).toBe(true);
    expect(isRegistered('nomad')).toBe(false);
    expect([...REGISTERED].sort()).toEqual([DOCKER, KUBERNETES]);
    expect(() => requireRegistered('nomad')).toThrow(ValidationError);
    expect(() => requireRegistered(DOCKER)).not.toThrow();
  });
});

describe('reading a workspace', () => {
  it('reads an ABSENT runtime key as docker, which is what it means', () => {
    // Every workspace made before this key existed is a compose one. The absent key is
    // not ambiguous; it is older than the question.
    expect(ofMeta({ extra: {} })).toBe(DOCKER);
    expect(ofMeta({})).toBe(DOCKER);
    expect(ofMeta(null)).toBe(DOCKER);
  });

  it('reads an UNKNOWN runtime as docker rather than throwing', () => {
    // A workspace written by a NEWER houston must still list, still show its ports and
    // still tear down. The alternative is a repro the installed version cannot remove.
    expect(ofMeta({ extra: { runtime: 'nomad' } })).toBe(DOCKER);
    expect(ofMeta({ extra: 'not a dict' })).toBe(DOCKER);
    expect(ofMeta({ extra: ['not', 'a', 'dict'] })).toBe(DOCKER);
    expect(ofMeta({ extra: { runtime: '  K8S ' } })).toBe(KUBERNETES);
  });

  it('stamps every create, including compose ones', () => {
    // Stamping only the new runtime would leave "absent" meaning two different things.
    expect(stamp({}, DOCKER)).toEqual({ [config.EXTRA_RUNTIME]: DOCKER });
    expect(stamp(null, KUBERNETES)).toEqual({ [config.EXTRA_RUNTIME]: KUBERNETES });
    const bag: Record<string, unknown> = { keep: 1 };
    expect(stamp(bag)).toBe(bag);
    expect(bag).toEqual({ keep: 1, [config.EXTRA_RUNTIME]: DOCKER });
  });

  it('agrees with earlier releases about every one of those readings', () => {
    const cases = [
      {},
      { extra: {} },
      { extra: { runtime: 'nomad' } },
      { extra: { runtime: '  K8S ' } },
      { extra: { runtime: 'compose' } },
    ];
    // What earlier releases read each one as, recorded.
    const recorded = ['docker', 'docker', 'docker', 'kubernetes', 'docker'];
    expect(recorded).toEqual(cases.map((c) => ofMeta(c)));
  });
});

describe('deployments', () => {
  it('defaults per runtime, with microservices the Kubernetes default', () => {
    expect(normalizeDeployment('', DOCKER)).toBe(MONOLITH);
    expect(normalizeDeployment('', KUBERNETES)).toBe(MICROSERVICES);
    expect(DEPLOYMENTS[DOCKER]).toEqual([MONOLITH, MULTI_INSTANCE]);
    expect(DEPLOYMENTS[KUBERNETES]).toEqual([MICROSERVICES, MONOLITH]);
  });

  it('names the runtime a legal-elsewhere deployment IS legal on', () => {
    // "unknown deployment 'microservices'" would be a lie: it is a real deployment that
    // this runtime simply cannot host, and the message has to say so.
    expect(() => normalizeDeployment('microservices', DOCKER)).toThrow(
      /Docker Compose cannot run a 'microservices' deployment\. It is available on --runtime kubernetes\./u,
    );
    expect(() => normalizeDeployment('nonsense', DOCKER)).toThrow(/unknown deployment/u);
  });
});

describe('resolveAxes', () => {
  it('implies Kubernetes from --deployment microservices, and says so', () => {
    const axes = resolveAxes({ deployment: 'microservices' });
    expect(axes.runtime).toBe(KUBERNETES);
    expect(axes.hints).toContain('--deployment microservices implies --runtime kubernetes');
  });

  it('treats the old spellings as permanent aliases, with a hint and no failure', () => {
    const axes = resolveAxes({ preset: LEGACY_MULTI_PRESET });
    expect(axes.deployment).toBe(MULTI_INSTANCE);
    // It reaches the preset loader exactly as before, which is what makes the compose
    // document byte-identical to the old spelling's.
    expect(axes.preset).toBe(LEGACY_MULTI_PRESET);
    expect(axes.params[LEGACY_REPLICA_PARAM]).toBe(2);
    expect(axes.hints.join(' ')).toMatch(/now --deployment multi-instance/u);
  });

  it('refuses two spellings that ask for different deployments', () => {
    expect(() => resolveAxes({ preset: LEGACY_MULTI_PRESET, deployment: 'monolith' })).toThrow(
      /ask for two different deployments/u,
    );
  });

  it('refuses --replicas on a lone monolith and names the flag that would work', () => {
    // There is no load balancer in front of a Compose monolith and no NATS mesh between
    // them, so `--replicas 3` would silently produce one.
    expect(() => resolveAxes({ replicas: 3 })).toThrow(
      /--replicas 3 would silently give you one\. Add --deployment multi-instance\./u,
    );
    expect(() =>
      resolveAxes({ runtime: 'kubernetes', deployment: 'monolith', replicas: 3 }),
    ).toThrow(/Add --deployment microservices\./u);
    expect(() => resolveAxes({ replicas: -1 })).toThrow(/--replicas must be at least 1\./u);
  });

  it('composes a scenario with a multi-instance deployment instead of refusing it', () => {
    // This was refused while a Preset was all-or-nothing. Composition merges them, and the
    // compose build applies the scenario's settings to every instance.
    const axes = resolveAxes({ deployment: 'multi-instance', preset: 'ldap' });
    expect([axes.deployment, axes.preset, axes.params[LEGACY_REPLICA_PARAM]]).toEqual([
      MULTI_INSTANCE,
      'ldap+multi-instance',
      2,
    ]);
  });

  it('reads multi-instance among several presets as the deployment, and keeps the rest', () => {
    const axes = resolveAxes({ preset: 'email+ldap+multi-instance' });
    expect([axes.deployment, axes.preset]).toEqual([MULTI_INSTANCE, 'email+ldap+multi-instance']);
    expect(() => resolveAxes({ preset: 'ldap+multi-instance', deployment: 'monolith' })).toThrow(
      /ask for two different deployments/u,
    );
  });

  it('coerces a replica count the way earlier releases do, not the way Number() does', () => {
    // A number 3.7 truncates to 3; the text "3.7" is refused. Number() gets the first wrong and
    // parseInt gets the second wrong, so either one alone diverges on a JSON payload.
    expect(resolveAxes({ deployment: 'multi-instance', params: { instances: 3.7 } }).replicas).toBe(
      3,
    );
    expect(
      resolveAxes({ deployment: 'multi-instance', params: { instances: ' 4 ' } }).replicas,
    ).toBe(4);
    expect(() =>
      resolveAxes({ deployment: 'multi-instance', params: { instances: '3.7' } }),
    ).toThrow(/expects a whole number/u);
  });

  it('lets a typed --replicas win over the count a record carries back as a param', () => {
    // `up --force --replicas 4` on a 3-instance workspace rebuilt it with 3: the recorded
    // `instances` param came back and beat the flag (review 2026-10-31).
    const axes = resolveAxes({
      deployment: 'multi-instance',
      replicas: 4,
      params: { instances: 3 },
    });
    expect([axes.replicas, axes.params.instances]).toEqual([4, 4]);
    expect(resolveAxes({ deployment: 'multi-instance', params: { instances: 3 } }).params).toEqual({
      instances: 3,
    });
  });

  it('agrees with earlier releases on every axis of a representative matrix', () => {
    const cases = [
      {},
      { runtime: 'k8s' },
      { deployment: 'microservices' },
      { preset: 'multi-instance' },
      { deployment: 'multi-instance', replicas: 3 },
      { preset: 'multi-instance', params: { instances: 5 } },
      // The legacy spelling's own param travels VERBATIM, a string as typed.
      { preset: 'multi-instance', params: { instances: '3' } },
      { runtime: 'kubernetes', deployment: 'monolith' },
      { preset: 'ldap' },
    ];
    const recorded = RECORDED.axes;
    const mine = cases.map((c) => {
      const a = resolveAxes(c);
      return {
        runtime: a.runtime,
        deployment: a.deployment,
        replicas: a.replicas,
        preset: a.preset,
        params: a.params,
        hints: a.hints,
      };
    });
    expect(mine).toEqual(recorded);
  });
});

describe('axesOfMeta on a composed multi-instance workspace', () => {
  it('keeps its scenarios, which resolve back to the same set', () => {
    const axes = axesOfMeta({
      preset: 'ldap+multi-instance',
      extra: { runtime: 'docker', deployment: 'multi-instance', instances: 3 },
    });
    expect([axes.deployment, axes.preset]).toEqual([MULTI_INSTANCE, 'ldap']);
    expect(
      resolveAxes({ deployment: String(axes.deployment), preset: String(axes.preset), replicas: 3 })
        .preset,
    ).toBe('ldap+multi-instance');
  });
});

describe('axesOfMeta', () => {
  it('rebuilds a multi-instance workspace without printing a deprecation nobody caused', () => {
    // `restore` and the GUI's start button both rebuild a request from an existing
    // workspace. Passing `preset=meta.preset` printed "--preset multi-instance is now
    // --deployment multi-instance" at a user who typed neither and merely clicked Start.
    const rebuilt = axesOfMeta({ preset: LEGACY_MULTI_PRESET, extra: { instances: 3 } });
    expect(rebuilt).toEqual({
      runtime: DOCKER,
      deployment: MULTI_INSTANCE,
      preset: 'default',
      replicas: 3,
    });
    expect(resolveAxes(rebuilt).hints).toEqual([]);
  });

  it('keeps an empty cluster context empty, because carrying none RETARGETS', () => {
    // A rebuilt request with no context sends `planCluster` back through its own steps,
    // and on a box with `kind` that means BUILDING A LOCAL CLUSTER for a workspace that
    // lives in a remote one.
    expect(axesOfMeta({ extra: {} })).not.toHaveProperty('context');
    expect(axesOfMeta({ extra: { context: 'prod-eu' } })).toHaveProperty('context', 'prod-eu');
    expect(axesOfMeta({ extra: { context: '   ' } })).not.toHaveProperty('context');
  });

  it('says the operator runs MongoDB, so a rebuild does not apply houston’s own over it', () => {
    // The GUI's Start rebuilds from these axes; without it, `kubectl apply` met the operator's
    // StatefulSet and failed. Absent for every other workspace.
    expect(axesOfMeta({ extra: { mongo_managed_by: 'operator' } })).toHaveProperty(
      'mongoOperator',
      true,
    );
    expect(axesOfMeta({ extra: {} })).not.toHaveProperty('mongoOperator');
  });

  it('agrees with earlier releases for every shape of recorded workspace', () => {
    const cases = [
      { preset: 'default', extra: {} },
      { preset: LEGACY_MULTI_PRESET, extra: { instances: 3 } },
      { preset: 'ldap', extra: { runtime: 'kubernetes', deployment: 'microservices' } },
      { preset: 'default', extra: { runtime: 'kubernetes' } },
      { preset: 'default', extra: { instances: 'nonsense' } },
      { preset: 'default', extra: { context: 'prod-eu' } },
    ];
    expect(cases.map((c) => axesOfMeta(c))).toEqual(RECORDED.axesOfMeta);
  });
});

describe('the alias tables themselves', () => {
  it('are identical to the tables earlier releases had, key for key', () => {
    const recorded = RECORDED.tables;
    expect(recorded.aliases).toEqual({ ...ALIASES });
    expect(recorded.registered).toEqual([...REGISTERED].sort());
  });
});

describe('the runtime, on disk', () => {
  // A HOME PER CASE: each case writes workspaces and reads them back.
  let home = '';
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.HOUSTON_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-topology-'));
    process.env.HOUSTON_HOME = home;
    jest.resetModules();
  });
  afterEach(() => {
    jest.resetModules();
    process.env.HOUSTON_HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('survives a real write and read', async () => {
    // Round-trip through repro.json on disk, not through a mock: the reader drops keys it
    // does not know, so a value living in the wrong place would be lost between writing a
    // workspace and reading it back.
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    const topology = require('../../src/core/topology') as typeof TopologyNS;
    const meta = record.metadata({ name: 'k', project: 'p', rcVersion: '8.6.1', hostPort: 3010 });
    topology.stamp(meta.extra, topology.KUBERNETES);
    await record.write('k', 'services: {}\n', meta);
    expect(await topology.ofRepro('k')).toBe(topology.KUBERNETES);
    expect((await record.readMeta('k')).extra.runtime).toBe('kubernetes');
  });

  it('reads a workspace that does not exist as docker, rather than failing first', async () => {
    // `ofRepro` runs before the caller's own existence check on some paths. It must not be
    // the thing that fails, or the user gets a stat error instead of "no such repro".
    const topology = require('../../src/core/topology') as typeof TopologyNS;
    expect(await topology.ofRepro('nope')).toBe(topology.DOCKER);
  });

  it('refuses a compose-only operation on a Kubernetes workspace, naming the alternative', async () => {
    // `stats` shells out to `docker stats` against a compose project, so it cannot serve a
    // workspace that has none. "Not supported" leaves the user to find what the person
    // writing the refusal already knew.
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    const topology = require('../../src/core/topology') as typeof TopologyNS;
    const meta = record.metadata({ name: 'k', project: 'p', rcVersion: '8.6.1', hostPort: 3010 });
    topology.stamp(meta.extra, topology.KUBERNETES);
    await record.write('k', 'services: {}\n', meta);
    const refusal = topology.requireCompose('k', 'stats', { instead: 'Use `kubectl top`.' });
    await expect(refusal).rejects.toThrow(/Kubernetes/u);
    await expect(refusal).rejects.toThrow(/kubectl top/u);
    // And SILENT for the runtime it guards: a guard that fired on compose would break
    // every existing user of the command.
    topology.stamp(meta.extra, topology.DOCKER);
    await record.write('k', 'services: {}\n', meta);
    await expect(topology.requireCompose('k', 'stats')).resolves.toBeUndefined();
  });
});

describe('the three axes, decided in one function', () => {
  it('decides every cell of the runtime and deployment matrix', () => {
    // `--preset` used to carry the scenario AND the deployment shape at once. A scenario is
    // a scenario wherever it runs, and every combination is decided in one function,
    // because a rule enforced at two call sites eventually disagrees with itself.
    const plain = resolveAxes();
    expect([plain.runtime, plain.deployment, plain.replicas]).toEqual([DOCKER, MONOLITH, 1]);
    const k = resolveAxes({ runtime: 'k8s' });
    expect([k.runtime, k.deployment]).toEqual([KUBERNETES, MICROSERVICES]);
    expect(resolveAxes({ runtime: 'k8s', deployment: 'monolith' }).deployment).toBe(MONOLITH);
    expect(resolveAxes({ preset: 'ldap' }).preset).toBe('ldap');
    expect(resolveAxes({ runtime: 'k8s', preset: 'ldap' }).preset).toBe('ldap');
    // multi-instance reaches the preset loader, which is how it stays compatible.
    const m = resolveAxes({ deployment: 'multi-instance', replicas: 3 });
    expect([m.preset, m.params[LEGACY_REPLICA_PARAM], m.replicas]).toEqual([
      'multi-instance',
      3,
      3,
    ]);
    expect(resolveAxes({ deployment: 'multi-instance' }).replicas).toBe(2);
  });

  it('refuses every bad combination as a usage error that names what to do instead', () => {
    // Each refusal is about coverage or physics, never category confusion.
    const cases: [Parameters<typeof resolveAxes>[0], string][] = [
      [{ runtime: 'docker', deployment: 'microservices' }, '--runtime kubernetes'],
      [{ runtime: 'k8s', deployment: 'multi-instance' }, '--runtime docker'],
      [{ replicas: 3 }, '--deployment multi-instance'],
      [{ preset: 'multi-instance', deployment: 'monolith' }, 'two different deployments'],
      [{ runtime: 'nomad' }, 'Known runtimes'],
      [{ deployment: 'sharded' }, 'Known deployments'],
      [{ replicas: -1 }, 'at least 1'],
    ];
    for (const [options, expected] of cases) {
      let caught: unknown = null;
      try {
        resolveAxes(options);
      } catch (error) {
        caught = error;
      }
      expect({ options, caught: caught instanceof ValidationError }).toEqual({
        options,
        caught: true,
      });
      expect((caught as ValidationError).message).toContain(expected);
      // A bad combination is a usage error, exit 2 -- not a preflight fault.
      expect((caught as ValidationError).exitCode).toBe(2);
    }
    // Resolving and being allowed stay separate questions, so a GUI can name a runtime it
    // cannot yet create.
    expect(resolveAxes({ runtime: 'k8s' }).runtime).toBe(KUBERNETES);
    expect(() => requireRegistered('nomad')).toThrow(/not available in this build/u);
  });

  it('names the runtimes with the same words the preset layer uses', () => {
    // One vocabulary for one pair of things. The preset layer is LOWER and must not import
    // this module, so its adapters are keyed by spelled-out names -- and this is what an
    // import would have guaranteed.
    jest.resetModules();
    const presets = require('../../src/lib/presets/index') as typeof PresetsNS;
    const registry = require('../../src/lib/presets/registry') as typeof PresetRegistryNS;
    presets.scenarioNames(); // registers the built-in scenarios
    const ldap = registry.scenarios().ldap as { adapters: Record<string, unknown> };
    const keys = Object.keys(ldap.adapters).sort();
    expect(keys.filter((key) => !REGISTERED.has(key))).toEqual([]);
    expect(keys).toEqual([DOCKER, KUBERNETES]);
    // And the preset layer's default runtime is this module's.
    expect(presets.load('ldap', {})).toEqual(presets.resolve('ldap', DOCKER, {}));
  });

  it('keeps deployments out of the preset catalogue', () => {
    // PR #3 modelled `microservices` as a PRESET that implies Kubernetes. Here it is a
    // DEPLOYMENT under an explicit runtime; keeping both would give two answers to "what
    // runs where", and the one that infers would quietly win because it needs no flag.
    jest.resetModules();
    const presets = require('../../src/lib/presets/index') as typeof PresetsNS &
      Record<string, unknown>;
    expect(presets.resolveSelection).toBeUndefined();
    expect(presets.DEPLOYMENT_PRESETS).toBeUndefined();
    expect(DEPLOYMENTS[KUBERNETES]).toContain(MICROSERVICES);
    expect(DEPLOYMENTS[DOCKER]).toContain(MULTI_INSTANCE);
    expect(presets.scenarioNames()).not.toContain('microservices');
  });
});

/**
 * Every command asks the runtime the workspace IS on: one case per command that used to ask
 * Docker about a Kubernetes workspace.
 */
describe('each command asks the runtime the workspace is on', () => {
  const MOCKED = [
    '../../src/core/audit',
    '../../src/core/data',
    '../../src/core/edge/networks',
    '../../src/core/kube/capabilities',
    '../../src/core/kube/forward',
    '../../src/core/kube/monitoring',
    '../../src/core/kube/namespace',
    '../../src/core/kube/operator',
    '../../src/core/kube/status',
    '../../src/core/lifecycle/create-k8s',
    '../../src/core/lifecycle/naming',
    '../../src/core/lifecycle/ownership',
    '../../src/core/lifecycle/ports',
    '../../src/core/lifecycle/preconditions',
    '../../src/core/lifecycle/sizing',
    '../../src/core/rcapi',
    '../../src/core/runner/engine',
    '../../src/core/runner/queries',
    '../../src/core/topology',
  ];
  let home = '';
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.HOUSTON_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-topology-'));
    process.env.HOUSTON_HOME = home;
    jest.resetModules();
  });
  afterEach(() => {
    for (const id of MOCKED) jest.dontMock(id);
    // The suite's own guards go BACK rather than being `dontMock`ed away.
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

  /** A workspace record on the runtime named, the way `up` leaves it. */
  async function workspace(
    name: string,
    runtime: string,
    values: Partial<RecordNS.Metadata> = {},
  ): Promise<RecordNS.Metadata> {
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    const meta = record.metadata({
      name,
      project: `houston-${name}`,
      rcVersion: '8.5.1',
      rcImage: 'i',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3000',
      hostPort: 3000,
      versionSource: 't',
      ...values,
    });
    meta.extra = { ...meta.extra, [config.EXTRA_RUNTIME]: runtime };
    if (runtime === KUBERNETES && meta.extra[config.EXTRA_CONTEXT] === undefined) {
      meta.extra[config.EXTRA_CONTEXT] = 'kind-houston-local';
    }
    if (runtime === KUBERNETES) await record.writeRecord(name, meta);
    else await record.write(name, 'services: {}\n', meta);
    return meta;
  }

  /** kubectl on PATH, over the suite's guard: the engine these commands need. */
  function kubectlPresent(present = true): void {
    jest.doMock('../../src/core/kube/tools', () => ({
      ...(require('../testsetup-policy') as typeof PolicyNS).guardedTools(),
      which: (name: string) => (present ? `/usr/bin/${name}` : ''),
    }));
  }

  it('lists which runtime each workspace is on', async () => {
    // Two workspaces that differ in what every other command will do to them looked
    // identical in `list`, which is the one place people look first.
    await workspace('d', DOCKER);
    await workspace('k', KUBERNETES);
    jest.doMock('../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../src/core/runner/queries'),
      projectStates: async () => ({}),
      rcStatusByProject: async () => ({}),
      servicesByProject: async () => ({}),
    }));
    jest.doMock('../../src/core/kube/capabilities', () => ({
      ...jest.requireActual('../../src/core/kube/capabilities'),
      workspaceNamespaces: async () => [],
    }));
    const inspect = require('../../src/core/lifecycle/inspect') as typeof InspectNS;
    const rows = Object.fromEntries(
      (await inspect.listRepros()).map((row) => [String(row.name), row]),
    );
    expect(rows.d?.runtime).toBe(DOCKER);
    expect(rows.k?.runtime).toBe(KUBERNETES);
  });

  it('refuses the compose-only `env --set` with the helm command, namespace named', async () => {
    // Six commands used to answer "no configuration file provided: not found" here. The
    // list has shrunk to one: an environment variable cannot be changed inside a running
    // container on either runtime, and on this one that is a helm upgrade -- so the
    // refusal hands the command over, copy-pasteable, rather than guessing.
    await workspace('k', KUBERNETES);
    const envvars = require('../../src/core/envvars') as typeof EnvvarsNS;
    let caught: unknown = null;
    try {
      await envvars.setEnv('k', { A: 'b' });
    } catch (error) {
      caught = error;
    }
    const errors = require('../../src/lib/errors') as typeof ErrorsNS;
    expect(caught).toBeInstanceOf(errors.ValidationError);
    const message = (caught as Error).message;
    expect(message).toContain('helm');
    expect(message).toContain('houston-k');
    expect((caught as ErrorsNS.ValidationError).exitCode).toBe(2);
    // A Compose workspace passes straight through the same guard.
    await workspace('d', DOCKER, { hostPort: 3001 });
    const topology = require('../../src/core/topology') as typeof TopologyNS;
    await expect(topology.requireCompose('d', 'backup')).resolves.toBeUndefined();
  });

  it('reads `env` from the running container on Kubernetes, masked', async () => {
    // First a bare ENOENT naming `docker-compose.yml`, which escaped the error
    // contract as a 500; then a clean refusal; now an answer -- from the CONTAINER, since
    // the chart contributes variables houston never set.
    await workspace('k', KUBERNETES, { rcVersion: '8.6.1', hostPort: 3010 });
    expect(fs.existsSync(path.join(home, 'repros', 'k', 'docker-compose.yml'))).toBe(false);
    jest.doMock('../../src/core/kube/status', () => ({
      ...jest.requireActual('../../src/core/kube/status'),
      containerEnv: async () => ({ ROOT_URL: 'http://localhost:3010', ADMIN_PASS: 'admin123' }),
    }));
    const envvars = require('../../src/core/envvars') as typeof EnvvarsNS;
    const out = await envvars.current('k');
    const keys = Object.fromEntries(
      (out.env as { key: string; value: string }[]).map((row) => [row.key, row.value]),
    );
    expect(keys.ROOT_URL).toBe('http://localhost:3010');
    expect(keys.ADMIN_PASS).not.toBe('admin123');
    // The WRITE path still refuses, as a 400.
    const refusal = envvars.setEnv('k', { A: 'b' });
    await expect(refusal).rejects.toThrow(/helm/u);
    await expect(refusal).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('asks for the engine the workspace actually runs on', async () => {
    // `requireDocker()` ran before anything looked at the runtime, so on a host with no
    // Docker -- the documented adopt-an-existing-cluster setup -- `upgrade`, `ready`,
    // `logs` and the rest all refused a healthy Kubernetes workspace.
    const load = (runtime: string, kubectl: boolean): typeof PreconditionsNS => {
      jest.resetModules();
      jest.doMock('../../src/core/runner/host', () => ({
        ...(require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
        dockerAvailable: async () => false,
      }));
      jest.doMock('../../src/core/topology', () => ({
        ...jest.requireActual('../../src/core/topology'),
        ofRepro: async () => runtime,
      }));
      kubectlPresent(kubectl);
      return require('../../src/core/lifecycle/preconditions') as typeof PreconditionsNS;
    };
    await expect(load(KUBERNETES, true).requireEngine('k')).resolves.toBeUndefined();
    // A Compose workspace still needs Docker, or the gate would protect nothing. The error
    // classes are read from the registry each load made, or identity would not hold.
    const compose = load(DOCKER, true);
    const composeErrors = require('../../src/lib/errors') as typeof ErrorsNS;
    await expect(compose.requireEngine('c')).rejects.toBeInstanceOf(composeErrors.DockerError);
    // And a Kubernetes workspace still needs kubectl, said here rather than one layer
    // down in a child process whose "command not found" names nothing.
    const preconditions = load(KUBERNETES, false);
    const errors = require('../../src/lib/errors') as typeof ErrorsNS;
    const refusal = preconditions.requireEngine('k');
    await expect(refusal).rejects.toBeInstanceOf(errors.PreflightError);
    await expect(refusal).rejects.toThrow(/kubectl/u);
  });

  /** `prunable` against a stated cluster; Docker must not be reached unless asked. */
  function pruning({
    workload,
    docker = true,
  }: {
    workload: (name: string) => Promise<boolean>;
    docker?: boolean;
  }): typeof PruningNS {
    jest.doMock('../../src/core/audit', () => ({
      ...jest.requireActual('../../src/core/audit'),
      actor: () => '',
      record: () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/ownership', () => ({
      ...jest.requireActual('../../src/core/lifecycle/ownership'),
      mayDestroy: async () => [true, ''],
    }));
    jest.doMock('../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../src/core/runner/queries'),
      projectStates: async () => ({}),
    }));
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../src/core/lifecycle/preconditions'),
      requireDocker: async () => {
        if (!docker) throw new Error('Docker must not be required for a Kubernetes-only host');
      },
    }));
    jest.doMock('../../src/core/kube/status', () => ({
      ...jest.requireActual('../../src/core/kube/status'),
      workloadExists: async (name: string) => await workload(name),
    }));
    return require('../../src/core/lifecycle/pruning') as typeof PruningNS;
  }

  it('asks Kubernetes, not Docker, whether a Kubernetes workspace is down', async () => {
    // `prunable` listed a repro when no compose PROJECT was running, and a Kubernetes
    // workspace never has one -- so a healthy workspace serving traffic was offered for
    // deletion among "N down repro(s) incl. data".
    await workspace('live-k8s', KUBERNETES);
    await workspace('gone-k8s', KUBERNETES, { hostPort: 3001 });
    await workspace('down-docker', DOCKER, { hostPort: 3002 });
    const targets = await pruning({ workload: async (name) => name === 'live-k8s' }).prunable();
    expect(targets).not.toContain('live-k8s');
    expect(targets).toContain('gone-k8s');
    expect(targets).toContain('down-docker');
  });

  it('does not need Docker to prune when every workspace is on Kubernetes', async () => {
    // The gate at the top of `prunable` refused a host that uses only an adopted cluster,
    // while the loop below it already asked Kubernetes about Kubernetes workspaces.
    await workspace('k', KUBERNETES, { hostPort: 3001 });
    const targets = await pruning({ workload: async () => false, docker: false }).prunable();
    expect(targets).toEqual(['k']);
  });

  it('does not offer a workspace nobody could read for deletion as down', async () => {
    // A refused read was indistinguishable from "the workload is not there", and
    // `prunable()` listed a LIVE workspace under "these down repros will be deleted".
    await workspace('k', KUBERNETES);
    const errors = require('../../src/lib/errors') as typeof ErrorsNS;
    const targets = await pruning({
      workload: async () => {
        throw new errors.DockerError('could not ask the cluster about k');
      },
    }).prunable();
    expect(targets).toEqual([]);
  });

  it('removes a pruned Kubernetes workspace through Kubernetes, record and all', async () => {
    // The loop called `docker compose down` for every target, so a Kubernetes workspace
    // was warned about and skipped every time, leaving its namespace and PVC behind.
    await workspace('k', KUBERNETES);
    const deleted: [string, boolean][] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../src/core/runner/engine'),
      down: async () => {
        throw new Error('it reached for `docker compose down` on Kubernetes');
      },
    }));
    jest.doMock('../../src/core/kube/namespace', () => ({
      ...jest.requireActual('../../src/core/kube/namespace'),
      deleteNamespace: async (name: string, { volumes }: { volumes: boolean }) => {
        deleted.push([name, volumes]);
        return true;
      },
    }));
    jest.doMock('../../src/core/kube/capabilities', () => ({
      ...jest.requireActual('../../src/core/kube/capabilities'),
      workspaceNamespaces: async () => [],
    }));
    jest.doMock('../../src/core/edge/networks', () => ({
      ...jest.requireActual('../../src/core/edge/networks'),
      detach: async () => undefined,
    }));
    const prune = pruning({ workload: async () => false });
    const out = await prune.prune({ confirm: true });
    expect(deleted).toEqual([['k', true]]);
    expect(out.removed).toEqual(['k']);
    expect(fs.existsSync(path.join(home, 'repros', 'k'))).toBe(false);
  });

  it('fails doctor when a Kubernetes workspace exists but the tools do not', async () => {
    // The same finding at the opposite severity: a workspace that cannot be reached OR
    // TORN DOWN is a real fault, and the teardown half is what makes it urgent.
    await workspace('k', KUBERNETES, { rcVersion: '8.6.1', hostPort: 3010 });
    // The suite's fixture already answers every cluster tool absent; stated so the case
    // does not depend on it silently.
    kubectlPresent(false);
    // The one check that crosses the wire, answered as a box with no network answers it.
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      releasesReachable: async () => null,
    }));
    const doctor = require('../../src/core/doctor') as typeof DoctorNS;
    const report = await doctor.runChecks();
    const kube = (report.checks as { message: string; status: string }[]).filter((row) =>
      row.message.includes('Kubernetes workspace(s) exist'),
    );
    expect(kube).toHaveLength(1);
    expect(kube[0]?.status).toBe('fail');
    expect(kube[0]?.message).toContain('torn down');
    expect(report.verdict).toBe('fail');
  }, 30_000);

  it('tears a Kubernetes workspace down through Kubernetes, below the shared gates', async () => {
    // `down` reached for a compose project that is not there, leaving a workspace that
    // could be CREATED and never removed. The dispatch sits BELOW the confirmation, the
    // ownership gate and the audit record, which do not depend on the runtime.
    await workspace('k', KUBERNETES, { rcVersion: '8.6.1', hostPort: 3010 });
    kubectlPresent();
    const called: [string, Record<string, unknown>][] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../src/core/runner/engine'),
      down: async () => {
        throw new Error('it asked docker compose');
      },
    }));
    jest.doMock('../../src/core/kube/namespace', () => ({
      ...jest.requireActual('../../src/core/kube/namespace'),
      deleteNamespace: async (name: string, options: Record<string, unknown>) => {
        called.push([name, options]);
        return true;
      },
    }));
    const destroy = require('../../src/core/lifecycle/destroy') as typeof DestroyNS;
    // The registry's own `nullEmit`: the module under test was loaded fresh, so the one
    // imported at the top of this file is a different function with the same name.
    const events = require('../../src/lib/events') as typeof EventsNS;
    const out = await destroy.teardown('k', { volumes: false });
    expect(out.runtime).toBe(KUBERNETES);
    expect(called).toEqual([
      ['k', { context: 'kind-houston-local', volumes: false, emit: events.nullEmit }],
    ]);
    // And --volumes still needs the confirmation, shared rather than per runtime.
    const errors = require('../../src/lib/errors') as typeof ErrorsNS;
    await expect(destroy.teardown('k', { volumes: true, confirm: false })).rejects.toBeInstanceOf(
      errors.ValidationError,
    );
  });

  it('drops the edge route when a Kubernetes workspace is torn down', async () => {
    // The Kubernetes branch returned before the line that removes the route. Once
    // `--https` lands that is a leak with a nasty shape: the route outlives the namespace,
    // so the hostname 502s instead of 404ing and the name can never be reused.
    await workspace('kws', KUBERNETES, {
      rootUrl: 'http://localhost:3001',
      hostPort: 3001,
      publicUrl: 'https://kws.houston.localhost',
      extra: { edge: true },
    });
    kubectlPresent();
    const edgePaths = require('../../src/core/edge/paths') as typeof EdgePathsNS;
    fs.mkdirSync(edgePaths.dynamicDir(), { recursive: true });
    const route = edgePaths.routePath('kws');
    fs.writeFileSync(route, '# generated\n');
    jest.doMock('../../src/core/kube/namespace', () => ({
      ...jest.requireActual('../../src/core/kube/namespace'),
      deleteNamespace: async () => true,
    }));
    jest.doMock('../../src/core/kube/operator', () => ({
      ...jest.requireActual('../../src/core/kube/operator'),
      removeOperator: async () => false,
    }));
    jest.doMock('../../src/core/kube/monitoring', () => ({
      ...jest.requireActual('../../src/core/kube/monitoring'),
      removeMonitoring: async () => false,
    }));
    const destroy = require('../../src/core/lifecycle/destroy') as typeof DestroyNS;
    await destroy.teardown('kws', { volumes: true, confirm: true });
    expect(fs.existsSync(route)).toBe(false);
  });

  it('brings a workspace back on the runtime it already has', async () => {
    // `up -v 8.5.1 --name X` on a Kubernetes workspace defaulted to docker and ran
    // `docker compose up` against a workspace with no compose file. `--runtime` says what
    // to CREATE; what already exists is a fact, not a preference.
    await workspace('k', KUBERNETES);
    const took: string[] = [];
    jest.doMock('../../src/core/lifecycle/create-k8s', () => ({
      ...jest.requireActual('../../src/core/lifecycle/create-k8s'),
      createKubernetes: async (req: LifecycleTypesNS.CreateReq) => {
        took.push(req.runtime);
        return {};
      },
    }));
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../src/core/runner/engine'),
      up: async () => {
        throw new Error('it ran docker compose up');
      },
    }));
    const types = require('../../src/core/lifecycle/types') as typeof LifecycleTypesNS;
    const create = require('../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    // No --runtime at all, exactly as the failing command had it.
    await create.createReproLocked(types.createReq({ version: '8.5.1', name: 'k' }));
    expect(took).toEqual([KUBERNETES]);
  });

  /** The first steps of a Kubernetes create, with the machine's answers stated. */
  function kubeSteps(): { k8s: typeof CreateK8sNS; types: typeof LifecycleTypesNS } {
    jest.doMock('../../src/core/lifecycle/sizing', () => ({
      ...jest.requireActual('../../src/core/lifecycle/sizing'),
      checkCapacity: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../src/core/lifecycle/ports'),
      // What a FRESH allocation gives, so a returning workspace landing here moved. A port
      // given to it (asked for, or recorded) comes back once checked, as the real one does.
      pickHostPort: async (port: number) => port || 3000,
    }));
    return {
      k8s: require('../../src/core/lifecycle/create-k8s') as typeof CreateK8sNS,
      types: require('../../src/core/lifecycle/types') as typeof LifecycleTypesNS,
    };
  }

  it('brings a downed Kubernetes workspace back instead of refusing it', async () => {
    // `down` says "bring it back: houston up ..." and `up` answered "already exists, down
    // first or --force": two messages contradicting each other about one workspace. The
    // namespace and PVC surviving a plain `down` is what makes bringing it back meaningful.
    await workspace('k', KUBERNETES);
    const { k8s, types } = kubeSteps();
    const job = k8s.kubeCreate({
      req: types.createReq({ version: '8.5.1', name: 'k', runtime: KUBERNETES, offline: true }),
      emit: nullEmit,
      monitorAttach: (
        require('../../src/core/lifecycle/request') as { missingMonitorAttach: never }
      ).missingMonitorAttach,
    });
    await k8s.settleName(job);
    expect(job.reused).toBe(true);
  });

  it('brings a workspace back on the port it left on, unless another is asked for', async () => {
    // `up` after `down` allocated afresh, so a workspace created on :3382 came back on
    // :3000 -- every bookmark and every curl pasted into a ticket pointed at nothing.
    await workspace('k', KUBERNETES, { rootUrl: 'http://localhost:3382', hostPort: 3382 });
    const { k8s, types } = kubeSteps();
    const monitorAttach = (
      require('../../src/core/lifecycle/request') as { missingMonitorAttach: never }
    ).missingMonitorAttach;
    const returning = k8s.kubeCreate({
      req: types.createReq({ version: '8.5.1', name: 'k', runtime: KUBERNETES, offline: true }),
      emit: nullEmit,
      monitorAttach,
    });
    await k8s.settleName(returning);
    await k8s.resolvePairing(returning);
    k8s.settleAddressing(returning);
    expect(returning.hostPort).toBe(3382);
    expect(returning.root).toBe('http://localhost:3382');
    // An explicit --port still wins, because asking for one is asking for one.
    const asked = k8s.kubeCreate({
      req: types.createReq({
        version: '8.5.1',
        name: 'k',
        port: 3999,
        runtime: KUBERNETES,
        offline: true,
      }),
      emit: nullEmit,
      monitorAttach,
    });
    await k8s.settleName(asked);
    await k8s.resolvePairing(asked);
    expect(asked.hostPort).toBe(3999);
  });

  it('asks Kubernetes whether it is ready, and re-establishes the forward', async () => {
    // `ready` answered "Rocket.Chat container is not running" about a workspace whose pods
    // were fine -- `rcState` asks docker about a CONTAINER. And `ready` is exactly what
    // someone runs when the URL is not answering, and a forward dies with its pod.
    const meta = await workspace('k', KUBERNETES, {
      extra: { context: 'kind-houston-local', namespace: 'houston-k', port_forward_pid: 999999999 },
    });
    const established: unknown[] = [];
    // The namespace identity check asks a cluster this suite does not have; it is tested on
    // its own in test/core/kube/tier3.test.ts.
    jest.doMock('../../src/core/kube/namespace', () => ({
      ...jest.requireActual('../../src/core/kube/namespace'),
      requireOwnNamespace: async () => undefined,
    }));
    jest.doMock('../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../src/core/runner/queries'),
      rcState: async () => {
        throw new Error('it asked docker');
      },
    }));
    jest.doMock('../../src/core/kube/status', () => ({
      ...jest.requireActual('../../src/core/kube/status'),
      workspaceReady: async () => true,
      terminalPodFailure: async () => null,
      servicesWithoutEndpoints: async () => [],
    }));
    jest.doMock('../../src/core/kube/forward', () => ({
      ...jest.requireActual('../../src/core/kube/forward'),
      forwardReachable: async () => true,
      ensurePortForward: async (_name: string, options: unknown) => {
        established.push(options);
        return 4242;
      },
    }));
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      apiInfo: async () => ({ version: '8.5.1' }),
    }));
    const ready = require('../../src/core/lifecycle/ready') as typeof ReadyNS;
    const record = require('../../src/core/runner/record') as typeof RecordNS;
    const out = await ready.waitServing(meta, nullEmit, 30);
    expect(out.ready).toBe(true);
    expect(established.length).toBeGreaterThan(0);
    // The dead pid is replaced in the record, or `down` later signals nothing.
    expect((await record.readMeta('k')).extra.port_forward_pid).toBe(4242);
  }, 20_000);

  it('does not call a Kubernetes workspace down just because nobody could ask', async () => {
    // `list` said `down` for a healthy workspace whenever the cluster could not be asked.
    // `down` is the word that invites `up --force` and `down --volumes`; the Docker branch
    // has said `?` for an unreachable daemon all along.
    const meta = await workspace('k', KUBERNETES);
    let answer: string[] | null = null;
    jest.doMock('../../src/core/kube/capabilities', () => ({
      ...jest.requireActual('../../src/core/kube/capabilities'),
      workspaceNamespaces: async () => answer,
    }));
    const inspect = require('../../src/core/lifecycle/inspect') as typeof InspectNS;
    expect(await inspect.kubernetesState('k', meta)).toBe('?');
    // A real empty answer still means down.
    answer = [];
    expect(await inspect.kubernetesState('k', meta)).toBe('down');
  });

  it('refuses the Mongo scale prefill on Kubernetes rather than asking compose', async () => {
    // `scaleseed` bulk-inserts through a compose exec, so on Kubernetes this answered
    // docker's "no configuration file provided: not found". The REST seed works on both.
    await workspace('k', KUBERNETES);
    const data = require('../../src/core/data') as typeof DataNS;
    const errors = require('../../src/lib/errors') as typeof ErrorsNS;
    for (const call of [() => data.runScale('k', 'users=10'), () => data.clearScale('k')]) {
      const refusal = call();
      await expect(refusal).rejects.toBeInstanceOf(errors.ValidationError);
      await expect(refusal).rejects.toThrow(/seed/iu);
    }
  });
});

/**
 * A runtime or a deployment named after an Object.prototype member. Indexing a plain object
 * found the prototype's `constructor`, a function, where earlier releases have no such key
 * and refuse the name.
 */
describe("the alias tables, as a mapping's own keys", () => {
  it('refuse the names Object.prototype holds, as earlier releases refuse them', () => {
    const names = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];
    const outcome = (fn: () => unknown) => {
      try {
        return ['ok', fn()];
      } catch (error) {
        return [(error as Error).constructor.name, (error as Error).message];
      }
    };
    const topology = require('../../src/core/topology') as typeof TopologyNS;
    const ours = names.map((n) => [
      outcome(() => topology.normalize(n)),
      outcome(() => topology.normalizeDeployment(n, 'docker')),
      outcome(() => topology.ofMeta({ extra: { runtime: n } })),
    ]);
    expect(ours).toEqual(RECORDED.protoNames);
  });
});
