/**
 * Waiting for a workspace to actually serve, and the last steps once it does.
 *
 * Tier 3. `waitServing` polls the HTTP surface; the Kubernetes branch also has to keep a
 * port-forward alive while it waits, which is why `waitServingKubernetes` is separate rather
 * than a flag.
 */
import { pendingReceipt } from '../../seed/receipt';
import * as config from '../../lib/config';
import { ConflictError, CreateFailedError, NotReadyError, ReproError } from '../../lib/errors';
import { type Emit, info, nullEmit, warn } from '../../lib/events';
import { toInt, toText } from '../../lib/format';
import { publicPathsOf } from '../../lib/presets/public';
import { baseVersion } from '../../lib/versions';
import { Interrupted, sleep, unwindsOnInterrupt } from '../../seams/exec';
import { diagnoseFailure } from '../diagnose';
import * as edge from '../edge/acme';
import { running as edgeRunning } from '../edge/engine';
import { ensureRunning } from '../edge/runtime';
import { register as registerRoute } from '../edge/routes';
import {
  ensurePortForward,
  forwardAlive,
  signalForward,
  forwardReachable,
  holderCommand,
  scenarioUiForwards,
  stopForward,
} from '../kube/forward';
import { namespaceFor, requireOwnNamespace } from '../kube/namespace';
import {
  workspaceReady,
  workloadReplicas,
  terminalPodFailure,
  servicesWithoutEndpoints,
} from '../kube/status';
import { CONTEXT as KUBE_CONTEXT } from '../kube/names';
import {
  type Auth,
  completeSetupWizard,
  getSetting,
  licenseInfo,
  setSetting,
  NotReady,
  apiInfo,
  waitReady,
} from '../rcapi';
import * as engine from '../runner/engine';
import { type Metadata, adminPass, externalUrl, readMeta, updateMeta } from '../runner/record';
import {
  oneShotSetups,
  projectStates,
  rcRestartCount,
  rcState,
  servicesByProject,
} from '../runner/queries';
import * as postready from '../postready';
import * as topology from '../topology';
import { MODE_LOCAL, originCertificate } from '../tls';

import { login } from './admin';
import { loginPresetOf, premiumSignIn, signInGate } from './notes';
import * as inspect from './inspect';
import * as seeding from './seeding';
import { CREATE_UNFINISHED, clearKind, pendingSeed } from '../journal';
import { ESSENTIAL_SERVICES, tuning } from './types';

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The workspace is serving. Whether that is the END is the caller's to say. */
export function sayReady(emit: Emit, final: boolean): void {
  if (final) {
    info(emit, 'ready', { phase: 'done', pct: 100.0 });
  } else {
    // NO PERCENTAGE, deliberately. `waitServing` has already emitted 100 by the time this
    // runs, so naming any number here sends the bar BACKWARDS.
    info(emit, 'the workspace is up', { phase: 'wait' });
  }
}

/**
 * The one place a readiness failure is worded.
 *
 * `known` is a diagnosis from `diagnose`, which is preferred over anything guessed: it
 * comes from a matched log signature rather than from a restart count. The
 * resource-pressure sentence survives only as a POSSIBILITY, and only when nothing was
 * matched -- stated as fact it sent a reader hunting for memory they had.
 */
export function readinessFailure(
  meta: Metadata,
  seen: { restarts: number; cause: string | null },
  { prefix = '', known = '' } = {},
): NotReadyError {
  const cause = known || seen.cause || '';
  const head = prefix || `Rocket.Chat is not becoming ready in '${meta.name}'`;
  if (cause) return new NotReadyError(`${head} - ${cause}`);
  const restarts = seen.restarts || 0;
  if (restarts >= 2) {
    return new NotReadyError(
      `${head} - Rocket.Chat restarted ${String(restarts)}x and nothing in its logs ` +
        "matches a known cause. Free memory or raise Docker's CPU+RAM if the " +
        `box is loaded, then \`houston ready --name ${meta.name}\`; otherwise ` +
        `\`houston logs --name ${meta.name}\` has what happened.`,
    );
  }
  return new NotReadyError(head);
}

/**
 * `docker compose pull` and `up -d`, the containers phase of a create.
 *
 * UNWOUND by a Ctrl-C: out through the create's catch-all, which clears the note, so an
 * `up` interrupted in its pull leaves no `create_unfinished` note, where `process.exit(130)`
 * left one for `doctor` to warn about a workspace that was never made.
 * Nothing between here and that `catch` catches the interrupt, and the note is cleared
 * synchronously. Only this phase: the readiness wait after it goes through catches that
 * handle any error -- `rcRestartCount`'s among them -- which would swallow the interrupt
 * and print one more `still booting` line before the next wait ended the run.
 */
