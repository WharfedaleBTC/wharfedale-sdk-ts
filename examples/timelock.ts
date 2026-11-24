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
