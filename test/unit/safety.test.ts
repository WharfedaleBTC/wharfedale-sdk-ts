// Defensive checks: key file permissions, untrusted node responses, amount arithmetic,
// canonical address checksums.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as liquid from 'liquidjs-lib';
import { decode, encode, BLECH32, BLECH32M } from 'blech32';
import { Client, Key, addNeed, destination, explicitAsset, explicitValue, select, type Coin } from '../../src/index.js';

test('key files are owner-only, also when the file exists', { skip: process.platform === 'win32' }, () => {
  const path = join(mkdtempSync(join(tmpdir(), 'wf-sdk-')), 'k.json');
  writeFileSync(path, 'old', { mode: 0o644 });
  const key = Key.generate();
  key.save(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(Key.load(path).secretBytes(), key.secretBytes());
});

test('a confidential address must use its canonical checksum variant', () => {
  const addr = Key.fromSecret('42'.repeat(32)).address();
  assert.ok(destination(addr.toUpperCase()).blindingKey, 'all-uppercase is the same address');
  // Same payload, blech32 (version 0) checksum on a version 1 address.
  const { hrp, data } = decode(addr, BLECH32M);
  const wrongVariant = encode(hrp, data, BLECH32);
  assert.doesNotThrow(() => liquid.address.fromBlech32(wrongVariant), 'liquidjs-lib alone accepts it');
  assert.throws(() => destination(wrongVariant));
});

test('amount sums stay exact', () => {
  const coin = (value: number): Coin => ({
    txid: '00'.repeat(32),
    vout: 0,
    output: { script: Buffer.alloc(0), asset: Buffer.alloc(33), value: Buffer.alloc(9), nonce: Buffer.from([0]) },
    asset: 'aa',
    value,
    assetBlinder: Buffer.alloc(32),
    valueBlinder: Buffer.alloc(32),
    confidential: false,
  });
  assert.throws(() => select([coin(Number.MAX_SAFE_INTEGER), coin(2)], 'aa', Number.MAX_SAFE_INTEGER + 1), /safe integer/);
  const need = new Map<string, number>();
  addNeed(need, 'aa', Number.MAX_SAFE_INTEGER - 10);
  assert.throws(() => addNeed(need, 'aa', 100));
  assert.throws(() => addNeed(need, 'bb', 1.5));
  assert.throws(() => addNeed(need, 'bb', -1));
});

test('a node cannot substitute another transaction', async () => {
  const tx = new liquid.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 1), 0);
  tx.addOutput(Buffer.from([0x6a]), explicitValue(0), explicitAsset('11'.repeat(32)), Buffer.from([0]));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ result: tx.toHex(), error: null }))) as typeof fetch;
  try {
    const client = new Client('http://node.invalid');
    assert.equal((await client.transaction(tx.getId())).getId(), tx.getId());
    await assert.rejects(client.transaction('00'.repeat(32)), /returned transaction/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
