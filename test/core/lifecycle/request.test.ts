import * as fs from 'node:fs';
import * as path from 'node:path';

import { createReq } from '../../../src/core/lifecycle/types';
import {
  chooseImage,
  samlEmailWarning,
  paramsByPreset,
  premiumAuthWarning,
  deriveIdpHost,
  inferRuntime,
  savedDefaultIsBillable,
  sayWhereThisIsGoing,
  unknownParams,
  defaultDomainFromZone,
  voiceLicenceWarning,
} from '../../../src/core/lifecycle/request';

import type * as ConfigNS from '../../../src/lib/config';
import type * as PresetsNS from '../../../src/lib/presets/index';

describe('reading a create request', () => {
  it('infers the runtime and reads the saved-cluster policy as earlier releases do', () => {
    const contexts = [
      'arn:aws:eks:us-east-1:1:cluster/x',
      'GKE_project_zone_name',
      'gke_x',
      'kind-houston-local',
      'k3s',
      '  arn:aws:eks: ',
      '',
    ];
    // What earlier releases answered for each case, recorded.
    const recorded = {
      infer: ['', 'docker', 'kubernetes', 'kubernetes', 'kubernetes', 'DOCKER'],
      billable: [true, true, true, false, false, true, false],
    };
    const inferCases: [string, string][] = [
      ['', ''],
      ['docker', ''],
      ['kubernetes', ''],
      ['', 'arn:aws:eks:us-east-1:1:cluster/x'],
      ['', 'kind-x'],
      ['DOCKER', ''],
    ];
    expect(
      inferCases.map(([runtime, context]) =>
        inferRuntime(createReq({ version: '8.5.1', runtime, context })),
      ),
    ).toEqual(recorded.infer);
    expect(contexts.map(savedDefaultIsBillable)).toEqual(recorded.billable);
  });

  it('lists unknown --set params and derives an IdP host exactly as earlier releases do', () => {
    const derivations = [
      {
        version: '8.5.1',
        preset: 'saml',
        root_url: 'https://rc.example.com',
        bind: '0.0.0.0',
        domain: '',
      },
      {
        version: '8.5.1',
        preset: 'oidc',
        root_url: '',
        bind: '0.0.0.0',
        domain: 'idp.example.com',
      },
      {
        version: '8.5.1',
        preset: 's3_minio',
        root_url: 'https://rc.example.com',
        bind: '0.0.0.0',
        domain: '',
        params: { presigned: 'true' },
      },
      {
        version: '8.5.1',
        preset: 's3_minio',
        root_url: 'https://rc.example.com',
        bind: '0.0.0.0',
        domain: '',
      },
      {
        version: '8.5.1',
        preset: 'saml',
        root_url: 'https://rc.example.com',
        bind: '127.0.0.1',
        domain: '',
      },
      {
        version: '8.5.1',
        preset: 'saml',
        root_url: 'https://rc.example.com',
        bind: '0.0.0.0',
        domain: '',
        params: { idp_host: 'already.example.com' },
      },
      // Nothing is invented for a URL that names this machine, or for a preset with no IdP.
      {
        version: '8.5.1',
        preset: 'saml',
        root_url: 'http://localhost:3001',
        bind: '0.0.0.0',
        domain: '',
      },
      {
        version: '8.5.1',
        preset: 'ldap',
        root_url: 'https://rc.example.com',
        bind: '0.0.0.0',
        domain: '',
      },
    ];
    // What earlier releases derived and said for each request, and the unknown params, recorded.
    const recorded: {
      derived: { params: Record<string, unknown>; messages: string[] }[];
      unknown: string[][];
    } = {
      derived: [
        {
          params: { idp_host: 'rc.example.com' },
          messages: [
            "the saml preset will address its own service as 'rc.example.com', taken from the URL you gave — that is the name the browser follows, and its default names only the machine running houston. Override with `--set idp_host=...`.",
          ],
        },
        {
          params: { idp_host: 'idp.example.com' },
          messages: [
            "the oidc preset will address its own service as 'idp.example.com', taken from the URL you gave — that is the name the browser follows, and its default names only the machine running houston. Override with `--set idp_host=...`.",
          ],
        },
        {
          params: { presigned: 'true', s3_host: 'rc.example.com' },
          messages: [
            "the s3_minio preset will address its own service as 'rc.example.com', taken from the URL you gave — that is the name the browser follows, and its default names only the machine running houston. Override with `--set s3_host=...`.",
          ],
        },
        { params: {}, messages: [] },
        { params: {}, messages: [] },
        { params: { idp_host: 'already.example.com' }, messages: [] },
        { params: {}, messages: [] },
        { params: {}, messages: [] },
      ],
      unknown: [[], ['presigned']],
    };
    const derived = derivations.map((spec) => {
      const req = createReq({
        version: spec.version,
        preset: spec.preset,
        rootUrl: spec.root_url,
        bind: spec.bind,
        domain: spec.domain,
        ...(spec.params === undefined ? {} : { params: spec.params }),
      });
      const messages: string[] = [];
      deriveIdpHost(req, (event) => messages.push(event.message));
      return { params: req.params, messages };
    });
    expect(derived).toEqual(recorded.derived);
    // Agreement alone would pass two answers that both derived nothing, so the answers the
    // derivation exists for are stated: taken from --root-url and said out loud, taken from
    // --domain, s3_minio's own param only in presigned mode, never over an explicit value,
    // never for localhost or a preset with no IdP.
    expect(derived.map((one) => one.params.idp_host ?? one.params.s3_host ?? null)).toEqual([
      'rc.example.com',
      'idp.example.com',
      'rc.example.com',
      null,
      null,
      'already.example.com',
      null,
      null,
    ]);
    expect(derived[0]?.messages.join(' ')).toContain('rc.example.com');
    const presets = require('../../../src/lib/presets/index') as typeof PresetsNS;
    const pre = presets.load('default', {});
    expect([unknownParams({}, pre), unknownParams({ presigned: true }, pre)]).toEqual(
      recorded.unknown,
    );
  });
});

