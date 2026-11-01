/**
 * Creating a workspace on Docker Compose, and the front door both runtimes come in by.
 *
 * Tier 5. `createRepro` takes the lock and dispatches; `createReproLocked` is the Compose
 * path, and it is a PLAN plus a sequence of named steps rather than one function.
 *
 * It was 503 lines at cyclomatic complexity 99, and the cost was not aesthetic: the order
 * of those lines is load-bearing in about a dozen places, every one of them recorded in a
 * comment saying what broke when it was somewhere else. Each step names what it does, and
 * the order is visible in one screen at the bottom of this module.
 */
import { seedSelection } from '../../lib/seed-options';
import * as fs from 'node:fs/promises';

import * as compose from '../../lib/compose';
import * as config from '../../lib/config';
import {
  ConflictError,
  DockerError,
  NotFoundError,
  PreflightError,
  ValidationError,
  errorText,
} from '../../lib/errors';
import { type Emit, info, nullEmit, warn } from '../../lib/events';
import {
  notes as monitoringNotes,
  files as monitoringFiles,
  grafanaUrl as monitoringGrafanaUrl,
} from '../../lib/monitoring';
import { quotedText, toText } from '../../lib/format';
import { joinPath } from '../../lib/home';
import { redactEnv } from '../../lib/redact';
import { presetPort } from '../../lib/presets/common';
import * as presets from '../../lib/presets/index';
import { compositeName, namesOf, presetsLabel, qualifiedParams } from '../../lib/presets/composite';
import { directoryHost, withCertificate } from '../../lib/presets/ldap';
import { presignedOverHttps, publicPathsOf, withPublicUrl } from '../../lib/presets/public';
import { PROFILES } from '../../lib/seed-profiles';
import { type Preset } from '../../lib/presets/types';
import {
  type ReleaseFetcher,
  type Resolved,
  applyMongoOverride,
  flavor as mongoFlavorOf,
  resolve,
} from '../../lib/versions';
import { actor as auditActor, record as auditRecord } from '../audit';
import { refuseEnforcedBefore880 } from '../../lib/presets/e2ee';
import { refuseVoiceBefore800 } from '../../lib/presets/voice';
import { diagnoseFailure } from '../diagnose';
import { attach, backendContainer } from '../edge/networks';
import { hasAcme, issueLocalCert } from '../edge/acme';
import { foreignEdge, portHolder, running as edgeRunning } from '../edge/engine';
import { challengeStale, ensureRunning } from '../edge/runtime';
import { register as registerRoute } from '../edge/routes';
import { dockerKernelVersion, engine as hostEngine } from '../runner/host';
import * as engine from '../runner/engine';
import { reproLock, updateConfig as updateLockedConfig } from '../runner/locks';
import * as paths from '../runner/paths';
import * as portSeam from '../runner/ports';
import * as record from '../runner/record';
import { rcState, removeVolumes } from '../runner/queries';
import * as topology from '../topology';
import {
  MODE_LOCAL,
  acmeDir,
  budgetWarning,
  normalizeDomain,
  recordIssuance,
  rootUrl as tlsRootUrl,
} from '../tls';

import type * as createK8s from './create-k8s';
import { createKubernetes } from './create-k8s';
import * as inspect from './inspect';
import * as naming from './naming';
import * as ownership from './ownership';
import * as ports from './ports';
import * as preconditions from './preconditions';
import { restoreRoute, upCompose, waitAndFinalize } from './ready';
import * as request from './request';
import * as seeding from './seeding';
import * as sizing from './sizing';
import * as tlsplan from './tlsplan';
import { mongoKernelConflict } from '../../lib/mongo-kernel';
import { type CreateReq, BROWSER_HOST_PARAM, LOOPBACK_BINDS, PRESET_LINKS } from './types';
import { type TlsSpec } from '../tls';
import {
  clearKind,
  record as journalRecord,
  clear as journalClear,
  CREATE_UNFINISHED,
} from '../journal';

type Bag = Record<string, unknown>;

