#!/usr/bin/env node
// Stand-in for `direwolf -c <conf> ... -L <csv> -`: logs its arguments to FAKE_RTL_LOG, reads (and drops) the audio on
// stdin, and writes direwolf's CSV log: the header, then a car near Beirut and a weather station with a quoted comment
// containing a comma, every 300 ms. Stops when its input ends, as direwolf does.
import fs from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FAKE_RTL_LOG) fs.appendFileSync(process.env.FAKE_RTL_LOG, `direwolf ${args.join(' ')}\n`);
const log = args[args.indexOf('-L') + 1];
fs.writeFileSync(log, 'chan,utime,isotime,source,heard,level,error,dti,name,symbol,latitude,longitude,speed,course,altitude,frequency,offset,tone,system,status,telemetry,comment\n');
const rows = [
  '0,1794943735,2026-11-17T19:28:55Z,OD5XYZ-9,OD5XYZ-9,73(21/21),0,`,OD5XYZ-9,/>,33.883333,35.500000,36.0,90.0,100.0,,,,,,,On the way north',
  '0,1794943736,2026-11-17T19:28:56Z,OD5WX,OD5WX,60(20/20),0,_,OD5WX,/_,33.95,35.6,,,,,,,,,,"Wind 5 km/h, 21 C"',
];
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
setInterval(() => fs.appendFileSync(log, `${rows.join('\n')}\n`), 300);
