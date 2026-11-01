/**
 * Dynamic `ldap` preset: an OpenLDAP directory seeded with N users + a group, with
 * Rocket.Chat wired to authenticate against it.
 *
 * The only preset that is a SCENARIO -- one deployment-neutral intent with a Compose adapter
 * and a Kubernetes adapter, rather than one Preset carrying both renderings the way `saml`
 * and `oidc` do.
 *
 * Parameters (via `--set`):
 *   users   number of LDAP users to generate (default 5). Set high (e.g. 130000) to
 *           reproduce LDAP-sync scale/performance issues.
 *   domain  LDAP domain (default example.com) -> base DN dc=example,dc=com.
 *   directory  'ad' serves the users from Samba as Active Directory instead (`AD_SEED`).
 *   idp     'saml' or 'oidc' adds a Keycloak that federates this directory (`federation`),
 *           so the same users also sign in by SSO; `mfa=on` makes it ask for TOTP.
 *
 * Every user `userN` has password `userN`, so you can log in immediately as `user1` /
 * `user1`. The local admin (admin/admin123) still works via LDAP_Login_Fallback, so
 * houston's own API/token calls keep functioning.
 */
import { createHash } from 'node:crypto';

import type { PortMap } from '../config';

import { EMAIL_2FA, choiceParam, intParam, presetPort, safeDump, strParam } from './common';
import { guide, type PresetGuide } from './guides';
import * as keycloak from './keycloak';
import { type Params, register, registerScenario } from './registry';
import { Scenario } from './scenario';
import { emptyPreset, type Preset } from './types';

/**
 * phpLDAPadmin's host port in this workspace (`ports` over the ONE registry both runtimes
 * read). Compose publishes it directly; Kubernetes declares it on the Service (see
 * `UI_PORT_LABEL`) and the lifecycle forwards it. Same number either way, so a ticket's
 * instructions do not depend on where the workspace happens to run.
 */
function uiPortOf(ports: PortMap): number {
  return presetPort('ldap', 0, ports);
}

/**
 * phpLDAPadmin 2, the maintained line (amd64/arm64). osixia/phpldapadmin:0.9.0 shipped 1.2.5
 * on a PHP nobody patches any more; 2.3.12 is the security release built on PHP 8.4.27.
 */
const UI_IMAGE = 'phpldapadmin/phpldapadmin:2.3.12';

/** What it listens on inside: it runs as www-data, so not 80. */
export const UI_CONTAINER_PORT = 8080;

/**
 * A Service wearing this label is published on the host port it names. One convention for
 * every scenario, so the four presets still to be adapted need no new mechanism -- and no
 * second place to declare a port that could disagree with `config.PRESET_PORTS`.
 */
export const UI_PORT_LABEL = 'houston.io/ui-port';

/**
 * OpenLDAP 2.6 LTS (Symas packages, Debian 13), amd64/arm64: a maintained drop-in for
 * osixia/openldap:1.5.0, whose OpenLDAP 2.4.57 and Debian 10 are both past end of life. The
 * same environment drives it, read-only user included. Pinned by digest: one small publisher,
 * and a moved tag would change the directory under a ticket.
 */
const DIRECTORY_IMAGE =
  'ghcr.io/intechcore/openldap:2.6.16-1@sha256:04a95ae6131d8f21ee15b025c2dc7318c2922c9249fa469c7a780cceddba06f1';

/** The image applies every LDIF here on first boot (`ldapadd -c`: existing entries skipped). */
const BOOTSTRAP_PATH = '/bootstrap/50-rc-users.ldif';
const GROUP_CN = 'rc-users';
const GID = '5000';
const PARAMS_HELP: Readonly<Record<string, string>> = Object.freeze({
  users: 'number of LDAP users to generate (default 5; try 130000 for scale)',
  domain: 'LDAP domain (default example.com)',
  groups:
    "'on' adds groups rocket-chat (every user but the last), rocket-admin (user1) and " +
    'employee (everyone), and lets only rocket-chat log in (default off)',
  bind:
    "'service' binds Rocket.Chat as a read-only directory user, whom slapd limits to 500 " +
    "entries per search, as many real directories do (default 'admin', unlimited)",
  tls:
    "'ldaps' (port 636) or 'starttls' (389), with a certificate from houston's own CA " +
    '(default none)',
  trust:
    "'none' leaves houston's CA out of Rocket.Chat, to reproduce a certificate error " +
    "(default 'houston')",
  directory:
    "'ad' serves the same users from Samba as Active Directory: sAMAccountName, " +
    "objectGUID, nested groups (default 'openldap')",
  idp:
    "'saml' or 'oidc' puts Keycloak in front of this directory, so the same users also " +
    'sign in by SSO (default none)',
  mfa: "'on' has Keycloak ask for a one-time code at SSO sign-in; needs idp (default off)",
  idp_host:
    'with idp: hostname your browser reaches Keycloak on (default as the saml and oidc ' +
    'presets: localhost, or keycloak for oidc)',
});

/** Where the image reads its TLS files, in place, by the names `slapdEnv` gives them. */
const CERTS_DIR = '/container/certs';
const CERT_FILES = ['ldap.crt', 'ldap.key', 'ca.crt'] as const;
/** The Kubernetes Secret `withCertificate` adds and the Deployment mounts. */
const TLS_SECRET = 'openldap-tls';

/** The groups `--set groups=on` adds, beside `rc-users`; each with its gidNumber. */
const LAB_GROUPS: readonly (readonly [string, string])[] = [
  ['rocket-chat', '5001'],
  ['rocket-admin', '5002'],
  ['employee', '5003'],
];

/**
 * Past this many users the LDIF is generated inside the container rather than shipped: a
 * thousand users is 272 KB, past the 256 KiB a ConfigMap applied client-side can carry, and
 * 130,000 is 37.7 MB. Below it nothing changes, so every existing workspace builds as before.
 */
export const SHIPPED_USERS_MAX = 500;

/** The generator, an sh + awk transcription of `ldif()`; a spec holds the two byte-equal. */
export const GENERATOR = String.raw`#!/bin/sh
# The directory houston would ship as LDIF, generated here instead: past a few hundred users
# the file outgrows a Kubernetes ConfigMap. Byte for byte the LDIF houston writes for the
# same parameters, users first, then rc-users, then the lab groups when asked for.
set -eu
awk -v n="$HOUSTON_LDAP_USERS" -v base="$HOUSTON_LDAP_BASE_DN" -v domain="$HOUSTON_LDAP_DOMAIN" \
    -v groups="$HOUSTON_LDAP_GROUPS" -v admin="$LDAP_ADMIN_PASSWORD" '
function group(cn, gid, first, last,    i) {
  printf "\ndn: cn=%s,ou=groups,%s\nobjectClass: top\nobjectClass: posixGroup\ncn: %s\ngidNumber: %s\n", cn, base, cn, gid
  for (i = first; i <= last; i++) printf "memberUid: user%d\n", i
}
BEGIN {
  printf "dn: cn=admin,%s\nobjectClass: simpleSecurityObject\nobjectClass: organizationalRole\ncn: admin\nuserPassword: %s\n\n", base, admin
  printf "dn: ou=people,%s\nchangetype: delete\n\n", base
  printf "dn: ou=Users,%s\nobjectClass: organizationalUnit\nou: Users\n\n", base
  printf "dn: ou=groups,%s\nobjectClass: organizationalUnit\nou: groups\n\n", base
  for (i = 1; i <= n; i++) {
    printf "dn: uid=user%d,ou=Users,%s\nobjectClass: inetOrgPerson\nobjectClass: posixAccount\n", i, base
    printf "cn: User %d\nsn: %d\nuid: user%d\nuidNumber: %d\ngidNumber: 5000\n", i, i, i, 1000 + i
    printf "homeDirectory: /home/user%d\nmail: user%d@%s\nuserPassword: user%d\n\n", i, i, domain, i
  }
  printf "dn: cn=rc-users,ou=groups,%s\nobjectClass: top\nobjectClass: posixGroup\ncn: rc-users\ngidNumber: 5000\n", base
  for (i = 1; i <= n; i++) printf "memberUid: user%d\n", i
  if (groups == "on") {
    group("rocket-chat", 5001, 1, n - 1)
    group("rocket-admin", 5002, 1, n < 1 ? 0 : 1)
    group("employee", 5003, 1, n)
  }
  printf "\n"
}' > "$1"
`;

