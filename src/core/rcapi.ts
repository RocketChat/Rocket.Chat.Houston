/**
 * Minimal Rocket.Chat REST client: readiness polling, login, and calls.
 *
 * Every request goes through `seams/rc-http`; nothing here opens a socket, and nothing there
 * knows a Rocket.Chat path. The division is the point: the retry loops, the 2FA dance and the
 * "which of these four failures is this" judgements are domain, and they all live on this
 * side.
 *
 * ONE DEPARTURE FROM THE PREVIOUS IMPLEMENTATION, and it is the runtime's: every function
 * that makes a request is `async`, because service entry points are asynchronous and `Emit`
 * stays synchronous; and the sleeps inside the three polling loops are injectable so their
 * specs do not spend real seconds.
 */
import * as config from '../lib/config';
import { CreateFailedError } from '../lib/errors';
import { recordAudit } from '../lib/audit';
import { storedText } from '../lib/format';
import { dumps } from '../lib/json-text';
import { sleep as interruptibleSleep } from '../seams/exec';
import { RequestFailed, rcHttp, type HttpResponse, type RequestOptions } from '../seams/rc-http';

/** Fetch a release document for callers that must prefetch before synchronous resolution. */
export async function releaseInfo(url: string): Promise<HttpResponse | null> {
  try {
    return await get(url, { timeoutMs: 5_000 });
  } catch (error) {
    if (error instanceof RequestFailed) return null;
    throw error;
  }
}

/** Rocket.Chat is not serving yet, or stopped being able to. */
export class NotReady extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotReady';
  }
}

export interface Auth {
  readonly token: string;
  readonly userId: string;
}

export function authHeaders(auth: Auth): Record<string, string> {
  return { 'X-Auth-Token': auth.token, 'X-User-Id': auth.userId };
}

export type Sleep = (seconds: number) => Promise<void>;

/** The real sleep, which a Ctrl-C interrupts. */
const realSleep: Sleep = (seconds) => interruptibleSleep(seconds * 1000);

const now = () => Date.now() / 1000;

const trimEnd = (url: string) => url.replace(/\/+$/u, '');

