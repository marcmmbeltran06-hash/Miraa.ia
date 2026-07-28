import * as fs from 'node:fs';
import * as path from 'node:path';
import { evaluateQualityGate } from '../validation/QualityGate.js';

type Json = Record<string, unknown>;

export type AcceptanceStatus =
  | 'ready'
  | 'needs_manual_review'
  | 'needs_partial_reconstruction'
  | 'blocked_by_source'
  | 'blocked_by_environment'
  | 'failed';

export interface AcceptanceCheck {
  id: string;
  status: 'pass' | 'fail';
  message: string;
  evidence: string[];
}

export interface AcceptanceReport {
  version: 1;
  generatedAt: string;
  status: AcceptanceStatus;
  checks: AcceptanceCheck[];
  failedChecks: string[];
  pages: {
    expected: number;
    validated: number;
    approved: number;
    failed: number;
  };
  commerce: {
    applicable: boolean;
    expectedProducts: number;
    addToCart: boolean;
    cart: boolean;
    checkout: boolean;
    testOrderCreated: boolean;
  };
  requiredViewports: string[];
}

const REQUIRED_VIEWPORTS = ['desktop-large', 'desktop', 'tablet', 'mobile'];

function readJson(filePath: string): Json | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Json;
  } catch {
    return undefined;
  }
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function check(id: string, passed: boolean, message: string, evidence: string[]): AcceptanceCheck {
  return { id, status: passed ? 'pass' : 'fail', message, evidence };
}

/**
 * Produces a fail-closed, machine-readable acceptance decision.
 *
 * This report intentionally duplicates a small amount of QualityGate evidence:
 * the gate remains the shared safety switch, while this richer report explains
 * exactly why the switch is open or closed.
 */
