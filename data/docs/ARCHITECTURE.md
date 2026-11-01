# Architecture

Why houston is built the way it is, for a contributor about to change it. Each section is a
decision and what breaking it costs. [`README.md`](../../README.md) and [`guide.md`](guide.md)
cover using houston. [`CONTRIBUTING.md`](../../CONTRIBUTING.md) covers setup, the gates and
writing a preset.

## What houston is

houston reproduces a customer's Rocket.Chat issue on their exact version, in minutes. One
command boots a version-matched Rocket.Chat with a compatible MongoDB, optional backing
services (LDAP, SAML/OIDC, email, S3, multi-instance) and sample data, and one more removes
all of it. The Rocket.Chat support team maintains it.

```
houston up --version 8.5.1 --name TICKET-1234 --wait
houston down --name TICKET-1234 --volumes
```

It is TypeScript on Node.js 24.10 or newer. `bin/houston` is a POSIX `sh` script that `exec`s
`node tools/cli.js` over the source on a checkout (any tree with `src/`) and
`node dist/cli/entry.js` in an installed package, so a clone needs no build step and never
runs a stale `dist/`. It `exec`s rather than spawns, so the exit code and signals stay the
caller's. `tsc` emits `dist/` with no bundler, because a bundler rewrites the `data/` lookup
in `lib/config.ts`.

## The shape of it

**Two front-ends over one service layer.** `houston <cmd>` is the terminal. `houston serve`
is a browser GUI a support engineer can use without a shell, with named accounts, roles and
an audit trail.

```
        cli/                                     web/
  commander app, usage errors             Fastify app, guard chain,
  verdicts, handlers, serve               ROUTE_ROLES, jobs, SSE/WS
           │                                       │
           └───────────────────┬───────────────────┘
                               ▼
                             core/
               the entire behaviour of the product
        lifecycle/ kube/ edge/ runner/ backup doctor eks ...
                  with perf/ and seed/ beside it
                               │
     ┌────────────┬────────────┼────────────┬─────────────┐
     ▼            ▼            ▼            ▼             ▼
 docker-cli    kubectl      aws-cli      rc-http       fs/lock
 docker and    kubectl,     aws and      the only      the file
 compose       helm, kind   eksctl       HTTP client   lock
     └────────────┴────── seams/exec ───────┴─────────────┘
                 the one process-launch boundary

       lib/ underneath all of it: errors, events, config, lock,
       jsonout, compose, versions, presets/, the contract formatting modules
```

**Both front-ends call the same `core/` functions.** This is the most important fact about
the codebase. A change the GUI needs almost always belongs in `core/`, not in `web/routes/`.
Behaviour placed in one front-end is missing from the other, and because developers use the
CLI, the GUI is the one that loses it. `cli/serve.ts` builds the app `web/app.ts` exports, so
`cli/` ranks above `web/`. Service functions are asynchronous, state owners included: `serve`
is one event loop, and a state owner that blocked on a write would stall every request in it.

### The seams

**Six modules touch the outside world, and nothing bypasses them.** Each is thin: it knows
argv, a timeout, an environment, a URL. The tool-specific ones have a domain half in `core/`.

| Seam | Launches | Who may import it |
|---|---|---|
| `seams/exec.ts` | every OS process, as an argv tuple, `shell` always false | anything; nothing else may import `child_process` |
| `seams/docker-cli.ts` | `docker`, `docker compose` | `core/runner/`, `core/edge/`, `core/doctor`, `core/migrate`, `perf/constrain` |
| `seams/kubectl.ts` | `kubectl`, `helm`, `kind` | `core/kube/exec.ts` alone, which decides which client state a call may see |
| `seams/aws-cli.ts` | `aws`, `eksctl` | `core/eks.ts` alone, which decides whose account is being spent in |
| `seams/rc-http.ts` | every HTTP request | `core/rcapi.ts`, where every Rocket.Chat path lives, and `core/sso.ts`, where the identity provider's do |
| `seams/fs/lock.ts` | the cross-process file lock (Node has no `flock`) | the state owners: `core/runner/locks`, `core/users`, `core/sessions`, `core/eventlog`, `core/promote` |

