import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ExternalCaptureOptions { url: string; outputDir: string; maxPageSettleMs?: number; }

/** Optional Browsertrix process adapter. The builder never bundles or copies
 * Browsertrix; when installed, callers can run it as a versioned tool. */
export class BrowsertrixAdapter {
  public capture(options: ExternalCaptureOptions): { started: boolean; command: string; error?: string } {
    fs.mkdirSync(options.outputDir, { recursive: true });
    const args = ['crawl', '--url', options.url, '--collection', options.outputDir];
    const result = childProcess.spawnSync('browsertrix', args, { encoding: 'utf8', timeout: options.maxPageSettleMs ?? 900_000 });
    return { started: result.status === 0, command: `browsertrix ${args.join(' ')}`, error: result.status === 0 ? undefined : (result.stderr || result.error?.message || 'Browsertrix unavailable').trim() };
  }
}

/** Optional SingleFile page fallback. It is deliberately page-scoped so a
 * failed page cannot invalidate the rest of a job. */
export class SingleFileFallbackManager {
  public capture(options: ExternalCaptureOptions): { captured: boolean; outputPath: string; error?: string } {
    fs.mkdirSync(options.outputDir, { recursive: true });
    const outputPath = path.join(options.outputDir, 'page.html');
    const args = [options.url, outputPath];
    const result = childProcess.spawnSync('single-file', args, { encoding: 'utf8', timeout: options.maxPageSettleMs ?? 180_000 });
    return { captured: result.status === 0 && fs.existsSync(outputPath), outputPath, error: result.status === 0 ? undefined : (result.stderr || result.error?.message || 'SingleFile unavailable').trim() };
  }
}
