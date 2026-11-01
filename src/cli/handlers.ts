/** Command handlers: the L4 adapter from parsed CLI values to the existing TS core. */

import { constants as osConstants } from 'node:os';

import type * as AuditNS from '../core/audit';
import type * as BackupNS from '../core/backup';
import type * as ClusterNS from '../core/cluster';
import type * as DataNS from '../core/data';
import type * as DoctorNS from '../core/doctor';
import type * as EksNS from '../core/eks';
import type * as EksDocsNS from '../core/eks-docs';
import type * as EnvvarsNS from '../core/envvars';
import type * as EventlogNS from '../core/eventlog';
import type * as KubeContextNS from '../core/kube/context';
import type * as KubeAskNS from '../core/kube/ask';
import type * as PreconditionsNS from '../core/lifecycle/preconditions';
import type * as RequestNS from '../core/lifecycle/request';
import type * as KubeNamespaceNS from '../core/kube/namespace';
import type * as KubeClusterNS from '../core/kube/cluster';
import type * as KubeReachabilityNS from '../core/kube/reachability';
import type * as KubeStatusNS from '../core/kube/status';
import type * as KubeNamesNS from '../core/kube/names';
import type * as AdminNS from '../core/lifecycle/admin';
import type * as CreateDockerNS from '../core/lifecycle/create-docker';
import type * as DestroyNS from '../core/lifecycle/destroy';
import type * as InspectNS from '../core/lifecycle/inspect';
import type * as NamingNS from '../core/lifecycle/naming';
import type * as OwnershipNS from '../core/lifecycle/ownership';
import type * as PayloadNS from '../core/lifecycle/payload';
import type * as PruningNS from '../core/lifecycle/pruning';
import type * as ReadyNS from '../core/lifecycle/ready';
import type * as SeedingNS from '../core/lifecycle/seeding';
import type * as StateNS from '../core/lifecycle/state';
import type * as LifecycleTypesNS from '../core/lifecycle/types';
import type * as JournalNS from '../core/journal';
import type * as MigrateNS from '../core/migrate';
import type * as MonitorNS from '../core/monitor';
import type * as NotesNS from '../core/lifecycle/notes';
import type * as RcapiNS from '../core/rcapi';
import type * as RunnerEngineNS from '../core/runner/engine';
import type * as RunnerQueriesNS from '../core/runner/queries';
import type * as LocksNS from '../core/runner/locks';
import type * as RecordNS from '../core/runner/record';
import type * as ScaleseedNS from '../core/scaleseed';
import type * as SsoNS from '../core/sso';
import type * as SkillNS from '../core/skill';
import type * as TopologyNS from '../core/topology';
import type * as UpgradeNS from '../core/upgrade';
import type * as ConfigNS from '../lib/config';
import type * as PromoteNS from '../core/promote';
import type * as EventsNS from '../lib/events';
import type * as LibLockNS from '../lib/lock';
import type * as PresetsNS from '../lib/presets';
import type * as VersionsNS from '../lib/versions';
import type * as ResourcesNS from '../perf/resources';
import type * as BaselineNS from '../perf/baseline';
import type * as SloNS from '../perf/slo';
import type * as TimelineNS from '../perf/timeline';
import type * as TimingsNS from '../perf/timings';
import type * as SeedPlanNS from '../seed/plan';
import type * as ExecNS from '../seams/exec';
import type * as FsNS from 'node:fs';

import {
  ConflictError,
  CreateFailedError,
  NotFoundError,
  NotReadyError,
  PreflightError,
  ReproError,
  ValidationError,
  errorText,
} from '../lib/errors';
import { active, failDirectly, setHoustonVersion, warnOnce, warningsSoFar } from '../lib/jsonout';
import {
  compareCodePoints,
  formatFixed,
  formatSigned,
  dictGetChecked,
  orElse,
  floatString,
  toInt,
  quotedText,
  shownValue,
  splitFields,
  splitTextLines,
  toText,
  toTextAny,
  stripText,
  isTruthy,
  pathIsFile,
  fileErrorOf,
  storedText,
} from '../lib/format';
import { joinPath } from '../lib/home';
import { loads as jsonLoads } from '../lib/json-text';

import {
  Aborted,
  commandOutcome,
  reportBeforeCommand,
  runCli,
  usagePanelWritten,
  type CliIo,
  type CommandExecutor,
  type Invocation,
} from './app';
import { cliActorAndOrigin } from './handlers/actor';
import * as https from './handlers/https';
import { confirm } from './handlers/prompt';
import { usersCommand } from './handlers/users';
import { ljust, asciiOf, wrapWords, say, writeBox, writePanel, paint, writeTable } from './render';
import { PROCESS_CONSOLE, consoleColumns, type ConsoleEnvironment } from './error-panel';
import { runWithContext } from '../lib/context';
import { redactArgv } from '../lib/redact';
import { imageRef } from '../lib/compose';
import { compositeName } from '../lib/presets/composite';
import { capabilities } from './capabilities';
import { runCapacityCli, runLoadtestCli, type LoadtestView } from './perf';
import { serve, type ServeDependencies } from './serve';

type Values = Readonly<Record<string, string | number | boolean | string[] | null>>;
type Bag = Record<string, unknown>;

export interface HandlerDependencies {
  readonly serve?: Partial<ServeDependencies>;
  readonly prompt?: (question: string, secret: boolean) => Promise<string>;
  readonly confirm?: (question: string) => Promise<boolean>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === null ? '' : String(value ?? '');
}

/** A loadtest's missed `--slo` rules as the failure its exit 1 reports, or undefined. */
function sloMissed(data: unknown): ReproError | undefined {
  const bag = (data ?? {}) as { passed?: unknown; slo?: unknown };
  if (bag.passed !== false) return undefined;
  const missed = (Array.isArray(bag.slo) ? (bag.slo as { ok?: unknown; raw?: unknown }[]) : [])
    .filter((rule) => rule.ok === false)
    .map((rule) => text(rule.raw));
  return new ReproError(`the run missed its --slo: ${missed.join(', ') || 'a rule'}`);
}

