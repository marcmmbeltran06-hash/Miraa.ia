import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildApp } from '../src/ApiServer';
import { buildWordPressProjectFiles, collectResourceUrls, restoreDeploymentArtifactsFromReconstruction, runAllExports, toWooCommerceCsv } from '../src/ExportService';
import { DefaultSeoAnalyzer } from '@autowp/seo-analyzer';
import type { CrawlJobService, CrawlJobSummary } from '../src/types';

function makeService(overrides: Partial<CrawlJobService> = {}): CrawlJobService {
  return {
    submit: vi.fn(async () => 'job-abc'),
    getStatus: vi.fn(async (): Promise<CrawlJobSummary | undefined> => ({
      jobId: 'job-abc',
      url: 'https://example.com',
      status: 'running',
      pagesVisited: 4,
      pagesPending: 2,
      errors: [],
      progress: 40,
      seoScore: undefined,
    })),
    cancel: vi.fn(async () => true),
    buildWordPress: vi.fn(async () => true),
    pauseWordPressBuild: vi.fn(async () => true),
    resumeWordPressBuild: vi.fn(async () => true),
    cancelWordPressBuild: vi.fn(async () => true),
    restartSite: vi.fn(async () => true),
    rerunValidation: vi.fn(async () => true),
    stopSite: vi.fn(async () => true),
    ...overrides,
  };
}

describe('GET /health', () => {
  const app = buildApp(makeService());
  afterAll(() => app.close());

  it('returns { status: "ok" }', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('responds to CORS preflight requests', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/crawl',
      headers: {
        origin: 'http://127.0.0.1:5174',
        'access-control-request-method': 'POST',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5174');
  });
});

describe('campaign launcher API', () => {
  const app = buildApp(makeService());
  afterAll(() => app.close());

  it('rejects a non-Excel upload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/campaign/excel?limit=2000',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('not an xlsx file'),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/Excel/);
  });

  it('reports an unknown campaign without starting work', async () => {
    const res = await app.inject({ method: 'GET', url: '/campaign/00000000-0000-4000-8000-000000000000' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('not_found');
  });
});

describe('resource closure discovery', () => {
  it('collects responsive, lazy, poster and inline CSS resources', () => {
    const report = new DefaultSeoAnalyzer().analyze({
      entryUrl: 'https://example.com/shop/',
      pages: [{
        url: 'https://example.com/shop/',
        finalUrl: 'https://example.com/shop/',
        statusCode: 200,
        depth: 0,
        html: `<html><head><link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="https://fonts.example.test/css?family=Brand"></head><body>
          <picture><source srcset="/media/hero-small.webp 480w, /media/hero-large.webp 1280w"></picture>
          <img data-src="/media/lazy.jpg" data-srcset="/media/lazy-2x.jpg 2x" />
          <video poster="/media/poster.jpg"></video>
          <section style="background-image:url('/media/background.png')"></section>
        </body></html>`,
      }],
    });

    expect(collectResourceUrls(report)).toEqual(expect.arrayContaining([
      'https://example.com/assets/site.css',
      'https://fonts.example.test/css?family=Brand',
      'https://example.com/media/hero-small.webp',
      'https://example.com/media/hero-large.webp',
      'https://example.com/media/lazy.jpg',
      'https://example.com/media/lazy-2x.jpg',
      'https://example.com/media/poster.jpg',
      'https://example.com/media/background.png',
    ]));
  });
});

describe('POST /crawl', () => {
  const app = buildApp(makeService());
  afterAll(() => app.close());

  it('returns 202 with jobId for valid URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/crawl',
      payload: { url: 'https://example.com' },
    });
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).jobId).toBe('job-abc');
  });

  it('returns 400 for invalid URL string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/crawl',
      payload: { url: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when url field is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/crawl',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for ftp:// scheme', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/crawl',
      payload: { url: 'ftp://files.example.com' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /crawl/:jobId', () => {
  it('returns job summary when found', async () => {
    const app = buildApp(makeService());
    afterAll(() => app.close());

    const res = await app.inject({ method: 'GET', url: '/crawl/job-abc' });
    await app.close();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as CrawlJobSummary;
    expect(body.status).toBe('running');
    expect(body.pagesVisited).toBe(4);
  });

  it('returns 404 when job not found', async () => {
    const app = buildApp(makeService({
      getStatus: vi.fn(async () => undefined),
    }));
    const res = await app.inject({ method: 'GET', url: '/crawl/unknown-id' });
    await app.close();
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/no encontrado/i);
  });
});

