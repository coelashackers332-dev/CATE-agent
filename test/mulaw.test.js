import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode } from '../src/mulaw.js';

test('decode: known G.711 values', () => {
  assert.deepEqual([...decode(Uint8Array.of(0xff, 0x00, 0x80, 0x7f))], [0, -32124, 32124, 0]);
});

test('encode: silence, extremes, returns a Buffer', () => {
  const out = encode(Int16Array.of(0, 32767, -32768));
  assert.ok(Buffer.isBuffer(out));
  assert.deepEqual([...out], [0xff, 0x80, 0x00]);
});

test('every μ-law byte survives decode → encode', () => {
  for (let u = 0; u < 256; u++) {
    if (u === 0x7f) continue; // negative zero decodes to 0, which encodes as 0xff
    assert.equal(encode(decode(Uint8Array.of(u)))[0], u, `byte ${u}`);
  }
});

test('round trip stays within the μ-law quantisation step', () => {
  for (let s = -32768; s <= 32767; s += 7) {
    const back = decode(encode(Int16Array.of(s)))[0];
    const magnitude = Math.min(Math.abs(s), 32635);
    const segment = 24 - Math.clz32(magnitude + 132);
    const step = 8 << segment;                      // quantisation step in this segment
    const limit = Math.abs(s) > 32635 ? 32768 - 32124 : step / 2; // clipped samples land on the top level
    assert.ok(Math.abs(back - s) <= limit, `${s} → ${back} (limit ${limit})`);
    assert.equal(Math.sign(back) * Math.sign(s) >= 0, true);
  }
});
