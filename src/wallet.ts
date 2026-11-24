// Single-key wallet: coin discovery (unblinding), confidential payments, issuance, reissuance.
// Every `build*` method returns a blinded, signed transaction; the plain method also sends it.
import * as liquid from 'liquidjs-lib';
import { Client, ChainInfo } from './client.js';
import { confidential, ecc, zkp } from './ecc.js';
import { amount as checkAmount, fromHex, hex, randomBytes, reversed } from './bytes.js';
import { destination } from './network.js';
import { Key } from './keys.js';
import type { TxOutLike } from './simplicity.js';
import { AssetMetadata, metadataContractHash, metadataScript, validateMetadata } from './metadata.js';

/** Default fee in fee-asset units (the node's minimum relay rate is 100 per 1000 vbytes). */
export const DEFAULT_FEE = 1_000;

const ZERO32 = Buffer.alloc(32);
const NULL_NONCE = Buffer.from([0]);

/** A spendable output with its opening. Assets are display hex; blinders internal bytes. */
export interface Coin {
  txid: string;
  vout: number;
  output: TxOutLike;
  asset: string;
  value: number;
  assetBlinder: Buffer;
  valueBlinder: Buffer;
  confidential: boolean;
}

/** An output's opening (one surjection-domain entry). */
export interface Opening {
  asset: string;
  value: number;
  assetBlinder: Buffer;
  valueBlinder: Buffer;
}

export const explicitOpening = (asset: string, value: number): Opening => ({ asset, value, assetBlinder: ZERO32, valueBlinder: ZERO32 });

const assetBytes = (asset: string): Buffer => reversed(fromHex(asset));
export const explicitAsset = (asset: string): Buffer => Buffer.concat([Buffer.from([1]), assetBytes(asset)]);
export const explicitValue = (value: number): Buffer => liquid.confidential.satoshiToConfidentialValue(checkAmount(value));

/** An output description; `blindingKey` marks it for blinding (Elements: carried in the nonce). */
export interface OutputSpec {
  script: Buffer;
  asset: string;
  value: number;
  blindingKey?: Buffer;
}

/** Confirmed coins locked to `script`, not spent in the mempool. Confidential outputs are
 *  unblinded with `blindingKey`; those it can't open (or all, without one) are skipped. */
export async function coinsAt(client: Client, script: Uint8Array, blindingKey?: Buffer): Promise<Coin[]> {
  const conf = await confidential();
  const txs = new Map<string, liquid.Transaction>();
  const out: Coin[] = [];
  for (const u of await client.scriptUtxos(script)) {
    if (u.spentInMempool) continue;
    let tx = txs.get(u.txid);
    if (!tx) {
      tx = await client.transaction(u.txid);
      txs.set(u.txid, tx);
    }
    const o = tx.outs[u.vout];
    if (!o) throw new Error(`${u.txid}:${u.vout} missing`);
    const output: TxOutLike = { script: o.script, asset: o.asset, value: o.value, nonce: o.nonce, rangeProof: o.rangeProof, surjectionProof: o.surjectionProof };
    if (o.asset[0] === 1 && o.value[0] === 1) {
      out.push({ txid: u.txid, vout: u.vout, output, asset: hex(reversed(o.asset.subarray(1))), value: liquid.confidential.confidentialValueToSatoshi(o.value), assetBlinder: ZERO32, valueBlinder: ZERO32, confidential: false });
      continue;
    }
    if (!blindingKey) continue;
    try {
      const r = conf.unblindOutputWithKey(o, blindingKey);
      out.push({ txid: u.txid, vout: u.vout, output, asset: hex(reversed(r.asset)), value: Number(r.value), assetBlinder: r.assetBlindingFactor, valueBlinder: r.valueBlindingFactor, confidential: true });
    } catch {
      // blinded to someone else's key
    }
  }
  return out;
}

