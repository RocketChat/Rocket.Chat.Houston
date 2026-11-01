import { ctx } from "./shared.js";

// ---- home ------------------------------------------------------------------
// What the stage shows when nothing is selected. It used to say "Select a
// workspace", which answers a question nobody asked.
//
// It leads with CAPACITY because that is what actually limits this tool: `up`
// refuses without headroom, and seven concurrent stacks once OOM-killed a 10 GB
// host with every individual create having succeeded. "Room for about 2 more" is
// the sentence that decides what you do next; a row of totals would look like a
// dashboard and say nothing.
let HOME = { cap: null, at: 0 };
const HOME_EVERY = 15000;

async function refreshHome(force) {
  if (!force && Date.now() - HOME.at < HOME_EVERY) return;
  HOME.at = Date.now();
  const cap = await ctx.api("/api/machine").catch(() => null);
  if (cap) { HOME.cap = cap; ctx.MACHINE_ROOM = cap; }
  // What an EKS cluster wants arrives with the overview, after Home is drawn.
  if (ctx.loadClusterOverview) {
    ctx.loadClusterOverview(!!force).then((ov) => {
      if (ov && ctx.VIEW === "home" && !ctx.SELECTED) renderHome();
    }).catch(() => {});
  }
  // `!SELECTED` is not the same question as "is Home on screen". Activity and
  // Scenarios are stage views with no workspace selected, so this timer repainted
  // the stage with Home underneath whatever you were reading -- the page appearing
  // to navigate itself, seconds after you opened it. render() has always asked the
  // right question (VIEW === "home"); this never got the same fix.
  if (ctx.VIEW === "home" && !ctx.SELECTED) renderHome();
}

// Where a workspace runs, in the words the Clusters page uses for the place.
function whereOf(r) {
  if ((r.runtime || "docker") !== "kubernetes") return "Docker";
  const row = ((ctx.CLUSTERS && ctx.CLUSTERS.contexts) || []).find((c) => c.context === r.context);
  const short = (row && row.short) || String(r.context || r.cluster || "").split("/").pop();
  if (row && ctx.clWhere(row, ctx.CLSTATE.status[row.context]) === "aws") return `${short} · EKS`;
  return short ? `Kubernetes · ${short}` : "Kubernetes";
}

// One running workspace, on Home. The name opens the WORKSPACE (this tool's page about
// it); Open goes to Rocket.Chat itself -- two different places, so two targets.
function runningRow(r) {
  const health = String(r.health || "").toLowerCase();
  const bad = health && !["healthy", "running", "starting"].includes(health);
  return ctx.el("div", { class: "drow" },
    ctx.el("span", { class: "ldot" + (bad ? " bad" : "") }),
    ctx.el("button", { class: "t-btn grow", type: "button", title: `Open ${r.name} in houston`, onclick: () => selectRepro(r.name) },
      ctx.el("div", { class: "t" }, r.name),
      ctx.el("div", { class: "m" }, [r.rc_version, r.preset || "default", whereOf(r)].filter(Boolean).join(" · "))),
    ctx.el("span", { class: "m" + (bad ? " warn" : "") }, bad ? health : (r.uptime || "")),
    ctx.el("a", { class: "btn sm", href: r.open_url || r.root_url, target: "_blank", rel: "noreferrer",
      title: ctx.remoteLoopback(r.open_url || r.root_url) ? ctx.LOOPBACK_TITLE : "Open Rocket.Chat itself, in a new tab" }, "Open"));
}

