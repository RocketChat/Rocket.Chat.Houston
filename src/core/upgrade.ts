/**
 * Upgrade a running repro to another Rocket.Chat version — CLI and web API.
 *
 * An upgrade is where most "it broke after we upgraded" tickets actually live, because
 * Rocket.Chat runs its database migrations on boot. Reproducing that means taking a real
 * workspace with real data to a new version and watching what happens — which is only
 * meaningful if the data survives the trip.
 *
 * Requires the repro to be RUNNING. Not a stylistic choice: the pre-upgrade backup
 * needs Mongo up to dump, and the migrations only run when Rocket.Chat boots. A `down`ed
 * repro has no containers at all, so there is nothing to upgrade.
 *
 * The compose file is edited SURGICALLY (image tag + the oplog variable) rather than
 * regenerated from the spec. Regenerating would rebuild every launch-time decision from
 * defaults, so an --https repro would quietly lose its TLS and a bound repro its
 * --bind. Same approach `envvars` takes, for the same reason.
 *
 * A pre-upgrade backup is taken automatically and is what --rollback restores. The
 * backup is the point: it is what makes an upgrade something you can run twice.
 */
import * as fs from 'node:fs';

import * as compose from '../lib/compose';
import * as config from '../lib/config';
import {
  ConflictError,
  DockerError,
  NotReadyError,
  ReproError,
  ValidationError,
  errorText,
} from '../lib/errors';
import { type Emit, info, nullEmit, warn } from '../lib/events';
import { joinPath } from '../lib/home';
import { cleanup } from '../seams/exec';
import { InvalidVersion, compareVersions, parseVersion, type Version } from '../lib/version-spec';
import {
  floatString,
  quotedText,
  splitTextLines,
  toTextAny,
  isTruthy,
  valueKind,
  roundSeconds,
} from '../lib/format';
import {
  InvalidVersionError,
  type ReleaseFetcher,
  type Resolved,
  isBuildTag,
  resolve as resolveVersion,
} from '../lib/versions';

import * as audit from './audit';
import * as backup from './backup';
import { refuseAmbiguous, resolveName } from './lifecycle/naming';
import { signInGroup } from './lifecycle/notes';
import { mayDestroy } from './lifecycle/ownership';
import { requireEngine } from './lifecycle/preconditions';
import { LAST_BACKUP_KEY, UPGRADE_FROM_KEY } from './lifecycle/types';
import { releaseFetcher } from './lifecycle/request';
import { waitAndFinalize } from './lifecycle/ready';
import { apiInfo } from './rcapi';
import { composeLogsCapture, startServices, up } from './runner/engine';
import { containerDetails, rcState, runningWriterServices } from './runner/queries';
import {
  type Metadata,
  readCompose,
  readMeta,
  rcServices,
  updateMeta,
  write,
} from './runner/record';
import { workspace } from './runner/paths';
import * as topology from './topology';

type Bag = Record<string, unknown>;

export { LAST_BACKUP_KEY, UPGRADE_FROM_KEY };

function bagOf(value: unknown): Bag {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Bag;
}

function versionOf(value: unknown): Version | null {
  try {
    return parseVersion(String(value));
  } catch (error) {
    if (error instanceof InvalidVersion) return null;
    throw error;
  }
}

/** `versions.resolve`, its refusal of a version translated to a ValidationError. */
export function resolveOrRefuse(
  toVersion: string,
  offline: boolean,
  fetcher?: ReleaseFetcher,
): Resolved {
  try {
    return resolveVersion(toVersion, { offline, ...(fetcher === undefined ? {} : { fetcher }) });
  } catch (error) {
    // `InvalidVersionError` alone. Anything else -- a broken shipped map, a bug in the
    // resolver -- propagates as it always has, rather than being retyped as a caller
    // mistake.
    if (!(error instanceof InvalidVersionError)) throw error;
    // A CI build's version is read from GitHub. The resolver's own way round names
    // `--rc-image` and `--version`, which `up` has and `upgrade` does not.
    if (isBuildTag(toVersion)) {
      throw new ValidationError(
        `${quotedText(toVersion)} is a CI build, and its version is read from GitHub, which ` +
          'needs the network: run the upgrade without --offline, on a box that can reach it',
      );
    }
    throw new ValidationError(errorText(error));
  }
}

/**
 * The gate: an upgrade is only offered on a running workspace.
 *
 * Checked here in the service layer so the CLI and the GUI cannot disagree about when
 * the action is available.
 */
