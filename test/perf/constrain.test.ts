import type * as ModNS from '../../src/perf/constrain';
import type * as ExecNS from '../../src/seams/exec';

import { human, parse, resolveServices, restoreSwap, type Applied } from '../../src/perf/constrain';

const SPECS = [
  'rc=2cpu/2g',
  'rc=2cpu',
  'rc=2g',
  'mongo=1cpu/1g,rc=0.5cpu',
  'rc=512m',
  'rc=2GB/4CPU',
  '  ',
  'rc=2cpu,,mongo=1g',
  // Each of these must raise.
  'rc',
  'rc=',
  'rc=0cpu',
  'rc=-1cpu',
  'rc=abccpu',
  'rc=2x',
  'rc=2cpu/nonsense',
  'rc=2cpu/',
];

describe('parse', () => {
  it('reads a CPU cap, a memory cap, or both', () => {
    expect(parse('rc=2cpu/2g')).toEqual({ rc: { cpus: 2, mem: '2g' } });
    expect(parse('rc=2cpu')).toEqual({ rc: { cpus: 2, mem: null } });
    expect(parse('rc=2g')).toEqual({ rc: { cpus: null, mem: '2g' } });
  });

  it('strips the trailing b docker does not want', () => {
    expect(parse('rc=2gb')).toEqual({ rc: { cpus: null, mem: '2g' } });
    expect(parse('rc=512mb')).toEqual({ rc: { cpus: null, mem: '512m' } });
  });

  it('refuses a CPU count of zero or below', () => {
    // A cap of zero would be silently ignored by the engine, so the run would report a
    // constrained result for an unconstrained workspace.
    expect(() => parse('rc=0cpu')).toThrow(/CPU count must be > 0/u);
    expect(() => parse('rc=-1cpu')).toThrow(/CPU count must be > 0/u);
  });

  it('reports an EMPTY value as a bad part, not as "sets neither"', () => {
    // `rc=` splits to one empty part, so the part check fires first and the
    // "sets neither CPU nor memory" branch is unreachable from a bare `svc=`.
    // Measured against earlier releases rather than assumed -- the intuitive expectation
    // is the other message.
    expect(() => parse('rc=')).toThrow(/bad constraint part '' in 'rc='/u);
    expect(() => parse('rc=2cpu/')).toThrow(/bad constraint part '' in 'rc=2cpu\/'/u);
  });

  it('refuses a rule with no value and a part it cannot read', () => {
    expect(() => parse('rc')).toThrow(/bad constraint 'rc' \(want e\.g\. rc=2cpu\/2g\)/u);
    expect(() => parse('rc=2x')).toThrow(/bad constraint part '2x'/u);
    expect(() => parse('rc=abccpu')).toThrow(/bad CPU count/u);
  });

  it('parses exactly as earlier releases did, including which specs raise', () => {
    // What earlier releases answered for each of SPECS, in order.
    const recorded = [
      { rc: { cpus: 2, mem: '2g' } },
      { rc: { cpus: 2, mem: null } },
      { rc: { cpus: null, mem: '2g' } },
      { mongo: { cpus: 1, mem: '1g' }, rc: { cpus: 0.5, mem: null } },
      { rc: { cpus: null, mem: '512m' } },
      { rc: { cpus: 4, mem: '2g' } },
      {},
      { rc: { cpus: 2, mem: null }, mongo: { cpus: null, mem: '1g' } },
      { RAISES: "bad constraint 'rc' (want e.g. rc=2cpu/2g)" },
      { RAISES: "bad constraint part '' in 'rc=' (want e.g. 2cpu, 2g, 512m)" },
      { RAISES: "CPU count must be > 0 in 'rc=0cpu'" },
      { RAISES: "CPU count must be > 0 in 'rc=-1cpu'" },
      { RAISES: "bad CPU count in 'rc=abccpu' (want e.g. 2cpu, 0.5cpu)" },
      { RAISES: "bad constraint part '2x' in 'rc=2x' (want e.g. 2cpu, 2g, 512m)" },
      {
        RAISES: "bad constraint part 'nonsense' in 'rc=2cpu/nonsense' (want e.g. 2cpu, 2g, 512m)",
      },
      { RAISES: "bad constraint part '' in 'rc=2cpu/' (want e.g. 2cpu, 2g, 512m)" },
    ];
    const mine = SPECS.map((spec) => {
      try {
        return parse(spec);
      } catch (error) {
        return { RAISES: error instanceof Error ? error.message : String(error) };
      }
    });
    expect(mine).toEqual(recorded);
  });
});

