'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXPECTED = '53d4fe98f9d12eb94430a66c3e183861b558c7eaaaa5e4e8f26ae09a572a9d02';
// Re-recorded for side ports allocated per workspace: the Presets page says each preset's
// ports are preferred (another workspace with it gets the next free one); restore as new no
// longer names a holder of its ports, since the copy gets its own, and its Restore button
// carries the server's refusal instead; and a monitoring attach whose Grafana is on a port
// other than 5050 reloads the page so its frame is allowed -- only for a Grafana the page was
// not loaded allowing, which it records from its first workspace list.
// Re-recorded for the 2026-10-21 live audit: a create shown as Creating on the page that
// started it, and kept out of Home's "Needs you" (it read `down`); the Logs tab's message
// under its columns at phone width, where it had ~50px; and an EKS build with the Nodes
// field cleared sending the 3 its price was quoted for, not a 0 the server now refuses.
// Re-recorded for Enter in the Delete dialog's name field: it presses Delete once the name
// is right, where the method=dialog form closed the dialog with nothing done.
// Re-recorded for the pane's foot: Take down (the containers go, the data stays) and Delete
// workspace (everything goes, once the name is typed), each saying what it removes, kept in
// view as the pane scrolls, behind one dialog instead of two browser confirm boxes.
// Re-recorded for the scenario card reading each preset's guide behind tabs: who to sign in
// as, what to try, what to know, one preset at a time, the pane at the tallest guide's height.
// Re-recorded for the rail card keeping a long name and preset list inside its box: its grid
// track may shrink below the text, which breaks anywhere.
// Re-recorded for the voice options' one vocabulary: each row labelled as Rocket.Chat's
// settings and compose files name it (SIP integration, VoIP domain, RTP ports, PBX, FreeSWITCH
// dialplans), its --set key the same words (sip_integration, freeswitch_dialplans), the
// dialplan choice showing the values themselves.
// Re-recorded for voice's designed controls: each phone option opens once the one it needs is
// on, none is offered on Kubernetes, and a hidden one is not sent.
// Re-recorded for a cluster's Prepare and Forget offered to admins only, as the server now
// allows them only to admins.
// Re-recorded for a member's view of a colleague's workspace: no Stop, Restart, Logs, Env
// vars or action pane, the owner named, the admin login shown as hidden; the CLI default
// offered to admins (and on a box without accounts); a colleague's backups not restorable.
// Re-recorded for a create's toasts naming the workspace, as Activity does, not the version.
// Re-recorded for the create dialog's footer cleared once its job has stopped or failed.
// Re-recorded for Okta sign-in: the account chip's Okta name, the People page's Okta email,
// "houston password" in the menu and dialog, the sign-in page's Okta button style, and the
// linked email in its own uncoloured class, its whole address in the title.
// Re-recorded for a GUI request given up after API_TIMEOUT_MS, so a read that never answers
// cannot freeze the list.
// Re-recorded for the e2ee preset's four options, a refused live chart asked once per
// selection, a create still running after a reload shown on the rail, and a page restored
// after sign-out sent to sign-in.
// Re-recorded for retained job output reopening and truthful acceptance/terminal audit.
// Re-recorded for the pending Logs batch capped while rendering frames are delayed.
// Re-recorded for releasing obsolete Logs views and streams on tab and top-bar navigation.
// Re-recorded for owner-only detail refresh after handover and tablet navigation fit.
// Re-recorded for persisted navigation, stable rail focus, readonly backup controls,
// Docker log reconnection and explicit unavailable status after a failed poll.
// Re-recorded for shared seed scenarios/history controls, complete-verification colours,
// planned/read feature counts, date ranges, and personal-star account locations.
// Re-recorded for the footer naming an unreadable kubeconfig ("k8s: kubeconfig unreadable")
// where it said "not set up" beside a Clusters page giving the reason (acceptance L6-07).
// First recorded, when the GUI was frozen, from:
//   find houston/data/webui -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum
// Re-recorded once, deliberately, for six comment-only edits that name the TypeScript
// modules the comments describe; no rule, markup or script changed.
// Keep both the sorted relative names and sha256sum's two-space record separator. The
// explicit inventory also makes an addition, removal or rename fail before hashing.
//
// The assets have since moved, byte for byte, from `houston/data/webui` to `data/webui`.
// The manifest still names each file under the label that was hashed, so the digest stays comparable to that record -- the frozen
// claim is about the bytes, and a move is not a change to them.
// Re-recorded for the public Grafana attachment result: closing it refreshes the
// document's frame-src allow-list before a dashboard is embedded.
// Re-recorded for four cluster fixes: the create dialog sends the chosen cluster, the
// delete dialog sends the cluster's region, the cluster cards use a radius token that
// exists, and a detached job is watched until it ends rather than for 15 minutes.
// Re-recorded for the cluster card reading "houston's own" from the ledger's ownership
// tag rather than from the kind-cluster switch, which is never true for EKS.
// Re-recorded for the Clusters page rebuild: a stepper of the six stages, the next step
// from the core, a totals strip, one table row per cluster and the selected one's detail
// and actions, all rendered from /api/clusters/overview instead of a card per probe.
// Re-recorded for the Clusters card on Home and the chip naming what is billing, both from
// the same overview, read at most once every two minutes whoever asks.
// Re-recorded for the guided build flow: four steps replace the four-field dialog, each
// with its checks and the terminal command that does the same, and the DNS step opens by
// itself when a build ends.
// Re-recorded for section 2's cluster cards (one per cluster, with what it costs) over the
// hidden select that still carries the value, and a cluster pane opening a workspace on it.
// Re-recorded for a Kubernetes workspace naming its cluster, the certificate check on a
// cluster workspace with a public name, and cluster jobs saying their result in the log.
// Re-recorded for the delete's result separating what is tied to the cluster (with its
// command) from untagged candidates (to check, with none).
// Re-recorded for totals that say when they leave a cluster out: a "+" and "not priced"
// on the Clusters page, Home and the chip.
// Re-recorded for the review and screenshot fixes: the page and the build flow read the
// overview with no cluster yet, one read in flight, "?" not "free", an expired date in
// amber, the DNS stage passed over without a zone, commands kept whole, a stepper that
// fits, the identity on step 2, a costed "Decide for me", and Runs on on two lines.
// Re-recorded for a Cancel on every step of the build flow, and the delete dialog no
// longer telling you to release load balancers with a kubectl that names no context.
// Re-recorded for the Clusters page in three places (on this machine, elsewhere, in AWS),
// a local cluster's plain detail read when it is opened, Home counting it apart from AWS,
// and the footer saying kubectl has no current context instead of "not set up".
// Re-recorded for the detail placed after its section rather than inside it, where the
// section's own re-render wiped it on a box whose only cluster is local.
// Re-recorded for an AWS section with nothing in it drawing no strip of zeros and no
// empty table header, and the pane naming a local cluster with its place.
// Re-recorded after restoring the original shell, Home and workspace dialog while
// retaining the EKS connection controls and hiding non-EKS remote GUI contexts.
// Re-recorded for the 2026-10 redesign from the approved prototype: Home as a dashboard,
// Create a workspace in two steps with its progress, the Clusters page given to Amazon
// EKS with this machine on one card, a cluster's own view, and Set up Amazon EKS.
// Re-recorded for the owner's first look: light by default with dark only from the toggle,
// no Offline or Don't-pull boxes in Create, Build first in Set up Amazon EKS with the
// check listing what houston built, and Refresh reading the page on screen again.
// Re-recorded for the sign-in page on the light ground: ink labels, a muted (not dim)
// foot, a solid Sign in button, and banner text dark enough to read on its tint.
// Re-recorded for the softer light palette the owner chose (grey-white cards on a grey
// ground) and the signal colours a step darker so text keeps 5:1 on it.
// Re-recorded for "Create here" offered only where the Create dialog can go: under the
// admin create policy a member gets Docker and the server's default, not every cluster.
// Re-recorded for the server's default read as where an empty context lands: the saved
// default, else the cluster `up` picks (what kubectl points at), measured on a k3s box.
// Re-recorded for what a first EKS cluster taught on a real Cloudflare zone: one card for a
// cluster being built, builds read after a page load, reminders only once due, the DNS
// record offered from Home, the card and the cluster's page and laid out field by field,
// Create asking for an email rather than a domain on a zoned cluster, a workspace's header
// drawn before its own read, and one workspace-list read at a time. Then the review's
// three: a build hides only its own name in its own region, Create promises <name>.<zone>
// only where the server will make it, and "Off" comes back chosen after a zoned cluster.
// Re-recorded for the EKS setup's Re-check: it says it is checking and when it last
// checked, and a server started without AWS_PROFILE names the profiles it could use.
// Re-recorded for Stop on a running job's output dialog, which ends a stuck job and says
// it was stopped, and for the cluster delete dialog saying what --force does and does not skip.
// Re-recorded for Stop offered only on a job the server says may be stopped.
// Re-recorded for the workspace panel's "About this scenario" link back at its small size: the
// wizard's `.linkbtn { font: inherit }` reset it everywhere.
// Re-recorded for the create dialog's options (js/options.js, approved prototype 2026-10-08):
// presets ticked from a list with each one's settings, the license (masked), the version's
// kind and a CI build's base release, the 9.0 notice; privileged fields shown to members
// and disabled when the policy keeps them to admins; preset chips, CI build and Licensed in
// the workspace panel.
// Re-recorded for the create dialog titling its progress with the name the server settled
// on (the job's `workspace-name` event), where it guessed `rc-<version>`.
// Re-recorded for the Clusters page's This-machine Kubernetes row saying "Reading…" before its
// list arrives and "Not answering" when it could not be read, where it said there was no
// cluster on this machine.
// Re-recorded for the cluster rows following every read of the list, so the page drawn
// after the page load's read shows the local cluster rather than "no cluster on this machine".
// Re-recorded for the 2026-10-09 acceptance fixes: a refusal toast drawn above an open dialog,
// a create dialog that opens empty, no bare refresh() after a restore or upgrade, wrapping
// note rows, an Overview that follows a starting workspace, "k8s: ?" and "Reading…" while the
// probe is pending, an unreadable kubeconfig said with its reason, readable "down" words,
// a 390 px rail and tab cue, a member told a CI build is admin-only, a Kubernetes log stream
// that follows a restarted pod, Stop inside the create dialog, and "stopped" for a stopped job.
// Re-recorded for three GUI gaps the same run found: "Hand over…" in a workspace's pane and
// its dialog, a delete confirm that names that way instead of a shell command, a Backups page
// listing every bundle on the box with restore as new from it, a restore-as-new dialog that
// says a held side port before anything starts, and "Roll back to <version>" behind a red
// confirm.
const ASSET_ROOT = 'data/webui';
const RECORDED_LABEL = 'houston/data/webui';
const ASSETS = [
  'app.css',
  'index.html',
  'js/api.js',
  'js/boot.js',
  'js/clusters-tail.js',
  'js/clusters.js',
  'js/create.js',
  'js/detail.js',
  'js/jobs.js',
  'js/logs.js',
  'js/main.js',
  'js/options.js',
  'js/people.js',
  'js/perf.js',
  'js/render.js',
  'js/shared.js',
  'js/state.js',
  'js/theme.js',
  'js/util.js',
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function walk(directory, root) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return walk(absolute, root);
      if (!entry.isFile()) {
        throw new Error(`GUI asset is not a regular file: ${path.relative(root, absolute)}`);
      }
      return [path.relative(root, absolute)];
    })
    .sort();
}

