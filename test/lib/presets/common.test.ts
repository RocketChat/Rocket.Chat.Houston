import * as fs from 'node:fs';
import * as path from 'node:path';

import { isYamlDate } from '../../../src/lib/config';

import {
  intParam,
  k8sManifests,
  presetPort,
  presetPorts,
  safeDump,
  safeLoad,
  safeLoadAll,
  safeLoadOrdered,
  strParam,
  truthyParam,
} from '../../../src/lib/presets/common';

const ROOT = path.resolve(__dirname, '..', '..', '..');

/** Walk a parsed document by key path, checking each level rather than asserting it. */
function dig(value: unknown, ...keys: (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[String(key)];
  }
  return current;
}

/** The first document in a `---` stream with the given `kind`. */
function byKind(text: string, kind: string): unknown {
  return safeLoadAll(text).find((doc) => dig(doc, 'kind') === kind);
}

describe('the --set coercions', () => {
  it('reads a boolean the way a person types one', () => {
    const cases: [Record<string, unknown>, boolean][] = [
      [{}, false],
      [{ k: '1' }, true],
      [{ k: 'TRUE' }, true],
      [{ k: ' yes ' }, true],
      [{ k: 'On' }, true],
      [{ k: '0' }, false],
      [{ k: 'nope' }, false],
      [{ k: '' }, false],
      [{ k: '   ' }, false],
      [{ k: null }, false],
    ];
    for (const [params, expected] of cases) expect(truthyParam(params, 'k')).toBe(expected);
    // `--set k=` is ABSENT, not false: the default has to survive an empty value, which
    // is what the department flag depends on.
    expect(truthyParam({ k: '' }, 'k', true)).toBe(true);
    expect(truthyParam({ k: 'no' }, 'k', true)).toBe(false);
  });

  it('reads every boolean spelling, padded and empty ones included', () => {
    const spellings: [string, boolean][] = [
      ['1', true],
      ['true', true],
      ['TRUE', true],
      ['yes', true],
      ['on', true],
      ['0', false],
      ['false', false],
      ['no', false],
      ['off', false],
      ['x', false],
      [' 1 ', true],
      ['', false],
    ];
    expect(spellings.map(([v]) => [v, truthyParam({ k: v }, 'k')])).toEqual(spellings);
  });

  it('refuses a non-numeric integer with the message the CLI prints verbatim', () => {
    expect(intParam({}, 'users', 5)).toBe(5);
    expect(intParam({ users: '' }, 'users', 5)).toBe(5);
    expect(intParam({ users: '12' }, 'users', 5)).toBe(12);
    // `!r`, so the value is QUOTED. A message that says `--set users=abc` reads as if
    // `abc` were a token rather than the text somebody typed.
    expect(() => intParam({ users: 'abc' }, 'users', 5)).toThrow(
      "--set users='abc' expects a whole number",
    );
  });

  // An integer as earlier releases read one: underscores between digits, any Unicode decimal
  // digit, their whitespace, a sign -- `--set users=1_0` builds user1..user10 and `users=٣`
  // is 3. A JSON number truncates and a bool counts, as they have them; a list is refused.
  it.each<[unknown, number]>([
    ['1_0', 10],
    ['130_000', 130000],
    ['٣', 3],
    ['１２', 12],
    [' 12 ', 12],
    ['+5', 5],
    ['-0', 0],
    ['007', 7],
    ['', 5],
    [5.7, 5],
    [true, 1],
  ])('reads the integer %j as earlier releases do: %j', (value, expected) => {
    expect(intParam({ users: value }, 'users', 5)).toBe(expected);
  });

  it.each<[unknown, string]>([
    ['\u001c7', "--set users='\\x1c7' expects a whole number"],
    ['\ufeff7', "--set users='\\ufeff7' expects a whole number"],
    ['1__0', "--set users='1__0' expects a whole number"],
    ['_1', "--set users='_1' expects a whole number"],
    ['1e3', "--set users='1e3' expects a whole number"],
    ['12.0', "--set users='12.0' expects a whole number"],
    ['0x10', "--set users='0x10' expects a whole number"],
    [[1], '--set users=[1] expects a whole number'],
  ])('refuses the integer %j as earlier releases do', (value, message) => {
    expect(() => intParam({ users: value }, 'users', 5)).toThrow(message);
  });

  it('reads a string, treating empty as absent', () => {
    expect(strParam({}, 'domain', 'example.com')).toBe('example.com');
    expect(strParam({ domain: '' }, 'domain', 'example.com')).toBe('example.com');
    expect(strParam({ domain: 'a.b' }, 'domain', 'example.com')).toBe('a.b');
  });
});

