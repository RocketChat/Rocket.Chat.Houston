/**
 * What a workspace costs, and whether this box has it.
 *
 * Tier 0. `checkCapacity` REFUSES rather than warning: the tool is usually run on a laptop
 * already running other stacks, and a create that starts and then cannot finish leaves a
 * half-made workspace behind.
 */
import { namesOf } from '../../lib/presets/composite';
import { PreflightError } from '../../lib/errors';
import { formatFixed } from '../../lib/format';
import { type Emit, nullEmit, warn } from '../../lib/events';
import * as topology from '../topology';
import * as host from '../runner/host';
import { projectStates } from '../runner/queries';
import { listMeta, recordedOwner } from '../runner/record';

import * as request from './request';
import { type CreateReq } from './types';

/**
 * Rocket.Chat settled at 670-770 MB and MongoDB at 124-184 MB per workspace on the host
 * that OOMed -- so ~950 MB at REST. Rounded UP to 1100, deliberately: those were idle
 * figures, RC's Node heap reached 721 MB under a mild load test, and calibrating to the
 * resting case would have permitted exactly the seven stacks that took the machine down.
 */
export const WORKSPACE_MB = 1100;

/** Sidecars a preset adds. Keycloak (saml/oidc) is by far the largest. */
export const PRESET_MB: Readonly<Record<string, number>> = Object.freeze({
  saml: 450,
  oidc: 450,
  s3_minio: 120,
  ldap: 80,
  livechat: 60,
  'multi-instance': 400,
  email: 40,
  webhooks: 30,
});

/**
 * What the ldap preset's params add to its charge. `directory=ad`: Samba held 56 MB with
 * 1,600 users and 103 MB with 20,000 (measured), where OpenLDAP's share of `PRESET_MB.ldap`
 * is small, so it is charged by size. `idp`: a Keycloak, as the saml and oidc presets charge
 * for theirs. A composed workspace names the params `ldap.*`.
 */
export function ldapParamsMb(params: Record<string, unknown>): number {
  const param = (key: string): unknown => params[`ldap.${key}`] ?? params[key];
  let need = 0;
  if (param('directory') === 'ad') {
    const users = Number.parseInt(String(param('users') ?? '5'), 10);
    need += 60 + 3 * Math.ceil((Number.isNaN(users) ? 5 : users) / 1000);
  }
  if (param('idp') === 'saml' || param('idp') === 'oidc') need += PRESET_MB.saml ?? 0;
  return need;
}

/**
 * What the voice preset's `sip_integration=on` adds: Drachtio and FreeSWITCH, measured idle at
 * 7 and 27 MiB on 8.7.0, with room for calls; `pbx=on` adds the lab's Asterisk, idle at
 * 48.5 MiB (2026-10-16). A composed workspace names the params `voice.sip_integration` and
 * `voice.pbx`; 2.1.3 spelled the first `sip` (VOICE_PARAM_ALIASES), and its records still do.
 */
export function voiceParamsMb(params: Record<string, unknown>): number {
  const on = (key: string): boolean =>
    String(params[`voice.${key}`] ?? params[key] ?? '')
      .trim()
      .toLowerCase() === 'on';
  return (on('sip_integration') || on('sip') ? 60 : 0) + (on('pbx') ? 80 : 0);
}

/** Prometheus + Grafana + Loki + the OTel collector + two exporters. */
export const MONITORING_MB = 280;

/**
 * Kubernetes costs on top of a workspace, and both are load-bearing for the same reason
 * WORKSPACE_MB is: the formula that refuses a create has to know what it is about to
 * start, or it refuses the wrong things and permits the fatal ones.
 *
 * CLUSTER_MB is MEASURED -- `docker stats kind-control-plane` reads 573 MiB idle -- and
 * is charged ONCE, only when the cluster still has to be created. Every workspace after
 * that shares it.
 */
export const CLUSTER_MB = 600;

/**
 * What the CHART costs beyond the app itself, and it applies to both deployments.
 * Measured, and it corrected an assumption: a "monolith" on this chart is FIVE pods, not
 * two -- it runs NATS regardless of `microservices.enabled`.
 */
export const KUBE_CHART_MB = 500;

/**
 * MICROSERVICES_MB is now HALF measured: a microservices workspace on chart 7.0.2 is nine
 * pods against a monolith's five, and the four extra are `account`, `authorization`,
 * `ddp-streamer` and `presence`. What those four COST is still estimated, 4 x ~200 MB,
 * and it stays deliberately on the generous side: under-charging lets through a create
 * that OOMs a swapless host.
 */