export async function upCompose(
  name: string,
  options: { pull: boolean; emit: Emit; streamOutput: boolean },
): Promise<number> {
  return await unwindsOnInterrupt(async () => await composeUp(name, options));
}

async function composeUp(
  name: string,
  { pull, emit, streamOutput }: { pull: boolean; emit: Emit; streamOutput: boolean },
): Promise<number> {
  if (!streamOutput) {
    // docker draws its own progress on the terminal
    return (await engine.up(name, { pull })) ?? 1;
  }
  // `data.echo="docker"` marks this as ECHO rather than narrative: every line of
  // `docker compose pull` comes through here, so a create emits several hundred
  // "Downloading 45.09MB" events. The GUI wants them; the durable log does not.
  const onLine = (line: string): void =>
    info(emit, line, { phase: 'boot', data: { echo: 'docker' } });
  if (pull) {
    // non-fatal, like runner.up
    await engine.stream(name, ['pull'], onLine);
  }
  const rc = await engine.stream(name, ['up', '-d', '--remove-orphans'], onLine);
  return (await engine.recreatedIfStale(name, rc)) ?? 1;
}

/**
 * Re-register a workspace's https name with the edge. Best-effort.
 *
 * Never fatal: the workspace is up and usable either way, and failing a reuse over the
 * ingress would be the wrong trade.
 */
export async function restoreRoute(meta: Metadata, emit: Emit = nullEmit): Promise<void> {
  const extra = bag(meta.extra);
  if (!(isTruthy(extra.tls) && meta.publicUrl)) return;
  const host = meta.publicUrl.split('://').slice(-1)[0]?.split('/')[0] ?? '';
  const local = extra.tls === MODE_LOCAL;
  try {
    if (!(await edgeRunning())) {
      await ensureRunning({
        acmeEmail: local ? '' : String(extra.tls_email ?? ''),
        acmeStaging: Boolean(extra.tls_staging),
      });
    }
    if (local) await edge.issueLocalCert(host);
    const instances =
      typeof extra.instances === 'number' && Number.isInteger(extra.instances)
        ? extra.instances
        : 1;
    await registerRoute(meta.name, host, {
      instances,
      local,
      grafana: isTruthy(extra.monitoring),
      publicPaths: publicPathsOf(extra),
    });
    info(emit, `${host} is served by the edge again`, { phase: 'tls' });
  } catch (error) {
    warn(
      emit,
      `could not restore the https name ${host}: ${errorText(error)}. ` +
        '`houston edge status` reports it.',
      { phase: 'tls' },
    );
  }
}

/**
 * Kill a workspace's port-forward, if it is still ours to kill.
 *
 * Best-effort and deliberately narrow: the check is "is this process this NAMESPACE's
 * port-forward", delegated to `forwardAlive` so there is one definition of "ours". A
 * recycled pid belonging to ANOTHER workspace's forward is precisely the failure this
 * avoids.
 */
export async function stopPortForward(pid: number, { namespace = '' } = {}): Promise<void> {
  if (!(await forwardAlive(pid, { namespace }))) return;
  signalForward(pid);
}

export async function finalize(
  meta: Metadata,
  emit: Emit,
): Promise<{ token: string; userId: string } | null> {
  try {
    const auth = await login(meta);
    if (await completeSetupWizard(meta.rootUrl, auth, adminPass(meta))) {
      info(emit, 'setup wizard skipped — no registration needed', { phase: 'post_ready' });
    }
    return auth;
  } catch (error) {
    if (error instanceof Interrupted) throw error; // Ctrl-C or a stopped job: unwind
    // finalize is best-effort
    return null;
  }
}

/**
 * One poll of a boot in progress: is it slow, or is it failing?
 *
 * Module-level rather than a closure over `waitServing`, so a test can patch it. `seen`
 * carries the two facts that have to survive between ticks.
 */
