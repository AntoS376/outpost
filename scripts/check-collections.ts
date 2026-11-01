// Checks data/collections.json against the live Kiwix catalog: every book must exist with the listed flavour.
//   npx tsx scripts/check-collections.ts      (exits 1 if anything is missing)
import { loadConfig } from '../src/config.js';
import { loadCollections, resolveCollections } from '../src/services/collections.js';

const cfg = loadConfig();
const resolved = await resolveCollections(cfg, await loadCollections(cfg.collectionsFile));
const line = (b: { name: string; flavour: string; size: number | null; fileName: string }) => `${b.name}${b.flavour ? ` (${b.flavour})` : ''}  ${((b.size ?? 0) / 1e9).toFixed(2)} GB  ${b.fileName}`;
console.log('Wikipedia:');
for (const w of resolved.wikipedia) console.log(`  ${w.choice}: ${line(w)}`);
for (const t of resolved.topics) {
  for (const l of t.levels) {
    console.log(`${t.title}, ${l.title} (with the levels before it): ${(l.size / 1e9).toFixed(2)} GB`);
    for (const b of l.books) console.log(`  ${line(b)}`);
  }
}
if (resolved.dropped.length) {
  console.log(`\nNot in the catalog (dropped): ${resolved.dropped.join(', ')}`);
  process.exitCode = 1;
}
