import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'node:child_process';

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  CLOUD_ACCOUNTS_KEY,
  DEFAULT_BIND_HOST,
  KUBE_CONTEXT_KEY,
  MONITOR_PORTS,
  PRESET_PORTS,
  WEBHOOKS_INCOMING,
  WEBHOOKS_OUTGOING,
  WEBHOOKS_RECEIVER,
  WEBHOOKS_TOKEN,
  approvedAwsAccounts,
  configFile,
  dataPath,
  defaultKubeContext,
  env,
  generateAdminPassword,
  home,
  HOME_ID_FILE,
  homeId,
  isYamlDate,
  legacyEnvUsed,
  loadConfig,
  parseConfigYaml,
  stringifyConfigYaml,
  presetDir,
  reportsDir,
  reprosDir,
  resetLegacyEnvWarnings,
  saveConfig,
  truthy,
  updateConfig,
} from '../../src/lib/config';

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * What earlier releases answered and wrote for the larger corpora below, recorded: paths,
 * scalar readings, explicit tags, emitted and rewritten config.yaml text.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'lib', 'config.json'), 'utf8'),
) as {
  path_rows: string[][];
  scalars: Record<string, { value: unknown; type: string; naive?: boolean }>;
  tagged: unknown[];
  emitted: string;
  rewritten: string;
  quoted: string[];
  folded: string[];
  hand_edited: Record<string, string[]>;
  integral_floats: string;
  big_ints: string;
};

/**
 * The instant a timestamp with no offset is in THIS run's zone. Both readers take such a
 * timestamp for a local time, so earlier releases' reading was recorded as the wall-clock
 * time it spells (marked naive), and it is compared as the instant that wall clock is here.
 */
function naiveInstant(wallClock: string): string {
  const [date = '', time = ''] = wallClock.split(' ');
  const [year, month, day] = date.split('-').map(Number);
  const [hours, minutes, seconds] = time.split(':').map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day, hours, minutes, seconds)
    .toISOString()
    .replace(/\.000Z$/, 'Z');
}

let previousHome: string | undefined;
let madeHome = '';
beforeEach(() => {
  previousHome = process.env.HOUSTON_HOME;
  madeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-config-'));
  process.env.HOUSTON_HOME = madeHome;
  resetLegacyEnvWarnings();
});
afterEach(() => {
  // The home THIS hook made, not whatever HOUSTON_HOME says now: several tests delete or
  // repoint it, and removing the current value left the made one behind in /tmp.
  fs.rmSync(madeHome, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.HOUSTON_HOME;
  else process.env.HOUSTON_HOME = previousHome;
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('RC_REPRO_') || name === 'HOUSTON_KUBE_CONTEXT') delete process.env[name];
  }
});

