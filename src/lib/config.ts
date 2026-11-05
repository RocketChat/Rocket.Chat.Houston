/**
 * Paths, constants, and the small persisted config for houston.
 *
 * State lives under `~/.houston` (override with `HOUSTON_HOME`):
 *
 *     ~/.houston/
 *       config.yaml            # default_repro, bind_host, acme.*, gui.* -- NO secrets:
 *                              #   reg_token is env/flag only and is never persisted
 *                              #   (see updateConfig, which reads with env off)
 *       presets/               # user/team presets (override built-ins)
 *       repros/<name>/         # one workspace per repro
 *
 * ONE KNOWN GAP, and it is the same one `lock.ts` records: there is no cross-PROCESS lock
 * around the read-modify-write of config.yaml. That would take an `flock` plus an additive
 * OFD lock, and the native addon that would provide them is ruled out; within the process
 * no lock is needed, since Node runs one JavaScript thread. The atomic temp-file plus rename
 * below still prevents a TORN file; it does not prevent a LOST UPDATE, and those are
 * different problems. The `IMPLEMENTATION` marker is what keeps two builds off one home.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import * as YAML from 'yaml';
import type { ScalarTag, Tags } from 'yaml';

import { ConflictError } from './errors';
import { pathHome, joinPath } from './home';
import { fileErrorText, parseFloat_, intFromText, quotedText } from './format';
import { mkdirParents } from './mkdir-parents';
import { JsonFloat, stripText } from './float-text';
import { safeDump } from './yaml-dump';

/** Container-internal Rocket.Chat port. The published host port is chosen per repro. */
export const RC_CONTAINER_PORT = 3000;

/**
 * Docker compose project (and container) name prefix, so houston's stacks are easy to
 * tell apart from unrelated compose projects.
 */
export const PROJECT_PREFIX = 'houston-';

/**
 * Admin user auto-provisioned into every repro (see presets / compose).
 *
 * ADMIN_PASSWORD is the LOOPBACK password, and that is the whole of its contract.
 * `DEFAULT_BIND_HOST` below explains why a fixed weak credential is acceptable at all:
 * nothing outside this machine can reach the workspace. A workspace that gets a public
 * name or a non-loopback bind removes that premise, and a password is generated per
 * workspace instead.
 */
export const ADMIN_USERNAME = 'admin';
export const ADMIN_PASSWORD = 'admin123';
export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_NAME = 'Admin';

/**
 * Bytes of entropy in a generated workspace admin password. 15 bytes is 120 bits
 * through base64url, which is 20 characters -- long enough that the answer to "is this
 * brute-forcible from the internet" is not a calculation, short enough to read off a
 * terminal and type into a browser once.
 */
const ADMIN_PASSWORD_BYTES = 15;

/**
 * A fresh admin password for one workspace.
 *
 * `crypto.randomBytes`, never `Math.random`: a cryptographic source against a predictable
 * one, and it is the only thing that matters here. `base64url` is the URL-safe alphabet
 * earlier releases generated from, 20 characters for 15 bytes.
 */
export function generateAdminPassword(): string {
  return crypto.randomBytes(ADMIN_PASSWORD_BYTES).toString('base64url');
}

/**
 * Host ports by preset and position: the registry's own, or one workspace's.
 *
 * SPARSE where it is one workspace's: a preset it does not name publishes its registry ports
 * (`presets/common.ts` `presetPorts` is the one reader that falls back).
 */
export type PortMap = Readonly<Record<string, readonly number[]>>;

/**
 * The PREFERRED host ports of preset side services. ONE registry, so presets cannot
 * silently collide with each other -- a new preset picks a port by looking here. The first
 * workspace on a machine gets these; another with the same preset gets the next free port,
 * recorded in its own record and kept from then on (`core/lifecycle/ports.ts`).
 */
export const PRESET_PORTS: PortMap = Object.freeze({
  saml: Object.freeze([8081]), // Keycloak (SAML)
  oidc: Object.freeze([8085]), // Keycloak (OIDC; same port inside+out)
  email: Object.freeze([8025]), // Mailpit web UI / API
  s3_minio: Object.freeze([9000, 9001]), // MinIO S3 API + console
  livechat: Object.freeze([8090]), // demo "customer website" embedding the widget
  ldap: Object.freeze([8082]), // phpLDAPadmin -- browse the directory the preset seeded
  webhooks: Object.freeze([8086]), // webhook-tester, the inbox every outgoing call lands in
});

/**
 * The PREFERRED host ports of the --monitor add-on (Prometheus, Grafana). Not a preset, so
 * kept separate from PRESET_PORTS but allocated the same way: the first monitored workspace
 * gets these, another the next free ones (`extra.monitoring_ports` records which).
 */
export const MONITOR_PORTS: readonly [number, number] = Object.freeze([9090, 5050]);

/**
 * Traefik, for the shared HTTPS edge and the multi-instance preset's load balancer: one pin,
 * so a workspace that uses both runs one version. v3.4 stopped at 3.4.5 in July 2025; v3.7
 * is the maintained line (3.7.0 in May 2026). Floating on the minor, for its patches.
 */
export const TRAEFIK_TAG = 'v3.7';

/**
 * Host interface published ports bind to.
 *
 * LOOPBACK. Repros use weak fixed credentials, so they must not be reachable from the
 * local network unless the user opts in (`up --bind 0.0.0.0` or `HOUSTON_BIND_HOST`).
 * Matches the official rocketchat-compose posture for local and backing services.
 */
export const DEFAULT_BIND_HOST = '127.0.0.1';

/** In-network addresses of the Mongo replica set (compose service DNS). */
export const MONGO_URL = 'mongodb://mongodb:27017/rocketchat?replicaSet=rs0';
export const MONGO_OPLOG_URL = 'mongodb://mongodb:27017/local?replicaSet=rs0';

/** Key under `Metadata.extra` where the email preset records Mailpit's URL. */
export const EXTRA_MAILPIT_URL = 'mailpit_url';

/**
 * The webhooks preset's receiver (webhook-tester): the compose/Kubernetes DNS name
 * Rocket.Chat reaches it at, the Service being named after the service. It records any
 * request whose path starts with a session's uuid; post-ready makes the session through
 * its API (answering JSON: the kind the receiver makes by itself answers an empty body,
 * a failed call to Rocket.Chat) and records the uuid the receiver chose. Here, below every
 * preset and core module, so the post-ready action and the lifecycle import no builder.
 */
export const WEBHOOKS_RECEIVER = 'http://webhooks:8080';
/** The sample integrations post-ready creates, found again by name on every re-run. */
export const WEBHOOKS_OUTGOING = 'houston-outgoing';
export const WEBHOOKS_INCOMING = 'houston-incoming';
/** The Omnichannel webhook's secret, sent as X-RocketChat-Livechat-Token. */
export const WEBHOOKS_TOKEN = 'houston';

/**
 * Key under `Metadata.extra` naming the runtime a workspace runs on. ABSENT means
 * docker -- every workspace created before this key existed is a compose one.
 */
export const EXTRA_RUNTIME = 'runtime';

/** Key under `Metadata.extra` naming HOW Rocket.Chat is arranged. */
export const EXTRA_DEPLOYMENT = 'deployment';

/** Key under `Metadata.extra` naming WHICH Kubernetes cluster a workspace runs in. */
export const EXTRA_CONTEXT = 'context';

