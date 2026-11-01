import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../../../src/lib/config';
import { toYaml } from '../../../src/lib/compose';
import { MissingRecordError } from '../../../src/lib/errors';
import { shownValue } from '../../../src/lib/format';
import { orderedDict } from '../../../src/lib/json-text';

import type * as KubeNamesNS from '../../../src/core/kube/names';
import type * as KubeNamespaceNS from '../../../src/core/kube/namespace';

import * as paths from '../../../src/core/runner/paths';
import {
  META_FIELDS,
  adminPass,
  externalUrl,
  fromDocument,
  grafanaPortOf,
  listMeta,
  metadata,
  projectName,
  prometheusPortOf,
  rcServices,
  readCompose,
  readMeta,
  recorded,
  sidePortsOf,
  toDocument,
  updateMeta,
  write,
  writeRecord,
} from '../../../src/core/runner/record';

const ROOT = path.resolve(__dirname, '..', '..', '..');

function sample(values: Parameters<typeof metadata>[0] = {}) {
  return metadata({
    name: 'TICKET-1234',
    project: 'houston-TICKET-1234',
    rcVersion: '8.5.1',
    rcImage: 'rocketchat/rocket.chat:8.5.1',
    mongoTag: '8.0',
    mongoFlavor: 'official',
    preset: 'default',
    rootUrl: 'http://localhost:3000',
    hostPort: 3000,
    versionSource: 'live',
    createdAt: '2026-09-14T09:00:00Z',
    ...values,
  });
}