function number(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function bool(value: unknown): boolean {
  return value === true;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

export function emitOf(invocation: Invocation, io?: CliIo) {
  return (event: Parameters<NonNullable<Invocation['events']>['emit']>[0]) => {
    if (invocation.events !== null) {
      invocation.events.emit(event);
      return;
    }
    // A terminal event, and the INFORMATIONAL `done` ones, are the command's own
    // final panel's to say; a `done` WARNING is printed -- it is where a service says what it
    // finished doing. Indented two, warnings on stderr.
    if (active() || io === undefined || event.message === undefined || event.message === '') return;
    if (event.terminal === true || (event.phase === 'done' && event.level === 'info')) return;
    if (event.level === 'warn' || event.level === 'error') io.writeErr(`  ${event.message}\n`);
    else io.writeOut(`  ${event.message}\n`);
  };
}

/**
 * A confirmation that aborts on "no": the question on stdout, asked again on an answer that
 * is not yes or no, and end of input as a "no" (`./handlers/prompt`'s `confirm` says how,
 * byte for byte). A PIPE is read too, so `echo y | houston down --volumes` works; an
 * earlier version refused anything that was not a terminal and wrote the question to
 * stderr.
 */
const defaultConfirm = confirm;

/**
 * An explicit name, else the default -- WITH the CLI's actor, so a name typed without the
 * owner prefix finds the workspace its owner made (`up --name test` makes `alice-test` once
 * accounts exist). Only where the CLI has always resolved this way: `use`, `env`, `backup`,
 * `backups`, `restore` and `upgrade` hand the name over as typed. `chown` joined in 2.x:
 * earlier releases refused `chown --name test` with exit 4 while every lifecycle command
 * took it, and a refusal is the only answer that changes.
 */
async function target(name: string): Promise<string> {
  const naming = require('../core/lifecycle/naming') as typeof NamingNS;
  const audit = require('../core/audit') as typeof AuditNS;
  return await naming.resolveName(name, audit.actor());
}

/** A transport failure from the REST seam: a `RequestFailed`, of whatever kind. */
function isRequestFailure(error: unknown): boolean {
  return (error as { name?: unknown }).name === 'RequestFailed';
}

/**
 * A REST command that could not reach or authenticate to a workspace.
 *
 * A CONNECTION failure is NOT_READY -- exit 5, "poll again" -- and a 429 is the other "wait
 * and it will work" (Rocket.Chat rate-limits token creation per user). Anything else stays
 * unclassified, because waiting will not fix it. An earlier version applied this to
 * `loadtest` only, so `api` against a workspace still coming back exited 1.
 *
 * THE NAME IS WHATEVER repro.json HOLDS, not necessarily a string. The record keeps a
 * hand-edited `"name": 123` as a number, and the message formats any value, quoted and
 * plain: `123`, `None`, `['a']`. `quotedText` assumes a string, so `token`, `pat` and `api` died
 * on `value.includes is not a function` (or on null) with a JavaScript stack and exit 1 where
 * the established answer is exit 5, and a list name came out as `'a'` where earlier
 * releases print `['a']`.
 * `shownValue` quotes and `toTextAny` spells every JSON type, and both are `quotedText`/the value
 * itself for a string, so a real name reads exactly as before.
 */
function notAnswering(meta: RecordNS.Metadata, error: unknown, what: string): never {
  const message = errorText(error);
  // A connection failure or a timeout, not every transport failure: a login whose body was
  // cut short, or that redirected thirty times, is `{what} failed: ...`, exit 1, as it has
  // always been -- and was "not answering yet", exit 5, here.
  // `RequestFailed.kind` carries which class the failure is.
  if (isRequestFailure(error) && (error as { kind?: unknown }).kind !== 'other') {
    throw new NotReadyError(
      `${shownValue(meta.name)} is not answering yet, so ${what} cannot run — wait for it with ` +
        `\`houston ready --name ${toTextAny(meta.name)}\``,
    );
  }
  if (message.includes('429') || message.includes('Too Many Requests')) {
    throw new NotReadyError(
      `Rocket.Chat is rate-limiting token creation on ${shownValue(meta.name)}, so ${what} ` +
        'cannot run yet. Its limiter resets in about a minute — try again then.',
    );
  }
  throw new ReproError(`${what} failed: ${message}`);
}

/**
 * `target` + `requireEngine` + `readMeta`: the opening three of the REST commands, and of
 * `ready` and `stats`, which open exactly this way too.
 */
async function engineMetadata(name: string) {
  const preconditions = require('../core/lifecycle/preconditions') as typeof PreconditionsNS;
  const record = require('../core/runner/record') as typeof RecordNS;
  const resolved = await target(name);
  await preconditions.requireEngine(resolved);
  return await record.readMeta(resolved);
}

async function metadata(name: string) {
  const record = require('../core/runner/record') as typeof RecordNS;
  return await record.readMeta(await target(name));
}

/**
 * `versions`: resolve one version and hand back the pairing the renderer prints.
 *
 * A VERSION `resolve` REFUSES IS A CALLER MISTAKE, NOT A CRASH. `houston versions notaversion
 * --offline` prints exactly `error: 'notaversion' is not a valid version (want e.g. 6.5.3)`,
 * exits 2 and logs VALIDATION_FAILED with `trace: false`. An earlier version called `resolve`
 * bare, so its `InvalidVersionError` reached `runCli` as an unhandled Error: a JavaScript
 * stack, "this is unhandled", and `trace: true` in the durable log -- the event log's signal
 * for a defect, raised by a typo.
 *
 * A ValidationError, as `up --version`, `upgrade --to` and `GET /api/versions/:version` raise
 * for the same refusal: one input, one exit code. This was a plain ReproError, exit 1, so
 * `versions not.a.version` exited 1 where `up --version not.a.version` exited 2. Only
 * `InvalidVersionError` is translated, so a broken shipped map or a resolver bug still
 * surfaces as unhandled.
 */
async function runVersions(args: Values, options: Values): Promise<Bag> {
  const versions = require('../lib/versions') as typeof VersionsNS;
  const request = require('../core/lifecycle/request') as typeof RequestNS;
  const version = text(args.version);
  const offline = bool(options.offline);
  // An invalid version is refused by `resolve` below WITHOUT asking the network first.
  const fetcher = await request.releaseFetcher(version, offline);
  let resolved: VersionsNS.Resolved;
  try {
    resolved = versions.resolve(version, {
      offline,
      ...(fetcher === undefined ? {} : { fetcher }),
    });
  } catch (error) {
    if (error instanceof versions.InvalidVersionError) throw new ValidationError(error.message);
    throw error;
  }
  return {
    rc_version: resolved.rcVersion,
    rc_image: resolved.rcImage,
    mongo_tag: resolved.mongoTag,
    mongo_flavor: resolved.mongoFlavor,
    mongo_shell: resolved.mongoShell,
    oplog: resolved.oplog,
    source: resolved.source,
    note: resolved.note,
  };
}

/**
 * The workspace's admin login, then the plan, before anything is written -- a login refusal a
 * plain ReproError (exit 1), an unknown profile a ValidationError (exit 2, as the GUI's seed
 * raises it), neither with a trace, and under `--json` an envelope.
 *
 * Both were called bare, so a login Rocket.Chat refused (401), one its rate limiter refused
 * (429), one that could not connect, and a typo in `--profile` / `--seed-profile` each left
 * the seed as an unhandled failure: a JavaScript stack, "this is unhandled", `trace: true`
 * in the durable log.
 *
 * ANY login failure is "not ready" -- except a 429, which is not: Rocket.Chat's own login
 * limiter answers it after a few failed attempts, and `ready` would report success and
 * change nothing. Keyed on the text, as it always was. A Ctrl-C is not a login failure and
 * is not one here. Only the plan's own refusal is translated, and nothing else the plan
 * throws.
 */
async function seedPreamble(
  meta: RecordNS.Metadata,
  options: Values,
): Promise<[Awaited<ReturnType<typeof AdminNS.login>>, SeedPlanNS.Plan]> {
  const admin = require('../core/lifecycle/admin') as typeof AdminNS;
  const plans = require('../seed/plan') as typeof SeedPlanNS;
  let auth: Awaited<ReturnType<typeof admin.login>>;
  try {
    auth = await admin.login(meta);
  } catch (error) {
    if (error instanceof (require('../seams/exec') as typeof ExecNS).Interrupted) {
      throw error;
    }
    const exc = errorText(error);
    if (exc.includes('429') || exc.toLowerCase().includes('too many requests')) {
      throw new ReproError(
        `can't seed — Rocket.Chat's login rate limiter is refusing (${exc}). The workspace is ` +
          'up; wait about a minute and retry, or turn the limiter off for this workspace with ' +
          `\`houston api -n ${toTextAny(meta.name)} -X POST /settings/` +
          `${(require('../lib/config') as typeof ConfigNS).RC_RATE_LIMITER_SETTING} ` +
          `-d '{"value": false}'\`.`,
      );
    }
    throw new ReproError(
      `can't seed — workspace not ready (\`houston ready --name ${toTextAny(meta.name)}\`): ${exc}`,
    );
  }
  try {
    return [
      auth,
      plans.planFrom(text(options.profile ?? options.seed_profile), {
        users: options.users === null || options.users === undefined ? null : number(options.users),
        channels:
          options.channels === null || options.channels === undefined
            ? null
            : number(options.channels),
        messages:
          options.messages === null || options.messages === undefined
            ? null
            : number(options.messages),
        scenarios: strings(options.scenario ?? options.seed_scenario),
        historyDays:
          options.history_days === null || options.history_days === undefined
            ? options.seed_history_days === null || options.seed_history_days === undefined
              ? null
              : number(options.seed_history_days)
            : number(options.history_days),
      }),
    ];
  } catch (error) {
    if (error instanceof plans.UnknownProfileError) throw new ValidationError(error.message);
    throw error;
  }
}

/**
 * Seed, print the result AS IT GOES, and return the summary.
 *
 * It followed the GUI's inline seed instead, and printed nothing while it ran: no `Seeding
 * 'x' (profile: ...)` line, none of the seeder's own log (the progress counts, the rooms it
 * could not create, the 2FA and rate-limiter settings it could not change), no timing table,
 * no readback lines. It handed checkSeed the CLI emitter, so the service's one-line summaries
 * printed on stderr in their place -- it takes NO emit, on purpose, and the result renders
 * from the verdict. It threw away the ResourceMonitor's report, so `--stats` printed nothing;
 * it gated before anything was shown, in a shorter sentence, and called an unproven readback
 * a failed one; and it returned `total_s` where the established envelope has `elapsed_s`.
 *
 * All of it is prose, so none of it under `--json`: the seed's summary folds into the
 * create's envelope instead, and a failure is the envelope's error.
 */
async function runSeed(meta: Awaited<ReturnType<typeof metadata>>, options: Values, io: CliIo) {
  const seeding = require('../core/lifecycle/seeding') as typeof SeedingNS;
  const locks = require('../core/runner/locks') as typeof LocksNS;
  const resources = require('../perf/resources') as typeof ResourcesNS;
  const events = require('../lib/events') as typeof EventsNS;
  // UNDER THE WORKSPACE LOCK, from the login to the gate, as the GUI's seed runs. The CLI's
  // seed once took none -- it ran straight into a backup or an upgrade holding the
  // workspace, then lost its record when `updateMeta`'s 60 s wait timed out -- and now
  // takes it here too, with the same default wait.
  return await locks.reproLock(meta.name, async () => {
    const quiet = active();
    const profile = text(options.profile ?? options.seed_profile);
    const [auth, plan] = await seedPreamble(meta, options);
    if (!quiet) {
      say(
        io,
        `Seeding ${shownValue(meta.name)} (profile: ${profile} — ${String(plan.users)} users, ` +
          `${String(plan.channels)} channels, ${String(plan.messages)} msgs/channel)…`,
      );
    }
    const monitor = bool(options.stats) ? new resources.ResourceMonitor(meta.name).start() : null;
    const started = performance.now();
    const tokens: Record<string, { token: string; userId: string }> = {};
    let summary: Bag;
    let report: Awaited<ReturnType<ResourcesNS.ResourceMonitor['stop']>> | null = null;
    try {
      summary = await seeding.seedPrepared(
        meta,
        auth,
        plan,
        events.nullEmit,
        tokens,
        quiet ? () => undefined : (message: string) => say(io, `  ${message}`),
      );
    } finally {
      // Stopped even if the seed throws: the sampler never outlives the seed.
      if (monitor !== null) report = await monitor.stop();
    }
    const total = (performance.now() - started) / 1000;
    if (!quiet) printSeedResult(summary, total, report, meta, io);
    // NO emit: `checkSeed` emits the facts this renders from the returned verdict, so
    // passing one said every line twice -- and under `--json` put a readback event and a
    // WARNING into a stream that has never carried either.
    const verdict = bag(summary.verification);
    if (!quiet) printSeedVerification(verdict, io, summary);
    // `--verify-seed` gates AFTER the report is shown. UNPROVEN IS NOT PASSED, and it is not
    // "failed: 0 mismatch(es)" either: it is a readback that could not run.
    if (bool(options.verify ?? options.verify_seed)) {
      if (verdict.ok === null || verdict.ok === undefined) {
        throw new CreateFailedError(
          'seed verification could not run, so the seed is UNPROVEN (drop --verify-seed to ' +
            'accept it anyway; the attempt is recorded in repro.json either way)',
        );
      }
      const faults = verdict.faults;
      if (verdict.ok !== true) {
        throw new CreateFailedError(
          `seed verification failed: ${String(Array.isArray(faults) ? faults.length : 0)} mismatch(es) ` +
            'between the plan and the workspace (drop --verify-seed to seed anyway; the ' +
            'readback is recorded in repro.json either way)',
        );
      }
    }
    // The summary with the profile and `elapsed_s`, rounded to 2 places -- a float, which
    // the envelope spells as one (`preserveFloatFields`). And what `--stats` measured, which
    // was printed in prose and dropped under `--json`: the sampler ran and nobody got its
    // numbers.
    return {
      ...summary,
      profile,
      elapsed_s: Number(formatFixed(total, 2)),
      ...(report === null ? {} : { resources: report }),
    };
  });
}

/** How long the seed took, and one row per thing seeded. */
function printSeedResult(
  s: Bag,
  total: number,
  report: unknown,
  meta: RecordNS.Metadata,
  io: CliIo,
): void {
  const timings = require('../perf/timings') as typeof TimingsNS;
  const d = bag(s.durations);
  const lat = bag(s.latency);
  say(io, `✓ seeded in ${timings.fmtMs(total * 1000)}`);
  const seconds = (key: string): number => Number(d[key] ?? 0);
  const row = (label: string, count: unknown, dur: number, extra = ''): void => {
    const n = Number(count);
    const rate = dur > 0.05 && isTruthy(count) ? `${formatFixed(n / dur, 1)}/s` : '';
    say(
      io,
      `  ${ljust(label, 9)} ${toTextAny(count).padStart(5)}   ${formatFixed(dur, 1).padStart(4)}s   ` +
        `${ljust(rate, 8)} ${extra}`,
    );
  };
  const latency = isTruthy(lat.count)
    ? `p50 ${timings.fmtMs(Number(lat.p50))} · p95 ${timings.fmtMs(Number(lat.p95))} · ` +
      `p99 ${timings.fmtMs(Number(lat.p99))}  ${toTextAny(s.latency_hist ?? '')}`
    : '';
  row('users', s.users, seconds('users'));
  row('channels', s.channels, seconds('channels'));
  row('messages', s.messages, seconds('messages'), latency);
  if (isTruthy(s.threads)) row('threads', s.threads, 0);
  if (isTruthy(s.reactions)) row('reactions', s.reactions, 0);
  if (isTruthy(s.files)) row('files', s.files, 0);
  if (isTruthy(s.total_content)) row('content', s.total_content, 0);
  if (isTruthy(s.rooms_total)) {
    const kinds = Object.entries(bag(s.rooms)).sort(([a], [b]) => compareCodePoints(a, b));
    row(
      'rooms',
      s.rooms_total,
      seconds('channels'),
      kinds.map(([kind, n]) => `${kind} ${toTextAny(n)}`).join(' · '),
    );
  }
  row('DMs', s.dms, seconds('dms'));
  if (isTruthy(s.users)) say(io, '  Seeded users sign in with their username as the password.');
  const planned = bag(s.planned);
  if (planned.rooms_total !== undefined)
    say(
      io,
      `  Planned: ${toTextAny(planned.users)} users · ${toTextAny(planned.rooms_total)} rooms · ` +
        `${toTextAny(planned.messages)} messages · ${toTextAny(planned.threads)} thread replies · ${toTextAny(planned.files)} files`,
    );
  if (Array.isArray(s.scenarios) && s.scenarios.length > 0)
    say(io, `  Scenarios: ${s.scenarios.map(toTextAny).join(' · ')}`);
  const history = bag(s.history);
  if (history.days !== undefined) {
    say(
      io,
      `  Synthetic history: ${toTextAny(history.days)} days · ${toTextAny(history.oldest)} to ${toTextAny(history.latest)}`,
    );
    if (Array.isArray(history.constrained) && history.constrained.length > 0)
      say(
        io,
        `  Existing discussion anchors constrain ${String(history.constrained.length)} room(s); details are saved in the seed result.`,
      );
  }
  if (Array.isArray(s.created))
    for (const raw of s.created) {
      const location = bag(raw);
      const stars = Array.isArray(location.starred_by) ? location.starred_by.map(toTextAny) : [];
      const files = Array.isArray(location.files) ? location.files.map(toTextAny) : [];
      if (stars.length === 0 && files.length === 0 && location.kind !== 'discussion') continue;
      const details = [
        ...(stars.length > 0 ? [`personal stars: sign in as ${stars.join(', ')}`] : []),
        ...(files.length > 0 ? [`files: ${files.join(', ')}`] : []),
        ...(location.kind === 'discussion' ? [`discussion in ${toTextAny(location.parent)}`] : []),
      ];
      say(io, `  ${toTextAny(location.name)}: ${details.join(' · ')}`);
    }
  renderResources(report ?? {}, io, toTextAny(meta.name));
}

/** The seed's readback, in one line when it agrees and a list when not. */
function printSeedVerification(verdict: Bag, io: CliIo, summary: Bag): void {
  const features = bag(verdict.features);
  const planned = bag(summary.planned);
  const featureRows: readonly (readonly [string, string, string])[] = [
    ['files', 'files', 'files'],
    ['thread_parents', 'thread_parents', 'thread roots'],
    ['reactions', 'reaction_actions', 'reactions'],
    ['pins', 'pins', 'pins'],
    ['stars', 'stars', 'stars'],
    ['mentions', 'mentions', 'mentions'],
    ['edits', 'edits', 'edits'],
  ];
  if (Object.keys(features).length > 0)
    say(
      io,
      '  Features (read/planned): ' +
        featureRows
          .map(
            ([actual, expected, label]) =>
              `${toTextAny(features[actual] ?? 0)}/${toTextAny(planned[expected] ?? 0)} ${label}`,
          )
          .join(' · '),
    );
  if (verdict.ok === null || verdict.ok === undefined) {
    // NOT SILENCE: a readback that could not run at all says so, and why.
    const reasons = bags(verdict.unreadable)
      .filter((entry) => isTruthy(entry.why))
      .map((entry) =>
        isTruthy(entry.what)
          ? `${toTextAny(entry.what)}: ${toTextAny(entry.why)}`
          : toTextAny(entry.why),
      );
    const why = isTruthy(verdict.why)
      ? toTextAny(verdict.why)
      : reasons.length > 0
        ? reasons.join('; ')
        : 'no reason recorded';
    say(
      io,
      `  ⚠ the seed readback could not run (${why}), so nothing about this seed is verified. ` +
        '`houston seed --name <it>` re-runs it.',
    );
    return;
  }
  const faults = isTruthy(verdict.faults) ? (verdict.faults as unknown[]) : [];
  const unreadable = isTruthy(verdict.unreadable) ? (verdict.unreadable as unknown[]) : [];
  const extra = isTruthy(verdict.extra) ? (verdict.extra as unknown[]) : [];
  if (verdict.ok === true && faults.length === 0 && unreadable.length === 0 && extra.length === 0) {
    say(io, `✓ readback: ${toTextAny(verdict.checked)} rooms match the plan`);
    return;
  }
  for (const raw of faults) {
    const f = bag(raw);
    say(
      io,
      `  ⚠ ${toTextAny(isTruthy(f.room) ? f.room : 'users')}: wanted ${toTextAny(f.want)}, ` +
        `found ${toTextAny(f.got)}${isTruthy(f.detail) ? ` (${toTextAny(f.detail)})` : ''}`,
    );
  }
  if (extra.length > 0) {
    say(
      io,
      `  · ${String(extra.length)} room(s) hold more than this run planned — they had content ` +
        'already (a re-seed, a preset, a restore). Not a fault: seeding only ever adds.',
    );
  }
  // Apart from the faults, and never as one: an unreadable room is a gap in the CHECK.
  for (const raw of unreadable) {
    const u = bag(raw);
    say(io, `  · ${toTextAny(u.what)} could not be read back (${toTextAny(u.why)})`);
  }
}

/** Repeated `--set KEY=VALUE` into a preset params mapping. */
function parseSetParams(items: readonly string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const item of items) {
    const at = item.indexOf('=');
    if (at < 0) throw new ValidationError(`--set expects KEY=VALUE, got ${quotedText(item)}`);
    params[stripText(item.slice(0, at))] = stripText(item.slice(at + 1));
  }
  return params;
}

/**
 * `--license <file|->`: the licence TEXT from a file or stdin, never from argv, where `ps`
 * shows it to every user on the box. Validated by the create; a read failure names the path
 * and never the content.
 */
function licenseFrom(source: string): string {
  if (source === '') return '';
  const fs = require('node:fs') as typeof FsNS;
  try {
    return fs.readFileSync(source === '-' ? 0 : source, 'utf8');
  } catch (error) {
    throw new ValidationError(
      `--license ${quotedText(source)} could not be read: ${errorText(error)}`,
    );
  }
}

async function runUp(invocation: Invocation, io: CliIo): Promise<unknown> {
  const lifecycle = require('../core/lifecycle/create-docker') as typeof CreateDockerNS;
  const types = require('../core/lifecycle/types') as typeof LifecycleTypesNS;
  const envvars = require('../core/envvars') as typeof EnvvarsNS;
  const monitor = require('../core/monitor') as typeof MonitorNS;
  const o = invocation.options;
  const version = text(o.version);
  // `parseSetParams`: the request is built -- and a malformed `--set` refused -- before the
  // create starts. Preset params, not env vars: the env parser has other rules and another
  // error. The release lookup is the create's own, where `resolvePairing` makes it.
  const params = parseSetParams(strings(o.set_));
  const req = types.createReq({
    version,
    // Repeatable: several presets compose into one workspace, spelled one canonical way.
    // None at all is '' rather than `default`, so a rebuild of a composed workspace can
    // tell "not said" from "said default" and keep its presets; the create reads '' as
    // `default` everywhere else.
    preset: strings(o.preset).length > 0 ? compositeName(strings(o.preset)) : '',
    runtime: text(o.runtime),
    deployment: text(o.deployment),
    replicas: number(o.replicas),
    context: text(o.context),
    mongoOperator: bool(o.mongo_operator),
    name: text(o.name),
    // WHO IS CREATING IT, which is what names it on a box with accounts: without it two
    // people running `up -v 8.5.1` derived the same workspace.
    actor: (require('../core/audit') as typeof AuditNS).actor(),
    port: number(o.port),
    rootUrl: text(o.root_url),
    bind: text(o.bind),
    rcImage: text(o.rc_image),
    mongo: text(o.mongo),
    regToken: text(o.reg_token),
    license: licenseFrom(text(o.license)),
    params,
    seed: bool(o.seed),
    // ALWAYS true: the note is this command's to close, below, and it records what a killed
    // create's recovery reads. Taking it from `--seed` let the create clear its own note and
    // wrote `seed_here: false` into every other.
    seedHere: true,
    seedProfile: text(o.seed_profile),
    seedScenarios: strings(o.seed_scenario),
    seedHistoryDays:
      o.seed_history_days === null || o.seed_history_days === undefined
        ? null
        : number(o.seed_history_days),
    pin: bool(o.pin),
    wait: bool(o.wait),
    offline: bool(o.offline),
    noPull: bool(o.no_pull),
    fresh: bool(o.fresh),
    force: bool(o.force),
    monitor: bool(o.monitor),
    stats: bool(o.stats),
    domain: text(o.domain),
    acmeEmail: text(o.email),
    https: bool(o.https),
    ingressClass: text(o.ingress_class),
    env: {
      ...envvars.parseSet(strings(o.env)),
      ...stringRecord(envvars.asSetting(strings(o.setting))),
    },
  });
  const created = await lifecycle.createRepro(req, emitOf(invocation, io), {
    // No streamed output, even under --json, as it has always been: compose draws on the
    // terminal (its stdout on stderr while --json owns stdout) and none of its
    // lines becomes an event. Streaming them under --json turned every pull and container
    // line into an NDJSON `boot` event the established stream never carries.
    streamOutput: false,
    monitorAttach: monitor.attach,
  });
  // The record, read back for the panel and notes.
  const createdMeta = active() ? null : await metadata(String(created.name ?? req.name));
  // THE NOTE IS OURS TO CLOSE, as it always has been: `seedHere` told the create not to, and
  // a failed seed throws before the clear, so reaching it means the seed landed -- or none
  // was asked for.
  const journal = require('../core/journal') as typeof JournalNS;
  if (!bool(o.seed)) {
    journal.clearKind(journal.CREATE_UNFINISHED, String(created.name));
    return createdMeta === null ? created : withMeta(created, createdMeta);
  }
  // The panel, THEN the seed. It was rendered from the return value, after the seed -- so the
  // seed's output came before the panel, and a seed that failed (a refused login, a typo in
  // `--seed-profile`, `--verify-seed` refusing) left a workspace that is up and serving with
  // no panel at all: no URL, no login. Rendered here, so the value returned for a person
  // renders nothing more.
  if (createdMeta !== null) await renderHuman(invocation, withMeta(created, createdMeta), io);
  const seed = await runSeed(await metadata(String(created.name ?? req.name)), o, io);
  journal.clearKind(journal.CREATE_UNFINISHED, String(created.name));
  // Folded in, not printed beside: exactly one envelope per command.
  return createdMeta === null ? { ...created, seed } : undefined;
}

const CONFIG_KEYS: Readonly<Record<string, string>> = Object.freeze({
  'kubernetes.context': 'kubernetes_context',
  'cluster.approved_accounts': 'cluster_approved_accounts',
  'acme.email': 'acme_email',
  'acme.staging': 'acme_staging',
  'acme.challenge': 'acme_challenge',
  'acme.dns_provider': 'acme_dns_provider',
  bind_host: 'bind_host',
  'gui.create_policy': 'gui.create_policy',
  'gui.destroy_policy': 'gui.destroy_policy',
  // Okta sign-in for the GUI. The client secret is never one of these: `config list` prints
  // them, so it lives in `<home>/sso.env` or the environment (see `core/sso`).
  'sso.issuer': 'sso.issuer',
  'sso.client_id': 'sso.client_id',
  'sso.public_url': 'sso.public_url',
  'sso.email_domains': 'sso.email_domains',
  'sso.provision': 'sso.provision',
});

/** The owner a workspace's record names, for a result line; '' for nobody or no record. */
async function recordOwner(name: string): Promise<string> {
  const runnerRecord = require('../core/runner/record') as typeof RecordNS;
  const meta = await runnerRecord.readMeta(name).catch(() => null);
  return meta === null ? '' : runnerRecord.recordedOwner(meta);
}

/**
 * The owner leads the prompt, because on a shared box the thing you most need to know first
 * is whose data it is -- and is still said under `--yes`, where there is no prompt to read
 * but there is a log to read afterwards.
 */
async function confirmDestruction(
  io: CliIo,
  name: string,
  yes: boolean,
  dependencies: HandlerDependencies,
): Promise<void> {
  const ownership = require('../core/lifecycle/ownership') as typeof OwnershipNS;
  const audit = require('../core/audit') as typeof AuditNS;
  // `toTextAny` of the raw owner `ownerOf` returns, which a hand-edited record can make an
  // int or a list.
  const owner = await ownership.ownerOf(name);
  const me = audit.actor();
  const whose = isTruthy(owner) && owner !== me ? ` -- owned by ${toTextAny(owner)}` : '';
  const warnLine = (line: string): void => (active() ? io.writeErr(`${line}\n`) : say(io, line));
  if (!yes) {
    if (whose !== '') warnLine(`${quotedText(name)} belongs to ${toTextAny(owner)}, not you.`);
    // No `quotedText` here: its quotes collide with the possessive.
    const question = `This permanently deletes the data volume and record for ${name}${whose}. Continue?`;
    if (!(await (dependencies.confirm ?? defaultConfirm)(question))) throw new Aborted();
  } else if (whose !== '') {
    warnLine(`deleting ${quotedText(name)}, owned by ${toTextAny(owner)}.`);
  }
}

/** Name every destructive target before asking once. */
async function confirmPrune(
  io: CliIo,
  targets: readonly string[],
  stray: readonly string[],
  dependencies: HandlerDependencies,
): Promise<void> {
  const ownership = require('../core/lifecycle/ownership') as typeof OwnershipNS;
  const audit = require('../core/audit') as typeof AuditNS;
  const pruning = require('../core/lifecycle/pruning') as typeof PruningNS;
  const namespaces = require('../core/kube/namespace') as typeof KubeNamespaceNS;
  const me = audit.actor();
  say(
    io,
    'These workspaces were taken down with `houston down`; their containers, kept data and ' +
      'records will be deleted for good (stopped ones are not touched):',
  );
  for (const name of targets) {
    const owner = await ownership.ownerOf(name);
    say(
      io,
      `  - ${name}${isTruthy(owner) && owner !== me ? `   (owned by ${toTextAny(owner)})` : ''}`,
    );
  }
  if (stray.length > 0) {
    say(io, '');
    say(
      io,
      "These Kubernetes namespaces are labelled houston's but no local record explains " +
        'them — their data (PersistentVolumeClaims) goes too:',
    );
    for (const ns of stray) {
      // The same three answers the service decides on, so the prompt cannot promise a
      // sweep the service then refuses. Never raises: this is prompt text.
      let owner: string | null;
      try {
        owner = await namespaces.namespaceOwner(ns, { context: await pruning.orphanContext() });
      } catch {
        owner = null;
      }
      if (owner === null) say(io, `  - ${ns}   (owner could not be read — needs --force)`);
      else if (owner !== '' && owner !== me)
        say(io, `  - ${ns}   (belongs to ${owner} — needs --force)`);
      else say(io, `  - ${ns}`);
    }
    say(io, '  (on a shared cluster one of these may belong to a colleague)');
  }
  if (!(await (dependencies.confirm ?? defaultConfirm)('Continue?'))) throw new Aborted();
}

async function dispatch(
  invocation: Invocation,
  dependencies: HandlerDependencies,
  io: CliIo,
): Promise<unknown> {
  const o = invocation.options;
  const a = invocation.arguments;
  const emit = emitOf(invocation, io);
  switch (invocation.spec.path) {
    case 'capabilities':
      return capabilities();
    case 'up':
      return await runUp(invocation, io);
    case 'ready': {
      const ready = require('../core/lifecycle/ready') as typeof ReadyNS;
      // `requireEngine` BEFORE the first poll. Without it a stopped daemon went straight
      // to the poll, whose liveness check found no container and reported NOT_READY, exit 5
      // ("Rocket.Chat container is not running") -- the code that tells a caller to poll
      // again. The established answer is ENGINE_UNAVAILABLE, exit 3, because polling cannot
      // start Docker. Measured by the CLI differential, docker stubbed.
      const meta = await engineMetadata(text(o.name));
      // Said before the first poll, on stdout, and only to a person: `--json` streams its
      // events instead. An earlier version never said it, so a slow boot was a silent prompt
      // until the first "still booting" line.
      if (!active())
        io.writeOut(`Waiting for ${quotedText(meta.name)} to serve ${meta.rootUrl} ...\n`);
      const result = {
        ...(await ready.waitAndFinalize(meta, emit, number(o.timeout))),
        name: meta.name,
        url: meta.publicUrl || meta.rootUrl,
      };
      return withMeta(result, meta);
    }
    case 'down': {
      const destroy = require('../core/lifecycle/destroy') as typeof DestroyNS;
      const volumes = bool(o.volumes);
      const yes = bool(o.yes);
      // RESOLVED FIRST, as `down` does: a name that does not exist is NOT_FOUND (exit 4)
      // whatever else is wrong with the command, and only then is the refusal asked.
      const name = await target(text(o.name));
      if (volumes && active() && !yes) {
        // REFUSED, not silently downgraded to keeping the volume: there is nobody to
        // prompt, and both ways out of that are unacceptable for an irreversible verb.
        throw new ValidationError(
          '--volumes deletes the data volume and the record, and --json has nobody to ' +
            'prompt. Add --yes to confirm it in the command.',
        );
      }
      if (volumes) await confirmDestruction(io, name, yes, dependencies);
      // Read BEFORE the teardown: with --volumes the record that names the owner is gone after.
      const runnerRecord = require('../core/runner/record') as typeof RecordNS;
      const was = await runnerRecord.readMeta(name).catch(() => null);
      const owner = was === null ? '' : runnerRecord.recordedOwner(was);
      const result = await destroy.teardown(name, { volumes, confirm: true, emit });
      const data = { ...result, name, volumes, owner };
      if (!active() && volumes && result.removed === false) {
        return commandOutcome(data, 5);
      }
      return data;
    }
    case 'monitor': {
      const monitor = require('../core/monitor') as typeof MonitorNS;
      const name = await target(text(o.name));
      return bool(o.off) ? await monitor.detach(name, emit) : await monitor.attach(name, emit);
    }
    case 'prune': {
      const pruning = require('../core/lifecycle/pruning') as typeof PruningNS;
      const shown = await pruning.prunable();
      const stray = bool(o.orphans) ? await pruning.orphanNamespaces() : [];
      // The CLUSTER is reclaimable separately from any workspace: with everything gone,
      // houston's own kind control plane is 514 MiB holding nothing. ASKED ON EVERY PRUNE,
      // before the empty check and the prompt, as it always has been (`clusterReclaimable`)
      // -- even when there are targets and the answer goes unused. This asked only on the
      // nothing-to-prune branch, so with kind on PATH a prune with targets ran none of `kind
      // get clusters`, `kubectl config current-context` and the `/readyz` probe a prune has
      // always run, and an aborted one left no `clients/` tree where earlier releases leave
      // one.
      let reclaimable: boolean;
      const cluster = require('../core/kube/cluster') as typeof KubeClusterNS;
      try {
        reclaimable = await cluster.clusterReclaimable();
      } catch {
        // A cleanup verb must not become destructive, or fail, because a probe did.
        reclaimable = false;
      }
      if (shown.length === 0 && stray.length === 0) {
        if (!reclaimable) return { targets: [], removed: [], orphans: [], cluster: false };
        if (!bool(o.yes)) {
          say(
            io,
            "Nothing to prune, but houston's own Kubernetes cluster is empty and can be " +
              'given back (about 0.5 GB).',
          );
          if (!(await (dependencies.confirm ?? defaultConfirm)('Delete the cluster?'))) {
            throw new Aborted();
          }
        }
        const res = await pruning.prune({
          confirm: true,
          orphans: bool(o.orphans),
          force: bool(o.force),
          emit,
        });
        return { ...res, emptyCluster: true };
      }
      if (!bool(o.yes)) await confirmPrune(io, shown, stray, dependencies);
      return await pruning.prune({
        confirm: true,
        orphans: bool(o.orphans),
        force: bool(o.force),
        only: shown,
        onlyStray: stray,
        emit,
      });
    }
    case 'start':
    case 'stop':
    case 'restart': {
      const state = require('../core/lifecycle/state') as typeof StateNS;
      const name = await target(text(o.name));
      const action = invocation.spec.path as 'start' | 'stop' | 'restart';
      if (action !== 'start') return await state.setState(name, action, emit);
      try {
        return await state.setState(name, action, emit);
      } catch (error) {
        // `start` answers a domain failure with a red error line and a plain exit, keeping the
        // class's exit code, so the log has an `end` record and no `error` one; `stop` and
        // `restart` throw through the error contract and keep that path. The line is the
        // SERVICE'S OWN now. It was one fixed sentence for every failure -- "if it was
        // `down`ed, use `houston up`" -- which sent a workspace that was merely stopped with
        // its port held to recreate itself, while the core knew which it was and why.
        if (!(error instanceof ReproError)) throw error;
        io.writeErr(`error: ${error.message}\n`);
        return commandOutcome(undefined, error.exitCode);
      }
    }
    case 'use': {
      const naming = require('../core/lifecycle/naming') as typeof NamingNS;
      const target = await naming.resolveName(text(a.name));
      await (require('../core/runner/locks') as typeof LocksNS).updateConfig((stored) => {
        stored.default_repro = target;
      });
      return { default: target };
    }
    case 'list': {
      const inspect = require('../core/lifecycle/inspect') as typeof InspectNS;
      const repros = await inspect.listRepros();
      return { repros, count: repros.length };
    }
    case 'info': {
      const name = await target(text(o.name));
      if (!active()) {
        // The record alone, as the human `info` has always read it: `detail()` asks docker
        // and the compose file, which a person reading a URL and a login does not need,
        // and which failed where the record alone answers (see summaryPanel).
        const record = require('../core/runner/record') as typeof RecordNS;
        return withMeta({}, await record.readMeta(name));
      }
      const payload = require('../core/lifecycle/payload') as typeof PayloadNS;
      return await payload.detail(name);
    }
    case 'users':
      // Printed as it goes (`handlers/users.ts`): it is `json: none`, so what it prints and
      // the code it exits with are its whole contract.
      await usersCommand(
        io,
        {
          action: text(a.action),
          name: text(a.name),
          role: text(a.role),
          askPassword: bool(o.ask_password),
        },
        dependencies.prompt,
      );
      return undefined;
    case 'config': {
      const config = require('../lib/config') as typeof ConfigNS;
      const action = text(a.action);
      const key = text(a.key);
      if (action === 'list') {
        const stored = config.loadConfig();
        return Object.fromEntries(
          Object.entries(CONFIG_KEYS).map(([shown, internal]) => [
            shown,
            Object.hasOwn(stored, internal) ? stored[internal] : null,
          ]),
        );
      }
      // THE ACTION FIRST: the order earlier releases kept checked the key first, so `config
      // frob x` answered "unknown key 'x'" about a command whose mistake was `frob`. Every
      // refusal quotes what was typed with `quotedText`: hand-written quotes printed `'it's'`
      // for `"it's"` and a raw tab for `'a\tb'`.
      if (!['get', 'set', 'unset'].includes(action))
        throw new ValidationError(
          `unknown action ${quotedText(action)} (want: list | get | set | unset)`,
        );
      const internal = CONFIG_KEYS[key];
      if (internal === undefined)
        throw new ValidationError(
          `unknown key ${quotedText(key)} (want: ${Object.keys(CONFIG_KEYS).join(', ')})`,
        );
      if (action === 'get') return { key, value: config.loadConfig()[internal] ?? null };
      if (action === 'unset') {
        await (require('../core/runner/locks') as typeof LocksNS).updateConfig((stored) => {
          delete stored[internal];
        });
        return { key, unset: true };
      }
      const given = text(a.value);
      if (given === '') throw new ValidationError(`\`config set ${key}\` needs a value`);
      if (key === 'gui.create_policy' || key === 'gui.destroy_policy') {
        const strict = key === 'gui.create_policy' ? 'admin' : 'owner';
        if (given !== 'anyone' && given !== strict)
          throw new ValidationError(
            `${key} takes 'anyone' or '${strict}' (got ${quotedText(given)})`,
          );
      }
      // Refused like the policies: the edge reads only these three (`forcedChallenge`), so
      // any other value was stored and silently did nothing.
      if (key === 'acme.challenge' && !['http', 'tlsalpn', 'dns'].includes(given)) {
        throw new ValidationError(`${key} takes http, tlsalpn or dns (got ${quotedText(given)})`);
      }
      let value: unknown = given;
      if (key.startsWith('sso.')) {
        const sso = require('../core/sso') as typeof SsoNS;
        value = sso.checkSetting(key, given);
        if (key === 'sso.issuer') sso.requireReadyForIssuer(config.loadConfig(false));
      }
      if (key === 'acme.staging') {
        // `TRUE_WORDS` + `FALSE_WORDS` after `stripText`, the empty word excluded: `y`, `t`,
        // `n` and `f` were refused here, and `trim()` stripped a BOM `stripText` keeps and
        // kept the separators and NEL it strips.
        const low = stripText(given).toLowerCase();
        if (low === '' || !(config.TRUE_WORDS.includes(low) || config.FALSE_WORDS.includes(low)))
          throw new ValidationError(`${key} takes true or false (got ${quotedText(given)})`);
        value = config.truthy(given);
      }
      await (require('../core/runner/locks') as typeof LocksNS).updateConfig((stored) => {
        stored[internal] = value;
      });
      return { key, value };
    }
    case 'env': {
      const envvars = require('../core/envvars') as typeof EnvvarsNS;
      // No `--set`, `--setting` or `--unset` typed means a read: read or write is decided on
      // what was TYPED, not on what parsing kept. Decided on the parsed keys, a `--set
      // __proto__=x` the parser lost turned a write into a read that printed the panel and
      // exit 0, with nothing written.
      if (
        strings(o.set_).length === 0 &&
        strings(o.setting).length === 0 &&
        strings(o.unset).length === 0
      )
        return await envvars.current(text(o.name));
      const sets = {
        ...envvars.parseSet(strings(o.set_)),
        ...stringRecord(envvars.asSetting(strings(o.setting))),
      };
      return await envvars.setEnv(text(o.name), sets, strings(o.unset), {
        restart: !bool(o.no_restart),
        emit,
      });
    }
    case 'edge': {
      // `https.edgeCommand`: this command is `json: none`, so what it prints and the code it
      // exits with are its whole contract.
      const action = text(a.action);
      const edge = async (): Promise<number> =>
        await https.edgeCommand(
          io,
          action,
          text(a.host),
          { follow: bool(o.follow), tail: number(o.tail), yes: bool(o.yes) },
          dependencies.confirm ?? defaultConfirm,
        );
      return commandOutcome(null, await edge());
    }
    case 'tls-status':
      // Human-only, so its prose and exit code are the contract. Nothing serving TLS is
      // exit 1, as it always was.
      return commandOutcome(null, await https.tlsStatus(io, text(o.name)));
    case 'trust-ca':
      // Human-only, printed as it goes, exit 0 either way.
      return commandOutcome(null, await https.trustCa(io, bool(o.uninstall), bool(o.show)));
    case 'token': {
      const admin = require('../core/lifecycle/admin') as typeof AdminNS;
      const meta = await engineMetadata(text(o.name));
      try {
        const auth = await admin.login(meta);
        return { token: auth.token, user_id: auth.userId };
      } catch (error) {
        return notAnswering(meta, error, 'logging in');
      }
    }
    case 'pat': {
      const admin = require('../core/lifecycle/admin') as typeof AdminNS;
      const rcapi = require('../core/rcapi') as typeof RcapiNS;
      const record = require('../core/runner/record') as typeof RecordNS;
      const meta = await engineMetadata(text(o.name));
      let auth: Awaited<ReturnType<typeof admin.login>>;
      let token: string;
      try {
        auth = await admin.login(meta);
        token = await rcapi.generatePat(meta.rootUrl, auth, record.adminPass(meta), {
          tokenName: text(o.label),
          bypass2fa: bool(o.bypass_2fa),
          workspace: meta.name,
        });
      } catch (error) {
        return notAnswering(meta, error, 'minting a token');
      }
      return {
        token,
        user_id: auth.userId,
        label: text(o.label),
        bypass_2fa: bool(o.bypass_2fa),
        name: meta.name,
        root_url: meta.rootUrl,
      };
    }
    case 'api': {
      const admin = require('../core/lifecycle/admin') as typeof AdminNS;
      const rcapi = require('../core/rcapi') as typeof RcapiNS;
      const record = require('../core/runner/record') as typeof RecordNS;
      // ANY method, upper-cased, as `rcapi.call` sends it: there has never been an
      // allowlist, so HEAD and OPTIONS are sent rather than refused.
      const method = text(a.method).toUpperCase();
      // The established order: the workspace, its engine, the login -- and only then the body.
      const meta = await engineMetadata(text(o.name));
      let auth: Awaited<ReturnType<typeof admin.login>>;
      try {
        auth = await admin.login(meta);
        if (bool(o.pat))
          auth = {
            token: await rcapi.generatePat(meta.rootUrl, auth, record.adminPass(meta), {
              bypass2fa: true,
              workspace: meta.name,
            }),
            userId: auth.userId,
          };
      } catch (error) {
        return notAnswering(meta, error, 'this API call');
      }
      let body: unknown;
      try {
        // `jsonLoads`, so the refusal quotes the established reason. And the body sent is
        // written back from what `jsonLoads` read, so what a double loses is kept for the
        // writer: `-d 12345678901234567890` went out as 12345678901234567000, and
        // `-d '{"b":1,"2":2}'` with the `2` first.
        body = text(o.data) === '' ? undefined : jsonLoads(text(o.data), { spelledRoot: true });
      } catch (error) {
        throw new ValidationError(`--data is not valid JSON: ${errorText(error)}`);
      }
      const extraHeaders = bool(o.two_fa)
        ? await rcapi.password2faHeaders(record.adminPass(meta))
        : undefined;
      // A monotonic clock with a fractional part: `fmtMs` rounds what it is given, and a
      // whole-ms clock would round twice.
      const started = performance.now();
      let status: number;
      let response: string;
      try {
        [status, response] = await rcapi.call(meta.rootUrl, method, text(a.path), {
          auth,
          ...(body === undefined ? {} : { data: body }),
          ...(extraHeaders === undefined ? {} : { extraHeaders }),
        });
      } catch (error) {
        if (!isRequestFailure(error)) throw error;
        throw new ReproError(`request failed: ${errorText(error)}`);
      }
      const data = {
        status,
        text: response,
        auth: bool(o.pat) ? 'PAT' : 'admin',
        elapsed_ms: performance.now() - started,
      };
      return status >= 400 ? commandOutcome(data, 1) : data;
    }
    case 'seed': {
      const data = require('../core/data') as typeof DataNS;
      const events = require('../lib/events') as typeof EventsNS;
      if (
        (strings(o.scenario).length > 0 ||
          (o.history_days !== null && o.history_days !== undefined)) &&
        (text(o.scale) !== '' || bool(o.clear_scale))
      )
        throw new ValidationError(
          '--scenario and --history-days cannot be combined with --scale or --clear-scale',
        );
      // `engineMetadata` -- the name, the engine check, the record -- as `seed` has always
      // opened: a stopped engine is ENGINE_UNAVAILABLE, exit 3, before any login, prefill or
      // undo. This read the record and went on to a REST login, refused in its own words with
      // exit 1.
      const meta = await engineMetadata(text(o.name));
      // The two scale paths: the services run with NO emit, and the command says it all
      // itself -- the headline on stdout BEFORE the spec is read, so a refused spec is still
      // told what `--scale` is, and the totals with thousands commas. The CLI emitter was
      // handed down instead: the service's own warning (" - ", not " — ") went to stderr, its
      // "inserting"/"inserted" lines to stdout, and a refusal printed no headline at all.
      if (bool(o.clear_scale)) return await data.clearScale(meta.name, events.nullEmit);
      if (text(o.scale) !== '') {
        say(
          io,
          'bulk Mongo prefill: users are credential-less and messages fire no app hooks — ' +
            'for scale and performance tests, not feature testing.',
        );
        return await data.runScale(meta.name, text(o.scale), events.nullEmit);
      }
      return await runSeed(meta, o, io);
    }
    case 'config-import': {
      const data = require('../core/data') as typeof DataNS;
      const typed = text(a.settings_file);
      // The typed path, normalised by `joinPath`, is what is checked and what the service
      // reads. That drops a trailing `/` and `.` parts, so `settings.json/` IS the file -- a
      // plan, and an import -- where the stat of the typed text failed with ENOTDIR and
      // this said "no such file". The refusal quotes what was typed.
      const file = joinPath(typed);
      if (!pathIsFile(file)) throw new NotFoundError(`no such file: ${typed}`);
      // Each comma-separated term, stripped, or no filter for no `--only`: an EMPTY term is
      // kept. Dropped here, `--only ,` or `--only ' '` was an empty set, which the plan
      // reads as no filter at all -- so a filter that matches nothing applied the WHOLE
      // dump, OAuth providers and all, where a set holding only `''` applies nothing.
      const selected =
        text(o.only) === ''
          ? null
          : new Set(
              text(o.only)
                .split(',')
                .map((part) => stripText(part)),
            );
      // The engine check (`engineMetadata`) after the name and before the plan: a stopped
      // engine refused nothing here, and `--dry-run` printed the plan with exit 0.
      const meta = await engineMetadata(text(o.name));
      const plan = await data.importPlan(meta.name, file, selected);
      // DRAWN HERE, before anything is applied, as it has always been drawn: the plan box and
      // the secrets to set by hand come first on an apply too, so the operator sees what is
      // about to change before the providers are created. The renderer drew a panel of its
      // own words for the dry run only, and said nothing of the redacted secrets in either
      // mode.
      if (!active()) renderImportPlan(io, plan, bool(o.dry_run));
      if (bool(o.dry_run)) return plan;
      return withMeta({ ...(await data.importApply(meta.name, file, selected, emit)) }, meta);
    }
    case 'backup': {
      const backup = require('../core/backup') as typeof BackupNS;
      return await backup.create(text(o.name), {
        out: text(o.out),
        note: text(o.label),
        live: bool(o.live),
        emit,
      });
    }
    case 'backups': {
      const backup = require('../core/backup') as typeof BackupNS;
      return { backups: await backup.listBackups(text(o.name)) };
    }
    case 'restore': {
      const backup = require('../core/backup') as typeof BackupNS;
      return await backup.restore(text(a.bundle), {
        name: text(o.name),
        new: bool(o.new),
        allowUpgrade: bool(o.allow_upgrade),
        force: bool(o.force),
        emit,
      });
    }
    case 'upgrade': {
      const upgrade = require('../core/upgrade') as typeof UpgradeNS;
      if (bool(o.rollback))
        return await upgrade.rollback(text(o.name), { bundle: text(o.bundle), emit });
      if (text(o.to) === '')
        throw new ValidationError(
          'no target version given — use `--to 8.6.1` (or `--rollback` to undo)',
        );
      const plan = await upgrade.plan(text(o.name), text(o.to), { offline: bool(o.offline) });
      // The upgrade DRAWS THE PLAN FIRST, then decides, then runs. This returned the plan for
      // `renderHuman` to draw afterwards, so a real upgrade never showed its panel or its
      // warnings at all (they would have landed after the run); a refusal never said why --
      // no reason, no `--force` hint, and `--dry-run: nothing changed` for a plan that was
      // refused; and a forced plan's reason was dropped. `upgrade` has no `--json`, so
      // drawing here is safe. The reason goes to stderr as a failure line before the exit,
      // and to stdout as a warning line when `--force` carries on past it. Exit 1 after it
      // writes no error record, which is what an outcome with no error is.
      renderUpgradePlan(plan, io);
      if (!isTruthy(plan.allowed)) {
        const reason = `  ${toTextAny(plan.blocked_reason)}\n`;
        if (!bool(o.force)) {
          io.writeErr(reason);
          io.writeOut('  --force overrides this, but expect it to fail\n');
          return commandOutcome(null, 1);
        }
        io.writeOut(reason);
      }
      if (bool(o.dry_run)) {
        io.writeOut('  --dry-run: nothing changed\n');
        return null;
      }
      return await upgrade.run(text(o.name), text(o.to), {
        offline: bool(o.offline),
        force: bool(o.force),
        noBackup: bool(o.no_backup),
        rollbackOnFailure: !bool(o.no_rollback),
        emit,
      });
    }
    case 'stats':
      return await runStats(invocation, io);
    case 'loadtest': {
      const result = await runLoadtestCli(
        {
          name: text(o.name),
          scenario: text(o.scenario),
          endpoint: text(o.endpoint),
          body: text(o.body),
          vus: number(o.vus),
          usersN: number(o.users_n),
          duration: text(o.duration),
          ramp: text(o.ramp),
          spike: text(o.spike),
          live: bool(o.live),
          slo: text(o.slo),
          constrain: text(o.constrain),
          diag: bool(o.diag),
          slowms: number(o.slowms),
          stats: bool(o.stats),
          save: text(o.save),
          compare: text(o.compare),
          json: bool(o.json_out),
          report: bool(o.report),
          reportPath: text(o.report_path),
        },
        io,
        undefined,
        (view) => {
          renderLoadtest(view, io);
        },
      );
      return commandOutcome(result.data, result.exitCode, sloMissed(result.data));
    }
    case 'capacity': {
      const result = await runCapacityCli(
        {
          name: text(o.name),
          scenario: text(o.scenario),
          usersN: number(o.users_n),
          slo: text(o.slo),
          start: number(o.start),
          maxVus: number(o.max_vus),
          stepDuration: text(o.step_duration),
          constrain: text(o.constrain),
          json: bool(o.json_out),
          report: bool(o.report),
          reportPath: text(o.report_path),
        },
        io,
      );
      return commandOutcome(result.data, result.exitCode);
    }
    case 'logs': {
      const topology = require('../core/topology') as typeof TopologyNS;
      const name = await target(text(o.name));
      // `requireEngine`: the engine THIS workspace needs, asked before its logs are, so a
      // stopped daemon is a preflight (exit 3) rather than whatever `docker` exits with.
      // The record is read on the Kubernetes path only: a damaged repro.json is exactly the
      // workspace whose logs somebody needs.
      const preconditions = require('../core/lifecycle/preconditions') as typeof PreconditionsNS;
      await preconditions.requireEngine(name);
      if ((await topology.ofRepro(name)) === topology.KUBERNETES) {
        const meta = await metadata(name);
        const status = require('../core/kube/status') as typeof KubeStatusNS;
        // Ctrl-C "is how you leave" a follow, so the command answers it itself: the read
        // stops, kubectl is sent SIGTERM, and the command exits with kubectl's code. That
        // is a death by a signal, so `returncode` is its negation: -15 for the SIGTERM (exit
        // 241) when the SIGINT reached houston alone, -2 (exit 254) when a terminal's Ctrl-C
        // killed kubectl first, with an `end` record saying so. This answered 130 with
        // runMain's handler, and `?? 0` read any death by a signal as a success. The listener
        // is this command's own from the moment kubectl runs, so runMain's steps aside;
        // before that -- the pod count -- a Ctrl-C is an interrupt like any other.
        const terminate = new AbortController();
        const stop = (): void => terminate.abort();
        let result: Awaited<ReturnType<typeof status.logProcess>>;
        try {
          result = await status.logProcess(meta.name, {
            context: recordedContext(meta.extra),
            tail: number(o.tail) || 200,
            follow: bool(o.follow),
            abortSignal: terminate.signal,
            onSpawn: () => process.on('SIGINT', stop),
            // Each line echoed as it arrives, and nothing kept: every line was pushed into
            // an array for a result nobody reads -- `logs` has no `--json` -- so a `logs -f`
            // grew without bound for as long as it ran.
            onLine: (line) => {
              if (!active()) io.writeOut(`${line}\n`);
            },
          });
        } finally {
          process.off('SIGINT', stop);
        }
        const code =
          result.exitCode ??
          (result.signal === null ? 0 : -(osConstants.signals[result.signal] as number));
        return commandOutcome({ exit_code: code }, code);
      }
      const engine = require('../core/runner/engine') as typeof RunnerEngineNS;
      const code = await engine.logs(name, {
        follow: bool(o.follow),
        ...(number(o.tail) === 0 ? {} : { tail: number(o.tail) }),
      });
      // Exit 0 whatever compose said: `logs` has always discarded that code; only the
      // Kubernetes branch above hands the process's own code back.
      return commandOutcome({ exit_code: code ?? 0 }, 0);
    }
    case 'presets': {
      const presets = require('../lib/presets') as typeof PresetsNS;
      return { presets: presets.listPresets() };
    }
    case 'versions':
      return await runVersions(a, o);
    case 'audit': {
      const audit = require('../core/audit') as typeof AuditNS;
      const page = audit.read({
        actorName: text(o.actor),
        kind: text(o.kind),
        since: text(o.since),
        q: text(o.q),
        // `read(limit=max(1, n))`: `-n 0` and `-n -1` show the newest line. Passed as typed,
        // the read loop never ran and the answer was `nothing matched`.
        limit: Math.max(1, number(o.n)),
      });
      const lines = bool(o.denied)
        ? page.lines.filter((row) => row.outcome === 'denied')
        : page.lines;
      if (bool(o.tsv) && !active())
        for (const row of lines)
          io.writeOut(
            `${row.ts}\t${row.actor || '-'}\t${row.kind}\t${row.label}\t${row.origin || '-'}\t${row.outcome}\n`,
          );
      return { ...page, lines };
    }
    case 'chown': {
      const ownership = require('../core/lifecycle/ownership') as typeof OwnershipNS;
      return await ownership.setOwner(await target(text(o.name)), text(o.to), {
        by: (require('../core/audit') as typeof AuditNS).actor(),
      });
    }
    case 'skill install': {
      const skill = require('../core/skill') as typeof SkillNS;
      return skill.install(text(o.host), { force: bool(o.force) });
    }
    case 'skill status': {
      const skill = require('../core/skill') as typeof SkillNS;
      return skill.state();
    }
    case 'doctor': {
      const doctor = require('../core/doctor') as typeof DoctorNS;
      const report = await doctor.runChecks(text(o.context));
      const checks = Array.isArray(report.checks) ? (report.checks as Bag[]) : [];
      for (const row of checks)
        if (['warn', 'fail'].includes(String(row.status)))
          warnOnce(
            `DOCTOR_${String(row.check ?? 'check')
              .toUpperCase()
              .replace(/-/gu, '_')}`,
            String(row.message ?? ''),
            { check: row.check, status: row.status },
          );
      if (report.verdict === 'fail') {
        if (active()) {
          // `jsonout.fail(..., warnings=jsonout.warnings_so_far())`, called directly: the
          // one envelope that carries what was collected, and no `error` record.
          throw failDirectly(
            new PreflightError('doctor checks failed', { details: report }),
            warningsSoFar(),
          );
        }
        return commandOutcome(report, 1);
      }
      return report;
    }
    case 'cluster':
      return await runCluster(invocation, dependencies, io);
    case 'serve': {
      const served = await serve(
        {
          port: number(o.port),
          domain: text(o.domain),
          email: text(o.email),
          noDomain: bool(o.no_domain),
          bind: text(o.bind),
          allowHost: strings(o.allow_host),
          noOpen: bool(o.no_open),
          printService: bool(o.print_service),
          insecure: bool(o.insecure),
          trustProxy: strings(o.trust_proxy),
        },
        dependencies.serve ?? {},
        io,
      );
      // The no-accounts stop is printed and exits 3 with no `error:` line.
      return 'refused' in served ? commandOutcome(null, served.exitCode) : served;
    }
    default:
      throw new ValidationError(`handler for '${invocation.spec.path}' is not available`);
  }
}

async function runCluster(
  invocation: Invocation,
  dependencies: HandlerDependencies,
  io: CliIo,
): Promise<unknown> {
  const o = invocation.options;
  const a = invocation.arguments;
  const action = text(a.action);
  const emit = emitOf(invocation, io);
  if (action === 'status') {
    const cluster = require('../core/cluster') as typeof ClusterNS;
    // A bare name, as create/delete/keep/share take it, or --context: the same cluster.
    const report = await cluster.status(text(o.context) || text(a.name), emit);
    const unreadable = Array.isArray(report.unreadable) ? report.unreadable : [];
    if (active()) {
      for (const missing of unreadable) {
        warnOnce(
          `CLUSTER_UNREADABLE_${String(missing).toUpperCase()}`,
          `${String(missing)} could not be read; it is reported as unknown rather than as none`,
        );
      }
    }
    if (report.context === '' || report.reachable === false) {
      const message =
        `cluster ${report.context || '(none)'} is not usable from here: ` +
        (report.context === ''
          ? 'no context is configured'
          : report.gone === true
            ? 'AWS says it no longer exists, so nothing there is billing'
            : 'it is not reachable');
      // A PreflightError: the message and no details. The envelope carried the whole ledger
      // row as `error.details`, which the established envelope never has.
      if (active()) throw new PreflightError(message);
      if (report.context === '') {
        // The context line, then a failure line -- stderr, no `error:` prefix -- and a plain
        // exit 3, which writes no durable error record. This printed "'' cannot be read: it
        // is not answering" on stdout instead.
        say(io, 'cluster   (none)');
        io.writeErr(
          'No cluster configured. `houston config set kubernetes.context <name>`, ' +
            'or point kubectl at one.\n',
        );
        return commandOutcome(undefined, 3);
      }
      // WHICH KIND OF UNREACHABLE, both sentences of it, on stderr with no `error:` prefix,
      // and then the advice on stdout. The renderer printed the first sentence alone on
      // stdout and never the advice, so a cluster AWS says is deleted -- and costs nothing
      // -- read as one that is down.
      say(io, `cluster   ${report.context}`);
      if (report.gone === true) {
        // AWS gave a definite no. That is ONE verdict: the cluster is gone, nothing there is
        // billing, and only the kubeconfig entry is left. This printed "NOT a report that the
        // cluster is empty" on stderr and "no longer exists, not costing anything" on stdout,
        // two verdicts on one cluster, and readers believed the louder one.
        const short = report.context.split('/').pop() ?? report.context;
        io.writeErr(
          `${quotedText(report.context)} no longer exists in AWS — nothing there is billing. ` +
            'The kubeconfig entry naming it is left over; ' +
            `\`houston cluster forget ${short}\` removes it.\n`,
        );
        return commandOutcome(undefined, 3);
      }
      io.writeErr(
        `${quotedText(report.context)} cannot be read: ` +
          `${report.reach_why || 'it is not answering'}. Nothing below could be read — ` +
          'this is NOT a report that the cluster is empty.\n',
      );
      if (report.reach_advice) say(io, stripText(report.reach_advice));
      return commandOutcome(undefined, 3);
    }
    return report;
  }
  const docs = require('../core/eks-docs') as typeof EksDocsNS;
  if (action === 'guide') {
    const path = docs.guidePath() ?? '';
    if (bool(o.path_only)) return active() ? { path } : path;
    return { path, body: docs.guide() };
  }
  if (action === 'iam-policy') {
    const name = text(a.name);
    const names = name === '' ? Object.keys(docs.IAM_DOCUMENTS).sort() : [name];
    return {
      documents: names.map((key) => ({
        name: key,
        filename: docs.IAM_DOCUMENTS[key]?.[0] ?? '',
        purpose: docs.IAM_DOCUMENTS[key]?.[1] ?? '',
        body: docs.iamDocument(key),
      })),
    };
  }
  const eks = require('../core/eks') as typeof EksNS;
  if (action === 'list') {
    const region = text(o.region);
    const found = await eks.sweepClusters({
      ...(region === '' ? {} : { regions: [region] }),
      ownedOnly: !bool(o.force),
      emit,
    });
    // One warning per region that could not be read, as the listing has always added them:
    // the envelope said nothing of them.
    if (active()) {
      for (const bad of found.unreadable) {
        warnOnce(
          `REGION_UNREADABLE_${bad.region.toUpperCase().replaceAll('-', '_')}`,
          `${bad.region} could not be read (${bad.why}); it is reported ` +
            'as unknown rather than as holding nothing',
        );
      }
    }
    return found;
  }
  if (action === 'connect') {
    const arn = stripText(text(a.name) || text(o.context));
    if (arn === '')
      throw new ValidationError(
        '`cluster connect` needs the full EKS ARN from `houston cluster list --force`.',
      );
    return await eks.connectExisting(arn);
  }
  if (action === 'create') {
    const name = text(a.name);
    if (name === '')
      throw new ValidationError(
        "`cluster create` needs the cluster's name, e.g. `houston cluster create support`.",
      );
    const subnets: Record<string, string> = {};
    for (const item of strings(o.subnet)) {
      const at = item.indexOf('=');
      if (at < 0)
        throw new ValidationError(`--subnet wants \`<az>=<subnet-id>\`, got ${quotedText(item)}`);
      subnets[item.slice(0, at).trim()] = item.slice(at + 1).trim();
    }
    const wanted = stripText(text(o.expires)).toLowerCase();
    let expiresDays: number | null = eks.DEFAULT_EXPIRY_DAYS;
    if (['never', 'none', '0'].includes(wanted)) expiresDays = null;
    else if (wanted !== '') {
      // `toInt(want)`: a sign, underscores between digits and any Unicode decimal digit are
      // days, and a negative is kept -- `expiryDate` clamps it to today. This
      // took ASCII digits alone, so a `-3` typo created the cluster in one build and was
      // refused in the other.
      try {
        expiresDays = toInt(wanted);
      } catch {
        throw new ValidationError(
          `--expires wants a number of days or \`never\`, got ${quotedText(text(o.expires))}`,
        );
      }
    }
    return await eks.createCluster(name, {
      region: text(o.region),
      // A typed 0 is refused, not replaced: only an absent value takes the default.
      nodes: o.nodes === undefined ? eks.DEFAULT_NODES : number(o.nodes),
      zone: stripText(text(o.zone)),
      ...(Object.keys(subnets).length === 0 ? {} : { subnets }),
      expiresDays,
      emit,
    });
  }
  if (action === 'delete') {
    const name = text(a.name);
    if (name === '')
      throw new ValidationError(
        "`cluster delete` needs the cluster's name, e.g. `houston cluster delete support`.",
      );
    // Typed, else where the build note says it was built, else the AWS CLI's default -- and
    // ALWAYS named below. Without --region this looked in the default region, said "nothing
    // to delete", and the cluster billed on where `cluster create` had put it.
    const region = text(o.region) || eks.rememberedRegion(name) || (await eks.preflight()).region;
    // READ BEFORE ASKING: consent to destroy something that is not there is how people learn
    // to type `y` at a prompt that means nothing. ONLY a definite ABSENT short-circuits;
    // REFUSED goes on through the prompt into the guards inside `deleteCluster`, which are
    // the real gate either way.
    const seen = await eks.describeCluster(name, region);
    if (seen.state === (require('../core/kube/ask') as typeof KubeAskNS).ABSENT) {
      if (active()) return { name, deleted: false };
      const context = require('../core/kube/context') as typeof KubeContextNS;
      const known = (await context.contexts())[0];
      say(
        io,
        `no EKS cluster named ${quotedText(name)} in ${region} — nothing to delete.` +
          ' `houston cluster list` finds it in whichever region it is; then `--region <that>`.' +
          (known.includes(name)
            ? ' That name is a kubeconfig context on this machine; ' +
              `\`houston cluster forget ${name}\` clears the entry, and ` +
              'only a cluster houston built in AWS can be deleted here.'
            : ''),
      );
      return { name, deleted: false, said: true };
    }
    // The prompt is not the gate -- the TAG is -- but a 15-minute destructive operation on
    // somebody's AWS account still asks. Not under --json, where it has never asked.
    if (!bool(o.yes) && !active()) {
      // Red on a terminal, like every word here that is about to destroy something.
      const question = paint(
        `Delete EKS cluster ${quotedText(name)} in ${region}` +
          '? This destroys the cluster, its nodes and its volumes.',
        'red',
      );
      if (!(await (dependencies.confirm ?? defaultConfirm)(question))) throw new Aborted();
    }
    const deleted = await eks.deleteCluster(name, { region, force: bool(o.force), emit });
    // "The command returned" is not "nothing is billing": what AWS still holds, and the
    // fix for each, read with the operator policy's own rights. Additive on the envelope.
    return deleted
      ? { name, deleted, region, leftovers: await eks.sweepLeftovers(name, region) }
      : { name, deleted };
  }
  if (action === 'prepare') {
    const config = require('../lib/config') as typeof ConfigNS;
    const context = text(o.context) || text(a.name) || config.defaultKubeContext();
    if (context === '')
      throw new ValidationError(
        '`cluster prepare` needs --context <name>, or a default from ' +
          '`houston config set kubernetes.context <name>`.',
      );
    // The resolved context rides along for the renderer, out of the --json envelope.
    const prepared = await eks.prepareCluster(context, { emit, zone: stripText(text(o.zone)) });
    Object.defineProperty(prepared, '__context', { enumerable: false, value: context });
    return prepared;
  }
  if (action === 'forget') {
    const context = require('../core/kube/context') as typeof KubeContextNS;
    const reachability = require('../core/kube/reachability') as typeof KubeReachabilityNS;
    const target = (text(a.name) || text(o.context)).trim();
    if (target === '')
      throw new ValidationError(
        'which context should be forgotten? `houston cluster forget ' +
          '<context>`, or `houston cluster list` to see what is there.',
      );
    const known =
      target === (await context.activeContext())
        ? target
        : (await context.assertContextKnown(target))[0];
    if (!bool(o.force) && reachability.reachOk(await reachability.reach(known)))
      throw new ConflictError(
        `${quotedText(known)} is answering, so it is a cluster you can still use rather ` +
          'than a leftover entry. `houston cluster delete` takes a cluster ' +
          'away; `--force` forgets a working one anyway.',
      );
    if (!(await context.forgetContext(known)))
      throw new ConflictError(
        `${known} is still named by a kubeconfig — remove it by hand with ` +
          `\`kubectl config delete-context ${known}\``,
      );
    return { context: known, forgotten: true };
  }
  if (action === 'keep') {
    const name = text(a.name);
    if (name === '')
      throw new ValidationError(
        "`cluster keep` needs the cluster's name, e.g. `houston cluster keep support --days 7`.",
      );
    const days = number(o.days) || 7;
    if (days < 1)
      throw new ValidationError('--days wants a whole number of days from today, at least 1');
    return await eks.keepCluster(name, { days, region: text(o.region) });
  }
  if (action === 'share') {
    const name = text(a.name);
    const user = stripText(text(o.user));
    if (name === '' || user === '')
      throw new ValidationError(
        "`cluster share` needs the cluster's name and --user <iam-user>, e.g. " +
          '`houston cluster share support --user bob`.',
      );
    return await eks.shareCluster(name, { user, region: text(o.region) });
  }
  if (action === 'overview') {
    const cluster = require('../core/cluster') as typeof ClusterNS;
    return await cluster.overview(emit);
  }
  throw new ValidationError(`unknown cluster action '${action}'`);
}

function bag(value: unknown): Bag {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Bag) : {};
}

