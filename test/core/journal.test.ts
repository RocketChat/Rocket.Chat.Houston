import * as fs from 'node:fs';
import * as path from 'node:path';

import * as config from '../../src/lib/config';
import { recordJournal, journalSinkInstalled } from '../../src/lib/journal';

import {
  ADVISORY,
  CLUSTER_UNFINISHED,
  CREATE_UNFINISHED,
  DIRNAME,
  KINDS,
  OUTLIVE_THE_WORKSPACE,
  RATE_LIMITER_OFF,
  WORKSPACE_KINDS,
  abandoned,
  clear,
  clearKind,
  clearWorkspace,
  describe as describeEntry,
  journalDir,
  openEntries,
  ownerAlive,
  pendingSeed,
  procStarted,
  record,
  recover,
  registerSubjectPredicate,
  repairKinds,
  subjectPredicateKinds,
  type Entry,
} from '../../src/core/journal';
import type * as AppMod from '../../src/cli/app';
import type * as HandlersMod from '../../src/cli/handlers';
import type * as VersionsMod from '../../src/lib/versions';
import type * as TestsetupPolicyMod from '../testsetup-policy';
import type * as EksMod from '../../src/core/eks';
import type * as JournalMod from '../../src/core/journal';
import type * as CreateDockerMod from '../../src/core/lifecycle/create-docker';
import type * as TypesMod from '../../src/core/lifecycle/types';
import type * as RecoveryMod from '../../src/core/recovery';

/** The sentence earlier releases wrote for each kind, in KINDS order, recorded. */
const RECORDED_DESCRIPTIONS = (
  JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'core', 'journal.json'), 'utf8'),
  ) as { describe: string[] }
).describe;

/**
 * A note an earlier release wrote for `cluster_unfinished` on `a-cluster`, recorded byte
 * for byte, under the file name it gave it. Its owner has long since exited.
 */
const RECORDED_NOTE_ID = 'faca1689b2d02cd3';
const RECORDED_NOTE = [
  '{',
  '  "id": "faca1689b2d02cd3",',
  '  "kind": "cluster_unfinished",',
  '  "workspace": "a-cluster",',
  '  "pid": 1293470,',
  '  "started": "6273650",',
  '  "at": "2026-09-29T08:49:46Z",',
  '  "detail": {',
  '    "region": "eu-west-1",',
  '    "account": "123"',
  '  }',
  '}',
].join('\n');

beforeEach(() => {
  fs.rmSync(journalDir(), { recursive: true, force: true });
});

/**
 * `lifecycle/ports.claimSidePorts` on a machine where every preferred side and monitoring port
 * is free: the preset as built, nothing moved, monitoring on its preferred pair.
 */
async function preferredSidePorts(
  _name: string,
  pre: unknown,
  _rebuild: unknown,
  options: { monitoring?: readonly string[] } = {},
) {
  return {
    pre,
    side: {},
    monitoring: (options.monitoring ?? []).map((slot) => (slot === 'prometheus' ? 9090 : 5050)),
    moved: [],
  };
}

describe('the note on disk', () => {
  it('is one JSON file per open side effect, named by its id', () => {
    // A DIRECTORY rather than a single log: entries are created and cleared concurrently
    // by unrelated jobs, and an unlink is atomic where a rewrite of a shared file is a
    // lost-update race.
    const id = record(RATE_LIMITER_OFF, 'TICKET-1');
    expect(id).toMatch(/^[0-9a-f]{16}$/u);
    expect(fs.existsSync(path.join(journalDir(), `${id}.json`))).toBe(true);
    expect(fs.readdirSync(journalDir())).toHaveLength(1);
  });

  it('carries the pid AND that process start time, because pids are recycled', () => {
    const id = record(RATE_LIMITER_OFF, 'TICKET-1');
    const entry = openEntries().find((e) => e.id === id);
    expect(entry?.pid).toBe(process.pid);
    expect(entry?.started).toBe(procStarted(process.pid));
    expect(entry?.started).not.toBe('');
  });

  it('stamps UTC, because a note is read beside doctor, list and an audit line', () => {
    // One event once read 22:29 in a journal note and 16:59 in the repro.json beside it.
    const id = record(RATE_LIMITER_OFF, 'TICKET-1');
    const entry = openEntries().find((e) => e.id === id);
    expect(entry?.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u);
  });

  it('refuses a kind outside the closed vocabulary', () => {
    // Recovery has to know how to undo each one, so a kind nothing can repair is a note
    // that would sit there forever looking like a fault.
    expect(() => record('invented', 'TICKET-1')).toThrow(/unknown journal kind/u);
  });

  it('keeps BENCH_WORKSPACE even though nothing writes it any more', () => {
    // A journal note is durable state on somebody's disk, and the point of this module is
    // that a killed process's side effects are recoverable LATER -- by a build newer than
    // the one that made the mess.
    expect(KINDS).toContain('bench_workspace');
    expect(repairKinds()).toContain('bench_workspace');
  });

  it('is best-effort: an unwritable home returns "" rather than throwing', () => {
    const blocked = path.join(config.home(), 'blocked-journal');
    fs.writeFileSync(blocked, 'not a directory');
    const previous = process.env.HOUSTON_HOME;
    process.env.HOUSTON_HOME = blocked;
    try {
      expect(record(RATE_LIMITER_OFF, 'TICKET-1')).toBe('');
    } finally {
      if (previous === undefined) delete process.env.HOUSTON_HOME;
      else process.env.HOUSTON_HOME = previous;
    }
  });

  it('skips an unreadable file rather than raising out of a listing', () => {
    record(RATE_LIMITER_OFF, 'TICKET-1');
    fs.writeFileSync(path.join(journalDir(), 'garbage.json'), 'not json');
    expect(openEntries()).toHaveLength(1);
  });
});

