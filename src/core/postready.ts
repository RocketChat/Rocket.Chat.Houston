/**
 * Post-ready preset self-configuration, moved out of the CLI so both front ends run it
 * identically. Each handler reports via `emit` instead of printing.
 *
 * Behaviour is unchanged from the CLI's former post-ready handlers; only the output
 * mechanism differs (Event objects rather than printed lines and warnings).
 *
 * Every handler returns a BOOLEAN, and `runPostReady` collects the ones that answered
 * false. That is the whole point of the module's shape: a create that printed "could not
 * fetch/apply IdP cert" and then "starting" left the reader to work out for themselves
 * whether SAML actually worked -- the deployment succeeding and the configuration
 * succeeding are different answers to different questions.
 */
import { namesOf } from '../lib/presets/composite';
import { E2EE_TEST_USERS } from '../lib/presets/e2ee';
import { VOICE_TEST_USERS } from '../lib/presets/voice';
import * as config from '../lib/config';
import { quotedText } from '../lib/format';
import { type Emit, info, warn } from '../lib/events';
import { cleanup, sleep as interruptibleSleep } from '../seams/exec';

import { kube } from './kube/exec';
import { APPLY_TIMEOUT, CONTEXT, isOurs } from './kube/names';
import { namespaceFor } from './kube/namespace';
import * as rcapi from './rcapi';
import { composeExec } from './runner/engine';
import { adminPass, type Metadata, updateMeta } from './runner/record';
import * as topology from './topology';

/**
 * How long to wait for Keycloak to serve its SAML descriptor.
 *
 * Passed INTO `fetchSamlIdpCert`, which owns the retrying -- not layered on top of it.
 * Generous because on Kubernetes the image is pulled before the realm is imported.
 */
export const IDP_CERT_DEADLINE = 180.0;

/** One entry of a preset's `post_ready` list, as it is read back out of `repro.json`. */
export type Action = Record<string, unknown>;

/**
 * The sleep is an injected function with a real default, so a spec can replace it. The
 * production call sites pass nothing.
 */
export type Sleep = (seconds: number) => Promise<void>;

const realSleep: Sleep = (seconds) => interruptibleSleep(seconds * 1000);

export interface Options {
  readonly sleep?: Sleep;
}

/** Truthiness: false for null, undefined, false, 0, '', [] and {}. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === true) return true;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * `meta.extra` when it is a mapping, else `{}`.
 *
 * The declared type says this cannot fail, and the declared type is optimistic: `extra`
 * is copied verbatim out of `repro.json` by `record.fromDocument`, so a hand-edited or
 * half-written record can hold a list, a string or null there and still satisfy the
 * compiler. Routed through `unknown` so the check is against what is on disk rather than
 * against what the annotation claims.
 */
function bagOf(value: Record<string, unknown>): Record<string, unknown> {
  const raw: unknown = value;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return raw as Record<string, unknown>;
}

/**
 * `action["key"]` -- absent raises, rather than quietly becoming the string "undefined".
 *
 * A preset that names a `post_ready` action without the fields that action needs is a
 * broken preset, and it has always been refused, naming the key. Coercing the missing value
 * instead would PATCH a Rocket.Chat setting to the literal text `undefined` and report
 * success.
 */
function required(action: Action, key: string): unknown {
  if (!(key in action)) throw new Error(`a post_ready action is missing ${JSON.stringify(key)}`);
  return action[key];
}

/** The key's value, or `fallback` -- keyed on PRESENCE, so an explicit falsy value survives. */
function getOr(action: Action, key: string, fallback: unknown): unknown {
  return key in action ? action[key] : fallback;
}

/** An integer: a number truncated toward zero, a boolean as 1 or 0, text as signed digits. */
function toInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RangeError(`${String(value)} is not an integer`);
    return Math.trunc(value);
  }
  const text = String(value ?? '').trim();
  if (!/^[+-]?\d+$/u.test(text)) {
    throw new RangeError(`'${text}' is not an integer`);
  }
  return Number.parseInt(text, 10);
}

/**
 * `quotedText(meta.preset)` in the summary below. Re-exported rather than re-implemented: the
 * quoting rule is the established one and there is one place here that spells it.
 */
export { quotedText };

/**
 * Run a command in a preset's side service, on either runtime.
 *
 * A post_ready action is a preset configuring ITSELF, and presets now exist on both
 * runtimes -- so the one call that reaches into a container had to stop being a Compose
 * call. `composeExec` on a Kubernetes workspace answers "no configuration file provided:
 * not found" -- docker compose's own words for "there is no compose project here" --
 * printed raw, in the middle of a create that then said it succeeded.
 */
export async function execIn(
  meta: Metadata,
  service: string,
  argv: readonly string[],
): Promise<number | null> {
  if (topology.ofMeta(meta) !== topology.KUBERNETES) {
    return await composeExec(meta.name, service, argv);
  }
  const extra = bagOf(meta.extra);
  const ctxValue = extra[config.EXTRA_CONTEXT];
  const context = String(truthy(ctxValue) ? ctxValue : CONTEXT);
  const nsValue = extra.namespace;
  // Asked only when none is recorded: asking kubectl to mint the namespace name for a
  // workspace that already recorded one is a subprocess spent on an answer that was
  // already on disk.
  const namespace = String(truthy(nsValue) ? nsValue : await namespaceFor(meta.name));
  const pod = await kube.run(
    [
      'kubectl',
      '--context',
      context,
      '-n',
      namespace,
      'get',
      'pod',
      '-l',
      `app=houston-${service}`,
      '-o',
      'jsonpath={.items[0].metadata.name}',
    ],
    { own: isOurs(context) },
  );
  const target = (pod.stdout || '').trim();
  if (!target) return 1;
  const res = await kube.run(
    ['kubectl', '--context', context, '-n', namespace, 'exec', target, '--', ...argv],
    { timeout: APPLY_TIMEOUT, own: isOurs(context) },
  );
  return res.returncode;
}

