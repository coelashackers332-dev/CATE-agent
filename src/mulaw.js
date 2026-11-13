// G.711 μ-law <-> 16-bit linear PCM. Phone audio is 8 kHz μ-law; the model side is 8 kHz PCM, so no resampling.
const BIAS = 0x84;   // 132, added before the segment search so every magnitude has a top bit at 7 or above
const CLIP = 32635;  // largest magnitude that still fits after the bias

function decodeByte(u) {
  u = ~u & 0xff;     // μ-law bytes are stored inverted
  const magnitude = ((((u & 0x0f) << 3) + BIAS) << ((u >> 4) & 7)) - BIAS;
  return u & 0x80 ? -magnitude : magnitude;
}
const DECODE = Int16Array.from({ length: 256 }, (_, u) => decodeByte(u));

function encodeSample(s) {
  const sign = s < 0 ? 0x80 : 0;
  const magnitude = Math.min(Math.abs(s), CLIP) + BIAS;
  const segment = 24 - Math.clz32(magnitude);   // top bit position minus 7 → 0..7
  return ~(sign | (segment << 4) | ((magnitude >> (segment + 3)) & 0x0f)) & 0xff;
}

/** μ-law bytes (Buffer or Uint8Array) → Int16Array of PCM samples. */
export function decode(mulaw) {
  const pcm = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) pcm[i] = DECODE[mulaw[i]];
  return pcm;
}

/** Int16Array of PCM samples → Buffer of μ-law bytes. */
export function encode(pcm) {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = encodeSample(pcm[i]);
  return out;
}
