/**
 * A preset's own web UIs at paths of the workspace's HTTPS name, as Grafana is at /grafana:
 * Mailpit at /mailpit, Keycloak at /keycloak, the livechat demo page at /livechat-demo, the
 * MinIO console at /minio and phpLDAPadmin at /phpldapadmin.
 *
 * Applied by the create once the public URL is known (it is not when presets are loaded),
 * the way `withCertificate` is. Pure: it rewrites the preset for either runtime and records
 * what to route in `extra.public_paths`; the edge (Compose) and an Ingress (Kubernetes) do
 * the routing.
 *
 * Each UI serves from its path itself where it can -- Mailpit's web root, Keycloak's relative
 * path, the demo page copied under its path -- so no edge or Ingress rewrites a prefix, which
 * ingress controllers each do their own way. The MinIO console and phpLDAPadmin 2 have no
 * such setting (they expect the prefix stripped), so a small nginx of each one's own,
 * `minio-ui` and `ldap-ui`, strips it on both runtimes. `/livechat` is not
 * available: Rocket.Chat serves its own widget there on the same host.
 */
import { withoutLocalSetup } from './guides';
import { k8sManifests, safeDump, safeLoadAll } from './common';
import { type Preset } from './types';

type Bag = Record<string, unknown>;

/** One UI routed under the workspace's name. */
export interface PublicPath {
  readonly preset: string;
  readonly path: string;
  /** The Compose service, and the Kubernetes Service, it is reached at. */
  readonly service: string;
  /** What the container listens on (Compose routes to the container). */
  readonly container_port: number;
  /** What its Kubernetes Service exposes (the Ingress routes to the Service). */
  readonly service_port: number;
}

export const MAILPIT_PATH = '/mailpit';
export const KEYCLOAK_PATH = '/keycloak';
export const DEMO_PATH = '/livechat-demo';
export const MINIO_PATH = '/minio';
export const LDAPADMIN_PATH = '/phpldapadmin';
const NGINX_ROOT = '/usr/share/nginx/html';
const NGINX_IMAGE = 'docker.io/nginx:alpine';
const MINIO_UI = 'minio-ui';
const UI_PORT_LABEL = 'houston.io/ui-port';

/**
 * Presigned downloads are links to MinIO's own http:// port, and an https page may not load
 * them: measured on a live domain, Chrome requested `https://minio:9000/...` for the image
 * and it failed. Said at create and in the notes.
 */
export const PRESIGNED_OVER_HTTPS =
  'presigned mode over HTTPS: the download links are http:// to MinIO on an https page, ' +
  'which browsers treat as mixed content: Chrome rewrites them to https://, which MinIO ' +
  'does not serve, so previews and downloads break, as on a customer site with an http S3 ' +
  'endpoint. The default proxy mode works over HTTPS.';

/**
 * The MinIO console under /minio/, its own root on the far side. Its page names /minio/ as
 * its base (MINIO_BROWSER_REDIRECT_URL), so every request the browser makes comes back here.
 * `minio` reaches the console on both runtimes: the Compose service, and on Kubernetes the
 * primary Service, which carries every port the workload listens on.
 *
 * ponytail: nginx resolves `minio` once, at start. A Compose `minio` restarted alone with a
 * new address answers 502 here until `minio-ui` restarts too; no houston command does that
 * (re-`up` downs everything first, `start` starts minio first). A Kubernetes Service keeps
 * its address while it exists, and `down` keeps the presets' Services for that reason.
 */
function minioUiConf(consolePort: number): string {
  return `server {
  listen 80;
  absolute_redirect off;
  location = / { return 302 ${MINIO_PATH}/; }
  location = ${MINIO_PATH} { return 301 ${MINIO_PATH}/; }
  location ${MINIO_PATH}/ {
    proxy_pass http://minio:${String(consolePort)}/;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    chunked_transfer_encoding off;
    client_max_body_size 0;
    proxy_buffering off;
  }
}
`;
}

/**
 * Short on purpose: the edge reaches it as `houston-<name>-ldap-ui-1`, a DNS label, and
 * `phpldapadmin-ui` would have been the longest container it routes to (`naming.DERIVED_MAX`).
 */
