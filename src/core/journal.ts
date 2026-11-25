/**
 * Durable notes about side effects that must be undone, so a killed process does not
 * leave them behind.
 *
 * WHY A FILE AND NOT A `finally`. The GUI runs long operations in the background, so
 * `systemctl restart`, an OOM kill or a plain SIGKILL ends them where they stand and skips
 * every `finally` they were relying on. Those blocks are doing real work: `backup` stops
 * Rocket.Chat for the duration of the dump, `loadtest` turns the API rate limiter OFF,
 * `capacity` arms the Mongo profiler and applies container CPU/RAM caps. Interrupted, all
 * of that outlives the process -- a workspace that silently is not serving, a rate limiter
 * left off -- with nothing anywhere recording that it happened.
 *
 * Cooperative cancellation cannot fix this. It helps a graceful shutdown; the dangerous
 * exit is the one where no code runs at all. What survives that is a note written BEFORE
 * the risky change and removed AFTER it is undone.
 *
 * THE HARD PART IS NOT WRITING IT, IT IS KNOWING WHOSE IT IS. An open entry belongs either
 * to a job still running or to a process that died. Repairing the first would re-enable the
 * rate limiter underneath a load test that is still going. So each entry records the pid
 * AND that process's start time, and recovery touches an entry only when its owner is
 * provably gone -- pid alone is not enough, because the OS recycles them.
 *
 * ## This module is the SINK; `lib/journal.ts` is the registry
 *
 * `core/eks` writes the most expensive note in the product and sits BELOW this file, so the
 * registry is the dependency inversion. This installs itself at import, and replays any
 * subject predicate registered before it arrived -- which is why that queue exists.
 *
 * ## `record` and `clear` are SYNCHRONOUS, and that is a deliberate departure
 *
 * Atomic filesystem helpers expose asynchronous APIs, so that nothing blocks the event
 * loop. This module is the exception, and the reason is the thing it exists for.
 *
 * `core/eks` writes CLUSTER_UNFINISHED on the line BEFORE `eksctl create cluster` -- a
 * twenty-minute call that builds a VPC, a NAT gateway and a control plane. An awaited write
 * yields the event loop between "decided to write the note" and "the note is on disk", and
 * that gap is precisely the window the note exists to cover: a SIGKILL landing in it leaves
 * a billing cluster with no record anywhere that it was ever started. It has always been
 * synchronous here for that reason, and `lib/journal.ts`'s registry is declared
 * synchronous and id-returning because `eks` has to be able to clear the note it wrote.
 *
 * So the write is `writeFileSync` + `renameSync` -- the same temp-file-then-rename
 * `runner/paths.atomicWrite` does, spelled synchronously. It is one small file, not a
 * subprocess or a network call, which is the class of work the async rule is about.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../lib/config';
import { type Emit, info, nullEmit, warn } from '../lib/events';
import { joinPath } from '../lib/home';
import { installJournalSink, type SubjectPredicate } from '../lib/journal';
import { mkdirParents } from '../lib/mkdir-parents';

import { down } from './runner/engine';
import { exists, remove } from './runner/paths';

/**
 * One file per open side effect. A DIRECTORY rather than a single log, because entries are
 * created and cleared concurrently by unrelated jobs, and an unlink is atomic where a
 * rewrite of a shared file is a lost-update race.
 */
export const DIRNAME = 'journal';

export const RATE_LIMITER_OFF = 'rate_limiter_off';
export const ROCKETCHAT_STOPPED = 'rocketchat_stopped';
/**
 * A throwaway workspace the deleted `benchmark` command meant to delete.
 *
 * NOTHING RECORDS THIS ANY MORE and it stays anyway. `benchmark` is gone, but a
 * journal note is durable state on somebody's disk, and the entire purpose of this module
 * is that a killed process's side effects are recoverable LATER -- by a build that may be
 * newer than the one that made the mess. Dropping the kind from a closed vocabulary would
 * strand exactly the notes it exists to honour.
 */
