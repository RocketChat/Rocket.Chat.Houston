import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as YAML from 'yaml';

import {
  ADMIN_PASSWORD,
  DEFAULT_BIND_HOST,
  MONGO_OPLOG_URL,
  presetDir,
  safeLoadYaml,
} from '../../src/lib/config';
import { ValidationError } from '../../src/lib/errors';
import { RC_METRICS_ENV, SERVICES as MONITOR_SERVICES } from '../../src/lib/monitoring';
import { load as loadPreset } from '../../src/lib/presets/index';
import { emptyPreset, presetFromJSON } from '../../src/lib/presets/types';
import { safeDump } from '../../src/lib/yaml-dump';
import { resolve as resolveVersion } from '../../src/lib/versions';
import type { ComposeDoc, Service, Spec } from '../../src/lib/compose';
import {
  HEADER,
  bindPorts,
  build,
  forEngine,
  rcServiceNames,
  spec,
  toYaml,
} from '../../src/lib/compose';

import type * as EdgeSpecNS from '../../src/core/edge/spec';
import type * as EdgeTypesNS from '../../src/core/edge/types';
import type * as TopologyNS from '../../src/core/topology';

/**
 * What earlier releases wrote and read for the compose documents below, recorded: the
 * documents this build wrote that they read back as the same values, their spelling of
 * each value, and every shipped preset's compose file with the specs they were built from.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'lib', 'compose.json'), 'utf8'),
) as {
  user_preset: { env: Record<string, string>; text: string };
  indicator_text: string;
  unreadable_raw_text: string;
  unreadable_raw_spelled: string[];
  blank_lines_text: string;
  blank_lines_spelled: string[];
  shipped: {
    presets: Record<string, Record<string, unknown>>;
    cases: {
      spec: Record<string, unknown>;
      rc: string;
      text_sha256: string;
      rewritten_sha256: string;
    }[];
    spelled_out: {
      preset: string;
      rc_tag: string;
      monitoring: boolean;
      text: string;
      rewritten: string;
    }[];
  };
};

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function preset(over: Partial<ReturnType<typeof emptyPreset>> = {}) {
  return { ...emptyPreset('default'), ...over };
}

function official(over: Partial<Spec> = {}): Spec {
  return spec({
    projectName: 'houston-test',
    preset: preset(),
    rcImage: 'registry.rocket.chat/rocketchat/rocket.chat',
    rcTag: '8.5.1',
    mongoTag: '8.0',
    mongoFlavor: 'official',
    mongoShell: 'mongosh',
    oplog: false,
    rootUrl: 'http://localhost:3001',
    hostPort: 3001,
    ...over,
  });
}

function legacy(over: Partial<Spec> = {}): Spec {
  return official({
    rcTag: '6.5.3',
    mongoTag: '6.0',
    mongoFlavor: 'bitnami-legacy',
    mongoShell: 'mongosh',
    oplog: true,
    ...over,
  });
}

function env(doc: ComposeDoc, service = 'rocketchat'): Record<string, string> {
  return (doc.services[service] as { environment: Record<string, string> }).environment;
}

describe('the two MongoDB flavors', () => {
  it('official gets a fix-permission container, a healthcheck and an init one-shot', () => {
    // MongoDB Inc's community-server image runs as uid 1001, so the data dir is chowned
    // first and the replica set is initiated by a separate one-shot.
    const doc = build(official());
    expect(Object.keys(doc.services).sort()).toEqual([
      'mongo-init',
      'mongodb',
      'mongodb-fix-permission',
      'rocketchat',
    ]);
    expect(doc.services.mongodb?.user).toBe('1001');
    expect(String(doc.services.mongodb?.image)).toContain('mongodb-community-server');
    expect(doc.services.rocketchat?.depends_on).toEqual({
      'mongo-init': { condition: 'service_completed_successfully' },
    });
  });

  it('bitnami-legacy initiates its own replica set, so needs no init container', () => {
    const doc = build(legacy());
    expect(Object.keys(doc.services).sort()).toEqual(['mongodb', 'rocketchat']);
    expect(doc.services.rocketchat?.depends_on).toEqual(['mongodb']);
    // Published for amd64 only, so the platform is pinned to run under emulation on
    // Apple Silicon.
    expect(doc.services.mongodb?.platform).toBe('linux/amd64');
    expect(String(doc.services.mongodb?.image)).toContain('bitnamilegacy/mongodb');
  });

  it('raises mongod"s open-file soft limit on both flavors', () => {
    // mongod asks for 64000 and Docker's default soft limit is 1024. Normal traffic
    // survives it; a restore building many collections at once hit EMFILE inside
    // WiredTiger, which panics and aborts the whole mongod.
    for (const doc of [build(official()), build(legacy())]) {
      expect(doc.services.mongodb?.ulimits).toEqual({ nofile: { soft: 64000, hard: 64000 } });
    }
  });
});

describe('the Rocket.Chat environment', () => {
  it('has NO INITIAL_USER, whose absence is measured rather than assumed', () => {
    // RC parses this one as JSON: "yes" logged a SyntaxError on every boot of every
    // workspace, forever -- noise in exactly the artefact a support engineer reads. The
    // admin never came from it.
    expect(env(build(official()))).not.toHaveProperty('INITIAL_USER');
  });

  it('provisions the admin and skips the setup wizard', () => {
    const e = env(build(official()));
    expect(e.ADMIN_USERNAME).toBe('admin');
    expect(e.ADMIN_PASS).toBe(ADMIN_PASSWORD);
    expect(e.OVERWRITE_SETTING_Show_Setup_Wizard).toBe('completed');
  });

  it('uses the workspace"s own admin password when there is one', () => {
    // A password stored in repro.json and not put here would be a record of a login
    // that does not work.
    expect(env(build(official({ adminPassword: 'per-workspace' }))).ADMIN_PASS).toBe(
      'per-workspace',
    );
  });

  it('emits MONGO_OPLOG_URL for RC < 8 only', () => {
    expect(env(build(legacy())).MONGO_OPLOG_URL).toBe(MONGO_OPLOG_URL);
    expect(env(build(official()))).not.toHaveProperty('MONGO_OPLOG_URL');
  });

  it('emits REG_TOKEN only when there is one', () => {
    expect(env(build(official({ regToken: 'tok' }))).REG_TOKEN).toBe('tok');
    expect(env(build(official()))).not.toHaveProperty('REG_TOKEN');
  });
});

describe('precedence: base, then preset, then explicit overrides', () => {
  it('lets the preset beat a base default', () => {
    const doc = build(official({ preset: preset({ env: { DEPLOY_METHOD: 'from-preset' } }) }));
    expect(env(doc).DEPLOY_METHOD).toBe('from-preset');
  });

  it('lets an explicit override beat everything, including a base key', () => {
    // This is a reproduction tool, so pointing MONGO_URL or ROOT_URL somewhere odd is a
    // legitimate thing to want.
    const doc = build(
      official({
        preset: preset({ env: { ROOT_URL: 'http://preset' } }),
        envOverrides: { ROOT_URL: 'http://explicit' },
      }),
    );
    expect(env(doc).ROOT_URL).toBe('http://explicit');
  });

  it('REMOVES a key when the override value is null', () => {
    // That is how a base or preset default is unset rather than merely blanked. Writing
    // the string "null" would be a different, and wrong, document.
    const doc = build(
      official({ envOverrides: { ALLOW_UNSAFE_QUERY_AND_FIELDS_API_PARAMS: null } }),
    );
    expect(env(doc)).not.toHaveProperty('ALLOW_UNSAFE_QUERY_AND_FIELDS_API_PARAMS');
  });

  it('tolerates removing a key that was not there', () => {
    expect(() => build(official({ envOverrides: { NOT_THERE: null } }))).not.toThrow();
  });
});

describe('multi-instance', () => {
  it('names one service for one instance and rocketchat-N for many', () => {
    expect(rcServiceNames(1)).toEqual(['rocketchat']);
    expect(rcServiceNames(3)).toEqual(['rocketchat-1', 'rocketchat-2', 'rocketchat-3']);
    expect(rcServiceNames(0)).toEqual(['rocketchat']);
  });

  it('publishes each instance directly on hostPort+i', () => {
    // So you can open a specific instance in the browser -- post on one and watch it
    // arrive on another.
    const doc = build(official({ preset: preset({ instances: 3 }) }));
    expect(doc.services['rocketchat-1']?.ports).toEqual(['127.0.0.1:3002:3000']);
    expect(doc.services['rocketchat-2']?.ports).toEqual(['127.0.0.1:3003:3000']);
    expect(doc.services['rocketchat-3']?.ports).toEqual(['127.0.0.1:3004:3000']);
  });

  it('serialises the cold start so instances cannot race the empty database', () => {
    // Only rocketchat-1 boots against the empty DB, running migrations and seeding
    // settings; 2..N wait for it to be healthy or they crash on E11000 duplicate keys.
    const doc = build(official({ preset: preset({ instances: 3 }) }));
    expect(doc.services['rocketchat-1']?.depends_on).not.toHaveProperty('rocketchat-1');
    for (const name of ['rocketchat-2', 'rocketchat-3']) {
      expect(doc.services[name]?.depends_on).toMatchObject({
        'rocketchat-1': { condition: 'service_healthy' },
      });
    }
  });

  it('points every instance at NATS as the transporter', () => {
    const doc = build(official({ preset: preset({ instances: 2 }) }));
    expect(env(doc, 'rocketchat-1').TRANSPORTER).toBe('monolith+nats://nats:4222');
  });
});

describe('entry_service', () => {
  it('hands the published host port to the front end and drops the collision', () => {
    // Leaving the same host port on RC too binds it twice and `up` fails with "port is
    // already allocated".
    const doc = build(
      official({
        preset: preset({ entryService: 'front', services: { front: { image: 'traefik' } } }),
      }),
    );
    expect(doc.services.front?.ports).toEqual(['127.0.0.1:3001:80']);
    expect(doc.services.rocketchat).not.toHaveProperty('ports');
  });

  it('keeps multi-instance"s direct per-instance ports', () => {
    const doc = build(
      official({
        preset: preset({
          instances: 2,
          entryService: 'front',
          services: { front: { image: 'traefik' } },
        }),
      }),
    );
    expect(doc.services['rocketchat-1']?.ports).toEqual(['127.0.0.1:3002:3000']);
  });

  it('THROWS when the named service is not one of the preset"s', () => {
    // Silently skipping meant NOTHING published the host port: the repro booted and was
    // unreachable at its own advertised root_url.
    expect(() =>
      build(official({ preset: preset({ name: 'p', entryService: 'missing' }) })),
    ).toThrow(/entry_service "missing"/);
  });
});

describe('binding', () => {
  it('is loopback by default', () => {
    expect(DEFAULT_BIND_HOST).toBe('127.0.0.1');
    expect(build(official()).services.rocketchat?.ports).toEqual(['127.0.0.1:3001:3000']);
  });

  it('leaves ports bare when the bind host is empty', () => {
    expect(build(official({ bindHost: '' })).services.rocketchat?.ports).toEqual(['3001:3000']);
  });

  function bound(ports: unknown[], bind = '127.0.0.1'): unknown[] {
    const doc: ComposeDoc = { name: 'n', services: { s: { ports } }, volumes: {} };
    bindPorts(doc, bind);
    return doc.services.s?.ports as unknown[];
  }

  it('prefixes the short HOST:CONTAINER form', () => {
    expect(bound(['8025:8025'])).toEqual(['127.0.0.1:8025:8025']);
  });

  it('leaves an already IP-qualified mapping alone', () => {
    // Prefixing again would produce a double-IP mapping.
    expect(bound(['127.0.0.1:8025:8025'])).toEqual(['127.0.0.1:8025:8025']);
  });

  it('uses the IP::CONTAINER form for a bare container port', () => {
    // "127.0.0.1:8025" would be parsed as host:container with an invalid host port.
    expect(bound(['8025'])).toEqual(['127.0.0.1::8025']);
  });

  it('binds a port RANGE rather than passing it through unbound', () => {
    // This fell through and was appended UNCHANGED, so it published on every interface
    // while `info` reported the workspace as loopback-bound -- a silent opt-out of the
    // posture, on a workspace running fixed weak credentials.
    expect(bound(['8000-8005:8000-8005'])).toEqual(['127.0.0.1:8000-8005:8000-8005']);
    // A one-sided range means container ports with ephemeral host ports. Repeating the
    // range on the host side would silently change that contract to fixed host ports.
    expect(bound(['8000-8005'])).toEqual(['127.0.0.1::8000-8005']);
  });

  it('keeps a port a preset opened to every address, unless a narrower bind was chosen', () => {
    // Voice opens its call ports with an explicit 0.0.0.0 once voip_domain names an address.
    // A loopback or wildcard bind leaves them open; `--bind 10.0.0.5` keeps them on 10.0.0.5.
    const opened = ['0.0.0.0:20000-20046:20000-20046/udp'];
    expect(bound(opened)).toEqual(opened);
    expect(bound(opened, '0.0.0.0')).toEqual(opened);
    expect(bound(opened, '10.0.0.5')).toEqual(['10.0.0.5:20000-20046:20000-20046/udp']);
    expect(bound(['192.168.1.9:8025:8025'], '10.0.0.5')).toEqual(['192.168.1.9:8025:8025']);
  });

  it('binds a UDP range, and a bare UDP port, rather than refusing them', () => {
    // A protocol suffix fell outside every recognised shape and was refused, so the voice
    // preset could not publish FreeSWITCH's RTP range the way Rocket.Chat's compose file does.
    expect(bound(['20000-20046:20000-20046/udp'])).toEqual([
      '127.0.0.1:20000-20046:20000-20046/udp',
    ]);
    expect(bound(['20000-20046/udp'])).toEqual(['127.0.0.1::20000-20046/udp']);
    expect(bound(['3478/udp'])).toEqual(['127.0.0.1::3478/udp']);
  });

  it('handles compose long syntax by setting host_ip, not by stringifying it', () => {
    // THE TYPE CHECK COMES FIRST: stringifying long syntax gives a text containing two
    // colons, which matched the already-qualified branch, and the object's text was
    // appended as a ports entry.
    expect(bound([{ target: 80, published: 8080 }])).toEqual([
      { target: 80, published: 8080, host_ip: '127.0.0.1' },
    ]);
  });

  it('leaves long syntax that already names a host_ip alone', () => {
    expect(bound([{ target: 80, published: 8080, host_ip: '10.0.0.1' }])).toEqual([
      { target: 80, published: 8080, host_ip: '10.0.0.1' },
    ]);
  });

  it('REFUSES a shape it does not understand, rather than publishing it everywhere', () => {
    // Everything above is a shape this function understands; anything else is a
    // published port it would be leaving on every interface, which is the one outcome
    // that must never be the default.
    expect(() => bound(['weird-shape'])).toThrow(ValidationError);
    expect(() => bound(['weird-shape'])).toThrow(/houston cannot bind to 127\.0\.0\.1/);
  });

  it('names the service, so a preset author can see what to change', () => {
    expect(() => bound(['weird-shape'])).toThrow(/service "s"/);
  });

  it('applies to preset sidecars as well as to Rocket.Chat', () => {
    const doc = build(
      official({
        preset: preset({ services: { mailpit: { image: 'mailpit', ports: ['8025:8025'] } } }),
      }),
    );
    expect(doc.services.mailpit?.ports).toEqual(['127.0.0.1:8025:8025']);
  });
});

describe('the monitoring add-on', () => {
  it('Grafana public URL regression: configures only houston-served HTTPS', () => {
    expect(
      build(official({ monitoring: true, publicUrl: 'https://h' })).services.grafana?.environment,
    ).toHaveProperty('GF_SERVER_ROOT_URL', 'https://h/grafana/');
    expect(
      build(official({ monitoring: true, rootUrl: 'https://customers-proxy' })).services.grafana
        ?.environment,
    ).not.toHaveProperty('GF_SERVER_ROOT_URL');
  });
  it('adds nothing unless asked', () => {
    const doc = build(official());
    for (const name of MONITOR_SERVICES) expect(doc.services).not.toHaveProperty(name);
  });

  it('adds its services and volumes and turns the metrics endpoint on', () => {
    const doc = build(official({ monitoring: true }));
    for (const name of MONITOR_SERVICES) expect(doc.services).toHaveProperty(name);
    expect(Object.keys(doc.volumes).sort()).toEqual([
      'grafana_data',
      'loki_data',
      'mongodb_data',
      'prometheus_tsdb',
    ]);
    expect(env(doc)[RC_METRICS_ENV]).toBe('true');
  });

  it('turns metrics on for EVERY instance', () => {
    const doc = build(official({ monitoring: true, preset: preset({ instances: 2 }) }));
    expect(env(doc, 'rocketchat-1')[RC_METRICS_ENV]).toBe('true');
    expect(env(doc, 'rocketchat-2')[RC_METRICS_ENV]).toBe('true');
  });

  it('binds its own published ports too', () => {
    const doc = build(official({ monitoring: true }));
    expect(doc.services.prometheus?.ports).toEqual(['127.0.0.1:9090:9090']);
    expect(doc.services.grafana?.ports).toEqual(['127.0.0.1:5050:3000']);
    // The exporters are internal -- scraped by Prometheus, never published to the host.
    expect(doc.services['node-exporter']).not.toHaveProperty('ports');
    expect(doc.services['mongodb-exporter']).not.toHaveProperty('ports');
  });

  it("publishes a second monitored workspace's Prometheus and Grafana on the ports it was given", () => {
    const doc = build(official({ monitoring: true, monitorPorts: [9091, 5051] }));
    expect(doc.services.prometheus?.ports).toEqual(['127.0.0.1:9091:9090']);
    expect(doc.services.grafana?.ports).toEqual(['127.0.0.1:5051:3000']);
  });
});

describe('TLS', () => {
  it('changes the document NOT AT ALL, which is the property the design rests on', () => {
    // A workspace never terminates TLS: the edge does, for all of them, and reaches this
    // one over the private network compose already made. Gaining or losing HTTPS is a
    // route file appearing or disappearing, and no container is ever rebuilt.
    expect(toYaml(build(official()))).toBe(toYaml(build(official())));
    expect(build(official()).services.rocketchat?.ports).toEqual(['127.0.0.1:3001:3000']);
  });
});

describe('YAML emission', () => {
  it('QUOTES a YAML 1.1 boolean word, or compose rejects the value', () => {
    // YAML 1.2 treats bare `yes` as the string it is; compose reads YAML 1.1, where it
    // is a boolean. This one line was measured, not assumed.
    const text = toYaml(build(official()));
    expect(text).toContain("ALLOW_EMPTY_PASSWORD: 'yes'");
    expect(text).not.toMatch(/ALLOW_EMPTY_PASSWORD: yes\s*$/m);
  });

  it('reads back as STRINGS under YAML 1.2 parsing', () => {
    // Parsing stays 1.2 deliberately, so reading a file back can never turn a stray
    // `yes` into a boolean.
    const doc = YAML.parse(toYaml(build(official()))) as ComposeDoc;
    const mongoEnv = (doc.services.mongodb as { environment: Record<string, unknown> }).environment;
    expect(mongoEnv.ALLOW_EMPTY_PASSWORD).toBe('yes');
    expect(typeof mongoEnv.ALLOW_EMPTY_PASSWORD).toBe('string');
  });

  it('carries the do-not-edit header, because the file is generated', () => {
    expect(toYaml(build(official())).startsWith('# Generated by houston.')).toBe(true);
  });

  it('round-trips to a document with the same services', () => {
    const built = build(official({ monitoring: true, preset: preset({ instances: 2 }) }));
    const reread = YAML.parse(toYaml(built)) as ComposeDoc;
    expect(Object.keys(reread.services).sort()).toEqual(Object.keys(built.services).sort());
  });
});

describe('preset merging', () => {
  it('deep-merges the rocketchat patch into every instance', () => {
    const doc = build(
      official({
        preset: preset({
          instances: 2,
          rocketchat: { environment: { FROM_PRESET: 'yes' }, labels: ['a=b'] },
        }),
      }),
    );
    for (const name of ['rocketchat-1', 'rocketchat-2']) {
      expect(env(doc, name).FROM_PRESET).toBe('yes');
      expect(doc.services[name]?.labels).toEqual(['a=b']);
      // The deep merge must not have replaced the base environment wholesale.
      expect(env(doc, name).ROOT_URL).toBe('http://localhost:3001');
    }
  });

  it('adds depends_on in both the list and condition-map shapes', () => {
    const onList = build(legacy({ preset: preset({ dependsOn: ['sidecar'] }) }));
    expect(onList.services.rocketchat?.depends_on).toEqual(['mongodb', 'sidecar']);

    const onMap = build(official({ preset: preset({ dependsOn: ['sidecar'] }) }));
    expect(onMap.services.rocketchat?.depends_on).toMatchObject({
      'mongo-init': { condition: 'service_completed_successfully' },
      sidecar: { condition: 'service_started' },
    });
  });

  it('does not let one instance"s patch leak into another', () => {
    const doc = build(
      official({ preset: preset({ instances: 2, rocketchat: { labels: ['x'] } }) }),
    );
    (doc.services['rocketchat-1'] as { labels: string[] }).labels.push('mutated');
    expect(doc.services['rocketchat-2']?.labels).toEqual(['x']);
  });
});

/** A Spec built the way the create path builds one: a shipped preset, a real pairing. */
function shipped(
  presetName = 'default',
  params: Record<string, unknown> = {},
  over: Partial<Spec> = {},
  version = '8.4.1',
): Spec {
  const resolved = resolveVersion(version, { offline: true });
  return spec({
    projectName: 'houston-t',
    rcImage: resolved.rcImage,
    rcTag: resolved.rcVersion,
    mongoTag: resolved.mongoTag,
    mongoFlavor: resolved.mongoFlavor,
    mongoShell: resolved.mongoShell,
    oplog: resolved.oplog,
    rootUrl: 'http://localhost:3000',
    hostPort: 3000,
    regToken: null,
    preset: loadPreset(presetName, params),
    ...over,
  });
}

