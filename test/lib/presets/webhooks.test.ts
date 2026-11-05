/**
 * The webhooks preset: a receiver Rocket.Chat posts to by name, an inbox page on this
 * machine, and one post-ready action that carries everything the handler needs.
 */
import * as config from '../../../src/lib/config';
import { safeLoadAll } from '../../../src/lib/presets/common';
import { load, loadMany, resolve } from '../../../src/lib/presets/index';

type Doc = Record<string, unknown>;

/** The receiver chooses the session when post-ready makes it: the text names a placeholder. */
const RECEIVER = `${config.WEBHOOKS_RECEIVER}/<session>`;

/** Walk a parsed manifest; a missing step is undefined rather than a throw. */
function g(value: unknown, ...keys: (string | number)[]): unknown {
  let here = value;
  for (const key of keys) {
    if (here === null || typeof here !== 'object') return undefined;
    here = (here as Record<string | number, unknown>)[key];
  }
  return here;
}

function docs(manifest: string | undefined): Doc[] {
  return safeLoadAll(manifest ?? '').filter((d): d is Doc => d !== null && typeof d === 'object');
}

function named(list: Doc[], kind: string, name: string): Doc | undefined {
  return list.find((d) => d.kind === kind && g(d, 'metadata', 'name') === name);
}

