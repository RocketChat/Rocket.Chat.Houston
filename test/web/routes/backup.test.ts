/**
 * `web/routes/backup`: backup, restore, upgrade and rollback over HTTP.
 *
 * The cases that matter most are the confinement ones -- `out` and `bundle` name paths on
 * the SERVER, and unconfined they were a write-anywhere and a filesystem oracle.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import type * as OsNS from 'node:os';
import * as path from 'node:path';

import type { FastifyInstance } from 'fastify';

import * as backup from '../../../src/core/backup';
import * as record from '../../../src/core/runner/record';
import type * as RecordNS from '../../../src/core/runner/record';
import type * as BackupNS from '../../../src/core/backup';
import * as compat from '../../../src/core/backup-compat';
import * as upgrade from '../../../src/core/upgrade';
import * as users from '../../../src/core/users';
import { createApp } from '../../../src/web/app';

/**
 * What earlier releases' two confining functions answered for each row below, recorded:
 * `{HOME}` for the home the row set and `{CWD}` for the working directory it ran in.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'web', 'routes', 'backup.json'),
    'utf8',
  ),
) as { confined: unknown[] };

// `os.homedir()` is native and under Jest `process.env` is this file's own copy, so a HOME
// set here never reaches it; the one case that needs another home answers it here instead.
let mockHomedir: string | null = null;
jest.mock('node:os', () => {
  const actual = jest.requireActual<typeof OsNS>('node:os');
  return { ...actual, homedir: () => mockHomedir ?? actual.homedir() };
});

jest.mock('../../../src/core/lifecycle/naming', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/naming'),
  resolveName: async (name: string) => name,
}));
jest.mock('../../../src/core/runner/record', () => ({
  ...jest.requireActual('../../../src/core/runner/record'),
  readMeta: jest.fn(async () => ({})),
}));
jest.mock('../../../src/core/backup', () => ({
  ...jest.requireActual('../../../src/core/backup'),
  create: jest.fn(async () => ({ name: 'x', path: '/x.rcbak', bytes: 1, manifest: {} })),
  listBackups: jest.fn(async () => [{ path: '/a.rcbak' }]),
  deleteBackup: jest.fn(async (bundle: string) => ({ deleted: bundle })),
  readManifest: jest.fn(async () => ({ rc_version: '8.5.1' })),
  restore: jest.fn(async () => ({})),
  bundleOwner: jest.fn(async () => ''),
}));
jest.mock('../../../src/core/backup-compat', () => ({
  ...jest.requireActual('../../../src/core/backup-compat'),
  compatibility: jest.fn(() => ({ allowed: false, blocked_reason: 'downgrade' })),
}));
jest.mock('../../../src/core/upgrade', () => ({
  ...jest.requireActual('../../../src/core/upgrade'),
  canUpgrade: jest.fn(),
  plan: jest.fn(async (_name: string, to: string) => ({ to_version: to, allowed: true })),
  run: jest.fn(async () => ({})),
  rollback: jest.fn(async () => ({})),
}));

const PASSWORD = 'a-good-enough-password';

let home = '';
let app: FastifyInstance;
let admin = '';

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-backup-route-'));
  process.env.HOUSTON_HOME = home;
  await users.add('alice', PASSWORD, 'admin');
  app = await createApp({ accounts: true });
  await app.ready();
  const signin = await app.inject({
    method: 'POST',
    url: '/api/session',
    payload: { user: 'alice', password: PASSWORD },
    headers: { host: 'localhost' },
  });
  expect(signin.statusCode).toBe(200);
  admin = String(signin.headers['set-cookie'] ?? '').split(';')[0] ?? '';
});
afterEach(async () => {
  await app.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const post = (url: string, payload: unknown = {}) =>
  app.inject({
    method: 'POST',
    url,
    payload: payload as object,
    headers: { host: 'localhost', cookie: admin },
  });
const get = (url: string) => app.inject({ url, headers: { host: 'localhost', cookie: admin } });
const inside = (name: string) => path.join(backup.backupsDir(), name);

describe('backups', () => {
  it('are jobs, and the note travels as note', async () => {
    // `label` is the job manager's own keyword, so the note travels under another name.
    const response = await post('/api/repros/rc8-5-1/backup', {
      label: 'before upgrade',
      live: true,
    });
    expect(response.statusCode).toBe(200);
    expect(String(response.json().job_id)).toMatch(/^job_/u);
    await app.jobs.drain();
    expect(backup.create).toHaveBeenCalledWith(
      'rc8-5-1',
      expect.objectContaining({ note: 'before upgrade', live: true }),
    );
  });

  it('are listed and deleted', async () => {
    const listed = await get('/api/backups');
    expect(listed.statusCode).toBe(200);
    expect(listed.json().backups).toEqual([{ path: '/a.rcbak' }]);
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/backups?path=/a.rcbak',
      headers: { host: 'localhost', cookie: admin },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().deleted).toBe('/a.rcbak');
  });

  it('are deleted or restored by a member only when the workspace they came from is theirs', async () => {
    // A bundle is that workspace's data: deleting one was open to every member, and restoring
    // a colleague's as new handed over their data and admin login.
    await users.add('bob', PASSWORD, 'member');
    const signin = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { user: 'bob', password: PASSWORD },
      headers: { host: 'localhost' },
    });
    const bob = String(signin.headers['set-cookie'] ?? '').split(';')[0] ?? '';
    fs.mkdirSync(backup.backupsDir(), { recursive: true });
    fs.writeFileSync(inside('carol.rcbak'), 'bundle');
    const asBob = (method: 'DELETE' | 'POST') =>
      method === 'DELETE'
        ? app.inject({
            method,
            url: `/api/backups?path=${encodeURIComponent(inside('carol.rcbak'))}`,
            headers: { host: 'localhost', cookie: bob },
          })
        : app.inject({
            method,
            url: '/api/restore',
            payload: { bundle: inside('carol.rcbak'), name: 'mine', new: true },
            headers: { host: 'localhost', cookie: bob },
          });
    jest.mocked(backup.readManifest).mockResolvedValue({ repro: 'carols-box' });
    jest.mocked(record.readMeta).mockResolvedValue({ extra: { owner: 'carol' } } as never);
    for (const method of ['DELETE', 'POST'] as const) {
      const refused = await asBob(method);
      expect([method, refused.statusCode]).toEqual([method, 409]);
      expect(String(refused.json().error)).toContain('carols-box belongs to carol');
    }
    expect(jest.mocked(backup.deleteBackup)).not.toHaveBeenCalled();
    expect(jest.mocked(backup.restore)).not.toHaveBeenCalled();
    jest.mocked(record.readMeta).mockResolvedValue({ extra: { owner: 'bob' } } as never);
    expect((await asBob('DELETE')).statusCode).toBe(200);
    expect((await asBob('POST')).statusCode).toBe(200);
    jest.mocked(record.readMeta).mockImplementation(async () => ({}) as never);
    jest.mocked(backup.readManifest).mockImplementation(async () => ({ rc_version: '8.5.1' }));
  });

  it("are a colleague's by the owner they record, once their workspace is gone or renamed", async () => {
    // Gated on the workspace the name resolves to NOW: once carol's was deleted, or a newer
    // workspace of bob's took its name, bob could delete her only copy of that data.
    await users.add('bob2', PASSWORD, 'member');
    const signin = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { user: 'bob2', password: PASSWORD },
      headers: { host: 'localhost' },
    });
    const bob = String(signin.headers['set-cookie'] ?? '').split(';')[0] ?? '';
    fs.mkdirSync(backup.backupsDir(), { recursive: true });
    fs.writeFileSync(inside('carols-old.rcbak'), 'bundle');
    jest.mocked(backup.bundleOwner).mockResolvedValue('carol');
    // The name now resolves to bob2's own workspace, or to nothing: either way, carol's data.
    jest.mocked(backup.readManifest).mockResolvedValue({ repro: 'shared-name' });
    jest.mocked(record.readMeta).mockResolvedValue({ extra: { owner: 'bob2' } } as never);
    const refused = await app.inject({
      method: 'DELETE',
      url: `/api/backups?path=${encodeURIComponent(inside('carols-old.rcbak'))}`,
      headers: { host: 'localhost', cookie: bob },
    });
    expect(refused.statusCode).toBe(409);
    expect(String(refused.json().error)).toContain("this backup is carol's data");
    expect(jest.mocked(backup.deleteBackup)).not.toHaveBeenCalled();
    // An admin still may.
    const asAdmin = await app.inject({
      method: 'DELETE',
      url: `/api/backups?path=${encodeURIComponent(inside('carols-old.rcbak'))}`,
      headers: { host: 'localhost', cookie: admin },
    });
    expect(asAdmin.statusCode).toBe(200);
    jest.mocked(backup.bundleOwner).mockResolvedValue('');
    jest.mocked(record.readMeta).mockImplementation(async () => ({}) as never);
    jest.mocked(backup.readManifest).mockImplementation(async () => ({ rc_version: '8.5.1' }));
  });

  it('never reads a file outside the managed directory to decide a delete', async () => {
    // The owner check read the manifest of whatever path it was given, before the delete's
    // own refusal: a member could make the server open and gunzip any file it can read.
    jest.mocked(backup.readManifest).mockClear();
    await app.inject({
      method: 'DELETE',
      url: '/api/backups?path=/etc/hostname',
      headers: { host: 'localhost', cookie: admin },
    });
    expect(jest.mocked(backup.readManifest)).not.toHaveBeenCalled();
  });

  it('refuse to be written anywhere outside the managed directory', async () => {
    // `out` chose a path on the SERVER. Unconfined it wrote a tar.gz anywhere the server
    // user could -- a systemd drop-in, a webroot -- and a forged cross-site request chose it.
    for (const bad of ['/etc/cron.d/pwn', '../../../../tmp/pwn.tar.gz', '~/../../tmp/x']) {
      const refused = await post('/api/repros/x/backup', { out: bad });
      expect({ bad, status: refused.statusCode }).toEqual({ bad, status: 400 });
      expect(String(refused.json().error)).toContain('must be inside');
    }
    await app.jobs.drain();
    expect(backup.create).not.toHaveBeenCalled();
  });

  it('are written inside the managed directory, at the resolved path', async () => {
    fs.mkdirSync(backup.backupsDir(), { recursive: true });
    const destination = inside('mine.tar.gz');
    expect((await post('/api/repros/x/backup', { out: destination })).statusCode).toBe(200);
    await app.jobs.drain();
    expect(backup.create).toHaveBeenCalledWith(
      'x',
      expect.objectContaining({
        out: path.join(fs.realpathSync(backup.backupsDir()), 'mine.tar.gz'),
      }),
    );
  });

  it('need a session, every one of them', async () => {
    const anonymous = { host: 'localhost' };
    for (const [method, url, payload] of [
      ['POST', '/api/repros/x/backup', {}],
      ['GET', '/api/backups', undefined],
      ['POST', '/api/restore', { bundle: '/a' }],
      ['GET', '/api/repros/x/upgrade', undefined],
    ] as const) {
      const refused = await app.inject({
        method,
        url,
        ...(payload === undefined ? {} : { payload }),
        headers: anonymous,
      });
      expect({ url, status: refused.statusCode }).toEqual({ url, status: 401 });
    }
  });
});

describe('compatibility', () => {
  it('is answerable before committing, and only for a bundle inside the managed directory', async () => {
    // The restore dialog enables its button from this, so a downgrade is refused while the
    // user is still choosing rather than after a job has started.
    const verdict = await post('/api/backups/compatibility', {
      bundle: inside('a.rcbak'),
      name: 'old',
    });
    expect(verdict.statusCode).toBe(200);
    expect(verdict.json().compatibility.allowed).toBe(false);
    expect(compat.compatibility).toHaveBeenCalled();

    // AN OUTSIDE PATH IS REFUSED. Unconfined this was a filesystem oracle with three
    // distinguishable answers, plus the archive reader's error text for any readable file.
    const outside = await post('/api/backups/compatibility', {
      bundle: '/etc/passwd',
      name: 'old',
    });
    expect(outside.statusCode).toBe(400);
    expect(String(outside.json().error)).toContain('must be inside');

    // No target named: the manifest alone, no verdict to give.
    const bare = await post('/api/backups/compatibility', { bundle: inside('a.rcbak') });
    expect(bare.statusCode).toBe(200);
    expect(bare.json().compatibility).toBeNull();
  });

  it('names no holder for a restore as new, which is given side ports of its own', async () => {
    // The as-new create was refused while the source still held its scenario's ports, and
    // this answer named the holder. A copy now gets the next free ports, so nobody is in the
    // way: the answer is the manifest and whether this viewer may use it.
    const real = jest.requireActual<typeof RecordNS>('../../../src/core/runner/record');
    await real.write(
      'mail-src',
      'services: {}\n',
      real.metadata({ name: 'mail-src', extra: { sidecar_ports: [8025, 8082] } }),
    );
    jest.mocked(backup.readManifest).mockResolvedValueOnce({ preset: 'email+ldap' });
    const answer = await post('/api/backups/compatibility', { bundle: inside('a.rcbak') });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).not.toHaveProperty('held');
    expect(answer.json()).toMatchObject({ compatibility: null, refusal: '' });
  });

  it("says whether this viewer may use the bundle, so a colleague's restore is not offered", async () => {
    // "Restore into <workspace> instead" was offered on a colleague's bundle and the server
    // refused the click. The as-new answer now carries the same refusal, '' when allowed.
    await users.add('bob3', PASSWORD, 'member');
    const signin = await app.inject({
      method: 'POST',
      url: '/api/session',
      payload: { user: 'bob3', password: PASSWORD },
      headers: { host: 'localhost' },
    });
    const bob = String(signin.headers['set-cookie'] ?? '').split(';')[0] ?? '';
    fs.mkdirSync(backup.backupsDir(), { recursive: true });
    fs.writeFileSync(inside('carols.rcbak'), 'bundle');
    jest.mocked(backup.bundleOwner).mockResolvedValue('carol');
    const ask = async (cookie: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/backups/compatibility',
          payload: { bundle: inside('carols.rcbak') },
          headers: { host: 'localhost', cookie },
        })
      ).json().refusal;
    expect(await ask(bob)).toBe(
      "this backup is carol's data — only carol or an admin can use or delete it",
    );
    expect(await ask(admin)).toBe('');
    jest.mocked(backup.bundleOwner).mockResolvedValue('');
  });

  it('and restore both need a bundle', async () => {
    expect((await post('/api/backups/compatibility', {})).statusCode).toBe(400);
    expect((await post('/api/restore', {})).statusCode).toBe(400);
  });

  it("expands `~` in the caller's path, before asking whether it is absolute, and never in the managed directory", async () => {
    // Earlier releases confine a bundle read and a bundle written against the managed
    // directory as it is spelled, and expand only the CALLER's path, first. An earlier
    // version expanded the managed directory -- a home spelled from `~` confined to
    // `$HOME/...`, where earlier releases confine to a `~` directory under the working one --
    // and asked whether the caller's path was absolute before expanding it, so `~/x.rcbak`
    // became `<backups>/~/x.rcbak` and was let through where earlier releases refuse it. Each
    // row is held to what earlier releases' route answered, handed the same managed
    // directory, recorded.
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'houston-route-home-')));
    const decoy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'houston-route-cwd-')));
    fs.mkdirSync(path.join(dir, 'backups'));
    // [HOME, the managed directory as spelled, the caller's path]
    const rows: [string, string, string][] = [];
    for (const home of [dir, `${dir}/`]) {
      for (const managed of [`${dir}/backups`, '~/backups']) {
        for (const given of [
          '~/backups/a.rcbak',
          '~/x.rcbak',
          'a.rcbak',
          '~',
          `${dir}/backups/./b.rcbak/`,
          '~no-such-user-houston/a.rcbak',
        ]) {
          rows.push([home, managed, given]);
        }
      }
    }
    let spelled = '';
    const mocked = jest.requireMock<typeof BackupNS>('../../../src/core/backup');
    jest.spyOn(mocked, 'backupsDir').mockImplementation(() => spelled);
    const cwd = process.cwd();
    const answered: [
      Awaited<ReturnType<typeof post>>,
      unknown,
      Awaited<ReturnType<typeof post>>,
    ][] = [];
    try {
      process.chdir(decoy);
      for (const [at, [home, managed, given]] of rows.entries()) {
        mockHomedir = home;
        spelled = managed;
        const read = await post('/api/backups/compatibility', { bundle: given });
        const passed = jest.mocked(backup.readManifest).mock.lastCall?.[0];
        // One workspace per row: a drained job manager takes no more work, so the jobs are
        // drained once, below, and each `out` is found by the workspace it was for.
        answered.push([
          read,
          passed,
          await post(`/api/repros/w${String(at)}/backup`, { out: given }),
        ]);
      }
      await app.jobs.drain();
    } finally {
      process.chdir(cwd);
      mockHomedir = null;
    }
    const outcome = (response: Awaited<ReturnType<typeof post>>, passed: unknown) =>
      response.statusCode === 200
        ? ['ok', passed]
        : response.statusCode === 400
          ? ['refused', String(response.json().error)]
          : [String(response.statusCode), String(response.json().message)];
    const ours = answered.map(([read, passed, wrote], at) => [
      outcome(read, passed),
      outcome(
        wrote,
        jest.mocked(backup.create).mock.calls.find(([name]) => name === `w${String(at)}`)?.[1]?.out,
      ),
    ]);
    const recorded = JSON.parse(
      JSON.stringify(RECORDED.confined).split('{CWD}').join(decoy).split('{HOME}').join(dir),
    ) as unknown[];
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(decoy, { recursive: true, force: true });
    expect(recorded).toHaveLength(rows.length);
    expect(ours).toEqual(recorded);
    // The rows the port answered differently, as earlier releases answer them.
    expect(recorded[0]).toEqual([
      ['ok', `${dir}/backups/a.rcbak`],
      ['ok', `${dir}/backups/a.rcbak`],
    ]);
    expect(JSON.stringify(recorded[1])).toContain('must be inside');
    expect(JSON.stringify(recorded[6])).toContain(`must be inside ${decoy}/~/backups`);
  });
});

describe('the managed directory under a home that walks back out of a symlink', () => {
  it('is the one resolve() names, and so is a bundle joined onto it', async () => {
    // `path.resolve` and `fs.realpathSync` both fold `link/..` before reading `link`, so
    // with `link -> other/sub` the directory under `<box>/link/../hh` was `<box>/hh` here and
    // `<box>/other/hh` to earlier releases' resolution of it -- the route confined to, named
    // and read bundles from a directory the backups are not in.
    const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'houston-route-link-')));
    fs.mkdirSync(path.join(box, 'other', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(box, 'other', 'hh', 'backups'), { recursive: true });
    fs.symlinkSync('other/sub', path.join(box, 'link'));
    const managed = `${box}/link/../hh/backups`;
    jest
      .spyOn(jest.requireMock<typeof BackupNS>('../../../src/core/backup'), 'backupsDir')
      .mockImplementation(() => managed);
    try {
      const refused = await post('/api/backups/compatibility', { bundle: '/nowhere/a.rcbak' });
      expect(refused.statusCode).toBe(400);
      const named = /must be inside (.*) — /u.exec(String(refused.json().error))?.[1];
      const read = await post('/api/backups/compatibility', { bundle: 'a.rcbak' });
      expect(read.statusCode).toBe(200);
      // What earlier releases resolved the managed directory, and a bundle in it, to.
      const [root, bundle] = [`${box}/other/hh/backups`, `${box}/other/hh/backups/a.rcbak`];
      expect(root).toBe(path.join(box, 'other', 'hh', 'backups'));
      expect(named).toBe(root);
      expect(backup.readManifest).toHaveBeenLastCalledWith(bundle);
    } finally {
      fs.rmSync(box, { recursive: true, force: true });
    }
  });
});

describe('restore', () => {
  it('is a job carrying its flags, and refuses a path outside the managed directory', async () => {
    const started = await post('/api/restore', {
      bundle: inside('a.rcbak'),
      new: true,
      allow_upgrade: true,
    });
    expect(started.statusCode).toBe(200);
    expect(String(started.json().job_id)).toMatch(/^job_/u);
    const outside = await post('/api/restore', { bundle: '/etc/hosts' });
    expect(outside.statusCode).toBe(400);
    await app.jobs.drain();
    expect(backup.restore).toHaveBeenCalledTimes(1);
    expect(backup.restore).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ new: true, allowUpgrade: true }),
    );
  });
});

describe('upgrade', () => {
  it('is gated by the SERVER, which says why it will not offer one', async () => {
    // A stopped workspace reports can_upgrade=false with the reason, so the GUI can hide the
    // action instead of offering one that would fail.
    jest
      .mocked(upgrade.canUpgrade)
      .mockResolvedValue({ can_upgrade: false, reason: "'x' is exited", current: '' });
    const gate = await get('/api/repros/x/upgrade?to=8.6.1');
    expect(gate.statusCode).toBe(200);
    expect(gate.json()).toMatchObject({
      can_upgrade: false,
      reason: expect.stringContaining('exited'),
    });
    expect(gate.json()).not.toHaveProperty('plan');
    expect(upgrade.plan).not.toHaveBeenCalled();
  });

  it('resolves a plan only for a workspace that can be upgraded', async () => {
    jest
      .mocked(upgrade.canUpgrade)
      .mockResolvedValue({ can_upgrade: true, reason: '', current: '8.5.1' });
    const gate = await get('/api/repros/x/upgrade?to=8.6.1');
    expect(gate.statusCode).toBe(200);
    expect(gate.json().plan.to_version).toBe('8.6.1');
  });

  it('needs a target version', async () => {
    expect((await post('/api/repros/x/upgrade', {})).statusCode).toBe(400);
    expect(upgrade.run).not.toHaveBeenCalled();
  });

  it('and rollback are jobs', async () => {
    const started = await post('/api/repros/x/upgrade', { to: '8.6.1' });
    expect(started.statusCode).toBe(200);
    expect(String(started.json().job_id)).toMatch(/^job_/u);
    const back = await post('/api/repros/x/upgrade/rollback', {});
    expect(back.statusCode).toBe(200);
    expect(String(back.json().job_id)).toMatch(/^job_/u);
    await app.jobs.drain();
    expect(upgrade.run).toHaveBeenCalledWith(
      'x',
      '8.6.1',
      expect.objectContaining({ noBackup: false }),
    );
  });
});

describe('rollback', () => {
  it('confines its bundle like the other two, and an empty one still means the recorded bundle', async () => {
    // The confinement wrapped `/api/restore` and `/api/backups/compatibility`; this third
    // route was missed, and a member got the same filesystem oracle, readable back from
    // `GET /api/jobs/{id}` at readonly.
    const outside = await post('/api/repros/x/upgrade/rollback', { bundle: '/etc/passwd' });
    expect(outside.statusCode).toBe(400);
    expect(String(outside.json().error)).toContain('must be inside');

    // EMPTY is the ordinary call -- "use the one recorded on the workspace" -- and must not
    // start being refused.
    expect((await post('/api/repros/x/upgrade/rollback', {})).statusCode).toBe(200);
    await app.jobs.drain();
    expect(upgrade.rollback).toHaveBeenCalledTimes(1);
    expect(upgrade.rollback).toHaveBeenCalledWith('x', expect.objectContaining({ bundle: '' }));
  });
});
