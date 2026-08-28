import type { LogFn } from '../linkedin/voyager/client.js';

/**
 * What a provider concluded about a number.
 *
 * `skipped` is the important one: it means we never got an answer (no key, no
 * quota, provider down) rather than "the number is fine". The caller decides
 * whether that opens or closes the gate — see `PHONE_VALIDATION_FAIL_MODE`.
 */
export interface PhoneVerdict {
  verdict: 'accepted' | 'rejected' | 'skipped';
  /** Why, in words, for rejections and skips; `null` when accepted. */
  reason: string | null;
  /** The provider's payload, cached verbatim so a rule change can be re-run. */
  raw: unknown;
  provider: string;
  /** The provider's own spelling of the line type, echoed back untouched. */
  type: string | null;
  /** `null` when the provider did not answer. */
  valid: boolean | null;
}

export interface PhoneValidator {
  validate(phoneE164: string): Promise<PhoneVerdict>;
}

const ABSTRACT_ENDPOINT = 'https://phonevalidation.abstractapi.com/v1/';
const ABSTRACT_PROVIDER = 'abstract';

/**
 * The only line type we accept. Compared case-insensitively: Abstract's
 * documented samples spell it `mobile`, and treating a casing change as
 * "not a mobile" would lock every real user out.
 */
const MOBILE = 'mobile';

export interface AbstractPhoneValidatorOptions {
  /** Absent when `ABSTRACT_API_KEY` is unset; every check then skips. */
  apiKey: string | undefined;
  /** Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  log?: LogFn;
}

/**
 * Abstract Phone Validation v1. It tells us whether a number is real and what
 * kind of line it is; it does **not** prove the person in front of us holds
 * it, and the documented tier does not flag VoIP. This filters out obvious
 * junk and landlines, nothing more.
 *
 * The free quota is small, so every failure mode on our side or theirs is a
 * `skipped`, never a rejection: refusing a real user because we ran out of
 * credits is worse than letting one through.
 */
export class AbstractPhoneValidator implements PhoneValidator {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AbstractPhoneValidatorOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async validate(phoneE164: string): Promise<PhoneVerdict> {
    const { apiKey } = this.options;
    if (!apiKey) return this.skip('no ABSTRACT_API_KEY configured', { quiet: true });

    const query = new URLSearchParams({
      api_key: apiKey,
      // Abstract wants the digits only; a literal `+` would arrive as a space.
      phone: phoneE164.replace(/^\+/, ''),
    });

    let res: Response;
    try {
      res = await this.fetchImpl(`${ABSTRACT_ENDPOINT}?${query.toString()}`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return this.skip(`the validation request failed: ${detail}`);
    }

    if (!res.ok) return this.skip(`the provider returned HTTP ${res.status}`);

    let body: unknown;
    try {
      body = (await res.json()) as unknown;
    } catch {
      return this.skip('the provider returned a body that is not JSON');
    }

    const valid = readBoolean(body, 'valid');
    if (valid === null) return this.skip('the provider returned no verdict');

    return answeredVerdict({
      provider: ABSTRACT_PROVIDER,
      valid,
      type: readString(body, 'type'),
      raw: body,
    });
  }

  /** A skip is an operational event, so it is worth a line in the log. */
  private skip(reason: string, opts: { quiet?: boolean } = {}): PhoneVerdict {
    if (!opts.quiet) this.options.log?.('warn', 'phone validation skipped', { reason });
    return {
      verdict: 'skipped',
      reason,
      raw: null,
      provider: ABSTRACT_PROVIDER,
      type: null,
      valid: null,
    };
  }
}

/** Used when no provider is configured at all: every number is a skip. */
export class NoopPhoneValidator implements PhoneValidator {
  async validate(_phoneE164: string): Promise<PhoneVerdict> {
    return {
      verdict: 'skipped',
      reason: 'no validator configured',
      raw: null,
      provider: 'none',
      type: null,
      valid: null,
    };
  }
}

/**
 * The accept/reject rule, applied to an answer the provider actually gave.
 * Shared with the cache, so a row read back next month is judged by exactly
 * the same rule — and worded the same way — as the live call that wrote it.
 */
export function answeredVerdict(answer: {
  provider: string;
  valid: boolean | null;
  type: string | null;
  raw: unknown;
}): PhoneVerdict {
  const { provider, valid, type, raw } = answer;
  if (valid === true && type?.toLowerCase() === MOBILE) {
    return { verdict: 'accepted', reason: null, raw, provider, type, valid };
  }
  return {
    verdict: 'rejected',
    reason:
      valid === true
        ? `the provider reports this number as type ${type ?? 'unknown'}, not a mobile`
        : 'the provider reports this number as not in service (valid=false)',
    raw,
    provider,
    type,
    valid,
  };
}

function field(body: unknown, key: string): unknown {
  if (typeof body !== 'object' || body === null) return undefined;
  return (body as Record<string, unknown>)[key];
}

function readBoolean(body: unknown, key: string): boolean | null {
  const value = field(body, key);
  return typeof value === 'boolean' ? value : null;
}

function readString(body: unknown, key: string): string | null {
  const value = field(body, key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}