export const BENCH_WORKSPACE = 'bench_workspace';
export const CONSTRAINTS_APPLIED = 'constraints_applied';
export const CREATE_UNFINISHED = 'create_unfinished';
export const RC_METRICS_ON = 'rc_metrics_on';
export const MONGO_PROFILER_ON = 'mongo_profiler_on';
export const EMAIL_2FA_OFF = 'email_2fa_off';
/** One of `config.E2EE_ROOM_DEFAULT_SETTINGS`, named in `detail.setting`, off for a seed. */
export const E2EE_DEFAULT_OFF = 'e2ee_default_off';
export const DATABASE_DROPPED = 'database_dropped';
export const CLUSTER_UNFINISHED = 'cluster_unfinished';

/**
 * Kinds, CLOSED on purpose: recovery has to know how to undo each one, so a kind nothing
 * can repair is a note that would sit there forever looking like a fault.
 */
export const KINDS: readonly string[] = Object.freeze([
  RATE_LIMITER_OFF,
  ROCKETCHAT_STOPPED,
  BENCH_WORKSPACE,
  CONSTRAINTS_APPLIED,
  CREATE_UNFINISHED,
  RC_METRICS_ON,
  MONGO_PROFILER_ON,
  EMAIL_2FA_OFF,
  DATABASE_DROPPED,
  CLUSTER_UNFINISHED,
  E2EE_DEFAULT_OFF,
]);

/** Named once so the seed path and the repair cannot disagree about which key they mean. */
export const EMAIL_2FA_SETTING = 'Accounts_TwoFactorAuthentication_By_Email_Enabled';

/**
 * Kinds recovery REPORTS but does not undo by itself.
 *
 * `CREATE_UNFINISHED` is here for a timing reason: finishing a create means waiting for
 * Rocket.Chat to serve and then running the preset's self-configuration, which can take the
 * full readiness timeout, and doing that inside `serve`'s startup would hold the GUI shut
 * for minutes on a workspace nobody asked about. The other two are here because acting on
 * them is destructive and a process that already crashed is not what should decide to.
 */
export const ADVISORY: readonly string[] = Object.freeze([
  CREATE_UNFINISHED,
  DATABASE_DROPPED,
  CLUSTER_UNFINISHED,
]);

/**
 * Kinds whose note is ABOUT A WORKSPACE, and so goes when that workspace's record does.
 *
 * `down --volumes` and `prune` delete the containers, the data and the record, and nothing
 * cleared the notes about them: only a create that finishes and `ready` ever closed a
 * `CREATE_UNFINISHED`, and both need the workspace to exist. Seen as 28 notes for one
 * workspace that `down --volumes` had removed, and `doctor` went on advising `houston ready
 * --name <it>` -- advice that cannot work on a workspace that is gone. `serve`'s recovery
 * drops such notes at its next start, but a CLI-only box never starts one, and `doctor` is
 * what tells that box.
 *
 * Each one, and why it goes with the workspace:
 *   RATE_LIMITER_OFF, EMAIL_2FA_OFF, RC_METRICS_ON, MONGO_PROFILER_ON, E2EE_DEFAULT_OFF -- a
 *       setting held in the workspace's database, which the deletion took with its volume.
 *   ROCKETCHAT_STOPPED, CONSTRAINTS_APPLIED -- the state of a container, and the containers
 *       are gone.
 *   BENCH_WORKSPACE -- its repair IS deleting the workspace, which has just happened.
 *   CREATE_UNFINISHED -- `ready` completes a workspace; there is none left to complete.
 *   DATABASE_DROPPED -- the half-loaded database went with the volume.
 */
export const WORKSPACE_KINDS: readonly string[] = Object.freeze([
  RATE_LIMITER_OFF,
  ROCKETCHAT_STOPPED,
  BENCH_WORKSPACE,
  CONSTRAINTS_APPLIED,
  CREATE_UNFINISHED,
  RC_METRICS_ON,
  MONGO_PROFILER_ON,
  EMAIL_2FA_OFF,
  DATABASE_DROPPED,
  E2EE_DEFAULT_OFF,
]);