Narrow seams are why the suite runs without Docker, a cluster, an AWS account or the
network. Error policy stays with the caller: `kubectl` never throws, because a preflight that
raised on a missing binary would take down `doctor`, the command people run when things are
missing. `.dependency-cruiser.js` enforces `only-exec-launches-processes`,
`only-kube-exec-launches-kubectl`, `only-eks-launches-aws` and `only-rcapi-speaks-http`.
eslint covers what a graph cannot see, `no-restricted-imports` on `child_process` and
`no-restricted-globals` on `fetch`, each switched off for exactly one file and for tests.

### The layering rule

> A module imports only from a strictly lower layer, never sideways within a layer,
> never upward; anything two siblings both need moves DOWN into their package's
> layer-0 module; the only permitted upward reference is a registry a lower layer
> owns and an upper layer registers into.

Layers are **ranks**, finer than directories, in the `RANKS` table of
`tools/dependency-policy.js`. `lib/` fills the bottom and the five seams other than `exec`
share one rank above it. Then come the tiers of `core/runner/`, `core/edge/`, `core/kube/`,
`core/lifecycle/`, `perf/` and `seed/`, the services that compose them, `web/`, and `cli/`.
Two modules in one rank may not import each other. `.dependency-cruiser.js` generates a
`layer-N-imports-down-only` rule per rank, because a hand-kept n-squared list drifts and a
drifted layer rule fails open. `tsPreCompilationDeps` makes a type-only import count.

The gate fails closed. `yarn depcruise` refuses a module that matches no rank or more than
one before it cruises a single edge. `yarn depcruise:selftest` plants a cycle, a type-only
rank-0 to rank-4 edge and a `node:child_process` import, and requires each to be reported:
dependency-cruiser reports a clean tree when it cannot load `typescript`, and a gate nobody
has watched fail is a green light with no bulb.

**Registries are the one upward reference.** A high module registers into a registry a low
one owns: `lib/events.ts` for event sinks, `jsonout.onActivate()` for moving prose to stderr,
and `lib/audit.ts`, `lib/journal.ts` and `lib/teammode.ts`. The real `core/audit`,
`core/journal` and `core/users` rank above every user of their registry, so the gate refuses
the direct edge.

### Why `lib/` has its own formatting modules

The frozen CLI contract includes exact spellings: how a float prints, where a tie rounds, how
a truncated JSON file is reported, how a YAML scalar is quoted, which option a typo matches.
Node answers each one plausibly and differently. So `lib/` carries small, measured
implementations of exactly those formats (`format`, `float-text`, `json-text`, `yaml-dump`,
`close-matches`, `mkdir-parents`, `tempdir`, `login-name`, `platform-name`, `home`, `version-spec`,
`unicode-tables`), and each module's header says where it departs from Node, and why.

## The decisions

**Progress is an `Event`, not a print.** `lib/events.ts` defines `Event` and
`type Emit = (event: Event) => void`, and every long-running service function takes `emit`,
defaulting to `nullEmit`. The CLI prints events, `web/jobs.ts` buffers them per job and
`web/routes/jobs.ts` streams them over SSE. A service function that prints instead is
invisible in the GUI, and a fact returned but never emitted never reaches the GUI's log.

**Failure is a raised `ReproError`, not an exit.** `lib/errors.ts` gives every subclass an
HTTP status for the web layer, a stable `code` for the `--json` envelope and an exit code for
the CLI, named in `EXIT_CODES`, which `houston capabilities` publishes. A service that ended
the process would be harmless in a one-shot command and fatal in `serve`, where one bad
request would take the server down. Nothing under `core/` calls `process.exit`.

| Class | HTTP | Exit |
|---|---|---|
| `ReproError` | 400 | 1 `internal` |
| `ValidationError` | 400 | 2 `usage` |
| `DockerError`, `PreflightError` | 502, 409 | 3 `preflight` |
| `NotFoundError` (and `MissingRecordError`) | 404 | 4 `not_found` |
| `NotReadyError` | 409 | 5 `not_ready` |
| `AuthorityGateError` | 403 | 6 `gate` |
| `CreateFailedError` | 500 | 7 `create_failed` |
| `ConflictError` | 409 | 8 `conflict` |

**Background jobs are bounded.** `web/jobs.ts` keeps at most `MAX_JOBS = 100` jobs of
`MAX_EVENTS_PER_JOB = 2000` events, and only the 10 newest finished jobs keep their result. A
capacity search result is about 118 KB, and `serve` is a long-lived process on a box that runs
out of RAM first. Job kinds are a closed tuple mapped to pools, so a kind with no pool is a
compile error.

