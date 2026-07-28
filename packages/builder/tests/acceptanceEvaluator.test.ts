import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateAcceptance, writeAcceptanceReport } from '../src/acceptance/AcceptanceEvaluator.js';

const temporaryPaths: string[] = [];

function temporarySite(): string {
  const sitePath = fs.mkdtempSync(path.join(os.tmpdir(), 'autowp-acceptance-'));
  temporaryPaths.push(sitePath);
  fs.mkdirSync(path.join(sitePath, 'validation'), { recursive: true });
  fs.mkdirSync(path.join(sitePath, 'imports'), { recursive: true });
  return sitePath;
}

function writeJson(sitePath: string, relativePath: string, value: unknown): void {
  const filePath = path.join(sitePath, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function writeCompleteSourceEvidence(sitePath: string): void {
  writeJson(sitePath, 'validation/capture-integrity.json', { complete: true, pagesDeclared: 1, pagesWithRawHtml: 1 });
  writeJson(sitePath, 'validation/source-capture-status.json', { status: 'pass', expectedPages: 1, capturedPages: 1 });
}

afterEach(() => {
  for (const sitePath of temporaryPaths.splice(0)) {
    fs.rmSync(sitePath, { recursive: true, force: true });
  }
});

describe('AcceptanceEvaluator', () => {
  it('fails closed when runtime evidence does not exist', () => {
    const report = evaluateAcceptance(temporarySite());

    expect(report.status).toBe('blocked_by_environment');
    expect(report.failedChecks).toContain('quality-gate');
    expect(report.failedChecks).toContain('all-pages-validated');
  });

  it('detects missing viewport evidence per page', () => {
    const sitePath = temporarySite();
    writeCompleteSourceEvidence(sitePath);
    writeJson(sitePath, 'validation/runtime-validation.json', { status: 'pass', commerce: { expectedProducts: 0 } });
    writeJson(sitePath, 'validation/visual-validation-runtime.json', {
      status: 'pass',
      results: [{
        slug: 'home',
        status: 'pass',
        captures: [{ viewport: 'desktop' }, { viewport: 'tablet' }, { viewport: 'mobile' }],
      }],
    });
    writeJson(sitePath, 'imports/editable-blocks-report.json', {
      status: 'pass',
      allPagesEditable: true,
      visualEditorAvailable: true,
      expectedPageCount: 1,
      pageCount: 1,
      blockCount: 1,
    });

    const report = evaluateAcceptance(sitePath);

    expect(report.status).toBe('needs_partial_reconstruction');
    expect(report.failedChecks).toContain('all-required-viewports');
  });

  it('requires a completed non-payment order for commerce sites', () => {
    const sitePath = temporarySite();
    writeCompleteSourceEvidence(sitePath);
    writeJson(sitePath, 'validation/runtime-validation.json', { status: 'pass', commerce: { expectedProducts: 1 } });
    writeJson(sitePath, 'validation/visual-validation-runtime.json', {
      status: 'pass',
      results: [{
        slug: 'product',
        status: 'pass',
        captures: [
          { viewport: 'desktop-large' },
          { viewport: 'desktop' },
          { viewport: 'tablet' },
          { viewport: 'mobile' },
        ],
      }],
    });
    writeJson(sitePath, 'validation/commerce-runtime-report.json', {
      expectedProducts: 1,
      addToCartSucceeded: true,
      addToCartButtonsChecked: 1,
      addToCartButtonsUsable: 1,
      cartHasItem: true,
      checkoutReachable: true,
      checkoutUsable: true,
      testOrderCreated: false,
    });
    writeJson(sitePath, 'imports/editable-blocks-report.json', {
      status: 'pass',
      allPagesEditable: true,
      visualEditorAvailable: true,
      expectedPageCount: 1,
      pageCount: 1,
      blockCount: 1,
    });

    const report = writeAcceptanceReport(sitePath);

    expect(report.commerce.applicable).toBe(true);
    expect(report.commerce.testOrderCreated).toBe(false);
    expect(report.failedChecks).toContain('test-order');
    expect(fs.existsSync(path.join(sitePath, 'validation', 'acceptance-report.json'))).toBe(true);
  });

  it('reports source-blocked when CAPTCHA or an incomplete capture is present', () => {
    const sitePath = temporarySite();
    writeJson(sitePath, 'validation/capture-integrity.json', { complete: false, pagesDeclared: 2, pagesWithRawHtml: 1 });
    writeJson(sitePath, 'validation/source-capture-status.json', {
      status: 'needs_reconstruction',
      blockedPages: [{ slug: 'checkout', status: 'blocked', issues: ['source-challenge-detected'] }],
    });

    const report = evaluateAcceptance(sitePath);

    expect(report.status).toBe('blocked_by_source');
    expect(report.failedChecks).toContain('capture-integrity');
    expect(report.failedChecks).toContain('source-capture');
  });
});
