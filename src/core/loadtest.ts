/**
 * Load-test service for the web GUI (a focused subset of the CLI `loadtest`).
 *
 * Supports the common options — scenario, vus, duration, users, slo, constrain, diag, stats,
 * live — with the SAME safety-critical restore-in-`finally` as the CLI (rate limiter,
 * Prometheus setting, resource caps, and the users.json token file are always
 * restored/cleaned up, even on failure). Returns a structured result.
 *
 * The CLI reuses the same transaction through the prepared-run seams below, adding its
 * ramp/spike/custom controls and post-run artifacts without duplicating restoration.
 *
 * THE DEPENDENCY BAG. The private steps take `constrain`, `k6`, `mongoprof`, the metrics
 * sampler and the analysis modules as PARAMETERS, so a spec passes stand-ins through. This
 * module keeps that shape as `LoadtestDeps`, which is also what lets a spec drive the
 * restore ordering with scripted modules instead of containers.
 */
import * as fs from 'node:fs/promises';

import * as config from '../lib/config';
import { DockerError, NotReadyError, ReproError, ValidationError, errorText } from '../lib/errors';
import { type Emit, info, nullEmit, warn } from '../lib/events';
import { joinPath } from '../lib/home';
import { formatFixed, isTruthy } from '../lib/format';
import * as monitoring from '../lib/monitoring';

import * as constrainModule from '../perf/constrain';
import * as k6Module from '../perf/k6';
import * as mongoprofModule from '../perf/mongoprof';
import * as rcmetricsModule from '../perf/rcmetrics';
import * as resourcesModule from '../perf/resources';
import * as sloModule from '../perf/slo';
import * as timelineModule from '../perf/timeline';
import * as verdictModule from '../perf/verdict';
import { Interrupted, cleanup, unwindsOnInterrupt } from '../seams/exec';
import { login } from './lifecycle/admin';
import { grafanaUrlOf } from './lifecycle/inspect';
import { resolveName } from './lifecycle/naming';
import { requireDocker } from './lifecycle/preconditions';
import * as journal from './journal';
import { generatePat, getSetting, loginUser, setSetting, type Auth } from './rcapi';
import { readCompose, readMeta, adminPass, type Metadata } from './runner/record';
import * as paths from './runner/paths';
import { rcRestartCount } from './runner/queries';
import { username as seedUsername } from '../seed/wording';
import * as topology from './topology';

type Bag = Record<string, unknown>;

export const GUI_SCENARIOS: readonly string[] = Object.freeze([
  'messages',
  'login',
  'read',
  'mixed',
  'journey',
  'badbot',
]);

/** The modules the steps reach through, replaceable by a spec. */
export interface LoadtestDeps {
  readonly constrain: typeof constrainModule;
  readonly k6: typeof k6Module;
  readonly mongoprof: typeof mongoprofModule;
  readonly monitoring: typeof monitoring;
  readonly resources: typeof resourcesModule;
  readonly rcmetrics: typeof rcmetricsModule;
  readonly slo: typeof sloModule;
  readonly timeline: typeof timelineModule;
  readonly verdict: typeof verdictModule;
}

export const DEFAULT_DEPS: LoadtestDeps = {
  constrain: constrainModule,
  k6: k6Module,
  mongoprof: mongoprofModule,
  monitoring,
  resources: resourcesModule,
  rcmetrics: rcmetricsModule,
  slo: sloModule,
  timeline: timelineModule,
  verdict: verdictModule,
};

/** The default modules, any of them replaced by `overrides`. */
export function depsWith(overrides: Partial<LoadtestDeps> = {}): LoadtestDeps {
  return { ...DEFAULT_DEPS, ...overrides };
}

export interface LoadtestReq {
  name: string;
  scenario: string;
  vus: number;
  duration: string;
  usersN: number;
  slo: string;
  constrain: string;
  diag: boolean;
  stats: boolean;
  live: boolean;
  slowms: number;
  /** CLI-only k6 controls. Defaults preserve the focused GUI service. */
  ramp: string | null;
  spike: string | null;
  extraEnv: Record<string, string | null | undefined> | null;
  quiet: boolean;
  /** CLI preserves two setup warnings the focused GUI service never published. */
  setupWarnings: boolean;
}

/**
 * The CLI's share of a run it holds in common with the GUI's job.
 *
 * `loadtest` and `capacity` measure through the same transaction as the job the GUI starts,
 * but the CLI renders that transaction AS IT GOES and in its established words: the header
 * once the settings are armed, each capacity step the moment it is measured, and every
 * warning as a warning line when it happens. The job narrates the same run through events
 * instead, and every event also reaches the event log's sink whatever the emitter. A CLI run
 * hands these hooks over and the runner raises none of the job's events, so none reach its
 * terminal or its event log; the GUI hands over none and keeps its events exactly as they
 * were.
 */
export interface CliHooks {
  /** A warning in the CLI's words, with its `'  ⚠ '` lead, said the moment it happens. */
  readonly warn: (message: string) => void;
  /** The caps are on, and the CLI says so in a note line. */
  readonly constrained?: (human: string) => void;
  /** The settings are armed and the run is about to start: where the header goes. */
  readonly armed?: () => void;
  /** One capacity step measured, with its tag: `' (bisect)'` or nothing. */
  readonly step?: (row: Bag, tag: string) => void;
}

/**
 * A cap that could not be applied: the job's DockerError, or the CLI's plain error
 * `could not apply --constrain: <why>` -- REPRO_ERROR, exit 1, and the flag's own name.
 */
function constrainFailure(cli: CliHooks | null, exc: unknown): ReproError {
  return cli === null
    ? new DockerError(`could not apply constrain: ${errorText(exc)}`)
    : new ReproError(`could not apply --constrain: ${errorText(exc)}`);
}

/** A request with the established defaults filled in. */
export function loadtestReq(values: Partial<LoadtestReq> & Pick<LoadtestReq, 'name'>): LoadtestReq {
  return {
    scenario: 'messages',
    vus: 10,
    duration: '30s',
    usersN: 10,
    slo: '',
    constrain: '',
    diag: true,
    stats: false,
    live: false,
    slowms: 100,
    ramp: null,
    spike: null,
    extraEnv: null,
    quiet: true,
    setupWarnings: false,
    ...values,
  };
}

