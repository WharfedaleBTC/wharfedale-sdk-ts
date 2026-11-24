# @wharfedale/sdk (TypeScript)

TypeScript SDK for Wharfedale, a private layer-1 using the Elements (Liquid) transaction format:
confidential assets, issuance, and Simplicity contracts. It runs on Node ≥ 20 (ESM) and talks
to any node's JSON-RPC and Esplora REST API.

It is built on:
- liquidjs-lib: transactions and the taproot sighash;
- secp256k1-zkp (WASM): commitments, range proofs and surjection proofs;
- tiny-secp256k1: Schnorr signatures and taproot tweaks;
- @noble/hashes.

## What you can do

| Task | API |
|---|---|
| Create, save and load keys; derive confidential `wfc1…` and explicit `wf1…` addresses | [`Key`](#keys-and-addresses) |
| Read chain state, transactions, assets and address history from a node | [`Client`](#talking-to-a-node) |
| Find your coins (confidential ones are unblinded automatically) and see balances | [`Wallet.coins`, `Wallet.balances`](#balances) |
| Pay confidentially or explicitly, in the fee asset or any issued asset | [`Wallet.send`](#payments) |
| Build and inspect a transaction without broadcasting; dry-run it on the node | [`Wallet.buildSend`, `Client.testAccept`](#build-dry-run-broadcast) |
| Issue new assets with reissuance tokens; reissue more later | [`Wallet.issue`, `Wallet.reissue`](#issuing-assets) |
| Assemble custom transactions: coin selection, blinding, signing | [`select`, `addOutputs`, `signKeyPath`](#custom-transactions) |
| Lock coins to Simplicity contracts and spend them | [`SignatureContract`](#simplicity-contracts) |
| Time-locked contracts (covenants enforced by every validator) | [Time-locked contract](#time-locked-contract) |
| Sign contract spends with an external signer | [`sigAllHash`](#external-signing) |

Every snippet below is a file in `examples/`. `npm run typecheck` type-checks them, and
`npm test` checks that this README matches the files. All of them have been run against a
4-node network (see [Running the examples](#running-the-examples)).

## Install

The package is not on npm. Build it and depend on the folder:

```bash
npm install --ignore-scripts && npm run build
```

```json
{ "dependencies": { "@wharfedale/sdk": "file:../wharfedale-sdk-ts" } }
```

## Keys and addresses

One 32-byte secret gives everything a wallet needs:

- **Output script**: key-path-only taproot `OP_1 <Q>`.
- **Blinding key**: SHA-256("wharfedale/blinding-key" ‖ secret).
- **Confidential address** `wfc1p…`: what you hand out to get paid privately.
- **Explicit address** `wf1p…`: amounts and assets visible on chain.

Keys and addresses are identical to the Rust SDK's, and the shared test vectors check this.

```ts
// examples/keys.ts
// Create, save and load a key; derive its addresses.
import { Key } from '@wharfedale/sdk';

const key = Key.generate();
key.save('alice.json'); // {"secret": "<hex>"}, same format as node keys and the Rust SDK
const alice = Key.load('alice.json');

console.log('confidential:', alice.address()); // wfc1p…
console.log('explicit:    ', alice.explicitAddress()); // wf1p…
console.log('pubkey:      ', alice.xOnlyPublicKey().toString('hex')); // for contract arguments
```

## Talking to a node

`Client` covers JSON-RPC (`call`) and Esplora REST (`rest`, `restText`), which the node serves on
the same base URL.

```ts
// examples/node.ts
// Chain state, Esplora queries and raw JSON-RPC.
import { Client } from '@wharfedale/sdk';

const client = new Client(process.env.WHARFEDALE_RPC ?? 'http://127.0.0.1:18443');
const info = await client.chainInfo();
console.log(`${info.chain} at height ${info.blocks}, fee asset ${info.feeAsset}`);

const tip = await client.restText('blocks/tip/hash');
const block = await client.rest<{ tx_count: number }>(`block/${tip}`);
console.log(`tip has ${block.tx_count} transactions`);

console.log('mempool:', await client.call<string[]>('getrawmempool'));
```

## Balances

`Wallet` pairs a key with a client. `coins()` returns confirmed outputs paying the key that are
not already spent in the node's mempool. Confidential outputs are unblinded with the key's
blinding key: you see their asset and amount, while everyone else sees only commitments.
Amounts are numbers (every valid amount is below 2⁵³). Assets are display-order hex, as RPC
and Esplora show them.

```ts
// examples/balances.ts
// Coins (confidential ones unblinded with the key's blinding key) and balances.
import { Client, Key, Wallet } from '@wharfedale/sdk';

const wallet = new Wallet(new Client(process.env.WHARFEDALE_RPC ?? 'http://127.0.0.1:18443'), Key.load('alice.json'));

for (const [asset, amount] of await wallet.balances()) console.log(`${asset}: ${amount}`);
for (const coin of await wallet.coins()) {
  console.log(`${coin.txid}:${coin.vout}  ${coin.value} of ${coin.asset}  (${coin.confidential ? 'confidential' : 'explicit'})`);
}
```

## Payments

`send` picks coins (largest first), adds change and a fee output, blinds, signs every input
and broadcasts:

- To a `wfc1…` address, the payment is blinded to the receiver: amount and asset are hidden on
  chain.
- Change is blinded back to you whenever the transaction is confidential (a confidential
  destination, or any confidential coin spent).
- To a `wf1…` address or a raw hex script, the payment is explicit.

```ts
// examples/payments.ts
// Confidential and explicit payments.
import { Client, Key, Wallet } from '@wharfedale/sdk';

const client = new Client(process.env.WHARFEDALE_RPC ?? 'http://127.0.0.1:18443');
const alice = new Wallet(client, Key.load('alice.json'));
const bob = Key.load('bob.json');

// To a wfc1 address: amount and asset are blinded to Bob. Fee: 1 000 units by default.
const txid = await alice.send(bob.address(), 250_000);
console.log(`${txid} confirmed at ${await client.waitForTx(txid)}`);

// An issued asset, explicitly (wf1 address), with a larger fee.
const asset = process.env.ASSET ?? '6e8da0e6433b5189d819180caeab100f1f8a88e58feabcbcaa2a357d2d28f0f6';
await alice.send(bob.explicitAddress(), 10, { asset, fee: 2_000 });
```

## Build, dry-run, broadcast

Every operation has a `build…` form that returns the signed `liquidjs-lib` `Transaction`
without sending it. `testAccept` asks the node whether it would accept it
(`testmempoolaccept`, which never changes the node's mempool).

```ts
// examples/dry-run.ts
// Build without broadcasting, inspect, dry-run on the node, then send.
import { Client, Key, Wallet } from '@wharfedale/sdk';

const client = new Client(process.env.WHARFEDALE_RPC ?? 'http://127.0.0.1:18443');
const alice = new Wallet(client, Key.load('alice.json'));
const bob = Key.load('bob.json');

const tx = await alice.buildSend(bob.address(), 1_000);
console.log(`txid ${tx.getId()}, weight ${tx.weight()}`);
tx.outs.forEach((out, i) => console.log(`output ${i}: confidential value = ${out.value[0] !== 1}`));

const reason = await client.testAccept(tx); // never changes the node's mempool
console.log(reason === undefined ? `accepted: ${await client.sendTransaction(tx)}` : `the node would reject it: ${reason}`);
```

## Issuing assets

`issue` creates a new asset from one of your inputs, with optional reissuance tokens. The asset
and tokens are paid confidentially to you. Whoever holds a token can `reissue` (mint more)
later; the token comes back to you. Supply is public: issued amounts are explicit, and
`client.asset(id)` reports the totals.

```ts
// examples/issue.ts
// Issue an asset with a reissuance token, reissue, then pay with it.
import { Client, Key, Wallet } from '@wharfedale/sdk';

const client = new Client(process.env.WHARFEDALE_RPC ?? 'http://127.0.0.1:18443');
const issuer = new Wallet(client, Key.load('alice.json'));

// 1 000 000 units and 1 reissuance token (0 tokens = fixed supply). Fee 1 000.
const issued = await issuer.issue(1_000_000, 1, 1_000);
await client.waitForTx(issued.txid);
console.log(`asset ${issued.asset}, reissuance token ${issued.token}`);

// Reissuing reads the issuance record, which the node indexes shortly after the block.
while (!(await client.asset(issued.asset).then(() => true, () => false))) await new Promise((r) => setTimeout(r, 250));
await client.waitForTx(await issuer.reissue(issued.asset, 500_000));
console.log('supply now', (await client.asset(issued.asset)).issuedAmount);

await issuer.send(Key.load('bob.json').address(), 42, { asset: issued.asset });
```

## Custom transactions

The steps `send` uses are exported, so you can shape a transaction yourself. Here one
transaction pays two receivers, one confidentially and one explicitly:

- `select`: largest-first coin selection.
- `unsignedTx`: inputs.
- `addOutputs`: outputs, blinding the ones that have a `blindingKey`. It uses the same
  algorithm as rust-elements `Transaction::blind`: the last blinded output's value blinder
  balances the commitments.
- `signKeyPath`: Elements taproot key-path signatures.

```ts
// examples/custom-tx.ts
// One transaction, two payees (one confidential, one explicit), built from the SDK's parts.
import { Client, Key, Wallet, destination, select, unsignedTx, addOutputs, signKeyPath } from '@wharfedale/sdk';

const client = new Client(process.env.WHARFEDALE_RPC ?? 'http://127.0.0.1:18443');
const key = Key.load('alice.json');
const wallet = new Wallet(client, key);
const info = await client.chainInfo();
const fee = 1_500;

const bob = destination(Key.load('bob.json').address()); // wfc1: script + blinding key
const carol = destination(Key.load('carol.json').explicitAddress()); // wf1: script only
const [payBob, payCarol] = [100_000, 50_000];

const { taken: inputs, total } = select(await wallet.coins(), info.feeAsset, payBob + payCarol + fee);
const tx = unsignedTx(inputs);
await addOutputs(
  tx,
  [
    { script: bob.script, asset: info.feeAsset, value: payBob, blindingKey: bob.blindingKey },
    { script: carol.script, asset: info.feeAsset, value: payCarol },
    { script: key.scriptPubkey(), asset: info.feeAsset, value: total - payBob - payCarol - fee, blindingKey: key.blindingPublicKey() },
    { script: Buffer.alloc(0), asset: info.feeAsset, value: fee }, // fee output: empty script
  ],
  // Surjection domain: the opening of each spent coin, in input order.
  inputs.map((c) => ({ asset: c.asset, value: c.value, assetBlinder: c.assetBlinder, valueBlinder: c.valueBlinder })),
);
signKeyPath(tx, inputs.map((c) => c.output), key, info.genesisHash);
console.log(await client.sendTransaction(tx));
```

Rules the node enforces (see the node docs, "Validation"):

- Outputs are taproot, fee (empty script) or `OP_RETURN` (explicit only).
- A transaction spending confidential coins needs at least one blinded output.
- Fees are paid in the chain's fee asset (`chainInfo().feeAsset`). The minimum is 100 units per
  1 000 vbytes.

## Simplicity contracts

Contracts are SimplicityHL programs. A program's commitment Merkle root (CMR) defines a taproot
output with one Simplicity leaf and no key path, so coins there move only when the program
accepts the spending transaction. Every validator runs the program.

There is no SimplicityHL compiler for JavaScript. Compile once with the Rust SDK
(`Contract::signature_artifact`) or the CLI:

```bash
echo '{"OWNER": "0x'$(wharfedale-wallet pubkey --key bob.json)'"}' > p2pk.args
wharfedale-wallet contract-artifact --program contracts/p2pk.simf --args p2pk.args > p2pk.artifact.json
# {"cmr": "…", "program": "…", "signatures": ["SIG"]}
```

`SignatureContract` spends contracts that have no branches and whose witness is only
signatures: pay-to-public-key, time lock + signature, n-of-n multisig. For each input it
computes Simplicity's `sig_all_hash` (a port of the C library's, checked against
rust-simplicity on test vectors). Each named signer signs it with BIP340. The witness is the
signatures concatenated in artifact order.

`contracts/p2pk.simf`:

```text
fn main() {
    jet::bip_0340_verify((param::OWNER, jet::sig_all_hash()), witness::SIG)
}
```

```ts
// examples/contract.ts
// Lock coins to a p2pk Simplicity contract and spend them with the owner's signature.
// The artifact comes from the Rust SDK or `wharfedale-wallet contract-artifact`.
import { readFileSync } from 'node:fs';
import { Client, Key, Wallet, SignatureContract, type SignatureArtifact } from '@wharfedale/sdk';

const client = new Client(process.env.WHARFEDALE_RPC ?? 'http://127.0.0.1:18443');
const funder = new Wallet(client, Key.load('faucet.json'));
const bob = Key.load('bob.json'); // the contract's OWNER
const alice = Key.load('alice.json');

const artifact = JSON.parse(readFileSync('p2pk.artifact.json', 'utf8')) as SignatureArtifact;
const p2pk = new SignatureContract(artifact);
console.log(`contract ${p2pk.address()} (cmr ${artifact.cmr}), witness: ${artifact.signatures.join(', ')}`);

// Anyone can pay the contract (contract outputs are explicit).
await client.waitForTx(await funder.send(p2pk.address(), 100_000));

// A wrong signer: the node runs the program and rejects it (dry run).
const forged = await p2pk.buildSpend(client, { to: alice.address(), amount: 60_000, signers: { SIG: Key.generate() } });
console.log('forged:', await client.testAccept(forged)); // "invalid: input 0: Simplicity program rejected: EXEC_JET"

// The owner: fee from the contract, change back to it.
const txid = await p2pk.spend(client, { to: alice.address(), amount: 60_000, signers: { SIG: bob } });
await client.waitForTx(txid);
const left = (await p2pk.coins(client)).reduce((sum, c) => sum + c.value, 0);
console.log(`left in contract: ${left}`); // 100 000 − 60 000 − 1 000
```

Contracts with branches, or with witnesses other than signatures (hash locks, oracle data), need
the Rust SDK, which compiles and satisfies any SimplicityHL program.

### Time-locked contract

`contracts/timelock.simf` pays `OWNER` only once the spending transaction's lock time is at least
`AFTER` (a block height). Pass the same height as `lockTime`. It must also be below the next
block's height, or the node holds the transaction as not yet final.

```text
fn main() {
    let after: Height = param::AFTER;
    jet::check_lock_height(after);
    jet::bip_0340_verify((param::OWNER, jet::sig_all_hash()), witness::SIG)
}
```

```ts
// examples/timelock.ts
// A time-locked contract: spendable by OWNER once the transaction's lock time ≥ AFTER.
import { readFileSync } from 'node:fs';
import { Client, Key, SignatureContract, type SignatureArtifact } from '@wharfedale/sdk';

const client = new Client(process.env.WHARFEDALE_RPC ?? 'http://127.0.0.1:18443');
const owner = Key.load('bob.json');
const vault = new SignatureContract(JSON.parse(readFileSync('timelock.artifact.json', 'utf8')) as SignatureArtifact);
const after = Number(process.env.AFTER ?? 100); // the AFTER argument the artifact was compiled with

// Blocks come only with transactions: the chain reaches `after` as other transactions confirm.
await client.waitForHeight(after); // lock time must also be below the next block's height
const txid = await vault.spend(client, { to: owner.address(), amount: 10_000, lockTime: after, signers: { SIG: owner } });
console.log(txid);
```

### External signing

For keys the SDK doesn't hold (a hardware device, a remote signer):

1. Build the transaction.
2. Compute the 32-byte message with `sigAllHash`. It commits to the whole transaction, every
   spent output, the input index, the program and the genesis hash.
3. Get a BIP340 signature over it from your signer.
4. Set the witness `[signature, program, cmr, controlBlock]`.

```ts
// examples/external-signing.ts
// Sign a contract spend elsewhere (hardware or remote signer): compute sig_all_hash, collect
// the signature, assemble the witness.
import { readFileSync } from 'node:fs';
import { Client, Key, SignatureContract, sigAllHash, type SignatureArtifact } from '@wharfedale/sdk';

const client = new Client(process.env.WHARFEDALE_RPC ?? 'http://127.0.0.1:18443');
const p2pk = new SignatureContract(JSON.parse(readFileSync('p2pk.artifact.json', 'utf8')) as SignatureArtifact);
const info = await client.chainInfo();

// Build with a placeholder key, then replace the witness of input 0.
const tx = await p2pk.buildSpend(client, { to: Key.load('alice.json').address(), amount: 5_000, signers: { SIG: Key.generate() } });
const coins = await p2pk.coins(client);
const prevouts = tx.ins.map((i) => coins.find((c) => c.txid === Buffer.from(i.hash).reverse().toString('hex') && c.vout === i.index)!.output);

const message = sigAllHash(tx, prevouts, 0, p2pk.cmr, info.genesisHash); // 32 bytes to sign (BIP340)
const signature: Buffer = await remoteSign(message);
tx.setWitness(0, [signature, p2pk.program, p2pk.cmr, p2pk.controlBlock()]);
console.log(await client.sendTransaction(tx));

// Stand-in for your signer.
async function remoteSign(msg: Buffer): Promise<Buffer> {
  return Key.load('bob.json').signSchnorr(msg);
}
```

## API overview

| Export | |
|---|---|
| `Key` | `generate`, `fromSecret`, `load`, `save`, `address`, `explicitAddress`, `scriptPubkey`, `xOnlyPublicKey`, `blindingKey`, `blindingPublicKey`, `tweakedPrivateKey`, `signSchnorr` |
| `Client` | `call`, `rest`, `restText`, `chainInfo`, `blockCount`, `transaction`, `txHeight`, `sendTransaction`, `testAccept`, `scriptUtxos`, `asset`, `waitForTx`, `waitForHeight` |
| `Wallet` | `coins`, `balances`, `send` / `buildSend`, `issue` / `buildIssue`, `reissue` / `buildReissue` |
| Building blocks | `coinsAt`, `select`, `unsignedTx`, `addOutputs`, `signKeyPath`, `explicitOpening`, `explicitAsset`, `explicitValue`, `DEFAULT_FEE` |
| Contracts | `SignatureContract` (`address`, `coins`, `buildSpend`, `spend`, `witnessStack`), `sigAllHash`, `contractScriptPubkey`, `contractAddress`, `contractControlBlock`, `parseTxOut` |
| Addresses and constants | `destination`, `addressOf`, `feeAssetFor`, `WHARFEDALE` (liquidjs-lib network) |

Errors are thrown as `Error`. Node rejections are `RpcError` (`method`, message such as
`invalid: input 0: Simplicity program rejected: EXEC_JET`).

## Running the examples

1. Start a local network from the node repository: `make run`. RPC is on
   `http://127.0.0.1:18443` (node0) to `:18446`, and `:18447` (a full node).
2. Copy out the funded faucet key:
   `docker compose -f docker/compose.yml cp node0:/net/faucet.json .`.
3. Build: `npm run build`.
4. From a folder holding `faucet.json`, `alice.json`, `bob.json` and `carol.json`, run e.g.
   `node <sdk>/build/examples/payments.js`. `WHARFEDALE_RPC` overrides the node URL.

## Tests

| Command | Covers |
|---|---|
| `npm test` | Cross-SDK vectors from the Rust SDK (`test/vectors.json`): keys, addresses, fee assets, contract outputs, `sig_all_hash` over explicit / confidential / issuance / reissuance / annex transactions. Also checks that this README's code equals `examples/` |
| `WHARFEDALE_RPC=… WHARFEDALE_FAUCET=… npm run test:e2e` | Payments, issuance, reissuance, p2pk and timelock contracts against a live network, including the node rejecting a wrong signature and an early lock time |
| `npm run typecheck` | Sources, tests and examples |

Dependencies are pinned exactly, and `.npmrc` sets `ignore-scripts=true`.
