import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';

import { makeTempDir } from '../../src/lib/tempdir';
import { issueLeaf } from '../../src/core/tls-local';
import { originCertificate } from '../../src/core/tls';
import { capture } from '../../src/seams/exec';
import { rcHttp, RequestFailed } from '../../src/seams/rc-http';

describe('a credential-free HTTPS origin probe', () => {
  let server: https.Server | null = null;

  async function serving(
    host: string,
    handler: Parameters<typeof https.createServer>[1],
    expired = false,
  ): Promise<{ url: string; certificate: string }> {
    const [issuedCertificate, key] = await issueLeaf(host);
    let certificate = issuedCertificate;
    if (expired) {
      const directory = makeTempDir();
      try {
        const original = path.join(directory, 'original.crt');
        const keyFile = path.join(directory, 'private.key');
        const output = path.join(directory, 'expired.crt');
        fs.writeFileSync(original, certificate, { mode: 0o600 });
        fs.writeFileSync(keyFile, key, { mode: 0o600 });
        // `-days -1` is how OpenSSL 3.0 dates a certificate into the past; from 3.4 it is
        // refused ("Non-positive number") and the dates are set outright instead.
        const resign = ['openssl', 'x509', '-in', original, '-signkey', keyFile] as const;
        let result = await capture([...resign, '-days', '-1', '-out', output]);
        if (result.exitCode !== 0) {
          result = await capture([
            ...resign,
            '-not_before',
            '20200101000000Z',
            '-not_after',
            '20200102000000Z',
            '-out',
            output,
          ]);
        }
        expect(result.exitCode).toBe(0);
        certificate = fs.readFileSync(output, 'utf8');
        expect(Date.parse(new X509Certificate(certificate).validTo)).toBeLessThan(Date.now());
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
    server = https.createServer({ cert: certificate, key }, handler);
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `https://${host}:${port}`, certificate };
  }

  afterEach(async () => {
    if (server === null) return;
    const closing = server;
    server = null;
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  });

  it('pins a CA-signed leaf on loopback while preserving the public Host and SNI', async () => {
    const incoming: unknown[] = [];
    const { url, certificate } = await serving('workspace.example.test', (request, response) => {
      incoming.push({
        host: request.headers.host,
        sni: (request.socket as TLSSocket).servername,
        authorization: request.headers.authorization,
      });
      response.end('Rocket.Chat');
    });
    const response = await rcHttp.request(url, {
      followRedirects: false,
      loopbackOrigin: { certificate },
    });
    expect(response.status).toBe(200);
    expect(response.text).toBe('Rocket.Chat');
    expect(incoming).toEqual([
      {
        host: new URL(url).host,
        sni: 'workspace.example.test',
        authorization: undefined,
      },
    ]);
  });

  it('does not add an observed origin certificate to ordinary requests trust', async () => {
    const { url, certificate } = await serving('localhost', (_request, response) => {
      response.end('Rocket.Chat');
    });
    expect((await rcHttp.request(url, { loopbackOrigin: { certificate } })).status).toBe(200);
    await expect(rcHttp.request(url)).rejects.toBeInstanceOf(RequestFailed);
  });

  it('rejects a replacement leaf even when it shares the same trusted issuer', async () => {
    const { url } = await serving('workspace.example.test', (_request, response) => {
      response.end('Rocket.Chat');
    });
    const [differentCertificate] = await issueLeaf('workspace.example.test');
    await expect(
      rcHttp.request(url, {
        loopbackOrigin: { certificate: differentCertificate },
      }),
    ).rejects.toBeInstanceOf(RequestFailed);
  });

  it('keeps hostname validation unless a caller explicitly identifies a pending default', async () => {
    const { url, certificate } = await serving('fallback.example.test', (_request, response) => {
      response.end('Rocket.Chat');
    });
    const publicUrl = url.replace('fallback.example.test', 'workspace.example.test');
    await expect(
      rcHttp.request(publicUrl, {
        loopbackOrigin: { certificate },
      }),
    ).rejects.toBeInstanceOf(RequestFailed);
    expect(
      (
        await rcHttp.request(publicUrl, {
          loopbackOrigin: { certificate, allowCertificateNameMismatch: true },
        })
      ).text,
    ).toBe('Rocket.Chat');
  });

  it('times out when TLS succeeds but the complete response body never arrives', async () => {
    const { url, certificate } = await serving('workspace.example.test', (_request, response) => {
      response.writeHead(200, { 'Content-Length': '100' });
      response.write('only part of the page');
    });
    const started = Date.now();
    await expect(
      rcHttp.request(url, {
        timeoutMs: 250,
        loopbackOrigin: { certificate },
      }),
    ).rejects.toMatchObject({
      name: 'RequestFailed',
      kind: 'connection',
      message: expect.stringContaining('stopped sending before the response ended'),
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects an expired observed leaf even when a pending-default name mismatch is allowed', async () => {
    const { url, certificate } = await serving(
      'localhost',
      (_request, response) => {
        response.end('Rocket.Chat');
      },
      true,
    );
    const publicUrl = url.replace('localhost', 'workspace.example.test');
    await expect(
      rcHttp.request(publicUrl, {
        loopbackOrigin: { certificate, allowCertificateNameMismatch: true },
      }),
    ).rejects.toMatchObject({
      name: 'RequestFailed',
      cause: expect.objectContaining({ code: 'CERT_HAS_EXPIRED' }),
    });
  });

  it('observes the exact local peer without treating it as publicly trusted', async () => {
    const { url, certificate } = await serving('workspace.example.test', (_request, response) => {
      response.end('Rocket.Chat');
    });
    const observed = await originCertificate('workspace.example.test', {
      port: Number(new URL(url).port),
    });
    expect(observed).toEqual({ pem: certificate, fallback: false, error: '' });
  });
});
