---
name: houston
description: Use when someone asks to create, spin up, boot or start a Rocket.Chat workspace or server, on a given version ("a workspace on 7.4.1") or a pull request's build, or when a task needs one running - reproduce a support ticket or reported behaviour, check whether a bug is version-specific, or compare two versions; try a feature or setting, test an integration (LDAP, SAML, OIDC, email, S3/MinIO, livechat, E2EE, Voice/SIP/PBX, HTTPS, air-gapped), demo or train with sample data, or call its REST API; on Docker, Kubernetes or EKS. Also to list, inspect, read the logs of, back up, restore, upgrade or tear down those workspaces. Drives the `houston` CLI, which runs a version-matched Rocket.Chat and MongoDB.
---

# houston

houston boots a version-matched Rocket.Chat paired with a compatible MongoDB, on
Docker Compose or Kubernetes, with optional backing services (LDAP, SAML/OIDC,
email, S3, several instances) and sample data. Each workspace is disposable: made for
one purpose, then removed.

**When it helps:** whenever seeing Rocket.Chat run matters. Reproducing a support ticket
or a reported behaviour on the exact version it was seen on, checking whether a bug is
version-specific, comparing two versions, trying a feature or a setting, testing an
integration, checking a pull request's build, or a demo or training workspace.

**When it does not:** a question the documentation or the source code answers needs no
workspace, so answer it without booting one. houston only manages the workspaces it
creates; it cannot reach a Rocket.Chat deployment somebody else runs.

If `houston` is not found, it is not installed: `npm install -g @rocket.chat/houston` installs it
(Node 24.10.0 or later), and Docker with `docker compose` v2 must be running. Then
`houston doctor` names anything else a boot would trip on. Its guides ship in the
package's `data/docs/` (`$(npm root -g)/@rocket.chat/houston/data/docs/`).

## Requests and the commands they mean

