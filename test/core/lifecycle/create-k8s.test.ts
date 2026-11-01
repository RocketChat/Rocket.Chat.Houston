import * as config from '../../../src/lib/config';
import { type Event, nullEmit } from '../../../src/lib/events';

import * as fs from 'node:fs/promises';
import * as net from 'node:net';

import {
  finish,
  buildRecord,
  kubeCreate,
  recordTheRequest,
  resolvePairing,
  settleAddressing,
  settleEnv,
  settleName,
  writeProvisionalRecord,
  writeRecordStep,
} from '../../../src/core/lifecycle/create-k8s';
import { missingMonitorAttach } from '../../../src/core/lifecycle/request';
import { createReq } from '../../../src/core/lifecycle/types';
import { metadata, readMeta, writeRecord } from '../../../src/core/runner/record';
import type { ClusterPlan } from '../../../src/core/kube/context';
import { load } from '../../../src/lib/presets/index';
import { resolve } from '../../../src/lib/versions';
import { PORT_LOCK } from '../../../src/core/lifecycle/ports';
import { heldBy, reproLock } from '../../../src/core/runner/locks';
import type * as CreateK8sNS from '../../../src/core/lifecycle/create-k8s';

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

describe('a Kubernetes create of the e2ee preset', () => {
  afterEach(() => {
    for (const module of [
      '../../../src/core/lifecycle/sizing',
      '../../../src/core/lifecycle/ports',
      '../../../src/core/lifecycle/tlsplan',
      '../../../src/core/kube/probe',
    ])
      jest.dontMock(module);
    jest.resetModules();
  });

  it.each([
    [
      'e2ee+ldap',
      { 'e2ee.policy': 'enforced', 'ldap.tls': 'starttls' },
      '8.5.1',
      'e2ee policy=enforced needs Rocket.Chat 8.8.0 or later; 8.5.1 would not enforce it.',
    ],
    [
      'voice',
      {},
      '7.13.0',
      'the voice preset needs Rocket.Chat 8.0.0 or later; 7.13.0 has the older Team Voice Calls.',
    ],
  ])(
    'refuses %s %j on %s before certificates, the cluster or the record',
    async (preset, params, version, said) => {
      jest.resetModules();
      const probe = jest.fn(async () => {
        throw new Error('reached the cluster');
      });
      const certificate = jest.fn(async () => {
        throw new Error('wrote a directory certificate');
      });
      jest.doMock('../../../src/core/lifecycle/sizing', () => ({
        checkCapacity: async () => undefined,
      }));
      jest.doMock('../../../src/core/lifecycle/ports', () => ({
        ...jest.requireActual('../../../src/core/lifecycle/ports'),
        pickHostPort: async () => 3391,
        claimSidePorts: preferredSidePorts,
      }));
      jest.doMock('../../../src/core/lifecycle/tlsplan', () => ({
        ...jest.requireActual('../../../src/core/lifecycle/tlsplan'),
        resolveTls: async () => null,
        issueDirectoryCertificate: certificate,
      }));
      jest.doMock('../../../src/core/kube/probe', () => ({ preflight: probe }));
      const create = require('../../../src/core/lifecycle/create-k8s') as typeof CreateK8sNS;
      const refused = create.createKubernetes(
        createReq({
          name: 'kube-too-old',
          version,
          preset,
          params,
          runtime: 'kubernetes',
          offline: true,
        }),
      );
      await expect(refused).rejects.toThrow(said);
      await expect(refused).rejects.toHaveProperty('exitCode', 2);
      expect(certificate).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
      await expect(readMeta('kube-too-old')).rejects.toThrow();
    },
  );
});

