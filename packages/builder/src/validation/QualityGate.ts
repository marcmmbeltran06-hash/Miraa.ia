import * as fs from 'node:fs';
import * as path from 'node:path';

type Json = Record<string, unknown>;

function readJson(filePath: string): Json | undefined {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Json; } catch { return undefined; }
}

function arrayLength(value: unknown): number { return Array.isArray(value) ? value.length : 0; }

/**
 * One honest, shared readiness decision for the builder and API.
 * Missing reports never count as a pass: an incomplete validation is reviewable,
 * not a successful reconstruction.
 */
export function evaluateQualityGate(sitePath: string): { status: 'ready' | 'needs_review'; failures: string[] } {
  const validation = path.join(sitePath, 'validation');
  const pages = readJson(path.join(validation, 'pages-validation.json'));
  const resources = readJson(path.join(validation, 'missing-resources-report.json'));
  const runtime = readJson(path.join(validation, 'runtime-validation.json'));
  const visual = readJson(path.join(validation, 'visual-validation-runtime.json'));
  const cssRuntime = readJson(path.join(validation, 'css-runtime-validation.json'));
  const interactions = readJson(path.join(validation, 'interaction-runtime-report.json'));
  const contentOrder = readJson(path.join(validation, 'content-order-report.json'));
  const localDependencies = readJson(path.join(validation, 'local-dependency-report.json'));
  const network = readJson(path.join(validation, 'network-runtime-report.json'));
  const commerce = readJson(path.join(validation, 'commerce-runtime-report.json'));
  const commerceVisual = readJson(path.join(validation, 'commerce-visual-report.json'));
  const consent = readJson(path.join(validation, 'consent-runtime-report.json'));
  const editable = readJson(path.join(sitePath, 'imports', 'editable-blocks-report.json'));
  const globals = readJson(path.join(validation, 'global-components-report.json'));
  const forms = readJson(path.join(validation, 'forms-validation.json'));
  const content = readJson(path.join(validation, 'content-validation.json'));
  const urls = readJson(path.join(validation, 'url-rewrite-report.json'));
  const captureIntegrity = readJson(path.join(validation, 'capture-integrity.json'));
  const sourceCapture = readJson(path.join(validation, 'source-capture-status.json'));
  const failures: string[] = [];

  if (!pages || arrayLength(pages.missingPages) || arrayLength(pages.emptyPages) || arrayLength(pages.failedPages) || arrayLength(pages.duplicatedPages) || arrayLength(pages.incorrectSlugs) || arrayLength(pages.incorrectTemplates) || arrayLength(pages.missingLanguages) || arrayLength(pages.missingParentRelations)) failures.push('pages');
  if (!resources || arrayLength(resources.missingCriticalResources)) failures.push('critical-resources');
  if (!captureIntegrity || captureIntegrity.complete !== true) failures.push('capture-integrity');
  if (!sourceCapture || sourceCapture.status !== 'pass') failures.push('source-capture');
  if (!runtime || runtime.status !== 'pass') failures.push('runtime');
  if (!visual || visual.status !== 'pass') failures.push('visual');
  if (!cssRuntime || cssRuntime.status !== 'pass') failures.push('css-runtime');
  if (!interactions || interactions.status !== 'pass') failures.push('interactions');
  if (!contentOrder || contentOrder.status !== 'pass') failures.push('content-order');
  if (!forms || arrayLength(forms.missingForms) || arrayLength(forms.brokenForms)) failures.push('forms');
  if (!content || arrayLength(content.missingTextBlocks) || arrayLength(content.missingMedia) || arrayLength(content.missingComponents)) failures.push('content');
  if (!urls || Number(urls.originalInternalDomainReferences ?? 1) > 0) failures.push('original-links');
  if (!localDependencies || localDependencies.status !== 'pass') failures.push('network-locality');
  if (!network || network.status !== 'pass' || arrayLength(network.forbiddenExternalRequests)) failures.push('offline-runtime');
  const runtimeCommerce = runtime?.commerce as Json | undefined;
  const expectedProducts = Number(runtimeCommerce?.expectedProducts ?? 0);
  if (expectedProducts > 0 && (
    !commerce ||
    commerce.status !== 'pass' ||
    commerce.bridgeDetected !== true ||
    commerce.addToCartSucceeded !== true ||
    Number(commerce.addToCartButtonsChecked ?? 0) < 1 ||
    Number(commerce.addToCartButtonsUsable ?? 0) !== Number(commerce.addToCartButtonsChecked ?? 0) ||
    commerce.cartHasItem !== true ||
    commerce.checkoutReachable !== true ||
    commerce.checkoutUsable !== true ||
    commerce.testOrderCreated !== true ||
    (commerce.visual as Json | undefined)?.status !== 'pass' ||
    (commerce.visual as Json | undefined)?.cartBaselineAvailable !== true ||
    (commerce.visual as Json | undefined)?.checkoutBaselineAvailable !== true ||
    (commerce.visual as Json | undefined)?.cartBaselinePass !== true ||
    (commerce.visual as Json | undefined)?.checkoutBaselinePass !== true ||
    !commerceVisual ||
    commerceVisual.status !== 'pass' ||
    commerceVisual.cartBaselineAvailable !== true ||
    commerceVisual.checkoutBaselineAvailable !== true ||
    commerceVisual.cartBaselinePass !== true ||
    commerceVisual.checkoutBaselinePass !== true
  )) failures.push('commerce-purchase-flow');
  if (
    !editable ||
    editable.status !== 'pass' ||
    editable.allPagesEditable !== true ||
    editable.visualEditorAvailable !== true ||
    Number(editable.pageCount ?? 0) < 1 ||
    Number(editable.expectedPageCount ?? 0) !== Number(editable.pageCount ?? -1) ||
    Number(editable.blockCount ?? 0) < Number(editable.pageCount ?? 0)
  ) failures.push('editable-pages');
  if (!consent || (consent.status !== 'pass' && consent.status !== 'not_applicable')) failures.push('cookie-consent');
  if (!globals || globals.status !== 'pass' || globals.headerPresent !== true || globals.footerPresent !== true || globals.navigationPresent !== true) failures.push('header-footer-navigation');

  if (visual && Array.isArray(visual.results)) {
    for (const page of visual.results as Json[]) {
      if (page.status !== 'pass' || page.heightMismatch === true) { failures.push(`visual:${String(page.slug ?? 'unknown')}`); break; }
      const regions = page.regions as Json | undefined;
      if (regions && (regions.headerPresent !== true || regions.footerPresent !== true || regions.mainPresent !== true)) { failures.push(`structure:${String(page.slug ?? 'unknown')}`); break; }
    }
  }
  return { status: failures.length === 0 ? 'ready' : 'needs_review', failures };
}
