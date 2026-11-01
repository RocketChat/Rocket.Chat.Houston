/**
 * What a workspace IS right now: its state, its health, its links, and the list.
 *
 * Tier 3. Reads the on-disk record and the engine; never changes either. `detail` lives next
 * door in `payload` because it is the payload-shape trap -- the browser suite renders from a
 * fixture of it, so a key that drifts from what this layer really returns breaks the panel in
 * production with the whole suite green.
 */
import * as config from '../../lib/config';
import { mapLimit } from '../../lib/map-limit';
import { grafanaUrl } from '../../lib/monitoring';
import { workspaceNamespaces } from '../kube/capabilities';
import { shortName } from '../kube/context';
import { forwardAlive } from '../kube/forward';
import { CONTEXT as KUBE_CONTEXT, RELEASE } from '../kube/names';
import { namespaceFor } from '../kube/namespace';
import { PENDING_STATES, releaseState } from '../kube/release';
import {
  terminalFailureOfPods,
  terminalPodFailure,
  workloadReplicas,
  workspacePodsByNamespace,
  workspacePodsReady,
  workspaceReady,
  workspaceReplicasByNamespace,
} from '../kube/status';
import { dockerAvailable } from '../runner/host';
import { projectStates, rcStatusByProject, servicesByProject } from '../runner/queries';
import {
  type Metadata,
  externalUrl,
  grafanaPortOf,
  listMeta,
  prometheusPortOf,
  readMeta,
  sidePortsOf,
} from '../runner/record';
import * as topology from '../topology';

import * as naming from './naming';
import * as notes from './notes';
import { callHost } from './request';
import { ESSENTIAL_SERVICES, PRESET_LINKS } from './types';
import { presetPort, presetPorts } from '../../lib/presets/common';
import { namesOf } from '../../lib/presets/composite';
import { publicPathsOf } from '../../lib/presets/public';
import { BUILD_IMAGE, isBuildTag } from '../../lib/versions';

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
 * The state to report for a repro, from its Rocket.Chat container's docker `Status`
 * string ("Up 2 hours (healthy)", "Restarting (1) 5 seconds ago", ...).
 *
 * BOTH the list and the detail panel must derive state from this, because they used to
 * disagree. The list read compose's PROJECT-level aggregate, where the always-running
 * Mongo put "running(" in the string and made a crash-looping RC report "running"; the
 * panel checked only whether RC was literally "running" and flattened everything else to
 * "stopped".
 *
 * `hasContainers` separates "the stack is gone" (down) from "containers exist but
 * Rocket.Chat has none" (stopped).
 */
export function reproState(rcStatus: string, hasContainers: boolean): string {
  const s = (rcStatus || '').trim();
  if (!s) return hasContainers ? 'stopped' : 'down';
  const low = s.toLowerCase();
  if (low.startsWith('up')) {
    // docker reports a paused container as "Up 3 days (Paused)".
    return low.includes('(paused)') ? 'paused' : 'running';
  }
  if (low.startsWith('exited')) return 'stopped';
  // "Restarting (1) 5 seconds ago" -> restarting; "Created"/"Dead" -> as-is.
  return low.split(' (')[0]?.split(' ')[0] || 'down';
}

interface KubernetesReads {
  workloadReplicas: typeof workloadReplicas;
  workspaceReady: typeof workspaceReady;
  terminalPodFailure: typeof terminalPodFailure;
}

const scopedKubernetesReads: KubernetesReads = {
  workloadReplicas,
  workspaceReady,
  terminalPodFailure,
};

/**
 * `running` / `down` for a Kubernetes workspace.
 *
 * `reproState()` asks docker whether the project's containers exist, so it called a live
 * Kubernetes workspace `down` -- the state column was reporting on the wrong runtime
 * entirely.
 */
