#!/usr/bin/env node
// Stand-in for Homebrew: `fake-brew install <dest>` "installs" the fake app by copying it to <dest>.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const [cmd, dest] = process.argv.slice(2);
if (cmd !== 'install' || !dest) process.exit(1);
console.log('==> Downloading fake-app');
fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-app.mjs'), dest);
fs.chmodSync(dest, 0o755);
console.log('==> Installed');
