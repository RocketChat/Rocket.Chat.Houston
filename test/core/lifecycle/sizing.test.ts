import * as fs from 'node:fs';
import * as path from 'node:path';

import { createReq } from '../../../src/core/lifecycle/types';
import {
  CLUSTER_MB,
  ENGINE_FLOOR_CPUS,
  ENGINE_FLOOR_MEMORY_GIB,
  KUBE_CHART_MB,
  MICROSERVICES_MB,
  MONITORING_MB,
  PRESET_MB,
  WORKSPACE_MB,
  hostReserveMb,
  kubeOverheadMb,
  neededMb,
  runtimeCost,
} from '../../../src/core/lifecycle/sizing';

/** What earlier releases raised and said for each engine size below, recorded. */
const RECORDED = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'core', 'lifecycle', 'sizing.json'),
    'utf8',
  ),
) as { engineFloor: unknown[] };

describe('capacity arithmetic', () => {
  it('is the same arithmetic earlier releases spend', () => {
    const requests = [
      { version: '8.5.1' },
      { version: '8.5.1', monitor: true },
      { version: '8.5.1', runtime: 'kubernetes' },
      { version: '8.5.1', runtime: 'kubernetes', deployment: 'monolith' },
      { version: '8.5.1', runtime: 'kubernetes', deployment: 'microservices' },
      { version: '8.5.1', preset: 'saml' },
    ];
    // What earlier releases answered for each case, and the constants they spend, recorded.
    const recorded = {
      reserve: [1024, 1024, 1024, 1638, 3276, 20000],
      cost: [
        { workspace_mb: 1100, cluster_mb: 0, shape: '2 containers' },
        { workspace_mb: 2400, cluster_mb: 600, shape: '9 pods' },
        { workspace_mb: 1600, cluster_mb: 600, shape: '5 pods' },
        { workspace_mb: 2400, cluster_mb: 600, shape: '9 pods' },
        { workspace_mb: 1100, cluster_mb: 0, shape: '2 containers' },
      ],
      needed: [1100, 1380, 2400, 1600, 2400, 1550],
      needed_provisioning: [1100, 1380, 3000, 2200, 3000, 1550],
      constants: {
        workspace: 1100,
        monitoring: 280,
        cluster: 600,
        chart: 500,
        micro: 800,
        preset: {
          saml: 450,
          oidc: 450,
          s3_minio: 120,
          ldap: 80,
          livechat: 60,
          'multi-instance': 400,
          email: 40,
          webhooks: 30,
        },
        floor_cpus: 4,
        floor_gib: 6.0,
      },
    };
    expect([0, 1024, 4096, 8192, 16384, 100000].map(hostReserveMb)).toEqual(recorded.reserve);
    expect(
      [
        ['docker', ''],
        ['kubernetes', ''],
        ['kubernetes', 'monolith'],
        ['kubernetes', 'microservices'],
        ['', ''],
      ].map(([runtime, deployment]) => runtimeCost(runtime as string, deployment)),
    ).toEqual(recorded.cost);
    expect(
      requests.map((spec) => neededMb(spec.preset ?? 'default', false, createReq(spec))),
    ).toEqual(recorded.needed);
    expect(
      requests.map((spec) => neededMb(spec.preset ?? 'default', true, createReq(spec))),
    ).toEqual(recorded.needed_provisioning);
    expect({
      workspace: WORKSPACE_MB,
      monitoring: MONITORING_MB,
      cluster: CLUSTER_MB,
      chart: KUBE_CHART_MB,
      micro: MICROSERVICES_MB,
      preset: { ...PRESET_MB },
      floor_cpus: ENGINE_FLOOR_CPUS,
      floor_gib: ENGINE_FLOOR_MEMORY_GIB,
    }).toEqual(recorded.constants);
  });

  it('answers the same overhead for the same request as the refusal spends', () => {
    // ONE formula: a card that quotes a number while the preflight reserves another is a
    // card contradicted by its own refusal. `neededMb` builds on `kubeOverheadMb`, and
    // nothing here restates a constant.
    const docker = createReq({ version: '8.5.1' });
    expect(neededMb('default', false, docker)).toBe(WORKSPACE_MB);
    const kube = createReq({
      version: '8.5.1',
      runtime: 'kubernetes',
      deployment: 'microservices',
    });
    expect(kubeOverheadMb(kube, true)).toBe(KUBE_CHART_MB + CLUSTER_MB + MICROSERVICES_MB);
    expect(neededMb('default', true, kube)).toBe(
      WORKSPACE_MB + KUBE_CHART_MB + CLUSTER_MB + MICROSERVICES_MB,
    );
  });
  it('charges an AD directory by its size and a Keycloak in front, alone or composed', () => {
    const base = WORKSPACE_MB + (PRESET_MB.ldap ?? 0);
    const req = (params: Record<string, string>) => createReq({ version: '8.5.1', params });
    expect(neededMb('ldap', false, req({}))).toBe(base);
    expect(neededMb('ldap', false, req({ directory: 'openldap', users: '20000' }))).toBe(base);
    expect(neededMb('ldap', false, req({ directory: 'ad' }))).toBe(base + 63);
    expect(neededMb('ldap', false, req({ directory: 'ad', users: '20000' }))).toBe(base + 120);
    expect(
      neededMb('email+ldap', false, req({ 'ldap.directory': 'ad', 'ldap.users': '1600' })),
    ).toBe(base + (PRESET_MB.email ?? 0) + 66);
    // Another preset's `directory` is not the ldap preset's.
    expect(neededMb('default', false, req({ directory: 'ad' }))).toBe(WORKSPACE_MB);
    // A Keycloak in front of the directory costs what the saml preset's does.
    expect(neededMb('ldap', false, req({ idp: 'oidc' }))).toBe(base + (PRESET_MB.saml ?? 0));
  });

  it('charges the SIP stack and the PBX lab, alone or composed', () => {
    const req = (params: Record<string, string>) => createReq({ version: '8.8.1', params });
    const base = neededMb('voice', false, req({}));
    expect(neededMb('voice', false, req({ sip_integration: 'on' }))).toBe(base + 60);
    // 2.1.3 spelled it sip, and its records still do.
    expect(neededMb('voice', false, req({ sip: 'on' }))).toBe(base + 60);
    // The Asterisk idled at 48.5 MiB (2026-10-16), with room for calls.
    expect(neededMb('voice', false, req({ sip_integration: 'on', pbx: 'on' }))).toBe(base + 140);
    expect(
      neededMb('email+voice', false, req({ 'voice.sip_integration': 'on', 'voice.pbx': 'on' })),
    ).toBe(neededMb('email+voice', false, req({})) + 140);
  });
});

