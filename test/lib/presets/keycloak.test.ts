import * as fs from 'node:fs';
import * as path from 'node:path';

import { safeLoadAll } from '../../../src/lib/presets/common';
import {
  KC_IMAGE,
  REALM,
  manifests,
  realmJson,
  samlClient,
  service,
  users,
} from '../../../src/lib/presets/keycloak';

/**
 * What earlier releases generated for the same inputs, recorded: the realm file's text, the
 * compose service without and with an inside port, and the Kubernetes documents without and
 * with one, as parsed.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'lib', 'presets', 'keycloak.json'),
    'utf8',
  ),
) as { realm_json: string; service: unknown[]; manifests: unknown[] };

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

const CLIENT = { clientId: 'houston-saml-sp', protocol: 'saml', enabled: true };

describe('the generated realm', () => {
  it('is byte-identical to earlier releases, because it is written to disk', () => {
    // This string becomes `saml/keycloak-realm.json` in the workspace and is mounted into
    // Keycloak. Earlier releases' two-space JSON and `JSON.stringify(..., null, 2)` agree on
    // ASCII, and everything in a generated realm is ASCII by construction.
    expect(realmJson([CLIENT], 3)).toBe(RECORDED.realm_json);
  });

  it('gives every test user a password equal to its own name', () => {
    // The whole point of the preset is that a reader can log in as user1/user1 without
    // being handed credentials; a generated password would need a second place to print.
    const made = users(3);
    expect(made).toHaveLength(3);
    for (let i = 0; i < 3; i += 1) {
      const u = made[i] as Record<string, unknown>;
      expect(u.username).toBe(`user${String(i + 1)}`);
      expect(u.email).toBe(`user${String(i + 1)}@example.com`);
      expect(u.emailVerified).toBe(true);
      expect((u.credentials as Record<string, unknown>[])[0]?.value).toBe(`user${String(i + 1)}`);
      expect((u.credentials as Record<string, unknown>[])[0]?.temporary).toBe(false);
    }
    expect(users(0)).toEqual([]);
  });

  it('allows plain HTTP, because the IdP is reached through a published port', () => {
    expect(JSON.parse(realmJson([], 0)).sslRequired).toBe('none');
    expect(JSON.parse(realmJson([], 0)).realm).toBe(REALM);
  });
});

describe("Rocket.Chat's SAML client", () => {
  it('lets Keycloak post the assertion back to a Site_Url that is not localhost', () => {
    // Keycloak checks the AuthnRequest's `<Site_Url>/_saml/validate/…` against these, and
    // `http://localhost*` alone answered 400 to every `--root-url`, proxy and tunnel: measured
    // on 8.9.1 and 9.0.0 at http://rc-c.kestron.org.
    const uris = samlClient().redirectUris as string[];
    expect(uris).toEqual(expect.arrayContaining(['http://*', 'https://*']));
  });
});

describe('the compose service', () => {
  it('matches earlier releases with and without an inside port', () => {
    for (const [at, [mount, host, inside]] of (
      [
        ['./saml/keycloak-realm.json', 8081, null],
        ['./oidc/keycloak-realm.json', 8085, 8085],
      ] as const
    ).entries()) {
      expect(service(mount, host, inside ?? undefined)).toEqual(RECORDED.service[at]);
    }
  });

  it('publishes the SAME port inside and out only when asked to', () => {
    // OIDC needs one `keycloak:8085` URL that works from the browser AND from RC's
    // backend, which means Keycloak has to LISTEN on 8085 rather than on its default.
    expect(service('./x.json', 8085, 8085).ports).toEqual(['8085:8085']);
    expect(service('./x.json', 8081).ports).toEqual(['8081:8080']);
    const env = service('./x.json', 8081).environment as Record<string, string>;
    expect(env.KC_HTTP_PORT).toBeUndefined();
    // Believe X-Forwarded-*, or an admin console reached through anything terminating TLS
    // serves an https page that requests http assets and the browser blocks every one.
    expect(env.KC_PROXY_HEADERS).toBe('xforwarded');
  });
});

describe('the Kubernetes rendering', () => {
  it('renders the documents earlier releases render', () => {
    const realm = realmJson([CLIENT], 2);
    for (const [at, inside] of [undefined, 8085].entries()) {
      expect(safeLoadAll(manifests(realm, 8085, inside))).toEqual(RECORDED.manifests[at]);
    }
  });

  it('will not call the pod Ready before Keycloak serves HTTP', () => {
    // Without the probe the pod is Ready the instant the container starts -- about forty
    // seconds early. The operational audit caught the consequence: SAML came up with an
    // empty cert because post_ready fetched the descriptor from a port with nothing
    // behind it, and both post_ready actions failed.
    const deployment = byKind(manifests(realmJson([], 1), 8081), 'Deployment');
    const container = dig(deployment, 'spec', 'template', 'spec', 'containers', 0);
    expect(dig(container, 'readinessProbe', 'httpGet', 'path')).toBe('/realms/master');
    expect(dig(container, 'readinessProbe', 'failureThreshold')).toBe(60);
    expect(dig(container, 'image')).toBe(KC_IMAGE);
  });

  it('names the Service `keycloak`, because the realm and the settings already do', () => {
    const svc = byKind(manifests(realmJson([], 1), 8081), 'Service');
    expect(dig(svc, 'metadata', 'name')).toBe('keycloak');
    expect(dig(svc, 'metadata', 'labels', 'houston.io/ui-port')).toBe('8081');
    expect(dig(svc, 'spec', 'ports', 0)).toEqual({ name: 'http', port: 8081, targetPort: 8080 });
  });
});

describe('the scaffolding both IdP presets share', () => {
  it('builds users, both port shapes and the realm earlier releases name', () => {
    expect(users(2).map((u) => u.username)).toEqual(['user1', 'user2']);
    // saml: publish the host port onto Keycloak's default 8080.
    const saml = service('./x/realm.json', 8081);
    expect(saml.ports).toEqual(['8081:8080']);
    expect(saml.environment as Record<string, string>).not.toHaveProperty('KC_HTTP_PORT');
    // oidc: the same port inside and out, for one keycloak:<port> URL.
    const oidc = service('./x/realm.json', 8085, 8085);
    expect(oidc.ports).toEqual(['8085:8085']);
    expect((oidc.environment as Record<string, string>).KC_HTTP_PORT).toBe('8085');
    const realm = JSON.parse(realmJson([{ clientId: 'c' }], 2)) as {
      realm: string;
      users: unknown[];
    };
    expect([realm.realm, realm.users.length]).toEqual(['houston', 2]);
  });

  it('believes a proxy’s forwarded scheme in both shapes, with the Keycloak 26 spelling', () => {
    // Reached through anything terminating TLS, Keycloak otherwise serves an https page
    // that asks for http resources and the browser blocks all of them -- a blank console
    // and a silent container log. KC_PROXY was removed in 26, which is the pinned version.
    for (const inside of [undefined, 8085]) {
      const env = service('./x/realm.json', 8081, inside).environment as Record<string, string>;
      expect(env.KC_PROXY_HEADERS).toBe('xforwarded');
      expect(env).not.toHaveProperty('KC_PROXY');
    }
    expect(KC_IMAGE.startsWith('quay.io/keycloak/keycloak:26')).toBe(true);
  });
});
