/**
 * Shared helpers for the dynamic preset builders.
 *
 * `--set KEY=VALUE` params arrive as raw strings, so every builder needs the same small
 * coercions -- and every builder that has a Kubernetes rendering needs the same
 * Deployment/Service shape, which is written once here rather than five times.
 */
import * as YAML from 'yaml';

import * as config from '../config';
import { toInt, shownValue } from '../format';

import type { Params } from './registry';

/**
 * `doc` as YAML in the established manifest spelling, through the `yaml` package.
 *
 * Four options carry the whole equivalence and each one is a divergence that was
 * measured rather than assumed:
 *
 * - `compat: 'yaml-1.1'` -- the established emitter is a YAML 1.1 one, so `'1'`, `'true'`
 *   and `'on'` must be quoted or a 1.1 reader reads a number or a boolean back.
 * - `singleQuote: true` -- the established spelling prefers `'...'`; the library defaults
 *   to `"..."`, and a manifest full of the other spelling is a diff on every line that
 *   needs quoting.
 * - `blockQuote: false` -- the established spelling NEVER has a `|` literal block for a
 *   multi-line string; it has a folded single-quoted scalar. The library prefers `|`,
 *   which parses back to the same string and does not compare equal, and the strings
 *   involved are an entire HTML page and a Keycloak realm.
 * - `anchorPrefix: 'id00'` -- an anchor is named `id` and three digits, `id001`. The shared
 *   `labels` mapping appears twice inside one Deployment, so every manifest here has one.
 *
 * - `doubleQuotedMinMultiLineLength: Infinity` -- the library spells a `\n` inside a
 *   double-quoted scalar as a real line break once the scalar is long enough; the
 *   established spelling is always `\n`. Without this the realm JSON renders as forty
 *   folded lines against four.
 *
 * `indentSeq: false` is the one `lib/compose.ts` already established for the same reason,
 * and `lineWidth: 80` is the established default width rather than compose's `0`, because
 * these documents contain scalars long enough to fold and compose's do not.
 *
 * WHAT THIS DOES NOT CLAIM. The output is not byte-identical to the established spelling
 * for a scalar long enough to fold: the two emitters break at the same width and spell the
 * break differently -- the established one writes `\` and re-escapes a leading space, the
 * library lets the fold absorb it. Both parse back to the identical string, and the only
 * consumer of this text is `kubectl apply -f -`, so the contract is the DOCUMENT and not
 * its spelling. So these manifests compare parsed, for exactly that reason, and everything
 * else -- `files`, `env`, `services`, `notes`, `post_ready` -- compares byte for byte,
 * because those are written to disk and read back.
 */
export function safeDump(doc: unknown): string {
  return YAML.stringify(doc, {
    compat: 'yaml-1.1',
    indentSeq: false,
    lineWidth: 80,
    doubleQuotedMinMultiLineLength: Number.POSITIVE_INFINITY,
    nullStr: 'null',
    singleQuote: true,
    blockQuote: false,
    anchorPrefix: 'id00',
  });
}

/**
 * `text` read with the established safe grammar -- config.ts's YAML11_OPTIONS, the one
 * reader this build has for a YAML file.
 *
 * The yaml library's own YAML 1.1 schema is not the established one: it reads `y`, `Y`,
 * `n` and `N` as booleans, and parts ways on dotless exponents, leading-dot floats,
 * sexagesimals starting with 0 and single-digit months, so a preset whose env held `Y: 2`
 * had the key `true` where it is `'Y'`. And `uniqueKeys: false`, as on every YAML read in
 * this build: a mapping that names a key twice keeps the LAST value, where the yaml
 * library refused the document -- so a user preset with a doubled key was UNREADABLE,
 * where it is a preset.
 */
export function safeLoad(text: string): unknown {
  return config.safeLoadYaml(text);
}

/**
 * `safeLoad`, with every mapping read as a `Map` -- which keeps the order the document wrote
 * its keys in, where a plain object lists every integer-like key (`"10"`) first. For a
 * reader that prints keys in order; the keys are not stringified, so an unquoted `10` comes
 * back as the number.
 */
