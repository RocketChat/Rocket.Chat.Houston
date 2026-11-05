import * as fs from 'node:fs';
import * as path from 'node:path';

import { CONTEXT as KUBE_CONTEXT } from '../../../src/core/kube/names';
import type { PodRow } from '../../../src/core/kube/status';
import { workspace } from '../../../src/core/runner/paths';
import { type Metadata, metadata, toDocument, write } from '../../../src/core/runner/record';
import * as topology from '../../../src/core/topology';

import {
  degradedReason,
  grafanaFrameOrigins,
  reproLinks,
  reproState,
  rowFor,
  summary,
  uptimeHealth,
} from '../../../src/core/lifecycle/inspect';
import { type NoteGroup, flattenNotes } from '../../../src/core/lifecycle/notes';

import type * as PolicyNS from '../../testsetup-policy';
import type * as HostNS from '../../../src/core/runner/host';
import type * as PayloadNS from '../../../src/core/lifecycle/payload';
import type * as InspectNS from '../../../src/core/lifecycle/inspect';
import type * as CapabilitiesNS from '../../../src/core/kube/capabilities';
import type * as NamespaceNS from '../../../src/core/kube/namespace';
import type * as StatusNS from '../../../src/core/kube/status';
import type * as RecordNS from '../../../src/core/runner/record';
import type * as KubeExecNS from '../../../src/core/kube/exec';

