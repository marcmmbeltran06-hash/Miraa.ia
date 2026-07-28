export interface BuilderOptions {
  inputPath: string;
  outputPath: string;
  projectName?: string;
  startDocker?: boolean;
  openBrowser?: boolean;
  visualThreshold?: number;
  sitePort?: number;
  dockerProject?: string;
  adminUser?: string;
  adminPassword?: string;
  databasePassword?: string;
  reconstructionEngine?: 'snapshot' | 'exact' | 'legacy';
}

export interface BuilderResult {
  outputPath: string;
  dockerComposePath: string;
  themePath: string;
  reportPath: string;
  pagesBuilt: number;
  productsBuilt: number;
  warnings: string[];
  dockerStarted: boolean;
  runtimeVerified: boolean;
}

export interface ImportedPackage {
  rootPath: string;
  cleanup?: () => void;
}

export interface ValidationIssue {
  code: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
}

export interface ResourceManifest {
  downloaded?: Array<{
    path: string;
    sourceUrl?: string;
    contentType?: string;
    bytes?: number;
  }>;
  referencedButNotDownloaded?: string[];
}

export interface SourcePage {
  slug: string;
  sourceUrl?: string;
  finalUrl?: string;
  title?: string;
  metaDescription?: string;
  canonical?: string;
  robots?: string;
  htmlRef?: string;
  html?: string;
  content?: string;
  headings?: { h1?: string[]; h2?: string[]; h3?: string[] };
  links?: { internal?: string[]; external?: string[]; anchors?: unknown[] };
  seo?: Record<string, unknown>;
  visual?: {
    screenshotRef?: string;
    viewport?: { width: number; height: number };
    fullPage?: boolean;
    capturedAt?: string;
    commerceCaptureStatus?: 'captured' | 'not-product' | 'blocked' | 'partial' | 'failed';
    commerceCaptureIssues?: string[];
    commerceStates?: Array<{
      name: 'product' | 'variant-selected' | 'product-added' | 'cart' | 'checkout';
      device: 'desktop' | 'mobile';
      url: string;
      screenshotRef: string;
      viewport: { width: number; height: number };
      capturedAt: string;
    }>;
  };
  components?: SourceComponent[];
  layout?: SourceLayoutSection[];
  mediaRefs?: string[];
  productRefs?: string[];
  relationships?: unknown[];
  forms?: Array<Record<string, unknown>>;
}

export interface SourceComponent {
  id?: string;
  type?: string;
  settings?: Record<string, unknown>;
  mediaRefs?: string[];
  children?: SourceComponent[];
}

export interface SourceLayoutSection {
  id?: string;
  type?: string;
  order?: number;
  columns?: number;
  blocks?: SourceLayoutBlock[];
}

export interface SourceLayoutBlock {
  id?: string;
  type?: string;
  tag?: string;
  text?: string;
  mediaRefs?: string[];
  children?: SourceLayoutBlock[];
}

export interface SourceProduct {
  id?: string;
  sourceUrl?: string;
  url?: string;
  canonical?: string;
  sku?: string;
  slug?: string;
  name?: string;
  title?: string;
  description?: string;
  descriptionHtml?: string;
  shortDescription?: string;
  price?: string;
  regularPrice?: string;
  salePrice?: string;
  currency?: string;
  stock?: string;
  stockStatus?: string;
  categories?: string[];
  tags?: string[];
  attributes?: Record<string, string>;
  options?: Record<string, string[]>;
  variants?: Array<{
    id?: string;
    sku?: string;
    price?: string;
    regularPrice?: string;
    salePrice?: string;
    stock?: string;
    stockStatus?: string;
    attributes?: Record<string, string>;
    image?: string;
  }>;
  media?: Array<{ url: string; role?: string; alt?: string; order?: number }>;
  images?: string[];
  seo?: Record<string, unknown>;
}

export interface SourceProject {
  rootPath: string;
  manifest: Record<string, unknown>;
  reconstructionManifest: Record<string, unknown>;
  wordpressIndex: Record<string, unknown>;
  pages: SourcePage[];
  products: SourceProduct[];
  wooCommerceCsv: string;
  resources: ResourceManifest;
  rawHtmlBySlug: Map<string, string>;
  optimizationPlan?: Record<string, unknown>;
}

export type ComponentStrategy = 'gutenberg' | 'pattern' | 'woocommerce' | 'html_fallback' | 'unsupported';

export interface ComponentDecision {
  sourceId: string;
  type: string;
  strategy: ComponentStrategy;
  confidence: number;
  reason: string;
}

export interface BuildContext {
  options: Required<Omit<BuilderOptions, 'projectName'>> & { projectName: string };
  source: SourceProject;
  outputPath: string;
  themePath: string;
  uploadsPath: string;
  importsPath: string;
  validationPath: string;
  warnings: string[];
  componentDecisions: ComponentDecision[];
  mediaMap: Array<{ sourceUrl?: string; sourcePath?: string; localPath?: string; wpPath?: string; role?: string }>;
  reconstructionEngine: 'snapshot' | 'exact' | 'legacy';
}
