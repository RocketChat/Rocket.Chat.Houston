/**
 * Monitoring add-on: Prometheus + Grafana with Rocket.Chat metrics.
 *
 * The part `compose.ts` needs. Layered onto ANY repro (via `up --monitor` at creation, or
 * `houston monitor` to attach to a running one) rather than being its own preset: monitoring
 * is cross-cutting, and Prometheus must scrape whatever RC topology exists (a single
 * `rocketchat`, or `rocketchat-1..N` for multi-instance).
 *
 * SCOPE. `services()`, `volumes()`, `bindPorts()` and the metrics setting are what
 * `compose.build` calls. The config FILES this add-on writes into a workspace --
 * `prometheus.yml`, the three file-SD target lists, the Grafana provisioning tree, the
 * Loki and OTel configs and five dashboards -- are below. Nothing in the compose document
 * depends on their CONTENTS, only on the mount paths.
 *
 * ## The embedded configs are transcribed, so they are extracted rather than retyped
 *
 * Six YAML documents live as string constants, and one of them -- the OTel collector config
 * -- contains backticks, which a TypeScript template literal ends on. They were lifted out
 * of an earlier release mechanically rather than by hand, and the spec compares the written
 * files with the established ones byte for byte, because a transcription is exactly the
 * kind of thing that looks right and differs by one space of indentation.
 */

import * as fs from 'node:fs';

import { MONITOR_PORTS, dataPath } from './config';

/** Service + volume names, so attach/detach can find and remove them. */
export const SERVICES: readonly string[] = Object.freeze([
  'prometheus',
  'grafana',
  'node-exporter',
  'mongodb-exporter',
  'loki',
  'opentelemetry-logs-collector',
]);

export const VOLUMES: readonly string[] = Object.freeze([
  'prometheus_tsdb',
  'grafana_data',
  'loki_data',
]);

/**
 * RC setting that opens the /metrics endpoint on :9458 -- used both as an API setting
 * id (attach, live toggle) and as the OVERWRITE_SETTING env (`up --monitor`).
 */
export const RC_METRICS_SETTING = 'Prometheus_Enabled';
export const RC_METRICS_ENV = `OVERWRITE_SETTING_${RC_METRICS_SETTING}`;

const PROM_PORT = MONITOR_PORTS[0];
const GRAFANA_PORT = MONITOR_PORTS[1];

// Pinned to the official compose.monitoring.yml defaults (multi-arch).
const PROMETHEUS_IMAGE = 'docker.io/prom/prometheus:v3.4.2';
const GRAFANA_IMAGE = 'docker.io/grafana/grafana:12.0.2';
const NODE_EXPORTER_IMAGE = 'docker.io/prom/node-exporter:v1.9.1';
const MONGODB_EXPORTER_IMAGE = 'docker.io/percona/mongodb_exporter:0.43.1';
// Logs stack, mirroring RocketChat/rocketchat-compose (compose.monitoring.yml).
const LOKI_IMAGE = 'docker.io/grafana/loki:3.6';
const OTELCOL_IMAGE = 'docker.io/otel/opentelemetry-collector-contrib:0.143.0';

type Service = Record<string, unknown>;

function prometheus(port: number): Service {
  return {
    image: PROMETHEUS_IMAGE,
    command: [
      '--config.file=/etc/prometheus/prometheus.yml',
      '--web.enable-lifecycle',
      '--storage.tsdb.retention.time=15d',
      // Accept pushed metrics: loadtest --live streams k6 results here, so client-side
      // load sits next to RC metrics in Grafana.
      '--web.enable-remote-write-receiver',
    ],
    volumes: [
      './monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro',
      './monitoring/file_sd_configs:/etc/prometheus/file_sd_configs:ro',
      'prometheus_tsdb:/prometheus',
    ],
    ports: [`${String(port)}:9090`],
    restart: 'unless-stopped',
  };
}

/**
 * The browser URL; a Kubernetes forward also reaches Grafana under /grafana. `port` is the
 * workspace's Grafana host port (`extra.monitoring_ports`); the default is the preferred one.
 */
export function grafanaUrl(publicUrl = '', subPath = false, port: number = GRAFANA_PORT): string {
  const local = `http://localhost:${String(port)}`;
  return subPath ? `${(publicUrl || local).replace(/\/+$/u, '')}/grafana` : local;
}