// It leads with what limits this tool: `up` refuses without headroom, so "room for
// about 2 more" is the sentence that decides what you do next.
function capacityCard(cap) {
  const box = ctx.el("div", { class: "hcard dash capcard" }, ctx.el("h3", {}, "Memory on this server"));
  if (!cap || !cap.known) {
    box.append(ctx.el("p", { class: "m", style: "margin:0;font-family:var(--sans);font-size:13px" },
      "houston reads /proc/meminfo, which this server does not have — so it "
      + "cannot say how much room is left, and `up` will not refuse on memory here."));
    return box;
  }
  const usedMb = Math.max(0, cap.total_mb - cap.available_mb);
  const pct = (n) => Math.max(0, Math.min(100, (n / cap.total_mb) * 100));
  const gb = (mb) => (mb / 1024).toFixed(1);
  box.append(ctx.el("div", {}, ctx.el("span", { class: "big" }, `${gb(usedMb)} GB`), " ",
    ctx.el("span", { class: "wh", style: "font-size:14px" }, `of ${gb(cap.total_mb)} GB in use`)));
  box.append(ctx.el("div", { class: "bar" },
    ctx.el("i", { class: "used", style: `width:${pct(usedMb)}%;background:var(--accent-fill)` }),
    ctx.el("i", { class: "reserved", style: `width:${pct(cap.reserve_mb)}%;background:var(--line2)`, title: "kept back for the server itself" })));
  const kube = (cap.room_by_runtime || {})["kubernetes-microservices"];
  const tight = cap.room < 1;
  box.append(ctx.el("div", { class: "wh" + (tight ? " warn" : ""), style: "font-size:13px" + (tight ? ";color:var(--amber)" : "") },
    tight ? "Not enough room for another workspace on this server."
      : `Room for about ${cap.room} more on Docker` + (typeof kube === "number" ? `, or ${kube} more on Kubernetes.` : ".")));
  return box;
}

// What wants somebody, and only that. Amazon EKS comes from the overview Home already
// reads -- no call of its own.
function attentionItems() {
  const out = [];
  if (!ctx.DOCKER_OK) {
    out.push(["Docker is not answering",
      "Nothing can start, stop or report state until it is back.", ctx.openDoctor, "Check"]);
  }
  const broken = ((ctx.EDGE && ctx.EDGE.routes) || []).filter((r) => !r.reachable);
  for (const r of broken) {
    out.push([`${r.name}'s HTTPS address is not connected`,
      "It answers 502 (Bad Gateway). The workspace may be fine; the shared HTTPS front "
      + "door has lost its connection to it.", ctx.openEdge, "HTTPS details"]);
  }
  // Not one with an action in flight: an unfinished create reads `down`, and Home asked
  // for attention about a workspace that was still being made.
  for (const r of ctx.ALL_REPROS.filter((x) => x.state === "down" && !ctx.pendingOn(x.name))) {
    out.push([`${r.name} is down`,
      `It still holds port :${r.host_port} and its data volume.`,
      () => selectRepro(r.name), "Review"]);
  }
  // clRows, not the raw list: a cluster still being built is the build's item below, and
  // listing its own warning beside it said the same cluster twice.
  const aws = ctx.clRows("aws");
  const sign = ctx.awsSignIn ? ctx.awsSignIn() : { state: "unknown" };
  if (aws.length && sign.state === "expired") {
    const names = aws.map((r) => r.short || r.context).join(", ");
    out.push(["The server's AWS sign-in has expired",
      `Houston can't check ${names} or what ${aws.length === 1 ? "it costs" : "they cost"} until someone signs in again on the server.`,
      ctx.canAdmin() ? () => ctx.openEksSetup() : null, "Fix"]);
  } else {
    for (const r of aws) {
      const st = ctx.CLSTATE.status[r.context];
      const warn = ctx.placeWarn(st);
      if (!warn) continue;
      const name = `${r.short || r.context} (Amazon EKS)`;
      const day = ctx.perDay(st);
      const bills = day ? `It keeps billing ~$${day.toFixed(2)} a day until someone deletes it.` : "It keeps billing until someone deletes it.";
      const d = st.expires_in_days;
      // The DNS record is its own item with its own button: a first-time user does not know
      // a built cluster needs one, and "Review" did not say that this was the next step.
      if (/^Public names under/u.test(warn)) {
        out.push([`${name} needs a DNS record`,
          `Workspaces on it get public names under ${st.zone} once one record (a CNAME) answers. Add it once, at your DNS provider.`,
          () => ctx.clOpenDns(r), "Set up DNS"]);
        continue;
      }
      const [title, why] = !st.reachable ? [`${name} is not answering`, warn]
        : typeof d === "number" && d < 0 ? [`${name} is past its reminder date`, bills]
        : d === 0 ? [`${name} reaches its reminder date today`, bills]
        : /^Holds no workspaces/u.test(warn) ? [`${name} holds no workspaces`, `It still bills ~$${(day || 0).toFixed(2)} a day until someone deletes it.`]
        : [`${name} wants you`, warn];
      out.push([title, why, () => ctx.openPlace(`eks:${r.context}`), "Review"]);
    }
  }
  for (const j of ctx.CLSTATE.jobs.filter((x) => x.kind === "cluster-create")) {
    out.push([`${j.label || "A cluster"} is being built`, "About 20 minutes in all. It is already billing.",
      () => ctx.openClusters(), "View"]);
  }
  for (const b of (ctx.CLSTATE.overview && ctx.CLSTATE.overview.failed) || []) {
    if (b.present === false) continue;
    out.push([`The build of ${b.name} failed part-way`, "It may still be billing. Delete what it left.",
      () => ctx.openClusters(), "Review"]);
  }
  return out;
}