/** `resp.json()` or `{}`, for the many places a non-JSON body is just a failure. */
function body(resp: HttpResponse): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = resp.json();
  } catch {
    return {};
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

const map = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? (value as Record<string, unknown>[]) : [];

/** The first 200 characters of a body, which is what every message here quotes. */
const said = (resp: HttpResponse, limit = 200) => resp.text.slice(0, limit);

async function get(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
  return await rcHttp.request(url, { ...options, method: 'GET' });
}

async function post(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
  return await rcHttp.request(url, { ...options, method: 'POST' });
}

async function put(url: string, options: RequestOptions = {}): Promise<HttpResponse> {
  return await rcHttp.request(url, { ...options, method: 'PUT' });
}

/** GET /api/info (public). The JSON, or null if it is not serving. */
export async function apiInfo(
  rootUrl: string,
  {
    timeoutMs = 5_000,
    requestOptions = {},
  }: { timeoutMs?: number; requestOptions?: RequestOptions } = {},
): Promise<Record<string, unknown> | null> {
  let resp: HttpResponse;
  try {
    resp = await get(`${trimEnd(rootUrl)}/api/info`, { ...requestOptions, timeoutMs });
  } catch (error) {
    if (error instanceof RequestFailed) return null;
    throw error;
  }
  if (resp.status !== 200) return null;
  try {
    const parsed = resp.json();
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Block until Rocket.Chat serves /api/info, returning its payload.
 *
 * `isAlive()` is checked each tick, so a crashed container fails fast rather than being
 * polled for the full timeout. `onTick(elapsed)` drives progress display.
 */
export async function waitReady(
  rootUrl: string,
  {
    timeout = 300,
    interval = 3,
    isAlive,
    onTick,
    sleep = realSleep,
    requestOptions = {},
    page = false,
  }: {
    timeout?: number;
    interval?: number;
    isAlive?: () => boolean | Promise<boolean>;
    onTick?: (elapsed: number) => void | Promise<void>;
    sleep?: Sleep;
    requestOptions?: RequestOptions | ((remainingMs: number) => Promise<RequestOptions | null>);
    /** The exposed web route must return a complete page as well as its public API. */
    page?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  const deadline = now() + timeout;
  for (;;) {
    const remainingMs = (): number => Math.max(1, Math.min(5_000, (deadline - now()) * 1000));
    const options =
      typeof requestOptions === 'function' ? await requestOptions(remainingMs()) : requestOptions;
    const info =
      options === null
        ? null
        : await apiInfo(rootUrl, { requestOptions: options, timeoutMs: remainingMs() });
    if (
      info !== null &&
      options !== null &&
      (!page || (await pageServing(rootUrl, options, remainingMs())))
    )
      return info;
    if (isAlive !== undefined && !(await isAlive())) {
      throw new NotReady('Rocket.Chat container is not running (check `logs`)');
    }
    if (now() >= deadline) {
      throw new NotReady(`Rocket.Chat did not become ready within ${String(Math.trunc(timeout))}s`);
    }
    // AWAITED, so a tick that decides the boot has already failed can throw out of the
    // poll there and then, before the next sleep. A caller that ignores the return value
    // is unaffected.
    if (onTick !== undefined) await onTick(timeout - (deadline - now()));
    await sleep(interval);
  }
}

async function pageServing(
  rootUrl: string,
  requestOptions: RequestOptions,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await get(`${trimEnd(rootUrl)}/`, {
      ...requestOptions,
      timeoutMs,
      followRedirects: false,
    });
    return response.status === 200 && response.text.trim() !== '';
  } catch (error) {
    if (error instanceof RequestFailed) return false;
    throw error;
  }
}

/**
 * The Auth in a login response.
 *
 * A 200 with a non-JSON body -- a proxy's error page -- must fall through to the error
 * below, which carries the body text an operator needs, rather than escaping as a bare
 * JSON parse failure.
 */
function authFrom(resp: HttpResponse): Auth {
  const data = map(body(resp).data);
  const token = String(data.authToken ?? '');
  const userId = String(data.userId ?? '');
  if (token === '' || userId === '') {
    throw new Error(`login did not return a token: ${said(resp)}`);
  }
  return { token, userId };
}

/** Headers that satisfy Rocket.Chat's 'password' 2FA method for guarded endpoints. */
export async function password2faHeaders(password: string): Promise<Record<string, string>> {
  const crypto = await import('node:crypto');
  return {
    'x-2fa-code': crypto.createHash('sha256').update(password, 'utf8').digest('hex'),
    'x-2fa-method': 'password',
  };
}

/**
 * An `HttpStatusError` for a 4xx or a 5xx status, and nothing otherwise.
 *
 * In the established words, and the words carry behaviour. A refused login used to say
 * `login failed: HTTP 401: <body>` (and `login with the email code failed: ...`), where the
 * established text is `401 Client Error: Unauthorized for url:
 * http://localhost:3100/api/v1/login` -- every caller of `login` prints it. And the REST
 * commands' `notAnswering`, and `seed`, test that text for `429` to tell Rocket.Chat's rate
 * limiter from a broken login, so the URL in it is read too: a workspace on port 3429 (or
 * 4290-4299, 14290, ...) whose login is refused is reported as rate-limited, exit 5, as it
 * always has been. That is an accident, and reproducing it is the point of matching it.
 *
 * Named `HttpStatusError` and NOT a `RequestFailed`: only a connection failure or a timeout is
 * "not answering yet", and `notAnswering` reads a `RequestFailed` as one of those.
 */
function raiseForStatus(resp: HttpResponse): void {
  const kind =
    resp.status >= 400 && resp.status < 500
      ? 'Client Error'
      : resp.status >= 500 && resp.status < 600
        ? 'Server Error'
        : '';
  if (kind === '') return;
  const error = new Error(
    `${String(resp.status)} ${kind}: ${resp.reason ?? ''} for url: ${resp.url}`,
  );
  error.name = 'HttpStatusError';
  throw error;
}

/** Plain login, then Rocket.Chat's password-fallback 2FA method. */
async function tryPasswordLogins(
  base: string,
  creds: Record<string, string>,
  password: string,
  timeoutMs: number,
): Promise<[Auth | null, HttpResponse]> {
  const resp = await post(`${base}/login`, { json: creds, timeoutMs });
  if (resp.status === 200) return [authFrom(resp), resp];
  if (!resp.text.includes('totp-required')) {
    // `raiseForStatus` is a no-op for 2xx/3xx, so a 204 -- or a reverse proxy's 302 to
    // HTTPS, the case `--allow-host` exists for -- used to fall through into the 2FA
    // branch below and report a missing Mailpit URL for what is really a redirect.
    raiseForStatus(resp);
    throw new Error(
      `login returned HTTP ${String(resp.status)}, which is neither a success nor a 2FA ` +
        `challenge: ${said(resp)}`,
    );
  }
  const retry = await post(`${base}/login`, {
    json: creds,
    timeoutMs,
    headers: await password2faHeaders(password),
  });
  if (retry.status === 200) return [authFrom(retry), resp];
  return [null, resp];
}

/**
 * A safe recipient filter for Mailpit's shared inbox.
 *
 * Falling back to no filter disabled it entirely, so this could hand back a DIFFERENT
 * user's code -- the exact thing the filter exists to prevent. It refuses instead.
 */
export function otpRecipient(user: string): string {
  if (user.includes('@')) return user;
  if (user === config.ADMIN_USERNAME) return config.ADMIN_EMAIL;
  throw new Error(
    `cannot fetch an email-2FA code for '${user}': its address is unknown, and polling the ` +
      "shared Mailpit inbox unfiltered could return another user's code",
  );
}

/** Trigger, fetch, and submit a fresh recipient-filtered email code. */
async function loginWithEmailCode(
  base: string,
  creds: Record<string, string>,
  user: string,
  timeoutMs: number,
  mailpitUrl: string,
  sleep: Sleep,
  otpTimeout: number,
): Promise<Auth> {
  // Snapshot the inbox FIRST, so a leftover code from a previous login is not mistaken
  // for the fresh one, and filter by recipient because Mailpit is a catch-all for every
  // address.
  const toEmail = otpRecipient(user);
  const baseline = await newestMailStamp(mailpitUrl, { toEmail });
  let sent: HttpResponse | null = null;
  try {
    sent = await post(`${base}/users.2fa.sendEmailCode`, {
      json: { emailOrUsername: user },
      timeoutMs,
    });
  } catch (error) {
    if (!(error instanceof RequestFailed)) throw error;
  }
  const code = await fetchEmailOtp(mailpitUrl, {
    toEmail,
    after: baseline,
    sleep,
    timeout: otpTimeout,
  });
  if (code === null) {
    // Surface a failed send instead of blaming the timeout for it.
    const detail =
      sent !== null && !sent.ok
        ? ` (users.2fa.sendEmailCode returned HTTP ${String(sent.status)}: ${said(sent, 120)})`
        : '';
    throw new Error(`email-2FA code did not arrive in Mailpit within the timeout${detail}`);
  }
  const resp = await post(`${base}/login`, {
    json: creds,
    timeoutMs,
    headers: { 'x-2fa-code': code, 'x-2fa-method': 'email' },
  });
  raiseForStatus(resp);
  return authFrom(resp);
}

/**
 * Log in and return an Auth.
 *
 * With email-2FA on (the `email` preset's default) a plain login is rejected with
 * `totp-required`. The password-fallback method is tried first, and if that is not
 * accepted and a Mailpit URL is known, the code email is triggered, read out of Mailpit
 * and submitted -- so houston's own admin calls keep working while OTP stays on for
 * browsers.
 */
export async function login(
  rootUrl: string,
  {
    user = config.ADMIN_USERNAME,
    password = config.ADMIN_PASSWORD,
    timeoutMs = 10_000,
    mailpitUrl = '',
    sleep = realSleep,
    otpTimeout = OTP_WAIT_SECONDS,
  }: {
    user?: string;
    password?: string;
    timeoutMs?: number;
    mailpitUrl?: string;
    sleep?: Sleep;
    /**
     * How long to wait for the code email. `fetchEmailOtp`'s own default, threaded through
     * for the same reason `sleep` is: a spec for the failed-send message should not spend
     * thirty real seconds discovering that no code arrived.
     */
    otpTimeout?: number;
  } = {},
): Promise<Auth> {
  const base = `${trimEnd(rootUrl)}/api/v1`;
  const creds = { user, password };
  const [auth, challenge] = await tryPasswordLogins(base, creds, password, timeoutMs);
  if (auth !== null) return auth;

  if (mailpitUrl === '') {
    throw new Error(
      'login requires an email-2FA code and no Mailpit URL is configured (is this the ' +
        `\`email\` preset?): ${said(challenge)}`,
    );
  }
  return await loginWithEmailCode(base, creds, user, timeoutMs, mailpitUrl, sleep, otpTimeout);
}

/**
 * A seeded user's plain login, for the identities a load test's VUs carry.
 *
 * The load test once posted to `/api/v1/login` directly — one of three bypasses of the REST
 * client. Here it goes through this module: the dependency policy allows exactly one module
 * to speak HTTP, and the endpoint is Rocket.Chat's own, so this is where it belongs.
 * Returns the token pair, or null for any non-200; a transport failure still throws
 * `RequestFailed`, which the caller's loop breaks on.
 */
export async function loginUser(
  rootUrl: string,
  user: string,
  { timeoutMs = 10_000 } = {},
): Promise<{ authToken: string; userId: string } | null> {
  const resp = await rcHttp.request(`${trimEnd(rootUrl)}/api/v1/login`, {
    method: 'POST',
    json: { user, password: user },
    timeoutMs,
  });
  if (resp.status !== 200) return null;
  const data = body(resp).data as Record<string, unknown> | null | undefined;
  if (data === null || data === undefined) return null;
  return { authToken: String(data.authToken ?? ''), userId: String(data.userId ?? '') };
}

/**
 * Whether releases.rocket.chat answers, for doctor's version-lookup check.
 *
 * doctor's version check once fetched it directly -- the fourth recorded `rcapi` bypass,
 * after `seed`'s three. Here it goes through this module instead: exactly one module speaks
 * HTTP, and the endpoint is houston's own lookup. Returns the status code, or null when the
 * request failed (`RequestFailed`).
 */
export async function releasesReachable(version = '8.5.1'): Promise<number | null> {
  try {
    const resp = await rcHttp.request(`https://releases.rocket.chat/${version}/info`, {
      timeoutMs: 5_000,
    });
    return resp.status;
  } catch (error) {
    // `RequestFailed` alone -- the transport-failure type and the only thing the HTTP seam
    // throws. A programmer error propagates rather than being reported as a network
    // problem.
    if (error instanceof RequestFailed) return null;
    throw error;
  }
}

/** How long `fetchEmailOtp` waits, and therefore how long a 2FA login can take. */
export const OTP_WAIT_SECONDS = 30;

/**
 * The emailed 2FA code, as the six digits Rocket.Chat stored, or null.
 *
 * Rocket.Chat mails it as `ddd-ddd` (`EmailCheck.send2FAEmail`:
 * `random.replace(/^(\d{3})/, '$1-')`, the same at every tag checked, 3.18.0 to 8.8.0),
 * and its `verify` strips every non-digit before comparing, so the digits alone are what it
 * accepts. Only that shape is read: a bare six-digit run was never the code, and taking one
 * would spend a login attempt on a colour, a year or a ticket number in a custom template.
 */
export function extractOtp(text: string): string | null {
  const found = /(?<![\d-])(\d{3})-(\d{3})(?![\d-])/u.exec(text || '');
  return found === null ? null : `${found[1] as string}${found[2] as string}`;
}

/**
 * Whether one Mailpit message is addressed to `toEmail`. An empty filter matches anything,
 * which is why an unresolvable recipient is refused by `otpRecipient` before it ever
 * reaches here.
 *
 * Exported so it can be checked directly:
 * a filter that silently stops matching is how a login reads somebody else's code, and
 * nothing about the caller's behaviour would look different.
 */
export function addressedTo(item: Record<string, unknown>, toEmail: string): boolean {
  if (toEmail === '') return true;
  const addresses = list(item.To).map((entry) => String(entry.Address ?? ''));
  return addresses.some((address) => address.toLowerCase() === toEmail.toLowerCase());
}

/**
 * The `Created` timestamp of the newest message, or ''.
 *
 * Snapshot this BEFORE triggering a new code so `fetchEmailOtp` can ignore stale codes
 * still sitting in the catch-all inbox.
 */
export async function newestMailStamp(
  mailpitUrl: string,
  { toEmail = '' }: { toEmail?: string } = {},
): Promise<string> {
  try {
    const resp = await get(`${trimEnd(mailpitUrl)}/api/v1/messages`, {
      params: { limit: 10 },
      timeoutMs: 5_000,
    });
    if (resp.status === 200) {
      for (const item of list(body(resp).messages)) {
        // Newest first.
        if (addressedTo(item, toEmail)) return String(item.Created ?? '');
      }
    }
  } catch {
    // A Mailpit that is not answering is not a reason to fail the login that has not
    // been attempted yet; the fetch below reports the real outcome.
  }
  return '';
}

/**
 * Poll Mailpit for an emailed 2FA code (`extractOtp`), optionally only in messages addressed
 * to `toEmail`.
 *
 * `after` (a `newestMailStamp` snapshot) skips any message not newer than it, so a code
 * left over from a previous login is never reused. Null if none shows up in time.
 */
export async function fetchEmailOtp(
  mailpitUrl: string,
  {
    toEmail = '',
    timeout = 30,
    interval = 1.5,
    after = '',
    sleep = realSleep,
  }: {
    toEmail?: string;
    timeout?: number;
    interval?: number;
    after?: string;
    sleep?: Sleep;
  } = {},
): Promise<string | null> {
  const base = trimEnd(mailpitUrl);
  const deadline = now() + timeout;
  for (;;) {
    try {
      const listing = await get(`${base}/api/v1/messages`, {
        params: { limit: 10 },
        timeoutMs: 5_000,
      });
      if (listing.status === 200) {
        for (const item of list(body(listing).messages)) {
          // Newest first.
          const id = String(item.ID ?? '');
          if (id === '' || !addressedTo(item, toEmail)) continue;
          // Stale: it predates the code we just requested.
          if (after !== '' && String(item.Created ?? '') <= after) continue;
          const message = await get(`${base}/api/v1/message/${id}`, { timeoutMs: 5_000 });
          if (message.status !== 200) continue;
          const parsed = body(message);
          const code =
            extractOtp(String(parsed.Text ?? '')) ?? extractOtp(String(parsed.HTML ?? ''));
          if (code !== null) return code;
        }
      }
    } catch {
      // A transport failure or an unparseable body is a reason to poll again, not to give
      // up: Mailpit comes up alongside Rocket.Chat and may not be answering yet.
    }
    if (now() >= deadline) return null;
    await sleep(interval);
  }
}

/**
 * Mark the setup wizard completed so the repro is usable immediately.
 *
 * Rocket.Chat leaves the wizard at 'in_progress' (the cloud-registration step) after
 * auto-provisioning the admin, and that beats OVERWRITE_SETTING_Show_Setup_Wizard.
 * Best-effort; never throws.
 */
export async function completeSetupWizard(
  rootUrl: string,
  auth: Auth,
  password: string,
  { timeoutMs = 15_000 } = {},
): Promise<boolean> {
  return await setSetting(rootUrl, auth, password, 'Show_Setup_Wizard', 'completed', {
    timeoutMs,
  });
}

/**
 * Create (or regenerate) a Personal Access Token and return the token string.
 *
 * Mirrors a token created in the UI with "Ignore Two Factor Authentication". Generating a
 * PAT is itself a 2FA-guarded action, satisfied here with the password method.
 */
export async function generatePat(
  rootUrl: string,
  auth: Auth,
  password: string,
  {
    tokenName = 'houston',
    bypass2fa = true,
    timeoutMs = 15_000,
    workspace = '',
  }: {
    tokenName?: string;
    bypass2fa?: boolean;
    timeoutMs?: number;
    workspace?: string;
  } = {},
): Promise<string> {
  // AUDITED HERE, not at the handlers. There were exactly eight non-test call sites, so
  // a record written at one handler would have missed six -- and a bypass-2FA
  // admin token for somebody else's workspace is one of the two most sensitive things
  // this tool can do. `workspace` is passed by every caller; the root URL is the fallback
  // so a ninth site still writes a usable line rather than an anonymous one.
  //
  // `bypass_2fa=True` / `bypass_2fa=False`, capitalised: audit.log is a record both releases
  // append to, so it keeps the stored spelling (`storedText`) it has always had. This wrote
  // `true`/`false`, so every PAT this build minted -- `pat`, `api --pat`, a load test's,
  // the GUI's -- left a line an external `grep bypass_2fa=True` or awk over
  // audit.log does not match, beside the lines earlier releases wrote.
  recordAudit(
    'pat',
    `${workspace || rootUrl} label=${tokenName} bypass_2fa=${storedText(Boolean(bypass2fa))}`,
  );

  const base = `${trimEnd(rootUrl)}/api/v1`;
  const headers = {
    ...authHeaders(auth),
    'Content-Type': 'application/json',
    ...(await password2faHeaders(password)),
  };

  // The documented contract is "a token, or an Error". A bare transport failure escaping
  // would break it for any caller that narrows its catch.
  const send = async (path: string, json: unknown): Promise<HttpResponse> => {
    try {
      return await post(`${base}/${path}`, { headers, json, timeoutMs });
    } catch (error) {
      throw new Error(`could not reach ${path}: ${String((error as Error).message)}`, {
        cause: error,
      });
    }
  };

  const first = await send('users.generatePersonalAccessToken', {
    tokenName,
    bypassTwoFactor: bypass2fa,
  });
  const created = body(first);
  if (created.success === true && typeof created.token === 'string' && created.token !== '') {
    return created.token;
  }
  // Already exists -> regenerate it (also 2FA-guarded).
  const second = await send('users.regeneratePersonalAccessToken', { tokenName });
  const regenerated = body(second);
  if (
    regenerated.success === true &&
    typeof regenerated.token === 'string' &&
    regenerated.token !== ''
  ) {
    return regenerated.token;
  }
  throw new Error(`could not create PAT: ${said(first)}`);
}

/** The headers every integration call sends: the session, JSON, and the password 2FA method. */
async function integrationHeaders(auth: Auth, password: string): Promise<Record<string, string>> {
  return {
    ...authHeaders(auth),
    'Content-Type': 'application/json',
    ...(await password2faHeaders(password)),
  };
}

/** 48 hex characters, the shape Rocket.Chat's own form gives an outgoing integration. */
async function newIntegrationToken(): Promise<string> {
  const crypto = await import('node:crypto');
  return crypto.randomBytes(24).toString('hex');
}

/**
 * Every integration, page by page (`count=100`), optionally of one `type`; null when the
 * list could not be read. Filtered here rather than by the `name`/`type` query params,
 * which older releases ignore.
 */
export async function listIntegrations(
  rootUrl: string,
  auth: Auth,
  password: string,
  { type = '', timeoutMs = 15_000 }: { type?: string; timeoutMs?: number } = {},
): Promise<Record<string, unknown>[] | null> {
  const headers = await integrationHeaders(auth, password);
  const out: Record<string, unknown>[] = [];
  try {
    // Stepped by what a page HELD: API_Upper_Count_Limit is a setting, and a dump that caps
    // a page at 25 answered 25 to count=100. 50 pages: more than 5,000 is not a repro.
    let offset = 0;
    for (let pages = 0; pages < 50; pages += 1) {
      const resp = await get(`${trimEnd(rootUrl)}/api/v1/integrations.list`, {
        headers,
        params: { count: 100, offset },
        timeoutMs,
      });
      if (resp.status !== 200) return null;
      const parsed = body(resp);
      const page = list(parsed.integrations);
      out.push(...page);
      offset += page.length;
      const total = typeof parsed.total === 'number' ? parsed.total : 0;
      if (page.length === 0 || (total > 0 ? out.length >= total : page.length < 100)) break;
    }
  } catch {
    return null;
  }
  return type === '' ? out : out.filter((one) => one.type === type);
}

/** The integration of exactly this `name` and `type`, or null (also when the list failed). */
export async function findIntegration(
  rootUrl: string,
  auth: Auth,
  password: string,
  { name, type, timeoutMs = 15_000 }: { name: string; type: string; timeoutMs?: number },
): Promise<Record<string, unknown> | null> {
  const all = await listIntegrations(rootUrl, auth, password, { type, timeoutMs });
  return all?.find((one) => one.name === name) ?? null;
}

/**
 * Find, else create, an incoming-webhook integration; returns its POST path
 * (`/hooks/<id>/<token>`) or null. Used by the loadtest `webhook` scenario and the webhooks
 * preset. Looked up FIRST: Rocket.Chat accepts a duplicate name, so creating and looking only
 * on refusal added a hook on every run.
 */
export async function createIncomingWebhook(
  rootUrl: string,
  auth: Auth,
  password: string,
  {
    channel = '#general',
    name = 'houston-loadtest-hook',
    alias = 'loadtest',
    timeoutMs = 15_000,
  }: { channel?: string; name?: string; alias?: string; timeoutMs?: number } = {},
): Promise<string | null> {
  const hookPath = (integration: Record<string, unknown>): string | null => {
    const id = String(integration._id ?? '');
    const token = String(integration.token ?? '');
    return id !== '' && token !== '' ? `/hooks/${id}/${token}` : null;
  };
  try {
    const found = await findIntegration(rootUrl, auth, password, {
      name,
      type: 'webhook-incoming',
      timeoutMs,
    });
    if (found !== null) return hookPath(found);
    const created = await post(`${trimEnd(rootUrl)}/api/v1/integrations.create`, {
      headers: await integrationHeaders(auth, password),
      json: {
        type: 'webhook-incoming',
        name,
        enabled: true,
        username: 'rocket.cat',
        channel,
        scriptEnabled: false,
        script: '',
        alias,
        avatar: '',
        emoji: '',
      },
      timeoutMs,
    });
    const madeBody = body(created);
    if (created.status === 200 && madeBody.success === true) {
      return hookPath(map(madeBody.integration));
    }
  } catch {
    // Best-effort by contract: the scenario runs without a webhook.
  }
  return null;
}

/**
 * Find, else create, an outgoing-webhook integration that posts every message of every
 * public channel to `urls`; returns its id or null. As rocket.cat, the one user with
 * `message-impersonate` on every workspace; with a token, because the update the admin UI
 * saves refuses an empty one.
 */
export async function createOutgoingWebhook(
  rootUrl: string,
  auth: Auth,
  password: string,
  {
    name,
    urls,
    channel = 'all_public_channels',
    event = 'sendMessage',
    timeoutMs = 15_000,
  }: {
    name: string;
    urls: readonly string[];
    channel?: string;
    event?: string;
    timeoutMs?: number;
  },
): Promise<string | null> {
  try {
    const found = await findIntegration(rootUrl, auth, password, {
      name,
      type: 'webhook-outgoing',
      timeoutMs,
    });
    if (found !== null) return String(found._id ?? '') || null;
    const created = await post(`${trimEnd(rootUrl)}/api/v1/integrations.create`, {
      headers: await integrationHeaders(auth, password),
      json: {
        type: 'webhook-outgoing',
        name,
        enabled: true,
        username: 'rocket.cat',
        channel,
        event,
        urls: [...urls],
        token: await newIntegrationToken(),
        scriptEnabled: false,
        script: '',
        retryFailedCalls: true,
        retryCount: 4,
        retryDelay: 'powers-of-ten',
        impersonateUser: false,
        runOnEdits: false,
        triggerWordAnywhere: false,
        alias: 'houston',
        avatar: '',
        emoji: '',
      },
      timeoutMs,
    });
    const madeBody = body(created);
    if (created.status === 200 && madeBody.success === true) {
      return String(map(madeBody.integration)._id ?? '') || null;
    }
  } catch {
    // Best-effort by contract: the caller says what is missing.
  }
  return null;
}

/** The fields `integrations.update` takes for an outgoing webhook, and nothing else. */
const OUTGOING_UPDATE_FIELDS: readonly string[] = [
  'name',
  'enabled',
  'username',
  'channel',
  'event',
  'triggerWords',
  'triggerWordAnywhere',
  'token',
  'scriptEnabled',
  'script',
  'runOnEdits',
  'retryFailedCalls',
  'retryCount',
  'retryDelay',
  'impersonateUser',
  'targetRoom',
  'alias',
  'avatar',
  'emoji',
];

/**
 * Point an outgoing integration at other `urls`, as stored (`integrations.list`'s document).
 *
 * The update writes EVERY field from its body, so the whole document goes back -- but only
 * the fields the schema names (it refuses unknown keys, and `scriptEngine`/`skipTranspile`
 * exist on some releases only), the channel list as the comma-joined string the form sends,
 * and a token where the stored one is empty, which the update refuses.
 */
export async function updateOutgoingUrls(
  rootUrl: string,
  auth: Auth,
  password: string,
  integration: Record<string, unknown>,
  urls: readonly string[],
  { timeoutMs = 15_000 } = {},
): Promise<boolean> {
  const json: Record<string, unknown> = {
    type: 'webhook-outgoing',
    integrationId: String(integration._id ?? ''),
  };
  for (const key of OUTGOING_UPDATE_FIELDS) {
    const value = integration[key];
    if (value !== undefined && value !== null) json[key] = value;
  }
  if (Array.isArray(integration.channel)) json.channel = integration.channel.join(',');
  if (String(json.token ?? '').trim() === '') json.token = await newIntegrationToken();
  json.urls = [...urls];
  try {
    // A PUT: Rocket.Chat registers integrations.update that way, and a POST is refused.
    const resp = await put(`${trimEnd(rootUrl)}/api/v1/integrations.update`, {
      headers: await integrationHeaders(auth, password),
      json,
      timeoutMs,
    });
    return resp.status === 200 && body(resp).success === true;
  } catch {
    return false;
  }
}

/** A Rocket.Chat setting's current value, or null if unavailable. */
export async function getSetting(
  rootUrl: string,
  auth: Auth,
  password: string,
  settingId: string,
  { timeoutMs = 15_000 } = {},
): Promise<unknown> {
  const headers = { ...authHeaders(auth), ...(await password2faHeaders(password)) };
  try {
    const resp = await get(`${trimEnd(rootUrl)}/api/v1/settings/${settingId}`, {
      headers,
      timeoutMs,
    });
    const parsed = body(resp);
    if (resp.status === 200 && parsed.success === true) return parsed.value;
  } catch {
    // Unreachable or unparseable: the caller gets null, which is "unavailable".
  }
  return null;
}

/**
 * Whether Rocket.Chat ACCEPTED the license it holds: true, false, or null when it could not
 * be asked (not serving, or a release whose `licenses.info` does not say).
 */
export async function licenseValid(
  rootUrl: string,
  auth: Auth,
  { timeoutMs = 15_000 } = {},
): Promise<boolean | null> {
  try {
    const resp = await get(`${trimEnd(rootUrl)}/api/v1/licenses.info`, {
      headers: authHeaders(auth),
      timeoutMs,
    });
    const valid = map(body(resp).license).hasValidLicense;
    return resp.status === 200 && typeof valid === 'boolean' ? valid : null;
  } catch {
    return null;
  }
}

/**
 * Every setting id this workspace knows, or null if it could not be asked.
 *
 * Catches a silent mistake: a Rocket.Chat SETTING only takes effect from the environment
 * as `OVERWRITE_SETTING_<id>`. A bare setting id is accepted by docker, changes nothing,
 * and reports no error -- so it is worth asking the workspace itself which names are
 * settings rather than guessing from their shape.
 */
export async function settingIds(
  rootUrl: string,
  auth: Auth,
  password: string,
  { timeoutMs = 20_000 } = {},
): Promise<Set<string> | null> {
  const headers = { ...authHeaders(auth), ...(await password2faHeaders(password)) };
  try {
    // count=0 means "all" to Rocket.Chat's REST pagination.
    const resp = await get(`${trimEnd(rootUrl)}/api/v1/settings?count=0`, { headers, timeoutMs });
    if (resp.status !== 200) return null;
    const parsed = body(resp);
    if (parsed.success !== true) return null;
    const ids = new Set<string>();
    for (const setting of list(parsed.settings)) {
      const id = String(setting._id ?? '');
      if (id !== '') ids.add(id);
    }
    return ids;
  } catch {
    return null;
  }
}

/** Write a Rocket.Chat setting (2FA-guarded; satisfied via the password method). */
export async function setSetting(
  rootUrl: string,
  auth: Auth,
  password: string,
  settingId: string,
  value: unknown,
  { timeoutMs = 15_000 } = {},
): Promise<boolean> {
  const headers = {
    ...authHeaders(auth),
    'Content-Type': 'application/json',
    ...(await password2faHeaders(password)),
  };
  try {
    const resp = await post(`${trimEnd(rootUrl)}/api/v1/settings/${settingId}`, {
      headers,
      json: { value },
      timeoutMs,
    });
    return resp.status === 200 && body(resp).success === true;
  } catch {
    return false;
  }
}

/**
 * This process's loaded SAML provider, without following its missing-provider redirect.
 * A transport failure is unknown, rather than proof that a disable has completed.
 */
export async function samlProviderState(
  rootUrl: string,
  provider: string,
  { timeoutMs = 3_000, publicUrl = '' } = {},
): Promise<'loaded' | 'unloaded' | 'unknown'> {
  const exposed = new URL(publicUrl || rootUrl);
  try {
    const metadata = await get(
      `${trimEnd(rootUrl)}/_saml/metadata/${encodeURIComponent(provider)}`,
      {
        timeoutMs,
        followRedirects: false,
        headers: {
          Host: exposed.host,
          'X-Forwarded-Proto': exposed.protocol.slice(0, -1),
        },
      },
    );
    if (metadata.status === 200 && /<(?:[\w.-]+:)?EntityDescriptor\b/u.test(metadata.text))
      return 'loaded';
    if (metadata.status === 404) return 'unloaded';
    const location = metadata.headers.location;
    if (
      metadata.status === 302 &&
      location !== undefined &&
      URL.canParse(location, exposed.href) &&
      new URL(location, exposed).href === new URL('home', `${exposed.origin}/`).href
    )
      return 'unloaded';
    return 'unknown';
  } catch (error) {
    if (error instanceof RequestFailed || error instanceof TypeError) return 'unknown';
    throw error;
  }
}

/** A SAML login service exists and this Rocket.Chat process can serve its metadata. */
export async function samlProviderReady(
  rootUrl: string,
  {
    timeoutMs = 3_000,
    auth,
    publicUrl = '',
  }: { timeoutMs?: number; auth?: Auth; publicUrl?: string } = {},
): Promise<boolean> {
  try {
    // Self-configuration already has an admin session. Anonymous polling consumes the
    // same per-IP provider-list quota the next visitor needs to render the SSO button.
    const resp = await get(`${trimEnd(rootUrl)}/api/v1/service.configurations`, {
      timeoutMs,
      ...(auth === undefined ? {} : { headers: authHeaders(auth) }),
    });
    const parsed = body(resp);
    if (resp.status !== 200 || parsed.success !== true) return false;
    const service = list(parsed.configurations).find((entry) => entry.service === 'saml');
    const provider = map(service?.clientConfig).provider;
    if (typeof provider !== 'string' || provider === '') return false;
    // The service document is shared in MongoDB; metadata is served by the instance's
    // own loaded providers. Both matter when several processes share that document.
    return (await samlProviderState(rootUrl, provider, { timeoutMs, publicUrl })) === 'loaded';
  } catch (error) {
    if (error instanceof RequestFailed) return false;
    throw error;
  }
}

/**
 * Whether a `method.call` response reflects a SUCCESSFUL method run.
 *
 * `method.call` returns HTTP 200 with a top-level `success: true` even when the Meteor
 * method itself threw -- the real outcome is a JSON-encoded string in `message`
 * (`{"msg":"result", ..., "error": {...}}` on failure). So the outer flag alone reports
 * false success and the inner envelope has to be opened.
 */
export function methodSucceeded(resp: HttpResponse): boolean {
  let inner: unknown;
  try {
    const outer = body(resp);
    if (resp.status !== 200 || outer.success !== true) return false;
    inner = JSON.parse(String(outer.message ?? '{}'));
  } catch {
    return false;
  }
  return !(inner !== null && typeof inner === 'object' && 'error' in inner);
}

/** Invoke a Meteor method over REST. True on success. */
async function methodCall(
  rootUrl: string,
  auth: Auth,
  password: string,
  method: string,
  params: unknown[],
  { timeoutMs = 15_000 } = {},
): Promise<boolean> {
  const headers = {
    ...authHeaders(auth),
    'Content-Type': 'application/json',
    ...(await password2faHeaders(password)),
  };
  // `dumps(...)`, the established string in `message`: `', '` and `': '` between members
  // and `\uXXXX` for anything past ASCII, in the literal's order.
  // `JSON.stringify` wrote it compact, so every `addOAuthService` -- a dump's custom OAuth
  // provider, the oidc and saml presets' post-ready step -- sent Rocket.Chat other bytes.
  const message = dumps({ msg: 'method', id: '1', method, params });
  try {
    const resp = await post(`${trimEnd(rootUrl)}/api/v1/method.call/${method}`, {
      headers,
      json: { message },
      timeoutMs,
    });
    return methodSucceeded(resp);
  } catch {
    return false;
  }
}

/**
 * Create a Custom OAuth provider via Rocket.Chat's `addOAuthService` method.
 *
 * A custom provider's `Accounts_OAuth_Custom-<name>-*` settings do not exist until it is
 * created, so OVERWRITE_SETTING env cannot configure it -- this creates the provider (and
 * its settings) so they can then be set via the API.
 */
export async function addOauthService(
  rootUrl: string,
  auth: Auth,
  password: string,
  name: string,
  { timeoutMs = 15_000 } = {},
): Promise<boolean> {
  return await methodCall(rootUrl, auth, password, 'addOAuthService', [name], { timeoutMs });
}

/** Create a verified user (idempotent-ish: an existing username just fails). */
export async function createUser(
  rootUrl: string,
  auth: Auth,
  password: string,
  username: string,
  { timeoutMs = 15_000 } = {},
): Promise<boolean> {
  const headers = {
    ...authHeaders(auth),
    'Content-Type': 'application/json',
    ...(await password2faHeaders(password)),
  };
  try {
    const resp = await post(`${trimEnd(rootUrl)}/api/v1/users.create`, {
      headers,
      json: {
        name: username.charAt(0).toUpperCase() + username.slice(1),
        username,
        email: `${username}@example.com`,
        password: username,
        verified: true,
        requirePasswordChange: false,
      },
      timeoutMs,
    });
    return resp.status === 200 && body(resp).success === true;
  } catch {
    return false;
  }
}

/** Make `username` an Omnichannel agent (assigns the livechat-agent role). */
export async function addLivechatAgent(
  rootUrl: string,
  auth: Auth,
  password: string,
  username: string,
  { timeoutMs = 15_000 } = {},
): Promise<boolean> {
  const headers = {
    ...authHeaders(auth),
    'Content-Type': 'application/json',
    ...(await password2faHeaders(password)),
  };
  try {
    const resp = await post(`${trimEnd(rootUrl)}/api/v1/livechat/users/agent`, {
      headers,
      json: { username },
      timeoutMs,
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Give user `id` a voice call extension; false when Rocket.Chat refuses (Voice unlicensed). */
export async function setVoiceExtension(
  rootUrl: string,
  auth: Auth,
  password: string,
  id: string,
  extension: string,
  { timeoutMs = 15_000 } = {},
): Promise<boolean> {
  const headers = {
    ...authHeaders(auth),
    'Content-Type': 'application/json',
    ...(await password2faHeaders(password)),
  };
  try {
    const resp = await post(`${trimEnd(rootUrl)}/api/v1/users.update`, {
      headers,
      json: { userId: id, data: { freeSwitchExtension: extension } },
      timeoutMs,
    });
    return resp.status === 200 && body(resp).success === true;
  } catch {
    return false;
  }
}

/** Resolve a username to its `_id` via users.info, or null. */
export async function getUserId(
  rootUrl: string,
  auth: Auth,
  username: string,
  { timeoutMs = 15_000 } = {},
): Promise<string | null> {
  try {
    const resp = await get(`${trimEnd(rootUrl)}/api/v1/users.info`, {
      params: { username },
      headers: authHeaders(auth),
      timeoutMs,
    });
    if (resp.ok) {
      const id = String(map(body(resp).user)._id ?? '');
      return id === '' ? null : id;
    }
  } catch {
    // Unreachable: null, and the caller decides.
  }
  return null;
}

/**
 * Create (or find) an Omnichannel department and return its id.
 *
 * The create schema is strict -- only these department fields, no agents, which are
 * assigned separately by `assignLivechatAgents`.
 */
export async function ensureLivechatDepartment(
  rootUrl: string,
  auth: Auth,
  password: string,
  name: string,
  { timeoutMs = 15_000 } = {},
): Promise<string | null> {
  const base = `${trimEnd(rootUrl)}/api/v1`;
  const headers = {
    ...authHeaders(auth),
    'Content-Type': 'application/json',
    ...(await password2faHeaders(password)),
  };
  const department = {
    enabled: true,
    name,
    email: `${name}@example.com`,
    showOnRegistration: true,
    showOnOfflineForm: true,
  };
  try {
    const created = await post(`${base}/livechat/department`, {
      headers,
      json: { department },
      timeoutMs,
    });
    const madeBody = body(created);
    if (madeBody.success === true) {
      const id = String(map(madeBody.department)._id ?? '');
      return id === '' ? null : id;
    }
    // Already exists (or a strict-schema reject) -- look it up by name. count=0 means all
    // departments, so a match past the default page is not missed.
    const listed = await get(`${base}/livechat/department`, {
      headers,
      params: { count: 0 },
      timeoutMs,
    });
    for (const entry of list(body(listed).departments)) {
      if (entry.name === name) {
        const id = String(entry._id ?? '');
        return id === '' ? null : id;
      }
    }
  } catch {
    // Best-effort: the preset reports what it could not set up.
  }
  return null;
}

/** Assign agents to a department. Idempotent. */
export async function assignLivechatAgents(
  rootUrl: string,
  auth: Auth,
  password: string,
  deptId: string,
  agents: readonly { agentId: string; username: string }[],
  { timeoutMs = 15_000 } = {},
): Promise<boolean> {
  const headers = {
    ...authHeaders(auth),
    'Content-Type': 'application/json',
    ...(await password2faHeaders(password)),
  };
  const upsert = agents.map((agent) => ({
    agentId: agent.agentId,
    username: agent.username,
    count: 0,
    order: 0,
  }));
  try {
    const resp = await post(`${trimEnd(rootUrl)}/api/v1/livechat/department/${deptId}/agents`, {
      headers,
      json: { upsert, remove: [] },
      timeoutMs,
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Save a global canned response. An ENTERPRISE feature, so this returns false on
 * Community (403) and callers treat it as best-effort.
 */
export async function saveCannedResponse(
  rootUrl: string,
  auth: Auth,
  password: string,
  shortcut: string,
  text: string,
  { timeoutMs = 15_000 } = {},
): Promise<boolean> {
  const headers = {
    ...authHeaders(auth),
    'Content-Type': 'application/json',
    ...(await password2faHeaders(password)),
  };
  try {
    const resp = await post(`${trimEnd(rootUrl)}/api/v1/canned-responses`, {
      headers,
      json: { shortcut, text, scope: 'global' },
      timeoutMs,
    });
    return resp.status === 200 && body(resp).success === true;
  } catch {
    return false;
  }
}

/**
 * Set the logged-in agent available for Omnichannel.
 *
 * The workspace only shows as "online" to visitors once that agent also has a live
 * presence (is logged into the UI); this flips the availability flag and nothing else.
 */
export async function setLivechatAvailable(
  rootUrl: string,
  auth: Auth,
  password: string,
  { timeoutMs = 15_000 } = {},
): Promise<boolean> {
  const headers = {
    ...authHeaders(auth),
    'Content-Type': 'application/json',
    ...(await password2faHeaders(password)),
  };
  try {
    const resp = await post(`${trimEnd(rootUrl)}/api/v1/livechat/agent.status`, {
      headers,
      json: { status: 'available' },
      timeoutMs,
    });
    return resp.status === 200 && body(resp).success === true;
  } catch {
    return false;
  }
}

/**
 * An IdP's signing certificate from its SAML metadata descriptor.
 *
 * Retries until the IdP -- Keycloak, which boots slowly -- is serving. Returns the base64
 * DER cert body on a single line, which is Rocket.Chat's idp cert format.
 */
export async function fetchSamlIdpCert(
  descriptorUrl: string,
  {
    timeout = 90,
    interval = 3,
    sleep = realSleep,
  }: { timeout?: number; interval?: number; sleep?: Sleep } = {},
): Promise<string | null> {
  const deadline = now() + timeout;
  for (;;) {
    try {
      const resp = await get(descriptorUrl, { timeoutMs: 10_000 });
      if (resp.status === 200) {
        const found = /<[^>]*X509Certificate>([^<]+)</u.exec(resp.text);
        if (found !== null) return (found[1] as string).split(/\s+/u).join('');
      }
    } catch {
      // Not serving yet. That is what the loop is for.
    }
    if (now() >= deadline) return null;
    await sleep(interval);
  }
}

/**
 * The transport failure, re-exported so a caller can tell one from a 4xx.
 *
 * The seam it comes from is fenced to this module by `only-rcapi-speaks-http`, so the class
 * travels with the call that can raise it. Without this a caller has to catch EVERYTHING to
 * spot a dropped connection, and a bug in this module would be swallowed as one.
 */
export { RequestFailed } from '../seams/rc-http';

/**
 * Make an authed REST call. Returns `[status, bodyText]`.
 *
 * `params` is the point: the three modules that once bypassed this seam -- the seed, the
 * load test and the CLI -- all did so because they needed a query string. Adding the one
 * keyword they were going around it for is what lets them come back through.
 */
export async function call(
  rootUrl: string,
  method: string,
  path: string,
  {
    auth,
    data,
    extraHeaders,
    params,
    responseHeaders,
    timeoutMs = 30_000,
  }: {
    auth?: Auth;
    data?: unknown;
    extraHeaders?: Record<string, string>;
    params?: Record<string, string | number | boolean>;
    /** Optional complete response headers, without changing the status/body tuple. */
    responseHeaders?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<[number, string]> {
  const url = `${trimEnd(rootUrl)}/${path.replace(/^\/+/u, '')}`;
  const headers = { ...(auth === undefined ? {} : authHeaders(auth)), ...extraHeaders };
  const resp = await rcHttp.request(url, {
    method,
    headers,
    ...(data === undefined ? {} : { json: data }),
    ...(params === undefined ? {} : { params }),
    timeoutMs,
  });
  if (responseHeaders !== undefined) {
    for (const key of Object.keys(responseHeaders)) delete responseHeaders[key];
    Object.assign(responseHeaders, resp.headers);
  }
  return [resp.status, resp.text];
}

/**
 * The module's own injectable entry point.
 *
 * An intra-module function binding cannot be replaced from outside: swc emits exports as
 * non-configurable getters, so this object is what a caller replaces.
 */
export interface MultipartPart {
  readonly name: string;
  readonly value: string | Buffer;
  readonly filename?: string;
  readonly type?: string;
}

export async function multipart(
  rootUrl: string,
  path: string,
  headers: Record<string, string>,
  parts: readonly MultipartPart[],
): Promise<[number, string]> {
  const { randomBytes } = await import('node:crypto');
  const boundary = `houston-${randomBytes(18).toString('hex')}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (
      /[\r\n"\\]/u.test(part.name) ||
      (part.filename !== undefined && /[\r\n"\\]/u.test(part.filename))
    ) {
      throw new Error('invalid multipart field or filename');
    }
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}\r\n${part.type === undefined ? '' : `Content-Type: ${part.type}\r\n`}\r\n`,
      ),
    );
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const clean = Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'content-type'),
  );
  const response = await rcHttp.request(`${trimEnd(rootUrl)}/${path.replace(/^\/+/u, '')}`, {
    method: 'POST',
    headers: { ...clean, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body: Buffer.concat(chunks),
    timeoutMs: 60_000,
  });
  return [response.status, response.text];
}

export async function download(
  rootUrl: string,
  path: string,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  const base = new URL(`${trimEnd(rootUrl)}/`);
  const target = new URL(path, base);
  if (target.origin !== base.origin)
    throw new Error('file download must stay on the workspace origin');
  try {
    return await rcHttp.request(target.href, {
      headers,
      binary: true,
      sameOriginRedirects: true,
      timeoutMs: 60_000,
    });
  } catch {
    throw new CreateFailedError('workspace file download could not be completed');
  }
}

export const rcapi = { call, multipart, download };
