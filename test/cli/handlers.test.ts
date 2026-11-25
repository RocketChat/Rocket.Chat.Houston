import * as fs from 'node:fs';
import * as path from 'node:path';

import type * as EventlogNS from '../../src/core/eventlog';
import type * as RcapiNS from '../../src/core/rcapi';
import type * as EventsNS from '../../src/lib/events';
import type * as PolicyNS from '../testsetup-policy';
import { loadConfig } from '../../src/lib/config';
import { workspace } from '../../src/core/runner/paths';
import { metadata, write, writeRecord } from '../../src/core/runner/record';

import { runCli, type CliIo } from '../../src/cli/app';
import type * as AppNS from '../../src/cli/app';
import { createExecutor } from '../../src/cli/handlers';
import type * as HandlersNS from '../../src/cli/handlers';
import { parseJsonTranscript } from '../../src/cli/wire';

async function real(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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
    return { code: await runCli(argv, { execute: createExecutor(io), io }), stdout, stderr };
  } finally {
    write.mockRestore();
  }
}

describe('real handler dispatch through Commander', () => {
  test('list JSON includes the count field of earlier releases and exactly one final envelope', async () => {
    const result = await real(['list', '--json']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const transcript = parseJsonTranscript(result.stdout, false);
    expect(transcript.envelope).toMatchObject({
      ok: true,
      data: { count: 0, repros: [] },
    });
  });

  test('presets --json answers the catalogue in the names the support bot reads', async () => {
    // The support bot runs `houston presets --json` and reads `data.presets[].paramsHelp` (and
    // `.error`) to check a job's preset options; 2.1.8 refused the flag with exit 2, so every
    // job that set a preset option was refused before it booted anything.
    fs.mkdirSync(path.join(process.env.HOUSTON_HOME as string, 'presets'), { recursive: true });
    fs.writeFileSync(
      path.join(process.env.HOUSTON_HOME as string, 'presets', 'broken.yaml'),
      'name: broken\n  : [\n',
    );
    const result = await real(['presets', '--json']);
    expect(result.code).toBe(0);
    const transcript = parseJsonTranscript(result.stdout, false);
    expect(transcript.envelope).toMatchObject({ ok: true, schema: 'houston.presets.v1' });
    const presets = (transcript.envelope as { data: { presets: Record<string, unknown>[] } }).data
      .presets;
    const ldap = presets.find((p) => p.name === 'ldap') as Record<string, unknown>;
    expect(Object.keys(ldap).sort()).toEqual(['description', 'name', 'paramsHelp']);
    expect(ldap.paramsHelp).toMatchObject({ users: expect.any(String) });
    const broken = presets.find((p) => p.name === 'broken') as Record<string, unknown>;
    expect(broken.error).toEqual(expect.any(String));
    // Plain `presets` is unchanged: the boxes, no JSON.
    const text = await real(['presets']);
    expect(text.stdout.startsWith('Presets\n')).toBe(true);
  });

  test('positional config and users actions execute rather than becoming subcommands', async () => {
    expect((await real(['config', 'set', 'acme.staging', 'false'])).code).toBe(0);
    // `false`: a stored false, which is not an unset key.
    expect((await real(['config', 'get', 'acme.staging'])).stdout.trim()).toBe('false');
    const users = await real(['users', 'list']);
    expect(users.code).toBe(0);
    expect(users.stdout).toContain('no users yet');
    expect(users.stdout).not.toContain('"users"');
  });

  test('doctor warnings and failure use the stable JSON error and exit 3', async () => {
    jest.resetModules();
    jest.doMock('../../src/core/doctor', () => ({
      ...jest.requireActual<object>('../../src/core/doctor'),
      runChecks: jest.fn(async () => ({
        verdict: 'fail',
        counts: { fail: 1 },
        checks: [{ check: 'docker', status: 'fail', message: 'not answering' }],
        repros: null,
      })),
    }));
    const app = require('../../src/cli/app') as typeof AppNS;
    const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
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
    const code = await app.runCli(['doctor', '--json'], {
      execute: handlers.createExecutor(io),
      io,
    });
    write.mockRestore();
    jest.dontMock('../../src/core/doctor');
    const result = { code, stdout, stderr };
    expect(result.code).toBe(3);
    const envelope = parseJsonTranscript(result.stdout, false).envelope;
    expect(envelope).toMatchObject({
      ok: false,
      error: { code: 'PREFLIGHT_FAILED' },
      warnings: [{ code: 'DOCTOR_DOCKER', message: 'not answering' }],
    });
  });

  test('offline version resolution remains reachable through the real handler', async () => {
    const result = await real(['versions', '8.5.1', '--offline']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Rocket.Chat 8.5.1');
    expect(result.stdout).toContain('MongoDB');
  });

  test('cluster guide --path stays an envelope', async () => {
    const result = await real(['cluster', 'guide', '--path', '--json']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(parseJsonTranscript(result.stdout, false).envelope.ok).toBe(true);
  });

  test('a live 404 reaches the CLI as an explicit unknown-release warning', async () => {
    jest.resetModules();
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual<object>('../../src/core/rcapi'),
      releaseInfo: jest.fn(async () => ({ status: 404, json: () => ({}) })),
    }));
    const app = require('../../src/cli/app') as typeof AppNS;
    const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
    let stdout = '';
    let stderr = '';
    const io: CliIo = {
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
    };
    const code = await app.runCli(['versions', '99.1.2'], {
      execute: handlers.createExecutor(io),
      io,
    });
    jest.dontMock('../../src/core/rcapi');
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('resolved via : map (no such release)');
    expect(stdout).toContain('releases.rocket.chat has no 99.1.2');
  });

  test('a CI build prints its image as it is pulled, never repo:tag:version', async () => {
    // Seen live: `versions pr-42617` printed ghcr.io/rocketchat/rocket.chat:pr-42617:8.10.0.dev0.
    jest.resetModules();
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual<object>('../../src/core/rcapi'),
      releaseInfo: jest.fn(async () => ({
        status: 200,
        json: () => ({ version: '8.10.0-develop' }),
      })),
    }));
    const app = require('../../src/cli/app') as typeof AppNS;
    const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
    let stdout = '';
    const io: CliIo = {
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: () => undefined,
    };
    const code = await app.runCli(['versions', 'pr-42617'], {
      execute: handlers.createExecutor(io),
      io,
    });
    jest.dontMock('../../src/core/rcapi');
    expect(code).toBe(0);
    expect(stdout).toContain('  image        : ghcr.io/rocketchat/rocket.chat:pr-42617\n');
  });

  test('prune asks before an orphan namespace can reach the destructive service', async () => {
    jest.resetModules();
    const prune = jest.fn();
    jest.doMock('../../src/core/lifecycle/pruning', () => ({
      prunable: jest.fn(async () => []),
      orphanNamespaces: jest.fn(async () => ['houston-orphan']),
      prune,
    }));
    const app = require('../../src/cli/app') as typeof AppNS;
    const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
    let stdout = '';
    let stderr = '';
    const io: CliIo = {
      writeOut: (value) => {
        stdout += value;
      },
      writeErr: (value) => {
        stderr += value;
      },
    };
    const code = await app.runCli(['prune', '--orphans'], {
      execute: handlers.createExecutor(io, { confirm: async () => false }),
      io,
    });
    jest.dontMock('../../src/core/lifecycle/pruning');
    // Declined is what earlier releases' aborting confirmation does: `Aborted.` on stderr and
    // exit 1, not an `error:` line. An earlier version exited 2 with `error: cancelled`, telling a
    // script its input was invalid when it had simply said no.
    expect(code).toBe(1);
    expect(stderr).toBe('Aborted.\n');
    // Every destructive target is NAMED before the one question, as earlier releases do:
    // a namespace whose owner cannot be read is said to need --force.
    expect(stdout).toContain('  - houston-orphan   (owner could not be read — needs --force)');
    expect(prune).not.toHaveBeenCalled();
  });
});

