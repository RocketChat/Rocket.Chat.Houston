/**
 * Reading a create request: what runtime it means, what it would provision, what it may
 * not ask for.
 *
 * Tier 0. Pure shaping and refusal -- nothing here writes, and `capacity` depends on it to
 * know whether a create will provision a cluster and therefore whether the cluster overhead
 * counts against this machine.
 */
import * as config from '../../lib/config';

import * as eks from '../eks';
import * as paths from '../runner/paths';
import { shortName } from '../kube/context';
import { ValidationError } from '../../lib/errors';
import { type Emit, info, nullEmit, warn } from '../../lib/events';
import { EMAIL_2FA, truthyParam } from '../../lib/presets/common';
import * as presets from '../../lib/presets/index';
import { namesOf } from '../../lib/presets/composite';
import { type Preset } from '../../lib/presets/types';
import { BUILD_SOURCE, type ReleaseFetcher, type Resolved, lookupUrl } from '../../lib/versions';
import * as topology from '../topology';
import { planCluster } from '../kube/context';
import { releaseInfo } from '../rcapi';

import { premiumSignIn } from './notes';
import {
  BILLABLE_CONTEXT_PREFIXES,
  BROWSER_HOST_PARAM,
  LOOPBACK_BINDS,
  type CreateReq,
} from './types';

/** Truthiness, as a function -- `unknown` may not appear in a conditional. */
function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value !== '';
  if (typeof value === 'number') return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * The release lookup `versions.resolve` makes, made WHERE it has always been made.
 *
 * `resolve` is synchronous and HTTP is not, so its document is fetched first and handed
 * over. It is asked after the name checks, the create lock and the engine preflight -- so
 * every refusal ahead of it (Docker down, compose missing, a bad `--name` or `--env`)
 * answers without touching the network. `up` fetched
 * right after parsing `--set`, ahead of all of them, so each of those refusals waited on a
 * request first, for its whole 5 s timeout on a network that drops packets.
 * Offline, or a version `resolve` refuses before going online, asks nothing; a fetcher a
 * caller injected is used as given.
 */
export async function releaseFetcher(
  version: string,
  offline: unknown,
  given?: ReleaseFetcher,
): Promise<ReleaseFetcher | undefined> {
  if (given !== undefined) return given;
  const url = isTruthy(offline) ? null : lookupUrl(version);
  if (url === null) return undefined;
  const fetched = await releaseInfo(url);
  return () => fetched;
}

/**
 * The image to run, on either runtime: `--rc-image`, else the box-wide `rc_image` (config.yaml
 * or HOUSTON_RC_IMAGE), else the resolved one. A CI build's own image is not replaced by the
 * box-wide setting, which points RELEASES at a mirror; the flag still wins.
 */
export function chooseImage(resolved: Resolved, flag: string, boxImage: unknown): void {
  if (flag) resolved.rcImage = flag;
  else if (isTruthy(boxImage) && resolved.source !== BUILD_SOURCE) {
    resolved.rcImage = String(boxImage);
  }
}

/**
 * An Enterprise licence as Rocket.Chat issues it: V2 base64, or V3 `RCV3_...`. The character
 * set is also what keeps it to one line, so it cannot add variables to the env file it is
 * written to.
 */
export const LICENSE_RE = /^[A-Za-z0-9+/=_.-]{1,65536}$/u;

/** The licence text, trimmed, or a refusal that never repeats it. */
export function requireLicense(text: string): string {
  const trimmed = text.trim();
  if (!LICENSE_RE.test(trimmed)) {
    throw new ValidationError(
      '--license does not hold a Rocket.Chat license: want the text Rocket.Chat issued (base64, ' +
        'or starting RCV3_), on one line, at most 64 KiB',
    );
  }
  return trimmed;
}

/**
 * Warn when a voice workspace has no licence, or ''. Rocket.Chat 8 has no setting that switches
 * Voice on: a licence carrying the Voice add-on does. Not a refusal -- one can be applied to the
 * running workspace later -- but without it there is nothing to try.
 */
export function voiceLicenceWarning(
  presetNames: readonly string[],
  licensed: boolean,
  regToken: string,
): string {
  if (licensed || regToken !== '') return '';
  if (!presetNames.flatMap((name) => namesOf(name)).includes('voice')) return '';
  return (
    'the voice preset needs a license with the Voice add-on (teams-voip), and this workspace ' +
    'has neither --license nor --reg-token: it boots, but Rocket.Chat shows no call button ' +
    'until one is applied in Administration → Subscription.'
  );
}