function bags(value: unknown): Bag[] {
  return Array.isArray(value) ? value.map((item) => bag(item)) : [];
}

function display(value: unknown, fallback = ''): string {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return String(value);
  return String(value);
}

/**
 * `{seconds}` of a duration rounded to one place: always written with a decimal point, so an
 * integral one reads `0.0` / `5.0`. `display` of the same JavaScript number printed `0` /
 * `5` in the restore and upgrade `✓` lines. Only a number is a float; anything else is
 * shown as it is.
 */
function floatText(value: unknown): string {
  return typeof value === 'number' ? floatString(value) : display(value);
}

/** `?` for anything that could not be read. Never a zero. */
function unknownOr(value: unknown): string {
  return value === null || value === undefined ? '?' : toTextAny(value);
}

/**
 * Where the cluster is and who built it, on one line under the context: the facts the
 * ledger reads from the cluster's own tags, so they are true on every machine.
 */
function renderClusterAbout(io: CliIo, report: Bag): void {
  if (!isTruthy(report.name) && !isTruthy(report.region)) return;
  const where = toText(report.where) || 'aws';
  const place =
    where === 'local'
      ? 'this machine'
      : where === 'elsewhere'
        ? 'elsewhere'
        : toText(report.region) || 'local';
  const parts = [toText(report.name), place, toText(report.distribution)].filter(
    (part) => part !== '',
  );
  if (report.made_by_houston === true) parts.push('built by houston');
  else if (report.made_by_houston === false) parts.push('built by you');
  if (isTruthy(report.created_at)) parts.push(`created ${toText(report.created_at).slice(0, 10)}`);
  if (typeof report.expires_in_days === 'number') {
    const days = report.expires_in_days;
    parts.push(
      days < 0
        ? paint(`expired ${String(-days)} d ago (${toText(report.expires)})`, 'amber')
        : `expires in ${String(days)} d (${toText(report.expires)})`,
    );
  }
  say(io, `about     ${parts.join(' · ')}`);
  const ready = report.ready;
  // NOT A CHECKLIST off AWS: a local install shipped its storage class and ingress, and
  // "ready ... cert-manager" read as houston having set them up. It says what is there.
  if (where !== 'aws' && ready !== null && ready !== undefined && typeof ready === 'object') {
    const r = bag(ready);
    const facts: string[] = [];
    if (r.storage_class !== null) facts.push(`storage class ${toText(r.storage_class) || 'none'}`);
    if (r.ingress_class !== null) facts.push(`ingress ${toText(r.ingress_class) || 'none'}`);
    if (r.cert_manager === true) facts.push('cert-manager');
    if (facts.length > 0) say(io, `uses      ${facts.join(' · ')}`);
    return;
  }
  if (ready !== null && ready !== undefined && typeof ready === 'object') {
    const r = bag(ready);
    const facts: string[] = [];
    if (r.storage_class !== null) facts.push(`storage ${toText(r.storage_class) || 'none'}`);
    if (r.ingress_class !== null) facts.push(`ingress ${toText(r.ingress_class) || 'none'}`);
    if (r.cert_manager === true) facts.push('cert-manager');
    else if (r.cert_manager === false) facts.push('no cert-manager');
    const zone = toText(report.zone);
    if (zone !== '' && r.dns_answers === true) facts.push(`DNS for *.${zone} answers`);
    else if (zone !== '' && r.dns_answers === false)
      facts.push(paint(`DNS for *.${zone} does not answer yet`, 'amber'));
    else if (zone === '' && isTruthy(r.cname_target)) facts.push('no DNS zone (`--zone` sets one)');
    if (facts.length > 0) say(io, `ready     ${facts.join(' · ')}`);
  }
}

