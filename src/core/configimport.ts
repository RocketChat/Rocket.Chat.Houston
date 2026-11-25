/**
 * Apply a customer's exported settings to a repro.
 *
 * Rocket.Chat support dumps contain a `*-settings.json`: a flat list of
 * `{_id, value, packageValue, ...}` for every setting (~1000). To reproduce a customer's
 * config we import only what they actually CHANGED (value != default), minus secrets the dump
 * redacts and a deny-list of settings that are identity- or environment-specific and would
 * break/pollute a local repro.
 *
 * Bypasses nothing dangerous: settings are applied through the same 2FA-guarded REST
 * endpoint the admin UI uses.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../lib/config';
import { ValidationError } from '../lib/errors';
import { decodeUtf8Strict } from '../lib/format';
import { JsonSyntaxError, JsonFloat, JsonNumber, loads, spelled } from '../lib/json-text';

import * as journal from './journal';
import { type Auth, addOauthService, getSetting, setSetting } from './rcapi';

type Bag = Record<string, unknown>;
type Log = (message: string) => void;

/**
 * Values a support dump uses to mask a secret it will not export.
 *
 * 4+ repeats of ONE character, via a backreference. A character class matched any MIXTURE
 * instead ("x.x.x.x", "*.*.*.*", "Xx.#*"), and "." inside `[...]` is a literal dot, so a
 * legitimate dotted value was classified as a masked secret: silently dropped from the
 * import AND reported to the operator as "the dump masked this". Case-insensitive so
 * "xxxx" still matches.
 */
