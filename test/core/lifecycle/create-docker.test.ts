import * as config from '../../../src/lib/config';
import { nullEmit } from '../../../src/lib/events';
import * as presets from '../../../src/lib/presets/index';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as YAML from 'yaml';

import type { Preset } from '../../../src/lib/presets/types';
import type { Resolved } from '../../../src/lib/versions';
import type * as VersionsNS from '../../../src/lib/versions';
import type * as PolicyNS from '../../testsetup-policy';
import type * as ContextNS from '../../../src/lib/context';
import { openEntries } from '../../../src/core/journal';
import {
  type Metadata,
  adminPass,
  metadata,
  readMeta,
  writeRecord,
} from '../../../src/core/runner/record';

import { createPlan } from '../../../src/core/lifecycle/create-docker';

import type * as CreateDockerNS from '../../../src/core/lifecycle/create-docker';
import type * as CreateK8sNS from '../../../src/core/lifecycle/create-k8s';
import { MODE_ACME, tlsSpec } from '../../../src/core/tls';
import { type CreateReq, createReq } from '../../../src/core/lifecycle/types';
import * as users from '../../../src/core/users';

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

describe('the image a rebuild runs', () => {
  it('is the one the workspace was built from, on the release it runs', async () => {
    // `up --force` without `--rc-image` rebuilt a patched image's workspace from the default
    // repository; a Kubernetes re-up already kept it. Another release is another image.
    const patched = 'registry.example.com/rc:8.5.1-patched';
    await writeRecord(
      'rc8-5-1',
      metadata({ name: 'rc8-5-1', rcVersion: '8.5.1', rcImage: patched }),
    );
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const pairing = async (values: Partial<ReturnType<typeof createReq>>): Promise<string> => {
      const plan = createPlan({
        req: createReq({ version: '8.5.1', offline: true, force: true, ...values }),
        emit: nullEmit,
      });
      await createDocker.resolvePairing(plan);
      return String(plan.resolved?.rcImage);
    };
    expect(await pairing({})).toBe(patched);
    expect(await pairing({ rcImage: 'mine/rc:1' })).toBe('mine/rc:1');
    expect(await pairing({ version: '8.6.1', name: 'rc8-5-1' })).not.toBe(patched);
    fs.rmSync(path.join(config.home(), 'repros', 'rc8-5-1'), { recursive: true, force: true });
  });
});

describe('claiming the Compose ports', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('does not turn a falsy recorded token into the string "false"', async () => {
    // The third of the three sites the review named: a `reg_token: false` in config must
    // mean "no token", because `String(false)` is truthy and would travel into the
    // generated compose document as a licence the user never supplied.
    config.updateConfig((cfg) => {
      cfg.reg_token = false;
    });
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      claimSidePorts: preferredSidePorts,
      pickHostPort: async () => 3100,
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/tlsplan'),
      resolveTls: async () => null,
    }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const plan = createPlan({ req: createReq({ version: '8.5.1' }), emit: nullEmit });
    // The config `resolvePairing` would have loaded. Without it `plan.cfg` is `{}`, and
    // the test passes whether the token mapping is right or wrong -- the defect class the
    // review itself calls "a case that compares [] to []".
    plan.cfg = config.loadConfig();
    plan.pre = presets.load('default', {});
    await createDocker.claimPorts(plan);
    expect(plan.token).toBe('');
    expect(plan.hostPort).toBe(3100);
    expect(plan.root).toBe('http://localhost:3100');
  });

  it('keeps an explicit token and an explicit bind', async () => {
    config.updateConfig((cfg) => {
      cfg.reg_token = 'from-config';
    });
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      claimSidePorts: preferredSidePorts,
      pickHostPort: async () => 3200,
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/tlsplan'),
      resolveTls: async () => null,
    }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const plan = createPlan({
      req: createReq({ version: '8.5.1', regToken: 'explicit', bind: '0.0.0.0' }),
      emit: nullEmit,
    });
    plan.cfg = config.loadConfig();
    plan.pre = presets.load('default', {});
    await createDocker.claimPorts(plan);
    expect(plan.token).toBe('explicit');
    expect(plan.bindHost).toBe('0.0.0.0');
    // A wildcard includes loopback, so houston still calls it there.
    expect(plan.root).toBe('http://localhost:3200');
  });

  it('calls a workspace bound to one address on that address', async () => {
    // `--bind 172.17.0.1` published nothing on loopback, so readiness polled
    // `localhost` and `up --wait` always ended exit 5 while Rocket.Chat served on the
    // bridge -- and the warning said it was published "on every interface".
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      claimSidePorts: preferredSidePorts,
      pickHostPort: async () => 3611,
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/tlsplan'),
      resolveTls: async () => null,
    }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const said: string[] = [];
    const plan = createPlan({
      req: createReq({ version: '8.5.1', bind: '172.17.0.1' }),
      emit: (event) => said.push(event.message),
    });
    plan.cfg = config.loadConfig();
    plan.pre = presets.load('default', {});
    await createDocker.claimPorts(plan);
    expect(plan.root).toBe('http://172.17.0.1:3611');
    createDocker.warnAboutTheBind(plan);
    expect(said.join(' ')).toContain('to everyone who can reach 172.17.0.1');
    expect(said.join(' ')).not.toContain('every interface');
  });

  it('keeps a rebuilt workspace on its recorded port, unless something else holds it', async () => {
    // `up --force` allocated afresh, from 3000: a workspace on 3301 came back on 3000 and
    // every link to it went dead. A Kubernetes re-up already kept its port. But a stopped
    // workspace's port taken by something else since is not its to keep: the real
    // `pickHostPort` skips the probe for a workspace's own recorded ports, so compose failed
    // to bind it.
    await writeRecord(
      'moved',
      metadata({ name: 'moved', project: 'houston-moved', hostPort: 3301 }),
    );
    let held = false;
    let state = 'exited';
    jest.resetModules();
    jest.doMock('../../../src/core/runner/ports', () => ({
      ...jest.requireActual('../../../src/core/runner/ports'),
      portFree: async (port: number) => !(held && port === 3301),
      pickPort: async () => 3000,
    }));
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../../src/core/runner/queries'),
      rcState: async () => state,
    }));
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      claimSidePorts: preferredSidePorts,
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/tlsplan'),
      resolveTls: async () => null,
    }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const got: number[] = [];
    const said: string[] = [];
    // Free; held by its own running Rocket.Chat; held by something else while it is stopped.
    for (const [taken, rc] of [
      [false, 'exited'],
      [true, 'running'],
      [true, 'exited'],
    ] as const) {
      held = taken;
      state = rc;
      const plan = createPlan({
        req: createReq({ version: '8.5.1', name: 'moved', force: true }),
        emit: (event) => {
          if (event.level === 'warn') said.push(event.message);
        },
        reproName: 'moved',
      });
      plan.cfg = config.loadConfig();
      plan.pre = presets.load('default', {});
      await createDocker.claimPorts(plan);
      got.push(plan.hostPort);
    }
    expect(got).toEqual([3301, 3301, 3000]);
    // The move is said: every link to the old port stops working.
    expect(said).toEqual(["port 3301 is no longer free, so 'moved' moves to 3000"]);
  });
});