describe("a user preset's env, as earlier releases write it", () => {
  it('writes each value as the text of what the YAML holds, not String() of what JavaScript does', () => {
    // Earlier releases write each env value as the text of the value: a user preset's
    // unquoted `true` reached the container as `True` from them and `true` from here, `null`
    // as `None` and `null`, `.inf` as `inf` and `Infinity`, an int past 2**53 digit for digit
    // and rounded, a date as `2026-01-01` and the Date's own text in the box's time zone, a
    // mapping as `{'a': 1}` and `[object Object]`.
    const document = [
      'name: mine',
      'env:',
      '  FLAG: true',
      '  NO_WORD: no',
      '  NOTHING: null',
      '  BIG: 12345678901234567890',
      '  NEG_BIG: -12345678901234567890',
      '  SAFE: 42',
      '  FLOAT: 1.0',
      '  FRACTION: 2.5',
      '  EXP: 1.0e+20',
      '  INF: .inf',
      '  NAN: .nan',
      '  DATE: 2026-01-01',
      '  STAMP: 2026-01-01 10:00:00',
      '  STAMP_OFFSET: 2026-01-01T10:00:00.5+05:30',
      '  NESTED: {a: 1, 1: b, f: 1.0}',
      '  LIST: [1, 2, x, 1.0, null, true, 2026-01-01]',
      '  EMPTY: []',
      '  PLAIN: text',
      '  QUOTED: "3.0"',
      '',
    ].join('\n');
    fs.mkdirSync(presetDir(), { recursive: true });
    fs.writeFileSync(path.join(presetDir(), 'mine.yaml'), document, 'utf8');
    // Recorded: the env earlier releases built for 8.4.1 with this preset, offline, and the
    // compose file they wrote.
    const recorded = RECORDED.user_preset;
    const built = build(shipped('mine'));
    const ours = env(built);
    expect(Object.fromEntries(Object.keys(recorded.env).map((key) => [key, ours[key]]))).toEqual(
      recorded.env,
    );
    expect(toYaml(built)).toBe(recorded.text);
    expect(recorded.env).toMatchObject({
      FLAG: 'True',
      NOTHING: 'None',
      BIG: '12345678901234567890',
      FLOAT: '1.0',
      INF: 'inf',
      DATE: '2026-01-01',
      NESTED: "{'a': 1, 1: 'b', 'f': 1.0}",
    });
  });
});