const REDACTED_RE = /^([X*•·●▪#])\1{3,}$/iu;

/**
 * Never import these -- they identify the customer's specific install or would break local
 * access. Exact ids, plus the id-prefixes below.
 */
const DENY: ReadonlySet<string> = new Set([
  'Site_Url', // breaks localhost access to the repro
  'Enterprise_License', // their license; invalid here, legally theirs
  'Enterprise_License_Status',
  'Deployment_FingerPrint_Hash', // identity of their deployment
  'Deployment_FingerPrint_Verified',
  'uniqueID',
  'Update_LatestAvailableVersion', // cloud-reported, not a real preference
  'Register_Server', // would try to register the repro to cloud
  'Show_Setup_Wizard', // controls the repro's own onboarding state
  'Country',
  'Industry',
  'Size', // org-profile telemetry, not behaviour
]);

const DENY_PREFIX: readonly string[] = ['Assets_', 'Cloud_', 'Statistics_', 'Deployment_'];

/**
 * The provider name is the segment after "Custom-".
 *
 * RC uses "-" as the setting-id separator, so custom-provider names never contain a hyphen
 * (they use "_", e.g. Ms_entra_id) -- `[^-]+` captures the whole name.
 */
const OAUTH_RE = /^Accounts_OAuth_Custom-([^-]+)/u;

const RATE_LIMITER = 'API_Enable_Rate_Limiter';

/** "the dump does not set this" -- distinct from a value of null/false. */
const UNSET = Symbol('unset');

export interface Plan {
  /** `(id, value)` */
  readonly apply: [string, unknown][];
  readonly redacted: string[];
  readonly denied: string[];
  /** provider names to pre-create */
  oauthServices: string[];
}

export function emptyPlan(): Plan {
  return { apply: [], redacted: [], denied: [], oauthServices: [] };
}

function denied(sid: string): boolean {
  return DENY.has(sid) || DENY_PREFIX.some((prefix) => sid.startsWith(prefix));
}

export function isRedacted(value: unknown): boolean {
  return typeof value === 'string' && REDACTED_RE.test(value.trim());
}

export interface BuildPlanOptions {
  /** Filter to ids whose prefix (before the first '_') matches, e.g. {'Livechat', 'LDAP'}. */
  readonly only?: ReadonlySet<string> | null;
}

/** Parse a dump's settings list into an import plan. */
export function buildPlan(settingsJson: string, options: BuildPlanOptions = {}): Plan {
  const only = options.only ?? null;
  // A CUSTOMER DUMP IS EXACTLY THE FILE THAT ARRIVES WRONG -- truncated by a download, HTML
  // from an expired share link, or the whole support bundle instead of the settings file
  // inside it. A raw decoder error is not a ReproError: the CLI printed a stack trace and the
  // web layer answered 500, where every other bad input in this path says what is wrong
  // with the file.
  //
  // A STRICT UTF-8 decode, with CRLF and lone CR read as LF. Node's 'utf8' read turns a
  // byte that is not UTF-8 into U+FFFD and carries on, so the whole support bundle passed
  // in place of the settings file inside it -- a zip -- or a UTF-16 export was "not valid
  // JSON (line 1, column 1: Expecting value)" here, where the right answer names the
  // decoding error that says what the file is, and a dump holding one stray byte was
  // APPLIED with a U+FFFD in its value. The decode keeps a BOM, which is `loads`'s to
  // refuse; and a text read turns CRLF and a lone CR into LF, so a fault in a CR-only file
  // is on the line it has always been reported on.
  const raw = decodeUtf8Strict(fs.readFileSync(settingsJson), path.basename(settingsJson)).replace(
    /\r\n?/gu,
    '\n',
  );
  let data: unknown;
  try {
    data = loads(raw);
  } catch (error) {
    if (!(error instanceof JsonSyntaxError)) throw error;
    throw new Error(
      `${path.basename(settingsJson)} is not valid JSON (line ${String(error.lineno)}, column ` +
        `${String(error.colno)}: ${error.msg}). A Rocket.Chat support dump's ` +
        `*-settings.json is a JSON array; if this came from a browser it may ` +
        `be an HTML error page.`,
      { cause: error },
    );
  }
  if (!Array.isArray(data)) {
    throw new Error('expected a list of settings (a Rocket.Chat *-settings.json)');
  }

  const plan = emptyPlan();
  const services = new Set<string>();
  for (const it of data as unknown[]) {
    // Be tolerant of a hand-edited / truncated dump: skip anything that is not a
    // {_id: string, value: ...} entry rather than crashing the import.
    if (it === null || typeof it !== 'object' || Array.isArray(it)) continue;
    const entry = it as Bag;
    const sid = entry._id;
    if (typeof sid !== 'string' || sid === '' || !('value' in entry)) continue;
    // Unchanged-from-default. With no packageValue we cannot tell, so skip rather than
    // import a setting that may just be sitting at its default.
    if (
      !('packageValue' in entry) ||
      sameValue(spelled(entry, 'value'), spelled(entry, 'packageValue'))
    )
      continue;
    // PREFIXES, as `--only` says it takes. Compared with the id's first `_` segment, so
    // `--only Message_` (the spelling the help invites) matched no setting at all.
    if (only !== null && only.size > 0 && ![...only].some((prefix) => sid.startsWith(prefix))) {
      continue;
    }
    if (isRedacted(entry.value)) {
      plan.redacted.push(sid);
      continue;
    }
    if (denied(sid)) {
      plan.denied.push(sid);
      continue;
    }
    const m = OAUTH_RE.exec(sid);
    if (m !== null) services.add(m[1] as string);
    // The value as `loads` holds it. Copied out of the entry, a double lost what `loads`
    // keeps beside the entry, so a dump's `5.0`, `-0.0` and `1e+16` were planned, printed and
    // SENT as `5`, `0` and `10000000000000000` -- and `-0.0` stored as `0`; an int past
    // 2**53 was sent rounded. A value nested in a list or object needs nothing: it is the
    // container `loads` built.
    plan.apply.push([sid, spelled(entry, 'value')]);
  }
  plan.oauthServices = [...services].sort();
  // SAID, not imported-zero-and-exit-0: a filter that matched nothing is usually a typo.
  if (
    only !== null &&
    only.size > 0 &&
    plan.apply.length + plan.redacted.length + plan.denied.length === 0
  ) {
    throw new ValidationError(
      `--only ${[...only].join(',')} matched no setting this dump changes from its default`,
    );
  }
  return plan;
}

/**
 * Equality for the values a settings dump holds.
 *
 * A setting's `value` against its `packageValue` compares JSON scalars, lists and objects
 * BY VALUE; `===` compares objects by identity, so every list- or object-valued setting
 * sitting at its default would have been imported as a change. Structural, and
 * order-sensitive for a list.
 *
 * Over the values as `loads` holds them (`spelled`), members included: an integer is exact
 * at any size, and an integer against a float compares exactly, so `12345678901234567890`
 * against a default of `12345678901234567891` is a change -- which, both rounding to one
 * double, was dropped from the plan here.
 */
function sameValue(a: unknown, b: unknown): boolean {
  const x = exactNumber(a);
  const y = exactNumber(b);
  if (x !== undefined && y !== undefined) return sameNumber(x, y);
  if (a === b) return true;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    // `1` equals `true` and `1` equals `1.0` here, as they always have; JavaScript's `===`
    // says false for the first. A dump holding `1` against a default of `true` was a change
    // under `===` and not in the established plan, so the coercion is reproduced rather than
    // tightened.
    return Number(x ?? a) === Number(y ?? b);
  }
  // A number against anything but a number or a bool is unequal, a spelled one included.
  if (x !== undefined || y !== undefined) return false;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length &&
      a.every((_item, i) => sameValue(spelled(a, String(i)), spelled(b, String(i))))
    );
  }
  const left = a as Bag;
  const right = b as Bag;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((k) => k in right && sameValue(spelled(left, k), spelled(right, k)));
}

/** A dump's number held exactly: a double, or an integer past 2**53 as a bigint. */
function exactNumber(value: unknown): number | bigint | undefined {
  if (typeof value === 'number') return value;
  if (value instanceof JsonFloat) return value.value;
  if (value instanceof JsonNumber) {
    return /^-?\d+$/u.test(value.spelling) ? BigInt(value.spelling) : value.value;
  }
  return undefined;
}

