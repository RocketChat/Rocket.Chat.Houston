/**
 * What each shipped preset resolves to, asserted as properties rather than as agreement.
 *
 * `index.test.ts` proves every preset is field-for-field what earlier releases resolved, as
 * recorded; agreeing with a recording can mean agreeing on a wrong answer. These are the claims
 * earlier releases' spec makes about the answers themselves.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../../../src/lib/config';

import { safeLoadAll } from '../../../src/lib/presets/common';
import { UI_PORT_LABEL as KEYCLOAK_UI_PORT_LABEL } from '../../../src/lib/presets/keycloak';
import { UI_PORT_LABEL as LDAP_UI_PORT_LABEL } from '../../../src/lib/presets/ldap';
import { load, resolve } from '../../../src/lib/presets/index';

import type * as ForwardNS from '../../../src/core/kube/forward';

type Doc = Record<string, unknown>;

/** Walk a parsed manifest; a missing step is undefined rather than a throw. */
function g(value: unknown, ...keys: (string | number)[]): unknown {
  let here = value;
  for (const key of keys) {
    if (here === null || typeof here !== 'object') return undefined;
    here = (here as Record<string | number, unknown>)[key];
  }
  return here;
}

function docs(manifest: string | undefined): Doc[] {
  return safeLoadAll(manifest ?? '').filter((d): d is Doc => d !== null && typeof d === 'object');
}

function named(list: Doc[], kind: string, name: string): Doc | undefined {
  return list.find((d) => d.kind === kind && g(d, 'metadata', 'name') === name);
}

function kube(name: string, params: Record<string, unknown> = {}): Doc[] {
  return resolve(name, 'kubernetes', params).kubernetesManifests.flatMap((m) => docs(m));
}

function servicePorts(name: string): Record<string, Set<number>> {
  const out: Record<string, Set<number>> = {};
  for (const d of kube(name)) {
    if (d.kind !== 'Service') continue;
    out[String(g(d, 'metadata', 'name'))] = new Set(
      (g(d, 'spec', 'ports') as { port: number }[]).map((p) => p.port),
    );
  }
  return out;
}

function action(postReady: Record<string, unknown>[], name: string): Doc | undefined {
  return postReady.find((a) => a.action === name);
}