export async function crashLoopTick(
  meta: Metadata,
  emit: Emit,
  timeout: number,
  seen: { restarts: number; cause: string | null },
  elapsed: number,
): Promise<void> {
  // Surface a crash-loop: if RC keeps restarting, boot is slow for a reason.
  const rc = await rcRestartCount(meta.name);
  if (rc >= 2 && rc > seen.restarts) {
    warn(emit, `Rocket.Chat has restarted ${String(rc)}x - checking why`, { phase: 'wait' });
    // ASK, rather than assert. The old wording named resource pressure as the cause, and
    // `diagnose` -- which exists for exactly this -- was never consulted anywhere on the
    // readiness path.
    //
    // Giving up EARLY only when the cause is known. A boot that restarts twice and then
    // settles is ordinary; a matched signature is evidence.
    if (seen.cause === null) {
      seen.cause = (await diagnoseFailure(meta.name)) ?? '';
    }
    if (seen.cause) {
      throw readinessFailure(meta, seen, { known: seen.cause });
    }
  }
  seen.restarts = Math.max(seen.restarts, rc);
  const pct = timeout ? Math.max(0.0, Math.min(99.0, (elapsed / timeout) * 100)) : null;
  // `toInt(elapsed)`, which REFUSES a NaN: under `--timeout inf` or `nan` the deadline is
  // never reached and the elapsed time is NaN, so the first tick throws `InvalidValue` and the
  // command ends (exit 1). Math.floor printed "still booting (NaNs)" every three seconds, for
  // ever -- a run that never wrote its `end` record.
  info(emit, `still booting (${String(toInt(elapsed))}s)`, { phase: 'wait', pct });
}

/**
 * SERVING IS NOT USABLE, and this is the gap between them.
 *
 * Rocket.Chat answers /api/info with no database behind it, so a workspace whose mongodb
 * had exited passed this and was reported ready, running and healthy -- while `api` and
 * `seed` refused it and pointed the reader back at `ready`, the command that had just
 * said yes.
 */
export async function refuseIfServingWithoutADatabase(meta: Metadata): Promise<void> {
  const why = inspect.degradedReason((await servicesByProject())[meta.project] ?? {});
  if (why) {
    throw new NotReadyError(
      `'${meta.name}' is serving, but ${why} - Rocket.Chat answers /api/info ` +
        'without a database, so this looks ready and no login will work. ' +
        `\`docker start ${meta.project}-${ESSENTIAL_SERVICES[0] ?? ''}-1\`, or ` +
        `\`houston up --version ${meta.rcVersion} --name ${meta.name}\` to ` +
        'rebuild the stack.',
    );
  }
}

export async function waitServing(
  meta: Metadata,
  emit: Emit,
  timeout: number,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  if (topology.ofMeta(meta) === topology.KUBERNETES) {
    // `rcState` asks docker whether a CONTAINER is running, so `ready` on a Kubernetes
    // workspace answered "Rocket.Chat container is not running" about a workspace whose
    // pods were fine. It also re-establishes the port-forward, which is the whole reason
    // `ready` is the right place to ask.
    const served = await waitServingKubernetes(meta, emit, timeout);
    await waitForOrigin(meta, emit, Math.max(timeout - (Date.now() - started) / 1000, 1));
    return served;
  }
  const seen: { restarts: number; cause: string | null } = { restarts: 0, cause: null };

  let last = '';
  const isAlive = async (): Promise<boolean> => {
    last = await rcState(meta.name);
    return ['running', 'restarting', 'created'].includes(last);
  };

  const tick = async (elapsed: number): Promise<void> => {
    await crashLoopTick(meta, emit, timeout, seen, elapsed);
  };

  let served: Record<string, unknown>;
  try {
    served = await waitReady(meta.rootUrl, { timeout, isAlive, onTick: tick });
    // EVERY INSTANCE, not the front door alone. The workspace's own Traefik starts every
    // server healthy and checks them every 10 s, so the first instance to answer made this
    // "ready" while the others were still booting: 9-10 of 20 requests answered 502 right
    // after it, and the admin login failed. Each instance is published on hostPort+i.
    const instances = Number(bag(meta.extra).instances ?? 1) || 1;
    // NAMED when one is not: "did not become ready within 59s" with the front door
    // answering left a reader to find the stopped replica by hand.
    const late: string[] = [];
    let first: NotReady | null = null;
    for (let i = 1; instances > 1 && i <= instances; i += 1) {
      const own = new URL(meta.rootUrl);
      own.port = String(meta.hostPort + i);
      const left = Math.max(timeout - (Date.now() - started) / 1000, 1);
      try {
        await waitReady(own.origin, { timeout: left, isAlive, onTick: tick });
      } catch (error) {
        if (!(error instanceof NotReady)) throw error;
        first ??= error;
        late.push(`rocketchat-${String(i)} at ${own.origin}`);
      }
    }
    if (first !== null) {
      throw new NotReady(
        `${errorText(first)}: ${late.join(', ')} ${late.length === 1 ? 'is' : 'are'} not serving`,
      );
    }
  } catch (error) {
    if (!(error instanceof NotReady)) throw error;
    // STOPPED IS AN ANSWER, as on Kubernetes. Rocket.Chat runs `restart: always`, so a crash
    // comes back as `restarting`: an exited one was stopped, and its logs do not say so.
    // `compose ps` lists running containers only, so there a stopped one is `absent`; `compose
    // ls --all` still lists its project, every container exited (a taken-down one: none).
    const project = last === 'absent' ? ((await projectStates()) ?? {})[meta.project] : '';
    if (last === 'exited' || /^exited\(\d+\)$/.test(project ?? '')) {
      throw new NotReadyError(
        `'${meta.name}' is stopped — \`houston start --name ${meta.name}\` brings it back`,
      );
    }
    if (seen.cause === null) {
      seen.cause = (await diagnoseFailure(meta.name)) ?? '';
    }
    throw readinessFailure(meta, seen, { prefix: errorText(error) });
  }
  await waitForOneShotSetup(meta, emit, Math.max(timeout - (Date.now() - started) / 1000, 1));
  await refuseIfServingWithoutADatabase(meta);
  await waitForOrigin(meta, emit, Math.max(timeout - (Date.now() - started) / 1000, 1));
  return served;
}

