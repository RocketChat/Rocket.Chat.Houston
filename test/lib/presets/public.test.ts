/**
 * A preset's own UIs at paths of the workspace's HTTPS name: Mailpit, the livechat demo page,
 * Keycloak, the MinIO console and phpLDAPadmin, on both runtimes.
 */
import * as config from '../../../src/lib/config';
import { safeLoadAll } from '../../../src/lib/presets/common';
import { load, loadMany, resolve } from '../../../src/lib/presets/index';
import {
  PRESIGNED_OVER_HTTPS,
  presignedOverHttps,
  publicPathsOf,
  withPublicUrl,
} from '../../../src/lib/presets/public';
import type { Preset } from '../../../src/lib/presets/types';

const URL_ = 'https://ws.houston.localhost';
type Bag = Record<string, unknown>;
const docs = (pre: Preset): Bag[] =>
  pre.kubernetesManifests.flatMap((manifest) => safeLoadAll(manifest)) as Bag[];
const deployment = (pre: Preset, name: string) =>
  docs(pre).find((d) => d.kind === 'Deployment' && (d.metadata as Bag).name === name) as {
    spec: { template: { spec: { containers: Bag[] } } };
  };
const container = (pre: Preset, name: string) =>
  deployment(pre, name).spec.template.spec.containers[0] as {
    env: { name: string; value: string }[];
    readinessProbe?: { httpGet?: { path: string } };
    volumeMounts?: { mountPath: string; subPath?: string }[];
  };
const realmOf = (text: string) => JSON.parse(text) as { clients: { redirectUris: string[] }[] };

describe('Mailpit at /mailpit', () => {
  it('serves under its web root on Compose, and houston reads its API there', () => {
    const pre = withPublicUrl(load('email', {}), URL_, 'docker');
    expect(pre.services.mailpit?.environment).toMatchObject({ MP_WEBROOT: '/mailpit' });
    expect(pre.extra.mailpit_url).toBe('http://localhost:8025/mailpit');
    expect(publicPathsOf(pre.extra)).toEqual([
      {
        preset: 'email',
        path: '/mailpit',
        service: 'mailpit',
        container_port: 8025,
        service_port: 8025,
      },
    ]);
    // Its port answers only under the path now, so the notes give the public address.
    expect(pre.notes.join('\n')).toContain(`${URL_}/mailpit/`);
    expect(pre.notes.join('\n')).not.toContain('http://localhost:8025');
  });

  it('serves under its web root on Kubernetes, ready only once that answers', () => {
    const pre = withPublicUrl(resolve('email', 'kubernetes', {}), URL_, 'kubernetes');
    const c = container(pre, 'mailpit');
    expect(c.env).toEqual(expect.arrayContaining([{ name: 'MP_WEBROOT', value: '/mailpit' }]));
    expect(c.readinessProbe?.httpGet?.path).toBe('/mailpit/');
  });
});

