// tests for ProductExtraction and confidenceScore
import { describe, it, expect } from 'vitest';
import { calculateConfidence, mergeProducts } from '../src/ProductExtraction';
import type { ProductData } from '../src/types';

describe('calculateConfidence', () => {
  it('returns base score plus increments for required fields', () => {
    const product: ProductData = {
      name: 'Test Product',
      slug: 'test-product',
      url: 'https://example.com/product',
      price: '10.00',
      images: ['https://example.com/img1.jpg'],
      variants: [],
      attributes: {},
      sourceUrl: 'https://example.com/product',
    };
    const score = calculateConfidence(product);
    // base 50 + 5*10 = 100 (capped)
    expect(score).toBe(100);
  });

  it('adds optional field points and variant points', () => {
    const product: ProductData = {
      name: 'Prod',
      slug: 'prod',
      url: 'https://ex.com/p',
      price: '5',
      images: ['https://ex.com/i.jpg'],
      description: 'Desc',
      sku: 'SKU1',
      gtin: '12345',
      brand: 'BrandX',
      variants: [{ id: 'v1', attributes: {} }],
      attributes: {},
      sourceUrl: 'https://ex.com/p',
    };
    const score = calculateConfidence(product);
    // base 50 + 5*10 (required) = 100, optional +4*5 = 20, variant +5 = 125 capped 100
    expect(score).toBe(100);
  });
});

describe('mergeProducts adds confidenceScore', () => {
  it('calculates confidence for merged product', () => {
    const p1: ProductData = { name: 'A', slug: 'a', url: 'u', price: '1', images: [], variants: [], attributes: {}, sourceUrl: 'u' };
    const p2: ProductData = { name: 'A', slug: 'a', url: 'u', price: '1', images: [], variants: [], attributes: {}, sourceUrl: 'u' };
    const result = mergeProducts([p1, p2]);
    expect(result.products[0].confidenceScore).toBeDefined();
    // With no optional fields, score should be 50 + 5*10 = 100 (capped)
    expect(result.products[0].confidenceScore).toBe(100);
  });

  it('does not merge different products just because they share a page URL', () => {
    const p1: ProductData = { name: 'Blue Shirt', slug: 'collection', url: 'https://ex.com/collection', price: '10', images: ['https://ex.com/blue.jpg'], variants: [], attributes: {}, sourceUrl: 'https://ex.com/collection' };
    const p2: ProductData = { name: 'Red Shirt', slug: 'collection', url: 'https://ex.com/collection', price: '12', images: ['https://ex.com/red.jpg'], variants: [], attributes: {}, sourceUrl: 'https://ex.com/collection' };
    const result = mergeProducts([p1, p2]);

    expect(result.products).toHaveLength(2);
    expect(result.mergedDuplicates).toBe(0);
  });

  it('preserves image order while merging duplicate products', () => {
    const p1: ProductData = { name: 'Gallery Product', slug: 'gallery', url: 'https://ex.com/gallery', price: '10', images: ['https://ex.com/front.jpg'], variants: [], attributes: {}, sourceUrl: 'https://ex.com/gallery' };
    const p2: ProductData = { name: 'Gallery Product', slug: 'gallery', url: 'https://ex.com/gallery', images: ['https://ex.com/front.jpg', 'https://ex.com/side.jpg', 'https://ex.com/back.jpg'], variants: [], attributes: {}, sourceUrl: 'https://ex.com/gallery' };
    const result = mergeProducts([p1, p2]);

    expect(result.products).toHaveLength(1);
    expect(result.products[0].images).toEqual([
      'https://ex.com/front.jpg',
      'https://ex.com/side.jpg',
      'https://ex.com/back.jpg',
    ]);
  });
});
