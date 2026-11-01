/**
 * `web/routes/meta`: health, the Host guard, security headers, version preview, doctor,
 * settings and the static assets -- over HTTP, end to end.
 *
 * Several of these properties are proven as PRIMITIVES in `test/web/security.test.ts` -- Host
 * normalisation, the guard chain -- and this proves them on the routes a browser actually
 * asks for. That a failing recovery does not stop `serve` from serving is proven in
 * `test/cli/serve.test.ts` instead, because `serve` is where recovery runs.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import type { FastifyInstance } from 'fastify';

import * as doctor from '../../../src/core/doctor';
import { CLUSTER_MB, WORKSPACE_MB } from '../../../src/core/lifecycle/sizing';
import { CREATE_POLICY_KEY, PRIVILEGED_CREATE_FIELDS } from '../../../src/core/lifecycle/types';
import * as host from '../../../src/core/runner/host';
import * as users from '../../../src/core/users';
import { metadata, writeRecord } from '../../../src/core/runner/record';
import * as config from '../../../src/lib/config';
import { createApp, type AppOptions } from '../../../src/web/app';
import { JobManager } from '../../../src/web/jobs';

import type * as PolicyNS from '../../testsetup-policy';

// This file OWNS `runner/host`, because the version preview reads the engine's kernel. It
// keeps the suite's healthy engine and adds the one probe it needs to state per case.
jest.mock('../../../src/core/runner/host', () => ({
  ...(require('../../testsetup-policy') as typeof PolicyNS).healthyHost(),
  dockerKernelVersion: jest.fn(async () => '6.1.167'),
}));
jest.mock('../../../src/core/doctor', () => ({
  ...jest.requireActual('../../../src/core/doctor'),
  runChecks: jest.fn(),
}));

const PASSWORD = 'a-good-enough-password';

let home = '';
const apps: FastifyInstance[] = [];

async function appWith(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = await createApp({ accounts: true, ...options });
  await app.ready();
  apps.push(app);
  return app;
}

async function signIn(app: FastifyInstance, user = 'alice', role = 'admin'): Promise<string> {
  await users.add(user, PASSWORD, role);
  const response = await app.inject({
    method: 'POST',
    url: '/api/session',
    payload: { user, password: PASSWORD },
    headers: { host: 'localhost' },
  });
  expect(response.statusCode).toBe(200);
  return String(response.headers['set-cookie'] ?? '').split(';')[0] ?? '';
}

const as = (cookie: string) => ({ host: 'localhost', cookie });

it('Grafana public URL regression: permits the monitored HTTPS origin in the GUI iframe policy', async () => {
  const app = await appWith({ accounts: false });
  await writeRecord(
    'w',
    metadata({
      name: 'w',
      publicUrl: 'https://rc.example.test',
      extra: { tls: 'local', monitoring: true },
    }),
  );
  await writeRecord(
    'bare',
    metadata({
      name: 'bare',
      publicUrl: 'https://unserved.example.test',
      extra: { monitoring: true },
    }),
  );
  const response = await app.inject({ url: '/', headers: { host: 'localhost' } });
  expect(response.statusCode).toBe(200);
  expect(String(response.headers['content-security-policy'])).toContain(
    "frame-src 'self' http://localhost:5050 https://rc.example.test;",
  );
  expect(String(response.headers['content-security-policy'])).not.toContain(
    'https://unserved.example.test',
  );
});

it("lets the GUI frame a second monitored workspace's Grafana, on the port it was given", async () => {
  // The k6 dashboard is an iframe: a page allowing only localhost:5050 refused it.
  const app = await appWith({ accounts: false });
  await writeRecord('first', metadata({ name: 'first', extra: { monitoring: true } }));
  await writeRecord(
    'second',
    metadata({ name: 'second', extra: { monitoring: true, monitoring_ports: [9091, 5051] } }),
  );
  const response = await app.inject({ url: '/', headers: { host: 'localhost' } });
  expect(String(response.headers['content-security-policy'])).toContain(
    "frame-src 'self' http://localhost:5050 http://localhost:5051;",
  );
});

it('Grafana public URL regression: refreshes the iframe policy when cached HTML is revalidated', async () => {
  const app = await appWith({ accounts: false });
  const before = await app.inject({ url: '/', headers: { host: 'localhost' } });
  expect(String(before.headers['content-security-policy'])).not.toContain(
    'https://later.example.test',
  );
  await writeRecord(
    'later',
    metadata({
      name: 'later',
      publicUrl: 'https://later.example.test',
      extra: { tls: 'local', monitoring: true },
    }),
  );
  for (const conditional of [
    { 'if-none-match': String(before.headers.etag) },
    { 'if-modified-since': String(before.headers['last-modified']) },
  ]) {
    const after = await app.inject({ url: '/', headers: { host: 'localhost', ...conditional } });
    expect(after.statusCode).toBe(304);
    expect(String(after.headers['content-security-policy'])).toContain(
      'https://later.example.test',
    );
  }
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-meta-'));
  process.env.HOUSTON_HOME = home;
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('/api/health', () => {
  it('needs no session, and says whether docker answers', async () => {
    const response = await (
      await appWith()
    ).inject({ url: '/api/health', headers: { host: 'localhost' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('docker');
  });

  it('stays open to a signed-in caller too, for uptime checks', async () => {
    const app = await appWith();
    const alice = await signIn(app);
    expect((await app.inject({ url: '/api/health', headers: as(alice) })).statusCode).toBe(200);
  });

  it('says nothing about identity', async () => {
    // It used to carry an `actor`, and deriving one let an anonymous caller spend scrypt per
    // request just by attaching a header. `GET /api/session` is where identity lives.
    const body = (
      await (await appWith()).inject({ url: '/api/health', headers: { host: 'localhost' } })
    ).json();
    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty('actor');
  });

  it('does not carry the edge, which shells out to docker twice', async () => {
    // Every tab polls /api/health every four seconds; it is the cheap one on purpose.
    const app = await appWith();
    const body = (await app.inject({ url: '/api/health', headers: as(await signIn(app)) })).json();
    expect(body).not.toHaveProperty('routes');
    expect(body).not.toHaveProperty('edge');
  });
});

describe('the Host guard', () => {
  it('refuses a Host that is not this machine', async () => {
    const response = await (
      await appWith()
    ).inject({ url: '/api/health', headers: { host: 'evil.example' } });
    expect(response.statusCode).toBe(403);
  });

  it('compares case-insensitively, without widening the list', async () => {
    // Comparing raw is a fail-CLOSED bug: `curl http://LOCALHOST:7070/` and a proxy
    // forwarding `Host: Lab.Example.Com` both read as the guard being broken.
    const app = await appWith({ allowHosts: ['Lab.Example.Com'] });
    for (const allowed of [
      'LOCALHOST',
      'LocalHost',
      'localhost',
      'lab.example.com',
      'LAB.EXAMPLE.COM',
      'Lab.Example.Com:443',
    ]) {
      const response = await app.inject({ url: '/api/health', headers: { host: allowed } });
      expect({ allowed, status: response.statusCode }).toEqual({ allowed, status: 200 });
    }
    for (const refused of ['evil.example', 'lab.example.com.evil', 'notlocalhost']) {
      const response = await app.inject({ url: '/api/health', headers: { host: refused } });
      expect({ refused, status: response.statusCode }).toEqual({ refused, status: 403 });
    }
  });

  it('admits a proxy domain only when it is allowed, by name or by *', async () => {
    const proxied = { host: 'x.iximiuz.com' };
    expect(
      (await (await appWith()).inject({ url: '/api/health', headers: proxied })).statusCode,
    ).toBe(403);
    expect(
      (
        await (
          await appWith({ allowHosts: ['x.iximiuz.com'] })
        ).inject({ url: '/api/health', headers: proxied })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await (
          await appWith({ allowHosts: ['*'] })
        ).inject({ url: '/api/health', headers: proxied })
      ).statusCode,
    ).toBe(200);
  });

  it('refuses a request with no Host at all, on a real socket', async () => {
    // "" used to be a member of the allow-list, so a Host-less request walked past the
    // DNS-rebind guard. ON A REAL SOCKET, because `inject()` fills in a Host of its own:
    // measured, `inject({ headers: { host: '' } })` reached the handler and answered 200,
    // while the same bytes over TCP were refused.
    const app = await appWith();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    const statusLine = (request: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
        let data = '';
        socket.on('data', (chunk) => (data += String(chunk)));
        socket.on('end', () => resolve(data.split('\r\n')[0] ?? ''));
        socket.on('error', reject);
      });
    expect(
      await statusLine('GET /api/health HTTP/1.1\r\nHost: \r\nConnection: close\r\n\r\n'),
    ).toBe('HTTP/1.1 403 Forbidden');
    expect(await statusLine('GET /api/health HTTP/1.0\r\nConnection: close\r\n\r\n')).toBe(
      'HTTP/1.1 403 Forbidden',
    );
    // And the same socket admits the loopback name, so the refusals above are about Host.
    expect(
      await statusLine('GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'),
    ).toBe('HTTP/1.1 200 OK');
  });

  it('admits the IPv6 loopback, bracketed, with or without a port', async () => {
    // '[::1]:7070'.split(':')[0] is '[', so a naive port strip refused the loopback.
    const app = await appWith();
    for (const loopback of ['[::1]:7070', '[::1]']) {
      const response = await app.inject({ url: '/api/health', headers: { host: loopback } });
      expect({ loopback, status: response.statusCode }).toEqual({ loopback, status: 200 });
    }
  });

  it('names the host it refused, and the exact flag that would admit it', async () => {
    // "host not allowed (use serve --allow-host)" never said WHICH name to add.
    const app = await appWith();
    const refused = await app.inject({ url: '/api/health', headers: { host: 'lab.example.com' } });
    expect(refused.statusCode).toBe(403);
    const error = String(refused.json().error);
    expect(error).toContain('lab.example.com');
    expect(error).toContain('--allow-host lab.example.com');
    // A port on the refused Host must not end up inside the suggested flag.
    const withPort = await app.inject({
      url: '/api/health',
      headers: { host: 'lab.example.com:9944' },
    });
    expect(String(withPort.json().error)).toContain('--allow-host lab.example.com`');
  });

  it('bounds what it echoes back', async () => {
    // A 4 KB Host header must not become a 4 KB error body.
    const refused = await (
      await appWith()
    ).inject({ url: '/api/health', headers: { host: 'a'.repeat(4000) } });
    expect(refused.statusCode).toBe(403);
    expect(String(refused.json().error).length).toBeLessThan(400);
  });
});

describe('the security headers', () => {
  it('forbid inline script and plugins, sniffing, and an off-origin Referer', async () => {
    const response = await (
      await appWith()
    ).inject({ url: '/api/health', headers: { host: 'localhost' } });
    const directives = Object.fromEntries(
      String(response.headers['content-security-policy'])
        .split(';')
        .map((one) => one.trim())
        .filter((one) => one !== '')
        .map((one) => {
          const at = one.indexOf(' ');
          return at === -1 ? [one, ''] : [one.slice(0, at), one.slice(at + 1)];
        }),
    ) as Record<string, string>;
    // An injected inline handler cannot run even if a renderer forgets to escape.
    expect(directives['script-src']?.trim()).toBe("'self'");
    // Style ATTRIBUTES are used throughout the UI, so styles do need it.
    expect(directives['style-src']).toContain("'unsafe-inline'");
    expect(directives['object-src']?.trim()).toBe("'none'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    // `same-origin`, not `no-referrer`: the page's own origin must still arrive.
    expect(response.headers['referrer-policy']).toBe('same-origin');
  });
});

describe('the version preview', () => {
  it('shows the MongoDB pairing before a multi-gigabyte pull, and refuses nonsense', async () => {
    const app = await appWith();
    const alice = await signIn(app);
    const preview = await app.inject({
      url: '/api/versions/8.5.1?offline=true',
      headers: as(alice),
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ mongo_tag: '8.0', mongo_flavor: 'official' });
    // Kernel 6.1 runs MongoDB 8 fine.
    expect(preview.json()).not.toHaveProperty('warning');
    expect(
      (await app.inject({ url: '/api/versions/nonsense', headers: as(alice) })).statusCode,
    ).toBe(400);
  });

  it('warns about the MongoDB 8 kernel trap before the pull, not minutes into it', async () => {
    // SERVER-121912: mongod 8.0 hard-exits on kernel >= 6.19, and the failure reads like a
    // volume or permission problem.
    jest.mocked(host.dockerKernelVersion).mockResolvedValue('6.19.7-200.fc43');
    const app = await appWith();
    const alice = await signIn(app);
    const trapped = (
      await app.inject({ url: '/api/versions/8.5.1?offline=true', headers: as(alice) })
    ).json();
    expect(String(trapped.warning)).toContain('SERVER-121912');
    // An older Rocket.Chat pairs with an older MongoDB, so no warning.
    const older = (
      await app.inject({ url: '/api/versions/7.10.13?offline=true', headers: as(alice) })
    ).json();
    expect(older).not.toHaveProperty('warning');
    expect(older.mongo_tag).toBe('7.0');
  });
});

describe('the preset list', () => {
  it('says which presets can be created on Kubernetes', async () => {
    const app = await appWith();
    const alice = await signIn(app);
    const listed = (await app.inject({ url: '/api/presets', headers: as(alice) })).json() as {
      presets: { name: string; kubernetes: boolean }[];
    };
    const k8s = Object.fromEntries(
      listed.presets.map((preset) => [preset.name, preset.kubernetes]),
    );
    expect([k8s.ldap, k8s.email, k8s.saml, k8s.default]).toEqual([true, true, true, true]);
    // airgapped is settings only, so Kubernetes takes it as it is.
    expect(k8s.airgapped).toBe(true);
    // Several instances is the deployment shape, offered as such; not a preset to pick.
    expect('multi-instance' in k8s).toBe(false);
  });
});

describe('/api/doctor', () => {
  it('returns the report the CLI renders, verdict included', async () => {
    jest.mocked(doctor.runChecks).mockResolvedValue({
      checks: [{ status: 'fail', message: 'Docker daemon not running' }],
      counts: { ok: 0, warn: 0, fail: 1 },
      verdict: 'fail',
      repros: null,
    } as never);
    const app = await appWith();
    const body = (await app.inject({ url: '/api/doctor', headers: as(await signIn(app)) })).json();
    // The dashboard needs the verdict to colour its banner, not just the rows.
    expect(body.verdict).toBe('fail');
    expect(body.checks[0].status).toBe('fail');
  });

  it('drops a row the browser already shows, and never a problem', async () => {
    // A row tagged `elsewhere` names a place the GUI shows the same fact permanently. The
    // CLI keeps it -- a terminal has no chip and no People page -- and that asymmetry is the
    // point.
    jest.mocked(doctor.runChecks).mockResolvedValue({
      checks: [
        { status: 'ok', message: 'Docker daemon running' },
        {
          status: 'ok',
          message: '3 GUI account(s), admin: lovekesh',
          elsewhere: 'the People page',
        },
        { status: 'fail', message: 'No admin account' },
      ],
      counts: { ok: 2, warn: 0, fail: 1 },
      verdict: 'fail',
      repros: null,
    } as never);
    const app = await appWith();
    const body = (await app.inject({ url: '/api/doctor', headers: as(await signIn(app)) })).json();
    const messages = (body.checks as { message: string }[]).map((row) => row.message);
    expect(messages).not.toContain('3 GUI account(s), admin: lovekesh');
    expect(messages).toContain('Docker daemon running');
    expect(messages).toContain('No admin account');
    // The counts still describe every check that ran, so the verdict holds.
    expect(body.counts.ok).toBe(2);
  });

  it('needs a session before it runs a single check', async () => {
    expect(
      (await (await appWith()).inject({ url: '/api/doctor', headers: { host: 'localhost' } }))
        .statusCode,
    ).toBe(401);
  });
});

describe('the static assets', () => {
  it('must revalidate, so an upgrade is not masked by a cached GUI', async () => {
    // With no freshness directive a browser may reuse a cached copy WITHOUT revalidating, so
    // after an upgrade the old modules keep running and new UI simply is not there.
    // SIGNED IN, as earlier releases' test client was: signed out, `/` is a redirect to sign-in.
    const app = await appWith();
    const alice = await signIn(app);
    for (const url of ['/js/boot.js', '/js/main.js', '/app.css']) {
      const response = await app.inject({ url, headers: as(alice) });
      expect({ url, status: response.statusCode }).toEqual({ url, status: 200 });
      expect({ url, cache: response.headers['cache-control'] }).toEqual({ url, cache: 'no-cache' });
      expect(response.headers.etag).toBeTruthy();
    }
    // `no-cache` means "revalidate first", not "do not store": a matching ETag stays cheap.
    const etag = String(
      (await app.inject({ url: '/js/main.js', headers: as(alice) })).headers.etag,
    );
    const revalidated = await app.inject({
      url: '/js/main.js',
      headers: { ...as(alice), 'if-none-match': etag },
    });
    expect(revalidated.statusCode).toBe(304);
    expect(revalidated.body).toBe('');
    // API responses are not given a blanket directive; the SSE stream sets its own.
    expect(
      (await app.inject({ url: '/api/health', headers: { host: 'localhost' } })).headers[
        'cache-control'
      ],
    ).toBeUndefined();
  });
});

describe('the page after signing out', () => {
  it('is never stored, so Back asks the server and is sent to sign-in', async () => {
    // Back after signing out showed the cached page, whose modules were then answered with a
    // redirect to sign-in: a shell with nothing running. `no-cache` lets a browser show its
    // stored copy on Back without asking; `no-store` leaves it no copy to show.
    const app = await appWith();
    const alice = await signIn(app);
    for (const url of ['/', '/index.html']) {
      const page = await app.inject({ url, headers: as(alice) });
      expect({ url, status: page.statusCode }).toEqual({ url, status: 200 });
      expect({ url, cache: page.headers['cache-control'] }).toEqual({ url, cache: 'no-store' });
    }
    const signedOut = await app.inject({ url: '/', headers: { host: 'localhost' } });
    expect(signedOut.statusCode).toBe(303);
    expect(String(signedOut.headers.location)).toMatch(/^\/signin\?/u);
  });
});

describe('/api/settings', () => {
  it('says whether an email is remembered without ever returning it', async () => {
    const app = await appWith();
    const alice = await signIn(app);
    const before = (
      await app.inject({ url: '/api/settings', headers: as(alice) })
    ).json() as Record<string, unknown>;
    expect(before.acme_email_remembered).toBe(false);
    // THE ADDRESS, not every "@": eksctl names its kubeconfig contexts
    // `<user>@<cluster>.<region>.eksctl.io`, and those rows are in this payload.
    for (const [key, value] of Object.entries(before)) {
      if (key !== 'kube_clusters')
        expect({ key, at: String(JSON.stringify(value)).includes('@') }).toEqual({
          key,
          at: false,
        });
    }
    config.updateConfig((cfg) => {
      cfg.acme_email = 'ops@rocket.chat';
    });
    const after = await app.inject({ url: '/api/settings', headers: as(alice) });
    expect(after.json().acme_email_remembered).toBe(true);
    expect(after.body).not.toContain('ops@rocket.chat');
  });

  it("reports the box's default bind host, which a browser elsewhere cannot find out", async () => {
    const app = await appWith();
    const alice = await signIn(app);
    expect(
      (await app.inject({ url: '/api/settings', headers: as(alice) })).json().default_bind_host,
    ).toBe('127.0.0.1');
    config.updateConfig((cfg) => {
      cfg.bind_host = '0.0.0.0';
    });
    expect(
      (await app.inject({ url: '/api/settings', headers: as(alice) })).json().default_bind_host,
    ).toBe('0.0.0.0');
  });

  it('needs a session before it describes the box', async () => {
    expect(
      (await (await appWith()).inject({ url: '/api/settings', headers: { host: 'localhost' } }))
        .statusCode,
    ).toBe(401);
  });

  it('tells the dialog who may set the privileged fields, rather than letting it recompute', async () => {
    // Two places deciding one permission is how the dialog offered fields the API rejects.
    const app = await appWith();
    await users.add('alice', PASSWORD, 'admin');
    const bob = await signIn(app, 'bob', 'member');
    const open = (await app.inject({ url: '/api/settings', headers: as(bob) })).json();
    expect(open.may_set_privileged).toBe(true);
    expect(open.privileged_fields).toEqual([...PRIVILEGED_CREATE_FIELDS]);
    config.updateConfig((cfg) => {
      (cfg as Record<string, unknown>)[CREATE_POLICY_KEY] = 'admin';
    });
    expect(
      (await app.inject({ url: '/api/settings', headers: as(bob) })).json().may_set_privileged,
    ).toBe(false);
  });

  it('publishes what each runtime costs and refuses, from the constants the preflight spends', async () => {
    // Both have moved -- the refusal list shrank twice -- and a card quoting a cost the
    // preflight does not use is a card the refusal contradicts.
    const app = await appWith();
    const body = (
      await app.inject({ url: '/api/settings', headers: as(await signIn(app)) })
    ).json() as {
      runtimes: {
        name: string;
        unsupported: { field: string; why: string }[];
        cost: Record<string, Record<string, number>>;
      }[];
    };
    const kube = body.runtimes.find((runtime) => runtime.name === 'kubernetes');
    const docker = body.runtimes.find((runtime) => runtime.name === 'docker');
    expect(docker?.unsupported).toEqual([]);
    // `https` LEFT this set when the ingress path landed, and the GUI followed with no JS
    // change -- the property this endpoint exists for.
    expect(new Set(kube?.unsupported.map((one) => one.field))).toEqual(new Set(['fresh']));
    expect(kube?.unsupported.every((one) => one.why !== '')).toBe(true);
    expect(docker?.cost.monolith?.workspace_mb).toBe(WORKSPACE_MB);
    const micro = kube?.cost.microservices;
    expect(micro?.workspace_mb).toBeGreaterThan(kube?.cost.monolith?.workspace_mb ?? Infinity);
    // Charged once per machine.
    expect(micro?.cluster_mb).toBe(CLUSTER_MB);
  });
});

describe('shutdown', () => {
  it('drains the job registry, because the hook is wired to the app and not merely present', async () => {
    const jobs = new JobManager();
    const drain = jest.spyOn(jobs, 'drain');
    const app = await createApp({ accounts: true, jobs });
    await app.ready();
    await app.inject({ url: '/api/health', headers: { host: 'localhost' } });
    await app.close();
    expect(drain).toHaveBeenCalledTimes(1);
  });
});
