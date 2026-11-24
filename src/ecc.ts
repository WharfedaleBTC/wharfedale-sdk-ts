// Elliptic-curve backends: @bitcoinerlab/secp256k1 (pure JS, tiny-secp256k1 interface: Schnorr,
// taproot tweaks) and secp256k1-zkp (WASM: commitments, range and surjection proofs, loaded once).
import * as ecc from '@bitcoinerlab/secp256k1';
import * as zkpModule from '@vulpemventures/secp256k1-zkp';
import type { Secp256k1ZKP } from '@vulpemventures/secp256k1-zkp';
import * as liquid from 'liquidjs-lib';

export { ecc };

export type Zkp = Secp256k1ZKP;

// A CommonJS module with `exports.default`: unwrap whichever shape the loader gives.
const loadZkp: () => Promise<Zkp> = (() => {
  const m = zkpModule as unknown as { default?: unknown };
  const d = m.default as { default?: unknown } | undefined;
  return (typeof d === 'function' ? d : d?.default) as () => Promise<Zkp>;
})();

let zkpPromise: Promise<Zkp> | undefined;

/** The secp256k1-zkp module (WASM), initialised on first use. */
export function zkp(): Promise<Zkp> {
  zkpPromise ??= loadZkp();
  return zkpPromise;
}

/** liquidjs-lib's confidential helper bound to the WASM module. */
export async function confidential(): Promise<liquid.confidential.Confidential> {
  return new liquid.confidential.Confidential((await zkp()) as never);
}

