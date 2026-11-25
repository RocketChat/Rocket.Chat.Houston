import type * as ModNS from '../../src/perf/resources';
import type * as ExecNS from '../../src/seams/exec';

import { ResourceMonitor, parseCpu, parseMem, toBytes } from '../../src/perf/resources';

const CPU_TOKENS = ['12.34%', ' 0.00% ', '100%', '', 'n/a', '--', '1e2%'];
const MEM_TOKENS = [
  '540MiB / 2GiB',
  '1.5GiB / 4GiB',
  '512MB / 1GB',
  '0B / 0B',
  '540MiB',
  '',
  'garbage',
  '12 KiB / 1 MiB',
];

describe('parsing docker stats', () => {
  it('reads a CPU percentage, and anything unreadable as zero', () => {
    expect(parseCpu('12.34%')).toBe(12.34);
    expect(parseCpu(' 0.00% ')).toBe(0);
    expect(parseCpu('n/a')).toBe(0);
  });

  it('knows both the decimal and the binary unit families', () => {
    // docker prints MiB; a limit can come back as MB. Treating them as equal would
    // misreport a memory ceiling by 5%.
    expect(toBytes('1MiB')).toBe(1024 * 1024);
    expect(toBytes('1MB')).toBe(1000 * 1000);
    expect(toBytes('1.5GiB')).toBe(1.5 * 1024 ** 3);
    expect(toBytes('garbage')).toBe(0);
  });

  it('splits used from limit, and tolerates a token with neither', () => {
    expect(parseMem('540MiB / 2GiB')).toEqual([540 * 1024 ** 2, 2 * 1024 ** 3]);
    expect(parseMem('540MiB')).toEqual([540 * 1024 ** 2, 0]);
    expect(parseMem('')).toEqual([0, 0]);
  });

  it('parses exactly as earlier releases did, for every token', () => {
    const recorded: { cpu: number[]; mem: [number, number][] } = {
      cpu: [12.34, 0, 100, 0, 0, 0, 100],
      mem: [
        [566231040, 2147483648],
        [1610612736, 4294967296],
        [512000000, 1000000000],
        [0, 0],
        [566231040, 0],
        [0, 0],
        [0, 0],
        [12288, 1048576],
      ],
    };
    expect(CPU_TOKENS.map(parseCpu)).toEqual(recorded.cpu);
    expect(MEM_TOKENS.map((t) => parseMem(t))).toEqual(recorded.mem);
  });
});

describe('report', () => {
  /** `[t, cpu, memUsed, memLimit]` */
  const SERIES: [number, number, number, number][] = [
    [0, 5, 100e6, 2e9],
    [1, 80, 150e6, 2e9],
    [2, 40, 900e6, 2e9],
    [3, 80, 300e6, 2e9],
  ];

  it('reports idle from the first sample and peak from the whole window', () => {
    const mon = new ResourceMonitor('ws');
    mon.seed('rocketchat', SERIES);
    const stats = mon.report().rocketchat;
    expect(stats?.idle_cpu).toBe(5);
    expect(stats?.peak_cpu).toBe(80);
    expect(stats?.idle_mem).toBe(100e6);
    expect(stats?.peak_mem).toBe(900e6);
    expect(stats?.limit_mem).toBe(2e9);
  });

  it('keeps the FIRST peak when two samples tie, as earlier releases did', () => {
    // t=1 and t=3 both read 80%. Reporting the later one would move `peak_cpu_t` and
    // mislead anybody correlating it with the timeline.
    const mon = new ResourceMonitor('ws');
    mon.seed('rocketchat', SERIES);
    expect(mon.report().rocketchat?.peak_cpu_t).toBe(1);
  });

  it('restricts to a window when given one, and skips a container with nothing in it', () => {
    const mon = new ResourceMonitor('ws');
    mon.seed('rocketchat', SERIES);
    expect(mon.report([2, 3]).rocketchat?.idle_cpu).toBe(40);
    expect(mon.report([90, 99])).toEqual({});
  });

  it('reports the stats earlier releases reported', () => {
    const mon = new ResourceMonitor('ws');
    mon.seed('rocketchat', SERIES);
    expect([mon.report(), mon.report([2, 3]), mon.report([90, 99])]).toEqual([
      {
        rocketchat: {
          idle_cpu: 5,
          peak_cpu: 80,
          idle_mem: 100000000,
          peak_mem: 900000000,
          limit_mem: 2000000000,
          peak_cpu_t: 1,
        },
      },
      {
        rocketchat: {
          idle_cpu: 40,
          peak_cpu: 80,
          idle_mem: 900000000,
          peak_mem: 900000000,
          limit_mem: 2000000000,
          peak_cpu_t: 3,
        },
      },
      {},
    ]);
  });
});

