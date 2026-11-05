import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../../../src/lib/config';
import { ValidationError } from '../../../src/lib/errors';
import { EMAIL_2FA } from '../../../src/lib/presets/common';
import {
  compositeName,
  composePresets,
  namesOf,
  qualifiedParams,
} from '../../../src/lib/presets/composite';
import { load, loadMany, scenarioNames, userPath } from '../../../src/lib/presets/index';
import { emptyPreset, type Preset } from '../../../src/lib/presets/types';

const BUILT_IN = [
  'airgapped',
  'email',
  'ldap',
  'livechat',
  'multi-instance',
  'oidc',
  's3_minio',
  'saml',
  'voice',
  'webhooks',
];

function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationError) return error.message;
    throw error;
  }
  return 'composed';
}

function preset(name: string, over: Partial<Preset>): Preset {
  return { ...emptyPreset(name), ...over };
}

describe('the conflict matrix of the built-in presets', () => {
  it('composes the voice PBX lab with every other built-in preset on Docker', () => {
    // Its services, files and ports (drachtio, freeswitch, pbx; 5060, 5080, 20000-20046,
    // 30000-30019) collide with no other preset's.
    const lab = { voice: { sip_integration: 'on', pbx: 'on', freeswitch_dialplans: 'edit' } };
    // Every preset the catalogue has, not a list kept by hand: e2ee was missing from one.
    const others = [...scenarioNames()].filter((n) => !['voice', 'default'].includes(n));
    expect(others).toEqual(expect.arrayContaining(['airgapped', 'e2ee', 'email', 'ldap']));
    const refused = others.filter(
      (other) => refusal(() => loadMany(['voice', other], lab, 'docker')) !== 'composed',
    );
    expect(refused).toEqual([]);
    const composed = loadMany(['email', 'voice'], lab, 'docker');
    expect(Object.keys(composed.services).sort()).toEqual(
      expect.arrayContaining(['drachtio', 'freeswitch', 'pbx']),
    );
    expect(composed.keepFiles).toHaveLength(5);
  });

  it("takes the voice options' 2.1.3 spellings in a combination, and maps them", () => {
    // `--set voice.sip=on` from a 2.1.3 command or a composed workspace's record.
    const was = { voice: { sip: 'on', pbx: 'on', fs_dialplan: 'edit' } };
    const now = { voice: { sip_integration: 'on', pbx: 'on', freeswitch_dialplans: 'edit' } };
    const [old, current] = [was, now].map((params) =>
      loadMany(['email', 'voice'], params, 'docker'),
    );
    expect([old?.services, old?.keepFiles, old?.ports]).toEqual([
      current?.services,
      current?.keepFiles,
      current?.ports,
    ]);
    expect(current?.paramAliases).toEqual({
      'voice.sip': 'voice.sip_integration',
      'voice.fs_dialplan': 'voice.freeswitch_dialplans',
    });
  });

  it('composes every pair on both runtimes except saml + oidc, the same in either order', () => {
    expect([...scenarioNames()].sort()).toEqual(
      expect.arrayContaining(BUILT_IN.filter((n) => n !== 'multi-instance')),
    );
    const refused: string[] = [];
    for (const runtime of ['docker', 'kubernetes']) {
      for (const [i, a] of BUILT_IN.entries()) {
        for (const b of BUILT_IN.slice(i + 1)) {
          if (
            runtime === 'kubernetes' &&
            [a, b].some((n) => ['airgapped', 'multi-instance'].includes(n))
          )
            continue;
          const said = refusal(() => loadMany([a, b], {}, runtime));
          if (said !== 'composed') {
            refused.push(`${runtime} ${a}+${b}`);
            continue;
          }
          expect(loadMany([a, b], {}, runtime)).toEqual(loadMany([b, a], {}, runtime));
        }
      }
    }
    expect(refused).toEqual(['docker oidc+saml', 'kubernetes oidc+saml']);
  });

  it('refuses saml + oidc naming both and saying why', () => {
    const said = refusal(() => loadMany(['saml', 'oidc'], {}, 'docker'));
    expect(said).toContain("'oidc' and 'saml'");
    expect(said).toContain('one SSO preset per workspace');
  });
});