describe('the shipped catalogue, preset by preset', () => {
  it('email: Mailpit, SMTP to it, email 2FA on, verification opt-in', () => {
    const p = load('email');
    expect(p.services).toHaveProperty('mailpit');
    expect(p.dependsOn).toEqual(['mailpit']);
    expect(p.env.OVERWRITE_SETTING_SMTP_Host).toBe('mailpit');
    expect(p.env.OVERWRITE_SETTING_SMTP_Port).toBe('1025');
    // Email 2FA gates only verified users, so a plain admin login keeps working.
    expect(p.env.OVERWRITE_SETTING_Accounts_TwoFactorAuthentication_By_Email_Enabled).toBe('true');
    expect(p.postReady).toEqual([]);
    // rcapi.login fetches codes from here whenever houston's own login is 2FA-gated.
    expect(p.extra.mailpit_url).toBe('http://localhost:8025');
    expect(p.env).not.toHaveProperty('OVERWRITE_SETTING_Accounts_EmailVerification');
    expect(
      load('email', { verification: 'true' }).env.OVERWRITE_SETTING_Accounts_EmailVerification,
    ).toBe('true');
  });

  it('livechat: a widget site, CORS and framing open, a department by default', () => {
    const p = load('livechat');
    expect(p.services).toHaveProperty('widget-site');
    expect(p.env.OVERWRITE_SETTING_Livechat_enabled).toBe('true');
    expect(p.env.OVERWRITE_SETTING_API_Enable_CORS).toBe('true');
    // The widget iframes RC cross-origin; X-Frame-Options: sameorigin would block it.
    expect(p.env.OVERWRITE_SETTING_Iframe_Restrict_Access).toBe('false');
    expect(p.ports).toEqual([8090]);
    expect(Object.fromEntries(p.files)['livechat/index.html']).toContain('{{ROOT_URL}}/livechat');
    expect(p.postReady[0]?.action).toBe('livechat_setup');
    expect(p.postReady[0]?.department).toBe('support');
    expect(load('livechat', { department: 'false' }).postReady[0]?.department).toBe('');
  });

  it('multi-instance: clamps the count to 2..5', () => {
    expect(load('multi-instance', { instances: '1' }).instances).toBe(2);
    expect(load('multi-instance', { instances: '99' }).instances).toBe(5);
  });

  it('multi-instance: NATS plus a file-provider Traefik listing every backend', () => {
    const p = load('multi-instance', { instances: '3' });
    expect(p.instances).toBe(3);
    expect(p.entryService).toBe('traefik');
    expect(Object.keys(p.services)).toEqual(expect.arrayContaining(['nats', 'traefik']));
    expect(p.dependsOn).toEqual(['nats']);
    const dynamic = Object.fromEntries(p.files)['traefik/dynamic.yml'] ?? '';
    expect(dynamic.split('- url:').length - 1).toBe(3);
    expect(dynamic).toContain('http://rocketchat-3:3000');
    // No Docker-socket label discovery, as the official rocketchat-compose does it.
    const volumes = (p.services.traefik?.volumes ?? []) as string[];
    expect(volumes.filter((v) => v.includes('docker.sock'))).toEqual([]);
  });

  it('multi-instance: a count that is not a number names the flag to fix', () => {
    expect(() => load('multi-instance', { instances: 'many' })).toThrow('--set instances=');
  });

  it('default: loads with no backing services', () => {
    const p = load('default');
    expect(p.name).toBe('default');
    expect(p.services).toEqual({});
  });

  it('ldap: generates the asked-for users against a generic server', () => {
    const p = load('ldap', { users: '3' });
    const ldif = Object.fromEntries(p.files)['ldap/50-rc-users.ldif'] ?? '';
    expect(ldif.split('dn: uid=user').length - 1).toBe(3);
    expect(p.services).toHaveProperty('openldap');
    expect(p.env.OVERWRITE_SETTING_LDAP_Server_Type).toBe('');
  });

  it('saml: the realm scales with users and the IdP cert is fetched at runtime', () => {
    const p = load('saml', { users: '4' });
    const realm = JSON.parse(Object.fromEntries(p.files)['saml/keycloak-realm.json'] ?? '{}') as {
      users: { username: string }[];
      sslRequired: string;
    };
    expect(realm.users.map((u) => u.username)).toEqual(['user1', 'user2', 'user3', 'user4']);
    expect(realm.sslRequired).toBe('none');
    expect(p.postReady.length).toBeGreaterThan(0);
  });

  it('an unknown name is refused', () => {
    expect(() => load('does-not-exist')).toThrow('unknown preset');
  });

  it('s3_minio: MinIO and its init, proxied by default, persisted in a named volume', () => {
    const p = load('s3_minio');
    expect(Object.keys(p.services)).toEqual(expect.arrayContaining(['minio', 'minio-init']));
    expect(p.env.OVERWRITE_SETTING_FileUpload_Storage_Type).toBe('AmazonS3');
    expect(p.env.OVERWRITE_SETTING_FileUpload_S3_ForcePathStyle).toBe('true');
    expect(p.env.OVERWRITE_SETTING_FileUpload_S3_Proxy_Uploads).toBe('true');
    expect(p.env.OVERWRITE_SETTING_FileUpload_S3_Proxy_Avatars).toBe('true');
    expect(p.volumes).toEqual({ minio_data: { driver: 'local' } });
    expect(p.dependsOn).toEqual(['minio']);
  });

  it('s3_minio: presigned mode, a custom bucket, the bare endpoint and SigV2', () => {
    const p = load('s3_minio', { presigned: 'true', bucket: 'tickets' });
    expect(p.env.OVERWRITE_SETTING_FileUpload_S3_Proxy_Uploads).toBe('false');
    expect(p.env.OVERWRITE_SETTING_FileUpload_S3_Bucket).toBe('tickets');
    // The ENDPOINT with no bucket on it: ForcePathStyle already builds
    // {endpoint}/{bucket}/{key}, so a bucket here is repeated as a key prefix.
    expect(p.env.OVERWRITE_SETTING_FileUpload_S3_BucketURL).toBe('http://minio:9000');
    // v2: RC 7.13.x's aws-sdk v2 honours it, and v4 stops RC booting.
    expect(p.env.OVERWRITE_SETTING_FileUpload_S3_SignatureVersion).toBe('v2');
    expect(p.notes.some((n) => n.includes('/etc/hosts'))).toBe(true);
    const entrypoint = (p.services['minio-init']?.entrypoint ?? []) as string[];
    expect(entrypoint[entrypoint.length - 1]).toContain('local/tickets');
  });

  it('s3_minio: an invalid bucket name is refused, naming the bucket', () => {
    expect(() => load('s3_minio', { bucket: 'Bad Name!' })).toThrow('bucket');
  });

  it('s3_minio: creates its bucket on both runtimes, as a Job on Kubernetes', () => {
    // MinIO running is not the bucket existing, and neither MinIO nor Rocket.Chat creates
    // one on demand -- so on Kubernetes every upload had nowhere to go.
    const compose = resolve('s3_minio', 'docker', { bucket: 'tickets' });
    const init = (compose.services['minio-init']?.entrypoint ?? []) as string[];
    expect(init.join(' ')).toContain('mc mb -p local/tickets');

    const jobs = kube('s3_minio', { bucket: 'tickets' }).filter((d) => d.kind === 'Job');
    expect(jobs.length).toBeGreaterThan(0);
    const job = jobs[0] as Doc;
    const spec = g(job, 'spec', 'template', 'spec');
    const cmd = (g(spec, 'containers', 0, 'command') as string[]).join(' ');
    expect(cmd).toContain('mc mb -p local/tickets');
    // It is applied alongside the Deployment, so it must wait for MinIO.
    expect(cmd).toContain('until mc alias set');
    // A Job, not an init container, which would wait for a MinIO that cannot start.
    expect(g(spec, 'restartPolicy')).toBe('OnFailure');
    expect(g(job, 'spec', 'backoffLimit')).toBeGreaterThanOrEqual(1);
    expect(g(job, 'metadata', 'labels', 'app.kubernetes.io/managed-by')).toBe('houston');
  });

  it('a user preset’s notes and params help are read from its YAML', () => {
    fs.mkdirSync(config.presetDir(), { recursive: true });
    fs.writeFileSync(
      path.join(config.presetDir(), 'team.yaml'),
      'name: team\nnotes: [tip one, tip two]\nparams_help: {x: does x}\n',
      'utf8',
    );
    const p = load('team');
    expect(p.notes).toEqual(['tip one', 'tip two']);
    expect(p.paramsHelp).toEqual({ x: 'does x' });
    fs.rmSync(path.join(config.presetDir(), 'team.yaml'));
  });
});