export async function kubernetesState(
  name: string,
  meta: Metadata,
  namespaces: typeof workspaceNamespaces = workspaceNamespaces,
  reads: KubernetesReads = scopedKubernetesReads,
): Promise<string> {
  const extra = bag(meta.extra);
  const context = isTruthy(extra[config.EXTRA_CONTEXT])
    ? String(extra[config.EXTRA_CONTEXT])
    : KUBE_CONTEXT;
  // "?" ON A REFUSED READ, which is the word the Docker branch one function up already
  // uses when the daemon is unreachable. Without it a healthy workspace read as `down`
  // whenever the cluster could not be asked. `down` is the word that invites `up --force`
  // and `down --volumes`, so it is the worst available guess.
  //
  // ONE ROUND OF QUESTIONS, NOT FOUR IN A ROW. On EKS every kubectl call first fetches a
  // token, so asking the namespace, the workload, its replicas and its pods one after
  // another made each `list` -- which the GUI asks for every four seconds -- and each
  // workspace panel cost four round trips. The three reads are independent; their answers
  // are taken in the order the rule needs, so a missing namespace still decides first and
  // a refused workload read still raises only once the namespace is known to be there.
  const [held, workload, ready] = await Promise.all([
    namespaces(context),
    reads.workloadReplicas(name, { context }).then(
      (replicas) => ({ replicas, failure: null as unknown }),
      (failure: unknown) => ({ replicas: null, failure }),
    ),
    reads.workspaceReady(name, { context }),
  ]);
  if (held === null) return '?';
  if (!held.includes(await namespaceFor(name))) return 'down';
  if (workload.failure !== null) throw workload.failure;
  // The namespace EXISTING is not the workspace running. A plain `down` keeps the
  // namespace and its PVC on purpose and uninstalls the release, so a torn-down workspace
  // reported "starting" -- and would have reported it forever.
  if (workload.replicas === null) return 'down';
  // Scaled to zero is STOPPED, not starting. `stop` is implemented as scale-to-zero and
  // without this the column said "starting" for a workspace that was deliberately
  // stopped and was never going to move.
  if (workload.replicas === 0) return 'stopped';
  if (ready) return 'running';
  // NOT-READY IS NOT ALWAYS STARTING. For a wedged `pending-install` release or a pod in
  // ImagePullBackOff / CreateContainerConfigError nothing is coming. A refused read must
  // not manufacture a failure, so each probe is guarded and falls back to the honest
  // "starting".
  try {
    if ((await reads.terminalPodFailure(name, { context })) !== null) return 'failed';
  } catch {
    // a refused probe is not evidence of failure
  }
  try {
    const [state] = await releaseState(RELEASE, await namespaceFor(name), context);
    if (PENDING_STATES.includes(state) || state === 'failed') return 'failed';
  } catch {
    // same
  }
  return 'starting';
}

/**
 * Why a workspace that LOOKS running is not usable, or "".
 *
 * `services` is {service: docker Status string}. Reported as a distinct health rather
 * than as a state, because the workspace genuinely is running -- what is wrong is that
 * something it needs is not.
 */
export function degradedReason(services: Record<string, string>): string {
  for (const svc of ESSENTIAL_SERVICES) {
    const status = services[svc];
    if (status !== undefined && !status.startsWith('Up ')) {
      const first = status.split(' (')[0]?.trim().toLowerCase() || 'not running';
      return `${svc} is ${first}`;
    }
  }
  return '';
}

/**
 * Parse a docker `Status` string -> (uptime, health).
 * "Up 2 hours (healthy)" -> ("2 hours", "healthy"); "Exited (0) ..." -> ("", "").
 */
export function uptimeHealth(status: string): [string, string] {
  if (!status) return ['', ''];
  const match = /\(([^)]+)\)/u.exec(status);
  let health = match !== null && status.startsWith('Up ') ? (match[1] as string) : '';
  // Docker spells the transitional one "health: starting" inside the Status string, and
  // a bare "healthy"/"unhealthy" for the settled ones. Taken verbatim the panel rendered
  // "Health: health: starting".
  if (health.startsWith('health: ')) health = health.slice('health: '.length);
  const up = status.startsWith('Up ') ? (status.slice(3).split(' (')[0]?.trim() ?? '') : '';
  return [up, health];
}

/**
 * Why a running Kubernetes workspace's URL will not answer, or "".
 *
 * Only where a pid was actually recorded: `forwardAlive(null)` is false, and reading that
 * as "nothing is running" is the confusion this release spent itself removing.
 */
export async function forwardGap(meta: Metadata): Promise<string> {
  const extra = bag(meta.extra);
  const pid = extra.port_forward_pid;
  if (!isTruthy(pid)) return '';
  const ns = isTruthy(extra.namespace) ? String(extra.namespace) : await namespaceFor(meta.name);
  if (await forwardAlive(Number(pid), { namespace: ns, hostPort: meta.hostPort })) return '';
  return (
    'no port-forward, so the URL will not answer — ' +
    `\`houston ready --name ${meta.name}\` re-establishes it`
  );
}

