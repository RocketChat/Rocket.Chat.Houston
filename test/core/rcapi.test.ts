/**
 * The Rocket.Chat client: the login dance, the polls, and the calls that lie about failing.
 *
 * The seam has its own spec against a real socket. These cases are the domain on top of
 * it -- which failure is which, when a refusal is safer than a guess, and the three places
 * Rocket.Chat answers 200 for something that did not work.
 */
import { installAuditRecorder } from '../../src/lib/audit';
import { RequestFailed, rcHttp, type HttpResponse } from '../../src/seams/rc-http';

import {
  NotReady,
  addOauthService,
  apiInfo,
  authHeaders,
  call,
  createIncomingWebhook,
  createOutgoingWebhook,
  extractOtp,
  findIntegration,
  listIntegrations,
  updateOutgoingUrls,
  fetchEmailOtp,
  fetchSamlIdpCert,
  generatePat,
  getSetting,
  licenseValid,
  login,
  methodSucceeded,
  newestMailStamp,
  otpRecipient,
  password2faHeaders,
  rcapi,
  releaseInfo,
  samlProviderReady,
  samlProviderState,
  setSetting,
  setVoiceExtension,
  settingIds,
  waitReady,
} from '../../src/core/rcapi';

const realRequest = rcHttp.request;

type Reply = Partial<HttpResponse> | Error;
type Rule = [(url: string, options: Record<string, unknown>) => boolean, Reply];

/** Every request the scripted seam saw. */
let seen: {
  url: string;
  method: string;
  headers: Record<string, string>;
  json: unknown;
  params?: Readonly<Record<string, string | number | boolean>>;
}[] = [];

function respond(reply: Partial<HttpResponse>, url: string): HttpResponse {
  const text = reply.text ?? '';
  const status = reply.status ?? 200;
  return {
    status,
    ok: reply.ok ?? status < 400,
    text,
    headers: reply.headers ?? {},
    url,
    json:
      reply.json ??
      (() => {
        return JSON.parse(text) as unknown;
      }),
  };
}

function script(rules: Rule[], fallback: Reply = { status: 200, text: '{}' }): void {
  seen = [];
  rcHttp.request = (url, options = {}) => {
    seen.push({
      url,
      method: String(options.method ?? 'GET'),
      headers: { ...options.headers },
      json: options.json,
      ...(options.params === undefined ? {} : { params: options.params }),
    });
    const hit = rules.find(([matches]) => matches(url, options as Record<string, unknown>));
    const reply = hit === undefined ? fallback : hit[1];
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(respond(reply, url));
  };
}

const at = (fragment: string) => (url: string) => url.includes(fragment);
const nowait = () => Promise.resolve();

afterEach(() => {
  rcHttp.request = realRequest;
});

describe('release metadata', () => {
  it('returns the live document and treats transport failure as an unavailable lookup', async () => {
    script([], { status: 200, text: '{"compatibleMongoVersions":["7.0"]}' });
    await expect(releaseInfo('https://releases.example/8.5.1/info')).resolves.toEqual(
      expect.objectContaining({ status: 200 }),
    );
    expect(seen[0]?.url).toBe('https://releases.example/8.5.1/info');
    script([], new RequestFailed('refused', 'https://releases.example'));
    await expect(releaseInfo('https://releases.example/8.5.1/info')).resolves.toBeNull();
  });
});

describe('readiness', () => {
  it('reads "not serving" off any failure, and never raises from apiInfo', async () => {
    script([], new RequestFailed('refused', 'http://x'));
    expect(await apiInfo('http://x')).toBeNull();
    script([], { status: 503, text: 'gateway' });
    expect(await apiInfo('http://x')).toBeNull();
    // A 200 with an unparseable body is not serving either.
    script([], { status: 200, text: '<html>' });
    expect(await apiInfo('http://x')).toBeNull();
    script([], { status: 200, text: '{"version":"8.5.1"}' });
    expect(await apiInfo('http://x')).toEqual({ version: '8.5.1' });
    // The trailing slash comes off, or the path doubles it.
    expect(seen[0]?.url).toBe('http://x/api/info');
  });

  it('fails fast on a crashed container rather than polling it for the full timeout', async () => {
    // Five minutes of polling a container that has exited, then "did not become ready", is
    // a report that names the wrong thing and takes five minutes to do it.
    script([], { status: 502, text: '' });
    let ticks = 0;
    await expect(
      waitReady('http://x', {
        isAlive: () => false,
        sleep: nowait,
        onTick: () => {
          ticks += 1;
        },
      }),
    ).rejects.toBeInstanceOf(NotReady);
    await expect(waitReady('http://x', { isAlive: () => false, sleep: nowait })).rejects.toThrow(
      /is not running/u,
    );
    expect(ticks).toBe(0);
  });

  it('gives up at its own deadline, and says how long it waited', async () => {
    script([], { status: 502, text: '' });
    await expect(waitReady('http://x', { timeout: 0, sleep: nowait })).rejects.toThrow(
      /did not become ready within 0s/u,
    );
  });

  it('returns the payload as soon as it is serving', async () => {
    script([], { status: 200, text: '{"version":"8.5.1"}' });
    expect(await waitReady('http://x', { sleep: nowait })).toEqual({ version: '8.5.1' });
  });

  it('does not declare an exposed route ready until its complete page also answers', async () => {
    let pages = 0;
    script(
      [
        [at('/api/info'), { text: '{"version":"8.5.1"}' }],
        [
          (url) => {
            if (url !== 'http://x/') return false;
            pages += 1;
            return pages > 1;
          },
          { text: '<html>Rocket.Chat</html>' },
        ],
      ],
      { status: 503, text: 'not ready' },
    );
    expect(await waitReady('http://x', { page: true, sleep: nowait })).toEqual({
      version: '8.5.1',
    });
    expect(pages).toBe(2);
  });
});

