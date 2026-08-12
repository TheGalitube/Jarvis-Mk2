export function float32ToPcm16Base64(samples) {
  const output = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  const bytes = new Uint8Array(output.buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Capture is independent of STT. Its PCM16 output can be consumed by any
// streaming provider while Chrome SpeechRecognition continues to own its own
// browser microphone path.
export class MicrophoneCapture {
  constructor({ AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext, getUserMedia = globalThis.navigator?.mediaDevices?.getUserMedia?.bind(globalThis.navigator.mediaDevices) } = {}) {
    this.AudioContext = AudioContext;
    this.getUserMedia = getUserMedia;
    this.stream = null; this.context = null; this.source = null; this.processor = null; this.mute = null;
  }

  get supported() { return Boolean(this.AudioContext && this.getUserMedia); }

  async start(onAudio) {
    if (!this.supported) throw new Error("Microphone capture is unavailable");
    if (this.stream) return false;
    this.stream = await this.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    this.context = new this.AudioContext({ sampleRate: 16_000 });
    await this.context.resume?.();
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = this.context.createScriptProcessor(4096, 1, 1);
    this.mute = this.context.createGain(); this.mute.gain.value = 0;
    this.processor.onaudioprocess = (event) => onAudio(float32ToPcm16Base64(event.inputBuffer.getChannelData(0)));
    this.source.connect(this.processor); this.processor.connect(this.mute); this.mute.connect(this.context.destination);
    return true;
  }

  async stop() {
    this.processor?.disconnect(); this.source?.disconnect(); this.mute?.disconnect();
    this.stream?.getTracks().forEach((track) => track.stop());
    await this.context?.close?.();
    this.stream = this.context = this.source = this.processor = this.mute = null;
  }
}
