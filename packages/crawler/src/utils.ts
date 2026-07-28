export function normalizeUrl(rawUrl: string, baseUrl: string): string | null {
  try {
    const url = new URL(rawUrl, baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }
    // --- Canonicalisation ---------------------------------------------------
    // 1. Remove hash fragment
    url.hash = '';
    // 2. Strip known tracking parameters (do NOT touch functional ones)
    const trackingParams = [
      /^(utm_.*)$/i,
      'fbclid',
      'gclid',
      'msclkid',
      '_ga',
      '_gl',
      'ref',
      'source',
      'session',
      'tracking',
    ];
    for (const [key] of Array.from(url.searchParams.entries())) {
      const isTracking = trackingParams.some(p => {
        if (p instanceof RegExp) return p.test(key);
        return p.toLowerCase() === key.toLowerCase();
      });
      if (isTracking) {
        url.searchParams.delete(key);
      }
    }
    // 3. Sort remaining parameters for deterministic ordering
    url.searchParams.sort();
    // 4. Normalise trailing slash on pathname
    if (url.pathname !== '/' && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    // 5. Return the canonical string
    let href = url.toString();
    // Ensure no trailing slash on root URL
    if (url.pathname === '/' && href.endsWith('/')) {
      href = href.slice(0, -1);
    }
    return href;
  } catch {
    return null;
  }
}

export function isSameDomain(url: string, allowedOrigins: Set<string>): boolean {
  try {
    const parsed = new URL(url);
    return allowedOrigins.has(parsed.hostname) || allowedOrigins.has(parsed.origin);
  } catch {
    return false;
  }
}

export function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// URL categorization for prioritization and knowledge graph
export enum UrlCategory {
  Product = 'Product',
  Category = 'Category',
  Collection = 'Collection',
  LandingPage = 'LandingPage',
  Blog = 'Blog',
  Legal = 'Legal',
  Secondary = 'Secondary',
  Unknown = 'Unknown',
  Tracking = 'Tracking',
  Functional = 'Functional',
  Static = 'Static',
}

const TRACKING_PARAM_PATTERNS: Array<string | RegExp> = [
  /^(utm_.*)$/i,
  'fbclid',
  'gclid',
  'msclkid',
  '_ga',
  '_gl',
  'ref',
  'source',
  'tracking',
  // Session identifiers: never change the underlying knowledge.
  'session',
  'sid',
  'sessionid',
  'phpsessid',
  'jsessionid',
  'aspsessionid',
];

/**
 * Params that create equivalent pages (filters, sort, search, product
 * variants, recommendation context). They never point to distinct navigable
 * knowledge, so they must collapse to a single canonical entity.
 */
const EQUIVALENCE_PARAMS = new Set([
  'sort', 'order', 'orderby', 'dir', 'direction',
  'filter', 'filters', 'facet', 'facets',
  'q', 'query', 'search', 's',
  'view', 'display', 'layout', 'format',
  'color', 'size', 'brand', 'vendor', 'price', 'tag', 'category', 'collection',
  // Product variants: the same product page rendered with a preselected option.
  'variant', 'variation', 'v',
  // Recommendation / carousel context: same target page, different referrer.
  'recommendation', 'rec', 'recommended', 'recid',
  // Pagination: always equivalent — they slice the same knowledge list.
  'page', 'pages', 'paged', 'page_num', 'pagenum',
  'offset', 'cursor', 'start', 'from', 'skip',
  'limit', 'per_page', 'perpage', 'per-page', 'per-page', 'posts_per_page',
  'items_per_page', 'ipp', 'count', 'take',
]);

/** Params that identify a distinct resource and must be preserved. */
const IDENTITY_PARAMS = new Set([
  'id', 'product_id', 'sku', 'slug', 'handle', 'item',
]);

/** File extensions that identify non-navigable assets (never knowledge). */
const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'tif', 'tiff', 'heic', 'heif',
]);
const FONT_EXTENSIONS = new Set(['woff', 'woff2', 'ttf', 'otf', 'eot']);
const STYLE_EXTENSIONS = new Set(['css']);
const SCRIPT_EXTENSIONS = new Set(['js', 'mjs', 'cjs', 'map']);
const MEDIA_EXTENSIONS = new Set([
  'mp4', 'webm', 'ogg', 'ogv', 'mov', 'avi', 'mkv', 'm4v', 'mp3', 'wav', 'flac', 'aac', 'm4a', 'wmv',
]);
const DOCUMENT_EXTENSIONS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'rtf',
  'zip', 'rar', '7z', 'gz', 'tar', 'tgz', 'dmg', 'exe', 'apk', 'bin', 'iso',
]);

const ASSET_EXTENSIONS = new Set<string>([
  ...IMAGE_EXTENSIONS,
  ...FONT_EXTENSIONS,
  ...STYLE_EXTENSIONS,
  ...SCRIPT_EXTENSIONS,
  ...MEDIA_EXTENSIONS,
  ...DOCUMENT_EXTENSIONS,
]);

export type AssetType = 'image' | 'script' | 'stylesheet' | 'font' | 'media' | 'document' | 'other';

