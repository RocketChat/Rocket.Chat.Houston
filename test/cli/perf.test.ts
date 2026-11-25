import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as coreLoadtest from '../../src/core/loadtest';
import * as runnerRecord from '../../src/core/runner/record';
import { NotFoundError, NotReadyError, ReproError, ValidationError } from '../../src/lib/errors';
import * as baseline from '../../src/perf/baseline';
import * as constrain from '../../src/perf/constrain';
import * as report from '../../src/perf/report';
import * as timeline from '../../src/perf/timeline';
import * as verdict from '../../src/perf/verdict';
import { RequestFailed } from '../../src/seams/rc-http';

import type * as EventsNS from '../../src/lib/events';

import type * as AppNS from '../../src/cli/app';
import type * as HandlersNS from '../../src/cli/handlers';
import {
  type CapacityCliOptions,
  type LoadtestCliOptions,
  type PerfCliDependencies,
  parseEndpoint,
  parseRamp,
  perfDeps,
  runCapacityCli,
  runLoadtestCli,
} from '../../src/cli/perf';

interface Recorded {
  code: number;
  out: string;
  err: string;
}

/**
 * What earlier releases' `capacity` and `loadtest` printed for the scripted runs below, by
 * case: the exit code, stdout and stderr, each recorded from a HOUSTON_HOME of its own, with
 * an envelope's `generated_at` and `houston_version` kept as `$GEN` and `$VER`.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cli', 'perf.json'), 'utf8'),
) as { capacity: Record<string, Recorded>; loadtest: Record<string, Recorded> };

function recorded(kind: 'capacity' | 'loadtest', label: string): Recorded {
  const run = RECORDED[kind][label];
  if (run === undefined) throw new Error(`no recorded ${kind} run for ${label}`);
  return run;
}

/** An `io` that drops what it is given, for the calls whose prose is not under test. */
function sink(): { writeOut: (text: string) => void; writeErr: (text: string) => void } {
  return { writeOut: () => undefined, writeErr: () => undefined };
}

it('Grafana public URL regression: prints the public dashboard URL in the live hint', async () => {
  const run = coreLoadtest.newLoadRun();
  run.summary = { p95: 1, rps: 1, error_rate: 0 };
  const execute = jest.fn(async (...args: unknown[]) => {
    (args[4] as coreLoadtest.CliHooks).armed?.();
    return {
      run,
      verdict: {
        grafana: 'https://h/grafana',
        mongoSlow: null,
        passed: true,
        shortStats: null,
        sloResults: [],
        tl: null,
        verdictLines: [],
      },
    };
  });
  const output: string[] = [];
  await runLoadtestCli(
    { ...LOAD_DEFAULTS, json: false, live: true },
    { writeOut: (line) => output.push(line), writeErr: () => undefined },
    loadtestDeps(execute, {
      readMeta: async () => ({
        ...meta({ monitoring: true, tls: 'local' }),
        publicUrl: 'https://h',
      }),
    }),
  );
  expect(output.join('')).toContain('dashboard in Grafana (https://h/grafana)');
});

const LOAD_DEFAULTS: LoadtestCliOptions = {
  name: 'work',
  scenario: 'messages',
  endpoint: '',
  body: '',
  vus: 10,
  usersN: 10,
  duration: '30s',
  ramp: '',
  spike: '',
  live: false,
  slo: '',
  constrain: '',
  diag: true,
  slowms: 100,
  stats: false,
  save: '',
  compare: '',
  json: true,
  report: false,
  reportPath: '',
};

const CAPACITY_DEFAULTS: CapacityCliOptions = {
  name: 'work',
  scenario: 'journey',
  usersN: 10,
  slo: 'p95=500ms,error=2%',
  start: 10,
  maxVus: 640,
  stepDuration: '20s',
  constrain: '',
  json: true,
  report: false,
  reportPath: '',
};

function meta(extra: Record<string, unknown> = {}): runnerRecord.Metadata {
  return runnerRecord.metadata({
    name: 'resolved',
    project: 'houston-resolved',
    rcVersion: '8.5.1',
    preset: 'default',
    rootUrl: 'http://127.0.0.1:19001',
    adminPassword: 'secret',
    extra,
  });
}

function loadtestDeps(
  runPreparedLoadtest: jest.Mock,
  overrides: Partial<PerfCliDependencies> = {},
): PerfCliDependencies {
  const core = {
    ...coreLoadtest,
    requireComposeForPerf: jest.fn(async () => undefined),
    loadtestTarget: jest.fn(() => 'http://traefik:80'),
    rcServicesIn: jest.fn(() => ['rocketchat-1', 'rocketchat-2']),
    loginSeedUsers: jest.fn(async () => [
      { username: 'alice', token: 'a', uid: 'u1' },
      { username: 'bob', token: 'b', uid: 'u2' },
    ]),
    runPreparedLoadtest,
  } as typeof coreLoadtest;
  return perfDeps({
    core,
    baseline: {
      ...baseline,
      load: jest.fn(() => ({
        label: 'old',
        saved_at: '2020-01-01T00:00:00+00:00',
        ctx: { scenario: 'read', vus: 3 },
        summary: { p95: 200, rps: 5, error_rate: 0 },
        snapshot: { constraints: 'old caps' },
      })),
      compare: jest.fn(() => [
        { metric: 'p95', before: 200, after: 900, pct: 350, worse: true, flag: true },
      ]),
      save: jest.fn(() => '/isolated/baseline.json'),
    },
    constrain: {
      ...constrain,
      parse: jest.fn(() => ({ rc: { cpus: 2, mem: '2g' } })),
      resolveServices: jest.fn(() => ({ 'rocketchat-1': { cpus: 2, mem: '2g' } })),
      human: jest.fn(() => 'rocketchat-1=2cpu/2g'),
    },
    report: {
      ...report,
      writeLoadtest: jest.fn(() => '/isolated/loadtest.md'),
      writeCapacity: jest.fn(() => '/isolated/capacity.md'),
    },
    timeline: { ...timeline, spikeRecovery: jest.fn(() => null) },
    verdict: { ...verdict, analyze: jest.fn(() => ['diagnosis']) },
    requireDocker: jest.fn(async () => undefined),
    resolveName: jest.fn(async () => 'resolved'),
    readMeta: jest.fn(async () => meta({ monitoring: true })),
    readCompose: jest.fn(async () => ({
      services: {
        traefik: {},
        'rocketchat-1': {},
        'rocketchat-2': {},
        prometheus: { command: ['--web.enable-remote-write-receiver'] },
      },
    })),
    adminPass: jest.fn(() => 'secret'),
    login: jest.fn(async () => ({ token: 'admin', userId: 'admin-id' })),
    generatePat: jest.fn(async () => 'pat'),
    createIncomingWebhook: jest.fn(async () => '/hooks/abc'),
    call: jest.fn(async (): Promise<[number, string]> => [
      200,
      JSON.stringify({ totalUsers: 12, totalRooms: 3, totalMessages: 99 }),
    ]),
    dockerServerVersion: jest.fn(async () => '27.0'),
    composeVersion: jest.fn(async () => '2.29'),
    now: jest.fn(() => new Date('2026-09-22T12:34:56.000Z')),
    platform: jest.fn(() => 'test-os'),
    cpuCount: jest.fn(() => 8),
    ...overrides,
  });
}

