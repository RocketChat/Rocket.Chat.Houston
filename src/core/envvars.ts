/**
 * Change a running repro's Rocket.Chat environment — shared by CLI and web API.
 *
 * An env var cannot be changed inside a running container: the environment is fixed when the
 * container is created. What CAN be done is rewrite the compose file and let
 * `docker compose up -d` recreate just the Rocket.Chat service — Mongo is left running and
 * its volume untouched, so no data is lost and it takes seconds (no image pull).
 *
 * Overrides are stored in the repro's metadata (`extra["env"]`), not only in the compose
 * file, because `up --force` rebuilds compose from the spec — anything living only in the
 * generated file is silently dropped on the next rebuild.
 *
 * Same shape as `core/monitor.ts`, which mutates a running repro the same way.
 */
import { toYaml } from '../lib/compose';
import type { ComposeDoc } from '../lib/compose';
import * as config from '../lib/config';
import { DockerError, ValidationError } from '../lib/errors';
import { type Emit, info, nullEmit, warn } from '../lib/events';
import {
  namedError,
  quotedText,
  setItemChecked,
  stripText,
  isTruthy,
  valueKind,
  storedText,
  expectedText,
  keyRefusal,
} from '../lib/format';
import { orderedDict } from '../lib/json-text';
import { redactEnv } from '../lib/redact';

import { login } from './lifecycle/admin';
import { resolveName } from './lifecycle/naming';
import { requireDocker } from './lifecycle/preconditions';
import { waitServing } from './lifecycle/ready';
import { settingIds } from './rcapi';
import { up } from './runner/engine';
import { reproLock } from './runner/locks';
import { rcContainerEnv } from './runner/queries';
import { type Metadata, adminPass, readCompose, readMeta, write } from './runner/record';
import * as topology from './topology';

type Bag = Record<string, unknown>;

/** Sentinel for "this key is not in the container at all", which is not the same as it
 * being there with an empty value. */
const MISSING = Symbol('missing');

/**
 * A POSIX-ish environment variable name. Anything else produces a compose file docker
 * will not accept, so it is refused rather than written out.
 */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * Overriding these breaks how houston itself talks to the repro. Allowed anyway —
 * reproducing a broken configuration is the point of the tool — but never silently.
 */
const LOAD_BEARING: Readonly<Record<string, string>> = Object.freeze({
  MONGO_URL: "houston's Mongo connection; Rocket.Chat will not start if it is wrong",
  PORT: 'the container port houston publishes; the workspace becomes unreachable',
  ROOT_URL: 'set from --root-url/--https; overriding it here will fight those',
  TRANSPORTER: 'the multi-instance NATS mesh',
});

export const SETTING_PREFIX = 'OVERWRITE_SETTING_';

/**
 * The value when it is a mapping, else `{}`.
 *
 * The declared record type says mapping, and a hand-edited or half-written repro.json can
 * still hold a list there. Routed through `unknown` so the check is against what is on
 * disk rather than against what the annotation claims.
 */
function bagOf(value: unknown): Bag {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Bag;
}

/**
 * A mapping made of what a hand-edited `extra.env` can hold.
 *
 * A mapping is copied. Anything else is read as a sequence of key/value PAIRS:
 * `[["A", "1"]]` is `{A: "1"}`, and so is `["AB"]`, since a string is the sequence of its
 * characters. `"abc"` is entry #0 with one item and `5` is not a sequence at all, each
 * refused with what it was. `bagOf` answered `{}` for every one of them, so a list
 * of pairs was dropped from the document and the record, and a string reported success
 * where the right answer is a refusal before anything is written.
 *
 * NOT REPRODUCED: a pair keyed by a number, a bool or null. It is kept here under its JSON
 * spelling. The previous implementation keeps the key as it is -- where `true` and `1` are
 * one key -- writes both files, and then fails sorting it against a string for the
 * display, exit 1.
 */
