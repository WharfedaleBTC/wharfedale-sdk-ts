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