const GENERATOR_PATH = '/houston/gen-users.sh';
/** Generate the directory, then hand over to the image's own entrypoint, as its CMD does. */
const GENERATE_THEN_RUN = `sh ${GENERATOR_PATH} ${BOOTSTRAP_PATH} && exec /usr/local/bin/docker-entrypoint.sh slapd`;

function generated(it: LDAPIntent): boolean {
  return it.users > SHIPPED_USERS_MAX;
}

/** What the generator reads: the same intent `ldif()` renders. */
function generatorEnv(it: LDAPIntent): Record<string, string> {
  return {
    HOUSTON_LDAP_USERS: String(it.users),
    HOUSTON_LDAP_BASE_DN: it.baseDn,
    HOUSTON_LDAP_DOMAIN: it.domain,
    HOUSTON_LDAP_GROUPS: it.groups ? 'on' : 'off',
  };
}

/**
 * `--set directory=ad`: Samba answering as Active Directory, without the rest of a domain
 * controller. Pinned by digest because the image publishes only `latest`.
 */
const AD_IMAGE =
  'smblds/smblds@sha256:c9e6dedd718cc541ff5b14c7044fc14ce3d3a8789e4468552a9a17c24e118d62';
const AD_HOST = 'samba-ad';
/** The image's default, which provisioning holds to AD's complexity rules. */
const AD_ADMIN_PASSWORD = 'Passw0rd';
const AD_SEED_PATH = '/houston/ad-seed.sh';
const AD_CERTS_DIR = '/houston/certs';
/** AD's LDAP_MATCHING_RULE_IN_CHAIN: membership through any depth of nested groups. */
const IN_CHAIN = '1.2.840.113556.1.4.1941';

/**
 * The AD directory's seed, which the image runs after it provisions and before samba starts,
 * as it runs every executable in /entrypoint.d. Offline `ldbadd`, because one `samba-tool`
 * per user takes minutes; this way 1,600 users seed in 29 s and 20,000 in about five minutes
 * (measured). Users carry sAMAccountName, a UPN and `unicodePwd` (the password quoted,
 * UTF-16LE, base64, which awk computes itself). With groups=on, rocket-chat holds staff, which
 * holds every user but the last, so a login is allowed only through the nesting. Once only:
 * on a restart the directory is already there, and only houston's certificate is put back.
 */
export const AD_SEED = String.raw`#!/bin/sh
set -eu
PRIVATE=${'$'}{HOUSTON_AD_PRIVATE:-/var/lib/samba/private}
if [ -f /houston/certs/ldap.key ]; then
  # Samba serves LDAPS and StartTLS with these when they are there, and makes its own if not.
  mkdir -p "$PRIVATE/tls"
  install -m 0600 /houston/certs/ldap.key "$PRIVATE/tls/key.pem"
  install -m 0644 /houston/certs/ldap.crt "$PRIVATE/tls/cert.pem"
  install -m 0644 /houston/certs/ca.crt "$PRIVATE/tls/ca.pem"
fi
[ -f "$PRIVATE/houston-seeded" ] && exit 0
awk -v n="$HOUSTON_LDAP_USERS" -v base="$HOUSTON_LDAP_BASE_DN" -v domain="$HOUSTON_LDAP_DOMAIN" \
    -v groups="$HOUSTON_LDAP_GROUPS" -v service="$HOUSTON_LDAP_SERVICE" '
BEGIN {
  B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  for (c = 32; c < 127; c++) ORD[sprintf("%c", c)] = c
}
function pwd(p,    s, i, n, b, o, x) {
  s = "\"" p "\""; n = 0
  for (i = 1; i <= length(s); i++) { b[n++] = ORD[substr(s, i, 1)]; b[n++] = 0 }
  o = ""
  for (i = 0; i < n; i += 3) {
    x = b[i] * 65536 + (i + 1 < n ? b[i + 1] : 0) * 256 + (i + 2 < n ? b[i + 2] : 0)
    o = o substr(B64, int(x / 262144) % 64 + 1, 1) substr(B64, int(x / 4096) % 64 + 1, 1)
    o = o (i + 1 < n ? substr(B64, int(x / 64) % 64 + 1, 1) : "=")
    o = o (i + 2 < n ? substr(B64, x % 64 + 1, 1) : "=")
  }
  return o
}
function user(name, parent, given, sn) {
  printf "dn: CN=%s,%s,%s\nobjectClass: user\nsAMAccountName: %s\n", name, parent, base, name
  printf "userPrincipalName: %s@%s\ngivenName: %s\nsn: %s\n", name, domain, given, sn
  printf "displayName: %s %s\nmail: %s@%s\n", given, sn, name, domain
  printf "userAccountControl: 512\nunicodePwd:: %s\n\n", pwd(name)
}
function group(cn, first, last,    i) {
  printf "dn: CN=%s,OU=Groups,%s\nobjectClass: group\nsAMAccountName: %s\n", cn, base, cn
  for (i = first; i <= last; i++) printf "member: CN=user%d,OU=Users,%s\n", i, base
  printf "\n"
}
BEGIN {
  printf "dn: OU=Users,%s\nobjectClass: organizationalUnit\nou: Users\n\n", base
  printf "dn: OU=Groups,%s\nobjectClass: organizationalUnit\nou: Groups\n\n", base
  for (i = 1; i <= n; i++) user("user" i, "OU=Users", "User", i)
  if (service == "on") user("readonly", "CN=Users", "Read", "Only")
  group("rc-users", 1, n)
  if (groups == "on") {
    group("staff", 1, n - 1)
    printf "dn: CN=rocket-chat,OU=Groups,%s\nobjectClass: group\n", base
    printf "sAMAccountName: rocket-chat\nmember: CN=staff,OU=Groups,%s\n\n", base
    group("rocket-admin", 1, n < 1 ? 0 : 1)
    group("employee", 1, n)
  }
}' > "$PRIVATE/houston-seed.ldif"
ldbadd -H "$PRIVATE/sam.ldb" "$PRIVATE/houston-seed.ldif" > /dev/null
rm -f "$PRIVATE/houston-seed.ldif"
touch "$PRIVATE/houston-seeded"
`;

/** Put the seed where the image runs it (a workspace's files are 0644), then start as it does. */
const INSTALL_SEED_THEN_RUN =
  `install -m 0755 ${AD_SEED_PATH} /entrypoint.d/50-houston-seed && ` +
  'exec /sbin/tini -g -- /entrypoint.sh';

function isAd(it: LDAPIntent): boolean {
  return it.directory === 'ad';
}

/** The service Rocket.Chat dials, phpLDAPadmin reads and the certificate is issued for. */
function hostOf(it: LDAPIntent): string {
  return isAd(it) ? AD_HOST : 'openldap';
}

/** The directory's administrator, as phpLDAPadmin is signed in to: a DN and its password. */
function adminLogin(it: LDAPIntent): [string, string] {
  return isAd(it)
    ? [`CN=Administrator,CN=Users,${it.baseDn}`, AD_ADMIN_PASSWORD]
    : [`cn=admin,${it.baseDn}`, it.adminPassword];
}

/** phpLDAPadmin 2's settings, one source for both runtimes. */
function uiEnv(it: LDAPIntent): Record<string, string> {
  const [dn, password] = adminLogin(it);
  return {
    LDAP_HOST: hostOf(it),
    LDAP_BASE_DN: it.baseDn,
    // The bind it reads the schema with before anyone has signed in: the same throwaway
    // admin the notes print, on a directory reachable only inside the workspace.
    LDAP_USERNAME: dn,
    LDAP_PASSWORD: password,
    // Signed in with the whole DN, as the notes and the guide say (2.x defaults to uid)...
    LDAP_LOGIN_ATTR: 'dn',
    LDAP_LOGIN_ATTR_DESC: 'Login DN',
    // ...and only an entry of these classes may sign in (2.x defaults to posixAccount,
    // which neither administrator is).
    LDAP_LOGIN_OBJECTCLASS: isAd(it) ? 'user' : 'organizationalRole',
    // Samba has no entryUUID; AD names its entries by objectGUID.
    ...(isAd(it) ? { LDAP_GUIDKEY: 'objectguid' } : {}),
  };
}