describe('a start that fails', () => {
  test("says the service's own reason, not one sentence for every failure", async () => {
    // Every failed `start` printed "if it was `down`ed, use `houston up`" -- so a merely
    // stopped workspace whose port somebody else held was sent to recreate itself, while
    // the core had said which it was and why.
    jest.resetModules();
    await writeRecord('st', metadata({ name: 'st', project: 'houston-st' }));
    const reason =
      "`docker compose start` failed for 'st' — rocketchat: failed to bind host port " +
      '127.0.0.1:3611/tcp: address already in use';
    jest.doMock('../../src/core/lifecycle/state', () => ({
      ...jest.requireActual('../../src/core/lifecycle/state'),
      setState: async () => {
        const errors = require('../../src/lib/errors') as {
          DockerError: new (message: string) => Error;
        };
        throw new errors.DockerError(reason);
      },
    }));
    const app = require('../../src/cli/app') as typeof AppNS;
    const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
    let stderr = '';
    const io: CliIo = {
      writeOut: () => undefined,
      writeErr: (value) => {
        stderr += value;
      },
    };
    const code = await app.runCli(['start', '--name', 'st'], {
      execute: handlers.createExecutor(io),
      io,
    });
    jest.dontMock('../../src/core/lifecycle/state');
    expect(code).toBe(3);
    expect(stderr).toBe(`error: ${reason}\n`);
  });
});

