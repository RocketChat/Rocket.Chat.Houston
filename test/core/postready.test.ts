import * as path from 'node:path';

import type { Event } from '../../src/lib/events';

import { metadata, type Metadata } from '../../src/core/runner/record';
import { KUBERNETES, stamp } from '../../src/core/topology';
import { Interrupted } from '../../src/seams/exec';

import type * as ModNS from '../../src/core/postready';
import type * as KubeExecNS from '../../src/core/kube/exec';
import type * as FsNS from 'node:fs';

function meta(values: Partial<Metadata> = {}): Metadata {
  return metadata({
    name: 'w',
    project: 'p',
    rcVersion: '8.5.1',
    rcImage: 'i',
    mongoTag: '8.0',
    mongoFlavor: 'official',
    preset: 'saml',
    rootUrl: 'u',
    hostPort: 3000,
    versionSource: 't',
    ...values,
  });
}

const AUTH = { token: 't', userId: 'uid' };

/** Collect what the run said, the way the CLI and `web/jobs` both do. */
function recorder() {
  const said: string[] = [];
  return { said, emit: (e: Event) => said.push(e.message) };
}

const noSleep = () => Promise.resolve();

/** Load the module with `./rcapi` fully stubbed to one answer. */
function withRcapi(answers: Record<string, unknown>, mocks: Record<string, () => unknown> = {}) {
  jest.resetModules();
  jest.doMock('../../src/core/rcapi', () => ({
    getSetting: async () => 'keycloak',
    samlProviderState: async () => 'unloaded',
    ...answers,
  }));
  for (const [modulePath, factory] of Object.entries(mocks)) jest.doMock(modulePath, factory);
  return require('../../src/core/postready') as typeof ModNS;
}

describe('a preset configures itself through the runtime that owns it', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('reaches for kubectl on a Kubernetes workspace, and never for compose', async () => {
    // `no configuration file provided: not found` in the middle of a Kubernetes create,
    // followed by "starting". That is docker compose's own wording for "there is no
    // compose project here", and it appeared because a post_ready handler -- a preset
    // configuring ITSELF -- called `composeExec` on a Kubernetes workspace.
    jest.resetModules();
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExec: () => {
        throw new Error('it reached for docker compose');
      },
    }));
    jest.doMock('../../src/core/kube/namespace', () => ({
      namespaceFor: () => Promise.resolve('houston-k'),
    }));
    const postready = require('../../src/core/postready') as typeof ModNS;
    const { kube } = require('../../src/core/kube/exec') as typeof KubeExecNS;

    const seen: (readonly string[])[] = [];
    const original = kube.run;
    kube.run = (argv) => {
      seen.push(argv);
      return Promise.resolve({ argv, returncode: 0, stdout: 'keycloak-abc', stderr: '' });
    };
    try {
      const m = meta({ name: 'k', project: 'houston-k' });
      stamp(m.extra, KUBERNETES);
      expect(await postready.execIn(m, 'keycloak', ['bash', '-lc', 'true'])).toBe(0);
    } finally {
      kube.run = original;
    }
    expect(seen.some((argv) => argv.includes('kubectl'))).toBe(true);
    expect(seen.some((argv) => argv.includes('exec'))).toBe(true);
    expect(seen.some((argv) => argv.includes('-l') && argv.includes('app=houston-keycloak'))).toBe(
      true,
    );
  });

  it('still goes through compose on a Compose workspace -- this is a fork, not a swap', async () => {
    jest.resetModules();
    const calls: unknown[][] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExec: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(0);
      },
    }));
    const postready = require('../../src/core/postready') as typeof ModNS;
    const { kube } = require('../../src/core/kube/exec') as typeof KubeExecNS;

    const original = kube.run;
    kube.run = () => {
      throw new Error('it reached for kubectl');
    };
    try {
      expect(await postready.execIn(meta({ name: 'c' }), 'keycloak', ['true'])).toBe(0);
    } finally {
      kube.run = original;
    }
    expect(calls).toEqual([['c', 'keycloak', ['true']]]);
  });

  it('does not ask kubectl to mint a namespace the record already holds', async () => {
    // The recorded namespace short-circuits the lookup. A workspace that recorded its
    // namespace has the answer on disk, and spending a kubectl call to recompute it is a
    // child process spent in the middle of a create.
    jest.resetModules();
    jest.doMock('../../src/core/runner/engine', () => ({ composeExec: () => Promise.resolve(0) }));
    jest.doMock('../../src/core/kube/namespace', () => ({
      namespaceFor: () => {
        throw new Error('it recomputed a namespace it already had');
      },
    }));
    const postready = require('../../src/core/postready') as typeof ModNS;
    const { kube } = require('../../src/core/kube/exec') as typeof KubeExecNS;

    const seen: (readonly string[])[] = [];
    const original = kube.run;
    kube.run = (argv) => {
      seen.push(argv);
      return Promise.resolve({ argv, returncode: 0, stdout: 'pod-1', stderr: '' });
    };
    try {
      const m = meta({ name: 'k' });
      stamp(m.extra, KUBERNETES);
      m.extra.namespace = 'houston-recorded';
      await postready.execIn(m, 'keycloak', ['true']);
    } finally {
      kube.run = original;
    }
    expect(seen[0]).toContain('houston-recorded');
  });
});

describe('a half-configured preset says so instead of reporting success', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('names what failed and the command that retries it', async () => {
    // The create printed "could not fetch/apply IdP cert", then "starting", and left the
    // reader to work out whether SAML actually worked. The DEPLOYMENT succeeding and the
    // CONFIGURATION succeeding are different answers to different questions.
    jest.resetModules();
    const postready = require('../../src/core/postready') as typeof ModNS;
    const m = meta();
    m.extra.post_ready = [{ action: 'saml_idp_cert' }, { action: 'keycloak_master_ssl_off' }];
    const { said, emit } = recorder();
    postready.POST_READY_ACTIONS.saml_idp_cert = () => Promise.resolve(false);
    postready.POST_READY_ACTIONS.keycloak_master_ssl_off = () => Promise.resolve(true);
    let failed: string[] | null;
    try {
      failed = await postready.runPostReady(m, AUTH, emit);
    } finally {
      postready.resetActions();
    }
    expect(failed).toEqual(['saml_idp_cert']);
    const joined = said.join(' ');
    expect(joined).toContain('RUNNING');
    expect(joined).toContain('partly configured');
    expect(joined).toContain('saml_idp_cert');
    expect(joined).toContain('houston ready --name w');
    // And the one that SUCCEEDED is not in the list, or the summary means nothing.
    expect(joined).not.toContain('keycloak_master_ssl_off');
  });

  it('answers null, not an empty list, when there was no admin session', async () => {
    const postready = require('../../src/core/postready') as typeof ModNS;
    const m = meta();
    m.extra.post_ready = [{ action: 'saml_idp_cert' }];
    const { said, emit } = recorder();
    // No session, no actions, and null says so. "Nothing ran" and "everything succeeded"
    // are different answers, and a caller that renders `[]` as a clean bill of health needs
    // to be able to tell them apart.
    expect(await postready.runPostReady(m, null, emit)).toBeNull();
    expect(said.join(' ')).toContain('preset self-config skipped');
  });

  it('says nothing at all when there was no admin session and nothing to configure', async () => {
    const postready = require('../../src/core/postready') as typeof ModNS;
    const { said, emit } = recorder();
    expect(await postready.runPostReady(meta(), null, emit)).toBeNull();
    expect(said).toEqual([]);
  });

  it('skips an action name this build does not know, rather than failing it', async () => {
    const postready = require('../../src/core/postready') as typeof ModNS;
    const m = meta();
    m.extra.post_ready = [{ action: 'from_a_newer_preset' }];
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit)).toEqual([]);
    expect(said).toEqual([]);
  });
});

