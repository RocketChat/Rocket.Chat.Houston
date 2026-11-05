/**
 * `web/routes/repros`: workspaces over HTTP -- create, inspect, act on, hand over, destroy.
 *
 * `repros-call`, `repros-version` and `validation` hold the create prefetch, the create label,
 * the API console's null body, and body validation. Everything else is here: ownership, the
 * cross-site refusal, attribution, the API console's confinement to its own workspace, env,
 * TLS, the engine-down statuses.
 *
 * Seams are replaced at the module earlier releases' tests patched, and each one is reset to its
 * default before every case: `clearMocks` keeps an implementation a case installed, so a
 * stub one case sets would otherwise answer for the next.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { AUDIT_FILE } from '../../../src/core/audit';
import { event } from '../../../src/lib/events';
import * as admin from '../../../src/core/lifecycle/admin';
import * as createDocker from '../../../src/core/lifecycle/create-docker';
import * as destroy from '../../../src/core/lifecycle/destroy';
import { deriveFor } from '../../../src/core/lifecycle/naming';
import * as inspect from '../../../src/core/lifecycle/inspect';
import * as payload from '../../../src/core/lifecycle/payload';
import * as state from '../../../src/core/lifecycle/state';
import { CREATE_POLICY_KEY, DESTROY_POLICY_KEY } from '../../../src/core/lifecycle/types';
import * as envvars from '../../../src/core/envvars';
import { CONTEXT } from '../../../src/core/kube/names';
import * as kubeStatus from '../../../src/core/kube/status';
import * as rcapi from '../../../src/core/rcapi';
import * as engine from '../../../src/core/runner/engine';
import * as host from '../../../src/core/runner/host';
import * as queries from '../../../src/core/runner/queries';
import * as record from '../../../src/core/runner/record';
import * as sessions from '../../../src/core/sessions';
import * as tls from '../../../src/core/tls';
import * as topology from '../../../src/core/topology';
import * as users from '../../../src/core/users';
import * as config from '../../../src/lib/config';
import {
  AuthorityGateError,
  ConflictError,
  CreateFailedError,
  DockerError,
  GATE_CODES,
  NotFoundError,
  NotReadyError,
  PreflightError,
  ValidationError,
} from '../../../src/lib/errors';
import { runCli, type CliIo } from '../../../src/cli/app';
import { createExecutor } from '../../../src/cli/handlers';
import { createApp } from '../../../src/web/app';
import { COOKIE_PLAIN } from '../../../src/web/security';

import type * as PolicyNS from '../../testsetup-policy';
import type * as RecordNS from '../../../src/core/runner/record';
import type * as EnvvarsNS from '../../../src/core/envvars';

jest.mock('../../../src/core/lifecycle/naming', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/naming'),
  resolveName: jest.fn(async (name: string) => name),
}));
jest.mock('../../../src/core/lifecycle/inspect', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/inspect'),
  listRepros: jest.fn(),
  describe: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/payload', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/payload'),
  detail: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/create-docker', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/create-docker'),
  createRepro: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/destroy', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/destroy'),
  teardown: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/state', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/state'),
  setState: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/admin', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/admin'),
  login: jest.fn(),
}));
jest.mock('../../../src/core/runner/engine', () => ({
  ...jest.requireActual('../../../src/core/runner/engine'),
  containerIds: jest.fn(),
}));
jest.mock('../../../src/core/runner/queries', () => ({
  ...jest.requireActual('../../../src/core/runner/queries'),
  dockerStats: jest.fn(),
}));
jest.mock('../../../src/core/runner/record', () => ({
  ...jest.requireActual('../../../src/core/runner/record'),
  readMeta: jest.fn(),
}));
// OWNED: the engine-down case says so. Healthy otherwise, as the suite's engine is.
jest.mock('../../../src/core/runner/host', () => ({
  ...(require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
  dockerAvailable: jest.fn(),
}));
jest.mock('../../../src/core/rcapi', () => ({
  ...jest.requireActual('../../../src/core/rcapi'),
  generatePat: jest.fn(),
  call: jest.fn(),
  releaseInfo: jest.fn(),
  releasesReachable: jest.fn(),
}));
jest.mock('../../../src/core/tls', () => ({
  ...jest.requireActual('../../../src/core/tls'),
  verify: jest.fn(),
}));
jest.mock('../../../src/core/envvars', () => ({
  ...jest.requireActual('../../../src/core/envvars'),
  current: jest.fn(),
  setEnv: jest.fn(),
}));
jest.mock('../../../src/core/kube/status', () => ({
  ...jest.requireActual('../../../src/core/kube/status'),
  podMetrics: jest.fn(),
  containerEnv: jest.fn(),
}));

const realRecord = jest.requireActual<typeof RecordNS>('../../../src/core/runner/record');
const realEnvvars = jest.requireActual<typeof EnvvarsNS>('../../../src/core/envvars');

/** Every seam back to its default, before every case. */
function defaults(): void {
  jest.mocked(inspect.listRepros).mockReset().mockResolvedValue([]);
  jest.mocked(inspect.describe).mockReset();
  jest.mocked(payload.detail).mockReset();
  jest
    .mocked(createDocker.createRepro)
    .mockReset()
    .mockResolvedValue({ name: 'x' } as never);
  jest
    .mocked(state.setState)
    .mockReset()
    .mockResolvedValue(undefined as never);
  jest
    .mocked(destroy.teardown)
    .mockReset()
    .mockImplementation(async (name: string) => ({ name, removed: false }));
  jest
    .mocked(admin.login)
    .mockReset()
    .mockResolvedValue({ token: 't1', userId: 'u1' } as never);
  jest.mocked(engine.containerIds).mockReset();
  jest.mocked(queries.dockerStats).mockReset();
  jest.mocked(record.readMeta).mockReset().mockImplementation(realRecord.readMeta);
  jest.mocked(host.dockerAvailable).mockReset().mockResolvedValue(true);
  jest.mocked(rcapi.generatePat).mockReset();
  jest.mocked(rcapi.call).mockReset();
  jest.mocked(rcapi.releaseInfo).mockReset().mockResolvedValue(null);
  jest.mocked(rcapi.releasesReachable).mockReset().mockResolvedValue(null);
  jest.mocked(tls.verify).mockReset();
  jest.mocked(envvars.current).mockReset().mockImplementation(realEnvvars.current);
  jest
    .mocked(envvars.setEnv)
    .mockReset()
    .mockImplementation(
      async (name: string) => ({ name, restarted: true, overrides: [] }) as never,
    );
  jest.mocked(kubeStatus.podMetrics).mockReset();
  jest.mocked(kubeStatus.containerEnv).mockReset();
}

const PASSWORD = 'correct-horse-battery';
const CROSS = { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' };

let home = '';
let app: FastifyInstance;
let cookie = '';

async function signIn(user: string, password = PASSWORD): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/session',
    payload: { user, password },
    headers: { host: 'localhost' },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}

/** Become `user`, creating the account with `role` first when it does not exist. */
async function as(
  user: string,
  role = 'member',
  password = 'a-good-enough-password',
): Promise<void> {
  if (!users.listUsers().some((row) => row.name === user)) await users.add(user, password, role);
  cookie = await signIn(user, password);
}

const headers = (extra: Record<string, string> = {}) => ({ host: 'localhost', cookie, ...extra });
const get = (url: string, extra: Record<string, string> = {}) =>
  app.inject({ url, headers: headers(extra) });
const post = (url: string, body?: unknown, extra: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url,
    ...(body === undefined ? {} : { payload: body as object }),
    headers: headers(extra),
  });
const del = (url: string, extra: Record<string, string> = {}) =>
  app.inject({ method: 'DELETE', url, headers: headers(extra) });

/** A workspace record on disk, created by `owner`, as earlier releases' web helpers made one. */
async function workspace(
  name: string,
  owner: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await realRecord.write(
    name,
    'services: {}\n',
    realRecord.metadata({
      name,
      project: `houston-${name}`,
      rcVersion: '8.5.1',
      rcImage: 'i',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3000',
      hostPort: 3000,
      versionSource: 'map',
      extra: { created_by: owner, ...extra },
    }),
  );
}