describe('the CLI performance option boundary', () => {
  it('uses the host platform spelling of earlier releases in performance reports', () => {
    // Recorded as `Linux-6.1.167-x86_64-with-glibc2.39` on a Linux 6.1.167 x86_64 host with
    // glibc 2.39: the spelling is pinned, and the three host facts are this host's.
    const recordedSpelling = 'Linux-<release>-<machine>-with-glibc<glibc>';
    const glibc = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
      .header?.glibcVersionRuntime;
    const spelled = perfDeps()
      .platform()
      .replace(`-${os.release()}-`, '-<release>-')
      .replace(`-${os.machine()}-`, '-<machine>-')
      .replace(`-with-glibc${String(glibc)}`, '-with-glibc<glibc>');
    expect(spelled).toBe(recordedSpelling);
  });

  it('parses custom endpoints and load shapes with the refusal wording of earlier releases', () => {
    expect(parseEndpoint('/api/v1/info')).toEqual(['GET', '/api/v1/info']);
    expect(parseEndpoint('patch /api/v1/settings')).toEqual(['PATCH', '/api/v1/settings']);
    expect(parseRamp('0:20', '--ramp')).toEqual([0, 20]);
    expect(() => parseEndpoint('TRACE /api/v1/info')).toThrow(
      "bad --endpoint: unsupported method 'TRACE' (use DELETE, GET, PATCH, POST, PUT)",
    );
    expect(() => parseRamp('10:10', '--spike')).toThrow("--spike peak must exceed base ('10:10')");
  });

  it('refuses a --spike base of 0 VUs, which leaves nothing to measure the spike against', () => {
    expect(() => parseRamp('0:50', '--spike')).toThrow(
      'bad --spike: the base must be at least 1 VU, e.g. 10:100',
    );
    expect(parseRamp('1:50', '--spike')).toEqual([1, 50]);
    expect(parseRamp('0:50', '--ramp')).toEqual([0, 50]);
  });

  it('forwards every load-control family and returns artifacts with the SLO exit', async () => {
    const run = coreLoadtest.newLoadRun();
    run.summary = { p95: 900, rps: 42, error_rate: 0.03 };
    run.resources = { 'houston-resolved-rocketchat-1-1': {} as never };
    run.rcmReport = { 'rocketchat-1': {} };
    run.mon = { memSlopes: () => ({ 'houston-resolved-rocketchat-1-1': 12 }) } as never;
    const measured = {
      grafana: 'http://localhost:9090',
      mongoSlow: null,
      passed: false,
      shortStats: { rocketchat: { peak_cpu: 95 } },
      sloResults: [
        {
          key: 'p95',
          op: '<=',
          threshold: 500,
          raw: '500ms',
          actual: 900,
          ok: false,
          measured: true,
        },
      ],
      tl: null,
      verdictLines: [],
    };
    const execute = jest.fn(async () => ({ run, verdict: measured }));
    const deps = loadtestDeps(execute);
    const outcome = await runLoadtestCli(
      {
        ...LOAD_DEFAULTS,
        scenario: 'webhook',
        vus: 20,
        usersN: 7,
        duration: '2m',
        ramp: '5:50',
        live: true,
        slo: 'p95=500ms',
        constrain: 'rc=2cpu/2g',
        slowms: 75,
        stats: true,
        save: 'After Fix',
        compare: 'Before Fix',
        report: true,
        reportPath: '/isolated/result.md',
      },
      sink(),
      deps,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const [req, prepared] = execute.mock.calls[0] as unknown as [
      coreLoadtest.LoadtestReq,
      coreLoadtest.LoadtestPrepared,
    ];
    expect(req).toMatchObject({
      name: 'resolved',
      scenario: 'webhook',
      vus: 20,
      usersN: 7,
      duration: '2m',
      ramp: '5:50',
      spike: null,
      live: true,
      slo: 'p95=500ms',
      constrain: 'rc=2cpu/2g',
      diag: true,
      slowms: 75,
      stats: true,
      quiet: true,
      setupWarnings: true,
      extraEnv: { RC_HOOK_PATH: '/hooks/abc' },
    });
    expect(prepared).toMatchObject({
      target: 'http://traefik:80',
      rcServices: ['rocketchat-1', 'rocketchat-2'],
      token: 'pat',
      users: [
        { username: 'alice', token: 'a', uid: 'u1' },
        { username: 'bob', token: 'b', uid: 'u2' },
      ],
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.artifacts).toEqual({
      baseline: '/isolated/baseline.json',
      report: '/isolated/loadtest.md',
    });
    expect(outcome.data).toMatchObject({
      passed: false,
      saved_baseline: '/isolated/baseline.json',
      report: '/isolated/loadtest.md',
      compare: { baseline: 'old' },
      snapshot: {
        users: 12,
        rooms: 3,
        messages: 99,
        constraints: 'rocketchat-1=2cpu/2g',
      },
    });
    expect(outcome.warnings).toEqual(
      expect.arrayContaining([
        'note: --vus is ignored when --ramp is given',
        expect.stringContaining('comparing across scenarios'),
        expect.stringContaining('different load shape'),
        expect.stringContaining('different resource constraints'),
      ]),
    );
    expect(deps.report.writeLoadtest).toHaveBeenCalledWith(
      expect.objectContaining({ version: '8.5.1', label: 'webhook', users: 2 }),
      run.summary,
      measured.sloResults,
      measured.shortStats,
      { os: 'test-os', cpu: 8, docker: '27.0', compose: '2.29' },
      '20260922T123456',
      '/isolated/result.md',
      expect.objectContaining({ snapshot: expect.any(Object), diag: expect.any(Object) }),
    );
  });

  it('keeps custom request values, suppresses seeded identities, and enables spike capture', async () => {
    const run = coreLoadtest.newLoadRun();
    run.summary = { p95: 5, rps: 10, error_rate: 0 };
    const execute = jest.fn(async () => ({
      run,
      verdict: {
        grafana: null,
        mongoSlow: null,
        passed: true,
        shortStats: null,
        sloResults: [],
        tl: {
          width_s: 1,
          span_s: 9,
          buckets: [],
          first_error_s: null,
        },
        verdictLines: [],
      },
    }));
    const deps = loadtestDeps(execute);
    const outcome = await runLoadtestCli(
      {
        ...LOAD_DEFAULTS,
        scenario: 'custom',
        endpoint: 'POST /api/v1/chat.postMessage',
        body: '{"roomId":"GENERAL"}',
        spike: '3:30',
        diag: false,
        json: false,
      },
      sink(),
      deps,
    );
    const [req, prepared] = execute.mock.calls[0] as unknown as [
      coreLoadtest.LoadtestReq,
      coreLoadtest.LoadtestPrepared,
    ];
    expect(req).toMatchObject({
      ramp: null,
      spike: '3:30',
      quiet: false,
      extraEnv: {
        RC_METHOD: 'POST',
        RC_PATH: '/api/v1/chat.postMessage',
        RC_BODY: '{"roomId":"GENERAL"}',
      },
    });
    expect(prepared.users).toEqual([]);
    expect(deps.core.loginSeedUsers).not.toHaveBeenCalled();
    expect(deps.createIncomingWebhook).not.toHaveBeenCalled();
    expect(outcome.exitCode).toBe(0);
    expect(outcome.data.ctx).toEqual(
      expect.objectContaining({ label: 'custom POST /api/v1/chat.postMessage', spike: '3:30' }),
    );
  });

  it.each([
    [{ endpoint: '/x' }, '--endpoint/--body only apply'],
    [{ scenario: 'custom' }, '--scenario custom needs --endpoint'],
    [{ ramp: '1:2', spike: '1:3' }, 'mutually exclusive'],
    [{ vus: 0 }, '--vus must be >= 1'],
    [{ usersN: -1 }, '--users must be >= 0'],
    [{ scenario: 'custom', endpoint: 'GET /x', body: '{}' }, '--body is not sent'],
    [{ ramp: '1:x' }, 'bad --ramp: ramp START and END must be integers'],
    [{ endpoint: 'TRACE /x', scenario: 'custom' }, "bad --endpoint: unsupported method 'TRACE'"],
    [{ slo: 'nonsense' }, 'bad --slo'],
    [{ constrain: 'rc=lots' }, 'bad --constrain'],
    [{ scenario: 'frob' }, "unknown scenario 'frob'"],
    [{ ramp: 'abc' }, 'bad --ramp: ramp must be START:END'],
    [{ save: '///' }, "'///' is not a usable baseline name"],
    // Passed to k6 unchecked: it started, failed, and the command exited 1.
    [{ duration: 'forever' }, "bad --duration: 'forever' is not a duration"],
  ] as const)(
    'rejects a wrong load option as a usage error, exit 2, after the engine and before any workspace read: %j',
    async (fields, text) => {
      const deps = loadtestDeps(jest.fn(), {
        constrain: { ...constrain },
      });
      const refusal = await runLoadtestCli({ ...LOAD_DEFAULTS, ...fields }, sink(), deps).then(
        () => null,
        (error: unknown) => error,
      );
      // A plain REPRO_ERROR, exit 1, until L7-07: the GUI's preflight raised a ValidationError
      // for the same refusals, and every other command's bad flag is exit 2.
      expect(refusal).toBeInstanceOf(ValidationError);
      expect(refusal).toMatchObject({
        code: 'VALIDATION_FAILED',
        exitCode: 2,
        message: expect.stringContaining(text),
      });
      expect(deps.requireDocker).toHaveBeenCalledTimes(1);
      expect(deps.readMeta).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ live: true }, {}, ValidationError, 2, '--live needs the monitoring stack'],
    [
      { live: true },
      {
        readMeta: jest.fn(async () => meta({ monitoring: true })),
        // A string-form command, which is not the list earlier releases walk.
        readCompose: jest.fn(async () => ({
          services: { prometheus: { command: '--web.enable-remote-write-receiver' } },
        })),
      },
      ValidationError,
      2,
      '--live needs Prometheus with remote-write enabled',
    ],
    [
      { scenario: 'webhook' },
      { createIncomingWebhook: jest.fn(async () => '') },
      ReproError,
      1,
      'could not create',
    ],
    // A missing named thing is 4, as a missing workspace is; it was a plain exit 1 (L7-07).
    [
      { compare: 'gone' },
      { baseline: { ...baseline } },
      NotFoundError,
      4,
      "no saved baseline 'gone'",
    ],
  ] as const)(
    'refuses what the workspace cannot do, each with its own class: %j',
    async (fields, overrides, kind, exitCode, text) => {
      const deps = loadtestDeps(jest.fn(), {
        readMeta: jest.fn(async () => meta()),
        ...overrides,
      } as Partial<PerfCliDependencies>);
      const refusal = await runLoadtestCli({ ...LOAD_DEFAULTS, ...fields }, sink(), deps).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toMatchObject({
        constructor: kind,
        exitCode,
        message: expect.stringContaining(text),
      });
    },
  );

  it.each([
    [new RequestFailed('offline', 'http://127.0.0.1:19001'), NotReadyError, 5, 'not answering yet'],
    [new Error('HTTP 429 Too Many Requests'), NotReadyError, 5, 'rate-limiting token creation'],
    [new Error('bad credentials'), ReproError, 1, 'the load test cannot sign in: bad credentials'],
  ] as const)(
    'preserves the authentication error class and exit semantics for %s',
    async (failure, kind, exitCode, message) => {
      const deps = loadtestDeps(jest.fn(), {
        login: jest.fn(async () => {
          throw failure;
        }),
      });
      let caught: unknown;
      try {
        await runLoadtestCli(LOAD_DEFAULTS, sink(), deps);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(kind);
      expect(caught).toMatchObject({ exitCode, message: expect.stringContaining(message) });
    },
  );
});

describe('the CLI capacity orchestration', () => {
  it('maps all search controls, writes the requested report, and uses CLI result wording', async () => {
    const search = coreLoadtest.newCapacitySearch();
    search.steps = [
      {
        vus: 25,
        rps: 12,
        p95: 700,
        error_rate: 0.03,
        ok: false,
        lag_max_s: 1.2,
        breached: ['p95 <= 400ms (actual 700ms)'],
      },
    ];
    search.firstFail = 25;
    const execute = jest.fn(async () => ({
      search,
      result: 'breaches the SLO even at 25 VUs - start lower',
      why: 'service wording is deliberately ignored by the CLI adapter',
    }));
    const core = {
      ...coreLoadtest,
      requireComposeForPerf: jest.fn(async () => undefined),
      loadtestTarget: jest.fn(() => 'http://rocketchat:3000'),
      rcServicesIn: jest.fn(() => ['rocketchat']),
      loginSeedUsers: jest.fn(async () => [{ username: 'alice' }]),
      runPreparedCapacity: execute,
    } as typeof coreLoadtest;
    const deps = loadtestDeps(jest.fn(), {
      core,
      readMeta: jest.fn(async () => meta()),
      readCompose: jest.fn(async () => ({ services: { rocketchat: {}, mongodb: {} } })),
    });
    const outcome = await runCapacityCli(
      {
        ...CAPACITY_DEFAULTS,
        scenario: 'mixed',
        usersN: 5,
        slo: 'p95=400ms,error=1%',
        start: 25,
        maxVus: 200,
        stepDuration: '45s',
        constrain: 'rc=2cpu/2g',
        reportPath: '/isolated/capacity-dest.md',
      },
      sink(),
      deps,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const [req, prepared] = execute.mock.calls[0] as unknown as [
      coreLoadtest.CapacityReq,
      coreLoadtest.CapacityPrepared,
    ];
    expect(req).toEqual({
      name: 'resolved',
      scenario: 'mixed',
      usersN: 5,
      slo: 'p95=400ms,error=1%',
      start: 25,
      maxVus: 200,
      stepDuration: '45s',
      constrain: 'rc=2cpu/2g',
    });
    expect(prepared).toMatchObject({
      target: 'http://rocketchat:3000',
      rcServices: ['rocketchat'],
      users: [{ username: 'alice' }],
    });
    expect(outcome).toMatchObject({
      exitCode: 0,
      artifacts: { report: '/isolated/capacity.md' },
      data: {
        capacity_vus: null,
        breach_vus: 25,
        result: 'breaches the SLO even at 25 VUs — start lower (--start)',
        why: 'at 25 VUs the RC event loop saturated (lag peaked at 1.20s)',
      },
    });
    expect(deps.report.writeCapacity).toHaveBeenCalledWith(
      expect.objectContaining({
        version: '8.5.1',
        users: 1,
        step_duration: '45s',
        constrained: 'rocketchat-1=2cpu/2g',
      }),
      search.steps,
      'breaches the SLO even at 25 VUs — start lower (--start)',
      'at 25 VUs the RC event loop saturated (lag peaked at 1.20s)',
      { os: 'test-os', cpu: 8, docker: '27.0', compose: '2.29' },
      '20260922T123456',
      '/isolated/capacity-dest.md',
    );
  });

  it.each([
    [{ scenario: 'custom' }, 'capacity supports the built-in scenarios'],
    [{ start: 0 }, '--start must be >= 1 and --max >= --start'],
    [{ start: 20, maxVus: 10 }, '--start must be >= 1 and --max >= --start'],
    [{ stepDuration: 'a while' }, "bad --step-duration: 'a while' is not a duration"],
    [{ slo: 'unknown=1' }, 'bad --slo'],
    [{ start: -5 }, '--start must be >= 1 and --max >= --start'],
    [{ constrain: 'rc=lots' }, 'bad --constrain'],
    [{ scenario: 'webhook' }, 'capacity supports the built-in scenarios'],
  ] as const)(
    'rejects an unsupported search as a usage error, exit 2, after the engine and before reading the workspace: %j',
    async (fields, text) => {
      const deps = loadtestDeps(jest.fn(), { constrain: { ...constrain } });
      const refusal = await runCapacityCli({ ...CAPACITY_DEFAULTS, ...fields }, sink(), deps).then(
        () => null,
        (error: unknown) => error,
      );
      // REPRO_ERROR, exit 1, until L7-07.
      expect(refusal).toMatchObject({
        constructor: ValidationError,
        code: 'VALIDATION_FAILED',
        exitCode: 2,
        message: expect.stringContaining(text),
      });
      expect(deps.requireDocker).toHaveBeenCalledTimes(1);
      expect(deps.readMeta).not.toHaveBeenCalled();
    },
  );
});

describe('Commander to performance-handler integration', () => {
  afterEach(() => {
    jest.dontMock('../../src/cli/perf');
    jest.resetModules();
  });

  it('maps actual loadtest and capacity argv and propagates the loadtest SLO exit', async () => {
    const load = jest.fn(async () => ({
      data: { passed: false, warnings: ['measured warning'] },
      exitCode: 1,
      warnings: ['measured warning'],
      artifacts: {},
    }));
    const capacity = jest.fn(async () => ({
      data: { capacity_vus: 40 },
      exitCode: 0,
      warnings: [],
      artifacts: {},
    }));
    jest.resetModules();
    jest.doMock('../../src/cli/perf', () => ({
      ...jest.requireActual<object>('../../src/cli/perf'),
      runLoadtestCli: load,
      runCapacityCli: capacity,
    }));
    const { runCli } = require('../../src/cli/app') as typeof AppNS;
    const { createExecutor } = require('../../src/cli/handlers') as typeof HandlersNS;
    let stdout = '';
    let stderr = '';
    const io = {
      writeOut: (text: string) => {
        stdout += text;
      },
      writeErr: (text: string) => {
        stderr += text;
      },
    };
    const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
    try {
      const loadExit = await runCli(
        [
          'loadtest',
          '--name',
          'w',
          '--scenario',
          'custom',
          '--endpoint',
          'POST /api/v1/x',
          '--body',
          '{}',
          '--vus',
          '12',
          '--users',
          '4',
          '--duration',
          '1m',
          '--ramp',
          '2:20',
          '--live',
          '--slo',
          'p95=500ms',
          '--constrain',
          'rc=2cpu/2g',
          '--no-diag',
          '--slowms',
          '55',
          '--stats',
          '--save',
          'after',
          '--compare',
          'before',
          '--report',
          '--report-path',
          '/isolated/load.md',
          '--json',
        ],
        { execute: createExecutor(io), io },
      );
      expect(loadExit).toBe(1);
      expect(stderr).toBe('');
      expect(load).toHaveBeenCalledWith(
        {
          name: 'w',
          scenario: 'custom',
          endpoint: 'POST /api/v1/x',
          body: '{}',
          vus: 12,
          usersN: 4,
          duration: '1m',
          ramp: '2:20',
          spike: '',
          live: true,
          slo: 'p95=500ms',
          constrain: 'rc=2cpu/2g',
          diag: false,
          slowms: 55,
          stats: true,
          save: 'after',
          compare: 'before',
          json: true,
          report: true,
          reportPath: '/isolated/load.md',
        },
        io,
        undefined,
        expect.any(Function),
      );
      // A missed SLO is a failure on both channels: exit 1 came under `ok: true, error: null`,
      // so a script branching on `ok` and one on the exit code read different answers. The
      // run's numbers stay in `data`.
      expect(JSON.parse(stdout.trim())).toMatchObject({
        schema: 'houston.error.v1',
        ok: false,
        data: { passed: false, warnings: ['measured warning'] },
        error: { code: 'REPRO_ERROR', message: expect.stringContaining('missed its --slo') },
      });

      stdout = '';
      const capacityExit = await runCli(
        [
          'capacity',
          '--name',
          'w',
          '--scenario',
          'mixed',
          '--users',
          '6',
          '--slo',
          'p95=400ms',
          '--start',
          '20',
          '--max',
          '160',
          '--step-duration',
          '45s',
          '--constrain',
          'mongo=1cpu/1g',
          '--report-path',
          '/isolated/capacity.md',
          '--json',
        ],
        { execute: createExecutor(io), io },
      );
      expect(capacityExit).toBe(0);
      expect(capacity).toHaveBeenCalledWith(
        {
          name: 'w',
          scenario: 'mixed',
          usersN: 6,
          slo: 'p95=400ms',
          start: 20,
          maxVus: 160,
          stepDuration: '45s',
          constrain: 'mongo=1cpu/1g',
          json: true,
          report: false,
          reportPath: '/isolated/capacity.md',
        },
        io,
      );
      expect(JSON.parse(stdout.trim())).toMatchObject({
        schema: 'houston.capacity.v1',
        ok: true,
        data: { capacity_vus: 40 },
      });
    } finally {
      write.mockRestore();
    }
  });
});

/**
 * The seams a whole `houston capacity` or `houston loadtest` reaches, scripted: k6's
 * summaries (one per VU count for a search, one for a load test) and the event-loop lag
 * beside them, the seeded users that could log in, Rocket.Chat's settings, the baseline to
 * compare with, and a restore that may report problems. Everything else is the real CLI,
 * from argv to the last line.
 */
interface PerfScript {
  /** Each VU count's summary; a key left out is one k6's summary did not carry. */
  steps?: Record<number, { rps: number; p95: number; error_rate?: number; lag?: number }>;
  summary?: Record<string, unknown>;
  users: number;
  restoreProblems: readonly string[];
  /** As found; absent, the limiter is already off and the metrics already on. */
  settings?: Record<string, unknown>;
  setOk?: boolean;
  base?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  compose?: Record<string, unknown>;
  /** Why the caps could not be applied, if they could not. */
  applyError?: string;
  /** Why k6 left no summary to read, if it did not. */
  k6Error?: string;
  /** What --diag and --spike read back: the timeline, the profiler, RC's own metrics. */
  timeline?: Record<string, unknown>;
  mongoPrior?: Record<string, unknown>;
  mongo?: Record<string, unknown>;
  rcm?: Record<string, unknown>;
  /** The --stats sampler's report, by full container name. */
  resources?: Record<string, Record<string, number>>;
}

type CapacityScript = PerfScript & Required<Pick<PerfScript, 'steps'>>;

interface Driven {
  code: number;
  out: string;
  err: string;
  envelope: string;
  teed: string[];
}

async function drivePerf(argv: readonly string[], script: PerfScript): Promise<Driven> {
  jest.resetModules();
  let current = 0;
  const partial = <T extends object>(module: string, extra: Partial<T>): T => ({
    ...jest.requireActual<T>(module),
    ...extra,
  });
  jest.doMock('../../src/core/lifecycle/preconditions', () =>
    partial('../../src/core/lifecycle/preconditions', { requireDocker: async () => undefined }),
  );
  jest.doMock('../../src/core/lifecycle/naming', () =>
    partial('../../src/core/lifecycle/naming', { resolveName: async (name: string) => name }),
  );
  jest.doMock('../../src/core/runner/record', () =>
    partial('../../src/core/runner/record', {
      readMeta: async () => meta(script.extra ?? {}),
      readCompose: async () => script.compose ?? { services: { rocketchat: {}, mongodb: {} } },
      adminPass: () => 'secret',
    }),
  );
  jest.doMock('../../src/core/lifecycle/admin', () =>
    partial('../../src/core/lifecycle/admin', {
      login: async () => ({ token: 'admin', userId: 'admin-id' }),
    }),
  );
  jest.doMock('../../src/core/rcapi', () =>
    partial('../../src/core/rcapi', {
      generatePat: async () => 'pat',
      getSetting: async (...args: unknown[]) =>
        script.settings === undefined
          ? args[3] !== 'API_Enable_Rate_Limiter'
          : script.settings[String(args[3])],
      setSetting: async () => script.setOk ?? true,
      // The report snapshot's statistics, which are best-effort and print nothing.
      call: async (): Promise<[number, string]> => [500, ''],
    }),
  );
  jest.doMock('../../src/core/loadtest', () =>
    partial('../../src/core/loadtest', {
      requireComposeForPerf: async () => undefined,
      loginSeedUsers: async () =>
        Array.from({ length: script.users }, (_, i) => ({ username: `u${String(i)}` })),
    }),
  );
  jest.doMock('../../src/perf/k6', () =>
    partial('../../src/perf/k6', {
      run: async (_name: string, _scenario: string, opts: { vus: number }) => {
        if (script.k6Error !== undefined) throw new Error(script.k6Error);
        if (script.summary !== undefined) return { ...script.summary };
        current = opts.vus;
        const step = script.steps?.[opts.vus];
        if (step === undefined) throw new Error(`no step scripted for ${String(opts.vus)}`);
        return Object.fromEntries(Object.entries(step).filter(([key]) => key !== 'lag'));
      },
    }),
  );
  class Sampler {
    start(): this {
      return this;
    }
    async stop(): Promise<Record<string, unknown>> {
      if (script.steps === undefined) return script.rcm ?? {};
      const lag = script.steps[current]?.lag ?? 0;
      return { rocketchat: { eventloop_lag_max_s: { max: lag } } };
    }
  }
  jest.doMock('../../src/perf/rcmetrics', () =>
    partial('../../src/perf/rcmetrics', { RCMetricsSampler: Sampler as never }),
  );
  jest.doMock('../../src/perf/constrain', () =>
    partial('../../src/perf/constrain', {
      apply: async () => {
        if (script.applyError !== undefined) throw new Error(script.applyError);
        return [];
      },
      restore: async () => [...script.restoreProblems],
    }),
  );
  jest.doMock('../../src/perf/report', () =>
    partial('../../src/perf/report', {
      writeCapacity: () => '/isolated/capacity.md',
      writeLoadtest: () => '/isolated/loadtest.md',
    }),
  );
  jest.doMock('../../src/perf/baseline', () =>
    partial('../../src/perf/baseline', {
      load: () => {
        if (script.base === undefined) throw new Error('no baseline scripted');
        return { ...script.base };
      },
      save: (label: string) => `/isolated/${label}.json`,
    }),
  );
  jest.doMock('../../src/perf/mongoprof', () =>
    partial('../../src/perf/mongoprof', {
      start: async () => (script.mongoPrior ?? null) as never,
      collect: async () => (script.mongo ?? null) as never,
      stop: async () => undefined,
    }),
  );
  jest.doMock('../../src/perf/timeline', () =>
    partial('../../src/perf/timeline', { parse: () => (script.timeline ?? null) as never }),
  );
  class Monitor {
    start(): this {
      return this;
    }
    async stop(): Promise<Record<string, unknown>> {
      return script.resources ?? {};
    }
    memSlopes(): Record<string, number> {
      return {};
    }
  }
  jest.doMock('../../src/perf/resources', () =>
    partial('../../src/perf/resources', { ResourceMonitor: Monitor as never }),
  );
  jest.doMock('../../src/core/runner/host', () =>
    partial('../../src/core/runner/host', {
      dockerServerVersion: async () => '27.0',
      composeVersion: async () => '2.29',
    }),
  );
  const { runCli } = require('../../src/cli/app') as typeof AppNS;
  const { createExecutor } = require('../../src/cli/handlers') as typeof HandlersNS;
  const events = require('../../src/lib/events') as typeof EventsNS;
  // What the event log's sink would record: earlier releases' run raises no event at all.
  const teed: string[] = [];
  const release = events.installSink('perf-test', (event) => {
    teed.push(event.message);
  });
  let out = '';
  let err = '';
  let envelope = '';
  const io = {
    writeOut: (text: string) => {
      out += text;
    },
    writeErr: (text: string) => {
      err += text;
    },
  };
  const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    envelope += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  });
  try {
    const code = await runCli([...argv], { execute: createExecutor(io), io });
    return { code, out, err, envelope, teed };
  } finally {
    write.mockRestore();
    release();
  }
}

