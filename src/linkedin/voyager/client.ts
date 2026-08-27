import { randomInt } from 'node:crypto';
import {
  ProfileNotFoundError,
  RateLimitedError,
  SchemaDriftError,
  SessionExpiredError,
  UpstreamError,
} from '../../errors.js';
import type { VoyagerResponse } from './types.js';
import {
  applySetCookies,
  buildSessionCookies,
  serializeCookies,
  type SessionCookies,
} from '../cookies.js';

export const LINKEDIN_ORIGIN = 'https://www.linkedin.com';
export const VOYAGER_BASE = `${LINKEDIN_ORIGIN}/voyager/api`;

export interface RequestContext {
  publicIdentifier: string;
}

/** Anything that can GET a Voyager path. Implemented over raw HTTP and over a real browser. */
export interface VoyagerTransport {
  readonly name: 'http' | 'browser';
  get(path: string, context: RequestContext): Promise<VoyagerResponse>;
}

export type LogFn = (level: 'debug' | 'warn', msg: string, extra?: Record<string, unknown>) => void;

/** The parts of an HTTP response we need to classify it, transport-agnostic. */
export interface RawResponse {
  status: number;
  contentType: string | null;
  retryAfter: string | null;
  text: string;
}

interface VoyagerErrorBody {
  data?: { exceptionClass?: string; message?: string; status?: number };
  message?: string;
}

/**
 * Turns a raw LinkedIn response into either a parsed body or one of our typed
 * errors. Shared by every transport so the failure mapping is defined once.
 */