function bag(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value !== '';
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * What one Compose create knows, in the order it comes to know it.
 *
 * Every field is filled by exactly one step and read by the ones after it, so the
 * sequence at the bottom of this module IS the data flow -- there is no hidden channel
 * between steps.
 */
export interface CreatePlan {
  req: CreateReq;
  emit: Emit;
  streamOutput: boolean;
  monitorAttach: createK8s.MonitorAttach;
  versionFetcher?: ReleaseFetcher;
  /** `resolvePairing` */
  cfg: config.Config;
  resolved: Resolved | null;
  /** `loadPreset`, rebuilt by `claimPorts` on the side ports it was given */
  pre: Preset | null;
  /** A composed workspace's params, by preset; null for one preset, whose params are flat. */
  presetParams: Record<string, Record<string, unknown>> | null;
  /** `--set` as the caller gave it, before the record's params or a derived host fill it in. */
  typedParams: Record<string, unknown>;
  wait: boolean;
  /** `settleName` */
  reproName: string;
  /** `claimPorts` */
  hostPort: number;
  /** The presets' moved side ports, sparse (`extra.side_ports`); `{}` when none moved. */
  sidePorts: Record<string, number[]>;
  /** `[prometheus, grafana]` when monitored (`extra.monitoring_ports`), else empty. */
  monitorPorts: number[];
  root: string;
  token: string;
  bindHost: string;
  tlsspec: TlsSpec | null;
  /** `warnAboutTheBrowserHost` */
  public: string;
  /** `buildDocument` */
  envOverrides: Record<string, string | null>;
  adminPassword: string;
  spec: compose.Spec | null;
  doc: compose.ComposeDoc | null;
  /** `buildRecord` */
  meta: record.Metadata | null;
  /** The record a rebuild replaces, read by `buildDocument`; null on a first create. */
  previousMeta: record.Metadata | null;
  /** `prepareEdge`, then `attachMonitoring` */
  files: [string, string][];
}

export function createPlan(
  values: Partial<CreatePlan> & Pick<CreatePlan, 'req' | 'emit'>,
): CreatePlan {
  return {
    streamOutput: false,
    monitorAttach: request.missingMonitorAttach,
    cfg: {},
    resolved: null,
    pre: null,
    presetParams: null,
    typedParams: { ...values.req.params },
    wait: false,
    reproName: '',
    hostPort: 0,
    sidePorts: {},
    monitorPorts: [],
    root: '',
    token: '',
    bindHost: '',
    tlsspec: null,
    public: '',
    envOverrides: {},
    adminPassword: '',
    spec: null,
    doc: null,
    meta: null,
    previousMeta: null,
    files: [],
    ...values,
  };
}

/**
 * EVERY note for this workspace, not just the one just written.
 *
 * An earlier create that failed left its own, and clearing only ours left that one
 * claiming a finished workspace had never finished.
 *
 * UNLESS THE CALLER STILL HAS WORK TO DO. With `seedHere` the CLI runs the seed after the
 * create returns, so clearing here would delete the note in the window it exists for.
 */
export function clearTheUnfinishedNote(req: CreateReq, name: string, note: string): void {
  if (!req.seedHere) {
    journalClear(note);
    clearKind(CREATE_UNFINISHED, naming.deriveFor(req) || name);
  }
}

/**
 * The create itself, plus the write-ahead note that says it may not have finished.
 *
 * A CREATE THAT NEVER FINISHES LEAVES A WORKSPACE THAT LOOKS FINE. Measured by killing one
 * mid-flight: `docker compose up -d` has already detached, so the containers come up on
 * their own and `list` reports it `running` -- which is true. What is lost is everything
 * after readiness: the preset's self-configuration, the seed, the edge route.
 *
 * Advisory rather than repaired automatically: finishing it means waiting for Rocket.Chat
 * to serve and then running post_ready, which can take the full readiness timeout, and
 * `serve`'s startup must not hold the GUI shut for that.
 */
export async function createUnderTheLock(
  req: CreateReq,
  name: string,
  emit: Emit,
  {
    streamOutput,
    monitorAttach,
    versionFetcher,
  }: {
    streamOutput: boolean;
    monitorAttach: createK8s.MonitorAttach;
    versionFetcher?: ReleaseFetcher;
  },
): Promise<Bag> {
  return await reproLock(name, async () => {
    // WHAT THE NOTE HAS TO CARRY. `ready` is the command the note tells people to run, and
    // it could not finish a seed because the request that asked for one died with the
    // process -- `req.seed` lives in a CreateReq nobody can read any more.
    const detail = {
      seed: Boolean(req.seed),
      seed_here: Boolean(req.seedHere),
      seed_profile: String(req.seedProfile),
      seed_stats: Boolean(req.stats),
      seed_scenarios: req.seedScenarios,
      seed_history_days: req.seedHistoryDays,
    };
    let note = journalRecord(CREATE_UNFINISHED, name, detail);
    let out: Bag;
    try {
      out = await createReproLocked(req, emit, {
        streamOutput,
        monitorAttach,
        ...(versionFetcher === undefined ? {} : { versionFetcher }),
      });
    } catch (error) {
      // A REFUSAL CREATED NOTHING, so it must leave nothing. Without this the note
      // survived every kind of refusal -- a bad version, a taken port, a capacity
      // preflight -- one per attempt, and `doctor` then warned about a workspace that
      // does not exist while telling the reader to run `houston ready` on it.
      journalClear(note);
      throw error;
    }
    // RE-KEYED TO THE WORKSPACE THAT EXISTS. The note is recorded under the name derived
    // BEFORE `resolveAxes` ran, and `--deployment multi-instance` without a `--name` renames
    // the workspace on the way (`rc8-5-1` becomes `rc8-5-1-multi-instance`). With `seedHere`
    // the note is the CALLER's to close, by the name it is handed back -- so the one under
    // the old name was never cleared, and `doctor` reported an unfinished create for a
    // workspace that does not exist. Moved rather than dropped: until the caller's seed
    // lands, a kill must still leave a note, for the right name. The previous
    // implementation moves it the same way.
    const created = isTruthy(out.name) ? String(out.name) : name;
    if (req.seedHere && created !== name) {
      journalClear(note);
      note = journalRecord(CREATE_UNFINISHED, created, detail);
    }
    clearTheUnfinishedNote(req, name, note);
    return out;
  });
}

/**
 * Create-or-reuse a repro. Returns a result object (meta + boot/seed info).
 *
 * `streamOutput=true` streams docker's line output through `emit` (for the web job log);
 * false leaves docker's own progress on the terminal (CLI default). Serialised per repro,
 * like every other mutating operation.
 */
export async function createRepro(
  req: CreateReq,
  emit: Emit = nullEmit,
  {
    streamOutput = false,
    monitorAttach = request.missingMonitorAttach,
    versionFetcher,
  }: {
    streamOutput?: boolean;
    monitorAttach?: createK8s.MonitorAttach;
    versionFetcher?: ReleaseFetcher;
  } = {},
): Promise<Bag> {
  // ONE SPELLING of a set, whichever front-end sent it: the GUI's `preset: "ldap+email"` and
  // a restored manifest reach here as typed. Empty stays empty -- it means "as recorded".
  if (req.preset !== '') req.preset = compositeName(namesOf(req.preset));
  // A SEED PROFILE THAT DOES NOT EXIST, refused before anything is made. The planner refused
  // it only after the whole workspace had been pulled, built and started -- exit 1 over a
  // running workspace, for a typo.
  if (req.seed && req.seedProfile !== '' && !Object.hasOwn(PROFILES, req.seedProfile)) {
    throw new ValidationError(
      `unknown seed profile ${quotedText(req.seedProfile)} ` +
        `(want ${Object.keys(PROFILES).join(' | ')})`,
    );
  }
  if (!req.seed && (req.seedScenarios.length > 0 || req.seedHistoryDays !== null))
    throw new ValidationError('seed scenarios and history days require --seed');
  if (req.seed) {
    const selection = seedSelection(req.seedScenarios, req.seedHistoryDays);
    req.seedScenarios = [...selection.scenarios];
    req.seedHistoryDays = selection.historyDays;
  }
  // ONCE, HERE, before anything reads it. `runtime` is consulted at a dozen places
  // downstream and inferring it at each would be a dozen chances to disagree; after this
  // `req.runtime` means what the caller meant rather than only what they typed.
  const typedRuntime = String(req.runtime).trim();
  // Before the first `deriveFor`: a typed name that is an existing workspace this actor may
  // act on means that workspace, not a new `<actor>-<name>` beside it.
  await ownership.claimTypedName(req);
  // A workspace brought back goes to its recorded cluster: carried before anything says
  // where this is going, or that would name the box's default instead.
  await carryRecordedAxes(req, naming.deriveFor(req));
  req.runtime = request.inferRuntime(req);
  request.sayWhereThisIsGoing(req, typedRuntime, emit);
  // SAID, not dropped: these two mean nothing to Compose, and a Docker workspace came up
  // without a word that the operator (or the ingress class) asked for was not there.
  if (req.runtime !== topology.KUBERNETES) {
    const ignored = [
      req.mongoOperator ? '--mongo-operator' : '',
      req.ingressClass !== '' ? '--ingress-class' : '',
    ].filter((flag) => flag !== '');
    if (ignored.length > 0) {
      warn(emit, `${ignored.join(' and ')}: Kubernetes only, ignored on Docker`, {
        phase: 'plan',
      });
    }
  }

  const name = naming.deriveFor(req);
  if (!name) {
    throw new ValidationError(
      `name '${req.name}' contains no usable characters (want a-z, 0-9, '-')`,
    );
  }
  // The workspace's public name, from the cluster's zone, once the name is known.
  await request.defaultDomainFromZone(req, name, emit);
  naming.requireValidName(name);
  return await createUnderTheLock(req, name, emit, {
    streamOutput,
    monitorAttach,
    ...(versionFetcher === undefined ? {} : { versionFetcher }),
  });
}

/**
 * The rest of what a reuse does not apply, each only when it was asked for and differs from the
 * record, so re-running the command that made the workspace says nothing of these (the licence
 * and registration token are never recorded, so `reuse` names them whenever given). All of these went
 * unmentioned: `up --name existing --bind 0.0.0.0` (or --set, --root-url, --rc-image, --mongo,
 * --https, --domain, --env) came back exactly as before and said it was fine (live 2026-10-30).
 */
function ignoredSettings(
  req: CreateReq,
  meta: record.Metadata,
  resolved: Resolved | null,
  presetName: string,
  typed: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  const extra = bag(meta.extra);
  const bound = String(extra.bind_host ?? '') || config.DEFAULT_BIND_HOST;
  if (req.bind && req.bind !== bound) out.push(`bind address ${req.bind} (existing: ${bound})`);
  const advertised = String(extra.advertised_url ?? '') || meta.publicUrl || meta.rootUrl;
  if (req.rootUrl && req.rootUrl.replace(/\/$/u, '') !== advertised.replace(/\/$/u, '')) {
    out.push(`root URL ${req.rootUrl} (existing: ${advertised})`);
  }
  // As compose names them: the record keeps the repository, and the tag is the release.
  if (req.rcImage && resolved !== null) {
    const image = compose.imageRef(resolved.rcImage, resolved.rcVersion);
    const running = compose.imageRef(meta.rcImage, meta.rcVersion);
    if (image !== running) out.push(`image ${image} (existing: ${running})`);
  }
  if (req.mongo && resolved !== null && resolved.mongoTag !== meta.mongoTag) {
    out.push(`MongoDB ${resolved.mongoTag} (existing: ${meta.mongoTag})`);
  }
  if (req.domain) {
    // As TLS reads it (`https://RC.Example.com/` is `rc.example.com`), which runs after this.
    const asked = attempt(() => normalizeDomain(req.domain)[0], req.domain.toLowerCase());
    const host = attempt(() => new URL(meta.publicUrl).hostname, meta.publicUrl);
    if (asked !== host) out.push(`domain ${asked} (existing: ${host || 'none, plain HTTP'})`);
  } else if ((req.https || req.acmeEmail) && !meta.publicUrl) {
    out.push('HTTPS (existing: plain HTTP)');
  }
  const instances = Number(extra.instances ?? 0);
  // A typed `--set instances=N` is named with the other params below.
  if (
    instances > 1 &&
    req.replicas &&
    req.replicas !== instances &&
    !Object.hasOwn(typed, topology.LEGACY_REPLICA_PARAM)
  ) {
    out.push(`--replicas ${String(req.replicas)} (existing: ${String(instances)})`);
  }
  // Only what was typed: a host derived from the root URL, or the record's own params carried
  // back, is not a request.
  const preset = presetName || meta.preset;
  const names = namesOf(preset);
  const [asked, kept] =
    names.length > 1
      ? [
          qualifiedParams(request.paramsByPreset(names, typed)),
          qualifiedParams(bag(extra.preset_params)),
        ]
      : [request.unqualifiedParams(preset, typed), bag(extra.params)];
  const params = Object.entries(asked)
    .filter(([key, value]) => !Object.hasOwn(kept, key) || String(kept[key]) !== String(value))
    .map(([key, value]) => `${key}=${redactEnv(key, String(value))}`);
  if (params.length > 0) out.push(`--set ${params.join(' ')}`);
  const env = bag(extra.env);
  // Keys only: a value can be a secret.
  const keys = Object.entries(req.env)
    .filter(([key, value]) => !Object.hasOwn(env, key) || String(env[key]) !== String(value))
    .map(([key]) => key);
  if (keys.length > 0) {
    out.push(`environment ${keys.join(', ')} (\`houston env --set\` changes it in place)`);
  }
  return out;
}

function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** Reuse an existing workspace exactly as recorded, saying so when that ignores a flag. */
export async function reuse(
  name: string,
  wait: boolean,
  req: CreateReq,
  emit: Emit,
  {
    streamOutput,
    resolved = null,
    presetName = '',
    typedParams = req.params,
  }: {
    streamOutput: boolean;
    resolved?: Resolved | null;
    presetName?: string;
    typedParams?: Record<string, unknown>;
  } = {
    streamOutput: false,
  },
): Promise<Bag> {
  const meta = await record.readMeta(name);
  // An existing repro is reused EXACTLY as recorded. Say so when the request asked for
  // something else: `up --version 9.9.9 --name existing` silently booted the old version,
  // which is fatal for a tool whose whole premise is version matching.
  const mismatch: string[] = [];
  if (resolved !== null && resolved.rcVersion !== meta.rcVersion) {
    mismatch.push(`version ${resolved.rcVersion} (existing: ${meta.rcVersion})`);
  }
  if (presetName && presetName !== meta.preset) {
    mismatch.push(`preset '${presetName}' (existing: '${meta.preset}')`);
  }
  if (req.monitor && !isTruthy(meta.extra.monitoring)) {
    mismatch.push('monitoring (existing: not attached)');
  }
  if (req.license !== '') mismatch.push('the license');
  if (req.port && req.port !== meta.hostPort) {
    mismatch.push(`port ${String(req.port)} (existing: ${String(meta.hostPort)})`);
  }
  if (req.regToken !== '') mismatch.push('the registration token');
  mismatch.push(...ignoredSettings(req, meta, resolved, presetName, typedParams));
  if (mismatch.length > 0) {
    // A rebuild onto another preset removes what the old one kept -- an s3_minio workspace's
    // uploads -- so that is said where --force is offered, not discovered after it.
    const dropsData =
      presetName !== '' && presetName !== meta.preset && (meta.preset || 'default') !== 'default'
        ? ` (a --force rebuild as '${presetName}' removes the data '${meta.preset}' kept)`
        : '';
    // A VERSION is not a --force: that skips the upgrade's backup and lets a downgrade
    // through. `upgrade` backs up first and refuses one.
    const newVersion =
      resolved !== null && resolved.rcVersion !== meta.rcVersion ? resolved.rcVersion : '';
    const others = mismatch.length > (newVersion === '' ? 0 : 1);
    const msg =
      `'${name}' already exists and is reused as-is, ignoring requested ` +
      mismatch.join('; ') +
      '.' +
      (newVersion === ''
        ? ''
        : ` To move it to ${newVersion} and keep its data: houston upgrade --name ${name} ` +
          `--to ${newVersion} (it backs up first, and refuses a downgrade); for a separate ` +
          'workspace on that version, use another --name.') +
      (others ? ` Use --force to rebuild it${dropsData}.` : '') +
      ' --fresh rebuilds it empty.';
    warn(emit, msg, {
      phase: 'create',
      code: 'VERSION_IGNORED_ON_REUSE',
      data: {
        requested: resolved?.rcVersion ?? '',
        running: meta.rcVersion,
        ignored: mismatch,
      },
    });
    // AND IN THE ENVELOPE. In prose this is loud; under `--json` it was an NDJSON progress
    // event and the envelope still said `ok: true, warnings: []`.
  }
  // --pin IS APPLIED, NOT DROPPED. It was not even among the flags said to be ignored, so
  // `up --pin` on an existing workspace answered `pinned: false` -- and the next `prune`
  // deleted, data and all, the one workspace its owner had just asked to keep. As a
  // create does, it also becomes the default.
  if (req.pin) {
    if (!isTruthy(meta.pinned)) {
      await record.updateMeta(name, (m) => {
        m.pinned = true;
      });
      meta.pinned = true;
      info(emit, `'${name}' is pinned now — \`prune\` keeps it`, { phase: 'create' });
    }
    await updateLockedConfig((cfg) => {
      cfg.default_repro = name;
    });
  }
  const state = await rcState(name);
  if (state === 'running') {
    info(emit, `'${name}' is already running.`, { phase: 'create' });
  } else {
    info(emit, `'${name}' already exists - bringing it back up.`, { phase: 'create' });
    if ((await upCompose(name, { pull: false, emit, streamOutput })) !== 0) {
      throw new DockerError('`docker compose up` failed');
    }
  }
  // A reused workspace gets its https name back. This path never resolved TLS -- it reuses
  // the record as-is -- so after a `down`, `up` printed "URL https://…" from that record
  // while the name served nothing at all: the route was removed by the teardown and never
  // rewritten.
  await restoreRoute(meta, emit);

  const result = await inspect.summary(meta);
  result.reused = true;
  result.waited = wait;
  if (wait) Object.assign(result, await waitAndFinalize(meta, emit));
  // NOT when the caller seeds. `seedHere` means the CLI runs it after this returns, so
  // seeding here as well would seed the workspace twice -- the manifest only ever adds, so
  // the readback would report rooms holding more than planned.
  if (req.seed && !req.seedHere) {
    result.seed = await seeding.runSeedInline(meta, req.seedProfile, req.stats, emit, {
      scenarios: req.seedScenarios,
      historyDays: req.seedHistoryDays,
    });
  }
  return result;
}

/**
 * An existing workspace's recorded deployment, instance count, cluster and MongoDB operator,
 * for whichever of them this run left out, as the GUI's Start rebuilds it: an empty --deployment resolved to
 * Kubernetes' default, so `up --name X` brought a monolith back as microservices, and an
 * empty --context could send it to another cluster. Only on the runtime it was recorded on:
 * the shape of one runtime means nothing on the other.
 */
export async function carryRecordedAxes(req: CreateReq, name: string): Promise<void> {
  if (!name || !(await paths.exists(name))) return;
  let meta: record.Metadata;
  let was: Record<string, unknown>;
  try {
    meta = await record.readMeta(name);
    was = topology.axesOfMeta(meta);
  } catch {
    return; // a half-written record: nothing to keep
  }
  if (req.runtime && topology.normalize(req.runtime) !== was.runtime) return;
  if (!req.deployment) {
    req.deployment = String(was.deployment ?? '');
    // The count belongs to that shape; with a --deployment typed it is the user's to give, and
    // so is a typed `--set instances=N` -- carried here, the record's count would beat it.
    if (!req.replicas && req.params[topology.LEGACY_REPLICA_PARAM] === undefined) {
      req.replicas = Number(was.replicas) || 0;
    }
  }
  req.context ||= String(was.context ?? '');
  req.mongoOperator ||= was.mongoOperator === true;
  // Its monitoring too, as a Kubernetes re-up keeps it: `up --force` without --monitor
  // dropped Prometheus and Grafana without a word. `houston monitor --off` drops them.
  req.monitor ||= isTruthy(meta.extra.monitoring);
  // And the address Rocket.Chat advertises: `up --force` put ROOT_URL back to loopback under
  // a proxied workspace, leaving Site_Url on the old name. Not from a workspace houston served
  // over HTTPS (that URL is its TLS name), nor into a rebuild that asks for TLS -- which
  // `--email` does too, on the name the record holds (`resolveTls`).
  if (!req.rootUrl && !meta.publicUrl && !req.https && !req.domain && !req.acmeEmail) {
    req.rootUrl = String(meta.extra.advertised_url ?? '');
  }
}

/** Runtime x deployment x scenario, decided before anything else reads the request. */
export async function resolveAxesStep(plan: CreatePlan): Promise<void> {
  // An existing workspace's RECORDED runtime beats the flag default. Without this,
  // `houston up -v 8.5.1 --name X` on a Kubernetes workspace defaulted to docker and ran
  // `docker compose up` against a workspace with no compose file.
  //
  // Read BEFORE resolveAxes: it normalises an empty --runtime to "docker", after which
  // `!req.runtime` is never true and this could not fire.
  const existing = naming.deriveFor(plan.req);
  if (!plan.req.runtime && existing && (await paths.exists(existing))) {
    plan.req.runtime = await topology.ofRepro(existing);
  }
  await carryRecordedAxes(plan.req, existing);
  // No --preset at all: rebuild ITS presets (and their params, when no --set is given), not a
  // vanilla one that silently drops them. On Kubernetes dropping it re-installed Rocket.Chat
  // without the preset's settings while the preset's own objects stayed in the namespace; on
  // Compose a one-preset workspace was rebuilt vanilla, and the preset's volumes -- MinIO's,
  // holding every upload of an s3_minio workspace -- were then removed as left over. Only a
  // preset ASKED FOR replaces the recorded one.
  if (plan.req.preset === '' && existing && (await paths.exists(existing))) {
    try {
      const meta = await record.readMeta(existing);
      const composed = namesOf(meta.preset).length > 1;
      const kept = (meta.preset || 'default') !== 'default';
      if (kept) {
        plan.req.preset = meta.preset;
        if (Object.keys(plan.req.params).length === 0) {
          plan.req.params = composed
            ? qualifiedParams(bag(meta.extra.preset_params))
            : { ...bag(meta.extra.params) };
        }
        info(plan.emit, `'${existing}' is a ${meta.preset} workspace — keeping those presets`, {
          phase: 'plan',
        });
      }
    } catch {
      // a half-written record: nothing to keep
    }
  }
  const axes = topology.resolveAxes({
    runtime: plan.req.runtime,
    deployment: plan.req.deployment,
    replicas: plan.req.replicas,
    preset: plan.req.preset,
    params: plan.req.params,
  });
  topology.requireRegistered(axes.runtime);
  for (const hint of axes.hints) info(plan.emit, hint, { phase: 'plan' });
  plan.req.preset = axes.preset;
  plan.req.params = request.unqualifiedParams(axes.preset, axes.params);
  plan.req.runtime = axes.runtime;
  plan.req.deployment = axes.deployment;
  plan.req.replicas = axes.replicas;
  // ABOVE THE RUNTIME DISPATCH, deliberately: it started life below it, so `--root-url`
  // derived an IdP host on Compose and derived nothing at all on Kubernetes. Both runtimes
  // resolve the preset from `req.params`, so one call site above the fork covers both.
  request.deriveIdpHost(plan.req, plan.emit);
}

/** Which Rocket.Chat and which MongoDB, and whether this engine can run the pair. */
export async function resolvePairing(plan: CreatePlan): Promise<void> {
  await preconditions.requireDocker();
  plan.cfg = config.loadConfig();

  // HERE, where the release lookup has always gone online: after the engine preflight and
  // the name checks, not ahead of them.
  const fetcher = await request.releaseFetcher(
    plan.req.version,
    plan.req.offline,
    plan.versionFetcher,
  );
  try {
    plan.resolved = resolve(plan.req.version, {
      offline: plan.req.offline,
      ...(fetcher === undefined ? {} : { fetcher }),
    });
  } catch (error) {
    throw new ValidationError(errorText(error));
  }
  // SAID BEFORE THE BUILD, not discovered after it. `resolve()` already knows when
  // releases.rocket.chat answered 404 -- it stamps `source` -- and the create path ignored
  // it, so `up --version 99.99.99` built the whole compose document, created containers and
  // failed at the pull with docker's own "not found", ~90 seconds later.
  if (plan.resolved.source === 'map (no such release)') {
    warn(
      plan.emit,
      `releases.rocket.chat has no ${plan.req.version} — the pairing below ` +
        'comes from the shipped map, and the image pull will fail unless ' +
        `this tag really exists (\`houston versions ${plan.req.version}\`).`,
      { phase: 'resolve' },
    );
  }
  // The flag, then -- for a workspace rebuilt on the release it runs -- the image it was built
  // from, as a Kubernetes re-up keeps it: `--force` swapped an `--rc-image` for the default
  // repository's. Another release is another image, so that one is resolved afresh.
  const name = naming.deriveFor(plan.req);
  const before =
    name !== '' && (await paths.exists(name))
      ? await record.readMeta(name).catch(() => null)
      : null;
  const kept =
    before !== null && before.rcVersion === plan.resolved.rcVersion ? before.rcImage : '';
  request.chooseImage(plan.resolved, plan.req.rcImage || kept, plan.cfg.rc_image);
  if (plan.req.mongo) applyMongoOverride(plan.resolved, plan.req.mongo);

  // Before any docker work: this pairing cannot boot on this engine, and mongod says so by
  // exiting with a message that reads like a permission fault. The rule is a leaf; this
  // caller supplies the engine probe.
  const conflict = mongoKernelConflict(plan.resolved.mongoTag, await dockerKernelVersion());
  if (conflict) throw new PreflightError(conflict);
}

/**
 * The preset, its parameters, and whether this create has to wait for readiness. `ports` is
 * the workspace's side ports (`claimPorts` builds it again on the ones it was given); the
 * default, every preferred port, is what the ports are allocated FROM.
 */
export function loadPreset(plan: CreatePlan, ports: config.PortMap = {}): void {
  const names = namesOf(plan.req.preset);
  if (names.length > 1) {
    // Several presets: params routed to each, then one Preset merged from them. A key the
    // user sets with --env/--setting is theirs to decide when two presets disagree on it.
    const byPreset = request.paramsByPreset(names, plan.req.params);
    plan.presetParams = byPreset;
    plan.pre = presets.loadMany(
      names,
      byPreset,
      'docker',
      new Set(Object.keys(plan.req.env)),
      ports,
    );
    refuseEnforcedBefore880(plan.pre, plan.resolved?.rcVersion ?? '');
    refuseVoiceBefore800(plan.pre, plan.resolved?.rcVersion ?? '');
    plan.wait = plan.req.wait || plan.pre.postReady.length > 0 || plan.req.seed;
    return;
  }
  try {
    plan.pre = presets.load(plan.req.preset, plan.req.params, ports);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : String(error));
  }
  request.refuseUnknownParams(plan.req.params, plan.pre, plan.req.preset);
  refuseEnforcedBefore880(plan.pre, plan.resolved?.rcVersion ?? '');
  refuseVoiceBefore800(plan.pre, plan.resolved?.rcVersion ?? '');

  plan.wait = plan.req.wait || plan.pre.postReady.length > 0 || plan.req.seed;
}

