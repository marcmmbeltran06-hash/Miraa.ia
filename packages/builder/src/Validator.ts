import * as fs from 'node:fs';
import * as path from 'node:path';
import { readJson, safeJoin } from './fs-utils.js';
import type { ValidationIssue, ValidationReport } from './types.js';

const REQUIRED_PATHS = [
  'reconstruction-manifest.json',
  'wordpress',
  'model',
  'raw',
  'products.json',
  'woocommerce-products.csv',
] as const;

export class Validator {
  public validate(rootPath: string): ValidationReport {
    const issues: ValidationIssue[] = [];
    for (const requiredPath of REQUIRED_PATHS) {
      if (!fs.existsSync(path.join(rootPath, requiredPath))) {
        issues.push({
          code: 'MISSING_REQUIRED_EXPORT_PATH',
          severity: 'error',
          message: `Missing required Phase 1 artifact: ${requiredPath}`,
        });
      }
    }

    if (!fs.existsSync(path.join(rootPath, 'resources'))) {
      issues.push({
        code: 'MISSING_RESOURCES',
        severity: 'warning',
        message: 'resources/ is missing; media will be limited to external fallbacks.',
      });
    }
    if (!fs.existsSync(path.join(rootPath, 'visual'))) {
      issues.push({
        code: 'MISSING_VISUAL_REFERENCES',
        severity: 'warning',
        message: 'visual/ is missing; visual validation coverage will be incomplete.',
      });
    }

    const manifestPath = path.join(rootPath, 'reconstruction-manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = readJson<{ pages?: Array<{ slug?: string; model?: string; html?: string; screenshot?: string }> }>(manifestPath);
        const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
        // Some crawler exports contain the canonical page records in
        // wordpress/pages but leave the reconstruction manifest empty. That
        // is recoverable: ProjectLoader can load those records without a new
        // crawl, so do not abort the entire WordPress build.
        const fallbackPagesDir = path.join(rootPath, 'wordpress', 'pages');
        const fallbackPages = fs.existsSync(fallbackPagesDir)
          ? fs.readdirSync(fallbackPagesDir).filter((name) => name.toLowerCase().endsWith('.json'))
          : [];
        if (pages.length === 0) {
          if (fallbackPages.length > 0) issues.push({ code: 'MANIFEST_EMPTY_FALLBACK_PAGES', severity: 'warning', message: `reconstruction-manifest.json is empty; using ${fallbackPages.length} canonical wordpress/pages records.` });
          else issues.push({ code: 'EMPTY_CAPTURE_EXPORT', severity: 'error', message: 'La exportación no contiene ninguna página capturada (report.pages=0). No se puede generar una réplica fiel; vuelve a exportar tras comprobar que el crawler ha terminado y que la captura no fue bloqueada.' });
        }
        for (const page of pages) {
          const label = page.slug ?? 'unknown page';
          for (const [kind, ref] of [['model', page.model], ['raw HTML', page.html]] as const) {
            if (!ref || !fs.existsSync(safeJoin(rootPath, ref))) issues.push({ code: 'INCOMPLETE_PAGE_ARTIFACT', severity: 'error', message: `${label} is incomplete: missing ${kind} artifact.` });
          }
          if (!page.screenshot || !fs.existsSync(safeJoin(rootPath, page.screenshot))) issues.push({ code: 'MISSING_VISUAL_REFERENCE', severity: 'warning', message: `${label} has no screenshot; it cannot pass visual validation.` });
        }
      } catch (error) {
        issues.push({ code: 'INVALID_RECONSTRUCTION_MANIFEST', severity: 'error', message: `Cannot read reconstruction manifest: ${error instanceof Error ? error.message : String(error)}` });
      }
    }

    return { ok: issues.every((issue) => issue.severity !== 'error'), issues };
  }
}
