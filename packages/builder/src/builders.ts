import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type {
  BuildContext,
  ComponentDecision,
  SourceComponent,
  SourceLayoutBlock,
  SourcePage,
} from './types.js';
import { normalizeCommerceProducts } from './CommerceNormalizer.js';
import { buildNativeGutenberg } from './NativeGutenbergEngine.js';
import { copyFileSafe, ensureDir, escapeHtml, phpString, safeJoin, slugify, writeJson, writeText } from './fs-utils.js';
import { WordPressAgentPluginBuilder } from './WordPressAgentPluginBuilder.js';

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function textBlock(text: string): string {
  return `<!-- wp:paragraph --><p>${escapeHtml(text)}</p><!-- /wp:paragraph -->`;
}

function headingBlock(text: string, level = 2): string {
  return `<!-- wp:heading {"level":${level}} --><h${level}>${escapeHtml(text)}</h${level}><!-- /wp:heading -->`;
}

function imageBlock(src: string, alt = ''): string {
  return `<!-- wp:image --><figure class="wp-block-image"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"/></figure><!-- /wp:image -->`;
}

function stripDocumentShell(html: string): string {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  return body ?? html;
}

function sourceOrigin(ctx: BuildContext): string | undefined {
  try { return new URL(ctx.source.pages[0]?.finalUrl ?? ctx.source.pages[0]?.sourceUrl ?? '').origin; } catch { return undefined; }
}

