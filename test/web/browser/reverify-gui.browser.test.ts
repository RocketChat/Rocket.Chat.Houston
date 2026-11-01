/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

// Serve the shipped browser assets against a small HTTP/WebSocket fixture. These
// regressions concern what a browser keeps, displays and permits; no engine or
// external cluster is needed to exercise the same response shapes.
const assets = path.resolve(__dirname, '../../../data/webui');
const initialWorkspace = {
  name: 'admin-ticket',
  runtime: 'docker',
  state: 'running',
  health: 'healthy',
  rc_version: '8.5.1',
  mongo_tag: '8.0',
  preset: 'default',
  host_port: 3301,
  root_url: 'http://localhost:3301',
  open_url: 'http://localhost:3301',
  licensed: false,
  license_refused: false,
  owner: 'admin',
  created_by: 'admin',
  uptime: '2 minutes',
  containers: [],
  notes: [],
  note_groups: [] as unknown[],
  links: [],
  may_destroy: true,
};
type LogSocket = {
  send: (line: string) => void;
  close: (code?: number) => void;
  terminate: () => void;
  once: (event: 'close', listener: () => void) => unknown;
};

describe('live re-verification GUI regressions', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let app: FastifyInstance;
  let origin = '';
  let role = 'admin';
  let user = 'admin';
  let accounts = true;
  let edgeInstalled = false;
  let workspace = { ...initialWorkspace };
  // Other workspaces on the box, beside `workspace`, as the list answers them.
  let others: Record<string, unknown>[] = [];
  // Why the server would refuse this viewer the bundle ('' when it would not).
  let refusal = '';
  let listReads = 0;
  let connections = 0;
  let mutations = 0;
  let clustersGate: Promise<void> | null = null;
  // Holds the next list read open until released: a reply that never comes.
  let listGate: Promise<void> | null = null;
  let jobs: { id: string; kind: string; label: string; status: string; verb?: string }[] = [];
  const sockets = new Set<LogSocket>();
  const pageErrors: string[] = [];

  beforeAll(async () => {
    browser = await chromium.launch();
  });
  beforeEach(async () => {
    role = 'admin';
    user = 'admin';
    accounts = true;
    edgeInstalled = false;
    workspace = { ...initialWorkspace };
    others = [];
    refusal = '';
    listReads = 0;
    connections = 0;
    mutations = 0;
    clustersGate = null;
    listGate = null;
    jobs = [];
    pageErrors.length = 0;
    app = Fastify({ logger: false });
    await app.register(websocket);
    app.get('/api/repros/admin-ticket/logs/stream', { websocket: true }, (socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('close', () => {
        sockets.delete(socket);
      });
      socket.send(`rocketchat-1 | connected-${String(connections)}`);
    });
    app.get('/', async (_request, reply) =>
      reply.type('text/html').send(fs.readFileSync(path.join(assets, 'index.html'))),
    );
    app.get('/app.css', async (_request, reply) =>
      reply.type('text/css').send(fs.readFileSync(path.join(assets, 'app.css'))),
    );
    app.get('/js/:file', async (request, reply) => {
      const { file } = request.params as { file: string };
      return reply
        .type('text/javascript')
        .send(fs.readFileSync(path.join(assets, 'js', path.basename(file))));
    });
    app.get('/favicon.ico', async (_request, reply) => reply.code(204).send());
    app.get('/api/*', async (request) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/api/repros') {
        listReads += 1;
        if (listGate !== null) {
          const gate = listGate;
          listGate = null;
          await gate;
        }
        return { repros: [workspace, ...others] };
      }
      if (pathname.endsWith('/detail'))
        // As the server answers: with no accounts there is nobody to refuse.
        return {
          ...workspace,
          may_destroy: !accounts || role === 'admin' || workspace.owner === user,
        };
      if (pathname.endsWith('/stats')) return { cpu: 1, mem_mb: 100 };
      if (pathname.endsWith('/env')) return { env: [], settings: {}, source: 'fixture' };
      if (pathname === '/api/health') return { docker: true };
      if (pathname === '/api/session') return { accounts, user, role };
      if (pathname === '/api/kubernetes') return { usable: false, tools_ready: false };
      if (pathname === '/api/edge')
        return {
          installed: edgeInstalled,
          running: edgeInstalled,
          routes: [],
        };
      if (pathname === '/api/clusters') {
        if (clustersGate !== null) await clustersGate;
        return { contexts: [], unreadable: '', default: '' };
      }
      if (pathname === '/api/clusters/overview') return { clusters: [], failed: [], preflight: {} };
      if (pathname === '/api/clusters/connection') return { error: '', profiles: [] };
      if (pathname === '/api/settings') return { may_set_privileged: true };
      if (pathname === '/api/machine')
        return { known: true, room: 2, total_mb: 8192, available_mb: 4096, reserve_mb: 1024 };
      if (pathname === '/api/jobs') return { jobs };
      if (pathname.startsWith('/api/jobs/'))
        return jobs.find((job) => pathname === `/api/jobs/${job.id}`) ?? { status: 'done' };
      if (pathname === '/api/audit') return { lines: [] };
      if (pathname === '/api/presets') return { presets: [] };
      if (pathname === '/api/users') return { users: [], roles: ['admin', 'member', 'readonly'] };
      if (pathname === '/api/sessions') return { sessions: [] };
      if (pathname === '/api/backups')
        return {
          backups: [
            {
              path: '/fixture/ticket.rcbak',
              repro: workspace.name,
              rc_version: '8.5.1',
              preset: 'email',
              bytes: 1024,
            },
          ],
        };
      return {};
    });
    app.post('/api/*', async (request, reply) => {
      // A read the GUI makes by POST: whether a restore as new could start.
      if (new URL(request.url, 'http://localhost').pathname === '/api/backups/compatibility')
        return { compatibility: null, refusal };
      mutations += 1;
      return role === 'readonly'
        ? reply.code(403).send({ error: 'Your role is readonly.' })
        : { job_id: 'fixture-job' };
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    origin = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
    context = await browser.newContext({ baseURL: origin });
    page = await context.newPage();
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });
  });
  afterEach(async () => {
    await context.close();
    for (const socket of sockets) socket.terminate();
    sockets.clear();
    await app.close();
    expect(pageErrors).toEqual([]);
    expect(app.server.listening).toBe(false);
  });
  afterAll(async () => {
    await browser.close();
  });

  async function dashboard(expectedUser = 'admin'): Promise<void> {
    await page.goto('/');
    await page.locator('.wrow').first().waitFor();
    await page.waitForFunction(
      (name) => document.querySelector('#whoami')?.textContent.startsWith(name) === true,
      expectedUser,
    );
  }
  async function selectWorkspace(): Promise<void> {
    await page.locator('.wrow').click();
    await page.locator('#detail .tabs').waitFor();
  }
  async function refresh(): Promise<void> {
    const before = listReads;
    await page.locator('#btn-refresh').click();
    await page.waitForFunction(
      () => document.querySelector('#btn-refresh')?.textContent === 'Refresh',
    );
    expect(listReads).toBeGreaterThan(before);
  }

  test('a create still running when the page loads is shown as creating until its job ends', async () => {
    // The rail's "working" state lived only in the page that started the job: after a
    // reload during a create, the row read `down` beside a create still in progress.
    workspace = { ...initialWorkspace, state: 'down', health: '', uptime: '' };
    jobs = [{ id: 'job-create', kind: 'create', label: workspace.name, status: 'running' }];
    await dashboard();
    await page.waitForFunction(
      () => document.querySelector('.wrow .wstate')?.textContent === 'Creating',
    );
    expect(await page.locator('.wrow').getAttribute('data-state')).toBe('working');
    workspace = { ...initialWorkspace };
    jobs = [];
    await page.waitForFunction(
      () => document.querySelector('.wrow .wstate')?.textContent === 'running',
    );
    expect(await page.locator('.wrow').getAttribute('data-state')).toBe('running');
  });

  test('home does not ask about a workspace whose create is still running', async () => {
    // Measured live: during a create Home said "<name> is down. It still holds port and its
    // data volume. [Review]" -- `down` is only what an unfinished create looks like.
    workspace = { ...initialWorkspace, state: 'down', health: '', uptime: '' };
    jobs = [{ id: 'job-create', kind: 'create', label: workspace.name, status: 'running' }];
    await dashboard();
    await page.waitForFunction(
      () => document.querySelector('.wrow .wstate')?.textContent === 'Creating',
    );
    await page.locator('#btn-home').click();
    await page.locator('#detail', { hasText: 'Good' }).waitFor({ state: 'visible' });
    expect(await page.locator('#detail').textContent()).not.toContain(`${workspace.name} is down`);
  });

  test("restore as new is offered beside a colleague's workspace on the preferred ports", async () => {
    // A copy is given side ports of its own. The dialog used to name whoever held 8025 and
    // advise deleting it; now nothing about another workspace's ports stands in the way.
    others = [
      { ...initialWorkspace, name: 'bob-mail', host_port: 3302, owner: 'bob', created_by: 'bob' },
    ];
    await dashboard();
    await page.locator('#btn-backups').click();
    await page.locator('#detail button', { hasText: 'restore as new' }).click();
    await page.locator('#restore-dialog[open]').waitFor({ state: 'visible' });
    const said = (await page.locator('#restore-dialog').textContent()) ?? '';
    expect(said).not.toContain('bob-mail');
    expect(said).not.toContain('8025');
    expect(await page.locator('#restore-go').isDisabled()).toBe(false);
    await page.locator('#restore-cancel').click();
    expect(mutations).toBe(0);
  });

  test('deleting taken-down workspaces says whose, and that stopped ones are kept', async () => {
    // "Prune down repros" asked "Delete every 'down' repro?": not whose, nor what "down" is.
    await dashboard();
    expect(await page.locator('#btn-prune').textContent()).toBe('Delete taken-down workspaces');
    const asked = new Promise<string>((resolve) => {
      page.once('dialog', (dialog) => {
        resolve(dialog.message());
        void dialog.dismiss();
      });
    });
    await page.locator('#btn-prune').click();
    const said = await asked;
    expect(said).toContain('every taken-down workspace you are allowed to delete');
    expect(said).toContain("(an admin: everyone's)");
    expect(said).toContain('Stopped ones');
    expect(said).toContain('This cannot be undone.');
    expect(mutations).toBe(0);
  });

  test("a running job is named with the GUI's verbs, not its job kind", async () => {
    // Activity said "teardown: admin-ticket" and "state: other-ws". A take down and a delete
    // are one kind, as are Stop, Start and Restart, and the record says neither which.
    workspace = { ...initialWorkspace, state: 'down', health: '', uptime: '' };
    jobs = [
      { id: 'job-teardown', kind: 'teardown', label: workspace.name, status: 'running' },
      { id: 'job-state', kind: 'state', label: 'other-ws', status: 'running' },
    ];
    await dashboard();
    await page.waitForFunction(
      () => document.querySelector('.wrow .wstate')?.textContent === 'Taking down or deleting',
    );
    await page.locator('#btn-jobs').click();
    await page.locator('#jobs-list .jkind').first().waitFor();
    expect(await page.locator('#jobs-list .jkind').allTextContents()).toEqual([
      'Take down or delete: admin-ticket',
      'Stop, start or restart: other-ws',
    ]);
  });

  test('a running job says which of its kind it is once its record carries the verb', async () => {
    // The record now says it (`verb`): a Delete and a Take down read apart, as do Stop, Start
    // and Restart, in the rail and in Activity.
    workspace = { ...initialWorkspace, state: 'down', health: '', uptime: '' };
    jobs = [
      {
        id: 'job-teardown',
        kind: 'teardown',
        label: workspace.name,
        status: 'running',
        verb: 'delete',
      },
      { id: 'job-state', kind: 'state', label: 'other-ws', status: 'running', verb: 'stop' },
    ];
    await dashboard();
    await page.waitForFunction(
      () => document.querySelector('.wrow .wstate')?.textContent === 'Deleting',
    );
    await page.locator('#btn-jobs').click();
    await page.locator('#jobs-list .jkind').first().waitFor();
    expect(await page.locator('#jobs-list .jkind').allTextContents()).toEqual([
      'Delete: admin-ticket',
      'Stop: other-ws',
    ]);
  });

  test("restore as new of a colleague's backup is shown disabled, saying who can", async () => {
    // The server refuses anyone but the bundle's owner or an admin; the dialog offered the
    // Restore button anyway, and the click was refused.
    role = 'member';
    user = 'carol';
    workspace = { ...initialWorkspace, name: 'bob-ticket', owner: 'bob', created_by: 'bob' };
    await dashboard('carol');
    await page.locator('#btn-backups').click();
    refusal = "this backup is bob's data — only bob or an admin can use or delete it";
    await page.locator('#detail button', { hasText: 'restore as new' }).click();
    await page.locator('#restore-dialog[open]').waitFor({ state: 'visible' });
    const go = page.locator('#restore-go');
    expect(await go.isDisabled()).toBe(true);
    expect(await go.getAttribute('title')).toBe(
      "This backup is bob's data — only bob or an admin can use or delete it.",
    );
    await page.locator('#restore-cancel').click();
    // The server's answer for the bundle's owner or an admin: offered as before.
    refusal = '';
    await page.locator('#detail button', { hasText: 'restore as new' }).click();
    await page.locator('#restore-dialog[open]').waitFor({ state: 'visible' });
    expect(await go.isDisabled()).toBe(false);
    expect(await go.getAttribute('title')).toBe('');
    expect(mutations).toBe(0);
  });

  test('a workspace behind a tunnel opens at the address it advertises, not localhost', async () => {
    // Measured live: `--root-url https://testin6.kestron.org` served Rocket.Chat on that name,
    // and Home's Open and the panel's Open RC both led to http://localhost:3014 -- the
    // reader's own machine.
    workspace = { ...initialWorkspace, open_url: 'https://ticket.example.test' };
    await dashboard();
    await page.locator('#btn-home').click();
    const home = page.locator('#detail .drow a', { hasText: 'Open' });
    await home.waitFor({ state: 'visible' });
    expect(await home.getAttribute('href')).toBe('https://ticket.example.test');
    await selectWorkspace();
    const open = page.locator('#detail .d-actions a', { hasText: 'Open RC' });
    expect(await open.getAttribute('href')).toBe('https://ticket.example.test');
  });

  test('a license Rocket.Chat refused is said in amber, not badged Licensed', async () => {
    // Measured live: a license bound to another URL was installed and refused ("Url
    // validation failed"), and the panel still showed "Licensed".
    workspace = { ...initialWorkspace, licensed: true, license_refused: true };
    await dashboard();
    await selectWorkspace();
    expect(await page.locator('#detail .d-sub .pill').allInnerTexts()).toEqual(['License refused']);
    expect(await page.locator('#detail .d-sub .pill.warn').count()).toBe(1);
  });

  test("a guide's <workspace-url> on an https workspace names its public address", async () => {
    // The placeholder read `d.url`, which no payload carries, so it fell back to root_url:
    // over HTTPS the livechat step sent a remote reader to http://localhost:3301/livechat.
    const guide = {
      name: 'livechat',
      summary: 'Livechat with a widget.',
      signIn: [],
      steps: ['Open the built-in widget at <workspace-url>/livechat, and start a chat.'],
      know: [],
      setup: null,
    };
    workspace = {
      ...initialWorkspace,
      preset: 'livechat',
      open_url: 'https://ticket.example.test',
      note_groups: [
        {
          title: 'Preset · livechat',
          kind: 'scenario',
          rows: [],
          body: ['A livechat department is set up.'],
          commands: [],
          guides: [guide],
        },
      ],
    };
    await dashboard();
    await selectWorkspace();
    const step = page.locator('#d-body .guide-pane li', { hasText: 'built-in widget' });
    await step.waitFor({ state: 'visible' });
    expect(await step.innerText()).toContain('https://ticket.example.test/livechat');
  });

  test('a refused license says Bring up asks again, not Restart', async () => {
    // The title said "restart the workspace, and houston ready asks again", but the GUI's
    // Restart on Docker never re-checks the license: only Bring up asks Rocket.Chat again.
    workspace = { ...initialWorkspace, licensed: true, license_refused: true };
    await dashboard();
    await selectWorkspace();
    const title = (await page.locator('#detail .d-sub .pill.warn').getAttribute('title')) ?? '';
    expect(title).toContain('Bring up asks Rocket.Chat again');
    expect(title).not.toMatch(/restart/iu);
  });

  test('a list read that never answers is given up, and the rail carries on', async () => {
    // `api()` had no deadline, and the list poll queues each read behind the last one: a
    // single read that never answered froze the rail until the page was reloaded.
    await dashboard();
    await page.evaluate(async () => {
      const load = new Function('name', 'return import(name)') as (
        specifier: string,
      ) => Promise<{ ctx: { API_TIMEOUT_MS: number } }>;
      (await load('/js/shared.js')).ctx.API_TIMEOUT_MS = 1000;
    });
    let release = (): void => undefined;
    listGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    workspace = { ...initialWorkspace, state: 'down', health: '', uptime: '' };
    try {
      await page.waitForFunction(
        () => document.querySelector('.wrow .wstate')?.textContent === 'down',
        undefined,
        { timeout: 20_000 },
      );
      expect(listGate).toBeNull(); // the held read was the one given up
    } finally {
      release();
    }
  });

  test('reload keeps each top-level view in the rendered page', async () => {
    await dashboard();
    for (const [button, view, heading] of [
      ['#btn-clusters', 'clusters', 'Clusters'],
      ['#btn-backups', 'backups', 'Backups'],
      ['#btn-jobs', 'activity', 'Activity'],
      ['#btn-scenarios', 'scenarios', 'Presets'],
      ['#btn-home', 'home', 'Good'],
    ]) {
      await page.locator(button ?? '').click();
      if (view === 'activity') await page.locator('#act-tab-history').click();
      const before = await page.locator('#detail h1').innerText();
      expect(before).toContain(heading);
      await page.reload();
      await page.waitForFunction(
        (text) => document.querySelector('#detail h1')?.textContent === text,
        before,
      );
      expect(new URL(page.url()).hash).toBe(
        `#/${view ?? ''}${view === 'activity' ? '/history' : ''}`,
      );
      if (view === 'activity')
        expect(await page.locator('#act-tab-history').getAttribute('class')).toContain('active');
    }
  });

  test.each(['overview', 'logs', 'containers', 'env', 'backups'])(
    'reload keeps the selected workspace %s tab',
    async (tab) => {
      await dashboard();
      await selectWorkspace();
      const label = tab === 'env' ? 'Env vars' : tab.charAt(0).toUpperCase() + tab.slice(1);
      await page
        .locator('#detail .tab')
        .filter({ hasText: new RegExp(`^${label}$`) })
        .click();
      await page.reload();
      await page.waitForFunction(
        (wanted) => document.querySelector('#detail .tab.active')?.textContent === wanted,
        label,
      );
      expect(await page.locator('#detail .d-head .name').textContent()).toBe(workspace.name);
      expect(new URL(page.url()).hash).toBe(`#/workspace/${workspace.name}/${tab}`);
    },
  );

  test('reload restores People over the same underlying view', async () => {
    await dashboard();
    await page.locator('#btn-backups').click();
    await page.locator('#whoami').click();
    await page.locator('#me-people').click();
    await page.reload();
    await page.locator('#people-dialog[open]').waitFor();
    expect(await page.locator('#detail h1').textContent()).toBe('Backups');
    await page.locator('#people-close').click();
    await page.waitForURL('**/#/backups');
    expect(new URL(page.url()).hash).toBe('#/backups');
  });

  test('Back and Forward restore workspace selection and its tab', async () => {
    await dashboard();
    await selectWorkspace();
    await page
      .locator('#detail .tab')
      .filter({ hasText: /^Backups$/ })
      .click();
    await page.locator('#btn-clusters').click();
    await page.goBack();
    await page.waitForFunction(
      () => document.querySelector('#detail .tab.active')?.textContent === 'Backups',
    );
    expect(await page.locator('#detail .d-head .name').textContent()).toBe(workspace.name);
    await page.goForward();
    await page.waitForFunction(
      () => document.querySelector('#detail h1')?.textContent === 'Clusters',
    );
  });

  test('an unchanged poll keeps the rail node and keyboard focus attached', async () => {
    await dashboard();
    await selectWorkspace();
    await page.locator('.wrow').evaluate((node) => {
      (node as HTMLButtonElement).focus();
      (window as Window & { focusedRail?: Element }).focusedRail = node;
    });
    const before = listReads;
    await page.waitForResponse((response) => new URL(response.url()).pathname === '/api/repros');
    await page.waitForTimeout(100);
    expect(listReads).toBeGreaterThan(before);
    expect(
      await page.evaluate(() => {
        const saved = (window as Window & { focusedRail?: Element }).focusedRail;
        return saved?.isConnected === true && saved === document.activeElement;
      }),
    ).toBe(true);
  });

  test('a changed poll updates a rail row without replacing its button', async () => {
    await dashboard();
    await page.locator('.wrow').evaluate((node) => {
      (window as Window & { savedRail?: Element }).savedRail = node;
    });
    workspace = { ...workspace, state: 'stopped', health: '', uptime: '' };
    await refresh();
    expect(await page.locator('.wrow .wstate').textContent()).toBe('stopped');
    expect(
      await page
        .locator('.wrow')
        .evaluate((node) => node === (window as Window & { savedRail?: Element }).savedRail),
    ).toBe(true);
  });

  test('an owner-only poll refreshes the open member detail and handover control', async () => {
    role = 'member';
    user = 'bob';
    await dashboard('bob');
    await selectWorkspace();
    expect(await page.locator('#actpane button', { hasText: 'Hand over…' }).count()).toBe(0);
    workspace = { ...workspace, owner: 'bob', created_by: 'bob' };
    await page.waitForFunction(
      () => document.querySelector('#detail .d-sub')?.textContent.includes('bob') === true,
      null,
      { timeout: 6000 },
    );
    expect(await page.locator('#actpane button', { hasText: 'Hand over…' }).isVisible()).toBe(true);
    expect(await page.locator('#detail .d-head .name').textContent()).toBe(workspace.name);
    expect(workspace.state).toBe('running');
    expect(workspace.health).toBe('healthy');
  });

  test('a member sees a colleague’s workspace, but nothing that changes it, nor its logs, env or login', async () => {
    // The owner's call after Okta: members see every workspace and change only their own.
    // The server sends no login for it (`login: null`) and refuses every change with 409.
    role = 'member';
    user = 'bob';
    workspace = { ...workspace, owner: 'carol', created_by: 'carol', login: null } as never;
    await dashboard('bob');
    await selectWorkspace();
    const actions = page.locator('#detail .d-actions');
    expect(await actions.locator('button', { hasText: /^(Stop|Restart|Start)$/u }).count()).toBe(0);
    expect(await actions.locator('.inline-note').textContent()).toContain(
      "carol's workspace — you can look; only carol or an admin can change it",
    );
    const tabs = await page.locator('#detail .tabs button').allTextContents();
    expect(tabs).not.toContain('Logs');
    expect(tabs).not.toContain('Env vars');
    expect(await page.locator('#actpane button').count()).toBe(0);
    expect(await page.locator('#actpane .apnote').textContent()).toContain(
      "This is carol's workspace. You can look at it; only carol or an admin can change it",
    );
    expect(await page.locator('#detail').textContent()).toContain(
      'Hidden. Only carol or an admin can see it.',
    );
    expect(mutations).toBe(0);
    // Handed to bob, the same panel is his to use again.
    workspace = { ...workspace, owner: 'bob', created_by: 'bob' };
    await page.locator('#actpane button', { hasText: 'Hand over…' }).waitFor({ timeout: 6000 });
    expect(await actions.locator('button', { hasText: 'Stop' }).count()).toBe(1);
    expect(await page.locator('#detail .tabs button').allTextContents()).toContain('Logs');
  });

  test('a box without accounts offers every control, the CLI default included', async () => {
    // No accounts means no roles: the session answers role ''. Gating "Use for CLI
    // commands" on the admin role alone took it away from every single-user box.
    accounts = false;
    role = '';
    user = '';
    await page.goto('/');
    await page.locator('.wrow').waitFor();
    await selectWorkspace();
    await page.locator('#actpane button', { hasText: 'Use for CLI commands' }).waitFor();
    expect(await page.locator('#detail .d-actions button', { hasText: 'Stop' }).count()).toBe(1);
    expect(await page.locator('#detail .tabs button').allTextContents()).toContain('Logs');
  });

  test('the tablet top bar keeps the account and navigation inside 768 pixels', async () => {
    // The live clipping occurred with an idle installed edge: "edge: 0 names".
    edgeInstalled = true;
    await page.setViewportSize({ width: 768, height: 900 });
    await dashboard();
    await page.locator('#edge-badge').waitFor({ state: 'visible' });
    const bounds = await page.evaluate(() => ({
      viewport: window.innerWidth,
      width: document.documentElement.scrollWidth,
      controls: [...document.querySelectorAll('.topbar button')]
        .filter((button) => button.getClientRects().length > 0)
        .map((button) => ({
          id: button.id,
          left: button.getBoundingClientRect().left,
          right: button.getBoundingClientRect().right,
        })),
    }));
    expect(bounds.width).toBeLessThanOrEqual(bounds.viewport);
    for (const control of bounds.controls) {
      expect(control.left).toBeGreaterThanOrEqual(0);
      expect(control.right).toBeLessThanOrEqual(bounds.viewport);
    }
    await page.locator('#whoami').click();
    expect(await page.locator('#me-menu').isVisible()).toBe(true);
    await page.locator('#whoami').click();
    await page.locator('#me-menu').waitFor({ state: 'hidden' });
    await page.locator('#nav-toggle').click();
    await page.locator('#btn-backups').click();
    await page.waitForURL('**/#/backups');
    expect(await page.locator('#detail h1').textContent()).toBe('Backups');
  });

  test('readonly workspace backups expose no enabled mutations while bundles stay readable', async () => {
    role = 'readonly';
    await dashboard();
    await selectWorkspace();
    await page
      .locator('#detail .tab')
      .filter({ hasText: /^Backups$/ })
      .click();
    await page.locator('#d-body .dtable').waitFor();
    expect(await page.locator('#d-body').innerText()).toContain('ticket.rcbak');
    const enabled = await page.locator('#d-body button:enabled').allTextContents();
    expect(enabled.filter((text) => /back up now|restore|as new|delete/i.test(text))).toEqual([]);
    const refusal = await page.request.post('/api/restore', {
      data: { bundle: '/fixture/ticket.rcbak', name: 'admin-ticket', new: false },
    });
    expect(refusal.status()).toBe(403);
  });

  test('delayed Logs rendering keeps only the latest bounded batch and releases it on exit', async () => {
    await dashboard();
    await selectWorkspace();
    await page
      .locator('#detail .tab')
      .filter({ hasText: /^Logs$/ })
      .click();
    await page.locator('#logview').filter({ hasText: 'connected-1' }).waitFor();
    await page.evaluate(async () => {
      const load = new Function('name', 'return import(name)') as (
        specifier: string,
      ) => Promise<Record<string, unknown>>;
      const logs = (await load('/js/logs.js')) as unknown as {
        logv: { buf: unknown[]; pending: unknown[] };
      };
      logs.logv.buf = [];
      logs.logv.pending = [];
      const host = window as Window & {
        delayedLogsFrame?: {
          original: typeof requestAnimationFrame;
          callback: FrameRequestCallback | null;
          scheduled: number;
        };
      };
      const probe = { original: requestAnimationFrame, callback: null, scheduled: 0 } as {
        original: typeof requestAnimationFrame;
        callback: FrameRequestCallback | null;
        scheduled: number;
      };
      host.delayedLogsFrame = probe;
      // Keep the real WebSocket handler running while its one rendering frame is
      // withheld. No timing race or browser-background throttling is needed.
      window.requestAnimationFrame = (callback): number => {
        probe.callback = callback;
        probe.scheduled += 1;
        return 123456;
      };
    });
    for (const socket of sockets)
      for (let index = 0; index < 3600; index += 1)
        socket.send(`rocketchat-1 | delayed-marker-${String(index)}`);
    await page.waitForFunction(
      async () => {
        const load = new Function('name', 'return import(name)') as (
          specifier: string,
        ) => Promise<Record<string, unknown>>;
        const logs = (await load('/js/logs.js')) as unknown as {
          logv: { buf: { msg: string }[] };
        };
        return logs.logv.buf.at(-1)?.msg === 'delayed-marker-3599';
      },
      undefined,
      { polling: 50 },
    );
    const pending = await page.evaluate(async () => {
      const load = new Function('name', 'return import(name)') as (
        specifier: string,
      ) => Promise<Record<string, unknown>>;
      const logs = (await load('/js/logs.js')) as unknown as {
        logv: { buf: { msg: string }[]; pending: { msg: string }[]; frame: number };
      };
      const host = window as Window & { delayedLogsFrame?: { scheduled: number } };
      return {
        buffered: logs.logv.buf.length,
        messages: logs.logv.pending.map((row) => row.msg),
        frame: logs.logv.frame,
        scheduled: host.delayedLogsFrame?.scheduled,
      };
    });
    expect(pending.buffered).toBe(3000);
    expect(pending.messages).toHaveLength(3000);
    expect(pending.messages).toEqual(
      Array.from({ length: 3000 }, (_, index) => `delayed-marker-${String(index + 600)}`),
    );
    expect(pending.frame).toBe(123456);
    expect(pending.scheduled).toBe(1);
    await page.evaluate(() => {
      const host = window as Window & {
        delayedLogsFrame?: {
          original: typeof requestAnimationFrame;
          callback: FrameRequestCallback | null;
        };
      };
      const probe = host.delayedLogsFrame;
      if (probe === undefined || probe.callback === null) throw new Error('missing delayed frame');
      window.requestAnimationFrame = probe.original;
      const callback = probe.callback;
      delete host.delayedLogsFrame;
      callback(performance.now());
    });
    expect(await page.locator('#logview .logrow .lm').allTextContents()).toEqual(pending.messages);
    await page
      .locator('#detail .tab')
      .filter({ hasText: /^Overview$/ })
      .click();
    const released = await page.evaluate(async () => {
      const load = new Function('name', 'return import(name)') as (
        specifier: string,
      ) => Promise<Record<string, unknown>>;
      const logs = (await load('/js/logs.js')) as unknown as {
        logv: { buf: unknown[]; pending: unknown[]; frame: number; onUnseen: unknown };
      };
      return {
        buffered: logs.logv.buf.length,
        pending: logs.logv.pending.length,
        frame: logs.logv.frame,
        callback: logs.logv.onUnseen,
      };
    });
    expect(released).toEqual({ buffered: 0, pending: 0, frame: 0, callback: null });
    expect(await page.locator('#logview').count()).toBe(0);
  });

  test.each(['Overview', 'Activity'])(
    'leaving Logs for %s releases its rendered tree while preferences survive a fresh stream',
    async (exitView) => {
      await dashboard();
      await selectWorkspace();
      await page
        .locator('#detail .tab')
        .filter({ hasText: /^Logs$/ })
        .click();
      await page.locator('#logview').filter({ hasText: 'connected-1' }).waitFor();
      await page.locator('.logctl select').first().selectOption('warn');
      await page.locator('#log-svc').selectOption('rocketchat');
      await page.locator('.logctl input[aria-label="filter log lines"]').fill('retention-marker');
      await page.locator('.logfollow input').uncheck();
      for (const socket of sockets)
        socket.send('rocketchat-1 | {"level":40,"msg":"retention-marker-before"}');
      await page
        .locator('#logview .logrow')
        .filter({ hasText: 'retention-marker-before' })
        .waitFor();
      expect(await page.locator('.logfollow input').isChecked()).toBe(false);
      await page.evaluate(() => {
        const view = document.querySelector('#logview');
        const row = view?.querySelector('.logrow');
        if (view === null || row === undefined || row === null)
          throw new Error('the real Logs view and rendered message are required');
        const host = window as Window & {
          closedLogsProbe?: { view: WeakRef<Element>; row: WeakRef<Element> };
        };
        // Return no node or handle: only weak page references outlive this task.
        host.closedLogsProbe = { view: new WeakRef(view), row: new WeakRef(row) };
      });
      const disconnected = Promise.all(
        [...sockets].map((socket) => new Promise<void>((resolve) => socket.once('close', resolve))),
      );
      if (exitView === 'Overview') {
        await page
          .locator('#detail .tab')
          .filter({ hasText: /^Overview$/ })
          .click();
      } else {
        await page.locator('#btn-jobs').click();
        await page.waitForURL('**/#/activity/running');
        await page.locator('#detail h1').filter({ hasText: 'Activity' }).waitFor();
      }
      await page.locator('#logview').waitFor({ state: 'detached' });
      // The four-second idle-status closure is temporary; let it settle before
      // checking whether the obsolete DOM remains reachable after a full collection.
      await page.waitForTimeout(4200);
      const diagnostic = await context.newCDPSession(page);
      try {
        await diagnostic.send('HeapProfiler.collectGarbage');
        await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
        const retained = await page.evaluate(() => {
          const host = window as Window & {
            closedLogsProbe?: { view: WeakRef<Element>; row: WeakRef<Element> };
          };
          const probe = host.closedLogsProbe;
          return {
            probeCreated: probe !== undefined,
            viewAlive: probe?.view.deref() !== undefined,
            rowAlive: probe?.row.deref() !== undefined,
          };
        });
        expect(retained).toEqual({ probeCreated: true, viewAlive: false, rowAlive: false });
        // A direct top-bar exit must also close its obsolete real stream. Check
        // after collectibility so pre-fix Activity fails at the semantic retainer.
        expect(sockets.size).toBe(0);
        await disconnected;
        if (exitView === 'Activity') await selectWorkspace();
        await page
          .locator('#detail .tab')
          .filter({ hasText: /^Logs$/ })
          .click();
        await page.waitForFunction(
          () => document.querySelector('#log-stat')?.textContent === 'streaming',
        );
        expect(connections).toBe(2);
        await page.locator('#log-svc option[value="rocketchat"]').waitFor({ state: 'attached' });
        expect(await page.locator('#log-svc').inputValue()).toBe('rocketchat');
        expect(await page.locator('.logctl select').first().inputValue()).toBe('warn');
        expect(
          await page.locator('.logctl input[aria-label="filter log lines"]').inputValue(),
        ).toBe('retention-marker');
        expect(await page.locator('.logfollow input').isChecked()).toBe(false);
        for (const socket of sockets)
          socket.send('rocketchat-1 | {"level":40,"msg":"retention-marker-after"}');
        await page
          .locator('#logview .logrow')
          .filter({ hasText: 'retention-marker-after' })
          .waitFor();
        expect(await page.locator('#logview').innerText()).not.toContain('retention-marker-before');
      } finally {
        await diagnostic.detach();
        await page.evaluate(() => {
          const host = window as Window & { closedLogsProbe?: unknown };
          delete host.closedLogsProbe;
        });
      }
    },
  );

  test('Docker logs reconnect automatically after an established socket ends', async () => {
    await dashboard();
    await selectWorkspace();
    await page
      .locator('#detail .tab')
      .filter({ hasText: /^Logs$/ })
      .click();
    await page.locator('#logview').filter({ hasText: 'connected-1' }).waitFor();
    for (const socket of sockets) socket.close();
    await page.locator('#logview').filter({ hasText: 'connected-2' }).waitFor({ timeout: 10000 });
    for (const socket of sockets) socket.send('rocketchat-1 | marker-after-serve-recovery');
    await page.locator('#logview').filter({ hasText: 'marker-after-serve-recovery' }).waitFor();
    expect(await page.locator('#log-stat').textContent()).toBe('streaming');
  });

  test('a closed log stream never reconnects after leaving its workspace', async () => {
    await dashboard();
    await selectWorkspace();
    await page
      .locator('#detail .tab')
      .filter({ hasText: /^Logs$/ })
      .click();
    await page.locator('#logview').filter({ hasText: 'connected-1' }).waitFor();
    for (const socket of sockets) socket.close();
    await page.locator('#log-stat').filter({ hasText: 'reconnecting' }).waitFor();
    await page.locator('#btn-home').click();
    await page.waitForTimeout(1800);
    expect(connections).toBe(1);
    expect(await page.locator('#logview').count()).toBe(0);
  });

  test('a failed poll qualifies cached status and disables mutations until automatic recovery', async () => {
    await dashboard();
    await selectWorkspace();
    await page.route('**/api/repros', (route) => route.abort());
    await page.locator('#btn-refresh').click();
    await page.locator('#server-unavailable').waitFor();
    expect(await page.locator('.wrow .wstate').textContent()).toBe('state unknown');
    expect(await page.locator('#sb-engines').textContent()).toContain('docker: ? · k8s: ?');
    expect(await page.locator('#detail .d-head .pill').textContent()).toBe('?');
    expect(
      await page
        .locator('#actpane button:enabled, .d-actions button:enabled:not(.panetoggle)')
        .count(),
    ).toBe(0);
    expect(await page.locator('#btn-new').isDisabled()).toBe(true);
    await page.unroute('**/api/repros');
    await page.locator('#server-unavailable').waitFor({ state: 'detached', timeout: 10000 });
    expect(await page.locator('.wrow .wstate').textContent()).toBe('running');
    expect(await page.locator('#sb-engines').textContent()).toContain('docker: up');
    expect(await page.locator('#btn-new').isDisabled()).toBe(false);
  });

  test('an open mutation dialog is locked during an outage and restored without a new submit', async () => {
    await dashboard();
    await page.locator('#btn-new').click();
    await page.locator('#create-dialog[open]').waitFor();
    await page.locator('#dest-cards label[data-dest="docker"]').click();
    await page.locator('#create-next').click();
    expect(await page.locator('#create-submit').isEnabled()).toBe(true);
    await page.route('**/api/repros', (route) => route.abort());
    await page.waitForResponse((response) => new URL(response.url()).pathname === '/api/health');
    await page.waitForFunction(
      () => (document.querySelector('#create-submit') as HTMLButtonElement).disabled,
    );
    expect(mutations).toBe(0);
    await page.unroute('**/api/repros');
    await page.waitForFunction(
      () => !(document.querySelector('#btn-new') as HTMLButtonElement).disabled,
      undefined,
      { timeout: 10000 },
    );
    expect(await page.locator('#create-submit').isEnabled()).toBe(true);
    expect(mutations).toBe(0);
  });

  test('a policy-closed log socket stays closed across successful polls and server recovery', async () => {
    await dashboard();
    await selectWorkspace();
    await page
      .locator('#detail .tab')
      .filter({ hasText: /^Logs$/ })
      .click();
    await page.locator('#logview').filter({ hasText: 'connected-1' }).waitFor();
    for (const socket of sockets) socket.close(1008);
    await page.waitForFunction(
      () => !document.querySelector('#log-stat')?.textContent.includes('streaming'),
    );
    await page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/repros' && response.status() === 200,
    );
    await page.waitForTimeout(200);
    expect(connections).toBe(1);
    await page.route('**/api/repros', (route) => route.abort());
    await page.locator('#server-unavailable').waitFor();
    await page.unroute('**/api/repros');
    await page.locator('#server-unavailable').waitFor({ state: 'detached', timeout: 10000 });
    await page.waitForTimeout(200);
    expect(connections).toBe(1);
  });

  test('navigation during a held restored view creates its own history and survives reload', async () => {
    await dashboard();
    await page.locator('#btn-clusters').click();
    await page.waitForFunction(
      () => document.querySelector('#detail h1')?.textContent === 'Clusters',
    );
    let release = (): void => {};
    clustersGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => document.querySelector('#detail h1')?.textContent === 'Clusters',
      );
      await page.locator('#btn-backups').click();
      await page.waitForFunction(
        () => document.querySelector('#detail h1')?.textContent === 'Backups',
      );
      expect(new URL(page.url()).hash).toBe('#/backups');
      release();
      clustersGate = null;
      await page.goBack();
      await page.waitForFunction(
        () => document.querySelector('#detail h1')?.textContent === 'Clusters',
      );
      await page.goForward();
      await page.waitForFunction(
        () => document.querySelector('#detail h1')?.textContent === 'Backups',
      );
      await page.reload();
      await page.waitForFunction(
        () => document.querySelector('#detail h1')?.textContent === 'Backups',
      );
      expect(new URL(page.url()).hash).toBe('#/backups');
    } finally {
      release();
      clustersGate = null;
    }
  });
});