import type * as SizingNS from '../../../src/core/lifecycle/sizing';

describe('the engine floor refusal', () => {
  afterEach(() => {
    jest.resetModules();
  });

  async function load(cpus: number, memBytes: number): Promise<typeof SizingNS> {
    jest.resetModules();
    jest.doMock('../../../src/core/runner/host', () => ({
      ...jest.requireActual('../../../src/core/runner/host'),
      dockerCapacity: async () => [cpus, memBytes],
    }));
    return require('../../../src/core/lifecycle/sizing') as typeof SizingNS;
  }

  it('formats both numbers exactly as earlier releases do', async () => {
    // Two defects lived in one line. `toFixed` rounds half AWAY FROM ZERO where earlier
    // releases' fixed-point formatting rounds half TO EVEN -- `formatFixed` exists in this
    // tree for that -- and earlier releases render the float `6.0` as "6.0", which `String(6)`
    // shortens to "6". The second half fires on EVERY emission of this refusal.
    const cases: [number, number][] = [
      [4, 8 * 1024 ** 3],
      [3, 8 * 1024 ** 3],
      [4, 5.25 * 1024 ** 3],
      [4, 5.5 * 1024 ** 3],
      [2, 4 * 1024 ** 3],
    ];
    const recorded = RECORDED.engineFloor;

    const ours: unknown[] = [];
    for (const [cpus, mem] of cases) {
      for (const force of [false, true]) {
        const sizing = await load(cpus, mem);
        const events: string[] = [];
        const req = createReq({ version: '8.5.1', runtime: 'kubernetes', force });
        let raised: { kind: string; message: string } | null = null;
        try {
          await sizing.checkEngineFloor(req, (event) => events.push(String(event.message)), true);
        } catch (error) {
          raised = {
            kind: (error as Error).constructor.name,
            message: (error as Error).message,
          };
        }
        ours.push({ force, raised, events });
      }
    }
    expect(ours).toEqual(recorded);
    // The measured half must be visible: "5.2", not "5.3", and "6.0", not "6".
    const short = ours[4] as { raised: { message: string } };
    expect(short.raised.message).toContain('5.2 GiB of memory (needs 6.0)');
  });
});

