import * as fs from 'node:fs';
import * as path from 'node:path';

import * as presets from '../../../src/lib/presets/index';
import { kube, ownedKubeconfig } from '../../../src/core/kube/exec';
import { CONTEXT as KUBE_CONTEXT } from '../../../src/core/kube/names';
import * as paths from '../../../src/core/runner/paths';
import { type Metadata, metadata } from '../../../src/core/runner/record';

import { summary } from '../../../src/core/lifecycle/inspect';
import {
  type NoteGroup,
  flattenNotes,
  noteGroup,
  noteGroupsOf,
  scenarioGroup,
} from '../../../src/core/lifecycle/notes';

describe('note groups', () => {
  it('renders the flat form byte for byte against earlier releases', () => {
    // Indentation is the contract the flat form has: a four-space line is something to
    // paste, and the CLI and the browser both parse it. The padding counts CODE POINTS, which
    // is why this is compared rather than assumed.
    // What earlier releases built and flattened for the same four groups, recorded.
    const recorded = {
      groups: [
        {
          title: 'G',
          kind: 'k',
          rows: [
            ['a', 1],
            ['muchlonger', 'x'],
          ],
          body: ['b'],
          commands: ['c'],
          guides: [],
        },
        { title: 'Empty', kind: '', rows: [], body: [], commands: [], guides: [] },
        { title: 'Bare', kind: '', rows: [], body: [], commands: ['one'], guides: [] },
        {
          title: 'Unicode',
          kind: '',
          rows: [
            ['λ', 1],
            ['wide', 2],
          ],
          body: [],
          commands: [],
          guides: [],
        },
      ],
      flat: [
        'G:',
        '    a           1',
        '    muchlonger  x',
        'b',
        '    c',
        'Empty:',
        'Bare:',
        '    one',
        'Unicode:',
        '    λ     1',
        '    wide  2',
      ],
    };
    const groups = [
      noteGroup('G', {
        rows: [
          ['a', 1],
          ['muchlonger', 'x'],
        ],
        body: ['b'],
        commands: ['c'],
        kind: 'k',
      }),
      noteGroup('Empty'),
      noteGroup('Bare', { commands: ['one'] }),
      noteGroup('Unicode', {
        rows: [
          ['λ', 1],
          ['wide', 2],
        ],
      }),
    ];
    expect(groups).toEqual(recorded.groups);
    expect(flattenNotes(groups)).toEqual(recorded.flat);
  });

  it('drops nothing a builder put in and keeps the three sections apart', () => {
    const group = noteGroup('Title', {
      rows: [['key', 'value']],
      body: ['know'],
      commands: ['paste'],
    });
    expect(group).toEqual({
      title: 'Title',
      kind: '',
      rows: [['key', 'value']],
      body: ['know'],
      commands: ['paste'],
      guides: [],
    });
    expect(flattenNotes([group])).toEqual(['Title:', '    key  value', 'know', '    paste']);
  });

  it("carries the presets' guides to the card, and none unless every preset wrote one", () => {
    // The scenario card reads a guide per preset; a YAML preset has none, and then the card
    // falls back to reading the notes, so a half-guided workspace is not half-rendered.
    expect(scenarioGroup(record({ preset: 'e2ee' }))[0]?.guides.map((g) => g.name)).toEqual([
      'e2ee',
    ]);
    expect(scenarioGroup(record({ preset: 'email+ldap' }))[0]?.guides.map((g) => g.name)).toEqual([
      'email',
      'ldap',
    ]);
    expect(scenarioGroup(record({ preset: 'airgapped+email' }))[0]?.guides).toEqual([]);
    // The CLI's flat form says nothing of it.
    expect(flattenNotes(scenarioGroup(record({ preset: 'e2ee' }))).join('\n')).not.toContain(
      'guides',
    );
  });
});

function record(values: Partial<Metadata>): Metadata {
  return metadata({
    rcVersion: '8.5.1',
    rcImage: 'i',
    mongoTag: '8.0',
    mongoFlavor: 'official',
    preset: 'default',
    rootUrl: 'http://localhost:3000',
    hostPort: 3000,
    versionSource: 'map',
    ...values,
  });
}