describe('resolveServices', () => {
  const services = ['rocketchat-1', 'rocketchat-2', 'mongodb', 'ldap'];

  it('expands rc across every instance of a multi-instance repro', () => {
    expect(Object.keys(resolveServices({ rc: { cpus: 2, mem: null } }, services))).toEqual([
      'rocketchat-1',
      'rocketchat-2',
    ]);
  });

  it('expands rc to the single service of a monolith', () => {
    expect(
      Object.keys(resolveServices({ rc: { cpus: 2, mem: null } }, ['rocketchat', 'mongodb'])),
    ).toEqual(['rocketchat']);
  });

  it('takes an exact service name for anything else', () => {
    expect(Object.keys(resolveServices({ ldap: { cpus: 1, mem: null } }, services))).toEqual([
      'ldap',
    ]);
  });

  it('refuses an unknown service and names the ones that exist', () => {
    // A typo that silently capped nothing would report a constrained result for an
    // unconstrained workspace.
    expect(() => resolveServices({ redis: { cpus: 1, mem: null } }, services)).toThrow(
      /no service 'redis' in this workspace \(services: ldap, mongodb, rocketchat-1, rocketchat-2\)/u,
    );
  });

  it('resolves exactly as earlier releases did', () => {
    const cases: [Record<string, { cpus: number | null; mem: string | null }>, string[]][] = [
      [{ rc: { cpus: 2, mem: '2g' } }, services],
      [{ rc: { cpus: 2, mem: null } }, ['rocketchat', 'mongodb']],
      [{ mongo: { cpus: 1, mem: null } }, services],
      [{ ldap: { cpus: 1, mem: null } }, services],
      [{ redis: { cpus: 1, mem: null } }, services],
    ];
    const recorded = [
      { 'rocketchat-1': { cpus: 2, mem: '2g' }, 'rocketchat-2': { cpus: 2, mem: '2g' } },
      { rocketchat: { cpus: 2, mem: null } },
      { mongodb: { cpus: 1, mem: null } },
      { ldap: { cpus: 1, mem: null } },
      {
        RAISES:
          "no service 'redis' in this workspace (services: ldap, mongodb, rocketchat-1, rocketchat-2)",
      },
    ];
    const mine = cases.map(([c, s]) => {
      try {
        return resolveServices(c, s);
      } catch (error) {
        return { RAISES: error instanceof Error ? error.message : String(error) };
      }
    });
    expect(mine).toEqual(recorded);
  });
});

describe('human', () => {
  it('renders a whole CPU count without a decimal tail', () => {
    // `%g`, not `toPrecision` -- `2.00000cpu` in a report banner is noise, and the same
    // formatting reaches `docker update --cpus`.
    expect(human({ rc: { cpus: 2, mem: '2g' } })).toBe('rc=2cpu/2g');
    expect(human({ rc: { cpus: 0.5, mem: null } })).toBe('rc=0.5cpu');
    expect(human({ rc: { cpus: null, mem: '512m' } })).toBe('rc=512m');
  });

  it('renders exactly what earlier releases rendered', () => {
    const cases = [
      { rc: { cpus: 2, mem: '2g' } },
      { rc: { cpus: 0.5, mem: null } },
      { rc: { cpus: null, mem: '512m' } },
      { rc: { cpus: 2.5, mem: '2g' }, mongo: { cpus: 1, mem: null } },
      {},
    ];
    expect(cases.map(human)).toEqual([
      'rc=2cpu/2g',
      'rc=0.5cpu',
      'rc=512m',
      'rc=2.5cpu/2g, mongo=1cpu',
      '',
    ]);
  });
});

