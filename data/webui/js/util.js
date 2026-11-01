import { ctx } from "./shared.js";

"use strict";
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids) n.append(kid);
  return n;
};

// kind: "error" (default) | "ok" | "info". Toasts were unconditionally red, so
// "copied" and "pruned 3" flashed like failures; and every toast shared one fixed
// position, so a repeating failure (the 4s poll against a bad token) piled
// unreadable banners exactly on top of each other.
function toast(msg, kind = "error") {
  const stack = $("#toasts") || el("div", { id: "toasts", class: "toasts" });
  // INSIDE THE OPEN MODAL, when there is one. showModal() puts a dialog in the top layer
  // and the rest of the page under its backdrop -- a stack on <body> included -- so a
  // create the server refused toasted its reason where nobody could read it, and Create
  // looked as if it had done nothing. Re-homed on every toast, because which dialog is
  // open changes; the last open modal in the document stands in for the topmost.
  const host = [...document.querySelectorAll("dialog[open]")].filter((d) => d.matches(":modal")).pop()
    || document.body;
  if (stack.parentElement !== host) host.append(stack);
  const last = stack.lastElementChild;
  if (last && last.textContent === msg) last.remove();   // collapse an identical repeat
  const t = el("div", { class: "toast " + kind, role: "status" }, msg);
  stack.append(t);
  while (stack.childElementCount > 4) stack.removeChild(stack.firstChild);
  setTimeout(() => t.remove(), 4000);
}

// EVERY url on screen is the one the server reported, shown and linked verbatim.
//
// There used to be a rewrite here that swapped `localhost` for whatever host the
// GUI was loaded from, so that links stayed clickable when `serve` is reached
// through a proxy or a remote lab. It is gone, deliberately: a workspace's
// ROOT_URL is what Rocket.Chat itself is configured with, so it is the address
// that identifies the workspace, and the rewrite meant the interface showed a
// number that appears in no config file anywhere. Applying it to an href but not
// to the label also put two different addresses for one workspace on one screen.
//
// The cost is real and is accepted: from a browser that is not on the docker host,
// `http://localhost:3000` is that browser's own machine, so the link will not
// open the workspace. It is still the correct thing to display, and copying it is
// what a support engineer pastes into a ticket.

// Set once the server says a login is in force. Until then every 401 is a token
// problem, not an expired session, and bouncing to /signin would be wrong.
let ACCOUNTS = false;
let MY_ROLE = "";
// The Okta username of an account linked to Okta, shown beside the houston name.
// Display only: ME, ownership and the audit trail stay on the houston name.
let SSO_USER = "";
// What this session may do, so the interface can say so BEFORE the click rather
// than refusing after it. The server is the boundary -- every one of these is
// enforced in `guard` regardless -- but a button that always answers with a red
// toast reads as a broken feature, not as a permission.
// Token mode has no roles, so everything is allowed there exactly as before.
const canWrite = () => MY_ROLE !== "readonly";
const canAdmin = () => MY_ROLE === "admin";
// A member sees every workspace and changes only their own: the server refuses the rest
// with 409. The detail's `may_destroy` is the server's answer for this viewer.
const canChange = (d) => canWrite() && !(d && d.may_destroy === false);
const ownerOf = (d) => (d && (d.owner || d.created_by)) || "its owner";
const READONLY_WHY = "Your role is readonly. Workspace logs carry LDAP bind "
  + "passwords and OAuth secrets, so readonly cannot read them either.";
let SIGNING_OUT = false;

// A session can expire mid-session (12h idle / 7d absolute) or be revoked from
// another browser. Both arrive as a 401 on whatever the page happened to be
// doing -- the 4s poll, an SSE reconnect, a click. Without this the dashboard
// just started failing silently, which is the failure mode the old
// no-logout-no-login-page design had no answer for either.
function toSignIn(reason) {
  if (SIGNING_OUT) return;
  SIGNING_OUT = true;
  const next = encodeURIComponent(location.pathname + location.search + location.hash);
  location.assign(`/signin?e=${reason}&next=${next}`);
}