/** The workspace's name, and every refusal that depends on having one. */
export async function settleName(plan: CreatePlan): Promise<void> {
  plan.reproName = naming.deriveFor(plan.req);
  naming.warnNameCoerced(plan.req, plan.emit);
  naming.announceName(plan.req, plan.reproName, plan.emit);
  // Before any docker work, and only for a workspace that does not exist yet: `up` on an
  // existing one reuses its containers and adds nothing.
  // `--force` is NOT a reason to skip this. `checkCapacity` has its own force branch that
  // warns loudly and proceeds -- written because "this is the guard that exists after an
  // OOM took out a 10 GB host: overriding it has to stay visible". Excluding force HERE
  // made that branch unreachable for a new workspace, so the loud override became a silent
  // one: the function was never called at all.
  if (!(await paths.exists(naming.deriveFor(plan.req)))) {
    await sizing.checkCapacity(plan.req, plan.req.preset, plan.emit);
  }
  if (!plan.reproName) {
    throw new ValidationError(
      `name '${plan.req.name}' contains no usable characters (want a-z, 0-9, '-')`,
    );
  }
  // sanitize() fixes the CHARACTERS but not the length, and the first thing below is a
  // stat on the derived path -- which throws ENAMETOOLONG rather than returning false for
  // an over-long name.
  naming.requireValidName(plan.reproName);
  if (plan.req.port && !(plan.req.port >= 1024 && plan.req.port <= 65535)) {
    throw new ValidationError(`--port ${String(plan.req.port)} is out of range (want 1024-65535)`);
  }
}