describe('a Kubernetes re-up of a handed-over workspace', () => {
  it('keeps its owner in the write-ahead record and in the completed one', async () => {
    // Every `up` rewrites the record: whoever brought it up became its owner again.
    const history = [{ from: 'mem2', to: 'mem', by: 'admin', at: '2026-10-12T13:00:00Z' }];
    await writeRecord(
      'kube-handed',
      metadata({
        name: 'kube-handed',
        project: 'houston-kube-handed',
        extra: { created_by: 'mem2', owner: 'mem', owner_history: history },
      }),
    );
    const job = kubeCreate({
      req: createReq({ version: '8.5.1', name: 'kube-handed', force: true }),
      emit: nullEmit,
      monitorAttach: missingMonitorAttach,
      reproName: 'kube-handed',
      reused: true,
      resolved: resolve('8.5.1', { offline: true }),
      presetForNotes: load('default', {}),
      plan: { context: 'c', distribution: 'k3s' } as ClusterPlan,
    });
    await settleEnv(job);
    await writeProvisionalRecord(job);
    expect((await readMeta(job.reproName)).extra).toMatchObject({
      owner: 'mem',
      owner_history: history,
    });
    job.out = { namespace: 'houston-kube-handed', context: 'c' };
    await buildRecord(job);
    recordTheRequest(job);
    expect(job.meta?.extra).toMatchObject({ owner: 'mem', owner_history: history });
  });
});

interface Settled {
  reg_token: string;
  bind_host: string;
  root: string;
  microservices: boolean;
  preset: string;
}

function ours(req: Parameters<typeof kubeCreate>[0]['req']): Settled {
  const job = kubeCreate({ req, emit: nullEmit, monitorAttach: missingMonitorAttach });
  settleAddressing(job);
  return {
    reg_token: job.regToken,
    bind_host: job.bindHost,
    root: job.root,
    microservices: job.microservices,
    preset: job.presetForNotes?.name ?? '',
  };
}

describe('settling a Kubernetes create', () => {
  it('reads a falsy recorded token as no token, exactly as earlier releases do', () => {
    // A config key holding `false` (or `0`) is NOT the string "false". `String(false)`
    // would make it a truthy licence token, which then reaches the chart through a
    // Secret -- the one field `--reg-token` exists to keep deliberate.
    config.updateConfig((cfg) => {
      cfg.reg_token = false;
      cfg.bind_host = false;
    });
    // What earlier releases settled each request to, over the same config, recorded.
    const recorded: Settled[] = [
      {
        reg_token: '',
        bind_host: '127.0.0.1',
        root: 'http://localhost:0',
        microservices: false,
        preset: 'default',
      },
      {
        reg_token: 'explicit',
        bind_host: '0.0.0.0',
        root: 'http://localhost:0',
        microservices: false,
        preset: 'default',
      },
    ];
    expect([
      ours(createReq({ version: '8.5.1' })),
      ours(createReq({ version: '8.5.1', regToken: 'explicit', bind: '0.0.0.0' })),
    ]).toEqual(recorded);
    expect(ours(createReq({ version: '8.5.1' })).reg_token).toBe('');
  });
});

