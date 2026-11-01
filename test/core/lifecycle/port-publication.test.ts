import * as fs from 'node:fs/promises';

import * as config from '../../../src/lib/config';
import { currentContext, runWithContext } from '../../../src/lib/context';
import { ConflictError } from '../../../src/lib/errors';
import { nullEmit } from '../../../src/lib/events';
import { openEntries } from '../../../src/core/journal';
import { createRepro } from '../../../src/core/lifecycle/create-docker';
import { PORT_LOCK } from '../../../src/core/lifecycle/ports';
import * as ready from '../../../src/core/lifecycle/ready';
import { createReq, type CreateReq } from '../../../src/core/lifecycle/types';
import * as host from '../../../src/core/runner/host';
import { heldBy } from '../../../src/core/runner/locks';
import * as paths from '../../../src/core/runner/paths';
import * as portProbe from '../../../src/core/runner/ports';
import * as engine from '../../../src/core/runner/engine';
import * as queries from '../../../src/core/runner/queries';
import * as record from '../../../src/core/runner/record';
import type * as PolicyNS from '../../testsetup-policy';

jest.mock('../../../src/core/runner/host', () => {
  const healthy = (require('../../testsetup-policy') as typeof PolicyNS).healthyHost();
  return {
    ...healthy,
    engine: jest.fn(healthy.engine),
    dockerKernelVersion: jest.fn(async () => '6.1.0'),
  };
});
// The probe of this machine's ports, real by default: a spec deciding where a SIDE port lands
// says the machine is free rather than depending on what the host running the suite listens on.
jest.mock('../../../src/core/runner/ports', () => {
  const actual = jest.requireActual<typeof portProbe>('../../../src/core/runner/ports');
  return { ...actual, portFree: jest.fn(actual.portFree) };
});
// A rebuild takes the old containers down first; there is no Docker here to ask.
jest.mock('../../../src/core/runner/engine', () => ({
  ...jest.requireActual('../../../src/core/runner/engine'),
  down: async () => 0,
  publishedPorts: jest.fn(async () => new Set<number>()),
}));
jest.mock('../../../src/core/runner/queries', () => ({
  ...jest.requireActual('../../../src/core/runner/queries'),
  projectConfigFiles: jest.fn(async () => ({})),
  // No MongoDB left by another home: the guard refuses an unanswered ask, and there is no
  // Docker here to answer it.
  projectDataVolumes: jest.fn(async () => []),
}));
jest.mock('../../../src/core/lifecycle/sizing', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/sizing'),
  checkCapacity: jest.fn(async () => undefined),
}));
jest.mock('../../../src/core/lifecycle/ready', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/ready'),
  upCompose: jest.fn(async () => 0),
  waitAndFinalize: jest.fn(async () => ({})),
}));