describe('what a create request says without saying it', () => {
  it('reads an explicit context as Kubernetes, and never the box default', () => {
    // Somebody who named a cluster has already said where it runs; an explicit runtime
    // always wins. A CONFIGURED default cluster is a convenience, not a statement that
    // every un-flagged `up` is now Kubernetes.
    const config = require('../../../src/lib/config') as typeof ConfigNS;
    expect(inferRuntime(createReq({ version: '8.5.1', context: 'arn:aws:eks:x' }))).toBe(
      'kubernetes',
    );
    expect(
      inferRuntime(createReq({ version: '8.5.1', context: 'arn:aws:eks:x', runtime: 'docker' })),
    ).toBe('docker');
    expect(inferRuntime(createReq({ version: '8.5.1' }))).toBe('');
    config.updateConfig((cfg) => {
      cfg[config.KUBE_CONTEXT_KEY] = 'arn:aws:eks:default';
    });
    try {
      expect(inferRuntime(createReq({ version: '8.5.1' }))).toBe('');
    } finally {
      config.updateConfig((cfg) => {
        delete cfg[config.KUBE_CONTEXT_KEY];
      });
    }
  });

  it('catches a typo in a --set param rather than ignoring it', () => {
    // `--set agent=5` (for `agents`) was silently ignored.
    const presets = require('../../../src/lib/presets/index') as typeof PresetsNS;
    const livechat = presets.load('livechat', {});
    expect(unknownParams({ agent: '5' }, livechat)).toEqual(['agent']);
    expect(unknownParams({ agents: '5' }, livechat)).toEqual([]);
    expect(unknownParams({ x: '1' }, presets.load('default', {}))).toEqual(['x']);
  });
});