/** Restore the profiler a killed run left armed — the note's own kind, not this file's. */
export function installJournalRepairs(): void {
  journal.registerRepair(journal.CONSTRAINTS_APPLIED, repairConstraints);
  journal.registerRepair(journal.RC_METRICS_ON, repairMetrics);
}

export async function repairConstraints(
  entry: journal.Entry,
  _emit: Emit,
  _login: unknown,
): Promise<boolean> {
  const applied = (Array.isArray(entry.detail.applied) ? entry.detail.applied : []).map(
    (a) => ({ ...(a as Bag) }) as unknown as constrainModule.Applied,
  );
  // `not restore(...)`, where restore returns a PROBLEM LIST: an array is always truthy
  // here, so `!restore(...)` would report every failed restore as repaired.
  return (await constrainModule.restore(applied)).length === 0;
}

export async function repairMetrics(
  entry: journal.Entry,
  _emit: Emit,
  login_: unknown,
): Promise<boolean> {
  if (login_ === null || login_ === undefined) return false;
  const meta = await readMeta(entry.workspace);
  const auth = await (login_ as (m: Metadata) => Promise<Auth | null | undefined>)(meta);
  if (auth === null || auth === undefined) return false;
  return await setSetting(
    meta.rootUrl,
    auth,
    adminPass(meta),
    monitoring.RC_METRICS_SETTING,
    false,
  );
}

function bagOf(value: unknown): Bag {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Bag;
}

export function rcServicesIn(doc: Bag): string[] {
  return Object.keys(bagOf(doc.services)).filter(
    (service) => service === 'rocketchat' || service.startsWith('rocketchat-'),
  );
}

export function loadtestTarget(doc: Bag): string {
  const svcs = bagOf(doc.services);
  if ('traefik' in svcs) return 'http://traefik:80';
  const rc = rcServicesIn(doc);
  if (rc.includes('rocketchat')) return 'http://rocketchat:3000';
  return rc.length > 0 ? `http://${rc[0] as string}:3000` : 'http://rocketchat:3000';
}

export function short(full: string, reproName: string): string {
  const prefix = `${config.PROJECT_PREFIX}${reproName}-`;
  const s = full.startsWith(prefix) ? full.slice(prefix.length) : full;
  return s.replace(/-\d+$/u, '');
}

/**
 * Log in the seeded users so VUs carry real identity.
 *
 * This once posted to `/api/v1/login` directly — one of the three recorded `rcapi`
 * bypasses — and now reaches the same endpoint through `rcapi`, which is where the
 * dependency policy says HTTP lives.
 */
export async function loginSeedUsers(rootUrl: string, count: number): Promise<Bag[]> {
  const users: Bag[] = [];
  for (let i = 0; i < count; i += 1) {
    const uname = seedUsername(i);
    let entry;
    try {
      entry = await loginUser(rootUrl, uname);
    } catch {
      break;
    }
    if (entry !== null && isTruthy(entry.authToken)) {
      users.push({
        username: uname,
        password: uname,
        token: entry.authToken,
        uid: entry.userId,
      });
    }
  }
  return users;
}

/**
 * The warning for `journey` past 50 VUs per user, or null.
 *
 * Each journey iteration logs its VU in afresh (as the VU's seeded user, or the admin) and
 * uses that session to its last step. Rocket.Chat keeps a user's newest 50 sessions and
 * deletes the rest, so past 50 VUs per user it deletes sessions still in use, and their
 * later steps fail with 4xx that are not the server's.
 */
export function sessionLimitWarning(scenario: string, vus: number, users: number): string | null {
  const most = 50 * Math.max(1, users);
  if (scenario !== 'journey' || vus <= most) return null;
  const who = users > 0 ? `${String(users)} seeded user${users === 1 ? '' : 's'}` : 'the admin';
  return (
    `journey at ${String(vus)} VUs is more than ${String(most)}, 50 per user for ${who}: ` +
    `Rocket.Chat keeps 50 sessions per user and deletes the older ones while they are ` +
    `still in use, so some steps fail with 4xx that are not the server's. Use fewer VUs, ` +
    `or seed more users (houston seed --profile standard makes 20) and use them all`
  );
}

/**
 * Refuse a load test or capacity search on a Kubernetes workspace, and say why.
 *
 * Not merely "unimplemented". The number would be WRONG in a way that reads as a result:
 * a Kubernetes workspace is reached through `kubectl port-forward`, which is a single
 * userspace relay — it saturates, serialises and drops connections far below what
 * Rocket.Chat itself would, so every figure the run produced would be a measurement of
 * the forward. A plausible wrong number is the one failure mode this tool cannot afford
 * in a report a support engineer sends to a customer.
 */
export async function requireComposeForPerf(name: string, operation: string): Promise<void> {
  const target = await resolveName(name);
  if ((await topology.ofRepro(target)) !== topology.KUBERNETES) {
    return;
  }
  let version = '';
  try {
    version = (await readMeta(target)).rcVersion;
  } catch {
    // the refusal matters more than the example
  }
  throw new ValidationError(
    `${operation} is Compose-only. A Kubernetes workspace is reached through a ` +
      '`kubectl port-forward`, which is a single userspace relay: it saturates and ' +
      'drops connections long before Rocket.Chat does, so every number this ' +
      'produced would be measuring the forward. Run it against a Compose ' +
      `workspace on the same version instead — \`houston up --version ` +
      `${version || '<version>'} --name perf\` — where the client talks to the ` +
      'container directly.',
  );
}

/**
 * The side effects one load test arms, and what it has measured so far.
 *
 * Six things are switched on before k6 runs and switched back after it, in a `finally`
 * that must run whichever way the test ended. Passing them between named steps as fifteen
 * parameters and twelve return values is the same tangle with more punctuation in it;
 * this is what they actually are.
 */