const LDAPADMIN_UI = 'ldap-ui';

/**
 * phpLDAPadmin 2 has no server-path setting (1.x's PHPLDAPADMIN_SERVER_PATH is gone): it serves
 * from / and builds every link from `X-Forwarded-Prefix`, which it believes from the private
 * ranges its image trusts by default (APP_TRUST_PROXIES: 10/8, 127/8, 172.16/12, 192.168/16 --
 * a Docker or Podman network, a k3s or EKS-default pod). So this strips the prefix and names
 * it, as the maintainer's own configuration does (leenooks/phpLDAPadmin#435).
 *
 * ponytail: nginx resolves `phpldapadmin` once, at start, as `minio-ui` does `minio`; a pod
 * network outside those ranges would need APP_TRUST_PROXIES set on phpLDAPadmin too.
 */
function ldapadminUiConf(upstreamPort: number): string {
  return `server {
  listen 80;
  absolute_redirect off;
  location = / { return 302 ${LDAPADMIN_PATH}/; }
  location = ${LDAPADMIN_PATH} { return 301 ${LDAPADMIN_PATH}/; }
  location ${LDAPADMIN_PATH}/ {
    proxy_pass http://phpldapadmin:${String(upstreamPort)}/;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;
    proxy_set_header X-Forwarded-Port $http_x_forwarded_port;
    proxy_set_header X-Forwarded-Prefix ${LDAPADMIN_PATH};
  }
}
`;
}

const bag = (value: unknown): Bag =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Bag) : {};

/** The Kubernetes manifests as documents, to edit and dump back. */
function docsOf(pre: Preset): Bag[][] {
  return pre.kubernetesManifests.map((manifest) => safeLoadAll(manifest).map(bag));
}
const dumpAll = (docs: Bag[][]): string[] =>
  docs.map((one) => one.map((doc) => safeDump(doc)).join('---\n'));
const find = (docs: Bag[][], kind: string, name: string): Bag | undefined =>
  docs.flat().find((doc) => doc.kind === kind && bag(doc.metadata).name === name);
function containerOf(deployment: Bag): Bag {
  const spec = bag(bag(bag(deployment.spec).template).spec);
  return bag((spec.containers as unknown[])[0]);
}
function addEnv(container: Bag, env: Record<string, string>): void {
  const list = Array.isArray(container.env) ? (container.env as Bag[]) : [];
  for (const [name, value] of Object.entries(env)) {
    const at = list.findIndex((entry) => entry.name === name);
    if (at >= 0) list[at] = { name, value };
    else list.push({ name, value });
  }
  container.env = list;
}
function probePath(container: Bag, path: string): void {
  const get = bag(bag(container.readinessProbe).httpGet);
  if (typeof get.path === 'string') get.path = path;
}

/** What the workspace would reach `service` at: its container port and its Service port. */
function ports(pre: Preset, service: string, docs: Bag[][], fallback: number): [number, number] {
  const compose = bag(pre.services[service]);
  const mapping = Array.isArray(compose.ports) ? String(compose.ports[0] ?? '') : '';
  const [published = '', inside = ''] = mapping.split(':').slice(-2);
  const svc = find(docs, 'Service', service);
  const first = svc === undefined ? undefined : bag((bag(svc.spec).ports as unknown[])[0]);
  const container = Number(inside) || Number(first?.targetPort) || fallback;
  const exposed = Number(first?.port) || Number(published) || fallback;
  return [container, exposed];
}

/**
 * The HOST port a side UI is published on in this workspace: its `houston.io/ui-port` label on
 * Kubernetes (read before this module moves the label), the host side of its mapping on
 * Compose. Read off the preset, never the registry, so it is whatever port the builder was
 * given. 0 when the preset publishes none there.
 */
function hostPortOf(
  pre: Preset,
  docs: Bag[][],
  kube: boolean,
  service: string,
  { k8sService = service, index = 0 }: { k8sService?: string; index?: number } = {},
): number {
  if (kube) {
    const svc = find(docs, 'Service', k8sService);
    return Number(bag(bag(svc?.metadata).labels)[UI_PORT_LABEL]) || 0;
  }
  const mappings = bag(pre.services[service]).ports;
  const mapping = Array.isArray(mappings) ? String(mappings[index] ?? '') : '';
  return Number(mapping.split(':').slice(-2)[0]) || 0;
}

