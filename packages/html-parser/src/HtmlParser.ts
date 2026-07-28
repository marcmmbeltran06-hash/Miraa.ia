import { parseHTML } from 'linkedom';

export type HtmlAssetType = 'image' | 'script' | 'stylesheet';

export interface HtmlAsset {
  type: HtmlAssetType;
  url: string;
}

export interface MicrodataItem {
  itemType?: string;
  properties: Record<string, unknown>;
}

export interface HtmlParseResult {
  url: string;
  html: string;
  title?: string;
  description?: string;
  canonical?: string;
  internalLinks: string[];
  externalLinks: string[];
  images: string[];
  scripts: string[];
  stylesheets: string[];
  jsonLd: unknown[];
  microdata: MicrodataItem[];
}

function normalizeHref(rawHref: string | null, baseUrl: string): string | null {
  if (!rawHref || rawHref.startsWith('javascript:') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) {
    return null;
  }

  try {
    const url = new URL(rawHref, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }

    url.hash = '';
    url.searchParams.sort();
    if (url.pathname.endsWith('/') && url.pathname !== '/') {
      url.pathname = url.pathname.slice(0, -1);
    }

    return url.toString();
  } catch {
    return null;
  }
}

function parseMicrodata(document: Document): MicrodataItem[] {
  const roots = Array.from(document.querySelectorAll('[itemscope]')).filter(
    (node) => !node.parentElement?.closest('[itemscope]')
  );

  return roots.map((root) => ({
    itemType: root.getAttribute('itemtype') ?? undefined,
    properties: extractProperties(root),
  }));
}

function extractProperties(element: Element): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const item of Array.from(element.querySelectorAll('[itemprop]'))) {
    const key = item.getAttribute('itemprop');
    if (!key) {
      continue;
    }

    const value =
      item.getAttribute('content') ??
      item.getAttribute('src') ??
      item.getAttribute('href') ??
      item.textContent?.trim() ??
      '';

    if (properties[key] === undefined) {
      properties[key] = value;
    } else if (Array.isArray(properties[key])) {
      (properties[key] as unknown[]).push(value);
    } else {
      properties[key] = [properties[key], value];
    }
  }

  return properties;
}

function parseJsonLd(document: Document): unknown[] {
  return Array.from(document.querySelectorAll('script[type="application/ld+json"]')).flatMap((node) => {
    const content = node.textContent?.trim();
    if (!content) {
      return [];
    }

    try {
      const parsed = JSON.parse(content);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  });
}

export function parseHtml(html: string, baseUrl: string): HtmlParseResult {
  const { document } = parseHTML(html);
  const pageUrl = baseUrl;
  const base = new URL(baseUrl);

  const title = document.querySelector('head title')?.textContent?.trim() || undefined;
  const description = document.querySelector('meta[name="description"]')?.getAttribute('content') ?? undefined;
  const canonical = normalizeHref(document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null, pageUrl) ?? undefined;

  const anchors = Array.from(document.querySelectorAll('a[href]'))
    .map((anchor) => normalizeHref(anchor.getAttribute('href'), pageUrl))
    .filter((href): href is string => href !== null);

  const internalLinks: string[] = [];
  const externalLinks: string[] = [];
  for (const link of anchors) {
    try {
      const parsed = new URL(link);
      if (parsed.hostname === base.hostname) {
        internalLinks.push(link);
      } else {
        externalLinks.push(link);
      }
    } catch {
      // ignore invalid URLs
    }
  }

  const images = Array.from(document.querySelectorAll('img[src]'))
    .map((img) => normalizeHref(img.getAttribute('src'), pageUrl))
    .filter((src): src is string => src !== null);

  const scripts = Array.from(document.querySelectorAll('script[src]'))
    .map((script) => normalizeHref(script.getAttribute('src'), pageUrl))
    .filter((src): src is string => src !== null);

  const stylesheets = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'))
    .map((link) => normalizeHref(link.getAttribute('href'), pageUrl))
    .filter((href): href is string => href !== null);

  return {
    url: pageUrl,
    html,
    title,
    description,
    canonical,
    internalLinks,
    externalLinks,
    images,
    scripts,
    stylesheets,
    jsonLd: parseJsonLd(document),
    microdata: parseMicrodata(document),
  };
}
