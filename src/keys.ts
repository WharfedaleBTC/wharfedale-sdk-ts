// Wallet keys: one secret → key-path taproot output, blinding key, `wfc1…`/`wf1…` addresses.
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { ecc } from './ecc.js';
import { fromHex, hex, sha256, taggedHash } from './bytes.js';
import { addressOf } from './network.js';

export class Key {
  readonly #secret: Buffer;

  private constructor(secret: Buffer) {
    if (secret.length !== 32 || !ecc.isPrivate(secret)) throw new Error('invalid secret key');
    this.#secret = secret;
  }

  static fromSecret(secret: Uint8Array | string): Key {
    return new Key(typeof secret === 'string' ? fromHex(secret) : Buffer.from(secret));
  }

  static generate(): Key {
    for (;;) {
      const s = randomBytes(32);
      if (ecc.isPrivate(s)) return new Key(s);
    }
  }

  /** Key file `{"secret": "<64 hex>"}` (same format as node keys and the Rust SDK). */
  static load(path: string): Key {
    const v = JSON.parse(readFileSync(path, 'utf8')) as { secret?: string };
    if (typeof v.secret !== 'string') throw new Error('key file has no "secret"');
    return Key.fromSecret(v.secret);
  }

  save(path: string): void {
    writeFileSync(path, JSON.stringify({ secret: hex(this.#secret) }, null, 2));
  }

  secretBytes(): Buffer {
    return Buffer.from(this.#secret);
  }

  /** x-only public key (untweaked): taproot internal key, and what contracts check. */
  xOnlyPublicKey(): Buffer {
    return Buffer.from(ecc.xOnlyPointFromScalar(this.#secret));
  }

  /** Taproot tweak of a key-path-only output: H_TapTweak/elements(P). */
  #tweak(): Buffer {
    return taggedHash('TapTweak/elements', this.xOnlyPublicKey());
  }

  /** Output key Q = P + tweak·G. */
  outputKey(): Buffer {
    const r = ecc.xOnlyPointAddTweak(this.xOnlyPublicKey(), this.#tweak());
    if (!r) throw new Error('tweak failed');
    return Buffer.from(r.xOnlyPubkey);
  }

  /** Private key of Q (negated first if P has an odd y). Signs key-path spends. */
  tweakedPrivateKey(): Buffer {
    const p = ecc.pointFromScalar(this.#secret, true)!;
    const d = p[0] === 3 ? ecc.privateNegate(this.#secret) : this.#secret;
    const t = ecc.privateAdd(d, this.#tweak());
    if (!t) throw new Error('tweak failed');
    return Buffer.from(t);
  }

  /** BIP340 signature with the untweaked key (contract `"sign:"` witnesses). */
  signSchnorr(message: Uint8Array): Buffer {
    return Buffer.from(ecc.signSchnorr(message, this.#secret, randomBytes(32)));
  }

  /** `OP_1 <Q>`. */
  scriptPubkey(): Buffer {
    return Buffer.concat([Buffer.from([0x51, 0x20]), this.outputKey()]);
  }

  /** Blinding key: SHA-256("wharfedale/blinding-key" ‖ secret). */
  blindingKey(): Buffer {
    return sha256(Buffer.from('wharfedale/blinding-key', 'utf8'), this.#secret);
  }

  blindingPublicKey(): Buffer {
    return Buffer.from(ecc.pointFromScalar(this.blindingKey(), true)!);
  }

  /** Confidential address `wfc1p…`. */
  address(): string {
    return addressOf(this.scriptPubkey(), this.blindingPublicKey());
  }

  /** Explicit address `wf1p…`. */
  explicitAddress(): string {
    return addressOf(this.scriptPubkey());
  }
}
