/**
 * Dynamic `voice` preset: Rocket.Chat Voice, calls between users, and with `sip_integration=on` the SIP stack
 * Rocket.Chat's documentation pairs it with (Drachtio and Rocket.Chat's own FreeSWITCH image).
 *
 * A call's audio goes browser to browser over WebRTC; Rocket.Chat only signals. So calls between
 * users need no service, only a licence carrying the Voice add-on (the `teams-voip` module):
 * Rocket.Chat 8 has no setting that switches Voice on, a workspace licensed for it has it. Without
 * one the workspace still boots and says so, because a licence can be applied later.
 *
 * With sip_integration=on Rocket.Chat reaches Drachtio, a SIP signalling gateway, on :9022, and Drachtio
 * reaches FreeSWITCH on :5060. Both run as Rocket.Chat's own compose files define them
 * (`compose.drachtio.yml`, `compose.freeswitch.yml` in RocketChat/rocketchat-compose): the same
 * images, command and variables. FreeSWITCH's stock dialplan answers 123 with an echo test and
 * sends a four-digit number back through Drachtio to the Rocket.Chat user with that extension.
 *
 * AUDIO IS A DIRECT UDP CONNECTION between FreeSWITCH and the browser, on a port of the RTP range
 * (Rocket.Chat's docs), so the range is published and FreeSWITCH advertises VOIP_DOMAIN, the
 * address browsers reach this machine at. The default is its own container name, which only a
 * browser on this (Linux) machine reaches. Drachtio sends its in-dialog requests back to where
 * FreeSWITCH's replies came from, so advertising the machine's address does not cut Drachtio off
 * (measured: ACK and BYE delivered with FreeSWITCH advertising the host's address).
 *
 * Parameters (via `--set`), named as Rocket.Chat's settings and compose files name them; the GUI
 * labels each with the same words (SIP integration, VoIP domain, RTP ports, ICE servers, PBX,
 * FreeSWITCH dialplans), so a lab built in one front-end is repeated in the other word for word:
 *   sip_integration       on|off (default off).
 *   voip_domain           VOIP_DOMAIN, the hostname or IPv4 browsers reach this machine at.
 *   rtp_ports             the published RTP range, start-end (default 20000-20046).
 *   ice_servers           Rocket.Chat's ICE servers setting: [user:password@]stun:|turn:|turns:host:port,...
 *   pbx                   on|off (default off): the PBX lab, `voice-pbx.ts` (sip_integration=on).
 *   freeswitch_dialplans  stock|edit (default stock): FreeSWITCH's dialplans as files to edit (pbx=on).
 * 2.1.3 spelled the first and last `sip` and `fs_dialplan`; `VOICE_PARAM_ALIASES` keeps them working.
 */
import { ValidationError } from '../errors';
import { shownValue } from '../format';
import { redactIceServers } from '../redact';
import { parseVersion } from '../version-spec';

import { guide, type PresetGuide } from './guides';
import { EMAIL_2FA, choiceParam, strParam } from './common';
import { type Params, register, registerScenario } from './registry';
import { Scenario } from './scenario';
import { emptyPreset, type Preset } from './types';
import {
  EXTERNAL_SIP_PORT,
  FS_DIALPLAN_MOUNTS,
  FS_DIALPLANS,
  PBX_KEPT,
  PBX_PORTS,
  opensCallPorts,
  externalEnv,
  fsDialplanFiles,
  pbxFiles,
  pbxNotes,
  pbxService,
} from './voice-pbx';

/** Created by the `voice_users` post-ready action, each with its username as its password. */
export const VOICE_TEST_USERS: Readonly<Record<string, string>> = Object.freeze({
  'voice-alice': '1001',
  'voice-bob': '1002',
});

// The images Rocket.Chat's compose files name. ponytail: `latest`, as those files have it (owner
// decision), so a workspace gets what a customer deploying them today gets; pin when a ticket
// needs an older FreeSWITCH build.
const DRACHTIO_IMAGE = 'docker.io/drachtio/drachtio-server:latest';
const FREESWITCH_IMAGE = 'docker.io/rocketchat/freeswitch:latest';
/** The shipped guide, where it is read online: the eight test calls, the PBX, the call flow. */
export const VOICE_GUIDE_URL =
  'https://github.com/klovekesh37/houston/blob/main/data/docs/voice.md';
const DRACHTIO_PORT = 9022;
const DRACHTIO_SECRET = 'houston';
const SIP_PORT = 5060;
const DEFAULT_RTP: readonly [number, number] = [20000, 20046];

