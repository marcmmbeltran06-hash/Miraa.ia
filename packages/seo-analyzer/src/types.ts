export type SeoIssueSeverity = 'critical' | 'warning' | 'info';

// ==== New Model Interfaces ====
export interface SectionModel {
  id: string;
  type: string; // e.g., 'section', 'article', 'main', etc.
  source?: string;
  confidence?: number;
  components: string[]; // component IDs belonging to this section
  children?: SectionModel[];
}

export interface ColumnModel {
  id: string;
  parentSectionId: string;
  source?: string;
  confidence?: number;
  components: string[];
}

export interface UnsupportedDiscovery {
  type: string; // what kind of element couldn't be modeled
  location: string; // CSS selector or description of where it was found
  source: string; // e.g., 'html', 'json-ld', 'open-graph'
  reason: string; // why it couldn't be modeled
}

export interface BlogModel {
  // Placeholder for blog entries, expand as needed
}

export interface SeoIssue {
  code: string;
  severity: SeoIssueSeverity;
  message: string;
  pageUrl?: string;
  meta?: Record<string, string | number | boolean>;
}

export interface SeoAnalyzerOptions {
  maxUrlLength?: number;
  maxImageBytes?: number;
  minTitleLength?: number;
  maxTitleLength?: number;
  minDescriptionLength?: number;
  maxDescriptionLength?: number;
}

export interface SeoAnalyzerInputPage {
  url: string;
  finalUrl: string;
  statusCode: number;
  html: string;
  depth: number;
  responseTimeMs?: number;
  htmlSizeBytes?: number;
  imageByteSizeByUrl?: Record<string, number>;
  securityHeaders?: Record<string, string>;
  /** Full visible body text content extracted during crawl */
  pageContent?: string;
  /** Computed CSS styles for layout sections (extracted at crawl time via getComputedStyle) */
  computedStyles?: Array<{ selector: string; styles: Record<string, string> }>;
  /** Full-page visual reference captured during crawl for offline reconstruction validation */
  screenshot?: PageScreenshotData;
}

export interface SeoAnalyzerInput {
  entryUrl: string;
  pages: SeoAnalyzerInputPage[];
  options?: SeoAnalyzerOptions;
}

export interface PageHeadingData {
  h1: string[];
  h2: string[];
  h3: string[];
}

export interface OpenGraphData {
  title?: string;
  description?: string;
  image?: string;
  url?: string;
  type?: string;
}

export interface TwitterCardData {
  card?: string;
  title?: string;
  description?: string;
  image?: string;
}

export interface AnchorTextData {
  href: string;
  text: string;
  external: boolean;
}

export interface ImageData {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
  bytes?: number;
}

export interface ProductMediaData {
  url: string;
  originalUrl: string;
  filename?: string;
  alt?: string;
  caption?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  order: number;
  role?: 'featured' | 'gallery' | 'variant' | 'video' | 'download' | 'document';
  variantKey?: string;
}

export interface ProductVariantData {
  id?: string;
  sku?: string;
  price?: string;
  salePrice?: string;
  regularPrice?: string;
  compareAtPrice?: string;
  stock?: string;
  stockStatus?: string;
  manageStock?: boolean;
  backorders?: string;
  availability?: string;
  barcode?: string;
  weight?: string;
  dimensions?: Record<string, string>;
  attributes: Record<string, string>;
  image?: string;
  url?: string;
}

export interface ProductDiscoveryStats {
  jsonLd: number;
  microdata: number;
  openGraph: number;
  html: number;
  api: number;
}

export interface ProductValidationStats {
  discoveredProducts: number;
  productsBySource: ProductDiscoveryStats;
  mergedDuplicates: number;
  finalProducts: number;
  completeProducts: number;
  incompleteProducts: number;
  discardedProducts: number;
  imagesFound: number;
  imagesLost: number;
  variantsFound: number;
  variantsLost: number;
  reconstructedFields: string[];
  unobtainableFields: string[];
  missingGalleries: number;
  duplicateProducts: number;
  orphanVariants: number;
}

