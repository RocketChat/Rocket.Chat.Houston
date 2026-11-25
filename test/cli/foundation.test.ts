import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Command, Option } from 'commander';

import { buildCli, commandOutcome, runCli } from '../../src/cli/app';
import { describeCommands } from '../../src/cli/capabilities';
import { COMMAND_SPECS } from '../../src/cli/spec-data';
import type { CommandSpec, OptionSpec } from '../../src/cli/spec-types';

const PACKAGE_VERSION = (
  JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

function registered(root: Command, path: string): Command {
  let current = root;
  for (const part of path.split(' ')) {
    const next = current.commands.find((candidate) => candidate.name() === part);
    if (next === undefined) throw new Error(`missing registered command ${path}`);
    current = next;
  }
  return current;
}

function optionByLong(command: Command, long: string): Option {
  const found = command.options.find((option) => option.long === long);
  if (found === undefined) throw new Error(`${command.name()} did not register ${long}`);
  return found;
}

function valueFor(option: OptionSpec, ordinal = 1): string {
  if (option.key === 'data') return '{}';
  if (option.key === 'port') return String(30_000 + ordinal);
  if (option.value === 'integer') return String(ordinal + 1);
  if (option.value === 'float') return `${ordinal + 1}.5`;
  return `value-${ordinal}`;
}

function argumentValue(name: string): string {
  if (name === 'method') return 'GET';
  if (name === 'path') return '/api/v1/me';
  if (name === 'version') return '7.4.1';
  if (name === 'action') return 'status';
  return `value-${name}`;
}

function baseArgv(spec: CommandSpec, omitRequired?: OptionSpec): string[] {
  const argv = spec.path.split(' ');
  for (const argument of spec.arguments) {
    if (argument.required) argv.push(argumentValue(argument.name));
  }
  for (const option of spec.options) {
    if (!option.required || option === omitRequired) continue;
    argv.push(option.long.split('/')[0] as string, valueFor(option));
  }
  return argv;
}

async function invoke(argv: string[]): Promise<{
  exit: number;
  calls: Parameters<Parameters<typeof runCli>[1]['execute']>[0][];
  out: string;
  err: string;
}> {
  const calls: Parameters<Parameters<typeof runCli>[1]['execute']>[0][] = [];
  let out = '';
  let err = '';
  const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  });
  try {
    const exit = await runCli(argv, {
      execute: async (invocation) => {
        calls.push(invocation);
        return { observed: invocation.spec.path };
      },
      io: {
        writeOut: (text) => {
          out += text;
        },
        writeErr: (text) => {
          err += text;
        },
      },
    });
    return { exit, calls, out, err };
  } finally {
    write.mockRestore();
  }
}

/** The options one argv parses to, which must parse cleanly. */
async function parsed(path: string, extra: string[]): Promise<Record<string, unknown>> {
  const spec = COMMAND_SPECS.find((candidate) => candidate.path === path) as CommandSpec;
  const result = await invoke([...baseArgv(spec), ...extra]);
  expect({ argv: extra, err: result.err, exit: result.exit }).toEqual({
    argv: extra,
    err: '',
    exit: 0,
  });
  return result.calls[0]?.options as Record<string, unknown>;
}

function pick(options: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, options[key]]));
}