function addRedirects(realm: string, publicUrl: string): string {
  const parsed = JSON.parse(realm) as { clients?: Bag[] };
  for (const client of parsed.clients ?? []) {
    const uris = Array.isArray(client.redirectUris) ? (client.redirectUris as string[]) : [];
    if (!uris.includes(`${publicUrl}/*`)) client.redirectUris = [...uris, `${publicUrl}/*`];
  }
  return JSON.stringify(parsed, null, 2);
}

/**
 * The notes that send a browser to Keycloak by its port or a hosts entry, as runs of lines:
 * how each run starts, and its length. Runs, not patterns: a composed workspace's notes are
 * merged, and s3_minio's presigned-mode hosts entry is worded line for line like oidc's.
 */
const KEYCLOAK_HOST_NOTES: readonly (readonly [string, number])[] = [
  ['OIDC needs one host entry', 5],
  ["  It is 'localhost', so the browser must be on the machine running houston", 3],
  // ldap's SSO notes: the sentence, then the entry to paste on its own line.
  ['A browser on the machine running houston needs a hosts entry for Keycloak', 2],
  ['From another computer, create the workspace with HTTPS on a domain', 1],
];

function dropRuns(notes: readonly string[], runs: typeof KEYCLOAK_HOST_NOTES): string[] {
  const out = [...notes];
  for (const [start, length] of runs) {
    const at = out.findIndex((note) => note.startsWith(start));
    if (at >= 0) out.splice(at, length);
  }
  return out;
}

/** Notes with one address replaced by another, wherever it appears. */
function rewrite(notes: readonly string[], from: string, to: string): string[] {
  return notes.map((note) => note.split(from).join(to));
}