/**
 * The kinds that must OUTLIVE a workspace of the same name, and why.
 *   CLUSTER_UNFINISHED -- its `workspace` field carries a CLUSTER name, and the cluster may
 *       be billing now. A workspace called the same is not that cluster, and deleting it
 *       says nothing about whether an interrupted `eksctl create` left a VPC and a NAT
 *       gateway behind.
 * Every kind is in exactly one of the two, so a new kind has to be decided here rather than
 * fall into whichever default was nearest.
 */
export const OUTLIVE_THE_WORKSPACE: readonly string[] = Object.freeze([CLUSTER_UNFINISHED]);

export interface Entry {
  id: string;
  kind: string;
  workspace: string;
  pid: number;
  /** The owning process's start time, as /proc reports it; '' off Linux. */
  started: string;
  at: string;
  detail: Record<string, unknown>;
}

export function journalDir(): string {
  // Joined component by component, a `..` kept, as every path under the home is.
  return joinPath(config.home(), DIRNAME);
}

/**
 * A process's start time as a stable string, or null if it is not running.
 *
 * Field 22 of `/proc/<pid>/stat`, in clock ticks since boot. Read from the raw bytes and
 * split from the RIGHT of the last ')', because field 2 is the executable name and may
 * itself contain spaces or brackets.
 *
 * Returns '' for "running, but the start time could not be read", which is a different
 * answer from null and is what `ownerAlive` leans on.
 *
 * Off Linux there is no /proc, and reading it answered null -- "not running" -- for every
 * pid, this process's own included: on a Mac a CLI cluster build in another terminal read as
 * "failed part-way", and `serve`'s startup recovery would undo work still in progress. There
 * the answer is liveness alone, '' for a pid that exists: kill(0) succeeds, or is refused for
 * someone else's process.
 *
 * ponytail: pid only, so a recycled pid keeps a dead owner's note alive (left alone, never
 * undone). `ps -o lstart=` would add the start time, at the cost of an async `record`.
 */
export function procStarted(pid: number): string | null {
  if (process.platform !== 'linux') {
    // kill(0) and kill(-n) address process GROUPS, which are always "running".
    if (!(Math.trunc(pid) > 0)) return null;
    try {
      process.kill(Math.trunc(pid), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') return null;
    }
    return '';
  }
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${Math.trunc(pid)}/stat`, 'utf8');
  } catch {
    return null;
  }
  const close = raw.lastIndexOf(')');
  if (close < 0) return '';
  const fields = raw
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  return fields[19] ?? '';
}

/**
 * Whether the process that wrote this is still running.
 *
 * pid AND start time, because a recycled pid is a different process. An unknowable start
 * time falls back to pid liveness, which is the conservative direction: it means "assume
 * the owner is alive", so recovery leaves the entry alone rather than undoing live work.
 */
export function ownerAlive(entry: Entry): boolean {
  const current = procStarted(entry.pid);
  if (current === null) return false;
  if (!entry.started) return true;
  return current === entry.started;
}

/**
 * The current UTC time as `YYYY-MM-DDTHH:MM:SSZ`.
 *
 * UTC, LIKE EVERY OTHER TIMESTAMP HERE. `strftime` with no argument is LOCAL time, so one
 * event once read 22:29 in a journal note and 16:59 in the `repro.json` written beside it
 * -- and a note is read next to `doctor`, `list` and an audit line, all of which are UTC.
 */
function stamp(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

/**
 * Note a side effect that must be undone. Returns the entry id, or '' if unwritable.
 *
 * Best-effort by design: a journal that cannot be written must not stop the operation it
 * was describing. The operation's own `finally` is still the primary cleanup -- this is
 * only what covers the case where no `finally` runs.
 */
export function record(
  kind: string,
  workspace: string,
  detail: Record<string, unknown> = {},
): string {
  if (!KINDS.includes(kind)) {
    throw new Error(`unknown journal kind '${kind}' (want: ${KINDS.join(', ')})`);
  }
  const entry: Entry = {
    id: randomBytes(8).toString('hex'),
    kind,
    workspace,
    pid: process.pid,
    started: procStarted(process.pid) ?? '',
    at: stamp(),
    detail: { ...detail },
  };
  try {
    const dir = journalDir();
    // Made with its parents, the mode 0700 on the leaf only.
    mkdirParents(dir, 0o700);
    atomicWriteSync(joinPath(dir, `${entry.id}.json`), JSON.stringify(entry, null, 2));
  } catch {
    return '';
  }
  return entry.id;
}

/**
 * `runner/paths.atomicWrite`, spelled synchronously. See the module docstring for why.
 *
 * The temp name is unique per call for the reason the async one gives: a fixed
 * `<name>.tmp` meant two concurrent writers shared one path and clobbered each other,
 * defeating the atomicity it exists to provide.
 */
function atomicWriteSync(target: string, content: string): void {
  const unique = `${String(process.pid)}.${randomBytes(4).toString('hex')}`;
  const temporary = joinPath(path.dirname(target), `${path.basename(target)}.${unique}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf8' });
    fs.renameSync(temporary, target);
  } finally {
    // A no-op after a successful rename; the cleanup that matters is the failed one.
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* already renamed away */
    }
  }
}

