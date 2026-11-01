#!/usr/bin/env node
// Stand-in for macOS caffeinate: records its arguments, then waits until it is stopped.
import fs from 'node:fs';
fs.writeFileSync(process.env.FAKE_CAFFEINATE_LOG, process.argv.slice(2).join(' '));
setInterval(() => {}, 1 << 30);
