/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { FastifyInstance } from 'fastify';

jest.mock('../../../src/core/lifecycle/inspect', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/inspect'),
  listRepros: jest.fn(),
  describe: jest.fn(),
  kubernetesState: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/payload', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/payload'),
  detail: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/naming', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/naming'),
  resolveName: jest.fn(),
}));
jest.mock('../../../src/core/runner/host', () => ({
  ...jest.requireActual('../../../src/core/runner/host'),
  dockerAvailable: jest.fn(),
  dockerKernelVersion: jest.fn(),
}));
jest.mock('../../../src/core/runner/engine', () => ({
  ...jest.requireActual('../../../src/core/runner/engine'),
  containerIds: jest.fn(),
  stream: jest.fn(),
}));
jest.mock('../../../src/core/runner/queries', () => ({
  ...jest.requireActual('../../../src/core/runner/queries'),
  dockerStats: jest.fn(),
  containerDetails: jest.fn(),
  rcRestartCount: jest.fn(),
}));
jest.mock('../../../src/core/runner/record', () => ({
  ...jest.requireActual('../../../src/core/runner/record'),
  readMeta: jest.fn(),
}));
jest.mock('../../../src/core/topology', () => ({
  ...jest.requireActual('../../../src/core/topology'),
  ofRepro: jest.fn(),
}));
jest.mock('../../../src/core/kube/probe', () => ({
  ...jest.requireActual('../../../src/core/kube/probe'),
  preflight: jest.fn(),
}));
jest.mock('../../../src/core/kube/tools', () => ({
  ...jest.requireActual('../../../src/core/kube/tools'),
  toolsReady: jest.fn(),
  canProvision: jest.fn(),
}));
jest.mock('../../../src/core/kube/status', () => ({
  ...jest.requireActual('../../../src/core/kube/status'),
  podMetrics: jest.fn(),
  podRows: jest.fn(),
  logProcess: jest.fn(),
}));
// THE RELEASE LOOKUP. The create dialog's version hint asks /api/versions/<v> 400 ms after
// a version is typed, and nothing stubbed it: a case passed only while it finished inside
// that window, and failed (network refused) when it did not. Answered as offline, so the
// route falls back to the shipped map, exactly as `--offline` does.
jest.mock('../../../src/core/rcapi', () => ({
  ...jest.requireActual('../../../src/core/rcapi'),
  releaseInfo: jest.fn(async () => null),
}));
jest.mock('../../../src/core/eks', () => ({
  ...jest.requireActual('../../../src/core/eks'),
  deleteCluster: jest.fn(),
  createCluster: jest.fn(),
  sweepLeftovers: jest.fn(async () => ({ found: [], unreadable: [] })),
  sweepClusters: jest.fn(),
  connectExisting: jest.fn(),
  whoami: jest.fn(async () => ({
    account: '111122223333',
    arn: 'arn:aws:iam::111122223333:user/alice',
    error: '',
  })),
  region: jest.fn(async () => 'us-east-1'),
  profiles: jest.fn(async () => []),
}));
jest.mock('../../../src/core/cluster', () => ({
  ...jest.requireActual('../../../src/core/cluster'),
  knownContexts: jest.fn(),
  status: jest.fn(),
  overview: jest.fn(),
  resolveName: jest.fn(async () => []),
  resolveAddresses: jest.fn(async () => []),
}));
jest.mock('../../../src/core/lifecycle/sizing', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/sizing'),
  capacity: jest.fn(),
}));
jest.mock('../../../src/core/edge/runtime', () => ({
  ...jest.requireActual('../../../src/core/edge/runtime'),
  status: jest.fn(),
  deleteHost: jest.fn(),
}));
jest.mock('../../../src/core/edge/spec', () => ({
  ...jest.requireActual('../../../src/core/edge/spec'),
  servedDomain: jest.fn(),
}));
jest.mock('../../../src/core/edge/acme', () => ({
  ...jest.requireActual('../../../src/core/edge/acme'),
  acmeHosts: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/create-docker', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/create-docker'),
  createRepro: jest.fn(),
}));
jest.mock('../../../src/core/envvars', () => ({
  ...jest.requireActual('../../../src/core/envvars'),
  current: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/seeding', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/seeding'),
  runSeedInline: jest.fn(),
}));
jest.mock('../../../src/core/backup', () => ({
  ...jest.requireActual('../../../src/core/backup'),
  listBackups: jest.fn(),
  restore: jest.fn(),
  readManifest: jest.fn(),
}));
jest.mock('../../../src/core/upgrade', () => ({
  ...jest.requireActual('../../../src/core/upgrade'),
  rollback: jest.fn(),
}));
jest.mock('../../../src/core/lifecycle/destroy', () => ({
  ...jest.requireActual('../../../src/core/lifecycle/destroy'),
  teardown: jest.fn(),
}));
jest.mock('../../../src/core/doctor', () => ({
  ...jest.requireActual('../../../src/core/doctor'),
  runChecks: jest.fn(),
}));
jest.mock('../../../src/core/edge/routes', () => ({
  ...jest.requireActual('../../../src/core/edge/routes'),
  routeHost: jest.fn(),
  isPassthrough: jest.fn(),
  routeReachable: jest.fn(),
}));

import * as cluster from '../../../src/core/cluster';
import * as eks from '../../../src/core/eks';
import { event } from '../../../src/lib/events';
import * as backup from '../../../src/core/backup';
import * as doctor from '../../../src/core/doctor';
import * as edgeRoutes from '../../../src/core/edge/routes';
import * as createDocker from '../../../src/core/lifecycle/create-docker';
import * as rcapi from '../../../src/core/rcapi';
import * as envvars from '../../../src/core/envvars';
import * as seeding from '../../../src/core/lifecycle/seeding';
import * as presets from '../../../src/lib/presets';
import * as config from '../../../src/lib/config';
import { CREATE_POLICY_KEY, PRIVILEGED_CREATE_FIELDS } from '../../../src/core/lifecycle/types';
import { JobManager } from '../../../src/web/jobs';
import type * as ExecNS from '../../../src/seams/exec';
import { NotReadyError, PreflightError } from '../../../src/lib/errors';
import * as firstrun from '../../../src/core/firstrun';
import * as edgeAcme from '../../../src/core/edge/acme';
import * as edgeRuntime from '../../../src/core/edge/runtime';
import * as edgeSpec from '../../../src/core/edge/spec';
import * as inspect from '../../../src/core/lifecycle/inspect';
import * as naming from '../../../src/core/lifecycle/naming';
import * as payload from '../../../src/core/lifecycle/payload';
import * as sizing from '../../../src/core/lifecycle/sizing';
import * as kubeProbe from '../../../src/core/kube/probe';
import * as kubeTools from '../../../src/core/kube/tools';
import * as runnerHost from '../../../src/core/runner/host';
import * as runnerEngine from '../../../src/core/runner/engine';
import * as runnerQueries from '../../../src/core/runner/queries';
import * as runnerRecord from '../../../src/core/runner/record';
import * as destroy from '../../../src/core/lifecycle/destroy';
import * as upgrade from '../../../src/core/upgrade';
import * as topology from '../../../src/core/topology';
import * as kubeStatus from '../../../src/core/kube/status';
import * as users from '../../../src/core/users';
import { createApp } from '../../../src/web/app';
import type { AppOptions } from '../../../src/web/app';

const realPayload = jest.requireActual<typeof payload>('../../../src/core/lifecycle/payload');
const realInspect = jest.requireActual<typeof inspect>('../../../src/core/lifecycle/inspect');
const realRecord = jest.requireActual<typeof runnerRecord>('../../../src/core/runner/record');

const mockListRepros = jest.mocked(inspect.listRepros);
const mockDescribe = jest.mocked(inspect.describe);
const mockKubernetesState = jest.mocked(inspect.kubernetesState);
const mockDetail = jest.mocked(payload.detail);
const mockResolveName = jest.mocked(naming.resolveName);
const mockDockerAvailable = jest.mocked(runnerHost.dockerAvailable);
const mockDockerKernelVersion = jest.mocked(runnerHost.dockerKernelVersion);
const mockContainerIds = jest.mocked(runnerEngine.containerIds);
const mockComposeStream = jest.mocked(runnerEngine.stream);
const mockDockerStats = jest.mocked(runnerQueries.dockerStats);
const mockContainerDetails = jest.mocked(runnerQueries.containerDetails);
const mockRcRestartCount = jest.mocked(runnerQueries.rcRestartCount);
const mockReadMeta = jest.mocked(runnerRecord.readMeta);
const mockRuntimeOf = jest.mocked(topology.ofRepro);
const mockPodMetrics = jest.mocked(kubeStatus.podMetrics);
const mockPodRows = jest.mocked(kubeStatus.podRows);
const mockLogProcess = jest.mocked(kubeStatus.logProcess);
const mockPreflight = jest.mocked(kubeProbe.preflight);
const mockToolsReady = jest.mocked(kubeTools.toolsReady);
const mockCanProvision = jest.mocked(kubeTools.canProvision);
const mockKnownContexts = jest.mocked(cluster.knownContexts);
const mockOverview = jest.mocked(cluster.overview);
const mockDeleteCluster = jest.mocked(eks.deleteCluster);
const mockCreateCluster = jest.mocked(eks.createCluster);
const mockSweepLeftovers = jest.mocked(eks.sweepLeftovers);
const mockSweepClusters = jest.mocked(eks.sweepClusters);
const mockConnectExisting = jest.mocked(eks.connectExisting);
const mockWhoami = jest.mocked(eks.whoami);
const mockProfiles = jest.mocked(eks.profiles);
const mockResolveDns = jest.mocked(cluster.resolveName);
const mockResolveAddresses = jest.mocked(cluster.resolveAddresses);
/** What the build flow's first two steps read; a case may shape it, even mid-case. */
let preflightOverride: Partial<cluster.OverviewPreflight> | null = null;
const mockClusterStatus = jest.mocked(cluster.status);
const mockCapacity = jest.mocked(sizing.capacity);
const mockEdgeStatus = jest.mocked(edgeRuntime.status);
const mockDeleteHost = jest.mocked(edgeRuntime.deleteHost);
const mockServedDomain = jest.mocked(edgeSpec.servedDomain);
const mockAcmeHosts = jest.mocked(edgeAcme.acmeHosts);
const mockCreateRepro = jest.mocked(createDocker.createRepro);
const mockReleaseInfo = jest.mocked(rcapi.releaseInfo);
const mockEnvCurrent = jest.mocked(envvars.current);
const mockRunSeedInline = jest.mocked(seeding.runSeedInline);
const mockListBackups = jest.mocked(backup.listBackups);
const mockRestore = jest.mocked(backup.restore);
const mockReadManifest = jest.mocked(backup.readManifest);
const mockRollback = jest.mocked(upgrade.rollback);
const mockTeardown = jest.mocked(destroy.teardown);
/** A bundle's manifest by file name, for the cases that need one other than the default. */
let manifests: Record<string, Record<string, unknown>> = {};
const mockRunChecks = jest.mocked(doctor.runChecks);
const mockRouteHost = jest.mocked(edgeRoutes.routeHost);
const mockIsPassthrough = jest.mocked(edgeRoutes.isPassthrough);
const mockRouteReachable = jest.mocked(edgeRoutes.routeReachable);

const PUBLIC_NAME = 'houston.support.example.com';
let portedJobs: JobManager | undefined;
/** The job the Stop case stops, really running in the server's own registry. */
let stuckJob: { status: string; error: string | null } | undefined;
let buildingJob: { status: string; stopper: AbortController } | undefined;
/** Lets the workspace's own read answer, in the case that holds it back. */
let releaseDetail: (() => void) | null = null;
/** How many workspace-list reads the server answered. */
let listReads = { calls: 0, open: 0, most: 0 };
let portedUser = 'alice';
let portedPassword = 'browser-password-123';
let portedReducedMotion = false;
let surfaceAcmeHosts: string[] = [];

type BrowserCase = readonly [file: string, name: string];

const CASES: readonly BrowserCase[] = [
  ['flows', 'a signed out browser lands on the sign in page'],
  ['flows', 'a wrong password shows an error in the page'],
  ['flows', 'signing in renders the dashboard'],
  ['flows', 'sign out ends the session and returns to the login'],
  ['flows', 'first run creates the first admin in the browser'],
  ['flows', 'the setup page says so when the key is missing'],
  ['flows', 'a readonly user is not offered what it cannot do'],
  ['flows', 'an admin can open people and a member cannot'],
  ['flows', 'the activity page opens both of its tabs'],
  ['flows', 'a running job can be stopped from its output'],
  ['surfaces chrome', 'the theme is light by default and the choice survives a reload'],
  ['surfaces chrome', 'people rows have their own shape not activitys'],
  ['surfaces chrome', 'a background poll does not navigate the page for you'],
  ['surfaces chrome', 'activity and a workspace are different views of the stage'],
  ['surfaces chrome', 'the scenarios page shows the setup step a preset needs'],
  ['surfaces chrome', 'every page is reachable and says which one you are on'],
  ['surfaces chrome', 'the dashboard poll does not close the page you are reading'],
  ['surfaces chrome', 'preset notes are read as points not as lines'],
  ['surfaces rail', 'the dashboard renders a workspace card'],
  ['surfaces rail', 'the detail panel opens and switches tabs'],
  ['surfaces rail', 'the log viewer streams container output'],
  ['surfaces rail', 'the backups tab lists what is there'],
  ['surfaces rail', 'a readonly user is offered nothing in the detail panel either'],
  ['surfaces rail', 'nothing in the page is painted a hardcoded dark colour'],
  ['surfaces rail', 'no control is hidden behind the status bar'],
  ['surfaces rail', 'the one button a screen is asking for carries the accent'],
  ['surfaces rail', 'a burst of log lines costs one layout not one per line'],
  ['surfaces rail', 'scrolling up in the logs offers one press back to the latest'],
  ['surfaces rail', 'reduced motion keeps every state and removes the travel'],
  ['surfaces rail', 'the action pane names the thing not one of its parts'],
  ['surfaces panel', 'the home page leads with capacity'],
  ['surfaces panel', 'a down workspace is something home asks you about'],
  ['surfaces panel', 'a card is not the same colour as the thing it stands on'],
  ['surfaces panel', 'a note that names a place joins the row that already lists it'],
  ['surfaces dialogs', 'the create dialog opens and lists presets'],
  ['surfaces dialogs', 'the load test dialog opens from the panel'],
  ['surfaces dialogs', 'the doctor dialog renders its checks'],
  ['surfaces dialogs', 'the edge badge surfaces an unreachable route'],
  ['surfaces dialogs', 'an admin can delete a certificate nothing points at'],
  ['surfaces dialogs', 'a member is not offered the delete at all'],
  ['surfaces dialogs', 'the create dialog follows the box policy not the role'],
  ['surfaces dialogs', 'https is in section two and is still not a second twisty'],
  ['surfaces dialogs', 'presets are ticked from a list and sent with each ones settings'],
  ['surfaces dialogs', 'voice with the phone system combines with email as the cli does'],
  ['surfaces dialogs', 'the voice panel opens each phone option once the one it needs is on'],
  ['surfaces dialogs', 'the e2ee options send the policy and switches as its settings'],
  ['surfaces dialogs', 'saml and oidc rule each other out and ldap follows the one ticked'],
  ['surfaces dialogs', 'ldap asks for a one time code only with its own single sign on'],
  ['surfaces dialogs', 'a pasted license is masked and sent'],
  ['surfaces dialogs', 'the 9 notice asks for a license only when one is needed'],
  ['surfaces dialogs', 'a ci build names its base release'],
  ['surfaces dialogs', 'the workspace panel shows its presets its build and its license'],
  ['surfaces dialogs', 'you can change your own password from the browser'],
  ['surfaces offstage', 'a running workspace on home offers both places it could mean'],
  ['remote', 'the panel says that localhost means the readers own machine'],
  ['remote', 'a wide bound workspace is given the address that works from here'],
  ['remote', 'a local browser is told none of this'],
  ['remote', 'an https workspace read from another computer shows its public address'],
  ['remote', 'a localhost workspace read from another computer says where its links open'],
  ['remote', 'the create dialog warns a remote reader about the default bind'],
  ['remote', 'the create dialog stays quiet on a laptop'],
  ['plain http', 'signing in works over plain http on a real hostname'],
  ['plain http', 'a write from the spa survives plain http on a real hostname'],
  ['plain http', 'a link row shows the workspaces root url verbatim'],
  ['plain http', 'a placeholder url in a link row is left alone'],
  ['plain http', 'the workspace row says kubernetes and stays quiet about docker'],
  ['plain http', 'the create dialog offers a runtime and follows it'],
  ['plain http', 'creating a kubernetes workspace sends the axes'],
  ['kubernetes chrome', 'the top links become one menu on a narrow screen'],
  ['kubernetes chrome', 'the header is the doctor button and the footer names both engines'],
  ['kubernetes chrome', 'the doctor chip goes red only when nothing can run a workspace'],
  ['kubernetes chrome', 'in progress shows only jobs that are'],
  ['kubernetes dialogs', 'the seed job shows what it made and whether it was confirmed'],
  ['kubernetes dialogs', 'seed choices show server counts and reset when reopened'],
  ['kubernetes dialogs', 'seed submits profile scenarios and history together'],
  ['kubernetes dialogs', 'seed scale mode disables scenarios and historical dates'],
  ['kubernetes dialogs', 'seed incomplete readback never appears confirmed'],
  ['kubernetes dialogs', 'create sends scenario and history only with sample data enabled'],
  ['kubernetes dialogs', 'the create dialog says what it builds and what the box has left'],
  ['kubernetes dialogs', 'a kubernetes card names the cluster it will use'],
  ['kubernetes dialogs', 'the arrangement says what it builds'],
  ['kubernetes dialogs', 'on kubernetes the voice panel offers no phone options and sends none'],
  ['kubernetes offstage', 'fake detail matches the real payload'],
  ['kubernetes offstage', 'the restart count on kubernetes is rocket chats own pod'],
  ['kubernetes pane', 'the action pane leads with what this state admits'],
  ['kubernetes pane', 'the pane never offers what this runtime refuses'],
  ['kubernetes panel', 'the panel leads with what is wrong and what to do'],
  ['kubernetes panel', 'a down workspace is told what it still holds'],
  ['kubernetes panel', 'a pod that cannot start is named in the panel'],
  ['kubernetes panel', 'the narrow layout is a picker a panel and a bar'],
  ['kubernetes panel', 'a sidecar that keeps restarting is a fault on kubernetes'],
  ['kubernetes panel', 'a sidecar that is not ready and restarting is still a fault'],
  ['kubernetes rail', 'the env tab renders on kubernetes where it used to be blank'],
  ['kubernetes rail', 'the env tab still offers the controls on compose'],
  ['kubernetes rail', 'the env tab shows the refusal rather than an empty table'],
  ['kubernetes rail', 'the containers tab shows pods and says so on kubernetes'],
  ['kubernetes rail', 'the live chart stops asking when the answer is a refusal'],
  ['kubernetes rail', 'a credential note is not labelled a sudo setup step'],
  ['kubernetes rail', 'the one preset with a real setup step keeps it'],
  ['kubernetes rail', 'the three panes survive a narrow window'],
  ['kubernetes rail', 'a note that ends in a name is not glued to the next one'],
  ['kubernetes rail', 'a genuinely wrapped note still joins the line after it'],
  ['kubernetes rail', 'a long line in a note scrolls instead of being clipped away'],
  ['kubernetes rail', 'a grouped note gets its own card with a fact table and a copy button'],
  ['kubernetes rail', 'the overview says which runtime the workspace runs on'],
  ['kubernetes rail', 'the panel is not a two hundred pixel window on a narrow screen'],
  ['kubernetes rail', 'a place a group names is the link row and not a second row'],
  ['kubernetes rail', 'a healthy workspace gets no triage block at all'],
  ['kubernetes rail', 'the rail groups by what each workspace wants from you'],
  ['kubernetes rail', 'one state gets no group headings'],
  ['kubernetes rail', 'a long workspace name does not push the rail sideways'],
  ['kubernetes rail', 'a seeded workspace is not told to seed itself'],
  ['kubernetes rail', 'nothing is suggested for a workspace that is not running'],
  ['kubernetes rail', 'a kubernetes log line is split by pod like a compose one'],
  ['kubernetes rail', 'a note paragraph is as wide as the card it is in'],
  ['kubernetes rail', 'a restart count that climbs is a fault even while ready'],
  ['kubernetes rail', 'the gui has exactly one jobActive and the page parses'],
  ['kubernetes rail', 'the stats poll discards another workspaces answer'],
  ['clusters', 'the clusters view never shows a zero it did not read'],
  ['clusters', 'the cluster chip wants you in amber and is never red'],
  ['clusters', 'only an admin is offered the controls that spend or destroy'],
  ['clusters', 'a member is offered no prepare or forget on a shared cluster'],
  ['clusters', 'the delete dialog will not arm until the name is typed'],
  ['clusters', 'the fake cluster status matches the real payload'],
  ['clusters', 'the cluster action pane survives the four second poll'],
  ['clusters', 'the create form says what a managed cluster commits you to'],
  ['clusters', 'step one quotes this machines memory only for places on it'],
  ['clusters', 'the clusters view speaks english and explains its own numbers'],
  ['clusters', 'a cluster aws says is gone does not read as one that is down'],
  ['clusters', 'a gone cluster offers only controls that can work'],
  ['clusters', 'the local certificate option goes when the cluster is not on this machine'],
  ['clusters', 'the cluster picker shows a name not sixty characters of arn'],
  ['clusters', 'the clusters page is about eks with this machine on one card'],
  ['clusters', 'clicking a cluster card opens its own view and its actions'],
  ['clusters', 'a build in progress is a card with its elapsed time'],
  ['clusters', 'home asks about an eks cluster only when it wants you'],
  ['clusters', 'the setup flow says what the server is missing'],
  ['clusters', 'an admin approves the account from the setup flow'],
  ['clusters', 'the build price follows the node count and the build carries its zone'],
  ['clusters', 'the dns step shows the record to add and says whether it answers'],
  ['clusters', 'step one shows one card per place with what it costs'],
  ['clusters', 'create here opens the details on that cluster'],
  ['clusters', 'a kubernetes workspace names its cluster and can check its certificate'],
  ['clusters', 'a cluster delete says in its job what aws still holds'],
  ['clusters', 'the setup flow connects a cluster houston built and folds away the others'],
  ['clusters', 'the overview is read once while a read is in flight'],
  ['clusters', 'the setup flow can be closed from every step'],
  ['clusters', 'a cluster on this machine is listed apart, free, and out of the aws totals'],
  ['clusters', 'opening a local cluster reads its facts and offers nothing for aws'],
  ['clusters', 'with only a cluster on this machine the page offers to set up eks'],
  ['clusters', 'the clusters page shows no number it has not read'],
  ['clusters', 'a failed overview read says so and offers to try again'],
  ['clusters', 'this machine says it could not read its clusters, not that it has none'],
  ['clusters', 'this machine shows its cluster while the list is read again'],
  ['clusters', 'an expired aws sign-in says sign in, not install'],
  ['clusters', 'the setup re-check says it is checking and when it last checked'],
  ['clusters', 'the setup flow names the aws profiles a server started without one could use'],
  ['clusters', 'first run home offers to create the first workspace'],
  ['clusters', 'create shows its progress and ends with where to go'],
  ['clusters', 'the create dialog never names a cluster the server will not use'],
  ['clusters', 'refresh reads the page on screen again'],
  ['clusters', 'a cluster being built shows once, as its build'],
  ['clusters', 'a build running when the page loads is on home at once'],
  ['clusters', 'a reminder wants you only once it is due'],
  ['clusters', 'a cluster whose names do not answer asks for its dns record'],
  ['clusters', 'the dns dialog lays the record out and tells a proxied record from a missing one'],
  ['clusters', 'create on a cluster with a dns zone asks for an email, not a domain'],
  ['clusters', 'opening a workspace shows its header before its own read answers'],
  ['clusters', 'the workspace list is read one at a time'],
  ['surfaces dialogs', 'a refusal raised inside a dialog is read on top of it'],
  ['surfaces dialogs', 'a second new workspace starts from an empty form'],
  ['surfaces dialogs', 'a member is told a ci build is kept to admins before pressing create'],
  ['surfaces dialogs', 'the create dialog can stop its own job'],
  ['surfaces dialogs', 'a stopped job is said to be stopped not failed'],
  ['surfaces dialogs', 'a long scenario note wraps in the create result'],
  ['surfaces rail', 'a finished restore re-reads the workspace without a page error'],
  ['surfaces rail', 'the overview follows a workspace that is still starting'],
  ['surfaces rail', 'the down and unknown words are readable in both themes'],
  ['surfaces rail', 'at phone width the rail filters and the last tab stay reachable'],
  ['kubernetes chrome', 'the footer says k8s is unknown until the probe answers'],
  ['kubernetes rail', 'a log stream a restart ends follows the new pod by itself'],
  ['clusters', 'an unreadable kubeconfig is said with its reason'],
  ['clusters', 'a member opening create at once is told the cluster is being read'],
  ['clusters', 'the create dialog redraws a local cluster card when its status arrives'],
  ['surfaces rail', 'a workspace is handed over from its pane and its owner row follows'],
  ['surfaces rail', 'a refused hand over is said inside its dialog'],
  [
    'surfaces rail',
    'a member on a colleague’s workspace is told who can hand it over and offered nothing to click',
  ],
  [
    'surfaces rail',
    'every backup on the machine is listed and a deleted workspaces restores as new',
  ],
  [
    'surfaces rail',
    'restore as new is offered while the source still holds the side ports it would use',
  ],
  ['surfaces rail', 'an upgraded workspace rolls back behind a red confirm and the panel follows'],
  [
    'surfaces rail',
    "a directory workspace's notes read as points, with its login on the place row",
  ],
  ['surfaces rail', 'a card with a long name and a long preset list stays inside its box'],
  ['surfaces rail', "a combined workspace's scenario card is a guide per preset behind tabs"],
  [
    'surfaces rail',
    'take down keeps the data, delete asks for the name, and both say what they remove',
  ],
];

// Re-recorded when "a directory workspace's notes read as points, with its login on the place row"
// and "a card with a long name and a long preset list stays inside its box" joined: the presets
// write one string per point, and the rail card's grid track may shrink below its text.
// Re-recorded when "a combined workspace's scenario card is a guide per preset behind tabs"
// joined: the scenario card reads each preset's guide instead of its prose.
// Re-recorded when "take down keeps the data, delete asks for the name, and both say what they remove" joined: the pane's foot has Take down and Delete workspace, each
// saying what it removes, behind one dialog instead of two browser confirm boxes.
// Re-recorded when "the voice panel opens each phone option once the one it needs is on" and
// "on kubernetes the voice panel offers no phone options and sends none" joined: voice's designed controls.
// Re-recorded when "an https workspace read from another computer shows its public address" and
// "a localhost workspace read from another computer says where its links open" joined: the
// overview names the address Open RC follows, and a remote reader is told where localhost is.
// Re-recorded when "restore as new says before it starts that the side ports are taken and what
// works" became "restore as new is offered while the source still holds the side ports it would
// use": a copy is given side ports of its own, so no holder stands in its way.
const CASES_DIGEST = '899739a1784d8f913035e6e63faceb04bc35e3da6eb5ba037f76fd08172e8779';
const caseIds = CASES.map(([file, name]) => `${file}: ${name}`);
const casesDigest = crypto.createHash('sha256').update(JSON.stringify(CASES)).digest('hex');
if (CASES.length !== 194 || new Set(caseIds).size !== 194 || casesDigest !== CASES_DIGEST) {
  throw new Error(
    `browser behavior inventory changed: expected 194 unique cases at ${CASES_DIGEST}, ` +
      `got ${String(CASES.length)} cases, ${String(new Set(caseIds).size)} unique, ${casesDigest}`,
  );
}

function probeCase(file: string, name: string): boolean {
  return file === 'surfaces rail' && name === 'the dashboard renders a workspace card';
}

function detail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 't1234',
    state: 'running',
    rc_version: '7.4.1',
    mongo_tag: '7.0',
    mongo_flavor: 'mongodb',
    host_port: 3001,
    uptime: '2h',
    preset: 'base',
    // A composed workspace's list; the real payload adds it only for one.
    presets: [],
    // The CI build it runs (its ghcr tag) and whether it was given a license.
    ci_build: '',
    licensed: false,
    // Whether Rocket.Chat refused it when `ready` last asked.
    license_refused: false,
    health: 'healthy',
    url: 'http://localhost:3001',
    root_url: 'http://localhost:3001',
    public_url: '',
    // What every "Open" follows: the https name, else `--root-url`'s, else root_url.
    open_url: 'http://localhost:3001',
    login: { user: 'admin', password: 'admin123' },
    degraded: '',
    instances: 1,
    instance_urls: [],
    containers: [
      { service: 'rocketchat', state: 'running', status: 'Up 2 hours', health: 'healthy' },
    ],
    env: [{ key: 'ROOT_URL', value: 'http://localhost:3001', override: false }],
    links: [],
    notes: [],
    note_groups: [],
    restarts: 0,
    monitoring: false,
    tls: '',
    is_default: false,
    created_by: 'alice',
    owner: 'alice',
    made_by: 'alice',
    owner_history: [],
    // The version a rollback returns to; the pane offers one only when it is set.
    rollback_to: '',
    workspace: '/tmp/ws',
    default: false,
    grafana_url: '',
    diag: {},
    runtime: 'docker',
    deployment: 'monolith',
    bind_host: '127.0.0.1',
    seed: null,
    pinned: false,
    namespace: '',
    context: '',
    cluster: '',
    ...overrides,
  };
}

function configureStubs(browserCase: BrowserCase): void {
  const kubernetes = browserCase[0].includes('kubernetes');
  const row = detail(
    kubernetes
      ? {
          runtime: 'kubernetes',
          deployment: 'microservices',
          namespace: 'houston-t1234',
          containers: [],
        }
      : {},
  );
  mockListRepros.mockResolvedValue([row] as never);
  mockDescribe.mockResolvedValue(row as never);
  mockDetail.mockResolvedValue(row as never);
  if (
    process.env.BROWSER_GATE_PROBE === 'wire' &&
    browserCase[0] === 'surfaces rail' &&
    browserCase[1] === 'the detail panel opens and switches tabs'
  ) {
    mockDetail.mockResolvedValue({ ...row, rc_version: 'wire-contract-violation' } as never);
  }
  mockResolveName.mockResolvedValue('t1234');
  mockDockerAvailable.mockResolvedValue(true);
  mockDockerKernelVersion.mockResolvedValue('6.8.0');
  mockContainerIds.mockResolvedValue([]);
  mockDockerStats.mockResolvedValue('');
  mockContainerDetails.mockResolvedValue([]);
  mockRcRestartCount.mockResolvedValue(0);
  mockReadMeta.mockResolvedValue({
    name: 't1234',
    runtime: kubernetes ? topology.KUBERNETES : topology.DOCKER,
    extra: kubernetes ? { context: 'kind-support' } : {},
  } as never);
  mockRuntimeOf.mockResolvedValue(kubernetes ? topology.KUBERNETES : topology.DOCKER);
  mockPodMetrics.mockResolvedValue([]);
  mockPodRows.mockResolvedValue([]);
  mockKubernetesState.mockResolvedValue('running');
  mockPreflight.mockResolvedValue({
    context: kubernetes ? 'kind-support' : '',
    distribution: kubernetes ? 'kind' : '',
    clusterReachable: kubernetes,
    nodeCount: kubernetes ? 1 : 0,
    namespaces: kubernetes ? ['houston-t1234'] : [],
  } as never);
  mockToolsReady.mockReturnValue(kubernetes);
  mockCanProvision.mockReturnValue(false);
  mockKnownContexts.mockResolvedValue({ contexts: [], unreadable: '', default: '' });
  mockClusterStatus.mockResolvedValue({} as never);
  preflightOverride = null;
  // clearAllMocks keeps an implementation: a case that signed the server out must not
  // leave the next one signed out.
  mockWhoami.mockResolvedValue({
    account: '111122223333',
    arn: 'arn:aws:iam::111122223333:user/alice',
    error: '',
  });
  mockProfiles.mockResolvedValue([]);
  // Offline, as at the top of the file: the CI-build case answers a package.json, and
  // clearAllMocks would keep that answer for every case after it.
  mockReleaseInfo.mockResolvedValue(null);
  mockResolveDns.mockResolvedValue([]);
  mockResolveAddresses.mockResolvedValue([]);
  fakeOverview();
  mockCapacity.mockResolvedValue({
    known: true,
    total_mb: 32768,
    available_mb: 28672,
    reserve_mb: 6553,
    swap_mb: 0,
    workspace_mb: 1100,
    room: 20,
    room_denominated_in: 'docker',
    room_by_runtime: { docker: 20, 'kubernetes-monolith': 10, 'kubernetes-microservices': 8 },
  } as never);
  mockEdgeStatus.mockResolvedValue({
    installed: false,
    running: false,
    attached: [],
    routes: [],
  } as never);
  mockServedDomain.mockReturnValue('');
  mockAcmeHosts.mockReturnValue([]);
  mockListBackups.mockResolvedValue([]);
  manifests = {};
  mockReadManifest.mockImplementation(
    async (bundle) =>
      manifests[path.basename(bundle)] ?? { rc_version: '7.4.1', preset: 'base', repro: 't1234' },
  );
  mockTeardown.mockResolvedValue({ name: 't1234' } as never);
  mockRunChecks.mockResolvedValue({ checks: [], counts: {}, verdict: 'ok', repros: {} });
  mockRouteHost.mockImplementation((value) => `${value}.example.test`);
  mockIsPassthrough.mockReturnValue(false);
  mockRouteReachable.mockResolvedValue(true);
  mockComposeStream.mockResolvedValue(0);
}
const CLUSTER_SUPPORT = 'arn:aws:eks:us-east-1:1:cluster/support';
const CLUSTER_PERF = 'arn:aws:eks:eu-west-1:1:cluster/perf';

function clusterContext(
  context: string,
  overrides: Partial<cluster.ContextRow> = {},
): cluster.ContextRow {
  const short = context.split('/').at(-1) ?? context;
  const region = context.startsWith('arn:aws:eks:') ? (context.split(':')[3] ?? '') : '';
  return {
    context,
    short,
    region,
    aliases: [],
    ours: false,
    provider: 'eks',
    billable: true,
    is_default: context === CLUSTER_SUPPORT,
    made_by_houston: false,
    where: cluster.whereOf(context),
    ...overrides,
  };
}

function fakeClusterStatus(context = ''): cluster.Ledger {
  if (context === CLUSTER_SUPPORT) {
    return {
      context,
      distribution: 'eks',
      provider: 'external',
      ours: false,
      reachable: true,
      unreadable: [],
      reach_status: 'ok',
      reach_why: '',
      reach_advice: '',
      manageable: true,
      unmanageable_why: '',
      gone: false,
      nodes: 2,
      age_hours: 148,
      instance_types: { 't3.large': 2 },
      workspaces: [
        {
          namespace: 'houston-t1',
          name: 't1',
          owner: 'alice',
          owner_readable: true,
          pvcs: 1,
        },
      ],
      pvcs: 1,
      loadbalancers: 1,
      operator: false,
      monitoring: false,
      cost: {
        usd_hr: 0.3523,
        unpriced: {},
        incomplete: [],
        basis: 'us-east-1 on-demand',
        estimate: true,
      },
      name: 'support',
      region: 'us-east-1',
      made_by_houston: true,
      created_at: '2026-09-24T09:00:00Z',
      expires: '2026-10-05',
      expires_in_days: 5,
      spend_usd: 52.14,
      ready: {
        storage_class: 'gp3',
        ingress_class: 'traefik',
        cert_manager: true,
        cname_target: 'a1b2c3-123.us-east-1.elb.amazonaws.com',
        dns_answers: null,
      },
      zone: '',
      where: 'aws',
    };
  }
  return {
    context,
    distribution: '',
    provider: '',
    ours: false,
    reachable: false,
    unreadable: ['cluster'],
    reach_status: 'denied',
    reach_why: 'it answered and refused these credentials',
    reach_advice: ' Ask whoever created it to run `aws eks create-access-entry`.',
    manageable: true,
    unmanageable_why: '',
    gone: false,
    nodes: null,
    age_hours: null,
    instance_types: null,
    workspaces: null,
    pvcs: null,
    loadbalancers: null,
    operator: null,
    monitoring: null,
    cost: null,
    name: context.split('/').at(-1) ?? context,
    region: context.startsWith('arn:aws:eks:') ? (context.split(':')[3] ?? '') : '',
    made_by_houston: null,
    created_at: '',
    expires: '',
    expires_in_days: null,
    spend_usd: null,
    ready: null,
    zone: '',
    where: cluster.whereOf(context),
  };
}

