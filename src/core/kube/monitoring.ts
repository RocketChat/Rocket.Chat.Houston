/**
 * Prometheus and Grafana in the cluster, attachable to any workspace.
 *
 * Shared, like the operator, and reference-counted the same careful way.
 */
import { CreateFailedError, DockerError } from '../../lib/errors';
import { info, nullEmit, warn, type Emit } from '../../lib/events';
import { dashboard } from '../../lib/monitoring';

import {
  absent,
  askList,
  askObject,
  classify,
  items,
  present,
  refused,
  require_,
  why,
} from './ask';
import { workspaceNamespaces } from './capabilities';
import { helmEnv, kube } from './exec';
import {
  APPLY_TIMEOUT,
  HELM_REPO,
  HELM_REPO_URL,
  INSTALL_TIMEOUT,
  NAMESPACE_PREFIX,
  OWNER_SELECTOR,
  OWNER_LABEL_KEY,
  OWNER_LABEL_VALUE,
  RELEASE,
  WORKSPACE_LABEL,
  isOurs,
} from './names';
import {
  OPERATOR_NAMESPACE,
  OPERATOR_RELEASE,
  releaseInstalled,
  waitForSystemNamespace,
} from './operator';
import {
  apply,
  clearPendingRelease,
  helmRollbackOnFailure,
  releaseState,
  releaseValues,
  rerenderRelease,
} from './release';
import type { Sleep } from './replicaset';

const realSleep: Sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/**
 * The namespace label that says a workspace wants the shared stack. One name, in one
 * place: it was a literal at the setter AND a literal in the reference count, which is two
 * chances to disagree about the thing that decides whether the shared stack gets
 * uninstalled.
 */
export const MONITORING_LABEL = 'houston.io/monitoring';

export const MONITORING_RELEASE = 'monitoring';

export const MONITORING_CHART = `${HELM_REPO}/monitoring`;

/**
 * Installed ONCE per cluster, next to the MongoDB operator, for the same reason and then
 * one more. kube-prometheus-stack owns cluster-scoped CRDs, so a per-workspace install
 * collides on them at the second workspace. And even with every dependency disabled the
 * chart still renders a ClusterRole and ClusterRoleBinding at FIXED names plus a
 * log-collector DaemonSet -- so the per-namespace install that looks like the compose
 * shape does not compose either, and would put one collector per node per workspace on the
 * same host paths.
 *
 * Sharing is also what makes this affordable: one 1.0 GB stack for every workspace on the
 * box rather than 1.0 GB each, on a tool whose capacity preflight exists because it runs on
 * laptops.
 */
export const MONITORING_NAMESPACE = OPERATOR_NAMESPACE;

/**
 * grafana-operator names the Grafana instance's Service this; `monitoring-grafana` is the
 * operator itself and serves nothing useful. Forwarding the wrong one gives a page that
 * loads and has no dashboards.
 */
export const GRAFANA_SERVICE = 'monitoring-grafana-service';

export const GRAFANA_DEPLOYMENT = 'monitoring-grafana-deployment';

export const GRAFANA_PORT = 3000;
export const GRAFANA_INGRESS_LABEL = 'houston.io/grafana-ingress';