describe('a saved default cluster', () => {
  const EKS = 'arn:aws:eks:us-east-1:1:cluster/support';

  function said(
    saved: string,
    typed: string,
    extra: { context?: string } = {},
  ): [string, [string, string][]] {
    const config = require('../../../src/lib/config') as typeof ConfigNS;
    config.updateConfig((cfg) => {
      cfg[config.KUBE_CONTEXT_KEY] = saved;
    });
    const out: [string, string][] = [];
    const req = createReq({ version: '8.5.1', name: 't', runtime: typed, ...extra });
    const was = String(req.runtime).trim();
    req.runtime = inferRuntime(req);
    sayWhereThisIsGoing(req, was, (event) => out.push([event.level, event.message]));
    return [req.runtime, out];
  }

  afterEach(() => {
    const config = require('../../../src/lib/config') as typeof ConfigNS;
    config.updateConfig((cfg) => {
      delete cfg[config.KUBE_CONTEXT_KEY];
    });
  });

  it('never changes what a bare up means, but now says so', () => {
    // THE BEHAVIOUR IS UNCHANGED -- a bare `up` is still Docker. Only the silence went.
    const [runtime, out] = said(EKS, '');
    expect(['', 'docker']).toContain(runtime);
    expect(out[0]?.[1]).toContain('going to Docker');
    expect(out[0]?.[1]).toContain('--runtime kubernetes');
    // An explicit `--runtime docker` is an instruction, and naming the cluster is already
    // unambiguous: neither is repeated back.
    expect(said(EKS, 'docker')[1]).toEqual([]);
    expect(said(EKS, '', { context: EKS })[1]).toEqual([]);
    // A saved BILLABLE default chosen implicitly is a warning, because it costs money.
    const [, billed] = said(EKS, 'kubernetes');
    expect(billed[0]?.[0]).toBe('warn');
    expect(billed[0]?.[1]).toContain('costs money by the hour');
    expect(billed[0]?.[1]).toContain('saved default');
    // A saved free cluster used the same way is silent -- that is what saving one is for.
    expect(said('default', 'kubernetes')[1]).toEqual([]);
    expect(said('k3s-prod', 'kubernetes')[1]).toEqual([]);
  });
});

describe('the public name a cluster zone gives a workspace', () => {
  // The zone is known once, on the cluster; every ticket typed it again as --domain.
  const events: string[] = [];
  const emit = (event: { message: string }): void => void events.push(event.message);
  const noteFor = (zone: string): void => {
    const dir = path.join(process.env.HOUSTON_HOME as string, 'clusters', 'support');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'cluster.json'),
      JSON.stringify({
        name: 'support',
        region: 'us-east-1',
        account: '1',
        provider: 'eks',
        expires: '',
        zone,
        created_at: '',
      }),
    );
  };

  it('defaults the domain to <name>.<zone> for a workspace on a cluster with a zone, and says so', async () => {
    noteFor('rc.example.com');
    const req = createReq({ version: '8.5.1', context: 'arn:aws:eks:us-east-1:1:cluster/support' });
    await defaultDomainFromZone(req, 'ticket-1234', emit);
    expect(req.domain).toBe('ticket-1234.rc.example.com');
    expect(events.join(' ')).toContain('ticket-1234.rc.example.com');
    expect(events.join(' ')).toContain('--domain');
  });

  it('leaves a workspace that already exists with the name it has', async () => {
    // down then up is how a workspace comes back with its data; one made with its own
    // --domain moved to <name>.<zone>, a new ROOT_URL and a new certificate order.
    noteFor('rc.example.com');
    const dir = path.join(process.env.HOUSTON_HOME as string, 'repros', 'ticket-1234');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'repro.json'), '{}');
    const req = createReq({ version: '8.5.1', context: 'arn:aws:eks:us-east-1:1:cluster/support' });
    await defaultDomainFromZone(req, 'ticket-1234', emit);
    expect(req.domain).toBe('');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('leaves an explicit --domain alone, and a cluster without a zone alone', async () => {
    noteFor('rc.example.com');
    const typed = createReq({
      version: '8.5.1',
      context: 'arn:aws:eks:us-east-1:1:cluster/support',
      domain: 'x.example.org',
    });
    await defaultDomainFromZone(typed, 'ticket-1234', emit);
    expect(typed.domain).toBe('x.example.org');
    noteFor('');
    const plain = createReq({
      version: '8.5.1',
      context: 'arn:aws:eks:us-east-1:1:cluster/support',
    });
    await defaultDomainFromZone(plain, 'ticket-1234', emit);
    expect(plain.domain).toBe('');
    const docker = createReq({ version: '8.5.1' });
    await defaultDomainFromZone(docker, 'ticket-1234', emit);
    expect(docker.domain).toBe('');
  });
});