describe('the shipped presets, built as the create path builds them', () => {
  it('lets an override beat a base default and removes a key given null, leaving the rest', () => {
    // Blanking a base default to "" is not removing it -- Rocket.Chat treats an empty value
    // as set -- so an unset has to delete the key.
    const e = env(
      build(
        shipped(
          'default',
          {},
          {
            rootUrl: 'http://x',
            envOverrides: { MY_VAR: 'v', ADMIN_USERNAME: 'someone', MONGO_URL: null },
          },
          '8.6.1',
        ),
      ),
    );
    expect(e.MY_VAR).toBe('v');
    expect(e.ADMIN_USERNAME).toBe('someone');
    expect(e).not.toHaveProperty('MONGO_URL');
    expect([e.ROOT_URL, e.PORT]).toEqual(['http://x', '3000']);
    // No overrides -> the document the feature did not exist for.
    expect(env(build(shipped('default', {}, {}, '8.6.1')))).not.toHaveProperty('MY_VAR');
  });

  it('applies env overrides to every rocketchat instance', () => {
    // multi-instance clones rocketchat into rocketchat-1..N, and every one must get them.
    const doc = build(
      shipped('multi-instance', { instances: '3' }, { envOverrides: { MY_VAR: 'v' } }),
    );
    const rc = Object.keys(doc.services).filter((name) => name.startsWith('rocketchat'));
    expect(rc).toHaveLength(3);
    for (const name of rc) expect(env(doc, name).MY_VAR).toBe('v');
  });

  it('gives the single rocketchat service a healthcheck that asks Rocket.Chat itself', () => {
    // Without one docker reports no health, and the panel fell back to the container
    // STATE -- "running" from the moment the process starts, minutes before RC serves
    // anything. The probe existed only on the multi-instance CLONES.
    const hc = (
      build(shipped('default', {}, {}, '8.5.1')).services.rocketchat as {
        healthcheck?: { test: string[] };
      }
    ).healthcheck;
    expect(hc).toBeDefined();
    expect((hc?.test ?? []).join(' ')).toContain('/api/info');
  });

  it('keeps every instance its healthcheck, which the serialised cold start waits on', () => {
    const services = build(shipped('multi-instance', {}, {}, '8.5.1')).services;
    const instances = Object.keys(services).filter((name) => name.startsWith('rocketchat-'));
    expect(instances.length).toBeGreaterThanOrEqual(2);
    for (const name of instances) {
      expect({ name, has: services[name]?.healthcheck !== undefined }).toEqual({ name, has: true });
    }
    expect(JSON.stringify(services['rocketchat-2']?.depends_on)).toContain('rocketchat-1');
  });

  it('lands a preset’s volumes in the top-level block, beside the base one', () => {
    // Else compose rejects the file.
    const doc = build(shipped('s3_minio'));
    expect(Object.keys(doc.volumes)).toEqual(
      expect.arrayContaining(['minio_data', 'mongodb_data']),
    );
    expect(doc.services.minio?.volumes).toContain('minio_data:/data');
  });

  it('clones and meshes the shipped multi-instance preset over NATS', () => {
    const services = build(shipped('multi-instance', { instances: '3' })).services;
    expect(Object.keys(services)).toEqual(
      expect.arrayContaining(['rocketchat-1', 'rocketchat-2', 'rocketchat-3', 'nats', 'traefik']),
    );
    expect(services).not.toHaveProperty('rocketchat');
    const second = services['rocketchat-2'] as {
      environment: Record<string, string>;
      ports: string[];
      depends_on: Record<string, { condition?: string }>;
    };
    expect(second.environment.TRANSPORTER).toBe('monolith+nats://nats:4222');
    // The NATS transporter, not the DDP mesh.
    expect(second.environment).not.toHaveProperty('INSTANCE_IP');
    // Direct access on host_port+2, loopback-bound.
    expect(second.ports).toEqual(['127.0.0.1:3002:3000']);
    expect(Object.keys(second.depends_on)).toContain('nats');
    expect(second.depends_on['rocketchat-1']?.condition).toBe('service_healthy');
    expect(services['rocketchat-1']?.healthcheck).toBeDefined();
    // Traefik got the published host port.
    expect(services.traefik?.ports).toEqual(['127.0.0.1:3000:80']);
  });

  it('keeps one rocketchat for the default preset, on its own port', () => {
    const services = build(shipped()).services;
    expect(services).toHaveProperty('rocketchat');
    expect(services).not.toHaveProperty('rocketchat-1');
    expect(services.rocketchat?.ports).toEqual(['127.0.0.1:3000:3000']);
  });

  it('binds every published port of a shipped preset to loopback', () => {
    // The official rocketchat-compose BIND_IP pattern, sidecars included.
    const published = Object.values(build(shipped('s3_minio')).services).flatMap(
      (service) => (service.ports ?? []) as unknown[],
    );
    expect(published.length).toBeGreaterThan(0);
    expect(published.filter((port) => !String(port).startsWith('127.0.0.1:'))).toEqual([]);
  });

  it('binds wide only when asked to', () => {
    // `up --bind 0.0.0.0` is deliberate LAN sharing.
    expect(
      build(shipped('default', {}, { bindHost: '0.0.0.0' })).services.rocketchat?.ports,
    ).toEqual(['0.0.0.0:3000:3000']);
  });

  it('builds the same document for both spellings of multi-instance', () => {
    // `multi-instance` moved from --preset to --deployment and the old spelling stays as
    // an alias -- so they must be the SAME stack, byte for byte, not similar ones.
    const topology = jest.requireActual<typeof TopologyNS>('../../src/core/topology');
    const built = (options: Parameters<typeof topology.resolveAxes>[0] = {}): string => {
      const axes = topology.resolveAxes(options);
      const resolved = resolveVersion('8.5.1', { offline: true });
      return toYaml(
        build(
          spec({
            projectName: 'houston-x',
            rcImage: resolved.rcImage,
            rcTag: resolved.rcVersion,
            mongoTag: resolved.mongoTag,
            mongoFlavor: resolved.mongoFlavor,
            mongoShell: resolved.mongoShell,
            oplog: resolved.oplog,
            rootUrl: 'http://localhost:3000',
            hostPort: 3000,
            regToken: null,
            preset: loadPreset(axes.preset, axes.params),
            bindHost: '127.0.0.1',
          }),
        ),
      );
    };
    const old = built({ preset: 'multi-instance', params: { instances: '3' } });
    const fresh = built({ deployment: 'multi-instance', replicas: 3 });
    expect(old).toBe(fresh);
    // The preset's own default count survives the move too.
    expect(built({ preset: 'multi-instance' })).toBe(built({ deployment: 'multi-instance' }));
    // A plain monolith is untouched by any of this.
    expect(built({ preset: 'default' })).toBe(built());
    // And the count reaches the document, so the equalities are not two identically-wrong files.
    const count = (text: string) =>
      Object.keys((YAML.parse(text) as ComposeDoc).services).filter((name) =>
        name.startsWith('rocketchat'),
      ).length;
    expect(count(fresh)).toBe(3);
    expect(count(built({ deployment: 'multi-instance' }))).toBe(2);
  });
});

