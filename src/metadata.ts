// On-chain asset names (Wharfedale convention, not consensus): the issuance carries
// OP_RETURN <"WFA1"> <metadata> and its new-issuance contract hash is SHA-256(metadata), so the
// asset id commits to its name. Nodes verify and index it (/asset/:id → name, ticker, precision).
import { sha256 } from './bytes.js';

export interface AssetMetadata {
  name: string;
  ticker: string;
  precision: number;
}

export const METADATA_TAG = Buffer.from('WFA1', 'ascii');
export const METADATA_MAX_LEN = 128;

/** Canonical bytes: `{"name":…,"precision":…,"ticker":…}` (same as the Rust SDK). */
export function encodeMetadata(m: AssetMetadata): Buffer {
  return Buffer.from(JSON.stringify({ name: m.name.trim(), precision: m.precision, ticker: m.ticker }), 'utf8');
}

/** Same rules as the node's indexer. Throws with a readable message. */
export function validateMetadata(m: AssetMetadata): void {
  const name = m.name.trim();
  const chars = [...name].length;
  if (chars === 0 || chars > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new Error('asset name must be 1–64 characters');
  if (!/^[A-Z0-9]{1,8}$/.test(m.ticker)) throw new Error('ticker must be 1–8 characters A–Z or 0–9');
  if (!Number.isInteger(m.precision) || m.precision < 0 || m.precision > 8) throw new Error('precision must be 0–8');
  if (encodeMetadata(m).length > METADATA_MAX_LEN) throw new Error(`metadata exceeds ${METADATA_MAX_LEN} bytes`);
}

/** The issuance contract hash: SHA-256 of the canonical metadata. */
export function metadataContractHash(m: AssetMetadata): Buffer {
  return sha256(encodeMetadata(m));
}

/** `OP_RETURN <"WFA1"> <metadata>`, minimal pushes. */
export function metadataScript(m: AssetMetadata): Buffer {
  const data = encodeMetadata(m);
  const push = (b: Buffer) => (b.length < 0x4c ? Buffer.concat([Buffer.from([b.length]), b]) : Buffer.concat([Buffer.from([0x4c, b.length]), b]));
  return Buffer.concat([Buffer.from([0x6a]), push(METADATA_TAG), push(data)]);
}
