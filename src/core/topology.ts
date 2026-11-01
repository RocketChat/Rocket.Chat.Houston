/**
 * Which runtime a workspace runs on.
 *
 * Until this module, the answer was structural rather than recorded: a repro WAS a
 * `docker-compose.yml` on disk. That is true of every workspace this tool has ever made, and
 * it is the assumption a second runtime has to displace -- so this makes the answer a value
 * that can be read, rather than a shape that can only be inferred.
 *
 * **A missing value means docker.** Every workspace created before this key existed is a
 * compose one, and there is no migration: `repro.json` files are not rewritten, not on
 * read and not on the next `up`. The absent key is not ambiguous, it is older than the
 * question. This is one of the two "absence is a version marker" fields, and the failure
 * to guard against is exactly this one round-tripping "successfully" while turning an
 * absent `extra.runtime` into an explicit `"docker"`.
 *
 * **Unknown values also mean docker, and that is deliberate.** `ofMeta` never throws. A
 * workspace written by a NEWER houston naming a runtime this build has never heard of must
 * still list, still show its ports and still tear down; the alternative is a repro that
 * cannot be removed by the version installed. Refusing belongs at the point of USE --
 * `requireCompose` -- where the operation is known and the message can say what to do
 * instead. Reading is not use.
 *
 * `normalize` is the opposite and does throw, because it is only ever called on input a
 * human just typed, where a silent fallback would boot the wrong thing.
 */
import * as config from '../lib/config';
import { ValidationError } from '../lib/errors';
import { compositeName, namesOf } from '../lib/presets/composite';

import { readMeta } from './runner/record';

/** Canonical runtime names. These reach `repro.json` and are stable API. */
export const DOCKER = 'docker';
export const KUBERNETES = 'kubernetes';

/**
 * Canonical deployment names -- HOW Rocket.Chat is arranged, as opposed to WHERE it runs.
 * Which are legal depends on the runtime; see `DEPLOYMENTS`.
 */
export const MONOLITH = 'monolith';
export const MULTI_INSTANCE = 'multi-instance';
export const MICROSERVICES = 'microservices';

/**
 * The deployments each runtime can serve, first entry being its default.
 *
 * Kubernetes defaults to microservices because the chart's own default is
 * `microservices.enabled: true` and it is the shape customers actually run;
 * monolith-on-Kubernetes is the control experiment, not the common case.
 */
export const DEPLOYMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [DOCKER]: Object.freeze([MONOLITH, MULTI_INSTANCE]),
  [KUBERNETES]: Object.freeze([MICROSERVICES, MONOLITH]),
});

/** Deployment spellings, same reasoning as the runtime aliases. */
export const DEPLOYMENT_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  monolith: MONOLITH,
  monolithic: MONOLITH,
  single: MONOLITH,
  default: MONOLITH,
  'multi-instance': MULTI_INSTANCE,
  multi_instance: MULTI_INSTANCE,
  multiinstance: MULTI_INSTANCE,
  microservices: MICROSERVICES,
  microservice: MICROSERVICES,
  micro: MICROSERVICES,
});

/**
 * The preset that IS a deployment rather than a scenario, and the `--set` key it used to
 * take. Both spellings keep working; see `resolveAxes`.
 */
export const LEGACY_MULTI_PRESET = 'multi-instance';
export const LEGACY_REPLICA_PARAM = 'instances';

/**
 * What a human may type. Values are canonical names; keys are lowercased before lookup.
 * `compose` and `k8s` are here because they are what people actually write, and a tool
 * that rejects `--runtime k8s` is being pedantic at the user's expense.
 */
export const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  docker: DOCKER,
  compose: DOCKER,
  'docker-compose': DOCKER,
  dockercompose: DOCKER,
  kubernetes: KUBERNETES,
  k8s: KUBERNETES,
  kube: KUBERNETES,
});

/**
 * Runtimes this build can actually create. Kubernetes joined once the whole sequence --
 * cluster, namespace, MongoDB with an initiated replica set, the chart, a port-forward --
 * was proven on a live cluster rather than in stubs.
 */
export const REGISTERED: ReadonlySet<string> = new Set([DOCKER, KUBERNETES]);

