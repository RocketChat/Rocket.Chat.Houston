/**
 * Build a docker-compose document for one repro.
 *
 * Built as a plain object (then dumped to YAML) rather than a fixed template, so presets can
 * deep-merge extra services / env / RC patches into it.
 *
 * **THIS MODULE IS PURE, and it sits below the service layer on purpose.** `docker compose
 * config` is an external check this code does not control: this module's document for
 * every preset x version x bind x instances combination was normalised under it and found
 * to be the same document as the one earlier releases generated.
 *
 * **Emission is the established safe dump's.** A YAML 1.2 emitter, measured, writes
 * `ALLOW_EMPTY_PASSWORD: yes` bare, which is CORRECT 1.2 -- and compose reads YAML 1.1,
 * where bare `yes` is a boolean, and rejects the value. The document is written by the
 * emitter in `yaml-dump.ts`, whose YAML 1.1 resolver quotes it, and READ back with the
 * established grammar (`record.ts`'s `readCompose`), since that emitter's output is what
 * every workspace earlier releases made holds.
 */

import {
  ADMIN_EMAIL,
  ADMIN_NAME,
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  DEFAULT_BIND_HOST,
  MONGO_OPLOG_URL,
  MONGO_URL,
  RC_CONTAINER_PORT,
  yamlDateText,
} from './config';
import { ValidationError } from './errors';
import * as monitoring from './monitoring';
import type { Preset } from './presets/types';
import { toTextYaml } from './format';
import { safeDump, type ImplicitResolver } from './yaml-dump';

/** A compose service body. Deliberately open: presets merge arbitrary keys into it. */
export type Service = Record<string, unknown>;

