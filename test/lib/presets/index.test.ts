import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../../../src/lib/config';

import { safeLoadAll } from '../../../src/lib/presets/common';
import {
  listPresets,
  load,
  paramsHelpItems,
  parse,
  resolve,
  scenarioNames,
  userPath,
} from '../../../src/lib/presets/index';
import type { Preset } from '../../../src/lib/presets/types';

/**
 * What earlier releases answered for each case below, recorded against the same presets
 * directory contents. `cases` holds each answer by a key naming the call and its inputs; a
 * preset in an answer is an id into `presets`, which holds each distinct preset once, as
 * earlier releases dumped it. The presets directory the answers were recorded in is spelled
 * `{PRESET_DIR}`, and read back as this test's own.
 */
const RECORDING = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'lib', 'presets', 'index.json'),
    'utf8',
  ),
) as { cases: Record<string, unknown>; presets: Record<string, Record<string, unknown>> };

/** `value`, with the recording's presets directory spelled as this test's. */
function localised(value: unknown): unknown {
  if (typeof value === 'string') return value.split('{PRESET_DIR}').join(config.presetDir());
  if (Array.isArray(value)) return value.map(localised);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localised(v)]));
  }
  return value;
}

/** The recorded answer for `key`, which must exist. */
function recorded(key: string): unknown {
  expect(Object.keys(RECORDING.cases)).toContain(key);
  return localised(RECORDING.cases[key]);
}

/** The recorded preset with this id, as earlier releases dumped it. */
function recordedPreset(id: unknown): Record<string, unknown> {
  expect(Object.keys(RECORDING.presets)).toContain(id);
  return localised(RECORDING.presets[id as string]) as Record<string, unknown>;
}

/** A recorded listing: the presets in order, or what was raised instead. */
function recordedListing(
  key: string,
): ['ok', Record<string, unknown>[]] | ['raised', string, string] {
  const answer = recorded(key) as ['ok', string[]] | ['raised', string, string];
  return answer[0] === 'ok' ? ['ok', answer[1].map(recordedPreset)] : answer;
}

/** Presets added since the recorded catalogue; each has its own complete contract spec. */
const NEW_PRESETS: readonly string[] = ['e2ee', 'voice', 'webhooks'];

/** Keep every old row byte-exact. */
function legacyCatalogue(): Preset[] {
  const rows = listPresets();
  for (const name of NEW_PRESETS) {
    expect(rows.filter((preset) => preset.name === name)).toHaveLength(1);
  }
  return rows.filter((preset) => !NEW_PRESETS.includes(preset.name));
}

/** Every field a Preset carries, paired with the snake_case name earlier releases dump. */
const FIELDS: readonly (readonly [keyof Preset, string])[] = [
  ['name', 'name'],
  ['description', 'description'],
  ['env', 'env'],
  ['services', 'services'],
  ['rocketchat', 'rocketchat'],
  ['dependsOn', 'depends_on'],
  ['requiresLicense', 'requires_license'],
  ['source', 'source'],
  ['files', 'files'],
  ['paramsHelp', 'params_help'],
  ['postReady', 'post_ready'],
  ['notes', 'notes'],
  ['instances', 'instances'],
  ['entryService', 'entry_service'],
  ['extra', 'extra'],
  ['volumes', 'volumes'],
  ['ports', 'ports'],
  ['topology', 'topology'],
  ['scenario', 'scenario'],
  ['scenarioParams', 'scenario_params'],
  ['error', 'error'],
];

/**
 * Compare one preset field by field.
 *
 * `kubernetes_manifests` is compared PARSED and everything else byte for byte. The
 * manifests are the one artifact whose only consumer is `kubectl apply -f -`, and earlier
 * releases' YAML emitter and this one fold a long scalar at the same width and spell the
 * break differently --
 * see the note on `safeDump`. Everything else here is written to disk or printed to a
 * person, so for those the bytes are the contract.
 */
