/**
 * Creating a workspace on Kubernetes.
 *
 * Tier 5. The Kubernetes half of create, split from the Compose half because the two share a
 * request and almost nothing else: this one talks to a cluster that may not exist yet, has no
 * compose file to write, and publishes a name through an ingress rather than a port.
 *
 * Like the Compose half, this is a PLAN plus named steps rather than one function. The
 * order carries decisions that each cost a real defect to learn -- the write-ahead record
 * before any cluster resource exists, the cluster chosen before a byte is written, the
 * core tools checked before a kind cluster is built. The order is visible at the bottom.
 */
import * as fs from 'node:fs/promises';

import * as config from '../../lib/config';
import { joinPath } from '../../lib/home';
import { toText } from '../../lib/format';
import {
  ConflictError,
  PreflightError,
  ReproError,
  ValidationError,
  errorText,
} from '../../lib/errors';
import { type Emit, NOTHING_LEFT, info, nullEmit, warn } from '../../lib/events';
import * as presets from '../../lib/presets/index';
import { compositeName, namesOf } from '../../lib/presets/composite';
import { directoryHost, withCertificate } from '../../lib/presets/ldap';
import { presignedOverHttps, withPublicUrl } from '../../lib/presets/public';
import { type Preset } from '../../lib/presets/types';
import { parseVersion } from '../../lib/version-spec';
import {
  BUILD_SOURCE,
  type ReleaseFetcher,
  type Resolved,
  applyMongoOverride,
  resolve,
} from '../../lib/versions';
import { refuseChartOwnedEnv } from '../kube/chart';
import * as ownership from './ownership';
import { refuseEnforcedBefore880 } from '../../lib/presets/e2ee';
import { refuseVoiceBefore800 } from '../../lib/presets/voice';
import { endpointString } from '../kube/endpoints';
import { stopForward } from '../kube/forward';
import { deregister as deregisterRoute, routeHost } from '../edge/routes';
import { installed as edgeInstalled } from '../edge/spec';
import { assertNamespaceAvailable, namespaceFor, namespaceLabels } from '../kube/namespace';
import { mintNamespace } from '../kube/names';
import { wouldUseOperator } from '../kube/operator';
import { type ClusterPlan, planCluster } from '../kube/context';
import { ensureKubeconfig } from '../kube/cluster';
import { helmReachable } from '../kube/reachability';
import { missingTools } from '../kube/tools';
import type { Preflight } from '../kube/tools';
import { preflight } from '../kube/probe';
import { createWorkspace } from '../kube/workspace';
import {
  adminPass,
  externalUrl,
  keptAdminPassword,
  metadata,
  readMeta,
  serialise,
  toDocument,
  type Metadata,
  writeRecord,
} from '../runner/record';
import { atomicWrite, exists, remove as removeWorkspace, workspace } from '../runner/paths';
import { cleanup } from '../../seams/exec';
import * as topology from '../topology';
import { MODE_ACME } from '../tls';

import * as naming from './naming';
import * as notes from './notes';
import * as ports from './ports';
import * as preconditions from './preconditions';
import { waitAndFinalize, waitServing } from './ready';
import * as request from './request';
import * as seeding from './seeding';
import * as sizing from './sizing';
import { type KubeTls, type CreateReq, BILLABLE_DISTRIBUTIONS } from './types';
import * as tlsplan from './tlsplan';
import { type TlsSpec } from '../tls';

type Bag = Record<string, unknown>;
export type MonitorAttach = (name: string, emit: Emit) => Bag | Promise<Bag>;

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
 * What one Kubernetes create knows, in the order it comes to know it.
 *
 * `plan` is the CLUSTER plan `planCluster` returns -- which cluster, what distribution,
 * what it costs -- and is why the parameter these steps take is `job` rather than `plan`:
 * the two would otherwise be the same word for different things in every line.
 */
export interface KubeCreate {
  req: CreateReq;
  emit: Emit;
  monitorAttach: MonitorAttach;
  versionFetcher?: ReleaseFetcher;
  reproName: string;
  reused: boolean;
  /** `up --env`/`--setting` over what the workspace already had: recorded as `extra.env`. */
  envOverrides: Record<string, string | null>;
  /** Whether the release references the licence Secret: this run's, or a re-up's earlier one. */
  licensed: boolean;
  /** A re-up's forwards, read BEFORE the write-ahead record replaces the record holding them. */
  previous: { pid: number; port: number | null; scenarioForwards: Record<string, unknown> };
  /** The record a re-up replaces, read before the write-ahead record does. */
  previousMeta: Metadata | null;
  /** Namespace ownership survives a handover and a rewritten write-ahead record. */
  namespaceIdentity: { uid: string; owner: string } | null;
  /** A composed workspace's params, by preset; null for one preset. */
  presetParams: Record<string, Record<string, unknown>> | null;
  resolved: Resolved | null;
  recorded: number;
  /** A workspace coming back stays pinned: its record is rewritten, and `--pin` is opt-in. */
  wasPinned: boolean;
  hostPort: number;
  cfg: config.Config;
  regToken: string;
  bindHost: string;
  root: string;
  microservices: boolean;
  presetForNotes: Preset | null;
  /** The presets' moved side ports, sparse (`extra.side_ports`); `{}` when none moved. */
  sidePorts: Record<string, number[]>;
  /** Local Grafana claims are published before its later monitoring attachment. */
  monitoringPorts: number[];
  pre: Preflight | null;
  plan: ClusterPlan | null;
  tlsspec: TlsSpec | null;
  ktls: KubeTls | null;
  /** Whether THIS create put the name's edge route there, so a failure takes back only that. */
  routeIntroduced: boolean;
  adminPassword: string;
  provisional: Metadata | null;
  out: Bag;
  meta: Metadata | null;
  groups: notes.NoteGroup[] | null;
  result: Bag;
}

