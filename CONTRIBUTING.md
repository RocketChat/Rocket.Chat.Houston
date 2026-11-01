# Contributing to houston

For working on houston itself. For using it, see the [README](README.md). For why it
is built the way it is, read [`data/docs/ARCHITECTURE.md`](data/docs/ARCHITECTURE.md)
before your first change.

**Contents:** [Set up](#set-up) · [Run the tests](#run-the-tests) ·
[Where things go](#where-things-go) · [Before you commit](#before-you-commit) ·
[Adding a command](#adding-a-command) · [Adding a preset](#adding-a-preset) ·
[Trying a change for real](#trying-a-change-for-real) · [The gates](#the-gates) ·
[Releasing](#releasing)

---

## Set up

**First, sandbox houston.** Every houston run, even `--help` and `--version`, writes to
`$HOUSTON_HOME/logs/houston.log`, and without `HOUSTON_HOME` that is your real
`~/.houston`. Do this in every shell you work in:

```bash
export HOUSTON_HOME=$(mktemp -d) HOUSTON_SKILL_HOME=$(mktemp -d)
```

Then:

```bash
git clone https://github.com/klovekesh37/houston.git && cd houston
npm install -g corepack         # Node 26 no longer ships it; on Node 24 this is harmless
corepack enable                 # yarn 4, at the exact version package.json pins
yarn install --immutable        # fails rather than resolving versions the lockfile does not name
bin/houston --version
```

You need Node.js 24.10 or newer (`.nvmrc` and `.tool-versions` pin the line the
maintainers use). Docker is only needed to try a change for real; the test suite never
talks to an engine.

**There is no build step.** On a checkout, `bin/houston` runs the TypeScript source
through `tools/cli.js`; an installed package runs `dist/cli/entry.js`, which `yarn build`
emits with `tsc`. So a `git pull` is the whole update, and a leftover `dist/` is never
used. To type `houston` instead of `bin/houston`, link it onto your `PATH`:

```bash
ln -s "$PWD/bin/houston" ~/.local/bin/houston
```

`.yarnrc.yml` disables install scripts, so no dependency may need a postinstall step.

---

## Run the tests

```bash
yarn test --ci                                    # the whole suite, about 2-5 minutes, no Docker
npx jest --ci test/core/backup.test.ts            # one spec
npx jest --ci -t "refuses a newer bundle"         # tests whose name matches
```

The browser suite drives the real GUI in Chromium:

```bash
npx playwright install chromium                   # once
yarn test:browser                                 # exactly 112 tests must pass
```

Inside Jest the sandbox is automatic: `test/testsetup.ts` gives every spec file a fresh
`HOUSTON_HOME`, `test/testsetup-engine.ts` makes the engine answer healthy,
`test/testsetup-cloud.ts` makes `eksctl`, `aws`, `kubectl` and the other cloud tools
absent unless a test stubs them, and `test/testsetup-network.ts` fails any test that
reaches past loopback.

The zero-skips reporter (`tools/jest-zero-skips.js`) fails a run with a skipped, todo or
`.only` test. On a full run it also requires at least `FLOOR` tests; a filtered run,
such as one spec, does not check the floor.

---

## Where things go

- **`src/` is production code only**, laid out by layer: `lib` → `seams` → `core` →
  `cli`, `web`, `perf`, `seed`. A module imports only from a lower layer.
  `tools/dependency-policy.js` holds the ranks, and ARCHITECTURE explains them.
- **`test/` mirrors `src/` path for path:** `test/core/backup.test.ts` tests
  `src/core/backup.ts`. Rules about a whole layer live in that layer's `invariants/`
  directory. Where the contract is what 1.x printed or wrote, the 1.x answer is pinned
  under `test/fixtures/`, with the messages 2.0.0 reworded in their new words.
- **`data/`** is everything shipped that is not code: `versions.yaml`, static presets,
  dashboards, k6 scripts, the GUI (`data/webui`), the agent skill, the IAM documents
  and the guides in `data/docs/`.
- **`tools/`** is repository tooling that never ships.

---

## Before you commit

Go through this list for every change:

1. **A new module under `src/`** gets a rank in `tools/dependency-policy.js` (an
   unranked module fails `yarn depcruise`), and its name in the module index in
   `data/docs/ARCHITECTURE.md` (`test/lib/invariants/architecture-map.test.ts` fails
   otherwise).
2. **A changed command, flag, preset or exit code** means running `yarn skill:generate`,
   which rewrites `data/skill/SKILL.md` from `tools/skill/SKILL.template.md` (and
   refreshes the two ignored copies your checkout keeps under `.claude/skills/` and
   `.agents/skills/`). Edit the template, never the generated files.
3. **Help text and usage errors are pinned** under `test/fixtures/cli/`. Move a pin only
   on purpose, in the commit that changes the behaviour.
4. **Documents name only real commands and flags.**
   `test/cli/invariants/printed-commands.test.ts` checks every `houston …` in the README,
   CONTRIBUTING, the guides and the skill template.
5. **Added tests move the floor.** Set `FLOOR` in `tools/jest-zero-skips.js` to the
   measured total, and say why in the commit.
6. **A regression test must fail without the fix.** Reverse the fix, run the test,
   confirm it fails for the reason you state, then restore the fix byte for byte.
7. **A change under `data/webui/`** means re-recording the digest in `tools/gui-hash.js`,
   deliberately.
8. **Nothing may break a 1.x install.** houston 1.x must keep working on a home 2.x has
   touched: leave the `IMPLEMENTATION` marker handling, the locks and every state file
   format alone unless that is the change.

---

## Adding a command

**The command surface is a contract.** Every command, flag, default, help text, exit
code and `--json` schema is what 1.x users and their scripts rely on.
`test/cli/invariants/command-surface.test.ts` counts the 40 declared commands. A new
command or flag is a contract change: ask first, and expect those pins to move on
purpose.

When one is agreed:

1. **Declare it** in `COMMAND_SPECS` in `src/cli/spec-data.ts` with `defineCommand`
   (`src/cli/spec-types.ts` has the shape): path, arguments, options and the `json`
   block. Help, the commander program, usage errors and `capabilities` all come from
   this table.
2. **Do the work in `src/core/`**, in a function that takes `emit: Emit` for progress and
   raises a `ReproError` subclass for failures. The GUI calls the same function.
3. **Handle it** with a `case` in `dispatch` in `src/cli/handlers.ts`, and one in
   `renderHuman` for the human output. A large command gets its own file in
   `src/cli/handlers/`.
4. **Give it a GUI route if it needs one**, under `src/web/routes/`, and an entry in
   `ROUTE_ROLES` in `src/web/route-table.ts`. That table is **default deny**: a route missing
   from it answers 403 to everyone, admins included, and
   `test/web/invariants/route-registry.test.ts` proves none is missing. Reads are readonly and up, writes member and up, managing people admin, and
   a read that hands over credentials (logs, env, a minted PAT, a raw REST call) member
   and up.
5. **Rank the new modules, write the tests, run `yarn skill:generate`.**

---

## Adding a preset

Read `src/lib/presets/index.ts` (the loader), `registry.ts`, `types.ts` (the `Preset`
shape) and one builder first: `email.ts` is the smallest, `ldap.ts` has an adapter per
runtime.

**A static preset** (environment and extra services only) is a YAML file,
`data/presets/<name>.yaml`:

```yaml
name: my-scenario
description: What this reproduces.
env:                       # merged into the rocketchat service
  OVERWRITE_SETTING_Some_Setting: "true"
services:                  # optional extra compose services
  my-sidecar: { image: some/image:tag }
depends_on: [my-sidecar]
```

**A dynamic preset** (generated files, `--set` parameters, or steps after boot) needs
three edits:

1. A module, `src/lib/presets/<name>.ts`, exporting `build(params): Preset`. Start from
   `emptyPreset('<name>')` and end with `register('<name>', build)`.
2. Its name in `DYNAMIC_PRESETS` in `registry.ts`. `builders()` refuses to answer while a
   listed name has not registered, so a forgotten import fails loudly.
3. Its import in `index.ts`, beside the others, and its rank in
   `tools/dependency-policy.js`.

Read `--set` values with `truthyParam`, `intParam` and `strParam` from `common.ts`, so a
bad value is a clear refusal. Reuse `keycloak.ts` for a Keycloak identity provider. A
preset whose Kubernetes shape differs from its Compose shape is a `Scenario`
(`scenario.ts`), registered with `registerScenario`; `ldap.ts` is the example.

`types.ts` documents every `Preset` field. Two of them are traps:

- **`postReady`**: actions run once Rocket.Chat serves. Each `action` must match a key
  in `POST_READY_ACTIONS` in `src/core/postready.ts`, and **one with no handler is
  skipped silently.** Add the handler and a test that runs it in the same change.
- **`ports`**: host ports the side services publish. Add their preferred numbers to
  `PRESET_PORTS` in `src/lib/config.ts`. A builder is `build(params, ports)`: read each port
  with `presetPort('<name>', index, ports)`, build every address and mapping from that value,
  and set `ports: [...]` to the same numbers on every adapter, Kubernetes included. A second
  workspace with the preset is given other ports, so a number read from the registry instead
  sends its browser to someone else's service (`test/core/invariants/source-rules.test.ts`
  holds the source to this). Never hard-code a bind host; everything binds `127.0.0.1`.

---

## Trying a change for real

A green suite has repeatedly not been enough here: several defects only showed on a
running workspace. After a user-visible change, try it, sandboxed, and clean up:

```bash
export HOUSTON_HOME=$(mktemp -d) HOUSTON_SKILL_HOME=$(mktemp -d)
bin/houston up --version 8.5.1 --name try-it --wait
bin/houston info --name try-it
bin/houston down --name try-it --volumes --yes          # always tear it down
```

For the GUI, run `bin/houston serve --port 7171` (any free port that is not in use by
someone else's `serve`), and stop it by its PID when you are done. Check both the light
and the dark theme. Never stop a `serve` you did not start.

---

## The gates

| Command | Proves | CI |
|---|---|---|
| `yarn lint` | eslint, including the seam fences and the strict boolean rule | yes |
| `yarn typecheck` | `tsc --noEmit` over the whole tree | yes |
| `yarn test --ci` | the Jest suite, zero skips, at least `FLOOR` tests | yes |
| `yarn depcruise` | every module is ranked, and no import goes sideways or up | yes |
| `yarn depcruise:selftest` | the layer gate still sees: it plants a cycle and a seam bypass and requires both reported | yes |
| `yarn format` | Prettier, check only | |
| `yarn test:zero-skips:selftest` | the zero-skips reporter still catches each defect it claims to | |
| `yarn test:browser` | the GUI in Chromium, in-process: exactly 112 pass, none skip | |
| `yarn verify:gui-hash` | `data/webui` is byte for byte the pinned GUI | |
| `yarn test:process-contracts` | the process and Docker seams' contracts, run in band | |
| `yarn test:timing` | sign-in takes as long for an unknown name as for a real one | |
| `yarn lint:truthiness` | the lint rule that protects the three-state `Answer` is live | |
| `yarn skill:check` | the skill file matches the build (also covered inside `yarn test --ci`) | |

CI (`.github/workflows/ci.yml`) runs the first five on Node 24 and 26. **Before a merge,
run all of them.**

---

## Releasing

A release is published from `main`, from a clean tree, by a maintainer, so the package
on the registry is exactly a commit on `main`.

1. **Move the version** in `package.json`, then run `yarn skill:generate`, because the
   skill carries the version.
2. **Run every gate** in the table above.
3. **Look at the package:** `npm publish --dry-run` lists every file the tarball holds.
   `prepack` deletes `dist/` and rebuilds it from this commit first, so a stale build
   cannot ship.
4. **Publish:** `npm login` once, then `npm publish`.
5. **Tag it:** `git tag -a vX.Y.Z` on the published commit, then push `main` and the tag.

A version can be published only once. A fix after that ships as the next patch version.

---

Maintained by the Rocket.Chat support team. Issues and requests:
<https://github.com/klovekesh37/houston/issues>
