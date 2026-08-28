import nodemailer from 'nodemailer';
import { AppError } from '../errors.js';

export type LogFn = (level: 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;

export interface MailSender {
  sendCode(to: string, code: string): Promise<void>;
}

/** The subset of nodemailer's `Transporter` this module actually calls. */
export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

export interface SmtpMailerOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

const SUBJECT = 'Your LinkedIn Profile API code';

function body(code: string): string {
  return `Your verification code is ${code}. It expires in 10 minutes.\n\nIf you did not request this, ignore this email.`;
}

/** Sends the code over SMTP, Gmail by default. */
export class SmtpMailer implements MailSender {
  private readonly transport: MailTransport;
  private readonly from: string;
  private readonly log: LogFn;

  constructor(options: SmtpMailerOptions, transport?: MailTransport, log: LogFn = () => {}) {
    this.from = options.from;
    this.log = log;
    this.transport =
      transport ??
      nodemailer.createTransport({
        host: options.host,
        port: options.port,
        secure: options.port === 465,
        auth: { user: options.user, pass: options.pass },
      });
  }

  async sendCode(to: string, code: string): Promise<void> {
    try {
      await this.transport.sendMail({ from: this.from, to, subject: SUBJECT, text: body(code) });
    } catch (err) {
      // The cause is logged here, not on the AppError, so it never reaches the response.
      this.log('error', 'failed to send OTP mail', { err });
      throw new AppError('MAIL_FAILED', 'Could not send the code, try again later');
    }
  }
}

/** Dev fallback when SMTP isn't configured: logs the code instead of mailing it. */
export class LogMailer implements MailSender {
  constructor(private readonly log: LogFn) {}

  async sendCode(to: string, code: string): Promise<void> {
    this.log('warn', 'SMTP not configured; logging the OTP code instead of mailing it', {
      to,
      code,
    });
  }
}