describe('clearing', () => {
  it('forgets one entry, and an empty id is a no-op', () => {
    const id = record(RATE_LIMITER_OFF, 'TICKET-1');
    clear('');
    expect(openEntries()).toHaveLength(1);
    clear(id);
    expect(openEntries()).toHaveLength(0);
  });

  it('forgets EVERY note of one kind for one workspace', () => {
    // A create that failed left a note behind, and a later create of the same name that
    // succeeded cleared only the note it had written itself -- so the stale one went on
    // claiming a complete workspace had never finished.
    record(CREATE_UNFINISHED, 'TICKET-1');
    record(CREATE_UNFINISHED, 'TICKET-1');
    record(CREATE_UNFINISHED, 'TICKET-2');
    record(RATE_LIMITER_OFF, 'TICKET-1');
    expect(clearKind(CREATE_UNFINISHED, 'TICKET-1')).toBe(2);
    expect(
      openEntries()
        .map((e) => `${e.kind}:${e.workspace}`)
        .sort(),
    ).toEqual(['create_unfinished:TICKET-2', 'rate_limiter_off:TICKET-1']);
  });

  it('forgets every note ABOUT one workspace, and nothing about any other subject', () => {
    // What `down --volumes` and `prune` call once the record is gone. Another workspace's
    // notes stay, and so does a `cluster_unfinished` whose `workspace` field holds the same
    // name: it is about a cloud cluster that may be billing. Every kind is decided one way
    // or the other, so a new one cannot fall into a default nobody chose.
    expect(new Set([...WORKSPACE_KINDS, ...OUTLIVE_THE_WORKSPACE])).toEqual(new Set(KINDS));
    expect(WORKSPACE_KINDS.filter((kind) => OUTLIVE_THE_WORKSPACE.includes(kind))).toEqual([]);
    for (const kind of KINDS) record(kind, 'gone');
    record(CREATE_UNFINISHED, 'gone');
    record(CREATE_UNFINISHED, 'other');
    record(RATE_LIMITER_OFF, 'other');

    expect(clearWorkspace('gone')).toBe(WORKSPACE_KINDS.length + 1);
    expect(
      openEntries()
        .map((e) => `${e.kind}:${e.workspace}`)
        .sort(),
    ).toEqual(['cluster_unfinished:gone', 'create_unfinished:other', 'rate_limiter_off:other']);
    // Nothing left to clear is not an error.
    expect(clearWorkspace('gone')).toBe(0);
  });
});

describe('whose note it is', () => {
  const base: Entry = {
    id: 'x',
    kind: RATE_LIMITER_OFF,
    workspace: 'w',
    pid: process.pid,
    started: '',
    at: '',
    detail: {},
  };

  it('reads a live process with a matching start time as alive', () => {
    expect(ownerAlive({ ...base, started: procStarted(process.pid) ?? '' })).toBe(true);
  });

  it('reads a recycled pid as DEAD, which is the whole reason the start time is stored', () => {
    expect(ownerAlive({ ...base, started: 'not-the-start-time' })).toBe(false);
  });

  it('assumes ALIVE when the start time is unknowable, so recovery leaves it alone', () => {
    // The conservative direction: undoing live work is worse than keeping a stale note.
    expect(ownerAlive({ ...base, started: '' })).toBe(true);
  });

  it('reads a pid that is not running as dead', () => {
    expect(procStarted(2 ** 22)).toBeNull();
    expect(ownerAlive({ ...base, pid: 2 ** 22, started: 'anything' })).toBe(false);
  });

  it('lists only abandoned entries as actionable', () => {
    record(RATE_LIMITER_OFF, 'mine');
    expect(abandoned()).toHaveLength(0);
    const dead = openEntries()[0] as Entry;
    fs.writeFileSync(
      path.join(journalDir(), `${dead.id}.json`),
      JSON.stringify({ ...dead, pid: 2 ** 22, started: 'gone' }),
    );
    expect(abandoned()).toHaveLength(1);
  });
});

