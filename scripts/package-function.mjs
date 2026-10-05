import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const output = fileURLToPath(new URL('../.netlify/functions-dist/', import.meta.url));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const functionSource = await readFile(new URL('../netlify/functions/game.ts', import.meta.url), 'utf8');
const compiledSource = functionSource.replace('../../game-core.js', './game-core.js');
if (compiledSource === functionSource) throw new Error('The game function helper import could not be prepared.');
const functionPath = `${output}/game.mjs`;
const helperPath = `${output}/game-core.js`;
const packagePath = `${output}/package.json`;
const archivePath = `${output}/game.zip`;
await writeFile(functionPath, compiledSource);
await copyFile(new URL('../game-core.js', import.meta.url), helperPath);
await writeFile(packagePath, JSON.stringify({
  name: 'galaxy-conquest-game-function',
  private: true,
  type: 'module',
  dependencies: { '@netlify/blobs': '^11.1.3' },
}, null, 2));

const { default: handler } = await import(pathToFileURL(functionPath));
if (typeof handler !== 'function') throw new Error('The packaged game function does not export a request handler.');
const smokeResponse = await handler(new Request('https://game.test/.netlify/functions/game'));
if (smokeResponse.status !== 400 || !(await smokeResponse.json()).error) {
  throw new Error('The packaged game function did not handle an HTTP request correctly.');
}

await new Promise((resolve, reject) => {
  const outputStream = createWriteStream(archivePath);
  const archive = new ZipArchive({ zlib: { level: 9 } });
  outputStream.on('close', resolve);
  outputStream.on('error', reject);
  archive.on('error', reject);
  archive.pipe(outputStream);
  archive.file(functionPath, { name: 'game.mjs' });
  archive.file(helperPath, { name: 'game-core.js' });
  archive.file(packagePath, { name: 'package.json' });
  archive.finalize().catch(reject);
});

console.log(`Verified the request handler and packaged its files at ${archivePath}`);
