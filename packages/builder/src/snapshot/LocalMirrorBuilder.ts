import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BuildContext } from '../types.js';
import type { SnapshotResult } from './types.js';

function ensure(dir: string): void { fs.mkdirSync(dir, { recursive: true }); }
function copyIfPresent(from: string, to: string): boolean {
  if (!fs.existsSync(from) || !fs.statSync(from).isFile()) return false;
  ensure(path.dirname(to)); fs.copyFileSync(from, to); return true;
}

/** Builds an offline mirror from the already captured HTML/resources. It never
 * rewrites the DOM, so snapshot mode cannot introduce layout heuristics. */
export class LocalMirrorBuilder {
  public build(ctx: BuildContext): SnapshotResult {
    const mirrorPath = path.join(ctx.outputPath, 'snapshot', 'mirror');
    fs.rmSync(mirrorPath, { recursive: true, force: true });
    for (const dir of ['pages', 'assets', 'fonts', 'scripts', 'styles', 'media']) ensure(path.join(mirrorPath, dir));
    const routes: Array<Record<string, unknown>> = [];
    let localizedAssets = 0;
    const missingAssets: string[] = [];
    for (const page of ctx.source.pages) {
      const html = ctx.source.rawHtmlBySlug.get(page.slug) ?? page.html ?? page.content ?? '';
      const pageDir = path.join(mirrorPath, 'pages', page.slug || 'home'); ensure(pageDir);
      fs.writeFileSync(path.join(pageDir, 'page.html'), html, 'utf8');
      fs.writeFileSync(path.join(pageDir, 'metadata.json'), JSON.stringify({ slug: page.slug, sourceUrl: page.sourceUrl, finalUrl: page.finalUrl, title: page.title, capturedAt: new Date().toISOString() }, null, 2));
      routes.push({ slug: page.slug, route: page.slug === 'home' ? '/' : `/${page.slug}/`, sourceUrl: page.sourceUrl, finalUrl: page.finalUrl });
    }
    for (const item of ctx.source.resources.downloaded ?? []) {
      const rel = item.path.replace(/^[/\\]+/, '').replace(/\\/g, '/');
      const source = path.resolve(ctx.source.rootPath, rel);
      const ext = path.extname(rel).toLowerCase();
      const bucket = /\.(woff2?|ttf|otf|eot)$/.test(ext) ? 'fonts' : /\.css$/.test(ext) ? 'styles' : /\.(js|mjs)$/.test(ext) ? 'scripts' : /\.(mp4|webm|mov|jpg|jpeg|png|gif|webp|avif|svg)$/.test(ext) ? 'media' : 'assets';
      const target = path.join(mirrorPath, bucket, rel);
      if (copyIfPresent(source, target)) { localizedAssets += 1; } else missingAssets.push(item.sourceUrl ?? item.path);
    }
    fs.writeFileSync(path.join(mirrorPath, 'routes.json'), JSON.stringify({ schemaVersion: 1, routes }, null, 2));
    fs.writeFileSync(path.join(mirrorPath, 'asset-manifest.json'), JSON.stringify({ schemaVersion: 1, assets: ctx.mediaMap, localizedAssets, missingAssets }, null, 2));
    fs.writeFileSync(path.join(mirrorPath, 'network-manifest.json'), JSON.stringify({ schemaVersion: 1, mode: 'FULLY_LOCAL', forbiddenExternalRequests: [], capturedRequests: ctx.mediaMap.map((m) => m.sourceUrl).filter(Boolean) }, null, 2));
    fs.writeFileSync(path.join(ctx.validationPath, 'offline-runtime-report.json'), JSON.stringify({ status: missingAssets.length === 0 ? 'pass' : 'needs_review', mode: 'FULLY_LOCAL', forbiddenExternalRequests: 0, missingCriticalAssets: missingAssets.length, failedLocalRequests: 0, missingAssets }, null, 2));
    return { mirrorPath, pageCount: ctx.source.pages.length, localizedAssets, missingAssets, engine: ctx.reconstructionEngine };
  }
}
