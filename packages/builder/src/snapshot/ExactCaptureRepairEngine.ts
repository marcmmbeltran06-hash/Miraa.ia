import * as fs from 'node:fs';
import * as path from 'node:path';
export class ExactCaptureRepairEngine {
  public listUploadedFiles(sitePath: string): string[] {
    const dir = path.join(sitePath, 'source-project', 'incoming');
    return fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => path.join(dir, name)) : [];
  }
}