function bag(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function containersOf(doc: Record<string, unknown>): Record<string, unknown>[] {
  const containers = bag(bag(bag(doc.spec).template).spec).containers;
  return Array.isArray(containers) ? containers.map(bag) : [];
}

const GRAFANA_ENV = {
  GF_SERVER_SERVE_FROM_SUB_PATH: 'true',
  GF_AUTH_ANONYMOUS_ENABLED: 'true',
  GF_AUTH_ANONYMOUS_ORG_ROLE: 'Viewer',
  GF_SECURITY_ALLOW_EMBEDDING: 'true',
};

/** Share the same Logs dashboard as Docker, using the chart's Loki datasource. */
async function ensureLogsDashboard(context: string): Promise<void> {
  const name = `${MONITORING_RELEASE}-houston-logs`;
  // APPLY_TIMEOUT for every must-answer question on the attach path, for the reason
  // `removeGrafanaIngress` gives: a refusal fails the job, and nobody is waiting on a screen.
  const seen = require_(
    await askObject('grafanadashboard', name, {
      context,
      namespace: MONITORING_NAMESPACE,
      timeout: APPLY_TIMEOUT,
    }),
    'the shared Logs dashboard',
    { context },
  );
  if (present(seen) && bag(bag(seen.doc.metadata).labels)[OWNER_LABEL_KEY] !== OWNER_LABEL_VALUE)
    throw new CreateFailedError(`refusing to replace '${name}': it is not owned by houston`);
  await apply(
    JSON.stringify({
      apiVersion: 'grafana.integreatly.org/v1beta1',
      kind: 'GrafanaDashboard',
      metadata: {
        name,
        namespace: MONITORING_NAMESPACE,
        labels: { [OWNER_LABEL_KEY]: OWNER_LABEL_VALUE, dashboards: 'grafana' },
      },
      spec: {
        allowCrossNamespaceImport: true,
        folder: 'General',
        instanceSelector: { matchLabels: { grafana: 'dashboards' } },
        datasources: [{ inputName: 'DS_LOKI', datasourceName: 'loki' }],
        // Docker provisions a fixed UID; the operator resolves ${DS_LOKI} to
        // this cluster's chart-provisioned datasource named "loki".
        json: dashboard('houston-logs.json').replaceAll('"DS_LOKI"', '"${DS_LOKI}"'),
      },
    }),
    { context, namespace: MONITORING_NAMESPACE },
  );
}

/** The chart has no values for anonymous viewing or embedding, so configure its CR. */
async function configureGrafana(context: string, rootUrl: string): Promise<boolean> {
  const seen = require_(
    await askObject('grafana', `${MONITORING_RELEASE}-grafana`, {
      context,
      namespace: MONITORING_NAMESPACE,
      timeout: APPLY_TIMEOUT,
    }),
    'the shared Grafana configuration',
    { context },
  );
  if (!present(seen)) throw new CreateFailedError('the monitoring chart did not create Grafana');
  const spec = bag(seen.doc.spec);
  const containers = containersOf(bag(spec.deployment));
  const grafana = containers.find((container) => container.name === 'grafana');
  if (grafana === undefined)
    throw new CreateFailedError('the shared Grafana has no container configuration');
  const env = Array.isArray(grafana.env) ? grafana.env.map(bag) : [];
  const wanted = { ...GRAFANA_ENV, GF_SERVER_ROOT_URL: rootUrl };
  if (
    Object.entries(wanted).every(([name, value]) =>
      env.some((entry) => entry.name === name && entry.value === value),
    )
  )
    return false;
  const updated = env.filter((entry) => !(String(entry.name) in wanted));
  updated.push(...Object.entries(wanted).map(([name, value]) => ({ name, value })));
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      MONITORING_NAMESPACE,
      'patch',
      'grafana',
      `${MONITORING_RELEASE}-grafana`,
      '--type=merge',
      '-p',
      JSON.stringify({
        spec: {
          deployment: {
            spec: {
              template: {
                spec: {
                  containers: containers.map((container) =>
                    container === grafana ? { ...container, env: updated } : container,
                  ),
                },
              },
            },
          },
        },
      }),
    ],
    { own: isOurs(context), timeout: APPLY_TIMEOUT },
  );
  if (res.returncode !== 0)
    throw new CreateFailedError(`could not configure shared Grafana: ${why(res)}`);
  return true;
}

/**
 * Up to four minutes. The operator has to reconcile a Grafana CR into a Deployment and then
 * pull its image, which is well past what helm's own wait allows for.
 */
export const GRAFANA_WAIT_TRIES = 48;

export const GRAFANA_WAIT_INTERVAL = 5.0;

/**
 * cert-manager's namespace is baked into its own manifests and its CRDs are cluster-scoped,
 * so it is not one of ours to place.
 */
export const CERT_MANAGER_NAMESPACE = 'cert-manager';

/**
 * Whether this cluster already has a WORKING shared stack.
 *
 * `helm status` exits 0 for a release in any state, including one a killed install left in
 * `pending-install` -- so this returned true for a namespace holding no Prometheus and no
 * Grafana, the install was skipped, and `monitor` reported the stack attached. The
 * dashboards did not exist.
 *
 * Only `deployed` means there is something to leave alone; pending, failed and absent all
 * mean the install below should run, and it is `upgrade --install`, so running it is the
 * repair.
 */
export async function monitoringInstalled(context: string): Promise<boolean> {
  try {
    const [state] = await releaseState(MONITORING_RELEASE, MONITORING_NAMESPACE, context);
    return state === 'deployed';
  } catch (error) {
    // Could not ask. Not "installed" -- the caller's next step is an idempotent `upgrade
    // --install`, which is the safer way to be wrong here.
    if (error instanceof DockerError) return false;
    throw error;
  }
}