export function kubeCreate(
  values: Partial<KubeCreate> & Pick<KubeCreate, 'req' | 'emit' | 'monitorAttach'>,
): KubeCreate {
  return {
    reproName: '',
    reused: false,
    envOverrides: {},
    licensed: false,
    previous: { pid: 0, port: null, scenarioForwards: {} },
    previousMeta: null,
    namespaceIdentity: null,
    presetParams: null,
    resolved: null,
    recorded: 0,
    wasPinned: false,
    hostPort: 0,
    cfg: {},
    regToken: '',
    bindHost: '',
    root: '',
    microservices: false,
    presetForNotes: null,
    sidePorts: {},
    monitoringPorts: [],
    pre: null,
    plan: null,
    tlsspec: null,
    ktls: null,
    routeIntroduced: false,
    adminPassword: '',
    provisional: null,
    out: {},
    meta: null,
    groups: null,
    result: {},
    ...values,
  };
}

/**
 * When the workspace was made: kept on a re-up, which keeps its data. Stamped afresh, a backup
 * taken before a `down` and re-up read as one from an earlier workspace with the same name.
 */
function bornAt(previous: Metadata | null): string {
  return previous?.createdAt || new Date().toISOString().slice(0, 19) + '+00:00';
}

/** The longest a namespace, a DNS label, may be. */
const NAMESPACE_MAX = 63;

/** The name, whether this is a re-create, and the capacity refusal. */
export async function settleName(job: KubeCreate): Promise<void> {
  job.reproName = naming.deriveFor(job.req);
  naming.warnNameCoerced(job.req, job.emit);
  naming.announceName(job.req, job.reproName, job.emit);
  naming.requireValidName(job.reproName);
  // NO refusal for an existing workspace. `down` tells the user "bring it back: houston up
  // ...", and this raised "already exists, down first or --force" at them -- two messages
  // in the same tool contradicting each other about the same workspace. The namespace and
  // its PVC survived a plain `down`, which is exactly what makes bringing it back
  // meaningful.
  job.reused = await exists(job.reproName);
  if (job.reused) {
    info(job.emit, `'${job.reproName}' already exists — bringing it back up`, { phase: 'plan' });
  } else {
    // Before anything is made: a namespace is a DNS label, 63 characters, and kubectl
    // refused a longer `houston-<name>` only once the create was under way.
    const namespace = mintNamespace(job.reproName);
    if (namespace.length > NAMESPACE_MAX) {
      const max = job.reproName.length - (namespace.length - NAMESPACE_MAX);
      throw new ValidationError(
        `'${job.reproName}' is too long for Kubernetes: its namespace ${namespace} is ` +
          `${String(namespace.length)} characters, and a namespace holds ` +
          `${String(NAMESPACE_MAX)}. Give it a shorter name: ` +
          `${naming.typedRoom(job.req, job.reproName, max)}.`,
      );
    }
  }
  await sizing.checkCapacity(job.req, job.req.preset, job.emit);
}

/**
 * The env overrides, as Compose's `buildDocument` settles them: what the workspace already
 * had, then anything named on THIS run. Without the carry-forward a re-up silently dropped
 * them; without this step at all, `up --env` and `--setting` were ignored on Kubernetes.
 * Refused here, before anything is written, if the chart owns the key.
 */
export async function settleEnv(job: KubeCreate): Promise<void> {
  job.envOverrides = {};
  job.licensed = job.req.license !== '';
  if (job.reused) {
    let old: Metadata | null = null;
    try {
      old = await readMeta(job.reproName);
    } catch {
      // half-written record; nothing to carry
    }
    // A different set of presets is refused, not applied over the old one: the old
    // presets' objects would stay in the namespace with nothing pointing at them.
    const was = old?.preset || 'default';
    // Compared as SETS: a record an earlier build wrote as typed (`ldap+email`) is the same
    // set as the canonical `email+ldap` this run asks for.
    const asked = job.req.preset || 'default';
    if (
      old !== null &&
      old.extra.incomplete !== true &&
      compositeName(namesOf(was)) !== compositeName(namesOf(asked))
    ) {
      throw new ValidationError(
        `'${job.reproName}' runs the ${was} preset${namesOf(was).length > 1 ? 's' : ''} and ` +
          `this asks for ${job.req.preset || 'default'}. Kubernetes cannot swap presets in ` +
          `place: \`houston down --name ${job.reproName} --volumes\`, then \`up\` again, or ` +
          'leave out --preset to bring it back as it was.',
      );
    }
    if (old !== null) {
      job.previousMeta = old;
      const previous = old.extra;
      const owner = Object.hasOwn(previous, 'namespace_owner')
        ? previous.namespace_owner
        : (previous.created_by ?? '');
      const uid = Object.hasOwn(previous, 'namespace_uid') ? previous.namespace_uid : '';
      if (typeof owner !== 'string' || typeof uid !== 'string') {
        throw new ConflictError(
          `'${job.reproName}' has an invalid namespace ownership record — refusing to replace it`,
        );
      }
      job.namespaceIdentity = { uid, owner };
      job.envOverrides = { ...(bag(previous.env) as Record<string, string | null>) };
      // The Secret stays in the namespace across a `down`, so a re-up keeps referencing it.
      job.licensed ||= previous.licensed === true;
      // HERE, not after the write-ahead record: that record replaces this one, and reading
      // the forwards back from it found none -- so a re-up never retired its own forward,
      // which kept the port and failed the readiness wait, and `down` lost track of both
      // forwards, which then outlived the workspace holding 3000-range and side ports.
      job.previous = {
        pid: Number(previous.port_forward_pid ?? 0) || 0,
        port: Number(old.hostPort) || null,
        scenarioForwards: bag(previous.scenario_forwards),
      };
      // MONITORING COMES BACK WITH IT, as TLS does. The record is rewritten on a re-up and
      // only an attach writes `monitoring` and the Grafana forward, so a workspace brought
      // back without `--monitor` lost its Grafana link -- while the stack, its Ingress and
      // the namespace label were all still there.
      if (isTruthy(previous.monitoring)) job.req.monitor = true;
    }
  }
  Object.assign(job.envOverrides, job.req.env);
  refuseChartOwnedEnv(job.envOverrides);
}

