# @wharfedale/sdk (TypeScript)

TypeScript SDK for Wharfedale (Elements transaction format). Node ≥ 20, ESM. Built on
liquidjs-lib (transactions, sighash), secp256k1-zkp (WASM: commitments, range and surjection
proofs), tiny-secp256k1 (Schnorr, taproot) and @noble/hashes.

| Export | Contents |
|---|---|
| `Key` | Secret → key-path taproot output, blinding key, `wfc1…` / `wf1…` addresses, key files |
| `Client` | `fetch`-based JSON-RPC + Esplora REST client |
| `Wallet` | Coins (unblinded), balances, `send` / `issue` / `reissue` (`build*` without broadcasting) |
| `addOutputs`, `signKeyPath`, `select`, … | Blinding (Elements `Transaction::blind` algorithm) and signing building blocks |
| `SignatureContract` | Spend a signature-only Simplicity contract from its artifact |
| `sigAllHash`, `contractScriptPubkey`, `contractAddress`, `contractControlBlock` | Simplicity on Wharfedale (port of the C library's `sig_all_hash`) |
| `destination`, `feeAssetFor`, `WHARFEDALE` | Addresses and constants |

```ts
import { Client, Key, Wallet } from '@wharfedale/sdk';

const wallet = new Wallet(new Client('http://127.0.0.1:18443'), Key.load('alice.json'));
const txid = await wallet.send('wfc1p…', 100_000);
await wallet.client.waitForTx(txid);
```

## Contracts

There is no SimplicityHL compiler in JS. Compile with the Rust SDK
(`Contract::signature_artifact`) or `wharfedale-wallet contract-artifact --program p2pk.simf
--args args.json`, which gives `{cmr, program, signatures}` for branch-free programs whose
witness is only signatures (p2pk, timelock + signature, n-of-n). Then:

```ts
const c = new SignatureContract(artifact);
await faucet.send(c.address(), 100_000);
await c.spend(client, { to: alice.key.address(), amount: 50_000, signers: { SIG: owner } });
```

The witness is `sig₁ ‖ sig₂ ‖ …` in artifact order, each a BIP340 signature over `sigAllHash`.

## Tests

| | |
|---|---|
| `npm test` | Vectors from the Rust SDK (`test/vectors.json`): keys, addresses, fee assets, contract outputs, `sig_all_hash` |
| `npm run test:e2e` | Against a network: `WHARFEDALE_RPC`, `WHARFEDALE_FAUCET`, optional `WHARFEDALE_RPC2` |

Dependencies are pinned exactly; `.npmrc` sets `ignore-scripts=true`.
