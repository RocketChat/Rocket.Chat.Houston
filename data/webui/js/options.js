import { ctx } from "./shared.js";

// The create dialog's options, step 2: presets ticked from a list, each with its own
// settings; the license; what the version is; and the Rocket.Chat 9.0 notice. One state
// and one render, so the list, the panels and the notice never disagree.

// `ctx.el` sets every attribute it is given, so `checked: false` would tick a box: this
// one leaves out false and null, and flattens its children.
function node(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "class") n.className = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  n.append(...kids.flat().filter((x) => x != null && x !== false));
  return n;
}

const BUILD = /^(develop|pr-([1-9][0-9]{0,6}))(-(?:fips|cov))?(-gha-run-[0-9]{1,15})?$/u;
const RELEASE = /^(\d+)\.(\d+)\.(\d+)$/u;
const CANDIDATE = /^(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/u;
// What only a combination needs saying, in the dialog's words (the CLI prints its own).
const TWO_STORES = "Two separate user stores: directory users are user1…N, Keycloak users are sso-user1…N.";
const PAIR_NOTES = [
  [["email", "ldap"], "Email two-factor is on, and directory users' emails are verified, so a directory sign-in asks for a code: read it in Mailpit."],
  [["ldap", "saml"], TWO_STORES],
  [["ldap", "oidc"], TWO_STORES],
];

let S = fresh();
function fresh() {
  // `params` holds only what was CHANGED: an untouched control shows its default and sends
  // nothing, so the request says exactly what the person chose.
  return { presets: new Set(), params: {}, license: "", licFile: "", licOpen: false, version: null };
}
const P = (p) => (S.params[p] ||= {});
const ticked = (n) => S.presets.has(n);
const catalogue = () => (ctx.PRESETS || []).filter((p) => p.name !== "default");
const presetOf = (name) => (ctx.PRESETS || []).find((p) => p.name === name) || { params_help: {} };
const runtime = () => (ctx.$("#runtime-value") && ctx.$("#runtime-value").value) || "docker";
const firstSentence = (d) => (/^.*?[.!?](?=\s|$)/u.exec(d || "") || [d || ""])[0];
// "(default houston-uploads)" -> "houston-uploads"; nothing when the default is a phrase.
function defaultOf(help) {
  const m = /\(default ([^;,)]+)/u.exec(help || "");
  const v = m ? m[1].trim().replace(/^'(.*)'$/u, "$1") : "";
  return /\s/u.test(v) ? "" : v;
}

function whyOff(name) {
  const p = presetOf(name);
  if (runtime() === "kubernetes" && p.kubernetes === false) return "Not on Kubernetes";
  const rival = { saml: "oidc", oidc: "saml" }[name];
  if (rival && ticked(rival)) return "One sign-in provider per workspace";
  return "";
}
// voice's SIP options: each needs the one before it, and all of them Docker. A hidden one is
// not sent either, or a value typed before switching place would have the create refused.
const voiceOn = (key) => P("voice")[key] === "on";
function voiceShown(key) {
  if (key === "ice_servers") return true;
  if (runtime() === "kubernetes") return false;
  if (key === "sip_integration") return true;
  return key === "freeswitch_dialplans" ? voiceOn("sip_integration") && voiceOn("pbx") : voiceOn("sip_integration");
}
// ldap's own single sign-on follows a ticked saml or oidc preset: one Keycloak per workspace.
const keycloakPreset = () => ticked("saml") || ticked("oidc");
const ldapIdp = () => (ticked("saml") ? "saml" : ticked("oidc") ? "oidc" : P("ldap").idp || "none");
function signInKinds() {
  const k = [];
  if (ticked("ldap")) k.push("LDAP");
  if (ticked("saml") || (ticked("ldap") && ldapIdp() === "saml")) k.push("SAML");
  if (ticked("oidc") || (ticked("ldap") && ldapIdp() === "oidc")) k.push("OIDC");
  return k;
}
const andJoin = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);
const presetText = () => [...S.presets].sort().join(" + ");
const may = () => ctx.MAY_SET_PRIVILEGED === true;

