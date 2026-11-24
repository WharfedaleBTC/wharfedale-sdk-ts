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
