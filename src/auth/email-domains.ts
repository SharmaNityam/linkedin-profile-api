/**
 * Consumer mailbox providers we accept out of the box: Google, Microsoft and
 * Yahoo, including the regional variants people actually sign up with.
 *
 * Intentionally not exhaustive; ALLOWED_EMAIL_DOMAINS overrides it. Microsoft
 * alone runs ~160 country domains, so treat the env var as the escape hatch
 * rather than growing this list forever.
 */
export const DEFAULT_ALLOWED_EMAIL_DOMAINS: readonly string[] = [
  // Google
  'gmail.com',
  'googlemail.com',
  // Microsoft
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'outlook.in',
  'outlook.co.uk',
  'outlook.fr',
  'outlook.de',
  'outlook.jp',
  'outlook.com.au',
  'outlook.sa',
  'outlook.kr',
  'outlook.sg',
  'outlook.my',
  'outlook.ph',
  'hotmail.co.uk',
  'hotmail.co.in',
  'hotmail.fr',
  'hotmail.de',
  'hotmail.es',
  'hotmail.it',
  'hotmail.co.jp',
  'live.co.uk',
  'live.com.au',
  'live.nl',
  // Yahoo
  'yahoo.com',
  'ymail.com',
  'rocketmail.com',
  'yahoo.co.in',
  'yahoo.in',
  'yahoo.co.uk',
  'yahoo.fr',
  'yahoo.de',
  'yahoo.es',
  'yahoo.it',
  'yahoo.ca',
  'yahoo.com.au',
  'yahoo.co.jp',
  'yahoo.com.br',
  'yahoo.com.sg',
  'yahoo.com.hk',
  'yahoo.co.id',
  'yahoo.co.nz',
  'yahoo.com.ph',
];

/** Case-insensitive membership test; both sides are normalised first. */
export function isAllowedDomain(domain: string, allowed: readonly string[]): boolean {
  const needle = domain.trim().toLowerCase();
  return allowed.some((d) => d.trim().toLowerCase() === needle);
}

/**
 * Parses the `ALLOWED_EMAIL_DOMAINS` comma list. An unset, empty or
 * all-blank value falls back to the built-in defaults.
 */
export function parseAllowedDomains(env: string | undefined): string[] {
  const parsed = (env ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_ALLOWED_EMAIL_DOMAINS];
}