describe('the port registry lookups', () => {
  it('answers the same numbers config declares', () => {
    expect(presetPorts('s3_minio', {})).toEqual([9000, 9001]);
    expect(presetPort('s3_minio', 1, {})).toBe(9001);
    expect(presetPort('ldap', 0, {})).toBe(8082);
  });

  it("answers a workspace's own ports where it has them, and the registry's elsewhere", () => {
    // Sparse, as a record keeps only what moved: Mailpit at 8026, everything else preferred.
    const ports = { email: [8026], s3_minio: [9002, 9003] };
    expect(presetPort('email', 0, ports)).toBe(8026);
    expect(presetPorts('s3_minio', ports)).toEqual([9002, 9003]);
    expect(presetPort('ldap', 0, ports)).toBe(8082);
  });

  it('raises rather than answering undefined for a preset with no reservation', () => {
    // A preset publishing a port nothing reserved is the collision PRESET_PORTS exists to
    // prevent; answering `undefined` would put that port in the compose file anyway.
    expect(() => presetPorts('not-a-preset', {})).toThrow(
      'no port is reserved for the preset "not-a-preset"',
    );
    expect(() => presetPort('ldap', 4, {})).toThrow(
      'the preset "ldap" has no reserved port at index 4',
    );
  });
});

describe('the YAML dumper', () => {
  it('quotes what YAML 1.1 would otherwise read as something else', () => {
    // `'1'`, `'true'` and `'on'` are strings in a manifest and numbers/booleans to a 1.1
    // reader. Earlier releases' dumper quotes them; a dumper that does not hands kubectl a different
    // document.
    const text = safeDump({ a: '1', b: 'true', c: 'on', d: 'plain', e: 1, f: true });
    expect(text).toBe("a: '1'\nb: 'true'\nc: 'on'\nd: plain\ne: 1\nf: true\n");
  });

  it('keeps declaration order rather than sorting keys', () => {
    expect(safeDump({ z: 1, a: 2, m: 3 })).toBe('z: 1\na: 2\nm: 3\n');
  });

  it('emits a sequence at the parent indent, as earlier releases do', () => {
    expect(safeDump({ ports: [{ containerPort: 80 }] })).toBe('ports:\n- containerPort: 80\n');
  });

  it('aliases a repeated node instead of writing it twice', () => {
    // Earlier releases emit `&id001`/`*id001` for a mapping referenced twice in one document, and the
    // shared `labels` bag in every Deployment here is exactly that.
    const labels = { app: 'x' };
    expect(safeDump({ a: labels, b: labels })).toBe('a: &id001\n  app: x\nb: *id001\n');
  });

  it('round-trips through its own reader', () => {
    const doc = { a: '1', b: ['x', 'y'], c: { d: true } };
    expect(safeLoad(safeDump(doc))).toEqual(doc);
  });
});