function grafana(publicUrl: string, port: number): Service {
  return {
    image: GRAFANA_IMAGE,
    environment: {
      GF_SECURITY_ADMIN_USER: 'admin',
      GF_SECURITY_ADMIN_PASSWORD: 'admin',
      // Anonymous read access so the dashboard opens with no login (local repro).
      GF_AUTH_ANONYMOUS_ENABLED: 'true',
      GF_AUTH_ANONYMOUS_ORG_ROLE: 'Viewer',
      // Allow the houston web GUI to embed the k6 dashboard in an iframe.
      GF_SECURITY_ALLOW_EMBEDDING: 'true',
      ...(publicUrl
        ? {
            GF_SERVER_ROOT_URL: `${grafanaUrl(publicUrl, true)}/`,
            GF_SERVER_SERVE_FROM_SUB_PATH: 'true',
          }
        : {}),
    },
    volumes: [
      './monitoring/grafana/provisioning:/etc/grafana/provisioning:ro',
      './monitoring/grafana/dashboards:/dashboards:ro',
      'grafana_data:/var/lib/grafana',
    ],
    ports: [`${String(port)}:3000`],
    depends_on: ['prometheus'],
    restart: 'unless-stopped',
  };
}

/**
 * Host/OS metrics, portably scraped over the compose network.
 *
 * The official compose runs this in host-network mode on Linux; houston uses the
 * compose network so Prometheus scrapes it at `node-exporter:9100` portably on
 * Mac/Windows/Linux (metrics reflect the Docker VM there rather than the bare host --
 * fine for a local repro).
 */
function nodeExporter(): Service {
  return {
    image: NODE_EXPORTER_IMAGE,
    command: [
      '--path.procfs=/host/proc',
      '--path.sysfs=/host/sys',
      '--path.rootfs=/rootfs',
      '--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($$|/)',
    ],
    volumes: ['/proc:/host/proc:ro', '/sys:/host/sys:ro', '/:/rootfs:ro'],
    restart: 'unless-stopped',
  };
}

/**
 * MongoDB metrics from the single replica-set node. Houston's Mongo has no auth
 * (ALLOW_EMPTY_PASSWORD), so a plain `directConnection` URI is both sufficient and
 * intentional.
 */
function mongodbExporter(): Service {
  return {
    image: MONGODB_EXPORTER_IMAGE,
    command: [
      '--mongodb.uri=mongodb://mongodb:27017/?directConnection=true',
      '--collect-all',
      '--compatible-mode',
    ],
    depends_on: ['mongodb'],
    restart: 'unless-stopped',
  };
}

/** The internal-only Loki half of the log stack. */
function loki(): Service {
  return {
    image: LOKI_IMAGE,
    command: '-config.file=/etc/loki/config.yaml -config.expand-env=true',
    user: '0',
    volumes: ['./monitoring/loki/config.yaml:/etc/loki/config.yaml:ro', 'loki_data:/data/loki:rw'],
    restart: 'unless-stopped',
  };
}

function opentelemetryLogsCollector(): Service {
  return {
    image: OTELCOL_IMAGE,
    command: ['--config=/etc/otel-collector-config.yaml'],
    user: '0',
    volumes: [
      './monitoring/otel/config.yaml:/etc/otel-collector-config.yaml:ro',
      // discover + tail this repro's containers (host/VM paths, like node-exporter)
      '/var/run/docker.sock:/var/run/docker.sock:ro',
      '/var/lib/docker/containers:/hostfs/storage:ro',
    ],
    depends_on: ['loki'],
    restart: 'unless-stopped',
  };
}

/**
 * The monitoring compose services with BARE `host:container` ports. The caller binds
 * them to the host interface (`compose.bindPorts` for `up --monitor`, or the attach
 * path directly) so they are never double-bound.
 */
export function services(
  publicUrl = '',
  [prometheusPort, grafanaPort]: readonly number[] = MONITOR_PORTS,
): Record<string, Service> {
  return {
    prometheus: prometheus(prometheusPort ?? PROM_PORT),
    grafana: grafana(publicUrl, grafanaPort ?? GRAFANA_PORT),
    'node-exporter': nodeExporter(),
    'mongodb-exporter': mongodbExporter(),
    loki: loki(),
    'opentelemetry-logs-collector': opentelemetryLogsCollector(),
  };
}

/**
 * Prefix each service's published ports with `bindHost`. Services with no published
 * ports (the exporters) are left untouched. Used by the attach path; `up --monitor`
 * binds through `compose.bindPorts` instead.
 */
export function bindPorts(
  svcs: Record<string, Service>,
  bindHost: string,
): Record<string, Service> {
  for (const svc of Object.values(svcs)) {
    const ports = svc.ports;
    if (bindHost && Array.isArray(ports) && ports.length > 0) {
      svc.ports = ports.map((p) => `${bindHost}:${String(p)}`);
    }
  }
  return svcs;
}