/** What the cluster has cost, and the one next thing to do with it. */
function renderClusterNext(io: CliIo, report: Bag): void {
  if (typeof report.spend_usd === 'number')
    say(io, `spent     ~$${report.spend_usd.toFixed(2)} so far`);
  // Only a full ledger can say what is next; a partial one (an older --json replayed, a
  // test double with three keys) gets the facts above and nothing invented below them.
  if (typeof report.name !== 'string' || !('ready' in report) || !('zone' in report)) return;
  const cluster = require('../core/cluster') as typeof ClusterNS;
  const next = cluster.nextStep({
    tools_ok: true,
    approved: true,
    account: '',
    clusters: [report as unknown as ClusterNS.Ledger],
    building: [],
    failed: [],
    default_context: toText(report.context),
  });
  say(io, `next      ${next.title}`);
  if (next.command !== '') say(io, `          ${next.command}`);
}

/**
 * The WHERE cell of `list`: the kind of cluster, in eight cells. `k8s` said nothing
 * about which cluster; `eks` and `kind` say what a person needs to know at a glance, and
 * the row's `context` says exactly which. k3s cannot be told from its name, so it stays k8s.
 */
function whereWord(row: Bag): string {
  // `docker` in the table only: --json keeps the runtime's own value.
  if (display(row.runtime) !== 'kubernetes') return 'docker';
  const context = toText(row.context);
  if (context.startsWith('arn:aws:eks:')) return 'eks';
  if (context.startsWith('kind-')) return 'kind';
  return 'k8s';
}

/** One ledger row of the overview table, the words both front-ends use for a state. */
/** The state word both front-ends use, green only when it is running. */
function stateWord(c: Bag): string {
  return isTruthy(c.gone)
    ? 'gone'
    : c.reachable === true
      ? paint('running', 'green')
      : c.reach_status === 'denied'
        ? 'refusing'
        : c.reach_status === 'no-context'
          ? 'no credentials'
          : 'not answering';
}

/** A row for a cluster that does not bill: what it is, whether it answers, what it holds. */
function plainRow(c: Bag, cost: string): string[] {
  return [
    toText(c.name) || toText(c.context),
    toText(c.distribution) || '?',
    stateWord(c),
    Array.isArray(c.workspaces) ? String(c.workspaces.length) : '?',
    cost,
  ];
}

