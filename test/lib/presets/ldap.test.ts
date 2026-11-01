/**
 * The ldap preset's Directory lab parameters: groups and a service bind.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { choiceParam, safeLoadAll } from '../../../src/lib/presets/common';
import {
  AD_SEED,
  GENERATOR,
  SHIPPED_USERS_MAX,
  withCertificate,
} from '../../../src/lib/presets/ldap';
import { load, loadMany, resolve } from '../../../src/lib/presets/index';
import type { Preset } from '../../../src/lib/presets/types';

function ldifOf(preset: Preset): string {
  return (preset.files.find(([file]) => file.endsWith('.ldif')) as [string, string])[1];
}

/** The members of one posixGroup in an LDIF. */
function membersOf(ldif: string, cn: string): string[] {
  const block = ldif.split('\n\n').find((entry) => entry.startsWith(`dn: cn=${cn},`)) ?? '';
  return block
    .split('\n')
    .filter((line) => line.startsWith('memberUid: '))
    .map((line) => line.slice('memberUid: '.length));
}

describe('--set groups=on', () => {
  it('adds the lab groups, with the last user left out of rocket-chat', () => {
    const ldif = ldifOf(load('ldap', { users: '4', groups: 'on' }));
    expect(membersOf(ldif, 'rocket-chat')).toEqual(['user1', 'user2', 'user3']);
    expect(membersOf(ldif, 'rocket-admin')).toEqual(['user1']);
    expect(membersOf(ldif, 'employee')).toEqual(['user1', 'user2', 'user3', 'user4']);
    // The group every release has seeded is still there, still with everyone.
    expect(membersOf(ldif, 'rc-users')).toHaveLength(4);
  });

  it('lets only rocket-chat log in, matching memberUid against the username', () => {
    expect(load('ldap', { groups: 'on' }).env).toMatchObject({
      OVERWRITE_SETTING_LDAP_Group_Filter_Enable: 'true',
      OVERWRITE_SETTING_LDAP_Group_Filter_ObjectClass: 'posixGroup',
      OVERWRITE_SETTING_LDAP_Group_Filter_Group_Member_Attribute: 'memberUid',
      OVERWRITE_SETTING_LDAP_Group_Filter_Group_Member_Format: '#{username}',
      OVERWRITE_SETTING_LDAP_Group_Filter_Group_Name: 'rocket-chat',
    });
  });

  it("maps rocket-admin to admin and employee to #employees, in both releases' spellings", () => {
    const env = load('ldap', { groups: 'on' }).env;
    expect(env).toMatchObject({
      OVERWRITE_SETTING_LDAP_Sync_User_Data_Roles: 'true',
      OVERWRITE_SETTING_LDAP_Sync_User_Data_Roles_BaseDN: 'ou=groups,dc=example,dc=com',
      OVERWRITE_SETTING_LDAP_Sync_User_Data_Roles_Filter:
        '(&(cn=#{groupName})(memberUid=#{username}))',
      OVERWRITE_SETTING_LDAP_Sync_User_Data_RolesMap: '{"rocket-admin":"admin"}',
      OVERWRITE_SETTING_LDAP_Sync_User_Data_ChannelsMap: '{"employee":"employees"}',
      // The ids before 4.0.0 renamed them.
      OVERWRITE_SETTING_LDAP_Sync_User_Data_GroupsMap: '{"rocket-admin":"admin"}',
      OVERWRITE_SETTING_LDAP_Sync_User_Data_Groups_AutoChannelsMap: '{"employee":"employees"}',
    });
  });

  it('changes nothing when it is off', () => {
    const plain = load('ldap', {});
    expect(plain).toEqual(load('ldap', { groups: 'off', bind: 'admin' }));
    expect(Object.keys(plain.env).some((key) => key.includes('Group_Filter'))).toBe(false);
    expect(membersOf(ldifOf(plain), 'rocket-chat')).toEqual([]);
  });
});

