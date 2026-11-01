/**
 * The Kubernetes create path, from `createRepro` down to the cluster module that builds it.
 *
 * Each case asserts something `lifecycle` does with what this package answers, which is why they
 * sit beside the package. The cluster itself is the double: the plan, the kubeconfig export, helm's
 * answer, the namespace preflight and `createWorkspace` are stated, exactly the functions that
 * reach outside, and the orchestration between them is the real one. Nothing reaches a cluster,
 * the network or Docker.
 */
import type * as ClusterNS from '../../../src/core/kube/cluster';
import type * as ContextNS from '../../../src/core/kube/context';
import type * as NamespaceNS from '../../../src/core/kube/namespace';
import type * as ProbeNS from '../../../src/core/kube/probe';
import type * as ReachabilityNS from '../../../src/core/kube/reachability';
import type * as ToolsNS from '../../../src/core/kube/tools';
import type * as WorkspaceNS from '../../../src/core/kube/workspace';
import type * as PortsNS from '../../../src/core/lifecycle/ports';
import type * as RunnerPortsNS from '../../../src/core/runner/ports';
import type * as ReadyNS from '../../../src/core/lifecycle/ready';
import type * as SeedingNS from '../../../src/core/lifecycle/seeding';
import type * as SizingNS from '../../../src/core/lifecycle/sizing';
import type * as TlsplanNS from '../../../src/core/lifecycle/tlsplan';
import type * as RoutesNS from '../../../src/core/edge/routes';

import * as config from '../../../src/lib/config';
import { safeLoadAll } from '../../../src/lib/presets/common';
import { ConflictError, PreflightError, ValidationError } from '../../../src/lib/errors';
import { NOTHING_LEFT, nullEmit } from '../../../src/lib/events';
import type { KubectlResult } from '../../../src/seams/kubectl';
import { createRepro } from '../../../src/core/lifecycle/create-docker';
import { createKubernetes } from '../../../src/core/lifecycle/create-k8s';
import { createReq } from '../../../src/core/lifecycle/types';
import { exists } from '../../../src/core/runner/paths';
import { usedPorts } from '../../../src/core/runner/ports';
import { readMeta } from '../../../src/core/runner/record';
import * as topology from '../../../src/core/topology';

import { register, routeHost } from '../../../src/core/edge/routes';
import { kube } from '../../../src/core/kube/exec';
import { CONTEXT } from '../../../src/core/kube/names';
import { namespaceFor } from '../../../src/core/kube/namespace';

/** What each stated function answers; `null` hands the call to the real one. */
let mockPort = 3000;
let mockPlan: ((context?: string) => Promise<ContextNS.ClusterPlan>) | null = null;
let mockHelm = '';
let mockCreate: ((options: Record<string, unknown>) => Promise<Record<string, unknown>>) | null =
  null;
const mockCalls: string[] = [];
const mockCreated: Record<string, unknown>[] = [];
/** A name the cluster serves over HTTPS, through the edge; null for none. */
let mockKtls: { host: string } | null = null;
/** What the edge step does instead of registering the route; null registers it. */
let mockRoute: (() => Promise<void>) | null = null;