/** Human labels, for a message or a GUI row. */
export const LABELS: Readonly<Record<string, string>> = Object.freeze({
  [DOCKER]: 'Docker Compose',
  [KUBERNETES]: 'Kubernetes',
});

/**
 * A table's OWN entry for `key`. Indexing a plain object also finds its prototype's names:
 * `--runtime constructor` found Object's constructor, a function, where the established
 * answer refuses an unknown runtime.
 */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * Canonical runtime name for something a human typed.
 *
 * Empty means the default, which is docker -- omitting `--runtime` is not an error, it is
 * the common case. An unrecognised spelling throws, because it is a typo the caller can
 * fix and guessing would boot the wrong topology.
 */
export function normalize(value: string | null | undefined): string {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  if (!text) return DOCKER;
  const found = own(ALIASES, text);
  if (found === undefined) {
    const known = [...new Set(Object.values(ALIASES))].sort().join(', ');
    throw new ValidationError(`unknown runtime '${text}'. Known runtimes: ${known}.`);
  }
  return found;
}

/** Whether this build can create workspaces on that runtime. */
export function isRegistered(name: string): boolean {
  return REGISTERED.has(name);
}

/** A human-readable name, falling back to the raw value for an unknown one. */
export function label(name: string): string {
  return LABELS[name] ?? (name || DOCKER);
}

/** Anything carrying an `extra` bag. `readMeta`'s result, in practice. */
export interface HasExtra {
  readonly extra?: unknown;
  readonly preset?: unknown;
}

/**
 * The runtime a workspace's metadata records. NEVER throws -- see the module docstring for
 * why an unreadable or unknown value reads as docker.
 */
export function ofMeta(meta: HasExtra | null | undefined): string {
  const extra = meta?.extra;
  if (typeof extra !== 'object' || extra === null || Array.isArray(extra)) return DOCKER;
  const raw = String((extra as Record<string, unknown>)[config.EXTRA_RUNTIME] ?? '')
    .trim()
    .toLowerCase();
  return own(ALIASES, raw) ?? DOCKER;
}

/**
 * The runtime of a named workspace.
 *
 * Tolerant of a workspace that is missing or mid-write: this must never be the thing that
 * breaks an operation. If the metadata cannot be read, the answer that preserves today's
 * behaviour is docker, and the caller's own existence check reports the real problem a
 * moment later with a better message.
 */
export async function ofRepro(name: string): Promise<string> {
  try {
    return ofMeta(await readMeta(name));
  } catch {
    return DOCKER;
  }
}

/**
 * Record the runtime in an `extra` bag, returning it for chaining.
 *
 * Written on every create, INCLUDING compose ones. Stamping only the new runtime would
 * leave "absent" meaning two different things -- an old workspace and a new compose one --
 * and the first question asked of any workspace field is eventually "is this missing
 * because it is old, or because it is false?".
 */
export function stamp(extra: Record<string, unknown> | null | undefined, runtime = DOCKER) {
  const bag =
    typeof extra === 'object' && extra !== null && !Array.isArray(extra)
      ? extra
      : ({} as Record<string, unknown>);
  bag[config.EXTRA_RUNTIME] = runtime;
  return bag;
}

/**
 * Refuse an operation that only Docker Compose can serve.
 *
 * The guard lives at the operation, not at the front door, because most of the tool is
 * runtime-agnostic -- `seed`, `api`, `token` and `config-import` all speak REST to a URL
 * and do not care what is behind it. Only the handful of commands that reach for a compose
 * project need this.
 *
 * `instead` is the Kubernetes equivalent, when there is one. Saying only "not supported"
 * leaves the user to search for the alternative that the person writing the refusal
 * already knew.
 */
export async function requireCompose(
  name: string,
  operation: string,
  { instead = '' } = {},
): Promise<void> {
  const runtime = await ofRepro(name);
  if (runtime === DOCKER) return;
  const tail = instead ? ` ${instead}` : '';
  throw new ValidationError(
    `${operation} reads the Docker Compose project, and '${name}' runs on ` +
      `${label(runtime)}.${tail}`,
  );
}