describe('--set bind=service', () => {
  it('binds Rocket.Chat as the read-only user the directory creates, on both runtimes', () => {
    const preset = load('ldap', { bind: 'service' });
    expect(preset.env).toMatchObject({
      OVERWRITE_SETTING_LDAP_Authentication_UserDN: 'cn=readonly,dc=example,dc=com',
      OVERWRITE_SETTING_LDAP_Authentication_Password: 'readonly',
    });
    expect(preset.services.openldap?.environment).toMatchObject({
      LDAP_READONLY_USER: 'true',
      LDAP_READONLY_USER_USERNAME: 'readonly',
    });
    const kube = resolve('ldap', 'kubernetes', { bind: 'service' });
    const deployment = kube.kubernetesManifests
      .flatMap((manifest) => safeLoadAll(manifest))
      .find((doc) => (doc as { kind?: string }).kind === 'Deployment') as {
      spec: { template: { spec: { containers: { env: { name: string; value: string }[] }[] } } };
    };
    expect(deployment.spec.template.spec.containers[0]?.env).toEqual(
      expect.arrayContaining([{ name: 'LDAP_READONLY_USER', value: 'true' }]),
    );
  });
});

describe('the lab parameters', () => {
  it('refuse a value outside their choices, naming them', () => {
    expect(() => load('ldap', { groups: 'yes' })).toThrow(
      "--set groups='yes' expects one of: off, on",
    );
    expect(() => choiceParam({ bind: 'root' }, 'bind', ['admin', 'service'])).toThrow(
      'expects one of: admin, service',
    );
  });

  it('qualify as ldap.* when composed', () => {
    const both = loadMany(['ldap', 'email'], { ldap: { groups: 'on' } }, 'docker');
    expect(both.env.OVERWRITE_SETTING_LDAP_Group_Filter_Enable).toBe('true');
    expect(Object.keys(both.paramsHelp)).toEqual(
      expect.arrayContaining(['ldap.groups', 'ldap.bind']),
    );
  });
});