/**
 * An envelope line as written, with only the two fields that differ by when and by which
 * build wrote it masked: its numbers keep their spelling, which `JSON.parse` would not.
 */
function envelopeText(text: string): string {
  return text
    .trim()
    .replace(/"generated_at": "[^"]*"/u, '"generated_at": "$GEN"')
    .replace(/"houston_version": "[^"]*"/u, '"houston_version": "$VER"');
}

/**
 * A capacity search as the recorded runs were scripted: the SLO, the start, the ceiling and
 * the step length, any caps, where the report went, and whether --json was given.
 */
interface CapacityCase {
  scenario: string;
  slo: string;
  start: number;
  max: number;
  step_duration: string;
  constrain: string;
  report_path: string;
  json: boolean;
}

function capacityArgv(spec: CapacityCase, script: CapacityScript): string[] {
  return [
    'capacity',
    '--name',
    'resolved',
    '--scenario',
    spec.scenario,
    '--users',
    String(script.users),
    '--slo',
    spec.slo,
    '--start',
    String(spec.start),
    '--max',
    String(spec.max),
    '--step-duration',
    spec.step_duration,
    ...(spec.constrain === '' ? [] : ['--constrain', spec.constrain]),
    ...(spec.report_path === '' ? [] : ['--report-path', spec.report_path]),
    ...(spec.json ? ['--json'] : []),
  ];
}

