/**
 * `core/lifecycle/ports`: which host port a workspace gets, and what its record says it is.
 */
import * as fs from 'node:fs';

import type * as ConfigNS from '../../../src/lib/config';
import type * as ErrorsNS from '../../../src/lib/errors';
import { nullEmit } from '../../../src/lib/events';
import { emptyPreset } from '../../../src/lib/presets/types';

import type * as CreateDockerNS from '../../../src/core/lifecycle/create-docker';
import type * as PortsNS from '../../../src/core/lifecycle/ports';
import type * as RecordNS from '../../../src/core/runner/record';
import type * as TypesNS from '../../../src/core/lifecycle/types';
import type * as VersionsNS from '../../../src/lib/versions';
import type * as PresetsNS from '../../../src/lib/presets/index';
import type * as PathsNS from '../../../src/core/runner/paths';

const ISOLATED = [
  '../../../src/core/runner/ports',
  '../../../src/core/runner/paths',
  '../../../src/core/runner/record',
  '../../../src/core/runner/queries',
  '../../../src/core/lifecycle/ports',
  '../../../src/core/lifecycle/sizing',
  '../../../src/core/lifecycle/ready',
  '../../../src/lib/versions',
];

afterEach(() => {
  for (const module of ISOLATED) jest.dontMock(module);
  jest.resetModules();
});

describe('picking a host port', () => {
  it('refuses a port another workspace already claims', async () => {
    jest.resetModules();
    jest.doMock('../../../src/core/runner/ports', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/ports'),
      usedPorts: async () => new Set([8300]),
    }));
    const ports = require('../../../src/core/lifecycle/ports') as typeof PortsNS;
    // The class from the SAME registry the fresh module threw from: after `resetModules` an
    // import at the top of this file is a different class object with the same name.
    const { ConflictError } = require('../../../src/lib/errors') as typeof ErrorsNS;
    await expect(ports.pickHostPort(8300, emptyPreset('default'), '')).rejects.toThrow(
      ConflictError,
    );
  });
});

describe("an explicit --port beside the presets' own ports", () => {
  it("refuses an instance port that lands on one of the workspace's side ports", async () => {
    jest.resetModules();
    jest.doMock('../../../src/core/runner/ports', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/ports'),
      usedPorts: async () => new Set<number>(),
      portFree: async () => true,
    }));
    const ports = require('../../../src/core/lifecycle/ports') as typeof PortsNS;
    const pre = { instances: 2, ports: [8081] } as Parameters<typeof PortsNS.pickHostPort>[1];
    await expect(ports.pickHostPort(8080, pre, '')).rejects.toThrow(
      "--port 8080: instance port 8081 is also a port this workspace's presets publish",
    );
    await expect(ports.pickHostPort(8090, pre, '')).resolves.toBe(8090);
  });
});