/** A version recorded for a CI build (`8.10.0.dev0`), which no release carries. */
function isDevBuild(version: string): boolean {
  try {
    return parseVersion(version).dev !== null;
  } catch {
    return false;
  }
}

/**
 * Rocket.Chat, its MongoDB and the host port -- announced before the slow part starts.
 *
 * SAID BEFORE IT IS DONE, not after. The live lookup and the cluster probing below are a
 * dozen kubectl round trips; together they were a minute or more of complete silence
 * after the opening line.
 */
export async function resolvePairing(job: KubeCreate): Promise<void> {
  info(job.emit, `resolving Rocket.Chat ${job.req.version} and its MongoDB pairing`, {
    phase: 'plan',
  });
  // Looked up HERE, after the announcement, where the release lookup has always gone
  // online -- no longer by the front door ahead of every refusal, and no longer skipped by
  // the ones that had no door to do it.
  const fetcher = await request.releaseFetcher(
    job.req.version,
    job.req.offline,
    job.versionFetcher,
  );
  try {
    job.resolved = resolve(job.req.version, {
      offline: job.req.offline,
      ...(fetcher === undefined ? {} : { fetcher }),
    });
  } catch (error) {
    throw new ValidationError(errorText(error));
  }
  // A CI BUILD IS REFUSED HERE, before a namespace or a MongoDB exists. The Rocket.Chat
  // chart compares its image tag as a semantic version (`semverCompare` in the stream-hub
  // template, which every render evaluates), and a build's tag -- `develop`, `pr-123` -- is
  // not one: helm refused it after MongoDB was up (exit 7), and no values combination pulls
  // the ghcr image instead (measured on chart 7.0.0 and 7.0.2). A recorded build (`.devN`)
  // fails the same way. Docker runs them.
  if (job.resolved.source === BUILD_SOURCE || isDevBuild(job.resolved.rcVersion)) {
    throw new ValidationError(
      `${job.req.version} is a CI build, and the Rocket.Chat chart reads its image tag as a ` +
        'semantic version, so helm refuses a build tag. Run CI builds on Docker: `--runtime docker`.',
    );
  }
  // SAID BEFORE THE BUILD, not discovered after it. `resolve()` already knows when
  // releases.rocket.chat answered 404 -- it stamps `source` and the create path ignored
  // it, so `up --version 99.99.99` built the whole document and failed at the pull ~90
  // seconds later, leaving a workspace to clean up.
  if (job.resolved.source === 'map (no such release)') {
    warn(
      job.emit,
      `releases.rocket.chat has no ${job.req.version} — the pairing below ` +
        'comes from the shipped map, and the image pull will fail unless ' +
        `this tag really exists (\`houston versions ${job.req.version}\`).`,
      { phase: 'resolve' },
    );
  }
  let before: Metadata | null = null;
  if (job.reused) {
    try {
      before = await readMeta(job.reproName);
    } catch {
      before = null;
    }
  }
  // The flag, then -- for a workspace coming back -- the image it ran, then the box-wide
  // `rc_image` (config.yaml or HOUSTON_RC_IMAGE), as Compose resolves it. Only the flag was
  // read here, so a box pointed at a mirror pulled Kubernetes workspaces from Docker Hub;
  // and a re-up swapped `--rc-image` (or a CI build's ghcr image) for the default
  // repository, where Compose reuses the file that names it.
  request.chooseImage(
    job.resolved,
    job.req.rcImage || (before === null ? '' : String(before.rcImage || '')),
    config.loadConfig().rc_image,
  );
  // A WORKSPACE COMES BACK AS IT WAS. A re-up re-applies the chart and MongoDB from this
  // request: another version helm-moved Rocket.Chat over a database a different release had
  // migrated -- downwards too, which `upgrade` refuses -- and a fresh pairing swapped the
  // MongoDB image under its data. A create that never finished has nothing to keep.
  const kept = before !== null && before.extra.incomplete !== true ? before : null;
  if (kept !== null && kept.rcVersion !== '' && job.resolved.rcVersion !== kept.rcVersion) {
    throw new ValidationError(
      `'${job.reproName}' runs Rocket.Chat ${kept.rcVersion}, and this asks for ` +
        `${job.resolved.rcVersion}. It comes back at its own version: \`--version ` +
        `${kept.rcVersion}\`. \`houston upgrade --name ${job.reproName} --to ` +
        `${job.resolved.rcVersion}\` moves it, with a backup to roll back to.`,
    );
  }
  if (job.req.mongo) applyMongoOverride(job.resolved, job.req.mongo);
  else if (kept !== null && kept.mongoTag !== '') applyMongoOverride(job.resolved, kept.mongoTag);
  // NOR UNDER ANOTHER MONGODB. The operator keeps its data in a claim of its own, so a kept
  // workspace brought back with --mongo-operator (or HOUSTON_MONGO_OPERATOR set since) came up
  // on an empty database, its data in a claim nothing read -- and `down --volumes` deleted it.
  if (
    kept !== null &&
    kept.extra.mongo_managed_by === 'statefulset' &&
    wouldUseOperator(job.resolved.mongoTag, job.req.mongoOperator)
  ) {
    throw new ValidationError(
      `'${job.reproName}' keeps its data in a MongoDB houston runs itself, and this would bring ` +
        'it back under the MongoDB operator, on an empty volume. Bring it back without ' +
        '--mongo-operator (and with HOUSTON_MONGO_OPERATOR unset). To move it to the operator: ' +
        `\`houston backup --name ${job.reproName}\`, \`down --volumes\`, then \`restore --new\` ` +
        'with the operator.',
    );
  }

  // A workspace that comes back must come back at the SAME address. Allocating afresh
  // moved it from :3382 to :3000 on the `up` after a `down` -- so every bookmark, every
  // curl in a ticket and the URL the user had just been shown all pointed at nothing.
  job.recorded = before === null ? 0 : Number(before.hostPort) || 0;
  job.wasPinned = before !== null && isTruthy(before.pinned);
  const publicMonitoring =
    Boolean(job.req.https || job.req.domain || job.req.acmeEmail) ||
    (job.req.monitor && (await tlsplan.tlsFromRecord(job.reproName)) !== null);
  // The side UIs' forwards, and the local Grafana's: preferred first, the next free port when
  // another workspace holds one. A re-up keeps what its record holds -- its own live forwards
  // hold those ports -- so its manifests render the same labels and nothing rolls.
  const claim = await ports.claimSidePorts(
    job.reproName,
    requestedPreset(job),
    (given) => requestedPreset(job, given),
    {
      monitoring: job.req.monitor && !publicMonitoring ? ['grafana'] : [],
      reserve: job.req.port ? [job.req.port] : [],
    },
  );
  for (const [whose, was, now] of claim.moved) {
    warn(
      job.emit,
      `${whose}'s port ${String(was)} is claimed by another workspace now, so ` +
        `'${job.reproName}' forwards it on ${String(now)}`,
      { phase: 'plan' },
    );
  }
  job.sidePorts = claim.side;
  job.monitoringPorts = claim.monitoring;
  const pre = claim.pre;
  // CHECKED, as Compose checks it, before anything is made. A port given here was taken on
  // trust: the whole workspace deployed, the forward then found the port held, and `up`
  // ended exit 8 with the workspace left running. The workspace's own recorded port stays
  // its own (`pickHostPort` excludes it), so a re-up is not refused by its live forward.
  job.hostPort = await ports.pickHostPort(
    job.req.port || job.recorded,
    {
      ...pre,
      // This runtime publishes one application forward, independent of chart replicas.
      instances: 1,
      ports: [...pre.ports, ...job.monitoringPorts],
    },
    job.reproName,
  );
}

