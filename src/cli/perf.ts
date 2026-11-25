/** CLI-only performance orchestration over the shared load-test service. */
import * as os from 'node:os';

import { actor as auditActor } from '../core/audit';
import * as coreLoadtest from '../core/loadtest';
import * as lifecycleAdmin from '../core/lifecycle/admin';
import { grafanaUrlOf } from '../core/lifecycle/inspect';
import * as lifecycleNaming from '../core/lifecycle/naming';
import * as lifecyclePreconditions from '../core/lifecycle/preconditions';
import * as rcapi from '../core/rcapi';
import * as runnerHost from '../core/runner/host';
import * as runnerRecord from '../core/runner/record';
import { NotReadyError, ReproError, ValidationError, errorText } from '../lib/errors';
import { nullEmit } from '../lib/events';
import { JsonFloat } from '../lib/jsonout';
import { formatFixed, shownValue, isTruthy } from '../lib/format';
import { platformName } from '../lib/platform-name';
import * as baseline from '../perf/baseline';
import * as constrain from '../perf/constrain';
import * as report from '../perf/report';
import type { Rule } from '../perf/slo';
import * as timeline from '../perf/timeline';
import { fmtMs } from '../perf/timings';
import * as verdict from '../perf/verdict';

type Bag = Record<string, unknown>;

/**
 * The CLI's two streams, as `./app`'s `CliIo` has them, and `./render`'s `say`: this
 * module sits a layer below both, so it names the shape rather than importing it.
 */
interface CliIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

/** One line of prose on stdout: a warning, a note or a plain echo. */
function say(io: CliIo, message: string): void {
  io.writeOut(`${message}\n`);
}

export interface LoadtestCliOptions {
  name: string;
  scenario: string;
  endpoint: string;
  body: string;
  vus: number;
  usersN: number;
  duration: string;
  ramp: string;
  spike: string;
  live: boolean;
  slo: string;
  constrain: string;
  diag: boolean;
  slowms: number;
  stats: boolean;
  save: string;
  compare: string;
  json: boolean;
  report: boolean;
  reportPath: string;
}

export interface CapacityCliOptions {
  name: string;
  scenario: string;
  usersN: number;
  slo: string;
  start: number;
  maxVus: number;
  stepDuration: string;
  constrain: string;
  json: boolean;
  report: boolean;
  reportPath: string;
}

export interface PerfCliOutcome {
  data: Bag;
  exitCode: number;
  warnings: string[];
  artifacts: { baseline?: string; report?: string };
}

/**
 * What the result renderer (`renderLoadtest`) draws from: the run's context and summary, the
 * SLO results, the spike line, the diagnostics when --diag armed them, the comparison with
 * the baseline it was made against (whose label, context and save time head it), and the
 * sampler's report under its FULL container names, which `renderResources` shortens itself.
 */
export interface LoadtestView {
  name: string;
  ctx: Bag;
  summary: Bag;
  slo: readonly Bag[];
  spike: timeline.SpikeRecovery | null;
  diag: {
    rcmetrics: Bag;
    mongo: Bag | null;
    timeline: timeline.Timeline | null;
    verdict: readonly string[];
  } | null;
  compare: readonly Bag[];
  base: Bag | null;
  resources: Bag;
}

export interface PerfCliDependencies {
  core: typeof coreLoadtest;
  baseline: typeof baseline;
  constrain: typeof constrain;
  report: typeof report;
  timeline: typeof timeline;
  verdict: typeof verdict;
  requireDocker: typeof lifecyclePreconditions.requireDocker;
  resolveName: typeof lifecycleNaming.resolveName;
  readMeta: typeof runnerRecord.readMeta;
  readCompose: typeof runnerRecord.readCompose;
  adminPass: typeof runnerRecord.adminPass;
  login: typeof lifecycleAdmin.login;
  generatePat: typeof rcapi.generatePat;
  createIncomingWebhook: typeof rcapi.createIncomingWebhook;
  call: typeof rcapi.call;
  dockerServerVersion: typeof runnerHost.dockerServerVersion;
  composeVersion: typeof runnerHost.composeVersion;
  now(): Date;
  platform(): string;
  cpuCount(): number;
}

export const DEFAULT_PERF_DEPS: PerfCliDependencies = {
  core: coreLoadtest,
  baseline,
  constrain,
  report,
  timeline,
  verdict,
  requireDocker: lifecyclePreconditions.requireDocker,
  resolveName: lifecycleNaming.resolveName,
  readMeta: runnerRecord.readMeta,
  readCompose: runnerRecord.readCompose,
  adminPass: runnerRecord.adminPass,
  login: lifecycleAdmin.login,
  generatePat: rcapi.generatePat,
  createIncomingWebhook: rcapi.createIncomingWebhook,
  call: rcapi.call,
  dockerServerVersion: runnerHost.dockerServerVersion,
  composeVersion: runnerHost.composeVersion,
  now: () => new Date(),
  platform: platformName,
  cpuCount: () => os.cpus().length,
};