// ---- the version ----------------------------------------------------------------
function kindOf(v) {
  const b = BUILD.exec(v);
  if (b) return { kind: "ci", pr: b[2] || "" };
  const r = RELEASE.exec(v) || CANDIDATE.exec(v);
  if (r) return { kind: r.length > 4 ? "rc" : "release", major: +r[1] };
  return { kind: v ? "other" : "empty" };
}
// The release the 9.0 notice goes by: the version itself, or a CI build's base, once the
// server has read it from the build's package.json.
function baseMajor() {
  const s = S.version;
  if (!s) return null;
  if (s.kind === "release" || s.kind === "rc") return s.major;
  if (s.kind === "ci" && s.answer && s.answer.rc_version) return parseInt(s.answer.rc_version, 10);
  return null;
}
const baseRelease = (rcVersion) => String(rcVersion || "").replace(/\.dev\d+$/u, "");

let versionTimer = null;
function onVersion(value) {
  const v = value.trim();
  S.version = { v, ...kindOf(v), answer: null, error: "" };
  clearTimeout(versionTimer);
  renderVersion();
  renderPresets();
  if (S.version.kind === "empty") return;
  // Asked 400 ms after typing stops: which MongoDB, a CI build's base release, and whether
  // this engine can run that MongoDB, before committing to a multi-GB pull.
  versionTimer = setTimeout(async () => {
    const asked = v;
    try {
      const r = await ctx.api(`/api/versions/${encodeURIComponent(v)}`);
      if (S.version && S.version.v === asked) S.version.answer = r;
    } catch (err) {
      if (S.version && S.version.v === asked) S.version.error = err.message;
    }
    renderVersion();
    renderPresets();
  }, 400);
}

function renderVersion() {
  const out = ctx.$("#version-hint");
  const s = S.version;
  ctx.$("#version-pill").hidden = !s || s.kind !== "ci";
  out.replaceChildren();
  out.className = "hint";
  if (!s || s.kind === "empty") return;
  if (s.error) { out.textContent = s.error; out.className = "hint bad"; return; }
  const a = s.answer;
  const mongo = a ? ` · MongoDB ${a.mongo_tag}` : "";
  if (s.kind === "release" || s.kind === "rc") {
    out.append(`${s.kind === "rc" ? "Release candidate" : "Release"} ${s.v}${mongo}`);
  } else if (s.kind === "ci") {
    out.append("Built by Rocket.Chat's CI ");
    if (s.pr) {
      out.append("for ", node("a", { href: `https://github.com/RocketChat/Rocket.Chat/pull/${s.pr}`,
        target: "_blank", rel: "noreferrer" }, `pull request #${s.pr}`));
    } else out.append("as the latest develop build");
    out.append(node("br"), "Pulled fresh on every create: ",
      node("code", {}, `ghcr.io/rocketchat/rocket.chat:${s.v}`), node("br"));
    if (a) {
      out.append(`Based on ${baseRelease(a.rc_version)} (from ${s.pr ? "the pull request's" : "develop's"} `
        + `package.json), so MongoDB ${a.mongo_tag}`);
    } else out.append(node("span", { class: "looking" }, "Looking up its base release…"));
    // The server refuses a CI build from whoever it refuses the image field from, and the
    // image field on this same step says so; this said nothing until Create was refused.
    if (!may()) {
      out.append(node("br"), "Limited to admins on this server (", node("code", {}, "gui.create_policy admin"), ").");
    }
  } else {
    out.append("Not a release or a CI build");
  }
  // The engine-kernel conflict the server found, said where the version is typed.
  if (a && a.warning) { out.append(node("br"), a.warning); out.className = "hint bad"; }
}