describe('the IdP cert is fetched once, not retried around a retrier', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('calls the retrying function exactly once, with the deadline passed in', async () => {
    // A SAML create that sat for THIRTY MINUTES, found by the operational audit.
    // `fetchSamlIdpCert` retries to its own deadline, and v0.54.1 wrapped it in a second
    // 20-attempt loop without reading that. 20 x 90s is half an hour of a create that
    // looks hung and cannot be told from one that is.
    const calls: unknown[] = [];
    const postready = withRcapi({
      fetchSamlIdpCert: (_url: string, options: unknown) => {
        calls.push(options);
        return Promise.resolve('');
      },
      setSetting: () => Promise.resolve(true),
    });
    const m = meta();
    m.extra.post_ready = [
      { action: 'saml_idp_cert', descriptor_url: 'http://localhost:8081/x', setting: 's' },
    ];
    await postready.runPostReady(m, AUTH, recorder().emit, { sleep: noSleep });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ timeout: postready.IDP_CERT_DEADLINE });
  });

  it('has no loop wrapped around it in the source, which is the shape of the defect', () => {
    const fs = require('node:fs') as typeof FsNS;
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'core', 'postready.ts'),
      'utf8',
    );
    // The CALL, not the prose: the comment above it names the function to explain why it
    // is only called once, so counting the name would count the explanation too.
    expect(src.split('rcapi.fetchSamlIdpCert(')).toHaveLength(2);
  });
});

describe('every handler reports a boolean', () => {
  afterEach(() => {
    jest.resetModules();
  });

  const ALL_ACTIONS = [
    { action: 'saml_idp_cert', descriptor_url: 'http://idp/x', setting: 's' },
    { action: 'keycloak_master_ssl_off' },
    { action: 'create_oauth_provider', name: 'Keycloak', settings: { a: 1 } },
    { action: 'livechat_setup', agents: 2, department: 'Support' },
  ];

  /**
   * Driven rather than read off the type annotations.
   * The collection reads `=== false`, so a handler that answers `undefined` opts itself
   * out of it silently -- two did, and one of them was the oidc preset's only action.
   */
  function rcapiAnswering(value: boolean) {
    const yes = () => Promise.resolve(value);
    return {
      fetchSamlIdpCert: () => Promise.resolve(value ? 'CERT' : ''),
      setSetting: yes,
      addOauthService: yes,
      createUser: yes,
      addLivechatAgent: yes,
      getUserId: () => Promise.resolve(value ? 'id2' : null),
      ensureLivechatDepartment: () => Promise.resolve(value ? 'dept' : null),
      assignLivechatAgents: yes,
      saveCannedResponse: yes,
      setLivechatAvailable: yes,
    };
  }

  it('reports every action as failed when nothing works', async () => {
    jest.doMock('../../src/core/runner/engine', () => ({ composeExec: () => Promise.resolve(1) }));
    const postready = withRcapi(rcapiAnswering(false));
    const m = meta();
    m.extra.post_ready = ALL_ACTIONS;
    expect(await postready.runPostReady(m, AUTH, recorder().emit, { sleep: noSleep })).toEqual([
      'saml_idp_cert',
      'keycloak_master_ssl_off',
      'create_oauth_provider',
      'livechat_setup',
    ]);
  });

  it("keeps Keycloak's login chatter off houston's stderr", async () => {
    // kcadm's "Logging into http://localhost:8080 as user admin of realm master" is on
    // stderr, which a Docker exec shares with houston: it landed under `up --json` and on
    // serve's console.
    const scripts: string[] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExec: (_name: string, _service: string, argv: string[]) => {
        scripts.push(argv.join(' '));
        return Promise.resolve(0);
      },
    }));
    const postready = withRcapi(rcapiAnswering(true));
    const m = meta();
    m.extra.post_ready = [{ action: 'keycloak_master_ssl_off' }];
    await postready.runPostReady(m, AUTH, recorder().emit, { sleep: noSleep });
    expect(scripts.join('\n')).toMatch(/config credentials [^&]*>\/dev\/null 2>&1 &&/u);
  });

  it('reports none as failed when everything works', async () => {
    jest.doMock('../../src/core/runner/engine', () => ({ composeExec: () => Promise.resolve(0) }));
    const postready = withRcapi(rcapiAnswering(true));
    const m = meta();
    m.extra.post_ready = ALL_ACTIONS;
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
    const joined = said.join(' ');
    expect(joined).toContain('SAML login button registered');
    expect(joined).toContain('Keycloak admin console enabled over HTTP');
    expect(joined).toContain('OIDC provider created and configured');
    expect(joined).toContain("Omnichannel: 2 agent(s) available, 'Support' department");
    expect(joined).not.toContain('partly configured');
  });
});