export async function requireRunning(name: string): Promise<Metadata> {
  const target = await resolveName(name);
  // As `down` refuses it: an upgrade or a rollback of somebody else's `test` while your own
  // `alice-test` is what you meant drops its data either way.
  if (name !== '') await refuseAmbiguous(name, target, audit.actor());
  // THE RIGHT ENGINE, not always Docker.
  await requireEngine(target);
  // BEFORE the running check, not after: `rcState` asks docker about containers, so a
  // healthy Kubernetes workspace was reported as "has no containers".
  if ((await topology.ofRepro(target)) === topology.KUBERNETES) {
    const { workloadExists } = await import('./kube/status');
    const { CONTEXT } = await import('./kube/names');
    const meta = await readMeta(target);
    const context = String(
      isTruthy(bagOf(meta.extra)[config.EXTRA_CONTEXT])
        ? bagOf(meta.extra)[config.EXTRA_CONTEXT]
        : CONTEXT,
    );
    // Its own namespace still, before an upgrade or a rollback changes what runs in it.
    await (await import('./kube/namespace')).requireOwnNamespace(target, { context });
    if (await workloadExists(target, { context })) {
      return meta;
    }
    throw new NotReadyError(
      `${quotedText(target)} is not running. Upgrades run Rocket.Chat's migrations on ` +
        `boot and the pre-upgrade backup needs MongoDB up: ` +
        `\`houston start --name ${target}\``,
    );
  }
  const state = await rcState(target);
  if (state === 'running') {
    return await readMeta(target);
  }
  // `rcState` reads `docker compose ps` WITHOUT --all, so a merely stopped repro
  // reports "absent" -- indistinguishable there from a `down`ed one. The two need
  // different advice (`start` vs `up`), so ask again with a call that does see
  // stopped containers.
  if ((await containerDetails(target)).length > 0) {
    throw new NotReadyError(
      `${quotedText(target)} is not running. Upgrades run Rocket.Chat's migrations on boot ` +
        'and the pre-upgrade backup needs MongoDB up: ' +
        `\`houston start --name ${target}\``,
    );
  }
  // With its version: `up` requires one, and a bare `up --name` was a usage error.
  const { rcVersion } = await readMeta(target);
  throw new NotReadyError(
    `${quotedText(target)} has no containers (it was \`down\`ed). Upgrades run Rocket.Chat's ` +
      'migrations on boot, so it has to be up first: ' +
      `\`houston up --version ${rcVersion} --name ${target}\``,
  );
}

/** Whether the Upgrade action should be offered, and why not if it should not. */
export async function canUpgrade(name: string): Promise<Bag> {
  try {
    const meta = await requireRunning(name);
    return { can_upgrade: true, reason: '', current: meta.rcVersion };
  } catch (error) {
    // Any expected failure -- missing repro, Docker down, stopped -- is a reason not
    // to offer the action. This is advisory and must never itself raise.
    if (!(error instanceof ReproError)) throw error;
    return { can_upgrade: false, reason: error.message, current: '' };
  }
}

/**
 * The unit a featureCompatibilityVersion step moves by. Before 5.0 each major.minor is one
 * (3.6, 4.0, 4.2, 4.4: 4.0 -> 4.4 is two steps); from 5.0 each major is.
 */
const PRE_5_SERIES = ['3.0', '3.2', '3.4', '3.6', '4.0', '4.2', '4.4'];

function seriesOf(version: Version): string {
  const [major = 0, minor = 0] = version.release;
  return major < 5 ? `${String(major)}.${String(minor)}` : String(major);
}

/** Every series from `from` up to `to`; none for a move down, which is refused anyway. */
function seriesSteps(from: Version, to: Version): string[] {
  const top = to.release[0] ?? 0;
  const all = [...PRE_5_SERIES];
  for (let major = 5; major <= top; major += 1) all.push(String(major));
  const start = all.indexOf(seriesOf(from));
  const end = all.indexOf(seriesOf(to));
  return start < 0 || end < start ? [] : all.slice(start, end + 1);
}

/** Whether the new pairing crosses a MongoDB major, and what to say about it. */
export function mongoMove(
  blocked: string,
  meta: Metadata,
  name: string,
  resolved: Resolved,
  warnings: string[],
): { blocked: string; mongoChange: string; keepMongo: boolean } {
  const curMongo = versionOf(meta.mongoTag);
  const newMongo = versionOf(resolved.mongoTag);
  let mongoChange = '';
  // KEPT, when the target runs on it. The pairing is what a FRESH workspace of that version
  // gets; an upgrade only replaces Rocket.Chat, so a MongoDB the target supports stays.
  // 7.12 -> 7.13 was refused "(7 -> 8)" -- 7.13 is paired with 8.0 and runs on 7.0.
  const supported = (resolved.supports ?? [])
    .map((tag) => versionOf(tag))
    .some((tag) => tag !== null && curMongo !== null && seriesOf(tag) === seriesOf(curMongo));
  if (
    curMongo !== null &&
    newMongo !== null &&
    seriesOf(newMongo) !== seriesOf(curMongo) &&
    supported
  ) {
    warnings.push(
      `MongoDB stays at ${meta.mongoTag}: Rocket.Chat ${resolved.rcVersion} runs on it ` +
        `(a new ${resolved.rcVersion} workspace would get ${resolved.mongoTag})`,
    );
    return { blocked, mongoChange, keepMongo: true };
  }
  if (curMongo !== null && newMongo !== null && seriesOf(newMongo) !== seriesOf(curMongo)) {
    // Refused, not attempted. Mongo majors must be stepped one at a time with a
    // featureCompatibilityVersion bump between each; doing it in one move is how the
    // data is lost. The way that works is a dump restored into a new workspace.
    const steps = seriesSteps(curMongo, newMongo);
    mongoChange =
      `Rocket.Chat ${resolved.rcVersion} pairs with MongoDB ${resolved.mongoTag}, ` +
      `but ${quotedText(name)} runs MongoDB ${meta.mongoTag}. MongoDB majors have to be ` +
      `stepped one at a time (${steps.join(' -> ')}), which houston does not do in place` +
      (compareVersions(newMongo, curMongo) > 0
        ? `. To carry the data across: houston backup --name ${name}, then houston up ` +
          `--version ${resolved.rcVersion} --name ${name}-new, then houston restore <bundle> ` +
          `--name ${name}-new --allow-upgrade`
        : '');
    blocked = blocked !== '' ? blocked : mongoChange;
  } else if (curMongo !== null && newMongo !== null && compareVersions(newMongo, curMongo) !== 0) {
    warnings.push(
      `MongoDB minor moves ${meta.mongoTag} -> ${resolved.mongoTag}; the ` +
        'container keeps its data volume and is not recreated by this upgrade',
    );
  }
  return { blocked, mongoChange, keepMongo: false };
}

