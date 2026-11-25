/**
 * Shared Keycloak scaffolding for the IdP presets (`saml`, `oidc`, and ldap's `idp`).
 *
 * Both presets run the same Keycloak image with a generated realm import; only the realm's
 * client (SAML vs OIDC) and the published port differ. Bump the Keycloak version here, once.
 */
import { safeDump } from './common';

export const UI_PORT_LABEL = 'houston.io/ui-port';

export const KC_IMAGE = 'quay.io/keycloak/keycloak:26.0';
export const REALM = 'houston';
const DOMAIN = 'example.com';

type Bag = Record<string, unknown>;

/** Must equal Rocket.Chat's SAML issuer. */
export const SAML_CLIENT = 'houston-saml-sp';
export const OIDC_CLIENT_ID = 'rc-oidc';
export const OIDC_CLIENT_SECRET = 'rc-oidc-secret';
/** RC Custom OAuth name -> settings key + /_oauth/keycloak callback. */
export const OIDC_PROVIDER = 'keycloak';

/**
 * Keycloak by its port works only for a browser on the machine running houston: the way in
 * from another computer, HTTPS first and the wide bind second, with what that opens.
 */
export const FROM_ANOTHER_COMPUTER =
  'From another computer, create the workspace with HTTPS on a domain: Keycloak is then at ' +
  '<workspace URL>/keycloak, with no hosts entry. Or re-create with --bind 0.0.0.0 ' +
  '--set idp_host=<server address>, which opens Rocket.Chat and Keycloak, fixed logins ' +
  'and all, to anyone who can reach their ports.';

/** Why the `127.0.0.1  keycloak` hosts entry, and on which machine. */
export const HOSTS_ENTRY_WHY =
  'Add this line to /etc/hosts on the machine running houston (needs sudo) and use a browser ' +
  'there: it is how the browser reaches Keycloak at the address Rocket.Chat uses.';

function samlMapper(name: string, userProperty: string): Bag {
  return {
    name,
    protocol: 'saml',
    protocolMapper: 'saml-user-property-mapper',
    consentRequired: false,
    config: {
      'user.attribute': userProperty,
      'attribute.nameformat': 'Basic',
      'attribute.name': name,
    },
  };
}

/** Rocket.Chat's SAML service provider, as a realm client. */
export function samlClient(): Bag {
  return {
    clientId: SAML_CLIENT,
    protocol: 'saml',
    enabled: true,
    // WHERE KEYCLOAK MAY POST THE ASSERTION BACK: Rocket.Chat's `<Site_Url>/_saml/validate/…`.
    // `http://localhost*` alone refused (400) every workspace whose Site_Url is another name --
    // `--root-url`, a proxy, a tunnel -- on every version; same reasoning as the OIDC client.
    redirectUris: ['http://*', 'https://*'],
    frontchannelLogout: true,
    attributes: {
      'saml.assertion.signature': 'true', // sign the assertion
      'saml.server.signature': 'true', // sign the response
      'saml.client.signature': 'false', // RC doesn't sign its requests
      'saml.force.post.binding': 'true',
      'saml.authnstatement': 'true',
      saml_name_id_format: 'email',
      'saml.signature.algorithm': 'RSA_SHA256',
    },
    protocolMappers: [
      samlMapper('email', 'email'),
      samlMapper('username', 'username'),
      samlMapper('firstName', 'firstName'),
      samlMapper('lastName', 'lastName'),
    ],
  };
}

/** Rocket.Chat's SAML provider settings for the generated Keycloak realm. */
export function samlSettings(samlEp: string): Record<string, string> {
  return {
    OVERWRITE_SETTING_SAML_Custom_Default: 'true',
    OVERWRITE_SETTING_SAML_Custom_Default_provider: 'keycloak',
    OVERWRITE_SETTING_SAML_Custom_Default_entry_point: samlEp,
    // Keycloak serves SSO and SLO from the same endpoint. We logout locally by default,
    // but set this correctly so the config is coherent and real SLO works if
    // logout_behaviour is switched to "SAML".
    OVERWRITE_SETTING_SAML_Custom_Default_idp_slo_redirect_url: samlEp,
    OVERWRITE_SETTING_SAML_Custom_Default_logout_behaviour: 'Local',
    OVERWRITE_SETTING_SAML_Custom_Default_issuer: SAML_CLIENT,
    OVERWRITE_SETTING_SAML_Custom_Default_button_label_text: 'Keycloak SSO',
    OVERWRITE_SETTING_SAML_Custom_Default_default_user_role: 'user',
    OVERWRITE_SETTING_SAML_Custom_Default_name_overwrite: 'false',
    OVERWRITE_SETTING_SAML_Custom_Default_mail_overwrite: 'false',
    OVERWRITE_SETTING_SAML_Custom_Default_user_data_fieldmap:
      '{"username":"username","email":"email","name":"firstName"}',
    OVERWRITE_SETTING_Accounts_TwoFactorAuthentication_By_Email_Enabled: 'false',
  };
}