describe('a SAML provider refreshed after a restart', () => {
  afterEach(() => {
    jest.dontMock('../../src/core/rcapi');
    jest.resetModules();
  });

  function samlMeta(instances = 1): Metadata {
    const m = meta({
      rootUrl: 'http://localhost:3600',
      hostPort: 3600,
      extra: { instances },
    });
    m.extra.post_ready = [
      {
        action: 'saml_idp_cert',
        descriptor_url: 'http://localhost:8081/descriptor',
        setting: 'SAML_Custom_Default_cert',
        enable_setting: 'SAML_Custom_Default',
      },
    ];
    return m;
  }

  it('keeps an unchanged healthy SAML provider loaded without writing settings again', async () => {
    const setSetting = jest.fn(async () => true);
    const observed = new Map<string, number>();
    const pauses: number[] = [];
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      getSetting: async (_root: string, _auth: unknown, _pw: string, setting: string) =>
        setting === 'SAML_Custom_Default_cert' ? 'CERT' : 'keycloak',
      setSetting,
      samlProviderReady: async (root: string) => {
        observed.set(root, (observed.get(root) ?? 0) + 1);
        return true;
      },
    });
    const { said, emit } = recorder();
    expect(
      await postready.runPostReady(samlMeta(2), AUTH, emit, {
        sleep: async (seconds) => {
          pauses.push(seconds);
        },
      }),
    ).toEqual([]);
    expect(setSetting).not.toHaveBeenCalled();
    expect(pauses).toEqual([3]);
    expect([...observed.entries()].sort()).toEqual([
      ['http://localhost:3600', 2],
      ['http://localhost:3601', 2],
      ['http://localhost:3602', 2],
    ]);
    expect(said.join(' ')).toContain('SAML login button registered');
  });

  it('says the certificate is already in place, not applied, when nothing was written', async () => {
    // A healthy `ready` said "IdP cert applied" while every SAML setting kept its
    // `_updatedAt`: nothing had been applied.
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      getSetting: async (_root: string, _auth: unknown, _pw: string, setting: string) =>
        setting === 'SAML_Custom_Default_cert' ? 'CERT' : 'keycloak',
      setSetting: async () => true,
      samlProviderReady: async () => true,
    });
    const { said, emit } = recorder();
    await postready.runPostReady(samlMeta(), AUTH, emit, { sleep: noSleep });
    expect(said).toContain('IdP cert already in place; SAML login button registered.');
    expect(said.join(' ')).not.toContain('IdP cert applied');
  });

  it('waits for unchanged SAML settings to finish initial registration without toggling them', async () => {
    let elapsed = 0;
    const setSetting = jest.fn(async () => true);
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      getSetting: async (_root: string, _auth: unknown, _pw: string, setting: string) =>
        setting === 'SAML_Custom_Default_cert' ? 'CERT' : 'keycloak',
      setSetting,
      samlProviderReady: async (root: string) => root !== 'http://localhost:3602' || elapsed >= 6,
    });
    expect(
      await postready.runPostReady(samlMeta(2), AUTH, recorder().emit, {
        sleep: async (seconds) => {
          elapsed += seconds;
        },
      }),
    ).toEqual([]);
    // The slow process answers missing-provider redirects while its initial load is
    // pending. Two loaded observations are required after it finishes at six seconds.
    expect(elapsed).toBe(9);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it.each(['missing', 'late-loaded'])(
    'bounds unchanged SAML observation by wall time when the provider is %s',
    async (state) => {
      let clock = 0;
      let repaired = false;
      let firstWriteAt: number | undefined;
      const timeouts: number[] = [];
      const postready = withRcapi({
        fetchSamlIdpCert: async () => 'CERT',
        getSetting: async (_root: string, _auth: unknown, _pw: string, setting: string) =>
          setting === 'SAML_Custom_Default_cert' ? 'CERT' : 'keycloak',
        setSetting: async (
          _root: string,
          _auth: unknown,
          _pw: string,
          setting: string,
          value: unknown,
        ) => {
          firstWriteAt ??= clock;
          if (setting === 'SAML_Custom_Default' && value === true) repaired = true;
          return true;
        },
        samlProviderReady: async (_root: string, { timeoutMs = 3_000 } = {}) => {
          if (repaired) return true;
          timeouts.push(timeoutMs);
          const began = clock;
          // Two slow requests consume real observation time, rather than only the
          // polling sleeps. The last pair must fit the remaining one-second budget.
          clock += Math.min(5_000, timeoutMs * 2);
          return state === 'late-loaded' && began >= 24_000;
        },
      });
      const now = jest.spyOn(Date, 'now').mockImplementation(() => clock);
      try {
        expect(
          await postready.runPostReady(samlMeta(), AUTH, recorder().emit, {
            sleep: async (seconds) => {
              clock += seconds * 1000;
            },
          }),
        ).toEqual([]);
      } finally {
        now.mockRestore();
      }
      expect(firstWriteAt).toBe(33_000);
      expect(timeouts).toEqual([3_000, 3_000, 3_000, 3_000, 500]);
    },
  );

  it('reloads an unchanged certificate when a replica loses its loaded provider', async () => {
    const writes: unknown[] = [];
    let observation = 0;
    let repaired = false;
    let elapsed = 0;
    let firstWriteAt: number | undefined;
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      getSetting: async (_root: string, _auth: unknown, _pw: string, setting: string) =>
        setting === 'SAML_Custom_Default_cert' ? 'CERT' : 'keycloak',
      setSetting: async (
        _root: string,
        _auth: unknown,
        _pw: string,
        setting: string,
        value: unknown,
      ) => {
        firstWriteAt ??= elapsed;
        if (setting === 'SAML_Custom_Default') writes.push(value);
        if (setting === 'SAML_Custom_Default' && value === true) repaired = true;
        return true;
      },
      // The first observation succeeds, but a replica then remains absent until a
      // real reload repairs it. Waiting is bounded and cannot silently certify it.
      samlProviderReady: async (root: string) => {
        observation += 1;
        return root !== 'http://localhost:3602' || observation <= 3 || repaired;
      },
    });
    expect(
      await postready.runPostReady(samlMeta(2), AUTH, recorder().emit, {
        sleep: async (seconds) => {
          elapsed += seconds;
        },
      }),
    ).toEqual([]);
    expect(firstWriteAt).toBe(33);
    expect(writes).toEqual([false, false, false, true, true, true]);
  });

  it.each([false, true])(
    'reports a refused enable-setting write (%s) instead of registration',
    async (refused) => {
      const postready = withRcapi({
        fetchSamlIdpCert: async () => 'CERT',
        setSetting: async (
          _url: string,
          _auth: unknown,
          _pw: string,
          setting: string,
          value: unknown,
        ) => setting !== 'SAML_Custom_Default' || value !== refused,
        samlProviderReady: async () => true,
      });
      const { said, emit } = recorder();
      expect(await postready.runPostReady(samlMeta(), AUTH, emit, { sleep: noSleep })).toEqual([
        'saml_idp_cert',
      ]);
      expect(said.join(' ')).not.toContain('SAML login button registered');
      expect(said.join(' ')).toContain('SAML_Custom_Default');
    },
  );

  it('does not claim registration while the service list remains empty', async () => {
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      setSetting: async () => true,
      samlProviderReady: async () => false,
    });
    const { said, emit } = recorder();
    expect(await postready.runPostReady(samlMeta(), AUTH, emit, { sleep: noSleep })).toEqual([
      'saml_idp_cert',
    ]);
    expect(said.join(' ')).toContain('did not register on every instance');
    expect(said.join(' ')).not.toContain('SAML login button registered');
  });

  it('lets the disabled provider reload before enabling it, then observes the registration', async () => {
    let disabledAt = 0;
    let elapsed = 0;
    let registered = false;
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      setSetting: async (
        _url: string,
        _auth: unknown,
        _pw: string,
        setting: string,
        value: unknown,
      ) => {
        if (setting === 'SAML_Custom_Default' && value === false) disabledAt = elapsed;
        if (setting === 'SAML_Custom_Default' && value === true) {
          // Rocket.Chat debounces SAML reloads for two seconds; the previous one-second
          // transition could leave a replica completing its disabled reload later.
          registered = elapsed - disabledAt > 2;
        }
        return true;
      },
      samlProviderReady: async () => registered,
    });
    const sleep = async (seconds: number) => {
      elapsed += seconds;
    };
    expect(await postready.runPostReady(samlMeta(), AUTH, recorder().emit, { sleep })).toEqual([]);
    expect(registered).toBe(true);
  });

  it('refreshes each replica cache and waits for its own SAML provider to load', async () => {
    const writes: { root: string; setting: string; value: unknown }[] = [];
    const observed = new Map<string, number>();
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      setSetting: async (
        root: string,
        _auth: unknown,
        _pw: string,
        setting: string,
        value: unknown,
      ) => {
        writes.push({ root, setting, value });
        return true;
      },
      samlProviderReady: async (root: string) => {
        const attempt = (observed.get(root) ?? 0) + 1;
        observed.set(root, attempt);
        return root !== 'http://localhost:3602' || attempt > 1;
      },
    });
    expect(
      await postready.runPostReady(samlMeta(2), AUTH, recorder().emit, { sleep: noSleep }),
    ).toEqual([]);
    for (const root of [
      'http://localhost:3600',
      'http://localhost:3601',
      'http://localhost:3602',
    ]) {
      expect(writes).toContainEqual({ root, setting: 'SAML_Custom_Default_cert', value: 'CERT' });
      expect(writes).toContainEqual({ root, setting: 'SAML_Custom_Default', value: false });
      expect(writes).toContainEqual({ root, setting: 'SAML_Custom_Default', value: true });
      expect(observed.get(root)).toBeGreaterThanOrEqual(2);
    }
  });

  it('waits for a slower replica to unload before re-enabling the shared SAML service', async () => {
    let elapsed = 0;
    let disabled = false;
    let enabledTooSoon = false;
    const observed = new Set<string>();
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      setSetting: async (
        _root: string,
        _auth: unknown,
        _pw: string,
        setting: string,
        value: unknown,
      ) => {
        if (setting === 'SAML_Custom_Default' && value === false) disabled = true;
        if (setting === 'SAML_Custom_Default' && value === true) {
          enabledTooSoon ||= elapsed < 9;
          disabled = false;
        }
        return true;
      },
      samlProviderState: async (root: string) => {
        observed.add(root);
        return disabled && (root !== 'http://localhost:3602' || elapsed >= 6)
          ? 'unloaded'
          : 'loaded';
      },
      samlProviderReady: async () => !disabled && !enabledTooSoon,
    });
    const { said, emit } = recorder();
    expect(
      await postready.runPostReady(samlMeta(2), AUTH, emit, {
        sleep: async (seconds) => {
          elapsed += seconds;
        },
      }),
    ).toEqual([]);
    expect(enabledTooSoon).toBe(false);
    expect([...observed].sort()).toEqual([
      'http://localhost:3600',
      'http://localhost:3601',
      'http://localhost:3602',
    ]);
    expect(said.join(' ')).toContain('SAML login button registered');
  });

  it('does not treat an unreachable replica as unloaded, and restores enablement on timeout', async () => {
    const writes: unknown[] = [];
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      setSetting: async (
        _root: string,
        _auth: unknown,
        _pw: string,
        setting: string,
        value: unknown,
      ) => {
        if (setting === 'SAML_Custom_Default') writes.push(value);
        return true;
      },
      samlProviderState: async () => 'unknown',
      samlProviderReady: async () => true,
    });
    const { said, emit } = recorder();
    expect(await postready.runPostReady(samlMeta(), AUTH, emit, { sleep: noSleep })).toEqual([
      'saml_idp_cert',
    ]);
    expect(writes).toEqual([false, true]);
    expect(said.join(' ')).toContain('reload did not finish disabling on every instance');
    expect(said.join(' ')).not.toContain('SAML login button registered');
  });

  it('restores SAML enablement after one replica refuses the disable write', async () => {
    const enabled: string[] = [];
    const postready = withRcapi({
      fetchSamlIdpCert: async () => 'CERT',
      setSetting: async (
        root: string,
        _auth: unknown,
        _pw: string,
        setting: string,
        value: unknown,
      ) => {
        if (setting === 'SAML_Custom_Default' && value === true) enabled.push(root);
        return setting !== 'SAML_Custom_Default' || value !== false || !root.endsWith(':3602');
      },
    });
    expect(
      await postready.runPostReady(samlMeta(2), AUTH, recorder().emit, { sleep: noSleep }),
    ).toEqual(['saml_idp_cert']);
    expect(enabled.sort()).toEqual([
      'http://localhost:3600',
      'http://localhost:3601',
      'http://localhost:3602',
    ]);
  });

  it.each(['observation', 'cancellation'])(
    'restores SAML enablement when %s interrupts the unload wait',
    async (failure) => {
      const problem = failure === 'cancellation' ? new Interrupted() : new Error('probe failed');
      const writes: unknown[] = [];
      const postready = withRcapi({
        fetchSamlIdpCert: async () => 'CERT',
        setSetting: async (
          _root: string,
          _auth: unknown,
          _pw: string,
          setting: string,
          value: unknown,
        ) => {
          if (setting === 'SAML_Custom_Default') writes.push(value);
          return true;
        },
        samlProviderState: async () => {
          if (failure === 'observation') throw problem;
          return 'loaded';
        },
      });
      await expect(
        postready.runPostReady(samlMeta(), AUTH, recorder().emit, {
          sleep: async () => {
            throw problem;
          },
        }),
      ).rejects.toBe(problem);
      expect(writes).toEqual([false, true]);
    },
  );
});