describe('a directory too large to ship', () => {
  /** What the generator writes for these params, run the way the container runs it. */
  function generate(env: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-gen-'));
    try {
      const script = path.join(dir, 'gen-users.sh');
      const out = path.join(dir, 'out.ldif');
      fs.writeFileSync(script, GENERATOR);
      const run = spawnSync('sh', [script, out], {
        env: { ...process.env, ...env },
        encoding: 'utf8',
      });
      expect(run.status).toBe(0);
      return fs.readFileSync(out, 'utf8');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('is generated byte for byte as houston ships it, groups and all', () => {
    for (const [users, groups] of [
      ['0', 'off'],
      ['1', 'on'],
      ['37', 'off'],
      ['37', 'on'],
    ] as const) {
      const shipped = ldifOf(load('ldap', { users, groups, domain: 'corp.example.org' }));
      expect(
        generate({
          HOUSTON_LDAP_USERS: users,
          HOUSTON_LDAP_BASE_DN: 'dc=corp,dc=example,dc=org',
          HOUSTON_LDAP_DOMAIN: 'corp.example.org',
          HOUSTON_LDAP_GROUPS: groups,
          // The container has it from slapd's own environment, as it has the base DN.
          LDAP_ADMIN_PASSWORD: 'admin',
        }),
      ).toBe(shipped);
    }
  });

  it('ships the generator instead of the LDIF past 500 users, on both runtimes', () => {
    expect(SHIPPED_USERS_MAX).toBe(500);
    const at = load('ldap', { users: '500' });
    expect(at.files.map(([file]) => file)).toEqual(['ldap/50-rc-users.ldif']);
    const big = load('ldap', { users: '130000', groups: 'on' });
    expect(big.files.map(([file]) => file)).toEqual(['ldap/gen-users.sh']);
    expect(big.services.openldap).toMatchObject({
      entrypoint: [
        '/bin/sh',
        '-c',
        expect.stringContaining('&& exec /usr/local/bin/docker-entrypoint.sh slapd'),
      ],
      environment: { HOUSTON_LDAP_USERS: '130000', HOUSTON_LDAP_GROUPS: 'on' },
    });
    // The ConfigMap a client-side apply annotates is the script, not 37 MB of LDIF.
    const kube = resolve('ldap', 'kubernetes', { users: '130000' }).kubernetesManifests.join('\n');
    expect(Buffer.byteLength(kube)).toBeLessThan(262_144);
    expect(kube).toContain('gen-users.sh');
  });
});

describe('--set tls=ldaps|starttls', () => {
  const CERT = { crt: 'LEAF-PEM', key: 'KEY-PEM', ca: 'CA-PEM' };

  it("serves LDAPS on 636 or StartTLS on 389, with houston's files and no client certificate", () => {
    const ldaps = load('ldap', { tls: 'ldaps' });
    expect(ldaps.env).toMatchObject({
      OVERWRITE_SETTING_LDAP_Port: '636',
      OVERWRITE_SETTING_LDAP_Encryption: 'ssl',
      OVERWRITE_SETTING_LDAP_Reject_Unauthorized: 'true',
    });
    expect(ldaps.services.openldap?.environment).toMatchObject({
      LDAP_TLS_CRT_FILENAME: 'ldap.crt',
      LDAP_TLS_CA_CRT_FILENAME: 'ca.crt',
      LDAP_TLS_VERIFY_CLIENT: 'never',
    });
    expect(ldaps.services.openldap?.volumes).toEqual(
      expect.arrayContaining(['./ldap/certs/ldap.key:/container/certs/ldap.key:ro']),
    );
    expect(ldaps.extra).toEqual({ directory_tls: 'ldaps', directory_trust: 'houston' });
    expect(load('ldap', { tls: 'starttls' }).env).toMatchObject({
      OVERWRITE_SETTING_LDAP_Port: '389',
      OVERWRITE_SETTING_LDAP_Encryption: 'tls',
    });
    expect(load('ldap', {}).extra).toEqual({});
  });

  it('gets the certificate as files on Compose and a Secret on Kubernetes, and the CA unless trust=none', () => {
    const docker = withCertificate(load('ldap', { tls: 'ldaps' }), CERT, 'docker');
    expect(docker.files.map(([file]) => file)).toEqual(
      expect.arrayContaining(['ldap/certs/ldap.crt', 'ldap/certs/ldap.key', 'ldap/certs/ca.crt']),
    );
    expect(docker.env.OVERWRITE_SETTING_LDAP_CA_Cert).toBe('CA-PEM');
    const untrusted = withCertificate(
      load('ldap', { tls: 'ldaps', trust: 'none' }),
      CERT,
      'docker',
    );
    expect('OVERWRITE_SETTING_LDAP_CA_Cert' in untrusted.env).toBe(false);
    const kube = withCertificate(
      resolve('ldap', 'kubernetes', { tls: 'starttls' }),
      CERT,
      'kubernetes',
    );
    const docs = kube.kubernetesManifests.flatMap((manifest) => safeLoadAll(manifest)) as {
      kind: string;
      metadata: { name: string };
      stringData?: Record<string, string>;
      spec?: { template: { spec: { volumes: { name: string }[] } } };
    }[];
    expect(
      docs.find((doc) => doc.kind === 'Secret' && doc.metadata.name === 'openldap-tls')?.stringData,
    ).toEqual({
      'ldap.crt': 'LEAF-PEM',
      'ldap.key': 'KEY-PEM',
      'ca.crt': 'CA-PEM',
    });
    const deployment = docs.find(
      (doc) => doc.kind === 'Deployment' && doc.metadata.name === 'openldap',
    );
    // LDAPS is reachable through the Service, not only inside the pod.
    const service = (
      resolve('ldap', 'kubernetes', { tls: 'ldaps' }).kubernetesManifests.flatMap((manifest) =>
        safeLoadAll(manifest),
      ) as { kind: string; metadata: { name: string }; spec: { ports: { port: number }[] } }[]
    ).find((doc) => doc.kind === 'Service' && doc.metadata.name === 'openldap');
    expect(service?.spec.ports.map((port) => port.port)).toEqual([389, 636]);
    expect(deployment?.spec?.template.spec.volumes.map((volume) => volume.name)).toEqual([
      'bootstrap',
      'tls',
    ]);
  });
});

describe('--set directory=ad', () => {
  const AD = { directory: 'ad' };

  it('points Rocket.Chat at Samba as AD, through the LDAP_AD_* fields it reads in that mode', () => {
    const env = load('ldap', AD).env;
    expect(env).toMatchObject({
      OVERWRITE_SETTING_LDAP_Server_Type: 'ad',
      OVERWRITE_SETTING_LDAP_Host: 'samba-ad',
      OVERWRITE_SETTING_LDAP_BaseDN: 'DC=example,DC=com',
      OVERWRITE_SETTING_LDAP_Authentication_UserDN: 'CN=Administrator,CN=Users,DC=example,DC=com',
      OVERWRITE_SETTING_LDAP_AD_User_Search_Field: 'sAMAccountName',
      OVERWRITE_SETTING_LDAP_AD_Username_Field: 'sAMAccountName',
      OVERWRITE_SETTING_LDAP_Unique_Identifier_Field: 'objectGUID',
      OVERWRITE_SETTING_LDAP_User_Search_Filter:
        '(&(objectCategory=person)(objectClass=user)(!(userAccountControl:1.2.840.113556.1.4.803:=2)))',
    });
    // The plain fields are not what an `ad` server type reads, so they are not set at all.
    expect('OVERWRITE_SETTING_LDAP_User_Search_Field' in env).toBe(false);
  });

  it('lets in only rocket-chat members through the nesting, and syncs by in-chain membership', () => {
    const env = load('ldap', { ...AD, groups: 'on', bind: 'service' }).env;
    expect(env.OVERWRITE_SETTING_LDAP_User_Search_Filter).toContain(
      '(memberOf:1.2.840.113556.1.4.1941:=CN=rocket-chat,OU=Groups,DC=example,DC=com)',
    );
    expect(env).toMatchObject({
      OVERWRITE_SETTING_LDAP_Sync_User_Data_Roles_BaseDN: 'OU=Groups,DC=example,DC=com',
      OVERWRITE_SETTING_LDAP_Sync_User_Data_Roles_Filter:
        '(&(objectClass=group)(cn=#{groupName})(member:1.2.840.113556.1.4.1941:=#{userdn}))',
      OVERWRITE_SETTING_LDAP_Authentication_UserDN: 'CN=readonly,CN=Users,DC=example,DC=com',
    });
    expect('OVERWRITE_SETTING_LDAP_Group_Filter_Enable' in env).toBe(false);
  });

  it('runs Samba in place of OpenLDAP on Compose, seeded by the script, phpLDAPadmin on it', () => {
    const preset = load('ldap', AD);
    expect(Object.keys(preset.services)).toEqual(['samba-ad', 'phpldapadmin']);
    expect(preset.services['samba-ad']).toMatchObject({
      image: expect.stringMatching(/^smblds\/smblds@sha256:[0-9a-f]{64}$/u),
      entrypoint: ['/bin/sh', '-c', expect.stringContaining('/entrypoint.d/50-houston-seed')],
      environment: { REALM: 'EXAMPLE.COM', DOMAIN: 'EXAMPLE', INSECURE_LDAP: 'true' },
    });
    // phpLDAPadmin 2: the Administrator signs in by DN; Samba has no entryUUID.
    expect(preset.services.phpldapadmin?.environment).toEqual({
      LDAP_HOST: 'samba-ad',
      LDAP_BASE_DN: 'DC=example,DC=com',
      LDAP_USERNAME: 'CN=Administrator,CN=Users,DC=example,DC=com',
      LDAP_PASSWORD: expect.any(String),
      LDAP_LOGIN_ATTR: 'dn',
      LDAP_LOGIN_ATTR_DESC: 'Login DN',
      LDAP_LOGIN_OBJECTCLASS: 'user',
      LDAP_GUIDKEY: 'objectguid',
    });
    expect(preset.files).toEqual([['ldap/ad-seed.sh', AD_SEED]]);
    expect(preset.dependsOn).toEqual(['samba-ad']);
  });

  it('is the same seed on Kubernetes, with LDAPS on the Service and the certificate for samba-ad', () => {
    const kube = resolve('ldap', 'kubernetes', { ...AD, tls: 'ldaps' });
    const docs = kube.kubernetesManifests.flatMap((manifest) => safeLoadAll(manifest)) as {
      kind: string;
      metadata: { name: string };
      data?: Record<string, string>;
      spec?: { ports?: { port: number }[] };
    }[];
    expect(docs.map((doc) => `${doc.kind}/${doc.metadata.name}`)).toEqual([
      'ConfigMap/samba-ad-seed',
      'Deployment/samba-ad',
      'Service/samba-ad',
      'Deployment/phpldapadmin',
      'Service/phpldapadmin',
    ]);
    expect(docs[0]?.data).toEqual({ 'ad-seed.sh': AD_SEED });
    expect(docs[2]?.spec?.ports?.map((port) => port.port)).toEqual([389, 636]);
    expect(kube.extra).toEqual({
      directory_tls: 'ldaps',
      directory_trust: 'houston',
      directory_host: 'samba-ad',
    });
    expect(kube.env.OVERWRITE_SETTING_LDAP_Encryption).toBe('ssl');
  });

  it('changes nothing when it is openldap', () => {
    expect(load('ldap', { directory: 'openldap' })).toEqual(load('ldap', {}));
    expect(() => load('ldap', { directory: 'ldap' })).toThrow('expects one of: openldap, ad');
  });
});

describe("the AD directory's seed", () => {
  /** Run the seed as the image runs it, with an `ldbadd` that keeps what it was given. */
  function seed(dir: string, env: Record<string, string>): string {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, 'ldbadd'),
      '#!/bin/sh\ncat "$3" >> "$(dirname "$2")/added.ldif"\n',
      {
        mode: 0o755,
      },
    );
    const script = path.join(dir, 'ad-seed.sh');
    fs.writeFileSync(script, AD_SEED);
    const run = spawnSync('sh', [script], {
      env: {
        ...process.env,
        PATH: `${bin}:${String(process.env.PATH)}`,
        HOUSTON_AD_PRIVATE: dir,
        HOUSTON_LDAP_BASE_DN: 'DC=example,DC=com',
        HOUSTON_LDAP_DOMAIN: 'example.com',
        HOUSTON_LDAP_GROUPS: 'off',
        HOUSTON_LDAP_SERVICE: 'off',
        ...env,
      },
      encoding: 'utf8',
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    return fs.readFileSync(path.join(dir, 'added.ldif'), 'utf8');
  }

  /** The values of one attribute of one entry. */
  function values(ldif: string, dn: string, attribute: string): string[] {
    const entry = ldif.split('\n\n').find((block) => block.startsWith(`dn: ${dn}\n`)) ?? '';
    return entry
      .split('\n')
      .filter((line) => line.startsWith(`${attribute}: `) || line.startsWith(`${attribute}:: `))
      .map((line) => line.slice(line.indexOf(' ') + 1));
  }

  it("gives each user AD's unicodePwd: the password quoted, UTF-16LE, base64", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-ad-'));
    try {
      const ldif = seed(dir, { HOUSTON_LDAP_USERS: '12', HOUSTON_LDAP_SERVICE: 'on' });
      for (const [name, parent] of [
        ['user1', 'OU=Users'],
        ['user12', 'OU=Users'],
        ['readonly', 'CN=Users'],
      ]) {
        const dn = `CN=${String(name)},${String(parent)},DC=example,DC=com`;
        expect(values(ldif, dn, 'unicodePwd')).toEqual([
          Buffer.from(`"${String(name)}"`, 'utf16le').toString('base64'),
        ]);
        expect(values(ldif, dn, 'userPrincipalName')).toEqual([`${String(name)}@example.com`]);
        expect(values(ldif, dn, 'userAccountControl')).toEqual(['512']);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('nests rocket-chat > staff > all but the last user, and seeds once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-ad-'));
    try {
      const env = { HOUSTON_LDAP_USERS: '4', HOUSTON_LDAP_GROUPS: 'on' };
      const ldif = seed(dir, env);
      const group = (cn: string) => values(ldif, `CN=${cn},OU=Groups,DC=example,DC=com`, 'member');
      const users = (...n: number[]) =>
        n.map((i) => `CN=user${String(i)},OU=Users,DC=example,DC=com`);
      expect(group('rocket-chat')).toEqual(['CN=staff,OU=Groups,DC=example,DC=com']);
      expect(group('staff')).toEqual(users(1, 2, 3));
      expect(group('rocket-admin')).toEqual(users(1));
      expect(group('employee')).toEqual(users(1, 2, 3, 4));
      // A restart runs the seed again; the directory is already there, so nothing is added.
      expect(seed(dir, env)).toBe(ldif);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('--set idp=saml|oidc', () => {
  type Realm = {
    users: unknown[];
    clients: { clientId: string }[];
    requiredActions?: { alias: string; defaultAction: boolean }[];
    components: Record<
      string,
      {
        config: Record<string, string[]>;
        subComponents: Record<string, { name: string; config: Record<string, string[]> }[]>;
      }[]
    >;
  };
  const realmOf = (preset: Preset): Realm =>
    JSON.parse(
      (preset.files.find(([file]) => file === 'ldap/keycloak-realm.json') as [string, string])[1],
    ) as Realm;
  const directoryOf = (realm: Realm) =>
    realm.components[
      'org.keycloak.storage.UserStorageProvider'
    ]?.[0] as Realm['components'][string][number];
  const mapper = (realm: Realm, name: string) =>
    directoryOf(realm).subComponents['org.keycloak.storage.ldap.mappers.LDAPStorageMapper']?.find(
      (m) => m.name === name,
    )?.config;

  it('puts a Keycloak federating the directory in front, with no users of its own', () => {
    const preset = load('ldap', { idp: 'saml' });
    expect(Object.keys(preset.services)).toEqual(['openldap', 'phpldapadmin', 'keycloak']);
    expect(preset.dependsOn).toEqual(['openldap', 'keycloak']);
    expect(preset.ports).toEqual([8082, 8081]);
    const realm = realmOf(preset);
    expect(realm.users).toEqual([]);
    expect(realm.clients.map((client) => client.clientId)).toEqual(['houston-saml-sp']);
    expect(directoryOf(realm).config).toMatchObject({
      vendor: ['other'],
      connectionUrl: ['ldap://openldap:389'],
      bindDn: ['cn=admin,dc=example,dc=com'],
      usernameLDAPAttribute: ['uid'],
      editMode: ['READ_ONLY'],
    });
    // A realm import creates no mappers, so the username one has to be there.
    expect(mapper(realm, 'username')).toMatchObject({ 'ldap.attribute': ['uid'] });
    expect(mapper(realm, 'groups')).toMatchObject({ 'membership.ldap.attribute': ['memberUid'] });
    // Rocket.Chat keeps its LDAP login and gains SAML, with the IdP's certificate fetched.
    expect(preset.env).toMatchObject({
      OVERWRITE_SETTING_LDAP_Enable: 'true',
      OVERWRITE_SETTING_SAML_Custom_Default_entry_point:
        'http://localhost:8081/realms/houston/protocol/saml',
    });
    expect(preset.postReady.map((step) => step.action)).toEqual([
      'saml_idp_cert',
      'keycloak_master_ssl_off',
    ]);
  });

  it("follows the AD flavour's attributes and nesting, and asks for TOTP with mfa=on", () => {
    const kube = resolve('ldap', 'kubernetes', { directory: 'ad', idp: 'oidc', mfa: 'on' });
    const docs = kube.kubernetesManifests.flatMap((manifest) => safeLoadAll(manifest)) as {
      kind: string;
      metadata: { name: string };
      data?: Record<string, string>;
    }[];
    const realmText = docs.find((doc) => doc.metadata.name === 'keycloak-realm')?.data?.[
      'houston-realm.json'
    ];
    const realm = JSON.parse(String(realmText)) as Realm;
    expect(directoryOf(realm).config).toMatchObject({
      vendor: ['ad'],
      connectionUrl: ['ldap://samba-ad:389'],
      usernameLDAPAttribute: ['sAMAccountName'],
      uuidLDAPAttribute: ['objectGUID'],
    });
    expect(mapper(realm, 'groups')).toMatchObject({
      'user.roles.retrieve.strategy': ['LOAD_GROUPS_BY_MEMBER_ATTRIBUTE_RECURSIVELY'],
    });
    expect(realm.requiredActions).toEqual([
      expect.objectContaining({ alias: 'CONFIGURE_TOTP', defaultAction: true }),
    ]);
    expect(realm.clients.map((client) => client.clientId)).toEqual(['rc-oidc']);
    expect(docs.map((doc) => `${doc.kind}/${doc.metadata.name}`)).toEqual(
      expect.arrayContaining(['Deployment/samba-ad', 'Deployment/keycloak', 'Service/keycloak']),
    );
    expect(kube.ports).toEqual([8082, 8085]);
    expect(kube.postReady.map((step) => step.action)).toEqual([
      'keycloak_master_ssl_off',
      'create_oauth_provider',
    ]);
    expect(kube.notes.join('\n')).toContain('127.0.0.1  keycloak');
  });

  it('refuses mfa without an IdP, and a second Keycloak beside the saml preset', () => {
    expect(() => load('ldap', { mfa: 'on' })).toThrow('add --set idp=saml or idp=oidc');
    expect(() => loadMany(['ldap', 'saml'], { ldap: { idp: 'saml' } }, 'docker')).toThrow(
      'both define the service "keycloak"',
    );
    expect(load('ldap', { idp: 'none', mfa: 'off' })).toEqual(load('ldap', {}));
  });
});

describe("the directory's browser", () => {
  // osixia/phpldapadmin:0.9.0 shipped phpLDAPadmin 1.2.5 on a PHP nobody patches any more;
  // phpLDAPadmin 2.3.12 is the security release on PHP 8.4.27.
  const IMAGE = 'phpldapadmin/phpldapadmin:2.3.12';

  it('is the maintained phpLDAPadmin on both runtimes, signed in to with the admin DN', () => {
    const compose = load('ldap', {});
    expect(compose.services.phpldapadmin?.image).toBe(IMAGE);
    expect(compose.services.phpldapadmin?.environment).toEqual({
      LDAP_HOST: 'openldap',
      LDAP_BASE_DN: 'dc=example,dc=com',
      LDAP_USERNAME: 'cn=admin,dc=example,dc=com',
      LDAP_PASSWORD: 'admin',
      // The notes say "log in with DN"; 2.x defaults to uid, and to posixAccount entries.
      LDAP_LOGIN_ATTR: 'dn',
      LDAP_LOGIN_ATTR_DESC: 'Login DN',
      LDAP_LOGIN_OBJECTCLASS: 'organizationalRole',
    });
    const docs = resolve('ldap', 'kubernetes', {}).kubernetesManifests.flatMap((m) =>
      safeLoadAll(m),
    ) as {
      kind: string;
      metadata: { name: string };
      spec: { template: { spec: { containers: Record<string, unknown>[] } } };
    }[];
    const ui = docs.find((d) => d.kind === 'Deployment' && d.metadata.name === 'phpldapadmin')!;
    const container = ui.spec.template.spec.containers[0] as {
      image: string;
      env: { name: string; value: string }[];
      ports: { containerPort: number }[];
      readinessProbe: { httpGet: { path: string; port: number } };
    };
    expect(container.image).toBe(IMAGE);
    expect(Object.fromEntries(container.env.map((e) => [e.name, e.value]))).toEqual(
      compose.services.phpldapadmin?.environment,
    );
    // It runs as www-data, on 8080; `/` answers a redirect, so readiness asks Laravel's /up.
    expect(container.ports).toEqual([{ containerPort: 8080 }]);
    expect(container.readinessProbe.httpGet).toEqual({ path: '/up', port: 8080 });
  });

  it('never ships the old image, in any flavour or combination', () => {
    for (const params of [{}, { directory: 'ad' }, { tls: 'ldaps' }, { idp: 'saml' }]) {
      for (const runtime of ['docker', 'kubernetes'] as const) {
        const text = JSON.stringify(resolve('ldap', runtime, params));
        expect(text).not.toContain('osixia/phpldapadmin');
        expect(text).not.toContain('PHPLDAPADMIN_');
      }
    }
  });
});

describe("the administrator's entry", () => {
  // osixia makes cn=admin the root account and, seeded from custom LDIF, never creates its
  // entry. phpLDAPadmin 2 then refused the documented sign-in: "Authentication succeeded, but
  // the DN doesnt exist ... rootdn to login (not supported)" (live, k3s, 2026-10-28).
  const ENTRY =
    'dn: cn=admin,dc=example,dc=com\nobjectClass: simpleSecurityObject\n' +
    'objectClass: organizationalRole\ncn: admin\nuserPassword: admin\n';

  it('is seeded first, with the class phpLDAPadmin admits, on both runtimes', () => {
    expect(ldifOf(load('ldap', {})).startsWith(ENTRY)).toBe(true);
    const cm = resolve('ldap', 'kubernetes', {})
      .kubernetesManifests.flatMap((m) => safeLoadAll(m))
      .find((d) => (d as { kind: string }).kind === 'ConfigMap') as {
      data: Record<string, string>;
    };
    expect(Object.values(cm.data).some((text) => text.startsWith(ENTRY))).toBe(true);
    expect(load('ldap', {}).services.phpldapadmin?.environment).toMatchObject({
      LDAP_LOGIN_OBJECTCLASS: 'organizationalRole',
    });
  });

  it('is generated too, for a directory too large to ship', () => {
    expect(GENERATOR).toContain('-v admin="$LDAP_ADMIN_PASSWORD"');
    expect(GENERATOR).toContain('dn: cn=admin,%s\\nobjectClass: simpleSecurityObject');
  });

  it("is followed by the delete of the image's own empty ou=people, shipped and generated", () => {
    // The image seeds ou=people beside ou=groups; houston's users are in ou=Users, so every
    // tree showed an empty second people branch (live, Docker lane VD, 2026-10-28).
    const gone = 'dn: ou=people,dc=example,dc=com\nchangetype: delete\n';
    expect(ldifOf(load('ldap', {})).startsWith(`${ENTRY}\n${gone}\n`)).toBe(true);
    expect(GENERATOR).toContain('printf "dn: ou=people,%s\\nchangetype: delete\\n\\n", base');
  });
});

describe('the directory itself', () => {
  // osixia/openldap:1.5.0 is OpenLDAP 2.4.57 on Debian 10 (both past end of life, last built
  // February 2021); its replacement keeps osixia's environment and is pinned by digest.
  const PINNED = /^ghcr\.io\/intechcore\/openldap:2\.6\.\d+-\d+@sha256:[0-9a-f]{64}$/u;

  it('is a maintained OpenLDAP 2.6, pinned by digest, seeded from /bootstrap on both runtimes', () => {
    for (const users of ['5', '600']) {
      const compose = load('ldap', { users });
      const slapd = compose.services.openldap as { image: string; command?: unknown };
      expect(slapd.image).toMatch(PINNED);
      // The image's own CMD (`slapd`) applies /bootstrap; osixia's --copy-service is gone.
      expect(slapd.command).toBeUndefined();
      const deployment = resolve('ldap', 'kubernetes', { users })
        .kubernetesManifests.flatMap((m) => safeLoadAll(m))
        .find(
          (d) =>
            (d as { kind: string }).kind === 'Deployment' &&
            (d as { metadata: { name: string } }).metadata.name === 'openldap',
        ) as { spec: { template: { spec: { containers: Record<string, unknown>[] } } } };
      const container = deployment.spec.template.spec.containers[0] as {
        image: string;
        args?: unknown;
        volumeMounts: { mountPath: string }[];
      };
      expect(container.image).toBe(slapd.image);
      expect(container.args).toBeUndefined();
      if (users === '5') {
        expect(container.volumeMounts.map((m) => m.mountPath)).toContain(
          '/bootstrap/50-rc-users.ldif',
        );
      }
    }
  });

  it('never ships osixia/openldap, in any flavour or combination', () => {
    for (const params of [
      {},
      { tls: 'ldaps' },
      { tls: 'starttls' },
      { bind: 'service' },
      { users: '600' },
    ]) {
      for (const runtime of ['docker', 'kubernetes'] as const) {
        const text = JSON.stringify(resolve('ldap', runtime, params));
        expect(text).not.toContain('osixia/openldap');
        expect(text).not.toContain('--copy-service');
        expect(text).not.toContain('/container/service/slapd');
      }
    }
  });
});

describe('a re-up that changes the directory seed', () => {
  // slapd reads its seed once and keeps its entries in the pod, and a ConfigMap edit restarts
  // nothing: a Kubernetes re-up with `--set users=9` recorded 9 and kept serving 5 (live
  // 2026-10-31). The pod template carries the seed's hash, so a changed seed rolls it.
  const seedOf = (params: Record<string, unknown>): string | undefined => {
    const docs = resolve('ldap', 'kubernetes', params).kubernetesManifests.flatMap((manifest) =>
      safeLoadAll(manifest),
    ) as {
      kind: string;
      metadata: { name: string };
      spec?: { template: { metadata: { annotations?: Record<string, string> } } };
    }[];
    // The directory's own Deployment: `openldap`, or AD's Samba.
    const deployment = docs.find(
      (d) => d.kind === 'Deployment' && d.metadata.name !== 'phpldapadmin',
    );
    if (deployment === undefined) throw new Error('no directory Deployment');
    return deployment.spec?.template.metadata.annotations?.['houston.io/seed'];
  };

  it('rolls the directory when the seed changes, and only then', () => {
    expect(seedOf({})).toBeUndefined();
    expect(seedOf({ users: '5' })).toBeUndefined();
    const nine = seedOf({ users: '9' });
    expect(nine).toMatch(/^[0-9a-f]{16}$/u);
    expect(seedOf({ users: '9' })).toBe(nine);
    expect(seedOf({ groups: 'on' })).not.toBe(nine);
    expect(seedOf({ groups: 'on' })).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('leaves AD and a generated directory alone, whose counts already roll them', () => {
    // Their seeds are fixed scripts: a stamp would be one constant, rolling a 2.1.6 workspace
    // once for nothing -- and an AD rolled re-provisions with new objectGUIDs (review 2026-10-31).
    expect(seedOf({ directory: 'ad' })).toBeUndefined();
    expect(seedOf({ directory: 'ad', users: '9' })).toBeUndefined();
    expect(seedOf({ users: '600' })).toBeUndefined();
  });
});