describe('what a workspace compose document never carries', () => {
  it('runs no Traefik of its own and publishes no 443', () => {
    // The edge terminates TLS for every workspace; a workspace holds no :443 at all.
    const doc = build(shipped());
    expect(doc.services).not.toHaveProperty('traefik');
    const published = Object.values(doc.services).flatMap(
      (service) => (service.ports ?? []) as unknown[],
    );
    expect(published.filter((port) => String(port).endsWith(':443'))).toEqual([]);
  });

  it('keeps its own private network, with no shared one anywhere in the document', () => {
    // That is what stops workspaces reaching each other; the edge joins THEM instead.
    const doc = build(shipped()) as ComposeDoc & { networks?: unknown };
    expect(doc).not.toHaveProperty('networks');
    expect(doc.services.rocketchat).not.toHaveProperty('networks');
  });
});

describe('every published port shape', () => {
  it('is bound, an unpublished target is left alone, and an unknown shape is refused', () => {
    // A fixed RANGE was appended unchanged and published on every interface while `info`
    // reported loopback; a one-sided range became IP:RANGE, which compose refuses; long
    // syntax was stringified into its own text. Reachable through custom presets.
    const doc: ComposeDoc = {
      name: 'n',
      volumes: {},
      services: {
        range: { ports: ['8000-8005:8000-8005'] },
        range_ephemeral: { ports: ['8000-8005'] },
        long: { ports: [{ target: 80, published: 8080 }] },
        plain: { ports: ['9000:9000'] },
        bare: { ports: ['8025'] },
        already: { ports: ['127.0.0.1:1:1'] },
        unpublished: { ports: [{ target: 80 }] },
      },
    };
    bindPorts(doc, '127.0.0.1');
    expect(Object.fromEntries(Object.entries(doc.services).map(([k, v]) => [k, v.ports]))).toEqual({
      range: ['127.0.0.1:8000-8005:8000-8005'],
      range_ephemeral: ['127.0.0.1::8000-8005'],
      long: [{ target: 80, published: 8080, host_ip: '127.0.0.1' }],
      plain: ['127.0.0.1:9000:9000'],
      bare: ['127.0.0.1::8025'],
      already: ['127.0.0.1:1:1'],
      // A target with no `published` is not on the host, so there is nothing to bind.
      unpublished: [{ target: 80 }],
    });
    // "Unbound" must never be the fallback for "I did not understand this".
    const weird: ComposeDoc = {
      name: 'n',
      volumes: {},
      services: { weird: { ports: [['a', 'b']] } },
    };
    expect(() => bindPorts(weird, '127.0.0.1')).toThrow(/"weird"/u);
    expect(() => bindPorts(weird, '127.0.0.1')).toThrow(/every interface/u);
  });
});