function overviewRow(c: Bag): string[] {
  const state = stateWord(c);
  const types = isTruthy(c.instance_types) ? Object.entries(bag(c.instance_types)) : [];
  const nodes =
    types.length > 0
      ? nodeShape(types.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      : unknownOr(c.nodes);
  const workspaces = Array.isArray(c.workspaces) ? String(c.workspaces.length) : '?';
  const cost = bag(c.cost);
  const perDay = isTruthy(c.gone)
    ? 'nothing'
    : c.cost === null || c.cost === undefined
      ? '?'
      : Number(cost.usd_hr) === 0
        ? 'free'
        : `~$${(Number(cost.usd_hr) * 24).toFixed(2)}`;
  const days = c.expires_in_days;
  const expires =
    typeof days === 'number'
      ? days < 0
        ? paint(`${String(-days)} d ago`, 'amber')
        : days === 0
          ? paint('today', 'amber')
          : `in ${String(days)} d`
      : '—';
  const built = c.made_by_houston === true ? 'houston' : c.made_by_houston === false ? 'you' : '?';
  return [
    toText(c.name) || toText(c.context),
    toText(c.region) || 'local',
    state,
    nodes,
    workspaces,
    perDay,
    expires,
    built,
  ];
}

/**
 * `cluster overview`: every known cluster as a table, the totals, and what to do next.
 *
 * The one answer both front-ends render (`cluster.overview`), so the terminal and the
 * Clusters page cannot disagree. Colour only on a terminal, and only as a signal: a running
 * state green, a cluster expiring within two days amber, one past its date red, and the
 * count of billing clusters amber -- the GUI's own rule.
 */
function renderClusterOverview(io: CliIo, result: Bag): void {
  const clusters = Array.isArray(result.clusters) ? (result.clusters as Bag[]) : [];
  const failed = Array.isArray(result.failed) ? (result.failed as Bag[]) : [];
  // WHERE IT LIVES decides the table: a cluster on this machine has nothing to approve,
  // build or pay for, so it is not in the AWS table, its totals or its next step. A
  // document from before `where` existed is all AWS, which is all it could hold.
  const where = (c: Bag): string => toText(c.where) || 'aws';
  const plain: [string, string, string][] = [
    ['local', 'ON THIS MACHINE', 'free'],
    ['elsewhere', 'ELSEWHERE', 'not priced'],
  ];
  for (const [kind, heading, cost] of plain) {
    const here = clusters.filter((c) => where(c) === kind);
    if (here.length === 0) continue;
    say(io, heading);
    writeTable(
      io,
      ['NAME', 'KIND', 'STATE', 'WORKSPACES', 'COST'],
      here.map((c) => plainRow(c, cost)),
    );
    say(io, '');
  }
  const rows = clusters.filter((c) => where(c) === 'aws').map(overviewRow);
  for (const build of failed) {
    rows.push([
      toText(build.name),
      toText(build.region) || '?',
      paint(build.present === false ? 'failed build (gone)' : 'failed build', 'amber'),
      '?',
      '?',
      build.present === false ? 'nothing' : '?',
      '—',
      'houston',
    ]);
  }
  if (clusters.length === 0 && failed.length === 0) {
    say(
      io,
      'no cluster known on this box — a local one appears with `houston up --runtime ' +
        'kubernetes`; a managed one is built with `houston cluster create`',
    );
  } else if (rows.length === 0) {
    say(io, 'IN AWS');
    say(io, 'no cluster in AWS yet');
  } else {
    say(io, 'IN AWS');
    writeTable(
      io,
      ['NAME', 'REGION', 'STATE', 'NODES', 'WORKSPACES', 'COST/DAY', 'EXPIRES', 'BUILT BY'],
      rows,
    );
    const t = bag(result.totals);
    const n = Number(t.clusters) || 0;
    const billing = Number(t.billable) || 0;
    const w = Number(t.workspaces) || 0;
    // PARTIAL IS SAID. A billing cluster whose rate could not be read, or whose workspace
    // list could not be listed, is left out of a sum -- so the sum says so, as a `?` in a
    // row does, rather than reading as the whole bill.
    const unpriced = Number(t.unpriced) || 0;
    const unread = Number(t.unread) || 0;
    const perDay =
      t.usd_day === null || t.usd_day === undefined
        ? 'cost ?'
        : `~$${Number(t.usd_day).toFixed(2)}/day` +
          (unpriced > 0 ? ` + ${String(unpriced)} not priced` : '');
    const parts = [
      `${String(n)} cluster${n === 1 ? '' : 's'}`,
      billing > 0 ? paint(`${String(billing)} billing`, 'amber') : '0 billing',
      perDay,
    ];
    if (t.spend_usd !== null && t.spend_usd !== undefined)
      parts.push(`spent so far ~$${Number(t.spend_usd).toFixed(2)}`);
    parts.push(
      `${String(w)}${unread > 0 ? '+' : ''} workspace${w === 1 && unread === 0 ? '' : 's'}`,
    );
    say(io, '');
    say(io, parts.join(' · '));
  }
  const next = bag(result.next);
  say(io, `next  ${toText(next.title)}`);
  if (isTruthy(next.why)) say(io, `      ${toText(next.why)}`);
  if (isTruthy(next.command)) say(io, `      ${toText(next.command)}`);
  if (isTruthy(result.unreadable))
    io.writeErr(
      `the kubeconfig could not be fully listed (${toText(result.unreadable)}) — there may be clusters missing above\n`,
    );
}

/** `n`x `type` for each instance type, `unlabelled` for a node with no type label. */
function nodeShape(entries: [string, unknown][]): string {
  return entries.map(([type, count]) => `${toTextAny(count)}x ${type || 'unlabelled'}`).join(', ');
}

/**
 * What the cluster is, how old, and what is running on it. An earlier version printed the
 * headline and the holding count and nothing else -- no age, no node types, no workspace
 * rows, no LoadBalancer line, and "? workspace(s)" where the established output says the
 * workspaces could not be listed.
 */
function renderClusterShape(io: CliIo, report: Bag): void {
  // `ours` is the kind-cluster switch and never true for EKS; the tag houston writes at
  // build time decides for a managed cluster. null (could not tell) reads as yours.
  const owned =
    isTruthy(report.ours) || report.made_by_houston === true ? "houston's own" : 'yours';
  say(
    io,
    `${toText(report.distribution) || 'unknown'} · ${owned} · ${unknownOr(report.nodes)} node(s)`,
  );
  if (report.age_hours !== null && report.age_hours !== undefined) {
    // Days and hours of the age: truncated first, then floor division by 24.
    const whole = Math.trunc(Number(report.age_hours));
    const days = Math.floor(whole / 24);
    say(io, `up for    ${String(days)}d ${String(whole - days * 24)}h`);
  }
  if (isTruthy(report.instance_types)) {
    // Sorted by type: the keys are distinct, so by type alone, in code-point order.
    const types = Object.entries(bag(report.instance_types)).sort(([left], [right]) =>
      compareCodePoints(left, right),
    );
    say(io, `nodes     ${nodeShape(types)}`);
  }
  const rows = report.workspaces;
  if (rows === null || rows === undefined) {
    say(io, 'workspaces could not be listed — not the same as none');
  } else {
    const listed = bags(rows);
    say(io, `holding   ${String(listed.length)} workspace(s), ${unknownOr(report.pvcs)} volume(s)`);
    for (const row of listed) {
      const who = isTruthy(row.owner_readable) ? toText(row.owner) : 'owner unreadable';
      say(
        io,
        `            ${display(row.name)}  (${who || 'unowned'}, ${toTextAny(row.pvcs)} volume(s))`,
      );
    }
  }
  say(
    io,
    `services  ${unknownOr(report.loadbalancers)} LoadBalancer(s)` +
      (isTruthy(report.cost) ? '   — each one is billed on a managed cluster' : ''),
  );
}

/**
 * The shared installs, the bill, and anything that could not be read. An earlier version
 * printed the hourly figure alone: no per-day figure, no `stuck` line for a cluster houston
 * can no longer remove, no `shared` line, and neither the LOW nor the INCOMPLETE qualifier,
 * so an under-counted bill read as a plain estimate.
 */
function renderClusterCost(io: CliIo, report: Bag): void {
  if (report.manageable === false && isTruthy(report.unmanageable_why)) {
    say(io, `stuck     ${toTextAny(report.unmanageable_why)}`);
  }
  const shared = (
    [
      ['operator', report.operator],
      ['monitoring', report.monitoring],
    ] as const
  )
    .filter(([, on]) => isTruthy(on))
    .map(([name]) => name);
  say(io, `shared    ${shared.length > 0 ? shared.join(', ') : 'none installed'}`);
  if (isTruthy(report.cost)) {
    const cost = bag(report.cost);
    const perHour = Number(cost.usd_hr);
    // The hourly rate times 24, rounded to 2 places, is a float, printed with its decimal
    // point: `8.9`, `3.0`.
    const perDay = floatString(Number(formatFixed(perHour * 24, 2)));
    say(
      io,
      `cost      ~$${floatString(perHour)}/hr  (~$${perDay}/day)  ESTIMATE — ` +
        toTextAny(cost.basis),
    );
    if (isTruthy(cost.unpriced)) {
      say(
        io,
        `          plus ${nodeShape(Object.entries(bag(cost.unpriced)))} which this build ` +
          'cannot price — the figure above is LOW',
      );
    }
    if (isTruthy(cost.incomplete)) {
      // A read that FAILED, not a gap in the price table.
      say(
        io,
        `          and ${(Array.isArray(cost.incomplete) ? cost.incomplete : []).map((item) => toTextAny(item)).join(', ')}` +
          ' could not be counted — the figure above is INCOMPLETE, not merely approximate',
      );
    }
  }
  for (const missing of Array.isArray(report.unreadable) ? report.unreadable : []) {
    say(io, `unread    ${toTextAny(missing)}`);
  }
}

/**
 * A path's last part once empty and `.` parts are dropped, which is not `path.basename`:
 * `sub/b.rcbak/` and `sub/b.rcbak/.` are `b.rcbak`, and a path of nothing but a root (or
 * `.`) has no name at all.
 */
function pathBaseName(value: string): string {
  return (
    value
      .split('/')
      .filter((part) => part !== '' && part !== '.')
      .at(-1) ?? ''
  );
}

/**
 * The upgrade's panel and warnings: `from  ->  to` with two spaces each side, and the MongoDB
 * row showing the current tag alone when it does not move. Every warning is a warning line of
 * two spaces and its text as given; this printed `8.5.1 -> 8.6.1`, `8.0 -> 8.0` and a `⚠ `
 * prefix.
 */
function renderUpgradePlan(plan: Bag, io: CliIo): void {
  const fromMongo = toTextAny(plan.from_mongo);
  writePanel(io, `upgrade: ${toTextAny(plan.name)}`, [
    ['Rocket.Chat', `${toTextAny(plan.from_version)}  ->  ${toTextAny(plan.to_version)}`],
    [
      'MongoDB',
      fromMongo + (plan.from_mongo === plan.to_mongo ? '' : `  ->  ${toTextAny(plan.to_mongo)}`),
    ],
    ['image', imageRef(toTextAny(plan.rc_image), toTextAny(plan.to_version))],
    ['source', toTextAny(plan.source)],
  ]);
  for (const line of Array.isArray(plan.warnings) ? plan.warnings : [])
    io.writeOut(`  ${toTextAny(line)}\n`);
}

/** `backup.human`: base 1024, B to GB, a tie rounded to even. */
function humanBytes(raw: unknown): string {
  const backup = require('../core/backup') as typeof BackupNS;
  return backup.human(Number(raw ?? 0));
}

/**
 * `presets`: one box per preset, every box `min(terminal width, 88) - 4` columns inside
 * and its text wrapped to that -- the width is `consoleColumns(90)`, so 84 off a terminal and
 * under any COLUMNS from 88 up, 56 at COLUMNS=60, 36 at COLUMNS=40.
 *
 * An earlier version handed each description to `writePanel`, which grows to its widest row,
 * so every box was one line as long as its description -- 283 columns for `airgapped` -- and
 * read `params_help` and `requires_license`, which a `Preset` spells `paramsHelp` and
 * `requiresLicense`: no `--set` line and no `[needs license]` was ever printed. Measured
 * against the frozen CLI at COLUMNS=100, 60, 40 and unset.
 *
 * A description is folded onto one line (its `splitFields` words joined by single spaces) and
 * made ASCII before it is wrapped; a `--set` entry hangs its wrapped help under the help's
 * first column. A key is NOT made ASCII, and never was. The `--set` lines come in the order
 * the preset file wrote them, which a JavaScript object's key order is not for a key like
 * `"10"`; `paramsHelpItems` carries the file's order.
 */
export function renderPresets(
  value: Bag,
  io: CliIo,
  host: ConsoleEnvironment = PROCESS_CONSOLE,
): void {
  const { paramsHelpItems } = require('../lib/presets') as typeof PresetsNS;
  const inner = Math.min(consoleColumns(90, host), 88) - 4;
  io.writeOut('Presets\n\n');
  for (const preset of bags(value.presets)) {
    const lines = wrapWords(asciiOf(splitFields(display(preset.description)).join(' ')), inner);
    if (lines.length === 0) lines.push('');
    const help = paramsHelpItems(bag(preset.paramsHelp));
    if (help.length > 0) {
      lines.push('');
      const keyWidth = Math.max(...help.map(([key]) => [...key].length));
      const hang = ' '.repeat('--set '.length + keyWidth + 3);
      for (const [key, about] of help) {
        const padded = key + ' '.repeat(keyWidth - [...key].length);
        const entry = `--set ${padded}   ${asciiOf(splitFields(display(about)).join(' '))}`;
        lines.push(...wrapWords(entry, inner, { subsequentIndent: hang }));
      }
    }
    const title = `${display(preset.name)}${preset.requiresLicense === true ? '  [needs license]' : ''}`;
    writeBox(io, title, lines, inner);
    io.writeOut('\n');
  }
  io.writeOut('run: houston up --version <X.Y.Z> --preset <name> [--set key=value]\n');
}

/**
 * `42s`, `1m03s`. An earlier version printed `134s` for every boot past a minute, which is
 * most of them.
 */
function fmtDuration(secs: number): string {
  return secs < 60
    ? `${String(secs)}s`
    : `${String(Math.floor(secs / 60))}m${String(secs % 60).padStart(2, '0')}s`;
}

/** How the certificate was obtained. */
function tlsLabel(meta: RecordNS.Metadata): string {
  const labels: Readonly<Record<string, string>> = {
    // A *.houston.localhost name: no browser on another computer ever opens it.
    local: 'local CA, a browser on the machine running houston only (houston trust-ca)',
    acme: "Let's Encrypt",
    own: 'supplied certificate',
  };
  const kind = isTruthy(meta.extra.tls) ? toTextAny(meta.extra.tls) : '';
  return Object.hasOwn(labels, kind) ? (labels[kind] as string) : 'enabled';
}

/**
 * The boxed workspace summary `up`, `ready` and `info` share, drawn from the RECORD -- not
 * from `detail()`, which asks docker and reads the compose file, and so failed `info` (a
 * stack, exit 1) for a workspace whose compose file an interrupted create never wrote, where
 * repro.json alone answers.
 *
 * Rows in the established order and wording: MongoDB `<tag> (via the <managed_by>)` when
 * the runtime recorded what it built, else `<tag> (<flavor>)`, parentheses even when the
 * flavor is empty (every Kubernetes record); Owner from `created_by` only, which `chown`
 * leaves alone; TLS and Direct HTTP for a workspace with a public URL; then the caller's
 * rows. And the instances, in the established wording, under the box.
 */
function summaryPanel(
  meta: RecordNS.Metadata,
  io: CliIo,
  extraRows: readonly (readonly [string, string])[] = [],
): void {
  const record = require('../core/runner/record') as typeof RecordNS;
  const topology = require('../core/topology') as typeof TopologyNS;
  const managedBy = meta.extra.mongo_managed_by ?? '';
  const mongo = isTruthy(managedBy)
    ? `${meta.mongoTag} (via the ${toTextAny(managedBy)})`
    : `${meta.mongoTag} (${meta.mongoFlavor})`;
  const rows: (readonly [string, string])[] = [
    ['Rocket.Chat', meta.rcVersion],
    ['MongoDB', mongo],
    // The presets without the deployment: multi-instance has its own instances line below.
    ['Preset', String(topology.axesOfMeta(meta).preset ?? meta.preset)],
    // externalUrl, not rootUrl: with --https the browser wants the https URL.
    ['URL', record.externalUrl(meta)],
    ['Login', `admin / ${record.adminPass(meta)}`],
  ];
  const owner = meta.extra.created_by ?? '';
  if (isTruthy(owner)) rows.push(['Owner', toTextAny(owner)]);
  if (isTruthy(meta.publicUrl)) rows.push(['TLS', tlsLabel(meta)]);
  // houston's own way in, whenever the URL above is somebody else's (TLS, a proxy, a tunnel).
  if (record.externalUrl(meta) !== meta.rootUrl) rows.push(['Direct HTTP', meta.rootUrl]);
  rows.push(...extraRows);
  writePanel(io, meta.name, rows);
  const instances = meta.extra.instances;
  if (isTruthy(instances)) {
    io.writeOut(`  instances (${toTextAny(instances)}, load-balanced by Traefik):\n`);
    const count = toInt(instances);
    for (let at = 1; at <= count; at += 1) {
      io.writeOut(`    rocketchat-${String(at)}: http://localhost:${String(meta.hostPort + at)}\n`);
    }
  }
  sshHint(io, record.externalUrl(meta));
}

/**
 * Over SSH, `localhost` is the server, not the reader's computer: one line saying how to
 * open `url` from there. Read here, not in core: it is about this terminal.
 */
export function sshHint(io: CliIo, url: string): void {
  if (!isTruthy(process.env.SSH_CONNECTION) && !isTruthy(process.env.SSH_CLIENT)) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) return;
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  io.writeOut(
    '  localhost is the machine running houston. From your computer: ' +
      `ssh -L ${port}:localhost:${port} <you>@<this server>, then open the URL; or create it ` +
      'with --domain for an address anyone can open.\n',
  );
}

/**
 * An INDENTED line is something to paste and is never wrapped; anything else is wrapped by
 * `wrapWords` with hyphen breaks off, so `metrics-server` stays one word.
 */
function noteLines(line: string, width: number): string[] {
  const text = asciiOf(line);
  if (text.startsWith(' ') && stripText(text) !== '') return [`      ${stripText(text)}`];
  const wrapped = wrapWords(text, width, {
    initialIndent: '    ',
    subsequentIndent: '    ',
    breakOnHyphens: false,
  });
  return wrapped.length > 0 ? wrapped : [''];
}

/**
 * What is in this workspace, as sections, from the record's note groups. Rows as an aligned
 * two-column block -- the key column as wide as the widest key BEFORE its ASCII fallback, in
 * code points -- prose wrapped to `min(consoleColumns(90), 88) - 6`, and commands set off and
 * never wrapped.
 */
export async function printNotes(meta: RecordNS.Metadata, io: CliIo): Promise<void> {
  const notes = require('../core/lifecycle/notes') as typeof NotesNS;
  let groups: { title: unknown; rows: unknown; body: unknown; commands: unknown }[] =
    await notes.noteGroupsOf(meta);
  if (groups.length === 0) {
    const flat = Array.isArray(meta.extra.notes) ? meta.extra.notes : [];
    if (flat.length === 0) return;
    groups = [{ title: '', rows: [], body: flat, commands: [] }];
  }
  const width = Math.min(consoleColumns(90), 88);
  const head = 'what is in this workspace ';
  io.writeOut(`\n  ${head}${'-'.repeat(Math.max(1, width - head.length - 3))}\n`);
  for (const group of groups) {
    const rows = Array.isArray(group.rows) ? (group.rows as unknown[][]) : [];
    const body = Array.isArray(group.body) ? (group.body as unknown[]) : [];
    const commands = Array.isArray(group.commands) ? (group.commands as unknown[]) : [];
    if (rows.length + body.length + commands.length === 0) continue;
    io.writeOut('\n');
    if (isTruthy(group.title)) io.writeOut(`  ${asciiOf(toTextAny(group.title))}\n`);
    if (rows.length > 0) {
      const keyWidth = Math.max(...rows.map(([key]) => [...toTextAny(key)].length));
      for (const [key, value] of rows) {
        const shown = asciiOf(toTextAny(key));
        const pad = ' '.repeat(Math.max(0, keyWidth - [...shown].length));
        io.writeOut(`    ${shown}${pad}   ${asciiOf(toTextAny(value))}\n`);
      }
    }
    for (const line of body) {
      for (const out of noteLines(toTextAny(line), width - 6)) io.writeOut(`${out}\n`);
    }
    for (const command of commands) io.writeOut(`      ${asciiOf(toTextAny(command))}\n`);
  }
}

/** `houston-<name>-rocketchat-1` -> `rocketchat` (or `rocketchat-1`). */
function shortContainer(full: string, repro: string, keepIndex = false): string {
  const prefix = `houston-${repro}-`;
  const trimmed = full.startsWith(prefix) ? full.slice(prefix.length) : full;
  return keepIndex ? trimmed : trimmed.replace(/-\d+$/u, '');
}

/**
 * Until Ctrl-C, for a loop that answers it itself by returning. The listener is registered
 * after `runMain`'s, which therefore steps aside, so the command returns and exits 0 with an
 * `end` record of 0, as it always has.
 */
function untilInterrupted(signals: readonly NodeJS.Signals[] = ['SIGINT']) {
  let stopped = false;
  let stop = (): void => undefined;
  const interrupted = new Promise<undefined>((resolve) => {
    stop = () => {
      stopped = true;
      resolve(undefined);
    };
  });
  for (const signal of signals) process.on(signal, stop);
  return {
    interrupted,
    isStopped: () => stopped,
    /** Resolve after `ms`, or at the interrupt, whichever is first. */
    sleep: (ms: number) =>
      Promise.race([interrupted, new Promise<void>((resolve) => setTimeout(resolve, ms))]),
    release: () => {
      for (const signal of signals) process.off(signal, stop);
    },
  };
}

/**
 * `stats`, printed in the established shape.
 *
 * An earlier version sampled through a ResourceMonitor in every mode and printed only at the
 * end: `--watch` showed NOTHING until Ctrl-C and then an idle -> peak table the established
 * output never has, the window had no "Sampling ..." line, and Kubernetes read one sample
 * where it should watch, or keep each pod's peak over the window. Each branch now runs the
 * established loop: `--watch` prints "Live stats for ..." and a block per `docker stats`
 * sample every two seconds until Ctrl-C (exit 0, nothing more); the window prints "Sampling
 * ... for Ns..." first and the resource table after; Kubernetes prints `printPodMetrics` per
 * sample under `--watch`, else the peak rows once, most memory first, after the first sample
 * at or past the deadline.
 *
 * SIGTERM stops `--watch` cleanly too, as it always did here, where the previous
 * implementation dies by it with no `end` record: a known difference, and a clean stop in
 * both.
 */
async function runStats(invocation: Invocation, io: CliIo): Promise<unknown> {
  const o = invocation.options;
  const topology = require('../core/topology') as typeof TopologyNS;
  // `requireEngine` before the runtime branch and before --watch. Without it a stopped daemon
  // sampled nothing and exited 0 with both streams empty -- a peak of nothing reported as
  // success -- where the established answer is ENGINE_UNAVAILABLE, exit 3. Measured by the
  // CLI differential with docker stubbed.
  const meta = await engineMetadata(text(o.name));
  const seconds = number(o.for_);
  const watch = bool(o.watch);
  if ((await topology.ofRepro(meta.name)) === topology.KUBERNETES) {
    await kubernetesStats(meta, seconds, watch, io);
    return undefined;
  }
  if (watch) {
    const engine = require('../core/runner/engine') as typeof RunnerEngineNS;
    const queries = require('../core/runner/queries') as typeof RunnerQueriesNS;
    io.writeOut(`Live stats for ${quotedText(meta.name)} (Ctrl-C to stop)…\n`);
    // The whole loop, docker calls included, answers Ctrl-C itself, so a Ctrl-C at any
    // point of it is a clean stop.
    const ctrlC = untilInterrupted(['SIGINT', 'SIGTERM']);
    try {
      while (!ctrlC.isStopped()) {
        const ids = await Promise.race([engine.containerIds(meta.name), ctrlC.interrupted]);
        if (ids === undefined) break;
        const out = await Promise.race([queries.dockerStats(ids), ctrlC.interrupted]);
        if (out === undefined) break;
        io.writeOut('\n');
        for (const line of splitTextLines(out)) {
          const parts = line.split('\t');
          if (parts.length < 3) continue;
          const short = shortContainer(parts[0] as string, meta.name).padEnd(14);
          io.writeOut(
            `  ${short} CPU ${(parts[1] as string).padStart(7)}   RAM ${parts[2] as string}\n`,
          );
        }
        await ctrlC.sleep(2000);
      }
    } finally {
      ctrlC.release();
    }
    return undefined;
  }
  io.writeOut(`Sampling ${quotedText(meta.name)} for ${formatFixed(seconds, 0)}s…\n`);
  const resources = require('../perf/resources') as typeof ResourcesNS;
  const monitor = new resources.ResourceMonitor(meta.name).start();
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000));
  return { name: meta.name, resources: await monitor.stop() };
}

/** One Kubernetes sample, a blank line first. */
function printPodMetrics(rows: readonly Bag[], io: CliIo): void {
  io.writeOut('\n');
  for (const row of rows) {
    const cpu = formatFixed(Number(row.cpu_millicores ?? 0), 0).padStart(6);
    const ram = formatFixed(Number(row.mem_bytes ?? 0) / 1e6, 1).padStart(7);
    io.writeOut(`  ${display(row.pod).padEnd(44)} CPU ${cpu}m   RAM ${ram} MB\n`);
  }
  if (rows.length === 0) io.writeOut("no pods are running in this workspace's namespace\n");
}

/**
 * Every pod in the namespace, each sample printed under `--watch`, else each pod's peak --
 * its sample with the most memory, carrying the highest CPU seen since -- printed once after
 * the first sample at or past the deadline, most memory first. Only the two-second sleep
 * answers Ctrl-C by returning, so a Ctrl-C while kubectl answers is an interrupt like any
 * other (exit 130).
 */
async function kubernetesStats(
  meta: RecordNS.Metadata,
  seconds: number,
  watch: boolean,
  io: CliIo,
): Promise<void> {
  const status = require('../core/kube/status') as typeof KubeStatusNS;
  const context = recordedContext(meta.extra);
  const deadline = performance.now() + (watch ? 0 : Math.max(0, seconds)) * 1000;
  const peak = new Map<string, Bag>();
  for (;;) {
    const rows = bags(await status.podMetrics(meta.name, { context, selector: '' }));
    if (watch) printPodMetrics(rows, io);
    else {
      for (const row of rows) {
        const previous = peak.get(display(row.pod));
        if (previous === undefined || Number(row.mem_bytes) > Number(previous.mem_bytes)) {
          peak.set(display(row.pod), { ...row });
        } else {
          previous.cpu_millicores = Math.max(
            Number(previous.cpu_millicores),
            Number(row.cpu_millicores),
          );
        }
      }
      if (performance.now() >= deadline) {
        const sorted = [...peak.values()].sort(
          (left, right) => Number(right.mem_bytes) - Number(left.mem_bytes),
        );
        printPodMetrics(sorted, io);
        return;
      }
    }
    const ctrlC = untilInterrupted();
    try {
      await ctrlC.sleep(2000);
      if (ctrlC.isStopped()) return;
    } finally {
      ctrlC.release();
    }
  }
}

/**
 * Short names, keeping the instance index only where a base name repeats (multi-instance
 * rocketchat-1/-2/-3) so no row overwrites another, sorted by that name.
 */
export function renderResources(value: unknown, io: CliIo, repro: string): void {
  const entries = Object.entries(bag(value));
  if (entries.length === 0) return;
  const bases = entries.map(([full]) => shortContainer(full, repro));
  const repeated = new Set(bases.filter((base, index) => bases.indexOf(base) !== index));
  const labelled = new Map<string, Bag>();
  for (const [full, raw] of entries) {
    const base = shortContainer(full, repro);
    labelled.set(repeated.has(base) ? shortContainer(full, repro, true) : base, bag(raw));
  }
  io.writeOut('\nResource cost (idle -> peak):\n');
  for (const name of [...labelled.keys()].sort()) {
    const row = labelled.get(name) as Bag;
    const peakMem = Number(row.peak_mem ?? 0);
    const delta = (peakMem - Number(row.idle_mem ?? 0)) / 1e6;
    io.writeOut(
      `  ${name.padEnd(14)} CPU ${formatFixed(Number(row.idle_cpu ?? 0), 0)}% -> ` +
        `${formatFixed(Number(row.peak_cpu ?? 0), 0)}%   RAM ${formatFixed(peakMem / 1e6, 0)} MB ` +
        `(+${formatFixed(delta, 0)})\n`,
    );
  }
}

/** '2xx 1158 · 429 61 · 5xx 41', the non-zero buckets only. */
function statusBreakdown(summary: Bag): string {
  const status = bag(orElse(summary.status, {}));
  return ['2xx', '429', '4xx', '5xx', 'other']
    .filter((key) => isTruthy(status[key]))
    .map((key) => `${key} ${String(Math.trunc(Number(status[key])))}`)
    .join(' · ');
}