/** Largest-first selection of `amount` of `asset` (removes what it takes from `pool`). */
export function select(pool: Coin[], asset: string, amount: number): { taken: Coin[]; total: number } {
  pool.sort((a, b) => b.value - a.value);
  const taken: Coin[] = [];
  let total = 0;
  while (total < amount) {
    const i = pool.findIndex((c) => c.asset === asset);
    if (i < 0) throw new Error(`insufficient funds in asset ${asset}: have ${total}, need ${amount}`);
    const [c] = pool.splice(i, 1);
    total += c!.value;
    taken.push(c!);
  }
  return { taken, total };
}

/**
 * Builds outputs, blinding the marked ones (Elements `Transaction::blind`): random asset
 * blinders, random value blinders except the last blinded output's, which balances the
 * commitments. `domain`: the opening of each surjection-domain entry in consensus order — per
 * input, its spent output, then its issuance pseudo-inputs (asset, then token).
 */
export async function addOutputs(tx: liquid.Transaction, specs: OutputSpec[], domain: Opening[]): Promise<void> {
  const conf = await confidential();
  const z = await zkp();
  const blinded = specs.map((s, i) => (s.blindingKey ? i : -1)).filter((i) => i >= 0);
  if (blinded.length === 0) {
    for (const s of specs) tx.addOutput(s.script, explicitValue(s.value), explicitAsset(s.asset), NULL_NONCE);
    return;
  }
  const abfs = specs.map((s) => (s.blindingKey ? randomScalar() : ZERO32));
  const vbfs = specs.map((s) => (s.blindingKey ? randomScalar() : ZERO32));
  const last = blinded[blinded.length - 1]!;
  // Σ inputs (v·abf + vbf) = Σ outputs: solve for the last blinded output's value blinder.
  const order = specs.map((_, i) => i).filter((i) => i !== last).concat([last]);
  vbfs[last] = conf.valueBlindingFactor(
    domain.map((d) => String(d.value)),
    order.map((i) => String(specs[i]!.value)),
    domain.map((d) => d.assetBlinder),
    order.map((i) => abfs[i]!),
    domain.map((d) => d.valueBlinder),
    order.slice(0, -1).map((i) => vbfs[i]!),
  );
  const inAssets = domain.map((d) => assetBytes(d.asset));
  const inAbfs = domain.map((d) => d.assetBlinder);
  specs.forEach((s, i) => {
    if (!s.blindingKey) {
      tx.addOutput(s.script, explicitValue(s.value), explicitAsset(s.asset), NULL_NONCE);
      return;
    }
    const asset = assetBytes(s.asset);
    const assetCommitment = Buffer.from(z.generator.generateBlinded(asset, abfs[i]!));
    const valueCommitment = conf.valueCommitment(String(s.value), assetCommitment, vbfs[i]!);
    const ephemeral = randomScalar();
    const nonce = Buffer.from(ecc.pointFromScalar(ephemeral, true)!);
    const rangeProof = conf.rangeProofWithNonceHash(s.blindingKey, ephemeral, String(s.value), asset, valueCommitment, assetCommitment, vbfs[i]!, abfs[i]!, s.script);
    const surjectionProof = conf.surjectionProof(asset, abfs[i]!, inAssets, inAbfs, randomBytes(32));
    tx.addOutput(s.script, valueCommitment, assetCommitment, nonce, rangeProof, surjectionProof);
  });
}

function randomScalar(): Buffer {
  for (;;) {
    const b = randomBytes(32);
    if (ecc.isPrivate(b)) return b;
  }
}

/** Signs every input on the key path (`SIGHASH_DEFAULT`, Elements taproot sighash). */
export function signKeyPath(tx: liquid.Transaction, prevouts: TxOutLike[], key: Key, genesisHash: string): void {
  const genesis = reversed(fromHex(genesisHash));
  const tweaked = key.tweakedPrivateKey();
  const scripts = prevouts.map((p) => p.script);
  const values = prevouts.map((p) => ({ asset: p.asset, value: p.value }));
  tx.ins.forEach((_, i) => {
    const hash = tx.hashForWitnessV1(i, scripts, values, liquid.Transaction.SIGHASH_DEFAULT, genesis);
    tx.setWitness(i, [Buffer.from(ecc.signSchnorr(hash, tweaked, randomBytes(32)))]);
  });
}

