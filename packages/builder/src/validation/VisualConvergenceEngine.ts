import * as fs from 'node:fs';
import * as path from 'node:path';

type Json = Record<string, unknown>;

function readJson(filePath: string): Json | undefined {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Json; } catch { return undefined; }
}

function array(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item) && typeof item === 'object') : [];
}

function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

/**
 * Turns measured browser failures into a small, auditable set of safe repairs.
 * It never guesses missing content or hides a real header/footer. Those causes
 * remain explicit blockers, rather than being concealed with generic CSS.
 */
export class VisualConvergenceEngine {
  public createPlan(outputPath: string, pages: Array<{ slug: string }>): void {
    const root = path.join(outputPath, 'validation', 'visual');
    fs.mkdirSync(root, { recursive: true });
    const plan = {
      version: 2,
      maxIterations: 5,
      status: 'pending-runtime-comparison',
      thresholds: { home: 0.995, critical: 0.995, other: 0.995 },
      regions: ['header', 'navigation', 'hero', 'main', 'sections', 'forms', 'products', 'footer', 'overlays'],
      pages: pages.map((page) => ({ slug: page.slug, iteration: 0, status: 'pending' })),
      iterations: [],
    };
    fs.writeFileSync(path.join(root, 'convergence-plan.json'), JSON.stringify(plan, null, 2));
  }

  /** Applies only deterministic fixes supported by runtime evidence. */
  public applySafeCorrections(outputPath: string): { applied: string[]; unresolved: string[] } {
    const validation = path.join(outputPath, 'validation');
    const report = readJson(path.join(validation, 'visual-validation-runtime.json'));
    const planPath = path.join(validation, 'visual', 'convergence-plan.json');
    const plan = readJson(planPath);
    if (!report || !plan) return { applied: [], unresolved: ['runtime-report-missing'] };

    const results = array(report.results);
    const applied: string[] = [];
    const unresolved = new Set<string>();
    let oversizedPage = false;
    let nativeCommerceLayoutFailure = false;
    const technicalBlockers = new Set<string>();

    for (const page of results) {
      if (page.heightMismatch === true && Number(page.heightRatio) > 1.1) oversizedPage = true;
      if (page.contentMismatch === true) unresolved.add(`content:${String(page.slug ?? 'unknown')}`);
      if (page.structureMismatch === true) unresolved.add(`structure:${String(page.slug ?? 'unknown')}`);
      if (page.responsiveMismatch === true) unresolved.add(`responsive:${String(page.slug ?? 'unknown')}`);
      for (const viewport of array(page.viewportChecks)) {
        const name = String(viewport.viewport ?? 'unknown');
        const slug = String(page.slug ?? 'unknown');
        for (const dimension of ['text', 'images', 'structure', 'typography', 'positions', 'interactions']) {
          const result = viewport[dimension] as Json | undefined;
          if (result?.pass === false) unresolved.add(`${dimension}:${slug}:${name}`);
          if ((dimension === 'positions' || dimension === 'structure') && result?.pass === false) {
            nativeCommerceLayoutFailure = true;
          }
        }
      }
      const regions = page.regions as Json | undefined;
      if (regions?.headerPresent !== true) unresolved.add(`header:${String(page.slug ?? 'unknown')}`);
      if (regions?.footerPresent !== true) unresolved.add(`footer:${String(page.slug ?? 'unknown')}`);
      const assets = page.assets as Json | undefined;
      if (list(assets?.brokenImages).length) unresolved.add(`media:${String(page.slug ?? 'unknown')}`);
      if (Number(assets?.loadedStyleSheets ?? assets?.styleSheetCount ?? 0) < 1) {
        unresolved.add(`css:${String(page.slug ?? 'unknown')}`);
      }
      if (list(assets?.missingFonts).length) unresolved.add(`fonts:${String(page.slug ?? 'unknown')}`);
    }
    for (const blocked of array(report.blockedClicks)) {
      const blocker = String(blocked.blocker ?? '');
      const classes = blocker.split('.').slice(1);
      for (const className of classes) {
        if (/^(?:[a-z0-9_-]*)(?:preloader|loader|consent|cookie|cmplz)(?:[a-z0-9_-]*)$/i.test(className)) technicalBlockers.add(className);
        else unresolved.add(`blocked-click:${String(blocked.text ?? blocker)}`);
      }
    }

    if (oversizedPage && this.removeEmptySpacers(path.join(outputPath, 'wp-content', 'themes', 'autowp-reconstruction', 'templates'))) {
      applied.push('remove-empty-spacers');
    }
    if (technicalBlockers.size && this.disableTechnicalBlockers(path.join(outputPath, 'wp-content', 'themes', 'autowp-reconstruction', 'assets', 'convergence.css'), technicalBlockers)) {
      applied.push('disable-technical-click-blockers');
    }
    if (nativeCommerceLayoutFailure && this.repairNativeCommerceLayout(path.join(outputPath, 'wp-content', 'themes', 'autowp-reconstruction', 'assets', 'convergence.css'))) {
      applied.push('repair-native-commerce-responsive-layout');
    }

    const iterations = Array.isArray(plan.iterations) ? plan.iterations : [];
    iterations.push({
      number: iterations.length + 1,
      at: new Date().toISOString(),
      evidence: { visualStatus: report.status, pages: results.length },
      applied,
      unresolved: [...unresolved],
      status: applied.length ? 'corrected-revalidation-required' : unresolved.size ? 'needs-review' : 'no-safe-correction-needed',
    });
    plan.iterations = iterations;
    plan.status = applied.length ? 'revalidation-required' : unresolved.size ? 'needs_review' : String(report.status ?? 'needs_review');
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    return { applied, unresolved: [...unresolved] };
  }