describe('env: soft defaults and hard values', () => {
  it('gives ldap + email email-2FA ON with no flag: email is hard, ldap only soft', () => {
    const both = loadMany(['ldap', 'email'], {}, 'docker');
    expect(both.env[EMAIL_2FA]).toBe('true');
    expect(both.softEnv).not.toContain(EMAIL_2FA);
    expect(loadMany(['ldap', 'saml'], {}, 'docker').env[EMAIL_2FA]).toBe('false');
  });

  it('refuses two hard values naming both presets, unless the user decides', () => {
    const a = preset('alpha', { env: { OVERWRITE_SETTING_Site_Name: 'A', API_KEY: 'k1' } });
    const b = preset('beta', { env: { OVERWRITE_SETTING_Site_Name: 'B', API_KEY: 'k2' } });
    const said = refusal(() => composePresets([a, b]));
    expect(said).toContain("'alpha' sets OVERWRITE_SETTING_Site_Name=A");
    expect(said).toContain("'beta' sets OVERWRITE_SETTING_Site_Name=B");
    expect(said).toContain('--setting Site_Name=<value>');
    const decided = composePresets([a, b], new Set(['OVERWRITE_SETTING_Site_Name', 'API_KEY']));
    expect('OVERWRITE_SETTING_Site_Name' in decided.env).toBe(false);
    // A secret is never printed in the refusal.
    const secret = refusal(() => composePresets([a, b], new Set(['OVERWRITE_SETTING_Site_Name'])));
    expect(secret).not.toContain('k1');
    expect(secret).toContain('--env API_KEY=<value>');
  });

  it('refuses two soft defaults that disagree, and keeps two that agree', () => {
    const a = preset('alpha', { env: { X: '1' }, softEnv: ['X'] });
    const b = preset('beta', { env: { X: '2' }, softEnv: ['X'] });
    expect(refusal(() => composePresets([a, b]))).toContain('X=');
    const c = preset('gamma', { env: { X: '1' }, softEnv: ['X'] });
    expect(composePresets([a, c]).env.X).toBe('1');
  });
});

describe('the unions', () => {
  it('refuses a service, a file, a port or a Kubernetes object both presets claim', () => {
    const svc = (name: string) => preset(name, { services: { shared: { image: name } } });
    expect(refusal(() => composePresets([svc('alpha'), svc('beta')]))).toContain(
      "'alpha' and 'beta' both define the service \"shared\"",
    );
    const file = (name: string) => preset(name, { files: [['same.json', name]] });
    expect(refusal(() => composePresets([file('alpha'), file('beta')]))).toContain('the file');
    const port = (name: string) => preset(name, { ports: [9999] });
    expect(refusal(() => composePresets([port('alpha'), port('beta')]))).toContain('host port');
    const kube = (name: string) =>
      preset(name, { kubernetesManifests: ['kind: Service\nmetadata:\n  name: shared\n'] });
    expect(refusal(() => composePresets([kube('alpha'), kube('beta')]))).toContain(
      '"Service/shared"',
    );
  });

  it('keeps the kept files of every member', () => {
    const a = preset('alpha', { files: [['a/x', '1']], keepFiles: ['a/x'] });
    const b = preset('beta', { files: [['b/y', '2']], keepFiles: ['b/y'] });
    expect(composePresets([a, b]).keepFiles).toEqual(['a/x', 'b/y']);
  });

  it('refuses a Rocket.Chat patch both set differently, and deep-merges the rest', () => {
    const a = preset('alpha', { rocketchat: { labels: { a: '1' }, mem_limit: '1g' } });
    const b = preset('beta', { rocketchat: { labels: { b: '2' } } });
    expect(composePresets([a, b]).rocketchat).toEqual({
      labels: { a: '1', b: '2' },
      mem_limit: '1g',
    });
    const c = preset('gamma', { rocketchat: { mem_limit: '2g' } });
    expect(refusal(() => composePresets([a, c]))).toContain('"mem_limit"');
  });

  it('ORs requiresLicense, unions ports, and qualifies params by preset', () => {
    const both = loadMany(['ldap', 'email'], {}, 'docker');
    expect(both.name).toBe('email+ldap');
    expect([...both.ports].sort()).toEqual([8025, 8082]);
    expect(Object.keys(both.paramsHelp)).toEqual(
      expect.arrayContaining(['ldap.users', 'email.verification']),
    );
    expect(
      composePresets([preset('alpha', { requiresLicense: true }), preset('beta', {})])
        .requiresLicense,
    ).toBe(true);
  });

  it('notes what only the combination needs', () => {
    expect(loadMany(['ldap', 'email'], {}, 'docker').notes.join('\n')).toContain(
      'an LDAP login asks for a code: read it in Mailpit',
    );
  });
});

