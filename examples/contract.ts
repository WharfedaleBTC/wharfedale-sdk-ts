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
console.log(`left in contract: ${left}`); // 100 000 − 60 000 − 100