/** The console's target: a workspace answering at http://x:3000, as `_stub_call_target`. */
function callTarget(): void {
  jest
    .mocked(record.readMeta)
    .mockResolvedValue(
      realRecord.metadata({ name: 'x', rootUrl: 'http://x:3000', extra: {} }) as never,
    );
}

beforeEach(async () => {
  defaults();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-repros-route-'));
  process.env.HOUSTON_HOME = home;
  await users.add('alice', PASSWORD, 'admin');
  app = await createApp({ accounts: true });
  await app.ready();
  cookie = await signIn('alice');
});
afterEach(async () => {
  await app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('reading workspaces', () => {
  it('needs a session, and answers the list once there is one', async () => {
    expect(
      (await app.inject({ url: '/api/repros', headers: { host: 'localhost' } })).statusCode,
    ).toBe(401);
    // The authorised half is a real assertion: it used to be `== 200 or True`.
    expect((await get('/api/repros')).statusCode).toBe(200);
  });

  it('lists what the service answers', async () => {
    jest.mocked(inspect.listRepros).mockResolvedValue([{ name: 'x', state: 'running' }] as never);
    const response = await get('/api/repros');
    expect(response.statusCode).toBe(200);
    expect(response.json().repros[0].name).toBe('x');
  });

  it('maps a ReproError onto its HTTP status', async () => {
    jest.mocked(inspect.describe).mockRejectedValue(new NotFoundError('no such repro'));
    const response = await get('/api/repros/ghost');
    expect(response.statusCode).toBe(404);
    expect(response.json().kind).toBe('NotFoundError');
  });

  it('serves the detail payload, and stats summed over the rocketchat containers', async () => {
    jest.mocked(payload.detail).mockImplementation(
      async (name: string) =>
        ({
          name,
          state: 'running',
          uptime: '2 hours',
          containers: [],
          env: [],
          links: [],
        }) as never,
    );
    const detail = await get('/api/repros/x/detail');
    expect(detail.statusCode).toBe(200);
    expect(detail.json().uptime).toBe('2 hours');
    jest.mocked(engine.containerIds).mockResolvedValue(['c1']);
    jest
      .mocked(queries.dockerStats)
      .mockResolvedValue('houston-x-rocketchat-1\t120.0%\t900MiB / 8GiB');
    const stats = await get('/api/repros/x/stats');
    expect(stats.statusCode).toBe(200);
    expect(stats.json().cpu).toBe(120);
    expect(stats.json().mem_mb).toBeGreaterThan(900);
  });

  it('answers stats for a Kubernetes workspace from the pods, never from docker', async () => {
    // `kubectl top`, summed over every Rocket.Chat pod so replicas count the way compose
    // instances do; the payload keys are unchanged because the GUI renders from them.
    const meta = realRecord.metadata({
      name: 'k',
      rcVersion: '8.6.1',
      hostPort: 3010,
      extra: { context: CONTEXT },
    });
    topology.stamp(meta.extra, topology.KUBERNETES);
    await realRecord.write('k', 'services: {}\n', meta);
    jest
      .mocked(engine.containerIds)
      .mockRejectedValue(new Error('docker was reached for a Kubernetes workspace'));
    jest.mocked(kubeStatus.podMetrics).mockResolvedValue([
      { pod: 'rocketchat-a', cpu_millicores: 150, mem_bytes: 400e6 },
      { pod: 'rocketchat-b', cpu_millicores: 50, mem_bytes: 200e6 },
    ] as never);
    const response = await get('/api/repros/k/stats');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ cpu: 20, mem_mb: 600 });
    expect(engine.containerIds).not.toHaveBeenCalled();
  });

  it('answers env for a Kubernetes workspace from the running container, masked', async () => {
    // It threw a bare ENOENT, so `serve` answered 500; then it refused with 400.
    const meta = realRecord.metadata({
      name: 'k',
      rcVersion: '8.6.1',
      hostPort: 3010,
      extra: { context: CONTEXT },
    });
    topology.stamp(meta.extra, topology.KUBERNETES);
    await realRecord.writeRecord('k', meta);
    expect(fs.existsSync(path.join(home, 'repros', 'k', 'docker-compose.yml'))).toBe(false);
    jest
      .mocked(kubeStatus.containerEnv)
      .mockResolvedValue({ ROOT_URL: 'http://localhost:3010', ADMIN_PASS: 'admin123' } as never);
    const response = await get('/api/repros/k/env');
    expect(response.statusCode).toBe(200);
    const values = Object.fromEntries(
      (response.json().env as { key: string; value: string }[]).map((row) => [row.key, row.value]),
    );
    expect(values.ROOT_URL).toBe('http://localhost:3010');
    // Credentials are masked over HTTP too.
    expect(values.ADMIN_PASS).not.toBe('admin123');
  });
});

describe('the error payload', () => {
  it('carries the stable code for every class, and keeps kind for anything reading it', async () => {
    // Renaming a class is a refactor; renaming a `code` is a breaking change -- so a caller
    // branching on `kind` was branching on the one field nobody had agreed not to move.
    const cases: [Error, number, string][] = [
      [new NotFoundError('gone'), 404, 'NOT_FOUND'],
      [new ValidationError('bad'), 400, 'VALIDATION_FAILED'],
      [new ConflictError('taken'), 409, 'CONFLICT'],
      [new NotReadyError('booting'), 409, 'NOT_READY'],
      [new DockerError('engine down'), 502, 'ENGINE_UNAVAILABLE'],
      [new PreflightError('no room'), 409, 'PREFLIGHT_FAILED'],
      [new CreateFailedError('dead'), 500, 'CREATE_FAILED'],
    ];
    for (const [error, status, code] of cases) {
      jest.mocked(payload.detail).mockRejectedValue(error);
      const response = await get('/api/repros/x/detail');
      expect({
        code,
        status: response.statusCode,
        published: response.json().code,
        kind: response.json().kind,
      }).toEqual({
        code,
        status,
        published: code,
        kind: error.constructor.name,
      });
    }
  });

  it('tells the caller what a human must run to clear a gate', async () => {
    jest.mocked(payload.detail).mockRejectedValue(
      new AuthorityGateError('the target cluster is not an approved one', {
        kind: 'cluster',
        subject: 'kind-houston',
        approveWith: 'houston doctor --approve-cluster kind-houston',
        code: 'GATE_UNAPPROVED_CLUSTER',
      }),
    );
    const response = await get('/api/repros/x/detail');
    expect(response.statusCode).toBe(403);
    const body = response.json();
    expect(body.code).toBe('GATE_UNAPPROVED_CLUSTER');
    // Gates are declared, not invented at the call site.
    expect(Object.keys(GATE_CODES)).toContain(body.code);
    expect(body.gate).toMatchObject({
      approve_with: 'houston doctor --approve-cluster kind-houston',
      subject: 'kind-houston',
    });
  });
});

