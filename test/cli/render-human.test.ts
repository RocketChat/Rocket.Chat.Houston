import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../../src/lib/config';
import { metadata, writeRecord } from '../../src/core/runner/record';
import { listPresets } from '../../src/lib/presets';
import { emptyPreset, type Preset } from '../../src/lib/presets/types';

import type { Invocation } from '../../src/cli/app';
import { renderHuman, renderPresets } from '../../src/cli/handlers';
import { COMMAND_SPECS } from '../../src/cli/spec-data';
import type { CommandSpec } from '../../src/cli/spec-types';

type Answer = { out: string; error: string | null };

/**
 * What earlier releases printed, recorded: `houston presets` over the corpus at each width
 * (`unset` is no COLUMNS, off a terminal), over the shipped catalogue at each width, and over
 * the user files of the ordering case; and `env`, `pat` and `monitor` for each of their cases,
 * in table order.
 */
const RECORDED = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cli', 'render-human.json'), 'utf8'),
) as {
  presets: {
    corpus: Record<string, Answer>;
    catalogue: Record<string, Answer>;
    userFiles: Answer;
  };
  env: string[];
  pat: string[];
  monitor: string[];
};

function invocation(path: string, action = ''): Invocation {
  const spec = (COMMAND_SPECS as readonly CommandSpec[]).find(
    (candidate) => candidate.path === path,
  );
  if (spec === undefined) throw new Error(`unknown command path ${path}`);
  return {
    spec,
    arguments: action === '' ? {} : { action },
    options: {},
    events: null,
  };
}

async function render(
  path: string,
  value: unknown,
  action = '',
): Promise<{ out: string; err: string }> {
  let out = '';
  let err = '';
  await renderHuman(invocation(path, action), value, {
    writeOut: (text) => {
      out += text;
    },
    writeErr: (text) => {
      err += text;
    },
  });
  return { out, err };
}

