import * as fs from 'node:fs';
import * as path from 'node:path';

export class SourceFilesRequestService {
  public write(outputPath: string, requests: string[]): void {
    const validation = path.join(outputPath, 'validation'); fs.mkdirSync(validation, { recursive: true });
    fs.writeFileSync(path.join(validation, 'source-files-request.json'), JSON.stringify({ status: requests.length ? 'source_files_required' : 'not_required', requests, message: requests.length ? 'La captura no contiene estos recursos. Aporta únicamente los archivos indicados para reparar las páginas afectadas.' : null }, null, 2));
  }
}