describe('which image a create runs', () => {
  const resolved = (rcImage: string, source: string) =>
    ({ rcImage, source }) as Parameters<typeof chooseImage>[0];

  it('takes the flag, then the box-wide rc_image, then the resolved one', () => {
    const release = resolved('registry.rocket.chat/rocketchat/rocket.chat', 'releases.rocket.chat');
    chooseImage(release, '', 'mirror.example/rc');
    expect(release.rcImage).toBe('mirror.example/rc');
    chooseImage(release, 'flag.example/rc', 'mirror.example/rc');
    expect(release.rcImage).toBe('flag.example/rc');
  });

  it("keeps a CI build's own image under a box-wide mirror, which points at releases", () => {
    const build = resolved('ghcr.io/rocketchat/rocket.chat:develop', 'ci build');
    chooseImage(build, '', 'mirror.example/rc');
    expect(build.rcImage).toBe('ghcr.io/rocketchat/rocket.chat:develop');
  });
});

describe('the voice licence warning', () => {
  it('says a voice workspace with no licence boots without a call button, and how to add one', () => {
    const said = voiceLicenceWarning(['voice'], false, '');
    expect(said).toContain('Voice add-on (teams-voip)');
    expect(said).toContain('no call button');
    expect(said).toContain('Administration → Subscription');
    // Compose passes a combination as the one name it built.
    expect(voiceLicenceWarning(['email+voice'], false, '')).toBe(said);
  });

  it('stays quiet with a licence or a token, and for other presets', () => {
    expect([
      voiceLicenceWarning(['voice'], true, ''),
      voiceLicenceWarning(['voice'], false, 'tok'),
      voiceLicenceWarning(['email'], false, ''),
    ]).toEqual(['', '', '']);
  });
});

