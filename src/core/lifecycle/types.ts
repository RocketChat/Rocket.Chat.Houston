/**
 * The shapes a workspace request and its record take, and the constants they carry.
 *
 * Tier 0: this module imports nothing from `core/lifecycle`, which is what makes it the leaf
 * the other nineteen can reach.
 */

/**
 * How long an INTERACTIVE mutator waits for the repro lock.
 *
 * The lock's own default is 900s, right for a create or a restore queued behind
 * another -- and wrong for a button: nobody wants a Stop click to hang for fifteen
 * minutes rather than say "something else is working on this".
 */
export const INTERACTIVE_LOCK_WAIT = 60.0;

/**
 * Context-name shapes that identify a managed cluster without asking anything.
 *
 * `aws eks update-kubeconfig` writes the ARN and `gcloud container clusters
 * get-credentials` writes `gke_<project>_<zone>_<name>`, so both name their own
 * service. AKS is NOT here and cannot be: `az aks get-credentials` writes the bare
 * cluster name, indistinguishable from a kind or k3s context -- so an AKS default is
 * missed rather than guessed at, and a guess that called someone's k3s billable would
 * be the worse error of the two.
 */
export const BILLABLE_CONTEXT_PREFIXES: readonly string[] = Object.freeze(['arn:aws:eks:', 'gke_']);

/** What `up` was asked for. One field per flag, plus the derived ones. */
export interface CreateReq {
  version: string;
  preset: string;
  name: string;
  port: number;
  rootUrl: string;
  bind: string;
  rcImage: string;
  mongo: string;
  regToken: string;
  /**
   * The Enterprise licence TEXT (`up --license <file|->` reads it). Never recorded, never in
   * the compose document or `extra.env`: a file of its own on Compose, a Secret on Kubernetes.
   */
  license: string;
  params: Record<string, unknown>;
  seed: boolean;
  /**
   * "The CALLER will run the seed, not createRepro." The CLI seeds after `createRepro`
   * returns so it can render the verification table and honour `--verify-seed`; the GUI
   * lets the service do it. Both must still record the seed in the write-ahead note, or
   * `ready` cannot finish an interrupted create.
   */
  seedHere: boolean;
  seedProfile: string;
  seedScenarios: string[];
  seedHistoryDays: number | null;
  pin: boolean;
  wait: boolean;
  offline: boolean;
  noPull: boolean;
  fresh: boolean;
  force: boolean;
  monitor: boolean;
  stats: boolean;
  /**
   * The three axes (`core/topology.ts`). Empty/0 means "that runtime's default", never
   * "unset but meaningful" -- `resolveAxes` turns them into canonical values and writes
   * the deployment back out as a preset + params so the rest of create is unchanged.
   */
  runtime: string;
  deployment: string;
  replicas: number;
  /**
   * WHICH cluster, for `--runtime kubernetes`. Empty means "decide for me" and keeps
   * `planCluster`'s existing steps; naming one ADOPTS it and never provisions.
   *
   * PRIVILEGED (see PRIVILEGED_CREATE_FIELDS). Choosing the cluster a workspace lands
   * in is the same class of decision as `rc_image` and `bind`, and on a shared `serve`
   * it can point a colleague's workspace at a cluster they cannot see.
   */
  context: string;
  /** Kubernetes only. The operator brings SCRAM auth and owns the MongoDB bootstrap. */
  mongoOperator: boolean;
  https: boolean;
  domain: string;
  acmeEmail: string;
  acmeStaging: boolean;
  /** Derived by `pickChallenge`, never asked for. */
  acmeChallenge: string;
  acmeDnsProvider: string;
  ingressClass: string;
  /** `up --env KEY=VALUE`. Merged over the preset's env; a null value removes a key. */
  env: Record<string, string | null>;
  /** Who asked for this, when the GUI has named accounts. */
  actor: string;
  /**
   * `name` is an existing workspace `actor` may act on, so it is used as typed rather than
   * given the actor's prefix. Set by `ownership.claimTypedName`, never from a request body.
   */
  exactName: boolean;
  /** Set by `resolveTls`: an ACME challenge has to publish on a public interface. */
  bindPublic: boolean;
  /**
   * Bring back the workspace `name` IS, never make one: the GUI's Bring it up. Queued behind
   * a Delete, it otherwise found the name free and made a new, empty workspace.
   */
  bringBack: boolean;
}