/** An unsigned version-2 transaction spending `inputs` (final sequences). */
export function unsignedTx(inputs: Coin[], sequence = 0xffffffff): liquid.Transaction {
  const tx = new liquid.Transaction();
  tx.version = 2;
  tx.locktime = 0;
  for (const c of inputs) tx.addInput(reversed(fromHex(c.txid)), c.vout, sequence);
  return tx;
}

export interface SendOptions {
  /** Asset to pay (display hex); default: the fee asset. */
  asset?: string;
  fee?: number;
}

export interface Issued {
  txid: string;
  asset: string;
  token: string;
}

export class Wallet {
  constructor(readonly client: Client, readonly key: Key) {}

  coins(): Promise<Coin[]> {
    return coinsAt(this.client, this.key.scriptPubkey(), this.key.blindingKey());
  }

  async balances(): Promise<Map<string, number>> {
    const m = new Map<string, number>();
    for (const c of await this.coins()) m.set(c.asset, (m.get(c.asset) ?? 0) + c.value);
    return m;
  }

  /** Pays `amount` to `to` (address or hex script); confidential when the destination is
   *  `wfc1…` or any selected coin is confidential (change then blinded to this key). */
  async buildSend(to: string, amount: number, opts: SendOptions = {}): Promise<liquid.Transaction> {
    const info = await this.client.chainInfo();
    const fee = checkAmount(opts.fee ?? DEFAULT_FEE, 'fee');
    const asset = opts.asset ?? info.feeAsset;
    const dest = destination(to);
    const need = new Map<string, number>();
    need.set(asset, (need.get(asset) ?? 0) + checkAmount(amount));
    need.set(info.feeAsset, (need.get(info.feeAsset) ?? 0) + fee);

    const pool = await this.coins();
    const inputs: Coin[] = [];
    const change: [string, number][] = [];
    for (const [a, n] of need) {
      const { taken, total } = select(pool, a, n);
      inputs.push(...taken);
      if (total > n) change.push([a, total - n]);
    }
    const isConfidential = !!dest.blindingKey || inputs.some((c) => c.confidential);
    if (isConfidential && !dest.blindingKey && change.length === 0) {
      // Confidential inputs need a blinded output: take one more coin for blinded change.
      const { taken, total } = select(pool, info.feeAsset, 1);
      inputs.push(...taken);
      change.push([info.feeAsset, total]);
    }
    const own = isConfidential ? this.key.blindingPublicKey() : undefined;
    const specs: OutputSpec[] = [{ script: dest.script, asset, value: amount, blindingKey: dest.blindingKey }];
    for (const [a, v] of change) specs.push({ script: this.key.scriptPubkey(), asset: a, value: v, blindingKey: own });
    specs.push({ script: Buffer.alloc(0), asset: info.feeAsset, value: fee });
    return this.#finish(info, unsignedTx(inputs), specs, inputs, []);
  }

  async send(to: string, amount: number, opts: SendOptions = {}): Promise<string> {
    return this.client.sendTransaction(await this.buildSend(to, amount, opts));
  }