`<n>` is the workspace's name: what you pass to `--name` when you create it, and
`data.name` from the `up` reply when you report it (see [Naming](#naming)). Add `--json` where the
command takes it and read the last line (see [The output contract](#the-output-contract)).
`houston capabilities` always prints JSON and takes no `--json`.

| The person asks | Run | Then |
|---|---|---|
| a workspace on 7.4.1 | `houston up --version 7.4.1 --name <n> --wait --json` | `houston info --name <n> --json`, and report back |
| the same with LDAP | `houston up --version 7.4.1 --name <n>-ldap --preset ldap --wait --json` | a **new name**: an existing one is reused as it was |
| SAML, OIDC, email, S3, livechat, offline | `--preset saml`, `oidc`, `email`, `s3_minio`, `livechat` or `airgapped` on `up` | `oidc`: ask the person to add `127.0.0.1 keycloak` to `/etc/hosts` |
| encrypted conversations | `houston up --version 8.8.0 --name <n> --preset e2ee --wait --json` | the person signs in as `e2e-alice` and `e2e-bob` in two browser profiles ([E2EE](#e2ee)) |
| Voice calls | `houston up --version 8.7.0 --name <n> --preset voice --license <file> --wait --json` | the person signs in as `voice-alice` and `voice-bob` and calls; `--set sip_integration=on` adds the SIP integration ([Voice](#voice)) |
| an integration or a webhook | `houston up --version 8.6.3 --name <n> --preset webhooks --wait --json` | `houston info --name <n> --json` gives the inbox URL and the incoming hook; the inbox UI is on the machine running houston only; `--set capture=all` repoints a restored dump's outgoing integrations at the inbox |
| a pull request's build, or develop | `houston up --version pr-42617 --name <n> --wait --json` | a CI build, not a partial version ([Versions](#versions)) |
| HTTPS on this machine | `houston up --version 8.5.1 --name <n> --https --wait --json` | for OAuth, SAML and anything that needs a secure origin; the person runs `houston trust-ca` once first ([HTTPS](#https)) |
| HTTPS for a phone or another machine | `houston up --version 8.5.1 --name <n> --domain <host> --email <address> --wait --json` | ask for the name; it must already point at this machine ([HTTPS](#https)) |
| a specific MongoDB version too | `houston up --version 7.4.1 --mongo 6.0 --name <n> --wait --json` | only when the request names one |
| several Rocket.Chat instances | `houston up --version 7.4.1 --name <n> --deployment multi-instance --replicas 3 --wait --json` | Docker only |
| put some data in it | `houston seed --name <n> --profile standard --verify-seed` | exit 0 means the readback matched ([Sample data](#sample-data)) |
| 50k users, a huge room | `houston seed --name <n> --scale users=50000,messages=800000@general` | undo with `houston seed --name <n> --clear-scale`; Docker only |
| what's running | `houston list --json` | `data.repros[]`: `name`, `owner`, `rc_version`, `state`, `links[0].url`; every workspace on the machine |
| show the logs | `houston logs --name <n> --tail 200` | never `-f`: it does not return |
| is it up yet | `houston ready --name <n> --json` | one call waits up to `--timeout` seconds (300); on exit 5 read `houston logs --name <n> --tail 200` before asking again |
| upgrade it to 8.0.0 | `houston upgrade --name <n> --to 8.0.0 --dry-run`, then without `--dry-run` | it must be running; if the dry-run refuses, stop and tell the person what it said, otherwise go ahead; it backs up first; `houston upgrade --name <n> --rollback` undoes it; a version needing another MongoDB major is refused |
| back it up | `houston backup --name <n> --label "<why>"` | `houston backups --name <n>` lists the bundles |
| restore a bundle | `houston restore <bundle> --new` | only `.rcbak` bundles `houston backup` made; restoring in place replaces data: ask first |
| change a setting | `houston api --name <n> --2fa POST /api/v1/settings/<Id> -d '{"value":<v>}'` | or `houston env --name <n> --setting <Id>=<v>` on Docker |
| call the REST API | `houston api --name <n> GET /api/v1/me` | `--pat` calls it as a personal access token would; `houston token --name <n>` prints headers for curl |
| import a settings export | `houston config-import <file> --name <n> --dry-run`, then without `--dry-run` | report what was skipped |
| compare 7.4.1 and 8.0.0 | two `up`s with different names, one after the other | report both, remove both |
| pause it, resume it | `houston stop --name <n>`, `houston start --name <n>` | |
| tear it down | `houston down --name <n> --volumes --yes --json` | only workspaces you created; backup bundles in `~/.houston/backups/` are kept |
| which MongoDB goes with a version | `houston versions 7.4.1` | |
| what clusters there are, and their cost | `houston cluster overview --json` | the safe read: every cluster, its state, cost a day, reminder date and next step; it changes nothing and buys nothing |

### Checking how a version behaves

For a support ticket or reported behaviour, a bug that may be version-specific, a feature
to try, or a pull request to check:

1. **Take the facts from the request:** the full Rocket.Chat version, and the MongoDB
   version, deployment (several instances, microservices, Kubernetes) and sign-in method
   only when the request names them. Without a full version, ask ([Versions](#versions)).
2. **Boot the smallest match:** one `up` with a name that says what it is for, only the
   presets the behaviour involves, and `--seed --seed-profile standard` when the steps
   need rooms, users or messages.
3. **Run the steps.** In a browser that is the person's part: give them the URL and the
   logins. Over the REST API you can do it yourself with `houston api`.
4. **Report what was observed:** say a behaviour happens on 7.4.1 only when it was seen
   on that workspace; otherwise say it was not seen there, and what was tried. Attach the
   record ([The record to share](#the-record-to-share)) and the `houston logs` lines that
   show it.
5. **Narrow it by version** when the person needs to know where a behaviour started or
   whether it is fixed: the last version reported good and the first reported bad, under different
   names; for a fix, its pull-request build or the release it ships in. Boot them one after
   the other, and bisect between releases only when the person asks: each boot takes
   minutes and about 1.1 GB.
6. **Clean up** as [Tear it down](#tear-it-down) says.

### Naming

- **Always pass `--name`**, one that says what the workspace is for: an issue or
  pull-request id when there is one (`--name pr-42617`, `--name issue-1234`), otherwise
  `rc` plus the version with dashes, plus the preset: `rc7-4-1-ldap`.
- Names are lowercased, and anything outside `a-z`, `0-9` and `-` becomes `-`, up to
  64 characters. With accounts on the machine, houston puts the owner (`HOUSTON_USER`)
  in front: `lucy-issue-1234`. Later commands accept the name you typed as well, and
  `data.name` from the `up` reply is the name to report. Build a new name (`<n>-ldap`)
  from the name you chose, not from `data.name`, or the owner prefix is applied twice.
- **An existing name is reused exactly as it was.** A different version, preset, port,
  `--set` or other flag is ignored, with a `VERSION_IGNORED_ON_REUSE` warning in the reply
  naming each. A new preset needs a
  new name; a new version means `upgrade`.

### Versions

**Never boot a partial version.** "7.4" is not a release: it boots a `7.4` image tag
that may not be the patch that was meant. Ask for the full version, or run
`houston versions 7.4.1`: `resolved via : releases.rocket.chat` is a real release, and
`map (no such release)` means ask the person. `versions` confirms a version you have; it
cannot find the right patch for you. The same applies to `upgrade --to`.

**A CI build is named, not partial:** `--version develop` or `--version pr-<number>` (either
with `-fips` or `-cov`) boots that build from `ghcr.io/rocketchat/rocket.chat`, and
`houston versions pr-42617` shows the release it is recorded as and its MongoDB. It needs
the network; offline, `up` stops and names the way round.

### What to tell the person afterwards

From `houston info --name <n> --json`:

- the URL: `data.links[0].url`;
- the admin login: `data.login.user` and `data.login.password`. It is `admin` /
  `admin123` only for a workspace on loopback; one with `--domain` or a wider `--bind`
  gets a generated password, so always read it;
- a preset's own logins and consoles, from `data.notes` (`ldap`, `saml` and `oidc` users
  are `user1` / `user1`);
- the Rocket.Chat and MongoDB versions it runs (`data.rc_version`, `data.mongo_tag`);
- that it is still running, and the command that removes it.

### Ask a person first

- anything that touches a cloud cluster: `cluster create`, `cluster delete`,
  `cluster keep` (it moves the date a cluster is meant to go by), `cluster share` (it
  grants somebody access in AWS and in the cluster), `up` with `--context` naming a
  cloud cluster, or `up --runtime kubernetes` without `--context`
  when `houston doctor --json` names a cloud cluster as the one it would use. If a task
  needs EKS and no cluster exists, say so and ask; never create one. A local Kubernetes
  workspace is a stand-in only if the person agrees;
- `--bind` beyond `127.0.0.1`, or `houston config set bind_host`;
- `--reg-token`: a registration token is a real licence, never paste one into an issue,
  a ticket or a chat;
- `down --volumes`, `prune`, or an in-place `restore` of a workspace you did not create.
  `down --volumes`, `prune` and `cluster delete` ask for confirmation; pass `--yes` only
  once the person has agreed, or for a workspace you started for your own checks;
- stopping or removing a workspace the person asked for, even one you created, for instance
  to free a port. There is none to free for a second workspace with the same `ldap`,
  `saml`, `oidc`, `email`, `s3_minio`, `livechat` or `webhooks` preset: its side service gets
  the next free port, and `houston info` gives its addresses. Two `voice` workspaces with
  `sip_integration=on` clash on their RTP ports, whose numbers phones dial: give the second
  its own range with `--set rtp_ports=21000-21046` rather than removing the first. Only one
  with `pbx=on` can run per machine;
- exit 6: show `error.gate.approve_with` to the person, never run it yourself;
- `houston trust-ca`, or editing `/etc/hosts`.

## Three standing rules

1. **Read `houston capabilities` first.** It is JSON, needs no container engine,
   and is the authority for *this build* on which commands exist, which accept
   `--json`, which stream progress, what the error codes are and what each exit
   code means. Do not assume a flag exists because it did in another version.
2. **Branch on the exit code and `error.code`, never on prose.** Messages get
   reworded between releases; codes do not.
   - `1` internal — an unhandled failure. There is still an envelope on stdout;
     the stack trace is on stderr. Retrying unchanged will not help.
   - `2` usage — fix the call; retrying unchanged will not help.
   - `3` preflight — the environment is not usable. Run `houston doctor --json`.
   - `4` not found — no such workspace.
   - `5` not ready — from `ready` or `up --wait`, it is still starting: poll again.
     From `down --volumes`, it is still there: read the warning, do not retry.
   - `6` gate — an action needs a human decision houston is not authorised to make.
     Never retryable and never auto-approvable: `error.gate.approve_with` is what to ask a
     PERSON to run, not something you may run yourself.
   - `7` create failed — known dead. Stop; do not retry in a loop.
   - `8` conflict — the name or port is taken. Pick another.

   `capabilities.exit_codes` is the whole table, and `capabilities.error_codes` says
   which are advertised.
3. **Never import houston's internals and never scrape human output.**
   Use `--json` on the commands that have it — `capabilities.commands[].json` says
   which, and it is a minority, not all of them: `capabilities`, `cluster`, `doctor`, `down`, `info`, `list`, `ready`, `skill install`, `skill status`, `up` (`capabilities` prints
   JSON without the flag). For the rest (`seed`, `logs`,
   `env`, `backup`, `restore`, `upgrade`, `prune`, `tls-status`, …) the **exit code** is
   the machine-readable part. stdout is the document; anything on stderr is for a
   person.

## The output contract

Every `--json` reply is one envelope:

```json
{"schema":"houston.info.v1","contract":2,"houston_version":"2.1.7",
 "generated_at":"...","ok":true,"data":{...},"warnings":[],"error":null}
```

Only `ready` and `up` stream: NDJSON `houston.event.v1` progress lines first, then exactly
one envelope as the **last line**. Read to the end of the output and parse the last
line, which is the right way to read every reply. A failure is the same envelope with
`ok: false` and `error.code` set; there is always exactly one, even when the failure
was unexpected (its stack trace goes to stderr, never stdout).

`contract` is the wire generation: if you do not recognise it, refuse rather than
guess. New keys may appear in `data` or `warnings`; ignore ones you do not know.
`down --volumes --json` needs `--yes`, because there is nobody to prompt.

## Details by topic

### Presets

`capabilities.presets` lists what this build has: `airgapped`, `default`, `e2ee`, `email`, `ldap`, `livechat`, `oidc`, `s3_minio`, `saml`, `voice`, `webhooks`. A preset starts the side
service, wires Rocket.Chat to it and turns the feature on, so it is ready when you
arrive: an `ldap` workspace has users, an `email` one catches every message Rocket.Chat
sends, a `webhooks` one catches every outgoing integration call and Omnichannel webhook
in a web inbox, `airgapped` has no route to Rocket.Chat Cloud.
`houston presets` prints each
preset's `--set` parameters; `--set users=130000` on `ldap` is the large-directory case.

- `--preset` takes a **name from that list, never a path**.
- **Presets combine:** repeat `--preset` (`--preset ldap --preset email`). Qualify a shared
  parameter with the preset's name (`--set ldap.users=500`). `saml` and `oidc` cannot be
  combined; a conflict between two presets' settings is refused until `--setting`/`--env`
  says which.
- Several instances is `--deployment multi-instance`, not a preset; a preset combines with
  it. `--preset multi-instance` is the old spelling; it still works, and warns.

### E2EE

The `e2ee` preset only sets Rocket.Chat's E2E settings and creates `e2e-alice`, `e2e-bob`
and `e2e-carol` (password = username); keys and E2EE passwords are made in each person's
browser, so you cannot send or read encrypted messages yourself. Options:
`policy=optional|default|enforced` (`enforced` needs 8.8.0 or later and is refused on an
older version), `files=on|off`, `allow_unencrypted=on|off`, `users=on|off`. The browser
must reach Rocket.Chat on localhost or over HTTPS. `data/docs/e2ee.md` has the rest.

### Voice

The `voice` preset creates `voice-alice` and `voice-bob` (password = username) for
Rocket.Chat Voice calls. It needs Rocket.Chat 8.0.0 or later and a licence with the Voice
add-on: without `--license` the workspace boots with a warning and no call button.
`--set sip_integration=on` (Docker only) adds Drachtio and FreeSWITCH wired to Rocket.Chat
and gives the users Voice call extensions 1001 and 1002; dialling 123 reaches FreeSWITCH's echo
test. For browsers on other machines add `--set voip_domain=<this machine's host or IP>`:
houston then opens the call ports on every address (browsers need UDP to it; through a tunnel a
SIP call is answered but keeps ringing, with no audio). `--set pbx=on` (it needs
`sip_integration=on`) adds a lab PBX (Asterisk) on
FreeSWITCH's external profile, with desk phones, ring groups and editable dialplans
(`--set freeswitch_dialplans=edit`), for testing PBX integrations. The option names are the
words Rocket.Chat's settings and rocketchat-compose use, and the GUI labels them the same;
2.1.3's `sip` and `fs_dialplan` still work.
The browser must reach Rocket.Chat on localhost or over HTTPS. `data/docs/voice.md` has the
rest.

### Sample data

A profile contains every kind of room, because what needs checking is rarely in a public
channel alone: channels, teams, discussions, direct messages, threads and reactions.
`standard` is 25 rooms, 431 content messages and 162 thread replies across 20 users.
All profiles include group DMs, files, profiles, reactions, pins, stars and custom emoji.
Repeat `--scenario room-states` (read-only, broadcast and archived rooms) and
`--scenario permissions` (owner, moderator, muted and outside users) when those matter.
Add `--history-days 180` for synthetic historical dates on a managed database; creation
uses `--seed-scenario` and `--seed-history-days` alongside `--seed`. Interrupted runs
resume with the same options or `ready`; uncertain uploads refuse duplicate replay.

Seeding reads everything back and checks it against the plan. **Treat a false, null or
missing result as unproven**; do not infer success from a 2xx write.
`--verify-seed` makes a mismatch fail the command. `seed` has no `--json`, so its exit
code is the answer; afterwards `houston info --name <n> --json` shows `data.seed.ok`.
Seeded users are `alice`, `bob` and so on, each with the username as the password.

### Where it runs

`--runtime` is `docker` (default) or `kubernetes`; `--deployment` is `monolith` or
`multi-instance` on Docker, `microservices` (default) or `monolith` on Kubernetes.
`capabilities.runtimes` lists the legal pairs, and an illegal one is refused before
anything is created.

On Kubernetes: `--context <name>` picks a cluster (and implies `--runtime kubernetes`),
and the workspace records it, so later commands for that workspace go there. Without
one, houston uses its own kind cluster if kind is installed, or else the cluster
`kubectl` points at. `houston doctor --json` names the cluster and what it provides
(`storage`, `ingress`, `loadbalancer`, `metrics`); do not infer those from the
distribution's name.

### What Kubernetes refuses, and why

Each refusal names the reason and the alternative:

- `--fresh`: it means delete this workspace's data, and the Kubernetes path keeps the
  volume. `houston down --name <n> --volumes` does delete it.
- any `env` change: an environment variable is a Helm value there. Use `houston api` for
  a setting.
- `seed --scale`: Docker only. `houston seed` works on both.
- `voice` with `sip_integration=on` or `pbx=on`: Drachtio, FreeSWITCH and the PBX run on Docker
  only. `--preset voice` alone, calls between users, works on both.

`stats` needs metrics-server and says how to install it. Everything else works on both
runtimes.

### HTTPS

On Docker, one shared proxy (the edge) holds ports 80 and 443 for every HTTPS name on the
machine. Rocket.Chat's `ROOT_URL` becomes the HTTPS URL, which is what OAuth and SAML
redirects need, and a preset's own pages (Mailpit, Keycloak, MinIO, phpLDAPadmin) are
served on the same name.

- `--https` is houston's own certificate authority, with no domain and no internet:
  `https://<name>.houston.localhost`, reachable from this machine only. A browser trusts
  it only after `houston trust-ca`, which the person runs once per machine.
- `--domain <host>` gets a Let's Encrypt certificate (`--email` the first time; it is
  remembered). The name must already point at this machine and port 443 must be
  reachable. It is the answer for a phone or another machine, and the admin password is
  then generated.

On Kubernetes, with `--domain`, cert-manager obtains a Let's Encrypt certificate and TLS
ends inside the cluster. Right after a create, a placeholder
certificate means cert-manager has not issued yet, which is normal for a few minutes:
`houston tls-status --name <n>` re-checks (it has no `--json`; exit 1 naming the
ingress controller's placeholder, with the workspace up, is "still coming"). `--https`,
houston's own CA, is refused on a cluster that is not on this machine; `--domain` is the
answer there.

### Cloud clusters cost money, and `up` never creates one

`houston cluster create` takes about twenty minutes and **bills from the first minute
whether or not anything runs in it**; only `houston cluster delete` stops it. `up`
cannot create one, structurally. Before saying nothing is running, run
`houston cluster list --json`: it checks every enabled region, and a region listed under
`unreadable` is NOT covered by the answer. The whole procedure is `houston cluster guide`.

### The record to share

`houston info --name <n> --json` is the record to attach to an issue, a ticket or a pull
request: version, MongoDB pairing,
runtime and deployment, links, and on Kubernetes the namespace and the pods, with the
reason any cannot start. Credentials in its env listing are masked, but `data.login`
carries the admin password, generated for any workspace reachable beyond loopback. Drop it
before attaching: `houston info --name <n> --json | jq 'del(.data.login.password)' > record.json`.

### Tear it down

**Tear down by default.** A workspace costs about 1.1 GB on Docker and more on
Kubernetes, `up` refuses when the machine lacks room, and too many at once can run a
machine out of memory. Remove the workspaces you start for your own checks. A workspace
the person asked for is theirs: leave it running, say so, and give them the command that
removes it.

`--volumes` deletes the data and the record and cannot be undone. Without it the data
is kept, and the same `up` brings the workspace back.

`down --volumes` can **refuse** with exit 5 and a warning, keeping the record, so
`list` still showing the workspace is correct. That 5 means "it is still there, read the
warning", not "poll again". The usual cause is a Kubernetes namespace that will not
finish terminating.

On Kubernetes, `down` leaves the shared cluster running; `houston prune` removes it only
if houston created it and no houston namespace remains.

## When the envelope is not enough

Every command appends to `$HOUSTON_HOME/logs/houston.log` (default
`~/.houston/logs/houston.log`): one JSON object per line, credentials dropped. Each
line carries a `run` id for one command, so `grep '"run":"<id>"'` on that file shows it
from start to end. Use it when `error.code` says what failed and you need when and in
what order. It is for reading, not a contract.

## Things that will bite you

- **The first run is slow.** Images have to be pulled. Do not treat the first duration
  as typical or kill it early.
- **`up` can refuse for capacity.** That is a preflight, not a hiccup: free something
  rather than retrying.
- **Version pairs matter.** houston picks the MongoDB for a Rocket.Chat version. Do not
  override it unless the request names one.
- **Enterprise features need a licence.** A workspace boots without one, so Enterprise-only
  features such as LDAP background sync are missing and their settings answer 400. Say so
  and ask the person for a licence file: `up --license <file>` boots with it, and one can be
  added later in Administration → Subscription, so set up the rest meanwhile.
- **houston does not load an outside database.** `restore` takes only the `.rcbak`
  bundles `houston backup` makes, and a mongodump from another server is not one. Say so,
  and ask before loading someone's data any other way. For a settings export,
  `config-import` takes a support dump's `*-settings.json`.
- **Everything binds `127.0.0.1`** unless told otherwise, because workspaces use weak,
  well-known credentials. Widening that is a decision for a person.

## If this skill is stale

`capabilities.skill.current` is false when a copy that exists does not match the
build, and `houston doctor` names the copy. `capabilities.skill.hosts` names each one and
its scope:

- `user` — `~/.claude/skills/houston/` and `~/.agents/skills/houston/`.
  `houston skill install` writes both, and refuses to overwrite a copy you have edited
  unless you pass `--force`. Upgrading houston does not update them: run
  `houston skill install` after each upgrade.
- `project` — a `.claude/skills/houston/SKILL.md` in the directory you are working in
  or one above it. Claude Code reads a user copy in preference to a project copy of the
  same name, so even inside a checkout a stale user copy is the one in play.

Prefer `capabilities` over this file wherever the two disagree. That one is
generated from the build; this is prose, and prose goes stale.
