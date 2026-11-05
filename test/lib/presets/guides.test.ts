import { guide, withoutLocalSetup } from '../../../src/lib/presets/guides';
import { load, loadMany } from '../../../src/lib/presets/index';
import { withPublicUrl } from '../../../src/lib/presets/public';

const GUIDED = [
  'e2ee',
  'email',
  'ldap',
  'livechat',
  'oidc',
  's3_minio',
  'saml',
  'voice',
  'multi-instance',
  'webhooks',
];

describe("a preset's guide for the scenario card", () => {
  it.each(GUIDED)('%s writes one: a summary, steps, every line on one line', (name) => {
    const guides = load(name, {}).guides;
    expect(guides.map((g) => g.name)).toEqual([name]);
    const [one] = guides;
    expect(one?.summary).not.toBe('');
    expect(one?.steps.length).toBeGreaterThan(0);
    const lines = [
      one?.summary ?? '',
      ...(one?.steps ?? []),
      ...(one?.know ?? []),
      ...(one?.signIn ?? []).flat(),
    ];
    for (const line of lines) expect(line).not.toMatch(/\n|^\s|\s$/u);
    for (const row of one?.signIn ?? []) expect(row).toHaveLength(3);
  });

  it('a YAML preset has none, and a plain workspace neither', () => {
    expect(load('airgapped', {}).guides).toEqual([]);
    expect(load('default', {}).guides).toEqual([]);
  });

  it('follows the parameters: the hosts entry, the PBX, the directory flavour', () => {
    expect(load('oidc', {}).guides[0]?.setup?.line).toBe('127.0.0.1  keycloak');
    expect(load('oidc', { idp_host: 'idp.example.test' }).guides[0]?.setup).toBeNull();
    expect(load('s3_minio', { presigned: 'true' }).guides[0]?.setup?.line).toBe('127.0.0.1  minio');
    expect(load('s3_minio', {}).guides[0]?.setup).toBeNull();
    const lab = load('voice', { sip_integration: 'on', pbx: 'on' }).guides[0];
    expect(lab?.steps.join(' ')).toContain('Local/1002@from-outside');
    expect(lab?.signIn).toEqual([
      ['voice-alice', 'voice-alice', 'extension 1001'],
      ['voice-bob', 'voice-bob', 'extension 1002'],
    ]);
    expect(load('voice', {}).guides[0]?.steps.join(' ')).not.toContain('Dial 123');
    expect(load('ldap', { directory: 'ad', groups: 'on' }).guides[0]?.know.join(' ')).toContain(
      'Samba returns',
    );
    expect(load('ldap', { idp: 'oidc' }).guides[0]?.setup?.line).toBe('127.0.0.1  keycloak');
    expect(load('e2ee', { policy: 'enforced' }).guides[0]?.know[0]).toContain('enforced');
  });

  it('a combination carries one guide per preset, in order, with the combined note under the first named', () => {
    const composed = loadMany(['email', 'ldap', 'voice'], {}, 'docker');
    expect(composed.guides.map((g) => g.name)).toEqual(['email', 'ldap', 'voice']);
    expect(composed.guides[0]?.know.join(' ')).toContain('LDAP + email');
    // Its own copy: the preset's guide is not changed by composing it.
    expect(load('email', {}).guides[0]?.know.join(' ')).not.toContain('LDAP + email');
  });

  it("over a public URL nothing needs the reader's own machine", () => {
    const served = withPublicUrl(load('oidc', {}), 'https://ws.example.test', 'docker').guides[0];
    expect(served?.setup).toBeNull();
    expect(served?.know.join(' ')).not.toMatch(/hosts entry/iu);
    expect(
      withoutLocalSetup([
        guide('x', { setup: { why: 'w', line: 'l' }, know: ['a hosts entry', 'kept'] }),
      ])[0],
    ).toMatchObject({ setup: null, know: ['kept'] });
  });

  it.each([
    ['saml', {}],
    ['oidc', {}],
    ['oidc', { idp_host: 'idp.example.test' }],
    ['ldap', { idp: 'oidc' }],
    ['ldap', { idp: 'saml' }],
  ])(
    'over HTTPS %s %j sends the browser to Keycloak at the path, with nothing to set up',
    (name, params) => {
      // The card kept "SAML sends your browser to http://localhost:8081" and the step "Add the
      // hosts entry above." with the box it pointed at removed.
      const [served] = withPublicUrl(
        load(name, params),
        'https://ws.example.test',
        'docker',
      ).guides;
      const lines = [...(served?.steps ?? []), ...(served?.know ?? [])].join('\n');
      expect(lines).not.toMatch(/http:\/\/|hosts entry|--bind|localhost/u);
      expect(lines).toContain('Keycloak is at https://ws.example.test/keycloak');
    },
  );

  it('drops the blank lines a conditional part leaves', () => {
    expect(guide('x', { steps: ['a', '', '  '], know: [''] })).toEqual({
      name: 'x',
      summary: '',
      setup: null,
      signIn: [],
      steps: ['a'],
      know: [],
    });
  });
});