describe('publishing the actual Kubernetes host-port allocation', () => {
  beforeEach(async () => {
    await fs.rm(config.reprosDir(), { recursive: true, force: true });
  });

  afterEach(async () => {
    await fs.rm(config.reprosDir(), { recursive: true, force: true });
  });

  function pending(name: string, values: Partial<Parameters<typeof createReq>[0]> = {}) {
    return kubeCreate({
      req: createReq({ version: '8.5.1', name, runtime: 'kubernetes', offline: true, ...values }),
      emit: nullEmit,
      monitorAttach: missingMonitorAttach,
      reproName: name,
      plan: { context: 'c', distribution: 'k3s' } as ClusterPlan,
    });
  }

  it.each([
    ['saml', 8081],
    ['oidc', 8085],
  ] as const)(
    'refuses an RC port also forwarded by LDAP idp=%s before publishing anything',
    async (idp, port) => {
      const job = pending(`dynamic-${idp}`, { preset: 'ldap', params: { idp }, port });
      await expect(resolvePairing(job)).rejects.toThrow(
        `--port ${String(port)} is also a port this workspace`,
      );
      const resolved = job.presetForNotes;
      expect(resolved?.ports).toEqual(expect.arrayContaining([8082, port]));
      settleAddressing(job);
      expect(job.presetForNotes).toBe(resolved);
      expect(job.provisional).toBeNull();
    },
  );

  it('refuses an RC port also requested for the local Grafana forward before publishing anything', async () => {
    const job = pending('self-grafana', { monitor: true, port: 5050 });
    await expect(resolvePairing(job)).rejects.toThrow('--port 5050 is also a port this workspace');
    expect(job.provisional).toBeNull();
  });

  it('publishes the local Grafana claim before unlock and retains it in the final record', async () => {
    const job = pending('grafana-first', { monitor: true });
    await reproLock(PORT_LOCK, async () => {
      await resolvePairing(job);
      settleAddressing(job);
      await writeProvisionalRecord(job);
      expect(heldBy(PORT_LOCK)).toBe(true);
      expect((await readMeta(job.reproName)).extra.monitoring_ports).toEqual([5050]);
    });
    expect(heldBy(PORT_LOCK)).toBe(false);
    const competing = pending('grafana-collision', { port: 5050 });
    await expect(resolvePairing(competing)).rejects.toThrow(/5050.*already claimed/u);
    expect(competing.provisional).toBeNull();
    job.out = { namespace: 'houston-grafana-first', context: 'c' };
    await buildRecord(job);
    await writeRecordStep(job);
    expect((await readMeta(job.reproName)).extra.monitoring_ports).toEqual([5050]);
  });

  it('gives a second local Grafana forward the next free port, and records it', async () => {
    // One monitored workspace per machine: a second `--monitor` on Kubernetes was refused
    // while the first one's forward held 5050.
    await writeRecord(
      'grafana-held',
      metadata({
        name: 'grafana-held',
        hostPort: 3417,
        extra: { monitoring: true, monitoring_ports: [5050] },
      }),
    );
    const job = pending('grafana-second', { monitor: true });
    await resolvePairing(job);
    settleAddressing(job);
    await writeProvisionalRecord(job);
    // Which free port depends on this machine; that it is not the held one does not.
    expect(job.monitoringPorts).toHaveLength(1);
    expect(job.monitoringPorts[0]).toBeGreaterThan(5050);
    expect((await readMeta(job.reproName)).extra.monitoring_ports).toEqual(job.monitoringPorts);
  });

  it('does not claim local monitoring ports for public ingress monitoring', async () => {
    await writeRecord('existing-grafana', metadata({ name: 'existing-grafana', hostPort: 5050 }));
    const job = pending('public-monitor', { monitor: true, domain: 'public.example.test' });
    await resolvePairing(job);
    settleAddressing(job);
    await writeProvisionalRecord(job);
    expect((await readMeta(job.reproName)).extra.monitoring_ports).toBeUndefined();
  });

  it('keeps the local Grafana allocation when monitoring comes back without --monitor', async () => {
    await writeRecord(
      'carried-grafana',
      metadata({
        name: 'carried-grafana',
        hostPort: 3418,
        extra: { monitoring: true, monitoring_ports: [5050] },
      }),
    );
    const job = pending('carried-grafana');
    job.reused = true;
    await settleEnv(job);
    await resolvePairing(job);
    settleAddressing(job);
    await writeProvisionalRecord(job);
    expect(job.req.monitor).toBe(true);
    expect((await readMeta(job.reproName)).extra.monitoring_ports).toEqual([5050]);
  });
});

describe('an unlicensed Kubernetes voice workspace', () => {
  it('is warned that it boots without a call button', () => {
    config.updateConfig((cfg) => {
      delete cfg.reg_token;
    });
    const events: Event[] = [];
    const job = kubeCreate({
      req: createReq({ version: '8.7.0', name: 'kvoice', preset: 'voice', runtime: 'kubernetes' }),
      emit: (e) => events.push(e),
      monitorAttach: missingMonitorAttach,
    });
    settleAddressing(job);
    expect(
      events.filter((e) => e.message.includes('Voice add-on (teams-voip)')).map((e) => e.level),
    ).toEqual(['warn']);
  });
});

describe('a name too long for a Kubernetes namespace', () => {
  it('is refused before anything is made, with the length a person may type', async () => {
    // `houston-<name>` is a namespace, a 63-character DNS label: kubectl refused a longer
    // one only once the create was under way.
    const events: Event[] = [];
    const job = kubeCreate({
      req: createReq({
        version: '8.5.1',
        name: `alice-${'a'.repeat(50)}`,
        actor: 'alice',
        runtime: 'kubernetes',
      }),
      emit: (e) => events.push(e),
      monitorAttach: missingMonitorAttach,
    });
    await expect(settleName(job)).rejects.toThrow(
      /namespace houston-alice-a{50} is 64 characters.*at most 49 characters, as houston puts 'alice-' in front of it/u,
    );
  });
});

