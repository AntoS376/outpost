import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBatt } from '../src/services/battery.js';

test('battery: on battery power with time left', () => {
  const b = parseBatt("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t55%; discharging; 2:16 remaining present: true\n");
  assert.deepEqual(b, { present: true, percent: 55, plugged: false, charging: false, minutes: 136 });
});

test('battery: charging, time not known yet', () => {
  const b = parseBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charging; (no estimate) present: true\n");
  assert.deepEqual(b, { present: true, percent: 80, plugged: true, charging: true, minutes: null });
});

test('battery: full on power', () => {
  const b = parseBatt("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n");
  assert.equal(b.plugged, true);
  assert.equal(b.charging, false);
  assert.equal(b.percent, 100);
});

test('battery: a Mac without a battery', () => {
  assert.equal(parseBatt("Now drawing from 'AC Power'\n").present, false);
});
