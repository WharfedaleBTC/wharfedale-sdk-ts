// Spending Simplicity contracts from TypeScript, without a SimplicityHL compiler: a
// signature-only contract compiled by the Rust SDK or `wharfedale-wallet contract-artifact`
// ({cmr, program, signatures}) is spent with witness = sig₁ ‖ sig₂ ‖ … over `sig_all_hash`.
import * as liquid from 'liquidjs-lib';
import { Client } from './client.js';
import { amount, fromHex } from './bytes.js';
import { destination } from './network.js';
import { Key } from './keys.js';
import { contractAddress, contractControlBlock, contractScriptPubkey, sigAllHash } from './simplicity.js';
import { addNeed, addOutputs, coinsAt, Coin, DEFAULT_FEE, OutputSpec, select, unsignedTx } from './wallet.js';

/** Output of `Contract::signature_artifact` (Rust SDK) / `wharfedale-wallet contract-artifact`. */
export interface SignatureArtifact {
  cmr: string;
  program: string;
  /** Witness names in witness order. */
  signatures: string[];
}

export interface ContractSpend {
  to: string;
  amount: number;
  asset?: string;
  fee?: number;
  /** Transaction lock time (block height), for contracts that check it. */
  lockTime?: number;
  /** A key per signature name in the artifact. */
  signers: Record<string, Key>;
}

export class SignatureContract {
  readonly cmr: Buffer;
  readonly program: Buffer;

  constructor(readonly artifact: SignatureArtifact) {
    this.cmr = fromHex(artifact.cmr);
    this.program = fromHex(artifact.program);
    if (this.cmr.length !== 32) throw new Error('cmr must be 32 bytes');
  }

  scriptPubkey(): Buffer {
    return contractScriptPubkey(this.cmr);
  }

  controlBlock(): Buffer {
    return contractControlBlock(this.cmr);
  }

  /** Explicit address `wf1p…` (contract outputs are not blinded). */
  address(): string {
    return contractAddress(this.cmr);
  }

  /** Explicit coins locked to the contract. */
  coins(client: Client): Promise<Coin[]> {
    return coinsAt(client, this.scriptPubkey());
  }

  /** `[witness, program, cmr, control_block]` for input `ix` of a finished transaction. */
  witnessStack(tx: liquid.Transaction, ix: number, prevouts: Coin['output'][], genesisHash: string, signers: Record<string, Key>): Buffer[] {
    const h = sigAllHash(tx, prevouts, ix, this.cmr, genesisHash);
    const sigs = this.artifact.signatures.map((name) => {
      const k = signers[name];
      if (!k) throw new Error(`no signer for ${name}`);
      return k.signSchnorr(h);
    });
    return [Buffer.concat(sigs), this.program, this.cmr, this.controlBlock()];
  }

  /** `amount` to `to`, fee from contract coins too, change back to the contract. */
  async buildSpend(client: Client, spend: ContractSpend): Promise<liquid.Transaction> {
    const info = await client.chainInfo();
    const asset = spend.asset ?? info.feeAsset;
    const fee = amount(spend.fee ?? DEFAULT_FEE, 'fee');
    if (spend.lockTime !== undefined && !(Number.isInteger(spend.lockTime) && spend.lockTime >= 0 && spend.lockTime < 500_000_000)) {
      throw new Error('lock time must be a block height below 500 000 000');
    }
    const dest = destination(spend.to);
    const need = new Map<string, number>();
    addNeed(need, asset, spend.amount);
    addNeed(need, info.feeAsset, fee);
    const pool = await this.coins(client);
    const inputs: Coin[] = [];
    const specs: OutputSpec[] = [{ script: dest.script, asset, value: spend.amount, blindingKey: dest.blindingKey }];
    for (const [a, n] of need) {
      const { taken, total } = select(pool, a, n);
      inputs.push(...taken);
      if (total > n) specs.push({ script: this.scriptPubkey(), asset: a, value: total - n });
    }
    specs.push({ script: Buffer.alloc(0), asset: info.feeAsset, value: fee });
    const tx = unsignedTx(inputs, spend.lockTime !== undefined ? 0xfffffffe : 0xffffffff);
    if (spend.lockTime !== undefined) tx.locktime = spend.lockTime;
    await addOutputs(tx, specs, inputs.map((c) => ({ asset: c.asset, value: c.value, assetBlinder: c.assetBlinder, valueBlinder: c.valueBlinder })));
    const prevouts = inputs.map((c) => c.output);
    // All outputs are final before any sig_all_hash is computed.
    const stacks = inputs.map((_, ix) => this.witnessStack(tx, ix, prevouts, info.genesisHash, spend.signers));
    stacks.forEach((s, ix) => tx.setWitness(ix, s));
    return tx;
  }

  async spend(client: Client, spend: ContractSpend): Promise<string> {
    return client.sendTransaction(await this.buildSpend(client, spend));
  }
}