export interface ProductData {
  id?: string;
  sourceUrl: string;
  url?: string;
  relationships?: ProductRelationships;
  canonical?: string;
  slug?: string;
  handle?: string;
  title?: string;
  name?: string;
  price?: string;
  regularPrice?: string;
  salePrice?: string;
  compareAtPrice?: string;
  currency?: string;
  taxStatus?: string;
  taxClass?: string;
  discounts?: string[];
  description?: string;
  descriptionHtml?: string;
  renderedText?: string;
  shortDescription?: string;
  excerpt?: string;
  images?: string[];
  media?: ProductMediaData[];
  sku?: string;
  gtin?: string;
  ean?: string;
  upc?: string;
  isbn?: string;
  mpn?: string;
  brand?: string;
  manufacturer?: string;
  vendor?: string;
  stock?: string;
  stockStatus?: string;
  manageStock?: boolean;
  availability?: string;
  preorder?: boolean;
  backorder?: boolean;
  backorders?: string;
  categories?: string[];
  parentCategories?: string[];
  collections?: string[];
  tags?: string[];
  breadcrumbs?: string[];
  seo?: {
    title?: string;
    description?: string;
    canonical?: string;
    robots?: string;
    openGraph?: OpenGraphData;
    twitter?: TwitterCardData;
    jsonLd?: unknown[];
    schemaTypes?: string[];
  };
  faqs?: unknown[];
  reviews?: unknown[];
  ingredients?: string[];
  discoverySources?: string[];
  attributes?: Record<string, string>;
  variants: ProductVariantData[];
  downloads?: ProductMediaData[];
  options?: Record<string, string[]>;
}

export interface ProductRelationships {
  bundles?: string[];
  upsells?: string[];
  recommended?: string[];
  crossSells?: string[];
  related?: string[];
  [key: string]: string[] | undefined;
}

export interface PageScreenshotData {
  contentType: 'image/png';
  dataBase64: string;
  viewport?: { width: number; height: number };
  fullPage: boolean;
  capturedAt: string;
  /** Representative, non-destructive ecommerce states captured from the source. */
  commerceStates?: Array<{
    name: 'product' | 'variant-selected' | 'product-added' | 'cart' | 'checkout';
    device: 'desktop' | 'mobile';
    url: string;
    contentType: 'image/png';
    dataBase64: string;
    viewport: { width: number; height: number };
    capturedAt: string;
  }>;
  commerceCaptureStatus?: 'captured' | 'not-product' | 'blocked' | 'partial' | 'failed';
  commerceCaptureIssues?: string[];
}

export interface SeoPageReport {
  url: string;
  finalUrl: string;
  statusCode: number;
  depth: number;
  responseTimeMs?: number;
  htmlSizeBytes: number;
  title?: string;
  metaDescription?: string;
  canonical?: string;
  robots?: string;
  headings: PageHeadingData;
  openGraph: OpenGraphData;
  twitter: TwitterCardData;
  jsonLd: unknown[];
  structuredDataTypes: string[];
  internalLinks: string[];
  externalLinks: string[];
  brokenLinks: string[];
  anchorTexts: AnchorTextData[];
  images: ImageData[];
  redirectsTo?: string;
  imagesWithoutAlt: string[];
  heavyImages: string[];
  wordCount: number;
  thinContent: boolean;
  indexability: 'indexable' | 'noindex' | 'blocked' | 'error';
  noindex: boolean;
  nofollow: boolean;
  securityHeaders: Record<string, string>;
  products: ProductData[];
  siteModel?: CanonicalPageModel;
  issues: SeoIssue[];
  /** Full visible body text content (for WordPress post content reconstruction) */
  pageContent?: string;
  /** Full raw HTML of the page (for components that cannot be modeled) */
  pageHtml?: string;
  /** Computed CSS styles for layout sections (extracted at crawl time via getComputedStyle) */
  computedStyles?: Array<{ selector: string; styles: Record<string, string> }>;
  /** Full-page visual reference captured during crawl for offline reconstruction validation */
  screenshot?: PageScreenshotData;
}