/** A k3s on this machine (or, with `where`, elsewhere), read in full. */
function localStatus(context = 'default', where: cluster.Where = 'local'): cluster.Ledger {
  return {
    ...fakeClusterStatus(context),
    distribution: 'k3s',
    reachable: true,
    unreadable: [],
    reach_status: 'ok',
    reach_why: '',
    reach_advice: '',
    nodes: 1,
    age_hours: 880,
    instance_types: { '': 1 },
    workspaces: [],
    pvcs: 0,
    loadbalancers: 0,
    operator: false,
    monitoring: false,
    ready: {
      storage_class: 'local-path',
      ingress_class: 'traefik',
      cert_manager: true,
      cname_target: '',
      dns_answers: null,
    },
    where,
  };
}

const localContext = (context: string, where: cluster.Where): cluster.ContextRow =>
  clusterContext(context, {
    short: context,
    region: '',
    provider: '',
    billable: false,
    is_default: false,
    where,
  });

function useClusterContexts(rows: cluster.ContextRow[], byDefault: string): void {
  mockKnownContexts.mockResolvedValue({
    contexts: rows,
    unreadable: '',
    default: byDefault,
  });
}

/**
 * The overview double, built from whatever contexts and statuses the case set: the page and
 * Home read ONE answer, and deriving it here means a case that shapes one cluster's status
 * shapes both. The next step comes from the real nextStep, the one source both front-ends use.
 */
function fakeOverview(): void {
  mockOverview.mockImplementation(async (_emit, options) => {
    const known = await mockKnownContexts();
    const rows = known.contexts;
    const byDefault = known.default;
    const statuses = await Promise.all(
      rows.map(async (row) => {
        // A case that left the status double at its `{}` default gets the fixture's ledger.
        const st = (await mockClusterStatus(row.context)) as Partial<cluster.Ledger>;
        const full = (
          st.context === undefined ? fakeClusterStatus(row.context) : st
        ) as cluster.Ledger;
        // As the real overview reads it: a cluster not in AWS is glanced at, and what a
        // glance does not read is null until somebody opens it.
        return full.where === 'aws'
          ? full
          : {
              ...full,
              // `glance(row.context, row.where)`: where the list placed it, by its server.
              where: row.where,
              ready: null,
              nodes: null,
              age_hours: null,
              instance_types: null,
              loadbalancers: null,
              operator: null,
              monitoring: null,
            };
      }),
    );
    const preflight = {
      tools_ok: true,
      blockers: [] as string[],
      account: '111122223333',
      identity: 'arn:aws:iam::111122223333:user/alice',
      region: 'us-east-1',
      approved: true,
      ...(preflightOverride ?? {}),
    };
    // Approving from the flow writes the real config; the next read must see it.
    if (config.approvedAwsAccounts().has(preflight.account)) preflight.approved = true;
    const building = options?.building ?? [];
    // As the real overview adds them up, over the AWS clusters alone: a building cluster
    // bills and has no rate yet, and an unread cost or workspace list is counted as
    // unread, never as zero. A cluster on this machine is in none of these.
    const inAws = statuses.filter((st) => st.where === 'aws');
    const awsPriced = inAws.filter((st) => st.cost !== null);
    const spent = inAws.filter((st) => typeof st.spend_usd === 'number');
    const totals = {
      clusters: inAws.length,
      billable: inAws.filter((st) => !st.gone).length + building.length,
      usd_day:
        awsPriced.length === 0
          ? null
          : Math.round(awsPriced.reduce((t, st) => t + (st.cost?.usd_hr ?? 0), 0) * 24 * 100) / 100,
      spend_usd:
        spent.length === 0
          ? null
          : Math.round(spent.reduce((t, st) => t + (st.spend_usd ?? 0), 0) * 100) / 100,
      workspaces: inAws.reduce((t, st) => t + (st.workspaces?.length ?? 0), 0),
      unpriced: inAws.filter((st) => !st.gone && st.cost === null).length + building.length,
      unread: inAws.filter((st) => !st.gone && st.workspaces === null).length,
    };
    return {
      clusters: statuses,
      failed: [],
      preflight,
      totals,
      next: cluster.nextStep({
        tools_ok: preflight.tools_ok,
        approved: preflight.approved,
        account: preflight.account,
        clusters: inAws,
        building,
        failed: [],
        default_context: byDefault,
      }),
      default: byDefault,
      unreadable: '',
    };
  });
}

/** The support cluster's ledger with these fields changed; every other cluster as fixed. */
function supportStatus(extra: Partial<cluster.Ledger>): void {
  mockClusterStatus.mockImplementation(async (context) => {
    const status = fakeClusterStatus(context);
    return context === CLUSTER_SUPPORT ? { ...status, ...extra } : status;
  });
}

/** Running cluster builds, as the job list reports them: [id, name, region]. */
function buildRunning(...builds: [string, string, string][]): JobManager {
  return {
    listJobs: () =>
      builds.map(([id, label, region]) => ({
        id,
        kind: 'cluster-create',
        label,
        region,
        actor: 'alice',
        status: 'running',
        started_at: Date.now() / 1000 - 760,
        finished_at: null,
        error: '',
        error_kind: '',
      })),
    drain: async () => [],
    get: () => undefined,
  } as unknown as JobManager;
}

function useDefaultClusters(): void {
  useClusterContexts(
    [clusterContext(CLUSTER_SUPPORT), clusterContext(CLUSTER_PERF, { is_default: false })],
    CLUSTER_SUPPORT,
  );
  mockClusterStatus.mockImplementation(async (context) => fakeClusterStatus(context));
}

async function prepareClusterCase(name: string): Promise<void> {
  if (name === 'only an admin is offered the controls that spend or destroy') {
    portedUser = 'ronly';
    portedPassword = 'read-only-password';
    await users.add(portedUser, portedPassword, 'readonly');
  }
  if (name === 'a member is offered no prepare or forget on a shared cluster') {
    portedUser = 'mem';
    portedPassword = 'member-password';
    await users.add(portedUser, portedPassword, 'member');
  }
  useDefaultClusters();
  if (
    name === 'a cluster on this machine is listed apart, free, and out of the aws totals' ||
    name === 'opening a local cluster reads its facts and offers nothing for aws' ||
    name === 'with only a cluster on this machine the page offers to set up eks'
  ) {
    const rows =
      name === 'with only a cluster on this machine the page offers to set up eks'
        ? [localContext('default', 'local')]
        : [
            clusterContext(CLUSTER_SUPPORT),
            localContext('default', 'local'),
            ...(name ===
            'a cluster on this machine is listed apart, free, and out of the aws totals'
              ? [localContext('lab', 'elsewhere')]
              : []),
          ];
    useClusterContexts(
      rows,
      name === 'with only a cluster on this machine the page offers to set up eks'
        ? ''
        : CLUSTER_SUPPORT,
    );
    mockClusterStatus.mockImplementation(async (context) =>
      context === 'default'
        ? localStatus()
        : context === 'lab'
          ? localStatus('lab', 'elsewhere')
          : fakeClusterStatus(context),
    );
    // kubectl names contexts and none is current: the footer's case.
    mockToolsReady.mockReturnValue(true);
    mockPreflight.mockResolvedValue({
      context: '',
      distribution: '',
      clusterReachable: false,
      nodeCount: 0,
      namespaces: [],
    } as never);
    if (name === 'with only a cluster on this machine the page offers to set up eks')
      preflightOverride = { approved: false };
  }
  mockCapacity.mockResolvedValue({
    known: true,
    total_mb: 8192,
    available_mb: 6144,
    reserve_mb: 1024,
    swap_mb: 0,
    workspace_mb: 1100,
    room: 4,
    room_denominated_in: 'docker',
    room_by_runtime: {
      docker: 4,
      'kubernetes-monolith': 2,
      'kubernetes-microservices': 1,
    },
  });

  if (
    name === 'the create form says what a managed cluster commits you to' ||
    name === 'the local certificate option goes when the cluster is not on this machine' ||
    name === 'step one quotes this machines memory only for places on it'
  ) {
    useClusterContexts(
      [
        clusterContext(CLUSTER_SUPPORT, {
          is_default: name !== 'step one quotes this machines memory only for places on it',
        }),
        clusterContext('kind-houston-local', {
          short: 'kind-houston-local',
          region: '',
          ours: true,
          provider: '',
          billable: false,
          is_default: false,
        }),
      ],
      name === 'step one quotes this machines memory only for places on it' ? '' : CLUSTER_SUPPORT,
    );
    // houston's own kind answers, so its card is one to choose.
    mockClusterStatus.mockImplementation(async (context) =>
      context === 'kind-houston-local'
        ? localStatus('kind-houston-local')
        : fakeClusterStatus(context),
    );
  }

  if (name === 'the create dialog never names a cluster the server will not use') {
    // The box default is a remote cluster the GUI does not show; kind could make a local one.
    useClusterContexts(
      [localContext('remote-k3s', 'elsewhere')].map((row) => ({ ...row, is_default: true })),
      'remote-k3s',
    );
    mockToolsReady.mockReturnValue(true);
    mockCanProvision.mockReturnValue(true);
  }

  if (
    name === 'a cluster aws says is gone does not read as one that is down' ||
    name === 'a gone cluster offers only controls that can work'
  ) {
    mockClusterStatus.mockImplementation(async (context) => {
      const status = fakeClusterStatus(context);
      if (context !== CLUSTER_PERF) return status;
      return {
        ...status,
        gone: true,
        reach_advice:
          'AWS says this cluster no longer exists, so it is not costing anything. ' +
          'The kubeconfig entry naming it is left over — ' +
          '`houston cluster forget perf` removes it.',
      };
    });
  }

  if (name === 'a kubernetes workspace names its cluster and can check its certificate') {
    useRows([
      kubeDetail({
        public_url: 'https://t1234.rc.example.com',
        open_url: 'https://t1234.rc.example.com',
        tls: 'acme',
        state: 'running',
      }),
    ]);
  }
  if (name === 'a cluster delete says in its job what aws still holds') {
    mockDeleteCluster.mockResolvedValue(true);
    mockSweepLeftovers.mockResolvedValue({
      found: [
        {
          kind: 'volume',
          id: 'vol-0abc',
          detail: '8 GB, created 2026-09-28',
          fix: 'aws ec2 delete-volume --region us-east-1 --volume-id vol-0abc',
          certain: true,
        },
        {
          kind: 'volume',
          id: 'vol-9zz',
          detail: '8 GB — not tagged with any cluster',
          fix: '',
          certain: false,
        },
      ],
      unreadable: [{ kind: 'stack', why: 'AccessDenied' }],
    });
  }
  if (name === 'the setup flow connects a cluster houston built and folds away the others') {
    useClusterContexts([], '');
    mockSweepClusters.mockResolvedValue({
      clusters: [
        {
          name: 'payments-prod',
          region: 'us-east-1',
          arn: 'arn:aws:eks:us-east-1:111122223333:cluster/payments-prod',
          status: 'ACTIVE',
          ours: false,
          created: '',
          expires: '',
        },
        {
          name: 'support',
          region: 'us-east-1',
          arn: CLUSTER_SUPPORT,
          status: 'ACTIVE',
          ours: true,
          created: '',
          expires: '',
        },
      ],
      unreadable: [],
      regions: ['us-east-1'],
      fallback: '',
      owned_only: false,
    } as never);
    mockConnectExisting.mockImplementation(async (arn) => {
      useClusterContexts([clusterContext(CLUSTER_SUPPORT)], CLUSTER_SUPPORT);
      return {
        context: arn,
        account: '111122223333',
        principal: 'arn:aws:iam::111122223333:user/alice',
        region: 'us-east-1',
        reachable: true,
        access_reason: '',
      } as never;
    });
  }
  if (
    name === 'the overview is read once while a read is in flight' ||
    name === 'the clusters page shows no number it has not read'
  ) {
    const real = mockOverview.getMockImplementation();
    mockOverview.mockImplementation(async (...args) => {
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          name === 'the overview is read once while a read is in flight' ? 1500 : 3000,
        ),
      );
      return await (real as NonNullable<typeof real>)(...args);
    });
  }
  if (name === 'a failed overview read says so and offers to try again') {
    mockOverview.mockRejectedValue(new Error('kubeconfig could not be read'));
  }
  if (name === 'this machine says it could not read its clusters, not that it has none') {
    mockKnownContexts.mockRejectedValue(new Error('kubeconfig could not be read'));
  }
  if (name === 'an unreadable kubeconfig is said with its reason') {
    // H11b: `chmod 000` on the kubeconfig of a running k3s. The list answers, empty, with why.
    mockKnownContexts.mockResolvedValue({
      contexts: [],
      unreadable:
        'error: error loading config file "/home/laborant/kube-run/config": open /home/laborant/kube-run/config: permission denied',
      default: '',
    });
    mockToolsReady.mockReturnValue(true);
  }
  if (
    name === 'a member opening create at once is told the cluster is being read' ||
    name === 'the create dialog redraws a local cluster card when its status arrives'
  ) {
    // A k3s that kubectl points at and no saved default: the box of H11c and H12.
    useClusterContexts([localContext('default', 'local')], '');
    mockClusterStatus.mockImplementation(async (context) => localStatus(context));
    mockToolsReady.mockReturnValue(true);
    const slow = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    };
    if (name === 'a member opening create at once is told the cluster is being read') {
      portedUser = 'mem';
      portedPassword = 'members-good-password';
      await users.add(portedUser, portedPassword, 'member');
      config.updateConfig((value) => {
        value[CREATE_POLICY_KEY] = 'admin';
      });
      // The probe that says where an empty context lands, slow as kubectl is.
      mockPreflight.mockImplementation(async () => {
        await slow();
        return {
          context: 'default',
          distribution: 'k3s',
          clusterReachable: true,
          nodeCount: 1,
          namespaces: [],
        } as never;
      });
    } else {
      // The overview that says the k3s is running, slow as it is on a real box.
      const real = mockOverview.getMockImplementation();
      mockOverview.mockImplementation(async (...args) => {
        await slow();
        return await (real as NonNullable<typeof real>)(...args);
      });
    }
  }
  if (name === 'this machine shows its cluster while the list is read again') {
    // The page load reads the list at once; the Clusters page's own read is slow.
    const local = {
      contexts: [
        clusterContext('default', {
          where: 'local',
          provider: 'k3s',
          billable: false,
          is_default: false,
        }),
      ],
      unreadable: '',
      default: '',
    };
    const start = Date.now();
    mockKnownContexts.mockImplementation(async () => {
      if (Date.now() - start > 3000) await new Promise((resolve) => setTimeout(resolve, 2500));
      return local;
    });
  }
  if (name === 'the setup flow says what the server is missing') {
    preflightOverride = {
      tools_ok: false,
      blockers: ['helm is not installed'],
      identity: '',
      account: '',
      approved: false,
    };
    mockWhoami.mockResolvedValue({ account: '', arn: '', error: 'Unable to locate credentials.' });
  }
  if (
    name === 'the setup re-check says it is checking and when it last checked' ||
    name === 'the setup flow names the aws profiles a server started without one could use'
  ) {
    preflightOverride = { identity: '', account: '', approved: false };
    mockWhoami.mockResolvedValue({ account: '', arn: '', error: 'Unable to locate credentials.' });
    mockProfiles.mockResolvedValue(['support-eks-houston']);
  }
  if (name === 'an expired aws sign-in says sign in, not install') {
    const expired = 'Error when retrieving token from sso: Token has expired and refresh failed';
    preflightOverride = {
      tools_ok: false,
      blockers: [`not signed in to AWS (${expired}). houston never holds AWS credentials.`],
      identity: '',
      account: '',
      approved: true,
    };
    mockWhoami.mockResolvedValue({ account: '', arn: '', error: expired });
  }
  if (name === 'an admin approves the account from the setup flow') {
    preflightOverride = { approved: false };
  }
  if (name === 'the build price follows the node count and the build carries its zone') {
    mockCreateCluster.mockResolvedValue({
      name: 'support2',
      region: 'us-east-1',
      account: '111122223333',
      nodes: 5,
      context: 'arn:aws:eks:us-east-1:111122223333:cluster/support2',
      expires: '2026-10-07',
      prepared: { cname_target: 'b2c3.us-east-1.elb.amazonaws.com', zone: 'rc.example.com' },
    } as never);
  }
  if (name === 'the dns step shows the record to add and says whether it answers') {
    mockClusterStatus.mockImplementation(async (context) => {
      const status = fakeClusterStatus(context);
      if (context !== CLUSTER_SUPPORT) return status;
      return {
        ...status,
        zone: 'rc.example.com',
        ready: { ...(status.ready as cluster.Readiness), dns_answers: false },
      };
    });
  }

  if (name === 'a cluster being built shows once, as its build') {
    // A second build named like perf, in another region: perf itself must stay on the page.
    portedJobs = buildRunning(
      ['j-support', 'support', 'us-east-1'],
      ['j-perf', 'perf', 'us-west-2'],
    );
  }
  if (name === 'a build running when the page loads is on home at once') {
    portedJobs = buildRunning(['j-perf2', 'perf2', 'us-east-1']);
  }
  if (name === 'a reminder wants you only once it is due') {
    supportStatus({ expires: '2026-10-07', expires_in_days: 1 });
  }
  if (name === 'a cluster whose names do not answer asks for its dns record') {
    supportStatus({
      zone: 'rc.example.com',
      workspaces: [],
      ready: {
        ...(fakeClusterStatus(CLUSTER_SUPPORT).ready as cluster.Readiness),
        dns_answers: false,
      },
    });
  }
  if (name === 'the dns dialog lays the record out and tells a proxied record from a missing one') {
    supportStatus({
      zone: 'rc.example.com',
      ready: {
        ...(fakeClusterStatus(CLUSTER_SUPPORT).ready as cluster.Readiness),
        dns_answers: false,
      },
    });
    mockResolveAddresses.mockResolvedValue(['104.21.71.43']);
  }
  if (name === 'create on a cluster with a dns zone asks for an email, not a domain') {
    // Built HERE: the server names a workspace from this box's build note only.
    useClusterContexts(
      [
        clusterContext(CLUSTER_SUPPORT, { made_by_houston: true }),
        clusterContext(CLUSTER_PERF, { is_default: false }),
      ],
      CLUSTER_SUPPORT,
    );
    supportStatus({
      zone: 'rc.example.com',
      ready: {
        ...(fakeClusterStatus(CLUSTER_SUPPORT).ready as cluster.Readiness),
        dns_answers: true,
      },
    });
    mockCreateRepro.mockResolvedValue({} as never);
  }
  if (name === 'opening a workspace shows its header before its own read answers') {
    const row = detail({
      runtime: 'kubernetes',
      deployment: 'monolith',
      context: CLUSTER_SUPPORT,
      namespace: 'houston-t1234',
      containers: [],
    });
    useRows([row]);
    releaseDetail = null;
    mockDetail.mockImplementation(
      async () =>
        await new Promise((resolve) => {
          releaseDetail = () => resolve(row as never);
        }),
    );
  }
  if (name === 'the workspace list is read one at a time') {
    const rows = [detail()];
    listReads = { calls: 0, open: 0, most: 0 };
    mockListRepros.mockImplementation(async () => {
      listReads.calls += 1;
      listReads.open += 1;
      listReads.most = Math.max(listReads.most, listReads.open);
      // The first read draws the page; every later one is a slow cluster's 4.5 s.
      if (listReads.calls > 1) await new Promise((resolve) => setTimeout(resolve, 4500));
      listReads.open -= 1;
      return rows as never;
    });
  }
  if (name === 'a build in progress is a card with its elapsed time') {
    portedJobs = {
      listJobs: () => [
        {
          id: 'j-build',
          kind: 'cluster-create',
          label: 'perf2',
          actor: 'alice',
          status: 'running',
          started_at: Date.now() / 1000 - 760,
          finished_at: null,
          error: '',
          error_kind: '',
        },
      ],
      drain: async () => [],
      get: () => undefined,
    } as unknown as JobManager;
  }

  if (name === 'create shows its progress and ends with where to go') {
    mockCreateRepro.mockImplementation(async (req, emit) => {
      // The name the create settled on comes first; the title takes it (it guessed one).
      emit?.(
        event('workspace name: first-one', {
          phase: 'create',
          code: 'workspace-name',
          data: { workspace: 'first-one' },
        }),
      );
      // As a real create streams them: many lines per phase, docker's pull lines among them.
      for (const [phase, message] of [
        ['pull', 'Image rocket.chat:8.5.1 Pulling'],
        ['pull', 'df076c1feb21 Downloading 3.146MB'],
        ['pull', 'Image rocket.chat:8.5.1 Pulled'],
        ['boot', 'Starting MongoDB'],
        ['wait', 'Waiting for Rocket.Chat'],
      ] as const) {
        emit?.(event(message, { phase }));
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      return {
        name: 'first-one',
        rc_version: req.version,
        mongo_tag: '8.0',
        preset: 'default',
        root_url: 'http://localhost:3005',
        login: { user: 'admin', password: 'admin123' },
        notes: [],
      } as never;
    });
  }
  if (name === 'first run home offers to create the first workspace') {
    useRows([]);
  }

  if (name === 'the cluster picker shows a name not sixty characters of arn') {
    const arn = 'arn:aws:eks:us-east-1:533674205877:cluster/chatrepo';
    useClusterContexts(
      [
        clusterContext(arn, {
          short: 'chatrepo',
          region: 'us-east-1',
          is_default: true,
        }),
        clusterContext('kind-houston-local', {
          short: 'kind-houston-local',
          region: '',
          ours: true,
          provider: '',
          billable: false,
          is_default: false,
        }),
      ],
      arn,
    );
  }
}