describe('the subject predicate', () => {
  it('defaults to "is there a workspace by that name"', () => {
    expect(subjectPredicateKinds()).not.toContain(RATE_LIMITER_OFF);
  });

  it('refuses a second, different predicate for one kind', () => {
    const first = () => true;
    registerSubjectPredicate('rate_limiter_off', first);
    expect(() => registerSubjectPredicate('rate_limiter_off', () => false)).toThrow(
      /already registered/u,
    );
    // Idempotent for the same function, so a re-import is not an error.
    expect(() => registerSubjectPredicate('rate_limiter_off', first)).not.toThrow();
  });
});

describe('describe()', () => {
  function entry(kind: string, detail: Record<string, unknown> = {}): Entry {
    return { id: 'i', kind, workspace: 'TICKET-1', pid: 1, started: '', at: 'T', detail };
  }

  it('gives the cluster note CloudFormation-shaped advice, not the advice that fails', () => {
    // A rolled-back `eksctl create` can leave its stack behind, and `eksctl delete` then
    // reports that the cluster does not exist while a VPC and a NAT gateway carry on
    // billing.
    const line = describeEntry(entry(CLUSTER_UNFINISHED, { region: 'eu-west-1', account: '1' }));
    expect(line).toContain('BILLING NOW');
    expect(line).toContain('eksctl delete cluster --name TICKET-1 --region eu-west-1 --wait');
    expect(line).toContain('aws cloudformation describe-stacks');
  });

  it('falls back to a generic line for a kind it has no sentence for', () => {
    expect(describeEntry(entry('bench_workspace'))).toContain('throwaway benchmark workspace');
  });

  it('describes every kind in the words earlier releases used', () => {
    const cases = KINDS.map((k) => ({
      id: 'i',
      kind: k,
      workspace: 'TICKET-1',
      pid: 1,
      started: '',
      at: 'T',
      detail:
        k === CLUSTER_UNFINISHED
          ? { region: 'eu-west-1', account: '123' }
          : k === 'constraints_applied'
            ? { applied: [{ service: 'rocketchat' }, { service: 'mongodb' }] }
            : k === 'database_dropped'
              ? { bundle: 'b.tar.gz' }
              : k === CREATE_UNFINISHED
                ? { seed: 'small' }
                : k === 'e2ee_default_off'
                  ? { setting: 'E2E_Enabled_Default_PrivateRooms' }
                  : {},
    }));
    expect(RECORDED_DESCRIPTIONS).toHaveLength(KINDS.length);
    expect(cases.map((c) => describeEntry(c as Entry))).toEqual(RECORDED_DESCRIPTIONS);
  });
});

describe('recover()', () => {
  function makeAbandoned(kind: string, workspace: string, detail: Record<string, unknown> = {}) {
    const id = record(kind, workspace, detail);
    const file = path.join(journalDir(), `${id}.json`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Entry;
    fs.writeFileSync(file, JSON.stringify({ ...data, pid: 2 ** 22, started: 'gone' }));
    return id;
  }

  it('a DRY RUN never deletes anything, which it used to', async () => {
    // The clear sat above the dry-run check, so a dry run over two notes reported one and
    // DELETED the other -- and a dry run is the only way to inspect the journal without
    // repairing it, which makes mutating one a contradiction in terms.
    makeAbandoned(CREATE_UNFINISHED, 'gone-workspace');
    makeAbandoned(CREATE_UNFINISHED, 'other-gone');
    const rows = await recover(undefined, { dryRun: true });
    expect(rows).toHaveLength(2);
    expect(openEntries()).toHaveLength(2);
    expect(rows[0]?.why).toBe('the thing it is about is gone; would be dropped');
  });

  it('reports an advisory note rather than acting on it', async () => {
    registerSubjectPredicate(CLUSTER_UNFINISHED, () => true);
    makeAbandoned(CLUSTER_UNFINISHED, 'a-cluster', { region: 'eu-west-1' });
    const rows = await recover();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.repaired).toBe(false);
    expect(rows[0]?.why).toBe('needs `houston ready`');
    // And it is STILL THERE, because deleting a cloud cluster is not a decision a process
    // that already crashed gets to make.
    expect(openEntries()).toHaveLength(1);
  });

  it('drops an advisory note whose subject is gone', async () => {
    makeAbandoned(CREATE_UNFINISHED, 'never-existed');
    expect(await recover()).toHaveLength(0);
    expect(openEntries()).toHaveLength(0);
  });

  it('answers "still there" when the predicate THROWS, because unaskable is not gone', async () => {
    registerSubjectPredicate('database_dropped', () => {
      throw new Error('cannot ask');
    });
    makeAbandoned('database_dropped', 'w', { bundle: 'b.tar.gz' });
    const rows = await recover();
    expect(rows).toHaveLength(1);
    expect(openEntries()).toHaveLength(1);
  });
});