export interface DuplicateValueGroup {
  value: string;
  urls: string[];
}

export interface SeoSummary {
  totalPages: number;
  redirects: number;
  brokenLinks: number;
  pagesWithoutTitle: number;
  pagesWithoutDescription: number;
  duplicateTitles: DuplicateValueGroup[];
  duplicateDescriptions: DuplicateValueGroup[];
  noindexPages: number;
  thinContentPages: number;
  totalProducts: number;
  productValidation: ProductValidationStats;
}

export interface SeoReport {
  score: number;
  criticalErrors: SeoIssue[];
  warnings: SeoIssue[];
  info: SeoIssue[];
  summary: SeoSummary;
  pages: SeoPageReport[];
  siteModel?: CanonicalSiteModel;
}

export interface SeoAnalyzer {
  analyze(input: SeoAnalyzerInput): SeoReport;
}

export interface ConfidenceDetection {
  name: string;
  confidence: number;
  evidence: string[];
  version?: string;
}

// Generic wrapper for any extracted field, including source and confidence
export interface FieldValue<T> {
  value: T;
  source: 'dom' | 'jsonld' | 'microdata' | 'opengraph' | 'css' | 'script' | 'framework';
  confidence: number; // 0‑1 confidence score
}

// Simplified component classification used by the extractor
export type ComponentType =
  | 'container'
  | 'section'
  | 'column'
  | 'heading'
  | 'paragraph'
  | 'button'
  | 'image'
  | 'gallery'
  | 'carousel'
  | 'video'
  | 'icon'
  | 'list'
  | 'navigation'
  | 'form'
  | 'accordion'
  | 'tabs'
  | 'table'
  | 'unknown';

export interface PlatformModel {
  primary?: ConfidenceDetection;
  detected: ConfidenceDetection[];
  sourceTechnologyIndependent: true;
}

export interface ThemeModel {
  active?: string;
  child?: string;
  framework?: string;
  type?: 'block' | 'classic' | 'unknown';
  themeJson?: unknown;
  confidence: number;
  evidence: string[];
}

export interface BuilderModel {
  primary?: ConfidenceDetection;
  secondary: ConfidenceDetection[];
}

export interface HeaderModel {
  logoRefs: string[];
  navigationRefs: string[];
  hasSearch: boolean;
  hasCart: boolean;
  hasWishlist: boolean;
  hasLogin: boolean;
  ctaTexts: string[];
  iconRefs: string[];
  sticky: boolean;
  transparent: boolean;
  heights: string[];
  layout: string[];
}

export interface FooterModel {
  columns: number;
  widgetRefs: string[];
  linkRefs: string[];
  copyright?: string;
  socialRefs: string[];
  logoRefs: string[];
  newsletterRefs: string[];
}

export interface NavigationItemModel {
  id: string;
  label: string;
  href?: string;
  children: NavigationItemModel[];
}

export interface NavigationMenuModel {
  id: string;
  name: string;
  position: 'primary' | 'secondary' | 'footer' | 'mobile' | 'breadcrumbs' | 'unknown';
  items: NavigationItemModel[];
}

export interface GlobalStyleModel {
  colors: string[];
  gradients: string[];
  fonts: string[];
  fontSizes: string[];
  fontWeights: string[];
  spacings: string[];
  radii: string[];
  shadows: string[];
  cssVariables: Record<string, string>;
  globalCssRefs: string[];
  themeJson?: unknown;
}

export interface StyleBlock {
  display?: string;
  layout?: 'flex' | 'grid';
  width?: string;
  height?: string;
  gap?: string;
  padding?: string;
  margin?: string;
  alignment?: string;
  order?: number;
  background?: string;
  borderRadius?: string;
  zIndex?: string;
  responsiveHints?: Record<string, unknown>;
}