/** The front door and each independently cached Rocket.Chat instance behind it. */
function providerRoots(meta: Metadata): string[] {
  const roots = [meta.rootUrl];
  if (topology.ofMeta(meta) === topology.KUBERNETES) return roots;
  const count = Number(bagOf(meta.extra).instances ?? 1);
  for (let i = 1; Number.isInteger(count) && count > 1 && i <= count; i += 1) {
    const own = new URL(meta.rootUrl);
    own.port = String(meta.hostPort + i);
    roots.push(own.origin);
  }
  return roots;
}

async function samlProvidersReady(
  meta: Metadata,
  auth: rcapi.Auth,
  roots: readonly string[],
  timeoutMs = 3_000,
): Promise<boolean> {
  const ready = await Promise.all(
    roots.map(
      async (root) =>
        await rcapi.samlProviderReady(root, {
          auth,
          publicUrl: meta.publicUrl || meta.rootUrl,
          timeoutMs,
        }),
    ),
  );
  return ready.every((ok) => ok);
}

async function waitForSamlProviders(
  meta: Metadata,
  auth: rcapi.Auth,
  roots: readonly string[],
  sleep: Sleep,
  { maxWaitMs }: { maxWaitMs?: number } = {},
): Promise<boolean> {
  const deadline = maxWaitMs === undefined ? undefined : Date.now() + maxWaitMs;
  let stable = false;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const remaining = deadline === undefined ? undefined : deadline - Date.now();
    if (remaining !== undefined && remaining <= 0) return false;
    // One probe makes two sequential requests; roots are observed in parallel. Keep
    // their combined request budget inside the pre-mutation observation deadline.
    const timeoutMs = remaining === undefined ? 3_000 : Math.min(3_000, remaining / 2);
    const all = await samlProvidersReady(meta, auth, roots, timeoutMs);
    if (deadline !== undefined && Date.now() >= deadline) return false;
    // HTTP can answer before Rocket.Chat's initial debounced SAML load completes.
    // Observe every process across a reload interval, without changing its settings.
    if (all && stable) return true;
    stable = all;
    if (attempt < 11) {
      const pause = deadline === undefined ? 3 : Math.min(3, (deadline - Date.now()) / 1000);
      if (pause <= 0) return false;
      await sleep(pause);
    }
  }
  return false;
}

async function registerSamlProvider(
  meta: Metadata,
  auth: rcapi.Auth,
  roots: readonly string[],
  enable: string,
  emit: Emit,
  sleep: Sleep,
): Promise<boolean> {
  const apply = async (value: boolean): Promise<boolean> => {
    const applied = await Promise.all(
      roots.map(async (root) => await rcapi.setSetting(root, auth, adminPass(meta), enable, value)),
    );
    return applied.every((ok) => ok);
  };
  const provider = await rcapi.getSetting(
    meta.rootUrl,
    auth,
    adminPass(meta),
    `${enable}_provider`,
  );
  if (typeof provider !== 'string' || provider === '') {
    warn(emit, `could not read ${enable}_provider to refresh the SAML provider`, {
      phase: 'post_ready',
    });
    return false;
  }
  // A disabled reload deletes a shared service before updating this process's provider
  // list. Waiting a fixed debounce interval does not prove slower replicas completed
  // that reload: one could remove the service after another had enabled it again.
  let stable = false;
  let disabled = false;
  let enabled: boolean;
  try {
    if (!(await apply(false))) {
      warn(emit, `could not disable ${enable} to refresh the SAML provider`, {
        phase: 'post_ready',
      });
      return false;
    }
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const states = await Promise.all(
        roots.map(
          async (root) =>
            await rcapi.samlProviderState(root, provider, {
              publicUrl: meta.publicUrl || meta.rootUrl,
            }),
        ),
      );
      const all = states.every((state) => state === 'unloaded');
      if (all && stable) {
        disabled = true;
        break;
      }
      stable = all;
      if (attempt < 11) await sleep(3);
    }
  } finally {
    // Restore after a partial write, observation failure or interruption, as well as a
    // timeout. Cleanup can send this compensating request while cancellation unwinds.
    enabled = await cleanup(async () => await apply(true));
    if (!enabled)
      warn(emit, `could not enable ${enable}; the SAML login service is not ready`, {
        phase: 'post_ready',
      });
  }
  if (!enabled) return false;
  if (!disabled) {
    warn(emit, 'SAML provider reload did not finish disabling on every instance', {
      phase: 'post_ready',
    });
    return false;
  }
  if (await waitForSamlProviders(meta, auth, roots, sleep)) return true;
  warn(emit, 'IdP cert applied, but the SAML login service did not register on every instance', {
    phase: 'post_ready',
  });
  return false;
}

