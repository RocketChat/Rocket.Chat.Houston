/**
 * The `--json` contract, for the cases no other spec carries.
 *
 * Driven through `runCli` with a FRESH app and executor per case, because several cases
 * reset the module registry and a refusal is recognised by class identity.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type * as DoctorNS from '../../src/core/doctor';
import type * as CreateDockerNS from '../../src/core/lifecycle/create-docker';
import type * as EksNS from '../../src/core/eks';
import type { Emit } from '../../src/lib/events';
import type * as EventsNS from '../../src/lib/events';
import type * as ErrorsNS from '../../src/lib/errors';
import type * as JsonoutNS from '../../src/lib/jsonout';
import type * as PolicyNS from '../testsetup-policy';
import type * as RecordNS from '../../src/core/runner/record';

import type * as AppNS from '../../src/cli/app';
import type { CliIo } from '../../src/cli/app';
import type * as CapabilitiesNS from '../../src/cli/capabilities';
import type * as HandlersNS from '../../src/cli/handlers';

const ROOT = path.resolve(__dirname, '..', '..');

let home = '';
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.HOUSTON_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-json-'));
  process.env.HOUSTON_HOME = home;
  jest.resetModules();
});
afterEach(() => {
  process.env.HOUSTON_HOME = previous;
  fs.rmSync(home, { recursive: true, force: true });
  jest.doMock('../../src/core/runner/host', () =>
    (require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
  );
  for (const id of [
    '../../src/core/lifecycle/inspect',
    '../../src/core/doctor',
    '../../src/core/runner/ports',
    '../../src/core/rcapi',
  ]) {
    jest.dontMock(id);
  }
  jest.resetModules();
});

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  envelope: Record<string, unknown>;
}

/** One command through the real parser and executor, from the current module registry. */
async function run(argv: string[]): Promise<Ran> {
  const app = require('../../src/cli/app') as typeof AppNS;
  const { createExecutor } = require('../../src/cli/handlers') as typeof HandlersNS;
  let stdout = '';
  let stderr = '';
  const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const io: CliIo = {
    writeOut: (value) => {
      stdout += value;
    },
    writeErr: (value) => {
      stderr += value;
    },
  };
  try {
    const code = await app.runCli(argv, { execute: createExecutor(io), io });
    const last = stdout
      .split('\n')
      .filter((line) => line.trim().startsWith('{'))
      .at(-1);
    return {
      code,
      stdout,
      stderr,
      envelope: last === undefined ? {} : (JSON.parse(last) as Record<string, unknown>),
    };
  } finally {
    write.mockRestore();
  }
}

const errorOf = (ran: Ran) => (ran.envelope.error ?? {}) as Record<string, unknown>;

function writeWorkspace(name: string, compose = true): void {
  const record = require('../../src/core/runner/record') as typeof RecordNS;
  const dir = path.join(home, 'repros', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'repro.json'),
    JSON.stringify(
      record.toDocument(
        record.metadata({
          name,
          project: 'p',
          rcVersion: '8.5.1',
          rootUrl: 'http://localhost:3001',
          hostPort: 3001,
          versionSource: 'x',
        }),
      ),
    ),
  );
  if (compose) fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
}