export interface LoadRun {
  appliedConstraints: constrainModule.Applied[];
  limiterWasOff: boolean;
  limiterNote: string;
  constrainNote: string;
  metricsNote: string;
  mongoNote: string;
  metricsChanged: boolean;
  mongoPrior: mongoprofModule.Prior | null;
  sampler: InstanceType<typeof rcmetricsModule.RCMetricsSampler> | null;
  mon: InstanceType<typeof resourcesModule.ResourceMonitor> | null;
  resources: Record<string, resourcesModule.ContainerStats> | null;
  summary: Bag | null;
  rcmReport: Record<string, Record<string, rcmetricsModule.SeriesSummary>>;
  sinceMs: number;
  /** Rocket.Chat's restart count when a constrained run began; -1 when none was read. */
  restartsBefore: number;
}

export function newLoadRun(): LoadRun {
  return {
    appliedConstraints: [],
    limiterWasOff: true,
    limiterNote: '',
    constrainNote: '',
    metricsNote: '',
    mongoNote: '',
    metricsChanged: false,
    mongoPrior: null,
    sampler: null,
    mon: null,
    resources: null,
    summary: null,
    rcmReport: {},
    sinceMs: 0,
    restartsBefore: -1,
  };
}

/**
 * Put a setting back, and say whether it went back.
 *
 * `setSetting` answers false rather than throwing, and that answer was dropped: the warning
 * in the `catch` could never fire, and the journal note was cleared either way. The login,
 * mixed and journey scenarios log the admin in hundreds of times, and Rocket.Chat keeps 50
 * login tokens (MAX_RESUME_LOGIN_TOKENS) -- so the session this run started with was
 * pruned before it ended, the restore was refused, and the rate limiter stayed OFF with
 * nothing said. Every later run then read it as "was off" and left it. A refused restore
 * logs in afresh and tries once more.
 */
async function restoreSetting(
  m: Metadata,
  auth: Auth,
  settingId: string,
  value: unknown,
): Promise<boolean> {
  if (await setSetting(m.rootUrl, auth, adminPass(m), settingId, value)) return true;
  let fresh: Auth;
  try {
    fresh = await login(m);
  } catch (error) {
    if (error instanceof Interrupted) throw error;
    return false;
  }
  return await setSetting(m.rootUrl, fresh, adminPass(m), settingId, value);
}

/** Undo every side effect this run armed, whichever way it ended. */
export async function putEverythingBack({
  auth,
  cli = null,
  deps,
  emit,
  m,
  run,
}: {
  auth: Auth;
  cli?: CliHooks | null;
  deps: LoadtestDeps;
  emit: Emit;
  m: Metadata;
  run: LoadRun;
}): Promise<void> {
  // The job's event, or the restore's warning in the CLI's words.
  const restoreWarning = (job: string, words: string): void => {
    if (cli === null) warn(emit, job, { phase: 'restore' });
    else cli.warn(words);
  };
  // users.json holds live seeded-user auth tokens — delete it FIRST, so no later restore
  // step failing can leave credentials on disk.
  await fs.rm(joinPath(paths.workspace(m.name), 'loadtest', 'users.json'), { force: true });
  if (run.sampler !== null) {
    run.rcmReport = await run.sampler.stop();
  }
  if (run.mon !== null) {
    run.resources = await run.mon.stop();
  }
  if (!run.limiterWasOff) {
    if (await restoreSetting(m, auth, config.RC_RATE_LIMITER_SETTING, true)) {
      journal.clear(run.limiterNote);
    } else {
      restoreWarning(
        'could not restore the API rate limiter setting',
        '  ⚠ could not restore the API rate limiter setting',
      );
    }
  }
  if (run.metricsChanged) {
    if (await restoreSetting(m, auth, deps.monitoring.RC_METRICS_SETTING, false)) {
      journal.clear(run.metricsNote);
    } else {
      restoreWarning(
        'could not restore the Prometheus metrics setting',
        '  ⚠ could not restore the Prometheus metrics setting',
      );
    }
  }
  if (run.mongoPrior !== null) {
    // Wrapped like its neighbours: an exception here would skip the resource-cap restore
    // below and leave the containers capped.
    try {
      await deps.mongoprof.stop(m.name, run.mongoPrior);
      journal.clear(run.mongoNote);
    } catch {
      restoreWarning(
        'could not restore the Mongo profiler level',
        '  ⚠ could not restore the Mongo profiler level',
      );
    }
  }
  // CLEARED AFTER, like its three siblings above. Clearing first threw away the note on
  // the one path it exists for: `restore` RETURNS problems rather than raising, and the
  // loop below is there to report them — so a failed restore left the containers capped
  // with the record of their prior values already deleted, which is precisely what
  // CONSTRAINTS_APPLIED carries them for.
  const capProblems = await deps.constrain.restore(run.appliedConstraints);
  for (const problem of capProblems) {
    restoreWarning(
      `could not restore resource limits - ${problem}`,
      `  ⚠ could not restore resource limits — ${problem}`,
    );
  }
  if (capProblems.length === 0) {
    journal.clear(run.constrainNote);
  }
}