export function perfDeps(overrides: Partial<PerfCliDependencies> = {}): PerfCliDependencies {
  return { ...DEFAULT_PERF_DEPS, ...overrides };
}

function asBag(value: unknown): Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Bag) : {};
}

/**
 * A copy of `row` in which each of `keys` holding a number is marked a FLOAT, so the
 * envelope writes `5.0`, as it always has, rather than `5`.
 *
 * For the --json envelope only: the renderer, the report and the GUI's job read the plain
 * numbers, and the web's serializer does not know a `JsonFloat`.
 */
function floatSpellings(row: unknown, keys: readonly string[]): Bag {
  const out: Bag = { ...asBag(row) };
  for (const key of keys) {
    const value = out[key];
    if (typeof value === 'number') out[key] = new JsonFloat(value);
  }
  return out;
}

/** Every value of a `{name: row}` map through `floatSpellings`. */
function eachFloatSpelling(map: unknown, keys: readonly string[]): Bag {
  return Object.fromEntries(
    Object.entries(asBag(map)).map(([k, v]) => [k, floatSpellings(v, keys)]),
  );
}

/**
 * The loadtest envelope's computed numbers, marked as the floats the envelope has always
 * carried: the SLO's `threshold` and `actual`, a compare row's `before`, `after` and `pct`
 * (and `0.0` against a zero baseline), the timeline's `span_s` and each bucket's `p50`,
 * `p95` and `max`, the spike's two p95s, each RC metric's `mean`, `max` and `last` (read
 * from the exposition text), and every field of a container's resource cost. What k6's
 * summary and the profiler wrote is left as read.
 */
function loadtestEnvelopeFloats(data: Bag): Bag {
  const out: Bag = {
    ...data,
    slo: (data.slo as unknown[]).map((r) => floatSpellings(r, ['threshold', 'actual'])),
  };
  if (data.diag !== undefined) {
    const diag = asBag(data.diag);
    const tl = diag.timeline as timeline.Timeline | null;
    out.diag = {
      ...diag,
      rcmetrics: Object.fromEntries(
        Object.entries(asBag(diag.rcmetrics)).map(([service, series]) => [
          service,
          eachFloatSpelling(series, ['mean', 'max', 'last']),
        ]),
      ),
      timeline:
        tl === null
          ? null
          : {
              ...floatSpellings(tl, ['span_s']),
              buckets: tl.buckets.map((b) => floatSpellings(b, ['p50', 'p95', 'max'])),
            },
      spike: diag.spike === null ? null : floatSpellings(diag.spike, ['baseline_p95', 'spike_p95']),
    };
  }
  if (data.resources !== undefined) {
    out.resources = eachFloatSpelling(data.resources, [
      'idle_cpu',
      'peak_cpu',
      'idle_mem',
      'peak_mem',
      'limit_mem',
      'peak_cpu_t',
    ]);
  }
  if (data.compare !== undefined) {
    const comparison = asBag(data.compare);
    out.compare = {
      ...comparison,
      rows: (comparison.rows as unknown[]).map((r) =>
        floatSpellings(r, ['before', 'after', 'pct']),
      ),
    };
  }
  return out;
}

function stamp(date: Date): string {
  return date.toISOString().replaceAll('-', '').replaceAll(':', '').slice(0, 15);
}

function isoSeconds(date: Date): string {
  return `${date.toISOString().slice(0, 19)}+00:00`;
}

/** A warning for `--json`: the message trimmed, its leading `⚠` and spaces gone. */
function stripWarning(message: string): string {
  return message.trim().replace(/^[⚠ ]+/u, '');
}

function authenticationFailure(meta: runnerRecord.Metadata, error: unknown): never {
  const message = errorText(error);
  if (error instanceof Error && error.name === 'RequestFailed') {
    throw new NotReadyError(
      `'${meta.name}' is not answering yet, so the load test cannot sign in — wait for it with ` +
        `\`houston ready --name ${meta.name}\``,
    );
  }
  if (message.includes('429') || message.includes('Too Many Requests')) {
    throw new NotReadyError(
      `Rocket.Chat is rate-limiting token creation on '${meta.name}', so the load test ` +
        'cannot sign in yet. Its limiter resets in about a minute — try again then.',
    );
  }
  throw new ReproError(`the load test cannot sign in: ${message}`);
}