// `runner/host` is a GUARDED module and two cases here own it; the suite's healthy engine
// goes back after each one rather than the real module's answers leaking into the next.
afterEach(() => {
  jest.doMock('../../../src/core/runner/host', () =>
    (require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
  );
  jest.dontMock('../../../src/core/lifecycle/inspect');
  jest.dontMock('../../../src/core/kube/status');
  jest.dontMock('../../../src/core/kube/capabilities');
  jest.dontMock('../../../src/core/kube/namespace');
  jest.dontMock('../../../src/core/kube/exec');
  jest.dontMock('../../../src/core/runner/record');
  jest.resetModules();
});

/**
 * What earlier releases answered, recorded: `derived` is state, health, links and summary for
 * the cases below; `browserFixtureDetail` is the detail payload their browser tests rendered
 * the panel from.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'core', 'lifecycle', 'inspect.json'),
    'utf8',
  ),
) as { derived: Record<string, unknown>; browserFixtureDetail: Record<string, unknown> };

const STATUSES = [
  'Up 2 hours (healthy)',
  'Up 3 days (Paused)',
  'Restarting (1) 5 seconds ago',
  'Exited (0) 2 hours ago',
  'Created',
  'Dead',
  'Up 5 minutes (health: starting)',
  '',
  'UP 1 second',
];

const STATUS_CASES: [string, boolean][] = [
  ['Up 2 hours (healthy)', true],
  ['Restarting (1) 5 seconds ago', true],
  ['Exited (0) 2 hours ago', true],
  ['Created', true],
  ['', true],
  ['', false],
  ['UP 1 second', false],
];

const SERVICES = [
  { mongodb: 'Up 3 hours (healthy)', rocketchat: 'Up 2 hours (healthy)' },
  { mongodb: 'Exited (0) 5 minutes ago', rocketchat: 'Up 2 hours' },
  { mongodb: 'Restarting (1) 5 seconds ago' },
  {},
];

describe('what a workspace is right now', () => {
  it('derives state, health and links the way earlier releases do', async () => {
    const recorded = RECORDED.derived;
    const meta = metadata({
      name: 'T-1',
      project: 'houston-T-1',
      rcVersion: '8.5.1',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3100',
      hostPort: 3100,
      createdAt: '2026-01-01T00:00:00+00:00',
      extra: {
        runtime: 'docker',
        deployment: 'monolith',
        instances: 2,
        monitoring: true,
        created_by: 'alice',
        bind_host: '127.0.0.1',
      },
    });
    expect({
      state: STATUS_CASES.map(([status, flag]) => reproState(status, flag)),
      uptime: STATUSES.map((status) => [...uptimeHealth(status)]),
      degraded: SERVICES.map(degradedReason),
      links: reproLinks(meta),
      summary: await summary(meta),
    }).toEqual(recorded);
  });

  it("gives an HTTPS workspace's public address in the summary `up` and the GUI return", async () => {
    // `up --json` and the create dialog offered only the http://localhost port, which from
    // another machine names that machine.
    const https = metadata({ name: 'w', publicUrl: 'https://w.example.com' });
    expect(await summary(https)).toMatchObject({ public_url: 'https://w.example.com' });
    expect((await summary(metadata({ name: 'plain' }))).public_url).toBe('');
  });

  it('names the cluster a Kubernetes workspace runs in, and nothing for a Compose one', async () => {
    // The record held the context all along; the panel and `list` showed "k8s" and an ARN
    // in a note card. The short name is what a person recognises, the context what a
    // command needs, and both are ALWAYS present so the payload's shape does not drift.
    const kube = metadata({
      name: 't1',
      extra: { runtime: 'kubernetes', context: 'arn:aws:eks:us-east-1:1:cluster/support' },
    });
    expect(await summary(kube)).toMatchObject({
      context: 'arn:aws:eks:us-east-1:1:cluster/support',
      cluster: 'support',
    });
    expect(await summary(metadata({ name: 'c1' }))).toMatchObject({ context: '', cluster: '' });
  });

  it('returns every key the browser fixture renders from', async () => {
    // The payload-shape trap, closed on this side too: the detail payload earlier releases'
    // browser tests rendered the panel from is recorded here, so a key the real payload adds
    // and the fixture lacks breaks the panel in production with the whole suite green. The
    // invariant is `real ⊆ fake`; this asserts it against that recorded fixture.
    const fake = RECORDED.browserFixtureDetail;

    const meta = metadata({
      name: 'cmp',
      project: 'houston-cmp',
      rcVersion: '8.5.1',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3101',
      hostPort: 3101,
      createdAt: '2026-01-01T00:00:00+00:00',
      extra: { runtime: 'docker', deployment: 'monolith', bind_host: '127.0.0.1' },
    });
    await write(
      'cmp',
      'services:\n  rocketchat:\n    image: i\n    ports:\n      - 127.0.0.1:3101:3000\n',
      meta,
    );
    // Docker cannot be asked from a unit test. `dockerAvailable` is the only stub, and it
    // is spread over the real module so its shape cannot drift from the real one.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/host', () => ({
      ...jest.requireActual('../../../src/core/runner/host'),
      dockerAvailable: async () => false,
    }));
    const payload = require('../../../src/core/lifecycle/payload') as typeof PayloadNS;
    const d = (await payload.detail('cmp')) as Record<string, unknown>;
    // THE DIRECTION IS real ⊆ fake: every key the real payload returns must exist in the
    // fixture. A key that is only real would be read by production and missing from every
    // test -- and the fixture being a superset is by design (it is the union of both
    // runtime branches).
    const unrendered = Object.keys(d).filter((key) => !(key in fake));
    expect(unrendered).toEqual([]);
    // And a shared key must be the same SHAPE, not merely present: `env` as a dict where
    // detail() returns rows is a blank tab, not an error.
    for (const key of Object.keys(d)) {
      if (d[key] === null || fake[key] === null || fake[key] === undefined) continue;
      expect(Array.isArray(d[key])).toBe(Array.isArray(fake[key]));
    }
    // The keys the panel ITERATES must be arrays, not undefined or strings.
    expect(Array.isArray(d.env)).toBe(true);
    expect(Array.isArray(d.notes)).toBe(true);
    expect(Array.isArray(d.note_groups)).toBe(true);
    expect(Array.isArray(d.links)).toBe(true);
    expect(Array.isArray(d.owner_history)).toBe(true);
    expect(typeof d.tls).toBe('string');
    // What the pane's "Roll back to <version>" reads: always a string, "" for none.
    expect(d.rollback_to).toBe('');
    expect(d.seed).toBeNull();
  });
});

function linksMeta(preset: string, extra: Record<string, unknown> = {}): Metadata {
  return metadata({
    name: 'r',
    project: 'p',
    rcVersion: '8.5.1',
    rcImage: 'i',
    mongoTag: '8.0',
    mongoFlavor: 'official',
    preset,
    rootUrl: 'http://localhost:8300',
    hostPort: 8300,
    versionSource: 'x',
    extra,
  });
}

/** A recorded Kubernetes workspace with NO compose file -- the condition these share. */
function kubeWorkspace(name: string, preset: string): Metadata {
  const meta = metadata({
    name,
    project: 'p',
    rcVersion: '8.6.1',
    rcImage: 'i',
    mongoTag: '8.0',
    mongoFlavor: 'official',
    preset,
    rootUrl: 'http://localhost:3010',
    hostPort: 3010,
    versionSource: 't',
  });
  topology.stamp(meta.extra, topology.KUBERNETES);
  Object.assign(meta.extra, {
    context: KUBE_CONTEXT,
    namespace: `houston-${name}`,
    bind_host: '127.0.0.1',
  });
  fs.mkdirSync(workspace(name), { recursive: true });
  fs.writeFileSync(path.join(workspace(name), 'repro.json'), JSON.stringify(toDocument(meta)));
  expect(fs.existsSync(path.join(workspace(name), 'docker-compose.yml'))).toBe(false);
  return meta;
}

describe('reading a container status', () => {
  it('names every state the rocketchat container can be in', () => {
    // "No rocketchat container" splits on whether anything else survives.
    expect(reproState('', false)).toBe('down');
    expect(reproState('', true)).toBe('stopped');
    expect(reproState('Up 2 hours (healthy)', true)).toBe('running');
    expect(reproState('Up 5 seconds (health: starting)', true)).toBe('running');
    expect(reproState('Exited (0) 2 minutes ago', true)).toBe('stopped');
    expect(reproState('Created', true)).toBe('created');
    expect(reproState('Dead', true)).toBe('dead');
    // Docker reports a paused container as "Up ... (Paused)": it must not read as running.
    expect(reproState('Up 3 days (Paused)', true)).toBe('paused');
    // The regression: a crash-looping RC read as "running" in the list (the healthy
    // Mongo's aggregate) and "stopped" in the detail. Both had to become "restarting".
    expect(reproState('Restarting (1) 5 seconds ago', true)).toBe('restarting');
  });

  it('reads the uptime and the health out of the status', () => {
    expect(uptimeHealth('Up 2 hours (healthy)')).toEqual(['2 hours', 'healthy']);
    expect(uptimeHealth('Up 47 minutes')).toEqual(['47 minutes', '']);
    expect(uptimeHealth('Exited (0) 5 minutes ago')).toEqual(['', '']);
    expect(uptimeHealth('')).toEqual(['', '']);
  });

  it("reports a transitional health without docker's string prefix", () => {
    // Taken verbatim the panel rendered "Health: health: starting". The prefix belongs to
    // the string format, not to the value.
    expect(uptimeHealth('Up 4 seconds (health: starting)')).toEqual(['4 seconds', 'starting']);
    expect(uptimeHealth('Up 2 hours (healthy)')).toEqual(['2 hours', 'healthy']);
    expect(uptimeHealth('Up 5 minutes (unhealthy)')).toEqual(['5 minutes', 'unhealthy']);
    // No healthcheck at all, and a stopped container, are both "no health".
    expect(uptimeHealth('Up 3 minutes')).toEqual(['3 minutes', '']);
    expect(uptimeHealth('Exited (0) 1 minute ago')).toEqual(['', '']);
  });
});

describe('the links a workspace publishes', () => {
  it.each([
    ['172.18.0.7', 'http://localhost:3300', '172.18.0.7'],
    ['2001:db8::7', 'http://localhost:3300', '[2001:db8::7]'],
    ['', 'http://172.18.0.8:3300', '172.18.0.8'],
    ['', 'http://[2001:db8::8]:3300', '[2001:db8::8]'],
  ])(
    'uses the actual published host for preset, LDAP IdP and replica links (bind=%s)',
    async (bindHost, rootUrl, host) => {
      const meta = metadata({
        name: 'bound',
        preset: 'email+ldap+s3_minio+multi-instance',
        hostPort: 3300,
        rootUrl,
        extra: {
          runtime: 'docker',
          deployment: 'multi-instance',
          instances: 2,
          bind_host: bindHost,
          preset_params: { ldap: { idp: 'saml' } },
        },
      });
      expect(
        Object.fromEntries(reproLinks(meta).map((link) => [link.label, link.url])),
      ).toMatchObject({
        Mailpit: `http://${host}:8025`,
        phpLDAPadmin: `http://${host}:8082`,
        Keycloak: `http://${host}:8081`,
        'MinIO API': `http://${host}:9000`,
        'MinIO console': `http://${host}:9001`,
        'instance 1': `http://${host}:3301`,
        'instance 2': `http://${host}:3302`,
      });
      expect((await summary(meta)).instance_urls).toEqual([
        `http://${host}:3301`,
        `http://${host}:3302`,
      ]);
    },
  );

  it('keeps loopback and wildcard links on localhost and public preset paths on their origin', () => {
    for (const bind of ['127.0.0.1', '::1', '0.0.0.0', '::']) {
      expect(
        reproLinks(linksMeta('email', { bind_host: bind })).find((link) => link.label === 'Mailpit')
          ?.url,
      ).toBe('http://localhost:8025');
    }
    const meta = linksMeta('email+s3_minio', {
      bind_host: '172.18.0.7',
      public_paths: [
        {
          preset: 'email',
          path: '/mailpit',
          service: 'mailpit',
          container_port: 8025,
          service_port: 8025,
        },
      ],
    });
    meta.publicUrl = 'https://bound.example.com';
    expect(
      Object.fromEntries(reproLinks(meta).map((link) => [link.label, link.url])),
    ).toMatchObject({
      Mailpit: 'https://bound.example.com/mailpit/',
      'MinIO API': 'http://172.18.0.7:9000',
    });
  });

  it.each([
    ['docker', 'local', 'https://h', 'https://h/grafana'],
    ['docker', 'acme', 'https://h', 'https://h/grafana'],
    ['kubernetes', 'local', 'https://h', 'https://h/grafana'],
    ['kubernetes', '', '', 'http://localhost:5050/grafana'],
  ])(
    'Grafana public URL regression: reports %s TLS=%s in every payload',
    async (runtime, tls, publicUrl, expected) => {
      const meta = metadata({
        name: 'w',
        project: 'houston-w',
        rootUrl: 'http://localhost:3310',
        hostPort: 3310,
        publicUrl,
        extra: { runtime, tls, monitoring: true, namespace: 'houston-w' },
      });
      expect((await summary(meta)).grafana_url).toBe(expected);
      expect(reproLinks(meta).find((link) => link.label === 'Grafana')?.url).toBe(expected);
      expect(
        (
          await rowFor(meta, {
            default: '',
            dockerUp: false,
            states: {},
            statusMap: {},
            svcMap: {},
          })
        ).grafana_url,
      ).toBe(expected);
      // Docker publishes Prometheus on 9090; Kubernetes forwards only Grafana, and a link to
      // 9090 there answered nothing.
      expect(reproLinks(meta).find((link) => link.label === 'Prometheus')?.url).toBe(
        runtime === 'kubernetes' ? undefined : 'http://localhost:9090',
      );
    },
  );
  it('names the address a person opens, the one `--root-url` advertised included', async () => {
    // Every "Open" took `public_url || root_url`, and with `--root-url` (a tunnel, a proxy)
    // that is http://localhost -- measured on testin6.kestron.org, served there all along.
    const answers = { default: '', dockerUp: false, states: {}, statusMap: {}, svcMap: {} };
    const at = (values: Partial<Metadata>) =>
      metadata({ name: 'w', rootUrl: 'http://localhost:3014', hostPort: 3014, ...values });
    const tunnelled = at({ extra: { advertised_url: 'https://w.example.test' } });
    expect((await summary(tunnelled)).open_url).toBe('https://w.example.test');
    expect((await rowFor(tunnelled, answers)).open_url).toBe('https://w.example.test');
    const https = at({ publicUrl: 'https://h.example.test' });
    expect((await rowFor(https, answers)).open_url).toBe('https://h.example.test');
    expect((await summary(at({}))).open_url).toBe('http://localhost:3014');
  });
  it('never lends a Kubernetes row the uptime of Docker containers left under its name', async () => {
    // 2.1.1's takeover left a Docker workspace's containers running under the Kubernetes
    // record that replaced it, and `list` showed their uptime and health as the namespace's.
    const answers = {
      default: '',
      dockerUp: true,
      states: { 'houston-w': 'running(2)' },
      statusMap: { 'houston-w': 'Up 3 hours (healthy)' },
      svcMap: {},
    };
    const kube = metadata({ name: 'w', project: 'houston-w', extra: { runtime: 'kubernetes' } });
    const row = await rowFor(kube, answers);
    expect(row.uptime).toBe('');
    expect(row.health).not.toBe('healthy');
    const docker = metadata({ name: 'w', project: 'houston-w', extra: { runtime: 'docker' } });
    expect(await rowFor(docker, answers)).toMatchObject({ uptime: '3 hours', health: 'healthy' });
  });
  it('keeps a Docker loopback workspace and a customer proxy on the original Grafana URL', async () => {
    for (const meta of [
      metadata({ extra: { monitoring: true } }),
      metadata({ publicUrl: 'https://h', rootUrl: 'https://h', extra: { monitoring: true } }),
    ]) {
      expect((await summary(meta)).grafana_url).toBe('http://localhost:5050');
    }
  });
  it("links a second workspace's own side services and monitoring, never the preferred ports", async () => {
    // A link built from the registry opens SOMEONE ELSE's Mailpit, Keycloak or Grafana.
    const byLabel = (meta: Metadata) =>
      Object.fromEntries(reproLinks(meta).map((link) => [link.label, link.url]));
    const moved = linksMeta('email+ldap', {
      runtime: 'docker',
      preset_params: { ldap: { idp: 'saml' } },
      side_ports: { email: [8026], ldap: [8083], saml: [8084] },
      monitoring: true,
      monitoring_ports: [9091, 5051],
    });
    expect(byLabel(moved)).toMatchObject({
      Mailpit: 'http://localhost:8026',
      phpLDAPadmin: 'http://localhost:8083',
      Keycloak: 'http://localhost:8084',
      Grafana: 'http://localhost:5051',
      Prometheus: 'http://localhost:9091',
    });
    // A record written before ports could move keeps answering what it runs.
    const older = linksMeta('email+ldap', {
      runtime: 'docker',
      preset_params: { ldap: { idp: 'saml' } },
      monitoring: true,
    });
    expect(byLabel(older)).toMatchObject({
      Mailpit: 'http://localhost:8025',
      phpLDAPadmin: 'http://localhost:8082',
      Keycloak: 'http://localhost:8081',
      Grafana: 'http://localhost:5050',
      Prometheus: 'http://localhost:9090',
    });
    expect((await summary(moved)).grafana_url).toBe('http://localhost:5051');
  });

  it("lets the GUI frame each monitored workspace's own Grafana", async () => {
    // The k6 dashboard is an iframe; a page allowing only localhost:5050 refused a second
    // monitored workspace's Grafana.
    await write(
      'watched',
      'services: {}\n',
      metadata({ ...linksMeta('default'), name: 'watched', extra: { monitoring: true } }),
    );
    await write(
      'second',
      'services: {}\n',
      metadata({
        ...linksMeta('default'),
        name: 'second',
        extra: { monitoring: true, monitoring_ports: [9091, 5051] },
      }),
    );
    expect(await grafanaFrameOrigins()).toEqual(['http://localhost:5050', 'http://localhost:5051']);
    for (const name of ['watched', 'second']) fs.rmSync(workspace(name), { recursive: true });
  });

  it("surfaces each scenario's own UI, the monitoring pair and every instance", () => {
    const byLabel = (meta: Metadata) =>
      Object.fromEntries(reproLinks(meta).map((link) => [link.label, link.url]));
    const s3 = byLabel(linksMeta('s3_minio'));
    expect(s3['Rocket.Chat']).toBe('http://localhost:8300');
    expect(Object.keys(s3)).toEqual(expect.arrayContaining(['MinIO console', 'MinIO API']));
    const oidc = byLabel(linksMeta('oidc'));
    expect(oidc.Keycloak).toMatch(/^http:\/\/localhost:/u);
    expect(Object.keys(byLabel(linksMeta('default', { monitoring: true })))).toEqual(
      expect.arrayContaining(['Grafana', 'Prometheus']),
    );
    expect(Object.keys(byLabel(linksMeta('multi-instance', { instances: 3 })))).toEqual(
      expect.arrayContaining(['instance 1', 'instance 2', 'instance 3']),
    );
  });

  it('links the webhook inbox to the session the receiver chose, on the port the workspace holds', () => {
    // The receiver's root page opens a NEW, empty session: the link has to name ours, and
    // ours exists once post-ready made it and recorded the id the receiver chose.
    const byLabel = (meta: Metadata) =>
      Object.fromEntries(reproLinks(meta).map((link) => [link.label, link.url]));
    expect(byLabel(linksMeta('webhooks'))['Webhook inbox']).toBeUndefined();
    const hooks = { webhooks: { session: 'ses-9' } };
    expect(byLabel(linksMeta('webhooks', hooks))['Webhook inbox']).toBe(
      'http://localhost:8086/s/ses-9',
    );
    expect(
      byLabel(linksMeta('webhooks', { ...hooks, side_ports: { webhooks: [8087] } }))[
        'Webhook inbox'
      ],
    ).toBe('http://localhost:8087/s/ses-9');
    // A workspace without the preset never links one, whatever its record says.
    expect(byLabel(linksMeta('email', hooks))['Webhook inbox']).toBeUndefined();
  });
});

describe('listing several Kubernetes workspaces', () => {
  function records(): Metadata[] {
    return Array.from({ length: 8 }, (_unused, index) =>
      metadata({
        name: `list-${String(index)}`,
        project: `houston-list-${String(index)}`,
        rootUrl: `http://localhost:${String(3300 + index)}`,
        hostPort: 3300 + index,
        extra: { runtime: 'kubernetes', context: index < 4 ? 'first' : 'second' },
      }),
    );
  }

  function clusterList(
    metas: Metadata[],
    namespaces: (context?: string) => Promise<string[] | null>,
    replicas: (name: string) => Promise<number | null>,
  ): typeof InspectNS {
    jest.resetModules();
    jest.doMock('../../../src/core/runner/host', () => ({
      ...(require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
      dockerAvailable: async () => false,
    }));
    jest.doMock('../../../src/core/runner/record', () => ({
      ...(jest.requireActual('../../../src/core/runner/record') as typeof RecordNS),
      listMeta: async () => metas,
    }));
    jest.doMock('../../../src/core/kube/capabilities', () => ({
      ...(jest.requireActual('../../../src/core/kube/capabilities') as typeof CapabilitiesNS),
      workspaceNamespaces: namespaces,
    }));
    jest.doMock('../../../src/core/kube/namespace', () => ({
      ...(jest.requireActual('../../../src/core/kube/namespace') as typeof NamespaceNS),
      namespaceFor: async (name: string) => `houston-${name}`,
    }));
    jest.doMock('../../../src/core/kube/status', () => ({
      ...(jest.requireActual('../../../src/core/kube/status') as typeof StatusNS),
      workloadReplicas: replicas,
      workspaceReady: async () => true,
      workspaceReplicasByNamespace: async () => null,
      workspacePodsByNamespace: async () => null,
    }));
    return require('../../../src/core/lifecycle/inspect') as typeof InspectNS;
  }

  it('overlaps independent workspace probes with a bounded batch and preserves record order', async () => {
    const metas = records();
    const gates = new Map<string, { held: Promise<number>; release: () => void }>();
    for (const meta of metas) {
      let release!: () => void;
      const held = new Promise<number>((resolve) => {
        release = () => resolve(1);
      });
      gates.set(meta.name, { held, release });
    }
    const started: string[] = [];
    let active = 0;
    let maximum = 0;
    const inspect = clusterList(
      metas,
      async () => metas.map((meta) => `houston-${meta.name}`),
      async (name) => {
        started.push(name);
        active += 1;
        maximum = Math.max(maximum, active);
        try {
          return await gates.get(name)!.held;
        } finally {
          active -= 1;
        }
      },
    );
    const listing = inspect.listRepros();
    try {
      for (let turn = 0; turn < 10; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(started).toHaveLength(4);
      expect(maximum).toBe(4);
      for (const name of [...started].reverse()) gates.get(name)!.release();
      for (let turn = 0; turn < 10; turn += 1)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(started).toHaveLength(8);
      expect(maximum).toBe(4);
      for (const name of [...started].reverse()) gates.get(name)!.release();
      expect((await listing).map((row) => row.name)).toEqual(metas.map((meta) => meta.name));
    } finally {
      for (const gate of gates.values()) gate.release();
      await listing;
    }
  });

  it('shares namespace reads only within one list call and refreshes each context on the next poll', async () => {
    const metas = records();
    let reachable = true;
    const namespaces = jest.fn(async () =>
      reachable ? metas.map((meta) => `houston-${meta.name}`) : null,
    );
    const inspect = clusterList(metas, namespaces, async () => 0);
    expect((await inspect.listRepros()).map((row) => row.state)).toEqual(Array(8).fill('stopped'));
    expect(namespaces.mock.calls).toEqual([['first'], ['second']]);
    reachable = false;
    expect((await inspect.listRepros()).map((row) => row.state)).toEqual(Array(8).fill('?'));
    expect(namespaces.mock.calls).toEqual([['first'], ['second'], ['first'], ['second']]);
  });

  it('keeps absent namespaces down and unreadable namespaces unknown even when workload reads fail', async () => {
    const metas = records();
    const namespaces = jest.fn(async (context?: string) => (context === 'first' ? [] : null));
    const inspect = clusterList(metas, namespaces, async () => {
      throw new Error('workload read refused');
    });
    expect((await inspect.listRepros()).map((row) => row.state)).toEqual([
      'down',
      'down',
      'down',
      'down',
      '?',
      '?',
      '?',
      '?',
    ]);
    expect(namespaces).toHaveBeenCalledTimes(2);
  });
});

describe('listing fresh Kubernetes workload snapshots', () => {
  type PodDocument = {
    metadata: { namespace: string; name: string; labels: Record<string, string> };
    status: Record<string, unknown>;
  };

  function fixture(count = 8) {
    const metas = Array.from({ length: count }, (_unused, index) =>
      metadata({
        name: `snapshot-${String(index)}`,
        project: `houston-snapshot-${String(index)}`,
        hostPort: 3300 + index,
        rootUrl: `http://localhost:${String(3300 + index)}`,
        extra: {
          runtime: 'kubernetes',
          context: index < 4 ? 'first' : 'second',
          namespace: `recorded-space-${String(index)}`,
        },
      }),
    );
    return {
      metas,
      held: new Set(metas.map((meta) => String(meta.extra.namespace))),
      replicas: new Map(metas.map((meta) => [String(meta.extra.namespace), 1 as number | null])),
      ready: new Map(metas.map((meta) => [String(meta.extra.namespace), true])),
      terminal: new Set<string>(),
      broadRefused: new Set<string>(),
      broadMalformed: new Set<string>(),
      namespacesRefused: new Set<string>(),
      scopedRefused: new Set<string>(),
    };
  }

  function snapshotList(data: ReturnType<typeof fixture>) {
    jest.resetModules();
    jest.dontMock('../../../src/core/kube/status');
    jest.dontMock('../../../src/core/kube/capabilities');
    const run = jest.fn<Promise<KubeExecNS.KubectlResult>, [readonly string[]]>(async (argv) => {
      const output = (doc?: unknown): KubeExecNS.KubectlResult => ({
        argv,
        returncode: 0,
        stdout: doc === undefined ? '' : JSON.stringify(doc),
        stderr: '',
      });
      const denied = (): KubeExecNS.KubectlResult => ({
        argv,
        returncode: 1,
        stdout: '',
        stderr: 'Error from server (Forbidden): this identity cannot list that collection',
      });
      if (argv[0] === 'helm') return output([]);
      const context = argv[argv.indexOf('--context') + 1];
      const requestedKind = argv[argv.indexOf('get') + 1] ?? '';
      const kind = requestedKind === 'pods' ? 'pod' : requestedKind;
      const broad = argv.includes('-A');
      const namespace = argv.includes('-n') ? argv[argv.indexOf('-n') + 1] : '';
      const metas = data.metas.filter((meta) => meta.extra.context === context);
      if (kind === 'namespace') {
        if (data.namespacesRefused.has(String(context))) return denied();
        return output({
          items: metas
            .filter((meta) => data.held.has(String(meta.extra.namespace)))
            .map((meta) => ({ metadata: { name: meta.extra.namespace } })),
        });
      }
      if (broad && data.broadRefused.has(kind)) return denied();
      if (broad && data.broadMalformed.has(kind)) {
        return output({ items: [{ metadata: { name: 'no-namespace' } }] });
      }
      if (!broad && data.scopedRefused.has(kind)) return denied();
      const selected = broad ? metas : metas.filter((meta) => meta.extra.namespace === namespace);
      if (kind === 'deployment') {
        const deployments = selected.flatMap((meta) => {
          const count = data.replicas.get(String(meta.extra.namespace));
          return count === null
            ? []
            : [
                {
                  metadata: { namespace: meta.extra.namespace, name: 'rocketchat-rocketchat' },
                  spec: { replicas: count },
                },
              ];
        });
        return broad ? output({ items: deployments }) : output(deployments[0]);
      }
      if (kind === 'pod') {
        const pods = selected.flatMap((meta) => {
          const ns = String(meta.extra.namespace);
          if (data.replicas.get(ns) === null || data.replicas.get(ns) === 0) return [];
          const application: PodDocument = {
            metadata: {
              namespace: ns,
              name: `${meta.name}-app`,
              labels: { 'app.kubernetes.io/name': 'rocketchat' },
            },
            status: { containerStatuses: [{ ready: data.ready.get(ns) }] },
          };
          const sidecar: PodDocument = {
            metadata: {
              namespace: ns,
              name: `${meta.name}-mongo`,
              labels: { 'app.kubernetes.io/name': 'mongodb' },
            },
            status: {
              initContainerStatuses: [
                {
                  state: {
                    waiting: { reason: 'CreateContainerConfigError', message: 'missing secret' },
                  },
                },
              ],
            },
          };
          return data.terminal.has(ns) ? [application, sidecar] : [application];
        });
        return output({
          items: argv.includes('-l')
            ? pods.filter((pod) => pod.metadata.labels['app.kubernetes.io/name'] === 'rocketchat')
            : pods,
        });
      }
      throw new Error(`unexpected Kubernetes query: ${argv.join(' ')}`);
    });
    jest.doMock('../../../src/core/kube/exec', () => ({
      ...(jest.requireActual('../../../src/core/kube/exec') as typeof KubeExecNS),
      kube: { run },
    }));
    jest.doMock('../../../src/core/runner/host', () => ({
      ...(require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
      dockerAvailable: async () => false,
    }));
    jest.doMock('../../../src/core/runner/record', () => ({
      ...(jest.requireActual('../../../src/core/runner/record') as typeof RecordNS),
      listMeta: async () => data.metas,
    }));
    jest.doMock('../../../src/core/kube/namespace', () => ({
      ...(jest.requireActual('../../../src/core/kube/namespace') as typeof NamespaceNS),
      namespaceFor: async (name: string) =>
        String(data.metas.find((meta) => meta.name === name)?.extra.namespace ?? ''),
    }));
    return { inspect: require('../../../src/core/lifecycle/inspect') as typeof InspectNS, run };
  }

  it('shares fresh workload and pod snapshots across a list and reuses pods for terminal failures', async () => {
    const data = fixture();
    data.replicas.set('recorded-space-1', 0);
    data.replicas.set('recorded-space-2', null);
    data.ready.set('recorded-space-3', false);
    data.terminal.add('recorded-space-3');
    data.ready.set('recorded-space-4', false);
    const { inspect, run } = snapshotList(data);
    const rows = await inspect.listRepros();
    expect(rows.map((row) => row.name)).toEqual(data.metas.map((meta) => meta.name));
    expect(rows.map((row) => row.state)).toEqual([
      'running',
      'stopped',
      'down',
      'failed',
      'starting',
      'running',
      'running',
      'running',
    ]);
    expect(run.mock.calls.filter(([argv]) => argv[0] === 'kubectl')).toHaveLength(6);
    expect(
      run.mock.calls.filter(([argv]) => argv.includes('-n') && argv[0] === 'kubectl'),
    ).toHaveLength(0);
    for (const meta of data.metas) data.replicas.set(String(meta.extra.namespace), 0);
    expect((await inspect.listRepros()).map((row) => row.state)).toEqual(Array(8).fill('stopped'));
    expect(run.mock.calls.filter(([argv]) => argv[0] === 'kubectl')).toHaveLength(12);
  });

  it('falls back independently to scoped reads when a broad collection is refused or malformed', async () => {
    for (const kind of ['deployment', 'pod']) {
      for (const malformed of [false, true]) {
        const data = fixture(2);
        data.replicas.set('recorded-space-1', 0);
        (malformed ? data.broadMalformed : data.broadRefused).add(kind);
        const { inspect, run } = snapshotList(data);
        expect((await inspect.listRepros()).map((row) => row.state)).toEqual([
          'running',
          'stopped',
        ]);
        expect(run.mock.calls.filter(([argv]) => argv.includes('-A'))).toHaveLength(2);
        const scoped = run.mock.calls.filter(([argv]) => argv.includes('-n'));
        expect(scoped).toHaveLength(2);
        expect(scoped.every(([argv]) => argv[argv.indexOf('get') + 1] === kind)).toBe(true);
      }
    }
  });

  it('keeps namespace authority and scoped deployment refusals when broad snapshots are unavailable', async () => {
    const data = fixture(5);
    data.held.delete('recorded-space-1');
    data.namespacesRefused.add('second');
    const { inspect, run } = snapshotList(data);
    expect((await inspect.listRepros()).map((row) => row.state)).toEqual([
      'running',
      'down',
      'running',
      'running',
      '?',
    ]);
    expect(run.mock.calls.filter(([argv]) => argv.includes('-n'))).toHaveLength(0);
    data.broadRefused.add('deployment');
    data.scopedRefused.add('deployment');
    await expect(inspect.listRepros()).rejects.toThrow('could not ask cluster');
  });
});

describe('what the record alone says', () => {
  it('renders a workspace made before note groups existed as groups', async () => {
    // Grouped notes were written into repro.json at create time, so they reached only
    // workspaces created after the release that added them -- and destroying a customer
    // repro to see the new shape is the one thing nobody can do. Notes are a pure function
    // of the record, so they are derived on every read. This is what an older release wrote.
    const meta = metadata({
      name: 'old',
      project: 'houston-old',
      rcVersion: '8.5.1',
      rcImage: 'i',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3000',
      hostPort: 3000,
      versionSource: 'map',
      extra: {
        runtime: 'kubernetes',
        deployment: 'microservices',
        namespace: 'houston-old',
        context: 'kind-houston-local',
        release: 'rocketchat',
        bind_host: '127.0.0.1',
        mongo_managed_by: 'statefulset',
        mongo_image: 'mongo:8.0',
        notes: [
          'microservices on kind-houston-local - about 9 pods, namespace houston-old',
          'reachable on this box at http://localhost:3000',
        ],
      },
    });
    const s = await summary(meta);
    const groups = s.note_groups as NoteGroup[];
    const titles = groups.map((group) => group.title);
    expect(titles.slice(0, 2)).toEqual(['Kubernetes', 'MongoDB']);
    // The three steps read in the order somebody has to perform them.
    expect(titles.slice(2, 5)).toEqual([
      '1 · Point kubectl and helm at this cluster',
      '2 · Open the way in',
      '3 · Look at what is inside',
    ]);
    // The facts that were welded into a sentence are rows now, for this record too.
    expect(Object.fromEntries(groups[0]?.rows ?? [])).toEqual({
      Cluster: 'kind-houston-local',
      Namespace: 'houston-old',
      Shape: 'microservices',
      // Counted from the cluster, which a unit test has none of.
      Pods: 'not counted: the cluster did not answer',
      License: expect.stringContaining('microservices are an Enterprise feature') as unknown,
    });
    // And the flat list the CLI prints is the derived one, not the sentence above.
    expect(s.notes).toEqual(flattenNotes(groups));
    expect(
      (s.notes as string[]).filter((note) => note.includes('about 9 pods, namespace')),
    ).toEqual([]);
  });

  it('says microservices need a license only while the workspace has none', async () => {
    // The second Rocket.Chat replica of an unlicensed microservices workspace crash-loops
    // ("Enterprise license not found") and nothing said why. A license can be added once it
    // is up, so this is said, not refused.
    const rows = async (extra: Record<string, unknown>) => {
      const meta = metadata({
        name: 'm',
        project: 'houston-m',
        rootUrl: 'http://localhost:3000',
        hostPort: 3000,
        extra: { runtime: 'kubernetes', namespace: 'houston-m', ...extra },
      });
      const groups = (await summary(meta)).note_groups as NoteGroup[];
      return Object.fromEntries(groups[0]?.rows ?? []) as Record<string, string>;
    };
    expect((await rows({ deployment: 'microservices' })).License).toBe(
      'microservices are an Enterprise feature: without an Enterprise license, every ' +
        'Rocket.Chat replica after the first stops ("Enterprise license not found"). Add one ' +
        'with `--license` or in Rocket.Chat under Workspace > Subscription.',
    );
    expect(await rows({ deployment: 'microservices', licensed: true })).not.toHaveProperty(
      'License',
    );
    // Given and REFUSED (bound to another URL) is no license at all to Rocket.Chat.
    expect(
      await rows({ deployment: 'microservices', licensed: true, license_status: 'refused' }),
    ).toHaveProperty('License');
    expect(await rows({ deployment: 'monolith' })).not.toHaveProperty('License');
  });

  it("carries the workspace's password, and an older record's real one", async () => {
    // The GUI renders `login` with a copy button and the create dialog shows the same
    // dict, so a generated password reaches a browser-only operator through this key.
    const meta = metadata({
      name: 'd',
      project: 'houston-d',
      rcVersion: '8.5.1',
      rcImage: 'i',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3001',
      hostPort: 3001,
      versionSource: 'live',
      adminPassword: 's3cret-generated-value',
    });
    expect((await summary(meta)).login).toEqual({
      user: 'admin',
      password: 's3cret-generated-value',
    });
    meta.adminPassword = '';
    expect(((await summary(meta)).login as { password: string }).password).toBe('admin123');
  });
});

describe('the detail of a Kubernetes workspace', () => {
  function withCluster(pods: PodRow[], { dockerDown = false } = {}): typeof PayloadNS {
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/inspect', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/inspect'),
      kubernetesState: async () => 'running',
    }));
    jest.doMock('../../../src/core/kube/status', () => ({
      ...jest.requireActual('../../../src/core/kube/status'),
      podRows: async () => pods,
    }));
    if (dockerDown) {
      // Over the suite's healthy engine, so the only thing this changes is the answer.
      jest.doMock('../../../src/core/runner/host', () => ({
        ...(require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
        dockerAvailable: async () => false,
      }));
    }
    return require('../../../src/core/lifecycle/payload') as typeof PayloadNS;
  }

  it('gives it its links and its pods', async () => {
    // The Kubernetes branch returned before it built either. A preset's UI answers on the
    // SAME host port under both runtimes, so leaving links out made phpLDAPadmin, Keycloak,
    // MinIO, Mailpit and Grafana unreachable from the GUI while the CLI printed each. And
    // an empty `containers` reads as "this repro is down" under a running workspace, with
    // no way to see an ImagePullBackOff from a browser.
    kubeWorkspace('k', 'ldap');
    const payload = withCluster([
      {
        service: 'rocketchat-rocketchat-1',
        state: 'running',
        status: '1/1 ready',
        health: 'healthy',
        app: true,
        blocked: false,
        restarts: 0,
        started: '2026-08-18T10:00:00Z',
      },
      {
        service: 'rocketchat-mongodb-0',
        state: 'pending',
        status: 'ImagePullBackOff',
        health: '',
        app: false,
        blocked: true,
        restarts: 0,
        started: '',
      },
    ]);
    const d = await payload.detail('k');
    const labels = (d.links as { label: string }[]).map((link) => link.label);
    expect(labels).toContain('Rocket.Chat');
    // The scenario's own UI, on the same port as Compose.
    expect(labels).toContain('phpLDAPadmin');
    const containers = d.containers as PodRow[];
    expect(containers.map((row) => row.service)).toEqual([
      'rocketchat-rocketchat-1',
      'rocketchat-mongodb-0',
    ]);
    expect(containers[1]?.status).toContain('ImagePullBackOff');
    // microservices, because that is what this runtime DEFAULTS to and the record names no
    // deployment.
    expect([d.runtime, d.deployment, d.namespace]).toEqual([
      'kubernetes',
      'microservices',
      'houston-k',
    ]);
    // An uptime, from the earliest running pod.
    expect(d.uptime).not.toBe('');
  });

  it('survives docker being down, because the runtime is asked first', async () => {
    // detail() asked docker first, and its docker-unavailable branch reads the COMPOSE
    // FILE. A Kubernetes workspace has none, so a daemon merely asleep answered the panel
    // with a bare ENOENT -- a 500 -- for a workspace running fine in the cluster.
    kubeWorkspace('k', 'default');
    const payload = withCluster([], { dockerDown: true });
    // The stub is really in force: the engine this payload sees says docker is down.
    expect(
      await (require('../../../src/core/runner/host') as typeof HostNS).dockerAvailable(),
    ).toBe(false);
    const d = await payload.detail('k');
    // Docker's absence says nothing about a cluster...
    expect(d.state).toBe('running');
    // ...and the links are still there.
    expect((d.links as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('a composed workspace in the payload', () => {
  const combo = () =>
    metadata({
      name: 'combo',
      project: 'houston-combo',
      rcVersion: '8.5.1',
      mongoTag: '8.0',
      preset: 'email+ldap',
      rootUrl: 'http://localhost:3110',
      hostPort: 3110,
      extra: {
        runtime: 'docker',
        presets: ['email', 'ldap'],
        preset_params: { ldap: { users: '3' } },
      },
    });

  it("links every preset's sidecar UI", () => {
    const labels = reproLinks(combo()).map((link) => link.label);
    expect(labels).toEqual(expect.arrayContaining(['Mailpit', 'phpLDAPadmin']));
  });

  it('carries the list only for a composed workspace', async () => {
    expect((await summary(combo())).presets).toEqual(['email', 'ldap']);
    expect('presets' in (await summary(metadata({ name: 'one', preset: 'ldap' })))).toBe(false);
  });

  it('names a multi-instance workspace’s presets without the deployment', async () => {
    // Compose builds multi-instance through that preset, so the record lists it among the
    // presets; the panel showed it as a preset chip beside the deployment that already says
    // so, where the owner had settled it is the deployment, not a preset.
    const multi = (preset: string) =>
      summary(
        metadata({
          name: 'mi',
          preset,
          extra: { runtime: 'docker', deployment: 'multi-instance' },
        }),
      );
    expect(await multi('email+ldap+multi-instance')).toMatchObject({
      preset: 'email+ldap',
      presets: ['email', 'ldap'],
      deployment: 'multi-instance',
    });
    expect(String((await multi('multi-instance')).preset)).not.toContain('multi-instance');
  });
});

describe("an HTTPS workspace's preset UIs", () => {
  it('link to their public path; the demo page keeps its cross-origin port beside it', () => {
    const meta = linksMeta('email+livechat', {
      public_paths: [
        {
          preset: 'email',
          path: '/mailpit',
          service: 'mailpit',
          container_port: 8025,
          service_port: 8025,
        },
        {
          preset: 'livechat',
          path: '/livechat-demo',
          service: 'widget-site',
          container_port: 80,
          service_port: 80,
        },
      ],
    });
    meta.publicUrl = 'https://r.houston.localhost';
    const byLabel = Object.fromEntries(reproLinks(meta).map((link) => [link.label, link.url]));
    expect(byLabel).toMatchObject({
      Mailpit: 'https://r.houston.localhost/mailpit/',
      'Widget site': 'http://localhost:8090',
      'Widget site (same origin)': 'https://r.houston.localhost/livechat-demo/',
    });
    // Without a public name, nothing changes.
    meta.publicUrl = '';
    expect(reproLinks(meta).find((link) => link.label === 'Mailpit')?.url).toBe(
      'http://localhost:8025',
    );
  });
  it('replace the MinIO console and phpLDAPadmin links, which name the same pages', () => {
    const meta = linksMeta('ldap+s3_minio', {
      public_paths: [
        {
          preset: 's3_minio',
          path: '/minio',
          service: 'minio-ui',
          container_port: 80,
          service_port: 80,
        },
        {
          preset: 'ldap',
          path: '/phpldapadmin',
          service: 'phpldapadmin',
          container_port: 80,
          service_port: 8082,
        },
      ],
    });
    meta.publicUrl = 'https://r.houston.localhost';
    const links = reproLinks(meta);
    expect(Object.fromEntries(links.map((link) => [link.label, link.url]))).toMatchObject({
      'MinIO console': 'https://r.houston.localhost/minio/',
      'MinIO API': 'http://localhost:9000',
      phpLDAPadmin: 'https://r.houston.localhost/phpldapadmin/',
    });
    expect(links.filter((link) => link.label === 'MinIO console')).toHaveLength(1);
  });
});

describe("ldap's own IdP", () => {
  it('is linked, on the port its Keycloak publishes', () => {
    // Links were by preset name only, so the Keycloak `--set idp=saml|oidc` brings -- the
    // console holding the directory's SSO users -- had no link on loopback.
    const { reproLinks } = require('../../../src/core/lifecycle/inspect') as {
      reproLinks: (meta: never) => { label: string; url: string }[];
    };
    const { metadata } = require('../../../src/core/runner/record') as {
      metadata: (values: Record<string, unknown>) => never;
    };
    for (const [idp, port] of [
      ['saml', 8081],
      ['oidc', 8085],
    ] as const) {
      const links = reproLinks(
        metadata({ name: 'l', preset: 'ldap', hostPort: 3000, extra: { params: { idp } } }),
      );
      expect(links.find((link) => link.label === 'Keycloak')?.url).toBe(
        `http://localhost:${String(port)}`,
      );
    }
  });
});