describe('a SAML login service is actually loaded', () => {
  it('uses the existing admin session without consuming the anonymous provider-list quota', async () => {
    script(
      [
        [
          (url, options) => {
            const headers = options.headers as Record<string, string> | undefined;
            return (
              url.endsWith('/api/v1/service.configurations') &&
              headers !== undefined &&
              headers['X-Auth-Token'] === 'admin-token' &&
              headers['X-User-Id'] === 'admin-user'
            );
          },
          {
            text: JSON.stringify({
              success: true,
              configurations: [{ service: 'saml', clientConfig: { provider: 'keycloak' } }],
            }),
          },
        ],
        [at('/_saml/metadata/keycloak'), { text: '<md:EntityDescriptor entityID="rc" />' }],
      ],
      { status: 429, text: '{"success":false}' },
    );
    expect(
      await samlProviderReady('http://x', { auth: { token: 'admin-token', userId: 'admin-user' } }),
    ).toBe(true);
    expect(seen[1]?.headers).toEqual({ Host: 'x', 'X-Forwarded-Proto': 'http' });
  });

  it('requires both a SAML service document and metadata from the responding instance', async () => {
    const configurations = {
      success: true,
      configurations: [{ service: 'saml', clientConfig: { provider: 'keycloak' } }],
    };
    script([
      [at('service.configurations'), { text: JSON.stringify(configurations) }],
      [at('/_saml/metadata/keycloak'), { text: '<md:EntityDescriptor entityID="rc" />' }],
    ]);
    expect(await samlProviderReady('http://x/')).toBe(true);
    expect(seen.map((request) => request.url)).toEqual([
      'http://x/api/v1/service.configurations',
      'http://x/_saml/metadata/keycloak',
    ]);

    script([[at('service.configurations'), { text: '{"success":true,"configurations":[]}' }]]);
    expect(await samlProviderReady('http://x')).toBe(false);
    script([
      [at('service.configurations'), { text: JSON.stringify(configurations) }],
      [at('/_saml/metadata/keycloak'), { status: 404, text: 'Provider not found' }],
    ]);
    expect(await samlProviderReady('http://x')).toBe(false);
    script([
      [at('service.configurations'), { text: JSON.stringify(configurations) }],
      [at('/_saml/metadata/keycloak'), { text: '<html>Rocket.Chat</html>' }],
    ]);
    expect(await samlProviderReady('http://x')).toBe(false);
    script([], new RequestFailed('refused', 'http://x'));
    expect(await samlProviderReady('http://x')).toBe(false);
  });

  it('keeps a replica metadata probe on that replica with the advertised host and scheme', async () => {
    script(
      [
        [
          at('service.configurations'),
          {
            text: JSON.stringify({
              success: true,
              configurations: [{ service: 'saml', clientConfig: { provider: 'keycloak' } }],
            }),
          },
        ],
        [
          (url, options) =>
            url === 'http://localhost:3602/_saml/metadata/keycloak' &&
            options.followRedirects === false &&
            (options.headers as Record<string, string>).Host === 'workspace.localhost' &&
            (options.headers as Record<string, string>)['X-Forwarded-Proto'] === 'https',
          { text: '<md:EntityDescriptor entityID="rc" />' },
        ],
      ],
      { status: 302, headers: { location: 'https://workspace.localhost/home' } },
    );
    expect(
      await samlProviderReady('http://localhost:3602', {
        publicUrl: 'https://workspace.localhost',
      }),
    ).toBe(true);
  });

  it('distinguishes a completed provider unload from a request it could not make', async () => {
    script([], { status: 302, headers: { location: 'https://workspace.localhost/home' } });
    expect(
      await samlProviderState('http://localhost:3602', 'keycloak', {
        publicUrl: 'https://workspace.localhost',
      }),
    ).toBe('unloaded');
    script([], new RequestFailed('refused', 'http://localhost:3602'));
    expect(await samlProviderState('http://localhost:3602', 'keycloak')).toBe('unknown');
    script([], { status: 500, text: 'reload failed' });
    expect(await samlProviderState('http://localhost:3602', 'keycloak')).toBe('unknown');
    script([], { status: 302, headers: { location: 'http://[' } });
    expect(await samlProviderState('http://localhost:3602', 'keycloak')).toBe('unknown');
  });
});

