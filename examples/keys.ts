// examples/keys.ts
// Create, save and load a key; derive its addresses.
import { Key } from '@wharfedale/sdk';

const key = Key.generate();
key.save('alice.json'); // {"secret": "<hex>"}, same format as node keys and the Rust SDK
const alice = Key.load('alice.json');

console.log('confidential:', alice.address()); // wfc1p…
console.log('explicit:    ', alice.explicitAddress()); // wf1p…
console.log('pubkey:      ', alice.xOnlyPublicKey().toString('hex')); // for contract arguments
