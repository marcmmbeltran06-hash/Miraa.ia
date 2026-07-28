import * as fs from 'node:fs';
import * as path from 'node:path';

export class WaczArtifactManager {
  public locate(root: string): string | undefined {
    const candidates = [path.join(root, 'site.wacz'), path.join(root, 'exact-capture', 'site.wacz')];
    return candidates.find((candidate) => fs.existsSync(candidate));
  }
  public writeStatus(root: string, artifactPath?: string): void {
    fs.mkdirSync(path.join(root, 'exact-capture'), { recursive: true });
    fs.writeFileSync(path.join(root, 'exact-capture', 'wacz-status.json'), JSON.stringify({ available: Boolean(artifactPath), artifactPath: artifactPath ?? null, generatedAt: new Date().toISOString() }, null, 2));
  }
}