describe('logging in', () => {
  const OK = {
    status: 200,
    text: JSON.stringify({ data: { authToken: 'tok', userId: 'uid' } }),
  };

  it('returns the token and the user id', async () => {
    script([], OK);
    expect(await login('http://x/')).toEqual({ token: 'tok', userId: 'uid' });
    expect(seen[0]?.url).toBe('http://x/api/v1/login');
    expect(seen[0]?.json).toEqual({ user: 'admin', password: 'admin123' });
  });

  it('refuses a 200 whose body is not a token, quoting what came back instead', async () => {
    // A proxy's error page served with a 200 must not escape as a JSON parse failure: the
    // body text is the only useful thing such a page ever provides.
    script([], { status: 200, text: '<html>Bad Gateway</html>' });
    await expect(login('http://x')).rejects.toThrow(/login did not return a token/u);
    await expect(login('http://x')).rejects.toThrow(/Bad Gateway/u);
  });

  it('rejects a non-200 that is not a 2FA challenge, rather than blaming 2FA', async () => {
    // `raise_for_status()` is a no-op for 3xx, so a reverse proxy's 302 to HTTPS -- the
    // case `--allow-host` exists for -- fell through into the 2FA branch and reported a
    // missing Mailpit URL for what is really a redirect.
    script([], { status: 302, text: '<html>Found</html>', ok: true });
    await expect(login('http://x')).rejects.toThrow(/302/u);
    await expect(login('http://x')).rejects.toThrow(/2FA challenge/u);
  });

  it('tries the password-fallback method before asking for an email code', async () => {
    // No email needed, so it costs nothing and works on a workspace with no Mailpit.
    let attempt = 0;
    script([
      [
        at('/login'),
        {
          status: 200,
          text: '',
          json: () => ({}),
        },
      ],
    ]);
    rcHttp.request = (url, options = {}) => {
      seen.push({
        url,
        method: 'POST',
        headers: { ...options.headers },
        json: options.json,
        ...(options.params === undefined ? {} : { params: options.params }),
      });
      attempt += 1;
      if (attempt === 1) {
        return Promise.resolve(respond({ status: 401, text: '{"error":"totp-required"}' }, url));
      }
      return Promise.resolve(respond(OK, url));
    };
    expect(await login('http://x')).toEqual({ token: 'tok', userId: 'uid' });
    expect(seen).toHaveLength(2);
    expect(seen[1]?.headers['x-2fa-method']).toBe('password');
    // The code is the sha256 of the password, which is what RC's password method wants.
    expect(seen[1]?.headers['x-2fa-code']).toBe(
      (await password2faHeaders('admin123'))['x-2fa-code'],
    );
  });

  it('REFUSES an unfiltered OTP poll rather than risk another user’s code', async () => {
    // Mailpit is a catch-all inbox for every address. With no resolvable recipient the
    // filter would be off, and the poll could hand back a DIFFERENT user's code -- the
    // exact thing the filter exists to prevent.
    script([], { status: 401, text: '{"error":"totp-required"}' });
    await expect(
      login('http://x', {
        user: 'alice',
        password: 'alice',
        mailpitUrl: 'http://mailpit',
        sleep: nowait,
      }),
    ).rejects.toThrow(/another user's code/u);
  });

  it('says so when a code is needed and no Mailpit is configured', async () => {
    script([], { status: 401, text: '{"error":"totp-required"}' });
    await expect(login('http://x', { sleep: nowait })).rejects.toThrow(/no Mailpit URL/u);
  });

  it('resolves the admin’s own address, and anything with an @ in it', () => {
    expect(otpRecipient('admin')).toBe('admin@example.com');
    expect(otpRecipient('alice@example.test')).toBe('alice@example.test');
    expect(() => otpRecipient('alice')).toThrow(/address is unknown/u);
  });

  it('snapshots the inbox first, so a stale code is never reused', async () => {
    // A code left over from a previous login sits in the catch-all inbox and reads exactly
    // like a fresh one.
    const stale = {
      ID: 'old',
      Created: '2026-01-01T00:00:00Z',
      To: [{ Address: 'admin@example.com' }],
    };
    const fresh = {
      ID: 'new',
      Created: '2026-01-01T00:05:00Z',
      To: [{ Address: 'admin@example.com' }],
    };
    let loginAttempt = 0;
    seen = [];
    rcHttp.request = (url, options = {}) => {
      seen.push({
        url,
        method: String(options.method ?? 'GET'),
        headers: { ...options.headers },
        json: options.json,
        ...(options.params === undefined ? {} : { params: options.params }),
      });
      if (url.includes('/api/v1/messages')) {
        // Before the code is sent only the stale one is there; afterwards, both.
        const messages = seen.some((entry) => entry.url.includes('sendEmailCode'))
          ? [fresh, stale]
          : [stale];
        return Promise.resolve(respond({ text: JSON.stringify({ messages }) }, url));
      }
      if (url.includes('/api/v1/message/new')) {
        return Promise.resolve(respond({ text: JSON.stringify(rcCodeMail('424-242')) }, url));
      }
      if (url.includes('/api/v1/message/old')) {
        return Promise.resolve(respond({ text: JSON.stringify(rcCodeMail('111-111')) }, url));
      }
      if (url.includes('sendEmailCode')) return Promise.resolve(respond({ text: '{}' }, url));
      loginAttempt += 1;
      if (loginAttempt <= 2) {
        return Promise.resolve(respond({ status: 401, text: '{"error":"totp-required"}' }, url));
      }
      return Promise.resolve(respond(OK, url));
    };
    expect(await login('http://x', { mailpitUrl: 'http://mailpit', sleep: nowait })).toEqual({
      token: 'tok',
      userId: 'uid',
    });
    // The FRESH code, and the stale message was never even opened.
    const final = seen[seen.length - 1];
    expect(final?.headers['x-2fa-code']).toBe('424242');
    expect(final?.headers['x-2fa-method']).toBe('email');
    expect(seen.some((entry) => entry.url.includes('/message/old'))).toBe(false);
  });

  it('blames the failed send rather than the timeout, when the send is what failed', async () => {
    script([
      [at('/api/v1/messages'), { text: '{"messages":[]}' }],
      [at('sendEmailCode'), { status: 403, ok: false, text: 'Forbidden' }],
      [at('/login'), { status: 401, text: '{"error":"totp-required"}' }],
    ]);
    await expect(
      login('http://x', { mailpitUrl: 'http://mailpit', sleep: nowait, otpTimeout: 0 }),
    ).rejects.toThrow(/sendEmailCode returned HTTP 403/u);
  });
});

/**
 * The 2FA code mail as Mailpit hands it back, modelled on what Rocket.Chat 8.5.1 and 8.8.0
 * send (`EmailCheck.send2FAEmail`, en strings, the default Email_Header/Email_Footer with
 * `email_style` inlined): the code is `ddd-ddd` in both parts. `header` stands in for a
 * customised Email_Header, the one part of the mail a workspace owner writes.
 */
function rcCodeMail(code: string, header = ''): { Text: string; HTML: string } {
  const Text =
    '\nHere is your authentication code:\n\n' +
    `${code}\n\n` +
    'Do not provide this code to anyone.\n' +
    "If you didn't try to login in your account please ignore this email.\n";
  const HTML =
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" ' +
    '"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><html xmlns="http://www.w3.org/1999/xhtml">' +
    '<head><meta name="viewport" content="width=device-width" /><meta http-equiv="Content-Type" ' +
    'content="text/html; charset=UTF-8" /><title>Rocket.Chat Cloud</title></head>' +
    '<body bgcolor="#F7F8FA" style="width: 100%; height: 100%;"><table class="body" bgcolor="#F7F8FA" ' +
    'width="100%"><tr><td><table class="wrap" bgcolor="#F7F8FA"><tr><td class="header container" ' +
    'style="max-width: 640px;"><div class="header-content"><table bgcolor="#F7F8FA" width="100%"><tr><td>' +
    '<img src="http://localhost:3000/assets/logo.png" alt="Rocket.chat" width="150px" /></td></tr>' +
    `</table>${header}</div></td></tr></table></td></tr><tr><td><table class="wrap"><tr>` +
    '<td class="container" bgcolor="#FFFFFF"><div class="content"><table><tr><td> ' +
    '\n\t\t\t\t<p>Here is your authentication code:</p>\n' +
    '\t\t\t\t<p style="font-size: 30px;">\n' +
    `\t\t\t\t\t<b>${code}</b>\n` +
    '\t\t\t\t</p>\n\t\t\t\t<p>Do not provide this code to anyone.</p>\n' +
    "\t\t\t\t<p>If you didn't try to login in your account please ignore this email.</p>\n\t\t\t " +
    '</td></tr></table></div></td></tr></table></td></tr><tr style="margin: 0; padding: 0;">' +
    '<td style="margin: 0; padding: 0;"><table class="wrap"><tr><td class="container"><div class="content">' +
    '<table width="100%"><tr><td align="center" class="social"><a href="https://rocket.chat/blog" ' +
    'style="color: #1D74F5;">Blog</a> | <a href="https://github.com/RocketChat">Github</a></td></tr>' +
    '<tr><td align="center"><h6 style="font-weight: 500; font-size: 10px; color: #6c727A; ' +
    'line-height: 1.7;">© Rocket.Chat Technologies Corp.</h6></td></tr></table></div></td></tr>' +
    '</table></td></tr></table></body></html>';
  return { Text, HTML };
}

describe('reading a code out of an inbox', () => {
  it('reads the ddd-ddd code Rocket.Chat mails, as the six digits it verifies', () => {
    // Rocket.Chat's `verify` strips non-digits, and the six digits are what it stored.
    const mail = rcCodeMail('428-913');
    expect(extractOtp(mail.Text)).toBe('428913');
    expect(extractOtp(mail.HTML)).toBe('428913');
    expect(extractOtp(rcCodeMail('042-891').HTML)).toBe('042891');
    expect(extractOtp('')).toBeNull();
  });

  it('takes nothing but that shape, so a year, a date or a colour is never sent as a code', () => {
    // A customised header ahead of the code: none of it is the code, and the code still is.
    const header =
      '<p style="color: #000000">Ticket 202610 opened 2026-10-12, call +1-555-123-4567</p>';
    expect(extractOtp(rcCodeMail('731-406', header).HTML)).toBe('731406');
    // With no code at all, a bare six-digit run or a longer dashed one is not taken for one.
    expect(extractOtp(header)).toBeNull();
    expect(extractOtp('Your login code is 428913, valid 5 min.')).toBeNull();
    expect(extractOtp('order 1234-5678 and 123-4567 and 12-345678')).toBeNull();
  });

  it('hands the code from a real-format mail to the login, digits only', async () => {
    script([
      [
        at('/api/v1/messages'),
        { text: JSON.stringify({ messages: [{ ID: '1', Created: 'z', To: [] }] }) },
      ],
      [at('/api/v1/message/1'), { text: JSON.stringify(rcCodeMail('555-019')) }],
    ]);
    expect(await fetchEmailOtp('http://m', { timeout: 0, sleep: nowait })).toBe('555019');
  });

  it('matches the recipient case-insensitively, and only the right one', async () => {
    const message = (address: string) => ({
      messages: [{ ID: '1', Created: 'z', To: [{ Address: address }] }],
    });
    script([[at('/api/v1/messages'), { text: JSON.stringify(message('Alice@Example.com')) }]]);
    expect(await newestMailStamp('http://m', { toEmail: 'alice@example.com' })).toBe('z');
    script([[at('/api/v1/messages'), { text: JSON.stringify(message('Alice@Example.com')) }]]);
    expect(await newestMailStamp('http://m', { toEmail: 'admin@example.com' })).toBe('');
    // No filter matches anything, which is why an unresolvable recipient is refused
    // upstream rather than falling through to this.
    script([[at('/api/v1/messages'), { text: JSON.stringify(message('anyone@example.com')) }]]);
    expect(await newestMailStamp('http://m')).toBe('z');
  });

  it('keeps polling through a Mailpit that is not up yet', async () => {
    // Mailpit boots alongside Rocket.Chat, so a refused connection is "not yet", not "no".
    let tries = 0;
    seen = [];
    rcHttp.request = (url) => {
      tries += 1;
      if (tries < 3) return Promise.reject(new RequestFailed('refused', url));
      if (url.includes('/api/v1/messages')) {
        return Promise.resolve(
          respond({ text: JSON.stringify({ messages: [{ ID: '1', Created: 'z', To: [] }] }) }, url),
        );
      }
      return Promise.resolve(respond({ text: JSON.stringify(rcCodeMail('999-111')) }, url));
    };
    expect(await fetchEmailOtp('http://m', { sleep: nowait })).toBe('999111');
    expect(tries).toBeGreaterThan(2);
  });

  it('answers null at the deadline rather than hanging', async () => {
    script([[at('/api/v1/messages'), { text: '{"messages":[]}' }]]);
    expect(await fetchEmailOtp('http://m', { timeout: 0, sleep: nowait })).toBeNull();
  });
});

describe('the calls that answer 200 for something that did not work', () => {
  it('opens method.call’s inner envelope, because the outer flag lies', async () => {
    // `method.call` returns HTTP 200 with `success: true` even when the Meteor method
    // threw -- the real outcome is a JSON string in `message`.
    const ran = (message: unknown) =>
      respond({ status: 200, text: JSON.stringify({ success: true, message }) }, 'u');
    expect(methodSucceeded(ran(JSON.stringify({ msg: 'result', result: 1 })))).toBe(true);
    expect(
      methodSucceeded(ran(JSON.stringify({ msg: 'result', error: { message: 'nope' } }))),
    ).toBe(false);
    // An outer failure is still a failure.
    expect(methodSucceeded(respond({ status: 200, text: '{"success":false}' }, 'u'))).toBe(false);
    expect(methodSucceeded(respond({ status: 500, text: 'boom' }, 'u'))).toBe(false);
    // An unparseable inner envelope is not a success either.
    expect(methodSucceeded(ran('not json'))).toBe(false);
  });

  it('puts the DDP message in method.call spaced as earlier releases wrote it', async () => {
    // The inner message is a STRING, and earlier releases wrote its bytes as
    // `{"msg": "method", "id": "1", ...}` with `\uXXXX` past ASCII. `JSON.stringify` wrote
    // it compact and raw, and every addOAuthService sent other bytes.
    const names = ['Keycloak', 'Ms_entra_id', 'K\u00e9y \u65e5'];
    // What earlier releases sent for each name, recorded.
    const recorded = [
      '{"msg": "method", "id": "1", "method": "addOAuthService", "params": ["Keycloak"]}',
      '{"msg": "method", "id": "1", "method": "addOAuthService", "params": ["Ms_entra_id"]}',
      '{"msg": "method", "id": "1", "method": "addOAuthService", "params": ["K\\u00e9y \\u65e5"]}',
    ];
    const ours: unknown[] = [];
    for (const name of names) {
      script([], new RequestFailed('connection refused', 'http://x'));
      expect(await addOauthService('http://x', { token: 't', userId: 'u' }, 'pw', name)).toBe(
        false,
      );
      ours.push((seen[0]?.json as { message?: unknown } | undefined)?.message);
    }
    expect(ours).toEqual(recorded);
    expect(ours[0]).toBe(
      '{"msg": "method", "id": "1", "method": "addOAuthService", "params": ["Keycloak"]}',
    );
  });

  it('treats a setting write as done only when the body says so', async () => {
    script([], { status: 200, text: '{"success":true}' });
    expect(await setSetting('http://x', { token: 't', userId: 'u' }, 'pw', 'A', 1)).toBe(true);
    script([], { status: 200, text: '{"success":false}' });
    expect(await setSetting('http://x', { token: 't', userId: 'u' }, 'pw', 'A', 1)).toBe(false);
    script([], new RequestFailed('refused', 'http://x'));
    expect(await setSetting('http://x', { token: 't', userId: 'u' }, 'pw', 'A', 1)).toBe(false);
  });

  it('reads a setting value, and answers null when it cannot', async () => {
    script([], { status: 200, text: '{"success":true,"value":"completed"}' });
    expect(
      await getSetting('http://x', { token: 't', userId: 'u' }, 'pw', 'Show_Setup_Wizard'),
    ).toBe('completed');
    script([], { status: 403, text: 'no' });
    expect(
      await getSetting('http://x', { token: 't', userId: 'u' }, 'pw', 'Show_Setup_Wizard'),
    ).toBeNull();
  });

  it('reads whether Rocket.Chat accepted its license, and answers null when it cannot say', async () => {
    const auth = { token: 't', userId: 'u' };
    script([], { status: 200, text: '{"license":{"hasValidLicense":true,"activeModules":[]}}' });
    expect(await licenseValid('http://x', auth)).toBe(true);
    // Installed and refused ("Url validation failed"): the shape is the same, the answer no.
    script([], { status: 200, text: '{"license":{"hasValidLicense":false,"activeModules":[]}}' });
    expect(await licenseValid('http://x', auth)).toBe(false);
    // A release whose licenses.info does not say, a refusal, a dead socket: not "no".
    script([], { status: 200, text: '{"license":{"activeModules":[]}}' });
    expect(await licenseValid('http://x', auth)).toBeNull();
    script([], { status: 401, text: '{"success":false}' });
    expect(await licenseValid('http://x', auth)).toBeNull();
    script([], new RequestFailed('refused', 'http://x'));
    expect(await licenseValid('http://x', auth)).toBeNull();
  });

  it('asks the workspace which names are settings, and says null when it could not', async () => {
    // A bare setting id in the environment is accepted by docker, changes nothing, and
    // reports no error -- so guessing from a name's shape is not good enough.
    script([], { status: 200, text: '{"success":true,"settings":[{"_id":"A"},{"_id":"B"},{}]}' });
    expect(await settingIds('http://x', { token: 't', userId: 'u' }, 'pw')).toEqual(
      new Set(['A', 'B']),
    );
    expect(seen[0]?.url).toContain('?count=0');
    script([], { status: 401, text: '' });
    expect(await settingIds('http://x', { token: 't', userId: 'u' }, 'pw')).toBeNull();
    script([], { status: 200, text: '{"success":false}' });
    expect(await settingIds('http://x', { token: 't', userId: 'u' }, 'pw')).toBeNull();
  });
});

describe('the personal access token', () => {
  const AUTH = { token: 't', userId: 'u' };

  it('is audited HERE, before anything is sent', async () => {
    // Eight non-test call sites in earlier releases, so a record written at one handler would
    // have missed six -- and a bypass-2FA admin token for somebody else's workspace is one
    // of the two most sensitive things this tool can do.
    const audited: string[][] = [];
    const remove = installAuditRecorder((kind, label) => audited.push([kind, label]));
    try {
      script([], { status: 200, text: '{"success":true,"token":"pat-1"}' });
      expect(await generatePat('http://x', AUTH, 'pw', { workspace: 'TICKET-1' })).toBe('pat-1');
      expect(audited).toEqual([['pat', 'TICKET-1 label=houston bypass_2fa=True']]);
    } finally {
      remove();
    }
  });

  it('records the root URL when no workspace was named, rather than nothing', async () => {
    const audited: string[][] = [];
    const remove = installAuditRecorder((kind, label) => audited.push([kind, label]));
    try {
      script([], { status: 200, text: '{"success":true,"token":"pat-1"}' });
      await generatePat('http://x', AUTH, 'pw', { bypass2fa: false, tokenName: 'ci' });
      expect(audited).toEqual([['pat', 'http://x label=ci bypass_2fa=False']]);
    } finally {
      remove();
    }
  });

  it('spells the flag as earlier releases audit it: True and False', async () => {
    // Recorded from earlier releases with every request refused, since the record is
    // written before any request. This wrote `true`/`false`, so an external grep or awk
    // over audit.log for the spelling earlier releases wrote missed every PAT this build
    // minted.
    const CASES: [string, string, string, boolean][] = [
      ['TICKET-1', 'http://x', 'houston', true],
      ['', 'http://x', 'ci', false],
    ];
    // What earlier releases audited for each case, recorded.
    const recorded = [
      ['pat', 'TICKET-1 label=houston bypass_2fa=True'],
      ['pat', 'http://x label=ci bypass_2fa=False'],
    ];
    const audited: string[][] = [];
    const remove = installAuditRecorder((kind, label) => audited.push([kind, label]));
    try {
      for (const [workspace, root, tokenName, bypass2fa] of CASES) {
        script([], new RequestFailed('connection refused', root));
        await generatePat(root, AUTH, 'pw', { workspace, tokenName, bypass2fa }).catch(() => '');
      }
    } finally {
      remove();
    }
    expect(audited).toEqual(recorded);
    expect(audited[1]).toEqual(['pat', 'http://x label=ci bypass_2fa=False']);
  });

  it('audits even a mint that then fails, because the attempt is the event', async () => {
    const audited: string[][] = [];
    const remove = installAuditRecorder((kind) => audited.push([kind]));
    try {
      script([], { status: 403, text: 'forbidden' });
      await expect(generatePat('http://x', AUTH, 'pw')).rejects.toThrow(/could not create PAT/u);
      expect(audited).toHaveLength(1);
    } finally {
      remove();
    }
  });

  it('regenerates when the token already exists', async () => {
    script([
      [at('users.generatePersonalAccessToken'), { status: 200, text: '{"success":false}' }],
      [
        at('users.regeneratePersonalAccessToken'),
        { status: 200, text: '{"success":true,"token":"pat-2"}' },
      ],
    ]);
    expect(await generatePat('http://x', AUTH, 'pw')).toBe('pat-2');
    expect(seen).toHaveLength(2);
  });

  it('keeps its contract when the network fails, rather than leaking a transport error', async () => {
    // "A token, or an Error whose message names the path". A bare RequestFailed escaping
    // would break any caller that narrows its catch.
    script([], new RequestFailed('refused', 'http://x'));
    await expect(generatePat('http://x', AUTH, 'pw')).rejects.toThrow(
      /could not reach users.generatePersonalAccessToken/u,
    );
    await expect(generatePat('http://x', AUTH, 'pw')).rejects.not.toBeInstanceOf(RequestFailed);
  });

  it('satisfies 2FA with the password method, because minting one is guarded', async () => {
    script([], { status: 200, text: '{"success":true,"token":"pat-1"}' });
    await generatePat('http://x', AUTH, 'pw');
    expect(seen[0]?.headers['x-2fa-method']).toBe('password');
    expect(seen[0]?.headers['X-Auth-Token']).toBe('t');
  });
});

describe('the rest of the surface', () => {
  it('reuses an integration it already made rather than failing', async () => {
    script([
      [at('integrations.create'), { status: 400, ok: false, text: '{"success":false}' }],
      [
        at('integrations.list'),
        {
          status: 200,
          text: JSON.stringify({
            integrations: [
              { name: 'other', type: 'webhook-incoming', _id: 'x', token: 'y' },
              { name: 'houston-loadtest-hook', type: 'webhook-incoming', _id: 'i1', token: 't1' },
            ],
          }),
        },
      ],
    ]);
    expect(await createIncomingWebhook('http://x', { token: 't', userId: 'u' }, 'pw')).toBe(
      '/hooks/i1/t1',
    );
  });

  it('answers null for a webhook it could neither create nor find', async () => {
    script([], new RequestFailed('refused', 'http://x'));
    expect(await createIncomingWebhook('http://x', { token: 't', userId: 'u' }, 'pw')).toBeNull();
  });

  it('looks before it creates: an existing hook is reused and no second one is made', async () => {
    // Rocket.Chat accepts a duplicate integration name, so "create, then look on refusal"
    // added a hook on every load test, ready and upgrade.
    script([
      [
        at('integrations.list'),
        {
          status: 200,
          text: JSON.stringify({
            integrations: [
              { name: 'houston-loadtest-hook', type: 'webhook-incoming', _id: 'i1', token: 't1' },
            ],
            total: 1,
          }),
        },
      ],
    ]);
    expect(await createIncomingWebhook('http://x', { token: 't', userId: 'u' }, 'pw')).toBe(
      '/hooks/i1/t1',
    );
    expect(seen.map((s) => s.url).some((u) => u.includes('integrations.create'))).toBe(false);
  });
});

describe('integrations, listed and made', () => {
  const AUTH = { token: 't', userId: 'u' };
  const page = (offset: number, names: string[], total: number) =>
    [
      (url: string, options: Record<string, unknown>) =>
        url.includes('integrations.list') &&
        (options.params as Record<string, unknown> | undefined)?.offset === offset,
      {
        status: 200,
        text: JSON.stringify({
          integrations: names.map((name) => ({ name, type: 'webhook-outgoing', _id: name })),
          total,
        }),
      },
    ] as Rule;

  it('reads every page of the list, and nothing when the list is refused', async () => {
    const first = Array.from({ length: 100 }, (_, i) => `hook-${String(i)}`);
    script([page(0, first, 103), page(100, ['a', 'b', 'c'], 103)]);
    const all = await listIntegrations('http://x', AUTH, 'pw');
    expect(all?.length).toBe(103);
    expect(seen.map((s) => s.params?.offset)).toEqual([0, 100]);
    script([], { status: 401, ok: false, text: '{"success":false}' });
    expect(await listIntegrations('http://x', AUTH, 'pw')).toBeNull();
  });

  it('steps by what a page held, because a workspace may cap a page below 100', async () => {
    // API_Upper_Count_Limit is a setting: a dump with 25 and 60 integrations answered 25,
    // and a loop stepping by 100 stopped there, leaving 35 posting to the customer.
    const names = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => `hook-${String(from + i)}`);
    script([page(0, names(0, 25), 60), page(25, names(25, 25), 60), page(50, names(50, 10), 60)]);
    const all = await listIntegrations('http://x', AUTH, 'pw');
    expect(all?.length).toBe(60);
    expect(seen.map((s) => s.params?.offset)).toEqual([0, 25, 50]);
  });

  it('finds an integration by its exact name and type', async () => {
    script([
      [
        at('integrations.list'),
        {
          status: 200,
          text: JSON.stringify({
            integrations: [
              { name: 'houston-outgoing-old', type: 'webhook-outgoing', _id: 'old' },
              { name: 'houston-outgoing', type: 'webhook-incoming', _id: 'in' },
              { name: 'houston-outgoing', type: 'webhook-outgoing', _id: 'out' },
            ],
            total: 3,
          }),
        },
      ],
    ]);
    const found = await findIntegration('http://x', AUTH, 'pw', {
      name: 'houston-outgoing',
      type: 'webhook-outgoing',
    });
    expect(found?._id).toBe('out');
  });

  it('creates the outgoing webhook as rocket.cat on every public channel, with a token the admin UI can save', async () => {
    script([
      [at('integrations.list'), { status: 200, text: '{"integrations":[],"total":0}' }],
      [
        at('integrations.create'),
        {
          status: 200,
          text: '{"success":true,"integration":{"_id":"o1","name":"houston-outgoing"}}',
        },
      ],
    ]);
    const made = await createOutgoingWebhook('http://x', AUTH, 'pw', {
      name: 'houston-outgoing',
      urls: ['http://webhooks:8080/s/outgoing'],
    });
    expect(made).toBe('o1');
    const sent = seen.find((s) => s.url.includes('integrations.create'));
    expect(sent?.json).toMatchObject({
      type: 'webhook-outgoing',
      name: 'houston-outgoing',
      enabled: true,
      username: 'rocket.cat',
      channel: 'all_public_channels',
      event: 'sendMessage',
      urls: ['http://webhooks:8080/s/outgoing'],
      scriptEnabled: false,
      retryFailedCalls: true,
    });
    expect((sent?.json as { token: string }).token).toMatch(/^[0-9a-f]{48}$/u);
    expect(sent?.headers['x-2fa-method']).toBe('password');
  });

  it('reuses an outgoing webhook of that name rather than making a second', async () => {
    script([
      [
        at('integrations.list'),
        {
          status: 200,
          text: '{"integrations":[{"name":"houston-outgoing","type":"webhook-outgoing","_id":"o1"}],"total":1}',
        },
      ],
    ]);
    expect(
      await createOutgoingWebhook('http://x', AUTH, 'pw', {
        name: 'houston-outgoing',
        urls: ['u'],
      }),
    ).toBe('o1');
    expect(seen.some((s) => s.url.includes('integrations.create'))).toBe(false);
  });

  it('repoints an integration by resending only the fields the update schema takes', async () => {
    // The update writes EVERY field from its body, refuses unknown keys and an empty token,
    // and wants the channel list as the comma-joined string the form sends.
    script([[at('integrations.update'), { status: 200, text: '{"success":true}' }]]);
    const stored = {
      _id: 'jira',
      type: 'webhook-outgoing',
      name: 'Jira',
      enabled: true,
      username: 'rocket.cat',
      userId: 'rocket.cat-id',
      channel: ['#general', '#x'],
      event: 'sendMessage',
      urls: ['https://jira.example.com/hook'],
      triggerWords: ['jira'],
      scriptEnabled: true,
      script: 'class Script {}',
      scriptCompiled: 'compiled',
      scriptEngine: 'isolated-vm',
      retryFailedCalls: true,
      retryCount: 6,
      _createdAt: '2026-01-01',
      _createdBy: { _id: 'u' },
    };
    const ok = await updateOutgoingUrls('http://x', AUTH, 'pw', stored, [
      'http://webhooks:8080/s/captured/Jira?from=x',
    ]);
    expect(ok).toBe(true);
    // A PUT, as Rocket.Chat registers it (API.v1.put): a POST is refused on every version,
    // which a live 8.6.2 said and this stub could not.
    expect(seen[0]?.method).toBe('PUT');
    const sent = seen[0]?.json as Record<string, unknown>;
    expect(sent).toMatchObject({
      type: 'webhook-outgoing',
      integrationId: 'jira',
      name: 'Jira',
      channel: '#general,#x',
      urls: ['http://webhooks:8080/s/captured/Jira?from=x'],
      triggerWords: ['jira'],
      scriptEnabled: true,
      script: 'class Script {}',
      retryCount: 6,
    });
    expect(String(sent.token)).toMatch(/^[0-9a-f]{48}$/u);
    for (const key of [
      '_id',
      'userId',
      '_createdAt',
      '_createdBy',
      'scriptCompiled',
      'scriptEngine',
    ]) {
      expect(sent).not.toHaveProperty(key);
    }
    script([], { status: 400, ok: false, text: '{"success":false}' });
    expect(await updateOutgoingUrls('http://x', AUTH, 'pw', stored, ['u'])).toBe(false);
  });

  it('keeps retrying a SAML descriptor while the IdP boots, then reads one line', async () => {
    // Keycloak boots slowly, so "not serving" is not "no certificate".
    let tries = 0;
    seen = [];
    rcHttp.request = (url) => {
      tries += 1;
      if (tries < 3) return Promise.reject(new RequestFailed('refused', url));
      return Promise.resolve(
        respond(
          {
            text: '<md:KeyDescriptor><ds:X509Certificate>MIIC\n  AgEB\n  ABC=\n</ds:X509Certificate>',
          },
          url,
        ),
      );
    };
    expect(await fetchSamlIdpCert('http://idp/descriptor', { sleep: nowait })).toBe('MIICAgEBABC=');
  });

  it('answers null for an IdP that never came up', async () => {
    script([], new RequestFailed('refused', 'http://idp'));
    expect(await fetchSamlIdpCert('http://idp', { timeout: 0, sleep: nowait })).toBeNull();
  });

  it('returns a status and a body from call(), and sends the auth headers', async () => {
    script([], { status: 202, text: 'accepted' });
    expect(
      await call('http://rc/', 'get', '/api/info', { auth: { token: 'tok', userId: 'uid' } }),
    ).toEqual([202, 'accepted']);
    expect(seen[0]?.url).toBe('http://rc/api/info');
    expect(seen[0]?.headers).toMatchObject(authHeaders({ token: 'tok', userId: 'uid' }));
    // An extra header wins over the auth ones, which is what `extra_headers` is for.
    script([], { status: 200, text: '' });
    await call('http://rc', 'POST', 'api/v1/x', {
      auth: { token: 'tok', userId: 'uid' },
      data: { a: 1 },
      extraHeaders: { 'X-Auth-Token': 'override' },
    });
    expect(seen[0]?.headers['X-Auth-Token']).toBe('override');
    expect(seen[0]?.json).toEqual({ a: 1 });
  });

  it('carries a query string, which is what the three bypasses were going around it for', async () => {
    // The seed, perf and CLI code once called `/api/v1/...` directly, around this client,
    // and a query string is what each of them needed. `only-rcapi-speaks-http`
    // is the gate that brings them back through, so the keyword has to exist for them to
    // come.
    script([], { status: 200, text: '{}' });
    await call('http://rc', 'GET', '/api/v1/channels.info', {
      params: { roomName: 'team chat', count: 0 },
    });
    expect(seen[0]?.params).toEqual({ roomName: 'team chat', count: 0 });
    // And a call with no params sends none, rather than an empty `?`.
    script([], { status: 200, text: '{}' });
    await call('http://rc', 'GET', '/api/info');
    expect(seen[0]?.params).toBeUndefined();
  });

  it('preserves rate-limit response headers without changing the status/body tuple', async () => {
    const responseHeaders = { obsolete: 'a previous response' };
    script([], {
      status: 429,
      text: '{"success":false}',
      headers: { 'x-ratelimit-reset': '1791625753228', 'retry-after': '49' },
    });
    await expect(
      call('http://rc', 'POST', '/api/v1/chat.react', { responseHeaders }),
    ).resolves.toEqual([429, '{"success":false}']);
    expect(responseHeaders).toEqual({
      'x-ratelimit-reset': '1791625753228',
      'retry-after': '49',
    });
    expect(seen[0]?.headers).toEqual({});
  });

  it('does NOT swallow a transport failure in call(), unlike the best-effort helpers', async () => {
    // `call` is the `houston api` command's own path: an unreachable workspace has to
    // reach the caller, which renders it, rather than becoming a silent empty body.
    script([], new RequestFailed('refused', 'http://rc'));
    await expect(call('http://rc', 'GET', '/api/info')).rejects.toBeInstanceOf(RequestFailed);
  });
});