/**
 * Wait for the Grafana the operator builds, in two steps, because it arrives late.
 *
 * `monitoring-grafana-deployment` does not exist when helm returns: the grafana-operator
 * has to see the Grafana custom resource and create it. So this waits for the Deployment to
 * EXIST and only then for it to be available -- `kubectl rollout status` on a missing
 * Deployment is an error, not a wait, which would turn "not yet" into "failed".
 */
export async function waitForGrafana({
  context,
  emit = nullEmit,
  sleep = realSleep,
  rootUrl = '',
}: {
  context: string;
  emit?: Emit;
  sleep?: Sleep;
  rootUrl?: string;
}): Promise<void> {
  for (let attempt = 0; attempt < GRAFANA_WAIT_TRIES; attempt += 1) {
    if (rootUrl) {
      const seen = require_(
        await askObject('deployment', GRAFANA_DEPLOYMENT, {
          context,
          namespace: MONITORING_NAMESPACE,
          timeout: APPLY_TIMEOUT,
        }),
        'the shared Grafana deployment',
        { context },
      );
      if (present(seen)) {
        const spec = bag(seen.doc.spec);
        const status = bag(seen.doc.status);
        const env = containersOf(seen.doc).find((container) => container.name === 'grafana')?.env;
        const wanted = { ...GRAFANA_ENV, GF_SERVER_ROOT_URL: rootUrl };
        if (
          Array.isArray(env) &&
          Object.entries(wanted).every(([name, value]) =>
            env.some((entry: unknown) => bag(entry).name === name && bag(entry).value === value),
          ) &&
          Number(status.observedGeneration) >= Number(bag(seen.doc.metadata).generation) &&
          Number(status.updatedReplicas) === Number(spec.replicas ?? 1) &&
          Number(status.availableReplicas) >= Number(spec.replicas ?? 1)
        )
          return;
      }
      if (attempt % 5 === 0)
        info(emit, 'waiting for Grafana to reconcile its /grafana configuration', {
          phase: 'monitor',
        });
      await sleep(GRAFANA_WAIT_INTERVAL);
      continue;
    }
    const res = await kube.run(
      [
        'kubectl',
        '--context',
        context,
        '-n',
        MONITORING_NAMESPACE,
        'get',
        'deployment',
        GRAFANA_DEPLOYMENT,
        '-o',
        'jsonpath={.status.availableReplicas}',
      ],
      { own: isOurs(context) },
    );
    const seen = res.stdout.trim();
    if (seen !== '' && seen !== '0') return;
    if (attempt % 5 === 0) info(emit, 'waiting for Grafana', { phase: 'monitor' });
    await sleep(GRAFANA_WAIT_INTERVAL);
  }
  warn(
    emit,
    'Grafana has not come up yet; the stack is installed and it should appear shortly — ' +
      `kubectl -n ${MONITORING_NAMESPACE} get pods`,
    { phase: 'monitor' },
  );
}

/** The kind the Rocket.Chat chart's PodMonitor is, which the shared stack brings. */
export const PODMONITOR_CRD = 'podmonitors.monitoring.coreos.com';

/** How long a just-installed CRD gets to be served, in seconds. */
export const CRD_WAIT = 60;

/**
 * Have the workspace's release publish its PodMonitor, once the cluster can hold one.
 *
 * The chart renders its PodMonitor only where the cluster serves that kind, and a first
 * `up --monitor` installs the release BEFORE the shared stack brings the CRD -- the stack
 * waits for a workspace that serves. So helm rendered no PodMonitor, Prometheus had no target
 * and Grafana's Rocket.Chat dashboard was empty, until a re-up happened to render the release
 * again. Rendered again here instead, once the CRD is Established, when the chart wants a
 * PodMonitor and the namespace has none; a release rendered after the CRD already has one.
 */