async function performanceIdentity(
  deps: PerfCliDependencies,
  meta: runnerRecord.Metadata,
): Promise<{ auth: rcapi.Auth; token: string }> {
  try {
    const auth = await deps.login(meta);
    const token = await deps.generatePat(meta.rootUrl, auth, deps.adminPass(meta), {
      tokenName: 'houston-loadtest',
      bypass2fa: true,
      workspace: meta.name,
    });
    return { auth, token };
  } catch (error) {
    authenticationFailure(meta, error);
  }
}

/*
 * A FLAG THAT IS WRONG IS A ValidationError -- VALIDATION_FAILED, exit 2 -- in the option
 * checks, the capacity checks, the live-monitoring check and the constraints alike: the class
 * the GUI's own preflight in core/loadtest.ts raises for the same refusals. They were plain
 * ReproErrors, exit 1, so `loadtest --scenario frob` exited 1 where `--duration forever` and
 * every other command's bad flag exit 2. A `--compare` naming no saved baseline is the
 * baseline's own NotFoundError, exit 4. What is left as a plain ReproError, exit 1, is a
 * refusal of no more specific kind: Rocket.Chat refusing the webhook, or the API call.
 */
export function parseEndpoint(endpoint: string): [string, string] {
  const value = endpoint.trim();
  if (value === '') throw new ValidationError('bad --endpoint: empty endpoint');
  const parts = value.split(/\s+/u, 2);
  let method = 'GET';
  let target = value;
  if (parts.length === 2 && /^[A-Za-z]+$/u.test(parts[0] as string)) {
    method = (parts[0] as string).toUpperCase();
    const allowed = ['DELETE', 'GET', 'PATCH', 'POST', 'PUT'];
    if (!allowed.includes(method)) {
      throw new ValidationError(
        `bad --endpoint: unsupported method '${parts[0] as string}' (use ${allowed.join(', ')})`,
      );
    }
    target = value.slice((parts[0] as string).length).trim();
  }
  if (!target.startsWith('/')) {
    throw new ValidationError(`bad --endpoint: path must start with '/': '${target}'`);
  }
  return [method, target];
}

export function parseRamp(value: string, flag: '--ramp' | '--spike'): [number, number] {
  const cells = value.split(':');
  if (cells.length !== 2) {
    throw new ValidationError(`bad ${flag}: ramp must be START:END, e.g. 10:200`);
  }
  if (!cells.every((cell) => /^-?\d+$/u.test(cell))) {
    throw new ValidationError(`bad ${flag}: ramp START and END must be integers, e.g. 10:200`);
  }
  const start = Number(cells[0]);
  const end = Number(cells[1]);
  if (start < 0 || end < 1) {
    throw new ValidationError(`bad ${flag}: ramp needs START >= 0 and END >= 1, e.g. 10:200`);
  }
  // A spike is measured against its base, so a base of 0 VUs leaves nothing to compare.
  if (flag === '--spike' && start < 1) {
    throw new ValidationError('bad --spike: the base must be at least 1 VU, e.g. 10:100');
  }
  if (flag === '--spike' && end <= start) {
    throw new ValidationError(`--spike peak must exceed base ('${value}')`);
  }
  return [start, end];
}

function customEnvironment(options: LoadtestCliOptions): {
  extraEnv: Record<string, string | null> | null;
  method: string;
  path: string;
} {
  if (options.scenario !== 'custom') {
    if (options.endpoint !== '' || options.body !== '') {
      throw new ValidationError('--endpoint/--body only apply to --scenario custom');
    }
    return { extraEnv: null, method: '', path: '' };
  }
  if (options.endpoint === '') {
    throw new ValidationError(
      '--scenario custom needs --endpoint, e.g. --endpoint "GET /api/v1/channels.list"',
    );
  }
  const [method, path] = parseEndpoint(options.endpoint);
  if (options.body !== '' && ['GET', 'DELETE'].includes(method)) {
    throw new ValidationError(`--body is not sent with a ${method} request`);
  }
  return {
    extraEnv: { RC_METHOD: method, RC_PATH: path, RC_BODY: options.body || null },
    method,
    path,
  };
}