/** The image's environment, and what the seed reads. */
function adEnv(it: LDAPIntent): Record<string, string> {
  return {
    REALM: it.domain.toUpperCase(),
    DOMAIN: (it.domain.split('.')[0] ?? '').toUpperCase().slice(0, 15),
    ADMINPASS: AD_ADMIN_PASSWORD,
    // Simple binds over plain 389, as the openldap flavour allows, and passwords like user1.
    INSECURE_LDAP: 'true',
    INSECURE_PASSWORDSETTINGS: 'true',
    HOUSTON_LDAP_USERS: String(it.users),
    HOUSTON_LDAP_BASE_DN: it.baseDn,
    HOUSTON_LDAP_DOMAIN: it.domain,
    HOUSTON_LDAP_GROUPS: it.groups ? 'on' : 'off',
    HOUSTON_LDAP_SERVICE: it.bind === 'service' ? 'on' : 'off',
  };
}

/**
 * Keycloak's LDAP user federation for this directory (`--set idp=saml|oidc`): the users sign
 * in at Keycloak with their directory password, and Keycloak hands Rocket.Chat a SAML or OIDC
 * login for them. Read-only, imported on first sign-in. The attribute mappers are written out
 * because a realm import creates none (measured: every login failed with "User returned from
 * LDAP has null username"), and the group mapper shows the directory's groups in Keycloak,
 * through AD's nesting where there is one. Keycloak dials the directory over plain 389, which
 * both flavours serve whatever `tls` is.
 */
function federation(it: LDAPIntent): Record<string, unknown> {
  const ad = isAd(it);
  const [bindDn, bindCredential] = bindOf(it);
  const attribute = (name: string, ldap: string, model: string): Record<string, unknown> => ({
    name,
    providerId: 'user-attribute-ldap-mapper',
    config: {
      'ldap.attribute': [ldap],
      'user.model.attribute': [model],
      'read.only': ['true'],
      'always.read.value.from.ldap': ['true'],
      'is.mandatory.in.ldap': [model === 'email' ? 'false' : 'true'],
    },
  });
  const groups = {
    name: 'groups',
    providerId: 'group-ldap-mapper',
    config: {
      'groups.dn': [ad ? `OU=Groups,${it.baseDn}` : `ou=groups,${it.baseDn}`],
      'group.name.ldap.attribute': ['cn'],
      'group.object.classes': [ad ? 'group' : 'posixGroup'],
      'preserve.group.inheritance': [ad ? 'true' : 'false'],
      'membership.ldap.attribute': [ad ? 'member' : 'memberUid'],
      'membership.attribute.type': [ad ? 'DN' : 'UID'],
      'membership.user.ldap.attribute': [ad ? 'sAMAccountName' : 'uid'],
      'user.roles.retrieve.strategy': [
        ad ? 'LOAD_GROUPS_BY_MEMBER_ATTRIBUTE_RECURSIVELY' : 'LOAD_GROUPS_BY_MEMBER_ATTRIBUTE',
      ],
      mode: ['READ_ONLY'],
      'groups.path': ['/'],
      'ignore.missing.groups': ['false'],
      'drop.non.existing.groups.during.sync': ['false'],
    },
  };
  return {
    'org.keycloak.storage.UserStorageProvider': [
      {
        name: 'directory',
        providerId: 'ldap',
        config: {
          enabled: ['true'],
          vendor: [ad ? 'ad' : 'other'],
          connectionUrl: [`ldap://${hostOf(it)}:389`],
          usersDn: [ad ? `OU=Users,${it.baseDn}` : `ou=Users,${it.baseDn}`],
          bindDn: [bindDn],
          bindCredential: [bindCredential],
          authType: ['simple'],
          usernameLDAPAttribute: [ad ? 'sAMAccountName' : 'uid'],
          rdnLDAPAttribute: [ad ? 'cn' : 'uid'],
          uuidLDAPAttribute: [ad ? 'objectGUID' : 'entryUUID'],
          userObjectClasses: [
            ad ? 'person, organizationalPerson, user' : 'inetOrgPerson, posixAccount',
          ],
          searchScope: ['2'],
          editMode: ['READ_ONLY'],
          importEnabled: ['true'],
          syncRegistrations: ['false'],
          trustEmail: ['true'],
          pagination: ['true'],
        },
        subComponents: {
          'org.keycloak.storage.ldap.mappers.LDAPStorageMapper': [
            attribute('username', ad ? 'sAMAccountName' : 'uid', 'username'),
            attribute('email', 'mail', 'email'),
            attribute('first name', ad ? 'givenName' : 'cn', 'firstName'),
            attribute('last name', 'sn', 'lastName'),
            groups,
          ],
        },
      },
    ],
  };
}

/** Everything `idp` adds: Keycloak, its realm, Rocket.Chat's SSO settings, and how to use it. */
interface IdpParts {
  readonly port: number;
  readonly realm: string;
  readonly env: Record<string, string>;
  readonly postReady: Record<string, unknown>[];
  readonly notes: string[];
}

/** `ports`: the workspace's, so ldap's own Keycloak takes the saml or oidc port it was given. */
function idpParts(it: LDAPIntent, ports: PortMap): IdpParts | null {
  if (it.idp === 'none') return null;
  const port = presetPort(it.idp, 0, ports);
  const host = `http://${it.idpHost}:${String(port)}`;
  const realmBase = `${host}/realms/${keycloak.REALM}`;
  const saml = it.idp === 'saml';
  const extra = {
    components: federation(it),
    ...(it.mfa
      ? {
          // A default action is added to every user Keycloak creates, imported ones included
          // (measured: the first sign-in answers "Account is not fully set up").
          requiredActions: [
            {
              alias: 'CONFIGURE_TOTP',
              name: 'Configure OTP',
              providerId: 'CONFIGURE_TOTP',
              enabled: true,
              defaultAction: true,
              priority: 10,
              config: {},
            },
          ],
        }
      : {}),
  };
  const client = saml ? keycloak.samlClient() : keycloak.oidcClient(it.idpHost, port);
  const realm = keycloak.realmJson([client], 0, '', extra);
  const setting = `Accounts_OAuth_Custom-${keycloak.capitalize(keycloak.OIDC_PROVIDER)}`;
  const [oidcEnv, oidcSettings] = keycloak.oauthSettings(realmBase, setting);
  const button = saml ? 'Keycloak SSO' : 'Keycloak (OIDC)';
  return {
    port,
    realm,
    env: saml ? keycloak.samlSettings(`${realmBase}/protocol/saml`) : oidcEnv,
    postReady: saml
      ? [
          {
            action: 'saml_idp_cert',
            descriptor_url: `http://localhost:${String(port)}/realms/${keycloak.REALM}/protocol/saml/descriptor`,
            setting: 'SAML_Custom_Default_cert',
            enable_setting: 'SAML_Custom_Default',
          },
          { action: 'keycloak_master_ssl_off', service: 'keycloak' },
        ]
      : [
          { action: 'keycloak_master_ssl_off', service: 'keycloak', port },
          {
            action: 'create_oauth_provider',
            name: keycloak.capitalize(keycloak.OIDC_PROVIDER),
            settings: oidcSettings,
          },
        ],
    notes: [
      // One string per point: the GUI reads a line indented by four spaces as something to
      // paste, and wrapped prose written that way came out as a row of Copy boxes.
      `SSO: Keycloak signs in this directory's users. Click '${button}' and sign in as user1 / user1, the same user LDAP login uses; Rocket.Chat matches the two by email.`,
      ...(it.mfa
        ? ['Keycloak asks each user to set up an authenticator app at their first sign-in.']
        : []),
      ...(!saml && it.idpHost === 'keycloak'
        ? [
            'A browser on the machine running houston needs a hosts entry for Keycloak:',
            '    127.0.0.1  keycloak',
          ]
        : []),
      ...(it.idpHost === 'localhost' || it.idpHost === 'keycloak'
        ? [keycloak.FROM_ANOTHER_COMPUTER]
        : []),
      `Keycloak admin console: ${host}  (admin / admin, realm '${keycloak.REALM}'; the users are under User federation > directory)`,
    ],
  };
}