describe('an OAuth provider that did not configure is not a success', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('reports a provider that could not be created', async () => {
    // `runPostReady` collects a failure on an explicit false, and this handler returned
    // nothing on EVERY path -- so a workspace whose OAuth provider could not be created
    // printed one warning, was left out of the "only partly configured" summary that
    // exists for exactly this, and exited 0.
    const postready = withRcapi({ addOauthService: () => Promise.resolve(false) });
    const m = meta({ preset: 'oidc' });
    m.extra.post_ready = [
      { action: 'create_oauth_provider', name: 'Keycloak', settings: { a: 1 } },
    ];
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([
      'create_oauth_provider',
    ]);
    expect(said.join(' ')).toContain('partly configured');
  });

  it('names the settings that did not apply, and does not call the button usable', async () => {
    // Creating the provider is not the same as the provider working. The settings carry
    // the realm URL, the client id and the secret; every `setSetting` result was
    // discarded, so a provider created with none of them reported "login button
    // registered" -- and the button really was registered, pointing at nothing.
    const postready = withRcapi({
      addOauthService: () => Promise.resolve(true),
      // The url is the one that matters, and it is the one that refuses.
      setSetting: (_u: string, _a: unknown, _p: string, sid: string) =>
        Promise.resolve(!sid.includes('-url')),
    });
    const settings = {
      'Accounts_OAuth_Custom-Keycloak': true,
      'Accounts_OAuth_Custom-Keycloak-url': 'http://keycloak:8085/realms/x',
    };
    const m = meta({ preset: 'oidc' });
    m.extra.post_ready = [{ action: 'create_oauth_provider', name: 'Keycloak', settings }];
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([
      'create_oauth_provider',
    ]);
    const joined = said.join(' ');
    expect(joined).toContain('-url');
    expect(joined).toContain('lead nowhere');
    expect(joined).toContain('1 of its 2 settings did not apply');
  });

  it('retries the settings that did not take, because RC caches them', async () => {
    // The provider's settings are created BY `addOAuthService`, so the first PATCH can
    // land before the id exists. A fixed sleep is either too short on a loaded box or
    // wasted on a fast one, and this is the window in which a wrong answer looks like
    // success.
    let attempt = 0;
    const seen: string[][] = [];
    const postready = withRcapi({
      addOauthService: () => Promise.resolve(true),
      setSetting: (_u: string, _a: unknown, _p: string, sid: string) => {
        const round = seen[attempt] ?? (seen[attempt] = []);
        round.push(sid);
        return Promise.resolve(attempt > 0);
      },
    });
    const m = meta({ preset: 'oidc' });
    m.extra.post_ready = [{ action: 'create_oauth_provider', name: 'K', settings: { a: 1, b: 2 } }];
    const sleep = () => {
      attempt += 1;
      return Promise.resolve();
    };
    expect(await postready.runPostReady(m, AUTH, recorder().emit, { sleep })).toEqual([]);
    // The retry carries ONLY what failed, not the whole set again.
    expect(seen[0]).toEqual(['a', 'b']);
    expect(seen[1]).toEqual(['a', 'b']);
    expect(seen).toHaveLength(2);
  });

  it('gives up after three retries rather than looping forever', async () => {
    let rounds = 0;
    const postready = withRcapi({
      addOauthService: () => Promise.resolve(true),
      setSetting: () => {
        rounds += 1;
        return Promise.resolve(false);
      },
    });
    const m = meta({ preset: 'oidc' });
    m.extra.post_ready = [{ action: 'create_oauth_provider', name: 'K', settings: { a: 1 } }];
    expect(await postready.runPostReady(m, AUTH, recorder().emit, { sleep: noSleep })).toEqual([
      'create_oauth_provider',
    ]);
    expect(rounds).toBe(4); // one attempt, then three retries
  });

  function oidcMeta(instances = 1): Metadata {
    const m = meta({ preset: 'oidc', rootUrl: 'http://localhost:3600', hostPort: 3600 });
    m.extra.instances = instances;
    m.extra.post_ready = [
      {
        action: 'create_oauth_provider',
        name: 'Keycloak',
        settings: {
          'Accounts_OAuth_Custom-Keycloak': true,
          'Accounts_OAuth_Custom-Keycloak-url': 'http://keycloak:8085/realms/houston',
          'Accounts_OAuth_Custom-Keycloak-show_button': true,
        },
      },
    ];
    return m;
  }

  const registered = () =>
    Promise.resolve<[number, string]>([
      200,
      JSON.stringify({ success: true, configurations: [{ service: 'keycloak' }] }),
    ]);

  it('sets the URL before enabling so RC cannot poison its initial OAuth constructor', async () => {
    let url: unknown;
    let poisoned = false;
    const writes: string[] = [];
    const reads: string[] = [];
    const postready = withRcapi({
      addOauthService: async () => true,
      setSetting: async (
        _root: string,
        _auth: unknown,
        _pw: string,
        sid: string,
        value: unknown,
      ) => {
        writes.push(sid);
        if (sid.endsWith('-url')) url = value;
        if (sid === 'Accounts_OAuth_Custom-Keycloak' && value === true && typeof url !== 'string') {
          poisoned = true;
        }
        return true; // The HTTP PATCH still succeeds when RC's asynchronous loader throws.
      },
      call: async (root: string) => {
        reads.push(root);
        return [200, JSON.stringify({ configurations: poisoned ? [] : [{ service: 'keycloak' }] })];
      },
    });
    expect(
      await postready.runPostReady(oidcMeta(2), AUTH, recorder().emit, { sleep: noSleep }),
    ).toEqual([]);
    expect(poisoned).toBe(false);
    expect(writes).toEqual([
      'Accounts_OAuth_Custom-Keycloak-url',
      'Accounts_OAuth_Custom-Keycloak-show_button',
      'Accounts_OAuth_Custom-Keycloak',
    ]);
    expect(reads).toEqual([
      'http://localhost:3600',
      'http://localhost:3601',
      'http://localhost:3602',
    ]);
  });

  it('leaves a new provider disabled when its configuration was refused', async () => {
    const writes: string[] = [];
    const postready = withRcapi({
      addOauthService: async () => true,
      setSetting: async (_root: string, _auth: unknown, _pw: string, sid: string) => {
        writes.push(sid);
        return !sid.endsWith('-url');
      },
      call: () => {
        throw new Error('it observed an incompletely configured provider');
      },
    });
    const { said, emit } = recorder();
    expect(await postready.runPostReady(oidcMeta(), AUTH, emit, { sleep: noSleep })).toEqual([
      'create_oauth_provider',
    ]);
    expect(writes).not.toContain('Accounts_OAuth_Custom-Keycloak');
    expect(said.join(' ')).toContain('partly configured');
    expect(said.join(' ')).not.toContain('login button registered');
  });

  it('names an enable refusal without retrying or reporting a registered button', async () => {
    const writes: string[] = [];
    const postready = withRcapi({
      addOauthService: async () => true,
      setSetting: async (_root: string, _auth: unknown, _pw: string, sid: string) => {
        writes.push(sid);
        return sid !== 'Accounts_OAuth_Custom-Keycloak';
      },
    });
    const { said, emit } = recorder();
    expect(await postready.runPostReady(oidcMeta(), AUTH, emit, { sleep: noSleep })).toEqual([
      'create_oauth_provider',
    ]);
    expect(writes.filter((sid) => sid === 'Accounts_OAuth_Custom-Keycloak')).toHaveLength(1);
    expect(said.join(' ')).toContain('Accounts_OAuth_Custom-Keycloak');
    expect(said.join(' ')).not.toContain('login button registered');
  });

  it('waits for every replica registration without repeating the enable write', async () => {
    let observations = 0;
    const writes: unknown[] = [];
    const waits: number[] = [];
    const postready = withRcapi({
      addOauthService: async () => true,
      setSetting: async (
        _root: string,
        _auth: unknown,
        _pw: string,
        sid: string,
        value: unknown,
      ) => {
        if (sid === 'Accounts_OAuth_Custom-Keycloak') writes.push(value);
        return true;
      },
      call: async (
        root: string,
        method: string,
        apiPath: string,
        options: { timeoutMs: number },
      ) => {
        expect(method).toBe('GET');
        expect(apiPath).toBe('/api/v1/service.configurations');
        expect(options.timeoutMs).toBeLessThanOrEqual(3000);
        observations += 1;
        if (root.endsWith('3602') && observations <= 3) return [200, '{"configurations":[]}'];
        return await registered();
      },
    });
    expect(
      await postready.runPostReady(oidcMeta(2), AUTH, recorder().emit, {
        sleep: async (seconds) => {
          waits.push(seconds);
        },
      }),
    ).toEqual([]);
    expect(observations).toBe(6);
    expect(waits).toEqual([3]);
    expect(writes).toEqual([true]);
  });

  it('reports absent or malformed registration after a bounded observation', async () => {
    let observations = 0;
    let waits = 0;
    const postready = withRcapi({
      addOauthService: async () => true,
      setSetting: async () => true,
      call: async () => {
        observations += 1;
        return observations % 2 ? [200, '{"configurations":[]}'] : [200, 'not JSON'];
      },
    });
    const { said, emit } = recorder();
    expect(
      await postready.runPostReady(oidcMeta(), AUTH, emit, {
        sleep: async () => {
          waits += 1;
        },
      }),
    ).toEqual(['create_oauth_provider']);
    expect(observations).toBe(12);
    expect(waits).toBe(11);
    expect(said.join(' ')).toContain('did not register on every instance');
    expect(said.join(' ')).toContain('partly configured');
    expect(said.join(' ')).not.toContain('login button registered');
  });

  it('does not accept registration that answers after its observation deadline', async () => {
    let now = 1000;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const postready = withRcapi({
      addOauthService: async () => true,
      setSetting: async () => true,
      call: async () => {
        now += 33_001;
        return await registered();
      },
    });
    const { said, emit } = recorder();
    try {
      expect(await postready.runPostReady(oidcMeta(), AUTH, emit, { sleep: noSleep })).toEqual([
        'create_oauth_provider',
      ]);
    } finally {
      clock.mockRestore();
    }
    expect(said.join(' ')).toContain('did not register on every instance');
    expect(said.join(' ')).not.toContain('login button registered');
  });

  it('keeps a healthy repeated ready enabled throughout configuration', async () => {
    let enabled = true;
    const writes: unknown[] = [];
    const postready = withRcapi({
      addOauthService: async () => true,
      setSetting: async (
        _root: string,
        _auth: unknown,
        _pw: string,
        sid: string,
        value: unknown,
      ) => {
        expect(enabled).toBe(true);
        if (sid === 'Accounts_OAuth_Custom-Keycloak') {
          writes.push(value);
          enabled = value === true;
        }
        return true;
      },
      call: registered,
    });
    expect(
      await postready.runPostReady(oidcMeta(), AUTH, recorder().emit, { sleep: noSleep }),
    ).toEqual([]);
    expect(writes).toEqual([true]);
    expect(enabled).toBe(true);
  });
});