describe("a Kubernetes create's result", () => {
  it('names the addresses a caller opens, as the Compose one does', async () => {
    // The GUI's create dialog showed no address for a Kubernetes workspace, and `up --json`
    // gave a script none: the result carried `url` and the record, not root_url/public_url.
    const job = kubeCreate({
      req: createReq({ version: '8.5.1', name: 'k1', runtime: 'kubernetes' }),
      emit: nullEmit,
      monitorAttach: missingMonitorAttach,
    });
    job.reproName = 'k1';
    job.root = 'http://localhost:3801';
    job.meta = metadata({
      name: 'k1',
      rootUrl: 'http://localhost:3801',
      publicUrl: 'https://k1.example.com',
    });
    expect(await finish(job)).toMatchObject({
      root_url: 'http://localhost:3801',
      public_url: 'https://k1.example.com',
    });
  });
});

describe('a Kubernetes workspace brought back', () => {
  async function reupNamespaceIdentity(
    name: string,
    extra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    await writeRecord(name, metadata({ name, project: `houston-${name}`, extra }));
    const job = kubeCreate({
      req: createReq({ version: '8.5.1', name, actor: 'mem', runtime: 'kubernetes' }),
      emit: nullEmit,
      monitorAttach: missingMonitorAttach,
      reproName: name,
      reused: true,
      resolved: resolve('8.5.1', { offline: true }),
      plan: { context: 'c', distribution: 'k3s' } as ClusterPlan,
      presetForNotes: load('default', {}),
    });
    await settleEnv(job);
    await writeProvisionalRecord(job);
    return (await readMeta(name)).extra;
  }

  it('keeps namespace UID and original namespace owner after handover and re-up', async () => {
    const extra = await reupNamespaceIdentity('khand', {
      namespace_uid: 'namespace-original-uid',
      namespace_owner: 'admin',
      created_by: 'admin',
      owner: 'mem',
    });
    expect(extra.namespace_uid).toBe('namespace-original-uid');
    expect(extra.namespace_owner).toBe('admin');
  });

  it('carries a legacy namespace creator before the caller rewrites created_by', async () => {
    const extra = await reupNamespaceIdentity('klegacyowner', {
      created_by: 'admin',
      owner: 'mem',
    });
    expect(extra.namespace_owner).toBe('admin');
  });

  it('preserves an explicitly anonymous namespace owner through an attributed re-up', async () => {
    const extra = await reupNamespaceIdentity('kanonymous', {
      namespace_uid: 'anonymous-namespace-uid',
      namespace_owner: '',
      created_by: 'admin',
    });
    expect(extra.namespace_owner).toBe('');
    expect(extra.namespace_uid).toBe('anonymous-namespace-uid');
  });

  it('keeps the admin password its database holds', async () => {
    // Its PersistentVolumeClaim survives `down`, and Rocket.Chat reads ADMIN_PASS only when
    // it fills an empty database: a new password on `up` was recorded and accepted by
    // nothing, so every houston login answered 401 after a re-up, seen live on a k3s lane.
    await writeRecord(
      'kpw',
      metadata({ name: 'kpw', project: 'houston-kpw', adminPassword: 'Kept-K8s-1' }),
    );
    const job = kubeCreate({
      req: createReq({ version: '8.5.1', name: 'kpw', runtime: 'kubernetes', bind: '0.0.0.0' }),
      emit: nullEmit,
      monitorAttach: missingMonitorAttach,
    });
    job.reproName = 'kpw';
    job.reused = true;
    job.bindHost = '0.0.0.0';
    job.resolved = resolve('8.5.1', { offline: true });
    job.plan = { context: 'c', distribution: 'k3s' } as ClusterPlan;
    job.presetForNotes = load('default', {});
    await writeProvisionalRecord(job);
    expect(job.adminPassword).toBe('Kept-K8s-1');
  });
});

