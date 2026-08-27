import type { Page } from 'playwright-core';
import { SchemaDriftError, SessionExpiredError, UpstreamError } from '../../errors.js';
import type { ProfileData } from '../../schema/profile.js';
import {
  interpretVoyagerResponse,
  LINKEDIN_ORIGIN,
  voyagerHeaders,
  type LogFn,
  type RequestContext,
  type VoyagerTransport,
} from '../voyager/client.js';
import type { VoyagerResponse } from '../voyager/types.js';
import { collectTopCardLines, parseTopCard } from './selectors.js';
import type { BrowserSession } from './session.js';

const PAGE_TIMEOUT_MS = 25_000;

/**
 * Voyager, but every request is issued from inside a real browser tab that is
 * logged in to LinkedIn. Same endpoints, same normaliser — what changes is that
 * LinkedIn sees a genuine browser (TLS fingerprint, headers, its own CSRF
 * cookie), which is what gets past bot-detection when raw HTTP is blocked.
 */
export class BrowserVoyagerClient implements VoyagerTransport {
  readonly name = 'browser' as const;

  constructor(
    private readonly session: BrowserSession,
    private readonly log: LogFn = () => undefined,
  ) {}

  async get(path: string, context: RequestContext): Promise<VoyagerResponse> {
    const page = await this.session.newPage();
    try {
      await openLinkedIn(page, `${LINKEDIN_ORIGIN}/feed/`);
      const raw = await page.evaluate(
        async ({ path, headers }) => {
          const csrf = /JSESSIONID="?([^";]+)/.exec(document.cookie)?.[1];
          if (!csrf) return { status: 401, contentType: null, retryAfter: null, text: '' };
          const res = await fetch(`/voyager/api${path}`, {
            headers: { ...headers, 'csrf-token': csrf },
            redirect: 'manual',
          });
          return {
            status: res.status,
            contentType: res.headers.get('content-type'),
            retryAfter: res.headers.get('retry-after'),
            text: await res.text(),
          };
        },
        { path, headers: voyagerHeaders('') },
      );
      this.log('debug', 'browser voyager response', { path, status: raw.status });
      return interpretVoyagerResponse(raw, context, path);
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}

/** The partial profile the DOM scraper can produce. */
export interface TopCardResult {
  data: ProfileData;
  warnings: string[];
}

/**
 * Last resort: render the profile page and read the top card and About
 * section from the DOM. Only identity fields — the list sections are
 * lazy-loaded server-driven UI with unstable structure, so we don't pretend.
 */
export async function scrapeTopCard(
  session: BrowserSession,
  publicIdentifier: string,
  log: LogFn = () => undefined,
): Promise<TopCardResult> {
  const page = await session.newPage();
  try {
    const url = `${LINKEDIN_ORIGIN}/in/${encodeURIComponent(publicIdentifier)}/`;
    await openLinkedIn(page, url);
    await page
      .waitForSelector('main h1, main section h2', { timeout: PAGE_TIMEOUT_MS })
      .catch(() => {
        throw new UpstreamError('Profile page did not render a top card');
      });
    const raw = await page.evaluate(collectTopCardLines);
    const card = parseTopCard(raw);
    log('debug', 'dom top card', { publicIdentifier, name: card.name });
    if (!card.name)
      throw new SchemaDriftError('Could not find the profile name in the rendered page');

    const [firstName = '', ...rest] = card.name.split(/\s+/);
    return {
      warnings: [
        'Built from the rendered page: only top-card fields are available in this response',
      ],
      data: {
        url,
        publicIdentifier,
        urn: null,
        firstName,
        lastName: rest.join(' '),
        fullName: card.name,
        pronouns: null,
        headline: card.headline,
        about: card.about,
        location: card.location ? { name: card.location, countryCode: null } : null,
        industry: null,
        isPremium: null,
        profileImage: card.imageUrl ? { url: card.imageUrl, variants: [] } : null,
        backgroundImage: null,
        experience: [],
        education: [],
        skills: [],
        certifications: [],
        languages: [],
        volunteering: [],
        projects: [],
        honors: [],
        publications: [],
        courses: [],
      },
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function openLinkedIn(page: Page, url: string): Promise<void> {
  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout: PAGE_TIMEOUT_MS,
  });
  const finalUrl = page.url();
  if (/\/(login|authwall|checkpoint|uas\/login)/.test(finalUrl)) throw new SessionExpiredError();
  if (response && response.status() >= 500)
    throw new UpstreamError(`LinkedIn page returned HTTP ${response.status()}`);
}