function verify(root = path.resolve(__dirname, '..')) {
  const assetRoot = path.join(root, ASSET_ROOT);
  const found = walk(assetRoot, assetRoot);
  if (JSON.stringify(found) !== JSON.stringify(ASSETS)) {
    throw new Error(
      `GUI asset set changed\nexpected: ${ASSETS.join(', ')}\nactual:   ${found.join(', ')}`,
    );
  }
  const manifest = ASSETS.map((asset) => {
    const digest = sha256(fs.readFileSync(path.join(assetRoot, asset)));
    return `${digest}  ${RECORDED_LABEL}/${asset}\n`;
  }).join('');
  const actual = sha256(manifest);
  if (actual !== EXPECTED) {
    throw new Error(`GUI asset hash changed: expected ${EXPECTED}, got ${actual}`);
  }
  return actual;
}

function proveMutationIsRejected(root) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-gui-hash-'));
  try {
    fs.cpSync(path.join(root, ASSET_ROOT), path.join(scratch, ASSET_ROOT), { recursive: true });
    fs.appendFileSync(path.join(scratch, ASSET_ROOT, 'js/main.js'), '\n// mutation proof\n');
    try {
      verify(scratch);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('GUI asset hash changed:')) {
        return error.message;
      }
      throw error;
    }
    throw new Error('GUI hash verifier accepted a modified asset');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function proveNonRegularIsRejected(root) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-gui-hash-link-'));
  try {
    fs.cpSync(path.join(root, ASSET_ROOT), path.join(scratch, ASSET_ROOT), { recursive: true });
    const target = path.join(scratch, ASSET_ROOT, 'js/main.js');
    const saved = path.join(scratch, 'main.js');
    fs.copyFileSync(target, saved);
    fs.unlinkSync(target);
    fs.symlinkSync(saved, target);
    try {
      verify(scratch);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('GUI asset is not a regular file:')) {
        return error.message;
      }
      throw error;
    }
    throw new Error('GUI hash verifier accepted a non-regular asset');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const actual = verify(root);
  const mutation = proveMutationIsRejected(root);
  const nonRegular = proveNonRegularIsRejected(root);
  process.stdout.write(
    `GUI asset hash: ${actual}\nMutation sensitivity: ${mutation}\nAsset-type sensitivity: ${nonRegular}\n`,
  );
}

module.exports = {
  ASSET_ROOT,
  ASSETS,
  EXPECTED,
  proveMutationIsRejected,
  proveNonRegularIsRejected,
  verify,
};