// ---- the license ------------------------------------------------------------------
function renderLicense() {
  const has = S.license !== "";
  ctx.$("#lic-pill").hidden = !has;
  ctx.$("#lic-add").hidden = has || S.licOpen;
  ctx.$("#lic-add").disabled = !may();
  ctx.$("#lic-cancel").hidden = !S.licOpen;
  ctx.$("#lic-b").hidden = !S.licOpen;
  ctx.$("#lic-sum").hidden = !has || S.licOpen;
  ctx.$("#lic-policy").hidden = may();
  // Masked: its length and last four characters, never the text.
  ctx.$("#lic-sum-t").replaceChildren(`License added${S.licFile ? ` from ${S.licFile}` : ""} · `
    + `${S.license.length.toLocaleString("en-US")} characters · `, node("code", {}, "…" + S.license.slice(-4)));
}
function openLicense() {
  if (!may()) return;
  S.licOpen = true;
  renderLicense();
  ctx.$("#lic").scrollIntoView({ block: "center" });
  ctx.$("#lic-text").focus();
}
// The box closes as soon as a license is in it: pasted, or read from a file.
function commitLicense(text, file = "") {
  const t = String(text || "").trim();
  if (!t) return;
  Object.assign(S, { license: t, licFile: file, licOpen: false });
  ctx.$("#lic-text").value = "";
  ctx.$("#lic-file").value = "";
  renderLicense();
  renderPresets();
}
function openToken() {
  const adv = ctx.$("#create-dialog details.adv");
  if (adv) adv.open = true;
  const t = ctx.$("#create-form").reg_token;
  if (t) { t.scrollIntoView({ block: "center" }); t.focus(); }
}

// ---- the presets ------------------------------------------------------------------
function renderPresets() {
  // A preset this place cannot take does not stay ticked from the last place.
  for (const name of [...S.presets]) if (whyOff(name) === "Not on Kubernetes") S.presets.delete(name);
  ctx.$("#plist").replaceChildren(...catalogue().map(({ name, description }) => {
    const why = whyOff(name);
    return node("label", { class: "prow" + (why ? " off" : "") },
      node("input", { type: "checkbox", name: "preset", value: name, checked: ticked(name), disabled: !!why }),
      node("span", { class: "prow-t" }, node("span", { class: "prow-n" }, name),
        node("span", { class: "prow-d", title: description }, firstSentence(description))),
      why ? node("span", { class: "prow-why" }, why) : null);
  }));
  ctx.$("#pnone").hidden = S.presets.size > 0;
  const combo = ctx.$("#pcombo");
  combo.hidden = S.presets.size < 2;
  combo.replaceChildren("Combined: ", node("b", {}, presetText()),
    ...[...new Set(PAIR_NOTES.filter(([pair]) => pair.every(ticked)).map(([, note]) => note))]
      .map((note) => node("p", {}, note)));
  // A 9.x release (or a CI build based on one), a sign-in preset, and nothing licensing it.
  const major = baseMajor(), kinds = signInKinds();
  const token = ctx.$("#create-form").reg_token;
  const v9 = ctx.$("#v9");
  v9.hidden = !(major >= 9 && kinds.length && !S.license && !(token && token.value.trim()));
  v9.replaceChildren(
    `Rocket.Chat 9.0 and later require a Premium plan for ${andJoin(kinds)} sign-in. `
    + "Without a license or a registration token, those sign-ins are refused. ",
    node("button", { type: "button", class: "linkbtn", onclick: openLicense, disabled: !may() }, "Add a license"), " or a ",
    node("button", { type: "button", class: "linkbtn", onclick: openToken }, "registration token"), ".");
  ctx.$("#ppanels").replaceChildren(...[...S.presets].sort().map(paramPanel).filter(Boolean));
  if (ctx.$("#create-foot-hint") && ctx.$("#create-step-2") && !ctx.$("#create-step-2").hidden) {
    ctx.$("#create-foot-hint").textContent = ctx.createSummaryLine();
  }
}

// One settings row: the label on the left, the control and its hint on the right.
const row = (label, ...v) => [node("div", { class: "k" }, label), node("div", { class: "v" }, ...v)];
const num = (p, key, dflt) => node("input", { class: "num", type: "number", min: "1",
  value: P(p)[key] ?? dflt, "data-p": p, "data-k": key });