describe('what the browser is sent to', () => {
  it('moves the SAML entry point, SLO and OIDC url together with idp_host', () => {
    // Followed by the BROWSER: `localhost` names each visitor's own laptop on a shared box,
    // and Keycloak refuses a Destination that differs from the URL the request arrived on.
    const saml = load('saml', { idp_host: 'rc.example.com' });
    const entry = saml.env.OVERWRITE_SETTING_SAML_Custom_Default_entry_point;
    expect(entry).toBe('http://rc.example.com:8081/realms/houston/protocol/saml');
    expect(saml.env.OVERWRITE_SETTING_SAML_Custom_Default_idp_slo_redirect_url).toBe(entry);
    // The DESCRIPTOR is fetched by houston itself, so it stays on loopback.
    expect(g(action(saml.postReady, 'saml_idp_cert'), 'descriptor_url')).toMatch(
      /^http:\/\/localhost:8081\//u,
    );

    const oidc = load('oidc', { idp_host: 'rc.example.com' });
    expect(
      g(
        action(oidc.postReady, 'create_oauth_provider'),
        'settings',
        'Accounts_OAuth_Custom-Keycloak-url',
      ),
    ).toBe('http://rc.example.com:8085/realms/houston');

    // Default unchanged, so a laptop workspace keeps working.
    expect(load('saml', {}).env.OVERWRITE_SETTING_SAML_Custom_Default_entry_point).toContain(
      'localhost:8081',
    );
    expect(
      g(load('oidc', {}).postReady[1], 'settings', 'Accounts_OAuth_Custom-Keycloak-url'),
    ).toContain('keycloak:8085');
  });

  it('addresses presigned MinIO by s3_host, and stops asking for a hosts entry', () => {
    const key = 'OVERWRITE_SETTING_FileUpload_S3_BucketURL';
    expect(load('s3_minio', {}).env[key]).toBe('http://minio:9000');
    expect(load('s3_minio', { presigned: '1' }).env[key]).toBe('http://minio:9000');
    const moved = load('s3_minio', { presigned: '1', s3_host: 'box.example.com' });
    expect(moved.env[key]).toBe('http://box.example.com:9000');
    const body = moved.notes.join(' ');
    expect(body).not.toContain('127.0.0.1  minio');
    expect(body).toContain('no hosts entry is needed');
    // Proxy mode: RC streams the bytes and the browser never contacts MinIO.
    expect(load('s3_minio', {}).notes.join(' ')).toContain('proxied through RC');
  });

  it('lets an https workspace’s callback back into the OIDC realm', () => {
    // Keycloak refuses an unlisted callback outright, so both schemes must be listed.
    const realm = JSON.parse(load('oidc', {}).files[0]?.[1] ?? '{}') as {
      clients: { redirectUris: string[] }[];
    };
    const uris = realm.clients[0]?.redirectUris ?? [];
    expect(uris.some((u) => u.startsWith('https://'))).toBe(true);
    expect(uris.some((u) => u.startsWith('http://'))).toBe(true);
  });
});