/**
 * Warn when a workspace's login preset will be refused on Rocket.Chat 9 for want of a licence,
 * or ''. A warning, not a refusal: the workspace still boots, and a licence can be added later.
 * Worded for both front-ends: the GUI's job shows it too.
 */
export function premiumAuthWarning(
  pre: Pick<Preset, 'name' | 'postReady'>,
  rcVersion: string,
  licensed: boolean,
  regToken: string,
): string {
  const gate = licensed || regToken !== '' ? null : premiumSignIn(pre, rcVersion);
  if (gate === null) return '';
  return (
    `Rocket.Chat 9.0 and later refuse ${gate.kinds} login without a Premium plan (a license ` +
    `carrying ${gate.modules}), and this workspace has neither a license nor a registration ` +
    `token: logins through the ${gate.through} preset will be refused. Give it one when ` +
    "creating (--license or --reg-token; in the GUI, Add a license), or add one later as the workspace's notes say."
  );
}

/**
 * Warn when a SAML login and the email preset are combined, or ''. With email two-factor on, Rocket.Chat asks a
 * SAML login for the emailed code and refuses the right code, on every version measured: 8.5.1
 * and 8.9.0, the latest, in a real browser with the first code entered at once. Its words
 * differ (the API's "User not found", the 8.5.1 browser's "Invalid two factor code"), so the
 * warning quotes neither. 8.9.0's handler keeps the SAML credential for the retry
 * (`server/lib/saml/loginHandler.ts`), which is why this once said 8.9.0 fixed it; it does
 * not. Resend sends nothing because the client's dialog asks for the user named by the SAML
 * token (`client/lib/2fa/overrideLoginMethod.ts`). Silent once the user sets the 2FA key.
 */
export function samlEmailWarning(
  pre: Pick<Preset, 'name' | 'postReady'>,
  rcVersion: string,
  overridden: ReadonlySet<string>,
): string {
  // SAML by what the preset sets up, not by its name: `ldap --set idp=saml` signs its
  // directory users in through Keycloak's SAML too.
  const saml = pre.postReady.some((action) => action.action === 'saml_idp_cert');
  if (!saml || !namesOf(pre.name).includes('email')) return '';
  if (overridden.has(EMAIL_2FA)) return '';
  return (
    `SAML sign-in + email on Rocket.Chat ${rcVersion}: email two-factor is on, and Rocket.Chat ` +
    'refuses the code it emails to a SAML login, so the sign-in cannot finish (seen on 8.5.1 ' +
    "and 8.9.0); the dialog's Resend email sends nothing after a SAML login either. " +
    'To sign in through SAML, add --setting ' +
    'Accounts_TwoFactorAuthentication_By_Email_Enabled=false.'
  );
}

/**
 * A rebuild reachable from other machines that keeps the shared admin password, or ''. The
 * password stays what the database holds (`keptAdminPassword`), so a loopback workspace
 * brought back with --domain or a wide --bind is public with the shared one: said, since a
 * generated one would be printed and refused.
 */
export function keptSharedPasswordWarning(
  name: string,
  kept: string | null,
  reachable: boolean,
): string {
  if (kept !== '' || !reachable) return '';
  return (
    `'${name}' is reachable from other machines and keeps the admin password its database ` +
    `was made with, ${config.ADMIN_PASSWORD}: Rocket.Chat sets it only on an empty database. ` +
    'Change it in Rocket.Chat, or rebuild the workspace with its data wiped to get a generated one.'
  );
}