/**
 * Stored config key: the default `--context` for this box. FLAT, not dotted, and the
 * reason is mechanical rather than stylistic -- the env-override map below keys on flat
 * names only, so a dotted stored key could never have an env override.
 */
export const KUBE_CONTEXT_KEY = 'kubernetes_context';

/**
 * Stored config key: which AWS accounts this box may build a cluster in. Comma
 * separated, absent meaning none, and none meaning every create is gated.
 *
 * Keyed on the ACCOUNT rather than a cluster name or a context, because the account is
 * the thing that gets BILLED -- the unit somebody actually owns and can consent to.
 */
export const CLOUD_ACCOUNTS_KEY = 'cluster_approved_accounts';

/** RC's REST rate limiter -- disabled for the duration of a load test, then restored. */
export const RC_RATE_LIMITER_SETTING = 'API_Enable_Rate_Limiter';

/**
 * The settings that make Rocket.Chat create new DMs and private rooms encrypted -- off for
 * the duration of a seed, then restored, because the seeder sends plaintext and Rocket.Chat
 * refuses plaintext in an encrypted room. The last exists from 8.8.0.
 */
export const E2EE_ROOM_DEFAULT_SETTINGS: readonly string[] = Object.freeze([
  'E2E_Enabled_Default_DirectRooms',
  'E2E_Enabled_Default_PrivateRooms',
  'E2E_Force_Encryption_For_Private_Rooms',
]);

export const ENV_PREFIX = 'HOUSTON_';

/**
 * Environment variables were spelled `RC_REPRO_*` before the rename. They are read as
 * deprecated aliases rather than dropped: a rename that only taught the tool the new
 * name would make an `RC_REPRO_HOME` sitting in someone's shell profile do nothing at
 * all -- not fail, just quietly resolve state to `~/.houston` while every workspace they
 * own is somewhere else. Silence is the wrong failure for a variable whose only job is
 * to say where the state lives.
 */
export const LEGACY_ENV_PREFIX = 'RC_REPRO_';

/** Legacy names already warned about, so the notice fires once per process. */
const legacyEnvWarned = new Set<string>();

/**
 * Pre-rename variable names set in THIS environment, sorted.
 *
 * Read from the environment rather than from a record of what this process happened to
 * look up. A historical record answers "did anything read one yet", which depends on
 * which commands ran in what order -- so `doctor` would report a variable that is no
 * longer set, or stay silent about one that is simply not read on this code path.
 */
export function legacyEnvUsed(): string[] {
  return Object.keys(process.env)
    .filter((name) => name.startsWith(LEGACY_ENV_PREFIX))
    .sort();
}

/**
 * Read `HOUSTON_<X>`, falling back to the pre-rename `RC_REPRO_<X>`.
 *
 * The new spelling always wins, so a box part-way through the migration with both set
 * behaves as the new one says. The warning goes to STDERR, never stdout: under `--json`
 * stdout carries the envelope and nothing else.
 */
export function env(name: string, fallback = ''): string {
  const value = process.env[name];
  if (value !== undefined) return value;
  if (name.startsWith(ENV_PREFIX)) {
    const legacy = LEGACY_ENV_PREFIX + name.slice(ENV_PREFIX.length);
    const legacyValue = process.env[legacy];
    if (legacyValue !== undefined) {
      if (!legacyEnvWarned.has(legacy)) {
        legacyEnvWarned.add(legacy);
        process.stderr.write(
          `${legacy} is the pre-rename name for ${name} and will stop being read; rename it.\n`,
        );
      }
      return legacyValue;
    }
  }
  return fallback;
}

/** For tests: a fresh process has warned about nothing. */
export function resetLegacyEnvWarnings(): void {
  legacyEnvWarned.clear();
}

const ENV_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  reg_token: 'HOUSTON_REG_TOKEN',
  rc_image: 'HOUSTON_RC_IMAGE',
  bind_host: 'HOUSTON_BIND_HOST',
  [KUBE_CONTEXT_KEY]: 'HOUSTON_KUBE_CONTEXT',
});

/**
 * Root state directory. RESOLVES a path; it does not create anything.
 *
 * The `mkdir` lives in the writers below (0700, because accounts and sessions live in
 * here), so a reader who trusted a "created on demand" promise would file the resulting
 * ENOENT against the wrong function.
 *
 * `pathHome()`, not `os.homedir()`: with `HOME` set but empty the home is `/.houston`, and
 * `os.homedir()` made this `.houston` in whatever directory the command ran from -- a
 * different home per working directory, and never the one earlier releases used.
 * `lib/home.ts` has the measured table.
 */
export function home(): string {
  // `HOUSTON_HOME`, or `.houston` in the home, joined component by component -- and every
  // path under it is joined the same way, with `joinPath`, never `path.join`. The raw
  // value came back here and each site `path.join`ed it, which folds `..` against the text
  // before it: `HOUSTON_HOME=link/../hh` with `link -> other/sub` is `other/hh` to the
  // kernel, and was `hh` in the working directory here, so an earlier version of this build
  // and the releases before it kept every workspace, account and setting in two different
  // directories and each claimed its own. A `HOME` holding `..` split the default home the
  // same way, and a trailing `/` or a doubled one printed where the established path has
  // neither.
  const root = env('HOUSTON_HOME');
  return root ? joinPath(root) : joinPath(pathHome(), '.houston');
}

/** What `homeId` keeps in the home, and the shape it must have to be believed. */
export const HOME_ID_FILE = 'home-id';
const HOME_ID = /^[0-9a-f]{16}$/u;

/**
 * This home's own id, made on first use and kept in the home.
 *
 * WHAT TELLS TWO HOMES APART on one Kubernetes cluster. A workspace's name, its namespace
 * and even its owner's account name are the same in two homes -- a laptop and the server,
 * or two people with no accounts -- so a namespace one home made was adopted, and deleted,
 * by the other. Random rather than derived from the host or the path, so a home keeps it
 * when either changes. A file of its own, so a 1.x reading config.yaml never sees it.
 */
export function homeId(): string {
  const file = joinPath(home(), HOME_ID_FILE);
  // '' when there is no file yet; null when one is there and holds no id.
  const read = (): string | null => {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8').trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      // Not damage, so not the remedy for it: deleting a file that only could not be read
      // would give this home a new id. A `sudo houston` that left it root's is the usual cause.
      throw new ConflictError(
        `could not read ${file}, this home's id on Kubernetes clusters (${fileErrorText(error)}) ` +
          '- fix its permissions rather than deleting it',
      );
    }
    return HOME_ID.test(text) ? text : null;
  };
  const damaged = (): never => {
    throw new ConflictError(
      `${file} does not hold this home's id (16 hex digits), and a new one would make every ` +
        "namespace this home marked read as another home's. Put the id back -- `kubectl get " +
        'namespaces -L houston.io/home` shows the ones in use -- or delete the file to start a ' +
        "new id, then claim each of this home's namespaces with `kubectl label namespace <ns> " +
        'houston.io/home=<new id> --overwrite`',
    );
  };
  const known = read();
  if (known === null) return damaged();
  if (known !== '') return known;
  mkdirParents(home(), 0o700);
  const tmp = `${file}.${String(process.pid)}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${crypto.randomBytes(8).toString('hex')}\n`, { mode: 0o600 });
  try {
    // LINKED, never renamed into place: two first commands at once must agree on ONE id,
    // and a link refuses to replace what the other one made. Renamed only where nothing is
    // there and the filesystem has no links to make.
    fs.linkSync(tmp, file);
  } catch {
    if (read() === '') fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return read() ?? damaged();
}