describe('capacity, rendered as it runs, as earlier releases rendered it', () => {
  afterEach(() => {
    jest.resetModules();
  });

  // Doubles 10 -> 20 -> 40 (a breach), then bisects at 30 and 35: every row shape, a p95 of
  // a second and more in seconds, a half-even .1f, the tag's padding and a FAIL's reasons.
  const BISECTED: CapacityScript = {
    steps: {
      10: { rps: 35, p95: 100, error_rate: 0 },
      20: { rps: 71.25, p95: 1000, error_rate: 0.004 },
      40: { rps: 90.5, p95: 2500, error_rate: 0.03, lag: 0.7 },
      30: { rps: 80, p95: 1200, error_rate: 0.01 },
      35: { rps: 85.05, p95: 1600, error_rate: 0.02, lag: 0.2 },
    },
    users: 0,
    restoreProblems: [],
  };
  const HELD: CapacityScript = {
    steps: {
      10: { rps: 35, p95: 100, error_rate: 0 },
      20: { rps: 70, p95: 180, error_rate: 0 },
    },
    users: 3,
    restoreProblems: [
      'rocketchat: could not determine CPU/memory capacity to restore - the daemon went away',
    ],
  };
  const BASE: CapacityCase = {
    scenario: 'journey',
    slo: 'p95=1500ms,error=2%',
    start: 10,
    max: 80,
    step_duration: '1s',
    constrain: '',
    report_path: '',
    json: false,
  };

  it.each([
    [
      'a bisected search with the report it wrote',
      { ...BASE, report_path: 'out/cap.md' },
      BISECTED,
    ],
    [
      'a constrained search as seeded users, whose caps could not be restored',
      { ...BASE, max: 20, constrain: 'rc=2cpu/2g,mongo=1cpu/1g' },
      HELD,
    ],
  ] as const)(
    'prints what earlier releases printed, and nothing else: %s',
    async (label, spec, script) => {
      const expected = recorded('capacity', label);
      expect(expected.code).toBe(0);
      const driven = await drivePerf(capacityArgv(spec, script), script);
      expect(driven.code).toBe(0);
      expect(driven.out).toBe(expected.out);
      expect(driven.err).toBe(expected.err);
      expect(driven.envelope).toBe('');
      expect(driven.teed).toEqual([]);
    },
  );

  it('says a failed restore on stderr under --json, and keeps the envelope data', async () => {
    const spec = { ...BASE, max: 20, constrain: 'rc=2cpu/2g', json: true };
    const expected = recorded('capacity', 'a failed restore under --json');
    expect(expected.code).toBe(0);
    const driven = await drivePerf(capacityArgv(spec, HELD), HELD);
    expect(driven.code).toBe(0);
    expect(driven.out).toBe('');
    expect(driven.err).toBe(expected.err);
    expect(driven.err).toContain('⚠ could not restore resource limits — rocketchat:');
    const recordedEnvelope = JSON.parse(expected.out) as { data: unknown };
    const ours = JSON.parse(driven.envelope) as { data: unknown };
    expect(ours.data).toEqual(recordedEnvelope.data);
    expect(driven.teed).toEqual([]);
  });

  it("writes each step's floats as earlier releases wrote each step's row", async () => {
    // An integral lag and one a summary without its error rate: `lag_max_s` is always a
    // float, and so is the error rate earlier releases default a missing key to, where what
    // k6 wrote is written as k6 wrote it.
    const script: CapacityScript = {
      steps: {
        10: { rps: 35, p95: 100, error_rate: 0 },
        20: { rps: 70, p95: 180, lag: 1 },
        40: { rps: 90, p95: 2500, error_rate: 0.03 },
        30: { rps: 80, p95: 1200 },
        35: { rps: 85, p95: 1600 },
      },
      users: 0,
      restoreProblems: [],
    };
    const spec = { ...BASE, slo: 'p95=1500ms', max: 40, json: true };
    const expected = recorded('capacity', "each step's floats under --json");
    expect(expected.code).toBe(0);
    const driven = await drivePerf(capacityArgv(spec, script), script);
    expect(driven.code).toBe(0);
    expect(envelopeText(driven.envelope)).toBe(envelopeText(expected.out));
    expect(driven.envelope).toContain('"error_rate": 0.0, "lag_max_s": 1.0');
  });
});