/** A request with the established defaults filled in. */
export function createReq(values: Partial<CreateReq> & Pick<CreateReq, 'version'>): CreateReq {
  return {
    preset: 'default',
    name: '',
    port: 0,
    rootUrl: '',
    bind: '',
    rcImage: '',
    mongo: '',
    regToken: '',
    license: '',
    params: {},
    seed: false,
    seedHere: false,
    seedProfile: 'small',
    seedScenarios: [],
    seedHistoryDays: null,
    pin: false,
    wait: false,
    offline: false,
    noPull: false,
    fresh: false,
    force: false,
    monitor: false,
    stats: false,
    runtime: '',
    deployment: '',
    replicas: 0,
    context: '',
    mongoOperator: false,
    https: false,
    domain: '',
    acmeEmail: '',
    acmeStaging: false,
    acmeChallenge: 'tlsalpn',
    acmeDnsProvider: '',
    ingressClass: '',
    env: {},
    actor: '',
    exactName: false,
    bindPublic: false,
    bringBack: false,
    ...values,
  };
}

/**
 * Presets that hand the BROWSER a hostname, and the `--set` param that carries it.
 *
 * Each default names THIS machine -- `localhost:8081`, `keycloak:8085` -- which is right
 * on a laptop and wrong on every shared install, where it names the visitor's own
 * machine instead. The value is not the container network's business; it is whatever the
 * person typing actually uses.
 */
export const BROWSER_HOST_PARAM: Readonly<Record<string, string>> = Object.freeze({
  saml: 'idp_host',
  oidc: 'idp_host',
  s3_minio: 's3_host',
});

/** Binds from which nothing off this machine can reach a published port. */
export const LOOPBACK_BINDS: readonly string[] = Object.freeze([
  '127.0.0.1',
  'localhost',
  '::1',
  '',
]);

/**
 * Preset sidecar links to surface on the dashboard: preset -> [label, index into its ports].
 * The ports are the workspace's own (`record.sidePortsOf` over the registry), so a link never
 * drifts from what the workspace publishes.
 */
export const PRESET_LINKS: Readonly<Record<string, readonly (readonly [string, number])[]>> =
  Object.freeze({
    email: [['Mailpit', 0]] as const,
    s3_minio: [
      ['MinIO console', 1],
      ['MinIO API', 0],
    ] as const,
    saml: [['Keycloak', 0]] as const,
    oidc: [['Keycloak', 0]] as const,
    livechat: [['Widget site', 0]] as const,
    ldap: [['phpLDAPadmin', 0]] as const,
    // No static link: the webhook inbox is linked from the record (`notes.inboxUrl`), because
    // the receiver chose its session's id and its root page would open a new, empty one. The
    // empty list still marks the preset as having a browser side UI, which the --bind exposure
    // warning (`create-docker`) names by membership here.
    webhooks: [] as const,
  });

/**
 * States beyond running/stopped/down that `reproState()` can hand to the UI:
 * mid-transition or wedged rather than plainly up/stopped/gone. This is the
 * backend->UI contract for them, so adding a state here fails loudly until the
 * dashboard handles it.
 */
export const TRANSIENT_STATES: readonly string[] = Object.freeze([
  'restarting',
  'created',
  'paused',
  'dead',
]);

/**
 * The services whose absence makes a "running" workspace a lie.
 *
 * Rocket.Chat serves /api/info with no database behind it -- measured: /api/info 200,
 * login 000 after 15s, `ready` exit 0, `list` running, detail health "healthy", and the
 * truth sitting in the same payload's containers array as ("mongodb", "exited").
 *
 * DELIBERATELY JUST THE DATABASE: a stopped Mailpit or phpLDAPadmin is a side service a
 * person can live without.
 */
export const ESSENTIAL_SERVICES: readonly string[] = Object.freeze(['mongodb']);

/** Actions `setState` understands. One tuple, so validator and message cannot drift. */
export const STATE_ACTIONS: readonly string[] = Object.freeze(['start', 'stop', 'restart']);

/**
 * Who may destroy -- and, in the GUI, change at all -- a workspace somebody else owns.
 * `owner` is the default: the guardrail was "confirms first, naming the owner". `anyone`
 * restores the earlier behaviour, for a team that would rather share every workspace.
 */
export const DESTROY_POLICY_KEY = 'gui.destroy_policy';

/**
 * Where `upgrade` records the automatic pre-upgrade bundle, so a rollback finds it, and the
 * version it upgraded from. Here rather than in `upgrade`, because the detail payload reads
 * both to say whether a rollback can be made, and `upgrade` sits above it.
 */
export const LAST_BACKUP_KEY = 'last_upgrade_backup';
export const UPGRADE_FROM_KEY = 'upgraded_from';

/**
 * Who may set the create fields that decide what CODE runs and where it LISTENS.
 *
 * DEFAULT: anyone who may create at all, which is member and up. Set it to `admin` to
 * narrow it. A member can already create workspaces and tear them down WITH their data;
 * "you may destroy Maria's repro but not choose which interface your own listens on" is
 * not a security boundary, it is an inconsistent ladder.
 */
