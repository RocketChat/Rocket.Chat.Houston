import { ValidationError } from '../../../src/lib/errors';
import { EMAIL_2FA } from '../../../src/lib/presets/common';
import { load, loadMany, resolve, scenarioNames } from '../../../src/lib/presets/index';
import { type Preset } from '../../../src/lib/presets/types';
import {
  refuseVoiceBefore800,
  VOICE_PARAM_ALIASES,
  VOICE_TEST_USERS,
} from '../../../src/lib/presets/voice';

/** The Voice settings a preset writes, without the prefix. */
function voiceSettings(params: Record<string, unknown> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(load('voice', params).env)
      .filter(([key]) => key.startsWith('OVERWRITE_SETTING_VoIP_TeamCollab_'))
      .map(([key, value]) => [key.slice('OVERWRITE_SETTING_'.length), value]),
  );
}

describe('the voice preset', () => {
  it('needs only a licence and two users for calls between users', () => {
    // A call's audio goes browser to browser; Rocket.Chat 8 has no Voice on/off setting.
    const preset = load('voice');
    expect([preset.services, preset.ports, preset.dependsOn, voiceSettings()]).toEqual([
      {},
      [],
      [],
      {},
    ]);
    expect(preset.requiresLicense).toBe(true);
    expect(preset.postReady).toEqual([{ action: 'voice_users', extensions: false }]);
    expect(Object.keys(VOICE_TEST_USERS)).toEqual(['voice-alice', 'voice-bob']);
    const notes = preset.notes.join('\n');
    expect(notes).toContain('voice-alice, voice-bob');
    expect(notes).toContain('Voice add-on');
  });

  it('links the shipped guide where it is read online, as a place line', () => {
    // The CLI prints the line; the GUI's card reads "Name: url" as a link row.
    for (const params of [{}, { sip_integration: 'on', pbx: 'on' }]) {
      expect(load('voice', params).notes).toContain(
        'Voice guide (the test calls, the PBX, the call flow): https://github.com/RocketChat/Rocket.Chat.Houston/blob/main/data/docs/voice.md',
      );
    }
  });

  it('says it needs a licence in the part of its description the create dialog shows', () => {
    // The GUI's create dialog shows a description's first sentence (options.js firstSentence).
    const firstSentence = (d: string): string => (/^.*?[.!?](?=\s|$)/u.exec(d) ?? [d])[0];
    expect(firstSentence(load('voice').description)).toContain('license with the Voice add-on');
  });

  it('gives the GUI no false default for ice_servers', () => {
    // The GUI turns "(default X" into a placeholder; "Rocket.Chat's" read as a value.
    expect(load('voice').paramsHelp.ice_servers).not.toMatch(/\(default /u);
  });

  it('lets the test users sign in: email two-factor off unless Mailpit is there', () => {
    // Their emails are verified, so Rocket.Chat asks them for an emailed code a repro has no
    // mail server to send (measured on rc-l: totp-required, codeGenerated false).
    const preset = load('voice');
    expect(preset.env[EMAIL_2FA]).toBe('false');
    expect(preset.softEnv).toEqual([EMAIL_2FA]);
    expect(load('voice', { sip_integration: 'on' }).env[EMAIL_2FA]).toBe('false');
    expect(loadMany(['voice', 'email'], {}, 'docker').env[EMAIL_2FA]).toBe('true');
  });

  it('with sip_integration=on adds Drachtio and FreeSWITCH and points Rocket.Chat at them', () => {
    expect(voiceSettings({ sip_integration: 'on' })).toEqual({
      VoIP_TeamCollab_SIP_Integration_Enabled: 'true',
      VoIP_TeamCollab_Drachtio_Host: 'drachtio',
      VoIP_TeamCollab_Drachtio_Port: '9022',
      VoIP_TeamCollab_Drachtio_Password: 'houston',
      VoIP_TeamCollab_SIP_Server_Host: 'freeswitch',
      VoIP_TeamCollab_SIP_Server_Port: '5060',
    });
    const preset = load('voice', { sip_integration: 'on' });
    expect(Object.keys(preset.services).sort()).toEqual(['drachtio', 'freeswitch']);
    expect(preset.dependsOn).toEqual(['drachtio', 'freeswitch']);
  });

  it("runs Drachtio as rocketchat-compose's compose.drachtio.yml does", () => {
    // Same image, command and environment; never published (docs: reachable only by
    // Rocket.Chat and the SIP provider).
    expect(load('voice', { sip_integration: 'on' }).services.drachtio).toEqual({
      image: 'docker.io/drachtio/drachtio-server:latest',
      restart: 'unless-stopped',
      expose: [9022, '5060/udp'],
      environment: {
        DRACHTIO_ADMIN_TCP_PORT: '9022',
        DRACHTIO_SECRET: 'houston',
        DRACHTIO_LOGLEVEL: 'info',
        DRACHTIO_SOFIA_LOGLEVEL: '3',
      },
      command: 'drachtio --contact "sip:*;transport=udp"',
    });
  });

  it("runs FreeSWITCH as rocketchat-compose's compose.freeswitch.yml does", () => {
    // Same image and every variable, the compose escapes written as that file writes them, and
    // the RTP range published (host = container: FreeSWITCH names its own ports in the SDP).
    // houston adds only depends_on (FreeSWITCH resolves the drachtio name once, at startup).
    expect(load('voice', { sip_integration: 'on' }).services.freeswitch).toEqual({
      image: 'docker.io/rocketchat/freeswitch:latest',
      restart: 'unless-stopped',
      depends_on: ['drachtio'],
      environment: {
        EXTERNAL_ADDRESS_FQDN: 'freeswitch',
        FREESWITCH_PASSWORD: '',
        RTP_START_PORT: '20000',
        RTP_END_PORT: '20046',
        ACCEPT_EXTERNAL_CALLS: 'false',
        USE_LEGACY_ARCH: 'false',
        DRACHTIO_DOMAIN: 'drachtio',
        DEBUG_MODE: 'false',
        INTERNAL_NUMBER_EXPRESSION: '^(\\d{4})$$',
        INTERNAL_DIALPLAN_INTERNAL_NUMBER_BRIDGE_STRING:
          'sofia/internal/$${dialed_extension}@$${domain_name}',
      },
      expose: ['5060/udp'],
      ports: ['20000-20046:20000-20046/udp'],
    });
    expect(load('voice', { sip_integration: 'on' }).ports).toEqual(
      Array.from({ length: 47 }, (_, i) => 20000 + i),
    );
  });

  it('takes VOIP_DOMAIN and the RTP range as voip_domain and rtp_ports', () => {
    const preset = load('voice', {
      sip_integration: 'on',
      voip_domain: 'voip.example.com',
      rtp_ports: '21000-21010',
    });
    const fs = preset.services.freeswitch ?? {};
    expect(fs.environment).toMatchObject({
      EXTERNAL_ADDRESS_FQDN: 'voip.example.com',
      RTP_START_PORT: '21000',
      RTP_END_PORT: '21010',
    });
    // On every address: a VoIP domain is where browsers elsewhere send their audio.
    expect(fs.ports).toEqual(['0.0.0.0:21000-21010:21000-21010/udp']);
    expect(preset.ports).toEqual(Array.from({ length: 11 }, (_, i) => 21000 + i));
    expect(
      load('voice', { sip_integration: 'on', voip_domain: '203.0.113.7' }).services.freeswitch
        ?.environment,
    ).toMatchObject({ EXTERNAL_ADDRESS_FQDN: '203.0.113.7' });
  });

  it("keeps voip_domain and both presets' ports when composed with email", () => {
    const composed = loadMany(
      ['email', 'voice'],
      { voice: { sip_integration: 'on', voip_domain: 'voip.example.com' } },
      'docker',
    );
    expect(composed.services.freeswitch?.environment).toMatchObject({
      EXTERNAL_ADDRESS_FQDN: 'voip.example.com',
    });
    expect(composed.ports).toEqual(expect.arrayContaining([8025, 20000, 20046]));
  });

  it('writes ice_servers into the Ice Servers setting, with or without SIP', () => {
    const servers = 'stun:stun.example.com:3478,u:p@turn:turn.example.com:3478';
    for (const params of [
      { ice_servers: servers },
      { sip_integration: 'on', ice_servers: servers },
    ]) {
      expect(voiceSettings(params)).toMatchObject({ VoIP_TeamCollab_Ice_Servers: servers });
    }
    expect(voiceSettings({ sip_integration: 'on' })).not.toHaveProperty(
      'VoIP_TeamCollab_Ice_Servers',
    );
  });

  it('gives the users extensions with sip_integration=on, and says how to try the SIP path', () => {
    const preset = load('voice', { sip_integration: 'on' });
    expect(preset.postReady).toEqual([{ action: 'voice_users', extensions: true }]);
    expect(VOICE_TEST_USERS).toEqual({ 'voice-alice': '1001', 'voice-bob': '1002' });
    const notes = preset.notes.join('\n');
    expect(notes).toContain('123');
    expect(notes).toContain('1002');
    // A note is printed whatever post-ready managed: it must not claim extensions were given.
    expect(notes).not.toContain('voice-alice has extension');
    // Dialling a user's extension is answered by Rocket.Chat itself (measured on 8.8.1: no
    // INVITE reached Drachtio); ringing a user over SIP is an inbound call, from FreeSWITCH.
    expect(notes).not.toContain('to ring voice-bob through Drachtio');
    expect(notes).toContain(
      "docker exec houston-<name>-freeswitch-1 fs_cli -x 'originate {media_webrtc=true}sofia/internal/1002@drachtio &echo'",
    );
    expect(notes).toContain('a browser on the machine running houston only');
  });

  it('runs calls between users on Kubernetes, and refuses sip_integration=on there', () => {
    expect(scenarioNames()).toContain('voice');
    expect(resolve('voice', 'kubernetes', {}).services).toEqual({});
    expect(() => resolve('voice', 'kubernetes', { sip_integration: 'on' })).toThrow(
      'voice sip_integration=on runs on Docker only',
    );
  });

  // A plain Error, as every preset's: `up` turns it into the usage error (exit 2).
  it.each([
    [{ sip_integration: 'maybe' }, "--set sip_integration='maybe' expects one of: off, on"],
    [
      { ring: 'on' },
      "unknown --set param(s) for preset 'voice': ring - valid: freeswitch_dialplans, ice_servers, pbx, rtp_ports, sip_integration, voip_domain",
    ],
    [
      { sip_integration: 'on', voip_domain: 'https://voip.example.com' },
      "--set voip_domain='https://voip.example.com' expects a hostname or IPv4 address",
    ],
    [
      { sip_integration: 'on', voip_domain: 'voip.example.com:5060' },
      "--set voip_domain='voip.example.com:5060' expects a hostname or IPv4 address",
    ],
    [
      { sip_integration: 'on', rtp_ports: '20046-20000' },
      "--set rtp_ports='20046-20000' expects start-end, start below end, both from 1024 to 65535, at most 200 ports",
    ],
    [
      { sip_integration: 'on', rtp_ports: '80-90' },
      "--set rtp_ports='80-90' expects start-end, start below end, both from 1024 to 65535, at most 200 ports",
    ],
    [
      { sip_integration: 'on', rtp_ports: '20000-40000' },
      "--set rtp_ports='20000-40000' expects start-end, start below end, both from 1024 to 65535, at most 200 ports",
    ],
    [
      { sip_integration: 'on', voip_domain: 'voip..example.com' },
      "--set voip_domain='voip..example.com' expects a hostname or IPv4 address",
    ],
    [
      { ice_servers: 'u:pa$w@turn:turn.example.com:3478' },
      // The refusal reaches houston.log and the GUI's Activity: it must not carry the password.
      "--set ice_servers entry 'u:********@turn:turn.example.com:3478' is not [user:password@]stun:, turn: or turns:host:port",
    ],
    [
      { voip_domain: 'voip.example.com' },
      '--set voip_domain has an effect only with sip_integration=on',
    ],
    [{ rtp_ports: '21000-21010' }, '--set rtp_ports has an effect only with sip_integration=on'],
    [
      { ice_servers: 'stun.example.com:3478' },
      "--set ice_servers entry 'stun.example.com:3478' is not [user:password@]stun:, turn: or turns:host:port",
    ],
  ])('refuses %j, saying what it takes', (params, said) => {
    expect(() => load('voice', params)).toThrow(said);
  });
});

describe("the voice preset's 2.1.3 names", () => {
  it('lists the official names only, and keeps the 2.1.3 names as aliases', () => {
    // `houston presets`, the GUI and the skill read paramsHelp: one vocabulary, the one
    // Rocket.Chat's settings and compose files use. The aliases are read, never listed.
    const preset = load('voice');
    expect(Object.keys(preset.paramsHelp)).toEqual([
      'sip_integration',
      'voip_domain',
      'rtp_ports',
      'ice_servers',
      'pbx',
      'freeswitch_dialplans',
    ]);
    expect(preset.paramAliases).toEqual(VOICE_PARAM_ALIASES);
    expect(VOICE_PARAM_ALIASES).toEqual({
      sip: 'sip_integration',
      fs_dialplan: 'freeswitch_dialplans',
    });
  });

  it('takes sip and fs_dialplan as sip_integration and freeswitch_dialplans', () => {
    // A 2.1.3 command, a workspace record or a bundle from that release names them so.
    const pick = (p: Preset): unknown[] => [
      p.services,
      p.env,
      p.files,
      p.keepFiles,
      p.ports,
      p.postReady,
    ];
    expect(pick(load('voice', { sip: 'on', pbx: 'on', fs_dialplan: 'edit' }))).toEqual(
      pick(load('voice', { sip_integration: 'on', pbx: 'on', freeswitch_dialplans: 'edit' })),
    );
    expect(() => resolve('voice', 'kubernetes', { sip: 'on' })).toThrow('runs on Docker only');
  });

  it('refuses both spellings of one option in one request', () => {
    expect(() => load('voice', { sip: 'on', sip_integration: 'off' })).toThrow(
      '--set sip is the earlier spelling of sip_integration; give one of them',
    );
  });
});

describe('the voice preset on a Rocket.Chat before 8.0.0', () => {
  const voice = load('voice');

  it.each(['7.13.0', '7.10.0', '6.0.0'])('is refused on %s, naming the version it needs', (v) => {
    expect(() => refuseVoiceBefore800(voice, v)).toThrow(
      new ValidationError(
        `the voice preset needs Rocket.Chat 8.0.0 or later; ${v} has the older Team Voice Calls. ` +
          'Choose a newer version.',
      ),
    );
  });

  it.each(['8.0.0', '8.7.0', '9.0.0', 'develop'])('is let through on %s', (v) => {
    expect(() => refuseVoiceBefore800(voice, v)).not.toThrow();
  });

  it('leaves every other preset alone on an old version', () => {
    expect(() => refuseVoiceBefore800(load('email'), '6.0.0')).not.toThrow();
  });
});