function renderHome() {
  const panel = ctx.$("#detail");
  // The entrance plays once, when Home arrives -- not on every four-second repaint.
  const fresh = !panel.querySelector(".pv.home");
  panel.innerHTML = "";
  const box = ctx.el("div", { class: "pv home" + (fresh ? " anim" : "") });
  if (!ctx.SERVER_ONLINE) {
    box.append(ctx.el("h1", {}, "Your workspaces"), ctx.el("p", { class: "banner warn" },
      "Server unavailable — workspace state and available capacity are unknown."));
    panel.append(box);
    return;
  }
  const hour = new Date().getHours();
  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  box.append(ctx.el("h1", {}, ctx.ME ? `Good ${part}, ${ctx.ME}` : "Your workspaces"), ctx.el("p", { class: "sub" }));
  if (!ctx.ALL_REPROS.length) {
    box.append(ctx.canWrite()
      ? ctx.el("div", { class: "hcard dash welcome", id: "home-welcome" },
        ctx.el("h2", {}, "Create your first workspace"),
        ctx.el("p", {}, "A workspace is a Rocket.Chat of the version you choose, with its own MongoDB and any services it needs, such as LDAP, SAML or email."),
        ctx.el("button", { class: "btn solid", type: "button", onclick: () => ctx.openCreate() }, "+ Create a workspace"),
        ctx.el("p", { class: "small" }, "First you pick where it runs, then the Rocket.Chat version. Docker on this server is free and right for most workspaces."))
      : ctx.el("div", { class: "hcard dash" }, ctx.el("p", { style: "margin:0;color:var(--muted)" },
        "No workspaces yet. Workspaces your team creates appear here.")));
  }
  const items = attentionItems();
  if (items.length) {
    const card = ctx.el("div", { class: "hcard dash", id: "home-needs" },
      ctx.el("h3", {}, ctx.el("span", { class: "need" }, "Needs you"), ctx.el("span", {}, String(items.length))));
    for (const [title, why, fn, label] of items) {
      card.append(ctx.el("div", { class: "drow att" },
        ctx.el("span", { class: "need" }, "▲"),
        ctx.el("div", { class: "grow" }, ctx.el("div", { class: "t" }, title), ctx.el("div", { class: "why" }, why)),
        fn ? ctx.el("button", { class: "btn sm", type: "button", onclick: fn }, label) : ""));
    }
    box.append(card);
  }
  if (ctx.ALL_REPROS.length) {
    const running = ctx.ALL_REPROS.filter((r) => r.state === "running");
    const card = ctx.el("div", { class: "hcard dash", id: "home-running" },
      ctx.el("h3", {}, "Running now", ctx.el("span", { class: "mono", style: "letter-spacing:0;text-transform:none" }, `${running.length} of ${ctx.ALL_REPROS.length}`)));
    if (running.length) for (const r of running) card.append(runningRow(r));
    else card.append(ctx.el("p", { style: "color:var(--muted);margin:0" }, "Nothing is running."));
    box.append(card);
  }
  box.append(capacityCard(HOME.cap));
  panel.append(box);
}