/**
 * Whether a workspace's recorded port is still its own to keep.
 *
 * `pickHostPort` skips the probe for a workspace's own recorded ports, which is right while
 * its containers hold them; a stopped workspace's port taken by something else since went
 * unnoticed until compose failed to bind it. So: free, or held by its own running Rocket.Chat.
 * ponytail: the front door only, a multi-instance replica port taken alone still fails at bind.
 */
async function stillOwnPort(name: string, port: number): Promise<boolean> {
  if (await portSeam.portFree(port)) return true;
  return ['running', 'restarting'].includes(await rcState(name));
}

/**
 * The side and monitoring ports, then the host port, the URL houston will call itself by, and
 * the TLS plan.
 */
export async function claimPorts(plan: CreatePlan): Promise<void> {
  await preconditions.guardProjectCollision(plan.reproName);
  // Preferred first; a port another workspace holds is given the next free one, and the record
  // keeps what this got. A rebuild keeps its own while its containers still hold them.
  const span = (plan.pre as Preset).instances > 1 ? (plan.pre as Preset).instances + 1 : 1;
  const claim = await ports.claimSidePorts(
    plan.reproName,
    plan.pre as Preset,
    (given) => {
      loadPreset(plan, given);
      return plan.pre as Preset;
    },
    {
      monitoring: plan.req.monitor ? ['prometheus', 'grafana'] : [],
      reserve: plan.req.port
        ? Array.from({ length: span }, (_, offset) => plan.req.port + offset)
        : [],
      // Free, or published by one of its own running containers. Rocket.Chat's state alone is not
      // enough: after a failed boot it is `created` while its own Mailpit still holds 8025.
      stillHeld: async (port) =>
        (await portSeam.portFree(port)) || (await engine.publishedPorts(plan.reproName)).has(port),
    },
  );
  plan.pre = claim.pre;
  plan.sidePorts = claim.side;
  plan.monitorPorts = claim.monitoring;
  for (const [whose, was, now] of claim.moved) {
    warn(
      plan.emit,
      `${whose}'s port ${String(was)} is no longer free, so '${plan.reproName}' publishes it ` +
        `on ${String(now)}`,
      { phase: 'plan' },
    );
  }
  const pre = claim.pre;
  const allocation = { ...pre, ports: [...pre.ports, ...plan.monitorPorts] };
  // A rebuild keeps its recorded port, as a Kubernetes re-up does: allocating afresh moved
  // it to the lowest free one (3301 to 3000), and every link to it went dead. Only while
  // nothing else has taken that port; then it gets a new one, as before.
  const was = plan.req.port
    ? 0
    : await record.readMeta(plan.reproName).then(
        (meta) => Number(meta.hostPort) || 0,
        () => 0,
      );
  const recorded = was !== 0 && (await stillOwnPort(plan.reproName, was)) ? was : 0;
  plan.hostPort = await ports
    .pickHostPort(plan.req.port || recorded, allocation, plan.reproName)
    .catch(async (error: unknown) => {
      if (recorded === 0 || !(error instanceof ConflictError)) throw error;
      return await ports.pickHostPort(0, allocation, plan.reproName);
    });
  // Said, not only shown in the new URL: every link to the old port stops working.
  if (was !== 0 && plan.hostPort !== was) {
    warn(
      plan.emit,
      `port ${String(was)} is no longer free, so '${plan.reproName}' moves to ` +
        `${String(plan.hostPort)}`,
      { phase: 'plan' },
    );
  }
  // ALWAYS the published local port, never an override. `--root-url` says what Rocket.Chat
  // should ADVERTISE, and it still does that through the compose spec below -- but `root`
  // is what houston calls itself, and Metadata's own docstring makes that a contract.
  //
  // Letting the override through broke that contract, and readiness is where it showed:
  // `ready` polls meta.rootUrl, so a workspace whose root_url held a public https name
  // reported "Rocket.Chat did not become ready within 300s" while /api/info on the local
  // port answered 200 the whole time.
  plan.bindHost = request.requestedBindHost(plan.req);
  // ...on the address the port is published on, which is loopback unless one other
  // address was asked for (`request.callHost`).
  plan.root = `http://${request.callHost(plan.bindHost)}:${String(plan.hostPort)}`;
  plan.token = plan.req.regToken || toText(plan.cfg.reg_token);
  plan.tlsspec = await tlsplan.resolveTls(
    plan.req,
    plan.reproName,
    plan.bindHost,
    plan.reproName,
    plan.emit,
  );
  // After the TLS decision, which the record can make too, and before
  // anything is written: `resolveTls` only reads, and certificates are issued later.
  await refuseNamesTheEdgeCannotReach(plan);
}

/**
 * Refuse, before any certificate or container, a name the HTTPS edge could not reach.
 *
 * The edge routes to CONTAINER names (`backendContainer`), and a name is a DNS label: 63
 * characters at most. A longer one does not resolve, so its route answers 502 while the
 * workspace looks healthy. A GUI workspace with five presets was named so: Mailpit and
 * Keycloak answered under their paths, phpLDAPadmin and the demo page answered Bad
 * Gateway. Rocket.Chat itself goes the same way past a 42-character name.
 */