/**
 * Clickable URLs for a repro: RC, extra instances, preset sidecars (S3, Keycloak,
 * Mailpit, widget), and monitoring -- [{label, url, kind}].
 */
/**
 * A composed workspace's presets as a list, for a reader that should not split the string.
 * ABSENT for one preset, so every other workspace's payload is byte for byte what it was.
 */
function presetsOf(meta: Metadata): { presets?: string[] } {
  const names = namesOf(scenarioOf(meta));
  return names.length > 1 ? { presets: names } : {};
}

/**
 * The presets without the deployment. Compose builds multi-instance through that preset, so
 * the record lists it among them, and the panel showed it as a preset chip beside the
 * deployment that already says so: it is the deployment, not a preset.
 */
function scenarioOf(meta: Metadata): string {
  return String(topology.axesOfMeta(meta).preset ?? meta.preset);
}

/**
 * What the panel badges: the CI build a workspace runs (its ghcr tag, or ''), whether it
 * was given a license, and whether Rocket.Chat refused it when `ready` last asked. Always
 * present, so the panel reads one shape.
 */
function buildAndLicense(meta: Metadata): {
  ci_build: string;
  licensed: boolean;
  license_refused: boolean;
} {
  const prefix = `${BUILD_IMAGE}:`;
  const tag = meta.rcImage.startsWith(prefix) ? meta.rcImage.slice(prefix.length) : '';
  const extra = bag(meta.extra);
  return {
    ci_build: isBuildTag(tag) ? tag : '',
    licensed: extra.licensed === true,
    license_refused: extra.license_status === 'refused',
  };
}

/** The side ports and replicas are published on the workspace's recorded bind. */
function linkHost(meta: Metadata): string {
  const recorded = bag(meta.extra).bind_host;
  if (typeof recorded === 'string' && recorded.trim() !== '') return callHost(recorded);
  // Older records predate bind_host but already carry the address readiness uses.
  try {
    return callHost(new URL(meta.rootUrl).hostname);
  } catch {
    return 'localhost';
  }
}

export function reproLinks(meta: Metadata): { label: string; url: string; kind: string }[] {
  const links = [{ label: 'Rocket.Chat', url: externalUrl(meta), kind: 'rc' }];
  const extra = bag(meta.extra);
  const host = linkHost(meta);
  if (externalUrl(meta) !== meta.rootUrl) {
    // Keep the plain http way in as well: with the local CA the browser warns until
    // `trust-ca` has run, and behind a proxy or tunnel this is the link that works here.
    links.push({ label: 'direct HTTP', url: meta.rootUrl, kind: 'rc' });
  }
  const n = extra.instances;
  if (typeof n === 'number' && Number.isInteger(n) && n > 1) {
    for (let i = 1; i <= n; i += 1) {
      links.push({
        label: `instance ${String(i)}`,
        url: `http://${host}:${String(meta.hostPort + i)}`,
        kind: 'rc',
      });
    }
  }
  // Every preset of a composed workspace, in its canonical order, on ITS ports: a second
  // workspace with the same preset was given others, and the registry's open someone else's.
  const held = sidePortsOf(meta);
  for (const name of namesOf(meta.preset)) {
    const linked = PRESET_LINKS[name] ?? [];
    const ports = linked.length > 0 ? presetPorts(name, held) : [];
    for (const [label, idx] of linked) {
      if (idx < ports.length) {
        links.push({
          label,
          url: `http://${host}:${String(ports[idx])}`,
          kind: 'sidecar',
        });
      }
    }
  }
  // ldap's OWN Keycloak, when it federates the directory (`--set idp=saml|oidc`): it is
  // published on the IdP preset's port, and linked by preset name only, so the console that
  // holds the directory's SSO users had no link -- unless HTTPS added its path.
  if (namesOf(meta.preset).includes('ldap') && !links.some((link) => link.label === 'Keycloak')) {
    const idp = String(
      bag(extra.params).idp ?? bag(bag(extra.preset_params).ldap).idp ?? '',
    ).toLowerCase();
    const port = idp === 'saml' || idp === 'oidc' ? presetPort(idp, 0, held) : undefined;
    if (port !== undefined) {
      links.push({ label: 'Keycloak', url: `http://${host}:${String(port)}`, kind: 'sidecar' });
    }
  }
  // Over HTTPS, a preset's own UIs at paths of the name (`lib/presets/public.ts`). Mailpit,
  // Keycloak and the MinIO console then answer only under their path, so their link IS the
  // public one, as is phpLDAPadmin's; the demo page keeps its own port (the cross-origin one)
  // and gains the same-origin path beside it.
  if (meta.publicUrl) {
    const base = meta.publicUrl.replace(/\/+$/u, '');
    for (const p of publicPathsOf(extra)) {
      const url = `${base}${p.path}/`;
      const label =
        (
          {
            mailpit: 'Mailpit',
            keycloak: 'Keycloak',
            'widget-site': 'Widget site',
            'minio-ui': 'MinIO console',
            phpldapadmin: 'phpLDAPadmin',
          } as Record<string, string>
        )[p.service] ?? p.service;
      const at = links.findIndex((link) => link.label === label);
      if (p.service !== 'widget-site' && at >= 0) links[at] = { label, url, kind: 'sidecar' };
      else
        links.push({
          label: p.service === 'widget-site' ? `${label} (same origin)` : label,
          url,
          kind: 'sidecar',
        });
    }
  }
  if (isTruthy(extra.monitoring)) {
    links.push({
      label: 'Grafana',
      url: grafanaUrlOf(meta),
      kind: 'monitor',
    });
    // Docker's alone: Kubernetes forwards Grafana and nothing else, so this link led nowhere.
    if (topology.ofMeta(meta) !== topology.KUBERNETES) {
      links.push({
        label: 'Prometheus',
        url: `http://localhost:${String(prometheusPortOf(meta))}`,
        kind: 'monitor',
      });
    }
  }
  return links;
}