/** Extract the lowercased file extension of a URL path, or null when none. */
function urlExtension(url: string): string | null {
  try {
    const { pathname } = new URL(url);
    const lastSegment = pathname.split('/').filter(Boolean).pop() ?? '';
    const dotIndex = lastSegment.lastIndexOf('.');
    if (dotIndex <= 0) {
      return null;
    }
    return lastSegment.slice(dotIndex + 1).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Detect whether a URL points to a static asset (image, font, css, js, media,
 * document, CDN blob) rather than a navigable knowledge page. Extension-based
 * so it stays fully platform-agnostic (WordPress, Shopify, Magento, …).
 */
export function isAssetUrl(url: string): boolean {
  const ext = urlExtension(url);
  return ext !== null && ASSET_EXTENSIONS.has(ext);
}

/** Classify an asset URL into a coarse resource type for the knowledge graph. */
export function assetTypeFromUrl(url: string): AssetType {
  const ext = urlExtension(url);
  if (ext === null) return 'other';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (FONT_EXTENSIONS.has(ext)) return 'font';
  if (STYLE_EXTENSIONS.has(ext)) return 'stylesheet';
  if (SCRIPT_EXTENSIONS.has(ext)) return 'script';
  if (MEDIA_EXTENSIONS.has(ext)) return 'media';
  if (DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  return 'other';
}

function isTrackingParam(key: string): boolean {
  return TRACKING_PARAM_PATTERNS.some((pattern) => {
    if (pattern instanceof RegExp) return pattern.test(key);
    return pattern.toLowerCase() === key.toLowerCase();
  });
}

function normalizePathname(pathname: string): string {
  if (pathname !== '/' && pathname.endsWith('/')) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function stripParams(
  url: URL,
  shouldRemove: (key: string) => boolean,
): void {
  for (const [key] of Array.from(url.searchParams.entries())) {
    if (shouldRemove(key)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
}

/**
 * Canonical URL for exact duplicate detection (tracking params removed).
 */
export function canonicalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    stripParams(u, (key) => isTrackingParam(key));
    u.pathname = normalizePathname(u.pathname);
    let href = u.toString();
    if (u.pathname === '/' && href.endsWith('/')) {
      href = href.slice(0, -1);
    }
    return href;
  } catch {
    return url;
  }
}

/**
 * Structural equivalence key: same path + identity params, ignoring
 * filters, sort, pagination and search variants.
 */
export function equivalenceKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    stripParams(u, (key) => isTrackingParam(key) || EQUIVALENCE_PARAMS.has(key.toLowerCase()));
    u.pathname = normalizePathname(u.pathname);
    const identityEntries = Array.from(u.searchParams.entries())
      .filter(([key]) => IDENTITY_PARAMS.has(key.toLowerCase()))
      .sort(([a], [b]) => a.localeCompare(b));
    u.search = '';
    for (const [key, value] of identityEntries) {
      u.searchParams.set(key, value);
    }
    let href = u.toString();
    if (u.pathname === '/' && href.endsWith('/')) {
      href = href.slice(0, -1);
    }
    return href;
  } catch {
    return url;
  }
}

/**
 * Pattern key for structural deduplication loops (path + param shape).
 */
export function urlPatternKey(url: string): string {
  try {
    const u = new URL(url);
    const path = normalizePathname(u.pathname.toLowerCase());
    const parts = path.split('/').filter(Boolean);
    let pattern = '/';
    if (parts.length > 0) {
      pattern += parts.map((part) => (/^\d+$/.test(part) ? ':id' : part)).join('/') + '/*';
    }
    const paramKeys = Array.from(u.searchParams.keys())
      .map((key) => key.toLowerCase())
      .filter((key) => !isTrackingParam(key))
      .sort();
    if (paramKeys.length > 0) {
      pattern += '?' + paramKeys.map((key) => `${key}=*`).join('&');
    }
    return pattern;
  } catch {
    return url;
  }
}

/**
 * Lightweight content fingerprint for post-visit duplicate detection.
 */
export function contentFingerprint(title: string | undefined, canonical: string | undefined, linkCount: number): string {
  const normalizedTitle = (title ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const normalizedCanonical = (canonical ?? '').trim().toLowerCase();
  return `${normalizedTitle}|${normalizedCanonical}|${linkCount}`;
}

/**
 * Classify a URL into a high‑level category for prioritization.
 * Heuristics based on path patterns; fallback to generic classifications.
 */
export function classifyUrl(rawUrl: string): UrlCategory {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.toLowerCase();
    if (/(\/product|\/item|\/shop|\/store)\/.*/.test(path)) return UrlCategory.Product;
    if (/(\/category|\/cat)\/.*/.test(path)) return UrlCategory.Category;
    if (/(\/collection|\/coll)\/.*/.test(path)) return UrlCategory.Collection;
    if (/(\/blog|\/news)\/.*/.test(path)) return UrlCategory.Blog;
    if (/(\/legal|\/terms|\/privacy)\/.*/.test(path)) return UrlCategory.Legal;
    if (/(\/landing|\/home)\/.*/.test(path)) return UrlCategory.LandingPage;
    // Generic fallback based on query parameters
    const params = Array.from(url.searchParams.keys()).map(p => p.toLowerCase());
    const trackingParams = [
      /^(utm_.*)$/i,
      'fbclid',
      'gclid',
      'msclkid',
      '_ga',
      '_gl',
      'ref',
      'source',
      'session',
      'tracking',
    ];
    const functionalParams = [
      'page', 'offset', 'cursor', 'collection', 'category', 'tag', 'sort',
      'price', 'color', 'size', 'brand', 'vendor', 'search', 'q',
    ];
    if (params.some(p => trackingParams.some(tp => (tp instanceof RegExp ? tp.test(p) : tp === p))))
      return UrlCategory.Tracking;
    if (params.some(p => functionalParams.includes(p))) return UrlCategory.Functional;
    return UrlCategory.Static;
  } catch {
    return UrlCategory.Unknown;
  }
}