function dictOf(value: unknown): Bag {
  // A mapping is `orderedDict`'s copy: in the record's key order, with its numbers' spelling,
  // where a copy key by key was in JavaScript's order, integer-like keys first.
  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    return orderedDict(value);
  const out: Bag = {};
  if (!Array.isArray(value) && typeof value !== 'string') {
    throw new TypeError(expectedText('an object or a list of KEY/VALUE pairs', value));
  }
  Array.from(value as Iterable<unknown>).forEach((element, index) => {
    const at = `env entry #${String(index)}`;
    let pair: unknown[];
    if (Array.isArray(element)) pair = element;
    else if (typeof element === 'string') pair = Array.from(element);
    else if (element !== null && typeof element === 'object') pair = Object.keys(element);
    else throw new TypeError(`${at} is ${valueKind(element)}, not a KEY/VALUE pair`);
    if (pair.length !== 2) {
      throw namedError(
        'InvalidValue',
        `${at} has ${String(pair.length)} item${pair.length === 1 ? '' : 's'}; a KEY/VALUE pair has 2`,
      );
    }
    const [key, item] = pair;
    if (key !== null && typeof key === 'object') {
      throw new TypeError(keyRefusal(key));
    }
    const name =
      typeof key === 'string'
        ? key
        : key === null
          ? 'null'
          : typeof key === 'boolean'
            ? String(key)
            : storedText(key);
    setItemChecked(out, name, item);
  });
  return out;
}

/**
 * `{"Some_Setting": v}` -> `{"OVERWRITE_SETTING_Some_Setting": v}`.
 *
 * A Rocket.Chat SETTING only takes effect from the environment with this prefix; a
 * bare setting id changes nothing at all. Both front-ends hand their "this is a
 * setting" input through here rather than each prepending the prefix itself, so
 * the rule lives in one place.
 *
 * Already-prefixed keys pass through, so a caller that pastes the full name is not
 * double-prefixed.
 */
export function prefixSettings(settings: Record<string, unknown> | null | undefined): Bag {
  const out: Bag = {};
  for (const [rawKey, value] of Object.entries(settings ?? {})) {
    const key = stripText(String(rawKey));
    const bare = key.startsWith(SETTING_PREFIX) ? key.slice(SETTING_PREFIX.length) : key;
    checkNames([bare]);
    out[SETTING_PREFIX + bare] = value;
  }
  return out;
}

/** `--setting Id=value` -> `{"OVERWRITE_SETTING_Id": "value"}`. */
export function asSetting(pairs: readonly string[]): Bag {
  return prefixSettings(parseSet(pairs));
}

/**
 * Warn when a key is a Rocket.Chat setting id used WITHOUT the prefix.
 *
 * This is the one mistake here with no feedback of its own: docker accepts the
 * variable, Rocket.Chat ignores it, and the setting silently keeps its old value.
 * Verified against a live workspace — `Accounts_ShowFormLogin=false` left the setting
 * `true`, while `OVERWRITE_SETTING_Accounts_ShowFormLogin=false` applied.
 *
 * Best-effort: the workspace is asked which names are settings, so this is right for
 * whatever version is running. If it cannot be reached, say nothing.
 */
export async function warnBareSettings(
  meta: Metadata,
  keys: readonly string[],
  emit: Emit = nullEmit,
): Promise<void> {
  const candidates = keys.filter((key) => !key.startsWith(SETTING_PREFIX));
  if (candidates.length === 0) return;
  let known: Set<string> | null;
  try {
    const auth = await login(meta);
    known = await settingIds(meta.rootUrl, auth, adminPass(meta));
  } catch {
    // not serving yet, or not logged in; skip quietly
    return;
  }
  if (known === null || known.size === 0) return;
  for (const key of candidates) {
    if (known.has(key)) {
      warn(
        emit,
        `${key} is a Rocket.Chat SETTING, not an environment variable. ` +
          `On its own it has no effect - use ${SETTING_PREFIX}${key} ` +
          `(or \`--setting ${key}=...\`).`,
        { phase: 'config' },
      );
    }
  }
}