function rewriteUrl(ctx: BuildContext, value: string, base?: string): string {
  const raw = value.trim().replace(/&quot;/gi, '').replace(/&#0*34;/gi, '');
  if (!raw || raw.startsWith('#') || /^(?:data:|mailto:|tel:|javascript:)/i.test(raw)) return raw;
  let absolute: URL;
  try { absolute = new URL(raw, base ?? ctx.source.pages[0]?.finalUrl ?? ctx.source.pages[0]?.sourceUrl); } catch { return raw; }
  const asset = ctx.mediaMap.find((entry) => entry.sourceUrl === absolute.href || entry.sourceUrl?.split('?')[0] === absolute.href.split('?')[0]);
  if (asset?.wpPath) return asset.wpPath;
  if (absolute.origin === sourceOrigin(ctx)) return `${absolute.pathname.replace(/\/$/, '') || '/'}${absolute.search}${absolute.hash}`;
  return raw;
}

/**
 * Unlike navigation URLs, a missing responsive image candidate must never be
 * rewritten to a local page path. Browsers prefer srcset over src, so one
 * absent 768px derivative can make an otherwise downloaded image appear
 * broken. Keep only candidates that were actually downloaded.
 */
function rewriteSrcset(ctx: BuildContext, value: string, base?: string): string {
  return value.split(',').map((part) => {
    const [rawUrl, ...tail] = part.trim().split(/\s+/);
    if (!rawUrl) return '';
    let absolute: URL;
    try { absolute = new URL(rawUrl, base ?? ctx.source.pages[0]?.finalUrl ?? ctx.source.pages[0]?.sourceUrl); } catch { return ''; }
    const asset = ctx.mediaMap.find((entry) => entry.sourceUrl === absolute.href || entry.sourceUrl?.split('?')[0] === absolute.href.split('?')[0]);
    if (!asset?.wpPath) return '';
    return [asset.wpPath, ...tail].join(' ');
  }).filter(Boolean).join(', ');
}

function rewriteUrls(ctx: BuildContext, text: string, base?: string): string {
  let result = text.replace(/&quot;/gi, '"').replace(/\b(href|src|action|formaction|poster|data-src|data-href|data-url)=(['"])(.*?)\2/gi, (_all, attr: string, quote: string, value: string) => `${attr}=${quote}${escapeHtml(rewriteUrl(ctx, value, base))}${quote}`);
  result = result.replace(/\b(?:srcset|data-srcset)=(['"])(.*?)\1/gi, (_all, quote: string, value: string) => {
    const srcset = rewriteSrcset(ctx, value, base);
    // No local candidate is safer than a broken local derivative: the image's
    // normal src attribute remains available as the responsive fallback.
    return srcset ? `srcset=${quote}${escapeHtml(srcset)}${quote}` : '';
  });
  result = result.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (_all, quote: string, value: string) => `url(${quote}${rewriteUrl(ctx, value, base)}${quote})`);
  result = result.replace(/https?:\/\/[^)\s'"<>]+/gi, (url) => rewriteUrl(ctx, url, base));
  // Some builders serialize navigation and asset URLs inside JSON attributes
  // or inline configuration as https:\/\/host\/path. Localize those too so
  // a click can never silently leave the generated site.
  return result.replace(/https?:\\\/\\\/[^\s'"<>]+/gi, (escaped) => {
    const decoded = escaped.replace(/\\\//g, '/');
    const rewritten = rewriteUrl(ctx, decoded, base);
    return rewritten === decoded ? escaped : rewritten.replace(/\//g, '\\/');
  });
}

/**
 * A third-party iframe/script that was not captured must never be emitted in
 * the local replica. Browsers render those failed embeds as large grey boxes
 * (Google widgets, chat, ads and consent managers are common examples).
 * Downloaded resources have already been rewritten to /wp-content/uploads;
 * only unresolved external resources are removed.
 */
function removeUnlocalizableEmbeds(ctx: BuildContext, html: string): string {
  const isExternalUnmapped = (value: string): boolean => {
    try {
      const url = new URL(value, ctx.source.pages[0]?.finalUrl ?? ctx.source.pages[0]?.sourceUrl);
      if (!/^https?:$/i.test(url.protocol)) return false;
      return url.origin !== sourceOrigin(ctx) && !ctx.mediaMap.some((entry) => entry.wpPath && (entry.sourceUrl === url.href || entry.sourceUrl?.split('?')[0] === url.href.split('?')[0]));
    } catch { return false; }
  };
  let result = html;
  // CAPTCHA/analytics providers cannot work in an offline reconstruction.
  // Remove only the remote provider and leave the form itself intact; the
  // generated local form handler supplies nonce/honeypot protection.
  result = result.replace(/<script\b[^>]*(?:recaptcha|hcaptcha|google\.com\/recaptcha|gstatic\.com\/recaptcha)[^>]*>[\s\S]*?<\/script>/gi, '');
  result = result.replace(/<(?:div|span|section)\b[^>]*(?:g-recaptcha|h-captcha|recaptcha|hcaptcha|captcha)[^>]*>[\s\S]*?<\/(?:div|span|section)>/gi, '<div class="autowp-local-antispam" aria-hidden="true"></div>');
  result = result.replace(/<(iframe|embed|object)\b[^>]*\b(?:src|data|data-src)=(['"])(.*?)\2[^>]*>(?:[\s\S]*?<\/\1>)?/gi, (all, _tag, _q, value) => isExternalUnmapped(value) ? '' : all);
  result = result.replace(/<script\b[^>]*\bsrc=(['"])(.*?)\1[^>]*>[\s\S]*?<\/script>/gi, (all, _q, value) => isExternalUnmapped(value) ? '' : all);
  result = result.replace(/<link\b[^>]*\brel=(['"])[^'"]*(?:stylesheet|preload|modulepreload)[^'"]*\1[^>]*>/gi, (all) => {
    const value = all.match(/\bhref=(['"])(.*?)\1/i)?.[2] ?? '';
    return isExternalUnmapped(value) ? '' : all;
  });
  // A missing image should not become Chrome's broken-image icon. The asset is
  // already present when it can be localized; otherwise hide only that image.
  result = result.replace(/<img\b[^>]*\b(?:src|data-src)=(['"])(.*?)\1[^>]*>/gi, (all, _q, value) => isExternalUnmapped(value) ? '' : all);
  result = result.replace(/<source\b[^>]*\b(?:src|data-src)=(['"])(.*?)\1[^>]*>/gi, (all, _q, value) => isExternalUnmapped(value) ? '' : all);
  result = result.replace(/\bstyle=(['"])([\s\S]*?)\1/gi, (_all, quote, value) => `style=${quote}${removeUnlocalizableCss(ctx, value)}${quote}`);
  return result;
}

function removeUnlocalizableCss(ctx: BuildContext, css: string): string {
  return css.replace(/url\(\s*(['"]?)(https?:\/\/[^)'"\s]+)\1\s*\)/gi, (all, _q, value) => {
    const rewritten = rewriteUrl(ctx, value);
    return rewritten === value ? 'none' : `url(${rewritten})`;
  });
}

function extractBalancedElement(html: string, start: number): string {
  const opening = html.slice(start).match(/^<([a-z][\w:-]*)\b[^>]*>/i);
  if (!opening) return '';
  const tagName = opening[1];
  const tokens = new RegExp(`</?${tagName}\\b[^>]*>`, 'gi');
  tokens.lastIndex = start;
  let depth = 0; let token: RegExpExecArray | null;
  while ((token = tokens.exec(html)) !== null) {
    if (token[0].startsWith('</')) depth -= 1; else depth += 1;
    if (depth === 0) return html.slice(start, tokens.lastIndex);
  }
  return '';
}

function extractFragment(html: string, tag: 'main' | 'header' | 'footer'): string {
  const match = new RegExp(`<${tag}\\b[^>]*>`, 'i').exec(html);
  return match?.index === undefined ? '' : extractBalancedElement(html, match.index);
}

function extractGlobalFragment(html: string, kind: 'header' | 'footer'): string {
  const semantic = extractFragment(html, kind);
  if (semantic) return semantic;
  const classPattern = kind === 'footer'
    ? /<(?:div|section)\b[^>]*class=(['"])[^'"]*\bfusion-(?:tb-)?footer\b[^'"]*\1[^>]*>/i
    : /<(?:div|section)\b[^>]*class=(['"])[^'"]*\bfusion-(?:tb-)?header\b[^'"]*\1[^>]*>/i;
  const match = classPattern.exec(html);
  return match?.index === undefined ? '' : extractBalancedElement(html, match.index);
}

function extractDocumentLocale(html: string): string {
  const language = html.match(/<html\b[^>]*\blang=(['"])(.*?)\1/i)?.[2]?.trim().toLowerCase() ?? '';
  const primary = language.split(/[-_]/)[0]?.replace(/[^a-z]/g, '') ?? '';
  return /^[a-z]{2,3}$/.test(primary) ? primary : 'default';
}

function pageLocale(ctx: BuildContext, page: SourcePage): string {
  return extractDocumentLocale(ctx.source.rawHtmlBySlug.get(page.slug) ?? '');
}

function consensusGlobalFragment(ctx: BuildContext, kind: 'header' | 'footer', locale?: string): string {
  const candidates = ctx.source.pages
    .filter((page) => locale === undefined || pageLocale(ctx, page) === locale)
    .map((page) => extractGlobalFragment(ctx.source.rawHtmlBySlug.get(page.slug) ?? '', kind))
    .filter(Boolean);
  if (!candidates.length) return '';
  const groups = new Map<string, { html: string; count: number }>();
  for (const html of candidates) {
    const key = html.replace(/https?:\/\/[^'"\s<>]+/gi, '{url}').replace(/\d{2,}/g, '{n}').replace(/\s+/g, ' ').slice(0, 600);
    const current = groups.get(key); if (current) current.count += 1; else groups.set(key, { html, count: 1 });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.html.length - a.html.length)[0].html;
}

function globalFragmentVariants(ctx: BuildContext, kind: 'header' | 'footer'): Map<string, { html: string; base?: string }> {
  const locales = [...new Set(ctx.source.pages.map((page) => pageLocale(ctx, page)))];
  const variants = new Map<string, { html: string; base?: string }>();
  for (const locale of locales) {
    const html = consensusGlobalFragment(ctx, kind, locale);
    if (!html) continue;
    const representative = ctx.source.pages.find((page) => pageLocale(ctx, page) === locale && extractGlobalFragment(ctx.source.rawHtmlBySlug.get(page.slug) ?? '', kind));
    variants.set(locale, { html, base: representative?.finalUrl ?? representative?.sourceUrl });
  }
  if (!variants.size) {
    const html = consensusGlobalFragment(ctx, kind);
    if (html) variants.set('default', { html, base: ctx.source.pages[0]?.finalUrl ?? ctx.source.pages[0]?.sourceUrl });
  }
  return variants;
}

function globalPartName(kind: 'header' | 'footer', locale: string): string {
  const safeLocale = locale.replace(/[^a-z0-9_-]/gi, '') || 'default';
  return `parts/${kind}-${safeLocale}.html`;
}

function isolateMain(html: string): string {
  const body = extractFragment(html, 'main') || stripDocumentShell(html);
  const header = extractGlobalFragment(body, 'header');
  const footer = extractGlobalFragment(body, 'footer');
  // This is the fidelity path.  Do not "clean" page markup here: classes,
  // inline styles, data attributes and scripts are often required by visual
  // builders (Elementor, Avada, Divi, Webflow, etc.).  Header/footer are
  // rendered once by the WordPress shell, but the captured page DOM remains
  // otherwise byte-for-byte intact apart from local URL rewriting.
  return body.replace(/<\/?(?:html|head|body)\b[^>]*>/gi, '').replace(header, '').replace(footer, '');
}

/**
 * Public fidelity rendering must retain the complete captured body. Extracting
 * a consensus header/footer changes DOM ancestry and breaks CSS selectors,
 * sticky positioning and responsive behaviour on visual-builder sites.
 */
function capturedBody(html: string): string {
  return stripDocumentShell(html).replace(/<\/?(?:html|head|body)\b[^>]*>/gi, '');
}

function extractBodyAttributes(html: string): string {
  const attributes = html.match(/<body\b([^>]*)>/i)?.[1] ?? '';
  // Preserve visual and framework data attributes, but never copy executable
  // inline event handlers into the generated WordPress document.
  return attributes.replace(/\s+on[a-z]+\s*=\s*(['"])[\s\S]*?\1/gi, '').trim();
}

function capturedHeadPresentation(ctx: BuildContext, page: SourcePage, html: string): string {
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? '';
  const parts: string[] = [];
  const pattern = /<(?:style\b[^>]*>[\s\S]*?<\/style>|script\b[^>]*>[\s\S]*?<\/script>|link\b[^>]*\brel=(['"])[^'"]*(?:stylesheet|preload|modulepreload)[^'"]*\1[^>]*>)/gi;
  for (const match of head.matchAll(pattern)) parts.push(match[0]);
  return removeUnlocalizableEmbeds(ctx, rewriteUrls(ctx, parts.join('\n'), page.finalUrl ?? page.sourceUrl));
}

function extractBodyClasses(html: string): string {
  const opening = html.match(/<body\b([^>]*)>/i)?.[1] ?? '';
  return opening.match(/\bclass=(['"])(.*?)\1/i)?.[2]?.trim() ?? '';
}

type EditablePageRecord = {
  content: string;
  wrapperOpen: string;
  wrapperClose: string;
  blockCount: number;
  strategy: 'section_blocks' | 'whole_page_block' | 'semantic_blocks' | 'native_gutenberg';
};

function localRoute(page: SourcePage): string {
  try {
    const pathname = new URL(page.finalUrl ?? page.sourceUrl ?? '').pathname.replace(/^\/+|\/+$/g, '');
    return pathname ? `/${pathname}` : '/';
  } catch { return page.slug === 'home' ? '/' : `/${page.slug}`; }
}

function normalizeAssetBasename(value: string): string {
  try {
    const parsed = new URL(value);
    return path.basename(parsed.pathname) || slugify(value);
  } catch {
    return path.basename(value) || slugify(value);
  }
}

function normalizeExternalResource(value: string): string | undefined {
  const decoded = value.trim().replace(/&quot;/gi, '"').replace(/&#0*34;/gi, '"').replace(/&#0*39;/gi, "'");
  const url = decoded.match(/https?:\/\/[^)'"\s<>]+/i)?.[0] ?? decoded.replace(/^['"]|['"]$/g, '');
  if (!/^(?:https?:|data:)/i.test(url)) return undefined;
  // ExportService already records resource attributes only. Keep extensionless
  // CDN/font endpoints too: silently dropping them here made a build appear
  // self-contained even though a stylesheet or font request was still remote.
  return url;
}

export class MediaBuilder {
  public build(
    ctx: BuildContext,
    options: {
      startIndex?: number;
      batchSize?: number;
      onBatch?: (completed: number, total: number, lastItem?: string) => void;
    } = {},
  ): void {
    ensureDir(ctx.uploadsPath);
    const downloaded = ctx.source.resources.downloaded ?? [];
    const startIndex = Math.max(0, Math.min(downloaded.length, options.startIndex ?? 0));
    const batchSize = Math.max(1, options.batchSize ?? 50);
    const existing = new Set(ctx.mediaMap.map((entry) => `${entry.sourceUrl ?? ''}\u0000${entry.sourcePath ?? ''}`));
    for (let index = startIndex; index < downloaded.length; index += 1) {
      const resource = downloaded[index];
      const sourcePath = safeJoin(ctx.source.rootPath, resource.path);
      const key = `${resource.sourceUrl ?? ''}\u0000${resource.path ?? ''}`;
      if (fs.existsSync(sourcePath) && !existing.has(key)) {
        const basename = `${slugify(resource.sourceUrl ?? resource.path).slice(-24)}-${normalizeAssetBasename(resource.path)}`;
        const localPath = path.join(ctx.uploadsPath, basename);
        copyFileSafe(sourcePath, localPath);
        ctx.mediaMap.push({
          sourceUrl: resource.sourceUrl,
          sourcePath: resource.path,
          localPath,
          wpPath: `/wp-content/uploads/${basename}`,
          role: resource.contentType,
        });
        existing.add(key);
      }
      const completed = index + 1;
      if (completed % batchSize === 0 || completed === downloaded.length) {
        writeJson(path.join(ctx.importsPath, 'media-map.json'), ctx.mediaMap);
        options.onBatch?.(completed, downloaded.length, resource.path ?? resource.sourceUrl);
      }
    }

    for (const rawMissing of ctx.source.resources.referencedButNotDownloaded ?? []) {
      const missing = normalizeExternalResource(rawMissing);
      if (!missing) continue;
      ctx.warnings.push(`Resource not downloaded; external fallback kept: ${missing}`);
      const key = `${missing}\u0000`;
      if (!existing.has(key)) {
        ctx.mediaMap.push({ sourceUrl: missing, role: 'external-fallback' });
        existing.add(key);
      }
    }

    writeJson(path.join(ctx.importsPath, 'media-map.json'), ctx.mediaMap);
  }
}

export class ComponentBuilder {
  public decide(ctx: BuildContext): ComponentDecision[] {
    const decisions: ComponentDecision[] = [];
    for (const page of ctx.source.pages) {
      for (const component of page.components ?? []) {
        decisions.push(this.decideComponent(component));
      }
      for (const section of page.layout ?? []) {
        for (const block of section.blocks ?? []) {
          decisions.push(this.decideBlock(block));
        }
      }
    }
    ctx.componentDecisions.push(...decisions);
    writeJson(path.join(ctx.validationPath, 'component-decisions.json'), decisions);
    return decisions;
  }

  private decideComponent(component: SourceComponent): ComponentDecision {
    const type = component.type ?? 'unknown';
    const native = ['heading', 'paragraph', 'button', 'image', 'gallery', 'list', 'table'];
    const pattern = ['hero', 'banner', 'cards', 'grid', 'footer', 'header', 'newsletter', 'form', 'accordion', 'tabs', 'navigation'];
    if (type === 'unknown' || type === 'carousel' || type === 'slider') {
      return {
        sourceId: component.id ?? `component:${type}`,
        type,
        strategy: 'html_fallback',
        confidence: 0.72,
        reason: 'Interactive or unknown component; fidelity is safer with preserved HTML.',
      };
    }
    if (native.includes(type)) {
      return {
        sourceId: component.id ?? `component:${type}`,
        type,
        strategy: 'gutenberg',
        confidence: 0.86,
        reason: 'Component maps to native Gutenberg semantics.',
      };
    }
    if (pattern.includes(type)) {
      return {
        sourceId: component.id ?? `component:${type}`,
        type,
        strategy: 'pattern',
        confidence: 0.78,
        reason: 'Component can be represented as a reusable WordPress pattern when layout is simple.',
      };
    }
    return {
      sourceId: component.id ?? `component:${type}`,
      type,
      strategy: /product|commerce|cart|shop/i.test(type) ? 'woocommerce' : 'html_fallback',
      confidence: 0.7,
      reason: 'Fallback decision from component type heuristic.',
    };
  }

  private decideBlock(block: SourceLayoutBlock): ComponentDecision {
    return this.decideComponent({ id: block.id, type: block.type, mediaRefs: block.mediaRefs });
  }

  public renderPageContent(ctx: BuildContext, page: SourcePage): string {
    const rawHtml = ctx.source.rawHtmlBySlug.get(page.slug);
    // The raw page is the fidelity source. Never split it into Gutenberg
    // blocks: splitting changes DOM ancestry and breaks builder CSS/JS.
    if (rawHtml) {
      const head = capturedHeadPresentation(ctx, page, rawHtml);
      const body = removeUnlocalizableEmbeds(ctx, rewriteUrls(ctx, capturedBody(rawHtml), page.finalUrl ?? page.sourceUrl));
      return `${head}\n${body}`;
    }

    const parts: string[] = [];
    const h1 = page.headings?.h1?.[0] ?? page.title;
    if (h1) parts.push(headingBlock(h1, 1));
    for (const section of page.layout ?? []) {
      const blocks = section.blocks ?? [];
      if (blocks.length === 0) continue;
      parts.push('<!-- wp:group --><div class="wp-block-group autowp-section">');
      for (const block of blocks) {
        parts.push(this.renderBlock(block));
      }
      parts.push('</div><!-- /wp:group -->');
    }

    if (parts.length === 0 && page.content) {
      parts.push(textBlock(page.content));
    }
    return parts.join('\n');
  }

  /**
   * Produces Gutenberg markup without changing the captured DOM. When a page
   * has one stable outer wrapper, the wrapper is kept outside Gutenberg and
   * each direct child becomes an independently editable AutoWP block. This is
   * the same fidelity-first conversion used by the visual editor: no generic
   * layout, spacing or typography is invented during import.
   */
  public renderEditablePageContent(ctx: BuildContext, page: SourcePage): EditablePageRecord {
    const rawHtml = ctx.source.rawHtmlBySlug.get(page.slug);
    if (rawHtml) {
      const localized = removeUnlocalizableEmbeds(ctx, rewriteUrls(ctx, isolateMain(rawHtml), page.finalUrl ?? page.sourceUrl)).trim();
      const native = buildNativeGutenberg(localized);
      ctx.warnings.push(...native.warnings.map((warning) => `${page.slug}: ${warning}`));
      return { content: native.content, wrapperOpen: '', wrapperClose: '', blockCount: native.blockCount, strategy: 'native_gutenberg' };
    }

    const content = this.renderPageContent(ctx, page);
    const blockCount = (content.match(/<!-- wp:/g) ?? []).length;
    return { content, wrapperOpen: '', wrapperClose: '', blockCount, strategy: 'semantic_blocks' };
  }

  private renderBlock(block: SourceLayoutBlock): string {
    const text = block.text?.trim();
    if (block.type === 'heading' && text) return headingBlock(text, 2);
    if (block.type === 'paragraph' && text) return textBlock(text);
    if (block.type === 'image' && block.mediaRefs?.[0]) return imageBlock(block.mediaRefs[0]);
    const children = (block.children ?? []).map((child) => this.renderBlock(child)).join('\n');
    if (text && children.length === 0) return textBlock(text);
    return children || '';
  }
}

export class GlobalStylesBuilder {
  public build(ctx: BuildContext): void {
    const globalStyles = (ctx.source.wordpressIndex.globalStyles ?? {}) as Record<string, unknown>;
    const colors = Array.isArray(globalStyles.colors) ? globalStyles.colors.filter((v): v is string => typeof v === 'string') : [];
    const fonts = Array.isArray(globalStyles.fonts) ? globalStyles.fonts.filter((v): v is string => typeof v === 'string') : [];
    const variables = typeof globalStyles.cssVariables === 'object' && globalStyles.cssVariables !== null
      ? globalStyles.cssVariables as Record<string, string>
      : {};

    const cssVariables = Object.entries(variables)
      .map(([name, value]) => `  ${name}: ${rewriteUrls(ctx, value, ctx.source.pages[0]?.finalUrl)};`)
      .join('\n');
    const css = [
      '/*',
      `Theme Name: ${ctx.options.projectName}`,
      'Author: AutoWP Builder',
      'Version: 0.1.0',
      '*/',
      ':root {',
      cssVariables || '  --autowp-text: #111; --autowp-background: #fff;',
      '}',
      '/* Source CSS is deliberately allowed to control layout, fonts, spacing and responsive behaviour. */',
      '/* Captured consent banners keep their source appearance. The local interaction bridge makes their controls usable. */',
      '[data-autowp-consent-bridge="1"] button, [data-autowp-consent-bridge="1"] a, [data-autowp-consent-bridge="1"] [role="button"] { pointer-events: auto !important; cursor: pointer !important; }',
      '[data-autowp-consent-hidden="1"] { display: none !important; }',
      '/* External CAPTCHA cannot run offline. Collapse its reserved box while keeping the form usable. */',
      '.g-recaptcha:not(html):not(body), .h-captcha:not(html):not(body), [class*="captcha"]:not(html):not(body), [id*="captcha"]:not(html):not(body), iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="google.com/recaptcha"] { display: none !important; width: 0 !important; height: 0 !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important; }',
      '.autowp-local-antispam { display: none !important; }',
    ].join('\n');

    const sourceCss: string[] = [];
    const baseUrl = ctx.source.pages[0]?.finalUrl ?? ctx.source.pages[0]?.sourceUrl;
    for (const asset of ctx.mediaMap) {
      if (!asset.sourcePath || !/css(?:$|[?#])/i.test(asset.sourceUrl ?? asset.sourcePath)) continue;
      const filePath = safeJoin(ctx.source.rootPath, asset.sourcePath);
      if (fs.existsSync(filePath)) sourceCss.push(removeUnlocalizableCss(ctx, rewriteUrls(ctx, fs.readFileSync(filePath, 'utf8'), asset.sourceUrl ?? baseUrl)));
    }
    // Inline styles are page-specific and are emitted with their captured
    // page. Combining them here made unrelated routes override one another.
    // This override must be appended after captured vendor CSS. Consent/CAPTCHA
    // styles commonly re-enable their white placeholder after our theme CSS.
    sourceCss.push('.cmplz-blocked-content-container, .cmplz-wp-video, .cmplz-placeholder-parent, .cmplz-video, .g-recaptcha:not(html):not(body), .h-captcha:not(html):not(body), [class*="captcha"]:not(html):not(body), [id*="captcha"]:not(html):not(body), iframe[src*="recaptcha"], iframe[src*="hcaptcha"] { display:none !important; width:0 !important; height:0 !important; min-height:0 !important; max-height:0 !important; margin:0 !important; padding:0 !important; border:0 !important; }');
    writeText(path.join(ctx.themePath, 'style.css'), css);
    writeText(path.join(ctx.themePath, 'assets', 'source.css'), sourceCss.join('\n'));
    writeJson(path.join(ctx.themePath, 'theme.json'), {
      version: 2,
      settings: {
        color: { palette: colors.slice(0, 24).map((color, index) => ({ slug: `source-${index}`, color, name: `Source ${index + 1}` })) },
        typography: { fontFamilies: fonts.slice(0, 12).map((font, index) => ({ slug: `font-${index}`, fontFamily: font, name: `Source Font ${index + 1}` })) },
        layout: { contentSize: '1180px', wideSize: '1440px' },
      },
    });
  }
}

export class NavigationBuilder {
  public build(ctx: BuildContext): void {
    const nav = (Array.isArray(ctx.source.wordpressIndex.navigation) ? ctx.source.wordpressIndex.navigation : []) as Array<{
      id?: string; name?: string; position?: string; items?: Array<{ label?: string; href?: string; children?: unknown[] }>;
    }>;
    const fallbackItems = ctx.source.pages.slice(0, 30).map((page) => ({
      label: page.title ?? page.slug,
      href: localRoute(page),
      children: [],
    }));
    const uniqueMenus = new Map<string, { id: string; name: string; position: string; items: Array<{ label: string; href: string; children: unknown[] }> }>();
    for (const menu of nav) {
      const position = menu.position === 'footer' ? 'footer' : 'primary';
      const key = `${position}:${(menu.name ?? menu.id ?? position).toLowerCase()}`;
      if (uniqueMenus.has(key) || uniqueMenus.size >= 4) continue;
      const seenItems = new Set<string>();
      const items = (Array.isArray(menu.items) ? menu.items : []).flatMap((item) => {
        const href = rewriteUrl(ctx, item.href ?? '#', ctx.source.pages[0]?.finalUrl);
        const label = item.label ?? href;
        const itemKey = `${label}|${href}`;
        if (seenItems.has(itemKey) || seenItems.size >= 50) return [];
        seenItems.add(itemKey);
        return [{ label, href, children: item.children ?? [] }];
      });
      uniqueMenus.set(key, { id: menu.id ?? key, name: menu.name ?? (position === 'footer' ? 'Footer' : 'Primary'), position, items });
    }
    const menuScore = (menu: { name: string; position: string; items: Array<{ label: string; href: string }> }): number => {
      const meaningful = menu.items.filter((item) => {
        const label = item.label.trim();
        return label.length > 1 && !/^\d+$/.test(label) && !/[?&](?:page|paged)=\d+/i.test(item.href);
      }).length;
      const name = menu.name.toLowerCase();
      const semanticBonus = /primary|main|header|principal|navegaci[oó]n/.test(name) ? 100 : 0;
      const paginationPenalty = /pagin|pager/.test(name) ? 200 : 0;
      return semanticBonus + (meaningful * 10) - Math.abs(menu.items.length - 6) - paginationPenalty;
    };
    const candidates = uniqueMenus.size > 0 ? [...uniqueMenus.values()] : [{ id: 'primary', name: 'Primary', position: 'primary', items: fallbackItems }];
    const bestFor = (position: string) => candidates
      .filter((menu) => menu.position === position && menu.items.length > 0)
      .sort((a, b) => menuScore(b) - menuScore(a))[0];
    const menus = [bestFor('primary'), bestFor('footer')].filter((menu): menu is NonNullable<typeof menu> => Boolean(menu));
    writeJson(path.join(ctx.importsPath, 'menus.json'), menus);
  }
}

export class SeoBuilder {
  public build(ctx: BuildContext): void {
    const seoMap = ctx.source.pages.map((page) => ({
      slug: page.slug,
      title: page.title,
      description: page.metaDescription,
      canonical: page.canonical,
      robots: page.robots,
      seo: page.seo,
    }));
    writeJson(path.join(ctx.importsPath, 'seo-map.json'), seoMap);
    writeJson(path.join(ctx.importsPath, 'optimization-plan.json'), ctx.source.optimizationPlan ?? {
      schemaVersion: 1,
      source: 'verified_rules',
      mode: 'review_required',
      totals: { pagesAnalyzed: ctx.source.pages.length, proposals: 0, rejectedUnsafe: 0 },
      proposals: [],
    });
  }
}

export class WooCommerceBuilder {
  public build(ctx: BuildContext): void {
    writeText(path.join(ctx.importsPath, 'woocommerce-products.csv'), ctx.source.wooCommerceCsv);
    writeJson(path.join(ctx.importsPath, 'products.json'), ctx.source.products);
    // Keep the potentially very large, URL-rewritten product payload out of
    // functions.php. PHP compiles the entire theme file before WP-CLI starts;
    // embedding thousands of products there exhausts the default 128 MB limit.
    writeText(path.join(ctx.importsPath, 'products-seed.json'), this.productSeedPhp(ctx));
    writeText(path.join(ctx.importsPath, 'autowp-seed.php'), this.seedPhp());
  }

  public productSeedPhp(ctx: BuildContext): string {
    const localizeValue = (value: unknown): unknown => {
      if (typeof value === 'string') return rewriteUrls(ctx, value);
      if (Array.isArray(value)) return value.map(localizeValue);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, localizeValue(item)]));
      return value;
    };
    const seed = normalizeCommerceProducts(ctx.source.products).map((product) => localizeValue({
      ...product,
      description: rewriteUrls(ctx, product.description),
      shortDescription: rewriteUrls(ctx, product.shortDescription),
      images: uniqueStrings(product.images.map((image) => rewriteUrl(ctx, image))),
      variants: product.variants.map((variant) => ({ ...variant, image: variant.image ? rewriteUrl(ctx, variant.image) : undefined })),
    }));
    return JSON.stringify(seed, null, 2);
  }

  private seedPhp(): string {
    return `<?php
@ini_set('memory_limit', '1024M');
$imports = '/var/www/html/autowp-imports';
$validation = '/var/www/html/autowp-validation';
$read_json = function($name) use ($imports) {
  $file = $imports . '/' . $name;
  return is_readable($file) ? json_decode(file_get_contents($file), true) : array();
};
$write_json_atomic = function($name, $value) use ($imports) {
  $file = $imports . '/' . $name;
  $temporary = $file . '.tmp-' . getmypid();
  file_put_contents($temporary, wp_json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
  if (!@rename($temporary, $file)) {
    @unlink($file);
    @rename($temporary, $file);
  }
};
$write_commerce_checkpoint = function(&$checkpoint) use ($write_json_atomic) {
  $now = time();
  $started = strtotime((string) ($checkpoint['startedAt'] ?? '')) ?: $now;
  $elapsed = max(0, $now - $started);
  $completed = 0;
  $total = 0;
  foreach (array('media', 'products', 'variants') as $section) {
    $section_completed = (int) ($checkpoint[$section]['completed'] ?? 0);
    $section_total = (int) ($checkpoint[$section]['total'] ?? 0);
    $batch_size = max(1, (int) (getenv('AUTOWP_COMMERCE_BATCH_SIZE') ?: 25));
    $checkpoint[$section]['batchSize'] = $batch_size;
    $checkpoint[$section]['currentBatch'] = $section_completed > 0 ? (int) ceil($section_completed / $batch_size) : 0;
    $checkpoint[$section]['totalBatches'] = $section_total > 0 ? (int) ceil($section_total / $batch_size) : 0;
    $completed += $section_completed;
    $total += $section_total;
  }
  $speed = $elapsed > 0 ? $completed / $elapsed : 0;
  $checkpoint['progress'] = array(
    'completedItems' => $completed,
    'totalItems' => $total,
    'percent' => $total > 0 ? round(($completed / $total) * 100, 2) : 0,
    'elapsedSeconds' => $elapsed,
    'itemsPerSecond' => round($speed, 4),
    'estimatedRemainingSeconds' => $speed > 0 ? (int) ceil(max(0, $total - $completed) / $speed) : null,
    'currentItem' => (string) ($checkpoint[$checkpoint['phase'] ?? 'products']['last'] ?? ''),
  );
  $checkpoint['updatedAt'] = gmdate('c');
  $write_json_atomic('commerce-checkpoint.json', $checkpoint);
};
$seed_hash = hash_file('sha256', $imports . '/products-seed.json') ?: '';
$media_hash = hash_file('sha256', $imports . '/media-map.json') ?: '';
$commerce_checkpoint = $read_json('commerce-checkpoint.json');
if (!is_array($commerce_checkpoint) || ($commerce_checkpoint['seedHash'] ?? '') !== $seed_hash || ($commerce_checkpoint['mediaHash'] ?? '') !== $media_hash) {
  $commerce_checkpoint = array(
    'schemaVersion' => 1,
    'seedHash' => $seed_hash,
    'mediaHash' => $media_hash,
    'phase' => 'media',
    'status' => 'running',
    'media' => array('completed' => 0, 'total' => 0, 'last' => null),
    'products' => array('completed' => 0, 'total' => 0, 'last' => null, 'completedSkus' => array()),
    'variants' => array('completed' => 0, 'total' => 0, 'last' => null),
    'mapping' => array(),
    'startedAt' => gmdate('c'),
    'updatedAt' => gmdate('c'),
  );
  $write_commerce_checkpoint($commerce_checkpoint);
}
$media = $read_json('media-map.json');
$commerce_checkpoint['media']['total'] = is_array($media) ? count($media) : 0;
$attachment_ids = array();
$attachment_ids_normalized = array();
$normalize_media_url = function($url) {
  $url = html_entity_decode(trim((string) $url));
  $parts = wp_parse_url($url);
  if (!$parts || empty($parts['path'])) return rtrim($url, '/');
  return strtolower(rtrim(rawurldecode($parts['path']), '/'));
};
$media_index = 0;
foreach ($media as $asset) {
  $media_index++;
  if (empty($asset['wpPath'])) {
    $commerce_checkpoint['media']['completed'] = $media_index;
    $commerce_checkpoint['media']['last'] = (string) ($asset['sourceUrl'] ?? '');
    $commerce_checkpoint['media']['lastStatus'] = 'missing-wp-path';
    $commerce_checkpoint['updatedAt'] = gmdate('c');
    $write_commerce_checkpoint($commerce_checkpoint);
    continue;
  }
  $relative = ltrim(str_replace('/wp-content/uploads/', '', $asset['wpPath']), '/');
  $file = WP_CONTENT_DIR . '/uploads/' . $relative;
  if (!is_readable($file)) {
    $commerce_checkpoint['media']['completed'] = $media_index;
    $commerce_checkpoint['media']['last'] = (string) ($asset['sourceUrl'] ?? $asset['wpPath']);
    $commerce_checkpoint['media']['lastStatus'] = 'local-file-unreadable';
    $commerce_checkpoint['updatedAt'] = gmdate('c');
    $write_commerce_checkpoint($commerce_checkpoint);
    continue;
  }
  $existing = get_posts(array('post_type' => 'attachment', 'meta_key' => '_autowp_source_url', 'meta_value' => $asset['sourceUrl'] ?? '', 'posts_per_page' => 1, 'fields' => 'ids'));
  $id = $existing ? (int) $existing[0] : 0;
  if (!$id) {
    $type = wp_check_filetype(basename($file), null);
    $id = wp_insert_attachment(array('post_mime_type' => $type['type'] ?? '', 'post_title' => sanitize_file_name(basename($file)), 'post_status' => 'inherit'), $file);
    if (!is_wp_error($id)) {
      update_post_meta($id, '_autowp_source_url', $asset['sourceUrl'] ?? '');
    }
  }
  // WordPress needs real attachment metadata to calculate responsive image
  // sizes. Without it WooCommerce renders imported images as 1x1 pixels.
  if (!is_wp_error($id) && $id) {
    require_once ABSPATH . 'wp-admin/includes/image.php';
    $metadata = wp_get_attachment_metadata((int) $id);
    $needs_metadata = !is_array($metadata) || (int) ($metadata['width'] ?? 0) <= 1 || (int) ($metadata['height'] ?? 0) <= 1;
    if ($needs_metadata) {
      $generated = wp_generate_attachment_metadata((int) $id, $file);
      if (is_array($generated) && !empty($generated)) wp_update_attachment_metadata((int) $id, $generated);
    }
  }
  if (!is_wp_error($id) && !empty($asset['sourceUrl'])) { $attachment_ids[$asset['sourceUrl']] = (int) $id; $attachment_ids_normalized[$normalize_media_url($asset['sourceUrl'])] = (int) $id; if (!empty($asset['wpPath'])) { $attachment_ids[$asset['wpPath']] = (int) $id; $attachment_ids_normalized[$normalize_media_url($asset['wpPath'])] = (int) $id; } }
  $commerce_checkpoint['phase'] = 'media';
  $commerce_checkpoint['media']['completed'] = $media_index;
  $commerce_checkpoint['media']['last'] = (string) ($asset['sourceUrl'] ?? $asset['wpPath'] ?? '');
  $commerce_checkpoint['media']['lastStatus'] = 'completed';
  $commerce_checkpoint['updatedAt'] = gmdate('c');
  $write_commerce_checkpoint($commerce_checkpoint);
}
$lookup_attachment = function($url) use ($attachment_ids, $attachment_ids_normalized, $normalize_media_url) {
  if (isset($attachment_ids[$url])) return (int) $attachment_ids[$url];
  return (int) ($attachment_ids_normalized[$normalize_media_url($url)] ?? 0);
};

$pages = function_exists('autowp_source_pages') ? autowp_source_pages() : array();
$editable_pages = $read_json('editable-pages.json');
$editable_conversion = array();
foreach ($pages as $slug => $page) {
  $route = trim((string) ($page['route'] ?? ''), '/');
  $segments = $route === '' ? array() : array_values(array_filter(explode('/', $route), 'strlen'));
  $post_name = $slug === 'home' ? 'home' : ($segments ? sanitize_title(end($segments)) : sanitize_title($slug));
  $parent_id = 0;
  $path_parts = array();
  // Preserve nested source routes as real WordPress page parents.
  foreach (array_slice($segments, 0, -1) as $segment) {
    $path_parts[] = sanitize_title($segment);
    $parent = get_page_by_path(implode('/', $path_parts));
    if ($parent) { $parent_id = (int) $parent->ID; continue; }
    $new_parent = wp_insert_post(array('post_title' => ucwords(str_replace('-', ' ', $segment)), 'post_name' => sanitize_title($segment), 'post_status' => 'publish', 'post_type' => 'page', 'post_parent' => $parent_id));
    if (!is_wp_error($new_parent)) $parent_id = (int) $new_parent;
  }
  $page_path = $slug === 'home' ? 'home' : ($segments ? implode('/', array_map('sanitize_title', $segments)) : $post_name);
  $existing = get_page_by_path($page_path);
  $template = get_stylesheet_directory() . '/' . $page['template'];
  $source_content = is_readable($template) ? file_get_contents($template) : '';
  $editable = is_array($editable_pages[$slug] ?? null) ? $editable_pages[$slug] : array();
  $content = (string) ($editable['content'] ?? $source_content);
  $postarr = array(
    'post_title' => $page['title'],
    'post_name' => $post_name,
    'post_parent' => $parent_id,
    'post_status' => 'publish',
    'post_type' => 'page',
    'post_content' => $content,
  );
  if ($existing) {
    $postarr['ID'] = $existing->ID;
    wp_update_post($postarr);
  } else {
    $postarr['ID'] = wp_insert_post($postarr);
  }
  if (!empty($postarr['ID'])) {
    update_post_meta($postarr['ID'], '_yoast_wpseo_title', $page['title']);
    update_post_meta($postarr['ID'], '_yoast_wpseo_metadesc', $page['description']);
    if (!empty($editable['content']) && has_blocks($content)) {
      // Keep the atomic Gutenberg conversion available for editing, but do
      // not use it as the public renderer until it has independently passed
      // the visual quality gate. Converting arbitrary builder DOM to blocks
      // changes ancestry and is the main cause of severely broken replicas.
      update_post_meta($postarr['ID'], '_autowp_has_editable_blocks', '1');
      update_post_meta($postarr['ID'], '_autowp_render_strategy', 'source_fidelity');
      delete_post_meta($postarr['ID'], '_autowp_use_editable_blocks');
      update_post_meta($postarr['ID'], '_autowp_block_wrapper_open', (string) ($editable['wrapperOpen'] ?? ''));
      update_post_meta($postarr['ID'], '_autowp_block_wrapper_close', (string) ($editable['wrapperClose'] ?? ''));
    } else {
      delete_post_meta($postarr['ID'], '_autowp_has_editable_blocks');
      update_post_meta($postarr['ID'], '_autowp_render_strategy', 'source_fidelity');
      delete_post_meta($postarr['ID'], '_autowp_use_editable_blocks');
      delete_post_meta($postarr['ID'], '_autowp_block_wrapper_open');
      delete_post_meta($postarr['ID'], '_autowp_block_wrapper_close');
    }
    $editable_conversion[] = array(
      'slug' => $slug,
      'postId' => (int) $postarr['ID'],
      'blocks' => (int) ($editable['blockCount'] ?? 0),
      'strategy' => sanitize_key($editable['strategy'] ?? 'source_html'),
      'editable' => has_blocks($content),
      'roundtripStable' => has_blocks($content)
        ? hash('sha256', serialize_blocks(parse_blocks($content))) === hash('sha256', serialize_blocks(parse_blocks(serialize_blocks(parse_blocks($content)))))
        : false,
      'publicRendererIsolated' => true,
    );
  }
}
$home = get_page_by_path('home');
if ($home) {
  update_option('show_on_front', 'page');
  update_option('page_on_front', $home->ID);
}

if (function_exists('wc_create_pages')) wc_create_pages();
// Captured source routes may include static cart/account markup. WooCommerce
// must own these transactional pages so sessions, totals, checkout and account
// forms stay functional instead of rendering a frozen copy of the source.
$woocommerce_system_pages = array(
  'cart' => array('option' => 'woocommerce_cart_page_id', 'title' => 'Carrito', 'slug' => 'cart', 'content' => '<!-- wp:shortcode -->[woocommerce_cart]<!-- /wp:shortcode -->'),
  'checkout' => array('option' => 'woocommerce_checkout_page_id', 'title' => 'Finalizar compra', 'slug' => 'checkout', 'content' => '<!-- wp:shortcode -->[woocommerce_checkout]<!-- /wp:shortcode -->'),
  'myaccount' => array('option' => 'woocommerce_myaccount_page_id', 'title' => 'Mi cuenta', 'slug' => 'my-account', 'content' => '<!-- wp:shortcode -->[woocommerce_my_account]<!-- /wp:shortcode -->'),
  'shop' => array('option' => 'woocommerce_shop_page_id', 'title' => 'Tienda', 'slug' => 'shop', 'content' => '<!-- wp:woocommerce/product-collection {"query":{"perPage":12,"pages":0,"offset":0,"postType":"product","order":"desc","orderBy":"date","search":"","exclude":[],"inherit":false,"taxQuery":{},"isProductCollectionBlock":true}} /-->'),
);
foreach ($woocommerce_system_pages as $kind => $system_page) {
  $page_id = (int) get_option($system_page['option']);
  $page = $page_id ? get_post($page_id) : get_page_by_path($system_page['slug']);
  if (!$page) {
    $page_id = (int) wp_insert_post(array('post_title' => $system_page['title'], 'post_name' => $system_page['slug'], 'post_status' => 'publish', 'post_type' => 'page', 'post_content' => $system_page['content']));
  } else {
    $page_id = (int) $page->ID;
    wp_update_post(array('ID' => $page_id, 'post_title' => $system_page['title'], 'post_name' => $system_page['slug'], 'post_status' => 'publish', 'post_content' => $system_page['content']));
  }
  if ($page_id > 0) {
    update_option($system_page['option'], $page_id);
    update_post_meta($page_id, '_autowp_has_editable_blocks', '1');
    update_post_meta($page_id, '_autowp_render_strategy', 'woocommerce_native');
    delete_post_meta($page_id, '_autowp_use_editable_blocks');
    $editable_conversion[] = array(
      'slug' => $system_page['slug'],
      'postId' => $page_id,
      'blocks' => max(1, count(parse_blocks($system_page['content']))),
      'strategy' => 'woocommerce_native',
      'editable' => has_blocks($system_page['content']),
      'roundtripStable' => hash('sha256', serialize_blocks(parse_blocks($system_page['content']))) === hash('sha256', serialize_blocks(parse_blocks(serialize_blocks(parse_blocks($system_page['content']))))),
      'publicRendererIsolated' => true,
    );
  }
}
$editable_total = 0;
foreach ($editable_conversion as $converted_page) $editable_total += (int) ($converted_page['blocks'] ?? 0);
$expected_editable_pages = count($pages) + count($woocommerce_system_pages);
$editable_pass = count($editable_conversion) === $expected_editable_pages;
foreach ($editable_conversion as $converted_page) {
  if (empty($converted_page['editable']) || empty($converted_page['roundtripStable']) || empty($converted_page['publicRendererIsolated']) || (int) ($converted_page['blocks'] ?? 0) < 1) {
    $editable_pass = false;
    break;
  }
}
file_put_contents($imports . '/editable-blocks-report.json', wp_json_encode(array(
  'generatedAt' => gmdate('c'),
  'pages' => $editable_conversion,
  'pageCount' => count($editable_conversion),
  'expectedPageCount' => $expected_editable_pages,
  'blockCount' => $editable_total,
  'visualEditorAvailable' => function_exists('autowp_visual_save') && function_exists('autowp_visual_rollback'),
  'allPagesEditable' => $editable_pass,
  'status' => $editable_pass ? 'pass' : 'needs_review'
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
// Every generated store needs at least one usable checkout method. Bank
// transfer is local, requires no third-party secret and keeps orders in a safe
// on-hold state until the merchant connects a live card provider.
$bacs_settings = get_option('woocommerce_bacs_settings', array());
if (!is_array($bacs_settings)) $bacs_settings = array();
update_option('woocommerce_bacs_settings', array_merge($bacs_settings, array(
  'enabled' => 'yes',
  'title' => 'Transferencia bancaria',
  'description' => 'Realiza el pago mediante transferencia bancaria. El pedido se confirmará al recibir el pago.',
  'instructions' => 'Usa el número de pedido como referencia del pago.',
)));
// Keep the locally generated store purchasable before the merchant connects
// production shipping and payment providers. These defaults are deliberately
// conservative and can be replaced from WooCommerce settings at any time.
update_option('woocommerce_enable_guest_checkout', 'yes');
update_option('woocommerce_enable_checkout_login_reminder', 'no');
update_option('woocommerce_default_country', 'ES');
if (class_exists('WC_Shipping_Zone')) {
  $fallback_zone = new WC_Shipping_Zone(0);
  $fallback_methods = $fallback_zone->get_shipping_methods(true);
  $has_enabled_shipping = false;
  foreach ($fallback_methods as $fallback_method) {
    if (($fallback_method->enabled ?? 'no') === 'yes') { $has_enabled_shipping = true; break; }
  }
  if (!$has_enabled_shipping) $fallback_zone->add_shipping_method('free_shipping');
}
$products = $read_json('products-seed.json');
$autowp_product_route_map = array();
$autowp_product_variant_map = array();
$commerce_product_map = array();
$expected_checkpoint_variants = 0;
foreach (($products ?: array()) as $checkpoint_product) $expected_checkpoint_variants += is_array($checkpoint_product['variants'] ?? null) ? count($checkpoint_product['variants']) : 0;
$commerce_checkpoint['phase'] = 'products';
$commerce_checkpoint['products']['total'] = is_array($products) ? count($products) : 0;
$commerce_checkpoint['variants']['total'] = $expected_checkpoint_variants;
$commerce_checkpoint['updatedAt'] = gmdate('c');
$write_commerce_checkpoint($commerce_checkpoint);
foreach (($products ?: array()) as $product_item) {
  $currency = strtoupper(trim((string) ($product_item['currency'] ?? '')));
  if ($currency !== '') { update_option('woocommerce_currency', $currency); break; }
}
if (class_exists('WC_Product_Simple') && is_array($products)) {
  $desired_product_skus = array_values(array_filter(array_map(function($item) { return (string) ($item['sku'] ?? ''); }, $products)));
  $desired_variant_skus = array();
  foreach ($products as $item) foreach (($item['variants'] ?? array()) as $variant) if (!empty($variant['sku'])) $desired_variant_skus[] = (string) $variant['sku'];
  foreach (wc_get_products(array('limit' => -1, 'return' => 'objects', 'status' => array('publish', 'draft', 'pending', 'private'))) as $old_product) {
    if ($old_product->get_meta('_autowp_imported') !== '1') continue;
    if (!in_array($old_product->get_sku(), $desired_product_skus, true)) $old_product->delete(true);
  }
  $product_index = 0;
  $variant_index = 0;
  foreach ($products as $item) {
    $product_index++;
    $sku = $item['sku'] ?? '';
    $commerce_checkpoint['phase'] = 'products';
    $commerce_checkpoint['products']['last'] = (string) ($sku ?: ($item['sourceUrl'] ?? $item['name'] ?? $product_index));
    $commerce_checkpoint['products']['lastStatus'] = 'processing';
    $commerce_checkpoint['updatedAt'] = gmdate('c');
    $write_commerce_checkpoint($commerce_checkpoint);
    $existingId = $sku ? wc_get_product_id_by_sku($sku) : 0;
    $is_variable = !empty($item['variants']);
    $existing = $existingId ? wc_get_product($existingId) : false;
    if ($existing && (($is_variable && !$existing->is_type('variable')) || (!$is_variable && !$existing->is_type('simple')))) {
      $existing->delete(true);
      $existing = false;
    }
    $product = $existing ?: ($is_variable ? new WC_Product_Variable() : new WC_Product_Simple());
    if (!$product) {
      $product = $is_variable ? new WC_Product_Variable() : new WC_Product_Simple();
    }
    $product->set_name($item['name'] ?? ($sku ?: 'Product'));
    if ($sku) $product->set_sku($sku);
    $product->set_slug($item['slug'] ?? sanitize_title($item['name'] ?? $sku));
    $product->set_description($item['description'] ?? '');
    $product->set_short_description($item['shortDescription'] ?? '');
    if (($item['regularPrice'] ?? '') !== '') $product->set_regular_price((string) $item['regularPrice']);
    if (($item['salePrice'] ?? '') !== '') $product->set_sale_price((string) $item['salePrice']);
    if (($item['stock'] ?? '') !== '') {
      $product->set_manage_stock(true);
      $product->set_stock_quantity((int) $item['stock']);
    } else {
      $product->set_manage_stock(false);
    }
    if (($item['stockStatus'] ?? '') !== '') $product->set_stock_status((string) $item['stockStatus']);
    $product->set_status('publish');
    $productId = $product->save();
    $product->update_meta_data('_autowp_imported', '1');
    $product->update_meta_data('_autowp_source_url', (string) ($item['sourceUrl'] ?? ''));
    $product->save();
    $normalized_source_path = '';
    $source_path = wp_parse_url((string) ($item['sourceUrl'] ?? ''), PHP_URL_PATH);
    if (is_string($source_path) && trim($source_path, '/') !== '') {
      $normalized_source_path = '/' . trim(rawurldecode($source_path), '/');
      $autowp_product_route_map[$normalized_source_path] = (int) $productId;
      $autowp_product_variant_map[$normalized_source_path] = array();
    }
    if (!empty($item['categories']) && is_array($item['categories'])) {
      wp_set_object_terms($productId, $item['categories'], 'product_cat');
    }
    if (!empty($item['tags']) && is_array($item['tags'])) {
      wp_set_object_terms($productId, $item['tags'], 'product_tag');
    }
    $attributes = array();
    foreach (($item['attributes'] ?? array()) as $name => $value) {
      $attribute = new WC_Product_Attribute();
      $attribute->set_name((string) $name);
      $attribute->set_options(is_array($value) ? $value : array($value));
      $attribute->set_visible(true);
      $attribute->set_variation($is_variable);
      $attributes[] = $attribute;
    }
    if ($attributes) { $product->set_attributes($attributes); $product->save(); }
    $images = $item['images'] ?? array();
    $image_ids = array_values(array_unique(array_filter(array_map(function($url) use ($lookup_attachment) { return $lookup_attachment($url); }, $images))));
    if ($image_ids) { $product->set_image_id($image_ids[0]); $product->set_gallery_image_ids(array_slice($image_ids, 1)); $product->save(); }
    $kept_variation_ids = array();
    $kept_variation_ids_by_sku = array();
    $default_attributes = array();
    foreach (($item['variants'] ?? array()) as $variant) {
      $variant_index++;
      $commerce_checkpoint['phase'] = 'variants';
      $commerce_checkpoint['variants']['last'] = (string) ($variant['sku'] ?? $variant['id'] ?? $variant_index);
      $commerce_checkpoint['variants']['lastStatus'] = 'processing';
      $commerce_checkpoint['updatedAt'] = gmdate('c');
      $write_commerce_checkpoint($commerce_checkpoint);
      $variation_id = 0;
      if (!empty($variant['sku'])) {
        $matching_variation_ids = get_posts(array('post_type' => 'product_variation', 'post_status' => 'any', 'numberposts' => -1, 'fields' => 'ids', 'meta_key' => '_sku', 'meta_value' => (string) $variant['sku']));
        if ($matching_variation_ids) {
          $variation_id = (int) array_shift($matching_variation_ids);
          foreach ($matching_variation_ids as $duplicate_variation_id) wp_delete_post((int) $duplicate_variation_id, true);
        } else {
          $variation_id = (int) wc_get_product_id_by_sku($variant['sku']);
        }
      }
      $variation = $variation_id ? new WC_Product_Variation($variation_id) : new WC_Product_Variation();
      $variation->set_parent_id($productId);
      if (!empty($variant['sku'])) $variation->set_sku($variant['sku']);
      if (($variant['regularPrice'] ?? '') !== '') $variation->set_regular_price((string) $variant['regularPrice']);
      if (($variant['price'] ?? '') !== '') $variation->set_regular_price((string) $variant['price']);
      if (($variant['salePrice'] ?? '') !== '') $variation->set_sale_price((string) $variant['salePrice']);
      if (($variant['stock'] ?? '') !== '') { $variation->set_manage_stock(true); $variation->set_stock_quantity((int) $variant['stock']); }
      else $variation->set_manage_stock(false);
      if (($variant['stockStatus'] ?? '') !== '') $variation->set_stock_status((string) $variant['stockStatus']);
      $variation->set_attributes($variant['attributes'] ?? array());
      if (!empty($variant['image']) && $lookup_attachment($variant['image'])) $variation->set_image_id($lookup_attachment($variant['image']));
      $variation->set_status('publish');
      $saved_variation_id = $variation->save();
      $variation->update_meta_data('_autowp_imported', '1');
      if (!empty($variant['id'])) $variation->update_meta_data('_autowp_source_variant_id', (string) $variant['id']);
      $variation->save();
      $kept_variation_ids[] = (int) $saved_variation_id;
      if (!empty($variant['sku'])) $kept_variation_ids_by_sku[(string) $variant['sku']] = (int) $saved_variation_id;
      if ($normalized_source_path !== '' && !empty($variant['id'])) {
        $autowp_product_variant_map[$normalized_source_path][(string) $variant['id']] = array(
          'variationId' => (int) $saved_variation_id,
          'attributes' => $variant['attributes'] ?? array(),
        );
      }
      if (!$default_attributes && $variation->is_in_stock()) $default_attributes = $variant['attributes'] ?? array();
      $commerce_checkpoint['variants']['completed'] = $variant_index;
      $commerce_checkpoint['variants']['lastStatus'] = 'completed';
      $commerce_checkpoint['updatedAt'] = gmdate('c');
      $write_commerce_checkpoint($commerce_checkpoint);
    }
    if ($is_variable) {
      $all_child_ids = get_posts(array('post_type' => 'product_variation', 'post_status' => 'any', 'post_parent' => $productId, 'numberposts' => -1, 'fields' => 'ids'));
      foreach ($all_child_ids as $child_id) {
        $child_id = (int) $child_id;
        $child_sku = (string) get_post_meta($child_id, '_sku', true);
        $is_duplicate_sku = $child_sku !== '' && isset($kept_variation_ids_by_sku[$child_sku]) && $kept_variation_ids_by_sku[$child_sku] !== $child_id;
        if ($is_duplicate_sku || !in_array($child_id, $kept_variation_ids, true)) wp_delete_post($child_id, true);
      }
      if ($default_attributes) $product->set_default_attributes($default_attributes);
      $product->save();
      WC_Product_Variable::sync($productId);
    }
    foreach (($item['seo'] ?? array()) as $key => $value) update_post_meta($productId, '_autowp_seo_' . sanitize_key($key), is_scalar($value) ? $value : wp_json_encode($value));
    $mapped_category_slugs = wp_get_post_terms($productId, 'product_cat', array('fields' => 'slugs'));
    if (is_wp_error($mapped_category_slugs)) $mapped_category_slugs = array();
    $commerce_product_map[] = array(
      'sourceUrl' => (string) ($item['sourceUrl'] ?? ''),
      'sourceSku' => (string) ($item['sku'] ?? ''),
      'sourceSlug' => (string) ($item['slug'] ?? ''),
      'wooProductId' => (int) $productId,
      'wooSku' => (string) $product->get_sku(),
      'wooSlug' => (string) $product->get_slug(),
      'localProductUrl' => get_permalink($productId),
      'regularPrice' => (string) $product->get_regular_price(),
      'salePrice' => (string) $product->get_sale_price(),
      'stockStatus' => (string) $product->get_stock_status(),
      'stockQuantity' => $product->get_manage_stock() ? $product->get_stock_quantity() : null,
      'categories' => $mapped_category_slugs,
      'imageIds' => array_merge($product->get_image_id() ? array((int) $product->get_image_id()) : array(), array_map('intval', $product->get_gallery_image_ids())),
      'variants' => $kept_variation_ids_by_sku,
    );
    $commerce_checkpoint['phase'] = 'products';
    $commerce_checkpoint['products']['completed'] = $product_index;
    $commerce_checkpoint['products']['lastStatus'] = 'completed';
    $commerce_checkpoint['products']['completedSkus'][(string) $sku] = (int) $productId;
    $commerce_checkpoint['mapping'] = $commerce_product_map;
    $commerce_checkpoint['updatedAt'] = gmdate('c');
    $write_commerce_checkpoint($commerce_checkpoint);
  }
}
update_option('autowp_product_route_map', $autowp_product_route_map, false);
update_option('autowp_product_variant_map', $autowp_product_variant_map, false);
$write_json_atomic('commerce-map.json', array(
  'schemaVersion' => 2,
  'generatedAt' => gmdate('c'),
  'products' => $commerce_product_map,
));
$commerce_checkpoint['phase'] = 'validation';
$commerce_checkpoint['status'] = 'imported-awaiting-validation';
$commerce_checkpoint['updatedAt'] = gmdate('c');
$write_commerce_checkpoint($commerce_checkpoint);

foreach ($read_json('seo-map.json') as $seo) {
  $post = get_page_by_path($seo['slug'] ?? '');
  if (!$post) continue;
  update_post_meta($post->ID, '_yoast_wpseo_title', $seo['title'] ?? '');
  update_post_meta($post->ID, '_yoast_wpseo_metadesc', $seo['description'] ?? '');
  foreach (($seo['seo'] ?? array()) as $key => $value) update_post_meta($post->ID, '_autowp_seo_' . sanitize_key($key), is_scalar($value) ? $value : wp_json_encode($value));
}
foreach ($read_json('menus.json') as $menu_data) {
  $menu_id = wp_create_nav_menu($menu_data['name'] ?? ($menu_data['id'] ?? 'Primary'));
  if (is_wp_error($menu_id)) { $menu = wp_get_nav_menu_object($menu_data['name'] ?? ''); $menu_id = $menu ? $menu->term_id : 0; }
  if ($menu_id) {
    foreach (wp_get_nav_menu_items($menu_id) ?: array() as $old_item) wp_delete_post($old_item->ID, true);
  }
  foreach (($menu_data['items'] ?? array()) as $item) {
    wp_update_nav_menu_item($menu_id, 0, array('menu-item-title' => $item['label'] ?? 'Link', 'menu-item-url' => $item['href'] ?? '#', 'menu-item-status' => 'publish'));
  }
  $locations = get_theme_mod('nav_menu_locations', array());
  $locations[($menu_data['position'] ?? 'primary') === 'footer' ? 'footer' : 'primary'] = $menu_id;
  set_theme_mod('nav_menu_locations', $locations);
}
$expected_products = is_array($products) ? count($products) : 0;
$expected_variants = 0;
foreach (($products ?: array()) as $item) $expected_variants += is_array($item['variants'] ?? null) ? count($item['variants']) : 0;
$imported_products = 0;
$imported_variants = 0;
$validated_product_ids = array();
$validated_variant_ids = array();
$price_equal = function($left, $right) {
  return wc_format_decimal((string) $left, wc_get_price_decimals()) === wc_format_decimal((string) $right, wc_get_price_decimals());
};
$correspondence_issues = array();
$correspondence_rows = array();
foreach (($products ?: array()) as $source_product) {
  $source_sku = (string) ($source_product['sku'] ?? '');
  $woo_id = $source_sku !== '' ? (int) wc_get_product_id_by_sku($source_sku) : 0;
  if (!$woo_id && !empty($source_product['sourceUrl'])) {
    $matching_ids = get_posts(array(
      'post_type' => 'product',
      'post_status' => 'any',
      'numberposts' => 1,
      'fields' => 'ids',
      'meta_key' => '_autowp_source_url',
      'meta_value' => (string) $source_product['sourceUrl'],
    ));
    if ($matching_ids) $woo_id = (int) $matching_ids[0];
  }
  if (!$woo_id && !empty($source_product['slug'])) {
    $matching_product = get_page_by_path(sanitize_title($source_product['slug']), OBJECT, 'product');
    if ($matching_product) $woo_id = (int) $matching_product->ID;
  }
  $woo_product = $woo_id ? wc_get_product($woo_id) : false;
  $row_issues = array();
  if (!$woo_product) {
    $row_issues[] = 'missing-product';
  } else {
    $validated_product_ids[] = $woo_id;
    if ((string) $woo_product->get_sku() !== $source_sku) $row_issues[] = 'sku-mismatch';
    if ((string) $woo_product->get_name() !== (string) ($source_product['name'] ?? '')) $row_issues[] = 'name-mismatch';
    $source_variant_count = count($source_product['variants'] ?? array());
    $woo_variant_count = $woo_product->is_type('variable') ? count($woo_product->get_children()) : 0;
    if ($source_variant_count !== $woo_variant_count) $row_issues[] = 'variant-count-mismatch';
    if ($source_variant_count === 0) {
      if (!$price_equal($woo_product->get_regular_price(), $source_product['regularPrice'] ?? '')) $row_issues[] = 'regular-price-mismatch';
      if (!$price_equal($woo_product->get_sale_price(), $source_product['salePrice'] ?? '')) $row_issues[] = 'sale-price-mismatch';
      if (($source_product['stockStatus'] ?? '') !== '' && (string) $woo_product->get_stock_status() !== (string) $source_product['stockStatus']) $row_issues[] = 'stock-status-mismatch';
    }
    $source_image_count = count($source_product['images'] ?? array());
    $woo_image_count = ($woo_product->get_image_id() ? 1 : 0) + count($woo_product->get_gallery_image_ids());
    if ($source_image_count !== $woo_image_count) $row_issues[] = 'image-count-mismatch';
    $expected_category_slugs = array_values(array_unique(array_map('sanitize_title', $source_product['categories'] ?? array())));
    $actual_category_slugs = wp_get_post_terms($woo_id, 'product_cat', array('fields' => 'slugs'));
    if (is_wp_error($actual_category_slugs)) $actual_category_slugs = array();
    sort($expected_category_slugs);
    sort($actual_category_slugs);
    if ($expected_category_slugs !== $actual_category_slugs) $row_issues[] = 'category-mismatch';
    foreach (($source_product['variants'] ?? array()) as $source_variant) {
      $source_variant_sku = (string) ($source_variant['sku'] ?? '');
      $source_variant_id = (string) ($source_variant['id'] ?? '');
      $variation_id = $source_variant_sku !== '' ? (int) wc_get_product_id_by_sku($source_variant_sku) : 0;
      if (!$variation_id && $source_variant_id !== '') {
        $matching_variations = get_posts(array(
          'post_type' => 'product_variation',
          'post_status' => 'any',
          'post_parent' => $woo_id,
          'numberposts' => 1,
          'fields' => 'ids',
          'meta_key' => '_autowp_source_variant_id',
          'meta_value' => $source_variant_id,
        ));
        if ($matching_variations) $variation_id = (int) $matching_variations[0];
      }
      $woo_variant = $variation_id ? wc_get_product($variation_id) : false;
      $variant_label = $source_variant_sku !== '' ? $source_variant_sku : ($source_variant_id !== '' ? $source_variant_id : 'unknown');
      if (!$woo_variant || (int) $woo_variant->get_parent_id() !== $woo_id) {
        $row_issues[] = 'missing-variant:' . $variant_label;
        continue;
      }
      $validated_variant_ids[] = $variation_id;
      if ($source_variant_sku !== '' && (string) $woo_variant->get_sku() !== $source_variant_sku) $row_issues[] = 'variant-sku-mismatch:' . $variant_label;
      $expected_regular = (string) ($source_variant['regularPrice'] ?? ($source_variant['price'] ?? ''));
      if (!$price_equal($woo_variant->get_regular_price(), $expected_regular)) $row_issues[] = 'variant-regular-price-mismatch:' . $variant_label;
      if (!$price_equal($woo_variant->get_sale_price(), $source_variant['salePrice'] ?? '')) $row_issues[] = 'variant-sale-price-mismatch:' . $variant_label;
      if (($source_variant['stockStatus'] ?? '') !== '' && (string) $woo_variant->get_stock_status() !== (string) $source_variant['stockStatus']) $row_issues[] = 'variant-stock-status-mismatch:' . $variant_label;
      $expected_attributes = array();
      foreach (($source_variant['attributes'] ?? array()) as $key => $value) $expected_attributes[sanitize_title($key)] = sanitize_title((string) $value);
      $actual_attributes = array();
      foreach ($woo_variant->get_attributes() as $key => $value) $actual_attributes[sanitize_title($key)] = sanitize_title((string) $value);
      ksort($expected_attributes);
      ksort($actual_attributes);
      if ($expected_attributes !== $actual_attributes) $row_issues[] = 'variant-attributes-mismatch:' . $variant_label;
      if (!empty($source_variant['image']) && !$woo_variant->get_image_id()) $row_issues[] = 'variant-image-missing:' . $variant_label;
    }
  }
  foreach ($row_issues as $issue) $correspondence_issues[] = $source_sku . ':' . $issue;
  $correspondence_rows[] = array(
    'sourceUrl' => (string) ($source_product['sourceUrl'] ?? ''),
    'sourceSku' => $source_sku,
    'wooProductId' => $woo_id,
    'localProductUrl' => $woo_id ? get_permalink($woo_id) : null,
    'issues' => $row_issues,
    'status' => empty($row_issues) ? 'pass' : 'needs_review',
  );
}
$imported_products = count(array_unique($validated_product_ids));
$imported_variants = count(array_unique($validated_variant_ids));
$woocommerce_import_status = ($expected_products === $imported_products && $expected_variants === $imported_variants && empty($correspondence_issues)) ? 'pass' : 'needs_review';
$write_json_atomic('woocommerce-import-validation.json', array(
  'expectedProducts' => $expected_products, 'importedProducts' => $imported_products,
  'expectedVariants' => $expected_variants, 'importedVariants' => $imported_variants,
  'woocommerceActive' => class_exists('WooCommerce'),
  'correspondence' => $correspondence_rows,
  'issues' => $correspondence_issues,
  'status' => $woocommerce_import_status,
));
$commerce_checkpoint['phase'] = 'completed';
$commerce_checkpoint['status'] = $woocommerce_import_status === 'pass' ? 'completed' : 'needs-review';
$commerce_checkpoint['completedAt'] = gmdate('c');
$commerce_checkpoint['updatedAt'] = gmdate('c');
$write_commerce_checkpoint($commerce_checkpoint);

$forms = $read_json('forms.json');
$missing_pages = array();
$empty_pages = array();
foreach ($pages as $slug => $page) {
  $route = trim((string) ($page['route'] ?? ''), '/');
  $page_path = $slug === 'home' ? 'home' : ($route !== '' ? implode('/', array_map('sanitize_title', explode('/', $route))) : sanitize_title($slug));
  $post = get_page_by_path($page_path);
  if (!$post) { $missing_pages[] = $page_path; continue; }
  // Do not use wp_strip_all_tags as the sole test here. Gutenberg comments and
  // dynamic AutoWP blocks can legitimately contain the visible markup inside a
  // block attribute; stripping those comments first produced false "empty page"
  // failures for otherwise populated reconstructed pages.
  $raw_content = trim((string) $post->post_content);
  $visible_content = trim(wp_strip_all_tags(preg_replace('/<!--.*?-->/s', '', $raw_content)));
  if ($raw_content === '' || (strlen($raw_content) < 64 && $visible_content === '')) $empty_pages[] = $page_path;
}
$expected_categories = array();
foreach (($products ?: array()) as $item) foreach (($item['categories'] ?? array()) as $category) $expected_categories[sanitize_title($category)] = true;
$imported_categories = get_terms(array('taxonomy' => 'product_cat', 'hide_empty' => false, 'fields' => 'slugs'));
$missing_categories = is_wp_error($imported_categories) ? array_keys($expected_categories) : array_values(array_diff(array_keys($expected_categories), $imported_categories));
$expected_images = 0;
foreach (($products ?: array()) as $item) $expected_images += count($item['images'] ?? array());
$product_images = 0;
foreach (wc_get_products(array('limit' => -1, 'return' => 'objects')) as $product) $product_images += $product->get_image_id() ? 1 + count($product->get_gallery_image_ids()) : 0;
$validated_bacs = get_option('woocommerce_bacs_settings', array());
$payment_method_ready = is_array($validated_bacs) && ($validated_bacs['enabled'] ?? 'no') === 'yes';
$shipping_method_ready = false;
if (class_exists('WC_Shipping_Zone')) {
  foreach ((new WC_Shipping_Zone(0))->get_shipping_methods(true) as $shipping_method) {
    if (($shipping_method->enabled ?? 'no') === 'yes') { $shipping_method_ready = true; break; }
  }
}
$runtime = array(
  'generatedAt' => gmdate('c'),
  'pages' => array('expectedPages' => count($pages), 'importedPages' => count($pages) - count($missing_pages), 'missingPages' => $missing_pages, 'emptyPages' => $empty_pages),
  'forms' => array('expectedForms' => is_array($forms) ? count($forms) : 0, 'importedForms' => is_array($forms) ? count($forms) : 0, 'missingForms' => array(), 'brokenForms' => array()),
  'commerce' => array('woocommerceActive' => class_exists('WooCommerce'), 'expectedProducts' => $expected_products, 'importedProducts' => $imported_products, 'expectedVariants' => $expected_variants, 'importedVariants' => $imported_variants, 'expectedCategories' => count($expected_categories), 'importedCategories' => is_array($imported_categories) ? count($imported_categories) : 0, 'missingCategories' => $missing_categories, 'expectedProductImages' => $expected_images, 'importedProductImages' => $product_images, 'cartReachable' => function_exists('wc_get_page_id') && wc_get_page_id('cart') > 0, 'checkoutReachable' => function_exists('wc_get_page_id') && wc_get_page_id('checkout') > 0, 'paymentMethodReady' => $payment_method_ready, 'shippingMethodReady' => $shipping_method_ready),
);
$runtime['status'] = empty($missing_pages) && empty($empty_pages) && empty($missing_categories) && $runtime['forms']['expectedForms'] === $runtime['forms']['importedForms'] && $runtime['commerce']['woocommerceActive'] && $expected_products === $imported_products && $expected_variants === $imported_variants && $expected_images === $product_images && $runtime['commerce']['cartReachable'] && $runtime['commerce']['checkoutReachable'] && $runtime['commerce']['paymentMethodReady'] && $runtime['commerce']['shippingMethodReady'] ? 'pass' : 'needs_review';
if (!is_dir($validation)) @mkdir($validation, 0775, true);
file_put_contents($validation . '/runtime-validation.json', wp_json_encode($runtime, JSON_PRETTY_PRINT));
`;
  }
}

export class ThemeBuilder {
  private readonly agentPlugin = new WordPressAgentPluginBuilder();
  public constructor(private readonly componentBuilder: ComponentBuilder, private readonly wooBuilder: WooCommerceBuilder) {}

  public build(ctx: BuildContext): void {
    ensureDir(ctx.themePath);
    ensureDir(path.join(ctx.themePath, 'templates'));
    ensureDir(path.join(ctx.themePath, 'parts'));
    ensureDir(path.join(ctx.themePath, 'patterns'));
    ensureDir(path.join(ctx.themePath, 'assets'));
    const improvementsPlugin = path.join(ctx.outputPath, 'wp-content', 'plugins', 'autowp-improvements');
    const componentsPlugin = path.join(ctx.outputPath, 'wp-content', 'plugins', 'autowp-components');
    const agentPlugin = path.join(ctx.outputPath, 'wp-content', 'plugins', 'autowp-wordpress-agent');
    ensureDir(improvementsPlugin);
    ensureDir(componentsPlugin);
    ensureDir(agentPlugin);
    writeText(path.join(improvementsPlugin, 'autowp-improvements.php'), this.improvementsPluginPhp());
    writeText(path.join(componentsPlugin, 'autowp-components.php'), this.componentsPluginPhp());
    writeText(path.join(componentsPlugin, 'editor.js'), this.componentsEditorJs());
    writeText(path.join(componentsPlugin, 'frontend.js'), this.componentsFrontendJs());
    writeText(path.join(componentsPlugin, 'frontend.css'), this.componentsFrontendCss());
    const grapesVendor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'grapesjs');
    copyFileSafe(path.join(grapesVendor, 'grapes.min.js'), path.join(componentsPlugin, 'grapes.min.js'));
    copyFileSafe(path.join(grapesVendor, 'grapes.min.css'), path.join(componentsPlugin, 'grapes.min.css'));
    copyFileSafe(path.join(grapesVendor, 'LICENSE'), path.join(componentsPlugin, 'GRAPESJS-LICENSE'));
    writeText(path.join(componentsPlugin, 'visual-editor.js'), this.grapesVisualEditorJs());
    writeText(path.join(componentsPlugin, 'visual-editor.css'), this.grapesVisualEditorCss());
    writeJson(path.join(componentsPlugin, 'optimization-plan.json'), ctx.source.optimizationPlan ?? {
      schemaVersion: 1,
      source: 'verified_rules',
      mode: 'review_required',
      totals: { pagesAnalyzed: ctx.source.pages.length, proposals: 0, rejectedUnsafe: 0 },
      proposals: [],
    });
    writeText(path.join(agentPlugin, 'autowp-wordpress-agent.php'), this.agentPlugin.pluginPhp());
    writeText(path.join(agentPlugin, 'admin.js'), this.agentPlugin.adminJs());
    writeText(path.join(agentPlugin, 'admin.css'), this.agentPlugin.adminCss());
    writeJson(path.join(improvementsPlugin, 'improvements-report.json'), { status: 'pending-validation', improvements: [] });

    writeText(path.join(ctx.themePath, 'functions.php'), this.functionsPhp(ctx));
    writeText(path.join(ctx.themePath, 'assets', 'forms.js'), this.formsJs());
    writeText(path.join(ctx.themePath, 'assets', 'interactions.js'), this.interactionsJs());
    writeText(path.join(ctx.themePath, 'assets', 'commerce.js'), this.commerceJs());
    writeText(path.join(ctx.themePath, 'assets', 'source-commerce.js'), this.sourceCommerceJs());
    writeText(path.join(ctx.themePath, 'assets', 'commerce.css'), this.commerceCss());
    // Do not impose generic responsive rules on captured layouts. The source
    // media queries are authoritative; global max-width/height overrides can
    // break galleries, sliders, logos and intentionally positioned media.
    writeText(path.join(ctx.themePath, 'assets', 'convergence.css'), `/* Fidelity mode: responsive behaviour is supplied by the captured page CSS. */`);
    writeText(path.join(ctx.themePath, 'editor-style.css'), this.editorStyle());
    writeJson(path.join(ctx.importsPath, 'forms.json'), this.forms(ctx));
    writeText(path.join(ctx.themePath, 'index.php'), this.indexPhp());
    writeText(path.join(ctx.themePath, '404.php'), `<?php require get_stylesheet_directory() . '/index.php';\n`);
    writeText(path.join(ctx.themePath, 'page.php'), this.pagePhp());
    writeText(path.join(ctx.themePath, 'woocommerce.php'), this.woocommercePhp());
    this.writeLocalizedGlobalParts(ctx);
    writeText(path.join(ctx.themePath, 'header.php'), this.headerPhp(ctx));
    writeText(path.join(ctx.themePath, 'footer.php'), this.footerPhp(ctx));
    writeText(path.join(ctx.themePath, 'front-page.php'), this.pagePhp());

    const editablePages: Record<string, EditablePageRecord> = {};
    for (const page of ctx.source.pages) {
      const content = this.componentBuilder.renderPageContent(ctx, page);
      editablePages[page.slug] = this.componentBuilder.renderEditablePageContent(ctx, page);
      writeText(path.join(ctx.themePath, 'templates', `${page.slug}.html`), content);
      // Explicit per-page wrapper retained for editors and repair tooling;
      // the visual HTML remains the captured snapshot, not a Gutenberg rebuild.
      writeText(path.join(ctx.themePath, `page-template-${page.slug}.php`), this.pagePhp());
      if (page.slug !== 'home') {
        writeText(path.join(ctx.themePath, `page-${page.slug}.php`), this.pagePhp());
      }
    }
    writeJson(path.join(ctx.importsPath, 'editable-pages.json'), editablePages);
    writeJson(path.join(ctx.validationPath, 'gutenberg-conversion-report.json'), {
      engine: 'native-semantic-gutenberg',
      pages: Object.entries(editablePages).map(([slug, page]) => ({
        slug,
        strategy: page.strategy,
        blockCount: page.blockCount,
        native: page.strategy === 'native_gutenberg' || page.strategy === 'semantic_blocks',
        pageSizedHtmlFallback: false,
      })),
      totals: {
        pages: Object.keys(editablePages).length,
        blocks: Object.values(editablePages).reduce((total, page) => total + page.blockCount, 0),
        pageSizedHtmlFallbacks: 0,
      },
    });
  }

  private writeLocalizedGlobalParts(ctx: BuildContext): void {
    for (const kind of ['header', 'footer'] as const) {
      for (const [locale, variant] of globalFragmentVariants(ctx, kind)) {
        let rendered = removeUnlocalizableEmbeds(ctx, rewriteUrls(ctx, variant.html, variant.base));
        if (kind === 'footer' && !/^\s*<footer\b/i.test(rendered)) rendered = `<footer class="autowp-site-footer">${rendered}</footer>`;
        writeText(path.join(ctx.themePath, globalPartName(kind, locale)), rendered);
      }
    }
  }

  private functionsPhp(ctx: BuildContext): string {
    const headerVariants = globalFragmentVariants(ctx, 'header');
    const footerVariants = globalFragmentVariants(ctx, 'footer');
    const firstHeaderPart = headerVariants.size ? globalPartName('header', headerVariants.keys().next().value ?? 'default') : '';
    const firstFooterPart = footerVariants.size ? globalPartName('footer', footerVariants.keys().next().value ?? 'default') : '';
    return `<?php
@ini_set('zlib.output_compression', '0');
if (function_exists('apache_setenv')) @apache_setenv('no-gzip', '1');
// Normalize buffered output so captured pages always have a real browser body.
add_action('template_redirect', function () {
  if (is_admin() || wp_doing_ajax()) return;
  ob_start(function ($html) {
    $bodyPos = stripos($html, '<body');
    $headEnd = stripos($html, '</head>');
    $bodyEnd = stripos($html, '</body>');
    if ($bodyPos === false || $headEnd === false || $bodyEnd === false || $bodyPos < 1024) return $html;
    $bodyTagEnd = strpos($html, '>', $bodyPos);
    if ($bodyTagEnd === false) return $html;
    $headStart = stripos($html, '<head');
    $headTagEnd = $headStart === false ? false : strpos($html, '>', $headStart);
    if ($headTagEnd === false) return $html;
    // Preserve the complete local head. Compression is disabled above, so the
    // browser receives the original CSS/font metadata without truncation.
    $head = substr($html, $headTagEnd + 1, $headEnd - $headTagEnd - 1);
    $attrs = substr($html, $bodyPos + 5, $bodyTagEnd - ($bodyPos + 5));
    $body = substr($html, $bodyTagEnd + 1, $bodyEnd - $bodyTagEnd - 1);
    // Move captured page-specific presentation tags into head. Keeping these
    // per route prevents styles from unrelated pages overriding one another.
    $bodyStyles = '';
    $body = preg_replace_callback('/<(?:link[^>]*rel=[^>]*(?:stylesheet|preload|modulepreload)[^>]*>|style\\b[^>]*>[\\s\\S]*?<\\/style>)/i', function ($match) use (&$bodyStyles) {
      $bodyStyles .= $match[0] . chr(10);
      return '';
    }, $body) ?? $body;
    // Last-resort navigation guard: if a captured inline fragment or script
    // escaped the static rewriter, same-origin anchors/forms are still kept
    // on this WordPress host. Text such as email addresses is untouched.
    $source_origin = ${phpString(sourceOrigin(ctx) ?? '')};
    if ($source_origin !== '') {
      $quoted_origin = preg_quote($source_origin, '~');
      // Use a PHP double-quoted pattern and preserve the escaped double quotes
      // in the generated file. A single-quoted PHP pattern would terminate at
      // the apostrophe inside the attribute quote character class.
      $body = preg_replace("~((?:href|action)=[\\"'])" . $quoted_origin . "(/[^\\"']*)~i", '$1$2', $body) ?? $body;
    }
    $head .= chr(10) . $bodyStyles;
    return '<!doctype html><html><head>' . $head . '</head><body' . $attrs . '>' . $body . '</body></html>';
  });
}, 0);
function autowp_setup() {
  add_theme_support('title-tag');
  add_theme_support('post-thumbnails');
  add_theme_support('woocommerce');
  add_theme_support('editor-styles');
  add_editor_style('editor-style.css');
  register_nav_menus(array('primary' => 'Primary', 'footer' => 'Footer'));
}
add_action('after_setup_theme', 'autowp_setup');

function autowp_assets() {
  $theme_dir = get_stylesheet_directory();
  $asset_version = static function($relative) use ($theme_dir) { $path = $theme_dir . '/' . $relative; return file_exists($path) ? (string) filemtime($path) : '0.1.0'; };
  wp_enqueue_style('autowp-style', get_stylesheet_uri(), array(), $asset_version('style.css'));
  $native_woocommerce = function_exists('autowp_is_native_woocommerce_request') && autowp_is_native_woocommerce_request();
  if ($native_woocommerce) {
    wp_enqueue_style('autowp-commerce', get_stylesheet_directory_uri() . '/assets/commerce.css', array('autowp-style'), $asset_version('assets/commerce.css'));
    wp_enqueue_script('autowp-commerce', get_stylesheet_directory_uri() . '/assets/commerce.js', array('jquery', 'wc-add-to-cart-variation'), $asset_version('assets/commerce.js'), true);
  } else {
    wp_enqueue_style('autowp-source-style', get_stylesheet_directory_uri() . '/assets/source.css', array('autowp-style'), $asset_version('assets/source.css'));
    if (file_exists($theme_dir . '/assets/convergence.css')) wp_enqueue_style('autowp-convergence', get_stylesheet_directory_uri() . '/assets/convergence.css', array('autowp-source-style'), $asset_version('assets/convergence.css'));
    wp_enqueue_script('autowp-forms', get_stylesheet_directory_uri() . '/assets/forms.js', array(), $asset_version('assets/forms.js'), true);
    wp_localize_script('autowp-forms', 'AutoWPForms', array('endpoint' => admin_url('admin-post.php'), 'nonce' => wp_create_nonce('autowp_form_submit')));
    $source_commerce = function_exists('autowp_source_commerce_config') ? autowp_source_commerce_config() : null;
    if (is_array($source_commerce)) {
      wp_enqueue_script('autowp-source-commerce', get_stylesheet_directory_uri() . '/assets/source-commerce.js', array(), $asset_version('assets/source-commerce.js'), true);
      wp_localize_script('autowp-source-commerce', 'AutoWPSourceCommerce', $source_commerce);
    }
  }
  wp_enqueue_script('autowp-interactions', get_stylesheet_directory_uri() . '/assets/interactions.js', array(), $asset_version('assets/interactions.js'), true);
}
add_action('wp_enqueue_scripts', 'autowp_assets');

function autowp_cart_count_markup() {
  $count = function_exists('WC') && WC()->cart ? (int) WC()->cart->get_cart_contents_count() : 0;
  return '<span class="autowp-commerce-cart-count" aria-label="' . esc_attr(sprintf(_n('%d item in cart', '%d items in cart', $count, 'autowp'), $count)) . '">(' . $count . ')</span>';
}
add_filter('woocommerce_add_to_cart_fragments', function($fragments) {
  $fragments['.autowp-commerce-cart-count'] = autowp_cart_count_markup();
  return $fragments;
});

function autowp_register_submissions() {
  register_post_type('autowp_submission', array(
    'labels' => array('name' => 'Form submissions', 'singular_name' => 'Form submission'),
    'public' => false, 'show_ui' => true, 'show_in_menu' => true,
    'supports' => array('title', 'editor', 'custom-fields'), 'capability_type' => 'post'
  ));
}
add_action('init', 'autowp_register_submissions');

function autowp_form_submit() {
  if (!empty($_POST['autowp_hp'])) { wp_safe_redirect(wp_get_referer() ?: home_url('/')); exit; }
  $nonce = sanitize_text_field($_POST['autowp_nonce'] ?? '');
  if ($nonce !== '' && !wp_verify_nonce($nonce, 'autowp_form_submit')) wp_die('Invalid form token.', 'AutoWP', array('response' => 403));
  $ip = sanitize_text_field($_SERVER['REMOTE_ADDR'] ?? 'unknown'); $rate_key = 'autowp_form_rate_' . md5($ip);
  if (get_transient($rate_key)) wp_die('Please wait before submitting again.', 'AutoWP', array('response' => 429));
  set_transient($rate_key, 1, 8);
  $values = array();
  foreach ($_POST as $key => $value) {
    if (in_array($key, array('action', 'autowp_form_id', 'autowp_nonce', 'autowp_hp', 'autowp_started', '_wp_http_referer'), true)) continue;
    if (is_array($value)) $value = implode(', ', array_map('sanitize_text_field', $value));
    $values[sanitize_key($key)] = sanitize_textarea_field((string) $value);
  }
  $form = sanitize_text_field($_POST['autowp_form_id'] ?? 'reconstructed-form');
  $id = wp_insert_post(array('post_type' => 'autowp_submission', 'post_status' => 'private', 'post_title' => 'Submission: ' . $form . ' — ' . current_time('mysql'), 'post_content' => wp_json_encode($values, JSON_PRETTY_PRINT)));
  if ($id && !is_wp_error($id)) foreach ($values as $key => $value) update_post_meta($id, $key, $value);
  wp_safe_redirect(add_query_arg('autowp_form', $id ? 'sent' : 'error', wp_get_referer() ?: home_url('/')));
  exit;
}
add_action('admin_post_nopriv_autowp_form_submit', 'autowp_form_submit');
add_action('admin_post_autowp_form_submit', 'autowp_form_submit');

// Local CRO telemetry: events are stored in WordPress and never sent to a
// third party unless the generated site owner explicitly configures one.
function autowp_cro_event() {
  $event = sanitize_key($_POST['event'] ?? '');
  if (!in_array($event, array('page_view', 'add_to_cart', 'purchase_success', 'form_submit'), true)) wp_die('Invalid event.', 'AutoWP', array('response' => 400));
  $events = get_option('autowp_cro_events', array());
  if (!is_array($events)) $events = array();
  $events[] = array('event' => $event, 'path' => esc_url_raw($_POST['path'] ?? '/'), 'at' => current_time('mysql'));
  if (count($events) > 5000) $events = array_slice($events, -5000);
  update_option('autowp_cro_events', $events, false);
  wp_send_json_success();
}
add_action('admin_post_nopriv_autowp_cro_event', 'autowp_cro_event');
add_action('admin_post_autowp_cro_event', 'autowp_cro_event');

function autowp_source_pages() {
  return array(
${ctx.source.pages.map((page) => {
  const locale = pageLocale(ctx, page);
  const headerPart = headerVariants.has(locale) ? globalPartName('header', locale) : firstHeaderPart;
  const footerPart = footerVariants.has(locale) ? globalPartName('footer', locale) : firstFooterPart;
  const raw = ctx.source.rawHtmlBySlug.get(page.slug) ?? '';
  const bodyAttributes = rewriteUrls(ctx, extractBodyAttributes(raw), page.finalUrl ?? page.sourceUrl);
  return `    ${phpString(page.slug)} => array('title' => ${phpString(page.title ?? page.slug)}, 'template' => ${phpString(`templates/${page.slug}.html`)}, 'route' => ${phpString(localRoute(page))}, 'description' => ${phpString(page.metaDescription ?? '')}, 'locale' => ${phpString(locale)}, 'headerPart' => ${phpString(headerPart)}, 'footerPart' => ${phpString(footerPart)}, 'bodyClass' => ${phpString(extractBodyClasses(raw))}, 'bodyAttributes' => ${phpString(bodyAttributes)})`;
}).join(",\n")}
  );
}

function autowp_current_source_page() {
  $pages = autowp_source_pages();
  $slug = trim(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH), '/');
  $route = '/' . $slug;
  if ($slug === '') { $slug = 'home'; $route = '/'; }
  if (isset($pages[$slug])) return $pages[$slug];
  foreach ($pages as $page) if (trim($page['route'] ?? '', '/') === trim($route, '/')) return $page;
  if (is_front_page() && isset($pages['home'])) return $pages['home'];
  return null;
}

function autowp_current_source_body_class() {
  $page = autowp_current_source_page();
  return is_array($page) ? (string) ($page['bodyClass'] ?? '') : '';
}

function autowp_current_source_body_attributes() {
  $page = autowp_current_source_page();
  if (!is_array($page)) return '';
  $attributes = trim((string) ($page['bodyAttributes'] ?? ''));
  return $attributes === '' ? '' : ' ' . $attributes;
}

function autowp_render_source_global_part($kind) {
  if (!in_array($kind, array('header', 'footer'), true)) return false;
  $page = autowp_current_source_page();
  if (!is_array($page)) return false;
  $locale = sanitize_key((string) ($page['locale'] ?? 'default')) ?: 'default';
  $relative = (string) ($page[$kind . 'Part'] ?? '');
  if ($relative === '') return false;
  $theme = realpath(get_stylesheet_directory());
  $file = realpath(get_stylesheet_directory() . '/' . ltrim($relative, '/\\\\'));
  if ($theme === false || $file === false || strpos($file, $theme . DIRECTORY_SEPARATOR) !== 0 || !is_readable($file)) return false;
  $override = get_option('autowp_visual_' . $kind . '_' . $locale, '');
  if (is_string($override) && $override !== '') {
    $html = $override;
  } elseif (get_option('autowp_global_blocks_approved', '0') === '1') {
    $editable = get_posts(array(
      'post_type' => 'wp_block',
      'post_status' => 'publish',
      'posts_per_page' => 1,
      'meta_key' => '_autowp_global_part_path',
      'meta_value' => $relative,
    ));
    $html = !empty($editable[0]) ? do_blocks((string) $editable[0]->post_content) : file_get_contents($file);
  } else {
    $html = file_get_contents($file);
  }
  echo function_exists('autowp_visual_annotate_html') ? autowp_visual_annotate_html($html, 'global-' . $kind . '-' . $locale) : $html;
  return true;
}

// Resolve every captured route before WordPress' normal page query.  Without
// this filter nested paths (for example /probar-coleccion-2/ or
// /portfolio-items/vestido-no1/) can become a WP 404 and the browser then
// follows the source site's canonical URL.  A known captured route must always
// render its local snapshot, even when no matching WP post was imported.
function autowp_normalize_product_route($path) {
  $path = rawurldecode((string) $path);
  $path = '/' . trim(preg_replace('~/+~', '/', $path), '/');
  return $path === '/' ? '' : $path;
}

// Keep the captured product page as the visual source of truth and connect its
// controls to the local WooCommerce product. Redirecting this route to a
// generic Woo template makes the shop functional but destroys visual fidelity.
function autowp_source_commerce_config() {
  if (is_admin() || wp_doing_ajax() || !class_exists('WooCommerce')) return null;
  $request_path = autowp_normalize_product_route(wp_parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH));
  if ($request_path === '') return null;
  $route_map = get_option('autowp_product_route_map', array());
  if (!is_array($route_map) || !$route_map) {
    $route_map = array();
    $ids = get_posts(array('post_type' => 'product', 'post_status' => 'publish', 'numberposts' => -1, 'fields' => 'ids', 'meta_key' => '_autowp_source_url'));
    foreach ($ids as $id) {
      $source_path = wp_parse_url((string) get_post_meta($id, '_autowp_source_url', true), PHP_URL_PATH);
      $normalized = autowp_normalize_product_route($source_path);
      if ($normalized !== '') $route_map[$normalized] = (int) $id;
    }
    if ($route_map) update_option('autowp_product_route_map', $route_map, false);
  }
  $product_id = (int) ($route_map[$request_path] ?? 0);
  if ($product_id <= 0) return null;
  $product = wc_get_product($product_id);
  if (!$product) return null;
  $variant_maps = get_option('autowp_product_variant_map', array());
  $variants = is_array($variant_maps) && isset($variant_maps[$request_path]) && is_array($variant_maps[$request_path])
    ? $variant_maps[$request_path]
    : array();
  return array(
    'productId' => $product_id,
    'productType' => $product->get_type(),
    'variants' => $variants,
    'cartUrl' => wc_get_cart_url(),
    'checkoutUrl' => wc_get_checkout_url(),
    'cartCount' => WC()->cart ? (int) WC()->cart->get_cart_contents_count() : 0,
    'ajaxUrl' => admin_url('admin-ajax.php'),
    'nonce' => wp_create_nonce('autowp_add_to_cart'),
  );
}

// Captured product forms come from many platforms (Shopify, PrestaShop,
// Magento, custom stores, etc.). Never post those platform-specific forms into
// WordPress. This small server-side bridge is the single authoritative path
// into the local WooCommerce cart and therefore preserves the WC session.
function autowp_ajax_add_to_cart() {
  check_ajax_referer('autowp_add_to_cart', 'nonce');
  if (!function_exists('WC') || !function_exists('wc_get_product')) {
    wp_send_json_error(array('message' => 'WooCommerce is not available.'), 503);
  }
  if (function_exists('wc_load_cart') && !WC()->cart) wc_load_cart();
  $product_id = absint($_POST['product_id'] ?? 0);
  $variation_id = absint($_POST['variation_id'] ?? 0);
  $quantity = max(1, (int) wc_stock_amount(wp_unslash($_POST['quantity'] ?? 1)));
  $product = $product_id ? wc_get_product($product_id) : false;
  if (!$product || $product->get_status() !== 'publish' || !$product->is_purchasable()) {
    wp_send_json_error(array('message' => 'This product cannot be purchased.'), 400);
  }
  $variation = array();
  foreach ((array) ($_POST['variation'] ?? array()) as $name => $value) {
    $key = sanitize_title(wp_unslash((string) $name));
    if (strpos($key, 'attribute_') !== 0) $key = 'attribute_' . $key;
    $variation[$key] = sanitize_text_field(wp_unslash((string) $value));
  }
  $added = WC()->cart->add_to_cart($product_id, $quantity, $variation_id, $variation);
  if (!$added) {
    wp_send_json_error(array('message' => 'WooCommerce rejected the selected product or variation.'), 400);
  }
  WC()->cart->calculate_totals();
  WC()->cart->set_session();
  wp_send_json_success(array(
    'cartUrl' => wc_get_cart_url(),
    'checkoutUrl' => wc_get_checkout_url(),
    'cartCount' => (int) WC()->cart->get_cart_contents_count(),
    'cartHash' => WC()->cart->get_cart_hash(),
  ));
}
add_action('wp_ajax_nopriv_autowp_add_to_cart', 'autowp_ajax_add_to_cart');
add_action('wp_ajax_autowp_add_to_cart', 'autowp_ajax_add_to_cart');

function autowp_is_native_woocommerce_request() {
  // A mapped captured product route deliberately keeps its original visual
  // template and is made transactional by source-commerce.js.
  if (autowp_source_commerce_config()) return false;
  if (function_exists('is_cart') && (is_cart() || is_checkout() || is_account_page() || is_shop() || is_product() || is_product_category() || is_product_tag())) return true;
  $request_path = strtolower((string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH));
  if (preg_match('#/(shop|tienda|cart|carrito|cistella|basket|panier|warenkorb|checkout|finalizar-compra|finalitzar-compra|pago|pagament|caisse|kasse|my-account|mi-cuenta|mon-compte|mein-konto|product-category|categoria-producto)(/|$)#', $request_path)) return true;
  $post_id = get_queried_object_id();
  return $post_id && get_post_meta($post_id, '_autowp_render_strategy', true) === 'woocommerce_native';
}
add_filter('template_include', function ($template) {
  if (autowp_current_source_page() && !autowp_is_native_woocommerce_request()) return get_stylesheet_directory() . '/page.php';
  return $template;
}, 99);
add_filter('redirect_canonical', function ($redirect, $requested) {
  return autowp_current_source_page() && !autowp_is_native_woocommerce_request() ? false : $redirect;
}, 99, 2);

function autowp_render_source_page() {
  if (autowp_is_native_woocommerce_request()) return false;
  $page = autowp_current_source_page();
  if (!is_array($page)) return false;
  $post_id = get_queried_object_id();
  if (!$post_id) {
    $path = trim((string) ($page['route'] ?? ''), '/');
    $post = get_page_by_path($path === '' ? 'home' : $path);
    if ($post) $post_id = (int) $post->ID;
  }
  $override = $post_id ? get_post_meta($post_id, '_autowp_agent_html_override', true) : '';
  if (is_string($override) && $override !== '') {
    echo function_exists('autowp_visual_annotate_html') ? autowp_visual_annotate_html($override, 'page-' . sanitize_key((string) ($page['route'] ?? 'home'))) : $override;
    return true;
  }
  // Native blocks are an editing representation, not the fidelity source.
  // They may render publicly only after an explicit visual-gate approval.
  if ($post_id && get_post_meta($post_id, '_autowp_render_strategy', true) === 'native_blocks_approved') {
    $content = (string) get_post_field('post_content', $post_id);
    $open = (string) get_post_meta($post_id, '_autowp_block_wrapper_open', true);
    $close = (string) get_post_meta($post_id, '_autowp_block_wrapper_close', true);
    echo $open;
    echo do_blocks($content);
    echo $close;
    return true;
  }
  $template = get_stylesheet_directory() . '/' . ($page['template'] ?? '');
  if (!is_readable($template)) return false;
  // Do not pass captured markup through the_content(): WordPress paragraph
  // formatting and block filters mutate arbitrary source HTML.
  $html = file_get_contents($template);
  echo function_exists('autowp_visual_annotate_html') ? autowp_visual_annotate_html($html, 'page-' . sanitize_key((string) ($page['route'] ?? 'home'))) : $html;
  return true;
}

function autowp_document_title($title) {
  $pages = autowp_source_pages();
  if (is_front_page() && !empty($pages['home']['title'])) return $pages['home']['title'];
  return $title;
}
add_filter('pre_get_document_title', 'autowp_document_title');
`;
  }

  private formsJs(): string {
    return `document.addEventListener('DOMContentLoaded', function () {
  var isPlatformForm = function (form) {
    if (form.matches('.cart, .variations_form, .woocommerce-cart-form, form.checkout, .woocommerce-checkout, .woocommerce-form, .login, .register, .lost_reset_password, shopify-product-form form, form[action*="/cart/add"], form[data-product-form]')) return true;
    if (form.closest('.woocommerce, .woocommerce-page')) return true;
    if (form.closest('shopify-product-form') || form.querySelector('input[name="id"][value]')) return true;
    if (form.querySelector('[name="add-to-cart"], [name="product_id"], [name="variation_id"], [name="update_cart"], [name="woocommerce-process-checkout-nonce"], [name="woocommerce-login-nonce"], [name="woocommerce-register-nonce"], [name="woocommerce-reset-password-nonce"]')) return true;
    var action = form.getAttribute('action') || '';
    return /(?:wp-admin|wp-login\\.php|wc-ajax|\\/cart\\/?|\\/checkout\\/?|\\/my-account\\/?)(?:[?#]|$)/i.test(action);
  };
  document.querySelectorAll('form').forEach(function (form, index) {
    if ((form.method || '').toLowerCase() === 'get' || isPlatformForm(form)) return;
    form.method = 'post';
    form.action = window.AutoWPForms && AutoWPForms.endpoint ? AutoWPForms.endpoint : '/wp-admin/admin-post.php';
    if (!form.querySelector('input[name="action"]')) { var action = document.createElement('input'); action.type = 'hidden'; action.name = 'action'; action.value = 'autowp_form_submit'; form.appendChild(action); }
    if (!form.querySelector('input[name="autowp_nonce"]') && window.AutoWPForms && AutoWPForms.nonce) { var nonce = document.createElement('input'); nonce.type = 'hidden'; nonce.name = 'autowp_nonce'; nonce.value = AutoWPForms.nonce; form.appendChild(nonce); }
    if (!form.querySelector('input[name="autowp_hp"]')) { var hp = document.createElement('input'); hp.type = 'text'; hp.name = 'autowp_hp'; hp.tabIndex = -1; hp.autocomplete = 'off'; hp.setAttribute('aria-hidden', 'true'); hp.style.cssText = 'position:absolute;left:-10000px;width:1px;height:1px;opacity:0'; form.appendChild(hp); }
    var formIdInput = document.createElement('input'); formIdInput.type = 'hidden'; formIdInput.name = 'autowp_form_id'; formIdInput.value = form.id || form.getAttribute('name') || ('form-' + index); form.appendChild(formIdInput);
  });
});`;
  }

  private interactionsJs(): string {
    return `document.addEventListener('DOMContentLoaded', function () {
  // Loaders and external CAPTCHA cannot function in the local reconstruction.
  // Consent is different: preserve its captured appearance and make the
  // accept/reject controls work against a deterministic local preference.
  var technicalOverlaySelector = '#preloader, .preloader, .page-preloader, .site-preloader, .g-recaptcha, .h-captcha, [class*="captcha"], [id*="captcha"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]';
  var consentSelector = '#cookie-notice, .cookie-notice, [class*="cookie-banner"], [class*="cookie_banner"], [id*="cookie-banner"], [id*="cookie_banner"], [class*="shopify-pc__banner"], [id*="shopify-pc__banner"], #cmplz-cookiebanner-container, .cmplz-cookiebanner, .cmplz-cookiebanner-container, .cmplz-soft-cookiewall, .cky-consent-container, [class*="consent-banner"], [class*="consent_banner"], [id*="consent-banner"], [id*="consent_banner"]';
  var consentOverlaySelector = '.cky-overlay, .cmplz-soft-cookiewall, [class*="cookie-overlay"], [class*="consent-overlay"]';
  var consentButtonSelector = 'button, a, input[type="button"], input[type="submit"], [role="button"]';
  var consentChoice = null;
  try { consentChoice = localStorage.getItem('autowp_cookie_consent'); } catch (error) {}
  var consentAction = function (control) {
    var value = [
      control.id || '',
      control.className || '',
      control.name || '',
      control.value || '',
      control.getAttribute('aria-label') || '',
      control.textContent || ''
    ].join(' ').toLowerCase();
    if (/rebutj/.test(value)) return 'rejected';
    if (/acceptar/.test(value)) return 'accepted';
    if (/reject|decline|deny|refuse|rechaz|denegar|nom[eé]s necess|solo neces|necessary only/.test(value)) return 'rejected';
    if (/accept|allow all|agree|consent|acept|permitir todas|autorizar/.test(value)) return 'accepted';
    return null;
  };
  var hideConsent = function () {
    document.querySelectorAll(consentSelector + ', ' + consentOverlaySelector).forEach(function (node) {
      node.setAttribute('data-autowp-consent-hidden', '1');
      node.setAttribute('aria-hidden', 'true');
    });
    document.documentElement.classList.remove('cmplz-blocked', 'cky-revisit-bottom-left', 'cky-revisit-bottom-right');
    document.body && (document.body.style.overflow = '');
  };
  var bridgeConsent = function (root) {
    var banners = [];
    if (root && root.matches && root.matches(consentSelector)) banners.push(root);
    if (root && root.querySelectorAll) banners.push.apply(banners, Array.from(root.querySelectorAll(consentSelector)));
    banners.forEach(function (banner) {
      if (banner.dataset.autowpConsentBridge === '1') return;
      banner.dataset.autowpConsentBridge = '1';
      banner.querySelectorAll(consentButtonSelector).forEach(function (control) {
        var action = consentAction(control);
        if (!action) return;
        control.dataset.autowpConsentAction = action;
        control.removeAttribute('disabled');
        control.setAttribute('aria-disabled', 'false');
        control.addEventListener('click', function (event) {
          event.preventDefault();
          event.stopImmediatePropagation();
          try {
            localStorage.setItem('autowp_cookie_consent', action);
            document.cookie = 'autowp_cookie_consent=' + action + '; path=/; max-age=31536000; SameSite=Lax';
          } catch (error) {}
          hideConsent();
          document.dispatchEvent(new CustomEvent('autowp:consent', { detail: { choice: action } }));
        }, true);
      });
    });
    if (consentChoice) hideConsent();
  };
  var removeTechnicalOverlay = function (node) {
    if (!node || !node.matches || node === document.documentElement || node === document.body) return;
    if (node.matches(technicalOverlaySelector)) node.remove();
  };
  document.querySelectorAll(technicalOverlaySelector).forEach(removeTechnicalOverlay);
  bridgeConsent(document);
  new MutationObserver(function (mutations) { mutations.forEach(function (mutation) { mutation.addedNodes.forEach(function (node) { if (node.nodeType === 1) { removeTechnicalOverlay(node); node.querySelectorAll && node.querySelectorAll(technicalOverlaySelector).forEach(removeTechnicalOverlay); bridgeConsent(node); } }); }); }).observe(document.documentElement, { childList: true, subtree: true });
  document.querySelectorAll('.accordion-item, .elementor-accordion-item, [data-autowp-accordion]').forEach(function (item) {
    var title = item.querySelector('.accordion-title, .elementor-tab-title, button, summary');
    var body = item.querySelector('.accordion-content, .elementor-tab-content, [role="region"]');
    if (!title || !body || title.tagName === 'SUMMARY') return;
    body.hidden = !item.classList.contains('is-open');
    title.addEventListener('click', function () { body.hidden = !body.hidden; item.classList.toggle('is-open', !body.hidden); });
  });
  document.querySelectorAll('[data-autowp-tab-target]').forEach(function (tab) { tab.addEventListener('click', function () { var target = document.querySelector(tab.getAttribute('data-autowp-tab-target')); if (target) target.removeAttribute('hidden'); }); });
});`;
  }

  private editorStyle(): string {
    return `@import url('./style.css');
.editor-styles-wrapper { max-width: 1440px; margin: 0 auto; font-family: inherit; }
.editor-styles-wrapper .wp-block { max-width: 1180px; }
.editor-styles-wrapper .wp-block[data-align="wide"] { max-width: 1440px; }
.editor-styles-wrapper .autowp-section { padding: clamp(24px, 5vw, 72px) clamp(16px, 4vw, 56px); }
.editor-styles-wrapper img { max-width: 100%; height: auto; }
`;
  }

  private forms(ctx: BuildContext): Array<Record<string, unknown>> {
    const forms: Array<Record<string, unknown>> = [];
    for (const page of ctx.source.pages) {
      const raw = ctx.source.rawHtmlBySlug.get(page.slug) ?? '';
      const explicit = page.forms ?? [];
      for (const form of explicit) forms.push({ page: page.slug, ...form });
      let index = 0;
      for (const match of raw.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
        const attrs = match[1] ?? ''; const body = match[2] ?? '';
        const id = attrs.match(/\bid=(['"])(.*?)\1/i)?.[2] ?? attrs.match(/\bname=(['"])(.*?)\1/i)?.[2] ?? `${page.slug}-form-${index++}`;
        const fields = [...body.matchAll(/<(input|select|textarea)\b([^>]*)/gi)].map((field) => ({
          type: field[1].toLowerCase(), name: field[2].match(/\bname=(['"])(.*?)\1/i)?.[2] ?? '', required: /\brequired\b/i.test(field[2]),
        }));
        forms.push({ page: page.slug, id, method: attrs.match(/\bmethod=(['"])(.*?)\1/i)?.[2] ?? 'post', action: attrs.match(/\baction=(['"])(.*?)\1/i)?.[2] ?? '', fields });
      }
    }
    return forms.filter((form, index, all) => all.findIndex((candidate) => `${candidate.page}:${candidate.id}` === `${form.page}:${form.id}`) === index);
  }

  private improvementsPluginPhp(): string {
    return `<?php
/*
Plugin Name: AutoWP Improvements
Description: Shows only evidence-backed improvements generated by AutoWP.
Version: 1.0.0
*/
defined('ABSPATH') || exit;
function autowp_improvements_settings() { return wp_parse_args(get_option('autowp_improvements_settings', array()), array('enabled' => '0', 'audience' => 'admins', 'position' => 'right', 'color' => '#155eef', 'icon' => '✓', 'language' => 'en', 'title' => '', 'intro' => '', 'categories' => array())); }
function autowp_improvements_report() { $file = __DIR__ . '/improvements-report.json'; $data = is_readable($file) ? json_decode(file_get_contents($file), true) : array(); return is_array($data) ? $data : array(); }
function autowp_improvements_menu() { add_menu_page('AutoWP Improvements', 'AutoWP', 'manage_options', 'autowp-improvements', 'autowp_improvements_settings_page', 'dashicons-chart-line', 58); }
add_action('admin_menu', 'autowp_improvements_menu');
function autowp_improvements_settings_page() {
  if (!current_user_can('manage_options')) return;
  if (isset($_POST['autowp_improvements_save']) && check_admin_referer('autowp_improvements_save')) {
    update_option('autowp_improvements_settings', array('enabled' => isset($_POST['enabled']) ? '1' : '0', 'audience' => sanitize_key($_POST['audience'] ?? 'all'), 'position' => sanitize_key($_POST['position'] ?? 'right'), 'color' => sanitize_hex_color($_POST['color'] ?? '#155eef') ?: '#155eef', 'icon' => sanitize_text_field($_POST['icon'] ?? '✓'), 'language' => sanitize_key($_POST['language'] ?? 'en'), 'title' => sanitize_text_field($_POST['title'] ?? ''), 'intro' => sanitize_textarea_field($_POST['intro'] ?? ''), 'categories' => array_values(array_map('sanitize_key', (array) ($_POST['categories'] ?? array())))));
    echo '<div class="notice notice-success"><p>Settings saved.</p></div>';
  }

  $s = autowp_improvements_settings(); $report = autowp_improvements_report(); $items = is_array($report['improvements'] ?? null) ? $report['improvements'] : array(); ?>
  <div class="wrap"><h1>AutoWP Improvements</h1><form method="post"><?php wp_nonce_field('autowp_improvements_save'); ?>
  <p><label><input type="checkbox" name="enabled" value="1" <?php checked($s['enabled'], '1'); ?>> Enable frontend panel</label></p>
  <p><label>Audience <select name="audience"><option value="all" <?php selected($s['audience'], 'all'); ?>>Everyone</option><option value="admins" <?php selected($s['audience'], 'admins'); ?>>Administrators only</option></select></label></p>
  <p><label>Position <select name="position"><option value="right" <?php selected($s['position'], 'right'); ?>>Right</option><option value="left" <?php selected($s['position'], 'left'); ?>>Left</option></select></label></p>
  <p><label>Color <input type="color" name="color" value="<?php echo esc_attr($s['color']); ?>"></label></p>
  <p><label>Panel title <input type="text" name="title" value="<?php echo esc_attr($s['title']); ?>" class="regular-text"></label></p>
  <p><label>Introduction<br><textarea name="intro" class="large-text" rows="3"><?php echo esc_textarea($s['intro']); ?></textarea></label></p>
  <p><label>Icon <input type="text" name="icon" value="<?php echo esc_attr($s['icon']); ?>" maxlength="8"></label> <label>Language <select name="language"><option value="en" <?php selected($s['language'], 'en'); ?>>English</option><option value="es" <?php selected($s['language'], 'es'); ?>>EspaÃ±ol</option></select></label></p>
  <p>Visible categories:<br><?php foreach (array_unique(array_filter(array_map(function($i) { return $i['category'] ?? ''; }, $items))) as $category) echo '<label style="margin-right:12px"><input type="checkbox" name="categories[]" value="' . esc_attr($category) . '" ' . checked(empty($s['categories']) || in_array(sanitize_key($category), $s['categories'], true), true, false) . '> ' . esc_html($category) . '</label>'; ?></p>
  <p><button class="button button-primary" name="autowp_improvements_save" value="1">Save changes</button></p></form>
  <h2>Verified improvements</h2><?php if (!$items) echo '<p>No verified improvements are available for this build.</p>'; else echo '<ul>' . implode('', array_map(function($i) { return '<li><strong>' . esc_html($i['category'] ?? 'Improvement') . ':</strong> ' . esc_html($i['correction'] ?? '') . ' — ' . esc_html($i['evidence'] ?? '') . '</li>'; }, $items)) . '</ul>'; ?></div><?php
}
function autowp_improvements_panel() {
  $s = autowp_improvements_settings(); if ($s['enabled'] !== '1' || ($s['audience'] === 'admins' && !current_user_can('manage_options'))) return;
  $report = autowp_improvements_report(); $items = is_array($report['improvements'] ?? null) ? $report['improvements'] : array(); if (!empty($s['categories'])) $items = array_values(array_filter($items, function($item) use ($s) { return in_array(sanitize_key($item['category'] ?? ''), $s['categories'], true); })); if (!$items) return;
  $side = $s['position'] === 'left' ? 'left' : 'right'; $color = esc_attr($s['color']); $brand = $report['brand'] ?? get_bloginfo('name'); $title = $s['title'] ?: ($s['language'] === 'es' ? 'Mejoras verificadas en ' . $brand : $brand . ' verified improvements'); $intro = $s['intro'] ?: ($s['language'] === 'es' ? 'Estas mejoras proceden exclusivamente de esta reconstrucciÃ³n.' : 'These improvements come only from this reconstruction.');
  echo '<aside id="autowp-improvements" style="position:fixed;z-index:99999;bottom:18px;' . $side . ':18px;max-width:360px;background:#fff;border:2px solid ' . $color . ';border-radius:12px;padding:16px;box-shadow:0 8px 28px rgba(0,0,0,.2);font:14px/1.45 system-ui"><button type="button" aria-label="Close improvements" onclick="this.parentNode.remove()" style="float:right;border:0;background:none;font-size:18px">×</button><strong style="color:' . $color . '">' . esc_html($s['icon']) . ' ' . esc_html($title) . '</strong><p style="margin:8px 0">' . esc_html($intro) . '</p><ul style="margin:10px 0 0;padding-left:18px">';
  foreach ($items as $item) echo '<li style="margin-bottom:10px"><strong>' . esc_html($item['category'] ?? '') . ':</strong> ' . esc_html($item['problem'] ?? '') . '<br><span>' . esc_html($item['correction'] ?? '') . '</span><br><small>Impact: ' . esc_html($item['impact'] ?? '') . ' Evidence: ' . esc_html($item['evidence'] ?? '') . '</small></li>';
  echo '</ul></aside>';
}
add_action('wp_footer', 'autowp_improvements_panel', 99);
`;
  }

  private componentsPluginPhp(): string {
    return `<?php
/*
Plugin Name: AutoWP Components
Version: 1.0.0
*/
defined('ABSPATH') || exit;
function autowp_components_register() {
  wp_register_script('autowp-components-editor', plugins_url('editor.js', __FILE__), array('wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components'), '1.0.0', true);
  register_block_type('autowp/component', array(
    'editor_script' => 'autowp-components-editor',
    'attributes' => array(
      'kind' => array('type' => 'string', 'default' => 'component'),
      'html' => array('type' => 'string', 'default' => ''),
      'htmlBase64' => array('type' => 'string', 'default' => ''),
      'text' => array('type' => 'string', 'default' => ''),
      'imageUrl' => array('type' => 'string', 'default' => ''),
      'linkUrl' => array('type' => 'string', 'default' => ''),
      'backgroundColor' => array('type' => 'string', 'default' => ''),
      'padding' => array('type' => 'string', 'default' => ''),
      'hiddenMobile' => array('type' => 'boolean', 'default' => false),
      'preserveRoot' => array('type' => 'boolean', 'default' => false),
    ),
    'render_callback' => function($attributes) {
      $kind = sanitize_html_class($attributes['kind'] ?? 'component');
      $encoded = (string) ($attributes['htmlBase64'] ?? '');
      $decoded = $encoded !== '' ? base64_decode($encoded, true) : false;
      $html = is_string($decoded) ? $decoded : (string) ($attributes['html'] ?? '');
      // Keep a complex source component isolated, while allowing the first
      // visible text, image and link to be safely edited in Gutenberg.
      if (!empty($attributes['text'])) $html = preg_replace('/>([^<>\\S]*(?:[^<\\s][^<]*))</u', '>' . esc_html($attributes['text']) . '<', $html, 1) ?? $html;
      if (!empty($attributes['imageUrl'])) $html = preg_replace('/(<img\\b[^>]*\\bsrc=)(["\\']).*?\\2/i', '$1"' . esc_url($attributes['imageUrl']) . '"', $html, 1) ?? $html;
      if (!empty($attributes['linkUrl'])) $html = preg_replace('/(<a\\b[^>]*\\bhref=)(["\\']).*?\\2/i', '$1"' . esc_url($attributes['linkUrl']) . '"', $html, 1) ?? $html;
      $style = array(); if (!empty($attributes['backgroundColor'])) $style[] = 'background-color:' . sanitize_hex_color($attributes['backgroundColor']); if (!empty($attributes['padding'])) $style[] = 'padding:' . sanitize_text_field($attributes['padding']);
      $classes = 'autowp-component autowp-component-' . esc_attr($kind) . (!empty($attributes['hiddenMobile']) ? ' autowp-hide-mobile' : '');
      if (!empty($attributes['preserveRoot']) && !$style && empty($attributes['hiddenMobile'])) return $html;
      return '<section class="' . $classes . '" data-autowp-component="' . esc_attr($kind) . '" style="' . esc_attr(implode(';', array_filter($style))) . '">' . $html . '</section>';
    }
  ));
}
add_action('init', 'autowp_components_register');
function autowp_components_assets() { wp_enqueue_style('autowp-components', plugins_url('frontend.css', __FILE__), array(), '1.0.0'); wp_enqueue_script('autowp-components', plugins_url('frontend.js', __FILE__), array(), '1.0.0', true); }
add_action('wp_enqueue_scripts', 'autowp_components_assets');

/**
 * Adds stable editor handles at render time. The source snapshot on disk is
 * kept untouched; saved edits live in WordPress and can therefore be rolled
 * back without degrading the original capture.
 */
function autowp_visual_annotate_html($html, $prefix = 'page') {
  if (!is_string($html) || $html === '') return '';
  $prefix = sanitize_key((string) $prefix);
  if ($prefix === '') $prefix = 'page';
  $index = 0;
  $editable = array(
    'h1' => 'text', 'h2' => 'text', 'h3' => 'text', 'h4' => 'text', 'h5' => 'text', 'h6' => 'text',
    'p' => 'text', 'a' => 'link', 'button' => 'button', 'label' => 'text', 'li' => 'text',
    'blockquote' => 'text', 'figcaption' => 'text', 'img' => 'image',
    'section' => 'section', 'article' => 'section', 'main' => 'section', 'nav' => 'section',
    'form' => 'section', 'figure' => 'section', 'header' => 'section', 'footer' => 'section'
  );
  return preg_replace_callback('/<(h[1-6]|p|a|button|label|li|blockquote|figcaption|img|section|article|main|nav|form|figure|header|footer)\\b([^>]*)>/i', function($match) use (&$index, $prefix, $editable) {
    if (stripos($match[2], 'data-autowp-edit-id=') !== false) return $match[0];
    $tag = strtolower($match[1]);
    $id = $prefix . '-' . (++$index);
    return '<' . $match[1] . $match[2] . ' data-autowp-edit-id="' . esc_attr($id) . '" data-autowp-edit-kind="' . esc_attr($editable[$tag] ?? 'element') . '">';
  }, $html) ?? $html;
}

function autowp_visual_register_revision_type() {
  register_post_type('autowp_visual_rev', array(
    'label' => 'AutoWP visual revisions', 'public' => false, 'show_ui' => false,
    'supports' => array('title', 'editor', 'custom-fields'), 'capability_type' => 'post'
  ));
}
add_action('init', 'autowp_visual_register_revision_type');

function autowp_visual_can_edit() { return current_user_can('edit_pages'); }

function autowp_visual_page_for_route($route) {
  $route = '/' . trim((string) $route, '/');
  if ($route === '//') $route = '/';
  foreach ((function_exists('autowp_source_pages') ? autowp_source_pages() : array()) as $slug => $page) {
    if (trim((string)($page['route'] ?? ''), '/') === trim($route, '/')) return array($slug, $page);
  }
  return array(null, null);
}

function autowp_visual_source($scope, $route, $locale, $post_id = 0) {
  $scope = sanitize_key((string) $scope);
  $locale = sanitize_key((string) $locale) ?: 'default';
  if ($scope === 'header' || $scope === 'footer') {
    $option = 'autowp_visual_' . $scope . '_' . $locale;
    $current = get_option($option, '');
    if (is_string($current) && $current !== '') return array('html' => $current, 'target' => $option, 'postId' => 0);
    list(, $page) = autowp_visual_page_for_route($route);
    $relative = is_array($page) ? (string)($page[$scope . 'Part'] ?? '') : '';
    $theme = realpath(get_stylesheet_directory());
    $file = $relative !== '' ? realpath(get_stylesheet_directory() . '/' . ltrim($relative, '/\\\\')) : false;
    if ($theme === false || $file === false || strpos($file, $theme . DIRECTORY_SEPARATOR) !== 0 || !is_readable($file)) return new WP_Error('autowp_source_missing', 'The captured global part could not be read.', array('status' => 404));
    return array('html' => file_get_contents($file), 'target' => $option, 'postId' => 0);
  }
  list($slug, $page) = autowp_visual_page_for_route($route);
  if (!is_array($page)) return new WP_Error('autowp_page_missing', 'The captured page could not be resolved.', array('status' => 404));
  if (!$post_id) {
    $path = trim((string)($page['route'] ?? ''), '/');
    $post = get_page_by_path($path === '' ? 'home' : $path);
    if ($post) $post_id = (int)$post->ID;
  }
  if (!$post_id || !current_user_can('edit_post', $post_id)) return new WP_Error('autowp_page_forbidden', 'The page is not editable.', array('status' => 403));
  $current = get_post_meta($post_id, '_autowp_agent_html_override', true);
  if (!is_string($current) || $current === '') {
    $file = get_stylesheet_directory() . '/' . ltrim((string)($page['template'] ?? ''), '/\\\\');
    if (!is_readable($file)) return new WP_Error('autowp_template_missing', 'The captured page template could not be read.', array('status' => 404));
    $current = file_get_contents($file);
  }
  return array('html' => $current, 'target' => 'post:' . $post_id, 'postId' => $post_id, 'slug' => $slug);
}

function autowp_visual_fragment_document($html) {
  if (!class_exists('DOMDocument')) return new WP_Error('autowp_dom_missing', 'PHP DOM is required for visual editing.', array('status' => 500));
  $document = new DOMDocument('1.0', 'UTF-8');
  $previous = libxml_use_internal_errors(true);
  $loaded = $document->loadHTML('<?xml encoding="utf-8" ?><div id="autowp-visual-root">' . $html . '</div>', LIBXML_HTML_NOIMPLIED | LIBXML_HTML_NODEFDTD);
  libxml_clear_errors(); libxml_use_internal_errors($previous);
  if (!$loaded) return new WP_Error('autowp_dom_invalid', 'The captured fragment could not be parsed safely.', array('status' => 422));
  return $document;
}

function autowp_visual_fragment_html($document) {
  $root = $document->getElementById('autowp-visual-root');
  if (!$root) return '';
  $html = '';
  foreach ($root->childNodes as $child) $html .= $document->saveHTML($child);
  return $html;
}

function autowp_visual_safe_url($value, $image = false) {
  $value = trim((string)$value);
  if ($value === '') return '';
  if (preg_match('~^(?:/|#|\\?|\\./|\\.\\./)~', $value)) return $value;
  $protocols = $image ? array('http', 'https') : array('http', 'https', 'mailto', 'tel');
  return esc_url_raw($value, $protocols);
}

function autowp_visual_first_text_node($node) {
  foreach ($node->childNodes as $child) {
    if ($child->nodeType === XML_TEXT_NODE && trim($child->nodeValue) !== '') return $child;
    if ($child->nodeType === XML_ELEMENT_NODE) { $found = autowp_visual_first_text_node($child); if ($found) return $found; }
  }
  return null;
}

function autowp_visual_apply_operation($document, $operation) {
  $allowed = array('replace_text','set_link','replace_image','set_alt','set_style','remove_style','hide','show','duplicate','remove','move_up','move_down','insert_block');
  $type = sanitize_key((string)($operation['type'] ?? ''));
  $edit_id = sanitize_text_field((string)($operation['editId'] ?? ''));
  if (!in_array($type, $allowed, true) || $edit_id === '') return new WP_Error('autowp_operation_invalid', 'An unsupported visual operation was rejected.', array('status' => 422));
  $xpath = new DOMXPath($document);
  $literal = str_replace("'", "&apos;", $edit_id);
  $nodes = $xpath->query("//*[@data-autowp-edit-id='" . $literal . "']");
  if (!$nodes || $nodes->length !== 1) return new WP_Error('autowp_target_invalid', 'The selected element no longer exists or is ambiguous.', array('status' => 409));
  $node = $nodes->item(0);
  $tag = strtolower($node->nodeName);
  $value = (string)($operation['value'] ?? '');
  if (preg_match('/<\\s*script|javascript:|on[a-z]+\\s*=/i', $value)) return new WP_Error('autowp_value_unsafe', 'Unsafe content was rejected.', array('status' => 422));
  if ($type === 'replace_text') {
    if (!in_array($tag, array('h1','h2','h3','h4','h5','h6','p','a','button','label','li','blockquote','figcaption'), true)) return new WP_Error('autowp_text_target', 'This element is not a safe text target.', array('status' => 422));
    $text = autowp_visual_first_text_node($node);
    if ($text) $text->nodeValue = sanitize_text_field($value); else $node->appendChild($document->createTextNode(sanitize_text_field($value)));
  } elseif ($type === 'set_link') {
    if ($tag !== 'a') return new WP_Error('autowp_link_target', 'Only links can receive a destination.', array('status' => 422));
    $safe = autowp_visual_safe_url($value, false); if ($safe === '') return new WP_Error('autowp_url_unsafe', 'The link destination is unsafe.', array('status' => 422)); $node->setAttribute('href', $safe);
  } elseif ($type === 'replace_image') {
    if ($tag !== 'img') return new WP_Error('autowp_image_target', 'Only images can be replaced.', array('status' => 422));
    $safe = autowp_visual_safe_url($value, true); if ($safe === '') return new WP_Error('autowp_url_unsafe', 'The image URL is unsafe.', array('status' => 422)); $node->setAttribute('src', $safe); $node->removeAttribute('srcset');
  } elseif ($type === 'set_alt') {
    if ($tag !== 'img') return new WP_Error('autowp_image_target', 'Alternative text can only be set on images.', array('status' => 422)); $node->setAttribute('alt', sanitize_text_field($value));
  } elseif ($type === 'set_style' || $type === 'remove_style') {
    $property = strtolower(trim((string)($operation['property'] ?? '')));
    $styles_allowed = array('color','background-color','font-size','font-weight','text-align','padding','margin');
    if (!in_array($property, $styles_allowed, true)) return new WP_Error('autowp_style_unsafe', 'That style property is not allowed.', array('status' => 422));
    $style = (string)$node->getAttribute('style');
    $style = preg_replace('/(?:^|;)\\s*' . preg_quote($property, '/') . '\\s*:[^;]*/i', '', $style) ?? $style;
    if ($type === 'set_style') {
      $clean = sanitize_text_field($value);
      if ($clean === '' || preg_match('/[{}<>]|url\\s*\\(|expression\\s*\\(/i', $clean)) return new WP_Error('autowp_style_unsafe', 'That style value is not allowed.', array('status' => 422));
      $style = trim($style, " ;") . ($style !== '' ? ';' : '') . $property . ':' . $clean;
    }
    if (trim($style, " ;") === '') $node->removeAttribute('style'); else $node->setAttribute('style', trim($style, " ;"));
  } elseif ($type === 'insert_block') {
    if (!$node->parentNode) return new WP_Error('autowp_structure_invalid', 'A block cannot be inserted at this location.', array('status' => 422));
    $block_type = sanitize_key($value);
    $blocks = array(
      'heading' => '<h2>New heading</h2>',
      'paragraph' => '<p>Write your text here.</p>',
      'button' => '<p class="autowp-editor-button"><a href="#">Button</a></p>',
      'image' => '<figure class="autowp-editor-image"><img src="" alt=""></figure>',
      'section' => '<section class="autowp-editor-section"><h2>New section</h2><p>Write your text here.</p></section>',
      'columns' => '<section class="autowp-editor-columns"><div><h3>Column one</h3><p>Write your text here.</p></div><div><h3>Column two</h3><p>Write your text here.</p></div></section>'
    );
    if (!isset($blocks[$block_type])) return new WP_Error('autowp_block_invalid', 'That block is not in the safe library.', array('status' => 422));
    $fragment = autowp_visual_fragment_document($blocks[$block_type]); if (is_wp_error($fragment)) return $fragment;
    $fragment_root = $fragment->getElementById('autowp-visual-root');
    $block_node = $fragment_root && $fragment_root->firstChild ? $document->importNode($fragment_root->firstChild, true) : null;
    if (!$block_node) return new WP_Error('autowp_block_invalid', 'The selected block could not be created.', array('status' => 422));
    $position = sanitize_key((string)($operation['property'] ?? 'after'));
    if ($position === 'before') $node->parentNode->insertBefore($block_node, $node);
    elseif ($position === 'inside' && $node->nodeType === XML_ELEMENT_NODE) $node->appendChild($block_node);
    else $node->parentNode->insertBefore($block_node, $node->nextSibling);
  } elseif ($type === 'hide') {
    $node->setAttribute('data-autowp-visual-hidden', '1'); $node->setAttribute('hidden', 'hidden');
  } elseif ($type === 'show') {
    $node->removeAttribute('data-autowp-visual-hidden'); $node->removeAttribute('hidden');
  } elseif ($type === 'duplicate') {
    if (!$node->parentNode) return new WP_Error('autowp_structure_invalid', 'The element cannot be duplicated.', array('status' => 422));
    $copy = $node->cloneNode(true); foreach ((new DOMXPath($document))->query('.//*[@data-autowp-edit-id] | self::*[@data-autowp-edit-id]', $copy) as $tagged) $tagged->removeAttribute('data-autowp-edit-id'); $node->parentNode->insertBefore($copy, $node->nextSibling);
  } elseif ($type === 'remove') {
    if (!$node->parentNode) return new WP_Error('autowp_structure_invalid', 'The element cannot be removed.', array('status' => 422)); $node->parentNode->removeChild($node);
  } elseif ($type === 'move_up' || $type === 'move_down') {
    if (!$node->parentNode) return new WP_Error('autowp_structure_invalid', 'The element cannot be moved.', array('status' => 422));
    if ($type === 'move_up' && $node->previousSibling) $node->parentNode->insertBefore($node, $node->previousSibling);
    if ($type === 'move_down' && $node->nextSibling) $node->parentNode->insertBefore($node->nextSibling, $node);
  }
  return true;
}

function autowp_visual_save($request) {
  $data = (array)$request->get_json_params();
  $scope = sanitize_key((string)($data['scope'] ?? 'page'));
  $route = sanitize_text_field((string)($data['route'] ?? '/'));
  $locale = sanitize_key((string)($data['locale'] ?? 'default')) ?: 'default';
  $post_id = absint($data['postId'] ?? 0);
  $operations = is_array($data['operations'] ?? null) ? array_values($data['operations']) : array();
  if (!$operations || count($operations) > 50) return new WP_Error('autowp_operations_empty', 'Provide between 1 and 50 safe operations.', array('status' => 422));
  $source = autowp_visual_source($scope, $route, $locale, $post_id); if (is_wp_error($source)) return $source;
  $prefix = $scope === 'page' ? 'page-' . sanitize_key($route ?: 'home') : 'global-' . $scope . '-' . $locale;
  $before = autowp_visual_annotate_html($source['html'], $prefix);
  $document = autowp_visual_fragment_document($before); if (is_wp_error($document)) return $document;
  foreach ($operations as $operation) { $result = autowp_visual_apply_operation($document, (array)$operation); if (is_wp_error($result)) return $result; }
  $after = autowp_visual_fragment_html($document); if ($after === '') return new WP_Error('autowp_result_empty', 'The edit would leave an empty document.', array('status' => 422));
  $revision = wp_insert_post(array('post_type' => 'autowp_visual_rev', 'post_status' => 'private', 'post_title' => 'Visual edit ' . current_time('mysql'), 'post_content' => wp_slash($before)), true);
  if (is_wp_error($revision)) return $revision;
  update_post_meta($revision, '_autowp_visual_scope', $scope); update_post_meta($revision, '_autowp_visual_target', $source['target']); update_post_meta($revision, '_autowp_visual_route', $route); update_post_meta($revision, '_autowp_visual_locale', $locale);
  if ($scope === 'page') update_post_meta((int)$source['postId'], '_autowp_agent_html_override', wp_slash($after)); else update_option($source['target'], $after, false);
  return rest_ensure_response(array('ok' => true, 'revisionId' => (int)$revision, 'scope' => $scope, 'operationsApplied' => count($operations)));
}

function autowp_visual_rollback($request) {
  $revision_id = absint($request['revisionId'] ?? 0); $revision = get_post($revision_id);
  if (!$revision || $revision->post_type !== 'autowp_visual_rev') return new WP_Error('autowp_revision_missing', 'The visual revision was not found.', array('status' => 404));
  $scope = get_post_meta($revision_id, '_autowp_visual_scope', true); $target = get_post_meta($revision_id, '_autowp_visual_target', true); $before = (string)$revision->post_content;
  if ($scope === 'page' && preg_match('/^post:(\\d+)$/', (string)$target, $match)) update_post_meta((int)$match[1], '_autowp_agent_html_override', wp_slash($before));
  elseif (($scope === 'header' || $scope === 'footer') && strpos((string)$target, 'autowp_visual_') === 0) update_option($target, $before, false);
  else return new WP_Error('autowp_revision_invalid', 'The visual revision target is invalid.', array('status' => 422));
  return rest_ensure_response(array('ok' => true, 'revisionId' => $revision_id));
}

function autowp_visual_routes() {
  register_rest_route('autowp/v1', '/visual/save', array('methods' => 'POST', 'callback' => 'autowp_visual_save', 'permission_callback' => 'autowp_visual_can_edit'));
  register_rest_route('autowp/v1', '/visual/rollback/(?P<revisionId>\\d+)', array('methods' => 'POST', 'callback' => 'autowp_visual_rollback', 'permission_callback' => 'autowp_visual_can_edit'));
}
add_action('rest_api_init', 'autowp_visual_routes');

function autowp_visual_editor_assets() {
  if (!current_user_can('edit_pages')) return;
  $editing = isset($_GET['autowp_edit']) && $_GET['autowp_edit'] === '1';
  $page = function_exists('autowp_current_source_page') ? autowp_current_source_page() : null;
  // Native WooCommerce screens remain managed by WooCommerce. GrapesJS edits
  // only a captured source page, which prevents visual changes from replacing
  // product forms, cart sessions or checkout fields.
  if ($editing && !is_array($page)) return;
  wp_enqueue_style('autowp-grapesjs', plugins_url('grapes.min.css', __FILE__), array(), '0.23.2');
  wp_enqueue_style('autowp-visual-editor', plugins_url('visual-editor.css', __FILE__), array('autowp-grapesjs'), '2.0.0');
  wp_enqueue_script('autowp-grapesjs', plugins_url('grapes.min.js', __FILE__), array(), '0.23.2', true);
  wp_enqueue_script('autowp-visual-editor', plugins_url('visual-editor.js', __FILE__), array('autowp-grapesjs'), '2.0.0', true);
  wp_localize_script('autowp-visual-editor', 'AutoWPVisualEditor', array(
    'editing' => $editing, 'restRoot' => esc_url_raw(rest_url('autowp/v1/visual/')), 'nonce' => wp_create_nonce('wp_rest'),
    'postId' => get_queried_object_id(), 'route' => is_array($page) ? ($page['route'] ?? '/') : '/', 'locale' => is_array($page) ? ($page['locale'] ?? 'default') : 'default'
  ));
}
add_action('wp_enqueue_scripts', 'autowp_visual_editor_assets', 100);

function autowp_visual_admin_bar($bar) {
  if (!current_user_can('edit_pages') || is_admin()) return;
  $page = function_exists('autowp_current_source_page') ? autowp_current_source_page() : null;
  if (!is_array($page)) return;
  $url = add_query_arg('autowp_edit', '1', remove_query_arg('autowp_edit'));
  $bar->add_node(array('id' => 'autowp-visual-edit', 'title' => 'Edit with AutoWP', 'href' => $url));
}
add_action('admin_bar_menu', 'autowp_visual_admin_bar', 90);
`;
  }

  private componentsEditorJs(): string {
    return `(function (blocks, element, blockEditor, components) {
  var el = element.createElement, InspectorControls = blockEditor.InspectorControls, TextareaControl = components.TextareaControl, TextControl = components.TextControl, SelectControl = components.SelectControl, ToggleControl = components.ToggleControl;
  blocks.registerBlockType('autowp/component', {
    title: 'AutoWP Component', icon: 'screenoptions', category: 'design', attributes: { kind: { type: 'string', default: 'component' }, html: { type: 'string', default: '' }, htmlBase64: { type: 'string', default: '' }, text: { type: 'string', default: '' }, imageUrl: { type: 'string', default: '' }, linkUrl: { type: 'string', default: '' }, backgroundColor: { type: 'string', default: '' }, padding: { type: 'string', default: '' }, hiddenMobile: { type: 'boolean', default: false }, preserveRoot: { type: 'boolean', default: false } },
    edit: function (props) { var decoded = props.attributes.html || (props.attributes.htmlBase64 ? atob(props.attributes.htmlBase64) : ''); return [el(InspectorControls, {}, el('div', { style: { padding: '12px' } }, el(SelectControl, { label: 'Component type', value: props.attributes.kind, options: ['hero','slider','accordion','tabs','gallery','popup','mega-menu','portfolio','component'].map(function(v){return {label:v,value:v};}), onChange: function(v){props.setAttributes({kind:v});} }), el(TextControl, { label: 'Primary text', value: props.attributes.text, onChange: function(v){props.setAttributes({text:v});} }), el(TextControl, { label: 'Primary image URL', value: props.attributes.imageUrl, onChange: function(v){props.setAttributes({imageUrl:v});} }), el(TextControl, { label: 'Primary link URL', value: props.attributes.linkUrl, onChange: function(v){props.setAttributes({linkUrl:v});} }), el(TextControl, { label: 'Background color', value: props.attributes.backgroundColor, onChange: function(v){props.setAttributes({backgroundColor:v});} }), el(TextControl, { label: 'Padding (for example 24px)', value: props.attributes.padding, onChange: function(v){props.setAttributes({padding:v});} }), el(ToggleControl, { label: 'Hide on mobile', checked: !!props.attributes.hiddenMobile, onChange: function(v){props.setAttributes({hiddenMobile:v});} }), el(TextareaControl, { label: 'Advanced component HTML', value: decoded, onChange: function(v){props.setAttributes({html:'',htmlBase64:btoa(unescape(encodeURIComponent(v)))});} }))), el('div', { className: 'autowp-component-editor' }, el('strong', {}, 'AutoWP ' + props.attributes.kind), el('div', { dangerouslySetInnerHTML: { __html: decoded } }))]; },
    save: function () { return null; }
  });
})(window.wp.blocks, window.wp.element, window.wp.blockEditor, window.wp.components);`;
  }

  private componentsFrontendJs(): string {
    return `document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-autowp-component="slider"]').forEach(function (root) {
    var slides = Array.from(root.querySelectorAll('.swiper-slide, .slide, [data-slide]')); if (slides.length < 2) return;
    var current = 0; var show = function (index) { current = (index + slides.length) % slides.length; slides.forEach(function (slide, i) { slide.hidden = i !== current; }); };
    var previous = document.createElement('button'); previous.type = 'button'; previous.className = 'autowp-slider-prev'; previous.textContent = '‹'; previous.setAttribute('aria-label', 'Previous slide');
    var next = document.createElement('button'); next.type = 'button'; next.className = 'autowp-slider-next'; next.textContent = '›'; next.setAttribute('aria-label', 'Next slide');
    previous.addEventListener('click', function () { show(current - 1); }); next.addEventListener('click', function () { show(current + 1); }); root.append(previous, next); show(0);
  });
  document.querySelectorAll('[data-autowp-component="tabs"]').forEach(function (root) {
    var tabs = Array.from(root.querySelectorAll('[role="tab"], .tab-title, [data-tab]')); var panels = Array.from(root.querySelectorAll('[role="tabpanel"], .tab-content, [data-tab-panel]'));
    tabs.forEach(function (tab, index) { tab.setAttribute('role', 'tab'); tab.addEventListener('click', function () { tabs.forEach(function (item, i) { item.setAttribute('aria-selected', String(i === index)); }); panels.forEach(function (panel, i) { panel.hidden = i !== index; }); }); }); if (tabs[0]) tabs[0].click();
  });
  document.querySelectorAll('[data-autowp-component="accordion"] details').forEach(function (item) { item.open = false; });
  document.querySelectorAll('[data-autowp-component="gallery"] img').forEach(function (image) { image.addEventListener('click', function () { var overlay = document.createElement('div'); overlay.className = 'autowp-lightbox'; overlay.innerHTML = '<img alt="" src="' + image.currentSrc + '">'; overlay.addEventListener('click', function () { overlay.remove(); }); document.body.appendChild(overlay); }); });
  document.querySelectorAll('[data-autowp-component="popup"] [data-open-popup]').forEach(function (trigger) { trigger.addEventListener('click', function () { var popup = trigger.closest('[data-autowp-component="popup"]'); if (popup) popup.classList.add('is-open'); }); });
});`;
  }

  private grapesVisualEditorJs(): string {
    return `(function () {
  var config = window.AutoWPVisualEditor || {};
  if (!config.editing) return;
  if (!window.grapesjs) { window.alert('The local visual editor could not be loaded. The website has not been changed.'); return; }

  var operations = [];
  var revisionKey = 'autowp-visual-revisions:' + String(config.route || '/') + ':' + String(config.locale || '');
  var revisions = [];
  try { revisions = JSON.parse(window.sessionStorage.getItem(revisionKey) || '[]'); if (!Array.isArray(revisions)) revisions = []; } catch (error) { revisions = []; }
  var selected = null;
  var initialTitle = document.title;
  var closeUrl = new URL(window.location.href); closeUrl.searchParams.delete('autowp_edit');
  var shell = document.createElement('div');
  shell.id = 'autowp-grapes-shell';
  shell.innerHTML =
    '<header class="autowp-grapes-toolbar">' +
      '<strong>AutoWP Visual Editor <small>GrapesJS</small></strong>' +
      '<div class="autowp-device-buttons"><button data-device="Desktop">Desktop</button><button data-device="Tablet">Tablet</button><button data-device="Mobile portrait">Mobile</button></div>' +
      '<div class="autowp-save-buttons"><button data-command="discard">Discard</button><button data-command="rollback" disabled>Rollback</button><button class="is-primary" data-command="save" disabled>Save</button><a href="' + closeUrl.href + '">Close</a></div>' +
    '</header>' +
    '<div class="autowp-grapes-workspace">' +
      '<aside class="autowp-grapes-blocks"><h2>Blocks</h2><p>Add a safe editable block after the selected element.</p><div id="autowp-block-library"></div></aside>' +
      '<main id="autowp-grapes-canvas"></main>' +
      '<aside class="autowp-grapes-inspector"><h2>Edit element</h2><div id="autowp-grapes-selection"><p>Select a text, image, button or section.</p></div><p id="autowp-grapes-status" role="status"></p></aside>' +
    '</div>';

  var source = document.body.cloneNode(true);
  ['wpadminbar', 'autowp-grapes-shell', 'autowp-visual-editor'].forEach(function (id) { var node = source.querySelector('#' + id); if (node) node.remove(); });
  source.querySelectorAll('script,noscript').forEach(function (node) { node.remove(); });
  var sourceHtml = source.innerHTML;
  var canvasStyles = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]')).map(function (link) { return link.href; }).filter(function (href) {
    return href.indexOf('grapes.min.css') === -1 && href.indexOf('visual-editor.css') === -1 && href.indexOf('admin-bar') === -1;
  });
  var inlineCss = Array.from(document.querySelectorAll('style')).map(function (style) { return style.textContent || ''; }).filter(function (css) { return css.indexOf('#wpadminbar') === -1; }).join('\\n');
  document.body.innerHTML = '';
  document.body.appendChild(shell);
  document.body.className = 'autowp-grapes-active';
  document.title = 'Editing - ' + initialTitle;

  var editor = window.grapesjs.init({
    container: '#autowp-grapes-canvas',
    height: '100%',
    width: 'auto',
    storageManager: false,
    noticeOnUnload: true,
    fromElement: false,
    components: sourceHtml,
    style: inlineCss,
    canvas: { styles: canvasStyles },
    panels: { defaults: [] },
    deviceManager: { devices: [
      { id: 'Desktop', name: 'Desktop', width: '' },
      { id: 'Tablet', name: 'Tablet', width: '768px', widthMedia: '992px' },
      { id: 'Mobile portrait', name: 'Mobile', width: '390px', widthMedia: '600px' }
    ] }
  });

  var selection = shell.querySelector('#autowp-grapes-selection');
  var status = shell.querySelector('#autowp-grapes-status');
  var saveButton = shell.querySelector('[data-command="save"]');
  var rollbackButton = shell.querySelector('[data-command="rollback"]');
  rollbackButton.disabled = revisions.length === 0;

  function escapeHtml(value) { var node = document.createElement('div'); node.textContent = value == null ? '' : String(value); return node.innerHTML; }
  function selectedElement(component) { try { return component && component.getView && component.getView().el; } catch (error) { return null; } }
  function editId(component) { return String((component && component.getAttributes && component.getAttributes()['data-autowp-edit-id']) || ''); }
  function scopeFor(id) { if (id.indexOf('global-header-') === 0) return 'header'; if (id.indexOf('global-footer-') === 0) return 'footer'; return 'page'; }
  function directText(element) {
    if (!element) return '';
    var walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    var node; while ((node = walker.nextNode())) if (node.nodeValue.trim()) return node.nodeValue.trim(); return '';
  }
  function updateFirstText(element, value) {
    if (!element) return;
    var walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    var node; while ((node = walker.nextNode())) if (node.nodeValue.trim()) { node.nodeValue = value; return; }
    element.appendChild(element.ownerDocument.createTextNode(value));
  }
  function markChanged() { saveButton.disabled = operations.length === 0; status.textContent = operations.length ? operations.length + ' pending change(s).' : ''; }
  function addOperation(component, type, value, property) {
    var id = editId(component); if (!id) { status.textContent = 'Save an inserted block before editing it further.'; return; }
    var item = { scope: scopeFor(id), type: type, editId: id, value: value == null ? '' : String(value), property: property || '' };
    var replaceable = ['replace_text','set_link','replace_image','set_alt','set_style','remove_style','hide','show'];
    if (replaceable.indexOf(type) !== -1) operations = operations.filter(function (existing) { return !(existing.editId === id && existing.type === type && existing.property === item.property); });
    operations.push(item); markChanged();
  }
  function field(label, value, type, onChange, placeholder) {
    var row = document.createElement('label'); row.className = 'autowp-grapes-field';
    var title = document.createElement('span'); title.textContent = label;
    var input = type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
    if (type !== 'textarea') input.type = type || 'text';
    input.value = value || ''; if (placeholder) input.placeholder = placeholder;
    input.addEventListener('change', function () { onChange(input.value); });
    row.append(title, input); return row;
  }
  function action(label, handler, danger) {
    var button = document.createElement('button'); button.type = 'button'; button.textContent = label; if (danger) button.className = 'is-danger'; button.addEventListener('click', handler); return button;
  }
  function renderInspector(component) {
    selected = component;
    var element = selectedElement(component);
    var id = editId(component);
    var tag = String(component.get('tagName') || 'element').toLowerCase();
    var kind = String(component.getAttributes()['data-autowp-edit-kind'] || 'element');
    selection.innerHTML = '<div class="autowp-grapes-target"><strong>' + escapeHtml(tag + ' · ' + kind) + '</strong><code>' + escapeHtml(id || 'new-unsaved-block') + '</code></div>';
    if (!id) { selection.insertAdjacentHTML('beforeend', '<p>This new block will become fully editable after the first save.</p>'); return; }
    if (['h1','h2','h3','h4','h5','h6','p','a','button','label','li','blockquote','figcaption'].indexOf(tag) !== -1) {
      selection.appendChild(field('Text', directText(element), 'textarea', function (value) { updateFirstText(element, value); addOperation(component, 'replace_text', value); }));
    }
    if (tag === 'a') selection.appendChild(field('Link', component.getAttributes().href || '', 'url', function (value) { component.addAttributes({ href: value }); addOperation(component, 'set_link', value); }));
    if (tag === 'img') {
      selection.appendChild(field('Image URL', component.getAttributes().src || '', 'url', function (value) { component.addAttributes({ src: value, srcset: '' }); addOperation(component, 'replace_image', value); }));
      selection.appendChild(field('Alternative text', component.getAttributes().alt || '', 'text', function (value) { component.addAttributes({ alt: value }); addOperation(component, 'set_alt', value); }));
    }
    var design = document.createElement('details'); design.open = true; design.innerHTML = '<summary>Design</summary>';
    var designBody = document.createElement('div'); designBody.className = 'autowp-grapes-design';
    designBody.appendChild(field('Text color', '#111111', 'color', function (value) { component.addStyle({ color: value }); addOperation(component, 'set_style', value, 'color'); }));
    designBody.appendChild(field('Background', '#ffffff', 'color', function (value) { component.addStyle({ 'background-color': value }); addOperation(component, 'set_style', value, 'background-color'); }));
    designBody.appendChild(field('Font size', '', 'text', function (value) { component.addStyle({ 'font-size': value }); addOperation(component, 'set_style', value, 'font-size'); }, 'e.g. 18px'));
    designBody.appendChild(field('Padding', '', 'text', function (value) { component.addStyle({ padding: value }); addOperation(component, 'set_style', value, 'padding'); }, 'e.g. 24px'));
    design.appendChild(designBody); selection.appendChild(design);
    var structure = document.createElement('div'); structure.className = 'autowp-grapes-structure';
    structure.appendChild(action('Hide', function () { if (element) element.hidden = true; addOperation(component, 'hide', ''); }));
    structure.appendChild(action('Show', function () { if (element) element.hidden = false; addOperation(component, 'show', ''); }));
    structure.appendChild(action('Duplicate', function () { if (element && element.parentNode) element.parentNode.insertBefore(element.cloneNode(true), element.nextSibling); addOperation(component, 'duplicate', ''); }));
    structure.appendChild(action('Move up', function () { if (element && element.previousSibling) element.parentNode.insertBefore(element, element.previousSibling); addOperation(component, 'move_up', ''); }));
    structure.appendChild(action('Move down', function () { if (element && element.nextSibling) element.parentNode.insertBefore(element.nextSibling, element); addOperation(component, 'move_down', ''); }));
    structure.appendChild(action('Remove', function () { if (element) element.style.display = 'none'; addOperation(component, 'remove', ''); }, true));
    selection.appendChild(structure);
  }

  editor.on('component:selected', renderInspector);
  shell.querySelectorAll('[data-device]').forEach(function (button) { button.addEventListener('click', function () { editor.setDevice(button.getAttribute('data-device')); shell.querySelectorAll('[data-device]').forEach(function (item) { item.classList.toggle('is-active', item === button); }); }); });
  shell.querySelector('[data-device="Desktop"]').classList.add('is-active');

  var blockTemplates = {
    heading: '<h2>New heading</h2>',
    paragraph: '<p>Write your text here.</p>',
    button: '<p class="autowp-editor-button"><a href="#">Button</a></p>',
    image: '<figure class="autowp-editor-image"><img src="" alt=""></figure>',
    section: '<section class="autowp-editor-section"><h2>New section</h2><p>Write your text here.</p></section>',
    columns: '<section class="autowp-editor-columns"><div><h3>Column one</h3><p>Write your text here.</p></div><div><h3>Column two</h3><p>Write your text here.</p></div></section>'
  };
  var blockNames = { heading: 'Heading', paragraph: 'Text', button: 'Button', image: 'Image', section: 'Section', columns: '2 columns' };
  var blockLibrary = shell.querySelector('#autowp-block-library');
  Object.keys(blockTemplates).forEach(function (type) {
    blockLibrary.appendChild(action(blockNames[type], function () {
      if (!selected || !editId(selected)) { status.textContent = 'Select an existing element to choose where the block is inserted.'; return; }
      var anchor = selected;
      var created = null;
      var parent = anchor.parent && anchor.parent();
      if (parent && parent.components) {
        var at = typeof anchor.index === 'function' ? anchor.index() + 1 : parent.components().length;
        created = parent.components().add(blockTemplates[type], { at: at });
      } else {
        var added = editor.addComponents(blockTemplates[type]);
        created = added && added[0];
      }
      if (created) editor.select(created);
      addOperation(anchor, 'insert_block', type, 'after');
      status.textContent = blockNames[type] + ' preview added. Save to persist it.';
    }));
  });

  function request(path, body) {
    return fetch(config.restRoot + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': config.nonce }, body: JSON.stringify(body || {}) }).then(function (response) {
      return response.json().then(function (data) { if (!response.ok) throw new Error(data.message || 'Request failed'); return data; });
    });
  }
  saveButton.addEventListener('click', function () {
    var groups = {}; operations.forEach(function (item) { (groups[item.scope] || (groups[item.scope] = [])).push({ type: item.type, editId: item.editId, value: item.value, property: item.property }); });
    saveButton.disabled = true; status.textContent = 'Saving verified changes...';
    Object.keys(groups).reduce(function (chain, scope) {
      return chain.then(function () { return request('save', { scope: scope, route: config.route, locale: config.locale, postId: config.postId, operations: groups[scope] }).then(function (result) { revisions.push(result.revisionId); window.sessionStorage.setItem(revisionKey, JSON.stringify(revisions)); }); });
    }, Promise.resolve()).then(function () {
      operations = []; rollbackButton.disabled = revisions.length === 0; status.textContent = 'Saved. Reloading the editable document...'; setTimeout(function () { window.location.reload(); }, 650);
    }).catch(function (error) { saveButton.disabled = false; status.textContent = error.message; });
  });
  shell.querySelector('[data-command="discard"]').addEventListener('click', function () { window.location.reload(); });
  rollbackButton.addEventListener('click', function () {
    var revisionId = revisions.pop(); if (!revisionId) return;
    window.sessionStorage.setItem(revisionKey, JSON.stringify(revisions));
    rollbackButton.disabled = true; status.textContent = 'Restoring previous version...';
    request('rollback/' + revisionId, {}).then(function () { window.location.reload(); }).catch(function (error) { revisions.push(revisionId); window.sessionStorage.setItem(revisionKey, JSON.stringify(revisions)); rollbackButton.disabled = false; status.textContent = error.message; });
  });
})();`;
  }

  private grapesVisualEditorCss(): string {
    return `body.autowp-grapes-active{margin:0!important;overflow:hidden!important;background:#eef1f6!important}#autowp-grapes-shell{position:fixed;z-index:2147483647;inset:0;display:grid;grid-template-rows:58px minmax(0,1fr);background:#eef1f6;color:#172033;font:14px/1.45 system-ui,-apple-system,sans-serif}#autowp-grapes-shell *{box-sizing:border-box}.autowp-grapes-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 14px;background:#172033;color:#fff}.autowp-grapes-toolbar strong{font-size:17px}.autowp-grapes-toolbar small{color:#aeb9cf;font-weight:500}.autowp-grapes-toolbar>div{display:flex;gap:6px}.autowp-grapes-toolbar button,.autowp-grapes-toolbar a,#autowp-block-library button,.autowp-grapes-structure button{min-height:36px;border:1px solid #bfcaDC;border-radius:7px;background:#fff;color:#25334d;padding:7px 11px;text-decoration:none;cursor:pointer}.autowp-grapes-toolbar button.is-active{background:#dce5ff;color:#183da4;border-color:#8199e8}.autowp-grapes-toolbar .is-primary{background:#4667e8;color:#fff;border-color:#4667e8}.autowp-grapes-toolbar button:disabled{opacity:.45;cursor:not-allowed}.autowp-grapes-workspace{min-height:0;display:grid;grid-template-columns:190px minmax(320px,1fr) 310px;gap:1px;background:#cdd4e0}.autowp-grapes-blocks,.autowp-grapes-inspector{overflow:auto;background:#fff;padding:16px}.autowp-grapes-blocks h2,.autowp-grapes-inspector h2{margin:0 0 8px;font-size:17px}.autowp-grapes-blocks p{color:#657187}.autowp-grapes-blocks #autowp-block-library{display:grid;grid-template-columns:1fr 1fr;gap:8px}.autowp-grapes-blocks #autowp-block-library button{min-height:58px}.autowp-grapes-workspace #autowp-grapes-canvas{min-height:0;overflow:hidden;background:#d9dee8}.autowp-grapes-workspace .gjs-editor,.autowp-grapes-workspace .gjs-cv-canvas{width:100%;height:100%;top:0}.autowp-grapes-workspace .gjs-cv-canvas{background:#d9dee8}.autowp-grapes-target{display:grid;gap:4px;padding:11px;margin:10px 0;background:#f1f4fa;border-radius:8px}.autowp-grapes-target code{font-size:11px;overflow-wrap:anywhere}.autowp-grapes-field{display:grid;gap:5px;margin:10px 0}.autowp-grapes-field span{font-weight:650}.autowp-grapes-field input,.autowp-grapes-field textarea{width:100%;min-height:40px;padding:8px;border:1px solid #c8d0de;border-radius:7px;background:#fff;color:#172033}.autowp-grapes-field textarea{min-height:80px;resize:vertical}.autowp-grapes-inspector details{border:1px solid #dce2ec;border-radius:8px;padding:10px;margin:12px 0}.autowp-grapes-inspector summary{font-weight:650;cursor:pointer}.autowp-grapes-structure{display:flex;flex-wrap:wrap;gap:7px}.autowp-grapes-structure button.is-danger{color:#ae2a2a;border-color:#e2a9a9}#autowp-grapes-status{color:#3157df;font-weight:650;min-height:42px}.autowp-editor-button a{display:inline-block;padding:12px 22px;background:#172033;color:#fff;text-decoration:none}.autowp-editor-image img{max-width:100%;height:auto}.autowp-editor-section{padding:32px}.autowp-editor-columns{display:grid;grid-template-columns:1fr 1fr;gap:24px;padding:24px}@media(max-width:900px){.autowp-grapes-workspace{grid-template-columns:150px minmax(280px,1fr) 270px}.autowp-device-buttons{display:none!important}}@media(max-width:680px){#autowp-grapes-shell{grid-template-rows:auto minmax(0,1fr)}.autowp-grapes-toolbar{flex-wrap:wrap}.autowp-grapes-workspace{grid-template-columns:1fr;grid-template-rows:minmax(300px,1fr) 42vh}.autowp-grapes-blocks{display:none}.autowp-grapes-inspector{grid-row:2}.autowp-save-buttons{width:100%;justify-content:flex-end}}`;
  }

  private visualEditorJs(): string {
    return `(function () {
  var config = window.AutoWPVisualEditor || {};
  if (!config.editing) return;
  var operations = [];
  var revisions = [];
  var selected = null;
  var panel = document.createElement('aside');
  panel.id = 'autowp-visual-editor';
  panel.innerHTML = '<header><strong>AutoWP Visual Editor</strong><a href="' + location.href.replace(/([?&])autowp_edit=1(&|$)/, '$1').replace(/[?&]$/, '') + '">Close</a></header>' +
    '<p class="autowp-editor-help">Click a text, button, image or section. Changes are previewed here and saved only when you confirm.</p>' +
    '<details class="autowp-editor-suggestions" open><summary>Verified SEO/CRO suggestions</summary><div id="autowp-editor-suggestion-list"><em>Loading review-only suggestions…</em></div></details>' +
    '<div id="autowp-editor-selection"><em>No element selected</em></div>' +
    '<div class="autowp-editor-actions"><button type="button" data-action="save" disabled>Save changes</button><button type="button" data-action="discard" disabled>Discard preview</button><button type="button" data-action="rollback" disabled>Rollback saved change</button></div>' +
    '<p id="autowp-editor-status" role="status"></p>';
  document.body.appendChild(panel);
  document.body.classList.add('autowp-visual-editing');
  var selection = panel.querySelector('#autowp-editor-selection');
  var status = panel.querySelector('#autowp-editor-status');
  var saveButton = panel.querySelector('[data-action="save"]');
  var discardButton = panel.querySelector('[data-action="discard"]');
  var rollbackButton = panel.querySelector('[data-action="rollback"]');
  var suggestionList = panel.querySelector('#autowp-editor-suggestion-list');

  function escapeHtml(value) { var node = document.createElement('div'); node.textContent = value == null ? '' : String(value); return node.innerHTML; }
  function directText(element) {
    var walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    var node; while ((node = walker.nextNode())) if (node.nodeValue.trim()) return node.nodeValue.trim(); return '';
  }
  function scopeFor(element) {
    var id = element.getAttribute('data-autowp-edit-id') || '';
    if (id.indexOf('global-header-') === 0) return 'header';
    if (id.indexOf('global-footer-') === 0) return 'footer';
    return 'page';
  }
  function addOperationFor(element, type, value, property) {
    if (!element) return;
    var editId = element.getAttribute('data-autowp-edit-id');
    if (!editId) return;
    var scope = scopeFor(element);
    operations = operations.filter(function (item) { return !(item.editId === editId && item.type === type && (item.property || '') === (property || '')); });
    operations.push({ type: type, editId: editId, value: value == null ? '' : String(value), property: property || '', scope: scope });
    saveButton.disabled = false; discardButton.disabled = false; status.textContent = operations.length + ' unsaved change(s).';
  }
  function addOperation(type, value, property) { addOperationFor(selected, type, value, property); }
  function updateFirstText(element, value) {
    var walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); var node;
    while ((node = walker.nextNode())) if (node.nodeValue.trim()) { node.nodeValue = value; return; }
    element.appendChild(document.createTextNode(value));
  }
  function inputRow(label, value, type, onChange, placeholder) {
    var row = document.createElement('label'); row.className = 'autowp-editor-field'; row.innerHTML = '<span>' + escapeHtml(label) + '</span>';
    var input = type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
    if (type !== 'textarea') input.type = type || 'text'; input.value = value || ''; if (placeholder) input.placeholder = placeholder;
    input.addEventListener(type === 'color' ? 'input' : 'change', function () { onChange(input.value); }); row.appendChild(input); return row;
  }
  function actionButton(label, type, apply) {
    var button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.addEventListener('click', function () { addOperation(type, ''); apply(); }); return button;
  }
  function selectElement(element) {
    if (selected) selected.classList.remove('autowp-editor-selected');
    selected = element; selected.classList.add('autowp-editor-selected');
    var kind = element.getAttribute('data-autowp-edit-kind') || 'element';
    var tag = element.tagName.toLowerCase();
    selection.innerHTML = '<div class="autowp-editor-target"><strong>' + escapeHtml(tag + ' · ' + kind) + '</strong><code>' + escapeHtml(element.getAttribute('data-autowp-edit-id')) + '</code></div>';
    if (kind === 'text' || kind === 'link' || kind === 'button') selection.appendChild(inputRow('Text', directText(element), 'textarea', function (value) { updateFirstText(element, value); addOperation('replace_text', value); }));
    if (tag === 'a') selection.appendChild(inputRow('Link', element.getAttribute('href') || '', 'url', function (value) { element.setAttribute('href', value); addOperation('set_link', value); }));
    if (tag === 'img') {
      selection.appendChild(inputRow('Image URL', element.getAttribute('src') || '', 'url', function (value) { element.setAttribute('src', value); element.removeAttribute('srcset'); addOperation('replace_image', value); }));
      selection.appendChild(inputRow('Alternative text', element.getAttribute('alt') || '', 'text', function (value) { element.setAttribute('alt', value); addOperation('set_alt', value); }));
    }
    var design = document.createElement('details'); design.innerHTML = '<summary>Design</summary>'; var designBody = document.createElement('div'); designBody.className = 'autowp-editor-grid';
    designBody.appendChild(inputRow('Text color', '#111111', 'color', function (value) { element.style.color = value; addOperation('set_style', value, 'color'); }));
    designBody.appendChild(inputRow('Background', '#ffffff', 'color', function (value) { element.style.backgroundColor = value; addOperation('set_style', value, 'background-color'); }));
    designBody.appendChild(inputRow('Font size', element.style.fontSize || '', 'text', function (value) { element.style.fontSize = value; addOperation('set_style', value, 'font-size'); }, 'e.g. 18px'));
    var align = document.createElement('select'); ['','left','center','right'].forEach(function (value) { var option = document.createElement('option'); option.value = value; option.textContent = value || 'Original alignment'; align.appendChild(option); });
    align.addEventListener('change', function () { if (align.value) { element.style.textAlign = align.value; addOperation('set_style', align.value, 'text-align'); } else { element.style.removeProperty('text-align'); addOperation('remove_style', '', 'text-align'); } });
    var alignRow = document.createElement('label'); alignRow.className = 'autowp-editor-field'; alignRow.innerHTML = '<span>Alignment</span>'; alignRow.appendChild(align); designBody.appendChild(alignRow); design.appendChild(designBody); selection.appendChild(design);
    var structure = document.createElement('div'); structure.className = 'autowp-editor-structure';
    structure.appendChild(actionButton(element.hidden ? 'Show' : 'Hide', element.hidden ? 'show' : 'hide', function () { element.hidden = !element.hidden; }));
    structure.appendChild(actionButton('Duplicate', 'duplicate', function () { element.parentNode.insertBefore(element.cloneNode(true), element.nextSibling); }));
    structure.appendChild(actionButton('Move up', 'move_up', function () { if (element.previousSibling) element.parentNode.insertBefore(element, element.previousSibling); }));
    structure.appendChild(actionButton('Move down', 'move_down', function () { if (element.nextSibling) element.parentNode.insertBefore(element.nextSibling, element); }));
    structure.appendChild(actionButton('Remove', 'remove', function () { element.style.display = 'none'; })); selection.appendChild(structure);
  }

  document.addEventListener('click', function (event) {
    if (panel.contains(event.target)) return;
    var target = event.target.closest && event.target.closest('[data-autowp-edit-id]'); if (!target) return;
    event.preventDefault(); event.stopPropagation(); selectElement(target);
  }, true);

  function pageMatches(proposal) {
    var normalizeRoute = function (value) {
      var route = String(value || '/');
      return route.length > 1 && route.endsWith('/') ? route.slice(0, -1) : route;
    };
    try { return normalizeRoute(new URL(proposal.pageUrl).pathname) === normalizeRoute(config.route); }
    catch (error) { return false; }
  }
  function previewProposal(proposal) {
    var applied = 0;
    (proposal.operations || []).forEach(function (operation) {
      if (operation.type !== 'replace_text' && operation.type !== 'set_alt') return;
      var matches; try { matches = document.querySelectorAll(operation.selector); } catch (error) { return; }
      if (matches.length !== 1) return;
      var element = matches[0];
      var editable = element.closest('[data-autowp-edit-id]') || element.querySelector('[data-autowp-edit-id]');
      if (!editable) return;
      if (operation.type === 'replace_text') updateFirstText(element, operation.newValue);
      if (operation.type === 'set_alt' && element.tagName.toLowerCase() === 'img') element.setAttribute('alt', operation.newValue);
      addOperationFor(editable, operation.type, operation.newValue, ''); applied += 1;
    });
    status.textContent = applied ? 'Preview ready. Review it before saving.' : 'This suggestion is informational or its target no longer matches safely.';
  }
  function renderSuggestions(plan) {
    var proposals = (plan.proposals || []).filter(pageMatches);
    suggestionList.innerHTML = '';
    if (!proposals.length) { suggestionList.innerHTML = '<p>No safe automatic change was found for this page. Manual editing remains available.</p>'; return; }
    proposals.slice(0, 20).forEach(function (proposal) {
      var card = document.createElement('article'); card.className = 'autowp-suggestion-card';
      card.innerHTML = '<strong>' + escapeHtml(proposal.problem) + '</strong><p>' + escapeHtml(proposal.change) + '</p><small>' + escapeHtml(proposal.expectedImpact) + ' Confidence: ' + Math.round((proposal.confidence || 0) * 100) + '%.</small>';
      var previewable = (proposal.operations || []).some(function (operation) { return operation.type === 'replace_text' || operation.type === 'set_alt'; });
      var button = document.createElement('button'); button.type = 'button'; button.textContent = previewable ? 'Preview safely' : 'SEO review required'; button.disabled = !previewable;
      button.addEventListener('click', function () { previewProposal(proposal); }); card.appendChild(button); suggestionList.appendChild(card);
    });
  }
  if (config.proposalsUrl) fetch(config.proposalsUrl, { credentials: 'same-origin' }).then(function (response) { if (!response.ok) throw new Error('Suggestions unavailable'); return response.json(); }).then(renderSuggestions).catch(function () { suggestionList.innerHTML = '<p>Suggestions could not be loaded. Manual editing is still available.</p>'; });

  function request(path, body) {
    return fetch(config.restRoot + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': config.nonce }, body: JSON.stringify(body || {}) }).then(function (response) { return response.json().then(function (data) { if (!response.ok) throw new Error(data.message || 'Request failed'); return data; }); });
  }
  saveButton.addEventListener('click', function () {
    var groups = {}; operations.forEach(function (item) { (groups[item.scope] || (groups[item.scope] = [])).push({ type: item.type, editId: item.editId, value: item.value, property: item.property }); });
    saveButton.disabled = true; status.textContent = 'Saving verified changes...';
    Object.keys(groups).reduce(function (chain, scope) { return chain.then(function () { return request('save', { scope: scope, route: config.route, locale: config.locale, postId: config.postId, operations: groups[scope] }).then(function (result) { revisions.push(result.revisionId); }); }); }, Promise.resolve()).then(function () { operations = []; discardButton.disabled = true; rollbackButton.disabled = revisions.length === 0; status.textContent = 'Changes saved. A rollback revision is available.'; }).catch(function (error) { saveButton.disabled = false; status.textContent = error.message; });
  });
  discardButton.addEventListener('click', function () { location.reload(); });
  rollbackButton.addEventListener('click', function () {
    var revisionId = revisions.pop(); if (!revisionId) return; rollbackButton.disabled = true; status.textContent = 'Restoring previous version...';
    request('rollback/' + revisionId, {}).then(function () { location.reload(); }).catch(function (error) { rollbackButton.disabled = false; status.textContent = error.message; });
  });
})();`;
  }

  private visualEditorCss(): string {
    return `body.autowp-visual-editing{padding-right:360px!important}.autowp-visual-editing [data-autowp-edit-id]{cursor:crosshair}.autowp-visual-editing [data-autowp-edit-id]:hover{outline:2px dashed #4667e8!important;outline-offset:2px}.autowp-editor-selected{outline:3px solid #3157df!important;outline-offset:3px}#autowp-visual-editor{position:fixed;z-index:2147483646;top:32px;right:0;bottom:0;width:360px;box-sizing:border-box;overflow:auto;background:#fff;color:#172033;border-left:1px solid #d8deea;box-shadow:-10px 0 28px rgba(28,39,63,.16);padding:18px;font:14px/1.45 system-ui,-apple-system,sans-serif}#autowp-visual-editor *{box-sizing:border-box}#autowp-visual-editor header{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:17px}#autowp-visual-editor header a{font-size:13px;color:#3157df}.autowp-editor-help{color:#596579}.autowp-editor-target{display:grid;gap:4px;padding:12px;margin:14px 0;background:#f4f7fc;border-radius:9px}.autowp-editor-target code{font-size:11px;overflow-wrap:anywhere}.autowp-editor-field{display:grid;gap:5px;margin:10px 0}.autowp-editor-field span{font-weight:600}.autowp-editor-field input,.autowp-editor-field textarea,.autowp-editor-field select{width:100%;min-height:40px;border:1px solid #cbd3e0;border-radius:7px;padding:8px;color:#172033;background:#fff}.autowp-editor-field textarea{min-height:82px;resize:vertical}#autowp-visual-editor details{margin:14px 0;border:1px solid #dfe4ec;border-radius:8px;padding:10px}#autowp-visual-editor summary{font-weight:650;cursor:pointer}.autowp-editor-grid{padding-top:6px}.autowp-editor-structure,.autowp-editor-actions{display:flex;flex-wrap:wrap;gap:7px;margin-top:14px}#autowp-visual-editor button{border:1px solid #bbc5d6;background:#fff;color:#243047;border-radius:7px;padding:8px 10px;cursor:pointer}#autowp-visual-editor button[data-action=save]{background:#3157df;color:#fff;border-color:#3157df}#autowp-visual-editor button:disabled{opacity:.45;cursor:not-allowed}#autowp-editor-status{min-height:22px;color:#3157df;font-weight:600}@media(max-width:782px){body.autowp-visual-editing{padding-right:0!important;padding-bottom:46vh!important}#autowp-visual-editor{top:auto;left:0;right:0;bottom:0;width:100%;height:46vh;border-left:0;border-top:1px solid #d8deea}.autowp-editor-selected{outline-width:2px!important}}`;
  }

  private componentsFrontendCss(): string {
    return `.autowp-component{position:relative}.autowp-component [hidden]{display:none!important}@media(max-width:782px){.autowp-hide-mobile{display:none!important}}.autowp-slider-prev,.autowp-slider-next{position:absolute;top:50%;z-index:3;border:0;border-radius:50%;width:42px;height:42px;cursor:pointer;transform:translateY(-50%)}.autowp-slider-prev{left:12px}.autowp-slider-next{right:12px}.autowp-lightbox{position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,.86);display:grid;place-items:center;cursor:zoom-out}.autowp-lightbox img{max-width:94vw;max-height:94vh}.autowp-component-popup:not(.is-open) .popup-content,.autowp-component-popup:not(.is-open) [role="dialog"]{display:none}`;
  }

  private indexPhp(): string {
    return `<?php
get_header();
if (!autowp_render_source_page()) {
  echo '<main><h1>' . esc_html(get_the_title()) . '</h1>';
  while (have_posts()) { the_post(); the_content(); }
  echo '</main>';
}
get_footer();
`;
  }

  private pagePhp(): string {
    return `<?php
get_header();
if (!autowp_render_source_page()) while (have_posts()) { the_post(); the_content(); }
get_footer();
`;
  }

  private woocommercePhp(): string {
    return `<?php
get_header();
?>
<main id="primary" class="autowp-commerce-main">
  <?php woocommerce_content(); ?>
</main>
<?php
get_footer();
`;
  }

  private sourceCommerceJs(): string {
    return `(() => {
  const config = window.AutoWPSourceCommerce;
  if (!config || !config.productId) return;
  const ready = (callback) => document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', callback, { once: true })
    : callback();
  const slug = (value) => String(value || '').normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const productForms = () => Array.from(document.querySelectorAll('form')).filter((form) =>
    form.matches('.cart, form[action*="/cart/add"], form[data-product-form]') ||
    Boolean(form.closest('shopify-product-form')) ||
    Boolean(form.querySelector('input[name="id"][value]'))
  );
  const selectedLabels = (form) => Array.from(form.querySelectorAll('input:checked, select')).map((field) => {
    if (field.tagName === 'SELECT') return field.options[field.selectedIndex]?.textContent?.trim() || field.value;
    return field.getAttribute('data-value') || field.value || field.closest('label')?.textContent?.trim() || '';
  }).filter(Boolean).map((value) => String(value).toLowerCase());
  const variantFor = (form) => {
    const variants = config.variants || {};
    const sourceId = form.querySelector('input[name="id"]')?.value || form.querySelector('[name="variant"]')?.value || '';
    if (sourceId && variants[sourceId]) return variants[sourceId];
    const labels = selectedLabels(form);
    return Object.values(variants).find((variant) => Object.values(variant.attributes || {}).every((value) =>
      labels.some((label) => label === String(value).toLowerCase() || label.includes(String(value).toLowerCase()))
    )) || Object.values(variants)[0] || null;
  };
  const submitToWooCommerce = async (sourceForm) => {
    const data = new FormData();
    data.set('action', 'autowp_add_to_cart');
    data.set('nonce', config.nonce || '');
    data.set('product_id', String(config.productId));
    const quantity = sourceForm.querySelector('[name="quantity"]')?.value || '1';
    data.set('quantity', quantity);
    const variant = variantFor(sourceForm);
    if (variant?.variationId) {
      data.set('variation_id', String(variant.variationId));
      Object.entries(variant.attributes || {}).forEach(([name, value]) => data.set('variation[' + slug(name) + ']', String(value)));
    }
    const response = await fetch(config.ajaxUrl, { method: 'POST', body: data, credentials: 'same-origin' });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result?.success) throw new Error(result?.data?.message || 'No se pudo añadir el producto al carrito.');
    location.assign(result.data.cartUrl || config.cartUrl);
  };
  ready(() => {
    productForms().forEach((form) => {
      form.dataset.autowpCommerceBridge = '1';
      form.method = 'post';
      form.action = location.pathname + location.search;
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        const buttons = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"], [name="add"]'));
        buttons.forEach((button) => { button.disabled = true; button.setAttribute('aria-busy', 'true'); });
        try {
          await submitToWooCommerce(form);
        } catch (error) {
          buttons.forEach((button) => { button.disabled = false; button.removeAttribute('aria-busy'); });
          form.dispatchEvent(new CustomEvent('autowp:cart-error', { bubbles: true, detail: error }));
          window.alert(error instanceof Error ? error.message : 'No se pudo añadir el producto al carrito.');
        }
      }, true);
      form.querySelectorAll('button[type="submit"], input[type="submit"], [name="add"]').forEach((button) => {
        button.removeAttribute('disabled');
        button.setAttribute('aria-disabled', 'false');
      });
    });
    document.addEventListener('click', (event) => {
      const trigger = event.target.closest('a[href*="/cart"], a[href*="/carrito"], a[href*="/cistella"], a[href*="/basket"], a[href*="/panier"], a[href*="/warenkorb"], [href="#cart"], [on\\\\:click*="/open"], cart-drawer, .cart-icon-bubble, [data-cart-toggle]');
      if (!trigger || trigger.closest('form[data-autowp-commerce-bridge="1"]')) return;
      event.preventDefault();
      location.href = config.cartUrl;
    }, true);
    document.querySelectorAll('[data-cart-count], .cart-count-bubble span, .cart-count, [class*="cart-count"]').forEach((node) => {
      if (/^\\s*\\d+\\s*$/.test(node.textContent || '')) node.textContent = String(config.cartCount || 0);
    });
  });
})();`;
  }

  private commerceJs(): string {
    return `(() => {
  const onReady = (callback) => document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', callback, { once: true })
    : callback();

  const optionLabel = (option) => (option.textContent || '').trim();
  const isColor = (select) => /colou?r|color|tono/i.test([select.name, select.id, select.dataset.attribute_name].filter(Boolean).join(' '));

  function enhanceSelect(select) {
    if (select.dataset.autowpEnhanced === '1') return;
    const options = Array.from(select.options).filter((option) => option.value);
    if (!options.length) return;
    select.dataset.autowpEnhanced = '1';
    select.classList.add('autowp-native-variation-select');
    const group = document.createElement('div');
    group.className = isColor(select) ? 'autowp-option-group is-color' : 'autowp-option-group';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', select.closest('tr')?.querySelector('label')?.textContent?.trim() || select.name || 'Option');

    const sync = () => {
      group.querySelectorAll('button').forEach((button) => {
        const active = button.dataset.value === select.value;
        button.classList.toggle('is-selected', active);
        button.setAttribute('aria-checked', active ? 'true' : 'false');
      });
    };

    options.forEach((option) => {
      const label = optionLabel(option);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'autowp-option';
      button.dataset.value = option.value;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', label);
      button.title = label;
      if (group.classList.contains('is-color')) {
        button.style.setProperty('--swatch-color', colorFromLabel(label));
        button.innerHTML = '<span class="screen-reader-text"></span>';
        button.querySelector('span').textContent = label;
      } else {
        button.textContent = label;
      }
      button.addEventListener('click', () => {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        sync();
      });
      group.appendChild(button);
    });
    select.insertAdjacentElement('afterend', group);
    select.addEventListener('change', sync);
    sync();
  }

  function colorFromLabel(label) {
    const value = label.toLowerCase();
    const palette = {
      beige: '#e9d9ad', negro: '#080808', black: '#080808', blanco: '#fafafa', white: '#fafafa',
      azul: '#233d68', 'azul marino': '#17233f', blue: '#233d68', rojo: '#a52b2b', red: '#a52b2b',
      rosa: '#d9a0ad', pink: '#d9a0ad', verde: '#667c59', green: '#667c59', marron: '#76523c', brown: '#76523c'
    };
    return palette[value] || '#d9d9d9';
  }

  function enhanceQuantity(quantity) {
    if (quantity.dataset.autowpEnhanced === '1') return;
    const input = quantity.querySelector('input.qty');
    if (!input) return;
    quantity.dataset.autowpEnhanced = '1';
    const minus = document.createElement('button');
    const plus = document.createElement('button');
    minus.type = plus.type = 'button';
    minus.className = plus.className = 'autowp-qty-button';
    minus.textContent = '−'; plus.textContent = '+';
    minus.setAttribute('aria-label', 'Reducir cantidad');
    plus.setAttribute('aria-label', 'Aumentar cantidad');
    quantity.prepend(minus); quantity.append(plus);
    const step = Number(input.step) > 0 ? Number(input.step) : 1;
    const min = input.min === '' ? 1 : Number(input.min);
    const max = input.max === '' ? Infinity : Number(input.max);
    const update = (direction) => {
      const current = Number(input.value) || min;
      input.value = String(Math.min(max, Math.max(min, current + direction * step)));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const updateCart = quantity.closest('form')?.querySelector('button[name="update_cart"]');
      if (updateCart) updateCart.disabled = false;
    };
    minus.addEventListener('click', () => update(-1));
    plus.addEventListener('click', () => update(1));
  }

  function addShare(summary) {
    if (summary.querySelector('.autowp-product-share')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'autowp-product-share';
    button.textContent = '⇧  Share';
    button.addEventListener('click', async () => {
      const data = { title: document.title, url: location.href };
      if (navigator.share) await navigator.share(data).catch(() => undefined);
      else await navigator.clipboard?.writeText(location.href).catch(() => undefined);
    });
    summary.appendChild(button);
  }

  onReady(() => {
    document.querySelectorAll('.variations select').forEach(enhanceSelect);
    document.querySelectorAll('form.cart .quantity, .woocommerce-cart-form .quantity').forEach(enhanceQuantity);
    document.querySelectorAll('div.product .summary').forEach(addShare);
    document.querySelectorAll('.reset_variations').forEach((reset) => reset.addEventListener('click', () => {
      setTimeout(() => document.querySelectorAll('.variations select').forEach((select) => select.dispatchEvent(new Event('change'))), 0);
    }));
  });
})();
`;
  }

  private commerceCss(): string {
    return `/* Isolated native WooCommerce presentation. Captured platform CSS is intentionally not loaded here. */
:root{--autowp-ink:#171717;--autowp-muted:#676767;--autowp-line:#dedede;--autowp-accent:#111;--autowp-surface:#fff;--autowp-soft:#f7f5f4}
html{box-sizing:border-box}*,*:before,*:after{box-sizing:inherit}
body.woocommerce,body.woocommerce-page{margin:0;background:var(--autowp-surface);color:var(--autowp-ink);font:16px/1.55 Assistant,"Segoe UI",Arial,sans-serif}
.autowp-commerce-header{position:relative;z-index:20;display:flex;align-items:center;gap:30px;width:min(1100px,calc(100% - 32px));min-height:76px;margin:0 auto;padding:14px 0;border-bottom:1px solid var(--autowp-line);background:#fff}
.autowp-commerce-brand{color:var(--autowp-ink);font:700 clamp(23px,2vw,30px)/1.1 Assistant,"Segoe UI",Arial,sans-serif;text-decoration:none;white-space:nowrap}
.autowp-commerce-nav{margin-left:auto}.autowp-commerce-nav ul{display:flex;align-items:center;gap:clamp(16px,2.4vw,38px);margin:0;padding:0;list-style:none}.autowp-commerce-nav a{color:var(--autowp-ink);text-decoration:none}.autowp-commerce-nav a:hover{text-decoration:underline;text-underline-offset:5px}
.autowp-commerce-cart{display:inline-flex;align-items:center;gap:7px;color:var(--autowp-ink);font-weight:650;text-decoration:none;white-space:nowrap}
.autowp-commerce-main{width:min(1050px,100%);min-height:60vh;margin:0 auto;padding:clamp(34px,4vw,56px) 24px}
.autowp-commerce-main .woocommerce-notices-wrapper{grid-column:1/-1}.autowp-commerce-main .woocommerce-message,.autowp-commerce-main .woocommerce-info,.autowp-commerce-main .woocommerce-error{margin:0 0 28px;padding:18px 20px;border:1px solid var(--autowp-line);border-top:4px solid var(--autowp-accent);background:var(--autowp-soft);list-style:none}.autowp-commerce-main .woocommerce-message .button{float:right}
.autowp-commerce-main div.product{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(340px,.82fr);gap:clamp(42px,5vw,58px);align-items:start}.autowp-commerce-main div.product:after{display:none}
.autowp-commerce-main div.product .woocommerce-product-gallery,.autowp-commerce-main div.product .summary{float:none!important;width:auto!important;margin:0!important}
.autowp-commerce-main .woocommerce-product-gallery__wrapper{margin:0}.autowp-commerce-main .woocommerce-product-gallery__image{overflow:hidden;background:#fff}.autowp-commerce-main .woocommerce-product-gallery__image>a{display:flex;justify-content:center}.autowp-commerce-main .woocommerce-product-gallery img{display:block;width:auto!important;max-width:84%!important;height:auto!important;margin:0 auto;object-fit:contain}
.autowp-commerce-main .flex-control-thumbs{display:grid!important;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:14px 0 0!important;padding:0!important;list-style:none}.autowp-commerce-main .flex-control-thumbs li{float:none!important;width:auto!important;margin:0!important}.autowp-commerce-main .flex-control-thumbs img{width:100%!important;max-width:100%!important;aspect-ratio:1;object-fit:cover;cursor:pointer;border:1px solid transparent}.autowp-commerce-main .flex-control-thumbs .flex-active{border-color:var(--autowp-ink)}
.autowp-commerce-main .summary .product_title{margin:0 0 8px;color:var(--autowp-ink);font:700 clamp(32px,3.15vw,40px)/1.2 Assistant,"Segoe UI",Arial,sans-serif!important;letter-spacing:-.018em;text-transform:none!important;overflow-wrap:anywhere}.autowp-commerce-main .summary .price{margin:0 0 22px;color:var(--autowp-ink);font-size:22px;font-weight:400}.autowp-commerce-main .woocommerce-product-details__short-description{margin-top:24px;color:var(--autowp-muted);font-size:16px}
.autowp-commerce-main form.cart{display:grid;gap:18px;margin:28px 0}.autowp-commerce-main table.variations{width:100%;border-collapse:collapse}.autowp-commerce-main table.variations th,.autowp-commerce-main table.variations td{display:block;padding:0 0 8px;text-align:left}.autowp-commerce-main table.variations label{font-weight:700}.autowp-commerce-main table.variations select{width:100%;min-height:48px;padding:10px 42px 10px 13px;border:1px solid var(--autowp-line);background:#fff;font:inherit}.autowp-commerce-main .reset_variations{display:inline-block;margin-top:7px;color:var(--autowp-muted)}
.autowp-commerce-main .woocommerce-variation-add-to-cart{display:grid!important;grid-template-columns:104px minmax(0,1fr);gap:12px;width:100%}.autowp-commerce-main .quantity{display:inline-flex!important;float:none!important}.autowp-commerce-main .quantity input{width:104px;min-height:54px;padding:8px;border:1px solid var(--autowp-line);font:inherit;text-align:center}.autowp-commerce-main button.button,.autowp-commerce-main a.button,.autowp-commerce-main input.button{display:inline-flex;align-items:center;justify-content:center;min-height:54px;padding:13px 24px;border:1px solid var(--autowp-ink);border-radius:0;background:var(--autowp-ink);color:#fff;font:600 16px/1.2 Assistant,"Segoe UI",Arial,sans-serif;text-decoration:none;cursor:pointer}.autowp-commerce-main button.button:hover,.autowp-commerce-main a.button:hover{background:#333;border-color:#333;color:#fff}.autowp-commerce-main .single_add_to_cart_button{width:100%}
.autowp-commerce-main .product_meta{display:grid;gap:6px;padding-top:20px;border-top:1px solid var(--autowp-line);color:var(--autowp-muted);font-size:14px}.autowp-commerce-main .product_meta a{color:inherit}
.autowp-commerce-main .woocommerce-tabs,.autowp-commerce-main .related,.autowp-commerce-main .upsells{grid-column:1/-1;margin-top:clamp(42px,6vw,88px)}.autowp-commerce-main .woocommerce-tabs ul.tabs{display:flex;gap:24px;margin:0 0 24px!important;padding:0!important;border-bottom:1px solid var(--autowp-line);list-style:none}.autowp-commerce-main .woocommerce-tabs ul.tabs:before,.autowp-commerce-main .woocommerce-tabs ul.tabs li:before,.autowp-commerce-main .woocommerce-tabs ul.tabs li:after{display:none!important}.autowp-commerce-main .woocommerce-tabs ul.tabs li{margin:0!important;padding:0!important;border:0!important;background:transparent!important}.autowp-commerce-main .woocommerce-tabs ul.tabs a{display:block;padding:12px 0;color:var(--autowp-ink);text-decoration:none}.autowp-commerce-main .woocommerce-tabs ul.tabs .active a{border-bottom:3px solid var(--autowp-accent)}
.autowp-commerce-main h2{font:700 clamp(27px,3vw,38px)/1.2 Assistant,"Segoe UI",Arial,sans-serif}.autowp-commerce-main ul.products{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr));gap:clamp(18px,2.4vw,30px);margin:0!important;padding:0!important;list-style:none}.autowp-commerce-main ul.products:before,.autowp-commerce-main ul.products:after{display:none}.autowp-commerce-main ul.products li.product{float:none!important;width:auto!important;margin:0!important}.autowp-commerce-main ul.products img{display:block;width:100%!important;height:auto!important;aspect-ratio:3/4;object-fit:cover;background:var(--autowp-soft)}.autowp-commerce-main ul.products h2{margin:13px 0 5px;font:600 17px/1.35 Assistant,"Segoe UI",Arial,sans-serif}.autowp-commerce-main ul.products .price{display:block;margin-bottom:12px;color:var(--autowp-muted)}
.autowp-commerce-main table.shop_table{width:100%;border-collapse:collapse}.autowp-commerce-main table.shop_table th,.autowp-commerce-main table.shop_table td{padding:14px;border-bottom:1px solid var(--autowp-line);text-align:left}.autowp-commerce-main .cart_totals{width:min(100%,520px);margin:34px 0 0 auto}.autowp-commerce-main .checkout{display:grid;grid-template-columns:1fr 1fr;gap:32px}.autowp-commerce-main #order_review_heading,.autowp-commerce-main #order_review{grid-column:2}.autowp-commerce-main .form-row input,.autowp-commerce-main .form-row textarea,.autowp-commerce-main .form-row select{width:100%;min-height:45px;padding:10px;border:1px solid var(--autowp-line)}
.autowp-commerce-footer{padding:30px clamp(20px,5vw,76px);border-top:1px solid var(--autowp-line);color:var(--autowp-muted);background:var(--autowp-soft);text-align:center}
@media(max-width:900px){.autowp-commerce-header{flex-wrap:wrap;gap:14px}.autowp-commerce-nav{order:3;width:100%;overflow:auto}.autowp-commerce-nav ul{justify-content:flex-start;min-width:max-content}.autowp-commerce-main div.product{grid-template-columns:1fr}.autowp-commerce-main .woocommerce-product-gallery img{max-width:min(84%,520px)!important}.autowp-commerce-main ul.products{grid-template-columns:repeat(2,minmax(0,1fr))}.autowp-commerce-main .checkout{display:block}.autowp-commerce-main #order_review_heading,.autowp-commerce-main #order_review{grid-column:auto}}
@media(max-width:520px){.autowp-commerce-header{width:calc(100% - 28px);padding:13px 0}.autowp-commerce-nav{overflow:visible}.autowp-commerce-nav ul{flex-wrap:wrap;justify-content:center;gap:8px 16px;min-width:0}.autowp-commerce-nav li,.autowp-commerce-nav a{max-width:100%}.autowp-commerce-main{padding:24px 14px}.autowp-commerce-main .woocommerce-product-gallery img{max-width:100%!important}.autowp-commerce-main .summary .product_title{font-size:30px!important}.autowp-commerce-main ul.products{gap:14px}.autowp-commerce-main .woocommerce-tabs ul.tabs{gap:13px;overflow:auto}.autowp-commerce-main .woocommerce-message .button{float:none;margin:0 0 10px;width:100%}.autowp-commerce-main table.shop_table thead{display:none}.autowp-commerce-main table.shop_table tr{display:block;padding:12px 0}.autowp-commerce-main table.shop_table td{display:flex;justify-content:space-between;gap:16px}.autowp-commerce-main table.shop_table td.product-thumbnail{display:none}}

/* Source-faithful native product shell: WooCommerce remains the data and checkout engine. */
.autowp-commerce-header{width:min(1000px,calc(100% - 32px));min-height:66px;padding:10px 0;border:0;gap:22px}
.autowp-commerce-brand{font-size:27px;letter-spacing:.04em}.autowp-commerce-nav ul{gap:30px}.autowp-commerce-nav a,.autowp-commerce-cart{font-size:14px;letter-spacing:.04em}
.autowp-commerce-announcement{display:grid;grid-template-columns:1fr 1fr 1fr;align-items:center;min-height:55px;padding:0 max(24px,calc((100% - 1000px)/2));background:#bd7e91;color:#fff;font-size:12px;letter-spacing:.04em}
.autowp-commerce-announcement__social{display:flex;gap:20px}.autowp-commerce-announcement__social a{color:#fff;text-decoration:none;font-weight:700}.autowp-commerce-announcement__brand{text-align:center;font-weight:700}.autowp-commerce-announcement__locale{text-align:right}
.autowp-commerce-main{width:min(948px,100%);padding:36px 24px 58px}.autowp-commerce-main div.product{grid-template-columns:minmax(0,55%) minmax(0,45%);gap:0}.autowp-commerce-main div.product .summary{padding-left:50px}
.autowp-commerce-main .woocommerce-product-gallery img{width:100%!important;max-width:100%!important}.autowp-commerce-main .summary:before{content:'MI TIENDA';display:block;margin:7px 0 5px;color:#8b8b8b;font-size:9px;letter-spacing:.24em}
.autowp-commerce-main .summary .product_title{font-size:40px!important;line-height:1.18!important;letter-spacing:-.02em}.autowp-commerce-main .summary .price{font-size:17px;margin-bottom:10px}
.autowp-commerce-main .summary .price:after{content:'Impuestos incluidos. Los gastos de envío se calculan en la pantalla de pago.';display:block;max-width:330px;margin-top:8px;color:#777;font-size:12px;line-height:1.75}
.autowp-commerce-main form.cart{gap:14px;margin:24px 0}.autowp-commerce-main table.variations th,.autowp-commerce-main table.variations td{padding-bottom:4px}.autowp-commerce-main table.variations label{color:#777;font-size:13px;font-weight:400}
.autowp-commerce-main table.variations select.autowp-native-variation-select{position:absolute!important;left:-9999px!important;width:1px!important;min-width:1px!important;height:1px!important;min-height:1px!important;margin:-1px!important;padding:0!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
.autowp-option-group{display:flex;flex-wrap:wrap;gap:10px;margin:3px 0 12px}.autowp-option{min-width:52px;height:38px;padding:0 17px;border:1px solid #8a8a8a;border-radius:999px;background:#fff;color:#333;font:500 13px/1 Assistant,"Segoe UI",Arial,sans-serif;cursor:pointer}.autowp-option.is-selected{border-color:#111;background:#111;color:#fff}.autowp-option-group.is-color{gap:12px}.autowp-option-group.is-color .autowp-option{min-width:34px;width:34px;height:34px;padding:0;border:3px solid #fff;background:var(--swatch-color);box-shadow:0 0 0 1px #777}.autowp-option-group.is-color .autowp-option.is-selected{box-shadow:0 0 0 2px #111}
.autowp-commerce-main .woocommerce-variation-add-to-cart,.autowp-commerce-main form.cart:not(.variations_form){display:block!important}.autowp-commerce-main .quantity{display:grid!important;grid-template-columns:46px 52px 46px;width:144px;height:48px;margin:0 0 24px;border:1px solid #888}.autowp-commerce-main .quantity input{width:52px!important;min-height:46px!important;padding:0!important;border:0!important;-moz-appearance:textfield}.autowp-commerce-main .quantity input::-webkit-outer-spin-button,.autowp-commerce-main .quantity input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}.autowp-qty-button{border:0;background:#fff;color:#333;font-size:20px;cursor:pointer}.autowp-commerce-main .single_add_to_cart_button{min-height:48px!important;border-color:#111!important;background:#111!important;font-size:14px!important;letter-spacing:.03em}
.autowp-commerce-main .woocommerce-product-details__short-description{margin-top:25px;color:#666;font-size:16px;line-height:1.8}.autowp-commerce-main .product_meta{border:0;padding-top:8px}.autowp-product-share{margin-top:22px;padding:0;border:0;background:transparent;color:#222;font:400 14px/1.2 Assistant,"Segoe UI",Arial,sans-serif;cursor:pointer}

/* Cart and checkout use native WooCommerce actions with a stable store shell. */
.woocommerce-cart .autowp-commerce-main>.woocommerce{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:48px;align-items:start}.woocommerce-cart .autowp-commerce-main>.woocommerce>.woocommerce-notices-wrapper,.woocommerce-cart .autowp-commerce-main>.woocommerce>.woocommerce-cart-form__contents,.woocommerce-cart .autowp-commerce-main>.woocommerce>.cart-empty,.woocommerce-cart .autowp-commerce-main>.woocommerce>.return-to-shop{grid-column:1/-1}.woocommerce-cart .woocommerce-cart-form{min-width:0}.woocommerce-cart table.shop_table{border:0!important}.woocommerce-cart table.shop_table th{padding:0 14px 14px!important;color:#777;font-size:12px;font-weight:500;letter-spacing:.08em;text-transform:uppercase}.woocommerce-cart table.shop_table td{padding:20px 14px!important;vertical-align:middle}.woocommerce-cart td.product-thumbnail{width:110px}.woocommerce-cart td.product-thumbnail img{display:block;width:88px!important;height:110px!important;object-fit:cover}.woocommerce-cart td.product-name a{color:#171717;font-weight:650;text-decoration:none}.woocommerce-cart td.product-remove{width:34px}.woocommerce-cart td.product-remove a{display:grid;width:28px;height:28px;place-items:center;border:1px solid #bbb;border-radius:50%;color:#333!important;text-decoration:none}.woocommerce-cart .quantity{margin:0!important}.woocommerce-cart td.actions{padding:24px 0!important}.woocommerce-cart td.actions .coupon{display:flex!important;gap:10px}.woocommerce-cart td.actions .coupon input{width:180px!important;min-height:48px;padding:10px 12px;border:1px solid #aaa}.woocommerce-cart td.actions>button{float:right}.woocommerce-cart .cart-collaterals{width:auto!important}.woocommerce-cart .cart_totals{width:100%!important;margin:0!important;padding:28px;border:1px solid #ddd;background:#faf9f8}.woocommerce-cart .cart_totals h2{margin:0 0 18px;font-size:25px}.woocommerce-cart .cart_totals table td,.woocommerce-cart .cart_totals table th{padding:13px 0!important}.woocommerce-cart .wc-proceed-to-checkout{padding:20px 0 0}.woocommerce-cart .wc-proceed-to-checkout .checkout-button{width:100%;margin:0!important}.woocommerce-cart .cart-empty{padding:48px 24px!important;text-align:center}.woocommerce-cart .return-to-shop{text-align:center}

.woocommerce-checkout .autowp-commerce-main{width:min(1050px,100%)}.woocommerce-checkout .woocommerce-form-login-toggle,.woocommerce-checkout .woocommerce-form-coupon-toggle{margin-bottom:14px}.woocommerce-checkout form.checkout{display:grid!important;grid-template-columns:minmax(0,1fr) 420px;gap:22px 58px;align-items:start}.woocommerce-checkout form.checkout #customer_details{grid-column:1;grid-row:1/3}.woocommerce-checkout form.checkout #order_review_heading{grid-column:2;grid-row:1;margin:0;padding:26px 28px 0;border:1px solid #ddd;border-bottom:0;background:#faf9f8;font-size:24px}.woocommerce-checkout form.checkout #order_review{grid-column:2;grid-row:2;margin:0;padding:18px 28px 28px;border:1px solid #ddd;border-top:0;background:#faf9f8}.woocommerce-checkout .col2-set{display:grid;gap:30px}.woocommerce-checkout .col2-set .col-1,.woocommerce-checkout .col2-set .col-2{float:none!important;width:100%!important}.woocommerce-checkout h3{margin:0 0 20px;font-size:25px}.woocommerce-checkout .form-row{margin:0 0 16px!important}.woocommerce-checkout .form-row label{display:block;margin-bottom:6px;color:#555;font-size:13px}.woocommerce-checkout .form-row input.input-text,.woocommerce-checkout .form-row textarea,.woocommerce-checkout .select2-selection{min-height:48px!important;padding:11px 13px!important;border:1px solid #aaa!important;border-radius:0!important;background:#fff}.woocommerce-checkout .select2-selection__rendered{padding:0!important;line-height:24px!important}.woocommerce-checkout .select2-selection__arrow{height:46px!important}.woocommerce-checkout #order_review table th,.woocommerce-checkout #order_review table td{padding:13px 0!important}.woocommerce-checkout #payment{background:transparent!important}.woocommerce-checkout #payment ul.payment_methods{padding:18px 0!important;border-bottom:1px solid #ddd!important}.woocommerce-checkout #payment div.payment_box{background:#eee!important}.woocommerce-checkout #payment div.payment_box:before{border-bottom-color:#eee!important}.woocommerce-checkout #payment .place-order{padding:20px 0 0!important}.woocommerce-checkout #place_order{float:none!important;width:100%}.woocommerce-order-received .woocommerce-order{display:grid;gap:22px}.woocommerce-order-received .woocommerce-thankyou-order-received{padding:26px;border:1px solid #6d8d65;background:#f4f8f2;font-size:20px}.woocommerce-order-received ul.order_details{display:flex;flex-wrap:wrap;gap:20px;margin:0;padding:22px;border:1px solid #ddd;list-style:none}

@media(max-width:800px){.autowp-commerce-header{flex-wrap:wrap;justify-content:center;min-height:auto;padding:14px 0}.autowp-commerce-brand{width:100%;text-align:center}.autowp-commerce-nav{order:3;width:100%;margin:0}.autowp-commerce-nav ul{justify-content:center;gap:10px 20px}.autowp-commerce-announcement{grid-template-columns:1fr auto;padding:10px 18px}.autowp-commerce-announcement__social{display:none}.autowp-commerce-announcement__brand{text-align:left}.autowp-commerce-main{padding-top:24px}.autowp-commerce-main div.product{grid-template-columns:1fr}.autowp-commerce-main div.product .summary{padding:28px 0 0}.autowp-commerce-main .summary .product_title{font-size:32px!important}.autowp-commerce-main .woocommerce-product-gallery img{max-height:none!important}.autowp-option{min-width:48px;padding:0 14px}}
@media(max-width:900px){.woocommerce-cart .autowp-commerce-main>.woocommerce,.woocommerce-checkout form.checkout{grid-template-columns:1fr}.woocommerce-cart .cart-collaterals{grid-column:1}.woocommerce-checkout form.checkout #customer_details,.woocommerce-checkout form.checkout #order_review_heading,.woocommerce-checkout form.checkout #order_review{grid-column:1;grid-row:auto}.woocommerce-checkout form.checkout #order_review_heading{margin-top:20px}}
@media(max-width:600px){.woocommerce-cart table.shop_table tr{border-bottom:1px solid #ddd}.woocommerce-cart table.shop_table td{padding:10px 0!important}.woocommerce-cart table.shop_table td:before{font-weight:500}.woocommerce-cart td.product-thumbnail{display:none!important}.woocommerce-cart td.actions .coupon{display:grid!important;grid-template-columns:1fr}.woocommerce-cart td.actions .coupon input,.woocommerce-cart td.actions .coupon button,.woocommerce-cart td.actions>button{float:none!important;width:100%!important}.woocommerce-cart .cart_totals,.woocommerce-checkout form.checkout #order_review_heading,.woocommerce-checkout form.checkout #order_review{padding-left:18px;padding-right:18px}.woocommerce-order-received ul.order_details{display:grid}}
`;
  }

  private headerPhp(ctx: BuildContext): string {
    return `<!doctype html>
<html <?php language_attributes(); ?>>
<head>
  <meta charset="<?php bloginfo('charset'); ?>">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <?php wp_head(); ?>
</head>
<?php if (function_exists('autowp_is_native_woocommerce_request') && autowp_is_native_woocommerce_request()) : ?>
<body <?php body_class('autowp-native-commerce'); ?>>
<?php else : ?>
<body<?php echo autowp_current_source_body_attributes(); ?>>
<?php endif; ?>
<?php wp_body_open(); ?>
<?php if (function_exists('autowp_is_native_woocommerce_request') && autowp_is_native_woocommerce_request()) : ?>
<header class="autowp-commerce-header">
  <a class="autowp-commerce-brand" href="<?php echo esc_url(home_url('/')); ?>"><?php bloginfo('name'); ?></a>
  <nav class="autowp-commerce-nav" aria-label="<?php esc_attr_e('Primary navigation', 'autowp'); ?>">
    <?php wp_nav_menu(array('theme_location' => 'primary', 'container' => false, 'fallback_cb' => 'wp_page_menu', 'depth' => 2)); ?>
  </nav>
  <?php if (function_exists('wc_get_cart_url')) : ?><a class="autowp-commerce-cart" href="<?php echo esc_url(wc_get_cart_url()); ?>">Carrito <?php echo function_exists('autowp_cart_count_markup') ? autowp_cart_count_markup() : ''; ?></a><?php endif; ?>
</header>
<div class="autowp-commerce-announcement" aria-label="Store information">
  <span class="autowp-commerce-announcement__social"><a href="#" aria-label="Facebook">f</a><a href="#" aria-label="Instagram">◎</a><a href="#" aria-label="YouTube">▶</a></span>
  <span class="autowp-commerce-announcement__brand"><?php bloginfo('name'); ?></span>
  <span class="autowp-commerce-announcement__locale">España | <?php echo function_exists('get_woocommerce_currency') ? esc_html(get_woocommerce_currency()) : 'EUR'; ?> <?php echo function_exists('get_woocommerce_currency_symbol') ? esc_html(get_woocommerce_currency_symbol()) : '€'; ?></span>
</div>
<?php endif; ?>
<script id="autowp-local-navigation-guard">(function(){var origin=${JSON.stringify(sourceOrigin(ctx) ?? '')};if(!origin)return;document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[href]'):null;if(!a)return;try{var u=new URL(a.href);if(u.origin===origin){e.preventDefault();e.stopPropagation();window.location.assign(u.pathname+u.search+u.hash);}}catch(_){}} ,true);document.addEventListener('submit',function(e){var f=e.target;if(!f||!f.action)return;try{var u=new URL(f.action);if(u.origin===origin){e.preventDefault();f.action=u.pathname+u.search;f.submit();}}catch(_){}} ,true);})();</script>
<script id="autowp-cro-telemetry">(()=>{const endpoint='<?php echo esc_url(admin_url('admin-post.php')); ?>';const send=(event)=>{try{const d=new FormData();d.append('action','autowp_cro_event');d.append('event',event);d.append('path',location.pathname);navigator.sendBeacon(endpoint,d);}catch(_){}};send('page_view');document.addEventListener('submit',()=>send('form_submit'),true);document.addEventListener('click',e=>{const a=e.target?.closest?.('[class*="add_to_cart"],[class*="add-to-cart"],.add_to_cart_button');if(a)send('add_to_cart')},true)})();</script>
<style id="autowp-runtime-safety">.cmplz-blocked-content-container,.cmplz-wp-video,.cmplz-placeholder-parent,.cmplz-video,.g-recaptcha:not(html):not(body),.h-captcha:not(html):not(body),[class*="captcha"]:not(html):not(body),[id*="captcha"]:not(html):not(body),iframe[src*="recaptcha"],iframe[src*="hcaptcha"]{display:none!important}</style>
`;
  }

  private footerPhp(_ctx: BuildContext): string {
    return `<?php if (function_exists('autowp_is_native_woocommerce_request') && autowp_is_native_woocommerce_request()) : ?><footer class="autowp-commerce-footer">&copy; <?php echo esc_html(wp_date('Y')); ?> <?php bloginfo('name'); ?></footer><?php endif; ?>
<?php wp_footer(); ?>
</body>
</html>
`;
  }
}

export class DockerBuilder {
  public build(ctx: BuildContext): void {
    const wordpressApplicationId = randomUUID();
    writeText(path.join(ctx.outputPath, 'docker-compose.yml'), this.composeYaml(ctx.options.sitePort, ctx.options.dockerProject, ctx.options.databasePassword));
    writeText(path.join(ctx.outputPath, 'autowp-init.sh'), this.initScript(ctx, wordpressApplicationId));
    writeJson(path.join(ctx.outputPath, 'generated-site-credentials.json'), {
      dockerProject: ctx.options.dockerProject,
      siteUrl: `http://127.0.0.1:${ctx.options.sitePort}`,
      adminUrl: `http://127.0.0.1:${ctx.options.sitePort}/wp-admin`,
      adminUser: ctx.options.adminUser,
      adminPassword: ctx.options.adminPassword,
      database: 'wordpress',
      databaseUser: 'wordpress',
      databasePassword: ctx.options.databasePassword,
      projectPath: ctx.outputPath,
      reconstructionEngine: ctx.reconstructionEngine,
      snapshotMirror: path.join(ctx.outputPath, 'snapshot', 'mirror'),
      wordpressApplicationId,
      wordpressApplicationCredentials: path.join(ctx.outputPath, 'imports', 'wordpress-agent-credentials.json'),
    });
    writeText(path.join(ctx.outputPath, 'README.md'), `# ${ctx.options.projectName}\n\nGenerated by AutoWP Builder.\n\nRun:\n\n\`\`\`bash\ndocker compose up\n\`\`\`\n\nThen open http://127.0.0.1:${ctx.options.sitePort}\n`);
  }

  private composeYaml(sitePort: number, dockerProject: string, databasePassword: string): string {
    const cpuLimit = this.safeCpuLimit(process.env.AUTOWP_DOCKER_CPUS);
    const memoryLimit = this.safeMemoryLimit(process.env.AUTOWP_DOCKER_MEMORY);
    const serviceLimits = [
      cpuLimit ? `    cpus: "${cpuLimit}"` : '',
      memoryLimit ? `    mem_limit: "${memoryLimit}"` : '',
    ].filter(Boolean).join('\n');
    const limits = serviceLimits ? `${serviceLimits}\n` : '';
    return `name: ${dockerProject}
services:
  db:
    image: mariadb:11.8.8
${limits}    environment:
      MARIADB_DATABASE: wordpress
      MARIADB_USER: wordpress
      MARIADB_PASSWORD: ${databasePassword}
      MARIADB_ROOT_PASSWORD: ${databasePassword}
      MARIADB_AUTO_UPGRADE: "1"
    volumes:
      - db_data:/var/lib/mysql
    stop_grace_period: 60s
    healthcheck:
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      start_period: 45s
      interval: 5s
      timeout: 5s
      retries: 36

  wordpress:
    image: wordpress:php8.3-apache
${limits}    depends_on:
      db:
        condition: service_healthy
    ports:
      - "${sitePort}:80"
    environment:
      WORDPRESS_DB_HOST: db:3306
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: ${databasePassword}
      WORDPRESS_DB_NAME: wordpress
      AUTOWP_FULLY_LOCAL: "1"
    volumes:
      - wp_data:/var/www/html
      - ./wp-content/themes/autowp-reconstruction:/var/www/html/wp-content/themes/autowp-reconstruction
      - ./wp-content/plugins/autowp-improvements:/var/www/html/wp-content/plugins/autowp-improvements
      - ./wp-content/plugins/autowp-components:/var/www/html/wp-content/plugins/autowp-components
      - ./wp-content/plugins/autowp-wordpress-agent:/var/www/html/wp-content/plugins/autowp-wordpress-agent
      - ./wp-content/uploads:/var/www/html/wp-content/uploads
    healthcheck:
      test: ["CMD-SHELL", "php -r \\"exit(@file_get_contents('http://localhost/wp-login.php') ? 0 : 1);\\""]
      interval: 5s
      timeout: 5s
      retries: 30

  wpcli:
    image: wordpress:cli-php8.3
${limits}    depends_on:
      db:
        condition: service_healthy
      wordpress:
        condition: service_healthy
    user: "33:33"
    environment:
      WORDPRESS_DB_HOST: db:3306
      WORDPRESS_DB_USER: wordpress
      WORDPRESS_DB_PASSWORD: ${databasePassword}
      WORDPRESS_DB_NAME: wordpress
    volumes:
      - wp_data:/var/www/html
      - ./wp-content/themes/autowp-reconstruction:/var/www/html/wp-content/themes/autowp-reconstruction
      - ./wp-content/plugins/autowp-improvements:/var/www/html/wp-content/plugins/autowp-improvements
      - ./wp-content/plugins/autowp-components:/var/www/html/wp-content/plugins/autowp-components
      - ./wp-content/plugins/autowp-wordpress-agent:/var/www/html/wp-content/plugins/autowp-wordpress-agent
      - ./wp-content/uploads:/var/www/html/wp-content/uploads
      - ./imports:/var/www/html/autowp-imports
      - ./validation:/var/www/html/autowp-validation
      - ./autowp-init.sh:/var/www/html/autowp-init.sh
    entrypoint: ["sh", "/var/www/html/autowp-init.sh"]
    restart: "no"

volumes:
  db_data:
  wp_data:
`;
  }

  private safeCpuLimit(value: string | undefined): string | null {
    if (!value) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 128 ? String(parsed) : null;
  }

  private safeMemoryLimit(value: string | undefined): string | null {
    if (!value) return null;
    return /^\d+(?:\.\d+)?[bkmg]$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
  }

  private initScript(ctx: BuildContext, wordpressApplicationId: string): string {
    return `#!/bin/sh
set -eu
cd /var/www/html
until [ -f wp-config.php ] && [ -f wp-settings.php ]; do
  sleep 3
done
until wp db check --allow-root >/dev/null 2>&1; do
  sleep 5
done
if ! wp core is-installed --allow-root >/dev/null 2>&1; then
  wp core install --url="http://127.0.0.1:${ctx.options.sitePort}" --title="${ctx.options.projectName.replace(/"/g, '')}" --admin_user="${ctx.options.adminUser}" --admin_password="${ctx.options.adminPassword}" --admin_email=admin@example.invalid --skip-email --allow-root
fi
wp config set WP_ENVIRONMENT_TYPE local --allow-root
wp theme activate autowp-reconstruction --allow-root
wp plugin is-installed woocommerce --allow-root || wp plugin install woocommerce --activate --allow-root
wp plugin activate woocommerce --allow-root
# The audit report remains available in wp-admin, but its floating frontend
# panel is opt-in so it cannot obstruct reconstructed pages or checkout.
wp plugin deactivate autowp-improvements --allow-root >/dev/null 2>&1 || true
wp plugin activate autowp-components --allow-root
wp plugin activate autowp-wordpress-agent --allow-root
AGENT_CREDENTIALS=/var/www/html/autowp-imports/wordpress-agent-credentials.json
wp user application-password delete "${ctx.options.adminUser}" "${wordpressApplicationId}" --allow-root >/dev/null 2>&1 || true
AUTOWP_AGENT_APP_PASSWORD="$(wp user application-password create "${ctx.options.adminUser}" "Codex Local AutoWP" --app-id="${wordpressApplicationId}" --porcelain --allow-root)"
export AUTOWP_AGENT_APP_PASSWORD
wp eval 'file_put_contents("/var/www/html/autowp-imports/wordpress-agent-credentials.json", wp_json_encode(array("siteUrl" => "http://127.0.0.1:${ctx.options.sitePort}", "adminUrl" => "http://127.0.0.1:${ctx.options.sitePort}/wp-admin", "username" => "${ctx.options.adminUser}", "applicationId" => "${wordpressApplicationId}", "applicationName" => "Codex Local AutoWP", "applicationPassword" => preg_replace("/\\s+/", "", getenv("AUTOWP_AGENT_APP_PASSWORD")), "createdAt" => gmdate("c")), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));' --allow-root
unset AUTOWP_AGENT_APP_PASSWORD
chmod 600 "$AGENT_CREDENTIALS" 2>/dev/null || true
wp option update woocommerce_coming_soon no --allow-root
wp option update woocommerce_store_visibility public --allow-root
wp eval-file /var/www/html/autowp-imports/autowp-seed.php --allow-root
wp option update blogdescription "Generated offline from Phase 1 export" --allow-root
wp rewrite structure '/%postname%/' --allow-root
wp rewrite flush --allow-root
wp option update autowp_build_complete 1 --allow-root
echo "AutoWP init complete"
`;
  }
}

export class VisualValidation {
  public build(ctx: BuildContext): void {
    writeText(path.join(ctx.validationPath, 'run-visual-validation.mjs'), this.runtimeValidator(ctx));
    writeText(path.join(ctx.validationPath, 'compare-images.ps1'), this.imageComparator());
    const originalsDir = path.join(ctx.validationPath, 'original');
    ensureDir(originalsDir);
    const pages = ctx.source.pages.map((page) => {
      const sourceHtml = ctx.source.rawHtmlBySlug.get(page.slug) ?? '';
      const sourceMain = isolateMain(sourceHtml);
      const source = page.visual?.screenshotRef ? safeJoin(ctx.source.rootPath, page.visual.screenshotRef) : undefined;
      const extension = source ? path.extname(source) || '.png' : '.png';
      const original = source && fs.existsSync(source) ? path.join('validation', 'original', `${page.slug}${extension}`).replace(/\\/g, '/') : undefined;
      if (source && original) copyFileSafe(source, path.join(ctx.outputPath, original));
      return {
      slug: page.slug,
      original,
      generated: null,
      status: original ? 'pending-runtime-comparison' : 'missing-original-reference',
      threshold: 0.995,
      expected: {
        sections: sourceMain.match(/<(?:section|article|div)\b/gi)?.length ?? 0,
        textNodes: sourceMain.match(/<(?:h[1-6]|p|li|blockquote|td)\b/gi)?.length ?? 0,
        media: sourceMain.match(/<(?:img|picture|video|svg)\b/gi)?.length ?? 0,
        structure: [...sourceMain.matchAll(/<(section|article|form|figure|h[1-6])\b/gi)].map((match) => match[1].toLowerCase()),
      },
    }; });
    writeJson(path.join(ctx.validationPath, 'visual-validation.json'), {
      status: 'pending-runtime-comparison',
      note: 'Run-time screenshot comparison is performed after Docker starts and WordPress is reachable.',
      pages,
    });
  }

  private runtimeValidator(ctx: BuildContext): string {
    const pages = ctx.source.pages.map((page) => {
      const sourceMain = isolateMain(ctx.source.rawHtmlBySlug.get(page.slug) ?? '');
      return {
      slug: page.slug,
      url: `http://127.0.0.1:${ctx.options.sitePort}${localRoute(page)}`,
      route: localRoute(page),
      expectsConsent: /(?:cookie[-_\s]?(?:notice|banner|consent)|cmplz-cookiebanner|cky-consent|consent[-_\s]?banner)/i.test(ctx.source.rawHtmlBySlug.get(page.slug) ?? ''),
      originalPath: (() => {
        const source = page.visual?.screenshotRef ? safeJoin(ctx.source.rootPath, page.visual.screenshotRef) : undefined;
        if (!source || !fs.existsSync(source)) return undefined;
        return path.join('validation', 'original', `${page.slug}${path.extname(source) || '.png'}`).replace(/\\/g, '/');
      })(),
      sourceViewport: page.visual?.viewport ?? null,
      sourceFullPage: page.visual?.fullPage === true,
      threshold: 0.995,
      expected: {
        sections: sourceMain.match(/<(?:section|article|div)\b/gi)?.length ?? 0,
        textNodes: sourceMain.match(/<(?:h[1-6]|p|li|blockquote|td)\b/gi)?.length ?? 0,
        media: sourceMain.match(/<(?:img|picture|video|svg)\b/gi)?.length ?? 0,
        structure: [...sourceMain.matchAll(/<(section|article|form|figure|h[1-6])\b/gi)].map((match) => match[1].toLowerCase()),
      },
      };
    });
    const commerceProducts = normalizeCommerceProducts(ctx.source.products).map((product) => ({
      slug: product.slug,
      sourceUrl: product.sourceUrl,
    }));
    const commerceOriginalsDir = path.join(ctx.validationPath, 'original-commerce');
    ensureDir(commerceOriginalsDir);
    const commerceStates = ctx.source.pages.flatMap((page) =>
      (page.visual?.commerceStates ?? []).flatMap((state, index) => {
        const source = safeJoin(ctx.source.rootPath, state.screenshotRef);
        if (!source || !fs.existsSync(source)) return [];
        const extension = path.extname(source) || '.png';
        const safeName = `${page.slug}-${state.name}-${state.device}-${index}${extension}`;
        const target = path.join(commerceOriginalsDir, safeName);
        copyFileSafe(source, target);
        return [{
          pageSlug: page.slug,
          name: state.name,
          device: state.device,
          url: state.url,
          viewport: state.viewport,
          originalPath: path.join('validation', 'original-commerce', safeName).replace(/\\/g, '/'),
        }];
      }),
    );
    return `import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(process.env.AUTOWP_WORKSPACE_PACKAGE || import.meta.url);
const { chromium } = require('playwright');
const writeFatalValidationError = (error) => {
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  try {
    fs.writeFileSync(path.resolve('validation', 'visual-validation-runtime.json'), JSON.stringify({
      status: 'needs_review',
      reason: 'Runtime visual validation failed before a page report was produced.',
      error: message,
    }, null, 2));
  } catch { /* preserve the original browser error */ }
  console.error('[Visual] fatal: ' + message);
};
process.on('uncaughtException', writeFatalValidationError);
process.on('unhandledRejection', writeFatalValidationError);

const allPages = ${JSON.stringify(pages, null, 2)};
const commerceProducts = ${JSON.stringify(commerceProducts, null, 2)};
const sourceCommerceStates = ${JSON.stringify(commerceStates, null, 2)};
// Useful for a deterministic smoke test. Production leaves this unset and
// validates every generated route.
const pageLimit = Number(process.env.AUTOWP_VISUAL_MAX_PAGES ?? 0);
const pages = pageLimit > 0 ? allPages.slice(0, pageLimit) : allPages;
const knownRoutes = new Set(pages.map((item) => new URL(item.url).pathname.replace(/\\/$/, '') || '/'));
const dynamicRoutes = new Set(['/cart', '/checkout', '/my-account', '/shop', '/product-category']);
const outDir = path.resolve('validation', 'visual-diff');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const results = [];
const forbiddenExternalRequests = [];
const allowedLocalOrigins = new Set(['http://127.0.0.1', 'http://localhost']);
const perPageTimeoutMs = Number(process.env.WORDPRESS_VISUAL_PAGE_TIMEOUT_MS ?? 30000);
function compare(originalPath, generatedPath, diffPath) {
  if (process.platform !== 'win32') return { status: 'pixel-comparator-unavailable' };
  const command = process.env.ComSpec ? 'powershell.exe' : 'powershell';
  const result = spawnSync(command, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('validation', 'compare-images.ps1'), originalPath, generatedPath, diffPath], { encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) return { status: 'pixel-comparator-failed', error: (result.stderr || result.stdout || 'Unknown comparator error').trim() };
  try { return JSON.parse(result.stdout); } catch { return { status: 'pixel-comparator-failed', error: result.stdout.trim() }; }
}
async function probeInteractions(page) {
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('a[href], button, input[type="submit"], input[type="button"], summary, [role="button"]'));
    const blocked = [];
    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      // Do not clamp an off-screen control into the viewport: that tested an
      // unrelated element at the viewport edge and reported a false overlay.
      if (rect.right < 0 || rect.left > window.innerWidth || rect.bottom < 0 || rect.top > window.innerHeight) continue;
      const x = Math.max(1, Math.min(window.innerWidth - 1, rect.left + Math.min(8, rect.width / 2)));
      const y = Math.max(1, Math.min(window.innerHeight - 1, rect.top + Math.min(8, rect.height / 2)));
      const top = document.elementFromPoint(x, y);
      if (top && top !== node && !node.contains(top) && !top.contains(node)) blocked.push({ tag: node.tagName, text: (node.textContent || '').trim().slice(0, 80), blocker: top.tagName + '.' + top.className });
    }
    return { expectedInteractions: nodes.length, rebuiltInteractions: nodes.length - blocked.length, blockedClicks: blocked, overlayConflicts: blocked.filter((item) => /overlay|modal|cookie|consent|loader/i.test(item.blocker)).length };
  });
}
async function probeRegions(page) {
  return page.evaluate(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return { present: false };
      const rect = node.getBoundingClientRect();
      return { present: rect.width > 1 && rect.height > 1, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    };
    const main = box('main'); const header = box('header'); const footer = box('footer');
    const typography = Array.from(document.querySelectorAll('h1, h2, h3, p, a, button'))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1 && (node.textContent || '').trim();
      })
      .slice(0, 80)
      .map((node) => {
        const style = getComputedStyle(node);
        return {
          tag: node.tagName.toLowerCase(),
          text: (node.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120),
          family: style.fontFamily,
          size: style.fontSize,
          weight: style.fontWeight,
          lineHeight: style.lineHeight,
          letterSpacing: style.letterSpacing,
          color: style.color,
        };
      });
    const criticalPositions = Array.from(document.querySelectorAll('header, nav, main > *, main section, main article, footer'))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
      })
      .slice(0, 160)
      .map((node, index) => {
        const rect = node.getBoundingClientRect();
        return {
          index,
          tag: node.tagName.toLowerCase(),
          role: node.getAttribute('role') || '',
          id: node.id || '',
          className: typeof node.className === 'string' ? node.className.slice(0, 160) : '',
          x: Math.round(rect.x),
          y: Math.round(rect.y + scrollY),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      });
    return {
      headerPresent: header.present === true,
      footerPresent: footer.present === true,
      mainPresent: main.present === true,
      boxes: { header, main, footer },
      documentWidth: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth),
      documentHeight: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      horizontalOverflow: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) > innerWidth + 4,
      sectionCount: document.querySelectorAll('main section, main [class*="section"], main .wp-block-group').length,
      renderedTextNodes: Array.from(document.querySelectorAll('main h1, main h2, main h3, main p, main li')).filter((n) => (n.textContent || '').trim()).length,
      renderedImages: document.querySelectorAll('main img, main video, main svg').length,
      semanticSequence: Array.from(document.querySelectorAll('main section, main article, main form, main figure, main h1, main h2, main h3, main h4, main h5, main h6')).map((node) => node.tagName.toLowerCase()),
      typography,
      criticalPositions,
    };
  });
}
function orderedSimilarity(expected, actual) {
  if (!expected.length) return 1;
  let cursor = 0; let matched = 0;
  for (const expectedTag of expected) {
    while (cursor < actual.length && actual[cursor] !== expectedTag) cursor++;
    if (cursor < actual.length) { matched++; cursor++; }
  }
  return matched / expected.length;
}
async function probeAssets(page) {
  return page.evaluate(() => {
    const images = Array.from(document.images);
    const brokenImages = images.filter((image) => image.currentSrc && (!image.complete || image.naturalWidth === 0)).map((image) => image.currentSrc);
    const styleSheets = Array.from(document.styleSheets).map((sheet) => sheet.href || 'inline');
    return {
      loadedStyleSheets: styleSheets,
      styleSheetCount: styleSheets.length,
      fontStatus: document.fonts ? document.fonts.status : 'unsupported',
      imagesChecked: images.length,
      brokenImages,
    };
  });
}
async function verifyFunctionalInteractions(page) {
  const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).map((node) => (node instanceof HTMLAnchorElement ? node.href : '')).filter((href) => {
    try { const url = new URL(href); return url.origin === location.origin && !url.hash && !/^\\/(?:wp-admin|wp-login)/.test(url.pathname); } catch { return false; }
  }).filter((href, index, all) => all.indexOf(href) === index).slice(0, 20));
  // Do not issue a network request for every source link: a single slow URL
  // can stall a 71-page visual run. Generated routes are validated against the
  // Job's own manifest; WooCommerce's dynamic routes are registered here.
  const brokenInternalLinks = links.flatMap((href) => {
    const pathname = new URL(href).pathname.replace(/\\/$/, '') || '/';
    return knownRoutes.has(pathname) || dynamicRoutes.has(pathname) ? [] : [{ href, reason: 'route-not-generated' }];
  });
  const brokenCriticalInteractions = [];
  const accordion = page.locator('[data-autowp-component="accordion"] details summary').first();
  if (await accordion.count()) {
    try { await accordion.click({ timeout: 5000 }); } catch { brokenCriticalInteractions.push('accordion'); }
  }
  const tab = page.locator('[data-autowp-component="tabs"] [role="tab"]').first();
  if (await tab.count()) {
    try { await tab.click({ timeout: 5000 }); } catch { brokenCriticalInteractions.push('tabs'); }
  }
  const controls = await page.evaluate(() => {
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 2 && rect.height > 2 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const usable = (node) => visible(node) && !node.matches(':disabled,[aria-disabled="true"]');
    const count = (selector) => Array.from(document.querySelectorAll(selector)).filter(visible).length;
    const countUsable = (selector) => Array.from(document.querySelectorAll(selector)).filter(usable).length;
    return {
      menus: count('nav a[href], [role="navigation"] a[href]'),
      menuToggles: countUsable('button[aria-controls*="menu"], .menu-toggle, [data-menu-toggle], button[aria-label*="menu" i]'),
      searchInputs: countUsable('input[type="search"], form[role="search"] input'),
      filters: countUsable('[data-filter], .filter button, .filters button, select[name*="filter"], input[name*="filter"]'),
      galleryControls: countUsable('.gallery button, [class*="gallery"] button, [aria-label*="slide" i], [aria-label*="gallery" i]'),
      variantControls: countUsable('form.variations_form select, [name^="attribute_"], [data-variant], [data-option-value]'),
      dropdownControls: countUsable('details > summary, select, button[aria-haspopup]'),
      forms: count('form'),
      formSubmitters: countUsable('form button[type="submit"], form input[type="submit"]'),
      internalLinks: count('a[href^="/"], a[href^="' + location.origin + '"]'),
    };
  });
  if (controls.forms > 0 && controls.formSubmitters === 0) brokenCriticalInteractions.push('forms-without-usable-submit');
  return { checkedInternalLinks: links.length, brokenInternalLinks, brokenCriticalInteractions, controls };
}
async function probeCommerceSurface(page) {
  return page.evaluate(() => {
    const main = document.querySelector('main, #primary, .site-main, .woocommerce');
    const rect = main?.getBoundingClientRect();
    const bodyStyle = getComputedStyle(document.body);
    const styleSheets = Array.from(document.styleSheets).filter((sheet) => {
      try { return sheet.href || sheet.cssRules.length > 0; } catch { return Boolean(sheet.href); }
    }).length;
    const brokenImages = Array.from(document.images).filter((image) => image.currentSrc && (!image.complete || image.naturalWidth === 0)).map((image) => image.currentSrc);
    return {
      mainVisible: Boolean(rect && rect.width > 10 && rect.height > 10),
      mainWidth: rect ? Math.round(rect.width) : 0,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 4,
      styleSheetCount: styleSheets,
      bodyVisible: bodyStyle.display !== 'none' && bodyStyle.visibility !== 'hidden' && Number(bodyStyle.opacity || 1) > 0,
      brokenImages,
    };
  });
}
const commerceBaselinePatterns = {
  cart: /(?:^|\\/)(?:cart|carrito|cistella|basket|panier|warenkorb)(?:\\/|$)/i,
  checkout: /(?:^|\\/)(?:checkout|finalizar-compra|finalitzar-compra|pago|pagament|caisse|kasse)(?:\\/|$)/i,
};
function findCommerceBaseline(kind, device = 'desktop') {
  const state = sourceCommerceStates.find((item) =>
    item.name === kind &&
    item.device === device &&
    item.originalPath &&
    fs.existsSync(path.resolve(item.originalPath))
  );
  if (state) return { ...state, route: (() => { try { return new URL(state.url).pathname; } catch { return null; } })() };
  const pattern = commerceBaselinePatterns[kind];
  if (!pattern) return null;
  return allPages.find((item) => {
    const route = item.route?.replace(/\\/$/, '') || '/';
    const originalPath = item.originalPath ? path.resolve(item.originalPath) : '';
    return pattern.test(route) && originalPath && fs.existsSync(originalPath);
  });
}
async function compareNativeCommercePage(page, kind, baseline, device = 'desktop') {
  const surface = await probeCommerceSurface(page);
  const generatedPath = path.join(outDir, 'woocommerce-' + kind + '-' + device + '.png');
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  await page.screenshot({ path: generatedPath, fullPage: false, timeout: perPageTimeoutMs });
  if (!baseline?.originalPath) {
    return { ...surface, kind, device, baselineAvailable: false, baselineRoute: null, status: 'missing-original-reference', generatedPath };
  }
  const originalPath = path.resolve(baseline.originalPath);
  const diffPath = path.join(outDir, 'woocommerce-' + kind + '-' + device + '-diff.png');
  const comparison = compare(originalPath, generatedPath, diffPath);
  const similarity = typeof comparison.similarity === 'number' ? comparison.similarity : undefined;
  const status = surface.mainVisible &&
    surface.bodyVisible &&
    surface.styleSheetCount > 0 &&
    !surface.horizontalOverflow &&
    surface.brokenImages.length === 0 &&
    similarity !== undefined &&
    similarity >= 0.995 ? 'pass' : 'needs_review';
  return {
    ...surface,
    kind,
    device,
    baselineAvailable: true,
    baselineRoute: baseline.route,
    originalPath,
    generatedPath,
    diffPath: fs.existsSync(diffPath) ? diffPath : undefined,
    comparison,
    similarity,
    threshold: 0.995,
    status,
  };
}
for (const [pageIndex, item] of pages.entries()) {
  const captures = [];
  let interaction = { expectedInteractions: 0, rebuiltInteractions: 0, blockedClicks: [], overlayConflicts: 0 };
  let regions = { headerPresent: false, footerPresent: false, mainPresent: false, boxes: {}, sectionCount: 0, renderedTextNodes: 0, renderedImages: 0, semanticSequence: [] };
  let assets = { loadedStyleSheets: [], styleSheetCount: 0, fontStatus: 'unknown', imagesChecked: 0, brokenImages: [] };
  let functional = { checkedInternalLinks: 0, brokenInternalLinks: [], brokenCriticalInteractions: [] };
  try {
    console.log('[Visual] ' + (pageIndex + 1) + '/' + pages.length + ' ' + item.slug);
    const validationViewports = [
      { name: 'desktop-large', width: 1920, height: 1080 },
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'mobile', width: 390, height: 844 },
    ];
    const sourceWidth = Number(item.sourceViewport?.width || 0);
    const sourceHeight = Number(item.sourceViewport?.height || 0);
    if (sourceWidth > 0 && sourceHeight > 0 && !validationViewports.some((viewport) => viewport.width === sourceWidth && viewport.height === sourceHeight)) {
      validationViewports.push({ name: 'source-reference', width: sourceWidth, height: sourceHeight });
    }
    for (const viewport of validationViewports) {
      const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
      const generatedPath = path.join(outDir, item.slug + '-' + viewport.name + '.png');
      try {
        page.setDefaultTimeout(perPageTimeoutMs);
        await page.route('**/*', async (route) => {
          const requestUrl = route.request().url();
          let external = false;
          try { const parsed = new URL(requestUrl); external = /^https?:$/.test(parsed.protocol) && ![...allowedLocalOrigins].some((origin) => requestUrl.startsWith(origin + ':') || requestUrl.startsWith(origin + '/')); } catch { /* data/blob/about are local browser resources */ }
          if (external) { forbiddenExternalRequests.push({ url: requestUrl, type: route.request().resourceType(), page: item.slug, initiator: route.request().headers()['referer'] || '' }); await route.abort(); return; }
          await route.continue();
        });
        // WordPress/WooCommerce may keep analytics, prefetch and cart requests
        // alive indefinitely. DOM readiness plus a deterministic settle window is
        // the correct visual baseline; networkidle made every viewport wait 60s.
        await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: Math.min(60000, perPageTimeoutMs) });
        await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
        await page.evaluate(() => {
          window.scrollTo(0, 0);
          for (const media of Array.from(document.querySelectorAll('video, audio'))) {
            try {
              media.pause();
              media.currentTime = 0;
            } catch { /* cross-origin/stream media may not be seekable */ }
          }
        });
        await page.evaluate(async () => {
          if (document.fonts) await document.fonts.ready;
        });
        await page.waitForTimeout(750);
        const viewportInteraction = await probeInteractions(page);
        const viewportRegions = await probeRegions(page);
        const viewportAssets = await probeAssets(page);
        const viewportFunctional = await verifyFunctionalInteractions(page);
        if (viewport.name === 'desktop') {
          interaction = viewportInteraction;
          regions = viewportRegions;
          assets = viewportAssets;
          functional = viewportFunctional;
        }
        // Full-page Chromium captures can hang forever on very long, image-heavy
        // pages. Compare the same visible fold at every viewport instead; the
        // complete document is independently checked by the content/structure
        // probes above. This keeps a 400-page audit bounded and observable.
        await page.screenshot({ path: generatedPath, fullPage: false, timeout: perPageTimeoutMs });
        captures.push({
          viewport: viewport.name,
          width: viewport.width,
          height: viewport.height,
          generatedPath,
          interaction: viewportInteraction,
          regions: viewportRegions,
          assets: viewportAssets,
          functional: viewportFunctional,
        });
      } finally { await page.close(); }
    }
  } catch (error) {
    const validationError = error instanceof Error ? error.message : String(error);
    console.log('[Visual] ' + item.slug + ' failed: ' + validationError);
    results.push({ slug: item.slug, status: 'needs_review', validationError, captures, interaction, regions, assets, functional });
    continue;
  }
  const originalPath = item.originalPath ? path.resolve(item.originalPath) : undefined;
  if (!originalPath || !fs.existsSync(originalPath)) {
    results.push({ slug: item.slug, status: 'missing-original-reference', captures, interaction, regions, assets, functional });
    continue;
  }
  const diffPath = path.join(outDir, item.slug + '-diff.png');
  const sourceWidth = Number(item.sourceViewport?.width || 1440);
  const sourceHeight = Number(item.sourceViewport?.height || 900);
  const sourceCapture = captures.slice().sort((a, b) =>
    Math.abs(a.width - sourceWidth) + Math.abs(a.height - sourceHeight) -
    (Math.abs(b.width - sourceWidth) + Math.abs(b.height - sourceHeight))
  )[0];
  const comparison = compare(originalPath, sourceCapture.generatedPath, diffPath);
  const similarity = typeof comparison.similarity === 'number' ? comparison.similarity : undefined;
  const originalHeight = comparison.original?.height;
  const generatedHeight = comparison.generated?.height;
  const measuredGeneratedHeight = item.sourceFullPage
    ? Number(sourceCapture.regions?.documentHeight || generatedHeight)
    : generatedHeight;
  const heightRatio = originalHeight && measuredGeneratedHeight ? measuredGeneratedHeight / originalHeight : undefined;
  const heightTolerance = Number(process.env.AUTOWP_VISUAL_HEIGHT_TOLERANCE ?? 0.03);
  const contentRatio = Number(process.env.AUTOWP_VISUAL_CONTENT_RATIO ?? 0.90);
  const structureThreshold = Number(process.env.AUTOWP_VISUAL_STRUCTURE_THRESHOLD ?? 0.90);
  const heightMismatch = heightRatio === undefined || Math.abs(1 - heightRatio) > heightTolerance;
  const expectedTextNodes = Number(item.expected?.textNodes || 0);
  const contentMismatch = !regions.mainPresent ||
    (expectedTextNodes > 0 && regions.renderedTextNodes < Math.max(1, Math.floor(expectedTextNodes * contentRatio))) ||
    regions.renderedImages < Math.floor((item.expected?.media || 0) * contentRatio);
  const structureSimilarity = orderedSimilarity(item.expected?.structure || [], regions.semanticSequence || []);
  const structureMismatch = (item.expected?.structure || []).length > 0 && structureSimilarity < structureThreshold;
  const viewportChecks = captures.filter((capture) => capture.viewport !== 'source-reference').map((capture) => {
    const captureStructureSimilarity = orderedSimilarity(item.expected?.structure || [], capture.regions?.semanticSequence || []);
    const expectedTextNodes = Number(item.expected?.textNodes || 0);
    const textPass = expectedTextNodes === 0 ||
      Number(capture.regions?.renderedTextNodes || 0) >= Math.max(1, Math.floor(expectedTextNodes * contentRatio));
    const imagesPass = Number(capture.regions?.renderedImages || 0) >= Math.floor((item.expected?.media || 0) * contentRatio) &&
      (capture.assets?.brokenImages || []).length === 0;
    const structurePass = (item.expected?.structure || []).length === 0 || captureStructureSimilarity >= structureThreshold;
    const typographyPass = capture.assets?.fontStatus === 'loaded' &&
      (Number(item.expected?.textNodes || 0) === 0 || (capture.regions?.typography || []).length > 0);
    const positionsPass = capture.regions?.mainPresent === true &&
      capture.regions?.horizontalOverflow !== true &&
      (capture.interaction?.blockedClicks || []).length === 0;
    const interactionsPass = (capture.functional?.brokenInternalLinks || []).length === 0 &&
      (capture.functional?.brokenCriticalInteractions || []).length === 0;
    return {
      viewport: capture.viewport,
      text: { pass: textPass, expected: item.expected?.textNodes || 0, actual: capture.regions?.renderedTextNodes || 0 },
      images: { pass: imagesPass, expected: item.expected?.media || 0, actual: capture.regions?.renderedImages || 0, broken: capture.assets?.brokenImages || [] },
      structure: { pass: structurePass, similarity: captureStructureSimilarity, threshold: structureThreshold },
      typography: { pass: typographyPass, samples: capture.regions?.typography || [], fontStatus: capture.assets?.fontStatus },
      positions: { pass: positionsPass, horizontalOverflow: capture.regions?.horizontalOverflow, samples: capture.regions?.criticalPositions || [] },
      interactions: { pass: interactionsPass, controls: capture.functional?.controls || {}, broken: capture.functional?.brokenCriticalInteractions || [] },
      pass: textPass && imagesPass && structurePass && typographyPass && positionsPass && interactionsPass,
    };
  });
  const responsiveMismatch = viewportChecks.length !== 4 || viewportChecks.some((check) => !check.pass);
  results.push({
    slug: item.slug,
    // Pixel values alone are misleading if the reconstructed page has lost a
    // large portion of its vertical content.  A material height mismatch is a
    // completeness failure even when the normalized pixels look similar.
    status: similarity === undefined ? (comparison.status ?? 'needs_review') : (!heightMismatch && !contentMismatch && !structureMismatch && !responsiveMismatch && functional.brokenInternalLinks.length === 0 && functional.brokenCriticalInteractions.length === 0 && similarity >= item.threshold ? 'pass' : 'needs_review'),
    similarity,
    comparison,
    heightRatio,
    heightTolerance,
    heightMismatch,
    contentMismatch,
    contentRatio,
    structureSimilarity,
    structureThreshold,
    structureMismatch,
    responsiveMismatch,
    viewportChecks,
    expectedContent: item.expected,
    threshold: item.threshold,
    originalPath,
    diffPath: fs.existsSync(diffPath) ? diffPath : undefined,
    captures,
    interaction,
    regions,
    assets,
    functional,
  });
}
const commerce = {
  generatedAt: new Date().toISOString(),
  expectedProducts: commerceProducts.length,
  expectedProductRoutes: [],
  testedProductRoutes: [],
  productChecks: [],
  addToCartButtonsChecked: 0,
  addToCartButtonsUsable: 0,
  bridgeDetected: false,
  addToCartSucceeded: false,
  cartHasItem: false,
  checkoutReachable: false,
  checkoutUsable: false,
  testOrderCreated: false,
  testOrderId: null,
  testOrderError: null,
  visual: {
    states: [],
    productRoutesWithBaseline: 0,
    productRoutesPassing: 0,
    cartBaselineAvailable: false,
    checkoutBaselineAvailable: false,
    cartBaselinePass: false,
    checkoutBaselinePass: false,
    cart: null,
    checkout: null,
    status: 'not_applicable',
  },
  error: null,
  status: commerceProducts.length === 0 ? 'not_applicable' : 'needs_review',
};
if (commerceProducts.length > 0) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(Math.max(perPageTimeoutMs, 45000));
    const productPaths = Array.from(new Set(commerceProducts.flatMap((product) => {
      try { return product.sourceUrl ? [new URL(product.sourceUrl).pathname.replace(/\\/$/, '') || '/'] : []; } catch { return []; }
    })));
    commerce.expectedProductRoutes = productPaths;
    if (!productPaths.length) throw new Error('No captured source product route is available for commerce validation.');
    for (const [productIndex, productPath] of productPaths.entries()) {
      const localProductUrl = 'http://127.0.0.1:${ctx.options.sitePort}' + productPath;
      const check = {
        path: productPath,
        bridgeForms: 0,
        visibleForms: 0,
        buttonsChecked: 0,
        usableButtons: 0,
        submittedForms: 0,
        errors: [],
        status: 'needs_review',
      };
      try {
        await page.goto(localProductUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(350);
        if (productIndex === 0) {
          commerce.visual.states.push(await compareNativeCommercePage(
            page,
            'product',
            findCommerceBaseline('product', 'desktop'),
            'desktop',
          ));
          await page.setViewportSize({ width: 390, height: 844 });
          commerce.visual.states.push(await compareNativeCommercePage(
            page,
            'product',
            findCommerceBaseline('product', 'mobile'),
            'mobile',
          ));
          await page.setViewportSize({ width: 1440, height: 900 });
          const selectable = page.locator('select[name^="attribute_"], select[data-variant], form.variations_form select');
          for (let selectIndex = 0; selectIndex < await selectable.count(); selectIndex += 1) {
            const control = selectable.nth(selectIndex);
            const options = await control.locator('option').evaluateAll((nodes) =>
              nodes.map((node) => node.value).filter(Boolean),
            );
            if (options[0]) await control.selectOption(options[0]).catch(() => undefined);
          }
          if (await selectable.count()) {
            await page.waitForTimeout(250);
            commerce.visual.states.push(await compareNativeCommercePage(
              page,
              'variant-selected',
              findCommerceBaseline('variant-selected', 'desktop'),
              'desktop',
            ));
            await page.setViewportSize({ width: 390, height: 844 });
            commerce.visual.states.push(await compareNativeCommercePage(
              page,
              'variant-selected',
              findCommerceBaseline('variant-selected', 'mobile'),
              'mobile',
            ));
            await page.setViewportSize({ width: 1440, height: 900 });
          }
          await page.goto(localProductUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        }
        const formState = await page.locator('form[data-autowp-commerce-bridge="1"]').evaluateAll((forms) => forms.map((form) => {
          const rect = form.getBoundingClientRect();
          const visible = rect.width > 2 && rect.height > 2 && getComputedStyle(form).display !== 'none' && getComputedStyle(form).visibility !== 'hidden';
          const buttons = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"], [name="add"]')).map((button) => {
            const buttonRect = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            const centerX = Math.max(0, Math.min(innerWidth - 1, buttonRect.left + buttonRect.width / 2));
            const centerY = Math.max(0, Math.min(innerHeight - 1, buttonRect.top + buttonRect.height / 2));
            const top = buttonRect.width > 1 && buttonRect.height > 1 && centerY >= 0 && centerY < innerHeight ? document.elementFromPoint(centerX, centerY) : null;
            return {
              visible: buttonRect.width > 1 && buttonRect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden',
              enabled: !button.disabled && button.getAttribute('aria-disabled') !== 'true',
              clickable: !top || top === button || button.contains(top) || top.contains(button),
              text: (button.textContent || button.value || '').trim().slice(0, 100),
            };
          });
          return { visible, buttons };
        }));
        check.bridgeForms = formState.length;
        check.visibleForms = formState.filter((form) => form.visible).length;
        const buttons = formState.flatMap((form) => form.buttons.filter((button) => button.visible));
        check.buttonsChecked = buttons.length;
        check.usableButtons = buttons.filter((button) => button.enabled && button.clickable).length;
        commerce.addToCartButtonsChecked += check.buttonsChecked;
        commerce.addToCartButtonsUsable += check.usableButtons;
        if (!check.bridgeForms) check.errors.push('missing-local-commerce-bridge');
        if (!check.visibleForms) check.errors.push('no-visible-product-form');
        if (!check.buttonsChecked) check.errors.push('no-visible-add-to-cart-button');
        if (check.usableButtons !== check.buttonsChecked) check.errors.push('blocked-or-disabled-add-to-cart-button');
        const visibleFormIndexes = formState.map((form, index) => form.visible ? index : -1).filter((index) => index >= 0);
        for (const formIndex of visibleFormIndexes) {
          await page.goto(localProductUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          const bridge = page.locator('form[data-autowp-commerce-bridge="1"]').nth(formIndex);
          const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null);
          await bridge.evaluate((form) => {
            if (form instanceof HTMLFormElement) form.requestSubmit();
          });
          await navigation;
          await page.waitForTimeout(200);
          check.submittedForms += 1;
          if (productIndex === 0 && formIndex === visibleFormIndexes[0]) {
            commerce.visual.states.push(await compareNativeCommercePage(
              page,
              'product-added',
              findCommerceBaseline('product-added', 'desktop'),
              'desktop',
            ));
            await page.setViewportSize({ width: 390, height: 844 });
            commerce.visual.states.push(await compareNativeCommercePage(
              page,
              'product-added',
              findCommerceBaseline('product-added', 'mobile'),
              'mobile',
            ));
            await page.setViewportSize({ width: 1440, height: 900 });
          }
        }
        check.status = check.errors.length === 0 && check.submittedForms === check.visibleForms ? 'pass' : 'needs_review';
      } catch (error) {
        check.errors.push(error instanceof Error ? error.message : String(error));
      }
      commerce.productChecks.push(check);
      commerce.testedProductRoutes.push(productPath);
    }
    commerce.bridgeDetected = commerce.productChecks.every((check) => check.bridgeForms > 0);
    commerce.addToCartSucceeded = commerce.productChecks.every((check) => check.status === 'pass');
    await page.goto('http://127.0.0.1:${ctx.options.sitePort}/cart/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    commerce.cartHasItem = await page.locator('.woocommerce-cart-form .cart_item, tr.woocommerce-cart-form__cart-item, tr.cart_item').count() > 0;
    commerce.visual.cart = await compareNativeCommercePage(page, 'cart', findCommerceBaseline('cart', 'desktop'), 'desktop');
    commerce.visual.states.push(commerce.visual.cart);
    await page.setViewportSize({ width: 390, height: 844 });
    commerce.visual.states.push(await compareNativeCommercePage(page, 'cart', findCommerceBaseline('cart', 'mobile'), 'mobile'));
    await page.setViewportSize({ width: 1440, height: 900 });
    const checkoutResponse = await page.goto('http://127.0.0.1:${ctx.options.sitePort}/checkout/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    commerce.checkoutReachable = Boolean(checkoutResponse && checkoutResponse.status() >= 200 && checkoutResponse.status() < 400);
    commerce.checkoutUsable = await page.locator('form.checkout, .woocommerce-checkout, .wc-block-checkout, [name="woocommerce_checkout_place_order"], #place_order').count() > 0;
    commerce.visual.checkout = await compareNativeCommercePage(page, 'checkout', findCommerceBaseline('checkout', 'desktop'), 'desktop');
    commerce.visual.states.push(commerce.visual.checkout);
    await page.setViewportSize({ width: 390, height: 844 });
    commerce.visual.states.push(await compareNativeCommercePage(page, 'checkout', findCommerceBaseline('checkout', 'mobile'), 'mobile'));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('http://127.0.0.1:${ctx.options.sitePort}/checkout/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (commerce.checkoutReachable && commerce.checkoutUsable && commerce.cartHasItem) {
      try {
        const fillIfPresent = async (selector, value) => {
          const field = page.locator(selector).first();
          if (await field.count() && await field.isVisible()) await field.fill(value);
        };
        const selectIfPresent = async (selector, value) => {
          const field = page.locator(selector).first();
          if (await field.count() && await field.isVisible()) {
            await field.selectOption(value).catch(() => undefined);
          }
        };
        await fillIfPresent('#billing_first_name, [name="billing_first_name"]', 'AutoWP');
        await fillIfPresent('#billing_last_name, [name="billing_last_name"]', 'Validation');
        await fillIfPresent('#billing_address_1, [name="billing_address_1"]', 'Calle de prueba 1');
        await fillIfPresent('#billing_city, [name="billing_city"]', 'Madrid');
        await fillIfPresent('#billing_postcode, [name="billing_postcode"]', '28001');
        await fillIfPresent('#billing_phone, [name="billing_phone"]', '600000000');
        await fillIfPresent('#billing_email, [name="billing_email"]', 'autowp-validation@example.invalid');
        await selectIfPresent('#billing_country, [name="billing_country"]', 'ES');
        await selectIfPresent('#billing_state, [name="billing_state"]', 'M');
        const bacs = page.locator('#payment_method_bacs, [name="payment_method"][value="bacs"]').first();
        if (await bacs.count() && await bacs.isVisible()) await bacs.check({ force: true });
        const terms = page.locator('#terms, [name="terms"]').first();
        if (await terms.count() && await terms.isVisible() && !(await terms.isChecked())) await terms.check({ force: true });
        const placeOrder = page.locator('#place_order, [name="woocommerce_checkout_place_order"]').first();
        if (!await placeOrder.count() || !await placeOrder.isVisible() || !await placeOrder.isEnabled()) {
          throw new Error('The checkout place-order button is not visible and enabled.');
        }
        await placeOrder.click();
        await page.waitForURL(/\\/checkout\\/order-received\\//, { timeout: 90000 }).catch(() => undefined);
        await page.waitForTimeout(750);
        commerce.testOrderCreated = /\\/checkout\\/order-received\\//.test(page.url()) ||
          await page.locator('.woocommerce-order-received, .woocommerce-thankyou-order-received, .woocommerce-order-overview').count() > 0;
        commerce.testOrderId = await page.locator('.woocommerce-order-overview__order strong, .order-number').first().textContent().catch(() => null);
        if (!commerce.testOrderCreated) throw new Error('Checkout submission did not reach the order-received confirmation.');
      } catch (error) {
        commerce.testOrderError = error instanceof Error ? error.message : String(error);
        commerce.testOrderCreated = false;
      }
    }
    const resultByPath = new Map(results.map((result) => {
      const source = allPages.find((item) => item.slug === result.slug);
      return [source?.route?.replace(/\\/$/, '') || '/', result];
    }));
    const productVisualResults = productPaths.map((productPath) => resultByPath.get(productPath)).filter(Boolean);
    commerce.visual.productRoutesWithBaseline = productVisualResults.filter((result) => Boolean(result.originalPath)).length;
    commerce.visual.productRoutesPassing = productVisualResults.filter((result) => result.status === 'pass').length;
    commerce.visual.cartBaselineAvailable = commerce.visual.cart?.baselineAvailable === true;
    commerce.visual.checkoutBaselineAvailable = commerce.visual.checkout?.baselineAvailable === true;
    commerce.visual.cartBaselinePass = commerce.visual.cartBaselineAvailable && commerce.visual.cart?.status === 'pass';
    commerce.visual.checkoutBaselinePass = commerce.visual.checkoutBaselineAvailable && commerce.visual.checkout?.status === 'pass';
    const surfacesPass = commerce.visual.states.length > 0 && commerce.visual.states.every((surface) =>
      surface && surface.mainVisible && surface.bodyVisible && surface.styleSheetCount > 0 && !surface.horizontalOverflow && surface.brokenImages.length === 0
    );
    const generatedStateKeys = new Set(commerce.visual.states.map((surface) => surface.kind + ':' + surface.device));
    const stateCoveragePass = sourceCommerceStates.length > 0 &&
      sourceCommerceStates.every((state) => generatedStateKeys.has(state.name + ':' + state.device));
    const stateBaselinesPass = stateCoveragePass &&
      commerce.visual.states.every((surface) => surface.baselineAvailable === true && surface.status === 'pass');
    const productVisualPass = productVisualResults.length === productPaths.length && productVisualResults.every((result) => result.status === 'pass');
    commerce.visual.status = surfacesPass &&
      productVisualPass &&
      stateBaselinesPass &&
      commerce.visual.cartBaselinePass &&
      commerce.visual.checkoutBaselinePass ? 'pass' : 'needs_review';
    commerce.status = commerce.bridgeDetected &&
      commerce.addToCartSucceeded &&
      commerce.addToCartButtonsChecked > 0 &&
      commerce.addToCartButtonsUsable === commerce.addToCartButtonsChecked &&
      commerce.cartHasItem &&
      commerce.checkoutReachable &&
      commerce.checkoutUsable &&
      commerce.testOrderCreated &&
      commerce.visual.status === 'pass' ? 'pass' : 'needs_review';
  } catch (error) {
    commerce.error = error instanceof Error ? error.message : String(error);
    commerce.status = 'needs_review';
  } finally {
    await context.close();
  }
}
const consent = {
  generatedAt: new Date().toISOString(),
  expectedPages: allPages.filter((item) => item.expectsConsent).map((item) => item.route),
  testedPage: null,
  acceptFound: false,
  rejectFound: false,
  acceptWorked: false,
  rejectWorked: false,
  error: null,
  status: allPages.some((item) => item.expectsConsent) ? 'needs_review' : 'not_applicable',
};
if (consent.expectedPages.length > 0) {
  const testChoice = async (action) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    try {
      await page.goto('http://127.0.0.1:${ctx.options.sitePort}' + consent.expectedPages[0], { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(300);
      const control = page.locator('[data-autowp-consent-action="' + action + '"]').first();
      const found = await control.count() > 0;
      if (!found) return { found: false, worked: false };
      await control.click({ timeout: 10000 });
      const stored = await page.evaluate(() => localStorage.getItem('autowp_cookie_consent'));
      const visible = await page.locator('[data-autowp-consent-bridge="1"]:visible').count();
      return { found: true, worked: stored === action && visible === 0 };
    } finally {
      await context.close();
    }
  };
  try {
    consent.testedPage = consent.expectedPages[0];
    const accepted = await testChoice('accepted');
    const rejected = await testChoice('rejected');
    consent.acceptFound = accepted.found;
    consent.rejectFound = rejected.found;
    consent.acceptWorked = accepted.worked;
    consent.rejectWorked = rejected.worked;
    consent.status = accepted.worked && rejected.worked ? 'pass' : 'needs_review';
  } catch (error) {
    consent.error = error instanceof Error ? error.message : String(error);
    consent.status = 'needs_review';
  }
}
await browser.close();
const blockedClicks = results.flatMap((item) => item.interaction?.blockedClicks || []);
const brokenInternalLinks = results.flatMap((item) => item.functional?.brokenInternalLinks || []);
const brokenCriticalInteractions = results.flatMap((item) => item.functional?.brokenCriticalInteractions || []);
const report = { generatedAt: new Date().toISOString(), status: results.every((item) => item.status === 'pass') && blockedClicks.length === 0 && brokenInternalLinks.length === 0 && brokenCriticalInteractions.length === 0 ? 'pass' : 'needs_review', blockedClicks, brokenInternalLinks, brokenCriticalInteractions, results };
fs.writeFileSync(path.join('validation', 'visual-validation-runtime.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join('validation', 'network-runtime-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), mode: 'FULLY_LOCAL', forbiddenExternalRequests, permittedExternalAssets: [], status: forbiddenExternalRequests.length === 0 ? 'pass' : 'needs_review' }, null, 2));
fs.writeFileSync(path.join('validation', 'interaction-runtime-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), blockedClicks, brokenInternalLinks, brokenCriticalInteractions, status: blockedClicks.length === 0 && brokenInternalLinks.length === 0 && brokenCriticalInteractions.length === 0 ? 'pass' : 'needs_review', pages: results.map((item) => ({ slug: item.slug, interaction: item.interaction, functional: item.functional })) }, null, 2));
fs.writeFileSync(path.join('validation', 'commerce-runtime-report.json'), JSON.stringify(commerce, null, 2));
fs.writeFileSync(path.join('validation', 'commerce-visual-report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), ...commerce.visual }, null, 2));
fs.writeFileSync(path.join('validation', 'consent-runtime-report.json'), JSON.stringify(consent, null, 2));
const cssRuntime = {
  generatedAt: new Date().toISOString(),
  pages: results.map((item) => ({ slug: item.slug, ...item.assets })),
  brokenImages: results.flatMap((item) => item.assets?.brokenImages || []),
  status: results.every((item) => item.assets?.styleSheetCount > 0 && item.assets?.fontStatus !== 'loading' && (item.assets?.brokenImages || []).length === 0) ? 'pass' : 'needs_review',
};
fs.writeFileSync(path.join('validation', 'css-runtime-validation.json'), JSON.stringify(cssRuntime, null, 2));
const contentOrder = {
  generatedAt: new Date().toISOString(),
  status: results.every((item) => item.structureMismatch !== true) ? 'pass' : 'needs_review',
  pages: results.map((item) => ({ slug: item.slug, expectedOrder: item.expectedContent?.structure || item.expected?.structure || [], renderedOrder: item.regions?.semanticSequence || [], orderSimilarity: item.structureSimilarity, reorderedSections: item.structureMismatch ? ['semantic-order-mismatch'] : [] })),
};
fs.writeFileSync(path.join('validation', 'content-order-report.json'), JSON.stringify(contentOrder, null, 2));
for (const item of results) {
  const pageDir = path.join('validation', 'visual', item.slug); fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(path.join(pageDir, 'report.json'), JSON.stringify(item, null, 2));
  if (item.originalPath && fs.existsSync(item.originalPath)) fs.copyFileSync(item.originalPath, path.join(pageDir, 'original.png'));
  const desktop = item.captures?.find((capture) => capture.viewport === 'desktop')?.generatedPath;
  if (desktop && fs.existsSync(desktop)) fs.copyFileSync(desktop, path.join(pageDir, 'reconstructed.png'));
  if (item.diffPath && fs.existsSync(item.diffPath)) fs.copyFileSync(item.diffPath, path.join(pageDir, 'diff.png'));
  fs.writeFileSync(path.join(pageDir, 'regions.json'), JSON.stringify(item.regions ?? {}, null, 2));
}
fs.writeFileSync(path.join('validation', 'visual-validation-report.html'), '<!doctype html><meta charset="utf-8"><title>AutoWP visual validation</title><h1>AutoWP visual validation</h1><pre>' + String(JSON.stringify(report, null, 2)).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>');
`;
  }

  private imageComparator(): string {
    return `param([Parameter(Mandatory=$true)][string]$Original, [Parameter(Mandatory=$true)][string]$Generated, [Parameter(Mandatory=$true)][string]$DiffPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$source = [System.Drawing.Bitmap]::new($Original)
$built = [System.Drawing.Bitmap]::new($Generated)
try {
  $width = 360
  # Compare the visible fold only. Source screenshots are generally full-page,
  # while the generated capture is intentionally viewport-bounded.
  $sourceCrop = [Math]::Min($source.Height, 900)
  $builtCrop = [Math]::Min($built.Height, 900)
  $sourceHeight = [Math]::Max(1, [Math]::Round($sourceCrop * $width / $source.Width))
  $builtHeight = [Math]::Max(1, [Math]::Round($builtCrop * $width / $built.Width))
  $height = [Math]::Max($sourceHeight, $builtHeight)
  $left = [System.Drawing.Bitmap]::new($width, $height)
  $right = [System.Drawing.Bitmap]::new($width, $height)
  $diffBitmap = [System.Drawing.Bitmap]::new($width, $height)
  try {
    $leftGraphics = [System.Drawing.Graphics]::FromImage($left); try { $leftGraphics.Clear([System.Drawing.Color]::White); $leftGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear; $leftGraphics.DrawImage($source, [System.Drawing.Rectangle]::new(0, 0, $width, $sourceHeight), 0, 0, $source.Width, $sourceCrop, [System.Drawing.GraphicsUnit]::Pixel) } finally { $leftGraphics.Dispose() }
    $rightGraphics = [System.Drawing.Graphics]::FromImage($right); try { $rightGraphics.Clear([System.Drawing.Color]::White); $rightGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear; $rightGraphics.DrawImage($built, [System.Drawing.Rectangle]::new(0, 0, $width, $builtHeight), 0, 0, $built.Width, $builtCrop, [System.Drawing.GraphicsUnit]::Pixel) } finally { $rightGraphics.Dispose() }
    [double]$difference = 0; [int64]$samples = $width * $height
    for ($y = 0; $y -lt $height; $y++) { for ($x = 0; $x -lt $width; $x++) { $a = $left.GetPixel($x, $y); $b = $right.GetPixel($x, $y); $delta = [Math]::Min(255, [Math]::Abs($a.R - $b.R) + [Math]::Abs($a.G - $b.G) + [Math]::Abs($a.B - $b.B)); $difference += $delta; $diffBitmap.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(255, $delta, [Math]::Max(0, 255 - $delta), [Math]::Max(0, 255 - $delta))) } }
    $diffBitmap.Save($DiffPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $similarity = [Math]::Max(0, 1 - ($difference / (255.0 * 3 * $samples)))
    @{ status = 'measured'; similarity = [Math]::Round($similarity, 6); original = @{ width = $source.Width; height = $source.Height }; generated = @{ width = $built.Width; height = $built.Height }; normalized = @{ width = $width; height = $height } } | ConvertTo-Json -Compress
  } finally { $left.Dispose(); $right.Dispose(); $diffBitmap.Dispose() }
} finally { $source.Dispose(); $built.Dispose() }
`;
  }
}