describe('the repro.json format', () => {
  it('writes the record keys, in the order earlier releases write them', () => {
    expect(META_FIELDS.map(([, key]) => key)).toEqual([
      'name',
      'project',
      'rc_version',
      'rc_image',
      'mongo_tag',
      'mongo_flavor',
      'preset',
      'root_url',
      'host_port',
      'version_source',
      'pinned',
      'created_at',
      'public_url',
      'admin_password',
      'extra',
    ]);
  });

  it('writes a record as these bytes, and rewrites what it reads back identically', async () => {
    // The bytes earlier releases write, two-space indented, so a workspace that passes
    // between releases does not churn.
    const name = 'as-written';
    const bytes =
      '{\n  "name": "as-written",\n  "project": "houston-as-written",\n' +
      '  "rc_version": "8.5.1",\n  "rc_image": "rocketchat/rocket.chat:8.5.1",\n' +
      '  "mongo_tag": "8.0",\n  "mongo_flavor": "official",\n  "preset": "default",\n' +
      '  "root_url": "http://localhost:3000",\n  "host_port": 3000,\n' +
      '  "version_source": "live",\n  "pinned": false,\n' +
      '  "created_at": "2026-09-14T09:00:00Z",\n  "public_url": "",\n' +
      '  "admin_password": "",\n  "extra": {\n    "instances": 3\n  }\n}';
    const file = path.join(paths.workspace(name), 'repro.json');
    await writeRecord(
      name,
      sample({ name, project: 'houston-as-written', extra: { instances: 3 } }),
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);

    const meta = await readMeta(name);
    expect(meta.rcVersion).toBe('8.5.1');
    expect(meta.extra).toEqual({ instances: 3 });
    expect(await projectName(name)).toBe('houston-as-written');
    await writeRecord(name, meta);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
  });

  it('round-trips a record and drops a key a newer houston added', () => {
    const document = toDocument(sample({ extra: { instances: 3 } }));
    expect(Object.keys(document)).toEqual(META_FIELDS.map(([, key]) => key));

    const back = fromDocument({ ...document, invented_by_a_newer_build: 'ignored' });
    expect(back).toEqual(sample({ extra: { instances: 3 } }));
    expect(Object.prototype.hasOwnProperty.call(back, 'invented_by_a_newer_build')).toBe(false);
  });

  it('rewrites a record in the bytes earlier releases write: escapes, NaN and float spelling', async () => {
    // `updateMeta` rewrites the WHOLE file, so one `chown` or `env --set` through this build
    // re-spelled everything an earlier release had written: raw UTF-8 for `é`, `null` for
    // NaN, `1e-7` for `1e-07`. The record here is spelled as earlier releases spell one, and
    // an edit through this build must keep every spelling.
    const name = 'spelled';
    const recordFile = path.join(paths.workspace(name), 'repro.json');
    const original =
      '{"name": "spelled", "project": "houston-spelled", "rc_version": "8.5.1", ' +
      '"rc_image": "rocketchat/rocket.chat:8.5.1", "mongo_tag": "8.0", ' +
      '"mongo_flavor": "official", "preset": "default", "root_url": "http://localhost:3000", ' +
      '"host_port": 3000, "version_source": "live", "pinned": false, ' +
      '"created_at": "2026-09-14T09:00:00Z", "public_url": "", "admin_password": "", ' +
      '"extra": {"env": {"X": "\\u00e9", "GREETING": "h\\u00e9llo \\u2028 \\ud83d\\ude00"}, ' +
      '"note": "cannot run \\u2014 wait \x7f\\u0085\\ufeff \\u65e5\\u672c", ' +
      '"x": NaN, "y": Infinity, "z": -Infinity, "s": 1e-07, "m": 5e-05, "r": 1.5}}';
    fs.mkdirSync(paths.workspace(name), { recursive: true });
    fs.writeFileSync(recordFile, original);

    await updateMeta(name, (meta) => {
      meta.extra.owner = 'josé';
    });
    const ours = fs.readFileSync(recordFile, 'utf8');
    expect(ours).toContain('"owner": "jos\\u00e9"');
    expect(ours).toContain('"x": NaN');
    expect(ours).toContain('"s": 1e-07');
  }, 30_000);

  it('rewrites a hand-edited record keeping its key order and the numbers a double loses', async () => {
    // Earlier releases keep an object's keys in document order and an int of any size, and
    // so their rewrite keeps both; this build read plain objects and doubles, so one `chown`
    // wrote `extra.env` with its `10` and `2` first and `extra.seed.n` 12345678901234567890
    // as 12345678901234567000, and `env --set` wrote `1e16` as the int 10000000000000000
    // The mutation is chown's in place and migrate's shallow copy, made to the same
    // hand-edited bytes.
    const name = 'handedit';
    const recordFile = path.join(paths.workspace(name), 'repro.json');
    const original =
      '{"name": "handedit", "project": "houston-handedit", "rc_version": "8.5.1", ' +
      '"rc_image": "rocketchat/rocket.chat:8.5.1", "mongo_tag": "8.0", ' +
      '"mongo_flavor": "official", "preset": "default", "root_url": "http://localhost:3000", ' +
      '"host_port": 3000, "version_source": "live", "extra": {"runtime": "docker", ' +
      '"env": {"b": "1", "10": "2", "a": "3", "2": "4"}, "seed": {"n": 12345678901234567890}, ' +
      '"10": "numeric-key", "x": NaN, "y": 1e-07, "z": 1e16, "f": 3.0, ' +
      '"big": 123456789012345678901234567890, "l": [1.0, -9007199254740993, {"7": 7.0}]}}';
    fs.mkdirSync(paths.workspace(name), { recursive: true });
    fs.writeFileSync(recordFile, original);

    await updateMeta(name, (meta) => {
      meta.extra.owner = 'bob';
    });
    await updateMeta(name, (meta) => {
      meta.extra = orderedDict(meta.extra);
      meta.extra.namespace = 'rc-repro-handedit';
    });
    const ours = fs.readFileSync(recordFile, 'utf8');
    expect(ours).toContain('"n": 12345678901234567890');
    expect(ours).toContain('"z": 1e+16');
    expect(ours.indexOf('"b": "1"')).toBeLessThan(ours.indexOf('"10": "2"'));
    // And a reader of the record still reads plain values.
    expect((await readMeta(name)).extra.seed).toEqual({ n: 12345678901234567000 });
  }, 30_000);

  it('rewrites a top-level float as a float, and a field changed since as what it is now', async () => {
    // Earlier releases write each field as the record they read holds it, so a hand-edited
    // `"host_port": 3100.0` survives every `updateMeta`. The fields are COPIED out of the
    // document `loads` built, and the copy lost the spelling kept beside it: a Kubernetes
    // `stop` dropping its port-forward pid wrote `3100` and `1`.
    const name = 'topfloat';
    const recordFile = path.join(paths.workspace(name), 'repro.json');
    const original =
      '{"name": "topfloat", "project": "houston-topfloat", "rc_version": 8.5, ' +
      '"rc_image": "rocketchat/rocket.chat:8.5.1", "mongo_tag": 8.0, ' +
      '"mongo_flavor": "official", "preset": "default", "root_url": "http://localhost:3100", ' +
      '"host_port": 3100.0, "version_source": "live", "pinned": 1.0, ' +
      '"created_at": 12345678901234567890, "public_url": 1e16, "admin_password": -0.0, ' +
      '"extra": {"runtime": "kubernetes", "port_forward_pid": 4194000}}';

    try {
      fs.mkdirSync(paths.workspace(name), { recursive: true });
      fs.writeFileSync(recordFile, original);
      await updateMeta(name, (meta) => {
        delete meta.extra.port_forward_pid;
      });
      const untouched = fs.readFileSync(recordFile, 'utf8');
      await updateMeta(name, (meta) => {
        meta.pinned = true;
      });
      const ours = fs.readFileSync(recordFile, 'utf8');
      expect(untouched).toContain('"host_port": 3100.0,');
      expect(untouched).toContain('"pinned": 1.0,');
      expect(ours).toContain('"pinned": true,');
      // And every reader of the record still reads the number.
      expect((await readMeta(name)).hostPort).toBe(3100);
    } finally {
      // Not left for the tests below, which list every workspace.
      fs.rmSync(paths.workspace(name), { recursive: true, force: true });
    }
  }, 30_000);

  it('falls back to the extra bag, and never raises for an unreadable workspace', async () => {
    await writeRecord('extras', sample({ name: 'extras', extra: { runtime: 'kubernetes' } }));
    expect(await recorded('extras', 'runtime')).toBe('kubernetes');
    // THE RECORD'S OWN SPELLING FINDS THE FIELD. `recordedLocalHost` calls
    // `recorded(name, "public_url")`, the key as repro.json spells it, and the bare-key
    // lookup found nothing there and fell through to the `extra` bag -- so the helper
    // now maps through META_FIELDS first and reads the field itself.
    expect(await recorded('extras', 'rc_version')).toBe('8.5.1');
    expect(await recorded('extras', 'rcVersion')).toBe('8.5.1');
    expect(await recorded('never-created', 'project')).toBe('');
  });

  it('derives a project name only when none was recorded', async () => {
    await writeRecord('derived', sample({ name: 'derived', project: '' }));
    expect(await projectName('derived')).toBe(`${config.PROJECT_PREFIX}derived`);
    await writeRecord('renamed', sample({ name: 'renamed', project: 'rc-repro-renamed' }));
    expect(await projectName('renamed')).toBe('rc-repro-renamed');
  });

  it('raises a typed 404 for a workspace with no record', async () => {
    fs.mkdirSync(paths.workspace('half'), { recursive: true });
    fs.writeFileSync(path.join(paths.workspace('half'), 'docker-compose.yml'), 'services: {}\n');
    expect(await paths.exists('half')).toBe(true);
    await expect(readMeta('half')).rejects.toBeInstanceOf(MissingRecordError);
    // And it is skipped rather than making the whole listing fail.
    await writeRecord('whole', sample({ name: 'whole' }));
    const listed = (await listMeta()).map((meta) => meta.name);
    expect(listed).toContain('whole');
    expect(listed).not.toContain('half');
  });

  it('reads back the services and the compose document it wrote', async () => {
    await write(
      'multi',
      'services:\n  mongodb: {}\n  rocketchat-2: {}\n  rocketchat-1: {}\n  traefik: {}\n',
      sample({ name: 'multi' }),
    );
    expect(await rcServices('multi')).toEqual(['rocketchat-1', 'rocketchat-2']);
    expect(Object.keys((await readCompose('multi')).services as object)).toContain('traefik');
    expect(await rcServices('never-created')).toEqual([]);
  });

  it('reads a compose document as earlier releases read it, not as YAML 1.2', async () => {
    // Earlier releases write bare every string their YAML 1.1 grammar does not type, and YAML 1.2 typed
    // eight of these -- `1e8` read back as 100000000 in `info`, and in what `monitor attach`
    // wrote back. A bare hex, `yes` and sexagesimal ARE typed.
    const bare =
      'services:\n  rocketchat:\n    environment:\n      A: 1e8\n      B: 0o17\n' +
      '      C: 1e-3\n      D: 12e03\n      E: 5e21234\n      F: NaN\n      G: -.5\n' +
      '      H: +.5\n      I: 1e+8\n      J: 0x1F\n      K: yes\n      L: 22:22\n' +
      '      R: plain\n';
    await write('bare', bare, sample({ name: 'bare' }));
    expect(await readCompose('bare')).toEqual({
      services: {
        rocketchat: {
          environment: {
            A: '1e8',
            B: '0o17',
            C: '1e-3',
            D: '12e03',
            E: '5e21234',
            F: 'NaN',
            G: '-.5',
            H: '+.5',
            I: '1e+8',
            J: 31,
            K: true,
            L: 1342,
            R: 'plain',
          },
        },
      },
    });
  });

  it('reads back the strings the compose writer quotes', async () => {
    // The writer quotes each of these, since docker compose's reader typed them too; a
    // workspace written before still holds some bare, which the test above stands for.
    const environment = {
      A: '1e8',
      B: '0o17',
      C: '1e-3',
      D: '12e03',
      E: '5e21234',
      F: 'NaN',
      G: '-.5',
      H: '+.5',
      I: '1e+8',
      J: '0x1F',
      K: 'yes',
      L: '22:22',
      R: 'plain',
    };
    const doc = { name: 'houston-quoted', services: { rocketchat: { environment } }, volumes: {} };
    const text = toYaml(doc);
    expect(text).toBe(
      '# Generated by houston. Do not edit by hand -- re-run `houston up`.\n' +
        'name: houston-quoted\nservices:\n  rocketchat:\n    environment:\n' +
        "      A: '1e8'\n      B: '0o17'\n      C: '1e-3'\n      D: '12e03'\n" +
        "      E: '5e21234'\n      F: NaN\n      G: '-.5'\n      H: '+.5'\n" +
        "      I: '1e+8'\n      J: '0x1F'\n      K: 'yes'\n      L: '22:22'\n" +
        '      R: plain\nvolumes: {}\n',
    );
    await write('quoted', text, sample({ name: 'quoted' }));
    expect(await readCompose('quoted')).toEqual(doc);
  });

  it('reads the scalars earlier releases type in a hand-edited compose file', async () => {
    // Octal, sexagesimal and underscored ints, a boolean, a null, an infinity, a NaN.
    const hand =
      'services:\n  rocketchat:\n    environment:\n      A: yes\n      B: ~\n      C: .inf\n' +
      '      D: 010\n      E: 22:22\n      F: 0o17\n      G: 1_000\n      H: .nan\n' +
      '      I: 1e8\n      J: y\n';
    await write('handmade', hand, sample({ name: 'handmade' }));
    expect(await readCompose('handmade')).toEqual({
      services: {
        rocketchat: {
          environment: {
            A: true,
            B: null,
            C: Infinity,
            D: 8,
            E: 1342,
            F: '0o17',
            G: 1000,
            H: NaN,
            I: '1e8',
            J: 'y',
          },
        },
      },
    });
  });

  it('keeps a bare timestamp as its text, so writing the document back cannot restate it', async () => {
    // Earlier releases make these a date and a datetime. As Dates they would reach `compose.ts`'s
    // emitter, which spells one as `"2026-01-01T00:00:00.000Z"` -- a different value in the
    // container than the one the file held.
    await write(
      'dated',
      'services:\n  rocketchat:\n    environment:\n      D: 2026-01-01\n      T: 2026-01-01 10:00:00\n',
      sample({ name: 'dated' }),
    );
    const services = (await readCompose('dated')).services as Record<
      string,
      Record<string, unknown>
    >;
    expect(services.rocketchat?.environment).toEqual({ D: '2026-01-01', T: '2026-01-01 10:00:00' });
  });

  it('substitutes the advertised url into generated files, not the loopback one', async () => {
    await write('livechat', 'services: {}\n', sample({ name: 'livechat' }), [
      ['widget/index.html', '<script src="{{ROOT_URL}}/livechat"></script>'],
    ]);
    expect(
      fs.readFileSync(path.join(paths.workspace('livechat'), 'widget', 'index.html'), 'utf8'),
    ).toContain('http://localhost:3000/livechat');

    await write(
      'advertised',
      'services: {}\n',
      sample({ name: 'advertised', extra: { advertised_url: 'https://rc.example.test' } }),
      [['widget/index.html', '{{ROOT_URL}}']],
    );
    expect(
      fs.readFileSync(path.join(paths.workspace('advertised'), 'widget', 'index.html'), 'utf8'),
    ).toBe('https://rc.example.test');
  });

  it('writes a kept file only when it is absent, so an edit survives a rebuild', async () => {
    const dir = path.join(paths.workspace('lab'), 'voice', 'pbx');
    const keep = new Set(['voice/pbx/extensions.conf']);
    const files = (gen: string): [string, string][] => [
      ['voice/pbx/extensions.conf', 'default\n'],
      ['voice/pbx/transports.conf', `${gen}\n`],
    ];
    await write('lab', 'services: {}\n', sample({ name: 'lab' }), files('v1'), keep);
    expect(fs.readFileSync(path.join(dir, 'extensions.conf'), 'utf8')).toBe('default\n');
    fs.writeFileSync(path.join(dir, 'extensions.conf'), 'edited\n');
    await write('lab', 'services: {}\n', sample({ name: 'lab' }), files('v2'), keep);
    expect(fs.readFileSync(path.join(dir, 'extensions.conf'), 'utf8')).toBe('edited\n');
    // Not kept: rewritten as before.
    expect(fs.readFileSync(path.join(dir, 'transports.conf'), 'utf8')).toBe('v2\n');
    fs.rmSync(path.join(dir, 'extensions.conf'));
    await write('lab', 'services: {}\n', sample({ name: 'lab' }), files('v3'), keep);
    expect(fs.readFileSync(path.join(dir, 'extensions.conf'), 'utf8')).toBe('default\n');
  });

  it('writes a kept file over the empty folder Docker leaves at a deleted one', async () => {
    // A kept file deleted to reset it, then a restart instead of `up --force`: Docker creates
    // a folder at the missing mount source, which must not count as "someone's edit".
    const dir = path.join(paths.workspace('lab2'), 'voice', 'freeswitch');
    fs.mkdirSync(path.join(dir, 'public.xml'), { recursive: true });
    const keep = new Set(['voice/freeswitch/public.xml']);
    await write(
      'lab2',
      'services: {}\n',
      sample({ name: 'lab2' }),
      [['voice/freeswitch/public.xml', '<include/>\n']],
      keep,
    );
    expect(fs.readFileSync(path.join(dir, 'public.xml'), 'utf8')).toBe('<include/>\n');
  });

  it('updates a record under the workspace lock', async () => {
    await writeRecord('updating', sample({ name: 'updating' }));
    const updated = await updateMeta('updating', (meta) => {
      meta.pinned = true;
      meta.extra.note = 'held for the customer';
    });
    expect(updated.pinned).toBe(true);
    expect((await readMeta('updating')).extra).toEqual({ note: 'held for the customer' });
  }, 30_000);

  it('reads the https url for a browser and the workspace password for the API', () => {
    expect(externalUrl(sample())).toBe('http://localhost:3000');
    expect(externalUrl(sample({ publicUrl: 'https://rc.example.test' }))).toBe(
      'https://rc.example.test',
    );
    // `up --root-url https://…` behind a proxy or a tunnel: `info`, `list` and the GUI showed
    // only http://localhost:<port>, which is houston's own address, not the one people open.
    expect(externalUrl(sample({ extra: { advertised_url: 'https://rc.tunnel.test' } }))).toBe(
      'https://rc.tunnel.test',
    );
    expect(adminPass(sample())).toBe(config.ADMIN_PASSWORD);
    expect(adminPass(sample({ adminPassword: 'generated' }))).toBe('generated');
  });
});

