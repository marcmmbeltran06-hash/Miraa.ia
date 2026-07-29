import { Buffer } from 'node:buffer';
import { deflateRawSync } from 'node:zlib';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ProductData, ProductMediaData, SeoPageReport, SeoReport } from '@autowp/seo-analyzer';
import { createSafeOptimizationPlan, mergeProducts } from '@autowp/seo-analyzer';
import { generateUniversalTryOnSample, selectTryOnCandidate } from './tryon/UniversalTryOnSample.js';

export type ExportFormat = 'json' | 'csv' | 'html' | 'pdf' | 'zip' | 'woocommerce' | 'mira';

export interface ExportArtifact {
  filename: string;
  contentType: string;
  body?: string | Buffer;
  filePath?: string;
}

export type ExportStatus = 'ok' | 'failed';
export type ExportStatusMap = Record<string, ExportStatus>;

export interface FileEntry {
  name: string;
  content: Buffer;
  sourceUrl?: string;
  contentType?: string;
  bytes?: number;
}

export interface ExportError {
  exportName: string;
  error: string;
}

const EXPORT_DIR = 'auditoria';

/* ------------------------------------------------------------------ */
/*  Public API: run all exports independently                          */
/* ------------------------------------------------------------------ */

export interface StabilityEval {
  verdict: string;
  reason?: string;
  stableWindows: number;
  criteria: Record<string, boolean>;
  justification: string;
}

export interface CrawlDiagnostics {
  crawlDiagnostics: Record<string, unknown>;
  knowledgeDiagnostics: {
    totalPages: number;
    totalProducts: number;
    urlCategories: Record<string, string>;
    pageDuplicateCounts: Record<string, number>;
    pageVisitedDuplicateCounts: Record<string, number>;
    patternCounts: Record<string, number>;
    terminationReason: string | undefined;
    pendingUrlsAtEnd: string[];
    [key: string]: unknown;
  };
  schedulerDiagnostics: {
    evolution: { timestamp: number; frontier: number; queue: number }[];
    stabilityHistory: StabilityEval[];
    maxMemory: { heapUsed: number; heapTotal: number; rss: number; external: number };
    [key: string]: unknown;
  };
}

export interface ExportRunResult {
  status: ExportStatusMap;
  errors: ExportError[];
}

/**
 * Run all exports independently. The job directory is created immediately.
 * Each export is wrapped in try/catch — a failure never blocks the others.
 * Errors are collected and written to export-errors.json.
 */