/** Constrain, disable the limiter, turn the diagnostics on, and run k6. */
export async function armAndRun({
  auth,
  cli = null,
  deps,
  emit,
  m,
  perService,
  rcServices,
  req,
  run,
  target,
  token,
  users,
}: {
  auth: Auth;
  cli?: CliHooks | null;
  deps: LoadtestDeps;
  emit: Emit;
  m: Metadata;
  perService: Record<string, constrainModule.Limit>;
  rcServices: readonly string[];
  req: LoadtestReq;
  run: LoadRun;
  target: string;
  token: string;
  users: readonly Bag[];
}): Promise<void> {
  if (Object.keys(perService).length > 0) {
    try {
      run.appliedConstraints = await deps.constrain.apply(m.name, perService);
    } catch (exc) {
      // `constrain.apply` signals its own failures with a plain Error, and those are what
      // this answers; nothing else is expected from it, so wrapping every failure is no
      // broader a net than the one intended. A Ctrl-C is not one of them.
      if (exc instanceof Interrupted) throw exc;
      throw constrainFailure(cli, exc);
    }
    // NOTED WITH THE PRIOR VALUES, so a killed run can be undone exactly rather than
    // reset to "unlimited". `restore` runs in the `finally` below; this is what covers
    // the run that never reaches it.
    run.constrainNote = journal.record(journal.CONSTRAINTS_APPLIED, m.name, {
      applied: run.appliedConstraints.map((a) => ({ ...a })),
    });
    run.restartsBefore = await rcRestartCount(m.name);
    if (cli === null) {
      info(emit, `constrained: ${deps.constrain.human(perService)} (restored after)`, {
        phase: 'k6',
      });
    } else {
      cli.constrained?.(deps.constrain.human(perService));
    }
  }
  run.limiterWasOff =
    (await getSetting(m.rootUrl, auth, adminPass(m), config.RC_RATE_LIMITER_SETTING)) === false;
  if (!run.limiterWasOff) {
    // JOURNALLED BEFORE IT IS TURNED OFF. The `finally` below turns it back on, and a
    // daemon thread killed by a restart or an OOM runs no `finally` at all — so the note
    // on disk is what survives to say the API rate limiter is off on this workspace and
    // nobody meant to leave it that way.
    run.limiterNote = journal.record(journal.RATE_LIMITER_OFF, m.name);
    const changed = await setSetting(
      m.rootUrl,
      auth,
      adminPass(m),
      config.RC_RATE_LIMITER_SETTING,
      false,
    );
    if (!changed) {
      // NEVER TURNED OFF, so there is nothing to put back: restoring it anyway now says
      // "could not restore" about a setting this run never changed.
      run.limiterWasOff = true;
      journal.clear(run.limiterNote);
      run.limiterNote = '';
      if (req.setupWarnings) {
        const words = 'could not disable the API rate limiter — results may be throttled (429s)';
        if (cli === null) warn(emit, words, { phase: 'k6' });
        else cli.warn(`  ⚠ ${words}`);
      }
    }
  }
  // The banner: after the caps and the limiter, before the diagnostics are armed.
  cli?.armed?.();
  if (req.diag) {
    if (
      (await getSetting(m.rootUrl, auth, adminPass(m), deps.monitoring.RC_METRICS_SETTING)) !== true
    ) {
      // Journalled like its two neighbours. Both of these are restored in the `finally`
      // below, which is precisely the block a SIGKILL does not run — so without a note a
      // killed --diag run leaves Rocket.Chat's metrics endpoint open and the profiler
      // armed, with nothing on disk saying so.
      run.metricsNote = journal.record(journal.RC_METRICS_ON, m.name);
      run.metricsChanged = await setSetting(
        m.rootUrl,
        auth,
        adminPass(m),
        deps.monitoring.RC_METRICS_SETTING,
        true,
      );
    }
    run.mongoPrior = await deps.mongoprof.start(m.name, req.slowms);
    if (run.mongoPrior === null && req.setupWarnings) {
      const words = 'Mongo slow-query capture unavailable (profiler could not be enabled)';
      if (cli === null) warn(emit, words, { phase: 'k6' });
      else cli.warn(`  ⚠ ${words}`);
    } else if (run.mongoPrior !== null) {
      // Carrying the PRIOR level, because `mongoprof.stop` restores to a value rather
      // than to off, and a workspace that already had profiling on must keep it. Same
      // distinction CONSTRAINTS_APPLIED already draws.
      run.mongoNote = journal.record(journal.MONGO_PROFILER_ON, m.name, {
        prior: run.mongoPrior,
      });
    }
  }
  run.mon = req.stats ? new deps.resources.ResourceMonitor(m.name).start() : null;
  run.sinceMs = Date.now();
  if (req.diag) {
    run.sampler = new deps.rcmetrics.RCMetricsSampler(m.name, rcServices).start();
  }
  // The job's narration only: the CLI announced its own banner above, and an event would
  // reach the event log's sink even with no emitter.
  if (cli === null) {
    const who = users.length > 0 ? `${String(users.length)} seeded users` : 'admin token';
    info(
      emit,
      `running k6: ${req.scenario} @ ${String(req.vus)} VUs for ${req.duration} -> ${target}` +
        ` (${who})`,
      { phase: 'k6' },
    );
  }
  run.summary = await deps.k6.run(m.name, req.scenario, {
    vus: req.vus,
    duration: req.duration,
    ramp: req.ramp,
    token,
    uid: auth.userId,
    target,
    users: users.length > 0 ? [...users] : null,
    password: adminPass(m),
    ...(req.extraEnv === null ? {} : { extraEnv: req.extraEnv }),
    quiet: req.quiet,
    timeline: req.diag || req.spike !== null,
    spike: req.spike,
    live: req.live,
  });
}

/**
 * What the run proved: the SLO, the diagnosis, and where to look at it.
 *
 * `timeline` and `mongo` are read from the workspace only here, after the run has been
 * put back, so the point file that k6 wrote is consumed exactly once.
 */