export async function ensurePodMonitor({
  namespace,
  context,
  emit = nullEmit,
}: {
  namespace: string;
  context: string;
  emit?: Emit;
}): Promise<void> {
  const established = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      'wait',
      '--for=condition=Established',
      `crd/${PODMONITOR_CRD}`,
      `--timeout=${String(CRD_WAIT)}s`,
    ],
    { timeout: CRD_WAIT + APPLY_TIMEOUT, own: isOurs(context) },
  );
  if (established.returncode !== 0) {
    warn(
      emit,
      `Prometheus cannot find Rocket.Chat: the cluster does not serve ${PODMONITOR_CRD} ` +
        `(${why(established)})`,
      { phase: 'monitor' },
    );
    return;
  }
  const values = await releaseValues(RELEASE, namespace, context, { all: true });
  if (bag(values.podMonitor).enabled !== true) return; // a chart that publishes none
  const monitors = require_(
    await askList('podmonitors', { context, namespace, timeout: APPLY_TIMEOUT }),
    `the PodMonitors in ${namespace}`,
    { context },
  );
  if (items(monitors).length > 0) return;
  info(
    emit,
    'rendering the Rocket.Chat release again, now that the cluster serves PodMonitors, so ' +
      'Prometheus finds it',
    { phase: 'monitor' },
  );
  await rerenderRelease(namespace, context);
}

/**
 * Install the shared stack, or leave the existing one alone.
 *
 * The two `...SelectorNilUsesHelmValues=false` overrides are the whole reason a shared stack
 * works. kube-prometheus-stack defaults them to true, which restricts Prometheus to monitors
 * carrying its OWN release label -- so a workspace's PodMonitor, in a different namespace
 * and a different release, is ignored and Grafana shows a dashboard with no data. Nothing
 * errors; the graphs are simply empty.
 *
 * Rocket.Chat's own chart needs nothing: the PodMonitor is already its default. The scrape
 * starts because the shared Prometheus is willing to look outside its own release, not
 * because `--monitor` changed anything about the workspace.
 */
export async function ensureMonitoring({
  context,
  emit = nullEmit,
  publicUrl = '',
}: {
  context: string;
  emit?: Emit;
  publicUrl?: string;
}): Promise<void> {
  await kube.run(['helm', 'repo', 'add', HELM_REPO, HELM_REPO_URL, '--force-update'], {
    timeout: APPLY_TIMEOUT,
    env: helmEnv(context),
  });
  const installed = await monitoringInstalled(context);
  let values: Record<string, unknown> = {};
  if (installed) {
    const result = await kube.run(
      [
        'helm',
        'get',
        'values',
        MONITORING_RELEASE,
        '-n',
        MONITORING_NAMESPACE,
        '--kube-context',
        context,
        '-o',
        'json',
      ],
      { timeout: APPLY_TIMEOUT, env: helmEnv(context) },
    );
    if (result.returncode !== 0)
      throw new DockerError(`could not read shared monitoring values: ${why(result)}`);
    try {
      values = bag(JSON.parse(result.stdout));
    } catch {
      throw new DockerError('could not read shared monitoring values: invalid JSON');
    }
  }
  const ingress = bag(values.ingress);
  const grafana = bag(ingress.grafana);
  const existingHost = typeof grafana.host === 'string' ? grafana.host : '';
  const publicHost = publicUrl ? new URL(publicUrl).host : '';
  // The first public host becomes canonical; later hosts share relative paths without
  // flipping this shared setting and restarting everybody's Grafana.
  // shortcut: one Grafana per cluster, so its root URL names the preferred loopback forward
  // (5050); a second monitored workspace's forward on 5051 renders its dashboards, but links
  // Grafana builds itself (sign-in redirects, share links) name 5050. Upgrade if that bites.
  const host =
    existingHost && !(existingHost === 'localhost:5050' && publicHost)
      ? existingHost
      : publicHost || 'localhost:5050';
  const tls = publicHost !== '' || ingress.tls === true;
  const rootUrl = `${tls ? 'https' : 'http'}://${host}/grafana/`;
  const upgrade =
    !installed ||
    grafana.path !== '/grafana' ||
    existingHost !== host ||
    ingress.enabled !== false ||
    ingress.tls !== tls;
  if (!upgrade) {
    info(emit, 'monitoring stack already on this cluster (shared)', { phase: 'monitor' });
    if (await configureGrafana(context, rootUrl)) await waitForGrafana({ context, emit, rootUrl });
    await ensureLogsDashboard(context);
    return;
  }
  info(
    emit,
    installed
      ? 'upgrading the SHARED monitoring stack to serve /grafana; Grafana restarts, and existing port-forwards must be re-established with `houston monitor`'
      : `installing the monitoring stack in ${MONITORING_NAMESPACE} (once per cluster, ~1 GB)`,
    { phase: 'monitor' },
  );
  // Deliberately NOT `--wait`. This chart creates grafana-operator custom resources in the
  // same release that installs the operator, and helm's readiness check reaches them before
  // the operator has reconciled anything -- "resource GrafanaDashboard/... not ready.
  // status: NotFound" -- which is a race, not a failure: the stack came up perfectly well
  // anyway, and ten pods were Running while helm reported it broken.
  await waitForSystemNamespace(context, emit);
  await clearPendingRelease(MONITORING_RELEASE, MONITORING_NAMESPACE, context, { emit });
  const res = await kube.run(
    [
      'helm',
      'upgrade',
      ...(installed ? ['--reuse-values'] : ['--install']),
      MONITORING_RELEASE,
      MONITORING_CHART,
      '--kube-context',
      context,
      '-n',
      MONITORING_NAMESPACE,
      '--create-namespace',
      '--set',
      'ingress.enabled=false',
      '--set',
      'ingress.grafana.path=/grafana',
      '--set-string',
      `ingress.grafana.host=${host}`,
      '--set',
      `ingress.tls=${String(tls)}`,
      '--set',
      'operator.prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false',
      '--set',
      'operator.prometheus.prometheusSpec.podMonitorSelectorNilUsesHelmValues=false',
      '--timeout',
      '9m',
      ...(await helmRollbackOnFailure()),
    ],
    { timeout: INSTALL_TIMEOUT, env: helmEnv(context) },
  );
  if (res.returncode !== 0) {
    throw new CreateFailedError(`could not install the monitoring stack: ${why(res)}`);
  }
  await configureGrafana(context, rootUrl);
  await waitForGrafana({ context, emit, rootUrl });
  await ensureLogsDashboard(context);
}

