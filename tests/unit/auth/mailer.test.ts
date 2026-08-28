import { describe, expect, it, vi } from 'vitest';
import { BrevoMailer, LogMailer, SmtpMailer } from '../../../src/auth/mailer.js';
import { AppError } from '../../../src/errors.js';

describe('SmtpMailer', () => {
  it('sends the code with the expected subject and from address', async () => {
    const sendMail = vi.fn().mockResolvedValue(undefined);
    const mailer = new SmtpMailer(
      { host: 'smtp.gmail.com', port: 465, user: 'me@gmail.com', pass: 'x', from: 'me@gmail.com' },
      { sendMail },
    );

    await mailer.sendCode('them@example.com', '123456');

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'me@gmail.com',
        to: 'them@example.com',
        subject: 'Your LinkedIn Profile API code',
      }),
    );
    const call = sendMail.mock.calls[0]?.[0] as { text: string };
    expect(call.text).toContain('123456');
    expect(call.text).toContain('expires in 10 minutes');
  });

  it('wraps a transport failure in a MAIL_FAILED AppError, cause not in the message', async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error('ECONNREFUSED super secret detail'));
    const log = vi.fn();
    const mailer = new SmtpMailer(
      { host: 'smtp.gmail.com', port: 465, user: 'me@gmail.com', pass: 'x', from: 'me@gmail.com' },
      { sendMail },
      log,
    );

    await expect(mailer.sendCode('them@example.com', '123456')).rejects.toMatchObject({
      code: 'MAIL_FAILED',
    });
    try {
      await mailer.sendCode('them@example.com', '123456');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).message).not.toContain('secret detail');
    }
    expect(log).toHaveBeenCalledWith('error', expect.any(String), expect.any(Object));
  });
});

describe('BrevoMailer', () => {
  it('posts the expected URL, headers and body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    const mailer = new BrevoMailer({ apiKey: 'brevo-key', from: 'me@gmail.com' }, fetchFn);

    await mailer.sendCode('them@example.com', '123456');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'api-key': 'brevo-key',
      accept: 'application/json',
      'content-type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      sender: { email: 'me@gmail.com', name: 'LinkedIn Profile API' },
      to: [{ email: 'them@example.com' }],
      subject: 'Your LinkedIn Profile API code',
      textContent: '123456 is your code. It expires in 10 minutes.',
    });
  });

  it('resolves on a 201 response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    const mailer = new BrevoMailer({ apiKey: 'brevo-key', from: 'me@gmail.com' }, fetchFn);

    await expect(mailer.sendCode('them@example.com', '123456')).resolves.toBeUndefined();
  });

  it('wraps a 401 in MAIL_FAILED, response body not in the thrown message', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), {
        status: 401,
      }),
    );
    const log = vi.fn();
    const mailer = new BrevoMailer({ apiKey: 'bad-key', from: 'me@gmail.com' }, fetchFn, log);

    try {
      await mailer.sendCode('them@example.com', '123456');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('MAIL_FAILED');
      expect((err as AppError).message).not.toContain('Key not found');
      expect((err as AppError).message).not.toContain('unauthorized');
    }
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.any(String),
      expect.objectContaining({ status: 401, code: 'unauthorized', message: 'Key not found' }),
    );
  });

  it('wraps a network error in MAIL_FAILED', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));
    const log = vi.fn();
    const mailer = new BrevoMailer({ apiKey: 'brevo-key', from: 'me@gmail.com' }, fetchFn, log);

    await expect(mailer.sendCode('them@example.com', '123456')).rejects.toMatchObject({
      code: 'MAIL_FAILED',
    });
    expect(log).toHaveBeenCalledWith('error', expect.any(String), expect.any(Object));
  });

  it('wraps a timeout in MAIL_FAILED', async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new DOMException('The operation was aborted', 'TimeoutError'));
    const mailer = new BrevoMailer({ apiKey: 'brevo-key', from: 'me@gmail.com' }, fetchFn);

    await expect(mailer.sendCode('them@example.com', '123456')).rejects.toMatchObject({
      code: 'MAIL_FAILED',
    });
  });
});

describe('LogMailer', () => {
  it('logs the code at warn level instead of sending mail', async () => {
    const log = vi.fn();
    const mailer = new LogMailer(log);
    await mailer.sendCode('them@example.com', '654321');
    expect(log).toHaveBeenCalledWith(
      'warn',
      expect.any(String),
      expect.objectContaining({ to: 'them@example.com', code: '654321' }),
    );
  });
});