describe('the port registry', () => {
  // ONE registry, so presets cannot silently collide -- a new preset picks a port by
  // looking here. RC's own port is allocated dynamically per repro.
  it('gives every preset a distinct set of host ports', () => {
    const all = Object.values(PRESET_PORTS).flatMap((ports) => [...ports]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('does not collide with the monitoring add-on', () => {
    const all = new Set(Object.values(PRESET_PORTS).flatMap((ports) => [...ports]));
    for (const port of MONITOR_PORTS) expect(all.has(port)).toBe(false);
  });

  it('holds the ports the presets actually publish', () => {
    expect(PRESET_PORTS.saml).toEqual([8081]);
    expect(PRESET_PORTS.oidc).toEqual([8085]);
    expect(PRESET_PORTS.email).toEqual([8025]);
    expect(PRESET_PORTS.s3_minio).toEqual([9000, 9001]);
    expect(PRESET_PORTS.livechat).toEqual([8090]);
    expect(PRESET_PORTS.ldap).toEqual([8082]);
    expect(PRESET_PORTS.webhooks).toEqual([8086]);
    expect(MONITOR_PORTS).toEqual([9090, 5050]);
  });

  it('names the webhook inbox the one way every URL and integration spells it', () => {
    // The receiver's compose/Kubernetes name. The session is the receiver's choice, made
    // and recorded by post-ready, so no constant names one.
    expect(WEBHOOKS_RECEIVER).toBe('http://webhooks:8080');
    expect([WEBHOOKS_OUTGOING, WEBHOOKS_INCOMING]).toEqual([
      'houston-outgoing',
      'houston-incoming',
    ]);
    expect(WEBHOOKS_TOKEN).toBe('houston');
  });
});

describe('the bind posture', () => {
  it('is loopback, because repros ship weak fixed credentials', () => {
    // These two facts belong in one assertion: the fixed password is only acceptable
    // BECAUSE nothing outside this machine can reach the workspace.
    expect(DEFAULT_BIND_HOST).toBe('127.0.0.1');
    expect(ADMIN_USERNAME).toBe('admin');
    expect(ADMIN_PASSWORD).toBe('admin123');
  });
});

describe('generateAdminPassword', () => {
  it('is 20 url-safe characters, matching secrets.token_urlsafe(15)', () => {
    const pw = generateAdminPassword();
    expect(pw).toHaveLength(20);
    expect(pw).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is different every time', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateAdminPassword()));
    expect(seen.size).toBe(50);
  });
});

describe('paths', () => {
  it('all hang off HOUSTON_HOME', () => {
    const root = home();
    expect(reprosDir()).toBe(path.join(root, 'repros'));
    expect(presetDir()).toBe(path.join(root, 'presets'));
    expect(reportsDir()).toBe(path.join(root, 'reports'));
    expect(configFile()).toBe(path.join(root, 'config.yaml'));
  });

  it('RESOLVES rather than creating', () => {
    const fresh = path.join(home(), 'not-made-yet');
    process.env.HOUSTON_HOME = fresh;
    expect(home()).toBe(fresh);
    expect(fs.existsSync(fresh)).toBe(false);
  });

  it.each([
    null,
    '',
    '/',
    '//',
    '/tmp/x',
    '/tmp/x/',
    '/tmp/x//',
    '/tmp/a/../x',
    '//tmp/x',
    '/tmp/./x/',
  ])('is the home earlier releases use with no HOUSTON_HOME and HOME=%j', (row) => {
    // HOME set but EMPTY was `.houston` in the WORKING directory here and `/.houston` in
    // earlier releases: one tool keeping state in two places, and one of them a different
    // place per directory the command ran from. Each row is a fresh process of this build,
    // because under Jest `process.env` is this file's copy and `os.homedir()` is native -- a
    // HOME set here would move nothing. `null` is unset, which earlier releases answered
    // from the account's home directory in the user database. The last three keep a `..`
    // and a two-slash root, as earlier releases spelled the home, which `path.join` folded.
    const recorded: Record<string, string> = {
      '': '/.houston',
      '/': '/.houston',
      '//': '/.houston',
      '/tmp/x': '/tmp/x/.houston',
      '/tmp/x/': '/tmp/x/.houston',
      '/tmp/x//': '/tmp/x/.houston',
      '/tmp/a/../x': '/tmp/a/../x/.houston',
      '//tmp/x': '//tmp/x/.houston',
      '/tmp/./x/': '/tmp/x/.houston',
    };
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of ['HOME', 'HOUSTON_HOME', 'RC_REPRO_HOME']) delete env[name];
    if (row !== null) env.HOME = row;
    const configTs = path.join(ROOT, 'src', 'lib', 'config.ts');
    const ours = spawnSync(
      process.execPath,
      [
        '-e',
        `require(${JSON.stringify(path.join(ROOT, 'tools', 'ts-require'))}).install();` +
          `process.stdout.write(JSON.stringify(require(${JSON.stringify(configTs)}).home()))`,
      ],
      { cwd: ROOT, encoding: 'utf8', env },
    );
    const expected = row === null ? path.join(os.userInfo().homedir, '.houston') : recorded[row];
    expect([ours.stderr, row === null || row in recorded]).toEqual(['', true]);
    expect(JSON.parse(ours.stdout)).toBe(expected);
  });

  it('are spelled as earlier releases spell them, whatever HOUSTON_HOME holds', () => {
    // Earlier releases keep a `..` for the kernel to walk (with `link -> other/sub`,
    // `link/../hh` is `other/hh`, where `path.join` made it `hh`), keep a two-slash root,
    // and drop `.` parts, doubled and trailing slashes -- the raw value came back from
    // `home()` and every child was `path.join`ed.
    const rows = ['link/../hh', 'x/..', 'hh/', 'a//b/./c/', './x', '//srv/h', '///srv/h', '.', '/'];
    const ours = rows.map((row) => {
      process.env.HOUSTON_HOME = row;
      return [home(), reprosDir(), presetDir(), reportsDir(), configFile()];
    });
    // Recorded per row: the home, then its repros, presets and reports directories and
    // config file.
    expect(ours).toEqual(RECORDED.path_rows);
  });

  it('finds the shipped package data both implementations read', () => {
    // This is the package-data lookup, and the reason this tree has no
    // bundler: a bundler rewrites exactly this lookup, and versions.ts then falls back
    // to the live endpoint with a green build.
    expect(fs.existsSync(dataPath('versions.yaml'))).toBe(true);
    expect(fs.existsSync(dataPath('presets', 'default.yaml'))).toBe(true);
  });
});

describe('env', () => {
  it('prefers the new spelling when both are set', () => {
    process.env.HOUSTON_KUBE_CONTEXT = 'new';
    process.env.RC_REPRO_KUBE_CONTEXT = 'old';
    expect(env('HOUSTON_KUBE_CONTEXT')).toBe('new');
  });

  it('still reads the pre-rename spelling, and warns on STDERR once', () => {
    // A rename that only taught the tool the new name would make an RC_REPRO_HOME in
    // somebody's shell profile do nothing at all -- not fail, just quietly resolve state
    // somewhere else. And the warning must not reach stdout, which carries the envelope.
    process.env.RC_REPRO_KUBE_CONTEXT = 'old';
    const written: string[] = [];
    const spy = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    try {
      expect(env('HOUSTON_KUBE_CONTEXT')).toBe('old');
      expect(env('HOUSTON_KUBE_CONTEXT')).toBe('old');
    } finally {
      spy.mockRestore();
    }
    expect(written).toHaveLength(1);
    expect(written[0]).toContain('RC_REPRO_KUBE_CONTEXT');
    expect(written[0]).toContain('rename it');
  });

  it('returns the fallback when neither is set', () => {
    expect(env('HOUSTON_NOTHING_AT_ALL', 'fallback')).toBe('fallback');
  });

  it('reports legacy names from the ENVIRONMENT, not from what was read', () => {
    // A historical record answers "did anything read one yet", which depends on which
    // commands ran in what order -- so doctor would report a variable no longer set, or
    // stay silent about one that is simply not read on this code path.
    process.env.RC_REPRO_HOME = '/somewhere';
    process.env.RC_REPRO_BIND_HOST = '0.0.0.0';
    expect(legacyEnvUsed()).toEqual(['RC_REPRO_BIND_HOST', 'RC_REPRO_HOME']);
  });
});

describe('truthy', () => {
  // `Boolean("false")` IS TRUE, and that made `config set acme.staging false` impossible
  // to obey: turning staging ON worked while turning it OFF did nothing at all. The
  // asymmetry is what hid it.
  it.each([
    ['1', true],
    ['true', true],
    ['yes', true],
    ['on', true],
    ['y', true],
    ['t', true],
    ['TRUE', true],
    ['0', false],
    ['false', false],
    ['no', false],
    ['off', false],
    ['n', false],
    ['f', false],
    ['FALSE', false],
    ['', false],
    ['  False  ', false],
  ])('reads %p as %p', (value, expected) => {
    expect(truthy(value)).toBe(expected);
  });

  it('passes a real boolean straight through', () => {
    expect(truthy(true)).toBe(true);
    expect(truthy(false)).toBe(false);
  });

  it('falls back for null, undefined and a word it does not know', () => {
    expect(truthy(null, true)).toBe(true);
    expect(truthy(undefined, true)).toBe(true);
    expect(truthy('maybe', true)).toBe(true);
    expect(truthy('maybe', false)).toBe(false);
  });

  it('reads a number the way earlier releases do', () => {
    expect(truthy(1)).toBe(true);
    expect(truthy(0)).toBe(false);
  });

  it('strips what earlier releases strip, and nothing else, as their truthy does', () => {
    // `trim()` is not earlier releases' strip: it kept the information separators and NEL,
    // which they strip, and stripped a BOM, which they keep -- so a remembered `\x1ctrue`
    // read false here and `\ufefftrue` read true.
    const cells = [
      '\u001ctrue',
      'true\u001f',
      '\u001dno',
      '\u001eyes',
      '\u0085true',
      '\ufefftrue',
      'on\ufeff',
      '\u00a0yes',
      '\u2028on',
      '\u202foff',
      '\u3000t',
      '\u200btrue',
      '\u180etrue',
      ' \t1\n',
    ];
    // What earlier releases answered for each cell, under a false and a true fallback.
    const recorded: [boolean, boolean][] = [
      [true, true],
      [true, true],
      [false, false],
      [true, true],
      [true, true],
      [false, true],
      [false, true],
      [true, true],
      [true, true],
      [false, false],
      [true, true],
      [false, true],
      [false, true],
      [true, true],
    ];
    // Under both fallbacks, so "not a word" is an answer of its own and not a false.
    expect(cells.map((cell) => [truthy(cell, false), truthy(cell, true)])).toEqual(recorded);
    expect(recorded.slice(0, 6)).toEqual([
      [true, true],
      [true, true],
      [false, false],
      [true, true],
      [true, true],
      [false, true],
    ]);
  });
});

describe('the persisted config', () => {
  it('is {} when the file does not exist', () => {
    expect(loadConfig()).toEqual({});
  });

  it("resolves scalars the way earlier releases' YAML reader does, over the adversarial corpus", () => {
    // `config.yaml` is a file this build shares with earlier releases, and the two YAML stacks
    // disagree on exactly the cells a human writes by hand: `y`/`n` single letters, a dotless
    // exponent, a leading-dot float with no digit, a sexagesimal starting with 0, and a
    // single-digit month in a bare date. The answers must be the ones earlier releases gave,
    // recorded, each tagged with the type they read it as so `1.0` and `1` stay
    // distinguishable.
    const corpus = [
      'yes',
      'Yes',
      'YES',
      'no',
      'No',
      'NO',
      'on',
      'On',
      'ON',
      'off',
      'Off',
      'OFF',
      'true',
      'True',
      'false',
      'False',
      'y',
      'Y',
      'n',
      'N',
      't',
      'T',
      'f',
      'F',
      '1e5',
      '2E3',
      '-1e5',
      '1e+5',
      '1E-5',
      '1.5e5',
      '.5e5',
      '0.5e5',
      '1e5x',
      '+1e5',
      '1_000e5',
      'e5',
      '.e5',
      '1e',
      '1E',
      '0755',
      '0o755',
      '0b101',
      '0x10',
      '12:30:45',
      '1:20:30',
      '1:20',
      '0:00:00',
      '59:59',
      '1:20:30.5',
      '12:30',
      '123',
      '-42',
      '+42',
      '1_000',
      '1_000.5',
      '2026-09-17',
      '2026-9-17',
      '2026-09-17T12:00:00Z',
      '2026-09-17 08:00:00',
      'inf',
      'Inf',
      'INF',
      '-inf',
      '.inf',
      '-.inf',
      'nan',
      '.nan',
      '.NaN',
      '.NAN',
      '1.5',
      '-1.5',
      '.5',
      '-.5',
      '0.5.5',
      '1.',
      '.',
      // A digit must follow the leading dot: an underscore there is a string
      // to earlier releases, which write these bare, and the resolver here read nan and 0.5.
      '._',
      '.__',
      '._5',
      '._0',
      '._9',
      '._1_',
      '._5e+3',
      '.5_',
      '.5_e-3',
      '1._5',
      'null',
      'Null',
      'NULL',
      '~',
      '',
      '1,000',
      '0x',
      '1::2',
      '-0.0',
      '0.0',
      '+0.5',
      'a b',
      'a:b',
      '"x"',
      "'x'",
      'yes ',
      ' yes',
    ];
    // Quoting is the harness's, not the cells': each cell reaches both parsers as a
    // PLAIN scalar wherever that is legal, because resolution is the property under
    // test.
    const here: Record<string, { value: unknown; type: string }> = {};
    for (const [index, cell] of corpus.entries()) {
      const parsed = loadConfigRawValue(`k${index}: ${cell}\n`);
      here[`k${index}`] = parsed;
    }

    const expected = Object.fromEntries(
      Object.entries(RECORDED.scalars).map(([key, answer]) => [
        key,
        answer.naive === true
          ? { type: answer.type, value: naiveInstant(String(answer.value)) }
          : answer,
      ]),
    );
    expect(Object.keys(expected)).toHaveLength(corpus.length);
    const mismatches: string[] = [];
    for (const [index, cell] of corpus.entries()) {
      const key = `k${index}`;
      const left = expected[key];
      const right = here[key];
      const sameValue = JSON.stringify(right?.value) === JSON.stringify(left?.value);
      const sameType = right?.type === left?.type;
      if (!sameValue || !sameType) {
        mismatches.push(
          `${cell!} -> here=${JSON.stringify(right?.value)} ${right?.type}, recorded=${JSON.stringify(left?.value)} ${left?.type}`,
        );
      }
    }
    expect(mismatches).toEqual([]);

    function loadConfigRawValue(text: string): { value: unknown; type: string } {
      const loaded = parseConfigYaml(text) as Record<string, unknown>;
      const value = loaded[Object.keys(loaded)[0]!];
      return tagged(value);
    }

    function tagged(value: unknown): { value: unknown; type: string } {
      // The int/float split is the one distinction JavaScript cannot recover: both
      // arrive as `number`. The comparison below therefore treats earlier releases' integer
      // and float as one coarse `number` type -- the READERS on both sides that care
      // (truthy, the settings rows) agree on a number either way -- and pins the
      // VALUE for every numeric cell.
      if (value === null) return { value: null, type: 'null' };
      if (typeof value === 'number') {
        if (Number.isNaN(value)) return { value: 'nan', type: 'number' };
        if (value === Infinity) return { value: 'inf', type: 'number' };
        if (value === -Infinity) return { value: '-inf', type: 'number' };
        return { value, type: 'number' };
      }
      if (typeof value === 'boolean') return { value, type: 'boolean' };
      if (isYamlDate(value)) return { value: dateOnly(value), type: 'date' };
      if (value instanceof Date) {
        return { value: value.toISOString().replace(/\.000Z$/, 'Z'), type: 'datetime' };
      }
      return { value, type: 'string' };
    }

    function dateOnly(value: Date): string {
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
    }
  });

  it("constructs an explicitly tagged scalar the way earlier releases' YAML reader does, refusals included", () => {
    // An explicit `!!float 3` or `!!null x` is the tag's CONSTRUCTOR applied to any text; the
    // implicit grammar only decides which plain scalars get the tag untold. This build asked
    // the grammar of explicit ones too, so each text outside it was "could not determine a
    // constructor" and a stack, where earlier releases read `3.0` and null -- or were refused
    // by the constructor, `'1e3' is not an integer` for `!!int 1e3` and `'y' is not a boolean`
    // for `!!bool y`. The later documents hold two refusals each, and the one raised is the one
    // the document's construction meets first: a nested collection is built after its
    // parent's own scalars, and a merged mapping's items ahead of the mapping's.
    const documents = [
      ...['1e3', '3', '-0', '0o17', '0b101', '0x1F', '0X1F', '017', '08', '0_7', '1_000']
        .concat(['1:30', '1:x', '0:30', ' 7', '١٢', '0b', '0x', '+', "''", '1.5'])
        .concat(['-0b11', '0b0b1', '00o17', '0b_1', '0x_1f', '0b2', '"\\x1c7"', '"\\t7"'])
        .concat(['1::2', '"-"', '"\\uff17"', '0B1'])
        .map((text) => `k: !!int ${text}\n`),
      ...['3', '1_0', '1e3', '.5', '5.', 'inf', 'Infinity', '-nan', '.inf', '-.inf', '+.INF']
        .concat(['abc', "''", '+', '1:30', '1:30.5', '1:x', '0x10', '1e', ' 1 ', '١', '-0'])
        .concat(['1:-5', '"-"', '.', 'e5', '"\\x1c1"', '"\\u00a01"', 'İnf', ':1'])
        .map((text) => `k: !!float ${text}\n`),
      ...['y', 'yes', 'tRuE', 'oFF', 'n', "''", '1', 't', 'Ÿ', '" yes"', 'İ'].map(
        (text) => `k: !!bool ${text}\n`,
      ),
      ...['x', '~', 'null', '0', "'a b'"].map((text) => `k: !!null ${text}\n`),
      ...['nope', '2026-9-1', '2026-09-01', '2026-13-1', '2026-2-30', '2026-01-01 10:00:00']
        .concat(['2026-01-01T10:00:00Z', '0000-1-1', '2026-01-01x', "''", '"2026-1-1\\n"'])
        .concat(['2026-01-01 10:00:00 +24:00', '2026-01-01 10:00:00 -99:00', '2024-2-29'])
        .concat(['2026-01-01 25:00:00', '2026-01-01 10:60:00', '2026-01-01 10:00:60'])
        .concat(['2023-2-29', '1900-2-29', '0005-1-1', '2026-13-01 10:00:00 +24:00'])
        .map((text) => `k: !!timestamp ${text}\n`),
      ...['123', '~', 'true', '1.5', '2026-01-01'].map((text) => `k: !!str ${text}\n`),
      'k: !!int\n',
      'k: !!float\n',
      'k: !!bool\n',
      'k: !!null\n',
      'k: !!timestamp\n',
      'a: !!int x\nb: !foo y\n',
      'a: !foo y\nb: !!int x\n',
      'a: [!!int x]\nb: !!int y\n',
      'a: {c: !!int x}\nb: !foo y\n',
      '- [!foo a]\n- !!int b\n',
      '- - - !!int deep\n- !bar shallow\n',
      '!!int x\n',
      'b: &b {x: !!int q}\nt: {<<: *b, y: !!bool z}\n',
      't: {y: !!bool z, <<: {x: !!int q}}\n',
      't: {<<: [{x: !!int one}, {y: !!int two}]}\n',
      'b: !!int q\n<<: {a: !!bool z}\n',
      '? !!int q\n: !!bool z\n',
      'x: &a !!int q\ny: *a\nz: !foo w\n',
      'a: !!set {!!int x: , b: }\n',
      'a: !!omap [x: !!int q, y: !!bool z]\n',
    ];
    // What earlier releases read or refused for each document, recorded: the type and value
    // of `k`, an integral float compared as its integer with its sign kept (the int/float
    // split is the one JavaScript cannot keep), or the refusal.
    const recorded = RECORDED.tagged.map((answer) =>
      Array.isArray(answer) && answer[2] === 'naive'
        ? [answer[0], naiveInstant(String(answer[1]))]
        : answer,
    );

    const shown = (value: unknown): unknown[] => {
      if (value === null) return ['null', null];
      if (typeof value === 'boolean') return ['boolean', value];
      if (typeof value === 'number') {
        if (Number.isNaN(value)) return ['number', 'nan'];
        if (!Number.isFinite(value)) return ['number', value > 0 ? 'inf' : '-inf'];
        if (Number.isInteger(value)) return ['number', Object.is(value, -0) ? '-0' : String(value)];
        return ['number', String(value)];
      }
      if (isYamlDate(value)) return ['date', value.toISOString().slice(0, 10)];
      if (value instanceof Date) return ['datetime', value.toISOString().replace('.000Z', 'Z')];
      return [typeof value, value];
    };
    const ours = documents.map((text) => {
      try {
        const loaded = parseConfigYaml(text) as Record<string, unknown> | null;
        return loaded !== null && typeof loaded === 'object' && Object.keys(loaded).join() === 'k'
          ? shown(loaded.k)
          : ['document', null];
      } catch (error) {
        return [(error as Error).name, (error as Error).message];
      }
    });
    expect(recorded).toHaveLength(documents.length);
    const mismatches = documents.flatMap((text, at) =>
      JSON.stringify(ours[at]) === JSON.stringify(recorded[at])
        ? []
        : [
            `${JSON.stringify(text)}: here ${JSON.stringify(ours[at])}, recorded ${JSON.stringify(recorded[at])}`,
          ],
    );
    expect(mismatches).toEqual([]);
    // The finding's own cells, spelled out: the corpus agreeing would also be satisfied by
    // two readers that refused everything alike.
    const answer = (text: string) => recorded[documents.indexOf(text)];
    expect(answer('k: !!float 3\n')).toEqual(['number', '3']);
    expect(answer('k: !!float 1_0\n')).toEqual(['number', '10']);
    expect(answer('k: !!null x\n')).toEqual(['null', null]);
    expect(answer('k: !!int 1e3\n')).toEqual(['InvalidValue', "'1e3' is not an integer"]);
    expect(answer('k: !!bool y\n')).toEqual([
      'InvalidValue',
      "'y' is not a boolean (want yes, no, true, false, on or off)",
    ]);
  });

  it("emits scalars byte-for-byte the way earlier releases' YAML writer does", () => {
    // `config.yaml` is written by whichever release ran the command and read by both, so
    // the EMITTER matters as much as the resolver. Three defaults of earlier releases' YAML
    // writer had to be reproduced and each was measured, not guessed:
    //
    //   - `allow_unicode=False`, so every code point above printable ASCII is escaped
    //     (`\xNN` to U+00FF, `\uNNNN` through the BMP, `\UNNNNNNNN` above, uppercase);
    //   - single quotes where the package prefers double;
    //   - a quoted scalar, never a `|` block, for a value holding a newline.
    //
    // The writer is now the `safeDump` of `yaml-dump.ts`, which folds as earlier releases
    // fold too; the long values are in the byte-for-byte tests at the end of this file.
    const corpus: Record<string, unknown> = {
      e_acute: 'caf\u00e9',
      emdash: 'a\u2014b',
      ligature: '\ufb01x',
      emoji: 'rocket \u{1F680} here',
      u2028: 'line\u2028sep',
      u2029: 'para\u2029sep',
      nbsp: 'a\u00a0b',
      nel: 'a\u0085b',
      tabbed: 'a\u0009b',
      del: 'a\u007fb',
      nul: 'a\u0000b',
      bell: 'a\u0007b',
      escape: 'a\u001bb',
      plain: 'abc',
      digits: '123abc',
      quote: "it's",
      dquote: 'say "hi"',
      backslash: 'a\\b',
      cyrillic: '\u041f\u0440\u0438\u0432\u0435\u0442',
      multiline: 'line1\nline2\n',
      multiline_nofinal: 'a\nb',
      yes_word: 'yes',
      empty: '',
      spaces: '   ',
      sexagesimal: '12:30:45',
      numberish: '123',
      // Bare in earlier releases, because their float needs a digit after the dot; quoted
      // here while the resolver took them for floats. `.5` is a float to both.
      dot_underscore: '._5',
      dot_underscore_only: '._',
      dot_underscores: '.__',
      dot_underscore_exp: '._5e+3',
      dot_digit: '.5',
      real_true: true,
      real_false: false,
      real_null: null,
      an_int: 42,
      a_float: 1.5,
    };

    const here = stringifyConfigYaml(corpus);

    // The document earlier releases wrote for the same mapping, in its order.
    expect(here).toEqual(RECORDED.emitted);
  });

  it('rewrites the floats and timestamps it read as earlier releases write them back', () => {
    // Any `config set` rewrites every key, so an unrelated value must come back as earlier
    // releases write it. Floats went through their plain text -- `nan`, `-inf`, `1e-07`, which
    // both readers then took for strings -- where earlier releases write `.nan`, `-.inf` and
    // `1.0e-07`. A timestamp became a Date and came back as a UTC instant: a naive one
    // shifted by the box's zone, an offset dropped, a fraction cut to milliseconds, where
    // earlier releases write back what they read, date and time joined by a space. The
    // corpus is written by hand, as only a hand edit puts these here. Recorded: the file an
    // earlier release left after setting `bind_host` in a home holding this document.
    const document = [
      'x_nan: .nan',
      'x_NaN: .NaN',
      'x_inf: .inf',
      'x_ninf: -.inf',
      'x_pinf: +.INF',
      'f_small: 1.0e-7',
      'f_small2: 1.5e-7',
      'f_tiny: 2.5e-10',
      'f_denormal: 5.0e-324',
      'f_tenth: 0.1',
      'f_exp: 6.8523015e+5',
      'f_under: 1_000.5',
      'f_sexagesimal: 1:30.5',
      'f_neg: -.5',
      't_naive: 2026-01-01 10:00:00',
      't_utc: 2026-01-01T10:00:00Z',
      't_space_z: 2026-01-01 10:00:00 Z',
      't_lower_t: 2001-12-14t21:59:43.10-05:00',
      't_offset: 2026-01-01T10:00:00.5+02:00',
      't_seven: 2026-01-01 10:00:00.1234567+05:30',
      't_zero_fraction: 2026-01-01 10:00:00.000',
      't_short: 2026-1-1 1:00:00',
      't_hour_offset: 2026-01-01 10:00:00 +5',
      't_minus_zero: 2026-01-01 10:00:00-00:00',
      'd_date: 2026-01-01',
      'i_negative_zero: -0',
      '',
    ].join('\n');
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(configFile(), document, 'utf8');
    updateConfig((cfg) => {
      cfg.bind_host = '0.0.0.0';
    });
    const recorded = RECORDED.rewritten;
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(recorded);
    expect(recorded).toContain('t_naive: 2026-01-01 10:00:00\n');
    expect(recorded).toContain('f_small: 1.0e-07\n');
  });

  it('rewrites a timestamp a Date cannot hold, where it threw', () => {
    // `10:00:00.` -- a dot and no digits -- is a timestamp to earlier releases and an
    // Invalid Date to V8, so a rewrite of the file threw `RangeError: Invalid time value`
    // from toISOString and `config set` stored nothing. Earlier releases write it without
    // the dot.
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(configFile(), 'x: 2026-01-01 10:00:00.\n', 'utf8');
    updateConfig((cfg) => {
      cfg.bind_host = '0.0.0.0';
    });
    // What earlier releases wrote for the document with `bind_host` added.
    const recorded = 'x: 2026-01-01 10:00:00\nbind_host: 0.0.0.0\n';
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(recorded);
  });

  it('keeps the last value of a doubled key, as earlier releases do', () => {
    // The yaml library's default refused the file, and every command that read
    // config.yaml ended with a stack where earlier releases read the last value.
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(
      configFile(),
      'default_repro: first\nbind_host: 0.0.0.0\ndefault_repro: last\n',
    );
    // What earlier releases loaded from that file, and its keys in their order.
    const recorded: Record<string, unknown> = { default_repro: 'last', bind_host: '0.0.0.0' };
    const order = ['default_repro', 'bind_host'];
    expect(recorded.default_repro).toBe('last');
    const ours = loadConfig(false);
    expect(ours).toEqual(recorded);
    expect(Object.keys(ours)).toEqual(order);
  });

  it('round-trips through YAML', () => {
    saveConfig({ default_repro: 'TICKET-1', bind_host: '127.0.0.1' });
    expect(loadConfig()).toEqual({ default_repro: 'TICKET-1', bind_host: '127.0.0.1' });
  });

  it('writes the file 0600 and the home 0700', () => {
    // This directory also holds the audit log, the accounts file and the ACME material.
    saveConfig({ a: 1 });
    expect(fs.statSync(configFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(home()).mode & 0o777).toBe(0o700);
  });

  it('leaves no temp file behind', () => {
    saveConfig({ a: 1 });
    expect(fs.readdirSync(home()).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('replaces atomically rather than truncating in place', () => {
    // A plain write could be read half-written. The property under test is that the
    // destination inode CHANGES, which is what rename gives and what an in-place write
    // does not.
    saveConfig({ generation: 1 });
    const first = fs.statSync(configFile()).ino;
    saveConfig({ generation: 2 });
    const second = fs.statSync(configFile()).ino;
    expect(second).not.toBe(first);
    expect(loadConfig()).toEqual({ generation: 2 });
  });

  it('applies env overrides on read', () => {
    process.env.HOUSTON_KUBE_CONTEXT = 'from-env';
    expect(loadConfig()[KUBE_CONTEXT_KEY]).toBe('from-env');
  });

  it('NEVER persists an ephemeral env value', () => {
    // reg_token is env/flag only. `updateConfig` reads with env off precisely so a
    // HOUSTON_REG_TOKEN in the shell does not end up written into the file.
    process.env.HOUSTON_REG_TOKEN = 'secret-token';
    try {
      updateConfig((cfg) => {
        cfg.default_repro = 'TICKET-2';
      });
      const onDisk = fs.readFileSync(configFile(), 'utf8');
      expect(onDisk).toContain('TICKET-2');
      expect(onDisk).not.toContain('secret-token');
    } finally {
      delete process.env.HOUSTON_REG_TOKEN;
    }
  });

  it('ignores a config.yaml that is not a mapping', () => {
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(configFile(), '- a\n- list\n', 'utf8');
    expect(loadConfig()).toEqual({});
  });

  it('starts from {} under a document that is an object but not a mapping, as earlier releases do', () => {
    // A whole document that is a timestamp, a `!!set`, an `!!omap` or `!!binary` is an
    // object to JavaScript, so it passed for the config dict: the key was set on the Date,
    // Set, Map or Uint8Array as a property the emitter drops, `config set` reported success,
    // and the file was rewritten as the same non-mapping.
    const documents = [
      '2026-01-01\n',
      '2026-01-01 10:00:00\n',
      '!!set {bind_host}\n',
      '!!set {a, b}\n',
      '!!omap [a: 1]\n',
      '!!binary aGVsbG8=\n',
      '!!pairs [a: 1]\n',
      '- a\n',
      'plain\n',
      '{}\n',
      'acme_email: a@b\n',
    ];
    const homes = documents.map((document, at) => {
      const own = path.join(madeHome, `doc-${String(at)}`);
      fs.mkdirSync(own, { recursive: true });
      fs.writeFileSync(path.join(own, 'config.yaml'), document, 'utf8');
      return own;
    });
    // What earlier releases left in each home after setting `bind_host`.
    const recorded = [
      ...Array<string>(10).fill('bind_host: x\n'),
      'acme_email: a@b\nbind_host: x\n',
    ];
    const ours = homes.map((own) => {
      process.env.HOUSTON_HOME = own;
      updateConfig((cfg) => {
        cfg.bind_host = 'x';
      });
      return fs.readFileSync(configFile(), 'utf8');
    });
    expect(ours).toEqual(recorded);
    expect(recorded.slice(0, 6)).toEqual(Array.from({ length: 6 }, () => 'bind_host: x\n'));
  });
});

describe('approvedAwsAccounts', () => {
  it('is empty by default, so every create is gated', () => {
    expect(approvedAwsAccounts()).toEqual(new Set());
  });

  it('splits, trims and drops blanks', () => {
    saveConfig({ [CLOUD_ACCOUNTS_KEY]: ' 111122223333 , 444455556666 ,, ' });
    expect(approvedAwsAccounts()).toEqual(new Set(['111122223333', '444455556666']));
  });
});

describe('defaultKubeContext', () => {
  it('is "" when unset, and trimmed when set', () => {
    expect(defaultKubeContext()).toBe('');
    saveConfig({ [KUBE_CONTEXT_KEY]: '  prod  ' });
    expect(defaultKubeContext()).toBe('prod');
  });
});

describe('the environment over the file', () => {
  function quietly<T>(run: () => T): T {
    // A pre-rename spelling warns once on stderr; that warning has its own test above.
    const spy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      return run();
    } finally {
      spy.mockRestore();
    }
  }

  afterEach(() => {
    delete process.env.HOUSTON_REG_TOKEN;
  });

  it('lets HOUSTON_REG_TOKEN win over a token saved in the file', () => {
    process.env.HOUSTON_REG_TOKEN = 'tok-from-env';
    expect(loadConfig().reg_token).toBe('tok-from-env');
    saveConfig({ reg_token: 'tok-from-file' });
    expect(loadConfig().reg_token).toBe('tok-from-env');
  });

  it('reads the env with env off for a save, and readers still see it', () => {
    // Read-modify-write flows (`up --pin`, `use`) must not bake an ephemeral secret into
    // config.yaml -- while every reader still sees the value the environment gives.
    process.env.HOUSTON_REG_TOKEN = 'SECRET';
    const raw = loadConfig(false);
    expect(raw).not.toHaveProperty('reg_token');
    raw.default_repro = 'x';
    saveConfig(raw);
    expect(fs.readFileSync(configFile(), 'utf8')).not.toContain('SECRET');
    expect(loadConfig().reg_token).toBe('SECRET');
  });

  it('keeps both of two successive updates, and persists no env-only token', () => {
    process.env.HOUSTON_REG_TOKEN = 'ephemeral-secret';
    updateConfig((cfg) => {
      cfg.default_repro = 'a';
    });
    updateConfig((cfg) => {
      cfg.other = 1;
    });
    expect(loadConfig(false)).toEqual({ default_repro: 'a', other: 1 });
    expect(fs.readFileSync(configFile(), 'utf8')).not.toContain('ephemeral-secret');
  });

  it('still finds state under the pre-rename RC_REPRO_HOME, and names it for doctor', () => {
    // Renaming without reading the old spelling would not have failed -- it would have
    // gone quiet: `list` empty and `up` making a second copy somewhere else.
    const legacy = path.join(os.tmpdir(), 'houston-legacy-home-probe');
    delete process.env.HOUSTON_HOME;
    process.env.RC_REPRO_HOME = legacy;
    expect(quietly(() => home())).toBe(legacy);
    expect(legacyEnvUsed()).toContain('RC_REPRO_HOME');
  });

  it('lets HOUSTON_HOME win when both spellings are set', () => {
    // Both set is the normal state of a box part-way through the migration.
    const fresh = process.env.HOUSTON_HOME as string;
    process.env.RC_REPRO_HOME = path.join(os.tmpdir(), 'houston-legacy-home-probe');
    expect(home()).toBe(fresh);
  });

  it('carries a pre-rename override through to the config layer, not only to home()', () => {
    process.env.RC_REPRO_REG_TOKEN = 'tok-from-legacy-env';
    expect(quietly(() => loadConfig().reg_token)).toBe('tok-from-legacy-env');
  });
});

describe('a home that does not exist yet', () => {
  it('is created 0700 with a 0600 config, whatever the umask', () => {
    // The per-test home above comes from mkdtemp, which is already 0700 -- so this is the
    // case that actually exercises the create: a pure-CLI box never runs `serve`, which is
    // what tightens a loose home, and this directory also holds the audit log, the
    // accounts file and the ACME material.
    const fresh = path.join(process.env.HOUSTON_HOME as string, 'fresh');
    process.env.HOUSTON_HOME = fresh;
    const before = process.umask(0o022);
    try {
      saveConfig({ bind_host: '127.0.0.1' });
    } finally {
      process.umask(before);
    }
    expect(fs.statSync(fresh).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(fresh, 'config.yaml')).mode & 0o777).toBe(0o600);
    fs.rmSync(path.dirname(fresh), { recursive: true, force: true });
  });
});

describe('who reads the shared loopback password', () => {
  // Sixty-odd call sites once read `ADMIN_PASSWORD` directly; they want the workspace's own
  // password, which falls back to this constant only for a loopback workspace. A MISSED
  // site authenticates with `admin123` against a workspace whose password is not that, and
  // gets a 401 that names nothing -- so the readers are walked rather than trusted.
  const ALLOWED = new Set([
    // Earlier releases' allow-list, file for file.
    'core/runner/record.ts',
    'lib/compose.ts',
    'seed/apply.ts',
    'core/configimport.ts',
    'core/rcapi.ts',
    'core/kube/chart.ts',
    'perf/k6.ts',
    // These two inline `meta.adminPassword || ADMIN_PASSWORD`, which is exactly the
    // fallback `adminPass(meta)` makes -- the workspace's own first.
    'core/lifecycle/notes.ts',
    'core/lifecycle/inspect.ts',
    // Names the shared password in the warning that a rebuild made public keeps it; it
    // authenticates with nothing.
    'core/lifecycle/request.ts',
  ]);

  function readers(): string[] {
    const src = path.join(ROOT, 'src');
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const rel = path.relative(src, full).split(path.sep).join('/');
          fs.readFileSync(full, 'utf8')
            .split('\n')
            .forEach((line, index) => {
              const code = line.trim();
              if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
              if (code === 'ADMIN_PASSWORD,' || code.startsWith('export const ADMIN_PASSWORD')) {
                return;
              }
              if (/(^|[^A-Z_])ADMIN_PASSWORD\b/u.test(line))
                found.push(`${rel}:${String(index + 1)}`);
            });
        }
      }
    };
    walk(src);
    return found;
  }

  it('is only the files allowed to, which want the constant itself', () => {
    const stray = readers().filter((hit) => !ALLOWED.has(hit.slice(0, hit.lastIndexOf(':'))));
    expect(stray).toEqual([]);
  });

  it('keeps an allow-list that still describes something', () => {
    const using = new Set(readers().map((hit) => hit.slice(0, hit.lastIndexOf(':'))));
    expect([...ALLOWED].filter((file) => !using.has(file))).toEqual([]);
  });
});

describe("the YAML indicator scalars earlier releases' reader refuses bare", () => {
  it('writes = and << as earlier releases write them, so they can read the file back', () => {
    // `config set bind_host =` wrote `bind_host: =`, which earlier releases resolve to the
    // value tag and refuse: every read of config.yaml by an earlier release was then a
    // `YamlTagError` (`<<` is the merge tag). Their neighbours are plain in both.
    const values = ['=', '<<', '==', '<', '=a', 'a<<', '<<<'];
    const ours = values.map((value) => stringifyConfigYaml({ bind_host: value }));
    // What earlier releases wrote for each value, and what they read back from exactly
    // these texts, recorded.
    const dumped = [
      "bind_host: '='\n",
      "bind_host: '<<'\n",
      'bind_host: ==\n',
      'bind_host: <\n',
      'bind_host: =a\n',
      'bind_host: a<<\n',
      'bind_host: <<<\n',
    ];
    const read = ['=', '<<', '==', '<', '=a', 'a<<', '<<<'];
    expect(ours).toEqual(dumped);
    expect(read).toEqual(values);
  });
});

describe("config.yaml's writer against earlier releases', byte for byte", () => {
  // Each value's `bind_host: <value>` document, as `config set` wrote it in earlier
  // releases, recorded per value in order.
  it('quotes a value holding a quote, and one led by a document marker, as earlier releases do', () => {
    // `config set bind_host ...` was written bare and `'q'` double-quoted, where earlier
    // releases write `'...'` and `'''q'''`: every value that needs quoting and holds a single
    // quote, and every one led by `---` or `...`.
    const alphabet = [' ', "'", 'a', '-', '.', '#', ':', '"'];
    const values = ['...', '---', '...a', '---a', "'q'", "it's"];
    for (const first of alphabet) {
      values.push(first);
      for (const second of alphabet) {
        values.push(first + second);
        for (const third of alphabet) values.push(first + second + third);
      }
    }
    expect(values.map((value) => stringifyConfigYaml({ bind_host: value }))).toEqual(
      RECORDED.quoted,
    );
  });

  it('folds a long double-quoted value at the 80th column as earlier releases do', () => {
    // A value holding non-ASCII, a tab or a control character is double-quoted, and earlier
    // releases fold one over 80 columns with `\` continuations; it was written on one line,
    // and a space before a line break was spelled `a\ \nb` where they write `"a \nb"`.
    const values = [
      'é '.repeat(50),
      'a \nb',
      `${'word\t'.repeat(20)}end`,
      `${'x'.repeat(70)} ${'y'.repeat(20)}\n${'z '.repeat(40)}`,
      ` ${'é'.repeat(100)} `,
      `${'a '.repeat(38)}  é${'b '.repeat(30)}`,
    ];
    for (let length = 70; length <= 100; length += 1) values.push(`${'é'.repeat(length)} e`);
    expect(values.map((value) => stringifyConfigYaml({ bind_host: value }))).toEqual(
      RECORDED.folded,
    );
  });

  it('rewrites a list and an alias as earlier releases do', () => {
    // A rewrite indented a list under its key and renamed the anchor `&a1`, where earlier
    // releases write `- a` at the key's column and `&id001`.
    const document = 'x: [a, [b, [c]]]\ny: &a [1]\nz: *a\n';
    // The file an earlier release left after setting `bind_host` over that document.
    const recorded = 'x:\n- a\n- - b\n  - - c\ny: &id001\n- 1\nz: *id001\nbind_host: 0.0.0.0\n';
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(configFile(), document, 'utf8');
    updateConfig((cfg) => {
      cfg.bind_host = '0.0.0.0';
    });
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(recorded);
    expect(recorded).toContain('x:\n- a\n- - b\n');
    expect(recorded).toContain('y: &id001\n');
  });
});

describe("a rewrite of a hand-edited config.yaml, against earlier releases'", () => {
  // Any `config set`, `config unset` or `use` rewrites the whole file, and the object this
  // build read it into could not hold what earlier releases' mapping holds: keys that are not
  // strings became strings (`1: a` as `'1': a`, `~: b` as `'': b`), an integer-like key moved
  // to the front, and an `!!omap` came back a mapping.
  const documents = [
    '1: a\n~: b\ntrue: c\n1.5: d\n',
    's: !!set {a}\nb: !!binary aGVsbG8=\no: !!omap [a: 1, b: 2]\np: !!pairs [a: 1, a: 2]\n',
    "bind_host: a\n'10': b\n'2': c\n",
    [
      'base: &b {x: [1], 2: two, y: 2026-01-01}',
      'derived: {<<: *b, z: 3, 1: one}',
      "'10': ten",
      'bind_host: 127.0.0.1',
      'n: {~: null, true: t, 1.0: f, 0: zero, false: no}',
      't: 2026-01-01 10:00:00.5+02:00',
      'd: *b',
      'empty: {}',
      "'2': two",
      '',
    ].join('\n'),
  ];
  const mutations: [string, (cfg: Record<string, unknown>) => void][] = [
    ['set bind_host 0.0.0.0', (cfg) => void (cfg.bind_host = '0.0.0.0')],
    ['unset bind_host', (cfg) => void delete cfg.bind_host],
    ['set acme_staging true', (cfg) => void (cfg.acme_staging = true)],
  ];

  it.each(documents.map((document, at) => [at, document]))(
    'writes document %i back as earlier releases do, whatever the command changed',
    (at, document) => {
      // The file an earlier release left after each change, in the order of `mutations`.
      const recorded = RECORDED.hand_edited[String(at)] as string[];
      expect(recorded).toHaveLength(mutations.length);
      for (const [index, [change, typescript]] of mutations.entries()) {
        fs.mkdirSync(home(), { recursive: true });
        fs.writeFileSync(configFile(), document, 'utf8');
        updateConfig(typescript);
        expect({ change, text: fs.readFileSync(configFile(), 'utf8') }).toEqual({
          change,
          text: recorded[index],
        });
      }
    },
  );

  it('keeps an integral float it read, key or value, as the float earlier releases write back', () => {
    // A float that holds an integral value was the number, which the writer spells as an
    // int: `custom_float: 1.0` came back from `up --pin` as `custom_float: 1`, `ratio: 3.0`
    // from `down --volumes` as `ratio: 3`, and a `3.0:` key as `3:`. A float and an int that
    // are equal are one key to earlier releases' mapping, which keeps the first it met.
    const document = [
      'custom_float: 1.0',
      'ratio: 3.0',
      'neg_zero: -0.0',
      'big: 1.0e+20',
      'under: 1_000.0',
      'sexagesimal: 1:30.0',
      'tagged: !!float 3',
      'tagged_int: !!int 3',
      'int: 3',
      'quoted: "3.0"',
      'shared: &f 5.0',
      'again: *f',
      'nested: {x: [2.0, 2], 4.0: four}',
      '3.0: float-key',
      '-0.0: negative-zero-key',
      '1: int-first',
      '1.0: float-second',
      '2.0: float-first',
      '2: int-second',
      '',
    ].join('\n');
    // The file an earlier release left after setting `default_repro` over that document.
    const recorded = RECORDED.integral_floats;
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(configFile(), document, 'utf8');
    updateConfig((cfg) => {
      cfg.default_repro = 'alpha';
    });
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(recorded);
    expect(recorded).toContain('custom_float: 1.0\nratio: 3.0\n');
    expect(recorded).toContain('3.0: float-key\n');
    // The object readers are handed still holds numbers.
    expect(loadConfig(false).ratio).toBe(3);
  });

  it('keeps an int past 2**53 digit for digit, key or value, as earlier releases write it back', () => {
    // The int grammar resolved to a double, which rounded `12345678901234567890` to
    // `12345678901234567000` in any rewrite; the constructed tree holds the exact int, as the
    // user preset reader needs it to.
    const document = [
      'big: 12345678901234567890',
      'neg: -12345678901234567890',
      'hex: 0x1FFFFFFFFFFFFFFFF',
      'octal: 0777777777777777777777',
      'sexagesimal: 1:0:0:0:0:0:0:0:0:0:0',
      'tagged: !!int 12345678901234567891',
      'safe: 9007199254740991',
      'nested: [12345678901234567890]',
      '12345678901234567890: key',
      '',
    ].join('\n');
    // The file an earlier release left after setting `default_repro` over that document.
    const recorded = RECORDED.big_ints;
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(configFile(), document, 'utf8');
    updateConfig((cfg) => {
      cfg.default_repro = 'alpha';
    });
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(recorded);
    expect(recorded).toContain('big: 12345678901234567890\n');
  });

  it('reads a key a plain object cannot hold without a warning on stderr, as earlier releases do', () => {
    // `toJS` warned through `process.emitWarning` for a date key: every command that read a
    // config.yaml holding `2026-01-01: note` printed `(node:<pid>) Warning: Keys with
    // collection values will be stringified ...`. Earlier releases print nothing.
    const document = 'default_repro: alpha\n2026-01-01: note\n';
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(configFile(), document, 'utf8');
    // An earlier release read that file silently (exit 0, nothing on stderr), then set
    // `bind_host` and left this file, recorded.
    const recorded = 'default_repro: alpha\n2026-01-01: note\nbind_host: 0.0.0.0\n';
    const warned = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
    try {
      expect(loadConfig(false).default_repro).toBe('alpha');
      updateConfig((cfg) => {
        cfg.bind_host = '0.0.0.0';
      });
      expect(warned.mock.calls).toEqual([]);
    } finally {
      warned.mockRestore();
    }
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(recorded);
  });

  it('still hands readers the object toJS built, and writes what a reader changed inside it', () => {
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(configFile(), "1: a\n'10': b\nnested: {k: [1]}\n", 'utf8');
    expect(loadConfig(false)).toEqual({ '1': 'a', '10': 'b', nested: { k: [1] } });
    updateConfig((cfg) => {
      ((cfg.nested as Record<string, unknown>).k as number[]).push(2);
    });
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(
      "1: a\n'10': b\nnested:\n  k:\n  - 1\n  - 2\n",
    );
  });
});

describe("the home's own id", () => {
  it('is made once, kept, private, and never silently replaced', () => {
    // What tells two homes apart on one cluster: it must not change between commands, or a
    // home would stop recognising the namespaces it made.
    const file = path.join(home(), HOME_ID_FILE);
    fs.rmSync(file, { force: true });
    const first = homeId();
    expect(first).toMatch(/^[0-9a-f]{16}$/u);
    expect(homeId()).toBe(first);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(home()).filter((entry) => entry.includes('.tmp'))).toEqual([]);
    // Damaged, it is refused rather than silently replaced: a new id would make every
    // namespace this home marked read as another home's.
    fs.writeFileSync(file, 'not an id\n');
    expect(() => homeId()).toThrow(/does not hold this home's id[\s\S]*kubectl get namespaces/u);
    expect(fs.readFileSync(file, 'utf8')).toBe('not an id\n');
    // Deleted on purpose, a new one is made.
    fs.rmSync(file);
    const second = homeId();
    expect(second).toMatch(/^[0-9a-f]{16}$/u);
    expect(second).not.toBe(first);
    // One that cannot be READ is not damaged, and deleting it is not the remedy: the usual
    // cause is a `sudo houston` that left it root's. A directory in its place cannot be read
    // by anyone, root included.
    fs.renameSync(file, `${file}.kept`);
    fs.mkdirSync(file);
    try {
      expect(() => homeId()).toThrow(/could not read [\s\S]*fix its permissions/u);
    } finally {
      fs.rmdirSync(file);
      fs.renameSync(`${file}.kept`, file);
    }
    expect(homeId()).toBe(second);
  });
});