async function prSamlIdpCert(
  meta: Metadata,
  auth: rcapi.Auth,
  action: Action,
  emit: Emit,
  sleep: Sleep,
): Promise<boolean> {
  info(emit, 'fetching IdP cert (Keycloak first boot can take ~30s)...', { phase: 'post_ready' });
  // ONE call. `fetchSamlIdpCert` already retries to its own deadline -- its docstring says
  // "Retries until the IdP (e.g. Keycloak, which boots slowly) is serving" -- and v0.54.1
  // wrapped it in a second 20-attempt loop without reading that. 20 x 90s is thirty
  // minutes of a create that looks hung, which is how the operational audit found it: the
  // SAML workspace sat in "still waiting for the IdP to serve its descriptor" for half an
  // hour.
  //
  // The deadline is raised instead, and only here: Keycloak on Kubernetes has to pull its
  // image before it can boot, which the Compose default did not allow for.
  const cert = await rcapi.fetchSamlIdpCert(String(required(action, 'descriptor_url')), {
    timeout: IDP_CERT_DEADLINE,
  });
  if (!truthy(cert)) {
    warn(emit, 'could not fetch/apply IdP cert (is the IdP up?)', { phase: 'post_ready' });
    return false;
  }
  const roots = providerRoots(meta);
  const setting = String(required(action, 'setting'));
  const enable = action.enable_setting;
  // A restarted process can serve HTTP before its initial SAML load finishes. If the
  // certificate is unchanged, let that registration finish before deciding it needs
  // repair: a toggle schedules independent async reloads against a shared service.
  // A provider that stays absent reaches the existing observed reload path below.
  if (
    truthy(enable) &&
    (await rcapi.getSetting(meta.rootUrl, auth, adminPass(meta), setting)) === cert &&
    (await waitForSamlProviders(meta, auth, roots, sleep, { maxWaitMs: 33_000 }))
  ) {
    // Nothing was written, so nothing was "applied".
    info(emit, 'IdP cert already in place; SAML login button registered.', {
      phase: 'post_ready',
    });
    return true;
  }
  const applied = await Promise.all(
    roots.map(async (root) => await rcapi.setSetting(root, auth, adminPass(meta), setting, cert)),
  );
  if (!applied.every((ok) => ok)) {
    warn(emit, 'could not fetch/apply IdP cert (is the IdP up?)', { phase: 'post_ready' });
    return false;
  }
  if (
    truthy(enable) &&
    !(await registerSamlProvider(meta, auth, roots, String(enable), emit, sleep))
  ) {
    return false;
  }
  info(emit, 'IdP cert applied; SAML login button registered.', { phase: 'post_ready' });
  return true;
}

async function prKeycloakMasterSslOff(
  meta: Metadata,
  _auth: rcapi.Auth,
  action: Action,
  emit: Emit,
  _sleep: Sleep,
): Promise<boolean> {
  const svc = String(getOr(action, 'service', 'keycloak'));
  const port = getOr(action, 'port', 8080);
  // Under the workspace's HTTPS name Keycloak serves from a path (`lib/presets/public.ts`).
  const base = String(getOr(action, 'path', ''));
  const kcadm = '/opt/keycloak/bin/kcadm.sh';
  const script =
    `${kcadm} config credentials --server http://localhost:${String(port)}${base} ` +
    // Both streams: its "Logging into ... as user admin" goes to stderr, which a Docker exec
    // shares with houston's own -- under `up --json` and on serve's console.
    `--realm master --user admin --password admin >/dev/null 2>&1 && ` +
    `${kcadm} update realms/master -s sslRequired=NONE`;
  // Through whichever runtime owns this workspace -- see `execIn`.
  if ((await execIn(meta, svc, ['bash', '-lc', script])) === 0) {
    info(emit, 'Keycloak admin console enabled over HTTP.', { phase: 'post_ready' });
    return true;
  }
  warn(
    emit,
    'could not relax Keycloak master-realm sslRequired ' +
      '(is Keycloak up yet?) - the admin console may reject HTTP',
    { phase: 'post_ready' },
  );
  return false;
}

/** Apply each setting; return the ids that did not take. */
async function applySettings(
  meta: Metadata,
  auth: rcapi.Auth,
  settings: Record<string, unknown>,
): Promise<string[]> {
  const failed: string[] = [];
  for (const [sid, val] of Object.entries(settings)) {
    if (!(await rcapi.setSetting(meta.rootUrl, auth, adminPass(meta), sid, val))) failed.push(sid);
  }
  return failed;
}

/** Observe the public login service on each independently cached RC process. */
async function oauthProvidersReady(
  roots: readonly string[],
  provider: string,
  auth: rcapi.Auth,
  timeoutMs: number,
): Promise<boolean> {
  const ready = await Promise.all(
    roots.map(async (root) => {
      try {
        const [status, text] = await rcapi.call(root, 'GET', '/api/v1/service.configurations', {
          auth,
          timeoutMs,
        });
        if (status !== 200) return false;
        const parsed: unknown = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object') return false;
        const configurations = (parsed as Record<string, unknown>).configurations;
        return (
          Array.isArray(configurations) &&
          configurations.some(
            (entry: unknown) =>
              entry !== null &&
              typeof entry === 'object' &&
              (entry as Record<string, unknown>).service === provider,
          )
        );
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof rcapi.RequestFailed) return false;
        throw error;
      }
    }),
  );
  return ready.every((ok) => ok);
}

