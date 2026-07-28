import { parseHTML } from 'linkedom';
import type {
  OpenGraphData,
  AnchorTextData,
  ImageData,
  CanonicalPageModel,
  CanonicalSiteModel,
  ComponentModel,
  ConfidenceDetection,
  FooterModel,
  FormFieldModel,
  FormModel,
  GlobalSeoModel,
  GlobalStyleModel,
  HeaderModel,
  LayoutBlockModel,
  LayoutSectionModel,
  NavigationItemModel,
  NavigationMenuModel,
  PlatformModel,
  PluginModel,
  RelationshipModel,
  SeoAnalyzer,
  SeoAnalyzerInput,
  SeoAnalyzerInputPage,
  SeoIssue,
  SeoIssueSeverity,
  SeoPageReport,
  SeoReport,
  SiteMediaModel,
  ThemeModel,
  WidgetModel,
  WordPressConfigurationModel,
  TwitterCardData,
  SectionModel,
  ColumnModel,
  UnsupportedDiscovery,
} from './types.js';
import { buildProductValidationStats, extractProductsFromDocument } from './ProductExtraction.js';

type LinkedomDocument = ReturnType<typeof parseHTML>['document'];

const DEFAULTS = {
  maxUrlLength: 115,
  maxImageBytes: 300_000,
  minTitleLength: 20,
  maxTitleLength: 65,
  minDescriptionLength: 70,
  maxDescriptionLength: 160,
};

function normalizeWhitespace(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeUrl(input: string, base?: string): string | undefined {
  try {
    return new URL(input, base).toString();
  } catch {
    return undefined;
  }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function createIssue(
  severity: SeoIssueSeverity,
  code: string,
  message: string,
  pageUrl?: string,
  meta?: Record<string, string | number | boolean>,
): SeoIssue {
  return { severity, code, message, pageUrl, meta };
}

function pushIssue(target: SeoIssue[], severity: SeoIssueSeverity, code: string, message: string, pageUrl?: string, meta?: Record<string, string | number | boolean>): void {
  target.push(createIssue(severity, code, message, pageUrl, meta));
}

function collectMetaByName(document: LinkedomDocument, name: string): string | undefined {
  const selector = `meta[name="${name}"]`;
  return normalizeWhitespace(document.querySelector(selector)?.getAttribute('content'));
}

function collectMetaByProperty(document: LinkedomDocument, property: string): string | undefined {
  const selector = `meta[property="${property}"]`;
  return normalizeWhitespace(document.querySelector(selector)?.getAttribute('content'));
}

function collectHeadings(document: LinkedomDocument, tag: 'h1' | 'h2' | 'h3'): string[] {
  return Array.from(document.querySelectorAll(tag))
    .map((el) => normalizeWhitespace(el.textContent))
    .filter((v): v is string => v !== undefined);
}

function gatherLinks(page: SeoAnalyzerInputPage): { internal: string[]; external: string[] } {
  const { document } = parseHTML(page.html);
  const internal = new Set<string>();
  const external = new Set<string>();

  const finalOrigin = (() => {
    try {
      return new URL(page.finalUrl).origin;
    } catch {
      return undefined;
    }
  })();

  for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    const absolute = normalizeUrl(href, page.finalUrl);
    if (!absolute) continue;

    if (finalOrigin !== undefined && new URL(absolute).origin === finalOrigin) {
      internal.add(absolute);
    } else {
      external.add(absolute);
    }
  }

  return {
    internal: [...internal],
    external: [...external],
  };
}

function readOpenGraph(document: LinkedomDocument): OpenGraphData {
  return {
    title: collectMetaByProperty(document, 'og:title'),
    description: collectMetaByProperty(document, 'og:description'),
    image: collectMetaByProperty(document, 'og:image'),
    url: collectMetaByProperty(document, 'og:url'),
    type: collectMetaByProperty(document, 'og:type'),
  };
}

function readTwitter(document: LinkedomDocument): TwitterCardData {
  return {
    card: collectMetaByName(document, 'twitter:card'),
    title: collectMetaByName(document, 'twitter:title'),
    description: collectMetaByName(document, 'twitter:description'),
    image: collectMetaByName(document, 'twitter:image'),
  };
}

function slugFromUrl(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).join('-') || 'home';
  } catch {
    return 'page';
  }
}

function stableId(prefix: string, value: string): string {
  return `${prefix}:${value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'item'}`;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function parseJsonLd(document: LinkedomDocument): unknown[] {
  return Array.from(document.querySelectorAll('script[type="application/ld+json"]')).flatMap((node) => {
    const content = node.textContent?.trim();
    if (!content) return [];
    try {
      const parsed = JSON.parse(content) as unknown;
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  });
}

function structuredDataTypes(values: unknown[]): string[] {
  const types = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const type = obj['@type'];
      if (typeof type === 'string') types.add(type);
      if (Array.isArray(type)) {
        type.filter((item): item is string => typeof item === 'string').forEach((item) => types.add(item));
      }
      Object.values(obj).forEach(visit);
    }
  };
  values.forEach(visit);
  return [...types].sort();
}

function collectAnchorTexts(document: LinkedomDocument, page: SeoAnalyzerInputPage): AnchorTextData[] {
  const origin = new URL(page.finalUrl).origin;
  return Array.from(document.querySelectorAll('a[href]')).flatMap((anchor) => {
    const hrefRaw = anchor.getAttribute('href');
    const href = hrefRaw ? normalizeUrl(hrefRaw, page.finalUrl) : undefined;
    if (!href) return [];
    return [{
      href,
      text: normalizeWhitespace(anchor.textContent) ?? '',
      external: new URL(href).origin !== origin,
    }];
  });
}