describe('cluster delete names the region it will act in', () => {
  it('uses the region the cluster was built in when none is typed, and says so in the question', async () => {
    const seen: string[] = [];
    jest.doMock('../../src/core/eks', () => ({
      ...jest.requireActual('../../src/core/eks'),
      preflight: async () => ({
        tools: {},
        identity: { account: '1', arn: '', error: '' },
        region: 'eu-west-1',
      }),
      rememberedRegion: () => 'us-west-2',
      describeCluster: async (_name: string, region: string) => {
        seen.push(region);
        return { state: 'present', doc: { tags: {} } };
      },
    }));
    const app = require('../../src/cli/app') as typeof AppNS;
    const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
    let asked = '';
    const io: CliIo = { writeOut: () => undefined, writeErr: () => undefined };
    const code = await app.runCli(['cluster', 'delete', 'support'], {
      execute: handlers.createExecutor(io, {
        confirm: async (question: string) => {
          asked = question;
          return false;
        },
      }),
      io,
    });
    jest.dontMock('../../src/core/eks');
    expect(code).toBe(1);
    // The existence check and the question both name the build region: a delete that
    // looked in the AWS CLI's default region printed "nothing to delete" while the
    // cluster billed on elsewhere, and the question named no region unless one was typed.
    expect(seen).toEqual(['us-west-2']);
    expect(asked).toContain('in us-west-2');
  });

  it('asks in red where colour is wanted, like every word that is about to destroy something', async () => {
    jest.resetModules();
    const saved = { force: process.env.FORCE_COLOR, none: process.env.NO_COLOR };
    process.env.FORCE_COLOR = '1';
    delete process.env.NO_COLOR;
    jest.doMock('../../src/core/eks', () => ({
      ...jest.requireActual('../../src/core/eks'),
      preflight: async () => ({
        tools: {},
        identity: { account: '1', arn: '', error: '' },
        region: 'eu-west-1',
      }),
      rememberedRegion: () => 'eu-west-1',
      describeCluster: async () => ({ state: 'present', doc: { tags: {} } }),
    }));
    try {
      const app = require('../../src/cli/app') as typeof AppNS;
      const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
      let asked = '';
      const io: CliIo = { writeOut: () => undefined, writeErr: () => undefined };
      await app.runCli(['cluster', 'delete', 'support'], {
        execute: handlers.createExecutor(io, {
          confirm: async (question: string) => {
            asked = question;
            return false;
          },
        }),
        io,
      });
      expect(asked.startsWith('\u001b[31mDelete EKS cluster')).toBe(true);
    } finally {
      jest.dontMock('../../src/core/eks');
      if (saved.force === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = saved.force;
      if (saved.none !== undefined) process.env.NO_COLOR = saved.none;
    }
  });
});

describe('cluster connect uses the same existing-cluster path as the GUI', () => {
  it('hands the full ARN to the core and prints the context for a workspace', async () => {
    jest.resetModules();
    const arn = 'arn:aws:eks:eu-west-1:111122223333:cluster/support';
    const connectExisting = jest.fn(async () => ({
      context: arn,
      account: '111122223333',
      principal: 'arn:aws:iam::111122223333:user/alice',
      region: 'eu-west-1',
      reachable: true,
      access_reason: '',
    }));
    jest.doMock('../../src/core/eks', () => ({
      ...jest.requireActual('../../src/core/eks'),
      connectExisting,
    }));
    try {
      const app = require('../../src/cli/app') as typeof AppNS;
      const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
      let output = '';
      const io: CliIo = {
        writeOut: (line) => {
          output += line;
        },
        writeErr: () => undefined,
      };
      const code = await app.runCli(['cluster', 'connect', arn], {
        execute: handlers.createExecutor(io),
        io,
      });
      expect(code).toBe(0);
      expect(connectExisting).toHaveBeenCalledWith(arn);
      expect(output).toContain(`--context ${arn}`);
    } finally {
      jest.dontMock('../../src/core/eks');
    }
  });
});

describe('an invalid version is refused before anything is asked', () => {
  // A DEFECT AN EARLIER VERSION HAD: `resolve` is synchronous, so every caller fetches the release
  // info first -- and they fetched BEFORE `resolve` could refuse the version, so an invalid
  // one sent `https://releases.rocket.chat/<whatever was typed>/info` over the wire. Earlier
  // releases parse first and go online second. The network guard (test/testsetup-network.ts)
  // is what made the request visible; this reads its record directly.
  const reaches = (): string[] =>
    (globalThis as unknown as Record<symbol, { reaches: string[] } | undefined>)[
      Symbol.for('houston.test.network-guard')
    ]?.reaches.splice(0) ?? [];

  test('versions: refused, and releases.rocket.chat is never asked', async () => {
    const result = await real(['versions', 'nonsense']);
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("'nonsense' is not a valid version");
    expect(reaches()).toEqual([]);
  });

  // A refused version is ONE `error:` line on stderr, nothing on stdout, exit 2, and a durable
  // record with code VALIDATION_FAILED and `trace: false` -- what `up --version` answers for
  // the same input. It was exit 1 and REPRO_ERROR, so one typo had two exit codes (L7-07).
  // An earlier version let resolve's InvalidVersionError escape to runCli's unhandled
  // branch: a JavaScript stack, "... this is unhandled ...", and `trace: true`, which is the
  // event log's signal for a defect. Every refusal `resolve` raises is pinned: the
  // unparsable string, the parsable one no rule matches, and a CI build asked offline.
  test.each([
    [
      ['versions', 'notaversion', '--offline'],
      "'notaversion' is not a valid version (want e.g. 6.5.3)",
    ],
    [['versions', 'notaversion'], "'notaversion' is not a valid version (want e.g. 6.5.3)"],
    [
      ['versions', '8.0rc1', '--offline'],
      'no rule matches RC 8.0rc1 and the live lookup was unavailable',
    ],
    [
      ['versions', 'develop', '--offline'],
      "'develop' is a CI build, and its version is read from " +
        'https://raw.githubusercontent.com/RocketChat/Rocket.Chat/develop/apps/meteor/package.json, ' +
        // `up`'s flags, said as such: `versions` has no --rc-image.
        'which needs the network. `up` can name the image itself instead: ' +
        '--rc-image ghcr.io/rocketchat/rocket.chat:develop --version <its x.y.z>.',
    ],
  ])('versions %j: one error line, exit 2, usage, and no trace', async (argv, message) => {
    // FRESH modules: an earlier test resets the registry, after which the top-level app's
    // `instanceof ReproError` would not recognise a class the lazily-required handler throws.
    jest.resetModules();
    const fresh = require('../../src/cli/app') as typeof AppNS;
    const { createExecutor: fresher } = require('../../src/cli/handlers') as typeof HandlersNS;
    const eventlog = require('../../src/core/eventlog') as typeof EventlogNS;
    eventlog.resetForTest();
    let stdout = '';
    let stderr = '';
    const io: CliIo = {
      writeOut: (value) => (stdout += value),
      writeErr: (value) => (stderr += value),
    };
    const code = await fresh.runCli(argv, { execute: fresher(io), io });
    expect({ code, stdout, stderr }).toEqual({
      code: 2,
      stdout: '',
      stderr: `error: ${message}\n`,
    });
    const records = fs
      .readFileSync(eventlog.logPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(
        (line) => JSON.parse(line) as { kind: string; code: string; msg: string; trace: boolean },
      )
      .filter((record) => record.kind === 'error');
    expect(records.at(-1)).toMatchObject({
      code: 'VALIDATION_FAILED',
      msg: message,
      trace: false,
    });
    expect(reaches()).toEqual([]);
  });

  test('up: refused the same way, and the create never asks either', async () => {
    jest.resetModules();
    // Capacity is stated, so a loaded box cannot refuse this create for another reason.
    jest.doMock('../../src/core/lifecycle/sizing', () => ({
      ...jest.requireActual<object>('../../src/core/lifecycle/sizing'),
      checkCapacity: async () => undefined,
    }));
    try {
      const fresh = require('../../src/cli/app') as typeof AppNS;
      const { createExecutor: fresher } = require('../../src/cli/handlers') as typeof HandlersNS;
      let out = '';
      const io: CliIo = {
        writeOut: (value) => (out += value),
        writeErr: (value) => (out += value),
      };
      const code = await fresh.runCli(['up', '--version', 'nonsense', '--name', 'badver'], {
        execute: fresher(io),
        io,
      });
      expect(code).not.toBe(0);
      expect(out).toContain("'nonsense' is not a valid version");
      expect(reaches()).toEqual([]);
    } finally {
      jest.dontMock('../../src/core/lifecycle/sizing');
      jest.resetModules();
    }
  });
});

describe('the release lookup `up` makes', () => {
  // Earlier releases resolve the pairing online AFTER the name checks, the create lock and the engine
  // preflight, so every refusal ahead of it answers without a request. `up` fetched right
  // after parsing --set, before all of them, and on a network that drops packets each
  // refusal waited out the lookup's 5 s timeout first.
  afterEach(() => {
    for (const id of ['../../src/core/rcapi', '../../src/core/runner/host']) jest.dontMock(id);
    jest.doMock('../../src/core/runner/host', () =>
      (require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
    );
    jest.resetModules();
  });

  async function up(argv: string[], host: Record<string, unknown> = {}) {
    jest.resetModules();
    const releaseInfo = jest.fn(async (_url: string) => ({ status: 404, json: () => ({}) }));
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual<typeof RcapiNS>('../../src/core/rcapi'),
      releaseInfo,
    }));
    jest.doMock('../../src/core/runner/host', () => ({
      ...(require('../testsetup-policy') as typeof PolicyNS).healthyHost(),
      ...host,
    }));
    const app = require('../../src/cli/app') as typeof AppNS;
    const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
    let said = '';
    const io: CliIo = {
      writeOut: (value) => (said += value),
      writeErr: (value) => (said += value),
    };
    const code = await app.runCli(['up', '--version', '8.5.1', ...argv], {
      execute: handlers.createExecutor(io),
      io,
    });
    return { code, said, asked: releaseInfo.mock.calls.map((call) => String(call[0])) };
  }

  test('refuses on a stopped engine without asking releases.rocket.chat', async () => {
    const ran = await up(['--name', 'alpha'], { dockerAvailable: async () => false });
    expect(ran.code).toBe(3);
    expect(ran.said).toContain("Docker isn't running");
    expect(ran.asked).toEqual([]);
  });

  test.each([
    [['--name', '__'], 'contains no usable characters'],
    [['--name', 'alpha', '--env', 'FOO'], 'FOO'],
  ])('refuses %j on the request alone, asking nothing', async (argv, words) => {
    const ran = await up(argv);
    expect(ran.code).toBe(2);
    expect(ran.said).toContain(words);
    expect(ran.asked).toEqual([]);
  });

  test('asks once, inside the create, once the engine has answered', async () => {
    // Stopped at the kernel probe, the step after `resolve`.
    const ran = await up(['--name', 'alpha'], {
      dockerKernelVersion: async () => Promise.reject(new Error('stopped after the lookup')),
    });
    expect(ran.said).toContain('stopped after the lookup');
    expect(ran.asked).toEqual(['https://releases.rocket.chat/8.5.1/info']);
  });
});