/**
 * Every host port voice publishes at its defaults, lab PBX included. They cannot move -- phones
 * and the PBX dial them by number -- so another workspace's side port must never be given one
 * (`core/lifecycle/ports.ts` skips them when it looks for a free port).
 */
export const VOICE_DEFAULT_PORTS: readonly number[] = Object.freeze([
  SIP_PORT,
  ...Array.from({ length: DEFAULT_RTP[1] - DEFAULT_RTP[0] + 1 }, (_, i) => DEFAULT_RTP[0] + i),
  EXTERNAL_SIP_PORT,
  ...PBX_PORTS,
]);
// Labels of 1-63 letters, digits and inner hyphens; an IPv4 address is such a name too.
const HOST =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/u;
// No `$`: compose reads it as interpolation, so `pa$w` reached Rocket.Chat as `pa`.
const ICE_SERVER = /^([^@\s,$]+@)?(stun|turns?):[^\s,@$]+$/u;
// Docker runs a proxy and rules per published port. The official range is 47 ports.
const MAX_RTP_PORTS = 200;

interface Intent {
  sip: boolean;
  voipDomain: string;
  rtp: readonly [number, number];
  iceServers: string;
  pbx: boolean;
  fsDialplan: 'stock' | 'edit';
}

/** The 2.1.3 names of two options, still taken everywhere a `--set` key is read. */
export const VOICE_PARAM_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  sip: 'sip_integration',
  fs_dialplan: 'freeswitch_dialplans',
});

const PARAMS_HELP: Readonly<Record<string, string>> = Object.freeze({
  sip_integration:
    'off|on (default off); SIP integration: Drachtio and FreeSWITCH as rocketchat-compose runs them, SIP integration enabled in Rocket.Chat, Voice call extensions 1001 and 1002 for the test users. Docker only',
  voip_domain:
    "VOIP_DOMAIN: the hostname or IPv4 address browsers and phones send RTP audio to, for other computers the server's LAN or public IP; any address but loopback opens the call ports on every address of the machine running houston (default freeswitch, a browser on that machine only; sip_integration=on)",
  rtp_ports:
    'the published UDP RTP range, start-end, at most 200 ports (VOIP_RTP_START_PORT-VOIP_RTP_END_PORT; default 20000-20046; sip_integration=on)',
  ice_servers:
    "Rocket.Chat's ICE servers setting (WebRTC settings), comma-separated [user:password@]stun:|turn:|turns:host:port; unset keeps Rocket.Chat's own (Google STUN)",
  pbx: "off|on (default off); a lab PBX (Asterisk) on FreeSWITCH's external profile: desk phones, ring groups, an outside caller (sip_integration=on)",
  freeswitch_dialplans:
    "stock|edit (default stock); edit gives FreeSWITCH's public and drachtio dialplans as editable copies in the workspace folder (pbx=on)",
});

function rtpRange(params: Params): readonly [number, number] {
  const raw = strParam(params, 'rtp_ports', '');
  if (raw === '') return DEFAULT_RTP;
  const match = /^(\d{4,5})-(\d{4,5})$/u.exec(raw.trim());
  const [start, end] = match === null ? [0, 0] : [Number(match[1]), Number(match[2])];
  if (start < 1024 || end > 65535 || start >= end || end - start + 1 > MAX_RTP_PORTS) {
    throw new Error(
      `--set rtp_ports=${shownValue(raw)} expects start-end, start below end, both from 1024 to 65535, at most ${String(MAX_RTP_PORTS)} ports`,
    );
  }
  return [start, end];
}

function resolveIntent(params: Params): Intent {
  // choiceParam's first choice is the default.
  const sip = choiceParam(params, 'sip_integration', ['off', 'on']) === 'on';
  for (const key of ['voip_domain', 'rtp_ports']) {
    if (!sip && strParam(params, key, '') !== '') {
      throw new Error(`--set ${key} has an effect only with sip_integration=on`);
    }
  }
  const voipDomain = strParam(params, 'voip_domain', 'freeswitch');
  if (!HOST.test(voipDomain)) {
    throw new Error(
      `--set voip_domain=${shownValue(voipDomain)} expects a hostname or IPv4 address`,
    );
  }
  const iceServers = strParam(params, 'ice_servers', '');
  for (const entry of iceServers === '' ? [] : iceServers.split(',')) {
    if (!ICE_SERVER.test(entry.trim())) {
      throw new Error(
        // Masked: a refusal reaches houston.log and the GUI's Activity.
        `--set ice_servers entry ${shownValue(redactIceServers(entry.trim()))} is not [user:password@]stun:, turn: or turns:host:port`,
      );
    }
  }
  const pbx = choiceParam(params, 'pbx', ['off', 'on']) === 'on';
  if (pbx && !sip) throw new Error('--set pbx=on needs sip_integration=on');
  const fsDialplan =
    choiceParam(params, 'freeswitch_dialplans', ['stock', 'edit']) === 'edit' ? 'edit' : 'stock';
  if (fsDialplan === 'edit' && !pbx) {
    throw new Error('--set freeswitch_dialplans=edit needs pbx=on');
  }
  return { sip, voipDomain, rtp: rtpRange(params), iceServers, pbx, fsDialplan };
}

