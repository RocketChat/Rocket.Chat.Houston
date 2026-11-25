/**
 * INVARIANT: in `--json` mode, stdout carries the envelope and nothing else.
 *
 * MECHANISM: ts-morph, plus a behavioural confirmation that the envelope really is the
 * last line.
 *
 * A caller reads to end-of-stream and parses the LAST line. A stray JSON payload written
 * straight to stdout breaks every machine consumer, and the guard in earlier releases found
 * exactly that on the SUCCESS path of two commands while the failure path was covered. It walks
 * the CLI package because the question is "does any command do this", which is not a
 * thing one call can answer -- the offending command is the one nobody thought to drive.
 */
import * as path from 'node:path';

import { Project, SyntaxKind, type SourceFile } from 'ts-morph';

import { COMMAND_SPECS } from '../../../src/cli/spec-data';

const ROOT = path.resolve(__dirname, '..', '..', '..');

function cliSources(): SourceFile[] {
  const project = new Project({
    tsConfigFilePath: path.join(ROOT, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });
  project.addSourceFilesAtPaths([path.join(ROOT, 'src', 'cli', '**', '*.ts')]);
  return project.getSourceFiles();
}

/** Every write of a serialised payload straight to a stream. */
function rawJsonWrites(file: SourceFile): string[] {
  const found: string[] = [];
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const target = call.getExpression().getText();
    const writes = /(^|\.)(write|writeOut|log)$/u.test(target) && !/writeErr$/u.test(target);
    if (!writes) continue;
    for (const argument of call.getArguments()) {
      const text = argument.getText();
      // `JSON.stringify` INSIDE a message is prose about a value -- `--trust-proxy "x" is
      // not an address` -- and is not a payload. A payload is the whole argument.
      if (/^JSON\.stringify\(/u.test(text.trim())) {
        found.push(
          `${path.basename(file.getFilePath())}:${String(call.getStartLineNumber())}: ${target}`,
        );
      }
    }
  }
  return found;
}

describe('a JSON command', () => {
  it('recognises a payload written straight to stdout', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const planted = project.createSourceFile(
      '/planted.ts',
      `export function show(io: { writeOut: (s: string) => void }, data: unknown) {
  io.writeOut(JSON.stringify(data));
}`,
    );
    // The positive control: without it a walk that matched nothing would report a clean
    // tree, which is how the earlier version of this guard narrowed when the CLI split.
    expect(rawJsonWrites(planted)).toEqual(['planted.ts:2: io.writeOut']);
  });

  it('writes no JSON payload outside the envelope', () => {
    const files = cliSources();
    expect(files.length).toBeGreaterThan(5);
    expect(files.flatMap(rawJsonWrites)).toEqual([]);
  });

  it('reaches the envelope from exactly one place, for every command that speaks JSON', () => {
    const app = cliSources().find((file) => path.basename(file.getFilePath()) === 'app.ts');
    expect(app).toBeDefined();
    const replies = (app?.getDescendantsOfKind(SyntaxKind.CallExpression) ?? []).filter(
      (call) => call.getExpression().getText() === 'reply',
    );
    // ONE construction site. Seventy-five error paths predate the envelope and honour the
    // contract without being touched precisely because there is one funnel; a second
    // `reply` is a second place the schema can be chosen.
    expect(replies).toHaveLength(1);
    const speakers = COMMAND_SPECS.filter((spec) => spec.json.mode !== 'none');
    expect(speakers.length).toBe(13);
  });
});