/** Remove only Houston-labelled Grafana routes, certificates and secrets. */
export async function removeGrafanaIngress(
  workspace: string,
  { context, emit = nullEmit }: { context: string; emit?: Emit },
): Promise<void> {
  const selector =
    `${OWNER_SELECTOR},${GRAFANA_INGRESS_LABEL}=true` +
    (workspace ? `,${WORKSPACE_LABEL}=${workspace}` : '');
  // APPLY_TIMEOUT, NOT THE PROBE'S 8 s. These questions must be answered -- a refusal fails
  // the job -- and they run inside a teardown that has just waited a minute for a namespace
  // to go, where nobody is waiting on a screen. MEASURED on EKS over a slow link: the
  // workspace's namespace and volume were gone when the certificate question hit 8 s, and
  // the whole `down` failed for a Grafana route.
  const crd = require_(
    await askObject('customresourcedefinition', 'certificates.cert-manager.io', {
      context,
      timeout: APPLY_TIMEOUT,
    }),
    'the certificate API',
    { context },
  );
  const kinds = present(crd) ? ['ingress', 'certificate', 'secret'] : ['ingress', 'secret'];
  for (const kind of kinds) {
    const seen = require_(
      await askList(kind, {
        context,
        namespace: MONITORING_NAMESPACE,
        selector,
        timeout: APPLY_TIMEOUT,
      }),
      `Grafana ${kind} resources`,
      { context },
    );
    if (!present(seen)) continue;
    if (!Array.isArray(seen.doc.items))
      throw new DockerError(`could not read Grafana ${kind} resources: invalid list`);
    if (seen.doc.items.length === 0) continue;
    info(emit, `removing Grafana ${kind} resources${workspace ? ` for '${workspace}'` : ''}`, {
      phase: 'monitor',
    });
    const result = await kube.run(
      [
        'kubectl',
        '--context',
        context,
        '-n',
        MONITORING_NAMESPACE,
        'delete',
        kind,
        '-l',
        selector,
        '--ignore-not-found',
        '--wait=true',
        '--timeout=120s',
      ],
      { own: isOurs(context), timeout: APPLY_TIMEOUT },
    );
    if (result.returncode !== 0)
      throw new DockerError(`could not remove Grafana ${kind} resources: ${why(result)}`);
  }
}

/**
 * The grafana-operator custom resources this chart creates, in the order they must be
 * deleted -- children before the Grafana instance that owns them.
 */
export const GRAFANA_KINDS: readonly string[] = [
  'grafanadashboard',
  'grafanadatasource',
  'grafanafolder',
  'grafana',
];

