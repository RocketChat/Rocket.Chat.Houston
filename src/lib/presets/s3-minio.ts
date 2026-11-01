/**
 * Dynamic `s3_minio` preset: a MinIO S3-compatible object store wired to Rocket.Chat's
 * file upload storage.
 *
 * Reproduces external-object-storage tickets: uploads failing, broken previews,
 * bucket/path-style/signature misconfigurations and -- the classic -- presigned URLs the
 * browser cannot reach.
 *
 * THE GOTCHA (same class as the oidc preset): the S3 endpoint URL is used by RC's backend
 * (uploads) AND, in presigned mode, by the browser (downloads). The default mode
 * sidesteps it by proxying downloads through RC (FileUpload_S3_Proxy_*=true) -- zero
 * setup, works out of the box. `--set presigned=true` switches to real presigned MinIO
 * URLs, which needs the hosts entry `127.0.0.1  minio` (printed on `up`) -- and IS the
 * faithful repro for presigned-URL tickets: remove the hosts line and previews break
 * exactly like the customer's.
 *
 * Uploaded objects live in the `minio_data` named volume (via `Preset.volumes`), so files
 * survive `down`/`up` just like Mongo data -- no dangling attachment cards whose objects
 * vanished.
 *
 * Parameters (via `--set`):
 *   presigned   serve downloads via presigned MinIO URLs instead of proxying through RC
 *               (default false; needs the /etc/hosts line).
 *   bucket      bucket name (default houston-uploads).
 */
import type { PortMap } from '../config';
import { shownValue } from '../format';

import { guide } from './guides';
import { k8sManifests, presetPort, safeDump, strParam, truthyParam } from './common';
import { type Params, register } from './registry';
import { emptyPreset, type Preset } from './types';

/**
 * S3 bucket naming rules (also keeps the name shell-safe in minio-init).
 *
 * `\n?$` is not decoration: the established rule's `$` matches at the end of the string OR
 * before a single trailing newline, and JavaScript's does not. Reproduced rather than
 * tightened, because this must accept exactly the names that have always been accepted --
 * and the extra character that `$` admits can only be the last one, so it ends the `sh -c`
 * line rather than extending it.
 */
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\n?$/u;

/**
 * What MinIO's S3 API listens on when told nothing. Both of its ports are the SAME inside the
 * container and on the host: Rocket.Chat and (presigned) the browser follow one BucketURL, so
 * a workspace given another API port must make MinIO listen there (`serverArgs`).
 */
const MINIO_DEFAULT_API_PORT = 9000;
const USER = 'houston';
/** MinIO requires >= 8 chars; throwaway repro creds. */
const PASSWORD = 'houston-secret';
// MinIO's own images are gone from Docker Hub (docker.io/minio/minio and minio/mc answer
// 404), so this runs PGSTY's community build of the same MinIO server and mc client: the
// upstream entrypoint, `/data` volume and arguments, from github.com/pgsty. Pinned
// multi-arch (amd64/arm64) tags -- verified via docker manifest inspect.
const MINIO_TAG = 'RELEASE.2026-08-04T00-00-00Z';
const MC_TAG = 'RELEASE.2026-08-04T00-00-00Z';

/**
 * The Kubernetes twin of the compose `minio-init` service.
 *
 * It had no twin, and nothing said so. On Compose a one-shot container waits for MinIO
 * and runs `mc mb -p`; the Kubernetes adapter rendered only the MinIO Deployment, so the
 * bucket was NEVER created -- while the workspace's own notes said "bucket '<name>' is
 * created automatically; watch uploads land in it". MinIO does not create buckets on
 * demand and neither does Rocket.Chat, so every upload on that runtime had nowhere to go.
 *
 * A Job rather than an init container: an init container runs BEFORE its pod's main
 * container, so it would wait for a MinIO that cannot start until it finishes. Same
 * image, same idempotent `mc mb -p`, same wait loop as Compose.
 */
