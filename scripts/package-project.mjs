import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.resolve(root, '..', 'netlify-ready-game.zip');
const allowedOutput = `${path.resolve(root, '..')}${path.sep}`;
if (!destination.startsWith(allowedOutput)) throw new Error('The project ZIP must remain in the outputs folder.');
await rm(destination, { force: true });
const ignored = new Set(['node_modules', '.netlify', '.npm-cache', '.git', 'cache', 'caches']);
const archive = new ZipArchive({ zlib: { level: 9 } });
const output = createWriteStream(destination, { flags: 'wx' });
const required = new Set(['index.html', 'client.js', 'style.css', 'package.json', 'package-lock.json', 'netlify.toml', 'netlify/functions/game.ts', 'game-core.js']);
const included = new Set();

async function addDirectory(directory, prefix = '') {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(item.name) || item.name.endsWith('.log')) continue;
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    const absolute = path.join(directory, item.name);
    if (item.isDirectory()) await addDirectory(absolute, relative);
    else if (item.isFile()) {
      archive.file(absolute, { name: relative });
      included.add(relative);
    }
  }
}

await addDirectory(root);
const missing = [...required].filter((file) => !included.has(file));
if (missing.length) throw new Error(`Project archive is missing required files: ${missing.join(', ')}`);
await new Promise((resolve, reject) => {
  output.on('close', resolve);
  output.on('error', reject);
  archive.on('error', reject);
  archive.pipe(output);
  archive.finalize().catch(reject);
});
console.log(`Created ${destination} with ${included.size} project files.`);