/** Configure the disabled custom provider before enabling its debounced RC loader. */
async function prCreateOauthProvider(
  meta: Metadata,
  auth: rcapi.Auth,
  action: Action,
  emit: Emit,
  sleep: Sleep,
): Promise<boolean> {
  const name = String(required(action, 'name'));
  if (!(await rcapi.addOauthService(meta.rootUrl, auth, adminPass(meta), name))) {
    warn(emit, 'could not create the OAuth provider', { phase: 'post_ready' });
    return false;
  }
  const settings = { ...(required(action, 'settings') as Record<string, unknown>) };
  const enable = `Accounts_OAuth_Custom-${name}`;
  const enableValue = settings[enable];
  const hasEnable = enable in settings;
  if (hasEnable) delete settings[enable];
  // RC creates a disabled provider. Enabling before its URL exists can make the
  // asynchronous CustomOAuth constructor throw, even though every PATCH answers 200.
  // Keep an existing enabled provider enabled: a healthy ready must not toggle it off.
  let failed = await applySettings(meta, auth, settings);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (failed.length === 0) break;
    await sleep(2);
    const subset: Record<string, unknown> = {};
    for (const key of failed) subset[key] = settings[key];
    failed = await applySettings(meta, auth, subset);
  }
  if (failed.length === 0 && hasEnable) {
    if (!(await rcapi.setSetting(meta.rootUrl, auth, adminPass(meta), enable, enableValue))) {
      failed.push(enable);
    }
  }
  if (failed.length > 0) {
    const named = [...failed].sort().slice(0, 4).join(', ');
    warn(
      emit,
      `the OAuth provider exists but ${failed.length} of its ` +
        `${Object.keys(settings).length + (hasEnable ? 1 : 0)} settings did not apply: ` +
        `${named}${failed.length > 4 ? '…' : ''}. Its login button may be absent ` +
        `or lead nowhere.`,
      { phase: 'post_ready' },
    );
    return false;
  }
  if (enableValue === true) {
    const roots = providerRoots(meta);
    const provider = name.toLowerCase().replace(/[^a-z0-9_]/gu, '');
    const deadline = Date.now() + 33_000;
    let registered = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const ready = await oauthProvidersReady(roots, provider, auth, Math.min(3_000, remaining));
      if (Date.now() > deadline) break;
      if (ready) {
        registered = true;
        break;
      }
      if (attempt < 11) {
        const pause = Math.min(3, (deadline - Date.now()) / 1000);
        if (pause <= 0) break;
        await sleep(pause);
      }
    }
    if (!registered) {
      warn(
        emit,
        'OAuth settings applied, but the login service did not register on every instance',
        {
          phase: 'post_ready',
        },
      );
      return false;
    }
  }
  info(emit, 'OIDC provider created and configured; login button registered.', {
    phase: 'post_ready',
  });
  return true;
}

async function prLivechatSetup(
  meta: Metadata,
  auth: rcapi.Auth,
  action: Action,
  emit: Emit,
  _sleep: Sleep,
): Promise<boolean> {
  const url = meta.rootUrl;
  const pw = adminPass(meta);
  const agents: { agentId: string; username: string }[] = [
    { agentId: auth.userId, username: config.ADMIN_USERNAME },
  ];
  await rcapi.addLivechatAgent(url, auth, pw, config.ADMIN_USERNAME);
  const wanted = toInt(getOr(action, 'agents', 1));
  for (let i = 2; i <= wanted; i += 1) {
    const u = `agent${String(i)}`;
    await rcapi.createUser(url, auth, pw, u);
    await rcapi.addLivechatAgent(url, auth, pw, u);
    const uid = await rcapi.getUserId(url, auth, u);
    if (truthy(uid)) agents.push({ agentId: String(uid), username: u });
  }
  const available = await rcapi.setLivechatAvailable(url, auth, pw);

  const dept = action.department;
  let deptOk = false;
  if (truthy(dept)) {
    const deptId = await rcapi.ensureLivechatDepartment(url, auth, pw, String(dept));
    if (truthy(deptId)) {
      deptOk = await rcapi.assignLivechatAgents(url, auth, pw, String(deptId), agents);
    }
  }

  const canned = await rcapi.saveCannedResponse(
    url,
    auth,
    pw,
    'hello',
    'Hi! Thanks for reaching out - how can I help?',
  );
  if (!canned) {
    info(
      emit,
      '(canned responses & business hours are Enterprise features - pass ' +
        '--reg-token to enable, else set them up manually)',
      { phase: 'post_ready' },
    );
  }
  // REPORTED, like every other handler. This returned nothing on both paths, so a livechat
  // workspace whose agent could not be made available printed a warning and was still
  // counted as fully configured -- the same hole the oidc action had. `canned` is
  // deliberately NOT part of the verdict: it fails on a workspace with no licence, which
  // is the normal case and not a fault.
  if (!available) {
    warn(emit, 'set up the Omnichannel agent manually (Admin -> Omnichannel -> Agents)', {
      phase: 'post_ready',
    });
    return false;
  }
  let summary = `Omnichannel: ${agents.length} agent(s) available`;
  if (deptOk) summary += `, '${String(dept)}' department created + assigned`;
  info(emit, `${summary} - log into RC to go online.`, { phase: 'post_ready' });
  return true;
}