describe('a command that fails', () => {
  it('answers a failed listing with an envelope, not a stack trace', async () => {
    // `listRepros` reads every record and asks docker for project states, so it is not
    // the obviously-safe line it looks like.
    jest.doMock('../../src/core/lifecycle/inspect', () => ({
      ...jest.requireActual<object>('../../src/core/lifecycle/inspect'),
      listRepros: async () => {
        const errors = require('../../src/lib/errors') as typeof ErrorsNS;
        throw new errors.DockerError('docker is not running');
      },
    }));
    const errors = require('../../src/lib/errors') as typeof ErrorsNS;
    const ran = await run(['list', '--json']);
    expect(ran.envelope.ok).toBe(false);
    expect(errorOf(ran).code).toBe('ENGINE_UNAVAILABLE');
    expect(ran.code).toBe(errors.DockerError.exitCode);
  });

  it('answers a missing name with NOT_FOUND at exit 4, so a caller can tell it from not-ready', async () => {
    const ran = await run(['info', '--name', 'nope', '--json']);
    expect(errorOf(ran).code).toBe('NOT_FOUND');
    expect(ran.code).toBe(4);
  });

  it('keeps stdout a document and moves the human line to stderr', async () => {
    // `houston info --json > case.json` has to produce a valid document, and the person
    // who ran it should still see what happened.
    const ran = await run(['info', '--name', 'nope', '--json']);
    for (const line of ran.stdout.split('\n').filter((one) => one.trim() !== '')) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
    expect(ran.stderr).toContain('error:');
  });

  it('refuses a JSON `down --volumes` without --yes rather than keeping the data quietly', async () => {
    // Nobody can be prompted on this path; deleting unasked and silently keeping the data
    // are both unacceptable for an irreversible verb.
    writeWorkspace('r');
    const ran = await run(['down', '--name', 'r', '--volumes', '--json']);
    expect(ran.envelope.ok).toBe(false);
    expect(errorOf(ran).code).toBe('VALIDATION_FAILED');
    expect(String(errorOf(ran).message)).toContain('--yes');
    expect(ran.code).toBe(2);
    expect(fs.existsSync(path.join(home, 'repros', 'r', 'repro.json'))).toBe(true);
  });

  it('exits with a domain error its own code, without a stack', async () => {
    const ran = await run(['env', '--name', 'definitely-not-a-repro']);
    expect(ran.code).toBe(4);
    expect(`${ran.stdout}${ran.stderr}`).not.toMatch(/\n\s+at /u);
  });
});

describe('a state no command anticipated', () => {
  it('is still one envelope on stdout, and a non-zero exit', async () => {
    // A workspace with a compose file and no record (what an interrupted create leaves
    // between the two writes) and a malformed config.yaml each gave a stack trace and ZERO
    // bytes of stdout under --json. (A truncated record is the third state in the earlier
    // suite's test; this build reads it with defaults -- see suite-defects-cli-team.md.)
    const states: [string, () => string[]][] = [
      [
        'no repro.json',
        () => {
          fs.mkdirSync(path.join(home, 'repros', 'half'), { recursive: true });
          fs.writeFileSync(path.join(home, 'repros', 'half', 'docker-compose.yml'), 'services: {}');
          return ['info', '--name', 'half', '--json'];
        },
      ],
      [
        'malformed config.yaml',
        () => {
          fs.writeFileSync(path.join(home, 'config.yaml'), 'a: b: c: [');
          return ['list', '--json'];
        },
      ],
    ];
    for (const [label, build] of states) {
      fs.rmSync(path.join(home, 'repros'), { recursive: true, force: true });
      fs.rmSync(path.join(home, 'config.yaml'), { force: true });
      jest.resetModules();
      const ran = await run(build());
      expect({ label, ok: ran.envelope.ok, coded: Boolean(errorOf(ran).code) }).toEqual({
        label,
        ok: false,
        coded: true,
      });
      expect({ label, exit: ran.code === 0 }).toEqual({ label, exit: false });
    }
  });

  it('still writes one envelope when the failure comes before any command runs', async () => {
    // The accounts file is read on EVERY invocation, so a DIRECTORY where it belongs
    // failed before any command did.
    fs.mkdirSync(path.join(home, 'users'));
    const ran = await run(['list', '--json']);
    expect(ran.envelope.ok).toBe(false);
    expect(errorOf(ran).code).toBeTruthy();
    expect(ran.code).not.toBe(0);
    expect(`${ran.stdout}${ran.stderr}`).not.toMatch(/\n\s+at /u);
  });
});