/** Capitalised: first character upper, the rest lower. */
export function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1).toLowerCase();
}

/** Rocket.Chat's OIDC client, confidential, on Keycloak published at `port`. */
export function oidcClient(idpHost: string, port: number): Bag {
  return {
    clientId: OIDC_CLIENT_ID,
    protocol: 'openid-connect',
    enabled: true,
    publicClient: false, // confidential -> uses the client secret
    secret: OIDC_CLIENT_SECRET, // pinned so RC's config matches on import
    standardFlowEnabled: true, // authorization-code flow
    directAccessGrantsEnabled: true,
    // WHERE KEYCLOAK IS ALLOWED TO SEND THE BROWSER BACK -- which is Rocket.Chat's own
    // callback, `<Site_Url>/_oauth/keycloak`, and therefore has nothing to do with the
    // IdP's hostname. `http://localhost*` covers the ordinary case; the https entry
    // covers a workspace created with `--domain`, whose Site_Url is
    // `https://<name>.<domain>` and which Keycloak refused outright with "Invalid
    // parameter: redirect_uri" because no pattern here matched it.
    redirectUris: [
      'http://localhost*',
      `http://${idpHost}:${String(port)}/*`,
      'http://*',
      'https://*',
    ],
    webOrigins: ['*'],
    // Keycloak's built-in openid/profile/email scopes already emit preferred_username /
    // email / name / sub -- no custom mappers needed.
  };
}

/** The Accounts_OAuth_Custom block that points Rocket.Chat at this Keycloak realm. */
export function oauthSettings(
  realmBase: string,
  setting: string,
): [Record<string, string>, Record<string, unknown>] {
  // A custom OAuth provider's settings do not exist until it is created via the API, so
  // these cannot be OVERWRITE_SETTING env -- houston creates the provider and sets these
  // on `ready` (post_ready). Values are full setting ids.
  const settings: Record<string, unknown> = {
    [setting]: true,
    [`${setting}-url`]: realmBase,
    [`${setting}-authorize_path`]: '/protocol/openid-connect/auth',
    [`${setting}-token_path`]: '/protocol/openid-connect/token',
    [`${setting}-identity_path`]: '/protocol/openid-connect/userinfo',
    [`${setting}-token_sent_via`]: 'header',
    [`${setting}-scope`]: 'openid profile email',
    [`${setting}-id`]: OIDC_CLIENT_ID,
    [`${setting}-secret`]: OIDC_CLIENT_SECRET,
    [`${setting}-login_style`]: 'popup',
    [`${setting}-username_field`]: 'preferred_username',
    [`${setting}-email_field`]: 'email',
    [`${setting}-name_field`]: 'name',
    [`${setting}-merge_users`]: true,
    [`${setting}-show_button`]: true,
    [`${setting}-button_label_text`]: 'Keycloak (OIDC)',
    [`${setting}-button_color`]: '#1d74f5',
    [`${setting}-button_label_color`]: '#FFFFFF',
  };

  const env: Record<string, string> = {
    // This one IS a real existing setting, so OVERWRITE works at boot. No SMTP in the
    // repro -> don't block first login on email-2FA.
    OVERWRITE_SETTING_Accounts_TwoFactorAuthentication_By_Email_Enabled: 'false',
  };
  return [env, settings];
}