export interface ComposeDoc {
  name: string;
  services: Record<string, Service>;
  volumes: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Spec {
  projectName: string;
  rcImage: string;
  rcTag: string;
  mongoTag: string;
  /** "bitnami-legacy" | "official" */
  mongoFlavor: string;
  /** Used only by the official flavor's init container. */
  mongoShell: string;
  oplog: boolean;
  rootUrl: string;
  /** houston-served TLS, independently of a customer's --root-url proxy. */
  publicUrl: string;
  hostPort: number;
  regToken: string | null;
  /** Whether the workspace holds an Enterprise licence in `LICENSE_ENV_FILE`. */
  licensed: boolean;
  preset: Preset;
  /** --monitor: add Prometheus + Grafana. */
  monitoring: boolean;
  /**
   * Their host ports, `[prometheus, grafana]`, as `extra.monitoring_ports` records them.
   * Absent is the preferred pair (`monitoring.services`).
   */
  monitorPorts?: readonly number[];
  /**
   * `up --env K=V` / `houston env --set`. Applied to every rocketchat service, LAST, so
   * it beats the preset. A null value removes the key.
   */
  envOverrides: Record<string, string | null>;
  containerPort: number;
  /**
   * Host interface published ports bind to (the official rocketchat-compose BIND_IP
   * pattern). Loopback by default: repros run weak fixed credentials, so they must not
   * be reachable from the local network unless asked.
   */
  bindHost: string;
  /**
   * The workspace's Rocket.Chat admin password. Empty means the shared loopback
   * `config.ADMIN_PASSWORD`. It is a SPEC field because the compose document is what
   * actually provisions the admin, so a password stored in repro.json and not put here
   * would be a record of a login that does not work.
   */
  adminPassword: string;
}

/** A `Spec` with the established defaults. */
export function spec(fields: Partial<Spec> & Pick<Spec, 'projectName' | 'preset'>): Spec {
  return {
    rcImage: '',
    rcTag: '',
    mongoTag: '',
    mongoFlavor: '',
    mongoShell: '',
    oplog: false,
    rootUrl: '',
    publicUrl: '',
    hostPort: 0,
    regToken: null,
    licensed: false,
    monitoring: false,
    envOverrides: {},
    containerPort: RC_CONTAINER_PORT,
    bindHost: DEFAULT_BIND_HOST,
    adminPassword: '',
    ...fields,
  };
}

/**
 * The rocketchat service name(s) in the compose doc: one 'rocketchat', or
 * 'rocketchat-1..N' for a multi-instance repro. Used for Prometheus targets.
 */
export function rcServiceNames(instances: number): string[] {
  const n = Math.max(1, instances || 1);
  if (n === 1) return ['rocketchat'];
  return Array.from({ length: n }, (_v, i) => `rocketchat-${i + 1}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Recursively merge `patch` into `base` (patch wins), returning `base`. */
function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(patch)) {
    const existing = base[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      deepMerge(existing, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

/** A deep copy, matching `copy.deepcopy` for the JSON-shaped values used here. */
function clone<T>(value: T): T {
  return structuredClone(value);
}

function rcEnvironment(s: Spec): Record<string, string> {
  const env: Record<string, string> = {
    ROOT_URL: s.rootUrl,
    PORT: String(s.containerPort),
    DEPLOY_METHOD: 'docker',
    DEPLOY_PLATFORM: 'compose',
    MONGO_URL,
    ALLOW_UNSAFE_QUERY_AND_FIELDS_API_PARAMS: 'false',
    // Every repro should be usable out of the box: skip the setup wizard (houston also
    // finalizes it over the API on `ready`) and auto-provision the first admin. Presets
    // only add their scenario-specific settings.
    OVERWRITE_SETTING_Show_Setup_Wizard: 'completed',
    // NO `INITIAL_USER`, and its absence is measured rather than assumed. It used to be
    // here as "yes", and Rocket.Chat parses this one as JSON: every boot of every
    // workspace logged `Error processing environment variable INITIAL_USER SyntaxError:
    // Unexpected token 'y', "yes" is not valid JSON`, on both runtimes, forever -- noise
    // in exactly the artefact a support engineer reads to find the customer's real
    // problem. `true` is what RC's docs use and it is WORSE: RC parses it, finds no
    // `_id`, and logs `No _id provided; Ignoring environment variable INITIAL_USER`.
    // Removing it entirely is what works, because the admin never came from it --
    // ADMIN_USERNAME/ADMIN_PASS/ADMIN_EMAIL below do that.
    ADMIN_USERNAME,
    ADMIN_NAME,
    ADMIN_EMAIL,
    ADMIN_PASS: s.adminPassword || ADMIN_PASSWORD,
  };
  if (s.oplog) {
    // RC < 8 only; deprecated in 8.x.
    env.MONGO_OPLOG_URL = MONGO_OPLOG_URL;
  }
  if (s.regToken) env.REG_TOKEN = s.regToken;
  // Preset env (OVERWRITE_SETTING_* etc.) wins over base defaults. The displayed form of
  // the value the preset's YAML holds: `String` wrote `true`, `null`, `Infinity`, `1,2`, `[object
  // Object]` and a date in the box's time zone where the established values are `True`,
  // `None`, `inf`, `[1, 2]`, `{'a': 1}` and `2026-01-01`.
  for (const [k, v] of Object.entries(s.preset.env)) env[k] = toTextYaml(v, yamlDateText);
  // Explicit user overrides win over everything, including the base keys: this is a
  // reproduction tool, so pointing MONGO_URL or ROOT_URL somewhere odd is a legitimate
  // thing to want. A null value means "remove this key entirely", which is how you unset
  // a base or preset default rather than merely blanking it.
  for (const [k, v] of Object.entries(s.envOverrides)) {
    if (v === null) delete env[k];
    else env[k] = String(v);
  }
  return env;
}

/**
 * mongod asks for 64000 open files and warns on every boot that 1024 is too low. Docker's
 * default soft limit IS 1024, and normal Rocket.Chat traffic survives it -- but building
 * many collections and indexes at once does not: a `houston restore` hit EMFILE inside
 * WiredTiger, which panics and aborts the whole mongod rather than failing the one
 * operation. The container's hard limit is far higher, so raising the soft limit costs
 * nothing.
 */
const MONGO_ULIMITS = { nofile: { soft: 64000, hard: 64000 } };

function mongoServiceBitnami(s: Spec): Record<string, Service> {
  // Bitnami auto-initiates the replica set via REPLICA_SET_MODE=primary, so no separate
  // init container is needed.
  return {
    mongodb: {
      image: `docker.io/bitnamilegacy/mongodb:${s.mongoTag}`,
      restart: 'always',
      ulimits: clone(MONGO_ULIMITS),
      // Bitnami MongoDB images are published for amd64 only; pin the platform so they
      // run (under emulation) on Apple Silicon too.
      platform: 'linux/amd64',
      volumes: ['mongodb_data:/bitnami/mongodb'],
      environment: {
        MONGODB_REPLICA_SET_MODE: 'primary',
        MONGODB_REPLICA_SET_NAME: 'rs0',
        MONGODB_PORT_NUMBER: '27017',
        MONGODB_INITIAL_PRIMARY_HOST: 'mongodb',
        MONGODB_INITIAL_PRIMARY_PORT_NUMBER: '27017',
        MONGODB_ADVERTISED_HOSTNAME: 'mongodb',
        MONGODB_ENABLE_JOURNAL: 'true',
        ALLOW_EMPTY_PASSWORD: 'yes',
      },
    },
  };
}

function mongoServiceOfficial(s: Spec): Record<string, Service> {
  // Mirrors the official RocketChat/rocketchat-compose: MongoDB Inc's community-server
  // image (runs as uid 1001), so a fix-permission container chowns the data dir first,
  // then a one-shot container initiates the replica set. `directConnection=true` lets
  // mongosh reach the node before rs.initiate.
  const image = `docker.io/mongodb/mongodb-community-server:${s.mongoTag}-ubi8`;
  const sh = s.mongoShell; // mongosh for Mongo >= 5
  const uri = 'mongodb://mongodb:27017/?directConnection=true';
  // RETRIED, a minute at most. mongod checks that `mongodb` resolves to itself, and one
  // failed lookup made this single shot exit 1 and the whole `up` fail -- on rootless Podman
  // its DNS misses for a moment whenever a neighbouring workspace's network comes or goes
  // (measured: 3 in 38,302 lookups during a neighbour's up and down, `NodeNotFound` at
  // `replSetInitiate`). `var`, which every shell this image may carry parses.
  const initiate =
    'for (var i = 1; ; i++) { try { rs.status(); break } catch (e) { ' +
    "try { rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: 'mongodb:27017' }] }); " +
    'break } catch (f) { if (i >= 30) throw f; sleep(2000) } } }';
  return {
    'mongodb-fix-permission': {
      image,
      user: '0',
      restart: 'on-failure',
      volumes: ['mongodb_data:/data/db:rw'],
      entrypoint: ['sh', '-c', 'chown -R 1001 /data/db'],
    },
    mongodb: {
      image,
      user: '1001',
      restart: 'always',
      ulimits: clone(MONGO_ULIMITS),
      depends_on: { 'mongodb-fix-permission': { condition: 'service_completed_successfully' } },
      volumes: ['mongodb_data:/data/db:rw'],
      entrypoint: ['mongod', '--replSet', 'rs0', '--bind_ip_all'],
      environment: { ALLOW_EMPTY_PASSWORD: 'yes' },
      healthcheck: {
        test: ['CMD', sh, uri, '--eval', "db.adminCommand('ping')"],
        interval: '10s',
        timeout: '10s',
        retries: 30,
        start_period: '20s',
      },
    },
    // THE CONNECTION RETRIED TOO, not only the initiate: the shell connects before `--eval`
    // runs, so a lookup of `mongodb` that missed at that moment ended this one shot -- a
    // fresh `up` under Podman's DNS churn lost one boot in fifteen, and every `restart`
    // re-runs it. The address and the script travel as environment so the shell quotes
    // nothing; `$$` is compose's escape for a `$` the shell is to read.
    'mongo-init': {
      image,
      restart: 'no',
      depends_on: { mongodb: { condition: 'service_healthy' } },
      entrypoint: [
        'sh',
        '-c',
        `for i in 1 2 3 4 5 6 7 8 9 10; do ${sh} "$$MONGO_URI" --eval "$$RS_INIT" && exit 0; ` +
          'sleep 2; done; exit 1',
      ],
      environment: { MONGO_URI: uri, RS_INIT: initiate },
    },
  };
}

/**
 * Healthcheck for a Rocket.Chat instance. Uses `node` (always in the RC image) to hit
 * /api/info, so we do not depend on curl/wget being present.
 */
const RC_HEALTHCHECK = {
  test: [
    'CMD',
    'node',
    '-e',
    "require('http').get('http://localhost:3000/api/info'," +
      "r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))",
  ],
  interval: '10s',
  timeout: '5s',
  retries: 30,
  start_period: '60s',
};

/** Normalise a depends_on (plain list or condition-map) to a condition-map. */
function asConditionMap(deps: unknown): Record<string, { condition: string }> {
  if (isPlainObject(deps)) return { ...deps } as Record<string, { condition: string }>;
  const out: Record<string, { condition: string }> = {};
  for (const d of Array.isArray(deps) ? deps : [])
    out[String(d)] = { condition: 'service_started' };
  return out;
}

/**
 * Clone the rocketchat service into N instances (rocketchat-1..N).
 *
 * Instances coordinate over NATS (the moleculer transporter), matching the official
 * RocketChat/rocketchat-compose. INSTANCE_IP is intentionally left unset -- the legacy
 * DDP-mesh address is not used once NATS is the transporter.
 *
 * The load balancer owns the workspace port (hostPort); each instance is ALSO published
 * directly on hostPort+i so you can open a specific instance in the browser (e.g. to
 * post on one and watch it arrive on another). Traefik reaches them over the compose
 * network by service name regardless.
 *
 * Cold start is serialised: only rocketchat-1 boots against the empty database (running
 * migrations and seeding settings); rocketchat-2..N wait for it to be healthy first, so
 * they never race it to insert the same records -- which on a fresh DB otherwise crashes
 * an instance with E11000 duplicate-key errors.
 */
function instanceServices(
  base: Service,
  n: number,
  hostPort: number,
  containerPort: number,
): Record<string, Service> {
  const out: Record<string, Service> = {};
  for (let i = 1; i <= n; i += 1) {
    const inst = clone(base);
    inst.ports = [`${hostPort + i}:${containerPort}`]; // direct access
    (inst.environment as Record<string, string>).TRANSPORTER = 'monolith+nats://nats:4222';
    inst.healthcheck = clone(RC_HEALTHCHECK);
    if (i > 1) {
      const deps = asConditionMap(inst.depends_on);
      deps['rocketchat-1'] = { condition: 'service_healthy' };
      inst.depends_on = deps;
    }
    out[`rocketchat-${i}`] = inst;
  }
  return out;
}

/** Add each name in `extra` to a service's depends_on (list or condition-dict). */
function addDepends(svc: Service, extra: readonly string[]): void {
  const deps = svc.depends_on;
  for (const dep of extra) {
    if (Array.isArray(deps)) {
      if (!deps.includes(dep)) deps.push(dep);
    } else if (isPlainObject(deps)) {
      if (!(dep in deps)) deps[dep] = { condition: 'service_started' };
    }
  }
}

/** The Prometheus/Grafana add-on, wired to every Rocket.Chat instance. */
function attachMonitoring(doc: ComposeDoc, rcServices: Record<string, Service>, s: Spec): void {
  if (!s.monitoring) return;
  deepMerge(doc.services, monitoring.services(s.publicUrl, s.monitorPorts)); // bare ports; bound below
  Object.assign(doc.volumes, monitoring.volumes());
  for (const svc of Object.values(rcServices)) {
    (svc.environment as Record<string, string>)[monitoring.RC_METRICS_ENV] = 'true';
  }
}

/** Give the published host port to the preset's front end, and to nothing else. */
function publishThroughEntryService(
  doc: ComposeDoc,
  rcServices: Record<string, Service>,
  s: Spec,
): void {
  // A preset can hand the published host port to a front-end service (a load balancer)
  // instead of rocketchat -- the port is not known until `up`, so it is injected here
  // rather than in the preset.
  const entry = s.preset.entryService;
  if (!entry) return;
  if (!(entry in doc.services)) {
    // Silently skipping meant NOTHING published the host port: the repro booted and was
    // unreachable at its own advertised rootUrl.
    throw new Error(
      `preset ${JSON.stringify(s.preset.name)} sets entry_service ${JSON.stringify(entry)}, ` +
        `which is not one of its services (${Object.keys(doc.services).sort().join(', ')})`,
    );
  }
  (doc.services[entry] as Service).ports = [`${s.hostPort}:80`];
  // The front-end owns the published port now. Leaving the same host port on the RC
  // service too binds it twice and `up` fails with "port is already allocated" -- which
  // a single-instance preset setting entry_service would hit every time. Drop only the
  // colliding mapping, so multi-instance keeps its direct per-instance ports on
  // hostPort+i.
  for (const [svcName, svc] of Object.entries(rcServices)) {
    if (svcName === entry) continue;
    const ports = Array.isArray(svc.ports) ? svc.ports : [];
    const kept = ports.filter((p) => String(p).split(':')[0] !== String(s.hostPort));
    if (kept.length > 0) svc.ports = kept;
    else delete svc.ports;
  }
}

/**
 * `[repository, tag]` for the chart, which wants them separately, and `imageRef`.
 *
 * `versions.resolve` returns the REPOSITORY only -- compose composes it as
 * `${image}:${tag}` -- so a naive split on the last ':' of a tagless string returns the
 * whole repository as the tag. That is truthy, so an `|| rcVersion` fallback does not save
 * it, and the chart fed it to `semverCompare`, which failed the install with "invalid
 * semantic version" rather than anything naming the image.
 *
 * A colon only introduces a tag when nothing after it looks like a path segment:
 * `registry:5000/org/img` is a host with a port, not a tag.
 */
export function splitImage(rcImage: string, rcVersion: string): [string, string] {
  const at = rcImage.lastIndexOf(':');
  if (at >= 0) {
    const tail = rcImage.slice(at + 1);
    if (!tail.includes('/')) return [rcImage.slice(0, at), tail];
  }
  return [rcImage, rcVersion];
}

/**
 * The image reference to run: the image as given when it already names a tag (a CI build,
 * `--rc-image repo:tag`), else `<image>:<version>`. Appending unconditionally rendered
 * `repo:tag:8.5.1`, which no registry can resolve.
 */
export function imageRef(rcImage: string, rcVersion: string): string {
  const [repo, tag] = splitImage(rcImage, rcVersion);
  return `${repo}:${tag}`;
}

/** What `forEngine` needs to know about the engine a document will run on. */
export interface EngineShape {
  readonly kind: string;
  /** The engine's API socket on this host. */
  readonly socket: string;
  /** Where it keeps containers: `/var/lib/docker`, or Podman's graph root. */
  readonly rootDir: string;
}

const DOCKER_SOCKET = '/var/run/docker.sock';
const DOCKER_CONTAINERS = '/var/lib/docker/containers';

/**
 * The document as the engine it will run on needs it. Docker's is returned as it is, the
 * same object, so its bytes cannot move. On Podman (measured rootless, 4.9.3 and 6.1.3):
 * - logs to files (`k8s-file`), where its default is journald, which leaves nothing for the
 *   log collector to tail; the collector already reads that CRI line format;
 * - the Docker paths a service mounts become Podman's own: its socket for the API, and its
 *   container store for the logs (`/var/lib/docker` does not exist; creating it is refused);
 * - `label=disable`, so a host with SELinux lets the containers read the files houston
 *   mounts (harmless where there is none).
 */
export function forEngine(doc: ComposeDoc, engine: EngineShape | null): ComposeDoc {
  if (engine === null || engine.kind !== 'podman') return doc;
  const out = clone(doc);
  for (const service of Object.values(out.services)) {
    service.logging = { driver: 'k8s-file' };
    const options = Array.isArray(service.security_opt) ? service.security_opt.map(String) : [];
    // Idempotent: a document re-applied (monitoring attached later) is not doubled.
    if (!options.includes('label=disable')) service.security_opt = [...options, 'label=disable'];
    if (!Array.isArray(service.volumes)) continue;
    service.volumes = service.volumes.map((volume) => {
      const text = String(volume);
      if (text.startsWith(`${DOCKER_SOCKET}:`))
        return `${engine.socket}${text.slice(DOCKER_SOCKET.length)}`;
      if (text.startsWith(`${DOCKER_CONTAINERS}:`)) {
        return `${engine.rootDir}/overlay-containers${text.slice(DOCKER_CONTAINERS.length)}`;
      }
      return volume;
    });
  }
  return out;
}

/** The workspace file holding `ROCKETCHAT_LICENSE`, 0600, beside the compose document. */
export const LICENSE_ENV_FILE = '.license.env';

/** A FIPS build is published for amd64 only (measured on ghcr, 2026-10-08). */
export function isAmd64Only(rcImage: string): boolean {
  return /-fips(-gha-run-[0-9]+)?$/u.test(splitImage(rcImage, '')[1]);
}

/** The Rocket.Chat service, or N clones of it behind a load balancer. */
function rocketchatServices(n: number, official: boolean, s: Spec): Record<string, Service> {
  const rocketchat: Service = {
    image: imageRef(s.rcImage, s.rcTag),
    ...(isAmd64Only(s.rcImage) ? { platform: 'linux/amd64' } : {}),
    restart: 'always',
    environment: rcEnvironment(s),
    // The licence from a file of its own, never in `environment`: this document is printed
    // by `env`, read by the GUI and kept in the workspace for anyone to open.
    ...(s.licensed ? { env_file: [LICENSE_ENV_FILE] } : {}),
    ports: [`${s.hostPort}:${s.containerPort}`],
    // The same probe the cloned instances have always had. Without it Docker reports no
    // health for this service, and `detail()` then falls back to the container STATE --
    // which is "running" from the moment the process starts, minutes before Rocket.Chat
    // serves anything. The panel said "Health: running" on a workspace whose /api/info
    // was refusing the connection outright, which is the one question that field exists
    // to answer.
    //
    // Informational only: nothing declares depends_on service_healthy against the
    // single-instance service, so this changes what is REPORTED and not what anything
    // waits for.
    healthcheck: clone(RC_HEALTHCHECK),
    depends_on: official
      ? { 'mongo-init': { condition: 'service_completed_successfully' } }
      : ['mongodb'],
  };

  // Single instance (the default): one `rocketchat` service, unchanged. Many instances:
  // clone it into rocketchat-1..N behind a load balancer.
  return n === 1 ? { rocketchat } : instanceServices(rocketchat, n, s.hostPort, s.containerPort);
}

/** Return the compose document for `spec`. */
export function build(s: Spec): ComposeDoc {
  const official = s.mongoFlavor === 'official';
  const n = Math.max(1, s.preset.instances || 1);

  const rcServices = rocketchatServices(n, official, s);

  const services: Record<string, Service> = { ...rcServices };
  Object.assign(services, official ? mongoServiceOfficial(s) : mongoServiceBitnami(s));

  const doc: ComposeDoc = {
    name: s.projectName,
    services,
    volumes: { mongodb_data: { driver: 'local' } },
  };

  // --- apply the preset's backing services / volumes / RC patch / depends_on ---
  if (Object.keys(s.preset.services).length > 0) {
    deepMerge(doc.services, clone(s.preset.services));
  }
  if (Object.keys(s.preset.volumes).length > 0) {
    Object.assign(doc.volumes, clone(s.preset.volumes));
  }
  // The RC patch and extra depends_on apply to EVERY rocketchat instance.
  for (const svc of Object.values(rcServices)) {
    if (Object.keys(s.preset.rocketchat).length > 0) deepMerge(svc, clone(s.preset.rocketchat));
    addDepends(svc, s.preset.dependsOn);
  }

  publishThroughEntryService(doc, rcServices, s);

  // --- HTTPS ---
  // Nothing here. A workspace never terminates TLS: the edge does, for all of them, and
  // it reaches this one over the private network compose already made.
  //
  // So this document is IDENTICAL whether the workspace serves https or not, which is
  // the property the whole design rests on -- adding or removing a name is a route file
  // appearing or disappearing, and no container is ever rebuilt to gain or lose TLS.
  //
  // RC keeps its published http port. houston's own API calls use it, so nothing
  // internal has to trust the local CA, and `curl http://localhost:<port>` still works.

  attachMonitoring(doc, rcServices, s);

  bindPorts(doc, s.bindHost);

  return doc;
}

/** "8000-8005:8000-8005", and the single-sided "8000-8005" form. */
const RANGE_RE = /^\d+-\d+(:\d+(-\d+)?)?$/;

/**
 * Prefix every published port with the bind host, unless one is already given. Applied
 * to ALL services in one pass -- RC, multi-instance direct ports, the load balancer, and
 * preset sidecars -- mirroring the official rocketchat-compose
 * `${BIND_IP}:${HOST_PORT}:${PORT}` pattern.
 */
/** A bind on one address that is not this machine's loopback: narrower than every address. */
function narrowerBind(bind: string): boolean {
  const b = bind.trim().toLowerCase();
  return (
    !['', '0.0.0.0', '::', '[::]', '*', 'localhost', '::1'].includes(b) && !b.startsWith('127.')
  );
}

export function bindPorts(doc: ComposeDoc, bind: string): void {
  if (!bind) return;
  for (const [name, svc] of Object.entries(doc.services)) {
    const ports = svc.ports;
    if (!Array.isArray(ports) || ports.length === 0) continue;
    const out: unknown[] = [];
    for (const p of ports) {
      // THE TYPE CHECK COMES FIRST. Stringifying compose long syntax gives the object's
      // text containing two colons, which matched the already-IP-qualified branch below
      // -- the object's text was appended as a ports entry. Any shape that is not a
      // string has to be recognised before it is stringified.
      if (isPlainObject(p)) {
        const long = { ...p };
        if ('published' in long && (long.host_ip ?? '') === '') long.host_ip = bind;
        out.push(long);
        continue;
      }
      const str = String(p);
      // The shape is read without a protocol suffix ("20000-20019/udp" is a range, "3478/udp"
      // a bare port); the entry keeps it.
      const shape = str.replace(/\/(tcp|udp)$/u, '');
      const colons = str.split(':').length - 1;
      const head = str.split(':')[0] ?? '';
      if (colons >= 2) {
        // Already IP-qualified ("127.0.0.1:8025:8025") -- prefixing again would produce
        // a double-IP mapping. One a preset opened to every address (voice's call ports, once
        // voip_domain names one) follows a bind chosen on purpose: `--bind 10.0.0.5` keeps
        // them on 10.0.0.5 rather than on every interface.
        out.push(
          str.startsWith('0.0.0.0:') && narrowerBind(bind) ? `${bind}:${str.slice(8)}` : str,
        );
      } else if (colons === 1 && head !== '' && /^[0-9]+$/.test(head)) {
        out.push(`${bind}:${str}`); // "8025:8025"
      } else if (shape !== '' && /^[0-9]+$/.test(shape)) {
        // A BARE container port. "127.0.0.1:8025" would be parsed as host:container with
        // an invalid host port, so use compose's IP::CONTAINER form: an ephemeral host
        // port, still bound to `bind` rather than every interface.
        out.push(`${bind}::${str}`);
      } else if (RANGE_RE.test(shape)) {
        // A PORT RANGE ("8000-8005:8000-8005"). This fell through to the `else` below
        // and was appended UNCHANGED, so it published on every interface while `info`
        // and the detail panel both reported the workspace as loopback-bound: a silent
        // opt-out of the default posture, on a workspace running fixed weak credentials.
        // Legal Compose, and reachable through the custom presets the README documents.
        // A one-sided range means CONTAINER ports with ephemeral host ports.
        // Preserve that with IP::RANGE; IP:RANGE is invalid HOST:CONTAINER.
        out.push(str.includes(':') ? `${bind}:${str}` : `${bind}::${str}`);
      } else {
        // NOT SILENTLY PASSED THROUGH. Everything above is a shape this function
        // understands; anything else is a published port it would be leaving on every
        // interface, which is the one outcome that must never be the default. Named so
        // the preset author can see what to change.
        throw new ValidationError(
          `port entry ${JSON.stringify(p)} in service ${JSON.stringify(name)} is a shape ` +
            `houston cannot bind to ${bind}. Write it as "HOST:CONTAINER", a range, or ` +
            'compose long syntax with `published:` -- leaving it unbound would publish ' +
            'it on every interface.',
        );
      }
    }
    svc.ports = out;
  }
}

export const HEADER = '# Generated by houston. Do not edit by hand -- re-run `houston up`.\n';

const TIME = String.raw`(?:[01]?[0-9]|2[0-3]):[0-5]?[0-9]:[0-5]?[0-9](?:[.,][0-9]+)?`;

/**
 * The plain scalars docker compose's reader types and this module's resolver does not --
 * the same three patterns earlier releases register, so the two writers stay equal byte for
 * byte.
 *
 * The safe dump writes a string PLAIN when its resolver, a YAML 1.1 one, would read the
 * bare text back as a string. compose-go reads the file with yaml.v3's resolver -- YAML
 * 1.2's numbers, plus the underscores, `0b` and timestamps it kept -- so the string reached
 * the container as a number: `env --set E1=1e8` gave E1=1e+08, `0o17` gave 15, `-.5` gave
 * -0.5, `12e03` gave 12000, `08` gave 8, `2001-1-2` gave `2001-01-02 00:00:00 +0000 UTC`,
 * and `2001-1-2T3:4:5+24:00` made docker refuse the whole file. Measured with `docker compose
 * -f FILE config --format json` over every string of up to four characters of
 * `0-9 + - . _ : a-f E o x O X B` and the lookalikes: 8,133 of 558,352 came back other than
 * they went in, every one written plain. Earlier releases' writer had the same defect. With
 * these the emitter quotes such a string by its own rules, in single quotes, as it already
 * quotes `'3000'` and `'yes'`.
 *
 * They are yaml.v3's `resolve()`: from a sign or a digit, with every `_` taken out, a Go
 * integer literal or a decimal float with an optional unsigned exponent; from a `.`,
 * `strconv.ParseFloat`; and the `time.Parse` layouts `2006-1-2`, with `T`/`t`, `15:4:5`, a
 * fraction and `Z` or `±hh:mm`, or with spaces and the time alone. A magnitude is past
 * them -- `1e999`, an integer past 64 bits in `0x`/`0o`/`0b`, 29 February of a common year
 * are strings to yaml.v3 and are quoted anyway, which reads back the same. `config.yaml`,
 * which only houston reads, is written without them.
 */
const COMPOSE_READER_TYPES: readonly ImplicitResolver[] = [
  [
    'tag:yaml.org,2002:int',
    new RegExp(
      String.raw`^(?:[-+]_*)?(?:0_*[xX]_*(?:[0-9a-fA-F]_*)+|0_*[oO]_*(?:[0-7]_*)+` +
        String.raw`|0_*[bB]_*(?:[01]_*)+|(?:(?:[0-9]_*)+(?:\._*(?:[0-9]_*)*)?|\._*(?:[0-9]_*)+)` +
        String.raw`(?:[eE]_*(?:[-+]_*)?(?:[0-9]_*)+)?)\n?$`,
    ),
    '-+0123456789',
  ],
  ['tag:yaml.org,2002:float', /^\.[0-9]+(?:_[0-9]+)*(?:[eE][-+]?[0-9]+(?:_[0-9]+)*)?\n?$/, '.'],
  [
    'tag:yaml.org,2002:timestamp',
    new RegExp(
      String.raw`^[0-9]{4}-(?:(?:0?[13578]|1[02])-(?:0?[1-9]|[12][0-9]|3[01])` +
        String.raw`|(?:0?[469]|11)-(?:0?[1-9]|[12][0-9]|30)|0?2-(?:0?[1-9]|[12][0-9]))` +
        String.raw`(?:[Tt]${TIME}(?:Z|[-+](?:[01][0-9]|2[0-4]):(?:[0-5][0-9]|60))| +${TIME})?\n?$`,
    ),
    '0123456789',
  ],
];

/**
 * The compose document as YAML: the header, then the document in block style with its keys
 * in their own order, through the emitter in `yaml-dump.ts`.
 *
 * It was the `yaml` package's emitter with `compat: 'yaml-1.1'`, and the package's choices
 * are not the established ones: `PORT: "3000"` where the established file holds `'3000'`,
 * the mongo init command on one 110-column line where the established file folds it at 80,
 * `1e8`, `0o17`, `-.5`, `y` and `N` quoted where the established resolver leaves them
 * plain, `café` raw where the established file escapes it, an empty key as `""` where the
 * established file holds `? ''`, anchors `&a1`, escapes in lower case. Every generated
 * document differed in its bytes from the established one, and every `env --set`,
 * `monitor` or `upgrade` of a workspace an earlier release made rewrote 7 to 16 of its
 * lines. The generated documents are now the established ones byte for byte, which is
 * stronger than `docker compose config` agreeing on them.
 *
 * What the package needed patching for is this emitter's own behaviour and needs nothing
 * more: `yes` is quoted because the resolver reads it as a bool, as it reads `=` and `<<`
 * as the value and merge tags; a tab, DEL, C1, U+2028/U+2029 and U+FFFE/U+FFFF are
 * double-quoted and escaped because the analyser calls them special; and a value of blank
 * lines holding spaces is double-quoted because a space before a line break rules out every
 * other style.
 *
 * Both writers quote `1e8`, `0o17` and `-.5` again since, for docker compose's reader rather
 * than the package's reasons: the resolver is the safe dump's and then
 * `COMPOSE_READER_TYPES`, here as in earlier releases, while `y` and `N` stay plain.
 */
export function toYaml(doc: ComposeDoc): string {
  return HEADER + safeDump(doc, { implicitResolvers: COMPOSE_READER_TYPES });
}