describe("a workspace's own side and monitoring ports", () => {
  it('are what moved, and the preferred ones for everything else and every older record', () => {
    expect(sidePortsOf(sample())).toEqual({});
    expect(sidePortsOf(sample({ extra: { side_ports: { email: [8026] } } }))).toEqual({
      email: [8026],
    });
    // A record written before ports could move, or with nothing in `extra` at all.
    expect(sidePortsOf(sample({ extra: null as unknown as Record<string, unknown> }))).toEqual({});
    expect([grafanaPortOf(sample()), prometheusPortOf(sample())]).toEqual([5050, 9090]);
  });

  it('read monitoring by position: Docker records the pair, Kubernetes only Grafana', () => {
    const docker = sample({ extra: { monitoring_ports: [9091, 5051] } });
    expect([prometheusPortOf(docker), grafanaPortOf(docker)]).toEqual([9091, 5051]);
    const kube = sample({ extra: { monitoring_ports: [5051] } });
    expect([prometheusPortOf(kube), grafanaPortOf(kube)]).toEqual([9090, 5051]);
  });

  it('drop what a hand-edited record could not mean, rather than linking to it', () => {
    // A record is a trust boundary: a nonsense entry falls back to the preferred port, never
    // to an address built from whatever text was there.
    const odd = sample({
      extra: {
        side_ports: {
          email: [80],
          ldap: ['8083'],
          s3_minio: [9002],
          nonsense: [8100],
          saml: 'x',
        },
        monitoring_ports: [9091, 'grafana'],
      },
    });
    expect(sidePortsOf(odd)).toEqual({ ldap: [8083] });
    expect([prometheusPortOf(odd), grafanaPortOf(odd)]).toEqual([9090, 5050]);
  });
});