describe('the Rocket.Chat 9 login warning', () => {
  // The presets as built, so the warning is held to what each one really sets up.
  const built = (name: string, params: Record<string, string> = {}) => {
    const { load } = require('../../../src/lib/presets/index') as typeof PresetsNS;
    return load(name, params);
  };
  const many = (names: string[]) => {
    const { loadMany } = require('../../../src/lib/presets/index') as typeof PresetsNS;
    return loadMany(names, {}, 'docker');
  };

  it('names the login presets on 9 and above, with neither a licence nor a token', () => {
    const said = premiumAuthWarning(built('ldap'), '9.0.0', false, '');
    expect(said).toContain('refuse LDAP login without a Premium plan');
    expect(said).toContain('a license carrying ldap-enterprise');
    expect(said).toContain('will be refused');
    // Both front-ends: the flags for the terminal, the dialog's button for the GUI, and the
    // notes for later, rather than flags alone.
    expect(said).toContain('(--license or --reg-token; in the GUI, Add a license)');
    expect(said).toContain("as the workspace's notes say");
    expect(said).not.toContain('--license <file>');
    expect(premiumAuthWarning(built('saml'), '9.1.0.dev0', false, '')).toContain(
      'SAML login without a Premium plan (a license carrying saml-enterprise)',
    );
    expect(premiumAuthWarning(built('oidc'), '9.0.0', false, '')).toContain(
      'Custom OAuth login without a Premium plan (a license carrying oauth-enterprise)',
    );
  });

  it("names every module an ldap workspace signs in through, its idp's too", () => {
    // ldap's idp=oidc creates a Custom OAuth provider and idp=saml a SAML one: measured on
    // 9.0.0, the warning named only ldap-enterprise while the OAuth provider was refused.
    expect(premiumAuthWarning(built('ldap', { idp: 'oidc' }), '9.0.0', false, '')).toContain(
      'LDAP and Custom OAuth login without a Premium plan (a license carrying ' +
        'ldap-enterprise and oauth-enterprise)',
    );
    expect(premiumAuthWarning(built('ldap', { idp: 'saml' }), '9.0.0', false, '')).toContain(
      'a license carrying ldap-enterprise and saml-enterprise',
    );
  });

  it('warns for a combination, which Compose passes as the one name it built', () => {
    // `email+ldap` and `ldap+multi-instance` matched no login preset, so Docker never warned
    // for a combination while Kubernetes, passing the members, did.
    expect(premiumAuthWarning(many(['email', 'ldap']), '9.0.0', false, '')).toContain(
      'refuse LDAP login without a Premium plan',
    );
    const both = premiumAuthWarning(many(['ldap', 'saml']), '9.0.0', false, '');
    expect(both).toContain(
      'LDAP and SAML login without a Premium plan (a license carrying ldap-enterprise and saml-enterprise)',
    );
    expect(both).toContain('through the ldap and saml preset');
  });

  it('stays quiet below 9, with a licence or a token, and for other presets', () => {
    expect([
      premiumAuthWarning(built('ldap'), '8.9.0', false, ''),
      premiumAuthWarning(built('ldap'), '9.0.0', true, ''),
      premiumAuthWarning(built('ldap'), '9.0.0', false, 'tok'),
      premiumAuthWarning(many(['email', 'default']), '9.0.0', false, ''),
      premiumAuthWarning(built('ldap'), 'not-a-version', false, ''),
    ]).toEqual(['', '', '', '', '']);
  });
});

describe('--set across several presets', () => {
  it('routes a qualified key, and a plain one exactly one preset takes', () => {
    expect(paramsByPreset(['email', 'ldap'], { 'ldap.users': '7', verification: 'true' })).toEqual({
      email: { verification: 'true' },
      ldap: { users: '7' },
    });
  });

  it('refuses a plain key two presets take, naming the qualified forms', () => {
    expect(() => paramsByPreset(['ldap', 'saml'], { users: '3' })).toThrow(
      '--set users is taken by more than one preset; say which: --set ldap.users=... or --set saml.users=...',
    );
  });

  it('refuses a key no selected preset takes, listing what they do', () => {
    expect(() => paramsByPreset(['email', 'ldap'], { 'saml.users': '3' })).toThrow(
      /unknown --set param saml\.users for presets 'email', 'ldap' - valid: .*email\.verification.*ldap\.users/u,
    );
  });

  it("routes a voice option's 2.1.3 spelling as typed, qualified or plain, and knows it", () => {
    // A 2.1.3 command or a composed record says voice.sip; the record keeps what was typed and
    // the preset reads it through its aliases, so neither check may call it unknown.
    const { load } = require('../../../src/lib/presets/index') as typeof PresetsNS;
    expect(paramsByPreset(['email', 'voice'], { 'voice.sip': 'on', fs_dialplan: 'edit' })).toEqual({
      email: {},
      voice: { sip: 'on', fs_dialplan: 'edit' },
    });
    expect(unknownParams({ sip: 'on', pbx: 'on', fs_dialplan: 'edit' }, load('voice'))).toEqual([]);
    expect(unknownParams({ ring: 'on' }, load('voice'))).toEqual(['ring']);
  });
});