describe('use', () => {
  test('resolves the name like every other command, and a missing one exits 4', async () => {
    // `use` looked the literal argument up, so `use TICKET-1234` failed on a workspace
    // really named `ticket-1234` while `info --name TICKET-1234` found it -- and on a box
    // with accounts `use test` could not find `alice-test`. Exit was 1 where the table
    // says 4.
    //
    // A FRESH app and executor: an earlier test resets the module registry, after which
    // the top-level app's `instanceof NotFoundError` no longer recognises the class the
    // lazily-required handler throws, and every refusal would read as exit 1.
    jest.resetModules();
    const fresh = require('../../src/cli/app') as typeof AppNS;
    const { createExecutor: fresher } = require('../../src/cli/handlers') as typeof HandlersNS;
    const run = async (argv: string[]): Promise<{ code: number; out: string }> => {
      let out = '';
      const io: CliIo = {
        writeOut: (value) => (out += value),
        writeErr: (value) => (out += value),
      };
      return { code: await fresh.runCli(argv, { execute: fresher(io), io }), out };
    };
    await writeRecord(
      'ticket-1234',
      metadata({ name: 'ticket-1234', project: 'houston-ticket-1234' }),
    );
    const found = await run(['use', 'TICKET-1234']);
    expect(found.code).toBe(0);
    expect(found.out).toContain('ticket-1234');
    expect(loadConfig().default_repro).toBe('ticket-1234');
    const missing = await run(['use', 'nope']);
    expect(missing.code).toBe(4);
    expect(missing.out).toContain("no workspace named 'nope'");
    expect(loadConfig().default_repro).toBe('ticket-1234');
  });
});

describe('prune', () => {
  test('says what goes for good, and that stopped workspaces are left alone', async () => {
    // "These down repros will be deleted" did not say that `down` is not `stop`, nor that the
    // data `down` kept goes too; and "PersistentVolumeClaims" did not say it is their data.
    jest.resetModules();
    jest.doMock('../../src/core/lifecycle/pruning', () => ({
      ...jest.requireActual<object>('../../src/core/lifecycle/pruning'),
      prunable: async () => ['bob-t1'],
      orphanNamespaces: async () => ['houston-orphan'],
      prune: jest.fn(),
    }));
    try {
      const fresh = require('../../src/cli/app') as typeof AppNS;
      const { createExecutor: fresher } = require('../../src/cli/handlers') as typeof HandlersNS;
      let out = '';
      const io: CliIo = {
        writeOut: (value) => (out += value),
        writeErr: () => undefined,
      };
      const code = await fresh.runCli(['prune', '--orphans'], {
        execute: fresher(io, { confirm: async () => false }),
        io,
      });
      expect(code).toBe(1);
      expect(out).toContain(
        'These workspaces were taken down with `houston down`; their containers, kept data ' +
          'and records will be deleted for good (stopped ones are not touched):\n  - bob-t1\n',
      );
      expect(out).toContain('— their data (PersistentVolumeClaims) goes too:');
    } finally {
      jest.dontMock('../../src/core/lifecycle/pruning');
      jest.resetModules();
    }
  });

  test('says which namespaces it destroyed, rather than "Nothing to prune"', async () => {
    // `prune --orphans` deleted namespaces and their PersistentVolumeClaims and printed
    // "Nothing to prune.": the CLI rendered `removed` alone, so a sweep that removed no local
    // record -- the normal case for --orphans -- reported the irreversible half as the no-op
    // half. The prompt named them, which is no help under `--yes`.
    jest.resetModules();
    jest.doMock('../../src/core/lifecycle/pruning', () => ({
      ...jest.requireActual<object>('../../src/core/lifecycle/pruning'),
      prunable: async () => [],
      orphanNamespaces: async () => ['houston-ghost'],
      prune: async () => ({ targets: [], removed: [], orphans: ['houston-ghost'], cluster: false }),
    }));
    try {
      const fresh = require('../../src/cli/app') as typeof AppNS;
      const { createExecutor: fresher } = require('../../src/cli/handlers') as typeof HandlersNS;
      let out = '';
      const io: CliIo = {
        writeOut: (value) => (out += value),
        writeErr: (value) => (out += value),
      };
      const code = await fresh.runCli(['prune', '--orphans', '--yes'], {
        execute: fresher(io),
        io,
      });
      expect(code).toBe(0);
      expect(out).toContain('houston-ghost');
      expect(out).not.toContain('Nothing to prune');
    } finally {
      jest.dontMock('../../src/core/lifecycle/pruning');
      jest.resetModules();
    }
  });
});