// ---- scenarios --------------------------------------------------------------
// Where a preset's notes finally live. They were printed by `up` and `info` and
// shown nowhere in the browser -- which for `oidc` means a GUI-only user could
// not discover that the scenario does not work at all until an /etc/hosts line
// exists. The notes are pre-wrapped for an 80-column terminal, so they are set
// in a <pre> and allowed to scroll rather than re-flowed into a narrow column.
async function openScenarios() {
  ctx.setView("scenarios");
  ctx.$(".panes").classList.add("no-detail");
  ctx.$("#actpane").innerHTML = "";
  const panel = ctx.$("#detail");
  panel.innerHTML = "";
  const head = ctx.el("div", { class: "home-head" }, ctx.el("h1", {}, "Presets"),
    ctx.el("p", {}, "What each one adds to a plain Rocket.Chat, and what you have to do to use it."));
  const body = ctx.el("div", { class: "home-body" });
  body.append(ctx.el("p", { class: "empty" }, "loading…"));
  panel.append(head, body);
  let list;
  try { list = (await ctx.api("/api/presets")).presets || []; }
  catch (e) { body.innerHTML = ""; body.append(ctx.el("p", { class: "empty" }, e.message)); return; }
  if (ctx.VIEW !== "scenarios") return;                 // a newer view won the race
  body.innerHTML = "";
  for (const s of list) {
    const card = ctx.el("div", { class: "hcard scen" });
    const h = ctx.el("div", { class: "hcard-h" }, ctx.el("b", {}, s.name));
    if (s.requires_license) h.append(ctx.el("span", { class: "pill small" }, "needs a license"));
    card.append(h);
    const inner = ctx.el("div", { class: "scen-b" });
    if (s.description) inner.append(ctx.el("p", { class: "scen-d" }, s.description));
    if (s.notes && s.notes.length) {
      inner.append(ctx.el("div", { class: "section-label" }, "Using this preset"));
      inner.append(ctx.noteBlock(s.notes));
    }
    card.append(inner);
    const foot = ctx.el("div", { class: "scen-f" },
      ctx.el("span", {}, s.ports && s.ports.length
        ? (s.ports.length > 1 ? "Prefers ports " : "Prefers port ") + s.ports.join(", ")
          + (s.ports.length > 1 ? ", or the next free ones" : ", or the next free one")
        : "No extra ports"));
    if (ctx.canWrite()) {
      foot.append(ctx.el("button", { class: "btn small", onclick: () => ctx.openCreate(s.name) },
        "Create a workspace with this"));
    }
    card.append(foot);
    body.append(card);
  }
}


// One grouped note, as a card. Three kinds of content and each gets the treatment
// it needs rather than all three arriving as bullets:
//
//   rows      facts. A key/value table -- "Cluster: kind-x" was three facts welded
//             into a sentence, and a sentence is the wrong shape for a lookup.
//   body      what a reader needs to KNOW. Still read through the notes pattern's
//             three shapes, so a place line is still a link row and an indented
//             line is still a copyable box.
//   commands  what a reader has to PASTE. Its own block with a Copy button, never
//             prose -- these were buried mid-paragraph.
function noteGroupCard(g, items, shown) {
  const rows = g.rows || [], cmds = g.commands || [];
  // A place this workspace's link table ALREADY lists is not a second place: the
  // monitoring notes name Grafana and Prometheus, and both are link rows, so without
  // this the same two urls appear once as rows and again as prose one card below.
  const body = (items || []).filter((i) => !(shown && shown.has(i)));
  if (!rows.length && !body.length && !cmds.length) return null;
  const card = ctx.el("div", { class: "panelcard" });
  if (g.title) {
    card.append(ctx.el("div", { class: "panelcard-h" },
      ctx.el("span", { class: "section-label flat" }, g.title)));
  }
  if (rows.length) {
    const t = ctx.el("table", { class: "notetable" });
    for (const [k, v] of rows) {
      t.append(ctx.el("tr", {}, ctx.el("th", {}, k), ctx.el("td", {}, String(v))));
    }
    card.append(t);
  }
  if (body.length || cmds.length) {
    const box = ctx.el("div", { class: "panelcard-b notes" });
    // The body went through the SAME parser the ungrouped notes use, so the three
    // shapes hold inside a group and nothing about that pattern is re-decided here.
    if (body.length) ctx.renderNoteItems(box, body);
    for (const c of cmds) {
      box.append(ctx.el("div", { class: "note-cmd" },
        ctx.el("code", {}, c),
        ctx.el("button", { class: "cp", onclick: () => ctx.copy(c) }, "Copy")));
    }
    card.append(box);
  }
  return card;
}

