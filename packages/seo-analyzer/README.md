# Product Extraction Pipeline

The analyzer now treats extracted products as the internal source of truth for a later WordPress and WooCommerce import. The crawler still provides pages, but product discovery is no longer modeled as generic crawler output.

## Flow

1. Parse every crawled page for SEO data as before.
2. Run modular product discovery providers against the parsed document:
   - JSON-LD and Schema.org `Product`
   - Microdata product scopes
   - OpenGraph product metadata
   - Product-like HTML galleries and variant data attributes
3. Normalize each discovery into `ProductData`, preserving the legacy fields while adding WooCommerce-ready identity, pricing, inventory, SEO, media, options, and variant fields.
4. Merge discoveries by stable product identity:
   - SKU, GTIN, EAN, UPC, ISBN, or MPN
   - canonical product URL
   - normalized product title as a fallback
5. Keep variants inside `product.variants`; they are not exported as independent products.
6. Preserve media order in `product.media` and mirror image URLs in the legacy `product.images` array.
7. Export canonical products through the existing product and WordPress export APIs.
8. Generate a WooCommerce-compatible CSV from the canonical model without requiring a later ad-hoc transformation.

## Validation

`SeoReport.summary.productValidation` records discovery and normalization health:

- products discovered by source
- merged duplicates
- final canonical product count
- missing galleries
- duplicate products
- orphan variants

The goal is that `products.json` and `wordpress-project.json` need little or no transformation before a WooCommerce import layer consumes them.

## WooCommerce Export

The API export layer converts canonical products into WooCommerce import rows with standard column names such as `Type`, `SKU`, `Name`, `Regular price`, `Sale price`, `Categories`, `Images`, `Parent`, and `Attribute n name/value(s)`.

- Products without variants become `simple` rows.
- Products with variants become one `variable` parent row plus one `variation` row per variant.
- Gallery URLs are written to `Images` in normalized order.
- Variant rows include their own SKU, price, stock, image, parent reference, and attributes.
- SEO and source fidelity values are preserved in WooCommerce meta columns.

The ZIP export includes `woocommerce-products.csv`, and `GET /crawl/:jobId/export/woocommerce` returns the same CSV directly.