/**
 * Resolve the actual scenario once, including ports added by its parameters: on the registry's
 * ports, which side ports are allocated from, until `ports` -- the ones allocated -- rebuilds it.
 */
function requestedPreset(job: KubeCreate, ports?: config.PortMap): Preset {
  if (job.presetForNotes !== null && ports === undefined) return job.presetForNotes;
  const names = namesOf(job.req.preset || 'default');
  if (names.length > 1) {
    job.presetParams = request.paramsByPreset(names, job.req.params);
    job.presetForNotes = presets.loadMany(
      names,
      job.presetParams,
      topology.KUBERNETES,
      new Set(Object.keys(job.envOverrides)),
      ports ?? {},
    );
  } else {
    job.presetForNotes = presets.resolve(
      job.req.preset || 'default',
      topology.KUBERNETES,
      job.req.params,
      ports ?? {},
    );
    request.refuseUnknownParams(job.req.params, job.presetForNotes, job.req.preset || 'default');
  }
  return job.presetForNotes;
}

/** How this workspace is reached and what shape it is, in Compose's own order. */
export function settleAddressing(job: KubeCreate): void {
  // Same resolution order Compose uses: the flag, then the box-level config, then
  // loopback. This was dropped entirely on the Kubernetes path.
  job.cfg = config.loadConfig();
  job.regToken = job.req.regToken || toText(job.cfg.reg_token);
  if (job.req.bind) job.bindHost = String(job.req.bind);
  else if (isTruthy(job.cfg.bind_host)) job.bindHost = String(job.cfg.bind_host);
  else job.bindHost = config.DEFAULT_BIND_HOST;
  // Where the forward listens: loopback, unless one other address was asked for.
  job.root = `http://${request.callHost(job.bindHost)}:${String(job.hostPort)}`;
  job.microservices = job.req.deployment === topology.MICROSERVICES;
  // Allocation, deployment and notes share the same resolved scenario.
  requestedPreset(job);
  const names = namesOf(job.req.preset || 'default');
  const premium = request.premiumAuthWarning(
    names,
    job.resolved?.rcVersion ?? '',
    job.licensed,
    job.regToken,
  );
  if (premium !== '') warn(job.emit, premium, { phase: 'plan' });
  const voice = request.voiceLicenceWarning(names, job.licensed, job.regToken);
  if (voice !== '') warn(job.emit, voice, { phase: 'plan' });
  const samlEmail = request.samlEmailWarning(
    job.presetForNotes as Preset,
    job.resolved?.rcVersion ?? '',
    new Set(Object.keys(job.envOverrides)),
  );
  if (samlEmail !== '') warn(job.emit, samlEmail, { phase: 'plan' });
}

/**
 * A directory served over LDAPS or StartTLS: its certificate, as a Secret beside it. (Its side
 * ports were given in `resolvePairing`, which this runtime port-forwards on this machine.)
 */
export async function certifyTheDirectory(job: KubeCreate): Promise<void> {
  const pre = job.presetForNotes as Preset;
  if (pre.extra.directory_tls !== undefined) {
    job.presetForNotes = withCertificate(
      pre,
      await tlsplan.issueDirectoryCertificate(directoryHost(pre.extra)),
      topology.KUBERNETES,
    );
  }
}

/**
 * Which cluster, what it would cost, and whether this box has the tools to talk to it.
 *
 * THE CLUSTER IS CHOSEN FIRST, before a single byte is written. `planCluster` only probes,
 * and it is what refuses when there is no cluster and no `kind` -- so that refusal now
 * costs nothing, where before it left an `incomplete` record that `list` showed as a
 * workspace and whose port `usedPorts()` went on reserving.
 *
 * THE CORE TOOLS FIRST, before anything is provisioned: with `kubectl` absent, `up` built
 * an entire kind cluster, THEN failed, and blamed the API server.
 */