function validateLoadtest(
  options: LoadtestCliOptions,
  deps: PerfCliDependencies,
  warn: (message: string) => void,
): {
  constraints: Record<string, constrain.Limit>;
  extraEnv: Record<string, string | null> | null;
  method: string;
  path: string;
  rules: Rule[];
} {
  if (!deps.core.DEFAULT_DEPS.k6.SCENARIOS.includes(options.scenario)) {
    throw new ValidationError(
      `unknown scenario '${options.scenario}' (choose: ${deps.core.DEFAULT_DEPS.k6.SCENARIOS.join(', ')})`,
    );
  }
  const custom = customEnvironment(options);
  if (options.vus < 1) throw new ValidationError('--vus must be >= 1');
  coreLoadtest.refuseABadDuration(options.duration, '--duration');
  if (options.usersN < 0) throw new ValidationError('--users must be >= 0');
  if (options.ramp !== '' && options.spike !== '') {
    throw new ValidationError('--ramp and --spike are mutually exclusive load shapes');
  }
  for (const [flag, value] of [
    ['--ramp', options.ramp],
    ['--spike', options.spike],
  ] as const) {
    if (value === '') continue;
    parseRamp(value, flag);
    if (options.vus !== 10) warn(`  note: --vus is ignored when ${flag} is given`);
  }
  for (const label of [options.save, options.compare]) {
    if (label !== '') deps.baseline.sanitizeLabel(label);
  }
  let constraints: Record<string, constrain.Limit> = {};
  let rules: Rule[] = [];
  try {
    if (options.constrain !== '') constraints = deps.constrain.parse(options.constrain);
  } catch (error) {
    throw new ValidationError(`bad --constrain: ${errorText(error)}`);
  }
  try {
    if (options.slo !== '') rules = deps.core.DEFAULT_DEPS.slo.parse(options.slo);
  } catch (error) {
    throw new ValidationError(`bad --slo: ${errorText(error)}`);
  }
  return { ...custom, constraints, rules };
}

async function hostDetails(deps: PerfCliDependencies): Promise<Bag> {
  return {
    os: deps.platform(),
    cpu: deps.cpuCount() || '?',
    docker: (await deps.dockerServerVersion()) || '?',
    compose: (await deps.composeVersion()) || '?',
  };
}

async function workspaceSnapshot(
  deps: PerfCliDependencies,
  meta: runnerRecord.Metadata,
  auth: rcapi.Auth,
  instances: number,
): Promise<Bag> {
  const snapshot: Bag = {
    rc_version: meta.rcVersion,
    preset: meta.preset,
    instances,
  };
  try {
    const [status, body] = await deps.call(meta.rootUrl, 'GET', '/api/v1/statistics?refresh=true', {
      auth,
    });
    if (status === 200) {
      const parsed = asBag(JSON.parse(body));
      for (const [key, source] of [
        ['users', 'totalUsers'],
        ['rooms', 'totalRooms'],
        ['messages', 'totalMessages'],
      ] as const) {
        if (parsed[source] !== null && parsed[source] !== undefined) snapshot[key] = parsed[source];
      }
    }
  } catch {
    // A report snapshot is best-effort and must never fail the measurement.
  }
  return snapshot;
}

function loadShape(ctx: Bag): string {
  if (ctx.spike !== null && ctx.spike !== undefined && String(ctx.spike) !== '') {
    return `spike ${String(ctx.spike)}`;
  }
  if (ctx.ramp !== null && ctx.ramp !== undefined && String(ctx.ramp) !== '') {
    return `ramp ${String(ctx.ramp)}`;
  }
  return `${String(ctx.vus ?? '?')} VUs`;
}

function capacityCliVerdict(
  options: CapacityCliOptions,
  search: coreLoadtest.CapacitySearch,
): { result: string; why: string } {
  let result: string;
  if (search.lastPass === null) {
    result = `breaches the SLO even at ${String(options.start)} VUs — start lower (--start)`;
  } else if (search.firstFail === null) {
    result =
      `holds the SLO up to ${String(search.lastPass)} VUs ` +
      '(never breached; raise --max to push further)';
  } else {
    result =
      `~${String(search.lastPass)} concurrent VUs (holds at ${String(search.lastPass)}, ` +
      `breaks at ${String(search.firstFail)})`;
  }
  const breach =
    search.firstFail !== null
      ? search.steps.find((row) => row.vus === search.firstFail)
      : search.steps.find((row) => !isTruthy(row.ok));
  if (breach === undefined) return { result, why: '' };
  const lag = Number(breach.lag_max_s ?? 0);
  const why =
    lag >= 0.5
      ? `at ${String(breach.vus)} VUs the RC event loop saturated ` +
        `(lag peaked at ${fmtMs(lag * 1000)})`
      : `at ${String(breach.vus)} VUs: ` +
        (Array.isArray(breach.breached) ? breach.breached.map(String).join('; ') : '');
  return { result, why };
}