describe('memSlopes', () => {
  it('says nothing about a run too short to say anything about leaks', () => {
    const mon = new ResourceMonitor('ws');
    mon.seed('mongodb', [
      [0, 1, 100e6, 0],
      [60, 1, 200e6, 0],
    ]);
    expect(mon.memSlopes()).toEqual({});
  });

  it('reports bytes per hour once the span is long enough', () => {
    const mon = new ResourceMonitor('ws');
    mon.seed('mongodb', [
      [0, 1, 100e6, 0],
      [3600, 1, 200e6, 0],
    ]);
    expect(mon.memSlopes().mongodb).toBeCloseTo(100e6, 3);
  });

  it('computes the slopes earlier releases computed', () => {
    const series: [number, number, number, number][] = [
      [0, 1, 100e6, 0],
      [1800, 1, 150e6, 0],
      [3600, 1, 220e6, 0],
    ];
    const mon = new ResourceMonitor('ws');
    mon.seed('mongodb', series);
    // The float tail is the rounding of `(last - first) / span * 3600`, and part of the answer.
    expect([mon.memSlopes(), mon.memSlopes(99999)]).toEqual([{ mongodb: 120000000.00000001 }, {}]);
  });
});

describe('the sampler lifecycle', () => {
  it('polls, accumulates and stops without leaving the loop running', async () => {
    jest.resetModules();
    let polls = 0;
    jest.doMock('../../src/core/runner/engine', () => ({
      containerIds: () => Promise.resolve(['abc123']),
    }));
    jest.doMock('../../src/core/runner/queries', () => ({
      dockerStats: () => {
        polls += 1;
        return Promise.resolve(`rocketchat\t${String(polls * 10)}%\t100MiB / 2GiB`);
      },
    }));
    const { ResourceMonitor: Monitor } = require('../../src/perf/resources') as typeof ModNS;

    const mon = new Monitor('ws', 0.01).start();
    await new Promise((r) => setTimeout(r, 60));
    const report = await mon.stop();
    expect(polls).toBeGreaterThanOrEqual(2);
    expect(report.rocketchat?.idle_cpu).toBe(10);
    expect(report.rocketchat?.peak_mem).toBe(100 * 1024 ** 2);

    // The loop is finished, so nothing polls after `stop()` resolved.
    const after = polls;
    await new Promise((r) => setTimeout(r, 40));
    expect(polls).toBe(after);
  });

  it('asks for nothing before start() returns, and a stop at once takes no sample', async () => {
    // Earlier releases ask for the container ids on the sampler's own thread, so the k6 run
    // that `start()` precedes is launched first; a k6 that returns at once leaves an empty
    // series and no resource table.
    jest.resetModules();
    const asked: string[] = [];
    jest.doMock('../../src/core/runner/engine', () => ({
      containerIds: () => {
        asked.push('ids');
        return Promise.resolve(['abc123']);
      },
    }));
    jest.doMock('../../src/core/runner/queries', () => ({
      dockerStats: () => {
        asked.push('stats');
        return Promise.resolve('rocketchat\t5%\t100MiB / 2GiB');
      },
    }));
    const { ResourceMonitor: Monitor } = require('../../src/perf/resources') as typeof ModNS;

    const mon = new Monitor('ws', 0.01).start();
    const beforeStartReturned = [...asked];
    // Stopped before anything is asserted, so a failure cannot leave the loop running.
    const report = await mon.stop();
    expect(beforeStartReturned).toEqual([]);
    expect(report).toEqual({});
    expect(asked).not.toContain('stats');
  });

  it('re-asks for container ids while none have appeared', async () => {
    jest.resetModules();
    let asks = 0;
    jest.doMock('../../src/core/runner/engine', () => ({
      containerIds: () => {
        asks += 1;
        return Promise.resolve([]);
      },
    }));
    jest.doMock('../../src/core/runner/queries', () => ({
      dockerStats: () => Promise.resolve(''),
    }));
    const { ResourceMonitor: Monitor } = require('../../src/perf/resources') as typeof ModNS;

    // Wrapping a CREATE is the case: the containers do not exist at the first poll.
    const mon = new Monitor('ws', 0.01).start();
    await new Promise((r) => setTimeout(r, 60));
    await mon.stop();
    expect(asks).toBeGreaterThan(1);
  });

  it('gives up on a sample still in flight after five seconds, as earlier releases did', async () => {
    // A loaded daemon: the first `docker stats` answers after seven seconds, and
    // `stats --for 1` stops the monitor at one. Earlier releases report at six from an empty
    // series and print no table; this waited for the sample and printed one.
    jest.resetModules();
    jest.useFakeTimers();
    try {
      jest.doMock('../../src/core/runner/engine', () => ({
        containerIds: () => Promise.resolve(['abc123']),
      }));
      jest.doMock('../../src/core/runner/queries', () => ({
        dockerStats: () =>
          new Promise((resolve) => {
            setTimeout(() => {
              resolve('rocketchat\t1%\t100MiB / 2GiB');
            }, 7000);
          }),
      }));
      const { ResourceMonitor: Monitor, STOP_JOIN_MS } =
        require('../../src/perf/resources') as typeof ModNS;
      expect(STOP_JOIN_MS).toBe(5000);

      const mon = new Monitor('ws').start();
      await jest.advanceTimersByTimeAsync(1000);
      let report: unknown = 'still waiting';
      const stopped = mon.stop().then((value) => {
        report = value;
      });
      await jest.advanceTimersByTimeAsync(STOP_JOIN_MS - 1);
      expect(report).toBe('still waiting');
      await jest.advanceTimersByTimeAsync(1);
      expect(report).toEqual({});

      // The late sample still lands, in a series the report no longer reads, and the loop
      // then ends on the stop flag rather than polling again.
      await jest.advanceTimersByTimeAsync(2000);
      await stopped;
      expect(Object.keys(mon.report())).toEqual(['rocketchat']);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('the sampler and a Ctrl-C', () => {
  /** As the RC metrics sampler: see test/perf/rcmetrics.test.ts. */
  it('ends its loop when the Ctrl-C takes the sample in flight, and stop() reports what it had', async () => {
    jest.resetModules();
    const exec = require('../../src/seams/exec') as typeof ExecNS;
    let polls = 0;
    jest.doMock('../../src/core/runner/engine', () => ({
      containerIds: () => Promise.resolve(['abc123']),
    }));
    jest.doMock('../../src/core/runner/queries', () => ({
      dockerStats: async () => {
        polls += 1;
        if (polls > 1) await exec.sleep(60_000);
        return 'rocketchat\t10%\t100MiB / 2GiB';
      },
    }));
    const { ResourceMonitor: Monitor } = require('../../src/perf/resources') as typeof ModNS;
    let ended = 0;
    try {
      const report = await exec.unwindsOnInterrupt(async () => {
        const mon = new Monitor('ws', 0.01).start();
        await new Promise((r) => setTimeout(r, 50));
        exec.interrupt(() => (ended += 1));
        return await exec.cleanup(async () => await mon.stop());
      });
      expect(report.rocketchat?.peak_mem).toBe(100 * 1024 ** 2);
      expect(polls).toBe(2);
      expect(ended).toBe(0);
    } finally {
      exec.resetInterruptForTest();
    }
  });

  it('starts no sample after a Ctrl-C, which would end the process before the restore', async () => {
    jest.resetModules();
    const exec = require('../../src/seams/exec') as typeof ExecNS;
    let polls = 0;
    jest.doMock('../../src/core/runner/engine', () => ({
      containerIds: () => Promise.resolve(['abc123']),
    }));
    jest.doMock('../../src/core/runner/queries', () => ({
      dockerStats: async () => {
        await exec.interruptPoint();
        polls += 1;
        return 'rocketchat\t10%\t100MiB / 2GiB';
      },
    }));
    const { ResourceMonitor: Monitor } = require('../../src/perf/resources') as typeof ModNS;
    let ended = 0;
    try {
      const outcome = await exec.unwindsOnInterrupt(async () => {
        const mon = new Monitor('ws', 0.05).start();
        const k6 = exec.sleep(60_000);
        await new Promise((r) => setTimeout(r, 10));
        exec.interrupt(() => (ended += 1));
        await k6.catch(() => undefined);
        await new Promise((r) => setTimeout(r, 120));
        if (ended > 0) return 'ended';
        return await exec.cleanup(async () => await mon.stop());
      });
      expect(outcome).toEqual({ rocketchat: expect.anything() });
      expect(polls).toBe(1);
    } finally {
      exec.resetInterruptForTest();
    }
  });
});