/** Drachtio and FreeSWITCH as Rocket.Chat's compose files define them; see the module comment. */
function sipServices(intent: Intent): Record<string, Record<string, unknown>> {
  const [start, end] = intent.rtp;
  const range = `${String(start)}-${String(end)}`;
  const external = String(EXTERNAL_SIP_PORT);
  return {
    // compose.drachtio.yml. Never published: Rocket.Chat and FreeSWITCH reach it by name.
    drachtio: {
      image: DRACHTIO_IMAGE,
      restart: 'unless-stopped',
      expose: [DRACHTIO_PORT, `${String(SIP_PORT)}/udp`],
      environment: {
        DRACHTIO_ADMIN_TCP_PORT: String(DRACHTIO_PORT),
        DRACHTIO_SECRET,
        DRACHTIO_LOGLEVEL: 'info',
        DRACHTIO_SOFIA_LOGLEVEL: '3',
      },
      command: 'drachtio --contact "sip:*;transport=udp"',
    },
    // compose.freeswitch.yml, the `$$` escapes as that file writes them. houston adds only the
    // start order: FreeSWITCH resolves the drachtio name once, when it starts.
    freeswitch: {
      image: FREESWITCH_IMAGE,
      restart: 'unless-stopped',
      depends_on: ['drachtio'],
      environment: {
        EXTERNAL_ADDRESS_FQDN: intent.voipDomain,
        FREESWITCH_PASSWORD: '',
        RTP_START_PORT: String(start),
        RTP_END_PORT: String(end),
        ACCEPT_EXTERNAL_CALLS: String(intent.pbx),
        USE_LEGACY_ARCH: 'false',
        DRACHTIO_DOMAIN: 'drachtio',
        DEBUG_MODE: 'false',
        INTERNAL_NUMBER_EXPRESSION: '^(\\d{4})$$',
        INTERNAL_DIALPLAN_INTERNAL_NUMBER_BRIDGE_STRING:
          'sofia/internal/$${dialed_extension}@$${domain_name}',
        // compose.freeswitch.external.yml, laid over the base file as Rocket.Chat's docs do.
        ...(intent.pbx ? externalEnv() : {}),
      },
      expose: [`${String(SIP_PORT)}/udp`, ...(intent.pbx ? [`${external}/udp`] : [])],
      // Host = container: FreeSWITCH names its own ports in what it tells the browser. The RTP
      // range on every address once voip_domain names one (`opensCallPorts`); 5080 stays on the
      // bind, since the PBX reaches it by name.
      ports: [
        `${opensCallPorts(intent.voipDomain) ? '0.0.0.0:' : ''}${range}:${range}/udp`,
        ...(intent.pbx ? [`${external}:${external}/udp`] : []),
      ],
      ...(intent.fsDialplan === 'edit' ? { volumes: [...FS_DIALPLAN_MOUNTS] } : {}),
    },
  };
}

