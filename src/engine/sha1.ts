/** Pure synchronous SHA-1 (FIPS 180-4). No Node crypto, no WebCrypto (which is async). */

const BLOCK_BYTES = 64;
// Reused across calls: evaluation is synchronous, so there is no reentrancy.
const W = new Int32Array(80);
const H = new Int32Array(5);

/** Runs SHA-1 over `data` and leaves the five state words in `H`. */
function digestWords(data: Uint8Array): Int32Array {
  const len = data.length;
  const total = ((len + 9 + 63) >> 6) << 6;
  const m = new Uint8Array(total);
  m.set(data);
  m[len] = 0x80;
  const hiBits = Math.floor(len / 0x20000000);
  const loBits = (len << 3) >>> 0;
  m[total - 8] = (hiBits >>> 24) & 255;
  m[total - 7] = (hiBits >>> 16) & 255;
  m[total - 6] = (hiBits >>> 8) & 255;
  m[total - 5] = hiBits & 255;
  m[total - 4] = (loBits >>> 24) & 255;
  m[total - 3] = (loBits >>> 16) & 255;
  m[total - 2] = (loBits >>> 8) & 255;
  m[total - 1] = loBits & 255;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89 | 0;
  let h2 = 0x98badcfe | 0;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0 | 0;

  for (let off = 0; off < total; off += BLOCK_BYTES) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      W[i] = ((m[j] as number) << 24) | ((m[j + 1] as number) << 16) | ((m[j + 2] as number) << 8) | (m[j + 3] as number);
    }
    for (let i = 16; i < 80; i++) {
      const x = (W[i - 3] as number) ^ (W[i - 8] as number) ^ (W[i - 14] as number) ^ (W[i - 16] as number);
      W[i] = (x << 1) | (x >>> 31);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let t: number;
    for (let i = 0; i < 20; i++) {
      t = (((a << 5) | (a >>> 27)) + ((b & c) | (~b & d)) + e + 0x5a827999 + (W[i] as number)) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    for (let i = 20; i < 40; i++) {
      t = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e + 0x6ed9eba1 + (W[i] as number)) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    for (let i = 40; i < 60; i++) {
      t = (((a << 5) | (a >>> 27)) + ((b & c) | (b & d) | (c & d)) + e - 0x70e44324 + (W[i] as number)) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    for (let i = 60; i < 80; i++) {
      t = (((a << 5) | (a >>> 27)) + (b ^ c ^ d) + e - 0x359d3e2a + (W[i] as number)) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  H[0] = h0;
  H[1] = h1;
  H[2] = h2;
  H[3] = h3;
  H[4] = h4;
  return H;
}

/** SHA-1 digest of `data`: 20 bytes. */
export function sha1(data: Uint8Array): Uint8Array {
  const h = digestWords(data);
  const out = new Uint8Array(20);
  for (let i = 0; i < 5; i++) {
    const v = h[i] as number;
    out[i * 4] = (v >>> 24) & 255;
    out[i * 4 + 1] = (v >>> 16) & 255;
    out[i * 4 + 2] = (v >>> 8) & 255;
    out[i * 4 + 3] = v & 255;
  }
  return out;
}

/** The first 60 bits of the SHA-1 digest (the first 15 hex digits) as a BigInt. */
export function sha1Prefix60(data: Uint8Array): bigint {
  const h = digestWords(data);
  return (BigInt((h[0] as number) >>> 0) << 28n) | BigInt((h[1] as number) >>> 4 & 0xfffffff);
}

/** Lowercase hex of `bytes`. */
export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
