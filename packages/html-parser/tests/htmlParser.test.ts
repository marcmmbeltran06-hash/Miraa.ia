import { describe, expect, it } from 'vitest';
import { parseHtml } from '../src/HtmlParser';

describe('parseHtml', () => {
  it('extracts title, metadata, links, assets, json-ld, and microdata', () => {
    const html = `
      <!doctype html>
      <html>
        <head>
          <title>Example Page</title>
          <meta name="description" content="A description" />
          <link rel="canonical" href="/canonical-page" />
          <link rel="stylesheet" href="/styles.css" />
          <script src="/scripts.js"></script>
          <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite"}</script>
        </head>
        <body>
          <a href="/internal">Internal</a>
          <a href="https://external.com/page">External</a>
          <img src="/image.png" />
          <div itemscope itemtype="https://schema.org/Product">
            <span itemprop="name">Example Product</span>
            <span itemprop="description">Great product</span>
          </div>
        </body>
      </html>
    `;

    const result = parseHtml(html, 'https://example.com/page');

    expect(result.title).toBe('Example Page');
    expect(result.description).toBe('A description');
    expect(result.canonical).toBe('https://example.com/canonical-page');
    expect(result.internalLinks).toEqual(['https://example.com/internal']);
    expect(result.externalLinks).toEqual(['https://external.com/page']);
    expect(result.images).toEqual(['https://example.com/image.png']);
    expect(result.scripts).toEqual(['https://example.com/scripts.js']);
    expect(result.stylesheets).toEqual(['https://example.com/styles.css']);
    expect(result.jsonLd).toEqual([{ '@context': 'https://schema.org', '@type': 'WebSite' }]);
    expect(result.microdata).toEqual([
      {
        itemType: 'https://schema.org/Product',
        properties: {
          name: 'Example Product',
          description: 'Great product',
        },
      },
    ]);
  });
});