const txt = (p, key, placeholder) => node("input", { class: "txt", value: P(p)[key] ?? "", placeholder,
  "data-p": p, "data-k": key });
// A checkbox stores the param's own words: on/off, houston/none, true/false.
const check = (p, key, [yes, no], dflt, text, opt) => node("label", { class: "ck" },
  node("input", { type: "checkbox", checked: (P(p)[key] ?? dflt) === yes, "data-p": p, "data-k": key,
    "data-yes": yes, "data-no": no }),
  node("span", {}, text, opt ? node("span", { class: "opt" }, " " + opt) : null));
function seg(p, key, options, { value = P(p)[key] ?? options[0][0], disabled = false } = {}) {
  return node("div", { class: "seg" + (disabled ? " off" : ""), role: "group" },
    ...options.map(([v, label]) => node("button", { type: "button", "aria-pressed": String(v === value),
      disabled, "data-p": p, "data-k": key, "data-v": v }, label)));
}
const hint = (text) => node("p", { class: "hint" }, text);
// Every key without a designed control: a text field for `--set key=value`, labelled by
// the key, with the catalogue's help under it -- what this dialog has always offered.
const plain = (p, key, help) => row(node("code", {}, key), txt(p, key, defaultOf(help)), hint(help));

const DESIGNED = {
  // Rocket.Chat's own setting names, as Workspace > Settings > End-to-end encryption shows them.
  e2ee: {
    policy: () => row("Policy", seg("e2ee", "policy", [["optional", "Optional"], ["default", "On by default"], ["enforced", "Enforced"]]),
      hint({ default: "New DMs and private rooms start encrypted; people may turn it off.",
        enforced: "New private rooms must be encrypted. Needs Rocket.Chat 8.8.0 or later." }[P("e2ee").policy]
        ?? "People choose encryption for each DM or private room.")),
    users: () => row("Test users", check("e2ee", "users", ["on", "off"], "on",
      "e2e-alice, e2e-bob and e2e-carol", "(password = username)")),
    files: () => row("Files", check("e2ee", "files", ["on", "off"], "on", "Encrypt files")),
    allow_unencrypted: () => row("Plaintext", check("e2ee", "allow_unencrypted", ["on", "off"], "off",
      "Unencrypted messages in encrypted rooms")),
  },
  ldap: {
    users: () => row("Users", num("ldap", "users", "5")),
    domain: () => row("Domain", txt("ldap", "domain", "example.com")),
    directory: () => row("Directory", seg("ldap", "directory", [["openldap", "OpenLDAP"], ["ad", "Active Directory"]]),
      hint(P("ldap").directory === "ad" ? "Samba answering as Active Directory: sAMAccountName, objectGUID, nested groups"
        : "OpenLDAP, with phpLDAPadmin to browse it")),
    groups: () => row("Groups", check("ldap", "groups", ["on", "off"], "off",
      "Lab groups: rocket-chat, rocket-admin, employee; only rocket-chat may sign in")),
    bind: () => row("Bind", seg("ldap", "bind", [["admin", "Admin"], ["service", "Read-only service account"]]),
      P("ldap").bind === "service" && P("ldap").directory !== "ad"
        ? hint("Limited to 500 entries per search, as many real directories are.") : null),
    tls: () => row("Encryption", seg("ldap", "tls", [["none", "None"], ["ldaps", "LDAPS"], ["starttls", "StartTLS"]]),
      (P("ldap").tls ?? "none") === "none" ? null
        : check("ldap", "trust", ["houston", "none"], "houston", "Trust houston's certificate authority",
          "(untick to see an untrusted certificate)")),
    trust: () => [],
    idp: () => row("Single sign-on", seg("ldap", "idp", [["none", "None"], ["saml", "SAML"], ["oidc", "OIDC"]],
      { value: ldapIdp(), disabled: keycloakPreset() }),
      keycloakPreset() ? hint("Uses the same Keycloak as the saml/oidc preset") : null,
      ldapIdp() === "none" || keycloakPreset() ? null
        : check("ldap", "mfa", ["on", "off"], "off", "Ask for a one-time code (TOTP) at sign-in")),
    mfa: () => [],
    // Only for ldap's own Keycloak: with a saml/oidc preset ticked, that panel's idp_host decides.
    idp_host: (help) => ((P("ldap").idp ?? "none") === "none" || keycloakPreset() ? [] : plain("ldap", "idp_host", help)),
  },
  saml: { users: () => row("Users", num("saml", "users", "5")) },
  oidc: { users: () => row("Users", num("oidc", "users", "5")) },
  email: { verification: () => row("Verification", check("email", "verification", ["true", "false"], "false",
    "Require email verification on new accounts")) },
  s3_minio: { presigned: () => row("Presigned URLs", check("s3_minio", "presigned", ["true", "false"], "false",
    "Serve downloads from presigned MinIO URLs, not through Rocket.Chat (your browser must "
    + "reach MinIO directly; breaks over HTTPS)")) },
  // Each option is labelled as Rocket.Chat's settings and compose files name it, and its --set
  // key is the same words, so a lab built here is repeated on the command line word for word.
  // Each SIP option opens once the one it needs is on; on Kubernetes none is offered.
  voice: {
    sip_integration: () => (runtime() === "kubernetes"
      ? row("SIP integration", hint("SIP integration and the PBX run on Docker only. Calls between users work here."))
      : row("SIP integration", check("voice", "sip_integration", ["on", "off"], "off", "Drachtio (signaling gateway) and FreeSWITCH (SIP provider)",
        "(dial numbers, take calls from a PBX)"),
      voiceOn("sip_integration") ? hint("voice-alice and voice-bob get Voice call extensions 1001 and 1002. Dial 123 to hear yourself.") : null)),
    voip_domain: () => (voiceShown("voip_domain") ? row("VoIP domain", txt("voice", "voip_domain", "freeswitch (a browser on this server only)"),
      hint("VOIP_DOMAIN in rocketchat-compose: the address browsers and phones send RTP audio to. For a browser on another computer: this server's LAN or public IP, or a name that points straight at it.")) : []),
    rtp_ports: () => (voiceShown("rtp_ports") ? row("RTP ports", txt("voice", "rtp_ports", "20000-20046"),
      hint("UDP, start-end, at most 200 (VOIP_RTP_START_PORT to VOIP_RTP_END_PORT). A second SIP workspace on this server needs its own range.")) : []),
    pbx: () => (voiceShown("pbx") ? row("PBX", check("voice", "pbx", ["on", "off"], "off",
      "A lab PBX (Asterisk)", "(desk phones, ring groups, an outside caller)"),
      voiceOn("pbx") ? hint("Connected to FreeSWITCH's external profile the way compose.freeswitch.external.yml connects external calls.") : null) : []),
    freeswitch_dialplans: () => (voiceShown("freeswitch_dialplans") ? row("FreeSWITCH dialplans",
      seg("voice", "freeswitch_dialplans", [["stock", "stock"], ["edit", "edit"]]),
      hint(P("voice").freeswitch_dialplans === "edit"
        ? "edit: public.xml and drachtio.xml as editable copies in the workspace folder, kept across rebuilds and backups."
        : "stock: as FreeSWITCH writes them. edit: editable copies in the workspace folder.")) : []),
    ice_servers: () => row("ICE servers", txt("voice", "ice_servers", "Rocket.Chat's own"),
      hint("Rocket.Chat's ICE servers setting (WebRTC settings): stun:, turn: or turns:host:port, comma-separated; user:password@ is allowed and shown masked. Empty keeps Rocket.Chat's own (Google STUN).")),
  },
};
const ORDER = { ldap: ["users", "domain", "directory", "groups", "bind", "tls", "trust", "idp", "mfa", "idp_host"],
  e2ee: ["policy", "users", "files", "allow_unencrypted"],
  voice: ["sip_integration", "voip_domain", "rtp_ports", "pbx", "freeswitch_dialplans", "ice_servers"] };