describe('the livechat demo page at /livechat-demo', () => {
  it('serves a separate public page while keeping the port for cross-origin', () => {
    const docker = withPublicUrl(load('livechat', {}), URL_, 'docker');
    expect(docker.services['widget-site']?.volumes).toEqual([
      './livechat/index.html:/usr/share/nginx/html/index.html:ro',
      './livechat/public.html:/usr/share/nginx/html/livechat-demo/index.html:ro',
    ]);
    expect(docker.ports).toEqual(load('livechat', {}).ports);
    expect(docker.notes.join('\n')).toContain('same origin as Rocket.Chat');
    const kube = withPublicUrl(resolve('livechat', 'kubernetes', {}), URL_, 'kubernetes');
    expect(container(kube, 'widget-site').volumeMounts?.map((m) => m.mountPath)).toEqual([
      '/usr/share/nginx/html/index.html',
      '/usr/share/nginx/html/livechat-demo/index.html',
    ]);
    // Not /livechat: Rocket.Chat serves its own widget there on the same host. The Ingress
    // targets the Service's port (80); 8090 is only the host's port-forward.
    expect(publicPathsOf(kube.extra)).toEqual([
      {
        preset: 'livechat',
        path: '/livechat-demo',
        service: 'widget-site',
        container_port: 80,
        service_port: 80,
      },
    ]);
  });

  it.each(['docker', 'kubernetes'])('describes the served %s page origin accurately', (runtime) => {
    const original = resolve('livechat', runtime, {});
    const pre = withPublicUrl(original, URL_, runtime);
    let servedPage: string | undefined;
    if (runtime === 'docker') {
      const volumes = pre.services['widget-site']?.volumes as string[];
      const mount = volumes.find((value) => value.includes('/livechat-demo/index.html'));
      const file = mount?.split(':')[0]?.replace(/^\.\//u, '');
      servedPage = pre.files.find(([name]) => name === file)?.[1];
    } else {
      const mount = container(pre, 'widget-site').volumeMounts?.find((value) =>
        value.mountPath.endsWith('/livechat-demo/index.html'),
      );
      const configMap = docs(pre).find(
        (value) =>
          value.kind === 'ConfigMap' && (value.metadata as Bag).name === 'widget-site-files',
      );
      servedPage = (configMap?.data as Record<string, string>)[mount?.subPath ?? ''];
    }
    expect(servedPage).toContain("this storefront shares Rocket.Chat's HTTPS origin");
    expect(servedPage).toContain(
      'Use the separate demo port to test cross-origin CORS and framing.',
    );
    expect(servedPage).not.toContain('http://localhost:8090');
    expect(pre.files.find(([name]) => name === 'livechat/index.html')?.[1]).toBe(
      original.files.find(([name]) => name === 'livechat/index.html')?.[1],
    );
    expect(original.files.find(([name]) => name === 'livechat/index.html')?.[1]).toContain(
      'widget cross-origin.',
    );
  });
});

describe('Keycloak at /keycloak', () => {
  it('sends the SAML browser to the public path, and houston fetches the IdP under it', () => {
    const pre = withPublicUrl(load('saml', {}), URL_, 'docker');
    expect(pre.services.keycloak?.environment).toMatchObject({
      KC_HTTP_RELATIVE_PATH: '/keycloak',
      KC_HOSTNAME: `${URL_}/keycloak`,
      KC_HOSTNAME_BACKCHANNEL_DYNAMIC: 'true',
    });
    expect(pre.env.OVERWRITE_SETTING_SAML_Custom_Default_entry_point).toBe(
      `${URL_}/keycloak/realms/houston/protocol/saml`,
    );
    expect(pre.postReady).toEqual([
      expect.objectContaining({
        action: 'saml_idp_cert',
        descriptor_url: 'http://localhost:8081/keycloak/realms/houston/protocol/saml/descriptor',
      }),
      expect.objectContaining({ action: 'keycloak_master_ssl_off', path: '/keycloak' }),
    ]);
    // The admin console and the users page are under the path; no note sends anyone to :8081.
    expect(pre.notes.join('\n')).not.toContain('localhost:8081');
    expect(pre.notes.join('\n')).toContain(`${URL_}/keycloak/admin/master/console/#/houston/users`);
    const realm = realmOf(
      (pre.files.find(([f]) => f.endsWith('keycloak-realm.json')) as [string, string])[1],
    );
    expect(realm.clients[0]?.redirectUris).toContain(`${URL_}/*`);
    expect(publicPathsOf(pre.extra)).toEqual([
      {
        preset: 'keycloak',
        path: '/keycloak',
        service: 'keycloak',
        container_port: 8080,
        service_port: 8081,
      },
    ]);
  });

  it('lets OIDC authorize at the public path and exchange the code on the back channel', () => {
    const pre = withPublicUrl(resolve('oidc', 'kubernetes', {}), URL_, 'kubernetes');
    const create = pre.postReady.find((a) => a.action === 'create_oauth_provider') as {
      settings: Record<string, unknown>;
    };
    expect(create.settings).toMatchObject({
      'Accounts_OAuth_Custom-Keycloak-url': `${URL_}/keycloak/realms/houston`,
      'Accounts_OAuth_Custom-Keycloak-token_path':
        'http://keycloak:8085/keycloak/realms/houston/protocol/openid-connect/token',
      'Accounts_OAuth_Custom-Keycloak-identity_path':
        'http://keycloak:8085/keycloak/realms/houston/protocol/openid-connect/userinfo',
      // Relative, so the browser goes to the public URL above.
      'Accounts_OAuth_Custom-Keycloak-authorize_path': '/protocol/openid-connect/auth',
    });
    const c = container(pre, 'keycloak');
    expect(c.readinessProbe?.httpGet?.path).toBe('/keycloak/realms/master');
    const cm = docs(pre).find((d) => (d.metadata as Bag).name === 'keycloak-realm') as {
      data: Record<string, string>;
    };
    expect(realmOf(cm.data['houston-realm.json'] as string).clients[0]?.redirectUris).toContain(
      `${URL_}/*`,
    );
    // No hosts entry to add: the browser reaches Keycloak by the workspace's own name.
    expect(pre.notes.join('\n')).not.toContain('/etc/hosts');
    expect(pre.notes.join('\n')).toContain(`Keycloak admin console: ${URL_}/keycloak`);
    expect(pre.notes.join('\n')).not.toContain('host entry');
  });

  it("serves a directory's own SSO too, beside Mailpit in a composed workspace", () => {
    const pre = withPublicUrl(
      loadMany(['email', 'ldap'], { ldap: { idp: 'oidc' } }, 'docker'),
      URL_,
      'docker',
    );
    expect(publicPathsOf(pre.extra).map((p) => p.path)).toEqual([
      '/mailpit',
      '/keycloak',
      '/phpldapadmin',
    ]);
  });
});

describe("Keycloak's hosts-entry notes", () => {
  it("are dropped without taking a composed preset's own hosts entry with them", () => {
    const pre = withPublicUrl(
      loadMany(['saml', 's3_minio'], { s3_minio: { presigned: 'true' } }, 'docker'),
      URL_,
      'docker',
    );
    const notes = pre.notes.join('\n');
    // s3_minio's presigned mode still says where its line goes, and how to avoid it.
    expect(notes).toContain('this line to /etc/hosts (needs sudo):');
    expect(notes).toContain(
      '  That entry works only for a browser on the machine running houston.',
    );
    expect(notes).toContain('--set s3_host=<this host>');
    // saml's own were for a browser reaching Keycloak by port.
    expect(notes).not.toContain('idp_host');
    expect(notes).not.toContain('Keycloak refuses');
  });

  it("are dropped for a directory's own SSO", () => {
    const notes = withPublicUrl(load('ldap', { idp: 'oidc' }), URL_, 'docker').notes.join('\n');
    expect(notes).not.toContain('hosts entry');
    expect(notes).not.toContain('idp_host');
  });
});

describe('the MinIO console at /minio', () => {
  const conf = (text: string) => {
    expect(text).toContain('location /minio/ {');
    // The trailing slash is the strip: /minio/x reaches the console as /x.
    expect(text).toContain('proxy_pass http://minio:9001/;');
    expect(text).toContain('proxy_set_header Upgrade $http_upgrade;');
  };

  it('names its public base and is reached through its own prefix-stripping nginx (Compose)', () => {
    const pre = withPublicUrl(load('s3_minio', {}), URL_, 'docker');
    expect(pre.services.minio?.environment).toMatchObject({
      MINIO_BROWSER_REDIRECT_URL: `${URL_}/minio/`,
    });
    expect(pre.services['minio-ui']).toMatchObject({
      volumes: ['./s3_minio/minio-ui.conf:/etc/nginx/conf.d/default.conf:ro'],
      depends_on: ['minio'],
    });
    // The console's port is the nginx's, which sends / to /minio/: localhost:9001 keeps
    // opening the console, whose page now names /minio/ as its base.
    expect(pre.services['minio-ui']?.ports).toEqual(['9001:80']);
    expect(pre.services.minio?.ports).toEqual(['9000:9000']);
    const text = (pre.files.find(([f]) => f === 's3_minio/minio-ui.conf') as [string, string])[1];
    conf(text);
    expect(text).toContain('location = / { return 302 /minio/; }');
    expect(publicPathsOf(pre.extra)).toEqual([
      {
        preset: 's3_minio',
        path: '/minio',
        service: 'minio-ui',
        container_port: 80,
        service_port: 80,
      },
    ]);
    expect(pre.notes.join('\n')).toContain(`MinIO console: ${URL_}/minio/`);
    expect(pre.notes.join('\n')).not.toContain('localhost:9001');
  });

  it('does the same on Kubernetes, the nginx as its own workload', () => {
    const pre = withPublicUrl(resolve('s3_minio', 'kubernetes', {}), URL_, 'kubernetes');
    expect(container(pre, 'minio').env).toEqual(
      expect.arrayContaining([{ name: 'MINIO_BROWSER_REDIRECT_URL', value: `${URL_}/minio/` }]),
    );
    expect(container(pre, 'minio-ui').volumeMounts).toEqual([
      { name: 'files', mountPath: '/etc/nginx/conf.d/default.conf', subPath: 'default.conf' },
    ]);
    const cm = docs(pre).find((d) => (d.metadata as Bag).name === 'minio-ui-files') as {
      data: Record<string, string>;
    };
    conf(cm.data['default.conf'] as string);
    const svc = docs(pre).find(
      (d) => d.kind === 'Service' && (d.metadata as Bag).name === 'minio-ui',
    ) as { metadata: { labels: Bag }; spec: { ports: { port: number }[] } };
    expect(svc.spec.ports.map((p) => p.port)).toEqual([80]);
    // The console's port is forwarded to the nginx, not to the console's own Service.
    expect(svc.metadata.labels['houston.io/ui-port']).toBe('9001');
    const consoleSvc = docs(pre).find(
      (d) => d.kind === 'Service' && (d.metadata as Bag).name === 'minio-console',
    ) as { metadata: { labels: Bag } };
    expect(consoleSvc.metadata.labels['houston.io/ui-port']).toBeUndefined();
    // `minio` is the Service the nginx dials: it must carry the console's port.
    const minio = docs(pre).find(
      (d) => d.kind === 'Service' && (d.metadata as Bag).name === 'minio',
    ) as { spec: { ports: { port: number }[] } };
    expect(minio.spec.ports.map((p) => p.port)).toContain(9001);
  });
});

describe('presigned downloads on an HTTPS workspace', () => {
  it('are said to be blocked as mixed content, at create and in the notes', () => {
    for (const runtime of ['docker', 'kubernetes']) {
      const base =
        runtime === 'docker'
          ? load('s3_minio', { presigned: 'true' })
          : resolve('s3_minio', 'kubernetes', { presigned: 'true' });
      const pre = withPublicUrl(base, URL_, runtime);
      expect(presignedOverHttps(pre)).toBe(PRESIGNED_OVER_HTTPS);
      expect(pre.notes.join(' ')).toContain('mixed content: Chrome rewrites them to https://');
    }
    // The default proxy mode, and a workspace without HTTPS, have nothing to say.
    expect(presignedOverHttps(withPublicUrl(load('s3_minio', {}), URL_, 'docker'))).toBe('');
    expect(presignedOverHttps(load('s3_minio', { presigned: 'true' }))).toBe('');
  });
});

describe('phpLDAPadmin at /phpldapadmin', () => {
  it('is served through its own prefix-stripping nginx on both runtimes, for OpenLDAP and AD', () => {
    // phpLDAPadmin 2 has no server-path setting (1.x's PHPLDAPADMIN_SERVER_PATH is gone): it
    // serves from / and builds its links from X-Forwarded-Prefix, which this nginx sends.
    const conf = (text: string, upstream: number): void => {
      expect(text).toContain(`proxy_pass http://phpldapadmin:${String(upstream)}/;`);
      expect(text).toContain('proxy_set_header X-Forwarded-Prefix /phpldapadmin;');
      expect(text).toContain('location = / { return 302 /phpldapadmin/; }');
    };
    const docker = withPublicUrl(load('ldap', {}), URL_, 'docker');
    // The host port is the nginx's now, so http://localhost:8082 keeps opening it.
    expect(docker.services.phpldapadmin?.ports).toBeUndefined();
    expect(docker.services['ldap-ui']).toMatchObject({
      ports: ['8082:80'],
      depends_on: ['phpldapadmin'],
      volumes: ['./ldap/ldap-ui.conf:/etc/nginx/conf.d/default.conf:ro'],
    });
    // Compose dials the container's own port.
    conf((docker.files.find(([f]) => f === 'ldap/ldap-ui.conf') as [string, string])[1], 8080);
    expect(publicPathsOf(docker.extra)).toEqual([
      {
        preset: 'ldap',
        path: '/phpldapadmin',
        service: 'ldap-ui',
        container_port: 80,
        service_port: 80,
      },
    ]);
    expect(docker.notes.join('\n')).toContain(`phpLDAPadmin: ${URL_}/phpldapadmin/`);

    const ad = withPublicUrl(
      resolve('ldap', 'kubernetes', { directory: 'ad' }),
      URL_,
      'kubernetes',
    );
    // Kubernetes dials the Service, which listens on 80.
    const cm = docs(ad).find((d) => (d.metadata as Bag).name === 'ldap-ui-files') as {
      data: Record<string, string>;
    };
    conf(cm.data['default.conf'] as string, 80);
    const service = (name: string) =>
      docs(ad).find((d) => d.kind === 'Service' && (d.metadata as Bag).name === name) as {
        metadata: { labels: Bag };
      };
    expect(service('ldap-ui').metadata.labels['houston.io/ui-port']).toBe('8082');
    expect(service('phpldapadmin').metadata.labels['houston.io/ui-port']).toBeUndefined();
    expect(publicPathsOf(ad.extra)[0]).toMatchObject({
      service: 'ldap-ui',
      service_port: 80,
      container_port: 80,
    });
  });

  it('sits beside every other UI of a composed workspace', () => {
    const pre = withPublicUrl(
      loadMany(['email', 'ldap', 's3_minio'], { ldap: { idp: 'saml' } }, 'docker'),
      URL_,
      'docker',
    );
    expect(publicPathsOf(pre.extra).map((p) => p.path)).toEqual([
      '/mailpit',
      '/keycloak',
      '/minio',
      '/phpldapadmin',
    ]);
  });
});

describe('a workspace on shifted ports, over HTTPS', () => {
  // A second workspace with these presets publishes other host ports; the nginx fronts, the
  // filters and the note rewrites must follow the ports its preset publishes, not the registry.
  const SHIFTED: config.PortMap = Object.fromEntries(
    Object.entries(config.PRESET_PORTS).map(([name, ports]) => [name, ports.map((p) => p + 100)]),
  );
  const label = (pre: Preset, name: string): unknown =>
    (
      docs(pre).find((d) => d.kind === 'Service' && (d.metadata as Bag).name === name) as
        { metadata: { labels: Bag } } | undefined
    )?.metadata.labels['houston.io/ui-port'];

  it('fronts the MinIO console on its own port, and drops only that mapping (Compose)', () => {
    const pre = withPublicUrl(load('s3_minio', {}, SHIFTED), URL_, 'docker');
    expect(pre.services['minio-ui']?.ports).toEqual(['9101:80']);
    expect(pre.services.minio?.ports).toEqual(['9100:9100']);
    const text = (pre.files.find(([f]) => f === 's3_minio/minio-ui.conf') as [string, string])[1];
    expect(text).toContain('proxy_pass http://minio:9101/;');
    expect(pre.notes.join('\n')).toContain(`MinIO console: ${URL_}/minio/`);
    expect(pre.notes.join('\n')).not.toContain('localhost:9101');
  });

  it('forwards the moved console port to the nginx (Kubernetes)', () => {
    const pre = withPublicUrl(resolve('s3_minio', 'kubernetes', {}, SHIFTED), URL_, 'kubernetes');
    expect(label(pre, 'minio-ui')).toBe('9101');
    expect(label(pre, 'minio-console')).toBeUndefined();
    const cm = docs(pre).find((d) => (d.metadata as Bag).name === 'minio-ui-files') as {
      data: Record<string, string>;
    };
    expect(cm.data['default.conf']).toContain('proxy_pass http://minio:9101/;');
  });

  it('fronts phpLDAPadmin on its own port on both runtimes', () => {
    const docker = withPublicUrl(load('ldap', {}, SHIFTED), URL_, 'docker');
    expect(docker.services['ldap-ui']?.ports).toEqual(['8182:80']);
    expect(docker.services.phpldapadmin?.ports).toBeUndefined();
    expect(docker.notes.join('\n')).not.toContain('localhost:8182');
    const kube = withPublicUrl(resolve('ldap', 'kubernetes', {}, SHIFTED), URL_, 'kubernetes');
    expect(label(kube, 'ldap-ui')).toBe('8182');
    expect(kube.notes.join('\n')).not.toContain('localhost:8182');
  });

  it("rewrites a moved Mailpit's note on both runtimes, and reads 2FA codes from its own port", () => {
    for (const [pre, runtime] of [
      [load('email', {}, SHIFTED), 'docker'],
      [resolve('email', 'kubernetes', {}, SHIFTED), 'kubernetes'],
    ] as const) {
      const out = withPublicUrl(pre, URL_, runtime);
      expect({ runtime, url: out.extra.mailpit_url }).toEqual({
        runtime,
        url: 'http://localhost:8125/mailpit',
      });
      expect({ runtime, stale: out.notes.join('\n').includes('localhost:8125') }).toEqual({
        runtime,
        stale: false,
      });
      expect(out.notes.join('\n')).toContain(`${URL_}/mailpit/`);
    }
  });

  it("sends a moved Keycloak's browser to the path, and keeps houston's fetch on its port", () => {
    const pre = withPublicUrl(load('saml', {}, SHIFTED), URL_, 'docker');
    expect(pre.notes.join('\n')).not.toMatch(/:8181\b/u);
    const cert = pre.postReady.find((a) => a.action === 'saml_idp_cert');
    expect(cert?.descriptor_url).toBe(
      'http://localhost:8181/keycloak/realms/houston/protocol/saml/descriptor',
    );
  });
});

describe('a preset with nothing to serve', () => {
  it('is returned unchanged', () => {
    const plain = load('airgapped', {});
    expect(withPublicUrl(plain, URL_, 'docker')).toBe(plain);
    expect(publicPathsOf({})).toEqual([]);
  });
});