jest.mock('../../../src/core/lifecycle/tlsplan', () => {
  const actual = jest.requireActual<typeof TlsplanNS>('../../../src/core/lifecycle/tlsplan');
  const routes = jest.requireActual<typeof RoutesNS>('../../../src/core/edge/routes');
  return {
    ...actual,
    // With a name, the cluster's ingress probes are stated and the edge route is the real
    // file, passed through to a NodePort -- what a create with --domain writes on k3s.
    resolveTls: (...args: Parameters<typeof actual.resolveTls>) =>
      mockKtls !== null
        ? Promise.resolve({ mode: 'acme', host: mockKtls.host } as never)
        : actual.resolveTls(...args),
    kubernetesTlsPlan: () => Promise.resolve(mockKtls as never),
    routeKubernetesName: async (name: string, ktls: { host: string }) => {
      if (mockRoute !== null) return await mockRoute();
      await routes.register(name, ktls.host, { passthrough: '10.0.0.1:30734' });
    },
  };
});
jest.mock('../../../src/core/lifecycle/sizing', () => ({
  ...jest.requireActual<typeof SizingNS>('../../../src/core/lifecycle/sizing'),
  // The host's free memory is not what any of these is about.
  checkCapacity: () => Promise.resolve(),
}));
jest.mock('../../../src/core/runner/ports', () => ({
  ...jest.requireActual<typeof RunnerPortsNS>('../../../src/core/runner/ports'),
  // Whether this machine happens to hold 8025 is not what any of these is about.
  portFree: () => Promise.resolve(true),
}));
jest.mock('../../../src/core/lifecycle/ports', () => ({
  ...jest.requireActual<typeof PortsNS>('../../../src/core/lifecycle/ports'),
  pickHostPort: () => Promise.resolve(mockPort),
}));
jest.mock('../../../src/core/kube/probe', () => {
  const tools = jest.requireActual<typeof ToolsNS>('../../../src/core/kube/tools');
  return {
    ...jest.requireActual<typeof ProbeNS>('../../../src/core/kube/probe'),
    // kubectl and helm are here; which cluster is planCluster's business, below.
    preflight: () =>
      Promise.resolve(
        tools.preflight({
          tools: {
            kubectl: tools.makeTool({
              name: 'kubectl',
              path: '/usr/bin/kubectl',
              version: [1, 36],
            }),
            helm: tools.makeTool({ name: 'helm', path: '/usr/bin/helm', version: [3, 15] }),
          },
        }),
      ),
  };
});
jest.mock('../../../src/core/kube/context', () => {
  const actual = jest.requireActual<typeof ContextNS>('../../../src/core/kube/context');
  return {
    ...actual,
    planCluster: (context = '') => (mockPlan ?? actual.planCluster)(context),
  };
});
jest.mock('../../../src/core/kube/cluster', () => ({
  ...jest.requireActual<typeof ClusterNS>('../../../src/core/kube/cluster'),
  // The export it would do for the plan reaches for kind, which none of these are about.
  ensureKubeconfig: (plan: { context: string }) => Promise.resolve(plan.context),
}));
jest.mock('../../../src/core/kube/reachability', () => ({
  ...jest.requireActual<typeof ReachabilityNS>('../../../src/core/kube/reachability'),
  helmReachable: () => Promise.resolve(mockHelm),
}));
jest.mock('../../../src/core/kube/namespace', () => ({
  ...jest.requireActual<typeof NamespaceNS>('../../../src/core/kube/namespace'),
  assertNamespaceAvailable: (name: string) => {
    mockCalls.push(`assertNamespaceAvailable:${name}`);
    return Promise.resolve();
  },
}));
jest.mock('../../../src/core/kube/workspace', () => ({
  ...jest.requireActual<typeof WorkspaceNS>('../../../src/core/kube/workspace'),
  createWorkspace: (options: Record<string, unknown>) => {
    mockCreated.push(options);
    if (mockCreate !== null) return mockCreate(options);
    return Promise.resolve({
      context: CONTEXT,
      namespace: `houston-${String(options.name)}`,
      chart_version: '7.0.0',
      release: 'rocketchat',
      port_forward_pid: 0,
      bind_host: '',
      microservices: false,
    });
  },
}));
jest.mock('../../../src/core/lifecycle/ready', () => ({
  ...jest.requireActual<typeof ReadyNS>('../../../src/core/lifecycle/ready'),
  waitAndFinalize: () => {
    mockCalls.push('wait');
    return Promise.resolve({ ready: true });
  },
}));
jest.mock('../../../src/core/lifecycle/seeding', () => ({
  ...jest.requireActual<typeof SeedingNS>('../../../src/core/lifecycle/seeding'),
  runSeedInline: () => {
    mockCalls.push('seed');
    return Promise.resolve({ users: 5 });
  },
}));

type Bag = Record<string, unknown>;

const realRun = kube.run;

/** A cluster that exists, is not ours to build, and answers. */
const adopted = (context: string, distribution: string) => () =>
  Promise.resolve({ context, distribution, create: false });