/** The Clusters page, with every card read: none of them still says "Reading…". */
/** WCAG contrast of each selector's text against the backgrounds it is painted over. */
async function contrastRatios(
  page: Page,
  selectors: readonly string[],
): Promise<Record<string, number>> {
  return await page.evaluate((list) => {
    const rgba = (value: string): number[] =>
      [...(value.match(/[\d.]+/gu) ?? []).map(Number), 1].slice(0, 4);
    const over = (top: number[], under: number[]): number[] => [
      ...[0, 1, 2].map(
        (i) => (top[i] ?? 0) * (top[3] ?? 1) + (under[i] ?? 0) * (1 - (top[3] ?? 1)),
      ),
      1,
    ];
    const luminance = (colour: number[]): number => {
      const [r = 0, g = 0, b = 0] = colour.slice(0, 3).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const out: Record<string, number> = {};
    for (const selector of list) {
      const node = document.querySelector(selector);
      if (node === null) {
        out[selector] = -1;
        continue;
      }
      const layers: number[][] = [];
      for (let at: Element | null = node; at !== null; at = at.parentElement)
        layers.push(rgba(getComputedStyle(at).backgroundColor));
      const ground = layers
        .reverse()
        .reduce((under, layer) => over(layer, under), [255, 255, 255, 1]);
      const ink = over(rgba(getComputedStyle(node).color), ground);
      const [hi = 0, lo = 0] = [luminance(ink), luminance(ground)].sort((a, b) => b - a);
      out[selector] = Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
    }
    return out;
  }, selectors);
}

async function openClusterLedger(page: Page): Promise<void> {
  await page.locator('#btn-clusters').click();
  await page.waitForFunction(() => {
    const cards = [...document.querySelectorAll('#cl-local .mrow, #cl-eks .place')];
    return cards.length >= 2 && cards.every((card) => !card.textContent.includes('Reading…'));
  });
}

async function openClusterCreate(page: Page): Promise<void> {
  await page.locator('#btn-new').click();
  await page.locator('#create-dialog[open]').waitFor({ state: 'visible' });
  await page.locator('#dest-cards label[data-dest="docker"]').waitFor({ state: 'visible' });
}

/** Choose where it runs the way a person does: its card in step 1. */
async function pickPlace(page: Page, key: string): Promise<void> {
  await page.locator(`#dest-cards label[data-dest="${key}"]`).click();
}

/** On to step 2, the details. */
async function createDetails(page: Page): Promise<void> {
  await page.locator('#create-next').click();
  await page.locator('#create-step-2:not([hidden])').waitFor({ state: 'visible' });
}

/** Back to step 1, where it runs. */
async function createWhere(page: Page): Promise<void> {
  await page.locator('#create-back').click();
  await page.locator('#create-step-1:not([hidden])').waitFor({ state: 'visible' });
}

/** A cluster's own view, opened from its card or row on the Clusters page. */
async function openPlaceView(page: Page, key: string, title: string): Promise<void> {
  await page
    .locator(`#cl-eks .place[data-place="${key}"], #cl-local .mrow[data-place="${key}"]`)
    .click();
  await page.waitForFunction(
    (want) => document.querySelector('#detail .dhead h1')?.textContent === want,
    title,
  );
}

async function exerciseClusterCase(name: string, page: Page): Promise<void> {
  if (name === 'an unreadable kubeconfig is said with its reason') {
    // The server sent the reason; the page said there was no cluster and no kind.
    await page.locator('#btn-clusters').click();
    await page.waitForFunction(
      () => (document.querySelector('#cl-local')?.textContent ?? '').includes('permission denied'),
      undefined,
      { timeout: 5000 },
    );
    const local = await page.locator('#cl-local').innerText();
    expect(local).toContain("This server's kubeconfig could not be read: error: error loading");
    expect(local).not.toContain('No cluster on this server');
    // And the footer agrees: it said "k8s: not set up" beside this page.
    await page.waitForFunction(
      () =>
        (document.querySelector('#sb-engines')?.textContent ?? '').endsWith(
          'k8s: kubeconfig unreadable',
        ),
      undefined,
      { timeout: 5000 },
    );
    return;
  }
  if (name === 'a member opening create at once is told the cluster is being read') {
    // Opened before the probe answers: where an empty context lands is not known yet. It
    // said "Unavailable" and that an admin keeps the choice, and never changed while open.
    await openClusterCreate(page);
    const card = page.locator('#dest-cards label[data-dest="k8s-default"]');
    const early = await card.innerText();
    expect(early).toContain('Reading…');
    expect(early).not.toContain('Unavailable');
    expect(await card.locator('input').isDisabled()).toBe(true);
    await page.waitForFunction(
      () =>
        (
          document.querySelector('#dest-cards label[data-dest="k8s-default"]')?.textContent ?? ''
        ).includes("This server's default · "),
      undefined,
      { timeout: 8000 },
    );
    expect(await card.innerText()).toContain('Ready');
    expect(await card.locator('input').isDisabled()).toBe(false);
    return;
  }
  if (name === 'the create dialog redraws a local cluster card when its status arrives') {
    // H11c: the k3s card said "Reading…" for as long as the dialog stayed open; only
    // closing and opening it again showed "Running".
    await openClusterCreate(page);
    const card = page.locator('#dest-cards label[data-dest="k8s:default"]');
    expect(await card.innerText()).toContain('Reading…');
    await page.waitForFunction(
      () =>
        (
          document.querySelector('#dest-cards label[data-dest="k8s:default"]')?.textContent ?? ''
        ).includes('Running'),
      undefined,
      { timeout: 8000 },
    );
    expect(await card.innerText()).not.toContain('Reading…');
    return;
  }
  if (name === 'the fake cluster status matches the real payload') {
    const required: readonly (keyof cluster.Ledger)[] = [
      'context',
      'distribution',
      'provider',
      'ours',
      'reachable',
      'unreadable',
      'reach_status',
      'reach_why',
      'reach_advice',
      'manageable',
      'unmanageable_why',
      'gone',
      'nodes',
      'age_hours',
      'instance_types',
      'workspaces',
      'pvcs',
      'loadbalancers',
      'operator',
      'monitoring',
      'cost',
      'name',
      'region',
      'made_by_houston',
      'created_at',
      'expires',
      'expires_in_days',
      'spend_usd',
      'ready',
      'zone',
      'where',
    ];
    const fake: cluster.Ledger = fakeClusterStatus(CLUSTER_SUPPORT);
    expect(Object.keys(fake).sort()).toEqual([...required].sort());
    return;
  }

  if (name === 'the cluster chip wants you in amber and is never red') {
    await page.locator('#cluster-badge:not([hidden])').waitFor({ state: 'visible' });
    await openClusterLedger(page);
    await page.waitForFunction(() =>
      document.querySelector('#cluster-badge')?.classList.contains('warn'),
    );
    const classes = (await page.locator('#cluster-badge').getAttribute('class')) ?? '';
    expect(classes).toContain('warn');
    expect(classes).not.toContain('down');
    // What EKS costs per day, from the overview, not only a count.
    expect(await page.locator('#cluster-badge').innerText()).toContain('EKS ~$8.46/day');
    return;
  }

  if (name === 'a kubernetes workspace names its cluster and can check its certificate') {
    // "Runs on" said Kubernetes and nothing about which cluster; the ARN sat in a note card.
    await openWorkspace(page);
    const runsOn = page.locator('.kv', { has: page.locator('.k', { hasText: 'Runs on' }) });
    const text = await runsOn.innerText();
    expect(text).toContain('support');
    expect(text).toContain('us-east-1');
    expect(text).not.toContain('arn:aws');
    // The TLS route answers for a cluster workspace too, so its check is not hidden.
    const pane = await page.locator('#actpane').innerText();
    expect(pane).toContain('Check the certificate');
    // The cluster's name goes to the cluster's own view.
    await runsOn.getByRole('button', { name: /support/u }).click();
    await page.waitForFunction(
      () => document.querySelector('#detail .dhead h1')?.textContent === 'support',
    );
    expect(await page.locator('#btn-clusters').getAttribute('aria-current')).not.toBeNull();
    return;
  }

  if (name === 'the overview is read once while a read is in flight') {
    // One EKS status is ~18 s; Home re-asked every 15 s and the page asked again on open,
    // so a slow overview was being read two and three times at once.
    await page.locator('#detail .pv.home').waitFor({ state: 'visible' });
    await page.locator('#btn-clusters').click();
    await page.waitForFunction(
      () => {
        const cards = [...document.querySelectorAll('#cl-eks .place')];
        return cards.length >= 2 && cards.every((card) => !card.textContent.includes('Reading…'));
      },
      undefined,
      { timeout: 10_000 },
    );
    expect(mockOverview).toHaveBeenCalledTimes(1);
    return;
  }

  if (name === 'the clusters page shows no number it has not read') {
    // While the overview is on its way the cards say so; a total, a cost or a count of
    // workspaces before then would be a zero nobody read.
    await page.locator('#btn-clusters').click();
    await page.locator('#cl-eks .place').first().waitFor({ state: 'visible' });
    const reading = await page.locator('#cl-aws').innerText();
    expect(reading).toContain('Reading…');
    expect(reading).toContain('bills by the hour');
    expect(reading).not.toMatch(/~\$[0-9]/u);
    expect(reading).not.toMatch(/\b0 workspaces|No workspaces/u);
    expect(reading).not.toContain('together');
    await page.waitForFunction(
      () => (document.querySelector('#cl-aws')?.textContent ?? '').includes('~$8.46'),
      undefined,
      { timeout: 10_000 },
    );
    return;
  }

  if (name === 'a failed overview read says so and offers to try again') {
    // It left "reading every cluster…" up for ever and printed the raw status underneath.
    await page.locator('#btn-clusters').click();
    const error = page.locator('#cl-aws .zerr');
    await error.waitFor({ state: 'visible' });
    expect(await error.innerText()).toContain("Couldn't read the clusters");
    expect(await page.locator('#cl-aws').innerText()).not.toContain('Reading…');
    const before = mockOverview.mock.calls.length;
    await error.getByRole('button', { name: 'Try again' }).click();
    for (let n = 0; n < 40 && mockOverview.mock.calls.length === before; n += 1)
      await page.waitForTimeout(100);
    expect(mockOverview.mock.calls.length).toBeGreaterThan(before);
    return;
  }

  if (name === 'this machine says it could not read its clusters, not that it has none') {
    // A running k3s was shown as "Unavailable -- No cluster on this machine" while its list
    // had not been read: "I could not ask" said as "it is not there".
    await page.locator('#btn-clusters').click();
    await page.waitForFunction(() =>
      (document.querySelector('#cl-local')?.textContent ?? '').includes('Not answering'),
    );
    const local = await page.locator('#cl-local').innerText();
    expect(local).toContain('could not be read');
    expect(local).not.toContain('No cluster on this server');
    return;
  }

  if (name === 'this machine shows its cluster while the list is read again') {
    // The rows followed the page load's read only when a build started or ended, so the
    // page drew "Unavailable -- No cluster on this machine" for a running k3s until its own
    // (slow) read came back.
    // The page load's own reads (the list behind the cluster chip) are answered at once.
    await page.waitForTimeout(3200);
    await page.locator('#btn-clusters').click();
    await page.waitForTimeout(400);
    const early = await page.locator('#cl-local').innerText();
    expect(early).not.toContain('No cluster on this server');
    expect(early).toContain('default');
    await page.waitForTimeout(2600);
    return;
  }

  if (name === 'an expired aws sign-in says sign in, not install') {
    // An expired SSO token on a box with every tool installed was told to install the tools.
    await page.locator('#btn-clusters').click();
    const line = page.locator('#cl-connection');
    await line.waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
      (document.querySelector('#cl-connection')?.textContent ?? '').includes('expired'),
    );
    expect(await line.innerText()).toContain("The server's AWS sign-in has expired");
    expect((await line.getAttribute('class')) ?? '').toContain('bad');
    await line.getByRole('button', { name: 'Sign in again' }).click();
    const flow = page.locator('#eks-setup[open]');
    await flow.waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
      (document.querySelector('#eks-body')?.textContent ?? '').includes('aws sso login'),
    );
    const said = await flow.innerText();
    expect(said).toContain('SSO sign-in has expired');
    expect(said.toLowerCase()).not.toContain('install');
    return;
  }

  if (name === 'the setup re-check says it is checking and when it last checked') {
    // Re-check answered the same "not signed in" and redrew the same screen: it looked like
    // a button that did nothing. It says it is asking, then when it asked.
    await page.locator('#btn-clusters').click();
    await page
      .locator('#cl-aws')
      .getByRole('button', { name: /Set up Amazon EKS|Add a cluster/u })
      .first()
      .click();
    const flow = page.locator('#eks-setup[open]');
    await flow.waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
      (document.querySelector('#eks-foot')?.textContent ?? '').includes('Checked at'),
    );
    let answer: (value: Awaited<ReturnType<typeof eks.whoami>>) => void = () => undefined;
    mockWhoami.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    await flow.getByRole('button', { name: 'Re-check' }).click();
    const busy = flow.getByRole('button', { name: 'Checking…' });
    await busy.waitFor({ state: 'visible' });
    expect(await busy.isDisabled()).toBe(true);
    answer({ account: '', arn: '', error: 'Unable to locate credentials.' });
    await flow.getByRole('button', { name: 'Re-check' }).waitFor({ state: 'visible' });
    expect(await flow.getByRole('button', { name: 'Re-check' }).isDisabled()).toBe(false);
    expect(await page.locator('#eks-foot').innerText()).toMatch(
      /Re-check after signing in on the server\. Checked at \S/u,
    );
    return;
  }

  if (name === 'the setup flow names the aws profiles a server started without one could use') {
    // `aws sts get-caller-identity --profile p` worked in a shell while the server, started
    // without AWS_PROFILE, was not signed in -- and Re-check cannot fix that. It names the
    // profiles the server's AWS config has and says to restart with one.
    const prior = process.env.AWS_PROFILE;
    delete process.env.AWS_PROFILE;
    try {
      await page.locator('#btn-clusters').click();
      await page
        .locator('#cl-aws')
        .getByRole('button', { name: /Set up Amazon EKS|Add a cluster/u })
        .first()
        .click();
      const hint = page.locator('#eks-setup[open] #eks-profiles');
      await hint.waitFor({ state: 'visible' });
      const said = await hint.innerText();
      expect(said).toContain('This server was started without AWS_PROFILE');
      expect(said).toContain('support-eks-houston');
      expect(said).toContain('AWS_PROFILE=support-eks-houston houston serve');
      expect(said).toContain('houston serve --print-service');
      // A server started WITH a profile is not told to set one: the hint is not drawn.
      process.env.AWS_PROFILE = 'support-eks-houston';
      await page.locator('#eks-setup[open]').getByRole('button', { name: 'Re-check' }).click();
      await page.waitForFunction(() => document.querySelector('#eks-profiles') === null);
      expect(mockProfiles).toHaveBeenCalledTimes(1);
    } finally {
      if (prior === undefined) delete process.env.AWS_PROFILE;
      else process.env.AWS_PROFILE = prior;
    }
    return;
  }

  if (name === 'home asks about an eks cluster only when it wants you') {
    // Home's clusters card repeated the page. Home says what needs somebody; the chip
    // carries the money.
    const needs = page.locator('#home-needs');
    await needs.waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
      (document.querySelector('#home-needs')?.textContent ?? '').includes('perf'),
    );
    const text = await needs.innerText();
    expect(text).toContain('perf (Amazon EKS) is not answering');
    expect(text).not.toContain('support');
    expect(await page.locator('#detail .hcard', { hasText: 'Clusters' }).count()).toBe(0);
    expect(await page.locator('#cluster-badge').innerText()).toContain('~$8.46/day');
    await needs.getByRole('button', { name: 'Review' }).click();
    await page.waitForFunction(
      () => document.querySelector('#detail .dhead h1')?.textContent === 'perf',
    );
    return;
  }

  if (name === 'first run home offers to create the first workspace') {
    const welcome = page.locator('#home-welcome');
    await welcome.waitFor({ state: 'visible' });
    expect(await welcome.innerText()).toContain('Create your first workspace');
    expect(await page.locator('#detail').textContent()).toContain('Memory on this server');
    await welcome.getByRole('button', { name: /Create a workspace/u }).click();
    await page.locator('#create-dialog[open]').waitFor({ state: 'visible' });
    expect(await page.locator('#create-step-1').isVisible()).toBe(true);
    expect(await page.locator('#dest-cards input[name=dest]:checked').getAttribute('value')).toBe(
      'docker',
    );
    return;
  }

  if (name === 'with only a cluster on this machine the page offers to set up eks') {
    // A box with only a k3s was shown Tools, Approve and Build ticked, as if it were an EKS
    // build somebody had finished. It is one row on this machine, and EKS offers its setup.
    await page.locator('#btn-clusters').click();
    await page.locator('#cl-local .mrow[data-place="k8s:default"]').waitFor({ state: 'visible' });
    await page.locator('#cl-hero').waitFor({ state: 'visible' });
    expect(await page.locator('#cl-eks').count()).toBe(0);
    expect(await page.locator('#cl-stepper').count()).toBe(0);
    expect(await page.locator('#cl-hero').innerText()).toContain('Set up Amazon EKS');
    // Opened, it is its own view, read in full, and nothing about AWS in its pane.
    await page.locator('#cl-local .mrow[data-place="k8s:default"]').click();
    await page.waitForFunction(() =>
      (document.querySelector('#detail')?.textContent ?? '').includes('local-path'),
    );
    expect(await page.locator('#detail .dhead h1').innerText()).toBe('Kubernetes');
    // Home does not ask somebody with a k3s about an AWS account.
    await page.locator('#btn-home').click();
    await page.locator('#detail .pv.home').waitFor({ state: 'visible' });
    const home = await page.locator('#detail').innerText();
    expect(home).not.toContain('billing');
    expect(home).not.toContain('Amazon EKS');
    expect(await page.locator('#cluster-badge').isHidden()).toBe(true);
    return;
  }

  if (name === 'the setup flow connects a cluster houston built and folds away the others') {
    // The first time is the case the flow exists for: with no kubeconfig context the page
    // still reads the server. Build comes first; the check below it lists what houston
    // built, and the company's own clusters in the account stay folded away and labelled.
    await page.locator('#btn-clusters').click();
    await page.locator('#cl-hero').waitFor({ state: 'visible' });
    await page.locator('#cl-hero').getByRole('button', { name: 'Set up Amazon EKS' }).click();
    const flow = page.locator('#eks-setup[open]');
    await flow.waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
      (document.querySelector('#eks-body')?.textContent ?? '').includes('Signed in as'),
    );
    expect(await flow.innerText()).toContain('111122223333');
    await flow.getByRole('button', { name: 'Next →' }).click();
    const choices = await page.locator('#eks-body label.choice b').allInnerTexts();
    expect(choices).toEqual(['Build a new cluster', 'Check for a cluster houston already built']);
    expect(await page.locator('#eks-body input[value=build]').isChecked()).toBe(true);
    await page.locator('#eks-body input[value=existing]').check();
    await flow.getByRole('button', { name: /Check account 111122223333/u }).click();
    await page.locator('#eks-body [data-swept="support"]').waitFor({ state: 'visible' });
    expect(mockSweepClusters).toHaveBeenCalledWith(expect.objectContaining({ ownedOnly: false }));
    expect(await page.locator('#eks-body [data-swept="support"]').innerText()).toContain(
      'built with houston',
    );
    const others = page.locator('#eks-others');
    expect(await others.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
    expect(await others.locator('summary').innerText()).toBe(
      '1 other EKS cluster in this account, not built with houston',
    );
    expect(await page.locator('#eks-body [data-swept="payments-prod"]').isVisible()).toBe(false);
    expect(await others.textContent()).toContain('meant for testing');
    await page
      .locator('#eks-body [data-swept="support"]')
      .getByRole('button', { name: 'Connect' })
      .click();
    await page.waitForFunction(() =>
      (document.querySelector('#eks-body')?.textContent ?? '').includes('support is connected'),
    );
    expect(mockConnectExisting).toHaveBeenCalledWith(CLUSTER_SUPPORT);
    expect(mockCreateCluster).not.toHaveBeenCalled();
    await page.locator('#eks-foot').getByRole('button', { name: 'Close' }).click();
    await page
      .locator('#cl-eks .place[data-place$="cluster/support"]')
      .waitFor({ state: 'visible' });
    return;
  }

  if (name === 'the setup flow says what the server is missing') {
    // A first-time admin lands on what stops them: helm missing and no AWS identity. The
    // fix is said, never a key form, and Next waits until Re-check finds an identity.
    await page.locator('#btn-clusters').click();
    await page
      .locator('#cl-aws')
      .getByRole('button', { name: /Set up Amazon EKS|Add a cluster/u })
      .first()
      .click();
    const flow = page.locator('#eks-setup[open]');
    await flow.waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
      (document.querySelector('#eks-body')?.textContent ?? '').includes("isn't signed in"),
    );
    const one = await flow.innerText();
    expect(one).toContain('missing: helm');
    expect(one).toContain('Company SSO');
    expect(one).toContain('aws sso login');
    expect(one).toContain('Server role');
    expect(await flow.locator('input[type=password]').count()).toBe(0);
    expect(await flow.getByRole('button', { name: 'Next →' }).isDisabled()).toBe(true);
    preflightOverride = { approved: false };
    mockWhoami.mockResolvedValue({
      account: '111122223333',
      arn: 'arn:aws:iam::111122223333:user/alice',
      error: '',
    });
    const asked = mockOverview.mock.calls.length;
    await flow.getByRole('button', { name: 'Re-check' }).click();
    await page.waitForFunction(() =>
      (document.querySelector('#eks-body')?.textContent ?? '').includes('Signed in as'),
    );
    expect(await flow.getByRole('button', { name: 'Next →' }).isDisabled()).toBe(false);
    // RE-CHECK ASKS AGAIN. The server keeps the AWS tools and identity for ten minutes; a
    // Re-check after `aws sso login` answered from that read left Build disabled.
    for (let n = 0; n < 40 && mockOverview.mock.calls.length === asked; n += 1)
      await page.waitForTimeout(100);
    expect(
      mockOverview.mock.calls.slice(asked).some(([, options]) => options?.reuse === false),
    ).toBe(true);
    return;
  }

  if (name === 'the setup flow can be closed from every step') {
    // Every step can be left, by its own button and by the close mark.
    await page.locator('#btn-clusters').click();
    for (const step of [1, 2] as const) {
      await page
        .locator('#cl-aws')
        .getByRole('button', { name: /Set up Amazon EKS|Add a cluster/u })
        .first()
        .click();
      const flow = page.locator('#eks-setup[open]');
      await flow.waitFor({ state: 'visible' });
      await page.waitForFunction(() =>
        (document.querySelector('#eks-body')?.textContent ?? '').includes('Signed in as'),
      );
      if (step === 2) await flow.getByRole('button', { name: 'Next →' }).click();
      expect(await page.locator('#eks-steps .on').innerText()).toContain(
        step === 1 ? 'Connect AWS' : 'Choose a cluster',
      );
      await page.locator('#eks-x').click();
      await page.waitForFunction(
        () => !(document.querySelector('#eks-setup') as HTMLDialogElement).open,
      );
    }
    await page
      .locator('#cl-aws')
      .getByRole('button', { name: /Add a cluster/u })
      .click();
    await page.locator('#eks-setup[open]').getByRole('button', { name: 'Cancel' }).click();
    await page.waitForFunction(
      () => !(document.querySelector('#eks-setup') as HTMLDialogElement).open,
    );
    return;
  }

  if (name === 'an admin approves the account from the setup flow') {
    await page.locator('#btn-clusters').click();
    await page
      .locator('#cl-aws')
      .getByRole('button', { name: /Add a cluster/u })
      .click();
    const flow = page.locator('#eks-setup[open]');
    await flow.waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
      (document.querySelector('#eks-body')?.textContent ?? '').includes('Signed in as'),
    );
    await flow.getByRole('button', { name: 'Next →' }).click();
    await page.locator('#eks-body input[value=build]').check();
    await page.waitForFunction(() =>
      (document.querySelector('#eks-body')?.textContent ?? '').includes("isn't approved"),
    );
    expect(await flow.getByRole('button', { name: /Build it/u }).isDisabled()).toBe(true);
    await flow.locator('input[name=eks_email]').fill('alice@example.com');
    await flow.getByRole('button', { name: /Approve account 111122223333/u }).click();
    await page.waitForFunction(
      () => !(document.querySelector('#eks-body')?.textContent ?? '').includes("isn't approved"),
    );
    expect(config.approvedAwsAccounts().has('111122223333')).toBe(true);
    expect(String(config.loadConfig().acme_email)).toBe('alice@example.com');
    return;
  }

  if (name === 'the build price follows the node count and the build carries its zone') {
    // The price is the ledger's own table, through /api/clusters/estimate, and it changes
    // as the Nodes field does.
    await page.locator('#btn-clusters').click();
    await page
      .locator('#cl-aws')
      .getByRole('button', { name: /Add a cluster/u })
      .click();
    const flow = page.locator('#eks-setup[open]');
    await flow.waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
      (document.querySelector('#eks-body')?.textContent ?? '').includes('Signed in as'),
    );
    await flow.getByRole('button', { name: 'Next →' }).click();
    await page.locator('#eks-body input[value=build]').check();
    const perHour = async (): Promise<number> => {
      const text = await page.locator('#eks-estimate').innerText();
      return Number(/~\$([0-9.]+) an hour/u.exec(text)?.[1] ?? 'NaN');
    };
    await page.waitForFunction(() =>
      /~\$[0-9.]+ an hour/u.test(document.querySelector('#eks-estimate')?.textContent ?? ''),
    );
    const three = await perHour();
    await flow.locator('input[name=eks_nodes]').fill('5');
    await page.waitForFunction((was) => {
      const m = /~\$([0-9.]+) an hour/u.exec(
        document.querySelector('#eks-estimate')?.textContent ?? '',
      );
      return m !== null && Number(m[1]) !== was;
    }, three);
    expect(await perHour()).toBeGreaterThan(three);
    await flow.locator('input[name=eks_name]').fill('support2');
    await flow.locator('input[name=eks_zone]').fill('rc.example.com');
    await flow.getByRole('button', { name: /Build it/u }).click();
    for (let n = 0; n < 40 && mockCreateCluster.mock.calls.length === 0; n += 1)
      await page.waitForTimeout(100);
    expect(mockCreateCluster).toHaveBeenCalledWith(
      'support2',
      expect.objectContaining({ nodes: 5, zone: 'rc.example.com' }),
    );
    await page.waitForFunction(() =>
      (document.querySelector('#eks-body')?.textContent ?? '').includes('support2 is being built'),
    );
    return;
  }

  if (name === 'step one shows one card per place with what it costs') {
    // One card per place, the same cards the Clusters page shows. The money is the
    // ledger's, read by the overview, and choosing a billing cluster says what it means.
    await openClusterCreate(page);
    const support = page.locator(`#dest-cards label[data-dest="eks:${CLUSTER_SUPPORT}"]`);
    await page.waitForFunction(
      (key) =>
        (
          document.querySelector(`#dest-cards label[data-dest="${key}"]`)?.textContent ?? ''
        ).includes('~$8.46'),
      `eks:${CLUSTER_SUPPORT}`,
    );
    expect(await support.innerText()).toContain('support');
    expect(await support.innerText()).not.toContain('arn:aws');
    // perf refuses these credentials: listed, and not something to choose.
    expect(
      await page.locator(`#dest-cards label[data-dest="eks:${CLUSTER_PERF}"] input`).isDisabled(),
    ).toBe(true);
    expect(await page.locator('#dest-cards').innerText()).not.toContain('`');
    await pickPlace(page, `eks:${CLUSTER_SUPPORT}`);
    expect(await page.locator('#context-select').inputValue()).toBe(CLUSTER_SUPPORT);
    expect(await page.locator('#runtime-value').inputValue()).toBe('kubernetes');
    const note = await page.locator('#dest-note').innerText();
    expect(note).toContain('shared');
    expect(note).toContain("doesn't stop the charge");
    return;
  }

  if (name === 'create here opens the details on that cluster') {
    // From a cluster to a workspace on it: its view's first action opens Create on the
    // details, with that cluster chosen.
    await openClusterLedger(page);
    await openPlaceView(page, `eks:${CLUSTER_SUPPORT}`, 'support');
    await page.locator('#actpane').getByRole('button', { name: 'Create a workspace here' }).click();
    await page.locator('#create-dialog[open]').waitFor({ state: 'visible' });
    await page.locator('#create-step-2:not([hidden])').waitFor({ state: 'visible' });
    expect(await page.locator('#context-select').inputValue()).toBe(CLUSTER_SUPPORT);
    expect(await page.locator('#runtime-value').inputValue()).toBe('kubernetes');
    expect(await page.locator('#create-summary').innerText()).toContain('support · Amazon EKS');
    return;
  }

  if (name === 'create shows its progress and ends with where to go') {
    // The create used to hand off to a second dialog of raw lines; it shows its own steps.
    await openClusterCreate(page);
    await createDetails(page);
    await page.locator('#create-form input[name=version]').fill('8.5.1');
    await page.locator('#create-submit').click();
    await page.locator('#create-step-3:not([hidden])').waitFor({ state: 'visible' });
    // While it runs, the title names the workspace the server settled on.
    await page.waitForFunction(() =>
      (document.querySelector('#create-progress-title')?.textContent ?? '').startsWith(
        'Creating first-one on',
      ),
    );
    await page.waitForFunction(() =>
      (document.querySelector('#create-progress-title')?.textContent ?? '').includes('is ready'),
    );
    const items = await page.locator('#create-progress li').allInnerTexts();
    // One step per phase, named for what it does -- not one line per docker layer.
    expect(items.length).toBe(3);
    expect(items[0]).toContain('Pulling images');
    expect(items[0]).toContain('Pulled');
    expect(items.join('\n')).not.toContain('Downloading');
    expect(await page.locator('#create-progress .s.run').count()).toBe(0);
    expect(await page.locator('#create-result').innerText()).toContain('admin / admin123');
    expect(await page.locator('#create-open-rc').getAttribute('href')).toBe(
      'http://localhost:3005',
    );
    expect(
      await page.locator('#job-dialog').evaluate((node) => (node as HTMLDialogElement).open),
    ).toBe(false);
    return;
  }

  if (name === 'a cluster being built shows once, as its build') {
    // eksctl writes the cluster's kubeconfig context part-way through a build, and from
    // then the page drew the build's card AND the cluster's own card: one cluster, two
    // states side by side. Home listed both as well.
    await page.locator('#btn-clusters').click();
    await page.locator('#cl-eks .place[data-job="j-support"]').waitFor({ state: 'visible' });
    await page.waitForFunction(
      () => !(document.querySelector('#cl-eks')?.textContent ?? '').includes('Reading…'),
    );
    expect(await page.locator(`#cl-eks .place[data-place="eks:${CLUSTER_SUPPORT}"]`).count()).toBe(
      0,
    );
    // A build named perf in us-west-2 is not the perf in eu-west-1: a name is unique per region.
    expect(await page.locator(`#cl-eks .place[data-place="eks:${CLUSTER_PERF}"]`).count()).toBe(1);
    await page.locator('#btn-home').click();
    await page.waitForFunction(() =>
      (document.querySelector('#home-needs')?.textContent ?? '').includes('support is being built'),
    );
    expect(await page.locator('#home-needs').innerText()).not.toContain('support (Amazon EKS)');
    return;
  }

  if (name === 'a build running when the page loads is on home at once') {
    // The build list was read only while one was already known, so after a page load a
    // running build was missing from Home and the chip until someone opened Clusters.
    await page.waitForFunction(() =>
      (document.querySelector('#home-needs')?.textContent ?? '').includes('perf2 is being built'),
    );
    expect(await page.locator('#cluster-badge').innerText()).toContain('EKS · building');
    return;
  }

  if (name === 'a reminder wants you only once it is due') {
    // Flagged from three days out, a cluster built with tomorrow's reminder wanted you the
    // minute it was ready -- above the DNS record it actually needed.
    await page.waitForFunction(() =>
      (document.querySelector('#home-needs')?.textContent ?? '').includes('perf'),
    );
    expect(await page.locator('#home-needs').innerText()).not.toContain('support');
    supportStatus({ expires: '2026-10-06', expires_in_days: 0 });
    await page.locator('#btn-refresh').click();
    await page.waitForFunction(() =>
      (document.querySelector('#home-needs')?.textContent ?? '').includes(
        'support (Amazon EKS) reaches its reminder date today',
      ),
    );
    return;
  }

  if (name === 'a cluster whose names do not answer asks for its dns record') {
    // Nothing told a first-time user that a built cluster needs a DNS record: it was only
    // behind the cluster pane's "Public names (DNS)…". Home, the card and the cluster's
    // page each offer it now.
    await page.waitForFunction(() =>
      (document.querySelector('#home-needs')?.textContent ?? '').includes(
        'support (Amazon EKS) needs a DNS record',
      ),
    );
    const flow = page.locator('#cluster-build[open]');
    const close = flow.locator('#cluster-build-menu').getByRole('button', { name: 'Close' });
    await page
      .locator('#home-needs .drow', { hasText: 'needs a DNS record' })
      .getByRole('button', { name: 'Set up DNS' })
      .click();
    await flow.waitFor({ state: 'visible' });
    expect(await flow.innerText()).toContain('*.rc.example.com');
    await close.click();
    await openClusterLedger(page);
    await page
      .locator(`#cl-eks .place[data-place="eks:${CLUSTER_SUPPORT}"]`)
      .getByRole('button', { name: 'Set up DNS' })
      .click();
    await flow.waitFor({ state: 'visible' });
    await close.click();
    await openPlaceView(page, `eks:${CLUSTER_SUPPORT}`, 'support');
    await page.locator('#detail').getByRole('button', { name: 'Set up DNS' }).click();
    await flow.waitFor({ state: 'visible' });
    return;
  }

  if (name === 'the dns dialog lays the record out and tells a proxied record from a missing one') {
    // One line, "*.zone CNAME target", left three things to guess, and all three went wrong
    // on a real Cloudflare zone: its Name field wants only the part before the domain, its
    // proxy must be off, and houston-probe is a test name rather than a record to make.
    await openClusterLedger(page);
    await openPlaceView(page, `eks:${CLUSTER_SUPPORT}`, 'support');
    await page
      .locator('#actpane')
      .getByRole('button', { name: /Public names/u })
      .click();
    const flow = page.locator('#cluster-build[open]');
    await flow.waitFor({ state: 'visible' });
    const text = await flow.innerText();
    for (const want of [
      'CNAME',
      '*.rc.example.com',
      'DNS only',
      'grey cloud',
      'houston-probe.rc.example.com',
      'a name you do not create',
    ])
      expect(text).toContain(want);
    expect(text).toMatch(/if your domain is example\.com, type\s+\*\.rc/u);
    const check = flow.getByRole('button', { name: /Check DNS/u });
    await check.click();
    await page.waitForFunction(() =>
      (document.querySelector('#cluster-build-dns')?.textContent ?? '').includes('proxied'),
    );
    expect(await page.locator('#cluster-build-dns').innerText()).toContain('104.21.71.43');
    expect(await page.locator('#cluster-build-dns').innerText()).toContain('make it a CNAME');
    mockResolveAddresses.mockResolvedValue([]);
    await check.click();
    await page.waitForFunction(() =>
      (document.querySelector('#cluster-build-dns')?.textContent ?? '').includes(
        'does not answer yet',
      ),
    );
    expect(await page.locator('#cluster-build-dns').innerText()).toContain('*.rc at Cloudflare');
    return;
  }

  if (name === 'create on a cluster with a dns zone asks for an email, not a domain') {
    // The server names a workspace there <name>.<zone> and serves it with Let's Encrypt.
    // The dialog offered "Off" -- which then failed for want of an email nobody asked for
    // -- and refused Let's Encrypt without the domain the server fills in itself.
    await openClusterCreate(page);
    await page.waitForFunction(
      (key) =>
        (
          document.querySelector(`#dest-cards label[data-dest="${key}"]`)?.textContent ?? ''
        ).includes('~$'),
      `eks:${CLUSTER_SUPPORT}`,
    );
    await pickPlace(page, `eks:${CLUSTER_SUPPORT}`);
    await createDetails(page);
    const modes = await page
      .locator('#https-mode option')
      .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    expect(modes).not.toContain('');
    expect(await page.locator('#https-mode').inputValue()).toBe('acme');
    expect(
      await page.locator('#create-form input[name=domain]').getAttribute('placeholder'),
    ).toContain('<name>.rc.example.com');
    const note = await page.locator('#cluster-note').innerText();
    expect(note).toContain("goes through the cluster's load balancer");
    expect(note).not.toContain('adds a load balancer');
    await page.locator('#create-form input[name=version]').fill('8.5.1');
    await page.locator('#create-form input[name=acme_email]').fill('me@example.com');
    await page.locator('#create-submit').click();
    for (let n = 0; n < 40 && mockCreateRepro.mock.calls.length === 0; n += 1)
      await page.waitForTimeout(100);
    const request = mockCreateRepro.mock.calls[0]?.[0];
    expect(request?.context).toBe(CLUSTER_SUPPORT);
    expect(request?.domain ?? '').toBe('');
    expect(request?.acmeEmail).toBe('me@example.com');
    // Let the create's job stream finish before the dialog goes: closing it mid-stream
    // aborts the request, which the suite counts as a failure.
    await page.waitForFunction(() =>
      /is ready|could not be created/u.test(
        document.querySelector('#create-progress-title')?.textContent ?? '',
      ),
    );
    // Back on Docker, Off is back AND chosen: removing the selected option had left Let's
    // Encrypt selected, and every later Docker create asked for a domain.
    await page
      .locator('#create-dialog')
      .evaluate((dialog) => (dialog as HTMLDialogElement).close());
    await openClusterCreate(page);
    await pickPlace(page, `eks:${CLUSTER_SUPPORT}`);
    await createDetails(page);
    expect(await page.locator('#https-mode').inputValue()).toBe('acme');
    await createWhere(page);
    await pickPlace(page, 'docker');
    await createDetails(page);
    expect(await page.locator('#https-mode').inputValue()).toBe('');
    // A cluster this box did not build: the server will not name the workspace, so the
    // dialog does not say it will, and Off stays.
    useClusterContexts(
      [clusterContext(CLUSTER_SUPPORT), clusterContext(CLUSTER_PERF, { is_default: false })],
      CLUSTER_SUPPORT,
    );
    await page
      .locator('#create-dialog')
      .evaluate((dialog) => (dialog as HTMLDialogElement).close());
    await openClusterCreate(page);
    await pickPlace(page, `eks:${CLUSTER_SUPPORT}`);
    await createDetails(page);
    expect(await page.locator('#https-mode').inputValue()).toBe('');
    expect(await page.locator('#cluster-note').innerText()).toContain('port-forward');
    return;
  }

  if (name === 'opening a workspace shows its header before its own read answers') {
    // The panel waited for the workspace's own read and showed only "Loading…" -- on a
    // slow EKS cluster for a minute. What the list already knows is drawn at once.
    await page.locator('.wrow').first().click();
    await page.locator('#detail .d-head .name').waitFor({ state: 'visible' });
    expect(await page.locator('#detail .d-head .name').innerText()).toBe('t1234');
    expect(await page.locator('#detail-reading').innerText()).toContain(
      'Reading t1234 from its cluster',
    );
    expect(await page.locator('#detail .d-sub').innerText()).toContain('EKS');
    releaseDetail?.();
    await page.locator('#detail .tabs').waitFor({ state: 'visible' });
    expect(await page.locator('#detail-reading').count()).toBe(0);
    return;
  }

  if (name === 'the workspace list is read one at a time') {
    // The 4 s refresh asked again whether or not the last read had answered. Chromium holds
    // a second GET of the same URL until the first is done, so the server saw one at a
    // time while the page's queue grew without end -- eight open at once, measured against
    // a slow cluster. Counted where they pile up: the requests the page has open. Each read
    // after the first takes 4.5 s here.
    let open = 0;
    let most = 0;
    const list = (request: { url: () => string }): boolean =>
      new URL(request.url()).pathname === '/api/repros';
    page.on('request', (request) => {
      if (!list(request)) return;
      open += 1;
      most = Math.max(most, open);
    });
    const finished = (request: { url: () => string }): void => {
      if (list(request)) open -= 1;
    };
    page.on('requestfinished', finished);
    page.on('requestfailed', finished);
    await page.waitForTimeout(9500);
    expect(listReads.calls).toBeGreaterThanOrEqual(2);
    expect(most).toBe(1);
    return;
  }

  if (name === 'refresh reads the page on screen again') {
    // Refresh re-read only the list and the engines, which the four-second poll reads
    // anyway, so on Home and Clusters it changed nothing you could see. It reads the page
    // on screen now, and the AWS side past the server's ten-minute cache.
    await page.locator('#detail .pv.home').waitFor({ state: 'visible' });
    const refresh = page.locator('#btn-refresh');
    const memory = mockCapacity.mock.calls.length;
    await refresh.click();
    for (let n = 0; n < 40 && mockCapacity.mock.calls.length === memory; n += 1)
      await page.waitForTimeout(100);
    expect(mockCapacity.mock.calls.length).toBeGreaterThan(memory);
    await openClusterLedger(page);
    const asked = mockOverview.mock.calls.length;
    const fresh = (): boolean =>
      mockOverview.mock.calls.slice(asked).some(([, options]) => options?.reuse === false);
    await refresh.click();
    for (let n = 0; n < 40 && !fresh(); n += 1) await page.waitForTimeout(100);
    expect(fresh()).toBe(true);
    await page.waitForFunction(() => {
      const button = document.querySelector<HTMLButtonElement>('#btn-refresh');
      return button !== null && !button.disabled && button.textContent === 'Refresh';
    });
    expect(await page.locator(`#cl-eks .place[data-place="eks:${CLUSTER_SUPPORT}"]`).count()).toBe(
      1,
    );
    return;
  }

  if (name === 'the create dialog never names a cluster the server will not use') {
    // The box default is a remote cluster the GUI does not list. An empty context goes to
    // it, so the dialog must not offer one as "a local cluster" -- or call it free.
    await openClusterCreate(page);
    expect(await page.locator('#dest-cards label[data-dest="k8s-new"]').count()).toBe(0);
    const kube = page.locator('#dest-cards label[data-dest="k8s-none"]');
    expect(await kube.locator('input').isDisabled()).toBe(true);
    expect(await kube.innerText()).toContain('default cluster is set elsewhere');
    expect(await page.locator('#dest-cards').innerText()).toContain('--context');
    expect(await page.locator('#dest-cards').innerText()).not.toContain('remote-k3s');
    return;
  }

  if (
    name === 'the create form says what a managed cluster commits you to' ||
    name === 'the local certificate option goes when the cluster is not on this machine' ||
    name === 'the cluster picker shows a name not sixty characters of arn' ||
    name === 'step one quotes this machines memory only for places on it'
  ) {
    await openClusterCreate(page);
  } else {
    await openClusterLedger(page);
  }

  if (name === 'the dns step shows the record to add and says whether it answers') {
    // The DNS answer comes from the server, so nobody needs dig, and it says both answers.
    expect(
      await page.locator(`#cl-eks .place[data-place="eks:${CLUSTER_SUPPORT}"]`).innerText(),
    ).toContain('do not answer yet');
    await openPlaceView(page, `eks:${CLUSTER_SUPPORT}`, 'support');
    await page
      .locator('#actpane')
      .getByRole('button', { name: /Public names/u })
      .click();
    const flow = page.locator('#cluster-build[open]');
    await flow.waitFor({ state: 'visible' });
    expect(await flow.innerText()).toContain('a1b2c3-123.us-east-1.elb.amazonaws.com');
    expect(await flow.innerText()).toContain('*.rc.example.com');
    await flow.getByRole('button', { name: /Check DNS/u }).click();
    await page.waitForFunction(() =>
      document.querySelector('#cluster-build-dns')?.textContent.includes('does not answer yet'),
    );
    mockResolveDns.mockResolvedValue(['a1b2c3-123.us-east-1.elb.amazonaws.com.']);
    await flow.getByRole('button', { name: /Check DNS/u }).click();
    await page.waitForFunction(() =>
      document.querySelector('#cluster-build-dns')?.textContent.includes('answers'),
    );
    expect(await page.locator('#cluster-build-dns').innerText()).not.toContain('does not');
    return;
  }

  if (name === 'the clusters view never shows a zero it did not read') {
    const support = page.locator(`#cl-eks .place[data-place="eks:${CLUSTER_SUPPORT}"]`);
    const perf = page.locator(`#cl-eks .place[data-place="eks:${CLUSTER_PERF}"]`);
    const good = await support.innerText();
    expect(good).toContain('2 × t3.large');
    expect(good).toContain('~$8.46');
    // perf refused these credentials: no rate and no count, and the reason, in amber.
    const bad = await perf.innerText();
    expect(bad).toContain('Refusing');
    expect(bad).not.toMatch(/~\$|workspace/u);
    expect(bad).toContain('refused these credentials');
    await openPlaceView(page, `eks:${CLUSTER_PERF}`, 'perf');
    const detail = await page.locator('#detail').innerText();
    expect(detail).toContain('create-access-entry');
    expect(detail.toLowerCase()).toContain('unknown, not zero');
    expect(detail).toContain('could not be read');
    // A billing cluster whose rate could not be read is never "free"; a date that has passed
    // wants you (amber), it is not about to destroy anything (red).
    mockClusterStatus.mockImplementation(async (context) => {
      const status = fakeClusterStatus(context);
      return context === CLUSTER_SUPPORT
        ? { ...status, cost: null, instance_types: null, expires_in_days: -2 }
        : status;
    });
    await page.locator('#btn-clusters').click();
    await page.waitForFunction(
      (key) =>
        (document.querySelector(`#cl-eks .place[data-place="${key}"]`)?.textContent ?? '').includes(
          '2 days ago',
        ),
      `eks:${CLUSTER_SUPPORT}`,
    );
    const late = page.locator(`#cl-eks .place[data-place="eks:${CLUSTER_SUPPORT}"]`);
    expect(await late.innerText()).not.toContain('free');
    expect(await late.locator('.warnline').count()).toBe(1);
    expect(await late.locator('.bad, .danger').count()).toBe(0);
    return;
  }

  if (name === 'the clusters page is about eks with this machine on one card') {
    // The stepper, the Next card, the totals strip and the table drew one cluster five
    // times. This machine is one card of rows; Amazon EKS is a card per cluster.
    expect(await page.locator('#cl-local .mrow').count()).toBe(2);
    expect(await page.locator('#cl-eks .place').count()).toBe(2);
    expect(await page.locator('#cl-stepper, #cl-next, #cl-totals, .clrow').count()).toBe(0);
    expect((await page.locator('.panes').getAttribute('class')) ?? '').toContain('no-detail');
    const aws = await page.locator('#cl-aws').innerText();
    expect(aws).toContain('Costs money'.toUpperCase());
    expect(aws).toContain('Signed in to AWS on the server as alice');
    expect(aws).toContain('2 clusters');
    return;
  }

  if (name === 'a cluster on this machine is listed apart, free, and out of the aws totals') {
    // A k3s on this machine sat in the EKS table with "?" for its cost and its builder.
    const local = page.locator('#cl-local');
    const here = await local.innerText();
    expect(here).toContain('This server'.toUpperCase());
    expect(here).toContain('Free'.toUpperCase());
    expect(await page.locator('#cl-local .mrow[data-place="k8s:default"]').innerText()).toContain(
      'Running',
    );
    expect(await page.locator('#detail').innerText()).not.toContain('lab');
    const aws = await page.locator('#cl-eks').innerText();
    expect(aws).toContain('support');
    expect(aws).not.toContain('default');
    // One AWS cluster: its own card says its cost; there is no total to repeat it.
    expect(await page.locator('#cl-aws').innerText()).not.toContain('together');
    // Contexts named and none current is not "not set up".
    await page.waitForFunction(() =>
      (document.querySelector('#sb-engines')?.textContent ?? '').includes('no current context'),
    );
    await page.locator('#btn-home').click();
    await page.locator('#detail .pv.home').waitFor({ state: 'visible' });
    expect(await page.locator('#detail').innerText()).not.toContain('lab');
    return;
  }

  if (name === 'opening a local cluster reads its facts and offers nothing for aws') {
    // The overview only glanced at it; opening it reads the rest, and says what is there
    // rather than ticking a checklist houston did not set up.
    await openPlaceView(page, 'k8s:default', 'Kubernetes');
    await page.waitForFunction(() =>
      (document.querySelector('#detail')?.textContent ?? '').includes('local-path'),
    );
    const said = await page.locator('#detail').innerText();
    expect(said).toContain('storage class local-path');
    expect(said).toContain('ingress traefik');
    expect(said).not.toContain('✓');
    expect(said).toContain('Free: it runs on this server');
    expect(said).not.toContain('LoadBalancer');
    const pane = await page.locator('#actpane').innerText();
    expect(pane).toContain('Create a workspace here');
    expect(pane).toContain('Copy context name');
    for (const awsOnly of [
      'Public names',
      'Prepare again',
      'Copy kubeconfig command',
      'Delete cluster',
    ])
      expect(pane).not.toContain(awsOnly);
    return;
  }

  if (name === 'clicking a cluster card opens its own view and its actions') {
    await openPlaceView(page, `eks:${CLUSTER_SUPPORT}`, 'support');
    // innerText reads through the pane heading's text-transform, hence the lowercase.
    expect((await page.locator('#actpane h4').innerText()).toLowerCase()).toBe('support');
    expect(await page.locator('#detail .crumb').innerText()).toContain('support');
    await page.locator('#detail .crumb').getByRole('button', { name: 'Clusters' }).click();
    await openPlaceView(page, `eks:${CLUSTER_PERF}`, 'perf');
    expect((await page.locator('#actpane h4').innerText()).toLowerCase()).toBe('perf');
    return;
  }

  if (name === 'a build in progress is a card with its elapsed time') {
    // The job list arrives with the overview, after the cheap list has drawn the cards.
    const card = page.locator('#cl-eks .place[data-job="j-build"]');
    await card.waitFor({ state: 'visible' });
    const text = await card.innerText();
    expect(text).toContain('perf2');
    expect(text).toMatch(/Building · 1[0-9] min/u);
    expect(await page.locator('#cluster-badge').innerText()).toContain('EKS · building');
    return;
  }

  if (name === 'only an admin is offered the controls that spend or destroy') {
    expect(
      await page
        .locator('#cl-aws')
        .getByRole('button', { name: /Add a cluster/u })
        .count(),
    ).toBe(0);
    await openPlaceView(page, `eks:${CLUSTER_SUPPORT}`, 'support');
    expect(await page.locator('#detail').innerText()).toContain('~$0.35 an hour');
    const pane = await page.locator('#actpane').innerText();
    expect(pane).not.toContain('Delete cluster');
    expect(pane).not.toContain('Create a workspace here');
    expect(pane).toContain('admin action');
    expect(pane).toContain('readonly');
    return;
  }

  if (name === 'a member is offered no prepare or forget on a shared cluster') {
    // A cluster is everybody's, and a member changes only their own workspaces: the server
    // refuses a member's prepare and forget, so the pane does not offer them.
    await openPlaceView(page, `eks:${CLUSTER_SUPPORT}`, 'support');
    const pane = await page.locator('#actpane').innerText();
    expect(pane).toContain('Copy kubeconfig command');
    expect(pane).not.toContain('Prepare again');
    expect(pane).toContain('admin action');
    // Forget is offered for a cluster that does not answer -- perf here -- and to an admin only.
    await page.locator('#detail .crumb').getByRole('button', { name: 'Clusters' }).click();
    await openPlaceView(page, `eks:${CLUSTER_PERF}`, 'perf');
    const unreachable = await page.locator('#actpane').innerText();
    expect(unreachable).toContain('Copy context name');
    expect(unreachable).not.toContain('Forget this cluster');
    return;
  }

  if (name === 'a cluster delete says in its job what aws still holds') {
    // "Done" is not "nothing is billing": the delete's own result names what AWS still
    // holds and the command that removes each, in the job a person is watching.
    await openPlaceView(page, `eks:${CLUSTER_SUPPORT}`, 'support');
    await page
      .locator('#actpane')
      .getByRole('button', { name: /Delete cluster/u })
      .click();
    await page.locator('#cluster-delete-dialog[open]').waitFor({ state: 'visible' });
    // What force skips is said where it is offered: only the look inside, never the checks
    // that this is houston's own cluster in this account.
    const force = (await page.locator('#cluster-delete-force-hint').innerText()).replace(
      /\s+/gu,
      ' ',
    );
    expect(force).toContain('Force skips only that look inside');
    expect(force).toContain('houston deletes only a cluster it built');
    await page.locator('#cluster-delete-form input[name=confirm]').fill('support');
    await page.locator('#cluster-delete-form input[name=force]').check();
    await page.locator('#cluster-delete-go').click();
    await page.waitForFunction(() =>
      document.querySelector('#job-log')?.textContent.includes('left behind'),
    );
    const log = (await page.locator('#job-log').textContent()) ?? '';
    expect(log).toContain('left behind in us-east-1');
    expect(log).toContain('vol-0abc');
    expect(log).toContain('aws ec2 delete-volume --region us-east-1 --volume-id vol-0abc');
    expect(log).toContain('stack');
    expect(log).toContain('AccessDenied');
    // A candidate nothing ties to this cluster is shown to check, never with a command.
    expect(log).toContain('vol-9zz');
    expect(log).toContain('check before deleting');
    expect(log).not.toContain('--volume-id vol-9zz');
    return;
  }

  if (name === 'the delete dialog will not arm until the name is typed') {
    expect(
      await page
        .locator('#cl-aws')
        .getByRole('button', { name: /Add a cluster/u })
        .count(),
    ).toBe(1);
    await openPlaceView(page, `eks:${CLUSTER_SUPPORT}`, 'support');
    expect(await page.locator('#actpane').innerText()).toContain('Delete cluster');
    await page
      .locator('#actpane')
      .getByRole('button', { name: /Delete cluster/u })
      .click();
    await page.locator('#cluster-delete-dialog[open]').waitFor({ state: 'visible' });
    const go = page.locator('#cluster-delete-go');
    expect(await go.isDisabled()).toBe(true);
    // The delete releases the load balancers itself; it never sends you to a bare kubectl.
    const said = await page.locator('#cluster-delete-dialog').innerText();
    expect(said).not.toContain('kubectl delete svc');
    expect(said).toContain('releases its load balancers');
    expect(await page.locator('#cluster-delete-holds').innerText()).toContain(
      'holding 1 workspace(s)',
    );
    const confirm = page.locator('#cluster-delete-form input[name=confirm]');
    await confirm.fill('wrong');
    expect(await go.isDisabled()).toBe(true);
    await confirm.fill('support');
    expect(await go.isDisabled()).toBe(false);
    // AND THE REGION GOES WITH IT, or the server looks in the CLI's default region.
    mockDeleteCluster.mockResolvedValue(true);
    await go.click();
    for (let n = 0; n < 40 && mockDeleteCluster.mock.calls.length === 0; n += 1)
      await page.waitForTimeout(100);
    expect(mockDeleteCluster).toHaveBeenCalledWith(
      'support',
      expect.objectContaining({ region: 'us-east-1', force: false }),
    );
    return;
  }

  if (name === 'the cluster action pane survives the four second poll') {
    await openPlaceView(page, `eks:${CLUSTER_SUPPORT}`, 'support');
    expect(
      await page
        .locator('#actpane')
        .getByText('Create a workspace here', { exact: true })
        .isVisible(),
    ).toBe(true);
    await page.waitForTimeout(5200);
    expect((await page.locator('.panes').getAttribute('class')) ?? '').not.toContain('no-detail');
    expect(
      await page
        .locator('#actpane')
        .getByText('Create a workspace here', { exact: true })
        .isVisible(),
    ).toBe(true);
    expect(await page.locator('#detail .dhead h1').innerText()).toBe('support');
    return;
  }

  if (name === 'the create form says what a managed cluster commits you to') {
    expect(await page.locator('#dest-note').isHidden()).toBe(true);
    await pickPlace(page, `eks:${CLUSTER_SUPPORT}`);
    const money = await page.locator('#dest-note').innerText();
    expect(money).toContain('support');
    expect(money).toContain('shared');
    expect(money).toContain("doesn't stop the charge");
    await createDetails(page);
    // How it is reached, where that is decided -- and outside the collapsible.
    const access = await page.locator('#cluster-note').innerText();
    expect(access).toContain('port-forward');
    expect(access).toContain('EBS volume');
    expect(await page.locator('#create-https-block').isVisible()).toBe(true);
    expect(
      await page
        .locator('#create-https-block')
        .evaluate((node) => node.closest('details') === null),
    ).toBe(true);
    await page.locator('#cluster-note').getByRole('button', { name: 'Set a domain' }).click();
    expect(await page.locator('#https-mode').inputValue()).toBe('acme');
    expect(
      await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name),
    ).toBe('domain');
    await page.locator('#create-form [name=domain]').fill('t1.rc.example.com');
    await page.waitForTimeout(300);
    expect(await page.locator('#cluster-note').innerText()).not.toContain('port-forward');
    await createWhere(page);
    await pickPlace(page, 'k8s:kind-houston-local');
    expect(await page.locator('#dest-note').isHidden()).toBe(true);
    await createDetails(page);
    expect(await page.locator('#cluster-note').isHidden()).toBe(true);
    return;
  }

  if (name === 'step one quotes this machines memory only for places on it') {
    // "Room for about 4 more" is this machine's; next to a cluster in AWS it is false.
    await page.waitForFunction(() =>
      (document.querySelector('#dest-cards label[data-dest="docker"]')?.textContent ?? '').includes(
        'room for',
      ),
    );
    expect(await page.locator('#dest-cards label[data-dest="docker"]').innerText()).toContain(
      'room for 4 more',
    );
    expect(
      await page.locator('#dest-cards label[data-dest="k8s:kind-houston-local"]').innerText(),
    ).toContain('room for 1 more');
    expect(
      await page.locator(`#dest-cards label[data-dest="eks:${CLUSTER_SUPPORT}"]`).innerText(),
    ).not.toContain('room for');
    return;
  }

  if (name === 'the clusters view speaks english and explains its own numbers') {
    expect(await page.locator('#detail').innerText()).not.toContain('`');
    await openPlaceView(page, `eks:${CLUSTER_SUPPORT}`, 'support');
    const body = await page.locator('#detail').innerText();
    expect(body).not.toContain('`');
    expect(body).toContain('Traffic and storage are extra');
    expect(body).toContain('reminder date');
    expect(body).toContain('nothing deletes on it');
    expect(await page.locator('#actpane').innerText()).toContain('Copy kubeconfig command');
    return;
  }

  if (name === 'a cluster aws says is gone does not read as one that is down') {
    const card = await page.locator(`#cl-eks .place[data-place="eks:${CLUSTER_PERF}"]`).innerText();
    expect(card).toContain('Gone in AWS');
    expect(card).not.toContain('Not answering');
    await openPlaceView(page, `eks:${CLUSTER_PERF}`, 'perf');
    const detail = await page.locator('#detail').innerText();
    expect(detail).toContain('no longer exists');
    expect(detail).not.toContain('not answering');
    expect(detail.toLowerCase()).not.toContain('unknown, not zero');
    return;
  }

  if (name === 'a gone cluster offers only controls that can work') {
    const buttons = async (): Promise<string[]> =>
      await page.locator('#actpane button').allInnerTexts();
    await openPlaceView(page, `eks:${CLUSTER_SUPPORT}`, 'support');
    const live = await buttons();
    expect(live.some((label) => label.startsWith('Prepare'))).toBe(true);
    expect(live.some((label) => label.includes('Delete'))).toBe(true);
    await page.locator('#detail .crumb').getByRole('button', { name: 'Clusters' }).click();
    await openPlaceView(page, `eks:${CLUSTER_PERF}`, 'perf');
    const dead = await buttons();
    expect(dead.some((label) => label.startsWith('Prepare'))).toBe(false);
    expect(dead.some((label) => label.includes('Delete'))).toBe(false);
    expect(dead.some((label) => label.includes('Create'))).toBe(false);
    expect(dead.some((label) => label.includes('Forget'))).toBe(true);
    const forget = page.locator('#actpane').getByRole('button', { name: /Forget/u });
    expect((await forget.getAttribute('class')) ?? '').not.toContain('danger');
    return;
  }

  if (name === 'the local certificate option goes when the cluster is not on this machine') {
    const modes = async (): Promise<string[]> =>
      await page
        .locator('#https-mode option')
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value));
    await createDetails(page);
    expect(await modes()).toContain('local');
    await createWhere(page);
    await pickPlace(page, `eks:${CLUSTER_SUPPORT}`);
    await createDetails(page);
    expect(await modes()).not.toContain('local');
    expect(await modes()).toContain('acme');
    await createWhere(page);
    await pickPlace(page, 'k8s:kind-houston-local');
    await createDetails(page);
    expect(await modes()).toContain('local');
    await page.locator('#https-mode').selectOption('local');
    await createWhere(page);
    await pickPlace(page, `eks:${CLUSTER_SUPPORT}`);
    await createDetails(page);
    expect(await page.locator('#https-mode').inputValue()).not.toBe('local');
    return;
  }

  if (name === 'the cluster picker shows a name not sixty characters of arn') {
    const arn = 'arn:aws:eks:us-east-1:533674205877:cluster/chatrepo';
    const card = await page.locator(`#dest-cards label[data-dest="eks:${arn}"]`).innerText();
    expect(card).toContain('chatrepo');
    expect(card).toContain('us-east-1');
    expect(card).not.toContain(arn);
    expect(card).not.toContain('533674205877');
    // The VALUE sent is the full context; only what a person reads is short.
    const option = await page.locator(`#context-select option[value="${arn}"]`).textContent();
    expect(option).toContain('chatrepo');
    expect(option).not.toContain('533674205877');
    expect((option ?? '').length).toBeLessThan(60);
  }
}