describe('a Compose-only command on a Kubernetes workspace', () => {
  test('refuses in one line with exit 2 and names the alternative, never a stack', async () => {
    // Found by running the command: the guard escaped a handler that had no ReproError
    // branch, so the user got a stack trace and the one exit code the README defines as "a
    // bug in houston", for a condition that is entirely expected.
    await writeRecord(
      'k',
      metadata({ name: 'k', project: 'p', rcVersion: '8.6.1', extra: { runtime: 'kubernetes' } }),
    );
    jest.resetModules();
    const fresh = require('../../src/cli/app') as typeof AppNS;
    const { createExecutor: fresher } = require('../../src/cli/handlers') as typeof HandlersNS;
    let out = '';
    const io: CliIo = {
      writeOut: (value) => (out += value),
      writeErr: (value) => (out += value),
    };
    const code = await fresh.runCli(['env', '--name', 'k', '--set', 'A=b'], {
      execute: fresher(io),
      io,
    });
    expect(code).toBe(2);
    // The alternative is stated to the user...
    expect(out).toContain('helm');
    // ...and nothing escaped as a stack.
    expect(out).not.toMatch(/\n\s+at /u);
    expect(out.trim().split('\n')).toHaveLength(1);
  });
});

describe('env with a variable named after an Object.prototype accessor', () => {
  test('--set __proto__=x is written and recorded, not turned into a read', async () => {
    // Earlier releases decide on the TYPED lists and build a mapping from `--set`, so every
    // name the env rule accepts is written, whatever it is called. Here the parser assigned
    // into a plain object, `__proto__` hit `Object.prototype`'s accessor and vanished, and
    // the handler -- deciding on the parsed keys -- printed the read panel and exited 0 with
    // nothing written.
    await write(
      'alpha',
      'services:\n  rocketchat:\n    environment:\n      FOO: bar\n',
      metadata({
        name: 'alpha',
        project: 'houston-alpha',
        rcVersion: '8.5.1',
        rootUrl: 'http://127.0.0.1:1',
        extra: { runtime: 'docker', env: { FOO: 'bar' } },
      }),
    );
    jest.resetModules();
    // Not serving, so the bare-setting check is skipped without a request.
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      ...jest.requireActual<object>('../../src/core/lifecycle/admin'),
      login: async () => {
        throw new Error('not serving');
      },
    }));
    try {
      const fresh = require('../../src/cli/app') as typeof AppNS;
      const { createExecutor: fresher } = require('../../src/cli/handlers') as typeof HandlersNS;
      let out = '';
      const io: CliIo = {
        writeOut: (value) => (out += value),
        writeErr: (value) => (out += value),
      };
      const run = async (argv: string[]): Promise<number> =>
        await fresh.runCli(argv, { execute: fresher(io), io });
      expect(await run(['env', '--name', 'alpha', '--set', '__proto__=x', '--no-restart'])).toBe(0);
      expect(out).toContain("env updated on 'alpha': __proto__");
      expect(out).toContain('    __proto__ = x\n');
      expect(out).not.toContain('env: alpha');
      const home = workspace('alpha');
      const written = JSON.parse(fs.readFileSync(path.join(home, 'repro.json'), 'utf8')) as {
        extra: { env: object };
      };
      expect(Object.entries(written.extra.env)).toEqual([
        ['FOO', 'bar'],
        ['__proto__', 'x'],
      ]);
      expect(fs.readFileSync(path.join(home, 'docker-compose.yml'), 'utf8')).toContain(
        '      __proto__: x\n',
      );

      // The removal is recorded as one, not turned into a replaced prototype.
      out = '';
      expect(await run(['env', '--name', 'alpha', '--unset', '__proto__', '--no-restart'])).toBe(0);
      expect(out).toContain('    __proto__ = (removed)\n');
      const unset = JSON.parse(fs.readFileSync(path.join(home, 'repro.json'), 'utf8')) as {
        extra: { env: object };
      };
      expect(Object.entries(unset.extra.env)).toEqual([
        ['FOO', 'bar'],
        ['__proto__', null],
      ]);
      expect(fs.readFileSync(path.join(home, 'docker-compose.yml'), 'utf8')).not.toContain(
        '__proto__',
      );
    } finally {
      jest.dontMock('../../src/core/lifecycle/admin');
      jest.resetModules();
    }
  });
});

