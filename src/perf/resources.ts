/**
 * Background resource sampler: poll `docker stats` for a repro's containers, so any
 * operation can be wrapped and its CPU/RAM cost reported.
 *
 * PORTABILITY. `docker stats` works on Docker Desktop and Linux. On Docker Desktop CPU% is
 * relative to the VM's allocated CPUs and memory is the VM's view (consistent with
 * node-exporter). The idle->peak DELTAS are the trustworthy signal; absolute numbers are
 * host-specific.
 *
 * A sampler on a thread would guard its series with a lock, because `stop()` waits with a
 * timeout and `report()`/`memSlopes()` are callable while the sampler runs. Here it is
 * cooperative asynchronous concurrency: one loop, a stop flag, and a `stop()` that awaits
 * the loop for at most `STOP_JOIN_MS`. A reader that runs between awaits sees a consistent
 * array, so the snapshot copy is kept for its other reason -- a caller may hold the result
 * while sampling continues -- rather than for mutual exclusion.
 */
import { containerIds } from '../core/runner/engine';
import { dockerStats } from '../core/runner/queries';
import { Interrupted, interruptRaised } from '../seams/exec';

const MEM_UNITS: Readonly<Record<string, number>> = Object.freeze({
  b: 1,
  kb: 1000,
  mb: 1000 ** 2,
  gb: 1000 ** 3,
  tb: 1000 ** 4,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
});

export function parseCpu(tok: string): number {
  const text = tok.trim().replace(/%+$/u, '');
  const value = Number(text);
  // Anything that is not a number reads as 0.0. `Number('')` is 0, which happens to agree
  // here, but an explicit check says so.
  return text === '' || Number.isNaN(value) ? 0.0 : value;
}

export function toBytes(tok: string): number {
  const m = /^\s*([\d.]+)\s*([A-Za-z]+)/u.exec(tok);
  if (m === null) return 0.0;
  const value = Number(m[1]);
  if (Number.isNaN(value)) return 0.0;
  return value * (MEM_UNITS[(m[2] as string).toLowerCase()] ?? 1);
}

/** `"540MiB / 2GiB"` -> `[used, limit]`. */
export function parseMem(tok: string): [number, number] {
  const parts = tok.split('/');
  const used = parts.length > 0 ? toBytes(parts[0] as string) : 0.0;
  const limit = parts.length > 1 ? toBytes(parts[1] as string) : 0.0;
  return [used, limit];
}

export interface ContainerStats {
  idle_cpu: number;
  peak_cpu: number;
  idle_mem: number;
  peak_mem: number;
  limit_mem: number;
  /** Seconds since monitor start. */
  peak_cpu_t: number;
}

/** One sample: `[t, cpu, memUsed, memLimit]`. */
type Sample = [number, number, number, number];

/** How long `stop()` waits for a sample still in flight: five seconds. */
export const STOP_JOIN_MS = 5000;

/**
 * Usage: `const mon = new ResourceMonitor(name).start(); … ; const rep = await mon.stop();`
 */
export class ResourceMonitor {
  readonly reproName: string;
  readonly interval: number;

  private readonly series = new Map<string, Sample[]>();
  private stopping = false;
  private running: Promise<void> | null = null;
  private t0 = 0;

  constructor(reproName: string, interval = 1.0) {
    this.reproName = reproName;
    this.interval = interval;
  }

  start(): this {
    this.stopping = false;
    this.t0 = now();
    this.running = this.loop();
    return this;
  }

  private async loop(): Promise<void> {
    try {
      await this.sample();
    } catch (error) {
      // As `RCMetricsSampler.run`: a Ctrl-C took the sample in flight, and the run unwinds.
      if (!(error instanceof Interrupted)) throw error;
    }
  }

