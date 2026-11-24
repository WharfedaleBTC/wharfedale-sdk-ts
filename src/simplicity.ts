// Simplicity on Wharfedale: contract outputs (single leaf 0xbe under the NUMS key) and
// `sig_all_hash`, ported from the Simplicity C library (`elements/env.c`, `txEnv.c`, `ops.c`;
// simplicity-sys 0.8) — the hash `jet::sig_all_hash()` returns and contract signatures sign.
import * as liquid from 'liquidjs-lib';
import { ecc } from './ecc.js';
import { fromHex, readVarint, reversed, sha256, taggedHash, u32be, u64be } from './bytes.js';
import { addressOf } from './network.js';

export const LEAF_VERSION = 0xbe;
/** BIP341's "H" point: no known discrete logarithm (no key path). */
export const NUMS = fromHex('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');

/** An output as hashed: consensus encodings of asset, value, nonce, plus script and proofs. */
export interface TxOutLike {
  script: Buffer;
  asset: Buffer;
  value: Buffer;
  nonce: Buffer;
  rangeProof?: Buffer;
  surjectionProof?: Buffer;
}

/** Parses a consensus-encoded TxOut without witness (asset ‖ value ‖ nonce ‖ script). */
export function parseTxOut(raw: Uint8Array): TxOutLike {
  const b = Buffer.from(raw);
  let pos = 0;
  const take = (n: number): Buffer => {
    if (pos + n > b.length) throw new Error('truncated TxOut');
    const s = b.subarray(pos, pos + n);
    pos += n;
    return Buffer.from(s);
  };
  const conf = (explicitLen: number): Buffer => {
    const p = b[pos];
    return take(p === 0 ? 1 : p === 1 ? explicitLen : 33);
  };
  const asset = conf(33);
  const value = conf(9);
  const nonce = conf(33);
  const [len, next] = readVarint(b, pos);
  pos = next;
  const script = take(len);
  if (pos !== b.length) throw new Error('trailing bytes after TxOut');
  return { script, asset, value, nonce };
}

/** Leaf hash of `(script = cmr, version 0xbe)`. */
export function tapLeafHash(cmr: Uint8Array): Buffer {
  return taggedHash('TapLeaf/elements', Buffer.from([LEAF_VERSION, 32]), cmr);
}

function tweaked(cmr: Uint8Array): { parity: number; outputKey: Buffer } {
  const t = taggedHash('TapTweak/elements', NUMS, tapLeafHash(cmr));
  const r = ecc.xOnlyPointAddTweak(NUMS, t);
  if (!r) throw new Error('tweak failed');
  return { parity: r.parity, outputKey: Buffer.from(r.xOnlyPubkey) };
}

/** `OP_1 <Q>` locking coins to the program with commitment Merkle root `cmr`. */
export function contractScriptPubkey(cmr: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([0x51, 0x20]), tweaked(cmr).outputKey]);
}

/** Control block: `(0xbe | parity) ‖ NUMS` (one leaf, empty path). */
export function contractControlBlock(cmr: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([LEAF_VERSION | tweaked(cmr).parity]), NUMS]);
}

/** Explicit address `wf1p…` of a contract. */
export function contractAddress(cmr: Uint8Array): string {
  return addressOf(contractScriptPubkey(cmr));
}

// ---- sig_all_hash ----

type Prefix = 'none' | 'explicit' | 'even' | 'odd';

function prefixOf(raw: Buffer | undefined): Prefix {
  if (!raw || raw.length <= 1) return 'none';
  return raw[0] === 1 ? 'explicit' : (raw[0]! & 1) === 1 ? 'odd' : 'even';
}

const isConfidential = (p: Prefix): boolean => p === 'even' || p === 'odd';

