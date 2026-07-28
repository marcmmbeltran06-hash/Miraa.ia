import { parseHTML } from 'linkedom';
import type { SeoPageReport, SeoReport } from './types.js';

export type OptimizationCategory = 'seo' | 'cro' | 'accessibility' | 'performance' | 'ecommerce';
export type OptimizationPriority = 'critical' | 'high' | 'medium' | 'low';
export type OptimizationOperationType = 'set_meta_title' | 'set_meta_description' | 'replace_text' | 'set_alt';

export interface OptimizationOperation {
  type: OptimizationOperationType;
  selector: string;
  previousValue: string;
  newValue: string;
  reversible: true;
}

export interface OptimizationProposal {
  id: string;
  pageUrl: string;
  pageType: 'home' | 'product' | 'category' | 'content';
  templateScope: 'page' | 'all_products' | 'all_categories';
  category: OptimizationCategory;
  problem: string;
  evidence: string[];
  change: string;
  explanation: string;
  priority: OptimizationPriority;
  confidence: number;
  expectedImpact: string;
  expectedImpactKind: 'hypothesis';
  risk: 'low';
  requiresReview: true;
  autoApply: false;
  operations: OptimizationOperation[];
}

export interface SiteOptimizationPlan {
  schemaVersion: 1;
  generatedAt: string;
  source: 'verified_rules';
  mode: 'review_required';
  guarantees: {
    originalSiteModified: false;
    automaticApplication: false;
    rollbackRequired: true;
    commercialResultsGuaranteed: false;
  };
  totals: { pagesAnalyzed: number; proposals: number; rejectedUnsafe: number };
  proposals: OptimizationProposal[];
}

const GENERIC_CTA = new Set(['enviar', 'submit', 'ver más', 'ver mas', 'más', 'mas', 'more', 'continuar', 'continue', 'click aquí', 'click aqui']);

