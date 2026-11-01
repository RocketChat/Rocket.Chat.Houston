/**
 * Dynamic `saml` preset: a real Keycloak IdP that Rocket.Chat authenticates against over
 * SAML.
 *
 * The Keycloak realm is generated in code (a minimal realm with just our SAML client + N test
 * users) rather than shipping a bloated full export -- Keycloak regenerates all the default
 * clients/flows/scopes on import anyway.
 *
 * Parameters (via `--set`):
 *   users   number of test users to generate (default 5). Each userN has password userN
 *           and email userN@example.com -- log in as user1 / user1.
 *
 * Cert handling: Keycloak generates its signing key on realm import, so houston fetches
 * the cert at runtime (post_ready) and applies it to RC -- no manual exchange. The IdP is
 * published on the workspace's saml port, 8081 unless another workspace holds it
 * (browser-reachable).
 */
import type { PortMap } from '../config';

import { guide } from './guides';
import { EMAIL_2FA, intParam, presetPort, strParam } from './common';
import * as keycloak from './keycloak';
import { type Params, register } from './registry';
import { emptyPreset, type Preset } from './types';

const KC_REALM = keycloak.REALM;

/** Package the shared IdP rendering with SAML-specific setup and guidance. */
function samlPreset(
  users: number,
  idpHost: string,
  descriptor: string,
  services: Record<string, Record<string, unknown>>,
  env: Record<string, string>,
  prefix: string,
  kcPort: number,
): Preset {
  const realm = keycloak.realmJson([keycloak.samlClient()], users, prefix);
  return {
    ...emptyPreset('saml'),
    description:
      `Keycloak IdP with a generated SAML realm (${String(users)} users ${prefix}user1..${prefix}user` +
      `${String(users)}, password=username). Click 'Keycloak SSO', log in as ` +
      `${prefix}user1/${prefix}user1. Keycloak admin at http://${idpHost}:${String(kcPort)} ` +
      "(admin/admin, realm 'houston').",
    env,
    softEnv: [EMAIL_2FA],
    services,
    dependsOn: ['keycloak'],
    requiresLicense: false,
    source: 'built-in (dynamic)',
    files: [['saml/keycloak-realm.json', realm]],
    kubernetesManifests: [keycloak.manifests(realm, kcPort)],
    paramsHelp: {
      users: 'number of Keycloak test users (default 5)',
      idp_host:
        'hostname YOUR BROWSER reaches Keycloak on (default localhost: a browser on the ' +
        'machine running houston only; from another computer create the workspace with ' +
        'HTTPS on a domain instead, and Keycloak is at <workspace URL>/keycloak)',
    },
    ports: [kcPort],
    guides: [
      guide('saml', {
        summary: `Keycloak as a SAML identity provider with ${String(users)} users.`,
        signIn: [
          [
            `${prefix}user1 … ${prefix}user${String(users)}`,
            'same as the name',
            "press 'Keycloak SSO' on the login page",
          ],
          ['admin', 'admin', `Keycloak admin console, realm '${KC_REALM}' (not master)`],
        ],
        steps: [
          "On the login page press 'Keycloak SSO': your browser is sent to Keycloak.",
          `Sign in as ${prefix}user1 / ${prefix}user1.`,
        ],
        know: [
          `SAML sends your browser to http://${idpHost}:${String(kcPort)}: that address must resolve and be reachable from wherever the browser runs.`,
          idpHost === 'localhost'
            ? `It is localhost, so the browser must be on the machine running houston. ${keycloak.FROM_ANOTHER_COMPUTER}`
            : '',
          `In the Keycloak console switch the realm (top left) to '${KC_REALM}': the users are not in master. The 'temporary admin' banner there is normal in dev mode.`,
        ],
      }),
    ],
    notes: [
      `SAML sends your BROWSER to http://${idpHost}:${String(kcPort)} — that address has`,
      '  to resolve and be reachable from wherever the browser is running.',
      ...(idpHost !== 'localhost'
        ? []
        : [
            "  It is 'localhost', so the browser must be on the machine running houston.",
            keycloak.FROM_ANOTHER_COMPUTER,
            '  (Keycloak refuses a request that arrives on any other name.)',
          ]),
      `Keycloak admin console: http://${idpHost}:${String(kcPort)}  (admin / admin)`,
      `  Your SAML users live in the '${KC_REALM}' realm, NOT 'master' (the`,
      '  default view). Switch the realm dropdown (top-left) to ' +
        `'${KC_REALM}', or open Users directly:`,
      `    http://${idpHost}:${String(kcPort)}/admin/master/console/#/${KC_REALM}/users`,
      "  ('temporary admin' banner on master is normal Keycloak dev mode — ignore it)",
    ],
    postReady: [
      {
        action: 'saml_idp_cert',
        descriptor_url: descriptor,
        setting: 'SAML_Custom_Default_cert',
        enable_setting: 'SAML_Custom_Default',
      },
      { action: 'keycloak_master_ssl_off', service: 'keycloak' },
    ],
  };
}

export function build(params: Params, ports: PortMap): Preset {
  const users = intParam(params, 'users', 5);
  const kcPort = presetPort('saml', 0, ports);
  // THE BROWSER'S ADDRESS FOR THE IdP, not houston's. `entry_point` is the URL the user's
  // browser is redirected to, and it was hardcoded to `localhost` -- which names the
  // browser's OWN machine. On a shared box (the deployment this tool now supports: one
  // `serve` on an EC2 instance, several engineers using the GUI) the SAML button
  // therefore sent every one of them to port 8081 on their own laptop, and the browser
  // bounced straight back to the login page having reached nothing.
  //
  // Keycloak makes the mismatch unforgiving in the other direction too: it checks the
  // AuthnRequest's `Destination` against the URL the request actually arrived on, so
  // reaching the IdP as anything other than what `entry_point` says is refused with
  // `error="invalid_authn_request" reason="invalid_destination"` -- measured on this box
  // by changing nothing but the hostname. The two must agree, which is why this is one
  // knob and not a guess.
  const idpHost = strParam(params, 'idp_host', 'localhost');
  const samlEp = `http://${idpHost}:${String(kcPort)}/realms/${KC_REALM}/protocol/saml`;
  // FETCHED BY houston, so it stays on loopback whatever the browser uses. Same split as
  // root_url/public_url elsewhere in this codebase: an internal caller and a browser do
  // not need the same address, and giving the internal one the public address is how
  // `--set idp_host=<public name>` would break its own cert fetch on a workspace bound to
  // 127.0.0.1.
  const descriptor = `http://localhost:${String(kcPort)}/realms/${KC_REALM}/protocol/saml/descriptor`;
  const services = {
    keycloak: keycloak.service('./saml/keycloak-realm.json', kcPort),
  };
  const prefix = strParam(params, keycloak.USER_PREFIX_PARAM, '');
  return samlPreset(
    users,
    idpHost,
    descriptor,
    services,
    keycloak.samlSettings(samlEp),
    prefix,
    kcPort,
  );
}

register('saml', build);