function paramPanel(name) {
  const help = presetOf(name).params_help || {}, keys = Object.keys(help);
  if (!keys.length) return null;
  const first = (ORDER[name] || []).filter((k) => keys.includes(k));
  const designed = DESIGNED[name] || {};
  const rows = [...first, ...keys.filter((k) => !first.includes(k))]
    .map((k) => (designed[k] ? designed[k](help[k]) : plain(name, k, help[k])));
  return node("section", { class: "ppanel" }, node("div", { class: "ppanel-h" }, name),
    node("div", { class: "prm" }, ...rows.flat()));
}

// ---- what the create sends ------------------------------------------------------------
// One preset: `preset` and its params as `--set` keys, as this dialog has always sent.
// Several: `presets` and each one's params under its own name. ldap's own single sign-on is
// left out when a saml/oidc preset already brings the Keycloak.
function optionsRequest() {
  const names = [...S.presets].sort();
  const paramsOf = (p) => {
    const out = {};
    for (const [k, v] of Object.entries(S.params[p] || {})) {
      if (String(v).trim() === "") continue;
      if (p === "ldap" && keycloakPreset() && ["idp", "mfa", "idp_host"].includes(k)) continue;
      if (p === "voice" && !voiceShown(k)) continue;
      out[k] = String(v).trim();
    }
    return out;
  };
  const req = names.length > 1
    ? { presets: names, params: Object.fromEntries(names.map((p) => [p, paramsOf(p)])) }
    : { preset: names[0] || "default", params: names[0] ? paramsOf(names[0]) : {} };
  if (S.license) req.license = S.license;
  return req;
}