export const MICROSERVICES_MB = 800;

/**
 * Left unspent: for the OS, Docker, the page cache -- and, mostly, for GROWTH. A fifth of
 * the host, never below 1 GB.
 *
 * The proportion is the lesson from the incident. That box OOMed while MemAvailable still
 * read ~3.3 GB, because the danger is not the memory a workspace takes at admission but
 * the memory seven already-admitted ones take an hour later.
 */
export function hostReserveMb(totalMb: number): number {
  return Math.max(1024, Math.floor(totalMb / 5));
}

export interface Capacity {
  known: boolean;
  total_mb?: number;
  available_mb?: number;
  reserve_mb?: number;
  swap_mb?: number;
  workspace_mb?: number;
  room?: number;
  room_denominated_in?: string;
  room_by_runtime?: Record<string, number>;
}

/**
 * How much room this machine has left, in workspaces.
 *
 * ONE formula, three consumers: `checkCapacity` refuses a create with it, `houston
 * doctor` reports it, and the GUI's home page leads with it. They used to agree by
 * coincidence -- doctor carried its own copy of the arithmetic -- and a home page that
 * says "room for 2 more" while the create is refused is worse than one that says
 * nothing.
 *
 * `room` IS DENOMINATED IN COMPOSE WORKSPACES, AND SAYS SO. It divided by WORKSPACE_MB
 * (1100) and was reported as the machine's capacity whatever runtime the reader was
 * about to use -- while a Kubernetes microservices workspace costs 2400 plus 600 for a
 * control plane. `room_by_runtime` is the honest answer, and `room` keeps its meaning for
 * the three existing consumers rather than changing under them.
 */
export async function capacity(): Promise<Capacity> {
  const mem = await host.hostMemory();
  if (mem === null) return { known: false };
  const [totalMb, availMb, swapMb] = mem;
  const reserve = hostReserveMb(totalMb);
  const usable = Math.max(0, availMb - reserve);
  const rooms: Record<string, number> = {};
  const shapes: readonly [string, string, string][] = [
    ['docker', topology.DOCKER, ''],
    ['kubernetes-monolith', topology.KUBERNETES, topology.MONOLITH],
    ['kubernetes-microservices', topology.KUBERNETES, topology.MICROSERVICES],
  ];
  for (const [label, runtime, deployment] of shapes) {
    const cost = runtimeCost(runtime, deployment);
    const per = Math.trunc(cost.workspace_mb) || WORKSPACE_MB;
    rooms[label] = Math.floor(Math.max(0, usable - Math.trunc(cost.cluster_mb)) / per);
  }
  return {
    known: true,
    total_mb: totalMb,
    available_mb: availMb,
    reserve_mb: reserve,
    swap_mb: swapMb,
    workspace_mb: WORKSPACE_MB,
    room: Math.floor(usable / WORKSPACE_MB),
    room_denominated_in: 'docker',
    room_by_runtime: rooms,
  };
}

/**
 * What Kubernetes adds to a workspace's memory bill, in MB.
 *
 * Zero for Compose, which is every workspace today. The control plane is charged only
 * when it still has to be created: it is shared, so billing it to the second and third
 * workspace would refuse creates the host could actually hold.
 */
export function kubeOverheadMb(req: CreateReq, provisioning = true): number {
  if (topology.normalize(req.runtime) !== topology.KUBERNETES) return 0;
  let need = KUBE_CHART_MB;
  if (provisioning) need += CLUSTER_MB;
  // An empty deployment means "that runtime's default", which for Kubernetes is
  // microservices -- the expensive one.
  const deployment = req.deployment || (topology.DEPLOYMENTS[topology.KUBERNETES]?.[0] as string);
  if (deployment === topology.MICROSERVICES) need += MICROSERVICES_MB;
  return need;
}

/**
 * What the container ENGINE must have before a Kubernetes workspace is worth starting:
 * a control plane, the MongoDB operator or a StatefulSet, and on microservices six more
 * Rocket.Chat processes.
 */
export const ENGINE_FLOOR_CPUS = 4;

export const ENGINE_FLOOR_MEMORY_GIB = 6.0;

/**
 * Refuse a Kubernetes create the container engine is too small for.
 *
 * Compose is left alone: it runs two containers and works on a 2 GB VM, so a floor there
 * would refuse creates that succeed today. Silent when the engine cannot be asked -- an
 * unreadable `docker info` is not evidence of a small VM.
 */