/** Turn `["K=V", ...]` into `{K: V}`. Raises on a malformed pair or bad name. */
export function parseSet(pairs: readonly string[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of pairs ?? []) {
    if (!raw.includes('=')) {
      throw new ValidationError(
        `--set ${quotedText(raw)} is not KEY=VALUE (to remove a key, use --unset ${raw})`,
      );
    }
    const at = raw.indexOf('=');
    // `stripText(key)`, not `trim()`: `--set $'\x1fFOO=1'` has always been FOO and was an
    // invalid name here, and a BOM-led key the reverse. The same split as `chown --to`'s,
    // at all three strips -- this one, `prefixSettings` and `checkNames`.
    const key = stripText(raw.slice(0, at));
    const value = raw.slice(at + 1);
    if (!NAME_RE.test(key)) {
      throw new ValidationError(
        `${quotedText(key)} is not a valid environment variable name (letters, digits ` +
          'and underscore; not starting with a digit)',
      );
    }
    // An item set on a mapping (`setItemChecked`), where every name the rule above accepts is a
    // key -- `__proto__` too. Assigned here, it hit `Object.prototype`'s accessor and was
    // dropped, so `env --set __proto__=x` parsed to nothing and ran as a read.
    setItemChecked(out, key, value);
  }
  return out;
}

export function checkNames(keys: readonly string[]): void {
  for (const key of keys) {
    if (!NAME_RE.test(stripText(key))) {
      throw new ValidationError(`${quotedText(key)} is not a valid environment variable name`);
    }
  }
}

/**
 * A compose `environment` value as a name -> value map.
 *
 * Compose accepts both the map form and the list form (`"K=V"`). The split is on the
 * FIRST `=` only, so a value that contains one keeps it: `"A=x=y"` is `A -> "x=y"`.
 */
function asEnvironmentMap(env: unknown): Bag {
  const out: Bag = {};
  for (const item of Array.isArray(env) ? env : []) {
    const text = storedText(item);
    const at = text.indexOf('=');
    // A mapping's item assignment (`setItemChecked`), so a `__proto__=x` item is a variable
    // here too.
    if (at < 0) setItemChecked(out, text, '');
    else setItemChecked(out, text.slice(0, at), text.slice(at + 1));
  }
  return out;
}

/**
 * Each variable, masked where it is a credential, and whether it has drifted.
 *
 * WHAT IT IS RUNNING, not only what it was asked to run. The Kubernetes branch of
 * `current` already reads the container, and says why — "strictly more accurate". Compose
 * could answer from the document it generated, so it did, and that is
 * the wrong answer whenever the two disagree.
 *
 * MEASURED: an `env` apply interrupted mid-recreate left the variable in the compose file
 * and in `repro.json` and absent from the container. `houston env` then displayed it as
 * `<- yours` while Rocket.Chat used the old value, and neither `start`, `restart` nor a
 * re-run `up` reconverged it. That lands on the exact question this command exists to
 * answer — "is this setting actually set?" — and answered it wrongly, with a confirming
 * display.
 *
 * `live` is null when the container could not be read (not running, Docker down); then
 * there is nothing to compare against and the document is all there is, reported as before
 * rather than as universal drift.
 */
export function envRows(
  env: Record<string, unknown>,
  overrides: Bag,
  live: Record<string, string> | null,
): { drift: string[]; live: Record<string, string> | null; rows: Bag[] } {
  const rows: Bag[] = [];
  const drift: string[] = [];
  for (const key of Object.keys(env).sort()) {
    const value = env[key];
    // `Object.hasOwn`, not `in`: `'constructor' in {}` is TRUE, so a variable named
    // after an `Object.prototype` property was reported as an override the document
    // never recorded. Only a mapping's own keys count, so `hasOwn` is the faithful test.
    const row: Bag = {
      key,
      value: redactEnv(key, storedText(value)),
      override: Object.hasOwn(overrides, key),
    };
    // A key absent from the container is a drift, and so is one whose value differs as
    // text. The absence is compared as its own case rather than through `storedText`, since a
    // sentinel has no meaningful text.
    const liveValue: unknown = live !== null && Object.hasOwn(live, key) ? live[key] : MISSING;
    if (live !== null && (liveValue === MISSING || storedText(liveValue) !== storedText(value))) {
      // RECORDED BUT NOT IN EFFECT. Reported as its own state rather than folded into
      // the value, because a caller has to be able to say which of the two numbers it
      // is showing.
      row.drift = true;
      row.live = Object.hasOwn(live, key) ? redactEnv(key, storedText(live[key])) : '';
      drift.push(key);
    }
    rows.push(row);
  }
  return { drift, live, rows };
}

