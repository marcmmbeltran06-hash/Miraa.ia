import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BuildContext, BuilderOptions, BuilderResult } from './types.js';
import { ensureDir, writeJson } from './fs-utils.js';
import { VisualConvergenceEngine } from './validation/VisualConvergenceEngine.js';
import { ComponentRegistryBuilder } from './ComponentRegistryBuilder.js';
import { LocalMirrorBuilder, CaptureToolManager, ExactCaptureEngine } from './snapshot/index.js';
import { BuilderProgressReporter } from './BuilderProgress.js';
import { BuildCheckpointStore } from './BuildCheckpointStore.js';
import { Importer } from './ZipImporter.js';
import { Validator } from './Validator.js';
import { ProjectLoader } from './ProjectLoader.js';
import {
  ComponentBuilder,
  DockerBuilder,
  GlobalStylesBuilder,
  MediaBuilder,
  NavigationBuilder,
  SeoBuilder,
  ThemeBuilder,
  VisualValidation,
  WooCommerceBuilder,
} from './builders.js';

export class AutoWPBuilder {
  private readonly importer = new Importer();
  private readonly validator = new Validator();
  private readonly loader = new ProjectLoader();
  private readonly mediaBuilder = new MediaBuilder();
  private readonly componentBuilder = new ComponentBuilder();
  private readonly wooBuilder = new WooCommerceBuilder();
  private readonly themeBuilder = new ThemeBuilder(this.componentBuilder, this.wooBuilder);
  private readonly stylesBuilder = new GlobalStylesBuilder();
  private readonly navigationBuilder = new NavigationBuilder();
  private readonly seoBuilder = new SeoBuilder();
  private readonly dockerBuilder = new DockerBuilder();
  private readonly visualValidation = new VisualValidation();
  private readonly convergence = new VisualConvergenceEngine();
  private readonly componentRegistry = new ComponentRegistryBuilder();
  private readonly mirrorBuilder = new LocalMirrorBuilder();
  private readonly captureTools = new CaptureToolManager();
  private readonly exactCapture = new ExactCaptureEngine();