describe('the edge’s own document, through this writer', () => {
  it('is YAML that reads back with its edge service', () => {
    const edgeSpec = jest.requireActual<typeof EdgeSpecNS>('../../src/core/edge/spec');
    const edgeTypes = jest.requireActual<typeof EdgeTypesNS>('../../src/core/edge/types');
    const doc = edgeSpec.composeDoc(
      edgeTypes.edge({ domain: 'support.xyz.com', acmeEmail: 'ops@xyz.com' }),
    );
    const reread = YAML.parse(toYaml(doc)) as ComposeDoc;
    expect(reread.services.edge).toBeDefined();
  });
});

describe("the compose writer and the indicator scalars earlier releases' reader refuses bare", () => {
  it('quotes a bare = so earlier releases can read the workspace back', () => {
    // `env --set X==` left `X: =`, which earlier releases read as the YAML value tag and
    // refuse: every read of the workspace by an earlier release was a `YamlTagError`.
    const environment = { X: '=', Y: '<<', Z: '==', L: 'plain' };
    const text = toYaml({
      services: { rocketchat: { environment, command: ['=', 'a'] } },
    } as unknown as ComposeDoc);
    // The bytes this build wrote when earlier releases read them back as exactly this
    // document, recorded.
    expect(text).toBe(RECORDED.indicator_text);
  });
});

/*
 * The spellings below are earlier releases' compose writer's own, recorded for a document
 * holding each value as its one environment value -- the writer itself, not its bare YAML
 * dump, so these tests hold the two writers equal whatever the resolver it dumps with.
 */

describe("the compose writer and earlier releases' YAML reader", () => {
  // Each character the package wrote raw where earlier releases cannot read it raw, alone,
  // inside a word, beside spaces, and beside what the package already handled.
  const values = [
    'a\tb',
    'tab\there',
    'a \t b',
    '\t',
    'a\u007fb',
    'a\u0080b',
    'a\u0085b',
    'a\u009bb',
    'a\u009fb',
    'a\u2028b',
    '\u2028',
    'a\u2029b',
    'a\ufffeb',
    'a\uffffb',
    'caf\u00e9\tb',
    'a\tb\nc',
    'x: \t#',
    'a\u001c\tb',
  ];

  it('writes what earlier releases cannot read raw so that they read the workspace back', () => {
    // `env --set $'X=a\tb'` left `X: a<TAB>b`, and every read of the workspace by an earlier
    // release failed with a YAML scanner error; DEL and C1 with a YAML reader error, NEL read back
    // as a space, a lone U+2028 as null. This build read its own file back, so only earlier
    // releases broke.
    const environment = Object.fromEntries(values.map((value, i) => [`X${String(i)}`, value]));
    const doc = { services: { rocketchat: { environment, command: values, 'k\tey': 'v' } } };
    const text = toYaml(doc as unknown as ComposeDoc);
    // The bytes this build wrote when earlier releases read them back as exactly `doc`.
    expect(text).toBe(RECORDED.unreadable_raw_text);
  });

  it('spells each such value as earlier releases do', () => {
    const ours = values.map((value) =>
      toYaml({ services: { rocketchat: { environment: { X: value } } } } as unknown as ComposeDoc),
    );
    expect(ours).toEqual(RECORDED.unreadable_raw_spelled);
  });
});