export function volumes(): Record<string, { driver: string }> {
  const out: Record<string, { driver: string }> = {};
  for (const name of VOLUMES) out[name] = { driver: 'local' };
  return out;
}

const PROMETHEUS_YML = `# Generated by houston (mirrors RocketChat/rocketchat-compose).
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: file_sd_configs
    file_sd_configs:
      - refresh_interval: 15s
        files:
          - /etc/prometheus/file_sd_configs/*.yml
`;

const DATASOURCE_YML = `apiVersion: 1
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
    uid: DS_PROMETHEUS
`;

const DASHBOARDS_YML = `apiVersion: 1
providers:
  - name: 'default'
    orgId: 1
    folder: ''
    type: file
    disableDeletion: true
    updateIntervalSeconds: 30
    allowUiUpdates: false
    options:
      path: /dashboards
      foldersFromFilesStructure: true
`;

const LOKI_YML = `auth_enabled: false
server:
  http_listen_port: 3100
common:
  replication_factor: 1
  path_prefix: /data/loki
  storage:
    filesystem:
      chunks_directory: /data/loki/chunks
      rules_directory: /data/loki/rules
  ring:
    kvstore:
      store: inmemory
schema_config:
  configs:
    - from: 2020-10-24
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h
compactor:
  retention_enabled: true
  compaction_interval: 10m
  retention_delete_delay: 2h
  retention_delete_worker_count: 100
  delete_request_store: filesystem
pattern_ingester:
  enabled: true
limits_config:
  allow_structured_metadata: true
  volume_enabled: true
  retention_period: 15d
ruler:
  enable_api: true
distributor:
  otlp_config:
    default_resource_attributes_as_index_labels:
      - job
      - cluster.name
      - k8s.namespace.name
      - k8s.pod.name
      - k8s.container.name
      - k8s.deployment.name
`;

const OTELCOL_TMPL = `extensions:
  docker_observer:
    endpoint: "unix:///var/run/docker.sock"
receivers:
  receiver_creator:
    watch_observers: [docker_observer]
    receivers:
      filelog:
        rule: type == "container" and labels["com.docker.compose.project"] == "__PROJECT__"
        config:
          include:
            - /hostfs/storage/\`container_id\`/**/*.log
          include_file_path: true
          start_at: beginning
          operators:
            - type: router
              id: log_router
              routes:
                - output: parser_docker
                  expr: 'body matches "^{"'
                - output: parser_cri
                  expr: 'not(body matches "^{")'
            - type: json_parser
              id: parser_docker
              parse_from: body
              timestamp:
                parse_from: attributes.time
                layout_type: gotime
                layout: "2006-01-02T15:04:05.999999999Z07:00"
              output: extract_metadata
            - type: regex_parser
              id: parser_cri
              regex: "^(?P<time>[^ ]+) (?P<stream>stdout|stderr) (?P<logtag>[^ ]+) ?(?P<log>.*)$"
              timestamp:
                parse_from: attributes.time
                layout_type: gotime
                layout: "2006-01-02T15:04:05.999999999Z07:00"
            - type: recombine
              combine_field: attributes.log
              is_last_entry: "attributes.logtag == 'F'"
              source_identifier: attributes["log.file.path"]
            - type: noop
              id: extract_metadata
            - type: move
              from: attributes.log
              to: body
            - type: add
              field: resource["k8s.container.name"]
              value: '\`name\`'
            - type: add
              field: resource["k8s.deployment.name"]
              value: '\`labels["com.docker.compose.service"]\`'
            - type: add
              field: resource["k8s.pod.name"]
              value: '\`labels["com.docker.compose.service"]\`'
            - type: add
              field: resource["k8s.namespace.name"]
              value: '\`labels["com.docker.compose.project"]\`'
processors:
  resource:
    attributes:
      - key: job
        value: "logs"
        action: upsert
      - key: cluster.name
        value: "houston"
        action: upsert
exporters:
  otlphttp:
    endpoint: "http://loki:3100/otlp"
service:
  extensions: [docker_observer]
  pipelines:
    logs:
      receivers: [receiver_creator]
      processors: [resource]
      exporters: [otlphttp]
`;

const LOKI_DATASOURCE_YML = `apiVersion: 1
datasources:
  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
    uid: DS_LOKI
    editable: false
`;