function clean(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function trimTo(value: string, length: number): string {
  if (value.length <= length) return value;
  const shortened = value.slice(0, length + 1).replace(/\s+\S*$/, '').trim();
  return shortened || value.slice(0, length).trim();
}

function hash(value: string): string {
  let result = 2166136261;
  for (const character of value) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

function pageType(page: SeoPageReport): OptimizationProposal['pageType'] {
  if (page.depth === 0) return 'home';
  if (page.products.length > 0 || /\/(?:product|producto|products|productos)\//i.test(page.finalUrl)) return 'product';
  if (/\/(?:category|categoria|collection|coleccion|shop|tienda)(?:\/|$)/i.test(page.finalUrl)) return 'category';
  return 'content';
}

function scopeFor(type: OptimizationProposal['pageType']): OptimizationProposal['templateScope'] {
  if (type === 'product') return 'all_products';
  if (type === 'category') return 'all_categories';
  return 'page';
}

function selectorFor(element: Element): string | null {
  const id = clean(element.getAttribute('id') ?? '');
  if (id && /^[A-Za-z][\w:-]*$/.test(id)) return `#${id}`;
  const tag = element.tagName.toLowerCase();
  const classes = clean(element.getAttribute('class') ?? '').split(' ').filter((item) => /^[A-Za-z_][\w-]*$/.test(item));
  if (classes.length > 0) {
    const candidate = `${tag}.${classes.slice(0, 2).join('.')}`;
    if (element.ownerDocument?.querySelectorAll(candidate).length === 1) return candidate;
  }
  const parent = element.parentElement;
  if (!parent) return tag;
  const siblings = [...parent.children].filter((item) => item.tagName === element.tagName);
  const index = siblings.indexOf(element);
  const parentSelector = selectorFor(parent);
  if (!parentSelector || index < 0) return null;
  return `${parentSelector} > ${tag}:nth-of-type(${index + 1})`;
}

function addProposal(proposals: OptimizationProposal[], proposal: Omit<OptimizationProposal, 'id' | 'expectedImpactKind' | 'risk' | 'requiresReview' | 'autoApply'>): void {
  if (proposal.operations.some((operation) => !operation.newValue || operation.previousValue === operation.newValue)) return;
  proposals.push({
    ...proposal,
    id: `opt-${hash(`${proposal.pageUrl}|${proposal.category}|${proposal.problem}|${proposal.operations.map((item) => item.selector).join('|')}`)}`,
    expectedImpactKind: 'hypothesis',
    risk: 'low',
    requiresReview: true,
    autoApply: false,
  });
}

function descriptionCandidate(page: SeoPageReport): string {
  const source = clean(page.pageContent) || clean(page.headings.h1[0]) || clean(page.title);
  return trimTo(source, 155);
}

/** Generates conservative, review-only suggestions from captured evidence. */
export function createSafeOptimizationPlan(report: SeoReport): SiteOptimizationPlan {
  const proposals: OptimizationProposal[] = [];
  let rejectedUnsafe = 0;

  for (const page of report.pages) {
    const type = pageType(page);
    const templateScope = scopeFor(type);
    const title = clean(page.title);
    const h1 = clean(page.headings.h1[0]);
    const candidateTitle = trimTo(h1 || title, 60);
    if ((!title || title.length > 60) && candidateTitle) {
      addProposal(proposals, {
        pageUrl: page.finalUrl, pageType: type, templateScope: 'page', category: 'seo',
        problem: title ? 'El título SEO supera la longitud recomendada.' : 'La página no tiene título SEO.',
        evidence: [title ? `Título actual: ${title.length} caracteres.` : 'No se encontró una etiqueta title utilizable.', `Texto existente usado: ${candidateTitle}`],
        change: `Usar “${candidateTitle}” como título SEO.`,
        explanation: 'Un título descriptivo ayuda a entender la página. Es una hipótesis SEO, no una garantía de posicionamiento.',
        priority: title ? 'medium' : 'high', confidence: 0.96,
        expectedImpact: 'Hipótesis: mejorar la claridad del resultado de búsqueda sin alterar el diseño visible.',
        operations: [{ type: 'set_meta_title', selector: 'head > title', previousValue: title, newValue: candidateTitle, reversible: true }],
      });
    }

    const description = clean(page.metaDescription);
    const candidateDescription = descriptionCandidate(page);
    if ((!description || description.length < 70 || description.length > 160) && candidateDescription.length >= 40) {
      addProposal(proposals, {
        pageUrl: page.finalUrl, pageType: type, templateScope: 'page', category: 'seo',
        problem: description ? 'La descripción SEO tiene una longitud poco útil.' : 'La página no tiene descripción SEO.',
        evidence: [description ? `Descripción actual: ${description.length} caracteres.` : 'No se encontró meta description.', 'La propuesta usa únicamente texto visible capturado.'],
        change: `Proponer esta descripción: “${candidateDescription}”.`,
        explanation: 'La propuesta reutiliza contenido real y debe aprobarse antes de publicarse.',
        priority: description ? 'low' : 'medium', confidence: 0.9,
        expectedImpact: 'Hipótesis: ofrecer un resumen más claro en buscadores; Google puede elegir otro fragmento.',
        operations: [{ type: 'set_meta_description', selector: 'head > meta[name="description"]', previousValue: description, newValue: candidateDescription, reversible: true }],
      });
    }

    if (!page.pageHtml) continue;
    try {
      const { document } = parseHTML(page.pageHtml);
      const visibleTitle = h1 || clean(page.products[0]?.title) || clean(page.products[0]?.name) || title;
      for (const element of [...document.querySelectorAll('a,button')].slice(0, 100)) {
        const current = clean(element.textContent || element.getAttribute('value') || '');
        if (!GENERIC_CTA.has(current.toLowerCase())) continue;
        const selector = selectorFor(element);
        if (!selector || document.querySelectorAll(selector).length !== 1) { rejectedUnsafe += 1; continue; }
        const replacement = type === 'product' && visibleTitle ? trimTo(`Ver ${visibleTitle}`, 70) : 'Ver detalles';
        addProposal(proposals, {
          pageUrl: page.finalUrl, pageType: type, templateScope, category: 'cro',
          problem: 'El texto de la llamada a la acción es genérico.',
          evidence: [`Texto visible actual: “${current}”.`, `Selector verificado y único: ${selector}`],
          change: `Cambiarlo por “${replacement}” en la vista previa.`,
          explanation: 'Una llamada a la acción específica puede aclarar el siguiente paso. Debe validarse visualmente antes de aplicarla a una plantilla.',
          priority: 'medium', confidence: 0.84,
          expectedImpact: 'Hipótesis CRO: reducir ambigüedad; no implica ni garantiza más ventas.',
          operations: [{ type: 'replace_text', selector, previousValue: current, newValue: replacement, reversible: true }],
        });
      }

      for (const image of [...document.querySelectorAll('img:not([alt]), img[alt=""]')].slice(0, 30)) {
        const selector = selectorFor(image);
        const src = clean(image.getAttribute('src') ?? '');
        const filename = decodeURIComponent(src.split('/').pop()?.split('?')[0] ?? '').replace(/[-_]+/g, ' ').replace(/\.[a-z0-9]+$/i, '').trim();
        const alt = trimTo(filename, 120);
        if (!selector || !alt || document.querySelectorAll(selector).length !== 1) { rejectedUnsafe += 1; continue; }
        addProposal(proposals, {
          pageUrl: page.finalUrl, pageType: type, templateScope: 'page', category: 'accessibility',
          problem: 'Una imagen informativa no tiene texto alternativo.',
          evidence: [`Recurso: ${src}`, `Selector verificado y único: ${selector}`],
          change: `Proponer “${alt}” como texto alternativo, pendiente de revisión humana.`,
          explanation: 'El texto deriva del archivo y puede requerir corrección si la imagen es decorativa.',
          priority: 'medium', confidence: 0.7,
          expectedImpact: 'Hipótesis: mejorar la accesibilidad y comprensión del recurso.',
          operations: [{ type: 'set_alt', selector, previousValue: '', newValue: alt, reversible: true }],
        });
      }
    } catch {
      rejectedUnsafe += 1;
    }
  }

  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), source: 'verified_rules', mode: 'review_required',
    guarantees: { originalSiteModified: false, automaticApplication: false, rollbackRequired: true, commercialResultsGuaranteed: false },
    totals: { pagesAnalyzed: report.pages.length, proposals: proposals.length, rejectedUnsafe }, proposals,
  };
}