/** Resolve what an upgrade would do, without doing any of it. */
export async function plan(
  name: string,
  toVersion: string,
  { offline = false, fetcher }: { offline?: boolean; fetcher?: ReleaseFetcher } = {},
): Promise<Bag> {
  const meta = await requireRunning(name);
  if (toVersion === '') {
    throw new ValidationError('no target version given, e.g. `--to 8.6.1`');
  }
  // ASKED ONLINE, as `up` asks. Resolved from the shipped map alone, any x.y.z inside a
  // known series looked real -- the GUI planned and enabled an upgrade to 8.99.0, which
  // would have taken a backup and then failed on the pull -- and a CI build could never be
  // resolved at all.
  const resolved = resolveOrRefuse(
    toVersion,
    offline,
    await releaseFetcher(toVersion, offline, fetcher),
  );

  const cur = versionOf(meta.rcVersion);
  const next = versionOf(resolved.rcVersion);
  let blocked = '';
  let direction = 'same';
  const warnings: string[] = [];

  if (resolved.source === 'map (no such release)') {
    blocked =
      `releases.rocket.chat has no ${resolved.rcVersion}, so there is no image to upgrade ` +
      `to — \`houston versions ${resolved.rcVersion}\` says what it knows`;
  } else if (resolved.rcVersion === meta.rcVersion) {
    blocked = `${quotedText(name)} is already at ${meta.rcVersion}`;
  } else if (cur !== null && next !== null && compareVersions(next, cur) < 0) {
    direction = 'downgrade';
    blocked =
      `downgrading ${meta.rcVersion} -> ${resolved.rcVersion} is not ` +
      'supported: Rocket.Chat does not migrate a database backwards, so ' +
      'the workspace will very likely fail to boot';
  } else if (cur !== null && next !== null) {
    direction = 'upgrade';
  } else {
    warnings.push(
      `cannot compare ${quotedText(meta.rcVersion)} with ${quotedText(resolved.rcVersion)}; ` +
        'proceeding blind',
    );
  }

  const {
    blocked: afterMongo,
    mongoChange,
    keepMongo,
  } = mongoMove(blocked, meta, name, resolved, warnings);
  blocked = afterMongo;

  if (isTruthy(bagOf(meta.extra).tls)) {
    warnings.push(
      'this workspace terminates TLS; its certificate and Traefik configuration are ' +
        'left exactly as they are',
    );
  }
  // What Rocket.Chat 9 will ask of this sign-in (a licence, HTTPS for OAuth), said before the
  // upgrade reproduces it rather than found at the login page: the notes say it from then on.
  if (signInGroup(meta).length === 0) {
    const after = signInGroup({ ...meta, rcVersion: resolved.rcVersion });
    for (const line of after.flatMap((group) => group.body)) {
      warnings.push(`after the upgrade to ${resolved.rcVersion}: ${line}`);
    }
  }

  return {
    name: meta.name,
    from_version: meta.rcVersion,
    to_version: resolved.rcVersion,
    rc_image: resolved.rcImage,
    from_mongo: meta.mongoTag,
    to_mongo: keepMongo ? meta.mongoTag : resolved.mongoTag,
    mongo_blocked: mongoChange,
    direction,
    allowed: blocked === '',
    blocked_reason: blocked,
    warnings,
    oplog: resolved.oplog,
    source: resolved.source,
  };
}

/**
 * Point every Rocket.Chat service at the new image; fix the oplog variable.
 *
 * Services are read from the doc rather than reconstructed from an instance count, so a
 * multi-instance repro cannot end up with some containers upgraded and others left
 * behind.
 *
 * MONGO_OPLOG_URL is emitted for RC < 8 and dropped from 8.x, so an upgrade across that
 * line has to add or remove it or the new container boots with a variable its version
 * does not expect.
 */