/**
 * A load test as the recorded runs were scripted, from its banner to its last saved output:
 * the run, the result, and the saved outputs' lines, with only the baseline file and the
 * report left unwritten.
 */
interface LoadCase {
  scenario: string;
  endpoint: string;
  body: string;
  vus: number;
  users_n: number;
  duration: string;
  ramp: string;
  spike: string;
  live: boolean;
  constrain: string;
  diag: boolean;
  compare: string;
  json_out: boolean;
  slo?: string;
  stats?: boolean;
  save?: string;
  report?: boolean;
}

function loadArgv(spec: LoadCase): string[] {
  const text: [string, string][] = [
    ['--scenario', spec.scenario],
    ['--endpoint', spec.endpoint],
    ['--body', spec.body],
    ['--duration', spec.duration],
    ['--ramp', spec.ramp],
    ['--spike', spec.spike],
    ['--constrain', spec.constrain],
    ['--compare', spec.compare],
    ['--slo', spec.slo ?? ''],
    ['--save', spec.save ?? ''],
  ];
  return [
    'loadtest',
    '--name',
    'resolved',
    '--vus',
    String(spec.vus),
    '--users',
    String(spec.users_n),
    ...text.flatMap(([flag, value]) => (value === '' ? [] : [flag, value])),
    ...(spec.live ? ['--live'] : []),
    spec.diag ? '--diag' : '--no-diag',
    ...(spec.stats === true ? ['--stats'] : []),
    ...(spec.report === true ? ['--report'] : []),
    ...(spec.json_out ? ['--json'] : []),
  ];
}