/**
 * Create test users, each with its username as its password; a user an earlier `ready` made
 * (users.create refuses it) counts. False, with a warning naming who is missing, otherwise.
 */
async function ensureTestUsers(
  meta: Metadata,
  auth: rcapi.Auth,
  emit: Emit,
  label: string,
  usernames: readonly string[],
): Promise<boolean> {
  const url = meta.rootUrl;
  const pw = adminPass(meta);
  const missing: string[] = [];
  for (const username of usernames) {
    if (await rcapi.createUser(url, auth, pw, username)) continue;
    if (!truthy(await rcapi.getUserId(url, auth, username))) missing.push(username);
  }
  if (missing.length > 0) {
    warn(emit, `could not create the ${label} test users ${missing.join(', ')}`, {
      phase: 'post_ready',
    });
    return false;
  }
  return true;
}

/**
 * The `e2ee` preset's test users. Nothing about encryption is done here: each user's keys are
 * made in their browser the first time they sign in. Re-run by `ready`, so an existing user
 * is kept, not an error.
 */
async function prE2eeUsers(
  meta: Metadata,
  auth: rcapi.Auth,
  _action: Action,
  emit: Emit,
  _sleep: Sleep,
): Promise<boolean> {
  if (!(await ensureTestUsers(meta, auth, emit, 'E2EE', E2EE_TEST_USERS))) return false;
  info(emit, `E2EE test users ready: ${E2EE_TEST_USERS.join(', ')} (password = username)`, {
    phase: 'post_ready',
  });
  return true;
}

/**
 * The Voice test users and, with SIP, their extensions. Rocket.Chat lets an extension be set
 * only while SIP integration is on, which needs a licence with the Voice add-on: a refusal is
 * that missing licence, so it is a warning saying where to set them later, not a failure.
 */
async function prVoiceUsers(
  meta: Metadata,
  auth: rcapi.Auth,
  action: Action,
  emit: Emit,
  _sleep: Sleep,
): Promise<boolean> {
  const users = Object.keys(VOICE_TEST_USERS);
  if (!(await ensureTestUsers(meta, auth, emit, 'Voice', users))) return false;
  info(emit, `Voice test users ready: ${users.join(', ')} (password = username)`, {
    phase: 'post_ready',
  });
  if (!truthy(action.extensions)) return true;
  const url = meta.rootUrl;
  const pw = adminPass(meta);
  const refused: string[] = [];
  for (const [username, extension] of Object.entries(VOICE_TEST_USERS)) {
    const id = await rcapi.getUserId(url, auth, username);
    if (id === null || !(await rcapi.setVoiceExtension(url, auth, pw, id, extension))) {
      refused.push(username);
    }
  }
  if (refused.length > 0) {
    warn(
      emit,
      `could not give ${refused.join(', ')} their extensions: Rocket.Chat sets one only while ` +
        'Voice is licensed. Apply the license in Administration → Subscription, then run ' +
        `houston ready --name ${meta.name}.`,
      { phase: 'post_ready' },
    );
    return true;
  }
  const given = Object.entries(VOICE_TEST_USERS).map(([username, ext], i) =>
    i === 0 ? `${username} has extension ${ext}` : `${username} ${ext}`,
  );
  info(emit, `SIP: ${given.join(', ')}`, { phase: 'post_ready' });
  return true;
}

/** The Omnichannel webhook's event switches, for a workspace that cannot list its settings. */
const WEBHOOK_EVENT_SETTINGS: readonly string[] = [
  'start',
  'close',
  'chat_taken',
  'chat_queued',
  'forward',
  'offline_msg',
  'visitor_message',
  'agent_message',
].map((event) => `Livechat_webhook_on_${event}`);

/** The `?from=` a capture wrote into a repointed URL: where the call was bound. */
function capturedFrom(url: string): string {
  try {
    return new URL(url).searchParams.get('from') ?? '';
  } catch {
    return '';
  }
}

/** The JSON the inbox answers: not empty, and without `text`, so Rocket.Chat posts nothing back. */
const INBOX_ANSWER = '{"captured":true}';

/**
 * What the receiver says of a session: fit to be the inbox (200 and a body), made for
 * something else (an engineer's 500 or delay), the receiver's own creation on an unknown
 * uuid (200 and nothing else: the empty body Rocket.Chat reads as a failed call), gone, or
 * not answering.
 */
type SessionState = 'ok' | 'other' | 'auto' | 'missing' | 'unreachable';

async function sessionState(api: string, uuid: string): Promise<SessionState> {
  try {
    const [status, text] = await rcapi.call(
      api,
      'GET',
      `/api/session/${encodeURIComponent(uuid)}`,
      {
        timeoutMs: 5_000,
      },
    );
    if (status === 404) return 'missing';
    if (status !== 200) return 'unreachable';
    const parsed = JSON.parse(text) as {
      response?: { status_code?: unknown; response_body_base64?: unknown };
    };
    const code = parsed.response?.status_code;
    const body = parsed.response?.response_body_base64;
    if (code !== 200) return 'other';
    return typeof body === 'string' && body !== '' ? 'ok' : 'auto';
  } catch {
    return 'unreachable';
  }
}