describe('the port registry, on every runtime', () => {
  it('is exactly what every preset declares, through both adapters', () => {
    // Allocation and the collision pre-flight both read this list, and skip entirely when
    // it is empty -- so a Kubernetes adapter that forgot `ports` got no refusal at all.
    for (const [name, expected] of Object.entries(config.PRESET_PORTS)) {
      expect({ name, ports: load(name).ports }).toEqual({ name, ports: [...expected] });
      for (const runtime of ['docker', 'kubernetes']) {
        expect({ name, runtime, ports: resolve(name, runtime, {}).ports }).toEqual({
          name,
          runtime,
          ports: [...expected],
        });
      }
    }
    expect(load('default').ports).toEqual([]);
  });
});

/** Every registry port moved by 100, as a second workspace with each preset would get them. */
const SHIFTED: config.PortMap = Object.fromEntries(
  Object.entries(config.PRESET_PORTS).map(([name, ports]) => [name, ports.map((p) => p + 100)]),
);

/** Each preset in every shape that publishes something different, on both runtimes. */
const SHAPES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['email', {}],
  ['saml', {}],
  ['oidc', {}],
  ['s3_minio', {}],
  ['s3_minio', { presigned: 'true' }],
  ['livechat', {}],
  ['ldap', {}],
  ['ldap', { idp: 'saml' }],
  ['ldap', { idp: 'oidc' }],
  ['webhooks', {}],
];

