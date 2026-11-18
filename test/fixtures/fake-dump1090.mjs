#!/usr/bin/env node
// Stand-in for `dump1090 --write-json <dir> ...`: logs its arguments to FAKE_RTL_LOG, then rewrites <dir>/aircraft.json
// every 300 ms: a liner near Beirut climbing out, one squawking 7700, one heard too long ago, one heard without a
// position yet, and a message total that grows 100 a second. FAKE_RTL=busy acts as if another program holds the dongle.
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (process.env.FAKE_RTL_LOG) fs.appendFileSync(process.env.FAKE_RTL_LOG, `dump1090 ${args.join(' ')}\n`);
if (process.env.FAKE_RTL === 'busy') {
  console.error('usb_claim_interface error -3\nrtlsdr: error opening the RTLSDR device');
  process.exit(1);
}
const dir = args[args.indexOf('--write-json') + 1];
const start = Date.now();
const write = () => {
  const now = Date.now() / 1000;
  const flown = (Date.now() - start) / 1000; // the liner heads south-southeast, a little each second
  const aircraft = [
    { hex: '4b1805', flight: 'MEA322  ', lat: Math.round((33.82 - flown * 0.002) * 1e5) / 1e5, lon: Math.round((35.49 + flown * 0.0006) * 1e5) / 1e5, alt_baro: 3400, gs: 182.5, track: 164.2, baro_rate: 1856, squawk: '4421', seen: 0.2, seen_pos: 0.4, rssi: -11.6 },
    { hex: '738065', flight: 'ELY002', lat: 34.1, lon: 35.2, alt_baro: 36000, gs: 455, track: 290, baro_rate: 0, squawk: '7700', emergency: 'general', seen: 1, seen_pos: 2, rssi: -24.3 },
    { hex: '06a0f1', flight: 'QTR418', lat: 33.5, lon: 35.9, alt_baro: 38000, seen: 120, seen_pos: 120, rssi: -3 },
    { hex: '89645a', flight: 'UAE953', alt_baro: 24000, seen: 3, rssi: -20.1 },
  ];
  const messages = Math.round(((Date.now() - start) / 1000) * 100);
  fs.writeFileSync(path.join(dir, 'aircraft.json.tmp'), JSON.stringify({ now, messages, aircraft }));
  fs.renameSync(path.join(dir, 'aircraft.json.tmp'), path.join(dir, 'aircraft.json'));
};
write();
setInterval(write, 300);
process.on('SIGTERM', () => process.exit(0));