function expectSame(ours: Preset, expected: Record<string, unknown>): void {
  for (const [key, recordedKey] of FIELDS) {
    expect({ [String(key)]: ours[key] }).toEqual({ [String(key)]: expected[recordedKey] });
  }
  const mine = ours.kubernetesManifests.map((m) => safeLoadAll(m));
  const yours = (expected.kubernetes_manifests as string[]).map((m) => safeLoadAll(m));
  expect(mine).toEqual(yours);
}

describe('the shipped catalogue', () => {
  it('preserves the recorded names and adds the E2EE, voice and webhooks scenarios in sorted order', () => {
    expect(scenarioNames()).toEqual(
      [...(recorded('scenario_names') as string[]), ...NEW_PRESETS].sort(),
    );
  });

  it.each([
    'default',
    'airgapped',
    'email',
    'ldap',
    'livechat',
    'multi-instance',
    'oidc',
    's3_minio',
    'saml',
  ])('resolves %s exactly as earlier releases do', (name) => {
    expectSame(load(name), recordedPreset(recorded(`load ${name}`)));
  });

  it.each([
    ['saml', { users: '2' }],
    ['oidc', { idp_host: 'box.example' }],
    ['email', { verification: 'yes' }],
    ['livechat', { agents: '3', registration: '1', department: '0' }],
    ['s3_minio', { presigned: 'true', bucket: 'my.bucket' }],
    ['multi-instance', { instances: '9' }],
    ['ldap', { users: '2', domain: 'a.b.c' }],
  ] as const)('resolves %s with params exactly as earlier releases do', (name, params) => {
    expectSame(
      load(name, params),
      recordedPreset(recorded(`load ${name} ${JSON.stringify(params)}`)),
    );
  });

  it('resolves the ldap scenario through both of its adapters', () => {
    for (const target of ['docker', 'kubernetes']) {
      expectSame(resolve('ldap', target), recordedPreset(recorded(`resolve ldap ${target}`)));
    }
    // The two adapters are not the same preset wearing a different hat: only one declares
    // a topology, and only one needs a licence.
    expect(resolve('ldap', 'docker').topology).toBe('');
    expect(resolve('ldap', 'kubernetes').topology).toBe('kubernetes');
    expect(resolve('ldap', 'kubernetes').requiresLicense).toBe(true);
    // And BOTH declare the phpLDAPadmin port, which the Kubernetes one did not: with an
    // empty `ports` list the sidecar pre-flight returns immediately, so a second
    // Kubernetes LDAP workspace got no refusal and its forward simply failed to bind.
    expect(resolve('ldap', 'kubernetes').ports).toEqual([8082]);
  });

  it('clamps the instance count the way earlier releases clamp it', () => {
    expect(load('multi-instance', { instances: '1' }).instances).toBe(2);
    expect(load('multi-instance', { instances: '9' }).instances).toBe(5);
    expect(load('multi-instance', { instances: '3' }).instances).toBe(3);
  });
});

describe('a preset name is a name, never a path', () => {
  it('refuses anything that could be read as a path', () => {
    // Joining the presets directory with an ABSOLUTE name discards the directory, so
    // `--preset /tmp/x` resolved to `/tmp/x.yaml` in earlier releases -- and a preset is a
    // container spec whose `services:` is merged into the compose document. Node's
    // `path.join` never had that rule; the check is here because the guarantee callers
    // rely on is "a name, validated once".
    for (const bad of ['/tmp/x', '../etc/passwd', 'Upper', 'has space', '_leading', '', 'a/b']) {
      expect(() => userPath(bad)).toThrow('is not a preset name');
    }
    for (const good of ['ldap', 's3_minio', 'multi-instance', 'a1']) {
      expect(userPath(good)).toBe(path.join(config.presetDir(), `${good}.yaml`));
    }
  });

  it('refuses it through load, resolve AND listPresets, not two of the three', () => {
    expect(() => load('/tmp/x')).toThrow('is not a preset name');
    expect(() => resolve('/tmp/x')).toThrow('is not a preset name');
  });

  it('says the same words earlier releases say', () => {
    let said = '';
    try {
      userPath('../etc/passwd');
    } catch (error) {
      said = error instanceof Error ? error.message : String(error);
    }
    expect(said).toBe(recorded('user_path_refusal'));
  });
});