export async function planClusterStep(job: KubeCreate): Promise<void> {
  job.pre = await preflight();
  const missing = missingTools(job.pre);
  if (missing.length > 0) {
    throw new PreflightError(
      `${missing.join(', ')} is not installed, and a Kubernetes ` +
        'workspace cannot be created or used without it. Install it and try ' +
        'again — `houston doctor` lists what this runtime needs.',
    );
  }
  job.plan = await planCluster(request.reqContext(job.req));
  // A BILLABLE CLUSTER AND NO PUBLIC NAME. Warned, not refused, and the distinction
  // matters: a refusal would remove the one way to reach a workspace whose ingress is
  // broken, which is exactly when somebody needs it.
  if (BILLABLE_DISTRIBUTIONS.includes(job.plan.distribution) && !(job.req.domain || '').trim()) {
    warn(
      job.emit,
      `'${job.plan.context}' is a ${job.plan.distribution} cluster, and without --domain ` +
        'this workspace opens only in a browser on the machine running houston, through a ' +
        'port-forward that ends when its pod restarts. ' +
        '`--domain <name>` gives it a publicly-trusted address instead.',
      { phase: 'preflight' },
    );
  }
}

/** The HTTPS name, and which of the two mechanisms will serve it. */
export async function planTls(job: KubeCreate): Promise<void> {
  job.tlsspec = await tlsplan.resolveTls(
    job.req,
    job.reproName,
    job.bindHost,
    job.reproName,
    job.emit,
  );
  job.ktls = null;
  if (job.plan !== null && !job.plan.create) {
    // THE PREFLIGHT NEEDS A KUBECONFIG THAT KNOWS THIS CONTEXT, and on a fresh
    // HOUSTON_HOME it does not have one: the cluster exists, so nothing was created, so
    // nothing exported the context this is about to ask through. Idempotent, and a no-op
    // for a cluster houston did not make.
    await ensureKubeconfig(job.plan, job.emit);
    // HELM'S OWN ANSWER, and this is the cheapest refusal on the path. houston drives
    // kubectl AND helm, they resolve their configuration differently, and only kubectl was
    // ever asked. Measured: kubectl completely happy while helm refused every call with
    // `x509: certificate signed by unknown authority`, so the create built a namespace, a
    // StatefulSet, a PersistentVolume and an initiated replica set, spent four minutes,
    // then died at the chart and rolled all of it back.
    const helmWhy = await helmReachable(job.plan.context);
    if (helmWhy) {
      throw new ValidationError(
        `helm cannot reach cluster '${job.plan.context}', although kubectl can. ` +
          'The chart install would fail after MongoDB and roll the whole ' +
          `workspace back. helm said: ${helmWhy} — a kubeconfig left over ` +
          'from a previous install of the same cluster does this. Regenerate ' +
          'it (k3s: `sudo cat /etc/rancher/k3s/k3s.yaml > ~/.kube/config`; ' +
          'kind: `kind export kubeconfig --name <cluster>`) and run this ' +
          'again. `houston doctor` reports the same thing.',
      );
    }
    await assertNamespaceAvailable(job.reproName, {
      context: job.plan.context,
      owner: job.req.actor,
    });
  }
}

/** What the in-cluster ingress needs, when the edge is not the thing serving the name. */
export async function planKubeTls(job: KubeCreate): Promise<void> {
  if (job.tlsspec !== null) {
    // Named before the probing starts. `kubernetesTlsPlan` asks the cluster about its
    // ingress classes, its cert-manager CRD and its ingress endpoint before it emits
    // anything, which on a managed cluster is several seconds of nothing at the exact
    // moment the reader is waiting to learn where HTTPS is coming from.
    info(
      job.emit,
      `checking ${job.plan?.context ?? ''} for the ingress and cert-manager HTTPS ` + 'needs',
      { phase: 'tls' },
    );
    // AFTER `ensureKubeconfig`, because every probe in it needs a kubeconfig that knows
    // the context, and BEFORE the write-ahead record, because a refusal must leave
    // nothing.
    job.ktls = await tlsplan.kubernetesTlsPlan(job.req, job.tlsspec, job.plan as ClusterPlan, {
      emit: job.emit,
    });
    // A preset's own UIs at paths of that name; `installChart` routes them with an Ingress.
    if (job.presetForNotes !== null) {
      job.presetForNotes = withPublicUrl(
        job.presetForNotes,
        `https://${job.ktls.host}`,
        topology.KUBERNETES,
      );
      const presigned = presignedOverHttps(job.presetForNotes);
      if (presigned) warn(job.emit, presigned, { phase: 'tls' });
    }
  }
}