/** The image's read-only user (LDAP_READONLY_USER), for `--set bind=service`. */
const READONLY_USER = 'readonly';
const READONLY_PASSWORD = 'readonly';

type Bag = Record<string, unknown>;

/** Deployment-neutral LDAP intent shared by each native adapter. */
export interface LDAPIntent {
  readonly users: number;
  readonly domain: string;
  readonly baseDn: string;
  readonly adminPassword: string;
  /** `--set groups=on`: the lab groups and a group-restricted login. */
  readonly groups: boolean;
  /** `--set bind=service`: Rocket.Chat binds as the directory's read-only user, not the admin. */
  readonly bind: string;
  /** `--set tls=ldaps|starttls`: a certificate from houston's CA; `none` changes nothing. */
  readonly tls: string;
  /** `--set trust=none`: Rocket.Chat is not given that CA, and refuses the certificate. */
  readonly trust: string;
  /** `--set directory=ad`: Samba as Active Directory instead of OpenLDAP. */
  readonly directory: string;
  /** `--set idp=saml|oidc`: Keycloak federating this directory; `none` adds nothing. */
  readonly idp: string;
  /** `--set mfa=on`: Keycloak requires a TOTP authenticator at SSO sign-in. */
  readonly mfa: boolean;
  /** The hostname the browser reaches Keycloak on, as the saml/oidc presets' `idp_host`. */
  readonly idpHost: string;
}

function asParams(intent: LDAPIntent): Bag {
  // The two lab params only when set, so the default's params read as they always have.
  return {
    users: intent.users,
    domain: intent.domain,
    base_dn: intent.baseDn,
    ...(intent.groups ? { groups: 'on' } : {}),
    ...(intent.bind === 'service' ? { bind: 'service' } : {}),
    ...(intent.tls === 'none' ? {} : { tls: intent.tls, trust: intent.trust }),
    ...(intent.directory === 'ad' ? { directory: 'ad' } : {}),
    ...(intent.idp === 'none'
      ? {}
      : { idp: intent.idp, idp_host: intent.idpHost, ...(intent.mfa ? { mfa: 'on' } : {}) }),
  };
}

/** Which users each lab group holds: rocket-chat leaves the last one out, to be refused. */
function labMembers(group: string, users: number): number[] {
  const all = Array.from({ length: users }, (_, index) => index + 1);
  if (group === 'rocket-admin') return all.slice(0, 1);
  if (group === 'rocket-chat') return all.slice(0, Math.max(0, users - 1));
  return all;
}

/**
 * slapd makes `cn=admin,<base>` the root account, and neither osixia nor its replacement
 * creates its entry. phpLDAPadmin 1.2.5 signed in on the bind alone; 2.x looks the DN up and
 * refuses one that does not exist ("rootdn to login (not supported)"). Its classes are the ones
 * `LDAP_LOGIN_OBJECTCLASS` admits; Rocket.Chat's `(objectclass=inetOrgPerson)` never syncs it.
 */
function adminEntry(baseDn: string, password: string): string {
  return (
    `dn: cn=admin,${baseDn}\nobjectClass: simpleSecurityObject\n` +
    `objectClass: organizationalRole\ncn: admin\nuserPassword: ${password}\n`
  );
}

/**
 * The image seeds `ou=people` beside `ou=groups`, and houston's users live in `ou=Users`: an
 * empty second people branch in every tree. `ldapadd` honours an explicit changetype.
 */
function emptyPeopleGone(baseDn: string): string {
  return `dn: ou=people,${baseDn}\nchangetype: delete\n`;
}

function ldif(it: LDAPIntent): string {
  const { baseDn, domain, users } = it;
  const blocks = [
    adminEntry(baseDn, it.adminPassword),
    emptyPeopleGone(baseDn),
    `dn: ou=Users,${baseDn}\nobjectClass: organizationalUnit\nou: Users\n`,
    `dn: ou=groups,${baseDn}\nobjectClass: organizationalUnit\nou: groups\n`,
  ];
  for (let i = 1; i <= users; i += 1) {
    const uid = `user${String(i)}`;
    blocks.push(
      `dn: uid=${uid},ou=Users,${baseDn}\n` +
        'objectClass: inetOrgPerson\n' +
        'objectClass: posixAccount\n' +
        `cn: User ${String(i)}\n` +
        `sn: ${String(i)}\n` +
        `uid: ${uid}\n` +
        `uidNumber: ${String(1000 + i)}\n` +
        `gidNumber: ${GID}\n` +
        `homeDirectory: /home/${uid}\n` +
        `mail: ${uid}@${domain}\n` +
        `userPassword: ${uid}\n`,
    );
  }
  let members = '';
  for (let i = 1; i <= users; i += 1) members += `memberUid: user${String(i)}\n`;
  blocks.push(
    `dn: cn=${GROUP_CN},ou=groups,${baseDn}\n` +
      'objectClass: top\n' +
      'objectClass: posixGroup\n' +
      `cn: ${GROUP_CN}\n` +
      `gidNumber: ${GID}\n` +
      `${members}`,
  );
  if (it.groups) {
    for (const [cn, gid] of LAB_GROUPS) {
      blocks.push(
        `dn: cn=${cn},ou=groups,${baseDn}\n` +
          'objectClass: top\n' +
          'objectClass: posixGroup\n' +
          `cn: ${cn}\n` +
          `gidNumber: ${gid}\n` +
          labMembers(cn, users)
            .map((i) => `memberUid: user${String(i)}\n`)
            .join(''),
      );
    }
  }
  return `${blocks.join('\n')}\n`;
}

function intent(params: Params): LDAPIntent {
  const users = intParam(params, 'users', 5);
  const domain = strParam(params, 'domain', 'example.com');
  const directory = choiceParam(params, 'directory', ['openldap', 'ad']);
  const idp = choiceParam(params, 'idp', ['none', 'saml', 'oidc']);
  const mfa = choiceParam(params, 'mfa', ['off', 'on']) === 'on';
  if (mfa && idp === 'none') {
    throw new Error(
      '--set mfa=on is asked of Keycloak at SSO sign-in: add --set idp=saml or idp=oidc',
    );
  }
  // AD spells its naming attributes in capitals, and Rocket.Chat compares member DNs as text.
  const dc = directory === 'ad' ? 'DC' : 'dc';
  const baseDn = domain
    .split('.')
    .map((part) => `${dc}=${part}`)
    .join(',');
  return {
    users,
    domain,
    baseDn,
    adminPassword: 'admin',
    groups: choiceParam(params, 'groups', ['off', 'on']) === 'on',
    bind: choiceParam(params, 'bind', ['admin', 'service']),
    tls: choiceParam(params, 'tls', ['none', 'ldaps', 'starttls']),
    trust: choiceParam(params, 'trust', ['houston', 'none']),
    directory,
    idp,
    mfa,
    idpHost: strParam(params, 'idp_host', idp === 'oidc' ? 'keycloak' : 'localhost'),
  };
}

