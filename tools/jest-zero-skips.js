'use strict';
/**
 * A skipped test cannot be called green.
 *
 * A suite that skips reports green while testing nothing: that is how a broken same-origin
 * form POST once shipped past 570 passing HTTP tests. Jest has that hole under several
 * spellings: `it.skip`,
 * `describe.skip`, `xit`, `.todo`, a stray `.only`, and a conditional guard that picks one of
 * those at runtime.
 *
 * `tools/browser-results.js` already does this job for the browser suite and set the
 * convention followed here: a gate nobody has watched fail is a gate that does not work, so
 * `yarn test:zero-skips:selftest` plants each defect and requires the run to fail naming it.
 *
 * ## Two checks, because one of them cannot be made at runtime
 *
 * **The run.** Zero pending, zero todo, and at least `FLOOR` tests over the whole suite.
 * That catches what actually skipped on this machine.
 *
 * **The source.** `test/seams/exec.test.ts` selects
 * `(process.platform === 'win32' ? describe.skip : describe)`. On Linux nothing skips, the
 * run reports zero, and a runtime-only gate passes -- while the same suite on another machine
 * drops a whole `describe` in silence. A guard that does not fire HERE is still a guard, so
 * every authored skip construct must be named in `PERMITTED` with a written reason: the
 * reviewer decides that a guard is allowed, not the platform the gate happened to run on. A
 * permission that no longer matches anything fails too, so the list cannot drift into
 * describing nothing.
 *
 * ## When it enforces, and why it stands down when it does
 *
 * Only with `--ci` (`globalConfig.ci`, which `CI=1` in the environment also sets): `yarn test
 * --ci` is the gate and CI runs it; an ordinary `yarn test` stays a development loop.
 *
 * The RUNTIME skip check stands down on a NAME-FILTERED run (`-t`), and that is not a
 * convenience. Jest reports a test a `-t` pattern did not select with status `pending` --
 * exactly what `it.skip` produces -- so on such a run the two cannot be told apart, and any
 * verdict would be a guess. A proof that plants one break and runs only the test meant to
 * catch it runs that way, with `CI: '1'` and a `-t`; a reporter that counted the unselected
 * tests as skips would fail every such run. The
 * SOURCE check does not stand down there.
 *
 * The FLOOR stands down on any filtered run -- a run of one file is not the suite and has no
 * business asserting the suite's size. A path filter does NOT silence the runtime check: a
 * pending test inside a selected file is a real skip.
 *
 * NOT DETECTABLE, and named so the gap is recorded rather than implied: a test that returns
 * early from its own body, or wraps its assertions in an `if`. Neither is a skip to Jest, and
 * no reporter can tell either from a test that finished.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * The floor: the measured size of the whole suite.
 *
 * A count cannot say whether a single behaviour is covered. This number is for the one thing
 * a count is good at: noticing that a run collected far less than it used to, which is what a
 * broken `testMatch`, a crashed worker or a `.only` looks like from the outside. It is set to
 * the measured count in the commit that adds tests, and lowered only in a commit that removes
 * tests and says why; git holds its history.
 */