describe('restoreSwap', () => {
  function applied(prior_mem: number, prior_swap: number): Applied {
    return {
      container: 'c',
      service: 's',
      prior_nano: 0,
      prior_mem,
      prior_swap,
      set_cpus: false,
      set_mem: true,
    };
  }

  it("reproduces docker's implicit 2x default rather than disabling swap", () => {
    // MemorySwap 0 means "unset", which the runtime reads as TWICE the memory limit.
    // Folding it into "swap == memory" restores a STRICTER container than the one that
    // started.
    expect(restoreSwap(applied(1000, 0), 1000)).toBe(2000);
  });

  it('keeps an explicit prior limit, and unlimited', () => {
    expect(restoreSwap(applied(1000, 4000), 1000)).toBe(4000);
    expect(restoreSwap(applied(1000, -1), 1000)).toBe(-1);
  });

  it("matches apply()'s no-extra-swap for a previously unlimited container", () => {
    expect(restoreSwap(applied(0, 0), 2048)).toBe(2048);
  });

  it('decides exactly as earlier releases did', () => {
    const cases: [number, number, number][] = [
      [1000, 0, 1000],
      [1000, 4000, 1000],
      [1000, -1, 1000],
      [0, 0, 2048],
      [0, 500, 2048],
    ];
    expect(cases.map(([pm, ps, mem]) => restoreSwap(applied(pm, ps), mem))).toEqual([
      2000, 4000, -1, 2048, 2048,
    ]);
  });
});