/** Internal HTTP health cannot prove the restored HTTPS route serves an application. */
async function waitForOrigin(meta: Metadata, emit: Emit, timeout: number): Promise<void> {
  if (meta.publicUrl === '' || !isTruthy(bag(meta.extra).tls) || bag(meta.extra).edge !== true)
    return;
  const publicUrl = new URL(meta.publicUrl);
  if (publicUrl.protocol !== 'https:') return;
  try {
    await waitReady(meta.publicUrl, {
      timeout,
      page: true,
      requestOptions: async (remainingMs) => {
        const observed = await originCertificate(publicUrl.hostname, {
          port: Number(publicUrl.port || 443),
          timeout: remainingMs / 1000,
        });
        if (observed.pem === '') return null;
        return {
          followRedirects: false,
          loopbackOrigin: {
            certificate: observed.pem,
            allowCertificateNameMismatch: observed.fallback,
          },
        };
      },
      onTick: (elapsed) =>
        info(emit, `waiting for ${meta.publicUrl} to serve Rocket.Chat (${Math.floor(elapsed)}s)`, {
          phase: 'wait',
        }),
    });
  } catch (error) {
    if (!(error instanceof NotReady)) throw error;
    throw new NotReadyError(
      `'${meta.name}' answers internally, but its HTTPS origin ${meta.publicUrl} ` +
        'is not serving Rocket.Chat — `houston edge status` and the edge logs say why',
    );
  }
}

/**
 * The workspace's one-shot setup -- the MinIO bucket, the replica set -- finished, not just
 * Rocket.Chat serving. Rocket.Chat does not wait for `minio-init`, so on rootless Podman,
 * whose DNS flaps, `up --wait` returned while the bucket did not exist yet and the first
 * upload failed. A setup that failed is said, with where its reason is.
 */
export async function waitForOneShotSetup(
  meta: Metadata,
  emit: Emit,
  timeout: number,
  pause: (seconds: number) => Promise<void> = sleep,
): Promise<void> {
  const deadline = Date.now() + timeout * 1000;
  let said = false;
  for (;;) {
    // Not mongo-init: Rocket.Chat serving proves the replica set it initiated, and a re-run
    // after `restart` that missed a DNS lookup made a healthy workspace read as not ready.
    const setups = (await oneShotSetups(meta.name)).filter((one) => one.service !== 'mongo-init');
    const failed = setups.find((one) => one.status === 'exited' && one.exitCode !== 0);
    if (failed !== undefined) {
      throw new NotReadyError(
        `${failed.service} exited ${String(failed.exitCode)} before it finished setting up ` +
          `'${meta.name}' — \`docker compose -p ${meta.project} logs ${failed.service}\` says ` +
          `why, and \`houston restart --name ${meta.name}\` runs it again`,
      );
    }
    const pending = setups.filter((one) => one.status !== 'exited').map((one) => one.service);
    if (pending.length === 0) return;
    if (Date.now() >= deadline) {
      throw new NotReadyError(
        `${pending.join(', ')} has not finished setting up '${meta.name}' — ` +
          `\`docker compose -p ${meta.project} logs ${pending[0] ?? ''}\` says where it is`,
      );
    }
    if (!said) {
      info(emit, `Rocket.Chat answers; waiting for ${pending.join(', ')} to finish`, {
        phase: 'wait',
      });
      said = true;
    }
    await pause(2);
  }
}

/**
 * Re-establish the forward and record its pid. A forward dies with its pod, and `ready`
 * is exactly when someone asks why the URL stopped answering.
 */