/**
 * How long ONE kind's delete may block. Short on purpose: a delete that has not finished in
 * this long is waiting on a finalizer nothing will clear, and the useful response is to
 * clear it, not to keep waiting.
 */
export const GRAFANA_DELETE_WAIT = 15;

/**
 * `[kind, name]` for every grafana-operator resource still present.
 *
 * Read AFTER a delete has been asked for and given a deadline, so a non-empty result means
 * "these are not going to go on their own".
 */
export async function grafanaLeftovers(context: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for (const kind of GRAFANA_KINDS) {
    const res = await kube.run(
      [
        'kubectl',
        '--context',
        context,
        '-n',
        MONITORING_NAMESPACE,
        'get',
        kind,
        '-o',
        'jsonpath={.items[*].metadata.name}',
      ],
      { own: isOurs(context) },
    );
    if (res.returncode !== 0) continue; // the CRD is not installed; nothing to find
    for (const name of res.stdout.split(/\s+/u).filter((entry) => entry !== '')) {
      out.push([kind, name]);
    }
  }
  return out;
}

/**
 * Strip the operator finalizer from whatever is left, so the delete completes.
 *
 * A last resort, and safe as one: the operator that put the finalizer there is gone, so
 * there is nothing whose cleanup we are skipping -- and the alternative is a namespace that
 * sits in Terminating for ever and a release the next `--monitor` cannot install into.
 */
export async function clearGrafanaFinalizers(context: string): Promise<number> {
  let cleared = 0;
  for (const [kind, name] of await grafanaLeftovers(context)) {
    const res = await kube.run(
      [
        'kubectl',
        '--context',
        context,
        '-n',
        MONITORING_NAMESPACE,
        'patch',
        kind,
        name,
        '--type=merge',
        '-p',
        '{"metadata":{"finalizers":[]}}',
      ],
      { own: isOurs(context) },
    );
    if (res.returncode === 0) cleared += 1;
  }
  return cleared;
}

/**
 * Whether a workspace namespace is marked as wanting monitoring.
 *
 * A label on the namespace rather than a lookup in repro.json: `removeMonitoring` has to
 * answer "does anyone else still want this?" about workspaces it is not holding the record
 * for, and possibly ones created by a different user of the same cluster.
 *
 * NULL WHEN THE LABEL COULD NOT BE READ. This returned false for any failed call, and false
 * here means "this workspace does not want monitoring" -- so it is the INNER test of the
 * reference count. Fixing `workspaceNamespaces` to stop claiming an empty cluster does not
 * help if the per-namespace question then answers "no" for a namespace nobody could read.
 */
export async function monitoringWanted(
  namespace: string,
  { context }: { context: string },
): Promise<boolean | null> {
  // `-o json` rather than a jsonpath, because an empty jsonpath result cannot say whether
  // the LABEL is absent or the NAMESPACE is.
  const seen = await askObject('namespace', namespace, { context });
  if (refused(seen)) return null;
  if (absent(seen)) return false;
  const meta = present(seen) ? seen.doc.metadata : undefined;
  const labels =
    meta !== null && typeof meta === 'object'
      ? ((meta as { labels?: Record<string, unknown> }).labels ?? {})
      : {};
  return String(labels[MONITORING_LABEL] ?? '').trim() === 'true';
}

/**
 * Mark (or unmark) a namespace as wanting the shared stack.
 *
 * THE MARK IS THE STACK'S REFERENCE COUNT, so one that did not land is raised, not ignored:
 * an attach whose label was refused still recorded `monitoring: true`, and the next teardown
 * of any other workspace counted nobody, uninstalled the stack and deleted its volumes. An
 * unmark that did not land only keeps the stack, so that one is let go.
 */
export async function setMonitoringLabel(
  namespace: string,
  { context, wanted }: { context: string; wanted: boolean },
): Promise<void> {
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      'label',
      '--overwrite',
      'namespace',
      namespace,
      wanted ? `${MONITORING_LABEL}=true` : `${MONITORING_LABEL}-`,
    ],
    { own: isOurs(context) },
  );
  if (wanted && res.returncode !== 0) {
    throw new DockerError(
      `could not mark namespace ${namespace} as using the shared monitoring stack: ${why(res)} ` +
        "— monitoring was not attached, so another workspace's teardown cannot remove the " +
        'stack from under it',
    );
  }
}

