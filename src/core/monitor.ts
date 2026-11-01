/**
 * Attach/detach the Prometheus+Grafana monitoring add-on — shared by CLI and API.
 *
 * Raises `lib/errors` types and reports via `emit`; also used by the web GUI (and needed by
 * loadtest --live).
 *
 * Two runtimes, two shapes. On Compose the stack is written into the workspace's own
 * compose document and brought up with it. On Kubernetes the stack is SHARED by every
 * workspace on the cluster, so detaching is a reference-count question — that count lives
 * in `core/kube/monitoring.ts` and this module is the caller that supplies the workspace's
 * namespace.
 */
import { forEngine, toYaml, type ComposeDoc } from '../lib/compose';
import * as config from '../lib/config';
import { DockerError, NotReadyError, ValidationError, errorText } from '../lib/errors';
import { type Emit, info, nullEmit, warn } from '../lib/events';
import { toInt, quotedText, toText, isTruthy, valueKind, expectedText } from '../lib/format';
import * as monitoring from '../lib/monitoring';
import { publicPathsOf } from '../lib/presets/public';
import { record as auditRecord } from './audit';
import { register as registerRoute } from './edge/routes';

import { login } from './lifecycle/admin';
import { resolveName } from './lifecycle/naming';
import { claimMonitorPorts, withPortPublication } from './lifecycle/ports';
import { requireDocker } from './lifecycle/preconditions';
import { stopPortForward } from './lifecycle/ready';
import { setSetting } from './rcapi';
import { up, rmServices } from './runner/engine';
import { engine } from './runner/host';
import { reproLock } from './runner/locks';
import { removeVolumes } from './runner/queries';
import {
  type Metadata,
  adminPass,
  readCompose,
  readMeta,
  updateMeta,
  write,
} from './runner/record';
import * as topology from './topology';

type Bag = Record<string, unknown>;

function bagOf(value: unknown): Bag {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Bag;
}

/**
 * Whether a loaded YAML value is a mapping: an object of no class, its prototype null or
 * SOME realm's `Object.prototype` -- by shape, as `yaml-dump`'s `isPlainObject` asks,
 * because a `structuredClone` hands back objects of another realm under jest.
 */