/** `sha256_confidential`: NONE → 0x00; explicit → 0x01 ‖ data; blinded → even/odd ‖ x. */
function confidentialBytes(raw: Buffer | undefined, even: number, odd: number): Buffer {
  const p = prefixOf(raw);
  if (p === 'none') return Buffer.from([0]);
  const tag = p === 'explicit' ? 1 : p === 'even' ? even : odd;
  return Buffer.concat([Buffer.from([tag]), raw!.subarray(1, 33)]);
}

const confAsset = (raw?: Buffer): Buffer => confidentialBytes(raw, 0x0a, 0x0b);
const confNonce = (raw?: Buffer): Buffer => confidentialBytes(raw, 0x02, 0x03);

/** `sha256_confAmt`; a null amount hashes as explicit 0. */
function confAmt(raw: Buffer | undefined): Buffer {
  const p = prefixOf(raw);
  if (p === 'none') return Buffer.concat([Buffer.from([1]), u64be(0n)]);
  if (p === 'explicit') return Buffer.concat([Buffer.from([1]), raw!.subarray(1, 9)]);
  return Buffer.concat([Buffer.from([p === 'even' ? 0x08 : 0x09]), raw!.subarray(1, 33)]);
}

/** BIP341 annex of a witness stack: ≥ 2 elements and the last starts with 0x50. */
function annexOf(witness: Buffer[]): Buffer | undefined {
  const last = witness[witness.length - 1];
  return witness.length >= 2 && last && last[0] === 0x50 ? last.subarray(1) : undefined;
}

const EMPTY_HASH = sha256();

/**
 * `sig_all_hash` of input `ix`: SHA-256(genesis ‖ genesis ‖ txHash ‖ tapEnvHash ‖ ix).
 *
 * @param tx the spending transaction (witnesses other than annexes don't matter)
 * @param prevouts the output spent by each input
 * @param cmr the program's commitment Merkle root
 * @param controlBlock the input's control block (default: single-leaf contract of `cmr`)
 * @param genesisHash the chain's genesis hash, display (RPC) hex
 */
