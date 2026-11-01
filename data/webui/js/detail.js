import { ctx } from "./shared.js";

// ---- env vars ----------------------------------------------------------------
// FETCHED, not read out of the detail payload. detail() answers this from the
// generated compose file, and a Kubernetes workspace has no such file -- there the
// answer is read out of the running container, which can also legitimately refuse
// ("it is not running"). Hanging that off detail() would let one unreadable
// environment break the whole panel, so the tab asks for it itself and renders the
// refusal in place of the table. Before this the tab simply rendered EMPTY on
// Kubernetes, because the key it read was never in the payload.
async function renderEnv(body, d) {
  const kube = d.runtime === "kubernetes";
  const list = ctx.el("div", {}, ctx.el("p", { class: "empty" }, "loading…"));
  body.append(list);

  let rows = null;
  let doc = null;
  try {
    doc = await ctx.api(`/api/repros/${encodeURIComponent(d.name)}/env`);
    rows = doc.env || [];
  } catch (e) {
    list.innerHTML = "";
    list.append(ctx.el("p", { class: "empty pre" }, String(e.message || e)));
    return;
  }
  list.innerHTML = "";
  // No third column on Kubernetes: it held the remove button, and an empty column
  // under a blank heading reads as a table that failed to render something.
  const head = ctx.el("tr", {}, ctx.el("th", {}, "name"), ctx.el("th", {}, "value"));
  if (!kube) head.append(ctx.el("th", {}, ""));
  const t = ctx.el("table", { class: "dtable" }, head);
  // SAID BEFORE THE TABLE. A recorded value the container is not running was drawn
  // exactly like one it is, which confirms a setting that is not in effect — on the
  // question this tab exists to answer.
  if (doc && doc.drift && doc.drift.length) {
    list.append(ctx.el("p", { class: "banner warn" },
      `${doc.drift.length} recorded value(s) are not what the container is running `
      + `(${doc.drift.join(", ")}). Rocket.Chat is using the old value — set it again `
      + "to re-apply and recreate the container."));
  } else if (doc && doc.live_read === false) {
    // "No drift reported" and "drift could not be checked" are different, and only
    // one of them is reassuring.
    list.append(ctx.el("p", { class: "banner" },
      "The container could not be read, so this is the recorded configuration "
      + "rather than a statement about what is running."));
  }
  for (const e of rows) {
    // Two kinds live in this list and they are not interchangeable: a Rocket.Chat
    // SETTING only works with the OVERWRITE_SETTING_ prefix, a plain env var only
    // works without it. Show the setting id itself and tag it, rather than a wall
    // of OVERWRITE_SETTING_* that hides which is which.
    const isSetting = e.key.startsWith(ENV_SETTING_PREFIX);
    const shown = isSetting ? e.key.slice(ENV_SETTING_PREFIX.length) : e.key;
    const name = ctx.el("td", {}, shown);
    if (isSetting) name.append(ctx.el("span", { class: "pill small" }, "setting"));
    if (e.override) name.append(ctx.el("span", { class: "yours" }, "*"));
    // AMBER, because it wants you: this value is recorded and Rocket.Chat is not
    // running it. Shown per row as well as in the banner, so the one that disagrees
    // is identifiable in a list of forty.
    if (e.drift) name.append(ctx.el("span", { class: "pill small stopped" }, "not live"));
    const act = kube ? null : ctx.el("td", {});
    // No remove button on Kubernetes: the server refuses every write here and says
    // to use helm, so the button could only ever produce a red toast. A control
    // that cannot succeed is worse than no control -- the same rule that keeps the
    // logs and env TABS off a readonly user's panel.
    if (act) {
      act.append(ctx.el("button", {
        class: "btn small danger",
        title: e.override ? "Remove this override" : "Remove this variable from the workspace",
        // The FULL key, not the displayed one — that is what compose holds.
        onclick: () => doEnvChange(d.name, {}, {}, [e.key]),
      }, "remove"));
    }
    const row = ctx.el("tr", {}, name, ctx.el("td", { class: "v" }, e.value));
    if (act) row.append(act);
    t.append(row);
  }
  list.append(t);
  if (!rows.length) list.append(ctx.el("p", { class: "empty" }, "No environment variables."));

  if (kube) {
    // Read from the CONTAINER here, which is a different (and better) source than
    // Compose's file -- the chart contributes variables houston never set, and they
    // are all in this list. Say so, because "* = set by you" would otherwise imply
    // the rest came from houston.
    list.append(ctx.el("p", { class: "hint" },
      "Read live out of the Rocket.Chat container, so this includes what the Helm "
      + "chart sets as well as what houston asked for. * = an override houston "
      + "recorded."));
    list.append(ctx.el("p", { class: "hint pre" },
      "Changing one needs a Helm upgrade, run by someone with a shell on the server "
      + "(there is no button for it here):\n"
      + `  helm -n houston-${d.name} upgrade rocketchat --reuse-values --set extraEnv[0].name=KEY --set extraEnv[0].value=VALUE\n`
      + "For a Rocket.Chat SETTING, use Send an API call instead — that takes effect "
      + "without restarting anything."));
    return;
  }

  list.append(ctx.el("p", { class: "hint" },
    "* = set by you. Changing anything here recreates the Rocket.Chat container — "
    + "MongoDB keeps running, so no data is lost."));

  const kind = ctx.el("select", { class: "input", "aria-label": "kind" },
    ctx.el("option", { value: "setting" }, "Rocket.Chat setting"),
    ctx.el("option", { value: "env" }, "Plain env var"));
  const key = ctx.el("input", { class: "input", placeholder: "Message_AllowEditing", "aria-label": "name" });
  const val = ctx.el("input", { class: "input", placeholder: "false", "aria-label": "value" });
  const why = ctx.el("p", { class: "hint" }, "");
  const explain = () => {
    const setting = kind.value === "setting";
    key.placeholder = setting ? "Message_AllowEditing" : "MY_FLAG";
    val.placeholder = setting ? "false" : "true";
    why.textContent = setting
      ? "Anything you would change in Admin → Settings. The OVERWRITE_SETTING_ prefix"
        + " it needs is added for you — without it Rocket.Chat ignores the variable"
        + " silently. Re-applied on every boot, but the admin UI can still change it"
        + " while the container runs."
      : "A real environment variable (MONGO_URL, NODE_ENV, a feature flag). Passed"
        + " through exactly as typed.";
  };
  kind.addEventListener("change", explain);
  explain();
  const add = ctx.el("button", { class: "btn primary", onclick: () => {
    const k = key.value.trim();
    if (!k) { ctx.toast("enter a name"); return; }
    const payload = { [k]: val.value };
    doEnvChange(d.name, kind.value === "env" ? payload : {},
                kind.value === "setting" ? payload : {}, []);
  } }, "Set + restart");
  list.append(ctx.el("div", { class: "row2" }, kind, key, val, add), why);
}


