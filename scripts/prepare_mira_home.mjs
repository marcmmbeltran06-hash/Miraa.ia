import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(projectRoot, 'index.html');
const destination = resolve(projectRoot, 'packages', 'web', 'public', 'mira-home.html');

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log(`Portada original preparada: ${destination}`);