  private removeEmptySpacers(templateDir: string): boolean {
    if (!fs.existsSync(templateDir)) return false;
    let changed = false;
    for (const name of fs.readdirSync(templateDir).filter((entry) => entry.endsWith('.html'))) {
      const filePath = path.join(templateDir, name);
      const source = fs.readFileSync(filePath, 'utf8');
      // Only remove entirely empty elements whose own class explicitly declares
      // them as a spacer/gap. Real content and intentionally sized sections are
      // untouched.
      const corrected = source.replace(/<(div|section)\b(?=[^>]*\bclass=(['"])[^'"]*\b(?:spacer|empty|gap)\b[^'"]*\2)[^>]*>\s*(?:&nbsp;)?\s*<\/\1>/gi, '');
      if (corrected !== source) { fs.writeFileSync(filePath, corrected); changed = true; }
    }
    return changed;
  }

  private disableTechnicalBlockers(cssPath: string, classNames: Set<string>): boolean {
    const rules = [...classNames].sort().map((className) => `.${className}{pointer-events:none!important;visibility:hidden!important}`).join('\n');
    return this.writeManagedCssSection(cssPath, 'verified-technical-blockers', rules);
  }

  /**
   * Repairs only AutoWP's own WooCommerce layout. Source HTML is deliberately
   * excluded: an evidence-free generic rule must never rewrite the captured
   * site's header, menu, gallery or grid.
   */
  private repairNativeCommerceLayout(cssPath: string): boolean {
    const rules = [
      'body.autowp-native-commerce{max-width:100%;overflow-x:clip}',
      '.autowp-native-commerce .autowp-commerce-main,.autowp-native-commerce .autowp-commerce-main *{box-sizing:border-box}',
      '.autowp-native-commerce .autowp-commerce-main img{max-width:100%;height:auto}',
      '.autowp-native-commerce .autowp-commerce-main ul.products{display:grid!important;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))!important;width:100%!important}',
      '.autowp-native-commerce .woocommerce-product-gallery{max-width:100%;min-width:0}',
      '@media(max-width:900px){.autowp-native-commerce .product,.autowp-native-commerce .cart-collaterals,.autowp-native-commerce .woocommerce-checkout{display:grid!important;grid-template-columns:minmax(0,1fr)!important}.autowp-native-commerce table.shop_table{display:block;max-width:100%;overflow-x:auto}.autowp-native-commerce .woocommerce-product-gallery,.autowp-native-commerce .summary{float:none!important;width:100%!important;max-width:100%!important}}',
    ].join('\n');
    return this.writeManagedCssSection(cssPath, 'native-commerce-responsive-layout', rules);
  }

  private writeManagedCssSection(cssPath: string, name: string, rules: string): boolean {
    const start = `/* AutoWP convergence:${name}:start */`;
    const end = `/* AutoWP convergence:${name}:end */`;
    const section = `${start}\n${rules.trim()}\n${end}`;
    const current = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matcher = new RegExp(`/\\* AutoWP convergence:${escaped}:start \\*/[\\s\\S]*?/\\* AutoWP convergence:${escaped}:end \\*/`, 'g');
    const next = matcher.test(current)
      ? current.replace(matcher, section)
      : `${current.trim()}${current.trim() ? '\n\n' : ''}${section}\n`;
    if (next === current) return false;
    fs.mkdirSync(path.dirname(cssPath), { recursive: true });
    fs.writeFileSync(cssPath, next);
    return true;
  }
}
