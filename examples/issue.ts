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
