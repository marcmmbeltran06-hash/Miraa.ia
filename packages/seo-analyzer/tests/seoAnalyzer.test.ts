import { describe, expect, it } from 'vitest';
import { DefaultSeoAnalyzer } from '../src/SeoAnalyzer.js';

const analyzer = new DefaultSeoAnalyzer();

describe('DefaultSeoAnalyzer', () => {
  it('extracts core metadata and headings', () => {
    const report = analyzer.analyze({
      entryUrl: 'https://example.com',
      pages: [
        {
          url: 'https://example.com',
          finalUrl: 'https://example.com',
          statusCode: 200,
          depth: 0,
          responseTimeMs: 300,
          html: `
            <html>
              <head>
                <title>Home page title with valid length</title>
                <meta name="description" content="This is a rich description with enough characters to pass the SEO quality check for metadata length." />
                <meta name="robots" content="index,follow" />
                <link rel="canonical" href="https://example.com" />
                <meta property="og:title" content="OG Home" />
                <meta property="og:description" content="OG Description" />
                <meta property="og:image" content="https://example.com/og.jpg" />
                <meta name="twitter:card" content="summary_large_image" />
                <meta name="twitter:title" content="TW Title" />
                <meta name="twitter:description" content="TW Description" />
              </head>
              <body>
                <h1>Main heading</h1>
                <h2>Section heading</h2>
                <h3>Subsection heading</h3>
                <a href="/about">About</a>
                <a href="https://external.com">External</a>
                <img src="/logo.png" alt="Logo" />
              </body>
            </html>
          `,
        },
      ],
    });

    expect(report.pages).toHaveLength(1);
    expect(report.pages[0].title).toContain('Home page title');
    expect(report.pages[0].metaDescription).toContain('rich description');
    expect(report.pages[0].robots).toBe('index,follow');
    expect(report.pages[0].headings.h1).toEqual(['Main heading']);
    expect(report.pages[0].headings.h2).toEqual(['Section heading']);
    expect(report.pages[0].headings.h3).toEqual(['Subsection heading']);
    expect(report.pages[0].internalLinks).toContain('https://example.com/about');
    expect(report.pages[0].externalLinks).toContain('https://external.com/');
    expect(report.pages[0].anchorTexts[0]).toMatchObject({ text: 'About' });
    expect(report.pages[0].images[0]).toMatchObject({ alt: 'Logo' });
  });

  it('builds a platform-independent semantic site model', () => {
    const report = analyzer.analyze({
      entryUrl: 'https://example.com',
      pages: [
        {
          url: 'https://example.com',
          finalUrl: 'https://example.com',
          statusCode: 200,
          depth: 0,
          html: `
            <html lang="en">
              <head>
                <title>Semantic home page title</title>
                <meta name="description" content="Semantic home page description with enough text for validation boundaries." />
                <meta name="generator" content="WordPress 6.5" />
                <link rel="stylesheet" href="/wp-content/themes/twentytwentyfour/style.css" />
                <style>:root { --brand: #113355; } .hero { font-family: Inter; border-radius: 8px; }</style>
              </head>
              <body class="elementor-page">
                <header class="site-header sticky">
                  <img src="/logo.svg" alt="Brand logo" />
                  <nav aria-label="Primary"><a href="/">Home</a><a href="/shop">Shop</a></nav>
                  <form role="search"><input type="search" name="s" /></form>
                  <a href="/cart">Cart</a>
                </header>
                <main>
                  <section class="elementor-section hero">
                    <h1>Buildable Hero</h1>
                    <a class="cta" href="/shop">Shop now</a>
                  </section>
                  <section class="accordion"><h2>FAQ</h2></section>
                  <form class="wpcf7" action="/contact" method="post"><input name="email" type="email" required /></form>
                </main>
                <footer><p>Copyright 2026</p><nav><a href="/privacy">Privacy</a></nav></footer>
              </body>
            </html>
          `,
        },
      ],
    });

    expect(report.siteModel.modelKind).toBe('canonical-site-model');
    expect(report.siteModel.platform.primary?.name).toBe('WordPress');
    expect(report.siteModel.builder.primary?.name).toBe('Elementor');
    expect(report.siteModel.theme.active).toBe('twentytwentyfour');
    expect(report.siteModel.header.hasSearch).toBe(true);
    expect(report.siteModel.header.hasCart).toBe(true);
    expect(report.siteModel.navigation[0].items.map((item) => item.label)).toContain('Shop');
    expect(report.siteModel.globalStyles.cssVariables).toMatchObject({ '--brand': '#113355' });
    expect(report.pages[0].siteModel.layout[0].blocks[0].type).toBe('heading');
    expect(report.pages[0].siteModel.components.map((component) => component.type)).toContain('accordion');
    expect(report.pages[0].siteModel.forms[0].fields[0]).toMatchObject({ name: 's', type: 'search', required: false });
  });

  it('flags missing title and description as critical', () => {
    const report = analyzer.analyze({
      entryUrl: 'https://example.com',
      pages: [
        {
          url: 'https://example.com/no-meta',
          finalUrl: 'https://example.com/no-meta',
          statusCode: 200,
          depth: 1,
          html: '<html><head></head><body><h1>Page</h1></body></html>',
        },
      ],
    });

    const codes = report.criticalErrors.map((issue) => issue.code);
    expect(codes).toContain('TITLE_MISSING');
    expect(codes).toContain('DESCRIPTION_MISSING');
    expect(report.summary.pagesWithoutTitle).toBe(1);
    expect(report.summary.pagesWithoutDescription).toBe(1);
  });

  it('detects duplicate titles and descriptions', () => {
    const html = '<html><head><title>Duplicated title content for seo</title><meta name="description" content="Duplicated description with enough text for both pages in this test case." /></head><body><h1>H1</h1></body></html>';
    const report = analyzer.analyze({
      entryUrl: 'https://example.com',
      pages: [
        { url: 'https://example.com/a', finalUrl: 'https://example.com/a', statusCode: 200, depth: 1, html },
        { url: 'https://example.com/b', finalUrl: 'https://example.com/b', statusCode: 200, depth: 1, html },
      ],
    });

    expect(report.summary.duplicateTitles).toHaveLength(1);
    expect(report.summary.duplicateDescriptions).toHaveLength(1);
    expect(report.warnings.some((w) => w.code === 'DUPLICATE_TITLE')).toBe(true);
    expect(report.warnings.some((w) => w.code === 'DUPLICATE_DESCRIPTION')).toBe(true);
  });

  it('detects broken internal links based on crawled status', () => {
    const report = analyzer.analyze({
      entryUrl: 'https://example.com',
      pages: [
        {
          url: 'https://example.com',
          finalUrl: 'https://example.com',
          statusCode: 200,
          depth: 0,
          html: '<a href="/broken">Broken</a>',
        },
        {
          url: 'https://example.com/broken',
          finalUrl: 'https://example.com/broken',
          statusCode: 404,
          depth: 1,
          html: '<title>missing</title>',
        },
      ],
    });

    const home = report.pages.find((p) => p.url === 'https://example.com');
    expect(home?.brokenLinks).toContain('https://example.com/broken');
    expect(report.criticalErrors.some((e) => e.code === 'BROKEN_LINKS')).toBe(true);
  });

  it('detects redirects and canonical mismatch', () => {
    const report = analyzer.analyze({
      entryUrl: 'https://example.com',
      pages: [
        {
          url: 'https://example.com/start',
          finalUrl: 'https://example.com/final',
          statusCode: 301,
          depth: 0,
          html: `
            <html>
              <head>
                <title>Good title with enough length</title>
                <meta name="description" content="Long enough description to pass the expected threshold in this test implementation." />
                <link rel="canonical" href="https://example.com/wrong" />
              </head>
              <body><h1>H1</h1></body>
            </html>
          `,
        },
      ],
    });

    expect(report.info.some((i) => i.code === 'REDIRECT')).toBe(true);
    expect(report.warnings.some((i) => i.code === 'CANONICAL_INCORRECT')).toBe(true);
  });

  it('detects images without ALT and heavy inline images', () => {
    const heavyData = 'data:image/png;base64,' + 'A'.repeat(400_000);
    const report = analyzer.analyze({
      entryUrl: 'https://example.com',
      pages: [
        {
          url: 'https://example.com/img',
          finalUrl: 'https://example.com/img',
          statusCode: 200,
          depth: 0,
          html: `
            <html>
              <head>
                <title>Image page title with good length</title>
                <meta name="description" content="Image page description that is sufficiently long to satisfy the SEO rule boundaries." />
                <link rel="canonical" href="https://example.com/img" />
              </head>
              <body>
                <h1>Images</h1>
                <img src="/no-alt.png" />
                <img src="${heavyData}" alt="big" />
              </body>
            </html>
          `,
        },
      ],
    });

    const page = report.pages[0];
    expect(page.imagesWithoutAlt.length).toBe(1);
    expect(page.heavyImages.length).toBe(1);
    expect(report.warnings.some((w) => w.code === 'IMAGES_WITHOUT_ALT')).toBe(true);
    expect(report.warnings.some((w) => w.code === 'HEAVY_IMAGES')).toBe(true);
  });

  it('includes depth, html size, response time and computes bounded score', () => {
    const report = analyzer.analyze({
      entryUrl: 'https://example.com',
      pages: [
        {
          url: 'https://example.com/depth',
          finalUrl: 'https://example.com/depth',
          statusCode: 500,
          depth: 3,
          responseTimeMs: 3000,
          htmlSizeBytes: 900_000,
          html: '<html><body></body></html>',
        },
      ],
    });

    expect(report.pages[0].depth).toBe(3);
    expect(report.pages[0].htmlSizeBytes).toBe(900_000);
    expect(report.pages[0].responseTimeMs).toBe(3000);
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
    expect(report.criticalErrors.some((e) => e.code === 'HTTP_5XX')).toBe(true);
    expect(report.warnings.some((e) => e.code === 'SLOW_RESPONSE')).toBe(true);
  });

  it('extracts JSON-LD product data', () => {
    const report = analyzer.analyze({
      entryUrl: 'https://example.com',
      pages: [
        {
          url: 'https://example.com/product',
          finalUrl: 'https://example.com/product',
          statusCode: 200,
          depth: 1,
          html: `
            <html>
              <head>
                <title>Product page title with valid length</title>
                <meta name="description" content="Product page description that is sufficiently long for the SEO analyzer boundaries." />
                <link rel="canonical" href="https://example.com/product" />
                <script type="application/ld+json">
                  {
                    "@context": "https://schema.org",
                    "@type": "Product",
                    "name": "Linen Shirt",
                    "sku": "SKU-1",
                    "image": ["https://example.com/shirt.jpg"],
                    "category": "Shirts",
                    "offers": { "@type": "Offer", "price": "99.00" }
                  }
                </script>
              </head>
              <body><h1>Linen Shirt</h1></body>
            </html>
          `,
        },
      ],
    });

    expect(report.pages[0].structuredDataTypes).toContain('Product');
    expect(report.pages[0].products[0]).toMatchObject({
      name: 'Linen Shirt',
      sku: 'SKU-1',
      price: '99.00',
    });
    expect(report.pages[0].products[0].discoverySources).toContain('jsonLd');
    expect(report.summary.totalProducts).toBe(1);
  });

  it('merges duplicate product discoveries into one canonical product', () => {
    const productJson = `
      {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": "Everyday Jacket",
        "sku": "JACKET-1",
        "image": ["https://example.com/jacket-front.jpg"],
        "offers": { "@type": "Offer", "price": "120.00", "priceCurrency": "EUR" }
      }
    `;
    const report = analyzer.analyze({
      entryUrl: 'https://example.com',
      pages: [
        {
          url: 'https://example.com/products/jacket',
          finalUrl: 'https://example.com/products/jacket',
          statusCode: 200,
          depth: 1,
          html: `<title>Everyday Jacket product page</title><meta name="description" content="A jacket product page with enough metadata for the analyzer." /><link rel="canonical" href="https://example.com/products/jacket" /><script type="application/ld+json">${productJson}</script>`,
        },
        {
          url: 'https://example.com/collections/jackets/everyday-jacket',
          finalUrl: 'https://example.com/collections/jackets/everyday-jacket',
          statusCode: 200,
          depth: 2,
          html: `<title>Everyday Jacket duplicate page</title><meta name="description" content="A collection page duplicate with enough metadata for the analyzer." /><link rel="canonical" href="https://example.com/products/jacket" /><script type="application/ld+json">${productJson}</script>`,
        },
      ],
    });

    expect(report.summary.productValidation.discoveredProducts).toBe(2);
    expect(report.summary.productValidation.mergedDuplicates).toBe(1);
    expect(report.summary.productValidation.finalProducts).toBe(1);
    expect(report.summary.productValidation.duplicateProducts).toBe(0);
    expect(report.summary.totalProducts).toBe(1);
  });

  it('preserves complete product gallery order from HTML', () => {
    const report = analyzer.analyze({
      entryUrl: 'https://example.com',
      pages: [
        {
          url: 'https://example.com/products/gallery',
          finalUrl: 'https://example.com/products/gallery',
          statusCode: 200,
          depth: 1,
          html: `
            <html>
              <head>
                <title>Gallery product page title</title>
                <meta name="description" content="Gallery product metadata with enough text for validation boundaries." />
                <link rel="canonical" href="https://example.com/products/gallery" />
              </head>
              <body>
                <article class="product">
                  <h1>Gallery Product</h1>
                  <div class="product-gallery">
                    <img src="/gallery-1.jpg" alt="Front" width="800" height="900" />
                    <img data-src="/gallery-2.jpg" alt="Side" />
                    <img data-full="/gallery-3.jpg" alt="Back" />
                  </div>
                </article>
              </body>
            </html>
          `,
        },
      ],
    });

    const product = report.pages[0].products[0];
    expect(product.images).toEqual([
      'https://example.com/gallery-1.jpg',
      'https://example.com/gallery-2.jpg',
      'https://example.com/gallery-3.jpg',
    ]);
    expect(product.media?.map((item) => item.order)).toEqual([0, 1, 2]);
    expect(report.summary.productValidation.missingGalleries).toBe(0);
  });

  it('keeps the full gallery for simple products when structured data only has the featured image', () => {
    const report = analyzer.analyze({
      entryUrl: 'https://example.com',
      pages: [
        {
          url: 'https://example.com/products/simple-gallery',
          finalUrl: 'https://example.com/products/simple-gallery',
          statusCode: 200,
          depth: 1,
          html: `
            <html>
              <head>
                <title>Simple gallery product page</title>
                <meta name="description" content="Simple gallery product metadata with enough text for validation boundaries." />
                <link rel="canonical" href="https://example.com/products/simple-gallery" />
                <script type="application/ld+json">
                  {
                    "@context": "https://schema.org",
                    "@type": "Product",
                    "name": "Simple Gallery Product",
                    "sku": "SIMPLE-GALLERY",
                    "image": ["https://example.com/front.jpg"],
                    "offers": { "@type": "Offer", "price": "40.00" }
                  }
                </script>
              </head>
              <body>
                <img src="/logo.jpg" alt="Logo" />
                <article class="product">
                  <h1>Simple Gallery Product</h1>
                  <div class="woocommerce-product-gallery">
                    <img src="/front.jpg" alt="Front" />
                    <img src="/side.jpg" alt="Side" />
                    <img src="/back.jpg" alt="Back" />
                  </div>
                </article>
              </body>
            </html>
          `,
        },
      ],
    });

    const product = report.pages[0].products[0];
    expect(product.variants).toHaveLength(0);
    expect(product.images).toEqual([
      'https://example.com/front.jpg',
      'https://example.com/side.jpg',
      'https://example.com/back.jpg',
    ]);
  });

  it('groups variants under a single product instead of creating duplicate products', () => {
    const report = analyzer.analyze({
      entryUrl: 'https://example.com',
      pages: [
        {
          url: 'https://example.com/products/shoe',
          finalUrl: 'https://example.com/products/shoe',
          statusCode: 200,
          depth: 1,
          html: `
            <html>
              <head>
                <title>Shoe product page title</title>
                <meta name="description" content="Shoe product metadata with enough text for validation boundaries." />
                <link rel="canonical" href="https://example.com/products/shoe" />
                <script type="application/ld+json">
                  {
                    "@context": "https://schema.org",
                    "@type": "Product",
                    "name": "Runner Shoe",
                    "sku": "RUNNER",
                    "image": ["https://example.com/runner.jpg"],
                    "hasVariant": [
                      { "@type": "Product", "sku": "RUNNER-40-BLK", "size": "40", "color": "Black", "offers": { "price": "80.00" } },
                      { "@type": "Product", "sku": "RUNNER-41-BLK", "size": "41", "color": "Black", "offers": { "price": "80.00" } }
                    ],
                    "offers": { "@type": "Offer", "price": "80.00" }
                  }
                </script>
              </head>
              <body><h1>Runner Shoe</h1></body>
            </html>
          `,
        },
      ],
    });

    const product = report.pages[0].products[0];
    expect(report.summary.totalProducts).toBe(1);
    expect(product.variants).toHaveLength(2);
    expect(product.options).toEqual({ size: ['40', '41'], color: ['Black'] });
    expect(product.variants.map((variant) => variant.sku)).toEqual(['RUNNER-40-BLK', 'RUNNER-41-BLK']);
  });

  it('reconstructs galleries from picture, srcset, preload and lazy image attributes', () => {
    const report = analyzer.analyze({
      entryUrl: 'https://example.com',
      pages: [
        {
          url: 'https://example.com/products/media-rich',
          finalUrl: 'https://example.com/products/media-rich',
          statusCode: 200,
          depth: 1,
          html: `
            <html>
              <head>
                <title>Media rich product page</title>
                <meta name="description" content="Media rich product metadata with enough text for validation boundaries." />
                <link rel="canonical" href="https://example.com/products/media-rich" />
                <link rel="preload" as="image" href="/preload.jpg" />
              </head>
              <body>
                <article class="product">
                  <h1>Media Product</h1>
                  <div class="product-gallery">
                    <picture>
                      <source srcset="/picture-large.webp 1200w, /picture-small.webp 600w" />
                      <img src="/fallback.jpg" data-zoom-image="/zoom.jpg" alt="Media" />
                    </picture>
                    <img data-lazy-src="/lazy.jpg" />
                  </div>
                </article>
              </body>
            </html>
          `,
        },
      ],
    });

    expect(report.pages[0].products[0].images).toEqual([
      'https://example.com/picture-large.webp',
      'https://example.com/picture-small.webp',
      'https://example.com/zoom.jpg',
      'https://example.com/fallback.jpg',
      'https://example.com/lazy.jpg',
    ]);
  });

  it('extracts platform-style inline JSON products with variants', () => {
    const report = analyzer.analyze({
      entryUrl: 'https://example.com',
      pages: [
        {
          url: 'https://example.com/products/shopify-like',
          finalUrl: 'https://example.com/products/shopify-like',
          statusCode: 200,
          depth: 1,
          html: `
            <html>
              <head>
                <title>Inline JSON product page</title>
                <meta name="description" content="Inline JSON product metadata with enough text for validation boundaries." />
                <link rel="canonical" href="https://example.com/products/shopify-like" />
              </head>
              <body>
                <script type="application/json">
                  {
                    "id": 42,
                    "title": "Inline Jacket",
                    "handle": "inline-jacket",
                    "images": ["https://example.com/inline-1.jpg", "https://example.com/inline-2.jpg"],
                    "variants": [
                      { "id": 101, "sku": "INLINE-BLK-M", "option1": "Black", "option2": "M", "price": "90", "inventory_quantity": 5 }
                    ]
                  }
                </script>
              </body>
            </html>
          `,
        },
      ],
    });

    const product = report.pages[0].products[0];
    expect(product.discoverySources).toContain('api');
    expect(product.name).toBe('Inline Jacket');
    expect(product.images).toEqual(['https://example.com/inline-1.jpg', 'https://example.com/inline-2.jpg']);
    expect(product.variants[0]).toMatchObject({
      id: '101',
      sku: 'INLINE-BLK-M',
      stock: '5',
      attributes: { option1: 'Black', option2: 'M' },
    });
  });
});
