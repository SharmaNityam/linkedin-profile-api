import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AbstractPhoneValidator, NoopPhoneValidator } from '../../../src/auth/phone-validation.js';
import type { LogFn } from '../../../src/linkedin/voyager/client.js';

const PHONE = '+919876543210';

/** The validator always calls fetch with a plain URL string. */
function requestedUrl(input: RequestInfo | URL | undefined): string {
  if (typeof input !== 'string') throw new Error('expected a string URL');
  return input;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('AbstractPhoneValidator', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const logged: { level: string; msg: string }[] = [];
  const log: LogFn = (level, msg) => void logged.push({ level, msg });

  function validator(apiKey: string | undefined = 'test-key'): AbstractPhoneValidator {
    return new AbstractPhoneValidator({ apiKey, fetch: fetchMock, log });
  }

  beforeEach(() => {
    fetchMock.mockReset();
    logged.length = 0;
  });

  it('accepts a valid mobile number', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ valid: true, type: 'Mobile', format: {} }));

    const result = await validator().validate(PHONE);

    expect(result.verdict).toBe('accepted');
    expect(result.valid).toBe(true);
    expect(result.type).toBe('Mobile');
    expect(result.provider).toBe('abstract');
    expect(result.reason).toBeNull();
  });

  it('sends the key and the number without a leading plus', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ valid: true, type: 'Mobile' }));

    await validator('secret-key').validate(PHONE);

    const url = requestedUrl(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('https://phonevalidation.abstractapi.com/v1/');
    expect(url).toContain('phone=919876543210');
    expect(url).not.toContain('%2B');
    expect(url).toContain('api_key=secret-key');
  });

  it('rejects a landline and names the type', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ valid: true, type: 'Landline' }));

    const result = await validator().validate(PHONE);

    expect(result.verdict).toBe('rejected');
    expect(result.reason).toContain('Landline');
    expect(result.type).toBe('Landline');
  });

  it('rejects a number the provider calls invalid', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ valid: false, type: null }));

    const result = await validator().validate(PHONE);

    expect(result.verdict).toBe('rejected');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('skips on HTTP 429 and warns', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 429 }));

    const result = await validator().validate(PHONE);

    expect(result.verdict).toBe('skipped');
    expect(result.reason).toContain('429');
    expect(result.valid).toBeNull();
    expect(logged.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('skips on HTTP 402 (quota exhausted)', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 402 }));

    const result = await validator().validate(PHONE);

    expect(result.verdict).toBe('skipped');
    expect(result.reason).toContain('402');
  });

  it('skips on HTTP 500', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));

    expect((await validator().validate(PHONE)).verdict).toBe('skipped');
  });

  it('skips when the request throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const result = await validator().validate(PHONE);

    expect(result.verdict).toBe('skipped');
    expect(result.reason).toContain('ECONNRESET');
    expect(logged.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('skips when the body is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>nope</html>', { status: 200 }));

    expect((await validator().validate(PHONE)).verdict).toBe('skipped');
  });

  it('skips when the body has no verdict', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'bad request' } }));

    expect((await validator().validate(PHONE)).verdict).toBe('skipped');
  });

  it('skips without calling fetch when no API key is configured', async () => {
    const keyless = new AbstractPhoneValidator({ apiKey: undefined, fetch: fetchMock, log });

    const result = await keyless.validate(PHONE);

    expect(result.verdict).toBe('skipped');
    expect(result.reason).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('NoopPhoneValidator', () => {
  it('always skips', async () => {
    const result = await new NoopPhoneValidator().validate(PHONE);

    expect(result.verdict).toBe('skipped');
    expect(result.reason).toBe('no validator configured');
    expect(result.valid).toBeNull();
    expect(result.type).toBeNull();
  });
});
