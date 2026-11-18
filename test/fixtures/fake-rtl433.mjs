#!/usr/bin/env node
// Stand-in for `rtl_433 -f <freq> -F json -M level`: logs its arguments to FAKE_RTL_LOG, then prints a weather
// station, a thermometer in Fahrenheit, a car's tyre sensor, a doorbell and a garbled line, every 300 ms.
// FAKE_RTL=busy acts as if another program holds the dongle.
import fs from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_RTL_LOG) fs.appendFileSync(process.env.FAKE_RTL_LOG, `rtl_433 ${args.join(' ')}\n`);
if (process.env.FAKE_RTL === 'busy') {
  console.error('usb_claim_interface error -3');
  process.exit(1);
}
const lines = [
  { time: '1794942290', model: 'Fineoffset-WH24', id: 140, temperature_C: 21.4, humidity: 63, wind_dir_deg: 225, wind_avg_m_s: 2.1, wind_max_m_s: 4.5, rain_mm: 12.3, battery_ok: 1, rssi: -8.2 },
  { time: '1794942291', model: 'Nexus-TH', id: 211, channel: 2, temperature_F: 68, humidity: 48, battery_ok: 0, rssi: -14.1 },
  { time: '1794942292', model: 'Toyota', type: 'TPMS', id: 'd9d14b9f', pressure_PSI: 30.5, temperature_C: 25, rssi: -20 },
  { time: '1794942293', model: 'Generic-Doorbell', id: 7, cmd: 1 },
];
const tick = () => {
  for (const l of lines) process.stdout.write(`${JSON.stringify(l)}\n`);
  process.stdout.write('not json at all\n');
};
tick();
setInterval(tick, 300);
process.on('SIGTERM', () => process.exit(0));
