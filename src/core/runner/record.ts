/**
 * `repro.json`: what a workspace wrote down about itself, and how it is read back.
 *
 * The on-disk names are snake_case because that file is a format earlier releases wrote and
 * this build reads unchanged; the TypeScript property names are camelCase because that is
 * what the rest of this tree reads like. `META_FIELDS` is the one table that maps between
 * them, so a typo breaks both directions at once and the round-trip test sees it -- two
 * hand-written mappings is how a field silently stops surviving a write.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as config from '../../lib/config';
import { MissingRecordError } from '../../lib/errors';
import { joinPath } from '../../lib/home';
import {
  compareCodePoints,
  pathExists,
  pathIsDir,
  decodeUtf8Strict,
  fileErrorOf,
  quotedText,
} from '../../lib/format';
import { JsonSyntaxError, dumps, loads, spelled } from '../../lib/json-text';

import { reproLock } from './locks';
import * as paths from './paths';

/** What a workspace recorded about itself. */
export interface Metadata {
  name: string;
  project: string;
  rcVersion: string;
  rcImage: string;
  mongoTag: string;
  mongoFlavor: string;
  preset: string;
  rootUrl: string;
  hostPort: number;
  versionSource: string;
  pinned: boolean;
  createdAt: string;
  /**
   * External https URL when `up --https` was used. Kept SEPARATE from `rootUrl`, which
   * stays the plain http://localhost:<port> that houston's own API calls (login, PAT,
   * seeding, load tests) use. Pointing those at a locally-signed https URL would fail
   * certificate verification in 71 call sites; RC still advertises this one as its
   * ROOT_URL, which is what the browser needs.
   */
  publicUrl: string;
  /**
   * The Rocket.Chat admin password FOR THIS WORKSPACE, when one was generated. Empty
   * means the shared `config.ADMIN_PASSWORD` -- which is every workspace made before
   * this field existed, and every loopback one made after. Read it through `adminPass`,
   * never directly, so the fallback is not a thing each of sixty call sites has to
   * remember.
   */
  adminPassword: string;
  extra: Record<string, unknown>;
}

/**
 * The record's fields in their established order, with the on-disk key beside the
 * property. ORDER IS PART OF THE FORMAT: a record is written in exactly this order, and a
 * file whose keys are shuffled is a needless diff against every record earlier releases
 * wrote.
 */
export const META_FIELDS: readonly (readonly [keyof Metadata, string])[] = Object.freeze([
  ['name', 'name'],
  ['project', 'project'],
  ['rcVersion', 'rc_version'],
  ['rcImage', 'rc_image'],
  ['mongoTag', 'mongo_tag'],
  ['mongoFlavor', 'mongo_flavor'],
  ['preset', 'preset'],
  ['rootUrl', 'root_url'],
  ['hostPort', 'host_port'],
  ['versionSource', 'version_source'],
  ['pinned', 'pinned'],
  ['createdAt', 'created_at'],
  ['publicUrl', 'public_url'],
  ['adminPassword', 'admin_password'],
  ['extra', 'extra'],
] as const);

/** A record with the established defaults, for the fields that have one. */
export function metadata(values: Partial<Metadata> = {}): Metadata {
  return {
    name: '',
    project: '',
    rcVersion: '',
    rcImage: '',
    mongoTag: '',
    mongoFlavor: '',
    preset: '',
    rootUrl: '',
    hostPort: 0,
    versionSource: '',
    pinned: false,
    createdAt: '',
    publicUrl: '',
    adminPassword: '',
    extra: {},
    ...values,
  };
}

/**
 * What a human or a browser should open -- the https URL if there is one, else the one
 * `--root-url` advertised (a proxy's, a tunnel's), else houston's own loopback address.
 */
export function externalUrl(meta: Metadata): string {
  // `extra` is null in a hand-edited record, and the detail panel still has to render it.
  const extra = meta.extra as Record<string, unknown> | null;
  return meta.publicUrl || String(extra?.advertised_url ?? '') || meta.rootUrl;
}