// Rich seed profiles, recovery, historical metadata, and actual Kubernetes runtime seams.
// Twenty-seven re-verification regressions also cover shutdown, bind links, Kubernetes
// polling, SAML registration, shared namespace deletion and ordered progress.
// Thirty-eight post-integration cases cover shared-edge transactions, scoped origin
// readiness, SAML reload/idempotence, limiter-safe seeding and public preset guidance.
// Thirty-nine release-completion cases cover bounded SAML registration, awaited failure-safe
// backend shutdown, rate-limited star readback, truthful unreadable-seed reasons, and the
// process shutdown bound after the HTTP server closes with a live log-follow handle, and
// configuration-before-enable plus bounded OIDC registration across replica roots, and
// checked owned-edge ingress recovery with preservation guards for other runtimes/homes.
// Sixty-eight blocker regression and boundary cases cover namespace identity, verified quiescence,
// terminal job access/audit and complete atomic port publication.
// The e2ee preset (its settings, test users and the enforced-version refusal), the owner kept
// through a rebuild, the dashed email code, the Kubernetes typo wording and the origin's port.
// Seeding under E2EE room defaults and against 8.8.0's request validation: the encryption
// defaults held off and journalled, their repair, the marker in customFields, one invite per user.
// A supervised port-forward that restarts its kubectl, stops with it and gives up on a dead
// target; and the license line on an unlicensed microservices workspace.
// `serve` names an earlier serve from this home when its port is in use.
// Okta sign-in: settings and secret, every ID token and provider check, each way a person
// resolves to an account, the /signin start and callback, the CLI link verbs, and the seam's cap;
// and the review's: control characters in `next`, a stale link on a re-created account, the
// canonical redirect made once, and no audit line for an unstarted callback.
// The final re-verification's fixes: up resolving a name the actor may act on, a rebuild's
// monitoring, pin and port, the operator password off every argv, the operator's memory and
// PodMonitor, serve's shutdown, and the usage and wording answers it found untrue.
// A start over a systemd unit the last run left loaded: start, restart, up, a backup's restart
// of Rocket.Chat, an env apply's Rocket.Chat alone and the GUI's streamed up recreate, any other
// failure does not, and the edge.
// A member changes only their own workspaces: every member route naming one, the live logs,
// a bundle's delete and restore, a create over a handed-over prefix, a create's pin and the CLI
// default, and their login, env and password kept from others.
// A create on a name the other runtime holds: Docker over Kubernetes and Kubernetes over Docker.
// Acting on what a workspace is NOW: Docker leftovers under a Kubernetes record go first; down,
// restore, rollback, hand-over and prune ask again under the lock; a create locks and asks about
// the name multi-instance settles on; restore by a bundle's own name refuses a newer namesake;
// a Kubernetes re-up keeps its version and MongoDB, even after a re-up that failed; a rebuild
// that keeps the data keeps when the workspace was made; prune leaves a mixed record alone. A
// Kubernetes upgrade keeps the forward its backup re-established; production's stale-unit text.
// Two houston homes apart: the home's own id, its mark on a namespace (adopt, delete, prune), a
// MongoDB another home left on Docker; a typed name that could be two workspaces, resolved and
// created; cluster prepare and forget an admin's; Check TLS asking where tls-status asks; a
// rebuild keeping its image; Bring it up after a Delete; the start repair under the lock; a
// Kubernetes row's uptime; restore's engine from the bundle; scale and env refused up front;
// the TLS probe keeping IPv4's placeholder when [::1] refuses. Start, stop, ready, backup, restore,
// upgrade and rollback acting only on this home's own namespace; a damaged home id refused, not
// replaced; a --domain another workspace here records refused though no route file holds it.
// The data-deletion review: a rebuild keeping a one-preset workspace's data; restore, upgrade
// and rollback refusing an ambiguous name; restore refusing an older namesake; prune asking
// Docker afresh and never sweeping an unreadable record's namespace, only the orphans it
// showed, by UID; a bundle gated on its own owner; a refused monitoring mark; a re-up under
// the operator; a legacy namespace marked; backups re-checked under the lock; teardowns that
// cannot finish saying so; restores audited.
// The voice preset: its settings and SIP services, the 8.0 refusal on both runtimes, the test
// users and their extensions and sign-in, the licence warning, and what sip=on adds to the memory
// charge.
// Its SIP stack as Rocket.Chat's compose files define it: voip_domain, rtp_ports, ice_servers
// and their refusals, and a UDP range bound to the bind address; a TURN password in Rocket.Chat's
// Ice Servers form is masked wherever env or argv is printed, after a comma and a space too, and
// in a refused entry; the create dialog's sentence names the licence.
// Its PBX lab: the official external FreeSWITCH settings, the editable dialplans mounted per
// file, the Asterisk and its kept files, ports, refusals and notes; kept files written only when
// absent, over the empty folder Docker leaves at a deleted one; the PBX memory charge; info naming the
// edited lab files.
// The PBX follows FreeSWITCH to a new address after a restart; the lab composes with every
// other built-in preset.
// restore --new brings back the edited lab files, and leaves none behind when its create fails;
// a combined preset's Docker-only setting is refused on Kubernetes as early as one alone.
// doctor names an agent skill another build installed; the skill names the package to
// install; the skill eval scores only what an agent says it would run; a home copy is never
// also a project copy, and a same-version copy is not called another build; the shipped skill
// names a support ticket among its uses and teaches no load testing yet.
// The skill eval refuses a run that would score nothing, rather than report a pass.
// The voice options' one vocabulary: the 2.1.3 names sip and fs_dialplan read as aliases by the
// preset, by a combination's routing and by the unknown-key check, both spellings at once
// refused, and the memory charge the same for either spelling.
// The scenario card's guides: one per guided preset with its parameters, the composite order and
// the combined note, the public-URL stripping, the scenario group's all-or-nothing rule, and the
// blank lines a conditional part leaves dropped.
// The voice preset links its guide online.
// The 2026-10-21 live audit's fixes: serve's local-proxy text, a rebuild keeping --root-url,
// K8s --https refused without Docker, tls-status asking the name, ready on a stopped K8s
// workspace, late monitoring shipping earlier logs, the operator's webhook, the keep-data
// down line, an EKS node bound at core and route and a missing kubectl named, the side-port
// refusal's cost, the down hint's version, the advertised URL in info, a combination's notes
// at the width info prints them, and a proxied workspace's restore keeping its Site_Url.
// phpLDAPadmin 2.3.12 in place of osixia's 1.2.5, on both runtimes, and never the old image;
// the cn=admin entry osixia never created, seeded so phpLDAPadmin 2 can sign it in; and the
// directory a pinned, maintained OpenLDAP 2.6 in place of osixia/openldap:1.5.0. A changed
// acme.challenge reaching a running edge from `up --domain`, with the staging its request asks
// for.
// Side ports allocated per workspace: every preset built on shifted ports, over HTTPS too; the
// allocator, preferred first and never another's preferred or voice's; concurrent creates and
// attaches getting disjoint ports; a rebuild keeping them; Kubernetes labels and Grafana
// forwards; the record's accessors; links, notes and the GUI's frame policy on a workspace's own
// ports; and the source holding every builder and address to the ports it was handed.
// Plus 3 from the live matrix: `up` on an existing workspace naming an ignored --port and
// every other flag it does not apply, and `env`'s footer naming an unset key as removed rather
// than among the overrides. Plus 6 from the independent review: a reuse's warning keeping
// secrets out and naming only what was typed, a port its own container still holds kept, a
// lost moved port back to its preferred number, a recorded port that is not the slot's not
// kept, a typed --replicas winning on a rebuild, and no GUI reload for a known Grafana. Plus 1
// from verifying the gaps live: a Kubernetes re-up with another LDAP seed rolls the directory.
// Plus 4 from the last review: Docker's grouped port ranges read, a typed --set instances
// beating the carried count, AD and generated directories left unstamped, and the typed --set
// copy proven to reach the reuse through a whole create.
// Plus 31 from the webhooks preset: the builder's shape on both runtimes, moved ports and
// its words; integrations listed (by what a page held), found, made and repointed through
// rcapi, with the hook looked up before it is created; the post-ready action's wiring,
// capture=all, its refusals, a URL it could not read left alone and the event switches
// from its own list; the inbox link, the Webhooks note group and the hook token and a
// customer's endpoints hidden from a view-only member; the preset's guide and the pinned port.
// Plus 7 for the inbox's session: made through the receiver's API with a JSON answer (the
// auto-created one answers an empty body, a failed call Rocket.Chat retries), kept while it
// answers, adopted from the sample integration when a rebuilt record forgot it, replaced and
// repointed when lost, nothing wired while the API cannot be reached, the first build's
// action still accepted, and the --bind warning naming the inbox UI.
const FLOOR = 4850;