export async function refuseNamesTheEdgeCannotReach(plan: CreatePlan): Promise<void> {
  if (plan.tlsspec === null) return;
  const pre = plan.pre as Preset;
  const routed = [
    ...compose.rcServiceNames(pre.instances),
    ...(plan.req.monitor ? ['grafana'] : []),
    ...publicPathsOf(withPublicUrl(pre, 'https://name.invalid', topology.DOCKER).extra).map(
      (p) => p.service,
    ),
  ];
  for (const service of routed) {
    const container = await backendContainer(plan.reproName, service);
    if (container.length <= DNS_LABEL_MAX) continue;
    const max = plan.reproName.length - (container.length - DNS_LABEL_MAX);
    throw new ValidationError(
      `'${plan.reproName}' is too long to serve over HTTPS: the edge reaches ${service} as ` +
        `${container}, ${String(container.length)} characters, and a DNS name holds ` +
        `${String(DNS_LABEL_MAX)}. Give it a shorter name: ` +
        `${naming.typedRoom(plan.req, plan.reproName, max)}.`,
    );
  }
}

/** The longest label a DNS name, and so a container the edge resolves, may have. */
const DNS_LABEL_MAX = 63;

/** What publishing this workspace off loopback exposes, said once, at create time. */
export function warnAboutTheBind(plan: CreatePlan): void {
  if (plan.req.bindPublic && plan.bindHost !== '0.0.0.0' && plan.bindHost !== '::') {
    // Derived from the challenge (see resolveTls), not requested.
    plan.bindHost = '0.0.0.0';
    warn(
      plan.emit,
      `binding 0.0.0.0 so Let's Encrypt can reach this host for the ` +
        `${plan.req.acmeChallenge} challenge - that exposes the workspace, and ` +
        'it runs the fixed admin/admin123 credentials. `houston down` when ' +
        'you are finished.',
      { phase: 'tls' },
    );
  } else if (!LOOPBACK_BINDS.includes(plan.bindHost)) {
    // THE SAME EXPOSURE, ASKED FOR RATHER THAN DERIVED, AND IT WAS SILENT. The warning
    // above fires only when houston widened the bind ITSELF for an ACME challenge; `up
    // --bind 0.0.0.0` typed by hand got the normal panel and nothing else.
    const side = plan.req.preset in PRESET_LINKS ? plan.req.preset : '';
    const sideText = side ? `${side}:${String(presetPort(side, 0, plan.sidePorts))}` : '';
    // WHAT THE PANEL DOES NOT ALREADY SAY, and nothing else. The Rocket.Chat admin is
    // generated for a workspace bound this wide and printed two lines below, so repeating
    // it here is a sentence people learn to scroll past.
    const weak: string[] = [];
    if (sideText) weak.push(`the ${plan.req.preset} UI on ${sideText}`);
    if (plan.req.monitor) weak.push('Grafana on admin/admin');
    if (plan.req.seed) weak.push('seeded users, whose password is their username');
    // The voice preset's PBX lab, alone or composed: read from what the create builds.
    if (plan.pre?.services.pbx !== undefined) {
      weak.push(
        "the PBX lab's softphone accounts, whose password is their number, and FreeSWITCH's " +
          'external SIP port 5080, which asks none',
      );
    }
    warn(
      plan.emit,
      `--bind ${plan.bindHost} publishes this workspace ` +
        (request.bindsEverywhere(plan.bindHost)
          ? 'on every interface'
          : `to everyone who can reach ${plan.bindHost}`) +
        (weak.length > 0 ? ` — and ${weak.join(', ')}` : '') +
        '. Only do this on a trusted network.',
      { phase: 'create' },
    );
  } else {
    // A PRESET'S OWN OPENING, on a loopback bind: voice publishes its call ports on every
    // address once voip_domain names one, so phones and browsers elsewhere reach them. Said as
    // a wide bind is, since nothing else at create said those ports left this machine.
    const opened = Object.values(plan.pre?.services ?? {})
      .flatMap((svc) => (Array.isArray(svc.ports) ? svc.ports.map(String) : []))
      .filter((port) => port.startsWith('0.0.0.0:'))
      .map((port) => {
        const rest = port.slice('0.0.0.0:'.length);
        const proto = rest.includes('/') ? rest.slice(rest.lastIndexOf('/')) : '';
        return `${rest.split(':')[0] ?? ''}${proto}`;
      });
    if (opened.length > 0) {
      warn(
        plan.emit,
        `voip_domain opens the call ports ${opened.join(', ')} on every interface` +
          (plan.pre?.services.pbx !== undefined
            ? " — and the PBX lab's softphone accounts, whose password is their number"
            : '') +
          `. Rocket.Chat itself stays on ${plan.bindHost}. Only do this on a trusted network.`,
        { phase: 'create' },
      );
    }
  }
  // RC advertises the https URL (links, OAuth callbacks, CORS all derive from ROOT_URL);
  // `root` stays http so houston's own API calls need no CA.
}

/**
 * On Podman, a hosts line the notes ask for reaches the workspace's own containers too.
 *
 * Podman copies this machine's /etc/hosts into every container, so following houston's own
 * advice -- `127.0.0.1 minio`, `127.0.0.1 keycloak` -- made `minio-init` and Rocket.Chat
 * resolve those names to their OWN loopback: the bucket was never created and every upload
 * failed `ECONNREFUSED 127.0.0.1:9000`. Docker gives containers their own DNS and is not
 * affected. Said where the advice is given, with the way round that needs no hosts line.
 */
export async function warnAboutHostsOnPodman(plan: CreatePlan): Promise<void> {
  const asks = (plan.pre as Preset).notes.some((line) => line.includes('/etc/hosts'));
  if (!asks || (await hostEngine())?.kind !== 'podman') return;
  warn(
    plan.emit,
    "Podman copies this machine's /etc/hosts into every container, so the hosts line the " +
      "notes ask for would make the workspace's own services resolve those names to " +
      'themselves (a bucket never created, an IdP Rocket.Chat cannot reach). On Podman add ' +
      "no hosts line: give the browser this host's address instead, with " +
      '`--set idp_host=<address>` or `--set s3_host=<address>`.',
    { phase: 'create' },
  );
}

/** An IdP preset whose own service still names the BROWSER's machine, not this one. */
export function warnAboutTheBrowserHost(plan: CreatePlan): void {
  plan.public = plan.tlsspec === null ? '' : tlsRootUrl(plan.tlsspec);
  // SAID AT CREATE TIME, because it cannot be discovered afterwards. The IdP presets send
  // the BROWSER to a hostname baked into Rocket.Chat's settings, and the default names
  // this machine -- `localhost:8081` for SAML, `keycloak:8085` for OIDC. From anywhere
  // else both of those addresses are the visitor's own laptop: the SAML button bounces
  // off nothing and returns to the login page, and the OIDC popup opens a name that does
  // not resolve and renders blank.
  // EACH MEMBER of a set: looked up by the combined name (`email+saml`), this never fired
  // for a combination, while `doctor` (which reads the members) did.
  //
  // NOT OVER HTTPS: there the browser reaches Keycloak at <name>/keycloak/ and Rocket.Chat
  // proxies downloads (`withPublicUrl`), so neither address below is the browser's to
  // follow; presigned links over HTTPS have a warning of their own.
  if (plan.tlsspec !== null) return;
  const names = namesOf(plan.req.preset);
  const presigned = plan.pre?.env.OVERWRITE_SETTING_FileUpload_S3_Proxy_Uploads === 'false';
  for (const name of names) {
    const browserParam = BROWSER_HOST_PARAM[name];
    if (browserParam === undefined) continue;
    // MinIO only in presigned mode: in the default proxy mode the browser never reaches it.
    if (name === 's3_minio' && !presigned) continue;
    const key = names.length > 1 ? `${name}.${browserParam}` : browserParam;
    if (isTruthy(plan.req.params[key]) || isTruthy(plan.req.params[browserParam])) continue;
    warnAboutOneBrowserHost(plan, name, key);
  }
}

/** The warning for one IdP-style member whose service still names the browser's machine. */
function warnAboutOneBrowserHost(plan: CreatePlan, preset: string, key: string): void {
  const defaultHost: Record<string, string> = {
    saml: 'localhost',
    oidc: 'keycloak',
    s3_minio: 'minio',
  };
  const servicePort = presetPort(preset, 0, plan.sidePorts);
  const advertised = plan.req.rootUrl || plan.req.domain;
  let why = '';
  if (!LOOPBACK_BINDS.includes(plan.bindHost)) {
    why =
      `this '${preset}' workspace is bound to ${plan.bindHost}, so ` +
      'somebody will open it from another machine';
  } else if (advertised) {
    // DELIBERATELY NOT DERIVED. Pointing the service at {advertised} while its port is on
    // loopback would break Rocket.Chat's own access to it as well -- measured: a container
    // cannot reach a 127.0.0.1-published port by the host's address.
    why =
      `this '${preset}' workspace advertises ${advertised}, but its ` +
      `ports are published on ${plan.bindHost || config.DEFAULT_BIND_HOST} ` +
      'where nothing off this box can reach them';
  }
  if (why) {
    warn(
      plan.emit,
      `${why} — and its own service still points the browser at ` +
        `${defaultHost[preset] ?? ''}:${String(servicePort)}, which names that browser's OWN ` +
        'machine. SAML returns to the login page, OIDC opens a blank ' +
        'window, presigned previews fail. None of them logs an error.',
      { phase: 'create' },
    );
    warn(
      plan.emit,
      '    Both halves have to move. Re-create with:\n' +
        `      --bind 0.0.0.0 --port ${String(plan.hostPort)} ` +
        `--root-url http://<host>:${String(plan.hostPort)} ` +
        `--set ${key}=<host>\n` +
        '    where <host> is the name people actually type.',
      { phase: 'create' },
    );
  }
}