**"I could not ask" is not "it is not there".** This is the rule of `core/kube/`, and the
costliest to forget. A failed read answered with an empty list looks exactly like "the cluster
holds none of these", and the teardown or report that acts on it acts on something false. So
`Answer` (`core/kube/ask.ts`) is `PRESENT`, `ABSENT` or `REFUSED`, and `Reach`
(`core/kube/reachability.ts`) is `REACH_OK`, `REACH_DENIED`, `REACH_NO_CONTEXT` or
`REACH_DOWN`. JavaScript lets any object stand in a condition, so eslint's
`strict-boolean-expressions` disallows objects, and `yarn lint:truthiness` plants
`if (answer)` to prove the rule is live. `test/core/invariants/kube-source.test.ts` walks the
package so a new read cannot bring the collapse back, and `core/cluster.ts` shows a fact it
could not read as `null`, never `0`.

**Authorisation is a table, not scattered checks.** `ROUTE_ROLES` in `web/route-table.ts` is
**DEFAULT DENY**: an unlisted route is refused for everyone with a 403 and an audit line, and
`installRouteCompleteness` keeps the app from becoming ready while any route is unlisted.
Reads need readonly. Writes, and reads that hand over credentials (logs, env, a PAT, a raw
REST call), need member. People management and building or deleting a cloud cluster need
admin. The table lives in the web layer because the CLI honours `HOUSTON_USER` as given
(`cli/handlers/actor.ts`), so a check in `core/` would make `HOUSTON_USER=<any admin>` a
one-word privilege escalation. A policy that must hold at both
front doors is box configuration, which `core/lifecycle/ownership.ts` reads.

**Sessions are server-side so they can be ended.** `core/sessions.ts` issues a 256-bit id and
stores only its sha256. A session ends after 12h idle or 7d in total. Sign-in is rate-limited
per client address at `doSignin` in `web/security.ts`, where the scrypt is spent, because
`core/users.ts` cannot refuse on a counter without also refusing correct passwords. Hashing is
scrypt from `node:crypto`, with no bcrypt or argon dependency, and an unknown name is checked
against a dummy hash so it costs what a wrong password costs. `yarn test:timing` measures it.

**Okta sign-in is a second way in, never the only one.** `core/sso.ts` runs OpenID Connect
(authorization code, PKCE, a confidential client) from `GET /signin`, verifies the RS256 ID
token with `node:crypto`, and resolves the person to an account by the provider's `sub`, kept
in `core/sso-identities.ts` beside the unchanged `users` file. A first sign-in links an
account of exactly the same name, or creates a member; an admin account links only after
`houston users link-sso`, and a different name never links. Every failure is a fixed reason
code, so a provider that is down or misconfigured costs the button, never `serve`, a password
sign-in or a live session. Removing an account turns its link into a tombstone in the same
lock, so the person's next Okta sign-in is refused rather than recreating it.

**TLS is a runtime property, not a build-time one.** One Traefik edge holds `:80`/`:443` for
the box. A workspace gains or loses HTTPS when a route file appears or disappears, never by a
rebuild. The edge joins each workspace's network live, and each workspace keeps its own
network, so workspaces still cannot reach each other. `core/lifecycle/tlsplan.ts` makes every
HTTPS decision before anything is built. Routes address the **container name**, never the
service alias: every workspace names its service `rocketchat`, so on an edge attached to many
networks the alias resolves to one of them and would silently serve the wrong workspace.
`test/core/invariants/edge-and-doctor.test.ts` holds a route to the container.

**`--json` is one envelope, and it is the last line.** `lib/jsonout.ts` defines
`{schema, contract, houston_version, generated_at, ok, data, warnings, error}`. `up` and
`ready` write NDJSON `houston.event.v1` lines first, then exactly one envelope, failures
included, so a caller reads to the end and parses one line. stdout carries JSON and nothing
else: `activate()` moves every human line to stderr, which is how
`houston info --json > case.json` is a valid document while the person running it still sees
progress. `PHASES` is closed by the compiler, because `Event.phase` is typed `EmittedPhase`.

**Capacity is a preflight that refuses, not a warning.** `checkCapacity()` in
`core/lifecycle/sizing.ts` reserves host RAM headroom and blocks `up`. houston usually runs on
a laptop already running other stacks. When memory runs out the kernel picks its own victim,
and a create that cannot finish leaves a half-made workspace behind.

