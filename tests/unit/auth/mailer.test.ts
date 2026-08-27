import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogMailer, ResendMailer } from '../../../src/auth/mailer.js';
import { AppError } from '../../../src/errors.js';
import type { LogFn } from '../../../src/linkedin/voyager/client.js';

/** The mailer always sends a JSON string body; anything else is a bug. */
function jsonBody(init: RequestInit | undefined): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== 'string') throw new Error('expected a JSON string body');
  return JSON.parse(body) as Record<string, unknown>;
}

describe('ResendMailer', () => {
  const fetchMock = vi.fn<typeof fetch>();

  function mailer(): ResendMailer {
    return new ResendMailer({
      apiKey: 'resend-key',
      from: 'API <onboarding@resend.dev>',
      fetch: fetchMock,
    });
  }

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('posts the code to the Resend API', async () => {
    fetchMock.mockResolvedValue(new Response('{"id":"1"}', { status: 200 }));

    await mailer().sendVerificationCode('john@gmail.com', '123456');

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer resend-key');

    const body = jsonBody(init);
    expect(body.from).toBe('API <onboarding@resend.dev>');
    expect(body.to).toBe('john@gmail.com');
    expect(body.subject).toBeTruthy();
    expect(String(body.text)).toContain('123456');
  });

  it('throws INTERNAL_ERROR on a non-2xx response', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 422 }));

    await expect(mailer().sendVerificationCode('john@gmail.com', '123456')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
  });

  it('throws INTERNAL_ERROR when the request fails', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    await expect(mailer().sendVerificationCode('john@gmail.com', '123456')).rejects.toBeInstanceOf(
      AppError,
    );
  });
});

describe('LogMailer', () => {
  it('logs the code instead of sending it', async () => {
    const entries: { level: string; msg: string; extra: Record<string, unknown> | undefined }[] =
      [];
    const log: LogFn = (level, msg, extra) => void entries.push({ level, msg, extra });

    await new LogMailer(log).sendVerificationCode('john@gmail.com', '123456');

    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('debug');
    expect(entries[0]?.extra).toMatchObject({ to: 'john@gmail.com', code: '123456' });
  });
});