/** The Keycloak Deployment: one replica, dev mode, with its realm import mounted. */
function keycloakDeployment(
  containerPort: number,
  env: Bag[],
  labels: Record<string, string>,
): Bag {
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'keycloak', labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: labels.app } },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: 'keycloak',
              image: KC_IMAGE,
              args: ['start-dev', '--import-realm'],
              env,
              ports: [{ containerPort }],
              // WITHOUT THIS the pod is Ready the instant the container starts -- about
              // forty seconds before Keycloak serves HTTP. Everything downstream then
              // waits on a signal that means nothing: the Service gets a "ready"
              // endpoint, the port-forward attaches to a backend that is not listening,
              // and post_ready fetches the IdP descriptor from a port with nothing behind
              // it. The operational audit caught precisely that -- SAML came up with an
              // empty cert and both post_ready actions failed.
              readinessProbe: {
                httpGet: { path: '/realms/master', port: containerPort },
                initialDelaySeconds: 10,
                periodSeconds: 5,
                // Realm import plus an image pull on a cold node; generous because the
                // cost of being wrong is a workspace that looks healthy and is not
                // configured.
                failureThreshold: 60,
              },
              // subPath, so the ConfigMap lands as a FILE next to Keycloak's own import
              // directory rather than replacing the directory.
              volumeMounts: [
                {
                  name: 'realm',
                  mountPath: '/opt/keycloak/data/import/houston-realm.json',
                  subPath: 'houston-realm.json',
                },
              ],
            },
          ],
          volumes: [{ name: 'realm', configMap: { name: 'keycloak-realm' } }],
        },
      },
    },
  };
}

/**
 * The same Keycloak, as native Kubernetes resources.
 *
 * Deliberately NOT a Scenario with two adapters like `ldap`. Keycloak's intent survives
 * the crossing untouched: the realm JSON is byte-identical, the settings Rocket.Chat
 * needs are identical, and the post_ready actions are REST calls that do not care. Only
 * the container's packaging differs, so `saml` and `oidc` carry BOTH renderings on one
 * Preset and each runtime reads the half it understands.
 *
 * THE HOSTNAME TRANSFERS, which is the part worth stating. `keycloak:<port>` has to
 * resolve identically from Rocket.Chat's backend and from the browser, because OIDC uses
 * one URL for the authorize redirect AND the token exchange. On Compose that is the
 * project network plus a `127.0.0.1 keycloak` hosts entry. Here it is a Service literally
 * named `keycloak` plus the same hosts entry, with the port forwarded to the same number.
 */
export function manifests(
  realm: string,
  hostPort: number,
  httpPort?: number,
  { workspace = '__HOUSTON_NAME__' }: { workspace?: string } = {},
): string {
  const containerPort = httpPort !== undefined && httpPort !== 0 ? httpPort : 8080;
  const labels: Record<string, string> = {
    app: 'houston-keycloak',
    'app.kubernetes.io/managed-by': 'houston',
    'houston.io/component': 'keycloak',
    'houston.io/repro': workspace,
    [UI_PORT_LABEL]: String(hostPort),
  };
  const env: Bag[] = [
    { name: 'KC_BOOTSTRAP_ADMIN_USERNAME', value: 'admin' },
    { name: 'KC_BOOTSTRAP_ADMIN_PASSWORD', value: 'admin' },
    // See `service()` for why: without it, anything terminating TLS in front serves an
    // https console that requests http assets, and the browser blocks every one.
    { name: 'KC_PROXY_HEADERS', value: 'xforwarded' },
  ];
  if (httpPort !== undefined && httpPort !== 0) {
    env.push({ name: 'KC_HTTP_PORT', value: String(httpPort) });
  }
  const configMap: Bag = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'keycloak-realm', labels },
    data: { 'houston-realm.json': realm },
  };
  const deployment = keycloakDeployment(containerPort, env, labels);
  const service: Bag = {
    apiVersion: 'v1',
    kind: 'Service',
    // `keycloak`, so RC's pod resolves exactly the hostname the realm and the settings
    // already name.
    metadata: { name: 'keycloak', labels },
    spec: {
      selector: { app: labels.app },
      ports: [{ name: 'http', port: hostPort, targetPort: containerPort }],
    },
  };
  return [configMap, deployment, service].map((doc) => safeDump(doc)).join('---\n');
}