/**
 * Canonical deployment name, checked against what the runtime can serve.
 *
 * Empty means that runtime's default. An unknown spelling throws; so does a legal-elsewhere
 * one, and that refusal names the runtime it IS legal on -- "unknown deployment
 * 'microservices'" would be a lie, since it is a real deployment that this runtime simply
 * cannot host.
 */
export function normalizeDeployment(value: string | null | undefined, runtime: string): string {
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  const legal = DEPLOYMENTS[runtime] as readonly string[];
  if (!text) return legal[0] as string;
  const found = own(DEPLOYMENT_ALIASES, text);
  if (found === undefined) {
    const known = [...new Set(Object.values(DEPLOYMENT_ALIASES))].sort().join(', ');
    throw new ValidationError(`unknown deployment '${text}'. Known deployments: ${known}.`);
  }
  if (!legal.includes(found)) {
    const other = Object.entries(DEPLOYMENTS).find(([, d]) => d.includes(found))?.[0] ?? '';
    const where = other ? ` It is available on --runtime ${other}.` : '';
    throw new ValidationError(`${label(runtime)} cannot run a '${found}' deployment.${where}`);
  }
  return found;
}

/**
 * The three axes, resolved, plus how they map onto today's machinery.
 *
 * `preset` and `params` are what the existing preset loader is handed, so the deployment
 * axis reaches `compose.build` through exactly the path it always did. That is what makes
 * `--deployment multi-instance --replicas 3` produce a byte-identical compose file to
 * `--preset multi-instance --set instances=3`: it IS that call, reached by a different
 * spelling.
 */
export interface Axes {
  runtime: string;
  deployment: string;
  replicas: number;
  preset: string;
  params: Record<string, unknown>;
  /**
   * Deprecation notes for the caller to show. NOT warnings -- nothing is wrong, the old
   * spelling simply has a newer name.
   */
  hints: string[];
}

/** The pre-axes spellings -- the multi-instance preset and its replica param. */
function absorbLegacySpellings(
  out: Axes,
  rawDeployment: string,
  rawPreset: string,
  replicas: number,
): [unknown, string, string] {
  // `--preset multi-instance` is the deployment axis wearing last year's name.
  if (rawPreset === LEGACY_MULTI_PRESET) {
    if (rawDeployment && own(DEPLOYMENT_ALIASES, rawDeployment) !== MULTI_INSTANCE) {
      throw new ValidationError(
        `--preset ${LEGACY_MULTI_PRESET} and --deployment ${rawDeployment} ask for two ` +
          'different deployments. Drop the --preset; it is now spelled --deployment ' +
          'multi-instance.',
      );
    }
    rawDeployment = MULTI_INSTANCE;
    rawPreset = 'default';
    out.hints.push(
      '--preset multi-instance is now --deployment multi-instance ' +
        '(the old spelling still works)',
    );
  }

  // `--set instances=N` is `--replicas N` wearing the same.
  const legacyN = out.params[LEGACY_REPLICA_PARAM];
  if (legacyN !== undefined && legacyN !== null && legacyN !== '' && !replicas) {
    out.hints.push(
      `--set ${LEGACY_REPLICA_PARAM}=${String(legacyN)} is now --replicas ${String(legacyN)} ` +
        '(the old spelling still works)',
    );
  }
  return [legacyN, rawDeployment, rawPreset];
}

/**
 * A value read as an integer the established way, which is not `Number()` and not
 * `parseInt`.
 *
 * Measured rather than assumed, because the three disagree exactly where a replica count
 * comes from a JSON payload rather than from a command line:
 *
 *     3.7      -> 3        truncates toward zero
 *     "3.7"    -> null     a STRING must be a whole number
 *     " 4 "    -> 4        surrounding space is fine
 *     ""       -> null
 *     true     -> 1
 *
 * `Number("3.7")` is 3.7 and `parseInt("3.7")` is 3, so either one alone gets a case
 * wrong. Returns null where the value is not an integer, and the caller decides what that
 * means.
 */
function toInt(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.trunc(value);
  }
  const text = String(value ?? '').trim();
  if (!/^[+-]?\d+$/u.test(text)) return null;
  return Number.parseInt(text, 10);
}