// ---- backup / restore / upgrade ------------------------------------------------
// A backup is a bundle: the database PLUS the version, preset and parameters that
// produced it. That is what lets "Restore as new" rebuild a whole workspace from
// one file rather than needing a matching repro to already exist.

const fmtBytes = (n) => {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0, v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v.toFixed(0) : v.toFixed(1)) + " " + u[i];
};
const shortName = (p) => String(p || "").split("/").pop();

async function renderBackups(body, d) {
  body.append(ctx.el("p", { class: "hint" },
    "Backups hold this workspace's Rocket.Chat database (messages, users, settings, and files "
    + "stored in it) plus its version and preset. Data held by the preset's extra services "
    + "(MinIO files, LDAP or Keycloak users, Mailpit mail) is not included."));
  if (ctx.canChange(d)) {
    const attrs = ctx.SERVER_ONLINE ? {} : { disabled: "" };
    body.append(ctx.el("div", { class: "row2" },
      ctx.el("button", { ...attrs, class: "btn primary", onclick: () => doBackup(d.name) }, "Back up now")));
  }
  const list = ctx.el("div", {}, ctx.el("p", { class: "empty" }, "loading…"));
  body.append(list);

  let rows = [];
  try {
    rows = (await ctx.api(`/api/backups?name=${encodeURIComponent(d.name)}`)).backups || [];
  } catch (e) {
    list.innerHTML = ""; list.append(ctx.el("p", { class: "empty" }, String(e.message || e)));
    return;
  }
  list.innerHTML = "";
  if (!rows.length) {
    list.append(ctx.el("p", { class: "empty" }, "No backups yet for this workspace."));
    return;
  }
  list.append(backupTable(rows, d.name, ctx.canChange(d)));
}