/**
 * `loadtest`, as it has always run: its banner and its warnings said as the run goes, and
 * nothing of the GUI job's narration.
 *
 * It ran the job's transaction with the CLI emitter, so the service spoke for it: a
 * '  running k6: <scenario> @ <vus> VUs ...' line in place of the bold 'Load test: ...' banner
 * and its blank line (wrong for --spike, --ramp and custom), no live-dashboard hint under
 * --live, every warning gathered up and printed at the END on stderr as 'warning: ...', and
 * the job's 'k6' and 'done' events in the event log, the done event's `passed` redacted as a
 * secret. A warning now: under --json it is collected for `data.warnings`, otherwise it is a
 * warning line, on stdout, the moment it happens; and the job runs with the CLI's hooks and
 * raises no event.
 *
 * `render` is the result renderer, which the CLI's registry supplies: it draws the result
 * once the run is measured and before any output is saved, and each output written is then
 * announced as that function announces it.
 */
export async function runLoadtestCli(
  options: LoadtestCliOptions,
  io: CliIo,
  deps: PerfCliDependencies = DEFAULT_PERF_DEPS,
  render: (view: LoadtestView) => void = () => undefined,
): Promise<PerfCliOutcome> {
  const warnings: string[] = [];
  const prose = !options.json;
  const warn = (message: string): void => {
    if (prose) say(io, message);
    else warnings.push(stripWarning(message));
  };
  // `loadtest` asks for the engine first (`requireDocker`), then validates, as it always has:
  // a bad --vus on a box whose engine answers is refused after `docker info` and `docker
  // compose version`, not before them.
  await deps.requireDocker();
  const checked = validateLoadtest(options, deps, warn);
  // Resolved as the CLI's actor first, then guarded (`requireComposeForPerf`).
  const resolved = await deps.resolveName(options.name, auditActor());
  await deps.core.requireComposeForPerf(resolved, 'loadtest');
  const meta = await deps.readMeta(resolved);
  const compose = await deps.readCompose(meta.name);
  const target = deps.core.loadtestTarget(compose);
  const rcServices = deps.core.rcServicesIn(compose);
  const services = rcServices.length > 0 ? rcServices : ['rocketchat'];
  if (options.live) {
    if (!isTruthy(asBag(meta.extra).monitoring)) {
      throw new ValidationError(
        `--live needs the monitoring stack — attach it first: houston monitor --name ${meta.name}`,
      );
    }
    const command = asBag(asBag(compose.services).prometheus).command;
    if (
      !(Array.isArray(command) ? command : []).some((part) =>
        String(part).includes('remote-write-receiver'),
      )
    ) {
      throw new ValidationError(
        "--live needs Prometheus with remote-write enabled, but this workspace's monitoring " +
          `predates it. Re-attach it: houston monitor --name ${meta.name} --off && ` +
          `houston monitor --name ${meta.name}`,
      );
    }
  }
  let perService: Record<string, constrain.Limit> = {};
  try {
    if (Object.keys(checked.constraints).length > 0) {
      perService = deps.constrain.resolveServices(
        checked.constraints,
        Object.keys(asBag(compose.services)),
      );
    }
  } catch (error) {
    throw new ValidationError(`bad --constrain: ${errorText(error)}`);
  }
  let base: Bag | null = null;
  if (options.compare !== '') {
    try {
      base = deps.baseline.load(options.compare);
    } catch (error) {
      // The baseline's own NotFoundError (exit 4) passes; an unreadable one is a plain refusal.
      if (error instanceof ReproError) throw error;
      throw new ReproError(errorText(error));
    }
  }
  const { auth, token } = await performanceIdentity(deps, meta);
  const users =
    options.usersN > 0 && options.scenario !== 'custom'
      ? await deps.core.loginSeedUsers(meta.rootUrl, options.usersN)
      : [];
  if (options.usersN > 0 && options.scenario !== 'custom' && users.length === 0) {
    warn(
      '  ⚠ no seeded users could log in — using the admin token ' +
        '(run `houston seed` first for realistic multi-user load)',
    );
  }
  let extraEnv = checked.extraEnv;
  if (options.scenario === 'webhook') {
    const hook = await deps.createIncomingWebhook(meta.rootUrl, auth, deps.adminPass(meta));
    if (!hook) {
      throw new ReproError(
        'could not create the incoming webhook integration (check admin permissions)',
      );
    }
    extraEnv = { ...(extraEnv ?? {}), RC_HOOK_PATH: hook };
  }
  const snapshot = await workspaceSnapshot(deps, meta, auth, Math.max(1, rcServices.length));
  if (Object.keys(perService).length > 0) snapshot.constraints = deps.constrain.human(perService);
  const req = deps.core.loadtestReq({
    name: meta.name,
    scenario: options.scenario,
    vus: options.vus,
    duration: options.duration,
    usersN: options.usersN,
    slo: options.slo,
    constrain: options.constrain,
    diag: options.diag,
    stats: options.stats,
    live: options.live,
    slowms: options.slowms,
    ramp: options.ramp || null,
    spike: options.spike || null,
    extraEnv,
    quiet: options.json,
    setupWarnings: true,
  });
  const prepared: coreLoadtest.LoadtestPrepared = {
    auth,
    m: meta,
    perService,
    rcServices: services,
    rules: checked.rules,
    target,
    token,
    users,
  };
  const label =
    options.scenario === 'custom' ? `custom ${checked.method} ${checked.path}` : options.scenario;
  const shape =
    options.spike !== ''
      ? `spike ${options.spike}`
      : options.ramp !== ''
        ? `ramp ${options.ramp}`
        : `${String(options.vus)} VUs`;
  const identity = users.length > 0 ? `${String(users.length)} seeded users` : 'admin token';
  const hooks: coreLoadtest.CliHooks = {
    warn,
    constrained: (human) => {
      if (prose) say(io, `  constrained: ${human} (restored after the test)`);
    },
    // The banner, once the settings are armed.
    armed: () => {
      if (!prose) return;
      say(
        io,
        `Load test: ${label} @ ${shape} for ${options.duration} as ${identity} -> ${target} ` +
          `(via k6 on ${shownValue(meta.name)}'s network)\n`,
      );
      if (options.live) {
        say(
          io,
          '  live: k6 metrics streaming into Prometheus — open the ' +
            `'k6 Load Test' dashboard in Grafana (${grafanaUrlOf(meta)}), ` +
            'or Explore -> k6_*',
        );
      }
    },
  };
  const { run, verdict: measured } = await deps.core.runPreparedLoadtest(
    req,
    prepared,
    nullEmit,
    deps.core.DEFAULT_DEPS,
    hooks,
  );
  const ctx: Bag = {
    name: meta.name,
    version: meta.rcVersion,
    scenario: options.scenario,
    vus: options.vus,
    duration: options.duration,
    ramp: options.ramp,
    spike: options.spike,
    target,
    label,
    users: users.length,
    constrained: snapshot.constraints ?? '',
  };
  const summary = run.summary ?? {};
  const compareRows = base === null ? [] : deps.baseline.compare({ summary }, base);
  if (base !== null) {
    const baseCtx = asBag(base.ctx);
    if (
      baseCtx.scenario !== null &&
      baseCtx.scenario !== undefined &&
      baseCtx.scenario !== options.scenario
    ) {
      warn(
        `  ⚠ baseline '${options.compare}' was a '${String(baseCtx.scenario)}' run — ` +
          'comparing across scenarios',
      );
    }
    if (loadShape(baseCtx) !== loadShape(ctx)) {
      warn(
        `  ⚠ baseline '${options.compare}' ran a different load shape ` +
          `(${loadShape(baseCtx)} vs ${loadShape(ctx)}) — ` +
          'deltas reflect the offered load, not just the workspace',
      );
    }
    const oldConstraints = asBag(base.snapshot).constraints;
    if (oldConstraints !== snapshot.constraints) {
      const oldDisplay =
        oldConstraints === null || oldConstraints === undefined || oldConstraints === ''
          ? 'none'
          : String(oldConstraints);
      const currentDisplay =
        snapshot.constraints === null ||
        snapshot.constraints === undefined ||
        snapshot.constraints === ''
          ? 'none'
          : String(snapshot.constraints);
      warn(
        `  ⚠ baseline '${options.compare}' ran under different resource constraints ` +
          `(${oldDisplay} vs ${currentDisplay}) — ` +
          'deltas reflect the hardware change',
      );
    }
  }
  const spike =
    options.spike !== '' && measured.tl !== null ? deps.timeline.spikeRecovery(measured.tl) : null;
  const soak = run.mon === null ? null : run.mon.memSlopes();
  const verdictLines = options.diag
    ? deps.verdict.analyze(summary, {
        rcmetrics: Object.keys(run.rcmReport).length > 0 ? run.rcmReport : null,
        mongo: measured.mongoSlow as unknown as Bag | null,
        resources: measured.shortStats as unknown as Bag | null,
        timeline: measured.tl as unknown as Bag | null,
        soak,
        spike: spike as unknown as Bag | null,
      })
    : [];
  const diag = options.diag
    ? {
        rcmetrics: run.rcmReport,
        mongo: measured.mongoSlow,
        timeline: measured.tl,
        spike,
        verdict: verdictLines,
      }
    : null;
  // The result is rendered, then the outputs saved: the result is drawn BEFORE anything is
  // saved, so a baseline that cannot be written still leaves the run's answer on screen, and
  // each saved output is announced as it is written.
  if (prose) {
    render({
      name: meta.name,
      ctx,
      summary,
      slo: measured.sloResults as unknown as Bag[],
      spike,
      diag: diag as LoadtestView['diag'],
      compare: compareRows as unknown as Bag[],
      base,
      resources: run.resources ?? {},
    });
  }
  const artifacts: PerfCliOutcome['artifacts'] = {};
  if (options.save !== '') {
    const clean = deps.baseline.sanitizeLabel(options.save);
    artifacts.baseline = deps.baseline.save(options.save, {
      label: clean,
      saved_at: isoSeconds(deps.now()),
      ctx,
      summary,
      snapshot,
    });
    if (prose) {
      say(io, '');
      say(io, `✓ saved baseline ${shownValue(clean)} (compare later with --compare ${clean})`);
    }
  }
  if (options.report || options.reportPath !== '') {
    artifacts.report = deps.report.writeLoadtest(
      ctx,
      summary,
      measured.sloResults as unknown as Bag[],
      measured.shortStats as unknown as Bag | null,
      await hostDetails(deps),
      stamp(deps.now()),
      options.reportPath || null,
      {
        snapshot,
        compare:
          base === null ? null : { label: base.label, saved_at: base.saved_at, rows: compareRows },
        diag,
      },
    );
    if (prose) {
      say(io, '');
      say(io, `✓ wrote ${artifacts.report}`);
    }
  }
  const data: Bag = {
    ctx,
    summary,
    slo: measured.sloResults,
    passed: measured.passed,
    snapshot,
    warnings,
  };
  if (diag !== null) data.diag = diag;
  if (run.resources !== null && Object.keys(run.resources).length > 0) {
    data.resources = measured.shortStats;
  }
  if (base !== null) data.compare = { baseline: base.label, rows: compareRows };
  if (artifacts.baseline !== undefined) data.saved_baseline = artifacts.baseline;
  if (artifacts.report !== undefined) data.report = artifacts.report;
  return {
    data: loadtestEnvelopeFloats(data),
    exitCode: measured.passed ? 0 : 1,
    warnings,
    artifacts,
  };
}