/** The URL's hostname, or "" when it has none. */
function urlHostname(value: string): string {
  if (!value) return '';
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

/**
 * Whether this create is going to CREATE a cluster, as opposed to use one.
 *
 * The two capacity questions below both turn on it, and both used to ask something
 * narrower that gave the wrong answer the moment houston could use a cluster it did not
 * make: `clusterExists` is specifically OUR kind cluster, so a box whose k3s was about
 * to be adopted was billed 600 MB for a control plane already running.
 *
 * False on any doubt. An unprobeable cluster is not evidence that one will be built.
 */
export async function willProvision(req: CreateReq): Promise<boolean> {
  if (topology.normalize(req.runtime) !== topology.KUBERNETES) return false;
  try {
    // The request's context, or this answers for the WRONG cluster: with `kind`
    // installed, an un-passed context makes `planCluster` plan a kind create and return
    // true, so `checkCapacity` would reserve a control plane's RAM for a workspace going
    // to a cluster that already exists somewhere else.
    return (await planCluster(reqContext(req))).create;
  } catch {
    // No cluster and no kind: the create will refuse.
    return false;
  }
}

/**
 * The runtime this request means, with a context taken as saying Kubernetes.
 *
 * A CONTEXT IS A KUBERNETES WORD. Somebody who typed `--context <an eks arn>` has already
 * said where this runs. Only from an EXPLICIT `--context`, never from the box default: a
 * default cluster is a convenience for the Kubernetes work somebody already does, and
 * letting it silently move `up` off Compose would change what an un-flagged command means
 * for every workspace on the box.
 */
export function inferRuntime(req: CreateReq): string {
  const named = String(req.runtime).trim();
  if (named) return named;
  if (String(req.context).trim()) return topology.KUBERNETES;
  return named;
}

/**
 * Say out loud when a SAVED setting decided where this workspace goes.
 *
 * `kubernetes.context` changes what other commands mean and nothing ever mentioned it,
 * which produced two opposite complaints from the same silence. Both are the same defect:
 * a stored setting that decides something, with nothing on screen saying it did. Neither
 * is a refusal -- this reports, and the operator decides.
 *
 * An explicit `--context` says nothing here: naming the cluster on the command line is
 * already the unambiguous form.
 */
export function sayWhereThisIsGoing(
  req: CreateReq,
  typedRuntime: string,
  emit: Emit = nullEmit,
): void {
  const saved = config.defaultKubeContext();
  if (!saved || String(req.context).trim()) return;
  if (topology.normalize(req.runtime) === topology.KUBERNETES) {
    // Only when it COSTS: a saved kind or k3s context being used by `--runtime
    // kubernetes` is the whole point of saving one, and warning about it every time
    // would train people to stop reading these.
    if (savedDefaultIsBillable(saved)) {
      warn(
        emit,
        `this workspace is going to '${saved}', which costs money by the ` +
          "hour — it was chosen because it is this box's saved default " +
          'cluster, not because this command named one. `--context <name>` ' +
          'names a cluster outright; `houston config set ' +
          "kubernetes.context ''` clears the default.",
        { phase: 'preflight' },
      );
    }
    return;
  }
  if (typedRuntime) return; // they said `--runtime docker`; they are not confused
  info(
    emit,
    `this workspace is going to Docker. '${saved}' is saved as this box's ` +
      'default cluster, but a plain `up` never uses it — add `--runtime ' +
      'kubernetes` to send this one there, or `--context <name>` to name a ' +
      'cluster outright.',
    { phase: 'preflight' },
  );
}

/**
 * Whether a saved context names a cluster somebody is paying for.
 *
 * Read from the CONTEXT NAME, never by probing. This runs on the way into every create,
 * including Compose ones, and a create that pauses to ask a cloud API which kind of
 * cluster it is not about to use has bought nothing at a real price.
 */
export function savedDefaultIsBillable(context: string): boolean {
  const low = context.trim().toLowerCase();
  return BILLABLE_CONTEXT_PREFIXES.some((prefix) => low.startsWith(prefix));
}

/**
 * Which cluster this request names, falling back to the box's default.
 *
 * ONE function because two callers need the same answer and disagreeing is a real failure
 * rather than an untidiness: `willProvision` decides whether `checkCapacity` reserves a
 * control plane's RAM, and `createKubernetes` decides where the workspace actually goes.
 */
export function reqContext(req: CreateReq): string {
  const named = String(req.context).trim();
  return named || config.defaultKubeContext();
}

/** The params the preset neither documents nor takes as an earlier spelling, sorted. */
export function unknownParams(params: Record<string, unknown>, pre: Preset): string[] {
  return Object.keys(params)
    .filter((key) => !takesParam(pre, key))
    .sort();
}

/** Whether `pre` reads `key`: documented, or a spelling an earlier release documented. */
function takesParam(pre: Preset, key: string): boolean {
  return Object.hasOwn(pre.paramsHelp, key) || Object.hasOwn(pre.paramAliases, key);
}

/**
 * `--set` routed to the presets of a composed workspace: `ldap.users=5`, or plain `users=5`
 * when exactly one selected preset takes `users`. Two that take it is a refusal naming the
 * qualified forms, never a guess.
 */
export function paramsByPreset(
  names: readonly string[],
  params: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const loaded = Object.fromEntries(
    names.map((name) => [name, presets.asValidation(() => presets.load(name, {}))]),
  );
  // A key is routed as typed, an earlier spelling included: the record keeps what was typed,
  // and the preset reads it through its aliases (both spellings at once is its refusal).
  const takes = (name: string, key: string): boolean => {
    const pre = loaded[name];
    return pre !== undefined && takesParam(pre, key);
  };
  const out: Record<string, Record<string, unknown>> = Object.fromEntries(
    names.map((name) => [name, {}]),
  );
  const valid = names.flatMap((name) =>
    Object.keys(loaded[name]?.paramsHelp ?? {}).map((key) => `${name}.${key}`),
  );
  for (const [raw, value] of Object.entries(params)) {
    const dot = raw.indexOf('.');
    const qualifier = dot > 0 ? raw.slice(0, dot) : '';
    const target = out[qualifier];
    if (target !== undefined && takes(qualifier, raw.slice(dot + 1))) {
      target[raw.slice(dot + 1)] = value;
      continue;
    }
    const owners = names.filter((name) => takes(name, raw));
    if (owners.length === 1) {
      (out[owners[0] as string] as Record<string, unknown>)[raw] = value;
      continue;
    }
    if (owners.length > 1) {
      throw new ValidationError(
        `--set ${raw} is taken by more than one preset; say which: ` +
          owners.map((name) => `--set ${name}.${raw}=...`).join(' or '),
      );
    }
    throw new ValidationError(
      `unknown --set param ${raw} for presets ${names.map((name) => `'${name}'`).join(', ')} - ` +
        `valid: ${valid.sort().join(', ') || '(none of them takes --set params)'}`,
    );
  }
  return out;
}

/**
 * `--set ldap.users=5` for ldap alone, as `users=5`: the spelling a set takes names the same
 * parameter, and one preset refused it as unknown. Several presets are left to
 * `paramsByPreset`, and another preset's name stays as typed, to be refused.
 */
export function unqualifiedParams(
  preset: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const names = namesOf(preset);
  if (names.length > 1) return params;
  const prefix = `${names[0] as string}.`;
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key.startsWith(prefix) ? key.slice(prefix.length) : key,
      value,
    ]),
  );
}

