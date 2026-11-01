import * as fs from 'node:fs';
import * as path from 'node:path';

import type * as EnvvarsNS from '../../src/core/envvars';
import type * as YamlNS from 'yaml';

interface Recorded {
  names: { parse: unknown[]; settings: unknown[]; names: unknown[]; prefix: string };
  strip: unknown;
  rows: { rows: unknown; drift: unknown; live_read: boolean; single: unknown };
  current: unknown;
  nosvc: string;
  runs: (Captured & { error: unknown })[];
  shapes: (Captured & { error: unknown })[];
  record: string;
}

interface Captured {
  result: unknown;
  doc: unknown;
  env: unknown;
  upArgs: unknown[];
  up?: unknown;
  events: Seen[];
}

/**
 * What earlier releases answered for the cases below, recorded: every parse, prefix and
 * refusal, the rows and drift, the read of a list-form document, the refusal of one with
 * no services, each `set_env` run, and the repro.json they wrote back.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'core', 'envvars.json'), 'utf8'),
) as Recorded;

interface Seen {
  message: string;
  level: string;
  phase: string;
}

describe('env var names and the setting prefix', () => {
  it('agrees with earlier releases on parsing, prefixing and every refusal', () => {
    // These strings reach both a compose file docker must accept and the messages a
    // person reads off a refused `env` call, so both the values and the prose are the
    // contract.
    const corpus = {
      parse: [
        ['A=1', 'B_2=x=y'],
        [],
        ['JUST_A_KEY'],
        ['2LEADING=1'],
        ['has-hyphen=1'],
        ['has space=1'],
        ['=1'],
        ['  PADDED  =v'],
        ['A='],
        // Every name the rule accepts is a mapping key, the ones `Object.prototype` already
        // has included: `__proto__` was swallowed by its accessor, so `env --set __proto__=x`
        // parsed to nothing and ran as a read.
        ['__proto__=x', 'constructor=c', 'toString=t', 'hasOwnProperty=h'],
      ],
      settings: [
        ['Message_AllowEditing=false'],
        ['A_B=x=y'],
        [],
        ['Message_AllowEditing'],
        ['OVERWRITE_SETTING_Message_AllowEditing=false'],
        ['OVERWRITE_SETTING_Already_Prefixed=1'],
        ['  Spaced_Id  =v'],
        ['__proto__=1'],
      ],
      names: [['has-hyphen'], ['ok_name'], ['2lead'], ['']],
    };
    const recorded = RECORDED.names;

    const run = (fn: () => unknown): unknown => {
      try {
        return { value: fn() ?? null };
      } catch (exc) {
        const error = exc as Error;
        return { kind: error.constructor.name, message: error.message };
      }
    };
    const { parseSet, asSetting, checkNames, SETTING_PREFIX } =
      require('../../src/core/envvars') as typeof EnvvarsNS;
    const transport = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
    expect(SETTING_PREFIX).toBe(recorded.prefix);
    expect(corpus.parse.map((pairs) => transport(run(() => parseSet(pairs))))).toEqual(
      recorded.parse,
    );
    expect(corpus.settings.map((pairs) => transport(run(() => asSetting(pairs))))).toEqual(
      recorded.settings,
    );
    expect(corpus.names.map((keys) => transport(run(() => checkNames(keys))))).toEqual(
      recorded.names,
    );
  });

  it('strips a key as earlier releases do, which is not what trim() does', () => {
    // Earlier releases strip \x1c-\x1f and NEL and keep a BOM; `trim()` is the reverse. So
    // `--set $'\x1fFOO=1'` was a refusal here and FOO there, and a BOM-led key was FOO
    // here and a refusal there -- at each of the three strips.
    const corpus = {
      parse: [['\x1fFOO=1'], ['\ufeffFOO=1'], ['\u0085FOO\x1c=1'], ['\u3000FOO=1']],
      settings: [['\x1eId=1'], ['\ufeffId=1']],
      prefix: [{ '\x1dId': '1' }, { '\ufeffId': '1' }, { 'OVERWRITE_SETTING_Id\u0085': '1' }],
      names: [['\x1fok'], ['\ufeffok'], ['ok\u0085']],
    };
    const run = (fn: () => unknown): unknown => {
      try {
        return JSON.parse(JSON.stringify({ value: fn() ?? null })) as unknown;
      } catch (exc) {
        const error = exc as Error;
        return { kind: error.constructor.name, message: error.message };
      }
    };
    const { parseSet, asSetting, prefixSettings, checkNames } =
      require('../../src/core/envvars') as typeof EnvvarsNS;
    expect({
      parse: corpus.parse.map((pairs) => run(() => parseSet(pairs))),
      settings: corpus.settings.map((pairs) => run(() => asSetting(pairs))),
      prefix: corpus.prefix.map((bag) => run(() => prefixSettings(bag))),
      names: corpus.names.map((keys) => run(() => checkNames(keys))),
    }).toEqual(RECORDED.strip);
  });

  it('warns about a bare setting id only when the workspace answers and knows it', async () => {
    jest.resetModules();
    const seen: Seen[] = [];
    const emit = (event: Seen): void => {
      seen.push(event);
    };
    const loginCalls: number[] = [];
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      login: async () => {
        loginCalls.push(1);
        return { token: 't', userId: 'u' };
      },
    }));
    let known: Set<string> | null = new Set(['Message_AllowEditing']);
    jest.doMock('../../src/core/rcapi', () => ({
      settingIds: async () => known,
    }));
    const envvars = require('../../src/core/envvars') as typeof EnvvarsNS;
    const meta = {
      name: 'e',
      rootUrl: 'http://x',
      adminPassword: '',
      extra: {},
    } as never;

    await envvars.warnBareSettings(meta, ['Message_AllowEditing', 'MY_OWN_VAR'], emit as never);
    expect(seen.map((e) => e.message).join(' ')).toContain(
      'Message_AllowEditing is a Rocket.Chat SETTING',
    );
    expect(seen.map((e) => e.message).join(' ')).toContain(
      'OVERWRITE_SETTING_Message_AllowEditing',
    );
    expect(seen.map((e) => e.message).join(' ')).not.toContain('MY_OWN_VAR');

    // Already prefixed -> nothing to say, and no API call needed.
    seen.length = 0;
    const callsBefore = loginCalls.length;
    await envvars.warnBareSettings(meta, ['OVERWRITE_SETTING_X=1'], emit as never);
    expect(seen).toEqual([]);
    expect(loginCalls.length).toBe(callsBefore);

    // Workspace unreachable -> silent, never fatal.
    seen.length = 0;
    known = null;
    await envvars.warnBareSettings(meta, ['Message_AllowEditing'], emit as never);
    expect(seen).toEqual([]);
  });
});

describe('what the workspace records versus what it is running', () => {
  it('matches earlier releases on rows, drift and the unreadable-container case', async () => {
    // The rows are the whole answer to "is this setting actually set?": the container is
    // the authority, the compose document is what it was ASKED to run, and a key in one
    // and not the other is reported as drift rather than folded into the value.
    const env = {
      PORT: '3000',
      KEEP: '1',
      EMPTY: '',
      GONE: 'x',
      // `in` walks the prototype chain, so these two were reported as overrides the
      // document never recorded. The records earlier releases read have no prototype;
      // `Object.hasOwn` is the faithful test.
      constructor: 'c',
      toString: 't',
    };
    const overrides = { KEEP: '1', EXTRA: null };
    const live: Record<string, string> | null = {
      PORT: '3000',
      KEEP: 'changed',
      EMPTY: '',
      EXTRA: 'added',
      constructor: 'c',
      toString: 't',
    };
    const recorded = RECORDED.rows;
    const { envRows } = require('../../src/core/envvars') as typeof EnvvarsNS;
    const mine = envRows(env, overrides, live);
    expect(mine.rows).toEqual(recorded.rows);
    expect(mine.drift).toEqual(recorded.drift);
    expect(mine.live !== null).toBe(recorded.live_read);

    const unreadable = envRows(env, overrides, null);
    expect(unreadable.rows).toEqual(recorded.single);
    expect(unreadable.drift).toEqual([]);
    expect(unreadable.live).toBeNull();
  });
});

describe('reading what a workspace is running', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('sees a LIST-form compose environment, as earlier releases do', async () => {
    // compose accepts `environment: ["K=V", ...]`, and the read path converts it. A
    // `bagOf`-shaped port answered `{}` for such a document, so `houston env` showed no
    // variables at all for a workspace docker was running perfectly well.
    jest.resetModules();
    const record = require('../../src/core/runner/record') as {
      metadata: (values: object) => object;
      write: (name: string, yaml: string, meta: object) => Promise<void>;
    };
    const compose = require('../../src/lib/compose') as { toYaml: (doc: unknown) => string };
    const doc = {
      services: {
        rocketchat: { environment: ['PORT=3000', 'KEEP=1', 'BLANK=old'] },
      },
      volumes: {},
    };
    await record.write(
      's',
      compose.toYaml(doc),
      record.metadata({
        name: 's',
        project: 'houston-s',
        rootUrl: 'http://127.0.0.1:1',
        hostPort: 3000,
        extra: { env: { KEEP: null, MY: 'v' } },
      }),
    );
    jest.doMock('../../src/core/runner/queries', () => ({
      ...jest.requireActual('../../src/core/runner/queries'),
      rcContainerEnv: async () => ({ PORT: '3000' }),
    }));
    jest.doMock('../../src/core/topology', () => ({
      ...jest.requireActual('../../src/core/topology'),
      ofRepro: async () => 'docker',
    }));
    const envvars = require('../../src/core/envvars') as typeof EnvvarsNS;
    const { removed, ...mine } = await envvars.current('s');
    expect(mine).toEqual(RECORDED.current);
    // The removal is named as one, so a reader can leave it out of "your overrides" (F1).
    expect(removed).toEqual(['KEEP']);
    expect((mine.env as { key: string }[]).map((row) => row.key)).toEqual([
      'BLANK',
      'KEEP',
      'PORT',
    ]);
    // The override that is NOT in the document is reported as an override, not as a row;
    // the two document keys the container does not have are reported as drift.
    expect(mine.overrides).toEqual(['KEEP', 'MY']);
    expect(mine.drift).toEqual(['BLANK', 'KEEP']);
    expect(mine.live_read).toBe(true);
  });
});

describe('a compose document with no services key', () => {
  it('refuses inside the error contract, as earlier releases do', async () => {
    // Earlier releases read a MISSING services key as empty and reach the DockerError.
    // `Object.keys(undefined)` was a raw TypeError escaping the taxonomy.
    const record = require('../../src/core/runner/record') as {
      metadata: (values: object) => object;
      write: (name: string, yaml: string, meta: object) => Promise<void>;
    };
    const compose = require('../../src/lib/compose') as { toYaml: (doc: unknown) => string };
    await record.write(
      'nosvc',
      compose.toYaml({ volumes: {} }),
      record.metadata({ name: 'nosvc', project: 'houston-nosvc' }),
    );
    const recorded = RECORDED.nosvc;

    jest.resetModules();
    const { applyToCompose } = require('../../src/core/envvars') as typeof EnvvarsNS;
    let mine: string;
    try {
      await applyToCompose({ A: '1' }, 'nosvc');
      mine = 'NO-ERROR';
    } catch (exc) {
      mine = `${(exc as Error).constructor.name}: ${(exc as Error).message}`;
    }
    expect(mine).toBe(recorded);
    expect(mine).toContain('DockerError');
  });
});

describe('applying an env change', () => {
  afterEach(() => {
    jest.resetModules();
  });

  /**
   * What earlier releases did for each case is recorded, with the same behaviours stubbed
   * as the mocks below.
   *
   * A null override is the one thing this path exists to get right: it REMOVES a key
   * from every Rocket.Chat service and is recorded as null so `up --force` keeps the
   * removal. An empty string is not a removal, and the clean compose document earlier
   * releases round-trip is what this build is held to.
   */

  async function typescriptRun(
    caseData: Record<string, unknown>,
  ): Promise<Captured & { error: unknown; order: string[] }> {
    jest.resetModules();
    const captured: Record<string, unknown> = {};
    const events: Seen[] = [];
    // The recreate, the wait for Rocket.Chat and the events, in the order they happened.
    const order: string[] = [];
    // Through JSON, so a case's own document keeps a `__proto__` key as an own one -- as the
    // YAML reader makes it -- and is not mutated for the next run.
    const doc =
      caseData.doc === undefined
        ? {
            services: {
              rocketchat: { environment: { PORT: '3000', KEEP: '1', BLANK: 'old' } },
              'rocketchat-2': { environment: ['PORT=3000', 'KEEP=1', 'BLANK=old'] },
            },
            volumes: {},
          }
        : (JSON.parse(JSON.stringify(caseData.doc)) as unknown);
    const meta = {
      name: 'e',
      project: 'houston-e',
      rcVersion: '8.6.1',
      rcImage: 'i',
      mongoTag: '8.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3000',
      hostPort: 3000,
      versionSource: 'map',
      extra:
        'extra' in caseData
          ? caseData.extra
          : caseData.existingEnv == null
            ? {}
            : { env: caseData.existingEnv },
    };
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => meta,
      readCompose: async () => doc,
      write: async (_n: string, y: string, m: unknown) => {
        captured['y'] = y;
        captured['meta'] = m;
      },
    }));
    jest.doMock('../../src/core/runner/locks', () => ({
      ...jest.requireActual('../../src/core/runner/locks'),
      reproLock: async (_n: string, body: () => Promise<unknown>) => await body(),
    }));
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../src/core/runner/engine'),
      up: async (n: string, options: { pull?: boolean; forceRecreate?: string }) => {
        captured['up'] = [n, options.pull, options.forceRecreate];
        order.push('up');
        return 0;
      },
    }));
    jest.doMock('../../src/core/lifecycle/ready', () => ({
      waitServing: async (waited: { name: string }) => {
        order.push(`wait ${waited.name}`);
        return {};
      },
    }));
    jest.doMock('../../src/core/lifecycle/naming', () => ({ resolveName: async (n: string) => n }));
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      requireDocker: async () => undefined,
    }));
    jest.doMock('../../src/core/topology', () => ({ requireCompose: async () => undefined }));
    jest.doMock('../../src/core/rcapi', () => ({ settingIds: async () => null }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      login: async () => {
        throw new Error('not logged in');
      },
    }));
    const envvars = require('../../src/core/envvars') as typeof EnvvarsNS;
    let result: unknown = null;
    let error: unknown = null;
    try {
      result = await envvars.setEnv(
        caseData.name as string,
        caseData.sets as Record<string, string>,
        caseData.unset as string[],
        {
          restart: caseData.restart as boolean,
          emit: ((event: Seen) => {
            events.push({ message: event.message, level: event.level, phase: event.phase });
            order.push(`event ${event.message}`);
          }) as never,
        },
      );
    } catch (exc) {
      // `.name`, which is what the CLI prints for an unhandled error: the bad-value error
      // earlier releases raised is a RangeError NAMED `InvalidValue` here.
      error = { kind: (exc as Error).name, message: (exc as Error).message };
    }
    const yaml = require('yaml') as typeof YamlNS;
    return {
      result,
      error,
      doc: captured['y'] === undefined ? null : yaml.parse(captured['y'] as string),
      // The record's env, read without assuming the record's `extra` is a mapping: one that
      // is not must be reported as whatever was written, not crash the harness.
      env:
        captured['meta'] === undefined
          ? null
          : ((captured['meta'] as { extra: { env?: unknown } | null }).extra?.env ?? null),
      upArgs: [],
      events,
      up: captured['up'] ?? null,
      order,
    } as Captured & { error: unknown; order: string[] };
  }

  const CASES: { name: string; data: Record<string, unknown> }[] = [
    {
      name: 'sets and removes, restarting',
      data: {
        name: 'e',
        sets: { MONGO_URL: 'mongodb://elsewhere', MY: 'v', BLANK: '' },
        unset: ['KEEP'],
        restart: true,
        existingEnv: null,
      },
    },
    {
      name: 'writes without restarting',
      data: { name: 'e', sets: { A: '1' }, unset: [], restart: false, existingEnv: null },
    },
    {
      name: 'a recorded removal stays a removal',
      data: {
        name: 'e',
        sets: { ADDED: 'x' },
        unset: [],
        restart: true,
        existingEnv: { KEEP: null, OLD: 'kept' },
      },
    },
    {
      // The load-bearing names are a set of their own. A plain property lookup reached
      // `Object.prototype`, so `constructor` was announced load-bearing with the function's
      // own source as the reason; earlier releases say nothing about it.
      name: 'a prototype-named key is not load-bearing',
      data: {
        name: 'e',
        sets: { constructor: 'x', MONGO_URL: 'y' },
        unset: [],
        restart: true,
        existingEnv: null,
      },
    },
    {
      // A recorded override that is not a string -- a hand-edited repro.json, or a
      // manifest `env_overrides` carrying a JSON number or bool -- reaches the document as
      // its text, `'8080'` / `'True'`, not as YAML's number/bool.
      name: 'a non-string recorded override is coerced to its text',
      data: {
        name: 'e',
        sets: { A: '1' },
        unset: [],
        restart: true,
        existingEnv: { NUM: 8080, FLAG: true },
      },
    },
    {
      // Earlier releases merge the overrides and apply them as plain mappings, where every
      // name the env rule accepts is a key. On a plain object `__proto__` is `Object.prototype`'s
      // accessor, and `Object.assign` and `env[key] = ...` both assigned through it: the set
      // was dropped from the record and from both services. Built through JSON, as a parsed
      // argv or request body carries it; an object literal would set the prototype instead.
      name: 'a variable named __proto__ is a variable like any other',
      data: {
        name: 'e',
        sets: JSON.parse('{"__proto__": "x", "constructor": "c", "toString": "t"}') as unknown,
        unset: ['hasOwnProperty'],
        restart: false,
        existingEnv: null,
      },
    },
    {
      // Earlier releases read the LIST form item by item and keep a `__proto__=old` item as
      // a variable; the map built by assignment dropped it, so a change to any other key
      // removed it from the document.
      name: 'a __proto__ the document already has is kept',
      data: {
        name: 'e',
        sets: { A: '1' },
        unset: [],
        restart: false,
        existingEnv: null,
        doc: JSON.parse(
          '{"services": {"rocketchat": {"environment": {"PORT": "3000", "__proto__": "old"}}, ' +
            '"rocketchat-2": {"environment": ["PORT=3000", "__proto__=old"]}}, "volumes": {}}',
        ) as unknown,
      },
    },
    {
      // A removal is recorded as null, so `up --force` keeps it. Assigned on a plain
      // object, a `null` to `__proto__` REPLACED ITS PROTOTYPE and recorded nothing.
      name: 'unsetting __proto__ records the removal',
      data: {
        name: 'e',
        sets: { A: '1' },
        unset: ['__proto__'],
        restart: false,
        existingEnv: null,
      },
    },
  ];

  it('matches earlier releases for every path, byte for byte on the written document', async () => {
    expect(RECORDED.runs).toHaveLength(CASES.length);
    for (const [index, testCase] of CASES.entries()) {
      const recorded = RECORDED.runs[index] as Captured & { error: unknown };
      const mine = await typescriptRun(testCase.data);
      expect(mine.error).toEqual(recorded.error);
      expect(mine.result).toEqual(recorded.result);
      expect(mine.doc).toEqual(recorded.doc);
      expect(mine.env).toEqual(recorded.env);
      expect(mine.up).toEqual(recorded.up);
      expect(mine.events).toEqual(recorded.events);
    }
  });

  it('waits until Rocket.Chat answers before it says the restart is done', async () => {
    // It returned as soon as compose had recreated the container, and a `seed` typed
    // straight after refused "repro not ready" while the new container booted. The wait
    // prints nothing of its own, so the events stay those earlier releases printed.
    const mine = await typescriptRun({
      name: 'e',
      sets: { A: '1' },
      unset: [],
      restart: true,
      existingEnv: null,
    });
    expect(mine.error).toBeNull();
    expect(
      mine.order.filter((step) => !step.startsWith('event ') || step.includes('restarted')),
    ).toEqual(['up', 'wait e', "event 'e' restarted with the new environment"]);
  });

  it('matches earlier releases for every shape a hand-edited extra can take', async () => {
    // Earlier releases read a recorded env list as key/value PAIRS and refuse what is not
    // one, and refuse an `extra` that is not a mapping -- both before anything is written.
    // Read through `bagOf`, a list of pairs was dropped from the document and the record,
    // and every refusal was a success that wrote the override into docker-compose.yml
    // alone, where `up --force` rebuilds it away.
    const shapes: Record<string, unknown>[] = [
      {
        existingEnv: [
          ['A', '1'],
          ['KEEP', null],
          ['FOO', 5],
        ],
      },
      { existingEnv: ['AB', 'CD'] },
      { existingEnv: [{ K: 1, V: 2 }] },
      {
        existingEnv: [
          ['A', '1'],
          ['A', '2'],
        ],
      },
      { existingEnv: 'abc' },
      { existingEnv: 5 },
      { existingEnv: 1.5 },
      { existingEnv: true },
      { existingEnv: [5] },
      { existingEnv: [null] },
      { existingEnv: [['A']] },
      {
        existingEnv: [
          ['A', '1'],
          ['A', '1', '2'],
        ],
      },
      { existingEnv: [[['x'], 'y']] },
      { existingEnv: [[{ k: 1 }, 'y']] },
      { existingEnv: '' },
      { existingEnv: [] },
      { existingEnv: 0 },
      { extra: null },
      { extra: [] },
      { extra: 'x' },
      { extra: 5 },
      { extra: true },
      { extra: { runtime: 'docker', env: [['A', '1']] } },
    ];
    expect(RECORDED.shapes).toHaveLength(shapes.length);
    for (const [index, shape] of shapes.entries()) {
      const data = {
        name: 'e',
        sets: { NEW: '1' },
        unset: ['KEEP'],
        restart: false,
        existingEnv: null,
        ...shape,
      };
      const recorded = RECORDED.shapes[index] as Captured & { error: unknown };
      const mine = await typescriptRun(data);
      expect({ shape, ...mine, upArgs: undefined, order: undefined }).toEqual({
        shape,
        ...recorded,
        upArgs: undefined,
      });
    }
  });

  it('refuses a no-op and warns about a load-bearing key', async () => {
    jest.resetModules();
    const seen: Seen[] = [];
    jest.doMock('../../src/core/lifecycle/naming', () => ({ resolveName: async (n: string) => n }));
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      requireDocker: async () => undefined,
    }));
    jest.doMock('../../src/core/topology', () => ({ requireCompose: async () => undefined }));
    jest.doMock('../../src/core/runner/locks', () => ({
      reproLock: async (_n: string, body: () => Promise<unknown>) => await body(),
    }));
    const envvars = require('../../src/core/envvars') as typeof EnvvarsNS;
    await expect(
      envvars.setEnv('e', {}, [], { emit: ((event: Seen) => seen.push(event)) as never }),
    ).rejects.toThrow('nothing to change');

    jest.resetModules();
    const capture: Record<string, unknown> = {};
    const events: Seen[] = [];
    jest.doMock('../../src/core/lifecycle/naming', () => ({ resolveName: async (n: string) => n }));
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      requireDocker: async () => undefined,
    }));
    jest.doMock('../../src/core/topology', () => ({ requireCompose: async () => undefined }));
    jest.doMock('../../src/core/runner/locks', () => ({
      reproLock: async (_n: string, body: () => Promise<unknown>) => await body(),
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => ({
        name: 'e',
        project: 'houston-e',
        rootUrl: 'http://localhost:3000',
        extra: {},
      }),
      readCompose: async () => ({ services: { rocketchat: { environment: {} } } }),
      write: async (_n: string, y: string, m: unknown) => {
        capture['y'] = y;
        capture['meta'] = m;
      },
    }));
    jest.doMock('../../src/core/runner/engine', () => ({ up: async () => 0 }));
    jest.doMock('../../src/core/rcapi', () => ({ settingIds: async () => null }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      login: async () => {
        throw new Error('down');
      },
    }));
    const envvarsAgain = require('../../src/core/envvars') as typeof EnvvarsNS;
    const result = await envvarsAgain.setEnv('e', { MONGO_URL: 'mongodb://elsewhere' }, [], {
      restart: false,
      emit: ((event: Seen) => events.push(event)) as never,
    });
    expect(result['restarted']).toBe(false);
    expect(events.some((event) => event.message.includes('load-bearing'))).toBe(true);
  });
});

