import { AppError } from '../errors.js';
import type { LogFn } from '../linkedin/voyager/client.js';

/** How verification codes leave the process. */
export interface MailSender {
  sendVerificationCode(to: string, code: string): Promise<void>;
}

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SUBJECT = 'Your verification code';

export interface ResendMailerOptions {
  apiKey: string;
  /** The `From:` header; Resend rejects domains it has not verified. */
  from: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
}

/**
 * Resend's REST API, called directly rather than through their SDK: one POST
 * with a JSON body is not worth a dependency.
 *
 * Every failure surfaces as `INTERNAL_ERROR`, because there is nothing the
 * caller of `/auth/signup` can do about our mail provider — and the details
 * (a bad API key, an unverified sender domain) are ours, not theirs.
 */
export class ResendMailer implements MailSender {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ResendMailerOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async sendVerificationCode(to: string, code: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.options.from,
          to,
          subject: SUBJECT,
          text: verificationText(code),
        }),
      });
    } catch (err) {
      throw new AppError('INTERNAL_ERROR', 'Could not send the verification email', {
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    if (!res.ok) {
      throw new AppError('INTERNAL_ERROR', 'Could not send the verification email', {
        status: res.status,
      });
    }
  }
}

/**
 * The no-provider fallback: the code goes to the log instead of a mailbox, so
 * local development works without a Resend key. Never selected in production —
 * anyone who can read the logs can complete anyone's signup.
 */
export class LogMailer implements MailSender {
  constructor(private readonly log: LogFn) {}

  async sendVerificationCode(to: string, code: string): Promise<void> {
    this.log('debug', 'verification code', { to, code });
  }
}

function verificationText(code: string): string {
  return [
    `Your verification code is ${code}.`,
    '',
    'It expires in 10 minutes and can be used once.',
    'If you did not request it, you can ignore this email.',
  ].join('\n');
}
