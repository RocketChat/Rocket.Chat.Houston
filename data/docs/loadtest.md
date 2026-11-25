# Load testing and capacity

Two commands show how a workspace behaves under load, on the customer's exact version:

- **`houston loadtest`** puts a load on the workspace for a set time. It reports how fast
  Rocket.Chat answered, how many requests failed, and why it slowed down.
- **`houston capacity`** raises the load step by step until the workspace misses a target,
  and tells you how much load it held.

Both work on **Docker workspaces only**, from the terminal or from the GUI.

```bash
houston up --name ticket-1234 --version 8.9.1 --wait
houston seed --name ticket-1234                 # users for the load to log in as
houston loadtest --name ticket-1234 --scenario journey --vus 20 --duration 30s
houston capacity --name ticket-1234
houston down --name ticket-1234 --volumes
```

**Contents:** [How it works](#how-it-works) · [Scenarios](#scenarios) ·
[loadtest](#loadtest) · [Reading the result](#reading-the-result) · [capacity](#capacity) ·
[In the GUI](#in-the-gui) · [Good to know](#good-to-know)

---

## How it works

1. houston starts [k6](https://k6.io), a load-testing tool, in a temporary container on the
   workspace's own Docker network, so the load reaches Rocket.Chat directly.
2. k6 runs a number of **VUs** (virtual users). Each VU repeats the scenario in a loop,
   without pausing, for the whole run. A VU is a k6 worker, not a Rocket.Chat account, and it
   sends far more requests than one person in a browser does.
3. The VUs log in as the users `houston seed` made, so the load comes from several accounts.
   `houston seed` makes 5 users, and `--profile standard` makes 20. With no seeded users,
   every request uses the admin account.
4. While the load runs, houston watches Rocket.Chat and MongoDB from the inside.
5. At the end it prints the result and a short verdict, then puts the workspace back.

The first run downloads the k6 image, `grafana/k6`.

### What a run changes, and puts back

| During the run | Why | Afterwards |
|---|---|---|
| The API rate limiter is off | otherwise Rocket.Chat refuses the load (429) and you measure the limiter | back on |
| Prometheus metrics are on | to read Rocket.Chat's event-loop lag | as it was |
| The MongoDB profiler is on | to catch queries slower than `--slowms` | as it was |
| CPU and RAM caps, with `--constrain` | to act like the customer's server | as they were (see below) |

Docker cannot remove a cap, so a service that had none gets this machine's whole CPU and
RAM afterwards, which works out the same.

They go back even when the run fails. If houston is stopped before the run ends, by Ctrl-C
or by being killed, run `houston doctor`: it lists anything left changed, and `houston
serve` puts it back when it starts.

Some things stay in the workspace: the messages the writing scenarios post in `#general`,
an access token named `houston-loadtest` on the admin account, and, after the `webhook`
scenario, an incoming integration named `houston-loadtest-hook`.

---

## Scenarios

| `--scenario` | Each VU, in a loop | Use it when |
|---|---|---|
| `messages` (default) | posts a message to `#general` | sending messages is slow |
| `read` | reads the last 20 messages of `#general` | opening rooms is slow |
| `login` | logs in | logins are slow, or many people log in at once |
| `mixed` | reads (60%), posts (30%) or logs in and straight out again (10%) | you want a general, realistic load |
| `journey` | logs in, lists its rooms, opens `#general`, posts, syncs; each step timed | you need to know **which part** is slow |
| `webhook` | posts an alert through an incoming webhook houston creates | a monitoring system floods a channel |
| `badbot` | reads 100 messages, lists users, lists channels, with no paging | a customer's script or bot hammers the server |
| `custom` | calls the one endpoint you name with `--endpoint` | the customer has one slow API call |

---

## loadtest

```bash
# 20 VUs for 30 seconds
houston loadtest --name ticket-1234 --scenario journey --vus 20 --duration 30s

# a pass/fail target: exit 1 when it is missed, so it works in CI
houston loadtest --name ticket-1234 --scenario journey --slo "p95=500ms,error=1%"

# the customer's own slow call
houston loadtest --name ticket-1234 --scenario custom --endpoint "GET /api/v1/channels.list?count=100"

# on the customer's hardware: 2 CPUs and 2 GB for Rocket.Chat, 1 CPU and 1 GB for MongoDB
houston loadtest --name ticket-1234 --scenario messages --constrain "rc=2cpu/2g,mongo=1cpu/1g"

# a sudden burst: 10 VUs, then 100, then 10 again; says how long it took to recover
houston loadtest --name ticket-1234 --scenario read --spike 10:100 --duration 60s

# before and after a fix
houston loadtest --name ticket-1234 --scenario journey --save before-fix
houston loadtest --name ticket-1234 --scenario journey --compare before-fix
```

| Option | What it does | Default |
|---|---|---|
| `--scenario` | the load to run ([Scenarios](#scenarios)) | `messages` |
| `--vus` | how many VUs run at once | `10` |
| `--duration` | how long the run lasts: `30s`, `2m` | `30s` |
| `--users` | how many seeded users the VUs log in as; `0` is the admin only | `10` |
| `--ramp 10:200` | grow from 10 to 200 VUs over the run, instead of a fixed `--vus` | |
| `--spike 10:100` | 10 VUs, then 100, then 10, for a third of the run each | |
| `--endpoint`, `--body` | for `custom`: the call, such as `"GET /api/v1/me"`, and a JSON body for POST | |
| `--slo` | the target the run must meet (below); missing it exits 1 | |
| `--constrain` | CPU and RAM caps for the run (below) | |
| `--diag`, `--no-diag` | the inside view: event-loop lag, slow MongoDB queries, the verdict | on |
| `--slowms` | a MongoDB query slower than this many ms counts as slow | `100` |
| `--stats` | also report each container's CPU and RAM | |
| `--live` | stream the numbers to Grafana during the run; run `houston monitor` first | |
| `--save NAME`, `--compare NAME` | keep this run under a name; compare a later run with it | |
| `--report`, `--report-path` | also write a Markdown report to attach to a ticket | |
| `--json` | print the result as JSON, for scripts | |

**`--slo`** is a list of rules joined by commas, such as `p95=500ms,error=1%,rps=100`.
`p50` `p90` `p95` `p99` `avg` `min` `max` are the longest a response may take; `error` is
the most requests that may fail, in percent; `rps` is the fewest requests per second.

**`--constrain`** caps services by name: `rc` (every Rocket.Chat container), `mongo`, or
any other service of the workspace, with CPUs, memory or both: `rc=2cpu/2g`,
`mongo=0.5cpu/512m`. A memory cap below what a service already uses is refused, because the
service would restart and the run would measure the restart.

### Reading the result

The `journey` example above, on Rocket.Chat 8.9.1 on a 4-CPU test machine (k6's own
progress lines left out):

```text
Load test: journey @ 20 VUs for 30s as 5 seeded users -> http://rocketchat:3000 (via k6 on 'ticket-1234''s network)

+- loadtest journey (20 VUs / 30s, 5 users) --------------+
|  throughput  209.4 req/s   (6340 requests)              |
|  latency     p50 57ms  p90 205ms  p95 246ms  p99 380ms  |
|  avg 95ms  min 2ms  max 519ms                           |
|  errors      0.00%   checks 100% ok                     |
|  responses   2xx 6340                                   |
+---------------------------------------------------------+

Per-step latency:
  step      count       p50     p95     p99
  login      1268     157ms   272ms   336ms
  rooms      1268      29ms    69ms   101ms
  open       1268      51ms   115ms   152ms
  post       1268     173ms   375ms   432ms
  sync       1268      22ms    54ms    79ms

  p95 over time   171ms |::... .*#- ...  | 417ms   (16 buckets of 2s)

RC internals during the test:
  rocketchat     event-loop lag peak 51ms / p99 40ms   heap 895MB   ddp users 0

Verdict:
  - No saturation signals: p95 246ms at 209.4 req/s, 0.00% errors - the workspace has
      headroom at this load.
```

- **throughput**: requests answered per second, by all VUs together.
- **latency**: how long requests took. **p95** means 95 of every 100 requests were faster
  than this. It is the number to quote, because an average hides the slow requests.
- **errors** and **responses**: the share of requests that failed, and their status codes.
  429 is a rate limit; 5xx is Rocket.Chat failing.
- **Per-step latency** (`journey`, `mixed`): the time of each step. Here `post` and `login`
  are the slow ones.
- **p95 over time**: whether it stayed steady or got worse as the run went on.
- **RC internals**: Rocket.Chat's event-loop lag. houston calls it degraded when it averages
  over 100 ms, and saturated when it peaks over 500 ms.
- **Verdict**: what the inside view found, one sentence each.

| The verdict says | It means |
|---|---|
| RC event loop saturated, or degraded | Rocket.Chat's Node.js process is out of CPU. More CPU or more instances help. |
| MongoDB ran N collection scans (COLLSCAN) | a query read a whole collection: likely a missing index. |
| N MongoDB queries exceeded the slow threshold | the slowest query is named, with how MongoDB ran it. |
| MongoDB, or Rocket.Chat, was the hot container | which of the two used the CPU. |
| High client latency without RC event-loop saturation | requests wait somewhere else: a CPU cap, MongoDB, or connections. |
| N% of requests failed: Nx 429, Nx 5xx, Nx 4xx, starting ~Ns into the run | how many failed, of which kind, and from when. 5xx is the server failing. 4xx in `journey` above 50 VUs per seeded user is the session limit (see [Good to know](#good-to-know)), not the server. |
| Slow spike recovery, or did not recover | after a burst, Rocket.Chat took long to catch up, or never did. |
| RAM grew ~N MB/h | with `--stats` on a long run: a possible memory leak. |
| No saturation signals | the workspace coped with this load. |

---

## capacity

`capacity` finds how much load the workspace holds. It runs the scenario with 10 VUs, then
20, 40, 80 and so on, for 20 seconds each, until a step misses the target. Then it tries two
loads in between to narrow it down.

```bash
houston capacity --name ticket-1234
houston capacity --name ticket-1234 --slo "p95=300ms,error=1%" --constrain "rc=2cpu/2g" --max 160 --report
```

The first example, on the same machine (k6's progress lines left out):

```text
Capacity search: journey as 5 seeded users, SLO p95=500ms,error=2% (steps of 20s)
    10 VUs             217.2 req/s   p95   119ms   err  0.00%   PASS
    20 VUs             231.5 req/s   p95   212ms   err  0.00%   PASS
    40 VUs             232.9 req/s   p95   416ms   err  0.00%   PASS
    80 VUs             215.6 req/s   p95   937ms   err  0.00%   FAIL (p95 <= 500ms (actual 937ms))
    60 VUs (bisect)    223.4 req/s   p95   699ms   err  0.00%   FAIL (p95 <= 500ms (actual 699ms))
    50 VUs (bisect)    236.0 req/s   p95   512ms   err  0.00%   FAIL (p95 <= 500ms (actual 512ms))

Capacity: ~40 concurrent VUs (holds at 40, breaks at 50)
  why it broke: at 50 VUs: p95 <= 500ms (actual 512ms)
```

The answer is the last load that met the target, the first that missed it, and why it
broke. Here throughput stopped growing at about 230 req/s while p95 kept rising: past that
point, more VUs only wait longer. Missing the target is the answer, not a failure, so
`capacity` exits 0. If no step misses it, the answer is `holds the SLO up to N VUs (never
breached; raise --max to push further)`.

| Option | What it does | Default |
|---|---|---|
| `--scenario` | `journey`, `messages`, `read`, `mixed`, `login` or `badbot` | `journey` |
| `--slo` | the target that counts as holding | `p95=500ms,error=2%` |
| `--start` | the first step's VUs | `10` |
| `--max` | stop doubling past this many VUs | `640` |
| `--step-duration` | how long each step runs | `20s` |
| `--users`, `--constrain`, `--report`, `--report-path`, `--json` | as for `loadtest` | |

**The number is VUs, not people.** A VU sends requests without a pause, so it is far more
traffic than one person. Use the number to compare: two versions, 2 CPUs against 4, before
and after a fix. It does not say how many people the customer's server can take.

---

## In the GUI

On a running Docker workspace, **Run a load test** and **Find capacity** are among the
workspace's actions, for admins, and for members on their own workspaces. The job log shows the progress, and the result
when the run ends.

The GUI offers every scenario except `webhook` and `custom`. Ramp, spike, save and
compare, and the report are in the terminal only.

---

## Good to know

- **Docker only.** On Kubernetes the load would pass through one `kubectl port-forward`,
  which gives out long before Rocket.Chat does, so houston refuses. Reproduce on a Docker
  workspace with the same version.
- **The numbers are this machine's**, not the customer's server. `--constrain` brings the
  CPU and RAM closer; disks, network and the amount of data still differ.
- **A customer's amount of data:** `houston seed --scale` fills MongoDB in bulk
  ([Sample data](guide.md#sample-data)). Those users cannot log in, so also run a plain
  `houston seed` for the VUs.
- **`journey` with many VUs:** each VU logs in for itself, and Rocket.Chat keeps 50
  sessions per user. Keep the VUs (or `capacity`'s `--max`) at or under 50 per seeded user;
  above that, some steps fail with 4xx that are not the server's, and houston warns. For
  more, `houston seed --profile standard` makes 20 users: use them with `--users 20`.
- **Rocket.Chat 6.x and runs back to back:** 6.x limits how fast the run's tokens can be
  made, so a run started right after another can be refused with "rate-limiting token
  creation … try again then". Wait a minute and run it again.
- **Files:** reports go to `~/.houston/reports/`, saved runs to `~/.houston/loadtests/`.