**Everything binds loopback unless told otherwise.** Reproductions ship weak fixed credentials
(`admin` / `admin123`), so everything binds `DEFAULT_BIND_HOST` (`127.0.0.1`) unless opted out
with `--bind`, `HOUSTON_BIND_HOST` or `config set bind_host`. A workspace reachable beyond
loopback gets a generated admin password instead, when it is made: a rebuild keeps the one
its database holds (`keptAdminPassword`), since Rocket.Chat sets it only on an empty
database. `PRESET_PORTS` in `lib/config.ts` is the one registry of PREFERRED side ports,
`MONITOR_PORTS` monitoring's. `core/lifecycle/ports.ts` allocates Rocket.Chat's own port
and every side and monitoring port under one lock (`claimSidePorts`): preferred first, the
next free one when another workspace holds it, never another preset's preferred port or a
voice port. A workspace records only what moved (`extra.side_ports`; monitoring in
`extra.monitoring_ports`), `runner/record.ts` reads it back (`sidePortsOf`,
`grafanaPortOf`, `prometheusPortOf`), and the builders take the result as their `ports`
argument. Only voice's call ports, which phones dial by number, are refused when taken.

## Runtimes and the cloud

`core/topology.ts` records the runtime, the deployment and the replicas. `docker` runs on this
machine as `monolith` or `multi-instance`; `kubernetes` runs on any cluster (kind, k3s, EKS) as
`microservices` or `monolith`. `api`, `token`, `pat`, `config-import` and ordinary `seed` speak REST to a URL.
Historical seed creates content through REST, then `core/seed-db.ts` resolves and validates
the live managed MongoDB target before adjusting only captured message/file timestamps.
It uses the recorded Docker project or Kubernetes namespace/context and feeds credentials
through stdin. External or ambiguous databases are refused. Operations that need a compose project call
`topology.requireCompose()`, which refuses **and names the Kubernetes equivalent**. "Not
supported" alone leaves the user to find what the author already knew.

**The cloud is two verbs at two lifetimes.** `cluster create` runs once per team, takes about
20 minutes and bills by the hour from minute one. `up` runs once per ticket, takes minutes
and is free. **`up` can never create a cloud cluster**, and that is structural: `planCluster()`
in `core/kube/context.ts` adopts an explicitly named context and never provisions one, and
`core/kube/cluster.ts` creates only houston's own local cluster. Its `deleteCluster` takes no
cluster parameter at all. AWS IAM decides who may build a cluster and the cluster's own RBAC
decides who may use it, so `houston cluster iam-policy` ships three documents from `data/iam/`.
[`eks.md`](eks.md), which `houston cluster guide` prints, is the procedure.

**One answer about clusters, rendered twice.** `cluster.overview()` in `core/cluster.ts`
reads every AWS context through `status()` (the ledger: nodes, workspaces, cost, who
built it from the cluster's own tags, expiry, whether it is prepared and whether its DNS
zone answers) and every other with a glance (whether it answers, its distribution and
its workspaces); `whereOf()` decides which, from the context name and the API server,
never a probe. It adds the AWS totals and the preflight, and asks `nextStep()` for the
AWS stage, a pure table over the six stages every screen names. `houston cluster overview` prints
it; `/api/clusters/overview` serves it to the Clusters page, Home's Needs you and the
EKS setup flow. Neither front-end decides what exists, what it costs or what comes next.

## Where things live

One line per directory. Where a line uses `·`, it separates ranks, bottom first.
`git ls-files src` is the authority on what exists (tests live in `test/`), and each module's
header comment says what it is for.

