// examples/balances.ts
// Coins (confidential ones unblinded with the key's blinding key) and balances.
import { Client, Key, Wallet } from '@wharfedale/sdk';

const wallet = new Wallet(new Client(process.env.WHARFEDALE_RPC ?? 'http://127.0.0.1:18443'), Key.load('alice.json'));

for (const [asset, amount] of await wallet.balances()) console.log(`${asset}: ${amount}`);
for (const coin of await wallet.coins()) {
  console.log(`${coin.txid}:${coin.vout}  ${coin.value} of ${coin.asset}  (${coin.confidential ? 'confidential' : 'explicit'})`);
}