/** Carried-forward env, the admin password, and the compose document itself. */
export async function buildDocument(plan: CreatePlan): Promise<void> {
  // Overrides already on this repro are carried forward: `up --force` rebuilds the compose
  // file from the spec, so without this a rebuild would silently drop env the user had
  // set. Anything named on THIS run wins.
  plan.envOverrides = {};
  plan.previousMeta = null;
  if (await paths.exists(plan.reproName)) {
    try {
      plan.previousMeta = await record.readMeta(plan.reproName);
      const prev = bag(plan.previousMeta.extra.env);
      plan.envOverrides = { ...(prev as Record<string, string | null>) };
    } catch {
      // half-written record; nothing to carry
    }
  }
  Object.assign(plan.envOverrides, plan.req.env);

  // THE ADMIN PASSWORD, decided here because this is where both halves of "reachable from
  // off this box" are finally known. Generated for a public workspace and left empty --
  // meaning the shared `admin123` -- for a loopback one. A rebuild that keeps the data keeps
  // the password its database holds; `--fresh` empties the database, so it gets a new one.
  const kept = plan.req.fresh ? null : await record.keptAdminPassword(plan.reproName);
  const reachable = preconditions.reachableBeyondLoopback({
    tlsspec: plan.tlsspec,
    bindHost: plan.bindHost,
  });
  plan.adminPassword = kept ?? (reachable ? config.generateAdminPassword() : '');
  const shared = request.keptSharedPasswordWarning(plan.reproName, kept, reachable);
  if (shared !== '') warn(plan.emit, shared, { phase: 'create' });
  const resolved = plan.resolved as Resolved;
  // A directory served over LDAPS or StartTLS gets houston's certificate here, before the
  // document that mounts it is built.
  if ((plan.pre as Preset).extra.directory_tls !== undefined) {
    plan.pre = withCertificate(
      plan.pre as Preset,
      await tlsplan.issueDirectoryCertificate(directoryHost((plan.pre as Preset).extra)),
      topology.DOCKER,
    );
  }
  // Over HTTPS a preset's own UIs (Mailpit, Keycloak, the demo page) are served at paths of
  // the workspace's name, as Grafana is; the edge routes them (`registerTheName`).
  if (plan.tlsspec !== null) {
    plan.pre = withPublicUrl(plan.pre as Preset, tlsRootUrl(plan.tlsspec), topology.DOCKER);
    const presigned = presignedOverHttps(plan.pre);
    if (presigned) warn(plan.emit, presigned, { phase: 'tls' });
  }
  plan.spec = compose.spec({
    projectName: await record.projectName(plan.reproName),
    rcImage: resolved.rcImage,
    rcTag: resolved.rcVersion,
    mongoTag: resolved.mongoTag,
    mongoFlavor: resolved.mongoFlavor,
    mongoShell: resolved.mongoShell,
    oplog: resolved.oplog,
    rootUrl: plan.req.rootUrl || plan.public || plan.root,
    publicUrl: plan.public,
    hostPort: plan.hostPort,
    regToken: plan.token || null,
    // This run's licence, or the one an earlier `up --license` left: `up --force` keeps it.
    licensed:
      plan.req.license !== '' ||
      (await fs.stat(joinPath(paths.workspace(plan.reproName), compose.LICENSE_ENV_FILE)).then(
        () => true,
        () => false,
      )),
    preset: plan.pre as Preset,
    bindHost: plan.bindHost,
    monitoring: plan.req.monitor,
    monitorPorts: plan.monitorPorts,
    envOverrides: plan.envOverrides,
  });
  plan.spec.adminPassword = plan.adminPassword;
  const premium = request.premiumAuthWarning(
    [(plan.pre as Preset).name],
    resolved.rcVersion,
    plan.spec.licensed,
    plan.token,
  );
  if (premium !== '') warn(plan.emit, premium, { phase: 'create' });
  const voice = request.voiceLicenceWarning(
    [(plan.pre as Preset).name],
    plan.spec.licensed,
    plan.token,
  );
  if (voice !== '') warn(plan.emit, voice, { phase: 'create' });
  const samlEmail = request.samlEmailWarning(
    plan.pre as Preset,
    resolved.rcVersion,
    new Set(Object.keys(plan.envOverrides)),
  );
  if (samlEmail !== '') warn(plan.emit, samlEmail, { phase: 'create' });
  try {
    plan.doc = compose.build(plan.spec);
  } catch (error) {
    // e.g. a preset naming an entry_service it doesn't define.
    throw new ValidationError(error instanceof Error ? error.message : String(error));
  }
}

/** `repro.json`: everything a later command needs that the compose file does not say. */
export function buildRecord(plan: CreatePlan): void {
  const resolved = plan.resolved as Resolved;
  const pre = plan.pre as Preset;
  const spec = plan.spec as compose.Spec;
  plan.meta = record.metadata({
    name: plan.reproName,
    project: spec.projectName,
    rcVersion: resolved.rcVersion,
    rcImage: resolved.rcImage,
    mongoTag: resolved.mongoTag,
    mongoFlavor: resolved.mongoFlavor,
    preset: pre.name,
    rootUrl: plan.root,
    hostPort: plan.hostPort,
    versionSource: resolved.source,
    // A rebuilt workspace stays pinned, as on Kubernetes: `--force` unpinned it, and the
    // next `prune` would have deleted it.
    pinned: plan.req.pin || isTruthy(plan.previousMeta?.pinned),
    publicUrl: plan.public,
    adminPassword: plan.adminPassword,
    // Kept by a `--force` rebuild, which keeps the data; `--fresh` starts it again.
    createdAt:
      (!plan.req.fresh && plan.previousMeta?.createdAt) ||
      new Date().toISOString().slice(0, 19) + '+00:00',
  });
  // Stamped on every create, compose included, so "absent" keeps meaning exactly one
  // thing: a workspace older than the key.
  topology.stamp(plan.meta.extra, plan.req.runtime || topology.DOCKER);
  plan.meta.extra[config.EXTRA_DEPLOYMENT] = plan.req.deployment || topology.MONOLITH;
  // Recorded so a reader can be told the truth about reaching this workspace from another
  // machine. It was only ever written INTO the compose port mappings.
  plan.meta.extra.bind_host = plan.bindHost;
  // WHAT ROCKET.CHAT ADVERTISES, when that is not what houston calls it. `rootUrl` on the
  // record is deliberately the plain loopback URL that houston's own API calls use, and
  // `publicUrl` is set only by TLS -- so `--root-url http://box:3007` was written into the
  // compose ROOT_URL and recorded nowhere, and anything generated FOR THE BROWSER then got
  // loopback.
  if (spec.rootUrl && spec.rootUrl !== plan.root) {
    plan.meta.extra.advertised_url = spec.rootUrl;
  }
  if (pre.postReady.length > 0) plan.meta.extra.post_ready = pre.postReady;
  if (pre.notes.length > 0) plan.meta.extra.notes = pre.notes;
  if (pre.instances > 1) plan.meta.extra.instances = pre.instances;
  if (Object.keys(pre.extra).length > 0) Object.assign(plan.meta.extra, pre.extra);
  if (pre.ports.length > 0) plan.meta.extra.sidecar_ports = pre.ports;
  // Only what moved: a workspace on the preferred ports reads as every earlier one does.
  if (Object.keys(plan.sidePorts).length > 0) plan.meta.extra.side_ports = plan.sidePorts;
  if (Object.keys(plan.envOverrides).length > 0) plan.meta.extra.env = plan.envOverrides;
  if (spec.licensed) plan.meta.extra.licensed = true;
  if (plan.req.actor) {
    // Who owns this. Shown by `list` and the GUI card.
    plan.meta.extra.created_by = plan.req.actor;
  }
  if (plan.presetParams !== null) {
    // A composed workspace: `preset` stays ONE string (`email+ldap`), which earlier releases
    // refuse loudly as a preset name rather than silently building one of the presets; the
    // list and each preset's params ride in `extra`, which every release keeps.
    plan.meta.extra.presets = namesOf(pre.name);
    plan.meta.extra.preset_params = structuredClone(plan.presetParams);
  } else if (Object.keys(plan.req.params).length > 0) {
    // Recorded so a repro can be rebuilt exactly: `backup` copies these into its manifest,
    // and `restore --new` would otherwise recreate an s3_minio repro with the DEFAULT
    // bucket rather than the one whose data it is loading.
    plan.meta.extra.params = { ...plan.req.params };
  }
  ownership.carryOwnership(plan.previousMeta, plan.meta);
}

/** Prometheus and Grafana, when asked for. */
export function attachMonitoring(plan: CreatePlan): void {
  if (!plan.req.monitor) return;
  const meta = plan.meta as record.Metadata;
  const targets = compose.rcServiceNames((plan.pre as Preset).instances);
  plan.files.push(...monitoringFiles(targets, (plan.spec as compose.Spec).projectName));
  meta.extra.monitoring = true;
  meta.extra.monitoring_ports = [...plan.monitorPorts];
  const notes = Array.isArray(meta.extra.notes) ? [...meta.extra.notes] : [];
  meta.extra.notes = [
    ...notes,
    ...monitoringNotes(
      monitoringGrafanaUrl(plan.public, !!plan.public, record.grafanaPortOf(meta)),
      record.prometheusPortOf(meta),
    ),
  ];
}

/** Where each MongoDB image family keeps its data inside the shared `mongodb_data` volume. */
const MONGO_DATA_DIR: Readonly<Record<string, string>> = {
  'bitnami-legacy': '/bitnami/mongodb',
  official: '/data/db',
};

/**
 * A rebuild that would change the MongoDB image FAMILY under the same volume. Bitnami keeps
 * its data in /bitnami/mongodb and the official image in /data/db, so the new mongod finds an
 * empty directory and Rocket.Chat boots on a blank database. The data is still in the volume,
 * where nothing reads it. Refused unless `--fresh` says an empty database is what is wanted.
 */
