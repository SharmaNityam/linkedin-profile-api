import { describe, expect, it, vi } from 'vitest';
import { HttpVoyagerClient, interpretVoyagerResponse } from '../../src/linkedin/voyager/client.js';
import {
  CompanyNotFoundError,
  ProfileNotFoundError,
  RateLimitedError,
  SchemaDriftError,
  SessionExpiredError,
  UpstreamError,
} from '../../src/errors.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/vnd.linkedin.normalized+json+2.1' },
    ...init,
  });
}

function client(fetchImpl: typeof fetch) {
  return new HttpVoyagerClient({
    liAt: 'COOKIE',
    companionCookies: 'bcookie=b',
    userAgent: 'UA',
    fetch: fetchImpl,
    timeoutMs: 1000,
  });
}

const ctx = { kind: 'profile' as const, identifier: 'jane' };

describe('HttpVoyagerClient', () => {
  it('sends the auth cookies, matching csrf-token and Rest.li headers', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ data: {}, included: [] }));
    await client(fetchMock).get('/identity/dash/profiles?x=1', ctx);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://www.linkedin.com/voyager/api/identity/dash/profiles?x=1');
    const headers = init!.headers as Record<string, string>;
    expect(headers.cookie).toMatch(/^bcookie=b; li_at=COOKIE; JSESSIONID="ajax:\d+"$/);
    expect(headers.cookie).toContain(`JSESSIONID="${headers['csrf-token']}"`);
    expect(headers['x-restli-protocol-version']).toBe('2.0.0');
    expect(headers.accept).toBe('application/vnd.linkedin.normalized+json+2.1');
    expect(init!.redirect).toBe('manual');
  });

  it('sends companion cookies and echoes their JSESSIONID as csrf-token', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}));
    await new HttpVoyagerClient({
      liAt: 'COOKIE',
      companionCookies: 'bcookie=b; JSESSIONID="ajax:42"',
      userAgent: 'UA',
      fetch: fetchMock,
    }).get('/p', ctx);
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.cookie).toBe('bcookie=b; JSESSIONID="ajax:42"; li_at=COOKIE');
    expect(headers['csrf-token']).toBe('ajax:42');
  });

  it('returns the parsed body on success', async () => {
    const body = { data: { a: 1 }, included: [{ entityUrn: 'x' }] };
    await expect(
      client(vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body))).get('/p', ctx),
    ).resolves.toEqual(body);
  });

  it.each([
    ['401', new Response('', { status: 401 })],
    [
      'redirect to login',
      new Response('', { status: 302, headers: { location: 'https://www.linkedin.com/login' } }),
    ],
    [
      'HTML instead of JSON',
      new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ],
  ])('treats %s as an expired session', async (_name, res) => {
    await expect(
      client(vi.fn<typeof fetch>().mockResolvedValue(res)).get('/p', ctx),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('maps LinkedIn\'s 403 "can\'t be accessed" to ProfileNotFoundError', async () => {
    const res = jsonResponse(
      {
        data: {
          exceptionClass: 'com.linkedin.voyager.common.VoyagerUserVisibleException',
          message: "This profile can't be accessed",
          status: 403,
        },
        included: [],
      },
      { status: 403 },
    );
    await expect(
      client(vi.fn<typeof fetch>().mockResolvedValue(res)).get('/p', ctx),
    ).rejects.toBeInstanceOf(ProfileNotFoundError);
  });

  it('maps other 403s (e.g. CSRF failure) to UpstreamError', async () => {
    const res = jsonResponse({ message: 'CSRF check failed.' }, { status: 403 });
    await expect(
      client(vi.fn<typeof fetch>().mockResolvedValue(res)).get('/p', ctx),
    ).rejects.toThrow(/CSRF check failed/);
  });

  it('maps 404 to ProfileNotFoundError', async () => {
    await expect(
      client(vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, { status: 404 }))).get(
        '/p',
        ctx,
      ),
    ).rejects.toBeInstanceOf(ProfileNotFoundError);
  });

  it('maps 429 to RateLimitedError with Retry-After', async () => {
    const res = jsonResponse(
      {},
      { status: 429, headers: { 'retry-after': '30', 'content-type': 'application/json' } },
    );
    const err = await client(vi.fn<typeof fetch>().mockResolvedValue(res))
      .get('/p', ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect((err as RateLimitedError).retryAfterSeconds).toBe(30);
  });

  it('maps 400 (unknown decoration) to SchemaDriftError without leaking the upstream URL', async () => {
    const res = jsonResponse({ message: 'Unknown decoration' }, { status: 400 });
    const err = await client(vi.fn<typeof fetch>().mockResolvedValue(res))
      .get('/p', ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaDriftError);
    // Details reach the API caller; the Voyager path is operator detail.
    expect((err as SchemaDriftError).details).toEqual({ status: 400 });
  });

  it('retries once on 5xx and network errors, then gives up', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse({}, { status: 502 }));
    await expect(client(fetchMock).get('/p', ctx)).rejects.toBeInstanceOf(UpstreamError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('recovers when the retry succeeds', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({}, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(client(fetchMock).get('/p', ctx)).resolves.toEqual({ ok: true });
  });

  it('does not retry terminal errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, { status: 404 }));
    await client(fetchMock)
      .get('/p', ctx)
      .catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('session bootstrap', () => {
  it('visits /feed/ with li_at only and keeps the cookies LinkedIn issues', async () => {
    const bootstrapRes = new Response('', {
      status: 200,
      headers: [
        ['set-cookie', 'JSESSIONID="ajax:555"; Path=/; Secure'],
        ['set-cookie', 'bcookie="v2:xyz"; Domain=.linkedin.com'],
        ['set-cookie', 'lidc="b=1"; Path=/'],
        ['set-cookie', 'li_a=delete me; Max-Age=0'],
      ],
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(bootstrapRes)
      .mockResolvedValueOnce(jsonResponse({ ok: 1 }));
    const c = new HttpVoyagerClient({ liAt: 'COOKIE', userAgent: 'UA', fetch: fetchMock });
    await expect(c.get('/p', ctx)).resolves.toEqual({ ok: 1 });

    const [bootUrl, bootInit] = fetchMock.mock.calls[0]!;
    expect(bootUrl).toBe('https://www.linkedin.com/feed/');
    expect((bootInit!.headers as Record<string, string>).cookie).toBe('li_at=COOKIE');

    const headers = fetchMock.mock.calls[1]![1]!.headers as Record<string, string>;
    expect(headers.cookie).toBe(
      'JSESSIONID="ajax:555"; bcookie="v2:xyz"; lidc="b=1"; li_at=COOKIE',
    );
    expect(headers['csrf-token']).toBe('ajax:555');
  });

  it('bootstraps once even for concurrent requests', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        (url as string).endsWith('/feed/')
          ? new Response('', { status: 200, headers: { 'set-cookie': 'JSESSIONID="ajax:1"' } })
          : jsonResponse({}),
      );
    const c = new HttpVoyagerClient({ liAt: 'COOKIE', userAgent: 'UA', fetch: fetchMock });
    await Promise.all([c.get('/a', ctx), c.get('/b', ctx)]);
    expect(fetchMock.mock.calls.filter(([u]) => (u as string).endsWith('/feed/'))).toHaveLength(1);
  });

  it('reports an expired session when bootstrap is redirected to login', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('', { status: 302, headers: { location: 'https://www.linkedin.com/login' } }),
      );
    await expect(
      new HttpVoyagerClient({ liAt: 'COOKIE', userAgent: 'UA', fetch: fetchMock }).get('/p', ctx),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });
});

describe('interpretVoyagerResponse', () => {
  it('maps HTTP 999 (bot detection) to a non-retryable UpstreamError', async () => {
    expect(() =>
      interpretVoyagerResponse(
        { status: 999, contentType: 'text/html', retryAfter: null, text: '' },
        ctx,
      ),
    ).toThrow(/bot detection/);
  });

  it('maps 403 to CompanyNotFoundError for company requests', () => {
    expect(() =>
      interpretVoyagerResponse(
        {
          status: 403,
          contentType: 'application/json',
          retryAfter: null,
          text: JSON.stringify({ data: { message: "This company can't be accessed" } }),
        },
        { kind: 'company', identifier: 'acme' },
      ),
    ).toThrow(CompanyNotFoundError);
  });

  it('maps 404 to ProfileNotFoundError for posts requests', () => {
    expect(() =>
      interpretVoyagerResponse(
        { status: 404, contentType: 'application/json', retryAfter: null, text: '{}' },
        { kind: 'posts', identifier: 'jane' },
      ),
    ).toThrow(ProfileNotFoundError);
  });
});