- **`lib/`**, below every service: `errors` `events` `jsonout` `config` `lock` `context`, the registries `audit` `journal` `teammode`, then `compose` `versions` `monitoring` `mongo-kernel` `redact` `seed-profiles` `seed-options` `targz`, and the exact-format modules `format` `float-text` `json-text` `yaml-dump` `close-matches` `mkdir-parents` `tempdir` `login-name` `platform-name` `home` `version-spec` `unicode-tables`, and `map-limit` (a bounded concurrent map the cluster ledger and the region sweep share)
- **`lib/presets/`**, the dynamic presets (static presets are YAML in `data/presets/`): `types` `guides` (what a preset tells the GUI's preset card: sign in as, try it, good to know) · `registry` · `common` `scenario` `composite` (several presets as one) · `keycloak` `public` (a preset's UIs at paths of the HTTPS name) `voice-pbx` (the voice PBX lab) · `e2ee` `email` `ldap` `livechat` `multi-instance` `oidc` `s3-minio` `saml` `voice` · `index`
- **`seams/`**, the only doors out: `exec` `docker-cli` `kubectl` `aws-cli` `rc-http`
- **`seams/fs/`**: `lock`
- **`core/`**, the shared brain. REST and cloud: `rcapi` `eks` `eks-docs` `cluster` `topology`. HTTPS: `tls` `tls-local`. Data: `backup` `backup-compat` `database-of` `seed-db` `upgrade` `envvars` `monitor` `data` `configimport` `scaleseed` `loadtest` `postready`. Diagnosis: `diagnose` `doctor`. Records: `journal` `recovery` `eventlog` `audit`. People: `users` `sessions` `firstrun`, and Okta sign-in, `sso` with its links `sso-identities`. The home: `skill` `migrate` `promote`
- **`core/runner/`**, Docker per workspace: `paths` `locks` · `engine` `record` · `host` `ports` `queries`
- **`core/edge/`**, the shared Traefik edge: `paths` `types` · `engine` · `acme` `networks` · `routeyml` · `spec` · `routes` · `runtime`
- **`core/kube/`**, the Kubernetes domain half, which selects by label and never by name prefix: `names` · `exec` · `ask` `tools` · `capabilities` `reachability` `replicaset` · `context` · `cluster` `endpoints` `namespace` · `manifests` `probe` `scale` `status` `transfer` · `release` · `operator` · `chart` `monitoring` · `certmanager` `forward` · `ingress` `grafana-ingress` · `workspace`
- **`core/lifecycle/`**, create, inspect, change and destroy, with no façade (import the module that defines a name): `types` `notes` `admin` · `naming` `request` `ports` `tlsplan` · `sizing` `seeding` `ownership` `inspect` · `preconditions` `payload` `ready` · `state` · `destroy` `pruning` · `create-k8s` · `create-docker`
- **`perf/`**, what `loadtest` and `capacity` measure: `timings` `slo` `baseline` · `rcmetrics` `resources` `mongoprof` `constrain` `k6` `verdict` `timeline` · `report`
- **`seed/`**, sample data planned before anything is created and read back after: `kinds` · `wording` `assets` · `plan` `client` · `receipt` · `executor` `history` `verification` · `apply` `repairs` · `check`
- **`cli/`**, the terminal front door: `spec-types` `wire` `cell-widths` · `spec-data` `error-panel` · `help` `capabilities` `perf` `serve` · `usage-error` · `app` · `render` · `handlers` · `index` `entry`
- **`cli/handlers/`**: `actor` · `prompt` · `https` `users`
- **`web/`**, the `serve` server: `jobs` `signin` `security` · `route-deps` `route-table` · `app`
- **`web/routes/`**, one module per family, `spa` registered last because it matches every path: `session` `people` `meta` `repros` `logs` `data` `backup` `clusters` `edge` `perf` `jobs` `spa` · `index`

Outside `src/`, `bin/houston` is the entry and `data/` ships beside the code: `versions.yaml`,
the static presets, dashboards, k6 scripts, the GUI, the agent skill, the IAM documents and
these documents. `test/` and `tools/` do not ship.

## Durable sample data

`lib/seed-options.ts` supplies both front-ends with the profile/scenario catalogue.
`seed/plan.ts` assigns content and actions to named participants before mutation.
`core/lifecycle/seeding.ts` drives the executor, optional history and exact verification.
Workspace locks serialize all entry points. `seed/receipt.ts` fsyncs immutable manifests
and a hash-chained write-ahead log under `repros/<name>/seed-receipts/`; no credentials
are stored. Uncertain writes reconcile by exact identity or refuse replay. In particular,
media confirmation is not replayed: supported servers can create a second message.
`ready` resumes the recorded batch after rechecking its identity under the lock.
Verification checks the latest batch, preserves true/false/null, and reads personal
features with their actor token. Existing content and customized metadata remain intact.

## The GUI

The GUI is vanilla ES modules with no build step, in `data/webui/` and served by
`web/routes/spa.ts`. `yarn verify:gui-hash` checks an explicit list of its files and one
digest over all of them, recorded when the GUI was frozen, so changing the GUI means
re-recording that digest on purpose.

**Colour is a signal, never decoration.** The rule is declared at the top of `app.css`: green
= running, amber = wants you, red = about to destroy something, blue = you can click it.