export async function repairThePortForward(
  meta: Metadata,
  emit: Emit,
  extra: Record<string, unknown>,
  namespace: string,
  context: string,
): Promise<number> {
  const pid = await ensurePortForward(meta.name, {
    namespace,
    context,
    hostPort: meta.hostPort,
    pid: typeof extra.port_forward_pid === 'number' ? extra.port_forward_pid : 0,
    bindHost: toText(extra.bind_host),
    emit,
  });
  if (pid && pid !== extra.port_forward_pid) {
    await updateMeta(meta.name, (current) => {
      current.extra.port_forward_pid = pid;
    });
    // AND IN MEMORY, or whoever renders from this `meta` afterwards is reading the pid we
    // just replaced. `ready` repaired a dead forward and then printed "The URL is not
    // published right now" underneath "is serving at <url>".
    meta.extra.port_forward_pid = pid;
  }
  return pid;
}

/**
 * A preset's UI forwards, re-established when any of them is gone.
 *
 * They die with their pods, which `stop` scales to zero, and only the Rocket.Chat forward
 * was ever repaired. So after a stop/start the SAML IdP on :8081 answered nothing:
 * `post_ready` could not re-read its descriptor, Rocket.Chat kept the certificate of a
 * Keycloak that had since re-imported its realm with new keys, and every SAML sign-in was
 * `Invalid Signature` -- "Unauthorized". Restarted together, under a fresh record entry.
 */
export async function repairTheScenarioForwards(
  meta: Metadata,
  emit: Emit,
  extra: Record<string, unknown>,
  namespace: string,
  context: string,
): Promise<void> {
  const recorded = Object.entries(bag(extra.scenario_forwards));
  let gone = false;
  for (const [port, pid] of recorded) {
    if (!(await forwardAlive(Number(pid), { namespace, hostPort: Number(port) }))) gone = true;
  }
  if (!gone) return;
  for (const [port, pid] of recorded) {
    await stopForward(Number(pid), { namespace, hostPort: Number(port) });
  }
  const ui = await scenarioUiForwards(meta.name, {
    namespace,
    context,
    bindHost: toText(extra.bind_host),
    emit,
  });
  const fresh = Object.fromEntries(Object.entries(ui).map(([port, pid]) => [String(port), pid]));
  await updateMeta(meta.name, (current) => {
    current.extra.scenario_forwards = fresh;
  });
  meta.extra.scenario_forwards = fresh;
}

/**
 * Reachable through the forward, and dead to every pod in the cluster.
 *
 * The Service is never traversed by anything on this path, and on this runtime that
 * matters: readiness reads pod status, the port-forward targets the Deployment, and the
 * default deployment is microservices.
 *
 * WARNED, not gated: endpoints churn during a rollout and a false negative here would
 * block a boot, which is worse than the defect.
 */
export async function warnAboutServicesWithNoEndpoints(
  meta: Metadata,
  emit: Emit,
  namespace: string,
  context: string,
): Promise<void> {
  const empty = await servicesWithoutEndpoints(meta.name, { context });
  if (empty.length > 0) {
    warn(
      emit,
      'no ready pod is behind ' +
        empty.join(', ') +
        ' — the URL works because the port-forward goes ' +
        'straight to the Deployment, but nothing inside ' +
        `the cluster can reach ${empty.length > 1 ? 'these' : 'it'}` +
        `. \`kubectl -n ${namespace} get endpointslices\` ` +
        'shows what is behind each Service.',
      { phase: 'ready' },
    );
  }
}

/**
 * The port answers, the workspace is ready, and what answered is not Rocket.Chat.
 *
 * This was the only runtime that confused occupancy with identity. The Docker path has
 * always gone through `rcapi.waitReady`, which polls /api/info; here readiness was
 * concluded from a Ready pod plus "the port answers" and nothing ever asked Rocket.Chat
 * anything. The port is only validated at create time and 3000+ is the most contested
 * range on a dev box, so this is an ordinary event.
 *
 * Returns the new strike count.
 */
export function refuseAForeignHolder(meta: Metadata, foreign: number): number {
  // WHOSE forward is irrelevant once the workspace itself is ready. The first version
  // raised only when our forward was dead, and the live run found the case that misses:
  // on a dual-stack box kubectl binds `[::1]` quite happily while a squatter holds
  // `127.0.0.1`.
  //
  // So the test is the workspace's own state: if Kubernetes says it is ready and the
  // port answers with something that is not Rocket.Chat, then whatever is on that port
  // is not this workspace. Counted rather than acted on at once, because a pod that has
  // just passed its probe may not be serving for another moment.
  const strikes = foreign + 1;
  if (strikes >= tuning.FOREIGN_PORT_STRIKES) {
    throw new ConflictError(
      `port ${String(meta.hostPort)} is answering, but not with ` +
        `Rocket.Chat, and '${meta.name}' is otherwise ready — so ` +
        `nothing served on ${meta.rootUrl} can be trusted to be this ` +
        `workspace. Something else holds that port. \`${holderCommand(meta.hostPort)}\` ` +
        'says what; note it may hold only IPv4 ' +
        'while the port-forward has IPv6, which looks healthy from ' +
        'houston and wrong from a browser. Free the port, or ' +
        `\`houston down --name ${meta.name}\` then \`houston up\` for ` +
        'one that is free.',
    );
  }
  return strikes;
}

