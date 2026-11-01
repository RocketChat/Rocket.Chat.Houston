/**
 * Which host ports a workspace may take, and picking one without racing.
 *
 * Tier 1. Creates hold `withPortPublication` across choosing every port they need and
 * publishing their workspace record. Choosing a port alone does not reserve it: the record
 * holding it does.
 *
 * Side services and monitoring PREFER the registry's ports (`config.PRESET_PORTS`,
 * `config.MONITOR_PORTS`): the first workspace on a machine gets them, the next with the same
 * preset gets the next free port, and its record keeps it (`claimSidePorts`). Only ports that
 * cannot move -- voice's call ports, a preset file's own -- are refused when taken.
 */
import * as config from '../../lib/config';
import { ConflictError, ValidationError } from '../../lib/errors';
import { VOICE_DEFAULT_PORTS } from '../../lib/presets/voice';
import { emptyPreset, type Preset } from '../../lib/presets/types';
import { reproLock } from '../runner/locks';
import * as paths from '../runner/paths';
import * as portSeam from '../runner/ports';
import {
  type Metadata,
  grafanaPortOf,
  listMeta,
  prometheusPortOf,
  readMeta,
  recordedOwner,
  sidePortsOf,
} from '../runner/record';

import { INTERACTIVE_LOCK_WAIT } from './types';

/** `'bob-t1' (bob's)`: the holder of a port, with its owner when the record names one. */
function holder(meta: Metadata): string {
  const owner = recordedOwner(meta);
  return `'${meta.name}'${owner === '' ? '' : ` (${owner}'s)`}`;
}

/** A list of ports, spelled as the message has always spelled it: `[8081]`, `[9090, 5050]`. */
function portList(ports: readonly number[]): string {
  return `[${ports.map(String).join(', ')}]`;
}

/** An integer, or a string of ASCII digits read as one; anything else is null. */
function digits(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value === 'string' && /^\d+$/u.test(value)) return Number.parseInt(value, 10);
  return null;
}

export async function ownPorts(name: string): Promise<Set<number>> {
  if (!name || !(await paths.exists(name))) return new Set();
  let meta: Metadata;
  try {
    meta = await readMeta(name);
  } catch {
    // half-written record
    return new Set();
  }
  return claimedPorts(meta);
}

/** Every recorded publication participates, regardless of which service requested it. */
function claimedPorts(meta: Metadata): Set<number> {
  const own = new Set<number>([meta.hostPort]);
  const extra = meta.extra;
  const n = extra.instances;
  if (typeof n === 'number' && Number.isInteger(n) && n > 1) {
    for (let i = 1; i <= n; i += 1) own.add(meta.hostPort + i);
  }
  // tls_ports too, or `up --force --https` on an existing repro would not recognise its
  // OWN TLS port as reusable and would drift to the next one -- leaking a port number on
  // every recreate, and changing the URL each time.
  for (const key of ['sidecar_ports', 'monitoring_ports', 'tls_ports']) {
    const claimed = extra[key];
    if (!Array.isArray(claimed)) continue;
    for (const value of claimed) {
      const port = digits(value);
      if (port !== null) own.add(port);
    }
  }
  // A Kubernetes workspace's live forwards, keyed by host port: a record written before it
  // recorded `sidecar_ports` holds its side ports only here.
  const forwards = extra.scenario_forwards;
  if (forwards !== null && typeof forwards === 'object' && !Array.isArray(forwards)) {
    for (const key of Object.keys(forwards)) {
      const port = digits(key);
      if (port !== null) own.add(port);
    }
  }
  return own;
}

/** A workspace already holding side ports another wants, and which of them. */
export interface SideHolder {
  name: string;
  ports: number[];
}

/**
 * Walk the records once: the first workspace but `exclude` holding any of `wanted`, and
 * `exclude`'s own allocation, which is what `checkSidecarPorts` refuses or lets through.
 */
async function sideClaims(
  wanted: ReadonlySet<number>,
  exclude: string,
): Promise<{ held: SideHolder | null; own: Set<number>; whose: string }> {
  let own = new Set<number>();
  for (const meta of await listMeta()) {
    const claimed = claimedPorts(meta);
    if (meta.name === exclude) {
      own = claimed;
      continue;
    }
    const overlap = [...claimed].filter((value) => wanted.has(value)).sort((a, b) => a - b);
    if (overlap.length > 0)
      return { held: { name: meta.name, ports: overlap }, own, whose: holder(meta) };
  }
  return { held: null, own, whose: '' };
}