/** A record BEFORE any cluster resource exists, so a killed create leaves something. */
export async function writeProvisionalRecord(job: KubeCreate): Promise<void> {
  // A WRITE-AHEAD RECORD, before a single cluster resource exists. `createWorkspace`
  // below builds the namespace, MongoDB, the chart release, the scenario's manifests and
  // the port-forward -- minutes of work -- and only after it returned was anything written
  // down. Kill the process in that window and the workspace is left fully running with NO
  // record: invisible to `list`, `info` and `down`. Two such orphans were found holding
  // several GB between them.
  // A workspace brought back keeps its PersistentVolumeClaim, so its database's password too.
  const kept = job.reused ? await keptAdminPassword(job.reproName) : null;
  const reachable = preconditions.reachableBeyondLoopback({
    tlsspec: job.tlsspec,
    bindHost: job.bindHost,
  });
  job.adminPassword = kept ?? (reachable ? config.generateAdminPassword() : '');
  const shared = request.keptSharedPasswordWarning(job.reproName, kept, reachable);
  if (shared !== '') warn(job.emit, shared, { phase: 'plan' });
  const resolved = job.resolved as Resolved;
  const plan = job.plan as ClusterPlan;
  job.provisional = metadata({
    name: job.reproName,
    project: await namespaceFor(job.reproName),
    rcVersion: resolved.rcVersion,
    rcImage: resolved.rcImage,
    mongoTag: resolved.mongoTag,
    mongoFlavor: resolved.mongoFlavor,
    preset: job.req.preset,
    rootUrl: job.root,
    hostPort: job.hostPort,
    versionSource: resolved.source,
    pinned: job.req.pin || job.wasPinned,
    adminPassword: job.adminPassword,
    createdAt: bornAt(job.previousMeta),
  });
  topology.stamp(job.provisional.extra, topology.KUBERNETES);
  job.provisional.extra[config.EXTRA_DEPLOYMENT] = job.req.deployment || topology.MICROSERVICES;
  job.provisional.extra.namespace = await namespaceFor(job.reproName);
  if (job.namespaceIdentity !== null) {
    job.provisional.extra.namespace_owner = job.namespaceIdentity.owner;
    if (job.namespaceIdentity.uid !== '') {
      job.provisional.extra.namespace_uid = job.namespaceIdentity.uid;
    }
  }
  // The chosen context, not a guess at it. This was `CONTEXT` unconditionally, which was
  // right only while houston's own cluster was the only one it could use.
  job.provisional.extra[config.EXTRA_CONTEXT] = plan.context;
  job.provisional.extra.distribution = plan.distribution;
  // A RE-UP OF A FINISHED WORKSPACE IS NOT A HALF-MADE ONE. Marked incomplete, a re-up that
  // failed left the flag behind, and the next `up` skipped the checks that keep a workspace's
  // version, MongoDB and presets -- the ones a half-made workspace has nothing to keep for.
  job.provisional.extra.incomplete =
    job.previousMeta === null || job.previousMeta.extra.incomplete === true;
  if (job.req.actor) job.provisional.extra.created_by = job.req.actor;
  // In the write-ahead record too: a re-up after a killed create carries forward from it.
  if (Object.keys(job.envOverrides).length > 0) job.provisional.extra.env = job.envOverrides;
  if (job.licensed) job.provisional.extra.licensed = true;
  // Still recorded while the create runs, so a create killed part-way leaves `down` able to
  // stop them.
  if (job.previous.pid !== 0) job.provisional.extra.port_forward_pid = job.previous.pid;
  if (Object.keys(job.previous.scenarioForwards).length > 0) {
    job.provisional.extra.scenario_forwards = job.previous.scenarioForwards;
  }
  // Claimed from the write-ahead record on, so a concurrent create sees them.
  const sidePorts = (job.presetForNotes as Preset).ports;
  if (sidePorts.length > 0) job.provisional.extra.sidecar_ports = sidePorts;
  if (Object.keys(job.sidePorts).length > 0) job.provisional.extra.side_ports = job.sidePorts;
  if (job.monitoringPorts.length > 0) {
    job.provisional.extra.monitoring_ports = [...job.monitoringPorts];
  }
  ownership.carryOwnership(job.previousMeta, job.provisional);
  // Through the runner seam, so the workspace directory is restricted to 0700 the way
  // every Compose one is. This runtime is the one that also writes `kubernetes/values.yaml`
  // with ADMIN_PASS in it.
  await writeRecord(job.reproName, job.provisional);
}

/**
 * The name on the edge, BEFORE the create, so an ACME challenge has somewhere to land the
 * moment the chart's Ingress appears. Inside the create's rollback: the edge refusing to
 * start (another home's edge holds :443) left the write-ahead record of a workspace that
 * never existed, and the retry reused it.
 */
export async function routeTheName(job: KubeCreate): Promise<void> {
  if (job.ktls === null) return;
  job.routeIntroduced = routeHost(job.reproName) === '';
  await tlsplan.routeKubernetesName(job.reproName, job.ktls, { emit: job.emit });
}

/**
 * A failed create takes back the edge route it registered, as the cluster side takes back
 * the namespace. The route goes in BEFORE the create, so an ACME challenge has somewhere to
 * land; left behind, it sent the name to a NodePort the rollback had already deleted
 * (measured on a k3s playground, 2026-10-06). The record stays, as it always has, so
 * `list` and `down` still find the workspace; a route that was there before this create --
 * a workspace being re-created -- stays too.
 */
export function forgetTheRouteThisCreateMade(job: KubeCreate): void {
  if (job.ktls === null || !job.routeIntroduced || routeHost(job.reproName) === '') return;
  deregisterRoute(job.reproName);
  warn(job.emit, `create failed — removing the edge route for ${job.ktls.host}`, {
    phase: 'teardown',
  });
}

/**
 * A fresh create that left no namespace leaves no record either.
 *
 * The rollback removes the namespace a failed or stopped create made, and the write-ahead
 * record stayed: a "down" workspace that claimed its port and its preset's side ports --
 * the next create wanting 8025 was refused for it -- and whose panel said its data volume
 * was "still here". Nothing was. A workspace coming back keeps its record; so does one whose
 * namespace survived, or could not be asked about.
 */
async function forgetARecordWithNothingBehindIt(job: KubeCreate): Promise<void> {
  if (job.reused || job.plan === null) return;
  let labels: Record<string, string> | null;
  try {
    labels = await namespaceLabels(await namespaceFor(job.reproName), {
      context: job.plan.context,
    });
  } catch {
    return; // could not ask: the record stays, and says what it knows
  }
  if (labels !== null) return;
  await removeWorkspace(job.reproName);
  warn(
    job.emit,
    `nothing of '${job.reproName}' was left in the cluster, so its record goes too — ` +
      'its ports are free again',
    { phase: 'teardown', code: NOTHING_LEFT },
  );
}

/** The namespace, MongoDB, the chart release and the port-forward -- the long part. */
export async function createTheWorkspace(job: KubeCreate): Promise<void> {
  const ns = await namespaceFor(job.reproName);
  // The preset UIs' forwards are re-made below; the old ones would keep their ports.
  for (const [port, pid] of Object.entries(job.previous.scenarioForwards)) {
    await stopForward(Number(pid) || 0, { namespace: ns, hostPort: Number(port) || null });
  }
  const resolved = job.resolved as Resolved;
  job.out = await createWorkspace({
    name: job.reproName,
    resolved,
    hostPort: job.hostPort,
    microservices: job.microservices,
    replicas: job.req.replicas || 1,
    owner: job.req.actor,
    bindHost: job.bindHost,
    adminPassword: job.adminPassword,
    previousPid: job.previous.pid,
    previousPort: job.previous.port,
    // PASSED AT LAST. `createWorkspace` has taken `rootUrl` since it was written and this
    // call never supplied it, so `valuesFor` never set anything and the chart emitted no
    // ROOT_URL -- Rocket.Chat ran on its own default while every human reached it here.
    rootUrl: job.root,
    // With a name, the chart's own Ingress template builds the Ingress -- houston
    // hand-writes none.
    tlsHost: job.ktls?.host ?? '',
    ingressClass: job.ktls?.ingressClass ?? '',
    issuer: job.ktls?.issuer ?? null,
    useOperator: job.req.mongoOperator,
    // Through a Secret referenced by `valueFrom`, never as a values literal: `helm get
    // values` is readable by anyone who can reach the release.
    regToken: job.regToken,
    // Resolved through the KUBERNETES adapter, so a scenario yields native manifests here
    // and a compose service on the other runtime -- one intent, two renderings.
    preset: job.presetForNotes,
    envOverrides: job.envOverrides,
    license: job.req.license,
    licensed: job.licensed,
    plan: job.plan,
    emit: job.emit,
  });
}