describe('pendingSeed', () => {
  it('does not turn an abandoned unseeded CLI create into a seed request', () => {
    const id = record(CREATE_UNFINISHED, 'TICKET-1', { seed: false, seed_here: true });
    const file = path.join(journalDir(), `${id}.json`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Entry;
    fs.writeFileSync(file, JSON.stringify({ ...data, pid: 2 ** 22, started: 'gone' }));
    expect(pendingSeed('TICKET-1')).toEqual({});
  });

  it('reads the seed off the NOTE, because that is the only place it survives', () => {
    // `meta.extra.seed` is written only after a seed has already succeeded, so metadata
    // can say "seeded" or say nothing, and "nothing" covers both "none was asked for" and
    // "one was asked for and lost".
    const id = record(CREATE_UNFINISHED, 'TICKET-1', { seed: 'small' });
    const file = path.join(journalDir(), `${id}.json`);
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Entry;
    fs.writeFileSync(file, JSON.stringify({ ...data, pid: 2 ** 22, started: 'gone' }));
    expect(pendingSeed('TICKET-1')).toEqual({ seed: 'small' });
    expect(pendingSeed('TICKET-2')).toEqual({});
  });

  it('ignores a note whose owner is still alive, or seeding would run twice', () => {
    record(CREATE_UNFINISHED, 'TICKET-1', { seed: 'small' });
    expect(pendingSeed('TICKET-1')).toEqual({});
  });
});

describe('the registry', () => {
  it('is installed by importing this module', () => {
    expect(journalSinkInstalled()).toBe(true);
  });

  it('returns a usable id through lib/journal, so the writer can clear its own note', () => {
    // `core/eks` writes CLUSTER_UNFINISHED on the line before a twenty-minute call and
    // clears it by id afterwards. A sink that returned '' would leave every finished
    // cluster's note behind, reported forever as unfinished.
    const id = recordJournal(CLUSTER_UNFINISHED, 'a-cluster', { region: 'eu-west-1' });
    expect(id).toMatch(/^[0-9a-f]{16}$/u);
    expect(openEntries()).toHaveLength(1);
  });
});

describe('compatibility with the notes earlier releases wrote', () => {
  it('reads a note an earlier release wrote, field for field', () => {
    fs.mkdirSync(journalDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(journalDir(), `${RECORDED_NOTE_ID}.json`), RECORDED_NOTE, 'utf8');
    const entries = openEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(RECORDED_NOTE_ID);
    expect(entries[0]?.kind).toBe(CLUSTER_UNFINISHED);
    expect(entries[0]?.workspace).toBe('a-cluster');
    expect(entries[0]?.detail).toEqual({ region: 'eu-west-1', account: '123' });
  });

  it('writes a note an earlier release reads, field for field', () => {
    // An earlier release reads every `<id>.json` in the journal directory as JSON. This
    // build's note is the recorded one with its own id, owner and time in their places.
    const id = record(CLUSTER_UNFINISHED, 'a-cluster', { region: 'eu-west-1', account: '123' });
    const mine = fs.readFileSync(path.join(journalDir(), `${id}.json`), 'utf8');
    const theirs = JSON.parse(mine) as Record<string, unknown>;
    expect(mine).toBe(
      RECORDED_NOTE.replace(RECORDED_NOTE_ID, id)
        .replace('"pid": 1293470', `"pid": ${String(process.pid)}`)
        .replace('"started": "6273650"', `"started": ${JSON.stringify(theirs.started)}`)
        .replace('"at": "2026-09-29T08:49:46Z"', `"at": ${JSON.stringify(theirs.at)}`),
    );
    expect(fs.readdirSync(journalDir())).toEqual([`${id}.json`]);
    expect(theirs.id).toBe(id);
    expect(theirs.detail).toEqual({ region: 'eu-west-1', account: '123' });
    expect(theirs.pid).toBe(process.pid);
  });

  it('writes the same file name and directory earlier releases look in', () => {
    expect(`${DIRNAME} ${journalDir()}`).toBe(`journal ${config.home()}/journal`);
  });

  it('agrees about which kinds are advisory', () => {
    // The kinds and the advisory ones, in the order earlier releases listed them.
    expect([...KINDS]).toEqual([
      'rate_limiter_off',
      'rocketchat_stopped',
      'bench_workspace',
      'constraints_applied',
      'create_unfinished',
      'rc_metrics_on',
      'mongo_profiler_on',
      'email_2fa_off',
      'database_dropped',
      'cluster_unfinished',
      'e2ee_default_off',
    ]);
    expect([...ADVISORY]).toEqual(['create_unfinished', 'database_dropped', 'cluster_unfinished']);
  });
});

/** A note whose owner is provably gone, written through `mod`'s own `record`. */
function plantAbandoned(
  mod: { record: typeof record; journalDir: typeof journalDir },
  kind: string,
  workspace: string,
  detail: Record<string, unknown> = {},
): string {
  const id = mod.record(kind, workspace, detail);
  const file = path.join(mod.journalDir(), `${id}.json`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Entry;
  fs.writeFileSync(file, JSON.stringify({ ...data, pid: 2 ** 22, started: '1' }));
  return id;
}

describe('a side effect wrapped in its note', () => {
  it('clears the note when the cleanup ran, on success and on a throw alike', async () => {
    // A surviving entry has to mean precisely "the cleanup did not happen".
    const { sideEffect } = require('../../src/core/journal') as typeof JournalMod;
    await sideEffect(RATE_LIMITER_OFF, 'w', () => {
      expect(openEntries()).toHaveLength(1);
    });
    expect(openEntries()).toEqual([]);
    await expect(
      sideEffect(RATE_LIMITER_OFF, 'w', () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(openEntries()).toEqual([]);
    // A kind recovery does not know how to undo is refused at the door.
    expect(() => record('something_new', 'w')).toThrow();
  });
});

describe('a repairable note for a workspace that is gone', () => {
  it('is repaired by clearing it, because whatever was done went with the workspace', async () => {
    plantAbandoned({ record, journalDir }, 'rocketchat_stopped', 'deleted-long-ago');
    const rows = await recover();
    expect(rows[0]?.repaired).toBe(true);
    expect(openEntries()).toEqual([]);
  });
});

describe('recovery through the side-effect owners', () => {
  afterEach(() => {
    for (const id of [
      '../../src/core/runner/engine',
      '../../src/core/runner/paths',
      '../../src/core/runner/record',
      '../../src/core/rcapi',
    ]) {
      jest.dontMock(id);
    }
    jest.dontMock('../../src/perf/constrain');
    jest.resetModules();
  });

  /** A fresh journal and recovery, the workspace present, and the engine calls recorded. */
  function owners(overrides: { setSetting?: () => Promise<boolean> } = {}) {
    jest.resetModules();
    const calls: unknown[][] = [];
    const restored: Record<string, unknown>[][] = [];
    jest.doMock('../../src/core/runner/paths', () => ({
      ...jest.requireActual('../../src/core/runner/paths'),
      exists: async () => true,
      remove: async () => undefined,
    }));
    jest.doMock('../../src/core/runner/engine', () => ({
      ...jest.requireActual('../../src/core/runner/engine'),
      down: async (name: string, options: { volumes?: boolean } = {}) => {
        calls.push(['down', name, options.volumes === true]);
        return 0;
      },
      startServices: async (name: string, services: string[]) => {
        calls.push(['start', name, services]);
        return 0;
      },
    }));
    jest.doMock('../../src/perf/constrain', () => ({
      ...jest.requireActual('../../src/perf/constrain'),
      restore: async (applied: Record<string, unknown>[]) => {
        restored.push(applied);
        return [];
      },
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      readMeta: async () => ({ name: 'w', rootUrl: 'http://localhost:3000', extra: {} }),
    }));
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      setSetting: overrides.setSetting ?? (async () => true),
    }));
    const mod = require('../../src/core/journal') as typeof JournalMod;
    const recovery = require('../../src/core/recovery') as typeof RecoveryMod;
    return { mod, recovery, calls, restored };
  }

  it('takes the bench workspace down with its volume, and puts the PRIOR caps back', async () => {
    // A performance run's caps go back to what they were, not to "unlimited", which is why
    // the note carries them; and restore must not cap a dimension nobody capped.
    const { mod, recovery, calls, restored } = owners();
    plantAbandoned(mod, mod.BENCH_WORKSPACE, 'w');
    expect((await recovery.recover())[0]?.repaired).toBe(true);
    expect(calls).toEqual([['down', 'w', true]]);
    plantAbandoned(mod, mod.CONSTRAINTS_APPLIED, 'w', {
      applied: [
        {
          container: 'abc',
          service: 'rocketchat',
          prior_nano: 2_000_000_000,
          prior_mem: 1073741824,
          prior_swap: -1,
          set_cpus: true,
          set_mem: false,
        },
      ],
    });
    expect((await recovery.recover())[0]?.repaired).toBe(true);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.[0]).toMatchObject({ prior_nano: 2_000_000_000, set_mem: false });
  });

  it('starts Rocket.Chat again, and keeps a rate-limiter note whose repair failed', async () => {
    // A workspace left stopped is "a worse outcome than the failure itself"; the limiter
    // left off is a security-relevant setting nobody chose.
    let accept = false;
    const { mod, recovery, calls } = owners({ setSetting: async () => accept });
    plantAbandoned(mod, mod.ROCKETCHAT_STOPPED, 'w', { services: ['rocketchat'] });
    const rows = await recovery.recover();
    expect(rows[0]?.repaired).toBe(true);
    expect(calls).toEqual([['start', 'w', ['rocketchat']]]);
    expect(mod.openEntries()).toEqual([]);

    const login = async () => ({ token: 't', userId: 'u' });
    plantAbandoned(mod, mod.RATE_LIMITER_OFF, 'w');
    expect((await recovery.recover(undefined, { login }))[0]?.repaired).toBe(false);
    expect(mod.openEntries()).toHaveLength(1);
    accept = true;
    expect((await recovery.recover(undefined, { login }))[0]?.repaired).toBe(true);
    expect(mod.openEntries()).toEqual([]);
  });
});