/** What the compose document says this workspace was asked to run with. */
export async function composeEnvironment(
  meta: Metadata,
  target: string,
): Promise<{ env: Bag; overrides: Bag }> {
  const doc = await readCompose(target);
  const services = bagOf(doc.services);
  // `rocketchat` by a truth test, else `rocketchat-1`: an EMPTY map is falsy, so a
  // document with `rocketchat: {}` and a populated `rocketchat-1` reads the multi-instance
  // service. `??` only fell back for null/undefined and answered no variables at all for
  // that document; measured against the previous implementation.
  const primary = services.rocketchat;
  const rc = bagOf(isTruthy(primary) ? primary : services['rocketchat-1']);
  // THE LIST FORM IS REAL: compose accepts `environment: ["K=V", ...]` and both
  // `readCompose` consumers have to see the same map. `bagOf` alone would answer `{}`
  // for it, so `houston env` would show no variables at all for a document docker runs
  // perfectly well.
  const raw = rc.environment;
  const env = Array.isArray(raw) ? asEnvironmentMap(raw) : bagOf(raw);
  const overrides = bagOf(bagOf(meta.extra).env);
  return { env, overrides };
}

/**
 * The overrides that are removals (`env --unset` records the key as null). `overrides` keeps
 * listing them, as earlier releases did; a reader that says "your overrides" leaves these out,
 * or an unset key was still named as one (live matrix 2026-10-30, F1).
 */
function removedKeys(overrides: Bag): string[] {
  return Object.keys(overrides)
    .filter((key) => overrides[key] === null)
    .sort();
}

/**
 * The RC service's effective environment, credentials masked, plus which keys are user
 * overrides — so a caller can show what was changed versus inherited.
 *
 * Answered per runtime. On Compose that is the generated compose document; on Kubernetes
 * there is no such document, so the running container is asked — which is strictly more
 * accurate, since the chart contributes variables houston never set and the helm values
 * would not show them.
 *
 * This path first threw a bare ENOENT naming
 * `repros/<n>/docker-compose.yml` — a path, with no statement of what was wrong — which
 * escaped the ReproError contract so `serve` answered 500 to a request that was merely
 * unsupported. It then refused cleanly, and now answers.
 */
export async function current(name: string): Promise<Bag> {
  const target = await resolveName(name);
  const meta = await readMeta(target);
  if ((await topology.ofRepro(target)) === topology.KUBERNETES) {
    // Read from the RUNNING CONTAINER, not from a document. Compose can answer this from
    // the file it generated; there is no such file here, and the helm values are only
    // what houston asked for — the chart adds its own on top, so they are not the answer
    // to "what is Rocket.Chat running with".
    const { containerEnv } = await import('./kube/status');
    const ctxValue = bagOf(meta.extra)[config.EXTRA_CONTEXT];
    const context = String(isTruthy(ctxValue) ? ctxValue : (await import('./kube/names')).CONTEXT);
    const env = await containerEnv(target, { context });
    const overrides = bagOf(bagOf(meta.extra).env);
    return {
      name: target,
      env: Object.keys(env)
        .sort()
        .map((key) => ({
          key,
          value: redactEnv(key, storedText(env[key])),
          override: Object.hasOwn(overrides, key),
        })),
      overrides: Object.keys(overrides).sort(),
      removed: removedKeys(overrides),
    };
  }
  const { env, overrides } = await composeEnvironment(meta, target);
  const { drift, live, rows } = envRows(env, overrides, await rcContainerEnv(target));
  return {
    name: target,
    env: rows,
    overrides: Object.keys(overrides).sort(),
    removed: removedKeys(overrides),
    // The keys the workspace records and is not running. Empty when there are none AND
    // when the container could not be read — `live_read` says which.
    drift,
    live_read: live !== null,
  };
}

/**
 * Apply env changes to a repro and recreate Rocket.Chat so they take effect.
 *
 * `sets` adds or replaces; `unset` removes a key entirely (including a base or preset
 * default, which merely blanking it would not do).
 */