export function applyImage(doc: Bag, rcImage: string, tag: string, oplog: boolean): number {
  let changed = 0;
  const services = bagOf(doc.services);
  for (const svc of Object.keys(services)
    .filter((name) => name === 'rocketchat' || name.startsWith('rocketchat-'))
    .sort()) {
    const service = bagOf(services[svc]);
    services[svc] = service;
    service.image = compose.imageRef(rcImage, tag);
    if (!('environment' in service)) service.environment = {};
    const existing = service.environment;
    const env = Array.isArray(existing)
      ? Object.fromEntries(
          existing.map((item) => {
            const text = String(item);
            const at = text.indexOf('=');
            return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
          }),
        )
      : bagOf(existing);
    service.environment = env;
    if (oplog) {
      if (!('MONGO_OPLOG_URL' in env)) env.MONGO_OPLOG_URL = config.MONGO_OPLOG_URL;
    } else {
      delete env.MONGO_OPLOG_URL;
    }
    changed += 1;
  }
  doc.services = services;
  return changed;
}

/** Upgrade a running repro, backing it up first. */
export async function run(
  name: string,
  toVersion: string,
  {
    offline = false,
    force = false,
    noBackup = false,
    rollbackOnFailure = true,
    emit = nullEmit,
  }: {
    offline?: boolean;
    force?: boolean;
    noBackup?: boolean;
    rollbackOnFailure?: boolean;
    emit?: Emit;
  } = {},
): Promise<Bag> {
  const meta = await requireRunning(name);
  const target = meta.name;
  const { reproLock } = await import('./runner/locks');
  return await reproLock(
    target,
    async () =>
      await runLocked(target, toVersion, {
        offline,
        force,
        noBackup,
        rollbackOnFailure,
        emit,
      }),
  );
}

/** What is actually running afterwards, and what the migration logs said. */
export async function confirmTheUpgrade(
  emit: Emit,
  meta: Metadata,
  p: Bag,
  started: number,
  target: string,
): Promise<{ elapsed: number; errors: string[]; running: string }> {
  // Seconds on a monotonic clock, rounded to 1 place, half to even.
  const elapsed = roundSeconds(performance.now() - started);
  const info_ = await apiInfo(meta.rootUrl);
  const running = info_ === null ? '' : String(info_.version ?? '');
  if (
    running !== '' &&
    !String(p.to_version).startsWith(String(running).split('-')[0] ?? '') &&
    !String(running).startsWith(String(p.to_version))
  ) {
    warn(emit, `Rocket.Chat reports version ${running}, expected ${String(p.to_version)}`, {
      phase: 'upgrade',
    });
  }
  const errors = await migrationErrors(target);
  for (const line of errors) {
    warn(emit, `migration log: ${line}`, { phase: 'upgrade' });
  }

  // `{elapsed}` of a `round(..., 1)` float: `3.0s`, where `String` printed `3s`.
  info(
    emit,
    `${quotedText(target)} upgraded to ${String(p.to_version)} in ${floatString(elapsed)}s`,
    {
      phase: 'done',
      pct: 100,
    },
  );
  return { elapsed, errors, running };
}

/** Pull the new image and bring Rocket.Chat back, rolling back if it will not come. */
export async function pullAndRecreate({
  bundle,
  emit,
  kubeFlag,
  meta,
  p,
  previous,
  previousCompose,
  rollbackOnFailure,
  target,
}: {
  bundle: string;
  emit: Emit;
  kubeFlag: boolean;
  meta: Metadata;
  p: Bag;
  previous: { rcVersion: string; rcImage: string };
  previousCompose: string;
  rollbackOnFailure: boolean;
  target: string;
}): Promise<void> {
  try {
    if (kubeFlag) {
      // APPLY FIRST, then record. The record used to move ahead of the cluster, and
      // when the helm call then failed the workspace was left running the OLD version
      // while `list`, `info` and the GUI card all reported the new one.
      await applyKubernetes(target, p, emit);
      // ONLY WHAT THE UPGRADE CHANGED, onto the record as it is now. `meta` was read before
      // the pre-upgrade backup, which stops the port-forward and records the one it starts
      // again: written back whole, it put the dead pid back, so every readiness check after
      // it started another forward onto the port the live one held -- the upgrade and its
      // rollback timed out, and the live forward, named by nothing, outlived `down`.
      await updateMeta(target, (m) => {
        m.rcVersion = meta.rcVersion;
        m.rcImage = meta.rcImage;
        const now = bagOf(m.extra);
        for (const key of [UPGRADE_FROM_KEY, LAST_BACKUP_KEY]) {
          if (Object.hasOwn(bagOf(meta.extra), key)) now[key] = bagOf(meta.extra)[key];
          else delete now[key];
        }
        m.extra = now;
      });
    } else if ((await up(target)) !== 0) {
      throw new DockerError('`docker compose up` failed applying the new image');
    }
    info(emit, 'waiting for Rocket.Chat to run its migrations', { phase: 'wait', pct: 60 });
    await waitAndFinalize(await readMeta(target), emit, 300.0, false);
  } catch (exc) {
    // Whatever was thrown is caught, not only `Error`s, and a rejected non-Error still
    // owes the workspace its rollback. `errorText` is its text; the original value is
    // re-thrown untouched when there is nothing to roll back to.
    const why = errorText(exc);
    if (rollbackOnFailure && bundle !== '') {
      warn(emit, `upgrade failed (${why}); rolling back to ${String(p.from_version)}`, {
        phase: 'upgrade',
      });
      try {
        if (kubeFlag) {
          await rollbackKubernetes(target, previous, bundle, emit);
        } else {
          await rollbackCompose(target, previousCompose, previous, bundle, emit);
        }
      } catch (rexc) {
        // Letting this propagate would report the ROLLBACK's error and hide why the
        // upgrade failed -- while leaving the workspace in a state that is neither
        // version. Name both, and the bundle to recover from.
        throw new DockerError(
          `upgrade to ${String(p.to_version)} failed (${why}) AND the rollback ` +
            `failed (${errorText(rexc)}). ${quotedText(target)} is now in an indeterminate state; ` +
            `its pre-upgrade backup is at ${bundle} - restore it with ` +
            `\`houston restore ${bundle} --force\`.`,
        );
      }
      throw new DockerError(
        `upgrade to ${String(p.to_version)} failed and was rolled back to ` +
          `${String(p.from_version)}: ${why}`,
      );
    }
    throw exc;
  }
}