/**
 * Only houston-served TLS publishes Grafana; every cluster stack uses the sub-path. On the
 * workspace's own Grafana port: a second monitored workspace's is not the preferred one.
 */
export function grafanaUrlOf(meta: Metadata): string {
  const publicUrl = isTruthy(bag(meta.extra).tls) ? meta.publicUrl : '';
  return grafanaUrl(
    publicUrl,
    topology.ofMeta(meta) === topology.KUBERNETES || !!publicUrl,
    grafanaPortOf(meta),
  );
}

/**
 * Origins the GUI may embed, derived from monitored workspaces: the public name of one served
 * by houston over HTTPS, and the loopback Grafana of every other, on its own port.
 */
export async function grafanaFrameOrigins(): Promise<string[]> {
  const origins = new Set<string>();
  for (const meta of await listMeta()) {
    if (!isTruthy(bag(meta.extra).monitoring)) continue;
    try {
      const url = new URL(grafanaUrlOf(meta));
      if (url.protocol === 'https:' || url.hostname === 'localhost') origins.add(url.origin);
    } catch {
      // A hand-edited invalid URL grants no iframe origin.
    }
  }
  return [...origins].sort();
}

/**
 * DERIVED here, not read out of the record. Every workspace created before the groups
 * existed -- and every workspace created before the next wording fix -- gets the current
 * shape and the current words, because this is a read.
 *
 * The recorded flat list is the fallback, and it is only reached by a workspace that has
 * notes no group accounts for (a preset that has since been deleted, a note some older
 * release appended by hand).
 */
/**
 * The cluster a Kubernetes workspace runs in: the context a command needs, and the short
 * name a person recognises. Both '' for a Compose workspace, and ALWAYS present -- a key
 * that appears only sometimes is how a payload drifts from what the tests render.
 */
export function clusterOf(meta: Metadata): { context: string; cluster: string } {
  const extra = bag(meta.extra);
  if (topology.ofMeta(meta) !== topology.KUBERNETES) return { context: '', cluster: '' };
  const context = isTruthy(extra[config.EXTRA_CONTEXT]) ? String(extra[config.EXTRA_CONTEXT]) : '';
  return { context, cluster: context === '' ? '' : shortName(context) };
}