export async function runAllExports(
  report: SeoReport,
  jobId: string,
  diagnostics?: CrawlDiagnostics,
  mediaFiles: FileEntry[] = [],
  previewOnly = false,
): Promise<ExportRunResult> {
  // An empty SEO report is never a successful capture. Older crawler paths
  // could incorrectly assign score 100 to an empty result, which then reached
  // the builder and failed much later with an opaque manifest error.
  if (report.pages.length === 0) {
    report = {
      ...report,
      score: 0,
      criticalErrors: [...report.criticalErrors, { code: 'EMPTY_CAPTURE_EXPORT', severity: 'critical', message: 'No pages were captured; export must be retried after resolving the crawl block.' }],
      warnings: [...report.warnings, { code: 'EMPTY_CAPTURE_EXPORT', severity: 'warning', message: 'The crawl returned zero pages. WordPress reconstruction is unavailable until a page is captured.' }],
      summary: { ...report.summary, totalPages: 0 },
    };
  }
  const jobDir = path.join(EXPORT_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  console.log(`[Export] Job directory: ${jobDir}`);

  const status: ExportStatusMap = {};
  const errors: ExportError[] = [];

  // Preview mode deliberately writes only the local replay payload. WordPress,
  // WooCommerce, legacy formats and ZIP are opt-in at the final deployment step.
  await runOne('manifest', () => writeManifest(jobDir, report, jobId), status, errors);
  if (!previewOnly) {
    await runOne('json', () => writeJsonExport(jobDir, report), status, errors);
    await runOne('csv', () => writeCsvToFile(jobDir, report), status, errors);
    await runOne('html', () => writeHtmlToFile(jobDir, report), status, errors);
    await runOne('professional-pdf', () => writeProfessionalPdf(jobDir), status, errors);
    await runOne('products', () => writeProductsJson(jobDir, report), status, errors);
    await runOne('tryon-sample', () => generateUniversalTryOnSample(jobDir, report), status, errors);
    await runOne('woocommerce', () => writeWooCommerceCsv(jobDir, report), status, errors);
    await runOne('wordpress', () => writeWordPressFiles(jobDir, report), status, errors);
  }

  // Full-fidelity reconstruction files are required by the local replay.
  await runOne('reconstruction', () => writeReconstructionFiles(jobDir, report), status, errors);

  // This is a review-only plan. No proposal is applied to WordPress or to the
  // source site until the user explicitly approves it in the generated editor.
  await runOne('optimization-plan', () => writeOptimizationPlan(jobDir, report), status, errors);

  // 9. downloaded resources
  await runOne('resources', () => writeResourceFiles(jobDir, mediaFiles, report), status, errors);

  // 10. diagnostics (if available)
  if (diagnostics) {
    await runOne('diagnostics', () => writeDiagnostics(jobDir, diagnostics), status, errors);
  }

  if (!previewOnly) await runOne('zip', () => createZipFromDir(jobDir, jobId), status, errors);

  // Write export-errors.json if any failures
  if (errors.length > 0) {
    const errorBody = JSON.stringify({ errors: errors.map(e => ({ export: e.exportName, error: e.error })) }, null, 2);
    fs.writeFileSync(path.join(jobDir, 'export-errors.json'), errorBody, 'utf-8');
    console.log(`[Export] ${errors.length} export(s) failed — written to export-errors.json`);
  }

  return { status, errors };
}

async function runOne(
  name: string,
  fn: () => Promise<void> | void,
  status: ExportStatusMap,
  errors: ExportError[],
): Promise<void> {
  console.log(`[Export] Writing ${name}...`);
  try {
    await fn();
    console.log(`[Export] ${name} OK`);
    status[name] = 'ok';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Export] ${name} failed — reason: ${msg}`);
    console.error(`[Export] Continuing...`);
    status[name] = 'failed';
    errors.push({ exportName: name, error: msg });
  }
}

/* ------------------------------------------------------------------ */
/*  1. Manifest                                                        */
/* ------------------------------------------------------------------ */

function writeManifest(jobDir: string, report: SeoReport, jobId: string): void {
  const productCount = report.summary.totalProducts ?? 0;
  const business = {
    is_tienda: productCount > 0,
    confidence: productCount > 0 ? 1 : 0,
    signals: productCount > 0 ? ['productos detectados'] : [],
    productCount,
    generatedAt: new Date().toISOString(),
  };
  const manifest = {
    jobId,
    generatedAt: new Date().toISOString(),
    score: report.score,
    totalPages: report.summary.totalPages,
    totalProducts: report.summary.totalProducts,
    criticalErrors: report.criticalErrors.length,
    warnings: report.warnings.length,
    is_tienda: business.is_tienda,
    businessClassification: business,
  };
  writeFile(jobDir, 'manifest.json', JSON.stringify(manifest, null, 2));
}

/* ------------------------------------------------------------------ */
/*  2. JSON export                                                     */
/* ------------------------------------------------------------------ */

export function writeJsonExport(jobDir: string, report: SeoReport): void {
  /*
   * Do not stringify the complete report in one JavaScript string. Large shops
   * can exceed V8's maximum string length even though the resulting file is a
   * perfectly valid JSON document. Stream each page to an atomic temporary
   * file so this export works for hundreds or thousands of pages.
   */
  fs.mkdirSync(jobDir, { recursive: true });
  const destination = path.join(jobDir, 'seo-report.json');
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const handle = fs.openSync(temporary, 'w');
  const { pages, ...header } = report;
  try {
    fs.writeSync(handle, `${JSON.stringify(header, null, 2).replace(/\n}$/, '')},\n  "pages": [\n`);
    pages.forEach((page, index) => {
      const lightPage = {
        ...page,
        pageContent: undefined,
        pageHtml: undefined,
        screenshot: undefined,
        computedStyles: undefined,
      };
      const serialized = JSON.stringify(lightPage, null, 2)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');
      fs.writeSync(handle, `${index > 0 ? ',\n' : ''}${serialized}`);
    });
    fs.writeSync(handle, '\n  ]\n}\n');
    fs.fsyncSync(handle);
  } catch (error) {
    fs.closeSync(handle);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.closeSync(handle);
  try {
    fs.renameSync(temporary, destination);
  } catch {
    fs.copyFileSync(temporary, destination);
    fs.rmSync(temporary, { force: true });
  }
}

/** Retry only the JSON artifact without repeating crawl or other exports. */
export function retryJsonExport(jobId: string, report: SeoReport): void {
  const jobDir = path.join(EXPORT_DIR, jobId);
  writeJsonExport(jobDir, report);
  const errorsPath = path.join(jobDir, 'export-errors.json');
  if (!fs.existsSync(errorsPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(errorsPath, 'utf8')) as {
      errors?: Array<{ export?: string; error?: string }>;
    };
    const remaining = (parsed.errors ?? []).filter((entry) => entry.export !== 'json');
    if (remaining.length === 0) fs.rmSync(errorsPath, { force: true });
    else fs.writeFileSync(errorsPath, JSON.stringify({ errors: remaining }, null, 2), 'utf8');
  } catch {
    // A corrupt error report must not invalidate the successfully written JSON.
  }
}

/* ------------------------------------------------------------------ */
/*  3. CSV export                                                      */
/* ------------------------------------------------------------------ */

function writeCsvToFile(jobDir: string, report: SeoReport): void {
  writeFile(jobDir, 'seo-pages.csv', toCsv(report));
}

/* ------------------------------------------------------------------ */
/*  4. HTML export                                                     */
/* ------------------------------------------------------------------ */

function writeHtmlToFile(jobDir: string, report: SeoReport): void {
  writeFile(jobDir, 'seo-report.html', toProfessionalHtml(report));
}

function writeProfessionalPdf(jobDir: string): void {
  const scriptCandidates = [
    path.resolve('scripts', 'generate_professional_seo_cro_report.py'),
    path.resolve('..', '..', 'scripts', 'generate_professional_seo_cro_report.py'),
  ];
  const script = scriptCandidates.find((candidate) => fs.existsSync(candidate));
  const input = path.join(jobDir, 'seo-report.json');
  const output = path.join(jobDir, 'informe-seo-cro-profesional.pdf');
  if (!script || !fs.existsSync(input)) throw new Error('Professional report generator or source report is missing.');
  const candidates = [
    process.env.AUTOWP_PYTHON,
    process.platform === 'win32' ? 'python' : 'python3',
    'python',
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
  const failures: string[] = [];
  for (const executable of candidates) {
    const result = spawnSync(executable, [script, input, output], { encoding: 'utf8', windowsHide: true });
    if (result.status === 0 && fs.existsSync(output)) return;
    failures.push(`${executable}: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`);
  }
  throw new Error(`Professional PDF could not be generated. ${failures.join(' | ')}`);
}

/* ------------------------------------------------------------------ */
/*  5. Products JSON                                                   */
/* ------------------------------------------------------------------ */

function writeProductsJson(jobDir: string, report: SeoReport): void {
  writeFile(jobDir, 'products.json', JSON.stringify(extractProducts(report), null, 2));
}

/* ------------------------------------------------------------------ */
/*  6. WooCommerce CSV                                                 */
/* ------------------------------------------------------------------ */

function writeWooCommerceCsv(jobDir: string, report: SeoReport): void {
  writeFile(jobDir, 'woocommerce-products.csv', toWooCommerceCsv(extractProducts(report)));
}

function writeOptimizationPlan(jobDir: string, report: SeoReport): void {
  const body = JSON.stringify(createSafeOptimizationPlan(report), null, 2);
  writeFile(jobDir, 'optimization-plan.json', body);
  fs.mkdirSync(path.join(jobDir, 'wordpress'), { recursive: true });
  writeFile(path.join(jobDir, 'wordpress'), 'optimization-plan.json', body);
}

/* ------------------------------------------------------------------ */
/*  7. WordPress files (modular)                                       */
/* ------------------------------------------------------------------ */

function writeWordPressFiles(jobDir: string, report: SeoReport): void {
  const wpDir = path.join(jobDir, 'wordpress', 'pages');
  fs.mkdirSync(wpDir, { recursive: true });
  fs.mkdirSync(path.join(jobDir, 'visual', 'pages'), { recursive: true });

  const products = extractProducts(report);
  const allCategories = [...new Set(products.flatMap((product) => product.categories))];

  // index.json
  const index = {
    generatedAt: new Date().toISOString(),
    artifactName: 'wordpress-project',
    modelKind: 'canonical-site-model',
    targetHint: 'wordpress',
    score: report.score,
    platform: report.siteModel?.platform ?? { detected: [], sourceTechnologyIndependent: true },
    theme: report.siteModel?.theme ?? { type: 'unknown', confidence: 0, evidence: [] },
    builder: report.siteModel?.builder ?? { secondary: [] },
    header: report.siteModel?.header ?? {},
    footer: report.siteModel?.footer ?? {},
    navigation: report.siteModel?.navigation ?? [],
    globalStyles: report.siteModel?.globalStyles ?? {},
    components: report.siteModel?.components ?? [],
    plugins: report.siteModel?.plugins ?? [],
    forms: report.siteModel?.forms ?? [],
    widgets: report.siteModel?.widgets ?? [],
    wordpressConfiguration: report.siteModel?.wordpressConfiguration ?? {},
    media: report.siteModel?.media ?? [],
    seo: report.siteModel?.seo ?? {},
    relationships: report.siteModel?.relationships ?? [],
    pages: report.pages.map((page) => {
      const slug = pageSlug(page);
      return { slug, sourceUrl: page.url, title: page.title ?? page.headings.h1[0] ?? slug };
    }),
    menus: [{
      name: 'Primary',
      items: report.pages.slice(0, 20).map((page) => ({ title: page.title ?? pageSlug(page), slug: pageSlug(page) })),
    }],
    categories: allCategories,
    productValidation: report.summary.productValidation,
    seoConfiguration: {
      duplicateTitles: report.summary.duplicateTitles,
      duplicateDescriptions: report.summary.duplicateDescriptions,
      defaultIndexability: 'indexable',
    },
  };
  writeFile(path.join(jobDir, 'wordpress'), 'index.json', JSON.stringify(index, null, 2));

  // Per-page files
  for (const page of report.pages) {
    const slug = pageSlug(page);
    const pageModel = page.siteModel ?? {
      id: `page:${slug}`,
      sourceUrl: page.url,
      finalUrl: page.finalUrl,
      title: page.title,
      slug,
      layout: [],
      components: [],
      forms: [],
      widgets: [],
      mediaRefs: page.images.map((image) => `media:${image.src}`),
      productRefs: page.products.map((product) => `product:${product.id ?? product.sku ?? product.url ?? product.name ?? 'product'}`),
      relationships: [],
    };

    const pageFile = {
      slug,
      sourceUrl: page.url,
      title: page.title ?? page.headings.h1[0] ?? slug,
      metaDescription: page.metaDescription ?? '',
      canonical: page.canonical ?? page.finalUrl,
      headings: page.headings,
      images: page.images,
      links: { internal: page.internalLinks, external: page.externalLinks },
      seo: {
        indexability: page.indexability,
        robots: page.robots ?? '',
        issues: page.issues,
        structuredDataTypes: page.structuredDataTypes,
      },
      modelRef: pageModel.id,
      layout: pageModel.layout,
      components: pageModel.components,
      forms: pageModel.forms,
      widgets: pageModel.widgets,
      mediaRefs: pageModel.mediaRefs,
      productRefs: pageModel.productRefs,
      relationships: pageModel.relationships,
      content: page.pageContent,
      htmlRef: `../../raw/pages/${slug}.html`,
      computedStyles: page.computedStyles,
      visual: page.screenshot ? {
        screenshotRef: `../../visual/pages/${slug}.png`,
        contentType: page.screenshot.contentType,
        viewport: page.screenshot.viewport,
        fullPage: page.screenshot.fullPage,
        capturedAt: page.screenshot.capturedAt,
      } : undefined,
    };
    writeFile(wpDir, `${slug}.json`, JSON.stringify(pageFile, null, 2));
    writeScreenshotFile(jobDir, slug, page.screenshot?.dataBase64);
  }

  // products.json
  writeFile(path.join(jobDir, 'wordpress'), 'products.json', JSON.stringify(products, null, 2));
  writeFile(path.join(jobDir, 'wordpress'), 'woocommerce-products.csv', toWooCommerceCsv(products));
}

/* ------------------------------------------------------------------ */
/*  8. Reconstruction payload                                          */
/* ------------------------------------------------------------------ */

function writeReconstructionFiles(jobDir: string, report: SeoReport): void {
  const rawPageDir = path.join(jobDir, 'raw', 'pages');
  const modelPageDir = path.join(jobDir, 'model', 'pages');
  fs.mkdirSync(rawPageDir, { recursive: true });
  fs.mkdirSync(modelPageDir, { recursive: true });
  fs.mkdirSync(path.join(jobDir, 'visual', 'pages'), { recursive: true });

  const pageManifest = report.pages.map((page) => {
    const slug = pageSlug(page);
    const head = extractHeadSnapshot(page.pageHtml ?? '');
    const commerceStateRefs = writeCommerceStateFiles(jobDir, slug, page.screenshot?.commerceStates);
    const model = {
      slug,
      sourceUrl: page.url,
      finalUrl: page.finalUrl,
      statusCode: page.statusCode,
      depth: page.depth,
      title: page.title,
      metaDescription: page.metaDescription,
      canonical: page.canonical,
      robots: page.robots,
      openGraph: page.openGraph,
      twitter: page.twitter,
      jsonLd: page.jsonLd,
      structuredDataTypes: page.structuredDataTypes,
      headings: page.headings,
      visibleText: page.pageContent,
      hiddenText: extractHiddenText(page.pageHtml ?? ''),
      dom: {
        htmlRef: `../../raw/pages/${slug}.html`,
        headHtml: head.headHtml,
        bodyClasses: head.bodyClasses,
        htmlAttributes: head.htmlAttributes,
        bodyAttributes: head.bodyAttributes,
      },
      links: {
        internal: page.internalLinks,
        external: page.externalLinks,
        anchors: page.anchorTexts,
      },
      media: {
        images: page.images,
        heavyImages: page.heavyImages,
        missingAlt: page.imagesWithoutAlt,
      },
      commerce: {
        products: page.products,
        productRefs: page.siteModel?.productRefs ?? [],
      },
      design: {
        computedStyles: page.computedStyles ?? [],
        layout: page.siteModel?.layout ?? [],
        components: page.siteModel?.components ?? [],
        forms: page.siteModel?.forms ?? [],
        widgets: page.siteModel?.widgets ?? [],
      },
      visual: page.screenshot ? {
        screenshotRef: `../../visual/pages/${slug}.png`,
        contentType: page.screenshot.contentType,
        viewport: page.screenshot.viewport,
        fullPage: page.screenshot.fullPage,
        capturedAt: page.screenshot.capturedAt,
        commerceCaptureStatus: page.screenshot.commerceCaptureStatus,
        commerceCaptureIssues: page.screenshot.commerceCaptureIssues ?? [],
        commerceStates: commerceStateRefs,
      } : undefined,
      seo: {
        indexability: page.indexability,
        noindex: page.noindex,
        nofollow: page.nofollow,
        issues: page.issues,
      },
    };

    writeFile(modelPageDir, `${slug}.json`, JSON.stringify(model, null, 2));
    writeFile(rawPageDir, `${slug}.html`, page.pageHtml ?? '');
    writeScreenshotFile(jobDir, slug, page.screenshot?.dataBase64);
    return {
      slug,
      sourceUrl: page.url,
      finalUrl: page.finalUrl,
      model: `model/pages/${slug}.json`,
      html: `raw/pages/${slug}.html`,
      screenshot: page.screenshot ? `visual/pages/${slug}.png` : undefined,
    };
  });

  const reconstruction = {
    generatedAt: new Date().toISOString(),
    purpose: 'offline-wordpress-woocommerce-reconstruction',
    phase1Status: 'technically-closed',
    sufficiencyStatus: 'pending-builder-validation',
    sufficiencyNote:
      'The export is designed to be the only source of truth for Phase 2. ' +
      'Its definitive sufficiency is validated when the WordPress builder reconstructs real sites ' +
      'without returning to the original source website.',
    guarantees: [
      'raw HTML is preserved per crawled page',
      'canonical page, product, SEO, navigation, component and design models are preserved',
      'offline visual references are preserved when the browser can capture them',
      'downloaded resources are included when fetchable',
      'unfetchable resources remain referenced by original URL for fallback',
    ],
    pages: pageManifest,
    productsRef: 'products.json',
    wordpressIndexRef: 'wordpress/index.json',
    resourcesRef: 'resources/manifest.json',
    visualRefs: pageManifest.flatMap((page) => page.screenshot ? [page.screenshot] : []),
  };
  writeFile(jobDir, 'reconstruction-manifest.json', JSON.stringify(reconstruction, null, 2));
}

/* ------------------------------------------------------------------ */
/*  8. Diagnostics                                                     */
/* ------------------------------------------------------------------ */

function writeDiagnostics(jobDir: string, diag: CrawlDiagnostics): void {
  writeFile(jobDir, 'crawl-diagnostics.json', JSON.stringify(diag.crawlDiagnostics, null, 2));
  writeFile(jobDir, 'knowledge-diagnostics.json', JSON.stringify(diag.knowledgeDiagnostics, null, 2));
  writeFile(jobDir, 'scheduler-diagnostics.json', JSON.stringify(diag.schedulerDiagnostics, null, 2));
}

/* ------------------------------------------------------------------ */
/*  9. ZIP creation                                                    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  9. Resource files                                                  */
/* ------------------------------------------------------------------ */

async function writeResourceFiles(jobDir: string, mediaFiles: FileEntry[], report: SeoReport): Promise<void> {
  const resourceDir = path.join(jobDir, 'resources');
  fs.mkdirSync(resourceDir, { recursive: true });
  const writtenFiles = [...mediaFiles];
  for (const file of mediaFiles) {
    const safeRelative = safeZipPath(file.name).replace(/^resources\//, '');
    const fullPath = path.join(resourceDir, safeRelative);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.content);
  }

  const referencedUrls = new Set(collectResourceUrls(report));
  const downloaded = new Set(writtenFiles.map((file) => file.sourceUrl).filter(Boolean));
  const remainingUrls = [...referencedUrls].filter((url) => !downloaded.has(url));
  const streamed = await downloadResourcesToDir(remainingUrls, resourceDir);
  writtenFiles.push(...streamed);
  streamed.forEach((file) => {
    if (file.sourceUrl) downloaded.add(file.sourceUrl);
  });

  // Stylesheets frequently reference the resources that actually determine
  // visual fidelity (fonts, background images, imported component CSS). Those
  // URLs do not necessarily occur in the HTML, so close the CSS dependency
  // graph recursively instead of stopping after the first download pass.
  const maxDependencyPasses = 5;
  const maxResources = 20_000;
  for (let pass = 0; pass < maxDependencyPasses && referencedUrls.size < maxResources; pass += 1) {
    const nested = collectDownloadedCssDependencies(writtenFiles, resourceDir)
      .filter((url) => !referencedUrls.has(url) && !downloaded.has(url))
      .slice(0, maxResources - referencedUrls.size);
    if (nested.length === 0) break;
    nested.forEach((url) => referencedUrls.add(url));
    const nestedFiles = await downloadResourcesToDir(nested, resourceDir);
    if (nestedFiles.length === 0) break;
    writtenFiles.push(...nestedFiles);
    nestedFiles.forEach((file) => {
      if (file.sourceUrl) downloaded.add(file.sourceUrl);
    });
  }

  const manifest = writtenFiles.map((file) => ({
    path: file.name,
    sourceUrl: file.sourceUrl,
    contentType: file.contentType,
    bytes: file.bytes ?? file.content.length,
  }));
  const missing = [...referencedUrls].filter((url) => !downloaded.has(url));
  writeFile(resourceDir, 'manifest.json', JSON.stringify({
    downloaded: manifest,
    referencedButNotDownloaded: missing,
  }, null, 2));
}

async function createZipFromDir(jobDir: string, jobId: string): Promise<void> {
  const files = collectDiskFiles(jobDir);
  const zipPath = path.join(jobDir, '..', `${jobId}-seo-export.zip`);
  await streamZipFiles(files, zipPath);
  const stat = fs.statSync(zipPath);
  console.log(`[Export] ZIP created: ${jobId}-seo-export.zip (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
}

interface DiskFileEntry {
  name: string;
  fullPath: string;
  size: number;
}

function collectDiskFiles(dir: string, prefix: string = ''): DiskFileEntry[] {
  const entries: DiskFileEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, name);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      entries.push(...collectDiskFiles(fullPath, path.posix.join(prefix, name)));
    } else {
      entries.push({ name: path.posix.join(prefix, name), fullPath, size: stat.size });
    }
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function writeFile(dir: string, filename: string, content: string | Buffer): void {
  fs.writeFileSync(path.join(dir, filename), content);
}

function writeScreenshotFile(jobDir: string, slug: string, dataBase64: string | undefined): void {
  if (!dataBase64) return;
  const visualDir = path.join(jobDir, 'visual', 'pages');
  fs.mkdirSync(visualDir, { recursive: true });
  fs.writeFileSync(path.join(visualDir, `${slug}.png`), Buffer.from(dataBase64, 'base64'));
}

function writeCommerceStateFiles(
  jobDir: string,
  slug: string,
  states: import('@autowp/seo-analyzer').PageScreenshotData['commerceStates'],
): Array<{
  name: string;
  device: string;
  url: string;
  screenshotRef: string;
  viewport: { width: number; height: number };
  capturedAt: string;
}> {
  if (!states?.length) return [];
  const commerceDir = path.join(jobDir, 'visual', 'commerce');
  fs.mkdirSync(commerceDir, { recursive: true });
  return states.map((state) => {
    const filename = `${slug}-${state.device}-${state.name}.png`;
    fs.writeFileSync(path.join(commerceDir, filename), Buffer.from(state.dataBase64, 'base64'));
    return {
      name: state.name,
      device: state.device,
      url: state.url,
      screenshotRef: `../../visual/commerce/${filename}`,
      viewport: state.viewport,
      capturedAt: state.capturedAt,
    };
  });
}

function safeZipPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

function extractHeadSnapshot(html: string): {
  headHtml: string;
  htmlAttributes: Record<string, string>;
  bodyAttributes: Record<string, string>;
  bodyClasses: string[];
} {
  const headHtml = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? '';
  const htmlTag = html.match(/<html\b([^>]*)>/i)?.[1] ?? '';
  const bodyTag = html.match(/<body\b([^>]*)>/i)?.[1] ?? '';
  const parseAttrs = (attrs: string): Record<string, string> => Object.fromEntries(
    [...attrs.matchAll(/([a-z_:][-a-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)]
      .map((match) => [match[1], match[2] ?? match[3] ?? match[4] ?? '']),
  );
  const bodyAttributes = parseAttrs(bodyTag);
  return {
    headHtml,
    htmlAttributes: parseAttrs(htmlTag),
    bodyAttributes,
    bodyClasses: (bodyAttributes.class ?? '').split(/\s+/).filter(Boolean),
  };
}

function extractHiddenText(html: string): string[] {
  const hidden = [
    ...html.matchAll(/<[^>]+(?:hidden|aria-hidden=["']true["']|style=["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden)[^"']*["'])[^>]*>([\s\S]*?)<\/[^>]+>/gi),
  ];
  return hidden
    .map((match) => match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 0)
    .slice(0, 200);
}

export function collectResourceUrls(report: SeoReport): string[] {
  const urls = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value) return;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') urls.add(parsed.toString());
    } catch {
      // Ignore invalid resource references.
    }
  };

  for (const page of report.pages) {
    page.images.forEach((image) => add(image.src));
    page.products.forEach((product) => {
      product.images?.forEach(add);
      product.media?.forEach((media) => add(media.url));
      product.downloads?.forEach((media) => add(media.url));
      product.variants.forEach((variant) => add(variant.image));
    });
    const html = page.pageHtml ?? '';
    // Do not require a filename extension here. CDNs and font providers often
    // serve CSS/JS/images from extensionless, signed or query-only endpoints.
    for (const tag of html.matchAll(/<(?:link|script|img|source|video|audio)\b[^>]*>/gi)) {
      const markup = tag[0];
      if (/^<link\b/i.test(markup) && !/\brel\s*=\s*["'][^"']*(?:stylesheet|preload|modulepreload|icon)[^"']*["']/i.test(markup)) continue;
      for (const attribute of ['href', 'src', 'poster', 'data-src']) {
        const value = markup.match(new RegExp(`\\b${attribute}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
        if (!value) continue;
        try { add(new URL(value, page.finalUrl).toString()); } catch {
          // Ignore invalid resource attributes.
        }
      }
    }
    for (const match of html.matchAll(/(?:src|href|poster|data-src|data-href|data-url|data-background|data-bg)\s*=\s*["']([^"']+)["']/gi)) {
      const resolved = (() => {
        try { return new URL(match[1], page.finalUrl).toString(); } catch { return undefined; }
      })();
      if (resolved && /\.(?:css|js|jpe?g|png|webp|gif|svg|ico|woff2?|ttf|otf|mp4|webm|mov|pdf)(?:$|\?)/i.test(resolved)) {
        add(resolved);
      }
    }
    for (const match of html.matchAll(/(?:srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi)) {
      for (const candidate of match[1].split(',')) {
        const value = candidate.trim().split(/\s+/)[0];
        if (!value) continue;
        try { add(new URL(value, page.finalUrl).toString()); } catch {
          // Ignore invalid responsive image candidates.
        }
      }
    }
    for (const match of html.matchAll(/url\((['"]?)([^'")]+)\1\)/gi)) {
      try { add(new URL(match[2], page.finalUrl).toString()); } catch {
        // Ignore invalid CSS URLs.
      }
    }
    for (const match of html.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']\s*\)?/gi)) {
      try { add(new URL(match[1], page.finalUrl).toString()); } catch {
        // Ignore invalid imported stylesheets.
      }
    }
  }

  report.siteModel?.media.forEach((media) => add(media.url));
  report.siteModel?.globalStyles.globalCssRefs.forEach(add);
  return [...urls];
}

function collectDownloadedCssDependencies(files: FileEntry[], resourceDir: string): string[] {
  const urls = new Set<string>();
  for (const file of files) {
    if (!file.sourceUrl || !isCssResource(file)) continue;
    const safeRelative = safeZipPath(file.name).replace(/^resources\//, '');
    const fullPath = path.join(resourceDir, safeRelative);
    let css = '';
    try {
      css = file.content.length > 0 ? file.content.toString('utf-8') : fs.readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }
    const addResolved = (value: string): void => {
      const cleaned = value.trim();
      if (!cleaned || /^(?:data:|blob:|#)/i.test(cleaned)) return;
      try {
        const resolved = new URL(cleaned, file.sourceUrl);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') urls.add(resolved.toString());
      } catch {
        // Ignore invalid CSS references.
      }
    };
    for (const match of css.matchAll(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi)) addResolved(match[2]);
    for (const match of css.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']\s*\)?/gi)) addResolved(match[1]);
  }
  return [...urls];
}

function isCssResource(file: FileEntry): boolean {
  if (/text\/css/i.test(file.contentType ?? '')) return true;
  if (/\.css(?:$|\?)/i.test(file.sourceUrl ?? '')) return true;
  return /\.css$/i.test(file.name);
}

/* ------------------------------------------------------------------ */
/*  CSV helpers                                                        */
/* ------------------------------------------------------------------ */

const MIME_BY_FORMAT: Record<ExportFormat, string> = {
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  html: 'text/html; charset=utf-8',
  pdf: 'application/pdf',
  zip: 'application/zip',
  woocommerce: 'text/csv; charset=utf-8',
  mira: 'application/json; charset=utf-8',
};

function escapeCsv(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(report: SeoReport): string {
  const headers = [
    'url', 'status', 'title', 'meta_description', 'canonical', 'robots',
    'h1', 'h2_count', 'h3_count', 'internal_links', 'external_links', 'broken_links',
    'images', 'missing_alt', 'large_images', 'word_count', 'indexability', 'issues', 'products',
  ];
  const rows = report.pages.map((page) => [
    page.url, page.statusCode, page.title, page.metaDescription, page.canonical,
    page.robots, page.headings.h1.join(' | '), page.headings.h2.length, page.headings.h3.length,
    page.internalLinks.length, page.externalLinks.length, page.brokenLinks.length,
    page.images.length, page.imagesWithoutAlt.length, page.heavyImages.length,
    page.wordCount, page.indexability,
    page.issues.map((issue) => `${issue.severity}:${issue.code}`).join(' | '),
    page.products.length,
  ]);
  return [headers, ...rows].map((row) => row.map(escapeCsv).join(',')).join('\n');
}

/* ------------------------------------------------------------------ */
/*  HTML helper                                                        */
/* ------------------------------------------------------------------ */

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _toHtml(report: SeoReport): string {
  const rows = report.pages.map((page) => `
    <tr>
      <td>${escapeHtml(page.url)}</td>
      <td>${page.statusCode}</td>
      <td>${escapeHtml(page.title ?? '')}</td>
      <td>${escapeHtml(page.metaDescription ?? '')}</td>
      <td>${page.issues.length}</td>
      <td>${page.products.length}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>SEO report — ${escapeHtml(report.summary.totalPages)} pages</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #111827; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    th, td { border: 1px solid #e5e7eb; padding: 8px; text-align: left; vertical-align: top; }
    th { background: #f9fafb; }
  </style>
</head>
<body>
  <h1>SEO report</h1>
  <p>Score: ${report.score}/100. Pages: ${report.summary.totalPages}. Critical: ${report.criticalErrors.length}. Warnings: ${report.warnings.length}.</p>
  <table>
    <thead><tr><th>URL</th><th>Status</th><th>Title</th><th>Description</th><th>Issues</th><th>Products</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

function simpleIssueName(code: string): string {
  const names: Record<string, string> = {
    HTTP_4XX: 'Página que no funciona',
    BROKEN_LINKS: 'Enlaces que llevan a un error',
    DESCRIPTION_MISSING: 'Falta la explicación que aparece en Google',
    TITLE_LENGTH: 'El título puede explicarse mejor',
    H1_MISSING: 'Falta un titular principal claro',
    OPEN_GRAPH_INCOMPLETE: 'La página se comparte mal en redes y WhatsApp',
    IMAGES_WITHOUT_ALT: 'Hay imágenes sin explicación accesible',
    SLOW_RESPONSE: 'La página tarda demasiado en responder',
    CANONICAL_MISSING: 'Google no recibe la dirección principal',
    THIN_CONTENT: 'La página ofrece poca información útil',
  };
  return names[code] ?? code.toLowerCase().replaceAll('_', ' ');
}

function toProfessionalHtml(report: SeoReport): string {
  const valid = report.pages.filter((page) => page.statusCode >= 200 && page.statusCode < 400).length;
  const broken = report.pages.length - valid;
  const grouped = [...report.criticalErrors, ...report.warnings].reduce<Map<string, { count: number; critical: boolean }>>((all, issue) => {
    const value = all.get(issue.code) ?? { count: 0, critical: false };
    value.count += 1;
    value.critical ||= issue.severity === 'critical';
    all.set(issue.code, value);
    return all;
  }, new Map());
  const actions = [...grouped.entries()].map(([code, data]) => `<article class="action ${data.critical ? 'critical' : ''}">
    <small>${data.critical ? 'PRIORIDAD INMEDIATA' : 'MEJORA IMPORTANTE'}</small>
    <h3>${escapeHtml(simpleIssueName(code))}</h3>
    <p><b>Qué hemos visto:</b> aparece ${data.count} ${data.count === 1 ? 'vez' : 'veces'} en las páginas analizadas.</p>
    <p><b>Qué haremos:</b> corregiremos la causa y comprobaremos de nuevo las páginas afectadas.</p>
    <p><b>Por qué ayuda:</b> facilita que Google entienda el contenido y que la persona avance sin dudas ni errores.</p>
  </article>`).join('');
  const rows = report.pages.map((page) => `<tr>
    <td><b>${escapeHtml(page.title || page.url)}</b><small>${escapeHtml(page.url)}</small></td>
    <td class="${page.statusCode >= 400 ? 'bad' : 'good'}">${page.statusCode}</td>
    <td>${escapeHtml(page.issues.slice(0, 3).map((issue) => simpleIssueName(issue.code)).join(', ') || 'Sin problemas importantes')}</td>
    <td>${page.issues.length}</td>
  </tr>`).join('');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Informe SEO y CRO explicado</title><style>
  :root{--navy:#091d2e;--teal:#087f8c;--cyan:#3dd6d0;--pale:#f3f7f8;--line:#d7e2e5;--ink:#17212b;--red:#d9534f;--green:#2a9d6f}
  *{box-sizing:border-box}body{margin:0;background:#edf3f4;color:var(--ink);font:16px/1.55 Arial,sans-serif}.wrap{max-width:1120px;margin:auto;background:#fff;min-height:100vh}
  header{padding:72px 7%;background:var(--navy);color:#fff}header small{color:var(--cyan);font-weight:700;letter-spacing:.14em}h1{font-size:clamp(38px,7vw,68px);line-height:1.02;margin:.25em 0}header p{max-width:760px;font-size:19px;color:#d9e8eb}
  main{padding:50px 7% 90px}h2{margin:48px 0 12px;color:var(--navy);font-size:32px}h2:first-child{margin-top:0}.lead{max-width:850px;font-size:18px}
  .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:28px 0}.metric{padding:22px;background:var(--pale);border:1px solid var(--line);text-align:center}.metric b{display:block;color:var(--navy);font-size:34px}.metric span{font-size:13px;color:#60747c}
  .notice{margin:24px 0;padding:20px;border-left:5px solid var(--teal);background:#eaf6f6}.actions{display:grid;gap:14px}.action{padding:20px;border:1px solid var(--line);border-left:6px solid #f2a93b}.action.critical{border-left-color:var(--red)}.action small{font-weight:700;color:var(--teal)}.action h3{margin:5px 0}.action p{margin:5px 0}
  table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:12px;border:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--navy);color:#fff}tr:nth-child(even){background:var(--pale)}td small{display:block;color:#667b84;word-break:break-all}.bad{color:var(--red);font-weight:700}.good{color:var(--green);font-weight:700}
  .cro{display:grid;grid-template-columns:1fr 1fr;gap:14px}.cro article{padding:20px;background:var(--pale);border-top:5px solid var(--teal)}.cro h3{margin-top:0;color:var(--navy)}
  footer{padding:28px 7%;background:var(--navy);color:#d8e7ea}@media(max-width:700px){.metrics,.cro{grid-template-columns:1fr 1fr}main{padding:32px 5%}}
  </style></head><body><div class="wrap"><header><small>INFORME EXPLICADO · SEO + CRO</small><h1>Qué mejoraremos<br>y por qué</h1><p>Analizamos las páginas públicas descubiertas, explicamos los problemas sin tecnicismos y proponemos mejoras para atraer visitas útiles y convertirlas en contactos o ventas.</p></header>
  <main><h2>Resumen sencillo</h2><p class="lead">Priorizamos primero lo que no funciona, después la claridad de cada página y finalmente la conversión. Cada propuesta explica el problema, la acción y cómo sabremos si funciona.</p>
  <div class="metrics"><div class="metric"><b>${report.pages.length}</b><span>Páginas encontradas</span></div><div class="metric"><b>${valid}</b><span>Páginas que funcionan</span></div><div class="metric"><b>${broken}</b><span>Páginas con error</span></div><div class="metric"><b>${report.criticalErrors.length + report.warnings.length}</b><span>Mejoras detectadas</span></div></div>
  <div class="notice"><b>Importante:</b> no usamos una puntuación aislada para juzgar toda la web. Explicamos qué ocurre, qué cambiaremos y qué indicador demostrará si la mejora funciona.</div>
  <h2>Qué páginas hemos analizado</h2><table><thead><tr><th>Página</th><th>Estado</th><th>Qué debemos mejorar</th><th>Señales</th></tr></thead><tbody>${rows}</tbody></table>
  <h2>Mejoras SEO explicadas</h2><div class="actions">${actions}</div>
  <h2>Cómo mejoraremos la conversión</h2><div class="cro">
  <article><h3>1. Explicar la propuesta</h3><p>La primera pantalla debe decir qué ofrece la empresa, para quién y cuál es el siguiente paso.</p></article>
  <article><h3>2. Demostrar confianza</h3><p>Añadiremos ejemplos, proceso, garantías, opiniones y respuestas a las dudas que frenan la decisión.</p></article>
  <article><h3>3. Reducir pasos</h3><p>Usaremos botones concretos, contacto rápido y formularios breves adaptados a cada página.</p></article>
  <article><h3>4. Medir resultados</h3><p>Mediremos contactos, llamadas, citas, compras y valor. Solo mantendremos los cambios respaldados por datos.</p></article></div>
  <h2>SEO y CRO trabajando juntos</h2><div class="notice"><b>Recorrido correcto:</b> búsqueda concreta → resultado claro → página que responde a esa necesidad → prueba de confianza → acción sencilla.</div>
  <h2>Orden recomendado</h2><ol><li>Reparar errores, enlaces y páginas rotas.</li><li>Diferenciar el objetivo y el mensaje de cada página.</li><li>Añadir confianza y llamadas a la acción sencillas.</li><li>Medir, comparar y mejorar con datos reales.</li></ol></main>
  <footer>AutoWP Informes · Diagnóstico verificable. Las mejoras comerciales son hipótesis que deben medirse; no se garantizan posiciones ni ventas.</footer></div></body></html>`;
}

/* ------------------------------------------------------------------ */
/*  PDF helper                                                         */
/* ------------------------------------------------------------------ */

function pdfEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

export function toPdf(report: SeoReport): Buffer {
  const lines = [
    'SEO report',
    `Score: ${report.score}/100`,
    `Pages: ${report.summary.totalPages}`,
    `Critical: ${report.criticalErrors.length}`,
    `Warnings: ${report.warnings.length}`,
    `Products: ${report.summary.totalProducts}`,
    '',
    ...report.pages.slice(0, 80).map((page) => `${page.statusCode} ${page.url} issues:${page.issues.length}`),
  ];
  const content = [
    'BT',
    '/F1 10 Tf',
    '40 800 Td',
    ...lines.map((line, index) => `${index === 0 ? '' : '0 -14 Td '}(${pdfEscape(line).slice(0, 180)}) Tj`),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i += 1) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

/* ------------------------------------------------------------------ */
/*  ZIP helper                                                         */
/* ------------------------------------------------------------------ */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function crc32File(filePath: string): Promise<number> {
  let crc = 0xffffffff;
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk: string | Buffer) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    });
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(): { time: number; date: number } {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  return { time, date };
}

function zip64Extra(values: bigint[]): Buffer {
  const extra = Buffer.alloc(4 + (values.length * 8));
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, index) => extra.writeBigUInt64LE(value, 4 + (index * 8)));
  return extra;
}

async function writeStream(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) {
    await new Promise<void>((resolve) => stream.once('drain', resolve));
  }
}

async function copyFileToStream(filePath: string, stream: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk: string | Buffer) => {
      input.pause();
      const resume = () => input.resume();
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      if (stream.write(bytes)) {
        resume();
      } else {
        stream.once('drain', resume);
      }
    });
    input.on('error', reject);
    input.on('end', resolve);
  });
}

interface CentralDirectoryEntry {
  name: Buffer;
  crc: number;
  size: number;
  offset: number;
  time: number;
  date: number;
}

async function streamZipFiles(files: DiskFileEntry[], zipPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const output = fs.createWriteStream(zipPath);
  output.setMaxListeners(0);
  const central: CentralDirectoryEntry[] = [];
  let offset = 0;
  const uint32Max = 0xffffffff;

  try {
    for (const file of files) {
      const name = Buffer.from(safeZipPath(file.name));
      const crc = await crc32File(file.fullPath);
      const { time, date } = dosDateTime();
      const needsZip64 = file.size > uint32Max || offset > uint32Max;
      const extra = needsZip64 ? zip64Extra([BigInt(file.size), BigInt(file.size)]) : Buffer.alloc(0);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(needsZip64 ? 45 : 20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(needsZip64 ? uint32Max : file.size, 18);
      local.writeUInt32LE(needsZip64 ? uint32Max : file.size, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(extra.length, 28);

      await writeStream(output, local);
      await writeStream(output, name);
      if (extra.length > 0) await writeStream(output, extra);
      await copyFileToStream(file.fullPath, output);

      central.push({ name, crc, size: file.size, offset, time, date });
      offset += local.length + name.length + extra.length + file.size;
    }

    const centralOffset = offset;
    for (const file of central) {
      const needsZip64 = file.size > uint32Max || file.offset > uint32Max;
      const extra = needsZip64 ? zip64Extra([BigInt(file.size), BigInt(file.size), BigInt(file.offset)]) : Buffer.alloc(0);
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(needsZip64 ? 45 : 20, 4);
      header.writeUInt16LE(needsZip64 ? 45 : 20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(file.time, 12);
      header.writeUInt16LE(file.date, 14);
      header.writeUInt32LE(file.crc, 16);
      header.writeUInt32LE(needsZip64 ? uint32Max : file.size, 20);
      header.writeUInt32LE(needsZip64 ? uint32Max : file.size, 24);
      header.writeUInt16LE(file.name.length, 28);
      header.writeUInt16LE(extra.length, 30);
      header.writeUInt32LE(needsZip64 ? uint32Max : file.offset, 42);
      await writeStream(output, header);
      await writeStream(output, file.name);
      if (extra.length > 0) await writeStream(output, extra);
      offset += header.length + file.name.length + extra.length;
    }

    const centralSize = offset - centralOffset;
    const needsZip64End = files.length > 0xffff || centralOffset > uint32Max || centralSize > uint32Max;
    if (needsZip64End) {
      const zip64EndOffset = offset;
      const zip64End = Buffer.alloc(56);
      zip64End.writeUInt32LE(0x06064b50, 0);
      zip64End.writeBigUInt64LE(44n, 4);
      zip64End.writeUInt16LE(45, 12);
      zip64End.writeUInt16LE(45, 14);
      zip64End.writeBigUInt64LE(BigInt(files.length), 24);
      zip64End.writeBigUInt64LE(BigInt(files.length), 32);
      zip64End.writeBigUInt64LE(BigInt(centralSize), 40);
      zip64End.writeBigUInt64LE(BigInt(centralOffset), 48);
      await writeStream(output, zip64End);
      offset += zip64End.length;

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(zip64EndOffset), 8);
      locator.writeUInt32LE(1, 16);
      await writeStream(output, locator);
      offset += locator.length;
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(Math.min(files.length, 0xffff), 8);
    end.writeUInt16LE(Math.min(files.length, 0xffff), 10);
    end.writeUInt32LE(needsZip64End ? uint32Max : centralSize, 12);
    end.writeUInt32LE(needsZip64End ? uint32Max : centralOffset, 16);
    await writeStream(output, end);
  } finally {
    output.end();
    await new Promise<void>((resolve, reject) => {
      output.on('finish', resolve);
      output.on('error', reject);
    });
  }
}

function _zipFiles(files: FileEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name);
    const compressed = deflateRawSync(file.content);
    const crc = crc32(file.content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(file.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(file.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centralParts.reduce((acc, part) => acc + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

/* ------------------------------------------------------------------ */
/*  WooCommerce CSV helpers                                            */
/* ------------------------------------------------------------------ */

const WOOCOMMERCE_HEADERS = [
  'ID', 'Type', 'SKU', 'Name', 'Published', 'Is featured?', 'Visibility in catalog',
  'Short description', 'Description', 'Tax status', 'Tax class',
  'In stock?', 'Stock', 'Backorders allowed?', 'Sold individually?',
  'Regular price', 'Sale price', 'Categories', 'Tags', 'Images',
  'Download limit', 'Download expiry days', 'Parent', 'Grouped products',
  'Upsells', 'Cross-sells', 'External URL', 'Button text', 'Position',
  'Attribute 1 name', 'Attribute 1 value(s)', 'Attribute 1 visible', 'Attribute 1 global', 'Attribute 1 default',
  'Attribute 2 name', 'Attribute 2 value(s)', 'Attribute 2 visible', 'Attribute 2 global', 'Attribute 2 default',
  'Attribute 3 name', 'Attribute 3 value(s)', 'Attribute 3 visible', 'Attribute 3 global', 'Attribute 3 default',
  'Download 1 name', 'Download 1 URL',
  'Meta: _yoast_wpseo_title', 'Meta: _yoast_wpseo_metadesc', 'Meta: _canonical',
  'Meta: _original_permalink', 'Meta: _original_id', 'Meta: _original_currency', 'Meta: _brand',
] as const;

type WooCommerceRow = Record<typeof WOOCOMMERCE_HEADERS[number], string | number>;

function slugFallback(product: ProductData, index: number): string {
  return product.slug ?? product.handle ?? product.sku ?? `product-${index + 1}`;
}

function productImages(product: ProductData): string {
  const media: ProductMediaData[] = product.media?.length ? product.media : (product.images?.map((url, index) => ({
    url, originalUrl: url, order: index, role: index === 0 ? 'featured' : 'gallery',
  })) ?? []);
  return media
    .filter((item) => item.role !== 'video' && item.role !== 'download' && item.role !== 'document')
    .sort((a, b) => a.order - b.order)
    .map((item) => item.url)
    .join(', ');
}

function inStock(value: string | undefined): string {
  if (!value) return '';
  return /outofstock|out of stock|soldout|sold out|unavailable/i.test(value) ? '0' : '1';
}

function backordersAllowed(value: string | undefined): string {
  if (!value || value === 'no') return '0';
  return '1';
}

function attributeEntries(product: ProductData): Array<[string, string[], string]> {
  const options = product.options ?? {};
  const fromOptions = Object.entries(options).map(([name, values]) => [name, values, values[0] ?? ''] as [string, string[], string]);
  const fromAttributes = Object.entries(product.attributes ?? {})
    .filter(([name]) => !(name in options))
    .map(([name, value]) => [name, [value as string], value as string] as [string, string[], string]);
  return [...fromOptions, ...fromAttributes].slice(0, 3);
}

function emptyWooRow(): WooCommerceRow {
  return Object.fromEntries(WOOCOMMERCE_HEADERS.map((header) => [header, ''])) as WooCommerceRow;
}

function baseWooRow(product: ProductData, index: number): WooCommerceRow {
  const row = emptyWooRow();
  const relationships = product.relationships ?? {};
  row.ID = product.id ?? '';
  row.SKU = product.sku ?? slugFallback(product, index);
  row.Name = product.name ?? product.title ?? slugFallback(product, index);
  row.Published = 1;
  row['Is featured?'] = 0;
  row['Visibility in catalog'] = 'visible';
  row['Short description'] = product.shortDescription ?? product.excerpt ?? '';
  row.Description = product.descriptionHtml ?? product.description ?? product.renderedText ?? '';
  row['Tax status'] = product.taxStatus ?? 'taxable';
  row['Tax class'] = product.taxClass ?? '';
  row['In stock?'] = inStock(product.stockStatus ?? product.availability);
  row.Stock = product.stock ?? '';
  row['Backorders allowed?'] = backordersAllowed(product.backorders ?? (product.backorder ? 'notify' : undefined));
  row['Sold individually?'] = 0;
  row['Regular price'] = product.regularPrice ?? product.compareAtPrice ?? product.price ?? '';
  row['Sale price'] = product.salePrice ?? (product.compareAtPrice ? product.price ?? '' : '');
  row.Categories = (product.categories ?? []).join(', ');
  row.Tags = [...(product.tags ?? []), ...(product.collections ?? []), ...(product.brand ? [product.brand] : [])].join(', ');
  row.Images = productImages(product);
  row['Download limit'] = '';
  row['Download expiry days'] = '';
  row.Parent = '';
  row['Grouped products'] = relationships.bundles?.join(', ') ?? '';
  row.Upsells = relationships.upsells?.join(', ') ?? relationships.recommended?.join(', ') ?? '';
  row['Cross-sells'] = relationships.crossSells?.join(', ') ?? relationships.related?.join(', ') ?? '';
  row['External URL'] = '';
  row['Button text'] = '';
  row.Position = 0;
  row['Download 1 name'] = product.downloads?.[0]?.filename ?? '';
  row['Download 1 URL'] = product.downloads?.[0]?.url ?? '';
  row['Meta: _yoast_wpseo_title'] = product.seo?.title ?? product.title ?? '';
  row['Meta: _yoast_wpseo_metadesc'] = product.seo?.description ?? '';
  row['Meta: _canonical'] = product.seo?.canonical ?? product.canonical ?? '';
  row['Meta: _original_permalink'] = product.url ?? product.sourceUrl;
  row['Meta: _original_id'] = product.id ?? '';
  row['Meta: _original_currency'] = product.currency ?? '';
  row['Meta: _brand'] = product.brand ?? product.vendor ?? '';

  for (const [attributeIndex, [name, values, defaultValue]] of attributeEntries(product).entries()) {
    const position = attributeIndex + 1;
    row[`Attribute ${position} name` as keyof WooCommerceRow] = name;
    row[`Attribute ${position} value(s)` as keyof WooCommerceRow] = values.join(', ');
    row[`Attribute ${position} visible` as keyof WooCommerceRow] = 1;
    row[`Attribute ${position} global` as keyof WooCommerceRow] = 0;
    row[`Attribute ${position} default` as keyof WooCommerceRow] = defaultValue;
  }

  return row;
}

export function toWooCommerceCsv(products: ProductData[]): string {
  const rows: WooCommerceRow[] = [];
  const canonicalProducts = mergeProducts(products).products;

  canonicalProducts.forEach((product, productIndex) => {
    const parentSku = product.sku ?? slugFallback(product, productIndex);
    const parentRow = baseWooRow(product, productIndex);
    parentRow.Type = product.variants.length > 0 ? 'variable' : 'simple';
    rows.push(parentRow);

    product.variants.forEach((variant, variantIndex) => {
      const variantRow = baseWooRow(product, productIndex);
      const attributeValues = Object.values(variant.attributes);
      variantRow.ID = variant.id ?? '';
      variantRow.Type = 'variation';
      variantRow.SKU = variant.sku ?? `${parentSku}-${variantIndex + 1}`;
      variantRow.Name = `${product.name ?? product.title ?? parentSku}${attributeValues.length ? ` - ${attributeValues.join(' / ')}` : ''}`;
      variantRow['Regular price'] = variant.regularPrice ?? variant.compareAtPrice ?? variant.price ?? product.regularPrice ?? product.price ?? '';
      variantRow['Sale price'] = variant.salePrice ?? (variant.compareAtPrice ? variant.price ?? '' : '');
      variantRow['In stock?'] = inStock(variant.stockStatus ?? variant.availability);
      variantRow.Stock = variant.stock ?? '';
      variantRow['Backorders allowed?'] = backordersAllowed(variant.backorders);
      variantRow.Images = variant.image ?? '';
      variantRow.Parent = `sku:${parentSku}`;
      variantRow.Position = variantIndex;

      for (const [attributeIndex, [name, value]] of Object.entries(variant.attributes).slice(0, 3).entries()) {
        const position = attributeIndex + 1;
        variantRow[`Attribute ${position} name` as keyof WooCommerceRow] = name;
        variantRow[`Attribute ${position} value(s)` as keyof WooCommerceRow] = value;
        variantRow[`Attribute ${position} visible` as keyof WooCommerceRow] = '';
        variantRow[`Attribute ${position} global` as keyof WooCommerceRow] = 0;
        variantRow[`Attribute ${position} default` as keyof WooCommerceRow] = '';
      }

      rows.push(variantRow);
    });
  });

  return [
    WOOCOMMERCE_HEADERS.map(escapeCsv).join(','),
    ...rows.map((row) => WOOCOMMERCE_HEADERS.map((header) => escapeCsv(row[header])).join(',')),
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/*  Page slug helper                                                   */
/* ------------------------------------------------------------------ */

function pageSlug(page: SeoPageReport): string {
  const url = new URL(page.finalUrl);
  const slug = url.pathname.split('/').filter(Boolean).join('-');
  return slug || 'home';
}

/* ------------------------------------------------------------------ */
/*  Product extraction                                                 */
/* ------------------------------------------------------------------ */

export function extractProducts(report: SeoReport): ProductData[] {
  return mergeProducts(report.pages.flatMap((page) => page.products)).products;
}

/* ------------------------------------------------------------------ */
/*  Media download                                                     */
/* ------------------------------------------------------------------ */

export async function downloadMediaResources(
  urls: string[],
  basePath: string = 'media',
  maxResources: number = Number.MAX_SAFE_INTEGER,
  concurrency: number = 4,
): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  const seen = new Set<string>();
  const uniqueUrls = urls.filter((url) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  }).slice(0, maxResources);

  const queue = [...uniqueUrls];
  const inProgress: Promise<void>[] = [];

  const next = (): Promise<void> => {
    if (queue.length === 0) return Promise.resolve();
    const url = queue.shift()!;
    return downloadSingleResource(url, basePath)
      .then((entry) => {
        if (entry) results.push(entry);
      })
      .catch(() => {})
      .then(next);
  };

  for (let i = 0; i < Math.min(concurrency, uniqueUrls.length); i++) {
    inProgress.push(next());
  }
  await Promise.all(inProgress);

  return results;
}

async function downloadResourcesToDir(
  urls: string[],
  resourceDir: string,
  basePath: string = 'media',
  concurrency: number = 4,
): Promise<FileEntry[]> {
  const results: FileEntry[] = [];
  const seen = new Set<string>();
  const queue = urls.filter((url) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });

  const worker = async (): Promise<void> => {
    while (queue.length > 0) {
      const url = queue.shift();
      if (!url) return;
      const entry = await downloadSingleResourceToDir(url, resourceDir, basePath);
      if (entry) results.push(entry);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()));
  return results;
}

async function downloadSingleResourceToDir(
  url: string,
  resourceDir: string,
  basePath: string,
): Promise<FileEntry | null> {
  const entry = await downloadSingleResource(url, basePath);
  if (!entry) return null;
  const safeRelative = safeZipPath(entry.name).replace(/^resources\//, '');
  const fullPath = path.join(resourceDir, safeRelative);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, entry.content);
  return { ...entry, content: Buffer.alloc(0) };
}

async function downloadSingleResource(
  url: string,
  basePath: string,
): Promise<FileEntry | null> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'data:') return null;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

    let response: Response | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (response.status !== 429 && response.status < 500) break;
      const retryAfter = Number(response.headers.get('retry-after'));
      const delayMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : attempt * 1500;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!response) return null;
    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.startsWith('text/html') || contentType.startsWith('application/json')) return null;

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > 25 * 1024 * 1024) return null;

    const urlPath = parsed.pathname;
    const filename = urlPath.split('/').filter(Boolean).pop() ?? 'resource';
    const ext = path.extname(filename) || '.bin';

    const hash = Array.from(new Uint8Array(new TextEncoder().encode(url)))
      .reduce((acc, byte) => ((acc << 5) - acc + byte) | 0, 0)
      .toString(36);
    const safeName = `${hash}${ext}`;

    return {
      name: `resources/${basePath}/${safeName}`,
      content: buffer,
      sourceUrl: url,
      contentType,
      bytes: buffer.length,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  buildExport (kept for backward-compatible API endpoint calls)      */
/* ------------------------------------------------------------------ */

function discoverPublicSocialProfiles(report: SeoReport): Array<{ platform: string; url: string; sourcePage: string }> {
  const platforms: Array<[string, RegExp]> = [
    ['Instagram', /(^|\.)instagram\.com$/i],
    ['Facebook', /(^|\.)facebook\.com$/i],
    ['TikTok', /(^|\.)tiktok\.com$/i],
    ['Pinterest', /(^|\.)pinterest\.[a-z.]+$/i],
    ['YouTube', /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i],
    ['LinkedIn', /(^|\.)linkedin\.com$/i],
    ['Threads', /(^|\.)threads\.net$/i],
    ['X', /(^|\.)x\.com$|(^|\.)twitter\.com$/i],
  ];
  const excludedPaths = /\/(share|sharer|intent|login|dialog)\b/i;
  const found = new Map<string, { platform: string; url: string; sourcePage: string }>();
  for (const page of report.pages) {
    const html = page.pageHtml ?? '';
    for (const match of html.matchAll(/href\s*=\s*["'](https?:\/\/[^"'<>]+)["']/gi)) {
      const raw = match[1].replaceAll('&amp;', '&');
      try {
        const url = new URL(raw);
        const platform = platforms.find(([, hostPattern]) => hostPattern.test(url.hostname))?.[0];
        if (!platform || excludedPaths.test(url.pathname)) continue;
        url.hash = '';
        const normalized = url.toString();
        found.set(`${platform}:${normalized.toLowerCase()}`, {
          platform,
          url: normalized,
          sourcePage: page.finalUrl ?? page.url,
        });
      } catch {
        // Ignore malformed public links; never infer a profile from an invalid URL.
      }
    }
  }
  return [...found.values()].slice(0, 12);
}

export function buildExport(
  report: SeoReport,
  format: ExportFormat,
  jobId: string,
  _diagnostics?: CrawlDiagnostics,
  _mediaFiles?: FileEntry[],
): ExportArtifact {
  if (format === 'mira') {
    const candidate = selectTryOnCandidate(report);
    const socialProfiles = discoverPublicSocialProfiles(report);
    const resultPath = path.join(EXPORT_DIR, jobId, 'tryon-result.jpg');
    const sourceUrl = report.pages[0]?.finalUrl ?? report.pages[0]?.url ?? '';
    const sourceText = report.pages.map((page) => page.pageHtml ?? '').join(' ').toLowerCase();
    const issues = [...report.criticalErrors, ...report.warnings];
    const evidenceFindings = issues.slice(0, 6).map((issue, index) => ({
      title: issue.message,
      detail: issue.severity === 'critical' ? 'Este problema puede impedir que posibles clientes encuentren o utilicen correctamente esta página.' : 'Esta mejora ayuda a presentar mejor la tienda y reducir fricción.',
      evidence: `${issue.code}${issue.pageUrl ? ` detectado en ${issue.pageUrl}` : ' detectado durante el rastreo'}.`,
      action: `Corregir ${issue.code.toLowerCase().replaceAll('_', ' ')} y volver a medir el resultado.`,
      level: (issue.severity === 'critical' ? 'high' : 'medium') as 'high' | 'medium',
      source: 'crawler',
      order: index,
    }));
    const salesFindings = [
      {
        title: candidate ? 'La clienta todavía debe imaginar cómo le quedará la prenda' : 'El catálogo necesita una ayuda de compra más visual',
        detail: candidate ? `Hemos localizado ${candidate.productName}; una prueba visual puede resolver la duda antes de abandonar.` : 'No hemos encontrado una prenda compatible con el probador en las páginas analizadas.',
        evidence: candidate ? `Producto real detectado: ${candidate.productName} (${candidate.productUrl}).` : 'No se detectó un producto compatible con imagen utilizable en la muestra rastreada.',
        action: candidate ? 'Añadir el probador virtual junto a la talla y el botón de compra.' : 'Revisar el catálogo completo antes de activar el probador.',
        level: 'high' as const,
      },
      {
        title: 'La conversación comercial puede continuar después de la visita',
        detail: 'Una atención contextual permite resolver dudas sin enviar mensajes genéricos.',
        evidence: sourceText.includes('wa.me') || sourceText.includes('whatsapp') ? 'La web ya muestra un canal de WhatsApp que puede conectarse con el producto consultado.' : 'No se encontró un acceso contextual a WhatsApp en las páginas rastreadas.',
        action: 'Conectar cada consulta consentida con la prenda y la página que originaron el interés.',
        level: 'medium' as const,
      },
    ];
    const payload = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceUrl,
      evidencePolicy: 'Cada hallazgo procede del rastreo. Las propuestas visuales son simulaciones y los objetivos deben validarse después de implementar.',
      pagesAnalyzed: report.summary.totalPages,
      visibilityScore: report.score,
      salesReadinessScore: Math.max(0, Math.min(100, 100 - (report.summary.brokenLinks * 8) - (report.summary.thinContentPages * 3) - (candidate ? 8 : 22))),
      findability: evidenceFindings.slice(0, 3),
      sales: salesFindings,
      social: {
        profiles: socialProfiles,
        status: socialProfiles.length > 0 ? 'found_on_website' : 'not_found_on_crawled_pages',
        evidence: socialProfiles.length > 0
          ? `Se encontraron ${socialProfiles.length} enlaces sociales públicos en las páginas rastreadas.`
          : 'No se encontraron enlaces sociales públicos en las páginas rastreadas; esto no demuestra que el negocio no tenga perfiles.',
        policy: 'Solo se utilizan enlaces públicos publicados por el propio negocio. No se recopilan seguidores, relaciones ni datos privados.',
      },
      tryOn: candidate ? {
        productName: candidate.productName,
        productPrice: candidate.price ?? 'Precio no detectado',
        productUrl: candidate.productUrl,
        productImage: candidate.garmentImageUrl,
        modelGender: candidate.modelGender,
        category: candidate.garmentZone,
        resultAvailable: fs.existsSync(resultPath),
        resultEndpoint: fs.existsSync(resultPath) ? `/reports/${jobId}/tryon-result` : null,
      } : null,
    };
    return { filename: `${jobId}-mira-report.json`, contentType: 'application/json; charset=utf-8', body: JSON.stringify(payload, null, 2) };
  }
  if (format === 'json') {
    return { filename: `${jobId}-seo-report.json`, contentType: MIME_BY_FORMAT.json, body: JSON.stringify(report, null, 2) };
  }
  if (format === 'csv') {
    return { filename: `${jobId}-seo-report.csv`, contentType: MIME_BY_FORMAT.csv, body: toCsv(report) };
  }
  if (format === 'html') {
    return { filename: `${jobId}-informe-seo-cro.html`, contentType: MIME_BY_FORMAT.html, body: toProfessionalHtml(report) };
  }
  if (format === 'pdf') {
    const professionalPdf = path.join(EXPORT_DIR, jobId, 'informe-seo-cro-profesional.pdf');
    if (fs.existsSync(professionalPdf)) {
      return { filename: `${jobId}-informe-seo-cro.pdf`, contentType: MIME_BY_FORMAT.pdf, filePath: professionalPdf };
    }
    return { filename: `${jobId}-seo-report.pdf`, contentType: MIME_BY_FORMAT.pdf, body: toPdf(report) };
  }
  if (format === 'woocommerce') {
    return { filename: `${jobId}-woocommerce-products.csv`, contentType: MIME_BY_FORMAT.woocommerce, body: toWooCommerceCsv(extractProducts(report)) };
  }

  // Fallback to reading from disk — the ZIP was already built by runAllExports
  const zipPath = path.join(EXPORT_DIR, `${jobId}-seo-export.zip`);
  if (fs.existsSync(zipPath)) {
    return {
      filename: `${jobId}-seo-export.zip`,
      contentType: MIME_BY_FORMAT.zip,
      filePath: zipPath,
    };
  }

  throw new Error(`ZIP export not found on disk for job ${jobId}`);
}

export function buildWordPressProjectFiles(report: SeoReport): FileEntry[] {
  const products = extractProducts(report);

  const files: FileEntry[] = [];

  const index = {
    generatedAt: new Date().toISOString(),
    artifactName: 'wordpress-project',
    modelKind: 'canonical-site-model',
    targetHint: 'wordpress',
    score: report.score,
    platform: report.siteModel?.platform ?? { detected: [], sourceTechnologyIndependent: true },
    theme: report.siteModel?.theme ?? { type: 'unknown', confidence: 0, evidence: [] },
    builder: report.siteModel?.builder ?? { secondary: [] },
    header: report.siteModel?.header ?? {},
    footer: report.siteModel?.footer ?? {},
    navigation: report.siteModel?.navigation ?? [],
    globalStyles: report.siteModel?.globalStyles ?? {},
    components: report.siteModel?.components ?? [],
    plugins: report.siteModel?.plugins ?? [],
    forms: report.siteModel?.forms ?? [],
    widgets: report.siteModel?.widgets ?? [],
    wordpressConfiguration: report.siteModel?.wordpressConfiguration ?? {},
    media: report.siteModel?.media ?? [],
    seo: report.siteModel?.seo ?? {},
    relationships: report.siteModel?.relationships ?? [],
    pages: report.pages.map((page) => {
      const slug = pageSlug(page);
      return { slug, sourceUrl: page.url, title: page.title ?? page.headings.h1[0] ?? slug };
    }),
    menus: [{ name: 'Primary', items: report.pages.slice(0, 20).map((page) => ({ title: page.title ?? pageSlug(page), slug: pageSlug(page) })) }],
    categories: [...new Set(products.flatMap((product) => product.categories))],
    productValidation: report.summary.productValidation,
    seoConfiguration: {
      duplicateTitles: report.summary.duplicateTitles,
      duplicateDescriptions: report.summary.duplicateDescriptions,
      defaultIndexability: 'indexable',
    },
  };
  files.push({ name: 'wordpress/index.json', content: Buffer.from(JSON.stringify(index, null, 2)) });

  for (const page of report.pages) {
    const slug = pageSlug(page);
    const pageFile = {
      slug, sourceUrl: page.url, title: page.title ?? page.headings.h1[0] ?? slug,
      metaDescription: page.metaDescription ?? '', canonical: page.canonical ?? page.finalUrl,
      headings: page.headings, images: page.images,
      links: { internal: page.internalLinks, external: page.externalLinks },
      seo: { indexability: page.indexability, robots: page.robots ?? '', issues: page.issues, structuredDataTypes: page.structuredDataTypes },
      layout: page.siteModel?.layout ?? [], components: page.siteModel?.components ?? [],
      forms: page.siteModel?.forms ?? [], widgets: page.siteModel?.widgets ?? [],
      mediaRefs: page.images.map((image) => `media:${image.src}`),
      productRefs: page.products.map((product) => `product:${product.id ?? product.sku ?? product.url ?? product.name ?? 'product'}`),
      relationships: page.siteModel?.relationships ?? [],
      content: page.pageContent,
      html: page.pageHtml,
      htmlRef: `../../raw/pages/${slug}.html`,
      computedStyles: page.computedStyles,
      visual: page.screenshot ? {
        screenshotRef: `../../visual/pages/${slug}.png`,
        contentType: page.screenshot.contentType,
        viewport: page.screenshot.viewport,
        fullPage: page.screenshot.fullPage,
        capturedAt: page.screenshot.capturedAt,
      } : undefined,
    };
    files.push({ name: `wordpress/pages/${slug}.json`, content: Buffer.from(JSON.stringify(pageFile, null, 2)) });
  }

  files.push({ name: 'wordpress/products.json', content: Buffer.from(JSON.stringify(products, null, 2)) });
  files.push({ name: 'wordpress/woocommerce-products.csv', content: Buffer.from(toWooCommerceCsv(products)) });

  return files;
}

/**
 * Recreates the deployment-only artifacts from an already completed Phase 1
 * reconstruction. Older preview-first jobs can have a complete local mirror
 * while lacking the WordPress/product files. Reusing the canonical page models
 * avoids a second crawl and, importantly, does not overwrite captured HTML or
 * downloaded resources.
 */
export function restoreDeploymentArtifactsFromReconstruction(jobId: string): string[] {
  const jobDir = path.join(EXPORT_DIR, jobId);
  const manifestPath = path.join(jobDir, 'reconstruction-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('Cannot restore deployment artifacts: reconstruction-manifest.json is missing.');
  }

  const reconstruction = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    pages?: Array<{ slug?: string; sourceUrl?: string; finalUrl?: string; model?: string; html?: string; screenshot?: string }>;
  };
  const manifestPages = Array.isArray(reconstruction.pages) ? reconstruction.pages : [];
  if (manifestPages.length === 0) {
    throw new Error('Cannot restore deployment artifacts: the reconstruction contains no captured pages.');
  }

  type StoredPageModel = {
    slug?: string;
    sourceUrl?: string;
    finalUrl?: string;
    title?: string;
    metaDescription?: string;
    canonical?: string;
    robots?: string;
    headings?: { h1?: string[]; h2?: string[]; h3?: string[]; h4?: string[]; h5?: string[]; h6?: string[] };
    structuredDataTypes?: string[];
    visibleText?: string;
    links?: { internal?: string[]; external?: string[] };
    media?: { images?: Array<Record<string, unknown>> };
    commerce?: { products?: ProductData[]; productRefs?: string[] };
    design?: {
      computedStyles?: Array<{ selector: string; styles: Record<string, string> }>;
      layout?: unknown[];
      components?: unknown[];
      forms?: unknown[];
      widgets?: unknown[];
    };
    visual?: Record<string, unknown>;
  };

  const pages = manifestPages.map((entry, index) => {
    const modelPath = entry.model ? path.join(jobDir, entry.model) : '';
    if (!modelPath || !fs.existsSync(modelPath)) {
      throw new Error(`Cannot restore deployment artifacts: page model is missing for ${entry.sourceUrl ?? entry.slug ?? index}.`);
    }
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8')) as StoredPageModel;
    const slug = model.slug ?? entry.slug ?? `page-${index + 1}`;
    return { entry, model, slug };
  });

  const products = mergeProducts(pages.flatMap(({ model }) => model.commerce?.products ?? [])).products;
  const categories = [...new Set(products.flatMap((product) => product.categories ?? []))];
  const publicManifestPath = path.join(jobDir, 'manifest.json');
  const publicManifest = fs.existsSync(publicManifestPath)
    ? JSON.parse(fs.readFileSync(publicManifestPath, 'utf8')) as { score?: number }
    : {};

  const wpRoot = path.join(jobDir, 'wordpress');
  const wpPages = path.join(wpRoot, 'pages');
  fs.mkdirSync(wpPages, { recursive: true });

  const index = {
    generatedAt: new Date().toISOString(),
    artifactName: 'wordpress-project',
    modelKind: 'canonical-site-model',
    targetHint: 'wordpress',
    score: publicManifest.score ?? 0,
    platform: { detected: [], sourceTechnologyIndependent: true },
    theme: { type: 'captured-source', confidence: 1, evidence: ['reconstruction-manifest.json'] },
    builder: { secondary: [] },
    header: {},
    footer: {},
    navigation: [],
    globalStyles: {},
    components: [],
    plugins: [],
    forms: [],
    widgets: [],
    wordpressConfiguration: {},
    media: [],
    seo: {},
    relationships: [],
    pages: pages.map(({ entry, model, slug }) => ({
      slug,
      sourceUrl: model.sourceUrl ?? entry.sourceUrl,
      title: model.title ?? slug,
    })),
    menus: [{
      name: 'Primary',
      items: pages.slice(0, 20).map(({ model, slug }) => ({ title: model.title ?? slug, slug })),
    }],
    categories,
    productValidation: { valid: products.length, invalid: 0, total: products.length, errors: [] },
    seoConfiguration: { duplicateTitles: [], duplicateDescriptions: [], defaultIndexability: 'indexable' },
  };
  fs.writeFileSync(path.join(wpRoot, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

  for (const { entry, model, slug } of pages) {
    const pageFile = {
      slug,
      sourceUrl: model.sourceUrl ?? entry.sourceUrl,
      title: model.title ?? slug,
      metaDescription: model.metaDescription ?? '',
      canonical: model.canonical ?? model.finalUrl ?? entry.finalUrl,
      headings: model.headings ?? { h1: [], h2: [], h3: [], h4: [], h5: [], h6: [] },
      images: model.media?.images ?? [],
      links: { internal: model.links?.internal ?? [], external: model.links?.external ?? [] },
      seo: {
        indexability: 'indexable',
        robots: model.robots ?? '',
        issues: [],
        structuredDataTypes: model.structuredDataTypes ?? [],
      },
      modelRef: `page:${slug}`,
      layout: model.design?.layout ?? [],
      components: model.design?.components ?? [],
      forms: model.design?.forms ?? [],
      widgets: model.design?.widgets ?? [],
      mediaRefs: (model.media?.images ?? []).map((image) => `media:${String(image.src ?? '')}`).filter((value) => value !== 'media:'),
      productRefs: model.commerce?.productRefs ?? [],
      relationships: [],
      content: model.visibleText ?? '',
      htmlRef: entry.html ? `../../${entry.html.replaceAll('\\', '/')}` : `../../raw/pages/${slug}.html`,
      computedStyles: model.design?.computedStyles ?? [],
      visual: model.visual,
    };
    fs.writeFileSync(path.join(wpPages, `${slug}.json`), JSON.stringify(pageFile, null, 2), 'utf8');
  }

  const productJson = JSON.stringify(products, null, 2);
  const productCsv = toWooCommerceCsv(products);
  fs.writeFileSync(path.join(jobDir, 'products.json'), productJson, 'utf8');
  fs.writeFileSync(path.join(jobDir, 'woocommerce-products.csv'), productCsv, 'utf8');
  fs.writeFileSync(path.join(wpRoot, 'products.json'), productJson, 'utf8');
  fs.writeFileSync(path.join(wpRoot, 'woocommerce-products.csv'), productCsv, 'utf8');

  return [
    path.join(wpRoot, 'index.json'),
    path.join(jobDir, 'products.json'),
    path.join(jobDir, 'woocommerce-products.csv'),
  ];
}