export function safeLoadOrdered(text: string): unknown {
  return config.safeLoadYaml(text, { mapAsMap: true });
}

/**
 * Every document in a `---`-separated stream, read with the established safe grammar.
 *
 * Splitting on the separator by hand is what a reader reaches for first and it is wrong:
 * a `---` line inside a scalar is content, not a document boundary, and the scalars here
 * are an HTML page and a Keycloak realm. The parser knows the difference.
 */
export function safeLoadAll(text: string): unknown[] {
  return YAML.parseAllDocuments(text, config.YAML11_OPTIONS).map((doc) => doc.toJS() as unknown);
}

/**
 * `config.PRESET_PORTS[name]`, as a value rather than as a `| undefined`.
 *
 * A preset with no registry entry is an error naming it, as it has always been: a preset
 * that published a port nothing had reserved is the collision `PRESET_PORTS` exists to
 * prevent, and answering `undefined` would put that port in the compose file anyway.
 */
/**
 * Email 2FA, which ldap, saml, oidc and livechat turn OFF only because a repro has no mail
 * server to send the code. A soft default: composed with `email`, which brings Mailpit and
 * turns it on, email's value wins. See `composite.ts`.
 */
export const EMAIL_2FA = 'OVERWRITE_SETTING_Accounts_TwoFactorAuthentication_By_Email_Enabled';

/**
 * A preset's host ports in one workspace: the ones `ports` gives it, else the registry's.
 *
 * `ports` is REQUIRED, and sparse: `{}` is every preferred port, `{ email: [8026] }` moves
 * Mailpit alone. Required so a builder that never received the workspace's ports does not
 * quietly publish the preferred ones, which would open someone else's Mailpit.
 */
export function presetPorts(name: string, ports: config.PortMap): readonly number[] {
  const given = ports[name] ?? config.PRESET_PORTS[name];
  if (given === undefined)
    throw new Error(`no port is reserved for the preset ${JSON.stringify(name)}`);
  return given;
}

/** One of a preset's host ports -- the first is the one a single-port preset publishes. */
export function presetPort(name: string, index: number, ports: config.PortMap): number {
  const all = presetPorts(name, ports);
  const port = all[index];
  if (port === undefined) {
    throw new Error(
      `the preset ${JSON.stringify(name)} has no reserved port at index ${String(index)}`,
    );
  }
  return port;
}