describe('the shared Kubernetes rendering', () => {
  const rendered = () =>
    k8sManifests({
      name: 'mailpit',
      image: 'img:1',
      ports: [
        [8025, 8025],
        [1025, 1025],
      ],
      env: { A: '1' },
      readiness: { httpGet: { path: '/', port: 8025 } },
      ui: { mailpit: [8025, 8025] },
    });

  it('publishes EVERY port the workload listens on, not only the host-published one', () => {
    // Reported from a live workspace: SMTP_Host=mailpit, SMTP_Port=1025, container
    // listening on 1025, Service exposing 8025 alone -- so the browser could read the
    // inbox and Rocket.Chat could not deliver to it.
    const service = byKind(rendered(), 'Service');
    expect((dig(service, 'spec', 'ports') as { port: number }[]).map((p) => p.port)).toEqual([
      8025, 1025,
    ]);
  });

  it('puts the published port first, because the forwarder reads .spec.ports[0]', () => {
    const service = byKind(
      k8sManifests({
        name: 'thing',
        image: 'img:1',
        ports: [
          [1025, 1025],
          [8025, 8025],
        ],
        ui: { thing: [8025, 8025] },
      }),
      'Service',
    );
    expect(dig(service, 'spec', 'ports', 0, 'port')).toBe(8025);
    expect(dig(service, 'metadata', 'labels', 'houston.io/ui-port')).toBe('8025');
  });

  it('gives a second published port its own Service, naming the workload', () => {
    // A label value cannot carry a list, so MinIO's console cannot ride on the API
    // Service's label -- it gets a Service that points back with `ui-deployment`.
    const rendered_ = k8sManifests({
      name: 'minio',
      image: 'img:1',
      ports: [
        [9000, 9000],
        [9001, 9001],
      ],
      ui: { minio: [9000, 9000], 'minio-console': [9001, 9001] },
    });
    const console_ = safeLoadAll(rendered_).find(
      (doc) => dig(doc, 'metadata', 'name') === 'minio-console',
    );
    expect(dig(console_, 'metadata', 'labels', 'houston.io/ui-deployment')).toBe('minio');
    expect(dig(console_, 'metadata', 'labels', 'houston.io/ui-port')).toBe('9001');
  });

  it('mounts a ConfigMap only when there are files to mount', () => {
    const text = k8sManifests({
      name: 'w',
      image: 'img:1',
      ports: [[80, 80]],
      files: { 'index.html': '<p>hi</p>' },
      mounts: [{ name: 'files', mountPath: '/x', subPath: 'index.html' }],
    });
    const withFiles = safeLoadAll(text);
    expect(dig(withFiles[0], 'kind')).toBe('ConfigMap');
    expect(dig(withFiles[0], 'metadata', 'name')).toBe('w-files');
    const deployment = byKind(text, 'Deployment');
    expect(dig(deployment, 'spec', 'template', 'spec', 'volumes', 0, 'configMap', 'name')).toBe(
      'w-files',
    );

    expect(safeLoadAll(rendered()).some((doc) => dig(doc, 'kind') === 'ConfigMap')).toBe(false);
  });

  it('renders the whole Deployment and Service, read back as these documents', () => {
    const labels = {
      app: 'houston-mailpit',
      'app.kubernetes.io/managed-by': 'houston',
      'houston.io/component': 'mailpit',
      'houston.io/repro': '__HOUSTON_NAME__',
    };
    expect(safeLoadAll(rendered())).toEqual([
      {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: { name: 'mailpit', labels },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: 'houston-mailpit' } },
          template: {
            metadata: { labels },
            spec: {
              containers: [
                {
                  name: 'mailpit',
                  image: 'img:1',
                  ports: [{ containerPort: 8025 }, { containerPort: 1025 }],
                  env: [{ name: 'A', value: '1' }],
                  readinessProbe: { httpGet: { path: '/', port: 8025 } },
                },
              ],
            },
          },
        },
      },
      {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'mailpit', labels: { ...labels, 'houston.io/ui-port': '8025' } },
        spec: {
          selector: { app: 'houston-mailpit' },
          ports: [
            { name: 'p8025', port: 8025, targetPort: 8025 },
            { name: 'p1025', port: 1025, targetPort: 1025 },
          ],
        },
      },
    ]);
  });
});

describe('the three --set helpers together', () => {
  it('read a boolean, an integer and a string with their defaults', () => {
    expect(truthyParam({ x: 'YES' }, 'x')).toBe(true);
    expect(truthyParam({ x: '0' }, 'x')).toBe(false);
    expect(truthyParam({}, 'x', true)).toBe(true);
    expect(intParam({ n: '7' }, 'n', 5)).toBe(7);
    expect(intParam({ n: '' }, 'n', 5)).toBe(5);
    expect(intParam({}, 'n', 5)).toBe(5);
    expect(strParam({ b: '' }, 'b', 'd')).toBe('d');
    expect(strParam({ b: 'x' }, 'b', 'd')).toBe('x');
  });
});

/**
 * A key a mapping names twice. Earlier releases keep the LAST value, in the place the FIRST one
 * took, and never refuses the document; the yaml library's default refused it, so a user
 * preset with a doubled key was UNREADABLE here and a preset there, and a doubled key in
 * config.yaml ended every command with a stack.
 */
