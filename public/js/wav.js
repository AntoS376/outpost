/**
 * Voice clips as plain WAV (16 kHz, mono, 16-bit): every phone and computer can play it, and Outpost needs no converter.
 * `chunks` are the microphone's Float32 samples at `inRate`; they are averaged down to `outRate`.
 */
export function encodeWav(chunks, inRate, outRate = 16_000) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const step = inRate / outRate;
  const frames = Math.floor(total / step);
  const out = new Uint8Array(44 + frames * 2);
  const v = new DataView(out.buffer);
  const tag = (o, s) => [...s].forEach((ch, i) => out[o + i] = ch.charCodeAt(0));
  tag(0, 'RIFF');
  v.setUint32(4, 36 + frames * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, outRate, true);
  v.setUint32(28, outRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, frames * 2, true);

  // Walk the chunks once, averaging each window of input samples into one output sample.
  let ci = 0;
  let si = 0;
  let pos = 0;
  for (let f = 0; f < frames; f++) {
    const end = (f + 1) * step;
    let sum = 0;
    let n = 0;
    while (pos < end && ci < chunks.length) {
      sum += chunks[ci][si];
      n++;
      pos++;
      if (++si >= chunks[ci].length) {
        ci++;
        si = 0;
      }
    }
    const s = Math.max(-1, Math.min(1, n ? sum / n : 0));
    v.setInt16(44 + f * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}