/** Stop waiting for something Kubernetes has already decided cannot happen. */
export async function refuseADoomedPod(
  meta: Metadata,
  namespace: string,
  context: string,
): Promise<void> {
  // A mistyped version or an unreachable registry used to cost the full timeout and then
  // report the timeout rather than the cause.
  const doomed = await terminalPodFailure(meta.name, { context });
  if (doomed !== null) {
    const [pod, reason, message] = doomed;
    throw new CreateFailedError(
      `'${meta.name}' cannot start: pod ${pod} is ${reason}` +
        (message ? ` — ${message}` : '') +
        `. Nothing will change by waiting. \`kubectl -n ${namespace} ` +
        `describe pod ${pod}\` has the detail.`,
    );
  }
}

/**
 * Wait for a Kubernetes workspace to serve, and make sure it is reachable.
 *
 * Two jobs, because on this runtime they are different questions. The pod being Ready is
 * Kubernetes' answer; the URL answering also needs a live port-forward, and a forward
 * dies with its pod.
 */
export async function waitServingKubernetes(
  meta: Metadata,
  emit: Emit,
  timeout: number,
): Promise<Record<string, unknown>> {
  const extra = bag(meta.extra);
  const context = isTruthy(extra[config.EXTRA_CONTEXT])
    ? String(extra[config.EXTRA_CONTEXT])
    : KUBE_CONTEXT;
  const namespace = isTruthy(extra.namespace)
    ? String(extra.namespace)
    : await namespaceFor(meta.name);
  // Forwarded to, and set up over REST, only while it is still this workspace's own.
  await requireOwnNamespace(meta.name, { context });
  // STOPPED IS AN ANSWER, NOT A WAIT. `stop` scales Rocket.Chat to zero, and this polled out
  // its whole timeout (five minutes by default) on a workspace never going to move, then
  // named `kubectl get pods` -- there are none. A refused read is not "stopped": it waits.
  const replicas = await workloadReplicas(meta.name, { context }).catch(() => null);
  if (replicas === 0) {
    throw new NotReadyError(
      `'${meta.name}' is stopped — \`houston start --name ${meta.name}\` brings it back`,
    );
  }
  const deadline = Date.now() + timeout * 1000;
  let last = 0;
  // Consecutive rounds where the workspace is ready and the port answers with something
  // that is not Rocket.Chat. Grace, not tolerance: it ends in a refusal.
  let foreign = 0;
  // Pod churn can leave a forward serving once before it dies. Require the same pid to
  // carry two observations before handing its URL over.
  let stablePid = 0;
  let current = extra;
  while (Date.now() < deadline) {
    if (await workspaceReady(meta.name, { context })) {
      const pid = await repairThePortForward(meta, emit, current, namespace, context);
      // A Ready pod is not proof that its forwarding socket answers. Confirm it instead
      // of handing over a URL on the strength of a pid alone.
      if (await forwardReachable(meta.hostPort)) {
        // OCCUPANCY IS NOT IDENTITY: ask Rocket.Chat rather than inferring it from a
        // Ready pod and an answering port.
        const served = await apiInfo(meta.rootUrl);
        if (served !== null) {
          foreign = 0;
          if (pid && pid === stablePid) {
            await warnAboutServicesWithNoEndpoints(meta, emit, namespace, context);
            await repairTheScenarioForwards(meta, emit, current, namespace, context);
            info(emit, `'${meta.name}' is serving at ${meta.rootUrl}`, {
              phase: 'ready',
              pct: 100,
            });
            return { ready: true, url: meta.rootUrl };
          }
          stablePid = pid;
        } else {
          stablePid = 0;
          foreign = refuseAForeignHolder(meta, foreign);
        }
        current = { ...current, port_forward_pid: pid };
      } else {
        foreign = 0;
        stablePid = 0;
        current = { ...current, port_forward_pid: pid };
      }
    } else {
      stablePid = 0;
    }
    await refuseADoomedPod(meta, namespace, context);
    const now = Date.now();
    if (now - last > 15_000) {
      last = now;
      info(emit, `waiting for Rocket.Chat in ${namespace}`, { phase: 'wait' });
    }
    // `sleep(3000)`, which an Interrupted interrupts: a bare timer here was a
    // wait no Ctrl-C could reach, so `backup`'s unwind sat in it until the bound.
    await sleep(3000);
  }
  throw new NotReadyError(
    `Rocket.Chat did not become ready within ${String(Math.trunc(timeout))}s. ` +
      `kubectl -n ${namespace} get pods`,
  );
}