describe('creating', () => {
  it('answers a job id', async () => {
    const response = await post('/api/repros', { version: '8.5.1', preset: 'default' });
    expect(response.statusCode).toBe(200);
    expect(String(response.json().job_id)).toMatch(/^job_/u);
  });

  it('ignores an unknown field rather than crashing on it', async () => {
    expect(
      (await post('/api/repros', { version: '8.5.1', bogus_field: 'drop me' })).statusCode,
    ).toBe(200);
    await app.jobs.drain();
    expect(jest.mocked(createDocker.createRepro).mock.calls[0]?.[0].version).toBe('8.5.1');
  });

  it('takes several presets as a list, spelled into the one canonical preset', async () => {
    const response = await post('/api/repros', {
      version: '8.5.1',
      presets: ['ldap', 'email'],
      params: { ldap: { users: 7 } },
    });
    expect(response.statusCode).toBe(200);
    await app.jobs.drain();
    const req = jest.mocked(createDocker.createRepro).mock.calls[0]?.[0];
    expect([req?.preset, req?.params]).toEqual(['email+ldap', { 'ldap.users': 7 }]);
  });

  it('refuses preset and presets together, a list that is not names, and a bad name', async () => {
    const both = await post('/api/repros', {
      version: '8.5.1',
      preset: 'ldap',
      presets: ['email'],
    });
    expect([both.statusCode, String(both.json().error)]).toEqual([
      400,
      'give `preset` or `presets`, not both',
    ]);
    expect((await post('/api/repros', { version: '8.5.1', presets: 'ldap' })).statusCode).toBe(400);
    const bad = await post('/api/repros', { version: '8.5.1', presets: ['ldap', '../evil'] });
    expect([bad.statusCode, String(bad.json().error)]).toEqual([
      400,
      expect.stringContaining('is not a preset name'),
    ]);
  });

  it('is a 400 without a version, not a 500', async () => {
    const missing = await post('/api/repros', { preset: 'default' });
    expect(missing.statusCode).toBe(400);
    expect(String(missing.json().error)).toContain('version');
    expect((await post('/api/repros', {})).statusCode).toBe(400);
  });

  it('refuses a path as a preset on the REQUEST, not inside the job', async () => {
    // The escape was already blocked, but the caller got 200 and a job to watch, and the
    // first attempt at this preflight answered 500.
    const refused = await post('/api/repros', {
      version: '8.5.1',
      preset: '/tmp/anything',
      name: 'escapi',
    });
    expect(refused.statusCode).toBe(400);
    expect(String(refused.json().error)).toContain('not a preset name');
    expect(refused.json()).not.toHaveProperty('job_id');
    for (const bad of ['../../etc/passwd', 'sub/dir', 'UPPER']) {
      const response = await post('/api/repros', { version: '8.5.1', preset: bad, name: 'x' });
      expect({ bad, status: response.statusCode }).toEqual({ bad, status: 400 });
    }
    // A REAL preset name still reaches the job, which is the half a blunt fix breaks.
    const real = await post('/api/repros', { version: '8.5.1', preset: 'ldap', name: 'ok' });
    expect(real.statusCode).toBe(200);
    expect(String(real.json().job_id)).toMatch(/^job_/u);
  });

  it('takes the actor from the session, never from the body', async () => {
    // Otherwise anyone could create a workspace in a colleague's namespace.
    expect((await post('/api/repros', { version: '8.5.1', actor: 'bob' })).statusCode).toBe(200);
    await app.jobs.drain();
    expect(jest.mocked(createDocker.createRepro).mock.calls[0]?.[0].actor).toBe('alice');
  });

  it('asks releases.rocket.chat nothing on the request: the create job looks it up', async () => {
    // The route fetched the release info before submitting the job, ahead of every refusal
    // the job makes, where earlier releases' create resolves INSIDE it, with the pairing.
    // The invalid version that went over the wire first was one case of it.
    expect((await post('/api/repros', { version: '8.5.1' })).statusCode).toBe(200);
    await app.jobs.drain();
    expect(rcapi.releaseInfo).not.toHaveBeenCalled();
    expect(jest.mocked(createDocker.createRepro).mock.calls[0]?.[2]).not.toHaveProperty(
      'versionFetcher',
    );
    await post('/api/repros', { version: 'nonsense' });
    expect(rcapi.releaseInfo).not.toHaveBeenCalled();
  });
});

describe('who may choose the image and the interface', () => {
  it('is everybody by default, because a member can already destroy data', async () => {
    // "You may destroy Maria's customer repro but not choose which interface your own
    // listens on" is not a security boundary, it is an inconsistent ladder.
    await as('bob');
    for (const [field, value] of [
      ['bind', '0.0.0.0'],
      ['rc_image', 'registry/rc:x'],
      ['reg_token', 'an-ee-licence'],
    ]) {
      const response = await post('/api/repros', { version: '8.5.1', [field as string]: value });
      expect({ field, status: response.statusCode }).toEqual({ field, status: 200 });
    }
    // ...and a box that wants the boundary still gets it.
    config.updateConfig((cfg) => {
      (cfg as Record<string, unknown>)[CREATE_POLICY_KEY] = 'admin';
    });
    expect((await post('/api/repros', { version: '8.5.1', bind: '0.0.0.0' })).statusCode).toBe(400);
  });

  it('is admins only once the box narrows it, and an admin is unaffected', async () => {
    // `rc_image` runs an arbitrary container as the serve user, `reg_token` is an EE licence
    // secret, and `bind` can publish fixed admin/admin123 credentials to the network.
    config.updateConfig((cfg) => {
      (cfg as Record<string, unknown>)[CREATE_POLICY_KEY] = 'admin';
    });
    await as('bob');
    for (const [field, value] of [
      ['rc_image', 'evil/image'],
      ['bind', '0.0.0.0'],
      ['reg_token', 'x'],
    ]) {
      const response = await post('/api/repros', { version: '8.5.1', [field as string]: value });
      expect({ field, status: response.statusCode }).toEqual({ field, status: 400 });
      expect(String(response.json().error)).toContain('admin');
    }
    expect((await post('/api/repros', { version: '8.5.1' })).statusCode).toBe(200);
    cookie = await signIn('alice');
    const everything = await post('/api/repros', {
      version: '8.5.1',
      bind: '0.0.0.0',
      rc_image: 'registry/rc:x',
      reg_token: 'tok',
      port: 3999,
    });
    expect(everything.statusCode).toBe(200);
  });

  it('takes a license as text, governed like the registration token', async () => {
    // The GUI pastes or reads the license; the create gets the TEXT, as `--license` reads it
    // from a file. Who may set it is the same policy as `reg_token`: anyone by default.
    await as('bob');
    expect(
      (await post('/api/repros', { version: '8.5.1', license: 'LICENSE-TEXT' })).statusCode,
    ).toBe(200);
    await app.jobs.drain();
    expect(jest.mocked(createDocker.createRepro).mock.calls[0]?.[0].license).toBe('LICENSE-TEXT');
    config.updateConfig((cfg) => {
      (cfg as Record<string, unknown>)[CREATE_POLICY_KEY] = 'admin';
    });
    const refused = await post('/api/repros', { version: '8.5.1', license: 'LICENSE-TEXT' });
    expect(refused.statusCode).toBe(400);
    expect(String(refused.json().error)).toContain('license is limited to admins');
    // The refusal names the field, never the license itself.
    expect(String(refused.json().error)).not.toContain('LICENSE-TEXT');
  });

  it('gates a CI build version as it gates rc_image: it picks unreleased code', async () => {
    config.updateConfig((cfg) => {
      (cfg as Record<string, unknown>)[CREATE_POLICY_KEY] = 'admin';
    });
    await as('bob');
    const refused = await post('/api/repros', { version: 'pr-42617' });
    expect(refused.statusCode).toBe(400);
    expect(String(refused.json().error)).toContain('a CI build version is limited to admins');
    cookie = await signIn('alice');
    expect((await post('/api/repros', { version: 'pr-42617' })).statusCode).toBe(200);
  });

  it('gates a VoIP domain that opens the call ports, as it gates bind', async () => {
    // A VoIP domain opens voice's call ports on every address: where the workspace listens,
    // the decision `bind` is gated for, so a member could open ports the bind gate closed.
    config.updateConfig((cfg) => {
      (cfg as Record<string, unknown>)[CREATE_POLICY_KEY] = 'admin';
    });
    await as('bob');
    const voice = (voipDomain: string) => ({
      version: '8.8.1',
      preset: 'voice',
      params: { sip_integration: 'on', voip_domain: voipDomain },
    });
    const refused = await post('/api/repros', voice('10.1.2.3'));
    expect(refused.statusCode).toBe(400);
    expect(String(refused.json().error)).toContain(
      'voip_domain (it opens the call ports to the network) is limited to admins',
    );
    const composed = await post('/api/repros', {
      version: '8.8.1',
      presets: ['email', 'voice'],
      params: { voice: { sip_integration: 'on', voip_domain: '10.1.2.3' } },
    });
    expect(composed.statusCode).toBe(400);
    // A loopback VoIP domain opens nothing, and an admin may.
    expect((await post('/api/repros', voice('127.0.0.1'))).statusCode).toBe(200);
    cookie = await signIn('alice');
    expect((await post('/api/repros', voice('10.1.2.3'))).statusCode).toBe(200);
  });

  it('never included the host port, which guarded nothing', async () => {
    // 80 and 443 are refused for EVERYBODY by lifecycle's 1024-65535 check.
    await as('bob');
    expect((await post('/api/repros', { version: '8.5.1', port: 3999 })).statusCode).toBe(200);
  });

  it('names the setting that opens it, and each documented key can really be set', async () => {
    // A boundary with no door on the other side is just a wall.
    config.updateConfig((cfg) => {
      (cfg as Record<string, unknown>)[CREATE_POLICY_KEY] = 'admin';
    });
    await as('bob');
    const refused = await post('/api/repros', { version: '8.5.1', bind: '0.0.0.0' });
    expect(String(refused.json().error)).toContain('gui.create_policy anyone');
    expect(String(refused.json().error)).toContain('config set bind_host');
    let out = '';
    const io: CliIo = { writeOut: (value) => (out += value), writeErr: (value) => (out += value) };
    for (const [key, value] of [
      ['gui.create_policy', 'anyone'],
      ['gui.destroy_policy', 'owner'],
      ['bind_host', '127.0.0.1'],
    ]) {
      const code = await runCli(['config', 'set', key as string, value as string], {
        execute: createExecutor(io),
        io,
      });
      expect({ key, code, out }).toEqual({ key, code: 0, out: expect.any(String) });
    }
  });
});

