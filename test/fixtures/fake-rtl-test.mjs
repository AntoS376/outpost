#!/usr/bin/env node
// Stand-in for `rtl_test -t`: FAKE_RTL=none reports no dongle, otherwise one.
if (process.env.FAKE_RTL === 'none') {
  console.error('No supported devices found.');
  process.exit(1);
}
console.error('Found 1 device(s):\n  0:  Realtek, RTL2838UHIDIR, SN: 00000001\n\nUsing device 0: Generic RTL2832U OEM\nFound Rafael Micro R820T tuner');
process.exit(1);