function bucketJob(bucket: string, s3Port: number, workspace = '__HOUSTON_NAME__'): string {
  const app = 'houston-minio-init';
  const labels: Record<string, string> = {
    app,
    'app.kubernetes.io/managed-by': 'houston',
    'houston.io/component': 'minio-init',
    'houston.io/repro': workspace,
  };
  return safeDump({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: 'minio-init', labels },
    spec: {
      // Retries rather than one attempt: the Job is applied at the same time as the
      // Deployment, so its first run legitimately races MinIO starting.
      backoffLimit: 10,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'OnFailure',
          containers: [
            {
              name: 'minio-init',
              image: `docker.io/pgsty/mc:${MC_TAG}`,
              command: [
                'sh',
                '-c',
                `until mc alias set local http://minio:${String(s3Port)} ` +
                  `${USER} ${PASSWORD}; do sleep 2; done; ` +
                  `mc mb -p local/${bucket}`,
              ],
            },
          ],
        },
      },
    },
  });
}

/** What a presigned-URL setup needs the reader to know, and the proxy it wants. */
function presignedNotes(
  bucket: string,
  presigned: boolean,
  s3Host: string,
  [s3Port, consolePort]: readonly [number, number],
): string[] {
  const notes = [
    `MinIO console: http://localhost:${String(consolePort)}  (${USER} / ${PASSWORD})`,
    `  — bucket '${bucket}' is created automatically; watch uploads land in it.`,
    'Upload any file/image in RC; it goes to MinIO instead of GridFS.',
  ];
  if (presigned && s3Host === 'minio') {
    notes.push(
      'PRESIGNED MODE: the browser fetches files straight from MinIO, so add',
      'this line to /etc/hosts (needs sudo):',
      '    127.0.0.1  minio',
      '  That entry works only for a browser on the machine running houston. From',
      '  another computer, re-create with:  --bind 0.0.0.0 --set s3_host=<this host>',
      "Remove the line to reproduce the classic 'presigned URL unreachable'",
      'ticket symptom (uploads work, previews/downloads break).',
    );
  } else if (presigned) {
    notes.push(
      'PRESIGNED MODE: the browser fetches files straight from ' +
        `http://${s3Host}:${String(s3Port)}, so no hosts entry is needed — but that`,
      '  address must be reachable from the browser (`--bind 0.0.0.0`).',
      "Point s3_host somewhere unreachable to reproduce the classic 'presigned",
      "  URL unreachable' ticket symptom (uploads work, previews break).",
    );
  } else {
    notes.push(
      'Downloads are proxied through RC (no hosts entry needed). For real',
      'presigned-URL behaviour: --set presigned=true (reproduces that ticket class).',
    );
  }
  return notes;
}

/** Every Rocket.Chat setting that points file uploads at this bucket. */
function s3Settings(
  bucket: string,
  presigned: boolean,
  s3Host: string,
  s3Port: number,
): Record<string, string> {
  return {
    OVERWRITE_SETTING_FileUpload_Storage_Type: 'AmazonS3',
    OVERWRITE_SETTING_FileUpload_S3_Bucket: bucket,
    // The ENDPOINT, with no bucket on it, even though docs.rocket.chat/docs/minio spells
    // the format as `http://[your.minio.domain/bucketname]`. Bucket is already passed
    // separately, and with ForcePathStyle the client builds {endpoint}/{bucket}/{key} --
    // so a bucket in the endpoint is repeated as a key prefix. Measured on 7.13.6 by
    // uploading a file and reading MinIO's own layout:
    //
    //   with the bucket   -> houston-uploads/houston-uploads/<instance>/uploads/...
    //   without it        -> houston-uploads/<instance>/uploads/...
    //
    // Both upload successfully -- MinIO is happy to treat it as a prefix -- which is why
    // this went unnoticed. It is still every object nested one level deeper than it
    // should be, under a directory named after its own bucket.
    OVERWRITE_SETTING_FileUpload_S3_BucketURL: `http://${s3Host}:${String(s3Port)}`,
    OVERWRITE_SETTING_FileUpload_S3_AWSAccessKeyId: USER,
    OVERWRITE_SETTING_FileUpload_S3_AWSSecretAccessKey: PASSWORD,
    OVERWRITE_SETTING_FileUpload_S3_Region: 'us-east-1', // MinIO default
    OVERWRITE_SETTING_FileUpload_S3_ForcePathStyle: 'true', // mandatory for MinIO
    // v2, which is what docs.rocket.chat/docs/minio prescribes -- and NOT a cosmetic
    // choice. RC 7.13.x bundles aws-sdk v2 (there is no @aws-sdk directory in the image
    // at all), which honours this setting; asking it for v4 makes the very first
    // upload-store call raise
    //
    //   Non-file stream objects are not supported with SigV4
    //
    // during startup, and Rocket.Chat then never finishes booting. Measured on 7.13.6 +
    // s3_minio: with v4 it never served in 300s and /api/info refused the connection;
    // with v2 it answered 200 in ~35s and the error was gone.
    //
    // Newer releases moved to @aws-sdk/client-s3, which always signs SigV4 and ignores
    // this setting -- so v2 is correct on old images and inert on new ones, which is why
    // 8.5.1 never showed the fault.
    OVERWRITE_SETTING_FileUpload_S3_SignatureVersion: 'v2',
    // Default: stream files through RC so the browser never needs to reach MinIO.
    // Presigned mode: real presigned URLs (the faithful flow).
    OVERWRITE_SETTING_FileUpload_S3_Proxy_Uploads: presigned ? 'false' : 'true',
    OVERWRITE_SETTING_FileUpload_S3_Proxy_Avatars: presigned ? 'false' : 'true',
  };
}