describe('acting on a workspace', () => {
  it('refuses an unconfirmed volume deletion through the REAL check, as a 400', async () => {
    const response = await del('/api/repros/x?volumes=true');
    expect(response.statusCode).toBe(400);
    expect(String(response.json().error)).toContain('irreversible');
  });

  it('refuses a non-string action with a 400 rather than an unhashable-type 500', async () => {
    for (const bad of [{}, [], 5, null]) {
      const response = await post('/api/repros/x/state', { action: bad });
      expect({ bad, status: response.statusCode }).toEqual({ bad, status: 400 });
    }
  });

  it('brings a downed workspace back from its stored record, re-entering nothing', async () => {
    // `down` removes the containers, so `docker compose start` can never revive it.
    jest
      .mocked(record.readMeta)
      .mockResolvedValue(
        realRecord.metadata({ name: 'x', rcVersion: '8.5.1', preset: 'ldap' }) as never,
      );
    const response = await post('/api/repros/x/up');
    expect(response.statusCode).toBe(200);
    expect(String(response.json().job_id)).toMatch(/^job_/u);
    await app.jobs.drain();
    expect(jest.mocked(createDocker.createRepro).mock.calls[0]?.[0]).toMatchObject({
      version: '8.5.1',
      preset: 'ldap',
      name: 'x',
      wait: true,
      offline: true,
      // Only ever the workspace it is: queued behind a Delete, it made an empty new one.
      bringBack: true,
    });
  });

  it('brings a workspace back as its creator, for its owner and for an admin', async () => {
    // A Kubernetes namespace carries its creator as its owner label, and this route sent no
    // actor: the create refused the owner themselves ("HOUSTON_USER is not set"), so on
    // Kubernetes a GUI user could take a workspace down and never bring it back.
    jest.mocked(record.readMeta).mockResolvedValue(
      realRecord.metadata({
        name: 'mia-w3',
        rcVersion: '8.5.1',
        extra: { runtime: 'kubernetes', created_by: 'mia' },
      }) as never,
    );
    // Its owner, then an admin.
    await as('mia', 'member');
    expect((await post('/api/repros/mia-w3/up')).statusCode).toBe(200);
    cookie = await signIn('alice');
    expect((await post('/api/repros/mia-w3/up')).statusCode).toBe(200);
    await app.jobs.drain();
    const actors = jest.mocked(createDocker.createRepro).mock.calls.map(([req]) => req.actor);
    expect(actors).toEqual(['mia', 'mia']);
  });

  it('brings back the workspace it names, one made from the CLI included, for its owner and an admin', async () => {
    // A workspace made from the CLI has no `created_by`, so the clicker stood in as its
    // creator and their prefix went on its name: `k1` came back as `kmem-k1` and
    // `alice-k1`, which failed on the preset ports k1 holds. Anyone else is refused, not
    // handed a new workspace of their own.
    jest
      .mocked(record.readMeta)
      .mockResolvedValue(
        realRecord.metadata({ name: 'k1', rcVersion: '8.5.1', extra: { owner: 'kmem' } }) as never,
      );
    await as('kmem', 'member');
    expect((await post('/api/repros/k1/up')).statusCode).toBe(200);
    cookie = await signIn('alice');
    expect((await post('/api/repros/k1/up')).statusCode).toBe(200);
    await app.jobs.drain();
    const names = jest.mocked(createDocker.createRepro).mock.calls.map(([req]) => deriveFor(req));
    expect(names).toEqual(['k1', 'k1']);
    // With the hook that attaches monitoring, as the create gives it: without it a monitored
    // Kubernetes workspace came back saying "monitoring did not attach: monitoring attachment
    // was not supplied by the caller".
    const hooks = jest
      .mocked(createDocker.createRepro)
      .mock.calls.map(([, , options]) => typeof options?.monitorAttach);
    expect(hooks).toEqual(['function', 'function']);
    await as('mem2', 'member');
    // Refused by the gate every member route that names a workspace passes, before the
    // route's own check, which stays behind it.
    const refused = await post('/api/repros/k1/up');
    expect(refused.statusCode).toBe(409);
    expect(String(refused.json().error)).toMatch(/^k1 belongs to kmem — /u);
    expect(jest.mocked(createDocker.createRepro)).toHaveBeenCalledTimes(2);
  });

  it('records what a teardown or a state job does, which the kind alone does not say', async () => {
    // Activity and the rail could not tell a Delete from a Take down (both `teardown`), nor
    // Stop, Start and Restart (all `state`): the job record carried neither.
    await workspace('w-del', 'alice');
    await workspace('w-down', 'alice');
    expect((await post('/api/repros/x/state', { action: 'restart' })).statusCode).toBe(200);
    expect((await del('/api/repros/w-down')).statusCode).toBe(200);
    expect((await del('/api/repros/w-del?volumes=true&confirm=true')).statusCode).toBe(200);
    expect(await app.jobs.drain()).toEqual([]);
    const listed = ((await get('/api/jobs')).json().jobs as Record<string, unknown>[]).map(
      (job) => [job.kind, job.label, job.verb],
    );
    expect(listed).toEqual([
      ['teardown', 'w-del', 'delete'],
      ['teardown', 'w-down', 'take down'],
      ['state', 'x', 'restart'],
    ]);
    // `label` stays the workspace's name: the rail matches a running job to its row by it.
    expect(jest.mocked(destroy.teardown).mock.calls.map(([name]) => name)).toEqual([
      'w-down',
      'w-del',
    ]);
  });

  it('sets the default workspace', async () => {
    const response = await post('/api/repros/rc8-5-1/default');
    expect(response.statusCode).toBe(200);
    expect(response.json().default).toBe('rc8-5-1');
    expect(config.loadConfig().default_repro).toBe('rc8-5-1');
  });

  it('mints a PAT, and maps a workspace that cannot mint one to 409, not 500', async () => {
    callTarget();
    jest.mocked(rcapi.generatePat).mockResolvedValue('tok_abc');
    const minted = await post('/api/repros/x/pat', {});
    expect(minted.statusCode).toBe(200);
    expect(minted.json()).toMatchObject({ token: 'tok_abc', user_id: 'u1' });
    jest.mocked(rcapi.generatePat).mockResolvedValue('');
    expect((await post('/api/repros/x/pat', {})).statusCode).toBe(409);
  });

  it('answers 502 on the two routes that check the engine, and agrees with /state', async () => {
    // Every earlier test of them stubbed the check away, so the engine-down branch of
    // both was never exercised in either direction.
    jest.mocked(host.dockerAvailable).mockResolvedValue(false);
    for (const [url, body] of [
      ['/api/repros/x/pat', {}],
      ['/api/repros/x/call', { method: 'GET', path: '/api/info' }],
    ] as const) {
      const response = await post(url, body);
      expect({ url, status: response.statusCode, kind: response.json().kind }).toEqual({
        url,
        status: 502,
        kind: 'DockerError',
      });
    }
    expect(DockerError.httpStatus).toBe(502);
  });
});

