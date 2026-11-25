import type * as ModNS from '../../src/perf/rcmetrics';
import type * as ExecNS from '../../src/seams/exec';

import { METRICS, ServiceSeries, parseProm } from '../../src/perf/rcmetrics';

/** Real exposition text, including the shapes that must be skipped. */
const DUMP = [
  '# HELP nodejs_eventloop_lag_seconds Lag of event loop in seconds.',
  '# TYPE nodejs_eventloop_lag_seconds gauge',
  'nodejs_eventloop_lag_seconds 0.012345',
  'nodejs_eventloop_lag_max_seconds 1.5',
  'nodejs_eventloop_lag_p99_seconds 0.9',
  'nodejs_heap_size_used_bytes 1.234e8',
  'rocketchat_ddp_connected_users 42',
  'rocketchat_oplog_queue 0',
  'http_requests_total{method="GET",code="200"} 10',
  'http_requests_total{method="POST",code="200"} 5',
  'not a metric line at all',
  'broken_value abc',
  '',
  '   ',
].join('\n');

describe('parseProm', () => {
  it('reads the unlabeled gauges houston tracks', () => {
    const parsed = parseProm(DUMP);
    expect(parsed.nodejs_eventloop_lag_seconds).toBeCloseTo(0.012345, 10);
    expect(parsed.nodejs_heap_size_used_bytes).toBe(1.234e8);
    expect(parsed.rocketchat_oplog_queue).toBe(0);
  });

  it('SUMS labeled series of the same name', () => {
    expect(parseProm(DUMP).http_requests_total).toBe(15);
  });

  it('skips comments, blanks, and anything that is not a metric line', () => {
    const parsed = parseProm(DUMP);
    expect(parsed).not.toHaveProperty('broken_value');
    expect(Object.keys(parsed)).not.toContain('#');
  });

  it('is empty for empty input rather than throwing', () => {
    expect(parseProm('')).toEqual({});
    expect(parseProm('# only comments\n')).toEqual({});
  });

  it('parses exactly what earlier releases parsed', () => {
    const dumps = [DUMP, '', '# only comments\n', 'a 1\na 2\na 3\n', 'x{y="1"} 1e-3\n'];
    expect(dumps.map(parseProm)).toEqual([
      {
        nodejs_eventloop_lag_seconds: 0.012345,
        nodejs_eventloop_lag_max_seconds: 1.5,
        nodejs_eventloop_lag_p99_seconds: 0.9,
        nodejs_heap_size_used_bytes: 123400000,
        rocketchat_ddp_connected_users: 42,
        rocketchat_oplog_queue: 0,
        http_requests_total: 15,
      },
      {},
      {},
      { a: 6 },
      { x: 0.001 },
    ]);
  });
});

describe('ServiceSeries', () => {
  it('keeps only the tracked metrics, under their short names', () => {
    const series = new ServiceSeries();
    series.add(parseProm(DUMP));
    expect(Object.keys(series.samples).sort()).toEqual(
      [
        'ddp_users',
        'eventloop_lag_max_s',
        'eventloop_lag_p99_s',
        'eventloop_lag_s',
        'heap_used_bytes',
        'oplog_queue',
      ].sort(),
    );
    expect(series.samples).not.toHaveProperty('http_requests_total');
  });

  it('summarises mean, max, last and n across samples', () => {
    const series = new ServiceSeries();
    for (const v of [1, 3, 2]) series.add({ rocketchat_ddp_connected_users: v });
    expect(series.summary().ddp_users).toEqual({ mean: 2, max: 3, last: 2, n: 3 });
  });

  it('reports nothing for a metric that never appeared', () => {
    expect(new ServiceSeries().summary()).toEqual({});
  });

  it('summarises exactly as earlier releases did', () => {
    const rounds = [
      { rocketchat_ddp_connected_users: 1, nodejs_eventloop_lag_seconds: 0.5 },
      { rocketchat_ddp_connected_users: 3 },
      { rocketchat_ddp_connected_users: 2, nodejs_eventloop_lag_seconds: 1.5 },
    ];
    const series = new ServiceSeries();
    for (const r of rounds) series.add(r);
    expect(series.summary()).toEqual({
      eventloop_lag_s: { mean: 1, max: 1.5, last: 1.5, n: 2 },
      ddp_users: { mean: 2, max: 3, last: 2, n: 3 },
    });
  });

  it('tracks the metric names earlier releases tracked', () => {
    expect({
      nodejs_eventloop_lag_seconds: 'eventloop_lag_s',
      nodejs_eventloop_lag_max_seconds: 'eventloop_lag_max_s',
      nodejs_eventloop_lag_p99_seconds: 'eventloop_lag_p99_s',
      nodejs_heap_size_used_bytes: 'heap_used_bytes',
      rocketchat_ddp_connected_users: 'ddp_users',
      rocketchat_oplog_queue: 'oplog_queue',
    }).toEqual({ ...METRICS });
  });
});