describe('the livechat action', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('is a failure when the agent could not be made available', async () => {
    // This returned nothing on both paths, so a livechat workspace whose agent could not be
    // made available printed a warning and was still counted as fully configured.
    const postready = withRcapi({
      addLivechatAgent: () => Promise.resolve(true),
      createUser: () => Promise.resolve(true),
      getUserId: () => Promise.resolve(null),
      setLivechatAvailable: () => Promise.resolve(false),
      saveCannedResponse: () => Promise.resolve(true),
      ensureLivechatDepartment: () => Promise.resolve(null),
      assignLivechatAgents: () => Promise.resolve(false),
    });
    const m = meta({ preset: 'livechat' });
    m.extra.post_ready = [{ action: 'livechat_setup' }];
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([
      'livechat_setup',
    ]);
    expect(said.join(' ')).toContain('Admin -> Omnichannel -> Agents');
  });

  it('is NOT a failure when only the canned response was refused', async () => {
    // Canned responses fail on a workspace with no licence, which is the normal case and
    // not a fault -- so it is deliberately outside the verdict.
    const postready = withRcapi({
      addLivechatAgent: () => Promise.resolve(true),
      createUser: () => Promise.resolve(true),
      getUserId: () => Promise.resolve(null),
      setLivechatAvailable: () => Promise.resolve(true),
      saveCannedResponse: () => Promise.resolve(false),
      ensureLivechatDepartment: () => Promise.resolve(null),
      assignLivechatAgents: () => Promise.resolve(false),
    });
    const m = meta({ preset: 'livechat' });
    m.extra.post_ready = [{ action: 'livechat_setup' }];
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
    expect(said.join(' ')).toContain('Enterprise features');
  });

  it('counts only the agents it could actually resolve', async () => {
    const postready = withRcapi({
      addLivechatAgent: () => Promise.resolve(true),
      createUser: () => Promise.resolve(true),
      // agent2 resolves, agent3 does not -- the admin plus one, not plus two.
      getUserId: (_u: string, _a: unknown, username: string) =>
        Promise.resolve(username === 'agent2' ? 'id2' : null),
      setLivechatAvailable: () => Promise.resolve(true),
      saveCannedResponse: () => Promise.resolve(true),
      ensureLivechatDepartment: () => Promise.resolve(null),
      assignLivechatAgents: () => Promise.resolve(false),
    });
    const m = meta({ preset: 'livechat' });
    m.extra.post_ready = [{ action: 'livechat_setup', agents: 3 }];
    const { said, emit } = recorder();
    await postready.runPostReady(m, AUTH, emit, { sleep: noSleep });
    expect(said.join(' ')).toContain('Omnichannel: 2 agent(s) available');
    // No department was asked for, so the summary must not claim one.
    expect(said.join(' ')).not.toContain('department created');
  });
});

describe('the e2ee test users', () => {
  afterEach(() => {
    jest.resetModules();
  });

  function e2eeMeta(): ReturnType<typeof meta> {
    const m = meta({ preset: 'e2ee' });
    m.extra.post_ready = [{ action: 'e2ee_users' }];
    return m;
  }

  it('creates e2e-alice, e2e-bob and e2e-carol, each with nothing else done for them', async () => {
    const made: string[] = [];
    const postready = withRcapi({
      createUser: (_u: string, _a: unknown, _p: string, username: string) => {
        made.push(username);
        return Promise.resolve(true);
      },
      getUserId: () => Promise.resolve(null),
    });
    const { said, emit } = recorder();
    expect(await postready.runPostReady(e2eeMeta(), AUTH, emit, { sleep: noSleep })).toEqual([]);
    expect(made).toEqual(['e2e-alice', 'e2e-bob', 'e2e-carol']);
    expect(said.join(' ')).toContain('E2EE test users ready: e2e-alice, e2e-bob, e2e-carol');
  });

  it('keeps a user an earlier `ready` already made, which users.create refuses', async () => {
    const postready = withRcapi({
      createUser: (_u: string, _a: unknown, _p: string, username: string) =>
        Promise.resolve(username !== 'e2e-bob'),
      getUserId: (_u: string, _a: unknown, username: string) =>
        Promise.resolve(username === 'e2e-bob' ? 'bob-id' : null),
    });
    expect(
      await postready.runPostReady(e2eeMeta(), AUTH, recorder().emit, { sleep: noSleep }),
    ).toEqual([]);
  });

  it('is a failure naming the users that could not be made', async () => {
    const postready = withRcapi({
      createUser: (_u: string, _a: unknown, _p: string, username: string) =>
        Promise.resolve(username === 'e2e-alice'),
      getUserId: () => Promise.resolve(null),
    });
    const { said, emit } = recorder();
    expect(await postready.runPostReady(e2eeMeta(), AUTH, emit, { sleep: noSleep })).toEqual([
      'e2ee_users',
    ]);
    expect(said.join(' ')).toContain('could not create the E2EE test users e2e-bob, e2e-carol');
  });
});