/**
 * Whether Rocket.Chat ACCEPTED the license houston gave it, recorded for the panel.
 *
 * A license is valid only at the address it was issued for: one given to a workspace whose
 * Site_Url is anything else is installed and refused ("Url validation failed"), and the
 * panel said "Licensed" all the same. Asked a few times, because Rocket.Chat may still be
 * applying it when it first serves; no answer records nothing rather than a guess.
 *
 * Also asked, once, where Rocket.Chat 9 refuses this workspace's sign-in without a license
 * houston did not give: one added later in Administration → Subscription lifts it, and the
 * notes said "refused" for as long as the workspace lived. The modules it turns on are
 * recorded too, which is what the notes read.
 */
export async function checkLicense(
  meta: Metadata,
  auth: Auth | null,
  emit: Emit,
  pause: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  if (auth === null) return;
  const given = bag(meta.extra).licensed === true;
  const pre = loginPresetOf(meta);
  if (!given && premiumSignIn(pre, meta.rcVersion) === null) return;
  let answer: Awaited<ReturnType<typeof licenseInfo>> = null;
  for (let tries = 0; tries < (given ? 4 : 1) && answer?.valid !== true; tries += 1) {
    if (tries > 0) await pause(5000);
    answer = await licenseInfo(meta.rootUrl, auth);
  }
  if (answer === null) return;
  const { valid, modules } = answer;
  if (!given) {
    const lifted = premiumSignIn(pre, meta.rcVersion);
    if (valid && lifted !== null && premiumSignIn(pre, meta.rcVersion, modules ?? []) === null)
      info(
        emit,
        `Rocket.Chat has a license carrying ${lifted.modules}: sign-in through the ` +
          `${lifted.through} preset is no longer refused`,
        { phase: 'post_ready' },
      );
  } else if (valid) {
    info(emit, 'Rocket.Chat accepted the license', { phase: 'post_ready' });
  } else {
    const site = await getSetting(meta.rootUrl, auth, adminPass(meta), 'Site_Url');
    warn(
      emit,
      'Rocket.Chat refused the license: one is valid only at the address it was issued for ' +
        `and until it expires${typeof site === 'string' && site !== '' ? `, and this workspace's Site_Url is ${site}` : ''}. ` +
        `\`houston logs --name ${meta.name}\` shows its reason. Rocket.Chat keeps a refused ` +
        'license refused even once the address is right (measured on 8.8.1): put it right, ' +
        `then \`houston restart --name ${meta.name}\` and \`houston ready --name ${meta.name}\`.`,
      { phase: 'post_ready' },
    );
  }
  // One houston did not give and Rocket.Chat does not hold is no status at all: never "refused".
  const status = valid ? 'valid' : given ? 'refused' : undefined;
  const extra = bag(meta.extra);
  if (
    extra.license_status === status &&
    JSON.stringify(extra.license_modules) === JSON.stringify(modules ?? undefined)
  )
    return;
  const put = (into: Record<string, unknown>): void => {
    if (status === undefined) delete into.license_status;
    else into.license_status = status;
    if (modules === null) delete into.license_modules;
    else into.license_modules = modules;
  };
  await updateMeta(meta.name, (current) => {
    put(current.extra);
  });
  put(meta.extra);
}

/**
 * Site_Url onto the address a rebuild moved this workspace to, once. Rocket.Chat keeps the stored
 * setting whatever ROOT_URL says and gives it to the browser as the address to connect to: an
 * http oidc workspace upgraded to 9.0.0 and rebuilt onto https sat on its loading spinner. Moved
 * only while it still names the old address, so one set by hand stays; `restore` does the same
 * for a bundle's (`backup.retargetSiteUrl`). Unanswered, the marker stays for the next `ready`.
 */
async function followTheMove(meta: Metadata, auth: Auth | null, emit: Emit): Promise<void> {
  const from = toText(bag(meta.extra).site_url_moved_from);
  if (from === '' || auth === null) return;
  const want = externalUrl(meta);
  const site = await getSetting(meta.rootUrl, auth, adminPass(meta), 'Site_Url');
  if (site === null) return;
  const trim = (url: string): string => url.replace(/\/+$/u, '');
  if (typeof site === 'string' && trim(site) === trim(from) && trim(from) !== trim(want)) {
    if (!(await setSetting(meta.rootUrl, auth, adminPass(meta), 'Site_Url', want))) {
      warn(
        emit,
        `Site_Url still reads ${from}, the address before this rebuild, and the browser follows ` +
          `it: set it to ${want} (Administration, Settings, General, Site URL), or run ` +
          `\`houston ready --name ${meta.name}\` again.`,
        { phase: 'post_ready' },
      );
      return;
    }
    info(emit, `Site_Url moved from ${from} to ${want}, where this workspace is now served`, {
      phase: 'post_ready',
    });
  }
  await updateMeta(meta.name, (current) => {
    delete current.extra.site_url_moved_from;
  });
  delete meta.extra.site_url_moved_from;
}