/** Namespaces other than `excluding` that still request the shared stack. */
async function monitoringConsumers(
  context: string,
  excluding: string,
  emit: Emit,
): Promise<string[] | null> {
  const held = await workspaceNamespaces(context);
  if (held === null) {
    warn(
      emit,
      "not removing the shared monitoring stack: the cluster's namespace list could not be " +
        'read, so whether another workspace still wants it is unknown',
      { phase: 'monitor' },
    );
    return null;
  }
  const others: string[] = [];
  for (const ns of held) {
    if (ns === excluding) continue;
    const wants = await monitoringWanted(ns, { context });
    if (wants === null) {
      warn(
        emit,
        `not removing the shared monitoring stack: could not read whether ${ns} still wants it`,
        { phase: 'monitor' },
      );
      return null;
    }
    if (wants) others.push(ns);
  }
  return others;
}

/** Delete operator resources before uninstalling the operator that finalises them. */
async function removeGrafanaResources(context: string, emit: Emit): Promise<void> {
  // The grafana-operator's own resources go FIRST, while the operator that processes their
  // finalizers is still running. Letting helm delete everything at once deadlocks: it
  // removes the operator Deployment and then waits on a GrafanaFolder whose finalizer
  // nothing is left to clear.
  //
  // The ordering is not sufficient when the operator is already gone: the resources then
  // spend their full delete timeout waiting for finalizers nothing can clear. So the deletes
  // get a SHORT deadline and are then CHECKED.
  info(emit, 'removing the Grafana resources', { phase: 'monitor' });
  for (const kind of GRAFANA_KINDS) {
    await kube.run(
      [
        'kubectl',
        '--context',
        context,
        '-n',
        MONITORING_NAMESPACE,
        'delete',
        kind,
        '--all',
        '--ignore-not-found',
        `--timeout=${String(GRAFANA_DELETE_WAIT)}s`,
      ],
      { timeout: APPLY_TIMEOUT, own: isOurs(context) },
    );
  }
  const stuck = await grafanaLeftovers(context);
  if (stuck.length > 0) {
    warn(
      emit,
      `${String(stuck.length)} Grafana resource(s) will not delete — nothing is left to ` +
        'clear their finalizers, so clearing them now',
      { phase: 'monitor' },
    );
    await clearGrafanaFinalizers(context);
  }
}

/** Uninstall Helm while retaining the best-effort finalizer recovery. */
async function uninstallMonitoringRelease(context: string, emit: Emit): Promise<void> {
  info(emit, 'uninstalling the monitoring release', { phase: 'monitor' });
  const res = await kube.run(
    [
      'helm',
      'uninstall',
      MONITORING_RELEASE,
      '--kube-context',
      context,
      '-n',
      MONITORING_NAMESPACE,
      '--wait',
      '--timeout',
      '5m',
    ],
    { timeout: INSTALL_TIMEOUT, own: isOurs(context) },
  );
  if (res.returncode !== 0) {
    // The release is removed either way; a stuck finalizer must not leave the cluster in a
    // state the next `--monitor` cannot install into.
    await clearGrafanaFinalizers(context);
    warn(emit, `the monitoring stack needed its finalizers cleared by hand: ${why(res)}`, {
      phase: 'monitor',
    });
  }
}

/** Remove the Prometheus claims Helm deliberately leaves behind. */
async function reclaimMonitoringVolumes(context: string, emit: Emit): Promise<void> {
  const pvcs = await kube.run(
    ['kubectl', '--context', context, '-n', MONITORING_NAMESPACE, 'get', 'pvc', '-o', 'name'],
    { timeout: APPLY_TIMEOUT, own: isOurs(context) },
  );
  const names = pvcs.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (pvcs.returncode !== 0) {
    warn(
      emit,
      'could not check whether the monitoring stack left a volume behind — `kubectl -n ' +
        `${MONITORING_NAMESPACE} get pvc\` shows it`,
      { phase: 'monitor' },
    );
    return;
  }
  if (names.length === 0) return;
  const gone = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      MONITORING_NAMESPACE,
      'delete',
      'pvc',
      '--all',
      '--ignore-not-found',
      `--timeout=${String(GRAFANA_DELETE_WAIT)}s`,
    ],
    { timeout: APPLY_TIMEOUT, own: isOurs(context) },
  );
  if (gone.returncode === 0) {
    info(emit, `reclaimed ${String(names.length)} monitoring volume(s)`, { phase: 'monitor' });
  } else {
    warn(
      emit,
      `the monitoring stack's ${String(names.length)} volume(s) could not be reclaimed and ` +
        `are still allocated: ${why(gone)}`,
      { phase: 'monitor' },
    );
  }
}