  /** Issues `amount` of a new asset and `tokens` reissuance tokens (explicit amounts), paid
   *  confidentially to this key. */
  async buildIssue(
    amount: number,
    tokens = 1,
    fee = DEFAULT_FEE,
    metadata?: AssetMetadata,
  ): Promise<{ tx: liquid.Transaction; asset: string; token: string }> {
    if (metadata) validateMetadata(metadata);
    // New issuance: the contract hash is 0, or SHA-256 of the on-chain metadata.
    const contract = metadata ? metadataContractHash(metadata) : ZERO32;
    const info = await this.client.chainInfo();
    const { taken: inputs, total } = select(await this.coins(), info.feeAsset, fee + 1);
    const tx = unsignedTx(inputs);
    tx.ins[0]!.issuance = {
      assetBlindingNonce: ZERO32,
      assetEntropy: contract,
      assetAmount: explicitValue(amount),
      tokenAmount: tokens > 0 ? explicitValue(tokens) : Buffer.from([0]),
    };
    const entropy = liquid.issuance.generateEntropy({ txHash: tx.ins[0]!.hash, vout: tx.ins[0]!.index }, contract);
    const asset = hex(reversed(liquid.issuance.calculateAsset(entropy)));
    const token = hex(reversed(liquid.issuance.calculateReissuanceToken(entropy, false)));
    const own = this.key.blindingPublicKey();
    const me = this.key.scriptPubkey();
    const specs: OutputSpec[] = [{ script: me, asset, value: amount, blindingKey: own }];
    if (tokens > 0) specs.push({ script: me, asset: token, value: tokens, blindingKey: own });
    specs.push({ script: me, asset: info.feeAsset, value: total - fee, blindingKey: own });
    if (metadata) specs.push({ script: metadataScript(metadata), asset: info.feeAsset, value: 0 });
    specs.push({ script: Buffer.alloc(0), asset: info.feeAsset, value: fee });
    const extra = [explicitOpening(asset, amount)];
    if (tokens > 0) extra.push(explicitOpening(token, tokens));
    return { tx: await this.#finish(info, tx, specs, inputs, [extra]), asset, token };
  }

  /** Issues `amount` of a new asset (and `tokens` reissuance tokens); `metadata` names it on chain. */
  async issue(amount: number, tokens = 1, fee = DEFAULT_FEE, metadata?: AssetMetadata): Promise<Issued> {
    const { tx, asset, token } = await this.buildIssue(amount, tokens, fee, metadata);
    return { txid: await this.client.sendTransaction(tx), asset, token };
  }

  /** Reissues `amount` of `asset` with a held reissuance token (returned to this key). */
  async buildReissue(asset: string, amount: number, fee = DEFAULT_FEE): Promise<liquid.Transaction> {
    const info = await this.client.chainInfo();
    const record = await this.client.asset(asset);
    const token = record.reissuanceToken;
    if (!token) throw new Error(`${asset} has no reissuance token`);
    const pool = await this.coins();
    const i = pool.findIndex((c) => c.asset === token && c.confidential);
    if (i < 0) throw new Error(`no confidential reissuance token for ${asset}`);
    const [tokenCoin] = pool.splice(i, 1);
    const { taken, total } = select(pool, info.feeAsset, fee + 1);
    const inputs = [tokenCoin!, ...taken];
    const tx = unsignedTx(inputs);
    const entropy = fromHex(record.entropy);
    if (hex(reversed(liquid.issuance.calculateAsset(entropy))) !== asset) throw new Error(`issuance entropy does not derive ${asset}`);
    tx.ins[0]!.issuance = {
      assetBlindingNonce: tokenCoin!.assetBlinder,
      assetEntropy: entropy,
      assetAmount: explicitValue(amount),
      tokenAmount: Buffer.from([0]),
    };
    const own = this.key.blindingPublicKey();
    const me = this.key.scriptPubkey();
    const specs: OutputSpec[] = [
      { script: me, asset, value: amount, blindingKey: own },
      { script: me, asset: token, value: tokenCoin!.value, blindingKey: own },
      { script: me, asset: info.feeAsset, value: total - fee, blindingKey: own },
      { script: Buffer.alloc(0), asset: info.feeAsset, value: fee },
    ];
    return this.#finish(info, tx, specs, inputs, [[explicitOpening(asset, amount)]]);
  }

  async reissue(asset: string, amount: number, fee = DEFAULT_FEE): Promise<string> {
    return this.client.sendTransaction(await this.buildReissue(asset, amount, fee));
  }

  async #finish(info: ChainInfo, tx: liquid.Transaction, specs: OutputSpec[], inputs: Coin[], extra: Opening[][]): Promise<liquid.Transaction> {
    if (!specs.some((s) => s.blindingKey) && inputs.some((c) => c.confidential)) {
      throw new Error('spending confidential coins needs at least one blinded output');
    }
    const domain: Opening[] = [];
    inputs.forEach((c, i) => {
      domain.push({ asset: c.asset, value: c.value, assetBlinder: c.assetBlinder, valueBlinder: c.valueBlinder });
      domain.push(...(extra[i] ?? []));
    });
    await addOutputs(tx, specs, domain);
    signKeyPath(tx, inputs.map((c) => c.output), this.key, info.genesisHash);
    return tx;
  }
}
