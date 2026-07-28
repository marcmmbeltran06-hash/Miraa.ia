import { describe, expect, it } from 'vitest';
import {
  canonicalizeUrl,
  equivalenceKey,
  urlPatternKey,
  isAssetUrl,
  assetTypeFromUrl,
} from '../src/utils';

describe('URL equivalence helpers', () => {
  it('canonicalizeUrl strips tracking params', () => {
    const url = 'https://shop.com/product?utm_source=google&id=1';
    expect(canonicalizeUrl(url)).toBe('https://shop.com/product?id=1');
  });

  it('equivalenceKey ignores sort and filter params', () => {
    const a = 'https://shop.com/category/shoes?sort=price&page=2';
    const b = 'https://shop.com/category/shoes?sort=name&page=2';
    expect(equivalenceKey(a)).toBe(equivalenceKey(b));
  });

  it('equivalenceKey preserves identity params', () => {
    const a = 'https://shop.com/product?id=10&color=red';
    const b = 'https://shop.com/product?id=11&color=red';
    expect(equivalenceKey(a)).not.toBe(equivalenceKey(b));
  });

  it('urlPatternKey normalizes numeric path segments', () => {
    expect(urlPatternKey('https://shop.com/product/123?sort=price')).toBe(
      urlPatternKey('https://shop.com/product/456?sort=name'),
    );
  });

  it('collapses product variants to a single knowledge entity', () => {
    const base = 'https://shop.com/product?id=10';
    const variantA = 'https://shop.com/product?id=10&variant=100';
    const variantB = 'https://shop.com/product?id=10&variant=200';
    expect(equivalenceKey(variantA)).toBe(equivalenceKey(base));
    expect(equivalenceKey(variantB)).toBe(equivalenceKey(base));
  });

  it('collapses session and recommendation params to a single entity', () => {
    const base = 'https://shop.com/product?id=10';
    const withSession = 'https://shop.com/product?id=10&phpsessid=abc123';
    const withRec = 'https://shop.com/product?id=10&rec=carousel';
    expect(canonicalizeUrl(withSession)).toBe(base);
    expect(equivalenceKey(withRec)).toBe(equivalenceKey(base));
  });
});

describe('Asset classification', () => {
  it('detects assets by extension across platforms', () => {
    for (const url of [
      'https://cdn.shop.com/img/photo.jpg',
      'https://site.com/wp-content/uploads/2024/pic.PNG',
      'https://site.com/assets/app.js',
      'https://site.com/assets/main.css',
      'https://site.com/fonts/inter.woff2',
      'https://site.com/media/promo.mp4',
      'https://site.com/files/catalog.pdf',
    ]) {
      expect(isAssetUrl(url)).toBe(true);
    }
  });

  it('does not treat navigable pages as assets', () => {
    for (const url of [
      'https://site.com',
      'https://site.com/product/linen-shirt',
      'https://site.com/category/shoes',
      'https://site.com/about',
      'https://site.com/blog/post-title',
    ]) {
      expect(isAssetUrl(url)).toBe(false);
    }
  });

  it('classifies asset types', () => {
    expect(assetTypeFromUrl('https://s.com/a.png')).toBe('image');
    expect(assetTypeFromUrl('https://s.com/a.css')).toBe('stylesheet');
    expect(assetTypeFromUrl('https://s.com/a.js')).toBe('script');
    expect(assetTypeFromUrl('https://s.com/a.woff2')).toBe('font');
    expect(assetTypeFromUrl('https://s.com/a.mp4')).toBe('media');
    expect(assetTypeFromUrl('https://s.com/a.pdf')).toBe('document');
  });
});
