// examples/payments.ts
// Confidential and explicit payments.
import { Client, Key, Wallet } from '@wharfedale/sdk';

const client = new Client(process.env.WHARFEDALE_RPC ?? 'http://127.0.0.1:18443');
const alice = new Wallet(client, Key.load('alice.json'));
const bob = Key.load('bob.json');

// To a wfc1 address: amount and asset are blinded to Bob. Fee: 100 units by default.
const txid = await alice.send(bob.address(), 250_000);
console.log(`${txid} confirmed at ${await client.waitForTx(txid)}`);

// An issued asset, explicitly (wf1 address), with a larger fee.
const asset = process.env.ASSET ?? '6e8da0e6433b5189d819180caeab100f1f8a88e58feabcbcaa2a357d2d28f0f6';
await alice.send(bob.explicitAddress(), 10, { asset, fee: 500 });