describe("a doubled key, as earlier releases' YAML reader reads it", () => {
  // Each document, what all three readers make of it, and the key order the ordered reader
  // keeps (`null` where the document is not a mapping).
  it.each<[string, unknown, string[] | null]>([
    [
      'name: a\ndescription: first\nname: b\n',
      { name: 'b', description: 'first' },
      ['name', 'description'],
    ],
    ['env:\n  X: 1\n  W: 2\n  X: 3\n', { env: { X: 3, W: 2 } }, ['env']],
    [
      'params_help: {users: u, "10": ten, users: again}\n',
      { params_help: { '10': 'ten', users: 'again' } },
      ['params_help'],
    ],
    ['- {a: 1, a: 2}\n- a\n', [{ a: 2 }, 'a'], null],
    ['a: 1\nb: 2\na: {c: 1}\na: 3\n', { a: 3, b: 2 }, ['a', 'b']],
  ])('keeps the last value where the first one stood in %j', (text, expected, order) => {
    expect(safeLoad(text)).toEqual(expected);
    expect(safeLoadAll(text)).toEqual([expected]);
    const doc = safeLoadOrdered(text);
    expect(doc instanceof Map ? [...doc.keys()].map(String) : null).toEqual(order);
  });

  it('is how every YAML read in this build is made', () => {
    // A read added later without the option would refuse a document earlier releases read,
    // and nothing else here would notice: the documents this build writes never double
    // a key. Each call must pass `uniqueKeys: false`, or YAML11_OPTIONS, which does.
    const SRC = path.join(ROOT, 'src');
    const calls: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name.endsWith('.ts')) {
          const text = fs.readFileSync(file, 'utf8');
          for (const match of text.matchAll(
            /YAML\.(?:parse|parseDocument|parseAllDocuments)\(/gu,
          )) {
            const at = match.index;
            let depth = 0;
            let end = at + match[0].length - 1;
            for (; end < text.length; end += 1) {
              if (text[end] === '(') depth += 1;
              else if (text[end] === ')' && --depth === 0) break;
            }
            calls.push(
              `${path.relative(SRC, file)}: ${text.slice(at, end + 1).replace(/\s+/gu, ' ')}`,
            );
          }
        }
      }
    };
    walk(SRC);
    // Six direct reads: the preset, config.yaml, compose-document and values.yaml readers go
    // through config.safeLoadYaml, whose one parseDocument is among them. (Eight until
    // readCompose's own YAML 1.2 parse became a safeLoadYaml; seven until recordNewTag's
    // did.)
    expect(calls.length).toBeGreaterThanOrEqual(6);
    expect(calls.filter((call) => !/uniqueKeys: false|YAML11_OPTIONS/u.test(call))).toEqual([]);
    const config = fs.readFileSync(path.join(SRC, 'lib', 'config.ts'), 'utf8');
    expect(/YAML11_OPTIONS = \{[^}]*uniqueKeys: false/u.test(config)).toBe(true);
  });
});

/**
 * A preset's scalars, resolved as earlier releases resolve them. The yaml library's own YAML 1.1
 * schema reads `y`/`Y`/`n`/`N` as booleans and parts ways on dotless exponents, leading-dot
 * floats, sexagesimals starting with 0 and single-digit months -- so `env: {Y: 2}` had the
 * key `true` rather than `'Y'`. The readers use config.ts's resolution, which is earlier releases'.
 */