export async function refuseMongoFamilyChange(plan: CreatePlan): Promise<void> {
  if (plan.req.fresh || !(await paths.exists(plan.reproName))) return;
  let meta: record.Metadata;
  try {
    meta = await record.readMeta(plan.reproName);
  } catch {
    return; // half-written record: no data to protect
  }
  if (topology.ofMeta(meta) !== topology.DOCKER || meta.mongoTag === '') return;
  const was = meta.mongoFlavor || mongoFlavorOf(meta.mongoTag);
  const resolved = plan.resolved as Resolved;
  if (was === resolved.mongoFlavor) return;
  const name = plan.reproName;
  throw new ConflictError(
    `'${name}' keeps its data in MongoDB ${meta.mongoTag} (${was}, ` +
      `${MONGO_DATA_DIR[was] ?? was}); this rebuild would start MongoDB ${resolved.mongoTag} ` +
      `(${resolved.mongoFlavor}, ${MONGO_DATA_DIR[resolved.mongoFlavor] ?? resolved.mongoFlavor}) ` +
      'on the same volume, which finds no data there, so Rocket.Chat would boot on an empty ' +
      `database. To carry the data across: houston backup --name ${name}, then ` +
      `houston up --version ${resolved.rcVersion} --name ${name}-new, then houston restore ` +
      `<bundle> --name ${name}-new --allow-upgrade. Or add --fresh to rebuild it empty.`,
  );
}

/** Taking down what is already there, and the gate on destroying its data. */
export async function replaceExisting(plan: CreatePlan): Promise<void> {
  if (!(await paths.exists(plan.reproName))) return;
  // `--fresh` DELETES THE DATA VOLUME, which is the same irreversible act `down --volumes`
  // is gated on -- and this branch consulted nobody. Checked only for `--fresh`: a plain
  // overwrite recreates containers and leaves the volume alone.
  if (plan.req.fresh) {
    const [allowed, why] = await ownership.mayDestroy(plan.reproName, auditActor());
    if (!allowed) {
      auditRecord('up-fresh', plan.reproName, { outcome: 'denied' });
      throw new ConflictError(why);
    }
    // And when it goes ahead: only the refusals were recorded, so a wiped database had no
    // trace of who wiped it.
    auditRecord('up-fresh', plan.reproName);
  }
  // Volumes the OLD compose file declared but the new one doesn't (switching preset with
  // --force, dropping --monitor) would be orphaned: `down -v` only removes what the file
  // declares, so once it's rewritten nothing can ever reach them again.
  let stale: string[] = [];
  if (!plan.req.fresh) {
    try {
      const oldDoc = await record.readCompose(plan.reproName);
      const oldVolumes = new Set(Object.keys(bag(oldDoc.volumes)));
      const newVolumes = new Set(Object.keys((plan.doc as compose.ComposeDoc).volumes));
      stale = [...oldVolumes].filter((name) => !newVolumes.has(name));
    } catch {
      // unreadable old file: nothing to reconcile
      stale = [];
    }
  }
  if ((await engine.down(plan.reproName, { volumes: plan.req.fresh })) !== 0) {
    throw new DockerError(
      `could not tear down the existing '${plan.reproName}'; not overwriting it`,
    );
  }
  if (stale.length > 0) {
    // SAID AND RECORDED: these hold the data of a preset this rebuild was asked to drop.
    warn(
      plan.emit,
      `removing ${stale.sort().join(', ')}: the data of what '${plan.reproName}' no longer ` +
        'has, which nothing could reach once its compose file is rewritten',
      { phase: 'create' },
    );
    auditRecord('volumes-removed', plan.reproName);
  }
  for (const bad of await removeVolumes(plan.reproName, stale.sort())) {
    warn(plan.emit, `could not remove ${bad}, left over from the previous preset`, {
      phase: 'create',
    });
  }
}

/**
 * This run's licence into the workspace's env file, which the compose document names and never
 * holds. 0600 from the first byte, in the 0700 workspace; a dotfile, so `backup` leaves it out.
 */