describe('loadtest, announced and warned as it runs, as earlier releases said it', () => {
  afterEach(() => {
    jest.resetModules();
  });

  const SUMMARY = {
    p95: 300,
    p50: 120,
    p90: 250,
    p99: 400,
    rps: 41.5,
    error_rate: 0.004,
    count: 125,
  };
  const BASE: LoadCase = {
    scenario: 'messages',
    endpoint: '',
    body: '',
    vus: 10,
    users_n: 10,
    duration: '1s',
    ramp: '',
    spike: '',
    live: false,
    constrain: '',
    diag: false,
    compare: '',
    json_out: false,
  };
  // Every warning a run can give before, during and after it: the ignored --vus, seeded
  // users that could not log in, a limiter that would not switch off, a constrained run,
  // three baseline mismatches and caps that could not be put back.
  const WARNED: LoadCase = {
    ...BASE,
    vus: 12,
    ramp: '0:20',
    constrain: 'rc=2cpu/2g',
    compare: 'b0',
  };
  const WARNED_SCRIPT: PerfScript = {
    summary: SUMMARY,
    users: 0,
    restoreProblems: ['rocketchat: docker update failed: the daemon went away'],
    settings: { API_Enable_Rate_Limiter: true },
    setOk: false,
    base: {
      label: 'b0',
      saved_at: '2020-01-01T00:00:00+00:00',
      ctx: { scenario: 'read', vus: 3, ramp: '', spike: '' },
      summary: { p95: 200, rps: 5, error_rate: 0 },
      snapshot: { constraints: 'rocketchat=1cpu/1g' },
    },
  };
  // A custom spike under --live, with the profiler unavailable to --diag.
  const LIVE: LoadCase = {
    ...BASE,
    scenario: 'custom',
    endpoint: 'POST /api/v1/chat.postMessage',
    body: '{"roomId":"GENERAL"}',
    spike: '10:100',
    live: true,
    diag: true,
  };
  const LIVE_SCRIPT: PerfScript = {
    summary: SUMMARY,
    users: 2,
    restoreProblems: [],
    settings: { API_Enable_Rate_Limiter: false, Prometheus_Enabled: true },
    extra: { monitoring: true },
    compose: {
      services: {
        rocketchat: {},
        mongodb: {},
        prometheus: { command: ['--web.enable-remote-write-receiver'] },
      },
    },
  };

  it.each([
    ['every warning, the moment it happens', WARNED, WARNED_SCRIPT],
    [
      'a spike as seeded users',
      { ...BASE, users_n: 2, spike: '5:50' },
      { summary: SUMMARY, users: 2, restoreProblems: [], settings: LIVE_SCRIPT.settings ?? {} },
    ],
    ['the live hint and the diagnostics a custom run cannot arm', LIVE, LIVE_SCRIPT],
  ] as const)(
    'says what earlier releases said, before and after its result: %s',
    async (label, spec, script) => {
      const expected = recorded('loadtest', label);
      expect(expected.code).toBe(0);
      const driven = await drivePerf(loadArgv(spec), script);
      expect(driven.code).toBe(0);
      // The whole stdout, result panel included: nothing said during the run is said again.
      expect(driven.out).toBe(expected.out);
      expect(driven.out.match(/⚠ baseline 'b0' was a 'read' run/gu) ?? []).toHaveLength(
        spec === WARNED ? 1 : 0,
      );
      expect(driven.err).toBe(expected.err);
      expect(driven.teed).toEqual([]);
    },
  );

  it('keeps every warning for data.warnings under --json, and says none of them', async () => {
    const spec = { ...WARNED, json_out: true };
    const expected = recorded('loadtest', 'every warning under --json');
    expect(expected.code).toBe(0);
    const driven = await drivePerf(loadArgv(spec), WARNED_SCRIPT);
    expect(driven.code).toBe(0);
    expect(driven.out).toBe('');
    expect(driven.err).toBe(expected.err);
    const recordedEnvelope = JSON.parse(expected.out) as { data: { warnings: string[] } };
    const ours = JSON.parse(driven.envelope) as { data: { warnings: string[] } };
    expect(recordedEnvelope.data.warnings.length).toBeGreaterThan(5);
    expect(ours.data.warnings).toEqual(recordedEnvelope.data.warnings);
    expect(driven.teed).toEqual([]);
  });
});

