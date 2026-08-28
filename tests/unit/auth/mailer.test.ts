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

interface Entry {
  level: string;
  msg: string;
  extra: Record<string, unknown> | undefined;
}

describe('ResendMailer', () => {
  const fetchMock = vi.fn<typeof fetch>();
  let entries: Entry[];

  function mailer(): ResendMailer {
    return new ResendMailer({
      apiKey: 'resend-key',
      from: 'API <onboarding@resend.dev>',
      fetch: fetchMock,
      log: (level, msg, extra) => void entries.push({ level, msg, extra }),
    });
  }

  async function failure(): Promise<AppError> {
    try {
      await mailer().sendVerificationCode('john@gmail.com', '123456');
    } catch (err) {
      if (err instanceof AppError) return err;
      throw err;
    }
    throw new Error('expected the send to reject');
  }

  beforeEach(() => {
    fetchMock.mockReset();
    entries = [];
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

  it('throws INTERNAL_ERROR on a non-2xx response, logging the status instead of returning it', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 422 }));

    const err = await failure();

    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.details).toBeUndefined();
    expect(err.message).not.toContain('422');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('warn');
    expect(entries[0]?.extra).toMatchObject({ status: 422 });
  });

  it('throws INTERNAL_ERROR when the request fails, logging the cause instead of returning it', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const err = await failure();

    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.details).toBeUndefined();
    expect(err.message).not.toContain('ECONNRESET');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('warn');
    expect(entries[0]?.extra).toMatchObject({ cause: 'ECONNRESET' });
  });

  it('sends without a log configured at all', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    const quiet = new ResendMailer({
      apiKey: 'resend-key',
      from: 'API <onboarding@resend.dev>',
      fetch: fetchMock,
    });

    await expect(quiet.sendVerificationCode('john@gmail.com', '123456')).rejects.toBeInstanceOf(
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
