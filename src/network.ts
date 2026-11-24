// Chain constants shared by every Wharfedale network (must match the node and the Rust SDK).
import * as liquid from 'liquidjs-lib';
import { fromHex, hex, reversed, sha256 } from './bytes.js';

/**
 * liquidjs-lib network for address encoding: bech32m `wf1…` (explicit), blech32 `wfc1…`
 * (confidential). `genesisBlockHash` is not used: the SDK passes the chain's genesis hash
 * (from `getblockchaininfo`) explicitly.
 */
export const WHARFEDALE: liquid.networks.Network = {
  messagePrefix: '\x18Wharfedale Signed Message:\n',
  bech32: 'wf',
  blech32: 'wfc',
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  pubKeyHash: 73,
  scriptHash: 87,
  wif: 0x80,
  confidentialPrefix: 25,
  assetHash: '00'.repeat(32),
  genesisBlockHash: Buffer.alloc(32),
  name: 'wharfedale',
};

/** The fee asset of a chain: issuance from outpoint `0000…:0`, contract hash SHA-256(chain_id). */
export function feeAssetFor(chainId: string): string {
  const entropy = liquid.issuance.generateEntropy({ txHash: Buffer.alloc(32), vout: 0 }, sha256(Buffer.from(chainId, 'utf8')));
  return hex(reversed(liquid.issuance.calculateAsset(entropy)));
}

/** A payment destination: output script and, for a `wfc1…` address, its blinding key. */
export interface Destination {
  script: Buffer;
  blindingKey?: Buffer;
}

/** Parses a `wfc1…`/`wf1…` address or a hex output script. */
export function destination(to: string): Destination {
  const invalid = () => new Error(`invalid destination ${JSON.stringify(to)}: neither a Wharfedale address nor a hex script`);
  const lower = to.toLowerCase();
  if (lower.startsWith(`${WHARFEDALE.blech32}1`)) {
    // liquidjs-lib's `fromConfidential` only knows Liquid's prefixes: decode blech32 directly.
    try {
      const r = liquid.address.fromBlech32(to);
      return { script: r.data, blindingKey: r.pubkey };
    } catch {
      throw invalid();
    }
  }
  if (lower.startsWith(`${WHARFEDALE.bech32}1`)) {
    try {
      return { script: liquid.address.toOutputScript(to, WHARFEDALE) };
    } catch {
      throw invalid();
    }
  }
  let script: Buffer;
  try {
    script = fromHex(to);
  } catch {
    throw invalid();
  }
  // An empty script marks a fee output: the amount would go to the block's proposer as fees.
  if (script.length === 0) throw invalid();
  return { script };
}

/** Address of a segwit output script: `wf1…`, or `wfc1…` with a blinding public key. */
export function addressOf(script: Uint8Array, blindingKey?: Uint8Array): string {
  const s = Buffer.from(script);
  if (!blindingKey) return liquid.address.fromOutputScript(s, WHARFEDALE);
  const version = s[0] === 0 ? 0 : s[0]! - 0x50;
  return liquid.address.toBlech32(s, Buffer.from(blindingKey), WHARFEDALE.blech32, version);
}