describe('doctor --json', () => {
  it('keeps one id per check whatever the check finds, and no id carries a value', async () => {
    // Deriving the id from the MESSAGE gives `port-3000-free` and `port-3000-in`, so an
    // agent watching one id never sees the other state.
    const seen = new Map<string, Set<string>>();
    for (const free of [true, false]) {
      jest.resetModules();
      jest.doMock('../../src/core/runner/ports', () => ({
        ...jest.requireActual<object>('../../src/core/runner/ports'),
        portFree: async () => free,
      }));
      // The release lookup is the one row that would ask the network; unreachable is the
      // answer a box with no network gives.
      jest.doMock('../../src/core/rcapi', () => ({
        ...jest.requireActual<object>('../../src/core/rcapi'),
        releasesReachable: async () => null,
      }));
      const doctor = require('../../src/core/doctor') as typeof DoctorNS;
      for (const row of (await doctor.runChecks()).checks as { check: string; status: string }[]) {
        if (!seen.has(row.check)) seen.set(row.check, new Set());
        seen.get(row.check)?.add(row.status);
      }
    }
    expect([...seen.keys()].filter((id) => id.startsWith('port'))).toEqual(['ports']);
    expect([...seen.keys()].filter((id) => /\d/u.test(id))).toEqual([]);
  });

  it('puts every warning it counted into the envelope warnings, coded', async () => {
    // `warnings` was in the envelope from the start and nothing wrote to it, so doctor
    // counted warnings in `data` and put none where a caller is told to read.
    jest.doMock('../../src/core/doctor', () => ({
      ...jest.requireActual<object>('../../src/core/doctor'),
      runChecks: async () => ({
        verdict: 'warn',
        counts: { ok: 1, warn: 1, fail: 0 },
        checks: [
          { check: 'docker', status: 'ok', message: 'available' },
          { check: 'disk', status: 'warn', message: 'space is low' },
        ],
      }),
    }));
    const ran = await run(['doctor', '--json']);
    expect(ran.code).toBe(0);
    const warnings = ran.envelope.warnings as { code?: string; message?: string }[];
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.code)).toMatch(/^DOCTOR_/u);
    expect(warnings[0]?.message).toBeTruthy();
  });
});