describe('the compose writer and a value of blank lines holding spaces', () => {
  // Every string of spaces and line feeds up to six long with a space before a line feed:
  // `' \n'`, `'\n \n'`, `'  \n\n'`, and the ones ending in a space the package quoted.
  const values: string[] = [];
  for (let length = 2; length <= 6; length += 1) {
    for (let bits = 0; bits < 2 ** length; bits += 1) {
      let value = '';
      for (let at = 0; at < length; at += 1) value += (bits >> at) & 1 ? '\n' : ' ';
      if (value.includes(' \n')) values.push(value);
    }
  }

  it('writes them so that earlier releases read the spaces back', () => {
    // The package wrote one ending in a line feed as a `|+` block of blank lines with no
    // indentation indicator, and earlier releases took the spaces for the block's
    // indentation: `env --set $'X= \n'` left a workspace every such read saw as `'\n'`.
    expect(values).toHaveLength(99);
    const environment = Object.fromEntries(values.map((value, i) => [`X${String(i)}`, value]));
    const doc = { services: { rocketchat: { environment, command: values } } };
    // The bytes this build wrote when earlier releases read them back as exactly `doc`.
    expect(toYaml(doc as unknown as ComposeDoc)).toBe(RECORDED.blank_lines_text);
  });

  it('spells each one as earlier releases do, and blank lines without spaces too', () => {
    const ours = values.map((value) =>
      toYaml({ services: { rocketchat: { environment: { X: value } } } } as unknown as ComposeDoc),
    );
    expect(ours).toEqual(RECORDED.blank_lines_spelled);
    // Line feeds alone are single-quoted, as earlier releases write them; the package wrote
    // a `|+` block of them.
    const plain = toYaml({
      services: { rocketchat: { environment: { X: '\n\n' } } },
    } as unknown as ComposeDoc);
    expect(plain).toContain("X: '\n\n\n        '\n");
  });
});

describe('the compose writer and the ints earlier releases read', () => {
  it('writes back a -0 it read as the 0 earlier releases write', () => {
    // Earlier releases' integers have no negative zero: a hand-edited `ZA_NEGZ: -0` reads as
    // 0 there and is written `0`. It read as -0 here, which this writer spelled `-0`.
    const text = 'services:\n  rocketchat:\n    environment:\n      ZA_NEGZ: -0\n      ZB: +0\n';
    const ours = toYaml(safeLoadYaml(text, { timestampsAsText: true }) as ComposeDoc);
    // What earlier releases wrote back after reading `text`.
    const recorded =
      '# Generated by houston. Do not edit by hand -- re-run `houston up`.\n' +
      'services:\n  rocketchat:\n    environment:\n      ZA_NEGZ: 0\n      ZB: 0\n';
    expect(ours).toBe(recorded);
  });
});

describe("the compose writer against earlier releases', byte for byte", () => {
  // Every shipped preset at a current and a pre-8 release, the monitor add-on on and off,
  // built and written by earlier releases; and the same file after the write
  // `env --set X=1e8` makes of it, read back and dumped again. The package's emitter
  // differed from earlier releases' in 7 to 16 lines of every one: `PORT: "3000"` for
  // `'3000'`, the mongo init command unfolded, `1e8` quoted, `ALLOW_EMPTY_PASSWORD: "yes"`.
  // Recorded per case: the spec earlier releases built from (its preset by name), and the
  // sha256 of each file they wrote; two cases' files are spelled out too.
  it('writes every shipped preset as earlier releases do, and rewrites it as env --set does', () => {
    const { presets, cases, spelled_out: spelledOut } = RECORDED.shipped;
    expect(cases.length).toBeGreaterThanOrEqual(36);
    const written = new Map<string, [string, string]>();
    for (const { spec: raw, rc, text_sha256: textSha, rewritten_sha256: rewrittenSha } of cases) {
      const recordedPreset = presets[raw.preset as string] as Record<string, unknown>;
      const built = build(
        spec({
          projectName: raw.project_name as string,
          rcImage: raw.rc_image as string,
          rcTag: raw.rc_tag as string,
          mongoTag: raw.mongo_tag as string,
          mongoFlavor: raw.mongo_flavor as string,
          mongoShell: raw.mongo_shell as string,
          oplog: raw.oplog as boolean,
          rootUrl: raw.root_url as string,
          hostPort: raw.host_port as number,
          regToken: raw.reg_token as string | null,
          preset: presetFromJSON(recordedPreset),
          monitoring: raw.monitoring as boolean,
          envOverrides: raw.env_overrides as Record<string, string | null>,
          containerPort: raw.container_port as number,
          bindHost: raw.bind_host as string,
          adminPassword: raw.admin_password as string,
        }),
      );
      const text = toYaml(built);
      expect({ name: recordedPreset, text: sha256(text) }).toEqual({
        name: recordedPreset,
        text: textSha,
      });
      const read = safeLoadYaml(text, { timestampsAsText: true }) as ComposeDoc;
      ((read.services[rc] as Service).environment as Record<string, unknown>).X = '1e8';
      const rewritten = toYaml(read);
      expect(sha256(rewritten)).toBe(rewrittenSha);
      written.set(`${String(raw.preset)} ${String(raw.rc_tag)} ${String(raw.monitoring)}`, [
        text,
        rewritten,
      ]);
    }
    for (const one of spelledOut) {
      expect(written.get(`${one.preset} ${one.rc_tag} ${String(one.monitoring)}`)).toEqual([
        one.text,
        one.rewritten,
      ]);
    }
  });
});