/** Numbers compared exactly: a float equals an integer only when it IS that integer. */
function sameNumber(x: number | bigint, y: number | bigint): boolean {
  if (typeof x === typeof y) return x === y;
  const [whole, double] = (typeof x === 'bigint' ? [x, y] : [y, x]) as [bigint, number];
  return Number.isInteger(double) && BigInt(double) === whole;
}

/** Create custom providers first, then apply non-limiter settings. */
async function applySettings(
  rootUrl: string,
  admin: Auth,
  pw: string,
  plan: Plan,
  failures: string[],
  log: Log,
): Promise<number> {
  let applied = 0;
  // Custom OAuth providers' settings do not exist until the provider is created -- do that
  // first so its Accounts_OAuth_Custom-*-* PATCHes land.
  for (const name of plan.oauthServices) {
    const refused = await addOauthService(rootUrl, admin, pw, name);
    log(
      refused === null
        ? `  created custom OAuth provider: ${name}`
        : `  could not create custom OAuth provider ${name}: ${refused}`,
    );
  }
  // Apply everything except the limiter (handled last, in finally) so a dump that
  // re-enables it mid-run cannot throttle the rest of the import.
  for (const [sid, value] of plan.apply) {
    if (sid === RATE_LIMITER) continue;
    if (await setSetting(rootUrl, admin, pw, sid, value)) applied += 1;
    else failures.push(sid);
  }
  return applied;
}

/** Read and, when enabled, journal and disable the bulk API limiter. */
async function disableLimiter(
  rootUrl: string,
  admin: Auth,
  pw: string,
  workspace: string,
): Promise<{ limiterPrev: unknown; limiterNote: string }> {
  // `=== true`, not `!== false`: an UNREADABLE setting must not be treated as "was on" and
  // forced on afterwards -- the rule `seed/apply` states explicitly and both files were
  // breaking here.
  const limiterPrev = await getSetting(rootUrl, admin, pw, RATE_LIMITER);
  let limiterNote = '';
  if (limiterPrev === true) {
    // JOURNALLED. The `finally` below is the only thing that restores this, and it is the
    // block a SIGKILL does not run -- so an interrupted import left the rate limiter off
    // with nothing on disk saying so.
    if (workspace !== '')
      limiterNote = journal.record(journal.RATE_LIMITER_OFF, workspace, {
        purpose: 'a settings import',
      });
    await setSetting(rootUrl, admin, pw, RATE_LIMITER, false);
  }
  return { limiterPrev, limiterNote };
}

export interface ApplyOptions {
  readonly dryRun?: boolean;
  readonly log?: Log;
  readonly workspace?: string;
  readonly adminPassword?: string;
}

export interface ApplyResult {
  readonly applied: number;
  readonly failed: number;
  readonly skipped: number;
  readonly failures: string[];
}

/**
 * Apply the plan.
 *
 * Disables the API rate limiter during the bulk PATCH and restores it in a finally.
 */
export async function apply(
  rootUrl: string,
  admin: Auth,
  plan: Plan,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const log = options.log ?? (() => undefined);
  const workspace = options.workspace ?? '';
  if (options.dryRun === true) {
    return {
      applied: 0,
      failed: 0,
      skipped: plan.redacted.length + plan.denied.length,
      failures: [],
    };
  }

  const pw = (options.adminPassword ?? '') || config.ADMIN_PASSWORD;
  // Disable the rate limiter for the bulk PATCH. But the dump itself may set this setting
  // -- if so its value wins; otherwise restore the prior value.
  const planLimiterEntry = plan.apply.find(([sid]) => sid === RATE_LIMITER);
  const planLimiter: unknown = planLimiterEntry === undefined ? UNSET : planLimiterEntry[1];
  const { limiterPrev, limiterNote } = await disableLimiter(rootUrl, admin, pw, workspace);
  let applied = 0;
  const failures: string[] = [];
  try {
    applied = await applySettings(rootUrl, admin, pw, plan, failures, log);
  } finally {
    if (planLimiter !== UNSET) {
      // The DUMP sets it, so the dump's value wins and the note is closed either way: the
      // setting is now whatever the customer's workspace had, which is the point of the
      // import.
      if (await setSetting(rootUrl, admin, pw, RATE_LIMITER, planLimiter)) {
        applied += 1;
        journal.clear(limiterNote);
      } else {
        failures.push(RATE_LIMITER);
      }
    } else if (limiterPrev === true) {
      if (await setSetting(rootUrl, admin, pw, RATE_LIMITER, true)) journal.clear(limiterNote);
    }
  }

  return {
    applied,
    failed: failures.length,
    skipped: plan.redacted.length + plan.denied.length,
    failures,
  };
}