  private async sample(): Promise<void> {
    // ON A LATER TURN, so the first read runs after `start()` has returned rather than in
    // `start()` itself. Called straight through, the first `docker compose ps -q` was
    // spawned before `start()` returned -- ahead of the k6 run it is there to watch, on
    // every run -- and a k6 that returned at once still left a sample, and a 'Resource cost'
    // table the established report, still waiting for its first answer, never prints. A
    // wrapped create still gets its first sample: the loop re-asks for ids below.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    let ids = await containerIds(this.reproName);
    // Not after a Ctrl-C, as `RCMetricsSampler.sample`.
    while (!this.stopping && !interruptRaised()) {
      // A workspace whose containers were not up yet at the first poll gets another
      // chance, which is what makes wrapping a create work.
      if (ids.length === 0) ids = await containerIds(this.reproName);
      const t = now() - this.t0;
      for (const line of (await dockerStats(ids)).split('\n')) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
          const [used, limit] = parseMem(parts[2] as string);
          const key = parts[0] as string;
          let entry = this.series.get(key);
          if (entry === undefined) {
            entry = [];
            this.series.set(key, entry);
          }
          entry.push([t, parseCpu(parts[1] as string), used, limit]);
        }
      }
      await this.wait(this.interval);
    }
  }

  /** `Event.wait(interval)` -- returns early when `stop()` is called. */
  private wait(seconds: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopping) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        clearInterval(poll);
        resolve();
      }, seconds * 1000);
      const poll = setInterval(() => {
        if (this.stopping) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      }, 25);
    });
  }

  /**
   * Stop sampling and report what was sampled.
   *
   * Waits for the loop at most `STOP_JOIN_MS`, then reports without the sample in flight.
   * This waited for the loop however long `docker stats` took: on a loaded daemon whose
   * first sample needs 7 s, `stats --for 1` printed a resource table the established report
   * never prints, since it is read at 6 s from a series still empty. A sample that lands
   * later is appended to a report already made, as it always has been.
   */
  async stop(): Promise<Record<string, ContainerStats>> {
    this.stopping = true;
    const running = this.running;
    if (running !== null) {
      let timer: NodeJS.Timeout | undefined;
      try {
        const joined = await Promise.race([
          running.then(() => true),
          new Promise<boolean>((resolve) => {
            timer = setTimeout(() => {
              resolve(false);
            }, STOP_JOIN_MS);
          }),
        ]);
        if (joined) this.running = null;
      } finally {
        clearTimeout(timer);
      }
    }
    return this.report();
  }

  /**
   * A shallow copy of the series, so callers can read it while sampling continues.
   */
  private snapshot(): Record<string, Sample[]> {
    const out: Record<string, Sample[]> = {};
    for (const [name, series] of this.series) out[name] = [...series];
    return out;
  }

  /**
   * Per-container RAM growth in bytes/hour over the sampled span (a simple endpoint
   * slope) -- the soak-test leak signal.
   *
   * Empty unless the monitor ran for at least `minSpanS`: short runs say nothing about
   * leaks, and reporting a slope from thirty seconds of samples would be noise dressed as
   * evidence.
   */
  memSlopes(minSpanS = 600.0): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, series] of Object.entries(this.snapshot())) {
      if (series.length < 2) continue;
      const first = series[0] as Sample;
      const last = series[series.length - 1] as Sample;
      const span = last[0] - first[0];
      if (span < minSpanS) continue;
      out[name] = ((last[2] - first[2]) / span) * 3600;
    }
    return out;
  }

  /** Per-container stats, optionally restricted to a `[t0, t1]` window. */
  report(window?: [number, number]): Record<string, ContainerStats> {
    const out: Record<string, ContainerStats> = {};
    for (const [name, series] of Object.entries(this.snapshot())) {
      const sel = series.filter(
        (s) => window === undefined || (window[0] <= s[0] && s[0] <= window[1]),
      );
      if (sel.length === 0) continue;
      // `max(sel, key=...)` keeps the FIRST maximum; `reduce` with a strict `>` does too.
      const peak = sel.reduce((best, s) => (s[1] > best[1] ? s : best), sel[0] as Sample);
      out[name] = {
        idle_cpu: (sel[0] as Sample)[1],
        peak_cpu: peak[1],
        idle_mem: (sel[0] as Sample)[2],
        peak_mem: Math.max(...sel.map((s) => s[2])),
        limit_mem: (sel[sel.length - 1] as Sample)[3],
        peak_cpu_t: peak[0],
      };
    }
    return out;
  }

  /** For a test that needs a series without running docker. */
  seed(name: string, samples: readonly Sample[]): void {
    this.series.set(name, [...samples]);
  }
}

/** `time.monotonic()`, in seconds. */
function now(): number {
  return Number(process.hrtime.bigint()) / 1e9;
}
