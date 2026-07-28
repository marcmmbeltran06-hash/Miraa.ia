import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutoWPBuilder } from '../src/AutoWPBuilder.js';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

function makePhase1Export(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autowp-phase1-'));
  fs.mkdirSync(path.join(root, 'wordpress', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'model', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'raw', 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true });
  fs.mkdirSync(path.join(root, 'visual', 'pages'), { recursive: true });

  writeJson(path.join(root, 'manifest.json'), { jobId: 'test', totalPages: 1, totalProducts: 1 });
  writeJson(path.join(root, 'reconstruction-manifest.json'), {
    purpose: 'offline-wordpress-woocommerce-reconstruction',
    sufficiencyStatus: 'pending-builder-validation',
    pages: [
      {
        slug: 'home',
        sourceUrl: 'https://example.com',
        finalUrl: 'https://example.com',
        model: 'model/pages/home.json',
        html: 'raw/pages/home.html',
        screenshot: 'visual/pages/home.png',
      },
    ],
  });
  writeJson(path.join(root, 'wordpress', 'index.json'), {
    artifactName: 'wordpress-project',
    modelKind: 'canonical-site-model',
    globalStyles: {
      colors: ['#111111', '#ffffff'],
      fonts: ['Inter, sans-serif'],
      cssVariables: { '--brand': '#111111' },
    },
    navigation: [
      { id: 'primary', name: 'Primary', position: 'primary', items: [{ label: 'Home', href: '/', children: [] }] },
      { id: 'pagination', name: 'Paginación', position: 'primary', items: [{ label: '2', href: '/shop?page=2', children: [] }] },
    ],
  });
  writeJson(path.join(root, 'model', 'pages', 'home.json'), {
    slug: 'home',
    title: 'Home',
    metaDescription: 'Home meta description',
    canonical: 'https://example.com',
    headings: { h1: ['Hero Title'], h2: [], h3: [] },
    htmlRef: '../../raw/pages/home.html',
    visual: { screenshotRef: '../../visual/pages/home.png', viewport: { width: 1280, height: 720 }, fullPage: true },
    layout: [
      { id: 'hero', type: 'hero', order: 0, columns: 1, blocks: [{ id: 'h1', type: 'heading', text: 'Hero Title' }] },
    ],
    components: [{ id: 'component:hero', type: 'section', settings: { classes: 'hero' } }],
  });
  fs.writeFileSync(path.join(root, 'raw', 'pages', 'home.html'), '<html><body><section class="hero"><h1>Hero Title</h1></section></body></html>', 'utf-8');
  fs.writeFileSync(path.join(root, 'visual', 'pages', 'home.png'), 'png', 'utf-8');
  writeJson(path.join(root, 'resources', 'manifest.json'), { downloaded: [], referencedButNotDownloaded: [] });
  writeJson(path.join(root, 'products.json'), [
    {
      sku: 'SKU-1',
      slug: 'sample-product',
      name: 'Sample Product',
      price: '10',
      categories: ['Catalog'],
      tags: ['sample'],
      variants: [],
    },
  ]);
  fs.writeFileSync(path.join(root, 'woocommerce-products.csv'), '"Type","SKU","Name"\n"simple","SKU-1","Sample Product"', 'utf-8');
  return root;
}