/** Refuse a `--set` the preset does not take, on either runtime, naming the valid ones. */
export function refuseUnknownParams(
  params: Record<string, unknown>,
  pre: Preset,
  name: string,
): void {
  const unknown = unknownParams(params, pre);
  if (unknown.length === 0) return;
  const valid =
    Object.keys(pre.paramsHelp).sort().join(', ') || '(this preset takes no --set params)';
  throw new ValidationError(
    `unknown --set param(s) for preset '${name}': ${unknown.join(', ')} - valid: ${valid}`,
  );
}

/**
 * The interface these ports will be published on, as far as is known this early.
 *
 * `req.bindPublic` can still widen it later -- `resolveTls` sets that when an ACME
 * challenge needs the host reachable -- so this is the REQUESTED bind, not the final one.
 * Callers that must not over-promise use it in the conservative direction: loopback here
 * means "do not assume anything is reachable".
 */
/** A bind that means every interface, where the port is also on loopback. */
const WILDCARD_BINDS: readonly string[] = ['0.0.0.0', '::', '[::]', '*'];

/**
 * The address houston calls a workspace on, given what its port is published on.
 *
 * `localhost` for loopback and for a wildcard, which includes loopback. A single other
 * address is the ONLY place the port exists: `--bind 172.17.0.1` published nothing on
 * loopback, so readiness, the admin login and every API call aimed at `localhost` found
 * nobody, and `up --wait` always ended exit 5 while Rocket.Chat served on the bridge.
 */
export function callHost(bindHost: string): string {
  const bind = bindHost.trim();
  if (bind === '' || LOOPBACK_BINDS.includes(bind) || WILDCARD_BINDS.includes(bind)) {
    return 'localhost';
  }
  return bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind;
}

/** Whether a bind publishes on every interface, which is what the exposure warning says. */
export function bindsEverywhere(bindHost: string): boolean {
  return WILDCARD_BINDS.includes(bindHost.trim());
}

export function requestedBindHost(req: CreateReq): string {
  const cfg = config.loadConfig();
  if (req.bind) return String(req.bind);
  if (isTruthy(cfg.bind_host)) return String(cfg.bind_host);
  return config.DEFAULT_BIND_HOST;
}