/**
 * This workspace's admin password.
 *
 * `config.ADMIN_PASSWORD` is the fixed `admin123`, and loopback is WHY that is
 * acceptable -- `config.DEFAULT_BIND_HOST`'s own comment says so. A workspace reachable
 * beyond loopback removes that premise, so `createRepro` generates one for it and
 * stores it here.
 *
 * Everything that logs in reads THIS, not the constant: houston's own REST calls
 * (readiness, PATs, seeding, settings, load tests) would otherwise all authenticate
 * with `admin123` against a workspace whose admin password is not `admin123`.
 *
 * The empty fallback is not a default so much as a version marker: a repro.json written
 * before this field existed means a workspace whose Rocket.Chat really does run
 * `admin123`, and it has to keep working untouched.
 */
export function adminPass(meta: Metadata): string {
  return meta.adminPassword || config.ADMIN_PASSWORD;
}

/** A host port as a record may spell it: an integer 1024-65535, else null. */
function hostPort(value: unknown): number | null {
  const port = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535
    ? port
    : null;
}

/**
 * The workspace's side ports, sparse over `config.PRESET_PORTS`: `extra.side_ports` names only
 * the presets whose ports MOVED because another workspace held them. A workspace on the
 * preferred ports, and every record written before ports could move, has no key -- and those
 * presets publish their preferred ports, which is what such a workspace runs.
 *
 * Read it through this, never directly. A hand-edited record is a trust boundary: an entry
 * that is not a registry preset, or not a list of that preset's length of ports 1024-65535,
 * is dropped, so that preset answers its preferred ports rather than a nonsense address.
 */
export function sidePortsOf(meta: Metadata): config.PortMap {
  // A record whose `extra` is null is read as having none, as `recordedOwner` reads it.
  const recorded = ((meta.extra as Record<string, unknown> | null) ?? {}).side_ports;
  if (recorded === null || typeof recorded !== 'object' || Array.isArray(recorded)) return {};
  const out: Record<string, readonly number[]> = {};
  for (const [name, value] of Object.entries(recorded as Record<string, unknown>)) {
    const preferred = config.PRESET_PORTS[name];
    if (preferred === undefined || !Array.isArray(value) || value.length !== preferred.length)
      continue;
    const ports = value.map(hostPort);
    if (ports.every((port) => port !== null)) out[name] = ports as number[];
  }
  return out;
}

/**
 * Monitoring's recorded host ports, by POSITION as `extra.monitoring_ports` holds them: Docker
 * publishes `[prometheus, grafana]`, Kubernetes forwards Grafana alone, `[grafana]`. Absent --
 * never monitored, or a public workspace -- is the preferred pair.
 */
function monitoringPorts(meta: Metadata): number[] {
  const recorded = ((meta.extra as Record<string, unknown> | null) ?? {}).monitoring_ports;
  if (!Array.isArray(recorded) || recorded.length === 0 || recorded.length > 2) return [];
  const ports = recorded.map(hostPort);
  return ports.every((port) => port !== null) ? (ports as number[]) : [];
}

/** The workspace's Grafana host port: its last recorded monitoring port, else the preferred. */
export function grafanaPortOf(meta: Metadata): number {
  return monitoringPorts(meta).at(-1) ?? config.MONITOR_PORTS[1];
}

/** The workspace's Prometheus host port: the first of a recorded pair, else the preferred. */
export function prometheusPortOf(meta: Metadata): number {
  const ports = monitoringPorts(meta);
  return ports.length === 2 ? (ports[0] as number) : config.MONITOR_PORTS[0];
}

/** Who owns it, as `ownership.ownerOf` reads it, for a message: '' when the record names nobody. */
export function recordedOwner(meta: Metadata): string {
  const extra = (meta.extra as Record<string, unknown> | null) ?? {};
  const owner =
    typeof extra.owner === 'string' && extra.owner !== '' ? extra.owner : extra.created_by;
  return typeof owner === 'string' ? owner : '';
}

