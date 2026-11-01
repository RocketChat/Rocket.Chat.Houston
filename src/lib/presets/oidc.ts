/**
 * Dynamic `oidc` preset: a Keycloak OpenID Connect IdP that Rocket.Chat logs in against
 * via its Custom OAuth provider.
 *
 * Reuses the shared Keycloak scaffolding, but ships an OIDC client instead of a SAML one.
 * OIDC authenticates with a client id + a fixed client secret (no signing certs), so there is
 * no runtime cert fetch.
 *
 * THE ONE GOTCHA: OIDC's `url` is used by BOTH the browser (authorize) and RC's backend
 * (token/userinfo). We use a single shared hostname `keycloak:8085` -- RC's backend
 * resolves it over the compose network; the browser resolves it via a one-line hosts
 * entry `127.0.0.1  keycloak` (houston prints it). Keycloak is published on the
 * workspace's oidc port, 8085 unless another workspace holds it (SAML prefers 8081, so the
 * two presets do not collide), and LISTENS on it too: the one URL has to mean the same port
 * to the browser and to Rocket.Chat.
 */
import type { PortMap } from '../config';

import { guide } from './guides';
import { EMAIL_2FA, intParam, presetPort, strParam } from './common';
import * as keycloak from './keycloak';
import { type Params, register } from './registry';
import { emptyPreset, type Preset } from './types';

const KC_REALM = keycloak.REALM;
/** Resolvable from RC (compose DNS) AND the browser (/etc/hosts). */
const KC_HOST = 'keycloak';

/** The preset itself: what it is called, what it needs, and what `up` must do after. */
function oidcPreset(
  env: Record<string, string>,
  idpHost: string,
  settings: Record<string, unknown>,
  services: Record<string, Record<string, unknown>>,
  users: number,
  prefix: string,
  kcPort: number,
): Preset {
  const realm = keycloak.realmJson([keycloak.oidcClient(idpHost, kcPort)], users, prefix);
  return {
    ...emptyPreset('oidc'),
    description:
      `Keycloak OIDC IdP (OpenID Connect) with ${String(users)} users ${prefix}user1..${prefix}user` +
      `${String(users)} (password=username). RC logs in via Custom OAuth (popup). ` +
      `Click 'Keycloak (OIDC)', sign in as ${prefix}user1/${prefix}user1. ` +
      'See the note printed on `up` for how the browser reaches the IdP.',
    env,
    softEnv: [EMAIL_2FA],
    services,
    dependsOn: ['keycloak'],
    requiresLicense: false,
    source: 'built-in (dynamic)',
    files: [['oidc/keycloak-realm.json', realm]],
    // The same Keycloak as native resources. One Preset carries both renderings because
    // the intent is identical either way -- see `keycloak.manifests`.
    kubernetesManifests: [keycloak.manifests(realm, kcPort, kcPort)],
    paramsHelp: {
      users: 'number of Keycloak test users (default 5)',
      idp_host:
        'hostname BOTH your browser and Rocket.Chat reach ' +
        "Keycloak on (default 'keycloak', which needs a hosts entry and works only for a " +
        'browser on the machine running houston; from another computer create the ' +
        'workspace with HTTPS on a domain instead)',
    },
    ports: [kcPort],
    postReady: [
      { action: 'keycloak_master_ssl_off', service: 'keycloak', port: kcPort },
      // Create the Custom OAuth provider and configure it (cannot be done via env, since
      // the provider's settings do not exist until it is created).
      {
        action: 'create_oauth_provider',
        name: keycloak.capitalize(keycloak.OIDC_PROVIDER),
        settings,
      },
    ],
    guides: [
      guide('oidc', {
        summary: `Keycloak as an OpenID Connect provider with ${String(users)} users.`,
        setup:
          idpHost === KC_HOST
            ? {
                why: keycloak.HOSTS_ENTRY_WHY,
                line: `127.0.0.1  ${KC_HOST}`,
              }
            : null,
        signIn: [
          [
            `${prefix}user1 … ${prefix}user${String(users)}`,
            'same as the name',
            "press 'Keycloak (OIDC)' on the login page",
          ],
          ['admin', 'admin', `Keycloak admin console, realm '${KC_REALM}'`],
        ],
        steps: [
          idpHost === KC_HOST ? 'Add the hosts entry above.' : '',
          `On the login page press 'Keycloak (OIDC)' and sign in as ${prefix}user1 / ${prefix}user1.`,
        ],
        know: [
          idpHost === KC_HOST
            ? `The hosts entry works only for a browser on the machine running houston. ${keycloak.FROM_ANOTHER_COMPUTER}`
            : `Your browser and Rocket.Chat both reach Keycloak at http://${idpHost}:${String(kcPort)}; the workspace must be bound wide enough for both (--bind 0.0.0.0).`,
        ],
      }),
    ],
    notes: [
      ...(idpHost === KC_HOST
        ? [
            'OIDC needs one host entry so your browser can reach Keycloak at the',
            "same URL RC's backend uses. Add this line to /etc/hosts (needs sudo):",
            '    127.0.0.1  keycloak',
            '  It points at the machine running houston, so the browser has to be on it.',
            keycloak.FROM_ANOTHER_COMPUTER,
            `Then log in via 'Keycloak (OIDC)' as ${prefix}user1 / ${prefix}user1.`,
          ]
        : [
            `Your browser AND Rocket.Chat both reach Keycloak at http://${idpHost}:${String(kcPort)}.`,
            '  No hosts entry is needed, but the workspace must be bound wide enough',
            '  for both to get there (`--bind 0.0.0.0`).',
            `Log in via 'Keycloak (OIDC)' as ${prefix}user1 / ${prefix}user1.`,
          ]),
      `Keycloak admin console: http://${idpHost}:${String(kcPort)}  (admin/admin, realm '${KC_REALM}').`,
    ],
  };
}

