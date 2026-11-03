# houston

houston starts a customer's exact Rocket.Chat version on your machine, so you can
reproduce their issue in minutes. One command boots that version with a compatible
MongoDB, and can add LDAP, SAML, OIDC, email, S3 or sample data. When the ticket is
closed, one command removes it.

It is built for Rocket.Chat support engineers. What it starts is for reproducing a
problem, not for serving real users.

## Before you start

You need:

- **Docker**, with Compose v2 and the daemon running. `docker compose version` should
  print a version.
- **Node.js 24.10 or newer**. Check with `node --version`.
- **Internet access**, to pull images and look up which MongoDB a version needs.
- **Free memory.** A workspace uses about 1.1 GB, and `houston up` refuses to start one
  when the machine does not have room.

Kubernetes is optional. The [Kubernetes guide](data/docs/kubernetes.md) covers it.

## Install

```bash
npm install -g @rocket.chat/houston
houston doctor
```

`houston doctor` checks Docker, Compose, disk, memory and ports, and names anything
that would stop a workspace from starting.

Used houston 1.x or rc-repro before? Read [Upgrading](data/docs/upgrading.md) first.
Your workspaces are kept.

## Your first workspace

Start Rocket.Chat 8.5.1 for ticket TICKET-1234:

```bash
houston up --version 8.5.1 --name TICKET-1234 --wait
```

- `--version` is the Rocket.Chat version to reproduce on. Give the full version, such
  as `8.5.1`.
- `--name` is what you call the workspace. Use the ticket id. Names are lowercased, so
  this workspace is `ticket-1234`, and houston says so.
- `--wait` returns once Rocket.Chat is serving and its setup wizard is done. The first
  run downloads images and can take several minutes. Later runs are faster.

Find its address and login:

```bash
houston info --name TICKET-1234
```

Open the URL it prints in your browser and sign in with the admin login it shows. For
a workspace on your own machine that is `admin` / `admin123`.

When you are finished:

```bash
houston down --name TICKET-1234 --volumes
```

`--volumes` deletes the workspace's data as well, after asking you to confirm. Without
it, `down` keeps the data, and running the same `up` again brings the workspace back.

A workspace only listens on `127.0.0.1`, so nobody else on your network can reach it.
Keep it that way: every workspace uses the same well-known passwords.

## Day to day

| To | Run |
|---|---|
| see your workspaces | `houston list` |
| see a workspace's URL, login and details | `houston info --name <name>` |
| read its logs | `houston logs --name <name> --tail 100` (add `-f` to follow) |
| pause it, then resume it | `houston stop --name <name>`, then `houston start --name <name>` |
| start one with LDAP, SAML, email and so on | `houston up --version 8.5.1 --name <name> --preset ldap --wait` |
| fill it with conversations, files and profiles | `houston seed --name <name> --verify-seed` |
| back it up | `houston backup --name <name>` |
| upgrade it to another version | `houston upgrade --name <name> --to 8.6.1` |
| remove it and keep its data | `houston down --name <name>` |
| remove it and delete its data | `houston down --name <name> --volumes` |
| use a browser instead of the terminal | `houston serve` |
| check the machine | `houston doctor` |

Every command explains itself with `--help`, for example `houston up --help`.

## Where next

| Guide | Read it when |
|---|---|
| [User guide](data/docs/guide.md) | you need a preset, sample data, a customer's settings, backups and upgrades, HTTPS, monitoring, a load test or the REST API |
| [Encrypted conversations (E2EE)](data/docs/e2ee.md) | the ticket concerns encrypted DMs, rooms or files |
| [Voice calls](data/docs/voice.md) | the ticket concerns Voice calls or the SIP integration |
| [Kubernetes](data/docs/kubernetes.md) | the ticket needs Kubernetes, or Rocket.Chat as microservices |
| [Rocket.Chat on EKS](data/docs/eks.md) | the ticket needs a real cloud cluster. A cluster costs money by the hour, so read the guide before you create one. `houston cluster guide` prints it, and `houston cluster overview` shows what is billing |
| [Web GUI](data/docs/gui.md) | you prefer a browser, or you share one machine with your team, signing in with Okta or a password |
| [Scripts and agents](data/docs/automation.md) | a script or a coding agent drives houston: `--json`, exit codes, the agent skill |
| [Troubleshooting](data/docs/troubleshooting.md) | something does not work |
| [Upgrading](data/docs/upgrading.md) | you used houston 1.x or rc-repro before |
| [Contributing](CONTRIBUTING.md) and [Architecture](data/docs/ARCHITECTURE.md) | you want to change houston itself |

The guides ship with the package, so they are on every machine houston is installed on.
`houston cluster guide --path` prints where.

## About

houston is maintained by the Rocket.Chat support team and is released under the
[MIT licence](LICENSE). Report problems at
[github.com/RocketChat/Rocket.Chat.Houston/issues](https://github.com/RocketChat/Rocket.Chat.Houston/issues).

The 1.x source is in the repository's history, in `legacy/` at the
[v2.1.1 tag](https://github.com/RocketChat/Rocket.Chat.Houston/tree/v2.1.1/legacy).