export async function checkEngineFloor(
  req: CreateReq,
  emit: Emit = nullEmit,
  provisioning = true,
): Promise<void> {
  if (topology.normalize(req.runtime) !== topology.KUBERNETES) return;
  // The floor's whole premise is that the container VM has to hold a control plane. When
  // the cluster is not one houston is about to build in Docker, the premise is void.
  if (!provisioning) return;
  const cap = await host.dockerCapacity();
  if (cap === null) return;
  const [cpus, memBytes] = cap;
  const gib = memBytes / 1024 ** 3;
  const short: string[] = [];
  if (cpus && cpus < ENGINE_FLOOR_CPUS) {
    // `formatFixed`, not `toFixed`: JavaScript rounds half AWAY FROM ZERO and the
    // established format half TO EVEN, so 5.25 renders "5.3" against the established
    // "5.2". This is the only production module in src/ that called toFixed directly.
    short.push(`${formatFixed(cpus, 0)} CPUs (needs ${String(ENGINE_FLOOR_CPUS)})`);
  }
  if (gib && gib < ENGINE_FLOOR_MEMORY_GIB) {
    // The established text renders the float as `6.0`, which `String(6.0)` shortens to `6`.
    short.push(
      `${formatFixed(gib, 1)} GiB of memory (needs ${formatFixed(ENGINE_FLOOR_MEMORY_GIB, 1)})`,
    );
  }
  if (short.length === 0) return;
  if (req.force) {
    warn(
      emit,
      'the container engine is below the Kubernetes floor — ' +
        short.join(' and ') +
        '. Continuing because --force was given.',
      { phase: 'preflight' },
    );
    return;
  }
  throw new PreflightError(
    'the container engine has ' +
      short.join(' and ') +
      '. A Kubernetes ' +
      'workspace needs a control plane, MongoDB and the chart, and below this it ' +
      'does not fail cleanly -- pods stay Pending with nothing naming memory. ' +
      'Raise the VM (Docker Desktop: Settings -> Resources; Podman: ' +
      '`podman machine set --cpus 4 --memory 6144`), or use --runtime docker. ' +
      '--force overrides this.',
  );
}

export interface RuntimeCost {
  workspace_mb: number;
  cluster_mb: number;
  shape: string;
}

/**
 * Roughly what one workspace costs, from the numbers `checkCapacity` spends.
 *
 * The same constants, not a second set written for the screen: a card that quotes
 * 1.1 GB while the preflight reserves something else is a card that will be
 * contradicted by the refusal it was meant to prevent.
 */
export function runtimeCost(runtime: string, deployment = ''): RuntimeCost {
  if (topology.normalize(runtime) !== topology.KUBERNETES) {
    return { workspace_mb: WORKSPACE_MB, cluster_mb: 0, shape: '2 containers' };
  }
  const shape = deployment || (topology.DEPLOYMENTS[topology.KUBERNETES]?.[0] as string);
  const micro = shape === topology.MICROSERVICES;
  return {
    workspace_mb: WORKSPACE_MB + KUBE_CHART_MB + (micro ? MICROSERVICES_MB : 0),
    cluster_mb: CLUSTER_MB,
    shape: micro ? '9 pods' : '5 pods',
  };
}

/**
 * Say no, and say what to stop instead.
 *
 * Long because the message is the product here: a refusal nobody can act on is a refusal
 * they work around with --force.
 */