describe("a Kubernetes create's image and port", () => {
  function job(name: string, extra: Partial<Parameters<typeof createReq>[0]> = {}) {
    return kubeCreate({
      req: createReq({ version: '8.5.1', name, runtime: 'kubernetes', offline: true, ...extra }),
      emit: nullEmit,
      monitorAttach: missingMonitorAttach,
    });
  }

  it('brings a workspace back on the image it ran, not the default repository', async () => {
    // Compose reuses the file that names the image; Kubernetes chose afresh, so a re-up of
    // an `--rc-image` workspace (or a CI build's ghcr image) swapped in the default one.
    await writeRecord(
      'kimg',
      metadata({ name: 'kimg', project: 'houston-kimg', rcImage: 'mirror.example/rc/rocket.chat' }),
    );
    const back = job('kimg');
    back.reproName = 'kimg';
    back.reused = true;
    await resolvePairing(back);
    expect(back.resolved?.rcImage).toBe('mirror.example/rc/rocket.chat');
  });

  it('refuses to bring a workspace back on another Rocket.Chat version', async () => {
    // A re-up re-applies the chart: `up -v 8.5.1` on a workspace upgraded to 8.6.1 moved
    // Rocket.Chat back down over a database 8.6.1 had already migrated.
    await writeRecord(
      'kver',
      metadata({ name: 'kver', project: 'houston-kver', rcVersion: '8.6.1', mongoTag: '8.0' }),
    );
    const back = job('kver');
    back.reproName = 'kver';
    back.reused = true;
    await expect(resolvePairing(back)).rejects.toThrow(
      "'kver' runs Rocket.Chat 8.6.1, and this asks for 8.5.1",
    );
  });

  it('refuses to bring back under the operator a workspace whose MongoDB houston ran', async () => {
    // The operator keeps its data in a claim of its own: brought back with --mongo-operator,
    // the workspace came up empty, its data in a claim nothing read until `down --volumes`
    // deleted it.
    await writeRecord(
      'kop',
      metadata({
        name: 'kop',
        project: 'houston-kop',
        rcVersion: '8.5.1',
        mongoTag: '8.0',
        extra: { mongo_managed_by: 'statefulset' },
      }),
    );
    const back = job('kop', { mongoOperator: true });
    back.reproName = 'kop';
    back.reused = true;
    await expect(resolvePairing(back)).rejects.toThrow(
      "'kop' keeps its data in a MongoDB houston runs itself, and this would bring it back " +
        'under the MongoDB operator',
    );
    // As it was, it comes back.
    const same = job('kop');
    same.reproName = 'kop';
    same.reused = true;
    await expect(resolvePairing(same)).resolves.toBeUndefined();
  });

  it('brings a workspace back on the MongoDB it ran, not a fresh pairing', async () => {
    // The pairing was looked up again on every re-up, and the GUI's Start looks it up
    // offline while the CLI asks releases.rocket.chat: the two could swap MongoDB under the
    // same data.
    await writeRecord(
      'kmongo',
      metadata({ name: 'kmongo', project: 'houston-kmongo', rcVersion: '8.5.1', mongoTag: '7.0' }),
    );
    const back = job('kmongo');
    back.reproName = 'kmongo';
    back.reused = true;
    await resolvePairing(back);
    expect(back.resolved?.mongoTag).toBe('7.0');
  });

  it('still keeps its version after a re-up that failed half way', async () => {
    // Every re-up's write-ahead record said `incomplete`, and a re-up that failed left it so:
    // the next `up` read a half-made workspace with nothing to keep, and went down a version.
    const born = '2026-10-01T09:00:00+00:00';
    await writeRecord(
      'kfail',
      metadata({
        name: 'kfail',
        project: 'houston-kfail',
        rcVersion: '8.5.1',
        mongoTag: '8.0',
        createdAt: born,
      }),
    );
    const first = job('kfail');
    first.reproName = 'kfail';
    first.reused = true;
    await settleEnv(first);
    await resolvePairing(first);
    first.plan = { context: 'c', distribution: 'k3s' } as ClusterPlan;
    first.presetForNotes = load('default', {});
    await writeProvisionalRecord(first);
    // ...and the re-up dies here, leaving its write-ahead record.
    const left = await readMeta('kfail');
    expect([left.extra.incomplete, left.createdAt]).toEqual([false, born]);
    const second = job('kfail', { version: '8.4.0' });
    second.reproName = 'kfail';
    second.reused = true;
    await settleEnv(second);
    await expect(resolvePairing(second)).rejects.toThrow(
      "'kfail' runs Rocket.Chat 8.5.1, and this asks for 8.4.0",
    );
  });

  it('keeps a workspace pinned when it comes back without --pin', async () => {
    // The record is rewritten on a re-up with `pinned: --pin`, so a plain `up` after `down`
    // unpinned it, and the next `prune` took it.
    await writeRecord('kpin', metadata({ name: 'kpin', project: 'houston-kpin', pinned: true }));
    const back = job('kpin');
    back.reproName = 'kpin';
    back.reused = true;
    await resolvePairing(back);
    back.plan = { context: 'c', distribution: 'k3s' } as ClusterPlan;
    back.presetForNotes = load('default', {});
    await writeProvisionalRecord(back);
    expect(back.provisional?.pinned).toBe(true);
  });

  it('brings monitoring back with a workspace that had it, without --monitor', async () => {
    // The record is rewritten on a re-up and only an attach writes `monitoring`: a workspace
    // brought back without `--monitor` lost its Grafana link, while the stack, its Ingress
    // and the namespace label were all still in the cluster.
    await writeRecord(
      'kmon',
      metadata({ name: 'kmon', project: 'houston-kmon', extra: { monitoring: true } }),
    );
    const back = job('kmon');
    back.reproName = 'kmon';
    back.reused = true;
    await settleEnv(back);
    expect(back.req.monitor).toBe(true);
  });

  it('takes a set recorded as typed back under its canonical spelling', async () => {
    // A create with `--preset ldap+email` recorded `ldap+email`, and `up --preset email
    // --preset ldap` was then refused: "runs the ldap+email presets and this asks for
    // email+ldap".
    await writeRecord(
      'kset',
      metadata({ name: 'kset', project: 'houston-kset', preset: 'ldap+email' }),
    );
    const back = job('kset', { preset: 'email+ldap' });
    back.reproName = 'kset';
    back.reused = true;
    await expect(settleEnv(back)).resolves.toBeUndefined();
  });

  it('refuses a CI build before anything is made, as the chart cannot run one', async () => {
    // The chart compares its image tag as a semantic version, so helm refused `develop`
    // after MongoDB was already up: exit 7, every time, with no values combination that
    // pulls the build.
    const build = kubeCreate({
      req: createReq({ version: 'develop', name: 'kci', runtime: 'kubernetes' }),
      emit: nullEmit,
      monitorAttach: missingMonitorAttach,
      versionFetcher: () => ({ status: 200, json: () => ({ version: '8.10.0-develop' }) }),
    });
    build.reproName = 'kci';
    await expect(resolvePairing(build)).rejects.toThrow('Run CI builds on Docker');
    // And one recorded as a build, brought back.
    const recorded = job('kci2', { version: '8.10.0.dev0' });
    recorded.reproName = 'kci2';
    await expect(resolvePairing(recorded)).rejects.toThrow('Run CI builds on Docker');
  });

  it('refuses a port something else holds before anything is made', async () => {
    // Taken on trust, the whole workspace deployed, the forward found the port held, and
    // `up` ended exit 8 with the workspace left running.
    const holder = net.createServer();
    await new Promise<void>((done) => holder.listen(0, '127.0.0.1', done));
    const port = (holder.address() as net.AddressInfo).port;
    try {
      const fresh = job('kport', { port });
      fresh.reproName = 'kport';
      await expect(resolvePairing(fresh)).rejects.toThrow(`port ${String(port)} is already in use`);
    } finally {
      await new Promise((done) => holder.close(done));
    }
  });

  it('refuses an RC port that the requested Kubernetes preset also forwards', async () => {
    const fresh = job('kselfport', { preset: 'email', port: 8025 });
    fresh.reproName = 'kselfport';
    await expect(resolvePairing(fresh)).rejects.toThrow(
      '--port 8025 is also a port this workspace',
    );
    expect(fresh.provisional).toBeNull();
  });
});