/** The scenario card's guide: who to sign in as, what to try, what to know, for this lab. */
function voiceGuide(intent: Intent): PresetGuide {
  const stack = intent.sip ? ' with the SIP integration (Drachtio and FreeSWITCH)' : '';
  const lab = intent.pbx ? ' and a lab PBX' : '';
  return guide('voice', {
    summary: `Rocket.Chat Voice, calls between users${stack}${lab}; needs a license with the Voice add-on.`,
    signIn: Object.entries(VOICE_TEST_USERS).map(([user, extension]) => [
      user,
      user,
      intent.sip ? `extension ${extension}` : '',
    ]),
    steps: [
      'Open Rocket.Chat over HTTPS, or at localhost in a browser on the machine running houston.',
      'Sign in as both users in separate browser profiles, open a direct message between them, and press the call button.',
      intent.sip ? 'Dial 123 from the keypad: FreeSWITCH answers with an echo test.' : '',
      intent.pbx
        ? 'Ring voice-bob from the PBX: docker exec houston-<name>-pbx-1 asterisk -rx "channel originate Local/1002@from-outside application Echo".'
        : intent.sip
          ? "Ring voice-bob from FreeSWITCH: docker exec houston-<name>-freeswitch-1 fs_cli -x 'originate {media_webrtc=true}sofia/internal/1002@drachtio &echo'."
          : '',
    ],
    know: [
      'Without a license with the Voice add-on (teams-voip) there is no call button: add one when creating (--license, or the Enterprise license field), or later in Rocket.Chat under Administration → Subscription; then houston ready --name <name> (in the GUI: take it down, then bring it up) gives the extensions.',
      'On a plain-HTTP address other than localhost the browser withholds the microphone, and Rocket.Chat 8.8.1 shows "Application Error".',
      intent.sip
        ? intent.voipDomain === 'freeswitch'
          ? "SIP audio reaches a browser on the machine running houston only; for other computers set voip_domain to the server's LAN or public IP."
          : opensCallPorts(intent.voipDomain)
            ? `FreeSWITCH advertises ${intent.voipDomain}; houston opens the RTP ports on every address of the machine running houston, so browsers elsewhere reach it over UDP.`
            : `FreeSWITCH advertises ${intent.voipDomain}; only a browser on the machine running houston reaches it.`
        : '',
      intent.pbx
        ? 'PBX numbers: 22101 rings 10 s then answers, 22102 never, 22103 busy, 22104 at once; ring groups 23000 and 23001; 5550000 echo, 5550001 rings forever, 5550002 busy; softphone accounts 22001 to 22004 (password = number).'
        : '',
      intent.pbx
        ? 'The lab files are in the workspace folder under voice/; the Voice guide, linked above, has the eight test calls, the call flow and the editable dialplans.'
        : '',
    ],
  });
}

