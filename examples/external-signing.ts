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