describe('a workspace given shifted ports', () => {
  it('publishes exactly the ports it was given, through both adapters', () => {
    // A second workspace with the same preset is given other ports. Every one it declares is
    // the one allocation chose: what it claims is what it publishes.
    for (const [name, params] of SHAPES) {
      const idp = String(params.idp ?? 'none');
      const expected = [
        ...(SHIFTED[name] ?? []),
        ...(name === 'ldap' && idp !== 'none' ? (SHIFTED[idp] ?? []) : []),
      ];
      for (const runtime of ['docker', 'kubernetes']) {
        expect({
          name,
          params,
          runtime,
          ports: resolve(name, runtime, params, SHIFTED).ports,
        }).toEqual({ name, params, runtime, ports: expected });
      }
    }
  });

  it('sends nobody to a preferred port: no address names one, on either runtime', () => {
    // An address still built from the registry opens SOMEONE ELSE's Mailpit, Keycloak or
    // console. Container-side numbers (Mailpit's 8025 inside, Keycloak's 8080) are not
    // addresses a browser or houston follows, so the pattern names a host before the port.
    const preferred = Object.values(config.PRESET_PORTS).flat();
    const address = new RegExp(
      `(localhost|127\\.0\\.0\\.1|keycloak|minio):(${preferred.join('|')})\\b`,
      'u',
    );
    // The pattern finds them where they are: at the preferred ports, every preset names one.
    for (const [name, params] of SHAPES) {
      expect({
        name,
        params,
        found: address.test(JSON.stringify(resolve(name, 'docker', params))),
      }).toEqual({ name, params, found: true });
    }
    for (const [name, params] of SHAPES) {
      for (const runtime of ['docker', 'kubernetes']) {
        const text = JSON.stringify(resolve(name, runtime, params, SHIFTED));
        expect({ name, params, runtime, found: address.exec(text)?.[0] ?? null }).toEqual({
          name,
          params,
          runtime,
          found: null,
        });
      }
    }
  });

  it('wires each side service to its own port where the browser, Rocket.Chat and houston meet it', () => {
    const email = load('email', {}, SHIFTED);
    expect(email.services.mailpit?.ports).toEqual(['8125:8025']);
    // houston reads email 2FA codes from here: another workspace's inbox would never get them.
    expect(email.extra.mailpit_url).toBe('http://localhost:8125');
    expect(
      g(named(kube2('email'), 'Service', 'mailpit'), 'metadata', 'labels', 'houston.io/ui-port'),
    ).toBe('8125');

    const saml = load('saml', {}, SHIFTED);
    expect(saml.services.keycloak?.ports).toEqual(['8181:8080']);
    expect(saml.env.OVERWRITE_SETTING_SAML_Custom_Default_entry_point).toBe(
      'http://localhost:8181/realms/houston/protocol/saml',
    );
    expect(action(saml.postReady, 'saml_idp_cert')?.descriptor_url).toBe(
      'http://localhost:8181/realms/houston/protocol/saml/descriptor',
    );

    // OIDC listens on its host port: the one URL means one port to the browser and to RC.
    const oidc = load('oidc', {}, SHIFTED);
    expect(oidc.services.keycloak?.ports).toEqual(['8185:8185']);
    expect(g(oidc.services.keycloak, 'environment', 'KC_HTTP_PORT')).toBe('8185');
    expect(action(oidc.postReady, 'keycloak_master_ssl_off')?.port).toBe(8185);
    expect(g(action(oidc.postReady, 'create_oauth_provider'), 'settings')).toEqual(
      expect.objectContaining({
        'Accounts_OAuth_Custom-Keycloak-url': 'http://keycloak:8185/realms/houston',
      }),
    );
    const oidcService = named(kube2('oidc'), 'Service', 'keycloak');
    expect(g(oidcService, 'spec', 'ports', 0, 'port')).toBe(8185);

    // MinIO's S3 API is followed by RC and (presigned) the browser at one URL, so MinIO has to
    // LISTEN on the moved port; its console already listens where it is published.
    const s3 = load('s3_minio', {}, SHIFTED);
    expect(s3.services.minio?.ports).toEqual(['9100:9100', '9101:9101']);
    expect(s3.services.minio?.command).toEqual([
      'server',
      '/data',
      '--console-address',
      ':9101',
      '--address',
      ':9100',
    ]);
    expect(s3.env.OVERWRITE_SETTING_FileUpload_S3_BucketURL).toBe('http://minio:9100');
    expect(JSON.stringify(s3.services['minio-init'])).toContain('http://minio:9100');
    const minio = named(kube2('s3_minio'), 'Deployment', 'minio');
    const container = g(minio, 'spec', 'template', 'spec', 'containers', 0);
    expect(g(container, 'args')).toEqual(s3.services.minio?.command);
    expect(g(container, 'readinessProbe', 'httpGet', 'port')).toBe(9100);
    // At the preferred ports MinIO runs the command it always did.
    expect(load('s3_minio').services.minio?.command).toEqual([
      'server',
      '/data',
      '--console-address',
      ':9001',
    ]);

    const livechat = load('livechat', {}, SHIFTED);
    expect(livechat.services['widget-site']?.ports).toEqual(['8190:80']);
    expect(Object.fromEntries(livechat.files)['livechat/index.html']).toContain(
      'http://localhost:8190',
    );

    const ldap = resolve('ldap', 'docker', { idp: 'saml' }, SHIFTED);
    expect(ldap.services.phpldapadmin?.ports).toEqual(['8182:8080']);
    expect(ldap.services.keycloak?.ports).toEqual(['8181:8080']);
    const ldapUi = named(kube2('ldap', { idp: 'oidc' }), 'Service', 'phpldapadmin');
    expect(g(ldapUi, 'metadata', 'labels', LDAP_UI_PORT_LABEL)).toBe('8182');
    const ldapKeycloak = named(kube2('ldap', { idp: 'oidc' }), 'Deployment', 'keycloak');
    expect(g(ldapKeycloak, 'spec', 'template', 'metadata', 'labels', KEYCLOAK_UI_PORT_LABEL)).toBe(
      '8185',
    );
  });
});

