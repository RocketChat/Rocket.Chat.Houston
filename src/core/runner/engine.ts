/**
 * `docker compose` for one workspace.
 *
 * Every function here is the workspace-aware half: it turns a name into a directory and hands
 * argv to `seams/docker-cli`, which knows nothing about workspaces. The error contracts are
 * the established ones, and they differ on purpose -- the mutating calls propagate a launch
 * failure, the best-effort samplers degrade to "no sample" rather than stranding their
 * caller.
 */
import {
  invalidateQueries,
  compose as runCompose,
  composeFromFile,
  composeStream,
  composeToFile,
  docker,
  STALE_UNIT,
} from '../../seams/docker-cli';
import { Interrupted, type ProcessResult } from '../../seams/exec';

import * as paths from './paths';

export interface ComposeOptions {
  readonly input?: string | Buffer;
  readonly capture?: boolean;
  readonly timeoutMs?: number;
  readonly text?: boolean;
}

/**
 * Run `docker compose <args>` in a repro workspace.
 *
 * `timeoutMs` is opt-in and left unset by default: `up`, `pull` and `logs -f` are
 * legitimately long-running. Bounded callers pass one so a wedged daemon cannot block
 * a worker forever.
 */
export async function compose(
  name: string,
  args: readonly string[],
  options: ComposeOptions = {},
): Promise<ProcessResult> {
  return await runCompose(args, { ...options, cwd: paths.workspace(name) });
}

/**
 * Run `docker compose <args>` streaming combined output line by line, for live
 * progress in the web UI. Returns the exit code.
 */
export async function stream(
  name: string,
  args: readonly string[],
  onLine?: (line: string) => void,
  { abortSignal }: { abortSignal?: AbortSignal } = {},
): Promise<number | null> {
  return await composeStream(args, {
    cwd: paths.workspace(name),
    ...(onLine !== undefined ? { onLine } : {}),
    ...(abortSignal === undefined ? {} : { abortSignal }),
  });
}

/**
 * A compose command that CHANGES container state.
 *
 * Drops the memoised query results afterwards: a dashboard that still showed "running"
 * for two seconds after a Stop would be a cache the user can notice, which is worse
 * than the process spawns the memo saves.
 */
async function mutating(
  name: string,
  args: readonly string[],
  onLine?: (line: string) => void,
): Promise<number | null> {
  try {
    // Streamed when a GUI job asks: docker's own lines are the only progress it can show.
    return onLine === undefined
      ? (await compose(name, args)).exitCode
      : await stream(name, args, onLine);
  } finally {
    invalidateQueries();
  }
}

/**
 * `docker compose up -d`. `forceRecreate` names ONE service to rebuild anyway.
 *
 * Compose decides what to recreate by comparing a config hash it stores on the
 * container. MEASURED that this is not always enough: an `env` apply interrupted
 * mid-recreate left the compose file carrying a variable the container did not have,
 * and a later `up` reported "Booted in 0s" without recreating -- so the workspace kept
 * running configuration its own recorded state disagreed with, and no houston command
 * reconverged it.
 *
 * Scoped to one service on purpose. Recreating everything would take Mongo down with it
 * on every apply, and the whole reason this is safe is that it does not.
 */
export async function up(
  name: string,
  { pull = true, forceRecreate = '' } = {},
): Promise<number | null> {
  if (pull) {
    // A failed pull is deliberately non-fatal: cached images may satisfy `up -d` anyway
    // (a registry hiccup), and `up` itself fails loudly if an image is truly missing.
    await compose(name, ['pull']);
  }
  // --remove-orphans: if the compose file changed shape (a different preset after
  // --force), containers of dropped services are cleaned up.
  const args = ['up', '-d', '--remove-orphans'];
  // --no-deps so rebuilding Rocket.Chat does not take its database with it.
  if (forceRecreate) args.push('--force-recreate', '--no-deps', forceRecreate);
  // The same scope as the up: an `env` apply recreates Rocket.Chat alone, never Mongo.
  const services = forceRecreate ? [forceRecreate] : [];
  return await recreatedIfStale(name, await mutating(name, args), services);
}

/**
 * `rc`, unless the start it reports failed on a systemd unit left by the containers' last
 * run (`STALE_UNIT`): then they are recreated and the recreate's code is returned.
 *
 * Every start of an existing container hit it on that box, so Start, Restart, `up` over a
 * stopped workspace and the backup's restart of Rocket.Chat all failed until somebody removed
 * the containers by hand. `--force-recreate` gives new ids, so new unit names, and carries
 * the named and the anonymous volumes over, which a remove-and-create does not.
 */
export async function recreatedIfStale(
  name: string,
  rc: number | null,
  services: readonly string[] = [],
): Promise<number | null> {
  if (rc === 0 || !(await failedOnStaleUnit(name, services))) return rc;
  const scope = services.length > 0 ? ['--no-deps', ...services] : ['--remove-orphans'];
  return await mutating(name, ['up', '-d', '--force-recreate', ...scope]);
}