export function sigAllHash(
  tx: liquid.Transaction,
  prevouts: TxOutLike[],
  ix: number,
  cmr: Uint8Array,
  genesisHash: string,
  controlBlock: Uint8Array = contractControlBlock(cmr),
): Buffer {
  if (prevouts.length !== tx.ins.length) throw new Error('one prevout per input');
  if (ix < 0 || ix >= tx.ins.length) throw new Error('input index out of range');
  const outpoints: Buffer[] = [];
  const inAssetAmounts: Buffer[] = [];
  const inScripts: Buffer[] = [];
  const sequences: Buffer[] = [];
  const annexes: Buffer[] = [];
  const scriptSigs: Buffer[] = [];
  const issAssetAmounts: Buffer[] = [];
  const issTokenAmounts: Buffer[] = [];
  const issRangeProofs: Buffer[] = [];
  const issBlindingEntropy: Buffer[] = [];

  tx.ins.forEach((input, i) => {
    const prev = prevouts[i]!;
    // Peg-ins are invalid on Wharfedale: always "not a peg-in".
    outpoints.push(Buffer.from([0]), Buffer.from(input.hash), u32be(input.index));
    inAssetAmounts.push(confAsset(prev.asset), confAmt(prev.value));
    inScripts.push(sha256(prev.script));
    sequences.push(u32be(input.sequence));
    const annex = annexOf(input.witness ?? []);
    annexes.push(annex ? Buffer.concat([Buffer.from([1]), sha256(annex)]) : Buffer.from([0]));
    scriptSigs.push(sha256(input.script ?? Buffer.alloc(0)));

    const iss = input.issuance;
    const amountRaw = iss && prefixOf(iss.assetAmount) !== 'none' ? iss.assetAmount : undefined;
    const tokenRaw = iss && prefixOf(iss.tokenAmount) !== 'none' ? iss.tokenAmount : undefined;
    let assetRangeProofHash = EMPTY_HASH;
    let tokenRangeProofHash = EMPTY_HASH;
    if (!iss || (!amountRaw && !tokenRaw)) {
      issAssetAmounts.push(Buffer.from([0, 0]));
      issTokenAmounts.push(Buffer.from([0, 0]));
      issBlindingEntropy.push(Buffer.from([0]));
    } else {
      const nonce = Buffer.from(iss.assetBlindingNonce);
      const amountPrefix = prefixOf(amountRaw);
      if (isConfidential(amountPrefix)) assetRangeProofHash = sha256(input.issuanceRangeProof ?? Buffer.alloc(0));
      const isNew = nonce.every((b) => b === 0);
      let entropy: Buffer;
      if (isNew) {
        const contract = Buffer.from(iss.assetEntropy);
        entropy = liquid.issuance.generateEntropy({ txHash: Buffer.from(input.hash), vout: input.index }, contract);
        if (isConfidential(prefixOf(tokenRaw))) tokenRangeProofHash = sha256(input.inflationRangeProof ?? Buffer.alloc(0));
        issBlindingEntropy.push(Buffer.from([1]), Buffer.alloc(32), contract);
      } else {
        entropy = Buffer.from(iss.assetEntropy);
        issBlindingEntropy.push(Buffer.from([1]), nonce, entropy);
      }
      const assetId = liquid.issuance.calculateAsset(entropy);
      const tokenId = liquid.issuance.calculateReissuanceToken(entropy, isConfidential(amountPrefix));
      issAssetAmounts.push(Buffer.from([1]), assetId, confAmt(amountRaw));
      issTokenAmounts.push(Buffer.from([1]), tokenId, isNew ? confAmt(tokenRaw) : confAmt(undefined));
    }
    issRangeProofs.push(assetRangeProofHash, tokenRangeProofHash);
  });

  const outAssetAmounts: Buffer[] = [];
  const outNonces: Buffer[] = [];
  const outScripts: Buffer[] = [];
  const outRangeProofs: Buffer[] = [];
  const outSurjectionProofs: Buffer[] = [];
  for (const o of tx.outs) {
    outAssetAmounts.push(confAsset(o.asset), confAmt(o.value));
    outNonces.push(confNonce(o.nonce));
    outScripts.push(sha256(o.script));
    outRangeProofs.push(sha256(isConfidential(prefixOf(o.value)) ? (o.rangeProof ?? Buffer.alloc(0)) : Buffer.alloc(0)));
    outSurjectionProofs.push(sha256(isConfidential(prefixOf(o.asset)) ? (o.surjectionProof ?? Buffer.alloc(0)) : Buffer.alloc(0)));
  }

  const inputsHash = sha256(sha256(...outpoints), sha256(...sequences), sha256(...annexes));
  const inputUtxosHash = sha256(sha256(...inAssetAmounts), sha256(...inScripts));
  const issuancesHash = sha256(sha256(...issAssetAmounts), sha256(...issTokenAmounts), sha256(...issRangeProofs), sha256(...issBlindingEntropy));
  const outputsHash = sha256(sha256(...outAssetAmounts), sha256(...outNonces), sha256(...outScripts), sha256(...outRangeProofs));
  const txHash = sha256(u32be(tx.version), u32be(tx.locktime), inputsHash, outputsHash, issuancesHash, sha256(...outSurjectionProofs), inputUtxosHash);
  void scriptSigs; // committed by the jets that read them, not by sig_all_hash

  const cb = Buffer.from(controlBlock);
  if (cb.length < 33 || (cb.length - 33) % 32 !== 0) throw new Error('control block size');
  const leaf = taggedHash('TapLeaf/elements', Buffer.from([cb[0]! & 0xfe, 32]), cmr);
  const path: Buffer[] = [];
  for (let p = 33; p < cb.length; p += 32) path.push(cb.subarray(p, p + 32));
  const tapEnvHash = sha256(leaf, sha256(...path), cb.subarray(1, 33));

  const genesis = reversed(fromHex(genesisHash));
  return sha256(genesis, genesis, txHash, tapEnvHash, u32be(ix));
}