// Every note this workspace has, parsed once, group by group. Parsed HERE rather
// than inside each card because the link rows are enriched from these: a note naming
// a place the links already list is the rest of what is known about that one row, not
// a second row -- and the notes it can come from are no longer all in one group.
function noteItemsByGroup(d) {
  const groups = d.note_groups || [];
  // A workspace whose record has no groups keeps its whole story in the scenario
  // card, exactly as before groups existed.
  if (!groups.length) {
    return [{ g: { kind: "scenario" }, items: ctx.parseNotes(d.notes || []) }];
  }
  return groups.map((g) => ({ g, items: ctx.parseNotes(g.body || []) }));
}



// The Scenario card: what this workspace adds beyond a plain Rocket.Chat, where
// those things are, and what you have to do to use them — in one block instead of
// a "Where things are" list and a "Using this scenario" list that never referred
// to each other.
function scenarioCard(d, parsed, shown) {
  const card = ctx.el("div", { class: "panelcard" });
  // Title it by what is actually IN it. A plain workspace with monitoring
  // attached has links and notes but no scenario, and calling that block
  // "Scenario · default" described the preset field rather than the contents.
  const scenario = d.preset && d.preset !== "default" ? d.preset : "";
  const head = ctx.el("div", { class: "panelcard-h" },
    ctx.el("span", { class: "section-label flat" },
      scenario
        ? "Preset · " + (Array.isArray(d.presets) && d.presets.length > 1 ? d.presets.join(" + ") : scenario)
        : "What is in this workspace"));
  if (scenario) {
    head.append(ctx.el("button", { class: "linkbtn", onclick: openScenarios },
      "About this preset ↗"));
  }
  card.append(head);

  // A command that is NOT a url is something you must set up before the scenario
  // works at all -- `oidc` is broken until 127.0.0.1 keycloak is in /etc/hosts.
  // A command that IS a url is just a place to go, and colouring that as a warning
  // would be crying wolf.
  //
  // But "not a url" was not narrow enough either, and this block makes two specific
  // CLAIMS -- that the scenario cannot work until the line exists, and that it needs
  // sudo. `ldap`'s notes indent a phpLDAPadmin credential, so the panel was telling
  // an ldap reader to sudo their way through "log in with DN cn=admin,dc=example,
  // dc=com / admin" before the scenario would work, which is not true of anything.
  // The discriminator is the sentence that INTRODUCES the line, and it is already in
  // the note above it: a hosts entry is the only setup step any preset has.
  // Grouped or not, this card's prose is the SCENARIO's prose. Ungrouped that is
  // the whole flat list; grouped it is the one group marked as the scenario, and the
  // rest are cards of their own below. Reading d.notes in the grouped case would put
  // every Kubernetes fact through here a second time.
  const own = parsed.find((x) => x.g.kind === "scenario");
  const items = own ? own.items : [];
  // Presets that wrote a guide (every one of this workspace's, or none): the card reads
  // the guide, with its own setup box, instead of their prose.
  const guides = own ? (own.g.guides || []) : [];
  const introduced = (item) => {
    const before = items[items.indexOf(item) - 1];
    const text = before && before.kind === "prose" ? (before.lines || []).join(" ") : "";
    return /\/etc\/hosts/i.test(text);
  };
  const setup = guides.length ? null : items.find((i) => i.kind === "cmd"
                                  && !/^https?:\/\//.test(i.value)
                                  && introduced(i));
  if (setup) {
    card.append(ctx.el("div", { class: "setup" },
      ctx.el("span", { class: "setup-i" }, "▲"),
      ctx.el("span", { class: "setup-t" },
        ctx.el("b", {}, "For a browser on this server: do this once"),
        ctx.el("span", { class: "setup-w" },
          "This preset cannot work until the line below exists. Needs sudo."),
        ctx.el("code", {}, setup.value)),
      ctx.el("button", { class: "cp", onclick: () => ctx.copy(setup.value) }, "Copy")));
  }

  // A note that names a place the link table ALREADY lists is not a second place,
  // it is the rest of what is known about that one. Monitoring is the plain case:
  // the links say where Grafana is, and the notes say the same thing again plus
  // the password — which is how the same three urls came to be on screen twice,
  // once as rows and once as prose.
  const key = (u) => String(u || "").replace(/\/+$/, "");
  const byUrl = new Map();
  // Across EVERY group, not just this card's own prose. Monitoring's Grafana line
  // lives in the Monitoring group now, and it is still the same row as the Grafana
  // link -- password included, which is the part the link row does not know.
  for (const { items: its } of parsed) {
    for (const it of its) if (it.kind === "place") byUrl.set(key(it.url), it);
  }
  for (const l of d.links || []) {
    const note = byUrl.get(key(l.url));
    if (note) shown.add(note);
    card.append(ctx.placeRow({ label: l.label, url: l.url, kind: l.kind,
                           what: note ? note.what : "", creds: note ? note.creds : "",
                           sub: note ? note.sub : "" }));
  }
  // Read from another computer, a localhost link opens there, where nothing runs.
  if ([d.open_url || d.root_url, d.grafana_url, ...(d.links || []).map((l) => l.url),
       ...items.filter((i) => i.kind === "place").map((i) => i.url)].some(ctx.remoteLoopback)) {
    card.append(ctx.el("div", { class: "panelcard-b" }, ctx.el("p", { class: "hint", id: "links-loopback" },
      "Links to localhost open on YOUR computer; only a browser on this server can open them. "
      + "A workspace created with HTTPS gets public links (Mailpit at /mailpit/, and so on).")));
  }

  if (guides.length) {
    // Every place the notes name stays a link row, as before; only the prose moves to the guide.
    const places = items.filter((i) => i.kind === "place" && !shown.has(i));
    if (places.length) card.append(ctx.renderNoteItems(ctx.el("div", { class: "panelcard-b notes" }), places));
    card.append(guideBlock(d, guides));
    return card;
  }
  const rest = items.filter((i) => i !== setup && !shown.has(i));
  if (rest.length) {
    card.append(ctx.renderNoteItems(ctx.el("div", { class: "panelcard-b notes" }), rest));
  }
  return card;
}