describe('two user stores, kept apart', () => {
  it('names the SSO users sso-userN, email included, only when a directory is composed in', () => {
    const realm = (p: Preset) =>
      JSON.parse(
        (p.files.find(([file]) => file.endsWith('keycloak-realm.json')) as [string, string])[1],
      ) as {
        users: { username: string; email: string; credentials: { value: string }[] }[];
      };
    const apart = realm(loadMany(['ldap', 'saml'], {}, 'docker')).users[0];
    expect([apart?.username, apart?.email, apart?.credentials[0]?.value]).toEqual([
      'sso-user1',
      'sso-user1@example.com',
      'sso-user1',
    ]);
    expect(realm(loadMany(['ldap', 'oidc'], {}, 'docker')).users[0]?.username).toBe('sso-user1');
    // Kubernetes carries the same realm in its ConfigMap.
    expect(loadMany(['ldap', 'saml'], {}, 'kubernetes').kubernetesManifests.join('\n')).toContain(
      'sso-user1@example.com',
    );
    // A single SSO preset, and SSO with anything but a directory, are unchanged.
    expect(realm(loadMany(['saml'], {}, 'docker')).users[0]?.username).toBe('user1');
    expect(realm(loadMany(['saml', 'email'], {}, 'docker')).users[0]?.username).toBe('user1');
    expect(loadMany(['saml'], {}, 'docker')).toEqual(load('saml', {}));
  });

  it('tells an OIDC login the user Keycloak has, not the directory one', () => {
    // ldap+oidc said "Then log in via 'Keycloak (OIDC)' as user1 / user1." a few lines above
    // "Keycloak users are sso-user1..N": Keycloak has no user1 there.
    for (const params of [{}, { oidc: { idp_host: 'box.example.com' } }]) {
      const notes = loadMany(['ldap', 'oidc'], params, 'docker').notes.join('\n');
      expect(notes).toContain("via 'Keycloak (OIDC)' as sso-user1 / sso-user1.");
      expect(notes).not.toMatch(/ as user1 \/ user1/u);
    }
    expect(load('oidc', {}).notes.join('\n')).toContain("via 'Keycloak (OIDC)' as user1 / user1.");
  });
});

describe('one preset, and none', () => {
  it('is that preset unchanged, and default is the identity', () => {
    const ldap = load('ldap', { users: '3' });
    expect(composePresets([ldap])).toBe(ldap);
    expect(composePresets([load('default', {}), ldap])).toBe(ldap);
    expect(loadMany(['ldap'], { ldap: { users: '3' } }, 'docker')).toEqual(ldap);
    expect(loadMany([], {}, 'docker').name).toBe('default');
  });

  it('spells a set one way: sorted, deduplicated, default dropped, + between', () => {
    expect(compositeName(['ldap', 'email', 'ldap', 'default'])).toBe('email+ldap');
    expect(compositeName(['default'])).toBe('default');
    expect(namesOf('email+ldap')).toEqual(['email', 'ldap']);
    expect(namesOf('')).toEqual(['default']);
  });

  it('treats a user YAML preset as all hard', () => {
    fs.mkdirSync(config.presetDir(), { recursive: true });
    fs.writeFileSync(
      path.join(config.presetDir(), 'mine.yaml'),
      `name: mine\nenv:\n  ${EMAIL_2FA}: 'false'\n`,
    );
    expect(refusal(() => loadMany(['mine', 'email'], {}, 'docker'))).toContain(EMAIL_2FA);
  });
});

describe('a composed workspace read by an earlier release', () => {
  it('is refused loudly by the preset-name check earlier releases make, never half-built', () => {
    // `preset: "email+ldap"` is one string ON PURPOSE. This check is the one earlier releases
    // apply before `up --force` or `restore --new` loads a preset (the same expression,
    // recorded): `+` is not a preset-name character, so they stop with this message instead of
    // building one of the two presets, or crashing on a list in `list` and `info`.
    expect(() => userPath('email+ldap')).toThrow(
      "'email+ldap' is not a preset name (want lower-case letters, digits, '-' and '_', starting with a letter or digit)",
    );
    expect(() => userPath('email-ldap')).not.toThrow();
  });

  it('turns recorded params back into the --set keys that say them', () => {
    expect(qualifiedParams({ ldap: { users: '7' }, email: {}, junk: 'x' })).toEqual({
      'ldap.users': '7',
    });
  });
});

describe('one set, one spelling', () => {
  it('spells `ldap+email` typed as one token as the set it is', () => {
    // Kept as typed, it derived a second workspace for the same set and a Kubernetes re-up
    // spelled `--preset email --preset ldap` was refused as a different one.
    expect(compositeName(['ldap+email'])).toBe('email+ldap');
    expect(compositeName(['ldap+email', 'email'])).toBe('email+ldap');
  });
});

describe('the notes a combination adds', () => {
  it('fit the width `info` prints notes at, so none breaks mid-sentence', () => {
    // `info` lays a note out 82 columns wide (`printNotes`): a first line is word-wrapped
    // behind a 4-space indent, so 78 for its text; a continuation line is printed as given
    // behind 6, so 76. An 81-column first line printed "...marks LDAP users' emails" / "as" /
    // "verified, so an LDAP login asks for a code".
    for (const names of [
      ['email', 'ldap'],
      ['ldap', 'saml'],
      ['ldap', 'oidc'],
    ]) {
      const own = new Set(names.flatMap((name) => load(name, {}).notes));
      const added = loadMany(names, {}, 'docker').notes.filter((line) => !own.has(line));
      expect(added.length).toBeGreaterThan(0);
      const tooWide = (line: string): boolean =>
        line.startsWith(' ') ? line.trim().length > 76 : line.length > 78;
      expect(added.filter(tooWide)).toEqual([]);
    }
  });
});
