import { InvalidUrlError } from '../errors.js';

export interface ParsedProfileUrl {
  /** The vanity slug after /in/, percent-decoded. */
  publicIdentifier: string;
  /** Normalised https://www.linkedin.com/in/<slug>/ form. */
  canonicalUrl: string;
}

const LINKEDIN_HOST = /^(?:[a-z]{2,3}\.)?linkedin\.com$|^(?:www|m|touch)\.linkedin\.com$/i;
// Slugs are letters, digits, hyphens and a few unicode letters LinkedIn allows.
const SLUG = /^[\p{L}\p{N}\-_%.]{3,100}$/u;

function toUrl(raw: string, original: string): URL {
  try {
    return new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new InvalidUrlError(`"${original}" is not a valid URL`);
  }
}

/**
 * Accepts the many ways a profile URL shows up in the wild and returns the
 * public identifier. Rejects anything that is not a member profile (company,
 * school, pub/dir, posts) so we fail fast with a helpful message.
 */
export function parseProfileUrl(input: string): ParsedProfileUrl {
  const raw = input.trim();
  if (!raw) throw new InvalidUrlError('Profile URL is empty');

  // Bare slug (e.g. "sharmanityam") is accepted as a convenience.
  if (!raw.includes('/') && !raw.includes('.')) return fromSlug(raw);

  const url = toUrl(raw, input);

  if (!LINKEDIN_HOST.test(url.hostname)) {
    throw new InvalidUrlError(`Host "${url.hostname}" is not linkedin.com`);
  }

  // /in/<slug>, /mwlite/in/<slug>, with optional trailing segments/slash.
  // Paths are matched case-insensitively: shared links are often upper-cased.
  const match = /^\/(?:mwlite\/)?in\/([^/]+)/i.exec(url.pathname);
  if (!match?.[1]) {
    const kind = /^\/(company|school|pub|posts|jobs)\b/i.exec(url.pathname)?.[1]?.toLowerCase();
    throw new InvalidUrlError(
      kind === 'company' || kind === 'school'
        ? `"${url.pathname}" is a ${kind} URL, not a member profile; use /v1/company`
        : kind
          ? `"${url.pathname}" is a ${kind} URL, not a member profile (expected /in/<slug>)`
          : `Expected a profile URL of the form https://www.linkedin.com/in/<slug>`,
    );
  }
  return fromSlug(match[1]);
}

function fromSlug(segment: string): ParsedProfileUrl {
  let slug: string;
  try {
    slug = decodeURIComponent(segment);
  } catch {
    throw new InvalidUrlError(`Malformed profile slug "${segment}"`);
  }
  if (!SLUG.test(slug)) throw new InvalidUrlError(`"${slug}" is not a valid profile slug`);
  return {
    publicIdentifier: slug,
    canonicalUrl: `https://www.linkedin.com/in/${encodeURIComponent(slug)}/`,
  };
}

export interface ParsedCompanyUrl {
  universalName: string;
  kind: 'company' | 'school';
  canonicalUrl: string;
}

// Universal names allow '&' and '.' (e.g. schools migrated from old vanity names).
const COMPANY_SLUG = /^[\p{L}\p{N}\-_%.&]{1,120}$/u;
// "host.tld", with an optional scheme and port and nothing else.
const HOSTLIKE = /^(?:[a-z]+:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?$/i;

/**
 * Accepts the ways a company/school URL shows up in the wild and returns the
 * universal name and kind. Rejects member profile URLs so we can redirect
 * callers to /v1/profile.
 */
export function parseCompanyUrl(input: string): ParsedCompanyUrl {
  const raw = input.trim();
  if (!raw) throw new InvalidUrlError('Company URL is empty');

  // Bare universal name (e.g. "anthropicresearch") is accepted as a
  // convenience. Dots are legal in a universal name, so "." alone cannot
  // decide this: anything that looks like a hostname is treated as a URL.
  if (!raw.includes('/') && !HOSTLIKE.test(raw)) return fromCompanySlug(raw, 'company');

  const url = toUrl(raw, input);

  if (!LINKEDIN_HOST.test(url.hostname)) {
    throw new InvalidUrlError(`Host "${url.hostname}" is not linkedin.com`);
  }

  // `showcase` pages are company pages reached through a different path.
  const match = /^\/(?:mwlite\/)?(company|school|showcase)\/([^/]+)/i.exec(url.pathname);
  if (!match?.[2]) {
    if (/^\/(?:mwlite\/)?in\//i.test(url.pathname)) {
      throw new InvalidUrlError(`"${url.pathname}" is a member profile URL; use /v1/profile`);
    }
    throw new InvalidUrlError(
      'Expected a company URL of the form https://www.linkedin.com/company/<name> or /school/<name>',
    );
  }
  return fromCompanySlug(match[2], match[1]!.toLowerCase() === 'school' ? 'school' : 'company');
}

function fromCompanySlug(segment: string, kind: 'company' | 'school'): ParsedCompanyUrl {
  let slug: string;
  try {
    slug = decodeURIComponent(segment);
  } catch {
    throw new InvalidUrlError(`Malformed company slug "${segment}"`);
  }
  if (!COMPANY_SLUG.test(slug)) throw new InvalidUrlError(`"${slug}" is not a valid company slug`);
  return {
    universalName: slug,
    kind,
    canonicalUrl: `https://www.linkedin.com/${kind}/${encodeURIComponent(slug)}/`,
  };
}