export async function writeLicense(plan: CreatePlan): Promise<void> {
  if (plan.req.license === '') return;
  const file = joinPath(paths.workspace(plan.reproName), compose.LICENSE_ENV_FILE);
  await fs.writeFile(file, `ROCKETCHAT_LICENSE=${plan.req.license}\n`, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

/** Publish the full allocation and generated files while the port lock is held. */
export async function writeTheWorkspace(plan: CreatePlan): Promise<void> {
  const meta = plan.meta as record.Metadata;
  await record.write(
    plan.reproName,
    compose.toYaml(compose.forEngine(plan.doc as compose.ComposeDoc, await hostEngine())),
    meta,
    plan.files,
    new Set((plan.pre as Preset).keepFiles ?? []),
  );
  await writeLicense(plan);
}

/** Bring up a published workspace, then attach the edge. */
export async function startTheWorkspace(
  plan: CreatePlan,
  { recordWritten = false }: { recordWritten?: boolean } = {},
): Promise<void> {
  const resolved = plan.resolved as Resolved;
  if (!recordWritten) await writeTheWorkspace(plan);
  if (plan.req.pin) {
    await updateLockedConfig((cfg) => {
      cfg.default_repro = plan.reproName;
    });
  }

  info(
    plan.emit,
    `creating '${plan.reproName}' - RC ${resolved.rcVersion}, ` +
      `Mongo ${resolved.mongoTag} (${resolved.mongoFlavor}), ` +
      `preset ${presetsLabel((plan.pre as Preset).name)}`,
    // Nested, as it always has been: the event's detail is ONE key named `data`, so it is
    // `{"data": {"name": ...}}` on the NDJSON stream and in houston.log. `jsonout` calls
    // removing a key breaking, so the wire keeps the established shape.
    { phase: 'create', data: { data: { name: plan.reproName } } },
  );

  const rc = await upCompose(plan.reproName, {
    pull: !plan.req.noPull,
    emit: plan.emit,
    streamOutput: plan.streamOutput,
  });
  if (rc !== 0) {
    const cause = await diagnoseFailure(plan.reproName);
    const head = cause ? `\`docker compose up\` failed - ${cause}` : '`docker compose up` failed.';
    throw new DockerError(
      `${head} Workspace kept for inspection - retry with --force, or discard: ` +
        `houston down --name ${plan.reproName} --volumes`,
    );
  }

  // AFTER the workspace is up, because attaching needs the network `docker compose up` has
  // only just created. Registering during the build wrote a correct route to a backend the
  // edge could not resolve, so the name answered 502 -- and 502 is not an error anyone
  // sees, it just looks like a broken workspace. Idempotent: register() attaches too.
  if (plan.tlsspec !== null) {
    await attach(plan.reproName);
  }
}

/** The summary the caller gets back, plus waiting and seeding when asked. */
export async function finish(plan: CreatePlan): Promise<Bag> {
  const meta = plan.meta as record.Metadata;
  const result = await inspect.summary(meta);
  result.reused = false;
  result.waited = plan.wait;
  if (plan.wait) Object.assign(result, await waitAndFinalize(meta, plan.emit));
  // NOT when the caller seeds, for the reason `reuse` records.
  if (plan.req.seed && !plan.req.seedHere) {
    result.seed = await seeding.runSeedInline(
      meta,
      plan.req.seedProfile,
      plan.req.stats,
      plan.emit,
      { scenarios: plan.req.seedScenarios, historyDays: plan.req.seedHistoryDays },
    );
  }
  return result;
}

/** An edge belonging to another HOUSTON_HOME, refused before anything is written. */
export async function refuseAForeignEdge(): Promise<void> {
  // REFUSED BEFORE ANYTHING IS WRITTEN. `edge.up()` checks `foreignEdge()` -- an edge
  // belonging to a DIFFERENT HOUSTON_HOME, which compose would silently replace because
  // every home keys the project by the same name -- and it did so only after the local CA,
  // the certificate, the route file and the whole edge project had been written.
  const stolen = await foreignEdge();
  if (stolen) {
    const home = stolen.replace(/\/edge\/?$/u, '');
    throw new ConflictError(
      `the shared edge on this machine belongs to another houston home (${home}), usually ` +
        'houston run with sudo or as another user. Starting one from here would REPLACE it ' +
        'and take down every https name it serves, because compose keys the project by name ' +
        `and both homes use the same one. Run this the same way (or with HOUSTON_HOME=${home}), ` +
        'or stop that edge first.',
    );
  }
}

/** A local certificate, or the private directory Traefik needs before it mounts it. */
export async function issueCertificate(plan: CreatePlan, local: boolean): Promise<void> {
  const tlsspec = plan.tlsspec;
  if (tlsspec === null) return;
  if (local) {
    info(plan.emit, `issuing a local certificate for ${tlsspec.host}`, { phase: 'tls' });
    await issueLocalCert(tlsspec.host);
  } else {
    // Traefik writes acme.json here; it must exist and be private BEFORE the container
    // mounts it, or Traefik refuses to use it.
    await fs.mkdir(acmeDir(), { recursive: true });
    await fs.chmod(acmeDir(), 0o700);
  }
}

/** Started lazily, by the first workspace that needs a name -- never at install or by `serve`. */
export async function startTheEdge(plan: CreatePlan, local: boolean): Promise<void> {
  const tlsspec = plan.tlsspec;
  if (tlsspec === null) return;
  // Started HERE, not in resolveTls. Lazily, by the first workspace that needs a name --
  // not at install, not by `serve`, since whether the GUI has a public hostname is an
  // unrelated question. It has to happen where docker work legitimately happens, though:
  // putting it in resolveTls made a resolve function start containers, and the TEST SUITE
  // then started a real edge that held :443 and broke a live run. A running edge whose
  // challenge `acme.challenge` has since changed goes through it too: skipped here, the
  // change never reached the container (measured behind a tunnel: TLS-ALPN kept).
  if (!(await edgeRunning()) || (!local && (!hasAcme() || challengeStale()))) {
    info(plan.emit, 'starting the edge (one Traefik, :80 and :443 for every name)', {
      phase: 'tls',
    });
    const started = await ensureRunning({
      acmeEmail: local ? '' : tlsspec.acmeEmail,
      acmeStaging: tlsspec.acmeStaging,
    });
    if (!started.ok) {
      const holder = await portHolder(443);
      const because = holder
        ? ` — ${holder} is holding :443`
        : started.why
          ? ` — ${started.why}`
          : '';
      warn(
        plan.emit,
        `the edge did not start${because}, so ${tlsspec.host} will ` +
          'not answer yet. The workspace itself is unaffected; free ' +
          'the port and `houston edge start`.',
        { phase: 'tls' },
      );
    }
  }
}

/** The route, and the certificate request it may or may not imply. */
export async function registerTheName(plan: CreatePlan, local: boolean): Promise<void> {
  const tlsspec = plan.tlsspec;
  if (tlsspec === null) return;
  const needsCert = await registerRoute(plan.reproName, tlsspec.host, {
    instances: (plan.pre as Preset).instances || 1,
    local,
    grafana: plan.req.monitor,
    publicPaths: publicPathsOf((plan.pre as Preset).extra),
  });
  if (local) {
    // nothing further: the certificate was issued above
  } else if (needsCert) {
    // No reachability checks. Whether the domain resolves here, and how traffic gets to
    // this host, is the operator's business -- houston cannot see a tunnel, a
    // port-forward or a firewall from in here.
    info(
      plan.emit,
      `requesting a certificate from Let's Encrypt ` +
        `(${tlsspec.acmeStaging ? 'staging' : 'production'}) ` +
        `for ${tlsspec.host}, which must resolve to the machine running houston — the edge ` +
        'does this in the background; ' +
        `confirm with \`houston tls-status -n ${plan.reproName}\``,
      { phase: 'tls' },
    );
    // Counted BEFORE the warning, so the name being created is included -- the useful
    // number is "after this one", not "before it".
    recordIssuance(tlsspec.host);
    const budget = budgetWarning(tlsspec.host);
    if (budget) warn(plan.emit, budget, { phase: 'tls' });
  } else {
    info(
      plan.emit,
      // The wildcard is a CERTIFICATE; it was read as a DNS record, which it is not.
      `registering ${tlsspec.host} — the edge's wildcard certificate covers it, no ` +
        'certificate request; the name must still resolve to the machine running houston ' +
        '(one wildcard DNS record covers every such name)',
      {
        phase: 'tls',
      },
    );
  }
}

/** What the record has to say so `tls-status` and the panel can tell the truth. */
export function recordTls(plan: CreatePlan, local: boolean): void {
  const tlsspec = plan.tlsspec;
  const meta = plan.meta;
  if (tlsspec === null || meta === null) return;
  meta.extra.tls = tlsspec.mode;
  meta.extra.edge = true;
  // Deliberately NO tls_ports: usedPorts() feeds port allocation, and claiming a port this
  // workspace does not publish would make every later workspace route around one it never
  // held.
  if (!local) {
    meta.extra.tls_staging = tlsspec.acmeStaging;
    meta.extra.tls_email = tlsspec.acmeEmail;
  }
  const notes = Array.isArray(meta.extra.notes) ? [...meta.extra.notes] : [];
  meta.extra.notes = [
    ...notes,
    `served by the edge at https://${tlsspec.host}`,
    'the edge holds :443 for the whole box; this workspace publishes none',
  ];
}

/** The shared Traefik edge: refuse a foreign one, get a certificate, route the name. */
export async function prepareEdge(plan: CreatePlan): Promise<void> {
  plan.files = [...(plan.pre as Preset).files];
  if (plan.tlsspec === null) return;
  // ONE path, whether the name is a real domain or a .houston.localhost one. The only
  // difference is where the certificate comes from, and that is the edge's business -- so
  // no tls/ files are written here, no port is claimed, and nothing about this workspace's
  // containers depends on it.
  const local = plan.tlsspec.mode === MODE_LOCAL;
  await refuseAForeignEdge();
  await issueCertificate(plan, local);
  await startTheEdge(plan, local);
  await registerTheName(plan, local);
  recordTls(plan, local);
}

/**
 * A name is one workspace, on one runtime. 8.5.1 on Docker and then 8.5.1 on Kubernetes
 * derived the same name, and each runtime took the other's workspace for its own to bring
 * back: Kubernetes rewrote the Docker record and left its containers running with nothing
 * pointing at them, and Docker ran `compose up` on a workspace with no compose file.
 * Refused before anything is written, `--force` included. A record that cannot be read is
 * left to the existence checks downstream, as it always was.
 */
export async function refuseTheOtherRuntime(req: CreateReq): Promise<void> {
  const name = naming.deriveFor(req);
  if (!name || !(await paths.exists(name))) return;
  let was: string;
  try {
    was = topology.ofMeta(await record.readMeta(name));
  } catch {
    return;
  }
  if (was === req.runtime) return;
  throw new ConflictError(
    `'${name}' is already a ${topology.label(was)} workspace. A ${topology.label(req.runtime)} ` +
      'one needs its own name (Name in the dialog, or --name), or delete this one first: ' +
      `\`houston down --name ${name} --volumes\`.`,
  );
}

/**
 * The Compose create, as a plan and the steps that fill it in.
 *
 * The ORDER below is the specification. Each step's own docstring and comments say why it
 * sits where it does; several of them record a defect caused by sitting somewhere else.
 */
export async function createReproLocked(
  req: CreateReq,
  emit: Emit = nullEmit,
  {
    streamOutput = false,
    monitorAttach = request.missingMonitorAttach,
    versionFetcher,
  }: {
    streamOutput?: boolean;
    monitorAttach?: createK8s.MonitorAttach;
    versionFetcher?: ReleaseFetcher;
  } = {},
): Promise<Bag> {
  const plan = createPlan({
    req,
    emit,
    streamOutput,
    monitorAttach,
    ...(versionFetcher === undefined ? {} : { versionFetcher }),
  });
  // Before anything, on either runtime: the format check is also what keeps the licence to
  // one line of the env file it is written to.
  if (req.license !== '') req.license = request.requireLicense(req.license);
  await resolveAxesStep(plan);
  // THE NAME RESOLVING SETTLED ON is the one locked and asked about. `--deployment
  // multi-instance` and a kept set of presets rename a derived name after the caller locked
  // it, so the create held one name, asked who owned it, and built another: a member rebuilt
  // a workspace handed to somebody else, and nothing kept a `down` or a second create off it.
  // Re-entrant, so the name the caller already holds costs nothing.
  return await reproLock(naming.deriveFor(req), async () => await createSettled(plan));
}

/** The create, once its name is settled and held. */
async function createSettled(plan: CreatePlan): Promise<Bag> {
  const { req, emit } = plan;
  // AGAIN UNDER THE LOCK, on either runtime: `claimTypedName` looked before it, and a
  // hand-over while this request waited would have it rebuild somebody else's workspace.
  // Whatever name it derives, not only an exact one: a member's own prefix (`bob-x`) is
  // somebody else's once it is handed over, and a create there starts, pins or rebuilds it.
  // A name nothing holds yet has no owner, so a new workspace always passes.
  const [allowed, why] = await ownership.mayDestroy(naming.deriveFor(req), auditActor());
  if (!allowed) throw new ConflictError(why);
  if (req.bringBack && !(await paths.exists(naming.deriveFor(req)))) {
    throw new NotFoundError(
      `'${naming.deriveFor(req)}' was deleted while this waited its turn, so there is nothing ` +
        'to bring up - create it again instead',
    );
  }
  await refuseTheOtherRuntime(req);

  if (req.runtime === topology.KUBERNETES) {
    // A PARALLEL path, not a branch woven through this function. Everything below is
    // compose-shaped -- host ports, a compose document, `docker compose up` -- and two
    // front-ends depend on it behaving exactly as it does. Handing Kubernetes off here
    // keeps the Docker default byte-identical and puts the Kubernetes sequence in the
    // module that owns it.
    //
    // TLS is refused rather than ignored. `resolveTls` runs BELOW this line, so `--https`
    // on a Kubernetes workspace did nothing at all and said nothing about it.
    preconditions.refuseUnsupportedOnKubernetes(req);
    return await createKubernetes(req, emit, {
      monitorAttach: plan.monitorAttach,
      ...(plan.versionFetcher === undefined ? {} : { versionFetcher: plan.versionFetcher }),
    });
  }
  await resolvePairing(plan);
  loadPreset(plan);
  await settleName(plan);

  if ((await paths.exists(plan.reproName)) && !plan.req.force && !plan.req.fresh) {
    return await reuse(plan.reproName, plan.wait, plan.req, plan.emit, {
      streamOutput: plan.streamOutput,
      resolved: plan.resolved,
      presetName: (plan.pre as Preset).name,
      typedParams: plan.typedParams,
    });
  }
  await refuseMongoFamilyChange(plan);
  await ports.withPortPublication(async () => {
    await claimPorts(plan);
    warnAboutTheBind(plan);
    warnAboutTheBrowserHost(plan);
    await buildDocument(plan);
    await warnAboutHostsOnPodman(plan);
    await preconditions.refuseHealthWaitsTheEngineCannotRun(
      plan.doc as compose.ComposeDoc,
      plan.req.force,
      plan.emit,
    );
    buildRecord(plan);
    await prepareEdge(plan);
    attachMonitoring(plan);
    await replaceExisting(plan);
    await writeTheWorkspace(plan);
  });
  await startTheWorkspace(plan, { recordWritten: true });
  return await finish(plan);
}