describe('explicit human command renderers', () => {
  test('all 40 routable paths have a renderer and none falls back to object JSON', async () => {
    expect(COMMAND_SPECS).toHaveLength(40);
    for (const spec of COMMAND_SPECS) {
      const action = ['users', 'edge', 'config', 'cluster'].includes(spec.path) ? 'status' : '';
      const result = await render(spec.path, { sentinel: 'must-not-be-a-json-dump' }, action);
      expect(result.out).not.toContain('"sentinel"');
      expect(result.out).not.toContain('{\n');
    }
  });

  test('stop, start, down and use name whose workspace they acted on', async () => {
    // Without --name they act on the default the whole houston home shares, so on a shared
    // server the line has to say when it was a colleague's.
    await writeRecord(
      'bob-t1',
      metadata({
        name: 'bob-t1',
        project: 'houston-bob-t1',
        rcVersion: '8.5.1',
        extra: { created_by: 'bob' },
      }),
    );
    expect((await render('stop', { name: 'bob-t1' })).out).toBe(
      "✓ 'bob-t1' stopped (owned by bob; resume with `houston start`).\n",
    );
    expect((await render('start', { name: 'bob-t1' })).out).toBe(
      "✓ 'bob-t1' started (owned by bob).\n",
    );
    expect((await render('down', { name: 'bob-t1', removed: false })).out).toContain(
      "✓ 'bob-t1' down (data kept; owned by bob).\n",
    );
    expect((await render('use', { default: 'bob-t1' })).out).toBe(
      "✓ default workspace is now 'bob-t1' (owned by bob). Commands run without --name act " +
        'on it, for everyone using this houston home.\n',
    );
    // A record that names nobody gets no owner invented for it.
    await writeRecord('rc851', metadata({ name: 'rc851', project: 'houston-rc851' }));
    expect((await render('stop', { name: 'rc851' })).out).toBe(
      "✓ 'rc851' stopped (resume with `houston start`).\n",
    );
  });

  test('list preserves the empty guidance and the stable human columns', async () => {
    expect((await render('list', { repros: [], count: 0 })).out).toBe(
      'No workspaces yet. Create one with `houston up --version <X.Y.Z>`.\n',
    );
    const shown = (
      await render('list', {
        repros: [
          {
            name: 'ticket-1',
            rc_version: '8.5.1',
            mongo_tag: '8.0',
            runtime: 'docker',
            host_port: 3000,
            state: 'running',
            root_url: 'http://127.0.0.1:3000',
            default: true,
          },
        ],
      })
    ).out;
    expect(shown).toContain('NAME');
    expect(shown).toContain('RC');
    expect(shown).toContain('*ticket-1');
    expect(shown).toContain('* = default workspace');
    expect(shown).not.toContain('"repros"');
    // Its URL is the one a person opens: behind a tunnel, the name `--root-url` advertised.
    const tunnelled = (
      await render('list', {
        repros: [
          {
            name: 'ticket-2',
            rc_version: '8.9.0',
            mongo_tag: '8.0',
            runtime: 'docker',
            host_port: 3014,
            state: 'running',
            root_url: 'http://localhost:3014',
            public_url: '',
            open_url: 'https://ticket.example.test',
          },
        ],
      })
    ).out;
    expect(tunnelled).toContain('https://ticket.example.test');
    expect(tunnelled).not.toContain('http://localhost:3014');
  });

  test('token, PAT and API produce pasteable/raw output rather than serialized objects', async () => {
    expect((await render('token', { token: 'secret', user_id: 'uid' })).out).toBe(
      '-H "X-Auth-Token: secret" -H "X-User-Id: uid"\n',
    );
    expect((await render('pat', { token: 'pat', user_id: 'uid', bypass_2fa: true })).out).toContain(
      '-H "X-Auth-Token: pat" -H "X-User-Id: uid"',
    );
    const api = (
      await render('api', {
        status: 404,
        auth: 'PAT',
        elapsed_ms: 12,
        text: '{"success":false}',
      })
    ).out;
    expect(api).toBe('HTTP 404  [PAT]  in 12ms\n{"success":false}\n');
    // Earlier releases add a newline to one the body already has, and the elapsed time
    // turns to seconds at a second.
    expect(
      (await render('api', { status: 200, auth: 'admin', elapsed_ms: 1302.4, text: 'hello\n' }))
        .out,
    ).toBe('HTTP 200  [admin]  in 1.30s\nhello\n\n');
  });

  test('loadtest draws nothing after the run, and says no warning again', async () => {
    const result = await render('loadtest', {
      ctx: { name: 'one', label: 'journey', vus: 10, duration: '30s' },
      summary: { count: 100, rps: 3.3, p95: 30, error_rate: 0.01 },
      slo: [{ ok: false, key: 'p95', op: '<=', raw: '20ms', actual: 30 }],
      passed: false,
      warnings: ['seed users unavailable'],
      saved_baseline: '/isolated/b.json',
      report: '/isolated/r.md',
    });
    // The result is drawn by the run itself, once it is measured and before anything is
    // saved, as earlier releases draw it; its warnings were said as they happened and only
    // kept for the envelope.
    expect(result).toEqual({ out: '', err: '' });
  });

  test('versions includes the pairing provenance and unknown-version note', async () => {
    const result = (
      await render('versions', {
        rc_version: '8.5.999',
        rc_image: 'registry.example/rc',
        mongo_tag: '8.0',
        mongo_flavor: 'mongodb',
        mongo_shell: 'mongosh',
        oplog: false,
        source: 'map (no such release)',
        note: 'releases.rocket.chat has no 8.5.999',
      })
    ).out;
    expect(result).toContain('shell: mongosh');
    expect(result).toContain('oplog url');
    expect(result).toContain('resolved via : map (no such release)');
    expect(result).toContain('note         : releases.rocket.chat has no 8.5.999');
  });

  test('cluster documents remain raw while status is human prose', async () => {
    const guide = (await render('cluster', { body: '# Guide\nDo this.' }, 'guide')).out;
    expect(guide).toBe('# Guide\nDo this.\n');
    const policy = (
      await render(
        'cluster',
        { documents: [{ name: 'operator', body: '{"Version":"2012-10-17"}' }] },
        'iam-policy',
      )
    ).out;
    // An omitted document name is the menu, never an accidental object dump.
    expect(policy).toContain('operator');
    expect(policy).not.toContain('"documents"');
    const status = (
      await render(
        'cluster',
        {
          context: 'support',
          reachable: true,
          distribution: 'EKS',
          ours: true,
          nodes: 3,
          workspaces: [],
          pvcs: 0,
        },
        'status',
      )
    ).out;
    expect(status).toContain('cluster   support');
    expect(status).toContain("EKS · houston's own · 3 node(s)");
    // `ours` is the kind-cluster switch and is never true for EKS, so every EKS cluster
    // read "yours", the ones houston built included. The tag decides now; `ours` still
    // wins for the kind cluster.
    const shape = async (ours: boolean, made: boolean | null): Promise<string> =>
      (
        await render(
          'cluster',
          {
            context: 'support',
            reachable: true,
            distribution: 'EKS',
            ours,
            made_by_houston: made,
            nodes: 3,
            workspaces: [],
            pvcs: 0,
          },
          'status',
        )
      ).out;
    expect(await shape(false, true)).toContain("EKS · houston's own");
    expect(await shape(false, false)).toContain('EKS · yours');
    expect(await shape(false, null)).toContain('EKS · yours');
  });

  test('down on a cloud cluster without --volumes says the disk keeps billing', async () => {
    // The guide's per-ticket section said "Always pass --volumes on a cluster" because the
    // disk keeps billing and cluster delete refuses while it exists; the command said
    // only that the claim was kept.
    const cloud = (
      await render('down', {
        name: 't1',
        runtime: 'kubernetes',
        context: 'arn:aws:eks:us-east-1:1:cluster/support',
        removed: false,
        found: true,
      })
    ).out;
    expect(cloud).toContain('keeps billing');
    expect(cloud).toContain('cluster delete');
    expect(cloud).toContain('houston down --name t1 --volumes');
    const local = (
      await render('down', {
        name: 't1',
        runtime: 'kubernetes',
        context: 'kind-houston-local',
        removed: false,
        found: true,
      })
    ).out;
    expect(local).not.toContain('keeps billing');
  });

  test('list names the cluster kind in WHERE, not a bare k8s', async () => {
    const row = (name: string, context: string) => ({
      name,
      rc_version: '8.5.1',
      mongo_tag: '8.0',
      runtime: 'kubernetes',
      context,
      cluster: context.split('/').pop(),
      host_port: 3000,
      state: 'running',
      root_url: 'http://localhost:3000',
      public_url: '',
      default: false,
      pinned: false,
    });
    const out = (
      await render('list', {
        repros: [
          row('a', 'arn:aws:eks:us-east-1:1:cluster/support'),
          row('b', 'kind-houston-local'),
          row('c', 'default'),
          // A Docker workspace said `compose`, a tool's name; --json keeps `runtime: docker`.
          { ...row('d', ''), runtime: 'docker' },
        ],
        count: 4,
      })
    ).out;
    // NAME is 20 cells and a mark, RC 10, MONGO 8: WHERE starts at cell 39.
    const where = out
      .split('\n')
      .slice(1, 5)
      .map((line) => line.slice(39, 47).trim());
    expect(where).toEqual(['eks', 'kind', 'k8s', 'docker']);
  });

  test('cluster status opens with where the cluster is and who built it, and ends with the next step', async () => {
    const out = (
      await render(
        'cluster',
        {
          context: 'arn:aws:eks:us-east-1:1:cluster/support',
          name: 'support',
          region: 'us-east-1',
          reachable: true,
          distribution: 'eks',
          ours: false,
          made_by_houston: true,
          created_at: '2026-09-28T09:00:00Z',
          expires: '2026-10-05',
          expires_in_days: 5,
          spend_usd: 23.41,
          zone: 'rc.example.com',
          ready: {
            storage_class: 'gp3',
            ingress_class: 'traefik',
            cert_manager: true,
            cname_target: 'a1b2.elb.amazonaws.com',
            dns_answers: false,
          },
          nodes: 3,
          instance_types: { 't3.large': 3 },
          workspaces: [],
          pvcs: 0,
          loadbalancers: 1,
          cost: {
            usd_hr: 0.4443,
            basis: 'us-east-1 on-demand',
            estimate: true,
            unpriced: {},
            incomplete: [],
          },
        },
        'status',
      )
    ).out;
    // The established lines stay; the new ones sit around them.
    expect(out).toContain('cluster   arn:aws:eks:us-east-1:1:cluster/support');
    expect(out).toContain(
      'about     support · us-east-1 · eks · built by houston · created 2026-09-28 · expires in 5 d (2026-10-05)',
    );
    expect(out).toContain(
      'ready     storage gp3 · ingress traefik · cert-manager · DNS for *.rc.example.com does not answer yet',
    );
    expect(out).toContain('spent     ~$23.41 so far');
    expect(out).toContain('next      Point *.rc.example.com at a1b2.elb.amazonaws.com, once');
  });

  test('every cluster action ends with what to do next', async () => {
    const create = (
      await render(
        'cluster',
        {
          region: 'eu-west-1',
          expires: '2026-10-07',
          prepared: { cname_target: 'a1b2.elb.amazonaws.com', zone: 'rc.example.com' },
        },
        'create',
      )
    ).out;
    expect(create).toContain('next  point *.rc.example.com at a1b2.elb.amazonaws.com');
    const prepare = (
      await render(
        'cluster',
        {
          context: 'arn:aws:eks:eu-west-1:1:cluster/support',
          storage_class: 'gp3',
          ingress_class: 'traefik',
          cert_manager: true,
          cname_target: '',
          cname_pending: false,
          already: [],
          kept: '',
          zone: '',
          metrics_server: true,
        },
        'prepare',
      )
    ).out;
    expect(prepare).toContain(
      'next  houston up --version <version> --name <ticket> --context support',
    );
    const forget = (
      await render(
        'cluster',
        { context: 'arn:aws:eks:eu-west-1:1:cluster/old', forgotten: true },
        'forget',
      )
    ).out;
    expect(forget).toContain('next  houston cluster overview');
    const keep = (
      await render(
        'cluster',
        { name: 'support', region: 'eu-west-1', expires: '2026-10-14', days: 7 },
        'keep',
      )
    ).out;
    expect(keep).toContain('next  houston cluster overview');
    const list = (
      await render(
        'cluster',
        {
          clusters: [
            {
              name: 'support',
              region: 'eu-west-1',
              status: 'ACTIVE',
              ours: true,
              created: '2026-10-01',
              expires: '',
            },
          ],
          regions: ['eu-west-1'],
          unreadable: [],
          fallback: '',
        },
        'list',
      )
    ).out;
    expect(list).toContain('next  houston cluster status --context support');
    const none = (
      await render(
        'cluster',
        { clusters: [], regions: ['eu-west-1'], unreadable: [], fallback: '' },
        'list',
      )
    ).out;
    expect(none).toContain('next  houston cluster guide');
    const share = (
      await render(
        'cluster',
        {
          name: 'support',
          region: 'eu-west-1',
          user: 'bob',
          principal: 'arn:aws:iam::1:user/bob',
          already: false,
          lines: [],
        },
        'share',
      )
    ).out;
    expect(share).toContain('next  houston cluster overview');
    const deleted = (
      await render(
        'cluster',
        {
          name: 'support',
          deleted: true,
          region: 'eu-west-1',
          leftovers: { found: [], unreadable: [] },
        },
        'delete',
      )
    ).out;
    expect(deleted).toContain('next  houston cluster list');
  });

  test('cluster overview is a table, a totals line and the next step', async () => {
    const ledger = (over: Record<string, unknown>) => ({
      context: 'arn:aws:eks:us-east-1:1:cluster/support',
      name: 'support',
      region: 'us-east-1',
      distribution: 'eks',
      reachable: true,
      reach_status: 'ok',
      gone: false,
      nodes: 3,
      instance_types: { 't3.large': 3 },
      workspaces: [{ name: 't1' }, { name: 't2' }],
      cost: {
        usd_hr: 0.4443,
        basis: 'us-east-1 on-demand',
        estimate: true,
        unpriced: {},
        incomplete: [],
      },
      expires: '2026-10-05',
      expires_in_days: 5,
      made_by_houston: true,
      spend_usd: 23.41,
      ...over,
    });
    const out = (
      await render(
        'cluster',
        {
          clusters: [
            ledger({}),
            ledger({
              context: 'arn:aws:eks:eu-west-1:1:cluster/perf',
              name: 'perf',
              region: 'eu-west-1',
              gone: true,
              reachable: false,
              reach_status: 'down',
              nodes: null,
              instance_types: null,
              workspaces: null,
              cost: null,
              expires: '',
              expires_in_days: null,
              made_by_houston: false,
              spend_usd: null,
            }),
          ],
          failed: [],
          totals: { clusters: 2, billable: 1, usd_day: 10.66, spend_usd: 23.41, workspaces: 2 },
          next: {
            stage: 5,
            cluster: 'support',
            title: 'Run a workspace on support',
            why: 'In the GUI: click New workspace and pick support under Where it runs.',
            command: 'houston up --version <version> --name <ticket> --context support',
          },
          default: 'arn:aws:eks:us-east-1:1:cluster/support',
          unreadable: '',
        },
        'overview',
      )
    ).out;
    const lines = out.split('\n');
    expect(lines[0]).toBe('IN AWS');
    expect(lines[1]).toBe(
      'NAME     REGION     STATE    NODES        WORKSPACES  COST/DAY  EXPIRES  BUILT BY',
    );
    expect(lines[2]).toBe(
      'support  us-east-1  running  3x t3.large  2           ~$10.66   in 5 d   houston',
    );
    expect(lines[3]).toBe(
      'perf     eu-west-1  gone     ?            ?           nothing   —        you',
    );
    expect(out).toContain(
      '2 clusters · 1 billing · ~$10.66/day · spent so far ~$23.41 · 2 workspaces',
    );
    expect(out).toContain('next  Run a workspace on support');
    expect(out).toContain('      houston up --version <version> --name <ticket> --context support');
    // `?` still means unread, never zero; a pipe gets no colour.
    expect(out).not.toContain('\u001b[');
  });

  test('cluster overview puts a local cluster on this machine, free, apart from the aws table', async () => {
    // A k3s on this machine sat in the EKS table with "?" for its cost and its builder,
    // under totals and a next step that were about AWS.
    const plain = (over: Record<string, unknown>) => ({
      region: '',
      distribution: 'k3s',
      reachable: true,
      reach_status: 'ok',
      gone: false,
      nodes: null,
      workspaces: [],
      cost: null,
      made_by_houston: null,
      ...over,
    });
    const out = (
      await render(
        'cluster',
        {
          clusters: [
            plain({ context: 'default', name: 'default', where: 'local' }),
            plain({
              context: 'lab',
              name: 'lab',
              where: 'elsewhere',
              workspaces: [{ name: 't1' }, { name: 't2' }],
            }),
          ],
          failed: [],
          totals: {
            clusters: 0,
            billable: 0,
            usd_day: null,
            spend_usd: null,
            workspaces: 0,
            unpriced: 0,
            unread: 0,
          },
          next: {
            stage: 2,
            cluster: '',
            title: 'Approve AWS account 1 for spending on this box',
            why: 'w',
            command: 'houston config set cluster.approved_accounts 1',
          },
          default: '',
          unreadable: '',
        },
        'overview',
      )
    ).out;
    const lines = out.split('\n');
    expect(lines.slice(0, 3)).toEqual([
      'ON THIS MACHINE',
      'NAME     KIND  STATE    WORKSPACES  COST',
      'default  k3s   running  0           free',
    ]);
    expect(out).toContain('ELSEWHERE');
    expect(out).toMatch(/lab +k3s +running +2 +not priced/u);
    expect(out).toContain('IN AWS');
    expect(out).toContain('no cluster in AWS yet');
    // The AWS totals line says nothing about clusters that are not in AWS.
    expect(out).not.toContain('billing');
    expect(out).toContain('next  Approve AWS account 1 for spending on this box');
  });

  test('cluster status on a local cluster says this machine and what it uses', async () => {
    const out = (
      await render(
        'cluster',
        {
          context: 'default',
          name: 'default',
          region: '',
          where: 'local',
          reachable: true,
          distribution: 'k3s',
          ours: false,
          made_by_houston: null,
          created_at: '',
          expires: '',
          expires_in_days: null,
          spend_usd: null,
          zone: '',
          ready: {
            storage_class: 'local-path',
            ingress_class: 'traefik',
            cert_manager: true,
            cname_target: '',
            dns_answers: null,
          },
          nodes: 1,
          workspaces: [],
          pvcs: 0,
          loadbalancers: 0,
          cost: null,
        },
        'status',
      )
    ).out;
    expect(out).toContain('about     default · this machine · k3s');
    expect(out).toContain('uses      storage class local-path · ingress traefik · cert-manager');
    expect(out).not.toContain('ready     ');
    expect(out).toContain('next      Run a workspace on default');
  });

  test('cluster overview says when its totals leave something out', async () => {
    // Two billing clusters, one of which could not be read: "~$10.66/day" alone read as
    // the whole bill, and "0 workspaces" as none.
    const out = (
      await render(
        'cluster',
        {
          clusters: [
            {
              context: 'arn:aws:eks:us-east-1:1:cluster/perf',
              name: 'perf',
              region: 'us-east-1',
              reachable: false,
              reach_status: 'denied',
              gone: false,
              nodes: null,
              workspaces: null,
              cost: null,
              made_by_houston: null,
            },
          ],
          failed: [],
          totals: {
            clusters: 2,
            billable: 2,
            usd_day: 10.66,
            spend_usd: null,
            workspaces: 0,
            unpriced: 1,
            unread: 1,
          },
          next: {
            stage: 5,
            cluster: 'perf',
            title: 'perf is not answering',
            why: 'w',
            command: 'houston cluster status perf',
          },
          default: '',
          unreadable: '',
        },
        'overview',
      )
    ).out;
    expect(out).toContain('~$10.66/day + 1 not priced');
    expect(out).toContain('0+ workspaces');
  });

  test('an expired cluster is amber on a terminal, never the red kept for destroying', async () => {
    const saved = process.env.FORCE_COLOR;
    const savedNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    try {
      const out = (
        await render(
          'cluster',
          {
            clusters: [
              {
                context: 'arn:aws:eks:us-east-1:1:cluster/old',
                name: 'old',
                region: 'us-east-1',
                reachable: true,
                gone: false,
                nodes: 3,
                workspaces: [],
                cost: null,
                expires: '2026-09-20',
                expires_in_days: -3,
                made_by_houston: true,
              },
            ],
            failed: [],
            totals: {
              clusters: 1,
              billable: 1,
              usd_day: null,
              spend_usd: null,
              workspaces: 0,
              unpriced: 1,
              unread: 0,
            },
            next: {
              stage: 6,
              cluster: 'old',
              title: 't',
              why: 'w',
              command: 'houston cluster keep old --days 7',
            },
            default: '',
            unreadable: '',
          },
          'overview',
        )
      ).out;
      expect(out).toContain('\u001b[33m3 d ago\u001b[0m');
      expect(out).not.toContain('\u001b[31m');
    } finally {
      if (saved === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = saved;
      if (savedNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = savedNoColor;
    }
  });

  test('cluster overview with nothing known still says what to do', async () => {
    const out = (
      await render(
        'cluster',
        {
          clusters: [],
          failed: [],
          totals: { clusters: 0, billable: 0, usd_day: null, spend_usd: null, workspaces: 0 },
          next: {
            stage: 3,
            cluster: '',
            title: 'Build a cluster',
            why: 'About twenty minutes.',
            command: 'houston cluster create support --region us-east-1 --zone <your zone>',
          },
          default: '',
          unreadable: '',
        },
        'overview',
      )
    ).out;
    expect(out).toContain('no cluster known on this box');
    expect(out).toContain('next  Build a cluster');
  });

  test('cluster share prints the two lines the colleague runs', async () => {
    const out = (
      await render(
        'cluster',
        {
          name: 'support',
          region: 'eu-west-1',
          user: 'bob',
          principal: 'arn:aws:iam::1:user/bob',
          already: false,
          lines: [
            'aws eks update-kubeconfig --name support --region eu-west-1',
            'houston up --version 8.5.1 --name TICKET-5678 --context support',
          ],
        },
        'share',
      )
    ).out;
    expect(out).toContain('arn:aws:iam::1:user/bob');
    expect(out).toContain('aws eks update-kubeconfig --name support --region eu-west-1');
    expect(out).toContain('houston up');
  });

  test('cluster keep says the new date and what reads it', async () => {
    const out = (
      await render(
        'cluster',
        { name: 'support', region: 'eu-west-1', expires: '2026-10-14', days: 7 },
        'keep',
      )
    ).out;
    expect(out).toContain("kept 'support' until 2026-10-14");
    expect(out).toContain('reminder');
  });

  test('cluster delete ends with what AWS still holds, or with nothing billing', async () => {
    // The guide had seven aws commands to run after a delete, because "the command
    // returned" is not "nothing is billing". The delete asks AWS itself now.
    const clean = (
      await render(
        'cluster',
        {
          name: 'support',
          deleted: true,
          region: 'eu-west-1',
          leftovers: { found: [], unreadable: [] },
        },
        'delete',
      )
    ).out;
    expect(clean).toContain('nothing in eu-west-1 is billing');
    const dirty = (
      await render(
        'cluster',
        {
          name: 'support',
          deleted: true,
          region: 'eu-west-1',
          leftovers: {
            found: [
              {
                kind: 'volume',
                id: 'vol-0abc',
                detail: '8 GB',
                fix: 'aws ec2 delete-volume --region eu-west-1 --volume-id vol-0abc',
                certain: true,
              },
              {
                kind: 'volume',
                id: 'vol-9zz',
                detail: '8 GB — not tagged with any cluster',
                fix: '',
                certain: false,
              },
            ],
            unreadable: [{ kind: 'stack', why: 'AccessDenied' }],
          },
        },
        'delete',
      )
    ).out;
    expect(dirty).toContain('left behind');
    expect(dirty).toContain('vol-0abc');
    expect(dirty).toContain('aws ec2 delete-volume --region eu-west-1 --volume-id vol-0abc');
    expect(dirty).toContain('stack');
    expect(dirty).toContain('AccessDenied');
    expect(dirty).not.toContain('nothing in eu-west-1 is billing');
    // A candidate nothing ties to this cluster: listed to check, never with a command.
    expect(dirty).toContain('vol-9zz');
    expect(dirty).toContain('check before deleting');
    expect(dirty).not.toContain('--volume-id vol-9zz');
  });

  test('cluster create prints its summary once: the event already said the cluster is up', async () => {
    const out = (
      await render(
        'cluster',
        {
          region: 'eu-west-1',
          expires: '2026-10-07',
          context: 'arn:aws:eks:eu-west-1:1:cluster/support',
        },
        'create',
      )
    ).out;
    // `cluster 'X' is up in R` is an event createCluster emits, and emitOf prints every
    // event; the summary printed it a second time, one line under the first.
    expect(out).not.toContain('is up in');
    expect(out).toContain('tagged as wanted until 2026-10-07');
  });
});

/**
 * `houston presets` against what earlier releases printed, with the preset list stated where
 * a corpus is given.
 *
 * An earlier version drew each box one line as long as its description and printed no `--set`
 * line and no `[needs license]`, because it read snake_case keys off a camelCase `Preset`.
 * Earlier releases size every box as the terminal's columns (90 off a terminal), capped at
 * 88, less 4 inside, so the widths below are the ones that change the answer: unset (no
 * terminal: 90, capped to 88), 100 and 88 (both capped), 60, 40, 20, 8, and 4, where the
 * wrap raises.
 */
describe('presets', () => {
  interface Row {
    name: string;
    description: string;
    params_help: Record<string, string>;
    requires_license: boolean;
  }
  const CORPUS: Row[] = [
    { name: 'plain', description: 'Short.', params_help: {}, requires_license: false },
    {
      name: 'folded',
      description:
        'Line one\n\tindented   words — and a well-known multi-instance-horizontal-scaling ' +
        "tail (bucket 'houston-uploads'), then “quotes” → arrows… and a\u0085NEL.",
      params_help: {},
      requires_license: false,
    },
    {
      name: 'licensed',
      description: 'Enterprise only.',
      params_help: {
        users: 'number of users to generate (default 5; try 130000 for scale)',
        idp_host:
          'hostname BOTH your browser and Rocket.Chat reach Keycloak on (default ' +
          "'keycloak', which needs a hosts entry and only works on this machine)",
        e: '',
        名前: '値 😀 with “quotes”',
      },
      requires_license: true,
    },
    { name: 'blank', description: '', params_help: {}, requires_license: false },
    {
      name: 'a-title-far-wider-than-any-box-this-command-could-ever-draw-at-any-width-at-all',
      description: `/tmp/-home-laborant-rc-repro/${'x'.repeat(90)}/file.yaml`,
      params_help: {},
      requires_license: false,
    },
  ];

  function toPreset(row: Row): Preset {
    return {
      ...emptyPreset(row.name),
      description: row.description,
      paramsHelp: row.params_help,
      requiresLicense: row.requires_license,
    };
  }

  function ours(presets: Preset[], columns: string | null): Answer {
    const host = {
      env: columns === null ? {} : { COLUMNS: columns },
      isatty: () => false,
      columns: () => null,
    };
    let out = '';
    try {
      renderPresets({ presets }, { writeOut: (text) => (out += text), writeErr: () => {} }, host);
      return { out, error: null };
    } catch (error) {
      return { out, error: `${(error as Error).name}: ${(error as Error).message}` };
    }
  }

  test('every box is wrapped as earlier releases wrapped it, at every width that changes it', () => {
    const widths = [null, '100', '88', '60', '40', '20', '8', '4'];
    const recorded = widths.map((columns) => RECORDED.presets.corpus[columns ?? 'unset']);
    widths.forEach((columns, at) => {
      expect([columns, ours(CORPUS.map(toPreset), columns)]).toEqual([columns, recorded[at]]);
    });
    // COLUMNS=4 leaves the wrap a width of 0: an `InvalidValue` after the heading, in both.
    expect(recorded[widths.indexOf('4')]).toEqual({
      out: 'Presets\n\n',
      error: 'InvalidValue: invalid width 0 (must be > 0)',
    });
  });

  test('the shipped catalogue, through renderHuman, reads the width from COLUMNS', async () => {
    const widths = ['100', '60', '40'];
    const recorded = [null, ...widths].map(
      (columns) => RECORDED.presets.catalogue[columns ?? 'unset'],
    );
    // Unset needs a host with no terminal, which the real process may not be.
    expect(
      ours(
        listPresets().filter((preset) => !['e2ee', 'voice'].includes(preset.name)),
        null,
      ),
    ).toEqual(recorded[0]);
    const saved = process.env.COLUMNS;
    try {
      for (const [at, columns] of widths.entries()) {
        process.env.COLUMNS = columns;
        const shown = await render('presets', {
          presets: listPresets().filter((preset) => !['e2ee', 'voice'].includes(preset.name)),
        });
        expect([columns, { out: shown.out, error: null }]).toEqual([columns, recorded[at + 1]]);
        expect(shown.err).toBe('');
      }
    } finally {
      if (saved === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = saved;
    }
    // What an earlier version never printed, named so a failure says which half regressed.
    expect(recorded[1]?.out).toContain('| --set verification   require email verification');
  });

  test("a user file's --set lines come in the file's order, and its box where a code-point sort puts it", async () => {
    // A JavaScript object lists `"10"` and `"0"` before `users`; earlier releases keep the
    // order written. And UTF-16 sorts the astral emoji below U+FF21, where code points sort
    // it above.
    const files: readonly (readonly [string, string])[] = [
      [
        'ordered.yaml',
        'name: ordered\ndescription: Keys in the order written.\nparams_help:\n' +
          '  users: how many users\n  "10": ten\n  alpha: first letter\n  "0": zero\n',
      ],
      ['😀-emoji.yaml', 'name: 😀-emoji\ndescription: astral\n'],
      ['Ａ-fullwidth.yaml', 'name: Ａ-fullwidth\ndescription: above the surrogates\n'],
    ];
    const dir = config.presetDir();
    fs.mkdirSync(dir, { recursive: true });
    try {
      for (const [file, text] of files) fs.writeFileSync(path.join(dir, file), text, 'utf8');
      const recorded = RECORDED.presets.userFiles;
      expect(
        ours(
          listPresets().filter((preset) => !['e2ee', 'voice'].includes(preset.name)),
          null,
        ),
      ).toEqual(recorded);
      const out = recorded.out;
      const box = out.slice(out.indexOf('+- ordered '));
      const keys = box
        .slice(0, box.indexOf('\n+-'))
        .split('\n')
        .filter((line) => line.startsWith('| --set '))
        .map((line) => line.split(/ +/u)[2]);
      expect(keys).toEqual(['users', '10', 'alpha', '0']);
      expect(out.indexOf('+- Ａ-fullwidth')).toBeLessThan(out.indexOf('+- 😀-emoji'));
    } finally {
      for (const [file] of files) fs.rmSync(path.join(dir, file), { force: true });
    }
  });
});

/**
 * `houston env` against what earlier releases printed with the current values and the write
 * answering the payload given.
 *
 * An earlier version marked a drifted row `!! NOT RUNNING` and printed neither drift warning, so a
 * recorded value the container is not running was shown with nothing saying what to do about it;
 * nor the `could not be read` note, the `--setting`/`--set` examples, or the `verify:` line after
 * an applied write. The examples carry `--name` only when one was typed, which is why each case
 * says whether it was.
 */
describe('env', () => {
  type Bag = Record<string, unknown>;
  const row = (key: string, value: string, override = false, drift = false): Bag => ({
    key,
    value,
    override,
    ...(drift ? { drift: true, live: '' } : {}),
  });
  // [what was typed as --name, the --set values (null for a read), the payload]
  const CASES: [string, string[] | null, Bag][] = [
    [
      'alpha',
      null,
      {
        name: 'alpha',
        env: [
          row('ADMIN_PASS', '********', false, true),
          row('FOO', 'bar', true, true),
          row('MONGO_URL', 'mongodb://mongodb:27017/rocketchat'),
          row('PORT', '3000', false, true),
        ],
        overrides: ['FOO'],
        drift: ['ADMIN_PASS', 'FOO', 'PORT'],
        live_read: true,
      },
    ],
    [
      'alpha',
      null,
      {
        name: 'alpha',
        env: [row('FOO', 'bar', true)],
        overrides: ['FOO'],
        drift: [],
        live_read: false,
      },
    ],
    [
      '',
      null,
      { name: 'alpha', env: [row('PORT', '3000')], overrides: [], drift: [], live_read: true },
    ],
    // Kubernetes: the container itself was asked, so there is no drift and no live_read.
    ['beta', null, { name: 'beta', env: [row('FOO', 'bar', true)], overrides: ['FOO'] }],
    [
      'alpha',
      ['A=1'],
      { name: 'alpha', restarted: true, overrides: [{ key: 'A', value: '1', removed: false }] },
    ],
    [
      '',
      ['A=1'],
      { name: 'alpha', restarted: false, overrides: [{ key: 'FOO', value: '', removed: true }] },
    ],
  ];

  async function ours(typed: string, sets: string[] | null, result: Bag): Promise<string> {
    const spec = (COMMAND_SPECS as readonly CommandSpec[]).find((item) => item.path === 'env');
    if (spec === undefined) throw new Error('no env command');
    let out = '';
    await renderHuman(
      { spec, arguments: {}, options: { name: typed, set_: sets ?? [] }, events: null },
      result,
      { writeOut: (text) => (out += text), writeErr: () => {} },
    );
    return out;
  }

  test('the panel, the drift warnings and every hint line are those of earlier releases', async () => {
    const recorded = RECORDED.env;
    // All at once, so a failure shows every case that differs rather than the first.
    const shown: string[] = [];
    for (const [typed, sets, result] of CASES) shown.push(await ours(typed, sets, result));
    expect(shown).toEqual(recorded);
    // What an earlier version never printed, named so a failure says which half regressed.
    expect(recorded[0]).toContain(
      '|  FOO         bar   <- yours   !! NOT IN THE RUNNING CONTAINER  |',
    );
    expect(recorded[0]).toContain(
      '  3 recorded value(s) are NOT what the container is running: ADMIN_PASS, FOO, PORT\n' +
        '  Rocket.Chat is using the old value. `houston env --set ADMIN_PASS=<value> --name alpha`',
    );
    expect(recorded[1]).toContain('  the container could not be read, so this is the recorded');
    expect(recorded[2]).toContain('  a raw env var:        houston env --set KEY=VALUE\n');
    expect(recorded[4]).toMatch(/ {2}verify: houston env --name alpha\n$/u);
    expect(recorded[5]).not.toContain('verify:');
  });

  test('names an unset key as removed, not among your overrides', async () => {
    // `env --unset FOO` records FOO as null, and the footer went on saying "your overrides:
    // FOO" for a variable that was gone (live matrix 2026-10-30, F1).
    const read = (overrides: string[], removed: string[]): Promise<string> =>
      ours('alpha', null, {
        name: 'alpha',
        env: [row('BAR', '1', true)],
        overrides,
        removed,
        drift: [],
        live_read: true,
      });
    const both = await read(['BAR', 'FOO'], ['FOO']);
    expect(both).toContain('  your overrides: BAR\n  removed by you: FOO\n');
    expect(both).not.toContain('no overrides');
    const onlyRemoved = await read(['FOO'], ['FOO']);
    expect(onlyRemoved).toContain('  removed by you: FOO\n');
    expect(onlyRemoved).not.toMatch(/your overrides|no overrides/u);
  });
});

/**
 * `houston pat`'s two lines against what earlier releases printed with the workspace, the
 * login and the mint stubbed to the payload given. `bypass_2fa=` prints the bool as
 * `True`/`False`, where `display` wrote `true`/`false` on every successful mint; the name
 * and URL print what the record holds, which is not always text.
 */
describe('pat', () => {
  const ROWS = [
    { name: 'alpha', root_url: 'http://localhost:3100', bypass_2fa: true },
    { name: 'alpha', root_url: 'http://localhost:3100', bypass_2fa: false },
    { name: 123, root_url: null, bypass_2fa: true },
  ].map((row) => ({ ...row, token: 'pat-1', user_id: 'uid', label: 'houston' }));

  test('the header and the headers line are those of earlier releases, the flag as true or false', async () => {
    const recorded = RECORDED.pat;
    const shown: string[] = [];
    for (const row of ROWS) shown.push((await render('pat', row)).out);
    expect(shown).toEqual(recorded);
    expect(recorded[1]).toContain('(http://localhost:3100) — bypass_2fa=false\n');
  });
});

/**
 * `houston monitor`'s lines against what earlier releases printed with the service stubbed
 * to the payload given. The detach line dropped earlier releases'
 * ` (metrics setting left as-is — workspace not reachable)` when `rc_setting_reset` was false,
 * the shared-stack note was reworded, and the attach line had no blank line after it.
 */
describe('monitor', () => {
  const grafana = 'http://localhost:5050';
  const CASES: [boolean, Record<string, unknown>][] = [
    [
      false,
      {
        name: 'alpha',
        monitoring: true,
        grafana_url: grafana,
        notes: [`Grafana:    ${grafana}  (admin/admin)`, 'Prometheus: http://localhost:9090'],
      },
    ],
    [
      false,
      {
        name: 'alpha',
        monitoring: true,
        grafana_url: grafana,
        notes: [
          `Grafana: ${grafana} (admin/admin)`,
          'the stack is SHARED by every workspace on this cluster',
        ],
      },
    ],
    [true, { name: 'alpha', monitoring: false, rc_setting_reset: true }],
    [true, { name: 'alpha', monitoring: false, rc_setting_reset: false }],
    [true, { name: 'alpha', monitoring: false, rc_setting_reset: true, stack_removed: false }],
    [true, { name: 'alpha', monitoring: false, rc_setting_reset: false, stack_removed: true }],
  ];

  async function ours(off: boolean, result: Record<string, unknown>): Promise<string> {
    const spec = (COMMAND_SPECS as readonly CommandSpec[]).find((item) => item.path === 'monitor');
    if (spec === undefined) throw new Error('no monitor command');
    let out = '';
    await renderHuman(
      { spec, arguments: {}, options: { name: 'alpha', off }, events: null },
      result,
      {
        writeOut: (text) => (out += text),
        writeErr: () => {},
      },
    );
    return out;
  }

  test('the attach and detach lines, and the notes after them, are those of earlier releases', async () => {
    const recorded = RECORDED.monitor;
    // All at once, so a failure shows every case that differs rather than the first.
    const shown: string[] = [];
    for (const [off, result] of CASES) shown.push(await ours(off, result));
    expect(shown).toEqual(recorded);
    expect(recorded[0]).toMatch(/^✓ monitoring attached to 'alpha'\n\nGrafana: /u);
    expect(recorded[3]).toBe(
      "✓ monitoring detached from 'alpha' (metrics setting left as-is — workspace not reachable)\n",
    );
    expect(recorded[4]).toContain('other workspaces on this cluster are still using it\n');
  });
});
