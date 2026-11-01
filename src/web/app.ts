/** Build the Fastify front door used by the route-port verification tier. */

import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import sse from '@fastify/sse';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { parse as parseQuery } from 'node:querystring';

import { asPayload, PreflightError, ReproError } from '../lib/errors';
import { MONITOR_PORTS } from '../lib/config';
import { grafanaFrameOrigins } from '../core/lifecycle/inspect';
import { installJobs, type JobManager } from './jobs';
import { markFormBody, RequestValidationError } from './route-deps';
import { installRouteCompleteness, ownerScoped, routeRequirement } from './route-table';
import { registerAll } from './routes';
import {
  COOKIE_PLAIN,
  COOKIE_SECURE,
  installSecurity,
  type SecurityContext,
  type TrustedNetwork,
} from './security';

export interface AppOptions {
  allowHosts?: readonly string[];
  accounts?: boolean;
  publicHttps?: boolean;
  firstRun?: boolean;
  trustedProxies?: readonly TrustedNetwork[];
  jobs?: JobManager;
  /** Told which jobs shutdown stops because they outlasted the drain. */
  onShutdownStop?: (jobIds: readonly string[]) => void;
}

export interface ServePosture {
  readonly bind: string;
  readonly accounts: boolean;
  /** True when the browser hop is HTTPS, whether houston or a named proxy terminates it. */
  readonly transportProtected: boolean;
}

/** Refuse a reachable web front door before anything starts listening. */
export function requireSafeServePosture(posture: ServePosture): void {
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(posture.bind);
  if (!posture.accounts && !loopback) {
    throw new PreflightError(
      `houston needs an account before it will serve on ${posture.bind}; ` +
        'create one with `houston users add <name>`',
    );
  }
  if (posture.accounts && !loopback && !posture.transportProtected) {
    throw new PreflightError(
      `signing in over plain http on ${posture.bind} puts the password and session ` +
        'cookie on the wire',
    );
  }
}

export function contentSecurityPolicy(grafanaOrigins: readonly string[] = []): string {
  // The preferred Grafana first, then each monitored workspace's own, once each: a second
  // monitored workspace's Grafana is on another port, and a frame on it is refused otherwise.
  const frames = [
    ...new Set([`http://localhost:${String(MONITOR_PORTS[1])}`, ...grafanaOrigins]),
  ].join(' ');
  return (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self' ws: wss:; " +
    `frame-src 'self' ${frames}; ` +
    "base-uri 'none'; form-action 'self'; object-src 'none'"
  );
}

class JsonTextError extends Error {
  constructor(
    readonly detail: string,
    readonly offset: number,
  ) {
    super(detail);
  }
}