export const CREATE_POLICY_KEY = 'gui.create_policy';

/**
 * The fields CREATE_POLICY_KEY governs. Named here rather than inline so the check and
 * the message cannot drift apart -- and snake_case because this tuple must be identical to
 * the established one AND equal to what `/api/settings` advertises.
 */
export const PRIVILEGED_CREATE_FIELDS: readonly string[] = Object.freeze([
  'rc_image',
  'reg_token',
  'bind',
  'context',
  // An Enterprise license decides what the workspace is allowed to do, as a registration
  // token does: the same policy governs it.
  'license',
]);

/**
 * Distributions where a workspace costs money for as long as it exists, and so where
 * reaching it only by port-forward is a waste rather than a choice. Named here rather
 * than reusing `cluster.BILLABLE` because that one prices a cluster and this one warns
 * about a workspace.
 */
export const BILLABLE_DISTRIBUTIONS: readonly string[] = Object.freeze(['eks', 'gke', 'aks']);

/**
 * What `up` accepts on Compose and cannot honour on Kubernetes, with the reason.
 *
 * Each of these was ACCEPTED and silently dropped: the create succeeded, said nothing,
 * and produced a workspace that was not what was asked for. A refusal that names the
 * missing thing is worth more than a create that quietly does less.
 *
 * `https` and `domain` have LEFT this list: the chart's own Ingress template builds the
 * Ingress, cert-manager issues from a `ca` ClusterIssuer backed by houston's CA, and the
 * edge passes the name through by SNI. What refuses instead is
 * `kubernetesTlsPlan`, per cluster.
 */
export const KUBERNETES_UNSUPPORTED: readonly (readonly [string, string])[] = Object.freeze([
  [
    'fresh',
    "--fresh means DELETE this workspace's data, and the Kubernetes path keeps the " +
      'PersistentVolumeClaim — use `houston down --name <n> --volumes` first, which does ' +
      'delete it',
  ] as const,
]);

/** What `--https` needs from the cluster, once every refusal has passed. Reads only. */
export interface KubeTls {
  host: string;
  ingressClass: string;
  endpoint: IngressEndpointLike;
  /**
   * The cluster this workspace lives in, so the route step can ask whether the edge
   * needs to join its Docker network.
   */
  context: string;
  /**
   * Which ClusterIssuer this workspace's Ingress will name. `--https` and `--domain`
   * differ in this one field and nothing else.
   */
  issuer: IssuerLike | null;
  /**
   * Whether the CLUSTER is already receiving on this host's :443. When it is, the name
   * works through the cluster with no edge at all; when it is not, the edge has to own
   * :443 and pass through.
   */
  clusterOwns443: boolean;
}

/**
 * The structural shape of `kube/endpoints.ts`'s `IngressEndpoint`, restated here so this
 * leaf imports nothing. `String(endpoint)` there is `<address>:<port>`, which is what a
 * passthrough route carries.
 */
export interface IngressEndpointLike {
  readonly address: string;
  readonly port: number;
  readonly source: string;
  readonly service: string;
  readonly local: boolean;
}

/** The structural shape of `kube/certmanager.ts`'s `IssuerSpec`. */
export interface IssuerLike {
  readonly mode: string;
  readonly acmeEmail?: string;
  readonly acmeStaging?: boolean;
}

/** An endpoint as text: the `<address>:<port>` a passthrough route carries. */
export function endpointString(endpoint: IngressEndpointLike): string {
  return `${endpoint.address}:${String(endpoint.port)}`;
}

/** The `KubeTls` defaults, since a TypeScript interface has no field initialisers. */
export function kubeTls(
  values: Partial<KubeTls> & Pick<KubeTls, 'host' | 'ingressClass' | 'endpoint'>,
): KubeTls {
  return { context: '', issuer: null, clusterOwns443: false, ...values };
}

/**
 * How long the publish proof waits for the route to be LIVE, not merely written.
 *
 * Found by running it: the check fired on a chain that was completely correct and
 * reported "answered with a proxy's own default certificate", because a route file
 * appearing and Traefik's file provider having reloaded it are a second apart.
 */
export const PUBLISH_PROOF_TRIES = 8;

export const PUBLISH_PROOF_PAUSE = 1.5;

/**
 * How many consecutive ready-but-not-Rocket.Chat rounds before the port is called
 * foreign. Each round costs a `workspaceReady` probe plus a socket check, so this is
 * seconds of grace for a pod that has just passed its probe -- not a retry budget.
 *
 * On an object rather than a module-level number, following `k8s.tuning`: a test patches
 * one property and every reader resolves it at call time.
 */
export const tuning = { FOREIGN_PORT_STRIKES: 4 };