/** A Kubernetes workspace record, as `repro.json` holds one. */
function k8sMeta(extra: Record<string, unknown> = {}): Metadata {
  return record({
    name: 'old',
    project: 'houston-old',
    extra: {
      runtime: 'kubernetes',
      deployment: 'microservices',
      namespace: 'houston-old',
      context: 'kind-houston-local',
      release: 'rocketchat',
      bind_host: '127.0.0.1',
      mongo_managed_by: 'statefulset',
      mongo_image: 'mongo:8.0',
      ...extra,
    },
  });
}

const titled = (groups: readonly NoteGroup[]): Record<string, NoteGroup> =>
  Object.fromEntries(groups.map((group) => [group.title, group]));
const bodyOf = (groups: readonly NoteGroup[]): string =>
  groups.flatMap((group) => group.body).join(' ');

describe('which notes a record produces', () => {
  it('leaves no stray heading for an empty group, and no heading for an untitled one', () => {
    // A group is built unconditionally and filled conditionally -- the operator note only
    // exists on one MongoDB path.
    expect(flattenNotes([noteGroup('Monitoring')])).toEqual(['Monitoring:']);
    expect(flattenNotes([])).toEqual([]);
    expect(flattenNotes([noteGroup('', { body: ['a bare line'] })])).toEqual(['a bare line']);
  });

  it("groups a compose workspace's add-ons, and a plain one gets no empty sections", async () => {
    // The edge lines and the monitoring block were appended to one flat list, so a
    // monitored workspace behind HTTPS had five unrelated bullets in a row. Same words,
    // three sections -- and derived, so an older record gets them as well.
    const meta = record({
      name: 'c',
      project: 'houston-c',
      publicUrl: 'https://c.example.test',
      extra: { edge: true, tls: 'local', monitoring: true },
    });
    const groups = titled(await noteGroupsOf(meta));
    expect(Object.keys(groups)).toEqual(['HTTPS', 'Monitoring']);
    expect((groups.HTTPS?.body ?? []).join(' ')).toContain('https://c.example.test');
    expect((groups.Monitoring?.body ?? []).some((note) => note.includes('Grafana'))).toBe(true);
    meta.extra = {};
    meta.publicUrl = '';
    expect(await noteGroupsOf(meta)).toEqual([]);
  });

  it("names a second workspace's own Mailpit and monitoring ports, never the preferred ones", async () => {
    // The notes are built again on every read: built on the registry, a second email
    // workspace's said localhost:8025 -- the first workspace's inbox.
    const groups = await noteGroupsOf(
      record({
        name: 'second',
        project: 'houston-second',
        preset: 'email',
        extra: {
          runtime: 'docker',
          side_ports: { email: [8026] },
          monitoring: true,
          monitoring_ports: [9091, 5051],
        },
      }),
    );
    const text = flattenNotes(groups).join('\n');
    expect(text).toContain('http://localhost:8026');
    expect(text).toContain('http://localhost:5051');
    expect(text).toContain('http://localhost:9091');
    expect(text).not.toMatch(/localhost:(8025|5050|9090)\b/u);
  });

  it("says which host a shared workspace's preset pages are on, and only when they need it", async () => {
    // phpLDAPadmin, MinIO's console, Mailpit's inbox and the livechat page all print
    // `localhost`, written when the browser was assumed to be on the docker host. On a
    // workspace bound wide or given a public URL, `localhost` names the reader's own
    // machine. A preset builder never sees the bind or the URL, so the record corrects it.
    const ldap = (extra: Record<string, unknown>) =>
      record({
        name: 'w',
        project: 'p',
        preset: 'ldap',
        rootUrl: 'http://localhost:3007',
        hostPort: 3007,
        versionSource: 't',
        extra,
      });
    const shared = bodyOf(
      await noteGroupsOf(
        ldap({
          sidecar_ports: [8082],
          bind_host: '0.0.0.0',
          advertised_url: 'http://box.example.com:3007',
        }),
      ),
    );
    expect(shared).toContain('box.example.com:8082');
    // Name the thing being corrected, not just the fix.
    expect(shared).toContain('localhost');
    // Bound wide with no URL given: the host is unknown, so it is not invented.
    expect(
      bodyOf(await noteGroupsOf(ldap({ sidecar_ports: [8082], bind_host: '0.0.0.0' }))),
    ).toContain('<this-box>:8082');
    const heading = "Reaching this preset's own pages";
    // An ordinary laptop workspace gains nothing: localhost really is localhost...
    expect(
      (await noteGroupsOf(ldap({ sidecar_ports: [8082], bind_host: '127.0.0.1' }))).map(
        (g) => g.title,
      ),
    ).not.toContain(heading);
    // ...and a preset with no pages of its own has nothing to correct.
    expect((await noteGroupsOf(ldap({ bind_host: '0.0.0.0' }))).map((g) => g.title)).not.toContain(
      heading,
    );
    // THE CORRECTION MUST NOT DESCRIBE TEXT THAT IS NOT THERE: a saml workspace with a
    // derived idp_host already prints the real host, and the first version told its reader
    // "the URLs above say localhost" about notes that said no such thing.
    const saml = await noteGroupsOf(
      record({
        name: 's',
        project: 'p',
        preset: 'saml',
        rootUrl: 'http://localhost:3007',
        hostPort: 3007,
        versionSource: 't',
        extra: {
          sidecar_ports: [8081],
          bind_host: '0.0.0.0',
          advertised_url: 'http://box.example.com:3007',
          params: { idp_host: 'box.example.com' },
        },
      }),
    );
    expect(saml.map((group) => group.title)).not.toContain(heading);
    expect(bodyOf(saml)).not.toContain('localhost');
  });

  it('names the one address a workspace bound to it publishes its pages on', async () => {
    // `--bind 172.16.0.2` publishes Mailpit on that address alone, where the link already
    // pointed, while the text said `http://localhost:8025` -- nothing answers there, on this
    // box either -- and offered `<this-box>` as the way round.
    const groups = await noteGroupsOf(
      record({
        name: 'g1',
        project: 'p',
        preset: 'email',
        rootUrl: 'http://172.16.0.2:3000',
        hostPort: 3000,
        versionSource: 't',
        extra: { runtime: 'docker', sidecar_ports: [8025], bind_host: '172.16.0.2' },
      }),
    );
    const reach = groups.find((group) => group.title === "Reaching this preset's own pages");
    expect(reach?.body.join(' ')).toContain('Use 172.16.0.2 instead: http://172.16.0.2:8025.');
    expect(reach?.body.join(' ')).not.toContain('<this-box>');
    expect(reach?.body.join(' ')).not.toContain('From anywhere but this box');
  });

  it("carries the preset's notes derived on every read, not the copy the record froze", async () => {
    // A note written into repro.json at create time kept its wording for the life of the
    // workspace -- which is how a Kubernetes workspace went on saying `backup` had no path
    // on that runtime for three releases after it grew one.
    const s = await summary(
      record({
        name: 'x',
        project: 'houston-x',
        preset: 'oidc',
        extra: { notes: ['a sentence some older release wrote down'] },
      }),
    );
    expect(s.notes).toEqual(
      flattenNotes([
        noteGroup('Preset · oidc', { kind: 'scenario', body: presets.load('oidc', {}).notes }),
      ]),
    );
    expect(s.notes).not.toContain('a sentence some older release wrote down');
    // The scenario has to be MARKED as one: the panel feeds it into its links card.
    expect((s.note_groups as NoteGroup[]).map((group) => group.kind)).toEqual(['scenario']);
    expect((s.notes as string[]).some((note) => note.includes('/etc/hosts'))).toBe(true);
  });

  it('names a managed cluster by its short name and region, and says it bills', async () => {
    // The Cluster row held the sixty-character ARN; the panel and `info` showed it as
    // the only way to learn where a workspace ran, and nothing said the cluster costs.
    const rowsFor = async (context: string): Promise<[string, string][]> =>
      ((
        await noteGroupsOf(
          record({
            name: 'w',
            project: 'houston-w',
            rcImage: 'registry.rocket.chat/rocketchat/rocket.chat:8.5.1',
            mongoFlavor: 'community',
            versionSource: 'shipped',
            extra: {
              runtime: 'kubernetes',
              namespace: 'houston-w',
              context,
              deployment: 'monolith',
            },
          }),
        )
      ).find((group) => group.title === 'Kubernetes')?.rows ?? []) as [string, string][];
    const eks = await rowsFor('arn:aws:eks:us-east-1:1:cluster/support');
    expect(eks).toContainEqual(['Cluster', 'support · us-east-1 · EKS']);
    expect(eks.find(([key]) => key === 'Costs')?.[1]).toContain('bills by the hour');
    // The local cluster reads as it always did, and costs nothing.
    const kind = await rowsFor(KUBE_CONTEXT);
    expect(kind).toContainEqual(['Cluster', KUBE_CONTEXT]);
    expect(kind.some(([key]) => key === 'Costs')).toBe(false);
  });

  it('counts the pods its namespace runs, and counts nothing when the cluster does not answer', async () => {
    // `info` said "5 for Rocket.Chat and MongoDB" beside a chart-7.0.2 monolith's two pods:
    // what the chart runs differs by chart version, so the number is read, never predicted.
    const realRun = kube.run;
    const podsOf = async (answer: Record<string, unknown>[] | null): Promise<string> => {
      kube.run = (argv) =>
        Promise.resolve(
          answer === null
            ? { argv, returncode: 1, stdout: '', stderr: 'Unable to connect to the server' }
            : { argv, returncode: 0, stdout: JSON.stringify({ items: answer }), stderr: '' },
        );
      try {
        return ((
          await noteGroupsOf(
            record({
              name: 'w',
              project: 'houston-w',
              preset: 'ldap',
              extra: { runtime: 'kubernetes', namespace: 'houston-w', deployment: 'monolith' },
            }),
          )
        )
          .find((group) => group.title === 'Kubernetes')
          ?.rows.find(([key]) => key === 'Pods')?.[1] ?? '') as string;
      } finally {
        kube.run = realRun;
      }
    };
    const pod = (name: string, phase: string) => ({ metadata: { name }, status: { phase } });
    expect(await podsOf([pod('mongodb-0', 'Running'), pod('rocketchat-0', 'Running')])).toBe(
      '2 in its namespace, all running',
    );
    expect(
      await podsOf([
        pod('mongodb-0', 'Running'),
        pod('rocketchat-0', 'Running'),
        pod('openldap-0', 'Running'),
        pod('phpldapadmin-0', 'Pending'),
      ]),
    ).toBe('4 in its namespace, 3 running');
    expect(await podsOf(null)).toBe('not counted: the cluster did not answer');
  });

  it('exports a kubeconfig only for the cluster houston itself made', async () => {
    // On a cluster houston ADOPTED, `export KUBECONFIG=<houston's own>` is wrong three
    // ways -- it made no cluster, that file does not describe yours, and your kubectl
    // already pointed at the right one -- so pasting step 1 broke the shell.
    const noteText = async (context: string): Promise<string> =>
      flattenNotes(
        await noteGroupsOf(
          record({
            name: 'w',
            project: 'houston-w',
            rcImage: 'registry.rocket.chat/rocketchat/rocket.chat:8.5.1',
            mongoFlavor: 'community',
            versionSource: 'shipped',
            extra: {
              runtime: 'kubernetes',
              namespace: 'houston-w',
              context,
              deployment: 'monolith',
            },
          }),
        ),
      ).join('\n');
    const ours = await noteText(KUBE_CONTEXT);
    expect(ours).toContain('export KUBECONFIG=');
    expect(ours).toContain(ownedKubeconfig());
    const adopted = await noteText('default');
    expect(adopted).not.toContain('export KUBECONFIG=');
    // "a cluster you supplied" was wrong for every EKS cluster houston built itself; the
    // note describes the kubeconfig mechanism, which is the same either way.
    expect(adopted).not.toContain('you supplied');
    expect(adopted).toContain('an existing cluster');
    expect(adopted).not.toContain(ownedKubeconfig());
    expect(adopted).toContain("'default'");
    // houston never moves kubectl's current context, so the note may not promise the
    // commands below already reach this cluster: on a real EKS build the current context
    // was the user's own, and "# expect <cluster>" sent them looking for a fault.
    expect(adopted).not.toContain('# expect');
    expect(adopted).toContain('# if it is not default: kubectl config use-context default');
  });

  it('says the MongoDB operator is shared exactly when it is used', async () => {
    // The official guide installs the operator INTO the Rocket.Chat namespace; houston
    // installs it once in houston-system. Undocumented, the guide's `kubectl -n <ns> get
    // pods` finds no operator and the reader concludes it was never installed.
    const groupsFor = async (managedBy: string) =>
      titled(
        await noteGroupsOf(
          record({
            name: 'k',
            project: 'houston-k',
            extra: {
              runtime: 'kubernetes',
              deployment: 'microservices',
              namespace: 'houston-k',
              context: 'kind-houston-local',
              release: 'rocketchat',
              mongo_managed_by: managedBy,
              mongo_image: 'mongo:8.0',
            },
          }),
        ),
      );
    const rowsOf = (group: NoteGroup | undefined) =>
      (group?.rows ?? []).map((row) => JSON.stringify([...row]));
    const op = await groupsFor('operator');
    const shared = op['The MongoDB operator is shared'];
    expect((shared?.body ?? []).join(' ')).toContain('official guide');
    // It says where to look, not just that it is elsewhere.
    expect((shared?.commands ?? []).some((c) => c.includes('get mongodbcommunity'))).toBe(true);
    expect(rowsOf(op.MongoDB)).toContain(JSON.stringify(['Managed by', 'the official operator']));
    // Monitoring deviates the same way and for the same reason, on both paths.
    expect((op.Monitoring?.body ?? []).join(' ')).toContain(
      'shared by the cluster, not installed per',
    );
    // A plain StatefulSet has no operator to explain, and says so where the guide would
    // have led someone to expect authentication.
    const sts = await groupsFor('statefulset');
    expect(Object.keys(sts)).not.toContain('The MongoDB operator is shared');
    expect(rowsOf(sts.MongoDB)).toContain(JSON.stringify(['Authentication', 'none']));
    expect((sts.MongoDB?.body ?? []).join(' ')).toContain('official guide');
  });

  it('does not repeat the URL as a note on loopback, and warns when bound wide', async () => {
    // "reachable on this box at http://localhost:3000" was the fourth copy of that string
    // on one screen. What is said nowhere else is what a NON-loopback bind means.
    const quiet = await noteGroupsOf(k8sMeta());
    expect(quiet.map((group) => group.title)).not.toContain('Reachable from other machines');
    expect(flattenNotes(quiet).filter((note) => note.includes('reachable on this box'))).toEqual(
      [],
    );
    const loud = titled(await noteGroupsOf(k8sMeta({ bind_host: '0.0.0.0' })));
    const warned = (loud['Reachable from other machines']?.body ?? []).join(' ');
    expect(warned).toContain('0.0.0.0');
    // What it exposes.
    expect(warned).toContain('admin123');
    // The port-forward comes back the way it was published, or the workspace is
    // unreachable from the machines the note just warned about.
    expect(loud['2 · Open the way in']?.commands[0]).toContain('--address 0.0.0.0');
  });
});

