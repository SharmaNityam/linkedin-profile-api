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

  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new InvalidUrlError(`"${input}" is not a valid URL`);
  }

  if (!LINKEDIN_HOST.test(url.hostname)) {
    throw new InvalidUrlError(`Host "${url.hostname}" is not linkedin.com`);
  }

  // /in/<slug>, /mwlite/in/<slug>, with optional trailing segments/slash.
  const match = /^\/(?:mwlite\/)?in\/([^/]+)/.exec(url.pathname);
  if (!match?.[1]) {
    const kind = /^\/(company|school|pub|posts|jobs)\b/.exec(url.pathname)?.[1];
    throw new InvalidUrlError(
      kind
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
