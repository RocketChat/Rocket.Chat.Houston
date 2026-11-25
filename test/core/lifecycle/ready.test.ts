/**
 * `core/lifecycle/ready`: who may say the work is done.
 */
import type { Event } from '../../../src/lib/events';

import { sayReady } from '../../../src/core/lifecycle/ready';

import type * as NotesNS from '../../../src/core/lifecycle/notes';
import type * as ReadyNS from '../../../src/core/lifecycle/ready';
import type * as PresetsNS from '../../../src/lib/presets/index';
import type * as RcapiNS from '../../../src/core/rcapi';
import type * as RecordNS from '../../../src/core/runner/record';

describe('announcing readiness', () => {
  it('claims the end only when this step IS the end, and never names a percentage otherwise', () => {
    // MEASURED on a real EKS create: `done: ready` at 100% at 414s, then 46 more seconds of
    // seeding, then a second `done` -- a progress bar that fills up and keeps going.
    const said: [string, number | null | undefined][] = [];
    const emit = (event: Event) => said.push([String(event.phase), event.pct]);
    sayReady(emit, false);
    // NO PERCENTAGE: `wait_serving` already emitted 100, so any number sends the bar back.
    expect(said).toEqual([['wait', null]]);
    said.length = 0;
    sayReady(emit, true);
    expect(said).toEqual([['done', 100]]);
  });

  it('treats a caller that does not say as the end, because that caller is `houston ready`', async () => {
    // The default is observed, not read off the signature: `waitAndFinalize` is
    // CALLED without `final` and must announce the end -- the property the default exists
    // for -- while a caller that passes `final = false` must not. A default is read by
    // calling the function without the argument and looking.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'running',
      rcRestartCount: async () => 0,
    }));
    jest.doMock('../../../src/core/rcapi', () => ({
      ...jest.requireActual<object>('../../../src/core/rcapi'),
      waitReady: async () => ({ version: '8.5.1' }),
      completeSetupWizard: async () => false,
    }));
    jest.doMock('../../../src/core/lifecycle/admin', () => ({
      login: async () => ({ token: 't', userId: 'u' }),
    }));
    jest.doMock('../../../src/core/postready', () => ({ runPostReady: async () => undefined }));
    try {
      const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
      const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
      const meta = metadata({ name: 'w', rcVersion: '8.5.1', rootUrl: 'http://localhost:3000' });
      const phases = async (final?: boolean): Promise<string[]> => {
        const seen: string[] = [];
        const emit = (event: Event) => seen.push(String(event.phase));
        // Two arguments when `final` is not given: that is the caller being described.
        if (final === undefined) await ready.waitAndFinalize(meta, emit);
        else await ready.waitAndFinalize(meta, emit, 300, final);
        return seen;
      };
      expect((await phases()).at(-1)).toBe('done');
      expect(await phases(false)).not.toContain('done');
    } finally {
      for (const module of [
        '../../../src/core/runner/queries',
        '../../../src/core/rcapi',
        '../../../src/core/lifecycle/admin',
        '../../../src/core/postready',
      ])
        jest.dontMock(module);
      jest.resetModules();
    }
  });
});

describe('a rebuild that moved the address', () => {
  it('moves Site_Url once, before the preset setup, and only while it names the old address', async () => {
    // An http oidc workspace upgraded to 9.0.0 and rebuilt onto https kept Site_Url on http:
    // Rocket.Chat keeps the stored setting and sent the https page to it, which never loaded.
    jest.resetModules();
    let site: unknown = 'http://rc.example.test';
    const set: string[] = [];
    const order: string[] = [];
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'running',
      rcRestartCount: async () => 0,
    }));
    jest.doMock('../../../src/core/rcapi', () => ({
      ...jest.requireActual<object>('../../../src/core/rcapi'),
      waitReady: async () => ({ version: '9.0.0' }),
      completeSetupWizard: async () => false,
      licenseInfo: async () => null,
      getSetting: async () => site,
      setSetting: async (_url: string, _auth: unknown, _pw: string, id: string, value: string) => {
        set.push(`${id}=${value}`);
        order.push('Site_Url');
        site = value;
        return true;
      },
    }));
    jest.doMock('../../../src/core/lifecycle/admin', () => ({
      login: async () => ({ token: 't', userId: 'u' }),
    }));
    jest.doMock('../../../src/core/postready', () => ({
      runPostReady: async () => {
        order.push('preset setup');
      },
    }));
    try {
      const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
      const record = require('../../../src/core/runner/record') as typeof RecordNS;
      const moved = (): RecordNS.Metadata =>
        record.metadata({
          name: 'moved',
          rcVersion: '9.0.0',
          rootUrl: 'http://localhost:3000',
          publicUrl: 'https://rc.example.test',
          extra: { site_url_moved_from: 'http://rc.example.test' },
        });
      await record.writeRecord('moved', moved());
      const said: string[] = [];
      await ready.waitAndFinalize(moved(), (event: Event) => said.push(event.message), 300, false);
      expect(set).toEqual(['Site_Url=https://rc.example.test']);
      expect(order).toEqual(['Site_Url', 'preset setup']);
      expect(said).toContain(
        'Site_Url moved from http://rc.example.test to https://rc.example.test, where this ' +
          'workspace is now served',
      );
      expect((await record.readMeta('moved')).extra.site_url_moved_from).toBeUndefined();
      // Once: the next `ready` leaves it alone.
      await ready.waitAndFinalize(await record.readMeta('moved'), () => undefined, 300, false);
      expect(set).toHaveLength(1);
      // Set by hand to another address: kept, and the marker goes all the same.
      site = 'https://by-hand.example.test';
      await record.writeRecord('moved', moved());
      await ready.waitAndFinalize(moved(), () => undefined, 300, false);
      expect(set).toHaveLength(1);
      expect((await record.readMeta('moved')).extra.site_url_moved_from).toBeUndefined();
    } finally {
      for (const module of [
        '../../../src/core/runner/queries',
        '../../../src/core/rcapi',
        '../../../src/core/lifecycle/admin',
        '../../../src/core/postready',
      ])
        jest.dontMock(module);
      jest.resetModules();
    }
  });
});

