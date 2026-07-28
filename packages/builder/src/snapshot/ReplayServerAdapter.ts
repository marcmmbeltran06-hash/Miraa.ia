import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';

export interface ReplayServerResult { available: boolean; command: string; error?: string; }

/** Optional ReplayWeb.page/pywb launcher. It is never required for a normal
 * build, but records a deterministic command for operators who install it. */
export class ReplayServerAdapter {
  public start(waczPath: string, port: number): ReplayServerResult {
    const command = `replayweb.page --port ${port} ${waczPath}`;
    if (!fs.existsSync(waczPath)) return { available: false, command, error: 'WACZ artifact not found' };
    const result = childProcess.spawnSync('replayweb.page', ['--port', String(port), waczPath], { encoding: 'utf8', timeout: 5000 });
    return { available: result.status === 0, command, error: result.status === 0 ? undefined : (result.stderr || result.error?.message || 'ReplayWeb.page unavailable').trim() };
  }
}
