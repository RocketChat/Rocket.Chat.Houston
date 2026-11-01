import { ctx } from "./shared.js";

// ---- theme ------------------------------------------------------------------
// Stored per browser, not per account: it is a property of the screen you are
// sitting at, and the same person on a projector and a laptop wants different
// answers. Light until somebody presses the toggle: the owner's choice (2026-10-05),
// over following the OS, which opened dark on every dark-mode laptop.
const THEME_KEY = "houston-theme";
function applyTheme(name) {
  document.documentElement.dataset.theme = name === "dark" ? "dark" : "light";
  // Also in a cookie, because the SIGN-IN page is server-rendered with no script
  // (deliberately -- see src/web/signin.ts) and localStorage is unreadable without
  // one. Nothing but the palette depends on it, so it is not HttpOnly and carries
  // no security weight; the server accepts only the two literal values.
  try {
    document.cookie = "houston_theme=" + (name === "dark" ? "dark" : "light")
      + ";path=/;max-age=31536000;samesite=lax";
  } catch (_) { /* cookies off; prefers-color-scheme still applies */ }
  const b = ctx.$("#theme-toggle");
  if (b) {
    // The mark shows WHERE THE CLICK GOES, not where you are: on a dark page it
    // is a sun, because pressing it makes the page light. Drawn rather than an
    // emoji -- ☀/🌙 render as full-colour pictures on some platforms and as a
    // glyph on others, and neither follows the theme's own ink.
    const sun = "M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66l1.42-1.42M4.92 19.08l1.42-1.42"
      + "m11.32 0l1.42 1.42M4.92 4.92l1.42 1.42";
    b.innerHTML = name === "dark"
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/>`
        + `<path d="${sun}"/></svg>`
      : `<svg viewBox="0 0 24 24" aria-hidden="true">`
        + `<path d="M21 13.2A9 9 0 1110.8 3a7 7 0 1010.2 10.2z"/></svg>`;
    // The button has no text, so the only name it has is this one.
    const to = name === "dark" ? "light" : "dark";
    b.setAttribute("aria-label", `Switch to the ${to} theme`);
    b.setAttribute("title", `Switch to the ${to} theme`);
  }
}
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch (_) { /* private mode */ }
  applyTheme(saved === "dark" ? "dark" : "light");
}
initTheme();
// The initial VIEW is an assignment, not a setView() call, so nothing had
// marked the top bar on first load — you arrived on Home with no link lit.
ctx.setView(ctx.VIEW, { history: false });
ctx.$("#btn-prune").addEventListener("click", ctx.doPrune);
ctx.$("#filter").addEventListener("input", (e) => { ctx.view.filter = e.target.value.trim().toLowerCase(); ctx.render(); });
ctx.$("#status-filter").addEventListener("change", (e) => { ctx.view.status = e.target.value; ctx.render(); });
ctx.$("#sort-by").addEventListener("change", (e) => { ctx.view.sort = e.target.value; ctx.render(); });
ctx.$("#scope-filter").addEventListener("change", (e) => {
  ctx.view.scope = e.target.value; localStorage.setItem("rc_scope", ctx.view.scope); ctx.render();
});
// The fork and the segmented control carry their own handlers, so there is nothing
// to bind here: a <select>'s change event was the only reason those lines existed.
ctx.$("#https-mode").addEventListener("change", ctx.syncHttpsFields);
// The profile only means anything when seeding is on, so don't show it otherwise.
function syncCreateSeed() {
  const form = ctx.$("#create-form"), on = form.seed.checked;
  ctx.$("#create-seed-profile-row").hidden = !on;
  ctx.$("#create-seed-options").hidden = !on;
  form.seed_profile.disabled = !on;
  for (const input of ctx.$("#create-seed-options").querySelectorAll("input")) input.disabled = !on;
  form.seed_history_days.disabled = !on || !form.seed_history.checked;
}
ctx.$("#create-form").seed.addEventListener("change", syncCreateSeed);
ctx.$("#create-form").seed_history.addEventListener("change", syncCreateSeed);
ctx.$("#seed-form").history.addEventListener("change", ctx.syncSeedMode);
// The version as it is typed -- its MongoDB, a CI build's base release -- is options.js's.
ctx.$("#create-cancel").addEventListener("click", () => ctx.$("#create-dialog").close());
ctx.$("#create-submit").addEventListener("click", (e) => { e.preventDefault(); ctx.submitCreate(); });
ctx.$("#job-close").addEventListener("click", () => ctx.$("#job-dialog").close());
ctx.$("#job-dialog").addEventListener("close", () => {
  const job = ctx.JOB;
  ctx.closeJobStream();      // stop streaming into a hidden dialog (and stop the leak)
  if (job && !job.finished) ctx.watchDetachedJob(job);
});
ctx.$("#seed-mode").addEventListener("change", ctx.syncSeedMode);
ctx.$("#seed-cancel").addEventListener("click", () => ctx.$("#seed-dialog").close());
ctx.$("#seed-clear").addEventListener("click", ctx.clearScale);
ctx.$("#seed-submit").addEventListener("click", (e) => { e.preventDefault(); ctx.submitSeed(); });
ctx.$("#upgrade-cancel").addEventListener("click", () => ctx.$("#upgrade-dialog").close());
// Resolved server-side as you type: the version -> MongoDB pairing and the
// downgrade/major refusals are the backend's to decide, and finding out after a
// job started is too late. `change` too, so paste-and-blur is not missed.
ctx.$("#upgrade-to").addEventListener("change", ctx.checkUpgradePlan);
ctx.$("#upgrade-to").addEventListener("blur", ctx.checkUpgradePlan);
ctx.$("#upgrade-go").addEventListener("click", (e) => { e.preventDefault(); ctx.submitUpgrade(); });
ctx.$("#rollback-cancel").addEventListener("click", () => ctx.$("#rollback-dialog").close());
ctx.$("#rollback-go").addEventListener("click", ctx.submitRollback);
ctx.$("#owner-cancel").addEventListener("click", () => ctx.$("#owner-dialog").close());
// On `submit`, so Enter in the name field hands it over too; the dialog stays open for a refusal.
ctx.$("#owner-form").addEventListener("submit", (e) => { e.preventDefault(); ctx.submitHandOver(); });
ctx.$("#restore-cancel").addEventListener("click", () => ctx.$("#restore-dialog").close());
ctx.$("#restore-go").addEventListener("click", ctx.submitRestoreNew);
ctx.$("#import-cancel").addEventListener("click", () => ctx.$("#import-dialog").close());
ctx.$("#import-preview").addEventListener("click", (e) => { e.preventDefault(); ctx.previewImport(); });
ctx.$("#import-apply").addEventListener("click", ctx.applyImport);
ctx.$("#perf-cancel").addEventListener("click", () => ctx.$("#perf-dialog").close());
ctx.$("#perf-submit").addEventListener("click", ctx.submitPerf);
ctx.$("#pat-close").addEventListener("click", () => ctx.$("#pat-dialog").close());
ctx.$("#pat-copy").addEventListener("click", () => ctx.copy(ctx.PAT_HEADERS));
// A live admin credential should not outlive the dialog showing it. Bound to
// `close` rather than the button: Escape dismisses a <dialog> without it.
ctx.$("#pat-dialog").addEventListener("close", () => {
  ctx.PAT_HEADERS = "";
  ctx.$("#pat-body").textContent = "";
});
// On `submit`, not the Send button's click, so Enter in the path field sends too.
// preventDefault is what keeps the dialog open: this form is method="dialog", so
// without it every send would also dismiss the response it just fetched.
ctx.$("#call-form").addEventListener("submit", (e) => { e.preventDefault(); ctx.submitCall(); });
ctx.$("#call-close").addEventListener("click", () => ctx.$("#call-dialog").close());
ctx.$("#call-copy").addEventListener("click", () =>
  ctx.CALL_TEXT ? ctx.copy(ctx.CALL_TEXT) : ctx.toast("nothing to copy — send a request first"));

Object.defineProperties(ctx, {
  "THEME_KEY": { enumerable: true, get: () => THEME_KEY },
  "applyTheme": { enumerable: true, get: () => applyTheme },
  "initTheme": { enumerable: true, get: () => initTheme },
  "syncCreateSeed": { enumerable: true, get: () => syncCreateSeed },
});
export { THEME_KEY, applyTheme, initTheme, syncCreateSeed };