beforeEach(() => {
  mockPort = 3000;
  mockPlan = adopted(CONTEXT, 'kind');
  mockHelm = '';
  mockCreate = null;
  mockKtls = null;
  mockRoute = null;
  mockCalls.length = 0;
  mockCreated.length = 0;
});

afterEach(() => {
  kube.run = realRun;
});

describe('a Kubernetes create', () => {
  it('waits for the workspace to SERVE before it seeds it', async () => {
    // `up --seed` ran the seeder the instant helm returned -- "can't seed — repro not
    // ready". The CLI forces wait when seeding, and this path never read it. Helm returning
    // is not Rocket.Chat serving.
    await createKubernetes(
      createReq({
        version: '8.5.1',
        name: 'kseed',
        seed: true,
        wait: true,
        runtime: 'kubernetes',
        offline: true,
      }),
    );
    expect(mockCalls.filter((call) => call === 'wait' || call === 'seed')).toEqual([
      'wait',
      'seed',
    ]);

    // And without --seed or --wait it still returns promptly.
    mockCalls.length = 0;
    await createKubernetes(
      createReq({ version: '8.5.1', name: 'kseed', runtime: 'kubernetes', offline: true }),
    );
    expect(mockCalls.filter((call) => call === 'wait' || call === 'seed')).toEqual([]);
  });

  it('honours up --env and --setting, records them, and carries them into a re-up', async () => {
    // Both were accepted and silently dropped on Kubernetes: nothing read `req.env`, so the
    // chart never saw them, the record never held them and a backup could not carry them.
    await createKubernetes(
      createReq({
        version: '8.5.1',
        name: 'kenv',
        runtime: 'kubernetes',
        offline: true,
        env: { OVERWRITE_SETTING_Site_Name: 'Ticket', FEATURE: 'on' },
      }),
    );
    expect(mockCreated[0]?.envOverrides).toEqual({
      OVERWRITE_SETTING_Site_Name: 'Ticket',
      FEATURE: 'on',
    });
    expect((await readMeta('kenv')).extra.env).toEqual({
      OVERWRITE_SETTING_Site_Name: 'Ticket',
      FEATURE: 'on',
    });
    // A re-up with no --env keeps them; one that names a key changes only that key.
    await createKubernetes(
      createReq({
        version: '8.5.1',
        name: 'kenv',
        runtime: 'kubernetes',
        offline: true,
        env: { FEATURE: 'off' },
      }),
    );
    expect(mockCreated[1]?.envOverrides).toEqual({
      OVERWRITE_SETTING_Site_Name: 'Ticket',
      FEATURE: 'off',
    });
    expect((await readMeta('kenv')).extra.env).toEqual(mockCreated[1]?.envOverrides);
  });

  it("records the preset's own fields and side ports, as Compose does", async () => {
    // `mailpit_url` is what `admin.login` reads to fetch an email-2FA code, and this runtime
    // never recorded it: every `api`, `seed` and readiness login to an email workspace here
    // stopped at 2FA. `sidecar_ports` is what makes a second workspace's claim visible.
    await createKubernetes(
      createReq({
        version: '8.5.1',
        name: 'kmail',
        preset: 'email',
        runtime: 'kubernetes',
        offline: true,
      }),
    );
    const extra = (await readMeta('kmail')).extra;
    expect(extra.mailpit_url).toBe('http://localhost:8025');
    expect(extra.sidecar_ports).toEqual([8025]);
    expect(extra.runtime).toBe('kubernetes');
  });

  it('forwards a second workspace with the same preset on the next free port, and keeps it on a re-up', async () => {
    const req = (name: string) =>
      createReq({ version: '8.5.1', name, preset: 'ldap', runtime: 'kubernetes', offline: true });
    /** The host port the forwarder reads off phpLDAPadmin's Service. */
    const label = (options: Record<string, unknown> | undefined): unknown =>
      (options?.preset as { kubernetesManifests: string[] }).kubernetesManifests
        .flatMap((manifest) => safeLoadAll(manifest) as Record<string, unknown>[])
        .map((doc) => doc as { kind?: string; metadata?: { name?: string; labels?: Bag } })
        .find((doc) => doc.kind === 'Service' && doc.metadata?.name === 'phpldapadmin')?.metadata
        ?.labels?.['houston.io/ui-port'];
    await createKubernetes(req('kldap-one'));
    await createKubernetes(req('kldap-two'));
    expect([label(mockCreated[0]), label(mockCreated[1])]).toEqual(['8082', '8083']);
    const two = (await readMeta('kldap-two')).extra;
    expect([two.sidecar_ports, two.side_ports]).toEqual([[8083], { ldap: [8083] }]);
    expect((await readMeta('kldap-one')).extra).not.toHaveProperty('side_ports');
    // Its re-up renders the same label from its record: the forward, and every link, holds.
    await createKubernetes(req('kldap-two'));
    expect(label(mockCreated[2])).toBe('8083');
    expect((await readMeta('kldap-two')).extra.side_ports).toEqual({ ldap: [8083] });
  });

  it('refuses a --set the preset does not take, as Compose does', async () => {
    await expect(
      createKubernetes(
        createReq({
          version: '8.5.1',
          name: 'ktypo',
          preset: 'email',
          runtime: 'kubernetes',
          offline: true,
          params: { verificaton: 'true' },
        }),
      ),
    ).rejects.toThrow(
      "unknown --set param(s) for preset 'email': verificaton - valid: verification",
    );
    expect(await exists('ktypo')).toBe(false);
  });

  it('installs a licence as a Secret, records only that it has one, and keeps it on a re-up', async () => {
    const LICENSE = 'RCV3_bGljZW5jZQ==';
    const req = (license: string) =>
      createReq({ version: '8.5.1', name: 'klic', runtime: 'kubernetes', offline: true, license });
    await createKubernetes(req(LICENSE));
    expect([mockCreated[0]?.license, mockCreated[0]?.licensed]).toEqual([LICENSE, true]);
    const meta = await readMeta('klic');
    expect(meta.extra.licensed).toBe(true);
    expect(JSON.stringify(meta)).not.toContain(LICENSE);
    await createKubernetes(req(''));
    expect([mockCreated[1]?.license, mockCreated[1]?.licensed]).toEqual(['', true]);
  });

  it('retires its own forwards on a re-up, and keeps them findable while it runs', async () => {
    // The write-ahead record replaced the one holding the forwards, and the re-up then read
    // them back from it: pid 0. Measured on k3s, on the release before this: the old forward
    // kept the port, the readiness wait failed with exit 5, and `down --volumes` left both
    // kubectl forwards running, holding 3505 and Mailpit's 8025.
    mockPort = 3505;
    mockCreate = (options) =>
      Promise.resolve({
        context: CONTEXT,
        namespace: `houston-${String(options.name)}`,
        release: 'rocketchat',
        port_forward_pid: 4242,
        scenario_forwards: { '8025': 4343 },
      });
    const req = () =>
      createReq({ version: '8.5.1', name: 'kfw', runtime: 'kubernetes', offline: true });
    await createKubernetes(req());
    let duringReup: Record<string, unknown> = {};
    mockCreate = async (options) => {
      duringReup = (await readMeta('kfw')).extra;
      return {
        context: CONTEXT,
        namespace: `houston-${String(options.name)}`,
        port_forward_pid: 5252,
      };
    };
    await createKubernetes(req());
    expect([mockCreated[1]?.previousPid, mockCreated[1]?.previousPort]).toEqual([4242, 3505]);
    expect([duringReup.port_forward_pid, duringReup.scenario_forwards]).toEqual([
      4242,
      { '8025': 4343 },
    ]);
    expect((await readMeta('kfw')).extra.port_forward_pid).toBe(5252);
  });

  it('warns that Rocket.Chat 9 may refuse an unlicensed LDAP login', async () => {
    const said: string[] = [];
    // Said while the request is settled, before the side ports: a workspace earlier in this
    // file holds ldap's 8082, and this one's refusal for it is not what is under test.
    await createKubernetes(
      createReq({
        version: '9.0.0',
        name: 'k9',
        preset: 'ldap',
        runtime: 'kubernetes',
        offline: true,
      }),
      (event) => said.push(event.message),
    ).catch((error: unknown) => {
      if (!(error instanceof ConflictError)) throw error;
    });
    expect(said.filter((line) => line.includes('Premium plan for LDAP login'))).toHaveLength(1);
  });

  it('composes several presets as one, and records the set as Compose does', async () => {
    // Side ports earlier cases in this file do not hold.
    await createRepro(
      createReq({
        version: '8.5.1',
        name: 'kcombo',
        preset: 'livechat+s3_minio',
        params: { 'livechat.agents': '2' },
        runtime: 'kubernetes',
        offline: true,
      }),
    );
    const handed = mockCreated.at(-1)?.preset as { name: string; kubernetesManifests: string[] };
    expect(handed.name).toBe('livechat+s3_minio');
    expect(handed.kubernetesManifests.length).toBeGreaterThan(1);
    const meta = await readMeta('kcombo');
    expect([
      meta.preset,
      meta.extra.presets,
      meta.extra.preset_params,
      'params' in meta.extra,
    ]).toEqual([
      'livechat+s3_minio',
      ['livechat', 's3_minio'],
      { livechat: { agents: '2' }, s3_minio: {} },
      false,
    ]);
  });

  it('refuses to swap presets in place, and brings one back as it was with no --preset', async () => {
    await createRepro(
      createReq({
        version: '8.5.1',
        name: 'kswap',
        preset: 'saml',
        runtime: 'kubernetes',
        offline: true,
      }),
    );
    // No --preset: brought back as it was, not re-installed without its settings.
    await createRepro(createReq({ version: '8.5.1', name: 'kswap', preset: '', offline: true }));
    expect((mockCreated.at(-1)?.preset as { name: string }).name).toBe('saml');
    // A different set would leave the old presets' objects behind: refused, by name.
    await expect(
      createRepro(
        createReq({
          version: '8.5.1',
          name: 'kswap',
          preset: 'livechat',
          runtime: 'kubernetes',
          offline: true,
        }),
      ),
    ).rejects.toThrow("'kswap' runs the saml preset and this asks for livechat");
  });

  it('refuses a variable the chart writes itself before anything exists', async () => {
    await expect(
      createKubernetes(
        createReq({
          version: '8.5.1',
          name: 'kowned',
          runtime: 'kubernetes',
          offline: true,
          env: { ROOT_URL: 'http://elsewhere' },
        }),
      ),
    ).rejects.toThrow(ValidationError);
    expect(await exists('kowned')).toBe(false);
    expect(mockCreated).toEqual([]);
  });

  it('pulls from the box-wide rc_image, as Compose does, and the flag still wins', async () => {
    // Only `--rc-image` was read here, so a box pointed at a mirror with `config set
    // rc_image` pulled every Kubernetes workspace from Docker Hub.
    config.updateConfig((cfg) => {
      cfg.rc_image = 'mirror.example/rocketchat';
    });
    try {
      await createKubernetes(
        createReq({ version: '8.5.1', name: 'kmirror', runtime: 'kubernetes', offline: true }),
      );
      await createKubernetes(
        createReq({
          version: '8.5.1',
          name: 'kflag',
          runtime: 'kubernetes',
          offline: true,
          rcImage: 'flag.example/rc',
        }),
      );
    } finally {
      config.updateConfig((cfg) => {
        delete cfg.rc_image;
      });
    }
    const images = mockCreated.map((options) => (options.resolved as { rcImage: string }).rcImage);
    expect(images).toEqual(['mirror.example/rocketchat', 'flag.example/rc']);
    expect((await readMeta('kmirror')).rcImage).toBe('mirror.example/rocketchat');
  });

  it('passes the workspace the URL it just computed', async () => {
    // `createWorkspace` has taken `rootUrl` since it was written, and nothing gave it one --
    // so `valuesFor` had a branch for it that was dead on every real create, and a whole
    // runtime shipped with no ROOT_URL.
    mockPort = 3456;
    await createKubernetes(
      createReq({ version: '8.5.1', name: 'kurl', runtime: 'kubernetes', offline: true }),
    );
    expect(mockCreated[0]?.rootUrl).toBe('http://localhost:3456');
  });

  it('leaves a record behind when it is killed part-way', async () => {
    // Stopping `serve` with a create running left a full microservices workspace, twelve
    // pods, running and INVISIBLE: `list`, `info` and `down` all begin at the state
    // directory and there was nothing in it. Compose writes its record first; so does this.
    mockCreate = () => Promise.reject(new Error('serve shut down mid-create'));
    await expect(
      createRepro(
        createReq({
          version: '8.5.1',
          name: 'interrupted',
          runtime: 'kubernetes',
          deployment: 'microservices',
          offline: true,
        }),
      ),
    ).rejects.toThrow('serve shut down mid-create');
    expect(await exists('interrupted')).toBe(true);
    const meta = await readMeta('interrupted');
    expect(topology.ofMeta(meta)).toBe(topology.KUBERNETES);
    // Teardown selects on the namespace, so it has to be recorded...
    expect(meta.extra.namespace).toBe(await namespaceFor('interrupted'));
    // ...and it must be distinguishable from a create that finished.
    expect(meta.extra.incomplete).toBe(true);
  });

  it('takes back the edge route it registered when the create fails', async () => {
    // The route goes in before the create, so an ACME challenge has somewhere to land. On a
    // k3s playground a create whose ClusterIssuer never became ready rolled its namespace
    // back and left the route, sending the name to a NodePort that no longer existed.
    mockKtls = { host: 'kfail.example.test' };
    mockCreate = () => Promise.reject(new Error('the ClusterIssuer did not become ready'));
    const said: string[] = [];
    await expect(
      createKubernetes(
        createReq({ version: '8.5.1', name: 'kfail', runtime: 'kubernetes', offline: true }),
        (event) => said.push(event.message),
      ),
    ).rejects.toThrow('ClusterIssuer');
    expect(routeHost('kfail')).toBe('');
    expect(said).toContain('create failed — removing the edge route for kfail.example.test');
    // The record stays, as it always has, so `list` and `down` still find the workspace.
    expect(await exists('kfail')).toBe(true);
  });

  it('leaves a route that was there before the create', async () => {
    // Re-creating a workspace that already served the name must not take its route away.
    await register('kkeep', 'kkeep.example.test', { passthrough: '10.0.0.1:30000' });
    mockKtls = { host: 'kkeep.example.test' };
    mockCreate = () => Promise.reject(new Error('the chart did not install'));
    await expect(
      createKubernetes(
        createReq({ version: '8.5.1', name: 'kkeep', runtime: 'kubernetes', offline: true }),
      ),
    ).rejects.toThrow('chart');
    expect(routeHost('kkeep')).toBe('kkeep.example.test');
  });

  it('leaves NO record when it is refused for want of a cluster', async () => {
    // Measured on a box with k3s and no kind: the refusal left an `incomplete` repro.json,
    // `list` showed it, and `usedPorts()` went on reserving its port. The write-ahead record
    // is not the problem -- the ORDER was: choosing the cluster only probes, so it belongs
    // above the write. The real resolver runs here, on a box with no kind and nothing for
    // kubectl to point at.
    mockPlan = null;
    // The file's home already holds the workspaces above, so the claim is on THIS create:
    // the port it would have taken is not reserved afterwards.
    mockPort = 3142;
    const before = [...(await usedPorts())].sort();
    kube.run = (argv) =>
      Promise.resolve({ argv, returncode: 1, stdout: '', stderr: 'no cluster' } as KubectlResult);
    await expect(
      createKubernetes(
        createReq({ version: '8.5.1', name: 'ghost', runtime: 'kubernetes', offline: true }),
      ),
    ).rejects.toBeInstanceOf(PreflightError);
    expect(await exists('ghost')).toBe(false);
    expect([...(await usedPorts())].sort()).toEqual(before);
    expect(before).not.toContain(3142);
    expect(mockCreated).toEqual([]);
  });

  it('refuses before building anything when helm cannot reach a cluster kubectl can', async () => {
    // THE DEFECT, and it cost four minutes each time: kubectl entirely happy, helm refusing
    // every call, so the create built a namespace, a StatefulSet, a volume and an initiated
    // replica set, then died at the chart and rolled all of it back with an error naming
    // neither the cause nor the cure. A refusal here leaves nothing.
    mockPlan = adopted('default', 'k3s');
    mockHelm =
      'Error: kubernetes cluster unreachable: x509: certificate signed by unknown authority';
    const refusal = await createRepro(
      createReq({
        version: '8.5.1',
        name: 'hg',
        runtime: 'kubernetes',
        wait: false,
        offline: true,
      }),
      nullEmit,
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ValidationError);
    const said = (refusal as Error).message;
    expect(said).toContain('helm cannot reach cluster');
    expect(said).toContain('although kubectl can');
    // The CURE, named -- the whole difference from the error it replaces.
    expect(said).toContain('previous install of the same cluster');
    expect(said).toContain('/etc/rancher/k3s/k3s.yaml > ~/.kube/config');
    expect(said).toContain('kind export kubeconfig');
    expect(said).toContain('doctor');
    // Anything that would BUILD is a failure of the gate, not of the stub.
    expect(mockCalls.filter((call) => call.startsWith('assertNamespaceAvailable'))).toEqual([]);
    expect(mockCreated).toEqual([]);
  });
});

