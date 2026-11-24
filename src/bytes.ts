// Byte helpers: hex, hashing, Bitcoin-style encodings.
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';

export const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
export const fromHex = (h: string): Buffer => {
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error(`invalid hex: ${h.slice(0, 16)}…`);
  return Buffer.from(h, 'hex');
};
/** Display order (reversed) ⇄ internal order for txids, asset ids, block hashes. */
export const reversed = (b: Uint8Array): Buffer => Buffer.from(b).reverse();

/** Cryptographically secure random bytes (Web Crypto: browsers and Node ≥ 19). */
export function randomBytes(n: number): Buffer {
  const b = Buffer.alloc(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export const sha256 = (...parts: Uint8Array[]): Buffer => Buffer.from(nobleSha256(Buffer.concat(parts)));

/** BIP340 tagged hash: SHA-256(SHA-256(tag) ‖ SHA-256(tag) ‖ data). */
export const taggedHash = (tag: string, ...parts: Uint8Array[]): Buffer => {
  const t = sha256(Buffer.from(tag, 'utf8'));
  return sha256(t, t, ...parts);
};

export const u32be = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};

export const u64be = (n: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
};

/** Reads a Bitcoin compact-size integer at `pos`. */
export function readVarint(buf: Uint8Array, pos: number): [number, number] {
  const first = buf[pos];
  if (first === undefined) throw new Error('truncated varint');
  if (first < 0xfd) return [first, pos + 1];
  const len = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
  if (pos + 1 + len > buf.length) throw new Error('truncated varint');
  let n = 0;
  for (let i = len - 1; i >= 0; i--) n = n * 256 + buf[pos + 1 + i]!;
  return [n, pos + 1 + len];
}

/** Validates an amount (non-negative safe integer). */
export function amount(n: number, what = 'amount'): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${what} must be a non-negative integer`);
  return n;
}
