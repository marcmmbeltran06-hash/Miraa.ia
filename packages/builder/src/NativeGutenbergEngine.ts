import { parseHTML } from 'linkedom';

export interface NativeGutenbergResult {
  content: string;
  blockCount: number;
  sectionCount: number;
  warnings: string[];
}

type DomNode = {
  nodeType?: number;
  nodeName?: string;
  tagName?: string;
  textContent?: string | null;
  childNodes?: ArrayLike<DomNode>;
  children?: ArrayLike<DomNode>;
  getAttribute?: (name: string) => string | null;
  remove?: () => void;
};

const VOID_OR_UNSAFE = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'canvas']);
const CONTAINER_TAGS = new Set(['body', 'main', 'section', 'article', 'header', 'footer', 'aside', 'div']);

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function text(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function attr(node: DomNode, name: string): string {
  return node.getAttribute?.(name)?.trim() ?? '';
}

function children(node: DomNode): DomNode[] {
  return Array.from(node.childNodes ?? []);
}

function elementChildren(node: DomNode): DomNode[] {
  return children(node).filter((child) => child.nodeType === 1);
}

function tag(node: DomNode): string {
  return (node.tagName ?? node.nodeName ?? '').toLowerCase();
}

function json(value: Record<string, unknown>): string {
  return Object.keys(value).length > 0 ? ` ${JSON.stringify(value)}` : '';
}

function block(name: string, attributes: Record<string, unknown>, html: string): string {
  return `<!-- wp:${name}${json(attributes)} -->${html}<!-- /wp:${name} -->`;
}

function selfClosingBlock(name: string, attributes: Record<string, unknown>): string {
  return `<!-- wp:${name}${json(attributes)} /-->`;
}

function safeUrl(value: string, fallback = ''): string {
  const normalized = value.trim();
  if (!normalized) return fallback;
  if (/^(?:javascript|vbscript|data:text\/html):/i.test(normalized)) return fallback;
  return normalized;
}

function safeInlineMarkup(node: DomNode): string {
  const render = (current: DomNode): string => {
    if (current.nodeType === 3) return escapeHtml(current.textContent ?? '');
    const name = tag(current);
    const content = children(current).map(render).join('');
    if (name === 'br') return '<br>';
    if (name === 'strong' || name === 'b') return `<strong>${content}</strong>`;
    if (name === 'em' || name === 'i') return `<em>${content}</em>`;
    if (name === 'code') return `<code>${content}</code>`;
    if (name === 'sup' || name === 'sub' || name === 's') return `<${name}>${content}</${name}>`;
    if (name === 'a') {
      const href = safeUrl(attr(current, 'href'), '#');
      return `<a href="${escapeHtml(href)}">${content}</a>`;
    }
    return content;
  };
  return children(node).map(render).join('').trim();
}

function meaningful(node: DomNode): boolean {
  if (node.nodeType === 3) return Boolean(text(node.textContent));
  const name = tag(node);
  return !VOID_OR_UNSAFE.has(name) && (Boolean(text(node.textContent)) || ['img', 'picture', 'video', 'form', 'nav', 'hr'].includes(name));
}

function heading(node: DomNode): string {
  const level = Math.min(6, Math.max(1, Number(tag(node).slice(1)) || 2));
  const value = safeInlineMarkup(node) || escapeHtml(text(node.textContent));
  return block('heading', { level }, `<h${level} class="wp-block-heading">${value}</h${level}>`);
}

function paragraph(node: DomNode): string {
  const value = safeInlineMarkup(node) || escapeHtml(text(node.textContent));
  return value ? block('paragraph', {}, `<p>${value}</p>`) : '';
}

function image(node: DomNode): string {
  const sourceNode = tag(node) === 'img' ? node : elementChildren(node).find((child) => tag(child) === 'img');
  if (!sourceNode) return '';
  const src = safeUrl(attr(sourceNode, 'src') || attr(sourceNode, 'data-src'));
  if (!src) return '';
  const alt = attr(sourceNode, 'alt');
  return block('image', { sizeSlug: 'full', linkDestination: 'none' }, `<figure class="wp-block-image size-full"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"/></figure>`);
}

function button(node: DomNode): string {
  const href = safeUrl(attr(node, 'href'), '#');
  const label = escapeHtml(text(node.textContent) || attr(node, 'aria-label') || 'Continuar');
  const inner = block('button', { url: href }, `<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="${escapeHtml(href)}">${label}</a></div>`);
  return block('buttons', {}, `<div class="wp-block-buttons">${inner}</div>`);
}

function navigation(node: DomNode): string {
  const links: string[] = [];
  const walk = (current: DomNode): void => {
    if (tag(current) === 'a') {
      const label = text(current.textContent);
      const url = safeUrl(attr(current, 'href'));
      if (label && url && !links.some((entry) => entry.includes(`"url":"${url.replace(/"/g, '\\"')}"`))) {
        links.push(selfClosingBlock('navigation-link', { label, url, kind: 'custom' }));
      }
    }
    children(current).forEach(walk);
  };
  walk(node);
  if (links.length === 0) return '';
  return block('navigation', { overlayMenu: 'mobile', layout: { type: 'flex', justifyContent: 'space-between' } }, `<nav class="is-responsive wp-block-navigation">${links.join('')}</nav>`);
}

function list(node: DomNode): string {
  const ordered = tag(node) === 'ol';
  const items = elementChildren(node)
    .filter((child) => tag(child) === 'li')
    .map((child) => `<li>${safeInlineMarkup(child) || escapeHtml(text(child.textContent))}</li>`)
    .join('');
  if (!items) return '';
  const listTag = ordered ? 'ol' : 'ul';
  return block('list', ordered ? { ordered: true } : {}, `<${listTag}>${items}</${listTag}>`);
}

function isButtonLike(node: DomNode): boolean {
  if (tag(node) === 'button') return true;
  const classes = attr(node, 'class');
  return tag(node) === 'a' && /(?:button|btn|cta|wp-element-button)/i.test(`${classes} ${attr(node, 'role')}`);
}

function hasColumnsSignal(node: DomNode, directChildren: DomNode[]): boolean {
  if (directChildren.length < 2 || directChildren.length > 6) return false;
  const signal = `${attr(node, 'class')} ${attr(node, 'role')}`;
  return /(?:columns?|cols?|grid|row|cards?|features?|services?|products?|gallery|team)/i.test(signal)
    || directChildren.every((child) => /(?:col|card|item|product|feature|service)/i.test(attr(child, 'class')));
}

function convert(node: DomNode, depth: number, warnings: string[]): string {
  if (depth > 18) {
    warnings.push('A deeply nested source container was flattened to keep Gutenberg stable.');
    const value = text(node.textContent);
    return value ? block('paragraph', {}, `<p>${escapeHtml(value)}</p>`) : '';
  }
  if (node.nodeType === 3) {
    const value = text(node.textContent);
    return value ? block('paragraph', {}, `<p>${escapeHtml(value)}</p>`) : '';
  }

  const name = tag(node);
  if (VOID_OR_UNSAFE.has(name)) return '';
  if (/^h[1-6]$/.test(name)) return heading(node);
  if (name === 'p' || name === 'figcaption' || name === 'label') return paragraph(node);
  if (name === 'img' || name === 'picture') return image(node);
  if (isButtonLike(node)) return button(node);
  if (name === 'nav') return navigation(node);
  if (name === 'ul' || name === 'ol') return list(node);
  if (name === 'blockquote') {
    const value = safeInlineMarkup(node) || escapeHtml(text(node.textContent));
    return value ? block('quote', {}, `<blockquote class="wp-block-quote"><p>${value}</p></blockquote>`) : '';
  }
  if (name === 'hr') return selfClosingBlock('separator', {});
  if (name === 'video') {
    const src = safeUrl(attr(node, 'src'));
    return src ? block('video', {}, `<figure class="wp-block-video"><video controls src="${escapeHtml(src)}"></video></figure>`) : '';
  }
  if (name === 'table') {
    const rows = elementChildren(node).flatMap((part) => tag(part) === 'tr' ? [part] : elementChildren(part).filter((row) => tag(row) === 'tr'));
    const html = rows.map((row) => `<tr>${elementChildren(row).filter((cell) => ['th', 'td'].includes(tag(cell))).map((cell) => `<${tag(cell)}>${escapeHtml(text(cell.textContent))}</${tag(cell)}>`).join('')}</tr>`).join('');
    return html ? block('table', {}, `<figure class="wp-block-table"><table><tbody>${html}</tbody></table></figure>`) : '';
  }

  const direct = elementChildren(node).filter(meaningful);
  if (hasColumnsSignal(node, direct)) {
    const columns = direct.map((child) => {
      const content = convert(child, depth + 1, warnings);
      return content ? block('column', {}, `<div class="wp-block-column">${content}</div>`) : '';
    }).filter(Boolean);
    if (columns.length >= 2) return block('columns', {}, `<div class="wp-block-columns">${columns.join('')}</div>`);
  }

  const converted = children(node).filter(meaningful).map((child) => convert(child, depth + 1, warnings)).filter(Boolean).join('\n');
  if (!converted) {
    const value = text(node.textContent);
    return value ? block('paragraph', {}, `<p>${escapeHtml(value)}</p>`) : '';
  }
  if (!CONTAINER_TAGS.has(name) && name !== 'form' && name !== 'figure') return converted;
  const semanticClass = name === 'header' ? 'autowp-header' : name === 'footer' ? 'autowp-footer' : name === 'form' ? 'autowp-form' : 'autowp-section';
  return block('group', { className: semanticClass, layout: { type: 'constrained' } }, `<div class="wp-block-group ${semanticClass}">${converted}</div>`);
}

/**
 * Converts rendered, localized source markup to atomic native Gutenberg blocks.
 * Source scripts, inline handlers and inline styles are never serialized.
 */
export function buildNativeGutenberg(html: string): NativeGutenbergResult {
  const warnings: string[] = [];
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  document.querySelectorAll('script,style,noscript,template,iframe,object,embed,canvas').forEach((node) => node.remove());
  document.querySelectorAll('*').forEach((node) => {
    Array.from(node.attributes).forEach((attribute) => {
      if (/^on/i.test(attribute.name) || attribute.name.toLowerCase() === 'style') node.removeAttribute(attribute.name);
    });
  });
  // Process every region supplied by the caller. The builder normally passes
  // an isolated <main>, while standalone conversions may also include native
  // header/navigation/footer regions.
  const root = document.body as unknown as DomNode;
  const parts = children(root).filter(meaningful).map((node) => convert(node, 0, warnings)).filter(Boolean);
  const content = parts.join('\n');
  return {
    content,
    blockCount: (content.match(/<!-- wp:/g) ?? []).length,
    sectionCount: parts.length,
    warnings: [...new Set(warnings)],
  };
}
