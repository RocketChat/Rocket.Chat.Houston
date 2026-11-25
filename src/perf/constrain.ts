/**
 * Emulate customer-sized hardware for a load test.
 *
 * `--constrain "rc=2cpu/2g,mongo=1cpu/1g"` caps the repro's services with `docker update`
 * (live, no restart) so results answer "what does THEIR 2-CPU/2GB box handle?" instead of
 * "what does my laptop handle" -- then restores the caps afterwards.
 *
 * RESTORE SEMANTICS. `docker update` cannot CLEAR a limit (setting 0 is silently ignored
 * by the engine), so a service that was unlimited before is restored to the docker VM's
 * full capacity -- functionally identical, since a container can never exceed the VM
 * anyway.
 */
import { formatG, parseFloat_ } from '../lib/format';

import { dockerCapacity } from '../core/runner/host';
import { serviceContainerIds } from '../core/runner/engine';
import { docker } from '../seams/docker-cli';
import { cleanup } from '../seams/exec';

const MEM_RE = /^\d+(\.\d+)?(g|gb|m|mb)$/u;

export interface Limit {
  cpus: number | null;
  mem: string | null;
}

/**
 * `'rc=2cpu/2g,mongo=1cpu'` -> `{rc: {cpus: 2.0, mem: '2g'}, …}`.
 *
 * Each entry is `svc=PARTS` with `/`-separated parts: a CPU count (`2cpu`, `0.5cpu`)
 * and/or a memory cap (`2g`, `512m`). Throws on nonsense.
 */
export function parse(spec: string): Record<string, Limit> {
  const out: Record<string, Limit> = {};
  for (const piece of spec.split(',')) {
    const entry = piece.trim();
    if (!entry) continue;
    if (!entry.includes('=')) {
      throw new Error(`bad constraint '${entry}' (want e.g. rc=2cpu/2g)`);
    }
    const at = entry.indexOf('=');
    const svc = entry.slice(0, at).trim().toLowerCase();
    const val = entry.slice(at + 1);
    let cpus: number | null = null;
    let mem: string | null = null;
    for (const part of val.split('/')) {
      const p = part.trim().toLowerCase();
      if (p.endsWith('cpu')) {
        try {
          cpus = parseFloat_(p.slice(0, -3));
        } catch {
          throw new Error(`bad CPU count in '${entry}' (want e.g. 2cpu, 0.5cpu)`);
        }
        if (cpus <= 0) throw new Error(`CPU count must be > 0 in '${entry}'`);
      } else if (MEM_RE.test(p)) {
        // docker accepts 2g / 512m.
        mem = p.replace(/b+$/u, '');
      } else {
        throw new Error(`bad constraint part '${part}' in '${entry}' (want e.g. 2cpu, 2g, 512m)`);
      }
    }
    if (cpus === null && mem === null) {
      throw new Error(`constraint '${entry}' sets neither CPU nor memory`);
    }
    out[svc] = { cpus, mem };
  }
  return out;
}

/**
 * Expand aliases against the repro's actual compose services.
 *
 * `rc` -> rocketchat / rocketchat-1..N, `mongo` -> mongodb; anything else must be an exact
 * service name. Throws for an unknown service, naming the ones that exist -- a typo that
 * silently capped nothing would report a load result for an unconstrained workspace.
 */
export function resolveServices(
  constraints: Record<string, Limit>,
  services: readonly string[],
): Record<string, Limit> {
  const resolved: Record<string, Limit> = {};
  for (const [alias, lim] of Object.entries(constraints)) {
    let targets: string[];
    if (alias === 'rc') {
      targets = services.filter((s) => s === 'rocketchat' || s.startsWith('rocketchat-'));
    } else if (alias === 'mongo') {
      targets = services.filter((s) => s === 'mongodb');
    } else {
      targets = services.filter((s) => s === alias);
    }
    if (targets.length === 0) {
      throw new Error(
        `no service '${alias}' in this workspace (services: ${[...services].sort().join(', ')})`,
      );
    }
    for (const t of targets) resolved[t] = lim;
  }
  return resolved;
}