describe('the sampler', () => {
  it('polls every service, accumulates, and stops cleanly', async () => {
    jest.resetModules();
    const calls: string[] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExecCapture: (_name: string, service: string) => {
        calls.push(service);
        return Promise.resolve([0, `rocketchat_ddp_connected_users ${calls.length}\n`]);
      },
    }));
    const { RCMetricsSampler } = require('../../src/perf/rcmetrics') as typeof ModNS;

    const sampler = new RCMetricsSampler('ws', ['rocketchat-1', 'rocketchat-2'], 0.01).start();
    // Let a couple of rounds happen, then stop and require the loop to have finished.
    await new Promise((r) => setTimeout(r, 60));
    const report = await sampler.stop();

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(report).sort()).toEqual(['rocketchat-1', 'rocketchat-2']);
    expect(report['rocketchat-1']?.ddp_users?.n).toBeGreaterThanOrEqual(1);
  });

  it('reports nothing when the endpoint never answers', async () => {
    jest.resetModules();
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExecCapture: () => Promise.resolve([1, '']),
    }));
    const { RCMetricsSampler } = require('../../src/perf/rcmetrics') as typeof ModNS;

    const sampler = new RCMetricsSampler('ws', ['rocketchat'], 0.01).start();
    await new Promise((r) => setTimeout(r, 40));
    // Metrics off, or an RC too old to expose them: an empty report, not an error.
    expect(await sampler.stop()).toEqual({});
  });

  it('stops even if it is stopped before the first round finishes', async () => {
    jest.resetModules();
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExecCapture: () => new Promise((r) => setTimeout(() => r([0, 'x 1\n']), 20)),
    }));
    const { RCMetricsSampler } = require('../../src/perf/rcmetrics') as typeof ModNS;

    const sampler = new RCMetricsSampler('ws', ['rocketchat'], 5).start();
    // `stop()` awaits the loop, so this returning at all is the assertion: a sampler that
    // did not observe the flag inside its wait would hang here for five seconds.
    const started = Date.now();
    await sampler.stop();
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('the sampler and a Ctrl-C', () => {
  /**
   * A sample in flight when the Ctrl-C came rejected the loop, so `stop()` in the run's
   * restore threw; and a sample started after it ended the process before the restore ran.
   */
  it('ends its loop when the Ctrl-C takes the sample in flight, and stop() reports what it had', async () => {
    jest.resetModules();
    const exec = require('../../src/seams/exec') as typeof ExecNS;
    let calls = 0;
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExecCapture: async () => {
        calls += 1;
        if (calls > 1) await exec.sleep(60_000);
        return [0, 'rocketchat_ddp_connected_users 7\n'];
      },
    }));
    const { RCMetricsSampler } = require('../../src/perf/rcmetrics') as typeof ModNS;
    let ended = 0;
    try {
      const report = await exec.unwindsOnInterrupt(async () => {
        const sampler = new RCMetricsSampler('ws', ['rocketchat'], 0.01).start();
        await new Promise((r) => setTimeout(r, 50));
        exec.interrupt(() => (ended += 1));
        return await exec.cleanup(async () => await sampler.stop());
      });
      expect(report.rocketchat?.ddp_users?.n).toBe(1);
      expect(calls).toBe(2);
      expect(ended).toBe(0);
    } finally {
      exec.resetInterruptForTest();
    }
  });

  it('starts no sample after a Ctrl-C, which would end the process before the restore', async () => {
    jest.resetModules();
    const exec = require('../../src/seams/exec') as typeof ExecNS;
    let calls = 0;
    jest.doMock('../../src/core/runner/engine', () => ({
      composeExecCapture: async () => {
        await exec.interruptPoint();
        calls += 1;
        return [0, 'rocketchat_ddp_connected_users 7\n'];
      },
    }));
    const { RCMetricsSampler } = require('../../src/perf/rcmetrics') as typeof ModNS;
    let ended = 0;
    try {
      const outcome = await exec.unwindsOnInterrupt(async () => {
        const sampler = new RCMetricsSampler('ws', ['rocketchat'], 0.05).start();
        // The run's own wait, which the Ctrl-C is raised in.
        const k6 = exec.sleep(60_000);
        await new Promise((r) => setTimeout(r, 10));
        exec.interrupt(() => (ended += 1));
        await k6.catch(() => undefined);
        // Past the sampler's next round.
        await new Promise((r) => setTimeout(r, 120));
        if (ended > 0) return 'ended';
        return await exec.cleanup(async () => await sampler.stop());
      });
      expect(outcome).toEqual({ rocketchat: expect.anything() });
      expect(calls).toBe(1);
    } finally {
      exec.resetInterruptForTest();
    }
  });
});