describe('config-import, before it reads the dump', () => {
  const EMPTY_PLAN = {
    apply: [],
    redacted: [],
    denied: [],
    oauth_services: [],
    counts: { apply: 0, redacted: 0, denied: 0 },
  };
  const NOTHING_APPLIED = { applied: 0, failed: 0, skipped: 0, failures: [] };

  /**
   * One run of the real handler, the service stubbed to say what it was handed and to answer
   * `plan` and `applied`. The apply reports a provider it created, as `configimport.apply`
   * logs one, so the output shows where the service's own lines fall.
   */
  async function importing(argv: string[], plan: object = EMPTY_PLAN, applied = NOTHING_APPLIED) {
    await writeRecord('ci', metadata({ name: 'ci', project: 'houston-ci' }));
    jest.resetModules();
    const calls: [string, string, string[] | null][] = [];
    const seen = (only: ReadonlySet<string> | null) => (only === null ? null : [...only].sort());
    jest.doMock('../../src/core/data', () => ({
      importPlan: async (_name: string, file: string, only: ReadonlySet<string> | null) => {
        calls.push(['plan', file, seen(only)]);
        return plan;
      },
      importApply: async (
        _name: string,
        file: string,
        only: ReadonlySet<string> | null,
        emit: (event: object) => void,
      ) => {
        calls.push(['apply', file, seen(only)]);
        const { info } = jest.requireActual<typeof EventsNS>('../../src/lib/events');
        info(emit, 'created custom OAuth provider: Keycloak', { phase: 'config' });
        return applied;
      },
    }));
    try {
      const fresh = require('../../src/cli/app') as typeof AppNS;
      const { createExecutor: fresher } = require('../../src/cli/handlers') as typeof HandlersNS;
      let out = '';
      let err = '';
      const io: CliIo = {
        writeOut: (value) => (out += value),
        writeErr: (value) => (err += value),
      };
      const code = await fresh.runCli(argv, { execute: fresher(io), io });
      return { code, out, err, calls };
    } finally {
      jest.dontMock('../../src/core/data');
      jest.resetModules();
    }
  }

  test('keeps an empty --only term, so a filter that matches nothing applies nothing', async () => {
    // Earlier releases split `--only` on commas and trim each term, keeping an empty one.
    // The handler dropped empty terms, so `--only ,` was an empty set -- which the plan reads
    // as NO filter -- and the whole dump was applied where earlier releases' `['']` applies
    // nothing.
    const dir = fs.mkdtempSync(path.join(process.env.HOUSTON_HOME ?? '/tmp', 'ci-only-'));
    const dump = path.join(dir, 'settings.json');
    fs.writeFileSync(dump, '[]');
    const terms = [',', ' ', 'LDAP,', ' LDAP , Site ', ',,', '\u001cLDAP', ''];
    const ours: unknown[] = [];
    for (const only of terms) {
      const run = await importing(['config-import', dump, '--name', 'ci', '--only', only]);
      expect(run.code).toBe(0);
      // The plan and the apply are handed the same filter.
      expect(run.calls.map(([step]) => step)).toEqual(['plan', 'apply']);
      expect(run.calls[1]?.[2]).toEqual(run.calls[0]?.[2]);
      ours.push(run.calls[0]?.[2]);
    }
    expect(ours[0]).toEqual(['']);
  });

  test('finds the file by the normalised spelling of the path, and refuses in the typed words', async () => {
    // Earlier releases test and read the NORMALISED path, which drops a trailing `/` and `.`
    // parts, so `settings.json/` is the file there and "no such file" here, where the stat
    // of the typed text failed with ENOTDIR.
    const dir = fs.mkdtempSync(path.join(process.env.HOUSTON_HOME ?? '/tmp', 'ci-path-'));
    fs.writeFileSync(path.join(dir, 'settings.json'), '[]');
    const typed = [
      `${dir}/settings.json/`,
      `${dir}/settings.json/.`,
      `${dir}//./settings.json`,
      `${dir}/settings.json`,
      `${dir}/missing.json/`,
      `${dir}/settings.json/x`,
      dir,
    ];
    const ours: unknown[] = [];
    for (const text of typed) {
      const run = await importing(['config-import', text, '--name', 'ci', '--dry-run']);
      if (run.code === 0) {
        ours.push(run.calls[0]?.[1]);
      } else {
        // Exit 4, a named thing that is not there, as `restore <missing bundle>` (L7-07).
        expect([run.code, run.err]).toEqual([4, `error: no such file: ${text}\n`]);
        expect(run.calls).toEqual([]);
        ours.push(null);
      }
    }
    expect(ours[0]).toBe(`${dir}/settings.json`);
  });

  test('draws the plan as config_import does, before an apply too, and says what was refused', async () => {
    // `config_import` echoes a blank line and a width-64 box with an oauth row, warns which
    // redacted secrets to set by hand, and -- on an apply -- draws all that BEFORE applying,
    // then names the first ten refused ids and the restart. This drew a content-width panel
    // of its own words for the dry run only, never the redacted line, and after an apply
    // only "⚠ 12 setting(s) rejected"; and it padded an astral id by UTF-16 units.
    const dir = fs.mkdtempSync(path.join(process.env.HOUSTON_HOME ?? '/tmp', 'ci-render-'));
    const dump = path.join(dir, 'settings.json');
    fs.writeFileSync(dump, '[]');
    const full = {
      apply: [
        { id: 'Accounts_OAuth_Custom-Keycloak', value: 'True' },
        { id: 'Site_Name', value: "'Acme'" },
        { id: '\u{1f600}_Emoji', value: '5.0' },
      ],
      redacted: ['LDAP_Authentication_Password', 'SMTP_Password'],
      denied: ['Site_Url'],
      oauth_services: ['Keycloak', 'Ms_entra_id'],
      counts: { apply: 3, redacted: 2, denied: 1 },
    };
    const ids = Array.from({ length: 12 }, (_, i) => `Setting_${String(i + 1)}`);
    const CASES: [boolean, object, object][] = [
      [true, full, NOTHING_APPLIED],
      [true, EMPTY_PLAN, NOTHING_APPLIED],
      [false, full, { applied: 1, failed: 12, skipped: 3, failures: ids }],
      [false, full, { applied: 5, failed: 5, skipped: 3, failures: ids.slice(0, 5) }],
      [false, EMPTY_PLAN, NOTHING_APPLIED],
    ];
    const ours: string[] = [];
    for (const [dry, plan, applied] of CASES) {
      const argv = ['config-import', dump, '--name', 'ci', ...(dry ? ['--dry-run'] : [])];
      const run = await importing(argv, plan, applied as typeof NOTHING_APPLIED);
      expect([run.code, run.err]).toEqual([0, '']);
      ours.push(run.out);
    }
    expect(ours[2]).toMatch(
      /^\n\+- config import -+\+\n[^]*\n {2}set these by hand[^]*\n {2}created custom OAuth[^]*Setting_10 \.\.\.\n/u,
    );
  });
});

describe('up --license', () => {
  it('reads a FILE, and refuses one it cannot read by naming the path, before any create', async () => {
    const missing = path.join(workspace('nowhere'), 'licence.txt');
    const got = await real(['up', '--version', '8.5.1', '--license', missing]);
    expect(got.code).toBe(2);
    expect(got.stderr).toContain(`--license '${missing}' could not be read`);
    expect(fs.existsSync(workspace('rc8-5-1'))).toBe(false);
  });
});