/** Forget an entry, because whatever it described has been undone. */
export function clear(entryId: string): void {
  if (!entryId) return;
  try {
    fs.rmSync(joinPath(journalDir(), `${entryId}.json`), { force: true });
  } catch {
    /* best-effort */
  }
}

/**
 * Forget EVERY note of one kind for one workspace. Returns how many went.
 *
 * Some facts invalidate other processes' notes, not just your own. "This workspace's create
 * finished" is one: a create that failed left a `CREATE_UNFINISHED` note behind, and a
 * later create of the same name that succeeded cleared only the note it had written itself
 * -- so the stale one went on claiming a complete workspace had never finished. Seen
 * exactly that way, when a failed attempt was followed by a good one.
 */
export function clearKind(kind: string, workspace: string): number {
  let gone = 0;
  for (const entry of openEntries()) {
    if (entry.kind === kind && entry.workspace === workspace) {
      clear(entry.id);
      gone += 1;
    }
  }
  return gone;
}

/**
 * Forget every note ABOUT one workspace, because its record is being deleted.
 *
 * Whoever owns the note, alive or not -- unlike recovery, which touches abandoned ones only.
 * A live owner's note describes work on a workspace that is going away, so there is nothing
 * left for it to put back. Every caller holds the workspace's `reproLock`, which is where a
 * create writes its note, so no create can have one here for a workspace it has not made
 * yet. See `WORKSPACE_KINDS` for which kinds go.
 */
export function clearWorkspace(
  workspace: string,
  kinds: readonly string[] = WORKSPACE_KINDS,
): number {
  let gone = 0;
  for (const entry of openEntries()) {
    if (kinds.includes(entry.kind) && entry.workspace === workspace) {
      clear(entry.id);
      gone += 1;
    }
  }
  return gone;
}

/**
 * Record on the way in, clear on the way out -- however that happens.
 *
 * Wraps an existing `finally` rather than replacing it: the note is cleared when the normal
 * cleanup has run, so a surviving entry means precisely "the cleanup did not happen".
 */
export async function sideEffect<T>(
  kind: string,
  workspace: string,
  body: (entryId: string) => T | Promise<T>,
  detail: Record<string, unknown> = {},
): Promise<T> {
  const entryId = record(kind, workspace, detail);
  try {
    return await body(entryId);
  } finally {
    clear(entryId);
  }
}