/**
 * `minio server`'s arguments: the console on its port, and the S3 API on its own only when that
 * is not MinIO's default, so a workspace on the preferred ports runs the command it always did.
 */
function serverArgs(s3Port: number, consolePort: number): string[] {
  return [
    'server',
    '/data',
    '--console-address',
    `:${String(consolePort)}`,
    ...(s3Port === MINIO_DEFAULT_API_PORT ? [] : ['--address', `:${String(s3Port)}`]),
  ];
}

/** The same MinIO as native Kubernetes resources. */
function minioManifests(s3Port: number, consolePort: number): string {
  return k8sManifests({
    name: 'minio',
    image: `docker.io/pgsty/minio:${MINIO_TAG}`,
    ports: [
      [s3Port, s3Port],
      [consolePort, consolePort],
    ],
    env: { MINIO_ROOT_USER: USER, MINIO_ROOT_PASSWORD: PASSWORD },
    args: serverArgs(s3Port, consolePort),
    // The bucket is a directory in here, so keeping /data keeps it too: the one-shot
    // `minio-init` Job never runs again, and nothing else would recreate it.
    data: { path: '/data', size: '2Gi' },
    // TWO Services, one Deployment: MinIO serves the S3 API and the console from the same
    // process, and a Kubernetes label value cannot contain a comma -- so each Service
    // names the workload through `houston.io/ui-deployment` instead of carrying a list of
    // ports it is not allowed to spell.
    readiness: {
      httpGet: { path: '/minio/health/ready', port: s3Port },
      initialDelaySeconds: 3,
      periodSeconds: 3,
      failureThreshold: 40,
    },
    ui: {
      minio: [s3Port, s3Port],
      'minio-console': [consolePort, consolePort],
    },
  });
}

/** MinIO and its console, as compose services. */
function minioServices(
  bucket: string,
  s3Port: number,
  consolePort: number,
): Record<string, Record<string, unknown>> {
  return {
    minio: {
      image: `docker.io/pgsty/minio:${MINIO_TAG}`,
      restart: 'unless-stopped',
      command: serverArgs(s3Port, consolePort),
      environment: {
        MINIO_ROOT_USER: USER,
        MINIO_ROOT_PASSWORD: PASSWORD,
      },
      volumes: ['minio_data:/data'],
      ports: [
        `${String(s3Port)}:${String(s3Port)}`,
        `${String(consolePort)}:${String(consolePort)}`,
      ],
    },
    // One-shot: wait for MinIO to accept connections, then create the bucket. `mc mb -p`
    // is idempotent (no error if it already exists), so BOTH steps retry: on rootless
    // Podman the bucket step itself met a DNS flap ("lookup minio: i/o timeout") and the
    // container exited for good with no bucket.
    'minio-init': {
      image: `docker.io/pgsty/mc:${MC_TAG}`,
      restart: 'no',
      depends_on: ['minio'],
      entrypoint: [
        'sh',
        '-c',
        `until mc alias set local http://minio:${String(s3Port)} ${USER} ${PASSWORD} && ` +
          `mc mb -p local/${bucket}; do sleep 1; done`,
      ],
    },
  };
}