/** `kube`, for a workspace given the shifted ports. */
function kube2(name: string, params: Record<string, unknown> = {}): Doc[] {
  return resolve(name, 'kubernetes', params, SHIFTED).kubernetesManifests.flatMap((m) => docs(m));
}

describe('the ldap scenario', () => {
  it('renders ONE intent for both runtimes: shared settings, different backing', () => {
    const params = { users: '7', domain: 'example.org' };
    const compose = resolve('ldap', 'docker', params);
    const kubeSide = resolve('ldap', 'kubernetes', params);
    expect([compose.scenario, kubeSide.scenario]).toEqual(['ldap', 'ldap']);
    expect(compose.scenarioParams).toEqual(kubeSide.scenarioParams);
    for (const key of ['OVERWRITE_SETTING_LDAP_BaseDN', 'OVERWRITE_SETTING_LDAP_Host']) {
      expect({ key, v: compose.env[key] }).toEqual({ key, v: kubeSide.env[key] });
    }
    expect(Object.keys(compose.services).length).toBeGreaterThan(0);
    expect(compose.kubernetesManifests).toEqual([]);
    expect(kubeSide.kubernetesManifests.length).toBeGreaterThan(0);
    expect(kubeSide.services).toEqual({});
  });

  it('publishes its UI on the same registry port on both runtimes', () => {
    // Compose maps a host port; Kubernetes labels the Service and the lifecycle forwards
    // it. NodePort's 30000-32767 range would have made the numbers differ.
    const want = config.PRESET_PORTS.ldap?.[0] as number;
    const compose = resolve('ldap', 'docker', {});
    // phpLDAPadmin 2 listens on 8080 (it runs as www-data).
    expect(compose.services.phpldapadmin?.ports).toEqual([`${String(want)}:8080`]);
    expect(compose.ports).toEqual([want]);
    const svc = named(kube('ldap'), 'Service', 'phpldapadmin');
    expect(g(svc, 'metadata', 'labels', LDAP_UI_PORT_LABEL)).toBe(String(want));
    expect(g(svc, 'spec', 'ports', 0, 'port')).toBe(80);
    // The lifecycle forwards the host port to `targetPort`: the container's own.
    expect(g(svc, 'spec', 'ports', 0, 'targetPort')).toBe(8080);
    // The label the lifecycle looks for is the label the adapter writes.
    const forward = jest.requireActual<typeof ForwardNS>('../../../src/core/kube/forward');
    expect(LDAP_UI_PORT_LABEL).toBe(forward.UI_PORT_LABEL);
  });

  it('ships the directory AND a browser for it, on both runtimes', () => {
    const compose = resolve('ldap', 'docker', {});
    expect(Object.keys(compose.services).sort()).toEqual(['openldap', 'phpldapadmin']);
    expect(compose.services.phpldapadmin?.depends_on).toEqual(['openldap']);
    const kinds = kube('ldap').map((d) => [d.kind, g(d, 'metadata', 'name')]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['Deployment', 'phpldapadmin'],
        ['Deployment', 'openldap'],
        ['ConfigMap', 'openldap-bootstrap'],
      ]),
    );
  });
});

