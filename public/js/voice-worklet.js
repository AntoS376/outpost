// Hands the microphone's samples to the page, block by block, so it can build a WAV clip while you hold Talk.
class OutpostRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('outpost-recorder', OutpostRecorder);