/**
 * Wait for the workspace to serve, then finish it off.
 *
 * `final` is whether this call is the END of what the user asked for. It is for `houston
 * ready`, which is exactly this and nothing else; `up` seeds afterwards, restore restores
 * afterwards, and an upgrade has a rollback still to consider. All three used to announce
 * phase `done` at 100% here and then carry on working.
 */
export async function waitAndFinalize(
  meta: Metadata,
  emit: Emit = nullEmit,
  timeout = 300.0,
  final = true,
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const served = await waitServing(meta, emit, timeout);
  const elapsed = Math.floor((Date.now() - started) / 1000);
  const auth = await finalize(meta, emit);
  // Before the preset's setup, which builds its callbacks and checks from Site_Url.
  await followTheMove(meta, auth, emit);
  // Before it too: the license Rocket.Chat holds now, not at the last `ready`, decides the advice.
  await checkLicense(meta, auth, emit);
  await postready.runPostReady(meta, auth, emit, { licenseGate: signInGate(meta) });
  // AND THE SEED THE INTERRUPTED CREATE ASKED FOR. The note says the workspace "may be
  // running without its preset configuration or seed data" and names this command as the
  // thing that completes it -- and this used to run post_ready, seed nothing, print
  // "ready" and clear the note anyway.
  //
  // From the NOTE, not from meta: the request died with the process, and
  // meta.extra["seed"] is written only after a seed has already succeeded.
  let pending = pendingSeed(meta.name);
  const activeReceipt = pendingReceipt(meta.name);
  if (
    activeReceipt !== null ||
    (Object.keys(pending).length > 0 && !isTruthy(bag(meta.extra).seed))
  ) {
    if (activeReceipt !== null)
      pending = {
        ...pending,
        seed_profile: activeReceipt.plan.profile,
        seed_scenarios: activeReceipt.plan.scenarios,
        seed_history_days: activeReceipt.plan.historyDays,
      };
    info(
      emit,
      'finishing the seed the interrupted create asked for ' +
        `(profile: ${isTruthy(pending.seed_profile) ? String(pending.seed_profile) : 'small'})`,
      { phase: 'seed' },
    );
    try {
      await seeding.runSeedInline(
        meta,
        isTruthy(pending.seed_profile) ? String(pending.seed_profile) : 'small',
        Boolean(pending.seed_stats),
        emit,
        {
          scenarios: Array.isArray(pending.seed_scenarios)
            ? (pending.seed_scenarios as string[])
            : [],
          historyDays:
            typeof pending.seed_history_days === 'number' ? pending.seed_history_days : null,
          ...(activeReceipt === null
            ? {}
            : {
                users: activeReceipt.plan.users,
                channels: activeReceipt.plan.channels,
                messages: activeReceipt.plan.messages,
              }),
        },
        activeReceipt?.run,
        async () =>
          activeReceipt !== null ||
          (Object.keys(pendingSeed(meta.name)).length > 0 &&
            !isTruthy(bag((await readMeta(meta.name)).extra).seed)),
      );
    } catch (error) {
      if (!(error instanceof ReproError)) throw error;
      // The note STAYS: a seed that could not be finished is exactly what it is for, and
      // clearing it here would delete the only record again.
      warn(
        emit,
        `the interrupted create's seed could not be finished (${errorText(error)}) - ` +
          `the note stays; \`houston seed --name ${meta.name}\` retries it`,
        { phase: 'seed' },
      );
      const running = String(served.version ?? '?');
      sayReady(emit, final);
      return { booted_s: elapsed, running_version: running };
    }
  }
  clearKind(CREATE_UNFINISHED, meta.name);
  const running = String(served.version ?? '?');
  // `baseVersion`: a CI build serves `8.10.0-develop` and is recorded as `8.10.0.dev0`.
  if (running !== '?' && !meta.rcVersion.startsWith(baseVersion(running))) {
    warn(emit, `running version ${running} != requested ${meta.rcVersion}`, { phase: 'wait' });
  }
  sayReady(emit, final);
  return { booted_s: elapsed, running_version: running };
}