describe("a preset's scalars, as earlier releases' YAML reader resolves them", () => {
  /** `[type, value]`: `1.0` and `1` are both a number, and NaN and the infinities are named. */
  function tag(value: unknown): [string, unknown] {
    if (value === null) return ['null', null];
    if (typeof value === 'boolean') return ['boolean', value];
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return ['number', 'nan'];
      if (!Number.isFinite(value)) return ['number', value > 0 ? 'inf' : '-inf'];
      return ['number', value];
    }
    if (isYamlDate(value)) return ['date', value.toISOString().slice(0, 10)];
    if (value instanceof Date) return ['datetime', value.toISOString().replace('.000Z', 'Z')];
    return [typeof value, value];
  }

  it.each<[string, string, unknown]>([
    ['yes', 'boolean', true],
    ['Yes', 'boolean', true],
    ['no', 'boolean', false],
    ['NO', 'boolean', false],
    ['on', 'boolean', true],
    ['Off', 'boolean', false],
    ['true', 'boolean', true],
    ['False', 'boolean', false],
    ['y', 'string', 'y'],
    ['Y', 'string', 'Y'],
    ['n', 'string', 'n'],
    ['N', 'string', 'N'],
    ['t', 'string', 't'],
    ['F', 'string', 'F'],
    ['1e5', 'string', '1e5'],
    ['2E3', 'string', '2E3'],
    ['1e+5', 'string', '1e+5'],
    ['1.5e5', 'string', '1.5e5'],
    ['.5e5', 'string', '.5e5'],
    ['1e5x', 'string', '1e5x'],
    ['1_000e5', 'string', '1_000e5'],
    ['1e', 'string', '1e'],
    ['0755', 'number', 493],
    ['0o755', 'string', '0o755'],
    ['0b101', 'number', 5],
    ['0x10', 'number', 16],
    ['12:30:45', 'number', 45045],
    ['1:20', 'number', 80],
    ['0:00:00', 'string', '0:00:00'],
    ['1:20:30.5', 'number', 4830.5],
    ['123', 'number', 123],
    ['-42', 'number', -42],
    ['+42', 'number', 42],
    ['1_000', 'number', 1000],
    ['1_000.5', 'number', 1000.5],
    ['2026-09-17', 'date', '2026-09-17'],
    ['2026-9-17', 'string', '2026-9-17'],
    ['2026-09-17T12:00:00Z', 'datetime', '2026-09-17T12:00:00Z'],
    ['inf', 'string', 'inf'],
    ['.inf', 'number', 'inf'],
    ['-.inf', 'number', '-inf'],
    ['nan', 'string', 'nan'],
    ['.nan', 'number', 'nan'],
    ['.NaN', 'number', 'nan'],
    ['1.5', 'number', 1.5],
    ['.5', 'number', 0.5],
    ['1.', 'number', 1],
    ['.', 'string', '.'],
    ['null', 'null', null],
    ['Null', 'null', null],
    ['~', 'null', null],
    ['1,000', 'string', '1,000'],
    ['a b', 'string', 'a b'],
  ])('reads %j as a value, as a key and in a stream as a %s', (cell, type, value) => {
    expect(tag((safeLoad(`k: ${cell}`) as Record<string, unknown>).k)).toEqual([type, value]);
    expect(tag((safeLoadAll(`k: ${cell}`)[0] as Record<string, unknown>).k)).toEqual([type, value]);
    const key = [...(safeLoadOrdered(`${cell}: v`) as Map<unknown, unknown>).keys()][0];
    expect(tag(key)).toEqual([type, value]);
  });

  it('reads -0.0 as negative zero, and as key 0, which is all a Map key can hold', () => {
    // A Map key is compared SameValueZero, so `-0.0` is key 0: no reader can recover it.
    expect(Object.is((safeLoad('k: -0.0') as Record<string, unknown>).k, -0)).toBe(true);
    expect(Object.is((safeLoadAll('k: -0.0')[0] as Record<string, unknown>).k, -0)).toBe(true);
    const key = [...(safeLoadOrdered('-0.0: v') as Map<unknown, unknown>).keys()][0];
    expect(Object.is(key, 0)).toBe(true);
  });
});

/**
 * Earlier releases' YAML reader's refusals, which the yaml library only warns about or
 * enforces where earlier releases do not: a tag the safe loader has no constructor for is refused --
 * the yaml library read `name: !foo bar` as the string `bar` and printed a Node warning --
 * and a hundred aliases of one anchor are a document, where the yaml library's default
 * alias budget refused it.
 */
describe("earlier releases' YAML refusals and allowances", () => {
  it.each([
    [
      'name: !foo bar\n',
      "could not determine a constructor for the tag '!foo'\n" +
        '  at line 1, column 7:\n' +
        '    name: !foo bar\n' +
        '          ^',
    ],
    [
      'a: 1\nlist:\n  - x\n  - !!script/object:run.shell x\n',
      "could not determine a constructor for the tag 'tag:yaml.org,2002:script/object:run.shell'\n" +
        '  at line 4, column 5:\n' +
        '      - !!script/object:run.shell x\n' +
        '        ^',
    ],
  ])('refuses %j as an unknown tag, in its words', (text, message) => {
    let caught: unknown;
    try {
      safeLoad(text);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect([(caught as Error).name, (caught as Error).message]).toEqual(['YamlTagError', message]);
  });

  it('reads a hundred and twenty aliases of one anchor', () => {
    const text =
      'a: &x [1]\n' + Array.from({ length: 120 }, (_, i) => `b${String(i)}: *x`).join('\n') + '\n';
    const doc = safeLoad(text) as Record<string, unknown>;
    expect(Object.keys(doc)).toHaveLength(121);
    expect(doc['b119']).toEqual([1]);
  });

  it('reads a plain document', () => {
    expect(safeLoad('name: plain\n')).toEqual({ name: 'plain' });
  });
});