describe("a PBX lab's notes", () => {
  it('names the lab files that differ from the default', () => {
    const meta = metadata({
      name: 'labn',
      preset: 'voice',
      extra: { runtime: 'docker', params: { sip: 'on', pbx: 'on' } },
    });
    const dir = path.join(paths.workspace('labn'), 'voice', 'pbx');
    fs.mkdirSync(dir, { recursive: true });
    const stock =
      presets
        .load('voice', { sip: 'on', pbx: 'on' })
        .files.find(([file]) => file === 'voice/pbx/extensions.conf')?.[1] ?? '';
    fs.writeFileSync(path.join(dir, 'extensions.conf'), stock);
    const body = (): string => (scenarioGroup(meta)[0]?.body ?? []).join('\n');
    expect(body()).not.toContain('Edited lab files');
    fs.writeFileSync(path.join(dir, 'extensions.conf'), `${stock}; mine\n`);
    expect(body()).toContain(
      'Edited lab files (kept by up --force; delete one and run up --force for the default): voice/pbx/extensions.conf',
    );
  });
});

describe("a composed workspace's notes", () => {
  it('are ONE scenario group, merged as the create merged them, with the combined note', () => {
    const groups = scenarioGroup(
      metadata({
        name: 'combo',
        preset: 'email+ldap',
        extra: { runtime: 'docker', preset_params: { ldap: { users: '3' } } },
      }),
    );
    expect(groups).toHaveLength(1);
    const body = (groups[0]?.body ?? []).join('\n');
    expect(body).toContain('Mailpit');
    expect(body).toContain('an LDAP login asks for a code');
    expect(groups[0]?.title).toBe('Preset · email+ldap');
  });

  it('are titled by the presets asked for, not the deployment Compose builds with them', () => {
    // A multi-instance SAML workspace was "Scenario · multi-instance+saml" while its panel's
    // Preset row said `saml`: multi-instance is the deployment, not a preset.
    const groups = scenarioGroup(
      metadata({
        name: 'd2',
        preset: 'multi-instance+saml',
        extra: { runtime: 'docker', deployment: 'multi-instance', instances: 2 },
      }),
    );
    expect(groups[0]?.title).toBe('Preset · saml');
    // Its notes stay: the deployment's lines are about this workspace too.
    expect((groups[0]?.body ?? []).join('\n')).toContain('instances.get');
  });
});