describe('apply and restore against a stubbed docker', () => {
  function mockDocker(inspect: string, updateFails = false, stats = '') {
    jest.resetModules();
    const seen: string[][] = [];
    jest.doMock('../../src/seams/docker-cli', () => ({
      docker: (argv: string[]) => {
        seen.push(argv);
        if (argv[0] === 'inspect') {
          return Promise.resolve({ exitCode: 0, stdout: inspect, stderr: '' });
        }
        if (argv[0] === 'stats') {
          return Promise.resolve({ exitCode: 0, stdout: stats, stderr: '' });
        }
        return Promise.resolve(
          updateFails
            ? { exitCode: 1, stdout: '', stderr: 'no such container' }
            : { exitCode: 0, stdout: '', stderr: '' },
        );
      },
    }));
    jest.doMock('../../src/core/runner/engine', () => ({
      serviceContainerIds: (_n: string, svc: string) =>
        Promise.resolve(svc === 'missing' ? [] : [`cid-${svc}`]),
    }));
    jest.doMock('../../src/core/runner/host', () => ({
      dockerCapacity: () => Promise.resolve([8.0, 16e9]),
    }));
    return seen;
  }

  it('records the prior limits and caps only what was asked for', async () => {
    const seen = mockDocker('1000000000 2000000000 4000000000');
    const mod = require('../../src/perf/constrain') as typeof ModNS;
    const applied = await mod.apply('ws', { rocketchat: { cpus: 2, mem: null } });
    expect(applied).toEqual([
      {
        container: 'cid-rocketchat',
        service: 'rocketchat',
        prior_nano: 1000000000,
        prior_mem: 2000000000,
        prior_swap: 4000000000,
        set_cpus: true,
        set_mem: false,
      },
    ]);
    expect(seen.find((c) => c[0] === 'update')).toEqual([
      'update',
      '--cpus',
      '2',
      'cid-rocketchat',
    ]);
  });

  it('refuses a memory cap below what the container already uses, before capping it', async () => {
    // Applied at once, the kernel killed Rocket.Chat as the test began: `rc=1cpu/1g` on one
    // using 1.4 GiB reported 100% errors as a load result, exit 0, with nothing said.
    const seen = mockDocker('0 0 0', false, '1.417GiB / 9.79GiB');
    const mod = require('../../src/perf/constrain') as typeof ModNS;
    await expect(mod.apply('ws', { rocketchat: { cpus: 1, mem: '1g' } })).rejects.toThrow(
      /rocketchat=1g is below the 1\.42 GiB it uses now/u,
    );
    expect(seen.filter((c) => c[0] === 'update')).toEqual([]);
    // A cap it fits under is applied.
    await expect(mod.apply('ws', { rocketchat: { cpus: 1, mem: '2g' } })).resolves.toHaveLength(1);
  });

  it('ROLLS BACK what it already applied when a later service fails', async () => {
    const seen = mockDocker('1000000000 2000000000 4000000000');
    const mod = require('../../src/perf/constrain') as typeof ModNS;
    await expect(
      mod.apply('ws', { rocketchat: { cpus: 2, mem: null }, missing: { cpus: 1, mem: null } }),
    ).rejects.toThrow(/no running container for service 'missing'/u);
    // The caller never has to clean up a partial apply: the first cap was put back.
    const updates = seen.filter((c) => c[0] === 'update');
    expect(updates).toHaveLength(2);
    expect(updates[1]?.slice(0, 3)).toEqual(['update', '--cpus', '1']);
  });

  it('rolls back a cap it already set when a Ctrl-C lands part way through', async () => {
    // The rollback was not cleanup, so its first docker call ended the process: the
    // first service stayed capped, and no note said so, because none is written until the
    // apply returns.
    jest.resetModules();
    const exec = require('../../src/seams/exec') as typeof ExecNS;
    const seen: string[][] = [];
    jest.doMock('../../src/seams/docker-cli', () => ({
      docker: async (argv: string[]) => {
        // A docker call is a wait a Ctrl-C reaches, as the real one is.
        await exec.interruptPoint();
        seen.push(argv);
        if (argv[0] === 'inspect' && argv.includes('cid-mongodb')) await exec.sleep(60_000);
        if (argv[0] === 'inspect') {
          return { exitCode: 0, stdout: '1000000000 2000000000 4000000000', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }));
    jest.doMock('../../src/core/runner/engine', () => ({
      serviceContainerIds: (_n: string, svc: string) => Promise.resolve([`cid-${svc}`]),
    }));
    jest.doMock('../../src/core/runner/host', () => ({
      dockerCapacity: () => Promise.resolve([8.0, 16e9]),
    }));
    const mod = require('../../src/perf/constrain') as typeof ModNS;
    let ended = (): void => undefined;
    const end = new Promise<string>((resolve) => {
      ended = () => resolve('ended');
    });
    try {
      const applying = exec.unwindsOnInterrupt(
        async () =>
          await mod.apply('ws', {
            rocketchat: { cpus: 2, mem: null },
            mongodb: { cpus: 1, mem: null },
          }),
      );
      await new Promise((r) => setTimeout(r, 20));
      exec.interrupt(ended);
      const outcome = await Promise.race([
        applying.then(
          () => 'applied',
          (error: unknown) => error,
        ),
        end,
      ]);
      expect(outcome).toBeInstanceOf(exec.Interrupted);
      expect(seen.filter((c) => c[0] === 'update')).toEqual([
        ['update', '--cpus', '2', 'cid-rocketchat'],
        ['update', '--cpus', '1', 'cid-rocketchat'],
      ]);
    } finally {
      exec.resetInterruptForTest();
    }
  });

  it('restores ONLY the dimension it capped', async () => {
    const seen = mockDocker('1000000000 2000000000 4000000000');
    const mod = require('../../src/perf/constrain') as typeof ModNS;
    const applied = await mod.apply('ws', { rocketchat: { cpus: 2, mem: null } });
    seen.length = 0;
    expect(await mod.restore(applied)).toEqual([]);
    // No --memory anywhere: imposing one on a CPU-only cap is a change nobody asked for.
    expect(seen[0]).toEqual(['update', '--cpus', '1', 'cid-rocketchat']);
  });

  it('falls back to the VM capacity for a dimension that was unlimited', async () => {
    const seen = mockDocker('0 0 0');
    const mod = require('../../src/perf/constrain') as typeof ModNS;
    const applied = await mod.apply('ws', { rocketchat: { cpus: 2, mem: '2g' } });
    seen.length = 0;
    expect(await mod.restore(applied)).toEqual([]);
    expect(seen[0]).toEqual([
      'update',
      '--cpus',
      '8',
      '--memory',
      '16000000000',
      '--memory-swap',
      '16000000000',
      'cid-rocketchat',
    ]);
  });

  it('reports a problem instead of throwing, because restore runs inside a finally', async () => {
    const seen = mockDocker('1000000000 2000000000 4000000000');
    const mod = require('../../src/perf/constrain') as typeof ModNS;
    const applied = await mod.apply('ws', { rocketchat: { cpus: 2, mem: null } });

    jest.resetModules();
    jest.doMock('../../src/seams/docker-cli', () => ({
      docker: () => Promise.resolve({ exitCode: 1, stdout: '', stderr: 'daemon gone' }),
    }));
    jest.doMock('../../src/core/runner/host', () => ({
      dockerCapacity: () => Promise.resolve([8.0, 16e9]),
    }));
    const failing = require('../../src/perf/constrain') as typeof ModNS;
    // An exception here would skip the caller's remaining cleanup and mask whatever error
    // triggered the restore in the first place.
    expect(await failing.restore(applied)).toEqual(['rocketchat: daemon gone']);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('names EVERY dimension it could not put back', async () => {
    // Testing only "is the command still empty" hid the mixed case -- one dimension known,
    // the other not -- leaving half the test's cap applied with no warning at all.
    jest.resetModules();
    jest.doMock('../../src/seams/docker-cli', () => ({
      docker: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    }));
    jest.doMock('../../src/core/runner/host', () => ({
      dockerCapacity: () => Promise.resolve(null),
    }));
    const mod = require('../../src/perf/constrain') as typeof ModNS;
    const problems = await mod.restore([
      {
        container: 'c',
        service: 'rocketchat',
        prior_nano: 0,
        prior_mem: 0,
        prior_swap: 0,
        set_cpus: true,
        set_mem: true,
      },
    ]);
    expect(problems).toEqual([
      "rocketchat: could not determine CPU/memory capacity to restore - the test's cap is still applied",
    ]);
  });

  it('is a no-op for an empty apply list', async () => {
    mockDocker('0 0 0');
    const mod = require('../../src/perf/constrain') as typeof ModNS;
    expect(await mod.restore([])).toEqual([]);
  });
});

describe('restoring with only half the answer', () => {
  afterEach(() => {
    jest.resetModules();
  });

  function load(inspect = '') {
    jest.resetModules();
    const seen: string[][] = [];
    jest.doMock('../../src/seams/docker-cli', () => ({
      docker: (argv: string[]) => {
        seen.push(argv);
        return Promise.resolve({
          exitCode: 0,
          stdout: argv[0] === 'inspect' ? inspect : '',
          stderr: '',
        });
      },
    }));
    jest.doMock('../../src/core/runner/engine', () => ({
      serviceContainerIds: () => Promise.resolve(['cid1']),
    }));
    jest.doMock('../../src/core/runner/host', () => ({
      dockerCapacity: () => Promise.resolve(null),
    }));
    return { seen, mod: require('../../src/perf/constrain') as typeof ModNS };
  }

  it('restores the CPU it knows and reports the memory it cannot', async () => {
    // docker info unavailable, a real prior CPU limit, no prior memory limit. The memory
    // dimension used to be silent whenever the built command was non-empty, so the
    // test's memory cap stayed applied and the caller printed no warning.
    const { seen, mod } = load();
    const problems = await mod.restore([
      {
        container: 'cid1',
        service: 'rocketchat',
        prior_nano: 4_000_000_000,
        prior_mem: 0,
        prior_swap: 0,
        set_cpus: true,
        set_mem: true,
      },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('memory');
    expect(problems[0]).not.toContain('CPU');
    expect(seen).toEqual([['update', '--cpus', '4', 'cid1']]);
  });

  it('turns unreadable inspect output into the error every caller catches, naming the container', async () => {
    // A bare parse failure deeper in would escape as a raw stack trace in the CLI and an
    // internal-error job in the GUI.
    const { mod } = load('<no value>\n');
    await expect(mod.apply('ws', { rocketchat: { cpus: 1, mem: null } })).rejects.toThrow(
      "could not read current limits for cid1: '<no value>'",
    );
  });
});
