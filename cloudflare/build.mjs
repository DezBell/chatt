import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = resolve(scriptDirectory, 'public');

await mkdir(publicDirectory, { recursive: true });
await copyFile(resolve(scriptDirectory, '..', 'styles.css'), resolve(publicDirectory, 'styles.css'));
