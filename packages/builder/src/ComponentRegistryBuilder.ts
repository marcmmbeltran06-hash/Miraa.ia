import * as path from 'node:path';
import type { BuildContext, SourcePage } from './types.js';
import { writeJson } from './fs-utils.js';

type EditableField = {
  fieldId: string;
  kind: 'text' | 'image' | 'link' | 'form';
  selector: string;
  value?: string;
};

function body(html: string): string {
  return html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
}

function text(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function fields(html: string): EditableField[] {
  const result: EditableField[] = [];
  let index = 0;
  for (const match of html.matchAll(/<(h[1-6]|p|button)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const value = text(match[2]);
    if (value) result.push({ fieldId: `text-${index++}`, kind: 'text', selector: match[1].toLowerCase(), value });
  }
  index = 0;
  for (const match of html.matchAll(/<img\b[^>]*\bsrc=(['"])(.*?)\1[^>]*>/gi)) {
    result.push({ fieldId: `image-${index++}`, kind: 'image', selector: 'img', value: match[2] });
  }
  index = 0;
  for (const match of html.matchAll(/<a\b[^>]*\bhref=(['"])(.*?)\1[^>]*>/gi)) {
    result.push({ fieldId: `link-${index++}`, kind: 'link', selector: 'a', value: match[2] });
  }
  index = 0;
  for (const _match of html.matchAll(/<form\b[^>]*>/gi)) result.push({ fieldId: `form-${index++}`, kind: 'form', selector: 'form' });
  return result;
}

/**
 * Emits a stable, job-local registry. It is deliberately data only: no AI or
 * editing endpoint is enabled until the reconstruction QualityGate succeeds.
 */
export class ComponentRegistryBuilder {
  public build(ctx: BuildContext): void {
    const entries = ctx.source.pages.map((page) => this.pageEntry(ctx, page));
    const registry = {
      version: 1,
      generatedAt: new Date().toISOString(),
      editingState: 'blocked-until-quality-gate-ready',
      components: entries.flatMap((entry) => entry.components),
    };
    writeJson(path.join(ctx.outputPath, 'autowp-components.json'), registry);
    writeJson(path.join(ctx.importsPath, 'autowp-components.json'), registry);
    for (const entry of entries) writeJson(path.join(ctx.outputPath, 'content', 'pages', `${entry.pageId}.json`), entry);
  }

  private pageEntry(ctx: BuildContext, page: SourcePage): { pageId: string; route: string; components: Array<Record<string, unknown>>; text: EditableField[]; images: EditableField[]; links: EditableField[]; forms: EditableField[] } {
    const html = body(ctx.source.rawHtmlBySlug.get(page.slug) ?? page.html ?? '');
    const allFields = fields(html);
    const componentId = `${page.slug}.root`;
    return {
      pageId: page.slug,
      route: page.finalUrl ?? page.sourceUrl ?? `/${page.slug}`,
      components: [{
        componentId,
        pageId: page.slug,
        type: 'page-root',
        selector: 'main',
        editableFields: allFields,
        sourceHtml: html,
        styleReferences: [],
        scriptReferences: [],
        parent: null,
        children: (page.components ?? []).map((component, index) => component.id ?? `${componentId}.component-${index + 1}`),
        responsiveRules: [],
        validationRules: ['html-valid', 'links-valid', 'visual-validation'],
      }],
      text: allFields.filter((field) => field.kind === 'text'),
      images: allFields.filter((field) => field.kind === 'image'),
      links: allFields.filter((field) => field.kind === 'link'),
      forms: allFields.filter((field) => field.kind === 'form'),
    };
  }
}