describe('the API console', () => {
  it('relays the response, upper-cases the method and parses the body', async () => {
    callTarget();
    jest.mocked(rcapi.call).mockResolvedValue([200, '{"success":true}']);
    const response = await post('/api/repros/x/call', {
      method: 'post',
      path: '/api/v1/users.update',
      data: '{"userId": "abc"}',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      status: 200,
      text: '{"success":true}',
      tag: 'admin',
      url: 'http://x:3000/api/v1/users.update',
    });
    expect(typeof body.elapsed_ms).toBe('number');
    const [root, method, apiPath, options] = jest.mocked(rcapi.call).mock.calls[0] ?? [];
    expect([root, method, apiPath]).toEqual(['http://x:3000', 'POST', '/api/v1/users.update']);
    expect(options).toMatchObject({ data: { userId: 'abc' }, auth: { token: 't1' } });
    expect(options).not.toHaveProperty('extraHeaders');
  });

  it('reports a Rocket.Chat error as a result, not as its own failure', async () => {
    // A 403 from Rocket.Chat is the answer the user asked for.
    callTarget();
    jest.mocked(rcapi.call).mockResolvedValue([403, '{"error":"unauthorized"}']);
    const response = await post('/api/repros/x/call', { method: 'GET', path: '/api/v1/me' });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe(403);
    expect(String(response.json().text)).toContain('unauthorized');
  });

  it('uses a PAT and the 2FA header when asked, keeping the user id', async () => {
    callTarget();
    jest.mocked(rcapi.generatePat).mockResolvedValue('pat_xyz');
    jest.mocked(rcapi.call).mockResolvedValue([200, '{}']);
    const response = await post('/api/repros/x/call', {
      method: 'GET',
      path: '/api/v1/me',
      pat: true,
      two_fa: true,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().tag).toBe('PAT+2fa');
    const options = jest.mocked(rcapi.call).mock.calls[0]?.[3];
    expect(options).toMatchObject({ auth: { token: 'pat_xyz', userId: 'u1' } });
    expect(
      (options as { extraHeaders?: Record<string, string> }).extraHeaders?.['x-2fa-method'],
    ).toBe('password');
  });

  it('rejects bad input before touching the workspace', async () => {
    callTarget();
    expect((await post('/api/repros/x/call', { method: 'GET', path: '' })).statusCode).toBe(400);
    expect(
      (await post('/api/repros/x/call', { method: 'TRACE', path: '/api/v1/me' })).statusCode,
    ).toBe(400);
    const badJson = await post('/api/repros/x/call', {
      method: 'POST',
      path: '/api/v1/me',
      data: '{nope}',
    });
    expect(badJson.statusCode).toBe(400);
    expect(String(badJson.json().error)).toContain('valid JSON');
    expect(rcapi.call).not.toHaveBeenCalled();
  });

  it('cannot be pointed at another host', async () => {
    // The server fetches a caller-supplied URL fragment, which is the shape of an SSRF; it is
    // safe only because the join keeps the workspace's own root. A "cleaner" URL join here
    // would silently start honouring an absolute URL.
    callTarget();
    jest.mocked(rcapi.call).mockResolvedValue([200, '{}']);
    for (const hostile of ['http://evil.example/x', '//evil.example/x', '/../../evil']) {
      const response = await post('/api/repros/x/call', { method: 'GET', path: hostile });
      expect(response.statusCode).toBe(200);
      expect({ hostile, host: new URL(String(response.json().url)).host }).toEqual({
        hostile,
        host: 'x:3000',
      });
    }
    expect(jest.mocked(rcapi.call).mock.calls.map((call) => call[0])).toEqual([
      'http://x:3000',
      'http://x:3000',
      'http://x:3000',
    ]);
  });

  it('maps a dead workspace to 409 with the reason', async () => {
    callTarget();
    jest
      .mocked(rcapi.call)
      .mockRejectedValue(new rcapi.RequestFailed('connection refused', 'http://x:3000/api/v1/me'));
    const response = await post('/api/repros/x/call', { method: 'GET', path: '/api/v1/me' });
    expect(response.statusCode).toBe(409);
    expect(String(response.json().error)).toContain('connection refused');
  });

  it('needs a session before it relays anything', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/repros/x/call',
      payload: { method: 'GET', path: '/' },
      headers: { host: 'localhost' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('starting a stopped workspace', () => {
  it("rebuilds a composed workspace with its set and each preset's params", async () => {
    jest.mocked(record.readMeta).mockResolvedValue(
      realRecord.metadata({
        name: 'combo',
        rcVersion: '8.5.1',
        preset: 'email+ldap',
        extra: {
          runtime: 'docker',
          presets: ['email', 'ldap'],
          preset_params: { ldap: { users: '7' } },
        },
      }) as never,
    );
    expect((await post('/api/repros/combo/up', {})).statusCode).toBe(200);
    await app.jobs.drain();
    const req = jest.mocked(createDocker.createRepro).mock.calls[0]?.[0];
    expect([req?.preset, req?.params]).toEqual(['email+ldap', { 'ldap.users': '7' }]);
  });
});

describe('the TLS probe', () => {
  it('asks THIS host, with the name as SNI, and reports the public name apart', async () => {
    // Probing the public hostname reported Cloudflare's valid edge certificate as the
    // workspace's own while its Traefik had none.
    jest.mocked(record.readMeta).mockResolvedValue(
      realRecord.metadata({
        name: 't',
        rootUrl: 'http://localhost:3000',
        publicUrl: 'https://rc1.example.com',
        extra: { tls: 'acme', tls_ports: [443] },
      }) as never,
    );
    jest.mocked(tls.verify).mockImplementation((async (target: string) =>
      target === '127.0.0.1'
        ? {
            serving: true,
            issuer: 'CN = YR2',
            subject: 'CN = rc1.example.com',
            dates: 'notAfter=Nov  1 2026',
            fallback: false,
            trusted: true,
            trusted_via_ca: true,
            error: '',
          }
        : {
            serving: true,
            issuer: 'CN = Cloudflare Inc ECC CA-3',
            subject: '',
            dates: '',
            fallback: false,
            trusted: true,
            trusted_via_ca: true,
            error: '',
          }) as never);
    const response = await get('/api/repros/t/tls');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      issuer: 'CN = YR2',
      public_issuer: 'CN = Cloudflare Inc ECC CA-3',
      mode: 'acme',
      public_url: 'https://rc1.example.com',
    });
    const asked = jest
      .mocked(tls.verify)
      .mock.calls.map(([target, options]) => [target, options?.port ?? 443, options?.sni]);
    expect(asked).toContainEqual(['127.0.0.1', 443, 'rc1.example.com']);
    expect(asked).toContainEqual(['rc1.example.com', 443, undefined]);
  });

  it("asks where `tls-status` asks: [::1] past a cluster's placeholder, and a cluster's origin", async () => {
    // Check TLS asked on its own and missed both of the CLI's fixes: on a box running k3s,
    // IPv4 :443 answers with the cluster's placeholder, so a good Docker certificate read as
    // broken; and behind a CDN a Kubernetes workspace was given the CDN's certificate.
    const report = (issuer: string, fallback: boolean) =>
      ({
        serving: true,
        issuer,
        subject: '',
        dates: '',
        fallback,
        trusted: !fallback,
        error: '',
      }) as never;
    jest
      .mocked(tls.verify)
      .mockImplementation((async (target: string) =>
        target === '127.0.0.1'
          ? report('CN = TRAEFIK DEFAULT CERT', true)
          : target === '::1'
            ? report('CN = YR2', false)
            : target === '10.0.0.5'
              ? report('CN = R11', false)
              : report('CN = Cloudflare Inc ECC CA-3', false)) as never);
    const workspace = (extra: Record<string, unknown>) =>
      jest.mocked(record.readMeta).mockResolvedValue(
        realRecord.metadata({
          name: 't',
          rootUrl: 'http://localhost:3000',
          publicUrl: 'https://rc1.example.com',
          extra: { tls: 'acme', ...extra },
        }) as never,
      );

    workspace({ tls_ports: [443] });
    expect((await get('/api/repros/t/tls')).json()).toMatchObject({ issuer: 'CN = YR2' });

    jest.mocked(tls.verify).mockClear();
    workspace({ tls_terminates: 'cluster', edge: true, ingress_endpoint: '10.0.0.5:443' });
    expect((await get('/api/repros/t/tls')).json()).toMatchObject({ issuer: 'CN = R11' });
    expect(jest.mocked(tls.verify).mock.calls[0]).toEqual([
      '10.0.0.5',
      { port: 443, sni: 'rc1.example.com' },
    ]);
  });

  it('keeps the placeholder IPv4 found when [::1] refuses, rather than calling it nothing', async () => {
    // With IPv6 off, [::1] refuses -- and the last answer won, so a box serving the cluster's
    // placeholder on IPv4 was reported as serving nothing at all.
    jest
      .mocked(tls.verify)
      .mockImplementation((async (target: string) =>
        target === '127.0.0.1'
          ? { serving: true, issuer: 'CN = TRAEFIK DEFAULT CERT', fallback: true, error: '' }
          : { serving: false, issuer: '', fallback: false, error: 'connection refused' }) as never);
    jest.mocked(record.readMeta).mockResolvedValue(
      realRecord.metadata({
        name: 't',
        rootUrl: 'http://localhost:3000',
        publicUrl: 'https://rc1.example.com',
        extra: { tls: 'acme', tls_ports: [443] },
      }) as never,
    );
    expect((await get('/api/repros/t/tls')).json()).toMatchObject({
      serving: true,
      fallback: true,
      issuer: 'CN = TRAEFIK DEFAULT CERT',
    });
  });

  it('refuses a workspace created without --https', async () => {
    jest
      .mocked(record.readMeta)
      .mockResolvedValue(
        realRecord.metadata({ name: 't', rootUrl: 'http://localhost:3000' }) as never,
      );
    const response = await get('/api/repros/t/tls');
    expect(response.statusCode).toBe(400);
    expect(String(response.json().error)).toContain('not created with --https');
  });

  it('needs a session before it probes anything', async () => {
    expect(
      (await app.inject({ url: '/api/repros/t/tls', headers: { host: 'localhost' } })).statusCode,
    ).toBe(401);
  });
});

describe('env', () => {
  it('reports the effective env, and a change is a job because the recreate is slow', async () => {
    jest.mocked(envvars.current).mockResolvedValue({
      name: 'e',
      overrides: ['MY'],
      env: [
        { key: 'MY', value: 'v', override: true },
        { key: 'ADMIN_PASS', value: '********', override: false },
      ],
    } as never);
    const read = await get('/api/repros/e/env');
    expect(read.statusCode).toBe(200);
    expect(read.json().overrides).toEqual(['MY']);
    expect((read.json().env as { key: string }[]).map((row) => row.key)).toEqual([
      'MY',
      'ADMIN_PASS',
    ]);
    const changed = await post('/api/repros/e/env', { set: { A: '1' }, unset: ['B'] });
    expect(changed.statusCode).toBe(200);
    expect(String(changed.json().job_id)).toMatch(/^job_/u);
    await app.jobs.drain();
    expect(envvars.setEnv).toHaveBeenCalledWith(
      'e',
      { A: '1' },
      ['B'],
      expect.objectContaining({ restart: true }),
    );
  });

  it('refuses the wrong shapes before the service sees them', async () => {
    for (const [body, message] of [
      [{ set: ['A=1'] }, 'must be an object'],
      [{ unset: 'B' }, 'must be a list'],
    ] as const) {
      const response = await post('/api/repros/e/env', body);
      expect({ body, status: response.statusCode }).toEqual({ body, status: 400 });
      expect(String(response.json().error)).toContain(message);
    }
    expect(envvars.setEnv).not.toHaveBeenCalled();
  });

  it('prefixes settings on the SERVER and keeps plain variables apart', async () => {
    // A Rocket.Chat setting only works with OVERWRITE_SETTING_, a plain env var only without.
    expect(
      (
        await post('/api/repros/e/env', {
          set: { MY_PLAIN: 'raw' },
          setting: { Message_AllowStarring: 'false' },
          unset: ['OLD'],
        })
      ).statusCode,
    ).toBe(200);
    await post('/api/repros/e/env', { setting: { OVERWRITE_SETTING_Foo_Bar: '1' } });
    await app.jobs.drain();
    const calls = jest.mocked(envvars.setEnv).mock.calls;
    expect(calls[0]?.[1]).toEqual({
      MY_PLAIN: 'raw',
      OVERWRITE_SETTING_Message_AllowStarring: 'false',
    });
    expect(calls[0]?.[2]).toEqual(['OLD']);
    // An already-prefixed setting id is not double-prefixed.
    expect(calls[1]?.[1]).toEqual({ OVERWRITE_SETTING_Foo_Bar: '1' });
  });

  it('refuses an env change on a Kubernetes workspace up front, not in a job that fails', async () => {
    // The GUI said "started", then the job failed: `setEnv` refused Kubernetes only once it
    // ran. A refusal that is known before anything starts is a 400, and there is no job.
    const meta = realRecord.metadata({ name: 'ke', rcVersion: '8.6.1', extra: {} });
    topology.stamp(meta.extra, topology.KUBERNETES);
    await realRecord.writeRecord('ke', meta);
    const response = await post('/api/repros/ke/env', { set: { A: '1' } });
    expect(response.statusCode).toBe(400);
    expect(String(response.json().error)).toContain("'ke' runs on Kubernetes");
    expect(response.json().job_id).toBeUndefined();
    expect(envvars.setEnv).not.toHaveBeenCalled();
  });

  it('refuses a setting that is not an object', async () => {
    const response = await post('/api/repros/e/env', { setting: ['A=1'] });
    expect(response.statusCode).toBe(400);
    expect(String(response.json().error)).toContain('must be an object');
  });

  it('needs a session, both ways', async () => {
    const anonymous = { host: 'localhost' };
    expect((await app.inject({ url: '/api/repros/e/env', headers: anonymous })).statusCode).toBe(
      401,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/repros/e/env',
          payload: { set: {} },
          headers: anonymous,
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('sessions and credentials', () => {
  it('answers an anonymous API call 401 with no browser password dialog', async () => {
    // WWW-Authenticate is what summoned the browser's own grey box; dropping it is what makes
    // a real sign-in page possible.
    const response = await app.inject({ url: '/api/repros', headers: { host: 'localhost' } });
    expect(response.statusCode).toBe(401);
    expect(response.headers).not.toHaveProperty('www-authenticate');
    expect(response.json().kind).toBe('Unauthorized');
  });

  it('survives a malformed session cookie', async () => {
    for (const bad of ['', '!!!', 'x'.repeat(5000), 'a.b.c']) {
      const response = await app.inject({
        url: '/api/repros',
        headers: { host: 'localhost', cookie: `${COOKIE_PLAIN}=${bad}` },
      });
      expect({ length: bad.length, status: response.statusCode }).toEqual({
        length: bad.length,
        status: 401,
      });
    }
  });

  it('ends every session a password minted when the password changes', async () => {
    // Changing a compromised password must not leave the intruder signed in for seven days.
    expect((await get('/api/repros')).statusCode).toBe(200);
    // The SERVICE ends them, not the caller -- a caller that forgot left the old one working.
    expect(await users.setPassword('alice', 'a-brand-new-password')).toBe(1);
    expect(await sessions.revokeUser('alice')).toBe(0);
    expect((await get('/api/repros')).statusCode).toBe(401);
  });
});

describe('attribution and the audit trail', () => {
  /** Every job ended: a create without a typed name is audited once it names its workspace, or ends. */
  async function settled(): Promise<void> {
    for (let tries = 0; tries < 100; tries += 1) {
      const jobs = (await get('/api/jobs')).json().jobs as { status: string }[];
      if (jobs.every((job) => job.status !== 'queued' && job.status !== 'running')) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  it('records who ran each job', async () => {
    expect((await post('/api/repros', { version: '8.5.1' })).statusCode).toBe(200);
    expect((await get('/api/jobs')).json().jobs[0].actor).toBe('alice');
  });

  it('writes the audit log to disk, so it survives a restart, with the appended columns last', async () => {
    await post('/api/repros', { version: '8.5.1' });
    await settled();
    const lines = fs
      .readFileSync(path.join(home, AUDIT_FILE), 'utf8')
      .split('\n')
      .filter((line) => line.includes('\tcreate\t'));
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.split('\t')[5])).toEqual(['accepted', 'done']);
    const [when, who, kind, label, origin, outcome] = (lines[0] ?? '').split('\t');
    expect({ who, kind, label, origin, outcome }).toEqual({
      who: 'alice',
      kind: 'create',
      label: '8.5.1',
      origin: 'session',
      outcome: 'accepted',
    });
    expect(when?.startsWith('20')).toBe(true);
  });

  it('audits a typed name as the workspace it makes', async () => {
    // With accounts `gui-1` is made as `alice-gui-1`; the job and the audit said `gui-1`,
    // a name nothing on the box answers to.
    await post('/api/repros', { version: '8.5.1', name: 'gui-1' });
    expect((await get('/api/jobs')).json().jobs[0].label).toBe('alice-gui-1');
    const line = fs
      .readFileSync(path.join(home, AUDIT_FILE), 'utf8')
      .split('\n')
      .find((row) => row.includes('\tcreate\t'));
    expect(line?.split('\t')[3]).toBe('alice-gui-1');
  });

  it('audits a derived name as the workspace the create settled on', async () => {
    // History read "8.5.1" for every create without a typed name: the line was written at
    // submit, before the version lookup that names the workspace.
    jest.mocked(createDocker.createRepro).mockImplementationOnce(async (_req, emit) => {
      emit?.(
        event('workspace name: alice-rc8-5-1', {
          phase: 'create',
          code: 'workspace-name',
          data: { workspace: 'alice-rc8-5-1' },
        }),
      );
      return {};
    });
    await post('/api/repros', { version: '8.5.1' });
    await settled();
    const created = fs
      .readFileSync(path.join(home, AUDIT_FILE), 'utf8')
      .split('\n')
      .filter((row) => row.includes('\tcreate\t'))
      .filter((row) => row.split('\t')[5] === 'accepted')
      .map((row) => row.split('\t')[3]);
    expect(created).toEqual(['alice-rc8-5-1']);
  });

  it('can finally be read', async () => {
    await post('/api/repros', { version: '8.5.1' });
    await settled();
    const lines = (await get('/api/audit')).json().lines as {
      kind: string;
      actor: string;
      origin: string;
      outcome: string;
    }[];
    const created = lines.filter((line) => line.kind === 'create');
    expect(created.map((line) => line.outcome)).toEqual(['done', 'accepted']);
    for (const line of created) expect(line).toMatchObject({ actor: 'alice', origin: 'session' });
  });

  it('records a refusal, so the role lines can be reviewed', async () => {
    // `grep denied` is the evidence for whether `readonly` is drawn in the right place.
    await as('ronly', 'readonly');
    expect((await post('/api/repros', { version: '8.5.1' })).statusCode).toBe(403);
    const denied = (
      (await get('/api/audit')).json().lines as { outcome: string; label: string }[]
    ).filter((line) => line.outcome === 'denied');
    expect(denied.length).toBeGreaterThan(0);
    expect(denied[0]?.label).toContain('needs member');
  });
});

describe('the cross-site refusal', () => {
  it('covers every state change', async () => {
    // Confirmed reachable before the fix: a body-less POST to /upgrade/rollback, which drops
    // the workspace database.
    for (const url of [
      '/api/repros/x/upgrade/rollback',
      '/api/repros/x/pat',
      '/api/repros/x/default',
      '/api/repros/x/monitor',
    ]) {
      expect({ url, status: (await post(url, undefined, CROSS)).statusCode }).toEqual({
        url,
        status: 403,
      });
    }
  });

  it('covers a delete', async () => {
    expect((await del('/api/repros/x?volumes=true&confirm=true', CROSS)).statusCode).toBe(403);
  });

  it('covers reads too, because some reads hand over credentials', async () => {
    // `GET .../logs` hands over a container log with LDAP bind passwords in it, and
    // `/api/repros` discloses every ticket number on the box.
    for (const url of ['/api/repros', '/api/repros/x/logs', '/api/repros/x/detail', '/api/jobs']) {
      expect({ url, status: (await get(url, CROSS)).statusCode }).toEqual({ url, status: 403 });
    }
  });

  it('refuses a null origin with no Sec-Fetch-Site to appeal to', async () => {
    // A sandboxed iframe or a data: URL cannot be matched against the allow-list.
    expect(
      (await post('/api/repros/x/state', { action: 'stop' }, { origin: 'null' })).statusCode,
    ).toBe(403);
  });

  it('leaves the app’s own requests alone', async () => {
    const own = await post('/api/repros/x/default', undefined, {
      'sec-fetch-site': 'same-origin',
      origin: 'http://localhost',
    });
    expect(own.statusCode).not.toBe(403);
  });

  it('leaves non-browser clients alone, which send neither header', async () => {
    expect((await post('/api/repros/x/default')).statusCode).not.toBe(403);
  });
});

describe('roles and ownership', () => {
  it('lets a readonly user look but not touch', async () => {
    await as('ronly', 'readonly');
    expect((await get('/api/repros')).statusCode).toBe(200);
    expect((await get('/api/doctor')).statusCode).toBe(200);
    for (const url of ['/api/repros/x/state', '/api/repros/x/seed', '/api/repros/x/pat']) {
      expect({ url, status: (await post(url, {})).statusCode }).toEqual({ url, status: 403 });
    }
    expect((await del('/api/repros/x?volumes=true')).statusCode).toBe(403);
  });

  it('hands a workspace over, moving the owner and keeping who made it', async () => {
    // Who CREATED it is a fact about the past; who is responsible today is what moves.
    await users.add('bob', 'bobs-good-password', 'member');
    await workspace('t4471', 'alice');
    const response = await post('/api/repros/t4471/owner', { to: 'bob' });
    expect(response.statusCode).toBe(200);
    expect(response.json().to).toBe('bob');
    const extra = (await realRecord.readMeta('t4471')).extra as Record<string, unknown>;
    expect(extra.owner).toBe('bob');
    expect(extra.created_by).toBe('alice');
    expect((extra.owner_history as { from: string }[]).at(-1)?.from).toBe('alice');
  });

  it('will not hand a workspace to somebody who cannot sign in', async () => {
    await workspace('t4471', 'alice');
    const response = await post('/api/repros/t4471/owner', { to: 'ghost' });
    expect(response.statusCode).toBe(404);
    expect(String(response.json().error)).toContain('no account');
  });

  it('tells the panel whether this viewer passes the gate a hand-over and a rollback need', async () => {
    // The GUI had no hand-over control at all, and its delete confirm sent everyone to a
    // shell command. The pane needs the SERVER's answer for this viewer, not a guess at it.
    jest.mocked(payload.detail).mockImplementation(async (name) => ({ name }) as never);
    await workspace('alices-box', 'alice');
    const mayDestroy = async () => (await get('/api/repros/alices-box/detail')).json().may_destroy;
    expect(await mayDestroy()).toBe(true); // the owner, and an admin
    await as('bob');
    expect(await mayDestroy()).toBe(false); // a member who does not own it
    config.updateConfig((cfg) => {
      cfg[DESTROY_POLICY_KEY] = 'anyone';
    });
    expect(await mayDestroy()).toBe(true); // a box that lets anyone
    // And it is the answer the hand-over itself gets.
    expect((await post('/api/repros/alices-box/owner', { to: 'bob' })).statusCode).toBe(200);
  });

  it('will not let a member destroy somebody else’s workspace', async () => {
    // The old guardrail was a confirm dialog, which stops being one around the twentieth
    // time you click through it for your own workspaces.
    await workspace('alices-box', 'alice');
    await as('bob');
    const response = await del('/api/repros/alices-box?volumes=true&confirm=true');
    expect(response.statusCode).toBe(409);
    expect(String(response.json().error)).toContain('belongs to alice');
  });

  it('lets a member change only their own workspaces, as the owner decided after Okta', async () => {
    // Before, only destruction was gated, so a member could stop a colleague's workspace,
    // take it down, rewrite its env and read its logs and admin login.
    await workspace('alices-box', 'alice');
    await as('bob');
    jest.mocked(state.setState).mockResolvedValue({} as never);
    const refusals: [string, number][] = [];
    for (const [method, url, body] of [
      ['POST', '/api/repros/alices-box/state', { action: 'stop' }],
      ['POST', '/api/repros/alices-box/state', { action: 'restart' }],
      ['DELETE', '/api/repros/alices-box', undefined],
      ['GET', '/api/repros/alices-box/env', undefined],
      ['POST', '/api/repros/alices-box/env', { set: { A: 'b' } }],
      ['GET', '/api/repros/alices-box/logs', undefined],
      ['POST', '/api/repros/alices-box/seed', {}],
      ['POST', '/api/repros/alices-box/pat', {}],
      ['POST', '/api/repros/alices-box/call', { method: 'GET', path: '/api/v1/me' }],
      ['POST', '/api/repros/alices-box/backup', {}],
      ['POST', '/api/repros/alices-box/upgrade', { version: '8.6.0' }],
      ['POST', '/api/repros/alices-box/monitor', { on: true }],
      ['POST', '/api/repros/alices-box/ready', {}],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        ...(body === undefined ? {} : { payload: body as object }),
        headers: headers(),
      });
      refusals.push([`${method} ${url}`, response.statusCode]);
      if (response.statusCode === 409) {
        expect(String(response.json().error)).toContain('belongs to alice — you can look at it');
      }
    }
    expect(refusals.filter(([, status]) => status !== 409)).toEqual([]);
    expect(jest.mocked(state.setState)).not.toHaveBeenCalled();
    // Their own, they change as before; a workspace nobody owns is anyone's.
    await workspace('bobs-box', 'bob');
    await workspace('old-box', '');
    for (const name of ['bobs-box', 'old-box']) {
      expect((await post(`/api/repros/${name}/state`, { action: 'restart' })).statusCode).toBe(200);
    }
    // An admin changes anyone's; so does a member on a box set to let anyone.
    cookie = await signIn('alice');
    await workspace('carols-box', 'carol');
    expect((await post('/api/repros/carols-box/state', { action: 'stop' })).statusCode).toBe(200);
    await as('bob');
    config.updateConfig((cfg) => {
      cfg[DESTROY_POLICY_KEY] = 'anyone';
    });
    expect((await post('/api/repros/alices-box/state', { action: 'stop' })).statusCode).toBe(200);
  });

  it('shows a member someone else’s workspace without its login, env vars or password', async () => {
    const secret = 'g3nerated-Pa55';
    jest.mocked(payload.detail).mockImplementation(
      async (name) =>
        ({
          name,
          login: { user: 'admin', password: secret },
          env: [{ key: 'ROOT_URL', value: 'http://x' }],
          notes: [`it runs admin/${secret}. Keep it off untrusted networks.`],
          note_groups: [{ title: 'Reachable', body: [`runs admin/${secret}`] }],
        }) as never,
    );
    jest
      .mocked(inspect.describe)
      .mockImplementation(
        async (name) => ({ name, login: { user: 'admin', password: secret } }) as never,
      );
    await workspace('alices-box', 'alice');
    await workspace('bobs-box', 'bob');
    await as('bob');
    const theirs = await get('/api/repros/alices-box/detail');
    expect(theirs.statusCode).toBe(200);
    expect(theirs.body).not.toContain(secret);
    expect(theirs.json()).toMatchObject({ login: null, env: [], may_destroy: false });
    expect(theirs.json().notes).toEqual([
      'it runs admin/********. Keep it off untrusted networks.',
    ]);
    const described = await get('/api/repros/alices-box');
    expect([described.statusCode, described.json().login]).toEqual([200, null]);
    // Their own, in full.
    const own = await get('/api/repros/bobs-box/detail');
    expect(own.json()).toMatchObject({ login: { password: secret }, may_destroy: true });
  });

  it('hides the incoming webhook token from someone who may only look', async () => {
    // The hook posts as rocket.cat on a workspace that may be bound beyond loopback: the
    // token is for the owner's `info`, not for every member's panel.
    const line = 'Incoming hook (POST JSON): http://x/hooks/abc/t0k3n';
    jest.mocked(payload.detail).mockImplementation(
      async (name) =>
        ({
          name,
          login: null,
          notes: [line],
          note_groups: [
            {
              title: 'Webhooks',
              body: [line],
              // A customer's endpoints carry their own secrets in the path or query.
              rows: [
                [
                  'Repointed at the inbox (capture=all)',
                  'Jira — was https://hooks.example.com/services/T1/B2/s3cret',
                ],
                [
                  'Omnichannel webhook',
                  'left at https://crm.example.com/hook?token=s3cret (--set capture=all repoints it at the inbox)',
                ],
              ],
              commands: [`curl -X POST ${line.split(': ')[1] ?? ''}`],
            },
          ],
        }) as never,
    );
    jest
      .mocked(inspect.describe)
      .mockImplementation(async (name) => ({ name, login: null }) as never);
    await workspace('alices-box', 'alice');
    await workspace('bobs-box', 'bob');
    await as('bob');
    const theirs = await get('/api/repros/alices-box/detail');
    expect(theirs.statusCode).toBe(200);
    expect(theirs.body).not.toContain('t0k3n');
    expect(theirs.json().notes).toEqual(['Incoming hook (POST JSON): http://x/hooks/abc/********']);
    expect(theirs.json().note_groups[0].commands).toEqual([
      'curl -X POST http://x/hooks/abc/********',
    ]);
    // The customer's endpoints keep their host and lose their path and query.
    expect(theirs.body).not.toContain('s3cret');
    expect(theirs.json().note_groups[0].rows).toEqual([
      ['Repointed at the inbox (capture=all)', 'Jira — was https://hooks.example.com/********'],
      [
        'Omnichannel webhook',
        'left at https://crm.example.com/******** (--set capture=all repoints it at the inbox)',
      ],
    ]);
    const own = await get('/api/repros/bobs-box/detail');
    expect(own.body).toContain('t0k3n');
    expect(own.body).toContain('s3cret');
  });

  it('leaves the CLI default to an admin, it being everybody’s', async () => {
    await workspace('bobs-box', 'bob');
    await as('bob');
    expect((await post('/api/repros/bobs-box/default')).statusCode).toBe(403);
    // A create's pin sets it too.
    const pinned = await post('/api/repros', { version: '8.5.1', name: 'p1', pin: true });
    expect(pinned.statusCode).toBe(400);
    expect(String(pinned.json().error)).toContain('default workspace for CLI commands');
    expect(jest.mocked(createDocker.createRepro)).not.toHaveBeenCalled();
  });

  it('hides even a one-letter password without touching a key of the payload', async () => {
    // A password restored from a bundle can be any string; replaced in the serialised JSON,
    // an `e` rewrote keys and the panel could not read its own payload.
    jest
      .mocked(payload.detail)
      .mockImplementation(
        async (name) =>
          ({ name, login: { user: 'admin', password: 'e' }, notes: ['see admin/e'] }) as never,
      );
    await workspace('alices-box', 'alice');
    await as('bob');
    const d = (await get('/api/repros/alices-box/detail')).json();
    expect(Object.keys(d).sort()).toEqual(['login', 'may_destroy', 'name', 'notes']);
    expect([d.name, d.login]).toEqual(['alices-box', null]);
    expect(d.notes[0]).not.toContain('admin/e');
  });
});
