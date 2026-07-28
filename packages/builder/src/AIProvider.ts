export type AutoWPOperation =
  | 'create_page_from_html' | 'update_page_from_html' | 'append_html_to_page'
  | 'prepend_html_to_page' | 'replace_component' | 'insert_component_before'
  | 'insert_component_after' | 'create_template_from_html'
  | 'create_product_from_html' | 'create_products_from_html'
  | 'update_product_from_html' | 'create_variable_product' | 'import_media'
  | 'import_styles' | 'import_script' | 'create_menu' | 'update_menu';

export interface AgentActionPlan {
  operation: AutoWPOperation;
  targetId?: number;
  title?: string;
  slug?: string;
  html?: string;
  css?: string[];
  scripts?: string[];
  media?: string[];
  menuName?: string;
  menuItems?: Array<{ label: string; url: string }>;
  status?: 'draft' | 'publish';
  warnings: string[];
}

export interface AIProviderContext {
  instruction: string;
  html: string;
  allowedOperations: AutoWPOperation[];
  target?: { id: number; type: 'page' | 'product' };
}

/** Providers must return structured actions only; they never receive shell or filesystem access. */
export interface AIProvider {
  plan(context: AIProviderContext): Promise<AgentActionPlan>;
}

export class LocalRuleAIProvider implements AIProvider {
  async plan(context: AIProviderContext): Promise<AgentActionPlan> {
    const text = context.instruction.toLocaleLowerCase();
    const operation: AutoWPOperation = /producto.*variable|variable.*producto/.test(text)
      ? 'create_variable_product'
      : /productos|fichas/.test(text) ? 'create_products_from_html'
        : /producto/.test(text) ? 'create_product_from_html'
          : /sustitu|reemplaz|actualiz/.test(text) ? 'update_page_from_html'
            : /a[ñn]ad|append|secci[oó]n/.test(text) ? 'append_html_to_page'
              : 'create_page_from_html';
    return { operation, targetId: context.target?.id, html: context.html, status: 'draft', warnings: [] };
  }
}
