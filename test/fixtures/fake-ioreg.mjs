#!/usr/bin/env node
// Stand-in for `ioreg -r -d 1 -w 0 -c IOAccelerator`, in the format an Apple Silicon Mac prints. Counts its runs.
import fs from 'node:fs';
if (process.env.FAKE_IOREG_COUNT) fs.appendFileSync(process.env.FAKE_IOREG_COUNT, 'x');
const busy = process.env.FAKE_GPU_BUSY ?? '32';
console.log(`+-o AGXAcceleratorG15X  <class AGXAcceleratorG15X, id 0x100000a3c, registered, matched, active, busy 0 (0 ms), retain 23>
    {
      "IOClass" = "AGXAcceleratorG15X"
      "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=5294653440,"Tiler Utilization %"=31,"recoveryCount"=0,"Renderer Utilization %"=31,"Device Utilization %"=${busy},"In use system memory"=961003520}
      "model" = "Apple M3 Pro"
      "gpu-core-count" = 18
    }`);