// One table for both places bundles are listed: a workspace's Backups tab (`here` names
// that workspace) and the Backups page (`here` is ""), which lists every bundle on the box.
// `mine`: this viewer may change the workspace `here` names (its owner, or an admin).
function backupTable(rows, here, mine = false) {
  const cols = here ? ["bundle", "from", "size", ""] : ["bundle", "workspace", "from", "size", ""];
  const t = ctx.el("table", { class: "dtable" },
    ctx.el("tr", {}, ...cols.map((c) => ctx.el("th", {}, c))));
  for (const b of rows) {
    if (b.error) {
      t.append(ctx.el("tr", {}, ctx.el("td", {}, shortName(b.path)),
        ctx.el("td", { class: "v bad", colspan: String(cols.length - 1) }, "unreadable: " + b.error)));
      continue;
    }
    const label = ctx.el("td", {}, shortName(b.path));
    if (b.label) label.append(ctx.el("span", { class: "pill small" }, b.label));
    const row = ctx.el("tr", {}, label);
    if (!here) {
      // A fact, not a state: no colour.
      const ws = ctx.el("td", { class: "v" }, b.repro || "?");
      if (b.repro && !ctx.ALL_REPROS.some((r) => r.name === b.repro)) {
        ws.append(ctx.el("span", { class: "pill small plain" }, "deleted"));
      }
      row.append(ws);
    }
    row.append(ctx.el("td", { class: "v" }, `RC ${b.rc_version}`),
      ctx.el("td", { class: "v" }, fmtBytes(b.bytes)));
    const act = ctx.el("td", {});
    if (here && mine) {
      act.append(
        ctx.el("button", { class: "btn small primary", onclick: () => doRestore(b, here) }, "restore"),
        ctx.el("button", { class: "btn small", onclick: () => openRestoreNew(b) }, "as new"),
        ctx.el("button", { class: "btn small danger", onclick: () => doDeleteBackup(b) }, "delete"));
    } else if (!here && ctx.canWrite()) {
      // A colleague's bundle restored as new would copy their data and admin login, so the
      // server refuses it to anyone but its owner and admins; the Backups page offers it
      // and the refusal names the owner.
      act.append(ctx.el("button", { class: "btn small primary", onclick: () => openRestoreNew(b) },
        "restore as new"));
    }
    row.append(act);
    t.append(row);
  }
  return t;
}

// ---- every backup on this server ------------------------------------------------
// Bundles OUTLIVE the workspace they came from, and the Backups tab lives on that
// workspace's panel: once it was deleted, nothing in the GUI listed its bundles, and
// restoring one as new -- the one way back -- could not be reached. Read from the same
// call `houston backups` makes.
async function openBackups() {
  ctx.setView("backups");
  ctx.$(".panes").classList.add("no-detail");
  ctx.$("#actpane").innerHTML = "";
  const panel = ctx.$("#detail");
  panel.innerHTML = "";
  const body = ctx.el("div", { class: "home-body" }, ctx.el("p", { class: "empty" }, "loading…"));
  panel.append(ctx.el("div", { class: "home-head" }, ctx.el("h1", {}, "Backups"),
    ctx.el("p", {}, "Every backup on this server, deleted workspaces' included. Restoring "
      + "one as new rebuilds its workspace: the version, the preset and the data.")), body);
  let rows;
  try { rows = (await ctx.api("/api/backups")).backups || []; }
  catch (e) { body.innerHTML = ""; body.append(ctx.el("p", { class: "empty" }, String(e.message || e))); return; }
  if (ctx.VIEW !== "backups") return;                   // a newer view won the race
  body.innerHTML = "";
  body.append(rows.length ? backupTable(rows, "")
    : ctx.el("p", { class: "empty" }, "No backups on this server yet. Back one up from its workspace's panel."));
}

async function doBackup(name) {
  const note = prompt(`Back up ${name}\n\nRocket.Chat is stopped while its database is copied, `
    + "then started again.\n\nOptional note stored in the bundle:", "");
  if (note === null) return;
  try {
    const { job_id } = await ctx.api(`/api/repros/${encodeURIComponent(name)}/backup`,
      { method: "POST", body: JSON.stringify({ label: note }) });
    ctx.streamJob(job_id, `Backing up ${name}`, (res) => {
      ctx.toast(`backed up to ${shortName(res && res.path)}`, "ok");
    });
  } catch (e) { ctx.toast(e.message); }
}

