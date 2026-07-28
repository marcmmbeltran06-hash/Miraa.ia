import { describe, expect, it, vi, beforeEach } from 'vitest';

const pageMock = {
  goto: vi.fn(async () => ({ status: 200 })),
  content: vi.fn(async () => '<html></html>'),
};

const contextMock = {
  newPage: vi.fn(async () => pageMock),
  close: vi.fn(async () => undefined),
};

const browserMock = {
  newContext: vi.fn(async () => contextMock),
  close: vi.fn(async () => undefined),
};

vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(async () => browserMock),
  },
  firefox: {
    launch: vi.fn(async () => browserMock),
  },
  webkit: {
    launch: vi.fn(async () => browserMock),
  },
}));

describe('PlaywrightBrowserAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('launches and creates a session', async () => {
    const { PlaywrightBrowserAdapter } = await import('../src/PlaywrightBrowserAdapter');
    const adapter = new PlaywrightBrowserAdapter({ engine: 'chromium' });

    await adapter.launch();
    const session = await adapter.createSession();

    expect(session.page).toBe(pageMock);
    expect(browserMock.newContext).toHaveBeenCalledTimes(1);
    expect(contextMock.newPage).toHaveBeenCalledTimes(1);

    await adapter.destroySession(session);
    await adapter.close();

    expect(contextMock.close).toHaveBeenCalledTimes(1);
    expect(browserMock.close).toHaveBeenCalledTimes(1);
  });

  it('reuses the browser instance across multiple sessions', async () => {
    const { PlaywrightBrowserAdapter } = await import('../src/PlaywrightBrowserAdapter');
    const adapter = new PlaywrightBrowserAdapter({ engine: 'chromium' });

    await adapter.launch();
    const sessionA = await adapter.createSession();
    const sessionB = await adapter.createSession();

    expect(sessionA.browser).toBe(sessionB.browser);
    expect(browserMock.newContext).toHaveBeenCalledTimes(2);

    await adapter.destroySession(sessionA);
    await adapter.destroySession(sessionB);
    await adapter.close();
  });
});