describe('the side ports a preset publishes', () => {
  /** Fresh modules and no workspaces, with this machine's ports free unless `busy` says not. */
  function fresh(busy: (port: number) => boolean = () => false) {
    jest.resetModules();
    const config = require('../../../src/lib/config') as typeof ConfigNS;
    fs.rmSync(config.reprosDir(), { recursive: true, force: true });
    jest.doMock('../../../src/core/runner/ports', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/ports'),
      portFree: async (port: number) => !busy(port),
    }));
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    const paths = require('../../../src/core/runner/paths') as typeof PathsNS;
    const ports = require('../../../src/core/lifecycle/ports') as typeof PortsNS;
    const presets = require('../../../src/lib/presets/index') as typeof PresetsNS;
    const hold = async (name: string, extra: Record<string, unknown>, preset = 'default') =>
      await record.write(
        name,
        'services: {}\n',
        record.metadata({ name, project: `houston-${name}`, preset, hostPort: 3000, extra }),
      );
    const claim = async (
      name: string,
      preset: string,
      params: Record<string, unknown> = {},
      options: Parameters<typeof PortsNS.claimSidePorts>[3] = {},
    ) =>
      await ports.claimSidePorts(
        name,
        presets.load(preset, params),
        (given) => presets.load(preset, params, given),
        options,
      );
    return { paths, ports, hold, claim };
  }

  it('gives the first workspace the preferred port, and the next one the next free port', async () => {
    // Every email ticket needs the email preset: a second email workspace on the same server
    // was refused while the first held 8025.
    const { hold, claim } = fresh();
    expect((await claim('first', 'email')).side).toEqual({});
    await hold('first', { sidecar_ports: [8025] }, 'email');
    const second = await claim('second', 'email');
    expect(second.side).toEqual({ email: [8026] });
    expect(second.pre.ports).toEqual([8026]);
    // Built on it, not merely claimed: houston reads that workspace's 2FA codes from here.
    expect(second.pre.extra.mailpit_url).toBe('http://localhost:8026');
  });

  it("never hands out another preset's preferred port, so the first of each keeps its own", async () => {
    const { hold, claim } = fresh();
    await hold('sso-a', { sidecar_ports: [8081] }, 'saml');
    // 8082 is ldap's: a second saml there would push the next ldap workspace off it.
    expect((await claim('sso-b', 'saml')).side).toEqual({ saml: [8083] });
    expect((await claim('dir-a', 'ldap')).side).toEqual({});
  });

  it('gives two ports of one allocation two numbers', async () => {
    const { hold, claim } = fresh();
    await hold('s3-a', { sidecar_ports: [9000, 9001] }, 's3_minio');
    expect((await claim('s3-b', 's3_minio')).side).toEqual({ s3_minio: [9002, 9003] });
  });

  it('keeps a port the workspace already holds, and moves it only when it is not its own', async () => {
    // Its own Mailpit is what holds 8026, so the probe saying "busy" is not a reason to move.
    const { hold, claim } = fresh((port) => port === 8026);
    await hold('first', { sidecar_ports: [8025] }, 'email');
    await hold('mine', { sidecar_ports: [8026], side_ports: { email: [8026] } }, 'email');
    const kept = await claim('mine', 'email');
    expect(kept.side).toEqual({ email: [8026] });
    expect(kept.moved).toEqual([]);
    // Something else took it while the workspace was stopped: it moves, and says so.
    const lost = await claim('mine', 'email', {}, { stillHeld: async () => false });
    expect(lost.side).toEqual({ email: [8027] });
    expect(lost.moved).toEqual([['email', 8026, 8027]]);
  });

  it("keeps an older record's ports, which it holds without saying which preset they are", async () => {
    // Written before ports could move: no `side_ports`, the preferred numbers in the flat list.
    const { hold, claim } = fresh(() => true);
    await hold('old', { sidecar_ports: [8025, 8082] }, 'email+ldap');
    const again = await claim('old', 'email');
    expect(again.side).toEqual({});
    expect(again.pre.ports).toEqual([8025]);
  });

  it('never lands on the port the request asked Rocket.Chat to publish on', async () => {
    const { hold, claim } = fresh();
    await hold('first', { sidecar_ports: [8025] }, 'email');
    expect((await claim('second', 'email', {}, { reserve: [8026] })).side).toEqual({
      email: [8027],
    });
  });

  it('takes a moved port it lost back to its preferred number when that is free', async () => {
    // It went past 8025 to 8027 though nothing held 8025 any more (review 2026-10-31).
    const { hold, claim } = fresh((port) => port === 8026);
    await hold('mine', { sidecar_ports: [8026], side_ports: { email: [8026] } }, 'email');
    const lost = await claim('mine', 'email', {}, { stillHeld: async () => false });
    expect(lost.side).toEqual({});
    expect(lost.moved).toEqual([['email', 8026, 8025]]);
  });

  it("keeps no recorded side port that is another's: its own Rocket.Chat port or voice's", async () => {
    // A hand-edited record: Mailpit "recorded" on the workspace's own 3000, or on voice's 5060,
    // was kept, and Rocket.Chat then quietly moved off its own port (review 2026-10-31).
    const { hold, claim } = fresh();
    await hold('mine', { sidecar_ports: [3000], side_ports: { email: [3000] } }, 'email');
    expect((await claim('mine', 'email')).side).toEqual({});
    await hold('mine', { sidecar_ports: [5060], side_ports: { email: [5060] } }, 'email');
    expect((await claim('mine', 'email')).side).toEqual({});
  });

  it('gives the preferred port back once its holder is gone', async () => {
    const { hold, claim, paths } = fresh();
    await hold('first', { sidecar_ports: [8025] }, 'email');
    expect((await claim('second', 'email')).side).toEqual({ email: [8026] });
    await paths.remove('first');
    expect((await claim('second', 'email')).side).toEqual({});
  });

  it("gives monitoring the next free pair, past voice's SIP port", async () => {
    const { hold, ports } = fresh();
    await hold('watched', { monitoring: true, monitoring_ports: [9090, 5050] });
    expect(await ports.claimMonitorPorts('second', ['prometheus', 'grafana'])).toEqual([
      9091, 5051,
    ]);
    await hold('more', {
      monitoring_ports: [5051, 5052, 5053, 5054, 5055, 5056, 5057, 5058, 5059],
    });
    // 5060 is SIP: phones dial it by number, so no Grafana is ever put there.
    expect(await ports.claimMonitorPorts('third', ['grafana'])).toEqual([5061]);
    // Its own pair, while it holds it.
    expect(await ports.claimMonitorPorts('watched', ['prometheus', 'grafana'])).toEqual([
      9090, 5050,
    ]);
  });

  it("refuses a port that cannot move, naming the holder's owner and leaving freeing it to them", async () => {
    // Voice's call ports are dialled by number. On a shared server the holder is usually a
    // colleague's: the refusal says whose it is, and that freeing it deletes its data.
    const { hold, ports } = fresh();
    await hold('bob-t1', { sidecar_ports: [20000], created_by: 'bob' }, 'voice');
    const voice = { ...emptyPreset('voice'), ports: [20000, 20001] };
    let said = '';
    await ports
      .claimSidePorts('alice-t1', voice, () => voice)
      .catch((error: unknown) => (said = String(error)));
    expect(said).toContain(
      "preset 'voice' publishes port(s) [20000], already claimed by workspace 'bob-t1' (bob's). " +
        'These ports cannot move to another number',
    );
    expect(said).toContain(
      'its owner frees them with houston down --name bob-t1 --volumes (that deletes its data)',
    );
    // Its own ports are not a claim against itself.
    await expect(ports.claimSidePorts('bob-t1', voice, () => voice)).resolves.toMatchObject({
      side: {},
    });
  });
});

