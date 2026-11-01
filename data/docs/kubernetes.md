# Workspaces on Kubernetes

houston can run a workspace on Kubernetes with the Rocket.Chat Helm chart, including
microservices. Use it when a ticket is about Kubernetes, the chart or microservices; for
everything else Docker is faster. For Amazon EKS, read [Rocket.Chat on EKS](eks.md):
a cloud cluster costs money, and `up` never creates one.

**Contents:** [Before you start](#before-you-start) ·
[Start a workspace](#start-a-workspace) · [Which cluster it uses](#which-cluster-it-uses) ·
[What Kubernetes refuses](#what-kubernetes-refuses) ·
[HTTPS on a cluster](#https-on-a-cluster) · [Looking inside](#looking-inside) ·
[Removing it](#removing-it)

---

## Before you start

On top of the [README](../../README.md#before-you-start) list:

- `kubectl` and `helm` on your `PATH`.
- **Either** [kind](https://kind.sigs.k8s.io/), so houston can make its own local
  cluster (about 600 MB), **or** a cluster your `kubectl` already reaches, such as
  [k3s](https://k3s.io/), minikube or Docker Desktop.

```bash
houston doctor        # names the cluster it will use, and its storage, ingress, load balancer and metrics
```

## Start a workspace

```bash
houston up --version 8.5.1 --name ticket-1234 --runtime kubernetes --wait                       # microservices
houston up --version 8.5.1 --name ticket-1234 --runtime kubernetes --deployment monolith --wait # one Rocket.Chat pod
houston info --name ticket-1234                                                                 # its address, cluster and namespace
```

| `--runtime` | `--deployment` | What you get |
|---|---|---|
| `docker` (default) | `monolith` (default) | Rocket.Chat and MongoDB, two containers |
| `docker` | `multi-instance` | several Rocket.Chat instances behind a load balancer, with NATS |
| `kubernetes` | `microservices` (default) | the Helm chart, about 9 pods |
| `kubernetes` | `monolith` | the Helm chart, about 5 pods |

- Microservices are an Enterprise feature: without a license, Rocket.Chat replicas after
  the first stop. `info` says so; add a license with `--license` or in Rocket.Chat.
- Each workspace is a namespace, `houston-<name>`, reached on `http://localhost:<port>`
  through a port-forward houston starts.
- `--mongo-operator` runs MongoDB under the community operator, with authentication
  (MongoDB 6.0 or newer). Without it MongoDB has no authentication.
- `--replicas` sets how many Rocket.Chat instances run.
- houston never changes the context your own `kubectl` uses.

## Which cluster it uses

- **`--context <name>`** picks a cluster from your kubeconfig and implies Kubernetes. It
  never creates one. On EKS, a cluster's `--zone` names each workspace `<name>.<zone>`.
- **`houston config set kubernetes.context <name>`** sets the default for
  `--runtime kubernetes`.
- **With neither:** houston's own kind cluster if kind is installed, else whatever your
  `kubectl` points at. With both present, kind wins; pass `--context` for the other.

## What Kubernetes refuses

Each refusal says why and what to do instead.

| Refused | Instead |
|---|---|
| `up --fresh` | `houston down --name <name> --volumes`, then `up` again |
| `loadtest`, `capacity` | load-test a Docker workspace on the same version |
| `env --set`, `--setting`, `--unset` | the `helm upgrade` the refusal prints, or `houston api` for a setting |
| `up --env` or `--setting` naming a variable the chart writes itself (`ROOT_URL`, `MONGO_URL`, `REG_TOKEN`, `DEPLOY_*`, Prometheus and microservice variables) | `--root-url` or `--domain`, `--reg-token`; anything else goes through |
| `seed --scale` | `houston seed --name <name>` |
| `--preset voice --set sip_integration=on` (and `pbx=on`) | a Docker workspace; `--preset voice` alone, calls between users, works on Kubernetes |
| `up --https` on a cluster not on this machine | `--domain`, below |
| Rocket.Chat below 8.0.0 on an arm64 node (such as Graviton) | an amd64 node: those images are amd64 only |
| Rocket.Chat below 3.7.2 | Docker: no usable Helm chart exists |

`up --env` and `--setting` work on both runtimes, and a re-up, `backup` and `restore --new`
keep them. `logs`, `env` (reading), `upgrade`, `backup`, `restore`, `seed`, `monitor`, `api`, `pat`,
`token` and `stats` work on both runtimes (`stats` needs metrics-server and says how to
install it).

**LDAP users after a re-up:** the OpenLDAP directory keeps its entries inside its pod and reads
its users once, when the pod starts. A re-up that changes them (`--set users=…`, `groups=on`,
another `domain`) restarts the directory, so it serves the new users; entries you added by hand
in phpLDAPadmin are not kept, and Rocket.Chat's accounts stay linked (they are matched by
`uid`). A workspace an earlier houston made with up to 500 users and any of those set restarts
its directory once, on its first `up` with this release. An Active Directory workspace
(`directory=ad`) is unchanged.

**Monitoring:** `houston monitor --name ticket-1234` (or `up --monitor`) installs one
shared Grafana in `houston-system`. It opens at `https://<workspace-host>/grafana/` for an
HTTPS workspace, else `http://localhost:5050/grafana/` (`admin/admin`), or the next free
port when another monitored workspace's forward holds 5050. That Grafana's own absolute
links (sign-in redirects, share links) name 5050. The GUI's
**Logs in Grafana (Loki)** link opens its logs dashboard. `houston monitor --name
ticket-1234 --off` detaches it.

## HTTPS on a cluster

```bash
houston up --version 8.5.1 --name ticket-1234 --runtime kubernetes \
  --domain t1234.example.com --email you@example.com --wait
houston tls-status --name ticket-1234
```

- Point the name at the cluster's ingress **before** `up`: Let's Encrypt checks it from
  outside.
- For a minute or three the ingress may serve a placeholder certificate, and `tls-status`
  exits 1. Run it again; if it persists, the certificate order is stuck.
- With several ingress controllers, houston uses the default one and says which;
  `--ingress-class nginx` picks another.
- A `--domain` workspace gets a generated admin password; `houston info` shows it.

## Looking inside

```bash
export KUBECONFIG="${HOUSTON_HOME:-$HOME/.houston}/clients/kubernetes/config"   # only for houston's kind cluster
kubectl -n houston-ticket-1234 get pods
kubectl -n houston-ticket-1234 describe certificate ticket-1234-tls
```

With your own cluster, your usual `kubectl` works. The GUI's workspace page lists the
pods and why any cannot start.

## Removing it

```bash
houston down --name ticket-1234 --volumes     # the namespace and its data
houston prune                                 # also houston's own kind cluster, once it is empty
houston prune --orphans                       # namespaces houston owns that no record lists
```

The shared cluster stays, because other workspaces use it. `prune` deletes a kind cluster
only if houston created it; a cluster you brought is never deleted. The shared MongoDB
operator and monitoring go once nothing needs them, but their CRDs stay: deleting a CRD
deletes every resource of that kind in the cluster. The ingress controller and cert-manager
that `--https` or `--domain` installed also stay, as the cluster's own infrastructure.
