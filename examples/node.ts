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