describe('the create path end to end, stopped at the write seam', () => {
  let bin = '';
  let previousPath: string | undefined;
  beforeEach(() => {
    // A PATH holding one empty directory: no launch this file did not state can happen.
    previousPath = process.env.PATH;
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-nobin-'));
    process.env.PATH = bin;
  });
  afterEach(() => {
    process.env.PATH = previousPath;
    fs.rmSync(bin, { recursive: true, force: true });
    jest.doMock('../../../src/core/runner/host', () =>
      (require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    for (const id of [
      '../../../src/core/lifecycle/sizing',
      '../../../src/core/lifecycle/ports',
      '../../../src/core/lifecycle/tlsplan',
      '../../../src/core/lifecycle/preconditions',
      '../../../src/lib/versions',
      '../../../src/core/runner/record',
      '../../../src/core/runner/engine',
    ]) {
      jest.dontMock(id);
    }
    jest.resetModules();
  });

  /** The Compose create with the engine stated, capturing the record and the document. */
  function capture(): {
    seen: { meta?: Metadata; yaml?: string; keep?: ReadonlySet<string> };
    createDocker: typeof CreateDockerNS;
  } {
    jest.resetModules();
    const seen: { meta?: Metadata; yaml?: string; keep?: ReadonlySet<string> } = {};
    jest.doMock('../../../src/core/runner/host', () => ({
      ...(require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
      dockerKernelVersion: async () => '6.1.0',
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/sizing', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/sizing'),
      checkCapacity: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      pickHostPort: async () => 3001,
      claimSidePorts: preferredSidePorts,
    }));
    jest.doMock('../../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/tlsplan'),
      resolveTls: async () => null,
    }));
    jest.doMock('../../../src/lib/versions', () => {
      const actual = jest.requireActual<typeof VersionsNS>('../../../src/lib/versions');
      return {
        ...actual,
        resolve: (version: string): Resolved => actual.resolve(version, { offline: true }),
      };
    });
    jest.doMock('../../../src/core/runner/record', () => ({
      ...jest.requireActual('../../../src/core/runner/record'),
      write: async (
        _name: string,
        yaml: string,
        meta: Metadata,
        _files: unknown,
        keep: ReadonlySet<string>,
      ) => {
        seen.meta = meta;
        seen.yaml = yaml;
        seen.keep = keep;
        throw new Error('stopped at the write seam');
      },
    }));
    return {
      seen,
      createDocker: require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS,
    };
  }

  it('leaves no write-ahead note behind for a create that was refused', async () => {
    // The note is for a create that died HALF WAY, not one that never started. With no
    // cleanup on the refusal path every refusal stranded one -- seven accumulated during
    // one audit -- and `doctor` then told the reader to run `houston ready` on a workspace
    // that does not exist, which exits 4. A real refusal: --fresh on Kubernetes.
    const before = openEntries().length;
    const { createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({ version: '8.5.1', name: 'refu', runtime: 'kubernetes', fresh: true }),
      ),
    ).rejects.toThrow(/--fresh is not supported on Kubernetes/u);
    expect(openEntries()).toHaveLength(before);
  });

  it('brings back only a workspace that is still there when its turn comes', async () => {
    // The GUI's Bring it up, queued behind a Delete, found the name free once the Delete
    // let go of it and made a new, EMPTY workspace in its place.
    const { seen, createDocker } = capture();
    const back = createReq({
      version: '8.5.1',
      name: 'gone',
      exactName: true,
      bringBack: true,
      offline: true,
    });
    await expect(createDocker.createRepro(back)).rejects.toThrow(
      "'gone' was deleted while this waited its turn",
    );
    await expect(createDocker.createRepro(back)).rejects.toHaveProperty('exitCode', 4); // not_found
    expect(seen.meta).toBeUndefined();
  });

  it('keeps the shared password for a workspace nothing off this box can reach', async () => {
    // Loopback is the entire reason `admin123` is acceptable; rotating it here would cost
    // every runbook and buy nothing.
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({ version: '8.5.1', name: 'loop', wait: false, offline: true }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    expect(seen.meta?.adminPassword).toBe('');
    expect(adminPass(seen.meta as Metadata)).toBe(config.ADMIN_PASSWORD);
    expect(seen.yaml).toContain('admin123');
  });

  it('warns that Rocket.Chat 9 may refuse an unlicensed LDAP login', async () => {
    // An earlier case leaves a box-wide token, which rightly silences the warning.
    config.updateConfig((cfg) => {
      delete cfg.reg_token;
    });
    const { createDocker } = capture();
    const said: string[] = [];
    await expect(
      createDocker.createRepro(
        createReq({ version: '9.0.0', name: 'nine', preset: 'ldap', wait: false, offline: true }),
        (event) => said.push(event.message),
      ),
    ).rejects.toThrow('stopped at the write seam');
    expect(said.filter((line) => line.includes('Premium plan for LDAP login'))).toHaveLength(1);
  });

  it('warns that an unlicensed voice workspace boots without a call button', async () => {
    config.updateConfig((cfg) => {
      delete cfg.reg_token;
    });
    const { createDocker } = capture();
    const said: string[] = [];
    await expect(
      createDocker.createRepro(
        createReq({
          version: '8.7.0',
          name: 'voice-nolic',
          preset: 'voice',
          wait: false,
          offline: true,
        }),
        (event) => said.push(event.message),
      ),
    ).rejects.toThrow('stopped at the write seam');
    expect(said.filter((line) => line.includes('Voice add-on (teams-voip)'))).toHaveLength(1);
  });

  it('hands the record writer the files a preset keeps', async () => {
    // The PBX lab's dialplans are written once, so an edit survives `up --force`.
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({
          version: '8.8.1',
          name: 'kept',
          preset: 'voice',
          params: { sip: 'on', pbx: 'on' },
          wait: false,
          offline: true,
        }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    expect([...(seen.keep ?? [])].sort()).toEqual([
      'voice/pbx/extensions.conf',
      'voice/pbx/pjsip.conf',
      'voice/pbx/rtp.conf',
    ]);
  });

  it('warns that a wide bind publishes the softphone accounts', async () => {
    const { createDocker } = capture();
    const said: string[] = [];
    await expect(
      createDocker.createRepro(
        createReq({
          version: '8.8.1',
          name: 'wide-lab',
          preset: 'voice',
          params: { sip: 'on', pbx: 'on' },
          bind: '0.0.0.0',
          wait: false,
          offline: true,
        }),
        (event) => said.push(event.message),
      ),
    ).rejects.toThrow('stopped at the write seam');
    const softphones = "the PBX lab's softphone accounts, whose password is their number";
    expect(said.filter((line) => line.includes(softphones))).toHaveLength(1);
  });

  it('builds several presets as one workspace, recorded under the canonical name', async () => {
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({
          version: '8.5.1',
          name: 'combo',
          preset: 'email+ldap',
          wait: false,
          offline: true,
        }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    expect(seen.meta?.preset).toBe('email+ldap');
    expect(seen.yaml).toContain('mailpit:');
    expect(seen.yaml).toContain('openldap:');
    expect(seen.yaml).toMatch(
      /OVERWRITE_SETTING_Accounts_TwoFactorAuthentication_By_Email_Enabled: '?true'?\n/u,
    );
  });

  it("records the set: one preset string, the list and each preset's params in extra", async () => {
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({
          version: '8.5.1',
          name: 'combo-rec',
          preset: 'email+ldap',
          params: { 'ldap.users': '7' },
          wait: false,
          offline: true,
        }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    const extra = seen.meta?.extra ?? {};
    expect([seen.meta?.preset, extra.presets, extra.preset_params, 'params' in extra]).toEqual([
      'email+ldap',
      ['email', 'ldap'],
      { email: {}, ldap: { users: '7' } },
      false,
    ]);
  });

  it('records one preset exactly as before: flat params, no list', async () => {
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({
          version: '8.5.1',
          name: 'one-rec',
          preset: 'ldap',
          params: { users: '3' },
          wait: false,
          offline: true,
        }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    const extra = seen.meta?.extra ?? {};
    expect([seen.meta?.preset, extra.params, 'presets' in extra, 'preset_params' in extra]).toEqual(
      ['ldap', { users: '3' }, false, false],
    );
  });

  it('gives every instance of a multi-instance deployment the scenario', async () => {
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({
          version: '8.5.1',
          name: 'mi-ldap',
          preset: 'ldap',
          deployment: 'multi-instance',
          wait: false,
          offline: true,
        }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    expect([seen.meta?.preset, seen.meta?.extra.presets]).toEqual([
      'ldap+multi-instance',
      ['ldap', 'multi-instance'],
    ]);
    const yaml = seen.yaml ?? '';
    for (const service of ['rocketchat-1:', 'rocketchat-2:', 'openldap:', 'traefik:']) {
      expect(yaml).toContain(service);
    }
    expect(yaml.split('OVERWRITE_SETTING_LDAP_Enable').length - 1).toBe(2);
  });

  it("issues an LDAPS directory houston's certificate and hands Rocket.Chat the CA", async () => {
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({
          version: '8.5.1',
          name: 'ldaps',
          preset: 'ldap',
          params: { tls: 'ldaps' },
          wait: false,
          offline: true,
        }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    const yaml = seen.yaml ?? '';
    expect(yaml).toContain('./ldap/certs/ldap.crt:/container/certs/ldap.crt:ro');
    // The PEM survives the document: parsed back, it is the CA houston signs with.
    const doc = YAML.parse(yaml) as {
      services: { rocketchat: { environment: Record<string, string> } };
    };
    const ca = doc.services.rocketchat.environment.OVERWRITE_SETTING_LDAP_CA_Cert ?? '';
    expect(ca.startsWith('-----BEGIN CERTIFICATE-----\n')).toBe(true);
    expect(ca.trimEnd().endsWith('-----END CERTIFICATE-----')).toBe(true);
    expect(seen.meta?.extra.directory_tls).toBe('ldaps');
  });

  it('refuses saml + oidc before anything is written', async () => {
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({
          version: '8.5.1',
          name: 'sso2',
          preset: 'oidc+saml',
          wait: false,
          offline: true,
        }),
      ),
    ).rejects.toThrow('one SSO preset per workspace');
    expect(seen.yaml).toBeUndefined();
  });

  it.each([
    ['e2ee', { policy: 'enforced' }],
    ['e2ee+email', { 'e2ee.policy': 'enforced' }],
  ])(
    'refuses %s with policy=enforced on a Rocket.Chat before 8.8.0, before anything is written',
    async (preset, params) => {
      // 8.5.1 has no E2E_Force_Encryption_For_Private_Rooms: it would ignore the setting and
      // the workspace would enforce nothing while its record said it does.
      const { seen, createDocker } = capture();
      const refused = createDocker.createRepro(
        createReq({ version: '8.5.1', name: 'enf', preset, params, wait: false, offline: true }),
      );
      await expect(refused).rejects.toThrow(
        'e2ee policy=enforced needs Rocket.Chat 8.8.0 or later; 8.5.1 would not enforce it.',
      );
      // A usage error: exit 2, before the cluster, the edge or the record is touched.
      await expect(refused).rejects.toHaveProperty('exitCode', 2);
      expect(seen.meta).toBeUndefined();
    },
  );

  it.each([
    ['voice', {}],
    ['voice', { sip: 'on' }],
    ['voice+email', {}],
  ])(
    'refuses %s %j on a Rocket.Chat before 8.0.0, before anything is written',
    async (preset, params) => {
      // 7.x has the older Team Voice Calls: other settings, no Drachtio.
      const { seen, createDocker } = capture();
      const refused = createDocker.createRepro(
        createReq({
          version: '7.13.0',
          name: 'old-voice',
          preset,
          params,
          wait: false,
          offline: true,
        }),
      );
      await expect(refused).rejects.toThrow(
        'the voice preset needs Rocket.Chat 8.0.0 or later; 7.13.0 has the older Team Voice Calls.',
      );
      await expect(refused).rejects.toHaveProperty('exitCode', 2);
      expect(seen.meta).toBeUndefined();
    },
  );

  it('generates a password for a workspace bound wide', async () => {
    // `--bind 0.0.0.0` removes the same premise by the other mechanism, and it must not
    // be the path left handing `admin123` to the LAN.
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({ version: '8.5.1', name: 'wide', wait: false, bind: '0.0.0.0', offline: true }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    expect(seen.meta?.adminPassword).not.toBe('');
    expect(seen.yaml).not.toContain('admin123');
  });

  /** `up --force -n <name>` as `actor` over a workspace that exists: the record it writes. */
  async function forcedAs(actor: string, name: string): Promise<string> {
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../../src/core/runner/engine'),
      down: async () => 0,
    }));
    const { seen, createDocker } = capture();
    await expect(
      createDocker.createRepro(
        createReq({ version: '8.5.1', name, actor, force: true, wait: false, offline: true }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    return `${String(seen.meta?.name)} by ${String(seen.meta?.extra.created_by)}`;
  }

  it('rebuilds the workspace a member was handed, and gives anyone else their own', async () => {
    // `HOUSTON_USER=mem houston up -n g2 --force` on g2, handed to mem, said "workspace
    // name: mem-g2" and made a second workspace; g2 was untouched. Every other command
    // resolves the exact name first. Somebody else's name still gets the actor's prefix.
    await writeRecord(
      'g2',
      metadata({ name: 'g2', project: 'houston-g2', extra: { created_by: 'root', owner: 'mem' } }),
    );
    expect([await forcedAs('mem', 'g2'), await forcedAs('mem2', 'g2')]).toEqual([
      'g2 by root',
      'mem2-g2 by mem2',
    ]);
  });

  it('rebuilds the workspace an admin names, and keeps who made it', async () => {
    // `HOUSTON_USER=kadmin houston up -n k1` with k1 there made a new `kadmin-k1`. Acting on
    // k1, the rebuilt record must not make the admin its creator, and so its owner.
    await users.add('kadmin', 'a-good-enough-password', 'admin');
    await writeRecord(
      'k1',
      metadata({ name: 'k1', project: 'houston-k1', extra: { created_by: 'kmem' } }),
    );
    expect(await forcedAs('kadmin', 'k1')).toBe('k1 by kmem');
  });

  it('asks again under the lock, so a workspace handed away while the request waited is refused', async () => {
    // `claimTypedName` looks before the workspace lock, and a plain `--force` asks nobody:
    // a member's create queued behind the lock, then handed to alice, rebuilt alice's
    // workspace with the member's request.
    await writeRecord(
      'g3',
      metadata({
        name: 'g3',
        project: 'houston-g3',
        extra: { created_by: 'root', owner: 'alice' },
      }),
    );
    const { seen, createDocker } = capture();
    const context = require('../../../src/lib/context') as typeof ContextNS;
    const req = createReq({
      version: '8.5.1',
      name: 'g3',
      actor: 'mem',
      exactName: true,
      force: true,
      wait: false,
      offline: true,
    });
    await expect(
      context.runWithContext({ actor: 'mem' }, () => createDocker.createReproLocked(req)),
    ).rejects.toThrow('g3 belongs to alice');
    expect(seen.meta).toBeUndefined();
  });

  it('refuses a member whose own prefix now names a workspace handed to someone else', async () => {
    // Not an exact name: `x` derives `bob-x`, which bob made and handed to alice. Only an
    // exact name was asked again, so bob's create started, pinned or rebuilt alice's.
    await writeRecord(
      'bob-x',
      metadata({
        name: 'bob-x',
        project: 'houston-bob-x',
        extra: { created_by: 'bob', owner: 'alice' },
      }),
    );
    const { seen, createDocker } = capture();
    const context = require('../../../src/lib/context') as typeof ContextNS;
    const req = createReq({
      version: '8.5.1',
      name: 'x',
      actor: 'bob',
      wait: false,
      offline: true,
    });
    await expect(
      context.runWithContext({ actor: 'bob' }, () => createDocker.createReproLocked(req)),
    ).rejects.toThrow('bob-x belongs to alice');
    expect(seen.meta).toBeUndefined();
  });

  it('asks about the name multi-instance settles on, not the one before it', async () => {
    // The owner was asked about `bob-rc8-5-1`, then `--deployment multi-instance` renamed it
    // `bob-rc8-5-1-multi-instance`, which had been handed to alice -- and bob's --force
    // rebuilt it.
    await writeRecord(
      'bob-rc8-5-1-multi-instance',
      metadata({
        name: 'bob-rc8-5-1-multi-instance',
        project: 'houston-bob-rc8-5-1-multi-instance',
        extra: { created_by: 'bob', owner: 'alice' },
      }),
    );
    const { seen, createDocker } = capture();
    const context = require('../../../src/lib/context') as typeof ContextNS;
    const req = createReq({
      version: '8.5.1',
      deployment: 'multi-instance',
      actor: 'bob',
      force: true,
      wait: false,
      offline: true,
    });
    await expect(
      context.runWithContext({ actor: 'bob' }, () => createDocker.createRepro(req)),
    ).rejects.toThrow('bob-rc8-5-1-multi-instance belongs to alice');
    expect(seen.meta).toBeUndefined();
  });

  it('holds the name multi-instance settles on while it builds it', async () => {
    // Only the name before the rename was locked, so a `down` or a second create of
    // `rc8-5-1-multi-instance` ran straight through this one.
    const { seen, createDocker } = capture();
    const { reproLock } = require('../../../src/core/runner/locks') as {
      reproLock: <T>(name: string, body: () => Promise<T>) => Promise<T>;
    };
    const gate = { release: (): void => undefined, taken: false };
    const held = reproLock(
      'rc8-5-1-multi-instance',
      () =>
        new Promise<void>((done) => {
          gate.release = done;
          gate.taken = true;
        }),
    );
    for (let wait = 0; wait < 200 && !gate.taken; wait += 1) {
      await new Promise((done) => setTimeout(done, 10));
    }
    const creating = createDocker
      .createRepro(
        createReq({ version: '8.5.1', deployment: 'multi-instance', wait: false, offline: true }),
      )
      .then(
        () => '',
        (error: Error) => error.message,
      );
    await new Promise((done) => setTimeout(done, 500));
    expect(seen.meta).toBeUndefined();
    gate.release();
    await held;
    expect(await creating).toBe('stopped at the write seam');
    expect(seen.meta?.name).toBe('rc8-5-1-multi-instance');
  });
});

describe('rebuilding an existing workspace', () => {
  it('keeps a handed-over owner when the record is rebuilt', async () => {
    // `up --force` rebuilt the record from scratch: whoever ran it became the owner of a
    // workspace that had been handed to someone else.
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const history = [{ from: 'mem2', to: 'mem', by: 'admin', at: '2026-10-12T13:00:00Z' }];
    await writeRecord(
      'handed',
      metadata({
        name: 'handed',
        project: 'houston-handed',
        extra: { created_by: 'mem2', owner: 'mem', owner_history: history },
      }),
    );
    const plan = createDocker.createPlan({
      req: createReq({ version: '8.5.1', name: 'handed', force: true }),
      emit: nullEmit,
      reproName: 'handed',
      resolved: versions.resolve('8.5.1', { offline: true }),
      pre: presets.load('default', {}),
      root: 'http://localhost:3331',
      hostPort: 3331,
      bindHost: '127.0.0.1',
    });
    await createDocker.buildDocument(plan);
    createDocker.buildRecord(plan);
    expect(plan.meta?.extra).toMatchObject({ owner: 'mem', owner_history: history });
  });

  it('keeps when it was made through a --force rebuild, and not through --fresh', async () => {
    // A rebuild that keeps the data was stamped as a new workspace, so a backup taken before
    // it read as one from an earlier workspace and `restore` by its own name was refused.
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const born = '2026-10-01T09:00:00+00:00';
    const rebuilt = async (fresh: boolean): Promise<string> => {
      await writeRecord(
        'born',
        metadata({ name: 'born', project: 'houston-born', createdAt: born }),
      );
      const plan = createDocker.createPlan({
        req: createReq({ version: '8.5.1', name: 'born', force: true, fresh }),
        emit: nullEmit,
        reproName: 'born',
        resolved: versions.resolve('8.5.1', { offline: true }),
        pre: presets.load('default', {}),
        root: 'http://localhost:3331',
        hostPort: 3331,
        bindHost: '127.0.0.1',
      });
      await createDocker.buildDocument(plan);
      createDocker.buildRecord(plan);
      return String(plan.meta?.createdAt);
    };
    expect(await rebuilt(false)).toBe(born);
    expect(await rebuilt(true)).not.toBe(born);
  });

  it('keeps it pinned when the record is rebuilt', async () => {
    // `up --force` without --pin wrote `pinned: false`, and the next `prune` would delete it.
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    await writeRecord(
      'pinned',
      metadata({ name: 'pinned', project: 'houston-pinned', pinned: true }),
    );
    const plan = createDocker.createPlan({
      req: createReq({ version: '8.5.1', name: 'pinned', force: true }),
      emit: nullEmit,
      reproName: 'pinned',
      resolved: versions.resolve('8.5.1', { offline: true }),
      pre: presets.load('default', {}),
      root: 'http://localhost:3331',
      hostPort: 3331,
      bindHost: '127.0.0.1',
    });
    await createDocker.buildDocument(plan);
    createDocker.buildRecord(plan);
    expect(plan.meta?.pinned).toBe(true);
  });

  it('keeps its monitoring without --monitor, as a Kubernetes re-up does', async () => {
    // `up --force` dropped Prometheus and Grafana without a word: `info` went from
    // monitoring true to null and the Grafana link with it.
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    await writeRecord(
      'watched',
      metadata({ name: 'watched', project: 'houston-watched', extra: { monitoring: true } }),
    );
    const plan = createPlan({
      req: createReq({ version: '8.5.1', name: 'watched', force: true }),
      emit: nullEmit,
    });
    await createDocker.resolveAxesStep(plan);
    expect(plan.req.monitor).toBe(true);
  });

  describe('its --root-url', () => {
    // `up --force` without --root-url wrote ROOT_URL=http://localhost:<port> over a proxied
    // workspace's public address, without a word, and left Rocket.Chat's Site_Url on the old one.
    const createDocker = (): typeof CreateDockerNS =>
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const rebuild = async (
      extra: Record<string, unknown>,
      req: Partial<Parameters<typeof createReq>[0]> = {},
      publicUrl = '',
    ): Promise<string> => {
      await writeRecord(
        'proxied',
        metadata({ name: 'proxied', project: 'houston-proxied', publicUrl, extra }),
      );
      const plan = createPlan({
        req: createReq({ version: '8.5.1', name: 'proxied', force: true, ...req }),
        emit: nullEmit,
      });
      await createDocker().resolveAxesStep(plan);
      return plan.req.rootUrl;
    };

    it('is kept when the rebuild leaves it out', async () => {
      expect(await rebuild({ advertised_url: 'https://rc.example.test' })).toBe(
        'https://rc.example.test',
      );
    });

    it('gives way to one typed on the rebuild', async () => {
      expect(
        await rebuild(
          { advertised_url: 'https://rc.example.test' },
          { rootUrl: 'https://other.example.test' },
        ),
      ).toBe('https://other.example.test');
    });

    it('is not carried from a workspace houston served over HTTPS', async () => {
      // There the advertised URL IS the TLS name: carried into --root-url it would outrank
      // whatever TLS this rebuild resolves.
      const tls = 'https://proxied.houston.localhost';
      expect(await rebuild({ advertised_url: tls }, {}, tls)).toBe('');
    });

    it('is not carried into a rebuild that asks for HTTPS', async () => {
      expect(await rebuild({ advertised_url: 'https://rc.example.test' }, { https: true })).toBe(
        '',
      );
      expect(
        await rebuild({ advertised_url: 'https://rc.example.test' }, { domain: 'rc.example.com' }),
      ).toBe('');
      // `--email` asks for TLS too (on a recorded name: `resolveTls`), and the carried URL
      // then outranked it.
      expect(
        await rebuild({ advertised_url: 'https://rc.example.test' }, { acmeEmail: 'a@b.test' }),
      ).toBe('');
    });
  });
  it('Grafana public URL regression: passes the TLS URL into the compose document and notes', async () => {
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const plan = createDocker.createPlan({
      req: createReq({ version: '8.5.1', name: 'grafana', monitor: true }),
      emit: nullEmit,
    });
    plan.reproName = 'grafana';
    plan.resolved = versions.resolve('8.5.1', { offline: true });
    plan.pre = presets.load('default', {});
    plan.hostPort = 3310;
    plan.root = 'http://localhost:3310';
    plan.public = 'https://h';
    plan.bindHost = '127.0.0.1';
    plan.tlsspec = tlsSpec({ mode: 'local', host: 'h' });
    await createDocker.buildDocument(plan);
    createDocker.buildRecord(plan);
    createDocker.attachMonitoring(plan);
    expect(plan.doc?.services.grafana?.environment).toHaveProperty(
      'GF_SERVER_ROOT_URL',
      'https://h/grafana/',
    );
    expect(plan.meta?.extra.notes).toEqual(
      expect.arrayContaining([
        'Grafana:    https://h/grafana  (admin/admin; anonymous view enabled)',
      ]),
    );
  });
  it('carries its env overrides forward, and this run’s win', async () => {
    // `up --force` rebuilds compose from the spec, so overrides must live in the record.
    // Verified live: editing only the generated compose file worked until the next
    // `up --force`, which silently dropped the change.
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    await writeRecord(
      'e',
      metadata({ name: 'e', project: 'houston-e', extra: { env: { KEEP_ME: 'yes', GONE: null } } }),
    );
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const plan = createPlan({
      req: createReq({ version: '8.5.1', name: 'e', env: { NEW: '1', KEEP_ME: 'this run' } }),
      emit: nullEmit,
    });
    plan.reproName = 'e';
    plan.resolved = versions.resolve('8.5.1', { offline: true });
    plan.pre = presets.load('default', {});
    plan.hostPort = 3000;
    plan.root = 'http://localhost:3000';
    plan.bindHost = '127.0.0.1';
    await createDocker.buildDocument(plan);
    expect(plan.envOverrides).toEqual({ KEEP_ME: 'this run', GONE: null, NEW: '1' });
    createDocker.buildRecord(plan);
    expect(plan.meta?.extra.env).toEqual({ KEEP_ME: 'this run', GONE: null, NEW: '1' });
  });

  it('keeps the admin password its database holds, and mints one only for --fresh', async () => {
    // Rocket.Chat reads ADMIN_PASS only when it fills an empty database, so a new password
    // on a rebuild was recorded and accepted by nothing: every houston login after
    // `up --force` on an HTTPS workspace answered 401, seen live.
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    await writeRecord(
      'pw',
      metadata({ name: 'pw', project: 'houston-pw', adminPassword: 'Kept-Pass-1' }),
    );
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const passwordFor = async (fresh: boolean) => {
      const plan = createPlan({
        req: createReq({ version: '8.5.1', name: 'pw', force: true, fresh }),
        emit: nullEmit,
      });
      plan.reproName = 'pw';
      plan.resolved = versions.resolve('8.5.1', { offline: true });
      plan.pre = presets.load('default', {});
      plan.hostPort = 3000;
      plan.root = 'http://localhost:3000';
      plan.bindHost = '0.0.0.0';
      await createDocker.buildDocument(plan);
      return plan.adminPassword;
    };
    expect(await passwordFor(false)).toBe('Kept-Pass-1');
    expect(await passwordFor(true)).not.toBe('Kept-Pass-1');
  });

  it('says so when a workspace made on loopback comes back public with the shared password', async () => {
    // Its database holds admin123 and keeps it; a generated one would be printed and
    // refused, so the shared one is kept, and said, now that it is reachable.
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    await writeRecord('lo', metadata({ name: 'lo', project: 'houston-lo', adminPassword: '' }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const said: string[] = [];
    const plan = createPlan({
      req: createReq({ version: '8.5.1', name: 'lo', force: true }),
      emit: (event) => said.push(event.message),
    });
    plan.reproName = 'lo';
    plan.resolved = versions.resolve('8.5.1', { offline: true });
    plan.pre = presets.load('default', {});
    plan.hostPort = 3000;
    plan.root = 'http://localhost:3000';
    plan.bindHost = '0.0.0.0';
    await createDocker.buildDocument(plan);
    expect(plan.adminPassword).toBe('');
    expect(said.join('\n')).toContain('reachable from other machines and keeps the admin password');
  });
});

describe('what a create says and generates before the build', () => {
  const STATED = [
    '../../../src/core/lifecycle/sizing',
    '../../../src/core/lifecycle/ports',
    '../../../src/core/lifecycle/tlsplan',
    '../../../src/core/lifecycle/preconditions',
    '../../../src/lib/versions',
    '../../../src/core/runner/record',
  ];
  afterEach(() => {
    jest.doMock('../../../src/core/runner/host', () =>
      (require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    for (const id of STATED) jest.dontMock(id);
    jest.resetModules();
  });

  /** The Compose create with the engine, the pairing and the HTTPS plan stated. */
  function stated({
    source = 'releases.rocket.chat',
    domain = '',
  }: { source?: string; domain?: string } = {}): {
    seen: { meta?: Metadata };
    createDocker: typeof CreateDockerNS;
  } {
    jest.resetModules();
    const seen: { meta?: Metadata } = {};
    jest.doMock('../../../src/core/runner/host', () => ({
      ...(require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
      dockerKernelVersion: async () => '6.1.0',
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/sizing', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/sizing'),
      checkCapacity: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      pickHostPort: async () => 3001,
      claimSidePorts: preferredSidePorts,
    }));
    jest.doMock('../../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/tlsplan'),
      resolveTls: async () =>
        domain
          ? tlsSpec({ mode: MODE_ACME, host: domain, port: 443, acmeEmail: 'ops@example.com' })
          : null,
    }));
    jest.doMock('../../../src/lib/versions', () => {
      const actual = jest.requireActual<typeof VersionsNS>('../../../src/lib/versions');
      return {
        ...actual,
        resolve: (version: string): Resolved => ({
          ...actual.resolve('8.5.1', { offline: true }),
          rcVersion: version,
          source,
        }),
      };
    });
    jest.doMock('../../../src/core/runner/record', () => ({
      ...jest.requireActual('../../../src/core/runner/record'),
      write: async (_name: string, _yaml: string, meta: Metadata) => {
        seen.meta = meta;
        throw new Error('stopped at the write seam');
      },
    }));
    return {
      seen,
      createDocker: require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS,
    };
  }

  it('names a version the index has never heard of before building anything', async () => {
    // `up --version 99.99.99` built the whole compose document and failed ~90s later at
    // docker's own "not found". A warning rather than a refusal: the shipped map can
    // legitimately pair a version the live index has not indexed yet.
    const said: string[] = [];
    let { createDocker } = stated({ source: 'map (no such release)' });
    await createDocker
      .createRepro(
        createReq({ version: '99.99.99', name: 'bogus', wait: false, offline: true }),
        (event) => said.push(event.message),
      )
      .catch(() => undefined);
    expect(said.some((message) => message.includes('has no 99.99.99'))).toBe(true);
    expect(said.some((message) => message.includes('shipped map'))).toBe(true);

    // A version the index DOES know is not warned about.
    said.length = 0;
    ({ createDocker } = stated({ source: 'releases.rocket.chat' }));
    await createDocker
      .createRepro(
        createReq({ version: '8.5.1', name: 'fine', wait: false, offline: true }),
        (event) => said.push(event.message),
      )
      .catch(() => undefined);
    expect(said.filter((message) => message.includes('has no'))).toEqual([]);
  });

  it('gives two public workspaces two different passwords', async () => {
    // Per WORKSPACE: one password for every public workspace on the box would make a
    // single leak the whole box.
    const made: string[] = [];
    for (const [index, host] of ['c1.example.com', 'c2.example.com'].entries()) {
      const { seen, createDocker } = stated({ domain: host });
      await expect(
        createDocker.createRepro(
          createReq({
            version: '8.5.1',
            name: `multi${String(index)}`,
            wait: false,
            domain: host,
            acmeEmail: 'ops@example.com',
            offline: true,
          }),
        ),
      ).rejects.toThrow('stopped at the write seam');
      made.push(seen.meta?.adminPassword ?? '');
    }
    expect(made[0]).not.toBe('');
    expect(made[1]).not.toBe('');
    expect(made[0]).not.toBe(made[1]);
  });
});

describe('the event a create announces itself with', () => {
  afterEach(() => {
    for (const id of ['../../../src/core/runner/record', '../../../src/core/lifecycle/ready'])
      jest.dontMock(id);
    jest.resetModules();
  });

  it('carries its name nested one level, as earlier releases did', async () => {
    // Earlier releases handed the event's data ONE keyword named `data`, so their detail is
    // {"data": {"name": ...}} on the NDJSON stream and in houston.log; this build's was flat.
    // What earlier releases emitted for the same plan, stopped at the same compose call, recorded.
    const recorded = [
      {
        message: "creating 'alpha' - RC 8.5.1, Mongo 8.0 (official), preset default",
        phase: 'create',
        data: { data: { name: 'alpha' } },
      },
    ];

    jest.resetModules();
    jest.doMock('../../../src/core/runner/record', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/record'),
      write: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual<object>('../../../src/core/lifecycle/ready'),
      upCompose: async () => Promise.reject(new Error('stopped at compose')),
    }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const events: unknown[] = [];
    const plan = createDocker.createPlan({
      req: createReq({ version: '8.5.1', name: 'alpha', noPull: true }),
      emit: (event) =>
        events.push({ message: event.message, phase: event.phase, data: event.data }),
    });
    plan.reproName = 'alpha';
    plan.doc = { name: 'houston-alpha', services: {}, volumes: {} };
    plan.resolved = { rcVersion: '8.5.1', mongoTag: '8.0', mongoFlavor: 'official' } as Resolved;
    plan.pre = { name: 'default' } as Preset;
    await expect(createDocker.startTheWorkspace(plan)).rejects.toThrow('stopped at compose');
    expect(events).toEqual([
      {
        message: "creating 'alpha' - RC 8.5.1, Mongo 8.0 (official), preset default",
        phase: 'create',
        data: { data: { name: 'alpha' } },
      },
    ]);
    expect(events).toEqual(recorded);
  });

  it('names the presets asked for, not the deployment Compose builds with them', async () => {
    // `up --deployment multi-instance -p saml` said "preset multi-instance+saml", while the
    // panel's Preset row said `saml`: multi-instance is the deployment, not a preset.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/record', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/record'),
      write: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual<object>('../../../src/core/lifecycle/ready'),
      upCompose: async () => Promise.reject(new Error('stopped at compose')),
    }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const said: string[] = [];
    const plan = createDocker.createPlan({
      req: createReq({ version: '8.5.1', name: 'd2', noPull: true }),
      emit: (event) => said.push(event.message),
    });
    plan.reproName = 'd2';
    plan.doc = { name: 'houston-d2', services: {}, volumes: {} };
    plan.resolved = { rcVersion: '8.8.0', mongoTag: '8.0', mongoFlavor: 'official' } as Resolved;
    plan.pre = { name: 'multi-instance+saml' } as Preset;
    await expect(createDocker.startTheWorkspace(plan)).rejects.toThrow('stopped at compose');
    expect(said).toContain("creating 'd2' - RC 8.8.0, Mongo 8.0 (official), preset saml");
  });
});

describe('a rebuild that names no preset', () => {
  async function axesFor(name: string, recorded: Partial<Metadata>, runtime = '') {
    await writeRecord(name, metadata({ name, project: `houston-${name}`, ...recorded }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const said: string[] = [];
    const plan = createPlan({
      req: createReq({ version: '8.5.1', name, preset: '', force: true, runtime }),
      emit: (event) => said.push(event.message),
    });
    await createDocker.resolveAxesStep(plan);
    return { req: plan.req, said };
  }

  it("keeps a composed workspace's presets and their params, and says so", async () => {
    const { req, said } = await axesFor('keep-combo', {
      preset: 'email+ldap',
      extra: {
        runtime: 'docker',
        presets: ['email', 'ldap'],
        preset_params: { ldap: { users: '7' } },
      },
    });
    expect([req.preset, req.params]).toEqual(['email+ldap', { 'ldap.users': '7' }]);
    expect(said).toContain("'keep-combo' is a email+ldap workspace — keeping those presets");
  });

  it("keeps a one-preset workspace's preset and params, rather than dropping its data", async () => {
    // Rebuilt vanilla, an s3_minio workspace's MinIO volume -- every upload -- was then removed
    // as left over by the previous preset: `up --force` with no --preset deleted the uploads.
    const { req, said } = await axesFor('keep-one', {
      preset: 's3_minio',
      extra: { runtime: 'docker', params: { bucket: 'kept' } },
    });
    expect([req.preset, req.params]).toEqual(['s3_minio', { bucket: 'kept' }]);
    expect(said).toContain("'keep-one' is a s3_minio workspace — keeping those presets");
  });

  it('brings a Kubernetes monolith back as a monolith, on its own cluster', async () => {
    // An empty --deployment resolved to Kubernetes' default, so `up --name X` after `down`
    // rebuilt a monolith as microservices, seen live on a k3s lane.
    const { req } = await axesFor('keep-shape', {
      preset: 'email',
      extra: { runtime: 'kubernetes', deployment: 'monolith', context: 'lab-cluster' },
    });
    expect([req.runtime, req.deployment, req.context]).toEqual([
      'kubernetes',
      'monolith',
      'lab-cluster',
    ]);
  });

  it('keeps a MongoDB the operator runs, rather than applying its own over it', async () => {
    // `up --name X` after `down` on an --mongo-operator workspace applied houston's own
    // MongoDB over the operator's and failed ("kubectl apply failed"), seen live on k3s.
    const { req } = await axesFor('keep-operator', {
      preset: 'default',
      extra: { runtime: 'kubernetes', deployment: 'monolith', mongo_managed_by: 'operator' },
    });
    expect(req.mongoOperator).toBe(true);
  });

  it('keeps the instance count with the shape, as the GUI’s Start does', async () => {
    // The count is read from the record with the deployment; without it a three-instance
    // workspace came back with the shape's default.
    const { req } = await axesFor('keep-count', {
      preset: 'multi-instance',
      extra: { runtime: 'docker', deployment: 'multi-instance', instances: 3 },
    });
    expect([req.deployment, req.replicas]).toEqual(['multi-instance', 3]);
  });

  it('carries nothing onto a runtime the workspace was not recorded on', async () => {
    // A microservices shape and a cluster mean nothing to Compose: carried, they turned
    // `--runtime docker` into a refusal naming a --deployment nobody typed.
    const { req } = await axesFor(
      'other-runtime',
      {
        preset: 'email',
        extra: { runtime: 'kubernetes', deployment: 'microservices', context: 'c1' },
      },
      'docker',
    );
    expect([req.deployment, req.context]).toEqual(['monolith', '']);
  });

  it('says it goes to the recorded cluster, not the box default, when it brings one back', async () => {
    // The destination was announced before the recorded cluster was carried, so a box whose
    // saved default is an EKS cluster warned of an hourly bill for a kind workspace.
    config.updateConfig((cfg) => {
      cfg[config.KUBE_CONTEXT_KEY] = 'arn:aws:eks:us-east-1:123456789012:cluster/demo';
    });
    try {
      await writeRecord(
        'back',
        metadata({
          name: 'back',
          project: 'houston-back',
          extra: { runtime: 'kubernetes', deployment: 'monolith', context: 'kind-houston-local' },
        }),
      );
      const createDocker =
        require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
      const said: string[] = [];
      await createDocker
        .createRepro(
          createReq({ version: '8.5.1', name: 'back', runtime: 'kubernetes', offline: true }),
          (event) => said.push(event.message),
        )
        .catch(() => undefined);
      expect(said.join('\n')).not.toContain('costs money by the hour');
    } finally {
      config.updateConfig((cfg) => {
        delete cfg[config.KUBE_CONTEXT_KEY];
      });
    }
  });
});

describe('the edge a --domain create starts', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it.each([
    [true, 1],
    [false, 0],
  ])(
    "asks a running Let's Encrypt edge to change only when its challenge is stale (%s)",
    async (stale, calls) => {
      // Measured behind a tunnel: `config set acme.challenge http`, then `up --domain` beside a
      // running edge, and the edge kept TLS-ALPN: this gate never called `ensureRunning`.
      jest.resetModules();
      const ensureRunning = jest.fn(async () => ({ ok: true, why: '' }));
      jest.doMock('../../../src/core/edge/engine', () => ({
        ...jest.requireActual('../../../src/core/edge/engine'),
        running: async () => true,
      }));
      jest.doMock('../../../src/core/edge/acme', () => ({
        ...jest.requireActual('../../../src/core/edge/acme'),
        hasAcme: () => true,
      }));
      jest.doMock('../../../src/core/edge/runtime', () => ({
        ...jest.requireActual('../../../src/core/edge/runtime'),
        ensureRunning,
        challengeStale: () => stale,
      }));
      const createDocker =
        require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
      const plan = createPlan({ req: createReq({ version: '8.5.1' }), emit: nullEmit });
      plan.tlsspec = tlsSpec({
        mode: MODE_ACME,
        host: 'rc.example.test',
        port: 443,
        acmeEmail: 'ops@example.com',
      });
      await createDocker.startTheEdge(plan, false);
      expect(ensureRunning).toHaveBeenCalledTimes(calls);
    },
  );
});

describe('a create whose name a workspace on the other runtime holds', () => {
  it('refuses a Kubernetes create over a Docker workspace, and leaves its record alone', async () => {
    // Seen in production: 8.5.1 on Docker, then 8.5.1 on Kubernetes from the GUI, derived
    // the same name, took it for "bring it back up" and rewrote the Docker workspace's
    // record as a Kubernetes one -- its containers still running and nothing pointing at them.
    const name = 'lovekesh-rc8-5-1';
    await writeRecord(
      name,
      metadata({ name, project: `houston-${name}`, extra: { runtime: 'docker' } }),
    );
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    await expect(
      createDocker.createRepro(
        createReq({ version: '8.5.1', actor: 'lovekesh', runtime: 'kubernetes', offline: true }),
      ),
    ).rejects.toThrow(`'${name}' is already a Docker Compose workspace`);
    expect((await readMeta(name)).extra.runtime).toBe('docker');
  });

  it('refuses a Docker create over a Kubernetes workspace', async () => {
    await writeRecord(
      'kube-held',
      metadata({
        name: 'kube-held',
        project: 'houston-kube-held',
        extra: { runtime: 'kubernetes' },
      }),
    );
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    await expect(
      createDocker.createRepro(
        createReq({ version: '8.5.1', name: 'kube-held', runtime: 'docker', offline: true }),
      ),
    ).rejects.toThrow("'kube-held' is already a Kubernetes workspace");
  });
});

describe('a rebuild across MongoDB image families', () => {
  afterEach(() => {
    for (const id of [
      '../../../src/core/runner/engine',
      '../../../src/core/lifecycle/ports',
      '../../../src/core/lifecycle/preconditions',
      '../../../src/core/lifecycle/tlsplan',
    ]) {
      jest.dontMock(id);
    }
    jest.resetModules();
  });

  /** `fam` at RC 7.6.1 on Bitnami MongoDB 7.0, and what `up` would tear down or start. */
  async function existing(): Promise<{ torn: unknown[]; createDocker: typeof CreateDockerNS }> {
    await writeRecord(
      'fam',
      metadata({
        name: 'fam',
        project: 'houston-fam',
        rcVersion: '7.6.1',
        mongoTag: '7.0',
        mongoFlavor: 'bitnami-legacy',
        extra: { runtime: 'docker' },
      }),
    );
    fs.writeFileSync(
      path.join(config.home(), 'repros', 'fam', 'docker-compose.yml'),
      'services: {}\n',
    );
    const torn: unknown[] = [];
    jest.resetModules();
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/engine'),
      down: async (...args: unknown[]) => {
        torn.push(args);
        return 0;
      },
      up: async () => 0,
    }));
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      claimSidePorts: preferredSidePorts,
      pickHostPort: async () => 3300,
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/tlsplan'),
      resolveTls: async () => null,
    }));
    return {
      torn,
      createDocker: require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS,
    };
  }

  it('refuses up --force onto the other family before anything is torn down', async () => {
    // Bitnami keeps its data in /bitnami/mongodb and the official image in /data/db, on the
    // same `mongodb_data` volume: the rebuild booted Rocket.Chat 8 on an empty database.
    const { torn, createDocker } = await existing();
    const refused = createDocker.createRepro(
      createReq({ version: '8.5.1', name: 'fam', force: true, offline: true }),
    );
    await expect(refused).rejects.toThrow(/empty database/u);
    await expect(
      createDocker.createRepro(
        createReq({ version: '8.5.1', name: 'fam', force: true, offline: true }),
      ),
    ).rejects.toThrow(/houston backup --name fam/u);
    expect(torn).toEqual([]);
  });

  it('lets --fresh and a same-family rebuild through', async () => {
    const { createDocker } = await existing();
    const plan = (version: string, fresh: boolean) => {
      const made = createPlan({
        req: createReq({ version, name: 'fam', force: true, fresh, offline: true }),
        emit: nullEmit,
      });
      made.reproName = 'fam';
      made.resolved = (require('../../../src/lib/versions') as typeof VersionsNS).resolve(version, {
        offline: true,
      });
      return made;
    };
    await expect(
      createDocker.refuseMongoFamilyChange(plan('8.5.1', true)),
    ).resolves.toBeUndefined();
    await expect(
      createDocker.refuseMongoFamilyChange(plan('7.6.2', false)),
    ).resolves.toBeUndefined();
  });
});