async function waitForGui(page: Page): Promise<void> {
  await page.locator('.wrow').waitFor({ state: 'visible' });
  expect(await page.locator('#sb-count').textContent()).not.toBe('—');
}

const PASSWORD = 'browser-password-123';

async function signIn(page: Page, user = 'alice', password = PASSWORD): Promise<void> {
  await page.goto('/signin');
  await page.locator('#u').fill(user);
  await page.locator('#p').fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname === '/'),
    page.locator('button').click(),
  ]);
}

async function exerciseFlow(name: string, page: Page, firstRunKey: string): Promise<void> {
  if (name === 'a signed out browser lands on the sign in page') {
    // The sign-in page has no script; with no theme cookie it is light, on a dark desktop too.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/');
    await page.waitForURL((url) => url.pathname === '/signin');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      'rgb(228, 231, 236)',
    );
    expect(await page.locator('#u').isVisible()).toBe(true);
    expect(await page.locator('#p').isVisible()).toBe(true);
    expect(await page.title()).toContain('houston');
    return;
  }
  if (name === 'a wrong password shows an error in the page') {
    await page.goto('/signin');
    await page.locator('#u').fill('alice');
    await page.locator('#p').fill('not-the-password');
    await page.locator('button').click();
    await page.locator('.signin-banner.bad').waitFor({ state: 'visible' });
    expect(await page.locator('.signin-banner.bad').textContent()).toContain('not right');
    // READABLE ON WHITE. Light became the default and the page kept its dark-ground
    // colours: a pale pink error, a grey foot and a tinted button, all close to invisible.
    const ratios = await contrastRatios(page, [
      '.signin-form label[for=u]',
      '.signin-banner.bad',
      '.signin-form button',
      '.signin-foot',
      '.signin-foot code',
    ]);
    expect(Object.entries(ratios).filter(([, ratio]) => ratio < 4.5)).toEqual([]);
    return;
  }
  if (name === 'first run creates the first admin in the browser') {
    await page.goto(`/setup#k=${firstRunKey}`);
    await page.locator('#u').fill('alice');
    await page.locator('#p').fill(PASSWORD);
    await page.locator('button[type=submit]').click();
    await page.locator('#whoami:not([hidden])').waitFor({ state: 'visible' });
    expect((await page.locator('#whoami').textContent())?.trim()).toBe('alice');
    expect(page.url()).not.toContain('#k=');
    expect(users.roleOf('alice')).toBe('admin');
    return;
  }
  if (name === 'the setup page says so when the key is missing') {
    await page.goto('/setup');
    await page.locator('#err:not([hidden])').waitFor({ state: 'visible' });
    expect(await page.locator('#err').textContent()).toContain('setup link');
    return;
  }

  await signIn(
    page,
    name.includes('readonly') ? 'ronly' : 'alice',
    name.includes('readonly') ? 'read-only-password' : PASSWORD,
  );
  await page.locator('#whoami:not([hidden])').waitFor({ state: 'visible' });

  if (name === 'signing in renders the dashboard') {
    expect((await page.locator('#whoami').textContent())?.trim()).toBe('alice');
    expect(await page.locator('#btn-new').isVisible()).toBe(true);
    return;
  }
  if (name === 'sign out ends the session and returns to the login') {
    await page.locator('#whoami').click();
    await page.locator('#me-menu:not([hidden])').waitFor({ state: 'visible' });
    await page.locator('#me-out').click();
    await page.waitForURL((url) => url.pathname === '/signin');
    // BACK asks the server again: the page is never stored. It showed the cached page,
    // whose modules were answered with a redirect to sign-in, so nothing ran in it.
    const back = await page.goBack();
    expect(new URL(back?.url() ?? '').pathname).toBe('/signin');
    await page.locator('#u').waitFor({ state: 'visible' });
    await page.goto('/');
    await page.waitForURL((url) => url.pathname === '/signin');
    return;
  }
  if (name === 'a readonly user is not offered what it cannot do') {
    expect((await page.locator('#whoami').textContent())?.trim()).toBe('ronly · readonly');
    expect(await page.locator('#btn-new').isHidden()).toBe(true);
    expect(await page.locator('#btn-prune').isHidden()).toBe(true);
    return;
  }
  if (name === 'an admin can open people and a member cannot') {
    await page.locator('#whoami').click();
    await page.locator('#me-people:not([hidden])').waitFor({ state: 'visible' });
    await page.locator('#me-people').click();
    await page.locator('#people-dialog[open]').waitFor({ state: 'visible' });
    await page.locator('#people-body', { hasText: 'alice' }).waitFor({ state: 'visible' });
    expect(await page.locator('#people-body').textContent()).toContain('admin');
    await page.locator('#people-close').click();
    await page.locator('#whoami').click();
    await page.locator('#me-out').click();
    await page.waitForURL((url) => url.pathname === '/signin');
    await signIn(page, 'bob', 'bobs-good-password');
    await page.locator('#whoami:not([hidden])').waitFor({ state: 'visible' });
    await page.locator('#whoami').click();
    await page.locator('#me-menu:not([hidden])').waitFor({ state: 'visible' });
    expect(await page.locator('#me-people').isHidden()).toBe(true);
    return;
  }
  if (name === 'a running job can be stopped from its output') {
    // A create waiting on a port-forward it could not see held its workspace until the
    // server was killed. From Activity, its output now offers Stop, and says how it ended.
    await page.locator('#btn-jobs').click();
    const building = page.locator('#jobs-list .jobrow', { hasText: 'building-eks' });
    await building.waitFor({ state: 'visible' });
    await building.click();
    await page.locator('#job-dialog[open]').waitFor({ state: 'visible' });
    await page.waitForTimeout(500); // the dialog asks the server whether Stop is safe
    expect(await page.locator('#job-stop').isHidden()).toBe(true);
    await page.locator('#job-close').click();
    const row = page.locator('#jobs-list .jobrow', { hasText: 'stuck-ws' });
    await row.waitFor({ state: 'visible' });
    await row.click();
    const stop = page.locator('#job-dialog[open] #job-stop');
    await stop.waitFor({ state: 'visible' });
    page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await stop.click();
    await page.waitForFunction(
      () => document.querySelector('#job-title')?.textContent === 'Stopped',
    );
    expect(await page.locator('#job-log').textContent()).toContain(
      'stopped by alice before it finished',
    );
    expect(await page.locator('#job-stop').isHidden()).toBe(true);
    expect(stuckJob?.status).toBe('error');
    buildingJob?.stopper.abort();
    return;
  }

  if (name === 'the activity page opens both of its tabs') {
    await page.locator('#btn-jobs').click();
    await page.locator('#act-tabs').waitFor({ state: 'visible' });
    await page.locator('#act-tab-history').click();
    await page.locator('#jobs-filter:not([hidden])').waitFor({ state: 'visible' });
    await page.locator('#jobs-list', { hasText: 'alice' }).waitFor({ state: 'visible' });
  }
}

async function prepareFlow(name: string): Promise<{ options: AppOptions; firstRunKey: string }> {
  if (
    name === 'first run creates the first admin in the browser' ||
    name === 'the setup page says so when the key is missing'
  ) {
    return { options: { accounts: true, firstRun: true }, firstRunKey: firstrun.mint() };
  }
  await users.add('alice', PASSWORD, 'admin');
  if (name === 'a readonly user is not offered what it cannot do') {
    await users.add('ronly', 'read-only-password', 'readonly');
  }
  if (name === 'an admin can open people and a member cannot') {
    await users.add('bob', 'bobs-good-password', 'member');
  }
  if (name === 'a running job can be stopped from its output') {
    const { sleep } = require('../../../src/seams/exec') as typeof ExecNS;
    const manager = new JobManager();
    stuckJob = manager.submit(
      'up',
      async () => {
        for (;;) await sleep(100);
      },
      { label: 'stuck-ws', actor: 'alice' },
    );
    // A kind a Stop would leave half done: its output offers no Stop at all.
    buildingJob = manager.submit(
      'cluster-create',
      async () => {
        for (;;) await sleep(100);
      },
      { label: 'building-eks', actor: 'alice' },
    );
    return { options: { accounts: true, jobs: manager }, firstRunKey: '' };
  }
  return { options: { accounts: true }, firstRunKey: '' };
}

function portedFile(file: string): boolean {
  return (
    file.startsWith('surfaces ') ||
    ['remote', 'plain http', 'clusters'].includes(file) ||
    file.startsWith('kubernetes')
  );
}

function publicOrigin(file: string, name: string): boolean {
  const remote = [
    'the panel says that localhost means the readers own machine',
    'a wide bound workspace is given the address that works from here',
    'the create dialog warns a remote reader about the default bind',
    'an https workspace read from another computer shows its public address',
    'a localhost workspace read from another computer says where its links open',
  ];
  const plain = [
    'signing in works over plain http on a real hostname',
    'a write from the spa survives plain http on a real hostname',
    'a link row shows the workspaces root url verbatim',
    'a placeholder url in a link row is left alone',
  ];
  return (
    (file === 'remote' && remote.includes(name)) || (file === 'plain http' && plain.includes(name))
  );
}

function useRows(rows: Record<string, unknown>[]): void {
  mockListRepros.mockResolvedValue(rows as never);
  mockDescribe.mockImplementation(
    async (name) => rows.find((row) => row.name === name) ?? (rows[0] as never),
  );
  mockDetail.mockImplementation(
    async (name) => rows.find((row) => row.name === name) ?? (rows[0] as never),
  );
  mockResolveName.mockImplementation(async (name) => name ?? '');
}

function kubeDetail(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return detail({
    runtime: 'kubernetes',
    deployment: 'microservices',
    namespace: 'houston-t1234',
    context: 'arn:aws:eks:us-east-1:1:cluster/support',
    cluster: 'support',
    containers: [],
    ...overrides,
  });
}

function prepareKubernetesCase(name: string): void {
  if (name === 'the footer says k8s is unknown until the probe answers') {
    // A probe that takes its time, as kubectl against a real cluster does.
    const real = mockPreflight.getMockImplementation();
    mockPreflight.mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return await (real as NonNullable<typeof real>)(...args);
    });
  }
  if (name === 'a log stream a restart ends follows the new pod by itself') {
    // The first stream ends when a restart replaces the pod; the next follows the new one.
    let streams = 0;
    mockLogProcess.mockImplementation(async (_name, options) => {
      streams += 1;
      const pod = streams === 1 ? 'rocketchat-579c867b87-mclgv' : 'rocketchat-6d8f9c7b5-x2k4q';
      options.onLine?.(
        `[pod/${pod}/rocketchat] {"level":30,"msg":"pod ${String(streams)} says hello"}`,
      );
      const signal = options.abortSignal;
      if (streams > 1 && signal !== undefined && !signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
      return { code: 0 } as never;
    });
  }
  if (
    name === 'the arrangement says what it builds' ||
    name === 'the create dialog says what it builds and what the box has left' ||
    name === 'on kubernetes the voice panel offers no phone options and sends none'
  ) {
    useClusterContexts(
      [{ ...localContext('kind-support', 'local'), ours: true, is_default: true }],
      'kind-support',
    );
    mockClusterStatus.mockImplementation(async (context) => localStatus(context));
  }
  if (name === 'the create dialog offers a runtime and follows it') {
    useClusterContexts([{ ...localContext('kind-houston-local', 'local'), ours: true }], '');
    // It answers, so its card is one to choose; one that did not would say why and refuse.
    mockClusterStatus.mockImplementation(async (context) => localStatus(context));
  }
  if (name === 'the header is the doctor button and the footer names both engines') {
    mockPreflight.mockResolvedValue({
      context: '',
      distribution: '',
      clusterReachable: false,
      nodeCount: 0,
      namespaces: [],
    } as never);
    mockToolsReady.mockReturnValue(false);
  }
  if (name === 'in progress shows only jobs that are') {
    portedJobs = {
      listJobs: () => [
        {
          id: 'j1',
          kind: 'create',
          label: 'a',
          actor: 'alice',
          status: 'running',
          started_at: 1,
          finished_at: null,
          error: '',
          error_kind: '',
        },
        {
          id: 'j2',
          kind: 'backup',
          label: 'b',
          actor: 'alice',
          status: 'queued',
          started_at: 1,
          finished_at: null,
          error: '',
          error_kind: '',
        },
        {
          id: 'j3',
          kind: 'create',
          label: 'c',
          actor: 'alice',
          status: 'done',
          started_at: 1,
          finished_at: 2,
          error: '',
          error_kind: '',
        },
        {
          id: 'j4',
          kind: 'seed',
          label: 'd',
          actor: 'alice',
          status: 'error',
          started_at: 1,
          finished_at: 2,
          error: 'x',
          error_kind: 'InternalError',
        },
      ],
      drain: async () => [],
      get: () => undefined,
    } as unknown as JobManager;
  }
  if (
    name === 'the seed job shows what it made and whether it was confirmed' ||
    name.startsWith('seed ') ||
    name === 'create sends scenario and history only with sample data enabled'
  ) {
    mockReadMeta.mockResolvedValue({
      name: 't1234',
      project: 'p',
      rcVersion: '7.4.1',
      rcImage: 'i',
      mongoTag: '7.0',
      mongoFlavor: 'official',
      preset: 'default',
      rootUrl: 'http://localhost:3001',
      hostPort: 3001,
      versionSource: 'x',
      pinned: false,
      createdAt: '',
      publicUrl: '',
      adminPassword: '',
      extra: {},
    });
    const rich = name === 'seed submits profile scenarios and history together';
    mockRunSeedInline.mockResolvedValue({
      users: 20,
      messages: rich ? 435 : 415,
      threads: 162,
      rooms_total: rich ? 29 : 25,
      dms: 5,
      rooms: { channel: 5, team: 1, discussion: 3, dm: 5 },
      ...(rich
        ? {
            files: 12,
            scenarios: ['permissions', 'room-states'],
            history: {
              days: 90,
              oldest: '2026-07-11T00:00:00.000Z',
              latest: '2026-10-09T00:00:00.000Z',
              constrained: [],
            },
            planned: {
              users: 20,
              rooms_total: 29,
              messages: 435,
              threads: 162,
              files: 12,
              thread_parents: 54,
              reaction_actions: 278,
              pins: 21,
              stars: 25,
              mentions: 25,
              edits: 6,
            },
            created: [
              {
                name: 'support',
                kind: 'channel',
                starred_by: ['alice'],
                files: ['png', 'txt', 'pdf', 'csv'],
              },
              {
                name: 'customer escalation 4821',
                kind: 'discussion',
                parent: 'support',
                starred_by: ['bob'],
                files: [],
              },
            ],
          }
        : {}),
      verification: {
        ok: name === 'seed incomplete readback never appears confirmed' ? null : true,
        faults: [],
        extra: [],
        unreadable: [],
        checked: 25,
        ...(rich
          ? {
              features: {
                files: 12,
                thread_parents: 54,
                reactions: 278,
                pins: 21,
                stars: 25,
                mentions: 25,
                edits: 6,
              },
            }
          : {}),
      },
    } as never);
  }
  if (name === 'a kubernetes card names the cluster it will use') {
    mockPreflight.mockResolvedValue({
      context: 'default',
      distribution: 'k3s',
      clusterReachable: true,
      nodeCount: 1,
      namespaces: [],
    } as never);
    mockClusterStatus.mockImplementation(async (context) =>
      context === 'default' ? localStatus() : fakeClusterStatus(context),
    );
    mockKnownContexts.mockResolvedValue({
      contexts: [
        {
          context: 'arn:aws:eks:us-east-1:1:cluster/support',
          short: '',
          region: 'us-east-1',
          ours: false,
          provider: 'eks',
          billable: true,
          is_default: true,
          aliases: [],
          made_by_houston: false,
          where: 'aws',
        },
        {
          context: 'default',
          short: 'default',
          region: '',
          ours: false,
          provider: '',
          billable: false,
          is_default: false,
          aliases: [],
          made_by_houston: false,
          where: 'local',
        },
      ],
      unreadable: '',
      default: 'arn:aws:eks:us-east-1:1:cluster/support',
    });
  }
  if (name === 'the panel leads with what is wrong and what to do')
    useRows([detail({ restarts: 4, health: 'unhealthy' })]);
  if (name === 'a down workspace is told what it still holds')
    useRows([detail({ state: 'down', health: '', uptime: '' })]);
  if (name === 'a pod that cannot start is named in the panel')
    useRows([
      kubeDetail({
        containers: [
          {
            service: 'rocketchat-0',
            state: 'pending',
            status: 'ImagePullBackOff',
            health: '',
            blocked: true,
            restarts: 0,
            started: '',
          },
          {
            service: 'mongodb-0',
            state: 'pending',
            status: 'ContainerCreating',
            health: '',
            blocked: false,
            restarts: 0,
            started: '',
          },
        ],
      }),
    ]);
  if (name === 'the narrow layout is a picker a panel and a bar')
    useRows(Array.from({ length: 6 }, (_, index) => detail({ name: `ws-${String(index)}` })));
  if (name === 'a sidecar that keeps restarting is a fault on kubernetes')
    useRows([
      kubeDetail({
        restarts: 0,
        containers: [
          {
            service: 'rocketchat-rocketchat-579c867b87-mwq4w',
            state: 'running',
            status: '1/1 ready',
            health: 'healthy',
            app: true,
            restarts: 0,
          },
          {
            service: 'rocketchat-ddp-streamer-768f896d7-rpcw9',
            state: 'running',
            status: '1/1 ready · 3 restarts',
            health: 'healthy',
            app: false,
            restarts: 3,
          },
          {
            service: 'rocketchat-presence-7ffb7dc6f7-m25vt',
            state: 'running',
            status: '1/1 ready · 1 restart',
            health: 'healthy',
            app: false,
            restarts: 1,
          },
        ],
      }),
    ]);
  if (name === 'a sidecar that is not ready and restarting is still a fault')
    useRows([
      kubeDetail({
        restarts: 0,
        containers: [
          {
            service: 'rocketchat-rocketchat-579c867b87-mwq4w',
            state: 'running',
            status: '1/1 ready',
            health: 'healthy',
            app: true,
            restarts: 0,
          },
          {
            service: 'rocketchat-ddp-streamer-768f896d7-rpcw9',
            state: 'running',
            status: 'CrashLoopBackOff · 7 restarts',
            health: '',
            app: false,
            restarts: 7,
          },
        ],
      }),
    ]);
  if (name === 'the env tab renders on kubernetes where it used to be blank')
    mockEnvCurrent.mockResolvedValue({
      name: 't1234',
      overrides: ['MY_FLAG'],
      env: [
        { key: 'ROOT_URL', value: 'http://localhost:3001', override: false },
        { key: 'MY_FLAG', value: '1', override: true },
        { key: 'MONGO_URL', value: '********', override: false },
      ],
    });
  if (name === 'the env tab still offers the controls on compose') {
    useRows([detail()]);
    mockRuntimeOf.mockResolvedValue(topology.DOCKER);
    mockEnvCurrent.mockResolvedValue({
      name: 't1234',
      overrides: [],
      env: [{ key: 'ROOT_URL', value: 'http://localhost:3001', override: false }],
    });
  }
  if (name === 'the env tab shows the refusal rather than an empty table') {
    useRows([kubeDetail({ state: 'stopped' })]);
    mockEnvCurrent.mockRejectedValue(
      new NotReadyError(
        "no Rocket.Chat pod in houston-t1234 to read the environment from — is 't1234' running?",
      ),
    );
  }
  if (name === 'the containers tab shows pods and says so on kubernetes')
    useRows([
      kubeDetail({
        containers: [
          {
            service: 'rocketchat-rocketchat-6d9-abc',
            state: 'running',
            status: '1/1 ready',
            health: 'healthy',
          },
          {
            service: 'rocketchat-mongodb-0',
            state: 'pending',
            status: 'ImagePullBackOff',
            health: '',
          },
        ],
      }),
    ]);
  if (name === 'the live chart stops asking when the answer is a refusal')
    mockPodMetrics.mockRejectedValue(
      new PreflightError(
        'this cluster has no metrics-server, so there is nothing to read CPU and memory from. Install it with:\n  kubectl apply -f https://example/x.yaml',
      ),
    );
  if (
    [
      'presets are ticked from a list and sent with each ones settings',
      'voice with the phone system combines with email as the cli does',
      'the voice panel opens each phone option once the one it needs is on',
      'on kubernetes the voice panel offers no phone options and sends none',
      'the e2ee options send the policy and switches as its settings',
      'ldap asks for a one time code only with its own single sign on',
      'a pasted license is masked and sent',
    ].includes(name)
  )
    mockCreateRepro.mockResolvedValue({} as never);
  if (name === 'a ci build names its base release') {
    // The build's package.json, which the server reads before a CI create.
    mockReleaseInfo.mockImplementation(async (url: string) =>
      url.endsWith('/apps/meteor/package.json')
        ? ({ status: 200, ok: true, json: () => ({ version: '9.0.0-develop' }) } as never)
        : null,
    );
  }
  if (name === 'the workspace panel shows its presets its build and its license')
    useRows([
      detail({
        preset: 'email+ldap',
        presets: ['email', 'ldap'],
        ci_build: 'pr-41234',
        licensed: true,
        notes: [...presets.load('ldap').notes],
      }),
    ]);
  if (name === 'a credential note is not labelled a sudo setup step')
    useRows([detail({ state: 'stopped', preset: 'ldap', notes: [...presets.load('ldap').notes] })]);
  if (name === 'the one preset with a real setup step keeps it')
    useRows([detail({ state: 'stopped', preset: 'oidc', notes: [...presets.load('oidc').notes] })]);
  if (name === 'a note that ends in a name is not glued to the next one')
    useRows([
      detail({
        state: 'stopped',
        notes: [
          'monolith on kind-houston-local — about 5 pods, namespace houston-x',
          'MongoDB 8.0 as a plain StatefulSet — mongo:8.0, NO authentication.',
          'reachable on this box at http://localhost:3000',
        ],
      }),
    ]);
  if (name === 'a genuinely wrapped note still joins the line after it')
    useRows([detail({ state: 'stopped', preset: 'oidc', notes: [...presets.load('oidc').notes] })]);
  if (name === 'a long line in a note scrolls instead of being clipped away')
    useRows([
      detail({
        state: 'stopped',
        notes: [
          'houston keeps its own kubeconfig; a bare kubectl will not see this:',
          '    export KUBECONFIG=/tmp/runner-of-someone/a-very-long-isolated-home-0/clients/kubernetes/config',
        ],
      }),
    ]);
  if (name === 'a grouped note gets its own card with a fact table and a copy button')
    useRows([
      kubeDetail({
        notes: ['Kubernetes:', '    Cluster  x'],
        note_groups: [
          {
            title: 'Kubernetes',
            rows: [
              ['Cluster', 'kind-houston-local'],
              ['Namespace', 'houston-t1234'],
              ['Arrangement', 'microservices'],
            ],
            body: [],
            commands: [],
          },
          {
            title: 'Port forward',
            rows: [],
            body: ['The port-forward dies with the pod. Start it again:'],
            commands: ['kubectl -n houston-t1234 port-forward deployment/rc 3001:3000'],
          },
        ],
      }),
    ]);
  if (name === 'the panel is not a two hundred pixel window on a narrow screen')
    useRows([
      kubeDetail({
        note_groups: Array.from({ length: 8 }, (_, index) => ({
          title: `Group ${String(index)}`,
          kind: '',
          rows: [],
          body: [`Something worth reading, number ${String(index)}.`],
          commands: [],
        })),
      }),
    ]);
  if (name === 'a place a group names is the link row and not a second row')
    useRows([
      kubeDetail({
        notes: [],
        links: [
          { label: 'Rocket.Chat', url: 'http://localhost:3001', kind: 'rc' },
          { label: 'Grafana', url: 'http://localhost:5050', kind: 'monitor' },
        ],
        note_groups: [
          {
            title: 'Monitoring',
            rows: [],
            body: [
              'Grafana:    http://localhost:5050  (admin/admin; anonymous view enabled)',
              'Dashboards auto-provisioned: Rocket.Chat Metrics, MongoDB.',
            ],
            commands: [],
          },
        ],
      }),
    ]);
  if (name === 'the rail groups by what each workspace wants from you')
    useRows([
      detail({ name: 'aa-loop', state: 'restarting', restarts: 4 }),
      detail({ name: 'bb-sick', health: 'unhealthy' }),
      detail({ name: 'cc-fine' }),
      detail({ name: 'dd-stopped', state: 'stopped', uptime: '', health: '' }),
      detail({ name: 'ee-down', state: 'down', uptime: '', health: '' }),
    ]);
  if (name === 'one state gets no group headings')
    useRows(Array.from({ length: 3 }, (_, index) => detail({ name: `ws-${String(index)}` })));
  if (name === 'a long workspace name does not push the rail sideways')
    useRows([
      detail({ name: 'a-really-long-workspace-name-for-ticket-4821', preset: 'ldap' }),
      detail({ name: 'dana-upgrade', uptime: '4 minutes', monitoring: true }),
    ]);
  if (name === 'a seeded workspace is not told to seed itself')
    useRows([detail({ seed: { profile: 'standard', at: '2026-08-19T09:00:00+00:00', ok: true } })]);
  if (name === 'nothing is suggested for a workspace that is not running')
    useRows([detail({ state: 'down', uptime: '', health: '' })]);
  if (name === 'a note paragraph is as wide as the card it is in')
    useRows([
      kubeDetail({
        note_groups: [
          {
            title: '1 · Point kubectl and helm at this cluster',
            rows: [],
            body: [
              'houston keeps its own kubeconfig so creating a cluster cannot move the context you were using. A bare `kubectl` will not see this workspace until it is pointed here, and every command below assumes it:',
            ],
            commands: ['export KUBECONFIG=/home/you/.houston/clients/kubernetes/config'],
          },
        ],
      }),
    ]);
}

function setSurfaceDetail(row: Record<string, unknown>): void {
  mockListRepros.mockResolvedValue([row] as never);
  mockDescribe.mockResolvedValue(row as never);
  mockDetail.mockResolvedValue(row as never);
}