/**
 * The admin password a workspace brought back with its data must keep, or null when there is
 * no record. Rocket.Chat reads ADMIN_PASS only when it first fills an empty database, so a new
 * one minted on a rebuild was recorded and accepted by nothing: after `up --force`, or `up`
 * after `down` on Kubernetes, every `api`, `token` and `seed` answered 401.
 *
 * ponytail: a loopback workspace rebuilt public keeps its database's shared password; houston
 * now says so instead of printing one that does not work. Changing it takes the admin API.
 */
export async function keptAdminPassword(name: string): Promise<string | null> {
  try {
    return (await readMeta(name)).adminPassword;
  } catch {
    return null;
  }
}

/** The record as the JSON document that goes on disk, in the established field order. */
export function toDocument(meta: Metadata): Record<string, unknown> {
  const document: Record<string, unknown> = {};
  for (const [property, key] of META_FIELDS) document[key] = meta[property];
  return document;
}

/**
 * A document from disk as a record.
 *
 * Unknown keys are dropped rather than raising: a repro.json written by a NEWER houston
 * carrying an added field would otherwise fail, and `listMeta` swallows that -- silently
 * making the repro vanish from `houston list`.
 */
export function fromDocument(document: Record<string, unknown>): Metadata {
  const values: Partial<Metadata> = {};
  const kept: ReadSpelling[] = [];
  for (const [property, key] of META_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(document, key)) {
      (values as Record<string, unknown>)[property] = document[key];
      const held = spelled(document, key);
      if (held !== document[key]) kept.push([property, key, document[key], held]);
    }
  }
  const meta = metadata(values);
  if (kept.length > 0) READ_SPELLINGS.set(meta, kept);
  return meta;
}

/** A top-level field read with a spelling its double lost: the field, its key, both values. */
type ReadSpelling = readonly [keyof Metadata, string, unknown, unknown];

/**
 * What `fromDocument` copied out of a document that the copy could not hold, per record.
 *
 * A float read stays a float, and each field is written back as it was read: a hand-edited
 * `"host_port": 3100.0` or `"pinned": 1.0` has always survived every record update. `loads`
 * keeps that spelling beside the DOCUMENT, and the fields are copied out of it onto the
 * record, so a rewrite through this build -- a Kubernetes `stop` dropping its port-forward
 * pid, a `chown`, an `env --set` -- wrote `3100` and `1`. The nested
 * `extra` needed nothing: it is the object `loads` built, table and all.
 *
 * Kept beside the record rather than in it, for the reason `json-text` keeps it beside the
 * value: `hostPort` is a number to every reader, and only the writer needs to know more.
 * `serialise` writes a field's spelling while the field still holds what was read, and the
 * field itself once something has changed it.
 */
const READ_SPELLINGS = new WeakMap<Metadata, readonly ReadSpelling[]>();

/**
 * The record in the bytes earlier releases write it in -- indented by 2, fields in order --
 * byte for byte.
 *
 * `JSON.stringify` wrote the same document in different bytes: raw UTF-8 where the
 * established form writes `\u00e9` (everything past ASCII escaped), `null` where it writes
 * `NaN` or `Infinity` -- which a later read got back as null -- and `1e-7` where the
 * established float spelling is `1e-07`. And because `updateMeta` rewrites the whole file,
 * one `chown` or `env --set` through this build re-spelled every character and number an
 * earlier release had written, in every workspace it touched. Every writer of repro.json
 * goes through this one, the Kubernetes path's included.
 */
export function serialise(meta: Metadata): string {
  const document = toDocument(meta);
  for (const [property, key, read, held] of READ_SPELLINGS.get(meta) ?? []) {
    if (Object.is(meta[property], read)) document[key] = held;
  }
  return dumps(document, { indent: 2 });
}

/**
 * Load a repro's metadata.
 *
 * A TYPED error, not a raw ENOENT. `exists` accepts either marker and this needs
 * repro.json, so a directory left with only a compose file -- a SIGKILL, an OOM or a
 * host reboot between the two writes -- resolved fine and then raised out of
 * `detail`/`describe` on the request thread, which in `serve` is a 500 with a stack trace
 * rather than the documented ReproError -> status mapping. It is now a 404 that says
 * how to finish or remove it.
 */
