# @autowp/playwright-adapter

A Playwright browser adapter for the AutoWP browser pool.

## Features

- reuses a single browser instance across sessions
- creates fresh browser contexts for each pool session
- supports Chromium, Firefox, and WebKit

## Usage

```ts
import { PlaywrightBrowserAdapter } from '@autowp/playwright-adapter';
import { BrowserPool } from '@autowp/browser';

const adapter = new PlaywrightBrowserAdapter({ engine: 'chromium' });
const browserPool = new BrowserPool({ adapter, maxSessions: 4 });
```