async function prepareSurface(name: string): Promise<void> {
  if (name === 'a readonly user is offered nothing in the detail panel either') {
    portedUser = 'ronly';
    portedPassword = 'read-only-password';
    await users.add(portedUser, portedPassword, 'readonly');
  }
  if (name === 'a member is not offered the delete at all') {
    portedUser = 'bob';
    portedPassword = 'bobs-good-password';
    await users.add(portedUser, portedPassword, 'member');
  }
  if (name === 'the create dialog follows the box policy not the role') {
    portedUser = 'mem';
    portedPassword = 'members-good-password';
    await users.add(portedUser, portedPassword, 'member');
    // A k3s that kubectl points at, no saved default, and an EKS cluster: the box on the
    // live k3s playground. An empty context lands on the k3s (`up` picks what kubectl
    // points at), so the member's "server's default" is that, and the EKS one is not theirs
    // to choose under the admin policy.
    useClusterContexts(
      [localContext('default', 'local'), clusterContext(CLUSTER_SUPPORT, { is_default: false })],
      '',
    );
    mockClusterStatus.mockImplementation(async (context) =>
      context === 'default' ? localStatus() : fakeClusterStatus(context),
    );
    mockToolsReady.mockReturnValue(true);
    mockPreflight.mockResolvedValue({
      context: 'default',
      distribution: 'k3s',
      clusterReachable: true,
      nodeCount: 1,
      namespaces: [],
    } as never);
  }
  if (name === 'the home page leads with capacity') {
    mockCapacity.mockResolvedValue({
      known: true,
      total_mb: 10_240,
      available_mb: 4_096,
      reserve_mb: 2_048,
      swap_mb: 0,
      workspace_mb: 1_100,
      room: 1,
      room_denominated_in: 'docker',
      room_by_runtime: {
        docker: 1,
        'kubernetes-monolith': 0,
        'kubernetes-microservices': 0,
      },
    });
  }
  if (name === 'a down workspace is something home asks you about') {
    setSurfaceDetail(detail({ name: 'upgrade-test', state: 'down' }));
    mockResolveName.mockResolvedValue('upgrade-test');
  }
  if (name === 'a note that names a place joins the row that already lists it') {
    setSurfaceDetail(
      detail({
        links: [
          { label: 'Rocket.Chat', url: 'http://localhost:3001', kind: 'rc' },
          { label: 'Grafana', url: 'http://localhost:5050', kind: 'monitor' },
          { label: 'Prometheus', url: 'http://localhost:9090', kind: 'monitor' },
        ],
        notes: [
          'Grafana:    http://localhost:5050  (admin/admin; anonymous view enabled)',
          'Prometheus: http://localhost:9090  (Status -> Targets: rocketchat, mongodb)',
          'Dashboards auto-provisioned: Rocket.Chat Metrics, MongoDB, Node Exporter Full.',
        ],
      }),
    );
  }
  if (name === 'the log viewer streams container output') {
    mockComposeStream.mockImplementation(async (_target, _args, onLine, options) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      for (let index = 0; index < 5; index += 1) {
        onLine?.(`houston-t1234-rocketchat-1  | {"level":30,"msg":"line ${String(index)}"}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      const signal = options?.abortSignal;
      if (signal !== undefined && !signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
      return 0;
    });
  }
  if (name === 'the backups tab lists what is there') {
    mockListBackups.mockResolvedValue([
      {
        path: '/tmp/t1234-2026-08-09.tar.zst',
        bytes: 1_234_567,
        rc_version: '7.4.1',
        mongo_tag: '7.0',
        preset: 'base',
        label: '',
        created_at: '2026-08-09T10:00:00+00:00',
      },
    ]);
  }
  if (name === 'the doctor dialog renders its checks') {
    mockRunChecks.mockResolvedValue({
      checks: [
        { status: 'ok', message: 'Docker daemon running (27.0.3)' },
        { status: 'ok', message: 'Edge running — holds :80/:443', elsewhere: 'edge chip' },
        { status: 'warn', message: '1 edge route(s) with no workspace' },
        { status: 'fail', message: '2 GB free - a workspace needs about 6' },
      ],
      counts: {},
      verdict: 'fail',
      repros: { total: 1, running: 1 },
    } as never);
  }
  if (name === 'the edge badge surfaces an unreachable route') {
    mockEdgeStatus.mockResolvedValue({
      installed: true,
      running: true,
      routes: ['t1234', 't9999'],
      attached: ['houston-t1234_default'],
    });
    mockServedDomain.mockReturnValue('support.example.com');
    mockRouteReachable.mockImplementation(async (value) => value === 't1234');
  }
  if (
    name === 'an admin can delete a certificate nothing points at' ||
    name === 'a member is not offered the delete at all'
  ) {
    surfaceAcmeHosts = ['old-ticket-991.kestron.org'];
    mockAcmeHosts.mockImplementation(() => [...surfaceAcmeHosts]);
    mockEdgeStatus.mockResolvedValue({ installed: true, running: true, routes: [], attached: [] });
    mockServedDomain.mockReturnValue('');
    mockDeleteHost.mockImplementation(async (host) => {
      surfaceAcmeHosts = surfaceAcmeHosts.filter((value) => value !== host);
      return {
        host,
        routes: [],
        passthrough: [],
        certificate: false,
        declaration: false,
        acme: ['acme.json'],
        restarted: null,
        foreign: '',
        kept: [],
      };
    });
  }
  if (name === 'reduced motion keeps every state and removes the travel') {
    portedReducedMotion = true;
  }
  if (
    name === 'a refusal raised inside a dialog is read on top of it' ||
    name === 'a member is told a ci build is kept to admins before pressing create'
  ) {
    // E13 of the acceptance run: a member, on a box that keeps CI builds to admins.
    portedUser = 'mem';
    portedPassword = 'members-good-password';
    await users.add(portedUser, portedPassword, 'member');
    config.updateConfig((value) => {
      value[CREATE_POLICY_KEY] = 'admin';
    });
  }
  if (
    name === 'the create dialog can stop its own job' ||
    name === 'a stopped job is said to be stopped not failed'
  ) {
    // A create stuck waiting, as one on a port-forward it cannot see is.
    const { sleep } = require('../../../src/seams/exec') as typeof ExecNS;
    mockCreateRepro.mockImplementation(async (_req, emit) => {
      emit?.(
        event('workspace name: stuck-one', {
          phase: 'create',
          code: 'workspace-name',
          data: { workspace: 'stuck-one' },
        }),
      );
      emit?.(event('Image rocket.chat:8.5.1 Pulling', { phase: 'pull' }));
      for (;;) await sleep(100);
    });
  }
  if (name === 'a long scenario note wraps in the create result') {
    // The email preset's own notes: the Mailpit row carries a description too long for
    // a column, and its rider line.
    mockCreateRepro.mockImplementation(async (req) => ({
      name: 'mail-one',
      rc_version: req.version,
      mongo_tag: '8.0',
      preset: 'email',
      root_url: 'http://localhost:3302',
      login: { user: 'admin', password: 'admin123' },
      notes: [
        'Mailpit (EVERY email RC sends, for ALL users, lands here): http://localhost:8025',
        '  — one shared inbox; tell users apart by the To: column.',
        "Quick SMTP check: Admin → Email → 'Send test email', then open Mailpit.",
      ],
    }));
  }
  if (name === 'a finished restore re-reads the workspace without a page error') {
    mockRestore.mockResolvedValue({ name: 't1234' } as never);
    mockListBackups.mockResolvedValue([
      {
        path: 't1234-2026-10-09.tar.zst',
        bytes: 1_234_567,
        rc_version: '7.4.1',
        mongo_tag: '7.0',
        preset: 'base',
        label: '',
        created_at: '2026-10-09T10:00:00+00:00',
      },
    ]);
  }
  if (name === 'a workspace is handed over from its pane and its owner row follows') {
    await users.add('bob', 'bobs-good-password', 'member');
    // A real record, so the real hand-over writes it; the panel reads its owner from there.
    await realRecord.write(
      't1234',
      'services: {}\n',
      realRecord.metadata({ name: 't1234', extra: { created_by: 'alice' } }),
    );
    mockDetail.mockImplementation(async () => {
      const owner = String((await realRecord.readMeta('t1234')).extra.owner ?? 'alice');
      return detail({ owner, created_by: owner }) as never;
    });
  }
  if (
    name === 'a refused hand over is said inside its dialog' ||
    name ===
      'a member on a colleague’s workspace is told who can hand it over and offered nothing to click'
  ) {
    // A member, on the default policy: the owner, an admin or nobody else may hand over.
    portedUser = 'mem';
    portedPassword = 'members-good-password';
    await users.add(portedUser, portedPassword, 'member');
    const owner = name.startsWith('a refused') ? 'mem' : 'bob';
    setSurfaceDetail(detail({ owner, created_by: owner, made_by: owner }));
    mockReadMeta.mockResolvedValue({
      name: 't1234',
      runtime: topology.DOCKER,
      extra: { owner },
    } as never);
  }
  if (name === 'every backup on the machine is listed and a deleted workspaces restores as new') {
    mockRestore.mockImplementation(async () => {
      useRows([detail(), detail({ name: 'gone-ws', rc_version: '7.3.0' })]);
      return { name: 'gone-ws' } as never;
    });
    mockListBackups.mockResolvedValue([
      {
        path: 't1234-2026-10-08.rcbak',
        bytes: 2_048_000,
        rc_version: '7.4.1',
        preset: 'base',
        repro: 't1234',
        label: '',
        created_at: '2026-10-08T10:00:00+00:00',
      },
      {
        path: 'gone-ws-2026-10-01.rcbak',
        bytes: 1_234_567,
        rc_version: '7.3.0',
        preset: 'email',
        repro: 'gone-ws',
        label: 'before the upgrade',
        created_at: '2026-10-01T10:00:00+00:00',
      },
    ]);
  }
  if (
    name === 'restore as new is offered while the source still holds the side ports it would use'
  ) {
    // The source still exists and still holds the preferred port its scenario publishes.
    await realRecord.write(
      'mail-src',
      'services: {}\n',
      realRecord.metadata({ name: 'mail-src', preset: 'email', extra: { sidecar_ports: [8025] } }),
    );
    useRows([detail({ name: 'mail-src', preset: 'email' })]);
    manifests = {
      'mail-src-2026-10-09.rcbak': { rc_version: '7.4.1', preset: 'email', repro: 'mail-src' },
    };
    mockListBackups.mockResolvedValue([
      {
        path: 'mail-src-2026-10-09.rcbak',
        bytes: 4_096_000,
        rc_version: '7.4.1',
        preset: 'email',
        repro: 'mail-src',
        label: '',
        created_at: '2026-10-09T10:00:00+00:00',
      },
    ]);
  }
  if (name === 'an upgraded workspace rolls back behind a red confirm and the panel follows') {
    setSurfaceDetail(detail({ rc_version: '7.4.1', rollback_to: '7.3.0' }));
    mockRollback.mockImplementation(async () => {
      setSurfaceDetail(detail({ rc_version: '7.3.0', rollback_to: '' }));
      return { name: 't1234', rolled_back_to: '7.3.0', bundle: 'b', restore: {} } as never;
    });
  }
  if (name === 'the overview follows a workspace that is still starting') {
    // What a restart's job leaves on screen: it ended while Rocket.Chat was booting.
    setSurfaceDetail(detail({ health: 'starting', uptime: '9 seconds' }));
  }
  if (name === 'the down and unknown words are readable in both themes') {
    useRows([detail({ name: 'down-one', state: 'down' }), detail({ name: 'odd-one', state: '?' })]);
  }
  if (name === "a directory workspace's notes read as points, with its login on the place row") {
    // The AD lab's notes as the preset writes them, through the real parser.
    useRows([
      detail({
        preset: 'ldap',
        notes: presets.load('ldap', { directory: 'ad', groups: 'on' }).notes,
      }),
    ]);
  }
  if (name === 'a card with a long name and a long preset list stays inside its box') {
    useRows([
      detail({
        name: 'admin-rc8-5-1-e2ee--email--ldap-ec470f',
        preset: 'e2ee+email+ldap+livechat+oidc+s3_minio',
        host_port: 3000,
        created_by: 'admin',
        monitoring: true,
        uptime: '10 minutes',
      }),
    ]);
  }
  if (name === "a combined workspace's scenario card is a guide per preset behind tabs") {
    // The real presets' guides, in the group the core hands the card for a combined workspace.
    const names = ['e2ee', 'email', 'ldap', 'livechat', 'oidc', 's3_minio', 'voice'];
    const composed = presets.loadMany(names, {}, 'docker');
    useRows([
      detail({
        preset: names.join('+'),
        presets: names,
        notes: composed.notes,
        note_groups: [
          {
            title: `Preset · ${names.join(' + ')}`,
            kind: 'scenario',
            rows: [],
            body: composed.notes,
            commands: [],
            guides: composed.guides,
          },
        ],
      }),
    ]);
  }
}

async function preparePortedCase(file: string, name: string): Promise<AppOptions> {
  await users.add('alice', PASSWORD, 'admin');
  if (file.startsWith('surfaces ')) await prepareSurface(name);
  if (file === 'clusters') await prepareClusterCase(name);
  if (name === 'people rows have their own shape not activitys')
    await users.add('bob', PASSWORD, 'member');
  if (name === 'the panel says that localhost means the readers own machine')
    useRows([detail({ bind_host: '127.0.0.1' })]);
  if (name === 'a wide bound workspace is given the address that works from here')
    useRows([detail({ bind_host: '0.0.0.0' })]);
  if (name === 'an https workspace read from another computer shows its public address')
    useRows([
      detail({
        public_url: 'https://t1234.ws.example.test',
        open_url: 'https://t1234.ws.example.test',
        tls: 'acme',
      }),
    ]);
  if (name === 'a localhost workspace read from another computer says where its links open')
    useRows([
      detail({
        preset: 'email',
        links: [{ label: 'Mailpit', url: 'http://localhost:8025', kind: '' }],
      }),
    ]);
  if (name === 'a link row shows the workspaces root url verbatim') {
    useRows([
      detail({ links: [{ label: 'Rocket.Chat', url: 'http://localhost:3001', kind: '' }] }),
    ]);
  }
  if (name === 'a placeholder url in a link row is left alone') {
    useRows([detail({ links: [{ label: 'Livechat', url: '<repro-url>/livechat', kind: '' }] })]);
  }
  if (name === 'the workspace row says kubernetes and stays quiet about docker') {
    useRows([detail({ name: 'kube-one', runtime: 'kubernetes' }), detail({ name: 'compose-one' })]);
  }
  if (name === 'creating a kubernetes workspace sends the axes') {
    mockCreateRepro.mockResolvedValue({} as never);
    useDefaultClusters();
  }
  prepareKubernetesCase(name);
  return {
    accounts: true,
    ...(publicOrigin(file, name) ? { allowHosts: [PUBLIC_NAME] } : {}),
    ...(portedJobs === undefined ? {} : { jobs: portedJobs }),
  };
}

async function browserImport<T>(
  page: Page,
  module: string,
  member: string,
  ...args: unknown[]
): Promise<T> {
  return (await page.evaluate(
    async ({ specifier, exported, values }) => {
      const load = new Function('name', 'return import(name)') as (
        name: string,
      ) => Promise<Record<string, (...items: unknown[]) => unknown>>;
      const loaded = await load(specifier);
      return loaded[exported]?.(...values);
    },
    { specifier: module, exported: member, values: args },
  )) as T;
}

async function openWorkspace(page: Page, name = 't1234'): Promise<void> {
  await page
    .locator('.wrow', { has: page.locator('.nm', { hasText: name }) })
    .first()
    .click();
  await page.locator('#d-body').waitFor({ state: 'visible' });
}

async function scenarioParts(page: Page, scenario: string, klass: string): Promise<string[]> {
  const card = page.locator('.hcard').filter({ has: page.locator('b', { hasText: scenario }) });
  return await card
    .locator(`.${klass}`)
    .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim()));
}

async function exerciseChrome(name: string, page: Page): Promise<void> {
  if (name === 'the theme is light by default and the choice survives a reload') {
    // LIGHT EVEN ON A DARK DESKTOP. The first visit followed the OS, so every dark-mode
    // laptop opened the GUI dark; light is the default until the toggle says otherwise.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await page.locator('#repros').waitFor({ state: 'visible' });
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      'rgb(228, 231, 236)',
    );
    const toggle = page.locator('#theme-toggle');
    await toggle.click();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
    await page.reload();
    await page.locator('#repros').waitFor({ state: 'visible' });
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
    // #repros is static markup; the toggle is drawn by the theme module, a moment later.
    await toggle.locator('svg').waitFor({ state: 'attached' });
    expect((await toggle.innerText()).trim()).toBe('');
    expect(await toggle.locator('svg').count()).toBe(1);
    expect(await toggle.getAttribute('aria-label')).toBe('Switch to the light theme');
    expect(await toggle.locator('circle').count()).toBe(1);
    await toggle.click();
    expect(await toggle.getAttribute('aria-label')).toBe('Switch to the dark theme');
    expect(await toggle.locator('circle').count()).toBe(0);
    expect(
      await toggle.evaluate((node) => {
        const svg = node.querySelector('svg');
        return svg !== null && getComputedStyle(svg).stroke === getComputedStyle(node).color;
      }),
    ).toBe(true);
    return;
  }
  if (name === 'people rows have their own shape not activitys') {
    await page.locator('#whoami').click();
    await page.locator('#me-people').click();
    await page.locator('#people-dialog[open]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('.prow').length >= 2);
    expect(await page.locator('#people-dialog .jobrow, #people-dialog .jstatus').count()).toBe(0);
    const row = page.locator('.prow', { hasText: 'bob' }).first();
    expect(await row.locator('select').inputValue()).toBe('member');
    expect(await row.getByRole('button', { name: /reset/u }).count()).toBe(1);
    expect(await row.getByRole('button', { name: /remove/u }).count()).toBe(1);
    const counts = await page
      .locator('.prow')
      .evaluateAll((rows) => rows.map((row) => row.children.length));
    expect(new Set(counts).size).toBe(1);
    return;
  }
  if (name === 'a background poll does not navigate the page for you') {
    for (const [opener, marker] of [
      ['#btn-jobs', '#act-tabs'],
      ['#btn-scenarios', '.hcard.scen'],
    ] as const) {
      await page.locator(opener).click();
      await page.locator(marker).first().waitFor({ state: 'visible' });
      await browserImport(page, '/js/state.js', 'refreshHome', true);
      await page.waitForTimeout(400);
      expect(await page.locator(marker).count()).toBeGreaterThan(0);
      expect(await page.locator('.home-head h1').textContent()).not.toContain('Good ');
    }
    return;
  }
  if (name === 'activity and a workspace are different views of the stage') {
    await openWorkspace(page);
    expect(await page.locator('#actpane .apdanger').isVisible()).toBe(true);
    await page.locator('#btn-jobs').click();
    await page.locator('#act-tabs').waitFor({ state: 'visible' });
    expect(await page.locator('#actpane .apdanger').count()).toBe(0);
    expect(await page.locator('.wrow[aria-current=true]').count()).toBe(1);
    await page.locator('.wrow').click();
    await page.locator('#d-body').waitFor({ state: 'visible' });
    expect(await page.locator('#act-tabs').count()).toBe(0);
    return;
  }
  if (name === 'the scenarios page shows the setup step a preset needs') {
    await page.locator('#btn-scenarios').click();
    await page.waitForFunction(() =>
      document.querySelector('#detail')?.textContent.includes('oidc'),
    );
    const body = (await page.locator('#detail').textContent()) ?? '';
    expect(body).toContain('127.0.0.1  keycloak');
    expect(body).toContain('/etc/hosts');
    expect(body).toContain('8085');
    const command = page.locator('.note-cmd code', { hasText: '127.0.0.1' });
    expect(await command.count()).toBe(1);
    expect(await command.first().innerText()).toBe('127.0.0.1  keycloak');
    expect(await command.first().evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('pre');
    expect(await page.locator('.note-cmd .cp').first().isVisible()).toBe(true);
    const row = page
      .locator('.linkrow')
      .filter({ has: page.locator('.l-u', { hasText: 'http://keycloak:8085' }) });
    expect(await row.count()).toBe(1);
    expect(await row.locator('.l-n').innerText()).toContain('Keycloak admin console');
    expect(await row.locator('.l-c').innerText()).toBe('admin/admin');
    expect(await row.locator('.l-sub').innerText()).toContain('houston');
    expect(await row.first().getAttribute('href')).toBe('http://keycloak:8085');
    return;
  }
  if (name === 'every page is reachable and says which one you are on') {
    expect(await page.locator('#btn-home').getAttribute('aria-current')).not.toBeNull();
    await page.locator('#btn-jobs').click();
    await page.locator('#act-tabs').waitFor({ state: 'visible' });
    expect(await page.locator('#btn-jobs').getAttribute('aria-current')).not.toBeNull();
    expect(await page.locator('#btn-home').getAttribute('aria-current')).toBeNull();
    await page.locator('#btn-home').click();
    await page.waitForFunction(() => document.querySelector('#detail .pv.home') !== null);
    await page.locator('#btn-scenarios').click();
    await page.waitForFunction(() =>
      document.querySelector('#detail')?.textContent.includes('Presets'),
    );
    await page.locator('.brand').click();
    await page.waitForFunction(() => document.querySelector('#detail .pv.home') !== null);
    return;
  }
  if (name === 'the dashboard poll does not close the page you are reading') {
    await page.locator('#btn-scenarios').click();
    await page.waitForFunction(() =>
      document.querySelector('#detail')?.textContent.includes('Presets'),
    );
    await page.waitForTimeout(5000);
    expect(await page.locator('#detail').textContent()).toContain('Presets');
    return;
  }
  await page.locator('#btn-scenarios').click();
  await page.waitForFunction(() =>
    document.querySelector('#detail')?.textContent.includes('livechat'),
  );
  expect(await scenarioParts(page, 'livechat', 'l-u')).toEqual([
    'http://localhost:8090',
    '<workspace-url>/livechat',
  ]);
  expect(await scenarioParts(page, 'livechat', 'l-w')).toEqual([
    'widget embedded, cross-origin',
    'same-origin',
  ]);
  const live = await scenarioParts(page, 'livechat', 'note-p');
  expect(live).toHaveLength(2);
  expect(live[0]).toMatch(/^admin is an available/u);
  const oidc = await scenarioParts(page, 'oidc', 'note-p');
  expect(oidc[0]).toMatch(/^OIDC needs one host entry/u);
  expect(oidc[0]).toContain('same URL');
}

async function exerciseRemote(name: string, page: Page): Promise<void> {
  if (name.includes('panel says')) {
    await openWorkspace(page);
    const warning = page.locator('#d-body .banner.warn');
    await warning.waitFor({ state: 'visible' });
    const said = (await warning.textContent()) ?? '';
    expect(said).toContain(PUBLIC_NAME);
    expect(said).toContain('0.0.0.0');
    // The section is More options, and a wide bind gets a generated admin password.
    expect(said).toContain('More options');
    expect(said).not.toContain('admin123');
    expect(await page.locator('#d-body .urlbox').first().textContent()).toContain(
      'http://localhost:3001',
    );
    return;
  }
  if (name.includes('wide bound')) {
    await openWorkspace(page);
    await page.waitForFunction(() =>
      document.querySelector('#d-body')?.textContent.includes('From your browser'),
    );
    expect(await page.locator('#d-body').textContent()).toContain(`http://${PUBLIC_NAME}:3001`);
    expect(await page.locator('#d-body .banner.warn').count()).toBe(0);
    return;
  }
  if (name.includes('an https workspace')) {
    // Measured on the shared server: an HTTPS workspace's URL box said http://localhost
    // under an amber "only the server itself can reach it", beside an Open RC that worked.
    await openWorkspace(page);
    const box = page.locator('#d-body .urlbox').first();
    await box.waitFor({ state: 'visible' });
    expect(await box.textContent()).toContain('https://t1234.ws.example.test');
    const body = (await page.locator('#d-body').textContent()) ?? '';
    expect(body).toContain('On the server');
    expect(body).toContain('http://localhost:3001');
    expect(await page.locator('#d-body .banner').count()).toBe(0);
    return;
  }
  if (name.includes('says where its links open')) {
    // A remote reader's Mailpit link opened localhost on their own computer, unsaid.
    await openWorkspace(page);
    await page.locator('#d-body .linkrow').first().waitFor({ state: 'visible' });
    const note = page.locator('#d-body .panelcard #links-loopback');
    expect(await note.count()).toBe(1);
    expect(await note.textContent()).toContain('Links to localhost open on YOUR computer');
    const open = page.locator('#detail .d-actions a', { hasText: 'Open RC' });
    expect(await open.getAttribute('title')).toContain('YOUR computer');
    return;
  }
  if (name.includes('local browser')) {
    await openWorkspace(page);
    await page.locator('#d-body .urlbox').first().waitFor({ state: 'visible' });
    expect(await page.locator('#d-body .banner.warn').count()).toBe(0);
    expect(await page.locator('#d-body').textContent()).not.toContain('From your browser');
    expect(await browserImport(page, '/js/util.js', 'remoteHost')).toBe('');
    return;
  }
  await page.locator('#btn-new').click();
  await page.locator('#create-dialog[open]').waitFor({ state: 'visible' });
  if (name.includes('warns a remote')) {
    const hint = page.locator('#create-bind-hint:not([hidden])');
    await hint.waitFor({ state: 'visible' });
    const said = (await hint.textContent()) ?? '';
    expect(said).toContain('0.0.0.0');
    expect(said).toContain("Let's Encrypt");
    expect(said).not.toContain('admin123');
    expect(said.length).toBeLessThan(180);
  } else expect(await page.locator('#create-bind-hint').isHidden()).toBe(true);
}

async function exerciseRuntimeDialog(page: Page): Promise<void> {
  await page.locator('#btn-new').click();
  await page.locator('#create-dialog[open]').waitFor({ state: 'visible' });
  const arrangements = async () =>
    await page
      .locator('#deployment-seg button')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.deployment ?? ''));
  const selected = async () =>
    (await page
      .locator("#deployment-seg button[aria-pressed='true']")
      .getAttribute('data-deployment')) ?? '';
  // Docker is chosen before anybody clicks: it is where most workspaces go.
  expect(await page.locator('#dest-cards input[name=dest]:checked').getAttribute('value')).toBe(
    'docker',
  );
  expect(await page.locator('#runtime-value').inputValue()).toBe('docker');
  await createDetails(page);
  expect(await arrangements()).toEqual(expect.arrayContaining(['monolith', 'multi-instance']));
  expect(await arrangements()).not.toContain('microservices');
  expect(await page.locator('#mongo-operator').count()).toBe(0);
  await createWhere(page);
  await pickPlace(page, 'k8s:kind-houston-local');
  expect(await page.locator('#runtime-value').inputValue()).toBe('kubernetes');
  await createDetails(page);
  expect(await selected()).toBe('microservices');
  expect(await arrangements()).not.toContain('multi-instance');
  expect(await page.locator('#mongo-operator').count()).toBe(1);
  expect(await page.locator('#create-https-block').getAttribute('hidden')).toBeNull();
  const modes = async () =>
    await page
      .locator('#https-mode option')
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value));
  expect(await modes()).toEqual(expect.arrayContaining(['local', 'acme']));
  const modesFor = async (unsupported: Array<{ field: string }>) =>
    await page.evaluate(
      async ({ source, value }) => {
        const load = new Function('name', 'return import(name)') as (
          name: string,
        ) => Promise<Record<string, (...args: unknown[]) => unknown>>;
        const loaded = await load(source);
        const sync = loaded.syncAdvancedForRuntime;
        if (sync === undefined) throw new Error('syncAdvancedForRuntime is not exported');
        sync({ unsupported: value });
        return [...document.querySelectorAll('#https-mode option')].map(
          (node) => (node as HTMLOptionElement).value,
        );
      },
      { source: '/js/clusters.js', value: unsupported },
    );
  expect(await modesFor([{ field: 'domain' }])).not.toContain('acme');
  expect(await modes()).toContain('local');
  expect(await modesFor([])).toContain('acme');
  await modesFor([{ field: 'https' }]);
  expect(await page.locator('#create-https-block').getAttribute('hidden')).not.toBeNull();
  await modesFor([{ field: 'fresh' }]);
  expect(await page.locator('#create-https-block').getAttribute('hidden')).toBeNull();
  const existing = async () =>
    await page
      .locator('select[name=existing] option')
      .evaluateAll((nodes) => nodes.map((node) => node.textContent));
  expect((await existing()).some((v) => v.includes('DELETE'))).toBe(false);
  expect((await existing()).some((v) => v.includes('Reuse'))).toBe(true);
  await page.locator('#deployment-seg button[data-deployment="monolith"]').click();
  expect(await selected()).toBe('monolith');
  expect(await page.locator('#replicas-row').isHidden()).toBe(true);
  await page.locator('#deployment-seg button[data-deployment="microservices"]').click();
  await createWhere(page);
  await pickPlace(page, 'docker');
  await createDetails(page);
  expect(await page.locator('#mongo-operator').count()).toBe(0);
  expect((await existing()).some((v) => v.includes('DELETE'))).toBe(true);
}