describe('a fresh Kubernetes create that failed', () => {
  it('leaves no record when the edge refuses before anything exists', async () => {
    // The route step ran outside the rollback: another home's edge holding :443 refused it,
    // exit 8, and the write-ahead record of a workspace that never existed stayed behind.
    mockKtls = { host: 'kedge.example.test' };
    mockRoute = () =>
      Promise.reject(new ConflictError('another houston edge is already running on this machine'));
    kube.run = (argv) =>
      Promise.resolve({
        argv,
        returncode: 1,
        stdout: '',
        stderr: 'Error from server (NotFound): namespaces "houston-kedge" not found',
      });
    const said: string[] = [];
    await expect(
      createKubernetes(
        createReq({ version: '8.5.1', name: 'kedge', runtime: 'kubernetes', offline: true }),
        (event) => said.push(event.message),
      ),
    ).rejects.toThrow('another houston edge');
    expect(await exists('kedge')).toBe(false);
    // No route was registered, so none is said to be removed.
    expect(said.some((line) => line.includes('removing the edge route'))).toBe(false);
  });

  it('leaves no record when nothing of it is left in the cluster', async () => {
    // The rollback removed the namespace and the write-ahead record stayed: a "down"
    // workspace that claimed its ports (the next email create was refused for 8025) and
    // whose panel said its data volume was still there.
    mockCreate = () => Promise.reject(new Error('stopped by admin before it finished'));
    kube.run = (argv) =>
      Promise.resolve({
        argv,
        returncode: 1,
        stdout: '',
        stderr: argv.includes('namespace')
          ? 'Error from server (NotFound): namespaces "houston-kgone" not found'
          : '',
      });
    const codes: string[] = [];
    await expect(
      createKubernetes(
        createReq({
          version: '8.5.1',
          name: 'kgone',
          runtime: 'kubernetes',
          offline: true,
        }),
        (event) => codes.push(event.code),
      ),
    ).rejects.toThrow('stopped by admin');
    expect(await exists('kgone')).toBe(false);
    // Said with a code, so a stopped job's last line does not go on to say "what it had done
    // stays" right under it.
    expect(codes).toContain(NOTHING_LEFT);

    // One whose namespace survived keeps its record: there is something to point at.
    kube.run = (argv) =>
      Promise.resolve({
        argv,
        returncode: 0,
        stdout: JSON.stringify({
          metadata: {
            name: 'houston-kkept',
            labels: { 'app.kubernetes.io/managed-by': 'houston' },
          },
        }),
        stderr: '',
      });
    codes.length = 0;
    await expect(
      createKubernetes(
        createReq({ version: '8.5.1', name: 'kkept', runtime: 'kubernetes', offline: true }),
        (event) => codes.push(event.code),
      ),
    ).rejects.toThrow('stopped by admin');
    expect(await exists('kkept')).toBe(true);
    expect(codes).not.toContain(NOTHING_LEFT);
  });
});