/** `repro.json` as it stands once the cluster has answered. */
export async function buildRecord(job: KubeCreate): Promise<void> {
  const resolved = job.resolved as Resolved;
  const plan = job.plan as ClusterPlan;
  job.meta = metadata({
    name: job.reproName,
    project: String(job.out.namespace ?? ''),
    rcVersion: resolved.rcVersion,
    rcImage: resolved.rcImage,
    mongoTag: resolved.mongoTag,
    // NOT `resolved.mongoFlavor`. That is a COMPOSE concept -- "official" vs
    // "bitnami-legacy" -- and this runtime honours neither: `createWorkspace` records
    // `mongo_managed_by` and `mongo_image` for exactly this reason.
    mongoFlavor: '',
    preset: job.req.preset,
    rootUrl: job.root,
    hostPort: job.hostPort,
    versionSource: resolved.source,
    pinned: job.req.pin || job.wasPinned,
    adminPassword: job.adminPassword,
    createdAt: bornAt(job.previousMeta),
  });
  // The preset's own record fields -- `mailpit_url`, which `admin.login` reads to fetch an
  // email-2FA code, so without it every login to an email workspace here failed at 2FA.
  // BEFORE the runtime's stamps, so a preset cannot overwrite them.
  const pre = job.presetForNotes as Preset;
  Object.assign(job.meta.extra, pre.extra);
  if (pre.ports.length > 0) job.meta.extra.sidecar_ports = pre.ports;
  // Only what moved, in BOTH records: a re-up reads it back to render the same labels.
  if (Object.keys(job.sidePorts).length > 0) job.meta.extra.side_ports = job.sidePorts;
  if (job.monitoringPorts.length > 0) {
    job.meta.extra.monitoring_ports = [...job.monitoringPorts];
  }
  topology.stamp(job.meta.extra, topology.KUBERNETES);
  job.meta.extra[config.EXTRA_DEPLOYMENT] = job.req.deployment || topology.MICROSERVICES;
  for (const [key, value] of Object.entries(job.out)) {
    if (key !== 'microservices') job.meta.extra[key] = value;
  }
  // WHAT kind of cluster this workspace lives in. A label, never a branch -- it is what
  // lets `doctor`, the notes and a support case say "k3s" instead of leaving a reader to
  // infer it from a context name.
  job.meta.extra.distribution = plan.distribution;
  if (job.ktls !== null) {
    // The SAME three fields the Compose path records, so `list`, `info`, `reproLinks`, the
    // GUI grid and `tls-status` all work on a Kubernetes workspace for free. `rootUrl`
    // deliberately stays the plain http port-forward URL; `publicUrl` is what a human opens.
    job.meta.publicUrl = `https://${job.ktls.host}`;
    job.meta.extra.tls = job.ktls.issuer?.mode === 'acme' ? MODE_ACME : 'local';
    if (job.ktls.issuer?.mode === 'acme') {
      job.meta.extra.tls_staging = Boolean(job.ktls.issuer.acmeStaging);
      job.meta.extra.tls_email = job.ktls.issuer.acmeEmail ?? '';
    }
    // `edge` means "a route file speaks for this name". It is what `noteGroupsOf` keys the
    // HTTPS card on, and it is false in the topology where the cluster holds :443 itself
    // and no edge is involved at all.
    job.meta.extra.edge = edgeInstalled();
    // Where TLS actually terminates, which is the one thing genuinely different from
    // Compose: the certificate is a cluster Secret issued by cert-manager, not a file the
    // edge loaded.
    job.meta.extra.tls_terminates = 'cluster';
    job.meta.extra.ingress_endpoint = endpointString(job.ktls.endpoint);
    job.meta.extra.ingress_class = job.ktls.ingressClass;
    // `certificate_ready` decides how a fallback certificate is EXPLAINED. It was computed
    // here all along and thrown away, so the check that reports the result did not know
    // whether one had ever been issued.
    await tlsplan.publishKubernetesName(job.reproName, job.ktls, {
      certReady: Boolean(job.out.certificate_ready),
      emit: job.emit,
    });
  }
}

/** What was ASKED for, so the workspace can be rebuilt exactly as it was. */
export function recordTheRequest(job: KubeCreate): void {
  const meta = job.meta as Metadata;
  if (job.req.replicas > 1) meta.extra.instances = job.req.replicas;
  if (job.req.actor) meta.extra.created_by = job.req.actor;
  // Recorded so the notes can be REBUILT from the record rather than read back out of it
  // -- a dynamic scenario's prose is a function of its params, and nothing was keeping them.
  if (job.presetParams !== null) {
    // As Compose records a composed workspace: one preset string, the list and its params.
    meta.extra.presets = namesOf(job.req.preset);
    meta.extra.preset_params = structuredClone(job.presetParams);
  } else if (Object.keys(job.req.params).length > 0) {
    meta.extra.params = { ...job.req.params };
  }
  // The same key Compose records them under, so re-up, `backup` and `restore --new` carry them.
  if (Object.keys(job.envOverrides).length > 0) meta.extra.env = job.envOverrides;
  if (job.licensed) meta.extra.licensed = true;
  // A preset's self-configuration actions, recorded exactly as the Compose path records
  // them. Without this the OIDC preset would create no OAuth provider and the SAML preset
  // no provider settings -- both recorded and neither applied.
  const postReady = (job.presetForNotes as Preset | null)?.postReady;
  if (postReady !== undefined && postReady.length > 0) meta.extra.post_ready = postReady;
  ownership.carryOwnership(job.provisional ?? job.previousMeta, meta);
}