describe('the recorded root_url', () => {
  it('is always the local port, while Rocket.Chat still advertises the override', async () => {
    // A record's root_url is what houston's OWN calls use -- login, PAT, seeding, load tests,
    // and `ready`, which polls it. `--root-url` used to displace it with a public https name,
    // and `ready` then waited 300s on DNS while localhost answered 200 the whole time.
    const written: { yaml: string; meta: RecordNS.Metadata }[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/runner/paths', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/paths'),
      exists: async () => false,
    }));
    jest.doMock('../../../src/core/lifecycle/sizing', () => ({
      ...jest.requireActual<object>('../../../src/core/lifecycle/sizing'),
      checkCapacity: async () => undefined,
    }));
    // No MongoDB left by another home; there is no Docker here to answer that ask.
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      projectDataVolumes: async () => [],
    }));
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual<object>('../../../src/core/lifecycle/ports'),
      pickHostPort: async () => 3001,
    }));
    jest.doMock('../../../src/lib/versions', () => {
      const actual = jest.requireActual<typeof VersionsNS>('../../../src/lib/versions');
      return {
        ...actual,
        resolve: (version: string) => actual.resolve(version, { offline: true }),
      };
    });
    jest.doMock('../../../src/core/runner/record', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/record'),
      write: async (_name: string, yaml: string, meta: RecordNS.Metadata) => {
        written.push({ yaml, meta });
      },
    }));
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual<object>('../../../src/core/lifecycle/ready'),
      upCompose: async () => 0,
    }));
    const { createRepro } =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const { createReq } = require('../../../src/core/lifecycle/types') as typeof TypesNS;

    await createRepro(
      createReq({
        version: '8.5.1',
        name: 'urlcase',
        rootUrl: 'https://lab.example.com',
        wait: false,
        offline: true,
      }),
      nullEmit,
    );

    expect(written).toHaveLength(1);
    expect(written[0]?.meta.rootUrl).toBe('http://localhost:3001');
    // ...or `--root-url` would do nothing at all.
    expect(written[0]?.yaml).toContain('ROOT_URL: https://lab.example.com');
  });
});

describe('a port block past the top of the range', () => {
  it('is refused as a validation error, not truncated', async () => {
    // Three instances need a four-port block, and 65535 has no room for one.
    jest.resetModules();
    const ports = require('../../../src/core/lifecycle/ports') as typeof PortsNS;
    const { ValidationError } = require('../../../src/lib/errors') as typeof ErrorsNS;
    await expect(
      ports.pickHostPort(65535, { ...emptyPreset('default'), instances: 3 }, ''),
    ).rejects.toThrow(ValidationError);
  });
});