function collectImages(document: LinkedomDocument, page: SeoAnalyzerInputPage, maxImageBytes: number): { images: ImageData[]; imagesWithoutAlt: string[]; heavyImages: string[] } {
  const withoutAlt: string[] = [];
  const heavy: string[] = [];
  const images: ImageData[] = [];

  for (const img of Array.from(document.querySelectorAll('img'))) {
    const srcRaw = img.getAttribute('src') ?? '';
    const src = normalizeUrl(srcRaw, page.finalUrl) ?? srcRaw;
    const alt = normalizeWhitespace(img.getAttribute('alt'));
    const bytes = page.imageByteSizeByUrl?.[src];
    images.push({
      src,
      alt,
      width: Number(img.getAttribute('width')) || undefined,
      height: Number(img.getAttribute('height')) || undefined,
      bytes,
    });
    if (!alt) {
      withoutAlt.push(src);
    }

    if (typeof bytes === 'number' && bytes > maxImageBytes) {
      heavy.push(src);
      continue;
    }

    if (src.startsWith('data:image/')) {
      const bytes = byteLength(src);
      if (bytes > maxImageBytes) {
        heavy.push(src);
      }
    }
  }

  return { images, imagesWithoutAlt: withoutAlt, heavyImages: heavy };
}

function detection(name: string, confidence: number, evidence: string[], version?: string): ConfidenceDetection {
  return { name, confidence, evidence: uniqueStrings(evidence), version };
}

function detectByPatterns(text: string, patterns: Array<[string, RegExp, number]>): ConfidenceDetection[] {
  return patterns.flatMap(([name, pattern, confidence]) => {
    const match = text.match(pattern);
    return match ? [detection(name, confidence, [match[0]], match[1])] : [];
  });
}