/** Every authored construct that removes a test from a run or inverts what it asserts. */
const SKIP_CONSTRUCTS = [
  'describe.skip',
  'describe.only',
  'xdescribe',
  'fdescribe',
  'it.skip',
  'it.only',
  'it.todo',
  'it.failing',
  'xit',
  'fit',
  'test.skip',
  'test.only',
  'test.todo',
  'test.failing',
  'xtest',
];

/** The constructs a reviewer has looked at and allowed, each with its reason. */
const PERMITTED = [
  {
    file: 'test/seams/exec.test.ts',
    construct: 'describe.skip',
    reason:
      'A platform guard, not a disabled test. `processGroup: true` asks for a POSIX session ' +
      'and `process.kill(-pid, ...)` addresses a process group; Windows has neither, so the ' +
      'block is selected away there. Houston is not supported on Windows, and the block runs ' +
      'on Linux, on macOS and in CI.',
  },
];

function specFiles(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) specFiles(absolute, found);
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) found.push(absolute);
  }
  return found;
}

/**
 * The text with comments removed, so prose about `it.skip` is not read as a use of it.
 *
 * Deliberately crude and fail-LOUD: it strips line and block comments and nothing else. A
 * string literal holding one of these constructs is reported, and the answer to that is a
 * `PERMITTED` row with a reason -- not a cleverer parser whose blind spots nobody has listed.
 */