/** `'rc=2cpu/2g, mongo=1cpu'` -- for banners, reports and baselines. */
export function human(constraints: Record<string, Limit>): string {
  const parts: string[] = [];
  for (const [svc, lim] of Object.entries(constraints)) {
    const bits: string[] = [];
    if (lim.cpus !== null) bits.push(`${formatG(lim.cpus)}cpu`);
    if (lim.mem) bits.push(lim.mem);
    parts.push(`${svc}=${bits.join('/')}`);
  }
  return parts.join(', ');
}

export interface Applied {
  /** Container id. */
  container: string;
  service: string;
  /** NanoCpus before we touched it (0 = unlimited). */
  prior_nano: number;
  /** Memory bytes before (0 = unlimited). */
  prior_mem: number;
  /** MemorySwap before (0/-1 = default/unlimited). */
  prior_swap: number;
  /**
   * WHICH dimensions `apply()` actually capped.
   *
   * Without this, `restore()` writes both and imposes a memory limit (and disables swap)
   * on a service that was only ever CPU-capped -- a change the test never asked for.
   */
  set_cpus: boolean;
  set_mem: boolean;
}

async function inspectLimits(cid: string): Promise<[number, number, number]> {
  const r = await docker(
    [
      'inspect',
      '--format',
      '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}',
      cid,
    ],
    { capture: true, text: true, timeoutMs: 30_000 },
  );
  if (r.exitCode !== 0) {
    throw new Error(`docker inspect failed: ${String(r.stderr).trim()}`);
  }
  const parts = String(r.stdout)
    .trim()
    .split(/\s+/u)
    .filter((x) => x !== '');
  const values = parts.map((x) => (/^[+-]?\d+$/u.test(x) ? Number.parseInt(x, 10) : NaN));
  if (values.length !== 3 || values.some((v) => Number.isNaN(v))) {
    // Anything but three integers (a template mismatch, a truncated read) must surface as
    // the error every caller catches, not as a parse failure deeper in.
    throw new Error(
      `could not read current limits for ${cid.slice(0, 12)}: '${String(r.stdout).trim()}'`,
    );
  }
  return [values[0] as number, values[1] as number, values[2] as number];
}

async function update(cid: string, cpus: number | null, mem: string | null): Promise<void> {
  const cmd = ['update'];
  if (cpus !== null) cmd.push('--cpus', formatG(cpus));
  // The same value for both: no extra swap.
  if (mem) cmd.push('--memory', mem, '--memory-swap', mem);
  cmd.push(cid);
  const r = await docker(cmd, { capture: true, text: true, timeoutMs: 60_000 });
  if (r.exitCode !== 0) throw new Error(`docker update failed: ${String(r.stderr).trim()}`);
}

/** The used half of `docker stats`' `1.417GiB / 9.79GiB`, in bytes; 0 when unread. */
function usedBytes(text: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)(i?)b/iu.exec(text);
  if (m === null) return 0;
  const power = ['', 'k', 'm', 'g', 't'].indexOf((m[2] ?? '').toLowerCase());
  return Number(m[1]) * (m[3] === '' ? 1000 : 1024) ** Math.max(power, 0);
}

/** Docker's own reading of a `--memory` value: a bare number is bytes, k/m/g are binary. */
function capBytes(mem: string): number {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([bkmg]?)b?\s*$/iu.exec(mem);
  if (m === null) return Number.NaN;
  const unit = { '': 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] ?? '').toLowerCase()];
  return Number(m[1]) * (unit ?? 1);
}

/**
 * Refuse a memory cap the container is already over.
 *
 * Docker applies it at once and the kernel kills the process: `rc=1cpu/1g` on a Rocket.Chat
 * using 1.4 GiB restarted it as the test began, every request failed, and the run reported
 * 100% errors as a load result, exit 0, with nothing said. A cap that cannot hold what is
 * already running measures the restart, not the load.
 */
async function refuseACapBelowUse(cid: string, svc: string, mem: string): Promise<void> {
  const r = await docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', cid], {
    capture: true,
    text: true,
    timeoutMs: 30_000,
  });
  if (r.exitCode !== 0) return; // unread is not refused: the cap is the user's to try
  const used = usedBytes(String(r.stdout));
  const cap = capBytes(mem);
  if (used > 0 && Number.isFinite(cap) && cap <= used) {
    throw new Error(
      `${svc}=${mem} is below the ${(used / 1024 ** 3).toFixed(2)} GiB it uses now, so ` +
        'the kernel would kill it as the test starts and the run would measure its restart. ' +
        'Give it more, or constrain only its CPU',
    );
  }
}

