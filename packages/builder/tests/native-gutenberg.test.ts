import { describe, expect, it } from 'vitest';
import { buildNativeGutenberg } from '../src/NativeGutenbergEngine.js';

describe('buildNativeGutenberg', () => {
  it('segments a rendered ecommerce page into atomic native blocks', () => {
    const result = buildNativeGutenberg(`
      <main style="width:1200px" onclick="alert(1)">
        <section class="hero"><h1>Nueva colecciÃ³n</h1><p>DiseÃ±ada para durar.</p><a class="cta button" href="/tienda">Comprar ahora</a></section>
        <section class="product-grid grid">
          <article class="product-card"><img src="/media/uno.jpg" alt="Vestido Uno"><h2>Vestido Uno</h2><p>120 â‚¬</p></article>
          <article class="product-card"><img src="/media/dos.jpg" alt="Vestido Dos"><h2>Vestido Dos</h2><p>140 â‚¬</p></article>
        </section>
        <script>window.location='https://unsafe.example'</script>
      </main>`);

    expect(result.content).toContain('wp:group');
    expect(result.content).toContain('wp:heading');
    expect(result.content).toContain('wp:paragraph');
    expect(result.content).toContain('wp:buttons');
    expect(result.content).toContain('wp:columns');
    expect(result.content).toContain('wp:image');
    expect(result.content).not.toContain('wp:html');
    expect(result.content).not.toContain('wp:autowp/component');
    expect(result.content).not.toContain('onclick');
    expect(result.content).not.toContain('<script');
    expect(result.content).not.toContain('width:1200px');
    expect(result.blockCount).toBeGreaterThan(10);
  });

  it('creates native responsive navigation and rejects dangerous URLs', () => {
    const result = buildNativeGutenberg(`
      <header><nav><a href="/">Inicio</a><a href="/tienda">Tienda</a><a href="javascript:alert(1)">Malicioso</a></nav></header>
      <main><h1>Inicio</h1></main>`);

    expect(result.content).toContain('wp:navigation');
    expect(result.content).toContain('wp:navigation-link');
    expect(result.content).toContain('"overlayMenu":"mobile"');
    expect(result.content).not.toContain('javascript:');
  });
});
