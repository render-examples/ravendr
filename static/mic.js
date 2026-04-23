// Mic capture + speaker playback at 24 kHz PCM16 (AssemblyAI Voice Agent format).

const TARGET_SAMPLE_RATE = 24000;

/**
 * Start capturing the microphone and invoke onChunk with base64-encoded PCM16
 * frames (~50ms each). Returns a stop() function.
 */
export async function startCapture(onChunk) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, noiseSuppression: true, echoCancellation: true },
  });
  const ctx = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: TARGET_SAMPLE_RATE,
  });
  const source = ctx.createMediaStreamSource(stream);

  // Use a small ScriptProcessor for broad browser compat. AudioWorklet would
  // be cleaner but adds a separate module file.
  const processor = ctx.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = floatTo16BitPCM(input);
    onChunk(arrayBufferToBase64(pcm16.buffer));
  };
  source.connect(processor);
  processor.connect(ctx.destination);

  return () => {
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    ctx.close();
  };
}

/**
 * Play an incoming base64 PCM16 chunk. Chunks are queued so they play in order.
 */
export function createPlayer() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: TARGET_SAMPLE_RATE,
  });
  let playHead = ctx.currentTime;

  return {
    enqueue(base64) {
      const bytes = base64ToArrayBuffer(base64);
      const pcm = new Int16Array(bytes);
      const buffer = ctx.createBuffer(1, pcm.length, TARGET_SAMPLE_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const start = Math.max(ctx.currentTime, playHead);
      src.start(start);
      playHead = start + buffer.duration;
    },
    reset() {
      playHead = ctx.currentTime;
    },
  };
}

function floatTo16BitPCM(input) {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