/**
 * Cap each service's running container(s); returns what was applied (with prior limits)
 * for `restore`.
 *
 * A mid-way failure ROLLS BACK what was already applied, then re-throws -- the caller
 * never has to clean up a partial apply.
 */
export async function apply(name: string, perService: Record<string, Limit>): Promise<Applied[]> {
  const applied: Applied[] = [];
  try {
    for (const [svc, lim] of Object.entries(perService)) {
      const ids = await serviceContainerIds(name, svc);
      if (ids.length === 0) {
        throw new Error(`no running container for service '${svc}' — is the workspace up?`);
      }
      for (const cid of ids) {
        const [nano, mem, swap] = await inspectLimits(cid);
        if (lim.mem) await refuseACapBelowUse(cid, svc, lim.mem);
        await update(cid, lim.cpus, lim.mem);
        applied.push({
          container: cid,
          service: svc,
          prior_nano: nano,
          prior_mem: mem,
          prior_swap: swap,
          set_cpus: lim.cpus !== null,
          set_mem: Boolean(lim.mem),
        });
      }
    }
  } catch (error) {
    // As cleanup, so a Ctrl-C that raised in here does not end the process before the caps
    // already set go back: nothing has noted them yet, so nothing else would.
    await cleanup(async () => await restore(applied));
    throw error;
  }
  return applied;
}

/**
 * The MemorySwap value to restore alongside `mem`.
 *
 * Docker's MemorySwap: -1 is unlimited, > 0 is an explicit limit, and 0 is "unset", which
 * the runtime reads as TWICE the memory limit. Folding that 0 into "swap == memory" (no
 * swap at all) restores a STRICTER configuration than the container started with, so
 * reproduce the 2x default instead.
 */
export function restoreSwap(a: Applied, mem: number): number {
  // Previously unlimited -> match apply()'s no-extra-swap.
  if (!a.prior_mem) return Math.trunc(mem);
  // -1 (unlimited) or an explicit byte limit.
  if (a.prior_swap) return Math.trunc(a.prior_swap);
  // Docker's implicit default.
  return Math.trunc(a.prior_mem) * 2;
}

/**
 * Undo `apply`, touching ONLY the dimensions `apply()` actually capped.
 *
 * Prior real limits are restored exactly; a dimension that was unlimited goes back to the
 * docker VM's full capacity (see the module comment). Returns human-readable problems
 * instead of throwing: restore runs inside the callers' `finally`, so an exception here
 * would skip their remaining cleanup and mask whatever error triggered it.
 */
export async function restore(applied: readonly Applied[]): Promise<string[]> {
  if (applied.length === 0) return [];
  const cap = (await dockerCapacity()) ?? ([0.0, 0] as [number, number]);
  const problems: string[] = [];
  for (const a of applied) {
    const cmd = ['update'];
    const unresolved: string[] = [];
    if (a.set_cpus) {
      const cpus = a.prior_nano ? a.prior_nano / 1e9 : cap[0];
      if (cpus) cmd.push('--cpus', formatG(cpus));
      else unresolved.push('CPU');
    }
    if (a.set_mem) {
      const mem = a.prior_mem ? a.prior_mem : cap[1];
      if (mem) {
        cmd.push('--memory', String(Math.trunc(mem)), '--memory-swap', String(restoreSwap(a, mem)));
      } else {
        unresolved.push('memory');
      }
    }
    // Report EVERY dimension that could not be put back. Testing only "is the command
    // still empty" hid the mixed case (one dimension known, the other not), leaving half
    // the test's cap applied with no warning at all.
    if (unresolved.length > 0) {
      problems.push(
        `${a.service}: could not determine ${unresolved.join('/')} capacity to restore - ` +
          "the test's cap is still applied",
      );
    }
    if (cmd.length === 1) continue;
    cmd.push(a.container);
    try {
      const r = await docker(cmd, { capture: true, text: true, timeoutMs: 60_000 });
      if (r.exitCode !== 0) throw new Error(String(r.stderr).trim());
    } catch (error) {
      problems.push(`${a.service}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}