describe('a user file', () => {
  function writeUserPreset(name: string, text: string): void {
    fs.mkdirSync(config.presetDir(), { recursive: true });
    fs.writeFileSync(path.join(config.presetDir(), `${name}.yaml`), text, 'utf8');
  }

  it('shadows even a dynamic preset', () => {
    writeUserPreset('saml', 'name: saml\ndescription: mine\nenv:\n  A: "1"\n');
    const mine = load('saml');
    expect(mine.description).toBe('mine');
    expect(mine.services).toEqual({});
    expectSame(mine, recordedPreset(recorded('user saml')));
  });

  it('is never interpreted as a scenario, whatever deployment type is asked for', () => {
    writeUserPreset('ldap', 'name: ldap\ndescription: mine\n');
    expect(resolve('ldap', 'docker').description).toBe('mine');
    expectSame(resolve('ldap', 'docker'), recordedPreset(recorded('user ldap docker')));
  });

  it('refuses when it declares a deployment type the caller did not ask for', () => {
    writeUserPreset('pinned', 'name: pinned\ntopology: kubernetes\n');
    expect(() => resolve('pinned', 'docker')).toThrow(
      "preset 'pinned' declares deployment type 'kubernetes', not 'docker'",
    );
    // Unset means "use the preset's own declared topology", which is not a refusal.
    expect(resolve('pinned').topology).toBe('kubernetes');
  });

  it('is reported by name when it is unreadable, rather than taking out the catalogue', () => {
    // One bad file used to take out `houston presets`, `/api/presets` and the create
    // dialog -- and `capabilities` guards its own call with a bare except, so the failure
    // became silence and a report of ZERO presets.
    writeUserPreset('broken', '- not\n- a\n- mapping\n');
    writeUserPreset('fine', 'name: fine\ndescription: ok\n');
    const names = listPresets().map((p) => p.name);
    expect(names).toContain('broken');
    expect(names).toContain('fine');
    expect(names).toContain('saml');
    const broken = listPresets().find((p) => p.name === 'broken');
    expect(broken?.description.startsWith('UNREADABLE — ')).toBe(true);
    expect(broken?.error).toContain('not a mapping');
  });

  it('gives the same catalogue earlier releases give, in the same order', () => {
    writeUserPreset('zzz', 'name: zzz\ndescription: last\n');
    const expected = (recorded('catalogue with zzz') as string[]).map(recordedPreset);
    const ours = legacyCatalogue();
    expect(ours.map((p) => p.name)).toEqual(expected.map((p) => p.name));
    for (let i = 0; i < ours.length; i += 1) {
      expectSame(ours[i] as Preset, expected[i] as Record<string, unknown>);
    }
  });
});

/**
 * Earlier releases hold the catalogue in an insertion-ordered map and list it sorted by
 * code point; a plain object and `Array.prototype.sort` are neither. Each file below was a
 * different `houston presets` (t1-presets verifier, measured) and is compared with earlier
 * releases' recorded reading of the same directory, then removed so the tests after see
 * the catalogue they expect.
 */