/**
 * Refuse a port that cannot move when another workspace, or something else on this machine,
 * holds it. Only those: a side service on a registry port is given another one instead
 * (`claimSidePorts`), which runs this on the rest.
 */
export async function checkSidecarPorts(pre: Preset, exclude = ''): Promise<void> {
  if (pre.ports.length === 0) return;
  const wanted = new Set(pre.ports);
  const { held, own, whose } = await sideClaims(wanted, exclude);
  if (held !== null) {
    // Its owner's call, not the reader's: on a shared server the holder is often a colleague's.
    throw new ConflictError(
      `preset '${pre.name}' publishes port(s) ${portList(held.ports)}, already claimed ` +
        `by workspace ${whose}. These ports cannot move to another number (voice's call ` +
        'ports, which phones dial, or ports a preset file lists), so only one workspace on ' +
        `this machine can use them at a time; its owner frees them with houston down --name ` +
        `${held.name} --volumes (that deletes its data)`,
    );
  }
  for (const port of [...wanted].filter((p) => !own.has(p)).sort((a, b) => a - b)) {
    if (!(await portSeam.portFree(port))) {
      throw new ConflictError(
        `preset '${pre.name}' needs host port ${String(port)}, already in use on this machine`,
      );
    }
  }
}

/** Monitoring's host ports by what they serve, in the order `extra.monitoring_ports` keeps. */
export type MonitorSlot = 'prometheus' | 'grafana';

/** What `claimSidePorts` gave a workspace. */
export interface SidePortClaim {
  /** The preset built on the ports given: `atRegistry` itself when none moved. */
  pre: Preset;
  /** The presets whose ports moved, as `extra.side_ports` records them: `{}` when none did. */
  side: Record<string, number[]>;
  /** Monitoring's ports in the order asked, as `extra.monitoring_ports` records them. */
  monitoring: number[];
  /** Each port the workspace held that it could not keep: whose, which, and the one it got. */
  moved: (readonly [string, number, number])[];
}

/** One host port a workspace needs: a registry preset's by position, or monitoring's. */
interface Slot {
  readonly key: string;
  readonly index: number;
  readonly preferred: number;
}

const PREFERRED_MONITOR: Readonly<Record<MonitorSlot, number>> = Object.freeze({
  prometheus: config.MONITOR_PORTS[0],
  grafana: config.MONITOR_PORTS[1],
});

/**
 * Ports no scan hands out. The preferred ones, because each is the FIRST workspace's: a second
 * saml taking ldap's 8082 would push the next ldap workspace off it. And voice's, which phones
 * and the PBX dial by number.
 */
function reservedPorts(): Set<number> {
  return new Set([
    ...Object.values(config.PRESET_PORTS).flat(),
    ...config.MONITOR_PORTS,
    ...VOICE_DEFAULT_PORTS,
  ]);
}

/** The lowest port above `from` not in `skip` and free on this machine; bounded like `pickPort`. */
async function nextFreePort(from: number, skip: ReadonlySet<number>): Promise<number> {
  for (let port = from + 1; port <= portSeam.PORT_MAX; port += 1) {
    if (!skip.has(port) && (await portSeam.portFree(port))) return port;
  }
  throw new ConflictError(
    `no free host port above ${String(from)} (scanned to ${String(portSeam.PORT_MAX)}) -- ` +
      'can this environment bind TCP ports at all?',
  );
}

/**
 * Give a workspace the side and monitoring ports it needs, preferred first.
 *
 * `atRegistry` is the preset built on the registry's ports: every registry number it publishes
 * is a slot that may move, and anything else it publishes is fixed. Each slot keeps the port
 * the workspace's record holds (`sidePortsOf`, else the preferred one) while no other record
 * claims it and it is still the workspace's (`stillHeld`) or free; otherwise it gets the next
 * free port, skipping every claimed, preferred and voice port. `rebuild` builds the preset on
 * the ports given, once, when any moved; the fixed ports then get the refusal they always had.
 *
 * `reserve` is the request's own `--port` span, which no scan may land on. `stillHeld` decides
 * a port the workspace already holds: a Docker rebuild asks whether its own containers still
 * have it (and moves it, said, when something else took it); a Kubernetes re-up never moves.
 *
 * Callers hold `withPortPublication` from here until the record naming these ports is written.
 */
