#!/usr/bin/env node
// Stand-in for `pmtiles extract <src> <out> --bbox=... [--maxzoom=N] [--dry-run]`.
import fs from 'node:fs';
const [cmd, src, out, ...rest] = process.argv.slice(2);
if (cmd !== 'extract') process.exit(2);
if (rest.includes('--dry-run')) {
  console.error('2026/01/01 00:00:00 extract.go:611: Extract required 5 total requests.');
  console.error('2026/01/01 00:00:00 extract.go:612: Extract transferred 13 MB (overfetch 0.05) for an archive size of 12.5 MB');
  process.exit(0);
}
console.error('Region tiles: 42');
fs.writeFileSync(out, `PMTILES-FAKE src=${src} ${rest.join(' ')}`);
process.exit(0);