describe('the catalogue, as earlier releases order and sort it', () => {
  // `null` is a directory where a file is expected.
  const FILES: readonly (readonly [string, string | null])[] = [
    // UTF-16 puts the astral emoji below U+FF21; code points put it above.
    ['😀-emoji.yaml', 'name: 😀-emoji\ndescription: astral\n'],
    ['Ａ-fullwidth.yaml', 'name: Ａ-fullwidth\ndescription: above the surrogates\n'],
    // Two files, one name: the one sorted last by code point is the one that is listed.
    ['Ａ.yaml', 'name: shared\ndescription: from the fullwidth file\n'],
    ['😀.yaml', 'name: shared\ndescription: from the emoji file\n'],
    ['proto.yaml', 'name: __proto__\ndescription: a key like any other\n'],
    ['.yaml', '- a list\n'],
    ['folder.yaml', null],
    [
      'ordered.yaml',
      'name: ordered\ndescription: keys as written\nparams_help:\n' +
        '  users: u\n  "10": ten\n  alpha: a\n  "0": zero\n',
    ],
  ];

  function withFiles(check: () => void): void {
    const dir = config.presetDir();
    fs.mkdirSync(dir, { recursive: true });
    try {
      for (const [file, text] of FILES) {
        if (text === null) fs.mkdirSync(path.join(dir, file));
        else fs.writeFileSync(path.join(dir, file), text, 'utf8');
      }
      check();
    } finally {
      for (const [file] of FILES) fs.rmSync(path.join(dir, file), { recursive: true, force: true });
    }
  }

  it('lists what earlier releases list, in their order, each unreadable file named as they name it', () => {
    withFiles(() => {
      const expected = (recorded('catalogue with the sorting files') as string[]).map(
        recordedPreset,
      );
      const ours = legacyCatalogue();
      expect(ours.map((p) => p.name)).toEqual(expected.map((p) => p.name));
      ours.forEach((preset, at) => expectSame(preset, expected[at] as Record<string, unknown>));
      // Named, so a failure says which of them regressed.
      const names = ours.map((p) => p.name);
      expect(names.indexOf('Ａ-fullwidth')).toBeLessThan(names.indexOf('😀-emoji'));
      expect(ours.find((p) => p.name === 'shared')?.description).toBe('from the emoji file');
      expect(names).toContain('__proto__');
      expect(ours.find((p) => p.name === '.yaml')?.error).toContain('is a list, not a mapping');
      expect(ours.find((p) => p.name === 'folder')?.error).toBe(
        `${path.join(config.presetDir(), 'folder.yaml')}: Is a directory`,
      );
    });
  });

  it("gives params_help's keys in the file's order, as earlier releases hold them", () => {
    withFiles(() => {
      const expected = recorded('ordered params_help') as [string, string][];
      expect(expected.map(([key]) => key)).toEqual(['users', '10', 'alpha', '0']);
      expect(paramsHelpItems(load('ordered').paramsHelp)).toEqual(expected);
      const listed = listPresets().find((p) => p.name === 'ordered') as Preset;
      expect(paramsHelpItems(listed.paramsHelp)).toEqual(expected);
    });
  });
});

/**
 * A user presets directory, or a file in it, that `houston presets` read differently from
 * earlier releases (each measured against them): a presets path that is a file or cannot be
 * listed, a file that is not UTF-8, `requires_license: .nan`, ports that are no integer,
 * and notes or ports that are no list. Each is compared with earlier releases' recorded
 * listing of the same directory -- including where they raised out of it, which this must
 * do with the same exception and sentence.
 */