/** Whether this upgrade may proceed at all, and what to say before it does. */
export async function refuseOrWarn(
  emit: Emit,
  force: boolean,
  offline: boolean,
  target: string,
  toVersion: string,
): Promise<Bag> {
  const p = await plan(target, toVersion, { offline });
  if (!isTruthy(p.allowed) && !force) {
    // `--force` DOES NOT DO WHAT "try anyway" IMPLIES for a MongoDB major (a blocked plan
    // with one names it as its reason), so that refusal says what it does instead.
    throw new ValidationError(
      isTruthy(p.mongo_blocked) && p.blocked_reason === p.mongo_blocked
        ? `${String(p.mongo_blocked)}. \`--force\` upgrades Rocket.Chat only and leaves ` +
            'MongoDB where it is.'
        : `${String(p.blocked_reason)}. Pass --force to try anyway.`,
    );
  }
  if (isTruthy(p.mongo_blocked)) {
    warn(
      emit,
      `--force: upgrading Rocket.Chat ONLY. ${String(p.mongo_blocked)}. MongoDB stays at its ` +
        'current version and the record keeps naming it, so this workspace is a ' +
        'combination houston does not pair by itself.',
      { phase: 'upgrade' },
    );
  }
  for (const line of p.warnings as string[]) {
    warn(emit, line, { phase: 'upgrade' });
  }
  return p;
}

/** What the workspace is now, and the backup taken before it stops being that. */
export async function beforeTheUpgrade(
  emit: Emit,
  noBackup: boolean,
  p: Bag,
  target: string,
): Promise<{
  bundle: string;
  kubeFlag: boolean;
  meta: Metadata;
  previous: { rcVersion: string; rcImage: string };
  previousCompose: string;
}> {
  const kubeFlag = (await topology.ofRepro(target)) === topology.KUBERNETES;

  const meta = await readMeta(target);
  const ws = workspace(target);
  // A Kubernetes workspace has no compose document to keep a copy of; its previous
  // state is the image tag, which the helm release carries.
  const previousCompose = kubeFlag
    ? ''
    : fs.readFileSync(joinPath(ws, 'docker-compose.yml'), 'utf8');
  const previous = { rcVersion: meta.rcVersion, rcImage: meta.rcImage };

  let bundle = '';
  if (noBackup) {
    warn(emit, '--no-backup: there will be nothing to roll back to if the migrations fail', {
      phase: 'upgrade',
    });
  } else {
    info(emit, 'taking a pre-upgrade backup', { phase: 'backup', pct: 5 });
    // createLocked, not create(): the repro lock is already held here.
    const made = await backup.createLocked(target, {
      note: `pre-upgrade ${String(p.from_version)} -> ${String(p.to_version)}`,
      emit,
    });
    bundle = String(made.path);
  }
  return { bundle, kubeFlag, meta, previous, previousCompose };
}