/**
 * Uninstall the shared stack. Returns false if another workspace still wants it.
 *
 * Shared, so `--off` on one workspace must not blind the others. This is the whole
 * behavioural difference from Compose, where the stack belongs to a project and detaching it
 * is unambiguous.
 *
 * `excluding` is the namespace of a workspace being DESTROYED, and it exists because the
 * count reads a label on the namespace while `workspaceNamespaces` does not filter by phase:
 * a namespace still Terminating is still listed and still labelled, so a teardown asking
 * "does anyone else want this?" would be told yes by the workspace it is deleting.
 */
export async function removeMonitoring({
  context,
  excluding = '',
  emit = nullEmit,
}: {
  context: string;
  excluding?: string;
  emit?: Emit;
}): Promise<boolean> {
  // Nothing installed is nothing to report. Without this, `monitor --off` on a workspace
  // that never had monitoring ran the uninstall anyway, helm answered "release: not found",
  // and the fallback path announced that "the monitoring stack needed its finalizers cleared
  // by hand" -- a frightening sentence about wreckage that did not exist.
  if (!(await releaseInstalled(MONITORING_RELEASE, MONITORING_NAMESPACE, context))) return false;
  const others = await monitoringConsumers(context, excluding, emit);
  if (others === null) return false;
  if (others.length > 0) {
    info(
      emit,
      'leaving the monitoring stack up — still used by ' +
        others
          .map((ns) => (ns.startsWith(NAMESPACE_PREFIX) ? ns.slice(NAMESPACE_PREFIX.length) : ns))
          .sort()
          .join(', '),
      { phase: 'monitor' },
    );
    return false;
  }
  await removeGrafanaIngress('', { context, emit });
  await removeGrafanaResources(context, emit);
  await uninstallMonitoringRelease(context, emit);
  // THE PROMETHEUS VOLUME, which helm does not take with the release. A StatefulSet's
  // PersistentVolumeClaims outlive it by design -- that is what keeps a workspace's MongoDB
  // data across a plain `down` -- but nothing here ever deleted these: a clean `monitor
  // --off` left a 10 Gi claim Bound, permanently. On a laptop that is disk; on EKS it is a
  // billed EBS volume nobody can see the source of. Deleted by NAMESPACE, not by label: the
  // chart's PVCs carry its own labels, not houston's, and this namespace is houston's own.
  await reclaimMonitoringVolumes(context, emit);
  await releaseSystemNamespace(context, emit);
  return true;
}

/**
 * `houston-system`, once nothing of houston's needs it.
 *
 * helm made it (`--create-namespace`) for the operator and the monitoring stack, and
 * neither removal took it: after the last workspace was gone it stayed, holding a webhook
 * Secret the monitoring chart leaves behind. Removed only when neither release is there
 * (an unreadable release counts as there) and no workload or volume is left in it -- an
 * operator adopted rather than installed lives here too, and is not houston's to delete.
 */
export async function releaseSystemNamespace(context: string, emit: Emit): Promise<void> {
  if (await releaseInstalled(MONITORING_RELEASE, MONITORING_NAMESPACE, context)) return;
  if (await releaseInstalled(OPERATOR_RELEASE, OPERATOR_NAMESPACE, context)) return;
  const left = await askList('deployments,statefulsets,daemonsets,jobs,pvc', {
    context,
    namespace: OPERATOR_NAMESPACE,
  });
  if (!present(left) || items(left).length > 0) return;
  const res = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      'delete',
      'namespace',
      OPERATOR_NAMESPACE,
      '--wait=true',
      '--timeout=90s',
    ],
    { timeout: APPLY_TIMEOUT, own: isOurs(context) },
  );
  if (res.returncode === 0) {
    info(emit, `removed the ${OPERATOR_NAMESPACE} namespace — nothing of houston's uses it now`, {
      phase: 'teardown',
    });
  } else if (!absent(classify(res, { single: true }))) {
    // NotFound is the answer this asked for: a workspace that never had monitoring took
    // `down` here and warned that it "could not confirm" a namespace already gone.
    warn(
      emit,
      `could not confirm ${OPERATOR_NAMESPACE} is gone: ${why(res)} — a new operator or ` +
        'monitoring install must wait for its deletion to finish',
      { phase: 'teardown' },
    );
  }
}