async function failedOnStaleUnit(name: string, services: readonly string[]): Promise<boolean> {
  try {
    const ids = await allContainerIds(name, services);
    if (ids.length === 0) return false;
    const errors = await docker(['inspect', '--format', '{{.State.Error}}', ...ids], {
      capture: true,
      timeoutMs: 15_000,
    });
    return errors.exitCode === 0 && STALE_UNIT.test(String(errors.stdout ?? ''));
  } catch (error) {
    if (error instanceof Interrupted) throw error;
    return false;
  }
}

/** The ids of `services`' containers (all of them for none), stopped ones included. */
async function allContainerIds(name: string, services: readonly string[]): Promise<string[]> {
  const listed = await compose(name, ['ps', '--all', '-q', ...services], { capture: true });
  if (listed.exitCode !== 0) return [];
  return String(listed.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

export async function down(
  name: string,
  { volumes = false, onLine }: { volumes?: boolean; onLine?: (line: string) => void } = {},
): Promise<number | null> {
  const args = ['down', '--remove-orphans'];
  if (volumes) args.push('-v');
  const anonymous = await anonymousVolumes(name, []);
  // An image's own VOLUMEs become anonymous volumes, which a container removed without -v
  // leaves behind; the next one gets fresh ones. `rm -v` removes only those, never the
  // named data volume, so a down that keeps the data still leaves nothing else behind.
  if (!volumes) {
    const removed = await mutating(name, ['rm', '-s', '-f', '-v'], onLine);
    if (removed !== 0) return removed;
  }
  const rc = await mutating(name, args, onLine);
  if (rc === 0) await removeAnonymous(anonymous);
  return rc;
}

/** The 64-hex name Docker and Podman give a volume nobody named. */
const ANONYMOUS_VOLUME = /^[0-9a-f]{64}$/u;

/**
 * The anonymous volumes `services`' containers (all of them for none) mount, by name.
 *
 * `-v` is not enough on its own: once compose RECREATES a container (`env --set`, an
 * upgrade, `up --force`), the new one mounts the old one's anonymous volume BY NAME, and
 * Docker's `rm -v` keeps any volume mounted by name. So Rocket.Chat's `/app/uploads` volume
 * outlived `up --force`, a data-keeping `down` and even `down --volumes` -- one more empty
 * volume per recreate-heavy workspace on a shared box.
 */
async function anonymousVolumes(name: string, services: readonly string[]): Promise<string[]> {
  try {
    const ids = await allContainerIds(name, services);
    if (ids.length === 0) return [];
    const mounts = await docker(
      ['inspect', '--format', '{{range .Mounts}}{{.Name}} {{end}}', ...ids],
      { capture: true, timeoutMs: 15_000 },
    );
    if (mounts.exitCode !== 0) return [];
    return [
      ...new Set(
        String(mounts.stdout ?? '')
          .split(/\s+/u)
          .filter((volume) => ANONYMOUS_VOLUME.test(volume)),
      ),
    ];
  } catch (error) {
    if (error instanceof Interrupted) throw error;
    return [];
  }
}

/** Remove them, once nothing mounts them; one still in use is simply left. */
async function removeAnonymous(volumes: readonly string[]): Promise<void> {
  if (volumes.length === 0) return;
  try {
    await docker(['volume', 'rm', ...volumes], { capture: true, timeoutMs: 30_000 });
  } catch (error) {
    if (error instanceof Interrupted) throw error;
  }
}

export async function start(name: string, onLine?: (line: string) => void): Promise<number | null> {
  return await recreatedIfStale(name, await mutating(name, ['start'], onLine));
}

export async function stop(name: string, onLine?: (line: string) => void): Promise<number | null> {
  return await mutating(name, ['stop'], onLine);
}

export async function restart(
  name: string,
  onLine?: (line: string) => void,
): Promise<number | null> {
  return await recreatedIfStale(name, await mutating(name, ['restart'], onLine));
}

export async function logs(
  name: string,
  { follow = false, tail }: { follow?: boolean; tail?: number } = {},
): Promise<number | null> {
  const args = ['logs'];
  if (follow) args.push('-f');
  if (tail !== undefined) args.push('--tail', String(tail));
  return (await compose(name, args)).exitCode;
}

/** Run a command inside a running compose service (`docker compose exec -T`). */
export async function composeExec(
  name: string,
  service: string,
  args: readonly string[],
): Promise<number | null> {
  return (await compose(name, ['exec', '-T', service, ...args])).exitCode;
}

/**
 * Like `composeExec`, but captures stdout.
 *
 * Returns `[1, '']` instead of raising when the exec cannot run or the timeout expires,
 * so best-effort samplers degrade to "no sample" rather than stranding their caller.
 */
export async function composeExecCapture(
  name: string,
  service: string,
  args: readonly string[],
  timeoutMs?: number,
): Promise<[number, string]> {
  try {
    const result = await compose(name, ['exec', '-T', service, ...args], {
      capture: true,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return [result.exitCode ?? 1, String(result.stdout ?? '')];
  } catch (error) {
    if (error instanceof Interrupted) throw error; // Ctrl-C or a stopped job: unwind
    return [1, ''];
  }
}

/** Run a command in a service, writing its RAW stdout to `destination`. */
export async function composeExecToFile(
  name: string,
  service: string,
  args: readonly string[],
  destination: string,
  timeoutMs?: number,
): Promise<[number, string]> {
  try {
    const result = await composeToFile(['exec', '-T', service, ...args], destination, {
      cwd: paths.workspace(name),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return [result.exitCode ?? 1, result.stderr];
  } catch (error) {
    if (error instanceof Interrupted) throw error; // Ctrl-C or a stopped job: unwind
    return [1, String(error)];
  }
}

/** Run a command in a service with `source` piped to its stdin. */
export async function composeExecFromFile(
  name: string,
  service: string,
  args: readonly string[],
  source: string,
  timeoutMs?: number,
): Promise<[number, string]> {
  try {
    const result = await composeFromFile(['exec', '-T', service, ...args], source, {
      cwd: paths.workspace(name),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
    return [result.exitCode ?? 1, result.output];
  } catch (error) {
    if (error instanceof Interrupted) throw error; // Ctrl-C or a stopped job: unwind
    return [1, String(error)];
  }
}

/**
 * Stop specific services, leaving the rest of the project running.
 *
 * `stop` stops everything including Mongo -- useless for a dump, which needs Mongo up
 * and only the writers quiesced.
 */
export async function stopServices(
  name: string,
  services: readonly string[],
): Promise<number | null> {
  return (await compose(name, ['stop', ...services])).exitCode;
}

export async function startServices(
  name: string,
  services: readonly string[],
): Promise<number | null> {
  const rc = (await compose(name, ['start', ...services])).exitCode;
  return await recreatedIfStale(name, rc, services);
}

/** Stop and remove specific services and their anonymous volumes (`rm -s -f -v <services>`). */
export async function rmServices(
  name: string,
  services: readonly string[],
): Promise<number | null> {
  const anonymous = await anonymousVolumes(name, services);
  const rc = (await compose(name, ['rm', '-s', '-f', '-v', ...services])).exitCode;
  if (rc === 0) await removeAnonymous(anonymous);
  return rc;
}

/** Container id(s) of one compose service in this repro (usually a single id). */
export async function serviceContainerIds(name: string, service: string): Promise<string[]> {
  const result = await compose(name, ['ps', '-q', service], { capture: true });
  if (result.exitCode !== 0) return [];
  return String(result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/** Container ids of a repro's running services (`docker compose ps -q`). */
export async function containerIds(name: string): Promise<string[]> {
  const result = await compose(name, ['ps', '-q'], { capture: true });
  return String(result.stdout ?? '')
    .split(/\s+/u)
    .filter(Boolean);
}

/** The host ports a repro's RUNNING containers publish. */
export async function publishedPorts(name: string): Promise<Set<number>> {
  const result = await compose(name, ['ps', '--format', '{{.Ports}}'], { capture: true });
  return hostPortsIn(String(result.stdout ?? ''));
}

/**
 * The host ports in Docker's `Ports` text, a range expanded: one container publishing
 * consecutive ports prints them as one (`127.0.0.1:9000-9001->9000-9001/tcp`, MinIO's pair).
 */
export function hostPortsIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const match of text.matchAll(/:(\d+)(?:-(\d+))?->/gu)) {
    const first = Number(match[1]);
    const last = Math.min(Number(match[2] ?? match[1]), 65535);
    for (let port = first; port <= last; port += 1) out.add(port);
  }
  return out;
}

/** `docker compose ps` for a repro, as service/state/status lines. */
export async function ps(name: string): Promise<string> {
  const result = await compose(name, ['ps', '--format', '{{.Service}}\t{{.State}}\t{{.Status}}'], {
    capture: true,
  });
  return String(result.stdout ?? '');
}

/**
 * Captured (not streamed) combined logs for a repro, for post-mortem diagnosis of a
 * failed `up`. '' on error. `services` narrows them to those services; none is every one.
 */
export async function composeLogsCapture(
  name: string,
  { tail = 200, services = [] as readonly string[] } = {},
): Promise<string> {
  const result = await compose(name, ['logs', '--no-color', '--tail', String(tail), ...services], {
    capture: true,
  });
  return String(result.stdout ?? '') + String(result.stderr ?? '');
}

/**
 * Captured output of `docker compose pull`, used to surface registry errors when a
 * repro never started any container. '' on error.
 */
export async function composePullCapture(name: string): Promise<string> {
  const result = await compose(name, ['pull'], { capture: true });
  return String(result.stdout ?? '') + String(result.stderr ?? '');
}
