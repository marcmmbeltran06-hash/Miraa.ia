import * as childProcess from 'node:child_process';
import { createRequire } from 'node:module';
import type { CaptureToolStatus } from './types.js';

function detect(command: string): { available: boolean; version?: string } {
  try { const r = childProcess.spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 5000 }); return { available: r.status === 0, version: (r.stdout || r.stderr || '').trim().split(/\r?\n/)[0] }; } catch { return { available: false }; }
}
function detectAny(commands: string[]): { available: boolean; version?: string; command: string } {
  for (const command of commands) { const result = detect(command); if (result.available) return { ...result, command }; }
  return { available: false, command: commands[0] };
}

export class CaptureToolManager {
  public status(): CaptureToolStatus {
    let playwrightAvailable = false;
    try { createRequire(import.meta.url).resolve('playwright'); playwrightAvailable = true; } catch { /* optional */ }
    const browsertrix = detectAny(['browsertrix', 'browsertrix-crawler']);
    const singleFileCommands = ['single-file', 'single-file-cli'];
    if (process.platform === 'win32' && process.env.APPDATA) singleFileCommands.push(`${process.env.APPDATA}\\npm\\single-file.cmd`);
    const singleFile = detectAny(singleFileCommands);
    return { browsertrix, singleFile, playwright: { available: playwrightAvailable, version: playwrightAvailable ? 'workspace dependency' : undefined } };
  }
}