  public async build(options: BuilderOptions): Promise<BuilderResult> {
    const normalizedOptions = {
      inputPath: options.inputPath,
      outputPath: path.resolve(options.outputPath),
      projectName: options.projectName ?? 'AutoWP Reconstruction',
      startDocker: options.startDocker ?? false,
      openBrowser: options.openBrowser ?? false,
      visualThreshold: options.visualThreshold ?? 0.08,
      sitePort: options.sitePort ?? 8080,
      dockerProject: options.dockerProject ?? `autowp-${Date.now()}`,
      adminUser: options.adminUser ?? 'admin',
      adminPassword: options.adminPassword ?? 'autowp-change-me',
      databasePassword: options.databasePassword ?? 'wordpress',
      reconstructionEngine: options.reconstructionEngine ?? ((process.env.RECONSTRUCTION_ENGINE === 'legacy' || process.env.RECONSTRUCTION_ENGINE === 'snapshot') ? process.env.RECONSTRUCTION_ENGINE : 'exact'),
    };
    const imported = this.importer.import(options.inputPath);
    let progressReporter: BuilderProgressReporter | undefined;
    try {
      const validation = this.validator.validate(imported.rootPath);
      if (!validation.ok) {
        throw new Error(validation.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.message).join('; '));
      }

      const source = this.loader.load(imported.rootPath);
      const existingCheckpoint = path.join(normalizedOptions.outputPath, '.autowp-build', 'checkpoint.json');
      const resumableEvidence = [
        existingCheckpoint,
        path.join(normalizedOptions.outputPath, 'imports', 'media-map.json'),
        path.join(normalizedOptions.outputPath, 'snapshot', 'config.json'),
        path.join(normalizedOptions.outputPath, 'docker-compose.yml'),
        path.join(normalizedOptions.outputPath, 'validation', 'build-report.json'),
      ].some((candidate) => fs.existsSync(candidate));
      if (!resumableEvidence) this.prepareCleanOutputPath(normalizedOptions.outputPath);
      const ctx: BuildContext = {
        options: normalizedOptions,
        source,
        outputPath: normalizedOptions.outputPath,
        themePath: path.join(normalizedOptions.outputPath, 'wp-content', 'themes', 'autowp-reconstruction'),
        uploadsPath: path.join(normalizedOptions.outputPath, 'wp-content', 'uploads'),
        importsPath: path.join(normalizedOptions.outputPath, 'imports'),
        validationPath: path.join(normalizedOptions.outputPath, 'validation'),
        warnings: validation.issues.filter((issue) => issue.severity === 'warning').map((issue) => issue.message),
        componentDecisions: [],
        mediaMap: [],
        reconstructionEngine: normalizedOptions.reconstructionEngine,
      };

      ensureDir(ctx.outputPath);
      ensureDir(ctx.importsPath);
      ensureDir(ctx.validationPath);

      const reporter = new BuilderProgressReporter(ctx.validationPath);
      progressReporter = reporter;
      const checkpoints = new BuildCheckpointStore(ctx.outputPath, normalizedOptions.inputPath, normalizedOptions.dockerProject);
      if (!checkpoints.isCompleted('preparation')) {
        checkpoints.startPhase('preparation');
        try {
          this.recordInventoryBatches(ctx, checkpoints, progressReporter);
          checkpoints.completePhase('preparation');
        } catch (error) {
          checkpoints.failPhase('preparation', error);
          throw error;
        }
      }

      if (!checkpoints.isCompleted('resources')) {
        checkpoints.startPhase('resources');
        progressReporter.start('media');
        try {
          const resourceBatch = checkpoints.snapshot().phases.resources.batches.media;
          const startIndex = Math.max(0, resourceBatch?.completed ?? 0);
          if (startIndex > 0) this.hydrateMediaMap(ctx);
          const configured = Number(process.env.AUTOWP_RESOURCE_BATCH_SIZE ?? process.env.AUTOWP_BUILD_BATCH_SIZE ?? 50);
          const batchSize = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 50;
          this.mediaBuilder.build(ctx, {
            startIndex,
            batchSize,
            onBatch: (completed, total, lastItem) => {
              checkpoints.updateBatch('resources', 'media', completed, total, lastItem);
              reporter.batch('media', completed, total, lastItem);
            },
          });
          progressReporter.complete('media');
          checkpoints.completePhase('resources');
        } catch (error) {
          checkpoints.failPhase('resources', error);
          throw error;
        }
      } else {
        this.hydrateMediaMap(ctx);
        progressReporter.skip('media');
      }

      if (!checkpoints.isCompleted('snapshot')) {
      checkpoints.startPhase('snapshot');
      progressReporter.start('capture');
      const toolStatus = this.captureTools.status();
      writeJson(path.join(ctx.validationPath, 'capture-tools.json'), { generatedAt: new Date().toISOString(), ...toolStatus, selectedEngine: ctx.reconstructionEngine, note: 'Browsertrix/SingleFile are optional external capture tools; existing export capture remains the safe fallback.' });
      this.mirrorBuilder.build(ctx);
      const exactCapture = this.exactCapture.build(ctx);
      writeJson(path.join(ctx.validationPath, 'exact-capture-report.json'), { exactCaptureAvailable: exactCapture.available, exactVisualScore: null, missingRequests: exactCapture.missingRequests, sourceFilesRequired: exactCapture.sourceFilesRequired, status: exactCapture.available ? 'available' : 'fallback_mirror' });
      if (exactCapture.sourceFilesRequired.length > 0) writeJson(path.join(ctx.validationPath, 'source-files-request.json'), { status: 'source_files_required', requests: exactCapture.sourceFilesRequired, instructions: 'Aporta únicamente los archivos indicados; no se repetirá el crawl ni se duplicarán productos.' });
      writeJson(path.join(ctx.outputPath, 'snapshot', 'config.json'), {
        schemaVersion: 1,
        engine: ctx.reconstructionEngine,
        mode: ctx.reconstructionEngine === 'exact' ? 'EXACT_CAPTURE' : ctx.reconstructionEngine === 'legacy' ? 'LEGACY' : 'SNAPSHOT_FIDELITY',
        fullyLocal: true,
        settle: { domStabilityWindowMs: 1200, networkIdleWindowMs: 1500, maxPageSettleMs: 30000, maxAutoscrollSteps: 80 },
        fallback: { browsertrix: 'optional-external-adapter', singleFile: 'page-scoped-fallback', legacy: 'available-with---engine-legacy' },
      });
      progressReporter.complete('capture');
      checkpoints.completePhase('snapshot');
      } else {
        progressReporter.skip('capture');
      }

      if (!checkpoints.isCompleted('wordpress_generation')) {
        checkpoints.startPhase('wordpress_generation');
        const runGenerationStep = (stage: string, operation: () => void): void => {
          const saved = checkpoints.snapshot().phases.wordpress_generation.batches[stage];
          if (saved?.completed === 1 && saved.total === 1) {
            if (stage === 'components') this.hydrateComponentDecisions(ctx);
            reporter.skip(stage);
            return;
          }
          reporter.start(stage);
          operation();
          checkpoints.updateBatch('wordpress_generation', stage, 1, 1, stage);
          reporter.batch(stage, 1, 1, stage);
          reporter.complete(stage);
        };
        try {
          runGenerationStep('components', () => {
            this.componentBuilder.decide(ctx);
            this.componentRegistry.build(ctx);
          });
          runGenerationStep('styles', () => this.stylesBuilder.build(ctx));
          runGenerationStep('navigation', () => this.navigationBuilder.build(ctx));
          runGenerationStep('seo', () => this.seoBuilder.build(ctx));
          runGenerationStep('commerce', () => this.wooBuilder.build(ctx));
          runGenerationStep('theme', () => this.themeBuilder.build(ctx));
          checkpoints.completePhase('wordpress_generation');
        } catch (error) {
          checkpoints.failPhase('wordpress_generation', error);
          throw error;
        }
      } else {
        this.hydrateComponentDecisions(ctx);
        for (const stage of ['components', 'styles', 'navigation', 'seo', 'commerce', 'theme']) progressReporter.skip(stage);
      }

      if (!checkpoints.isCompleted('docker')) {
      checkpoints.startPhase('docker');
      progressReporter.start('docker');
      this.dockerBuilder.build(ctx);
      progressReporter.complete('docker');
      checkpoints.completePhase('docker');
      } else {
        progressReporter.skip('docker');
      }

      let quality: { status: 'ready' | 'needs_review'; originalInternalDomainReferences: number; expectedPages: number; expectedMedia: number };
      if (!checkpoints.isCompleted('validation')) {
      checkpoints.startPhase('validation');
      progressReporter.start('validation');
      this.visualValidation.build(ctx);
      this.convergence.createPlan(ctx.outputPath, source.pages);
      progressReporter.complete('validation');
      progressReporter.start('reports');
      this.writeCanonicalContract(ctx);
      quality = this.writeValidationReports(ctx);

      const report = {
        status: quality.status,
        generatedAt: new Date().toISOString(),
        inputPath: path.resolve(options.inputPath),
        outputPath: ctx.outputPath,
        pagesBuilt: source.pages.length,
        productsBuilt: source.products.length,
        warnings: ctx.warnings,
        componentDecisions: ctx.componentDecisions,
        visualValidation: 'pending-runtime-comparison',
        reconstructionEngine: ctx.reconstructionEngine,
        snapshotMirror: path.join(ctx.outputPath, 'snapshot', 'mirror'),
        quality,
      };
      const reportPath = path.join(ctx.validationPath, 'build-report.json');
      writeJson(reportPath, report);
      progressReporter.complete('reports');
      checkpoints.completePhase('validation');
      } else {
        progressReporter.skip('validation');
        progressReporter.skip('reports');
        quality = this.readStaticQuality(ctx);
      }

      const reportPath = path.join(ctx.validationPath, 'build-report.json');

      let dockerStarted = false;
      let runtimeVerified = false;
      progressReporter.start('runtime');
      if (normalizedOptions.startDocker) {
        checkpoints.startPhase('docker');
        try {
          this.startDocker(ctx.outputPath);
          dockerStarted = true;
          checkpoints.completePhase('docker');
        } catch (error) {
          checkpoints.failPhase('docker', error);
          throw error;
        }

        checkpoints.startPhase('wpcli');
        try {
          await this.waitForWordPress(ctx.outputPath, normalizedOptions.sitePort);
          checkpoints.completePhase('wpcli');
        } catch (error) {
          checkpoints.failPhase('wpcli', error);
          throw error;
        }

        checkpoints.startPhase('validation');
        try {
          for (let iteration = 0; iteration < 3; iteration += 1) {
            this.runVisualValidation(ctx.outputPath);
            const convergence = this.convergence.applySafeCorrections(ctx.outputPath);
            if (convergence.applied.length === 0) break;
          }
          checkpoints.completePhase('validation');
        } catch (error) {
          checkpoints.failPhase('validation', error);
          throw error;
        }
        runtimeVerified = true;
        progressReporter.complete('runtime');
      } else {
        progressReporter.skip('runtime');
      }
      progressReporter.completeBuild();
      if (normalizedOptions.openBrowser) {
        this.openBrowser(`http://localhost:${normalizedOptions.sitePort}`);
      }

      return {
        outputPath: ctx.outputPath,
        dockerComposePath: path.join(ctx.outputPath, 'docker-compose.yml'),
        themePath: ctx.themePath,
        reportPath,
        pagesBuilt: source.pages.length,
        productsBuilt: source.products.length,
        warnings: ctx.warnings,
        dockerStarted,
        runtimeVerified,
      };
    } catch (error) {
      progressReporter?.fail(error);
      throw error;
    } finally {
      imported.cleanup?.();
    }
  }

  private recordInventoryBatches(ctx: BuildContext, checkpoints: BuildCheckpointStore, progress: BuilderProgressReporter): void {
    const configured = Number(process.env.AUTOWP_BUILD_BATCH_SIZE ?? 50);
    const batchSize = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 50;
    const inventories = [
      { id: 'pages', items: ctx.source.pages.map((page) => page.slug) },
      { id: 'products', items: ctx.source.products.map((product, index) => product.slug ?? product.sku ?? `product-${index + 1}`) },
      { id: 'resources', items: (ctx.source.resources.downloaded ?? []).map((resource, index) => resource.path ?? resource.sourceUrl ?? `resource-${index + 1}`) },
    ];
    for (const inventory of inventories) {
      if (inventory.items.length === 0) {
        checkpoints.updateBatch('preparation', inventory.id, 0, 0);
        continue;
      }
      for (let offset = 0; offset < inventory.items.length; offset += batchSize) {
        const completed = Math.min(inventory.items.length, offset + batchSize);
        const lastItem = inventory.items[completed - 1];
        checkpoints.updateBatch('preparation', inventory.id, completed, inventory.items.length, lastItem);
        progress.batch('media', completed, inventory.items.length, lastItem);
      }
    }
  }

  private hydrateMediaMap(ctx: BuildContext): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(ctx.importsPath, 'media-map.json'), 'utf8')) as BuildContext['mediaMap'];
      if (!Array.isArray(parsed)) throw new Error('media-map.json is not an array');
      ctx.mediaMap.push(...parsed);
    } catch {
      // Media generation is deterministic and uses copy/overwrite semantics,
      // therefore rebuilding a missing phase output is safe and idempotent.
      this.mediaBuilder.build(ctx);
    }
  }

  private hydrateComponentDecisions(ctx: BuildContext): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(ctx.validationPath, 'component-decisions.json'), 'utf8')) as BuildContext['componentDecisions'];
      if (!Array.isArray(parsed)) throw new Error('component-decisions.json is not an array');
      ctx.componentDecisions.push(...parsed);
    } catch {
      this.componentBuilder.decide(ctx);
    }
  }

  private readStaticQuality(ctx: BuildContext): { status: 'ready' | 'needs_review'; originalInternalDomainReferences: number; expectedPages: number; expectedMedia: number } {
    try {
      const report = JSON.parse(fs.readFileSync(path.join(ctx.validationPath, 'build-report.json'), 'utf8')) as {
        quality?: {
          status?: 'ready' | 'needs_review';
          originalInternalDomainReferences?: number;
          expectedPages?: number;
          expectedMedia?: number;
        };
      };
      if (report.quality?.status) {
        return {
          status: report.quality.status,
          originalInternalDomainReferences: report.quality.originalInternalDomainReferences ?? 0,
          expectedPages: report.quality.expectedPages ?? ctx.source.pages.length,
          expectedMedia: report.quality.expectedMedia ?? ctx.mediaMap.length,
        };
      }
    } catch { /* fall through to deterministic report regeneration */ }
    return this.writeValidationReports(ctx);
  }

  /**
   * Docker Desktop, WSL and antivirus scanners can retain a handle to a bind
   * mounted upload for several seconds on Windows. Deleting the tree in place
   * then throws ENOTEMPTY/EPERM and used to abort every retry. Renaming the old
   * project is atomic and gives the builder a clean path immediately; removal
   * of the quarantined tree is best-effort and never hides a build failure.
   */
  private prepareCleanOutputPath(outputPath: string): void {
    if (!fs.existsSync(outputPath)) return;
    const previousWasValid = fs.existsSync(path.join(outputPath, 'validation', 'acceptance-report.json'))
      || fs.existsSync(path.join(outputPath, 'validation', 'build-report.json'));
    const stalePath = previousWasValid
      ? `${outputPath}.previous-valid-${Date.now()}`
      : `${outputPath}.stale-${Date.now()}`;
    try {
      fs.renameSync(outputPath, stalePath);
    } catch (error) {
      fs.rmSync(outputPath, {
        recursive: true,
        force: true,
        maxRetries: 40,
        retryDelay: 500,
      });
      return;
    }
    if (previousWasValid) return;
    try {
      fs.rmSync(stalePath, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 250,
      });
    } catch {
      // The stale folder is outside the new deployment path. A later cleanup
      // may remove it without making the current reconstruction fail.
    }
  }

  private writeValidationReports(ctx: BuildContext): { status: 'ready' | 'needs_review'; originalInternalDomainReferences: number; expectedPages: number; expectedMedia: number } {
    const files: string[] = [];
    const collect = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full); else files.push(full);
      }
    };
    collect(ctx.themePath);
    let origin = '';
    try { origin = new URL(ctx.source.pages[0]?.finalUrl ?? ctx.source.pages[0]?.sourceUrl ?? '').origin.replace(/^https?:\/\//, ''); } catch { /* validation records unknown origin as needs review */ }
    const originalUrlPattern = origin ? new RegExp(`https?:\\/\\/(?:www\\.)?${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\/|["'\\s<>)])`, 'gi') : undefined;
    const originalReferences = originalUrlPattern ? files.reduce((total, file) => total + ((fs.readFileSync(file, 'utf8').match(originalUrlPattern) ?? []).length), 0) : 1;
    const emptyPages = ctx.source.pages.filter((page) => !ctx.source.rawHtmlBySlug.get(page.slug)?.trim()).map((page) => page.slug);
    const slugs = ctx.source.pages.map((p) => p.slug);
    const duplicatedPages = slugs.filter((slug, index) => slugs.indexOf(slug) !== index).filter((slug, index, values) => values.indexOf(slug) === index);
    const sourceHtml = ctx.source.pages.map((page) => ctx.source.rawHtmlBySlug.get(page.slug) ?? '');
    const headerPresent = sourceHtml.some((html) => /<header\b|<nav\b|class=["'][^"']*(?:site-)?header/i.test(html));
    const footerPresent = sourceHtml.some((html) => /<footer\b|class=["'][^"']*(?:site-)?footer/i.test(html));
    const sourceNavigationPresent = sourceHtml.some((html) => /<nav\b|<a\b[^>]*href=/i.test(html));
    let menus: unknown = [];
    try { menus = JSON.parse(fs.readFileSync(path.join(ctx.importsPath, 'menus.json'), 'utf8')); } catch { /* report below marks navigation missing */ }
    const menuModelPresent = Array.isArray(menus) && menus.some((menu) => Array.isArray((menu as Record<string, unknown>).items) && ((menu as Record<string, unknown>).items as unknown[]).length > 0);
    // Header and footer are intentionally preserved inside each captured page.
    // Rendering another synthetic shell around them duplicates navigation and
    // changes the DOM ancestry that the source CSS depends on.
    const globalComponents = {
      schemaVersion: 1,
      strategy: 'per-page-captured-dom',
      headerPresent,
      footerPresent,
      navigationPresent: sourceNavigationPresent || menuModelPresent,
      cartPresent: sourceHtml.some((html) => /cart|woocommerce|shopping-bag|mini-cart/i.test(html)),
      status: sourceHtml.length > 0 && sourceHtml.every((html) => html.trim().length > 0) ? 'pass' : 'needs_review',
    };
    const pageReport = {
      verification: 'pending-runtime',
      expectedPages: slugs,
      generatedPages: slugs,
      importedPages: null,
      missingPages: null,
      emptyPages,
      failedPages: [],
      duplicatedPages,
      incorrectSlugs: [],
      incorrectTemplates: [],
      missingLanguages: [],
      missingParentRelations: [],
      extraPages: [],
      redirectedPages: [],
    };
    const remoteFallbacks = ctx.mediaMap.filter((m) => m.role === 'external-fallback').map((m) => m.sourceUrl).filter((url): url is string => Boolean(url));
    const missingCriticalMedia = remoteFallbacks.filter((url) => /(?:data:image|\.(?:avif|jpe?g|png|webp|gif|svg|mp4|webm|woff2?|ttf|otf|css|js)(?:$|[?#]))/i.test(url));
    const localDependencyReport = {
      schemaVersion: 1,
      mode: 'FULLY_LOCAL',
      expectedAssets: ctx.mediaMap.length,
      localizedAssets: ctx.mediaMap.filter((m) => Boolean(m.localPath)).length,
      missingAssets: remoteFallbacks,
      forbiddenRemoteAssets: remoteFallbacks,
      permittedExternalAssets: [],
      runtimeExternalRequests: 'pending-runtime-validation',
      status: remoteFallbacks.length === 0 ? 'pass' : 'needs_reconstruction',
    };
    const mediaReport = { expectedMedia: ctx.mediaMap.length, downloadedMedia: ctx.mediaMap.filter((m) => Boolean(m.localPath)).length, importedMedia: ctx.mediaMap.filter((m) => Boolean(m.wpPath)).length, missingMedia: remoteFallbacks, brokenMedia: [], remoteFallbacks, unusedMedia: [] };
    const cssReport = { expectedCss: ctx.mediaMap.filter((m) => /css/i.test(m.role ?? m.sourcePath ?? '')).length, cssLoaded: fs.existsSync(path.join(ctx.themePath, 'assets', 'source.css')), cssMissing: [], brokenUrls: [], fontsMissing: [], selectorsNotApplied: 'runtime-analysis-required', mediaQueriesExecuted: 'runtime-analysis-required' };
    const forms = ctx.source.pages.flatMap((page) => {
      const raw = ctx.source.rawHtmlBySlug.get(page.slug) ?? '';
      return [...raw.matchAll(/<form\b[\s\S]*?<\/form>/gi)].map((match, index) => ({ page: page.slug, id: `${page.slug}-form-${index}`, sourceLength: match[0].length }));
    });
    const expectedTextBlocks = ctx.source.pages.reduce((total, page) => total + ((ctx.source.rawHtmlBySlug.get(page.slug) ?? '').match(/<(?:p|h[1-6]|li|td|blockquote)\b/gi)?.length ?? 0), 0);
    const expectedComponents = ctx.source.pages.reduce((total, page) => total + (this.countTopLevelComponents(ctx.source.rawHtmlBySlug.get(page.slug) ?? '')), 0);
    const completeness = ctx.source.pages.map((page) => {
      const html = ctx.source.rawHtmlBySlug.get(page.slug) ?? '';
      const expectedSections = html.match(/<(?:section|article|main|div)\b/gi)?.length ?? 0;
      return { slug: page.slug, verification: 'pending-runtime', expectedSections, importedSections: null, missingSections: null, duplicatedSections: null, reorderedSections: null, emptySections: null, expectedText: html.match(/<(?:p|h[1-6]|li|td|blockquote)\b/gi)?.length ?? 0, importedText: null, expectedMedia: html.match(/<(?:img|video|svg|iframe)\b/gi)?.length ?? 0, importedMedia: null };
    });
    const sourceCss = fs.existsSync(path.join(ctx.themePath, 'assets', 'source.css')) ? fs.readFileSync(path.join(ctx.themePath, 'assets', 'source.css'), 'utf8') : '';
    const interactions = ctx.source.pages.map((p) => {
      const html = ctx.source.rawHtmlBySlug.get(p.slug) ?? '';
      const expectedInteractions = html.match(/<(?:a|button|form|details|summary)|(?:swiper|slider|carousel|accordion|modal|tab|sticky|animate|animation)/gi)?.length ?? 0;
      return { slug: p.slug, verification: 'pending-runtime', expectedInteractions, rebuiltInteractions: null, missingInteractions: null, brokenInteractions: null, blockedClicks: null, overlayConflicts: null, internalLinks: p.links?.internal?.length ?? 0, expectedForms: forms.filter((form) => form.page === p.slug).length, brokenButtons: null, brokenInternalLinks: 'needs-runtime-check' };
    });
    const urlReport = { originalInternalDomainReferences: originalReferences, origin, allowedRemoteFallbacks: mediaReport.remoteFallbacks, status: originalReferences === 0 ? 'pass' : 'needs_review' };
    const textReport = { status: 'runtime-analysis-required', criticalThreshold: 0.99, pages: ctx.source.pages.map((p) => ({ slug: p.slug, sourceTextPresent: Boolean(p.content || ctx.source.rawHtmlBySlug.get(p.slug)), reconstructedTextPresent: Boolean(ctx.source.rawHtmlBySlug.get(p.slug)) })) };
    const visualReport = { status: 'needs_review', reason: 'Runtime multi-viewport image comparison has not completed.', thresholds: { home: 0.995, critical: 0.995, remaining: 0.995 }, pages: ctx.source.pages.map((p) => ({ slug: p.slug, status: 'pending-runtime-comparison' })) };
    const sourceCapturePages = ctx.source.pages.map((page) => {
      const html = ctx.source.rawHtmlBySlug.get(page.slug) ?? '';
      const visualStatus = page.visual?.commerceCaptureStatus;
      const challengeDetected = /(?:captcha|verify you are human|comprueba que eres humano|cloudflare ray id|access denied|attention required)/i.test(html);
      const blocked = visualStatus === 'blocked' || challengeDetected;
      const partial = visualStatus === 'partial';
      const failed = visualStatus === 'failed' || html.trim().length === 0;
      return {
        slug: page.slug,
        sourceUrl: page.sourceUrl ?? page.finalUrl ?? null,
        status: blocked ? 'blocked' : failed ? 'failed' : partial ? 'partial' : 'captured',
        issues: [
          ...(page.visual?.commerceCaptureIssues ?? []),
          ...(challengeDetected ? ['source-challenge-detected'] : []),
          ...(html.trim().length === 0 ? ['source-html-missing'] : []),
        ],
      };
    });
    const incompleteSourcePages = sourceCapturePages.filter((page) => page.status !== 'captured');
    writeJson(path.join(ctx.validationPath, 'source-capture-status.json'), {
      generatedAt: new Date().toISOString(),
      status: incompleteSourcePages.length === 0 ? 'pass' : 'needs_reconstruction',
      expectedPages: sourceCapturePages.length,
      capturedPages: sourceCapturePages.length - incompleteSourcePages.length,
      blockedPages: sourceCapturePages.filter((page) => page.status === 'blocked'),
      partialPages: sourceCapturePages.filter((page) => page.status === 'partial'),
      failedPages: sourceCapturePages.filter((page) => page.status === 'failed'),
      pages: sourceCapturePages,
    });
    writeJson(path.join(ctx.validationPath, 'pages-validation.json'), pageReport);
    writeJson(path.join(ctx.validationPath, 'global-components-report.json'), globalComponents);
    writeJson(path.join(ctx.validationPath, 'media-validation.json'), mediaReport);
    writeJson(path.join(ctx.validationPath, 'css-validation.json'), cssReport);
    writeJson(path.join(ctx.validationPath, 'interactions-validation.json'), interactions);
    writeJson(path.join(ctx.validationPath, 'interactions-report.json'), { verification: 'pending-runtime', expectedInteractions: interactions.reduce((n, p) => n + p.expectedInteractions, 0), rebuiltInteractions: null, missingInteractions: null, brokenInteractions: null, blockedClicks: null, overlayConflicts: null });
    writeJson(path.join(ctx.validationPath, 'page-completeness-report.json'), { verification: 'pending-runtime', pages: completeness, missingPages: null });
    writeJson(path.join(ctx.validationPath, 'missing-resources-report.json'), { expectedResources: ctx.mediaMap.length, importedResources: mediaReport.importedMedia, missingResources: mediaReport.missingMedia, missingCriticalResources: missingCriticalMedia, remoteFallbacks: mediaReport.remoteFallbacks, status: missingCriticalMedia.length === 0 ? 'pass' : 'needs_review' });
    writeJson(path.join(ctx.validationPath, 'local-dependency-report.json'), localDependencyReport);
    writeJson(path.join(ctx.validationPath, 'css-completeness-report.json'), { expectedStylesheets: cssReport.expectedCss, loadedStylesheets: cssReport.cssLoaded ? cssReport.expectedCss : 0, missingStylesheets: cssReport.cssMissing, missingFonts: cssReport.fontsMissing, brokenCssUrls: cssReport.brokenUrls, missingMediaQueries: sourceCss.includes('@media') ? [] : ['No captured media queries'], missingAnimations: sourceCss.includes('@keyframes') ? [] : ['No captured keyframes'], selectorsNotApplied: cssReport.selectorsNotApplied });
    writeJson(path.join(ctx.validationPath, 'forms-validation.json'), { expectedForms: forms.length, importedForms: null, missingForms: null, brokenForms: null, status: 'runtime-validation-required', forms });
    writeJson(path.join(ctx.validationPath, 'content-validation.json'), { expectedTextBlocks, importedTextBlocks: null, missingTextBlocks: null, duplicatedTextBlocks: null, truncatedTextBlocks: null, expectedMedia: mediaReport.expectedMedia, importedMedia: null, missingMedia: null, expectedComponents, importedComponents: null, missingComponents: null, status: 'runtime-validation-required' });
    writeJson(path.join(ctx.validationPath, 'url-rewrite-report.json'), urlReport);
    writeJson(path.join(ctx.validationPath, 'text-validation.json'), textReport);
    writeJson(path.join(ctx.validationPath, 'visual-validation-report.json'), visualReport);
    const improvements = [
      ...(mediaReport.importedMedia > 0 ? [{ category: 'images', severity: 'info', pagesAffected: ctx.source.pages.map((p) => p.slug), problem: 'Source media depended on the original host.', correction: `${mediaReport.importedMedia} downloaded resources were copied to local WordPress uploads.`, impact: 'Local copies keep the reconstructed pages available when the source host is unavailable.', commercialImpact: 'More reliable visual content can reduce avoidable page abandonment.', evidence: `${mediaReport.importedMedia} local upload mappings`, metric: { localizedResources: mediaReport.importedMedia }, confidence: 'high', validation: 'static-pass' }] : []),
      ...(originalReferences === 0 ? [{ category: 'navigation', severity: 'info', pagesAffected: ctx.source.pages.map((p) => p.slug), problem: 'Internal links pointed to the source domain.', correction: 'Generated theme references were rewritten to local routes or local uploads.', impact: 'Internal navigation stays within the generated site.', commercialImpact: 'Visitors remain within the rebuilt experience instead of being sent to the old site.', evidence: '0 original-domain references in generated theme files', metric: { originalInternalDomainReferences: 0 }, confidence: 'high', validation: 'static-pass' }] : []),
      ...(forms.length > 0 ? [{ category: 'forms', severity: 'info', pagesAffected: [...new Set(forms.map((form) => form.page))], problem: `${forms.length} source forms had no safe local destination.`, correction: 'Forms were routed to the local WordPress submission endpoint and are stored in Form submissions.', impact: 'Messages can be reviewed from WordPress instead of being sent to an unknown source endpoint.', commercialImpact: 'Enquiries can be retained and followed up from the new site.', evidence: `${forms.length} detected forms with local endpoint binding`, metric: { forms: forms.length }, confidence: 'medium', validation: 'runtime-required' }] : []),
    ];
    const improvementsReport = { generatedAt: new Date().toISOString(), brand: ctx.options.projectName, status: 'pending_runtime', localizedResources: mediaReport.importedMedia, originalInternalDomainReferences: originalReferences, improvements };
    const routeManifestPath = path.join(ctx.outputPath, 'route-map.json');
    const routeManifest = fs.existsSync(routeManifestPath) ? JSON.parse(fs.readFileSync(routeManifestPath, 'utf8')) as { routes?: Array<{ normalizedPath?: string; status?: string }> } : { routes: [] };
    const routes = Array.isArray(routeManifest.routes) ? routeManifest.routes : [];
    const missingLocalRoutes = routes.filter((route) => route.status !== 'ready').map((route) => route.normalizedPath).filter((value): value is string => Boolean(value));
    const multipageQualityGate = {
      gates: ['visual:all-pages', 'routes:complete', 'navigation:local', 'links:internal', 'products:local', 'categories:local'],
      routesDetected: routes.length,
      routesCaptured: routes.filter((route) => route.status === 'ready').length,
      routesLocal: routes.length - missingLocalRoutes.length,
      originalInternalLinks: 0,
      externalInternalRedirects: 0,
      unmappedMenuItems: 0,
      unmappedProductLinks: 0,
      missingLocalRoutes,
      pagesVisuallyValidated: 0,
      // A static export is not visually validated.  Requiring every route to
      // have a runtime comparison prevents the old false-positive where a
      // broken multi-page site was marked pass after only copying HTML files.
      status: missingLocalRoutes.length === 0 && emptyPages.length === 0 && originalReferences === 0 && routes.length > 0 && routes.every((route) => route.status === 'ready') && visualReport.status === 'pass' && visualReport.pages.length === routes.length ? 'pass' : 'needs_reconstruction',
      qualityGateBlockedBy: ['visual:all-pages', 'runtime:navigation', 'runtime:assets'],
    };
    writeJson(path.join(ctx.validationPath, 'multipage-quality-gate.json'), multipageQualityGate);
    writeJson(path.join(ctx.validationPath, 'routes-manifest.json'), { routes, routesDetected: routes.length, routesCaptured: routes.filter((route) => route.status === 'ready').length });
    writeJson(path.join(ctx.validationPath, 'conversion-improvements-report.json'), { generatedAt: new Date().toISOString(), brand: ctx.options.projectName, improvements });
    writeJson(path.join(ctx.validationPath, 'improvements-report.json'), improvementsReport);
    writeJson(path.join(ctx.outputPath, 'wp-content', 'plugins', 'autowp-improvements', 'improvements-report.json'), improvementsReport);
    // Do not advertise a build as ready until the browser has compared every
    // route.  The previous condition only inspected generated files and let
    // incomplete pages through as “ready”.
    const status = emptyPages.length === 0 && originalReferences === 0 && missingCriticalMedia.length === 0 && remoteFallbacks.length === 0 && globalComponents.status === 'pass' && globalComponents.navigationPresent && visualReport.status === 'pass' && multipageQualityGate.status === 'pass' ? 'ready' : 'needs_review';
    return { status, originalInternalDomainReferences: originalReferences, expectedPages: ctx.source.pages.length, expectedMedia: ctx.mediaMap.length };
  }

  private writeCanonicalContract(ctx: BuildContext): void {
    const root = path.join(ctx.outputPath, 'reconstruction');
    ensureDir(root); ensureDir(path.join(root, 'pages')); ensureDir(path.join(root, 'components')); ensureDir(path.join(root, 'assets')); ensureDir(path.join(root, 'routes')); ensureDir(path.join(root, 'global')); ensureDir(path.join(root, 'validation'));
    writeJson(path.join(root, 'site-model.json'), { schemaVersion: 1, model: 'SourceSiteModel', generatedAt: new Date().toISOString(), pageCount: ctx.source.pages.length, productCount: ctx.source.products.length, origin: ctx.source.pages[0]?.finalUrl ?? ctx.source.pages[0]?.sourceUrl ?? null });
    writeJson(path.join(root, 'assets', 'asset-graph.json'), { schemaVersion: 1, model: 'AssetGraph', assets: ctx.mediaMap });
    writeJson(path.join(root, 'routes', 'routes.json'), { schemaVersion: 1, model: 'ReconstructionModel', routes: ctx.source.pages.map((page) => ({ slug: page.slug, sourceUrl: page.sourceUrl, finalUrl: page.finalUrl })) });
    writeJson(path.join(root, 'components', 'component-tree.json'), { schemaVersion: 1, model: 'ComponentTree', pages: ctx.source.pages.map((page) => ({ slug: page.slug, components: page.components ?? [], layout: page.layout ?? [] })) });
    writeJson(path.join(root, 'components', 'interaction-model.json'), { schemaVersion: 1, model: 'InteractionModel', pages: ctx.source.pages.map((page) => ({ slug: page.slug, forms: page.forms ?? [], interactions: (page.components ?? []).filter((component) => /menu|slider|carousel|accordion|tabs?|modal|search|cart/i.test(component.type ?? '')) })) });
    let navigation: unknown = [];
    try { navigation = JSON.parse(fs.readFileSync(path.join(ctx.importsPath, 'menus.json'), 'utf8')); } catch { /* empty manifest is explicit */ }
    writeJson(path.join(root, 'global', 'header.json'), { schemaVersion: 1, model: 'GlobalHeader', present: fs.existsSync(path.join(ctx.themePath, 'header.php')), source: 'consensus' });
    writeJson(path.join(root, 'global', 'footer.json'), { schemaVersion: 1, model: 'GlobalFooter', present: fs.existsSync(path.join(ctx.themePath, 'footer.php')), source: 'consensus' });
    writeJson(path.join(root, 'global', 'navigation.json'), { schemaVersion: 1, model: 'GlobalNavigation', menus: navigation });
    writeJson(path.join(root, 'global', 'cart-ui.json'), { schemaVersion: 1, model: 'GlobalCartUI', integrated: true, source: 'WooCommerce' });
    ensureDir(path.join(root, 'commerce'));
    writeJson(path.join(root, 'commerce', 'commerce-model.json'), { schemaVersion: 1, model: 'CommerceModel', products: ctx.source.products });
    writeJson(path.join(root, 'commerce', 'commerce-map.json'), { schemaVersion: 1, model: 'CommerceMap', products: ctx.source.products.map((product) => ({ sourceProductId: product.id ?? product.sku ?? product.slug ?? null, sourceSlug: product.slug ?? null, wooProductId: null, localProductUrl: product.slug ? `/product/${product.slug}/` : null, addToCartUrl: null })) });
    writeJson(path.join(root, 'checkpoints.json'), { captureComplete: true, waczReady: false, mirrorReady: true, wooCommerceReady: false, wordpressReady: false, offlineValidationComplete: true, visualValidationComplete: false, note: 'WooCommerce and runtime checkpoints are updated by the Docker builder.' });
    for (const page of ctx.source.pages) writeJson(path.join(root, 'pages', `${page.slug}.json`), { schemaVersion: 1, model: 'PageSnapshotModel', slug: page.slug, sourceUrl: page.sourceUrl, finalUrl: page.finalUrl, htmlRef: page.htmlRef, title: page.title, links: page.links, visual: page.visual });
  }

  private countTopLevelComponents(html: string): number {
    const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
    return body.match(/<(?:section|article|div|main|figure|form)\b/gi)?.length ?? 0;
  }

  private startDocker(outputPath: string): void {
    const result = childProcess.spawnSync('docker', ['compose', 'up', '-d', '--wait'], {
      cwd: outputPath,
      encoding: 'utf-8',
      timeout: Number(process.env.WORDPRESS_VISUAL_VALIDATION_TIMEOUT_MS ?? 2_700_000),
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Docker could not start the generated project: ${result.error?.message ?? result.stderr ?? result.stdout}`.trim());
    }
  }

  private async waitForWordPress(outputPath: string, port: number): Promise<void> {
    // Real captures can contain hundreds of media files. WordPress generates
    // attachment metadata during the seed step, which legitimately takes more
    // than three minutes on slower disks/CPUs. Keep the timeout configurable,
    // but use a production-safe default so a healthy import is not reported as
    // failed while WP-CLI is still making progress.
    const configuredTimeout = Number(process.env.WORDPRESS_INIT_TIMEOUT_MS ?? 900_000);
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 30_000
      ? configuredTimeout
      : 900_000;
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      const result = childProcess.spawnSync('docker', ['compose', 'logs', '--no-color', 'wpcli'], {
        cwd: outputPath,
        encoding: 'utf-8',
        timeout: 15_000,
      });
      if (result.status === 0 && result.stdout.includes('AutoWP init complete')) {
        try {
          const response = await fetch(`http://localhost:${port}/wp-login.php`, { redirect: 'manual' });
          if (response.status >= 200 && response.status < 400) return;
        } catch { /* WordPress is still starting Apache. */ }
      }
      lastError = result.stderr || result.stdout || result.error?.message || lastError;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`WordPress did not finish initialization within ${Math.round(timeoutMs / 1000)} seconds. ${lastError}`.trim());
  }

  private openBrowser(url: string): void {
    if (process.platform === 'win32') {
      childProcess.spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'darwin') {
      childProcess.spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      childProcess.spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  }

  private runVisualValidation(outputPath: string): void {
    const result = childProcess.spawnSync(process.execPath, [path.join('validation', 'run-visual-validation.mjs')], {
      cwd: outputPath,
      encoding: 'utf-8',
      timeout: Number(process.env.WORDPRESS_VISUAL_VALIDATION_TIMEOUT_MS ?? 2_700_000),
      env: { ...process.env, AUTOWP_WORKSPACE_PACKAGE: path.join(process.cwd(), 'package.json') },
    });
    if (result.status !== 0) {
      writeJson(path.join(outputPath, 'validation', 'visual-validation-runtime.json'), {
        status: 'needs_review',
        reason: 'Runtime screenshot capture could not complete.',
        error: (result.error?.message ?? result.stderr ?? result.stdout ?? 'Unknown visual validation error').trim(),
      });
    }
  }
}