async function doRestore(b, into) {
  // Ask the SERVER whether this is allowed before offering the button's action:
  // a downgrade is refused, and an older-into-newer restore is a migration the
  // user has to opt into. Learning that after a job started is too late.
  let verdict = null;
  try {
    verdict = (await ctx.api("/api/backups/compatibility", {
      method: "POST", body: JSON.stringify({ bundle: b.path, name: into }),
    })).compatibility;
  } catch (e) { ctx.toast(String(e.message || e), "bad"); return; }
  if (verdict && !verdict.allowed) { ctx.toast(verdict.blocked_reason, "bad"); return; }
  const lines = [`Restore ${shortName(b.path)} into ${into}.`,
    "", "Existing collections are DROPPED — this replaces the data, it does not merge."];
  for (const w of ((verdict && verdict.warnings) || [])) lines.push("", "⚠ " + w);
  if (!confirm(lines.join("\n"))) return;
  try {
    const { job_id } = await ctx.api("/api/restore", {
      method: "POST",
      body: JSON.stringify({
        bundle: b.path, name: into, new: false,
        allow_upgrade: !!(verdict && verdict.requires_flag === "allow_upgrade"),
      }),
    });
    ctx.streamJob(job_id, `Restoring ${shortName(b.path)} into ${into}`,
      // No refresh here: finishJob re-reads the list and the panel once this returns. A
      // bare `refresh()` named nothing, threw, and skipped that re-read.
      (res) => { ctx.toast(`restored ${(res && res.name) || ""}`, "ok"); });
  } catch (e) { ctx.toast(e.message); }
}

// ---- restore as new ------------------------------------------------------------
// A dialog rather than a confirm, because it may have to say who can use the bundle. The
// bundle's scenario is built again on side ports of its own: while another workspace holds
// the preferred ones (usually the very one the backup came from) the copy gets the next free
// ones, so nothing about them stands in the way.
let RESTORE = null;
async function openRestoreNew(b) {
  let refusal = "";
  try {
    const answer = await ctx.api("/api/backups/compatibility", {
      method: "POST", body: JSON.stringify({ bundle: b.path }),
    });
    refusal = answer.refusal || "";       // the server's own answer: only the owner or an admin
  } catch (e) { ctx.toast(String(e.message || e), "bad"); return; }
  RESTORE = b;
  ctx.$("#restore-what").textContent = `A new workspace from ${shortName(b.path)}: `
    + `Rocket.Chat ${b.rc_version}${b.preset ? `, ${b.preset}` : ""}, with the data it holds.`;
  // Shown but not offered to someone the server would refuse, saying who can.
  const go = ctx.$("#restore-go");
  go.disabled = !!refusal;
  go.title = refusal ? `${refusal[0].toUpperCase()}${refusal.slice(1)}.` : "";
  ctx.$("#restore-dialog").showModal();
}

async function submitRestoreNew() {
  const b = RESTORE;
  ctx.$("#restore-dialog").close();
  try {
    const { job_id } = await ctx.api("/api/restore", {
      method: "POST", body: JSON.stringify({ bundle: b.path, name: "", new: true }),
    });
    // finishJob re-reads the list and the panel; the Backups page is drawn from the list
    // too (which workspaces are deleted), so it is drawn again once the list is read.
    ctx.streamJob(job_id, `Restoring ${shortName(b.path)} as a new workspace`, (res) => {
      ctx.toast(`restored ${(res && res.name) || ""}`, "ok");
      if (ctx.VIEW === "backups") ctx.loadRepros().then(openBackups);
    });
  } catch (e) { ctx.toast(e.message); }
}

async function doDeleteBackup(b) {
  if (!confirm(`Delete ${shortName(b.path)}?\n\nThis cannot be undone.`)) return;
  try {
    await ctx.api(`/api/backups?path=${encodeURIComponent(b.path)}`, { method: "DELETE" });
    ctx.toast("backup deleted", "ok");
    ctx.renderTab();
  } catch (e) { ctx.toast(String(e.message || e), "bad"); }
}

// ---- roll back the last upgrade ----------------------------------------------------
// Offered only when the panel's read says one can be made (`rollback_to`) and this viewer
// passes the ownership gate. Red, because the database is replaced with the backup's.
let ROLLBACK_TARGET = "";
function openRollback(d) {
  ROLLBACK_TARGET = d.name;
  ctx.$("#rollback-title").textContent = `Roll back ${d.name} to ${d.rollback_to}`;
  ctx.$("#rollback-what").textContent = `${d.name} goes back to Rocket.Chat ${d.rollback_to}, `
    + `and its database is replaced with the backup taken before it was upgraded to `
    + `${d.rc_version}. Everything that happened in it since (messages, users, settings) is lost.`;
  ctx.$("#rollback-dialog").showModal();
}