export function build(params: Params, ports: PortMap): Preset {
  const users = intParam(params, 'users', 5);
  // Distinct from SAML's, so both presets can run at once (8080 is too commonly occupied --
  // e.g. other local Keycloaks).
  const kcPort = presetPort('oidc', 0, ports);
  // ONE hostname for two consumers -- the browser (authorize) and RC's backend
  // (token/userinfo) -- which is the gotcha this preset's doc comment opens with. The
  // default `keycloak` satisfies the backend over compose DNS and needs a hosts entry for
  // the browser, and that entry (`127.0.0.1 keycloak`) is only correct when the browser
  // is on THIS machine. It is not, on the shared-box deployment this tool now supports,
  // so the popup opened a name that did not resolve and showed the user a blank window --
  // reported as "the OIDC page shows nothing".
  //
  // Setting this to the host's own address satisfies BOTH and removes the hosts entry
  // entirely: the browser reaches the published port, and RC's container reaches the same
  // address over the bridge. It needs `--bind 0.0.0.0`, because a loopback-bound port is
  // not reachable from either.
  const idpHost = strParam(params, 'idp_host', KC_HOST);
  const realmBase = `http://${idpHost}:${String(kcPort)}/realms/${KC_REALM}`;
  // Accounts_OAuth_Custom-Keycloak
  const setting = `Accounts_OAuth_Custom-${keycloak.capitalize(keycloak.OIDC_PROVIDER)}`;

  const services = {
    // http_port: listen on the same port we publish, so the single `keycloak:8085` URL
    // works from the browser (via /etc/hosts) and RC's backend (via the compose network)
    // identically.
    keycloak: keycloak.service('./oidc/keycloak-realm.json', kcPort, kcPort),
  };

  const [env, settings] = keycloak.oauthSettings(realmBase, setting);

  const prefix = strParam(params, keycloak.USER_PREFIX_PARAM, '');
  return oidcPreset(env, idpHost, settings, services, users, prefix, kcPort);
}

register('oidc', build);
