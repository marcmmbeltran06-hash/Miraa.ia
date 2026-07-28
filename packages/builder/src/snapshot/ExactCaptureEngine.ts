import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BuildContext } from '../types.js';

export interface ExactCaptureResult { available: boolean; artifactPath: string; missingRequests: string[]; sourceFilesRequired: string[]; }

/** Produces the durable EXACT_CAPTURE contract from a browser export. External
 * Browsertrix/ReplayWeb.page processes can fill the WACZ later; no fake exact
 * score is emitted when that artifact is absent. */
export class ExactCaptureEngine {
  public build(ctx: BuildContext): ExactCaptureResult {
    const root = path.join(ctx.outputPath, 'exact-capture');
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'screenshots'), { recursive: true });
    fs.mkdirSync(path.join(root, 'states'), { recursive: true });
    fs.mkdirSync(path.join(root, 'replay'), { recursive: true });
    const missing = (ctx.mediaMap.filter((item) => !item.localPath).map((item) => item.sourceUrl).filter(Boolean) as string[]);
    const sourceFilesRequired = missing.length ? missing.slice(0, 50).map((url) => `Recurso no localizado: ${url}`) : [];
    // Always produce a deterministic offline replay entry point. A real WACZ
    // produced by Browsertrix can replace this file later without changing
    // WordPress or the API contract.
    const htmlPages = ctx.source.pages.filter((page) => Boolean(ctx.source.rawHtmlBySlug.get(page.slug)?.trim()));
    const home = htmlPages.find((page) => page.slug === 'home') ?? htmlPages[0];
    const homeHtml = home ? ctx.source.rawHtmlBySlug.get(home.slug) : undefined;
    const integrity = { pagesDeclared: ctx.source.pages.length, pagesWithRawHtml: htmlPages.length, homeSourceSlug: home?.slug ?? null, complete: ctx.source.pages.length > 0 && htmlPages.length === ctx.source.pages.length, checkedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(ctx.validationPath, 'capture-integrity.json'), JSON.stringify(integrity, null, 2));
    // Never present a fabricated placeholder as an exact replay. If capture
    // data is incomplete, leave an explicit diagnostic document instead.
    fs.writeFileSync(path.join(root, 'replay', 'index.html'), homeHtml ?? '<!doctype html><title>Capture incomplete</title><p>Exact replay unavailable: the export contains no local HTML.</p>', 'utf8');
    for (const page of htmlPages) {
      const target = path.join(root, 'replay', 'pages', `${page.slug || 'home'}.html`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, ctx.source.rawHtmlBySlug.get(page.slug)!, 'utf8');
    }
    const normalizePath = (raw?: string): string => {
      try { const value = new URL(raw ?? '/').pathname || '/'; return value === '/' ? '/' : `/${value.replace(/^\/+|\/+$/g, '')}/`; } catch { return '/'; }
    };
    const routes = ctx.source.pages.map((page) => ({
      sourceUrl: page.sourceUrl ?? page.finalUrl ?? '',
      normalizedPath: normalizePath(page.finalUrl ?? page.sourceUrl),
      pageId: page.slug,
      captureStatus: htmlPages.some((item) => item.slug === page.slug) ? 'ready' : 'needs_reconstruction',
      renderStrategy: htmlPages.some((item) => item.slug === page.slug) ? 'offline-html-replay' : 'pending-source-files',
      localUrl: `http://127.0.0.1:${ctx.options.sitePort ?? 8080}${normalizePath(page.finalUrl ?? page.sourceUrl)}`,
      visualScore: null,
    }));
    const routeMap = routes.map((route) => ({ sourceUrl: route.sourceUrl, localPath: route.normalizedPath, pageId: route.pageId, template: route.pageId === 'home' ? 'front-page.php' : `templates/${route.pageId}.html`, renderStrategy: route.renderStrategy, sourceSnapshot: `exact-capture/replay/pages/${route.pageId}.html`, localAssets: true, seo: {}, status: route.captureStatus }));
    fs.writeFileSync(path.join(root, 'routes-manifest.json'), JSON.stringify({ schemaVersion: 1, routes }, null, 2));
    fs.writeFileSync(path.join(ctx.outputPath, 'route-map.json'), JSON.stringify({ schemaVersion: 1, routes: routeMap }, null, 2));
    const origins = new Set(ctx.source.pages.map((page) => { try { return new URL(page.sourceUrl ?? '').origin; } catch { return ''; } }).filter(Boolean));
    const originalLinks = ctx.source.pages.flatMap((page) => [...(ctx.source.rawHtmlBySlug.get(page.slug) ?? '').matchAll(/(?:href|action)=["'](https?:\/\/[^"']+)/gi)].map((match) => ({ page: page.slug, url: match[1] }))).filter((entry) => { try { return origins.has(new URL(entry.url).origin); } catch { return false; } });
    const rootRelativeLinks = ctx.source.pages.flatMap((page) => [...(ctx.source.rawHtmlBySlug.get(page.slug) ?? '').matchAll(/(?:href|action)=["'](\/(?!\/)[^"'#?]*)/gi)].map((match) => ({ page: page.slug, url: match[1] })));
    const missingLocalRoutes = routes.filter((route) => route.captureStatus !== 'ready').map((route) => route.normalizedPath);
    // This report describes the captured source, not a promise that a browser
    // will magically rewrite it.  The API replay endpoint performs the rewrite
    // at serve time, so source-domain links remain unresolved until that step
    // is verified.  Never report them as local merely because pages were copied.
    const sourceInternalLinks = originalLinks.length + rootRelativeLinks.length;
    fs.writeFileSync(path.join(ctx.validationPath, 'internal-navigation-report.json'), JSON.stringify({ expectedInternalLinks: sourceInternalLinks, localLinks: 0, rewrittenInternalLinks: 0, originalInternalLinks: sourceInternalLinks, missingLocalRoutes, externalInternalRedirects: originalLinks.length, unmappedMenuItems: 0, unmappedProductLinks: 0, sourceReferences: [...originalLinks, ...rootRelativeLinks], rewriteStrategy: 'api-exact-replay-at-serve-time', status: 'needs_reconstruction', reason: 'Runtime navigation rewrite has not been verified for every captured page.' }, null, 2));
    const states = ctx.source.pages.map((page) => ({ pageId: page.slug, sourceUrl: page.sourceUrl, states: ['initial', 'menu-open', 'modal-open', 'accordion-open', 'form-ready'], stability: 'manifested; interactive replay requires Browsertrix/Playwright capture' }));
    for (const state of states) fs.writeFileSync(path.join(root, 'states', `${state.pageId || 'home'}.json`), JSON.stringify(state, null, 2));
    const manifest = { schemaVersion: 1, engine: 'EXACT_CAPTURE', immutable: integrity.complete, wacz: null, replay: { available: Boolean(homeHtml), endpoint: '/exact-capture/replay/', strategy: 'offline-html-entrypoint' }, pages: states, missingRequests: missing, sourceFilesRequired, integrity };
    fs.writeFileSync(path.join(root, 'capture-manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(root, 'pages.jsonl'), ctx.source.pages.map((page) => JSON.stringify({ pageId: page.slug, sourceUrl: page.sourceUrl, finalUrl: page.finalUrl })).join('\n') + '\n');
    fs.writeFileSync(path.join(root, 'missing-requests.json'), JSON.stringify({ generatedAt: new Date().toISOString(), missingRequests: missing, sourceFilesRequired }, null, 2));
    fs.writeFileSync(path.join(root, 'render-strategy.json'), JSON.stringify({ strategy: 'offline-html-entrypoint', exactCaptureAvailable: false, exactVisualScore: null, reason: 'WACZ replay artifact is not available; this is a local deterministic fallback.' }, null, 2));
    return { available: false, artifactPath: path.join(root, 'site.wacz'), missingRequests: missing, sourceFilesRequired };
  }
}