/**
 * One capacity step's row: the VUs right-aligned in 4, the tag left-aligned in 9, req/s
 * with 1 decimal in 7, p95 in 7, the error percentage with 2 decimals in 5, and the mark,
 * where a failure always carries its parentheses.
 */
function capacityRow(row: Bag, tag: string): string {
  const breached = Array.isArray(row.breached) ? row.breached.map(String) : [];
  const mark = isTruthy(row.ok) ? 'PASS' : `FAIL (${breached.join('; ')})`;
  return (
    `  ${String(row.vus).padStart(4)} VUs${tag.padEnd(9)}  ` +
    `${formatFixed(Number(row.rps), 1).padStart(7)} req/s   ` +
    `p95 ${fmtMs(Number(row.p95)).padStart(7)}   ` +
    `err ${formatFixed(Number(row.error_rate) * 100, 2).padStart(5)}%   ${mark}`
  );
}

/**
 * `capacity`, rendered AS IT RUNS.
 *
 * The search is the GUI job's transaction (`runPreparedCapacity`), but the CLI does not
 * borrow the job's narration. It handed the job the CLI emitter and drew its table after the
 * fact, so a search printed a 'capacity search:' line and every step twice -- once as an
 * event, before the header, and again in the table -- recorded each as an event in the log,
 * lost the bisect tag and `fmtMs`'s seconds, said 'as N user(s)' with no constrained suffix,
 * never said where the report went, and warned of a restore that failed in the service's
 * words on stderr, or not at all under --json. The job now runs with no emitter and the CLI's
 * hooks: the header once the search is prepared, each row as the step is measured, the
 * restore's warning line on stdout (on stderr under --json), then the closing lines before
 * the report is written.
 */