describe('the license Rocket.Chat was given', () => {
  it('says and records a refusal, records an acceptance, and records nothing it could not ask', async () => {
    // Measured live: a license bound to another URL was installed and refused ("Url
    // validation failed"); `up` said nothing and the panel badged the workspace Licensed.
    jest.resetModules();
    let answers: (boolean | null)[] = [];
    const asked: string[] = [];
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'running',
      rcRestartCount: async () => 0,
    }));
    jest.doMock('../../../src/core/rcapi', () => ({
      ...jest.requireActual<object>('../../../src/core/rcapi'),
      waitReady: async () => ({ version: '8.9.0' }),
      completeSetupWizard: async () => false,
      licenseInfo: async (rootUrl: string) => {
        asked.push(rootUrl);
        const valid = answers.length > 0 ? answers.shift() : null;
        return typeof valid === 'boolean' ? { valid, modules: [] } : null;
      },
      getSetting: async () => 'https://ticket.example.test',
    }));
    jest.doMock('../../../src/core/lifecycle/admin', () => ({
      login: async () => ({ token: 't', userId: 'u' }),
    }));
    jest.doMock('../../../src/core/postready', () => ({ runPostReady: async () => undefined }));
    try {
      const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
      const record = require('../../../src/core/runner/record') as typeof RecordNS;
      const pauses: number[] = [];
      const run = async (extra: Record<string, unknown>) => {
        const meta = record.metadata({
          name: 'lic',
          rcVersion: '8.9.0',
          rootUrl: 'http://localhost:3000',
          extra,
        });
        await record.writeRecord('lic', meta);
        const said: string[] = [];
        const emit = (event: Event) => said.push(event.message);
        await ready.checkLicense(meta, { token: 't', userId: 'u' }, emit, async (ms) => {
          pauses.push(ms);
        });
        return { said, status: (await record.readMeta('lic')).extra.license_status };
      };
      // `ready` asks: a workspace it finishes off is asked and its answer recorded.
      answers = [true];
      const meta = record.metadata({
        name: 'lic',
        rcVersion: '8.9.0',
        rootUrl: 'http://localhost:3000',
        extra: { licensed: true },
      });
      await record.writeRecord('lic', meta);
      const said: string[] = [];
      await ready.waitAndFinalize(meta, (event: Event) => said.push(event.message), 300, false);
      expect(said).toContain('Rocket.Chat accepted the license');
      expect((await record.readMeta('lic')).extra.license_status).toBe('valid');
      // Refused every time it is asked: said, with the address it is checked against.
      answers = [false, false, false, false];
      const refused = await run({ licensed: true });
      expect(pauses).toEqual([5000, 5000, 5000]);
      expect(refused.status).toBe('refused');
      expect(refused.said.filter((line) => line.includes('license'))).toEqual([
        expect.stringContaining(
          'Rocket.Chat refused the license: one is valid only at the address it was issued ' +
            "for and until it expires, and this workspace's Site_Url is " +
            'https://ticket.example.test.',
        ) as unknown,
      ]);
      // Still being applied when first asked: the second ask is the answer.
      answers = [false, true];
      const late = await run({ licensed: true, license_status: 'refused' });
      expect(late.status).toBe('valid');
      expect(late.said).toContain('Rocket.Chat accepted the license');
      // Could not ask: nothing recorded and nothing said, rather than a guess.
      answers = [];
      const unknown = await run({ licensed: true, license_status: 'valid' });
      expect(unknown.status).toBe('valid');
      expect(unknown.said.filter((line) => line.includes('license'))).toEqual([]);
      // Never given one: never asked.
      asked.length = 0;
      expect((await run({})).status).toBeUndefined();
      expect(asked).toEqual([]);
    } finally {
      for (const module of [
        '../../../src/core/runner/queries',
        '../../../src/core/rcapi',
        '../../../src/core/lifecycle/admin',
        '../../../src/core/postready',
      ])
        jest.dontMock(module);
      jest.resetModules();
    }
  });

  it('asks again where Rocket.Chat 9 refuses the sign-in, so a license added there later is seen', async () => {
    // Created with neither a license nor a token, then a license added in Administration →
    // Subscription and `ready` run, as the notes say: the record kept saying neither, so the
    // notes and the panel said "refused" after sign-in worked.
    jest.resetModules();
    type Answer = { valid: boolean; modules: string[] | null } | null;
    let answers: Answer[] = [];
    const asked: string[] = [];
    jest.doMock('../../../src/core/rcapi', () => ({
      ...jest.requireActual<object>('../../../src/core/rcapi'),
      licenseInfo: async (rootUrl: string) => {
        asked.push(rootUrl);
        return answers.length > 0 ? answers.shift() : null;
      },
    }));
    try {
      const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
      const record = require('../../../src/core/runner/record') as typeof RecordNS;
      const notes = require('../../../src/core/lifecycle/notes') as typeof NotesNS;
      const presets = require('../../../src/lib/presets/index') as typeof PresetsNS;
      const pauses: number[] = [];
      const run = async (rcVersion: string, extra: Record<string, unknown>) => {
        const meta = record.metadata({
          name: 'lic9',
          preset: 'oidc',
          rcVersion,
          rootUrl: 'http://localhost:3000',
          extra: { post_ready: presets.load('oidc', {}).postReady, ...extra },
        });
        await record.writeRecord('lic9', meta);
        const said: string[] = [];
        await ready.checkLicense(
          meta,
          { token: 't', userId: 'u' },
          (e) => said.push(e.message),
          async (ms) => {
            pauses.push(ms);
          },
        );
        const after = await record.readMeta('lic9');
        return {
          said,
          extra: after.extra,
          note: notes
            .signInGroup(after)
            .flatMap((g) => g.body)
            .join(' '),
        };
      };
      const PREMIUM = ['ldap-enterprise', 'saml-enterprise', 'oauth-enterprise'];
      // None yet: asked once (it is not still being applied), and the note says what was asked.
      answers = [{ valid: false, modules: [] }];
      const before = await run('9.0.0', {});
      expect(asked).toHaveLength(1);
      expect(pauses).toEqual([]);
      expect(before.extra.license_status).toBeUndefined();
      expect(before.extra.license_modules).toEqual([]);
      expect(before.note).toContain('Rocket.Chat had no such license when houston last asked it');
      // Added in Rocket.Chat: said, recorded, and the note's licence lines go.
      answers = [{ valid: true, modules: PREMIUM }];
      const after = await run('9.0.0', { license_modules: [] });
      expect(after.said).toContain(
        'Rocket.Chat has a license carrying oauth-enterprise: sign-in through the oidc preset ' +
          'is no longer refused',
      );
      expect(after.extra.license_status).toBe('valid');
      expect(after.extra.license_modules).toEqual(PREMIUM);
      expect(after.note).not.toContain('Premium plan');
      // Removed or expired: the status goes, never "refused" for one houston did not give.
      answers = [{ valid: false, modules: [] }];
      const gone = await run('9.0.0', { license_status: 'valid', license_modules: PREMIUM });
      expect(gone.extra.license_status).toBeUndefined();
      expect(gone.note).toContain('Premium plan');
      // A registration token that brought none: asked too, and the line comes back.
      answers = [{ valid: false, modules: [] }];
      expect((await run('9.0.0', { registered: true })).note).toContain('Premium plan');
      // Could not ask: what was recorded stays.
      answers = [];
      const unknown = await run('9.0.0', { license_status: 'valid', license_modules: PREMIUM });
      expect(unknown.extra.license_modules).toEqual(PREMIUM);
      // Before 9.0 nothing is refused, so nothing is asked.
      asked.length = 0;
      answers = [{ valid: true, modules: PREMIUM }];
      expect((await run('8.9.1', {})).extra.license_modules).toBeUndefined();
      expect(asked).toEqual([]);
    } finally {
      jest.dontMock('../../../src/core/rcapi');
      jest.resetModules();
    }
  });
});