export async function claimSidePorts(
  name: string,
  atRegistry: Preset,
  rebuild: (ports: config.PortMap) => Preset,
  {
    monitoring = [],
    reserve = [],
    stillHeld = async () => true,
  }: {
    monitoring?: readonly MonitorSlot[];
    reserve?: readonly number[];
    stillHeld?: (port: number) => Promise<boolean>;
  } = {},
): Promise<SidePortClaim> {
  const metas = await listMeta();
  const mine = metas.find((meta) => meta.name === name) ?? null;
  const own = mine === null ? new Set<number>() : claimedPorts(mine);
  const others = new Set<number>();
  for (const meta of metas) {
    if (meta.name !== name) for (const port of claimedPorts(meta)) others.add(port);
  }
  const recorded = mine === null ? {} : sidePortsOf(mine);
  const recordedMonitor: Readonly<Record<MonitorSlot, number>> =
    mine === null
      ? PREFERRED_MONITOR
      : { prometheus: prometheusPortOf(mine), grafana: grafanaPortOf(mine) };

  const slots: Slot[] = [];
  for (const [key, preferred] of Object.entries(config.PRESET_PORTS)) {
    preferred.forEach((port, index) => {
      if (atRegistry.ports.includes(port)) slots.push({ key, index, preferred: port });
    });
  }
  const movable = new Set(slots.map((slot) => slot.preferred));
  const fixed = atRegistry.ports.filter((port) => !movable.has(port));
  for (const key of monitoring) slots.push({ key, index: 0, preferred: PREFERRED_MONITOR[key] });

  const reserved = reservedPorts();
  const skip = new Set([...reserved, ...others, ...own, ...fixed, ...reserve]);
  // Its own Rocket.Chat ports: a recorded side port there (a hand-edited record) is not kept.
  const instances = Number((mine?.extra ?? {}).instances) || 0;
  const front =
    mine === null
      ? []
      : Array.from({ length: instances > 1 ? instances + 1 : 1 }, (_, at) => mine.hostPort + at);
  const taken = new Set<number>();
  const chosen: number[] = [];
  const moved: [string, number, number][] = [];
  const open = (slot: Slot, port: number): boolean =>
    !others.has(port) &&
    !taken.has(port) &&
    !fixed.includes(port) &&
    !front.includes(port) &&
    (port === slot.preferred || !reserved.has(port));
  for (const slot of slots) {
    const wanted =
      slot.key in PREFERRED_MONITOR
        ? recordedMonitor[slot.key as MonitorSlot]
        : (recorded[slot.key]?.[slot.index] ?? slot.preferred);
    const keep =
      open(slot, wanted) &&
      (own.has(wanted) ? await stillHeld(wanted) : await portSeam.portFree(wanted));
    // A moved port it lost goes back to its own preferred number first, when that is free now.
    const back =
      !keep &&
      wanted !== slot.preferred &&
      open(slot, slot.preferred) &&
      (await portSeam.portFree(slot.preferred));
    const port = keep
      ? wanted
      : back
        ? slot.preferred
        : await nextFreePort(slot.preferred, new Set([...skip, ...taken]));
    if (!keep && own.has(wanted)) moved.push([slot.key, wanted, port]);
    taken.add(port);
    chosen.push(port);
  }

  const side: Record<string, number[]> = {};
  slots.forEach((slot, at) => {
    const preferred = config.PRESET_PORTS[slot.key];
    if (preferred === undefined || chosen[at] === slot.preferred) return;
    const ports = side[slot.key] ?? [...preferred];
    ports[slot.index] = chosen[at] as number;
    side[slot.key] = ports;
  });
  const pre = Object.keys(side).length === 0 ? atRegistry : rebuild(side);
  // The rest cannot move: refused as they always were, whoever holds them.
  await checkSidecarPorts({ ...pre, ports: pre.ports.filter((port) => !taken.has(port)) }, name);
  // Recorded only where the rebuilt preset publishes it: a preset FILE shadowing a built-in
  // name ignores the ports it is given, and its record must say what it really publishes.
  for (const [key, ports] of Object.entries(side)) {
    if (!ports.every((port) => pre.ports.includes(port))) delete side[key];
  }
  return {
    pre,
    side,
    monitoring: chosen.slice(chosen.length - monitoring.length),
    moved,
  };
}

