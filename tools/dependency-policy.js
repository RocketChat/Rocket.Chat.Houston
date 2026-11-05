/** Shared source classification for dependency-cruiser and its fail-closed wrapper. */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Rank -> production modules at that rank. A module may import strictly lower ranks.
 * The two __depcruise_selftest__ paths are reserved probes, absent from a clean tree.
 *
 * `src/core/runner/` is split into three ranks rather than sharing one, because it is three
 * tiers -- `paths`/`locks` below `record`/`engine` below `host`/`ports`/`queries` -- and a
 * single rank for the directory would permit exactly the sideways edges those tiers forbid.
 * `src/core/kube/` is split the same way and for the same reason: it is twelve dependency
 * tiers, and they cannot import upward.
 *
 * The last rank deliberately EXCLUDES `src/core/runner/` and `src/core/kube/`, so a new
 * file in either is unmapped and fails the coverage check rather than silently landing
 * at the top.
 */
const RANKS = [
  // `float-text` is the float's displayed form and the whitespace set, with no imports. It sits at rank
  // 0 rather than with the leaves because a leaf needs it: `redact` builds its URL pattern
  // from that whitespace set, and two modules in one rank may not import each other.
  // `mkdir-parents` creates a directory and its missing parents, applying the mode to the
  // leaf only. It sits at the bottom because `lib/lock` at rank 1 claims the home
  // with it.
  //
  // `unicode-tables` is fixed data (the Unicode 15 digit, printable and case-fold tables) with no imports.
  // It sits here, below its caller `format`, for the reason `format` sits at rank 1.
  //
  // `home` resolves the home directory and joins paths component by component, with no
  // imports. It sat with the leaves until `lib/lock` at rank 1 needed the join: the marker
  // is the home joined with MARKER_NAME, and `path.join` folded a `..` the kernel does not.
  //
  // `login-name` reads the login name (glibc's login-uid and utmp), with no imports. Only
  // the CLI's actor calls it.
  // `platform-name` uses only Node's OS and process report to name the host for CLI reports.
  [
    '^src/lib/errors\\.ts$',
    '^src/seams/exec\\.ts$',
    '^src/lib/float-text\\.ts$',
    '^src/lib/map-limit\\.ts$',
    '^src/lib/mkdir-parents\\.ts$',
    '^src/lib/unicode-tables\\.ts$',
    '^src/lib/home\\.ts$',
    '^src/lib/login-name\\.ts$',
    '^src/lib/platform-name\\.ts$',
    '^src/__depcruise_selftest__/rank0\\.ts$',
  ],
  // `format` is the displayed form of values and the integer and float grammars, and
  // imports only `unicode-tables` and `float-text`. It sat at rank 3, which put it out of
  // reach of `config` at rank 2, and `config`'s YAML reader needs exactly those: an explicit
  // `!!int 1e3` is the integer grammar refusing `'1e3'`, and `!!bool y` a refusal in the
  // established words. Moving what a lower module needs DOWN a rank is the rule's own remedy.
  //
  // `yaml-dump` is the YAML 1.1 writer, and imports only `float-text`. It sits here because
  // both of its callers are above it: `config` at rank 2 writes config.yaml with it, and
  // `compose` at rank 4 a workspace's docker-compose.yml.
  // `presets/guides` is the scenario card's guide shape and two pure helpers; it imports
  // nothing, and `presets/types` (rank 2) names its type.
  [
    '^src/lib/(lock|events|redact|context|teammode|mongo-kernel|close-matches|format|yaml-dump)\\.ts$',
    '^src/lib/presets/guides\\.ts$',
  ],
  // `tempdir` finds the temp root and makes private temp directories. It stands on `home`
  // (rank 0) for absolute paths and on `format` (rank 1) for the quoting of its refusal, and only
  // `core/` calls it.
  [
    '^src/lib/(config|ui|eventlog|journal|tempdir)\\.ts$',
    '^src/lib/presets/types\\.ts$',
    '^src/lib/seed-profiles\\.ts$',
  ],
  [
    '^src/lib/(monitoring|version-spec|json-text|seed-options)\\.ts$',
    '^src/lib/presets/registry\\.ts$',
  ],
  // `targz` sits ABOVE `format`, because its only refusal message is
  // `bundle contains an unsafe entry: '<name>'` and the quoting must come from the one
  // implementation of it. Nothing below imports targz.
  //
  // `audit` is here too, though it is a registry and registries are leaves: its field
  // sanitiser is the printable test, which is `format`'s, and asking Node's `\p{C}` instead
  // answered from a newer Unicode. Nothing below `core/`
  // imports it, so it can stand this high and still be the only route `core/rcapi` has to
  // the recorder.
  [
    '^src/lib/(jsonout|versions|compose|targz|audit)\\.ts$',
    '^src/__depcruise_selftest__/rank4\\.ts$',
  ],
  // `src/lib/presets/` is split by tier for the reason `runner/` and `kube/` are. `registry`
  // and `types` are its leaves and already sit at rank 2; these three tiers are what stands
  // on them.
  //
  // The seven builders share ONE rank because none imports another -- an ordering between
  // them would be a claim nothing makes. `index` is alone above them because it is the
  // loader: it imports the builders, so that import moves DOWNWARD from the loader rather
  // than upward from the registry.
  ['^src/lib/presets/(common|scenario|composite)\\.ts$'],
  ['^src/lib/presets/(keycloak|public|voice-pbx)\\.ts$'],
  [
    '^src/lib/presets/(e2ee|email|ldap|livechat|multi-instance|oidc|s3-minio|saml|voice|webhooks)\\.ts$',
  ],
  ['^src/lib/presets/index\\.ts$'],
  ['^src/seams/(?!exec\\.ts$)'],
  ['^src/core/runner/(paths|locks)\\.ts$'],
  ['^src/core/runner/(engine|record)\\.ts$'],
  ['^src/core/runner/(cache|host|ports|queries)\\.ts$'],
  // The database lookup mongoprof, scaleseed and backup all need. Hoisted out of
  // `backup` so the two lower modules reach it DOWNWARD; see its docstring.
  ['^src/core/database-of\\.ts$'],
  ['^src/core/tls-local\\.ts$'],
  ['^src/core/rcapi\\.ts$'],
  ['^src/core/eks-docs\\.ts$'],
  ['^src/core/tls\\.ts$'],
  ['^src/core/edge/(paths|types)\\.ts$'],
  ['^src/core/edge/engine\\.ts$'],
  ['^src/core/edge/(acme|networks)\\.ts$'],
  ['^src/core/edge/routeyml\\.ts$'],
  ['^src/core/edge/spec\\.ts$'],
  ['^src/core/edge/routes\\.ts$'],
  ['^src/core/edge/runtime\\.ts$'],
  ['^src/core/kube/names\\.ts$'],
  ['^src/core/kube/exec\\.ts$'],
  ['^src/core/kube/(ask|tools)\\.ts$'],
  ['^src/core/kube/(capabilities|reachability|replicaset)\\.ts$'],
  ['^src/core/kube/context\\.ts$'],
  ['^src/core/kube/(cluster|endpoints|namespace)\\.ts$'],
  ['^src/core/kube/(manifests|probe|scale|status|transfer)\\.ts$'],
  ['^src/core/kube/release\\.ts$'],
  ['^src/core/kube/operator\\.ts$'],
  ['^src/core/kube/(chart|monitoring)\\.ts$'],
  ['^src/core/kube/(certmanager|forward)\\.ts$'],
  ['^src/core/kube/(ingress|grafana-ingress)\\.ts$'],
  ['^src/core/kube/workspace\\.ts$'],
  ['^src/core/eks\\.ts$'],
  // The account trio sits ABOVE everything it could otherwise be reached from, and that
  // placement is the point rather than an accident of arrival order.
  //
  // These look like low modules -- `audit` imports only `config` -- so the
  // tempting rank is just above the seams. It would be wrong here. Two lower modules
  // need one bit each from this tier and CANNOT import it: `core/rcapi` audits a minted
  // PAT, and `core/kube/namespace` needs to know whether this box has accounts at all.
  // `lib/audit.ts` and `lib/teammode.ts` exist as registries for exactly that, and are
  // the dependency inversion those two docstrings describe. Ranking the trio low would
  // permit the direct edge and let a future change quietly undo the inversion while
  // every gate stayed green; ranking it here makes the registry the only route, which
  // is what a layer gate is for.
  ['^src/core/audit\\.ts$'],
  ['^src/core/sessions\\.ts$'],
  // The Okta links sit just under `users`, because removing an account tombstones its link
  // inside the users lock; `sso`, which reads both and talks to the provider, sits above.
  ['^src/core/sso-identities\\.ts$'],
  ['^src/core/users\\.ts$'],
  // `firstrun`, `skill` and `sso` share ONE rank because none imports another, and a rank
  // per module would claim an ordering between them that does not exist. They sit up
  // here for the same reason the trio above does rather than because anything forces it:
  // nothing below needs them, so nothing below should be able to reach them.
  ['^src/core/(firstrun|skill|sso)\\.ts$'],
  // `diagnose` and `topology` share a rank on the same reasoning: neither imports the
  // other. Both sit above `core/runner/` because that is what they read -- diagnose asks
  // the engine for a failed workspace's logs, topology asks the record what runtime a
  // workspace was created on.
  ['^src/core/(diagnose|topology)\\.ts$'],
  // `journal` and `eventlog` share a rank: neither imports the other, and both are
  // DURABLE SINKS that sit above what they observe. `journal` reads `runner` to decide
  // whether a note's subject is still there; `eventlog` takes the lock seam to rotate.
  // Ranked here rather than low for the reason the account trio is: `core/eks` reaches
  // the journal through `lib/journal.ts`'s registry, and ranking the real module below it
  // would permit the direct edge that registry exists to prevent.
  ['^src/core/(journal|eventlog)\\.ts$'],
  // `src/perf/` is split by tier for the reason `runner/` and `kube/` are. `timings` and
  // `slo` are its pure leaves
  // -- neither imports anything from houston -- and `baseline` reads only `config`, so
  // the three sit at the bottom of it and none imports another.
  ['^src/perf/(timings|slo|baseline)\\.ts$'],
  // Tier 2: everything that reaches the runner seam, plus the three modules that read
  // `timings.fmtMs` -- which is why `timeline` and `verdict` cannot sit with the leaves. Split from the leaves for the reason `runner/` and `kube/` are split
  // -- one rank for the directory would permit the sideways edges its tiers forbid.
  ['^src/perf/(rcmetrics|resources|mongoprof|constrain|k6|verdict|timeline)\\.ts$'],
  ['^src/perf/report\\.ts$'],
  // `postready` is a lifecycle PREREQUISITE and nothing else: the preset self-config a
  // create runs once the workspace answers. It sits above `topology` because it asks which
  // runtime owns the workspace before choosing how to reach into a container, and above
  // `rcapi` and the two seams it drives. It gets its own rank rather than joining the
  // catch-all below because `lifecycle` lands there and CALLS it -- sideways edges are
  // forbidden, so a shared rank would make the one edge this module exists for a violation.
  ['^src/core/postready\\.ts$'],
  // `src/seed/` has five tiers, which cannot import upward. The ranks ARE those tiers. `apply` and `repairs` share one
  // because neither imports the other, and both sit above `core/journal`: one writes the
  // two notes a killed seed leaves behind and the other is what puts them back.
  //
  // `scaleseed` and `configimport` drive the same seams, and they sit below `core/data`,
  // which calls all three.
  ['^src/seed/kinds\\.ts$'],
  ['^src/seed/wording\\.ts$'],
  ['^src/seed/plan\\.ts$'],
  ['^src/seed/(receipt|assets|client)\\.ts$', '^src/core/seed-db\\.ts$'],
  ['^src/seed/(history|executor)\\.ts$'],
  ['^src/seed/(apply|repairs)\\.ts$'],
  ['^src/seed/verification\\.ts$'],
  ['^src/seed/check\\.ts$'],
  ['^src/core/(scaleseed|configimport)\\.ts$'],
  // `cluster` is the read-only ledger over the Kubernetes and AWS seams, and `migrate`
  // adopts a pre-rename state directory. Neither imports the other; both sit above
  // everything they read, and below the catch-all because `lifecycle` and `doctor` call
  // them.
  ['^src/core/(cluster|migrate)\\.ts$'],
  // `src/core/lifecycle/` is layered in tiers. The ranks ARE those tiers, one array entry per layer, because
  // sideways imports within a rank are forbidden and these tiers call each other.
  //
  // The width of this file's tier graph is the reason the ranks are so fine-grained:
  // `types`/`notes` are leaves, `ready` needs `inspect` AND `seeding`, `state` needs
  // `ready`, `destroy` and `pruning` need `state`, and the two create halves stand on
  // nearly all of it. Collapsing any two adjacent tiers would permit exactly the
  // sideways edge the tiers forbid.
  //
  // `admin`, `notes` and `types` have no lifecycle imports at all; they share the bottom
  // rank with the modules whose only edges are to `types`.
  [
    '^src/core/lifecycle/types\\.ts$',
    '^src/core/lifecycle/notes\\.ts$',
    '^src/core/lifecycle/admin\\.ts$',
  ],
  ['^src/core/lifecycle/(naming|request|ports|tlsplan)\\.ts$'],
  ['^src/core/lifecycle/(sizing|seeding|ownership|inspect)\\.ts$'],
  ['^src/core/lifecycle/(preconditions|payload|ready)\\.ts$'],
  ['^src/core/lifecycle/state\\.ts$'],
  ['^src/core/lifecycle/(destroy|pruning)\\.ts$'],
  ['^src/core/lifecycle/create-k8s\\.ts$'],
  ['^src/core/lifecycle/create-docker\\.ts$'],
  // The four lifecycle CONSUMERS. They sit above `lifecycle` because they
  // call it -- `envvars` and `monitor` mutate a running workspace, `data` runs its scale
  // and import paths, `loadtest` preflights and drives a run -- and below the catch-all
  // because `web`/`cli` call them. A shared rank with the catch-all would make every
  // route that imports one a sideways violation on the day it lands.
  //
  // One rank for all four: none imports another, and a rank each would claim an ordering
  // between them that does not exist.
  ['^src/core/(envvars|monitor|data|loadtest)\\.ts$'],
  // `backup` and its pure policy sibling. Above `lifecycle` because backing a workspace
  // up stops and starts it, and below the catch-all so the routes that call it
  // are not a sideways edge. The lookup the lower modules need was hoisted out to
  // `core/database-of.ts` rather than left as an upward call-time `require`.
  // `backup-compat` is the pure policy `backup` asks before touching anything, so it
  // sits one rank lower -- two modules in one rank may not import each other.
  ['^src/core/backup-compat\\.ts$'],
  ['^src/core/backup\\.ts$'],
  // `upgrade` calls `backup` (its automatic pre-upgrade bundle and the rollback's
  // restore), so it sits one rank above it.
  ['^src/core/upgrade\\.ts$'],
  // The recovery registry, which installs the repair handlers every side-effect owner
  // registers. Top of the service layer: it imports all of them, and nothing imports it
  // but the front doors.
  ['^src/core/recovery\\.ts$'],
  // `doctor` composes the completed service layer: every check reads a module below it,
  // and nothing imports doctor but the front doors.
  ['^src/core/doctor\\.ts$'],
  // Promotion composes the state readers and exposes the serve liveness marker. Both
  // front doors may ask it; keeping the path here avoids duplicating serve.pid policy.
  ['^src/core/promote\\.ts$'],
  // The three web leaves sit below the route modules that consume them.
  // Keeping them out of the front-door catch-all is narrow on purpose: a future web
  // module is unmapped here unless it is either one of these leaves or a route-level
  // consumer. In particular, routes may import jobs/signin/security; the leaves may not
  // import each other.
  ['^src/web/(jobs|signin|security)\\.ts$'],
  // Shared route mechanics and the transport-specific authorisation table are leaves
  // beneath every route module. They are separate from the three earlier web leaves
  // because `route-deps` calls the job registry, while no route leaf imports a route.
  ['^src/web/(route-deps|route-table)\\.ts$'],
  // The twelve siblings share one rank: none may import another.
  ['^src/web/routes/(?!index\\.ts$)[^/]+\\.ts$'],
  // The sole route aggregator imports the siblings and nothing imports it but the app.
  ['^src/web/routes/index\\.ts$'],
  // The application factory is the top of the web front door.
  ['^src/web/app\\.ts$'],
  // The TypeScript CLI is L4, but its own one-way construction still matters: inert
  // surface types below the declarative data, renderers/services below registration,
  // and the handler registry above all of them. This prevents a second capabilities
  // table or a command leaf reaching sideways into another command leaf.
  ['^src/cli/(spec-types|wire|cell-widths)\\.ts$'],
  ['^src/cli/(spec-data|error-panel)\\.ts$'],
  ['^src/cli/(help|capabilities|perf|serve)\\.ts$'],
  // The CLI's actor, which the root resolves before a command's argv is parsed: the app
  // asks it at that point, so it sits below the app rather than with the command handlers
  // it also serves.
  ['^src/cli/handlers/actor\\.ts$'],
  // The usage-error verdict on an argv reuses help's Usage line, and the app asks it first.
  ['^src/cli/usage-error\\.ts$'],
  ['^src/cli/app\\.ts$'],
  // The prose every human renderer shares -- the panel and a line -- beneath both the
  // registry and its leaves, so there is one box arithmetic rather than two.
  ['^src/cli/render\\.ts$'],
  // The hidden prompt, `readHiddenLine`, which every command that asks for a password shares:
  // beneath the command leaves that ask with it, so a leaf importing it (`users` does) is
  // not one leaf reaching into another.
  ['^src/cli/handlers/prompt\\.ts$'],
  ['^src/cli/handlers/(?!(actor|prompt)\\.ts$)'],
  ['^src/cli/handlers\\.ts$'],
  // The library index, and the emitted build's entry that `bin/houston` execs: each above
  // the handler registry, importing nothing sideways.
  ['^src/cli/(index|entry)\\.ts$'],
  [
    '^src/core/(?!runner/|kube/|edge/|tls-local\\.ts$|tls\\.ts$|rcapi\\.ts$|eks\\.ts$|eks-docs\\.ts$|audit\\.ts$|sessions\\.ts$|sso-identities\\.ts$|users\\.ts$|firstrun\\.ts$|skill\\.ts$|sso\\.ts$|diagnose\\.ts$|topology\\.ts$|journal\\.ts$|eventlog\\.ts$|postready\\.ts$|scaleseed\\.ts$|configimport\\.ts$|cluster\\.ts$|migrate\\.ts$|promote\\.ts$|lifecycle/|envvars\\.ts$|monitor\\.ts$|data\\.ts$|loadtest\\.ts$|backup\\.ts$|backup-compat\\.ts$|database-of\\.ts$|seed-db\\.ts$|recovery\\.ts$|upgrade\\.ts$|doctor\\.ts$)',
    '^src/web/(?!(jobs|signin|security|route-deps|route-table|app)\\.ts$|routes/)',
  ],
];

function pathOf(rank) {
  const patterns = RANKS[rank];
  if (!patterns || patterns.length === 0) return null;
  return patterns.length === 1 ? patterns[0] : `(${patterns.join('|')})`;
}

function ranksOf(relativePath) {
  const name = relativePath.split(path.sep).join('/');
  const ranks = [];
  for (let rank = 0; rank < RANKS.length; rank += 1) {
    if (RANKS[rank].some((pattern) => new RegExp(pattern).test(name))) ranks.push(rank);
  }
  return ranks;
}

function sourceFiles(root) {
  const src = path.join(root, 'src');
  const found = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name.endsWith('.ts')) {
        const relative = path.relative(root, absolute).split(path.sep).join('/');
        found.push(relative);
      }
    }
  };
  visit(src);
  return found.sort();
}

function coverageProblems(root) {
  const problems = [];
  for (const file of sourceFiles(root)) {
    const ranks = ranksOf(file);
    if (ranks.length === 0) problems.push(`unmapped-production-module: ${file}`);
    else if (ranks.length > 1) {
      problems.push(`multiply-ranked-production-module: ${file} matches ranks ${ranks.join(', ')}`);
    }
  }
  return problems;
}

module.exports = { RANKS, pathOf, ranksOf, coverageProblems };