function isMapping(value: unknown): value is Bag {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

/**
 * `value`, when it is the mapping a compose document holds there; else refused, in the
 * established words.
 *
 * `bagOf` read a service with no body (`mongodb:` alone is null) as `{}`, and a list or a
 * string where a mapping belongs the same: `monitor` then wrote the monitoring services, 14
 * files and the record, and ran `docker compose pull` and `up`, where earlier releases died
 * with a stack trace. It is refused now, by the previous implementation too.
 */
function mapping(value: unknown, what: string, name: string): Bag {
  if (!isMapping(value)) {
    throw new ValidationError(
      `cannot edit the compose file of ${quotedText(name)}: ${what} is ${valueKind(value)}, ` +
        'not a mapping',
    );
  }
  return value;
}

/** The key's value, or `fallback` only when the key is absent -- not when it is null. */
function held(doc: Bag, key: string, fallback: unknown): unknown {
  return Object.hasOwn(doc, key) ? doc[key] : fallback;
}

/**
 * The mapping the key holds, which is refused when it holds something else, or a new one,
 * stored, when it holds nothing.
 */
function setDefault(doc: Bag, key: string, name: string): Bag {
  if (!Object.hasOwn(doc, key)) doc[key] = {};
  return mapping(doc[key], `'${key}'`, name);
}

/**
 * The items of what a JSON record holds: a list's items, a string's characters, a
 * mapping's keys. Anything else is a TypeError, which nothing on the way up catches.
 *
 * `extra.notes` was kept only when it was an array: a string was dropped where the
 * established reading keeps each of its characters as a note, and a mapping its keys.
 */
function listChecked(value: unknown): unknown[] {
  if (Array.isArray(value)) return [...value];
  if (typeof value === 'string') return Array.from(value);
  if (value !== null && typeof value === 'object') return Object.keys(value);
  throw new TypeError(expectedText('a list', value));
}

/**
 * The recorded notes without the monitoring ones: compared as values, where
 * `String(note)` made a `["Grafana: ..."]` list the note it held.
 */
function notesWithoutMonitoring(extra: Bag): unknown[] {
  return listChecked(held(extra, 'notes', [])).filter((note) => !monitoring.isMonitoringNote(note));
}

async function updateDockerRoute(m: Metadata, grafana: boolean): Promise<void> {
  const extra = bagOf(m.extra);
  if (!isTruthy(extra.tls) || !m.publicUrl) return;
  await registerRoute(m.name, new URL(m.publicUrl).hostname, {
    instances: typeof extra.instances === 'number' ? extra.instances : 1,
    local: extra.tls === 'local',
    grafana,
    // Attaching or detaching monitoring rewrites the route: the preset's paths stay on it.
    publicPaths: publicPathsOf(extra),
  });
}

/**
 * Host bind interface from an existing published port (ip:host:container).
 *
 * A service that is not a mapping is refused where the loop reaches it: one after a
 * three-part port is never read, as it never has been.
 */
export function detectBind(doc: Bag, name = ''): string {
  for (const [service, svc] of Object.entries(
    mapping(held(doc, 'services', {}), "'services'", name),
  )) {
    const ports = mapping(svc, `service ${quotedText(service)}`, name).ports;
    for (const p of Array.isArray(ports) ? ports : []) {
      const parts = String(p).split(':');
      if (parts.length === 3) return parts[0] as string;
    }
  }
  return config.DEFAULT_BIND_HOST;
}

export function rcServicesIn(doc: Bag): string[] {
  return Object.keys(bagOf(doc.services)).filter(
    (service) => service === 'rocketchat' || service.startsWith('rocketchat-'),
  );
}

export async function attach(name: string, emit: Emit = nullEmit): Promise<Bag> {
  const target = await resolveName(name);
  if ((await topology.ofRepro(target)) === topology.KUBERNETES) {
    return await attachKubernetes(target, emit);
  }
  await requireDocker();
  // Same read-compose -> write-compose -> `docker compose up` shape as env and backup, so
  // it takes the same per-repro lock.
  return await reproLock(target, async () => await attachLocked(target, emit));
}

export async function attachLocked(target: string, emit: Emit = nullEmit): Promise<Bag> {
  const m = await readMeta(target);
  const doc = await readCompose(m.name);
  try {
    const auth = await login(m);
    if (!(await setSetting(m.rootUrl, auth, adminPass(m), monitoring.RC_METRICS_SETTING, true))) {
      warn(emit, 'could not enable RC metrics via the API (is it ready?)', { phase: 'config' });
    }
  } catch (exc) {
    throw new NotReadyError(
      `workspace not reachable to enable metrics (ready first): ${errorText(exc)}`,
    );
  }

  const services = setDefault(doc, 'services', m.name);
  const publicUrl = isTruthy(bagOf(m.extra).tls) ? m.publicUrl : '';
  const targets = rcServicesIn(doc);
  // Chosen and written down under the port lock, as a create does, so two attaches at once --
  // or one beside a create -- cannot be given the same pair. The slow part (the login and the
  // setting above) is already done; the `up` below runs after the lock is released.
  const { grafana, notes } = await withPortPublication(async () => {
    const [prometheusPort = 0, grafanaPort = 0] = await claimMonitorPorts(m.name, [
      'prometheus',
      'grafana',
    ]);
    const url = monitoring.grafanaUrl(publicUrl, !!publicUrl, grafanaPort);
    const lines = monitoring.notes(url, prometheusPort);
    Object.assign(
      services,
      monitoring.bindPorts(
        monitoring.services(publicUrl, [prometheusPort, grafanaPort]),
        detectBind(doc, m.name),
      ),
    );
    Object.assign(setDefault(doc, 'volumes', m.name), monitoring.volumes());
    const extra = bagOf(m.extra);
    m.extra = extra;
    extra.monitoring = true;
    extra.monitoring_ports = [prometheusPort, grafanaPort];
    extra.notes = [...notesWithoutMonitoring(extra), ...lines];
    await write(
      m.name,
      toYaml(forEngine(doc as unknown as ComposeDoc, await engine())),
      m,
      monitoring.files(targets.length > 0 ? targets : ['rocketchat'], m.project),
    );
    return { grafana: url, notes: lines };
  });

  info(emit, 'attaching monitoring (pulling images if needed)...', { phase: 'boot' });
  if ((await up(m.name, { pull: true })) !== 0) {
    throw new DockerError('`docker compose up` failed bringing up monitoring');
  }
  await updateDockerRoute(m, true);
  // The detail is ONE key named `data` inside the event's data: it nests, on the stream
  // and in houston.log, as it always has, and the wire keeps that shape.
  info(emit, `monitoring attached to ${quotedText(m.name)}`, {
    phase: 'done',
    data: { data: { grafana_url: grafana, notes } },
  });
  return {
    name: m.name,
    monitoring: true,
    grafana_url: grafana,
    notes,
  };
}

/**
 * (namespace, context) for a Kubernetes workspace, defaulted like lifecycle's.
 *
 * `namespaceFor` is consulted only when the record does not name one — the lookup reads the
 * record back off disk.
 */
export async function kubeTarget(m: Metadata): Promise<[string, string]> {
  const extra = bagOf(m.extra);
  const { namespaceFor } = await import('./kube/namespace');
  const { CONTEXT } = await import('./kube/names');
  const namespace = String(
    isTruthy(extra.namespace) ? extra.namespace : await namespaceFor(m.name),
  );
  const context = String(
    isTruthy(extra[config.EXTRA_CONTEXT]) ? extra[config.EXTRA_CONTEXT] : CONTEXT,
  );
  return [namespace, context];
}

/**
 * Point the cluster's shared stack at this workspace, and publish Grafana.
 *
 * Nothing is installed INTO the workspace. Rocket.Chat's chart already publishes a
 * PodMonitor wherever the cluster serves that kind — `podMonitor.enabled` and
 * `prometheusScraping.enabled` are its defaults — so what `--monitor` supplies is the
 * Prometheus willing to read it, which lives once per cluster. That makes this a much
 * cheaper operation than its Compose twin, and a shared one: see `kube/monitoring`'s
 * `removeMonitoring`.
 *
 * RC's own `Prometheus_Enabled` setting is turned on the same way as on Compose, over the
 * same REST seam, because the port-forward makes the workspace reachable at exactly the
 * URL the record already holds.
 */
export async function attachKubernetes(target: string, emit: Emit = nullEmit): Promise<Bag> {
  const k8s = await import('./kube/monitoring');
  const { forwardReachable, grafanaForward } = await import('./kube/forward');
  const m = await readMeta(target);
  const [namespace, context] = await kubeTarget(m);
  await (await import('./kube/namespace')).requireOwnNamespace(m.name, { context });
  const extra = bagOf(m.extra);
  const publicUrl = isTruthy(extra.tls) ? m.publicUrl : '';
  try {
    const auth = await login(m);
    if (!(await setSetting(m.rootUrl, auth, adminPass(m), monitoring.RC_METRICS_SETTING, true))) {
      warn(emit, 'could not enable RC metrics via the API (is it ready?)', { phase: 'config' });
    }
  } catch (exc) {
    throw new NotReadyError(
      `workspace not reachable to enable metrics (ready first): ${errorText(exc)}`,
    );
  }

  // CLAIMED FIRST. The label is the reference count every teardown reads, from any home;
  // set after the install, another workspace's `down --volumes` during the install found no
  // user and removed the stack under it. The reverse race -- a removal already past its count
  // when this starts -- is still open, and only a lock in the cluster itself would close it.
  await k8s.setMonitoringLabel(namespace, { context, wanted: true });
  await k8s.ensureMonitoring({ context, emit, publicUrl });
  // The stack is what brings the PodMonitor CRD, so a release installed before it -- every
  // first `up --monitor` -- has no PodMonitor until it is rendered again. Under the
  // workspace's lock, which `up` already holds: an `upgrade` holding it would otherwise race
  // the re-render, and helm refuses one of them or puts the old image back.
  await reproLock(target, async () => {
    await k8s.ensurePodMonitor({ namespace, context, emit });
  });
  if (publicUrl) {
    const { ensureGrafanaIngress } = await import('./kube/grafana-ingress');
    await ensureGrafanaIngress(m.name, {
      context,
      publicUrl,
      ingressClass: toText(extra.ingress_class),
      issuer: { mode: toText(extra.tls), acmeStaging: Boolean(extra.tls_staging) },
      emit,
    });
  }
  // This box's Grafana forward: its own port while it holds one, else preferred first --
  // chosen and claimed under the port lock (inside the workspace's, the order every create
  // takes them in) so a concurrent attach or create cannot be given the same one.
  const port = publicUrl
    ? 0
    : await reproLock(
        target,
        async () =>
          await withPortPublication(async () => {
            const [grafana = 0] = await claimMonitorPorts(m.name, ['grafana']);
            await updateMeta(m.name, (meta) => {
              const claimed = bagOf(meta.extra);
              meta.extra = claimed;
              claimed.monitoring_ports = [grafana];
            });
            return grafana;
          }),
      );
  const previousPid = extra.grafana_pid;
  if (isTruthy(previousPid))
    await stopPortForward(toInt(previousPid), { namespace: k8s.MONITORING_NAMESPACE });
  // Public workspaces use the Ingress, so several of them can share a cluster without
  // competing for this box's single localhost:5050 forward.
  const pid = publicUrl
    ? 0
    : await grafanaForward({
        context,
        hostPort: port,
        bindHost: toText(bagOf(m.extra).bind_host),
      });
  await updateMeta(m.name, (meta) => {
    const extra = bagOf(meta.extra);
    meta.extra = extra;
    extra.monitoring = true;
    if (publicUrl) {
      delete extra.monitoring_ports;
      delete extra.grafana_pid;
    } else {
      extra.monitoring_ports = [port];
      extra.grafana_pid = pid;
    }
  });
  const grafana = monitoring.grafanaUrl(publicUrl, true, port);
  // Don't hand over a URL that has not answered yet. `port-forward` returns a pid before
  // it binds the socket, and the workspace path already carries a test named for this
  // exact mistake — so this waits, and says so rather than printing a link that quietly
  // does not work.
  if (!publicUrl && !(await forwardReachable(port))) {
    warn(
      emit,
      `Grafana is installed but ${grafana} is not answering yet; ` +
        `re-run \`houston monitor --name ${m.name}\` if it stays quiet`,
      { phase: 'monitor' },
    );
  }
  // The detail is ONE key named `data` inside the event's data: it nests, on the stream
  // and in houston.log, as it always has, and the wire keeps that shape.
  info(emit, `monitoring attached to ${quotedText(m.name)}`, {
    phase: 'done',
    data: { data: { grafana_url: grafana } },
  });
  return {
    name: m.name,
    monitoring: true,
    grafana_url: grafana,
    notes: [
      `Grafana: ${grafana} (admin/admin)`,
      'the stack is SHARED by every workspace on this cluster',
    ],
  };
}

/** Stop wanting the shared stack; uninstall it only if nobody else does. */
export async function detachKubernetes(target: string, emit: Emit = nullEmit): Promise<Bag> {
  const k8s = await import('./kube/monitoring');
  const m = await readMeta(target);
  const [namespace, context] = await kubeTarget(m);
  // Its own namespace still: by name, `--off` stripped the label of a namespace another home
  // had made in this one's place, and could uninstall the stack that home was using.
  await (await import('./kube/namespace')).requireOwnNamespace(m.name, { context });
  if (isTruthy(bagOf(m.extra).tls)) await k8s.removeGrafanaIngress(m.name, { context, emit });
  let rcOk = false;
  // EMITTED, not silent. Removing the shared stack can take minutes — it deletes operator
  // custom resources and then uninstalls a release — and this function used to say nothing
  // at all until it was finished. A GUI job then showed "running" with an empty log for
  // the whole time, which is indistinguishable from a hang; that is exactly how a
  // nine-minute finalizer wait was reported as one.
  info(emit, `turning Rocket.Chat's metrics off in ${quotedText(m.name)}`, { phase: 'monitor' });
  try {
    const auth = await login(m);
    rcOk = await setSetting(m.rootUrl, auth, adminPass(m), monitoring.RC_METRICS_SETTING, false);
  } catch {
    // best-effort; the repro may be stopped
  }
  if (!rcOk) {
    info(
      emit,
      'the workspace did not answer, so its metrics setting was left as it is — the stack ' +
        'still comes down',
      { phase: 'monitor' },
    );
  }
  await k8s.setMonitoringLabel(namespace, { context, wanted: false });
  info(emit, 'checking whether another workspace still wants the shared stack', {
    phase: 'monitor',
  });
  const removed = await k8s.removeMonitoring({ context, emit });
  const pid = bagOf(m.extra).grafana_pid;
  if (isTruthy(pid)) {
    // The Grafana forward lives in the SHARED monitoring namespace, not the workspace's —
    // so that is the identity to prove before signalling a pid. `toInt(pid)`, which
    // rejects `0x10` and `1e3` rather than reading them as numbers.
    await stopPortForward(toInt(pid), { namespace: k8s.MONITORING_NAMESPACE });
  }
  await updateMeta(m.name, (meta) => {
    const extra = bagOf(meta.extra);
    meta.extra = extra;
    for (const key of ['monitoring', 'monitoring_ports', 'grafana_pid']) delete extra[key];
  });
  // The detail is ONE key named `data` inside the event's data: it nests, on the stream
  // and in houston.log, as it always has, and the wire keeps that shape.
  info(emit, `monitoring detached from ${quotedText(m.name)}`, {
    phase: 'done',
    data: { data: { rc_setting_reset: rcOk, stack_removed: removed } },
  });
  return { name: m.name, monitoring: false, rc_setting_reset: rcOk, stack_removed: removed };
}

export async function detach(name: string, emit: Emit = nullEmit): Promise<Bag> {
  const target = await resolveName(name);
  if ((await topology.ofRepro(target)) === topology.KUBERNETES) {
    return await detachKubernetes(target, emit);
  }
  await requireDocker();
  // Same read-compose -> write-compose -> `docker compose up` shape as env and backup, so
  // it takes the same per-repro lock.
  return await reproLock(target, async () => await detachLocked(target, emit));
}

export async function detachLocked(target: string, emit: Emit = nullEmit): Promise<Bag> {
  const m = await readMeta(target);
  const doc = await readCompose(m.name);
  await updateDockerRoute(m, false);
  let rcOk = false;
  // Same reasoning as the Kubernetes path above: this had two emits and the last one was
  // at the end, so there was nothing to tell "working" from "wedged".
  info(emit, `turning Rocket.Chat's metrics off in ${quotedText(m.name)}`, { phase: 'monitor' });
  try {
    const auth = await login(m);
    rcOk = await setSetting(m.rootUrl, auth, adminPass(m), monitoring.RC_METRICS_SETTING, false);
  } catch {
    // best-effort; the repro may be stopped
  }
  if (!rcOk) {
    info(
      emit,
      'the workspace did not answer, so its metrics setting was left as it is — the ' +
        'containers still come down',
      { phase: 'monitor' },
    );
  }
  info(emit, `removing ${String(monitoring.SERVICES.length)} monitoring container(s)`, {
    phase: 'monitor',
  });
  await rmServices(m.name, [...monitoring.SERVICES]);
  info(emit, 'removing the monitoring volumes', { phase: 'monitor' });
  // Recorded, as every removal of data is: Prometheus, Grafana and Loki's history.
  auditRecord('monitor-off', m.name);
  // Remove the volumes while they are still DECLARED. `docker compose down -v` only
  // removes declared volumes, so dropping them from the doc below without deleting them
  // first orphans prometheus_tsdb/grafana_data/loki_data forever.
  for (const bad of await removeVolumes(m.name, [...monitoring.VOLUMES])) {
    warn(emit, `could not remove monitoring volume ${bad} - remove it by hand`, {
      phase: 'done',
    });
  }
  // From the mappings the file holds, and never into it: `doc.services` and `doc.volumes`
  // were assigned whatever was there, so a compose file with no `volumes:` was written back
  // with `volumes: {}` and an empty one as `services: {}` and `volumes: {}`, where the
  // established file is `{}`. One that is not a mapping is refused, as in `attach`.
  const services = mapping(held(doc, 'services', {}), "'services'", m.name);
  for (const service of monitoring.SERVICES) delete services[service];
  const volumes = mapping(held(doc, 'volumes', {}), "'volumes'", m.name);
  for (const volume of monitoring.VOLUMES) delete volumes[volume];
  const extra = bagOf(m.extra);
  m.extra = extra;
  delete extra.monitoring;
  delete extra.monitoring_ports;
  extra.notes = notesWithoutMonitoring(extra);
  await write(m.name, toYaml(doc as unknown as ComposeDoc), m);
  // The detail is ONE key named `data` inside the event's data: it nests, on the stream
  // and in houston.log, as it always has, and the wire keeps that shape.
  info(emit, `monitoring detached from ${quotedText(m.name)}`, {
    phase: 'done',
    data: { data: { rc_setting_reset: rcOk } },
  });
  return { name: m.name, monitoring: false, rc_setting_reset: rcOk };
}