/** A Prometheus file-SD target block. */
export function sd(targets: readonly string[], job: string): string {
  const lines = [`# Generated by houston. Prometheus scrape targets (${job}).`, '- targets:'];
  for (const t of targets) lines.push(`    - ${t}`);
  lines.push('  labels:', `    job: ${job}`, `    service: ${job}`);
  return lines.join('\n') + '\n';
}

/**
 * One shipped Grafana dashboard, read from package data.
 *
 * `config.dataPath` rather than a path relative to the checkout: this tree has no bundler
 * precisely because one rewrites this lookup, and a dashboard that cannot be found
 * is a Grafana with an empty folder and no error anybody sees.
 */
export function dashboard(name: string): string {
  return fs.readFileSync(dataPath('monitoring', name), 'utf8');
}

/**
 * Config files written into the repro workspace, as [relative path, contents].
 *
 * Prometheus scrapes RC/Mongo/host via file-SD; Loki and the OTel collector ship this
 * repro's container logs, and the collector is SCOPED TO `project` so it never ingests
 * another workspace's -- or a real deployment's -- logs off the same docker socket.
 */
export function files(rcServices: readonly string[], project = ''): [string, string][] {
  return [
    ['monitoring/prometheus.yml', PROMETHEUS_YML],
    [
      'monitoring/file_sd_configs/rocketchat.yml',
      sd(
        rcServices.map((s2) => `${s2}:9458`),
        'rocketchat',
      ),
    ],
    ['monitoring/file_sd_configs/mongo.yml', sd(['mongodb-exporter:9216'], 'mongodb')],
    ['monitoring/file_sd_configs/node-exporter.yml', sd(['node-exporter:9100'], 'node-exporter')],
    ['monitoring/grafana/provisioning/datasources/prometheus.yml', DATASOURCE_YML],
    ['monitoring/grafana/provisioning/datasources/loki.yml', LOKI_DATASOURCE_YML],
    ['monitoring/grafana/provisioning/dashboards/from-dir.yml', DASHBOARDS_YML],
    ['monitoring/grafana/dashboards/rocketchat-metrics.json', dashboard('rocketchat-metrics.json')],
    ['monitoring/grafana/dashboards/node-exporter-full.json', dashboard('node-exporter-full.json')],
    ['monitoring/grafana/dashboards/mongodb-exporter.json', dashboard('mongodb-exporter.json')],
    // Client-side load metrics streamed by `loadtest --live` (remote-write).
    ['monitoring/grafana/dashboards/k6-loadtest.json', dashboard('k6-loadtest.json')],
    // Container logs (Loki) -- a dashboard so it is visible without Explore/login.
    ['monitoring/grafana/dashboards/houston-logs.json', dashboard('houston-logs.json')],
    // Logs stack.
    ['monitoring/loki/config.yaml', LOKI_YML],
    ['monitoring/otel/config.yaml', OTELCOL_TMPL.replace('__PROJECT__', project)],
  ];
}

/** What `up --monitor` prints once the stack is attached, for its Grafana and Prometheus. */
export function notes(url = grafanaUrl(), prometheusPort: number = PROM_PORT): string[] {
  return [
    `Grafana:    ${url}  (admin/admin; anonymous view enabled)`,
    `Prometheus: http://localhost:${String(prometheusPort)}  (Status -> Targets: rocketchat, mongodb, node-exporter)`,
    'Dashboards auto-provisioned: Rocket.Chat Metrics, MongoDB, Node Exporter Full.',
    'k6 Load Test dashboard is provisioned too; it fills in while a ' +
      '`loadtest --live` run streams metrics.',
    `Container logs -> Loki: open the 'Rocket.Chat Logs' dashboard in Grafana ` +
      `(${url}/d/houston-logs) - no login needed.`,
  ];
}

/** Detach recognises the generated lines even when the recorded hostname changed. */
export function isMonitoringNote(note: unknown): boolean {
  if (typeof note !== 'string') return false;
  return (
    notes().includes(note) ||
    /^Grafana: {4}https?:\/\/\S+ {2}\(admin\/admin; anonymous view enabled\)$/u.test(note) ||
    // A workspace whose Prometheus took another port than the preferred one.
    /^Prometheus: http:\/\/localhost:\d+ {2}\(Status -> Targets: rocketchat, mongodb, node-exporter\)$/u.test(
      note,
    ) ||
    /^Container logs -> Loki: open the 'Rocket.Chat Logs' dashboard in Grafana \(https?:\/\/\S+\/d\/houston-logs\) - no login needed\.$/u.test(
      note,
    )
  );
}