describe("an HTTPS workspace's scenario notes", () => {
  const https = (publicPaths: unknown[]) =>
    scenarioGroup(
      metadata({
        name: 'td',
        preset: 'ldap+s3_minio',
        publicUrl: 'https://td.houston.localhost',
        extra: { runtime: 'docker', public_paths: publicPaths },
      }),
    )
      .flatMap((group) => group.body)
      .join('\n');

  it("give the UIs' public paths, as the create served them", () => {
    const body = https([{ path: '/minio', service: 'minio-ui', container_port: 80 }]);
    expect(body).toContain('MinIO console: https://td.houston.localhost/minio/');
    expect(body).toContain('phpLDAPadmin: https://td.houston.localhost/phpldapadmin/');
    expect(body).not.toContain('localhost:9001');
  });

  it('are not "corrected" for saying localhost when only the HTTPS name does', async () => {
    const groups = await noteGroupsOf(
      record({
        name: 'td',
        project: 'p',
        preset: 'ldap+s3_minio',
        rootUrl: 'http://localhost:3720',
        publicUrl: 'https://td.houston.localhost',
        hostPort: 3720,
        versionSource: 't',
        extra: {
          runtime: 'docker',
          sidecar_ports: [8082, 9000, 9001],
          advertised_url: 'https://td.houston.localhost',
          public_paths: [{ path: '/minio', service: 'minio-ui', container_port: 80 }],
        },
      }),
    );
    expect(groups.map((group) => group.title)).not.toContain("Reaching this preset's own pages");
  });

  it('offer only the ports a note still gives when one stays on localhost', async () => {
    // livechat keeps its cross-origin demo page on a port; Mailpit, Keycloak, the MinIO
    // console and phpLDAPadmin moved to paths, so their ports are not offered as pages.
    const groups = await noteGroupsOf(
      record({
        name: 'd20',
        project: 'p',
        preset: 'email+livechat',
        rootUrl: 'http://localhost:3730',
        publicUrl: 'https://d20.houston.localhost',
        hostPort: 3730,
        versionSource: 't',
        extra: {
          runtime: 'docker',
          sidecar_ports: [8025, 8090],
          advertised_url: 'https://d20.houston.localhost',
          public_paths: [{ path: '/mailpit', service: 'mailpit', container_port: 8025 }],
        },
      }),
    );
    const reach = groups.find((group) => group.title === "Reaching this preset's own pages");
    expect(reach?.body.join(' ')).toContain('http://d20.houston.localhost:8090');
    expect(reach?.body.join(' ')).not.toContain(':8025');
  });

  it('keep the ports for a workspace whose UIs were not moved', () => {
    expect(https([])).toContain('MinIO console: http://localhost:9001');
  });
});