describe('an Enterprise licence', () => {
  const LICENSE = 'RCV3_c2VjcmV0LWxpY2VuY2UtdGV4dA==';

  function planFor(name: string, license: string) {
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    const made = createPlan({
      req: createReq({ version: '8.5.1', name, license }),
      emit: nullEmit,
    });
    made.reproName = name;
    made.resolved = versions.resolve('8.5.1', { offline: true });
    made.pre = presets.load('default', {});
    made.hostPort = 3320;
    made.root = 'http://localhost:3320';
    made.bindHost = '127.0.0.1';
    return made;
  }

  it('reaches Rocket.Chat through its own 0600 file, and nowhere a reader looks', async () => {
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const plan = planFor('lic', LICENSE);
    await createDocker.buildDocument(plan);
    createDocker.buildRecord(plan);
    const doc = plan.doc as NonNullable<typeof plan.doc>;
    expect(doc.services.rocketchat?.env_file).toEqual(['.license.env']);
    expect(JSON.stringify(doc)).not.toContain(LICENSE);
    expect(JSON.stringify(plan.meta)).not.toContain(LICENSE);
    expect(plan.meta?.extra.licensed).toBe(true);
    fs.mkdirSync(path.join(config.home(), 'repros', 'lic'), { recursive: true });
    await createDocker.writeLicense(plan);
    const file = path.join(config.home(), 'repros', 'lic', '.license.env');
    expect(fs.readFileSync(file, 'utf8')).toBe(`ROCKETCHAT_LICENSE=${LICENSE}\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('is kept by a rebuild that does not name it again', async () => {
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    fs.mkdirSync(path.join(config.home(), 'repros', 'kept'), { recursive: true });
    fs.writeFileSync(path.join(config.home(), 'repros', 'kept', '.license.env'), 'x', {
      mode: 0o600,
    });
    const plan = planFor('kept', '');
    await createDocker.buildDocument(plan);
    expect(plan.doc?.services.rocketchat?.env_file).toEqual(['.license.env']);
    const bare = planFor('bare', '');
    await createDocker.buildDocument(bare);
    expect('env_file' in (bare.doc?.services.rocketchat ?? {})).toBe(false);
  });

  it('refuses text that is not a licence, without repeating it', async () => {
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const bad = 'line-one\nEVIL=1';
    const refused = createDocker.createRepro(
      createReq({ version: '8.5.1', name: 'badlic', license: bad, offline: true }),
    );
    await expect(refused).rejects.toThrow('does not hold a Rocket.Chat license');
    await expect(
      createDocker.createRepro(
        createReq({ version: '8.5.1', name: 'badlic', license: bad, offline: true }),
      ),
    ).rejects.not.toThrow(/EVIL/u);
  });
});

describe('a name the HTTPS edge could not reach', () => {
  // The TLS the create DECIDED, as `resolveTls` leaves it: `--https`, `--email` on a recorded
  // name and a record of an HTTPS workspace all come out as a spec, none of them as a flag here.
  const planOf = (name: string, preset: string, https = true, actor = '') => {
    const plan = createPlan({
      req: createReq({ version: '8.5.1', name, preset, actor }),
      emit: nullEmit,
    });
    plan.reproName = name;
    plan.pre = presets.load(preset, {});
    plan.tlsspec = https ? tlsSpec({ host: `${name}.houston.localhost` }) : null;
    return plan;
  };

  it('is refused before anything is made, naming the container and the room left', async () => {
    // Every container the edge routes to must be a 63-character DNS label: once 64, it does
    // not resolve and its path answers Bad Gateway (/phpldapadmin/ did, at 41 characters).
    // The longest is livechat's demo page, `houston-<name>-widget-site-1`.
    const createDocker = jest.requireActual<typeof CreateDockerNS>(
      '../../../src/core/lifecycle/create-docker',
    );
    await expect(
      createDocker.refuseNamesTheEdgeCannotReach(planOf('a'.repeat(42), 'livechat')),
    ).rejects.toThrow(
      /reaches widget-site as houston-a{42}-widget-site-1, 64 characters.*at most 41/u,
    );
    await expect(
      createDocker.refuseNamesTheEdgeCannotReach(planOf('a'.repeat(41), 'livechat')),
    ).resolves.toBeUndefined();
    // phpLDAPadmin is reached through its `ldap-ui` nginx now, shorter than Rocket.Chat.
    await expect(
      createDocker.refuseNamesTheEdgeCannotReach(planOf('a'.repeat(42), 'ldap')),
    ).resolves.toBeUndefined();
    // Rocket.Chat itself is the limit without a preset UI, and plain http routes nothing.
    await expect(
      createDocker.refuseNamesTheEdgeCannotReach(planOf('a'.repeat(43), 'default')),
    ).rejects.toThrow(/rocketchat/u);
    await expect(
      createDocker.refuseNamesTheEdgeCannotReach(planOf('a'.repeat(60), 'ldap', false)),
    ).resolves.toBeUndefined();
  });

  it('is refused however the create came to HTTPS: --email, or the record', async () => {
    // Keyed on the TLS `resolveTls` decided, not on --https/--domain: `--email` brings back a
    // recorded name, and an existing HTTPS workspace gets its TLS back from its record.
    jest.resetModules();
    jest.doMock('../../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ports'),
      claimSidePorts: preferredSidePorts,
      pickHostPort: async () => 3300,
    }));
    jest.doMock('../../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/preconditions'),
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/tlsplan'),
      resolveTls: async () => tlsSpec({ host: `${'a'.repeat(42)}.houston.localhost` }),
    }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const plan = createPlan({
      req: createReq({
        version: '8.5.1',
        name: 'a'.repeat(42),
        preset: 'livechat',
        acmeEmail: 'a@b.c',
      }),
      emit: nullEmit,
    });
    plan.cfg = config.loadConfig();
    plan.reproName = 'a'.repeat(42);
    plan.pre = presets.load('livechat', {});
    await expect(createDocker.claimPorts(plan)).rejects.toThrow(/widget-site-1, 64 characters/u);
    jest.resetModules();
  });

  it('says how long a name the person may type when houston adds their prefix', async () => {
    const createDocker = jest.requireActual<typeof CreateDockerNS>(
      '../../../src/core/lifecycle/create-docker',
    );
    // alice typed 36 characters; the workspace is `alice-<36>`, 42, its demo page's container 64.
    await expect(
      createDocker.refuseNamesTheEdgeCannotReach(
        planOf(`alice-${'a'.repeat(36)}`, 'livechat', true, 'alice'),
      ),
    ).rejects.toThrow(/at most 35 characters, as houston puts 'alice-' in front of it/u);
  });
});

describe('a combination given a bad input', () => {
  it('is a usage error, as the same input to one preset is', () => {
    // A member's own refusal escaped as "unhandled": exit 1 and a stack trace for a typo,
    // where the single preset says exit 2, VALIDATION_FAILED. Nothing is created either way.
    const { loadPreset } =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const { ValidationError } = require('../../../src/lib/errors') as {
      ValidationError: new (...args: unknown[]) => Error;
    };
    const refused = (preset: string, params: Record<string, unknown>): unknown => {
      try {
        loadPreset(
          createPlan({ req: createReq({ version: '8.5.1', preset, params }), emit: nullEmit }),
        );
      } catch (error) {
        return error instanceof ValidationError ? 'usage' : String(error);
      }
      return 'accepted';
    };
    expect([
      refused('email+ldap', { 'ldap.users': 'abc' }),
      refused('email+ldap', { 'ldap.tls': 'bogus' }),
      refused('email+ldap', { 'ldap.mfa': 'on' }),
      refused('ldap+nosuch', {}),
    ]).toEqual(['usage', 'usage', 'usage', 'usage']);
  });
});

describe('up --pin on a workspace that exists', () => {
  afterEach(() => {
    jest.dontMock('../../../src/core/runner/queries');
    jest.dontMock('../../../src/core/lifecycle/ready');
    jest.dontMock('../../../src/core/lifecycle/inspect');
    jest.resetModules();
  });

  it('pins it, so the next prune keeps it, and makes it the default', async () => {
    // It was not even among the flags said to be ignored: `pinned: false`, no warning, and
    // `prune --yes` then deleted the one workspace its owner had just asked to keep.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../../src/core/runner/queries'),
      rcState: async () => 'running',
    }));
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ready'),
      restoreRoute: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/inspect', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/inspect'),
      summary: async () => ({}),
    }));
    const record = require('../../../src/core/runner/record') as {
      writeRecord: typeof writeRecord;
      metadata: typeof metadata;
      readMeta: (name: string) => Promise<Metadata>;
    };
    await record.writeRecord('kept', record.metadata({ name: 'kept', project: 'houston-kept' }));
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    await createDocker.reuse(
      'kept',
      false,
      createReq({ version: '8.5.1', name: 'kept', pin: true }),
      nullEmit,
    );
    expect((await record.readMeta('kept')).pinned).toBe(true);
    const cfg = require('../../../src/lib/config') as typeof config;
    expect(cfg.loadConfig().default_repro).toBe('kept');
  });

  it('points a different version at upgrade, and keeps --force for a preset change', async () => {
    // "Use --force to rebuild it" for a version skipped the upgrade's backup and let a
    // downgrade through; `upgrade` backs up first and refuses one.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../../src/core/runner/queries'),
      rcState: async () => 'running',
    }));
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ready'),
      restoreRoute: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/inspect', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/inspect'),
      summary: async () => ({}),
    }));
    const record = require('../../../src/core/runner/record') as {
      writeRecord: typeof writeRecord;
      metadata: typeof metadata;
    };
    await record.writeRecord(
      'old',
      record.metadata({ name: 'old', project: 'houston-old', rcVersion: '8.5.1', preset: 'ldap' }),
    );
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const said = async (presetName: string): Promise<string> => {
      const lines: string[] = [];
      await createDocker.reuse(
        'old',
        false,
        createReq({ version: '8.6.1', name: 'old' }),
        (event) => void lines.push(event.message),
        { streamOutput: false, resolved: { rcVersion: '8.6.1' } as Resolved, presetName },
      );
      return lines.join('\n');
    };
    const version = await said('');
    expect(version).toContain('houston upgrade --name old --to 8.6.1 (it backs up first');
    expect(version).toContain('--fresh rebuilds it empty.');
    expect(version).not.toContain('--force');
    expect(await said('email')).toContain(
      "Use --force to rebuild it (a --force rebuild as 'email' removes the data 'ldap' kept).",
    );
  });

  it('says a different --port is ignored, rather than reusing the old one in silence', async () => {
    // `up --name existing --port 3200` came up on the recorded port and named no ignored flag,
    // so the caller opened 3200 and found nothing (live matrix 2026-10-30, F2).
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../../src/core/runner/queries'),
      rcState: async () => 'running',
    }));
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ready'),
      restoreRoute: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/inspect', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/inspect'),
      summary: async () => ({}),
    }));
    const record = require('../../../src/core/runner/record') as {
      writeRecord: typeof writeRecord;
      metadata: typeof metadata;
    };
    await record.writeRecord(
      'old',
      record.metadata({ name: 'old', project: 'houston-old', rcVersion: '8.5.1', hostPort: 3014 }),
    );
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const said = async (port: number): Promise<string> => {
      const lines: string[] = [];
      await createDocker.reuse(
        'old',
        false,
        createReq({ version: '8.5.1', name: 'old', port }),
        (event) => void lines.push(event.message),
      );
      return lines.join('\n');
    };
    expect(await said(3200)).toContain(
      "'old' already exists and is reused as-is, ignoring requested port 3200 (existing: 3014). " +
        'Use --force to rebuild it.',
    );
    expect(await said(3014)).not.toContain('ignoring requested');
    expect(await said(0)).not.toContain('ignoring requested');
  });

  it('names every other flag a reuse does not apply, and stays quiet for the same command', async () => {
    // --bind, --set, --root-url, --rc-image, --mongo, --https, --domain and --env each came back
    // as-is with nothing said (live 2026-10-30, after F2). Re-running the command that made it
    // must still say nothing.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../../src/core/runner/queries'),
      rcState: async () => 'running',
    }));
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ready'),
      restoreRoute: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/inspect', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/inspect'),
      summary: async () => ({}),
    }));
    const record = require('../../../src/core/runner/record') as {
      writeRecord: typeof writeRecord;
      metadata: typeof metadata;
    };
    // Recorded as the repository; the tag is the release.
    const image = 'registry.rocket.chat/rocketchat/rocket.chat';
    await record.writeRecord(
      'old',
      record.metadata({
        name: 'old',
        project: 'houston-old',
        rcVersion: '8.5.1',
        rcImage: image,
        mongoTag: '7.0',
        preset: 'ldap',
        hostPort: 3014,
        rootUrl: 'http://127.0.0.1:3014',
        extra: { bind_host: '127.0.0.1', params: { users: '5' }, env: { KEEP: '1' } },
      }),
    );
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const said = async (
      asked: Partial<CreateReq>,
      resolved: Partial<Resolved>,
    ): Promise<string> => {
      const lines: string[] = [];
      await createDocker.reuse(
        'old',
        false,
        createReq({ version: '8.5.1', name: 'old', ...asked }),
        (event) => void lines.push(event.message),
        {
          streamOutput: false,
          resolved: {
            rcVersion: '8.5.1',
            rcImage: image,
            mongoTag: '7.0',
            ...resolved,
          } as Resolved,
          presetName: 'ldap',
        },
      );
      return lines.join('\n');
    };
    const everything = await said(
      {
        bind: '0.0.0.0',
        rootUrl: 'http://box.example:3014',
        rcImage: 'example/rc:custom',
        mongo: '8.0',
        domain: 'old.example.com',
        params: { users: '9' },
        env: { KEEP: '1', SECRET_TOKEN: 'hunter2' },
      },
      { rcImage: 'example/rc:custom', mongoTag: '8.0' },
    );
    for (const part of [
      'bind address 0.0.0.0 (existing: 127.0.0.1)',
      'root URL http://box.example:3014 (existing: http://127.0.0.1:3014)',
      `image example/rc:custom (existing: ${image}:8.5.1)`,
      'MongoDB 8.0 (existing: 7.0)',
      'domain old.example.com (existing: none, plain HTTP)',
      '--set users=9',
      'environment SECRET_TOKEN (`houston env --set` changes it in place)',
      'Use --force to rebuild it.',
    ]) {
      expect({ part, said: everything.includes(part) }).toEqual({ part, said: true });
    }
    expect(everything).not.toContain('hunter2');
    expect(everything).not.toContain('KEEP');
    expect(await said({ https: true }, {})).toContain('HTTPS (existing: plain HTTP)');
    expect(
      await said(
        {
          port: 3014,
          bind: '127.0.0.1',
          rootUrl: 'http://127.0.0.1:3014/',
          rcImage: `${image}:8.5.1`,
          mongo: '7.0',
          params: { users: '5' },
          env: { KEEP: '1' },
        },
        { rcImage: `${image}:8.5.1` },
      ),
    ).not.toContain('ignoring requested');
  });

  it('keeps secrets out, reads a domain as TLS does, and names only what was typed', async () => {
    // Review 2026-10-31: a TURN password typed in --set was printed; `--domain
    // https://RC.Example.com/` re-run on rc.example.com warned; an IdP host houston derived
    // itself was reported as a --set; --replicas, --reg-token and --email went unmentioned;
    // and an unreadable recorded public URL failed a harmless reuse.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../../src/core/runner/queries'),
      rcState: async () => 'running',
    }));
    jest.doMock('../../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/ready'),
      restoreRoute: async () => undefined,
    }));
    jest.doMock('../../../src/core/lifecycle/inspect', () => ({
      ...jest.requireActual('../../../src/core/lifecycle/inspect'),
      summary: async () => ({}),
    }));
    const record = require('../../../src/core/runner/record') as {
      writeRecord: typeof writeRecord;
      metadata: typeof metadata;
    };
    const write = async (values: Partial<Metadata>): Promise<void> =>
      await record.writeRecord(
        'old',
        record.metadata({
          name: 'old',
          project: 'houston-old',
          rcVersion: '8.5.1',
          preset: 'voice',
          hostPort: 3014,
          ...values,
        }),
      );
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const said = async (
      asked: Partial<CreateReq>,
      typedParams: Record<string, unknown> = asked.params ?? {},
    ): Promise<string> => {
      const lines: string[] = [];
      await createDocker.reuse(
        'old',
        false,
        createReq({ version: '8.5.1', name: 'old', ...asked }),
        (event) => void lines.push(event.message),
        {
          streamOutput: false,
          resolved: { rcVersion: '8.5.1' } as Resolved,
          presetName: '',
          typedParams,
        },
      );
      return lines.join('\n');
    };
    await write({});
    const turn = await said({ params: { ice_servers: 'alice:s3cret@turn:turn.example.com:3478' } });
    expect(turn).toContain('ignoring requested --set ice_servers=');
    expect(turn).not.toContain('s3cret');
    const token = await said({ regToken: 'tok-123' });
    expect(token).toContain('the registration token');
    expect(token).not.toContain('tok-123');
    expect(await said({ acmeEmail: 'a@example.com' })).toContain('HTTPS (existing: plain HTTP)');
    // Derived by houston, not typed: nothing to say.
    expect(await said({ params: { idp_host: 'box' } }, {})).not.toContain('ignoring requested');
    await write({ publicUrl: 'https://rc.example.com' });
    expect(await said({ domain: 'https://RC.Example.com/' })).not.toContain('ignoring requested');
    expect(await said({ domain: 'other.example.com' })).toContain(
      'domain other.example.com (existing: rc.example.com)',
    );
    await write({ publicUrl: 'not a url' });
    await expect(said({})).resolves.not.toContain('ignoring requested');
    await write({ preset: 'multi-instance', extra: { instances: 3 } });
    expect(await said({ replicas: 4 })).toContain('--replicas 4 (existing: 3)');
    expect(await said({ replicas: 3 })).not.toContain('ignoring requested');
  });
});