/**
 * The capacity check's BEHAVIOUR.
 *
 * The cases above prove the arithmetic against earlier releases. These prove what the preflight DOES
 * with it -- the refusals, the warnings and the overrides. This function exists because seven
 * concurrent stacks OOM-killed a 10 GB host, and the OOM killer picks its own victim, so
 * under-charging destroys somebody else's work.
 */
import type * as ErrorsNS from '../../../src/lib/errors';
import type * as EventsNS from '../../../src/lib/events';
import type * as KubeContextNS from '../../../src/core/kube/context';
import type * as PolicyNS from '../../testsetup-policy';
import type * as RequestNS from '../../../src/core/lifecycle/request';
import type * as TypesNS from '../../../src/core/lifecycle/types';
import type * as CreateDockerNS from '../../../src/core/lifecycle/create-docker';
import type * as RecordNS from '../../../src/core/runner/record';

interface Stated {
  available: number;
  total?: number;
  capacity?: [number, number] | null;
  plan?: () => Promise<{ context: string; distribution: string; create: boolean }>;
  metas?: RecordNS.Metadata[];
  /** `compose ls` by project, as `projectStates` answers it; null when it could not ask. */
  states?: Record<string, string> | null;
}

function preflight({
  available,
  total = 10_000,
  capacity = null,
  plan,
  metas = [],
  states = {},
}: Stated) {
  jest.resetModules();
  // `runner/host` is a GUARDED module: this owns it for the case and keeps the healthy
  // engine, and the cleanup below puts the suite's guard back rather than `dontMock`ing it.
  jest.doMock('../../../src/core/runner/host', () => ({
    ...(require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
    hostMemory: async () => [total, available, 0],
    dockerCapacity: async () => capacity,
  }));
  jest.doMock('../../../src/core/runner/record', () => ({
    ...jest.requireActual<object>('../../../src/core/runner/record'),
    listMeta: async () => metas,
  }));
  jest.doMock('../../../src/core/runner/queries', () => ({
    ...jest.requireActual<object>('../../../src/core/runner/queries'),
    projectStates: async () => states,
  }));
  if (plan !== undefined) {
    jest.doMock('../../../src/core/kube/context', () => ({
      ...jest.requireActual<typeof KubeContextNS>('../../../src/core/kube/context'),
      planCluster: plan,
    }));
  }
  return {
    sizing: require('../../../src/core/lifecycle/sizing') as typeof SizingNS,
    request: require('../../../src/core/lifecycle/request') as typeof RequestNS,
    types: require('../../../src/core/lifecycle/types') as typeof TypesNS,
    errors: require('../../../src/lib/errors') as typeof ErrorsNS,
  };
}

describe('the capacity preflight', () => {
  afterEach(() => {
    jest.doMock('../../../src/core/runner/host', () =>
      (require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    jest.dontMock('../../../src/core/runner/record');
    jest.dontMock('../../../src/core/runner/queries');
    jest.dontMock('../../../src/core/kube/context');
    jest.resetModules();
  });

  it('keeps a fifth of the host back, and never less than 1 GB', () => {
    expect(hostReserveMb(10_024)).toBe(2004);
    expect(hostReserveMb(2048)).toBe(1024);
  });

  it('charges the control plane only to the create that builds it', () => {
    // It is shared: billing it to the second and third workspace refuses creates the host
    // could hold, which is how people learn to pass --force by reflex.
    const req = createReq({ version: '8.6.1', runtime: 'k8s', deployment: 'monolith' });
    expect(kubeOverheadMb(req, true)).toBe(CLUSTER_MB + KUBE_CHART_MB);
    expect(kubeOverheadMb(req, false)).toBe(KUBE_CHART_MB);
  });

  it('charges microservices for the four pods that were observed, on top of the chart', () => {
    // MEASURED on chart 7.0.2: nine pods against a monolith's five.
    expect(MICROSERVICES_MB).toBe(800);
    expect(MICROSERVICES_MB).toBeGreaterThanOrEqual(4 * 200);
    expect(KUBE_CHART_MB).toBeGreaterThan(0);
    expect(CLUSTER_MB).toBeGreaterThan(0);
  });

  it('does not charge a Kubernetes workspace as a Compose one', () => {
    // An empty deployment is that runtime's DEFAULT, microservices -- the expensive one.
    expect(kubeOverheadMb(createReq({ version: '8.6.1' }))).toBe(0);
    expect(kubeOverheadMb(createReq({ version: '8.6.1', runtime: 'kubernetes' }))).toBe(
      CLUSTER_MB + KUBE_CHART_MB + MICROSERVICES_MB,
    );
    // A monolith on this chart is five pods: the cluster AND the chart baseline.
    expect(
      kubeOverheadMb(createReq({ version: '8.6.1', runtime: 'k8s', deployment: 'monolith' })),
    ).toBe(CLUSTER_MB + KUBE_CHART_MB);
  });

  it('does not charge for a cluster that is already running, and does for one about to be built', async () => {
    // INVERTED deliberately: keyed on houston's OWN kind cluster, this refused creates on a
    // box whose only cluster was the one about to be adopted.
    const up = preflight({
      available: 9000,
      plan: async () => ({ context: 'default', distribution: 'k3s', create: false }),
    });
    const req = up.types.createReq({
      version: '8.6.1',
      runtime: 'kubernetes',
      deployment: 'monolith',
    });
    expect(await up.request.willProvision(req)).toBe(false);
    expect(up.sizing.kubeOverheadMb(req, false)).toBe(KUBE_CHART_MB);

    const kind = preflight({
      available: 9000,
      plan: async () => ({ context: 'kind-houston', distribution: 'kind', create: true }),
    });
    const again = kind.types.createReq({
      version: '8.6.1',
      runtime: 'kubernetes',
      deployment: 'monolith',
    });
    expect(await kind.request.willProvision(again)).toBe(true);
    expect(kind.sizing.kubeOverheadMb(again, true)).toBe(CLUSTER_MB + KUBE_CHART_MB);
  });

  it('charges nothing for a control plane that will never be built, because that create refuses', async () => {
    const none = preflight({
      available: 9000,
      plan: async () => {
        throw new Error('kind is not installed, ...');
      },
    });
    const req = none.types.createReq({ version: '8.6.1', runtime: 'k8s', deployment: 'monolith' });
    expect(await none.request.willProvision(req)).toBe(false);
    expect(none.sizing.kubeOverheadMb(req, false)).toBe(KUBE_CHART_MB);
  });

  it('does not refuse a host with plenty of memory', async () => {
    const { sizing, types } = preflight({ available: 9000 });
    await expect(
      sizing.checkCapacity(types.createReq({ version: '8.5.1' })),
    ).resolves.toBeUndefined();
  });

  it('honours --force LOUDLY, and without it the same host still refuses', async () => {
    // The refusal told the user to pass --force and nothing read it, so obeying the advice
    // produced the identical refusal -- while `up --force` also means "overwrite this repro".
    const { sizing, types, errors } = preflight({ available: 1000 });
    const seen: EventsNS.Event[] = [];
    await sizing.checkCapacity(types.createReq({ version: '8.5.1', force: true }), '', (event) =>
      seen.push(event),
    );
    const warnings = seen
      .filter((event) => event.level === 'warn')
      .map((event) => String(event.message))
      .join(' ');
    // An OOM guard must not be bypassed silently; say which flag did it, and what it costs.
    expect(warnings).toContain('--force');
    expect(warnings).toContain('OOM');
    await expect(sizing.checkCapacity(types.createReq({ version: '8.5.1' }))).rejects.toThrow(
      errors.PreflightError,
    );
  });

  it('needs more for a preset that runs Keycloak, and counts monitoring too', async () => {
    const tight = hostReserveMb(10_024) + WORKSPACE_MB + 100;
    const { sizing, types, errors } = preflight({ available: tight });
    await expect(
      sizing.checkCapacity(types.createReq({ version: '8.5.1' })),
    ).resolves.toBeUndefined();
    await expect(
      sizing.checkCapacity(types.createReq({ version: '8.5.1' }), 'saml'),
    ).rejects.toThrow(errors.PreflightError);
    await expect(
      sizing.checkCapacity(types.createReq({ version: '8.5.1', monitor: true })),
    ).rejects.toThrow(errors.PreflightError);
  });

  it('labels each workspace in the refusal with its owner, and sends the reader to their own', async () => {
    // On a shared server the list was every workspace in the home, colleagues' included,
    // unlabelled, with advice to stop one: the obvious pick was often somebody else's.
    const record = jest.requireActual<typeof RecordNS>('../../../src/core/runner/record');
    const metas = [
      record.metadata({ name: 'bob-t1', project: 'houston-bob-t1', extra: { created_by: 'bob' } }),
      record.metadata({
        name: 'alice-t2',
        project: 'houston-alice-t2',
        extra: { created_by: 'alice', owner: 'carol' },
      }),
      record.metadata({ name: 'rc851', project: 'houston-rc851' }),
    ];
    const refusal = async (states: Record<string, string> | null): Promise<string> => {
      const { sizing, types } = preflight({ available: 1000, metas, states });
      let said = '';
      await sizing
        .checkCapacity(types.createReq({ version: '8.5.1' }))
        .catch((error: unknown) => (said = String(error)));
      return said;
    };
    // RUNNING ONES FIRST, AND SAID: they are what stopping frees. A stopped one (`exited`)
    // and a taken-down one (absent from `compose ls`) are listed after, unmarked. A running
    // workspace counts its exited one-shot setup container too, sorted first: measured live,
    // `startsWith('running')` marked none.
    const said = await refusal({
      'houston-bob-t1': 'exited(2)',
      'houston-alice-t2': 'exited(1), running(2)',
      'houston-rc851': 'running(2)',
    });
    expect(said).toContain(
      '3 workspace(s) on the machine running houston, running ones first: ' +
        "alice-t2 (carol's, running), rc851 (running), bob-t1 (bob's)",
    );
    // `compose ls` could not be asked: nothing is called running, in the record's order.
    expect(await refusal(null)).toContain("first: bob-t1 (bob's), alice-t2 (carol's), rc851\n");
    expect(said).toContain('stop one of YOUR running ones');
    expect(said).toContain("ask the owner before stopping anyone else's");
    expect(said).toContain('houston stop --name <it>      (keeps its data)');
  });

  it('warns about the ceiling before it is hit, not only in the refusal', async () => {
    const { sizing, types } = preflight({ available: hostReserveMb(10_024) + WORKSPACE_MB + 200 });
    const seen: string[] = [];
    await sizing.checkCapacity(types.createReq({ version: '8.5.1' }), '', (event) =>
      seen.push(String(event.message)),
    );
    expect(seen.some((message) => message.includes('is left'))).toBe(true);
  });

  it('carries the Kubernetes bill into the refusal, as a preflight failure and not a retry', async () => {
    // A correct estimate nothing consults refuses nothing: the first version computed the
    // overhead and did not add it. And a full host is exit 3, not "poll again" -- polling
    // does not free memory.
    const need = WORKSPACE_MB + CLUSTER_MB + KUBE_CHART_MB + MICROSERVICES_MB;
    const tight = WORKSPACE_MB + 200;
    const { sizing, types, errors } = preflight({
      available: tight + hostReserveMb(8000),
      total: 8000,
      plan: async () => ({ context: 'kind-houston', distribution: 'kind', create: true }),
    });
    await expect(
      sizing.checkCapacity(types.createReq({ version: '8.6.1' }), 'default'),
    ).resolves.toBeUndefined();
    expect(need).toBeGreaterThan(tight);
    let caught: unknown;
    try {
      await sizing.checkCapacity(
        types.createReq({ version: '8.6.1', runtime: 'kubernetes' }),
        'default',
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(errors.PreflightError);
    expect(String((caught as Error).message)).toContain(`${String(need)} MB`);
    expect((caught as ErrorsNS.ReproError).exitCode).toBe(3);
    expect((caught as ErrorsNS.ReproError).code).toBe('PREFLIGHT_FAILED');
  });

  it('does not take an unreadable engine as evidence of a small one', async () => {
    // A refusal on no evidence is how people learn to pass --force by reflex.
    const { sizing, types } = preflight({ available: 12_000, total: 16_000, capacity: null });
    await expect(
      sizing.checkCapacity(types.createReq({ version: '8.5.1', runtime: 'kubernetes' })),
    ).resolves.toBeUndefined();
  });
});

describe('the create path', () => {
  afterEach(() => {
    for (const module of ['../../../src/core/lifecycle/sizing', '../../../src/core/runner/engine'])
      jest.dontMock(module);
    jest.resetModules();
  });

  it('reaches the memory preflight with and without --force', async () => {
    // The caller excluded force from the call, so for a new workspace the loud override was a
    // silent one: the function was never reached.
    for (const force of [false, true]) {
      jest.resetModules();
      const calls: boolean[] = [];
      jest.doMock('../../../src/core/lifecycle/sizing', () => ({
        ...jest.requireActual<object>('../../../src/core/lifecycle/sizing'),
        checkCapacity: async () => {
          calls.push(true);
        },
      }));
      jest.doMock('../../../src/core/runner/engine', () => ({
        ...jest.requireActual<object>('../../../src/core/runner/engine'),
        up: async () => 0,
        down: async () => 0,
      }));
      const { createRepro } =
        require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
      const { createReq: fresh } = require('../../../src/core/lifecycle/types') as typeof TypesNS;
      // The boot is not the subject; whatever it does after the preflight is let go.
      await createRepro(
        fresh({ version: '8.5.1', name: `cap${force ? 1 : 0}`, force, offline: true }),
        () => undefined,
      ).catch(() => undefined);
      expect({ force, reached: calls.length > 0 }).toEqual({ force, reached: true });
    }
  });
});

describe('what the host can hold', () => {
  afterEach(() => {
    jest.doMock('../../../src/core/runner/host', () =>
      (require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    jest.dontMock('../../../src/core/runner/record');
    jest.resetModules();
  });

  it('says which runtime its room is denominated in, and gives every runtime its own', async () => {
    // `room` divided by WORKSPACE_MB and was reported as the machine's capacity whatever
    // runtime the reader was about to use. Observed in the same minute: doctor saying
    // "room for about 1 more workspace" and `up --runtime kubernetes` refusing for want
    // of memory -- the disagreement the one formula exists to prevent.
    const { sizing } = preflight({ available: 12_000, total: 16_000 });
    const cap = await sizing.capacity();
    expect(cap.known).toBe(true);
    expect(cap.room_denominated_in).toBe('docker');
    const rooms = cap.room_by_runtime ?? {};
    expect(Object.keys(rooms).sort()).toEqual([
      'docker',
      'kubernetes-microservices',
      'kubernetes-monolith',
    ]);
    // Strictly fewer of the expensive ones, which is the whole point...
    expect(rooms.docker).toBeGreaterThan(rooms['kubernetes-monolith'] ?? Infinity);
    expect(rooms['kubernetes-monolith']).toBeGreaterThanOrEqual(
      rooms['kubernetes-microservices'] ?? Infinity,
    );
    // ...and `room` keeps its old meaning for the existing consumers.
    expect(cap.room).toBe(rooms.docker);
  });

  it('never refuses a host it cannot measure', async () => {
    // Not Linux: skip rather than guess. A wrong refusal is worse than none.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/host', () => ({
      ...(require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
      hostMemory: async () => null,
    }));
    jest.doMock('../../../src/core/runner/record', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/record'),
      listMeta: async () => [],
    }));
    const sizing = require('../../../src/core/lifecycle/sizing') as typeof SizingNS;
    const types = require('../../../src/core/lifecycle/types') as typeof TypesNS;
    expect(await sizing.capacity()).toEqual({ known: false });
    await expect(
      sizing.checkCapacity(types.createReq({ version: '8.5.1' }), 'default'),
    ).resolves.toBeUndefined();
  });
});

describe("a composed workspace's memory", () => {
  it('pays for every preset, where its combined name used to cost nothing', () => {
    const req = createReq({ version: '8.5.1' });
    expect(neededMb('email+ldap', false, req)).toBe(1100 + 40 + 80);
    expect(neededMb('oidc+ldap', false, req)).toBe(1100 + 450 + 80);
    expect(neededMb('saml', false, req)).toBe(1550);
  });

  it('charges voice for Drachtio and FreeSWITCH only when sip=on starts them', () => {
    // Measured idle on 8.7.0: FreeSWITCH 27 MiB, Drachtio 7 MiB; the rest is room for calls.
    expect(neededMb('voice', false, createReq({ version: '8.7.0' }))).toBe(1100);
    expect(neededMb('voice', false, createReq({ version: '8.7.0', params: { sip: 'on' } }))).toBe(
      1100 + 60,
    );
    expect(
      neededMb(
        'email+voice',
        false,
        createReq({ version: '8.7.0', params: { 'voice.sip': 'on' } }),
      ),
    ).toBe(1100 + 40 + 60);
  });
});