describe('a user presets directory earlier releases read their own way', () => {
  function expectListingSame(key: string): void {
    const expected = recordedListing(key);
    let ours: Preset[];
    try {
      ours = legacyCatalogue();
    } catch (error) {
      expect(['raised', (error as Error).constructor.name, (error as Error).message]).toEqual(
        expected,
      );
      return;
    }
    expect(expected[0]).toBe('ok');
    const listed = expected[1] as Record<string, unknown>[];
    expect(ours.map((p) => p.name)).toEqual(listed.map((p) => p.name));
    ours.forEach((preset, at) => expectSame(preset, listed[at] as Record<string, unknown>));
  }

  function withUserDir(make: (dir: string) => void, check: () => void): void {
    const dir = config.presetDir();
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      make(dir);
      check();
    } finally {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) fs.chmodSync(dir, 0o700);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('lists the catalogue when the presets path is a file, or a directory it cannot list', () => {
    withUserDir(
      (dir) => {
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        fs.writeFileSync(dir, 'not a directory\n');
      },
      () => {
        expectListingSame('presets path is a file');
      },
    );
    withUserDir(
      (dir) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'hidden.yaml'), 'name: hidden\n');
        fs.chmodSync(dir, 0o000);
      },
      () => {
        expectListingSame('presets dir unlistable');
        expect(listPresets().map((p) => p.name)).not.toContain('hidden');
      },
    );
  });

  const FILES: readonly (readonly [string, Buffer])[] = [
    ['license-nan', Buffer.from('name: q\nrequires_license: .nan\n')],
    ['license-inf', Buffer.from('name: q\nrequires_license: -.inf\n')],
    ['license-zero', Buffer.from('name: q\nrequires_license: 0.0\n')],
    ['license-empty', Buffer.from('name: q\nrequires_license: []\n')],
    ['not-utf8', Buffer.from('name: q\ndescription: "a\xffb"\n', 'latin1')],
    ['cut-short', Buffer.from('name: q\n# \xe2\x82', 'latin1')],
    ['bad-continuation', Buffer.from('name: q\n# \xf0\x9f\x98\x28\n', 'latin1')],
    ['surrogate', Buffer.from('name: q\n# \xed\xa0\x80\n', 'latin1')],
    ['bom', Buffer.from('\ufeffname: q\ndescription: kept\n')],
    ['ports-refused', Buffer.from('name: q\nports: [abc]\n')],
    ['ports-read', Buffer.from('name: q\nports: ["80", " 7 ", 8080.5, true, "٨٠"]\n')],
    ['ports-string', Buffer.from('name: q\nports: "80"\n')],
    ['ports-mapping', Buffer.from('name: q\nports: {"81": x}\n')],
    ['ports-nan', Buffer.from('name: q\nports: [.nan]\n')],
    ['notes-string', Buffer.from('name: q\nnotes: abc\n')],
    ['notes-values', Buffer.from('name: q\nnotes: [1, 1.5, true, null, x]\n')],
    ['ports-none', Buffer.from('name: q\nports: [null]\n')],
    ['ports-scalar', Buffer.from('name: q\nports: 5\n')],
    ['notes-scalar', Buffer.from('name: q\nnotes: 5\n')],
  ];

  it.each(FILES)('reads %s as earlier releases read it', (name, bytes) => {
    withUserDir(
      (dir) => {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'q.yaml'), bytes);
      },
      () => {
        expectListingSame(`q.yaml ${name}`);
      },
    );
  });
});

describe('a malformed preset document', () => {
  it('names what it got instead of a mapping', () => {
    expect(() => parse('- a\n- b\n', 'src.yaml')).toThrow(
      "preset src.yaml is a list, not a mapping (a preset file is a YAML mapping with a 'name' key)",
    );
    expect(() => parse('just a string\n', 'src.yaml')).toThrow('preset src.yaml is a string');
    expect(() => parse('5\n', 'src.yaml')).toThrow('preset src.yaml is an integer');
  });

  it('treats an empty document as an empty mapping, which is then missing a name', () => {
    expect(() => parse('', 'src.yaml')).toThrow("preset src.yaml is missing a 'name' field");
    expect(() => parse('name: ""\n', 'src.yaml')).toThrow("missing a 'name' field");
  });

  it('says the same words earlier releases say', () => {
    const said: string[] = [];
    for (const text of ['- a\n- b\n', 'just a string\n', '5\n', '', 'name: ""\n']) {
      try {
        parse(text, 'src.yaml');
      } catch (error) {
        said.push(error instanceof Error ? error.message : String(error));
      }
    }
    expect(said).toEqual(recorded('parse_refusals'));
  });

  it('defaults every absent field rather than letting undefined reach compose', () => {
    const p = parse('name: bare\n', 'src.yaml');
    expect(p).toEqual({
      ...p,
      description: '',
      env: {},
      services: {},
      dependsOn: [],
      requiresLicense: false,
      instances: 1,
      entryService: '',
      ports: [],
      topology: '',
    });
    expectSame(p, recordedPreset(recorded('parse bare')));
  });
});

describe('an unknown preset', () => {
  it('points at the command that lists the real ones', () => {
    expect(() => load('nosuch')).toThrow("unknown preset 'nosuch' (run `houston presets` to list)");
  });
});