describe('a hosts line on Podman', () => {
  afterEach(() => {
    // The guard put back, never taken away: `runner/host` is the suite's stated engine.
    jest.doMock('../../../src/core/runner/host', () =>
      (require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    jest.resetModules();
  });

  it('is warned about where the notes ask for one, and only on Podman', async () => {
    // Podman copies /etc/hosts into every container, so `127.0.0.1 minio` made minio-init and
    // Rocket.Chat resolve minio to themselves: no bucket, every upload ECONNREFUSED.
    for (const [kind, expected] of [
      ['podman', true],
      ['docker', false],
    ] as const) {
      jest.resetModules();
      jest.doMock('../../../src/core/runner/host', () => ({
        ...jest.requireActual('../../../src/core/runner/host'),
        engine: async () => ({ kind, version: '4.9.3', rootless: true }),
      }));
      const createDocker =
        require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
      const said: string[] = [];
      const plan = createDocker.createPlan({
        req: createReq({ version: '8.5.1', preset: 's3_minio' }),
        emit: (event) => said.push(event.message),
      });
      plan.pre = presets.load('s3_minio', { presigned: 'true' });
      await createDocker.warnAboutHostsOnPodman(plan);
      expect({ kind, warned: said.some((line) => line.includes('Podman copies')) }).toEqual({
        kind,
        warned: expected,
      });
    }
  });
});

describe('a seed profile that does not exist', () => {
  it('is refused before anything is resolved or made', async () => {
    // The planner refused `--seed-profile huge` only after the workspace was pulled, built
    // and started: exit 1 over a running workspace, for a typo.
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const { ValidationError } = require('../../../src/lib/errors') as {
      ValidationError: new (...args: unknown[]) => Error;
    };
    const refusal = createDocker.createRepro(
      createReq({ version: '8.5.1', seed: true, seedProfile: 'huge', offline: true }),
    );
    await expect(refusal).rejects.toBeInstanceOf(ValidationError);
    await expect(
      createDocker.createRepro(
        createReq({ version: '8.5.1', seed: true, seedProfile: 'huge', offline: true }),
      ),
    ).rejects.toThrow("unknown seed profile 'huge' (want small | standard | large)");
  });
});

describe('Kubernetes-only flags on Docker', () => {
  it('are said to be ignored, rather than silently dropped', async () => {
    // `up --mongo-operator` or `--ingress-class nginx` on Docker built a full workspace
    // with no word that either was ignored.
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const warned: string[] = [];
    await createDocker
      .createRepro(
        createReq({
          version: '8.5.1',
          offline: true,
          runtime: 'docker',
          mongoOperator: true,
          ingressClass: 'nginx',
        }),
        (event) => {
          if (event.level === 'warn') warned.push(event.message);
        },
      )
      .catch(() => undefined);
    expect(warned).toContain(
      '--mongo-operator and --ingress-class: Kubernetes only, ignored on Docker',
    );
  });
});

describe('a qualified --set on a single preset', () => {
  it.each(['docker', 'kubernetes'])(
    "is that preset's parameter on %s, and its value is checked as one",
    async (runtime) => {
      // `-p ldap --set ldap.users=abc` was refused as an unknown param on both runtimes,
      // while `-p ldap -p email` took the same key and checked its value.
      const createDocker =
        require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
      const refused = createDocker.createRepro(
        createReq({
          version: '8.5.1',
          name: 'kbad',
          preset: 'ldap',
          params: { 'ldap.users': 'abc' },
          runtime,
          offline: true,
        }),
      );
      await expect(refused).rejects.toThrow("--set users='abc' expects a whole number");
      await expect(refused).rejects.toHaveProperty('exitCode', 2);
    },
  );
});

describe("a combination's IdP on a non-loopback bind", () => {
  it('is warned about as the single preset is', () => {
    // Looked up by the combined name (`email+saml`), the warning never fired for a set:
    // the SAML button bounced off the visitor's own machine with nothing said.
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const said: string[] = [];
    const plan = createDocker.createPlan({
      req: createReq({ version: '8.5.1', preset: 'email+saml', bind: '0.0.0.0' }),
      emit: (event) => said.push(event.message),
    });
    plan.bindHost = '0.0.0.0';
    plan.hostPort = 3611;
    createDocker.warnAboutTheBrowserHost(plan);
    expect(said.join(' ')).toContain("this 'saml' workspace is bound to 0.0.0.0");
    expect(said.join(' ')).toContain('--set saml.idp_host=<host>');
  });

  it('is said for a URL given over plain http, and not for an HTTPS name or proxied MinIO', () => {
    // A `--domain` workspace with oidc and s3_minio was told OIDC "opens a blank window" and
    // previews fail, and to re-create on 0.0.0.0: over HTTPS the browser signs in through
    // <name>/keycloak/ and Rocket.Chat proxies the downloads, and both worked.
    const warned = (https: boolean): string => {
      const said: string[] = [];
      const plan = createPlan({
        req: createReq({
          version: '8.5.1',
          preset: 'oidc+s3_minio',
          ...(https ? { domain: 'd1.example.com' } : { rootUrl: 'http://d1.example.com:3301' }),
        }),
        emit: (event) => said.push(event.message),
      });
      plan.pre = presets.loadMany(['oidc', 's3_minio'], {}, 'docker');
      plan.bindHost = '127.0.0.1';
      plan.hostPort = 3301;
      if (https) {
        plan.tlsspec = tlsSpec({ mode: MODE_ACME, host: 'd1.example.com', acmeEmail: 'o@e.com' });
      }
      createDocker.warnAboutTheBrowserHost(plan);
      return said.join(' ');
    };
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    expect(warned(true)).not.toContain('names that browser');
    // The case it was written for: an http URL with the ports on loopback.
    expect(warned(false)).toContain("this 'oidc' workspace advertises http://d1.example.com:3301");
    // MinIO in its default proxy mode is never the browser's to reach.
    expect(warned(false)).not.toContain("'s3_minio'");
  });
});

describe('presigned uploads on an HTTPS workspace', () => {
  it('are warned about when the workspace is created, not only in its notes', async () => {
    // The browser fetches presigned URLs from MinIO over http, which an https page blocks as
    // mixed content. The notes said so; the create-time warning had no test of its own, so
    // dropping the emit left every test green.
    const versions = require('../../../src/lib/versions') as typeof VersionsNS;
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const said: string[] = [];
    const plan = createPlan({
      req: createReq({ version: '8.5.1', name: 'p3', preset: 's3_minio' }),
      emit: (event) => said.push(event.message),
    });
    plan.reproName = 'p3';
    plan.resolved = versions.resolve('8.5.1', { offline: true });
    plan.pre = presets.load('s3_minio', { presigned: 'true' });
    plan.hostPort = 3000;
    plan.root = 'http://localhost:3000';
    plan.bindHost = '127.0.0.1';
    plan.tlsspec = tlsSpec({ mode: MODE_ACME, host: 'p3.example.com', acmeEmail: 'o@e.com' });
    await createDocker.buildDocument(plan);
    expect(said.some((line) => line.includes('mixed content'))).toBe(true);
  });
});

describe('the name a create settles on', () => {
  it('is announced by both runtimes, for the GUI to title its progress by', async () => {
    // Only `announceName` itself was tested; the jobs and repros tests inject the event by
    // mock, so a create that stopped calling it left every test green.
    const createDocker =
      require('../../../src/core/lifecycle/create-docker') as typeof CreateDockerNS;
    const createK8s = require('../../../src/core/lifecycle/create-k8s') as typeof CreateK8sNS;
    const { missingMonitorAttach } = require('../../../src/core/lifecycle/request') as {
      missingMonitorAttach: never;
    };
    const codes: string[] = [];
    const emit = (event: { code?: string; data?: unknown }): void => {
      if (event.code === 'workspace-name') codes.push(JSON.stringify(event.data));
    };
    const plan = createPlan({ req: createReq({ version: '8.5.1', preset: 'email' }), emit });
    plan.reproName = 'rc8-5-1-email';
    await createDocker.settleName(plan).catch(() => undefined);
    const job = createK8s.kubeCreate({
      req: createReq({ version: '8.5.1', preset: 'email', runtime: 'kubernetes' }),
      emit,
      monitorAttach: missingMonitorAttach,
    });
    await createK8s.settleName(job).catch(() => undefined);
    expect(codes).toHaveLength(2);
  });
});