async function submitRollback() {
  const name = ROLLBACK_TARGET;
  ctx.$("#rollback-dialog").close();
  try {
    const { job_id } = await ctx.api(`/api/repros/${encodeURIComponent(name)}/upgrade/rollback`,
      { method: "POST", body: JSON.stringify({}) });
    // finishJob re-reads the list and the panel, so the version and this control follow.
    ctx.streamJob(job_id, `Rolling ${name} back`, (res) => {
      ctx.toast(`rolled back to ${(res && res.rolled_back_to) || "the earlier version"}`, "ok");
    });
  } catch (e) { ctx.toast(e.message); }
}

// ---- hand over ----------------------------------------------------------------------
// POST /api/repros/{name}/owner. The new owner is who may delete it, roll it back and
// hand it on. An admin picks from the people list, which only an admin may read; anyone
// else types the name. A refusal is the server's own words, said in the dialog.
let OWNER_TARGET = "";
async function openHandOver(d) {
  OWNER_TARGET = d.name;
  let names = [];
  if (ctx.canAdmin()) {
    try { names = ((await ctx.api("/api/users")).users || []).map((u) => u.name); }
    catch (_) { names = []; }                         // the name field still works
  }
  names = names.filter((n) => n !== d.owner);
  ctx.$("#owner-title").textContent = `Hand over ${d.name}`;
  ctx.$("#owner-now").textContent = (d.owner
    ? `It belongs to ${d.owner === ctx.ME ? "you" : d.owner}. ` : "Nobody owns it yet. ")
    + "After this, only the new owner and admins can change it: start, stop, logs, login, "
    + "delete or hand it on. Unless you are an admin, you can then only look. Who made it, "
    + "and who held it before, stay in its history.";
  const pick = ctx.$("#owner-pick");
  pick.innerHTML = "";
  for (const n of names) pick.append(ctx.el("option", { value: n }, n));
  ctx.$("#owner-pick-row").hidden = !names.length;
  ctx.$("#owner-to-row").hidden = !!names.length;
  ctx.$("#owner-to").value = "";
  ctx.$("#owner-err").hidden = true;
  ctx.$("#owner-dialog").showModal();
}

async function submitHandOver() {
  const err = ctx.$("#owner-err");
  const to = (ctx.$("#owner-pick-row").hidden ? ctx.$("#owner-to").value : ctx.$("#owner-pick").value).trim();
  err.hidden = true;
  if (!to) { err.textContent = "Name who it goes to."; err.hidden = false; return; }
  try {
    const r = await ctx.api(`/api/repros/${encodeURIComponent(OWNER_TARGET)}/owner`,
      { method: "POST", body: JSON.stringify({ to }) });
    ctx.$("#owner-dialog").close();
    ctx.toast(`${r.name} now belongs to ${r.to}`, "ok");
    await ctx.loadRepros();
    if (ctx.SELECTED === r.name) await ctx.refreshDetail({ force: true });
  } catch (e) {
    err.textContent = String(e.message || e); err.hidden = false;
  }
}

let UPGRADE_TARGET = "";
function openUpgrade(name, current) {
  UPGRADE_TARGET = name;
  ctx.$("#upgrade-title").textContent = `Upgrade: ${name}`;
  ctx.$("#upgrade-current").textContent = current || "?";
  ctx.$("#upgrade-to").value = "";
  ctx.$("#upgrade-plan").textContent = "";
  ctx.$("#upgrade-plan").className = "hint";
  ctx.$("#upgrade-go").disabled = true;
  ctx.$("#upgrade-dialog").showModal();
}

async function checkUpgradePlan() {
  const to = ctx.$("#upgrade-to").value.trim();
  const out = ctx.$("#upgrade-plan"), go = ctx.$("#upgrade-go");
  go.disabled = true;
  if (!to) { out.textContent = ""; out.className = "hint"; return; }
  out.textContent = "checking…"; out.className = "hint";
  try {
    const s = await ctx.api(`/api/repros/${encodeURIComponent(UPGRADE_TARGET)}/upgrade`
      + `?to=${encodeURIComponent(to)}`);
    if (!s.can_upgrade) { out.textContent = s.reason; out.className = "hint bad"; return; }
    const p = s.plan || {};
    if (!p.allowed) { out.textContent = p.blocked_reason; out.className = "hint bad"; return; }
    const bits = [`${p.from_version} → ${p.to_version}`,
                  `MongoDB ${p.from_mongo}` + (p.from_mongo === p.to_mongo ? "" : ` → ${p.to_mongo}`)];
    out.textContent = bits.join(" · ") + (p.warnings || []).map((w) => "\n⚠ " + w).join("");
    out.className = (p.warnings || []).length ? "hint warn" : "hint ok";
    go.disabled = false;
  } catch (e) {
    out.textContent = String(e.message || e); out.className = "hint bad";
  }
}