describe('standalone report batches and transparent sharing', () => {
  it('submits every URL in report-only mode', async () => {
    const submit = vi.fn(async () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const app = buildApp(makeService({ submit }));
    const res = await app.inject({
      method: 'POST',
      url: '/reports/batch',
      payload: { urls: ['https://one.example', 'https://two.example'] },
    });
    await app.close();
    expect(res.statusCode).toBe(202);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledWith('https://one.example', { reportOnly: true, reportMode: 'full' });
  });

  it('creates a personal viewer and records its transparent opening', async () => {
    const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const getReportArtifact = vi.fn(async () => ({
      filename: 'report.html',
      contentType: 'text/html',
      body: '<!doctype html><html><body><h1>Report</h1></body></html>',
    }));
    const app = buildApp(makeService({ getReportArtifact }));
    const created = await app.inject({
      method: 'POST',
      url: `/reports/${jobId}/share`,
      payload: { recipient: 'Cliente de prueba' },
    });
    expect(created.statusCode).toBe(201);
    const share = JSON.parse(created.body) as { token: string; url: string };
    const viewed = await app.inject({ method: 'GET', url: share.url });
    expect(viewed.statusCode).toBe(200);
    expect(viewed.body).toContain('registramos la fecha de apertura');
    const status = await app.inject({ method: 'GET', url: `/reports/${jobId}/share/${share.token}` });
    await app.close();
    expect(JSON.parse(status.body).viewCount).toBe(1);
  });
});

describe('WordPress-only API and exports', () => {
  it('cancels a running crawl', async () => {
    const app = buildApp(makeService());
    const res = await app.inject({ method: 'POST', url: '/crawl/job-abc/cancel' });
    await app.close();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it('starts the WordPress constructor explicitly when requested', async () => {
    const buildWordPress = vi.fn(async () => true);
    const app = buildApp(makeService({ buildWordPress }));
    const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const res = await app.inject({ method: 'POST', url: `/crawl/${jobId}/build-wordpress` });
    await app.close();
    expect(res.statusCode).toBe(202);
    expect(buildWordPress).toHaveBeenCalledWith(jobId);
  });

  it('pauses, resumes and cancels a resumable WordPress build', async () => {
    const pauseWordPressBuild = vi.fn(async () => true);
    const resumeWordPressBuild = vi.fn(async () => true);
    const cancelWordPressBuild = vi.fn(async () => true);
    const app = buildApp(makeService({
      pauseWordPressBuild,
      resumeWordPressBuild,
      cancelWordPressBuild,
    }));
    const jobId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    expect((await app.inject({ method: 'POST', url: `/crawl/${jobId}/pause-build` })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/crawl/${jobId}/resume-build` })).statusCode).toBe(202);
    expect((await app.inject({ method: 'POST', url: `/crawl/${jobId}/cancel-build` })).statusCode).toBe(200);
    await app.close();

    expect(pauseWordPressBuild).toHaveBeenCalledWith(jobId);
    expect(resumeWordPressBuild).toHaveBeenCalledWith(jobId);
    expect(cancelWordPressBuild).toHaveBeenCalledWith(jobId);
  });

  it('serializes the canonical site model into wordpress-project content', () => {
    const report = new DefaultSeoAnalyzer().analyze({
      entryUrl: 'https://example.com',
      pages: [
        {
          url: 'https://example.com',
          finalUrl: 'https://example.com',
          statusCode: 200,
          depth: 0,
          html: `
            <html>
              <head>
                <title>Exportable semantic page</title>
                <meta name="description" content="Exportable semantic page description with enough text for validation." />
                <script id="__NEXT_DATA__" type="application/json">{ "props": {} }</script>
              </head>
              <body>
                <header><nav><a href="/about">About</a></nav></header>
                <main><section class="hero"><h1>Exportable Hero</h1></section></main>
              </body>
            </html>
          `,
        },
      ],
    });

    const files = buildWordPressProjectFiles(report);
    const indexFile = files.find(f => f.name === 'wordpress/index.json');
    expect(indexFile).toBeDefined();
    const project = JSON.parse(indexFile!.content.toString());

    expect(project).toMatchObject({
      artifactName: 'wordpress-project',
      modelKind: 'canonical-site-model',
      targetHint: 'wordpress',
    });
    expect(project.pages).toEqual([
      expect.objectContaining({
        slug: expect.any(String),
        sourceUrl: expect.any(String),
        title: expect.any(String),
      }),
    ]);
  });

  it('exports offline visual references for reconstruction validation', async () => {
    const report = new DefaultSeoAnalyzer().analyze({
      entryUrl: 'https://example.com',
      pages: [
        {
          url: 'https://example.com',
          finalUrl: 'https://example.com',
          statusCode: 200,
          depth: 0,
          html: `
            <html>
              <head>
                <title>Visual exportable page</title>
                <meta name="description" content="Visual exportable page description with enough text for validation." />
              </head>
              <body><main><h1>Visual Export</h1></main></body>
            </html>
          `,
          screenshot: {
            contentType: 'image/png',
            dataBase64: Buffer.from('png-reference').toString('base64'),
            viewport: { width: 1280, height: 720 },
            fullPage: true,
            capturedAt: '2026-07-11T00:00:00.000Z',
          },
        },
      ],
    });

    const files = buildWordPressProjectFiles(report);
    const pageFile = files.find(f => f.name === 'wordpress/pages/home.json');
    expect(pageFile).toBeDefined();
    expect(JSON.parse(pageFile!.content.toString()).visual).toMatchObject({
      screenshotRef: '../../visual/pages/home.png',
      viewport: { width: 1280, height: 720 },
    });

    const jobId = `visual-export-${Date.now()}`;
    const result = await runAllExports(report, jobId);
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(path.join('auditoria', jobId, 'visual', 'pages', 'home.png'))).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join('auditoria', jobId, 'reconstruction-manifest.json'), 'utf-8'));
    expect(manifest.visualRefs).toEqual(['visual/pages/home.png']);
  });

  it('restores deployment artifacts from an existing reconstruction without another crawl', () => {
    const jobId = `restore-export-${Date.now()}`;
    const jobDir = path.join('auditoria', jobId);
    fs.mkdirSync(path.join(jobDir, 'model', 'pages'), { recursive: true });
    fs.mkdirSync(path.join(jobDir, 'raw', 'pages'), { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'raw', 'pages', 'home.html'), '<main><h1>Recovered page</h1></main>');
    fs.writeFileSync(path.join(jobDir, 'model', 'pages', 'home.json'), JSON.stringify({
      slug: 'home',
      sourceUrl: 'https://example.com',
      finalUrl: 'https://example.com',
      title: 'Recovered page',
      headings: { h1: ['Recovered page'], h2: [], h3: [], h4: [], h5: [], h6: [] },
      visibleText: 'Recovered page',
      links: { internal: [], external: [] },
      media: { images: [] },
      commerce: { products: [], productRefs: [] },
      design: { computedStyles: [], layout: [], components: [], forms: [], widgets: [] },
    }));
    fs.writeFileSync(path.join(jobDir, 'reconstruction-manifest.json'), JSON.stringify({
      pages: [{
        slug: 'home',
        sourceUrl: 'https://example.com',
        finalUrl: 'https://example.com',
        model: 'model/pages/home.json',
        html: 'raw/pages/home.html',
      }],
    }));

    try {
      const restored = restoreDeploymentArtifactsFromReconstruction(jobId);
      expect(restored.every((file) => fs.existsSync(file))).toBe(true);
      expect(fs.existsSync(path.join(jobDir, 'wordpress', 'pages', 'home.json'))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(jobDir, 'wordpress', 'index.json'), 'utf8')).pages).toHaveLength(1);
    } finally {
      fs.rmSync(jobDir, { recursive: true, force: true });
    }
  });
});

describe('WooCommerce export', () => {
  it('emits WooCommerce-compatible parent and variation rows', () => {
    const csv = toWooCommerceCsv([
      {
        id: 'original-1',
        sku: 'SHIRT',
        slug: 'linen-shirt',
        url: 'https://example.com/products/linen-shirt',
        canonical: 'https://example.com/products/linen-shirt',
        title: 'Linen Shirt',
        name: 'Linen Shirt',
        price: '80',
        regularPrice: '100',
        salePrice: '80',
        currency: 'EUR',
        stock: '12',
        stockStatus: 'instock',
        categories: ['Clothing > Shirts'],
        tags: ['linen'],
        images: ['https://example.com/front.jpg', 'https://example.com/back.jpg'],
        media: [
          { url: 'https://example.com/front.jpg', originalUrl: 'https://example.com/front.jpg', order: 0, role: 'featured' },
          { url: 'https://example.com/back.jpg', originalUrl: 'https://example.com/back.jpg', order: 1, role: 'gallery' },
        ],
        attributes: { material: 'Linen' },
        options: { color: ['White', 'Blue'], size: ['M', 'L'] },
        variants: [
          {
            id: 'variant-1',
            sku: 'SHIRT-W-M',
            price: '80',
            stock: '4',
            attributes: { color: 'White', size: 'M' },
            image: 'https://example.com/white.jpg',
            url: 'https://example.com/products/linen-shirt?variant=1',
          },
        ],
        sourceUrl: 'https://example.com/products/linen-shirt',
      },
    ]);

    const lines = csv.split('\n');
    expect(lines[0]).toContain('"Type"');
    expect(lines[0]).toContain('"Images"');
    expect(lines[1]).toContain('"variable"');
    expect(lines[1]).toContain('"https://example.com/front.jpg, https://example.com/back.jpg"');
    expect(lines[2]).toContain('"variation"');
    expect(lines[2]).toContain('"sku:SHIRT"');
    expect(lines[2]).toContain('"SHIRT-W-M"');
  });
});