export function reprosDir(): string {
  return joinPath(home(), 'repros');
}

export function presetDir(): string {
  return joinPath(home(), 'presets');
}

/** Where loadtest and capacity reports are written by default. */
export function reportsDir(): string {
  return joinPath(home(), 'reports');
}

export function configFile(): string {
  return joinPath(home(), 'config.yaml');
}

/**
 * Shipped package data (`versions.yaml`, the preset catalogue, Grafana dashboards, the
 * k6 scripts, the GUI assets).
 *
 * This is the package's own data directory, found from this module, and it is the reason
 * this tree has no bundler: a bundler rewrites exactly this lookup, and `versions.ts` then
 * falls back to the live endpoint while presets report "not found" -- at runtime, in
 * production, with a green build.
 *
 * It resolves relative to the EMITTED module, walking up out of `dist/lib/` or
 * `src/lib/` to the package root. Both layouts are two directories deep, so one
 * expression serves the compiled build and `@swc/jest` alike.
 *
 * `data/` sits at the package root: the build that ships owns its data.
 */
export function dataPath(...parts: string[]): string {
  return path.join(__dirname, '..', '..', 'data', ...parts);
}

/**
 * What a person may type for a boolean setting, and what it means. Both directions are
 * listed because only one of them was ever exercised.
 *
 * Exported because `config set acme.staging` accepts exactly these words (minus the empty
 * one). It kept a literal list of its own that left out `y`, `t`, `n` and `f`, so
 * `config set acme.staging y` was refused, where it has always stored `true`.
 */
export const TRUE_WORDS: readonly string[] = Object.freeze(['1', 'true', 'yes', 'on', 'y', 't']);
export const FALSE_WORDS: readonly string[] = Object.freeze([
  '0',
  'false',
  'no',
  'off',
  'n',
  'f',
  '',
]);

/**
 * Read a remembered boolean, however it happens to be stored.
 *
 * `Boolean("false")` IS TRUE, and the same one-line coercion made
 * `config set acme.staging false` impossible to obey: `config set` wrote the raw string
 * and every reader coerced it, so turning staging ON worked while turning it OFF did
 * nothing at all. The asymmetry is what hid it -- the value people set first is the one
 * that works.
 *
 * Needed on the READ side and not only where the value is written, because every
 * config.yaml already written holds a string.
 */
export function truthy(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return Boolean(value);
  // `stripText`, not `trim()`: the two disagree both ways. `\x1ctrue` is true by the
  // established rule and was refused here, and a BOM-led `\ufefftrue` was true here and
  // is refused by it -- on the value `config set` stores and on every remembered one read back.
  const text = stripText(String(value)).toLowerCase();
  if (TRUE_WORDS.includes(text)) return true;
  if (FALSE_WORDS.includes(text)) return false;
  return fallback;
}

export type Config = Record<string, unknown>;

/**
 * The established YAML 1.1 scalar schema -- the one every existing config.yaml was written
 * and read with -- reimplemented as tag overrides for the `yaml` package.
 *
 * `config.yaml` is a shared file, and the package's schema disagrees with the established
 * one on exactly the cells a human is most likely to write by hand. Measured (the corpus
 * lives in `config.test.ts`):
 *
 *   - the package's YAML 1.1 mode resolves `y`/`Y`/`n`/`N` to booleans; the established
 *     schema reserves those for the full words only, so `y` stays a string;
 *   - the package resolves `1e5` (an exponent with no decimal point) to a float; the
 *     established float grammar requires the dot, so `1e5` stays a string;
 *   - the package resolves `-.5` to a float; the established grammar requires a digit
 *     after the leading dot, so it stays a string;
 *   - the package resolves a sexagesimal that starts with 0 (`0:00:00`) to an int;
 *     the established grammar requires the first group to start 1-9;
 *   - the package accepts a single-digit month in a bare date (`2026-9-17`);
 *     the established date-only grammar requires two.
 *
 * Each of those is a value the two schemas read differently -- a string the one writes
 * bare because it is a string to it is a boolean, a float, an int or a date to the other.
 * The fix is to make this build's resolver the established one, cell for cell, rather than
 * to remember a list of exceptions.
 *
 * The mechanism is the package's own: `customTags` as a function receives the
 * built-in 1.1 schema's tag list, so the tags whose grammar differs are dropped
 * and the established equivalents prepended. `default: true` on each makes the scalar
 * composer consider them, and the prepend makes them win over any built-in
 * survivor that would otherwise match first.
 */
/** Date-only scalars, marked so a writer can re-emit them as a date and not a timestamp. */
const yamlDates = new WeakSet<Date>();

function resolveFloat(str: string): number {
  const sign = str.startsWith('-') ? -1 : 1;
  const body = str.replace(/^[-+]/, '').replace(/_/g, '');
  const low = body.toLowerCase();
  if (low === '.inf') return sign * Infinity;
  if (low === '.nan') return NaN;
  if (body.includes(':')) {
    const [whole = '', frac] = body.split('.');
    const parts = whole.split(':').map(Number);
    let value = 0;
    for (const part of parts) value = value * 60 + part;
    return sign * (value + Number(`0.${frac ?? '0'}`));
  }
  return sign * parseFloat(body);
}

