/** Managed backups, restores, upgrades, and rollbacks. */

import * as path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { resolveName } from '../../core/lifecycle/naming';
import { readMeta } from '../../core/runner/record';
import { ConflictError, ValidationError } from '../../lib/errors';
import { pathExpandUser, pathResolve, joinPath } from '../../lib/home';
import { fileErrorText, quotedText } from '../../lib/format';
import { actor, bool, orText, queryBool, queryText, requestBody, submit } from '../route-deps';
import { workspaceRefusal } from '../security';
import type * as BackupNS from '../../core/backup';
import type * as BackupCompatNS from '../../core/backup-compat';
import type * as OwnershipNS from '../../core/lifecycle/ownership';
import type * as UpgradeNS from '../../core/upgrade';

function backupModule(): typeof BackupNS {
  return require('../../core/backup') as typeof BackupNS;
}

function ownershipModule(): typeof OwnershipNS {
  return require('../../core/lifecycle/ownership') as typeof OwnershipNS;
}

function backupCompatModule(): typeof BackupCompatNS {
  return require('../../core/backup-compat') as typeof BackupCompatNS;
}

function upgradeModule(): typeof UpgradeNS {
  return require('../../core/upgrade') as typeof UpgradeNS;
}

/**
 * The caller's path, as a confined backup path takes it: `~` expanded, joined onto the
 * RESOLVED managed directory when it is not absolute, and then resolved. `~` is expanded in
 * the caller's path ONLY, and BEFORE the is-absolute check.
 *
 * An earlier version had it the other way round in both places. It expanded a `~` in the
 * managed directory, which resolving that directory never does -- a `HOUSTON_HOME` spelled
 * `~/x` is `x` under a directory named `~`, and was the home to this. And it asked whether
 * the caller's path was absolute FIRST: `~/x` is not, so it became `<backups>/~/x` and was
 * let through as inside the directory, where it must be expanded to `$HOME/x` and refused
 * -- or, for `~/.houston/backups/a.rcbak`, read as that bundle rather than as a `~`
 * directory inside the backups. A `~name` nobody has is a `HomeUnknown` out of the
 * expansion, a 500, as it always has been.
 *
 * Resolved with `pathResolve`, not `path.resolve` and `fs.realpathSync`, which fold a `..`
 * before any link is read: with `HOUSTON_HOME=link/../hh` and `link -> other/sub` the
 * managed directory was `hh` under the working directory, where the kernel finds
 * `other/hh`.
 */
function confined(given: string, root: string): string {
  const expanded = pathExpandUser(given);
  return pathResolve(expanded.startsWith('/') ? expanded : joinPath(root, expanded));
}

/** Whether `candidate` is neither `root` nor inside it, for two resolved paths. */
function outside(candidate: string, root: string): boolean {
  return candidate !== root && !candidate.startsWith(root === '/' ? '/' : `${root}/`);
}

/**
 * '' when `who` may use the bundle at `inside` (already confined): it is a workspace's data,
 * so a member deletes or restores only their own workspaces' bundles. One that names no
 * workspace, or one that is gone, has nobody left to ask.
 */
async function bundleRefusal(inside: string, who: string): Promise<string> {
  // ITS OWN OWNER FIRST. A bundle outlives its workspace: once that was deleted, or a newer one
  // took its name, the check below asked about nobody or about the wrong person, and a member
  // could delete a colleague's only copy of their data.
  const owner = await backupModule().bundleOwner(inside);
  if (owner !== '') {
    const [allowed, holder] = ownershipModule().ownedGate(owner, who);
    return allowed
      ? ''
      : `this backup is ${holder}'s data — only ${holder} or an admin can use or delete it`;
  }
  let repro: string;
  try {
    repro = String((await backupModule().readManifest(inside)).repro ?? '');
  } catch {
    return '';
  }
  return repro === '' ? '' : await workspaceRefusal(repro, who);
}

function confinedInput(bundle: string): string {
  if (bundle === '') throw new ValidationError('no bundle given');
  const root = pathResolve(backupModule().backupsDir());
  let candidate: string;
  try {
    candidate = confined(bundle, root);
  } catch (error) {
    // Only a failed system call is "could not read"; the `HomeUnknown` of a `~` expansion
    // or the error of a symlink loop is the 500 it has always been.
    if (typeof (error as NodeJS.ErrnoException).errno !== 'number') throw error;
    throw new ValidationError(`could not read ${quotedText(bundle)}: ${fileErrorText(error)}`);
  }
  if (outside(candidate, root)) {
    throw new ValidationError(
      `\`bundle\` must be inside ${root} — the HTTP API cannot read arbitrary paths on ` +
        'the server (the CLI still can)',
    );
  }
  return candidate;
}

