import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { dumps } from '../../src/lib/json-text';

import { buildPlan, isRedacted } from '../../src/core/configimport';

import type * as ModNS from '../../src/core/configimport';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-configimport-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  jest.resetModules();
});

function write(name: string, text: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

const DUMP = [
  { _id: 'Site_Name', value: 'Acme', packageValue: 'Rocket.Chat' },
  { _id: 'Site_Url', value: 'https://acme.example', packageValue: 'http://localhost:3000' },
  { _id: 'Unchanged', value: 1, packageValue: 1 },
  { _id: 'NoDefault', value: 'x' },
  { _id: 'LDAP_Enable', value: true, packageValue: false },
  { _id: 'LDAP_Password', value: 'XXXXXXXX', packageValue: '' },
  { _id: 'Dotted', value: 'a.b.c.d', packageValue: '' },
  { _id: 'Assets_logo', value: { a: 1 }, packageValue: {} },
  { _id: 'Cloud_Url', value: 'https://c', packageValue: '' },
  { _id: 'Accounts_OAuth_Custom-Keycloak', value: true, packageValue: false },
  { _id: 'Accounts_OAuth_Custom-Keycloak-url', value: 'http://kc', packageValue: '' },
  { _id: 'Accounts_OAuth_Custom-Ms_entra_id-id', value: 'abc', packageValue: '' },
  { _id: 'API_Enable_Rate_Limiter', value: false, packageValue: true },
  { _id: 'ListSame', value: [1, 2], packageValue: [1, 2] },
  { _id: 'ListDiff', value: [1, 2], packageValue: [2, 1] },
  'not a dict',
  { value: 'no id', packageValue: '' },
  { _id: '', value: 'empty id', packageValue: '' },
  { _id: 'Deployment_X', value: 'd', packageValue: '' },
  { _id: 'Statistics_Y', value: 's', packageValue: '' },
];

/** A plan the way earlier releases reported it, for a recorded one to be written as. */
function recordedPlan(
  apply: [string, unknown][],
  redacted: string[],
  denied: string[],
  oauthServices: string[],
): Record<string, unknown> {
  return { apply, redacted, denied, oauth_services: oauthServices };
}

function ours(plan: ModNS.Plan): Record<string, unknown> {
  return {
    apply: plan.apply.map((pair) => [...pair]),
    redacted: plan.redacted,
    denied: plan.denied,
    oauth_services: plan.oauthServices,
  };
}

describe('the import plan', () => {
  it('matches the plan earlier releases made for a dump with one of everything in it', () => {
    const file = write('customer-settings.json', JSON.stringify(DUMP, null, 1));
    // The plan earlier releases made for this dump, recorded.
    const recorded = recordedPlan(
      [
        ['Site_Name', 'Acme'],
        ['LDAP_Enable', true],
        ['Dotted', 'a.b.c.d'],
        ['Accounts_OAuth_Custom-Keycloak', true],
        ['Accounts_OAuth_Custom-Keycloak-url', 'http://kc'],
        ['Accounts_OAuth_Custom-Ms_entra_id-id', 'abc'],
        ['API_Enable_Rate_Limiter', false],
        ['ListDiff', [1, 2]],
      ],
      ['LDAP_Password'],
      ['Site_Url', 'Assets_logo', 'Cloud_Url', 'Deployment_X', 'Statistics_Y'],
      ['Keycloak', 'Ms_entra_id'],
    );
    expect(ours(buildPlan(file))).toEqual(recorded);
  });

  it('filters by id prefix exactly as earlier releases do', () => {
    const file = write('customer-settings.json', JSON.stringify(DUMP));
    // The plan earlier releases made for this dump filtered to LDAP and Accounts, recorded.
    const recorded = recordedPlan(
      [
        ['LDAP_Enable', true],
        ['Accounts_OAuth_Custom-Keycloak', true],
        ['Accounts_OAuth_Custom-Keycloak-url', 'http://kc'],
        ['Accounts_OAuth_Custom-Ms_entra_id-id', 'abc'],
      ],
      ['LDAP_Password'],
      [],
      ['Keycloak', 'Ms_entra_id'],
    );
    expect(ours(buildPlan(file, { only: new Set(['LDAP', 'Accounts']) }))).toEqual(recorded);
  });

  it('takes --only as id prefixes, and says when they match nothing', () => {
    // The help says "id prefixes", and the filter compared the id's first `_` segment: the
    // spelling it invites, `--only Message_`, imported 0 settings and exited 0.
    const file = write(
      'message-settings.json',
      JSON.stringify([{ _id: 'Message_MaxAllowedSize', value: 4321, packageValue: 5000 }]),
    );
    expect(buildPlan(file, { only: new Set(['Message_']) }).apply.map(([id]) => id)).toEqual([
      'Message_MaxAllowedSize',
    ]);
    expect(() => buildPlan(file, { only: new Set(['Mesage_']) })).toThrow(
      '--only Mesage_ matched no setting this dump changes from its default',
    );
  });

  it('imports only what the customer CHANGED', () => {
    const file = write('s.json', JSON.stringify(DUMP));
    const ids = buildPlan(file).apply.map(([sid]) => sid);
    expect(ids).toContain('Site_Name');
    // Sitting at its default, so importing it would say the customer had changed it.
    expect(ids).not.toContain('Unchanged');
    // No packageValue means we cannot tell, so it is skipped rather than guessed at.
    expect(ids).not.toContain('NoDefault');
    // A list compares BY VALUE: same contents is unchanged, different ORDER is a change.
    expect(ids).not.toContain('ListSame');
    expect(ids).toContain('ListDiff');
  });

  it('never imports a setting that identifies the customer or breaks local access', () => {
    const file = write('s.json', JSON.stringify(DUMP));
    const plan = buildPlan(file);
    expect(plan.denied).toEqual([
      'Site_Url',
      'Assets_logo',
      'Cloud_Url',
      'Deployment_X',
      'Statistics_Y',
    ]);
    expect(plan.apply.map(([sid]) => sid)).not.toContain('Site_Url');
  });

  it('pre-creates every custom OAuth provider the dump names', () => {
    // A provider's settings do not exist until the provider is created, so its
    // Accounts_OAuth_Custom-*-* PATCHes would land nowhere.
    const file = write('s.json', JSON.stringify(DUMP));
    expect(buildPlan(file).oauthServices).toEqual(['Keycloak', 'Ms_entra_id']);
  });

  it("plans each value as the dump spells it, so the body sent is the dump's own number", () => {
    // Copied out of the entry, a value lost the spelling the parser keeps beside it: the
    // plan sent `{"value": 5}`, `{"value": 0}` and `{"value": 10000000000000000}` where
    // earlier releases send `5.0`, `-0.0` and `1e+16` -- and Rocket.Chat, reading `-0.0`
    // as -0 and `0` as 0, stored another value; an int past 2**53 went out rounded, and one
    // that differs from its default only past 2**53 was dropped as unchanged.
    const file = write(
      'floats.json',
      '[{"_id": "A_whole", "value": 5.0, "packageValue": 1},\n' +
        ' {"_id": "A_neg0", "value": -0.0, "packageValue": 1},\n' +
        ' {"_id": "A_16", "value": 1e16, "packageValue": 1},\n' +
        ' {"_id": "A_1E5", "value": 1E5, "packageValue": 1},\n' +
        ' {"_id": "A_big", "value": 12345678901234567890, "packageValue": 1},\n' +
        ' {"_id": "A_half", "value": 1.5, "packageValue": 1},\n' +
        ' {"_id": "A_int", "value": 7, "packageValue": 1},\n' +
        ' {"_id": "A_nested", "value": [1.0, null, {"x": 2.0}], "packageValue": []},\n' +
        ' {"_id": "A_same", "value": 1.0, "packageValue": 1},\n' +
        ' {"_id": "B_big_eq", "value": 12345678901234567890, "packageValue": 12345678901234567891},\n' +
        ' {"_id": "B_big_same", "value": 12345678901234567890, "packageValue": 12345678901234567890},\n' +
        ' {"_id": "B_big_vs_float", "value": 12345678901234567890, "packageValue": 1.2345678901234567e19},\n' +
        ' {"_id": "B_nested_big", "value": [12345678901234567890], "packageValue": [12345678901234567891]},\n' +
        ' {"_id": "B_nested_same", "value": {"n": [1.0, 2]}, "packageValue": {"n": [1, 2.0]}},\n' +
        ' {"_id": "B_true_float", "value": true, "packageValue": 1.0},\n' +
        ' {"_id": "B_float_vs_dict", "value": 5.0, "packageValue": {"value": 5}}]',
    );
    // The body earlier releases sent for each setting they planned, recorded.
    const recorded = [
      ['A_whole', '{"value": 5.0}'],
      ['A_neg0', '{"value": -0.0}'],
      ['A_16', '{"value": 1e+16}'],
      ['A_1E5', '{"value": 100000.0}'],
      ['A_big', '{"value": 12345678901234567890}'],
      ['A_half', '{"value": 1.5}'],
      ['A_int', '{"value": 7}'],
      ['A_nested', '{"value": [1.0, null, {"x": 2.0}]}'],
      ['B_big_eq', '{"value": 12345678901234567890}'],
      ['B_big_vs_float', '{"value": 12345678901234567890}'],
      ['B_nested_big', '{"value": [12345678901234567890]}'],
      ['B_float_vs_dict', '{"value": 5.0}'],
    ];
    expect(buildPlan(file).apply.map(([sid, value]) => [sid, dumps({ value })])).toEqual(recorded);
  });

  it('is tolerant of a hand-edited or truncated dump', () => {
    const file = write('s.json', JSON.stringify(DUMP));
    // A bare string, an entry with no `_id`, an empty `_id` -- skipped, not a crash.
    expect(() => buildPlan(file)).not.toThrow();
    expect(buildPlan(file).apply.map(([sid]) => sid)).not.toContain('');
  });
});

describe('a masked secret', () => {
  it('is 4+ repeats of ONE character, not any mixture', () => {
    // A character class matched "x.x.x.x" and "*.*.*.*", and "." inside `[...]` is a
    // literal dot -- so a legitimate dotted value was dropped from the import AND reported
    // to the operator as "the dump masked this".
    for (const masked of ['XXXXXXXX', 'xxxx', '****', '••••', '####', '  XXXX  ']) {
      expect(isRedacted(masked)).toBe(true);
    }
    for (const real of ['a.b.c.d', 'x.x.x.x', 'Xx.#*', 'XXX', '', 'X*X*', 'localhost']) {
      expect(isRedacted(real)).toBe(false);
    }
  });

  it('agrees with earlier releases on every one of them', () => {
    const corpus = [
      'XXXXXXXX',
      'xxxx',
      '****',
      '••••',
      '####',
      '  XXXX  ',
      'a.b.c.d',
      'x.x.x.x',
      'Xx.#*',
      'XXX',
      '',
      'X*X*',
      'localhost',
      '●●●●',
      '▪▪▪▪',
      '····',
    ];
    // What earlier releases answered for each, recorded.
    const recorded = [
      ...[true, true, true, true, true, true],
      ...[false, false, false, false, false, false, false],
      ...[true, true, true],
    ];
    expect(corpus.map((v) => isRedacted(v))).toEqual(recorded);
  });
});

describe('a dump that is not a dump', () => {
  it('says what is wrong with the file, and names the commonest cause', () => {
    // A customer dump is exactly the file that arrives wrong: truncated by a download,
    // HTML from an expired share link, or the whole support bundle instead of the settings
    // file inside it. A raw decoder error is not a ReproError -- the CLI printed a
    // stack trace and the web layer answered 500.
    const file = write('customer-settings.json', '<html><body>Link expired</body></html>');
    let said = '';
    try {
      buildPlan(file);
    } catch (error) {
      said = (error as Error).message;
    }
    expect(said).toContain('customer-settings.json');
    expect(said).toContain('not valid JSON');
    expect(said).toContain('HTML');
  });

  it('reports the same line, column and reason earlier releases report', () => {
    const advice =
      " A Rocket.Chat support dump's *-settings.json is a JSON array; if this came from a" +
      ' browser it may be an HTML error page.';
    // Each file, and what earlier releases said about it, recorded.
    for (const [name, text, recorded] of [
      [
        'customer-settings.json',
        '<html><body>Link expired</body></html>',
        `customer-settings.json is not valid JSON (line 1, column 1: Expecting value).${advice}`,
      ],
      [
        'truncated.json',
        '[{"_id": "a", "value": 1},',
        `truncated.json is not valid JSON (line 1, column 27: Expecting value).${advice}`,
      ],
      [
        'broken.json',
        '[{"_id": "a"\n "value": 1}]',
        `broken.json is not valid JSON (line 2, column 2: Expecting ',' delimiter).${advice}`,
      ],
    ] as const) {
      const file = write(name, text);
      let said = '';
      try {
        buildPlan(file);
      } catch (error) {
        said = (error as Error).message;
      }
      expect(said).toBe(recorded);
    }
  });

  it('reads the file as earlier releases do: strict UTF-8, BOM kept, universal newlines', () => {
    // Node's 'utf8' read put a U+FFFD in for every byte that is not UTF-8, so the whole
    // support bundle (a zip) and a UTF-16 export were "Expecting value" at 1:1, a BOM was
    // "Expecting value" too, and a dump holding one stray byte was applied with the U+FFFD
    // in its value.
    const files: [string, Buffer][] = [
      [
        'bundle.json',
        Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0xec, 0x5a]),
      ],
      ['utf16.json', Buffer.from('\uFEFF[{"_id": "a"}]', 'utf16le')],
      ['bom.json', Buffer.from('\uFEFF[{"_id": "Site_Name", "value": "A", "packageValue": "B"}]')],
      [
        'stray.json',
        Buffer.concat([
          Buffer.from('[{"_id": "Site_Name", "value": "Ac'),
          Buffer.from([0xff]),
          Buffer.from('me", "packageValue": "B"}]'),
        ]),
      ],
      ['cr.json', Buffer.from('[{"_id": "a",\r "value": 1}\r,\r x]')],
      ['crlf.json', Buffer.from('[{"_id": "a",\r\n "value": 1,\r\n "packageValue": 2}]\r\n')],
    ];
    const advice =
      " A Rocket.Chat support dump's *-settings.json is a JSON array; if this came from a" +
      ' browser it may be an HTML error page.';
    // What earlier releases said about each file, or the plan they made from it, recorded.
    const recorded: [string, string][] = [
      [
        'bundle.json',
        'bundle.json is not valid UTF-8 (byte 0xec at position 10: invalid continuation byte)',
      ],
      ['utf16.json', 'utf16.json is not valid UTF-8 (byte 0xff at position 0: invalid start byte)'],
      ['bom.json', `bom.json is not valid JSON (line 1, column 1: Unexpected UTF-8 BOM).${advice}`],
      [
        'stray.json',
        'stray.json is not valid UTF-8 (byte 0xff at position 34: invalid start byte)',
      ],
      ['cr.json', `cr.json is not valid JSON (line 4, column 2: Expecting value).${advice}`],
      ['crlf.json', '[["a", 1]]'],
    ];
    const ours: [string, string][] = [];
    for (const [name, bytes] of files) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, bytes);
      let said: string;
      try {
        said = dumps(buildPlan(file).apply.map((pair) => [...pair]));
      } catch (error) {
        said = (error as Error).message;
      }
      ours.push([name, said]);
    }
    expect(ours).toEqual(recorded);
  });

  it('refuses a JSON document that is not a list of settings', () => {
    const file = write('s.json', '{"a": 1}');
    expect(() => buildPlan(file)).toThrow(
      'expected a list of settings (a Rocket.Chat *-settings.json)',
    );
  });
});