export async function readMeta(name: string): Promise<Metadata> {
  const record = joinPath(paths.workspace(name), 'repro.json');
  // Whether it exists, then its text, read as strict UTF-8 and parsed by `loads`. A read
  // that failed for ANY reason was "no repro.json" here (exit 4, and skipped by `list`),
  // where only absence is that: a record that may not be read, a directory in its place,
  // or bytes that are not UTF-8 are each an unhandled error naming the file, exit 1, as they
  // always were -- and a NaN in it is a value to
  // `loads`, where JSON.parse refused the record.
  if (!pathExists(record)) {
    throw new MissingRecordError(
      `${quotedText(name)} has no repro.json, so it is a half-written workspace rather than one ` +
        `houston can act on — finish it with \`houston up --version <version> --name ${name}\`, or remove ` +
        `it with \`houston down --name ${name} --volumes\``,
    );
  }
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(record);
  } catch (error) {
    throw fileErrorOf(error, record);
  }
  const blob: unknown = loads(decodeUtf8Strict(bytes, record));
  if (blob === null || typeof blob !== 'object' || Array.isArray(blob)) {
    throw new TypeError('repro.json is not a JSON object');
  }
  // A Metadata from the document: the ten fields with no default are REQUIRED, and a record
  // missing one is refused, naming them -- a truncated repro.json is not a workspace with empty
  // fields. An earlier version filled defaults, so `info --json` on `{"name": "trunc"}`
  // answered ok:true.
  const missing = REQUIRED_FIELDS.filter((key) => !Object.hasOwn(blob, key));
  if (missing.length > 0) {
    const list =
      missing.length <= 2
        ? missing.join(' and ')
        : `${missing.slice(0, -1).join(', ')}, and ${missing[missing.length - 1] ?? ''}`;
    throw new TypeError(
      `${record} is missing ${String(missing.length)} required ` +
        `field${missing.length === 1 ? '' : 's'}: ${list}`,
    );
  }
  return fromDocument(blob as Record<string, unknown>);
}

/** The record fields with no default, in declaration order. */
const REQUIRED_FIELDS: readonly string[] = Object.freeze([
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
]);

/**
 * A value this workspace WROTE DOWN when it was created, or "" if there is none.
 *
 * Reads the record field first and falls back to the `extra` bag, because the three
 * identities that matter here were persisted in two different places for historical
 * reasons and a caller should not have to know which.
 *
 * Never throws. Every caller has a mint-time default to fall back on, and a workspace
 * that is half-written, unreadable, or written by a newer houston must degrade to
 * "derive it" rather than turn a name lookup into an error.
 */
export async function recorded(name: string, field: string): Promise<string> {
  let meta: Metadata;
  try {
    meta = await readMeta(name);
  } catch {
    return '';
  }
  // EITHER SPELLING FINDS THE RECORD'S OWN FIELD. Every caller of this helper names the
  // value by its on-disk key -- `public_url`, `project`, `namespace` -- and the bare-key
  // lookup found nothing for `public_url`, so it silently fell through to the `extra` bag.
  // Mapping through META_FIELDS first is what makes the record's own field win; the
  // property spelling stays accepted because the record spec already promised it.
  const property = META_FIELDS.find(([name, key]) => key === field || name === field)?.[0];
  // WIDENED TO `unknown` FIRST. The interface's field union carries no `undefined`, so
  // the compiler is sure the missing-key case cannot happen -- and a half-written record
  // is exactly where it does.
  const direct: unknown = property === undefined ? undefined : meta[property];
  const value =
    direct === undefined || direct === null || direct === '' ? meta.extra[field] : direct;
  return value === undefined || value === null || value === false ? '' : String(value);
}