/**
 * A summary metric as its format spells it, or '-' when it was not measured -- a zero-request
 * run has no latency or checks keys, and 0ms would be a confident lie.
 */
function summaryMetric(
  summary: Bag,
  key: string,
  spec: 'ms' | '.0f' | '.1f' | '.2%' | '.0%',
): string {
  const value = summary[key];
  if (value === null || value === undefined) return '-';
  const n = Number(value);
  switch (spec) {
    case 'ms':
      return `${formatFixed(n, 0)}ms`;
    case '.0f':
      return formatFixed(n, 0);
    case '.1f':
      return formatFixed(n, 1);
    case '.2%':
      return `${formatFixed(n * 100, 2)}%`;
    case '.0%':
      return `${formatFixed(n * 100, 0)}%`;
  }
}

/** 'spike 10:100', 'ramp 10:200' or '50 VUs'. */
function loadShapeOf(ctx: Bag): string {
  if (isTruthy(ctx.spike)) return `spike ${toTextAny(ctx.spike)}`;
  if (isTruthy(ctx.ramp)) return `ramp ${toTextAny(ctx.ramp)}`;
  return `${toTextAny(dictGetChecked(ctx, 'vus', '?'))} VUs`;
}

/** The per-step latency table, in the journey's order. */
function renderSteps(steps: Bag, io: CliIo): void {
  if (Object.keys(steps).length === 0) return;
  const baseline = require('../perf/baseline') as typeof BaselineNS;
  const { fmtMs } = require('../perf/timings') as typeof TimingsNS;
  const ms = (value: unknown): string => fmtMs(isTruthy(value) ? Number(value) : 0).padStart(7);
  io.writeOut('\nPer-step latency:\n');
  io.writeOut(
    `  ${ljust('step', 8)} ${'count'.padStart(6)}   ${'p50'.padStart(7)} ${'p95'.padStart(7)} ${'p99'.padStart(7)}\n`,
  );
  for (const step of baseline.stepOrder(steps)) {
    const row = bag(steps[step]);
    io.writeOut(
      `  ${ljust(step, 8)} ${formatFixed(Number(dictGetChecked(row, 'count', 0)), 0).padStart(6)}   ` +
        `${ms(row.p50)} ${ms(row.p95)} ${ms(row.p99)}\n`,
    );
  }
}

/**
 * The panel, the per-step table, and the SLO lines -- with 'SLO gate:' only when there were
 * rules to gate on.
 */
function renderLoadtestPanel(ctx: Bag, summary: Bag, slo: readonly Bag[], io: CliIo): void {
  const { fmtActual } = require('../perf/slo') as typeof SloNS;
  const rows: [string, string][] = [
    [
      'throughput',
      `${summaryMetric(summary, 'rps', '.1f')} req/s   (${summaryMetric(summary, 'count', '.0f')} requests)`,
    ],
    [
      'latency',
      `p50 ${summaryMetric(summary, 'p50', 'ms')}  p90 ${summaryMetric(summary, 'p90', 'ms')}  ` +
        `p95 ${summaryMetric(summary, 'p95', 'ms')}  p99 ${summaryMetric(summary, 'p99', 'ms')}`,
    ],
    [
      '',
      `avg ${summaryMetric(summary, 'avg', 'ms')}  min ${summaryMetric(summary, 'min', 'ms')}  ` +
        `max ${summaryMetric(summary, 'max', 'ms')}`,
    ],
    [
      'errors',
      `${summaryMetric(summary, 'error_rate', '.2%')}   checks ${summaryMetric(summary, 'checks_rate', '.0%')} ok`,
    ],
  ];
  const breakdown = statusBreakdown(summary);
  if (breakdown !== '') rows.push(['responses', breakdown]);
  if (isTruthy(ctx.constrained)) rows.push(['constrained', toTextAny(ctx.constrained)]);
  let load = `${loadShapeOf(ctx)} / ${toTextAny(ctx.duration)}`;
  if (isTruthy(ctx.users)) load += `, ${toTextAny(ctx.users)} users`;
  writePanel(
    io,
    `loadtest ${toTextAny(dictGetChecked(ctx, 'label', ctx.scenario))} (${load})`,
    rows,
  );
  renderSteps(bag(orElse(summary.steps, {})), io);
  if (slo.length === 0) return;
  io.writeOut('\n');
  for (const rule of slo) {
    const detail = !isTruthy(dictGetChecked(rule, 'measured', true))
      ? 'not measured'
      : `actual ${fmtActual(String(rule.key), Number(rule.actual))}`;
    io.writeOut(
      `  ${isTruthy(rule.ok) ? '✓' : '✗'} ${toTextAny(rule.key)} ${toTextAny(rule.op)} ` +
        `${toTextAny(rule.raw)}  (${detail})\n`,
    );
  }
  io.writeOut(`\nSLO gate: ${slo.every((rule) => isTruthy(rule.ok)) ? 'PASS' : 'FAIL'}\n`);
}

/** The p95 sparkline, RC's internals, the slow queries, and the verdict. */
function renderDiagnosis(diag: NonNullable<LoadtestView['diag']>, io: CliIo): void {
  const { fmtMs } = require('../perf/timings') as typeof TimingsNS;
  const timeline = require('../perf/timeline') as typeof TimelineNS;
  if (diag.timeline !== null) {
    io.writeOut('\n');
    for (const line of timeline.renderAscii(diag.timeline)) io.writeOut(`  ${line}\n`);
  }
  const rcm = diag.rcmetrics;
  if (Object.keys(rcm).length > 0) {
    io.writeOut('\nRC internals during the test:\n');
    for (const service of Object.keys(rcm).sort(compareCodePoints)) {
      const m = bag(rcm[service]);
      const bits: string[] = [];
      // The histogram's per-interval peak over the run; the instantaneous gauge as fallback.
      const peak = orElse(m.eventloop_lag_max_s, m.eventloop_lag_s);
      const p99 = m.eventloop_lag_p99_s;
      if (isTruthy(peak)) {
        let lag = `event-loop lag peak ${fmtMs(Number(bag(peak).max) * 1000)}`;
        if (isTruthy(p99)) lag += ` / p99 ${fmtMs(Number(bag(p99).max) * 1000)}`;
        bits.push(lag);
      }
      if (isTruthy(m.heap_used_bytes)) {
        bits.push(`heap ${formatFixed(Number(bag(m.heap_used_bytes).max) / 1e6, 0)}MB`);
      }
      if (isTruthy(m.ddp_users)) {
        bits.push(`ddp users ${formatFixed(Number(bag(m.ddp_users).max), 0)}`);
      }
      if (bits.length > 0) io.writeOut(`  ${ljust(service, 14)} ${bits.join('   ')}\n`);
    }
  }
  const mongo = diag.mongo;
  if (mongo !== null && isTruthy(mongo.slow)) {
    io.writeOut(
      `\nSlow MongoDB queries (${toTextAny(mongo.total)} profiled, ` +
        `${toTextAny(mongo.collscan)} COLLSCAN):\n`,
    );
    for (const slow of bags(mongo.slow)) {
      io.writeOut(
        `  ${fmtMs(Number(slow.millis)).padStart(7)}  ${toTextAny(slow.ns)}  ${toTextAny(slow.op)}  ` +
          `[${toTextAny(orElse(slow.plan, '?'))}]  docs ${toTextAny(slow.docs)}/ret ${toTextAny(slow.ret)}\n`,
      );
    }
  }
  if (diag.verdict.length > 0) {
    io.writeOut('\nVerdict:\n');
    for (const line of diag.verdict) {
      const wrapped = wrapWords(asciiOf(line), 84, { subsequentIndent: '    ' });
      io.writeOut(`  - ${wrapped[0] ?? ''}\n`);
      for (const more of wrapped.slice(1)) io.writeOut(`  ${more}\n`);
    }
  }
}

/** Throughput to one place, the error rate a percentage, latency as ms. */
function compareValue(metric: string, value: number): string {
  const { fmtMs } = require('../perf/timings') as typeof TimingsNS;
  if (metric.includes('rps')) return formatFixed(value, 1);
  if (metric.includes('error')) return `${formatFixed(value * 100, 2)}%`;
  return fmtMs(value);
}

/** The baseline it was measured against, then one aligned row a metric. */
function renderComparison(rows: readonly Bag[], base: Bag, io: CliIo): void {
  const ctx = bag(orElse(base.ctx, {}));
  const saved = [...toTextAny(dictGetChecked(base, 'saved_at', ''))].slice(0, 19).join('');
  io.writeOut(
    `\nvs baseline ${shownValue(dictGetChecked(base, 'label', '?'))} ` +
      `(${toTextAny(dictGetChecked(ctx, 'label', dictGetChecked(ctx, 'scenario', '?')))}, saved ${saved}):\n`,
  );
  const width = Math.max(0, ...rows.map((row) => [...String(row.metric)].length));
  for (const row of rows) {
    const metric = String(row.metric);
    const before = compareValue(metric, Number(row.before));
    const after = compareValue(metric, Number(row.after));
    const line =
      `  ${ljust(metric, width)}  ${before.padStart(8)} -> ${ljust(after, 8)} ` +
      `${formatSigned(Number(row.pct), 0).padStart(6)}%`;
    io.writeOut(isTruthy(row.flag) ? `${line}   <- regression\n` : `${line}\n`);
  }
}

/**
 * A blank line after k6's own output, the panel, the spike line, the diagnosis when --diag
 * armed it, the comparison, and the resource cost.
 *
 * An earlier version was a sketch of it: its title lost ', N users' and the 'spike'/'ramp'
 * word, the avg/min/max, checks and responses rows were missing, latency was `toFixed`
 * (210.5 -> 211ms, and never seconds), the SLO lines printed the raw actual and 'SLO gate:
 * PASS' was said on every run, the per-step table, the spike line, the sparkline, RC's
 * internals, the slow queries and the wrapped verdict were absent, and the comparison read
 * keys its rows do not have, so it printed names and no values.
 */
function renderLoadtest(view: LoadtestView, io: CliIo): void {
  const { fmtMs } = require('../perf/timings') as typeof TimingsNS;
  io.writeOut('\n');
  renderLoadtestPanel(view.ctx, view.summary, view.slo, io);
  const spike = view.spike;
  if (spike !== null) {
    const recovered = spike.recovered_after_s;
    io.writeOut(
      `  spike: baseline p95 ${fmtMs(spike.baseline_p95)} -> peak ${fmtMs(spike.spike_p95)} -> ` +
        (recovered !== null
          ? `recovered ~${String(recovered)}s after load dropped`
          : 'NOT recovered within the run') +
        '\n',
    );
  }
  if (view.diag !== null) renderDiagnosis(view.diag, io);
  if (view.compare.length > 0 && view.base !== null) renderComparison(view.compare, view.base, io);
  renderResources(view.resources, io, view.name);
}

/**
 * A result that carries the workspace's record for the human renderer, which draws the
 * panel and notes from it. Not enumerable, so no JSON envelope sees it.
 */
function withMeta<T extends object>(result: T, meta: RecordNS.Metadata): T {
  Object.defineProperty(result, '__meta', { enumerable: false, value: meta });
  return result;
}

/**
 * The record a result carries, or -- for a result some other caller built -- one read off
 * its own snake_case fields, as a record document would hold them.
 */
function metaOf(value: unknown): RecordNS.Metadata {
  const carried = (value as { __meta?: RecordNS.Metadata } | undefined)?.__meta;
  if (carried !== undefined) return carried;
  const record = require('../core/runner/record') as typeof RecordNS;
  return record.fromDocument(bag(value));
}

/**
 * The import plan, as it is drawn before the dry run's rows or the apply: a blank line,
 * the width-64 box with its three established rows -- the oauth one only when the dump names
 * a provider -- and the redacted secrets the operator must set by hand.
 */
function renderImportPlan(io: CliIo, plan: Bag, dryRun: boolean): void {
  const counts = bag(plan.counts);
  const lines = [
    `apply    ${display(counts.apply, '0')} customized setting(s)`,
    `skip     ${display(counts.redacted, '0')} redacted secret(s), ` +
      `${display(counts.denied, '0')} identity/environment setting(s)`,
  ];
  const services = Array.isArray(plan.oauth_services) ? plan.oauth_services.map(toTextAny) : [];
  if (services.length > 0) lines.push(`oauth    pre-create: ${services.join(', ')}`);
  io.writeOut('\n');
  writeBox(io, `config import${dryRun ? ' (dry run)' : ''}`, lines, 64);
  const redacted = Array.isArray(plan.redacted) ? plan.redacted.map(toTextAny) : [];
  if (redacted.length > 0) {
    io.writeOut(`  set these by hand (redacted in the dump): ${redacted.join(', ')}\n`);
  }
}