describe('the declarative command foundation', () => {
  test('registers all 40 unique paths and all 183 logical flags from one source', () => {
    const specs: readonly CommandSpec[] = COMMAND_SPECS;
    const root = buildCli({ execute: async () => null });
    const paths = specs.map((spec) => spec.path);
    expect(paths).toHaveLength(40);
    expect(new Set(paths).size).toBe(40);
    expect(specs.reduce((total, spec) => total + spec.options.length, 0)).toBe(171);
    const described = describeCommands();
    expect(described.reduce((total, command) => total + command.flags.length, 0)).toBe(183);
    expect(described.filter((command) => command.json)).toHaveLength(13);
    expect(described.filter((command) => command.streams).map((command) => command.name)).toEqual([
      'ready',
      'up',
    ]);

    for (const spec of specs) {
      const command = registered(root, spec.path);
      const expectedPhysical = spec.options.reduce(
        (total, option) => total + (option.negatablePair ? 2 : 1),
        spec.json.mode === 'flag' ? 1 : 0,
      );
      expect(command.options).toHaveLength(expectedPhysical);
      expect(command.registeredArguments).toHaveLength(spec.arguments.length);
      spec.arguments.forEach((argument, index) => {
        const actual = command.registeredArguments[index];
        if (actual === undefined) throw new Error(`missing argument ${argument.name}`);
        expect(actual.name()).toBe(argument.name);
        expect(actual.required).toBe(argument.required);
        expect(actual.defaultValue).toBe(
          argument.defaultValue === null ? undefined : argument.defaultValue,
        );
      });
      for (const option of spec.options) {
        const [positive, negative] = option.long.split('/');
        const actual = optionByLong(command, positive as string);
        expect(actual.short).toBe(option.short);
        expect(actual.mandatory).toBe(option.required);
        expect(actual.hidden).toBe(option.hidden);
        expect(actual.required).toBe(option.value !== 'boolean');
        expect(actual.optional).toBe(false);
        expect(actual.defaultValue).toEqual(
          option.repeatable
            ? []
            : option.defaultValue === null || option.defaultValue === undefined
              ? undefined
              : option.defaultValue,
        );
        if (negative !== undefined) {
          const inverse = optionByLong(command, negative);
          expect(inverse.short).toBeUndefined();
          expect(inverse.negate).toBe(true);
        }
      }
      expect(command.options.some((option) => option.long === '--json')).toBe(
        spec.json.mode === 'flag',
      );
    }
  });

  test('every published option passes through actual Commander argv parsing', async () => {
    const specs: readonly CommandSpec[] = COMMAND_SPECS;
    for (const spec of specs) {
      for (const option of spec.options) {
        const spellings = option.negatablePair ? option.long.split('/') : [option.long];
        for (const spelling of spellings) {
          const argv = baseArgv(spec);
          argv.push(spelling as string);
          if (option.value !== 'boolean') {
            argv.push(valueFor(option));
            if (option.repeatable) argv.push(spelling as string, valueFor(option, 2));
          }
          const result = await invoke(argv);
          expect({ path: spec.path, option: spelling, err: result.err, exit: result.exit }).toEqual(
            {
              path: spec.path,
              option: spelling,
              err: '',
              exit: 0,
            },
          );
          expect(result.calls).toHaveLength(1);
          const parsed = result.calls[0]?.options[option.key];
          if (option.repeatable) expect(parsed).toEqual([valueFor(option), valueFor(option, 2)]);
          else if (spelling.startsWith('--no-') && option.negatablePair) expect(parsed).toBe(false);
          else if (option.value === 'boolean') expect(parsed).toBe(true);
          else if (option.value === 'integer' || option.value === 'float') {
            expect(parsed).toBe(Number(valueFor(option)));
          } else expect(parsed).toBe(valueFor(option));
        }
        if (option.short !== undefined) {
          const argv = baseArgv(spec);
          argv.push(option.short);
          if (option.value !== 'boolean') argv.push(valueFor(option));
          const result = await invoke(argv);
          expect(result.exit).toBe(0);
          expect(result.calls).toHaveLength(1);
        }
      }
    }
  });

  test('serve --no-domain is its own flag, and leaves --domain as it was given', async () => {
    const serve = ['domain', 'no_domain'];
    expect(pick(await parsed('serve', ['--no-domain']), serve)).toEqual({
      domain: '',
      no_domain: true,
    });
    expect(
      pick(await parsed('serve', ['--domain', 'gui.example.com', '--no-domain']), serve),
    ).toEqual({ domain: 'gui.example.com', no_domain: true });
    expect(
      pick(await parsed('serve', ['--no-domain', '--domain', 'gui.example.com']), serve),
    ).toEqual({ domain: 'gui.example.com', no_domain: true });
  });

  test("serve --domain '' is an empty domain, not --no-domain", async () => {
    const serve = ['domain', 'no_domain'];
    expect(pick(await parsed('serve', ['--domain', '']), serve)).toEqual({
      domain: '',
      no_domain: false,
    });
    expect(pick(await parsed('serve', ['--domain=']), serve)).toEqual({
      domain: '',
      no_domain: false,
    });
    expect(pick(await parsed('serve', ['--domain', 'gui.example.com']), serve)).toEqual({
      domain: 'gui.example.com',
      no_domain: false,
    });
  });

  test('upgrade --rollback and --no-rollback are two flags in either order, and a negatable pair is one', async () => {
    const upgrade = ['rollback', 'no_rollback'];
    expect(pick(await parsed('upgrade', ['--rollback', '--no-rollback']), upgrade)).toEqual({
      rollback: true,
      no_rollback: true,
    });
    expect(pick(await parsed('upgrade', ['--no-rollback', '--rollback']), upgrade)).toEqual({
      rollback: true,
      no_rollback: true,
    });
    expect(pick(await parsed('upgrade', ['--no-rollback']), upgrade)).toEqual({
      rollback: false,
      no_rollback: true,
    });
    expect(pick(await parsed('upgrade', []), upgrade)).toEqual({
      rollback: false,
      no_rollback: false,
    });
    // A negatable pair is ONE parameter: the last spelling wins, as it did in earlier releases.
    expect((await parsed('loadtest', ['--no-diag'])).diag).toBe(false);
    expect((await parsed('loadtest', ['--diag', '--no-diag'])).diag).toBe(false);
    expect((await parsed('loadtest', ['--no-diag', '--diag'])).diag).toBe(true);
    expect((await parsed('loadtest', [])).diag).toBe(true);
    expect((await parsed('pat', ['--no-bypass-2fa'])).bypass_2fa).toBe(false);
    expect((await parsed('pat', ['--no-bypass-2fa', '--bypass-2fa'])).bypass_2fa).toBe(true);
    expect((await parsed('pat', ['--bypass-2fa', '--no-bypass-2fa'])).bypass_2fa).toBe(false);
    expect((await parsed('pat', [])).bypass_2fa).toBe(true);
  });

  test('JSON acceptance exactly follows the declaration, including streaming writers', async () => {
    const specs: readonly CommandSpec[] = COMMAND_SPECS;
    for (const spec of specs) {
      const argv = [...baseArgv(spec), '--json'];
      const result = await invoke(argv);
      if (spec.json.mode === 'flag') {
        expect(result.exit).toBe(0);
        expect(result.calls).toHaveLength(1);
        expect(result.calls[0]?.options.json_out).toBe(true);
        expect(result.calls[0]?.events === null).toBe(!spec.json.streams);
        expect(result.out.trim().split('\n')).toHaveLength(1);
      } else {
        expect(result.exit).toBe(2);
        expect(result.calls).toHaveLength(0);
      }
    }
    for (const spec of specs.filter((candidate) => candidate.json.streams)) {
      const result = await invoke(baseArgv(spec));
      expect(result.calls[0]?.events).toBeNull();
    }
  });

  test('advertised schemas are the schemas actual argv parsing emits', async () => {
    const described = new Map(describeCommands().map((command) => [command.name, command]));
    expect(described.get('skill install')?.schema).toBe('houston.skill-install.v1');
    expect(described.get('skill status')?.schema).toBe('houston.skill-status.v1');
    const clusterByAction = {
      status: 'houston.cluster.v1',
      list: 'houston.cluster-list.v1',
      connect: 'houston.cluster-connect.v1',
      guide: 'houston.cluster-guide.v1',
      'iam-policy': 'houston.cluster-iam-policy.v1',
      create: 'houston.cluster-create.v1',
      prepare: 'houston.cluster-prepare.v1',
      delete: 'houston.cluster-delete.v1',
      forget: 'houston.cluster-forget.v1',
      keep: 'houston.cluster-keep.v1',
      share: 'houston.cluster-share.v1',
      overview: 'houston.cluster-overview.v1',
    } as const;
    const clusterSchemas = Object.values(clusterByAction).sort();
    expect(described.get('cluster')).toMatchObject({
      schema: 'houston.cluster.v1',
      schemas: clusterSchemas,
    });
    expect(COMMAND_SPECS.find((spec) => spec.path === 'cluster')?.json.variants).toEqual({
      argument: 'action',
      byValue: clusterByAction,
    });

    for (const [path, schema] of [
      ['skill install', 'houston.skill-install.v1'],
      ['skill status', 'houston.skill-status.v1'],
    ] as const) {
      const result = await invoke([...path.split(' '), '--json']);
      expect(JSON.parse(result.out)).toMatchObject({ schema, ok: true });
    }
    for (const [action, schema] of Object.entries(clusterByAction)) {
      const result = await invoke(['cluster', action, '--json']);
      expect(JSON.parse(result.out)).toMatchObject({ schema, ok: true });
    }
  });

  test('required values, nested skill paths, positional actions and eager version are real parser rules', async () => {
    const specs: readonly CommandSpec[] = COMMAND_SPECS;
    for (const spec of specs) {
      for (const option of spec.options.filter((candidate) => candidate.required)) {
        const result = await invoke(baseArgv(spec, option));
        expect(result.exit).toBe(2);
        expect(result.calls).toHaveLength(0);
      }
      for (const option of spec.options.filter((candidate) => candidate.value !== 'boolean')) {
        const result = await invoke([...baseArgv(spec), option.long.split('/')[0] as string]);
        expect(result.exit).toBe(2);
        expect(result.calls).toHaveLength(0);
      }
      if (spec.arguments.some((argument) => argument.required)) {
        const requiredOptions = baseArgv(spec).slice(
          spec.path.split(' ').length + spec.arguments.length,
        );
        const result = await invoke([...spec.path.split(' '), ...requiredOptions]);
        expect(result.exit).toBe(2);
        expect(result.calls).toHaveLength(0);
      }
    }
    expect((await invoke(['skill', 'install'])).calls[0]?.spec.path).toBe('skill install');
    expect((await invoke(['skill', 'status'])).calls[0]?.spec.path).toBe('skill status');
    for (const path of ['users', 'edge', 'config', 'cluster']) {
      const action = path === 'edge' || path === 'cluster' ? 'status' : 'list';
      const positional = await invoke([path, action]);
      expect(positional.calls[0]?.spec.path).toBe(path);
      expect(positional.calls[0]?.arguments.action).toBe(action);
    }
    const version = await invoke(['--version']);
    expect(version.exit).toBe(0);
    expect(version.calls).toHaveLength(0);
    expect(version.out).toBe(`houston ${PACKAGE_VERSION}\n`);
    const excess = await invoke(['presets', 'unexpected']);
    expect(excess.exit).toBe(2);
    expect(excess.calls).toHaveLength(0);
  });

  test('a successful nonzero outcome emits its JSON envelope before returning the exit', async () => {
    let out = '';
    const write = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
    try {
      const exit = await runCli(['doctor', '--json'], {
        execute: async () => commandOutcome({ checks: [] }, 3),
      });
      expect(exit).toBe(3);
      const lines = out.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] as string)).toMatchObject({ ok: true, data: { checks: [] } });
    } finally {
      write.mockRestore();
    }
  });
});

describe('the cluster options', () => {
  test('--nodes defaults to 3 and says so once', () => {
    // The option carried defaultValue 0 with "Default 3" in its description, so help printed
    // `Default 3 … [default: 0]` on one flag. The handler substitutes DEFAULT_NODES for 0,
    // which is how both were true at once.
    const option = COMMAND_SPECS.find((spec) => spec.path === 'cluster')?.options.find(
      (candidate) => candidate.key === 'nodes',
    );
    expect(option?.defaultValue).toBe(3);
    expect(option?.description).not.toContain('Default 3');
  });
});

describe('the cluster zone option', () => {
  test('--zone exists for create and prepare', () => {
    // Typed once on the cluster instead of again as --domain on every ticket.
    const option = COMMAND_SPECS.find((spec) => spec.path === 'cluster')?.options.find(
      (candidate) => candidate.key === 'zone',
    );
    expect(option?.long).toBe('--zone');
    expect(option?.description).toContain('create');
    expect(option?.description).toContain('prepare');
  });
});