/** The preset, with its UIs served under `publicUrl` on `runtime`. */
export function withPublicUrl(pre: Preset, publicUrl: string, runtime: string): Preset {
  const base = publicUrl.replace(/\/+$/u, '');
  const kube = runtime === 'kubernetes';
  const out: Preset = {
    ...pre,
    env: { ...pre.env },
    services: JSON.parse(JSON.stringify(pre.services)) as Preset['services'],
    files: [...pre.files],
    notes: [...pre.notes],
    guides: withoutLocalSetup(pre.guides),
    postReady: pre.postReady.map((action) => JSON.parse(JSON.stringify(action)) as typeof action),
    extra: { ...pre.extra },
  };
  const docs = docsOf(pre);
  const has = (name: string): boolean =>
    kube ? find(docs, 'Deployment', name) !== undefined : name in out.services;
  const paths: PublicPath[] = [];

  if (has('mailpit')) {
    const [container, exposed] = ports(pre, 'mailpit', docs, 8025);
    paths.push({
      preset: 'email',
      path: MAILPIT_PATH,
      service: 'mailpit',
      container_port: container,
      service_port: exposed,
    });
    if (kube) {
      const c = containerOf(find(docs, 'Deployment', 'mailpit') as Bag);
      addEnv(c, { MP_WEBROOT: MAILPIT_PATH });
      probePath(c, `${MAILPIT_PATH}/`);
    } else {
      const svc = bag(out.services.mailpit);
      svc.environment = { ...bag(svc.environment), MP_WEBROOT: MAILPIT_PATH };
    }
    // houston reads 2FA codes from Mailpit's API, which now lives under the path too.
    const local = typeof out.extra.mailpit_url === 'string' ? out.extra.mailpit_url : '';
    if (local) out.extra.mailpit_url = `${local.replace(/\/+$/u, '')}${MAILPIT_PATH}`;
    // Its own port answers only under the path now: say the address that works anywhere.
    // The HOST port, which the notes name: on Kubernetes `exposed` is the Service's.
    out.notes = rewrite(
      out.notes,
      `http://localhost:${String(hostPortOf(pre, docs, kube, 'mailpit'))}`,
      `${base}${MAILPIT_PATH}/`,
    );
  }

  if (has('widget-site')) {
    const [container, exposed] = ports(pre, 'widget-site', docs, 80);
    paths.push({
      preset: 'livechat',
      path: DEMO_PATH,
      service: 'widget-site',
      container_port: container,
      service_port: exposed,
    });
    const target = `${NGINX_ROOT}${DEMO_PATH}/index.html`;
    // Keep the separate-port fixture intact; its cross-origin guidance is still true.
    const originalPage = out.files.find(([name]) => name === 'livechat/index.html')?.[1];
    const publicPage = originalPage?.replace(
      /(<div class="demo">)[\s\S]*?(<\/div>)/u,
      "$1houston Livechat demo — this storefront shares Rocket.Chat's HTTPS origin. " +
        "Start a chat here, answer it in Rocket.Chat's Omnichannel area. " +
        'Use the separate demo port to test cross-origin CORS and framing.$2',
    );
    if (publicPage !== undefined) out.files.push(['livechat/public.html', publicPage]);
    if (kube) {
      const c = containerOf(find(docs, 'Deployment', 'widget-site') as Bag);
      const mounts = Array.isArray(c.volumeMounts) ? (c.volumeMounts as Bag[]) : [];
      const page = mounts.find((m) => m.subPath === 'index.html');
      const files = find(docs, 'ConfigMap', 'widget-site-files');
      if (publicPage !== undefined && files !== undefined)
        files.data = { ...bag(files.data), 'public.html': publicPage };
      if (page !== undefined)
        c.volumeMounts = [
          ...mounts,
          {
            ...page,
            mountPath: target,
            subPath: publicPage === undefined ? 'index.html' : 'public.html',
          },
        ];
    } else {
      const svc = bag(out.services['widget-site']);
      const volumes = Array.isArray(svc.volumes) ? (svc.volumes as string[]) : [];
      const page = volumes.find((v) => v.includes(`${NGINX_ROOT}/index.html`));
      if (page !== undefined)
        svc.volumes = [
          ...volumes,
          publicPage === undefined
            ? page.replace(`${NGINX_ROOT}/index.html`, target)
            : `./livechat/public.html:${target}:ro`,
        ];
    }
    out.notes.push(
      `Demo page over HTTPS: ${base}${DEMO_PATH}/  (the same origin as Rocket.Chat, so CORS and framing problems will not show there; the port above does)`,
    );
  }

  if (has('keycloak')) {
    const [container, exposed] = ports(pre, 'keycloak', docs, 8080);
    const published = hostPortOf(pre, docs, kube, 'keycloak');
    paths.push({
      preset: 'keycloak',
      path: KEYCLOAK_PATH,
      service: 'keycloak',
      container_port: container,
      service_port: exposed,
    });
    // The browser gets the public URL; houston and Rocket.Chat's server keep reaching it
    // directly, which the dynamic back channel lets Keycloak answer.
    const kc = {
      KC_HTTP_RELATIVE_PATH: KEYCLOAK_PATH,
      KC_HOSTNAME: `${base}${KEYCLOAK_PATH}`,
      KC_HOSTNAME_BACKCHANNEL_DYNAMIC: 'true',
    };
    const realmBase = `${base}${KEYCLOAK_PATH}/realms`;
    if (kube) {
      const c = containerOf(find(docs, 'Deployment', 'keycloak') as Bag);
      addEnv(c, kc);
      probePath(c, `${KEYCLOAK_PATH}/realms/master`);
      const cm = find(docs, 'ConfigMap', 'keycloak-realm');
      const data = bag(cm?.data);
      if (typeof data['houston-realm.json'] === 'string') {
        data['houston-realm.json'] = addRedirects(data['houston-realm.json'], base);
      }
    } else {
      const svc = bag(out.services.keycloak);
      svc.environment = { ...bag(svc.environment), ...kc };
      out.files = out.files.map(([file, text]) =>
        file.endsWith('keycloak-realm.json') ? [file, addRedirects(text, base)] : [file, text],
      );
    }
    // SAML: the entry point is where the BROWSER is sent.
    for (const key of [
      'OVERWRITE_SETTING_SAML_Custom_Default_entry_point',
      'OVERWRITE_SETTING_SAML_Custom_Default_idp_slo_redirect_url',
    ]) {
      if (key in out.env) out.env[key] = `${realmBase}/houston/protocol/saml`;
    }
    for (const action of out.postReady) {
      if (action.action === 'saml_idp_cert' && typeof action.descriptor_url === 'string') {
        action.descriptor_url = action.descriptor_url.replace(
          '/realms/',
          `${KEYCLOAK_PATH}/realms/`,
        );
      }
      if (action.action === 'keycloak_master_ssl_off') action.path = KEYCLOAK_PATH;
      // OIDC: the browser authorizes at the public URL; Rocket.Chat's server exchanges the
      // code and reads the user from Keycloak directly (absolute token and identity paths).
      if (action.action === 'create_oauth_provider') {
        const settings = bag(action.settings);
        const backchannel = `http://keycloak:${String(container)}${KEYCLOAK_PATH}/realms/houston`;
        for (const key of Object.keys(settings)) {
          if (key.endsWith('-url')) settings[key] = `${realmBase}/houston`;
          if (key.endsWith('-token_path'))
            settings[key] = `${backchannel}/protocol/openid-connect/token`;
          if (key.endsWith('-identity_path'))
            settings[key] = `${backchannel}/protocol/openid-connect/userinfo`;
        }
      }
    }
    // The hosts entry and `idp_host` were for a browser reaching Keycloak by port.
    out.notes = dropRuns(out.notes, KEYCLOAK_HOST_NOTES);
    // And the card's: a line sending the browser to Keycloak's port becomes the path.
    const byPort = new RegExp(`http://[A-Za-z0-9.-]+:${String(published)}`, 'u');
    out.guides = out.guides.map((one) =>
      one.signIn.some(([, , where]) => where.startsWith('Keycloak'))
        ? {
            ...one,
            know: [
              `Keycloak is at ${base}${KEYCLOAK_PATH}, on the workspace's own address: any browser that opens Rocket.Chat reaches it.`,
              ...one.know.filter((line) => !byPort.test(line)),
            ],
          }
        : one,
    );
    // Every address the notes give for Keycloak (its port, under any idp_host) is the path now.
    out.notes = out.notes.map((note) =>
      note.replace(
        new RegExp(`http://[A-Za-z0-9.-]+:${String(published)}`, 'gu'),
        `${base}${KEYCLOAK_PATH}`,
      ),
    );
  }

  if (has('minio')) {
    // The console listens on its host port (`s3-minio.ts`: same inside and out), so the one
    // number is both what the nginx proxies to and what it takes over on the host.
    const consolePort = hostPortOf(pre, docs, kube, 'minio', {
      k8sService: 'minio-console',
      index: 1,
    });
    paths.push({
      preset: 's3_minio',
      path: MINIO_PATH,
      service: MINIO_UI,
      container_port: 80,
      service_port: 80,
    });
    const redirect = { MINIO_BROWSER_REDIRECT_URL: `${base}${MINIO_PATH}/` };
    if (kube) {
      addEnv(containerOf(find(docs, 'Deployment', 'minio') as Bag), redirect);
      // The console port forwards to the nginx now, which sends / to /minio/: the console's
      // own Service would serve a page whose base it no longer answers.
      const consoleService = find(docs, 'Service', 'minio-console');
      if (consoleService !== undefined)
        delete bag(bag(consoleService.metadata).labels)[UI_PORT_LABEL];
      docs.push(
        safeLoadAll(
          k8sManifests({
            name: MINIO_UI,
            image: NGINX_IMAGE,
            ports: [[consolePort, 80]],
            ui: { [MINIO_UI]: [consolePort, 80] },
            files: { 'default.conf': minioUiConf(consolePort) },
            mounts: [
              {
                name: 'files',
                mountPath: '/etc/nginx/conf.d/default.conf',
                subPath: 'default.conf',
              },
            ],
          }),
        ).map(bag),
      );
    } else {
      const svc = bag(out.services.minio);
      svc.environment = { ...bag(svc.environment), ...redirect };
      // The console's port is the nginx's now, which sends / to /minio/, so
      // http://localhost:<console port> keeps opening the console.
      const published = `${String(consolePort)}:${String(consolePort)}`;
      if (Array.isArray(svc.ports))
        svc.ports = (svc.ports as string[]).filter((p) => p !== published);
      out.services[MINIO_UI] = {
        image: NGINX_IMAGE,
        volumes: [`./s3_minio/${MINIO_UI}.conf:/etc/nginx/conf.d/default.conf:ro`],
        ports: [`${String(consolePort)}:80`],
        depends_on: ['minio'],
        restart: 'unless-stopped',
      };
      out.files = [...out.files, [`s3_minio/${MINIO_UI}.conf`, minioUiConf(consolePort)]];
    }
    // The address that works from anywhere, not only on this machine.
    out.notes = rewrite(
      out.notes,
      `http://localhost:${String(consolePort)}`,
      `${base}${MINIO_PATH}/`,
    );
    if (presignedOf(out)) out.notes.push(`Note: ${PRESIGNED_OVER_HTTPS}`);
  }

  if (has('phpldapadmin')) {
    // Compose reaches the container's own port; Kubernetes reaches the Service's.
    const [container, exposed] = ports(pre, 'phpldapadmin', docs, 8080);
    const conf = ldapadminUiConf(kube ? exposed : container);
    paths.push({
      preset: 'ldap',
      path: LDAPADMIN_PATH,
      service: LDAPADMIN_UI,
      container_port: 80,
      service_port: 80,
    });
    const port = hostPortOf(pre, docs, kube, 'phpldapadmin');
    if (kube) {
      // The host port forwards to the nginx now, which sends / to /phpldapadmin/.
      const uiService = find(docs, 'Service', 'phpldapadmin');
      if (uiService !== undefined) delete bag(bag(uiService.metadata).labels)[UI_PORT_LABEL];
      docs.push(
        safeLoadAll(
          k8sManifests({
            name: LDAPADMIN_UI,
            image: NGINX_IMAGE,
            ports: [[port, 80]],
            ui: { [LDAPADMIN_UI]: [port, 80] },
            files: { 'default.conf': conf },
            mounts: [
              {
                name: 'files',
                mountPath: '/etc/nginx/conf.d/default.conf',
                subPath: 'default.conf',
              },
            ],
          }),
        ).map(bag),
      );
    } else {
      // Its port is the nginx's now, so http://localhost:<port> keeps opening it.
      const svc = bag(out.services.phpldapadmin);
      delete svc.ports;
      out.services[LDAPADMIN_UI] = {
        image: NGINX_IMAGE,
        volumes: [`./ldap/${LDAPADMIN_UI}.conf:/etc/nginx/conf.d/default.conf:ro`],
        ports: [`${String(port)}:80`],
        depends_on: ['phpldapadmin'],
        restart: 'unless-stopped',
      };
      out.files = [...out.files, [`ldap/${LDAPADMIN_UI}.conf`, conf]];
    }
    out.notes = rewrite(out.notes, `http://localhost:${String(port)}`, `${base}${LDAPADMIN_PATH}/`);
  }

  if (paths.length === 0) return pre;
  if (kube) out.kubernetesManifests = dumpAll(docs);
  out.extra.public_paths = paths;
  return out;
}

/** Whether `pre` serves downloads as presigned MinIO links (s3_minio `presigned=true`). */
function presignedOf(pre: Preset): boolean {
  return pre.env.OVERWRITE_SETTING_FileUpload_S3_Proxy_Uploads === 'false';
}

/** The create's warning for presigned links on an https workspace, or ''. */
export function presignedOverHttps(pre: Preset): string {
  return publicPathsOf(pre.extra).some((p) => p.service === MINIO_UI) && presignedOf(pre)
    ? PRESIGNED_OVER_HTTPS
    : '';
}

/** The paths a workspace recorded, for the edge or an Ingress; [] for anything else. */
export function publicPathsOf(extra: Record<string, unknown>): PublicPath[] {
  const raw = extra.public_paths;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is PublicPath =>
      typeof bag(p).path === 'string' &&
      typeof bag(p).service === 'string' &&
      Number.isInteger(bag(p).container_port),
  );
}