describe('the note about a half-built cloud cluster', () => {
  afterEach(() => {
    jest.resetModules();
  });

  it('survives a restart while AWS says it is there or cannot say, and clears once it is gone', async () => {
    // A cluster is not a workspace, so "is there a workspace by that name" would have
    // deleted the most expensive note the product can hold at the next `serve` startup.
    jest.resetModules();
    const mod = require('../../src/core/journal') as typeof JournalMod;
    const eks = require('../../src/core/eks') as typeof EksMod;
    const realDescribe = eks.aws.describeCluster;
    try {
      plantAbandoned(mod, CLUSTER_UNFINISHED, 'rc-support', {
        region: 'eu-west-1',
        account: '1',
      });
      eks.aws.describeCluster = () => Promise.resolve({ state: 'present' as const, doc: {} });
      expect((await mod.recover(undefined, { dryRun: true })).map((row) => row.kind)).toEqual([
        CLUSTER_UNFINISHED,
      ]);
      expect(mod.openEntries()).toHaveLength(1);
      eks.aws.describeCluster = () => Promise.resolve({ state: 'refused' as const, doc: null });
      expect(await mod.recover()).toHaveLength(1);
      expect(mod.openEntries()).toHaveLength(1);
      eks.aws.describeCluster = () => Promise.resolve({ state: 'absent' as const, doc: null });
      await mod.recover();
      expect(mod.openEntries()).toEqual([]);
    } finally {
      eks.aws.describeCluster = realDescribe;
    }
  });
});