/** Rocket.Chat LDAP settings shared by Compose and Kubernetes. */
function envFor(it: LDAPIntent): Record<string, string> {
  if (isAd(it)) return adRocketChatEnv(it);
  return {
    OVERWRITE_SETTING_LDAP_Enable: 'true',
    // Generic OpenLDAP, NOT Active Directory. Without this, RC defaults to server type
    // "ad" and searches sAMAccountName instead of our uid field, so every LDAP login
    // fails with "User not found".
    OVERWRITE_SETTING_LDAP_Server_Type: '',
    OVERWRITE_SETTING_LDAP_Host: 'openldap',
    OVERWRITE_SETTING_LDAP_Port: '389',
    OVERWRITE_SETTING_LDAP_BaseDN: it.baseDn,
    OVERWRITE_SETTING_LDAP_Authentication: 'true',
    OVERWRITE_SETTING_LDAP_Authentication_UserDN: bindOf(it)[0],
    OVERWRITE_SETTING_LDAP_Authentication_Password: bindOf(it)[1],
    OVERWRITE_SETTING_LDAP_User_Search_Filter: '(objectclass=inetOrgPerson)',
    OVERWRITE_SETTING_LDAP_User_Search_Field: 'uid',
    OVERWRITE_SETTING_LDAP_User_Search_Scope: 'sub',
    OVERWRITE_SETTING_LDAP_Unique_Identifier_Field: 'uid',
    // Keep local login working so admin/admin123 (and houston's API) still work.
    OVERWRITE_SETTING_LDAP_Login_Fallback: 'true',
    // No SMTP in the repro, so email-2FA on a new LDAP user's first login would block it
    // with an OTP that goes nowhere. Turn it off so you can actually log in as
    // user1/user1.
    OVERWRITE_SETTING_Accounts_TwoFactorAuthentication_By_Email_Enabled: 'false',
    // Only members of `rocket-chat` may log in. posixGroup with memberUid, matched against
    // the username, so no memberOf overlay is needed.
    ...(it.groups
      ? {
          OVERWRITE_SETTING_LDAP_Group_Filter_Enable: 'true',
          OVERWRITE_SETTING_LDAP_Group_Filter_ObjectClass: 'posixGroup',
          OVERWRITE_SETTING_LDAP_Group_Filter_Group_Id_Attribute: 'cn',
          OVERWRITE_SETTING_LDAP_Group_Filter_Group_Member_Attribute: 'memberUid',
          OVERWRITE_SETTING_LDAP_Group_Filter_Group_Member_Format: '#{username}',
          OVERWRITE_SETTING_LDAP_Group_Filter_Group_Name: 'rocket-chat',
          ...syncEnv(it),
        }
      : {}),
    // The CA itself is added by `withCertificate`, once houston has issued the certificate.
    ...(it.tls === 'none'
      ? {}
      : {
          OVERWRITE_SETTING_LDAP_Port: it.tls === 'ldaps' ? '636' : '389',
          OVERWRITE_SETTING_LDAP_Encryption: it.tls === 'ldaps' ? 'ssl' : 'tls',
          OVERWRITE_SETTING_LDAP_Reject_Unauthorized: 'true',
        }),
  };
}

/**
 * Rocket.Chat against the AD flavour. Server type `ad` makes Rocket.Chat read the `LDAP_AD_*`
 * copies of the search, username, email and name fields, not the plain ones; the unique
 * identifier and the search filter it reads either way. With groups=on the login filter asks
 * for rocket-chat membership through any depth of nesting, which only AD's in-chain rule does.
 */
function adRocketChatEnv(it: LDAPIntent): Record<string, string> {
  const person = '(objectCategory=person)(objectClass=user)';
  const enabled = '(!(userAccountControl:1.2.840.113556.1.4.803:=2))';
  const chain = it.groups ? `(memberOf:${IN_CHAIN}:=CN=rocket-chat,OU=Groups,${it.baseDn})` : '';
  return {
    OVERWRITE_SETTING_LDAP_Enable: 'true',
    OVERWRITE_SETTING_LDAP_Server_Type: 'ad',
    OVERWRITE_SETTING_LDAP_Host: AD_HOST,
    OVERWRITE_SETTING_LDAP_Port: '389',
    OVERWRITE_SETTING_LDAP_BaseDN: it.baseDn,
    OVERWRITE_SETTING_LDAP_Authentication: 'true',
    OVERWRITE_SETTING_LDAP_Authentication_UserDN: bindOf(it)[0],
    OVERWRITE_SETTING_LDAP_Authentication_Password: bindOf(it)[1],
    OVERWRITE_SETTING_LDAP_User_Search_Filter: `(&${person}${enabled}${chain})`,
    OVERWRITE_SETTING_LDAP_User_Search_Scope: 'sub',
    OVERWRITE_SETTING_LDAP_AD_User_Search_Field: 'sAMAccountName',
    OVERWRITE_SETTING_LDAP_AD_Username_Field: 'sAMAccountName',
    OVERWRITE_SETTING_LDAP_AD_Email_Field: 'mail',
    OVERWRITE_SETTING_LDAP_AD_Name_Field: 'displayName',
    OVERWRITE_SETTING_LDAP_Unique_Identifier_Field: 'objectGUID',
    OVERWRITE_SETTING_LDAP_Login_Fallback: 'true',
    OVERWRITE_SETTING_Accounts_TwoFactorAuthentication_By_Email_Enabled: 'false',
    ...(it.groups ? syncEnv(it) : {}),
    ...(it.tls === 'none'
      ? {}
      : {
          OVERWRITE_SETTING_LDAP_Port: it.tls === 'ldaps' ? '636' : '389',
          OVERWRITE_SETTING_LDAP_Encryption: it.tls === 'ldaps' ? 'ssl' : 'tls',
          OVERWRITE_SETTING_LDAP_Reject_Unauthorized: 'true',
        }),
  };
}

/** Who Rocket.Chat (and Keycloak, with idp) binds to the directory as: DN and password. */
function bindOf(it: LDAPIntent): [string, string] {
  if (isAd(it)) {
    return it.bind === 'service'
      ? [`CN=${READONLY_USER},CN=Users,${it.baseDn}`, READONLY_USER]
      : [`CN=Administrator,CN=Users,${it.baseDn}`, AD_ADMIN_PASSWORD];
  }
  return it.bind === 'service'
    ? [`cn=${READONLY_USER},${it.baseDn}`, READONLY_PASSWORD]
    : [`cn=admin,${it.baseDn}`, it.adminPassword];
}

/** The service name the directory's certificate is issued for; none means openldap. */
export function directoryHost(extra: Record<string, unknown>): string | undefined {
  return typeof extra.directory_host === 'string' ? extra.directory_host : undefined;
}

/**
 * The directory's certificate, which houston's create issues from its own CA when the preset
 * records `directory_tls`: Compose files beside the LDIF, or a Kubernetes Secret, and the CA
 * for Rocket.Chat unless `trust=none`. Pure, so the merge and the specs need no openssl.
 */
export function withCertificate(
  pre: Preset,
  cert: { crt: string; key: string; ca: string },
  runtime: string,
): Preset {
  const out: Preset = { ...pre, env: { ...pre.env }, files: [...pre.files] };
  if (runtime === 'kubernetes') {
    out.kubernetesManifests = [
      ...pre.kubernetesManifests,
      safeDump({
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: TLS_SECRET, labels: { 'houston.io/repro': '__HOUSTON_NAME__' } },
        type: 'Opaque',
        stringData: { 'ldap.crt': cert.crt, 'ldap.key': cert.key, 'ca.crt': cert.ca },
      }),
    ];
  } else {
    out.files.push(
      ['ldap/certs/ldap.crt', cert.crt],
      ['ldap/certs/ldap.key', cert.key],
      ['ldap/certs/ca.crt', cert.ca],
    );
  }
  if (pre.extra.directory_trust !== 'none') {
    out.env.OVERWRITE_SETTING_LDAP_CA_Cert = cert.ca;
  }
  return out;
}

/**
 * Group-to-role and group-to-channel sync: rocket-admin becomes `admin`, employee joins
 * `#employees`. These settings exist only under an Enterprise licence with `ldap-enterprise`;
 * without one Rocket.Chat never registers them and ignores the variables. Written in both
 * spellings: 4.0.0 renamed `Groups*` to `Roles*`/`Channels*` and migrated the values, and an
 * unregistered id is ignored, so the old one is harmless on a new release.
 */
function syncEnv(it: LDAPIntent): Record<string, string> {
  const groups = isAd(it) ? `OU=Groups,${it.baseDn}` : `ou=groups,${it.baseDn}`;
  const filter = isAd(it)
    ? `(&(objectClass=group)(cn=#{groupName})(member:${IN_CHAIN}:=#{userdn}))`
    : '(&(cn=#{groupName})(memberUid=#{username}))';
  const roles = '{"rocket-admin":"admin"}';
  const channels = '{"employee":"employees"}';
  return {
    OVERWRITE_SETTING_LDAP_Sync_User_Data_Roles: 'true',
    OVERWRITE_SETTING_LDAP_Sync_User_Data_Roles_BaseDN: groups,
    OVERWRITE_SETTING_LDAP_Sync_User_Data_Roles_Filter: filter,
    OVERWRITE_SETTING_LDAP_Sync_User_Data_RolesMap: roles,
    OVERWRITE_SETTING_LDAP_Sync_User_Data_Channels: 'true',
    OVERWRITE_SETTING_LDAP_Sync_User_Data_Channels_BaseDN: groups,
    OVERWRITE_SETTING_LDAP_Sync_User_Data_Channels_Filter: filter,
    OVERWRITE_SETTING_LDAP_Sync_User_Data_ChannelsMap: channels,
    // Before 4.0.0.
    OVERWRITE_SETTING_LDAP_Sync_User_Data_Groups: 'true',
    OVERWRITE_SETTING_LDAP_Sync_User_Data_Groups_BaseDN: groups,
    OVERWRITE_SETTING_LDAP_Sync_User_Data_Groups_Filter: filter,
    OVERWRITE_SETTING_LDAP_Sync_User_Data_GroupsMap: roles,
    OVERWRITE_SETTING_LDAP_Sync_User_Data_Groups_AutoChannels: 'true',
    OVERWRITE_SETTING_LDAP_Sync_User_Data_Groups_AutoChannelsMap: channels,
  };
}

