/**
 * Sample Rocket.Chat's own Prometheus metrics during a load test.
 *
 * RC (a Node app) exposes prom-client metrics on :9458 inside the container when
 * `Prometheus_Enabled` is on -- including EVENT-LOOP LAG, the saturation signal for a Node
 * process: once the event loop lags, every request queues behind it. The port is not
 * published to the host, so each sample runs `node -e` inside the RC container (Node ships
 * with RC by definition) -- no extra images, no Grafana.
 */
import { composeExecCapture } from '../core/runner/engine';
import { Interrupted, interruptRaised } from '../seams/exec';

/**
 * Unlabeled gauges worth tracking, verified against a live RC `/metrics` dump and the
 * official dashboard.
 *
 * The lag HISTOGRAM gauges (`_max`/`_p99`, reset per scrape) matter more than the
 * instantaneous `nodejs_eventloop_lag_seconds`, which samples BETWEEN stalls and reads
 * near-zero even while requests queue for seconds.
 */
export const METRICS: Readonly<Record<string, string>> = Object.freeze({
  nodejs_eventloop_lag_seconds: 'eventloop_lag_s',
  nodejs_eventloop_lag_max_seconds: 'eventloop_lag_max_s',
  nodejs_eventloop_lag_p99_seconds: 'eventloop_lag_p99_s',
  nodejs_heap_size_used_bytes: 'heap_used_bytes',
  rocketchat_ddp_connected_users: 'ddp_users',
  rocketchat_oplog_queue: 'oplog_queue',
});

const LINE_RE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([0-9.eE+-]+)\s*$/u;

/**
 * `require('http')` instead of `fetch()`: works on every Node version RC ever shipped.
 *
 * `setTimeout` bounds the request, because a saturated event loop -- exactly what this
 * sampler exists to detect -- can accept the connection and then never finish the
 * response, which would hang `node` and the exec around it indefinitely.
 */
export const FETCH_JS =
  "var q=require('http').get('http://localhost:9458/metrics',function(r){" +
  "var d='';r.on('data',function(c){d+=c});r.on('end',function(){console.log(d)})" +
  "}).on('error',function(){process.exit(1)});" +
  'q.setTimeout(5000,function(){q.destroy();process.exit(1)})';

/** Belt to the JS timeout's braces: bound the exec itself too. */
const SAMPLE_TIMEOUT_S = 15.0;

/**
 * Prometheus exposition text -> {metric name: value}.
 *
 * Labeled series of the same name are SUMMED; the tracked metrics are unlabeled gauges
 * anyway, so this only matters for anything else a future RC exposes.
 */
export function parseProm(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const raw of text.split('\n')) {
    if (!raw || raw.startsWith('#')) continue;
    const m = LINE_RE.exec(raw.trim());
    if (m === null) continue;
    const value = Number(m[3]);
    // A malformed number skips the line; `Number` answers NaN, so the check is explicit.
    if (Number.isNaN(value)) continue;
    const name = m[1] as string;
    out[name] = (out[name] ?? 0.0) + value;
  }
  return out;
}

export interface SeriesSummary {
  mean: number;
  max: number;
  last: number;
  n: number;
}

/** One service's samples, keyed by the short name `METRICS` maps to. */
export class ServiceSeries {
  readonly samples: Record<string, number[]> = {};

  add(parsed: Record<string, number>): void {
    for (const [promName, key] of Object.entries(METRICS)) {
      if (promName in parsed) {
        (this.samples[key] ??= []).push(parsed[promName] as number);
      }
    }
  }

  summary(): Record<string, SeriesSummary> {
    const out: Record<string, SeriesSummary> = {};
    for (const [key, vals] of Object.entries(this.samples)) {
      if (vals.length > 0) {
        out[key] = {
          mean: vals.reduce((a, b) => a + b, 0) / vals.length,
          max: Math.max(...vals),
          last: vals[vals.length - 1] as number,
          n: vals.length,
        };
      }
    }
    return out;
  }
}

/**
 * Polls every RC instance's `/metrics` while a test runs.
 *
 * Mirrors the resource monitor's lifecycle: `start()` -> workload -> `stop()` -> report.
 *
 * A sampler on a THREAD would guard its series with a lock, because a wait with a timeout
 * can leave the worker live when `stop` reads. Here it is cooperative asynchronous
 * concurrency instead: there is one loop, it observes a stop flag, and `stop()` AWAITS it
 * -- so there is no concurrent reader to guard against and no change during iteration to
 * prevent.
 */
export class RCMetricsSampler {
  readonly name: string;
  readonly services: readonly string[];
  readonly interval: number;

  private readonly series = new Map<string, ServiceSeries>();
  private stopping = false;
  private running: Promise<void> | null = null;

  constructor(name: string, services: readonly string[], interval = 2.0) {
    this.name = name;
    this.services = services;
    this.interval = interval;
  }

  start(): this {
    this.stopping = false;
    this.running = this.run();
    return this;
  }

  private async run(): Promise<void> {
    try {
      await this.sample();
    } catch (error) {
      // A Ctrl-C took the sample in flight: the run is unwinding, and `stop()` reports what
      // was sampled before it.
      if (!(error instanceof Interrupted)) throw error;
    }
  }

  private async sample(): Promise<void> {
    // Not after a Ctrl-C: a sample started then ends the process before the run's restore.
    while (!this.stopping && !interruptRaised()) {
      for (const svc of this.services) {
        // The seam takes MILLISECONDS; `SAMPLE_TIMEOUT_S` is seconds.
        const [rc, text] = await composeExecCapture(
          this.name,
          svc,
          ['node', '-e', FETCH_JS],
          SAMPLE_TIMEOUT_S * 1000,
        );
        if (rc === 0 && text) {
          let entry = this.series.get(svc);
          if (entry === undefined) {
            entry = new ServiceSeries();
            this.series.set(svc, entry);
          }
          entry.add(parseProm(text));
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
   * `{service: {eventloop_lag_s: {mean,max,last,n}, …}}` -- empty if the endpoint never
   * answered (metrics off, or an RC too old to expose them).
   */
  async stop(): Promise<Record<string, Record<string, SeriesSummary>>> {
    this.stopping = true;
    if (this.running !== null) {
      await this.running;
      this.running = null;
    }
    const out: Record<string, Record<string, SeriesSummary>> = {};
    for (const [svc, s] of this.series) {
      const summary = s.summary();
      if (Object.keys(summary).length > 0) out[svc] = summary;
    }
    return out;
  }
}