/** Every entry on disk, newest last. Unreadable files are skipped, not raised. */
export function openEntries(): Entry[] {
  const out: Entry[] = [];
  let names: string[];
  try {
    names = fs
      .readdirSync(journalDir())
      .filter((n) => n.endsWith('.json'))
      .sort();
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const data = JSON.parse(fs.readFileSync(joinPath(journalDir(), name), 'utf8')) as Record<
        string,
        unknown
      >;
      const rawDetail = data.detail;
      out.push({
        id: String(data.id ?? '') || name.replace(/\.json$/u, ''),
        kind: String(data.kind ?? ''),
        workspace: String(data.workspace ?? ''),
        pid: Number.parseInt(String(data.pid ?? 0), 10) || 0,
        started: String(data.started ?? ''),
        at: String(data.at ?? ''),
        detail:
          typeof rawDetail === 'object' && rawDetail !== null && !Array.isArray(rawDetail)
            ? { ...(rawDetail as Record<string, unknown>) }
            : {},
      });
    } catch {
      continue;
    }
  }
  // By when each was written: the ids are random, so the file names alone are no order.
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * How to ask "is the thing this note is ABOUT still here", per kind.
 *
 * `recover()` clears an advisory note whose subject is gone, and it used to ask that as
 * `exists(entry.workspace)`. That is the right question for every kind today,
 * because every one of them is about a workspace -- and it is only ACCIDENTALLY right. A
 * note whose subject is NOT a workspace -- a cluster, say -- would find that false always,
 * and be cleared silently at the next `serve` startup. The most expensive note in the
 * product would be the one guaranteed not to survive.
 *
 * The fix is to keep ONE rule and make the rule true, rather than special-casing a kind out
 * of a rule stated as general -- which is the shape that produced this.
 */
const SUBJECT_EXISTS = new Map<string, SubjectPredicate>();

/** Register the owning module's way to ask whether a journal subject exists. */
export function registerSubjectPredicate(kind: string, predicate: SubjectPredicate): void {
  const current = SUBJECT_EXISTS.get(kind);
  if (current !== undefined && current !== predicate) {
    throw new Error(`journal subject predicate already registered for ${kind}`);
  }
  SUBJECT_EXISTS.set(kind, predicate);
}

export function subjectPredicateKinds(): string[] {
  return [...SUBJECT_EXISTS.keys()].sort();
}

/**
 * Whether the thing an advisory note is about still exists.
 *
 * A predicate that THROWS answers true, and that direction is deliberate: "I could not ask"
 * is not "it is gone", and the cost of the two mistakes is not symmetric. Keeping a stale
 * note wastes a line of output; dropping a live one loses the only record that something is
 * still running -- and for a cloud cluster, still billing.
 */
export async function stillThere(entry: Entry): Promise<boolean> {
  const ask = SUBJECT_EXISTS.get(entry.kind);
  if (ask === undefined) return await exists(entry.workspace);
  try {
    return await ask(entry);
  } catch {
    return true;
  }
}

/** Entries whose owning process is gone -- the ones safe to act on. */
export function abandoned(): Entry[] {
  return openEntries().filter((e) => !ownerAlive(e));
}