describe("loadtest's result, as earlier releases drew it and said where it was saved", () => {
  afterEach(() => {
    jest.resetModules();
  });

  const RUN: LoadCase = {
    scenario: 'journey',
    endpoint: '',
    body: '',
    vus: 10,
    users_n: 10,
    duration: '1s',
    ramp: '',
    spike: '',
    live: false,
    constrain: '',
    diag: false,
    compare: '',
    json_out: false,
  };
  // Every row the panel has, a tie earlier releases round to even (210.5 -> 210ms, where
  // `toFixed` says 211), a latency past a second, 429s among the responses, and steps of which one
  // has no p50.
  const FULL = {
    rps: 41.5,
    count: 1245,
    avg: 120.25,
    min: 3.1,
    max: 2500.5,
    p50: 80,
    p90: 210.5,
    p95: 300,
    p99: 1500,
    error_rate: 0.004,
    checks_rate: 0.99,
    status: { '2xx': 1180, '429': 60, '4xx': 5, '5xx': 0, other: 0 },
    steps: {
      zeta: { count: 3, p95: 40 },
      login: { count: 10, p50: 50, p95: 90, p99: 120.5 },
      post: { count: 400, p50: 62.5, p95: 1250, p99: 3000 },
    },
  };
  const QUIET: PerfScript = {
    summary: FULL,
    users: 2,
    restoreProblems: [],
  };
  // The diagnosis, every section of it: a sparkline with errors in it, RC's lag peak with
  // its p99, its heap and DDP users, a slow COLLSCAN, and a spike that recovered.
  const DIAG: PerfScript = {
    ...QUIET,
    mongoPrior: { was: 0, slowms: 100 },
    mongo: {
      total: 3,
      collscan: 1,
      slow: [
        {
          ns: 'rocketchat.rocketchat_message',
          op: 'query',
          millis: 1250,
          plan: 'COLLSCAN',
          docs: 5000,
          keys: 0,
          ret: 10,
          cmd: '{}',
        },
        { ns: 'rocketchat.users', op: 'update', millis: 150, plan: '', docs: 1, keys: 1, ret: 0 },
      ],
    },
    rcm: {
      'rocketchat-2': { eventloop_lag_s: { max: 0.004, mean: 0.002, last: 0.001, n: 3 } },
      'rocketchat-1': {
        eventloop_lag_max_s: { max: 0.62, mean: 0.3, last: 0.1, n: 3 },
        eventloop_lag_p99_s: { max: 0.41, mean: 0.2, last: 0.1, n: 3 },
        heap_used_bytes: { max: 312500000, mean: 3e8, last: 3e8, n: 3 },
        ddp_users: { max: 12, mean: 10, last: 9, n: 3 },
      },
    },
    timeline: {
      width_s: 1,
      span_s: 8,
      first_error_s: 4,
      buckets: [100, 110, 900, 1200, 950, 130, 120, 115, 110].map((p95, t0) => ({
        t0,
        reqs: 5,
        p50: p95 / 2,
        p95,
        max: p95 + 1,
        errors: t0 === 4 || t0 === 5 ? 1 : 0,
      })),
    },
    resources: {
      'houston-resolved-rocketchat-1': {
        idle_cpu: 1.5,
        peak_cpu: 180.5,
        idle_mem: 3e8,
        peak_mem: 6.5e8,
        limit_mem: 2e9,
        peak_cpu_t: 3,
      },
      'houston-resolved-rocketchat-2': {
        idle_cpu: 0.5,
        peak_cpu: 90,
        idle_mem: 2e8,
        peak_mem: 4e8,
        limit_mem: 2e9,
        peak_cpu_t: 4,
      },
      'houston-resolved-mongodb-1': {
        idle_cpu: 0.4,
        peak_cpu: 60,
        idle_mem: 1.26e8,
        peak_mem: 2.5e8,
        limit_mem: 2e9,
        peak_cpu_t: 2,
      },
    },
  };
  // A baseline that was a smaller, cleaner run: every compare row, a regression among them.
  const COMPARED: PerfScript = {
    ...QUIET,
    base: {
      label: 'b0',
      saved_at: '2026-09-20T10:00:00.123456+00:00',
      ctx: { scenario: 'journey', label: 'journey', vus: 10, ramp: '', spike: '' },
      summary: {
        rps: 50,
        p50: 70,
        p95: 250,
        p99: 600,
        error_rate: 0,
        steps: { login: { p95: 40 }, post: { p95: 1300 } },
      },
      snapshot: {},
    },
  };

  it.each([
    [
      'every row of the panel, the step table, SLO rules and the saved outputs',
      { ...RUN, slo: 'p95=200ms,error=1%,rps=100,p50=1s', save: 'After Fix', report: true },
      QUIET,
      1,
    ],
    ['a run with no rules, and no gate', RUN, QUIET, 0],
    [
      'a zero-request run, unmeasured metrics as -',
      { ...RUN, ramp: '0:20' },
      {
        ...QUIET,
        users: 0,
        summary: {
          rps: 0,
          count: 0,
          error_rate: 0,
          checks_rate: null,
          status: { '2xx': 0, '429': 0, '4xx': 0, '5xx': 0, other: 0 },
        },
      },
      0,
    ],
    [
      'a spike with the whole diagnosis and the resource cost',
      { ...RUN, spike: '10:100', diag: true, stats: true, constrain: 'rc=2cpu/2g' },
      DIAG,
      0,
    ],
    ['a comparison with the baseline it was made against', { ...RUN, compare: 'b0' }, COMPARED, 0],
  ] as const)('draws %s', async (label, spec, script, code) => {
    const expected = recorded('loadtest', label);
    expect(expected.code).toBe(code);
    const driven = await drivePerf(loadArgv(spec), script);
    expect(driven.code).toBe(code);
    expect(driven.out).toBe(expected.out);
    expect(driven.err).toBe(expected.err);
    expect(driven.teed).toEqual([]);
  });

  it("writes the envelope's computed numbers as earlier releases wrote their floats", async () => {
    // Integral values everywhere an earlier release makes a float: an SLO threshold and
    // actual, a compare row against a zero error rate (pct 0.0), the timeline and its
    // spike, RC's metrics and the containers' resource cost. k6's own summary is written as
    // k6 wrote it, which is JSON.stringify's integers.
    const script: PerfScript = {
      ...DIAG,
      rcm: { rocketchat: { eventloop_lag_max_s: { max: 1, mean: 1, last: 1, n: 2 } } },
      resources: {
        'houston-resolved-rocketchat-1': {
          idle_cpu: 0,
          peak_cpu: 180,
          idle_mem: 3e8,
          peak_mem: 6.5e8,
          limit_mem: 2e9,
          peak_cpu_t: 3,
        },
      },
      base: {
        label: 'b0',
        saved_at: '2026-09-20T10:00:00+00:00',
        ctx: { scenario: 'journey', vus: 10, ramp: '', spike: '10:100' },
        summary: { rps: 50, p95: 300, error_rate: 0 },
        snapshot: { constraints: 'rocketchat=2cpu/2g' },
      },
    };
    const spec = {
      ...RUN,
      spike: '10:100',
      diag: true,
      stats: true,
      constrain: 'rc=2cpu/2g',
      slo: 'p95=1s,error=0.1%',
      compare: 'b0',
      json_out: true,
    };
    const expected = recorded('loadtest', "the envelope's computed numbers");
    expect(expected.code).toBe(1);
    const driven = await drivePerf(loadArgv(spec), script);
    expect(driven.code).toBe(1);
    // This run missed its `error=0.1%` rule. Earlier releases put that under `ok: true`; it
    // is the error envelope now (the owner's 2026-10-09 decision), and its `data` is still
    // what they wrote, byte for byte -- which is what this case is about.
    const head = (text: string): string =>
      envelopeText(text).replace(/"data": \{.*\}, "error"/su, '"data": $DATA, "error"');
    const dataOf = (text: string): string =>
      /"data": (\{.*\}), "error"/su.exec(envelopeText(text))?.[1] ?? '';
    expect(dataOf(driven.envelope)).toBe(dataOf(expected.out));
    expect(head(driven.envelope)).toBe(
      head(expected.out)
        .replace(
          '"error": null',
          '"error": {"code": "REPRO_ERROR", "message": "the run missed its --slo: 0.1%"}',
        )
        .replace('"ok": true', '"ok": false')
        .replace('"schema": "houston.loadtest.v1"', '"schema": "houston.error.v1"'),
    );
    for (const spelled of [
      '"pct": 0.0',
      '"span_s": 8.0',
      '"threshold": 1000.0',
      '"idle_mem": 300000000.0',
    ]) {
      expect(driven.envelope).toContain(spelled);
    }
  });

  it('draws the result before anything is saved, and says where each output went', async () => {
    const spec = { ...RUN, save: 'After Fix', report: true };
    const driven = await drivePerf(loadArgv(spec), QUIET);
    expect(driven.code).toBe(0);
    const tail = driven.out.slice(driven.out.indexOf('+- loadtest journey (10 VUs / 1s, 2 users)'));
    expect(tail).toContain('|  throughput  41.5 req/s   (1245 requests)');
    expect(tail).toContain('p90 210ms');
    // The panel's whole milliseconds, which never turn to seconds, and round a tie to even.
    expect(tail).toContain('max 2500ms');
    // The step table's durations, which do.
    expect(tail).toContain('post        400      62ms   1.25s   3.00s');
    expect(tail).not.toContain('SLO gate');
    expect(
      tail.endsWith(
        "\n✓ saved baseline 'after-fix' (compare later with --compare after-fix)\n" +
          '\n✓ wrote /isolated/loadtest.md\n',
      ),
    ).toBe(true);
  });
});

