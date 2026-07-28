import { parseHTML } from 'linkedom';
import type {
  OpenGraphData,
  ProductData,
  ProductDiscoveryStats,
  ProductMediaData,
  ProductValidationStats,
  TwitterCardData,
} from './types.js';

type LinkedomDocument = ReturnType<typeof parseHTML>['document'];

export interface ProductPageContext {
  sourceUrl: string;
  canonical?: string;
  title?: string;
  metaDescription?: string;
  robots?: string;
  openGraph: OpenGraphData;
  twitter: TwitterCardData;
  jsonLd: unknown[];
  structuredDataTypes: string[];
}

export interface ProductExtractionResult {
  products: ProductData[];
  stats: ProductDiscoveryStats;
}

const EMPTY_DISCOVERY_STATS: ProductDiscoveryStats = {
  jsonLd: 0,
  microdata: 0,
  openGraph: 0,
  html: 0,
  api: 0,
};

function normalizeWhitespace(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeUrl(input: string | undefined, base?: string): string | undefined {
  if (!input) return undefined;
  try {
    return new URL(input, base).toString();
  } catch {
    return undefined;
  }
}

function slugFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const slug = parsed.pathname.split('/').filter(Boolean).at(-1);
    return slug || undefined;
  } catch {
    return undefined;
  }
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split('/').filter(Boolean).at(-1);
  } catch {
    return undefined;
  }
}

function mimeTypeFromUrl(url: string): string | undefined {
  const filename = filenameFromUrl(url)?.toLowerCase();
  if (!filename) return undefined;
  if (filename.endsWith('.jpg') || filename.endsWith('.jpeg')) return 'image/jpeg';
  if (filename.endsWith('.png')) return 'image/png';
  if (filename.endsWith('.webp')) return 'image/webp';
  if (filename.endsWith('.gif')) return 'image/gif';
  if (filename.endsWith('.svg')) return 'image/svg+xml';
  if (filename.endsWith('.mp4')) return 'video/mp4';
  if (filename.endsWith('.pdf')) return 'application/pdf';
  return undefined;
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return asText(obj.name ?? obj.text ?? obj.value);
  }
  return undefined;
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}

function asStringList(value: unknown): string[] {
  return asList(value).flatMap((item) => {
    const text = asText(item);
    if (text) return [text];
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      return asStringList(obj.url ?? obj.contentUrl ?? obj.image);
    }
    return [];
  });
}

function parseSrcset(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(',').flatMap((candidate) => {
    const url = candidate.trim().split(/\s+/)[0];
    return url ? [url] : [];
  });
}