function withoutComments(text) {
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//gu, (block) => block.replaceAll(/[^\n]/gu, ' '))
    .replaceAll(/(^|[^:])\/\/[^\n]*/gu, '$1');
}

/** Every authored skip construct under `test/`, with where it is. */
function authoredSkips(roots = [path.join(ROOT, 'test')]) {
  const found = [];
  const patterns = SKIP_CONSTRUCTS.map((construct) => [
    construct,
    construct.includes('.')
      ? // A MEMBER construct (`it.skip`) counts wherever it appears -- called, or merely
        // selected, which is what `(cond ? describe.skip : describe)` does. Not preceded by an
        // identifier character or a dot, so `describe.skip` does not match inside
        // `xdescribe.skip`.
        new RegExp(`(^|[^\\w.$])${construct.replaceAll('.', '\\.')}\\b`, 'u')
      : // A BARE identifier (`fit`, `xit`) counts only when it is CALLED, or `.each`ed.
        // MEASURED: the browser spec holds a local `const fit = await page.evaluate(...)`,
        // and matching the name alone reported it eight times.
        new RegExp(`(^|[^\\w.$])${construct}\\s*(\\(|\\.each\\b)`, 'u'),
  ]);
  for (const root of roots) {
    for (const absolute of specFiles(root).sort()) {
      const relative = path.relative(ROOT, absolute).split(path.sep).join('/');
      const lines = withoutComments(fs.readFileSync(absolute, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        for (const [construct, pattern] of patterns) {
          if (pattern.test(line)) {
            found.push({ file: relative, construct, line: index + 1, text: line.trim() });
          }
        }
      });
    }
  }
  return found;
}

function sourceProblems(roots) {
  const problems = [];
  const used = new Set();
  for (const skip of authoredSkips(roots)) {
    const at = PERMITTED.findIndex(
      (row) => row.file === skip.file && row.construct === skip.construct,
    );
    if (at === -1) {
      problems.push(
        `authored skip construct with no written reason: ${skip.file}:${String(skip.line)} ` +
          `uses ${skip.construct} -- ${skip.text.slice(0, 120)}`,
      );
    } else {
      used.add(at);
    }
  }
  PERMITTED.forEach((row, index) => {
    if (!used.has(index)) {
      problems.push(
        `PERMITTED allows ${row.construct} in ${row.file}, which is not there any more; ` +
          'remove the row rather than keep a permission for nothing',
      );
    }
  });
  return problems;
}

