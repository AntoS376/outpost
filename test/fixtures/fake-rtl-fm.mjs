#!/usr/bin/env node
// Stand-in for `rtl_fm -f <Hz> -M <mode> ... -`: logs its arguments, then streams a quiet tone as 16-bit PCM until
// stopped. FAKE_RTL=busy acts as if another program holds the dongle.
import fs from 'node:fs';
if (process.env.FAKE_RTL_LOG) fs.appendFileSync(process.env.FAKE_RTL_LOG, process.argv.slice(2).join(' ') + '\n');
if (process.env.FAKE_RTL === 'busy') {
  console.error('Found 1 device(s):\nKernel driver is active, or device is claimed by second instance of librtlsdr.');
  process.exit(1);
}
const chunk = Buffer.alloc(4800);
for (let i = 0; i < 2400; i++) chunk.writeInt16LE(Math.round(Math.sin(i / 4) * 3000), i * 2);
const timer = setInterval(() => process.stdout.write(chunk), 100);
// FAKE_RTL_BURST=ms: one call that long, then silence, as rtl_fm sends with squelch on.
if (process.env.FAKE_RTL_BURST) setTimeout(() => clearInterval(timer), Number(process.env.FAKE_RTL_BURST));
setInterval(() => {}, 1000); // keep running while quiet
process.on('SIGTERM', () => process.exit(0));