describe("the compose writer and docker compose's reader", () => {
  // docker compose reads the file with compose-go, whose resolver is yaml.v3's (YAML 1.2 and
  // what it kept); the YAML writer's is YAML 1.1's, so `env --set E1=1e8` wrote `E1: 1e8` and the
  // container got E1=1e+08. Measured on 2026-09-26 with Docker Compose v5.4.0: every value of
  // `corpus()` written by the pre-fix writer, as an environment value and as an item of an
  // `x-` list, and read back with `docker compose -f FILE config --format json` -- the
  // environment is what the container gets, the `x-` list's JSON the type docker gave it.
  // The measurement is the data, so nothing here needs docker.
  /** Value, and what the container received, of the 8,133 values that came back changed. */
  const DOCKER_READ: readonly (readonly [string, string | null])[] = [
    ['1e8', '1e+08'],
    ['0o17', '15'],
    ['-.5', '-0.5'],
    ['12e03', '12000'],
    ['1e-3', '0.001'],
    ['08', '8'],
    ['0778', '778'],
    ['0X1F', '31'],
    ['0O17', '15'],
    ['0B101', '5'],
    ['+_1', '1'],
    ['-_1', '-1'],
    ['1_e8', '1e+08'],
    ['0_x1F', '31'],
    ['.5e3', '500'],
    ['1.5e8', '1.5e+08'],
    ['1e+8', '1e+08'],
    ['1e-400', '0'],
    ['1e308', '1e+308'],
    ['0o1777777777777777777777', '18446744073709551615'],
    ['2001-1-2', '2001-01-02 00:00:00 +0000 UTC'],
    ['2001-12-14 3:4:5', '2001-12-14 03:04:05 +0000 UTC'],
    ['2001-1-2T3:4:5Z', '2001-01-02 03:04:05 +0000 UTC'],
    ['2001-12-14t21:59:43,5-05:00', '2001-12-14 21:59:43.5 -0500 -0500'],
    ['2001-1-2  3:4:5.5', '2001-01-02 03:04:05.5 +0000 UTC'],
    // docker refused the whole file: "Time.MarshalJSON: timezone hour outside of range".
    ['2001-1-2T3:4:5+24:00', null],
  ];
  /** Written plain before and after: docker read each back as the string it is. */
  const DOCKER_KEPT = [
    'plain',
    '8.5.1',
    '10s',
    '0:30',
    '1:60',
    '0x',
    '0b2',
    '._5',
    '1e',
    'y',
    'N',
    '2001-1-2T3:4:5',
    '2001-02-30 3:4:5',
  ];
  /**
   * Strings to yaml.v3 as well -- a float past the double range, an int past 64 bits -- but
   * a magnitude is beyond a resolver's pattern, so they are quoted too. That reads back the
   * same.
   */
  const QUOTED_ANYWAY = ['-1e999', '0o7777777777777777777777', '1e400', '1e999', '2e308'];
  /**
   * The corpus as measured, and the values docker's reading changed: the size, and the
   * sha256 of the sorted values joined by line feeds.
   */
  const CORPUS = [558_352, '7753025fdd54a11c74ff943dc3ce49a33d06cc8a42b0c9556e1d3a0c26cf4878'];
  const MEASURED = [8_133, '0f79efa3b451ce29bd33710b36344856b6d0d28f5aad519e3f684c9ee8a40df5'];

  const ALPHABET = '0123456789+-._:abcdefEoxOXB';
  /** The hand-listed lookalikes; the timestamps and the long or spaced ones are built below. */
  const LOOKALIKES = `
    1e8 1E8 1e+8 1e-8 1e08 12e03 1e-3 -1e8 +1e8 1.5e8 1.e8 1.5E+8 1.5e-8 -1.5e8 +1.5e8 .5e3
    .5E3 .5e+3 .5e-3 -.5 +.5 -.5e3 +.5E-3 -.5e+3 .5 5. -5. +5. 1.0 -0.0 1_0e8 1e8_0 1e_8
    1_e8 1_.5 1._5 1.5_ _1 1_ -_1 +_1 1__0 1_000 1_000_000 1_000.5 1e999 -1e999 1e400 1e308
    2e308 1e-400 1e-324 0x1p3 0x1P-2 0x1.8p1 0X1p3 .5_5 .5__5 ._5 .5e3_0 .5e3_ .5e_3 .e3 ._ .
    ..5 5.. 1.5.5 1e8e8 1e8.5 e8 E8 -e8 +e8 9223372036854775807 9223372036854775808
    -9223372036854775808 -9223372036854775809 18446744073709551615 18446744073709551616
    99999999999999999999 0x1F 0X1F 0xff 0XFF 0xAF 0XAF 0XaF 0x 0X 0xG -0x1 +0X1f -0X1F 0x_1F
    0_x1F 0x1_F 0x1F_ 0xFFFFFFFFFFFFFFFF 0x1FFFFFFFFFFFFFFFF -0x8000000000000000
    -0x8000000000000001 0755 0o755 0O755 0o17 0O17 -0o17 +0o17 -0O17 0o8 0o 0O 0778 0800 08 09
    010 0_7 -0755 +0755 0o_17 0_o17 0o1_7 00 000 0 -0 +0 0. -08 +09 0_8 08_ 0b101 0B101 -0b1
    +0B1 0b2 0B2 0b1_0 0_b1 0b_1 0b 0B 1:30 1:30:00 0:30 190:20:30 1:30.5 -1:30 +1:30 12:60
    1:5 01:30 1:3_0 1_0:30 0:0 1:30: :30 1::30 1:30e3 -0:30 60:60 1:59 1:60 2001-12-14
    2001-1-2 2001-01-2 2001-1-02 2001-02-30 2001-13-01 2001-00-01 2001-01-00 2000-02-29
    2001-02-29 0000-01-01 20010102 2001-01 2001-1 2001-001-01 2001-01-001 201-01-01
    20011-01-01 2001_01_01 2001-0_1-01 1.2.3 8.5.1 127.0.0.1 10s 5m 1h30m 3000/tcp 0x1F/tcp
    - -- --- + ++ 1-2 1+2 1e8# << = ! &a *a | > @ % \`
  `;
  const TIMES = [
    '21:59:43',
    '3:4:5',
    '03:04:05',
    '3:04:05',
    '03:4:05',
    '03:04:5',
    '24:00:00',
    '23:59:60',
    '23:60:00',
    '21:59:43.10',
    '21:59:43.1',
    '21:59:43,5',
    '21:59:43.123456789',
    '21:59:43.1234567891',
    '3:4:5.5',
    '21:59',
    '21:59:43.',
  ];
  const ZONES = [
    '',
    'Z',
    'z',
    '+07:00',
    '-05:00',
    '-5',
    '+07',
    '+0700',
    ' Z',
    ' -5',
    ' +07:00',
    '+24:00',
    '+25:00',
    '+07:60',
    '-05:00:00',
  ];

  /** Every string of up to four characters of ALPHABET, then the rest. */
  function corpus(): string[] {
    const out: string[] = [];
    let level = [''];
    for (let length = 1; length <= 4; length += 1) {
      level = level.flatMap((prefix) => Array.from(ALPHABET, (ch) => prefix + ch));
      for (const value of level) out.push(value);
    }
    const words: [string[], string][] = [
      [['', '.', '-', '+', '-.', '+.'], 'inf nan infinity'],
      [[''], 'true false yes no on off null y n nil none ~'],
    ];
    for (const [prefixes, group] of words) {
      for (const word of group.split(' ')) {
        let cases = [''];
        for (const ch of word) {
          const both = [...new Set([ch.toLowerCase(), ch.toUpperCase()])];
          cases = cases.flatMap((head) => both.map((tail) => head + tail));
        }
        for (const one of [...new Set(cases)].sort()) {
          for (const prefix of prefixes) out.push(prefix + one);
        }
      }
    }
    out.push(...LOOKALIKES.split(/\s+/u).filter(Boolean));
    out.push('1' + '0'.repeat(30), '1' + '0'.repeat(400), '0b' + '1'.repeat(64));
    out.push('0b' + '1'.repeat(65), '0o' + '7'.repeat(22), '0o1' + '7'.repeat(21));
    out.push('1e8 ', ' 1e8', '1e8 x', 'x 1e8', '1 2');
    for (const date of ['2001-12-14', '2001-1-2', '2001-02-30']) {
      for (const sep of ['T', 't', ' ', '  ', '\t', '_']) {
        for (const time of TIMES) for (const zone of ZONES) out.push(date + sep + time + zone);
      }
    }
    return [...new Set(out)];
  }

  function digest(values: Iterable<string>): (number | string)[] {
    const sorted = [...new Set(values)].sort();
    return [sorted.length, createHash('sha256').update(sorted.join('\n')).digest('hex')];
  }

  function environment(value: string): string {
    return toYaml({
      services: { rocketchat: { environment: { X: value } } },
    } as unknown as ComposeDoc);
  }

  it('quotes each value docker compose read as something else, and leaves the rest plain', () => {
    for (const value of [...DOCKER_READ.map(([read]) => read), ...QUOTED_ANYWAY]) {
      expect({ value, text: environment(value) }).toEqual({
        value,
        text: expect.stringContaining(`\n      X: '${value}'\n`) as unknown,
      });
    }
    for (const value of DOCKER_KEPT) {
      expect({ value, text: environment(value) }).toEqual({
        value,
        text: expect.stringContaining(`\n      X: ${value}\n`) as unknown,
      });
    }
  });

  it('writes the measured corpus as earlier releases do, and quotes exactly the values measured', () => {
    const values = corpus();
    expect(digest(values)).toEqual(CORPUS);
    // Each value as a key and as its own value: a simple key and a block value, the two
    // places the emitter decides a scalar's style.
    const ours = toYaml({
      'x-corpus': new Map(values.map((v) => [v, v])),
    } as unknown as ComposeDoc).split('\n');
    // What earlier releases' compose writer wrote for the same mapping: its line count and
    // sha256, and the lines of the values at its edges, by line number -- each value written
    // as a key and as its own value, after the header and `x-corpus:`.
    expect(ours.length).toBe(558_356);
    expect(sha256(ours.join('\n'))).toBe(
      '080d30024b561470b7d3f1bcfabee441796e2feaa9d88f890b06d55b7ef391df',
    );
    for (const [at, line] of [
      [2, "  '0': '0'"],
      [37, "  '08': '08'"],
      [52, '  0x: 0x'],
      [326, "  '-0': '-0'"],
      [2008, "  '1e8': '1e8'"],
      [9106, "  '-.5': '-.5'"],
      [36513, "  '0o17': '0o17'"],
      [50411, "  '1:30': '1:30'"],
      [553565, "  'Yes': 'Yes'"],
      [553599, "  'null': 'null'"],
      [553601, '  y: y'],
      [553602, '  N: N'],
      [553628, "  '~': '~'"],
      [553645, "  '1e999': '1e999'"],
      [553715, "  '2001-1-2': '2001-1-2'"],
      [554278, "  '2001-12-14 21:59:43+07:00': '2001-12-14 21:59:43+07:00'"],
    ] as const) {
      expect([at, ours[at]]).toEqual([at, line]);
    }
    // Against the plain YAML writer (`safeDump` with no options, which the tests of
    // `yaml-dump.ts` hold equal to earlier releases'), the writer quotes the measured values
    // and the five quoted anyway, each in single quotes, and changes nothing else.
    const listed = toYaml({ x: values } as unknown as ComposeDoc)
      .slice(HEADER.length)
      .split('\n');
    const plain = safeDump({ x: values }).split('\n');
    const changed = new Map<string, string>();
    values.forEach((value, at) => {
      const line = listed[at + 1] as string;
      if (line !== plain[at + 1]) changed.set(value, line);
    });
    expect([...changed].filter(([value, line]) => line !== `- '${value}'`)).toEqual([]);
    expect(digest([...changed.keys()].filter((v) => !QUOTED_ANYWAY.includes(v)))).toEqual(MEASURED);
    expect(QUOTED_ANYWAY.filter((value) => !changed.has(value))).toEqual([]);
    expect(DOCKER_READ.filter(([value]) => !changed.has(value))).toEqual([]);
    expect(DOCKER_KEPT.filter((value) => changed.has(value))).toEqual([]);
  }, 120_000);
});