export async function loadtestVerdict({
  cli = null,
  deps,
  emit,
  m,
  req,
  rules,
  run,
}: {
  cli?: CliHooks | null;
  deps: LoadtestDeps;
  emit: Emit;
  m: Metadata;
  req: LoadtestReq;
  rules: readonly sloModule.Rule[];
  run: LoadRun;
}): Promise<{
  grafana: string | null;
  mongoSlow: mongoprofModule.SlowReport | null;
  passed: boolean;
  shortStats: Record<string, resourcesModule.ContainerStats> | null;
  sloResults: sloModule.RuleResult[];
  tl: timelineModule.Timeline | null;
  verdictLines: string[];
}> {
  const mongoSlow =
    req.diag && run.mongoPrior !== null ? await deps.mongoprof.collect(m.name, run.sinceMs) : null;
  let tl: timelineModule.Timeline | null = null;
  if (req.diag || req.spike !== null) {
    const points = joinPath(paths.workspace(m.name), 'loadtest', 'points.json');
    tl = deps.timeline.parse(points);
    await fs.rm(points, { force: true });
  }

  const sloResults = rules.length > 0 ? deps.slo.evaluate(rules, run.summary ?? {}) : [];
  // An EMPTY resources object counts as none, and that is a real case: the sampler
  // ran but the workspace had no container to sample. Reporting `{}` where the established
  // answer is null would say "we measured nothing" in a different shape.
  const shortStats =
    run.resources !== null && Object.keys(run.resources).length > 0
      ? Object.fromEntries(
          Object.entries(run.resources).map(([key, value]) => [short(key, m.name), value]),
        )
      : null;
  const verdictLines = req.diag
    ? deps.verdict.analyze(run.summary ?? {}, {
        rcmetrics: Object.keys(run.rcmReport).length > 0 ? run.rcmReport : null,
        // The collectors' interfaces carry no index signature, which is a TypeScript
        // shape rather than a data difference: both are plain JSON objects on the wire.
        mongo: mongoSlow as unknown as Bag | null,
        resources: shortStats as unknown as Bag | null,
        timeline: tl as unknown as Bag | null,
      })
    : [];
  const passed = sloResults.length === 0 || sloResults.every((r) => r.ok);
  // A CAP THAT KILLED IT, said. Under a memory cap the kernel can restart Rocket.Chat while
  // the load runs, and the run then measures the restart -- it reported 100% errors as a
  // load result with no word about why.
  if (run.restartsBefore >= 0) {
    const restarts = (await rcRestartCount(m.name)) - run.restartsBefore;
    if (restarts > 0) {
      const words =
        `Rocket.Chat restarted ${String(restarts)}x during the run under --constrain: ` +
        'these numbers are its restart, not its load. Give it more memory.';
      verdictLines.unshift(words);
      if (cli === null) warn(emit, words, { phase: 'k6' });
      else cli.warn(`  ⚠ ${words}`);
    }
  }

  const grafana = req.live ? grafanaUrlOf(m) : null;
  const summary = run.summary ?? {};
  // The job's closing event. The CLI renders its own result, and the event would reach the
  // event log's sink with `passed` redacted as a secret.
  if (cli === null) {
    info(
      emit,
      `done: p95 ${formatFixed(Number(summary.p95 ?? 0), 0)}ms at ` +
        `${formatFixed(Number(summary.rps ?? 0), 1)} req/s, ` +
        `${formatFixed(Number(summary.error_rate ?? 0) * 100, 2)}% errors` +
        (passed ? '' : ' - SLO FAIL'),
      // The detail is one key named `data` inside the event's data, so it nests; the wire
      // keeps that shape.
      { phase: 'done', data: { data: { passed } } },
    );
  }
  return { grafana, mongoSlow, passed, shortStats, sloResults, tl, verdictLines };
}

/** Refuse what cannot be run, then resolve the workspace, its target and its users. */
export interface LoadtestPrepared {
  auth: Auth;
  m: Metadata;
  perService: Record<string, constrainModule.Limit>;
  rcServices: string[];
  rules: sloModule.Rule[];
  target: string;
  token: string;
  users: Bag[];
}

/**
 * A duration k6 takes: a Go duration (`30s`, `1m30s`, `500ms`, `1.5h`) or a bare number of
 * milliseconds. Checked here because houston passed any word to k6, which started and then
 * failed: `loadtest --duration forever` ran, exited 1 and said why only in k6's own output.
 */