describe('the voice test users', () => {
  afterEach(() => {
    jest.resetModules();
  });

  function voiceMeta(extensions: boolean): ReturnType<typeof meta> {
    const m = meta({ preset: 'voice' });
    m.extra.post_ready = [{ action: 'voice_users', extensions }];
    return m;
  }

  it('creates voice-alice and voice-bob, and gives no extension without SIP', async () => {
    const made: string[] = [];
    const extended: string[] = [];
    const postready = withRcapi({
      createUser: (_u: string, _a: unknown, _p: string, username: string) => {
        made.push(username);
        return Promise.resolve(true);
      },
      getUserId: () => Promise.resolve(null),
      setVoiceExtension: (_u: string, _a: unknown, _p: string, id: string) => {
        extended.push(id);
        return Promise.resolve(true);
      },
    });
    const { said, emit } = recorder();
    expect(await postready.runPostReady(voiceMeta(false), AUTH, emit, { sleep: noSleep })).toEqual(
      [],
    );
    expect([made, extended]).toEqual([['voice-alice', 'voice-bob'], []]);
    expect(said.join(' ')).toContain('Voice test users ready: voice-alice, voice-bob');
  });

  it('with SIP gives voice-alice 1001 and voice-bob 1002', async () => {
    const extended: string[] = [];
    const postready = withRcapi({
      createUser: () => Promise.resolve(true),
      getUserId: (_u: string, _a: unknown, username: string) => Promise.resolve(`${username}-id`),
      setVoiceExtension: (_u: string, _a: unknown, _p: string, id: string, ext: string) => {
        extended.push(`${id}=${ext}`);
        return Promise.resolve(true);
      },
    });
    const { said, emit } = recorder();
    expect(await postready.runPostReady(voiceMeta(true), AUTH, emit, { sleep: noSleep })).toEqual(
      [],
    );
    expect(extended).toEqual(['voice-alice-id=1001', 'voice-bob-id=1002']);
    expect(said.join(' ')).toContain('voice-alice has extension 1001, voice-bob 1002');
  });

  it('warns, and does not fail, when Rocket.Chat refuses the extensions (no Voice licence)', async () => {
    // An extension can be set only while SIP integration is on, which needs the Voice add-on.
    const postready = withRcapi({
      createUser: () => Promise.resolve(true),
      getUserId: (_u: string, _a: unknown, username: string) => Promise.resolve(`${username}-id`),
      setVoiceExtension: () => Promise.resolve(false),
    });
    const { said, emit } = recorder();
    expect(await postready.runPostReady(voiceMeta(true), AUTH, emit, { sleep: noSleep })).toEqual(
      [],
    );
    expect(said.join(' ')).toContain('could not give voice-alice, voice-bob their extensions');
    // Once licensed, `ready` runs this action again and sets them.
    expect(said.join(' ')).toContain('then run houston ready --name w');
  });

  it('is a failure naming the users that could not be made', async () => {
    const postready = withRcapi({
      createUser: (_u: string, _a: unknown, _p: string, username: string) =>
        Promise.resolve(username === 'voice-alice'),
      getUserId: () => Promise.resolve(null),
    });
    const { said, emit } = recorder();
    expect(await postready.runPostReady(voiceMeta(false), AUTH, emit, { sleep: noSleep })).toEqual([
      'voice_users',
    ]);
    expect(said.join(' ')).toContain('could not create the Voice test users voice-bob');
  });
});

describe('the keycloak action reads its fields the way earlier releases do', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('keys the service and port defaults on PRESENCE, not on truthiness', async () => {
    // A field that is PRESENT is used even when it is falsy, where
    // `value || fallback` would silently substitute the default -- so a preset that
    // deliberately wrote an empty service name would reach a different container.
    jest.resetModules();
    const calls: { service: string; argv: readonly string[] }[] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExec: (_n: string, service: string, argv: readonly string[]) => {
        calls.push({ service, argv });
        return Promise.resolve(0);
      },
    }));
    const postready = require('../../src/core/postready') as typeof ModNS;
    const m = meta();
    m.extra.post_ready = [{ action: 'keycloak_master_ssl_off', service: '', port: 0 }];
    await postready.runPostReady(m, AUTH, recorder().emit, { sleep: noSleep });
    expect(calls[0]?.service).toBe('');
    expect(calls[0]?.argv[2]).toContain('http://localhost:0');
  });

  it('uses keycloak and 8080 when the fields are absent', async () => {
    jest.resetModules();
    const calls: { service: string; argv: readonly string[] }[] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExec: (_n: string, service: string, argv: readonly string[]) => {
        calls.push({ service, argv });
        return Promise.resolve(0);
      },
    }));
    const postready = require('../../src/core/postready') as typeof ModNS;
    const m = meta();
    m.extra.post_ready = [{ action: 'keycloak_master_ssl_off' }];
    await postready.runPostReady(m, AUTH, recorder().emit, { sleep: noSleep });
    expect(calls[0]?.service).toBe('keycloak');
    expect(calls[0]?.argv[2]).toContain('http://localhost:8080');
  });
});

describe('Keycloak under a path', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('is configured at that path, where it now answers', async () => {
    jest.resetModules();
    const seen: string[][] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExec: (_name: string, _svc: string, argv: string[]) => {
        seen.push(argv);
        return Promise.resolve(0);
      },
    }));
    const postready = require('../../src/core/postready') as typeof ModNS;
    const m = metadata({ name: 'kc', project: 'houston-kc' });
    const { emit } = recorder();
    await postready.POST_READY_ACTIONS.keycloak_master_ssl_off?.(
      m,
      { base: 'http://localhost:3000', userId: 'u', token: 't' } as never,
      { action: 'keycloak_master_ssl_off', path: '/keycloak' },
      emit,
      noSleep,
    );
    expect(seen[0]?.[2]).toContain('--server http://localhost:8080/keycloak ');
  });
});