export function evaluateAcceptance(sitePath: string): AcceptanceReport {
  const validationPath = path.join(sitePath, 'validation');
  const visualPath = path.join(validationPath, 'visual-validation-runtime.json');
  const runtimePath = path.join(validationPath, 'runtime-validation.json');
  const commercePath = path.join(validationPath, 'commerce-runtime-report.json');
  const editablePath = path.join(sitePath, 'imports', 'editable-blocks-report.json');
  const pagesPath = path.join(validationPath, 'pages-validation.json');
  const captureIntegrityPath = path.join(validationPath, 'capture-integrity.json');
  const sourceCapturePath = path.join(validationPath, 'source-capture-status.json');

  const gate = evaluateQualityGate(sitePath);
  const visual = readJson(visualPath);
  const runtime = readJson(runtimePath);
  const commerce = readJson(commercePath);
  const editable = readJson(editablePath);
  const pages = readJson(pagesPath);
  const captureIntegrity = readJson(captureIntegrityPath);
  const sourceCapture = readJson(sourceCapturePath);

  const visualResults = list(visual?.results) as Json[];
  const expectedPages = Math.max(
    number(editable?.expectedPageCount),
    number(pages?.expectedPages),
    visualResults.length,
  );
  const approvedPages = visualResults.filter((page) => page.status === 'pass').length;
  const viewportFailures: string[] = [];

  for (const page of visualResults) {
    const captures = list(page.captures) as Json[];
    const available = new Set(captures.map((capture) => String(capture.viewport ?? '')));
    for (const viewport of REQUIRED_VIEWPORTS) {
      if (!available.has(viewport)) viewportFailures.push(`${String(page.slug ?? 'unknown')}:${viewport}`);
    }
  }

  const runtimeCommerce = runtime?.commerce as Json | undefined;
  const expectedProducts = Math.max(number(runtimeCommerce?.expectedProducts), number(commerce?.expectedProducts));
  const commerceApplicable = expectedProducts > 0;
  const addToCart = !commerceApplicable || (
    commerce?.addToCartSucceeded === true &&
    number(commerce?.addToCartButtonsChecked) > 0 &&
    number(commerce?.addToCartButtonsUsable) === number(commerce?.addToCartButtonsChecked)
  );
  const cart = !commerceApplicable || commerce?.cartHasItem === true;
  const checkout = !commerceApplicable || (commerce?.checkoutReachable === true && commerce?.checkoutUsable === true);
  const testOrderCreated = !commerceApplicable || commerce?.testOrderCreated === true;

  const checks: AcceptanceCheck[] = [
    check(
      'capture-integrity',
      captureIntegrity?.complete === true,
      captureIntegrity?.complete === true
        ? 'Every declared page has captured source HTML.'
        : 'The source capture is incomplete; the reconstruction cannot be approved.',
      [captureIntegrityPath],
    ),
    check(
      'source-capture',
      sourceCapture?.status === 'pass',
      sourceCapture?.status === 'pass'
        ? 'No source page was blocked by CAPTCHA or left partially captured.'
        : 'At least one source page was blocked, failed or only partially captured.',
      [sourceCapturePath],
    ),
    check(
      'quality-gate',
      gate.status === 'ready',
      gate.status === 'ready' ? 'All shared quality-gate checks passed.' : `Quality gate failed: ${gate.failures.join(', ')}.`,
      [path.join(validationPath, 'quality-gate inputs')],
    ),
    check(
      'all-pages-validated',
      expectedPages > 0 && visualResults.length === expectedPages,
      `${visualResults.length}/${expectedPages} pages have runtime visual evidence.`,
      [visualPath],
    ),
    check(
      'all-pages-approved',
      expectedPages > 0 && approvedPages === expectedPages,
      `${approvedPages}/${expectedPages} pages passed their individual threshold.`,
      [visualPath],
    ),
    check(
      'all-required-viewports',
      expectedPages > 0 && visualResults.length === expectedPages && viewportFailures.length === 0,
      viewportFailures.length === 0
        ? `Every page has ${REQUIRED_VIEWPORTS.join(', ')} evidence.`
        : `Missing viewport evidence: ${viewportFailures.slice(0, 20).join(', ')}${viewportFailures.length > 20 ? '…' : ''}.`,
      [visualPath],
    ),
    check(
      'runtime',
      runtime?.status === 'pass',
      runtime?.status === 'pass' ? 'WordPress runtime validation passed.' : 'WordPress runtime validation is missing or failed.',
      [runtimePath],
    ),
    check(
      'gutenberg-editability',
      editable?.status === 'pass' && editable?.allPagesEditable === true && editable?.visualEditorAvailable === true,
      editable?.status === 'pass'
        ? 'All generated pages are reported as editable.'
        : 'Editability evidence is missing or incomplete.',
      [editablePath],
    ),
    check('add-to-cart', addToCart, addToCart ? 'All tested add-to-cart controls are usable.' : 'At least one add-to-cart control failed.', [commercePath]),
    check('cart', cart, cart ? 'The WooCommerce cart contains the selected product.' : 'The cart flow did not preserve the selected product.', [commercePath]),
    check('checkout', checkout, checkout ? 'Checkout is reachable and usable.' : 'Checkout is not reachable or usable.', [commercePath]),
    check(
      'test-order',
      testOrderCreated,
      testOrderCreated ? 'A non-payment test order was created.' : 'No non-payment test order was created.',
      [commercePath],
    ),
  ];

  const failedChecks = checks.filter((item) => item.status === 'fail').map((item) => item.id);
  let status: AcceptanceStatus = failedChecks.length === 0 ? 'ready' : 'needs_manual_review';
  if (failedChecks.includes('all-pages-validated') || failedChecks.includes('all-pages-approved') || failedChecks.includes('all-required-viewports')) {
    status = 'needs_partial_reconstruction';
  }
  if (!visual || !runtime) status = 'blocked_by_environment';
  // A proven source-side blocker is more specific than missing downstream
  // runtime evidence: validation cannot exist precisely because capture failed.
  if (
    (Boolean(captureIntegrity) && failedChecks.includes('capture-integrity')) ||
    (Boolean(sourceCapture) && failedChecks.includes('source-capture'))
  ) {
    status = 'blocked_by_source';
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    status,
    checks,
    failedChecks,
    pages: {
      expected: expectedPages,
      validated: visualResults.length,
      approved: approvedPages,
      failed: Math.max(0, expectedPages - approvedPages),
    },
    commerce: {
      applicable: commerceApplicable,
      expectedProducts,
      addToCart,
      cart,
      checkout,
      testOrderCreated,
    },
    requiredViewports: REQUIRED_VIEWPORTS,
  };
}

export function writeAcceptanceReport(sitePath: string): AcceptanceReport {
  const report = evaluateAcceptance(sitePath);
  const validationPath = path.join(sitePath, 'validation');
  fs.mkdirSync(validationPath, { recursive: true });
  fs.writeFileSync(path.join(validationPath, 'acceptance-report.json'), JSON.stringify(report, null, 2));
  return report;
}