/** The notes a reader needs, then the record -- and no compose file, because it is not one. */
export async function writeRecordStep(job: KubeCreate): Promise<void> {
  const meta = job.meta as Metadata;
  job.groups = await notes.noteGroupsOf(meta);
  // THE GROUPS ARE NOT PERSISTED. They are rendered presentation -- roughly 5.5 KB of a
  // 6.4 KB Kubernetes record, the same content as `notes` a second time, and including an
  // absolute `export KUBECONFIG=<home>/clients/kubernetes/config` that is wrong the moment
  // the home moves.
  delete meta.extra.note_groups;
  // Derived, never written twice: the CLI and every workspace record made before groups
  // existed read this.
  meta.extra.notes = notes.flattenNotes(job.groups);
  // No compose document, so an empty one rather than a fake: a file that looks like a
  // compose project but is not would be worse than none.
  const ws = workspace(job.reproName);
  await fs.mkdir(ws, { recursive: true });
  // `serialise(meta)`, as every record is written: the record's one spelling, not
  // JSON.stringify's.
  await atomicWrite(joinPath(ws, 'repro.json'), serialise(meta));
}

/** Waiting, seeding, monitoring, and the line the caller reads at the end. */
export async function finish(job: KubeCreate): Promise<Bag> {
  const meta = job.meta as Metadata;
  job.result = {
    name: job.reproName,
    meta: toDocument(meta),
    url: job.root,
    // The two a caller opens, as the Compose create's summary names them: the GUI's create
    // dialog offered no address at all for a Kubernetes workspace, and `up --json` none to
    // a script.
    root_url: meta.rootUrl,
    public_url: meta.publicUrl,
    open_url: externalUrl(meta),
    reused: job.reused,
    runtime: topology.KUBERNETES,
  };
  // A preset with post_ready actions MUST wait, or there is nothing to configure against.
  if (job.req.wait || job.req.seed || isTruthy(meta.extra.post_ready)) {
    // waitAndFinalize, not bare waitServing: it also finalizes the setup wizard over REST
    // and runs the preset's post_ready actions. Waiting and stopping there left every
    // self-configuring preset half-applied.
    Object.assign(job.result, await waitAndFinalize(meta, job.emit, 600.0, false));
    job.result.ready = true;
  }
  // NOT when the caller seeds. `seedHere` means the CLI runs it after this returns, so
  // seeding here as well would seed the workspace twice.
  if (job.req.seed && !job.req.seedHere) {
    job.result.seed = await seeding.runSeedInline(
      meta,
      job.req.seedProfile,
      job.req.stats,
      job.emit,
      { scenarios: job.req.seedScenarios, historyDays: job.req.seedHistoryDays },
    );
  }
  // `--monitor` last, and only once the workspace is serving: attaching turns on RC's own
  // Prometheus_Enabled over REST, which needs a workspace that answers.
  if (job.req.monitor) {
    if (!(job.req.wait || job.req.seed)) {
      await waitServing(meta, job.emit, 600.0);
    }
    // An add-on failing does not un-create the workspace. The first live run of this
    // failed on the monitoring chart and exited 7 with the workspace up, serving, and
    // listed as running -- a create reported as failed while its result was sitting there
    // working.
    try {
      job.result.monitoring = await job.monitorAttach(job.reproName, job.emit);
    } catch (error) {
      if (!(error instanceof ReproError)) throw error;
      warn(job.emit, `the workspace is up, but monitoring did not attach: ${error.message}`, {
        phase: 'monitor',
      });
      warn(job.emit, `retry it with: houston monitor --name ${job.reproName}`, {
        phase: 'monitor',
      });
      job.result.monitoring = { monitoring: false, error: error.message };
    }
  }
  info(job.emit, `${job.root}  admin / ${adminPass(meta)}`, { phase: 'done', pct: 100 });
  return job.result;
}

/**
 * The Kubernetes half of `createReproLocked`.
 *
 * Shares everything that is not runtime-specific -- name derivation, version resolution,
 * the capacity refusal, host-port allocation, repro.json -- and delegates only the
 * sequence that differs. A workspace created here is a workspace like any other: `list`,
 * `info`, `logs` and `down` find it because it has a repro.json.
 */
export async function createKubernetes(
  req: CreateReq,
  emit: Emit = nullEmit,
  {
    monitorAttach = request.missingMonitorAttach,
    versionFetcher,
  }: { monitorAttach?: MonitorAttach; versionFetcher?: ReleaseFetcher } = {},
): Promise<Bag> {
  const job = kubeCreate({
    req,
    emit,
    monitorAttach,
    ...(versionFetcher === undefined ? {} : { versionFetcher }),
  });
  await settleName(job);
  await settleEnv(job);
  await ports.withPortPublication(async () => {
    await resolvePairing(job);
    settleAddressing(job);
    // Before the cluster is probed or anything is written.
    refuseEnforcedBefore880(requestedPreset(job), (job.resolved as Resolved).rcVersion);
    refuseVoiceBefore800(requestedPreset(job), (job.resolved as Resolved).rcVersion);
    await certifyTheDirectory(job);
    await planClusterStep(job);
    await planTls(job);
    await planKubeTls(job);
    await writeProvisionalRecord(job);
  });
  try {
    await routeTheName(job);
    await createTheWorkspace(job);
  } catch (error) {
    forgetTheRouteThisCreateMade(job);
    // As cleanup, so a stopped job's unwind runs it to the end, as the rollback does.
    await cleanup(async () => {
      await forgetARecordWithNothingBehindIt(job);
    });
    throw error;
  }
  await buildRecord(job);
  recordTheRequest(job);
  await writeRecordStep(job);
  return await finish(job);
}
