/**
 * Dynamic `webhooks` preset: a web inbox for HTTP requests (webhook-tester), wired to
 * Rocket.Chat the way Mailpit is wired for mail.
 *
 * The receiver records any request whose path starts with a session's uuid, and answers
 * what that session was made to answer. The `webhooks_setup` post-ready action makes ONE
 * session through the receiver's API, answering 200 with a small JSON body -- the one the
 * receiver makes by itself on an unknown uuid answers an EMPTY body, which Rocket.Chat
 * reads as a failed call and retries four times -- and records the uuid the receiver chose.
 * Every link ends in `/s/<uuid>` (the root page would open a new, empty session) and
 * Rocket.Chat posts to the same place on both runtimes. Sub-paths say who posted:
 * `/outgoing` (the sample integration), `/omnichannel` (the Omnichannel webhook),
 * `/captured/<name>` (a customer's integration repointed by capture=all). The receiver
 * keeps sessions and requests on disk, in a volume, so a stop, start, restart or rebuild
 * keeps them; while the receiver's API cannot be reached, post-ready wires nothing and
 * says so, because the auto-created session would bring the retries back.
 *
 * Nothing here is set by env: the sample integrations and the Omnichannel webhook settings
 * are made by the post-ready action, so they stay editable in the admin UI (an
 * OVERWRITE_SETTING_ greys a setting out, and repointing a webhook at a failing session is
 * the point of the exercise).
 *
 * The inbox UI is a browser-router SPA with absolute /api, /js and /s paths and no base-path
 * option, so it is not served under the HTTPS name (its /api would collide with Rocket.Chat's):
 * it answers on its own port on the machine running houston, and the notes say so.
 *
 * Parameters (via `--set`):
 *   capture   off|all (default off); all repoints every existing outgoing integration at the
 *             inbox, so a restored customer backup posts to nothing real.
 */
import * as config from '../config';

import { guide } from './guides';
import { choiceParam, k8sManifests, presetPort } from './common';
import { type Params, register } from './registry';
import { emptyPreset, type Preset } from './types';

const IMAGE = 'ghcr.io/tarampampam/webhook-tester:2.3.0';
/** The receiver's one port: UI, API and the capture endpoints together. */
const CONTAINER_PORT = 8080;
/**
 * Sessions and requests on disk (the image's FS_STORAGE_DIR is /data), not in memory, and
 * a session kept for the 31 days the receiver allows at most: a request renews it, an idle
 * month ends it, and the next `ready` makes a new one.
 */
const ENV = { AUTO_CREATE_SESSIONS: 'true', STORAGE_DRIVER: 'fs', SESSION_TTL: '744h' };
const DATA = '/data';
/** The image runs as this uid; a provisioned claim is root's until the pod says otherwise. */
const UID = 10001;
const DOCS = 'docs.rocket.chat/docs/integrations#script-compatibility';