describe('AutoWPBuilder', () => {
  it('builds a runnable WordPress project from a Phase 1 export directory', async () => {
    const inputPath = makePhase1Export();
    const outputPath = fs.mkdtempSync(path.join(os.tmpdir(), 'autowp-build-'));
    fs.rmSync(outputPath, { recursive: true, force: true });

    const result = await new AutoWPBuilder().build({
      inputPath,
      outputPath,
      projectName: 'Test Reconstruction',
    });

    expect(result.pagesBuilt).toBe(1);
    expect(result.productsBuilt).toBe(1);
    expect(fs.existsSync(path.join(outputPath, 'docker-compose.yml'))).toBe(true);
    const compose = fs.readFileSync(path.join(outputPath, 'docker-compose.yml'), 'utf-8');
    expect(compose).toContain('image: mariadb:11.8.8');
    expect(compose).toContain('healthcheck.sh');
    expect(compose).toContain('--innodb_initialized');
    expect(compose).toContain('condition: service_healthy');
    expect(compose).toContain('stop_grace_period: 60s');
    expect(fs.existsSync(path.join(outputPath, 'wp-content', 'themes', 'autowp-reconstruction', 'functions.php'))).toBe(true);
    expect(fs.existsSync(path.join(outputPath, 'wp-content', 'themes', 'autowp-reconstruction', 'woocommerce.php'))).toBe(true);
    expect(fs.existsSync(path.join(outputPath, 'wp-content', 'themes', 'autowp-reconstruction', 'assets', 'commerce.css'))).toBe(true);
    expect(fs.existsSync(path.join(outputPath, 'wp-content', 'themes', 'autowp-reconstruction', 'templates', 'home.html'))).toBe(true);
    expect(fs.existsSync(path.join(outputPath, 'imports', 'woocommerce-products.csv'))).toBe(true);
    expect(fs.existsSync(path.join(outputPath, 'imports', 'seo-map.json'))).toBe(true);
    expect(fs.existsSync(path.join(outputPath, 'imports', 'editable-pages.json'))).toBe(true);
    expect(fs.existsSync(path.join(outputPath, 'validation', 'gutenberg-conversion-report.json'))).toBe(true);
    expect(fs.existsSync(path.join(outputPath, 'validation', 'visual-validation.json'))).toBe(true);
    const initScript = fs.readFileSync(path.join(outputPath, 'autowp-init.sh'), 'utf-8');
    expect(initScript).toContain('wp config set WP_ENVIRONMENT_TYPE local --allow-root');
    expect(initScript).toContain('wp user application-password create');
    expect(initScript).toContain('wordpress-agent-credentials.json');
    expect(initScript).toContain('wp plugin deactivate autowp-improvements');
    expect(initScript).not.toContain('applicationPassword":');
    const credentials = JSON.parse(fs.readFileSync(path.join(outputPath, 'generated-site-credentials.json'), 'utf-8')) as { wordpressApplicationId: string; wordpressApplicationCredentials: string };
    expect(credentials.wordpressApplicationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(credentials.wordpressApplicationCredentials).toContain('wordpress-agent-credentials.json');

    const template = fs.readFileSync(path.join(outputPath, 'wp-content', 'themes', 'autowp-reconstruction', 'templates', 'home.html'), 'utf-8');
    expect(template).toContain('Hero Title');
    const editablePages = JSON.parse(fs.readFileSync(path.join(outputPath, 'imports', 'editable-pages.json'), 'utf-8')) as Record<string, { content: string; blockCount: number; strategy: string }>;
    expect(editablePages.home.content).toContain('wp:group');
    expect(editablePages.home.content).toContain('wp:heading');
    expect(editablePages.home.content).not.toContain('wp:autowp/component');
    expect(editablePages.home.strategy).toBe('native_gutenberg');
    expect(editablePages.home.blockCount).toBeGreaterThan(1);
    const gutenbergReport = JSON.parse(fs.readFileSync(path.join(outputPath, 'validation', 'gutenberg-conversion-report.json'), 'utf-8')) as { totals: { pageSizedHtmlFallbacks: number; blocks: number } };
    expect(gutenbergReport.totals.pageSizedHtmlFallbacks).toBe(0);
    expect(gutenbergReport.totals.blocks).toBeGreaterThan(1);
    const seedScript = fs.readFileSync(path.join(outputPath, 'imports', 'autowp-seed.php'), 'utf-8');
    expect(seedScript).toContain('editable-blocks-report.json');
    expect(seedScript).toContain("'allPagesEditable' => $editable_pass");
    expect(seedScript).toContain("'_autowp_has_editable_blocks', '1'");
    expect(seedScript).toContain("'_autowp_render_strategy', 'source_fidelity'");
    expect(seedScript).toContain("update_option('woocommerce_enable_guest_checkout', 'yes')");
    expect(seedScript).toContain("add_shipping_method('free_shipping')");
    expect(seedScript).toContain("'paymentMethodReady' => $payment_method_ready");
    expect(seedScript).toContain("'shippingMethodReady' => $shipping_method_ready");
    expect(seedScript).not.toContain("update_post_meta($postarr['ID'], '_autowp_use_editable_blocks', '1')");
    const functionsPhp = fs.readFileSync(path.join(outputPath, 'wp-content', 'themes', 'autowp-reconstruction', 'functions.php'), 'utf-8');
    expect(functionsPhp).toContain("wp_enqueue_style('autowp-commerce'");
    expect(functionsPhp).toContain("if (autowp_is_native_woocommerce_request())");
    expect(functionsPhp).toContain("if (autowp_source_commerce_config()) return false");
    expect(functionsPhp).toContain("wp_ajax_nopriv_autowp_add_to_cart");
    expect(functionsPhp).toContain("WC()->cart->add_to_cart");
    expect(functionsPhp).toContain(`$body = preg_replace("~((?:href|action)=[\\"'])" . $quoted_origin`);
    // The presentation-tag extractor must consume the closing angle bracket.
    // Otherwise a moved stylesheet link leaves its CSS as visible page text.
    expect(functionsPhp).toContain('(?:stylesheet|preload|modulepreload)[^>]*>|style\\b');
    expect(functionsPhp).toContain('autowp_visual_annotate_html');
    expect(functionsPhp).toContain("'_autowp_render_strategy', true) === 'native_blocks_approved'");
    expect(functionsPhp).toContain("get_option('autowp_global_blocks_approved', '0') === '1'");
    expect(functionsPhp).toContain('autowp-commerce-cart-count');
    expect(functionsPhp).toContain("woocommerce_add_to_cart_fragments");
    const headerPhp = fs.readFileSync(path.join(outputPath, 'wp-content', 'themes', 'autowp-reconstruction', 'header.php'), 'utf-8');
    expect(headerPhp).toContain("body_class('autowp-native-commerce')");
    expect(headerPhp).toContain('autowp_cart_count_markup');
    const commerceCss = fs.readFileSync(path.join(outputPath, 'wp-content', 'themes', 'autowp-reconstruction', 'assets', 'commerce.css'), 'utf-8');
    const commerceJs = fs.readFileSync(path.join(outputPath, 'wp-content', 'themes', 'autowp-reconstruction', 'assets', 'commerce.js'), 'utf-8');
    expect(commerceCss).toContain('.woocommerce-cart .cart_totals');
    expect(commerceCss).toContain('.woocommerce-checkout form.checkout');
    expect(commerceCss).toContain('@media(max-width:600px)');
    expect(commerceJs).toContain('.woocommerce-cart-form .quantity');
    expect(commerceJs).toContain("button[name=\"update_cart\"]");
    const sourceCommerceJs = fs.readFileSync(path.join(outputPath, 'wp-content', 'themes', 'autowp-reconstruction', 'assets', 'source-commerce.js'), 'utf-8');
    expect(sourceCommerceJs).toContain("fetch(config.ajaxUrl");
    expect(sourceCommerceJs).toContain("data.set('action', 'autowp_add_to_cart')");
    expect(sourceCommerceJs).not.toContain('post.submit()');
    const menus = JSON.parse(fs.readFileSync(path.join(outputPath, 'imports', 'menus.json'), 'utf-8')) as Array<{ id: string }>;
    expect(menus.map((menu) => menu.id)).toContain('primary');
    expect(menus.map((menu) => menu.id)).not.toContain('pagination');
    const visualPlugin = fs.readFileSync(path.join(outputPath, 'wp-content', 'plugins', 'autowp-components', 'autowp-components.php'), 'utf-8');
    const visualEditor = fs.readFileSync(path.join(outputPath, 'wp-content', 'plugins', 'autowp-components', 'visual-editor.js'), 'utf-8');
    expect(visualPlugin).toContain("register_rest_route('autowp/v1', '/visual/save'");
    expect(visualPlugin).toContain('function autowp_visual_annotate_html');
    expect(visualPlugin).toContain("'preserveRoot' => array('type' => 'boolean'");
    expect(visualPlugin).toContain("if (!empty($attributes['preserveRoot'])");
    expect(visualPlugin).toContain("array('replace_text','set_link','replace_image','set_alt','set_style','remove_style','hide','show','duplicate','remove','move_up','move_down','insert_block')");
    expect(visualPlugin).toContain("preg_match('/<\\s*script|javascript:|on[a-z]+\\s*=/i'");
    expect(visualEditor).toContain('AutoWP Visual Editor');
    expect(visualEditor).toContain('window.grapesjs.init');
    expect(visualEditor).toContain("addOperation(anchor, 'insert_block'");
    expect(visualEditor).toContain("request('rollback/' + revisionId");
    expect(fs.existsSync(path.join(outputPath, 'wp-content', 'plugins', 'autowp-components', 'grapes.min.js'))).toBe(true);
    expect(fs.existsSync(path.join(outputPath, 'wp-content', 'plugins', 'autowp-components', 'grapes.min.css'))).toBe(true);
    expect(fs.existsSync(path.join(outputPath, 'wp-content', 'plugins', 'autowp-components', 'GRAPESJS-LICENSE'))).toBe(true);
    expect(fs.existsSync(path.join(outputPath, 'wp-content', 'plugins', 'autowp-components', 'visual-editor.css'))).toBe(true);
    const themeCss = fs.readFileSync(path.join(outputPath, 'wp-content', 'themes', 'autowp-reconstruction', 'style.css'), 'utf-8');
    const interactionsJs = fs.readFileSync(path.join(outputPath, 'wp-content', 'themes', 'autowp-reconstruction', 'assets', 'interactions.js'), 'utf-8');
    expect(themeCss).not.toContain('[class*="cmplz"]');
    expect(themeCss).not.toContain('[id^="cmplz"]');
    expect(interactionsJs).toContain('node === document.documentElement || node === document.body');
    expect(interactionsJs).not.toContain('[class*="cmplz"]');
    expect(interactionsJs).not.toContain('[id^="cmplz"]');
    expect(interactionsJs).toContain('[class*="shopify-pc__banner"]');
    expect(interactionsJs).toContain('autowpConsentAction');
    const runtimeValidator = fs.readFileSync(path.join(outputPath, 'validation', 'run-visual-validation.mjs'), 'utf-8');
    expect(runtimeValidator).toContain('commerce-visual-report.json');
    expect(runtimeValidator).toContain('cartBaselinePass');
    expect(runtimeValidator).toContain('checkoutBaselinePass');
    expect(runtimeValidator).toContain('compareNativeCommercePage');
    expect(runtimeValidator).toContain("findCommerceBaseline('cart', 'desktop')");
    expect(runtimeValidator).toContain("findCommerceBaseline('cart', 'mobile')");
    expect(runtimeValidator).toContain("findCommerceBaseline('checkout', 'desktop')");
    expect(runtimeValidator).toContain("findCommerceBaseline('checkout', 'mobile')");
    expect(runtimeValidator).toContain('addToCartButtonsUsable');
    expect(runtimeValidator).toContain('checkoutUsable');
    expect(runtimeValidator).toContain('consent-runtime-report.json');
    expect(seedScript).toContain("'visualEditorAvailable' => function_exists('autowp_visual_save')");
    expect(seedScript).toContain("'expectedPageCount' => $expected_editable_pages");
    expect(seedScript).toContain('<!-- wp:shortcode -->[woocommerce_cart]<!-- /wp:shortcode -->');
    expect(seedScript).toContain('<!-- wp:shortcode -->[woocommerce_checkout]<!-- /wp:shortcode -->');
    const report = JSON.parse(fs.readFileSync(result.reportPath, 'utf-8')) as { status: string; componentDecisions: unknown[] };
    expect(report.status).toBe('needs_review');
    expect(report.componentDecisions.length).toBeGreaterThan(0);
    const builderProgress = JSON.parse(fs.readFileSync(path.join(outputPath, 'validation', 'builder-progress.json'), 'utf-8')) as { status: string; percent: number };
    expect(builderProgress).toMatchObject({ status: 'completed', percent: 100 });
    const contentValidation = JSON.parse(fs.readFileSync(path.join(outputPath, 'validation', 'content-validation.json'), 'utf-8')) as { importedTextBlocks: unknown; importedComponents: unknown; status: string };
    expect(contentValidation.importedTextBlocks).toBeNull();
    expect(contentValidation.importedComponents).toBeNull();
    expect(contentValidation.status).toBe('runtime-validation-required');
    const improvementsReport = JSON.parse(fs.readFileSync(path.join(outputPath, 'validation', 'improvements-report.json'), 'utf-8')) as { status: string };
    expect(improvementsReport.status).toBe('pending_runtime');
  });

  it('keeps each localized page DOM complete without duplicating global shells', async () => {
    const inputPath = makePhase1Export();
    const reconstructionPath = path.join(inputPath, 'reconstruction-manifest.json');
    const reconstruction = JSON.parse(fs.readFileSync(reconstructionPath, 'utf-8')) as { pages: Array<Record<string, unknown>> };
    const localizedPages = [
      { slug: 'ca', url: 'https://example.com/ca', locale: 'ca', navigation: 'Col·lecció', content: 'Costura a mida' },
      { slug: 'en', url: 'https://example.com/en', locale: 'en-US', navigation: 'Collection', content: 'Custom tailoring' },
    ];
    for (const page of localizedPages) {
      reconstruction.pages.push({ slug: page.slug, sourceUrl: page.url, finalUrl: page.url, model: `model/pages/${page.slug}.json`, html: `raw/pages/${page.slug}.html`, screenshot: `visual/pages/${page.slug}.png` });
      writeJson(path.join(inputPath, 'model', 'pages', `${page.slug}.json`), { slug: page.slug, sourceUrl: page.url, finalUrl: page.url, title: page.content, htmlRef: `../../raw/pages/${page.slug}.html` });
      fs.writeFileSync(path.join(inputPath, 'raw', 'pages', `${page.slug}.html`), `<html lang="${page.locale}"><body><header><nav>${page.navigation}</nav></header><main><h1>${page.content}</h1></main><footer>${page.navigation} footer</footer></body></html>`, 'utf-8');
      fs.writeFileSync(path.join(inputPath, 'visual', 'pages', `${page.slug}.png`), 'png', 'utf-8');
    }
    fs.writeFileSync(path.join(inputPath, 'raw', 'pages', 'home.html'), '<html lang="es-ES"><body><header><nav>Colección</nav></header><main><h1>Costura a medida</h1></main><footer>Colección footer</footer></body></html>', 'utf-8');
    writeJson(reconstructionPath, reconstruction);
    writeJson(path.join(inputPath, 'manifest.json'), { jobId: 'test', totalPages: 3, totalProducts: 1 });

    const outputPath = fs.mkdtempSync(path.join(os.tmpdir(), 'autowp-locales-'));
    fs.rmSync(outputPath, { recursive: true, force: true });
    await new AutoWPBuilder().build({ inputPath, outputPath, projectName: 'Localized Reconstruction' });

    const theme = path.join(outputPath, 'wp-content', 'themes', 'autowp-reconstruction');
    expect(fs.readFileSync(path.join(theme, 'parts', 'header-es.html'), 'utf-8')).toContain('Colección');
    expect(fs.readFileSync(path.join(theme, 'parts', 'header-ca.html'), 'utf-8')).toContain('Col·lecció');
    expect(fs.readFileSync(path.join(theme, 'parts', 'header-en.html'), 'utf-8')).toContain('Collection');
    expect(fs.readFileSync(path.join(theme, 'parts', 'footer-en.html'), 'utf-8')).toContain('Collection footer');
    const functionsPhp = fs.readFileSync(path.join(theme, 'functions.php'), 'utf-8');
    expect(functionsPhp).toContain("'locale' => 'es'");
    expect(functionsPhp).toContain("'headerPart' => 'parts/header-ca.html'");
    expect(functionsPhp).toContain("'footerPart' => 'parts/footer-en.html'");
    expect(functionsPhp).toContain('function autowp_render_source_global_part');
    expect(functionsPhp).toContain("ltrim($relative, '/\\\\')");
    const capturedCa = fs.readFileSync(path.join(theme, 'templates', 'ca.html'), 'utf-8');
    const capturedEn = fs.readFileSync(path.join(theme, 'templates', 'en.html'), 'utf-8');
    expect(capturedCa).toMatch(/<header><nav>[^<]+<\/nav><\/header>/);
    expect(capturedCa).toMatch(/<footer>[^<]+ footer<\/footer>/);
    expect(capturedEn).toContain('<header><nav>Collection</nav></header>');
    expect(capturedEn).toContain('<footer>Collection footer</footer>');
    expect(fs.readFileSync(path.join(theme, 'header.php'), 'utf-8')).not.toContain("autowp_render_source_global_part('header')");
    expect(fs.readFileSync(path.join(theme, 'footer.php'), 'utf-8')).not.toContain("autowp_render_source_global_part('footer')");
  });
});