/**
 * The Keycloak compose service.
 *
 * `httpPort` makes Keycloak listen on that port INSIDE the container too (KC_HTTP_PORT)
 * -- the oidc preset needs the same port inside and out so one `keycloak:<port>` URL works
 * from both the browser and RC's backend. Without it, Keycloak listens on its default
 * 8080.
 */
export function service(realmMount: string, hostPort: number, httpPort?: number): Bag {
  const env: Record<string, string> = {
    // Believe X-Forwarded-Proto/-Host, so the URLs Keycloak GENERATES match the scheme
    // and host the browser actually used.
    //
    // Keycloak builds absolute URLs for its own assets, its issuer and every OIDC
    // endpoint. Without this it derives them from the connection it can see -- plain http
    // on a published port -- so reaching the admin console through anything that
    // terminates TLS in front (an iximiuz lab forward, Codespaces, ngrok, a corporate
    // proxy) serves an https PAGE that asks for http RESOURCES, and the browser blocks
    // every one of them:
    //
    //   Mixed Content: The page at 'https://<host>/admin/master/console/' was loaded over
    //   HTTPS, but requested an insecure resource
    //   'http://<host>/resources/master/admin/en'. This request has been blocked.
    //
    // The console renders blank or half-dead, and nothing in the container log says why
    // -- the failure is entirely in the browser.
    //
    // Measured against quay.io/keycloak/keycloak:26.0, one request carrying
    // `X-Forwarded-Proto: https, X-Forwarded-Host: lab.example.com`:
    //
    //   without : issuer http://127.0.0.1:18085/realms/master
    //   with    : issuer https://lab.example.com/realms/master
    //
    // With no proxy in front there are no such headers and nothing changes -- also
    // measured, because a fix that alters the ordinary laptop case would be trading one
    // bug for another.
    //
    // KC_PROXY_HEADERS, not the old KC_PROXY: `proxy` was deprecated in 24 and REMOVED in
    // 26, which is the version above.
    KC_PROXY_HEADERS: 'xforwarded',
  };
  let containerPort = 8080;
  if (httpPort !== undefined && httpPort !== 0) {
    env.KC_HTTP_PORT = String(httpPort);
    containerPort = httpPort;
  }
  return {
    image: KC_IMAGE,
    command: ['start-dev', '--import-realm'],
    environment: {
      KC_BOOTSTRAP_ADMIN_USERNAME: 'admin',
      KC_BOOTSTRAP_ADMIN_PASSWORD: 'admin',
      ...env,
    },
    volumes: [`${realmMount}:/opt/keycloak/data/import/houston-realm.json:ro`],
    ports: [`${String(hostPort)}:${String(containerPort)}`],
    restart: 'unless-stopped',
  };
}

/**
 * Test users user1..userN, password = username, verified emails. `prefix` names them apart
 * from another store's users (`sso-user1`, `sso-user1@example.com`) when a directory is
 * composed in: SAML merges into an existing account by EMAIL, so the address must differ too.
 */
export function users(count: number, prefix = ''): Bag[] {
  const out: Bag[] = [];
  for (let i = 1; i <= count; i += 1) {
    const name = `${prefix}user${String(i)}`;
    out.push({
      username: name,
      enabled: true,
      emailVerified: true,
      email: `${name}@${DOMAIN}`,
      firstName: 'User',
      lastName: String(i),
      credentials: [{ type: 'password', value: name, temporary: false }],
    });
  }
  return out;
}

/** The internal param the composer passes saml and oidc; documented in no `paramsHelp`. */
export const USER_PREFIX_PARAM = 'sso_user_prefix';

/**
 * A minimal realm export: just our client(s) + test users.
 *
 * Keycloak regenerates all default clients, flows and scopes on import anyway. This is the
 * realm as JSON indented by two, in the established spelling, which
 * `JSON.stringify(value, null, 2)` matches byte for byte on ASCII -- and everything in here
 * is ASCII by construction.
 */
export function realmJson(clients: Bag[], userCount: number, prefix = '', extra: Bag = {}): string {
  return JSON.stringify(
    {
      realm: REALM,
      enabled: true,
      sslRequired: 'none', // allow HTTP (reached via docker port-forward)
      clients,
      users: users(userCount, prefix),
      // A directory's federation and required actions (ldap's `idp`); nothing otherwise.
      ...extra,
    },
    null,
    2,
  );
}