/**
 * The Compose project this workspace's containers ACTUALLY live under.
 *
 * RECORDED, not derived. `PROJECT_PREFIX` says what a new workspace gets; it does not
 * describe one that already exists. Deriving it here made the prefix and the containers
 * on the daemon two independent sources of truth that merely happened to agree -- and
 * they stop agreeing the moment the prefix changes, which is not hypothetical: this
 * tool was renamed. At that point `list` reads the recorded project and reports the
 * workspace running, while `down` derives a different one and tears down nothing,
 * leaking the containers along with their ports and the customer's Mongo volume.
 */
export async function projectName(name: string): Promise<string> {
  return (await recorded(name, 'project')) || paths.mintProjectName(name);
}

/**
 * Write a workspace: its record, its compose document, and any preset-generated files.
 *
 * THE RECORD FIRST, and the order is the whole point. Each write is individually
 * atomic; the PAIR is not, and a kill between them leaves a directory that `exists`
 * accepts. Compose-first left the half that `listMeta` skips and `readMeta` cannot
 * read -- a workspace invisible to `list`, `prune` and port allocation while still
 * occupying its name. Record-first leaves the half that is fully visible and whose
 * compose file `up` regenerates anyway, which is already this tool's contract for that
 * document.
 *
 * A file in `keep` is written only when absent (`Preset.keepFiles`): a person edits it.
 */
export async function write(
  name: string,
  composeYaml: string,
  meta: Metadata,
  files: readonly (readonly [string, string])[] = [],
  keep: ReadonlySet<string> = new Set(),
): Promise<void> {
  const ws = paths.workspace(name);
  await fs.mkdir(ws, { recursive: true });
  // The generated compose file carries ADMIN_PASS and, when set, REG_TOKEN, and preset
  // files carry LDAP and MinIO credentials -- all of it written at the process umask,
  // which on a normal box leaves them readable by every local user. Applied on every
  // write, so workspaces created before this are tightened when next touched.
  await paths.restrict(ws);
  await paths.atomicWrite(joinPath(ws, 'repro.json'), serialise(meta));
  await paths.atomicWrite(joinPath(ws, 'docker-compose.yml'), composeYaml);

  for (const [relative, content] of files) {
    const target = joinPath(ws, relative);
    if (keep.has(relative)) {
      const found = await fs.stat(target).catch(() => null);
      if (found?.isFile() === true) continue; // a kept file someone may have edited
      // The empty folder Docker creates at a bind mount whose file was deleted: not an edit.
      // A folder with something in it is someone's, and rmdir refuses it, loudly.
      if (found?.isDirectory() === true) await fs.rmdir(target);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    // The ADVERTISED url, falling back to the loopback one. A generated file carrying
    // this placeholder is read by a BROWSER, and `meta.rootUrl` is the address houston
    // uses for its own API calls -- always loopback, by contract. Substituting that
    // shipped a livechat demo page that only worked on the machine docker runs on.
    const advertised = String(meta.extra.advertised_url ?? '') || meta.rootUrl;
    await fs.writeFile(target, content.split('{{ROOT_URL}}').join(advertised), 'utf8');
  }
  await paths.restrict(ws); // again: covers the files just written, and their dirs
}

/**
 * Write just `repro.json`, for a workspace that has no compose document.
 *
 * The Kubernetes path has no docker-compose.yml to write, so it called `atomicWrite`
 * directly -- and `restrict` lives in `write`, which it therefore never reached. That
 * left the whole workspace directory at the process umask on the one runtime that ALSO
 * writes `kubernetes/values.yaml` carrying ADMIN_PASS, so a generated per-workspace
 * admin password was readable by every local user.
 */
export async function writeRecord(name: string, meta: Metadata): Promise<void> {
  const ws = paths.workspace(name);
  await fs.mkdir(ws, { recursive: true });
  await paths.restrict(ws);
  await paths.atomicWrite(joinPath(ws, 'repro.json'), serialise(meta));
  await paths.restrict(ws); // again: covers anything written into it since
}

/**
 * Read-modify-write repro.json under the repro lock.
 *
 * Every other mutator holds this lock while it rewrites the workspace, so a metadata
 * edit that skipped it could be lost by a concurrent `up --force` rewriting the same
 * file from the spec. `mutate(meta)` edits in place.
 */
export async function updateMeta(
  name: string,
  mutate: (meta: Metadata) => void,
): Promise<Metadata> {
  return await reproLock(
    name,
    async () => {
      const meta = await readMeta(name);
      mutate(meta);
      await paths.atomicWrite(joinPath(paths.workspace(name), 'repro.json'), serialise(meta));
      return meta;
    },
    { timeoutMs: 60_000 },
  );
}

/**
 * Load a repro's generated docker-compose.yml as a document, for in-place edits like
 * attaching or detaching the monitoring stack.
 */
export async function readCompose(name: string): Promise<Record<string, unknown>> {
  // Strict UTF-8, as `readMeta` reads the record: an fs error is `fileErrorOf`'s, named for
  // the file, and bytes that are not UTF-8 are a `NotUtf8` refusal. An earlier version let
  // Node's own error out --
  // `Error: ENOENT: ..., open '<path>'` for the compose file a kill between `runner.write`'s
  // two writes leaves missing, and `EISDIR: illegal operation on a directory, read`, which
  // names no file at all -- and read a stray non-UTF-8 byte as U+FFFD, which `env --set` then
  // wrote back.
  const file = joinPath(paths.workspace(name), 'docker-compose.yml');
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(file);
  } catch (error) {
    throw fileErrorOf(error, file);
  }
  const raw = decodeUtf8Strict(bytes, file);
  // `safeLoadYaml`, the YAML 1.1 grammar cell for cell. This read was YAML 1.2, and the file
  // it reads is the one the YAML 1.1 emitter wrote for every workspace an earlier release
  // made: it leaves `1e8`, `0o17`, `1e-3`, `-.5` and `1e+8` unquoted, since YAML 1.1 types
  // none of them as numbers, and YAML 1.2 types every one -- so `info` showed
  // `up --env X=1e8` as `100000000`, and `monitor attach` and `env --set` wrote it back
  // that way, changing the value in the container.
  // A stray bare `yes` is a boolean here, as YAML 1.1 has it; `compose.ts` quotes one.
  // Timestamps stay text, because this document is written back (`YAML11_TIMESTAMP_TEXT`).
  const document = config.safeLoadYaml(raw, { timestampsAsText: true });
  return document === null || typeof document !== 'object' || Array.isArray(document)
    ? {}
    : (document as Record<string, unknown>);
}

