import { describe, expect, it } from 'vitest';
import type { SeoReport } from '@autowp/seo-analyzer';
import { detectGarmentZone, selectTryOnCandidate } from '../src/tryon/UniversalTryOnSample.js';
import { buildExport } from '../src/ExportService.js';

function reportWithProduct(name: string, image = 'https://shop.test/product.webp'): SeoReport {
  return {
    score: 70,
    criticalErrors: [],
    warnings: [],
    info: [],
    summary: {
      totalPages: 1, redirects: 0, brokenLinks: 0, pagesWithoutTitle: 0, pagesWithoutDescription: 0,
      duplicateTitles: [], duplicateDescriptions: [], noindexPages: 0, thinContentPages: 0, totalProducts: 1,
      productValidation: {} as SeoReport['summary']['productValidation'],
    },
    pages: [{
      url: 'https://shop.test/product', finalUrl: 'https://shop.test/product', statusCode: 200, depth: 1,
      htmlSizeBytes: 100, headings: { h1: [], h2: [], h3: [], h4: [], h5: [], h6: [] },
      openGraph: {}, twitter: {}, jsonLd: [], structuredDataTypes: [], internalLinks: [], externalLinks: [],
      brokenLinks: [], anchorTexts: [], images: [], imagesWithoutAlt: [], heavyImages: [], wordCount: 20,
      thinContent: false, indexability: 'indexable', noindex: false, nofollow: false, securityHeaders: {},
      issues: [], products: [{ name, sourceUrl: 'https://shop.test/product', url: 'https://shop.test/product', price: '79 €', images: [image], variants: [] }],
    }],
  };
}

describe('UniversalTryOnSample', () => {
  it('selects a supported clothing product and its image', () => {
    const candidate = selectTryOnCandidate(reportWithProduct('Chaqueta bomber negra para mujer'));
    expect(candidate).toMatchObject({
      productName: 'Chaqueta bomber negra para mujer',
      garmentZone: 'tops',
      modelGender: 'female',
      garmentImageUrl: 'https://shop.test/product.webp',
    });
  });

  it('rejects accessories that the local engine cannot render', () => {
    expect(detectGarmentZone({ name: 'Bolso shopper', sourceUrl: 'https://shop.test/bag', images: ['https://shop.test/bag.webp'], variants: [] })).toBeUndefined();
  });

  it('classifies dresses as one-piece garments', () => {
    expect(selectTryOnCandidate(reportWithProduct('Vestido largo azul'))?.garmentZone).toBe('one-pieces');
  });

  it('builds an evidence-backed compact report for mass campaigns', () => {
    const artifact = buildExport(reportWithProduct('Chaqueta bomber negra para mujer'), 'mira', '00000000-0000-4000-8000-000000000000');
    const payload = JSON.parse(String(artifact.body)) as { tryOn: { productName: string; productImage: string }; evidencePolicy: string };
    expect(payload.tryOn.productName).toBe('Chaqueta bomber negra para mujer');
    expect(payload.tryOn.productImage).toBe('https://shop.test/product.webp');
    expect(payload.evidencePolicy).toContain('rastreo');
  });
});