async function exercisePlain(name: string, page: Page): Promise<void> {
  if (name === 'signing in works over plain http on a real hostname') {
    expect(await page.content()).not.toContain('cross-site request refused');
    expect((await page.locator('#whoami').textContent())?.trim()).toBe('alice');
    return;
  }
  if (name === 'a write from the spa survives plain http on a real hostname') {
    const result = await page.evaluate(async () => {
      const response = await fetch('/api/repros/does-not-exist', {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      return { status: response.status, text: await response.text() };
    });
    expect(result.status).not.toBe(403);
    expect(result.text).not.toContain('cross-site');
    return;
  }
  if (name.includes('link row')) {
    await openWorkspace(page);
    const row = page.locator('.linkrow').first();
    await row.waitFor({ state: 'visible' });
    const shown = (await row.locator('.l-u').innerText()).trim();
    if (name.startsWith('a placeholder')) expect(shown).toBe('<repro-url>/livechat');
    else {
      const href = await row.getAttribute('href');
      expect(shown).toBe('http://localhost:3001');
      expect(href).toBe(shown);
      expect(shown).not.toContain(PUBLIC_NAME);
    }
    return;
  }
  if (name.includes('workspace row')) {
    await page.waitForFunction(() =>
      document.querySelector('#repros')?.textContent.includes('kube-one'),
    );
    const kube = await page.locator('.wrow', { hasText: 'kube-one' }).locator('.meta').innerText();
    const compose = await page
      .locator('.wrow', { hasText: 'compose-one' })
      .locator('.meta')
      .innerText();
    expect(kube).toContain('k8s');
    expect(compose).not.toContain('docker');
    expect(compose).not.toContain('k8s');
    return;
  }
  if (name.includes('offers a runtime')) {
    await exerciseRuntimeDialog(page);
    return;
  }
  await page.locator('#btn-new').click();
  await page.locator('#create-dialog[open]').waitFor({ state: 'visible' });
  // THE CLUSTER TOO. The picker's choice was never copied into the request, so a browser
  // user could not put a workspace on a cluster at all: it always went to the default.
  await page.waitForFunction((key) => {
    const input = document.querySelector(
      `#dest-cards label[data-dest="${key}"] input`,
    ) as HTMLInputElement | null;
    return input !== null && !input.disabled;
  }, `eks:${CLUSTER_SUPPORT}`);
  await pickPlace(page, `eks:${CLUSTER_SUPPORT}`);
  await createDetails(page);
  await page.locator('input[name=version]').fill('8.5.1');
  await page.locator('#deployment-seg button[data-deployment="microservices"]').click();
  await page.locator('#create-dialog details.adv').evaluate((node) => {
    (node as HTMLDetailsElement).open = true;
  });
  await page.locator('input[name=mongo_operator]').check();
  // The dialog offers neither --offline nor --no-pull: they stay on the command line.
  expect(
    await page
      .locator('#create-dialog input[name=offline], #create-dialog input[name=no_pull]')
      .count(),
  ).toBe(0);
  await page.locator('#create-submit').click();
  for (let n = 0; n < 40 && mockCreateRepro.mock.calls.length === 0; n += 1)
    await page.waitForTimeout(100);
  expect(mockCreateRepro).toHaveBeenCalledTimes(1);
  const request = mockCreateRepro.mock.calls[0]?.[0];
  expect(request?.runtime).toBe('kubernetes');
  expect(request?.deployment).toBe('microservices');
  expect(request?.mongoOperator).toBe(true);
  expect(request?.context).toBe(CLUSTER_SUPPORT);
  expect(request?.offline).toBeFalsy();
  expect(request?.noPull).toBeFalsy();
}

async function paneState(
  page: Page,
): Promise<{ next: string[][]; rest: Array<[string, boolean]>; groups: string[]; note: string }> {
  return await page.evaluate(() => ({
    next: [...document.querySelectorAll('#actpane .apn')].map((button) => [
      button.querySelector('b')?.textContent ?? '',
      button.textContent,
    ]),
    rest: [...document.querySelectorAll<HTMLButtonElement>('#actpane .aplist button')].map(
      (button) => [button.textContent, button.disabled],
    ),
    groups: [...document.querySelectorAll('#actpane .apgroup')].map((group) => group.textContent),
    note: document.querySelector('#actpane .apnote')?.textContent ?? '',
  }));
}

async function exerciseKubernetesChrome(name: string, page: Page): Promise<void> {
  if (name === 'the footer says k8s is unknown until the probe answers') {
    // Docker has answered and Kubernetes has not: that is "?", not "not set up". It said
    // "not set up" for as long as the probe took, on a box with a working cluster.
    await page.waitForFunction(() =>
      (document.querySelector('#sb-engines')?.textContent ?? '').startsWith('docker: up'),
    );
    expect(await page.locator('#sb-engines').textContent()).toBe('docker: up · k8s: ?');
    // Create's Kubernetes card, opened in the same window, is reading too -- not "Needs
    // kubectl and helm on the server".
    await openClusterCreate(page);
    const card = page.locator('#dest-cards label[data-dest="k8s-none"]');
    expect(await card.innerText()).toContain('Reading…');
    expect(await card.innerText()).not.toContain('Needs kubectl');
    await page.waitForFunction(
      () => !(document.querySelector('#sb-engines')?.textContent ?? '').endsWith('k8s: ?'),
      undefined,
      { timeout: 8000 },
    );
    expect(await page.locator('#sb-engines').textContent()).toBe(
      'docker: up · k8s: kind kind-support',
    );
    // ...and says what the probe found once it has, with the dialog still open.
    expect(await card.innerText()).not.toContain('Reading…');
    return;
  }
  if (name === 'the top links become one menu on a narrow screen') {
    await page.setViewportSize({ width: 430, height: 780 });
    await page.waitForTimeout(200);
    expect(await page.locator('#nav-toggle').isVisible()).toBe(true);
    expect(await page.locator('#btn-jobs').isVisible()).toBe(false);
    expect(await page.locator('#btn-jobs').count()).toBe(1);
    await page.locator('#nav-toggle').click();
    await page.locator('#btn-jobs').waitFor({ state: 'visible' });
    expect(await page.locator('#nav-toggle').getAttribute('aria-expanded')).toBe('true');
    await page.locator('#btn-jobs').click();
    await page.waitForFunction(() =>
      document.querySelector('#btn-jobs')?.hasAttribute('aria-current'),
    );
    expect(await page.locator('#btn-jobs').isVisible()).toBe(false);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(200);
    expect(await page.locator('#btn-jobs').isVisible()).toBe(true);
    expect(await page.locator('#nav-toggle').isVisible()).toBe(false);
    return;
  }
  if (name === 'the header is the doctor button and the footer names both engines') {
    await page.locator('#doctor-badge').waitFor({ state: 'visible' });
    expect((await page.locator('#doctor-badge').textContent())?.trim()).toBe('doctor');
    await page.waitForFunction(
      () => !document.querySelector('#sb-engines')?.textContent.includes('k8s: ?'),
    );
    const footer = (await page.locator('#sb-engines').textContent()) ?? '';
    expect(footer.startsWith('docker: ')).toBe(true);
    expect(footer).toContain('k8s: not set up');
    await page.locator('#doctor-badge').click();
    await page.locator('#doctor-dialog[open]').waitFor({ state: 'visible' });
    return;
  }
  if (name === 'the doctor chip goes red only when nothing can run a workspace') {
    const classes = await page.evaluate(
      async ({ mainSource, sharedSource, utilSource }) => {
        const load = new Function('name', 'return import(name)') as (
          name: string,
        ) => Promise<Record<string, unknown>>;
        await load(mainSource);
        const ctx = (await load(sharedSource)).ctx as { DOCKER_OK: boolean; KUBE: unknown };
        const paintEngines = (await load(utilSource)).paintEngines as () => void;
        const badge = document.querySelector('#doctor-badge') as HTMLElement;
        const out: Record<string, string> = {};
        ctx.DOCKER_OK = false;
        ctx.KUBE = { usable: true, reachable: true, distribution: 'k3s', context: 'default' };
        paintEngines();
        out.dockerDownKubeUp = badge.className;
        out.footer = document.querySelector('#sb-engines')?.textContent ?? '';
        ctx.DOCKER_OK = false;
        ctx.KUBE = { usable: false, reachable: false };
        paintEngines();
        out.bothDown = badge.className;
        ctx.DOCKER_OK = true;
        ctx.KUBE = null;
        paintEngines();
        out.dockerOnly = badge.className;
        return out;
      },
      { mainSource: '/js/main.js', sharedSource: '/js/shared.js', utilSource: '/js/util.js' },
    );
    expect(classes.dockerDownKubeUp).toContain('up');
    expect(classes.footer).toContain('k3s default');
    expect(classes.bothDown).toContain('down');
    expect(classes.dockerOnly).toContain('up');
    return;
  }
  await page.locator('#btn-jobs').click();
  await page.locator('#jobs-list').waitFor({ state: 'visible' });
  await page.waitForTimeout(400);
  const shown = await page.locator('#jobs-list .jstatus').allTextContents();
  expect(shown.sort()).toEqual(['queued', 'running']);
}

async function exerciseKubernetesDialogs(name: string, page: Page): Promise<void> {
  if (name.startsWith('seed ')) {
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Add sample data' }).click();
    await page.locator('#seed-dialog[open]').waitFor({ state: 'visible' });
    const form = page.locator('#seed-form');
    if (name === 'seed choices show server counts and reset when reopened') {
      expect(await form.locator('[name=profile] option').allTextContents()).toEqual([
        'small — 5 users, 12 rooms',
        'standard — 20 users, 25 rooms',
        'large — 100 users, 60 rooms',
      ]);
      await form.locator('[name=scenarios][value=room-states]').check();
      await form.locator('[name=history]').check();
      await form.locator('[name=history_days]').fill('90');
      await page.locator('#seed-cancel').click();
      await page.getByRole('button', { name: 'Add sample data' }).click();
      await page.locator('#seed-dialog[open]').waitFor({ state: 'visible' });
      expect(await form.locator('[name=scenarios]:checked').count()).toBe(0);
      expect(await form.locator('[name=history]').isChecked()).toBe(false);
      expect(await form.locator('[name=history_days]').inputValue()).toBe('180');
      expect(await form.locator('[name=history_days]').isDisabled()).toBe(true);
      return;
    }
    if (name === 'seed scale mode disables scenarios and historical dates') {
      await form.locator('[name=mode]').selectOption('scale');
      expect(await form.locator('#seed-options').isVisible()).toBe(false);
      for (const input of await form.locator('#seed-options input').all())
        expect(await input.isDisabled()).toBe(true);
      await form.locator('[name=mode]').selectOption('profile');
      expect(await form.locator('#seed-options').isVisible()).toBe(true);
      expect(await form.locator('[name=history_days]').isDisabled()).toBe(true);
      return;
    }
    if (name === 'seed submits profile scenarios and history together') {
      await form.locator('[name=profile]').selectOption('standard');
      await form.locator('[name=scenarios][value=room-states]').check();
      await form.locator('[name=scenarios][value=permissions]').check();
      await form.locator('[name=history]').check();
      await form.locator('[name=history_days]').fill('90');
    }
    await page.locator('#seed-submit').click();
    await page.waitForFunction(
      () => document.querySelector('#job-log .result') !== null,
      undefined,
      { timeout: 20000 },
    );
    if (name === 'seed incomplete readback never appears confirmed') {
      expect(await page.locator('#job-log').innerText()).toContain(
        'Incomplete: some checks could not run',
      );
      expect(await page.locator('#job-log .result .green').count()).toBe(0);
    } else {
      expect(mockRunSeedInline).toHaveBeenCalledTimes(1);
      expect(mockRunSeedInline.mock.calls[0]?.[1]).toBe('standard');
      expect(mockRunSeedInline.mock.calls[0]?.[4]).toEqual({
        scenarios: ['permissions', 'room-states'],
        historyDays: 90,
      });
      const result = page.locator('#job-log .result');
      expect(await result.innerText()).toContain('Planned: 20 users · 29 rooms · 435 messages');
      expect(await result.innerText()).toContain(
        '12/12 files · 54/54 thread roots · 278/278 reactions · 21/21 pins · 25/25 stars',
      );
      expect(await result.innerText()).toContain('Synthetic history: 90 days');
      await result.locator('details summary').click();
      expect(await result.innerText()).toContain('support: personal stars: sign in as alice');
      expect(await result.innerText()).toContain('discussion in support');
    }
    return;
  }
  if (name === 'on kubernetes the voice panel offers no phone options and sends none') {
    // Chosen on Docker first: what was typed there must not reach a Kubernetes create,
    // where sip_integration=on is refused only after Create.
    await page.locator('#btn-new').click();
    await page.locator('#create-dialog[open]').waitFor({ state: 'visible' });
    await pickPlace(page, 'docker');
    await createDetails(page);
    await page.locator('#plist input[value=voice]').check();
    await page.locator('.ppanel input[data-p=voice][data-k=sip_integration]').check();
    await page.locator('.ppanel input[data-p=voice][data-k=voip_domain]').fill('192.168.1.20');
    await createWhere(page);
    await pickPlace(page, 'k8s:kind-support');
    await createDetails(page);
    expect(await page.locator('#plist input[value=voice]').isChecked()).toBe(true);
    expect(await page.locator('.ppanel [data-p=voice][data-k=sip_integration]').count()).toBe(0);
    expect(await page.locator('.ppanel [data-p=voice][data-k=voip_domain]').count()).toBe(0);
    expect(await page.locator('.ppanel', { hasText: 'run on Docker only' }).count()).toBe(1);
    expect(await page.locator('.ppanel input[data-p=voice][data-k=ice_servers]').count()).toBe(1);
    await page.locator('#create-form [name=version]').fill('8.8.1');
    await page.locator('#create-submit').click();
    for (let n = 0; n < 40 && mockCreateRepro.mock.calls.length === 0; n += 1)
      await page.waitForTimeout(100);
    const request = mockCreateRepro.mock.calls[0]?.[0];
    expect([request?.runtime, request?.preset, request?.params]).toEqual([
      'kubernetes',
      'voice',
      {},
    ]);
    return;
  }
  if (name === 'create sends scenario and history only with sample data enabled') {
    for (const enabled of [true, false]) {
      await page.locator('#btn-new').click();
      await page.locator('#create-dialog[open]').waitFor({ state: 'visible' });
      await createDetails(page);
      const form = page.locator('#create-form');
      await form.locator('[name=version]').fill('8.5.1');
      await form.locator('[name=seed]').check();
      await form.locator('[name=seed_profile]').selectOption('standard');
      await form.locator('[name=seed_scenarios][value=permissions]').check();
      await form.locator('[name=seed_history]').check();
      await form.locator('[name=seed_history_days]').fill('90');
      if (!enabled) await form.locator('[name=seed]').uncheck();
      const before = mockCreateRepro.mock.calls.length;
      await page.locator('#create-submit').click();
      for (let n = 0; n < 40 && mockCreateRepro.mock.calls.length === before; n += 1)
        await page.waitForTimeout(100);
      const request = mockCreateRepro.mock.calls[before]?.[0];
      expect(request?.seed).toBe(enabled);
      expect(request?.seedScenarios).toEqual(enabled ? ['permissions'] : []);
      expect(request?.seedHistoryDays).toBe(enabled ? 90 : null);
      await page.locator('#create-cancel').click();
    }
    return;
  }

  if (name === 'the seed job shows what it made and whether it was confirmed') {
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Add sample data' }).click();
    await page.locator('#seed-dialog[open]').waitFor({ state: 'visible' });
    await page.locator('#seed-submit').click();
    await page.locator('#job-log').waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForFunction(
      () => document.querySelector('#job-log')?.textContent.includes('match the plan'),
      undefined,
      { timeout: 20_000 },
    );
    const body = (await page.locator('#job-log').textContent()) ?? '';
    expect(body).toContain('415 messages');
    expect(body).toContain('162 in threads');
    expect(body).toContain('channel 5');
    expect(body).toContain('discussion 3');
    return;
  }
  await page.locator('#btn-new').click();
  await page.locator('#create-dialog[open]').waitFor({ state: 'visible' });
  if (name === 'the create dialog says what it builds and what the box has left') {
    // What the box has left is on the cards for the places on it, as a count -- never a
    // memory figure dressed as a fact; what it builds is said under Shape.
    await page.waitForFunction(
      () =>
        (
          document.querySelector('#dest-cards label[data-dest="docker"]')?.textContent ?? ''
        ).includes('room for'),
      undefined,
      { timeout: 15_000 },
    );
    const docker = await page.locator('#dest-cards label[data-dest="docker"]').innerText();
    const kube = await page.locator('#dest-cards label[data-dest="k8s:kind-support"]').innerText();
    expect(docker).toContain('room for');
    expect(kube).toContain('room for');
    expect(`${docker}${kube}`).not.toMatch(/GB|MB/u);
    await createDetails(page);
    expect(await page.locator('#runtime-hint').innerText()).toContain('One Rocket.Chat process');
    return;
  }
  if (name === 'a kubernetes card names the cluster it will use') {
    // A card that said only "Kubernetes" could not say which cluster. Now each cluster is
    // its own card, and it names the one the request will carry.
    const kube = page.locator('#dest-cards label[data-dest="k8s:default"]');
    await kube.waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
      (
        document.querySelector('#dest-cards label[data-dest="k8s:default"]')?.textContent ?? ''
      ).includes('k3s'),
    );
    expect(await kube.innerText()).toContain('default');
    expect(await page.locator('#dest-cards label[data-dest^="eks:"]').innerText()).toContain(
      'support',
    );
    await pickPlace(page, 'k8s:default');
    expect(await page.locator('#context-select').inputValue()).toBe('default');
    return;
  }
  await createDetails(page);
  expect(await page.locator('#runtime-hint').innerText()).toContain('One Rocket.Chat process');
  await createWhere(page);
  await pickPlace(page, 'k8s:kind-support');
  await createDetails(page);
  const note = await page.locator('#runtime-hint').innerText();
  expect(note).toContain('ddp-streamer');
  expect(note).not.toContain('HTTPS');
  await page.locator('#deployment-seg button[data-deployment="monolith"]').click();
  expect(await page.locator('#runtime-hint').innerText()).toContain('One Rocket.Chat process');
}

async function exerciseKubernetesOffstage(name: string): Promise<void> {
  if (name === 'fake detail matches the real payload') {
    const fake = detail();
    const metadata = {
      cmp: {
        name: 'cmp',
        project: 'p',
        rcVersion: '7.4.1',
        rcImage: 'i',
        mongoTag: '7.0',
        mongoFlavor: 'official',
        preset: 'default',
        rootUrl: 'http://localhost:3001',
        hostPort: 3001,
        versionSource: 'x',
        pinned: false,
        createdAt: '',
        publicUrl: '',
        adminPassword: '',
        extra: {},
      },
      kub: {
        name: 'kub',
        project: 'p',
        rcVersion: '7.4.1',
        rcImage: 'i',
        mongoTag: '7.0',
        mongoFlavor: 'official',
        preset: 'default',
        rootUrl: 'http://localhost:3002',
        hostPort: 3002,
        versionSource: 'x',
        pinned: false,
        createdAt: '',
        publicUrl: '',
        adminPassword: '',
        extra: { runtime: 'kubernetes', namespace: 'houston-kub' },
      },
      multi: {
        name: 'multi',
        project: 'p',
        rcVersion: '7.4.1',
        rcImage: 'i',
        mongoTag: '7.0',
        mongoFlavor: 'official',
        preset: 'multi-instance',
        rootUrl: 'http://localhost:3003',
        hostPort: 3003,
        versionSource: 'x',
        pinned: false,
        createdAt: '',
        publicUrl: '',
        adminPassword: '',
        extra: { instances: 3 },
      },
    } as const;
    const home = process.env.HOUSTON_HOME;
    if (home === undefined) throw new Error('browser home is not isolated');
    for (const name of ['cmp', 'multi'] as const) {
      const workspace = path.join(home, 'repros', name);
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(
        path.join(workspace, 'docker-compose.yml'),
        `services:\n  rocketchat:\n    image: i\n    ports:\n      - 127.0.0.1:${String(metadata[name].hostPort)}:3000\n    environment:\n      ROOT_URL: x\n`,
      );
    }
    mockResolveName.mockImplementation(async (target) => String(target ?? ''));
    mockReadMeta.mockImplementation(async (target) => metadata[target as keyof typeof metadata]);
    mockKubernetesState.mockResolvedValue('running');
    mockPodRows.mockResolvedValue([]);
    mockContainerDetails.mockResolvedValue([]);
    mockRcRestartCount.mockResolvedValue(0);
    const shape = (value: unknown): string => (Array.isArray(value) ? 'array' : typeof value);
    const seen: string[] = [];
    for (const available of [false, true]) {
      mockDockerAvailable.mockResolvedValue(available);
      for (const target of ['cmp', 'kub', 'multi'] as const) {
        seen.push(`${String(available)}:${target}`);
        const real = await realPayload.detail(target);
        expect(Object.keys(real).filter((key) => !Object.hasOwn(fake, key))).toEqual([]);
        for (const key of Object.keys(real).filter((item) => Object.hasOwn(fake, item))) {
          if (real[key] === null || fake[key] === null) continue;
          expect(shape(fake[key])).toBe(shape(real[key]));
        }
      }
    }
    expect(seen).toEqual([
      'false:cmp',
      'false:kub',
      'false:multi',
      'true:cmp',
      'true:kub',
      'true:multi',
    ]);
    return;
  }
  mockReadMeta.mockResolvedValue({
    name: 'kub',
    project: 'p',
    rcVersion: '8.5.1',
    rcImage: 'i',
    mongoTag: '8.0',
    mongoFlavor: 'official',
    preset: 'default',
    rootUrl: 'http://localhost:3131',
    hostPort: 3131,
    versionSource: 'x',
    pinned: false,
    createdAt: '',
    publicUrl: '',
    adminPassword: '',
    extra: { runtime: 'kubernetes', namespace: 'houston-kub', release: 'rocketchat' },
  });
  mockKubernetesState.mockResolvedValue('running');
  mockPodRows.mockResolvedValue([
    {
      service: 'rocketchat-ddp-streamer-x',
      state: 'running',
      status: '',
      health: '',
      app: false,
      blocked: false,
      restarts: 3,
      started: '',
    },
    {
      service: 'rocketchat-rocketchat-y',
      state: 'running',
      status: '',
      health: 'healthy',
      app: true,
      blocked: false,
      restarts: 1,
      started: '',
    },
  ]);
  expect((await realPayload.detail('kub')).restarts).toBe(1);
}

async function exerciseKubernetesPane(name: string, page: Page): Promise<void> {
  await openWorkspace(page);
  await page.locator('#actpane .aplist, #actpane .apn').first().waitFor({ state: 'visible' });
  const pane = await paneState(page);
  if (name === 'the action pane leads with what this state admits') {
    expect(pane.next.map((item) => item[0])).toEqual(['Add sample data', 'Send an API call']);
    expect(pane.next[0]?.[1]).toBe('Add sample data');
    expect(pane.groups.slice(0, 2)).toEqual(['Next, probably', 'Everything else']);
    expect(pane.rest.map((item) => item[0])).not.toEqual(
      expect.arrayContaining(['Add sample data', 'Send an API call']),
    );
    await page.locator('#actpane .apn').first().click();
    await page.locator('#seed-dialog[open]').waitFor({ state: 'visible' });
    return;
  }
  const labels = [...pane.rest.map((item) => item[0]), ...pane.next.map((item) => item[0])];
  expect(labels).not.toEqual(
    expect.arrayContaining(['Run a load test', 'Find capacity', 'Check the certificate']),
  );
  expect(await page.locator('#actpane').textContent()).toContain('Docker-only');
}

async function exerciseKubernetesPanel(name: string, page: Page): Promise<void> {
  const target = name === 'the narrow layout is a picker a panel and a bar' ? 'ws-2' : 't1234';
  if (name === 'the narrow layout is a picker a panel and a bar')
    await page.setViewportSize({ width: 430, height: 780 });
  await openWorkspace(page, target);
  if (name === 'the panel leads with what is wrong and what to do') {
    const tri = page.locator('#detail .triage .tri');
    await tri.waitFor({ state: 'visible' });
    expect(await tri.locator('.tri-t b').textContent()).toBe('Rocket.Chat has restarted 4×');
    expect(await tri.locator('.tri-t span').textContent()).toContain('memory pressure');
    expect((await tri.locator('.tri-a button').allTextContents())[0]).toBe('Open the logs');
    expect(
      await page.evaluate(() => {
        const triage = document.querySelector('#detail .triage');
        const tabs = document.querySelector('#detail .tabs');
        return (
          triage !== null &&
          tabs !== null &&
          Boolean(triage.compareDocumentPosition(tabs) & Node.DOCUMENT_POSITION_FOLLOWING)
        );
      }),
    ).toBe(true);
    expect(await page.locator('#detail .triage .tri').count()).toBe(1);
    await tri.locator('.tri-a button').first().click();
    await page.locator('button.tab.active', { hasText: 'Logs' }).waitFor({ state: 'visible' });
    return;
  }
  if (name === 'a down workspace is told what it still holds') {
    const why = (await page.locator('#detail .triage .tri-t span').textContent()) ?? '';
    expect(why).toContain(':3001');
    expect(why).toContain('data volume');
    expect(await page.locator('#detail .triage .tri-a button').textContent()).toBe('Bring it up');
    return;
  }
  if (name === 'a pod that cannot start is named in the panel') {
    const tri = page.locator('#detail .triage .tri');
    await tri.waitFor({ state: 'visible' });
    expect(await tri.locator('.tri-t b').textContent()).toBe('One pod cannot start');
    const why = (await tri.locator('.tri-t span').textContent()) ?? '';
    expect(why).toContain('rocketchat-0 — ImagePullBackOff');
    expect(why).not.toContain('mongodb-0');
    await tri.locator('.tri-a button').click();
    await page.locator('#d-body .dtable').waitFor({ state: 'visible' });
    return;
  }
  if (name === 'the narrow layout is a picker a panel and a bar') {
    await page.waitForTimeout(250);
    const fit = await page.evaluate(() => {
      const rows = document.querySelector('#repros') as HTMLElement;
      const chips = [...rows.querySelectorAll('.wrow')];
      return {
        sideways: document.body.scrollWidth > innerWidth + 2,
        railHeight: Math.round(rows.getBoundingClientRect().height),
        oneRow: new Set(chips.map((c) => Math.round(c.getBoundingClientRect().top))).size === 1,
        railScrolls: rows.scrollWidth > rows.clientWidth + 2,
        sticky: getComputedStyle(document.querySelector('#detail .d-actions') as Element).position,
        pane: getComputedStyle(document.querySelector('#actpane') as Element).display,
        toggle: getComputedStyle(document.querySelector('.panetoggle') as Element).display,
      };
    });
    expect(fit.sideways).toBe(false);
    expect(fit.oneRow).toBe(true);
    expect(fit.railHeight).toBeLessThanOrEqual(60);
    expect(fit.railScrolls).toBe(true);
    expect(fit.sticky).toBe('sticky');
    expect(fit.pane).toBe('none');
    expect(fit.toggle).not.toBe('none');
    const pinned = await page.evaluate(() => {
      const bar = document.querySelector('#detail .d-actions')?.getBoundingClientRect();
      const panel = document.querySelector('#detail')?.getBoundingClientRect();
      return {
        gap: bar === undefined ? Number.POSITIVE_INFINITY : Math.round(innerHeight - bar.bottom),
        taller: panel !== undefined && panel.height > innerHeight,
      };
    });
    expect(pinned.taller).toBe(true);
    expect(pinned.gap).toBeLessThanOrEqual(2);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(200);
    expect(
      await page.locator('#detail .d-actions').evaluate((element) => {
        const bar = element.getBoundingClientRect();
        return bar.bottom > 0 && bar.top < innerHeight;
      }),
    ).toBe(true);
    await page.locator('#detail .panetoggle').click();
    await page.locator('#actpane .apdanger').waitFor({ state: 'visible' });
    return;
  }
  if (name === 'a sidecar that keeps restarting is a fault on kubernetes') {
    await page.locator('#detail .tabs').waitFor({ state: 'visible' });
    expect(await page.locator('#detail .triage .tri').count()).toBe(0);
    expect(await mockDetail('t1234')).toHaveProperty('containers');
    return;
  }
  await page.locator('#detail .triage .tri').waitFor({ state: 'visible' });
  expect(await page.locator('#detail .triage .tri-t b').allTextContents()).toEqual([
    'rocketchat-ddp-streamer-768f896d7-rpcw9 keeps restarting',
  ]);
}

async function exerciseKubernetesRail(name: string, page: Page): Promise<void> {
  if (name === 'a log stream a restart ends follows the new pod by itself') {
    // Somebody else restarts the workspace: `kubectl logs -f` ends with the old pod. The
    // reader's panel did not redraw, so it sat on "stream ended" until Retry was pressed.
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Logs', exact: true }).click();
    await page.locator('#logview', { hasText: 'pod 1 says hello' }).waitFor({ state: 'visible' });
    await page
      .locator('#logview', { hasText: 'pod 2 says hello' })
      .waitFor({ state: 'visible', timeout: 8000 });
    expect(mockLogProcess).toHaveBeenCalledTimes(2);
    expect(await page.locator('#log-stat').textContent()).toBe('streaming');
    // What the first pod said is still on screen above what the new one says.
    expect(await page.locator('#logview .logrow .lm').allTextContents()).toEqual([
      'pod 1 says hello',
      'pod 2 says hello',
    ]);
    return;
  }
  if (name.startsWith('the env tab')) {
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Env vars' }).click();
    if (name.includes('refusal')) {
      await page.waitForFunction(() =>
        document.querySelector('#d-body')?.textContent.includes('no Rocket.Chat pod'),
      );
      return;
    }
    await page.waitForFunction(() =>
      document.querySelector('#d-body')?.textContent.includes('ROOT_URL'),
    );
    const body = (await page.locator('#d-body').textContent()) ?? '';
    if (name.includes('kubernetes')) {
      expect(body).toContain('MY_FLAG');
      expect(body).toContain('MONGO_URL');
      expect(body).not.toContain('Set + restart');
      expect(body).toContain('helm -n houston-t1234 upgrade');
      expect(await page.locator('#d-body button.danger').count()).toBe(0);
    } else {
      expect(body).toContain('Set + restart');
      expect(await page.locator('#d-body button.danger').count()).toBeGreaterThan(0);
    }
    return;
  }
  if (name === 'the containers tab shows pods and says so on kubernetes') {
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Containers' }).click();
    await page.locator('#d-body table.dtable').waitFor({ state: 'visible' });
    const body = (await page.locator('#d-body').textContent()) ?? '';
    expect(body).toContain('rocketchat-mongodb-0');
    expect(body).toContain('ImagePullBackOff');
    expect(body).not.toContain('No containers');
    expect(body).toContain('Pods, not containers');
    expect(await page.locator('#d-body table.dtable th').first().textContent()).toBe('pod');
    return;
  }
  if (name === 'the live chart stops asking when the answer is a refusal') {
    await openWorkspace(page);
    await page.waitForFunction(() =>
      document.querySelector('#chart')?.textContent.includes('metrics-server'),
    );
    const timer = await page.evaluate(async (source) => {
      const load = new Function('name', 'return import(name)') as (
        name: string,
      ) => Promise<Record<string, unknown>>;
      return ((await load(source)).ctx as { dstate: { statsTimer: unknown } }).dstate.statsTimer;
    }, '/js/shared.js');
    expect(timer).toBeNull();
    // ASKED ONCE PER SELECTION. Each re-render of the overview started the chart again, and
    // a Kubernetes panel re-renders as its pods change: a 409 on every one of them.
    const asked = mockPodMetrics.mock.calls.length;
    for (const tab of ['Containers', 'Overview', 'Containers', 'Overview']) {
      await page
        .locator('#detail .tab')
        .filter({ hasText: new RegExp(`^${tab}$`, 'u') })
        .click();
    }
    await page.waitForFunction(() =>
      document.querySelector('#chart')?.textContent.includes('metrics-server'),
    );
    expect(mockPodMetrics.mock.calls.length).toBe(asked);
    return;
  }
  if (name === 'a credential note is not labelled a sudo setup step') {
    await openWorkspace(page);
    const body = (await page.locator('#d-body').textContent()) ?? '';
    expect(body).toContain('cn=admin,dc=example,dc=com');
    expect(body).not.toContain('Needs sudo');
    // The header's "About this scenario" link keeps `.linkbtn`'s small size: the wizard's
    // later `.linkbtn { font: inherit }` rendered it full size and bold.
    const link = await page.locator('#d-body .panelcard-h .linkbtn').evaluate((el) => {
      const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const style = getComputedStyle(el);
      return { rem: parseFloat(style.fontSize) / root, weight: style.fontWeight };
    });
    expect(link.rem).toBeCloseTo(0.74, 2);
    expect(link.weight).toBe('400');
    return;
  }
  if (name === 'the one preset with a real setup step keeps it') {
    await openWorkspace(page);
    const setup = page.locator('#d-body .setup');
    await setup.waitFor({ state: 'visible' });
    expect(await setup.textContent()).toContain('127.0.0.1  keycloak');
    expect(await setup.textContent()).toContain('Needs sudo');
    return;
  }
  if (name === 'the three panes survive a narrow window') {
    await openWorkspace(page);
    for (const width of [1440, 1024, 768, 640, 480, 380]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      const measured = await page.evaluate(() => {
        const rail = document.querySelector('.rail')?.getBoundingClientRect();
        const stage = document.querySelector('#detail')?.getBoundingClientRect();
        if (rail === undefined || stage === undefined)
          return { over: true, width: 0, overlap: true };
        return {
          over: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          width: Math.round(stage.width),
          overlap:
            Math.round(Math.min(rail.bottom, stage.bottom) - Math.max(rail.top, stage.top)) > 2 &&
            Math.round(Math.min(rail.right, stage.right) - Math.max(rail.left, stage.left)) > 2,
        };
      });
      expect(measured.over).toBe(false);
      expect(measured.width).toBeGreaterThanOrEqual(320);
      expect(measured.overlap).toBe(false);
    }
    return;
  }
  if (name === 'a note that ends in a name is not glued to the next one') {
    await openWorkspace(page);
    const paragraphs = await page.locator('#d-body .note-p').allTextContents();
    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]?.trim().endsWith('houston-x')).toBe(true);
    expect(paragraphs[0]).not.toContain('StatefulSet');
    return;
  }
  if (name === 'a genuinely wrapped note still joins the line after it') {
    await openWorkspace(page);
    const paragraphs = await page.locator('#d-body .note-p').allTextContents();
    expect(
      paragraphs.some((text) => text.includes('host entry') && text.includes('/etc/hosts')),
    ).toBe(true);
    return;
  }
  if (name === 'a long line in a note scrolls instead of being clipped away') {
    await openWorkspace(page);
    await page.locator('#d-body .note-cmd').waitFor({ state: 'visible' });
    const measured = await page.evaluate(() => {
      const card = document.querySelector('#d-body .panelcard') as HTMLElement;
      const box = document.querySelector('#d-body .note-cmd') as HTMLElement;
      const code = box.querySelector('code') as HTMLElement;
      return {
        cardOver: card.scrollWidth > card.clientWidth + 2,
        boxOver: box.scrollWidth > box.clientWidth + 2,
        codeScrolls: code.scrollWidth > code.clientWidth,
        overflowX: getComputedStyle(code).overflowX,
        whiteSpace: getComputedStyle(code).whiteSpace,
      };
    });
    expect(measured.cardOver).toBe(false);
    expect(measured.boxOver).toBe(false);
    expect(measured.codeScrolls).toBe(true);
    expect(measured.overflowX).toBe('auto');
    expect(measured.whiteSpace).toBe('pre');
    return;
  }
  if (name === 'a grouped note gets its own card with a fact table and a copy button') {
    await openWorkspace(page);
    await page.locator('#d-body .notetable').waitFor({ state: 'visible' });
    const measured = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#d-body .panelcard')];
      const titled = (title: string) =>
        cards.find((card) => card.querySelector('.section-label')?.textContent === title);
      const kube = titled('Kubernetes');
      const forward = titled('Port forward');
      return {
        rows:
          kube !== undefined
            ? [...kube.querySelectorAll('tr')].map((row) => [
                row.querySelector('th')?.textContent,
                row.querySelector('td')?.textContent,
              ])
            : null,
        command: forward?.querySelector('.note-cmd code')?.textContent,
        copy: Boolean(forward?.querySelector('.note-cmd .cp')),
        prose: forward?.textContent.includes('dies with the pod'),
        flat: cards.some((card) => card.textContent.includes('Cluster  x')),
      };
    });
    expect(measured.rows).toEqual([
      ['Cluster', 'kind-houston-local'],
      ['Namespace', 'houston-t1234'],
      ['Arrangement', 'microservices'],
    ]);
    expect(measured.command).toBe('kubectl -n houston-t1234 port-forward deployment/rc 3001:3000');
    expect(measured.copy).toBe(true);
    expect(measured.prose).toBe(true);
    expect(measured.flat).toBe(false);
    return;
  }
  if (name === 'the overview says which runtime the workspace runs on') {
    await openWorkspace(page);
    const cells = await page
      .locator('#d-body .kv-grid .kv')
      .evaluateAll((nodes) =>
        nodes.map((node) => [
          node.querySelector('.k')?.textContent ?? '',
          node.querySelector('.v')?.textContent ?? '',
        ]),
      );
    expect(Object.fromEntries(cells)['Runs on']).toBe('Kubernetes · microservices');
    expect(cells).toHaveLength(6);
    return;
  }
  if (name === 'the panel is not a two hundred pixel window on a narrow screen') {
    await openWorkspace(page);
    await page.locator('#d-body .panelcard').first().waitFor({ state: 'visible' });
    await page.setViewportSize({ width: 520, height: 900 });
    await page.waitForTimeout(300);
    const measured = await page.evaluate(() => {
      const stage = document.querySelector('.stage') as HTMLElement;
      const cards = [...document.querySelectorAll('#d-body .panelcard')];
      const last = cards.at(-1)?.getBoundingClientRect();
      const status = document.querySelector('.statusbar')?.getBoundingClientRect();
      return {
        pageScrolls: document.documentElement.scrollHeight > innerHeight,
        sideways: document.body.scrollWidth > innerWidth + 2,
        hidden: stage.scrollHeight - stage.clientHeight,
        cells: document.querySelectorAll('#d-body .kv-grid .kv').length,
        cards: cards.length,
        clear: last !== undefined && status !== undefined && last.bottom <= status.top + 2,
      };
    });
    expect(measured.pageScrolls).toBe(true);
    expect(measured.sideways).toBe(false);
    expect(measured.hidden).toBeLessThanOrEqual(2);
    expect(measured.cells).toBe(6);
    expect(measured.cards).toBeGreaterThanOrEqual(9);
    expect(measured.clear).toBe(true);
    await page.setViewportSize({ width: 380, height: 900 });
    await page.waitForTimeout(200);
    const tabs = await page.evaluate(() => {
      const strip = document.querySelector('.tabs') as HTMLElement;
      const items = [...strip.querySelectorAll('.tab')];
      strip.scrollLeft = strip.scrollWidth;
      const last = items.at(-1)?.getBoundingClientRect();
      const rect = strip.getBoundingClientRect();
      return {
        scrolls: strip.scrollWidth > strip.clientWidth,
        reachable: last !== undefined && last.right <= rect.right + 2 && last.left >= rect.left - 2,
        sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    expect(tabs.sideways).toBe(false);
    expect(tabs.scrolls).toBe(true);
    expect(tabs.reachable).toBe(true);
    return;
  }
  if (name === 'a place a group names is the link row and not a second row') {
    await openWorkspace(page);
    await page.locator('#d-body .linkrow').first().waitFor({ state: 'visible' });
    const body = page.locator('#d-body');
    const rows = await body.locator('.linkrow').allTextContents();
    expect(rows.filter((row) => row.includes('localhost:5050'))).toHaveLength(1);
    expect(rows.some((row) => row.includes('admin/admin'))).toBe(true);
    expect(await body.textContent()).toContain('auto-provisioned');
    return;
  }
  if (name === 'a healthy workspace gets no triage block at all') {
    await openWorkspace(page);
    await page.locator('#d-body .kv-grid').waitFor({ state: 'visible' });
    expect(await page.locator('#detail .triage').count()).toBe(0);
    return;
  }
  if (name === 'the rail groups by what each workspace wants from you') {
    await page.locator('#repros .rgrp').first().waitFor({ state: 'visible' });
    const groups = await page.evaluate(() => {
      const out: Array<{ title: string; count: string; rows: string[] }> = [];
      let group: { title: string; count: string; rows: string[] } | null = null;
      for (const child of document.querySelector('#repros')?.children ?? []) {
        if (child.classList.contains('rgrp')) {
          group = {
            title: child.querySelector('.rgrp-t')?.textContent ?? '',
            count: child.querySelector('.rgrp-n')?.textContent ?? '',
            rows: [],
          };
          out.push(group);
        } else if (group !== null) group.rows.push(child.querySelector('.nm')?.textContent ?? '');
      }
      return out;
    });
    expect(groups.map((group) => group.title)).toEqual(['Wants you', 'Running', 'Not running']);
    expect(groups.map((group) => group.count)).toEqual(['2', '1', '2']);
    expect(groups.map((group) => group.rows)).toEqual([
      ['aa-loop', 'bb-sick'],
      ['cc-fine'],
      ['dd-stopped', 'ee-down'],
    ]);
    return;
  }
  if (name === 'one state gets no group headings') {
    expect(await page.locator('#repros .rgrp').count()).toBe(0);
    expect(await page.locator('#repros .wrow').count()).toBe(3);
    const titles = await page.evaluate(async (source) => {
      const load = new Function('name', 'return import(name)') as (
        name: string,
      ) => Promise<Record<string, unknown>>;
      const railGroups = (await load(source)).railGroups as (
        rows: Array<{ state: string }>,
      ) => unknown[][];
      return [
        railGroups([{ state: 'running' }, { state: 'running' }]).map(
          (group: unknown[]) => group[0],
        ),
        railGroups([{ state: 'running' }, { state: 'stopped' }]).map(
          (group: unknown[]) => group[0],
        ),
      ];
    }, '/js/api.js');
    expect(titles).toEqual([
      ['', '', ''],
      ['Wants you', 'Running', 'Not running'],
    ]);
    return;
  }
  if (name === 'a long workspace name does not push the rail sideways') {
    for (const width of [1440, 430]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      const measured = await page.evaluate(() => {
        const rows = document.querySelector('#repros') as HTMLElement;
        return {
          sideways: rows.scrollWidth > rows.clientWidth + 1,
          inside: [...rows.querySelectorAll<HTMLElement>('.wrow')].every(
            (row) => row.scrollWidth <= row.clientWidth + 1,
          ),
          title: rows.querySelector('.wrow')?.getAttribute('title'),
        };
      });
      if (width > 760) expect(measured.sideways).toBe(false);
      expect(measured.inside).toBe(true);
      expect(measured.title).toBe('a-really-long-workspace-name-for-ticket-4821');
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const meta = await page
      .locator('.wrow', { hasText: 'dana-upgrade' })
      .locator('.meta')
      .innerText();
    expect(meta).toContain(':3001');
    expect(meta).toContain('alice');
    expect(meta).toContain('monitored');
    return;
  }
  if (
    name === 'a seeded workspace is not told to seed itself' ||
    name === 'nothing is suggested for a workspace that is not running'
  ) {
    await openWorkspace(page);
    const pane = await paneState(page);
    if (name.startsWith('a seeded')) {
      expect(pane.next.map((item) => item[0])).toEqual(['Send an API call', 'Back up now']);
      expect(pane.rest.map((item) => item[0])).toContain('Add sample data');
    } else {
      expect(pane.next).toEqual([]);
      expect(pane.groups[0]).toBe('What you can do with it');
      expect(pane.note).toContain('need the workspace running');
      expect(Object.fromEntries(pane.rest)['Add sample data']).toBe(true);
      expect(Object.fromEntries(pane.rest)['Use for CLI commands']).toBe(false);
    }
    return;
  }
  if (name === 'a kubernetes log line is split by pod like a compose one') {
    const parsed = await page.evaluate(async (source) => {
      const load = new Function('name', 'return import(name)') as (
        name: string,
      ) => Promise<Record<string, unknown>>;
      const module = await load(source);
      const parseLogLine = module.parseLogLine as (line: string) => Record<string, unknown>;
      const logRow = module.logRow as (row: Record<string, unknown>) => HTMLElement;
      const rows = [
        parseLogLine(
          '[pod/rocketchat-presence-7ffb7dc6f7-7v88f/presence-service] NetworkBroker started successfully.',
        ),
        parseLogLine(
          '[pod/rocketchat-rocketchat-579c867b87-mclgv/rocketchat] {"level":50,"time":1755600000000,"msg":"You have not provided a mail URL."}',
        ),
        parseLogLine('rocketchat-1  | {"level":30,"time":1755600000000,"msg":"started"}'),
      ];
      const rendered = logRow(
        parseLogLine('[pod/rocketchat-ddp-streamer-768f896d7-2r7w7/ddp-streamer] hello'),
      );
      const cell = rendered.querySelector('.ls');
      return {
        rows,
        cell: [
          cell?.textContent,
          cell?.getAttribute('title'),
          rendered.querySelector('.lm')?.textContent,
        ],
      };
    }, '/js/logs.js');
    expect(parsed.rows[0]).toMatchObject({
      service: 'presence',
      msg: 'NetworkBroker started successfully.',
      pod: 'rocketchat-presence-7ffb7dc6f7-7v88f',
    });
    expect(parsed.rows[1]).toMatchObject({
      service: 'rocketchat',
      level: 'error',
      msg: 'You have not provided a mail URL.',
      pod: 'rocketchat-rocketchat-579c867b87-mclgv',
    });
    expect(parsed.rows[2]).toMatchObject({ service: 'rocketchat', msg: 'started' });
    expect(parsed.cell).toEqual([
      'ddp-streamer',
      'rocketchat-ddp-streamer-768f896d7-2r7w7',
      'hello',
    ]);
    return;
  }
  if (name === 'a note paragraph is as wide as the card it is in') {
    await openWorkspace(page);
    await page.locator('#d-body .note-cmd').waitFor({ state: 'visible' });
    for (const width of [1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(200);
      const measured = await page.evaluate(() => {
        const card = [...document.querySelectorAll<HTMLElement>('#d-body .panelcard')].find(
          (node) => node.textContent.includes('own kubeconfig'),
        );
        const size = (selector: string) =>
          Math.round(card?.querySelector(selector)?.getBoundingClientRect().width ?? 0);
        return { paragraph: size('.note-p'), command: size('.note-cmd') };
      });
      expect(Math.abs(measured.paragraph - measured.command)).toBeLessThanOrEqual(2);
    }
    return;
  }
  if (name === 'a restart count that climbs is a fault even while ready') {
    const values = [];
    for (const count of [3, 3, 4, 4])
      values.push(await browserImport(page, '/js/util.js', 'restartsClimbing', 'w', 'pod', count));
    expect(values).toEqual([false, false, true, false]);
    return;
  }
  if (name === 'the gui has exactly one jobActive and the page parses') {
    const source = fs.readFileSync(path.resolve('data/webui/js/util.js'), 'utf8');
    expect(source.match(/const jobActive/gu)).toHaveLength(1);
    const exported = await page.evaluate(
      async ({ utilSource, jobsSource }) => {
        const load = new Function('name', 'return import(name)') as (
          name: string,
        ) => Promise<Record<string, unknown>>;
        const util = await load(utilSource);
        const jobs = await load(jobsSource);
        return [typeof util.jobActive, typeof jobs.pollJobUntilDone, typeof util.apiForm];
      },
      { utilSource: '/js/util.js', jobsSource: '/js/jobs.js' },
    );
    expect(exported).toEqual(['function', 'function', 'function']);
    return;
  }
  const source = await page.evaluate(async (specifier) => {
    const load = new Function('name', 'return import(name)') as (
      name: string,
    ) => Promise<Record<string, unknown>>;
    return ((await load(specifier)).startStats as () => unknown).toString();
  }, '/js/logs.js');
  expect(source).toContain('inFlight');
  expect(source).toContain('asked !== ctx.SELECTED');
  expect(source).toContain('finally');
}

async function openCreate(page: Page): Promise<void> {
  await page.locator('#btn-new').click({ timeout: 5000 });
  await page.locator('#create-dialog[open]').waitFor({ state: 'visible', timeout: 5000 });
}

/** Type the version, submit, and let the create's job stream finish before the case ends. */
async function submitTheCreate(page: Page, version: string): Promise<void> {
  await page.locator('#create-form input[name=version]').fill(version);
  await page.locator('#create-submit').click();
  for (let n = 0; n < 40 && mockCreateRepro.mock.calls.length === 0; n += 1)
    await page.waitForTimeout(100);
  await page.waitForFunction(() =>
    /is ready|could not be created/u.test(
      document.querySelector('#create-progress-title')?.textContent ?? '',
    ),
  );
}

/** Close the dialog from step 2, which offers Back rather than Cancel: its ✕. */
async function closeTheCreate(page: Page): Promise<void> {
  await page.locator('#create-x').click({ timeout: 5000 });
  await page.waitForFunction(
    () => !(document.querySelector('#create-dialog') as HTMLDialogElement).open,
  );
}

async function exerciseSurface(name: string, page: Page): Promise<void> {
  if (name === 'the dashboard renders a workspace card') {
    await page.locator('#repros', { hasText: 't1234' }).waitFor({ state: 'visible' });
    expect(await page.locator('#repros').textContent()).toContain('t1234');
    return;
  }
  if (name === "a directory workspace's notes read as points, with its login on the place row") {
    // Wrapped prose indented by four spaces was read as things to paste: one sentence became
    // five Copy boxes in the scenario card, and the DN to log in with sat in a box of its own.
    await openWorkspace(page);
    await page.locator('#d-body .note-p').first().waitFor({ state: 'visible' });
    expect(await page.locator('#d-body .note-cmd').count()).toBe(0);
    const points = await page.locator('#d-body .note-p').allInnerTexts();
    expect(points.some((p) => p.includes('sAMAccountName') && p.includes('objectGUID'))).toBe(true);
    expect(points.some((p) => p.startsWith('Groups:') && p.includes('#employees at login'))).toBe(
      true,
    );
    expect(
      await page.locator('#d-body .linkrow .l-sub', { hasText: 'log in with DN' }).count(),
    ).toBe(1);
    return;
  }
  if (name === 'a card with a long name and a long preset list stays inside its box') {
    // A grid track is at least as wide as its widest unbreakable text: a preset list with no
    // space in it pushed the version and the age past the card's edge.
    const card = page.locator('.wrow').first();
    await card.waitFor({ state: 'visible' });
    const box = await card.evaluate((node) => {
      const right = (sel: string): number =>
        node.querySelector(sel)?.getBoundingClientRect().right ?? 0;
      return {
        overflow: node.scrollWidth - node.clientWidth,
        edge: node.getBoundingClientRect().right,
        ver: right('.ver'),
        age: right('.wage'),
        meta: right('.meta'),
      };
    });
    expect(box.overflow).toBe(0);
    expect(box.ver).toBeLessThanOrEqual(box.edge);
    expect(box.age).toBeLessThanOrEqual(box.edge);
    expect(box.meta).toBeLessThanOrEqual(box.edge);
    return;
  }
  if (
    name === 'take down keeps the data, delete asks for the name, and both say what they remove'
  ) {
    // One "Take this workspace down" behind two browser confirm boxes left stop, down and
    // delete for the reader to tell apart, and the second box read Cancel as "keep the data".
    // Now two buttons at the pane's foot, apart from Stop, each saying what it removes, behind
    // one dialog; Delete is enabled once the name is typed.
    let boxes = 0;
    page.on('dialog', (dialog) => {
      boxes += 1;
      void dialog.dismiss();
    });
    await openWorkspace(page);
    const foot = page.locator('#actpane .apdanger');
    await foot.waitFor({ state: 'visible' });
    expect(await foot.locator('button').allInnerTexts()).toEqual([
      'Take down…',
      'Delete workspace…',
    ]);
    expect(await foot.locator('p').allInnerTexts()).toEqual([
      'Removes its containers and keeps its data. Bring up starts it again.',
      'Deletes it with its data and record. This cannot be undone.',
    ]);
    expect(await page.locator('#detail .d-actions', { hasText: 'Take down' }).count()).toBe(0);
    const finished = async (): Promise<void> => {
      await page.waitForFunction(
        () => document.querySelector('#job-title')?.textContent === 'Done',
      );
      await page.locator('#job-close').click();
    };
    // Take down: no name to type, and the data is kept.
    await foot.getByRole('button', { name: 'Take down…' }).click();
    await page.locator('#down-dialog[open]').waitFor({ state: 'visible' });
    expect(await page.locator('#down-title').textContent()).toBe('Take t1234 down?');
    expect(await page.locator('#down-what').textContent()).toContain(
      'Its data and record are kept',
    );
    expect(await page.locator('#down-typed').isHidden()).toBe(true);
    await page.locator('#down-go').click();
    await finished();
    expect(mockTeardown).toHaveBeenLastCalledWith(
      't1234',
      expect.objectContaining({ volumes: false, confirm: false }),
    );
    // Delete: refused until the name is typed exactly.
    await foot.getByRole('button', { name: 'Delete workspace…' }).click();
    await page.locator('#down-dialog[open]').waitFor({ state: 'visible' });
    expect(await page.locator('#down-title').textContent()).toBe('Delete t1234?');
    const go = page.locator('#down-go');
    expect(await go.isDisabled()).toBe(true);
    await page.locator('#down-input').fill('t123');
    expect(await go.isDisabled()).toBe(true);
    // Enter submits the form: a wrong name leaves the dialog open with nothing done, and the
    // right one deletes, where the dialog used to close and do nothing at all.
    await page.locator('#down-input').press('Enter');
    expect(await page.locator('#down-dialog[open]').count()).toBe(1);
    await page.locator('#down-input').fill('t1234');
    expect(await go.isEnabled()).toBe(true);
    await page.locator('#down-input').press('Enter');
    await finished();
    expect(mockTeardown).toHaveBeenLastCalledWith(
      't1234',
      expect.objectContaining({ volumes: true, confirm: true }),
    );
    expect(boxes).toBe(0);
    return;
  }
  if (name === "a combined workspace's scenario card is a guide per preset behind tabs") {
    // Seven presets' notes were one wall of paragraphs; the card now shows the places as
    // before, then one preset's guide at a time, the card's height the same for each.
    await openWorkspace(page);
    const tabs = page.locator('#d-body .guide-tabs button');
    await tabs.first().waitFor({ state: 'visible' });
    expect(await tabs.allInnerTexts()).toEqual([
      'e2ee',
      'email',
      'ldap',
      'livechat',
      'oidc',
      's3_minio',
      'voice',
    ]);
    expect(await page.locator('#d-body .guide-tabs button[aria-selected=true]').innerText()).toBe(
      'e2ee',
    );
    expect(await page.locator('#d-body .guide-pane .notetable tr').count()).toBe(3);
    expect(await page.locator('#d-body .note-p').count()).toBe(0);
    expect(await page.locator('#d-body .linkrow').count()).toBeGreaterThanOrEqual(6);
    await page.waitForTimeout(150);
    const card = page.locator('#d-body .panelcard', { has: page.locator('.guide-tabs') });
    const height = async (): Promise<number> =>
      await card.evaluate((node) => Math.round(node.getBoundingClientRect().height));
    const before = await height();
    await page.locator('#d-body .guide-tabs button[data-tab=oidc]').click();
    await page.waitForTimeout(250);
    // innerText folds the entry's two spaces into one; the copy button gets the line itself.
    expect(await page.locator('#d-body .guide-pane .setup code').innerText()).toMatch(
      /^127\.0\.0\.1\s+keycloak$/u,
    );
    expect(Math.abs((await height()) - before)).toBeLessThanOrEqual(1);
    await page.locator('#d-body .guide-tabs button[data-tab=oidc]').press('End');
    await page.waitForTimeout(250);
    expect(await page.locator('#d-body .guide-tabs button[aria-selected=true]').innerText()).toBe(
      'voice',
    );
    return;
  }
  if (name === 'the detail panel opens and switches tabs') {
    await openWorkspace(page);
    expect(await page.locator('#detail').textContent()).toContain('7.4.1');
    await page.getByRole('button', { name: 'Containers', exact: true }).click();
    await page.locator('#d-body', { hasText: 'rocketchat' }).waitFor({ state: 'visible' });
    return;
  }
  if (name === 'the log viewer streams container output') {
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Logs', exact: true }).click();
    for (let attempt = 0; attempt < 30 && mockComposeStream.mock.calls.length === 0; attempt += 1)
      await page.waitForTimeout(100);
    expect(mockComposeStream).toHaveBeenCalled();
    await page
      .locator('#logview', { hasText: 'line 4' })
      .waitFor({ state: 'visible', timeout: 10_000 });
    expect(await page.locator('#logview .logrow .lm').allTextContents()).toEqual([
      'line 0',
      'line 1',
      'line 2',
      'line 3',
      'line 4',
    ]);
    return;
  }
  if (name === 'the backups tab lists what is there') {
    await openWorkspace(page);
    await page.locator('#detail .tab', { hasText: 'Backups' }).click();
    await page.locator('#d-body', { hasText: 't1234-2026-08-09' }).waitFor({ state: 'visible' });
    expect(await page.locator('#d-body').textContent()).toContain('7.4.1');
    expect(mockListBackups).toHaveBeenCalledWith('t1234');
    return;
  }
  if (name === 'a readonly user is offered nothing in the detail panel either') {
    await openWorkspace(page);
    expect(await page.locator('.d-actions').textContent()).toContain('readonly');
    for (const label of ['Make default', 'Down', 'Stop', 'Restart', 'Load test']) {
      expect(await page.locator('.d-actions button', { hasText: label }).count()).toBe(0);
    }
    expect(await page.locator('.d-actions a', { hasText: 'Open RC' }).count()).toBe(1);
    return;
  }
  if (name === 'nothing in the page is painted a hardcoded dark colour') {
    for (const selector of ['body', '.topbar', '.statusbar']) {
      const colour = await page.locator(selector).evaluate((element) => {
        return getComputedStyle(element).backgroundColor;
      });
      const channels = colour.match(/\d+/gu)?.slice(0, 3).map(Number) ?? [];
      expect(channels).toHaveLength(3);
      expect(channels.reduce((sum, value) => sum + value, 0) / 3).toBeGreaterThan(150);
    }
    return;
  }
  if (name === 'no control is hidden behind the status bar') {
    const bar = await page.locator('.statusbar').evaluate((element) => {
      return element.getBoundingClientRect().top;
    });
    for (const selector of ['#btn-prune', '#btn-new', '#filter']) {
      const bottom = await page.locator(selector).evaluate((element) => {
        return element.getBoundingClientRect().bottom;
      });
      expect(bottom).toBeLessThanOrEqual(bar + 1);
    }
    return;
  }
  if (name === 'the one button a screen is asking for carries the accent') {
    const got = await page.locator('#btn-new').evaluate((element) => {
      const styles = getComputedStyle(element);
      const root = getComputedStyle(document.documentElement);
      const swatch = (value: string): string => {
        const sample = document.createElement('div');
        sample.style.color = value.trim();
        document.body.append(sample);
        const colour = getComputedStyle(sample).color;
        sample.remove();
        return colour;
      };
      return {
        bg: styles.backgroundColor,
        accent: swatch(root.getPropertyValue('--accent-fill')),
        ink: swatch(root.getPropertyValue('--ink')),
        shadow: styles.boxShadow,
      };
    });
    expect(got.bg).toBe(got.accent);
    expect(got.bg).not.toBe(got.ink);
    expect(got.shadow).not.toBe('none');
    return;
  }
  if (name === 'a burst of log lines costs one layout not one per line') {
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Logs', exact: true }).click();
    await page.locator('#logview').waitFor({ state: 'visible' });
    const got = await page.evaluate(async () => {
      const load = new Function('name', 'return import(name)') as (
        specifier: string,
      ) => Promise<Record<string, unknown>>;
      const shared = (await load('/js/shared.js')) as unknown as {
        ctx: { logv: { buf: unknown[] } };
      };
      const logs = (await load('/js/logs.js')) as unknown as {
        queueLog: (row: unknown) => void;
      };
      const box = document.querySelector('#logview') as HTMLElement;
      let appends = 0;
      const real = box.append.bind(box);
      box.append = (...args: (Node | string)[]): void => {
        appends += 1;
        real(...args);
      };
      for (let index = 0; index < 400; index += 1) {
        const row = {
          ts: '12:00:00',
          level: 'info',
          service: 'rocketchat',
          msg: `line ${String(index)}`,
        };
        shared.ctx.logv.buf.push(row);
        logs.queueLog(row);
      }
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      return { appends, rows: box.childElementCount };
    });
    expect(got.rows).toBeGreaterThanOrEqual(400);
    expect(got.appends).toBeLessThanOrEqual(2);
    return;
  }
  if (name === 'scrolling up in the logs offers one press back to the latest') {
    await openWorkspace(page);
    await page.getByRole('button', { name: 'Logs', exact: true }).click();
    await page.locator('#logview').waitFor({ state: 'visible' });
    const feed = async (target: Page, count: number): Promise<void> => {
      await target.evaluate(async (total) => {
        const load = new Function('name', 'return import(name)') as (
          specifier: string,
        ) => Promise<Record<string, unknown>>;
        const shared = (await load('/js/shared.js')) as unknown as {
          ctx: { logv: { buf: unknown[] } };
        };
        const logs = (await load('/js/logs.js')) as unknown as {
          queueLog: (row: unknown) => void;
        };
        for (let index = 0; index < total; index += 1) {
          const row = {
            ts: '12:00:00',
            level: 'info',
            service: 'rocketchat',
            msg: `line ${String(index)}`,
          };
          shared.ctx.logv.buf.push(row);
          logs.queueLog(row);
        }
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
      }, count);
    };
    await feed(page, 200);
    expect(await page.locator('#log-jump').isHidden()).toBe(true);
    await page.locator('#logview').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.locator('#log-jump:not([hidden])').waitFor({ state: 'visible' });
    expect(
      await page.evaluate(async () => {
        const load = new Function('name', 'return import(name)') as (
          specifier: string,
        ) => Promise<Record<string, unknown>>;
        const shared = (await load('/js/shared.js')) as unknown as {
          ctx: { logv: { follow: boolean } };
        };
        return shared.ctx.logv.follow;
      }),
    ).toBe(false);
    await feed(page, 5);
    expect(await page.locator('#log-jump').innerText()).toBe('↓ 5 new');
    await page.locator('#log-jump').click();
    await page.locator('#log-jump').waitFor({ state: 'hidden' });
    expect(
      await page.locator('#logview').evaluate((element) => {
        return element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }),
    ).toBe(true);
    return;
  }
  if (name === 'reduced motion keeps every state and removes the travel') {
    const duration = await page.locator('#btn-new').evaluate((element) => {
      return getComputedStyle(element).transitionDuration;
    });
    for (const value of duration.split(',')) {
      expect(Number.parseFloat(value.trim().replace(/s$/u, ''))).toBeLessThanOrEqual(0.001);
    }
    expect(
      await page.locator('#btn-new').evaluate((element) => getComputedStyle(element).boxShadow),
    ).not.toBe('none');
    return;
  }
  if (name === 'the action pane names the thing not one of its parts') {
    await openWorkspace(page);
    const labels = await page.locator('#actpane button').allTextContents();
    expect(labels).toContain('Attach monitoring');
    expect(labels).toContain('PAT and Token');
    expect(labels.filter((value) => value.includes('Grafana') || value.includes('Mint'))).toEqual(
      [],
    );
    return;
  }
  if (name === 'the home page leads with capacity') {
    await page.locator('#detail', { hasText: 'room for' }).waitFor({ state: 'visible' });
    const body = await page.locator('#detail').textContent();
    expect(body).toContain('Room for about 1 more');
    expect(body).toContain('Memory on this server');
    return;
  }
  if (name === 'a down workspace is something home asks you about') {
    await page.locator('#detail', { hasText: 'Needs you' }).waitFor({ state: 'visible' });
    const body = await page.locator('#detail').textContent();
    expect(body).toContain('upgrade-test is down');
    expect(body).toContain('still holds port');
    await openWorkspace(page, 'upgrade-test');
    expect(await page.locator('.d-head').textContent()).toContain('upgrade-test');
    return;
  }
  if (name === 'a card is not the same colour as the thing it stands on') {
    await page.locator('#detail .hcard').first().waitFor({ state: 'visible' });
    const got = await page.evaluate(() => {
      const seen = (element: Element | null): string | null => {
        for (let node = element; node !== null; node = node.parentElement) {
          const colour = getComputedStyle(node).backgroundColor;
          if (colour !== '' && colour !== 'rgba(0, 0, 0, 0)' && colour !== 'transparent')
            return colour;
        }
        return null;
      };
      const card = document.querySelector('#detail .hcard') as HTMLElement;
      return {
        card: getComputedStyle(card).backgroundColor,
        ground: seen(document.querySelector('#detail')),
        rail: getComputedStyle(document.querySelector('.rail') as HTMLElement).backgroundColor,
      };
    });
    expect(got.card).not.toBe(got.ground);
    expect(got.rail).toBe(got.card);
    return;
  }
  if (name === 'a note that names a place joins the row that already lists it') {
    await openWorkspace(page);
    expect(await page.locator('#detail .linkrow').count()).toBe(3);
    const grafana = page.locator("#detail .linkrow:has(.l-u:text-is('http://localhost:5050'))");
    expect(await grafana.locator('.l-c').innerText()).toBe('admin/admin');
    expect(await grafana.locator('.l-sub').innerText()).toContain('anonymous view');
    const prometheus = page.locator("#detail .linkrow:has(.l-u:text-is('http://localhost:9090'))");
    expect(await prometheus.locator('.l-c').count()).toBe(0);
    expect(await prometheus.locator('.l-sub').innerText()).toContain('Targets');
    expect(await page.locator('#detail .note-p', { hasText: 'auto-provisioned' }).count()).toBe(1);
    return;
  }
  if (name === 'presets are ticked from a list and sent with each ones settings') {
    await openCreate(page);
    await createDetails(page);
    await page.locator('#plist input[value=ldap]').check();
    await page.locator('#plist input[value=email]').check();
    const combined = await page.locator('#pcombo').innerText();
    expect(combined).toContain('email + ldap');
    expect(combined).toContain('read it in Mailpit');
    // Each ticked preset has its own settings; the untouched ones send nothing.
    expect(await page.locator('.ppanel-h').allInnerTexts()).toEqual(['email', 'ldap']);
    await page.locator('.ppanel input[data-p=ldap][data-k=users]').fill('7');
    await page.locator('.ppanel input[data-p=email][data-k=verification]').check();
    await submitTheCreate(page, '8.5.1');
    const request = mockCreateRepro.mock.calls[0]?.[0];
    expect(request?.preset).toBe('email+ldap');
    expect(request?.params).toEqual({ 'ldap.users': '7', 'email.verification': 'true' });
    return;
  }
  if (name === 'voice with the phone system combines with email as the cli does') {
    await openCreate(page);
    await createDetails(page);
    await page.locator('#plist input[value=voice]').check();
    await page.locator('#plist input[value=email]').check();
    expect(await page.locator('.ppanel-h').allInnerTexts()).toEqual(['email', 'voice']);
    await page.locator('.ppanel input[data-p=voice][data-k=sip_integration]').check();
    await page.locator('.ppanel input[data-p=voice][data-k=pbx]').check();
    await submitTheCreate(page, '8.8.1');
    // What the core receives is what `--preset email+voice --set voice.sip_integration=on --set
    // voice.pbx=on` gives it: one rule for both front-ends.
    const request = mockCreateRepro.mock.calls[0]?.[0];
    expect(request?.preset).toBe('email+voice');
    expect(request?.params).toEqual({ 'voice.sip_integration': 'on', 'voice.pbx': 'on' });
    return;
  }
  if (name === 'the voice panel opens each phone option once the one it needs is on') {
    await openCreate(page);
    await createDetails(page);
    await page.locator('#plist input[value=voice]').check();
    // Each control once, in the order shown: a choice's buttons share their key.
    const shown = async (): Promise<string[]> => [
      ...new Set(
        await page.$$eval('.ppanel [data-p=voice][data-k]', (els) =>
          els.map((el) => (el as HTMLElement).dataset.k ?? ''),
        ),
      ),
    ];
    expect(await shown()).toEqual(['sip_integration', 'ice_servers']);
    await page.locator('.ppanel input[data-p=voice][data-k=sip_integration]').check();
    expect(await shown()).toEqual([
      'sip_integration',
      'voip_domain',
      'rtp_ports',
      'pbx',
      'ice_servers',
    ]);
    await page.locator('.ppanel input[data-p=voice][data-k=pbx]').check();
    expect(await shown()).toEqual([
      'sip_integration',
      'voip_domain',
      'rtp_ports',
      'pbx',
      'freeswitch_dialplans',
      'ice_servers',
    ]);
    await page
      .locator('.ppanel button[data-p=voice][data-k=freeswitch_dialplans][data-v=edit]')
      .click();
    expect(
      await page.locator('.ppanel', { hasText: 'kept across rebuilds and backups' }).count(),
    ).toBe(1);
    await page.locator('.ppanel input[data-p=voice][data-k=voip_domain]').fill('192.168.1.20');
    // pbx off hides the dialplan choice, and a hidden choice is not sent: freeswitch_dialplans=edit
    // without pbx=on is a refusal.
    await page.locator('.ppanel input[data-p=voice][data-k=pbx]').uncheck();
    expect(await shown()).not.toContain('freeswitch_dialplans');
    await submitTheCreate(page, '8.8.1');
    const request = mockCreateRepro.mock.calls[0]?.[0];
    expect(request?.preset).toBe('voice');
    expect(request?.params).toEqual({
      sip_integration: 'on',
      voip_domain: '192.168.1.20',
      pbx: 'off',
    });
    return;
  }
  if (name === 'the e2ee options send the policy and switches as its settings') {
    await openCreate(page);
    await createDetails(page);
    await page.locator('#plist input[value=e2ee]').check();
    const policy = page.locator('.ppanel button[data-p=e2ee][data-k=policy]');
    expect(await policy.allInnerTexts()).toEqual(['Optional', 'On by default', 'Enforced']);
    await page.locator('.ppanel button[data-p=e2ee][data-k=policy][data-v=enforced]').click();
    expect(
      await page.locator('.ppanel', { hasText: 'Needs Rocket.Chat 8.8.0 or later' }).count(),
    ).toBe(1);
    // Sample data stays on offer: nothing about this preset stops the seeder.
    expect(await page.locator('#create-form [name=seed]').isDisabled()).toBe(false);
    await page.locator('.ppanel input[data-p=e2ee][data-k=files]').uncheck();
    await submitTheCreate(page, '8.8.0');
    const request = mockCreateRepro.mock.calls[0]?.[0];
    expect(request?.preset).toBe('e2ee');
    expect(request?.params).toEqual({ policy: 'enforced', files: 'off' });
    return;
  }
  if (name === 'saml and oidc rule each other out and ldap follows the one ticked') {
    await openCreate(page);
    await createDetails(page);
    await page.locator('#plist input[value=saml]').check();
    expect(await page.locator('#plist input[value=oidc]').isDisabled()).toBe(true);
    expect(
      await page.locator('#plist label.prow:has(input[value=oidc]) .prow-why').innerText(),
    ).toBe('One sign-in provider per workspace');
    await page.locator('#plist input[value=ldap]').check();
    // ldap's own single sign-on is the ticked saml: one Keycloak, locked, and said why.
    const sso = await page
      .locator('.ppanel button[data-p=ldap][data-k=idp]')
      .evaluateAll((buttons) =>
        buttons.map((b) => [
          b.textContent,
          (b as HTMLButtonElement).disabled,
          b.getAttribute('aria-pressed'),
        ]),
      );
    expect(sso).toEqual([
      ['None', true, 'false'],
      ['SAML', true, 'true'],
      ['OIDC', true, 'false'],
    ]);
    expect(await page.locator('.ppanel', { hasText: 'Uses the same Keycloak' }).count()).toBe(1);
    await page.locator('#plist input[value=saml]').uncheck();
    expect(await page.locator('#plist input[value=oidc]').isDisabled()).toBe(false);
    await closeTheCreate(page);
    return;
  }
  if (name === 'ldap asks for a one time code only with its own single sign on') {
    await openCreate(page);
    await createDetails(page);
    await page.locator('#plist input[value=ldap]').check();
    const mfa = page.locator('.ppanel input[data-p=ldap][data-k=mfa]');
    expect(await mfa.count()).toBe(0);
    await page.locator('.ppanel button[data-p=ldap][data-k=idp][data-v=saml]').click();
    expect(await mfa.count()).toBe(1);
    expect(await page.locator('.ppanel input[data-p=ldap][data-k=idp_host]').count()).toBe(1);
    await mfa.check();
    await submitTheCreate(page, '8.5.1');
    const request = mockCreateRepro.mock.calls[0]?.[0];
    expect([request?.preset, request?.params]).toEqual(['ldap', { idp: 'saml', mfa: 'on' }]);
    return;
  }
  if (name === 'a pasted license is masked and sent') {
    await openCreate(page);
    await createDetails(page);
    const license = `${'Lk'.repeat(60)}zq9x`;
    await page.locator('#lic-add').click();
    await page.locator('#lic-text').fill(license);
    await page.locator('#lic-text').blur();
    // Masked: its length and last four characters; the box closed, the text gone from the page.
    expect(await page.locator('#lic-sum-t').innerText()).toBe(
      'License added · 124 characters · …zq9x',
    );
    expect(await page.locator('#lic-b').isHidden()).toBe(true);
    expect(await page.locator('#lic-pill').isVisible()).toBe(true);
    expect(await page.evaluate((text) => document.body.innerHTML.includes(text), license)).toBe(
      false,
    );
    await submitTheCreate(page, '8.5.1');
    expect(mockCreateRepro.mock.calls[0]?.[0]?.license).toBe(license);
    return;
  }
  if (name === 'the 9 notice asks for a license only when one is needed') {
    await openCreate(page);
    await createDetails(page);
    await page.locator('#create-form input[name=version]').fill('9.0.0-rc.1');
    await page.locator('#version-hint', { hasText: 'MongoDB' }).waitFor({ state: 'visible' });
    expect(await page.locator('#version-hint').innerText()).toContain(
      'Release candidate 9.0.0-rc.1',
    );
    const notice = page.locator('#v9');
    expect(await notice.isHidden()).toBe(true);
    await page.locator('#plist input[value=ldap]').check();
    expect(await notice.innerText()).toContain('for LDAP sign-in');
    // A registration token answers it...
    await page
      .locator('#create-dialog details.adv')
      .evaluate((d) => ((d as HTMLDetailsElement).open = true));
    await page.locator('#create-form input[name=reg_token]').fill('a-token');
    expect(await notice.isHidden()).toBe(true);
    await page.locator('#create-form input[name=reg_token]').fill('');
    expect(await notice.isVisible()).toBe(true);
    // ...and so does a license, added from the notice's own link.
    await notice.locator('button', { hasText: 'Add a license' }).click();
    await page.locator('#lic-text').fill('a-license-text');
    await page.locator('#lic-text').blur();
    expect(await notice.isHidden()).toBe(true);
    // Not a 9.x release: nothing to say.
    await page.locator('#lic-remove').click();
    await page.locator('#create-form input[name=version]').fill('8.5.1');
    expect(await notice.isHidden()).toBe(true);
    await closeTheCreate(page);
    return;
  }
  if (name === 'a ci build names its base release') {
    await openCreate(page);
    await createDetails(page);
    await page.locator('#create-form input[name=version]').fill('pr-41234');
    expect(await page.locator('#version-pill').isVisible()).toBe(true);
    await page
      .locator('#version-hint', { hasText: 'Based on 9.0.0' })
      .waitFor({ state: 'visible' });
    const hint = await page.locator('#version-hint').innerText();
    expect(hint).toContain('pull request #41234');
    expect(hint).toContain('ghcr.io/rocketchat/rocket.chat:pr-41234');
    expect(hint).toContain("from the pull request's package.json");
    // Its base is 9.0, so a directory sign-in gets the notice too.
    await page.locator('#plist input[value=ldap]').check();
    expect(await page.locator('#v9').isVisible()).toBe(true);
    await closeTheCreate(page);
    return;
  }
  if (name === 'the workspace panel shows its presets its build and its license') {
    await openWorkspace(page);
    expect(await page.locator('.d-sub .pchip').allInnerTexts()).toEqual(['email', 'ldap']);
    expect(await page.locator('.d-sub .pill.plain').allInnerTexts()).toEqual([
      'CI build',
      'Licensed',
    ]);
    // The notes card names the set the same way: not the stored `email+ldap`.
    expect(
      await page
        .locator('#d-body .panelcard-h .section-label', { hasText: 'Preset' })
        .textContent(),
    ).toBe('Preset · email + ldap');
    return;
  }
  if (name === 'the create dialog opens and lists presets') {
    await openCreate(page);
    await page.waitForFunction(
      () => document.querySelectorAll('#plist input[name=preset]').length > 0,
    );
    const values = await page
      .locator('#plist input[name=preset]')
      .evaluateAll((boxes) => boxes.map((box) => (box as HTMLInputElement).value));
    expect(values).toEqual(expect.arrayContaining(['ldap', 'email']));
    // Nothing ticked is `default`; several instances is the Shape, not a preset.
    expect(values).not.toContain('default');
    expect(values).not.toContain('multi-instance');
    await page.locator('#create-cancel').click();
    await page.waitForFunction(
      () => !(document.querySelector('#create-dialog') as HTMLDialogElement).open,
    );
    return;
  }
  if (name === 'the load test dialog opens from the panel') {
    await openWorkspace(page);
    await page.locator('button', { hasText: 'Load test' }).click({ timeout: 5000 });
    await page.locator('#perf-dialog[open]').waitFor({ state: 'visible', timeout: 5000 });
    expect(await page.locator('#perf-title').textContent()).toContain('t1234');
    expect(await page.locator('#perf-form [name=live]').isDisabled()).toBe(true);
    await page.locator('#perf-cancel').click({ timeout: 5000 });
    await page.waitForFunction(
      () => !(document.querySelector('#perf-dialog') as HTMLDialogElement).open,
      undefined,
      { timeout: 5000 },
    );
    return;
  }
  if (name === 'the doctor dialog renders its checks') {
    await page.locator('#doctor-badge').click();
    await page.locator('#doctor-dialog[open]').waitFor({ state: 'visible' });
    await page.waitForFunction(
      () => !(document.querySelector('#doctor-body')?.textContent ?? '').includes('Checking'),
    );
    const body = await page.locator('#doctor-body').textContent();
    expect(body).toContain('Docker daemon running');
    expect(body).toContain('a workspace needs about 6');
    expect(body).not.toContain('Edge running');
    expect(body).toContain('no workspace');
    expect(body).not.toContain('1 total, 1 running');
    await page.locator('#doctor-close').click();
    return;
  }
  if (name === 'the edge badge surfaces an unreachable route') {
    await page.locator('#edge-badge:not([hidden])').waitFor({ state: 'visible' });
    expect(await page.locator('#edge-badge').textContent()).toContain('1 unreachable');
    await page.locator('#edge-badge').click();
    await page.locator('#edge-dialog[open]').waitFor({ state: 'visible' });
    expect(await page.locator('#edge-body').textContent()).toContain('t9999');
    expect(mockRouteReachable).toHaveBeenCalled();
    await page.locator('#edge-close').click();
    await page.waitForFunction(
      () => !(document.querySelector('#edge-dialog') as HTMLDialogElement).open,
    );
    return;
  }
  if (name === 'an admin can delete a certificate nothing points at') {
    await page.locator('#edge-badge:not([hidden])').waitFor({ state: 'visible' });
    await page.locator('#edge-badge').click();
    await page.locator('#edge-dialog[open]').waitFor({ state: 'visible' });
    const before = await page.locator('#edge-body').textContent();
    expect(before).toContain('certificate held with no route');
    expect(before).toContain('old-ticket-991.kestron.org');
    page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await page.locator('#edge-body button.danger').click();
    await page.waitForFunction(
      () => !(document.querySelector('#edge-body')?.textContent ?? '').includes('old-ticket-991'),
    );
    expect(mockDeleteHost).toHaveBeenCalledWith('old-ticket-991.kestron.org', { confirm: true });
    expect(surfaceAcmeHosts).toEqual([]);
    return;
  }
  if (name === 'a member is not offered the delete at all') {
    await page.locator('#edge-badge:not([hidden])').waitFor({ state: 'visible' });
    await page.locator('#edge-badge').click();
    await page.locator('#edge-dialog[open]').waitFor({ state: 'visible' });
    expect(await page.locator('#edge-body').textContent()).toContain('old-ticket-991.kestron.org');
    expect(await page.locator('#edge-body button.danger').count()).toBe(0);
    expect(mockDeleteHost).not.toHaveBeenCalled();
    return;
  }
  if (name === 'the create dialog follows the box policy not the role') {
    const openWithAdvanced = async (): Promise<void> => {
      await openCreate(page);
      await createDetails(page);
      await page.locator('#create-dialog details.adv').evaluateAll((details) => {
        for (const item of details) (item as HTMLDetailsElement).open = true;
      });
      await page.locator('#create-form [name=mongo]').waitFor({ state: 'visible', timeout: 5000 });
    };
    await openWithAdvanced();
    for (const field of PRIVILEGED_CREATE_FIELDS) {
      if (field !== 'context' && field !== 'license') {
        const input = page.locator(`#create-form [name=${field}]`);
        expect([await input.isVisible(), await input.isDisabled()]).toEqual([true, false]);
      }
    }
    expect(await page.locator('#lic-add').isDisabled()).toBe(false);
    await createWhere(page);
    // The policy lets this member choose a cluster: no "server's default" stand-in.
    expect(await page.locator('#dest-cards label[data-dest="k8s-default"]').count()).toBe(0);
    await page.locator('#create-cancel').click({ timeout: 5000 });
    await page.waitForFunction(
      () => !(document.querySelector('#create-dialog') as HTMLDialogElement).open,
      undefined,
      { timeout: 5000 },
    );
    config.updateConfig((value) => {
      value[CREATE_POLICY_KEY] = 'admin';
    });
    await openWithAdvanced();
    // Shown, not hidden -- members create workspaces too -- and disabled, with the reason.
    for (const field of PRIVILEGED_CREATE_FIELDS) {
      if (field === 'context' || field === 'license') continue;
      const input = page.locator(`#create-form [name=${field}]`);
      expect([await input.isVisible(), await input.isDisabled()]).toEqual([true, true]);
    }
    expect(await page.locator('#adv-policy').isVisible()).toBe(true);
    expect(await page.locator('#lic-add').isDisabled()).toBe(true);
    expect(await page.locator('#lic-policy').isVisible()).toBe(true);
    await createWhere(page);
    // A cluster may not be chosen, so Kubernetes is one card: the server's default, which
    // here is the k3s kubectl points at -- named, and usable.
    expect(await page.locator('#dest-cards label[data-dest="k8s-default"]').count()).toBe(1);
    expect({
      off: await page.locator('#dest-cards label[data-dest="k8s-default"] input').isDisabled(),
      says: (await page.locator('#dest-cards label[data-dest="k8s-default"]').innerText()).includes(
        "This server's default · ",
      ),
    }).toEqual({ off: false, says: true });
    expect(
      await page
        .locator('#dest-cards label[data-dest^="eks:"], #dest-cards label[data-dest^="k8s:"]')
        .count(),
    ).toBe(0);
    // ...and the Clusters page offers Create only where that dialog can go: Docker, and the
    // server's default through the dialog's "default" card. It offered every cluster, and
    // Create opened, toasted and dropped the member back on step 1.
    await page.locator('#create-cancel').click({ timeout: 5000 });
    await page.waitForFunction(
      () => !(document.querySelector('#create-dialog') as HTMLDialogElement).open,
    );
    await openClusterLedger(page);
    const offers = await page.evaluate(async () => {
      const settings = (await (await fetch('/api/settings')).json()) as {
        kube_clusters: { context: string; is_default: boolean }[];
      };
      const fallback = settings.kube_clusters.find((row) => row.is_default)?.context ?? '';
      const offered = [...document.querySelectorAll('[data-place]')]
        .filter((node) =>
          [...node.querySelectorAll('button')].some((b) => b.textContent === 'Create here'),
        )
        .map((node) => node.getAttribute('data-place') ?? '');
      return { fallback, offered, places: document.querySelectorAll('[data-place]').length };
    });
    expect(offers).toEqual({ fallback: '', offered: ['docker', 'k8s:default'], places: 3 });
    return;
  }
  if (name === 'https is in section two and is still not a second twisty') {
    await openCreate(page);
    await createDetails(page);
    expect(await page.locator('#create-dialog details.adv').count()).toBe(1);
    expect(
      await page
        .locator('#create-https-block')
        .evaluate((element) => element.closest('details') === null),
    ).toBe(true);
    expect(
      await page.locator('#create-dialog details.adv').evaluate((element) => {
        return (element as HTMLDetailsElement).open;
      }),
    ).toBe(false);
    expect(await page.locator('#create-https-block').isVisible()).toBe(true);
    // In the details, with the rest of how it is reached -- never under More options.
    expect(
      await page
        .locator('#create-https-block')
        .evaluate((element) => element.closest('section')?.id),
    ).toBe('create-step-2');
    expect(await page.locator('input[name=domain]').isHidden()).toBe(true);
    await page.locator('#https-mode').selectOption('acme');
    expect(await page.locator('input[name=domain]').isVisible()).toBe(true);
    expect(await page.locator('input[name=acme_email]').isVisible()).toBe(true);
    await page.locator('#https-mode').selectOption('local');
    expect(await page.locator('input[name=domain]').isHidden()).toBe(true);
    expect((await page.locator('#https-mode-hint').textContent())?.trim()).not.toBe('');
    return;
  }
  if (name === 'you can change your own password from the browser') {
    await page.locator('#whoami').click();
    await page.locator('#me-menu:not([hidden])').waitFor({ state: 'visible' });
    await page.locator('#me-passwd').click();
    await page.locator('#passwd-dialog[open]').waitFor({ state: 'visible' });
    await page.locator('#passwd-form [name=old]').fill('not-my-password');
    await page.locator('#passwd-form [name=new]').fill('a-brand-new-password');
    await page.locator('#passwd-go').click();
    await page.locator('#passwd-err:not([hidden])').waitFor({ state: 'visible' });
    expect(await page.locator('#passwd-err').textContent()).toContain('not your current password');
    await page.locator('#passwd-form [name=old]').fill(PASSWORD);
    await page.locator('#passwd-go').click();
    await page.waitForFunction(
      () => !(document.querySelector('#passwd-dialog') as HTMLDialogElement).open,
    );
    await page.reload();
    await page.locator('#whoami:not([hidden])').waitFor({ state: 'visible' });
    expect((await page.locator('#whoami').textContent())?.trim()).toBe('alice');
    expect(await users.verify('alice', 'a-brand-new-password')).toBe(true);
    expect(await users.verify('alice', PASSWORD)).toBe(false);
    return;
  }
  if (name === 'a running workspace on home offers both places it could mean') {
    const row = page.locator('#home-running .drow').first();
    await row.waitFor({ state: 'visible' });
    expect(await row.locator('.t').innerText()).toContain('t1234');
    // Where it runs, in the Clusters page's words, instead of a port.
    expect(await row.locator('.t-btn .m').innerText()).toBe('7.4.1 · base · Docker');
    expect(await row.innerText()).toContain('2h');
    const opener = row.getByRole('link', { name: 'Open', exact: true });
    expect(await opener.getAttribute('target')).toBe('_blank');
    expect(await opener.getAttribute('href')).toBe('http://localhost:3001');
    await row.locator('.t-btn').click();
    await page.locator('#d-body').waitFor({ state: 'visible' });
    expect(await page.locator('.d-head').textContent()).toContain('t1234');
    return;
  }
  if (name === 'a refusal raised inside a dialog is read on top of it') {
    // The create is refused (400: a CI build is admin-only here). The reason was toasted
    // under the modal's backdrop, behind the dialog itself, and Create seemed to do nothing.
    await openCreate(page);
    await createDetails(page);
    await page.locator('#create-form input[name=version]').fill('develop');
    // The version lookup fires 400 ms after typing stops and, with no network here, answers
    // 400 for a CI build. Waited for: on a fast run the page was gone before it fired, on a
    // slow lane it landed after the refusal and was read as a stray failure.
    await page.waitForResponse((r) => new URL(r.url()).pathname === '/api/versions/develop');
    await page.locator('#create-submit').click();
    const toast = page.locator('#toasts .toast', { hasText: 'limited to admins' });
    await toast.waitFor({ state: 'visible' });
    const seen = await toast.evaluate((node) => {
      // The stack ignores the pointer so it never blocks a click; to ask what is drawn on
      // top at the toast's own centre, it has to answer for this one probe.
      (node.parentElement as HTMLElement).style.pointerEvents = 'auto';
      const box = node.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit !== null && (hit === node || node.contains(hit));
    });
    expect(seen).toBe(true);
    // Still on the details, where the version can be changed.
    expect(await page.locator('#create-step-2').isVisible()).toBe(true);
    return;
  }
  if (name === 'a second new workspace starts from an empty form') {
    // Only the presets were reset, so a second open came up with the last create's name,
    // port and image -- and "Reuse it" then started the earlier workspace instead.
    await openCreate(page);
    await createDetails(page);
    const form = page.locator('#create-form');
    await form.locator('input[name=version]').fill('9.0.0');
    await form.locator('input[name=name]').fill('l6-rc9-ldap-only-01');
    await form.locator('input[name=seed]').check();
    await page.locator('#create-dialog details.adv').evaluate((node) => {
      (node as HTMLDetailsElement).open = true;
    });
    await form.locator('input[name=port]').fill('3301');
    await form.locator('input[name=rc_image]').fill('registry.example/rocket.chat:8.5.1');
    await form.locator('select[name=existing]').selectOption('force');
    await closeTheCreate(page);
    await openCreate(page);
    await createDetails(page);
    expect(
      await form.evaluate((node) => {
        const f = node as HTMLFormElement;
        const value = (key: string): string =>
          (f.elements.namedItem(key) as HTMLInputElement).value;
        return {
          version: value('version'),
          name: value('name'),
          port: value('port'),
          image: value('rc_image'),
          existing: value('existing'),
          seed: (f.elements.namedItem('seed') as HTMLInputElement).checked,
        };
      }),
    ).toEqual({ version: '', name: '', port: '', image: '', existing: 'reuse', seed: false });
    await closeTheCreate(page);
    return;
  }
  if (name === 'a member is told a ci build is kept to admins before pressing create') {
    await openCreate(page);
    await createDetails(page);
    await page.locator('#create-form input[name=version]').fill('develop');
    expect(await page.locator('#version-pill').isVisible()).toBe(true);
    // Said where the version is typed, as the image and token fields on this step say it.
    expect(await page.locator('#version-hint').innerText()).toContain(
      'Limited to admins on this server (gui.create_policy admin)',
    );
    // A release is not a CI build: nothing to say there.
    await page.locator('#create-form input[name=version]').fill('8.5.1');
    expect(await page.locator('#version-hint').innerText()).not.toContain('Limited to admins');
    await closeTheCreate(page);
    return;
  }
  if (name === 'the create dialog can stop its own job') {
    // Stop existed only from Activity; the create's own progress, where a stuck create is
    // watched, offered nothing but Close.
    await openCreate(page);
    await createDetails(page);
    await page.locator('#create-form input[name=version]').fill('8.5.1');
    await page.locator('#create-submit').click();
    const stop = page.locator('#create-dialog[open] #create-stop');
    await stop.waitFor({ state: 'visible', timeout: 5000 });
    page.once('dialog', (dialog) => {
      void dialog.accept();
    });
    await stop.click();
    await page.waitForFunction(() =>
      (document.querySelector('#create-progress-title')?.textContent ?? '').endsWith('was stopped'),
    );
    expect(await stop.isHidden()).toBe(true);
    expect(await page.locator('#create-progress').innerText()).toContain('stopped by alice');
    // Its footer no longer says it "keeps starting and shows in the list".
    expect(await page.locator('#create-foot-hint').innerText()).not.toContain('keeps starting');
    return;
  }
  if (name === 'a stopped job is said to be stopped not failed') {
    // The create carries on when its dialog is closed, and its ending is toasted. Somebody
    // stopping it is not a failure; the toast said "failed: stopped by alice", in red.
    await openCreate(page);
    await createDetails(page);
    await page.locator('#create-form input[name=version]').fill('8.5.1');
    await page.locator('#create-submit').click();
    await page.locator('#create-progress li').first().waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
      (document.querySelector('#create-progress-title')?.textContent ?? '').includes('stuck-one'),
    );
    await closeTheCreate(page);
    const stopped = await page.evaluate(async () => {
      const { jobs } = (await (await fetch('/api/jobs')).json()) as {
        jobs: { id: string; kind: string; status: string }[];
      };
      const job = jobs.find((j) => j.kind === 'create' && j.status === 'running');
      if (job === undefined) return 0;
      return (await fetch(`/api/jobs/${job.id}/stop`, { method: 'POST' })).status;
    });
    expect(stopped).toBe(200);
    const toast = page.locator('#toasts .toast', { hasText: 'stopped by alice' });
    await toast.waitFor({ state: 'visible' });
    // Named as Activity names it: the workspace, not "Creating 8.5.1 (default)".
    expect(await toast.textContent()).toContain('Creating stuck-one: ');
    expect(await toast.textContent()).not.toContain('failed');
    expect(await toast.getAttribute('class')).not.toContain('error');
    return;
  }
  if (name === 'a long scenario note wraps in the create result') {
    await openCreate(page);
    await createDetails(page);
    await submitTheCreate(page, '8.5.1');
    const row = page.locator('#create-result .linkrow', { hasText: 'Mailpit' });
    await row.waitFor({ state: 'visible' });
    // The whole description is inside the row: wrapped, not cut at its right edge.
    const fit = await row.evaluate((node) => {
      const box = node.getBoundingClientRect();
      const parts = [...node.children].map((child) => child.getBoundingClientRect());
      return {
        inside: parts.every((part) => part.right <= box.right + 1 && part.left >= box.left - 1),
        clipped: node.scrollWidth > node.clientWidth + 1,
        text: node.textContent,
      };
    });
    expect(fit.text).toContain('tell users apart by the To: column');
    expect(fit).toMatchObject({ inside: true, clipped: false });
    return;
  }
  if (name === 'a finished restore re-reads the workspace without a page error') {
    // The restore's own callback called a `refresh()` nothing defines: a page error, and
    // the re-read of the list and the panel that follows it never ran.
    await openWorkspace(page);
    await page.locator('#detail .tab', { hasText: 'Backups' }).click();
    const asNew = page.locator('#d-body button', { hasText: 'as new' });
    await asNew.waitFor({ state: 'visible' });
    const reads = mockListRepros.mock.calls.length;
    await asNew.click();
    await page.locator('#restore-go').click();
    await page.waitForFunction(() => document.querySelector('#job-title')?.textContent === 'Done');
    await page
      .locator('#toasts .toast', { hasText: 'restored t1234' })
      .waitFor({ state: 'visible' });
    expect(mockRestore).toHaveBeenCalled();
    // Re-read at once, not on the next four-second poll.
    for (let n = 0; n < 20 && mockListRepros.mock.calls.length === reads; n += 1)
      await page.waitForTimeout(50);
    expect(mockListRepros.mock.calls.length).toBeGreaterThan(reads);
    return;
  }
  if (name === 'a workspace is handed over from its pane and its owner row follows') {
    // POST /api/repros/{name}/owner existed, and nothing in the GUI called it.
    await openWorkspace(page);
    expect(await page.locator('.d-sub').textContent()).toContain('alice (you)');
    await page.locator('#actpane button', { hasText: 'Hand over…' }).click();
    await page.locator('#owner-dialog[open]').waitFor({ state: 'visible' });
    // An admin may read the people list, so it is a choice rather than a name to recall.
    expect(await page.locator('#owner-pick option').allTextContents()).toEqual(['bob']);
    expect(await page.locator('#owner-to').isVisible()).toBe(false);
    await page.locator('#owner-pick').selectOption('bob');
    await page.locator('#owner-go').click();
    await page.locator('#owner-dialog').waitFor({ state: 'hidden' });
    await page.locator('.d-sub', { hasText: 'bob' }).waitFor({ state: 'visible' });
    expect((await realRecord.readMeta('t1234')).extra.owner).toBe('bob');
    return;
  }
  if (name === 'a refused hand over is said inside its dialog') {
    await openWorkspace(page);
    await page.locator('#actpane button', { hasText: 'Hand over…' }).click();
    await page.locator('#owner-dialog[open]').waitFor({ state: 'visible' });
    // A member may not read the people list, so the name is typed.
    expect(await page.locator('#owner-pick-row').isVisible()).toBe(false);
    await page.locator('#owner-to').fill('nobody');
    await page.locator('#owner-go').click();
    const err = page.locator('#owner-err');
    await err.waitFor({ state: 'visible' });
    expect(await err.textContent()).toContain('no account named');
    expect(await page.locator('#owner-dialog').getAttribute('open')).not.toBeNull();
    return;
  }
  if (
    name ===
    'a member on a colleague’s workspace is told who can hand it over and offered nothing to click'
  ) {
    await openWorkspace(page);
    // The gate refuses this member everything that changes bob's workspace, taking it down
    // included, so the pane offers nothing and says who to ask. It once sent a GUI user to
    // `houston chown`, which a member may not run for themselves.
    expect(await page.locator('#actpane button').count()).toBe(0);
    const note = String(await page.locator('#actpane .apnote').textContent());
    expect(note).toContain("This is bob's workspace");
    expect(note).toContain('Ask bob to hand it over');
    expect(note).not.toContain('houston');
    expect(mockTeardown).not.toHaveBeenCalled();
    return;
  }
  if (name === 'every backup on the machine is listed and a deleted workspaces restores as new') {
    // The Backups tab lives on a workspace's panel, so a deleted one's bundles were
    // listed nowhere, and restoring one as new could not be reached.
    await page.locator('#btn-backups').click();
    await page.locator('#detail .dtable').waitFor({ state: 'visible' });
    expect(mockListBackups).toHaveBeenCalledWith('');
    expect(await page.locator('#btn-backups').getAttribute('aria-current')).not.toBeNull();
    const gone = page.locator('#detail tr', { hasText: 'gone-ws-2026-10-01' });
    expect(await gone.textContent()).toContain('deleted');
    const kept = page.locator('#detail tr', { hasText: 't1234-2026-10-08' });
    expect(await kept.textContent()).not.toContain('deleted');
    await gone.getByRole('button', { name: 'restore as new' }).click();
    await page.locator('#restore-dialog[open]').waitFor({ state: 'visible' });
    await page.locator('#restore-go').click();
    await page.waitForFunction(() => document.querySelector('#job-title')?.textContent === 'Done');
    expect(mockRestore).toHaveBeenCalledWith(
      expect.stringContaining('gone-ws-2026-10-01.rcbak'),
      expect.objectContaining({ new: true, name: '' }),
    );
    // Back as a workspace, its bundle is no longer marked as a deleted one's.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('#detail tr')]
          .find((row) => row.textContent.includes('gone-ws-2026-10-01'))
          ?.textContent.includes('deleted') === false,
    );
    return;
  }
  if (
    name === 'restore as new is offered while the source still holds the side ports it would use'
  ) {
    // The copy is given side ports of its own, so the source still holding 8025 is not in
    // its way: the dialog offers the restore, and names no holder.
    await openWorkspace(page, 'mail-src');
    await page.locator('#detail .tab', { hasText: 'Backups' }).click();
    await page.locator('#d-body button', { hasText: 'as new' }).click();
    await page.locator('#restore-dialog[open]').waitFor({ state: 'visible' });
    expect(await page.locator('#restore-dialog').textContent()).not.toContain('8025');
    expect(await page.locator('#restore-go').isDisabled()).toBe(false);
    await page.locator('#restore-go').click();
    await page.waitForFunction(() => document.querySelector('#job-title')?.textContent === 'Done');
    expect(mockRestore).toHaveBeenCalledWith(
      expect.stringContaining('mail-src-2026-10-09.rcbak'),
      expect.objectContaining({ new: true, name: '' }),
    );
    // The job's stream has ended once its result is announced.
    await page.locator('#toasts .toast', { hasText: 'restored' }).waitFor({ state: 'visible' });
    return;
  }
  if (name === 'an upgraded workspace rolls back behind a red confirm and the panel follows') {
    // POST /api/repros/{name}/upgrade/rollback existed, and nothing in the GUI called it.
    await openWorkspace(page);
    await page.locator('#actpane button', { hasText: 'Roll back to 7.3.0' }).click();
    await page.locator('#rollback-dialog[open]').waitFor({ state: 'visible' });
    // RED: it replaces the database, and it says what is lost.
    const ink = await page.locator('#rollback-go').evaluate((element) => {
      const sample = document.createElement('div');
      sample.style.color = getComputedStyle(document.documentElement).getPropertyValue('--red');
      document.body.append(sample);
      const red = getComputedStyle(sample).color;
      sample.remove();
      return { color: getComputedStyle(element).color, red };
    });
    expect(ink.color).toBe(ink.red);
    expect(await page.locator('#rollback-what').getAttribute('class')).toContain('bad');
    expect(await page.locator('#rollback-what').textContent()).toContain('is lost');
    await page.locator('#rollback-go').click();
    await page.waitForFunction(() => document.querySelector('#job-title')?.textContent === 'Done');
    expect(mockRollback).toHaveBeenCalledWith('t1234', expect.anything());
    await page.locator('.d-sub', { hasText: '7.3.0' }).waitFor({ state: 'visible' });
    expect(await page.locator('#actpane button', { hasText: 'Roll back' }).count()).toBe(0);
    return;
  }
  if (name === 'the overview follows a workspace that is still starting') {
    await openWorkspace(page);
    const health = page.locator('#d-body .kv', { has: page.locator('.k', { hasText: 'Health' }) });
    expect(await health.locator('.v').innerText()).toBe('starting');
    // Rocket.Chat settles; the poll's list says so, and the panel follows it.
    setSurfaceDetail(detail({ health: 'healthy', uptime: '2 minutes' }));
    await browserImport(page, '/js/util.js', 'loadRepros');
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('#d-body .kv')]
          .find((kv) => kv.querySelector('.k')?.textContent === 'Health')
          ?.querySelector('.v')?.textContent === 'healthy',
      undefined,
      { timeout: 3000 },
    );
    expect(await page.locator('#d-body').innerText()).toContain('2 minutes');
    return;
  }
  if (name === 'the down and unknown words are readable in both themes') {
    const words = ['.wrow[data-state="down"] .wstate', '.wrow[data-state="unknown"] .wstate'];
    await page.locator(words[1] as string).waitFor({ state: 'visible' });
    const light = await contrastRatios(page, words);
    await page.locator('#theme-toggle').click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    // A row's ground eases to the new theme; measure once it has arrived.
    await page.waitForFunction(() => document.getAnimations().length === 0);
    const dark = await contrastRatios(page, words);
    // WCAG AA for text this size. They were 2.79 (light) and 3.12 (dark).
    expect(
      [...Object.entries(light), ...Object.entries(dark)].filter(([, ratio]) => ratio < 4.5),
    ).toEqual([]);
    return;
  }
  if (name === 'at phone width the rail filters and the last tab stay reachable') {
    // At 390px the status and sort filters sat wholly past the screen's edge, and the tab
    // strip cut "Backups" to "BAC", both in scrollers that showed no sign of being one.
    await page.setViewportSize({ width: 390, height: 844 });
    await openWorkspace(page);
    await page.waitForTimeout(200);
    const strips = await page.evaluate(() => {
      const controls = [...document.querySelectorAll('.rail-controls > *, .rail-two > *')]
        .filter((node) => (node as HTMLElement).offsetParent !== null)
        .filter((node) => node.getBoundingClientRect().right > innerWidth)
        .map((node) => node.id || node.className);
      // The tabs still scroll in their own strip (five need more than a phone has), and
      // the strip paints a cue at the edge that has more: a shadow that stays with the
      // box under a cover that travels with the tabs.
      const strip = document.querySelector('#detail .tabs') as HTMLElement;
      const style = getComputedStyle(strip);
      return {
        offscreen: controls,
        tabsScroll: strip.scrollWidth > strip.clientWidth,
        cue:
          /gradient.*gradient/u.test(style.backgroundImage) &&
          style.backgroundAttachment.replace(/\s/gu, '') === 'local,scroll',
        sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });
    expect(strips).toEqual({ offscreen: [], tabsScroll: true, cue: true, sideways: false });
    return;
  }
  throw new Error(`unported surfaces behavior: ${name}`);
}

async function exercise(browserCase: BrowserCase, page: Page): Promise<void> {
  const name = browserCase[1];
  if (name.includes('theme is light')) {
    await waitForGui(page);
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
    await page.locator('#theme-toggle').click();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
    await page.reload();
    expect(await page.locator('html').getAttribute('data-theme')).toBe('dark');
    return;
  }
  await waitForGui(page);
  if (name.includes('narrow') || name.includes('three panes')) {
    await page.setViewportSize({ width: 430, height: 760 });
    expect(await page.locator('#nav-toggle').isVisible()).toBe(true);
  }
  if (browserCase[0] === 'clusters' || name.includes('cluster chip')) {
    await page.locator('#btn-clusters').click();
    await page.locator('#detail', { hasText: 'Clusters' }).waitFor({ state: 'visible' });
    expect(await page.locator('#detail').textContent()).toContain('Clusters');
    return;
  }
  if (name.includes('activity') || name.includes('in progress') || name.includes('job')) {
    await page.locator('#btn-jobs').click();
    await page.locator('#detail', { hasText: 'Activity' }).waitFor({ state: 'visible' });
    expect(await page.locator('#detail').textContent()).toContain('Activity');
    return;
  }
  if (name.includes('scenario') || name.includes('preset notes')) {
    await page.locator('#btn-scenarios').click();
    await page.locator('#detail', { hasText: 'Presets' }).waitFor({ state: 'visible' });
    expect(await page.locator('#detail').textContent()).toContain('Presets');
    return;
  }
  if (
    name.includes('create dialog') ||
    name.includes('runtime card') ||
    name.includes('arrangement')
  ) {
    await page.locator('#btn-new').click();
    await page.locator('#create-dialog').waitFor({ state: 'visible' });
    expect(await page.locator('#create-dialog').getAttribute('open')).toBe('');
    expect(await page.locator('#plist input[name=preset]').count()).toBeGreaterThan(0);
    return;
  }
  if (
    name.includes('detail') ||
    name.includes('panel') ||
    name.includes('pane') ||
    name.includes('tab') ||
    name.includes('workspace') ||
    name.includes('containers') ||
    name.includes('env ')
  ) {
    await page.locator('.wrow').click();
    await page.locator('.d-head').waitFor({ state: 'visible' });
    expect(await page.locator('.d-head').textContent()).toContain('t1234');
    expect((await page.locator('#actpane').textContent())?.trim()).not.toBe('');
    return;
  }
  expect(await page.locator('.wrow').textContent()).toContain('t1234');
}

describe('the frozen GUI against the in-process Fastify server', () => {
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let app: FastifyInstance | null = null;
  let home = '';
  let failures: string[] = [];
  let expectedConsoleError: { pathname: string; status: number } | null = null;
  let sawExpectedConsoleError = false;

  beforeAll(async () => {
    browser = await chromium.launch({
      args: [`--host-resolver-rules=MAP ${PUBLIC_NAME} 127.0.0.1`],
    });
  });

  beforeEach(async () => {
    context = null;
    page = null;
    app = null;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'houston-browser-'));
    process.env.HOUSTON_HOME = home;
    jest.clearAllMocks();
    portedJobs = undefined;
    portedUser = 'alice';
    portedPassword = PASSWORD;
    portedReducedMotion = false;
    surfaceAcmeHosts = [];
    failures = [];
    expectedConsoleError = null;
    sawExpectedConsoleError = false;
  });

  afterEach(async () => {
    const cleanupErrors: string[] = [];
    for (const [label, close] of [
      ['page', page === null ? null : async () => await page?.close()],
      ['context', context === null ? null : async () => await context?.close()],
      ['app', app === null ? null : async () => await app?.close()],
    ] as const) {
      if (close === null) continue;
      try {
        await close();
      } catch (error) {
        cleanupErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      if (home !== '') fs.rmSync(home, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(`home: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (app !== null && app.server.listening) cleanupErrors.push('app: listener remained open');
    expect(cleanupErrors).toEqual([]);
    if (expectedConsoleError !== null && !sawExpectedConsoleError) {
      failures.push(
        `expected console resource error was absent: ${String(expectedConsoleError.status)} ${expectedConsoleError.pathname}`,
      );
    }
    expect(failures).toEqual([]);
  });

  afterAll(async () => {
    if (browser !== null) await browser.close();
  });

  test.each(CASES)('%s: %s', async (file, name) => {
    const browserCase: BrowserCase = [file, name];
    configureStubs(browserCase);
    if (process.env.BROWSER_GATE_PROBE === 'stub' && probeCase(file, name)) {
      mockListRepros.mockImplementation(realInspect.listRepros);
    }
    const flow = file === 'flows' ? await prepareFlow(name) : null;
    const portedOptions = portedFile(file) ? await preparePortedCase(file, name) : null;
    const activeApp = await createApp(flow?.options ?? portedOptions ?? { accounts: false });
    app = activeApp;
    await activeApp.listen({ host: '127.0.0.1', port: 0 });
    const address = activeApp.server.address() as AddressInfo;
    const hostname = publicOrigin(file, name) ? PUBLIC_NAME : '127.0.0.1';
    if (browser === null) throw new Error('Chromium did not start');
    const activeContext = await browser.newContext({
      baseURL: `http://${hostname}:${String(address.port)}`,
      ...(portedReducedMotion ? { reducedMotion: 'reduce' as const } : {}),
    });
    context = activeContext;
    const activePage = await activeContext.newPage();
    page = activePage;
    expectedConsoleError =
      name === 'a refusal raised inside a dialog is read on top of it'
        ? { pathname: '/api/versions/develop', status: 400 }
        : name === 'a wrong password shows an error in the page'
          ? { pathname: '/signin', status: 401 }
          : name === 'the env tab shows the refusal rather than an empty table'
            ? { pathname: '/api/repros/t1234/env', status: 409 }
            : name === 'the live chart stops asking when the answer is a refusal'
              ? { pathname: '/api/repros/t1234/stats', status: 409 }
              : name === 'you can change your own password from the browser'
                ? { pathname: '/api/me/password', status: 400 }
                : name === 'a failed overview read says so and offers to try again'
                  ? { pathname: '/api/clusters/overview', status: 500 }
                  : name ===
                      'this machine says it could not read its clusters, not that it has none'
                    ? { pathname: '/api/clusters', status: 500 }
                    : name === 'a refusal raised inside a dialog is read on top of it'
                      ? { pathname: '/api/repros', status: 400 }
                      : name === 'a refused hand over is said inside its dialog'
                        ? { pathname: '/api/repros/t1234/owner', status: 404 }
                        : null;
    activePage.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
    activePage.on('console', (message) => {
      if (message.type() !== 'error') return;
      const location = message.location().url;
      const pathname = location === '' ? '' : new URL(location).pathname;
      if (
        expectedConsoleError !== null &&
        pathname === expectedConsoleError.pathname &&
        message.text().startsWith('Failed to load resource:') &&
        message.text().includes(`status of ${String(expectedConsoleError.status)}`)
      ) {
        sawExpectedConsoleError = true;
        return;
      }
      // The refused create's own 400, logged by the browser when the page outlives it.
      const expectedRefusalConsole =
        name === 'a refusal raised inside a dialog is read on top of it' &&
        pathname === '/api/repros' &&
        message.text().includes('status of 400');
      if (expectedRefusalConsole) return;
      failures.push(`console: ${message.text()}`);
    });
    activePage.on('requestfailed', (request) => {
      // A finished job's stream is closed by the page, which Chromium reports as aborted.
      const expectedFinishedJobStream =
        (name === 'the seed job shows what it made and whether it was confirmed' ||
          name.startsWith('seed ') ||
          name === 'create sends scenario and history only with sample data enabled' ||
          name === 'a running job can be stopped from its output' ||
          name === 'the build price follows the node count and the build carries its zone' ||
          name === 'a cluster delete says in its job what aws still holds' ||
          name === 'the delete dialog will not arm until the name is typed' ||
          name === 'create shows its progress and ends with where to go' ||
          name === 'create on a cluster with a dns zone asks for an email, not a domain' ||
          name === 'creating a kubernetes workspace sends the axes' ||
          name === 'presets are ticked from a list and sent with each ones settings' ||
          name === 'voice with the phone system combines with email as the cli does' ||
          name === 'the voice panel opens each phone option once the one it needs is on' ||
          name === 'on kubernetes the voice panel offers no phone options and sends none' ||
          name === 'the e2ee options send the policy and switches as its settings' ||
          name === 'ldap asks for a one time code only with its own single sign on' ||
          name === 'a pasted license is masked and sent' ||
          name === 'the setup flow connects a cluster houston built and folds away the others' ||
          name === 'the create dialog can stop its own job' ||
          name === 'a stopped job is said to be stopped not failed' ||
          name === 'a long scenario note wraps in the create result' ||
          name === 'a finished restore re-reads the workspace without a page error' ||
          name ===
            'every backup on the machine is listed and a deleted workspaces restores as new' ||
          name ===
            'restore as new is offered while the source still holds the side ports it would use' ||
          name === 'an upgraded workspace rolls back behind a red confirm and the panel follows' ||
          name ===
            'take down keeps the data, delete asks for the name, and both say what they remove') &&
        request.method() === 'GET' &&
        new URL(request.url()).pathname.endsWith('/stream') &&
        new URL(request.url()).pathname.includes('/api/jobs/') &&
        request.failure()?.errorText === 'net::ERR_ABORTED';
      if (expectedFinishedJobStream) return;
      failures.push(
        `requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`,
      );
    });
    activePage.on('response', (response) => {
      const expectedSigninFailure =
        name === 'a wrong password shows an error in the page' &&
        response.status() === 401 &&
        response.url().includes('/signin?e=bad');
      const expectedBehaviorFailure =
        (name === 'a write from the spa survives plain http on a real hostname' &&
          response.request().method() === 'DELETE' &&
          response.status() !== 403) ||
        (name === 'the env tab shows the refusal rather than an empty table' &&
          response.url().endsWith('/env') &&
          response.status() === 409) ||
        (name === 'the live chart stops asking when the answer is a refusal' &&
          response.url().endsWith('/stats') &&
          response.status() === 409) ||
        (name === 'a failed overview read says so and offers to try again' &&
          new URL(response.url()).pathname === '/api/clusters/overview' &&
          response.status() === 500) ||
        (name === 'this machine says it could not read its clusters, not that it has none' &&
          new URL(response.url()).pathname === '/api/clusters' &&
          response.status() === 500) ||
        (name === 'a refusal raised inside a dialog is read on top of it' &&
          ((response.request().method() === 'POST' &&
            new URL(response.url()).pathname === '/api/repros') ||
            (response.request().method() === 'GET' &&
              new URL(response.url()).pathname === '/api/versions/develop')) &&
          response.status() === 400) ||
        (name === 'a refused hand over is said inside its dialog' &&
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/repros/t1234/owner' &&
          response.status() === 404) ||
        (name === 'you can change your own password from the browser' &&
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/api/me/password' &&
          [400, 403].includes(response.status()));
      if (response.status() >= 400 && !expectedSigninFailure && !expectedBehaviorFailure) {
        failures.push(
          `response: ${String(response.status())} ${response.request().method()} ${response.url()}`,
        );
      }
    });
    if (file === 'flows') {
      if (flow === null) throw new Error('flow fixture was not prepared');
      await exerciseFlow(name, activePage, flow.firstRunKey);
      expect(activeApp.server.listening).toBe(true);
      return;
    }
    if (portedFile(file)) {
      await signIn(activePage, portedUser, portedPassword);
      await activePage.locator('#whoami:not([hidden])').waitFor({ state: 'visible' });
      await activePage.locator('#repros').waitFor({ state: 'visible' });
      if (process.env.BROWSER_GATE_PROBE === 'stub' && probeCase(file, name)) {
        for (let attempt = 0; attempt < 30 && mockListRepros.mock.calls.length === 0; attempt += 1)
          await activePage.waitForTimeout(100);
        expect(mockListRepros).toHaveBeenCalled();
        throw new Error(
          'planted service stub bypass: browser reached the real in-process listRepros seam',
        );
      }
      if (process.env.BROWSER_GATE_PROBE === 'pageerror' && probeCase(file, name)) {
        await activePage.evaluate(() => {
          setTimeout(() => {
            throw new Error('planted unexpected page error');
          }, 0);
        });
        await activePage.waitForTimeout(50);
      }
      if (file === 'surfaces chrome') await exerciseChrome(name, activePage);
      else if (file.startsWith('surfaces ')) await exerciseSurface(name, activePage);
      else if (file === 'remote') await exerciseRemote(name, activePage);
      else if (file === 'plain http') await exercisePlain(name, activePage);
      else if (file === 'kubernetes chrome') await exerciseKubernetesChrome(name, activePage);
      else if (file === 'kubernetes dialogs') await exerciseKubernetesDialogs(name, activePage);
      else if (file === 'kubernetes offstage') await exerciseKubernetesOffstage(name);
      else if (file === 'kubernetes pane') await exerciseKubernetesPane(name, activePage);
      else if (file === 'kubernetes panel') await exerciseKubernetesPanel(name, activePage);
      else if (file === 'kubernetes rail') await exerciseKubernetesRail(name, activePage);
      else if (file === 'clusters') await exerciseClusterCase(name, activePage);
      expect(mockListRepros).toHaveBeenCalled();
      expect(activeApp.server.listening).toBe(true);
      return;
    }
    await activePage.goto('/');
    await exercise(browserCase, activePage);
    expect(mockListRepros).toHaveBeenCalled();
    expect(activeApp.server.listening).toBe(true);
  });
});