describe('the REST seam the callers go through', () => {
  it('is a replaceable property, so seed, the CLI and the GUI can all be stubbed at one place', async () => {
    // swc emits exports as non-configurable getters; `rcapi.call` is the property every
    // caller that speaks REST reaches it through, so replacing it must take effect.
    const real = rcapi.call;
    const seenCalls: unknown[][] = [];
    try {
      rcapi.call = (...args: Parameters<typeof call>) => {
        seenCalls.push(args);
        return Promise.resolve([202, 'accepted'] as [number, string]);
      };
      expect(await rcapi.call('http://rc', 'GET', '/api/info')).toEqual([202, 'accepted']);
      expect(seenCalls).toEqual([['http://rc', 'GET', '/api/info']]);
    } finally {
      rcapi.call = real;
    }
  });
});

describe('a voice call extension', () => {
  it('is set through users.update, and only a success body counts', async () => {
    script([[at('/api/v1/users.update'), { status: 200, text: '{"success":true}' }]]);
    expect(
      await setVoiceExtension('http://x', { token: 't', userId: 'u' }, 'pw', 'id1', '1001'),
    ).toBe(true);
    const sent = seen.find((r) => r.url.endsWith('/api/v1/users.update'));
    expect([sent?.method, sent?.json]).toEqual([
      'POST',
      { userId: 'id1', data: { freeSwitchExtension: '1001' } },
    ]);
  });

  it('is refused while Voice is unlicensed, and a refusal is false, not a throw', async () => {
    // Rocket.Chat lets an extension be edited only while SIP integration is effective.
    script([
      [
        at('/api/v1/users.update'),
        { status: 400, text: '{"success":false,"errorType":"error-action-not-allowed"}' },
      ],
    ]);
    expect(
      await setVoiceExtension('http://x', { token: 't', userId: 'u' }, 'pw', 'id1', '1001'),
    ).toBe(false);
    script([], new RequestFailed('refused', 'http://x'));
    expect(
      await setVoiceExtension('http://x', { token: 't', userId: 'u' }, 'pw', 'id1', '1001'),
    ).toBe(false);
  });
});