/**
 * Default a preset's browser-facing hostname from the URL the browser will use.
 *
 * `--root-url https://rc.example.com` and `--domain rc.example.com` both say, in as many
 * words, "people will type this". The saml/oidc presets otherwise send the browser to
 * `localhost:8081` / `keycloak:8085`, and `s3_minio` in presigned mode hands it
 * `minio:9000` -- all of which name the visitor's own laptop.
 *
 * Explicit `--set` always wins; nothing is derived for a workspace nobody said would be
 * reached from elsewhere.
 */
export function deriveIdpHost(req: CreateReq, emit: Emit = nullEmit): void {
  // Each preset of a composed workspace, under its qualified key (`saml.idp_host`).
  const names = namesOf(req.preset);
  for (const name of names) deriveOne(req, name, names.length > 1 ? `${name}.` : '', emit);
}

function deriveOne(req: CreateReq, preset: string, prefix: string, emit: Emit): void {
  const param = BROWSER_HOST_PARAM[preset];
  if (param === undefined) return;
  const key = `${prefix}${param}`;
  const params: Record<string, unknown> = { ...req.params };
  // EITHER SPELLING is the user's. In a combination a plain `--set idp_host=...` is routed
  // to the one preset that takes it -- after this ran, so the derived `saml.idp_host` won,
  // and the workspace pointed the browser at the root URL's host instead of the IdP typed.
  if (isTruthy(params[key]) || (prefix !== '' && isTruthy(params[param]))) return;
  // s3_minio ONLY in presigned mode. In the default proxy mode the browser never touches
  // MinIO -- Rocket.Chat streams the bytes -- so `minio:9000` is reached over the compose
  // network, which is strictly more reliable than a host address.
  if (preset === 's3_minio' && !truthyParam(params, `${prefix}presigned`)) return;
  // A HOST IS ONLY WORTH DERIVING IF IT CAN BE REACHED, and with the default loopback
  // bind it cannot -- by anything, including Rocket.Chat's own container. OIDC's url
  // serves the browser AND RC's backend, so deriving it here would have moved the backend
  // off compose DNS onto an address nothing can reach, turning one broken leg into two.
  if (LOOPBACK_BINDS.includes(requestedBindHost(req))) return;
  const source = req.rootUrl || (req.domain ? `https://${req.domain}` : '');
  const host = urlHostname(source);
  if (!host || host === 'localhost' || host === '127.0.0.1') return;
  params[key] = host;
  req.params = params;
  info(
    emit,
    `the ${preset} preset will address its own service as '${host}', ` +
      'taken from the URL you gave — that is the name the browser follows, ' +
      'and its default names only the machine running houston. Override with ' +
      `\`--set ${key}=...\`.`,
    { phase: 'create' },
  );
}

/**
 * The default for create's `monitorAttach` hook.
 *
 * A create may be asked for monitoring, and the thing that knows how to attach it lives a
 * layer up -- so the parameter defaults to a refusal rather than to `null`, and a caller
 * that forgets gets a ValidationError naming the omission instead of a TypeError deep
 * inside the k8s branch.
 */
export function missingMonitorAttach(_name: string, _emit: Emit): Record<string, unknown> {
  throw new ValidationError('monitoring attachment was not supplied by the caller');
}

/**
 * A public name for a workspace on a cluster that carries a DNS zone, when none was typed.
 *
 * The zone is known once, on the cluster; every ticket typed it again as `--domain
 * ticket-1234.rc.example.com`. `<name>.<zone>` is what that always was. Said out loud,
 * because a name that appears on its own is a name nobody chose; `--domain` still wins,
 * and a cluster with no zone changes nothing.
 */
export async function defaultDomainFromZone(
  req: CreateReq,
  name: string,
  emit: Emit = nullEmit,
): Promise<void> {
  if (String(req.domain).trim() !== '' || String(req.context).trim() === '') return;
  // ONLY A NEW WORKSPACE. `down` then `up` brings one back with what it had, and its
  // recorded name (restored later, from the record) is part of that; a default here moved
  // a workspace made with its own --domain to <name>.<zone> and a new certificate.
  if (await paths.exists(name)) return;
  const cluster = shortName(String(req.context).trim());
  const zone = eks.zoneOf(cluster);
  if (zone === '') return;
  req.domain = `${name}.${zone}`;
  info(
    emit,
    `public name defaulted to ${req.domain} from cluster ${cluster}'s zone — ` +
      '`--domain <name>` chooses another',
    { phase: 'preflight' },
  );
}
