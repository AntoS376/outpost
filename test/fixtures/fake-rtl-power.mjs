#!/usr/bin/env node
// Stand-in for `rtl_power -f lo:hi:bin -i 1 -1 -`: one sweep in rtl_power's CSV, noise at -30 dB with one station at
// 27.185 MHz (CB 19). Logs its arguments to FAKE_RTL_LOG. FAKE_RTL=none acts as if no dongle is plugged in.
import fs from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_RTL_LOG) fs.appendFileSync(process.env.FAKE_RTL_LOG, `power ${args.join(' ')}\n`);
if (process.env.FAKE_RTL === 'none') {
  console.error('No supported devices found.');
  process.exit(1);
}
const [lo, hi, bin] = args[args.indexOf('-f') + 1].split(':').map(Number);
// Like rtl_power, hops of at most 2 MHz, one CSV row each.
for (let start = lo; start < hi; start += 2e6) {
  const end = Math.min(hi, start + 2e6);
  const n = Math.max(1, Math.round((end - start) / bin));
  const step = (end - start) / n;
  const db = Array.from({ length: n }, (_, i) => (Math.abs(start + (i + 0.5) * step - 27_185_000) <= step ? '-2.5' : '-30.0'));
  console.log(`2026-11-17, 15:00:00, ${start}, ${end}, ${step.toFixed(2)}, 4096, ${db.join(', ')}`);
}