export interface LayoutBlockModel {
  id: string;
  type: string;
  tag?: string;
  text?: string;
  mediaRefs: string[];
  widgetRefs: string[];
  componentRefs: string[];
  children: LayoutBlockModel[];
}

export interface LayoutSectionModel {
  id: string;
  type: string;
  order: number;
  columns: number;
  blocks: LayoutBlockModel[];
}

export interface ComponentModel {
  id: string; // stable deterministic identifier
  type: ComponentType;
  provider?: string;
  confidence: FieldValue<number>; // confidence in detection of this component
  settings: Record<string, string | number | boolean | string[]>;
  mediaRefs: string[];
  // enriched content (optional)
  texts?: FieldValue<string[]>;
  buttons?: FieldValue<string[]>;
  images?: FieldValue<string[]>;
  icons?: FieldValue<string[]>;
  links?: FieldValue<string[]>;
  children?: ComponentModel[];
  styles?: FieldValue<StyleBlock>;
}

export interface PluginModel extends ConfidenceDetection {}

export interface FormFieldModel {
  name?: string;
  label?: string;
  type: string;
  required: boolean;
  validation?: string;
}

export interface FormModel {
  id: string;
  provider?: string;
  fields: FormFieldModel[];
  actions: string[];
}

export interface WidgetModel {
  id: string;
  type: string;
  title?: string;
  text?: string;
  mediaRefs: string[];
}

export interface WordPressConfigurationModel {
  language?: string;
  timezone?: string;
  dateFormat?: string;
  timeFormat?: string;
  permalinkPattern?: string;
  frontPageRef?: string;
  blogPageRef?: string;
  shopPageRef?: string;
  cartPageRef?: string;
  checkoutPageRef?: string;
  accountPageRef?: string;
}

export interface SiteMediaModel {
  id: string;
  url: string;
  type: 'logo' | 'favicon' | 'image' | 'video' | 'background' | 'svg' | 'icon' | 'document';
  alt?: string;
  sourcePageUrl?: string;
}

export interface GlobalSeoModel {
  schemaTypes: string[];
  schema: unknown[];
  organization?: unknown;
  localBusiness?: unknown;
  breadcrumbs: NavigationMenuModel[];
  robots: string[];
  sitemaps: string[];
  feeds: string[];
}

export interface RelationshipModel {
  from: string;
  to: string;
  type: string;
}

export interface CanonicalPageModel {
  id: string;
  sourceUrl: string;
  finalUrl: string;
  title?: string;
  slug: string;
  layout: LayoutSectionModel[];
  components: ComponentModel[];
  forms: FormModel[];
  widgets: WidgetModel[];
  mediaRefs: string[];
  productRefs: string[];
  relationships: RelationshipModel[];
}

export interface CanonicalSiteModel {
  sections?: SectionModel[];
  columns?: ColumnModel[];
  blog?: BlogModel[]; // optional blog entries // optional blog entries
  artifactName: 'wordpress-project.json';
  modelKind: 'canonical-site-model';
  version: '1.0';
  canonicalModelVersion: '2.0'; // model versioning
  targetHint: 'wordpress';
  // Extractor versioning and metadata
  extractorVersion: string; // e.g., '1.0.0'
  generatedAt: string; // ISO timestamp when the model was generated
  generatorCompatibility: {
    wordpress: string; // e.g., '>=1.0'
    shopify?: string | null;
    prestashop?: string | null;
  };
  // Record any features that could not be modeled
  unsupportedDiscoveries?: UnsupportedDiscovery[];
  platform: PlatformModel;
  theme: ThemeModel;
  builder: BuilderModel;
  header: HeaderModel;
  footer: FooterModel;
  navigation: NavigationMenuModel[];
  globalStyles: GlobalStyleModel;
  pages: CanonicalPageModel[];
  components: ComponentModel[];
  plugins: PluginModel[];
  forms: FormModel[];
  widgets: WidgetModel[];
  wordpressConfiguration: WordPressConfigurationModel;
  media: SiteMediaModel[];
  seo: GlobalSeoModel;
  relationships: RelationshipModel[];
}