// The three float grammars the established resolver accepts, as one tag. The package's
// own EXP float (a dotless exponent) is deliberately NOT included, and neither is
// its `.e5` form: the established resolver leaves both as strings.
//
// The leading-dot branch is `\.[0-9][0-9_]*`, a DIGIT first. It was `\.[0-9_]+`, which
// took `._5` for 0.5 and `._` and `.__` for nan -- strings to the established resolver,
// which `config set bind_host ._5` therefore writes bare, so this build read a config.yaml
// an earlier release wrote as a different type and value, and its next `config set`
// rewrote the key as `0.5` or `nan`.
const YAML11_FLOAT_TEST =
  /^[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?$|^\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?$|^[-+]?(?:[0-9][0-9_]*)(?::[0-5]?[0-9])+\.[0-9_]*$|^[-+]?\.(?:inf|Inf|INF)$|^\.(?:nan|NaN|NAN)$/;

const YAML11_FLOAT: ScalarTag = {
  tag: 'tag:yaml.org,2002:float',
  default: true,
  identify: (value) => typeof value === 'number',
  test: YAML11_FLOAT_TEST,
  resolve: resolveFloat,
};

/** The established bool words. The package's 1.1 mode adds the single letters; these do not. */
const YAML11_BOOL: ScalarTag = {
  tag: 'tag:yaml.org,2002:bool',
  default: true,
  identify: (value) => typeof value === 'boolean',
  test: /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/,
  resolve: (str) => ['yes', 'Yes', 'YES', 'true', 'True', 'TRUE', 'on', 'On', 'ON'].includes(str),
};

// The established int grammars, one tag: binary, octal, decimal, hex, then
// sexagesimal. The package's sexagesimal allows a leading 0 (`0:00:00`) and its
// binary spelling differs; both are corrected here.
const YAML11_INT_TEST =
  /^[-+]?0b[0-1_]+$|^[-+]?0[0-7_]+$|^[-+]?(?:0|[1-9][0-9_]*)$|^[-+]?0x[0-9a-fA-F_]+$|^[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+$/;

const YAML11_INT: ScalarTag = {
  tag: 'tag:yaml.org,2002:int',
  default: true,
  identify: (value) => typeof value === 'number' && Number.isInteger(value),
  test: YAML11_INT_TEST,
  resolve: (str) => {
    const sign = str.startsWith('-') ? -1 : 1;
    const body = str.replace(/^[-+]/, '').replace(/_/g, '');
    if (body.includes(':')) {
      const parts = body.split(':').map(Number);
      let value = 0;
      for (const part of parts) value = value * 60 + part;
      return sign * value;
    }
    let value: number;
    if (/^0b/i.test(body)) value = sign * Number.parseInt(body.slice(2), 2);
    else if (/^0x/i.test(body)) value = sign * Number.parseInt(body.slice(2), 16);
    else if (/^0[0-7]+$/.test(body)) value = sign * Number.parseInt(body, 8);
    else value = sign * Number.parseInt(body, 10);
    // An int has no negative zero: `-0` read as -0 here, and the compose writer spelled it
    // `-0` where the established file holds `0`.
    return value === 0 ? 0 : value;
  },
};

const YAML11_STR: ScalarTag = {
  tag: 'tag:yaml.org,2002:str',
  default: true,
  identify: (value) => typeof value === 'string',
  resolve: (str) => str,
};

/**
 * The timestamp constructor's pattern, which is wider than the resolver's: a date alone may
 * have a one-digit month or day. Its `$` also matches before a final newline (`\n?$`). The
 * groups are: year, month, day, hour, minute, second, fraction, tz, tz_sign, tz_hour,
 * tz_minute.
 */
const TIMESTAMP_CONSTRUCT =
  /^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:(?:[Tt]|[ \t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\.([0-9]*))?(?:[ \t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?)?\n?$/u;

/**
 * What the writer writes for a timestamp read from this text: the ISO form, date and time
 * split by a space, of the datetime the text stands for, so naive stays naive, an offset
 * stays the offset it was written with (`Z` is `+00:00`), and a fraction is six digits or
 * none -- or null when the text is not a full timestamp.
 */
function datetimeText(text: string): string | null {
  const match = TIMESTAMP_CONSTRUCT.exec(text);
  if (match === null || match[4] === undefined) return null;
  const [, year, month, day, hour, minute, second, fraction, tz, tzSign, tzHour, tzMinute] = match;
  const pad = (value: string | number, width = 2) => String(Number(value)).padStart(width, '0');
  let out = `${pad(year ?? '', 4)}-${pad(month ?? '')}-${pad(day ?? '')} `;
  out += `${pad(hour)}:${pad(minute ?? '')}:${pad(second ?? '')}`;
  const micro =
    fraction === undefined || fraction === '' ? 0 : Number(fraction.slice(0, 6).padEnd(6, '0'));
  if (micro !== 0) out += `.${pad(micro, 6)}`;
  if (tz !== undefined) {
    const offset =
      tzSign === undefined
        ? 0
        : (Number(tzHour) * 3600 + Number(tzMinute ?? 0) * 60) * (tzSign === '-' ? -1 : 1);
    const size = Math.abs(offset);
    out += `${offset < 0 ? '-' : '+'}${pad(Math.floor(size / 3600))}:${pad(Math.floor((size % 3600) / 60))}`;
  }
  return out;
}

/**
 * Each full timestamp this build read, as the representer for datetimes writes it back. A Date is
 * an instant: a naive `10:00:00` became one in the box's zone and an offset became UTC, so a
 * rewrite of config.yaml turned `x: 2026-01-01 10:00:00` into `04:30:00Z` on a box in IST,
 * and `10:00:00.5+02:00` into `08:00:00Z` -- an unrelated key's value changed by any
 * `config set`. The file must keep what it held.
 */
const yamlStamps = new WeakMap<Date, string>();

/** The established timestamp grammar: date-only requires two-digit month and day. */
const YAML11_TIMESTAMP: ScalarTag = {
  tag: 'tag:yaml.org,2002:timestamp',
  default: true,
  identify: (value) => value instanceof Date,
  test: /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])$|^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/,
  resolve: (str) => {
    const date = new Date(str);
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) yamlDates.add(date);
    const written = datetimeText(str);
    if (written !== null) yamlStamps.set(date, written);
    return date;
  },
};

/**
 * What the representer for dates writes for a Date this build's reader made: the ISO text
 * of the date, the year to four digits, or of the datetime (a space between) as
 * `yamlStamps` recorded it. Undefined for a Date the reader did not make, which the writer
 * spells as the UTC datetime of its instant.
 */
export function yamlDateText(value: Date): string | undefined {
  if (yamlDates.has(value)) {
    const pad = (n: number, width = 2) => String(n).padStart(width, '0');
    return `${pad(value.getUTCFullYear(), 4)}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  return yamlStamps.get(value);
}

/**
 * The same grammar, resolved to the scalar's own TEXT rather than to a Date.
 *
 * For the compose document, which is read to be WRITTEN BACK: `monitor`, `env` and
 * `upgrade` edit what `readCompose` returns and re-emit it through `compose.ts`, whose
 * emitter spells a Date as an instant -- a bare `2026-01-01` would come back as
 * `"2026-01-01T00:00:00.000Z"`, a different value in the container. A date's text is also
 * exactly how the date is shown. A full timestamp's text is not always how the timestamp is
 * shown (a `t` separator, an offset, a fraction are normalised there), and only a
 * hand-edited file holds one: the writer quotes every such string.
 */
const YAML11_TIMESTAMP_TEXT: ScalarTag = { ...YAML11_TIMESTAMP, resolve: (str) => str };

/**
 * An EXPLICIT standard tag -- `!!float 3`, `!!null x`, `!!int 0o17` -- is the tag's
 * constructor applied to the text, whatever the text is: the tag's implicit grammar decides
 * only which PLAIN scalars get the tag without being told. The yaml library asks the tag's
 * `test` of an explicit one too, so every text outside the grammar was "could not
 * determine a constructor" and a JavaScript stack, where the established reader reads
 * `3.0`, null and `15` -- or refuses with the constructor's own refusal: `!!int 1e3`
 * is `'1e3' is not an integer`, `!!bool y` is
 * `'y' is not a boolean (want yes, no, true, false, on or off)`.
 *
 * So each tag has a second, `test`-less entry, which the library takes for every explicit
 * use of that tag and never for a plain scalar, running the constructor line for line. A
 * refusal is not thrown from `resolve`, where the library would turn it into a parse error
 * at the tag; it becomes the node's value, and `safeLoadYaml` raises whichever refusal
 * building the document meets first.
 */
class ConstructFailure {
  constructor(readonly error: Error) {}
}

/** A tag's refusal of its text, named `InvalidValue` as `format`'s are. */
function loaderError(message: string): Error {
  const error = new Error(message);
  error.name = 'InvalidValue';
  return error;
}

/** The first character, refused for an empty string: `!!int ''` and `!!float` bare. */
function firstChar(value: string): string {
  if (value === '') throw loaderError('an empty value is not a number');
  return value.slice(0, 1);
}

/** The `!!int` constructor: sign, `0b`, `0x`, a leading `0` for octal, sexagesimal, decimal. */
function constructInt(text: string): number {
  let value = text.replace(/_/gu, '');
  const sign = firstChar(value) === '-' ? -1 : 1;
  if ('+-'.includes(firstChar(value))) value = value.slice(1);
  let result: number;
  if (value === '0') return 0;
  if (value.startsWith('0b')) result = sign * intFromText(value.slice(2), 2);
  else if (value.startsWith('0x')) result = sign * intFromText(value.slice(2), 16);
  else if (firstChar(value) === '0') result = sign * intFromText(value, 8);
  else if (value.includes(':')) {
    const digits = value
      .split(':')
      .map((part) => intFromText(part, 10))
      .reverse();
    let base = 1;
    result = 0;
    for (const digit of digits) {
      result += digit * base;
      base *= 60;
    }
    result *= sign;
  } else result = sign * intFromText(value, 10);
  // An int has no negative zero: `!!int -0b0` is 0.
  return result === 0 ? 0 : result;
}

/** The `!!float` constructor: the float grammar is given the lowered, sign-less text. */
function constructFloat(text: string): number {
  let value = text.replace(/_/gu, '').toLowerCase();
  const sign = firstChar(value) === '-' ? -1 : 1;
  if ('+-'.includes(firstChar(value))) value = value.slice(1);
  if (value === '.inf') return sign * Infinity;
  if (value === '.nan') return NaN;
  if (value.includes(':')) {
    const digits = value
      .split(':')
      .map((part) => parseFloat_(part))
      .reverse();
    let base = 1;
    let result = 0;
    for (const digit of digits) {
      result += digit * base;
      base *= 60;
    }
    return sign * result;
  }
  return sign * parseFloat_(value);
}

/** The `!!bool` constructor's words, looked up with the text lowered. */
const YAML11_BOOL_VALUES: ReadonlyMap<string, boolean> = new Map([
  ['yes', true],
  ['no', false],
  ['true', true],
  ['false', false],
  ['on', true],
  ['off', false],
]);

function constructBool(text: string): boolean {
  const key = text.toLowerCase();
  const value = YAML11_BOOL_VALUES.get(key);
  if (value === undefined) {
    throw loaderError(
      `${quotedText(text)} is not a boolean (want yes, no, true, false, on or off)`,
    );
  }
  return value;
}

/** A calendar date's checks, in the established order and words. */
function checkDate(year: number, month: number, day: number): void {
  if (year < 1 || year > 9999) throw loaderError(`year ${String(year)} is out of range`);
  if (month < 1 || month > 12) throw loaderError('month must be in 1..12');
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] as number;
  if (day < 1 || day > days) throw loaderError('day is out of range for month');
}

/**
 * The `!!timestamp` constructor's refusals, in the established order: text that is not a
 * timestamp, then an offset of a day or more, then the date and the time.
 * Whether the text is a date alone.
 */
function checkTimestamp(text: string): boolean {
  const match = TIMESTAMP_CONSTRUCT.exec(text);
  if (match === null) {
    throw loaderError(`${quotedText(text)} is not a timestamp`);
  }
  const [, year, month, day, hour, minute, second, , , tzSign, tzHour, tzMinute] = match;
  const date = [year, month, day].map(Number) as [number, number, number];
  if (hour === undefined) {
    checkDate(...date);
    return true;
  }
  if (tzSign !== undefined) {
    const total = (Number(tzHour) * 3600 + Number(tzMinute ?? 0) * 60) * (tzSign === '-' ? -1 : 1);
    if (total <= -86400 || total >= 86400) {
      const offset = `${tzSign}${String(tzHour)}:${String(tzMinute ?? '00')}`;
      throw loaderError(`the offset ${offset} is not under 24 hours`);
    }
  }
  checkDate(...date);
  if (Number(hour) > 23) throw loaderError('hour must be in 0..23');
  if (Number(minute) > 59) throw loaderError('minute must be in 0..59');
  if (Number(second) > 59) throw loaderError('second must be in 0..59');
  return false;
}

/**
 * An explicit `!!timestamp`: a date alone is the `date` it names, however its month and day
 * are padded, and a full timestamp is what the implicit tag makes of the same text, which
 * its grammar shares. `asText` is the compose reader's variant, whose dates are their
 * `YYYY-MM-DD` text.
 */
function constructTimestamp(text: string, asText: boolean): unknown {
  const bare = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!checkTimestamp(bare)) {
    return asText
      ? YAML11_TIMESTAMP_TEXT.resolve(bare, () => undefined, {})
      : YAML11_TIMESTAMP.resolve(bare, () => undefined, {});
  }
  const [year, month, day] = bare.split('-').map(Number) as [number, number, number];
  const pad = (n: number) => String(n).padStart(2, '0');
  const shown = `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
  if (asText) return shown;
  const date = new Date(`${shown}T00:00:00Z`);
  yamlDates.add(date);
  return date;
}

/** The `test`-less twin of a standard tag, for its explicit uses. */
function explicitTag(tag: string, construct: (text: string) => unknown): ScalarTag {
  return {
    tag,
    resolve: (text) => {
      try {
        return construct(text);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        return new YAML.Scalar(new ConstructFailure(failure));
      }
    },
  };
}

const YAML11_EXPLICIT: readonly ScalarTag[] = [
  explicitTag('tag:yaml.org,2002:null', () => null),
  explicitTag('tag:yaml.org,2002:bool', constructBool),
  explicitTag('tag:yaml.org,2002:int', constructInt),
  explicitTag('tag:yaml.org,2002:float', constructFloat),
];

const YAML11_TIMESTAMP_EXPLICIT = explicitTag('tag:yaml.org,2002:timestamp', (text) =>
  constructTimestamp(text, false),
);

const YAML11_TIMESTAMP_EXPLICIT_TEXT = explicitTag('tag:yaml.org,2002:timestamp', (text) =>
  constructTimestamp(text, true),
);

const YAML11_DROPPED = new Set([
  'tag:yaml.org,2002:float',
  'tag:yaml.org,2002:bool',
  'tag:yaml.org,2002:int',
  'tag:yaml.org,2002:timestamp',
  'tag:yaml.org,2002:str',
]);

/** The tag list with the five grammars that differ from the established ones swapped in. */
function yaml11Tags(tags: Tags): Tags {
  return [
    YAML11_BOOL,
    YAML11_INT,
    YAML11_FLOAT,
    YAML11_TIMESTAMP,
    YAML11_STR,
    ...tags.filter((tag) => typeof tag !== 'string' && !YAML11_DROPPED.has((tag as ScalarTag).tag)),
    // Last, and harmless there: the library returns the first `test`-less tag of an
    // explicit tag's name wherever it sits, and never considers one for a plain scalar.
    ...YAML11_EXPLICIT,
    YAML11_TIMESTAMP_EXPLICIT,
  ];
}

/**
 * The PARSER's options: the established safe grammar, for every YAML file houston reads.
 * Nothing here is written with the package's emitter: config.yaml and a workspace's
 * compose file are written by `yaml-dump.ts`'s `safeDump`.
 */
export const YAML11_OPTIONS = {
  version: '1.1' as const,
  // A doubled key keeps its last value; the yaml library's default refused the file, and
  // every command that read config.yaml ended with a stack.
  uniqueKeys: false,
  // No alias budget: the established reader has none, and the yaml library's default of
  // 100 refused a document with a hundred references to one anchor.
  maxAliasCount: -1,
  customTags: yaml11Tags,
  // No warnings on stderr: the established loader prints none. `toJS` warned through
  // `process.emitWarning` for a key a plain object cannot hold -- a hand-written
  // `2026-01-01: note` in config.yaml added two `(node:<pid>) Warning: Keys with collection
  // values will be stringified` lines, with a pid and a local-time date in them, to every
  // command that read the file. `error` silences only that; every refusal
  // still stands (`silent` would also have dropped the MULTIPLE_DOCS one).
  logLevel: 'error' as const,
};

/** `YAML11_OPTIONS` with timestamps kept as their text: see `YAML11_TIMESTAMP_TEXT`. */
const YAML11_TEXT_TIMESTAMP_OPTIONS = {
  ...YAML11_OPTIONS,
  customTags: (tags: Tags): Tags =>
    yaml11Tags(tags).map((tag) =>
      tag === YAML11_TIMESTAMP
        ? YAML11_TIMESTAMP_TEXT
        : tag === YAML11_TIMESTAMP_EXPLICIT
          ? YAML11_TIMESTAMP_EXPLICIT_TEXT
          : tag,
    ),
};

/** Whether a value is a date-only scalar this build's resolver produced. */
export function isYamlDate(value: unknown): value is Date {
  return value instanceof Date && yamlDates.has(value);
}

/**
 * Parse one document of YAML 1.1 with the established safe grammar.
 *
 * The compose document is read by the same grammar (`record.ts`'s `readCompose`), with
 * its timestamps kept as text; it is written by `compose.ts`'s own emitter.
 */
export function parseConfigYaml(text: string): unknown {
  return safeLoadYaml(text);
}

/**
 * `text` read with the established safe grammar, refusals included: a tag the safe loader
 * has no constructor for is refused, where the yaml library only warns -- on
 * stderr, as a Node warning -- and reads the value as a plain string, so a user preset
 * `name: !foo bar` was a preset called `bar`, where it is UNREADABLE. The message is the
 * established one, its mark and snippet drawn as they always have been.
 *
 * `timestampsAsText` resolves a timestamp to its text instead of a Date, for a document that
 * is written back through an emitter that would spell the Date differently.
 */
export function safeLoadYaml(
  text: string,
  { mapAsMap = false, timestampsAsText = false } = {},
): unknown {
  return safeLoadDocument(text, timestampsAsText).toJS({ maxAliasCount: -1, mapAsMap });
}

/**
 * The document with every type it holds kept, where `safeLoadYaml` is what JavaScript can:
 * every mapping a `Map` with its keys as typed, an integral float a `JsonFloat`, an int past
 * 2**53 a `bigint`, a date or timestamp the Date `yamlDateText` spells (`constructNode`).
 * For a reader that writes a value out in its displayed form -- a user preset's env, which
 * `compose.ts` writes through `toTextYaml`.
 */
export function safeLoadConstructed(text: string): unknown {
  return constructNode(safeLoadDocument(text));
}

/** `safeLoadYaml`'s document, parsed and checked for every refusal the safe loader makes. */
function safeLoadDocument(text: string, timestampsAsText = false): YAML.Document {
  const doc = YAML.parseDocument(
    text,
    timestampsAsText ? YAML11_TEXT_TIMESTAMP_OPTIONS : YAML11_OPTIONS,
  );
  const [failure] = doc.errors;
  if (failure !== undefined) throw failure;
  const refused = firstConstructionFailure(doc, text);
  if (refused !== null) throw refused;
  return doc;
}

/** A node as the constructor receives it: an alias is the node it names. */
function constructed(doc: YAML.Document, node: unknown): unknown {
  return YAML.isAlias(node) ? node.resolve(doc) : node;
}

/** Whether a mapping key is the merge key `<<`, which merging removes. */
function isMergeKey(key: unknown): boolean {
  return YAML.isScalar(key) && typeof key.value === 'symbol' && key.value.description === '<<';
}

/**
 * A mapping's key and value nodes as the constructor visits them: merges first, which
 * put every merged mapping's items ahead of the mapping's own, a list of merges in
 * reverse.
 */
function mappingItems(doc: YAML.Document, map: YAML.YAMLMap): unknown[] {
  const merged: unknown[] = [];
  const own: unknown[] = [];
  for (const pair of map.items) {
    if (!isMergeKey(pair.key)) {
      own.push(pair.key, pair.value);
      continue;
    }
    const source = constructed(doc, pair.value);
    if (YAML.isMap(source)) merged.push(...mappingItems(doc, source));
    else if (YAML.isSeq(source)) {
      const each = source.items.map((item) => {
        const one = constructed(doc, item);
        return YAML.isMap(one) ? mappingItems(doc, one) : [];
      });
      for (const items of each.reverse()) merged.push(...items);
    }
  }
  return [...merged, ...own];
}

/**
 * A key as the established mapping compares it: `True` is `1` and `False` is `0` (so `1: a`
 * then `true: c` is one key, `1`, holding `c`), a number is its value (`1.0` is `1`, `-0.0`
 * is `0`, and every `.nan` is one key), a date or datetime its text, bytes their contents.
 * Two aware datetimes at one instant in different offsets are equal by that rule and not
 * here; nothing writes one.
 */
function keyIdentity(key: unknown): unknown {
  if (typeof key === 'boolean') return Number(key);
  if (key instanceof JsonFloat) return key.value;
  if (key instanceof Date) return Symbol.for(`timestamp ${yamlDateText(key) ?? key.getTime()}`);
  if (key instanceof Uint8Array) return Symbol.for(`bytes ${Buffer.from(key).toString('base64')}`);
  return key;
}

/** Each pair set into a mapping that keeps the key it first saw. */
function fillDict(out: Map<unknown, unknown>, pairs: readonly (readonly [unknown, unknown])[]) {
  const held = new Map<unknown, unknown>();
  for (const [key, value] of pairs) {
    const identity = keyIdentity(key);
    if (!held.has(identity)) held.set(identity, key);
    out.set(held.get(identity), value);
  }
}

/**
 * Whether a scalar is a float the `!!float` constructor built that a number cannot say is one:
 * an integral value (`1.0`, `3.0`, `-0.0`), resolved by the float grammar or tagged
 * `!!float`. The int and float grammars are disjoint -- a float has a dot -- so the grammar
 * alone tells a plain `3.0` from a plain `3`.
 */
function isIntegralFloat(node: YAML.Scalar): node is YAML.Scalar<number> {
  if (typeof node.value !== 'number' || !Number.isInteger(node.value)) return false;
  if (node.tag !== undefined) return node.tag === 'tag:yaml.org,2002:float';
  return node.type === 'PLAIN' && YAML11_FLOAT_TEST.test(node.source ?? '');
}

/**
 * The `!!int` constructor in exact integers, for an int a double cannot hold: past 2**53,
 * `12345678901234567890` read as `12345678901234567000`. Undefined when the scalar is not
 * such an int, or its text is one `BigInt` does not take (the double then stands).
 */
function exactInt(node: YAML.Scalar): bigint | undefined {
  if (typeof node.value !== 'number' || !Number.isInteger(node.value)) return undefined;
  if (Number.isSafeInteger(node.value)) return undefined;
  const tagged = node.tag !== undefined;
  if (tagged ? node.tag !== 'tag:yaml.org,2002:int' : node.type !== 'PLAIN') return undefined;
  const text = node.source ?? '';
  if (!tagged && !YAML11_INT_TEST.test(text)) return undefined;
  try {
    let value = text.replace(/_/gu, '');
    const sign = value.startsWith('-') ? -1n : 1n;
    if (value.startsWith('-') || value.startsWith('+')) value = value.slice(1);
    if (value.startsWith('0b')) return sign * BigInt(`0b${value.slice(2)}`);
    if (value.startsWith('0x')) return sign * BigInt(`0x${value.slice(2)}`);
    if (value.startsWith('0')) return sign * BigInt(`0o${value.slice(1)}`);
    if (value.includes(':')) {
      let result = 0n;
      for (const part of value.split(':')) result = result * 60n + BigInt(part);
      return sign * result;
    }
    return sign * BigInt(value);
  } catch {
    return undefined;
  }
}

/**
 * The document as the safe constructor builds it, where `toJS` builds what JavaScript can
 * hold: a mapping is a `Map` with its keys as they were typed, in the order they were met;
 * a `!!set` is a `Set`; an `!!omap` or `!!pairs` is a list of `[key, value]` pairs, as
 * the established reader makes it; a node named twice is one value. Only `saveConfig`
 * reads it, to write config.yaml back as it has always been written.
 *
 * An integral float is a `JsonFloat`, key or value. It was the number, which the writer
 * spells as an int: a hand-edited `custom_float: 1.0`, `ratio: 3.0` or `3.0: x` came back
 * from any `config set`, `use`, `up --pin`, `down --volumes` or `prune` as `1`, `3` and
 * `3: x`, where `updateConfig` must write back the float it read. A `-0.0` key was worse off:
 * a `Map` keeps -0 as 0. An int past 2**53 is a `bigint`, the digits it was written with,
 * where the double rounded them.
 */
function constructNode(doc: YAML.Document): unknown {
  const made = new Map<unknown, unknown>();
  const build = (raw: unknown): unknown => {
    const node = constructed(doc, raw);
    if (node === null || node === undefined) return null;
    if (made.has(node)) return made.get(node);
    if (YAML.isScalar(node)) {
      const value = isIntegralFloat(node)
        ? new JsonFloat(node.value)
        : (exactInt(node) ?? (node.value as unknown));
      made.set(node, value);
      return value;
    }
    if (YAML.isMap(node)) {
      const pairs: [unknown, unknown][] = [];
      const items = mappingItems(doc, node);
      if (node.tag === 'tag:yaml.org,2002:set') {
        const out = new Set<unknown>();
        made.set(node, out);
        for (let at = 0; at < items.length; at += 2) pairs.push([build(items[at]), null]);
        const members = new Map<unknown, unknown>();
        fillDict(members, pairs);
        for (const member of members.keys()) out.add(member);
        return out;
      }
      const out = new Map<unknown, unknown>();
      made.set(node, out);
      for (let at = 0; at < items.length; at += 2) {
        pairs.push([build(items[at]), build(items[at + 1])]);
      }
      fillDict(out, pairs);
      return out;
    }
    if (YAML.isSeq(node)) {
      const out: unknown[] = [];
      made.set(node, out);
      const tuples =
        node.tag === 'tag:yaml.org,2002:omap' || node.tag === 'tag:yaml.org,2002:pairs';
      for (const item of node.items) {
        if (!YAML.isPair(item)) out.push(build(item));
        else if (tuples) out.push([build(item.key), build(item.value)]);
        else out.push(new Map([[build(item.key), build(item.value)]]));
      }
      return out;
    }
    return null;
  };
  return build(doc.contents);
}

/**
 * The document behind each object `loadConfig` handed out: the top-level mapping as
 * `constructNode` built it, and a fingerprint of each property as it was read, so a rewrite
 * can tell which ones a command changed.
 */
const yamlDocuments = new WeakMap<
  object,
  { items: Map<unknown, unknown>; read: Map<string, string> }
>();

/** A value's identity for `rewriteScalars`: its dump, which changes when anything inside it does. */
function fingerprint(value: unknown): string {
  return safeDump(value, { dateText: yamlDateText });
}

/**
 * The mapping to write after a command changed `cfg`: the mapping the loader built, with
 * each property the command set written in its place, each it deleted left out, and each
 * it added at the end, in the order it added them.
 *
 * `loadConfig` hands out a plain object, and a plain object cannot hold what the mapping held:
 * its keys are strings (`1: a`, `~: b`, `true: c` became `'1'`, `''` and `'true'`), it lists
 * an integer-like key first (`'10'` and `'2'` moved ahead of `bind_host`), and `toJS` made
 * an `!!omap` a Map, written back as a mapping where it belongs as a list of pairs. Any
 * `config set`, `config unset` or `use` rewrote a hand-edited config.yaml in those shapes,
 * where it must be rewritten as it was read. So what a command did not touch is written
 * from the mapping, and what it did from the object. A key that is not a string is one no
 * command can name, and keeps its value.
 */
function rewriteScalars(cfg: unknown): unknown {
  const document = typeof cfg === 'object' && cfg !== null ? yamlDocuments.get(cfg) : undefined;
  if (document === undefined) return cfg;
  const now = cfg as Config;
  const unchanged = (key: string) => document.read.get(key) === fingerprint(now[key]);
  const out = new Map<unknown, unknown>();
  const named = new Set<string>();
  for (const [key, value] of document.items) {
    if (typeof key !== 'string') {
      out.set(key, value);
      continue;
    }
    named.add(key);
    if (Object.hasOwn(now, key)) out.set(key, unchanged(key) ? value : now[key]);
  }
  for (const key of Object.keys(now)) {
    // A property standing for a key that is not a string (`'1'` for `1`) is skipped while
    // it is as it was read: the key itself is already written.
    if (named.has(key) || (document.read.has(key) && unchanged(key))) continue;
    out.set(key, now[key]);
  }
  return out;
}

/**
 * What the safe loader raises while CONSTRUCTING, in the order it would meet it: a tag with
 * no constructor (`constructorError`) or a constructor's own refusal (`ConstructFailure`).
 *
 * Building the document fills a mapping or a sequence only after its parent is done, so a
 * collection's scalars come after every scalar of the collection
 * holding it: in `a: [!!int x]` then `b: !!int y` the established reader reports `'y'`.
 * The first-warning rule this replaces was document order, which reported `'x'`. A node is
 * built once, however many aliases name it.
 *
 * An unresolved tag's warning is placed at its tag, the node at its content: the node a
 * warning belongs to is the first, in document order, that starts at or after the tag ends.
 */
function firstConstructionFailure(doc: YAML.Document, text: string): Error | null {
  const nodes: YAML.Node[] = [];
  YAML.visit(doc, {
    Node: (_key, node) => {
      nodes.push(node);
    },
  });
  const owners = new Map<unknown, YAML.YAMLWarning>();
  const orphans: YAML.YAMLWarning[] = [];
  for (const warning of doc.warnings) {
    if (warning.code !== 'TAG_RESOLVE_FAILED') continue;
    const owner = nodes.find((node) => (node.range?.[0] ?? -1) >= warning.pos[1]);
    if (owner === undefined || owners.has(owner)) orphans.push(warning);
    else owners.set(owner, warning);
  }
  const built = new Set<unknown>();
  const pending: (YAML.YAMLMap | YAML.YAMLSeq)[] = [];
  const build = (raw: unknown): Error | null => {
    const node = constructed(doc, raw);
    if (node === null || node === undefined || built.has(node)) return null;
    built.add(node);
    const warning = owners.get(node);
    if (warning !== undefined) return constructorError(text, warning);
    if (YAML.isScalar(node) && node.value instanceof ConstructFailure) return node.value.error;
    if (YAML.isMap(node) || YAML.isSeq(node)) pending.push(node);
    return null;
  };
  let failure = build(doc.contents);
  for (let next = 0; failure === null && next < pending.length; next += 1) {
    const collection = pending[next] as YAML.YAMLMap | YAML.YAMLSeq;
    const children = YAML.isMap(collection)
      ? mappingItems(doc, collection)
      : collection.items.flatMap((item) => (YAML.isPair(item) ? [item.key, item.value] : [item]));
    for (const child of children) {
      failure = build(child);
      if (failure !== null) break;
    }
  }
  if (failure !== null) return failure;
  // Nothing the walk reached: an unresolved tag it could not place is still refused, as
  // the first-warning rule refused it, and so is a refusal in a node it never visited.
  const [orphan] = orphans;
  if (orphan !== undefined) return constructorError(text, orphan);
  const stray = nodes.find((node) => YAML.isScalar(node) && node.value instanceof ConstructFailure);
  return stray === undefined ? null : ((stray as YAML.Scalar).value as ConstructFailure).error;
}

function constructorError(text: string, warning: YAML.YAMLWarning): Error {
  const tag = /Unresolved tag: (\S+)/u.exec(warning.message)?.[1] ?? '';
  const pointer = warning.pos[0];
  const breaks = '\0\r\n\u0085\u2028\u2029';
  let start = pointer;
  let head = '';
  while (start > 0 && !breaks.includes(text[start - 1] as string)) {
    start -= 1;
    if (pointer - start > 75 / 2 - 1) {
      head = ' ... ';
      start += 5;
      break;
    }
  }
  let end = pointer;
  let tail = '';
  while (end < text.length && !breaks.includes(text[end] as string)) {
    end += 1;
    if (end - pointer > 75 / 2 - 1) {
      tail = ' ... ';
      end -= 5;
      break;
    }
  }
  const before = text.slice(0, pointer);
  const line = (before.match(/\r\n|[\n\r\u0085\u2028\u2029]/gu) ?? []).length + 1;
  const lineStart = Math.max(...[...breaks].map((mark) => before.lastIndexOf(mark))) + 1;
  const column = pointer - lineStart + 1;
  const snippet =
    `    ${head}${text.slice(start, end)}${tail}\n` +
    `${' '.repeat(4 + pointer - start + head.length)}^`;
  const error = new Error(
    `could not determine a constructor for the tag ${tag.includes("'") && !tag.includes('"') ? `"${tag}"` : `'${tag}'`}\n` +
      `  at line ${String(line)}, column ${String(column)}:\n${snippet}`,
  );
  error.name = 'YamlTagError';
  return error;
}

/**
 * config.yaml's text, in block style with its keys in their own order, through
 * `yaml-dump.ts`'s emitter.
 *
 * It was the `yaml` package's emitter with options and tags shaped to match, which closed
 * the scalar choices one at a time and could not close the rest: a double-quoted value was
 * never folded at the 80th column and spelled `a\ \nb` where the established file holds
 * `"a \nb"`; a value holding a single quote was double-quoted where the established
 * emitter doubles the quote, `'''q'''`, and `...` and `---` were written bare; a list under
 * a key was indented and an anchor named `&a1` where the established file holds `- a` at
 * the key's column and `&id001`; and a plain scalar folded a word earlier. Each read back
 * to the same value, and each made any `config set` or `use` rewrite the lines an earlier
 * release had written. The scalar representers this replaces -- a float's `.nan` and
 * `1.0e-07`, the quoted `=` and `<<`, the escapes of non-ASCII -- are `yaml-dump.ts`'s own
 * behaviour; a Date is written as the reader recorded it (`yamlDateText`).
 */
export function stringifyConfigYaml(value: unknown): string {
  return safeDump(rewriteScalars(value), { dateText: yamlDateText });
}

/**
 * A document `safeLoadYaml` read and a command edited, written through `yaml-dump.ts`'s
 * emitter with its keys in their own order: a Date the reader made is written back as the
 * text it was read from. For a file that is not config.yaml -- a Kubernetes workspace's
 * `values.yaml`.
 */
export function safeDumpYaml(value: unknown): string {
  return safeDump(value, { dateText: yamlDateText });
}

/** Whether a loaded YAML value is a mapping: an object of no other kind than `{}`. */
function isPlainMapping(value: unknown): value is Config {
  if (value === null || typeof value !== 'object') return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Load `~/.houston/config.yaml` (or `{}`), with env-var overrides applied.
 *
 * Pass `withEnv: false` when the object will be written back through `saveConfig` --
 * otherwise ephemeral env values (notably `HOUSTON_REG_TOKEN`) would be persisted into
 * the file.
 */
export function loadConfig(withEnv = true): Config {
  const file = configFile();
  let data: Config = {};
  if (fs.existsSync(file)) {
    const doc = safeLoadDocument(fs.readFileSync(file, 'utf8'));
    const loaded: unknown = doc.toJS({ maxAliasCount: -1 });
    // A MAPPING, which the loader builds as a plain object. Any object that was not an
    // array passed, so a whole document that is a timestamp, a
    // `!!set`, an `!!omap` or `!!binary` became the Date, Set, Map or Uint8Array the next
    // write set the key on as a property -- which the emitter drops, so `config set` and
    // `use` reported success and stored nothing, and the file was rewritten as the same
    // non-mapping. Anything else now starts from `{}`, and the write stores the one key.
    if (isPlainMapping(loaded)) {
      data = loaded;
      const items = constructNode(doc);
      if (items instanceof Map) {
        const read = new Map(Object.keys(data).map((key) => [key, fingerprint(data[key])]));
        yamlDocuments.set(data, { items, read });
      }
    }
  }
  if (withEnv) {
    for (const [key, name] of Object.entries(ENV_OVERRIDES)) {
      const value = env(name);
      if (value) data[key] = value;
    }
  }
  return data;
}

/**
 * Persist config.yaml atomically (temp file + rename).
 *
 * A plain write could be read half-written -- the web GUI runs service calls
 * concurrently, so concurrent readers are real.
 */
export function saveConfig(cfg: Config): void {
  // 0700 ON CREATE, so a box that never runs `serve` is not left depending on the
  // umask. This directory also holds the audit log, the accounts file and the ACME
  // material. config.yaml itself holds no secret, so this is depth rather than a fix. On
  // the home ALONE: a parent it makes takes the umask's mode.
  mkdirParents(home(), 0o700);
  const file = configFile();
  const tmp = joinPath(
    path.dirname(file),
    `${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    // 0600 via an explicit mode rather than the default, which would take the umask.
    fs.writeFileSync(tmp, stringifyConfigYaml(cfg), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // no-op after a successful rename
    }
  }
}

/**
 * Read-modify-write config.yaml; `mutate(cfg)` edits in place.
 *
 * Reads with env overrides OFF on purpose: this writes the file back, and an ephemeral
 * `HOUSTON_REG_TOKEN` must never be persisted into it.
 */
export function updateConfig(mutate: (cfg: Config) => void): Config {
  const cfg = loadConfig(false);
  mutate(cfg);
  saveConfig(cfg);
  return cfg;
}

/** Accounts this box has been told it may spend in. Empty by default. */
export function approvedAwsAccounts(): Set<string> {
  const raw = String(loadConfig()[CLOUD_ACCOUNTS_KEY] ?? '');
  return new Set(
    raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

/**
 * The box's default `--context`, or "".
 *
 * ONE reader, because three callers need the same answer and disagreeing is a real
 * failure rather than an untidiness: `up` decides where a workspace goes, the capacity
 * preflight decides whose RAM to reserve, and `doctor` reports on a cluster. A default
 * honoured by two of the three makes `doctor` a second opinion about the boot.
 */
export function defaultKubeContext(): string {
  return String(loadConfig()[KUBE_CONTEXT_KEY] ?? '').trim();
}