/** The directory's environment (osixia's names, which the image keeps), and the read-only user. */
function slapdEnv(it: LDAPIntent): Record<string, string> {
  return {
    LDAP_ORGANISATION: 'Houston',
    LDAP_DOMAIN: it.domain,
    LDAP_BASE_DN: it.baseDn,
    LDAP_ADMIN_PASSWORD: it.adminPassword,
    ...(it.bind === 'service'
      ? {
          LDAP_READONLY_USER: 'true',
          LDAP_READONLY_USER_USERNAME: READONLY_USER,
          LDAP_READONLY_USER_PASSWORD: READONLY_PASSWORD,
        }
      : {}),
    // houston's certificate instead of the image's self-signed one, and no client certificate
    // asked for: the default `demand` refuses every Rocket.Chat connection.
    ...(it.tls === 'none'
      ? {}
      : {
          LDAP_TLS: 'true',
          LDAP_TLS_CRT_FILENAME: 'ldap.crt',
          LDAP_TLS_KEY_FILENAME: 'ldap.key',
          LDAP_TLS_CA_CRT_FILENAME: 'ca.crt',
          LDAP_TLS_VERIFY_CLIENT: 'never',
        }),
  };
}

/** The certificate files' Compose mounts, one file each, read in place (0644). */
function certVolumes(it: LDAPIntent): string[] {
  if (it.tls === 'none') return [];
  const dir = isAd(it) ? AD_CERTS_DIR : CERTS_DIR;
  return CERT_FILES.map((file) => `./ldap/certs/${file}:${dir}/${file}:ro`);
}

/** What houston's create reads to issue the directory a certificate (`withCertificate`). */
function certificateExtra(it: LDAPIntent): Record<string, string> {
  if (it.tls === 'none') return {};
  return {
    directory_tls: it.tls,
    directory_trust: it.trust,
    ...(isAd(it) ? { directory_host: AD_HOST } : {}),
  };
}

/** The AD flavour's Compose service. */
function adService(it: LDAPIntent): Record<string, unknown> {
  return {
    image: AD_IMAGE,
    entrypoint: ['/bin/sh', '-c', INSTALL_SEED_THEN_RUN],
    environment: adEnv(it),
    volumes: [`./ldap/ad-seed.sh:${AD_SEED_PATH}:ro`, ...certVolumes(it)],
    restart: 'unless-stopped',
  };
}

function describe(it: LDAPIntent): string {
  const sso =
    it.idp === 'none' ? '' : ` Keycloak signs the same users in by ${it.idp.toUpperCase()}.`;
  return directoryDescription(it) + sso;
}

function directoryDescription(it: LDAPIntent): string {
  if (isAd(it)) {
    return (
      `Samba as Active Directory seeded with ${String(it.users)} user(s) + group ` +
      `'${GROUP_CN}'; RC wired for AD login. Log in as user1 / user1.`
    );
  }
  return (
    `OpenLDAP (v2.6.x) seeded with ${String(it.users)} user(s) + group ` +
    `'${GROUP_CN}'; RC wired for LDAP login. Log in as user1 / user1.`
  );
}

function adNotes(it: LDAPIntent, uiPort: number): string[] {
  return [
    // One string per point (see the SSO notes): the place with its login in parentheses, as
    // the GUI's link rows read it, then prose.
    `phpLDAPadmin: http://localhost:${String(uiPort)}  (log in with DN CN=Administrator,CN=Users,${it.baseDn} / ${AD_ADMIN_PASSWORD})`,
    `Rocket.Chat users are user1..user${String(it.users)} (sAMAccountName, or UPN userN@${it.domain}), password same as name; Rocket.Chat keys them by objectGUID.`,
    ...(it.users > SHIPPED_USERS_MAX
      ? ['A large directory takes a while to seed: about 5 minutes for 20,000 users.']
      : []),
    ...(it.groups
      ? [
          `Groups: rocket-chat holds staff, which holds every user but the last; rocket-admin (user1); employee (everyone). Login asks for rocket-chat membership through the nesting (AD's in-chain rule), so user${String(it.users)} is refused. With an Enterprise license, rocket-admin members get the admin role and employee members join #employees at login.`,
          'Samba returns every member of a large group at once; Windows AD splits one past 1,500 members into ranges, which this directory does not reproduce.',
        ]
      : []),
    ...(it.bind === 'service'
      ? [
          `Rocket.Chat binds as CN=${READONLY_USER},CN=Users,${it.baseDn} / ${READONLY_USER}, an ordinary user. Samba sets no page limit (Windows AD stops at 1,000 entries).`,
        ]
      : []),
  ];
}

/** The scenario card's guide for this directory, its groups, its bind and its SSO. */
function guideFor(it: LDAPIntent): PresetGuide {
  const n = String(it.users);
  const ad = isAd(it);
  const sso = it.idp !== 'none';
  const saml = it.idp === 'saml';
  const button = saml ? 'Keycloak SSO' : 'Keycloak (OIDC)';
  const hostsEntry = sso && !saml && it.idpHost === 'keycloak';
  return guide('ldap', {
    summary: ad
      ? `Samba as Active Directory with ${n} users${it.groups ? ' and nested groups' : ''}; Rocket.Chat signs them in.`
      : `OpenLDAP with ${n} users and the group rc-users; Rocket.Chat signs them in.`,
    setup: hostsEntry
      ? {
          why: keycloak.HOSTS_ENTRY_WHY,
          line: '127.0.0.1  keycloak',
        }
      : null,
    signIn: [
      [`user1 … user${n}`, 'same as the name', 'Rocket.Chat, LDAP login'],
      [...adminLogin(it), 'phpLDAPadmin, as a DN'],
      ...(sso
        ? ([
            [`user1 … user${n}`, 'same as the name', `press '${button}' on the login page`],
            ['admin', 'admin', `Keycloak admin console, realm '${keycloak.REALM}'`],
          ] as [string, string, string][])
        : []),
    ],
    steps: [
      'Sign in to Rocket.Chat as user1 / user1.',
      'Browse the directory in phpLDAPadmin with the admin DN.',
      sso
        ? `Or press '${button}' and sign in as user1 / user1: Keycloak signs in the same directory user.`
        : '',
    ],
    know: [
      ...(it.groups
        ? ad
          ? [
              `rocket-chat holds staff (every user but the last); rocket-admin holds user1; employee holds everyone. Login asks for rocket-chat membership through the nesting (AD's in-chain rule), so user${n} is refused.`,
              'With an Enterprise license rocket-admin members get the admin role and employee members join #employees at login.',
              'Samba returns every member of a large group at once; Windows AD splits one past 1,500 members into ranges, which this directory does not reproduce.',
            ]
          : [
              `Groups: rocket-chat (all but the last user), rocket-admin (user1), employee (all). Only rocket-chat may log in: user${n} is refused by the group filter.`,
              'With an Enterprise license (--license, or the Enterprise license field when creating; or a registration token), rocket-admin members get the admin role and employee members join #employees at login.',
            ]
        : []),
      it.bind === 'service'
        ? ad
          ? `Rocket.Chat binds as CN=${READONLY_USER},CN=Users,${it.baseDn} / ${READONLY_USER}, an ordinary user. Samba sets no page limit (Windows AD stops at 1,000 entries).`
          : `Rocket.Chat binds as cn=${READONLY_USER},${it.baseDn} / ${READONLY_PASSWORD}; slapd limits it to 500 entries per search, so a sync over more users hits it.`
        : '',
      it.users > SHIPPED_USERS_MAX
        ? 'A large directory takes a while to seed: about 5 minutes for 20,000 users.'
        : '',
      sso
        ? 'Rocket.Chat matches the Keycloak sign-in to the directory user by email; the Keycloak users are under User federation > directory.'
        : '',
      sso && it.mfa
        ? 'Keycloak asks each user to set up an authenticator app at the first sign-in.'
        : '',
      hostsEntry
        ? `The hosts entry works only for a browser on the machine running houston. ${keycloak.FROM_ANOTHER_COMPUTER}`
        : sso && it.idpHost === 'localhost'
          ? `Keycloak is reached on localhost, so the browser must be on the machine running houston. ${keycloak.FROM_ANOTHER_COMPUTER}`
          : '',
    ],
  });
}