/**
 * The records under `repros/`, sorted by code point. A directory reached through a SYMLINK
 * is one (`pathIsDir` follows the link, where a Dirent does not, and the workspace vanished
 * from `list`, from `prune` and from port allocation); a `repros/` that cannot be listed
 * is an error, not an empty box; and only the records a half-written or foreign directory
 * leaves -- none, one that is not JSON, one that is not a Metadata -- are skipped. Anything
 * else is the error it is.
 */
export async function listMeta(): Promise<Metadata[]> {
  const root = config.reprosDir();
  if (!pathExists(root)) return [];
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (error) {
    throw fileErrorOf(error, root);
  }
  const out: Metadata[] = [];
  for (const name of names.sort(compareCodePoints)) {
    if (!pathIsDir(joinPath(root, name))) continue;
    try {
      out.push(await readMeta(name));
    } catch (error) {
      if (
        error instanceof MissingRecordError ||
        error instanceof JsonSyntaxError ||
        error instanceof TypeError
      ) {
        continue; // skip half-written / foreign dirs
      }
      throw error;
    }
  }
  return out;
}

/**
 * The repro's Rocket.Chat service names, read from its compose file.
 *
 * A multi-instance repro has rocketchat-1..N rather than one `rocketchat`, and
 * quiescing only the first would leave the others writing during a dump.
 */
export async function rcServices(name: string): Promise<string[]> {
  let document: Record<string, unknown>;
  try {
    document = await readCompose(name);
  } catch {
    return [];
  }
  const services = document.services;
  if (services === null || typeof services !== 'object') return [];
  return Object.keys(services)
    .filter((service) => service === 'rocketchat' || service.startsWith('rocketchat-'))
    .sort();
}