/** Read a boolean `--set` param ("1"/"true"/"yes"/"on", case-insensitive). */
export function truthyParam(params: Params, key: string, fallback = false): boolean {
  const value = params[key];
  // Absent or `--set key=` -> the default.
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

/**
 * Read an integer `--set` param; empty or absent -> the default.
 *
 * A non-numeric value raises a message the CLI shows verbatim rather than a stack trace,
 * so the message itself is the contract -- including the shown text of the value, which is why
 * `shownValue` is here and `String()` is not.
 */
export function intParam(params: Params, key: string, fallback: number): number {
  const value = params[key];
  if (value === null || value === undefined || value === '') return fallback;
  // `toInt`, whose TypeError or InvalidValue RangeError is the refusal -- not an ASCII pattern:
  // `--set users=1_0` is 10 and `users=٣` is 3, and the ldap help's "try 130000 for scale"
  // is naturally typed 130_000 -- each was refused by the pattern this replaced.
  // An OutOfRange error (an infinite float from a JSON body) is neither, and is not caught.
  try {
    return toInt(value);
  } catch (error) {
    if ((error as Error).name === 'OutOfRange') throw error;
    // The shown text of whatever arrived: a JSON body can send a list, which it brackets.
    throw new Error(`--set ${key}=${shownValue(value)} expects a whole number`, {
      cause: error,
    });
  }
}

/** Read a `--set` param that must be one of `choices`; empty or absent -> the first. */
export function choiceParam(params: Params, key: string, choices: readonly string[]): string {
  const value = params[key];
  const fallback = choices[0] ?? '';
  if (value === null || value === undefined || String(value).trim() === '') return fallback;
  const chosen = String(value).trim().toLowerCase();
  if (!choices.includes(chosen)) {
    throw new Error(`--set ${key}=${shownValue(value)} expects one of: ${choices.join(', ')}`);
  }
  return chosen;
}

/** Read a string `--set` param; empty or absent -> the default. */
export function strParam(params: Params, key: string, fallback: string): string {
  const value = params[key];
  if (value === null || value === undefined || String(value) === '') return fallback;
  return String(value);
}

/** A host port paired with the container port that serves it. */
export type PortPair = readonly [number, number];

type Bag = Record<string, unknown>;

/** Build the pod spec, including its optional file mount and readiness signal. */
function containerSpec(
  name: string,
  image: string,
  ports: readonly PortPair[],
  env: Record<string, unknown> | undefined,
  args: readonly unknown[] | undefined,
  mounts: readonly Bag[] | undefined,
  readiness: Bag | undefined,
): Bag {
  const container: Bag = {
    name,
    image,
    ports: ports.map(([, containerPort]) => ({ containerPort })),
  };
  if (env !== undefined && Object.keys(env).length > 0) {
    container.env = Object.entries(env).map(([k, v]) => ({ name: k, value: String(v) }));
  }
  if (args !== undefined && args.length > 0) container.args = args.map((a) => String(a));
  // A readiness probe is what makes "ready endpoint" mean anything. Without one a pod is
  // Ready as soon as its container starts, and every consumer downstream -- the Service's
  // endpoints, the port-forward, post_ready -- trusts a signal that has not been earned.
  if (readiness !== undefined && Object.keys(readiness).length > 0) {
    container.readinessProbe = readiness;
  }
  const pod: Bag = { containers: [container] };
  if (mounts !== undefined && mounts.length > 0) {
    container.volumeMounts = mounts;
    pod.volumes = [{ name: 'files', configMap: { name: `${name}-files` } }];
  }
  return pod;
}

/** Append the primary Service and any extra host-published Service. */
function appendServices(
  docs: Bag[],
  name: string,
  ports: readonly PortPair[],
  ui: Record<string, PortPair> | undefined,
  labels: Record<string, string>,
): void {
  const app = labels.app;
  // THE PRIMARY SERVICE CARRIES EVERY PORT THE WORKLOAD LISTENS ON, not only the ones
  // published to the host. On Compose, container-to-container traffic reaches any port
  // directly, so `mailpit:1025` just works. A Kubernetes Service forwards ONLY its
  // declared ports -- so publishing the web UI and nothing else gave a workspace whose
  // Mailpit was reachable from the browser and unreachable from Rocket.Chat, which is
  // where the mail actually has to come from.
  //
  // Reported from a live workspace: SMTP_Host=mailpit, SMTP_Port=1025, container
  // listening on 1025, Service exposing 8025 alone.
  //
  // The Service speaks CONTAINER ports, the way Compose's network does; the `ui-port`
  // label is what says which host port publishes one.
  const rest: Record<string, PortPair> = { ...(ui ?? {}) };
  const primaryUi = rest[name];
  delete rest[name];
  const ordered = [...ports];
  if (primaryUi !== undefined) {
    // The published port first: the lifecycle's forwarder reads .spec.ports[0]. A stable
    // sort on a boolean key, so the rest keep their declared order.
    const rank = (pair: PortPair) => (pair[1] !== primaryUi[1] ? 1 : 0);
    ordered.sort((a, b) => rank(a) - rank(b));
  }
  const primaryLabels: Record<string, string> = { ...labels };
  if (primaryUi !== undefined) primaryLabels['houston.io/ui-port'] = String(primaryUi[0]);
  docs.push({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, labels: primaryLabels },
    spec: {
      selector: { app },
      ports: ordered.map(([, cport]) => ({
        name: `p${String(cport)}`,
        port: cport,
        targetPort: cport,
      })),
    },
  });
  // Any REMAINING ui entry is a second published port on the same workload, which needs
  // its own Service because a label value cannot carry a list.
  for (const [svcName, [host, containerPort]] of Object.entries(rest)) {
    const svcLabels: Record<string, string> = { ...labels };
    svcLabels['houston.io/ui-port'] = String(host);
    svcLabels['houston.io/ui-deployment'] = name;
    docs.push({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: svcName, labels: svcLabels },
      spec: {
        selector: { app },
        ports: [{ name: 'http', port: containerPort, targetPort: containerPort }],
      },
    });
  }
}