describe('the Kubernetes renderings', () => {
  it('carries both Keycloak renderings on one preset, with the same realm bytes', () => {
    // Not a two-adapter Scenario: the realm, the settings and post_ready do not care where
    // the IdP runs, so one Preset carries both and two copies cannot drift.
    for (const name of ['saml', 'oidc']) {
      const p = load(name, { users: '3' });
      expect({ name, has: 'keycloak' in p.services }).toEqual({ name, has: true });
      const byKind = Object.fromEntries(
        docs(p.kubernetesManifests[0]).map((d) => [String(d.kind), d]),
      );
      expect(Object.keys(byKind).sort()).toEqual(['ConfigMap', 'Deployment', 'Service']);
      expect(g(byKind.ConfigMap, 'data', 'houston-realm.json')).toBe(
        Object.fromEntries(p.files)[`${name}/keycloak-realm.json`],
      );
      // `keycloak` on both, because RC's backend and the browser must resolve one name.
      expect(g(byKind.Service, 'metadata', 'name')).toBe('keycloak');
      const want = config.PRESET_PORTS[name]?.[0] as number;
      expect(g(byKind.Service, 'spec', 'ports', 0, 'port')).toBe(want);
      expect(g(byKind.Service, 'metadata', 'labels', KEYCLOAK_UI_PORT_LABEL)).toBe(String(want));
    }
  });

  it('mounts the realm as a FILE, with subPath, or Keycloak imports nothing', () => {
    const dep = docs(load('oidc', {}).kubernetesManifests[0]).find((d) => d.kind === 'Deployment');
    const mount = g(dep, 'spec', 'template', 'spec', 'containers', 0, 'volumeMounts', 0);
    expect(g(mount, 'subPath')).toBe('houston-realm.json');
    expect(String(g(mount, 'mountPath')).endsWith('/import/houston-realm.json')).toBe(true);
  });

  it('gives every scenario workload a readiness probe that tests what serves', () => {
    // Without one a pod is Ready the instant its container starts -- forty seconds before
    // Keycloak serves -- and post_ready fetches a descriptor from nothing.
    for (const name of ['ldap', 'saml', 'oidc', 'email', 's3_minio', 'livechat', 'webhooks']) {
      const deployments = kube(name).filter((d) => d.kind === 'Deployment');
      expect({ name, count: deployments.length > 0 }).toEqual({ name, count: true });
      for (const dep of deployments) {
        const probe = g(dep, 'spec', 'template', 'spec', 'containers', 0, 'readinessProbe') as
          Doc | undefined;
        const at = `${name}/${String(g(dep, 'metadata', 'name'))}`;
        expect({ at, probe: probe !== undefined }).toEqual({ at, probe: true });
        expect({ at, kind: 'httpGet' in (probe ?? {}) || 'tcpSocket' in (probe ?? {}) }).toEqual({
          at,
          kind: true,
        });
        const threshold = probe?.failureThreshold;
        expect({ at, patient: (typeof threshold === 'number' ? threshold : 3) >= 30 }).toEqual({
          at,
          patient: true,
        });
      }
    }
  });

  it('exposes every port a workload listens on, published one first', () => {
    // A Service forwards only DECLARED ports: publishing Mailpit's UI alone left SMTP on
    // 1025 unreachable from Rocket.Chat, which is where the mail comes from.
    const ports = (g(named(kube('email'), 'Service', 'mailpit'), 'spec', 'ports') ?? []) as {
      port: number;
    }[];
    expect(new Set(ports.map((p) => p.port))).toEqual(new Set([8025, 1025]));
    expect(ports[0]?.port).toBe(8025);
    const minio = servicePorts('s3_minio');
    expect(minio.minio).toEqual(new Set([9000, 9001]));
    const minioConsole = named(kube('s3_minio'), 'Service', 'minio-console');
    expect(g(minioConsole, 'metadata', 'labels', 'houston.io/ui-deployment')).toBe('minio');
  });

  it('carries every host:port a preset points Rocket.Chat at on a Service', () => {
    // Read from the settings themselves, so a preset gaining a backing port cannot skip it.
    for (const name of ['email', 's3_minio', 'ldap', 'oidc']) {
      const svc = servicePorts(name);
      const env = resolve(name, 'kubernetes', {}).env;
      for (const [key, host] of Object.entries(env)) {
        if (!key.endsWith('_Host')) continue;
        const portValue = env[`${key.slice(0, -'_Host'.length)}_Port`];
        if (!portValue || !(host in svc)) continue;
        const port = Number(String(portValue).replace(/\D/gu, '') || 0);
        expect({ name, host, port, served: svc[host]?.has(port) }).toEqual({
          name,
          host,
          port,
          served: true,
        });
      }
    }
  });
});