describe('env --set over a hand-edited record', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('writes the record back in the order and spelling it was read in', async () => {
    // Earlier releases rewrite the whole repro.json from what they read of it, the recorded
    // env included: a hand-edited `extra` comes back key for key and digit for digit. This
    // build wrote its `10` first, `1e16` as 10000000000000000 and the thirty-digit int as
    // 1.2345678901234568e+29 -- and copied `extra.env` key by key, in JavaScript's order.
    // Real files, against the bytes earlier releases wrote back for this record, recorded;
    // only the engine and the login are stubbed.
    const home = process.env.HOUSTON_HOME as string;
    const ws = path.join(home, 'repros', 'alpha');
    const record =
      '{"name": "alpha", "project": "houston-alpha", "rc_version": "8.5.1", ' +
      '"rc_image": "rocketchat/rocket.chat:8.5.1", "mongo_tag": "8.0", ' +
      '"mongo_flavor": "community", "preset": "", "root_url": "http://localhost:3100", ' +
      '"host_port": 3100, "version_source": "offline", "extra": {"runtime": "docker", ' +
      '"env": {"FOO": "bar", "7": "seven", "N": 12345678901234567890, "F": 2.0}, ' +
      '"10": "numeric-key", "b": 1, "x": NaN, "y": 1e-07, "z": 1e16, ' +
      '"big": 123456789012345678901234567890}}';
    const setUp = () => {
      fs.mkdirSync(ws, { recursive: true });
      fs.writeFileSync(path.join(ws, 'repro.json'), record);
      fs.writeFileSync(
        path.join(ws, 'docker-compose.yml'),
        'services:\n  rocketchat:\n    environment:\n      FOO: bar\n',
      );
    };

    const recorded = RECORDED.record;

    setUp();
    // The REAL record and lock layers: a `doMock` outlives `resetModules`, and the cases
    // above replaced both with doubles that write nothing to disk.
    jest.doMock('../../src/core/runner/record', () =>
      jest.requireActual('../../src/core/runner/record'),
    );
    jest.doMock('../../src/core/runner/locks', () =>
      jest.requireActual('../../src/core/runner/locks'),
    );
    jest.doMock('../../src/core/runner/engine', () =>
      jest.requireActual('../../src/core/runner/engine'),
    );
    jest.doMock('../../src/core/lifecycle/naming', () => ({ resolveName: async (n: string) => n }));
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      requireDocker: async () => undefined,
    }));
    jest.doMock('../../src/core/topology', () => ({ requireCompose: async () => undefined }));
    jest.doMock('../../src/core/rcapi', () => ({ settingIds: async () => null }));
    jest.doMock('../../src/core/lifecycle/admin', () => ({
      login: async () => {
        throw new Error('down');
      },
    }));
    const envvars = require('../../src/core/envvars') as typeof EnvvarsNS;
    await envvars.setEnv('alpha', { NEW: '1' }, [], { restart: false });
    const ours = fs.readFileSync(path.join(ws, 'repro.json'), 'utf8');
    expect(ours).toBe(recorded);
    expect(ours).toContain('"big": 123456789012345678901234567890');
    expect(ours.indexOf('"FOO": "bar"')).toBeLessThan(ours.indexOf('"7": "seven"'));
  });
});