/**
 * The workspace an env change acts on, refused where it has no Compose document to change.
 *
 * No Kubernetes path yet. Reaching for the compose project answers "no configuration file
 * provided", which names nothing a user can act on — so this refuses and hands over the
 * command that does the job. RESOLVED FIRST, because the refusal QUOTES the name.
 * `requireCompose` ran on the raw argument, so `env --set X=1 --name TICKET-1234` handed
 * over `helm -n houston-TICKET-1234 ...` — a namespace that does not exist, for a workspace
 * really called `ticket-1234`. A refusal whose suggested command cannot work is worse than
 * a bare refusal: it sends somebody to debug kubectl. Exported so the GUI refuses before it
 * queues a job, not inside one.
 */
export async function envTarget(name: string): Promise<string> {
  const target = await resolveName(name);
  await topology.requireCompose(target, 'env', {
    instead:
      `Use \`helm -n houston-${target} upgrade rocketchat --reuse-values ` +
      '--set extraEnv[0].name=...`, or `houston api` for a runtime setting.',
  });
  return target;
}

export async function setEnv(
  name: string,
  sets: Record<string, string> | null = null,
  unset: readonly string[] | null = null,
  { restart = true, emit = nullEmit }: { restart?: boolean; emit?: Emit } = {},
): Promise<Bag> {
  const target = await envTarget(name);
  await requireDocker();
  // Serialised against every other mutating operation on this repro: this does
  // read-compose -> write-compose -> `docker compose up`, and interleaving that with a
  // backup, an upgrade or another env change races compose against itself.
  return await reproLock(
    target,
    async () => await setEnvLocked(target, sets, unset, { restart, emit }),
  );
}

/** Write the overrides onto every Rocket.Chat service in the document. */
export async function applyToCompose(
  overrides: Record<string, string | null>,
  target: string,
): Promise<{ doc: Bag; rcServices: string[] }> {
  const doc = await readCompose(target);
  // The services, deliberately NOT through `bagOf`, so a present-but-null `services:`
  // throws here, as it always has. A MISSING key reads as `{}` and reaches the DockerError
  // below; it used to be `Object.keys(undefined)`, a raw TypeError out of the error
  // contract.
  const services: Record<string, unknown> =
    doc.services === undefined ? {} : (doc.services as Record<string, unknown>);
  const rcServices = Object.keys(services).filter(
    (service) => service === 'rocketchat' || service.startsWith('rocketchat-'),
  );
  if (rcServices.length === 0) {
    throw new DockerError(`${quotedText(target)} has no rocketchat service to change`);
  }
  for (const service of rcServices) {
    const entry = services[service] as Bag;
    if (!('environment' in entry)) entry.environment = {};
    const existing = entry.environment;
    const env = Array.isArray(existing) ? asEnvironmentMap(existing) : (existing as Bag);
    entry.environment = env;
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) delete env[key];
      // Each value through `storedText`: a recorded override that is not a string (a
      // hand-edited repro.json, or a manifest `env_overrides` carrying a JSON
      // number/bool) is the STRING `'8080'` / `'True'` in the document, not a YAML
      // number/bool. Defined rather than assigned, so an override named `__proto__` lands
      // in the document like any other variable.
      else setItemChecked(env, key, storedText(value));
    }
  }
  return { doc, rcServices };
}

/** Fold this call's sets and unsets into the workspace's recorded overrides. */
export async function mergedOverrides(
  emit: Emit,
  sets: Record<string, string>,
  target: string,
  unset: readonly string[],
): Promise<{ meta: Metadata; overrides: Record<string, string | null> }> {
  const meta = await readMeta(target);
  // The recorded `env` when `extra` is a mapping and `env` is truthy, else nothing: a
  // record whose `extra` is not a mapping starts from nothing, and its `env` goes through
  // `dictOf`.
  const recorded = bagOf(meta.extra).env;
  const overrides = dictOf(isTruthy(recorded) ? recorded : {}) as Record<string, string | null>;
  for (const key of unset) {
    // null (not "") records "remove this key", so a preset default really goes away
    // instead of being set to an empty string.
    setItemChecked(overrides, key, null);
  }
  // Each set merged in key by key (`setItemChecked`). `Object.assign` assigns through
  // the prototype chain, and so did `overrides[key] = null`: `--set __proto__=x` was
  // dropped from the record and the document, and `--unset __proto__` replaced the
  // object's prototype instead of recording the removal.
  for (const [key, value] of Object.entries(sets)) setItemChecked(overrides, key, value);

  for (const key of Object.keys(sets)) {
    // An OWN key of `LOAD_BEARING` only. A lookup by name reached `Object.prototype`
    // instead, so `--set constructor=x` warned with the function's own source where the
    // established answer is no warning at all.
    if (Object.hasOwn(LOAD_BEARING, key)) {
      warn(emit, `${key} is load-bearing: ${LOAD_BEARING[key] as string}. Setting it anyway.`, {
        phase: 'config',
      });
    }
  }
  await warnBareSettings(meta, Object.keys(sets), emit);
  return { meta, overrides };
}

