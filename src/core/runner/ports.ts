/**
 * Which host ports are claimed, and which are actually free to publish on.
 */
import * as net from 'node:net';

import { listMeta } from './record';

export const PORT_MAX = 65535;

/** How long the "is something already listening" probe waits: the established 0.2 s. */
const PROBE_TIMEOUT_MS = 200;

export async function usedPorts(): Promise<Set<number>> {
  const ports = new Set<number>();
  for (const meta of await listMeta()) {
    ports.add(meta.hostPort);
    // A multi-instance repro also occupies hostPort+1..+N (direct instance access),
    // so those are claimed too.
    const instances = meta.extra.instances;
    if (typeof instances === 'number' && instances > 1) {
      for (let offset = 1; offset <= instances; offset += 1) ports.add(meta.hostPort + offset);
    }
    // Preset side services (Keycloak/Mailpit/MinIO…) and the monitoring add-on
    // (Prometheus/Grafana) publish host ports recorded at `up` — claimed too, so
    // RC port allocation avoids them.
    for (const key of ['sidecar_ports', 'monitoring_ports', 'tls_ports']) {
      const claimed = meta.extra[key];
      if (!Array.isArray(claimed)) continue;
      for (const entry of claimed) {
        if (typeof entry === 'number') ports.add(entry);
        else if (/^\d+$/.test(String(entry))) ports.add(Number(entry));
      }
    }
  }
  return ports;
}

function listening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = new net.Socket();
    const done = (answer: boolean): void => {
      probe.destroy();
      resolve(answer);
    };
    probe.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.connect(port, host);
  });
}

function bindable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      // A privileged port (<1024) cannot be bound by an unprivileged user, but the
      // DOCKER DAEMON can — it runs as root, so `ports: 443:443` publishes fine.
      // Treating EACCES as "in use" made `up --https --domain ...` refuse 443 on every
      // non-root machine, with nothing actually listening on it. Nobody is holding it;
      // we just cannot probe this way. The connect check already caught a real listener.
      resolve(error.code === 'EACCES');
    });
    // libuv sets SO_REUSEADDR on a POSIX TCP bind, which is what lets this probe a port
    // that is only in TIME_WAIT -- the same allowance the previous implementation's port
    // check makes explicitly, and the same one it skips on Windows, where it would report an
    // active listener free.
    server.listen({ host, port, exclusive: process.platform === 'win32' }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * True if `port` is free to publish on the host right now.
 *
 * `host` narrows the question to one interface. It matters because the wildcard bind
 * below reports busy for EVERY address as soon as anything holds the port on 0.0.0.0 —
 * correct for "can I publish this everywhere", wrong for "is 203.0.113.10:443 free",
 * which is the dedicated-IP escape hatch: two processes CAN hold the same port on
 * different IPs (verified on 172.16.0.2 and .3 at once). Without this the front door
 * holding 443 on 0.0.0.0 made every other address look taken.
 */
export async function portFree(port: number, host = ''): Promise<boolean> {
  // First: is something already LISTENING there? A wildcard bind with SO_REUSEADDR can
  // miss a docker publish on 127.0.0.1:<port> (repros bind loopback), so probe it
  // directly — connect success == in use.
  if (await listening(host || '127.0.0.1', port)) return false;
  // Then: can we actually bind it? (catches reserved-but-not-listening ports.)
  return await bindable(host || '0.0.0.0', port);
}

/**
 * Lowest port >= start not claimed by another repro AND free on the host.
 *
 * Bounded: throws instead of scanning past 65535, which happens when the host cannot
 * bind anything (sandboxed environments).
 */
export async function pickPort(start = 3000): Promise<number> {
  const used = await usedPorts();
  let port = start;
  while (used.has(port) || !(await portFree(port))) {
    port += 1;
    if (port > PORT_MAX) {
      throw new Error(
        `no free host port found (scanned ${String(start)}-${String(PORT_MAX)}) — ` +
          'can this environment bind TCP ports at all?',
      );
    }
  }
  return port;
}

/**
 * Lowest base port with `count` consecutive ports all unclaimed AND free.
 *
 * Used by multi-instance repros, which need one port for the load balancer plus one per
 * instance (the block [base, base+count)). Bounded like `pickPort`.
 */
export async function pickPortRange(count: number, start = 3000): Promise<number> {
  const used = await usedPorts();
  let base = start;
  for (;;) {
    let free = true;
    for (let offset = 0; offset < count; offset += 1) {
      if (used.has(base + offset) || !(await portFree(base + offset))) {
        free = false;
        break;
      }
    }
    if (free) return base;
    base += 1;
    if (base + count - 1 > PORT_MAX) {
      throw new Error(
        `no free block of ${String(count)} consecutive host ports found ` +
          `(scanned from ${String(start)}) — can this environment bind TCP ports at all?`,
      );
    }
  }
}
