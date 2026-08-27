import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { LogFn } from '../voyager/client.js';
import { LINKEDIN_ORIGIN } from '../voyager/client.js';

export interface BrowserSessionOptions {
  liAt: string;
  userAgent: string;
  /** e.g. "chrome" to use an installed Chrome locally instead of a bundled Chromium. */
  channel?: string;
  log?: LogFn;
}

/**
 * One lazily-launched headless Chromium logged into LinkedIn with the same
 * `li_at` cookie the HTTP client uses. Shared by the browser transport and the
 * DOM scraper so we pay the launch cost once.
 */
export class BrowserSession {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private launching: Promise<BrowserContext> | undefined;
  private readonly log: LogFn;

  constructor(private readonly options: BrowserSessionOptions) {
    this.log = options.log ?? (() => undefined);
  }

  async newPage(): Promise<Page> {
    const context = await this.getContext();
    const page = await context.newPage();
    // Keep the page lean: no images, fonts or media.
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      return ['image', 'media', 'font'].includes(type) ? route.abort() : route.continue();
    });
    return page;
  }

  private getContext(): Promise<BrowserContext> {
    if (this.context) return Promise.resolve(this.context);
    this.launching ??= this.launch().finally(() => (this.launching = undefined));
    return this.launching;
  }

  private async launch(): Promise<BrowserContext> {
    this.log('debug', 'launching headless browser', { channel: this.options.channel ?? 'bundled' });
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      ...(this.options.channel ? { channel: this.options.channel } : {}),
    });
    this.browser.on('disconnected', () => {
      this.browser = undefined;
      this.context = undefined;
    });
    this.context = await this.browser.newContext({
      userAgent: this.options.userAgent,
      locale: 'en-US',
      viewport: { width: 1280, height: 900 },
    });
    await this.context.addCookies([
      {
        name: 'li_at',
        value: this.options.liAt,
        domain: '.www.linkedin.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      },
    ]);
    return this.context;
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = undefined;
    this.context = undefined;
  }
}

export { LINKEDIN_ORIGIN };
