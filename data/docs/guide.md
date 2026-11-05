# houston user guide

This guide covers what comes after your first workspace. For installing houston and
starting one, read the [README](../../README.md) first.

Every command also explains itself: `houston <command> --help`.

**Contents:** [Commands at a glance](#commands-at-a-glance) ·
[Everyday lifecycle](#everyday-lifecycle) · [Presets](#presets) ·
[Sample data](#sample-data) · [A customer's settings](#a-customers-settings) ·
[Settings and environment variables](#settings-and-environment-variables) ·
[Backup, restore, upgrade](#backup-restore-upgrade) · [HTTPS](#https) ·
[Monitoring](#monitoring) · [Load testing](#load-testing-and-capacity) ·
[REST API](#rest-api) · [Versions and MongoDB](#versions-and-mongodb) ·
[Where state lives](#where-state-lives)

---

## Commands at a glance

| Group | Commands |
|---|---|
| lifecycle | `up` `start` `stop` `restart` `down` `prune` |
| inspect | `list` `info` `logs` `ready` `stats` |
| settings | `use` `config` `env` |
| data | `seed` `config-import` `backup` `backups` `restore` `upgrade` |
| performance (Docker only) | `loadtest` `capacity` |
| REST | `token` `api` `pat` |
| web GUI and accounts | `serve` `users` `audit` `chown` |
| HTTPS | `edge` `trust-ca` `tls-status` |
| cloud clusters | `cluster` (`cluster overview` for what exists and what it costs; see [EKS](eks.md)) |
| other | `monitor` `presets` `versions` `doctor` `capabilities` `skill` |

---

## Everyday lifecycle

```bash
houston list                          # every workspace: version, MongoDB, runtime, port, state, URL
houston info  --name ticket-1234      # URL, login, links, notes
houston logs  --name ticket-1234 -f   # follow the logs (Ctrl-C to stop)
houston ready --name ticket-1234      # wait until Rocket.Chat is serving
```

A workspace can live as long as the ticket does. Pause and resume it instead of
creating it again:

| Command | What it does |
|---|---|
| `up` | creates a workspace, or brings a stopped one back with its data |
| `stop` / `start` | pauses and resumes it in seconds |
| `restart` | restarts Rocket.Chat |
| `down` | removes the containers but **keeps** the data and the record |
| `down --volumes` | deletes the data too, after asking |
| `prune` | **deletes** every workspace that is `down`, with its data and record, except pinned ones; stopped ones are not touched. An admin's prune covers everyone's |

The commands that delete data ask first, and `prune` lists what it will remove. Add
`--yes` to skip the question in a script.

**`up` on an existing name reuses that workspace exactly as it was.** What you asked for
differently (version, preset, monitoring, port, bind address, `--set`, root URL, image,
MongoDB, HTTPS name, `--replicas`, `--env`, licence, registration token) is named in a warning
and ignored. To try
another version, use `houston upgrade` or pick a new name. `--force` rebuilds the
workspace, and `--fresh` also wipes its data. A rebuild keeps what you leave out: its
deployment, instance count, cluster, admin password, monitoring, `--root-url`, pin and port
(a new port only when something else has taken the old one).

**One workspace you use every day:** create it once with `--pin`, then `stop` and
`start` it. A command without `--name` acts on the pinned workspace, or on the one
`houston use <name>` chose last. That default belongs to the houston home, so on a shared
server it is the same for everyone using it: give `--name` there.

```bash
houston up --version 8.5.1 --name main --pin
houston use ticket-1234        # later commands without --name act on ticket-1234
```

**Remove workspaces you are done with.** Each one uses about 1.1 GB of memory, `up`
refuses when the machine does not have room, and too many at once can run a machine
out of memory.

---

## Presets

A preset adds the service a ticket is about, wires Rocket.Chat to it, and turns the
feature on, so it is ready when you sign in.

```bash
houston presets                                                  # what exists
houston up --version 8.5.1 --name ticket-1234 --preset ldap --wait
```

| Preset | Starts | Use it for |
|---|---|---|
| `default` | Rocket.Chat and MongoDB | anything |
| `airgapped` | no route to Rocket.Chat Cloud | offline or disconnected workspaces |
| `ldap` | OpenLDAP with users and a group | LDAP login and sync |
| `saml` | a Keycloak identity provider (SAML) | SAML single sign-on |
| `oidc` | a Keycloak identity provider (OpenID Connect) | OIDC / OAuth single sign-on |
| `email` | Mailpit, catching every mail Rocket.Chat sends | invites, password resets, verification, 2FA codes |
| `s3_minio` | MinIO as the file-upload store | uploads, previews, presigned URLs |
| `livechat` | Omnichannel, an agent and a demo page with the widget | the widget, CORS, routing |
| `e2ee` | end-to-end encryption switched on, and three test users | encrypted DMs, rooms and files ([guide](e2ee.md)) |
| `voice` | two test users for Voice calls; `sip_integration=on` adds Drachtio and FreeSWITCH; `pbx=on` a lab PBX | calls between users, the SIP integration, PBX calls ([guide](voice.md)) |
| `webhooks` | a web inbox (webhook-tester) every outgoing integration call and Omnichannel webhook lands in, and two sample integrations | integrations, webhooks and their scripts; a customer dump's real endpoints (`--set capture=all`) ([below](#webhooks)) |

For `ldap`, `saml` and `oidc`, sign in as **`user1` / `user1`**. `houston info` lists
each preset's consoles and logins.

Those consoles prefer these ports on this machine: phpLDAPadmin 8082, Mailpit 8025,
Keycloak 8081 or 8085, MinIO 9000 and 9001, the livechat demo 8090, the webhook inbox
8086. The first workspace
with a preset gets them. Another workspace with the same preset, yours or a colleague's,
gets the next free port, and keeps it through stop, start, `up --force` and upgrade. If
something else took that port while the workspace was stopped, `up --force` moves it to a
free one and says so. `houston info` and the GUI give each workspace's own addresses.
Monitoring turned off and on again takes whichever pair is free then. A workspace that is only
`down` still holds its ports, because it comes back on them. Voice is the exception: its
call ports are dialled by number, so one machine runs one voice workspace.

Two consoles on `localhost` with different ports share the browser's cookies, so signing in
to one workspace's Keycloak or Grafana can sign you out of another's. Use a private window
for the second, as you would for two Rocket.Chat workspaces.

Presets take parameters with `--set key=value`. `houston presets` prints each one's
parameters and defaults:

```bash
houston up --version 8.5.1 --name big-ldap --preset ldap --set users=130000   # a large directory
houston up --version 8.5.1 --name groups --preset ldap --set groups=on       # group-restricted login, role and channel sync
houston up --version 8.5.1 --name svc --preset ldap --set bind=service       # a read-only bind, limited to 500 entries
houston up --version 8.5.1 --name tls --preset ldap --set tls=ldaps           # LDAPS, houston's CA trusted
houston up --version 8.5.1 --name bad --preset ldap --set tls=ldaps --set trust=none   # the certificate error
houston up --version 8.5.1 --name ad --preset ldap --set directory=ad --set groups=on  # Active Directory (Samba): sAMAccountName, objectGUID, nested groups
houston up --version 8.5.1 --name sso --preset ldap --set idp=saml --set mfa=on       # SSO through Keycloak, backed by the same directory, with a one-time code
houston up --version 8.5.1 --name mail --preset email --seed --wait            # users with mail
houston up --version 8.5.1 --name s3 --preset s3_minio --set presigned=true
```

Things to know:

- **Presets combine.** Give `--preset` more than once:

  ```bash
  houston up --version 8.5.1 --name ticket-1234 --preset ldap --preset email --wait
  ```

  Directory users then get email two-factor codes in Mailpit. Order does not matter: the
  workspace is recorded as `email+ldap`. When two presets set the same thing, a default
  gives way: `ldap` turns email 2FA off only because there is no mail server, and `email`
  turns it on. Two values neither presets treat as a default are refused until you choose
  one with `--setting` or `--env`. `saml` and `oidc` each run their own Keycloak and cannot
  be combined yet.
- **Parameters of combined presets** take the preset's name, `--set ldap.users=500`; a
  single preset accepts that spelling too. A plain `--set users=500` works when only one
  of the presets takes `users`.
- **A directory and an SSO preset are two user stores.** With `ldap` and `saml` (or `oidc`),
  directory users are `user1..N` and Keycloak users are `sso-user1..N`
  (`sso-user1@example.com`), so neither login lands in the other's account.
- **`up --force` with no `--preset`** keeps a combined workspace's presets, and on
  Kubernetes any workspace's preset. To change them on Kubernetes, `down --volumes` first.
- **`oidc` needs a hosts entry:** add `127.0.0.1  keycloak` to `/etc/hosts`. Your
  browser and Rocket.Chat must resolve the login URL the same way. `up` and `info`
  print this reminder.
- **Several Rocket.Chat instances is a deployment, not a preset.** Use
  `--deployment multi-instance --replicas 3` on Docker. It starts the instances behind
  a load balancer, with NATS and one MongoDB. The old spelling, `--preset
  multi-instance`, still works and prints a hint. A preset combines with it: every
  instance gets the preset's settings. Messages reach the other instances live only
  with an Enterprise license, Rocket.Chat's scalability module; without one they show
  after a reload.

### Webhooks

`--preset webhooks` starts a web inbox for HTTP requests (webhook-tester) and wires
Rocket.Chat to it: a `houston-outgoing` integration posts every public-channel message
there, a `houston-incoming` integration takes POSTs into `#general` (`houston info` prints
its URL and a curl to paste), and the Omnichannel webhook points at it with the token
`houston`, so with `--preset livechat` every chat event lands there too. Post a message,
open the inbox, read the request. The inbox answers 200 with `{"captured": true}`, which
Rocket.Chat reads as success; for a failing or slow endpoint click `New URL` in its UI, set
a 500 or a delay, untick `Destroy current session` (or houston's inbox goes with it) and
paste the new URL into the integration with the host replaced by `webhooks:8080` (the inbox
UI says `localhost`; Rocket.Chat reaches it inside the workspace network). Admin →
Workspace → Integrations →
History shows each call Rocket.Chat made and what came back, from any machine.

The inbox UI is on the machine running houston only (`http://localhost:8086/s/…`): it is a
single-page app with absolute paths that would collide with Rocket.Chat's, so it is not
served under the HTTPS name. From elsewhere, `ssh -L 8086:127.0.0.1:8086 <host>`, or
`--bind`. It keeps the last 128 requests on disk: stop, start, restart, upgrade and
`up --force` keep them; `down --volumes` removes them. An inbox idle for 31 days loses its
session; `houston ready` makes a new one.

A restored customer backup keeps posting to the customer's real services. `--set
capture=all` repoints every outgoing integration, and the Omnichannel webhook, at the
inbox and lists the original URLs under Webhooks in `houston info`; each repointed URL
keeps the original in its `?from=` query, so the inbox shows where a call was bound. From
Rocket.Chat 9.0.0 integration scripts run as written (strict mode): one saved earlier keeps
working until it is edited and saved again, which a repoint is; the docs' Script
compatibility section says what to change.

### Your own presets

Put a YAML file at `~/.houston/presets/<name>.yaml`. It replaces a built-in preset of
the same name. `--preset` always takes a name, never a path.

```yaml
name: my-scenario
description: What this reproduces.
env:
  OVERWRITE_SETTING_Some_Setting: "true"
services:
  my-sidecar: { image: some/image:tag }
depends_on: [my-sidecar]
```

**Treat preset files like code.** They can start any container and mount files.

### Enterprise licences

Pass a Rocket.Chat Cloud registration token. The workspace registers itself on first
boot and Cloud sends the licence down.

```bash
houston up --version 8.5.1 --name ee --reg-token <token> --wait
```

To stop typing it, put `reg_token:` in `~/.houston/config.yaml` or export
`HOUSTON_REG_TOKEN`. **A registration token is a real licence.** Never paste one into a
support case.

Or hand it the licence itself, from a file or from stdin, never on the command line:

```bash
houston up --version 8.5.1 --name ee --license ./licence.txt --wait
pbpaste | houston up --version 8.5.1 --name ee --license - --wait
```

On Docker it goes into `.license.env` in the workspace (mode 0600), which the compose file
names and never holds; on Kubernetes into a Secret the pod reads it from. `env`, the GUI and
`houston.log` never show it; backups leave it out, and `up --force` keeps it.

Rocket.Chat 8.8 and 8.9 announce that LDAP, SAML and Custom OAuth login will need a Premium
plan from 9.0. On Rocket.Chat 9 and later, `up` warns when an `ldap`, `saml` or `oidc`
workspace has neither `--license` nor `--reg-token`.

---

## Sample data

`--seed` adds realistic conversations through Rocket.Chat's REST API, then reads the
latest batch back by identity. Both CLI and GUI use the same plans and executor.

```bash
houston up --version 8.5.1 --name ticket-1234 --seed --seed-profile standard --verify-seed
houston seed --name ticket-1234 --profile large --verify-seed
houston seed --name ticket-1234 --users 30 --channels 10 --messages 40
houston seed --name ticket-1234 --profile small --scenario room-states --scenario permissions --history-days 180 --verify-seed
```

| Profile | Users | Rooms | Main messages | Thread replies | Files | Total content |
|---|---|---|---|---|---|---|
| `small` (default) | 5 | 12 | 38 | 24 | 4 | 68 |
| `standard` | 20 | 25 | 253 | 162 | 12 | 431 |
| `large` | 100 | 60 | 2620 | 2620 | 24 | 5270 |

Total content includes file messages and the opening messages of newly created
discussions. The existing `messages` summary counts main messages plus thread
replies; `threads` counts replies. On a repeat, existing discussions gain no new
opening messages: ordinary totals are 66, 427 and 5264. Users, rooms and custom
assets are reused; each completed invocation appends a fresh conversation batch.
`--messages` overrides the number per public channel, including General. Derived
room kinds retain their minima. Zero users explicitly uses the administrator for
content; reduced participant sets omit conversations that need more people.

All profiles include public/private channels, teams and their child channels,
discussions, DMs and group DMs. Conversations include markdown, code, Unicode and
predictable `INC-4821` search text, varied replies, reactions by other participants,
pins, personal stars, mentions, edited messages and custom emoji. Bundled PNG,
text, CSV and PDF files can be previewed or downloaded. New sample users receive
names, avatars and bios; passwords are their usernames (`alice`, `bob`, and so on).
Existing profile values and nonempty room metadata are preserved.
Objects from an older seed can be adopted only when a successful saved seed result
and their actual authorship establish provenance. An unrelated name collision is
reported instead of changing that object.

`--scenario room-states` adds readonly, broadcast and archived channels.
`--scenario permissions` adds a private room with Alice as owner, Bob as moderator,
Carol muted and Dave outside; it needs at least four sample users. Both scenarios
add four rooms, 20 main messages and four pins. Repeat `--scenario` to combine them.
On creation, use `--seed-scenario` and `--seed-history-days` alongside `--seed`.
These options cannot be combined with `--scale` or `--clear-scale`.

`--history-days 180` spreads this batch over the preceding 180 days with one saved
UTC reference. History is optional (1–36500 days); omitting it retains current
timestamps. Parent/reply order, copied discussion dates, file dates, thread activity
and room latest-message summaries are reconciled, including copied dates in new
pin notifications. Pin and edit action dates remain current. Existing message dates are never
changed. Reused discussion anchors remain intact and may narrow that room's range;
the result reports those constraints. Dates are synthetic: REST notifications and
hooks still run now. Refresh or sign in with a fresh client to read the adjusted dates.
Native date search uses `after:DD/MM/YYYY before:DD/MM/YYYY`.

History needs writable access to the workspace's managed MongoDB on Docker or
Kubernetes. Houston checks all live Rocket.Chat instances' `MONGO_URL` values and
refuses an external, inaccessible or ambiguous target before creating content.
SCRAM credentials and custom database names are read from the live configuration;
credentials are never put in command arguments or seed receipts.

A durable receipt records exact identities before and after writes. If interrupted,
repeat the same options or run `houston ready --name ticket-1234`; the original run
and historical reference are resumed. An unidentified upload or an ambiguous media
confirmation is refused rather than creating duplicates. Keep the receipt to
investigate that refusal; do not delete it and replay the batch.
Historical adjustment starts only after API creation completes. Its saved timeline
must cover every captured content record and related notice; an incomplete saved
timeline is a failure, and its selected dates are never silently expanded or replaced.
Results show planned and read feature counts, the effective date range, and room
locations with the accounts whose personal Stars panels contain the examples.

Email 2FA and the REST rate limiter are restored to their original values on exit.
Only newly created sample accounts have personal email 2FA disabled for their fixed
sample login. Existing accounts' security settings are preserved. Fresh workspaces
use the safe API query default required by the custom-emoji client; an existing
workspace that explicitly enables unsafe query parameters retains that setting and
may need its configuration corrected for native custom emoji to load.

**Check the result.** `verification.ok` is true only after complete readback, false
for a confirmed mismatch and null when a check is unreadable. `--verify-seed` accepts
only true. `seed` has no `--json`; its exit code is the strict gate, and
`houston info --name ticket-1234 --json` exposes the saved result at `data.seed.ok`.

### Large volumes

For "50k users" or "a room with 800k messages will not load", `--scale` writes
straight into MongoDB:

```bash
houston seed --name ticket-1234 --scale users=50000,messages=800000@general
houston seed --name ticket-1234 --clear-scale    # removes exactly what --scale added
```

These rows skip Rocket.Chat's own hooks: scale users cannot log in and scale messages
send no notifications. Use `--scale` for how Rocket.Chat behaves at volume, and the
normal seed for how a feature behaves. `--scale` works on Docker workspaces only.

---

## A customer's settings

Load the settings export from a customer's support dump:

```bash
houston config-import ./8.5.0-settings.json --name ticket-1234 --dry-run   # see what would change
houston config-import ./8.5.0-settings.json --name ticket-1234 --only Livechat,LDAP
```

It skips redacted secrets and lists them, so you can set them by hand. It also skips
settings that would break a local workspace, such as `Site_Url`,
`Enterprise_License`, `Assets_*` and the cloud registration.

---

## Settings and environment variables

```bash
houston env --name ticket-1234                                   # the effective environment, secrets masked
houston env --name ticket-1234 --setting Message_AllowEditing=false   # a Rocket.Chat setting
houston env --name ticket-1234 --set MY_FLAG=true                # a plain environment variable
houston env --name ticket-1234 --unset MY_FLAG
```

Most Rocket.Chat configuration is a **setting**, the thing you change in the admin
UI. From the environment, a setting only takes effect with the `OVERWRITE_SETTING_`
prefix, and without it Rocket.Chat ignores the variable silently:

| Environment variable | Effect on `Accounts_ShowFormLogin` |
|---|---|
| `Accounts_ShowFormLogin=false` | none |
| `OVERWRITE_SETTING_Accounts_ShowFormLogin=false` | applied |

`--setting Id=value` adds the prefix for you. `--set` is for real environment
variables; give it a setting's name and houston points you to the prefixed form.

- An `OVERWRITE_SETTING_` value is applied at every boot. The admin UI can still change
  it while Rocket.Chat runs, and the next restart puts it back.
- A change recreates only the Rocket.Chat container. MongoDB keeps running.
  `--no-restart` saves the change without applying it; re-run the same `houston env`
  without it to apply it.
- Your overrides are kept with the workspace and win over the preset's.
- You may override `MONGO_URL`, `PORT`, `ROOT_URL` or `TRANSPORTER` to reproduce a
  broken configuration. houston warns what each one will break.

Changing the environment works on Docker workspaces. On Kubernetes, `env` only reads;
see the [Kubernetes guide](kubernetes.md#what-kubernetes-refuses).

---

## Backup, restore, upgrade

```bash
houston backup  --name ticket-1234 --label "before upgrade"   # writes ~/.houston/backups/<file>.rcbak
houston backups                                               # list the backups
houston restore <bundle> --new                                # rebuild the whole workspace from one file
houston upgrade --name ticket-1234 --to 8.6.1                 # backs up first
houston upgrade --name ticket-1234 --rollback
```

- **A backup is a bundle:** the database plus the version, preset and parameters that
  produced it. One file rebuilds the workspace, on your machine or a colleague's.
- Rocket.Chat is stopped while a backup is taken, so the dump is consistent. `--live`
  skips the stop.
- A restore replaces the target database completely. `--new` restores into a new
  workspace instead. The copy comes up on this machine (loopback), without the source's
  HTTPS name and without its registration token, which a bundle never carries; give it
  `--domain` or `--https` again if it needs one.
- Restoring newer data into an older version is refused. Older into newer needs
  `--allow-upgrade`.
- A backup does not include the side services' data: MinIO files, Keycloak realms,
  LDAP entries or Mailpit mail.
- `upgrade` needs the workspace running, because Rocket.Chat migrates its database when
  it starts. `--dry-run` shows the plan without changing anything.
- An upgrade keeps the workspace's MongoDB when the new Rocket.Chat still runs on it, as
  7.13 runs on 7.0. One that needs a new major MongoDB version is refused: MongoDB majors
  have to be upgraded one step at a time. To carry the data across, `houston backup`, then
  `houston up` the new version under a new name, then `houston restore <bundle> --name
  <new name> --allow-upgrade`. `upgrade --force` moves Rocket.Chat only.

---

## HTTPS

This section is about Docker workspaces. For Kubernetes, see
[HTTPS on a cluster](kubernetes.md#https-on-a-cluster).

On Docker, one shared Traefik proxy, the **edge**, holds ports 80 and 443 and serves
every HTTPS name on the machine. It starts with the first workspace that needs it.

```bash
# A real name, with a Let's Encrypt certificate. The name must point at this machine; under
# a wildcard DNS record (*.example.com) that already does, any name works with no DNS change.
houston up --version 8.5.1 --name ticket-1234 --domain t1234.example.com --email you@example.com

# No domain and no internet: houston's own certificate authority, for a browser on this machine.
houston trust-ca                                              # once per machine
houston up --version 8.5.1 --name ticket-1234 --https         # https://ticket-1234.houston.localhost
```

The email is remembered (`houston config set acme.email <address>`). It is the contact for
the `--domain` certificate, so `--email` without a name is refused; `--https` needs none.
Rocket.Chat's
`ROOT_URL` becomes the HTTPS URL, which is what OAuth and SAML redirects need.

A preset's own pages are served on the same name and certificate, on both runtimes, so
they work from any browser, not only on this machine:

| Path | What |
|---|---|
| `/mailpit/` | Mailpit, every email Rocket.Chat sends (`email`) |
| `/keycloak/` | Keycloak, for sign-in and its admin console (`saml`, `oidc`, ldap's `idp`). SSO needs no `idp_host` and no hosts entry. |
| `/livechat-demo/` | the livechat demo page. It is the same origin as Rocket.Chat there, so cross-origin problems (CORS, framing) show only on its own port. |
| `/minio/` | the MinIO console, to watch uploads land in the bucket (`s3_minio`) |
| `/phpldapadmin/` | phpLDAPadmin, to browse and edit the directory (`ldap`, OpenLDAP and AD) |

`houston info` and the GUI link to them. Grafana is at `/grafana/` (see [Monitoring](#monitoring)).
The `webhooks` inbox has no path here: it answers only on its own port on the machine
running houston (see [Webhooks](#webhooks)).

```bash
houston edge status              # is it running, which names, can it reach each one
houston edge stop                # frees ports 80 and 443: every HTTPS workspace goes offline
houston tls-status --name ticket-1234
```

While the edge is stopped, every HTTPS name on the machine is unreachable, so `doctor`
reports a stopped edge as a failure when a workspace or the GUI's name uses it (and as
fine when nothing does). A route the edge cannot reach answers **502**, and
`edge status` shows which.

**Wildcard certificates (dns-01):** put your DNS provider's credentials in
`~/.houston/acme/dns.env` and houston uses the dns-01 challenge automatically:

```bash
mkdir -p ~/.houston/acme && chmod 700 ~/.houston/acme
printf 'CF_DNS_API_TOKEN=%s\n' "$TOKEN" > ~/.houston/acme/dns.env
chmod 600 ~/.houston/acme/dns.env
```

A `--domain` workspace can be reached by anyone who can reach that name, so houston
gives it a generated admin password instead of `admin123`, as it does for a workspace
bound beyond this machine (`--bind 0.0.0.0`). `houston info` shows it. A workspace made
on this machine alone and brought back public keeps `admin123`, because Rocket.Chat sets
the password only on an empty database; `up` says so.

---

## Monitoring

Prometheus, Grafana and Loki on top of any workspace:

```bash
houston up --version 8.5.1 --name ticket-1234 --monitor
houston monitor --name ticket-1234          # or add it later, without restarting Rocket.Chat
houston monitor --name ticket-1234 --off
```

- **Grafana** on a Docker loopback workspace is at `http://localhost:5050` (`admin` / `admin`, anonymous Viewer on),
  with the Rocket.Chat, MongoDB and Node Exporter dashboards.
- **Prometheus** is at `http://localhost:9090`.
- Another monitored workspace gets the next free pair, such as 5051 and 9091. `houston info`
  and the GUI give each workspace's own Grafana.
- Container logs go to **Loki**, readable in the *Rocket.Chat Logs* dashboard.

On Docker, log collection covers only that workspace. On Kubernetes, one shared stack
runs in the `houston-system` namespace, and `--off` leaves it running while another
workspace still uses it.

With houston-served HTTPS (`--domain` or `--https`), both runtimes serve Grafana at
`https://<workspace-host>/grafana/`. `info` and the GUI report that URL, including
the Logs link and the live load-test dashboard. The login remains `admin/admin`
on this public name; anonymous users can view dashboards.

Kubernetes loopback forwards serve `http://localhost:5050/grafana/`, and the next free port
for each further monitored workspace. That Grafana is one per cluster, and it builds its
own absolute links (sign-in redirects, share links) on 5050. Every monitored
HTTPS workspace has its own Ingress into the shared stack. Under ACME this requests
an extra certificate per workspace. Absolute Grafana links name the first public
host configured for the stack; other workspace hosts serve the same relative paths.
Upgrading an older stack to this path restarts Grafana; anyone using an existing
port-forward must run `houston monitor --name <name>` again on their own box.

A bare `--root-url` uses the local Grafana URL; a customer proxy must route `/grafana` to Grafana and configure its sub-path.

---

## Load testing and capacity

**Docker workspaces only.** On Kubernetes the traffic would go through one
`kubectl port-forward`, which saturates long before Rocket.Chat does, so the numbers
would measure the forward.

```bash
houston loadtest --name ticket-1234 --scenario journey --vus 50 --duration 60s
houston loadtest --name ticket-1234 --scenario custom --endpoint "GET /api/v1/channels.list?count=100"
houston loadtest --name ticket-1234 --scenario journey --save before-fix
houston loadtest --name ticket-1234 --scenario journey --compare before-fix
houston capacity --name ticket-1234 --slo "p95=300ms,error=2%"
```

The load comes from [k6](https://k6.io), run as a temporary container on the
workspace's own network.

- **Scenarios:** `journey` (a whole session, each step timed), `messages`, `login`,
  `read`, `mixed`, `webhook`, `badbot` and `custom`.
- **Shapes:** a constant `--vus`, `--ramp 10:200`, or `--spike 10:100`, which reports
  how long p95 took to recover. `--stats` on a long run reports memory growth per
  hour, the sign of a leak.
- **The customer's hardware:** `--constrain "rc=2cpu/2g,mongo=1cpu/1g"` limits the
  services for the run and puts back what they had afterwards. Docker cannot clear a limit, so
  a service that had none is given this machine's whole capacity, which is the same thing. A
  memory cap below what a service already uses is refused: the kernel would restart it as the
  test began, and the run would measure the restart.
- **`--slo p95=300ms,error=1%`** makes the command fail when the target is missed, so it
  fits in CI.
- **Diagnosis is on by default:** Rocket.Chat's event-loop lag, MongoDB's slow queries
  with their plans (it flags `COLLSCAN`), and when errors started, ending in a
  plain-language verdict.

`capacity` doubles the load until the target breaks, narrows down where, and says why.

**VUs are k6 workers, not Rocket.Chat accounts.** Write scenarios leave real messages
in `#general`; `read` and `login` add nothing.

---

## REST API

```bash
houston token --name ticket-1234                    # auth headers for curl
houston api   --name ticket-1234 GET /api/v1/me
houston api   --name ticket-1234 --pat POST /api/v1/users.update -d '{"userId":"ID","data":{"name":"X"}}'
houston api   --name ticket-1234 --2fa POST /api/v1/settings/Message_AllowEditing -d '{"value":false}'
houston pat   --name ticket-1234                    # create a Personal Access Token
```

`--pat` calls the API the way a customer's Personal Access Token would (with "Ignore
2FA"). `--2fa` gets past an admin endpoint that asks for two-factor authentication.
The web GUI has the same console.

---

## Versions and MongoDB

`houston up --version X` asks `releases.rocket.chat/<version>/info`, Rocket.Chat's own
compatibility data, and picks the newest supported MongoDB. When that is unreachable,
or for a release older than that data, it uses the list shipped with houston.
`--offline` always uses the shipped list.

```bash
houston versions 8.5.1        # which MongoDB houston would pair with 8.5.1, and why
```

Give full versions such as `8.5.1`. MongoDB 8 and newer runs the
`mongodb/mongodb-community-server` image; older MongoDB runs `bitnamilegacy/mongodb`.

### Unreleased builds

`--version` also takes a CI build of Rocket.Chat, pulled from `ghcr.io/rocketchat/rocket.chat`:
`develop`, `pr-<number>`, either with `-fips` or `-cov`, and `-gha-run-<id>` for one run's
build rather than the latest.

```bash
houston versions pr-42617                                  # its version and MongoDB pairing
houston up --version pr-42617 --name pr-42617 --wait       # the pull request's build
houston up --version develop-fips --name fips --wait       # FIPS: amd64 only
```

The build's version comes from that branch's `apps/meteor/package.json` on GitHub, so this
needs the network. It is recorded as `8.10.0.dev0` for `8.10.0-develop`, which sorts below
the release, and MongoDB is paired as for that release. Moving to the release later is an
`upgrade`. Offline, or for a build GitHub does not know, `up` stops and names the way round:
`--rc-image ghcr.io/rocketchat/rocket.chat:<tag> --version <x.y.z>`. On a shared GUI a build
version is limited to admins under `gui.create_policy admin`, as `rc_image` is.

---

## Where state lives

Everything houston keeps is under `~/.houston`. Set `HOUSTON_HOME` to use another
directory.

```
~/.houston/
├── IMPLEMENTATION            # which houston versions may use this directory
├── config.yaml               # your defaults: bind_host, reg_token, acme.email, GUI policies
├── users  sessions           # web GUI accounts and sign-ins (mode 0600)
├── sso.env                   # the Okta client secret (mode 0600), if Okta sign-in is on
├── sso-identities.json       # which houston account each Okta person signs in as
├── first-run                 # the web GUI's one-time setup key, until the first account exists
├── audit.log                 # who did what
├── logs/houston.log          # one start and one end line for every command
├── locks/  journal/          # houston's own bookkeeping; leave them alone
├── presets/                  # your own presets
├── backups/                  # backup bundles
├── reports/  loadtests/      # load-test reports and saved runs
├── acme/  edge/              # HTTPS: certificate state, the edge and its routes
├── clients/kubernetes/       # houston's own kubeconfig, never your ~/.kube/config
├── clusters/<name>/          # a cloud cluster houston built, and its kubeconfig
└── repros/<name>/
    ├── docker-compose.yml    # generated: run `up` again instead of editing it
    ├── repro.json            # the workspace record: version, runtime, ports, seed result, notes
    └── seed-receipts/        # durable seed manifests and write-ahead logs
```

**Every command writes to `logs/houston.log`**, even `--help` and `--version`. When you
experiment or script against houston, point it at a throwaway directory first:

```bash
export HOUSTON_HOME=$(mktemp -d)
```

Settings can also come from the environment, which wins over `config.yaml`:
`HOUSTON_HOME`, `HOUSTON_REG_TOKEN`, `HOUSTON_RC_IMAGE`, `HOUSTON_BIND_HOST` (the
`--bind` flag wins over both) and `HOUSTON_KUBE_CONTEXT`. `HOUSTON_SSO_CLIENT_SECRET` is
the Okta client secret, and wins over `sso.env`; see
[Sign in with Okta](gui.md#sign-in-with-okta).
