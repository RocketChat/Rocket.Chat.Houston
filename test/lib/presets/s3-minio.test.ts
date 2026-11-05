import { safeLoadAll } from '../../../src/lib/presets/common';
import { build } from '../../../src/lib/presets/s3-minio';

type Bag = Record<string, unknown>;

function docsOf(text: string): Bag[] {
  return safeLoadAll(text) as Bag[];
}

function named(docs: Bag[], kind: string, name: string): Bag | undefined {
  return docs.find((doc) => doc.kind === kind && (doc.metadata as Bag | undefined)?.name === name);
}

describe('s3_minio on Kubernetes', () => {
  it('keeps its objects and its bucket on a claim, so a stop/start does not empty it', () => {
    // MinIO wrote /data into the container's own filesystem: the first `stop` (a scale to
    // zero) took every uploaded file and the bucket, and the one-shot bucket Job never ran
    // again, so uploads failed for good. Compose keeps the same directory in `minio_data`.
    const docs = docsOf(build({}, {}).kubernetesManifests[0] as string);
    const claim = named(docs, 'PersistentVolumeClaim', 'minio-data');
    expect(claim).toBeDefined();
    const deployment = named(docs, 'Deployment', 'minio') as Bag;
    const spec = deployment.spec as Bag;
    const pod = (spec.template as Bag).spec as Bag;
    const container = (pod.containers as Bag[])[0] as Bag;
    expect(container.volumeMounts).toEqual([{ name: 'data', mountPath: '/data' }]);
    expect(pod.volumes).toEqual([
      { name: 'data', persistentVolumeClaim: { claimName: 'minio-data' } },
    ]);
    // One writer at a time on a ReadWriteOnce claim.
    expect(spec.strategy).toEqual({ type: 'Recreate' });
    // MinIO runs as root and asks for no group: the pod spec gains none.
    expect(pod.securityContext).toBeUndefined();
  });
});

describe('s3_minio on Docker', () => {
  it('retries the bucket step, not only the connection', () => {
    // `until mc alias set ...; done; mc mb` retried only the connection. On rootless Podman
    // the bucket step met a DNS flap ("lookup minio: i/o timeout") and the one-shot
    // container exited for good, with no bucket.
    const init = (build({}, {}).services['minio-init'] ?? {}) as { entrypoint?: string[] };
    const script = (init.entrypoint ?? []).join(' ');
    expect(script).toMatch(
      /^sh -c until mc alias set local \S+ \S+ \S+ && mc mb -p local\/\S+; do sleep 1; done$/,
    );
  });
});