function notesFor(it: LDAPIntent, uiPort: number): string[] {
  if (isAd(it)) return adNotes(it, uiPort);
  return [
    `phpLDAPadmin: http://localhost:${String(uiPort)}  (log in with DN cn=admin,${it.baseDn} / ${it.adminPassword})`,
    `Rocket.Chat users are user1..user${String(it.users)}, password same as name.`,
    ...(it.groups
      ? [
          `Groups: rocket-chat (all but the last user), rocket-admin (user1), employee (all). Only rocket-chat may log in: user${String(it.users)} is refused by the group filter. With an Enterprise license (--license, or the Enterprise license field when creating; or a registration token), rocket-admin members get the admin role and employee members join #employees at login.`,
        ]
      : []),
    ...(it.bind === 'service'
      ? [
          `Rocket.Chat binds as cn=${READONLY_USER},${it.baseDn} / ${READONLY_PASSWORD}, whom slapd limits to 500 entries per search: a sync over more users hits it.`,
        ]
      : []),
  ];
}

function openldapService(it: LDAPIntent): Record<string, unknown> {
  return generated(it)
    ? {
        image: DIRECTORY_IMAGE,
        entrypoint: ['/bin/sh', '-c', GENERATE_THEN_RUN],
        environment: { ...slapdEnv(it), ...generatorEnv(it) },
        volumes: [`./ldap/gen-users.sh:${GENERATOR_PATH}:ro`, ...certVolumes(it)],
        restart: 'unless-stopped',
      }
    : {
        image: DIRECTORY_IMAGE,
        environment: slapdEnv(it),
        volumes: [`./ldap/50-rc-users.ldif:${BOOTSTRAP_PATH}:ro`, ...certVolumes(it)],
        restart: 'unless-stopped',
      };
}

function composeAdapter(it: LDAPIntent, ports: PortMap): Preset {
  const host = hostOf(it);
  const uiPort = uiPortOf(ports);
  const idp = idpParts(it, ports);
  const services: Record<string, Record<string, unknown>> = {
    [host]: isAd(it) ? adService(it) : openldapService(it),
    // A directory you cannot look at is hard to reproduce against: "is the user there,
    // and what attributes does it have" is the first question of nearly every LDAP
    // ticket, and answering it meant `docker exec ... ldapsearch`.
    // Plain HTTP: the directory is on a private network with a fixed throwaway password, and
    // an HTTPS workspace serves it through its own name instead (`withPublicUrl`).
    phpldapadmin: {
      image: UI_IMAGE,
      environment: uiEnv(it),
      ports: [`${String(uiPort)}:${String(UI_CONTAINER_PORT)}`],
      depends_on: [host],
      restart: 'unless-stopped',
    },
    ...(idp === null
      ? {}
      : {
          keycloak: keycloak.service(
            './ldap/keycloak-realm.json',
            idp.port,
            it.idp === 'oidc' ? idp.port : undefined,
          ),
        }),
  };
  return {
    ...emptyPreset('ldap'),
    description: describe(it),
    env: { ...envFor(it), ...idp?.env },
    softEnv: [EMAIL_2FA],
    services,
    dependsOn: idp === null ? [host] : [host, 'keycloak'],
    requiresLicense: false,
    source: 'built-in (dynamic)',
    files: [
      ...directoryFiles(it),
      ...(idp === null ? [] : [['ldap/keycloak-realm.json', idp.realm] as [string, string]]),
    ],
    // Declared so port allocation and the capacity preflight can SEE it --
    // the invariant that holds each preset's ports to the registry caught this being
    // missing the moment phpLDAPadmin gained a port.
    ports: [uiPort, ...(idp === null ? [] : [idp.port])],
    notes: [...notesFor(it, uiPort), ...(idp?.notes ?? [])],
    guides: [guideFor(it)],
    postReady: idp?.postReady ?? [],
    paramsHelp: { ...PARAMS_HELP },
    scenario: 'ldap',
    scenarioParams: asParams(it),
    extra: certificateExtra(it),
  };
}

/** What the directory is seeded from: the AD seed, the generator, or the LDIF itself. */
function directoryFiles(it: LDAPIntent): [string, string][] {
  if (isAd(it)) return [['ldap/ad-seed.sh', AD_SEED]];
  return generated(it) ? [['ldap/gen-users.sh', GENERATOR]] : [['ldap/50-rc-users.ldif', ldif(it)]];
}

/** The phpLDAPadmin browser UI, which is the only way to see what LDAP holds. */
function phpldapadminWorkload(
  labels: Record<string, string>,
  it: LDAPIntent,
  uiPort: number,
): [Bag, Bag] {
  // phpLDAPadmin, and the label that gets it published. A Service carrying
  // `houston.io/ui-port` is forwarded to that host port by the Kubernetes lifecycle -- the
  // declaration lives on the Service that defines the thing, rather than in a second
  // registry the adapter would have to be kept in step with. The NUMBER is the workspace's
  // ldap port, so both runtimes publish the same one.
  const uiLabels: Record<string, string> = { ...labels };
  uiLabels.app = 'houston-phpldapadmin';
  uiLabels[UI_PORT_LABEL] = String(uiPort);
  const uiDeployment: Bag = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'phpldapadmin', labels: uiLabels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: uiLabels.app } },
      template: {
        metadata: { labels: uiLabels },
        spec: {
          containers: [
            {
              name: 'phpldapadmin',
              image: UI_IMAGE,
              env: Object.entries(uiEnv(it)).map(([name, value]) => ({ name, value })),
              ports: [{ containerPort: UI_CONTAINER_PORT }],
              // Laravel's own health route: `/` answers a redirect to the sign-in page.
              readinessProbe: {
                httpGet: { path: '/up', port: UI_CONTAINER_PORT },
                initialDelaySeconds: 3,
                periodSeconds: 3,
                failureThreshold: 30,
              },
            },
          ],
        },
      },
    },
  };
  const uiService: Bag = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'phpldapadmin', labels: uiLabels },
    spec: {
      selector: { app: uiLabels.app },
      // The forward to the host port reads `targetPort`; an Ingress reaches the Service's 80.
      ports: [{ name: 'http', port: 80, targetPort: UI_CONTAINER_PORT }],
    },
  };
  return [uiDeployment, uiService];
}