export function build(params: Params, ports: config.PortMap): Preset {
  const capture = choiceParam(params, 'capture', ['off', 'all']);
  const webPort = presetPort('webhooks', 0, ports);
  const receiver = `${config.WEBHOOKS_RECEIVER}/<session>`;
  const inboxOrigin = `http://localhost:${String(webPort)}`;
  return {
    ...emptyPreset('webhooks'),
    description:
      // The GUI's create list shows only the first sentence: it has to say what this is.
      'A web inbox (webhook-tester) that catches every outgoing integration call and ' +
      'Omnichannel webhook Rocket.Chat sends and shows each one; nothing is ' +
      `forwarded. Sample '${config.WEBHOOKS_OUTGOING}' and '${config.WEBHOOKS_INCOMING}' ` +
      'integrations are created, --set capture=all repoints every existing outgoing ' +
      `integration there, and the inbox UI is on port ${String(webPort)} on the machine ` +
      'running houston (no HTTPS path; houston info and the GUI link it).',
    services: {
      webhooks: {
        // Multi-arch (amd64/arm64), built from scratch: no shell, its own HEALTHCHECK.
        image: IMAGE,
        restart: 'unless-stopped',
        environment: { ...ENV },
        volumes: [`webhooks_data:${DATA}`],
        ports: [`${String(webPort)}:${String(CONTAINER_PORT)}`],
      },
    },
    volumes: { webhooks_data: { driver: 'local' } },
    dependsOn: ['webhooks'],
    requiresLicense: false,
    source: 'built-in (dynamic)',
    paramsHelp: {
      capture:
        'off|all (default off); all repoints EVERY existing outgoing integration at the ' +
        'inbox and lists the originals, so a restored customer backup posts to nothing real',
    },
    // The origins: post-ready makes the session and composes the addresses from them.
    postReady: [
      {
        action: 'webhooks_setup',
        receiver: config.WEBHOOKS_RECEIVER,
        ui_url: inboxOrigin,
        capture,
      },
    ],
    ports: [webPort],
    kubernetesManifests: [
      k8sManifests({
        name: 'webhooks',
        image: IMAGE,
        ports: [[webPort, CONTAINER_PORT]],
        env: { ...ENV },
        readiness: {
          httpGet: { path: '/ready', port: CONTAINER_PORT },
          initialDelaySeconds: 2,
          periodSeconds: 3,
          failureThreshold: 40,
        },
        // The lifecycle forwards the labelled Service to this host port, as Mailpit's.
        ui: { webhooks: [webPort, CONTAINER_PORT] },
        data: { path: DATA, size: '256Mi', fsGroup: UID },
      }),
    ],
    guides: [
      guide('webhooks', {
        summary:
          'A web inbox that shows every outgoing integration call and Omnichannel webhook Rocket.Chat sends, with sample integrations already pointing at it.',
        steps: [
          'Post a message in a public channel: it is in the inbox within a second (POST /outgoing, the message as JSON).',
          "Run the curl that houston info prints under Webhooks: the text appears in #general as rocket.cat (the 'houston-incoming' integration).",
          'With the livechat preset, start a chat on the demo page: every Omnichannel event (start, taken, each message, close) posts to /omnichannel with the X-RocketChat-Livechat-Token header.',
          "Admin → Workspace → Integrations → 'houston-outgoing' → History lists each call and the inbox's answer, from any machine.",
        ],
        know: [
          `The inbox UI is on the machine running houston only, no HTTPS path: from elsewhere, ssh -L ${String(webPort)}:127.0.0.1:${String(webPort)} <host>, or --bind.`,
          `Rocket.Chat posts to ${receiver}/<source> inside the workspace network (the session id is the receiver's; the Webhook inbox link carries it): /outgoing, /omnichannel (the Omnichannel webhook, token '${config.WEBHOOKS_TOKEN}'), /captured/<name>.`,
          `The inbox answers 200 with {"captured": true}. A failing or slow endpoint: 'New URL' in the inbox UI with a 500 or a delay (untick 'Destroy current session', or houston's inbox goes with it), then paste its URL into the integration or into Omnichannel → Webhooks with the host replaced by webhooks:${String(CONTAINER_PORT)} (the inbox UI says localhost; Rocket.Chat reaches it inside the workspace network).`,
          capture === 'all'
            ? 'capture=all: every existing outgoing integration was repointed at the inbox; houston info lists the original URLs.'
            : 'A restored customer backup still posts to its real endpoints: --set capture=all repoints every outgoing integration at the inbox.',
          `From Rocket.Chat 9.0.0 integration scripts run as written (strict mode): one saved earlier keeps working until it is edited and saved again (${DOCS}).`,
          'The inbox keeps the last 128 requests, on disk: a stop, start, restart, upgrade or rebuild keeps them; down --volumes removes them. An inbox idle for 31 days loses its session, and houston ready makes a new one.',
        ],
      }),
    ],
    notes: [
      // No URL here on purpose: the receiver chooses the session, so the live inbox link is
      // in the links row and the Webhooks card (`notes.inboxUrl`). A placeholder URL here
      // would show `/s/<session>` and the GUI would turn it into a broken link.
      `Webhook inbox: a page that lists every request Rocket.Chat sends, on port ${String(webPort)} on the machine running houston (no HTTPS path). The 'Webhook inbox' link in houston info and the GUI opens it; from elsewhere, ssh -L ${String(webPort)}:127.0.0.1:${String(webPort)} <host>, or --bind.`,
      `Rocket.Chat posts to ${receiver}/<source> inside the workspace network: /outgoing ('${config.WEBHOOKS_OUTGOING}': Message Sent, all public channels), /omnichannel (the Omnichannel webhook, token '${config.WEBHOOKS_TOKEN}'; fires once Omnichannel is on, e.g. --preset livechat), /captured/<name> (capture=all).`,
      `'${config.WEBHOOKS_INCOMING}' takes POSTs into #general as rocket.cat: houston info prints its URL and a curl once the workspace is ready.`,
      capture === 'all'
        ? 'capture=all: every existing outgoing integration is repointed at the inbox; the originals are listed under Webhooks in houston info.'
        : 'A restored dump still posts to its real endpoints: --set capture=all repoints every outgoing integration at the inbox.',
      `The inbox answers 200 with {"captured": true}, which Rocket.Chat reads as success and posts nothing back. A failing or slow endpoint: 'New URL' in the inbox UI with a 500 or a delay (untick 'Destroy current session', or houston's inbox goes with it), then paste its URL into the integration (Admin → Workspace → Integrations) or Omnichannel → Webhooks with the host replaced by webhooks:${String(CONTAINER_PORT)} (the inbox UI says localhost; Rocket.Chat reaches it inside the workspace network).`,
      'Last 128 requests, on disk: a stop, start, restart, upgrade or rebuild keeps them; down --volumes removes them. An inbox idle for 31 days loses its session, and houston ready makes a new one.',
      `From Rocket.Chat 9.0.0 integration scripts run as written (strict mode): one saved earlier keeps working until it is edited and saved again (${DOCS}). Paste the customer's script into ${config.WEBHOOKS_OUTGOING} to test it.`,
    ],
  };
}

register('webhooks', build);