/** Human output is an explicit part of every command, never a generic object dump. */
export async function renderHuman(
  invocation: Invocation,
  value: unknown,
  io: CliIo,
): Promise<void> {
  const path = invocation.spec.path;
  const result = bag(value);
  const action = display(invocation.arguments.action);
  if (value === undefined || path === 'serve' || path === 'logs' || path === 'capabilities') return;
  switch (path) {
    case 'up': {
      // The create's result: the panel and notes from the record.
      const meta = metaOf(value);
      if (isTruthy(result.waited)) {
        io.writeOut('✓ ready\n');
        const booted = result.booted_s;
        summaryPanel(
          meta,
          io,
          booted === undefined || booted === null
            ? []
            : [['Booted in', fmtDuration(Number(booted))]],
        );
        io.writeOut(`  next: houston logs --name ${meta.name} -f\n`);
      } else {
        io.writeOut('✓ starting\n');
        summaryPanel(meta, io);
        io.writeOut(`  ready when serving : houston ready --name ${meta.name}\n`);
        io.writeOut(`  follow logs        : houston logs --name ${meta.name} -f\n`);
      }
      await printNotes(meta, io);
      return;
    }
    case 'ready': {
      const meta = metaOf(value);
      io.writeOut('✓ ready\n');
      summaryPanel(meta, io, [['Booted in', fmtDuration(Number(result.booted_s))]]);
      io.writeOut(`  next: houston logs --name ${meta.name} -f\n`);
      await printNotes(meta, io);
      return;
    }
    case 'down': {
      // The nouns depend on the runtime: a Kubernetes workspace has a namespace and a
      // PersistentVolumeClaim, not containers and a Docker volume.
      const name = display(result.name, display(invocation.options.name));
      const kube = result.runtime === 'kubernetes';
      if (invocation.options.volumes === true && result.removed === false) {
        io.writeOut(
          `${quotedText(name)} was NOT removed — see above. \`houston list\` still shows it, ` +
            'which is correct: the record is deliberately kept.\n',
        );
      } else if (invocation.options.volumes === true) {
        const what = kube
          ? 'namespace, PersistentVolumeClaim and record'
          : 'containers, data volume, and record';
        const owner = display(result.owner);
        io.writeOut(
          `✓ ${quotedText(name)} removed (${what}${owner === '' ? '' : `; owned by ${owner}`}).\n`,
        );
      } else {
        const kept = kube ? 'the namespace and its PersistentVolumeClaim are kept' : 'data kept';
        // The kept record knows the version: `<same>` sent the reader to `list` to look it up.
        const runnerRecord = require('../core/runner/record') as typeof RecordNS;
        const was = await runnerRecord.readMeta(name).catch(() => null);
        const owner = was === null ? '' : runnerRecord.recordedOwner(was);
        io.writeOut(
          `✓ ${quotedText(name)} down (${kept}${owner === '' ? '' : `; owned by ${owner}`}).\n`,
        );
        io.writeOut(
          `  bring it back: houston up --version ${was?.rcVersion || '<same>'} --name ${name}\n`,
        );
        io.writeOut(
          '  delete for good: add --volumes (`houston prune` deletes every taken-down ' +
            'workspace, not just this one)\n',
        );
        // ON A CLOUD CLUSTER the kept disk is a bill: small, but it outlives the cluster
        // if the cluster goes first, and `cluster delete` refuses while it exists.
        const request = require('../core/lifecycle/request') as typeof RequestNS;
        if (kube && request.savedDefaultIsBillable(display(result.context))) {
          io.writeOut(
            '  its 8 GB disk keeps billing (about $0.64 a month) and `houston cluster delete` ' +
              `will refuse while it exists — \`houston down --name ${name} --volumes\` removes it\n`,
          );
        }
      }
      return;
    }
    case 'monitor': {
      // The established output, line for line. The detach line says when Prometheus_Enabled
      // was NOT reset, the shared-stack note is the established sentence, and a blank line
      // comes between the attach line and its notes: each was missing or reworded.
      const shown = quotedText(display(result.name, display(invocation.options.name)));
      if (invocation.options.off === true) {
        const kept = isTruthy(result.rc_setting_reset)
          ? ''
          : ' (metrics setting left as-is — workspace not reachable)';
        io.writeOut(`✓ monitoring detached from ${shown}${kept}\n`);
        if (result.stack_removed === false) {
          io.writeOut(
            'the shared monitoring stack stays up — other workspaces on this cluster are ' +
              'still using it\n',
          );
        }
        return;
      }
      io.writeOut(`✓ monitoring attached to ${shown}\n`);
      io.writeOut('\n');
      for (const note of Array.isArray(result.notes) ? result.notes : []) {
        io.writeOut(`${display(note)}\n`);
      }
      return;
    }
    case 'prune': {
      const removed = Array.isArray(result.removed) ? result.removed.map(String) : [];
      const orphans = Array.isArray(result.orphans) ? result.orphans.map(String) : [];
      if (removed.length > 0)
        io.writeOut(`✓ pruned ${String(removed.length)}: ${removed.join(', ')}\n`);
      if (orphans.length > 0)
        io.writeOut(
          `✓ removed ${String(orphans.length)} orphaned namespace(s): ${orphans.join(', ')}\n`,
        );
      if (result.emptyCluster === true) {
        // Nothing but the cluster was on offer.
        io.writeOut(
          result.cluster === true
            ? '✓ the cluster is gone — the next Kubernetes workspace creates a new one.\n'
            : 'Nothing to prune.\n',
        );
        return;
      }
      if (removed.length === 0 && orphans.length === 0) io.writeOut('Nothing to prune.\n');
      if (result.cluster === true) {
        io.writeOut(
          '✓ the cluster is gone too — the next Kubernetes workspace creates a new one.\n',
        );
      }
      return;
    }
    case 'start':
    case 'stop':
    case 'restart': {
      const name = display(result.name, display(invocation.options.name));
      // Whose it is, because without --name this acted on the default the whole home shares.
      const owned = await recordOwner(name);
      const notes = [
        ...(owned === '' ? [] : [`owned by ${owned}`]),
        ...(path === 'stop' ? ['resume with `houston start`'] : []),
      ];
      const suffix = notes.length === 0 ? '' : ` (${notes.join('; ')})`;
      // The `✓` line and nothing more: `start` and `restart` have always ignored
      // `needs_ready`, which is the GUI's to act on; the scaling-back-up warning already
      // names `houston ready`. This added `  run: houston ready --name X` on Kubernetes.
      io.writeOut(
        `✓ ${quotedText(name)} ${path === 'start' ? 'started' : path === 'stop' ? 'stopped' : 'restarted'}${suffix}.\n`,
      );
      return;
    }
    case 'use': {
      const name = display(result.default);
      const owned = await recordOwner(name);
      io.writeOut(
        `✓ default workspace is now ${quotedText(name)}` +
          `${owned === '' ? '' : ` (owned by ${owned})`}. Commands run without --name act on ` +
          'it, for everyone using this houston home.\n',
      );
      return;
    }
    case 'list': {
      const repros = bags(result.repros);
      if (repros.length === 0) {
        io.writeOut('No workspaces yet. Create one with `houston up --version <X.Y.Z>`.\n');
        return;
      }
      // `list`'s established tests and widths: truthiness for the default and pinned marks,
      // the owner column and the public URL (a pinned of 1 or "yes" was no pin here), and
      // `ljust` pads by code point, where padEnd counted UTF-16 units and left a cell holding
      // an astral character one space short.
      const shared = repros.some((row) => isTruthy(row.created_by));
      io.writeOut(
        `NAME                 ${shared ? 'OWNER        ' : ''}RC        MONGO   WHERE    PORT   STATE      URL\n`,
      );
      for (const row of repros) {
        const mark = isTruthy(row.default) ? '*' : isTruthy(row.pinned) ? '·' : ' ';
        const owner = isTruthy(row.created_by) ? display(row.created_by) : '-';
        io.writeOut(
          `${mark}${ljust(display(row.name), 19)} ${shared ? `${ljust(owner, 12)} ` : ''}` +
            `${ljust(display(row.rc_version), 9)} ${ljust(display(row.mongo_tag), 7)} ` +
            `${ljust(whereWord(row), 8)} ` +
            `${ljust(display(row.host_port), 6)} ${ljust(display(row.state), 10)} ` +
            `${isTruthy(row.open_url) ? display(row.open_url) : display(row.root_url)}\n`,
        );
      }
      io.writeOut('\n* = default workspace   · = pinned\n');
      return;
    }
    case 'info': {
      const meta = metaOf(value);
      summaryPanel(meta, io);
      io.writeOut(`  api  : houston api --name ${meta.name} GET /api/v1/me\n`);
      io.writeOut(`  curl : ${meta.rootUrl}/api/info\n`);
      await printNotes(meta, io);
      return;
    }
    case 'users':
      // Printed by the handler as it went (`handlers/users.ts`): nothing is left to render.
      return;
    case 'edge':
      // Printed by the handler as it went (`handlers/https.ts`): nothing is left to render.
      return;
    case 'config':
      // `toTextAny(value)`: a stored boolean reads `False`, not `false`, which is the whole
      // difference between "set to false" and "unset" on this screen.
      if (action === 'get')
        io.writeOut(result.value === null ? '\n' : `${toTextAny(result.value)}\n`);
      else if (action === 'list') {
        for (const [key, item] of Object.entries(result)) {
          io.writeOut(`  ${key.padEnd(20)} ${item === null ? '(unset)' : toTextAny(item)}\n`);
        }
      } else if (action === 'unset') io.writeOut(`✓ ${display(result.key)} unset.\n`);
      // `toTextAny` of what was stored: a coerced acme.staging reads `True`/`False`, where
      // `String()` printed `true`.
      else io.writeOut(`✓ ${display(result.key)} = ${toTextAny(result.value)}\n`);
      return;
    case 'env':
      // The established output, line for line. An earlier version marked a drifted row `!!
      // NOT RUNNING` and printed neither drift warning after the panel, so the one state this
      // read exists to catch — a recorded value the container is not running — was shown in a
      // narrower panel with nothing saying what to do about it; it printed no `could not be
      // read` note, no `--setting`/`--set` examples, and no `verify:` line after an applied
      // write. `if name` is the name as TYPED: a name-less read shows the examples without
      // `--name`.
      if (Array.isArray(result.env)) {
        writePanel(
          io,
          `env: ${display(result.name)}`,
          bags(result.env).map((row) => [
            display(row.key),
            `${display(row.value)}${isTruthy(row.override) ? '   <- yours' : ''}${isTruthy(row.drift) ? '   !! NOT IN THE RUNNING CONTAINER' : ''}`,
          ]),
        );
        const name = display(result.name);
        const drift = Array.isArray(result.drift) ? result.drift.map((key) => toTextAny(key)) : [];
        if (drift.length > 0) {
          io.writeOut(
            `  ${String(drift.length)} recorded value(s) are NOT what the container is running: ` +
              `${drift.join(', ')}\n`,
          );
          io.writeOut(
            `  Rocket.Chat is using the old value. \`houston env --set ${drift[0] ?? ''}=<value> ` +
              `--name ${name}\` re-applies and recreates the container.\n`,
          );
        } else if (!isTruthy(result.live_read ?? true)) {
          io.writeOut(
            '  the container could not be read, so this is the recorded configuration and ' +
              'not a statement about what is running.\n',
          );
        }
        const removed = Array.isArray(result.removed)
          ? result.removed.map((key) => toTextAny(key))
          : [];
        const overrides = Array.isArray(result.overrides)
          ? result.overrides.map((key) => toTextAny(key)).filter((key) => !removed.includes(key))
          : [];
        if (overrides.length > 0) io.writeOut(`  your overrides: ${overrides.join(', ')}\n`);
        if (removed.length > 0) io.writeOut(`  removed by you: ${removed.join(', ')}\n`);
        if (overrides.length === 0 && removed.length === 0) {
          io.writeOut('  no overrides — this is the preset/base environment.\n');
        }
        const named = display(invocation.options.name) === '' ? '' : ` --name ${name}`;
        io.writeOut(
          `  a Rocket.Chat setting: houston env --setting Some_Setting_Id=value${named}\n`,
        );
        io.writeOut(`  a raw env var:        houston env --set KEY=VALUE${named}\n`);
      } else {
        io.writeOut(
          `✓ env ${result.restarted === false ? 'written (not yet applied)' : 'applied'} on ${quotedText(display(result.name))}.\n`,
        );
        for (const row of bags(result.overrides)) {
          io.writeOut(
            `    ${display(row.key)} = ${row.removed === true ? '(removed)' : display(row.value)}\n`,
          );
        }
        if (result.restarted !== false)
          io.writeOut(`  verify: houston env --name ${display(result.name)}\n`);
        else io.writeOut('  to apply it: re-run the same `houston env` without --no-restart\n');
      }
      return;
    case 'tls-status':
    case 'trust-ca':
      // Printed by the handler as it went (`handlers/https.ts`).
      return;
    case 'token':
      io.writeOut(
        `-H "X-Auth-Token: ${display(result.token)}" -H "X-User-Id: ${display(result.user_id)}"\n`,
      );
      return;
    case 'api':
      // The body is echoed with a newline of its own, so a body that already ends in one is
      // followed by a blank line; this added one only when the body lacked it. And the time
      // is `fmtMs`, which is seconds with two decimals from a second up -- `in 1.30s` --
      // where this always printed whole milliseconds.
      io.writeOut(
        `HTTP ${display(result.status)}  [${display(result.auth)}${invocation.options.two_fa === true ? '+2fa' : ''}]  ` +
          `in ${(require('../perf/timings') as typeof TimingsNS).fmtMs(Number(result.elapsed_ms))}\n${display(result.text)}\n`,
      );
      return;
    case 'pat':
      // `toTextAny` of each, so the flag reads `True`/`False` where `display` wrote
      // `true`/`false` on every successful mint, and a record's name that is not text reads
      // as `toTextAny` spells it.
      io.writeOut(
        `# Personal Access Token for ${toTextAny(result.name)} (${toTextAny(result.root_url)}) — ` +
          `bypass_2fa=${toTextAny(result.bypass_2fa)}\n`,
      );
      io.writeOut(
        `-H "X-Auth-Token: ${display(result.token)}" -H "X-User-Id: ${display(result.user_id)}"\n`,
      );
      return;
    case 'seed': {
      // The REST seed is rendered as it runs (`runSeed`); only the two scale paths print from
      // their result, each count with thousands commas and the room quoted by `quotedText`.
      const commas = (require('../core/scaleseed') as typeof ScaleseedNS).withCommas;
      if (invocation.options.clear_scale === true) {
        io.writeOut(
          `✓ removed ${commas(Number(result.users))} scale users and ` +
            `${commas(Number(result.messages))} scale messages\n`,
        );
      } else if (display(invocation.options.scale) !== '') {
        if (Object.hasOwn(result, 'users'))
          io.writeOut(`✓ inserted ${commas(Number(result.users))} users\n`);
        if (Object.hasOwn(result, 'messages'))
          io.writeOut(
            `✓ inserted ${commas(Number(result.messages))} messages into ` +
              `${shownValue(result.room)}\n`,
          );
      }
      return;
    }
    case 'config-import': {
      // The plan box was drawn by the handler, before the apply (`renderImportPlan`).
      if (invocation.options.dry_run === true) {
        // Each id padded to 48 CODE POINTS, then ` = ` and its value, where `padEnd`
        // counted an astral id's UTF-16 units.
        for (const item of bags(result.apply))
          io.writeOut(`    ${ljust(display(item.id), 48)} = ${display(item.value)}\n`);
        return;
      }
      // Which settings Rocket.Chat refused, the first ten by id, and the restart they may
      // need. This said "⚠ 12 setting(s) rejected" and nothing else, so the operator could
      // not tell WHICH settings the workspace does not have.
      if (isTruthy(result.failed)) {
        const failures = Array.isArray(result.failures) ? result.failures.map(toTextAny) : [];
        io.writeOut(
          `  ${display(result.failed)} setting(s) rejected: ${failures.slice(0, 10).join(', ')}` +
            `${Number(result.failed) > 10 ? ' ...' : ''}\n`,
        );
      }
      io.writeOut(
        `✓ imported ${display(result.applied, '0')} setting(s), skipped ${display(result.skipped, '0')}\n`,
      );
      io.writeOut(
        `  some settings need an RC restart to fully take effect: houston restart --name ${metaOf(value).name}\n`,
      );
      return;
    }
    case 'backup': {
      const manifest = bag(result.manifest);
      io.writeOut(
        `✓ backed up ${quotedText(display(result.name))} (${display(manifest.rc_version)}) — ${humanBytes(result.bytes)}\n`,
      );
      io.writeOut(`    ${display(result.path)}\n`);
      // The sidecar warning line prints its text as given -- two spaces, no `⚠` -- and the
      // hint has TWO spaces after `roll back to it:`. This printed `⚠ ` and one.
      if (Array.isArray(manifest.sidecar_volumes) && manifest.sidecar_volumes.length > 0)
        io.writeOut(
          `  sidecar data is NOT included: ${manifest.sidecar_volumes.map(String).join(', ')}\n`,
        );
      // Restore with no --name goes back INTO this workspace, dropping what it holds now.
      io.writeOut(
        `  roll back to it:  houston restore ${display(result.path)}   ` +
          `(replaces ${display(result.name)}'s data; add --new for a separate copy)\n`,
      );
      return;
    }
    case 'backups': {
      // `backups`: the bundle's FILE NAME, not its path; the label when it has one; and the
      // warning that a bundle predates the workspace now holding its name, which is the line
      // that stops a restore loading an earlier workspace's data.
      const rows = bags(result.backups);
      if (rows.length === 0) io.writeOut('no backups yet — make one with `houston backup`\n');
      for (const row of rows) {
        const file = display(row.path).replace(/^.*\//su, ''); // `Path(r['path']).name`
        if (isTruthy(row.error)) {
          io.writeOut(`  ${file}  UNREADABLE: ${toTextAny(row.error)}\n`);
          continue;
        }
        const label = isTruthy(row.label) ? `  (${toTextAny(row.label)})` : '';
        io.writeOut(`  ${file}\n`);
        io.writeOut(
          `      ${toTextAny(row.repro)}  RC ${toTextAny(row.rc_version)}  ` +
            `${humanBytes(row.bytes)}  ${toTextAny(row.created_at)}${label}\n`,
        );
        if (isTruthy(row.predates_workspace)) {
          io.writeOut(
            '      ^ from an EARLIER workspace of this name, not the one running now — ' +
              "restoring it loads that workspace's data\n",
          );
        }
      }
      return;
    }
    case 'restore':
      // `restore`: the bundle's FILE NAME, `pathBaseName(bundle)`, where this printed the
      // whole path the service returned (`sub/b.rcbak`, the `~`-expanded home); and the
      // upgrade-direction line as a warning line, two spaces and no `⚠`, with its second
      // clause, which this dropped.
      io.writeOut(
        `✓ ${result.created === true ? 'created and restored' : 'restored'} ${quotedText(display(result.name))} from ${pathBaseName(display(result.bundle))} in ${floatText(result.restore_seconds)}s\n`,
      );
      if (result.direction === 'upgrade')
        io.writeOut(
          `  ${display(result.from_version)} data now runs on ${display(result.to_version)} — ` +
            'Rocket.Chat has migrated it\n',
        );
      if (display(result.url) !== '') {
        io.writeOut(`  ${display(result.url)}\n`);
        sshHint(io, display(result.url));
      }
      return;
    case 'upgrade': {
      if (invocation.options.rollback === true) {
        io.writeOut(
          `✓ ${quotedText(display(result.name))} rolled back to ${display(result.rolled_back_to)}\n`,
        );
        return;
      }
      // The plan was drawn by the command before it ran (`renderUpgradePlan`); a dry run or
      // a refusal has nothing more to say.
      if (value === null) return;
      io.writeOut(
        `✓ ${quotedText(display(result.name))} upgraded ${display(result.from_version)} -> ${display(result.to_version)} in ${floatText(result.boot_seconds)}s\n`,
      );
      // The rest of the upgrade's output, none of which was printed: the running version ONLY
      // WHEN IT DISAGREES, as a prefix, because `/api/info` reports the minor alone; the
      // migration errors under the header that counts them; and the way back whenever a
      // pre-upgrade backup was taken.
      const running = result.running_version;
      if (
        isTruthy(running) &&
        running !== '?' &&
        !toTextAny(result.to_version).startsWith(toTextAny(running))
      )
        io.writeOut(
          `    but Rocket.Chat reports ${toTextAny(running)} — the upgrade did not land ` +
            'the image you asked for\n',
        );
      const errors = Array.isArray(result.migration_errors) ? result.migration_errors : [];
      if (errors.length > 0) {
        io.writeOut(`  ${String(errors.length)} migration error(s) in the boot log:\n`);
        for (const line of errors) io.writeOut(`      ${toTextAny(line)}\n`);
      }
      if (isTruthy(result.backup))
        io.writeOut(`  roll back:  houston upgrade --rollback --name ${toTextAny(result.name)}\n`);
      return;
    }
    case 'stats':
      renderResources(result.resources, io, display(result.name, display(invocation.options.name)));
      return;
    case 'loadtest':
      // Drawn once the run was measured, before anything was saved, by `runLoadtestCli`.
      return;
    case 'capacity':
      // Drawn as it ran, header to report, by `runCapacityCli`.
      return;
    case 'presets':
      renderPresets(result, io);
      return;
    case 'versions':
      io.writeOut(`Rocket.Chat ${display(result.rc_version)}\n`);
      io.writeOut(
        `  image        : ${imageRef(display(result.rc_image), display(result.rc_version))}\n`,
      );
      io.writeOut(
        `  mongo        : ${display(result.mongo_tag)}  (flavor: ${display(result.mongo_flavor)}, shell: ${display(result.mongo_shell)})\n`,
      );
      io.writeOut(`  oplog url    : ${result.oplog === true ? 'yes' : 'no (deprecated in 8.x)'}\n`);
      io.writeOut(`  resolved via : ${display(result.source)}\n`);
      if (display(result.note) !== '') io.writeOut(`  note         : ${display(result.note)}\n`);
      return;
    case 'audit': {
      const rows = bags(result.lines);
      if (rows.length === 0) {
        io.writeOut(`nothing matched in ${display(result.path)}\n`);
        return;
      }
      if (invocation.options.tsv === true) return;
      // `audit`: the actor column is as wide as the widest actor SHOWN, where an earlier
      // version padded none, so `-` stood two spaces from its kind beside `alice`'s column.
      // Widths, the kind's 14 and the timestamp's first 19, count code points, as `ljust`
      // does and `padEnd`/`slice` do not. The truncation hint is the established sentence,
      // which names the file; an earlier version shortened it.
      const width = rows.reduce(
        (widest, row) => Math.max(widest, [...display(row.actor, '-')].length),
        0,
      );
      for (const row of [...rows].reverse()) {
        const origin = row.origin === 'session' ? '' : `  [${display(row.origin, 'legacy')}]`;
        io.writeOut(
          `${[...display(row.ts)].slice(0, 19).join('')}  ${ljust(display(row.actor, '-'), width)}  ` +
            `${ljust(display(row.kind), 14)} ${display(row.label)}${origin}${row.outcome === 'denied' ? '  DENIED' : ''}\n`,
        );
      }
      if (result.truncated === true)
        io.writeOut(
          `  (stopped early: ${display(result.path)} is large. Narrow it with --since or ` +
            '--actor, or ship it somewhere with an index.)\n',
        );
      return;
    }
    case 'chown':
      // ` (was <from>)` only when `from` is truthy: `from` is the raw previous owner, so an
      // int 0 or a null says nothing and a `true` or a list prints as `toTextAny` spells it.
      io.writeOut(
        `✓ ${quotedText(display(result.name))} now belongs to ${display(result.to)}${isTruthy(result.from) ? ` (was ${toTextAny(result.from)})` : ''}\n`,
      );
      return;
    case 'skill install':
      for (const row of bags(result.hosts))
        io.writeOut(`  ${display(row.action).padEnd(9)} ${display(row.path)}\n`);
      io.writeOut(`  version ${display(result.version)}\n`);
      return;
    case 'skill status':
      for (const [host, raw] of Object.entries(bag(result.hosts)).sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        const row = bag(raw);
        io.writeOut(`  ${host.padEnd(8)} ${display(row.status).padEnd(9)} ${display(row.path)}\n`);
      }
      if (result.current !== true)
        io.writeOut('  `houston skill install` writes the copy this build ships.\n');
      return;
    case 'doctor':
      for (const row of bags(result.checks)) {
        const mark = row.status === 'ok' ? '✓' : row.status === 'warn' ? '⚠' : '✗';
        io.writeOut(`${mark} ${display(row.message)}\n`);
      }
      if (Object.keys(bag(result.repros)).length > 0) {
        const repros = bag(result.repros);
        io.writeOut(
          `  workspaces: ${display(repros.total)} total, ${display(repros.running)} running\n`,
        );
      }
      io.writeOut(
        `\n${result.verdict === 'fail' ? 'Not ready — fix the ✗ item(s) above.' : result.verdict === 'warn' ? 'Usable, with warnings above.' : 'All good — houston is ready.'}\n`,
      );
      return;
    case 'cluster':
      if (action === 'guide') {
        io.writeOut(
          `${display(result.body, display(value))}${display(result.body, display(value)).endsWith('\n') ? '' : '\n'}`,
        );
      } else if (action === 'iam-policy') {
        const documents = bags(result.documents);
        const wanted = display(invocation.arguments.name);
        // Trailing newlines trimmed, then one: one newline, whatever the document ends with.
        if (wanted !== '' && documents.length === 1)
          say(io, display(documents[0]?.body).replace(/\n+$/u, ''));
        else {
          // THE MENU, as it has always been drawn: the heading, each purpose wrapped at 74 by
          // `wrapWords`, and the commands that use them. This build printed the rows alone, each
          // purpose on one line.
          say(io, 'permissions documents houston ships, each verified by using it:');
          for (const document of documents) {
            say(io, `  ${ljust(display(document.name), 9)} ${display(document.filename)}`);
            for (const line of wrapWords(display(document.purpose), 74))
              say(io, `            ${line}`);
          }
          say(io, '');
          say(io, '  houston cluster iam-policy operator > operator-policy.json');
          say(io, '  aws iam create-policy --policy-name houston-cluster-operator \\');
          say(io, '      --policy-document file://operator-policy.json');
          say(io, '  houston cluster iam-policy rbac | kubectl apply -f -');
        }
      } else if (action === 'list') {
        // A warning line adds no glyph, each row ends in when it was made and when it is due,
        // and the hint says how to price one.
        const clusters = bags(result.clusters);
        if (clusters.length > 0) {
          say(io, `${String(clusters.length)} cluster(s) — every one of these is billing`);
          for (const row of clusters) {
            const when = Array.from(toText(row.created)).slice(0, 10).join('');
            const due = isTruthy(row.expires) ? ` · expires ${toTextAny(row.expires)}` : '';
            say(
              io,
              `  ${ljust(toTextAny(row.region), 15)} ${ljust(toTextAny(row.name), 24)} ` +
                `${ljust(toText(row.status) || '?', 9)} ` +
                `${isTruthy(row.ours) ? 'houston' : "not houston's"}  created ${when || '?'}${due}`,
            );
          }
        }
        // NO REASSURING LINE WHEN NOTHING WAS SWEPT, and "houston" in it unless --force
        // widened the sweep. Then, said last and plainly, every region that could NOT be
        // read and why, and the fallback region list: this build stopped at the summary
        // and called nothing found in 21 unread regions a clean report.
        const regions = Array.isArray(result.regions) ? result.regions : [];
        if (clusters.length === 0 && regions.length > 0)
          say(
            io,
            `no ${bool(invocation.options.force) ? '' : 'houston '}clusters found in ` +
              `${String(regions.length)} region(s)`,
          );
        const unreadable = bags(result.unreadable);
        if (unreadable.length > 0) {
          say(
            io,
            `${String(unreadable.length)} region(s) could NOT be read — this report does not ` +
              'cover them:',
          );
          for (const bad of unreadable)
            say(io, `  ${ljust(toTextAny(bad.region), 15)} ${toTextAny(bad.why)}`);
        }
        if (isTruthy(result.fallback))
          say(
            io,
            'swept a built-in region list because the account could not be asked which are ' +
              `enabled (${toTextAny(result.fallback)})`,
          );
        // ENDS WITH WHAT TO DO NEXT, as every cluster action does: pricing the first one
        // found -- by its own name, which is enough -- or, with none, how to get one.
        say(
          io,
          clusters.length > 0
            ? `next  houston cluster status --context ${toTextAny(clusters[0]?.name)}`
            : 'next  houston cluster guide',
        );
      } else if (action === 'connect') {
        say(io, `connected ${display(result.context)} in account ${display(result.account)}`);
        if (result.reachable === true) {
          say(
            io,
            'Kubernetes responds; workspace permissions and preparation still need checking.',
          );
          say(io, `next  houston cluster status --context ${display(result.context)}`);
          say(
            io,
            `then  houston up --version <version> --name <ticket> --context ${display(result.context)}`,
          );
        } else
          say(
            io,
            `Kubernetes access is not ready: ${display(result.access_reason)}. Check the EKS access entry for ${display(result.principal)}.`,
          );
      } else if (action === 'prepare') {
        // The context it RESOLVED, not --context as typed (empty when the default was used),
        // and the adopted and next-command lines.
        const context = display((value as { __context?: string }).__context);
        say(io, `${context} is ready to serve a workspace`);
        say(io, `  storage   ${display(result.storage_class)}`);
        say(io, `  ingress   ${display(result.ingress_class)}`);
        say(io, '  certs     cert-manager installed');
        if (isTruthy(result.already)) {
          const adopted = (Array.isArray(result.already) ? result.already : []).map((item) =>
            toTextAny(item),
          );
          say(io, `  adopted   ${adopted.join(', ')} — left as they were`);
        }
        // A cluster with a zone names the workspace <name>.<zone> by itself.
        if (isTruthy(result.cname_target))
          say(
            io,
            '  then: houston up --version 8.5.1 --name t1 --runtime kubernetes ' +
              `--context ${context}${isTruthy(result.zone) ? '' : ' --domain <hostname>'}`,
          );
        const short = (display(result.context) || context).split('/').pop() ?? context;
        say(io, `next  houston up --version <version> --name <ticket> --context ${short}`);
      } else if (action === 'forget') {
        io.writeOut(`forgot ${display(result.context)} — the cluster itself was not touched\n`);
        say(io, 'next  houston cluster overview');
      } else if (action === 'overview') renderClusterOverview(io, result);
      else if (action === 'share') {
        say(
          io,
          `${display(result.principal)} may run workspaces on ${quotedText(display(result.name))}` +
            (isTruthy(result.already) ? ' (the access entry was already there)' : ''),
        );
        say(io, '  they run, once and then per ticket:');
        for (const line of Array.isArray(result.lines) ? (result.lines as unknown[]) : [])
          say(io, `    ${display(line)}`);
        say(io, 'next  houston cluster overview');
      } else if (action === 'keep') {
        say(
          io,
          `kept ${quotedText(display(result.name))} until ${display(result.expires)} ` +
            `(${display(result.days)} d) — a reminder tag; \`houston doctor\` and ` +
            '`houston cluster overview` say so once it passes',
        );
        say(io, 'next  houston cluster overview');
      } else if (action === 'create') {
        // The expiry or its absence, and the line people copy. NOT "cluster 'X' is up in R":
        // createCluster emits that as an event and emitOf prints every event, so the summary
        // repeated it one line under the first.
        const name = display(invocation.arguments.name);
        if (isTruthy(result.expires))
          say(
            io,
            `  tagged as wanted until ${toTextAny(result.expires)} — ` +
              '`houston doctor` says so once that passes',
          );
        else say(io, '  no expiry set — nothing will remind you this is running');
        const prepared = bag(result.prepared);
        say(
          io,
          '  point a workspace at it: houston up --version 8.5.1 ' +
            `--name TICKET-1234 --context ${name}` +
            (isTruthy(prepared.zone) ? '' : ' --domain <hostname>'),
        );
        if (isTruthy(prepared.cname_target)) {
          const zone = toText(prepared.zone) || '<your zone>';
          say(
            io,
            `next  point *.${zone} at ${toText(prepared.cname_target)} (a CNAME, once, at your DNS provider), then:`,
          );
          say(io, `      houston up --version <version> --name <ticket> --context ${name}`);
        } else {
          say(io, `next  houston up --version <version> --name <ticket> --context ${name}`);
        }
      } else if (action === 'delete') {
        if (result.said !== true)
          io.writeOut(
            result.deleted === true
              ? `cluster ${quotedText(display(result.name))} is gone\n`
              : `no cluster named ${quotedText(display(result.name))} to delete\n`,
          );
        if (result.deleted === true && isTruthy(result.leftovers)) {
          const left = bag(result.leftovers);
          const found = Array.isArray(left.found) ? (left.found as Bag[]) : [];
          const unreadable = Array.isArray(left.unreadable) ? (left.unreadable as Bag[]) : [];
          const region = display(result.region);
          if (found.length === 0 && unreadable.length === 0) {
            say(
              io,
              `nothing in ${region} is billing — AWS holds no volume, load balancer, NAT gateway, address or stack of it`,
            );
          } else {
            // Tied to this cluster by a tag: with the command. Not tied: to check, without
            // one -- in a region that holds colleagues' clusters, a command for something
            // nothing ties to this cluster is a command that can break theirs.
            const tied = found.filter((row) => row.certain !== false);
            const loose = found.filter((row) => row.certain === false);
            if (tied.length > 0)
              say(io, `left behind in ${region} — each one bills until it is removed:`);
            for (const row of tied) {
              say(io, `  ${display(row.kind)}  ${display(row.id)}  ${display(row.detail)}`);
              say(io, `    ${display(row.fix)}`);
            }
            if (loose.length > 0)
              say(io, `in ${region}, not tied to this cluster by any tag — check before deleting:`);
            for (const row of loose)
              say(io, `  ${display(row.kind)}  ${display(row.id)}  ${display(row.detail)}`);
            for (const row of unreadable) {
              say(
                io,
                `  ${display(row.kind)}: could not be read (${display(row.why)}) — check it in AWS`,
              );
            }
          }
          say(io, 'next  houston cluster list   # every region, so nothing is missed');
        }
      } else {
        // A reachable cluster: runCluster answered the other two stops itself.
        say(io, `cluster   ${display(result.context, '(none)')}`);
        renderClusterAbout(io, result);
        renderClusterShape(io, result);
        renderClusterCost(io, result);
        renderClusterNext(io, result);
      }
      return;
    case 'serve':
    case 'logs':
    case 'capabilities':
      return;
    default:
      throw new Error(`human renderer missing for ${path}`);
  }
}

export function createExecutor(io: CliIo, dependencies: HandlerDependencies = {}): CommandExecutor {
  return async (invocation) => {
    // Published once per command, as the root callback publishes it, so the service layer
    // audits, names and gates by who is running this without every call passing it down.
    const [actor, origin] = cliActorAndOrigin();
    return await runWithContext({ actor, origin }, async () => await execute(invocation));
  };

  async function execute(invocation: Invocation): Promise<unknown> {
    const result = await dispatch(invocation, dependencies, io);
    const data =
      typeof result === 'object' &&
      result !== null &&
      (result as { commandOutcome?: boolean }).commandOutcome === true
        ? (result as { data: unknown }).data
        : result;
    if (!active()) await renderHuman(invocation, data, io);
    return result;
  }
}

const processIo: CliIo = {
  writeOut: (value) => process.stdout.write(value),
  writeErr: (value) => process.stderr.write(value),
};

/** Production executor, loaded lazily by tools/cli.js after Commander has parsed argv. */
export const executeCommand = createExecutor(processIo);

/** 128 + SIGINT: the exit status when Ctrl-C stops a command. */
const INTERRUPTED = 130;

/**
 * Resolves once `stream` holds nothing unwritten: every queued byte has reached the reader,
 * or the stream has failed. A failure is left to the stream's 'error' listener, which Node
 * calls before 'close' -- so `runMain`'s EPIPE answer is given before this resolves.
 */
function flushed(stream: NodeJS.WriteStream): Promise<void> {
  if (stream.destroyed || (stream.errored === null && stream.writableLength === 0)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const closed = (): void => resolve();
    stream.once('close', closed);
    if (stream.errored !== null) return;
    // An empty write's callback runs once everything queued before it has been written.
    stream.write('', (error) => {
      if (error !== null && error !== undefined) return;
      stream.off('close', closed);
      resolve();
    });
  });
}

