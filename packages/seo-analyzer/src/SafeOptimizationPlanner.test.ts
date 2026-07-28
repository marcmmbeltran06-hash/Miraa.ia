import { describe, expect, it } from 'vitest';
import { parseHTML } from 'linkedom';
import { createSafeOptimizationPlan } from './SafeOptimizationPlanner.js';
import type { SeoReport } from './types.js';

function reportWith(html: string): SeoReport {
  return {
    score: 70,
    criticalErrors: [], warnings: [], info: [],
    summary: {
      totalPages: 1, redirects: 0, brokenLinks: 0, pagesWithoutTitle: 0,
      pagesWithoutDescription: 1, duplicateTitles: [], duplicateDescriptions: [],
      noindexPages: 0, thinContentPages: 0, totalProducts: 1,
      productValidation: {
        discoveredProducts: 1, productsBySource: { jsonLd: 1, microdata: 0, openGraph: 0, html: 0, api: 0 },
        mergedDuplicates: 0, finalProducts: 1, completeProducts: 1, incompleteProducts: 0,
        discardedProducts: 0, imagesFound: 1, imagesLost: 0, variantsFound: 0, variantsLost: 0,
        reconstructedFields: [], unobtainableFields: [], missingGalleries: 0, duplicateProducts: 0, orphanVariants: 0,
      },
    },
    pages: [{
      url: 'https://shop.test/producto/vestido', finalUrl: 'https://shop.test/producto/vestido', statusCode: 200, depth: 1,
      htmlSizeBytes: html.length, title: 'Vestido', headings: { h1: ['Vestido azul'], h2: [], h3: [] },
      openGraph: {}, twitter: {}, jsonLd: [], structuredDataTypes: [], internalLinks: [], externalLinks: [], brokenLinks: [], anchorTexts: [],
      images: [{ src: '/vestido-azul.jpg' }], redirectsTo: undefined, imagesWithoutAlt: ['/vestido-azul.jpg'], heavyImages: [],
      wordCount: 100, thinContent: false, indexability: 'indexable', noindex: false, nofollow: false,
      securityHeaders: {}, products: [{ sourceUrl: 'https://shop.test/producto/vestido', title: 'Vestido azul', variants: [] }], issues: [],
      pageContent: 'Vestido azul confeccionado localmente con detalles ajustables para distintas ocasiones.', pageHtml: html,
    }],
  };
}

describe('createSafeOptimizationPlan', () => {
  it('creates only reviewable and reversible DOM-validated proposals', () => {
    const plan = createSafeOptimizationPlan(reportWith('<html><body><main><h1>Vestido azul</h1><a id="buy">Ver más</a><img id="photo" src="/vestido-azul.jpg"></main></body></html>'));
    expect(plan.mode).toBe('review_required');
    expect(plan.guarantees.automaticApplication).toBe(false);
    expect(plan.proposals.some((item) => item.category === 'cro')).toBe(true);
    expect(plan.proposals.some((item) => item.category === 'accessibility')).toBe(true);
    for (const proposal of plan.proposals) {
      expect(proposal.autoApply).toBe(false);
      expect(proposal.expectedImpactKind).toBe('hypothesis');
      expect(proposal.operations.every((operation) => operation.reversible)).toBe(true);
    }
  });

  it('disambiguates repeated CTAs with selectors that resolve to one element', () => {
    const html = '<html><body><a class="cta">Ver más</a><a class="cta">Ver más</a></body></html>';
    const plan = createSafeOptimizationPlan(reportWith(html));
    const { document } = parseHTML(html);
    const operations = plan.proposals
      .filter((item) => item.category === 'cro')
      .flatMap((item) => item.operations);
    expect(operations).toHaveLength(2);
    for (const operation of operations) expect(document.querySelectorAll(operation.selector)).toHaveLength(1);
  });
});