// ---- the guide: one preset at a time, in three parts ---------------------------------
// The notes were one list of paragraphs across every preset of a combined workspace, a
// wall nobody read (owner, 2026-10-19). Each preset now says who to sign in as, what to
// try and what to know; a tab strip picks the preset, one pane shows it. The pane keeps
// the tallest guide's height so the card never jumps, and the next guide fades in.
function guideText(d, text) {
  return String(text).split("<name>").join(d.name || "<name>")
    .split("<workspace-url>").join(d.open_url || d.root_url || "<workspace-url>")
    .split("<repro-url>").join(d.open_url || d.root_url || "<repro-url>");   // an older server's
}
function guidePane(d, g) {
  const wrap = ctx.el("div", { class: "guide" });
  wrap.append(ctx.el("p", { class: "guide-one" }, guideText(d, g.summary)));
  if (g.setup) {
    wrap.append(ctx.el("div", { class: "setup" },
      ctx.el("span", { class: "setup-i" }, "▲"),
      ctx.el("span", { class: "setup-t" },
        ctx.el("b", {}, "For a browser on this server: do this once"),
        ctx.el("span", { class: "setup-w" }, g.setup.why),
        ctx.el("code", {}, g.setup.line)),
      ctx.el("button", { class: "cp", onclick: () => ctx.copy(g.setup.line) }, "Copy")));
  }
  const parts = [];
  if ((g.signIn || []).length) {
    const t = ctx.el("table", { class: "notetable" });
    for (const [user, password, where] of g.signIn) {
      t.append(ctx.el("tr", {}, ctx.el("th", {}, user), ctx.el("td", { class: "pw" }, guideText(d, password)),
        ctx.el("td", { class: "w" }, guideText(d, where))));
    }
    parts.push(ctx.el("div", { class: "guide-part" }, ctx.el("span", { class: "section-label flat" }, "Sign in as"), t));
  }
  if ((g.steps || []).length) {
    parts.push(ctx.el("div", { class: "guide-part" }, ctx.el("span", { class: "section-label flat" }, "Try it"),
      ctx.el("ol", {}, ...g.steps.map((s) => ctx.el("li", {}, ctx.linkify(guideText(d, s)))))));
  }
  wrap.append(ctx.el("div", { class: "guide-cols" + (parts.length === 1 ? " one" : "") }, ...parts));
  if ((g.know || []).length) {
    wrap.append(ctx.el("div", { class: "guide-part guide-know" }, ctx.el("span", { class: "section-label flat" }, "Good to know"),
      ctx.el("ul", {}, ...g.know.map((s) => ctx.el("li", {}, ctx.linkify(guideText(d, s)))))));
  }
  return wrap;
}
function guideBlock(d, guides) {
  const names = guides.map((g) => g.name);
  if (!names.includes(ctx.dstate.guideTab)) ctx.dstate.guideTab = names[0];
  const block = ctx.el("div", { class: "guide-block" },
    ctx.el("div", { class: "guide-h" }, ctx.el("span", { class: "section-label flat" }, "Using this preset")));
  const pane = ctx.el("div", { class: "guide-pane", role: "tabpanel" });
  const show = (name, animate) => {
    ctx.dstate.guideTab = name;
    for (const b of block.querySelectorAll(".guide-tabs button")) {
      const on = b.dataset.tab === name;
      b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1;
    }
    const next = guidePane(d, guides.find((g) => g.name === name) || guides[0]);
    if (animate) next.classList.add("entering");
    pane.replaceChildren(next);
    if (animate) requestAnimationFrame(() => next.classList.remove("entering"));
  };
  if (names.length > 1) {
    const strip = ctx.el("div", { class: "guide-tabs", role: "tablist", "aria-label": "Presets" },
      ...names.map((n) => ctx.el("button", { type: "button", role: "tab", "data-tab": n,
        "aria-selected": String(n === ctx.dstate.guideTab), tabIndex: n === ctx.dstate.guideTab ? 0 : -1,
        onclick: () => show(n, true) }, n)));
    strip.addEventListener("keydown", (e) => {
      const i = names.indexOf(ctx.dstate.guideTab);
      const to = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1
        : e.key === "Home" ? 0 : e.key === "End" ? names.length - 1 : -1;
      if (to < 0 || to >= names.length) return;
      e.preventDefault(); show(names[to], true);
      const b = strip.querySelector(`button[data-tab="${names[to]}"]`);
      if (b) b.focus();
    });
    block.append(strip);
  }
  block.append(pane);
  show(ctx.dstate.guideTab, false);
  // The tallest guide sets the pane's height once the card is on screen, measured off-screen
  // at the card's width, so switching presets never moves what is below the card.
  if (names.length > 1) {
    requestAnimationFrame(() => {
      const width = pane.getBoundingClientRect().width;
      if (!width) return;
      const probe = ctx.el("div", { class: "guide-pane", style: `position:absolute;visibility:hidden;left:-9999px;width:${width}px` });
      document.body.append(probe);
      let tallest = 0;
      for (const g of guides) { probe.replaceChildren(guidePane(d, g)); tallest = Math.max(tallest, probe.getBoundingClientRect().height); }
      probe.remove();
      pane.style.minHeight = `${Math.ceil(tallest)}px`;
    });
  }
  return block;
}