/**
 * Monitoring's ports alone, for `houston monitor` on a workspace that exists: its own while
 * it holds them, else preferred first. Callers hold `withPortPublication` until the record
 * names them.
 */
export async function claimMonitorPorts(
  name: string,
  monitoring: readonly MonitorSlot[],
): Promise<number[]> {
  const none = emptyPreset('');
  return (await claimSidePorts(name, none, () => none, { monitoring })).monitoring;
}

/**
 * The home-wide lock name port allocation serialises on.
 *
 * `reproLock` is PER REPRO, and two creates for two different names hold two different
 * locks -- so both could read `usedPorts()`, see the same gap and pick the same port, and
 * the heavy pool allows at least two creates at once by design. A box-wide name (no
 * workspace is called this; `requireValidName` would reject the leading underscore) makes
 * allocation the one cross-workspace critical section in a shared server's home.
 */
export const PORT_LOCK = '_ports';

/**
 * Check and publish the complete allocation before another workspace can choose.
 *
 * The existing workspace record is the claim: no new reservation format or abandoned
 * claim file is introduced. A failure before publication releases the native lock;
 * after publication, a partial workspace retains its claim until safe teardown.
 * Actual deployment and readiness must run outside this section.
 */
export async function withPortPublication<T>(publish: () => Promise<T>): Promise<T> {
  return await reproLock(PORT_LOCK, publish, { timeoutMs: INTERACTIVE_LOCK_WAIT * 1000 });
}

/**
 * Choose a free host port. Creates retain the enclosing publication lock after this
 * nested, reentrant choice until their side/monitoring/RC claims are visible.
 */
export async function pickHostPort(port: number, pre: Preset, exclude = ''): Promise<number> {
  return await reproLock(PORT_LOCK, async () => await pickHostPortLocked(port, pre, exclude), {
    timeoutMs: INTERACTIVE_LOCK_WAIT * 1000,
  });
}

export async function pickHostPortLocked(port: number, pre: Preset, exclude = ''): Promise<number> {
  const span = pre.instances > 1 ? pre.instances + 1 : 1;
  if (port) {
    if (port + span - 1 > portSeam.PORT_MAX) {
      throw new ValidationError(
        `--port ${String(port)}: a ${String(pre.instances)}-instance workspace needs ports ` +
          `up to ${String(port + span - 1)} (past 65535)`,
      );
    }
    const own = await ownPorts(exclude);
    const used = new Set(
      [...(await portSeam.usedPorts())].filter((usedPort) => !own.has(usedPort)),
    );
    // A legacy duplicate record is another claim even when this workspace claims
    // the same number. Excluding one's own record must not erase somebody else's.
    for (const meta of await listMeta()) {
      if (meta.name !== exclude) {
        for (const claimed of claimedPorts(meta)) used.add(claimed);
      }
    }
    for (let candidate = port; candidate < port + span; candidate += 1) {
      // An instance's own port on one of this workspace's side ports (saml's 8081,
      // ldap's 8082...): both would be published on it, and only one can be.
      if (pre.ports.includes(candidate)) {
        if (candidate === port) {
          throw new ConflictError(
            `--port ${String(port)} is also a port this workspace's presets or monitoring publish. Pick a different --port.`,
          );
        }
        throw new ConflictError(
          `--port ${String(port)}: instance port ${String(candidate)} is also a port this ` +
            "workspace's presets publish. Pick a --port whose next " +
            `${String(span - 1)} ports avoid ${pre.ports.join(', ')}.`,
        );
      }
      if (used.has(candidate)) {
        throw new ConflictError(
          `port ${String(candidate)} is already claimed by another workspace (see \`houston list\`)`,
        );
      }
      if (!own.has(candidate) && !(await portSeam.portFree(candidate))) {
        throw new ConflictError(`port ${String(candidate)} is already in use on this machine`);
      }
    }
    return port;
  }
  try {
    let start = 3000;
    for (;;) {
      const candidate =
        span > 1 ? await portSeam.pickPortRange(span, start) : await portSeam.pickPort(start);
      if (!pre.ports.some((side) => side >= candidate && side < candidate + span)) return candidate;
      start = candidate + 1;
      if (start + span - 1 > portSeam.PORT_MAX)
        throw new Error('no free allocation avoids the preset ports');
    }
  } catch (error) {
    throw new ConflictError(error instanceof Error ? error.message : String(error));
  }
}