// Locks, port selection, records and generated documents are real. Docker's
// deployment and host queries are the external boundary; they publish no sockets.
describe('a create publishes its complete port allocation before releasing the lock', () => {
  const deployed: string[] = [];
  const deploymentLocks: boolean[] = [];
  const deploymentRecords: record.Metadata[] = [];
  const healthy = (require('../../testsetup-policy') as typeof PolicyNS).healthyHost();

  beforeEach(async () => {
    await fs.rm(config.reprosDir(), { recursive: true, force: true });
    deployed.length = 0;
    deploymentLocks.length = 0;
    deploymentRecords.length = 0;
    jest.mocked(host.engine).mockReset().mockImplementation(healthy.engine);
    const actualFree = jest.requireActual<typeof portProbe>(
      '../../../src/core/runner/ports',
    ).portFree;
    jest.mocked(portProbe.portFree).mockReset().mockImplementation(actualFree);
    jest
      .mocked(ready.upCompose)
      .mockReset()
      .mockImplementation(async (name) => {
        deployed.push(name);
        deploymentLocks.push(heldBy(PORT_LOCK));
        deploymentRecords.push(await record.readMeta(name));
        return 0;
      });
  });

  afterEach(async () => {
    await fs.rm(config.reprosDir(), { recursive: true, force: true });
  });

  async function create(
    name: string,
    values: Partial<CreateReq> = {},
  ): Promise<Record<string, unknown>> {
    return await runWithContext(
      { workspace: name },
      async () =>
        await createRepro(
          createReq({ version: '8.5.1', runtime: 'docker', name, offline: true, ...values }),
          nullEmit,
        ),
    );
  }

  async function availableBlock(count = 1): Promise<number> {
    for (let base = 3300; base + count - 1 < 3990; base += 1) {
      let free = true;
      for (let offset = 0; offset < count; offset += 1) {
        if (!(await portProbe.portFree(base + offset))) {
          free = false;
          break;
        }
      }
      if (free) return base;
    }
    throw new Error('the test needs a free host-port block in 3300-3989');
  }

  function rendezvousAfterSelection(): Set<string> {
    const selected = new Set<string>();
    let release!: () => void;
    const secondQuery = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest.mocked(host.engine).mockImplementation(async () => {
      const name = currentContext().workspace;
      if (!selected.has(name)) {
        selected.add(name);
        if (selected.size === 2) release();
        else {
          // A real host query can be slow after a port has been selected. The
          // baseline releases _ports before this query, so both creates reach
          // this rendezvous with the same unrecorded allocation. The fix keeps
          // the second outside it until the first record is visible. The bound
          // releases that first query without requiring the forbidden overlap.
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              secondQuery,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 1000);
              }),
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        }
      }
      return await healthy.engine();
    });
    return selected;
  }

  function onlyOneCreated(outcomes: PromiseSettledResult<Record<string, unknown>>[]): void {
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(refused?.status).toBe('rejected');
    if (refused?.status === 'rejected') {
      expect(refused.reason).toBeInstanceOf(ConflictError);
      expect((refused.reason as ConflictError).exitCode).toBe(8);
    }
    expect(deployed).toHaveLength(1);
    expect(deploymentRecords).toHaveLength(1);
    expect(deploymentLocks).toEqual([false]);
  }

  async function holder(
    name: string,
    hostPort: number,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await record.writeRecord(
      name,
      record.metadata({ name, project: `houston-${name}`, hostPort, extra }),
    );
  }

  it('refuses a concurrent explicit RC collision before deploying or publishing the second workspace', async () => {
    const port = await availableBlock();
    const selected = rendezvousAfterSelection();
    const outcomes = await Promise.allSettled([
      create('rc-first', { port }),
      create('rc-second', { port }),
    ]);
    onlyOneCreated(outcomes);
    expect(selected.size).toBe(1);
    const metas = await record.listMeta();
    expect(metas).toHaveLength(1);
    expect(metas[0]?.hostPort).toBe(port);
  });

  it('allocates disjoint complete automatic multi-instance blocks to concurrent creates', async () => {
    rendezvousAfterSelection();
    const outcomes = await Promise.allSettled([
      create('auto-first', { deployment: 'multi-instance', replicas: 2 }),
      create('auto-second', { deployment: 'multi-instance', replicas: 2 }),
    ]);
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    const first = await record.readMeta('auto-first');
    const second = await record.readMeta('auto-second');
    expect(first.extra.instances).toBe(2);
    expect(second.extra.instances).toBe(2);
    const firstBlock = new Set([first.hostPort, first.hostPort + 1, first.hostPort + 2]);
    expect(
      [second.hostPort, second.hostPort + 1, second.hostPort + 2].some((port) =>
        firstBlock.has(port),
      ),
    ).toBe(false);
    expect(deploymentRecords).toHaveLength(2);
    expect(deploymentLocks).toEqual([false, false]);
  });

  it('allocates disjoint Mailpit ports to concurrent email creates, each built on its own', async () => {
    // Every email ticket needs the email preset: two people creating one at once both get a
    // workspace, the second on the next free port -- and each is BUILT on its own, so its
    // links and houston's own 2FA read open its inbox and not the other's.
    const port = await availableBlock(2);
    jest.mocked(portProbe.portFree).mockResolvedValue(true);
    rendezvousAfterSelection();
    const outcomes = await Promise.allSettled([
      create('mail-first', { preset: 'email', port }),
      create('mail-second', { preset: 'email', port: port + 1 }),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled']);
    const metas = await Promise.all(['mail-first', 'mail-second'].map(record.readMeta));
    const mailpits = metas.map((meta) => (meta.extra.sidecar_ports as number[])[0]);
    expect([...mailpits].sort()).toEqual([8025, 8026]);
    const kept = metas[mailpits.indexOf(8025)] as record.Metadata;
    const moved = metas[mailpits.indexOf(8026)] as record.Metadata;
    expect(moved.extra.side_ports).toEqual({ email: [8026] });
    expect(moved.extra.mailpit_url).toBe('http://localhost:8026');
    expect(JSON.stringify(await record.readCompose(moved.name))).toContain('127.0.0.1:8026:8025');
    // The first reads exactly as a workspace made before ports could move.
    expect(kept.extra).not.toHaveProperty('side_ports');
    expect(kept.extra.mailpit_url).toBe('http://localhost:8025');
    expect(deploymentLocks).toEqual([false, false]);
  });

  it('refuses an overlapping explicit instance block before the second deployment', async () => {
    const port = await availableBlock(4);
    rendezvousAfterSelection();
    const outcomes = await Promise.allSettled([
      create('block-first', { port, deployment: 'multi-instance', replicas: 2 }),
      create('block-second', { port: port + 1, deployment: 'multi-instance', replicas: 2 }),
    ]);
    onlyOneCreated(outcomes);
    expect(await record.listMeta()).toHaveLength(1);
    expect(deploymentRecords[0]?.extra.instances).toBe(2);
  });

  it('releases an unpublished allocation after a planning failure without leaving a record or claim', async () => {
    const port = await availableBlock();
    jest
      .mocked(host.engine)
      .mockRejectedValueOnce(new Error('host query failed before publication'));
    await expect(create('unpublished', { port })).rejects.toThrow(
      'host query failed before publication',
    );
    expect(await paths.exists('unpublished')).toBe(false);
    expect(await record.listMeta()).toEqual([]);
    expect(await portProbe.usedPorts()).toEqual(new Set());
    expect(openEntries()).toEqual([]);
    expect(deployed).toEqual([]);
    await expect(create('after-failure', { port })).resolves.toMatchObject({ host_port: port });
    expect(deployed).toEqual(['after-failure']);
  });

  it('lets independent runtime deployments proceed together after both records have been published', async () => {
    const port = await availableBlock(2);
    let release!: () => void;
    const bothDeploying = new Promise<void>((resolve) => {
      release = resolve;
    });
    let timer: NodeJS.Timeout | undefined;
    let overlapped = false;
    jest.mocked(ready.upCompose).mockImplementation(async (name) => {
      deployed.push(name);
      deploymentLocks.push(heldBy(PORT_LOCK));
      deploymentRecords.push(await record.readMeta(name));
      if (deployed.length === 2) {
        overlapped = true;
        release();
      } else
        await Promise.race([
          bothDeploying,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 1000);
          }),
        ]);
      return 0;
    });
    try {
      await expect(
        Promise.all([
          create('deploy-first', { port }),
          create('deploy-second', { port: port + 1 }),
        ]),
      ).resolves.toHaveLength(2);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    expect(overlapped).toBe(true);
    expect(deploymentRecords).toHaveLength(2);
    expect(deploymentLocks).toEqual([false, false]);
  });

  it('moves a side port past RC, instance, monitoring and TLS claims of other workspaces', async () => {
    jest.mocked(portProbe.portFree).mockResolvedValue(true);
    for (const [kind, main, extra, want] of [
      ['rc', 8025, {}, 8026],
      // An instance block claims its base and the next N: 8024, 8025, 8026.
      ['instance', 8024, { instances: 2 }, 8027],
      ['monitor', 3300, { monitoring_ports: [8025] }, 8026],
      ['tls', 3300, { tls_ports: [8025] }, 8026],
    ] as const) {
      await fs.rm(config.reprosDir(), { recursive: true, force: true });
      await holder(`side-holder-${kind}`, main, extra);
      await create(`side-mover-${kind}`, { preset: 'email' });
      const meta = await record.readMeta(`side-mover-${kind}`);
      expect({ kind, ports: meta.extra.sidecar_ports }).toEqual({ kind, ports: [want] });
      expect({ kind, side: meta.extra.side_ports }).toEqual({ kind, side: { email: [want] } });
    }
  });

  it('moves monitoring past every recorded claim category', async () => {
    jest.mocked(portProbe.portFree).mockResolvedValue(true);
    for (const [kind, main, extra, want] of [
      ['rc', 9090, {}, [9091, 5050]],
      ['instance', 9089, { instances: 2 }, [9092, 5050]],
      ['side', 3300, { sidecar_ports: [9090] }, [9091, 5050]],
      ['tls', 3300, { tls_ports: [9090] }, [9091, 5050]],
      ['monitor', 3300, { monitoring_ports: [9090, 5050] }, [9091, 5051]],
    ] as const) {
      await fs.rm(config.reprosDir(), { recursive: true, force: true });
      await holder(`monitor-holder-${kind}`, main, extra);
      await create(`monitor-mover-${kind}`, { monitor: true });
      const meta = await record.readMeta(`monitor-mover-${kind}`);
      expect({ kind, ports: meta.extra.monitoring_ports }).toEqual({ kind, ports: [...want] });
      const doc = JSON.stringify(await record.readCompose(meta.name));
      expect({ kind, grafana: doc.includes(`127.0.0.1:${String(want[1])}:3000`) }).toEqual({
        kind,
        grafana: true,
      });
    }
  });

  it("keeps a rebuilt workspace's moved ports while they are its own, and says so when one is not", async () => {
    jest.mocked(portProbe.portFree).mockResolvedValue(true);
    await holder('first', 3300, { sidecar_ports: [8025] });
    await create('mine', { preset: 'email' });
    expect((await record.readMeta('mine')).extra.side_ports).toEqual({ email: [8026] });
    // A rebuild keeps it: a moved port must not wander back, or every link to it breaks.
    await create('mine', { preset: 'email', force: true });
    expect((await record.readMeta('mine')).extra.side_ports).toEqual({ email: [8026] });
    // Something else took it while the workspace was stopped: it moves, and the create says so.
    jest.mocked(portProbe.portFree).mockImplementation(async (port) => port !== 8026);
    jest.spyOn(queries, 'rcState').mockResolvedValue('exited');
    const said: string[] = [];
    await runWithContext(
      { workspace: 'mine' },
      async () =>
        await createRepro(
          createReq({
            version: '8.5.1',
            runtime: 'docker',
            name: 'mine',
            offline: true,
            preset: 'email',
            force: true,
          }),
          (event) => said.push(event.message),
        ),
    );
    expect((await record.readMeta('mine')).extra.side_ports).toEqual({ email: [8027] });
    expect(said).toContain("email's port 8026 is no longer free, so 'mine' publishes it on 8027");
  });

  it('keeps a port its own container still publishes, though Rocket.Chat never started', async () => {
    // A failed boot: MongoDB never healthy, Rocket.Chat `created`, its own Mailpit up on 8025.
    // `up --force` read that as "something else took 8025" and moved the machine's first email
    // workspace to 8026 for good, with a warning blaming somebody else (review 2026-10-31).
    jest.mocked(portProbe.portFree).mockResolvedValue(true);
    await create('first', { preset: 'email' });
    jest.mocked(portProbe.portFree).mockImplementation(async (port) => port !== 8025);
    jest.spyOn(queries, 'rcState').mockResolvedValue('created');
    jest.mocked(engine.publishedPorts).mockResolvedValue(new Set([8025]));
    const said: string[] = [];
    await runWithContext(
      { workspace: 'first' },
      async () =>
        await createRepro(
          createReq({
            version: '8.5.1',
            runtime: 'docker',
            name: 'first',
            offline: true,
            preset: 'email',
            force: true,
          }),
          (event) => said.push(event.message),
        ),
    );
    const meta = await record.readMeta('first');
    expect(meta.extra.side_ports).toBeUndefined();
    expect(meta.extra.sidecar_ports).toEqual([8025]);
    expect(said.filter((line) => line.includes('no longer free'))).toEqual([]);
  });

  it('names no --set the caller did not type, though houston derives one on the way', async () => {
    // A saml workspace made on loopback records no IdP host; once the box binds 0.0.0.0 a plain
    // `up` derives one from the root URL, and the reuse named it as a --set (review 2026-10-31).
    // Through the whole create, so the copy of what was typed is proven to reach the reuse.
    jest.mocked(portProbe.portFree).mockResolvedValue(true);
    await create('sso', { preset: 'saml', rootUrl: 'http://box.example:3007' });
    jest.spyOn(queries, 'rcState').mockResolvedValue('running');
    config.updateConfig((cfg) => {
      cfg.bind_host = '0.0.0.0';
    });
    const said = async (values: Partial<CreateReq>): Promise<string> => {
      const lines: string[] = [];
      await runWithContext(
        { workspace: 'sso' },
        async () =>
          await createRepro(
            // `preset: ''` as the CLI sends it when no --preset is given: the recorded one is kept.
            createReq({
              version: '8.5.1',
              runtime: 'docker',
              name: 'sso',
              offline: true,
              preset: '',
              ...values,
            }),
            (event) => void lines.push(event.message),
          ),
      );
      return lines.join('\n');
    };
    try {
      const bare = await said({});
      expect(bare).toContain("will address its own service as 'box.example'");
      expect(bare).not.toContain('ignoring requested');
      expect(await said({ params: { idp_host: 'other.example' } })).toContain(
        'ignoring requested --set idp_host=other.example',
      );
    } finally {
      config.updateConfig((cfg) => {
        delete cfg.bind_host;
      });
    }
  });

  it('lets a typed --set instances win over the count the record carries', async () => {
    // The record's count was carried into --replicas, which then beat the typed param:
    // `up --force --set instances=4` rebuilt a 3-instance workspace with 3 (review 2026-10-31).
    jest.mocked(portProbe.portFree).mockResolvedValue(true);
    await create('multi', { deployment: 'multi-instance', replicas: 3 });
    expect((await record.readMeta('multi')).extra.instances).toBe(3);
    await create('multi', { params: { instances: '4' }, force: true });
    expect((await record.readMeta('multi')).extra.instances).toBe(4);
    await create('multi', { replicas: 2, force: true });
    expect((await record.readMeta('multi')).extra.instances).toBe(2);
  });

  it('never moves a side port onto the port Rocket.Chat was asked to publish on', async () => {
    jest.mocked(portProbe.portFree).mockResolvedValue(true);
    await holder('first', 3300, { sidecar_ports: [8025] });
    await create('asked', { preset: 'email', port: 8026 });
    const meta = await record.readMeta('asked');
    expect(meta.hostPort).toBe(8026);
    expect(meta.extra.sidecar_ports).toEqual([8027]);
  });

  it("still refuses voice's call ports, which cannot move, naming who holds them", async () => {
    jest.mocked(portProbe.portFree).mockResolvedValue(true);
    await holder('voice-a', 3300, {
      sidecar_ports: Array.from({ length: 47 }, (_, i) => 20000 + i),
    });
    await expect(
      create('voice-b', { preset: 'voice', params: { sip_integration: 'on' } }),
    ).rejects.toThrow(/\[20000, .*already claimed by workspace 'voice-a'.*cannot move/su);
    expect(await paths.exists('voice-b')).toBe(false);
    expect(deployed).toEqual([]);
  });

  it('refuses the main RC port on its own preset side port before any record or deployment', async () => {
    await expect(create('self-mail', { preset: 'email', port: 8025 })).rejects.toThrow(
      "--port 8025 is also a port this workspace's presets or monitoring publish",
    );
    expect(await record.listMeta()).toEqual([]);
    expect(deployed).toEqual([]);
  });

  it('refuses the main RC port on its own monitoring port before any record or deployment', async () => {
    await expect(create('self-monitor', { monitor: true, port: 9090 })).rejects.toThrow(
      "--port 9090 is also a port this workspace's presets or monitoring publish",
    );
    expect(await record.listMeta()).toEqual([]);
    expect(deployed).toEqual([]);
  });

  it("automatic allocation avoids the same workspace's fixed side port", async () => {
    // One real record covers [3000, 8024]; no real sockets or containers are
    // reserved. Mailpit's 8025 is the next numerical gap, but RC must skip it.
    await holder('recorded-range', 3000, { instances: 5024 });
    await expect(create('auto-mail', { preset: 'email' })).resolves.toHaveProperty('host_port');
    const created = await record.readMeta('auto-mail');
    expect(created.hostPort).toBeGreaterThan(8025);
    expect(created.extra.sidecar_ports).toContain(8025);
    expect(deployed).toEqual(['auto-mail']);
  });
});
