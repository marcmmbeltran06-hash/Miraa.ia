import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResourceManifest, SourcePage, SourceProduct, SourceProject } from './types.js';
import { readJson, safeJoin } from './fs-utils.js';

class LazyHtmlMap extends Map<string, string> {
  private readonly files = new Map<string, string>();
  private readonly inline = new Map<string, string>();
  private readonly cache = new Map<string, string>();
  private readonly cacheLimit: number;

  constructor() {
    super();
    const configured = Number(process.env.AUTOWP_HTML_CACHE_PAGES ?? 8);
    this.cacheLimit = Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 8;
  }

  registerFile(slug: string, filePath: string): void {
    this.files.set(slug, filePath);
    super.set(slug, '');
  }

  override set(slug: string, html: string): this {
    this.inline.set(slug, html);
    super.set(slug, '');
    return this;
  }

  override get(slug: string): string | undefined {
    const inline = this.inline.get(slug);
    if (inline !== undefined) return inline;
    const cached = this.cache.get(slug);
    if (cached !== undefined) {
      this.cache.delete(slug);
      this.cache.set(slug, cached);
      return cached;
    }
    const filePath = this.files.get(slug);
    if (!filePath || !fs.existsSync(filePath)) return undefined;
    const html = fs.readFileSync(filePath, 'utf8');
    if (this.cacheLimit > 0) {
      this.cache.set(slug, html);
      while (this.cache.size > this.cacheLimit) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
    }
    return html;
  }
}

export class ProjectLoader {
  public load(rootPath: string): SourceProject {
    const reconstructionManifest = readJson<Record<string, unknown>>(path.join(rootPath, 'reconstruction-manifest.json'));
    const manifestPath = path.join(rootPath, 'manifest.json');
    const manifest = fs.existsSync(manifestPath) ? readJson<Record<string, unknown>>(manifestPath) : {};
    const wordpressIndex = readJson<Record<string, unknown>>(path.join(rootPath, 'wordpress', 'index.json'));
    // Older exports could classify every page that contained images as a
    // product. Keep the builder defensive: WooCommerce must only receive
    // records with actual commerce evidence, never generic portfolio pages.
    const products = readJson<SourceProduct[]>(path.join(rootPath, 'products.json')).filter((product) => this.isCommerceProduct(product));
    const wooCommerceCsv = fs.readFileSync(path.join(rootPath, 'woocommerce-products.csv'), 'utf-8');
    const resourceManifestPath = path.join(rootPath, 'resources', 'manifest.json');
    const resources = fs.existsSync(resourceManifestPath) ? readJson<ResourceManifest>(resourceManifestPath) : {};
    const optimizationPlanPath = path.join(rootPath, 'optimization-plan.json');
    const optimizationPlan = fs.existsSync(optimizationPlanPath) ? readJson<Record<string, unknown>>(optimizationPlanPath) : undefined;
    const pages = this.loadPages(rootPath, reconstructionManifest);
    // Full rendered HTML is by far the largest part of a large export. Keep
    // only a small configurable LRU in memory and read page bodies lazily.
    const rawHtmlBySlug = new LazyHtmlMap();

    for (const page of pages) {
      if (page.htmlRef) {
        const htmlPath = safeJoin(rootPath, page.htmlRef);
        if (fs.existsSync(htmlPath)) rawHtmlBySlug.registerFile(page.slug, htmlPath);
      } else if (page.html) {
        rawHtmlBySlug.set(page.slug, page.html);
      }
    }

    return {
      rootPath,
      manifest,
      reconstructionManifest,
      wordpressIndex,
      pages,
      products,
      wooCommerceCsv,
      resources,
      rawHtmlBySlug,
      optimizationPlan,
    };
  }

  private loadPages(rootPath: string, reconstructionManifest: Record<string, unknown>): SourcePage[] {
    const manifestPages = Array.isArray(reconstructionManifest.pages) ? reconstructionManifest.pages : [];
    if (manifestPages.length > 0) {
      return manifestPages.flatMap((entry): SourcePage[] => {
        if (!entry || typeof entry !== 'object') return [];
        const pageEntry = entry as Record<string, unknown>;
        const modelRef = typeof pageEntry.model === 'string' ? pageEntry.model : undefined;
        if (!modelRef) return [];
        const model = readJson<SourcePage>(safeJoin(rootPath, modelRef));
        return [{
          ...model,
          slug: typeof model.slug === 'string' ? model.slug : String(pageEntry.slug ?? 'page'),
          htmlRef: typeof pageEntry.html === 'string' ? pageEntry.html : model.htmlRef,
          visual: typeof pageEntry.screenshot === 'string'
            ? { ...(model.visual ?? {}), screenshotRef: pageEntry.screenshot }
            : model.visual,
        }];
      });
    }

    const pagesDir = path.join(rootPath, 'wordpress', 'pages');
    if (!fs.existsSync(pagesDir)) return [];
    return fs.readdirSync(pagesDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson<SourcePage>(path.join(pagesDir, name)));
  }

  private isCommerceProduct(product: SourceProduct): boolean {
    const hasPrice = [product.price, product.regularPrice, product.salePrice]
      .some((value) => typeof value === 'string' && /\d/.test(value));
    const hasSku = typeof product.sku === 'string' && product.sku.trim().length > 0;
    const hasVariants = Array.isArray(product.variants) && product.variants.length > 0;
    // A product without price is still legitimate when it has a SKU or a
    // selectable variation. Images, a title and a generic URL are not proof.
    return hasPrice || hasSku || hasVariants;
  }
}