**The payload-shape trap.** Browser tests render from a hand-written `detail()` fixture in
`test/web/browser/frozen-gui.browser.test.ts`. A key that differs from what
`core/lifecycle/payload.ts` really returns breaks the panel in production while the suite
stays green. A browser test compares the fixture with the real payload, and
`test/core/lifecycle/inspect.test.ts` holds the real payload's keys.

## Performance: what is allowed to be slow

Each read of a remote cluster is a round trip, a second or two against EKS, so each operation
has a budget. The GUI's cluster list (`GET /api/clusters`) probes **nothing**, so the page
draws its cards at once. The Clusters page, Home and step 1 of Create then read one
`GET /api/clusters/overview`, which reads every cluster with bounded concurrency (and a
cluster on this machine only lightly); `GET /api/clusters/status` is read only when a
local cluster's own page is opened. `up` and `cluster create` take minutes, and must **say what they are doing while
they do it**.
Independent reads run concurrently. A step that prints nothing until it returns, like
`helm install --wait`, is where somebody decides the tool has hung and kills it, leaving a
half-installed release.

## State

Everything lives under `HOUSTON_HOME` (default `~/.houston`). The layout is in the user guide,
under [Where state lives](guide.md#where-state-lives). The compose file is generated, so
re-run `up` rather than editing it.

**The `IMPLEMENTATION` marker says which build may write a home.** This build is `typescript`.
`dual-v1` means every state format in the home was read back and agreed about, and a fresh
home is claimed as `dual-v1`. A marker this build does not know is refused before anything is
written, and so is a home holding a transition file. Only `core/promote.ts` changes a claimed
marker, under all five state locks, and the transition file exists exactly while a promotion
is in flight. A home 1.x left is adopted once. On the first command, `promote` reads every
state format in it back under the locks, swaps the marker to `dual-v1` atomically, clears the
transition file last, and says so on stderr. On any failure the home is left as it was.

**A cloud cluster's ownership is a tag on the cluster, in AWS.** A local file is one
`mktemp -d` away from a billable cluster houston can no longer prove is its own. A tag
survives a lost home, another machine and a colleague.

## Testing

`src/` is production code only. `test/` mirrors it path for path, so a failure names the
module. Nothing in the suite needs Docker, a cluster, an AWS account or the network. The
`test/testsetup*.ts` files give every spec file a fresh `HOUSTON_HOME`, a deterministic engine,
absent cloud tools and no non-loopback network, and the engine, cloud and network setups each
have a spec of their own. Anything run outside Jest must isolate itself the same way, with
`export HOUSTON_HOME=$(mktemp -d)` first.

- **Zero skips, and a floor.** `tools/jest-zero-skips.js` fails a skipped, todo or `.only`
  test and a run below the measured floor. The commit that moves the floor says why.
- **The browser suite runs in-process**, through the `playwright` library with the Fastify app
  in the same process, and must pass an exact count. `@playwright/test` would run the server
  out of process, where it sees none of the stubs, and the suite would stay green.
- **Invariant specs walk the source**, from each layer's `invariants/`: `ROUTE_ROLES` against
  the registered routes, `doctor.CHECKS` against its call sites, the lock every mutation
  takes. Registries drift; walks do not.
- **1.x's answers are pinned** under `test/fixtures/` wherever the contract is what 1.x printed
  or wrote. Where 2.0.0 reworded a message into houston's own words, the fixture holds the new
  wording and the rest of 1.x's answer.
- **A regression test must fail against the pre-fix code.** Reverse the fix, confirm the test
  fails for the stated reason, restore it byte for byte. A test that passes both ways proves
  nothing.

The gates, what each proves and what CI runs are in
[`CONTRIBUTING.md`](../../CONTRIBUTING.md#the-gates).

## Compatibility with 1.x

houston 2.x replaces 1.x in place. Every command, flag, exit code, `--json` envelope and state
file format is unchanged. What 2.0.0 changed is the wording of some messages: they name the file
and the reason in plain words, where 1.x printed its runtime's exception names and value
spellings. A 1.x install keeps working after 2.x is installed, on the same home, because
both read the `dual-v1` marker and take the same `flock(2)` locks.

## The rule behind most of the rules

A support tool's worst failure is not crashing. It is **answering confidently and wrongly**:
reporting zero volumes for a cluster it could not read, certifying a URL served by something
else, saying a certificate failed when it had not arrived yet, or telling somebody a cluster
costs nothing because the pointer file was lost. Most of this document applies that idea in
different places. Say what you know, say what you could not find out, and never let the
second turn into the first.
