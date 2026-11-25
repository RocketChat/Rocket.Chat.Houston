import type * as ModNS from '../../src/perf/k6';
import type * as PathsNS from '../../src/core/runner/paths';

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

import * as config from '../../src/lib/config';

import { K6_IMAGE, PROM_RW_URL, SCENARIOS, k6Command, stageScenario } from '../../src/perf/k6';
import type * as PolicyNS from '../testsetup-policy';

/**
 * What earlier releases built for the shape tables below, recorded: the k6 environment for
 * each staging case, and the docker argv for each live/timeline pair. The argv was recorded
 * in a sandboxed home by a user whose ids are this run's business, so the home is kept as
 * `<home>` and the `--user` value as `<uid>:<gid>`, and both are put back from this run.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'perf', 'k6.json'), 'utf8'),
) as { env: Record<string, string>[]; argv: string[][] };

function unmask(argv: string[]): string[] {
  const ids = `${String(process.getuid?.())}:${String(process.getgid?.())}`;
  return argv.map((arg) => arg.replaceAll('<home>', config.home()).replaceAll('<uid>:<gid>', ids));
}

/** A workspace with the `repro.json` `projectName` reads. */
function makeWorkspace(name: string): string {
  const paths = require('../../src/core/runner/paths') as typeof PathsNS;
  const ws = paths.workspace(name);
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(
    path.join(ws, 'repro.json'),
    JSON.stringify({ name, project: `houston-${name}` }),
  );
  return ws;
}

const BASE = {
  duration: '30s',
  live: false,
  name: 'ws',
  password: 'admin123',
  ramp: null,
  scenario: 'messages',
  spike: null,
  target: 'http://rocketchat:3000',
  token: 'a-pat',
  uid: 'uid1',
  user: 'admin',
  users: null,
  vus: 5,
};

beforeEach(() => {
  fs.rmSync(path.join(config.home(), 'repros'), { recursive: true, force: true });
});

describe('constants', () => {
  it('pins the image and scenario list earlier releases pinned', () => {
    const [image, scenarios, prom, secrets] = [
      'grafana/k6:0.55.0',
      ['messages', 'login', 'read', 'mixed', 'journey', 'webhook', 'badbot', 'custom'],
      'http://prometheus:9090/api/v1/write',
      ['RC_TOKEN', 'RC_PASS'],
    ];
    expect(image).toBe(K6_IMAGE);
    expect(scenarios).toEqual([...SCENARIOS]);
    expect(prom).toBe(PROM_RW_URL);
    expect(secrets).toEqual(['RC_TOKEN', 'RC_PASS']);
  });
});

describe('stageScenario', () => {
  it('copies the scenario and its common module out of package data', () => {
    makeWorkspace('ws');
    const { dest } = stageScenario(BASE);
    expect(fs.existsSync(path.join(dest, 'messages.js'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'common.js'))).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'common.js'), 'utf8')).toBe(
      fs.readFileSync(config.dataPath('loadtest', 'common.js'), 'utf8'),
    );
  });

  it('removes a stale summary and point stream before the run', () => {
    makeWorkspace('ws');
    const { dest } = stageScenario(BASE);
    fs.writeFileSync(path.join(dest, 'summary.json'), '{"old":true}');
    fs.writeFileSync(path.join(dest, 'points.json'), 'old');
    // A result from a prior run must not be mistaken for this one.
    stageScenario(BASE);
    expect(fs.existsSync(path.join(dest, 'summary.json'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'points.json'))).toBe(false);
  });

  it('chooses exactly one of SPIKE, RAMP and VUS, in that order', () => {
    makeWorkspace('ws');
    expect(stageScenario({ ...BASE, spike: '10:100:10' }).env).toMatchObject({
      SPIKE: '10:100:10',
    });
    expect(stageScenario({ ...BASE, spike: '10:100:10' }).env).not.toHaveProperty('VUS');
    expect(stageScenario({ ...BASE, ramp: '0:50' }).env).toMatchObject({ RAMP: '0:50' });
    expect(stageScenario({ ...BASE }).env).toMatchObject({ VUS: '5' });
  });

  it('writes a users file only when there are users, and clears a stale one', () => {
    makeWorkspace('ws');
    const { dest } = stageScenario({ ...BASE, users: [{ username: 'u1' }] });
    expect(JSON.parse(fs.readFileSync(path.join(dest, 'users.json'), 'utf8'))).toEqual([
      { username: 'u1' },
    ]);
    // This run is admin-only, so the previous run's list must go.
    const again = stageScenario(BASE);
    expect(fs.existsSync(path.join(dest, 'users.json'))).toBe(false);
    expect(again.env).not.toHaveProperty('RC_USERS_FILE');
  });

  it('drops a null extra-env value rather than writing it out as text', () => {
    makeWorkspace('ws');
    const env = stageScenario({ ...BASE, extraEnv: { RC_BODY: 'x', RC_CHANNEL: null } }).env;
    expect(env.RC_BODY).toBe('x');
    expect(env).not.toHaveProperty('RC_CHANNEL');
  });

  it('builds the environment earlier releases built, for every shape', () => {
    makeWorkspace('ws');
    const cases = [
      BASE,
      { ...BASE, live: true },
      { ...BASE, ramp: '0:50' },
      { ...BASE, spike: '10:100:10' },
      { ...BASE, users: [{ username: 'u1' }] },
      { ...BASE, extraEnv: { RC_BODY: 'x', RC_CHANNEL: null } },
    ];
    expect(cases.map((c) => stageScenario(c).env)).toEqual(RECORDED.env);
  });
});