export async function runLocked(
  target: string,
  toVersion: string,
  {
    offline,
    force,
    noBackup,
    rollbackOnFailure,
    emit,
  }: {
    offline: boolean;
    force: boolean;
    noBackup: boolean;
    rollbackOnFailure: boolean;
    emit: Emit;
  },
): Promise<Bag> {
  const p = await refuseOrWarn(emit, force, offline, target, toVersion);

  const { bundle, kubeFlag, meta, previous, previousCompose } = await beforeTheUpgrade(
    emit,
    noBackup,
    p,
    target,
  );

  info(
    emit,
    `upgrading ${quotedText(target)}: ${String(p.from_version)} -> ${String(p.to_version)}`,
    {
      phase: 'upgrade',
      pct: 25,
    },
  );
  let doc: Bag | null = null;
  if (!kubeFlag) {
    const services = await rcServices(target);
    const running = await runningWriterServices(target, services);
    try {
      await backup.stopWriters(target, services);
    } catch (error) {
      if (running.length > 0) {
        try {
          await cleanup(async () => {
            if ((await startServices(target, running)) !== 0) {
              warn(
                emit,
                `Rocket.Chat did not recover after the failed upgrade stop; run \`houston start --name ${target}\``,
                { phase: 'upgrade' },
              );
            }
          });
        } catch (recoveryError) {
          warn(
            emit,
            `Rocket.Chat did not recover after the failed upgrade stop: ${errorText(recoveryError)}`,
            { phase: 'upgrade' },
          );
        }
      }
      throw error;
    }
    doc = await readCompose(target);
    if (applyImage(doc, String(p.rc_image), String(p.to_version), isTruthy(p.oplog)) === 0) {
      throw new DockerError(`${quotedText(target)} has no rocketchat service to upgrade`);
    }
  }

  meta.rcVersion = String(p.to_version);
  meta.rcImage = String(p.rc_image);
  bagOf(meta.extra)[UPGRADE_FROM_KEY] = p.from_version;
  if (bundle !== '') {
    bagOf(meta.extra)[LAST_BACKUP_KEY] = bundle;
  } else {
    // CLEARED, not left alone. `--no-backup` used to leave the PREVIOUS upgrade's
    // bundle recorded while `upgraded_from` updated regardless, so a later `--rollback`
    // read that stale path and restored data from two versions back.
    delete bagOf(meta.extra)[LAST_BACKUP_KEY];
  }
  if (!kubeFlag && doc !== null) {
    // Compose has to be written BEFORE `up`, because `up` reads it.
    await write(target, compose.toYaml(doc as unknown as compose.ComposeDoc), meta);
  }

  info(
    emit,
    'pulling the new image and recreating Rocket.Chat (MongoDB and its data are untouched)',
    { phase: 'boot', pct: 40 },
  );
  const started = performance.now();
  await pullAndRecreate({
    bundle,
    emit,
    kubeFlag,
    meta,
    p,
    previous,
    previousCompose,
    rollbackOnFailure,
    target,
  });

  const { elapsed, errors, running } = await confirmTheUpgrade(emit, meta, p, started, target);
  return {
    name: target,
    from_version: p.from_version,
    to_version: p.to_version,
    running_version: running,
    boot_seconds: elapsed,
    backup: bundle,
    migration_errors: errors,
    warnings: p.warnings,
  };
}

export async function kubeTarget(target: string): Promise<[string, string]> {
  const { CONTEXT } = await import('./kube/names');
  const { namespaceFor } = await import('./kube/namespace');
  const meta = await readMeta(target);
  const extra = bagOf(meta.extra);
  const context = String(
    isTruthy(extra[config.EXTRA_CONTEXT]) ? extra[config.EXTRA_CONTEXT] : CONTEXT,
  );
  const namespace = String(
    isTruthy(extra.namespace) ? extra.namespace : await namespaceFor(target),
  );
  return [context, namespace];
}

/**
 * `helm upgrade` to the new image, with the chart pinned for that version.
 *
 * The chart moves WITH the app, which the official guide's own command does not do.
 * Here the chart is resolved for the target release by the same floor rule `up` uses.
 */
export async function applyKubernetes(target: string, p: Bag, emit: Emit): Promise<void> {
  const { resolveChartVersion } = await import('./kube/chart');
  const { splitImage } = await import('./kube/manifests');
  const { upgradeImage } = await import('./kube/release');
  const [context, namespace] = await kubeTarget(target);
  const chartVersion = await resolveChartVersion(String(p.to_version), emit);
  info(emit, `helm upgrade to chart ${chartVersion} (image ${String(p.to_version)})`, {
    phase: 'boot',
    pct: 45,
  });
  const [repo, tag] = splitImage(String(p.rc_image), String(p.to_version));
  await upgradeImage({
    namespace,
    context,
    chartVersion,
    imageRepo: repo,
    tag,
    oplog: isTruthy(p.oplog),
  });
  // The recorded values.yaml exists so a human can read what was deployed -- and after
  // an upgrade it still said the old tag. Best-effort.
  try {
    recordNewTag(target, repo, String(p.to_version), chartVersion);
  } catch (exc) {
    warn(
      emit,
      `upgraded, but the recorded values.yaml still shows the old image (${errorText(exc)})`,
      { phase: 'upgrade' },
    );
  }
}

