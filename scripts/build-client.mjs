// Bundles the offline map client (maplibre-gl + pmtiles + protomaps styles) and the QR code maker into public/vendor.
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'public', 'vendor'), { recursive: true });
await build({
  entryPoints: { map: path.join(root, 'client-src', 'map.js'), qr: path.join(root, 'client-src', 'qr.js') },
  outdir: path.join(root, 'public', 'vendor'),
  bundle: true,
  format: 'esm',
  minify: true,
  target: 'es2020',
  logLevel: 'warning',
  loader: { '.css': 'css' },
});
// MapLibre 6 runs its web worker from a separate file, loaded next to map.js.
await copyFile(path.join(root, 'node_modules', 'maplibre-gl', 'dist', 'maplibre-gl-worker.mjs'), path.join(root, 'public', 'vendor', 'maplibre-gl-worker.mjs'));
// Interface fonts (SIL Open Font Licence), served locally so they work offline.
await mkdir(path.join(root, 'public', 'vendor', 'fonts'), { recursive: true });
for (const [pkg, file] of [
  ['space-grotesk', 'space-grotesk-latin-wght-normal.woff2'],
  ['space-grotesk', 'space-grotesk-latin-ext-wght-normal.woff2'],
  ['inter', 'inter-latin-wght-normal.woff2'],
  ['inter', 'inter-latin-ext-wght-normal.woff2'],
  ['jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2'],
  ['jetbrains-mono', 'jetbrains-mono-latin-ext-wght-normal.woff2'],
]) {
  await copyFile(path.join(root, 'node_modules', '@fontsource-variable', pkg, 'files', file), path.join(root, 'public', 'vendor', 'fonts', file));
}
console.log('client bundle built → public/vendor/map.js, qr.js, fonts/');