function detectPlatform(document: LinkedomDocument, html: string): PlatformModel {
  const generator = collectMetaByName(document, 'generator') ?? '';
  const text = `${generator}\n${html}`;
  const detected = detectByPatterns(text, [
    ['WordPress', /wp-content|wp-includes|WordPress\s*([0-9.]+)?/i, 90],
    ['Shopify', /cdn\.shopify\.com|Shopify(?:\.theme|Analytics)?/i, 90],
    ['PrestaShop', /prestashop|\/modules\/ps_|content="PrestaShop/i, 85],
    ['Magento', /Magento|mage\/|data-mage-init/i, 85],
    ['WooCommerce', /woocommerce|wc-cart|wc-block/i, 80],
    ['Webflow', /webflow\.js|data-wf-page/i, 80],
    ['Wix', /wixstatic\.com|X-Wix/i, 75],
    ['Squarespace', /squarespace|static1\.squarespace\.com/i, 75],
    ['Next.js', /__NEXT_DATA__/i, 80],
    ['Nuxt', /__NUXT__/i, 80],
    ['Astro', /astro-island|data-astro/i, 70],
  ]);
  return {
    primary: detected.sort((a, b) => b.confidence - a.confidence)[0],
    detected,
    sourceTechnologyIndependent: true,
  };
}

function detectTheme(document: LinkedomDocument, html: string): ThemeModel {
  const themeMatch = html.match(/wp-content\/themes\/([^/"')?]+)/i);
  const framework = detectByPatterns(html, [
    ['Bootstrap', /bootstrap(?:\.min)?\.css/i, 70],
    ['Tailwind', /tailwind|tw-/i, 60],
    ['Genesis', /genesis/i, 70],
    ['Astra', /astra/i, 70],
    ['Kadence', /kadence/i, 70],
    ['GeneratePress', /generatepress/i, 70],
  ])[0]?.name;
  const blockTheme = /wp-block-|theme\.json|global-styles-inline-css/i.test(html);
  const themeJsonScript = Array.from(document.querySelectorAll('script[type="application/json"]'))
    .find((script) => /settings|styles|palette|typography/i.test(script.textContent ?? ''));
  let themeJson: unknown;
  if (themeJsonScript?.textContent) {
    try { themeJson = JSON.parse(themeJsonScript.textContent); } catch {
      themeJson = undefined;
    }
  }
  return {
    active: themeMatch?.[1],
    framework,
    type: blockTheme ? 'block' : themeMatch ? 'classic' : 'unknown',
    themeJson,
    confidence: themeMatch ? 80 : blockTheme ? 65 : 20,
    evidence: uniqueStrings([themeMatch?.[0], framework, blockTheme ? 'block theme markers' : undefined]),
  };
}

function detectBuilder(html: string): { primary?: ConfidenceDetection; secondary: ConfidenceDetection[] } {
  const builders = detectByPatterns(html, [
    ['Elementor', /elementor(?:-pro)?|data-elementor/i, 95],
    ['Bricks', /bricks-|data-bricks/i, 90],
    ['Divi', /et_pb_|Divi/i, 90],
    ['Beaver Builder', /fl-builder|fl-row|fl-module/i, 85],
    ['Oxygen', /ct-section|oxygen/i, 85],
    ['WPBakery', /wpb_|vc_row|js_composer/i, 85],
    ['Kadence', /kt-|kadence/i, 75],
    ['Spectra', /uagb-|spectra/i, 75],
    ['GenerateBlocks', /gb-container|generateblocks/i, 75],
    ['Gutenberg', /wp-block-|block-library/i, 80],
  ]).sort((a, b) => b.confidence - a.confidence);
  return { primary: builders[0], secondary: builders.slice(1) };
}

function mediaId(url: string): string {
  return stableId('media', url);
}

function collectSiteMedia(document: LinkedomDocument, page: SeoAnalyzerInputPage, images: ImageData[]): SiteMediaModel[] {
  const favicon = Array.from(document.querySelectorAll('link[rel*="icon" i]')).flatMap((node) => {
    const href = node.getAttribute('href');
    const url = href ? normalizeUrl(href, page.finalUrl) : undefined;
    return url ? [{ id: mediaId(url), url, type: 'favicon' as const, sourcePageUrl: page.finalUrl }] : [];
  });
  const imageMedia = images.map((image) => ({
    id: mediaId(image.src),
    url: image.src,
    type: /logo/i.test(image.alt ?? image.src) ? 'logo' as const : image.src.endsWith('.svg') ? 'svg' as const : 'image' as const,
    alt: image.alt,
    sourcePageUrl: page.finalUrl,
  }));
  const linkedMedia = Array.from(document.querySelectorAll('a[href], video[src], source[src]')).flatMap((node) => {
    const raw = node.getAttribute('href') ?? node.getAttribute('src');
    const url = raw ? normalizeUrl(raw, page.finalUrl) : undefined;
    if (!url || !/\.(pdf|docx?|xlsx?|zip|mp4|mov|webm|svg)(?:$|\?)/i.test(url)) return [];
    const type = /\.(mp4|mov|webm)(?:$|\?)/i.test(url) ? 'video' as const : url.includes('.svg') ? 'svg' as const : 'document' as const;
    return [{ id: mediaId(url), url, type, sourcePageUrl: page.finalUrl }];
  });
  return dedupeMedia([...favicon, ...imageMedia, ...linkedMedia]);
}

function dedupeMedia(media: SiteMediaModel[]): SiteMediaModel[] {
  const byId = new Map<string, SiteMediaModel>();
  for (const item of media) if (!byId.has(item.id)) byId.set(item.id, item);
  return [...byId.values()];
}

// Aggregate site‑level sections from page models
function collectSiteSections(pageModels: CanonicalPageModel[]): SectionModel[] {
  const sectionsMap = new Map<string, SectionModel>();
  for (const page of pageModels) {
    if (!page.layout) continue;
    for (const section of page.layout) {
      if (!sectionsMap.has(section.id)) {
        // Convert LayoutSectionModel to SectionModel (components empty for now)
        const sec: SectionModel = {
          id: section.id,
          type: section.type,
          source: undefined,
          confidence: undefined,
          components: [],
          children: [],
        };
        sectionsMap.set(section.id, sec);
      }
    }
  }
  return Array.from(sectionsMap.values());
}

// Aggregate site‑level columns (placeholder columns) from page models
function collectSiteColumns(pageModels: CanonicalPageModel[]): ColumnModel[] {
  const columnsMap = new Map<string, ColumnModel>();
  for (const page of pageModels) {
    if (!page.layout) continue;
    for (const sec of page.layout) {
      const colCount = (sec as LayoutSectionModel).columns ?? 1;
      for (let i = 0; i < colCount; i++) {
        const colId = `${sec.id}-col-${i}`;
        if (!columnsMap.has(colId)) {
          const column: ColumnModel = {
            id: colId,
            parentSectionId: sec.id,
            source: undefined,
            confidence: undefined,
            components: [],
          };
          columnsMap.set(colId, column);
        }
      }
    }
  }
  return Array.from(columnsMap.values());
}

function collectNavigation(document: LinkedomDocument, page: SeoAnalyzerInputPage): NavigationMenuModel[] {
  const navs = Array.from(document.querySelectorAll('nav, header ul, footer ul, [aria-label*="breadcrumb" i]'));
  return navs.flatMap((nav, index) => {
    const links = Array.from(nav.querySelectorAll('a[href]')).slice(0, 80);
    if (links.length === 0) return [];
    const text = `${nav.getAttribute('aria-label') ?? ''} ${nav.className ?? ''} ${nav.id ?? ''}`.toLowerCase();
    const position = text.includes('breadcrumb') ? 'breadcrumbs' : text.includes('footer') ? 'footer' : text.includes('mobile') ? 'mobile' : index === 0 ? 'primary' : 'secondary';
    const items: NavigationItemModel[] = links.map((link, itemIndex) => ({
      id: stableId('nav-item', `${page.finalUrl}-${index}-${itemIndex}-${link.textContent ?? ''}`),
      label: normalizeWhitespace(link.textContent) ?? link.getAttribute('href') ?? '',
      href: normalizeUrl(link.getAttribute('href') ?? '', page.finalUrl),
      children: [],
    }));
    return [{
      id: stableId('menu', `${page.finalUrl}-${index}-${position}`),
      name: nav.getAttribute('aria-label') ?? `${position} menu`,
      position,
      items,
    }];
  });
}

function collectHeader(document: LinkedomDocument, navigation: NavigationMenuModel[], media: SiteMediaModel[]): HeaderModel {
  const header = document.querySelector('header, [role="banner"], .site-header, #header');
  const text = `${header?.textContent ?? ''} ${header?.className ?? ''}`.toLowerCase();
  return {
    logoRefs: media.filter((item) => item.type === 'logo').map((item) => item.id),
    navigationRefs: navigation.filter((menu) => menu.position === 'primary' || menu.position === 'mobile').map((menu) => menu.id),
    hasSearch: !!header?.querySelector('input[type="search"], .search, [role="search"]'),
    hasCart: /cart|basket|bag|carrito|cesta/.test(text),
    hasWishlist: /wishlist|favorit/.test(text),
    hasLogin: /login|account|my account|cuenta|acceder/.test(text),
    ctaTexts: uniqueStrings(Array.from(header?.querySelectorAll('a, button') ?? []).map((node) => normalizeWhitespace(node.textContent))).slice(0, 10),
    iconRefs: media.filter((item) => item.type === 'icon' || item.type === 'svg').map((item) => item.id),
    sticky: /sticky|fixed/.test(`${header?.className ?? ''}`.toLowerCase()),
    transparent: /transparent/.test(`${header?.className ?? ''}`.toLowerCase()),
    heights: uniqueStrings([header?.getAttribute('height') ?? undefined, header?.getAttribute('style')?.match(/height\s*:\s*([^;]+)/i)?.[1]]),
    layout: uniqueStrings(Array.from(header?.children ?? []).map((child) => child.tagName.toLowerCase())),
  };
}

function collectFooter(document: LinkedomDocument, navigation: NavigationMenuModel[], media: SiteMediaModel[], widgets: WidgetModel[], forms: FormModel[]): FooterModel {
  const footer = document.querySelector('footer, [role="contentinfo"], .site-footer, #footer');
  const columns = footer ? Math.max(1, Array.from(footer.querySelectorAll('.column, [class*="col-"], .widget')).length) : 0;
  return {
    columns,
    widgetRefs: widgets.filter((widget) => widget.id.includes('footer')).map((widget) => widget.id),
    linkRefs: navigation.filter((menu) => menu.position === 'footer').map((menu) => menu.id),
    copyright: normalizeWhitespace(Array.from(footer?.querySelectorAll('*') ?? []).map((node) => node.textContent ?? '').find((text) => /©|copyright/i.test(text))),
    socialRefs: Array.from(footer?.querySelectorAll('a[href*="facebook"], a[href*="instagram"], a[href*="linkedin"], a[href*="twitter"], a[href*="x.com"], a[href*="youtube"]') ?? []).map((node) => stableId('social', node.getAttribute('href') ?? '')),
    logoRefs: media.filter((item) => item.type === 'logo').map((item) => item.id),
    newsletterRefs: forms.filter((form) => /newsletter|subscribe|mailchimp/i.test(form.provider ?? form.id)).map((form) => form.id),
  };
}

function collectForms(document: LinkedomDocument, page: SeoAnalyzerInputPage): FormModel[] {
  return Array.from(document.querySelectorAll('form')).map((form, index) => {
    const provider = /wpcf7/.test(form.className ?? '') ? 'Contact Form 7' : /wpforms/.test(form.className ?? '') ? 'WPForms' : /fluentform/.test(form.className ?? '') ? 'Fluent Forms' : undefined;
    const fields: FormFieldModel[] = Array.from(form.querySelectorAll('input, textarea, select')).map((field) => ({
      name: field.getAttribute('name') ?? undefined,
      label: normalizeWhitespace(field.getAttribute('aria-label') ?? field.getAttribute('placeholder')),
      type: field.getAttribute('type') ?? field.tagName.toLowerCase(),
      required: field.hasAttribute('required') || field.getAttribute('aria-required') === 'true',
      validation: field.getAttribute('pattern') ?? undefined,
    }));
    return {
      id: stableId('form', `${page.finalUrl}-${index}`),
      provider,
      fields,
      actions: uniqueStrings([form.getAttribute('action') ?? undefined, form.getAttribute('method') ?? undefined]),
    };
  });
}

function collectWidgets(document: LinkedomDocument, page: SeoAnalyzerInputPage): WidgetModel[] {
  return Array.from(document.querySelectorAll('.widget, [class*="widget"], aside, [role="complementary"]')).slice(0, 80).map((widget, index) => ({
    id: stableId('widget', `${page.finalUrl}-${index}-${widget.className ?? widget.tagName}`),
    type: normalizeWhitespace(String(widget.className)) ?? widget.tagName.toLowerCase(),
    title: normalizeWhitespace(widget.querySelector('h1,h2,h3,h4,h5,h6')?.textContent),
    text: normalizeWhitespace(widget.textContent)?.slice(0, 300),
    mediaRefs: Array.from(widget.querySelectorAll('img[src]')).flatMap((img) => {
      const src = normalizeUrl(img.getAttribute('src') ?? '', page.finalUrl);
      return src ? [mediaId(src)] : [];
    }),
  }));
}

function componentType(element: Element): ComponentModel['type'] {
  const marker = `${element.className ?? ''} ${element.id ?? ''} ${element.getAttribute('data-widget_type') ?? ''}`.toLowerCase();
  const tag = element.tagName.toLowerCase();

  // Tag based detection
  if (tag === 'form') return 'form';
  if (tag === 'img') return 'image';
  if (tag === 'video') return 'video';
  if (tag === 'a') return 'navigation';
  if (/^h[1-6]$/.test(tag)) return 'heading';
  if (tag === 'p') return 'paragraph';
  if (tag === 'button') return 'button';
  if (tag === 'ul' || tag === 'ol' || tag === 'li') return 'list';

  // Class / ID heuristics
  if (/slider|slideshow|swiper/.test(marker)) return 'carousel';
  if (/carousel/.test(marker)) return 'gallery';
  if (/accordion/.test(marker)) return 'accordion';
  if (/\btabs?\b/.test(marker)) return 'tabs';
  if (/faq|schema-faq/.test(marker)) return 'accordion';
  if (/testimonial|review/.test(marker)) return 'paragraph';
  if (/grid|products|collection/.test(marker)) return 'section';
  if (/section/.test(marker)) return 'section';
  if (/col|column/.test(marker)) return 'column';
  if (/container/.test(marker)) return 'container';
  if (/banner/.test(marker)) return 'section';
  if (/hero/.test(marker)) return 'section';
  if (/cta|call-to-action/.test(marker)) return 'button';
  if (/newsletter|subscribe/.test(marker)) return 'form';
  if (/icon/.test(marker)) return 'icon';
  if (/video/.test(marker)) return 'video';

  // Fallback
  return 'unknown';
}

function collectComponents(document: LinkedomDocument, page: SeoAnalyzerInputPage): ComponentModel[] {
  const selector = [
    '[class*="slider"]', '[class*="swiper"]', '[class*="carousel"]', '[class*="accordion"]',
    '[class*="tab"]', '[class*="faq"]', '[class*="testimonial"]', '[class*="grid"]',
    '[class*="banner"]', '[class*="hero"]', '[class*="cta"]', '[class*="newsletter"]', 'form',
  ].join(', ');
  return Array.from(document.querySelectorAll(selector)).slice(0, 120).flatMap((element, index) => {
    const type = componentType(element);
    if (!type) return [];
    return [{
      id: stableId('component', `${page.finalUrl}-${index}-${type}`),
      type,
      provider: element.getAttribute('data-widget_type')?.split('.')[0],
      confidence: { value: 70, source: 'dom', confidence: 1 },
      settings: {
        tag: element.tagName.toLowerCase(),
        classes: String(element.className ?? ''),
        itemCount: element.children.length,
      },
      mediaRefs: Array.from(element.querySelectorAll('img[src]')).flatMap((img) => {
        const src = normalizeUrl(img.getAttribute('src') ?? '', page.finalUrl);
        return src ? [mediaId(src)] : [];
      }),
    }];
  });
}

function blockFromElement(element: Element, page: SeoAnalyzerInputPage, index: number): LayoutBlockModel {
  const type = componentType(element) ?? (/^h[1-6]$/i.test(element.tagName) ? 'heading' : element.tagName.toLowerCase() === 'img' ? 'image' : element.tagName.toLowerCase() === 'a' ? 'link' : 'container');
  return {
    id: stableId('block', `${page.finalUrl}-${index}-${element.tagName}-${normalizeWhitespace(element.textContent) ?? ''}`),
    type,
    tag: element.tagName.toLowerCase(),
    text: normalizeWhitespace(element.textContent)?.slice(0, 240),
    mediaRefs: Array.from(element.querySelectorAll('img[src]')).flatMap((img) => {
      const src = normalizeUrl(img.getAttribute('src') ?? '', page.finalUrl);
      return src ? [mediaId(src)] : [];
    }),
    widgetRefs: [],
    componentRefs: [],
    children: Array.from(element.children).slice(0, 8).map((child, childIndex) => blockFromElement(child, page, (index * 10) + childIndex + 1)),
  };
}

function collectLayout(document: LinkedomDocument, page: SeoAnalyzerInputPage): LayoutSectionModel[] {
  // Expanded selectors to capture more section-like containers across platforms
  const sectionSelector = [
    'main > section', 'main > article', 'main > div',
    'body > section', 'body > article', 'body > div',
    '.elementor-section', '.elementor-widget-wrap',
    '.wp-block-group', '.wp-block-cover', '.wp-block-column',
    '[class*="section"]', '[class*="hero"]', '[class*="banner"]',
    '[class*="container"]', '[class*="wrapper"]',
    '[class*="row"]', '[class*="grid"]', '[class*="columns"]',
  ].join(', ');
  const roots = Array.from(document.querySelectorAll(sectionSelector)).slice(0, 80);
  // Filter out nested duplicates — prefer outermost section-like elements
  const topLevel: Element[] = [];
  for (const el of roots) {
    const parent = el.parentElement;
    if (parent && roots.includes(parent)) continue; // Skip if parent is also a root
    if (topLevel.some((existing) => existing.contains(el))) continue; // Skip if contained by another root
    topLevel.push(el);
    if (topLevel.length >= 40) break;
  }
  const sectionRoots = topLevel.length > 0 ? topLevel : Array.from(document.body?.children ?? []).slice(0, 20);
  return sectionRoots.map((section, index) => ({
    id: stableId('section', `${page.finalUrl}-${index}-${section.tagName}-${section.className ?? ''}`),
    type: componentType(section) ?? section.tagName.toLowerCase(),
    order: index,
    columns: Math.max(1, Array.from(section.children).filter((child) => /col|column|wp-block-column|grid|cell/i.test(String(child.className))).length),
    // Build deeper hierarchy: capture 2 levels of children instead of 1
    blocks: Array.from(section.children).slice(0, 20).map((child, childIndex) => ({
      ...blockFromElement(child, page, (index * 100) + childIndex),
      // Second-level children for richer hierarchy
      children: Array.from(child.children).slice(0, 8).map((grandchild, gcIndex) =>
        blockFromElement(grandchild, page, (index * 1000) + (childIndex * 10) + gcIndex + 1),
      ),
    })),
  }));
}

function collectGlobalStyles(document: LinkedomDocument): GlobalStyleModel {
  const styleText = Array.from(document.querySelectorAll('style')).map((style) => style.textContent ?? '').join('\n');
  const inlineStyles = Array.from(document.querySelectorAll('[style]')).map((node) => node.getAttribute('style') ?? '').join(';');
  const css = `${styleText}\n${inlineStyles}`;
  const variables = Object.fromEntries([...css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+)/gi)].map((match) => [match[1], match[2].trim()]));
  return {
    colors: uniqueStrings([...css.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)/gi)].map((match) => match[0])).slice(0, 80),
    gradients: uniqueStrings([...css.matchAll(/(?:linear|radial)-gradient\([^)]+\)/gi)].map((match) => match[0])).slice(0, 40),
    fonts: uniqueStrings([...css.matchAll(/font-family\s*:\s*([^;]+)/gi)].map((match) => match[1])).slice(0, 40),
    fontSizes: uniqueStrings([...css.matchAll(/font-size\s*:\s*([^;]+)/gi)].map((match) => match[1])).slice(0, 40),
    fontWeights: uniqueStrings([...css.matchAll(/font-weight\s*:\s*([^;]+)/gi)].map((match) => match[1])).slice(0, 30),
    spacings: uniqueStrings([...css.matchAll(/(?:margin|padding|gap)\s*:\s*([^;]+)/gi)].map((match) => match[1])).slice(0, 60),
    radii: uniqueStrings([...css.matchAll(/border-radius\s*:\s*([^;]+)/gi)].map((match) => match[1])).slice(0, 30),
    shadows: uniqueStrings([...css.matchAll(/box-shadow\s*:\s*([^;]+)/gi)].map((match) => match[1])).slice(0, 30),
    cssVariables: variables,
    globalCssRefs: Array.from(document.querySelectorAll('link[rel="stylesheet"][href]')).flatMap((link) => {
      const href = link.getAttribute('href');
      return href ? [href] : [];
    }),
  };
}

