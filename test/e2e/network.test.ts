// Against a running network (e.g. `wharfedale/docker`): WHARFEDALE_RPC (node URL),
// WHARFEDALE_FAUCET (faucet key file); optional WHARFEDALE_RPC2 (another node, to see gossip
// and blocks from a second validator). `npm run test:e2e`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client, Key, Wallet, SignatureContract } from '../../src/index.js';

const rpc = process.env.WHARFEDALE_RPC;
const faucetFile = process.env.WHARFEDALE_FAUCET;
const vectors = JSON.parse(readFileSync(new URL('../../../test/vectors.json', import.meta.url), 'utf8'));

test('wallet, issuance and contracts against a live network', { skip: !rpc || !faucetFile ? 'set WHARFEDALE_RPC and WHARFEDALE_FAUCET' : false, timeout: 300_000 }, async () => {
  const client = new Client(rpc!);
  const other = new Client(process.env.WHARFEDALE_RPC2 ?? rpc!);
  const info = await client.chainInfo();
  const faucet = new Wallet(client, Key.load(faucetFile!));
  const alice = new Wallet(client, Key.generate());
  const bob = new Wallet(other, Key.generate());

  // Confidential funding and payment (blinded by this SDK, validated by the Rust node).
  const fund = await faucet.send(alice.key.address(), 2_000_000);
  await other.waitForTx(fund);
  const pay = await alice.send(bob.key.address(), 500_000);
  await client.waitForTx(pay);
  assert.equal((await alice.balances()).get(info.feeAsset), 2_000_000 - 500_000 - 1_000);
  assert.equal((await bob.balances()).get(info.feeAsset), 500_000);
  const onChain = await client.rest<{ vout: { valuecommitment?: string; value?: number }[] }>(`tx/${pay}`);
  assert.ok(onChain.vout[0]!.valuecommitment && onChain.vout[0]!.value === undefined, 'payment is confidential');

  // Confidential coins to an explicit address.
  const carol = Key.generate();
  const toExplicit = await bob.send(carol.explicitAddress(), 100_000);
  await client.waitForTx(toExplicit);
  assert.equal((await new Wallet(client, carol).balances()).get(info.feeAsset), 100_000);

  // Issuance and reissuance.
  const issued = await alice.issue(1_000, 1);
  await client.waitForTx(issued.txid);
  for (let i = 0; i < 120; i++) {
    if (await client.asset(issued.asset).then(() => true, () => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const re = await alice.reissue(issued.asset, 250);
  await client.waitForTx(re);
  const b = await alice.balances();
  assert.equal(b.get(issued.asset), 1_250);
  assert.equal(b.get(issued.token), 1);

  // A named issuance: the node verifies the on-chain metadata and serves it.
  const named = await alice.issue(5_000, 0, 1_000, { name: 'Harbour Tickets', ticker: 'HBT', precision: 0 });
  await client.waitForTx(named.txid);
  let rec: { name?: string; ticker?: string; precision?: number } | null = null;
  for (let i = 0; i < 120 && !rec; i++) {
    rec = await client.rest<{ name?: string; ticker?: string; precision?: number }>(`asset/${named.asset}`).catch(() => null);
    if (!rec) await new Promise((r) => setTimeout(r, 250));
  }
  assert.deepEqual([rec?.name, rec?.ticker, rec?.precision], ['Harbour Tickets', 'HBT', 0]);

  // A p2pk contract (artifact compiled by the Rust SDK; owner = vector key 1).
  const p2pk = new SignatureContract(vectors.contracts[0].artifact);
  const owner = Key.fromSecret(vectors.keys[0].secret);
  const before = (await p2pk.coins(client)).reduce((s, c) => s + c.value, 0);
  const lock = await faucet.send(p2pk.address(), 100_000);
  await client.waitForTx(lock);
  const wrong = await p2pk.buildSpend(client, { to: alice.key.address(), amount: 50_000, signers: { SIG: Key.generate() } });
  assert.match((await client.testAccept(wrong)) ?? '', /Simplicity program rejected/);
  const spent = await p2pk.spend(client, { to: alice.key.address(), amount: 50_000, signers: { SIG: owner } });
  await other.waitForTx(spent);
  const after = (await p2pk.coins(client)).reduce((s, c) => s + c.value, 0);
  assert.equal(after, before + 100_000 - 50_000 - 1_000);

  // A timelock contract (AFTER = 5): lock time 4 is final but fails the program in the node;
  // lock time 5 spends.
  const timelock = new SignatureContract(vectors.contracts[1].artifact);
  const tlOwner = Key.fromSecret(vectors.keys[1].secret);
  const tlFund = await faucet.send(timelock.address(), 20_000);
  await client.waitForTx(tlFund);
  const early = await timelock.buildSpend(client, { to: alice.key.address(), amount: 5_000, lockTime: 4, signers: { SIG: tlOwner } });
  assert.match((await client.testAccept(early)) ?? '', /Simplicity program rejected: EXEC_JET/);
  const onTime = await timelock.spend(client, { to: alice.key.address(), amount: 5_000, lockTime: 5, signers: { SIG: tlOwner } });
  await client.waitForTx(onTime);
});