describe('the browser host of a composed workspace', () => {
  it("is derived per preset, under that preset's qualified key", () => {
    const req = createReq({
      version: '8.5.1',
      preset: 'email+saml',
      bind: '0.0.0.0',
      rootUrl: 'https://box.example',
    });
    deriveIdpHost(req);
    expect(req.params).toEqual({ 'saml.idp_host': 'box.example' });
  });
});

describe('a SAML login with the email preset', () => {
  /** The workspace's preset as a create resolves it, from the real definitions. */
  const preset = (names: string[], params: Record<string, Record<string, unknown>> = {}) =>
    (require('../../../src/lib/presets/index') as typeof PresetsNS).loadMany(
      names,
      params as never,
      'docker',
    );
  const EMAIL_2FA_KEY = 'OVERWRITE_SETTING_Accounts_TwoFactorAuthentication_By_Email_Enabled';

  it('warns that a SAML login cannot finish email 2FA, and names the setting', () => {
    const said = samlEmailWarning(preset(['email', 'saml']), '8.5.1', new Set());
    expect(said).toContain('SAML sign-in + email on Rocket.Chat 8.5.1');
    expect(said).toContain('--setting Accounts_TwoFactorAuthentication_By_Email_Enabled=false');
  });

  it("says what happens without quoting Rocket.Chat's words, which differ", () => {
    // It quoted "User not found"; the 8.5.1 browser showed "Invalid two factor code".
    const said = samlEmailWarning(preset(['email', 'saml']), '8.5.1', new Set());
    expect(said).toContain(
      'Rocket.Chat refuses the code it emails to a SAML login, so the sign-in cannot finish',
    );
    expect(said).not.toContain('User not found');
  });

  it('warns on 8.9.0 and later too, and no longer offers 8.9.0 as the way out', () => {
    // 8.9.0 refused the emailed code in a real browser, through the domain and straight to
    // the edge alike, so "or use 8.9.0 or later" sent people to a version that fails.
    for (const version of ['8.9.0', '9.0.0']) {
      const said = samlEmailWarning(preset(['email', 'saml']), version, new Set());
      expect(said).toContain(`SAML sign-in + email on Rocket.Chat ${version}`);
      expect(said).not.toContain('8.9.0 or later');
    }
  });

  it('warns for a directory signed in through SAML, which no preset named saml says', () => {
    // `ldap --set idp=saml` puts the directory's users behind Keycloak's SAML, and the
    // emailed code met the same refusal there, seen live; the name check let it pass silent.
    const said = samlEmailWarning(
      preset(['email', 'ldap'], { ldap: { idp: 'saml' } }),
      '8.5.1',
      new Set(),
    );
    expect(said).toContain('--setting Accounts_TwoFactorAuthentication_By_Email_Enabled=false');
  });

  it('is quiet without a SAML login or the email preset, and once the user sets the key', () => {
    expect([
      samlEmailWarning(preset(['saml']), '8.5.1', new Set()),
      samlEmailWarning(preset(['email', 'ldap']), '8.5.1', new Set()),
      samlEmailWarning(preset(['email', 'ldap'], { ldap: { idp: 'oidc' } }), '8.5.1', new Set()),
      samlEmailWarning(preset(['email', 'saml']), '8.5.1', new Set([EMAIL_2FA_KEY])),
    ]).toEqual(['', '', '', '']);
  });
});

describe('the IdP host a combination derives', () => {
  it('leaves a plain --set idp_host the user typed as theirs', () => {
    // In a combination the plain key is routed to the one preset that takes it -- after the
    // derivation, so the derived `saml.idp_host` (the root URL's host) won over the IdP the
    // user typed.
    const req = createReq({
      version: '8.5.1',
      preset: 'email+saml',
      bind: '0.0.0.0',
      rootUrl: 'http://rc.example.test:3611',
      params: { idp_host: 'sso.example.test' },
    });
    deriveIdpHost(req);
    expect(req.params).toEqual({ idp_host: 'sso.example.test' });
  });
});
