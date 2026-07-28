import type { SourceProduct } from './types.js';

export interface CommerceSeedVariant {
  id?: string;
  sku: string;
  regularPrice?: string;
  salePrice?: string;
  stock?: string;
  stockStatus?: string;
  attributes: Record<string, string>;
  image?: string;
}

export interface CommerceSeedProduct {
  sourceUrl?: string;
  currency?: string;
  sku: string;
  slug: string;
  name: string;
  description: string;
  shortDescription: string;
  regularPrice: string;
  salePrice: string;
  stock: string;
  stockStatus: string;
  categories: string[];
  tags: string[];
  images: string[];
  attributes: Record<string, string[]>;
  variants: CommerceSeedVariant[];
  seo: Record<string, unknown>;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function slugify(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'product';
}

function canonicalCandidateUrl(product: SourceProduct): string | undefined {
  const candidate = product.canonical ?? product.url ?? product.sourceUrl;
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    const path = parsed.pathname.replace(/\/+$/, '');
    // Variant and tracking parameters identify a state of the same product,
    // not another catalogue item.
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.origin}${path}`.toLowerCase();
  } catch {
    return undefined;
  }
}

function schemaObjects(product: SourceProduct): JsonRecord[] {
  const seo = asRecord(product.seo);
  return list(seo?.jsonLd).flatMap((value) => asRecord(value) ? [asRecord(value)!] : []);
}

function schemaType(value: JsonRecord): string[] {
  return list(value['@type']).flatMap((item) => text(item) ? [text(item)!.toLowerCase()] : []);
}

function hasProductSchema(product: SourceProduct): boolean {
  return schemaObjects(product).some((value) => {
    const types = schemaType(value);
    return types.includes('product') || types.includes('productgroup');
  });
}

function isStandardProductRoute(product: SourceProduct): boolean {
  const candidate = canonicalCandidateUrl(product);
  if (!candidate) return false;
  try {
    return /(?:^|\/)(?:products?|producto|productos|produit|produkte?)\/[^/]+$/i.test(new URL(candidate).pathname);
  } catch {
    return false;
  }
}

function productEvidenceScore(product: SourceProduct): number {
  let score = 0;
  if (isStandardProductRoute(product)) score += 4;
  if (hasProductSchema(product)) score += 4;
  if (text(product.sku)) score += 2;
  if (list(product.variants).length > 0) score += 2;
  if (text(product.price) || text(product.regularPrice) || text(product.salePrice)) score += 1;
  if (text(product.name) || text(product.title)) score += 1;
  if ((product.media?.length ?? product.images?.length ?? 0) > 0) score += 1;
  if ((product.categories?.length ?? 0) > 0) score += 1;
  return score;
}

function normalizedProductKey(product: SourceProduct): string | undefined {
  const candidateUrl = canonicalCandidateUrl(product);
  // Accept custom catalogue routes only when the capture contains independent
  // product evidence. This avoids losing products on /p/, /shop/item/ or fully
  // custom storefront paths while still rejecting ordinary priced pages.
  if (candidateUrl && productEvidenceScore(product) >= 4) return candidateUrl;
  const stableId = text(product.sku) ?? text(product.slug) ?? text(product.id);
  if (stableId && productEvidenceScore(product) >= 5) return `product:${slugify(stableId)}`;
  return undefined;
}

function bestProductGroup(products: SourceProduct[]): JsonRecord | undefined {
  return products.flatMap(schemaObjects)
    .filter((value) => schemaType(value).includes('productgroup'))
    .sort((a, b) => list(b.hasVariant).length - list(a.hasVariant).length)[0];
}

function offerOf(value: JsonRecord): JsonRecord {
  return list(value.offers).flatMap((offer) => asRecord(offer) ? [asRecord(offer)!] : [])[0] ?? {};
}

function variantId(value: JsonRecord): string | undefined {
  const raw = text(value.sku) ?? text(value['@id']) ?? text(offerOf(value).url);
  return raw?.match(/[?&#]variant=(\d+)/i)?.[1] ?? raw?.match(/(?:^|\D)(\d{6,})(?:\D|$)/)?.[1];
}

function variantTokens(name: string | undefined, baseName: string): string[] {
  if (!name) return [];
  const normalizedBase = baseName.replace(/\s+/g, ' ').trim().toLowerCase();
  const normalizedName = name.replace(/\s+/g, ' ').trim();
  const lowerName = normalizedName.toLowerCase();
  const suffix = lowerName.startsWith(`${normalizedBase} - `)
    ? normalizedName.slice(normalizedName.indexOf(' - ') + 3)
    : normalizedName;
  return suffix.split('/').map((part) => part.trim()).filter(Boolean);
}

const COLOR_WORDS = new Set(['negro', 'negra', 'blanco', 'blanca', 'beige', 'marrón', 'marron', 'rojo', 'roja', 'azul', 'azul marino', 'verde', 'rosa', 'gris', 'café', 'cafe', 'cocoa', 'perla', 'chantilly', 'vino', 'nude']);

function attributeNames(rows: string[][]): string[] {
  const width = Math.max(0, ...rows.map((row) => row.length));
  return Array.from({ length: width }, (_, index) => {
    const values = rows.map((row) => row[index]?.toLowerCase()).filter((value): value is string => Boolean(value));
    if (values.length > 0 && values.every((value) => COLOR_WORDS.has(value))) return 'color';
    if (values.length > 0 && values.every((value) => /^(?:\d{2,3}[a-z]?|\d?x{0,3}s|[smlx]{1,4}|[a-h])$/i.test(value))) return 'talla';
    return `opcion-${index + 1}`;
  });
}

function schemaVariants(group: JsonRecord, baseName: string): CommerceSeedVariant[] {
  const variants = list(group.hasVariant).flatMap((value) => asRecord(value) ? [asRecord(value)!] : []);
  const tokenRows = variants.map((variant) => variantTokens(text(variant.name), baseName));
  const names = attributeNames(tokenRows);
  return variants.flatMap((variant, index) => {
    const id = variantId(variant);
    if (!id) return [];
    const offer = offerOf(variant);
    const tokens = tokenRows[index];
    const attributes = Object.fromEntries(tokens.map((value, tokenIndex) => [names[tokenIndex], value]));
    const availability = text(offer.availability)?.toLowerCase() ?? '';
    return [{
      id,
      sku: `autowp-variant-${id}`,
      regularPrice: text(offer.price ?? variant.price),
      salePrice: text(offer.salePrice ?? variant.salePrice),
      stockStatus: availability.includes('outofstock') ? 'outofstock' : availability.includes('instock') ? 'instock' : undefined,
      attributes,
      image: text(variant.image),
    }];
  });
}

function rowVariants(products: SourceProduct[], baseName: string, sourceSlug: string): CommerceSeedVariant[] {
  const candidates = products.filter((product) => {
    const name = product.name ?? product.title ?? '';
    return name.toLowerCase().startsWith(`${baseName.toLowerCase()} - `) && Boolean(product.price ?? product.regularPrice);
  });
  const rows = candidates.map((product) => variantTokens(product.name ?? product.title, baseName));
  const names = attributeNames(rows);
  return candidates.map((product, index) => {
    const rawId = product.id?.match(/[?&#]variant=(\d+)/i)?.[1] ?? product.id;
    const id = rawId || `${sourceSlug}-${index + 1}`;
    return {
      id,
      sku: `autowp-variant-${slugify(id)}`,
      regularPrice: product.regularPrice ?? product.price,
      salePrice: product.salePrice,
      stock: product.stock,
      stockStatus: product.stockStatus,
      attributes: Object.fromEntries(rows[index].map((value, tokenIndex) => [names[tokenIndex], value])),
      image: product.media?.[0]?.url ?? product.images?.[0],
    };
  });
}

function chooseName(products: SourceProduct[], group: JsonRecord | undefined, slug: string): string {
  const schemaName = text(group?.name);
  if (schemaName) return schemaName;
  const names = unique(products.map((product) => product.name ?? product.title))
    .filter((name) => !name.includes(' - '))
    .sort((a, b) => a.length - b.length);
  return names[0] ?? slug.replace(/-/g, ' ');
}

function chooseDescription(products: SourceProduct[], group: JsonRecord | undefined): string {
  const values = unique([
    text(group?.description),
    ...products.map((product) => product.descriptionHtml ?? product.description),
  ]).sort((a, b) => b.length - a.length);
  return values[0] ?? '';
}

export function normalizeCommerceProducts(products: SourceProduct[]): CommerceSeedProduct[] {
  const groups = new Map<string, SourceProduct[]>();
  for (const product of products) {
    const key = normalizedProductKey(product);
    if (!key) continue;
    const current = groups.get(key) ?? [];
    current.push(product);
    groups.set(key, current);
  }

  // Last-resort import for sparse technical exports that contain no schema,
  // URL or media evidence. It is intentionally used only when no stronger
  // candidate was found.
  if (groups.size === 0) {
    for (const product of products.filter((item) => Boolean((item.name ?? item.title) && (item.price ?? item.regularPrice)))) {
      const key = product.sku ?? product.slug ?? product.id ?? slugify(product.name ?? product.title ?? 'product');
      groups.set(`fallback:${key}`, [product]);
    }
  }

  return [...groups.entries()].map(([sourceUrl, rows]) => {
    const group = bestProductGroup(rows);
    const slug = text(group?.url)?.split('/').filter(Boolean).pop() ?? rows.find((row) => row.slug)?.slug ?? sourceUrl.split('/').pop() ?? 'product';
    const name = chooseName(rows, group, slug);
    const groupId = text(group?.productGroupID) ?? text(group?.['@id'])?.match(/(\d{6,})/)?.[1] ?? slug;
    const variants = schemaVariants(group ?? {}, name);
    const normalizedVariants = variants.length > 0 ? variants : rowVariants(rows, name, slug);
    const attributeValues: Record<string, string[]> = {};
    for (const variant of normalizedVariants) {
      for (const [attribute, value] of Object.entries(variant.attributes)) {
        attributeValues[attribute] = unique([...(attributeValues[attribute] ?? []), value]);
      }
    }
    const category = text(group?.category);
    const best = rows.find((row) => (row.name ?? row.title)?.replace(/\s+/g, ' ').trim().toLowerCase() === name.replace(/\s+/g, ' ').trim().toLowerCase()) ?? rows[0];
    const images = unique([
      ...list(group?.hasVariant).flatMap((value) => text(asRecord(value)?.image) ? [text(asRecord(value)?.image)!] : []),
      ...rows.flatMap((row) => row.media?.map((item) => item.url) ?? row.images ?? []),
    ]);
    const currency = unique([
      ...rows.map((row) => row.currency),
      ...list(group?.hasVariant).map((value) => text(offerOf(asRecord(value) ?? {}).priceCurrency)),
    ])[0];
    return {
      sourceUrl: sourceUrl.startsWith('fallback:') || sourceUrl.startsWith('product:')
        ? (best.canonical ?? best.url ?? best.sourceUrl)
        : sourceUrl,
      currency,
      sku: `autowp-product-${slugify(groupId)}`,
      slug: slugify(slug),
      name,
      description: chooseDescription(rows, group),
      shortDescription: best.shortDescription ?? '',
      regularPrice: normalizedVariants.length > 0 ? '' : best.regularPrice ?? best.price ?? '',
      salePrice: normalizedVariants.length > 0 ? '' : best.salePrice ?? '',
      stock: normalizedVariants.length > 0 ? '' : best.stock ?? '',
      stockStatus: normalizedVariants.length > 0 ? '' : best.stockStatus ?? '',
      categories: unique([category, ...rows.flatMap((row) => row.categories ?? [])]),
      tags: unique(rows.flatMap((row) => row.tags ?? [])),
      images,
      attributes: attributeValues,
      variants: normalizedVariants,
      seo: best.seo ?? {},
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