function dedupeStrings(values: Array<string | undefined>): string[] {
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

function makeMedia(urls: string[], baseUrl: string, existing: ProductMediaData[] = []): ProductMediaData[] {
  const byUrl = new Map(existing.map((item) => [item.url, item]));
  const result = [...existing];
  for (const rawUrl of urls) {
    const url = normalizeUrl(rawUrl, baseUrl);
    if (!url || byUrl.has(url)) continue;
    const media: ProductMediaData = {
      url,
      originalUrl: rawUrl,
      filename: filenameFromUrl(url),
      mimeType: mimeTypeFromUrl(url),
      order: result.length,
      role: result.length === 0 ? 'featured' : 'gallery',
    };
    byUrl.set(url, media);
    result.push(media);
  }
  return result.map((item, index) => ({ ...item, order: index, role: item.role ?? (index === 0 ? 'featured' : 'gallery') }));
}

function mediaUrls(media: ProductMediaData[] | undefined): string[] {
  return (media ?? []).filter((item) => item.role !== 'video' && item.role !== 'download' && item.role !== 'document').map((item) => item.url);
}

function hasVariants(product: ProductData): boolean {
  return product.variants.length > 0;
}

function enrichSimpleProductGallery(product: ProductData, documentMedia: ProductMediaData[]): ProductData {
  if (hasVariants(product) || documentMedia.length === 0) return product;
  const media = makeMedia([
    ...(product.media ?? []).map((item) => item.url),
    ...(product.images ?? []),
    ...documentMedia.map((item) => item.url),
  ], product.sourceUrl);
  return {
    ...product,
    images: mediaUrls(media),
    media,
  };
}

/**
 * Calculate a confidence score (0-100) for a product based on data completeness.
 * Simple heuristic:
 * - Base score 50.
 * - +10 for each required field (name, slug, url, price, images) present.
 * - +5 for optional fields (description, sku, gtin, brand).
 * - +5 per variant up to a maximum of 20.
 * - Clamp result between 0 and 100.
 */
export function calculateConfidence(product: ProductData): number {
  let score = 50;
  const required: (keyof ProductData)[] = ['name', 'slug', 'url', 'price', 'images'];
  required.forEach((field) => {
    const value = product[field];
    if (value !== undefined && value !== null) {
      if (Array.isArray(value)) {
        // Count array presence even if empty
        score += 10;
      } else if (typeof value === 'string' && value !== '') {
        score += 10;
      } else if (typeof value !== 'string') {
        // Numbers, booleans count as present
        score += 10;
      }
    }
  });
  const optional: (keyof ProductData)[] = ['description', 'sku', 'gtin', 'brand'];
  optional.forEach((field) => {
    const value = product[field];
    if (Array.isArray(value)) {
      if (value.length > 0) score += 5;
    } else if (value !== undefined && value !== '') {
      score += 5;
    }
  });
  const variantScore = Math.min((product.variants?.length ?? 0) * 5, 20);
  score += variantScore;
  if (score > 100) score = 100;
  if (score < 0) score = 0;
  return score;
}

function mediaFromNode(node: Element, baseUrl: string): string[] {
  // Collect common image attributes, srcset, and also video source attributes
  const attrs = [
    node.getAttribute('data-full'),
    node.getAttribute('data-zoom-image'),
    node.getAttribute('data-large_image'),
    node.getAttribute('data-src'),
    node.getAttribute('data-lazy-src'),
    node.getAttribute('data-original'),
    node.getAttribute('src'),
    node.getAttribute('href'),
    node.getAttribute('content'),
    // Video specific attributes
    node.tagName.toLowerCase() === 'video' ? node.getAttribute('src') : undefined,
    node.tagName.toLowerCase() === 'source' ? node.getAttribute('src') : undefined,
    ...parseSrcset(node.getAttribute('srcset')),
    ...parseSrcset(node.getAttribute('data-srcset')),
  ];
  return attrs.flatMap((item) => {
    const url = normalizeUrl(item ?? undefined, baseUrl);
    return url ? [url] : [];
  });
}

function collectDocumentMedia(document: LinkedomDocument, baseUrl: string, scope?: Element | null): ProductMediaData[] {
  const root = scope ?? document.body;
  // An ordinary anchor is navigation, not product media.  The former broad
  // `a[href]` selector filled galleries with menu, legal and hash URLs.
  const imageNodes = Array.from(root?.querySelectorAll('picture source, img, meta[property="og:image"], meta[name="twitter:image"], link[rel="preload"][as="image"], link[rel="image_src"]') ?? []);
  const linkedMedia = Array.from(root?.querySelectorAll('a[href]') ?? [])
    .filter((node) => /(?:^data:image\/|\.(?:avif|jpe?g|png|webp|gif|svg|mp4|webm)(?:$|[?#]))/i.test(node.getAttribute('href') ?? ''));
  const urls = [...imageNodes, ...linkedMedia].flatMap((node) => mediaFromNode(node, baseUrl));
  const scriptUrls = Array.from(document.querySelectorAll('script')).flatMap((script) => (
    [...(script.textContent ?? '').matchAll(/https?:\\?\/\\?\/[^"'\\\s]+\.(?:jpe?g|png|webp|gif|svg|mp4|pdf)(?:\?[^"'\\\s]*)?/gi)]
      .map((match) => match[0].replace(/\\\//g, '/'))
  ));
  return makeMedia([...urls, ...scriptUrls], baseUrl);
}

function collectProductGalleryMedia(document: LinkedomDocument, baseUrl: string): ProductMediaData[] {
  const scopes = Array.from(document.querySelectorAll([
    '[data-product-gallery]',
    '.product-gallery',
    '.woocommerce-product-gallery',
    '.product__media-list',
    '.gallery',
    '.carousel',
    '[class*="carousel"]',
    '[class*="slider"]',
    '[class*="swiper"]',
    '[class*="product__media"]',
    '[class*="product-media"]',
  ].join(', ')));
  if (scopes.length === 0) return collectDocumentMedia(document, baseUrl);
  return makeMedia(scopes.flatMap((scope) => collectDocumentMedia(document, baseUrl, scope).map((item) => item.url)), baseUrl);
}

function collectDownloads(document: LinkedomDocument, baseUrl: string): ProductMediaData[] {
  const downloadable = Array.from(document.querySelectorAll('a[href]')).flatMap((node) => {
    const href = node.getAttribute('href') ?? '';
    if (!/\.(pdf|docx?|xlsx?|zip|mp4|mov)(?:$|\?)/i.test(href)) return [];
    return [href];
  });
  return makeMedia(downloadable, baseUrl).map((item) => ({
    ...item,
    role: item.mimeType?.startsWith('video/') ? 'video' : item.mimeType === 'application/pdf' ? 'document' : 'download',
  }));
}

function firstOffer(value: Record<string, unknown>): Record<string, unknown> {
  const offer = asList(value.offers).find((item) => item && typeof item === 'object');
  return offer && typeof offer === 'object' ? offer as Record<string, unknown> : {};
}

function brandName(value: unknown): string | undefined {
  if (typeof value === 'string') return normalizeWhitespace(value);
  if (value && typeof value === 'object') return asText((value as Record<string, unknown>).name);
  return undefined;
}

function extractJsonLdProducts(jsonLd: unknown[], context: ProductPageContext): ProductData[] {
  const products: ProductData[] = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;

    const obj = value as Record<string, unknown>;
    const type = obj['@type'];
    const types = Array.isArray(type) ? type : [type];
    const isProduct = types.some((item) => typeof item === 'string' && item.toLowerCase() === 'product');

    if (isProduct) {
      const offer = firstOffer(obj);
      const url = normalizeUrl(asText(obj.url) ?? context.canonical ?? context.sourceUrl, context.sourceUrl);
      const variants = asList(obj.hasVariant ?? obj.model).flatMap((variant): ProductData['variants'] => {
        if (!variant || typeof variant !== 'object') return [];
        const variantObj = variant as Record<string, unknown>;
        const variantOffer = firstOffer(variantObj);
        return [{
          id: asText(variantObj['@id']),
          sku: asText(variantObj.sku),
          price: asText(variantOffer.price ?? variantObj.price),
          salePrice: asText(variantOffer.salePrice ?? variantObj.salePrice),
          compareAtPrice: asText(variantOffer.highPrice ?? variantObj.compareAtPrice),
          stock: asText(variantOffer.inventoryLevel ?? variantObj.inventoryLevel),
          stockStatus: asText(variantOffer.availability ?? variantObj.availability)?.toLowerCase().includes('instock') ? 'instock' : undefined,
          manageStock: variantOffer.inventoryLevel !== undefined || variantObj.inventoryLevel !== undefined,
          backorders: asText(variantOffer.availability ?? variantObj.availability)?.toLowerCase().includes('backorder') ? 'notify' : undefined,
          availability: asText(variantOffer.availability ?? variantObj.availability),
          barcode: asText(variantObj.gtin ?? variantObj.gtin13 ?? variantObj.gtin14),
          attributes: Object.fromEntries(
            ['color', 'size', 'material', 'pattern'].flatMap((key) => {
              const text = asText(variantObj[key]);
              return text ? [[key, text]] : [];
            }),
          ),
          image: normalizeUrl(asStringList(variantObj.image)[0], context.sourceUrl),
          url: normalizeUrl(asText(variantObj.url), context.sourceUrl),
        }];
      });

      const media = makeMedia(asStringList(obj.image), context.sourceUrl);
      const name = asText(obj.name);
      products.push({
        id: asText(obj['@id']) ?? asText(obj.productID) ?? asText(obj.sku) ?? url,
        url,
        canonical: context.canonical ?? url,
        slug: slugFromUrl(url),
        handle: slugFromUrl(url),
        title: name,
        name,
        price: asText(offer.price ?? obj.price),
        salePrice: asText(offer.salePrice ?? obj.salePrice),
        regularPrice: asText(offer.priceSpecification && typeof offer.priceSpecification === 'object' ? (offer.priceSpecification as Record<string, unknown>).price : undefined),
        compareAtPrice: asText(offer.highPrice ?? obj.compareAtPrice),
        currency: asText(offer.priceCurrency ?? obj.priceCurrency),
        description: asText(obj.description),
        renderedText: asText(obj.description),
        sku: asText(obj.sku),
        gtin: asText(obj.gtin ?? obj.gtin13 ?? obj.gtin14 ?? obj.gtin12 ?? obj.gtin8),
        mpn: asText(obj.mpn),
        brand: brandName(obj.brand),
        manufacturer: brandName(obj.manufacturer),
        vendor: brandName(obj.seller),
        stock: asText(offer.inventoryLevel),
        stockStatus: asText(offer.availability)?.toLowerCase().includes('instock') ? 'instock' : undefined,
        manageStock: offer.inventoryLevel !== undefined,
        backorders: asText(offer.availability)?.toLowerCase().includes('backorder') ? 'notify' : undefined,
        availability: asText(offer.availability),
        categories: asStringList(obj.category),
        tags: asStringList(obj.keywords),
        breadcrumbs: [],
        seo: {
          title: context.title,
          description: context.metaDescription,
          canonical: context.canonical,
          robots: context.robots,
          openGraph: context.openGraph,
          twitter: context.twitter,
          jsonLd: context.jsonLd,
          schemaTypes: context.structuredDataTypes,
        },
        images: mediaUrls(media),
        media,
        attributes: Object.fromEntries(
          ['color', 'size', 'material', 'pattern'].flatMap((key) => {
            const text = asText(obj[key]);
            return text ? [[key, text]] : [];
          }),
        ),
        variants,
        discoverySources: ['jsonLd'],
        sourceUrl: context.sourceUrl,
      });
      return;
    }

    Object.values(obj).forEach(visit);
  };

  jsonLd.forEach(visit);
  return products;
}

function extractMicrodataProducts(document: LinkedomDocument, context: ProductPageContext): ProductData[] {
  return Array.from(document.querySelectorAll('[itemscope]')).flatMap((scope) => {
    const itemType = scope.getAttribute('itemtype') ?? '';
    if (!itemType.toLowerCase().includes('product')) return [];
    const readProp = (name: string): string | undefined => {
      const node = scope.querySelector(`[itemprop="${name}"]`);
      return normalizeWhitespace(
        node?.getAttribute('content') ??
        node?.getAttribute('src') ??
        node?.getAttribute('href') ??
        node?.textContent,
      );
    };

    const media = collectDocumentMedia(document, context.sourceUrl, scope);
    const name = readProp('name');
    const url = context.canonical ?? context.sourceUrl;

    return [{
      id: readProp('sku') ?? url,
      url,
      canonical: context.canonical ?? url,
      slug: slugFromUrl(url),
      handle: slugFromUrl(url),
      title: name,
      name,
      price: readProp('price'),
      salePrice: readProp('sale_price'),
      currency: readProp('priceCurrency'),
      description: readProp('description'),
      renderedText: readProp('description'),
      sku: readProp('sku'),
      gtin: readProp('gtin13') ?? readProp('gtin') ?? readProp('gtin14'),
      brand: readProp('brand'),
      availability: readProp('availability'),
      stockStatus: readProp('availability')?.toLowerCase().includes('instock') ? 'instock' : undefined,
      categories: [readProp('category')].filter((item): item is string => item !== undefined),
      seo: {
        title: context.title,
        description: context.metaDescription,
        canonical: context.canonical,
        robots: context.robots,
        openGraph: context.openGraph,
        twitter: context.twitter,
        jsonLd: context.jsonLd,
        schemaTypes: context.structuredDataTypes,
      },
      images: mediaUrls(media),
      media,
      attributes: {},
      variants: [],
      discoverySources: ['microdata'],
      sourceUrl: context.sourceUrl,
    }];
  });
}

function extractHtmlProduct(document: LinkedomDocument, context: ProductPageContext): ProductData[] {
  // A heading alone does not identify a product page.  Requiring a genuine
  // product root or the combination of price and purchase control prevents all
  // ordinary pages from becoming bogus WooCommerce products.
  const productLike = document.querySelector('[data-product], [data-product-id], article.product, main.product, .single-product, .type-product, .woocommerce div.product, [itemtype*="Product"], [itemprop="productID"]');
  const priceEvidence = document.querySelector('[itemprop="price"], [data-price], .woocommerce-Price-amount, .price');
  const purchaseEvidence = document.querySelector('form.cart, .single_add_to_cart_button, .add_to_cart_button, [data-add-to-cart], [name="add-to-cart"]');
  const title = normalizeWhitespace(
    document.querySelector('[data-product-title], .product-title, h1')?.textContent,
  );
  if (!productLike && !(priceEvidence && purchaseEvidence)) return [];

  const galleryScope = document.querySelector('[data-product-gallery], .product-gallery, .woocommerce-product-gallery, .product__media-list, .gallery') ?? productLike;
  const media = collectDocumentMedia(document, context.sourceUrl, galleryScope);

  const variants = Array.from(document.querySelectorAll('[data-variant-id], [data-sku]')).flatMap((node): ProductData['variants'] => {
    const sku = node.getAttribute('data-sku') ?? undefined;
    const id = node.getAttribute('data-variant-id') ?? sku;
    if (!id && !sku) return [];
    const attributes: Record<string, string> = {};
    for (const key of ['color', 'size', 'material', 'pattern']) {
      const value = node.getAttribute(`data-${key}`);
      if (value) attributes[key] = value;
    }
    return [{
      id,
      sku,
      price: node.getAttribute('data-price') ?? undefined,
      salePrice: node.getAttribute('data-sale-price') ?? undefined,
      compareAtPrice: node.getAttribute('data-compare-at-price') ?? undefined,
      stock: node.getAttribute('data-stock') ?? undefined,
      stockStatus: node.getAttribute('data-stock-status') ?? undefined,
      manageStock: node.hasAttribute('data-stock'),
      backorders: node.getAttribute('data-backorders') ?? undefined,
      availability: node.getAttribute('data-availability') ?? undefined,
      barcode: node.getAttribute('data-barcode') ?? undefined,
      attributes,
      image: normalizeUrl(node.getAttribute('data-image') ?? undefined, context.sourceUrl),
      url: normalizeUrl(node.getAttribute('data-url') ?? undefined, context.sourceUrl),
    }];
  });

  // Extract SKU from common Shopify/WooCommerce locations
  const skuEl = document.querySelector('[data-sku], .sku, .product-sku, [itemprop="sku"]');
  const sku = normalizeWhitespace(
    skuEl?.getAttribute('content') ??
    skuEl?.getAttribute('data-sku') ??
    skuEl?.textContent
  );
  // Extract categories from breadcrumbs, nav, and product type meta
  const categories = dedupeStrings([
    ...Array.from(document.querySelectorAll('[rel="tag"], .breadcrumb a, nav[aria-label*="breadcrumb" i] a, [itemprop="category"], .product-category')).map((node) => node.textContent ?? undefined),
    ...Array.from(document.querySelectorAll('meta[property="product:category"], meta[property="product:retailer_item_id"]')).map((node) => node.getAttribute('content') ?? undefined),
  ]);

  return [{
    id: sku ?? context.canonical ?? context.sourceUrl,
    url: context.canonical ?? context.sourceUrl,
    canonical: context.canonical ?? context.sourceUrl,
    slug: slugFromUrl(context.canonical ?? context.sourceUrl),
    handle: slugFromUrl(context.canonical ?? context.sourceUrl),
    title,
    name: title,
    sku,
    description: context.metaDescription,
    descriptionHtml: document.querySelector('.product-description, .woocommerce-product-details__short-description, [data-product-description], .product__description')?.innerHTML,
    renderedText: normalizeWhitespace(document.body?.textContent),
    shortDescription: context.metaDescription,
    categories,
    breadcrumbs: dedupeStrings(Array.from(document.querySelectorAll('.breadcrumb a, nav[aria-label*="breadcrumb" i] a')).map((node) => node.textContent ?? undefined)),
    seo: {
      title: context.title,
      description: context.metaDescription,
      canonical: context.canonical,
      robots: context.robots,
      openGraph: context.openGraph,
      twitter: context.twitter,
      jsonLd: context.jsonLd,
      schemaTypes: context.structuredDataTypes,
    },
    images: mediaUrls(media),
    media,
    downloads: collectDownloads(document, context.sourceUrl),
    attributes: {},
    variants,
    discoverySources: ['html'],
    sourceUrl: context.sourceUrl,
  }];
}

function normalizeInlineJson(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return [parsed];
  } catch {
    return [...text.matchAll(/({[^<]*"variants"[^<]*})/g)].flatMap((match) => {
      try {
        return [JSON.parse(match[1]) as unknown];
      } catch {
        return [];
      }
    });
  }
}

function extractInlineJsonProducts(document: LinkedomDocument, context: ProductPageContext): ProductData[] {
  const jsonValues = Array.from(document.querySelectorAll('script[type="application/json"], script:not([src])'))
    .flatMap((script) => normalizeInlineJson(script.textContent ?? ''));

  return jsonValues.flatMap((value): ProductData[] => {
    if (!value || typeof value !== 'object') return [];
    const obj = value as Record<string, unknown>;
    const title = asText(obj.title ?? obj.name);
    const rawVariants = asList(obj.variants);
    const rawImages = [
      ...asStringList(obj.images),
      ...asStringList(obj.media),
      ...rawVariants.flatMap((variant) => (variant && typeof variant === 'object' ? asStringList((variant as Record<string, unknown>).image) : [])),
    ];
    if (!title && rawVariants.length === 0 && rawImages.length === 0) return [];

    const url = normalizeUrl(asText(obj.url), context.sourceUrl) ?? context.canonical ?? context.sourceUrl;
    const media = makeMedia(rawImages, context.sourceUrl);

    return [{
      id: asText(obj.id),
      url,
      canonical: context.canonical ?? url,
      slug: slugFromUrl(url),
      handle: asText(obj.handle) ?? slugFromUrl(url),
      title,
      name: title,
      price: asText(obj.price),
      regularPrice: asText(obj.regular_price ?? obj.regularPrice),
      salePrice: asText(obj.sale_price ?? obj.salePrice),
      currency: asText(obj.currency),
      description: asText(obj.description),
      descriptionHtml: asText(obj.descriptionHtml ?? obj.body_html),
      renderedText: asText(obj.description),
      sku: asText(obj.sku),
      brand: brandName(obj.vendor ?? obj.brand),
      vendor: brandName(obj.vendor),
      categories: asStringList(obj.product_type ?? obj.category),
      collections: asStringList(obj.collections),
      tags: asStringList(obj.tags),
      seo: {
        title: context.title,
        description: context.metaDescription,
        canonical: context.canonical,
        robots: context.robots,
        openGraph: context.openGraph,
        twitter: context.twitter,
        jsonLd: context.jsonLd,
        schemaTypes: context.structuredDataTypes,
      },
      images: mediaUrls(media),
      media,
      attributes: {},
      variants: rawVariants.flatMap((variant): ProductData['variants'] => {
        if (!variant || typeof variant !== 'object') return [];
        const variantObj = variant as Record<string, unknown>;
        return [{
          id: asText(variantObj.id),
          sku: asText(variantObj.sku),
          price: asText(variantObj.price),
          regularPrice: asText(variantObj.regular_price ?? variantObj.regularPrice),
          salePrice: asText(variantObj.sale_price ?? variantObj.salePrice),
          stock: asText(variantObj.inventory_quantity ?? variantObj.stock),
          stockStatus: asText(variantObj.available) === 'false' ? 'outofstock' : undefined,
          manageStock: variantObj.inventory_quantity !== undefined || variantObj.stock !== undefined,
          attributes: Object.fromEntries(
            ['option1', 'option2', 'option3', 'color', 'colour', 'size', 'material', 'pattern'].flatMap((key) => {
              const text = asText(variantObj[key]);
              return text ? [[key.replace('colour', 'color'), text]] : [];
            }),
          ),
          image: normalizeUrl(asStringList(variantObj.image)[0] ?? asText(variantObj.featured_image), context.sourceUrl),
          url,
        }];
      }),
      downloads: collectDownloads(document, context.sourceUrl),
      discoverySources: ['api'],
      sourceUrl: context.sourceUrl,
    }];
  });
}

function extractOpenGraphProduct(context: ProductPageContext): ProductData[] {
  if (context.openGraph.type !== 'product' && !context.openGraph.type?.includes('product')) return [];
  const media = makeMedia([context.openGraph.image].filter((item): item is string => item !== undefined), context.sourceUrl);
  return [{
    id: context.openGraph.url ?? context.canonical ?? context.sourceUrl,
    url: normalizeUrl(context.openGraph.url, context.sourceUrl) ?? context.canonical ?? context.sourceUrl,
    canonical: context.canonical ?? normalizeUrl(context.openGraph.url, context.sourceUrl) ?? context.sourceUrl,
    slug: slugFromUrl(context.openGraph.url ?? context.canonical ?? context.sourceUrl),
    handle: slugFromUrl(context.openGraph.url ?? context.canonical ?? context.sourceUrl),
    title: context.openGraph.title,
    name: context.openGraph.title,
    description: context.openGraph.description,
    renderedText: context.openGraph.description,
    categories: [],
    seo: {
      title: context.title,
      description: context.metaDescription,
      canonical: context.canonical,
      robots: context.robots,
      openGraph: context.openGraph,
      twitter: context.twitter,
      jsonLd: context.jsonLd,
      schemaTypes: context.structuredDataTypes,
    },
    images: mediaUrls(media),
    media,
    attributes: {},
    variants: [],
    discoverySources: ['openGraph'],
    sourceUrl: context.sourceUrl,
  }];
}

// Additional extraction helpers for comprehensive product data
function extractRdfaProducts(document: LinkedomDocument, context: ProductPageContext): ProductData[] {
  const productElements = Array.from(document.querySelectorAll('[typeof*="Product"], [typeof*="schema:Product"]'));
  return productElements.flatMap((el) => {
    const readProp = (name: string): string | undefined => {
      const node = el.querySelector(`[property="${name}"]`);
      return normalizeWhitespace(
        node?.getAttribute('content') ??
        node?.getAttribute('src') ??
        node?.getAttribute('href') ??
        node?.textContent,
      );
    };
    const media = collectDocumentMedia(document, context.sourceUrl, el);
    const name = readProp('name') || readProp('title');
    const url = normalizeUrl(readProp('url') ?? context.canonical ?? context.sourceUrl, context.sourceUrl);
    return [{
      id: readProp('sku') ?? url,
      url,
      canonical: context.canonical ?? url,
      slug: slugFromUrl(url),
      handle: slugFromUrl(url),
      title: name,
      name,
      price: readProp('price'),
      salePrice: readProp('salePrice'),
      currency: readProp('priceCurrency'),
      description: readProp('description'),
      renderedText: readProp('description'),
      sku: readProp('sku'),
      gtin: readProp('gtin') ?? readProp('gtin13') ?? readProp('gtin14'),
      brand: readProp('brand'),
      vendor: readProp('brand'),
      availability: readProp('availability'),
      stockStatus: readProp('availability')?.toLowerCase().includes('instock') ? 'instock' : undefined,
      images: mediaUrls(media),
      media,
      attributes: {},
      variants: [],
      discoverySources: ['rdfa'],
      sourceUrl: context.sourceUrl,
    }];
  });
}

function extractNextDataProducts(document: LinkedomDocument, context: ProductPageContext): ProductData[] {
  const script = document.querySelector('script#__NEXT_DATA__');
  if (!script) return [];
  try {
    const data = JSON.parse(script.textContent ?? '{}');
    const found: unknown[] = [];
    const walk = (obj: unknown) => {
      if (!obj || typeof obj !== 'object') return;
      const o = obj as Record<string, unknown>;
      if (o['__typename']?.toString().toLowerCase().includes('product')) found.push(o);
      Object.values(o).forEach(walk);
    };
    walk(data);
    return extractJsonLdProducts(found, context);
  } catch {
    return [];
  }
}

function extractNuxtDataProducts(document: LinkedomDocument, context: ProductPageContext): ProductData[] {
  const script = document.querySelector('script#__NUXT__');
  if (!script) return [];
  try {
    const data = JSON.parse(script.textContent ?? '{}');
    const found: unknown[] = [];
    const walk = (obj: unknown) => {
      if (!obj || typeof obj !== 'object') return;
      const o = obj as Record<string, unknown>;
      if (o['type']?.toString().toLowerCase().includes('product')) found.push(o);
      Object.values(o).forEach(walk);
    };
    walk(data);
    return extractJsonLdProducts(found, context);
  } catch {
    return [];
  }
}

function extractShopifyProducts(document: LinkedomDocument, context: ProductPageContext): ProductData[] {
  const scripts = Array.from(document.querySelectorAll('script')).filter((s) => /ShopifyAnalytics|Shopify/.test(s.textContent ?? ''));
  const jsonObjects: unknown[] = [];
  // Match ShopifyAnalytics meta product (legacy)
  const analyticsRegex = /ShopifyAnalytics\.meta\.product\s*=\s*(\{[^;]*\})/;
  // Match window.Shopify product data (common in modern themes)
  const shopifyRegex = /(?:window\.)?Shopify\s*=\s*(?:window\.)?Shopify\s*\|\|\s*\{\};\s*Shopify\.(?:product|selectedVariant|featuredImage)\s*=\s*(\{[^;]*\})/g;
  // Match inline window.__INITIAL_STATE__ (Shopify hydrogen/next)
  const initialStateRegex = /window\.__INITIAL_STATE__\s*=\s*(\{[^;]*\});/;

  scripts.forEach((s) => {
    const text = s.textContent ?? '';
    // Analytics product
    const analyticsMatch = text.match(analyticsRegex);
    if (analyticsMatch) {
      try { jsonObjects.push(JSON.parse(analyticsMatch[1])); } catch {
        // Ignore malformed platform payloads and keep other extractors running.
      }
    }
    // Shopify global product data
    let shopifyMatch: RegExpExecArray | null;
    shopifyRegex.lastIndex = 0;
    while ((shopifyMatch = shopifyRegex.exec(text)) !== null) {
      try { jsonObjects.push(JSON.parse(shopifyMatch[1])); } catch {
        // Ignore malformed platform payloads and keep other extractors running.
      }
    }
    // Initial state
    const initialStateMatch = text.match(initialStateRegex);
    if (initialStateMatch) {
      try {
        const initialState = JSON.parse(initialStateMatch[1]) as Record<string, unknown>;
        // Walk for product data
        const walk = (obj: unknown): void => {
          if (!obj || typeof obj !== 'object') return;
          const o = obj as Record<string, unknown>;
          if (o.variants && o.title && o.images) jsonObjects.push(o);
          Object.values(o).forEach(walk);
        };
        walk(initialState);
      } catch {
        // Ignore
      }
    }
  });
  return extractJsonLdProducts(jsonObjects, context);
}

function extractPrestashopProducts(document: LinkedomDocument, context: ProductPageContext): ProductData[] {
  const scripts = Array.from(document.querySelectorAll('script')).filter((s) => /prestashop/.test(s.textContent ?? ''));
  const jsonObjects: unknown[] = [];
  const regex = /window\.prestashop\s*=\s*(\{[^;]*\});/;
  scripts.forEach((s) => {
    const match = (s.textContent ?? '').match(regex);
    if (match) {
      try { jsonObjects.push(JSON.parse(match[1])); } catch {
        // Ignore malformed platform payloads and keep other extractors running.
      }
    }
  });
  return extractJsonLdProducts(jsonObjects, context);
}

function extractMagentoProducts(document: LinkedomDocument, context: ProductPageContext): ProductData[] {
  const nodes = Array.from(document.querySelectorAll('[data-mage-init]'));
  const jsonObjects: unknown[] = [];
  nodes.forEach((node) => {
    const attr = node.getAttribute('data-mage-init');
    if (!attr) return;
    try { jsonObjects.push(JSON.parse(attr)); } catch {
      // Ignore malformed platform payloads and keep other extractors running.
    }
  });
  return extractJsonLdProducts(jsonObjects, context);
}

function extractEmbeddedJsonProducts(document: LinkedomDocument, context: ProductPageContext): ProductData[] {
  const scripts = Array.from(document.querySelectorAll('script:not([src])'));
  const jsonObjects: unknown[] = [];
  scripts.forEach((s) => {
    const text = s.textContent ?? '';
    const matches = [...text.matchAll(/\{[^}]*"product"[^}]*\}/g)];
    matches.forEach((m) => {
      try { jsonObjects.push(JSON.parse(m[0])); } catch {
        // Ignore malformed embedded payloads and keep other extractors running.
      }
    });
  });
  return extractJsonLdProducts(jsonObjects, context);
}

export function extractProductsFromDocument(document: LinkedomDocument, context: ProductPageContext): ProductExtractionResult {
  const documentMedia = collectProductGalleryMedia(document, context.sourceUrl);
  const products = [
    ...extractJsonLdProducts(context.jsonLd, context),
    ...extractRdfaProducts(document, context),
    ...extractNextDataProducts(document, context),
    ...extractNuxtDataProducts(document, context),
    ...extractShopifyProducts(document, context),
    ...extractPrestashopProducts(document, context),
    ...extractMagentoProducts(document, context),
    ...extractEmbeddedJsonProducts(document, context),
    ...extractMicrodataProducts(document, context),
    ...extractOpenGraphProduct(context),
    ...extractInlineJsonProducts(document, context),
    ...extractHtmlProduct(document, context),
  ].map((product) => enrichSimpleProductGallery(product, documentMedia));

  const stats = { ...EMPTY_DISCOVERY_STATS };
  for (const product of products) {
    for (const source of product.discoverySources ?? []) {
      if (source in stats) stats[source as keyof ProductDiscoveryStats] += 1;
    }
  }

  return {
    products: mergeProducts(products).products,
    stats,
  };
}

function productKeys(product: ProductData): string[] {
  const keys: string[] = [];
  const identity = product.sku ?? product.gtin ?? product.ean ?? product.upc ?? product.isbn ?? product.mpn;
  if (identity) keys.push(`id:${identity.toLowerCase()}`);
  const canonical = product.canonical ?? product.url;
  const normalizedUrl = canonical?.replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
  const name = (product.name ?? product.title ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  // A collection/feed can expose several distinct products with the same page
  // URL.  Only use a bare URL when there is no product name to disambiguate it.
  // Variants are already grouped inside ProductData.variants, so merging named
  // products solely by route would silently discard catalogue entries.
  if (normalizedUrl && name) keys.push(`url-name:${normalizedUrl}:${name}`);
  else if (normalizedUrl) keys.push(`url:${normalizedUrl}`);
  return keys.length > 0 ? keys : [`unknown:${product.sourceUrl}`];
}

function productKey(product: ProductData): string {
  return productKeys(product)[0];
}

function mergeOptions(variants: ProductData['variants']): Record<string, string[]> {
  const options: Record<string, Set<string>> = {};
  for (const variant of variants) {
    for (const [name, value] of Object.entries(variant.attributes)) {
      if (!options[name]) options[name] = new Set<string>();
      options[name].add(value);
    }
  }
  return Object.fromEntries(Object.entries(options).map(([name, values]) => [name, [...values]]));
}

function variantKey(variant: ProductData['variants'][number]): string {
  if (variant.sku) return `sku:${variant.sku.toLowerCase()}`;
  const attrs = Object.entries(variant.attributes).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${v}`).join('|');
  return attrs || JSON.stringify(variant);
}

function mergeTwoProducts(a: ProductData, b: ProductData): ProductData {
  const media = makeMedia([...(a.media ?? []).map((item) => item.url), ...(b.media ?? []).map((item) => item.url), ...(a.images ?? []), ...(b.images ?? [])], a.sourceUrl);
  const variants = [...a.variants];
  const existingVariants = new Set(variants.map(variantKey));
  for (const variant of b.variants) {
    const key = variantKey(variant);
    if (existingVariants.has(key)) continue;
    existingVariants.add(key);
    variants.push(variant);
  }

  const merged: ProductData = {
    ...a,
    ...Object.fromEntries(Object.entries(b).filter(([, value]) => value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0))),
    id: a.id ?? b.id,
    url: a.url ?? b.url,
    canonical: a.canonical ?? b.canonical,
    slug: a.slug ?? b.slug,
    handle: a.handle ?? b.handle,
    title: a.title ?? b.title,
    name: a.name ?? b.name,
    price: a.price ?? b.price,
    regularPrice: a.regularPrice ?? b.regularPrice,
    salePrice: a.salePrice ?? b.salePrice,
    compareAtPrice: a.compareAtPrice ?? b.compareAtPrice,
    currency: a.currency ?? b.currency,
    taxStatus: a.taxStatus ?? b.taxStatus,
    taxClass: a.taxClass ?? b.taxClass,
    description: a.description ?? b.description,
    descriptionHtml: a.descriptionHtml ?? b.descriptionHtml,
    renderedText: a.renderedText ?? b.renderedText,
    shortDescription: a.shortDescription ?? b.shortDescription,
    excerpt: a.excerpt ?? b.excerpt,
    sku: a.sku ?? b.sku,
    gtin: a.gtin ?? b.gtin,
    ean: a.ean ?? b.ean,
    upc: a.upc ?? b.upc,
    isbn: a.isbn ?? b.isbn,
    mpn: a.mpn ?? b.mpn,
    brand: a.brand ?? b.brand,
    manufacturer: a.manufacturer ?? b.manufacturer,
    vendor: a.vendor ?? b.vendor,
    stock: a.stock ?? b.stock,
    stockStatus: a.stockStatus ?? b.stockStatus,
    manageStock: a.manageStock ?? b.manageStock,
    availability: a.availability ?? b.availability,
    backorder: a.backorder ?? b.backorder,
    backorders: a.backorders ?? b.backorders,
    categories: dedupeStrings([...(a.categories ?? []), ...(b.categories ?? [])]),
    parentCategories: dedupeStrings([...(a.parentCategories ?? []), ...(b.parentCategories ?? [])]),
    collections: dedupeStrings([...(a.collections ?? []), ...(b.collections ?? [])]),
    tags: dedupeStrings([...(a.tags ?? []), ...(b.tags ?? [])]),
    breadcrumbs: dedupeStrings([...(a.breadcrumbs ?? []), ...(b.breadcrumbs ?? [])]),
    images: mediaUrls(media),
    media,
    downloads: [...(a.downloads ?? []), ...(b.downloads ?? [])],
    attributes: { ...b.attributes, ...a.attributes },
    variants,
    discoverySources: dedupeStrings([...(a.discoverySources ?? []), ...(b.discoverySources ?? [])]),
    sourceUrl: a.sourceUrl,
  };

  merged.options = { ...(a.options ?? {}), ...(b.options ?? {}), ...mergeOptions(variants) };
  return merged;
}

export function mergeProducts(products: ProductData[]): { products: ProductData[]; mergedDuplicates: number } {
  const keyToIndex = new Map<string, number>();
  const canonicalProducts: ProductData[] = [];
  let mergedDuplicates = 0;

  for (const product of products) {
    const keys = productKeys(product);
    const existingIndex = keys.map((key) => keyToIndex.get(key)).find((index): index is number => index !== undefined);
    if (existingIndex === undefined) {
      const nextIndex = canonicalProducts.length;
      canonicalProducts.push({ ...product, options: product.options ?? mergeOptions(product.variants) });
      for (const key of keys) keyToIndex.set(key, nextIndex);
      continue;
    }
    canonicalProducts[existingIndex] = mergeTwoProducts(canonicalProducts[existingIndex], product);
    for (const key of productKeys(canonicalProducts[existingIndex])) keyToIndex.set(key, existingIndex);
    mergedDuplicates += 1;
  }

  return { 
    products: canonicalProducts.map(p => ({ ...p, confidenceScore: calculateConfidence(p) })), 
    mergedDuplicates 
  };
}

export function buildProductValidationStats(products: ProductData[], pageStats: ProductDiscoveryStats[]): ProductValidationStats {
  const merged = mergeProducts(products);
  const duplicateProducts = Math.max(0, products.length - new Set(products.map(productKey)).size - merged.mergedDuplicates);
  const productsBySource = pageStats.reduce<ProductDiscoveryStats>((acc, stats) => ({
    jsonLd: acc.jsonLd + stats.jsonLd,
    microdata: acc.microdata + stats.microdata,
    openGraph: acc.openGraph + stats.openGraph,
    html: acc.html + stats.html,
    api: acc.api + stats.api,
  }), { ...EMPTY_DISCOVERY_STATS });
  const requiredFields: Array<keyof ProductData> = ['name', 'slug', 'url', 'price', 'images', 'description'];
  const completeProducts = merged.products.filter((product) => requiredFields.every((field) => {
    const value = product[field];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== '';
  })).length;
  const imagesFound = merged.products.reduce((acc, product) => acc + (product.media?.length ?? (product.images?.length ?? 0)), 0);
  const variantsFound = merged.products.reduce((acc, product) => acc + product.variants.length, 0);
  const reconstructedFields = dedupeStrings(merged.products.flatMap((product) => Object.entries(product)
    .filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0))
    .map(([key]) => key)));
  const unobtainableFields = ['taxStatus', 'taxClass'].filter((field) => (
    merged.products.every((product) => product[field as keyof ProductData] === undefined)
  ));

  return {
    discoveredProducts: products.length,
    productsBySource,
    mergedDuplicates: merged.mergedDuplicates,
    finalProducts: merged.products.length,
    completeProducts,
    incompleteProducts: merged.products.length - completeProducts,
    discardedProducts: 0,
    imagesFound,
    imagesLost: 0,
    variantsFound,
    variantsLost: 0,
    reconstructedFields,
    unobtainableFields,
    missingGalleries: merged.products.filter((product) => (product.media?.length ?? (product.images?.length ?? 0)) === 0).length,
    duplicateProducts,
    orphanVariants: 0,
  };
}