/** The established JSON grammar, so the exact error position and message survive. */
class JsonTextParser {
  private at = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    if (this.source.startsWith('\uFEFF')) {
      this.fail('Unexpected UTF-8 BOM', 0);
    }
    this.space();
    const value = this.value();
    this.space();
    if (this.at !== this.source.length) this.fail('Extra data');
    return value;
  }

  position(offset = this.at): number {
    return [...this.source.slice(0, offset)].length;
  }

  private fail(detail: string, offset = this.at): never {
    throw new JsonTextError(detail, this.position(offset));
  }

  private space(): void {
    while (/^[ \t\n\r]$/u.test(this.source[this.at] ?? '')) this.at += 1;
  }

  private value(): unknown {
    const character = this.source[this.at];
    if (character === '"') return this.string();
    if (character === '{') return this.object();
    if (character === '[') return this.array();
    for (const [word, value] of [
      ['true', true],
      ['false', false],
      ['null', null],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
    ] as const) {
      if (this.source.startsWith(word, this.at)) {
        this.at += word.length;
        return value;
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      this.source.slice(this.at),
    )?.[0];
    if (number !== undefined && number !== '') {
      this.at += number.length;
      return Number(number);
    }
    return this.fail('Expecting value');
  }

  private string(): string {
    const opening = this.at;
    this.at += 1;
    while (this.at < this.source.length) {
      const character = this.source[this.at] as string;
      if (character === '"') {
        this.at += 1;
        return JSON.parse(this.source.slice(opening, this.at)) as string;
      }
      if (character.charCodeAt(0) < 0x20) this.fail('Invalid control character at');
      if (character !== '\\') {
        this.at += 1;
        continue;
      }
      const slash = this.at;
      this.at += 1;
      const escape = this.source[this.at];
      if (escape === undefined) {
        this.fail('Unterminated string starting at', opening);
      }
      if (escape === 'u') {
        if (!/^[0-9a-fA-F]{4}$/u.test(this.source.slice(this.at + 1, this.at + 5))) {
          this.fail('Invalid \\uXXXX escape');
        }
        this.at += 5;
        continue;
      }
      if (!'"\\/bfnrt'.includes(escape)) {
        this.fail('Invalid \\escape', slash);
      }
      this.at += 1;
    }
    return this.fail('Unterminated string starting at', opening);
  }

  private object(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    this.at += 1;
    this.space();
    if (this.source[this.at] === '}') {
      this.at += 1;
      return result;
    }
    for (;;) {
      if (this.source[this.at] !== '"') {
        this.fail('Expecting property name enclosed in double quotes');
      }
      const name = this.string();
      this.space();
      if (this.source[this.at] !== ':') this.fail("Expecting ':' delimiter");
      this.at += 1;
      this.space();
      const value = this.value();
      Object.defineProperty(result, name, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.space();
      if (this.source[this.at] === '}') {
        this.at += 1;
        return result;
      }
      if (this.source[this.at] !== ',') this.fail("Expecting ',' delimiter");
      this.at += 1;
      this.space();
    }
  }

  private array(): unknown[] {
    const result: unknown[] = [];
    this.at += 1;
    this.space();
    if (this.source[this.at] === ']') {
      this.at += 1;
      return result;
    }
    for (;;) {
      result.push(this.value());
      this.space();
      if (this.source[this.at] === ']') {
        this.at += 1;
        return result;
      }
      if (this.source[this.at] !== ',') this.fail("Expecting ',' delimiter");
      this.at += 1;
      this.space();
    }
  }
}

export function parseJsonBody(body: string): unknown {
  return new JsonTextParser(body).parse();
}

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    exposeHeadRoutes: false,
    // avvio's plugin timeout (10 s) also bounds each preClose hook, and the job drain's own
    // bounds are longer (`installJobs`): cut at 10 s, a running job was neither waited for nor
    // stopped and `close()` rejected. `serve` bounds the whole shutdown itself.
    pluginTimeout: 0,
    // Once the drain is over, every connection is ended. An open stream, or a keep-alive
    // connection whose request was still in flight, held `server.close()` -- the second for
    // the 72 s keep-alive timeout, past serve's 38 s backstop.
    forceCloseConnections: true,
  });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    async (_request: FastifyRequest, body: string): Promise<unknown> => {
      if (body === '') return undefined;
      try {
        return parseJsonBody(body);
      } catch (error) {
        if (!(error instanceof JsonTextError)) throw error;
        throw new RequestValidationError([
          {
            type: 'json_invalid',
            loc: ['body', error.offset],
            msg: 'JSON decode error',
            input: {},
            ctx: { error: error.detail },
          },
        ]);
      }
    },
  );
  app.addContentTypeParser(
    '*',
    { parseAs: 'string' },
    async (_request: FastifyRequest, body: string) => body,
  );
  installRouteCompleteness(app);
  await app.register(websocket);
  await app.register(formbody, {
    parser: (body) => markFormBody(parseQuery(body), body),
  });
  await app.register(multipart, { throwFileSizeLimit: false });
  await app.register(sse);
  installJobs(app, {
    ...(options.jobs === undefined ? {} : { manager: options.jobs }),
    ...(options.onShutdownStop === undefined ? {} : { onStopping: options.onShutdownStop }),
  });
  app.decorate('houstonFirstRun', options.firstRun ?? false);
  const supplied = options.allowHosts ?? [];
  const allowed = new Set(
    ['localhost', '127.0.0.1', '::1', ...supplied].map((host) => host.toLowerCase()),
  );
  const publicHttps = options.publicHttps ?? false;
  const context: SecurityContext = {
    allowed,
    anyHost: supplied.includes('*'),
    csp: contentSecurityPolicy(),
    accounts: options.accounts ?? true,
    cookieSecure: COOKIE_SECURE,
    cookiePlain: COOKIE_PLAIN,
    publicHttps: () => publicHttps,
    trustedProxies: options.trustedProxies ?? [],
    routeRequirement,
    ownerScoped,
  };
  installSecurity(app, context);
  // A JSON response is `application/json`, with no charset, as it always has been: only a
  // `text/` type gets one. Fastify's serializer adds `; charset=utf-8` to every object it sends.
  app.addHook('onSend', (_request, reply, payload, done) => {
    if (reply.getHeader('content-type') === 'application/json; charset=utf-8') {
      reply.header('content-type', 'application/json');
    }
    done(null, payload);
  });
  app.addHook('onSend', async (request, reply, payload) => {
    if (
      request.routeOptions.url === '/' &&
      (String(reply.getHeader('content-type')).startsWith('text/html') || reply.statusCode === 304)
    ) {
      reply.header('Content-Security-Policy', contentSecurityPolicy(await grafanaFrameOrigins()));
    }
    return payload;
  });
  registerAll(app);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RequestValidationError) {
      void reply.code(error.statusCode).send({ detail: error.detail });
      return;
    }
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      void reply.code(422).send({
        detail: [
          {
            type: 'json_invalid',
            loc: ['body'],
            msg: 'JSON decode error',
            input: {},
          },
        ],
      });
      return;
    }
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      void reply.code(422).send({
        detail: [
          {
            type: 'dict_type',
            loc: ['body'],
            msg: 'Input should be a valid object',
            input: {},
          },
        ],
      });
      return;
    }
    if (error instanceof ReproError) {
      void reply.code(error.httpStatus).send(asPayload(error));
      return;
    }
    void reply.send(error);
  });
  return app;
}
