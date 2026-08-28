import { describe, expect, it, vi } from 'vitest';
import { LogMailer, SmtpMailer } from '../../../src/auth/mailer.js';
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
