#!/usr/bin/env node
// Stand-in for osmium: fileinfo (the data's date), merge and extract -b (writes what it was asked to do).
import fs from 'node:fs';
const [cmd, ...args] = process.argv.slice(2);
const out = () => args[args.indexOf('-o') + 1];
if (cmd === 'fileinfo') console.log('2026-10-30T21:24:51Z');
else if (cmd === 'merge') fs.writeFileSync(out(), args.slice(0, args.indexOf('-o')).map((f) => fs.readFileSync(f, 'utf8')).join('+'));
else if (cmd === 'extract') fs.writeFileSync(out(), `cut ${args[args.indexOf('-b') + 1]} from ${fs.readFileSync(args[2], 'utf8')}`);
else process.exit(2);