export function recordNewTag(
  target: string,
  repo: string,
  tag: string,
  chartVersion: string,
): void {
  const file = joinPath(workspace(target), 'kubernetes', 'values.yaml');
  if (!fs.existsSync(file)) return;
  // `safeLoadYaml`, then `safeDump` with keys in document order: the file is YAML 1.1 on both
  // sides of the edit. It was read by the `yaml` package and written with its defaults --
  // YAML 1.2, so an env value `'no'` came back plain `no`, which YAML 1.1 reads as false;
  // every sequence indented under its key; nothing folded at the 80th column -- so the
  // previous implementation's next upgrade of the same workspace recorded the value as
  // `false`.
  // Every mapping is a Map, so each key is written back as the key that was read.
  let doc = config.safeLoadYaml(fs.readFileSync(file, 'utf8'), { mapAsMap: true });
  if (!(doc instanceof Map)) {
    // An empty document, or a falsy scalar or list, is a new mapping; anything else is not
    // a mapping, and is refused with what it is.
    if (loadedTruthy(doc)) throw new TypeError(`expected a mapping, got ${loadedKind(doc)}`);
    doc = new Map<unknown, unknown>();
  }
  const mapping = doc as Map<unknown, unknown>;
  // An `image` that is NOT a mapping is handed back as it is, and the item assignment then
  // throws -- the warning the caller prints -- where `bagOf` replaced
  // it with an empty mapping and wrote that.
  if (!mapping.has('image')) mapping.set('image', new Map<unknown, unknown>());
  const image = mapping.get('image');
  setLoadedItem(image, 'repository', repo);
  setLoadedItem(image, 'tag', tag);
  mapping.set('_chart_version', chartVersion);
  fs.writeFileSync(file, config.safeDumpYaml(mapping), 'utf8');
}

/** What kind of value `safeLoadYaml` built, with its article: a date, binary data and a set too. */
function loadedKind(value: unknown): string {
  if (value instanceof Date) return config.isYamlDate(value) ? 'a date' : 'a timestamp';
  if (value instanceof Uint8Array) return 'binary data';
  if (value instanceof Set) return 'a set';
  if (value instanceof Map) return 'a mapping';
  return valueKind(value);
}

/** Truthiness of what `safeLoadYaml` builds with `mapAsMap`. */
function loadedTruthy(value: unknown): boolean {
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (value instanceof Date) return true;
  return isTruthy(value);
}

/** `container[key] = value` on a loaded value, and a TypeError saying what a non-mapping is. */
function setLoadedItem(container: unknown, key: string, value: unknown): void {
  if (container instanceof Map) {
    container.set(key, value);
    return;
  }
  throw new TypeError(`expected a mapping, got ${loadedKind(container)}`);
}

/** Put the old image back, then restore the pre-upgrade data. */
export async function rollbackKubernetes(
  target: string,
  previous: { rcVersion: string; rcImage: string },
  bundle: string,
  emit: Emit,
): Promise<void> {
  const { resolveChartVersion } = await import('./kube/chart');
  const { splitImage } = await import('./kube/manifests');
  const { upgradeImage } = await import('./kube/release');
  const [context, namespace] = await kubeTarget(target);
  const chartVersion = await resolveChartVersion(previous.rcVersion, emit);
  const [repo, tag] = splitImage(previous.rcImage, previous.rcVersion);
  // A recorded version that parses and is below 8: an unparseable recorded version
  // is NOT treated as a pre-8 release -- that would add MONGO_OPLOG_URL to a workspace
  // whose version nobody can name.
  const previousVersion = versionOf(previous.rcVersion);
  await upgradeImage({
    namespace,
    context,
    chartVersion,
    imageRepo: repo,
    tag,
    oplog: previousVersion !== null && (previousVersion.release[0] ?? 0) < 8,
  });
  await updateMeta(target, (m) => {
    m.rcVersion = previous.rcVersion;
    m.rcImage = previous.rcImage;
  });
  await waitAndFinalize(await readMeta(target), emit);
  if (bundle !== '') {
    await backup.restoreLocked(target, bundle, await backup.readManifest(bundle), emit, {
      allowUpgrade: false,
      force: true,
      created: false,
    });
  }
}

/**
 * Migration-shaped errors from the boot logs.
 *
 * Best-effort and deliberately narrow: the value is naming the failure, not reproducing
 * the whole log, which `houston logs` already does.
 */
export async function migrationErrors(name: string, tail = 400): Promise<string[]> {
  let text: string;
  try {
    if ((await topology.ofRepro(name)) === topology.KUBERNETES) {
      const { CONTEXT } = await import('./kube/names');
      const { logProcess } = await import('./kube/status');
      const meta = await readMeta(name);
      const context = String(
        isTruthy(bagOf(meta.extra)[config.EXTRA_CONTEXT])
          ? bagOf(meta.extra)[config.EXTRA_CONTEXT]
          : CONTEXT,
      );
      // `"".join(proc.stdout)`: the lines, each with the newline text mode read it with.
      // `result.stdout` is always null here -- `stream` retains nothing -- so this read ''
      // and a Kubernetes upgrade never reported a migration error.
      const lines: string[] = [];
      await logProcess(name, { context, tail, follow: false, onLine: (line) => lines.push(line) });
      text = lines.map((line) => `${line}\n`).join('');
    } else {
      // Rocket.Chat's own services only: Grafana logs "Executing migration ... error_string
      // column" at info level on every start, and four of those were reported as migration
      // errors after a clean upgrade.
      text = await composeLogsCapture(name, { tail, services: await rcServices(name) });
    }
  } catch {
    // logs are a nicety, never a failure
    return [];
  }
  const hits: string[] = [];
  for (const line of splitTextLines(text)) {
    const low = line.toLowerCase();
    if (
      low.includes('migration') &&
      ['error', 'failed', 'fatal'].some((key) => low.includes(key))
    ) {
      hits.push(line.trim().slice(0, 300));
    }
  }
  return hits.slice(0, 10);
}