describe('the webhooks preset', () => {
  it('runs the receiver as one service Rocket.Chat reaches by name, its data in a volume', () => {
    const p = load('webhooks', {}, {});
    expect(p.services.webhooks).toEqual({
      image: 'ghcr.io/tarampampam/webhook-tester:2.3.0',
      restart: 'unless-stopped',
      // On disk, kept for the month the receiver allows at most: a recreated container (a
      // stale unit, up --force) keeps the session post-ready made and what it caught.
      environment: { AUTO_CREATE_SESSIONS: 'true', STORAGE_DRIVER: 'fs', SESSION_TTL: '744h' },
      volumes: ['webhooks_data:/data'],
      ports: ['8086:8080'],
    });
    expect(p.volumes).toEqual({ webhooks_data: { driver: 'local' } });
    expect(p.dependsOn).toEqual(['webhooks']);
    // Nothing by env: the Omnichannel settings are written post-ready, so they stay editable.
    expect(p.env).toEqual({});
    expect(p.ports).toEqual([8086]);
    expect(p.extra).toEqual({});
    expect(p.requiresLicense).toBe(false);
  });

  it('hands post-ready the two origins and the capture choice: the session is made there', () => {
    expect(load('webhooks', {}, {}).postReady).toEqual([
      {
        action: 'webhooks_setup',
        receiver: 'http://webhooks:8080',
        ui_url: 'http://localhost:8086',
        capture: 'off',
      },
    ]);
    // No fixed session anywhere: the receiver chooses it, so no URL in the action carries one.
    expect(JSON.stringify(load('webhooks', {}, {}).postReady)).not.toContain('/s/');
    expect(load('webhooks', { capture: 'all' }, {}).postReady[0]).toMatchObject({ capture: 'all' });
    expect(() => load('webhooks', { capture: 'bogus' }, {})).toThrow(/expects one of: off, all/u);
    expect(load('webhooks', {}, {}).paramsHelp).toEqual({
      capture: expect.stringContaining('(default off)') as string,
    });
  });

  it('follows the workspace to moved ports and names the preferred one nowhere', () => {
    const p = load('webhooks', {}, { webhooks: [8186] });
    expect(p.services.webhooks?.ports).toEqual(['8186:8080']);
    expect(p.postReady[0]?.ui_url).toBe('http://localhost:8186');
    expect(p.ports).toEqual([8186]);
    expect(JSON.stringify(p)).not.toContain('localhost:8086');
    const svc = named(docs(p.kubernetesManifests[0]), 'Service', 'webhooks');
    expect(g(svc, 'metadata', 'labels', 'houston.io/ui-port')).toBe('8186');
  });

  it('is the same workload on Kubernetes: Ready when /ready answers, a Service on 8080, a claim it can write', () => {
    const k = resolve('webhooks', 'kubernetes', {}, {});
    expect(k.ports).toEqual([8086]);
    const all = docs(k.kubernetesManifests[0]);
    const dep = named(all, 'Deployment', 'webhooks');
    const pod = g(dep, 'spec', 'template', 'spec');
    const container = g(pod, 'containers', 0);
    expect(g(container, 'image')).toBe('ghcr.io/tarampampam/webhook-tester:2.3.0');
    expect(g(container, 'readinessProbe', 'httpGet', 'path')).toBe('/ready');
    expect(JSON.stringify(container)).toContain('STORAGE_DRIVER');
    expect(g(container, 'volumeMounts')).toEqual([{ name: 'data', mountPath: '/data' }]);
    expect(g(pod, 'volumes')).toEqual([
      { name: 'data', persistentVolumeClaim: { claimName: 'webhooks-data' } },
    ]);
    // The image runs as 10001, and a provisioned filesystem is root's: the group makes it
    // writable, or every request would be a 500 on EKS (kind's local path is 0777).
    expect(g(pod, 'securityContext')).toEqual({ fsGroup: 10001 });
    expect(g(dep, 'spec', 'strategy')).toEqual({ type: 'Recreate' });
    expect(named(all, 'PersistentVolumeClaim', 'webhooks-data')).toBeDefined();
    const svc = named(all, 'Service', 'webhooks');
    expect((g(svc, 'spec', 'ports') as { port: number }[]).map((p) => p.port)).toContain(8080);
    expect(g(svc, 'metadata', 'labels', 'houston.io/ui-port')).toBe('8086');
  });

  it('tells the reader where the inbox is, that it is local, and what 9.0 changed', () => {
    const p = load('webhooks', {}, {});
    expect(p.description.split('. ')[0]).toMatch(/inbox/u);
    // The receiver chooses the session when post-ready makes it, so no note carries a URL
    // for it (a `/s/<session>` placeholder would be a broken link in the GUI); the live
    // link is the links row and the Webhooks card (`notes.inboxUrl`).
    expect(p.notes[0]).toMatch(/^Webhook inbox: [^h]/u);
    expect(p.notes[0]).not.toContain('http');
    expect(p.notes[0]).toContain('houston info');
    expect(JSON.stringify(p)).not.toContain('/s/');
    expect(JSON.stringify(p)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
    const notes = p.notes.join('\n');
    expect(notes).toContain('machine running houston');
    expect(notes).toContain(RECEIVER);
    expect(notes).toContain('capture=all');
    expect(notes).toContain('9.0.0');
    // What the inbox answers, because an empty body is a failed call to Rocket.Chat.
    expect(notes).toContain('{"captured": true}');
    const [guide] = p.guides;
    expect(guide?.name).toBe('webhooks');
    expect(guide?.steps.join('\n')).toContain('History');
    const know = guide?.know.join('\n') ?? '';
    for (const word of ['HTTPS', '500', '9.0']) expect(know).toContain(word);
    // The card replaces the prose notes, so the address Rocket.Chat posts to and the
    // Omnichannel token must be on the card too -- and a session URL copied from the inbox
    // UI says localhost, which inside the workspace network is the wrong host.
    expect(know).toContain(RECEIVER);
    expect(know).toContain("'houston'");
    // The receiver's own words: the button is "New URL", and its dialog destroys the
    // current session -- houston's -- unless told not to.
    for (const text of [know, notes]) {
      expect(text).toMatch(/New URL[^\n]*Destroy current session[^\n]*webhooks:8080/u);
    }
  });

  it('composes with livechat, its post-ready action after the agent setup', () => {
    const both = loadMany(['livechat', 'webhooks'], {}, 'docker', new Set(), {});
    expect(Object.keys(both.services)).toEqual(expect.arrayContaining(['webhooks', 'widget-site']));
    expect(both.postReady.map((a) => a.action)).toEqual(['livechat_setup', 'webhooks_setup']);
  });
});
