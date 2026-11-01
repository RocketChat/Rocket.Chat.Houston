# Troubleshooting

Find the symptom, then the fix. **Start with `houston doctor`:** it checks the machine and
names most of what follows. On EKS, see [the EKS guide's list](eks.md#when-it-goes-wrong);
for what Kubernetes refuses, see [the Kubernetes guide](kubernetes.md#what-kubernetes-refuses).

**Contents:** [Installing](#installing) · [A workspace will not start](#a-workspace-will-not-start) ·
[Kubernetes](#kubernetes) · [HTTPS and certificates](#https-and-certificates) ·
[Left running](#left-running) · [The web GUI](#the-web-gui) ·
[Engines and images](#engines-and-images)

---

## Installing

| You see | Do this |
|---|---|
| `houston --version` prints someone else's version | Another npm package also installs `houston`. `command -v houston` shows which runs; uninstall the other or reorder your `PATH`. |
| An old houston still runs after installing 2.x | It was installed with pipx. See [Upgrading](upgrading.md#replacing-an-older-install). |
| Behind a proxy, `houston versions` uses the shipped list | Run `houston` (or `bin/houston`), not `node` directly: the launcher passes `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and `REQUESTS_CA_BUNDLE` to Node. |

## A workspace will not start

`up` refuses before it builds anything, and the refusal names the fix:

| It says | Do this |
|---|---|
| something about **memory** | Stop one of your own running workspaces (`houston stop --name <name>` keeps its data), or remove one you are done with: `houston down --name <name> --volumes`. The message names each workspace's owner: ask before stopping a colleague's. |
| a **port** is in use | Pass `--port`, or leave it out and houston picks a free one. |
| "publishes port(s) …, already claimed by workspace '<name>'" | Those ports cannot move: voice's call ports, which phones dial by number, or ports a preset file of your own lists. `<name>` holds them, even while it is only `down`, so one such workspace fits on a machine. The message names its owner: they free the ports with `houston down --name <name> --volumes` (its data goes too). Ask them rather than deleting a colleague's workspace, or use another machine. A built-in preset's consoles never refuse: they get the next free port. |
| the **Docker daemon** is not running | Start Docker Desktop, or `sudo systemctl start docker`. |
| "already exists and is reused as-is" | `up` brings back the existing workspace. `--force` rebuilds it, `--fresh` also wipes its data; `houston upgrade` changes the version. |
| "is already a Docker Compose workspace" (or "a Kubernetes workspace") | The name, typed or derived from the version, belongs to a workspace on the other runtime, and one name is one workspace. Give the new one its own name, or delete the old one first with `houston down --name <name> --volumes`. |
| "was made after this backup" | `restore <bundle>` without `--name` goes back to the workspace the bundle came from, and the one holding that name now is newer. `--new` brings the backup back as its own workspace; `--name <name>` replaces that newer workspace's data anyway. |
| "runs Rocket.Chat X, and this asks for Y" (Kubernetes) | `up` brings a Kubernetes workspace back at its own version. Use `--version X`, or `houston upgrade --name <name> --to Y` to move it. |
| "already holds a MongoDB for '<name>'" | Another houston on this machine left that workspace's data (`sudo houston` uses root's settings, not yours), or this one lost its record of it. Give the new one its own `--name`. Remove the volume the message names only if nobody needs that data. |
| "is not the workspace this backup was taken from" | The workspace with the bundle's name now is a different one: it was made at another time. `restore <bundle> --new` brings the backup back as its own workspace; `--name <name>` replaces that workspace's data anyway. |
| "could not ask Docker whether another houston home left a MongoDB" | Docker did not answer in time, and houston will not guess about someone else's data. Check `docker volume ls` answers, then run `up` again. |
| "could mean '<name>' … or your own '<you>-<name>'" | Two workspaces answer to what you typed. Type the full name for yours; the other one is reached from the GUI, or from a command run without `HOUSTON_USER`. |
| a Docker Hub pull limit | Run `docker login`. |
| "Unit docker-….scope was already loaded or has a fragment file" | systemd still holds the unit of the containers' last run. houston recreates them when it sees this, data kept; if it still shows, `houston down --name <name>` keeps the data, then bring the workspace up again. Out-of-memory kills leave such units behind: `journalctl -k \| grep -i oom`. |

It starts but Rocket.Chat never answers:

```bash
houston logs  --name <name> --tail 100
houston stats --name <name>          # a climbing restart count means it is out of memory
```

## Rocket.Chat's own behaviour, not houston's

Seen on Rocket.Chat 8.5.1, and the same with or without houston's edge in front:

- **A sign-in page left idle for about a minute says "You're offline."** Its websocket
  closes at ~61 s, so an SSO round trip that takes longer than that (a slow IdP, a person
  reading the Keycloak page) comes back to it. Reload and sign in again.
- **SAML with email two-factor on:** Rocket.Chat refuses the emailed code, so the sign-in
  cannot finish. `up` warns about this combination; turn email two-factor off with
  `--setting Accounts_TwoFactorAuthentication_By_Email_Enabled=false`.
- **Multi-instance:** `instances.get` keeps an instance a restart replaced for a while, so
  the count runs high after restarts.
- **After `restore --new`:** the admin is shown "Unique ID change detected", because the
  database now lives at a new address. Either answer is fine for a test copy.
- **E2EE, a new room's key sticks on one client**: that person sees "Check back later"
  or cannot read the others. Reload their page. More in the [E2EE guide](e2ee.md).

## Kubernetes

| You see | Do this |
|---|---|
| `up` worked but the URL does nothing | The port-forward stopped, usually with its pod but occasionally while the pods stay healthy; `list` and `info` show the workspace as degraded. `houston ready --name <name>` starts it again. "something else already holds it": `ss -ltnp \| grep <port>` names the program. |
| "no kubeconfig context named" | Add the cluster: `houston cluster connect <arn>` for EKS, or fix your kubeconfig. |
| kubectl works but helm says "cluster unreachable" | A stale kubeconfig. Regenerate it (k3s: `sudo cat /etc/rancher/k3s/k3s.yaml > ~/.kube/config`; kind: `kind export kubeconfig --name <cluster>`). |
| Every volume stays `Pending` | No default StorageClass: `houston cluster prepare --context <cluster>`. |
| A colleague gets "access denied" or `Unauthorized` | On a cluster houston built: `houston cluster share <cluster> --user <their-iam-user>`. Otherwise its owner adds an EKS access entry. |
| "no matching manifest for linux/arm64" | Rocket.Chat below 8.0.0 is amd64 only: use an amd64 node, 8.0.0 or newer, or Docker. |
| "no chart deploys it" or "predates every values key houston sets" | Rocket.Chat below 3.7.2: use Docker. |
| `env --set`, `seed --scale`, `loadtest` or `capacity` refuses | Docker only. The refusal names what to use instead. |
| "was made by another houston home on this cluster", or "this houston has no record of it" | Each houston marks the namespaces it makes, and one of the same name from another machine or another user is not yours to take over or delete. Use another `--name`. If it really is this one's (made before 2.1.2, its record lost), run the `kubectl label namespace …` the message gives, then `up` again. |
| "keeps its data in a MongoDB houston runs itself, and this would bring it back under the MongoDB operator" | Bring it back as it was: without `--mongo-operator`, and with `HOUSTON_MONGO_OPERATOR` unset. To move it to the operator, back it up, `down --volumes`, then `restore --new` with the operator. |
| "could not mark namespace … as using the shared monitoring stack" | Monitoring was not attached: without that mark another workspace's teardown could remove the stack. Fix the account's right to label namespaces, then `houston monitor --name <name>` again. |
| `prune --orphans` leaves a namespace "not marked as made by this houston home" | It may be another houston's workspace. `--force` removes it anyway. |
| "has a different UID from this workspace's record" on `start`, `backup`, `restore` or `upgrade` | The namespace was deleted and made again since this workspace was created, perhaps by another houston, so this workspace's own is gone and houston will not act on the new one, `down` included. Once you have checked whose it is, remove the stale record by hand: `rm -r ~/.houston/repros/<name>` (or under your `HOUSTON_HOME`). |
| "home-id does not hold this home's id" | The file that tells this houston from others on a cluster is damaged. Put the id back (`kubectl get namespaces -L houston.io/home` shows the ids in use), or delete the file to start a new one and label this home's namespaces with it, as the message shows. |
| "could not read … home-id" | Not damage: usually a `sudo houston` left it owned by root. Fix its owner or permissions; do not delete it, or this home's namespaces read as another home's. |
| "is already served for workspace '<other>' by its cluster's ingress" | On a cluster that serves HTTPS itself (EKS with no edge here), two workspaces cannot share a `--domain`. Give this one another name, or `houston down --name <other>` first. |

Names are lowercase: `TICKET-1234` lives in namespace `houston-ticket-1234`.

## HTTPS and certificates

| You see | Do this |
|---|---|
| "the ingress controller's built-in placeholder certificate" | Normal for a minute or three on a new cluster. `houston tls-status --name <name>` again; `kubectl -n houston-<name> get certificate` shows what it waits for. |
| Let's Encrypt never validates | The name must point at the right place, port 443 open, **before** `up`. On a cloud cluster, point it at the address `houston cluster prepare --context <cluster>` prints. On Cloudflare use **DNS only**. Check with `dig +short <name> @1.1.1.1`. |
| "something in front is terminating TLS for this name" | A proxy, CDN or another program is intercepting. `houston doctor` names a cluster holding the ports. |
| Behind a tunnel or a proxy that terminates TLS (Cloudflare proxied, a load balancer) | TLS-ALPN cannot pass it. `houston config set acme.challenge http` makes Let's Encrypt validate over plain HTTP on `:80` instead; `up --domain` and `serve --domain` both use it. Send the name's HTTP to this host's `:80`. |
| The browser warns about a local certificate | Run `houston trust-ca` once, then `houston tls-status --name <name>` says it is trusted. Phones cannot use local certificates: use `--domain`. |
| No "Local certificate" option in the GUI | The cluster is not on this machine; houston's CA key never leaves it. Use a domain. |

## Left running

A cloud cluster bills every hour it exists; only `houston cluster delete` stops it.

```bash
houston list               # workspaces on this machine
houston cluster overview   # clusters this machine knows: state, cost per day, expiry, next step
houston cluster list       # EKS clusters in every enabled AWS region
```

| You see | Do this |
|---|---|
| `cluster list` names regions it could not read | Those are not covered: check them with `aws eks list-clusters --region <region>`. |
| `doctor` has no local record of a cloud cluster | That is not "there is none": ask AWS with `houston cluster list`. |
| `cluster delete` refuses: it holds workspaces | Remove them first, see [Stop the bill](eks.md#stop-the-bill-delete-the-cluster). |
| A cluster deleted outside houston is still listed | `houston cluster forget <context>` removes its kubeconfig entry. |

## The web GUI

| You see | Do this |
|---|---|
| "this backup is <name>'s data" | A backup belongs to whoever owned the workspace it was taken from, even after that workspace is gone or its name is reused. Only they or an admin can restore or delete it. |
| A cluster card says **Reading…** | It is being read. **Not read** or `?` means it could not be read, never zero. |
| The job log is quiet for a while | Long steps say "still installing (1m30s)". Over a couple of minutes, check **Activity** and `houston logs --name <name>`. |
| A control is missing | Options a runtime or cluster cannot honour are removed. Offline and "Don't pull images" are command-line only (`--offline`, `--no-pull`). |
| `serve` refuses to start on a reachable address | See [Reaching it from another machine](gui.md#reaching-it-from-another-machine), and create the first account before opening it up. |
| No **Sign in with Okta** button | `serve`'s start-up lines say why: `Okta sign-in is set up but off: <reason>`, such as a missing setting or no client secret. `houston config list` shows the `sso.*` keys. |
| The Okta tile shows the sign-in page instead of signing in | The `iss` the tile sends is not exactly `sso.issuer`: a trailing slash, or the Okta domain where the custom one is set. Set `sso.issuer` to the tile's value. See [Sign in with Okta](gui.md#sign-in-with-okta). |
| "That Okta sign-in expired or was already used" | It took over ten minutes, `serve` restarted in between, or the browser came back to another host than `sso.public_url`. Start again from the button or the tile. |
| "Okta refused the sign-in" | The client secret is wrong, or the app's redirect URI or client authentication does not match the table in [Sign in with Okta](gui.md#sign-in-with-okta). |
| "Okta did not answer" | houston cannot reach the Okta domain. Sign in with your houston password meanwhile. |
| "Your houston account is an admin" | An admin account links to Okta only once approved: `houston users link-sso <name>`. |
| "Okta sign-in is turned off for your account here" | The link was removed by `houston users unlink-sso` or `houston users remove`. `houston users link-sso <name>` allows it again, after `houston users add <name>` if the account is gone. |
| "Your Okta email address is not one this server accepts" | The email's domain is not in `sso.email_domains`. |
| "Your Okta account has no verified email address" | Okta has not verified the person's email, or the app does not grant the `email` scope. |

## Engines and images

| You see | Do this |
|---|---|
| Slow on Apple Silicon | Rocket.Chat below 8 and MongoDB below 8 are amd64 only and run emulated. Everything newer runs natively. |
| MongoDB 8 fails on Linux kernel 6.19 through 7.0.13 | [SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912): use an engine on kernel 7.0.14 or newer (on a Mac or Windows, update Docker Desktop), or a Rocket.Chat version paired with MongoDB 7.0. `houston doctor` warns; `docker info --format '{{.KernelVersion}}'` shows the kernel. |
| `toomanyrequests` while pulling | Docker Hub's anonymous pull limit. `docker login`, or take Rocket.Chat from GitHub's registry: `--rc-image ghcr.io/rocketchat/rocket.chat`. |

### Which engine

houston drives whatever answers as `docker`, with `docker compose`. `houston doctor` names
the engine it found and anything about it that would stop a workspace.

| Engine | | |
|---|---|---|
| Docker Engine or Docker Desktop, with Compose v2 | Supported | Every release is checked on it. |
| Podman 4.9 or later with the systemd cgroup manager: a distro package on Linux, rootless or not, or a Podman machine | Best effort | Workspaces, presets, `--monitor` and `loadtest` work. `serve --domain` needs `--bind` set to an address of this host. |
| Podman with the cgroupfs manager (a static build, or Podman inside a container) | Refused | It runs no healthchecks, and MongoDB 8 and multi-instance workspaces wait on one, so they would never start. `up` refuses; `--force` tries anyway. |
| `podman-compose` as `docker compose` | Refused | It is not Compose v2. Install the Compose v2 plugin; Podman then uses it. |

**Podman on Linux**, rootless:

```bash
systemctl --user enable --now podman.socket
export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock
# The docker command: Docker's static client, or your distro's podman-docker package.
# And the Compose v2 plugin, which Podman uses as its compose provider:
mkdir -p ~/.docker/cli-plugins
curl -fsSL -o ~/.docker/cli-plugins/docker-compose \
  https://github.com/docker/compose/releases/latest/download/docker-compose-linux-$(uname -m)
chmod +x ~/.docker/cli-plugins/docker-compose
podman info --format '{{.Host.CgroupManager}}'   # must say systemd
houston doctor
```

If the cgroup manager says `cgroupfs`, set `cgroup_manager = "systemd"` under `[engine]` in
`~/.config/containers/containers.conf`. That needs a systemd user session
(`loginctl enable-linger $USER` on a server).

HTTPS (`--https`, `--domain`, `serve --domain`) needs the edge on ports 80 and 443, which
rootless Podman refuses ("rootlessport cannot expose privileged port 80") until the
kernel lets users bind them:

```bash
sudo sysctl -w net.ipv4.ip_unprivileged_port_start=80
echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/90-houston.conf
```

**A hosts line on Podman.** Podman copies this machine's `/etc/hosts` into every container,
so a line the notes ask for -- `127.0.0.1 keycloak` for `oidc`, `127.0.0.1 minio` for
`s3_minio` with `presigned=true` -- also makes the workspace's own services resolve those
names to themselves: the bucket is never created and uploads fail with
`ECONNREFUSED 127.0.0.1:9000`. On Podman add no hosts line; give the browser this host's
address instead, with `--set idp_host=<address>` or `--set s3_host=<address>`.

**Podman on a Mac:** `podman machine init && podman machine start`, then run
`podman-mac-helper` so the Docker socket points at it.