describe('recovery and the login it needs', () => {
  afterEach(() => {
    jest.dontMock('../../src/core/runner/paths');
    jest.resetModules();
  });

  it('is handed the login by its caller, rather than importing the orchestration', async () => {
    // The journal sits below lifecycle; a repair that needs a session receives one.
    jest.resetModules();
    jest.doMock('../../src/core/runner/paths', () => ({
      ...jest.requireActual('../../src/core/runner/paths'),
      exists: async () => true,
    }));
    const mod = require('../../src/core/journal') as typeof JournalMod;
    const given: unknown[] = [];
    mod.registerRepair('email_2fa_off', (_entry, _emit, login) => {
      given.push(login);
      return true;
    });
    const login = async () => null;
    plantAbandoned(mod, 'email_2fa_off', 'w');
    expect((await mod.recover(undefined, { login }))[0]?.repaired).toBe(true);
    expect(given).toEqual([login]);
  });
});

describe('the note a create writes before it starts', () => {
  afterEach(() => {
    jest.doMock('../../src/core/runner/host', () =>
      (require('../testsetup-policy') as typeof TestsetupPolicyMod).healthyHost(),
    );
    for (const id of [
      '../../src/core/lifecycle/sizing',
      '../../src/core/lifecycle/ports',
      '../../src/core/lifecycle/tlsplan',
      '../../src/core/lifecycle/preconditions',
      '../../src/lib/versions',
      '../../src/core/runner/record',
      '../../src/core/rcapi',
    ]) {
      jest.dontMock(id);
    }
    jest.resetModules();
  });

  /** The Compose create with the engine stated, stopped at the write seam with the note read. */
  function stoppedAtTheWrite(): Record<string, unknown>[] {
    jest.resetModules();
    const notes: Record<string, unknown>[] = [];
    jest.doMock('../../src/core/runner/host', () => ({
      ...(require('../testsetup-policy') as typeof TestsetupPolicyMod).healthyHost(),
      dockerKernelVersion: async () => '6.1.0',
    }));
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../src/core/lifecycle/preconditions'),
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/sizing', () => ({
      ...jest.requireActual('../../src/core/lifecycle/sizing'),
      checkCapacity: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../src/core/lifecycle/ports'),
      pickHostPort: async () => 3001,
      claimSidePorts: preferredSidePorts,
    }));
    jest.doMock('../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../src/core/lifecycle/tlsplan'),
      resolveTls: async () => null,
    }));
    jest.doMock('../../src/lib/versions', () => {
      const actual = jest.requireActual<typeof VersionsMod>('../../src/lib/versions');
      return { ...actual, resolve: (v: string) => actual.resolve(v, { offline: true }) };
    });
    jest.doMock('../../src/core/rcapi', () => ({
      ...jest.requireActual('../../src/core/rcapi'),
      releaseInfo: async () => ({ status: 404, json: () => ({}) }),
    }));
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      write: async () => {
        const mod = require('../../src/core/journal') as typeof JournalMod;
        for (const entry of mod.openEntries()) {
          if (entry.kind === CREATE_UNFINISHED) notes.push({ ...entry.detail });
        }
        throw new Error('stopped at the write seam');
      },
    }));
    return notes;
  }

  it('carries the seed the request asked for, so `ready` can finish it', async () => {
    // `ready` cleared the note and never ran the pending seed: `req.seed` lived only in the
    // dead process's request. Verified live, and worse than leaving the note: the engineer
    // follows the tool's instruction and is told the workspace is complete.
    const notes = stoppedAtTheWrite();
    const { createRepro } =
      require('../../src/core/lifecycle/create-docker') as typeof CreateDockerMod;
    const { createReq } = require('../../src/core/lifecycle/types') as typeof TypesMod;
    await expect(
      createRepro(
        createReq({
          version: '8.5.1',
          name: 'halfmade',
          wait: false,
          seed: true,
          seedProfile: 'standard',
        }),
      ),
    ).rejects.toThrow('stopped at the write seam');
    expect(notes[0]).toMatchObject({ seed: true, seed_profile: 'standard' });
  });

  it('carries the seed `houston up --seed` is about to run itself', async () => {
    // `cli.up` built its request with seed=False because it seeds afterwards, so the note
    // recorded no seed and the `pending_seed` recovery covered the GUI and not the CLI.
    // `seed_here` keeps the two-phase shape: the CLI seeds, so the service must not.
    const notes = stoppedAtTheWrite();
    const app = require('../../src/cli/app') as typeof AppMod;
    const { createExecutor } = require('../../src/cli/handlers') as typeof HandlersMod;
    let out = '';
    const io = {
      writeOut: (value: string) => (out += value),
      writeErr: (value: string) => (out += value),
    };
    await app.runCli(
      [
        'up',
        '--version',
        '8.5.1',
        '--name',
        'sd',
        '--seed',
        '--seed-profile',
        'standard',
        '--offline',
      ],
      { execute: createExecutor(io), io },
    );
    expect(notes[0]).toMatchObject({ seed: true, seed_here: true, seed_profile: 'standard' });
  });

  it('says `seed_here` for a plain `houston up` too, as the CLI always did', async () => {
    // Earlier releases pass `seed_here: true` whatever `--seed` says: the CLI closes the
    // note itself. Deriving it from `--seed` wrote `seed_here: false` into every other note.
    const notes = stoppedAtTheWrite();
    const app = require('../../src/cli/app') as typeof AppMod;
    const { createExecutor } = require('../../src/cli/handlers') as typeof HandlersMod;
    const io = { writeOut: () => undefined, writeErr: () => undefined };
    await app.runCli(['up', '--version', '8.5.1', '--name', 'plain', '--offline'], {
      execute: createExecutor(io),
      io,
    });
    expect(notes[0]).toMatchObject({ seed: false, seed_here: true });
  });
});