export function build(params: Params, ports: PortMap): Preset {
  const presigned = truthyParam(params, 'presigned');
  const s3Port = presetPort('s3_minio', 0, ports);
  const consolePort = presetPort('s3_minio', 1, ports);
  // THE BROWSER'S ADDRESS FOR MINIO, in presigned mode only. A presigned URL is followed
  // by the browser, and `minio` resolves for it solely through the `127.0.0.1 minio` hosts
  // line below -- which names whichever machine the browser is on. Right on a laptop;
  // wrong on the shared install this tool now runs on, where the same silent shape broke
  // the saml and oidc buttons. Setting this to the host's own address satisfies the
  // browser AND RC (which reaches it over the bridge) and needs no hosts entry, exactly as
  // `idp_host` does for the IdP presets.
  //
  // Proxy mode is unaffected: there the browser never touches MinIO at all, which is why
  // this default stays `minio` and nothing about the ordinary case changes.
  const s3Host = strParam(params, 's3_host', 'minio');
  const bucket = strParam(params, 'bucket', 'houston-uploads');
  if (!BUCKET_RE.test(bucket)) {
    throw new Error(
      `--set bucket=${shownValue(bucket)} is not a valid S3 bucket name ` +
        '(3-63 chars: lowercase letters, digits, dots, hyphens)',
    );
  }

  return {
    ...emptyPreset('s3_minio'),
    description:
      "MinIO S3-compatible storage wired as RC's file upload backend " +
      `(bucket '${bucket}', console :${String(consolePort)}). Default proxies ` +
      'downloads through RC; turn on Presigned URLs (--set presigned=true) for real ones.',
    env: s3Settings(bucket, presigned, s3Host, s3Port),
    services: minioServices(bucket, s3Port, consolePort),
    dependsOn: ['minio'],
    requiresLicense: false,
    source: 'built-in (dynamic)',
    paramsHelp: {
      presigned: 'browser fetches presigned MinIO URLs (default false; needs /etc/hosts line)',
      bucket: 'bucket name (default houston-uploads)',
      s3_host:
        'hostname the BROWSER reaches MinIO on in presigned mode ' +
        "(default 'minio', which needs a hosts entry and only works " +
        'for a browser on the machine running houston)',
    },
    volumes: { minio_data: { driver: 'local' } },
    ports: [s3Port, consolePort],
    // Both: the Deployment/Services for MinIO, and the Job that creates the bucket.
    // Without the second, `up` succeeded, MinIO ran, and every upload had nowhere to land
    // -- see `bucketJob`.
    kubernetesManifests: [minioManifests(s3Port, consolePort), bucketJob(bucket, s3Port)],
    notes: presignedNotes(bucket, presigned, s3Host, [s3Port, consolePort]),
    guides: [
      guide('s3_minio', {
        summary: `MinIO as the file upload store, bucket '${bucket}'${presigned ? ', presigned URLs' : ''}.`,
        setup:
          presigned && s3Host === 'minio'
            ? {
                why: 'In presigned mode the browser fetches files straight from MinIO, so it needs this line in /etc/hosts (needs sudo).',
                line: '127.0.0.1  minio',
              }
            : null,
        signIn: [[USER, PASSWORD, 'MinIO console']],
        steps: [
          'Upload any file or image in Rocket.Chat; it lands in MinIO, not GridFS.',
          `Watch it arrive in the bucket '${bucket}' in the MinIO console.`,
        ],
        know:
          presigned && s3Host === 'minio'
            ? [
                'The hosts entry works only for a browser on the machine running houston; from another computer re-create with --bind 0.0.0.0 --set s3_host=<this host>.',
                "Remove the hosts line to reproduce the classic 'presigned URL unreachable' symptom: uploads work, previews and downloads break.",
              ]
            : presigned
              ? [
                  `The browser fetches files straight from http://${s3Host}:${String(s3Port)}, which must be reachable from it (--bind 0.0.0.0).`,
                  "Point s3_host somewhere unreachable to reproduce the classic 'presigned URL unreachable' symptom: uploads work, previews break.",
                ]
              : [
                  'Downloads are proxied through Rocket.Chat; no hosts entry needed.',
                  'For real presigned-URL behaviour, re-create it with Presigned URLs on (--set presigned=true).',
                ],
      }),
    ],
  };
}

register('s3_minio', build);
