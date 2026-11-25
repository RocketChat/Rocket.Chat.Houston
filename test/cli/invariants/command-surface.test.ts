/**
 * INVARIANT: the declarative table IS the command surface.
 *
 * MECHANISM: RUNTIME REGISTRY.
 *
 * Earlier releases asked their command framework what it had registered and, for the
 * stray-registration case, searched the package for registrations that were not in the
 * registration order. Both are the same worry: a command can exist without the table
 * knowing, because a registration takes effect on import. Here the walk is of the built
 * Commander program -- the object `houston <anything>` is actually parsed by -- so a
 * command registered anywhere, by anything, is in it.
 *
 * The capabilities half is the one with a bug behind it: a document that can advertise a
 * command which does not answer in JSON has moved the caller's guess one level up and
 * made it authoritative. The version borrowed from elsewhere advertised
 * `houston.loadtest.v1` and `houston.capacity.v1` for two commands that printed a bare
 * payload. Derived from the registry on BOTH sides here, as it was there.
 */
import { buildCli } from '../../../src/cli/app';
import { capabilities, describeCommands } from '../../../src/cli/capabilities';
import { COMMAND_SPECS } from '../../../src/cli/spec-data';

import type { Command } from 'commander';

/** Every command path the built program will actually dispatch, nested paths included. */
function registeredPaths(program: Command): string[] {
  const found: string[] = [];
  const walk = (node: Command, prefix: string): void => {
    for (const child of node.commands) {
      const path = `${prefix}${child.name()}`;
      if (child.commands.length > 0) walk(child, `${path} `);
      else found.push(path);
    }
  };
  walk(program, '');
  return found.sort();
}

function program(): Command {
  return buildCli({
    execute: async () => undefined,
    io: { writeOut: () => undefined, writeErr: () => undefined },
  });
}

describe('the command table against the built parser', () => {
  it('registers exactly the forty commands the table declares', () => {
    const declared = COMMAND_SPECS.map((spec) => spec.path).sort();
    expect(declared).toHaveLength(40);
    expect(new Set(declared).size).toBe(declared.length);
    // THE BUILT PROGRAM, not a second list. A stray registration -- a command registered
    // in a module nobody listed -- appears here and nowhere else.
    expect(registeredPaths(program())).toEqual(declared);
    // The two nested paths stay distinct routing keys rather than collapsing into
    // their group, which is what `skill` alone would do.
    expect(declared).toContain('skill install');
    expect(declared).toContain('skill status');
    // And no command is named after something private. The trap in earlier releases was a
    // helper inserted between a command's registration and its function, so the
    // registration bound the helper and the real command was orphaned -- silently.
    for (const path of declared) {
      expect(path.startsWith('_')).toBe(false);
      expect(path).toMatch(/^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)?$/u);
    }
  });

  it('advertises exactly the commands that really speak JSON', () => {
    const advertised = new Set(
      (capabilities().commands as { name: string; json: boolean }[])
        .filter((command) => command.json)
        .map((command) => command.name),
    );
    // DERIVED FROM THE REGISTRY on the other side too: a command speaks JSON when its
    // declaration says so, either through a `--json` flag or because it has no other mode.
    const real = new Set(
      COMMAND_SPECS.filter((spec) => spec.json.mode !== 'none').map((spec) => spec.path),
    );
    expect([...advertised].sort()).toEqual([...real].sort());
    expect(advertised.size).toBe(13);
    // `capabilities` answers in an envelope and always has -- it has no `--json` because
    // it has no other mode -- so deriving purely from the flag made the one document
    // whose purpose is saying which commands speak JSON report that this one does not.
    expect(advertised.has('capabilities')).toBe(true);
    const always = COMMAND_SPECS.find((spec) => spec.path === 'capabilities');
    expect(always?.json.mode).toBe('always');
  });

  it('publishes a flag list that comes from the same declaration the parser reads', () => {
    const described = describeCommands();
    expect(described).toHaveLength(40);
    const flags = described.reduce((total, command) => total + command.flags.length, 0);
    // The number the frozen `capabilities` baseline carries. A flag that exists in the
    // parser and not in the document is a caller hardcoding a list it was told not to.
    expect(flags).toBe(183);
    for (const command of described) {
      expect([...command.flags].sort()).toEqual(command.flags);
      expect(new Set(command.flags).size).toBe(command.flags.length);
    }
  });

  it('streams exactly the two commands that have progress to stream', () => {
    const streaming = (capabilities().commands as { name: string; streams?: boolean }[])
      .filter((command) => command.streams === true)
      .map((command) => command.name)
      .sort();
    expect(streaming).toEqual(['ready', 'up']);
  });
});