describe('the capabilities document', () => {
  function doc(): Record<string, unknown> {
    return (require('../../src/cli/capabilities') as typeof CapabilitiesNS).capabilities();
  }
  const commands = () =>
    Object.fromEntries(
      (doc().commands as { name: string }[]).map((row) => [
        row.name,
        row as Record<string, unknown>,
      ]),
    );

  it('carries no pre-rename key, and says so with the wire generation', () => {
    // Removing `rc_repro_version` and `schema_legacy` is a BREAKING change, so it comes
    // with the bump of `contract`: either alone is a bug.
    const jsonout = require('../../src/lib/jsonout') as typeof JsonoutNS;
    const errors = require('../../src/lib/errors') as typeof ErrorsNS;
    const env = jsonout.envelope('info', { x: 1 }) as unknown as Record<string, unknown>;
    expect(env.schema).toBe('houston.info.v1');
    expect(env.contract).toBe(2);
    const failed = jsonout.errorEnvelope(
      new errors.NotReadyError('still booting'),
    ) as unknown as Record<string, unknown>;
    expect(failed.schema).toBe('houston.error.v1');
    for (const one of [env, failed]) {
      expect(Object.keys(one)).not.toContain('schema_legacy');
      expect(Object.keys(one)).not.toContain('rc_repro_version');
    }
    const caps = doc();
    expect(caps.contract_versions).toEqual([2]);
    expect(Object.keys(caps)).not.toContain('rc_repro_version');
    const speaking = (caps.commands as Record<string, unknown>[]).filter(
      (row) => row.json === true,
    );
    expect(speaking.length).toBeGreaterThan(0);
    for (const row of speaking) {
      expect(Object.keys(row)).not.toContain('schema_legacy');
      expect(String(row.schema)).toMatch(/^houston\./u);
    }
  });

  it('lists a grouped subcommand', () => {
    // The obvious walk sees only top-level commands, so grouped ones vanish silently.
    expect(Object.keys(commands())).toEqual(
      expect.arrayContaining(['skill install', 'skill status']),
    );
  });

  it('advertises the schemas the commands really emit, nested and positional ones included', () => {
    const rows = commands();
    expect(rows['skill install']?.schema).toBe('houston.skill-install.v1');
    expect(rows['skill status']?.schema).toBe('houston.skill-status.v1');
    expect(rows.cluster?.schema).toBe('houston.cluster.v1');
    expect(rows.cluster?.schemas).toEqual([
      'houston.cluster-connect.v1',
      'houston.cluster-create.v1',
      'houston.cluster-delete.v1',
      'houston.cluster-forget.v1',
      'houston.cluster-guide.v1',
      'houston.cluster-iam-policy.v1',
      'houston.cluster-keep.v1',
      'houston.cluster-list.v1',
      'houston.cluster-overview.v1',
      'houston.cluster-prepare.v1',
      'houston.cluster-share.v1',
      'houston.cluster.v1',
    ]);
  });

  it('advertises exactly the gate codes this build can raise', () => {
    // Publishing every gate would teach a caller to write branches that never run.
    const errors = require('../../src/lib/errors') as typeof ErrorsNS;
    const codes = new Set(doc().error_codes as string[]);
    expect(codes.has('VALIDATION_FAILED') && codes.has('NOT_READY')).toBe(true);
    const unreachable = Object.keys(errors.GATE_CODES).filter(
      (code) => !errors.RAISED_GATE_CODES.includes(code),
    );
    expect(unreachable.filter((code) => codes.has(code))).toEqual([]);
    expect(errors.RAISED_GATE_CODES.filter((code) => !codes.has(code))).toEqual([]);
  });

  it("lists the presets in earlier releases' order, by code point", () => {
    // `.sort()` compares UTF-16 units, which puts an astral `😀` BELOW `Ａ` (U+FF21);
    // earlier releases sort by code point, which puts it above.
    fs.mkdirSync(path.join(home, 'presets'));
    fs.writeFileSync(path.join(home, 'presets', 'a.yaml'), 'name: 😀-emoji\n');
    fs.writeFileSync(path.join(home, 'presets', 'b.yaml'), 'name: Ａ-fullwidth\n');
    // What earlier releases' capabilities listed for this home, recorded, less
    // `multi-instance`: since 2026-10-08 it is listed only as the deployment shape.
    const recorded = [
      'airgapped',
      'default',
      'e2ee',
      'email',
      'ldap',
      'livechat',
      'oidc',
      's3_minio',
      'saml',
      'voice',
      'webhooks',
      'Ａ-fullwidth',
      '😀-emoji',
    ];
    expect(recorded.indexOf('Ａ-fullwidth')).toBeLessThan(recorded.indexOf('😀-emoji'));
    expect(doc().presets).toEqual(recorded);
  });

  it('needs no engine and no home, because it is asked before anyone knows either works', async () => {
    process.env.HOUSTON_HOME = path.join(home, 'nothing-here');
    jest.doMock('../../src/core/runner/host', () => ({
      ...(require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
      dockerAvailable: async () => {
        throw new Error('capabilities asked docker');
      },
    }));
    const ran = await run(['capabilities']);
    expect(ran.code).toBe(0);
    expect((ran.envelope.data as Record<string, unknown>).houston_version).toBeTruthy();
  });
});

describe('cluster guide --path --json', () => {
  it('narrows the data and keeps stdout one envelope', async () => {
    const ran = await run(['cluster', 'guide', '--path', '--json']);
    expect(ran.code).toBe(0);
    expect(ran.stdout.split('\n').filter((line) => line !== '')).toHaveLength(1);
    expect(ran.envelope.schema).toBe('houston.cluster-guide.v1');
    expect(ran.envelope.data).toEqual({
      path: path.join(ROOT, 'data', 'docs', 'eks.md'),
    });
  });
});

describe('cluster status by name', () => {
  afterEach(() => {
    jest.dontMock('../../src/core/cluster');
  });

  it('takes the bare name the other actions take, as well as --context', async () => {
    const asked: string[] = [];
    jest.doMock('../../src/core/cluster', () => ({
      ...jest.requireActual('../../src/core/cluster'),
      status: jest.fn(async (context: string) => {
        asked.push(context);
        return {
          context,
          reachable: false,
          unreadable: ['cluster'],
          gone: true,
          reach_why: '',
          reach_advice: '',
        };
      }),
    }));
    await run(['cluster', 'status', 'support', '--json']);
    await run(['cluster', 'status', '--context', 'perf', '--json']);
    expect(asked).toEqual(['support', 'perf']);
  });
});

describe('cluster overview --json', () => {
  afterEach(() => {
    jest.dontMock('../../src/core/cluster');
  });

  it('is one envelope carrying the clusters, the totals and the next step', async () => {
    jest.doMock('../../src/core/cluster', () => ({
      ...jest.requireActual('../../src/core/cluster'),
      overview: jest.fn(async () => ({
        clusters: [],
        failed: [],
        preflight: {
          tools_ok: true,
          blockers: [],
          account: '1',
          identity: '',
          region: 'us-east-1',
          approved: true,
        },
        totals: { clusters: 0, billable: 0, usd_day: null, spend_usd: null, workspaces: 0 },
        next: {
          stage: 3,
          cluster: '',
          title: 'Build a cluster',
          why: 'w',
          command: 'houston cluster create support',
        },
        default: '',
        unreadable: '',
      })),
    }));
    const ran = await run(['cluster', 'overview', '--json']);
    expect(ran.code).toBe(0);
    expect(ran.envelope.schema).toBe('houston.cluster-overview.v1');
    expect(ran.envelope.data).toMatchObject({ totals: { clusters: 0 }, next: { stage: 3 } });
  });
});

describe('cluster list --json', () => {
  afterEach(() => {
    jest.dontMock('../../src/core/eks');
  });

  it('writes the envelope and nothing else, the progress and the warning included', async () => {
    // Earlier releases wrote each `[i/N] region` line to stdout ahead of the envelope. This
    // build's emitter prints nothing while --json is active, and later 1.x releases do the same.
    jest.doMock('../../src/core/eks', () => ({
      ...jest.requireActual<typeof EksNS>('../../src/core/eks'),
      sweepClusters: ({ ownedOnly = true, emit }: { ownedOnly?: boolean; emit?: Emit } = {}) => {
        const events = require('../../src/lib/events') as typeof EventsNS;
        const sink = emit ?? events.nullEmit;
        ['us-east-1', 'eu-west-1'].forEach((region, at) => {
          events.info(sink, `[${String(at + 1)}/2] ${region}`, { phase: 'preflight' });
        });
        events.warn(sink, 'eu-west-1 could not be read', { phase: 'preflight' });
        return Promise.resolve({
          clusters: [],
          regions: ['us-east-1'],
          fallback: '',
          owned_only: ownedOnly,
          unreadable: [{ region: 'eu-west-1', why: 'AccessDenied' }],
        });
      },
    }));
    const ran = await run(['cluster', 'list', '--json']);
    expect(ran.code).toBe(0);
    expect(ran.stdout.split('\n').filter((line) => line !== '')).toHaveLength(1);
    expect(ran.stderr).toBe('');
    expect(ran.envelope.schema).toBe('houston.cluster-list.v1');
    // The region that could not be read is a warning in the envelope, once, as earlier
    // releases make it; this build added none.
    expect((ran.envelope.warnings as { code: string }[]).map((warning) => warning.code)).toEqual([
      'REGION_UNREADABLE_EU_WEST_1',
    ]);
    expect((ran.envelope.data as Record<string, unknown>).owned_only).toBe(true);
  });
});

/**
 * Two `cluster` answers where EARLIER RELEASES broke the contract and were fixed toward it: they
 * refused an unknown action before activating --json, so stdout was empty, and they replied
 * `forgotten: false` with exit 0 ahead of the CONFLICT a human gets. This build answered
 * both the contract's way already; these hold it there.
 */
describe('cluster --json, one verdict for both front ends', () => {
  afterEach(() => {
    jest.dontMock('../../src/core/kube/context');
    jest.dontMock('../../src/core/kube/reachability');
  });

  it('answers an unknown action with one VALIDATION_FAILED envelope, exit 2', async () => {
    const ran = await run(['cluster', 'bogus', '--json']);
    expect(ran.code).toBe(2);
    expect(ran.stdout.split('\n').filter((line) => line.trim() !== '')).toHaveLength(1);
    expect(ran.envelope.ok).toBe(false);
    expect(errorOf(ran).code).toBe('VALIDATION_FAILED');
    expect(String(errorOf(ran).message)).toContain("unknown action 'bogus'");
  });

  it('refuses a forget that leaves the entry with CONFLICT, exit 8, in both modes', async () => {
    const world = (): void => {
      jest.doMock('../../src/core/kube/context', () => ({
        ...jest.requireActual('../../src/core/kube/context'),
        activeContext: async () => 'support',
        forgetContext: async () => false,
      }));
      jest.doMock('../../src/core/kube/reachability', () => ({
        ...jest.requireActual('../../src/core/kube/reachability'),
        reach: async () => ({ status: 'down', why: '' }),
        reachOk: () => false,
      }));
    };
    world();
    const human = await run(['cluster', 'forget', 'support']);
    expect(human.code).toBe(8);
    expect(human.stderr).toContain('is still named by a kubeconfig');
    jest.resetModules();
    world();
    const ran = await run(['cluster', 'forget', 'support', '--json']);
    expect(ran.code).toBe(8);
    expect(ran.stdout.split('\n').filter((line) => line.trim() !== '')).toHaveLength(1);
    expect(ran.envelope.ok).toBe(false);
    expect(errorOf(ran).code).toBe('CONFLICT');
  });
});

describe('capacity --json', () => {
  it('answers a box with no engine with one ENGINE_UNAVAILABLE envelope and exit 3', async () => {
    // Earlier releases asked for the engine before they activated --json and wrote no envelope.
    jest.doMock('../../src/core/runner/host', () => ({
      ...(require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
      dockerAvailable: () => Promise.resolve(false),
    }));
    const ran = await run(['capacity', '--name', 'nope', '--json']);
    expect(ran.stdout.split('\n').filter((line) => line !== '')).toHaveLength(1);
    expect([ran.code, ran.envelope.ok, errorOf(ran).code]).toEqual([
      3,
      false,
      'ENGINE_UNAVAILABLE',
    ]);
  });
});

describe('up --json', () => {
  afterEach(() => {
    jest.dontMock('../../src/core/lifecycle/create-docker');
  });

  it('leaves compose on the terminal: none of its lines becomes an NDJSON boot event', async () => {
    // Earlier releases do not stream compose's output under --json either, so compose draws
    // on the terminal (its stdout on stderr in JSON mode) and the stream carries houston's
    // events only. Streaming here made every pull and container line a `boot` event with
    // `detail.echo: "docker"` that earlier releases never emit.
    const seen: { streamOutput?: boolean | undefined } = {};
    jest.doMock('../../src/core/lifecycle/create-docker', () => ({
      ...jest.requireActual<typeof CreateDockerNS>('../../src/core/lifecycle/create-docker'),
      createRepro: (_req: unknown, _emit: unknown, given: { streamOutput?: boolean } = {}) => {
        seen.streamOutput = given.streamOutput;
        const errors = require('../../src/lib/errors') as typeof ErrorsNS;
        return Promise.reject(new errors.NotReadyError('stopped before compose'));
      },
    }));
    const ran = await run(['up', '--version', '8.5.1', '--offline', '--name', 'alpha', '--json']);
    expect(errorOf(ran).code).toBe('NOT_READY');
    expect(seen.streamOutput).toBe(false);
  });
});