/**
 * The value as that one message quotes it: text in single quotes, anything else bare.
 *
 * `--set instances='2.5'` is what the user typed, and the quotes are what tell them the
 * value arrived as text. A bare `2.5` in the message would read as a number houston chose.
 */
function quotedText(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

/**
 * How many app instances, and whether asking for more than one makes sense.
 *
 * A lone Compose monolith cannot be replicated -- there is no load balancer in front of it
 * and no NATS mesh between them, so `--replicas 3` there would silently produce one.
 * Refusing names the flag that would make it work.
 */
function resolveReplicas(replicas: number, legacyN: unknown, axes: Axes): number {
  let want = Number(replicas || 0);
  if (!want && legacyN !== undefined && legacyN !== null && legacyN !== '') {
    const parsed = toInt(legacyN);
    if (parsed === null) {
      throw new ValidationError(
        `--set ${LEGACY_REPLICA_PARAM}=${quotedText(legacyN)} expects a whole number`,
      );
    }
    want = parsed;
  }
  if (want && want < 1) throw new ValidationError('--replicas must be at least 1.');
  if (axes.deployment === MONOLITH && want > 1) {
    const alt =
      axes.runtime === DOCKER ? '--deployment multi-instance' : '--deployment microservices';
    throw new ValidationError(
      `a ${label(axes.runtime)} monolith runs one Rocket.Chat, so --replicas ${want} ` +
        `would silently give you one. Add ${alt}.`,
    );
  }
  // The multi-instance preset's own default.
  if (axes.deployment === MULTI_INSTANCE) return want || 2;
  return want || 1;
}

export interface ResolveAxesOptions {
  runtime?: string;
  deployment?: string;
  replicas?: number;
  preset?: string;
  params?: Record<string, unknown> | null;
}

/**
 * Decide runtime x deployment x scenario, in one place.
 *
 * Every refusal in the matrix lives here rather than at a call site, because the
 * combinations are what a user gets wrong and a rule enforced in two places eventually
 * disagrees with itself.
 *
 * The old spellings are PERMANENT ALIASES, not a deprecation with a deadline: they cost
 * one lookup each, and breaking a command line that is pasted into support tickets buys
 * nothing.
 */
export function resolveAxes(options: ResolveAxesOptions = {}): Axes {
  const { runtime = '', deployment = '', replicas = 0, preset = '', params = null } = options;
  const out: Axes = {
    runtime: DOCKER,
    deployment: MONOLITH,
    replicas: 1,
    preset: 'default',
    params: { ...(params ?? {}) },
    hints: [],
  };
  let rawPreset = String(preset || '').trim() || 'default';
  let rawDeployment = String(deployment || '')
    .trim()
    .toLowerCase();
  // `multi-instance` named among several presets is the deployment axis too, absorbed by the
  // same rule as the single legacy spelling; the rest stay presets.
  const named = namesOf(rawPreset);
  const listed = named.length > 1 && named.includes(LEGACY_MULTI_PRESET);
  const rest = compositeName(named.filter((name) => name !== LEGACY_MULTI_PRESET));

  // `--deployment microservices` with no --runtime implies Kubernetes. There is no other
  // runtime it could mean.
  const implied = own(DEPLOYMENT_ALIASES, rawDeployment) === MICROSERVICES && !runtime;
  out.runtime = implied ? KUBERNETES : normalize(runtime);
  if (implied) out.hints.push('--deployment microservices implies --runtime kubernetes');

  const [legacyN, absorbedDeployment, absorbedPreset] = absorbLegacySpellings(
    out,
    rawDeployment,
    listed ? LEGACY_MULTI_PRESET : rawPreset,
    replicas,
  );
  rawDeployment = absorbedDeployment;
  rawPreset = listed ? rest : absorbedPreset;

  out.deployment = normalizeDeployment(rawDeployment, out.runtime);
  out.preset = rawPreset;

  out.replicas = resolveReplicas(replicas, legacyN, out);
  if (out.deployment === MULTI_INSTANCE) {
    // Reached through the preset loader exactly as before -- see `Axes`. A scenario on top
    // composes with it: every instance gets the scenario's settings, which the compose
    // build applies to each clone.
    out.preset = compositeName([
      ...namesOf(out.preset).filter((name) => name !== 'default'),
      LEGACY_MULTI_PRESET,
    ]);
    // A typed --replicas wins, as it does in `resolveReplicas`: the record's own count, carried
    // back as a param, made `up --force --replicas 4` rebuild a 3-instance workspace with 3.
    if (out.params[LEGACY_REPLICA_PARAM] === undefined || Number(replicas || 0) > 0) {
      out.params[LEGACY_REPLICA_PARAM] = out.replicas;
    }
  }
  return out;
}

/**
 * Refuse a runtime this build cannot yet create.
 *
 * Kept apart from `resolveAxes` on purpose. Resolving answers "what did you ask for", which
 * a GUI needs in order to show Kubernetes as an option that is visible but not yet
 * available; this answers "can I do it", which only the create path asks. Folding them
 * together would mean the GUI could not name a runtime without also failing on it.
 */
export function requireRegistered(runtime: string): void {
  if (isRegistered(runtime)) return;
  throw new ValidationError(
    `${label(runtime)} workspaces are not available in this build yet. Use --runtime docker.`,
  );
}

/**
 * The axes a workspace was created with, as `CreateReq` fields.
 *
 * Two paths rebuild a request from an existing workspace -- `restore` and the GUI's
 * recreate-a-downed-workspace button -- and both used to pass `preset=meta.preset`. For a
 * multi-instance workspace that is the LEGACY spelling, so rebuilding one would print
 * "--preset multi-instance is now --deployment multi-instance" at a user who typed neither
 * and merely clicked Start. Reconstructing the axes properly means the deprecation hint
 * only ever appears for a spelling someone actually used.
 *
 * Workspaces older than the deployment key are not lost: for those the deployment WAS the
 * preset name, which is exactly the ambiguity the split removed going forward.
 */
export function axesOfMeta(meta: HasExtra | null | undefined): Record<string, unknown> {
  const rawExtra = meta?.extra;
  const extra =
    typeof rawExtra === 'object' && rawExtra !== null && !Array.isArray(rawExtra)
      ? (rawExtra as Record<string, unknown>)
      : {};
  const runtime = ofMeta(meta);
  let preset = String(meta?.preset ?? '') || 'default';
  const recorded = String(extra[config.EXTRA_DEPLOYMENT] ?? '')
    .trim()
    .toLowerCase();
  let deployment = own(DEPLOYMENT_ALIASES, recorded) ?? '';
  if (!deployment) {
    deployment =
      preset === LEGACY_MULTI_PRESET
        ? MULTI_INSTANCE
        : ((DEPLOYMENTS[runtime] as readonly string[])[0] as string);
  }
  // It is the deployment axis, not a scenario; any scenarios composed with it stay.
  if (deployment === MULTI_INSTANCE) {
    preset = compositeName(namesOf(preset).filter((name) => name !== LEGACY_MULTI_PRESET));
  }
  // The recorded count read as an integer, 0 when it is absent, empty or not an integer.
  const raw = extra[LEGACY_REPLICA_PARAM];
  const replicas = (raw === undefined || raw === null || raw === '' ? 0 : toInt(raw)) ?? 0;

  // The CLUSTER is an axis too, and leaving it out silently RETARGETS. Both callers rebuild
  // a CreateReq from this -- `restore`, and the GUI's start-a-downed-workspace button --
  // and a request with no context sends `planCluster` back through its own four steps. On a
  // box with the `kind` binary that means step 2: a workspace living in a remote cluster
  // would be rebuilt by BUILDING A LOCAL CLUSTER for it. Empty stays empty, so a workspace
  // older than `--context` keeps resolving exactly as it always did.
  const out: Record<string, unknown> = { runtime, deployment, preset, replicas };
  const context = String(extra[config.EXTRA_CONTEXT] ?? '').trim();
  if (context) out.context = context;
  // Who runs MongoDB is an axis too: rebuilt without it, a workspace whose database the
  // operator runs had houston's own MongoDB applied over it, and the apply failed. Absent
  // otherwise, as `context` is.
  if (extra.mongo_managed_by === 'operator') out.mongoOperator = true;
  return out;
}