/**
 * The CLI's main: the command, inside the durable record of it.
 *
 * An earlier version wrote no `start`/`end` line for a CLI command at all -- only `serve`
 * leased the sink -- so the event log held nothing a CLI run did. Logging never stops the
 * command: every step here is best-effort.
 *
 * CTRL-C IS AN EXIT, NOT A DEATH. With no SIGINT listener, Node dies by the signal: no `end`
 * record, and a signalled wait status where the established answer is exit 130. That answer
 * was MEASURED, with real processes of the previous implementation, SIGINT sent once each
 * was blocked: `ready --name <ws> --timeout 60` polling, with and without `--json`, and
 * `logs --name <ws> --follow` waiting on its child, each exit 130 with NOTHING on stdout or
 * stderr beyond what the command had already printed (no envelope under `--json`) and a last
 * record of `end`, exit 130. An interrupt raised inside the command is a silent exit 130. A
 * command that listens for SIGINT itself keeps it -- `stats --watch` and `serve` stop and
 * exit 0, as they always have, and a question is `Aborted.` (see `interruptible`) -- so this
 * handler steps aside for any SIGINT listener registered after it.
 *
 * On a terminal the Ctrl-C also kills the child a command is waiting on, and Node can hand
 * JS that death before this handler's SIGINT: `logs` returned 0 and the `finally` below
 * removed the handler first, so the run was recorded as `end` 0 (14 of 300 pty runs). The
 * exec seam now holds such a death back long enough for the interrupt to land first; see
 * `INTERRUPT_GRACE_MS` in src/seams/exec.ts.
 *
 * AND WHAT IT STOPS, IT STOPS AS IT ALWAYS HAS. The handler used to be `process.exit(130)`,
 * which skips everything an interrupt must run on its way out: the child it was waiting on
 * was left running (it is owed 0.25 s, then a SIGKILL), a flock(1) waiter left to take the
 * lock later, and every `finally` the command had. The interrupt is now the exec seam's
 * (`interrupt` in src/seams/exec.ts): the waits it can reach -- children, the lock wait, HTTP
 * requests, rcapi's sleeps -- are taken over, a child killed after that grace
 * (`POPEN_SIGINT_WAIT_MS`). Inside a body that asked to be UNWOUND (`unwindsOnInterrupt`,
 * where the cleanup is) they raise Interrupted, the command's `finally` and `catch`
 * blocks run, and `runCli` answers it with exit 130 and nothing more. Anywhere else the
 * process ends once the waits are stopped, with the `end` record as before. Either way a run
 * that took a Ctrl-C ends 130 here, whatever a `catch` it passed through made of it.
 *
 * NOT REPRODUCED, on purpose: the previous implementation's `interrupted` line -- written to
 * STDOUT, as every warning line is -- for an interrupt raised before argv is parsed. Measured
 * by racing the signal against the `start` record, that window is under 10 ms. Nothing
 * between this function's `start` record and the command yields to the event loop, where Node
 * delivers a signal, so here the same race is answered inside the command, silently.
 *
 * Not armed before the event log, as the previous implementation was not: there a Ctrl-C
 * during startup is a stack trace and a death by SIGINT, with no record at all. SIGTERM and
 * SIGHUP are left alone, as they always have been: both die by those, with no `end` record.
 *
 * A READER THAT HAS GONE AWAY IS AN EXIT TOO. `houston audit -n 5000 | head -1`
 * closes the pipe while the table is still being written. The established answer fails the
 * write there and then, and exits 1 with nothing on stderr and an `end` 1 record. Node
 * records the failure on the stream and emits it as an 'error' event later, and
 * with no listener that was an unhandled 'error': a 25-line stack on stderr, landing AFTER
 * the `end` record had said 0, since the rest of the command ran first. So a stream's EPIPE
 * is answered here as Ctrl-C is: `end` 1 and exit 1, silently, whenever it lands. And the
 * `end` record waits for stdout and stderr to hold nothing unwritten (`flushed`): an echo
 * returns once its bytes are in the pipe, a Node write can still be queued when the command
 * returns, and a queued write that fails must be answered as the EPIPE it is, not recorded as
 * a success first.
 *
 * ANY OTHER FAILED WRITE IS AN UNHANDLED ERROR. Only EPIPE is answered as an exit; the rest
 * is thrown on, so `houston list > file` on a full disk, or a terminal that hung up, reaches
 * `main`'s catch-all. On stdout that is the stack trace, `end` 1, an `error` REPRO_ERROR record
 * with `trace`, "error: No space left on device - this is unhandled, ..." (no envelope
 * under --json, since writing it fails too, and no error line after it), and then the failure
 * to flush stdout at shutdown: "error: could not flush stdout: ..." and exit 120. On
 * stderr the stack trace itself cannot be printed, so the exception leaves `main` before its
 * `end` record is written: none is, and the status is 120. This build rethrew anything but
 * EPIPE from the 'error' listener: a Node stack, exit 1, and `start` alone in the log.
 *
 * A FAILED WRITE BEFORE THE COMMAND IS SWALLOWED, AND COUNTED AT EXIT. Outside the command,
 * every write is inside a handler that lets nothing through: the pre-rename adoption's, and
 * `reportBeforeCommand`'s. So a stderr that is a closed pipe during the adoption stops the
 * MIGRATION at its first message -- the skill copies and the edge handover after it do not
 * run -- and the command then runs to the end, and a startup refusal still exits with its
 * code; either way the flush of the stream at shutdown fails, and the status is 120. This
 * build had no listener before the command's own: the adoption moved the directory and died
 * of an unhandled 'error' event, exit 1, with no marker claimed and no log.
 * `keepWriteFailures` now records such a failure from the first line, the adoption's messages
 * throw on a failed write, and every way out goes through `atShutdown`.
 */
export async function runMain(argv: readonly string[]): Promise<number> {
  // ORDER IS THE WHOLE FIX: the pre-rename adoption first, since
  // it moves `~/.rc-repro` onto this path and one log line would make the destination
  // non-empty; then the ownership check, which must judge the home adoption produced; and
  // only then the event log, which is the first write. A build about to be refused must
  // not have written to the home on its way to being refused.
  //
  // The version FIRST of all: adoption reinstalls a pre-rename agent skill, and the sidecar
  // it writes records the version that wrote it. The version must be known from the first
  // line; here it was still jsonout's placeholder until runCli set it, so an adopted
  // skill said "houston_version": "0.0.0" on disk, outside HOUSTON_HOME, for good.
  setHoustonVersion((require('../../package.json') as { version: string }).version);
  // From the first write on, a failed one is kept rather than thrown: see "A FAILED WRITE
  // BEFORE THE COMMAND" above.
  keepWriteFailures();
  await adoptPreRenameState();
  try {
    const lock = require('../lib/lock') as typeof LibLockNS;
    const config = require('../lib/config') as typeof ConfigNS;
    // THE MARKER WINDOW: a home the previous implementation left is validated and
    // promoted here, before the ownership check judges it, and the caller is told once --
    // on stderr, so a `--json` stdout stays one envelope. A failure is a refusal like any
    // other before the command, and leaves the home exactly as it was.
    const promote = require('../core/promote') as typeof PromoteNS;
    const adopted = await promote.adoptRetiredHome(config.home());
    if (adopted !== null) writeStderr(`${adopted}\n`);
    lock.requireThisImplementation(config.home());
  } catch (error) {
    if (error instanceof ReproError) return atShutdown(reportBeforeCommand(error, argv));
    throw error;
  }
  // Whether this build was dispatched for this command, for the event log -- and the
  // dispatch variables removed from the environment, now that the claim has read them, so
  // no child process inherits them.
  const via = (require('../lib/lock') as typeof LibLockNS).consumeDispatch();
  const eventlog = require('../core/eventlog') as typeof EventlogNS;
  // Rotated before this run's first write when the log is over its cap: so a run's `start`
  // lands in a fresh file, never in the one about to become `.1`.
  await eventlog.rotateIfOver();
  const began = performance.now();
  let unregister: () => void = () => undefined;
  // Whether this run's `start` was written, and so whether it gets an `end`: when any of
  // these three throws there is no `start`, and no `end` either. What throws in practice is
  // the actor, from an accounts file that cannot be read -- measured with `users` a
  // directory: the established log holds ONE `error` record for `up --help` and nothing for
  // `--help`, where this build wrote an `end` for each, a run with an exit code and no
  // command to count it against.
  let recorded = false;
  // The `end` record is written once, by whichever way out the run takes first.
  let ended = false;
  const end = (code: number): void => {
    if (ended) return;
    ended = true;
    try {
      if (recorded) eventlog.ended(code, (performance.now() - began) / 1000);
    } catch {
      /* best-effort */
    }
    try {
      unregister();
    } catch {
      /* best-effort */
    }
  };
  // Whether this handler answered a Ctrl-C: the run then ends 130.
  const ctrlC = { answered: false };
  const interrupted = (): void => {
    // A listener registered after this one is the command's own, and answers the signal. It
    // is still listed while this runs: emit calls a copy, in the order they were registered.
    const listeners = process.listeners('SIGINT');
    if (listeners[listeners.length - 1] !== interrupted) return;
    ctrlC.answered = true;
    (require('../seams/exec') as typeof ExecNS).interrupt(() => {
      end(INTERRUPTED);
      process.exit(atShutdown(INTERRUPTED));
    });
  };
  // A failed write: see "A READER THAT HAS GONE AWAY" and "ANY OTHER FAILED WRITE" above.
  // A failure from before the command -- the adoption's, a refusal's -- was swallowed where it
  // happened and counts at exit; only a write the command makes is answered here.
  const earlier = { stdout: failureOf('stdout'), stderr: failureOf('stderr') };
  const writeFailed = (stream: 'stdout' | 'stderr', error: NodeJS.ErrnoException): void => {
    if (error === earlier[stream]) return;
    unwritten[stream] ??= error;
    if (error.code === 'EPIPE') {
      end(1);
      // Unless the usage panel was written: that path answers the pipe itself with exit 1,
      // and the flush at shutdown is not pacified.
      const rich = stream === 'stderr' && usagePanelWritten();
      process.exit(atShutdown(1, { pacified: !rich }));
    }
    if (stream === 'stdout') reportUnwritableStdout(error, argv, end);
    process.exit(atShutdown(1));
  };
  const stdoutFailed = (error: NodeJS.ErrnoException): void => writeFailed('stdout', error);
  const stderrFailed = (error: NodeJS.ErrnoException): void => writeFailed('stderr', error);
  // In the same synchronous step as the `start` record, and BEFORE it: Node delivers a signal
  // only at the next turn of the event loop, so from here on every Ctrl-C is answered after
  // the `start` record and with an `end` one. Armed after it, a signal in the few
  // microseconds between was a death with no `end` record (measured: 5 of 5 when sent the
  // instant the record landed).
  process.on('SIGINT', interrupted);
  process.stdout.on('error', stdoutFailed);
  process.stderr.on('error', stderrFailed);
  try {
    unregister = eventlog.installEventlogSink();
    eventlog.configure({ via });
    eventlog.started(redactArgv(argv).join(' '), cliActorAndOrigin()[0]);
    recorded = true;
  } catch {
    /* logging must never stop the command */
  }
  let code = 1;
  try {
    code = await runCli(argv, { execute: executeCommand });
    if (ctrlC.answered) code = INTERRUPTED;
    await flushed(process.stdout);
    await flushed(process.stderr);
    // A failure a stream has recorded and not yet emitted is still this run's: the write
    // failed inside the command.
    if (process.stdout.errored !== null)
      stdoutFailed(process.stdout.errored as NodeJS.ErrnoException);
    if (process.stderr.errored !== null)
      stderrFailed(process.stderr.errored as NodeJS.ErrnoException);
    return atShutdown(code);
  } finally {
    process.off('SIGINT', interrupted);
    process.stdout.off('error', stdoutFailed);
    process.stderr.off('error', stderrFailed);
    // And before `end`, so a run's `end` follows its `start` wherever the rotation put it.
    if (recorded) await eventlog.rotateIfOver();
    end(code);
    if (ctrlC.answered) {
      // The unwind is done, and the process exits here: a killed child's pipes, or a request
      // the interrupt abandoned, must not hold the process open after it.
      await (require('../seams/exec') as typeof ExecNS).interruptSettled();
      process.exit(atShutdown(code));
    }
  }
}

/** The exit status when stdout or stderr cannot be flushed at shutdown, as it has always been. */
const FLUSH_FAILED = 120;

/** The error a failed write is reported as: `Broken pipe` for EPIPE, else `fileErrorOf`'s. */
function writeErrorText(error: NodeJS.ErrnoException): Error {
  if (error.code !== 'EPIPE') return fileErrorOf(error);
  const broken = new Error('Broken pipe');
  broken.name = 'BrokenPipe';
  return broken;
}

/**
 * The first failed write on each stream, whose bytes count as still buffered at shutdown.
 * Kept here because a Node stdio stream does not keep it: `errored` is set by the failing write
 * and cleared again once its 'error' event has been emitted.
 */
const unwritten: Record<'stdout' | 'stderr', NodeJS.ErrnoException | null> = {
  stdout: null,
  stderr: null,
};

/** Record, never throw, a failed write on either stream: once per process. */
function keepWriteFailures(): void {
  if (keepingWriteFailures) return;
  keepingWriteFailures = true;
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    unwritten.stdout ??= error;
  });
  process.stderr.on('error', (error: NodeJS.ErrnoException) => {
    unwritten.stderr ??= error;
  });
}
let keepingWriteFailures = false;

/** A stream's failure, recorded or still waiting to be emitted. */
function failureOf(stream: 'stdout' | 'stderr'): NodeJS.ErrnoException | null {
  return unwritten[stream] ?? (process[stream].errored as NodeJS.ErrnoException | null);
}

/** A line on stderr, unless stderr has failed: then there is nowhere to say it. */
function writeStderr(text: string): void {
  if (failureOf('stderr') === null) process.stderr.write(text);
}

/**
 * The status the process exits with once the program has chosen `code`.
 *
 * Both streams are flushed on the way out, and a stream whose earlier write failed still
 * holds those bytes, so the flush fails again and the status is 120 whatever the program
 * chose. For stdout that is said first, on stderr; for stderr it cannot be. Once a broken
 * pipe has been answered as an exit (`pacified`), both streams swallow EPIPE at that flush
 * and nothing else.
 */
function atShutdown(code: number, { pacified = false } = {}): number {
  // Once: the process shuts down once, however many ways out reach here.
  if (shutdownStatus !== null) return shutdownStatus;
  const unflushed = (stream: 'stdout' | 'stderr'): NodeJS.ErrnoException | null => {
    const failure = failureOf(stream);
    return failure !== null && !(pacified && failure.code === 'EPIPE') ? failure : null;
  };
  const stdout = unflushed('stdout');
  const stderr = unflushed('stderr');
  if (stdout !== null) {
    const raised = writeErrorText(stdout);
    writeStderr(`error: could not flush stdout: ${raised.message}\n`);
  }
  shutdownStatus = stdout !== null || stderr !== null ? FLUSH_FAILED : code;
  return shutdownStatus;
}
let shutdownStatus: number | null = null;

/**
 * `main`'s catch-all, for a write to stdout that failed with anything but EPIPE: the
 * stack trace, `end` 1, the `error` record, and the report -- whose envelope, under --json,
 * is one more write to the stdout that just failed, so it throws before the error line.
 */
function reportUnwritableStdout(
  error: NodeJS.ErrnoException,
  argv: readonly string[],
  end: (code: number) => void,
): void {
  const raised = writeErrorText(error);
  const message =
    `${raised.message} - this is unhandled, and the stack trace is on stderr. ` +
    'If it names a file under HOUSTON_HOME, that file is the problem.';
  writeStderr(`${error.stack ?? String(error)}\n`);
  end(1);
  try {
    (require('../core/eventlog') as typeof EventlogNS).failed(ReproError.code, message, {
      stackTraceOnStderr: true,
    });
  } catch {
    /* never let logging change the exit */
  }
  if (!active() && !argv.includes('--json')) writeStderr(`error: ${message}\n`);
}

/**
 * Move a pre-rename state directory into place, once, before anything reads it. Best-effort
 * and never fatal -- a box this cannot migrate must still run `doctor`, the command that
 * explains why. Progress goes to stderr, always: `--json` has not been parsed yet, and stdout
 * is the envelope's.
 */
async function adoptPreRenameState(io: CliIo = processIo): Promise<void> {
  try {
    const migrate = require('../core/migrate') as typeof MigrateNS;
    if (!migrate.pending()) return;
    await migrate.migrate((event) => {
      io.writeErr(
        event.level === 'warn' || event.level === 'error'
          ? `${event.message}\n`
          : `  ${event.message}\n`,
      );
      // A failed write throws, which ends the migration at this message.
      const failed = io === processIo ? failureOf('stderr') : null;
      if (failed !== null) throw writeErrorText(failed);
    });
  } catch (error) {
    if (error instanceof ReproError) {
      io.writeErr(`${error.message}\n`);
      // The warning line fails inside the refusal's handler, and nothing above catches it:
      // the run ends here, before the marker and the log, and fails to flush stderr.
      if (io === processIo && failureOf('stderr') !== null) process.exit(atShutdown(1));
    }
    // anything else: never let this stop a command running
  }
}

/**
 * The recorded `EXTRA_CONTEXT` when it is truthy, else `names.CONTEXT`: the context a
 * Kubernetes workspace was created in, or houston's own cluster. An earlier version read
 * `kubernetes_context` -- the BOX's default-context config key, which no record carries -- so
 * `logs` and `stats` always passed an empty context and asked whatever kubectl's current
 * context happened to be.
 */
function recordedContext(extra: Record<string, unknown>): string {
  const config = require('../lib/config') as typeof ConfigNS;
  const names = require('../core/kube/names') as typeof KubeNamesNS;
  const recorded = extra[config.EXTRA_CONTEXT];
  return storedText(isTruthy(recorded) ? recorded : names.CONTEXT);
}