export interface K8sManifestOptions {
  readonly name: string;
  readonly image: string;
  readonly ports: readonly PortPair[];
  readonly env?: Record<string, unknown>;
  readonly args?: readonly unknown[];
  readonly files?: Record<string, string>;
  readonly mounts?: readonly Bag[];
  /** Service name -> the host port it should be published on. */
  readonly ui?: Record<string, PortPair>;
  readonly readiness?: Bag;
  readonly workspace?: string;
  /**
   * A PersistentVolumeClaim mounted at `path`: what the Compose twin keeps in a named volume.
   * `fsGroup` makes a fresh claim writable by an image that runs as that uid, not root.
   */
  readonly data?: { readonly path: string; readonly size: string; readonly fsGroup?: number };
}

/**
 * One Deployment + one Service per exposed port, from the same shape every scenario
 * adapter needs.
 *
 * `ui` maps a Service name to the host port it should be published on; the lifecycle
 * reads `houston.io/ui-port` and forwards it. `houston.io/ui-deployment` names the
 * workload when the Service is not called after it -- MinIO serves an API and a console
 * from one Deployment, and a label value cannot contain a comma.
 *
 * ONE `labels` OBJECT, SHARED. The Deployment names it twice, and the emitter writes the
 * second reference as an alias; building a second identical object here would render the
 * same meaning as different text.
 */
export function k8sManifests(options: K8sManifestOptions): string {
  const { name, image, ports, env, args, files, mounts, ui, readiness } = options;
  const workspace = options.workspace ?? '__HOUSTON_NAME__';
  const app = `houston-${name}`;
  const labels: Record<string, string> = {
    app,
    'app.kubernetes.io/managed-by': 'houston',
    'houston.io/component': name,
    'houston.io/repro': workspace,
  };
  const docs: Bag[] = [];
  if (files !== undefined && Object.keys(files).length > 0) {
    docs.push({
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name: `${name}-files`, labels },
      data: { ...files },
    });
  }
  const pod = containerSpec(name, image, ports, env, args, mounts, readiness);
  const spec: Bag = {
    replicas: 1,
    selector: { matchLabels: { app } },
    template: { metadata: { labels }, spec: pod },
  };
  // THE CONTAINER'S OWN FILESYSTEM DIES WITH THE POD, and `stop` scales to zero. MinIO kept
  // its objects AND its bucket there, so the first stop/start emptied the workspace's
  // uploads for good. A claim survives a scale to zero and a data-keeping `down`, and goes
  // with the namespace on `down --volumes` -- the Compose named volume's lifetime. The
  // cluster's default StorageClass, as MongoDB's claim uses. Recreate, because a
  // ReadWriteOnce claim is one writer's: a rolling update would start the new pod beside
  // the old one holding it.
  if (options.data !== undefined) {
    const claim = `${name}-data`;
    docs.push({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: claim, labels },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: options.data.size } },
      },
    });
    const container = (pod.containers as Bag[])[0] as Bag;
    container.volumeMounts = [
      ...((container.volumeMounts as Bag[] | undefined) ?? []),
      { name: 'data', mountPath: options.data.path },
    ];
    pod.volumes = [
      ...((pod.volumes as Bag[] | undefined) ?? []),
      { name: 'data', persistentVolumeClaim: { claimName: claim } },
    ];
    // A provisioned filesystem is root's, 0755: a non-root image could not write a byte.
    if (options.data.fsGroup !== undefined) pod.securityContext = { fsGroup: options.data.fsGroup };
    spec.strategy = { type: 'Recreate' };
  }
  docs.push({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, labels },
    spec,
  });
  appendServices(docs, name, ports, ui, labels);
  return docs.map((doc) => safeDump(doc)).join('---\n');
}