function collectPlugins(html: string): PluginModel[] {
  return detectByPatterns(html, [
    ['WooCommerce', /woocommerce|wc-block|wc-cart/i, 90],
    ['RankMath', /rank-math|rankmath/i, 85],
    ['Yoast', /yoast|wpseo/i, 85],
    ['Elementor', /elementor/i, 90],
    ['ACF', /acf-|advanced-custom-fields/i, 75],
    ['WPML', /wpml|sitepress/i, 75],
    ['Polylang', /polylang|pll_/i, 75],
    ['Contact Form 7', /wpcf7|contact-form-7/i, 85],
    ['WPForms', /wpforms/i, 85],
    ['Fluent Forms', /fluentform|fluent-forms/i, 85],
    ['CookieYes', /cookieyes|cky-/i, 80],
    ['Complianz', /complianz|cmplz-/i, 80],
  ]);
}

function collectWordPressConfig(document: LinkedomDocument, pageReports: SeoPageReport[]): WordPressConfigurationModel {
  const html = document.querySelector('html');
  const urls = pageReports.map((page) => page.finalUrl);
  const findPage = (pattern: RegExp) => urls.find((url) => pattern.test(url));
  return {
    language: html?.getAttribute('lang') ?? undefined,
    permalinkPattern: urls.some((url) => /\?p=/.test(url)) ? 'plain' : 'pretty',
    frontPageRef: pageReports.find((page) => slugFromUrl(page.finalUrl) === 'home')?.siteModel?.id,
    blogPageRef: pageReports.find((page) => /blog|news|noticias/i.test(page.finalUrl))?.siteModel?.id,
    shopPageRef: pageReports.find((page) => /shop|tienda|store/i.test(page.finalUrl))?.siteModel?.id,
    cartPageRef: findPage(/cart|carrito|basket/i),
    checkoutPageRef: findPage(/checkout|finalizar-compra/i),
    accountPageRef: findPage(/account|mi-cuenta|my-account/i),
  };
}