export async function summary(meta: Metadata): Promise<Record<string, unknown>> {
  const groups = await notes.noteGroupsOf(meta);
  const extra = bag(meta.extra);
  const recorded = Array.isArray(extra.notes) ? extra.notes : [];
  const d: Record<string, unknown> = {
    notes: groups.length > 0 ? notes.flattenNotes(groups) : recorded,
    note_groups: groups,
    name: meta.name,
    rc_version: meta.rcVersion,
    mongo_tag: meta.mongoTag,
    mongo_flavor: meta.mongoFlavor,
    preset: scenarioOf(meta),
    ...presetsOf(meta),
    ...buildAndLicense(meta),
    root_url: meta.rootUrl,
    // The address a person opens, when the workspace has one: `up`'s result and the GUI's
    // create dialog offered only `root_url`, the http://localhost port, which from any other
    // machine is that machine's own. "" without HTTPS, as the list row and the panel say.
    public_url: meta.publicUrl,
    // What a person OPENS: the https name, else the address `--root-url` advertised (a
    // proxy's, a tunnel's), else the loopback port. Every "Open" took `public_url || root_url`,
    // which behind a tunnel is http://localhost -- the one address nobody outside can use.
    open_url: externalUrl(meta),
    host_port: meta.hostPort,
    login: { user: config.ADMIN_USERNAME, password: meta.adminPassword || config.ADMIN_PASSWORD },
    pinned: meta.pinned,
    // Which runtime, and how Rocket.Chat is arranged inside it. `listRepros` has carried
    // the runtime all along and the DETAIL payload had neither, so the panel rendered
    // every workspace as though it were Compose -- and offered actions the Kubernetes
    // path can only refuse.
    runtime: topology.ofMeta(meta),
    deployment: String(topology.axesOfMeta(meta).deployment ?? ''),
    ...clusterOf(meta),
  };
  // Whether this workspace HAS sample data, and whether the readback agreed. Always
  // present, never conditional -- a key that appears only sometimes is how the panel's
  // payload drifts from what the tests render.
  const seed = bag(extra.seed);
  d.seed =
    Object.keys(seed).length > 0
      ? {
          profile: seed.profile ?? '',
          at: seed.at ?? '',
          ok:
            bag(seed.verification).ok === true
              ? true
              : bag(seed.verification).ok === false
                ? false
                : null,
        }
      : null;
  const n = extra.instances;
  if (isTruthy(n)) {
    const count = Number(n);
    d.instances = count;
    d.instance_urls = Array.from(
      { length: count },
      (_unused, index) => `http://${linkHost(meta)}:${String(meta.hostPort + index + 1)}`,
    );
  }
  if (isTruthy(extra.monitoring)) {
    d.monitoring = true;
    d.grafana_url = grafanaUrlOf(meta);
  }
  return d;
}

export async function describe(name: string): Promise<Record<string, unknown>> {
  return await summary(await readMeta(await naming.resolveName(name)));
}

/**
 * One workspace as `list` and the GUI table see it.
 *
 * Its own function because the two runtimes answer "what state is this in" from
 * different places, and the branch that decides is three lines inside fifty.
 */
export async function rowFor(
  meta: Metadata,
  {
    default: defaultName,
    dockerUp,
    states,
    statusMap,
    svcMap,
    namespaces,
    kubeReads,
  }: {
    default: string;
    dockerUp: boolean;
    states: Record<string, string>;
    statusMap: Record<string, string>;
    svcMap: Record<string, Record<string, string>>;
    namespaces?: typeof workspaceNamespaces;
    kubeReads?: KubernetesReads;
  },
): Promise<Record<string, unknown>> {
  // Compose's answer is a Docker workspace's alone: one left under a Kubernetes record (as
  // 2.1.1's takeover left them) lent that row its own uptime and health.
  const rcStatus =
    topology.ofMeta(meta) === topology.KUBERNETES ? '' : (statusMap[meta.project] ?? '');
  // `states` is only consulted for "does this project have ANY container", never for the
  // state itself -- see reproState. A Kubernetes workspace has no compose project, so
  // asking docker whether its containers exist answered `down` for a workspace that was
  // running.
  let state: string;
  if (topology.ofMeta(meta) === topology.KUBERNETES) {
    state = await kubernetesState(meta.name, meta, namespaces, kubeReads);
  } else {
    state = dockerUp ? reproState(rcStatus, Boolean(states[meta.project])) : '?';
  }
  const [uptime, health] = uptimeHealth(rcStatus);
  let degradedWhy: string;
  if (topology.ofMeta(meta) === topology.KUBERNETES) {
    // `list` printed `running` beside a URL that refused connections, and only `info`
    // said otherwise. A port-forward dies with its pod, so this is the NORMAL state after
    // any restart. Carried in `degraded`, the field both front-ends already render for
    // the Compose side.
    degradedWhy = state === 'running' ? await forwardGap(meta) : '';
  } else {
    degradedWhy = state === 'running' ? degradedReason(svcMap[meta.project] ?? {}) : '';
  }
  const degraded = degradedWhy ? 'degraded' : '';
  const runtime = topology.ofMeta(meta);
  const extra = bag(meta.extra);
  const monitored = isTruthy(extra.monitoring);
  const owner = isTruthy(extra.owner)
    ? String(extra.owner)
    : isTruthy(extra.created_by)
      ? String(extra.created_by)
      : '';
  return {
    name: meta.name,
    created_by: owner,
    owner,
    made_by: isTruthy(extra.created_by) ? String(extra.created_by) : '',
    rc_version: meta.rcVersion,
    mongo_tag: meta.mongoTag,
    host_port: meta.hostPort,
    root_url: meta.rootUrl,
    state,
    runtime,
    ...clusterOf(meta),
    // The https URL when `up --https` was used; "" otherwise.
    public_url: meta.publicUrl,
    open_url: externalUrl(meta),
    tls: isTruthy(extra.tls) ? String(extra.tls) : '',
    preset: scenarioOf(meta),
    ...presetsOf(meta),
    pinned: meta.pinned,
    default: meta.name === defaultName,
    monitoring: monitored,
    created_at: meta.createdAt,
    uptime,
    health: degraded || health || (state === 'running' ? state : ''),
    degraded: degradedWhy,
    grafana_url: monitored ? grafanaUrlOf(meta) : null,
    links: reproLinks(meta),
  };
}