export async function runCapacityCli(
  options: CapacityCliOptions,
  io: CliIo,
  deps: PerfCliDependencies = DEFAULT_PERF_DEPS,
): Promise<PerfCliOutcome> {
  await deps.requireDocker();
  const allowed = deps.core.DEFAULT_DEPS.k6.SCENARIOS.filter(
    (scenario) => scenario !== 'custom' && scenario !== 'webhook',
  );
  if (!allowed.includes(options.scenario)) {
    throw new ValidationError(
      'capacity supports the built-in scenarios (journey/messages/read/mixed/login/badbot)',
    );
  }
  let rules: Rule[];
  try {
    rules = deps.core.DEFAULT_DEPS.slo.parse(options.slo);
  } catch (error) {
    throw new ValidationError(`bad --slo: ${errorText(error)}`);
  }
  if (options.start < 1 || options.maxVus < options.start) {
    throw new ValidationError('--start must be >= 1 and --max >= --start');
  }
  coreLoadtest.refuseABadDuration(options.stepDuration, '--step-duration');
  let constraints: Record<string, constrain.Limit> = {};
  try {
    if (options.constrain !== '') constraints = deps.constrain.parse(options.constrain);
  } catch (error) {
    throw new ValidationError(`bad --constrain: ${errorText(error)}`);
  }
  // Resolved as the CLI's actor first, then guarded (`requireComposeForPerf`).
  const resolved = await deps.resolveName(options.name, auditActor());
  await deps.core.requireComposeForPerf(resolved, 'capacity');
  const meta = await deps.readMeta(resolved);
  const compose = await deps.readCompose(meta.name);
  const target = deps.core.loadtestTarget(compose);
  const foundServices = deps.core.rcServicesIn(compose);
  const rcServices = foundServices.length > 0 ? foundServices : ['rocketchat'];
  let perService: Record<string, constrain.Limit> = {};
  try {
    if (Object.keys(constraints).length > 0) {
      perService = deps.constrain.resolveServices(
        constraints,
        Object.keys(asBag(compose.services)),
      );
    }
  } catch (error) {
    throw new ValidationError(`bad --constrain: ${errorText(error)}`);
  }
  const { auth, token } = await performanceIdentity(deps, meta);
  const users =
    options.usersN > 0 ? await deps.core.loginSeedUsers(meta.rootUrl, options.usersN) : [];
  const req = deps.core.capacityReq({
    name: meta.name,
    scenario: options.scenario,
    usersN: options.usersN,
    slo: options.slo,
    start: options.start,
    maxVus: options.maxVus,
    stepDuration: options.stepDuration,
    constrain: options.constrain,
  });
  const prepared: coreLoadtest.CapacityPrepared = {
    auth,
    m: meta,
    perService,
    rcServices,
    rules,
    target,
    token,
    users,
  };
  const prose = !options.json;
  const hooks: coreLoadtest.CliHooks = {
    // A warning line: stdout, or stderr once --json owns stdout.
    warn: (message) => (prose ? say(io, message) : io.writeErr(`${message}\n`)),
    armed: () => {
      if (!prose) return;
      const identity = users.length > 0 ? `${String(users.length)} seeded users` : 'admin token';
      const suffix =
        Object.keys(perService).length > 0
          ? `, constrained ${deps.constrain.human(perService)}`
          : '';
      say(
        io,
        `Capacity search: ${options.scenario} as ${identity}, SLO ${options.slo} ` +
          `(steps of ${options.stepDuration}${suffix})\n`,
      );
    },
    step: (row, tag) => {
      if (prose) say(io, capacityRow(row, tag));
    },
  };
  const { search } = await deps.core.runPreparedCapacity(
    req,
    prepared,
    nullEmit,
    deps.core.DEFAULT_DEPS,
    hooks,
  );
  const ctx: Bag = {
    name: prepared.m.name,
    version: prepared.m.rcVersion,
    scenario: options.scenario,
    slo: options.slo,
    users: prepared.users.length,
    step_duration: options.stepDuration,
    target: prepared.target,
    constrained:
      Object.keys(prepared.perService).length > 0 ? deps.constrain.human(prepared.perService) : '',
  };
  const { result, why } = capacityCliVerdict(options, search);
  if (prose) {
    say(io, '');
    say(io, `Capacity: ${result}`);
    if (why !== '') say(io, `  why it broke: ${why}`);
  }
  const artifacts: PerfCliOutcome['artifacts'] = {};
  if (options.report || options.reportPath !== '') {
    artifacts.report = deps.report.writeCapacity(
      ctx,
      search.steps,
      result,
      why,
      await hostDetails(deps),
      stamp(deps.now()),
      options.reportPath || null,
    );
    if (prose) {
      say(io, '');
      say(io, `✓ wrote ${artifacts.report}`);
    }
  }
  const data: Bag = {
    ctx,
    // Each step's floats: `lag_max_s` always, and the `0.0` a summary without the key
    // defaults to.
    steps: search.steps.map((row) => floatSpellings(row, coreLoadtest.stepFloats(row))),
    capacity_vus: search.lastPass,
    breach_vus: search.firstFail,
    result,
    why,
  };
  return { data, exitCode: 0, warnings: [], artifacts };
}
