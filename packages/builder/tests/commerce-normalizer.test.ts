import { describe, expect, it } from 'vitest';
import { normalizeCommerceProducts } from '../src/CommerceNormalizer.js';

describe('normalizeCommerceProducts', () => {
  it('folds Shopify variants into one variable WooCommerce product', () => {
    const canonical = 'https://example.test/products/brasier-encaje';
    const products = [
      {
        id: `${canonical}?variant=1000001`, canonical, name: 'Brasier Encaje - Rojo / B', price: '48.00',
        seo: { jsonLd: [{
          '@type': 'ProductGroup', name: 'Brasier Encaje', productGroupID: '90001', category: 'Brasieres',
          description: 'Brasier cómodo.', hasVariant: [
            { '@type': 'Product', '@id': `${canonical}#variant=1000001`, name: 'Brasier Encaje - Rojo / B', image: 'https://example.test/red.jpg', offers: { price: '48.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock', url: `${canonical}?variant=1000001` } },
            { '@type': 'Product', '@id': `${canonical}#variant=1000002`, name: 'Brasier Encaje - Beige / B', image: 'https://example.test/beige.jpg', offers: { price: '48.00', priceCurrency: 'USD', availability: 'https://schema.org/OutOfStock', url: `${canonical}?variant=1000002` } },
          ],
        }] },
      },
      { id: `${canonical}?variant=1000002`, canonical, name: 'Brasier Encaje - Beige / B', price: '48.00' },
      { id: 'https://example.test/pages/contact', canonical: 'https://example.test/pages/contact', name: 'Example Store', price: '10.00' },
    ];

    const result = normalizeCommerceProducts(products);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Brasier Encaje');
    expect(result[0].categories).toContain('Brasieres');
    expect(result[0].variants).toHaveLength(2);
    expect(result[0].attributes.color).toEqual(['Rojo', 'Beige']);
    expect(result[0].attributes.talla).toEqual(['B']);
    expect(result[0].variants[1].stockStatus).toBe('outofstock');
  });

  it('keeps a simple priced product when no standard product route exists', () => {
    const result = normalizeCommerceProducts([{ id: 'sku-1', sku: 'sku-1', name: 'Producto simple', price: '19.90' }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: 'Producto simple', regularPrice: '19.90', variants: [] });
  });

  it('keeps evidenced products on custom routes alongside standard routes', () => {
    const result = normalizeCommerceProducts([
      {
        canonical: 'https://example.test/products/standard-item',
        sku: 'standard-1',
        name: 'Standard item',
        price: '20.00',
        images: ['https://example.test/standard.jpg'],
      },
      {
        canonical: 'https://example.test/catalogue/summer/custom-item?variant=blue',
        sku: 'custom-1',
        name: 'Custom item',
        price: '25.00',
        categories: ['Summer'],
        images: ['https://example.test/custom.jpg'],
      },
      {
        canonical: 'https://example.test/pages/shipping',
        name: 'Shipping from 5 EUR',
        price: '5.00',
      },
    ]);

    expect(result.map((product) => product.sku)).toEqual([
      'autowp-product-custom-item',
      'autowp-product-standard-item',
    ]);
    expect(result.find((product) => product.name === 'Custom item')?.sourceUrl)
      .toBe('https://example.test/catalogue/summer/custom-item');
  });
});