function findSchema(values: unknown[], typeName: string): unknown | undefined {
  const visit = (value: unknown): unknown | undefined => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found) return found;
      }
      return undefined;
    }
    if (!value || typeof value !== 'object') return undefined;
    const obj = value as Record<string, unknown>;
    const type = obj['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((item) => typeof item === 'string' && item.toLowerCase() === typeName.toLowerCase())) return value;
    for (const item of Object.values(obj)) {
      const found = visit(item);
      if (found) return found;
    }
    return undefined;
  };
  return visit(values);
}

function buildPageModel(page: SeoAnalyzerInputPage, document: LinkedomDocument, title: string | undefined, images: ImageData[], products: SeoPageReport['products']): CanonicalPageModel {
  const components = collectComponents(document, page);
  const forms = collectForms(document, page);
  const widgets = collectWidgets(document, page);
  const media = collectSiteMedia(document, page, images);
  const id = stableId('page', page.finalUrl);
  const relationships: RelationshipModel[] = [
    ...media.map((item) => ({ from: id, to: item.id, type: 'uses-media' })),
    ...components.map((item) => ({ from: id, to: item.id, type: 'contains-component' })),
    ...forms.map((item) => ({ from: id, to: item.id, type: 'contains-form' })),
    ...widgets.map((item) => ({ from: id, to: item.id, type: 'contains-widget' })),
    ...products.map((product) => ({ from: id, to: stableId('product', product.id ?? product.sku ?? product.url ?? product.name ?? 'product'), type: 'contains-product' })),
  ];
  return {
    id,
    sourceUrl: page.url,
    finalUrl: page.finalUrl,
    title,
    slug: slugFromUrl(page.finalUrl),
    layout: collectLayout(document, page),
    components,
    forms,
    widgets,
    mediaRefs: media.map((item) => item.id),
    productRefs: products.map((product) => stableId('product', product.id ?? product.sku ?? product.url ?? product.name ?? 'product')),
    relationships,
  };
}