describe("post-ready's advice, where Rocket.Chat 9 refuses the sign-in", () => {
  it('is handed the license gate, so it does not advise a re-run that cannot help', async () => {
    // A 9.0 saml workspace with no license: `up` said "Rocket.Chat itself is fine. Re-run ...
    // houston ready", and `ready` fails the same way until a license is added.
    jest.resetModules();
    const gates: unknown[] = [];
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'running',
      rcRestartCount: async () => 0,
    }));
    jest.doMock('../../../src/core/rcapi', () => ({
      ...jest.requireActual<object>('../../../src/core/rcapi'),
      waitReady: async () => ({ version: '9.0.0' }),
      completeSetupWizard: async () => false,
      licenseInfo: async () => null,
    }));
    jest.doMock('../../../src/core/lifecycle/admin', () => ({
      login: async () => ({ token: 't', userId: 'u' }),
    }));
    jest.doMock('../../../src/core/postready', () => ({
      runPostReady: async (
        _m: unknown,
        _a: unknown,
        _e: unknown,
        o?: { licenseGate?: unknown },
      ) => {
        gates.push(o?.licenseGate ?? null);
        return [];
      },
    }));
    try {
      const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
      const record = require('../../../src/core/runner/record') as typeof RecordNS;
      const presets = require('../../../src/lib/presets/index') as typeof PresetsNS;
      const run = async (rcVersion: string, extra: Record<string, unknown>) => {
        const meta = record.metadata({
          name: 'gate9',
          preset: 'saml',
          rcVersion,
          rootUrl: 'http://localhost:3000',
          extra: { post_ready: presets.load('saml', {}).postReady, ...extra },
        });
        await ready.waitAndFinalize(meta, () => undefined);
      };
      await run('9.0.0', {});
      await run('9.0.0', { license_modules: ['saml-enterprise'] });
      await run('8.9.1', {});
      expect(gates).toEqual([
        { kinds: 'SAML', modules: 'saml-enterprise', through: 'saml', asked: false },
        null,
        null,
      ]);
    } finally {
      for (const module of [
        '../../../src/core/runner/queries',
        '../../../src/core/rcapi',
        '../../../src/core/lifecycle/admin',
        '../../../src/core/postready',
      ])
        jest.dontMock(module);
      jest.resetModules();
    }
  });

  it("reads the gate from Rocket.Chat's answer this run, not the last one", async () => {
    // A license added in Administration since the last `ready`: the setup was handed the
    // record's old "none", and a failure for any other reason was blamed on the license.
    jest.resetModules();
    const gates: unknown[] = [];
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'running',
      rcRestartCount: async () => 0,
    }));
    jest.doMock('../../../src/core/rcapi', () => ({
      ...jest.requireActual<object>('../../../src/core/rcapi'),
      waitReady: async () => ({ version: '9.0.0' }),
      completeSetupWizard: async () => false,
      licenseInfo: async () => ({ valid: true, modules: ['saml-enterprise'] }),
    }));
    jest.doMock('../../../src/core/lifecycle/admin', () => ({
      login: async () => ({ token: 't', userId: 'u' }),
    }));
    jest.doMock('../../../src/core/postready', () => ({
      runPostReady: async (
        _m: unknown,
        _a: unknown,
        _e: unknown,
        o?: { licenseGate?: unknown },
      ) => {
        gates.push(o?.licenseGate ?? null);
        return [];
      },
    }));
    try {
      const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
      const record = require('../../../src/core/runner/record') as typeof RecordNS;
      const presets = require('../../../src/lib/presets/index') as typeof PresetsNS;
      const meta = record.metadata({
        name: 'added9',
        project: 'houston-added9',
        preset: 'saml',
        rcVersion: '9.0.0',
        rootUrl: 'http://localhost:3000',
        extra: { post_ready: presets.load('saml', {}).postReady, license_modules: [] },
      });
      await record.writeRecord('added9', meta);
      await ready.waitAndFinalize(meta, () => undefined);
      expect(gates).toEqual([null]);
    } finally {
      for (const module of [
        '../../../src/core/runner/queries',
        '../../../src/core/rcapi',
        '../../../src/core/lifecycle/admin',
        '../../../src/core/postready',
      ])
        jest.dontMock(module);
      jest.resetModules();
    }
  });
});