/** One line a human can act on, whether or not recovery can. */
export function describe(entry: Entry): string {
  const w = `'${entry.workspace}'`;
  switch (entry.kind) {
    case RATE_LIMITER_OFF:
      // A seed and a settings import turn it off too, and say so; a note without a
      // purpose is a load test's, as every earlier one was taken to be.
      return (
        `${w}: the API rate limiter was turned off for ` +
        `${String(entry.detail.purpose ?? 'a performance run')} at ${entry.at} and never ` +
        'turned back on'
      );
    case ROCKETCHAT_STOPPED:
      return `${w}: Rocket.Chat was stopped for a backup at ${entry.at} and never started again`;
    case BENCH_WORKSPACE:
      return (
        `${w}: a throwaway benchmark workspace from ${entry.at} is still here, ` +
        'holding a Rocket.Chat and a MongoDB'
      );
    case CONSTRAINTS_APPLIED: {
      const applied = Array.isArray(entry.detail.applied)
        ? (entry.detail.applied as Record<string, unknown>[])
        : [];
      const caps = applied
        .slice(0, 3)
        .map((a) => String(a.service ?? '?'))
        .join(', ');
      return (
        `${w}: CPU/RAM limits from a performance run at ${entry.at} are still ` +
        `applied (${caps || 'unknown services'})`
      );
    }
    case DATABASE_DROPPED:
      return (
        `${w}: a restore from ${String(entry.detail.bundle ?? 'a bundle')} dropped ` +
        `the database at ${entry.at} and never finished loading it — the workspace ` +
        `is running against an EMPTY or partial database. \`houston restore ` +
        `${String(entry.detail.bundle ?? '<bundle>')} --name ${entry.workspace}\` ` +
        'again is what completes it'
      );
    case CLUSTER_UNFINISHED: {
      const name = entry.workspace;
      const region = String(entry.detail.region ?? '<region>');
      const account = String(entry.detail.account ?? 'unknown account');
      // CloudFormation-shaped, because the obvious advice is the advice that fails: a
      // rolled-back `eksctl create` can leave its stack behind, and `eksctl delete` then
      // reports that the cluster does not exist while a VPC and a NAT gateway carry on
      // billing.
      return (
        `an \`eksctl create cluster\` for '${name}' in ${region} (account ${account}) ` +
        `was interrupted at ${entry.at} and never returned. It may have created a VPC, ` +
        'a NAT gateway and a control plane, which are BILLING NOW. houston will not ' +
        'delete a cloud cluster it did not see finish — that is minutes of destructive ' +
        'work on your AWS account decided by a process that already crashed. Run ' +
        `\`eksctl delete cluster --name ${name} --region ${region} --wait\`; if that ` +
        'says the cluster does not exist, the CloudFormation stack may have rolled back ' +
        `and SURVIVED, so check \`aws cloudformation describe-stacks --stack-name ` +
        `eksctl-${name}-cluster --region ${region}\` and delete it directly`
      );
    }
    case EMAIL_2FA_OFF:
      return (
        `${w}: email two-factor authentication was turned off for a seed at ` +
        `${entry.at} and never turned back on — seeded users are loginable and real ` +
        'ones may not be'
      );
    case E2EE_DEFAULT_OFF:
      return (
        `${w}: ${String(entry.detail.setting ?? 'an end-to-end encryption default')} was ` +
        `turned off for a seed at ${entry.at} and never turned back on — new rooms it ` +
        'covers are not created encrypted'
      );
    case RC_METRICS_ON:
      return (
        `${w}: Rocket.Chat's Prometheus metrics endpoint was turned on for a ` +
        `diagnostic run at ${entry.at} and never turned off`
      );
    case MONGO_PROFILER_ON:
      return (
        `${w}: Mongo's query profiler was armed for a diagnostic run at ${entry.at} ` +
        'and never disarmed — it is still writing a system.profile document for every ' +
        'slow operation'
      );
    case CREATE_UNFINISHED: {
      const seeded =
        entry.detail.seed === undefined || entry.detail.seed === null || entry.detail.seed === ''
          ? ''
          : ' and its seed';
      return (
        `${w}: the create started at ${entry.at} never finished, so it may be running ` +
        `WITHOUT its preset configuration${seeded || ' or seed data'} — ` +
        `\`houston ready --name ${entry.workspace}\` completes it`
      );
    }
    default:
      return `${w}: ${entry.kind} since ${entry.at}`;
  }
}

export interface RecoverRow {
  id: string;
  kind: string;
  workspace: string;
  what: string;
  repaired: boolean;
  why: string;
}

export type RepairHandler = (
  entry: Entry,
  emit: Emit,
  login: unknown,
) => boolean | Promise<boolean>;

const REPAIR_HANDLERS = new Map<string, RepairHandler>();

/** Register one side-effect owner's recovery handler, idempotently. */
export function registerRepair(kind: string, handler: RepairHandler): void {
  const current = REPAIR_HANDLERS.get(kind);
  if (current !== undefined && current !== handler) {
    throw new Error(`journal repair handler already registered for ${kind}`);
  }
  REPAIR_HANDLERS.set(kind, handler);
}

export function repairKinds(): string[] {
  return [...REPAIR_HANDLERS.keys()].sort();
}

/** Retained for durable notes written by the removed benchmark command. */
async function repairBench(entry: Entry): Promise<boolean> {
  await down(entry.workspace, { volumes: true });
  await remove(entry.workspace);
  return true;
}

registerRepair(BENCH_WORKSPACE, repairBench);