async function createSession(api: string): Promise<string | null> {
  try {
    const [status, text] = await rcapi.call(api, 'POST', '/api/session', {
      data: {
        status_code: 200,
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        delay: 0,
        response_body_base64: Buffer.from(INBOX_ANSWER).toString('base64'),
      },
      timeoutMs: 5_000,
    });
    const uuid = (JSON.parse(text) as { uuid?: unknown }).uuid;
    return status < 300 && typeof uuid === 'string' && uuid !== '' ? uuid : null;
  } catch {
    return null;
  }
}

/** The session segment of a URL at the inbox, `http://webhooks:8080/<uuid>/...`; '' elsewhere. */
function sessionOf(url: string, origin: string): string {
  if (!url.startsWith(origin)) return '';
  try {
    return new URL(url).pathname.split('/')[1] ?? '';
  } catch {
    return '';
  }
}

function originOf(url: string, fallback: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return fallback;
  }
}

/**
 * The inbox's API: the port the preset published, at the address houston reaches the
 * workspace by -- with --bind <ip> nothing answers on localhost.
 */
function apiOrigin(rootUrl: string, uiUrl: string): string {
  try {
    const port = new URL(uiUrl).port;
    return port === '' ? '' : `http://${new URL(rootUrl).hostname}:${port}`;
  } catch {
    return '';
  }
}

/**
 * The webhooks preset: the inbox's session, the two sample integrations, the Omnichannel
 * webhook pointed at the inbox, the inbox on the SSRF allowlist, and -- with capture=all --
 * every other outgoing integration repointed there, the original URL kept in the new one's
 * query string.
 *
 * THE SESSION IS MADE HERE, NOT BY THE FIRST REQUEST: the receiver's auto-created session
 * answers 200 with an empty body, which Rocket.Chat reads as a failed call and retries four
 * times, so every message landed five times and the History tab read too-many-retries. One
 * made through the receiver's API answers JSON. The receiver picks the uuid, so it is
 * recorded, the recorded one is kept while it still answers, and a lost one (an idle month,
 * a removed volume) or the auto-created one is replaced and whatever pointed at it
 * repointed. While the receiver's API cannot be reached nothing is wired: the auto-created
 * session would bring the retries back.
 *
 * Everything is found before it is made, so a ready, an upgrade, a restore and a rebuild
 * re-run it safely; what Rocket.Chat answered is recorded under `extra.webhooks` for `info`
 * and the GUI, as the RELATIVE hook path: the host is composed when it is read.
 *
 * The rule for the Omnichannel webhook is "wire events only to our inbox, never widen a
 * foreign one": a URL a customer's dump brought along is left alone (and named) unless
 * capture=all, because switching more events on would post them to the customer's CRM.
 */