describe('the write-ahead ordering', () => {
  it('leaves the readable half when the compose write cannot complete', async () => {
    // A directory where the compose file goes makes the rename fail, which is the
    // deterministic form of the same interruption: repro.json must already be down.
    const ws = paths.workspace('blocked');
    fs.mkdirSync(path.join(ws, 'docker-compose.yml'), { recursive: true });

    await expect(write('blocked', 'services: {}\n', sample({ name: 'blocked' }))).rejects.toThrow();
    expect((await readMeta('blocked')).name).toBe('blocked');
  });

  it('leaves the readable half when the writer is killed between the two writes', async () => {
    // The plan asks for this one to be tested by KILLING between the writes, because
    // the ordering is only observable from outside the process that does them. The
    // compose payload is sized so the second write is wide enough to be killed inside.
    const child = path.join(ROOT, 'tools', 'writeahead-child.js');
    let caught = false;

    for (let attempt = 0; attempt < 8 && !caught; attempt += 1) {
      const name = `killed-${String(attempt)}`;
      const ws = paths.workspace(name);
      const proc = spawn(process.execPath, [child, name, String(24 * 1024 * 1024)], {
        env: { ...process.env, HOUSTON_HOME: config.home() },
        stdio: 'pipe',
      });
      const exited = new Promise<void>((resolve) => {
        proc.once('close', () => resolve());
      });
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (fs.existsSync(path.join(ws, 'repro.json'))) {
          proc.kill('SIGKILL');
          break;
        }
        if (proc.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await exited;

      if (fs.existsSync(path.join(ws, 'docker-compose.yml'))) continue; // too late; retry
      caught = true;
      // The half that survived is the one `readMeta` can read and `up` regenerates.
      expect(await paths.exists(name)).toBe(true);
      expect((await readMeta(name)).name).toBe(name);
      // And no temp file was left looking like a workspace file.
      expect(fs.readdirSync(ws).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
    }

    expect(caught).toBe(true);
  }, 120_000);
});

describe('a Kubernetes workspace', () => {
  it('is addressed by the namespace it was created in, not the one this build would mint', async () => {
    // A namespace cannot be renamed in place, so once its objects exist the prefix that
    // minted it is history. Deriving it would send `down` at a namespace that was never
    // created while the real one kept its pods, its PVCs and its port-forward.
    const { namespaceFor } = require('../../../src/core/kube/namespace') as typeof KubeNamespaceNS;
    const { mintNamespace } = require('../../../src/core/kube/names') as typeof KubeNamesNS;
    await writeRecord(
      'legacy',
      metadata({
        name: 'legacy',
        project: 'rcrepro-legacy',
        extra: { namespace: 'rc-repro-legacy' },
      }),
    );
    expect(await namespaceFor('legacy')).toBe('rc-repro-legacy');
    expect(await namespaceFor('absent')).toBe(mintNamespace('absent'));
  });
});

describe('a workspace the record does not fully describe', () => {
  it('tells the reader how to remove a half-written workspace, and answers it as a 404', async () => {
    // The PAIR of writes is not atomic, and a kill between them leaves a directory
    // `exists` accepts. In `serve` a bare read failure there is a 500 with a stack trace,
    // because the detail panel reads on the request thread.
    fs.mkdirSync(paths.workspace('halfwritten'), { recursive: true });
    fs.writeFileSync(
      path.join(paths.workspace('halfwritten'), 'docker-compose.yml'),
      'services: {}\n',
    );
    const refused = await readMeta('halfwritten').then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(MissingRecordError);
    expect((refused as MissingRecordError).httpStatus).toBe(404);
    expect((refused as Error).message).toContain('down --name halfwritten');
    expect((await listMeta()).map((meta) => meta.name)).not.toContain('halfwritten');
  });

  it('restricts a workspace written record-first, as the Kubernetes path writes one', async () => {
    // The Kubernetes path writes repro.json alone, and it is the one runtime that also
    // writes `kubernetes/values.yaml` with ADMIN_PASS in it -- so its directory has to be
    // 0700 like every other, not left at the umask.
    await writeRecord('kube', sample({ name: 'kube', project: 'p' }));
    expect(fs.statSync(paths.workspace('kube')).mode & 0o777).toBe(0o700);
    expect((await readMeta('kube')).name).toBe('kube');
  });

  it('mints the project name for a workspace that has no record yet', async () => {
    // `up` asks before there is anything to read, so absence falls through to the
    // mint-time prefix rather than raising or answering ''.
    expect(await projectName('fresh')).toBe(paths.mintProjectName('fresh'));
    expect(await projectName('fresh')).toBe(`${config.PROJECT_PREFIX}fresh`);
  });

  it('runs admin123 for a record written before the password field existed', async () => {
    // Back-compat, and not cosmetic: a workspace made by an older houston really does run
    // `admin123`, so the fallback is a fact about that workspace rather than a default.
    fs.mkdirSync(paths.workspace('old'), { recursive: true });
    fs.writeFileSync(
      path.join(paths.workspace('old'), 'repro.json'),
      JSON.stringify({
        name: 'old',
        project: 'houston-old',
        rc_version: '6.5.3',
        rc_image: 'registry.rocket.chat/rocketchat/rocket.chat',
        mongo_tag: '5.0',
        mongo_flavor: 'bitnami-legacy',
        preset: 'default',
        root_url: 'http://localhost:3001',
        host_port: 3001,
        version_source: 'shipped',
      }),
    );
    const meta = await readMeta('old');
    expect(meta.adminPassword).toBe('');
    expect(adminPass(meta)).toBe('admin123');
  });
});

/** What a read answers: `['ok', value]`, or the error's name and message. */
async function outcome(fn: () => Promise<unknown>): Promise<unknown[]> {
  try {
    return ['ok', await fn()];
  } catch (error) {
    return [(error as Error).name, (error as Error).message];
  }
}

/**
 * Records read as earlier releases read them, one and all. A read that failed for any reason
 * was "no repro.json" and the workspace was skipped by `list`, where only absence is that; a
 * NaN was a JSON.parse error where earlier releases read it; a symlinked workspace directory
 * was not a directory to a Dirent; and names sorted by UTF-16 unit. Each row: what `listMeta`
 * answers (each name with its `host_port` as earlier releases print it), and what
 * `readMeta('alpha')` answers (the same).
 */
describe('reading records, as earlier releases read one and all of them', () => {
  const BASE = {
    project: 'houston-x',
    rc_version: '8.5.1',
    rc_image: 'i',
    mongo_tag: '8.0',
    mongo_flavor: 'official',
    preset: 'default',
    root_url: 'http://localhost:3000',
    host_port: 3000,
    version_source: 'map',
  };
  const outside: string[] = [];
  // Only this row's workspaces: the tests above leave theirs behind.
  beforeEach(() => {
    fs.rmSync(config.reprosDir(), { recursive: true, force: true });
  });
  afterEach(() => {
    const root = config.reprosDir();
    if (fs.existsSync(root) && fs.statSync(root).isDirectory()) fs.chmodSync(root, 0o700);
    for (const dir of fs.existsSync(root) && fs.statSync(root).isDirectory()
      ? fs.readdirSync(root)
      : []) {
      const file = path.join(root, dir, 'repro.json');
      if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
    }
    fs.rmSync(root, { recursive: true, force: true });
    for (const dir of outside.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function put(name: string, body: string | Buffer | null): void {
    const dir = path.join(config.reprosDir(), name);
    fs.mkdirSync(dir, { recursive: true });
    if (body === null) fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}\n');
    else fs.writeFileSync(path.join(dir, 'repro.json'), body);
  }
  const record = (name: string, extra: string = '') =>
    JSON.stringify({ ...BASE, name }).replace(/\}$/u, `${extra}}`);

  const repros = () => config.reprosDir();
  const alpha = () => path.join(config.reprosDir(), 'alpha', 'repro.json');
  const missing =
    "'alpha' has no repro.json, so it is a half-written workspace rather than one houston " +
    'can act on — finish it with `houston up --version <version> --name alpha`, or remove it with ' +
    '`houston down --name alpha --volumes`';

  const STATES: [string, () => void, () => unknown[], () => unknown[]][] = [
    [
      'a NaN and an Infinity in a record',
      () => put('alpha', record('alpha', ', "host_port": NaN, "extra": {"x": Infinity}')),
      () => ['ok', [['alpha', 'nan']]],
      () => ['ok', 'nan'],
    ],
    [
      'a workspace directory reached through a symlink',
      () => {
        put('alpha', record('alpha'));
        const away = fs.mkdtempSync(path.join(path.dirname(config.reprosDir()), 'away-'));
        outside.push(away);
        fs.writeFileSync(path.join(away, 'repro.json'), record('bravo'));
        fs.symlinkSync(away, path.join(config.reprosDir(), 'bravo'));
      },
      () => [
        'ok',
        [
          ['alpha', '3000'],
          ['bravo', '3000'],
        ],
      ],
      () => ['ok', '3000'],
    ],
    [
      'names outside ASCII, sorted by code point',
      () => ['alpha', '😀x', 'ｚulu'].forEach((n) => put(n, record(n))),
      () => [
        'ok',
        [
          ['alpha', '3000'],
          ['ｚulu', '3000'],
          ['😀x', '3000'],
        ],
      ],
      () => ['ok', '3000'],
    ],
    [
      'a record it may not read',
      () => {
        put('alpha', record('alpha'));
        fs.chmodSync(alpha(), 0o000);
      },
      () => ['FileError', `${alpha()}: Permission denied`],
      () => ['FileError', `${alpha()}: Permission denied`],
    ],
    [
      'a directory where the record should be',
      () => fs.mkdirSync(alpha(), { recursive: true }),
      () => ['FileError', `${alpha()}: Is a directory`],
      () => ['FileError', `${alpha()}: Is a directory`],
    ],
    [
      'a record that is not UTF-8',
      () => put('alpha', Buffer.from(record('alpha').replace('8.5.1', '8.5.1ÿ'), 'latin1')),
      () => [
        'NotUtf8',
        `${alpha()} is not valid UTF-8 (byte 0xff at position 42: invalid start byte)`,
      ],
      () => [
        'NotUtf8',
        `${alpha()} is not valid UTF-8 (byte 0xff at position 42: invalid start byte)`,
      ],
    ],
    [
      'a truncated record',
      () => put('alpha', '{"name": "alpha",'),
      () => ['ok', []],
      () => [
        'JsonSyntaxError',
        'Expecting property name enclosed in double quotes: line 1 column 18 (char 17)',
      ],
    ],
    [
      'a record that is not a JSON object',
      () => put('alpha', '[1, 2]'),
      () => ['ok', []],
      () => ['TypeError', 'repro.json is not a JSON object'],
    ],
    [
      'a record missing required fields',
      () => put('alpha', '{"name": "alpha", "project": "p"}'),
      () => ['ok', []],
      () => [
        'TypeError',
        `${alpha()} is missing 8 required fields: rc_version, rc_image, mongo_tag, ` +
          'mongo_flavor, preset, root_url, host_port, and version_source',
      ],
    ],
    [
      'a compose file and no record',
      () => put('alpha', null),
      () => ['ok', []],
      () => ['MissingRecordError', missing],
    ],
    [
      'a repros directory it may not list',
      () => {
        put('alpha', record('alpha'));
        fs.chmodSync(config.reprosDir(), 0o000);
      },
      () => ['FileError', `${repros()}: Permission denied`],
      () => ['FileError', `${alpha()}: Permission denied`],
    ],
    [
      'a repros path that is a file',
      () => {
        fs.mkdirSync(path.dirname(config.reprosDir()), { recursive: true });
        fs.writeFileSync(config.reprosDir(), 'x');
      },
      () => ['FileError', `${repros()}: Not a directory`],
      () => ['MissingRecordError', missing],
    ],
  ];

  it.each(STATES)('%s', async (_label, make, listed, read) => {
    make();
    expect(
      await outcome(async () => (await listMeta()).map((m) => [m.name, shownValue(m.hostPort)])),
    ).toEqual(listed());
    expect(await outcome(async () => shownValue((await readMeta('alpha')).hostPort))).toEqual(
      read(),
    );
  });
});

/**
 * Earlier releases read a compose file as strict UTF-8 text and then parse it, so a compose
 * file that is missing, a directory, unreadable or not UTF-8 is a `FileError` or
 * `NotUtf8` named for the file. An earlier version let Node's error out --
 * `ENOENT: ..., open '<path>'`, and an EISDIR that names no file -- and read a stray byte as
 * U+FFFD. A record with no compose file is what a kill between `write`'s two writes leaves;
 * a document that is not a mapping reads as an empty one.
 */
describe('reading a compose file, as earlier releases read it', () => {
  const file = () => path.join(paths.workspace('alpha'), 'docker-compose.yml');
  afterEach(() => {
    if (fs.existsSync(file()) && fs.statSync(file()).isFile()) fs.chmodSync(file(), 0o600);
    fs.rmSync(config.reprosDir(), { recursive: true, force: true });
  });

  const STATES: [string, () => void, () => unknown[]][] = [
    [
      'a compose file',
      () => fs.writeFileSync(file(), 'services:\n  rocketchat: {}\n'),
      () => ['ok', { services: { rocketchat: {} } }],
    ],
    [
      'no compose file',
      () => undefined,
      () => ['FileError', `${file()}: No such file or directory`],
    ],
    [
      'a directory where the compose file should be',
      () => fs.mkdirSync(file()),
      () => ['FileError', `${file()}: Is a directory`],
    ],
    [
      'a compose file it may not read',
      () => {
        fs.writeFileSync(file(), 'services: {}\n');
        fs.chmodSync(file(), 0o000);
      },
      () => ['FileError', `${file()}: Permission denied`],
    ],
    [
      'a compose file that is not UTF-8',
      () =>
        fs.writeFileSync(
          file(),
          Buffer.from('services:\n  rocketchat:\n    image: "xÿ"\n', 'latin1'),
        ),
      () => [
        'NotUtf8',
        `${file()} is not valid UTF-8 (byte 0xff at position 37: invalid start byte)`,
      ],
    ],
    ['a compose file that is a list', () => fs.writeFileSync(file(), '- a\n'), () => ['ok', {}]],
    [
      'a compose file that is a scalar',
      () => fs.writeFileSync(file(), 'hello\n'),
      () => ['ok', {}],
    ],
    ['an empty compose file', () => fs.writeFileSync(file(), ''), () => ['ok', {}]],
  ];

  it.each(STATES)('%s', async (_label, make, expected) => {
    fs.mkdirSync(paths.workspace('alpha'), { recursive: true });
    make();
    expect(await outcome(() => readCompose('alpha'))).toEqual(expected());
  });
});