/** Every test the run did not actually execute, named. */
function notRun(results) {
  const rows = [];
  for (const suite of results.testResults ?? []) {
    // `testResults` in the reporter API, `assertionResults` in `--json` output. MEASURED:
    // reading only the second, the gate failed a planted skip without naming it.
    for (const assertion of suite.testResults ?? suite.assertionResults ?? []) {
      if (assertion.status === 'passed' || assertion.status === 'failed') continue;
      const file = path
        .relative(ROOT, suite.testFilePath ?? suite.name ?? '')
        .split(path.sep)
        .join('/');
      rows.push(`${assertion.status}: ${file} -- ${assertion.fullName}`);
    }
  }
  return rows;
}

function filtered(global) {
  const patterns = global.testPathPatterns;
  const byPath =
    patterns !== undefined && patterns !== null && typeof patterns.isSet === 'function'
      ? patterns.isSet()
      : Array.isArray(patterns) && patterns.length > 0;
  const byName = typeof global.testNamePattern === 'string' && global.testNamePattern !== '';
  const bySelection =
    global.onlyChanged === true ||
    global.onlyFailures === true ||
    global.lastCommit === true ||
    (typeof global.changedSince === 'string' && global.changedSince !== '') ||
    global.findRelatedTests === true;
  return { byPath, byName, whole: !byPath && !byName && !bySelection };
}

class ZeroSkipsReporter {
  constructor(globalConfig) {
    this._global = globalConfig ?? {};
    this._error = undefined;
  }

  /** Jest fails the run when a reporter reports an error here (`@jest/core` hasErrors). */
  getLastError() {
    return this._error;
  }

  onRunComplete(_contexts, results) {
    if (this._global.ci !== true) return;
    const scope = filtered(this._global);
    const problems = [];

    if (scope.byName) {
      process.stderr.write(
        'zero-skips gate: a -t pattern is active, and Jest reports every test it did not ' +
          'select as pending -- the status a skip has. The runtime check stands down for ' +
          'this run; the source check does not.\n',
      );
    } else {
      const skipped = notRun(results);
      if (skipped.length > 0) {
        problems.push(
          `${String(skipped.length)} test(s) did not run:\n    ${skipped.join('\n    ')}`,
        );
      }
      if ((results.numPendingTests ?? 0) > 0 || (results.numTodoTests ?? 0) > 0) {
        problems.push(
          `jest counted ${String(results.numPendingTests)} skipped and ` +
            `${String(results.numTodoTests)} todo; both must be zero`,
        );
      }
    }

    if (scope.whole) {
      const floor = process.env.HOUSTON_SKIP_GATE_PROBE === 'count' ? FLOOR + 1 : FLOOR;
      if (results.numTotalTests < floor) {
        problems.push(
          `the suite collected ${String(results.numTotalTests)} tests, below the floor of ` +
            `${String(floor)}. That is what a broken testMatch, a crashed worker or a stray ` +
            '.only looks like from the outside.',
        );
      }
    }

    problems.push(...sourceProblems());

    if (problems.length > 0) {
      // PRINTED HERE, not left to Jest: `@jest/core` reads `getLastError()` only to turn the
      // run's success false, and never prints it. MEASURED -- the first version failed
      // `yarn test --ci` with exit 1, 1954 passed, and not one word of why.
      const text = `zero-skips gate FAILED:\n  - ${problems.join('\n  - ')}`;
      process.stderr.write(`\n${text}\n`);
      this._error = new Error(text);
      return;
    }
    process.stderr.write(
      `zero-skips gate: ${String(results.numPassedTests)} passed, zero skipped, zero todo` +
        `${scope.whole ? `, floor ${String(FLOOR)} met` : ''}; ` +
        `${String(PERMITTED.length)} reviewed platform guard in the source\n`,
    );
  }
}

module.exports = ZeroSkipsReporter;
module.exports.FLOOR = FLOOR;
module.exports.PERMITTED = PERMITTED;
module.exports.authoredSkips = authoredSkips;
module.exports.sourceProblems = sourceProblems;
