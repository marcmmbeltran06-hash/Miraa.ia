import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { ImportedPackage } from './types.js';
import { ensureDir, safeJoin } from './fs-utils.js';

export class Importer {
  public import(inputPath: string): ImportedPackage {
    const resolved = path.resolve(inputPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Input does not exist: ${inputPath}`);
    }
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      return { rootPath: resolved };
    }
    if (!resolved.toLowerCase().endsWith('.zip')) {
      throw new Error('Input must be a Phase 1 export directory or ZIP');
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'autowp-builder-'));
    this.extractZip(resolved, tempRoot);
    return {
      rootPath: tempRoot,
      cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true }),
    };
  }

  private extractZip(zipPath: string, destination: string): void {
    const fd = fs.openSync(zipPath, 'r');
    const size = fs.fstatSync(fd).size;
    let offset = 0;
    const read = (length: number, position: number): Buffer => {
      const value = Buffer.allocUnsafe(length);
      const bytes = fs.readSync(fd, value, 0, length, position);
      if (bytes !== length) throw new Error(`Unexpected end of ZIP at offset ${position}`);
      return value;
    };
    try {
    while (offset + 30 <= size) {
      const header = read(30, offset);
      const signature = header.readUInt32LE(0);
      if (signature === 0x02014b50 || signature === 0x06054b50) break;
      if (signature !== 0x04034b50) {
        throw new Error(`Unsupported ZIP structure at offset ${offset}`);
      }

      const flags = header.readUInt16LE(6);
      const method = header.readUInt16LE(8);
      const compressedSize = header.readUInt32LE(18);
      const filenameLength = header.readUInt16LE(26);
      const extraLength = header.readUInt16LE(28);
      const nameStart = offset + 30;
      const dataStart = nameStart + filenameLength + extraLength;
      const filename = read(filenameLength, nameStart).toString('utf-8');

      if ((flags & 0x08) !== 0) {
        throw new Error('ZIP entries with data descriptors are not supported');
      }
      if (!filename.endsWith('/')) {
        const outputPath = safeJoin(destination, filename);
        ensureDir(path.dirname(outputPath));
        const data = read(compressedSize, dataStart);
        if (method === 0) {
          fs.writeFileSync(outputPath, data);
        } else if (method === 8) {
          fs.writeFileSync(outputPath, inflateRawSync(data));
        } else {
          throw new Error(`Unsupported ZIP compression method: ${method}`);
        }
      }

      offset = dataStart + compressedSize;
    }
    } finally {
      fs.closeSync(fd);
    }
  }
}