function shareContextRead<T>(
  probe: (context: string) => Promise<T>,
): (context: string) => Promise<T> {
  const reads = new Map<string, Promise<T>>();
  return (context) => {
    const held = reads.get(context);
    if (held !== undefined) return held;
    const reading = probe(context);
    reads.set(context, reading);
    return reading;
  };
}

export async function listRepros(): Promise<Record<string, unknown>[]> {
  const metas = await listMeta();
  const fallback = config.loadConfig().default_repro;
  const defaultName = isTruthy(fallback) ? String(fallback) : '';
  const dockerUp = await dockerAvailable();
  const [states, svcMap] = dockerUp
    ? await Promise.all([projectStates().then((value) => value ?? {}), servicesByProject()])
    : [{}, {}];
  // ONE docker ps for every service of every project, so the list and the panel cannot
  // disagree about whether a workspace is degraded -- which is exactly how they came to
  // disagree about `state` before reproState existed.
  const statusMap = dockerUp ? await rcStatusByProject(svcMap) : {};
  // Share a cluster read only within this list. Every poll asks again so a deleted
  // namespace or an unavailable cluster is never hidden behind an older answer.
  const reads = new Map<string, ReturnType<typeof workspaceNamespaces>>();
  const namespaces: typeof workspaceNamespaces = (context) => {
    const held = reads.get(context ?? '');
    if (held !== undefined) return held;
    const reading = workspaceNamespaces(context);
    reads.set(context ?? '', reading);
    return reading;
  };
  // A list needs current answers, but not one kubectl process per row and per question.
  // Keep these snapshots inside this call; a later poll must read the cluster again.
  // Broad RBAC is optional: a refused collection falls back to the original scoped probe.
  const replicas = shareContextRead(workspaceReplicasByNamespace);
  const pods = shareContextRead(workspacePodsByNamespace);
  const kubeReads: KubernetesReads = {
    workloadReplicas: async (name, options) => {
      const [seen, namespace] = await Promise.all([replicas(options.context), namespaceFor(name)]);
      return seen === null ? await workloadReplicas(name, options) : (seen.get(namespace) ?? null);
    },
    workspaceReady: async (name, options) => {
      const [seen, namespace] = await Promise.all([pods(options.context), namespaceFor(name)]);
      return seen === null
        ? await workspaceReady(name, options)
        : workspacePodsReady(seen.get(namespace) ?? []);
    },
    terminalPodFailure: async (name, options) => {
      const [seen, namespace] = await Promise.all([pods(options.context), namespaceFor(name)]);
      return seen === null
        ? await terminalPodFailure(name, options)
        : terminalFailureOfPods(seen.get(namespace) ?? []);
    },
  };
  return await mapLimit(metas, 4, async (meta) =>
    rowFor(meta, {
      default: defaultName,
      dockerUp,
      states,
      statusMap,
      svcMap,
      namespaces,
      kubeReads,
    }),
  );
}