describe('the refusals a run makes once it has started, as earlier releases made them', () => {
  afterEach(() => {
    jest.resetModules();
  });

  const GONE = "no running container for service 'rocketchat' — is the repro up?";
  const LOAD: LoadCase = {
    scenario: 'messages',
    endpoint: '',
    body: '',
    vus: 10,
    users_n: 0,
    duration: '1s',
    ramp: '',
    spike: '',
    live: false,
    constrain: 'rc=2cpu/2g',
    diag: false,
    compare: '',
    json_out: false,
  };

  it("recorded the refusals from a home of their own, never the caller's", () => {
    const ambientHome = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-perf-ambient-'));
    const previous = {
      HOME: process.env.HOME,
      HOUSTON_HOME: process.env.HOUSTON_HOME,
      HOUSTON_SKILL_HOME: process.env.HOUSTON_SKILL_HOME,
    };
    try {
      process.env.HOME = ambientHome;
      process.env.HOUSTON_HOME = path.join(ambientHome, 'state');
      process.env.HOUSTON_SKILL_HOME = path.join(ambientHome, 'skill');
      // The load test of LOAD with no users and `applyError: GONE`, and a journey search at
      // p95=500ms from 10 to 20 VUs under rc=2cpu/2g with the same failure, each recorded
      // from a HOUSTON_HOME of its own while this test's ambient home was the caller's.
      const load = recorded(
        'loadtest',
        'a load test whose caps cannot be applied, from a home of its own',
      );
      const search = recorded(
        'capacity',
        'a search whose caps cannot be applied, from a home of its own',
      );
      expect(load.code).toBe(1);
      expect(search.code).toBe(1);
      expect(load.err).toContain('could not apply --constrain');
      expect(search.err).toContain('could not apply --constrain');
      expect(fs.existsSync(path.join(ambientHome, 'state'))).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(ambientHome, { recursive: true, force: true });
    }
  });

  it.each([
    ['a load test whose caps cannot be applied', LOAD, { applyError: GONE }],
    [
      'a load test whose k6 left no summary',
      { ...LOAD, constrain: '' },
      { k6Error: 'k6 summary was unreadable (truncated) — the run likely did not finish' },
    ],
  ] as const)('refuses %s with one error line, exit 1', async (label, spec, failure) => {
    const script: PerfScript = { users: 0, restoreProblems: [], settings: {}, ...failure };
    const expected = recorded('loadtest', label);
    const driven = await drivePerf(loadArgv(spec), script);
    expect(expected.code).toBe(1);
    expect(driven.code).toBe(1);
    expect(driven.out).toBe(expected.out);
    expect(driven.err).toBe(expected.err);
  });

  it('refuses a search whose caps cannot be applied with one error line, exit 1', async () => {
    const spec: CapacityCase = {
      scenario: 'journey',
      slo: 'p95=500ms',
      start: 10,
      max: 20,
      step_duration: '1s',
      constrain: 'rc=2cpu/2g',
      report_path: '',
      json: false,
    };
    const script: CapacityScript = { steps: {}, users: 0, restoreProblems: [], applyError: GONE };
    const expected = recorded('capacity', 'a search whose caps cannot be applied');
    const driven = await drivePerf(capacityArgv(spec, script), script);
    expect(expected.code).toBe(1);
    expect(driven.code).toBe(1);
    expect(driven.out).toBe(expected.out);
    expect(driven.err).toBe(expected.err);
    expect(driven.err).toBe(`error: could not apply --constrain: ${GONE}\n`);
  });

  it('refuses a cap it cannot apply once, as earlier releases did: REPRO_ERROR, exit 1, one envelope', async () => {
    const spec = { ...LOAD, json_out: true };
    const script: PerfScript = { users: 0, restoreProblems: [], settings: {}, applyError: GONE };
    const expected = recorded('loadtest', 'a cap it cannot apply, under --json');
    const driven = await drivePerf(loadArgv(spec), script);
    const envelopes = (text: string): unknown[] =>
      text
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => (JSON.parse(line) as { error: unknown }).error);
    expect(expected.code).toBe(1);
    expect(driven.code).toBe(1);
    expect(envelopes(driven.envelope)).toEqual(envelopes(expected.out));
    expect(envelopes(driven.envelope)).toEqual([
      { code: 'REPRO_ERROR', message: `could not apply --constrain: ${GONE}` },
    ]);
    expect(driven.err).toBe(expected.err);
  });
});