describe('the note of a create the axes rename', () => {
  // `--deployment multi-instance` with no `--name`: locked and noted under `rc8-5-1`, the
  // name derived BEFORE `resolveAxes` ran, it makes `rc8-5-1-multi-instance`.
  afterEach(() => {
    jest.doMock('../../src/core/runner/host', () =>
      (require('../testsetup-policy') as typeof TestsetupPolicyMod).healthyHost(),
    );
    for (const id of [
      '../../src/core/lifecycle/sizing',
      '../../src/core/lifecycle/ports',
      '../../src/core/lifecycle/tlsplan',
      '../../src/core/lifecycle/preconditions',
      '../../src/core/lifecycle/ready',
      '../../src/lib/versions',
      '../../src/core/runner/record',
    ]) {
      jest.dontMock(id);
    }
    jest.resetModules();
  });

  /** The Compose create with the engine stated, run to the end with the boot a success. */
  function builtToTheEnd(): string[] {
    jest.resetModules();
    const during: string[] = [];
    jest.doMock('../../src/core/runner/host', () => ({
      ...(require('../testsetup-policy') as typeof TestsetupPolicyMod).healthyHost(),
      dockerKernelVersion: async () => '6.1.0',
    }));
    jest.doMock('../../src/core/lifecycle/preconditions', () => ({
      ...jest.requireActual('../../src/core/lifecycle/preconditions'),
      guardProjectCollision: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/sizing', () => ({
      ...jest.requireActual('../../src/core/lifecycle/sizing'),
      checkCapacity: async () => undefined,
    }));
    jest.doMock('../../src/core/lifecycle/ports', () => ({
      ...jest.requireActual('../../src/core/lifecycle/ports'),
      pickHostPort: async () => 3001,
      claimSidePorts: preferredSidePorts,
    }));
    jest.doMock('../../src/core/lifecycle/tlsplan', () => ({
      ...jest.requireActual('../../src/core/lifecycle/tlsplan'),
      resolveTls: async () => null,
    }));
    jest.doMock('../../src/lib/versions', () => {
      const actual = jest.requireActual<typeof VersionsMod>('../../src/lib/versions');
      return { ...actual, resolve: (v: string) => actual.resolve(v, { offline: true }) };
    });
    jest.doMock('../../src/core/runner/record', () => ({
      ...jest.requireActual('../../src/core/runner/record'),
      write: async () => {
        const mod = require('../../src/core/journal') as typeof JournalMod;
        for (const entry of mod.openEntries()) {
          if (entry.kind === CREATE_UNFINISHED) during.push(entry.workspace);
        }
      },
    }));
    jest.doMock('../../src/core/lifecycle/ready', () => ({
      ...jest.requireActual('../../src/core/lifecycle/ready'),
      upCompose: async () => 0,
    }));
    return during;
  }

  const unfinished = () =>
    (require('../../src/core/journal') as typeof JournalMod)
      .openEntries()
      .filter((entry) => entry.kind === CREATE_UNFINISHED)
      .map((entry) => [entry.workspace, entry.detail.seed_here]);

  it('is handed to the caller under the name the create made', async () => {
    // With `seedHere` the note is the caller's to close, by the name it is handed back.
    // Under the pre-rename name it was never closed; moved, it still covers the seed.
    const during = builtToTheEnd();
    const { createRepro } =
      require('../../src/core/lifecycle/create-docker') as typeof CreateDockerMod;
    const { createReq } = require('../../src/core/lifecycle/types') as typeof TypesMod;
    const out = await createRepro(
      createReq({
        version: '8.5.1',
        deployment: 'multi-instance',
        replicas: 3,
        offline: true,
        seedHere: true,
      }),
    );
    expect(out.name).toBe('rc8-5-1-multi-instance');
    expect(during).toEqual(['rc8-5-1']);
    expect(unfinished()).toEqual([['rc8-5-1-multi-instance', true]]);
  });

  it('is gone once `houston up` returns', async () => {
    // Earlier releases left journal/<id>.json for 'rc8-5-1', and `doctor` reported an unfinished
    // create for a workspace that does not exist.
    builtToTheEnd();
    const app = require('../../src/cli/app') as typeof AppMod;
    const { createExecutor } = require('../../src/cli/handlers') as typeof HandlersMod;
    const io = { writeOut: () => undefined, writeErr: () => undefined };
    const code = await app.runCli(
      [
        'up',
        '--offline',
        '--version',
        '8.5.1',
        '--deployment',
        'multi-instance',
        '--replicas',
        '3',
        '--json',
      ],
      { execute: createExecutor(io), io },
    );
    expect(code).toBe(0);
    expect(unfinished()).toEqual([]);
  });
});