/** Dispatch to the side-effect owner without importing that owner. */
async function repairOne(entry: Entry, emit: Emit, login: unknown): Promise<boolean> {
  if (!(await exists(entry.workspace))) return true;
  const handler = REPAIR_HANDLERS.get(entry.kind);
  if (handler === undefined) return false;
  return Boolean(await handler(entry, emit, login));
}

export interface RecoverOptions {
  dryRun?: boolean;
  login?: unknown;
}

/**
 * Undo what abandoned entries describe. Returns one result per entry.
 *
 * NEVER throws: this runs at `serve` startup, and a box that cannot be repaired still has
 * to be able to serve. Each result carries `repaired` so a caller can say what is still
 * outstanding.
 */
export async function recover(
  emit: Emit = nullEmit,
  { dryRun = false, login = null }: RecoverOptions = {},
): Promise<RecoverRow[]> {
  const results: RecoverRow[] = [];
  // Newest first: two runs cut short on one workspace both noted a "prior" state, and the
  // second's prior is the first's change, so the oldest note's has to be put back last.
  for (const entry of abandoned().reverse()) {
    const row: RecoverRow = {
      id: entry.id,
      kind: entry.kind,
      workspace: entry.workspace,
      what: describe(entry),
      repaired: false,
      why: '',
    };
    if (ADVISORY.includes(entry.kind) && !(await stillThere(entry))) {
      // The thing the note is about is gone, so an unfinished create is no longer
      // anybody's problem. Advisory notes are never repaired, so without this they would
      // warn forever about something that cannot be acted on.
      //
      // UNDER dryRun THIS IS A READ. The clear used to sit above the dry-run check, so a
      // dry run over two notes reported one and DELETED the other -- and a dry run is the
      // only way to inspect the journal without repairing it, which makes mutating one a
      // contradiction in terms.
      if (dryRun) {
        row.why = 'the thing it is about is gone; would be dropped';
        results.push(row);
        continue;
      }
      clear(entry.id);
      continue;
    }
    if (dryRun || ADVISORY.includes(entry.kind)) {
      // Reported and left alone. See ADVISORY: undoing this one means waiting for a
      // workspace to serve, which is not something a GUI startup may spend.
      row.why = ADVISORY.includes(entry.kind) ? 'needs `houston ready`' : '';
      results.push(row);
      if (ADVISORY.includes(entry.kind)) warn(emit, row.what, { phase: 'preflight' });
      continue;
    }
    try {
      row.repaired = await repairOne(entry, emit, login);
    } catch (error) {
      // Recovery must not break startup.
      row.why = error instanceof Error ? error.message : String(error);
    }
    if (row.repaired) {
      clear(entry.id);
      info(emit, `repaired: ${row.what}`, { phase: 'preflight' });
    } else {
      warn(emit, `could NOT repair — ${row.what}${row.why ? ` (${row.why})` : ''}`, {
        phase: 'preflight',
      });
    }
    results.push(row);
  }
  return results;
}

/**
 * The seed an interrupted create asked for and never ran, or {}.
 *
 * Read from the NOTE rather than from the workspace's metadata, because that is the only
 * place it survives: the `CreateReq` died with the process, and `meta.extra.seed` is
 * written only after a seed has already succeeded -- so metadata can say "seeded" or say
 * nothing, and "nothing" covers both "none was asked for" and "one was asked for and lost".
 *
 * Only OPEN notes count. A note whose owner is still alive belongs to a create that is
 * still running, and finishing its seed underneath it would seed twice.
 */
export function pendingSeed(workspace: string): Record<string, unknown> {
  for (const entry of abandoned()) {
    if (entry.kind === CREATE_UNFINISHED && entry.workspace === workspace) {
      const seed = entry.detail.seed;
      if (seed === true || (typeof seed === 'string' && seed !== '')) return { ...entry.detail };
    }
  }
  return {};
}

/** Install this module as the journal `lib/journal.ts` reaches. */
export function installSink(): () => void {
  return installJournalSink({
    record,
    clear,
    registerSubjectPredicate,
  });
}

installSink();