describe('applying the plan', () => {
  function load() {
    jest.resetModules();
    const calls: [string, unknown][] = [];
    const notes: string[] = [];
    let limiterPrev: unknown = true;
    const state = {
      calls,
      notes,
      setLimiterPrev: (v: unknown) => {
        limiterPrev = v;
      },
      setOk: (_sid: string) => true,
    };
    jest.doMock('../../src/core/rcapi', () => ({
      getSetting: () => Promise.resolve(limiterPrev),
      setSetting: (_u: string, _a: unknown, _p: string, sid: string, value: unknown) => {
        calls.push([sid, value]);
        return Promise.resolve(state.setOk(sid));
      },
      addOauthService: (_u: string, _a: unknown, _p: string, name: string) => {
        calls.push(['+oauth', name]);
        return Promise.resolve(null);
      },
    }));
    jest.doMock('../../src/core/journal', () => ({
      RATE_LIMITER_OFF: 'rate_limiter_off',
      record: (kind: string, ws: string, detail: { purpose?: string } = {}) => {
        notes.push(`+${kind}:${ws}${detail.purpose === undefined ? '' : `:${detail.purpose}`}`);
        return 'note-1';
      },
      clear: (id: string) => notes.push(`-${id}`),
    }));
    return { mod: require('../../src/core/configimport') as typeof ModNS, state };
  }

  const AUTH = { token: 't', userId: 'u' };

  it('creates providers first, then applies everything but the limiter', async () => {
    const { mod, state } = load();
    const plan: ModNS.Plan = {
      apply: [
        ['Accounts_OAuth_Custom-Keycloak', true],
        ['API_Enable_Rate_Limiter', true],
        ['Site_Name', 'Acme'],
      ],
      redacted: ['LDAP_Password'],
      denied: ['Site_Url'],
      oauthServices: ['Keycloak'],
    };
    const result = await mod.apply('http://x', AUTH, plan, { workspace: 'T-1' });
    expect(state.calls.map(([sid]) => sid)).toEqual([
      'API_Enable_Rate_Limiter', // disabled for the bulk PATCH
      '+oauth',
      'Accounts_OAuth_Custom-Keycloak',
      'Site_Name',
      'API_Enable_Rate_Limiter', // and the dump's own value, last
    ]);
    // The dump SETS the limiter, so the dump's value wins and the note is closed.
    expect(state.calls.at(-1)).toEqual(['API_Enable_Rate_Limiter', true]);
    // Said as a settings import's, not a performance run's, when recovery describes it.
    expect(state.notes).toEqual(['+rate_limiter_off:T-1:a settings import', '-note-1']);
    expect(result).toEqual({ applied: 3, failed: 0, skipped: 2, failures: [] });
  });

  it('leaves the limiter alone when it could not be read', async () => {
    // `=== true`, not `!== false`: an UNREADABLE setting must not be treated as "was on"
    // and forced on afterwards.
    const { mod, state } = load();
    state.setLimiterPrev(null);
    const plan: ModNS.Plan = {
      apply: [['Site_Name', 'A']],
      redacted: [],
      denied: [],
      oauthServices: [],
    };
    await mod.apply('http://x', AUTH, plan, { workspace: 'T-1' });
    expect(state.calls.map(([sid]) => sid)).toEqual(['Site_Name']);
    expect(state.notes).toEqual([]);
  });

  it('counts a refused setting as a failure, by name', async () => {
    const { mod, state } = load();
    state.setLimiterPrev(false);
    state.setOk = (sid: string) => sid !== 'Site_Name';
    const plan: ModNS.Plan = {
      apply: [
        ['Site_Name', 'A'],
        ['Other', 1],
      ],
      redacted: [],
      denied: [],
      oauthServices: [],
    };
    expect(await mod.apply('http://x', AUTH, plan)).toEqual({
      applied: 1,
      failed: 1,
      skipped: 0,
      failures: ['Site_Name'],
    });
  });

  it('changes nothing at all on a dry run', async () => {
    const { mod, state } = load();
    const plan: ModNS.Plan = {
      apply: [['Site_Name', 'A']],
      redacted: ['a'],
      denied: ['b', 'c'],
      oauthServices: ['K'],
    };
    expect(await mod.apply('http://x', AUTH, plan, { dryRun: true })).toEqual({
      applied: 0,
      failed: 0,
      skipped: 3,
      failures: [],
    });
    expect(state.calls).toEqual([]);
  });
});