/** Put the workspace back: old compose, old metadata, pre-upgrade data. */
export async function rollbackCompose(
  target: string,
  previousCompose: string,
  previous: { rcVersion: string; rcImage: string },
  bundle: string,
  emit: Emit,
): Promise<void> {
  const meta = await readMeta(target);
  meta.rcVersion = previous.rcVersion;
  meta.rcImage = previous.rcImage;
  delete bagOf(meta.extra)[UPGRADE_FROM_KEY];
  await write(target, previousCompose, meta);
  await up(target);
  await backup.restoreLocked(target, bundle, await backup.readManifest(bundle), emit, {
    allowUpgrade: false,
    force: true,
    created: false,
  });
}

/** Put the old image and the old data back, on either runtime. */
export async function rollbackUnderLock(
  emit: Emit,
  kubeFlag: boolean,
  manifest: Bag,
  bundle: string,
  previous: { rcVersion: string; rcImage: string },
  resolved: Resolved,
  target: string,
): Promise<Bag> {
  const { reproLock } = await import('./runner/locks');
  return await reproLock(target, async () => {
    // AGAIN UNDER THE LOCK: handed over while this waited, it is somebody else's data now.
    await refuseUnlessMayDestroy(target);
    // Recorded before the current data is dropped for the bundle's: only a refusal was.
    audit.record('upgrade-rollback', target);
    if (kubeFlag) {
      // Before the chart moves: its own namespace still, not one another home made of that name.
      const { requireOwnNamespace } = await import('./kube/namespace');
      await requireOwnNamespace(target, { context: await backup.kube(target) });
      await rollbackKubernetes(target, previous, bundle, emit);
      return { restored: true };
    }
    const doc = await readCompose(target);
    applyImage(doc, previous.rcImage, previous.rcVersion, resolved.oplog);
    // Read HERE, not before the wait: a record read earlier and written back undid a
    // hand-over, a pin or an env change made in between.
    const meta = await readMeta(target);
    meta.rcVersion = previous.rcVersion;
    meta.rcImage = previous.rcImage;
    delete bagOf(meta.extra)[UPGRADE_FROM_KEY];
    await write(target, compose.toYaml(doc as unknown as compose.ComposeDoc), meta);
    if ((await up(target)) !== 0) {
      throw new DockerError('`docker compose up` failed rolling back the image');
    }
    return await backup.restoreLocked(target, bundle, manifest, emit, {
      allowUpgrade: false,
      force: true,
      created: false,
    });
  });
}

async function refuseUnlessMayDestroy(target: string): Promise<void> {
  const [allowed, why] = await mayDestroy(target, audit.actor());
  if (!allowed) {
    audit.record('upgrade-rollback', target, { outcome: 'denied' });
    throw new ConflictError(why);
  }
}

/** Undo the last upgrade of this repro from its automatic pre-upgrade backup. */
export async function rollback(
  name: string,
  { bundle = '', emit = nullEmit }: { bundle?: string; emit?: Emit } = {},
): Promise<Bag> {
  const target = await resolveName(name);
  if (name !== '') await refuseAmbiguous(name, target, audit.actor());
  // A rollback DROPS THE CURRENT DATABASE and loads an older one, which destroys a
  // colleague's reproduction state exactly as thoroughly as `down --volumes`.
  //
  // BEFORE requireEngine, because "you may not do this" does not depend on whether
  // Docker is up.
  await refuseUnlessMayDestroy(target);
  await requireEngine(target); // same reason as requireRunning
  const meta = await readMeta(target);
  const extra = bagOf(meta.extra);
  const recorded = bundle !== '' ? bundle : String(extra[LAST_BACKUP_KEY] ?? '');
  if (recorded === '') {
    throw new ValidationError(
      `no pre-upgrade backup recorded for ${quotedText(target)}; pass one explicitly ` +
        'with --bundle, or see `houston backups`',
    );
  }
  if (!fs.existsSync(backup.expandUser(recorded))) {
    throw new ConflictError(
      `the recorded pre-upgrade backup is gone (${recorded}); pass another ` + 'with --bundle',
    );
  }
  const manifest = await backup.readManifest(recorded);
  info(emit, `rolling ${quotedText(target)} back to ${toTextAny(manifest.rc_version)}`, {
    phase: 'upgrade',
    pct: 5,
  });
  const kubeFlag = (await topology.ofRepro(target)) === topology.KUBERNETES;
  const resolved = resolveOrRefuse(String(manifest.rc_version ?? ''), true);
  const previous = {
    rcVersion: String(manifest.rc_version ?? '') || meta.rcVersion,
    rcImage: String(manifest.rc_image ?? '') || resolved.rcImage,
  };
  const result = await rollbackUnderLock(
    emit,
    kubeFlag,
    manifest,
    recorded,
    previous,
    resolved,
    target,
  );
  await updateMeta(target, (m) => {
    delete bagOf(m.extra)[UPGRADE_FROM_KEY];
  });
  return {
    name: target,
    rolled_back_to: previous.rcVersion,
    bundle: recorded,
    restore: result,
  };
}
