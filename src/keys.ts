// Wallet keys: one secret → key-path taproot output, blinding key, `wfc1…`/`wf1…` addresses.
import { generateMnemonic as bip39Generate, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { HDKey } from '@scure/bip32';
import { ecc } from './ecc.js';
import { fromHex, hex, randomBytes, sha256, taggedHash } from './bytes.js';
import { addressOf } from './network.js';

/** BIP32 path of the wallet key under a recovery phrase: BIP86 (taproot), coin type 1. */
export const DERIVATION_PATH = "m/86'/1'/0'/0/0";

/** A new BIP39 recovery phrase (English), 12 or 24 words. */
export function generateMnemonic(words: 12 | 24 = 12): string {
  return bip39Generate(wordlist, words === 24 ? 256 : 128);
}

const normalizePhrase = (p: string): string => p.trim().split(/\s+/).join(' ').toLowerCase();

/** Whether `phrase` is a valid BIP39 English phrase (checksum included). */
export function isValidMnemonic(phrase: string): boolean {
  return validateMnemonic(normalizePhrase(phrase), wordlist);
}

// Key files use `fs` only under Node (no static import: browser bundles stay clean).
interface NodeFs {
  readFileSync(p: string, e: 'utf8'): string;
  writeFileSync(p: string, d: string, o: { mode: number }): void;
  chmodSync(p: string, mode: number): void;
}

function nodeFs(): NodeFs {
  const get = (globalThis as { process?: { getBuiltinModule?: (m: string) => unknown } }).process?.getBuiltinModule;
  const fs = get?.('node:fs');
  if (!fs) throw new Error('key files need Node.js ≥ 22.3');
  return fs as NodeFs;
}

export class Key {
  readonly #secret: Buffer;

  private constructor(secret: Buffer) {
    if (secret.length !== 32 || !ecc.isPrivate(secret)) throw new Error('invalid secret key');
    this.#secret = secret;
  }

  /** Parses key-file JSON (`{"secret": "<64 hex>"}`); works in browsers. */
  static fromJson(json: string): Key {
    const v = JSON.parse(json) as { secret?: string };
    if (typeof v.secret !== 'string') throw new Error('key file has no "secret"');
    return Key.fromSecret(v.secret);
  }

  /** Key-file JSON for this key. */
  toJson(): string {
    return JSON.stringify({ secret: hex(this.#secret) }, null, 2);
  }

  static fromSecret(secret: Uint8Array | string): Key {
    return new Key(typeof secret === 'string' ? fromHex(secret) : Buffer.from(secret));
  }

  /** The key of a BIP39 recovery phrase (checksum verified, no passphrase) at `path`. */
  static fromMnemonic(phrase: string, path = DERIVATION_PATH): Key {
    const p = normalizePhrase(phrase);
    if (!validateMnemonic(p, wordlist)) throw new Error('invalid recovery phrase');
    const child = HDKey.fromMasterSeed(mnemonicToSeedSync(p)).derive(path);
    if (!child.privateKey) throw new Error('derivation failed');
    return new Key(Buffer.from(child.privateKey));
  }

  static generate(): Key {
    for (;;) {
      const s = randomBytes(32);
      if (ecc.isPrivate(s)) return new Key(s);
    }
  }

  /** Key file `{"secret": "<64 hex>"}` (same format as node keys and the Rust SDK). Node only. */
  static load(path: string): Key {
    const v = JSON.parse(nodeFs().readFileSync(path, 'utf8')) as { secret?: string };
    if (typeof v.secret !== 'string') throw new Error('key file has no "secret"');
    return Key.fromSecret(v.secret);
  }

  /** Writes the key file readable by its owner only (mode 0600 on Unix, also when it exists). */
  save(path: string): void {
    const fs = nodeFs();
    // `mode` applies only to a new file: tighten an existing one before writing the secret.
    fs.writeFileSync(path, '', { mode: 0o600 });
    fs.chmodSync(path, 0o600);
    fs.writeFileSync(path, this.toJson(), { mode: 0o600 });
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