describe('the Rocket.Chat image reference', () => {
  it('runs an image that already names its tag as given, never repo:tag:version', () => {
    // `--rc-image repo:tag` and every CI build rendered `repo:tag:8.5.1`, which no registry
    // resolves, so the pull failed after the whole workspace had been written.
    const image = (rcImage: string) =>
      (build(official({ rcImage })).services.rocketchat as { image: string }).image;
    expect(image('registry.example/rc:custom')).toBe('registry.example/rc:custom');
    expect(image('ghcr.io/rocketchat/rocket.chat:pr-42617')).toBe(
      'ghcr.io/rocketchat/rocket.chat:pr-42617',
    );
    expect(image('registry:5000/org/rc')).toBe('registry:5000/org/rc:8.5.1');
    expect(image('registry.rocket.chat/rocketchat/rocket.chat')).toBe(
      'registry.rocket.chat/rocketchat/rocket.chat:8.5.1',
    );
  });

  it('pins a FIPS build to amd64, the only platform it is published for', () => {
    const service = (rcImage: string) =>
      build(official({ rcImage })).services.rocketchat as Record<string, unknown>;
    expect(service('ghcr.io/rocketchat/rocket.chat:develop-fips').platform).toBe('linux/amd64');
    expect(service('ghcr.io/rocketchat/rocket.chat:pr-1-fips-gha-run-9').platform).toBe(
      'linux/amd64',
    );
    expect('platform' in service('ghcr.io/rocketchat/rocket.chat:develop')).toBe(false);
    expect('platform' in service('registry.rocket.chat/rocketchat/rocket.chat')).toBe(false);
  });
});

describe('the document as the engine needs it', () => {
  const podman = {
    kind: 'podman',
    socket: '/run/user/1001/podman/podman.sock',
    rootDir: '/home/u/.local/share/containers/storage',
  };
  const withCollector = () => {
    const doc = build(official());
    doc.services.collector = {
      image: 'otel',
      volumes: [
        '/var/run/docker.sock:/var/run/docker.sock:ro',
        '/var/lib/docker/containers:/hostfs/storage:ro',
        './x:/x:ro',
      ],
    };
    return doc;
  };

  it("is Docker's own document, the same object, so its bytes cannot move", () => {
    const doc = withCollector();
    expect(
      forEngine(doc, {
        kind: 'docker',
        socket: '/var/run/docker.sock',
        rootDir: '/var/lib/docker',
      }),
    ).toBe(doc);
    expect(forEngine(doc, null)).toBe(doc);
  });

  it("on Podman logs to files, disables SELinux labels, and mounts Podman's own socket and store", () => {
    const out = forEngine(withCollector(), podman);
    expect(out.services.rocketchat?.logging).toEqual({ driver: 'k8s-file' });
    expect(out.services.rocketchat?.security_opt).toEqual(['label=disable']);
    expect(out.services.collector?.volumes).toEqual([
      '/run/user/1001/podman/podman.sock:/var/run/docker.sock:ro',
      '/home/u/.local/share/containers/storage/overlay-containers:/hostfs/storage:ro',
      './x:/x:ro',
    ]);
    // Applied again (monitoring attached later), nothing doubles.
    expect(forEngine(out, podman)).toEqual(out);
  });
});

describe("the official MongoDB's replica-set initiation", () => {
  it('rides out a moment when mongod cannot resolve itself, instead of failing the up', () => {
    // mongod checks `mongodb` resolves to itself at `replSetInitiate`; on rootless Podman
    // that lookup misses for a moment while a neighbouring workspace's network comes or
    // goes. The init was ONE shot with `restart: 'no'`, so one miss failed the whole `up`.
    const service = build(official()).services['mongo-init'] as Service;
    const script = String((service.environment as Record<string, unknown>).RS_INIT);
    let initiated = 0;
    const rs = {
      status: () => {
        if (initiated < 3) throw new Error('no replset config has been received');
        return { ok: 1 };
      },
      initiate: () => {
        initiated += 1;
        if (initiated < 3) throw new Error('NodeNotFound: No host described in new configuration');
      },
    };
    // The shell script itself, run on a stand-in `rs`.
    new Function('rs', 'sleep', script)(rs, () => undefined);
    expect(initiated).toBe(3);
  });

  it('retries the connection itself, which the shell makes before its script runs', () => {
    // A miss of `mongodb` at connect time ended the one shot before the script's own retry
    // ran: a fresh `up` under Podman's DNS churn lost one boot in fifteen, and `restart`
    // re-runs it. The loop is the shell's, bounded, and compose's `$$` reaches it as `$`.
    const service = build(official()).services['mongo-init'] as Service;
    expect(service.entrypoint).toEqual([
      'sh',
      '-c',
      'for i in 1 2 3 4 5 6 7 8 9 10; do mongosh "$$MONGO_URI" --eval "$$RS_INIT" && exit 0; ' +
        'sleep 2; done; exit 1',
    ]);
    expect((service.environment as Record<string, unknown>).MONGO_URI).toBe(
      'mongodb://mongodb:27017/?directConnection=true',
    );
  });
});