function confinedOutput(output: string): string {
  if (output === '') return '';
  // No catch around the resolve, unlike `confinedInput`: a failure here propagates as it is.
  const root = pathResolve(backupModule().backupsDir());
  const candidate = confined(output, root);
  if (outside(candidate, root)) {
    throw new ValidationError(
      `\`out\` must be inside ${root} — the HTTP API cannot choose arbitrary paths on ` +
        "the server (the CLI's --out still can)",
    );
  }
  return candidate;
}

export function register(app: FastifyInstance): void {
  app.post<{ Params: { name: string } }>('/api/repros/:name/backup', async (request) => {
    const backup = backupModule();
    const body = requestBody(request.body, false);
    const target = await resolveName(request.params.name);
    const output = confinedOutput(orText(body.out));
    return submit(
      app,
      'backup',
      (emit) =>
        backup.create(target, {
          out: output,
          note: orText(body.label),
          live: bool(body.live),
          emit,
        }),
      { label: target },
    );
  });

  app.get<{ Querystring: { name?: unknown } }>('/api/backups', async (request) => ({
    backups: await backupModule().listBackups(queryText(request.query.name, '', 'name')),
  }));

  app.delete<{ Querystring: { path?: unknown } }>('/api/backups', async (request) => {
    const bundle = queryText(request.query.path, '', 'path', true);
    let inside = '';
    try {
      inside = confinedInput(bundle);
    } catch {
      // outside the managed directory: `deleteBackup` refuses it, and nothing is read
    }
    const why = inside === '' ? '' : await bundleRefusal(inside, actor(request));
    if (why !== '') throw new ConflictError(why);
    return await backupModule().deleteBackup(bundle);
  });

  app.post('/api/backups/compatibility', async (request) => {
    const backup = backupModule();
    const body = requestBody(request.body, true);
    const bundle = confinedInput(orText(body.bundle));
    const manifest = await backup.readManifest(bundle);
    const name = orText(body.name);
    if (name === '') {
      // AS NEW, which builds the bundle's preset again, on side ports of its own: another
      // workspace holding the preferred ones gives it the next free ones, so there is no
      // holder to name. Whether THIS viewer may use the bundle at all is said here, so the
      // dialog can say who can before a click is refused: '' when they may.
      const refusal = await bundleRefusal(bundle, actor(request));
      return { manifest, compatibility: null, refusal };
    }
    const meta = await readMeta(await resolveName(name));
    return { manifest, compatibility: backupCompatModule().compatibility(manifest, meta) };
  });

  app.post('/api/restore', async (request) => {
    const backup = backupModule();
    const body = requestBody(request.body, true);
    const bundle = confinedInput(orText(body.bundle));
    const name = orText(body.name);
    // Restored as new, a colleague's bundle would hand over their data and admin login.
    const why = await bundleRefusal(bundle, actor(request));
    if (why !== '') throw new ConflictError(why);
    return submit(
      app,
      'restore',
      (emit) =>
        backup.restore(bundle, {
          name,
          new: bool(body.new),
          allowUpgrade: bool(body.allow_upgrade),
          force: bool(body.force),
          emit,
        }),
      { label: name || path.basename(bundle) },
    );
  });

  app.get<{ Params: { name: string }; Querystring: { to?: unknown; offline?: unknown } }>(
    '/api/repros/:name/upgrade',
    async (request) => {
      const upgrade = upgradeModule();
      const offline = queryBool(request.query.offline, false, 'offline');
      const state = await upgrade.canUpgrade(request.params.name);
      const to = queryText(request.query.to, '', 'to');
      if (to !== '' && state.can_upgrade === true) {
        state.plan = await upgrade.plan(request.params.name, to, {
          offline,
        });
      }
      return state;
    },
  );

  app.post<{ Params: { name: string } }>('/api/repros/:name/upgrade', async (request) => {
    const upgrade = upgradeModule();
    const body = requestBody(request.body, true);
    const target = await resolveName(request.params.name);
    const to = orText(body.to);
    if (to === '') throw new ValidationError('no target version given, e.g. {"to": "8.6.1"}');
    return submit(
      app,
      'upgrade',
      (emit) =>
        upgrade.run(target, to, {
          offline: bool(body.offline),
          force: bool(body.force),
          noBackup: bool(body.no_backup),
          rollbackOnFailure:
            body.rollback_on_failure === undefined || bool(body.rollback_on_failure),
          emit,
        }),
      { label: target },
    );
  });

  app.post<{ Params: { name: string } }>('/api/repros/:name/upgrade/rollback', async (request) => {
    const upgrade = upgradeModule();
    const body = requestBody(request.body, false);
    const target = await resolveName(request.params.name);
    const rawBundle = orText(body.bundle);
    const bundle = rawBundle === '' ? '' : confinedInput(rawBundle);
    return submit(app, 'rollback', (emit) => upgrade.rollback(target, { bundle, emit }), {
      label: target,
    });
  });
}