describe('the webhooks preset wires the inbox, and says what it captured', () => {
  afterEach(() => {
    jest.resetModules();
  });

  /** The session the receiver's API hands out here, and the JSON it is made to answer. */
  const SESSION = 'ses-1';
  const ANSWER = Buffer.from('{"captured":true}').toString('base64');
  const RECEIVER = `http://webhooks:8080/${SESSION}`;
  const INBOX = `http://127.0.0.1:8086/s/${SESSION}`;
  const ON = ['Livechat_webhook_on_start', 'Livechat_webhook_on_close'];
  const EVENTS = [
    'start',
    'close',
    'chat_taken',
    'chat_queued',
    'forward',
    'offline_msg',
    'visitor_message',
    'agent_message',
  ].map((event) => `Livechat_webhook_on_${event}`);

  function whMeta(capture = 'off', hooks?: Record<string, unknown>): Metadata {
    const m = meta({ preset: 'webhooks', rootUrl: 'http://127.0.0.1:3000' });
    // The two origins: the session is made in the action, and the record carries its id.
    m.extra.post_ready = [
      {
        action: 'webhooks_setup',
        receiver: 'http://webhooks:8080',
        ui_url: 'http://localhost:8086',
        capture,
      },
    ];
    if (hooks !== undefined) m.extra.webhooks = hooks;
    return m;
  }

  /** The receiver's own API as the inbox answers it: sessions by uuid, one made on POST. */
  function inboxApi(
    sessions: Record<string, string | readonly [number, string]> = { '*': ANSWER },
    made = SESSION,
  ) {
    const posted: unknown[] = [];
    const call = (_root: string, method: string, p: string, opts?: { data?: unknown }) => {
      if (method === 'POST' && p === '/api/session') {
        posted.push(opts?.data);
        return Promise.resolve([200, JSON.stringify({ uuid: made })]);
      }
      const got = /^\/api\/session\/([^/]+)$/u.exec(p);
      if (got === null) return Promise.resolve([200, '']);
      const found = sessions[got[1] as string] ?? sessions['*'];
      if (found === undefined) return Promise.resolve([404, '{}']);
      const [status_code, body] = typeof found === 'string' ? [200, found] : found;
      return Promise.resolve([
        200,
        JSON.stringify({ uuid: got[1], response: { status_code, response_body_base64: body } }),
      ]);
    };
    return { posted, call };
  }

  /** rcapi as a fresh workspace answers it; `settings` overrides what getSetting says per id. */
  function stub(
    settings: Record<string, unknown> = {},
    over: Record<string, unknown> = {},
    inbox = inboxApi(),
  ) {
    const set: [string, unknown][] = [];
    const repointed: [unknown, unknown][] = [];
    const warmed: string[] = [];
    const answers: Record<string, unknown> = {
      createOutgoingWebhook: () => Promise.resolve('o1'),
      createIncomingWebhook: () => Promise.resolve('/hooks/i1/t1'),
      getSetting: (_u: string, _a: unknown, _p: string, id: string) =>
        Promise.resolve(
          id in settings ? settings[id] : id.startsWith('Livechat_webhook_on_') ? false : '',
        ),
      setSetting: (_u: string, _a: unknown, _p: string, id: string, value: unknown) => {
        set.push([id, value]);
        return Promise.resolve(true);
      },
      settingIds: () => Promise.resolve(new Set([...ON, 'Livechat_webhook_on_capture', 'Other'])),
      listIntegrations: () => Promise.resolve([]),
      updateOutgoingUrls: (
        _u: string,
        _a: unknown,
        _p: string,
        doc: Record<string, unknown>,
        urls: string[],
      ) => {
        repointed.push([doc.name, urls]);
        return Promise.resolve(true);
      },
      call: (root: string, method: string, p: string, opts?: { data?: unknown }) => {
        if (p.startsWith('/api/session')) return inbox.call(root, method, p, opts);
        warmed.push(`${root}${p}`);
        return Promise.resolve([200, '']);
      },
      ...over,
    };
    return { answers, set, repointed, warmed, posted: inbox.posted };
  }

  /** The module with rcapi stubbed and `updateMeta` writing into `m` itself. */
  function load(m: Metadata, answers: Record<string, unknown>) {
    return withRcapi(answers, {
      '../../src/core/runner/record': () => ({
        ...(jest.requireActual('../../src/core/runner/record') as object),
        updateMeta: (_name: string, mutate: (meta: Metadata) => void) => {
          mutate(m);
          return Promise.resolve(m);
        },
      }),
    });
  }

  it('makes both sample integrations, wires the Omnichannel webhook and records the hook', async () => {
    const m = whMeta();
    const { answers, set, warmed } = stub();
    const postready = load(m, answers);
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
    expect(m.extra.webhooks).toEqual({
      session: SESSION,
      incoming: '/hooks/i1/t1',
      outgoing_name: 'houston-outgoing',
      omnichannel: `${RECEIVER}/omnichannel`,
      captured: [],
    });
    expect(set).toEqual([
      ['Livechat_webhookUrl', `${RECEIVER}/omnichannel`],
      ['Livechat_secret_token', 'houston'],
      // Every switch the known list names, whatever the (possibly short) settings list says.
      ...EVENTS.map((id) => [id, true]),
      ['SSRF_Allowlist', 'webhooks'],
    ]);
    // Made through the API, the session needs no request to exist.
    expect(warmed).toEqual([]);
    const joined = said.join('\n');
    expect(joined).toContain(INBOX);
    expect(joined).toContain('houston info --name w');
    // The hook token is for `info`, not for every log line.
    expect(joined).not.toContain('t1');
  });

  /** `createOutgoingWebhook` as a spy: what post-ready asked it to make. */
  function creating(created: unknown[]) {
    return {
      createOutgoingWebhook: (_u: string, _a: unknown, _p: string, options: unknown) => {
        created.push(options);
        return Promise.resolve('o1');
      },
    };
  }

  it('makes the inbox session itself, with a JSON answer Rocket.Chat reads as success', async () => {
    // The receiver's auto-created session answers 200 with an EMPTY body, and Rocket.Chat
    // treats an empty body as a failed call: four retries per message, and the History tab
    // reading too-many-retries. A session made through the API carries a body.
    const m = whMeta();
    const created: unknown[] = [];
    const { answers, set, posted } = stub({}, creating(created));
    const postready = load(m, answers);
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
    expect(posted).toEqual([
      {
        status_code: 200,
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        delay: 0,
        response_body_base64: ANSWER,
      },
    ]);
    expect(created).toEqual([{ name: 'houston-outgoing', urls: [`${RECEIVER}/outgoing`] }]);
    expect(set).toContainEqual(['Livechat_webhookUrl', `${RECEIVER}/omnichannel`]);
    expect(m.extra.webhooks).toMatchObject({ session: SESSION });
    // On the port the preset published, at the address houston reaches the workspace by.
    expect(said.join('\n')).toContain(INBOX);
  });

  it('keeps the recorded session while it still answers as the inbox', async () => {
    const m = whMeta('off', { session: 'ses-0' });
    const created: unknown[] = [];
    const { answers, set, posted } = stub({}, creating(created), inboxApi({ 'ses-0': ANSWER }));
    const postready = load(m, answers);
    const { emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
    expect(posted).toEqual([]);
    expect(created).toEqual([
      { name: 'houston-outgoing', urls: ['http://webhooks:8080/ses-0/outgoing'] },
    ]);
    expect(set).toContainEqual(['Livechat_webhookUrl', 'http://webhooks:8080/ses-0/omnichannel']);
    expect(m.extra.webhooks).toMatchObject({ session: 'ses-0' });
  });

  it('adopts the session the sample integration still posts to when the record forgot it', async () => {
    // `up --force` rebuilds `extra`, and the volume keeps the session: a second one would
    // split the inbox in two, the link on one and the integrations on the other.
    const m = whMeta();
    const listed = [
      {
        name: 'houston-outgoing',
        type: 'webhook-outgoing',
        urls: ['http://webhooks:8080/ses-0/outgoing'],
      },
    ];
    const { answers, set, posted, repointed } = stub(
      {},
      { listIntegrations: () => Promise.resolve(listed) },
      inboxApi({ 'ses-0': ANSWER }),
    );
    const postready = load(m, answers);
    const { emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
    expect(posted).toEqual([]);
    expect(repointed).toEqual([]);
    expect(set).toContainEqual(['Livechat_webhookUrl', 'http://webhooks:8080/ses-0/omnichannel']);
    expect(m.extra.webhooks).toMatchObject({ session: 'ses-0' });
  });

  it("replaces a session the receiver lost or made by itself, and repoints what used it; an engineer's own stays", async () => {
    const lost = {
      name: 'houston-outgoing',
      type: 'webhook-outgoing',
      urls: ['http://webhooks:8080/ses-0/outgoing'],
    };
    const done = {
      name: 'Done',
      type: 'webhook-outgoing',
      urls: ['http://webhooks:8080/ses-0/captured/Done?from=https%3A%2F%2Fold.example.com%2Fx'],
    };
    // Made in the inbox UI with a 500: it answers, as it was told to, and is nobody's to move.
    const mine = { name: 'Mine', type: 'webhook-outgoing', urls: ['http://webhooks:8080/other/x'] };
    for (const inbox of [
      inboxApi({ other: [500, ''] }), // ses-0 gone
      inboxApi({ 'ses-0': '', other: [500, ''] }), // ses-0 auto-created: 200 and nothing else
    ]) {
      const m = whMeta('off', { session: 'ses-0' });
      const { answers, set, posted, repointed } = stub(
        { Livechat_webhookUrl: 'http://webhooks:8080/ses-0/omnichannel' },
        { listIntegrations: () => Promise.resolve([lost, done, mine]) },
        inbox,
      );
      const postready = load(m, answers);
      const { emit } = recorder();
      expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
      expect(posted).toHaveLength(1);
      expect(repointed).toEqual([
        ['houston-outgoing', [`${RECEIVER}/outgoing`]],
        ['Done', [`${RECEIVER}/captured/Done?from=https%3A%2F%2Fold.example.com%2Fx`]],
      ]);
      expect(set).toContainEqual(['Livechat_webhookUrl', `${RECEIVER}/omnichannel`]);
      expect(m.extra.webhooks).toMatchObject({
        session: SESSION,
        omnichannel: `${RECEIVER}/omnichannel`,
        captured: [
          { name: 'Done', from: ['https://old.example.com/x'] },
          { name: 'Mine', from: [] },
        ],
      });
    }
  });

  it("wires nothing while the inbox's API cannot be reached, and says what to run", async () => {
    // The auto-created session would bring the retries back: better nothing than that.
    const m = whMeta();
    const created: unknown[] = [];
    const { answers, set } = stub(
      {},
      {
        ...creating(created),
        call: () => Promise.reject(new Error('ECONNREFUSED')),
      },
    );
    const postready = load(m, answers);
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([
      'webhooks_setup',
    ]);
    expect(created).toEqual([]);
    expect(set).toEqual([]);
    expect(m.extra.webhooks).toBeUndefined();
    const joined = said.join('\n');
    expect(joined).toContain('http://127.0.0.1:8086');
    expect(joined).toContain('houston ready --name w');
  });

  it('accepts the action the first build recorded, a fixed session in both addresses', async () => {
    const m = whMeta();
    const fixed = '11111111-1111-4111-8111-111111111111';
    m.extra.post_ready = [
      {
        action: 'webhooks_setup',
        receiver: `http://webhooks:8080/${fixed}`,
        ui_url: `http://localhost:8086/s/${fixed}`,
        capture: 'off',
      },
    ];
    const created: unknown[] = [];
    const { answers, posted } = stub({}, creating(created));
    const postready = load(m, answers);
    const { emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(created).toEqual([{ name: 'houston-outgoing', urls: [`${RECEIVER}/outgoing`] }]);
  });

  it("leaves an engineer's repoint to another inbox session alone", async () => {
    const m = whMeta();
    const { answers, set } = stub({ Livechat_webhookUrl: 'http://webhooks:8080/other-uuid/x' });
    const postready = load(m, answers);
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
    expect(set.map(([id]) => id)).not.toContain('Livechat_webhookUrl');
    expect(set.map(([id]) => id)).toContain('Livechat_secret_token');
    expect(said.join('\n')).not.toContain('replaced');
    expect((m.extra.webhooks as { omnichannel: string }).omnichannel).toBe(
      'http://webhooks:8080/other-uuid/x',
    );
  });

  it("leaves a customer's Omnichannel webhook where it is by default, and says how to capture it", async () => {
    const m = whMeta();
    const { answers, set } = stub({ Livechat_webhookUrl: 'https://crm.example.com/hook' });
    const postready = load(m, answers);
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
    // Nothing of the customer's webhook is widened: no new events to their CRM.
    expect(set.map(([id]) => id).filter((id) => id.startsWith('Livechat_'))).toEqual([]);
    expect(set.map(([id]) => id)).toContain('SSRF_Allowlist');
    const joined = said.join('\n');
    expect(joined).toContain('crm.example.com');
    expect(joined).toContain('capture=all');
    expect((m.extra.webhooks as { omnichannel: string }).omnichannel).toBe(
      'https://crm.example.com/hook',
    );
  });

  it('replaces it with capture=all, naming what it was', async () => {
    const m = whMeta('all');
    const { answers, set } = stub({ Livechat_webhookUrl: 'https://crm.example.com/hook' });
    const postready = load(m, answers);
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
    expect(set).toEqual(
      expect.arrayContaining([
        // The customer's URL rides along in ?from=, as a captured integration's does.
        [
          'Livechat_webhookUrl',
          `${RECEIVER}/omnichannel?from=https%3A%2F%2Fcrm.example.com%2Fhook`,
        ],
        ['Livechat_secret_token', 'houston'],
      ]),
    );
    expect(said.join('\n')).toContain('https://crm.example.com/hook');
    expect((m.extra.webhooks as { omnichannel: string }).omnichannel).toBe(
      `${RECEIVER}/omnichannel?from=https%3A%2F%2Fcrm.example.com%2Fhook`,
    );
  });

  it('leaves the Omnichannel webhook alone when its URL could not be read', async () => {
    // null is "could not read", not "empty": writing over a URL nobody saw could replace
    // a customer's without a word.
    const m = whMeta();
    const { answers, set } = stub({ Livechat_webhookUrl: null });
    const postready = load(m, answers);
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([
      'webhooks_setup',
    ]);
    expect(set.map(([id]) => id).filter((id) => id.startsWith('Livechat_'))).toEqual([]);
    expect(said.join('\n')).toContain('could not read');
  });

  it('switches the events on from its own list when the settings list is short or absent', async () => {
    // settings?count=0 is capped on a workspace without API_Allow_Infinite_Count: a list
    // that lacks the switches must not mean "this version has none".
    for (const settingIds of [
      () => Promise.resolve(null),
      () => Promise.resolve(new Set(['Other'])),
    ]) {
      const m = whMeta();
      const { answers, set } = stub({}, { settingIds });
      const postready = load(m, answers);
      const { emit } = recorder();
      expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
      expect(set.map(([id]) => id)).toEqual(expect.arrayContaining(EVENTS));
    }
  });

  it('sets the token where a version stores false for an empty one', async () => {
    const m = whMeta();
    const { answers, set } = stub({ Livechat_secret_token: false });
    const postready = load(m, answers);
    const { emit } = recorder();
    await postready.runPostReady(m, AUTH, emit, { sleep: noSleep });
    expect(set).toContainEqual(['Livechat_secret_token', 'houston']);
  });

  it('sets only what is off or empty, and skips a setting this version lacks', async () => {
    const m = whMeta();
    const { answers, set } = stub({
      Livechat_secret_token: 'abc',
      ...Object.fromEntries(EVENTS.map((id) => [id, true])),
      Livechat_webhook_on_close: null,
      SSRF_Allowlist: 'webhooks\nfoo.internal',
    });
    const postready = load(m, answers);
    const { emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
    expect(set).toEqual([['Livechat_webhookUrl', `${RECEIVER}/omnichannel`]]);
  });

  it('appends the inbox to an allowlist that names other hosts', async () => {
    const m = whMeta();
    const { answers, set } = stub({ SSRF_Allowlist: 'foo.internal' });
    const postready = load(m, answers);
    const { emit } = recorder();
    await postready.runPostReady(m, AUTH, emit, { sleep: noSleep });
    expect(set).toContainEqual(['SSRF_Allowlist', 'foo.internal\nwebhooks']);
  });

  const LISTED = [
    { name: 'houston-outgoing', type: 'webhook-outgoing', urls: [`${RECEIVER}/outgoing`] },
    {
      name: 'Jira',
      type: 'webhook-outgoing',
      urls: ['https://jira.example.com/hook'],
      scriptEnabled: true,
      script: 'class Script {}',
    },
    {
      name: 'Done',
      type: 'webhook-outgoing',
      urls: [`${RECEIVER}/captured/Done?from=https%3A%2F%2Fold.example.com%2Fx`],
    },
  ];

  it('with capture=all repoints every outgoing integration that still posts elsewhere, keeping the original in the URL', async () => {
    const m = whMeta('all');
    const { answers, repointed } = stub({}, { listIntegrations: () => Promise.resolve(LISTED) });
    const postready = load(m, answers);
    const { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
    expect(repointed).toEqual([
      ['Jira', [`${RECEIVER}/captured/Jira?from=https%3A%2F%2Fjira.example.com%2Fhook`]],
    ]);
    expect((m.extra.webhooks as { captured: unknown }).captured).toEqual([
      { name: 'Jira', from: ['https://jira.example.com/hook'] },
      { name: 'Done', from: ['https://old.example.com/x'] },
    ]);
    const joined = said.join('\n');
    expect(joined).toContain("repointed 'Jira'");
    // A re-saved script runs as written from 9.0.0: the one thing a repoint can change.
    expect(joined).toContain('strict mode');
  });

  it('with capture off repoints nothing, and still lists what an earlier run captured', async () => {
    const m = whMeta();
    const { answers, repointed } = stub({}, { listIntegrations: () => Promise.resolve(LISTED) });
    const postready = load(m, answers);
    const { emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([]);
    expect(repointed).toEqual([]);
    expect((m.extra.webhooks as { captured: unknown }).captured).toEqual([
      { name: 'Done', from: ['https://old.example.com/x'] },
    ]);
  });

  it('is only partly configured when a sample integration, a setting or a repoint is refused', async () => {
    const refusedCreate = stub({}, { createOutgoingWebhook: () => Promise.resolve(null) });
    let m = whMeta();
    let postready = load(m, refusedCreate.answers);
    let { said, emit } = recorder();
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([
      'webhooks_setup',
    ]);
    expect(said.join('\n')).toContain('houston-outgoing');

    const refusedSetting = stub({}, { setSetting: () => Promise.resolve(false) });
    m = whMeta();
    postready = load(m, refusedSetting.answers);
    ({ said, emit } = recorder());
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([
      'webhooks_setup',
    ]);
    expect(said.join('\n')).toContain('Livechat_webhookUrl');

    const refusedRepoint = stub(
      {},
      {
        listIntegrations: () => Promise.resolve(LISTED),
        updateOutgoingUrls: () => Promise.resolve(false),
      },
    );
    m = whMeta('all');
    postready = load(m, refusedRepoint.answers);
    ({ said, emit } = recorder());
    expect(await postready.runPostReady(m, AUTH, emit, { sleep: noSleep })).toEqual([
      'webhooks_setup',
    ]);
    expect(said.join('\n')).toContain('Jira');
  });
});
