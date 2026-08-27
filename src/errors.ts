/**
 * Every failure the API can report maps to one of these. The `code` is stable
 * and documented; the HTTP status is derived from it.
 */
export type ErrorCode =
  | 'INVALID_URL'
  | 'INVALID_REQUEST'
  | 'PROFILE_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'LINKEDIN_SESSION_EXPIRED'
  | 'UPSTREAM_ERROR'
  | 'SCHEMA_DRIFT'
  | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, number> = {
  INVALID_URL: 400,
  INVALID_REQUEST: 400,
  PROFILE_NOT_FOUND: 404,
  RATE_LIMITED: 429,
  LINKEDIN_SESSION_EXPIRED: 503,
  UPSTREAM_ERROR: 502,
  SCHEMA_DRIFT: 502,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }
}

export class InvalidUrlError extends AppError {
  constructor(message: string) {
    super('INVALID_URL', message);
  }
}

export class ProfileNotFoundError extends AppError {
  constructor(publicIdentifier: string) {
    super(
      'PROFILE_NOT_FOUND',
      `LinkedIn reports that profile "${publicIdentifier}" can't be accessed. It may not exist, or its visibility may be restricted.`,
      { publicIdentifier },
    );
  }
}

export class SessionExpiredError extends AppError {
  constructor() {
    super(
      'LINKEDIN_SESSION_EXPIRED',
      'The backend LinkedIn session is no longer valid. The operator needs to rotate the LI_AT cookie.',
    );
  }
}

export class RateLimitedError extends AppError {
  constructor(readonly retryAfterSeconds?: number) {
    super('RATE_LIMITED', 'LinkedIn is rate limiting requests. Try again later.', {
      retryAfterSeconds,
    });
  }
}

export class UpstreamError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('UPSTREAM_ERROR', message, details);
  }
}

/**
 * Raised when LinkedIn returned a 2xx but the payload does not look like the
 * entity graph we know how to read. This is the signal for the browser fallback.
 */
export class SchemaDriftError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('SCHEMA_DRIFT', message, details);
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