export function interpretVoyagerResponse(
  res: RawResponse,
  context: RequestContext,
  url: string,
): VoyagerResponse {
  const contentType = res.contentType ?? '';
  const ok = res.status >= 200 && res.status < 300;

  // LinkedIn answers an invalid/expired li_at with a redirect to the login
  // wall (or an HTML page) rather than a clean 401.
  if (res.status === 401 || isRedirect(res.status) || (ok && !contentType.includes('json'))) {
    throw new SessionExpiredError();
  }

  if (res.status === 429) {
    const retryAfter = Number(res.retryAfter);
    throw new RateLimitedError(
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    );
  }

  const body = parseJson(res.text);

  if (ok) {
    if (!body || typeof body !== 'object') {
      throw new SchemaDriftError('LinkedIn returned a 2xx with a non-JSON body');
    }
    return body;
  }

  const errorBody = body as VoyagerErrorBody | undefined;
  const message = errorBody?.data?.message ?? errorBody?.message;

  if (
    res.status === 404 ||
    (res.status === 403 && /can'?t be accessed|not found/i.test(message ?? ''))
  ) {
    throw new ProfileNotFoundError(context.publicIdentifier);
  }
  if (res.status === 403) {
    // e.g. "CSRF check failed" — misconfiguration or LinkedIn blocking this client, not the user's fault.
    throw new UpstreamError(`LinkedIn refused the request: ${message ?? 'forbidden'}`, {
      status: 403,
    });
  }
  if (res.status === 400) {
    // Typically the decoration ID is no longer recognised — schema drift.
    throw new SchemaDriftError(`LinkedIn rejected the request: ${message ?? 'bad request'}`, {
      status: 400,
      url,
    });
  }
  if (res.status === 999) {
    // LinkedIn's bot-detection status. The browser transport usually gets past it.
    throw new UpstreamError('LinkedIn blocked the request (HTTP 999, bot detection)', {
      status: 999,
    });
  }
  throw new UpstreamError(
    `LinkedIn responded with HTTP ${res.status}${message ? `: ${message}` : ''}`,
    {
      status: res.status,
      retryable: res.status >= 500,
    },
  );
}

/**
 * Headers every Voyager call needs.
 *
 * Authentication is two cookies:
 *   - `li_at`      — the real session, issued at login (we get it from env)
 *   - `JSESSIONID` — a CSRF token. LinkedIn uses the double-submit pattern:
 *                    the `csrf-token` header must equal the `JSESSIONID`
 *                    cookie, but the value itself is client-chosen. LinkedIn's
 *                    own web app uses the form `ajax:<19 digits>`.
 *
 * The Rest.li headers (`x-restli-protocol-version: 2.0.0`,
 * `accept: …normalized+json+2.1`) are what make responses come back as the
 * flat `included[]` entity graph that `EntityGraph` reads.
 */
export function voyagerHeaders(csrfToken: string): Record<string, string> {
  return {
    'csrf-token': csrfToken,
    'x-restli-protocol-version': '2.0.0',
    'x-li-lang': 'en_US',
    accept: 'application/vnd.linkedin.normalized+json+2.1',
    'accept-language': 'en-US,en;q=0.9',
  };
}

export function newCsrfToken(): string {
  return `ajax:${randomInt(1e9, 1e10 - 1)}${randomInt(1e8, 1e9 - 1)}`;
}

export interface HttpVoyagerClientOptions {
  /** The `li_at` session cookie of the LinkedIn account used for scraping. */
  liAt: string;
  /** Optional companion cookies (the browser's `document.cookie`). See cookies.ts. */
  companionCookies?: string | undefined;
  userAgent: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  log?: LogFn;
}

/** Voyager over plain HTTP. Fast and cheap; the primary path. */
export class HttpVoyagerClient implements VoyagerTransport {
  readonly name = 'http' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly log: LogFn;
  private session: SessionCookies | undefined;
  private bootstrapping: Promise<SessionCookies> | undefined;

  constructor(private readonly options: HttpVoyagerClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.log = options.log ?? (() => undefined);
    if (options.companionCookies) {
      this.session = buildSessionCookies(options.liAt, options.companionCookies, newCsrfToken);
    }
  }

  /**
   * Establishes the session cookies. If the operator supplied the browser's
   * companion cookies we use those. Otherwise we do what a browser does on its
   * first visit: load a page with `li_at` only and keep the `JSESSIONID`,
   * `bcookie`, `bscookie` and `lidc` LinkedIn sets in response. Replaying
   * `li_at` without its companions is what gets sessions revoked.
   */
  private ensureSession(): Promise<SessionCookies> {
    if (this.session) return Promise.resolve(this.session);
    this.bootstrapping ??= this.bootstrap().finally(() => (this.bootstrapping = undefined));
    return this.bootstrapping;
  }

  private async bootstrap(): Promise<SessionCookies> {
    const url = `${LINKEDIN_ORIGIN}/feed/`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          cookie: `li_at=${this.options.liAt}`,
          'user-agent': this.options.userAgent,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new UpstreamError(
        `Network error bootstrapping LinkedIn session: ${errorMessage(err)}`,
        { retryable: true },
      );
    }
    const location = res.headers.get('location') ?? '';
    if (res.status === 401 || /\/(login|authwall|checkpoint)/.test(location))
      throw new SessionExpiredError();

    const jar = new Map<string, string>();
    applySetCookies(jar, res.headers.getSetCookie());
    const issued = [...jar.keys()];
    const session = buildSessionCookies(this.options.liAt, serializeCookies(jar), newCsrfToken);
    this.log('debug', 'bootstrapped LinkedIn session', { status: res.status, issued });
    this.session = session;
    return session;
  }

  /** Retries once on network errors and 5xx; everything else is terminal. */
  async get(path: string, context: RequestContext): Promise<VoyagerResponse> {
    const url = `${VOYAGER_BASE}${path}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.once(url, context);
      } catch (err) {
        lastError = err;
        if (!isRetryable(err)) throw err;
        this.log('warn', 'voyager request failed, retrying', { url, attempt, err: String(err) });
      }
    }
    throw lastError;
  }

  private async once(url: string, context: RequestContext): Promise<VoyagerResponse> {
    const session = await this.ensureSession();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          ...voyagerHeaders(session.csrfToken),
          cookie: serializeCookies(session.jar),
          'user-agent': this.options.userAgent,
          referer: `${LINKEDIN_ORIGIN}/`,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new UpstreamError(`Network error talking to LinkedIn: ${errorMessage(err)}`, {
        retryable: true,
      });
    }
    this.log('debug', 'voyager response', { url, status: res.status });
    applySetCookies(session.jar, res.headers.getSetCookie());
    return interpretVoyagerResponse(
      {
        status: res.status,
        contentType: res.headers.get('content-type'),
        retryAfter: res.headers.get('retry-after'),
        text: await res.text(),
      },
      context,
      url,
    );
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function isRetryable(err: unknown): boolean {
  return err instanceof UpstreamError && err.details?.retryable === true;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