export async function refuseForCapacity(
  availableMb: number,
  emit: Emit,
  headroom: number,
  need: number,
  req: CreateReq,
  reserve: number,
  swapMb: number,
  totalMb: number,
): Promise<void> {
  // Running ones first, and marked: those are what stopping frees. ONE `compose ls` for every
  // workspace, never a docker call each; when it cannot be asked, none is marked. Anywhere in
  // the status: a running workspace reads `exited(1), running(2)`, its setup container first.
  const states = (await projectStates()) ?? {};
  const isRunning = (meta: { project: string }): boolean =>
    (states[meta.project] ?? '').includes('running(');
  const metas = await listMeta();
  const existing = [...metas.filter(isRunning), ...metas.filter((meta) => !isRunning(meta))].map(
    (meta) => {
      const owner = recordedOwner(meta);
      const marks = [owner === '' ? '' : `${owner}'s`, isRunning(meta) ? 'running' : ''].filter(
        Boolean,
      );
      return marks.length === 0 ? meta.name : `${meta.name} (${marks.join(', ')})`;
    },
  );
  const swapNote =
    swapMb === 0
      ? '\n  This host has NO SWAP, so there is no buffer at all: memory ' +
        'pressure becomes an OOM kill rather than slowdown.'
      : '';
  if (req.force) {
    // The docstring above has always said "Overridable with --force" and the refusal
    // below has always told the user to pass it -- and nothing here ever read req.force,
    // so the advertised way out did not exist.
    warn(
      emit,
      `--force: creating anyway, though this workspace wants about ` +
        `${String(need)} MB and only ${String(Math.max(0, headroom))} MB is free to use.` +
        `${swapNote} If the host runs out, the OOM killer chooses what ` +
        `dies — which may be a colleague's workspace, not this one.`,
      { phase: 'create' },
    );
    return;
  }
  throw new PreflightError(
    `not enough memory: this workspace needs about ${String(need)} MB and only ` +
      `${String(Math.max(0, headroom))} MB is free to use ` +
      `(${String(availableMb)} MB available, ${String(reserve)} MB kept for the OS, Docker and ` +
      `the page cache, ${String(totalMb)} MB total).${swapNote}\n` +
      `  ${String(existing.length)} workspace(s) on the machine running houston, running ones ` +
      'first: ' +
      `${existing.slice(0, 6).join(', ') || 'none'}${existing.length > 6 ? ' …' : ''}\n` +
      '  Free some memory first: stop one of YOUR running ones (`houston list` shows which); ' +
      "ask the owner before stopping anyone else's.\n" +
      '    houston stop --name <it>      (keeps its data)\n' +
      "  Or override this check if you are sure:  --force (if memory runs out, a colleague's " +
      'workspace may be the one killed)',
  );
}

/**
 * Say so while it is still comfortable, so the ceiling is visible before it is hit
 * rather than only in the refusal.
 */
export function sayWhatIsLeft(emit: Emit, headroom: number, need: number): void {
  if (headroom - need < WORKSPACE_MB) {
    warn(
      emit,
      `after this one, about ${String(Math.max(0, headroom - need))} MB is left ` +
        `— roughly ${String(Math.floor(Math.max(0, headroom - need) / WORKSPACE_MB))} more ` +
        'workspace(s). `houston list` shows what is running.',
      { phase: 'create' },
    );
  }
}

/**
 * What this create will actually take: the workspace, its preset's sidecars, monitoring
 * if asked for, and the Kubernetes overhead -- which is not a Compose workspace with a
 * different label.
 */
export function neededMb(presetName: string, provisioning: boolean, req: CreateReq): number {
  // A composed workspace pays for every preset's sidecars: its combined name is in no table,
  // and charging nothing for it would permit exactly the create this exists to refuse.
  let need = WORKSPACE_MB;
  for (const name of namesOf(presetName)) need += PRESET_MB[name] ?? 0;
  if (namesOf(presetName).includes('ldap')) need += ldapParamsMb(req.params);
  if (namesOf(presetName).includes('voice')) need += voiceParamsMb(req.params);
  if (req.monitor) need += MONITORING_MB;
  need += kubeOverheadMb(req, provisioning);
  return need;
}

/**
 * Refuse to create a workspace the host cannot hold.
 *
 * Written after seven concurrent stacks OOM-killed a 10 GB host with no swap. Every
 * individual `up` had succeeded -- nothing anywhere asked whether there was room for one
 * more, which is exactly the gap docs/design/team-server.md §8 recorded as "made visible,
 * not solved".
 *
 * A REFUSAL rather than a warning, because the failure is not confined to the workspace
 * being created: the OOM killer picks its own victim, so on a shared server this destroys
 * a colleague's work. Overridable with --force, and the message says what to stop instead.
 */
export async function checkCapacity(
  req: CreateReq,
  presetName = '',
  emit: Emit = nullEmit,
): Promise<void> {
  // The ENGINE's floor first, and it is a different question from the host's headroom.
  // Probed once and passed to both, because both ask the same question and the probe
  // talks to a cluster.
  const provisioning = await request.willProvision(req);
  await checkEngineFloor(req, emit, provisioning);
  const mem = await host.hostMemory();
  if (mem === null) return; // not Linux: skip rather than guess
  const [totalMb, availableMb, swapMb] = mem;
  const need = neededMb(presetName, provisioning, req);

  const reserve = hostReserveMb(totalMb);
  const headroom = availableMb - reserve;
  if (need <= headroom) {
    sayWhatIsLeft(emit, headroom, need);
    return;
  }

  await refuseForCapacity(availableMb, emit, headroom, need, req, reserve, swapMb, totalMb);
}