describe('starting the stack for the GUI, over a stale systemd unit', () => {
  it('hands the streamed up to the recreate, which is what makes it start', async () => {
    // The GUI's Bring it up streams `compose up`; that path bypassed `engine.up`, so its
    // recovery from a unit the last run left loaded never ran there.
    jest.resetModules();
    const recreatedIfStale = jest.fn(async () => 0);
    jest.doMock('../../../src/core/runner/engine', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/engine'),
      stream: async () => 1,
      recreatedIfStale,
    }));
    try {
      const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
      const rc = await ready.upCompose('w', { pull: false, emit: () => {}, streamOutput: true });
      expect(recreatedIfStale).toHaveBeenCalledWith('w', 1);
      expect(rc).toBe(0);
    } finally {
      jest.dontMock('../../../src/core/runner/engine');
      jest.resetModules();
    }
  });
});

describe('bringing a route back', () => {
  it('Grafana public URL regression: restores the monitored router after start or reuse', async () => {
    jest.resetModules();
    const register = jest.fn(async () => false);
    jest.doMock('../../../src/core/edge/routes', () => ({
      ...jest.requireActual<object>('../../../src/core/edge/routes'),
      register,
    }));
    jest.doMock('../../../src/core/edge/engine', () => ({
      ...jest.requireActual<object>('../../../src/core/edge/engine'),
      running: async () => true,
    }));
    try {
      const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
      const record = require('../../../src/core/runner/record') as typeof RecordNS;
      await ready.restoreRoute(
        record.metadata({
          name: 'w',
          publicUrl: 'https://h',
          extra: { tls: 'acme', monitoring: true },
        }),
      );
      expect(register).toHaveBeenCalledWith('w', 'h', expect.objectContaining({ grafana: true }));
    } finally {
      jest.dontMock('../../../src/core/edge/engine');
      jest.dontMock('../../../src/core/edge/routes');
      jest.resetModules();
    }
  });
  afterEach(() => {
    jest.dontMock('../../../src/core/edge/routes');
    jest.resetModules();
  });

  it('restores nothing for a workspace that has no https name', async () => {
    jest.resetModules();
    const registered: string[] = [];
    jest.doMock('../../../src/core/edge/routes', () => ({
      ...jest.requireActual('../../../src/core/edge/routes'),
      register: async (name: string) => {
        registered.push(name);
        return false;
      },
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    const meta = record.metadata({
      name: 'w',
      project: 'houston-w',
      publicUrl: '',
      extra: { tls: 'acme', tls_ports: [443], tls_email: 'o@e.com' },
    });
    await ready.restoreRoute(meta);
    expect(registered).toEqual([]);
  });
});

describe('a workspace that does not become ready', () => {
  afterEach(() => {
    for (const module of [
      '../../../src/core/runner/queries',
      '../../../src/core/rcapi',
      '../../../src/core/diagnose',
    ])
      jest.dontMock(module);
    jest.resetModules();
  });

  /**
   * `waitServing` over a Rocket.Chat in `state` that restarted `restarts` times, whose
   * readiness wait ticks `ticks` times and then gives up, and whose logs diagnose as
   * `cause`. Returns the module and a live tick counter.
   */
  function load(state: string, restarts: number, ticks: number) {
    jest.resetModules();
    const seen = { ticks: 0, cause: null as string | null };
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => state,
      rcRestartCount: async () => restarts,
      servicesByProject: async () => ({}),
    }));
    jest.doMock('../../../src/core/rcapi', () => {
      const actual = jest.requireActual<typeof RcapiNS>('../../../src/core/rcapi');
      return {
        ...actual,
        waitReady: async (
          _root: string,
          { onTick }: { onTick?: (elapsed: number) => void | Promise<void> } = {},
        ) => {
          for (let i = 0; i < ticks; i += 1) {
            seen.ticks += 1;
            await onTick?.(i);
          }
          throw new actual.NotReady('Rocket.Chat did not become ready within 300s');
        },
      };
    });
    jest.doMock('../../../src/core/diagnose', () => ({
      ...jest.requireActual<object>('../../../src/core/diagnose'),
      diagnoseFailure: async () => seen.cause,
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    const meta = metadata({ name: 'slow', project: 'houston-slow', rcVersion: '8.5.1' });
    const failure = async (timeout: number): Promise<Error> =>
      (await ready
        .waitServing(meta, () => undefined, timeout)
        .then(
          () => null,
          (error: unknown) => error,
        )) as Error;
    return { seen, failure };
  }

  it('asks diagnose for the cause instead of asserting memory pressure', async () => {
    // MEASURED: `env --set MONGO_URL=mongodb://nope...` then `ready` said "likely resource
    // pressure" on a box with 5.7 GB free, while RC's logs said "Topology is closed" and
    // diagnose, never consulted on this path, knew the answer.
    const { seen, failure } = load('running', 0, 0);
    seen.cause = 'MongoDB is up but its replica set never initialised';
    const known = await failure(1);
    expect(known.constructor.name).toBe('NotReadyError');
    expect(known.message).toContain('replica set never initialised');
    expect(known.message.toLowerCase()).not.toContain('resource pressure');
    expect(known.message).not.toContain('raise Docker');

    // Nothing matched and no restarts: no invented cause at all.
    seen.cause = null;
    const unknown = await failure(1);
    expect(unknown.message).toContain('did not become ready');
    expect(unknown.message.toLowerCase()).not.toContain('resource pressure');
    expect(unknown.message).not.toContain('CPU+RAM');
  });

  it('stops waiting on a crash loop once the cause is known, and not on a count alone', async () => {
    // A boot that restarts twice and settles is ordinary; a matched signature is evidence.
    const { seen, failure } = load('restarting', 3, 2);
    seen.cause = 'MongoDB refused the connection';
    expect((await failure(300)).message).toContain('MongoDB refused the connection');
    expect(seen.ticks).toBe(1);

    // Without a known cause it keeps waiting rather than aborting on the count.
    seen.ticks = 0;
    seen.cause = null;
    await failure(300);
    expect(seen.ticks).toBe(2);
  });

  it('says a stopped Docker workspace is stopped and how to start it, not to read its logs', async () => {
    // Audit #18: `houston ready` on a stopped workspace said "container is not running (check
    // `logs`)". Rocket.Chat runs `restart: always`, so only a stop leaves it `exited`. What
    // docker really answers, measured: `compose ps` lists running containers only, so the
    // stopped one is `absent` there, and `compose ls --all` keeps its project, all exited.
    jest.resetModules();
    let projects: Record<string, string> = { 'houston-paused': 'exited(3)' };
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'absent',
      projectStates: async () => projects,
      rcRestartCount: async () => 0,
      servicesByProject: async () => ({}),
    }));
    jest.doMock('../../../src/core/rcapi', () => {
      const actual = jest.requireActual<typeof RcapiNS>('../../../src/core/rcapi');
      // Nothing answers; the liveness check decides, as the real wait's does.
      return {
        ...actual,
        waitReady: async (
          _root: string,
          { isAlive }: { isAlive?: () => boolean | Promise<boolean> } = {},
        ) => {
          if (isAlive !== undefined && !(await isAlive())) {
            throw new actual.NotReady('Rocket.Chat container is not running (check `logs`)');
          }
          throw new actual.NotReady('Rocket.Chat did not become ready within 1s');
        },
      };
    });
    jest.doMock('../../../src/core/diagnose', () => ({
      ...jest.requireActual<object>('../../../src/core/diagnose'),
      diagnoseFailure: async () => null,
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    const meta = metadata({ name: 'paused', project: 'houston-paused', rcVersion: '8.5.1' });
    const failure = async (): Promise<Error> =>
      (await ready.waitServing(meta, () => undefined, 1).catch((error: unknown) => error)) as Error;
    const stopped = await failure();
    expect(stopped.constructor.name).toBe('NotReadyError');
    expect(stopped.message).toBe(
      "'paused' is stopped — `houston start --name paused` brings it back",
    );
    // A container that is gone (taken down: no project left) is not called stopped.
    projects = {};
    expect((await failure()).message).toContain('check `logs`');
  });
});

/**
 * The crash-loop tick's whole-seconds conversion of the elapsed time. Under `--timeout inf` or
 * `nan` the deadline is never reached and the elapsed time is NaN, so in earlier releases the
 * first tick raises `InvalidValue` and the command ends with exit 1; `Math.floor` printed "still
 * booting (NaNs)" every three seconds for ever, a run that never wrote its `end` record.
 */
describe('a tick whose elapsed time is not a number', () => {
  afterEach(() => {
    jest.dontMock('../../../src/core/runner/queries');
    jest.resetModules();
  });

  it('refuses a NaN as earlier releases refused it, and a finite one says what they said', async () => {
    // What earlier releases answered for each (timeout, elapsed) pair, recorded.
    const recorded: [string, string][] = [
      ['InvalidValue', 'NaN is not an integer'],
      ['InvalidValue', 'NaN is not an integer'],
      ['said', 'still booting (3s)'],
    ];
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcRestartCount: async () => 0,
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    const meta = metadata({ name: 'w', rcVersion: '8.5.1', rootUrl: 'http://localhost:3000' });
    const ours: [string, string][] = [];
    for (const [timeout, elapsed] of [
      [Infinity, NaN],
      [NaN, NaN],
      [300, 3.7],
    ] as const) {
      const said: string[] = [];
      try {
        await ready.crashLoopTick(
          meta,
          (event: Event) => said.push(String(event.message)),
          timeout,
          { restarts: 0, cause: null },
          elapsed,
        );
        ours.push(['said', said.at(-1) ?? '']);
      } catch (error) {
        ours.push([(error as Error).name, (error as Error).message]);
      }
    }
    expect(recorded[0]).toEqual(['InvalidValue', 'NaN is not an integer']);
    expect(ours).toEqual(recorded);
  });
});

describe("a Kubernetes workspace's preset forwards, after a stop/start", () => {
  afterEach(() => {
    jest.dontMock('../../../src/core/kube/forward');
    jest.resetModules();
  });

  it('are re-established when one died with its pod, and recorded again', async () => {
    // Only the Rocket.Chat forward was ever repaired: the SAML IdP on :8081 answered
    // nothing after a stop/start, post_ready could not re-read its certificate, and every
    // SAML sign-in was refused as an invalid signature.
    jest.resetModules();
    const stopped: number[] = [];
    jest.doMock('../../../src/core/kube/forward', () => ({
      ...jest.requireActual('../../../src/core/kube/forward'),
      forwardAlive: async (pid: number) => pid !== 5151,
      stopForward: async (pid: number) => {
        stopped.push(pid);
        return true;
      },
      scenarioUiForwards: async () => ({ 8081: 6161, 8082: 6262 }),
    }));
    const record = require('../../../src/core/runner/record') as typeof RecordNS;
    const extra = { scenario_forwards: { 8081: 5151, 8082: 5252 } };
    await record.writeRecord('ks', record.metadata({ name: 'ks', project: 'houston-ks', extra }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const meta = await record.readMeta('ks');
    await ready.repairTheScenarioForwards(meta, () => undefined, extra, 'houston-ks', 'c');
    expect(stopped.sort()).toEqual([5151, 5252]);
    expect((await record.readMeta('ks')).extra.scenario_forwards).toEqual({
      8081: 6161,
      8082: 6262,
    });
  });
});

describe('a multi-instance workspace, ready', () => {
  afterEach(() => {
    for (const module of ['../../../src/core/runner/queries', '../../../src/core/rcapi'])
      jest.dontMock(module);
    jest.resetModules();
  });

  it('waits for one-shot setup to finish, and names one that failed', async () => {
    // Rocket.Chat does not wait for minio-init, so on rootless Podman `up --wait` returned
    // while the bucket did not exist yet. A setup that exits non-zero is said, not hidden.
    jest.resetModules();
    const answers: { service: string; status: string; exitCode: number }[][] = [
      [{ service: 'minio-init', status: 'running', exitCode: 0 }],
      [{ service: 'minio-init', status: 'exited', exitCode: 0 }],
      [{ service: 'minio-init', status: 'exited', exitCode: 1 }],
    ];
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      oneShotSetups: async () => answers.shift() ?? [],
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    const meta = metadata({ name: 's3', project: 'houston-s3' });
    const said: string[] = [];
    const paused: number[] = [];
    await ready.waitForOneShotSetup(
      meta,
      (event) => void said.push(event.message),
      60,
      async (s) => {
        paused.push(s);
      },
    );
    expect(paused).toEqual([2]);
    expect(said).toEqual(['Rocket.Chat answers; waiting for minio-init to finish']);
    await expect(ready.waitForOneShotSetup(meta, () => undefined, 60)).rejects.toThrow(
      "minio-init exited 1 before it finished setting up 's3'",
    );
    jest.dontMock('../../../src/core/runner/queries');
  });

  it('does not hold a serving workspace on a mongo-init re-run that missed a lookup', async () => {
    // `restart` re-runs mongo-init; on rootless Podman its connect missed `mongodb` and it
    // exited 1, and a workspace whose replica set was PRIMARY and serving read as not ready.
    // Rocket.Chat serving is what proves the replica set.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      oneShotSetups: async () => [{ service: 'mongo-init', status: 'exited', exitCode: 1 }],
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    await expect(
      ready.waitForOneShotSetup(metadata({ name: 'm', project: 'houston-m' }), () => undefined, 5),
    ).resolves.toBeUndefined();
    jest.dontMock('../../../src/core/runner/queries');
  });

  it('is not ready while the bucket setup has failed, though Rocket.Chat answers', async () => {
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'running',
      servicesByProject: async () => ({}),
      oneShotSetups: async () => [{ service: 'minio-init', status: 'exited', exitCode: 1 }],
    }));
    jest.doMock('../../../src/core/rcapi', () => ({
      ...jest.requireActual<typeof RcapiNS>('../../../src/core/rcapi'),
      waitReady: async () => ({ version: '8.5.1' }),
      apiInfo: async () => ({ version: '8.5.1' }),
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    const meta = metadata({
      name: 's3w',
      project: 'houston-s3w',
      rcVersion: '8.5.1',
      rootUrl: 'http://localhost:3601',
      hostPort: 3601,
    });
    await expect(ready.waitServing(meta, () => undefined, 60)).rejects.toThrow(
      'minio-init exited 1',
    );
    jest.dontMock('../../../src/core/runner/queries');
    jest.dontMock('../../../src/core/rcapi');
  });

  it('is ready when every instance answers, not when the front door first does', async () => {
    // The workspace's Traefik starts every server healthy and checks every 10 s, so the
    // first instance to answer made `ready` return while the others booted: 9-10 of 20
    // requests answered 502 right after it, and the admin login failed.
    jest.resetModules();
    const asked: string[] = [];
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'running',
      servicesByProject: async () => ({}),
    }));
    jest.doMock('../../../src/core/rcapi', () => ({
      ...jest.requireActual<typeof RcapiNS>('../../../src/core/rcapi'),
      waitReady: async (url: string) => {
        asked.push(url);
        return { version: '8.5.1' };
      },
      // No database to refuse over: the subject is which addresses were waited on.
      apiInfo: async () => ({ version: '8.5.1' }),
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    const meta = metadata({
      name: 'mi',
      project: 'houston-mi',
      rcVersion: '8.5.1',
      rootUrl: 'http://localhost:3600',
      hostPort: 3600,
      extra: { instances: 2 },
    });
    await ready.waitServing(meta, () => undefined, 60).catch(() => undefined);
    expect(asked).toEqual([
      'http://localhost:3600',
      'http://localhost:3601',
      'http://localhost:3602',
    ]);
  });

  it('names the instance that is not serving', async () => {
    // One replica stopped, the front door answering: `ready` exited 5 with only "did not
    // become ready within 59s", and which of the instances was down was left to find.
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'running',
      servicesByProject: async () => ({}),
    }));
    jest.doMock('../../../src/core/rcapi', () => {
      const actual = jest.requireActual<typeof RcapiNS>('../../../src/core/rcapi');
      return {
        ...actual,
        waitReady: async (url: string, { timeout = 0 }: { timeout?: number } = {}) => {
          if (url === 'http://localhost:3602') {
            throw new actual.NotReady(
              `Rocket.Chat did not become ready within ${String(Math.trunc(timeout))}s`,
            );
          }
          return { version: '8.5.1' };
        },
      };
    });
    jest.doMock('../../../src/core/diagnose', () => ({
      ...jest.requireActual<object>('../../../src/core/diagnose'),
      diagnoseFailure: async () => null,
    }));
    try {
      const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
      const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
      const meta = metadata({
        name: 'd2',
        project: 'houston-d2',
        rcVersion: '8.5.1',
        rootUrl: 'http://localhost:3600',
        hostPort: 3600,
        extra: { instances: 2 },
      });
      await expect(ready.waitServing(meta, () => undefined, 60)).rejects.toThrow(
        /did not become ready within \d+s: rocketchat-2 at http:\/\/localhost:3602 is not serving/u,
      );
    } finally {
      jest.dontMock('../../../src/core/runner/queries');
      jest.dontMock('../../../src/core/rcapi');
      jest.dontMock('../../../src/core/diagnose');
    }
  });
});

describe('readiness through the owned HTTPS origin', () => {
  afterEach(() => {
    for (const module of [
      '../../../src/core/runner/queries',
      '../../../src/core/rcapi',
      '../../../src/core/tls',
    ])
      jest.dontMock(module);
    jest.resetModules();
  });

  it('refuses internal success when the restored origin does not serve HTTP', async () => {
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'running',
      oneShotSetups: async () => [],
      servicesByProject: async () => ({}),
    }));
    const asked: string[] = [];
    jest.doMock('../../../src/core/rcapi', () => {
      const actual = jest.requireActual<typeof RcapiNS>('../../../src/core/rcapi');
      return {
        ...actual,
        waitReady: async (url: string) => {
          asked.push(url);
          if (url.startsWith('https:')) throw new actual.NotReady('origin HTTP timeout');
          return { version: '8.5.1' };
        },
      };
    });
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    await expect(
      ready.waitServing(
        metadata({
          name: 'restored',
          project: 'houston-restored',
          rootUrl: 'http://localhost:3500',
          publicUrl: 'https://workspace.example.test',
          extra: { edge: true, tls: 'acme' },
        }),
        () => undefined,
        60,
      ),
    ).rejects.toThrow('its HTTPS origin https://workspace.example.test is not serving');
    expect(asked).toEqual(['http://localhost:3500', 'https://workspace.example.test']);
  });

  it('checks a complete page on loopback with the advertised SNI and a per-observation pin', async () => {
    jest.resetModules();
    jest.doMock('../../../src/core/runner/queries', () => ({
      ...jest.requireActual<object>('../../../src/core/runner/queries'),
      rcState: async () => 'running',
      oneShotSetups: async () => [],
      servicesByProject: async () => ({}),
    }));
    const observations: unknown[] = [];
    jest.doMock('../../../src/core/tls', () => ({
      ...jest.requireActual<object>('../../../src/core/tls'),
      originCertificate: async (host: string, options: unknown) => {
        observations.push({ host, options });
        return { pem: 'OWNED-DEFAULT-CERTIFICATE', fallback: true, error: '' };
      },
    }));
    const requests: unknown[] = [];
    jest.doMock('../../../src/core/rcapi', () => ({
      ...jest.requireActual<object>('../../../src/core/rcapi'),
      waitReady: async (
        url: string,
        options: {
          page?: boolean;
          requestOptions?: (remaining: number) => Promise<unknown>;
        },
      ) => {
        if (options.requestOptions !== undefined)
          requests.push({ url, page: options.page, options: await options.requestOptions(1200) });
        return { version: '8.5.1' };
      },
    }));
    const ready = require('../../../src/core/lifecycle/ready') as typeof ReadyNS;
    const { metadata } = require('../../../src/core/runner/record') as typeof RecordNS;
    await ready.waitServing(
      metadata({
        name: 'pending',
        project: 'houston-pending',
        rootUrl: 'http://localhost:3500',
        publicUrl: 'https://workspace.example.test:3443',
        extra: { edge: true, tls: 'acme' },
      }),
      () => undefined,
      60,
    );
    expect(observations).toEqual([
      {
        host: 'workspace.example.test',
        options: { port: 3443, timeout: 1.2 },
      },
    ]);
    expect(requests).toEqual([
      {
        url: 'https://workspace.example.test:3443',
        page: true,
        options: {
          followRedirects: false,
          loopbackOrigin: {
            certificate: 'OWNED-DEFAULT-CERTIFICATE',
            allowCertificateNameMismatch: true,
          },
        },
      },
    ]);
  });
});