async function submitUpgrade() {
  const to = ctx.$("#upgrade-to").value.trim();
  const noBackup = ctx.$("#upgrade-nobackup").checked;
  const name = UPGRADE_TARGET;
  ctx.$("#upgrade-dialog").close();
  if (noBackup && !confirm(
    "Without a pre-upgrade backup there is nothing to roll back to if the "
    + "migrations fail.\n\nContinue?")) return;
  try {
    const { job_id } = await ctx.api(`/api/repros/${encodeURIComponent(name)}/upgrade`,
      { method: "POST", body: JSON.stringify({ to, no_backup: noBackup }) });
    ctx.streamJob(job_id, `Upgrading ${name} to ${to}`, (res) => {
      const errs = (res && res.migration_errors) || [];
      ctx.toast(errs.length
        ? `upgraded to ${res.to_version} with ${errs.length} migration error(s)`
        : `upgraded to ${(res && res.to_version) || to}`, errs.length ? "warn" : "ok");
    });
  } catch (e) { ctx.toast(e.message); }
}

// ---- env vars ---------------------------------------------------------------
// An env var cannot change inside a running container, so this recreates the
// Rocket.Chat service. It goes through streamJob because that recreate takes
// seconds to tens of seconds -- long enough that a silent button looks broken.
const ENV_SETTING_PREFIX = "OVERWRITE_SETTING_";

// `setting` is kept separate from `set` all the way to the server, which adds the
// OVERWRITE_SETTING_ prefix. The browser deliberately does not prepend it, so the
// rule lives in exactly one place.
function doEnvChange(name, set, setting, unset) {
  const changed = Object.keys(set).concat(Object.keys(setting)).concat(unset).join(", ");
  if (unset.length && !confirm(`Remove ${unset.join(", ")} from ${name}?\n\n`
      + "This recreates the Rocket.Chat container. Data is kept.")) return;
  return ctx.runAction(name, "Env", async () => {
    const { job_id } = await ctx.api(`/api/repros/${name}/env`,
      { method: "POST", body: JSON.stringify({ set, setting, unset }) });
    ctx.streamJob(job_id, `Env change on ${name}: ${changed}`);
  });
}


Object.defineProperties(ctx, {
  "renderEnv": { enumerable: true, get: () => renderEnv },
  "fmtBytes": { enumerable: true, get: () => fmtBytes },
  "shortName": { enumerable: true, get: () => shortName },
  "renderBackups": { enumerable: true, get: () => renderBackups },
  "backupTable": { enumerable: true, get: () => backupTable },
  "openBackups": { enumerable: true, get: () => openBackups },
  "openRestoreNew": { enumerable: true, get: () => openRestoreNew },
  "submitRestoreNew": { enumerable: true, get: () => submitRestoreNew },
  "openRollback": { enumerable: true, get: () => openRollback },
  "submitRollback": { enumerable: true, get: () => submitRollback },
  "openHandOver": { enumerable: true, get: () => openHandOver },
  "submitHandOver": { enumerable: true, get: () => submitHandOver },
  "doBackup": { enumerable: true, get: () => doBackup },
  "doRestore": { enumerable: true, get: () => doRestore },
  "doDeleteBackup": { enumerable: true, get: () => doDeleteBackup },
  "UPGRADE_TARGET": { enumerable: true, get: () => UPGRADE_TARGET, set: value => { UPGRADE_TARGET = value; } },
  "openUpgrade": { enumerable: true, get: () => openUpgrade },
  "checkUpgradePlan": { enumerable: true, get: () => checkUpgradePlan },
  "submitUpgrade": { enumerable: true, get: () => submitUpgrade },
  "ENV_SETTING_PREFIX": { enumerable: true, get: () => ENV_SETTING_PREFIX },
  "doEnvChange": { enumerable: true, get: () => doEnvChange },
});
export { renderEnv, fmtBytes, shortName, renderBackups, backupTable, openBackups, openRestoreNew, submitRestoreNew, openRollback, submitRollback, openHandOver, submitHandOver, doBackup, doRestore, doDeleteBackup, UPGRADE_TARGET, openUpgrade, checkUpgradePlan, submitUpgrade, ENV_SETTING_PREFIX, doEnvChange };