// NO REQUEST WAITS FOREVER. A reply that never came -- a server stalled mid-read, a
// connection a sleeping laptop left half-open -- held its caller for good, and the list
// poll queues each read behind the last (`loadRepros`), so one such request froze the
// rail until the page was reloaded. Two minutes is longer than the slowest read measured
// (an EKS workspace's panel, one to two minutes), so only a request that is stuck is cut.
let API_TIMEOUT_MS = 120_000;
function timedOut() {
  const err = new Error(`The server did not answer within ${Math.round(API_TIMEOUT_MS / 1000)} s.`);
  err.status = 0;
  return err;
}

async function api(path, opts = {}) {
  if (!SERVER_ONLINE && !["GET", "HEAD"].includes((opts.method || "GET").toUpperCase())) {
    throw new Error("Server unavailable — wait for the connection to return before making changes.");
  }
  const headers = Object.assign({}, opts.headers || {});
  if (opts.body) headers["Content-Type"] = "application/json";
  // same-origin credentials so the session cookie rides along; it is HttpOnly,
  // so this file can neither read nor forge it.
  const init = { credentials: "same-origin", signal: AbortSignal.timeout(API_TIMEOUT_MS) };
  let r;
  try { r = await fetch(path, Object.assign(init, opts, { headers })); }
  catch (e) { throw e && e.name === "TimeoutError" ? timedOut() : e; }
  // The deadline covers the body too: one that stops arriving is the same stuck reply.
  const data = await r.json().catch((e) => { if (e && e.name === "TimeoutError") throw timedOut(); return {}; });
  if (r.status === 401) { toSignIn("expired"); throw new Error("signed out"); }
  if (!r.ok) {
    // The STATUS rides along, because "retry in three seconds" and "this will
    // never work" are different answers and the message alone cannot tell them
    // apart. src/lib/errors.ts assigns the code by class: 409 is a refusal (not running,
    // no metrics-server), 502 is docker, 400 is the request itself.
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

// The same call for a MULTIPART body. `api()` sets Content-Type: application/json
// whenever there is a body, which is exactly wrong for a FormData upload -- the
// browser has to set its own boundary. So this shares everything that matters (the
// same-origin session cookie, the 401 redirect, the status-carrying error) and
// differs only in not touching Content-Type.
//
// The config-import preview used a bare `fetch` for this reason and lost the 401
// with it: an expired session showed an error inside a dialog that could no longer
// do anything, instead of returning the reader to sign-in.
async function apiForm(path, opts = {}) {
  if (!SERVER_ONLINE) throw new Error("Server unavailable — wait for the connection to return before making changes.");
  const r = await fetch(path, Object.assign({ credentials: "same-origin" }, opts));
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { toSignIn("expired"); throw new Error("signed out"); }
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

// ---- where is this browser? -------------------------------------------------
// Nothing is DETECTED here. Whether `serve` is on EC2, on a colleague's desktop or
// on the reader's own laptop is not a question this needs answered -- the only thing
// that matters is whether the browser and the workspaces are on the same machine,
// and the browser already knows that: it is the address in its own URL bar. No cloud
// metadata, no guessing from a hostname, no new endpoint.
//
// Loopback => `serve` and the browser are the same box, and every localhost link in
// this UI is correct. Anything else => they are not, and "localhost" names the
// READER'S machine, where nothing is running.
// The whole of 127.0.0.0/8, not just 127.0.0.1: every address in it is this machine
// talking to itself, so a GUI opened at 127.0.0.2 is no more remote than one opened
// at 127.0.0.1 and must not be told otherwise.
const LOOPBACK_HOSTS = ["localhost", "::1", "[::1]", ""];
function isLoopbackHost(h) {
  return LOOPBACK_HOSTS.includes(h) || /^127\.\d+\.\d+\.\d+$/.test(h);
}
function remoteHost() {
  return isLoopbackHost(location.hostname) ? "" : location.hostname;
}
// A link that, read from another computer, opens on THAT computer rather than the server.
// *.localhost is loopback in every browser (a local-certificate workspace's name).
function remoteLoopback(url) {
  if (!remoteHost()) return false;
  let h = "";
  try { h = new URL(url).hostname; } catch (_) { return false; }
  return isLoopbackHost(h) || h.endsWith(".localhost");
}
const LOOPBACK_TITLE = "Opens localhost on YOUR computer; only a browser on this server can open it. "
  + "A workspace created with HTTPS gets a public address.";
// A workspace bound to one of these is reachable from another machine; bound to
// anything else it answers only on the box that runs it. "" means the workspace
// predates the metadata key, so nothing is claimed either way.
const WIDE_BINDS = ["0.0.0.0", "::", "*"];

// ---- repro list (master) ----------------------------------------------------
let ALL_REPROS = [];
// The Grafana origins this page's frame-src was built from: the monitored workspaces of its
// first list read. A job naming one of these needs no reload.
let GRAFANAS_AT_LOAD = null;
let SELECTED = null;
// What the stage is showing: "home" when nothing is picked, "workspace" for
// the selected one, "activity" for the box-wide log. The rail selection and
// the view are separate on purpose -- opening Activity must not silently
// deselect the workspace you were working on.
let VIEW = "home";
// Every view change goes through here, so "what is on the stage" and "what the
// top bar says is current" cannot disagree. They did: Activity and Scenarios were
// reachable and nothing led back, because the brand was a <div> and no link was
// ever marked.
function setView(v, { history: writeHistory = true } = {}) {
  if (VIEW === "workspace" && v !== "workspace") ctx.closeLogs();
  VIEW = v;
  if (writeHistory) saveLocation();
  for (const [id, name] of [["#btn-home", "home"], ["#btn-jobs", "activity"],
                            ["#btn-clusters", "clusters"],
                            ["#btn-scenarios", "scenarios"], ["#btn-backups", "backups"]]) {
    const b = $(id);
    // A cluster's own view is still "Clusters" in the top bar.
    if (b) b.toggleAttribute("aria-current", VIEW === name || (name === "clusters" && VIEW === "cluster"));
  }
}
// The URL describes the view, selected workspace and tab. It survives a reload and
// uses the browser's own history; restoring it never adds another history entry.
let restoringLocation = false;
const ROUTE_VIEWS = new Set(["home", "workspace", "clusters", "cluster", "activity", "scenarios", "backups"]);
const WORKSPACE_TABS = new Set(["overview", "logs", "containers", "env", "backups"]);
function locationHash() {
  const parts = [VIEW];
  if (VIEW === "workspace" && SELECTED) parts.push(SELECTED, dstate.tab);
  if (VIEW === "cluster" && ctx.CLSTATE) parts.push(ctx.CLSTATE.selected);
  if (VIEW === "activity") parts.push(ctx.ACT_TAB || "running");
  const people = $("#people-dialog");
  return "#/" + parts.map(encodeURIComponent).join("/") + (people && people.open ? "?people=1" : "");
}
function saveLocation({ replace = false, restoring = false } = {}) {
  if (restoringLocation) return;
  // A click supersedes any restoration still waiting for a response, even when
  // it chooses the same hash. Only the restoration itself may normalize its URL.
  if (!restoring) locationRead += 1;
  const hash = locationHash();
  if (location.hash === hash) return;
  window.history[replace ? "replaceState" : "pushState"](null, "", hash);
}
let locationRead = 0;
async function restoreLocation() {
  const read = ++locationRead;
  let parts;
  try { parts = location.hash.split("?")[0].replace(/^#\/?/, "").split("/").map(decodeURIComponent); }
  catch (_) { parts = ["home"]; }
  const target = ROUTE_VIEWS.has(parts[0]) ? parts[0] : "home";
  const dispatch = (fn) => {
    // Suppress only this call's synchronous navigation write. Holding the flag
    // across an API read also suppressed real clicks made while it was pending.
    restoringLocation = true;
    try { return fn(); } finally { restoringLocation = false; }
  };
  const people = $("#people-dialog");
  if (people && people.open) {
    people.dataset.navigationClosing = "true";
    people.close();
  }
  if (target !== "workspace") {
    ctx.closeLogs();
    if (dstate.statsTimer) { clearInterval(dstate.statsTimer); dstate.statsTimer = null; }
  }
  if (target === "workspace" && parts[1]) {
    await dispatch(() => ctx.selectRepro(parts[1], WORKSPACE_TABS.has(parts[2]) ? parts[2] : "overview"));
  } else if (target === "clusters") await dispatch(() => ctx.openClusters());
  else if (target === "cluster" && parts[1]) await dispatch(() => ctx.openPlace(parts[1]));
  else if (target === "activity") await dispatch(() => ctx.openJobs(parts[1] === "history" ? "history" : "running"));
  else if (target === "scenarios") dispatch(() => ctx.openScenarios());
  else if (target === "backups") await dispatch(() => ctx.openBackups());
  else dispatch(goHome);
  if (read !== locationRead) return;
  if (location.hash.includes("?people=1") && canAdmin()) await dispatch(() => ctx.openPeople());
  if (read === locationRead) saveLocation({ replace: true, restoring: true });
}
// Every view is represented by a hash. Back/Forward and a typed hash both fire
// this event; pushState from a click already rendered that view and needs no read.
window.addEventListener("hashchange", () => { restoreLocation(); });

// A cached state is useful context, but cannot claim to be current after a failed
// poll. Keep the records, qualify their state and prevent changes until a real
// successful read returns. The poll remains active so recovery needs no refresh.
let SERVER_ONLINE = true;
let LAST_REPROS_AT = 0;
function displayRepro(r) {
  if (SERVER_ONLINE) return r;
  return { ...r, state: "?", health: "unknown", uptime: "", containers: (r.containers || []).map((c) =>
    ({ ...c, state: "?", health: "unknown", status: "last known — server unavailable" })) };
}
const offlineControls = new WeakMap();
const MUTATING_CONTROLS = "#btn-new, #btn-prune, #actpane button, .d-actions button:not(.panetoggle), "
  + "#create-submit, #create-stop, #job-stop, #seed-submit, #seed-clear, #upgrade-go, #rollback-go, #owner-go, #restore-go, "
  + "#import-apply, #perf-submit, #cap-submit, #call-send, #passwd-go, #session-all, "
  + "#people-add-btn, #people-body button, #people-body select, #cluster-delete-go";
function paintAvailability() {
  const message = "Server unavailable — workspace state is unknown. Reconnecting automatically.";
  let banner = $("#server-unavailable");
  if (!SERVER_ONLINE && !banner) {
    banner = el("p", { id: "server-unavailable", class: "banner warn", role: "status" }, message);
    const panel = $("#detail");
    if (panel) panel.prepend(banner);
  }
  if (SERVER_ONLINE && banner) banner.remove();
  if (!SERVER_ONLINE) {
    for (const id of ["#edge-badge", "#cluster-badge"]) { const badge = $(id); if (badge) badge.hidden = true; }
  }
  const controls = [...document.querySelectorAll(MUTATING_CONTROLS)];
  if (VIEW === "workspace" && ["backups", "env"].includes(dstate.tab)) {
    controls.push(...document.querySelectorAll("#d-body button"));
  }
  for (const button of controls) {
    if (!SERVER_ONLINE) {
      if (!offlineControls.has(button)) offlineControls.set(button, button.disabled);
      button.disabled = true;
    } else if (offlineControls.has(button)) {
      button.disabled = offlineControls.get(button);
      offlineControls.delete(button);
    }
  }
  // A log stream keeps its buffer and DOM during an outage. Update just the
  // status chrome rather than closing and rebuilding the stream as a side effect.
  if (VIEW === "workspace" && dstate.detail && dstate.tab === "logs") {
    const d = displayRepro(dstate.detail), pill = $("#detail .d-head .pill"), dot = $("#detail .d-head .dot");
    if (pill) {
      pill.className = "pill " + stateClass(d.state);
      const text = SERVER_ONLINE ? d.state : "state unknown";
      if (pill.textContent !== text) pill.textContent = text;
    }
    if (dot) dot.className = "dot " + stateClass(d.state);
  }
}
function setServerOnline(online) {
  const changed = SERVER_ONLINE !== online;
  SERVER_ONLINE = online;
  if (changed) {
    ctx.render();
    if (VIEW === "workspace" && dstate.detail && dstate.tab !== "logs") ctx.renderDetail();
  }
  paintEngines();
  paintAvailability();
}
// Dialog builders can finish after the failed poll. Apply the same lock to the
// controls they add, without resetting controls that were already disabled.
new MutationObserver(() => { if (!SERVER_ONLINE) paintAvailability(); })
  .observe(document.body, { childList: true, subtree: true });

function goHome() {
  SELECTED = null;
  ctx.closeLogs();
  if (dstate.statsTimer) { clearInterval(dstate.statsTimer); dstate.statsTimer = null; }
  dstate.detail = null;
  setView("home");
  ctx.renderHome();
  ctx.render();
}
const view = { filter: "", status: "", sort: "name",
               scope: localStorage.getItem("rc_scope") || "all" };
// lifecycle.list_repros() reports "?" when docker is down, which is not a usable
// CSS class token (and had no rule), so those cards rendered unstyled.
const stateClass = (s) => (s === "?" ? "unknown" : s);
// Colour the health badge from HEALTH, not state: "Up 2 minutes (unhealthy)" is
// state=running + health=unhealthy, and colouring by state painted it GREEN.
const HEALTH_TONE = { running: "green", bad: "bad", warn: "warn", stopped: "warn" };
function healthClass(r) {
  const h = (r.health || "").toLowerCase();
  if (h.includes("unhealthy")) return "bad";
  // AMBER, not green. A degraded workspace is running -- something it needs is not --
  // so falling through to stateClass painted it green, which is this file's word for
  // "fine". Colour is a signal here, never decoration: amber is "wants you".
  if (h === "degraded") return "warn";
  if (h.includes("starting")) return "warn";
  if (h === "healthy" || h === "running") return "running";
  return stateClass(r.state);
}
let ME = "";                  // the signed-in user, "" when nobody is signed in
// A job that has not reached a terminal state. "queued" is one: heavy and
// measurement jobs wait for a slot before they start, and testing only for
// "running" made every one of them look like it had already finished.
const jobActive = (s) => s === "running" || s === "queued";
const dstate = { tab: "overview", detail: null, statsTimer: null, statsRefused: "", points: [], guideTab: "" };

// Restart counts already seen, keyed "<workspace>/<pod>". A restart COUNT is
// cumulative and says nothing about now: a microservices workspace whose
// ddp-streamer came up before NATS restarts two or three times during a normal boot
// and is then stable for days. Warning on the total meant "keeps restarting" -- present
// tense -- sat on a healthy workspace forever, which is how a banner teaches people to
// ignore it. `src/core/lifecycle/ready.ts`'s own boot watcher already had the right rule
// (`rc >= 2 && rc > seen.restarts`); this is that rule, on this side.
const RESTARTS_SEEN = {};

function restartsClimbing(workspace, service, count) {
  const key = `${workspace}/${service}`;
  const before = RESTARTS_SEEN[key];
  RESTARTS_SEEN[key] = count;
  return before !== undefined && count > before;
}

// ONE READ AT A TIME. The 4 s timer asked again whether or not the last read had answered,
// and on Kubernetes a read is several cluster round trips: against a slow cluster the
// page held eight reads open at once, measured, a queue that grew for as long as a read
// took more than 4 s. Calls that arrive while one runs share ONE more read after it, and
// are answered by that one -- they asked after the running read began, so it cannot know
// what their action changed.
let reproRead = null;
let reproNext = null;
function originOf(url) {
  try { return new URL(url).origin; } catch (_) { return ""; }
}
function loadRepros() {
  if (!reproRead) {
    reproRead = readRepros().finally(() => { reproRead = null; });
    return reproRead;
  }
  if (!reproNext) reproNext = reproRead.then(() => { reproNext = null; return loadRepros(); });
  return reproNext;
}
async function readRepros() {
  try {
    const [{ repros }, health] = await Promise.all([
      api("/api/repros"), api("/api/health").catch(() => ({ docker: false })),
    ]);
    const was = selectedSeen();
    ALL_REPROS = repros;
    if (GRAFANAS_AT_LOAD === null) {
      GRAFANAS_AT_LOAD = new Set(repros.filter((r) => r.grafana_url).map((r) => originOf(r.grafana_url)));
    }
    LAST_REPROS_AT = Date.now();
    const recovering = !SERVER_ONLINE;
    setServerOnline(true);
    ctx.refreshEdgeBadge();          // its own request: /api/health must stay cheap
    ctx.refreshClusterBadge();       // ditto, and it probes nothing -- see the note there
    // Identity comes from /api/session now, not from a field bolted onto
    // /api/health -- an endpoint left open for uptime checks should not be
    // reading credentials. Empty on a single-user box (no accounts, no login),
    // in which case the chip stays hidden and every card renders as it always has.
    try {
      const me = await api("/api/session");
      ACCOUNTS = !!me.accounts;
      ME = me.user || "";
      MY_ROLE = me.role || "";
      SSO_USER = me.sso_user || "";
    } catch (_) { /* signed out; api() has already redirected */ }
    // The top bar too: "+ New repro" and "Prune down" are member+, so a readonly
    // session should not be offered them at all.
    for (const [sel, ok] of [["#btn-new", canWrite()], ["#btn-prune", canWrite()]]) {
      const b = $(sel); if (b) b.hidden = !ok;
    }
    // Only worth offering once somebody else's workspaces can appear.
    const scope = $("#scope-filter");
    if (scope) {
      scope.hidden = !ME || !ALL_REPROS.some((r) => (r.owner || r.created_by) &&
                                                    (r.owner || r.created_by) !== ME);
      scope.value = view.scope;
    }
    const who = $("#whoami");
    // The houston name first: the chip's "@" is its, and an Okta username is usually
    // an email address, so "@ana.lopez@rocket.chat" read as nobody's.
    who.textContent = ME + (SSO_USER ? ` · ${SSO_USER}` : "")
      + (MY_ROLE && MY_ROLE !== "admin" ? ` · ${MY_ROLE}` : "");
    who.hidden = !ME;
    ctx.DOCKER_OK = !!health.docker;
    paintEngines();
    if (SELECTED && !ALL_REPROS.find((r) => r.name === SELECTED)) ctx.closeDetail();
    ctx.render();
    // The panel is read once, so it was a snapshot: a restart's job ends while Rocket.Chat
    // is still booting, and "Health starting" stayed on screen for minutes beside a rail
    // row that said running. Read it again when THIS workspace's state or health in the
    // list moves between two polls, including an ownership handover -- once per change,
    // not every four seconds: on a cluster a read is several round trips.
    // Only while the panel is the page: on
    // Activity or Scenarios a redraw would put it back over what is being read.
    if (VIEW === "workspace" && dstate.detail && selectedSeen() !== was) ctx.refreshDetail();
    ctx.refreshHome();
    if (recovering) ctx.refreshKube();
    if (recovering && dstate.logsReconnect) dstate.logsReconnect({ serverRecovered: true });
    paintAvailability();
  } catch (e) { setServerOnline(false); toast(e.message); }
}

// What the list says about the selected workspace, as one comparable string.
function selectedSeen() {
  const r = SELECTED && ALL_REPROS.find((x) => x.name === SELECTED);
  return r ? `${r.state}\n${r.health || ""}\n${r.owner || r.created_by || ""}` : "";
}

// ---- the two engines --------------------------------------------------------
// `KUBE` is fetched on its own, NOT on the four-second poll: `preflight()` shells out
// to kubectl several times, and /api/health is the cheap unauthenticated call every
// open tab makes. Same reasoning as the edge badge, and the same facts `doctor`
// reports, from the same probe -- so the footer and the report cannot disagree about
// which cluster you are on.
let KUBE = null;
// Whether the probe has answered at all. Until it has, KUBE is null and NOTHING is known:
// the footer said "k8s: not set up" for the half second before a working k3s was read,
// and a member opening Create in that window was told its cluster was unavailable.
let KUBE_READ = false;

async function refreshKube() {
  try { KUBE = await api("/api/kubernetes"); }
  catch (_) { KUBE = null; }                    // no permission, or no gui extra
  KUBE_READ = true;
  paintEngines();
  // The create dialog's cards read it too, and one open while it was in flight said
  // "Reading…" until it was closed and opened again.
  if (ctx.renderDestinations && $("#create-dialog") && $("#create-dialog").open) ctx.renderDestinations();
}

// The footer says what each ENGINE is doing; the header button says what it does.
// "docker: up" in the header was the whole environment when Docker was the only
// runtime -- it is one engine of two now, and a workspace can run in either.
function paintEngines() {
  if (!SERVER_ONLINE) {
    const footer = $("#sb-engines");
    if (footer) footer.textContent = "docker: ? · k8s: ? · server unavailable";
    const badge = $("#doctor-badge");
    if (badge) badge.className = "chip unknown";
    return;
  }
  const k = KUBE || {};
  // Pending is not absent: "?" until the probe answers, as the page ships it.
  const known = KUBE !== null || KUBE_READ;
  // CONTEXTS AND NONE CURRENT is not "not set up": the Clusters page lists them running.
  // Nor is a kubeconfig that could not be READ, which the Clusters page names with its reason.
  const kube = !known ? "?"
    : !k.usable ? (k.unreadable ? "kubeconfig unreadable"
      : k.tools_ready && !k.context && k.contexts ? "no current context" : "not set up")
    : k.reachable ? `${k.distribution || "cluster"} ${k.context || ""}`.trim()
    : k.can_provision ? "no cluster yet" : "no cluster";
  const el = $("#sb-engines");
  if (el) el.textContent = `docker: ${ctx.DOCKER_OK ? "up" : "down"} · k8s: ${kube}`;
  // Red only when NOTHING can run a workspace. Docker being down is not a broken box
  // on a machine whose Kubernetes is up, and saying so would be crying wolf at
  // somebody whose k3s is working perfectly.
  const badge = $("#doctor-badge");
  if (badge) {
    const dead = !ctx.DOCKER_OK && known && !(k.usable && k.reachable);
    badge.className = "chip " + (dead ? "down" : "up");
    badge.title = dead ? "Nothing here can run a workspace — run the environment check"
                       : "Run the environment check";
  }
}

Object.defineProperties(ctx, {
  "paintAvailability": { enumerable: true, get: () => paintAvailability },
  "displayRepro": { enumerable: true, get: () => displayRepro },
  "LAST_REPROS_AT": { enumerable: true, get: () => LAST_REPROS_AT },
  "SERVER_ONLINE": { enumerable: true, get: () => SERVER_ONLINE },
  "restoreLocation": { enumerable: true, get: () => restoreLocation },
  "saveLocation": { enumerable: true, get: () => saveLocation },
  "$": { enumerable: true, get: () => $ },
  "el": { enumerable: true, get: () => el },
  "toast": { enumerable: true, get: () => toast },
  "API_TIMEOUT_MS": { enumerable: true, get: () => API_TIMEOUT_MS, set: value => { API_TIMEOUT_MS = value; } },
  "ACCOUNTS": { enumerable: true, get: () => ACCOUNTS, set: value => { ACCOUNTS = value; } },
  "MY_ROLE": { enumerable: true, get: () => MY_ROLE, set: value => { MY_ROLE = value; } },
  "canWrite": { enumerable: true, get: () => canWrite },
  "canAdmin": { enumerable: true, get: () => canAdmin },
  "canChange": { enumerable: true, get: () => canChange },
  "ownerOf": { enumerable: true, get: () => ownerOf },
  "READONLY_WHY": { enumerable: true, get: () => READONLY_WHY },
  "SIGNING_OUT": { enumerable: true, get: () => SIGNING_OUT, set: value => { SIGNING_OUT = value; } },
  "toSignIn": { enumerable: true, get: () => toSignIn },
  "api": { enumerable: true, get: () => api },
  "apiForm": { enumerable: true, get: () => apiForm },
  "LOOPBACK_HOSTS": { enumerable: true, get: () => LOOPBACK_HOSTS },
  "isLoopbackHost": { enumerable: true, get: () => isLoopbackHost },
  "remoteHost": { enumerable: true, get: () => remoteHost },
  "remoteLoopback": { enumerable: true, get: () => remoteLoopback },
  "LOOPBACK_TITLE": { enumerable: true, get: () => LOOPBACK_TITLE },
  "WIDE_BINDS": { enumerable: true, get: () => WIDE_BINDS },
  "ALL_REPROS": { enumerable: true, get: () => ALL_REPROS, set: value => { ALL_REPROS = value; } },
  "GRAFANAS_AT_LOAD": { enumerable: true, get: () => GRAFANAS_AT_LOAD },
  "originOf": { enumerable: true, get: () => originOf },
  "SELECTED": { enumerable: true, get: () => SELECTED, set: value => { SELECTED = value; } },
  "VIEW": { enumerable: true, get: () => VIEW, set: value => { VIEW = value; } },
  "setView": { enumerable: true, get: () => setView },
  "goHome": { enumerable: true, get: () => goHome },
  "view": { enumerable: true, get: () => view },
  "stateClass": { enumerable: true, get: () => stateClass },
  "HEALTH_TONE": { enumerable: true, get: () => HEALTH_TONE },
  "healthClass": { enumerable: true, get: () => healthClass },
  "ME": { enumerable: true, get: () => ME, set: value => { ME = value; } },
  "jobActive": { enumerable: true, get: () => jobActive },
  "dstate": { enumerable: true, get: () => dstate },
  "RESTARTS_SEEN": { enumerable: true, get: () => RESTARTS_SEEN },
  "restartsClimbing": { enumerable: true, get: () => restartsClimbing },
  "loadRepros": { enumerable: true, get: () => loadRepros },
  "KUBE": { enumerable: true, get: () => KUBE, set: value => { KUBE = value; } },
  "KUBE_READ": { enumerable: true, get: () => KUBE_READ },
  "refreshKube": { enumerable: true, get: () => refreshKube },
  "paintEngines": { enumerable: true, get: () => paintEngines },
});
export { $, el, toast, ACCOUNTS, MY_ROLE, canWrite, canAdmin, canChange, ownerOf, READONLY_WHY, SIGNING_OUT, toSignIn, api, apiForm, LOOPBACK_HOSTS, isLoopbackHost, remoteHost, remoteLoopback, LOOPBACK_TITLE, WIDE_BINDS, ALL_REPROS, SELECTED, VIEW, setView, goHome, view, stateClass, HEALTH_TONE, healthClass, ME, jobActive, dstate, RESTARTS_SEEN, restartsClimbing, loadRepros, KUBE, refreshKube, paintEngines };