export async function setEnvLocked(
  target: string,
  setsValue: Record<string, string> | null,
  unsetValue: readonly string[] | null,
  { restart = true, emit = nullEmit }: { restart?: boolean; emit?: Emit } = {},
): Promise<Bag> {
  const sets = { ...(setsValue ?? {}) };
  const unset = [...(unsetValue ?? [])];
  checkNames([...Object.keys(sets), ...unset]);
  if (Object.keys(sets).length === 0 && unset.length === 0) {
    throw new ValidationError('nothing to change (use --set KEY=VALUE or --unset KEY)');
  }

  const { meta, overrides } = await mergedOverrides(emit, sets, target, unset);

  const { doc, rcServices } = await applyToCompose(overrides, target);

  // `meta.extra["env"] = overrides`, which is a TypeError when `extra` is not a mapping --
  // raised before anything is written. Assigned into `bagOf`'s throwaway `{}`, the override
  // reached docker-compose.yml and not repro.json, so the next `up --force` rebuilt it away.
  setItemChecked(meta.extra, 'env', overrides);
  await write(target, toYaml(doc as unknown as ComposeDoc), meta);
  const changed = [...Object.keys(sets), ...unset].sort().join(', ');
  info(emit, `env updated on ${quotedText(target)}: ${changed}`, { phase: 'config' });

  if (!restart) {
    // Not `up`: on a running workspace it recreates nothing. Re-running `env` forces it.
    info(
      emit,
      'not restarting; the change is written but not applied. To apply it, re-run the ' +
        'same `houston env` without --no-restart',
      { phase: 'done' },
    );
    return { name: target, restarted: false, overrides: shown(overrides) };
  }

  // An env change only reaches Rocket.Chat by recreating the container. compose recreates
  // just the services whose config changed, so Mongo keeps running and its volume is
  // untouched — no data loss, and no image pull.
  info(emit, 'recreating the Rocket.Chat container (data is kept)...', { phase: 'boot' });
  // FORCED, so an interrupted apply is healed by the next one. Compose decides what to
  // recreate from a config hash on the container, and that was measured not to fire: an
  // apply interrupted mid-recreate left the compose file carrying a variable the
  // container did not have, and re-running `env`, `restart` and `up` all reported success
  // without changing anything. Scoped to the one service, so Mongo and its volume are
  // untouched — which is the reason recreating here is safe at all.
  if ((await up(target, { pull: false, forceRecreate: rcServices[0] })) !== 0) {
    throw new DockerError('`docker compose up` failed applying the env change');
  }
  // WAITED FOR, so the command returns when Rocket.Chat answers again. It returned as soon
  // as compose had recreated the container, and a `seed` typed straight after refused
  // "repro not ready" while the new container booted. No line of its own: the wait sits
  // under the "recreating" line, and "restarted" is said once it is true. A container the
  // new environment stops from serving is a NotReadyError (exit 5) naming why, not a
  // success; the change is written either way, so `env --unset` is the way back.
  await waitServing(await readMeta(target), emit, 300.0);
  info(emit, `${quotedText(target)} restarted with the new environment`, { phase: 'done' });
  return { name: target, restarted: true, overrides: shown(overrides) };
}

/** Overrides for display: values masked by key, removals marked. */
export function shown(overrides: Record<string, string | null>): Bag[] {
  const out: Bag[] = [];
  for (const key of Object.keys(overrides).sort()) {
    const value = overrides[key] as string | null;
    out.push({
      key,
      removed: value === null,
      value: value === null ? '' : redactEnv(key, storedText(value)),
    });
  }
  return out;
}