function adapter(intent: Intent): Preset {
  const users = Object.keys(VOICE_TEST_USERS).join(', ');
  const preset: Preset = {
    ...emptyPreset('voice'),
    description:
      // One sentence: the GUI's create dialog shows only the first.
      'Rocket.Chat Voice, which needs a license with the Voice add-on: calls between users in ' +
      'the browser, with test users; SIP integration (--set sip_integration=on) adds Drachtio and FreeSWITCH.',
    source: 'built-in (scenario)',
    scenario: 'voice',
    scenarioParams: { ...intent },
    paramsHelp: { ...PARAMS_HELP },
    requiresLicense: true,
    // The test users' emails are verified, so Rocket.Chat asks them for an emailed code a repro
    // has no mail server to send; composed with `email`, Mailpit catches it and email's value wins.
    env: {
      [EMAIL_2FA]: 'false',
      ...(intent.iceServers === ''
        ? {}
        : { OVERWRITE_SETTING_VoIP_TeamCollab_Ice_Servers: intent.iceServers }),
    },
    softEnv: [EMAIL_2FA],
    postReady: [{ action: 'voice_users', extensions: intent.sip }],
    guides: [voiceGuide(intent)],
    notes: [
      `Voice test users: ${users}, each with its username as its password. Sign in as both in separate browser profiles, open a direct message between them, and press the call button.`,
      'Voice needs a license with the Voice add-on (teams-voip); without one Rocket.Chat shows no call button. Add one when creating (--license, or the Enterprise license field), or later in Rocket.Chat under Administration → Subscription.',
      'Open Rocket.Chat over HTTPS, or at localhost in a browser on the machine running houston. On a plain-HTTP address elsewhere the browser withholds the microphone, and Rocket.Chat 8.8.1 shows "Application Error" for the whole page.',
      // A place line: the CLI prints it, the GUI's card makes it a link row.
      `Voice guide (the test calls, the PBX, the call flow): ${VOICE_GUIDE_URL}`,
    ],
  };
  if (!intent.sip) return preset;
  return {
    ...preset,
    env: {
      ...preset.env,
      OVERWRITE_SETTING_VoIP_TeamCollab_SIP_Integration_Enabled: 'true',
      OVERWRITE_SETTING_VoIP_TeamCollab_Drachtio_Host: 'drachtio',
      OVERWRITE_SETTING_VoIP_TeamCollab_Drachtio_Port: String(DRACHTIO_PORT),
      OVERWRITE_SETTING_VoIP_TeamCollab_Drachtio_Password: DRACHTIO_SECRET,
      OVERWRITE_SETTING_VoIP_TeamCollab_SIP_Server_Host: 'freeswitch',
      OVERWRITE_SETTING_VoIP_TeamCollab_SIP_Server_Port: String(SIP_PORT),
    },
    services: {
      ...sipServices(intent),
      ...(intent.pbx ? { pbx: pbxService(opensCallPorts(intent.voipDomain)) } : {}),
    },
    // Rocket.Chat needs only the SIP stack; the PBX starts after FreeSWITCH (its depends_on).
    dependsOn: ['drachtio', 'freeswitch'],
    ports: [
      ...Array.from({ length: intent.rtp[1] - intent.rtp[0] + 1 }, (_, i) => intent.rtp[0] + i),
      ...(intent.pbx ? [EXTERNAL_SIP_PORT, ...PBX_PORTS] : []),
    ],
    files: [
      ...(intent.pbx ? pbxFiles(intent.voipDomain) : []),
      ...(intent.fsDialplan === 'edit' ? fsDialplanFiles() : []),
    ],
    keepFiles: [
      ...(intent.pbx ? PBX_KEPT : []),
      ...(intent.fsDialplan === 'edit' ? FS_DIALPLANS : []),
    ],
    notes: [
      ...preset.notes,
      'SIP: once Voice is licensed, voice-alice gets extension 1001 and voice-bob 1002 (after a license applied later, houston ready --name <name> sets them; in the GUI, take it down and bring it up). Dial 123 for FreeSWITCH’s echo test (you hear yourself): Rocket.Chat → Drachtio → FreeSWITCH. Dialling 1002 rings voice-bob directly, as Rocket.Chat calls its own users itself.',
      "To ring voice-bob from the SIP side, as a PBX would: docker exec houston-<name>-freeswitch-1 fs_cli -x 'originate {media_webrtc=true}sofia/internal/1002@drachtio &echo'",
      intent.voipDomain === 'freeswitch'
        ? "SIP audio reaches a browser on the machine running houston only (FreeSWITCH advertises its container name). For browsers on other computers, as Rocket.Chat's docs set it up: --set voip_domain=<the server's LAN or public IP>; houston then opens the call ports on every address of the server."
        : opensCallPorts(intent.voipDomain)
          ? `FreeSWITCH advertises ${intent.voipDomain}, and houston opens UDP ${String(intent.rtp[0])}-${String(intent.rtp[1])} on every address of the machine running houston (only the call ports; Rocket.Chat's own port stays on the bind). Calls between users are not affected: their audio goes browser to browser.`
          : `FreeSWITCH advertises ${intent.voipDomain}: only a browser on the machine running houston reaches UDP ${String(intent.rtp[0])}-${String(intent.rtp[1])}. Calls between users are not affected: their audio goes browser to browser.`,
      ...(intent.pbx ? pbxNotes(intent.voipDomain) : []),
    ],
  };
}

/**
 * Rocket.Chat 7 has the older Team Voice Calls, with other settings and no Drachtio; a voice
 * workspace on it would not be what was asked for, so it is refused before anything is created.
 * A version that is not a number (a build tag) is let through, unknowable here.
 */
export function refuseVoiceBefore800(pre: Preset, rcVersion: string): void {
  if (!pre.postReady.some((action) => action.action === 'voice_users')) return;
  let release: number[];
  try {
    release = parseVersion(rcVersion).release;
  } catch {
    return;
  }
  if ((release[0] ?? 0) >= 8) return;
  throw new ValidationError(
    `the voice preset needs Rocket.Chat 8.0.0 or later; ${rcVersion} has the older Team Voice ` +
      'Calls. Choose a newer version.',
  );
}

const SCENARIO = new Scenario<Intent>({
  name: 'voice',
  paramsHelp: PARAMS_HELP,
  paramAliases: VOICE_PARAM_ALIASES,
  resolveIntent,
  adapters: {
    docker: adapter,
    // Settings and REST-created users work the same there; the SIP services have no manifests.
    kubernetes: (intent) => {
      if (intent.sip) throw new Error('voice sip_integration=on runs on Docker only');
      return adapter(intent);
    },
  },
});

export function scenario(): Scenario<Intent> {
  return SCENARIO;
}

export function build(params: Params): Preset {
  return SCENARIO.resolve(params, 'docker');
}

register('voice', build);
registerScenario('voice', SCENARIO);