async function prWebhooksSetup(
  meta: Metadata,
  auth: rcapi.Auth,
  action: Action,
  emit: Emit,
  _sleep: Sleep,
): Promise<boolean> {
  // The first build recorded a fixed session in both addresses; the origins are what count.
  const receiverOrigin = originOf(String(required(action, 'receiver')), config.WEBHOOKS_RECEIVER);
  const api = apiOrigin(meta.rootUrl, String(getOr(action, 'ui_url', '')));
  const capture = String(getOr(action, 'capture', 'off')) === 'all';
  const origin = `${receiverOrigin}/`;
  const url = meta.rootUrl;
  const pw = adminPass(meta);
  const phase = { phase: 'post_ready' as const };
  let ok = true;

  const states = new Map<string, SessionState>();
  const stateOf = async (uuid: string): Promise<SessionState> => {
    const known = states.get(uuid);
    if (known !== undefined) return known;
    const state = await sessionState(api, uuid);
    states.set(uuid, state);
    return state;
  };

  const listed = await rcapi.listIntegrations(url, auth, pw, { type: 'webhook-outgoing' });
  const ours = listed?.find((doc) => doc.name === config.WEBHOOKS_OUTGOING);
  const current = await rcapi.getSetting(url, auth, pw, 'Livechat_webhookUrl');
  const currentUrl = typeof current === 'string' ? current : '';
  // The session a rebuilt record forgot (`up --force` rebuilds `extra`) is the one the
  // sample integration or the Omnichannel webhook still posts to: the first that still
  // answers as the inbox is kept, so a rebuild never splits the inbox in two.
  const recorded = (meta.extra.webhooks as { session?: unknown } | undefined)?.session;
  const oursUrl = Array.isArray(ours?.urls) ? String(ours.urls[0] ?? '') : '';
  const candidates = [
    typeof recorded === 'string' ? recorded : '',
    sessionOf(oursUrl, origin),
    sessionOf(currentUrl, origin),
  ].filter((one) => one !== '');
  let session = '';
  for (const one of candidates) {
    if ((await stateOf(one)) === 'ok') {
      session = one;
      break;
    }
  }
  if (session === '') {
    const made = await createSession(api);
    if (made === null) {
      warn(
        emit,
        `could not reach the inbox at ${api || 'its port'} to make its session: nothing was wired -- houston ready --name ${meta.name} once the inbox answers`,
        phase,
      );
      return false;
    }
    session = made;
    states.set(made, 'ok');
  }
  const receiver = `${origin}${session}`;
  /** A URL at the inbox whose session is gone or the receiver's own, moved to this one. */
  const repaired = async (one: string): Promise<string> => {
    const uuid = sessionOf(one, origin);
    if (uuid === '' || uuid === session) return one;
    // An engineer's own session (a 500, a delay) stays; only a lost or empty one moves.
    const state = await stateOf(uuid);
    if (state !== 'missing' && state !== 'auto') return one;
    return `${receiver}${one.slice(origin.length + uuid.length)}`;
  };

  const outgoing =
    ours !== undefined
      ? 'listed'
      : await rcapi.createOutgoingWebhook(url, auth, pw, {
          name: config.WEBHOOKS_OUTGOING,
          urls: [`${receiver}/outgoing`],
        });
  if (outgoing === null) {
    warn(
      emit,
      `could not create the '${config.WEBHOOKS_OUTGOING}' integration (is rocket.cat present, and does admin hold manage-outgoing-integrations?)`,
      phase,
    );
    ok = false;
  }
  const incoming = await rcapi.createIncomingWebhook(url, auth, pw, {
    name: config.WEBHOOKS_INCOMING,
    channel: '#general',
    alias: 'houston',
  });
  if (incoming === null) {
    warn(
      emit,
      `could not create the '${config.WEBHOOKS_INCOMING}' integration (is rocket.cat present, and #general?)`,
      phase,
    );
    ok = false;
  }

  const failed: string[] = [];
  const set = async (id: string, value: unknown): Promise<void> => {
    if (!(await rcapi.setSetting(url, auth, pw, id, value))) failed.push(id);
  };
  const atInbox = currentUrl.startsWith(origin);
  let omnichannel = currentUrl;
  if (current === null) {
    // "Could not read" is not "empty": writing over a URL nobody saw could replace a
    // customer's without a word.
    warn(
      emit,
      'could not read Livechat_webhookUrl: the Omnichannel webhook is left as it is',
      phase,
    );
    ok = false;
  } else if (currentUrl === '' || atInbox || capture) {
    const replaced = !atInbox && currentUrl !== '';
    if (atInbox) {
      // Ours at a session the receiver lost, or at the auto-created one: moved to this one.
      omnichannel = await repaired(currentUrl);
      if (omnichannel !== currentUrl) await set('Livechat_webhookUrl', omnichannel);
    } else {
      // The URL it replaced rides along in ?from=, as a captured integration's does, so
      // `info` can say where the webhook was bound after any rebuild of the record.
      omnichannel = replaced
        ? `${receiver}/omnichannel?from=${encodeURIComponent(currentUrl)}`
        : `${receiver}/omnichannel`;
      await set('Livechat_webhookUrl', omnichannel);
      if (replaced)
        warn(emit, `Omnichannel webhook was ${currentUrl}: now the inbox (capture=all)`, phase);
    }
    const token = await rcapi.getSetting(url, auth, pw, 'Livechat_secret_token');
    if (token === '' || token === false || replaced) {
      await set('Livechat_secret_token', config.WEBHOOKS_TOKEN);
    }
    // The known switches first, then any the workspace lists beyond them: `settings?count=0`
    // is capped on a workspace without API_Allow_Infinite_Count, and a short list must not
    // read as "this version has none" -- a switch the version lacks answers null below.
    const listed = (await rcapi.settingIds(url, auth, pw)) ?? new Set<string>();
    for (const id of new Set([...WEBHOOK_EVENT_SETTINGS, ...listed])) {
      // `on_capture` needs navigation-as-message and is not an event of a chat.
      if (!id.startsWith('Livechat_webhook_on_') || id === 'Livechat_webhook_on_capture') continue;
      if ((await rcapi.getSetting(url, auth, pw, id)) === false) await set(id, true);
    }
  } else {
    warn(
      emit,
      `Omnichannel webhook points at ${currentUrl} and would post every chat event there: --set capture=all repoints it at the inbox`,
      phase,
    );
  }
  const allow = await rcapi.getSetting(url, auth, pw, 'SSRF_Allowlist');
  if (typeof allow === 'string') {
    // Absent (null) before 8.2.0, where nothing it guards reaches a private host anyway.
    const hosts = allow
      .split(/[\r\n,]+/u)
      .map((host) => host.trim())
      .filter((host) => host !== '');
    if (!hosts.includes('webhooks')) await set('SSRF_Allowlist', [...hosts, 'webhooks'].join('\n'));
  }
  if (failed.length > 0) {
    warn(emit, `these settings did not take: ${failed.join(', ')}`, phase);
    ok = false;
  }

  const captured: { name: string; from: string[] }[] = [];
  if (listed === null) {
    warn(emit, 'could not list the outgoing integrations', phase);
    ok = false;
  } else {
    const scripted: string[] = [];
    const resave = async (
      doc: Record<string, unknown>,
      name: string,
      target: string[],
      was: string,
    ): Promise<boolean> => {
      if (await rcapi.updateOutgoingUrls(url, auth, pw, doc, target)) {
        info(emit, `repointed '${name}' at the inbox (was ${was})`, phase);
        if (doc.scriptEnabled === true && String(doc.script ?? '').trim() !== '')
          scripted.push(name);
        return true;
      }
      warn(
        emit,
        `could not repoint '${name}' (Rocket.Chat refused the update: a deleted user or channel?)`,
        phase,
      );
      ok = false;
      return false;
    };
    for (const doc of listed) {
      const name = String(doc.name ?? '');
      const urls = Array.isArray(doc.urls) ? doc.urls.map(String) : [];
      if (urls.length === 0) continue;
      if (urls.every((one) => one.startsWith(origin))) {
        const fixed: string[] = [];
        for (const one of urls) fixed.push(await repaired(one));
        if (fixed.some((one, i) => one !== urls[i]))
          await resave(doc, name, fixed, 'a session the inbox no longer has');
        if (name !== config.WEBHOOKS_OUTGOING)
          captured.push({ name, from: fixed.map(capturedFrom).filter((one) => one !== '') });
        continue;
      }
      if (name === config.WEBHOOKS_OUTGOING || !capture) continue;
      const target = urls.map(
        (one) => `${receiver}/captured/${encodeURIComponent(name)}?from=${encodeURIComponent(one)}`,
      );
      if (await resave(doc, name, target, urls.join(', '))) captured.push({ name, from: urls });
    }
    if (scripted.length > 0) {
      warn(
        emit,
        `re-saved with a script: ${scripted.join(', ')} -- from Rocket.Chat 9.0.0 a script runs as written, in strict mode (docs.rocket.chat/docs/integrations#script-compatibility)`,
        phase,
      );
    }
  }

  const hooks = {
    session,
    incoming: incoming ?? '',
    outgoing_name: config.WEBHOOKS_OUTGOING,
    omnichannel,
    captured,
  };
  try {
    await updateMeta(meta.name, (recorded) => {
      recorded.extra.webhooks = hooks;
    });
    meta.extra.webhooks = hooks;
  } catch {
    warn(
      emit,
      `could not record the webhook URLs in repro.json: houston ready --name ${meta.name} writes them`,
      phase,
    );
    ok = false;
  }

  const where = omnichannel.startsWith(origin) ? 'at the inbox' : `left at ${omnichannel}`;
  const count = captured.length > 0 ? `; ${String(captured.length)} integration(s) captured` : '';
  const inbox = `${api}/s/${session}`;
  info(
    emit,
    `Webhooks: inbox ${inbox} (on the machine running houston); '${config.WEBHOOKS_OUTGOING}' posts every public-channel message there; Omnichannel webhook ${where}${count} -- houston info --name ${meta.name} prints the incoming curl.`,
    phase,
  );
  return ok;
}