// ---- detail panel -----------------------------------------------------------
// WHAT THE LIST ALREADY KNOWS, drawn at once. The full panel waits for the workspace's own
// read -- on a cluster several round trips -- and until then this showed only "Loading…",
// for as long as a minute on a slow EKS cluster.
function detailShell(r) {
  const open = r.open_url || r.root_url;
  const kube = (r.runtime || "docker") === "kubernetes";
  return [
    ctx.el("div", { class: "d-head" },
      ctx.el("span", { class: "dot " + ctx.stateClass(r.state || "?") }, "●"),
      ctx.el("span", { class: "name" }, r.name),
      ctx.el("span", { class: "pill " + ctx.stateClass(r.state || "?") }, r.state || "?"),
      ctx.el("button", { class: "close", onclick: ctx.closeDetail }, "×")),
    ctx.el("div", { class: "d-sub" }, ctx.el("b", {}, r.rc_version || "?"), ctx.el("i", {}, "/"),
      `mongo ${r.mongo_tag || "?"}`, ctx.el("i", {}, "·"), whereOf(r)),
    open && r.state !== "?" ? ctx.el("div", { class: "d-actions" },
      ctx.el("a", { href: open, target: "_blank", rel: "noreferrer", style: "text-decoration:none",
        ...(ctx.remoteLoopback(open) ? { title: ctx.LOOPBACK_TITLE } : {}) },
        ctx.el("button", { class: "btn primary" }, "↗ Open RC"))) : "",
    ctx.el("div", { class: "placeholder", id: "detail-reading" },
      kube ? `Reading ${r.name} from its cluster…` : `Loading ${r.name}…`),
  ];
}
async function selectRepro(name, tab = "overview") {
  ctx.SELECTED = name; ctx.dstate.tab = tab; ctx.dstate.points = []; ctx.dstate.statsRefused = ""; ctx.dstate.guideTab = "";
  ctx.setView("workspace");
  // Tear the PREVIOUS repro's panel down first. Leaving it up meant that while the
  // fetch was in flight -- and permanently if it failed -- the list highlighted B
  // while the panel still showed A, with A's destructive Down button wired to A.
  ctx.closeLogs();
  if (ctx.dstate.statsTimer) { clearInterval(ctx.dstate.statsTimer); ctx.dstate.statsTimer = null; }
  ctx.dstate.detail = null;
  ctx.render();
  const panel = ctx.$("#detail");
  panel.innerHTML = "";
  const found = (ctx.ALL_REPROS || []).find((r) => r.name === name);
  const row = found && ctx.displayRepro(found);
  panel.append(...(row ? detailShell(row) : [ctx.el("div", { class: "placeholder" }, `Loading ${name}…`)]));
  let detail;
  try { detail = await ctx.api(`/api/repros/${name}/detail`); }
  catch (e) {
    if (ctx.SELECTED !== name || ctx.VIEW !== "workspace") return;
    ctx.toast(e.message);
    panel.innerHTML = "";
    panel.append(ctx.el("div", { class: "placeholder" }, `Could not load ${name}.`));
    return;
  }
  if (ctx.SELECTED !== name || ctx.VIEW !== "workspace") return;        // a newer view won the race
  ctx.dstate.detail = detail;
  ctx.renderDetail();
}
function closeDetail() {
  ctx.setView("home");
  ctx.SELECTED = null; ctx.dstate.detail = null;
  if (ctx.dstate.statsTimer) { clearInterval(ctx.dstate.statsTimer); ctx.dstate.statsTimer = null; }
  ctx.closeLogs();
  ctx.render();
}
function switchTab(t) { ctx.dstate.tab = t; ctx.saveLocation(); ctx.renderDetail(); }

Object.defineProperties(ctx, {
  "HOME": { enumerable: true, get: () => HOME, set: value => { HOME = value; } },
  "HOME_EVERY": { enumerable: true, get: () => HOME_EVERY },
  "refreshHome": { enumerable: true, get: () => refreshHome },
  "runningRow": { enumerable: true, get: () => runningRow },
  "capacityCard": { enumerable: true, get: () => capacityCard },
  "attentionItems": { enumerable: true, get: () => attentionItems },
  "renderHome": { enumerable: true, get: () => renderHome },
  "openScenarios": { enumerable: true, get: () => openScenarios },
  "noteGroupCard": { enumerable: true, get: () => noteGroupCard },
  "noteItemsByGroup": { enumerable: true, get: () => noteItemsByGroup },
  "scenarioCard": { enumerable: true, get: () => scenarioCard },
  "selectRepro": { enumerable: true, get: () => selectRepro },
  "closeDetail": { enumerable: true, get: () => closeDetail },
  "switchTab": { enumerable: true, get: () => switchTab },
});
export { HOME, HOME_EVERY, refreshHome, runningRow, capacityCard, attentionItems, renderHome, openScenarios, noteGroupCard, noteItemsByGroup, scenarioCard, selectRepro, closeDetail, switchTab };