describe('the webhooks group: what post-ready recorded, on both runtimes', () => {
  const hooks = {
    session: 'ses-7',
    incoming: '/hooks/i/t0k3n',
    outgoing_name: 'houston-outgoing',
    omnichannel: 'http://webhooks:8080/ses-7/omnichannel',
    captured: [{ name: 'Jira', from: ['https://jira.example.com/hook'] }],
  };

  it('prints the incoming hook as a place, a curl to paste, and what was captured', async () => {
    const docker = titled(
      await noteGroupsOf(
        record({
          name: 'd',
          project: 'houston-d',
          preset: 'webhooks',
          extra: { runtime: 'docker', webhooks: hooks },
        }),
      ),
    );
    const group = docker.Webhooks;
    // `Name (what): http://…` is the line the GUI turns into a link row: the inbox at the
    // session the receiver chose (the links row says the same), then the hook.
    expect(group?.body[0]).toMatch(/^Webhook inbox \([^)]+\): http:\/\/localhost:8086\/s\/ses-7$/u);
    expect(group?.body[1]).toMatch(
      /^Incoming hook \([^)]+\): http:\/\/localhost:3000\/hooks\/i\/t0k3n$/u,
    );
    expect(group?.commands[0]).toContain('curl');
    expect(group?.commands[0]).toContain('http://localhost:3000/hooks/i/t0k3n');
    const body = group?.body.join('\n') ?? '';
    expect(body).toContain('houston-outgoing');
    expect(body).toContain('at the inbox');
    // The original URL is a FACT in a table row, never prose: the panel links a URL in
    // prose, and a click on the customer's real endpoint is a request to it.
    expect(body).not.toContain('jira.example.com');
    expect(group?.rows).toEqual([
      ['Repointed at the inbox (capture=all)', 'Jira — was https://jira.example.com/hook'],
    ]);
    const k8s = titled(await noteGroupsOf(k8sMeta({ webhooks: hooks })));
    expect(k8s.Webhooks?.commands[0]).toContain('http://localhost:3000/hooks/i/t0k3n');
  });

  it('names a webhook left at a foreign URL, and is absent until a ready run recorded the hooks', async () => {
    const left = titled(
      await noteGroupsOf(
        record({
          name: 'd',
          project: 'houston-d',
          preset: 'webhooks',
          extra: {
            runtime: 'docker',
            webhooks: { ...hooks, omnichannel: 'https://crm.example.com/hook', captured: [] },
          },
        }),
      ),
    );
    expect(left.Webhooks?.body.join('\n')).not.toContain('crm.example.com');
    expect(left.Webhooks?.rows).toEqual([
      [
        'Omnichannel webhook',
        'left at https://crm.example.com/hook (--set capture=all repoints it at the inbox)',
      ],
    ]);
    // Captured by capture=all: the original rides in the URL's ?from=, as for integrations.
    const captured = titled(
      await noteGroupsOf(
        record({
          name: 'd',
          project: 'houston-d',
          preset: 'webhooks',
          extra: {
            runtime: 'docker',
            webhooks: {
              ...hooks,
              omnichannel: `${hooks.omnichannel}?from=https%3A%2F%2Fcrm.example.com%2Fhook`,
              captured: [],
            },
          },
        }),
      ),
    );
    expect(captured.Webhooks?.body.join('\n')).not.toContain('Omnichannel webhook');
    expect(captured.Webhooks?.rows).toEqual([
      ['Omnichannel webhook', 'at the inbox — was https://crm.example.com/hook'],
    ]);
    const none = titled(
      await noteGroupsOf(
        record({
          name: 'd',
          project: 'houston-d',
          preset: 'webhooks',
          extra: { runtime: 'docker' },
        }),
      ),
    );
    expect(Object.keys(none)).not.toContain('Webhooks');
  });
});