/** The OpenLDAP Deployment and the Service in front of it. */
function openldapWorkload(it: LDAPIntent, labels: Record<string, string>): [Bag, Bag] {
  const deployment: Bag = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: 'openldap', labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: labels.app } },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: 'openldap',
              image: DIRECTORY_IMAGE,
              ...(generated(it) ? { command: ['/bin/sh', '-c', GENERATE_THEN_RUN] } : {}),
              env: Object.entries({
                ...slapdEnv(it),
                ...(generated(it) ? generatorEnv(it) : {}),
              }).map(([name, value]) => ({ name, value })),
              ports: [
                { name: 'ldap', containerPort: 389 },
                ...(it.tls === 'ldaps' ? [{ name: 'ldaps', containerPort: 636 }] : []),
              ],
              // slapd binds 389 only after the bootstrap LDIF is imported, and without
              // this the pod is Ready the instant the container starts -- so the Service
              // publishes an endpoint that is not serving, and Rocket.Chat starts against
              // an LDAP that is not answering. That is a first-login failure nobody would
              // connect back to here. tcpSocket rather than httpGet: LDAP is not HTTP,
              // and slapd binding the port IS the milestone.
              readinessProbe: {
                tcpSocket: { port: 389 },
                initialDelaySeconds: 5,
                periodSeconds: 3,
                failureThreshold: 40,
              },
              volumeMounts: [
                generated(it)
                  ? { name: 'bootstrap', mountPath: GENERATOR_PATH, subPath: 'gen-users.sh' }
                  : { name: 'bootstrap', mountPath: BOOTSTRAP_PATH, subPath: '50-rc-users.ldif' },
                ...(it.tls === 'none'
                  ? []
                  : CERT_FILES.map((file) => ({
                      name: 'tls',
                      mountPath: `${CERTS_DIR}/${file}`,
                      subPath: file,
                    }))),
              ],
            },
          ],
          volumes: [
            { name: 'bootstrap', configMap: { name: 'openldap-bootstrap' } },
            ...(it.tls === 'none' ? [] : [{ name: 'tls', secret: { secretName: TLS_SECRET } }]),
          ],
        },
      },
    },
  };
  const service: Bag = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: 'openldap', labels },
    spec: {
      selector: { app: labels.app },
      // 636 too for LDAPS: slapd serves it, and without it here Rocket.Chat's connection to
      // openldap:636 timed out (measured on k3s) while 389 answered.
      ports: [
        { name: 'ldap', port: 389, targetPort: 389 },
        ...(it.tls === 'ldaps' ? [{ name: 'ldaps', port: 636, targetPort: 636 }] : []),
      ],
    },
  };
  return [deployment, service];
}

/** The AD flavour's Deployment and Service: the same seed as Compose, from a ConfigMap. */
function adWorkload(it: LDAPIntent, labels: Record<string, string>): [Bag, Bag] {
  const tlsMounts =
    it.tls === 'none'
      ? []
      : CERT_FILES.map((file) => ({
          name: 'tls',
          mountPath: `${AD_CERTS_DIR}/${file}`,
          subPath: file,
        }));
  const deployment: Bag = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name: AD_HOST, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: labels.app } },
      template: {
        metadata: { labels },
        spec: {
          containers: [
            {
              name: AD_HOST,
              image: AD_IMAGE,
              command: ['/bin/sh', '-c', INSTALL_SEED_THEN_RUN],
              env: Object.entries(adEnv(it)).map(([name, value]) => ({ name, value })),
              ports: [
                { name: 'ldap', containerPort: 389 },
                ...(it.tls === 'ldaps' ? [{ name: 'ldaps', containerPort: 636 }] : []),
              ],
              // samba binds 389 only once the seed is in, so Ready means the users are there.
              readinessProbe: {
                tcpSocket: { port: 389 },
                initialDelaySeconds: 5,
                periodSeconds: 3,
                failureThreshold: 40,
              },
              volumeMounts: [
                { name: 'seed', mountPath: AD_SEED_PATH, subPath: 'ad-seed.sh' },
                ...tlsMounts,
              ],
            },
          ],
          volumes: [
            { name: 'seed', configMap: { name: `${AD_HOST}-seed` } },
            ...(it.tls === 'none' ? [] : [{ name: 'tls', secret: { secretName: TLS_SECRET } }]),
          ],
        },
      },
    },
  };
  const service: Bag = {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: AD_HOST, labels },
    spec: {
      selector: { app: labels.app },
      ports: [
        { name: 'ldap', port: 389, targetPort: 389 },
        ...(it.tls === 'ldaps' ? [{ name: 'ldaps', port: 636, targetPort: 636 }] : []),
      ],
    },
  };
  return [deployment, service];
}

/** The seed ConfigMap's data: the directory files under their own names. */
function seedData(it: LDAPIntent): Record<string, string> {
  return Object.fromEntries(
    directoryFiles(it).map(([file, text]) => [file.slice('ldap/'.length), text]),
  );
}

/** Render the small directory workload used by the Kubernetes adapter. */
function kubernetesManifest(it: LDAPIntent, uiPort: number): string {
  const labels: Record<string, string> = {
    app: isAd(it) ? `houston-${AD_HOST}` : 'houston-openldap',
    'app.kubernetes.io/managed-by': 'houston',
    'houston.io/component': 'ldap',
    // The Kubernetes lifecycle substitutes the namespace-local repro name.
    'houston.io/repro': '__HOUSTON_NAME__',
  };
  const configMap: Bag = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: isAd(it) ? `${AD_HOST}-seed` : 'openldap-bootstrap', labels },
    data: seedData(it),
  };
  const [deployment, service] = isAd(it) ? adWorkload(it, labels) : openldapWorkload(it, labels);
  // A CHANGED SEED ROLLS THE DIRECTORY. slapd keeps its entries in the pod and reads the seed
  // once; a ConfigMap edit restarts nothing, so a re-up with `--set users=9` recorded 9 and
  // kept serving 5 (live 2026-10-31). Stamped only off the default seed: a default workspace,
  // and the manifests earlier releases pin, are unchanged, and a re-up of either rolls nothing.
  // Only an LDIF seed: AD's and the generator's are fixed scripts whose counts ride in the env,
  // which rolls the pod already -- a stamp there would only roll a 2.1.6 workspace once, and
  // a re-provisioned AD gives every user a new objectGUID, which Rocket.Chat matches them by.
  const seed = JSON.stringify(configMap.data);
  if (!isAd(it) && !generated(it) && seed !== JSON.stringify(seedData(intent({})))) {
    const template = (deployment.spec as Bag).template as Bag;
    template.metadata = {
      ...(template.metadata as Bag),
      annotations: {
        'houston.io/seed': createHash('sha256').update(seed).digest('hex').slice(0, 16),
      },
    };
  }
  const [uiDeployment, uiService] = phpldapadminWorkload(labels, it, uiPort);
  return [configMap, deployment, service, uiDeployment, uiService]
    .map((doc) => safeDump(doc))
    .join('---\n');
}

function kubernetesAdapter(it: LDAPIntent, ports: PortMap): Preset {
  const uiPort = uiPortOf(ports);
  const idp = idpParts(it, ports);
  return {
    ...emptyPreset('ldap'),
    description: describe(it),
    notes: [...notesFor(it, uiPort), ...(idp?.notes ?? [])],
    guides: [guideFor(it)],
    postReady: idp?.postReady ?? [],
    topology: 'kubernetes',
    // Declared here for the same reason the Compose adapter declares it: phpLDAPadmin is
    // published on the workspace's host port on this runtime too (as a port-forward rather
    // than a compose mapping). The Kubernetes create allocates it as Compose does
    // (`lifecycle/ports.ts` `claimSidePorts`) and records it as `sidecar_ports`. Until that
    // step existed this list was read by nothing here, and a second workspace's forward
    // simply failed to bind 8082.
    ports: [uiPort, ...(idp === null ? [] : [idp.port])],
    // The scenario changes the backing service and Rocket.Chat settings; it does not make
    // the microservices deployment cease to be an Enterprise topology. Preserve that
    // deployment-level requirement so lifecycle warnings and onboarding next-command
    // guidance remain truthful.
    requiresLicense: true,
    source: 'built-in (scenario)',
    env: { ...envFor(it), ...idp?.env },
    softEnv: [EMAIL_2FA],
    paramsHelp: { ...PARAMS_HELP },
    scenario: 'ldap',
    scenarioParams: asParams(it),
    extra: certificateExtra(it),
    kubernetesManifests: [
      kubernetesManifest(it, uiPort),
      ...(idp === null
        ? []
        : [keycloak.manifests(idp.realm, idp.port, it.idp === 'oidc' ? idp.port : undefined)]),
    ],
  };
}

const SCENARIO = new Scenario<LDAPIntent>({
  name: 'ldap',
  paramsHelp: PARAMS_HELP,
  resolveIntent: intent,
  // Keyed by RUNTIME, in `core/topology.ts`'s words. See the note on `Preset.topology`
  // for why there is only one set of words for this.
  adapters: { docker: composeAdapter, kubernetes: kubernetesAdapter },
});

export function scenario(): Scenario<LDAPIntent> {
  return SCENARIO;
}

/** Legacy `ldap` loader entry point; resolve through the Compose adapter. */
export function build(params: Params, ports: PortMap): Preset {
  return SCENARIO.resolve(params, 'docker', ports);
}

register('ldap', build);
registerScenario('ldap', SCENARIO);