export type Handler = (
  meta: Metadata,
  auth: rcapi.Auth,
  action: Action,
  emit: Emit,
  sleep: Sleep,
) => Promise<boolean>;

/**
 * The action name a preset writes -> the handler that runs it.
 *
 * MUTABLE on purpose: a spec swaps entries in and out to drive `runPostReady` without
 * standing up four RC stubs, and reloads the table afterwards.
 * `resetActions` is the reload.
 */
export const POST_READY_ACTIONS: Record<string, Handler> = {
  saml_idp_cert: prSamlIdpCert,
  keycloak_master_ssl_off: prKeycloakMasterSslOff,
  create_oauth_provider: prCreateOauthProvider,
  livechat_setup: prLivechatSetup,
  e2ee_users: prE2eeUsers,
  voice_users: prVoiceUsers,
  webhooks_setup: prWebhooksSetup,
};

const BUILTIN_ACTIONS: Readonly<Record<string, Handler>> = Object.freeze({
  ...POST_READY_ACTIONS,
});

/** Put the table back the way it shipped. */
export function resetActions(): void {
  for (const key of Object.keys(POST_READY_ACTIONS)) delete POST_READY_ACTIONS[key];
  Object.assign(POST_READY_ACTIONS, BUILTIN_ACTIONS);
}

/**
 * Run a workspace's preset self-configuration. Returns the actions that did NOT complete.
 *
 * `null` when there was no admin session to run them with -- nothing ran, which is a
 * different answer from "they all succeeded".
 */
export async function runPostReady(
  meta: Metadata,
  auth: rcapi.Auth | null | undefined,
  emit: Emit,
  { sleep = realSleep }: Options = {},
): Promise<string[] | null> {
  const extra = bagOf(meta.extra);
  const raw = extra.post_ready;
  const actions: Action[] = Array.isArray(raw) ? (raw as Action[]) : [];
  if (auth === null || auth === undefined) {
    if (actions.length > 0) {
      warn(
        emit,
        'preset self-config skipped - could not log in as admin; ' +
          `re-run once reachable: houston ready --name ${meta.name}`,
        { phase: 'post_ready' },
      );
    }
    return null;
  }
  // COLLECTED, not just warned past. A create that printed "could not fetch/apply IdP
  // cert" and then "starting" left the reader to work out for themselves whether SAML
  // actually worked -- the deployment succeeded and the CONFIGURATION did not, and those
  // are different answers to different questions.
  const failed: string[] = [];
  for (const action of actions) {
    const name = action.action;
    const handler = truthy(name) ? POST_READY_ACTIONS[String(name)] : undefined;
    if (handler === undefined) continue;
    if ((await handler(meta, auth, action, emit, sleep)) === false) failed.push(String(name));
  }
  if (failed.length > 0) {
    warn(
      emit,
      `the workspace is RUNNING but its ${quotedText(meta.preset)} ` +
        `${namesOf(meta.preset).length > 1 ? 'presets are' : 'preset is'} only ` +
        `partly configured — these did not complete: ${failed.join(', ')}`,
      { phase: 'post_ready' },
    );
    warn(
      emit,
      `    Rocket.Chat itself is fine. Re-run the preset's ` +
        `self-configuration with: houston ready --name ${meta.name}`,
      { phase: 'post_ready' },
    );
  }
  return failed;
}