function buildSiteModel(pageReports: SeoPageReport[], inputPages: SeoAnalyzerInputPage[]): CanonicalSiteModel {
  const firstHtml = inputPages[0]?.html ?? '';
  const { document } = parseHTML(firstHtml);
  const allHtml = inputPages.map((page) => page.html).join('\n');
  const navigation = pageReports.flatMap((page, index) => {
    const inputPage = inputPages[index];
    if (!inputPage) return [];
    const parsed = parseHTML(inputPage.html);
    return collectNavigation(parsed.document, inputPage);
  });
  const media = dedupeMedia(pageReports.flatMap((page, index) => {
    const inputPage = inputPages[index];
    if (!inputPage) return [];
    const parsed = parseHTML(inputPage.html);
    return collectSiteMedia(parsed.document, inputPage, page.images);
  }));
  const pageModels = pageReports.flatMap((page) => page.siteModel ? [page.siteModel] : []);
  const sections = collectSiteSections(pageModels);
const columns = collectSiteColumns(pageModels);
const unsupportedDiscoveries: UnsupportedDiscovery[] = [];
const components = pageModels.flatMap((page) => page.components);
  const forms = pageModels.flatMap((page) => page.forms);
  const widgets = pageModels.flatMap((page) => page.widgets);
  const schema = pageReports.flatMap((page) => page.jsonLd);
  const seo: GlobalSeoModel = {
    schemaTypes: uniqueStrings(pageReports.flatMap((page) => page.structuredDataTypes)),
    schema,
    organization: findSchema(schema, 'Organization'),
    localBusiness: findSchema(schema, 'LocalBusiness'),
    breadcrumbs: navigation.filter((menu) => menu.position === 'breadcrumbs'),
    robots: uniqueStrings(pageReports.map((page) => page.robots)),
    sitemaps: uniqueStrings([...allHtml.matchAll(/https?:\/\/[^"'\s]+sitemap[^"'\s]*/gi)].map((match) => match[0])),
    feeds: uniqueStrings([...allHtml.matchAll(/https?:\/\/[^"'\s]+(?:feed|rss|atom)[^"'\s]*/gi)].map((match) => match[0])),
  };
  return {
    artifactName: 'wordpress-project.json',
    modelKind: 'canonical-site-model',
    version: '1.0',
    canonicalModelVersion: '2.0',
    extractorVersion: '1.0.0',
    generatedAt: new Date().toISOString(),
    generatorCompatibility: { wordpress: '>=1.0' },
    targetHint: 'wordpress',
    platform: detectPlatform(document, allHtml),
    theme: detectTheme(document, allHtml),
    builder: detectBuilder(allHtml),
    header: collectHeader(document, navigation, media),
    footer: collectFooter(document, navigation, media, widgets, forms),
    navigation,
    globalStyles: collectGlobalStyles(document),
    pages: pageModels,
    components,
    plugins: collectPlugins(allHtml),
    forms,
    widgets,
    // Site‑level aggregations
    sections,
    columns,
    unsupportedDiscoveries,
    wordpressConfiguration: collectWordPressConfig(document, pageReports),
    media,
    seo,
    relationships: pageModels.flatMap((page) => page.relationships),
  };
}

function groupDuplicates(map: Map<string, Set<string>>): Array<{ value: string; urls: string[] }> {
  return [...map.entries()]
    .filter(([, urls]) => urls.size > 1)
    .map(([value, urls]) => ({ value, urls: [...urls] }));
}

export class DefaultSeoAnalyzer implements SeoAnalyzer {
  analyze(input: SeoAnalyzerInput): SeoReport {
    const options = { ...DEFAULTS, ...(input.options ?? {}) };
    const pageReports: SeoPageReport[] = [];
    const productStats = [];
    const titleToUrls = new Map<string, Set<string>>();
    const descriptionToUrls = new Map<string, Set<string>>();
    const statusByUrl = new Map<string, number>();

    for (const page of input.pages) {
      statusByUrl.set(page.url, page.statusCode);
      statusByUrl.set(page.finalUrl, page.statusCode);
    }

    for (const page of input.pages) {
      const issues: SeoIssue[] = [];
      const { document } = parseHTML(page.html);

      const title = normalizeWhitespace(document.querySelector('title')?.textContent);
      const metaDescription = collectMetaByName(document, 'description');
      const robots = collectMetaByName(document, 'robots');
      const canonicalRaw = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
      const canonical = canonicalRaw ? normalizeUrl(canonicalRaw, page.finalUrl) : undefined;

      const headings = {
        h1: collectHeadings(document, 'h1'),
        h2: collectHeadings(document, 'h2'),
        h3: collectHeadings(document, 'h3'),
      };

      const openGraph = readOpenGraph(document);
      const twitter = readTwitter(document);
      const jsonLd = parseJsonLd(document);
      const dataTypes = structuredDataTypes(jsonLd);
      const anchorTexts = collectAnchorTexts(document, page);
      const productExtraction = extractProductsFromDocument(document, {
        sourceUrl: page.finalUrl,
        canonical,
        title,
        metaDescription,
        robots,
        openGraph,
        twitter,
        jsonLd,
        structuredDataTypes: dataTypes,
      });
      const products = productExtraction.products;
      productStats.push(productExtraction.stats);

      const links = gatherLinks(page);
      const brokenLinks = links.internal.filter((url) => {
        const code = statusByUrl.get(url);
        return typeof code === 'number' && code >= 400;
      });

      const { images, imagesWithoutAlt, heavyImages } = collectImages(document, page, options.maxImageBytes);
      const siteModel = buildPageModel(page, document, title, images, products);
      const noindex = /\bnoindex\b/i.test(robots ?? '');
      const nofollow = /\bnofollow\b/i.test(robots ?? '');
      const wordCount = (normalizeWhitespace(document.body?.textContent)?.split(/\s+/).filter(Boolean).length) ?? 0;
      const thinContent = wordCount > 0 && wordCount < 250;
      const indexability = page.statusCode >= 400 ? 'error' : noindex ? 'noindex' : 'indexable';

      if (!title) {
        pushIssue(issues, 'critical', 'TITLE_MISSING', 'Page has no <title>', page.url);
      } else {
        if (title.length < options.minTitleLength || title.length > options.maxTitleLength) {
          pushIssue(
            issues,
            'warning',
            'TITLE_LENGTH',
            `Title length should be between ${options.minTitleLength} and ${options.maxTitleLength}`,
            page.url,
            { length: title.length },
          );
        }
        if (!titleToUrls.has(title)) titleToUrls.set(title, new Set<string>());
        titleToUrls.get(title)?.add(page.url);
      }

      if (!metaDescription) {
        pushIssue(issues, 'critical', 'DESCRIPTION_MISSING', 'Page has no meta description', page.url);
      } else {
        if (metaDescription.length < options.minDescriptionLength || metaDescription.length > options.maxDescriptionLength) {
          pushIssue(
            issues,
            'warning',
            'DESCRIPTION_LENGTH',
            `Meta description length should be between ${options.minDescriptionLength} and ${options.maxDescriptionLength}`,
            page.url,
            { length: metaDescription.length },
          );
        }
        if (!descriptionToUrls.has(metaDescription)) descriptionToUrls.set(metaDescription, new Set<string>());
        descriptionToUrls.get(metaDescription)?.add(page.url);
      }

      if (!canonical) {
        pushIssue(issues, 'warning', 'CANONICAL_MISSING', 'Page has no canonical URL', page.url);
      } else {
        const finalNormalized = normalizeUrl(page.finalUrl);
        const canonicalOrigin = normalizeUrl(canonical) ? new URL(canonical).origin : undefined;
        const finalOrigin = normalizeUrl(page.finalUrl) ? new URL(page.finalUrl).origin : undefined;
        if (canonicalOrigin !== finalOrigin || canonical !== finalNormalized) {
          pushIssue(issues, 'warning', 'CANONICAL_INCORRECT', 'Canonical URL does not match final URL', page.url, {
            canonical,
            finalUrl: page.finalUrl,
          });
        }
      }

      if (page.url.length > options.maxUrlLength) {
        pushIssue(issues, 'warning', 'URL_TOO_LONG', `URL length exceeds ${options.maxUrlLength} characters`, page.url, {
          length: page.url.length,
        });
      }

      if (page.statusCode >= 500) {
        pushIssue(issues, 'critical', 'HTTP_5XX', 'Page returned a server error status', page.url, {
          statusCode: page.statusCode,
        });
      } else if (page.statusCode >= 400) {
        pushIssue(issues, 'critical', 'HTTP_4XX', 'Page returned a client error status', page.url, {
          statusCode: page.statusCode,
        });
      } else if (page.statusCode >= 300 || page.finalUrl !== page.url) {
        pushIssue(issues, 'info', 'REDIRECT', 'Page was redirected', page.url, {
          from: page.url,
          to: page.finalUrl,
          statusCode: page.statusCode,
        });
      }

      if (headings.h1.length === 0) {
        pushIssue(issues, 'warning', 'H1_MISSING', 'Page has no H1 heading', page.url);
      } else if (headings.h1.length > 1) {
        pushIssue(issues, 'warning', 'H1_MULTIPLE', 'Page has multiple H1 headings', page.url, {
          count: headings.h1.length,
        });
      }

      if (!openGraph.title || !openGraph.description || !openGraph.image) {
        pushIssue(issues, 'warning', 'OPEN_GRAPH_INCOMPLETE', 'Open Graph tags are incomplete', page.url);
      }

      if (!twitter.card || !twitter.title || !twitter.description) {
        pushIssue(issues, 'info', 'TWITTER_CARD_INCOMPLETE', 'Twitter Card tags are incomplete', page.url);
      }

      if (imagesWithoutAlt.length > 0) {
        pushIssue(issues, 'warning', 'IMAGES_WITHOUT_ALT', 'Page contains images without alt attribute', page.url, {
          count: imagesWithoutAlt.length,
        });
      }

      if (heavyImages.length > 0) {
        pushIssue(issues, 'warning', 'HEAVY_IMAGES', 'Page contains heavy images', page.url, {
          count: heavyImages.length,
          threshold: options.maxImageBytes,
        });
      }

      if (brokenLinks.length > 0) {
        pushIssue(issues, 'critical', 'BROKEN_LINKS', 'Page links to broken internal URLs', page.url, {
          count: brokenLinks.length,
        });
      }

      if (noindex) {
        pushIssue(issues, 'info', 'NOINDEX', 'Page is marked noindex', page.url);
      }

      if (nofollow) {
        pushIssue(issues, 'info', 'NOFOLLOW', 'Page is marked nofollow', page.url);
      }

      if (thinContent) {
        pushIssue(issues, 'warning', 'THIN_CONTENT', 'Page has thin textual content', page.url, { wordCount });
      }

      if ((page.responseTimeMs ?? 0) > 1200) {
        pushIssue(issues, 'warning', 'SLOW_RESPONSE', 'Page response time is high', page.url, {
          responseTimeMs: page.responseTimeMs ?? 0,
        });
      }

      const htmlSizeBytes = page.htmlSizeBytes ?? byteLength(page.html);
      if (htmlSizeBytes > 800_000) {
        pushIssue(issues, 'warning', 'HTML_TOO_LARGE', 'HTML payload is large', page.url, {
          htmlSizeBytes,
        });
      }

      // Extract visible body content for WordPress post reconstruction
      const bodyEl = document.body;
      const pageContent = bodyEl
        ? normalizeWhitespace(bodyEl.textContent)
        : undefined;

      pageReports.push({
        url: page.url,
        finalUrl: page.finalUrl,
        statusCode: page.statusCode,
        depth: page.depth,
        responseTimeMs: page.responseTimeMs,
        htmlSizeBytes,
        title,
        metaDescription,
        canonical,
        robots,
        headings,
        openGraph,
        twitter,
        jsonLd,
        structuredDataTypes: dataTypes,
        internalLinks: links.internal,
        externalLinks: links.external,
        brokenLinks,
        anchorTexts,
        images,
        redirectsTo: page.finalUrl !== page.url ? page.finalUrl : undefined,
        imagesWithoutAlt,
        heavyImages,
        wordCount,
        thinContent,
        indexability,
        noindex,
        nofollow,
        securityHeaders: page.securityHeaders ?? {},
        products,
        siteModel,
        issues,
        pageContent: pageContent && pageContent.length > 0 ? pageContent : undefined,
        pageHtml: page.html || undefined,
        computedStyles: page.computedStyles,
        screenshot: page.screenshot,
      });
    }

    const duplicateTitles = groupDuplicates(titleToUrls);
    const duplicateDescriptions = groupDuplicates(descriptionToUrls);

    const globalIssues: SeoIssue[] = [];
    for (const duplicate of duplicateTitles) {
      globalIssues.push(createIssue('warning', 'DUPLICATE_TITLE', 'Duplicate title detected across pages', undefined, {
        value: duplicate.value,
        occurrences: duplicate.urls.length,
      }));
    }

    for (const duplicate of duplicateDescriptions) {
      globalIssues.push(createIssue('warning', 'DUPLICATE_DESCRIPTION', 'Duplicate meta description detected across pages', undefined, {
        value: duplicate.value,
        occurrences: duplicate.urls.length,
      }));
    }

    const allIssues = [...pageReports.flatMap((p) => p.issues), ...globalIssues];
    const criticalErrors = allIssues.filter((issue) => issue.severity === 'critical');
    const warnings = allIssues.filter((issue) => issue.severity === 'warning');
    const info = allIssues.filter((issue) => issue.severity === 'info');

    const score = Math.max(0, Math.min(100,
      100 - (criticalErrors.length * 8) - (warnings.length * 3) - info.length,
    ));

    const siteModel = buildSiteModel(pageReports, input.pages);

    return {
      score,
      criticalErrors,
      warnings,
      info,
      summary: {
        totalPages: pageReports.length,
        redirects: pageReports.filter((p) => p.redirectsTo !== undefined).length,
        brokenLinks: pageReports.reduce((acc, p) => acc + p.brokenLinks.length, 0),
        pagesWithoutTitle: pageReports.filter((p) => !p.title).length,
        pagesWithoutDescription: pageReports.filter((p) => !p.metaDescription).length,
        duplicateTitles,
        duplicateDescriptions,
        noindexPages: pageReports.filter((p) => p.noindex).length,
        thinContentPages: pageReports.filter((p) => p.thinContent).length,
        totalProducts: buildProductValidationStats(pageReports.flatMap((page) => page.products), productStats).finalProducts,
        productValidation: buildProductValidationStats(pageReports.flatMap((page) => page.products), productStats),
      },
      pages: pageReports,
      siteModel,
    };
  }
}