export function refuseABadDuration(value: string, flag: string): void {
  if (/^(\d+(\.\d+)?|(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+)$/u.test(value.trim())) return;
  throw new ValidationError(`bad ${flag}: '${value}' is not a duration (e.g. 30s, 2m, 1m30s)`);
}

export async function loadtestPreflight(
  deps: LoadtestDeps,
  req: LoadtestReq,
): Promise<LoadtestPrepared> {
  await requireDocker();
  if (!GUI_SCENARIOS.includes(req.scenario)) {
    throw new ValidationError(`scenario must be one of ${GUI_SCENARIOS.join(', ')}`);
  }
  if (req.vus < 1) {
    throw new ValidationError('vus must be >= 1');
  }
  refuseABadDuration(req.duration, 'duration');

  // Refused here rather than at the top, so a bad --scenario is still named before a bad
  // --name: the request's own shape is cheaper to check and is what the caller most
  // likely got wrong. But BEFORE `readCompose`, which threw a bare ENOENT
  // naming a compose file a Kubernetes workspace does not have — outside the ReproError
  // contract, so the GUI answered 500 to a request that is merely unsupported. The same
  // defect the env tab had, in a second place.
  await requireComposeForPerf(req.name, 'loadtest');
  const m = await readMeta(await resolveName(req.name));
  const doc = await readCompose(m.name);
  const target = loadtestTarget(doc);
  const rcServices = rcServicesIn(doc);
  const services = rcServices.length > 0 ? rcServices : ['rocketchat'];

  if (req.live) {
    if (!isTruthy(bagOf(m.extra).monitoring)) {
      throw new ValidationError('live streaming needs monitoring attached first');
    }
    const promCmd = bagOf(bagOf(doc.services).prometheus).command;
    if (
      !(Array.isArray(promCmd) ? promCmd : []).some((c) =>
        String(c).includes('remote-write-receiver'),
      )
    ) {
      throw new ValidationError('live needs Prometheus with remote-write - re-attach monitoring');
    }
  }

  let rules: sloModule.Rule[];
  try {
    rules = isTruthy(req.slo) ? deps.slo.parse(req.slo) : [];
  } catch (exc) {
    throw new ValidationError(`bad slo: ${errorText(exc)}`);
  }
  let perService: Record<string, constrainModule.Limit> = {};
  if (req.constrain) {
    try {
      perService = deps.constrain.resolveServices(
        deps.constrain.parse(req.constrain),
        Object.keys(bagOf(doc.services)),
      );
    } catch (exc) {
      throw new ValidationError(`bad constrain: ${errorText(exc)}`);
    }
  }

  let auth: Auth;
  let token: string;
  try {
    auth = await login(m);
    token = await generatePat(m.rootUrl, auth, adminPass(m), {
      tokenName: 'houston-loadtest',
      bypass2fa: true,
      workspace: m.name,
    });
  } catch (exc) {
    throw new NotReadyError(`could not authenticate (ready?): ${errorText(exc)}`);
  }

  const users = req.usersN > 0 ? await loginSeedUsers(m.rootUrl, req.usersN) : [];
  return { auth, m, perService, rcServices: services, rules, target, token, users };
}

export async function runLoadtest(
  req: LoadtestReq,
  emit: Emit = nullEmit,
  deps: LoadtestDeps = DEFAULT_DEPS,
): Promise<Bag> {
  const prepared = await loadtestPreflight(deps, req);
  const { m, perService, target, users } = prepared;
  const { run, verdict } = await runPreparedLoadtest(req, prepared, emit, deps);
  const { grafana, mongoSlow, passed, shortStats, sloResults, tl, verdictLines } = verdict;
  return {
    ctx: {
      name: m.name,
      scenario: req.scenario,
      vus: req.vus,
      duration: req.duration,
      users: users.length,
      target,
      constrained: Object.keys(perService).length > 0 ? deps.constrain.human(perService) : '',
    },
    summary: run.summary,
    slo: sloResults,
    passed,
    verdict: verdictLines,
    diag: req.diag ? { rcmetrics: run.rcmReport, mongo: mongoSlow, timeline: tl } : null,
    resources:
      shortStats !== null
        ? Object.fromEntries(Object.entries(shortStats).map(([key, value]) => [key, { ...value }]))
        : null,
    grafana_url: grafana,
  };
}

export async function runPreparedLoadtest(
  req: LoadtestReq,
  prepared: LoadtestPrepared,
  emit: Emit = nullEmit,
  deps: LoadtestDeps = DEFAULT_DEPS,
  cli: CliHooks | null = null,
): Promise<{
  run: LoadRun;
  verdict: Awaited<ReturnType<typeof loadtestVerdict>>;
}> {
  const { auth, m, perService, rcServices, rules, target, token, users } = prepared;
  const shape = req.spike ?? req.ramp ?? '';
  const peak = shape !== '' ? Math.max(...shape.split(':').map(Number)) : req.vus;
  const words = sessionLimitWarning(req.scenario, peak, users.length);
  if (words !== null) {
    if (cli === null) warn(emit, words, { phase: 'k6' });
    else cli.warn(`  ⚠ ${words}`);
  }
  const run = newLoadRun();
  // UNWOUND by a Ctrl-C: the wait on k6 raises Interrupted and the restore runs as cleanup,
  // so what the run changed goes back as it does when the run fails. Without the unwind, a
  // Ctrl-C ended the process with nothing put back.
  await unwindsOnInterrupt(async () => {
    try {
      await armAndRun({
        auth,
        cli,
        deps,
        emit,
        m,
        perService,
        rcServices,
        req,
        run,
        target,
        token,
        users,
      });
    } catch (exc) {
      if (exc instanceof Interrupted) throw exc;
      // The ReproError taxonomy passes through and anything else is converted; every
      // failure `armAndRun` can raise on its own is a bad-input-or-engine one, and the
      // deliberate refusals above keep their own types.
      if (exc instanceof ReproError) throw exc;
      if (cli === null) throw new DockerError(errorText(exc));
      // The CLI's plain error: k6's unreadable or missing summary is REPRO_ERROR, exit 1. A
      // request that failed is a transport failure, which is not converted, so it goes on to
      // the contract's last line as it is.
      if (exc instanceof Error && exc.name === 'RequestFailed') throw exc;
      throw new ReproError(errorText(exc));
    } finally {
      await cleanup(async () => {
        await putEverythingBack({ auth, cli, deps, emit, m, run });
      });
    }
  });

  const verdict = await loadtestVerdict({ cli, deps, emit, m, req, rules, run });
  return { run, verdict };
}

// --- capacity ----------------------------------------------------------------

export interface CapacityReq {
  name: string;
  scenario: string;
  usersN: number;
  slo: string;
  start: number;
  maxVus: number;
  stepDuration: string;
  constrain: string;
}

export function capacityReq(values: Partial<CapacityReq> & Pick<CapacityReq, 'name'>): CapacityReq {
  return {
    scenario: 'journey',
    usersN: 10,
    slo: 'p95=500ms,error=2%',
    start: 10,
    maxVus: 640,
    stepDuration: '20s',
    constrain: '',
    ...values,
  };
}

/**
 * The side effects one capacity search arms, and the steps it has taken.
 *
 * The same shape as `LoadRun` and for the same reason: five things are switched on
 * before the search and back after it, and the search itself accumulates a step list
 * and a pass/fail boundary that every stage reads.
 */
export interface CapacitySearch {
  applied: constrainModule.Applied[];
  limiterWasOff: boolean;
  limiterNote: string;
  constrainNote: string;
  metricsNote: string;
  metricsChanged: boolean;
  steps: Bag[];
  lastPass: number | null;
  firstFail: number | null;
}

export function newCapacitySearch(): CapacitySearch {
  return {
    applied: [],
    limiterWasOff: true,
    limiterNote: '',
    constrainNote: '',
    metricsNote: '',
    metricsChanged: false,
    steps: [],
    lastPass: null,
    firstFail: null,
  };
}

export type CapacityStep = (vus: number, tag?: string) => Promise<Bag>;

/**
 * The members of each capacity step that are held as FLOATS: `lag_max_s` always (`0.0`,
 * or an RC metric read as a float), and `rps`, `p95` or `error_rate` where k6's summary had
 * no such key and the row took the default `0.0`. A value the
 * summary did carry is left as the summary spelled it.
 *
 * Kept BESIDE the row rather than in it, because the row is also the GUI job's result, which
 * the web's serializer writes: only the CLI's envelope writer knows a `JsonFloat`.
 */
const STEP_FLOATS = new WeakMap<object, readonly string[]>();

export function stepFloats(row: object): readonly string[] {
  return STEP_FLOATS.get(row) ?? [];
}

/** Where the SLO broke, and what broke it. */
export function capacityVerdict(
  emit: Emit,
  req: CapacityReq,
  search: CapacitySearch,
): { result: string; why: string } {
  const { result, why } = capacityWords(req, search);
  // Nested one level, a key named `data` inside the event's data, as it always has been.
  info(emit, `capacity: ${result}`, {
    phase: 'done',
    data: { data: { capacity_vus: search.lastPass } },
  });
  return { result, why };
}

/** The verdict's words alone, for the CLI's run, which says nothing through events. */
function capacityWords(req: CapacityReq, search: CapacitySearch): { result: string; why: string } {
  let result: string;
  if (search.lastPass === null) {
    result = `breaches the SLO even at ${String(req.start)} VUs - start lower`;
  } else if (search.firstFail === null) {
    result = `holds the SLO up to ${String(search.lastPass)} VUs (never breached; raise max to push further)`;
  } else {
    result = `~${String(search.lastPass)} concurrent VUs (holds at ${String(search.lastPass)}, breaks at ${String(search.firstFail)})`;
  }
  const breach =
    search.firstFail !== null
      ? search.steps.find((r) => r.vus === search.firstFail)
      : search.steps.find((r) => !isTruthy(r.ok));
  let why = '';
  if (breach !== undefined) {
    const lag = Number(breach.lag_max_s ?? 0);
    why =
      lag >= 0.5
        ? `at ${String(breach.vus)} VUs the RC event loop saturated (lag peaked ` +
          `at ${formatFixed(lag * 1000, 0)}ms)`
        : `at ${String(breach.vus)} VUs: ${(Array.isArray(breach.breached) ? breach.breached : []).join('; ')}`;
  }
  return { result, why };
}

/** Refuse what cannot be searched, then resolve the workspace and its users. */
export interface CapacityPrepared {
  auth: Auth;
  m: Metadata;
  perService: Record<string, constrainModule.Limit>;
  rcServices: string[];
  rules: sloModule.Rule[];
  target: string;
  token: string;
  users: Bag[];
}

export async function capacityPreflight(
  deps: LoadtestDeps,
  req: CapacityReq,
): Promise<CapacityPrepared> {
  await requireDocker();
  if (!GUI_SCENARIOS.includes(req.scenario)) {
    throw new ValidationError(`scenario must be one of ${GUI_SCENARIOS.join(', ')}`);
  }
  let rules: sloModule.Rule[];
  try {
    rules = deps.slo.parse(req.slo);
  } catch (exc) {
    throw new ValidationError(`bad slo: ${errorText(exc)}`);
  }
  if (req.start < 1 || req.maxVus < req.start) {
    throw new ValidationError('start must be >= 1 and max >= start');
  }
  refuseABadDuration(req.stepDuration, 'step duration');

  await requireComposeForPerf(req.name, 'capacity'); // see runLoadtest for the why
  const m = await readMeta(await resolveName(req.name));
  const doc = await readCompose(m.name);
  const target = loadtestTarget(doc);
  const rcServices = rcServicesIn(doc);
  const services = rcServices.length > 0 ? rcServices : ['rocketchat'];
  let perService: Record<string, constrainModule.Limit> = {};
  if (req.constrain) {
    try {
      perService = deps.constrain.resolveServices(
        deps.constrain.parse(req.constrain),
        Object.keys(bagOf(doc.services)),
      );
    } catch (exc) {
      throw new ValidationError(`bad constrain: ${errorText(exc)}`);
    }
  }
  let auth: Auth;
  let token: string;
  try {
    auth = await login(m);
    token = await generatePat(m.rootUrl, auth, adminPass(m), {
      tokenName: 'houston-loadtest',
      bypass2fa: true,
      workspace: m.name,
    });
  } catch (exc) {
    throw new NotReadyError(`could not authenticate (ready?): ${errorText(exc)}`);
  }
  const users = req.usersN > 0 ? await loginSeedUsers(m.rootUrl, req.usersN) : [];
  return { auth, m, perService, rcServices: services, rules, target, token, users };
}

/** Undo every side effect the search armed, whichever way it ended. */
export async function putTheWorkspaceBack({
  auth,
  cli = null,
  deps,
  emit,
  m,
  search,
}: {
  auth: Auth;
  cli?: CliHooks | null;
  deps: LoadtestDeps;
  emit: Emit;
  m: Metadata;
  search: CapacitySearch;
}): Promise<void> {
  // The job's event, or the restore's warning line: its own words, with the lead and
  // the em dash the service's line does not have.
  const restoreWarning = (job: string, words: string): void => {
    if (cli === null) warn(emit, job, { phase: 'restore' });
    else cli.warn(words);
  };
  if (!search.limiterWasOff) {
    if (await restoreSetting(m, auth, config.RC_RATE_LIMITER_SETTING, true)) {
      journal.clear(search.limiterNote);
    } else {
      restoreWarning(
        'could not restore the API rate limiter setting',
        '  ⚠ could not restore the API rate limiter setting',
      );
    }
  }
  if (search.metricsChanged) {
    if (await restoreSetting(m, auth, deps.monitoring.RC_METRICS_SETTING, false)) {
      journal.clear(search.metricsNote);
    } else {
      restoreWarning(
        'could not restore the Prometheus metrics setting',
        '  ⚠ could not restore the Prometheus metrics setting',
      );
    }
  }
  // See run_loadtest: cleared only when the restore actually succeeded.
  const capProblems = await deps.constrain.restore(search.applied);
  for (const problem of capProblems) {
    restoreWarning(
      `could not restore resource limits - ${problem}`,
      `  ⚠ could not restore resource limits — ${problem}`,
    );
  }
  if (capProblems.length === 0) {
    journal.clear(search.constrainNote);
  }
  await fs.rm(joinPath(paths.workspace(m.name), 'loadtest', 'users.json'), { force: true });
}

/** Double until the SLO breaks, then bisect between the last pass and the first fail. */
export async function searchForCapacity({
  auth,
  cli = null,
  deps,
  emit,
  m,
  perService,
  req,
  runStep,
  search,
}: {
  auth: Auth;
  cli?: CliHooks | null;
  deps: LoadtestDeps;
  emit: Emit;
  m: Metadata;
  perService: Record<string, constrainModule.Limit>;
  req: CapacityReq;
  runStep: CapacityStep;
  search: CapacitySearch;
}): Promise<void> {
  if (Object.keys(perService).length > 0) {
    try {
      search.applied = await deps.constrain.apply(m.name, perService);
    } catch (exc) {
      if (exc instanceof Interrupted) throw exc;
      throw constrainFailure(cli, exc);
    }
    // NOTED WITH THE PRIOR VALUES, so a killed run can be undone exactly rather than
    // reset to "unlimited". `restore` runs in the `finally` below; this is what covers
    // the run that never reaches it.
    search.constrainNote = journal.record(journal.CONSTRAINTS_APPLIED, m.name, {
      applied: search.applied.map((a) => ({ ...a })),
    });
  }
  search.limiterWasOff =
    (await getSetting(m.rootUrl, auth, adminPass(m), config.RC_RATE_LIMITER_SETTING)) === false;
  if (!search.limiterWasOff) {
    search.limiterNote = journal.record(journal.RATE_LIMITER_OFF, m.name);
    if (!(await setSetting(m.rootUrl, auth, adminPass(m), config.RC_RATE_LIMITER_SETTING, false))) {
      // Never turned off, so nothing to put back (as in `armAndRun`).
      search.limiterWasOff = true;
      journal.clear(search.limiterNote);
      search.limiterNote = '';
    }
  }
  if (
    (await getSetting(m.rootUrl, auth, adminPass(m), deps.monitoring.RC_METRICS_SETTING)) !== true
  ) {
    search.metricsNote = journal.record(journal.RC_METRICS_ON, m.name);
    search.metricsChanged = await setSetting(
      m.rootUrl,
      auth,
      adminPass(m),
      deps.monitoring.RC_METRICS_SETTING,
      true,
    );
  }
  // The CLI's header, once everything above is armed. An event would reach the event log's
  // sink even with no emitter, where the CLI's search has never written one.
  if (cli === null) {
    info(emit, `capacity search: ${req.scenario}, SLO ${req.slo}, steps of ${req.stepDuration}`, {
      phase: 'k6',
    });
  } else {
    cli.armed?.();
  }
  let n = req.start;
  while (n <= req.maxVus) {
    const row = await runStep(n);
    if (isTruthy(row.ok)) {
      search.lastPass = n;
      n *= 2;
    } else {
      search.firstFail = n;
      break;
    }
  }
  if (search.firstFail !== null && search.lastPass !== null) {
    let lo = search.lastPass;
    let hi = search.firstFail;
    for (let round = 0; round < 2; round += 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (mid <= lo || mid >= hi) {
        break;
      }
      const row = await runStep(mid, ' (bisect)');
      if (isTruthy(row.ok)) {
        lo = mid;
        search.lastPass = mid;
      } else {
        hi = mid;
        search.firstFail = mid;
      }
    }
  }
}

export async function runCapacity(
  req: CapacityReq,
  emit: Emit = nullEmit,
  deps: LoadtestDeps = DEFAULT_DEPS,
): Promise<Bag> {
  const prepared = await capacityPreflight(deps, req);
  const { m, perService } = prepared;
  const { search, result, why } = await runPreparedCapacity(req, prepared, emit, deps);
  return {
    ctx: {
      name: m.name,
      scenario: req.scenario,
      slo: req.slo,
      constrained: Object.keys(perService).length > 0 ? deps.constrain.human(perService) : '',
    },
    steps: search.steps,
    capacity_vus: search.lastPass,
    breach_vus: search.firstFail,
    result,
    why,
  };
}

export async function runPreparedCapacity(
  req: CapacityReq,
  prepared: CapacityPrepared,
  emit: Emit = nullEmit,
  deps: LoadtestDeps = DEFAULT_DEPS,
  cli: CliHooks | null = null,
): Promise<{ search: CapacitySearch; result: string; why: string }> {
  const { auth, m, perService, rcServices, rules, target, token, users } = prepared;
  const search = newCapacitySearch();
  let warned = false;

  const runStep: CapacityStep = async (n: number, tag = '') => {
    // Said once, at the first step that crosses it: the rows from there on are suspect.
    const words = warned ? null : sessionLimitWarning(req.scenario, n, users.length);
    if (words !== null) {
      warned = true;
      if (cli === null) warn(emit, words, { phase: 'k6' });
      else cli.warn(`  ⚠ ${words}`);
    }
    const sampler = new deps.rcmetrics.RCMetricsSampler(m.name, rcServices).start();
    let s: Bag;
    let rcm: Record<string, Record<string, rcmetricsModule.SeriesSummary>>;
    try {
      s = await deps.k6.run(m.name, req.scenario, {
        vus: n,
        duration: req.stepDuration,
        ramp: null,
        token,
        uid: auth.userId,
        target,
        users: users.length > 0 ? [...users] : null,
        password: adminPass(m),
        quiet: true,
      });
    } finally {
      rcm = await sampler.stop();
    }
    const res = deps.slo.evaluate(rules, s);
    let lagMax = 0.0;
    for (const sm of Object.values(rcm)) {
      // The first key's summary wins even if its `max` is zero: the fallback is decided on
      // the summary, not on the number.
      const lag = sm.eventloop_lag_max_s ?? sm.eventloop_lag_s;
      if (lag !== undefined && isTruthy(lag)) lagMax = Math.max(lagMax, Number(lag.max));
    }
    const row: Bag = {
      vus: n,
      rps: s.rps ?? 0.0,
      p95: s.p95 ?? 0.0,
      error_rate: s.error_rate ?? 0.0,
      ok: res.every((r) => r.ok),
      lag_max_s: lagMax,
      breached: res
        .filter((r) => !r.ok)
        .map((r) => `${r.key} ${r.op} ${r.raw} (actual ${deps.slo.fmtActual(r.key, r.actual)})`),
    };
    STEP_FLOATS.set(row, [
      ...(['rps', 'p95', 'error_rate'] as const).filter((key) => s[key] === undefined),
      'lag_max_s',
    ]);
    search.steps.push(row);
    if (cli === null) {
      info(
        emit,
        `${String(n)} VUs${tag}: ${formatFixed(Number(row.rps), 1)} req/s, ` +
          `p95 ${formatFixed(Number(row.p95), 0)}ms, ${isTruthy(row.ok) ? 'PASS' : 'FAIL'}`,
        { phase: 'k6' },
      );
    } else {
      // Each row is printed the moment it is measured, tag and all.
      cli.step?.(row, tag);
    }
    return row;
  };

  // UNWOUND by a Ctrl-C, as `runPreparedLoadtest` is.
  await unwindsOnInterrupt(async () => {
    try {
      await searchForCapacity({
        auth,
        cli,
        deps,
        emit,
        m,
        perService,
        req,
        runStep,
        search,
      });
    } finally {
      await cleanup(async () => {
        await putTheWorkspaceBack({ auth, cli, deps, emit, m, search });
      });
    }
  });

  const { result, why } =
    cli === null ? capacityVerdict(emit, req, search) : capacityWords(req, search);
  return { search, result, why };
}