describe('the small dumps earlier releases were held to', () => {
  it('denies the settings that identify the customer, the licence included', () => {
    const file = write(
      's.json',
      JSON.stringify([
        { _id: 'Site_Url', value: 'https://cust', packageValue: '' },
        { _id: 'Enterprise_License', value: 'RCV3_x', packageValue: '' },
        { _id: 'Assets_logo', value: { url: 'a' }, packageValue: {} },
        { _id: 'Message_MaxAllowedSize', value: 9000, packageValue: 5000 },
      ]),
    );
    const plan = buildPlan(file);
    expect(plan.apply.map(([sid]) => sid)).toEqual(['Message_MaxAllowedSize']);
    expect(new Set(plan.denied)).toEqual(
      new Set(['Site_Url', 'Enterprise_License', 'Assets_logo']),
    );
    // The plan earlier releases made for this dump, recorded.
    const recorded = recordedPlan(
      [['Message_MaxAllowedSize', 9000]],
      [],
      ['Site_Url', 'Enterprise_License', 'Assets_logo'],
      [],
    );
    expect(ours(plan)).toEqual(recorded);
  });

  it('skips a bare string, a numeric id and an entry with no value, and keeps the good one', () => {
    const file = write(
      's.json',
      JSON.stringify([
        'just a string',
        { _id: 123, value: 'x', packageValue: 'y' },
        { _id: 'NoValue', packageValue: 'y' },
        { _id: 'Good', value: 'new', packageValue: 'old' },
      ]),
    );
    expect(buildPlan(file).apply.map(([sid]) => sid)).toEqual(['Good']);
    // The plan earlier releases made for this dump, recorded.
    const recorded = recordedPlan([['Good', 'new']], [], [], []);
    expect(ours(buildPlan(file))).toEqual(recorded);
  });

  it('reads a lowercase, a bullet and a hash mask as redacted, and a real value as real', () => {
    const file = write(
      's.json',
      JSON.stringify([
        { _id: 'A', value: 'xxxxxxxx', packageValue: '' },
        { _id: 'B', value: '●●●●●●', packageValue: '' },
        { _id: 'C', value: '########', packageValue: '' },
        { _id: 'D', value: 'real-value', packageValue: '' },
        { _id: 'SMTP_Password', value: 'XXXXXXXX', packageValue: '' },
        { _id: 'Some_Secret', value: '********', packageValue: '' },
      ]),
    );
    const plan = buildPlan(file);
    expect(plan.apply.map(([sid]) => sid)).toEqual(['D']);
    expect(new Set(plan.redacted)).toEqual(
      new Set(['A', 'B', 'C', 'SMTP_Password', 'Some_Secret']),
    );
    // The plan earlier releases made for this dump, recorded.
    const recorded = recordedPlan(
      [['D', 'real-value']],
      ['A', 'B', 'C', 'SMTP_Password', 'Some_Secret'],
      [],
      [],
    );
    expect(ours(plan)).toEqual(recorded);
  });
});
