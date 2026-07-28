import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  LaunchOptions,
  Page,
} from 'playwright';
import { chromium, firefox, webkit } from 'playwright';
import type { BrowserAdapter } from '@autowp/browser';

export type BrowserEngine = 'chromium' | 'firefox' | 'webkit';

export interface PlaywrightBrowserAdapterOptions {
  engine?: BrowserEngine;
  launchOptions?: LaunchOptions;
  contextOptions?: BrowserContextOptions;
}

export interface PlaywrightSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

const browserEngines: Record<BrowserEngine, typeof chromium> = {
  chromium,
  firefox,
  webkit,
};

export class PlaywrightBrowserAdapter implements BrowserAdapter<PlaywrightSession> {
  private browser?: Browser;
  private readonly engine: BrowserEngine;
  private readonly launchOptions: LaunchOptions;
  private readonly contextOptions: BrowserContextOptions;

  constructor(options: PlaywrightBrowserAdapterOptions = {}) {
    this.engine = options.engine ?? 'chromium';
    this.launchOptions = options.launchOptions ?? { headless: true };
    this.contextOptions = options.contextOptions ?? {};
  }

  public async launch(): Promise<void> {
    if (this.browser) {
      return;
    }

    this.browser = await browserEngines[this.engine].launch(this.launchOptions);
  }

  public async close(): Promise<void> {
    if (!this.browser) {
      return;
    }

    await this.browser.close();
    this.browser = undefined;
  }

  public async createSession(): Promise<PlaywrightSession> {
    if (!this.browser) {
      throw new Error('Playwright browser must be launched before creating a session');
    }

    const context = await this.browser.newContext(this.contextOptions);
    const page = await context.newPage();

    return {
      browser: this.browser,
      context,
      page,
    };
  }

  public async destroySession(session: PlaywrightSession): Promise<void> {
    await session.context.close();
  }
}
