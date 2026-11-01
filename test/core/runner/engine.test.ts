import * as seam from '../../../src/seams/docker-cli';
import { SpawnFailure } from '../../../src/seams/exec';

import * as engine from '../../../src/core/runner/engine';
import { workspace } from '../../../src/core/runner/paths';

jest.mock('../../../src/seams/docker-cli', () => ({
  compose: jest.fn(),
  composeStream: jest.fn(),
  composeToFile: jest.fn(),
  composeFromFile: jest.fn(),
  invalidateQueries: jest.fn(),
  docker: jest.fn(),
  STALE_UNIT: jest.requireActual('../../../src/seams/docker-cli').STALE_UNIT,
}));

const composeMock = seam.compose as jest.MockedFunction<typeof seam.compose>;
const dockerMock = seam.docker as jest.MockedFunction<typeof seam.docker>;
const invalidateMock = seam.invalidateQueries as jest.MockedFunction<typeof seam.invalidateQueries>;

function answer(overrides: Partial<Awaited<ReturnType<typeof seam.compose>>> = {}) {
  return {
    argv: ['docker', 'compose'],
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

beforeEach(() => {
  composeMock.mockResolvedValue(answer());
});

describe('a compose command for one workspace', () => {
  it('runs in that workspace, and nowhere else', async () => {
    await engine.compose('TICKET-1', ['ps'], { capture: true });
    expect(composeMock).toHaveBeenCalledWith(['ps'], {
      capture: true,
      cwd: workspace('TICKET-1'),
    });
  });

  it('pulls before up, and a failed pull does not stop the up', async () => {
    composeMock.mockResolvedValueOnce(answer({ exitCode: 1 })); // the pull
    expect(await engine.up('TICKET-1')).toBe(0);
    expect(composeMock.mock.calls.map((call) => call[0])).toEqual([
      ['pull'],
      ['up', '-d', '--remove-orphans'],
    ]);
  });

  it('recreates ONE service without taking its database down', async () => {
    await engine.up('TICKET-1', { pull: false, forceRecreate: 'rocketchat' });
    expect(composeMock.mock.calls[0]?.[0]).toEqual([
      'up',
      '-d',
      '--remove-orphans',
      '--force-recreate',
      '--no-deps',
      'rocketchat',
    ]);
  });
});

// `State.Error` as Docker recorded it on a production box, every time a stopped workspace started.
const STALE =
  'failed to create task for container: failed to create shim task: OCI runtime create failed: ' +
  'runc create failed: unable to start container process: unable to apply cgroup configuration: ' +
  'unable to start unit "docker-2cbc.scope" (properties [{Name:Slice Value:"system.slice"}]): ' +
  'Unit docker-2cbc.scope was already loaded or has a fragment file.';

/** Every start fails until compose is asked to recreate; containers report `stateError`. */
function staleWorld(stateError: string): void {
  composeMock.mockImplementation(async (args) => {
    if (args[0] === 'ps') return answer({ stdout: 'c1\nc2\n' });
    if (args.includes('--force-recreate')) return answer();
    return answer({ exitCode: 1 });
  });
  dockerMock.mockResolvedValue(answer({ stdout: `\n${stateError}\n` }));
}

describe('a start systemd refuses because the last run left its unit loaded', () => {
  it.each([
    ['start', () => engine.start('x'), ['start']],
    ['restart', () => engine.restart('x'), ['restart']],
    ['up', () => engine.up('x', { pull: false }), ['up', '-d', '--remove-orphans']],
  ])('%s recreates the containers, data kept, and succeeds', async (_name, run, first) => {
    staleWorld(STALE);
    expect(await run()).toBe(0);
    expect(composeMock.mock.calls.map((call) => call[0])).toEqual([
      first,
      ['ps', '--all', '-q'],
      ['up', '-d', '--force-recreate', '--remove-orphans'],
    ]);
    expect(dockerMock.mock.calls[0]?.[0]).toEqual([
      'inspect',
      '--format',
      '{{.State.Error}}',
      'c1',
      'c2',
    ]);
  });

  it('recreates on the error production printed, whole property list and all', async () => {
    // Verbatim from `start` on an email workspace on 2.1.1, mailpit's line.
    staleWorld(
      'failed to create task for container: failed to create shim task: OCI runtime create ' +
        'failed: runc create failed: unable to start container process: unable to apply cgroup ' +
        'configuration: unable to start unit "docker-2cbcc01802f3c840a7e45c843038b24e7a9e133de' +
        '5540d2e115ee38778985d71.scope" (properties [{Name:Description Value:"libcontainer ' +
        'container 2cbcc01802f3c840a7e45c843038b24e7a9e133de5540d2e115ee38778985d71"} ' +
        '{Name:Slice Value:"system.slice"} {Name:Delegate Value:true} {Name:PIDs Value:@au ' +
        '[3002698]} {Name:MemoryAccounting Value:true} {Name:CPUAccounting Value:true} ' +
        '{Name:IOAccounting Value:true} {Name:TasksAccounting Value:true} ' +
        '{Name:DefaultDependencies Value:false}]): Unit docker-2cbcc01802f3c840a7e45c843038b24' +
        'e7a9e133de5540d2e115ee38778985d71.scope was already loaded or has a fragment file.',
    );
    expect(await engine.start('x')).toBe(0);
    expect(composeMock.mock.calls.at(-1)?.[0]).toEqual([
      'up',
      '-d',
      '--force-recreate',
      '--remove-orphans',
    ]);
  });

  it('a backup restarting Rocket.Chat recreates only Rocket.Chat', async () => {
    staleWorld(STALE);
    expect(await engine.startServices('x', ['rocketchat'])).toBe(0);
    expect(composeMock.mock.calls.map((call) => call[0])).toEqual([
      ['start', 'rocketchat'],
      ['ps', '--all', '-q', 'rocketchat'],
      ['up', '-d', '--force-recreate', '--no-deps', 'rocketchat'],
    ]);
  });

  it('an env apply that recreates Rocket.Chat recreates only Rocket.Chat again, never Mongo', async () => {
    let ups = 0;
    composeMock.mockImplementation(async (args) => {
      if (args[0] === 'ps') return answer({ stdout: 'c1\n' });
      return answer({ exitCode: args[0] === 'up' && ups++ === 0 ? 1 : 0 });
    });
    dockerMock.mockResolvedValue(answer({ stdout: `${STALE}\n` }));
    expect(await engine.up('x', { pull: false, forceRecreate: 'rocketchat' })).toBe(0);
    expect(composeMock.mock.calls.map((call) => call[0]).slice(1)).toEqual([
      ['ps', '--all', '-q', 'rocketchat'],
      ['up', '-d', '--force-recreate', '--no-deps', 'rocketchat'],
    ]);
  });

  it.each([
    ['a held port', 'Bind for 127.0.0.1:3000 failed: port is already allocated'],
    // Each container's State.Error is one line: a `.scope` in one and "already exists" in
    // another are two unrelated failures, not this one.
    [
      'two unrelated errors',
      'cgroup docker-c1.scope is busy\nendpoint with name x already exists in network y',
    ],
  ])('any other failed start (%s) is left to its caller, recreating nothing', async (_n, error) => {
    staleWorld(error);
    expect(await engine.start('x')).toBe(1);
    expect(composeMock.mock.calls.some((call) => call[0].includes('--force-recreate'))).toBe(false);
  });
});

describe('the memo and the mutations', () => {
  it.each([
    ['up', () => engine.up('x', { pull: false })],
    ['down', () => engine.down('x')],
    ['start', () => engine.start('x')],
    ['stop', () => engine.stop('x')],
    ['restart', () => engine.restart('x')],
  ])('drops the memoised docker state after %s', async (_name, run) => {
    await run();
    expect(invalidateMock).toHaveBeenCalled();
  });

  it('drops it even when the command fails, so the UI is not left stale', async () => {
    composeMock.mockRejectedValueOnce(new SpawnFailure(['docker'], new Error('boom')));
    await expect(engine.stop('x')).rejects.toBeInstanceOf(SpawnFailure);
    expect(invalidateMock).toHaveBeenCalled();
  });

  it('does not drop it for a read', async () => {
    await engine.ps('x');
    await engine.containerIds('x');
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});

describe('the error contracts, which differ on purpose', () => {
  it('propagates a launch failure from a mutating command', async () => {
    composeMock.mockRejectedValue(new SpawnFailure(['docker'], new Error('no docker')));
    await expect(engine.up('x', { pull: false })).rejects.toBeInstanceOf(SpawnFailure);
  });

  it('degrades a best-effort sampler to "no sample" instead', async () => {
    // `compose_exec_capture` returns (1, "") so a sampler thread is not stranded by a
    // wedged daemon. Turning that into a raise, or the raise above into a (1, ""),
    // would each hide a different thing.
    composeMock.mockRejectedValue(new SpawnFailure(['docker'], new Error('no docker')));
    expect(await engine.composeExecCapture('x', 'mongodb', ['mongosh'])).toEqual([1, '']);
  });

  it('reports an exec failure with its output when the command itself fails', async () => {
    composeMock.mockResolvedValue(answer({ exitCode: 3, stdout: 'partial' }));
    expect(await engine.composeExecCapture('x', 'mongodb', ['mongosh'])).toEqual([3, 'partial']);
  });
});

describe('reading a repro back', () => {
  it('returns no container ids rather than an empty string when the query fails', async () => {
    composeMock.mockResolvedValue(answer({ exitCode: 1, stdout: 'ignored' }));
    expect(await engine.serviceContainerIds('x', 'rocketchat')).toEqual([]);
  });

  it('splits ids on whitespace and drops the blanks', async () => {
    composeMock.mockResolvedValue(answer({ stdout: 'abc\ndef\n\n' }));
    expect(await engine.containerIds('x')).toEqual(['abc', 'def']);
    expect(await engine.serviceContainerIds('x', 'rocketchat')).toEqual(['abc', 'def']);
  });

  it('joins both streams for a post-mortem, because the reason may be on either', async () => {
    composeMock.mockResolvedValue(answer({ stdout: 'out', stderr: 'err' }));
    expect(await engine.composeLogsCapture('x')).toBe('outerr');
    expect(await engine.composePullCapture('x')).toBe('outerr');
    expect(composeMock.mock.calls[0]?.[0]).toEqual(['logs', '--no-color', '--tail', '200']);
  });

  it('stops only the services it was given, leaving Mongo up for a dump', async () => {
    await engine.stopServices('x', ['rocketchat-1', 'rocketchat-2']);
    expect(composeMock.mock.calls[0]?.[0]).toEqual(['stop', 'rocketchat-1', 'rocketchat-2']);
    await engine.rmServices('x', ['prometheus']);
    // Its containers' volumes are read first (`anonymousVolumes`), then it is removed.
    expect(composeMock.mock.calls[1]?.[0]).toEqual(['ps', '--all', '-q', 'prometheus']);
    expect(composeMock.mock.calls[2]?.[0]).toEqual(['rm', '-s', '-f', '-v', 'prometheus']);
  });

  it("takes the containers' anonymous volumes with them, and keeps the named ones unless asked", async () => {
    // An image's own VOLUMEs (MongoDB's /data/configdb, osixia's, Samba's) become anonymous
    // volumes. A container removed without -v leaves them behind, and the next one gets
    // fresh ones, so every `up --force` and plain `down` left a few more (measured: 5 and 6
    // empty volumes after two live runs). `rm -v` removes only anonymous volumes; the data
    // volume is named, so a plain `down` still keeps the data.
    await engine.down('x');
    expect(composeMock.mock.calls.map((call) => call[0])).toEqual([
      ['ps', '--all', '-q'],
      ['rm', '-s', '-f', '-v'],
      ['down', '--remove-orphans'],
    ]);
    composeMock.mockClear();
    await engine.down('x', { volumes: true });
    expect(composeMock.mock.calls.map((call) => call[0])).toEqual([
      ['ps', '--all', '-q'],
      ['down', '--remove-orphans', '-v'],
    ]);
  });

  it('removes an anonymous volume a recreated container mounted by name, never a named one', async () => {
    // After a recreate (`env --set`, an upgrade, `up --force`) compose mounts the old
    // container's anonymous volume into the new one BY NAME, and `rm -v` keeps any volume
    // mounted by name: Rocket.Chat's /app/uploads volume outlived `up --force`, a plain
    // `down` and even `down --volumes`.
    const hex = 'a'.repeat(64);
    composeMock.mockImplementation(async (argv) =>
      answer({ stdout: argv[0] === 'ps' ? 'c1\nc2\n' : '' }),
    );
    dockerMock.mockImplementation(async (argv) =>
      answer({ stdout: argv[0] === 'inspect' ? `houston-x_mongodb_data ${hex} \n${hex} \n` : '' }),
    );
    for (const volumes of [false, true]) {
      dockerMock.mockClear();
      await engine.down('x', { volumes });
      expect(dockerMock.mock.calls.map((call) => call[0])).toEqual([
        ['inspect', '--format', '{{range .Mounts}}{{.Name}} {{end}}', 'c1', 'c2'],
        ['volume', 'rm', hex],
      ]);
    }
  });
});

describe("the host ports in Docker's Ports text", () => {
  it('reads each one, a grouped range expanded', () => {
    // MinIO publishes 9000 and 9001 from one container, which Docker prints as one range: read
    // as nothing, a rebuild moved a running MinIO off its own ports (review 2026-10-31).
    expect(
      [
        ...engine.hostPortsIn(
          [
            '127.0.0.1:8025->8025/tcp',
            '127.0.0.1:9000-9001->9000-9001/tcp',
            '0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp',
            ':::8082->8080/tcp',
            '127.0.0.1:20000-20002->20000-20002/udp',
            '',
          ].join('\n'),
        ),
      ].sort((a, b) => a - b),
    ).toEqual([3000, 8025, 8082, 9000, 9001, 20000, 20001, 20002]);
  });
});