describe('--preset, more than once', () => {
  /** Fresh modules: an earlier case resets the registry, and a stale `ReproError` reads as a crash. */
  async function fresh(argv: string[]): Promise<{ code: number; stderr: string }> {
    jest.resetModules();
    const app = require('../../src/cli/app') as typeof AppNS;
    const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
    let stderr = '';
    const io: CliIo = { writeOut: () => undefined, writeErr: (value) => (stderr += value) };
    return { code: await app.runCli(argv, { execute: handlers.createExecutor(io), io }), stderr };
  }

  it('composes, and refuses saml + oidc naming both, before any create', async () => {
    const got = await fresh([
      'up',
      '--version',
      '8.5.1',
      '--offline',
      '--preset',
      'saml',
      '--preset',
      'oidc',
    ]);
    expect(got.code).toBe(2);
    expect(got.stderr).toContain("'oidc' and 'saml'");
  });

  it('asks which preset a shared --set key belongs to', async () => {
    const got = await fresh([
      'up',
      '--version',
      '8.5.1',
      '--offline',
      '--preset',
      'ldap',
      '--preset',
      'saml',
      '--set',
      'users=3',
    ]);
    expect(got.code).toBe(2);
    expect(got.stderr).toContain('--set ldap.users=... or --set saml.users=...');
  });
});

describe('config acme.challenge', () => {
  test('is listed in the help and refuses a value the edge would ignore', async () => {
    // Missing from the help's key list, and `config set acme.challenge bogus` was stored and
    // silently did nothing: the edge reads only http, tlsalpn and dns.
    const help = await real(['config', '--help']);
    expect(help.stdout).toContain('acme.challenge');
    const bogus = await real(['config', 'set', 'acme.challenge', 'bogus']);
    // A bad value is a usage error, exit 2 (L7-07); it was a plain exit 1.
    expect(bogus.code).toBe(2);
    expect(bogus.stderr).toContain('acme.challenge takes http, tlsalpn or dns');
    expect(loadConfig().acme_challenge).toBeUndefined();
    expect((await real(['config', 'set', 'acme.challenge', 'http'])).code).toBe(0);
  });
});

describe('up --seed --stats --json', () => {
  test("carries the seed's CPU and memory in the envelope", async () => {
    // The sampler ran, its report was printed in prose and dropped under --json: a script
    // got durations and readback, and none of the numbers --stats was asked for.
    jest.resetModules();
    await writeRecord('sd1', metadata({ name: 'sd1', project: 'houston-sd1', rcVersion: '8.5.1' }));
    const report = {
      rocketchat: {
        idle_cpu: 1,
        peak_cpu: 90,
        idle_mem: 3e8,
        peak_mem: 6e8,
        limit_mem: 0,
        peak_cpu_t: 2,
      },
    };
    jest.doMock('../../src/core/lifecycle/create-docker', () => ({
      ...jest.requireActual('../../src/core/lifecycle/create-docker'),
      createRepro: async () => ({ name: 'sd1' }),
    }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      ...jest.requireActual('../../src/core/lifecycle/admin'),
      login: async () => ({ token: 't', userId: 'u' }),
    }));
    jest.doMock('../../src/seed/apply', () => ({
      ...jest.requireActual('../../src/seed/apply'),
      seed: async () => ({ users: 1, channels: 1 }),
    }));
    jest.doMock('../../src/core/lifecycle/seeding', () => ({
      ...jest.requireActual('../../src/core/lifecycle/seeding'),
      checkSeed: async () => ({ ok: true, faults: [] }),
    }));
    jest.doMock('../../src/perf/resources', () => ({
      ...jest.requireActual('../../src/perf/resources'),
      ResourceMonitor: class {
        start() {
          return this;
        }
        async stop() {
          return report;
        }
      },
    }));
    const app = require('../../src/cli/app') as typeof AppNS;
    const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
    let stdout = '';
    const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    const io: CliIo = { writeOut: (v) => void (stdout += v), writeErr: () => undefined };
    try {
      const code = await app.runCli(
        ['up', '--version', '8.5.1', '--name', 'sd1', '--seed', '--stats', '--json'],
        { execute: handlers.createExecutor(io), io },
      );
      expect(code).toBe(0);
    } finally {
      write.mockRestore();
      for (const id of [
        '../../src/core/lifecycle/create-docker',
        '../../src/core/lifecycle/admin',
        '../../src/seed/apply',
        '../../src/core/lifecycle/seeding',
        '../../src/perf/resources',
      ])
        jest.dontMock(id);
    }
    const envelope = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as {
      data: { seed: { resources?: unknown } };
    };
    expect(envelope.data.seed.resources).toEqual(report);
  });
});

describe('upgrade --dry-run to a CI build', () => {
  test('shows the image as it is pulled, never repo:tag:version', async () => {
    // The plan table's image line went through imageRef with the build's own tag; only
    // `versions` had a test, so this line could regress to `...:develop:8.10.0` unseen.
    jest.resetModules();
    jest.doMock('../../src/core/upgrade', () => ({
      ...jest.requireActual('../../src/core/upgrade'),
      plan: async () => ({
        name: 'w',
        from_version: '8.5.1',
        to_version: '8.10.0',
        rc_image: 'ghcr.io/rocketchat/rocket.chat:develop',
        from_mongo: '8.0',
        to_mongo: '8.0',
        mongo_blocked: '',
        direction: 'upgrade',
        allowed: true,
        blocked_reason: '',
        warnings: [],
        oplog: false,
        source: 'ci build',
      }),
    }));
    const app = require('../../src/cli/app') as typeof AppNS;
    const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
    let stdout = '';
    const io: CliIo = { writeOut: (v) => void (stdout += v), writeErr: () => undefined };
    try {
      await app.runCli(['upgrade', '--name', 'w', '--to', 'develop', '--dry-run'], {
        execute: handlers.createExecutor(io),
        io,
      });
    } finally {
      jest.dontMock('../../src/core/upgrade');
    }
    expect(stdout).toContain('ghcr.io/rocketchat/rocket.chat:develop');
    expect(stdout).not.toContain('develop:8.10.0');
  });
});