describe('k6Command', () => {
  it('joins the repro network and mounts the staged directory', async () => {
    makeWorkspace('ws');
    const { dest, env } = stageScenario(BASE);
    const [cmd] = await k6Command(dest, env, false, 'ws', 'messages', false);
    expect(cmd.slice(0, 6)).toEqual([
      'docker',
      'run',
      '--rm',
      '--network',
      'houston-ws_default',
      '-v',
    ]);
    expect(cmd[6]).toBe(`${dest}:/k6`);
    expect(cmd[cmd.length - 1]).toBe('/k6/messages.js');
  });

  it('runs as container root and a qualified image on rootless Podman, the host user on Docker', async () => {
    makeWorkspace('ws');
    const { dest, env } = stageScenario(BASE);
    const [docker] = await k6Command(dest, env, false, 'ws', 'messages', false);
    expect(docker).toContain(K6_IMAGE);
    expect(docker[docker.indexOf('--user') + 1]).toBe(
      `${String(process.getuid?.())}:${String(process.getgid?.())}`,
    );
    jest.resetModules();
    jest.doMock('../../src/core/runner/host', () => ({
      ...jest.requireActual<object>('../../src/core/runner/host'),
      engine: async () => ({ kind: 'podman', rootless: true }),
    }));
    try {
      const fresh = require('../../src/perf/k6') as { k6Command: typeof k6Command };
      const [podman] = await fresh.k6Command(dest, env, false, 'ws', 'messages', false);
      expect(podman[podman.indexOf('--user') + 1]).toBe('0:0');
      expect(podman).toContain(`docker.io/${K6_IMAGE}`);
    } finally {
      jest.doMock('../../src/core/runner/host', () =>
        (require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
      );
      jest.resetModules();
    }
  });

  it('keeps the PAT and the password OUT of the argv', async () => {
    makeWorkspace('ws');
    const { dest, env } = stageScenario(BASE);
    const [cmd, envfile] = await k6Command(dest, env, false, 'ws', 'messages', false);
    // `-e K=V` would be readable by any local user through ps and docker inspect.
    expect(cmd.join(' ')).not.toContain('a-pat');
    expect(cmd.join(' ')).not.toContain('admin123');
    expect(cmd).toContain('--env-file');
    expect(fs.readFileSync(envfile, 'utf8')).toBe('RC_TOKEN=a-pat\nRC_PASS=admin123\n');
    expect(fs.statSync(envfile).mode & 0o777).toBe(0o600);
    // Everything else stays in the argv, where a newline in a custom scenario's body
    // cannot break the KEY=VALUE file format.
    expect(cmd).toContain('RC_URL=http://rocketchat:3000');
  });

  it('adds the timeline and live outputs only when asked', async () => {
    makeWorkspace('ws');
    const { dest, env } = stageScenario({ ...BASE, live: true });
    const [plain] = await k6Command(dest, env, false, 'ws', 'messages', false);
    expect(plain).not.toContain('--out');
    const [both] = await k6Command(dest, env, true, 'ws', 'messages', true);
    expect(both.join(' ')).toContain('--out json=/k6/points.json');
    expect(both.join(' ')).toContain('--out experimental-prometheus-rw');
  });

  it('builds the argv earlier releases built', async () => {
    makeWorkspace('ws');
    const cases: [boolean, boolean][] = [
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ];
    const mine: string[][] = [];
    for (const [live, timeline] of cases) {
      const { dest, env } = stageScenario({ ...BASE, live });
      const [cmd] = await k6Command(dest, env, live, 'ws', 'messages', timeline);
      mine.push(cmd);
    }
    expect(mine).toEqual(RECORDED.argv.map(unmask));
  });
});

describe('run', () => {
  function mockExec(writeSummary: string | null) {
    jest.resetModules();
    const seen: { mode: string; argv: string[] }[] = [];
    jest.doMock('../../src/seams/exec', () => ({
      inherit: (argv: string[]) => {
        seen.push({ mode: 'inherit', argv });
        return Promise.resolve({ exitCode: 0 });
      },
      stream: (argv: string[]) => {
        seen.push({ mode: 'stream', argv });
        return Promise.resolve({ exitCode: 0 });
      },
    }));
    return { seen, writeSummary };
  }

  it('throws with the pull hint when k6 produced no summary', async () => {
    makeWorkspace('ws');
    mockExec(null);
    const mod = require('../../src/perf/k6') as typeof ModNS;
    await expect(
      mod.run('ws', 'messages', {
        vus: 1,
        duration: '1s',
        token: 't',
        uid: 'u',
        target: 'http://x',
      }),
    ).rejects.toThrow(/k6 produced no summary.*docker pull grafana\/k6:0\.55\.0/su);
  });

  it('removes the env file even when the run fails', async () => {
    makeWorkspace('ws');
    mockExec(null);
    const mod = require('../../src/perf/k6') as typeof ModNS;
    const paths = require('../../src/core/runner/paths') as typeof PathsNS;
    const dest = path.join(paths.workspace('ws'), 'loadtest');
    await expect(
      mod.run('ws', 'messages', {
        vus: 1,
        duration: '1s',
        token: 't',
        uid: 'u',
        target: 'http://x',
      }),
    ).rejects.toThrow();
    // Never leave the PAT on disk.
    expect(fs.existsSync(path.join(dest, 'k6.env'))).toBe(false);
  });

  it('uses inherit normally and stream in quiet mode, so stdout stays JSON-only', async () => {
    makeWorkspace('ws');
    const { seen } = mockExec(null);
    const mod = require('../../src/perf/k6') as typeof ModNS;
    const paths = require('../../src/core/runner/paths') as typeof PathsNS;
    const dest = path.join(paths.workspace('ws'), 'loadtest');

    const opts = { vus: 1, duration: '1s', token: 't', uid: 'u', target: 'http://x' };
    // Write the summary from the stub's side effect: the run reads it after exec returns.
    fs.mkdirSync(dest, { recursive: true });
    await mod.run('ws', 'messages', opts).catch(() => undefined);
    expect(seen[0]?.mode).toBe('inherit');

    fs.mkdirSync(dest, { recursive: true });
    await mod.run('ws', 'messages', { ...opts, quiet: true }).catch(() => undefined);
    // `--json` promises stdout carries the envelope and nothing else, so k6's banner is
    // rerouted to stderr rather than inherited.
    expect(seen[1]?.mode).toBe('stream');
  });
});

describe('the shipped scenario scripts', () => {
  it('ships a script for every scenario it lists, and the shared module they need', () => {
    // A scenario named in SCENARIOS with no script behind it fails at run time inside a
    // container, after the workspace was seeded and capped.
    const read = (file: string) => fs.readFileSync(config.dataPath('loadtest', file), 'utf8');
    for (const name of ['custom', 'journey', 'webhook', 'badbot'])
      expect(SCENARIOS).toContain(name);
    for (const name of SCENARIOS) {
      expect(fs.existsSync(config.dataPath('loadtest', `${name}.js`))).toBe(true);
    }
    // journey and mixed emit per-step trends, and common.js collects them into `steps`;
    // the spike shape is read by common.js too.
    expect(read('journey.js')).toContain('step_');
    expect(read('mixed.js')).toContain('step_');
    expect(read('common.js')).toContain('steps');
    expect(read('common.js')).toContain('SPIKE');
  });
});

interface Call {
  method: string;
  url: string;
  token: string | undefined;
}

/**
 * A shipped scenario script run in a sandbox, as k6 would run it: `common.js` inlined in
 * front of it, k6's own modules stubbed, and `http` answering every login with token
 * `fresh`. Returns the sandbox and the requests the script made.
 */
function k6Script(file: string, env: Record<string, string>) {
  const strip = (src: string) =>
    src
      .replace(/^import .*;$/gmu, '')
      .replace(/^export \{.*\};$/gmu, '')
      .replace(/^export default /mu, 'var main = ')
      .replace(/^export /gmu, '');
  const read = (name: string) => strip(fs.readFileSync(config.dataPath('loadtest', name), 'utf8'));
  const calls: Call[] = [];
  const answer = (status: number, body: Record<string, unknown>) => ({
    status,
    timings: { duration: 1 },
    json: (key?: string) => (key === undefined ? body : body[key]),
  });
  const send = (method: string, url: string, params?: { headers?: Record<string, string> }) => {
    calls.push({ method, url, token: params?.headers?.['X-Auth-Token'] });
    return url.endsWith('/api/v1/login')
      ? answer(200, { status: 'success', data: { authToken: 'fresh', userId: 'u1' } })
      : answer(200, { success: true });
  };
  class Metric {
    add(): void {}
  }
  const sandbox = vm.createContext({
    __ENV: { RC_URL: 'http://rc', RC_TOKEN: 'pre-run', RC_UID: 'admin-id', ...env },
    __VU: 1,
    __ITER: 0,
    open: () =>
      JSON.stringify([{ username: 'alice', password: 'alice', token: 'alice-pre-run', uid: 'a1' }]),
    Counter: Metric,
    Trend: Metric,
    check: () => true,
    http: {
      get: (url: string, params?: { headers?: Record<string, string> }) => send('GET', url, params),
      post: (url: string, _body: unknown, params?: { headers?: Record<string, string> }) =>
        send('POST', url, params),
    },
  });
  vm.runInContext(`${read('common.js')}\n${read(file)}`, sandbox);
  return { calls, sandbox };
}

describe('what the scenario scripts ask k6 for', () => {
  it.each([
    { shape: { SPIKE: '10:100' }, start: 10 },
    { shape: { RAMP: '5:50' }, start: 5 },
  ])('starts $shape at its first number of VUs, in the option k6 reads', ({ shape, start }) => {
    // k6 has no top-level `startVUs`: it warned "unknown field" and began at 1 VU, so the
    // opening "10 VUs" third of a 10:100 spike climbed from 1. With `stages`, k6 reads the
    // starting count from `vus`.
    const { sandbox } = k6Script('read.js', { ...shape, DURATION: '60s' });
    const options = JSON.parse(vm.runInContext('JSON.stringify(options)', sandbox) as string);
    expect(Object.keys(options).sort()).toEqual(['stages', 'summaryTrendStats', 'vus']);
    expect(options.vus).toBe(start);
  });

  it.each([
    { users: { RC_USERS_FILE: '/k6/users.json' }, kept: 'alice-pre-run' },
    { users: {}, kept: 'pre-run' },
  ])('mixed logs its new session straight out, so $kept is never pruned', ({ users, kept }) => {
    // Rocket.Chat keeps 50 login tokens per user and drops every older one, the token made
    // before the run among them. mixed logged the same user in over and over, so its reads
    // and posts failed with 4xx from a few seconds in. Logging out with the new token keeps
    // the count where it was.
    const { calls, sandbox } = k6Script('mixed.js', { ...users, DURATION: '30s' });
    vm.runInContext('Math.random = () => 0.95; main();', sandbox);
    expect(calls).toEqual([
      { method: 'POST', url: 'http://rc/api/v1/login', token: undefined },
      { method: 'POST', url: 'http://rc/api/v1/logout', token: 'fresh' },
    ]);
    calls.length = 0;
    vm.runInContext('Math.random = () => 0.1; main();', sandbox);
    expect(calls).toEqual([
      {
        method: 'GET',
        url: 'http://rc/api/v1/channels.history?roomName=general&count=20',
        token: kept,
      },
    ]);
  });
});