function initOptions(preset) {
  S = fresh();
  if (preset && preset !== "default" && catalogue().some((p) => p.name === preset)) S.presets.add(preset);
  ctx.$("#lic-text").value = "";
  ctx.$("#lic-file").value = "";
  onVersion(ctx.$("#create-form").version.value);
  renderOptions();
}
function renderOptions() { renderVersion(); renderLicense(); renderPresets(); }

// ---- events -----------------------------------------------------------------------
const form = ctx.$("#create-form");
form.addEventListener("change", (e) => {
  const t = e.target;
  if (t.name === "preset" && t.closest("#plist")) {
    if (t.checked) S.presets.add(t.value); else S.presets.delete(t.value);
    renderPresets();
  } else if (t.dataset.p && t.type === "checkbox") {
    P(t.dataset.p)[t.dataset.k] = t.checked ? t.dataset.yes : t.dataset.no;
    renderPresets();
  } else if (t.id === "lic-file" && t.files[0]) {
    const file = t.files[0];
    file.text().then((text) => commitLicense(text, file.name));
  }
});
form.addEventListener("input", (e) => {
  const t = e.target;
  if (t.name === "version") onVersion(t.value);
  else if (t.name === "reg_token") renderPresets();
  else if (t.dataset.p && t.type !== "checkbox") P(t.dataset.p)[t.dataset.k] = t.value;
});
form.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.v && b.dataset.p && !b.disabled) { P(b.dataset.p)[b.dataset.k] = b.dataset.v; renderPresets(); }
  else if (b.id === "lic-add" || b.id === "lic-replace") openLicense();
  else if (b.id === "lic-cancel") { S.licOpen = false; ctx.$("#lic-text").value = ""; renderLicense(); }
  else if (b.id === "lic-remove") { Object.assign(S, { license: "", licFile: "" }); renderLicense(); renderPresets(); }
});
ctx.$("#lic-text").addEventListener("paste", () => setTimeout(() => commitLicense(ctx.$("#lic-text").value), 0));
ctx.$("#lic-text").addEventListener("blur", () => commitLicense(ctx.$("#lic-text").value));

Object.defineProperties(ctx, {
  "initOptions": { enumerable: true, get: () => initOptions },
  "renderOptions": { enumerable: true, get: () => renderOptions },
  "optionsRequest": { enumerable: true, get: () => optionsRequest },
  "optionsPresetText": { enumerable: true, get: () => presetText },
});
export { initOptions, renderOptions, optionsRequest, presetText as optionsPresetText };