describe('a usage mistake is exit 2 whichever command it is typed to (L7-07)', () => {
  // `up --set users=abc` was 2 and `up --set users` 1; `config-import bad.json` 2 and `api -d
  // '{not json'` 1; `cluster frob` 2 and `config frob x` 1. One kind of mistake, one code.
  afterEach(() => {
    jest.dontMock('../../src/core/lifecycle/admin');
    jest.resetModules();
  });

  /** argv through fresh modules, so a `doMock` reaches the lazily-required handler. */
  async function fresh(argv: string[]): Promise<{ code: number; err: string }> {
    const app = require('../../src/cli/app') as typeof AppNS;
    const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
    let err = '';
    const io: CliIo = { writeOut: () => undefined, writeErr: (v) => void (err += v) };
    return { code: await app.runCli(argv, { execute: handlers.createExecutor(io), io }), err };
  }

  /** A workspace on record whose admin login answers, so a command reaches its own checks. */
  async function signedIn(): Promise<void> {
    jest.resetModules();
    await writeRecord('sample', metadata({ name: 'sample', project: 'houston-sample' }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      ...jest.requireActual<object>('../../src/core/lifecycle/admin'),
      login: jest.fn(async () => ({ token: 'token', userId: 'admin' })),
    }));
  }

  test.each([
    [['up', '--version', '8.5.1', '--set', 'users'], '--set expects KEY=VALUE'],
    [['config', 'frob', 'acme.staging'], "unknown action 'frob'"],
    // The action first: this answered "unknown key 'x'" about a mistake that was `frob`.
    [['config', 'frob', 'x'], "unknown action 'frob'"],
    [['config', 'set', 'gui.create_policy', 'nobody'], 'gui.create_policy takes'],
  ])('%j', async (argv, message) => {
    jest.resetModules();
    const ran = await fresh(argv);
    expect(ran).toEqual({ code: 2, err: expect.stringContaining(message) as string });
  });

  test("api -d '{not json' is 2, as config-import of a file that is not JSON", async () => {
    await signedIn();
    const ran = await fresh(['api', 'POST', '/x', '--name', 'sample', '-d', '{not json']);
    expect(ran).toEqual({
      code: 2,
      err: expect.stringContaining('--data is not valid JSON') as string,
    });
  });

  test('seed --profile huge is 2, as the GUI seed refuses it', async () => {
    await signedIn();
    const ran = await fresh(['seed', '--name', 'sample', '--profile', 'huge']);
    expect(ran).toEqual({
      code: 2,
      err: expect.stringContaining("unknown seed profile 'huge'") as string,
    });
  });
});

describe('Okta sign-in from the terminal', () => {
  const home = (): string => process.env.HOUSTON_HOME ?? '';

  /** `real`, on this registry: an earlier test resets modules, and `core/sso` loads lazily,
   * so its refusals must be the same `ReproError` class the CLI it runs under checks for. */
  async function fresh(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    jest.resetModules();
    const app = require('../../src/cli/app') as typeof AppNS;
    const handlers = require('../../src/cli/handlers') as typeof HandlersNS;
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
      return {
        code: await app.runCli(argv, { execute: handlers.createExecutor(io), io }),
        stdout,
        stderr,
      };
    } finally {
      write.mockRestore();
    }
  }
  afterEach(() => {
    for (const file of ['users', 'sso-identities.json', 'config.yaml']) {
      fs.rmSync(path.join(home(), file), { force: true });
    }
  });

  test('config refuses a bad value, and the issuer until it is the last thing missing', async () => {
    const bad = await fresh(['config', 'set', 'sso.provision', 'admin']);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('sso.provision takes off, member, readonly -- never admin');
    const early = await fresh(['config', 'set', 'sso.issuer', 'https://login.example.com']);
    expect(early.code).toBe(2);
    expect(early.stderr).toContain(
      'set sso.client_id, sso.public_url, sso.email_domains first: setting sso.issuer is what turns Okta sign-in on',
    );
    for (const [key, value] of [
      ['sso.client_id', '0oa-client'],
      ['sso.public_url', 'https://houston.example.com/'],
      ['sso.email_domains', 'Example.com'],
      ['sso.issuer', 'https://login.example.com'],
    ]) {
      expect((await fresh(['config', 'set', key as string, value as string])).code).toBe(0);
    }
    expect(loadConfig()).toMatchObject({
      'sso.public_url': 'https://houston.example.com',
      'sso.email_domains': 'example.com',
      'sso.issuer': 'https://login.example.com',
    });
    expect((await fresh(['config', '--help'])).stdout).toContain('sso.provision');
  });

  test('users link-sso approves an exact name, list shows the link, unlink-sso ends it', async () => {
    expect((await fresh(['users', 'add', 'ana-lopez', 'admin'])).code).toBe(0);
    const link = await fresh(['users', 'link-sso', 'Ana.Lopez']);
    expect(link.code).toBe(0);
    expect(link.stdout).toContain(
      "✓ the Okta user whose username is 'ana-lopez' may now sign in as it.",
    );
    fs.writeFileSync(
      path.join(home(), 'sso-identities.json'),
      JSON.stringify({
        version: 1,
        bindings: [
          {
            issuer: 'https://login.example.com',
            sub: '00u-ana',
            name: 'ana-lopez',
            email: 'ana.lopez@example.com',
            display: 'ana.lopez',
            status: 'active',
            at: '2026-10-13T00:00:00.000Z',
          },
        ],
        approvals: [],
      }),
    );
    expect((await fresh(['users', 'list'])).stdout).toMatch(
      /ana-lopez +\d{4}-\d\d-\d\d {2}\[admin\] {2}okta ana\.lopez@example\.com/u,
    );
    const unlink = await fresh(['users', 'unlink-sso', 'ana-lopez']);
    expect(unlink.code).toBe(0);
    expect(unlink.stdout).toContain('to allow it again: houston users link-sso ana-lopez');
    expect((await fresh(['users', 'list'])).stdout).not.toContain('okta');
    expect((await fresh(['users', 'unlink-sso', 'ana-lopez'])).code).toBe(4);
    expect((await fresh(['users', 'link-sso', 'nobody'])).code).toBe(4);
  });
});
