// Outputs with an explicit asset and a blinded value, as DAMP's signer pays wallet change: the
// wallet must open them (its WBTC balance and coin selection depend on it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Key, unblindValueWithKey } from '../../src/index.js';
import { confidential, ecc, zkp } from '../../src/ecc.js';

test('an explicit-asset output with a blinded value opens with the wallet blinding key', async () => {
  const conf = await confidential();
  const z = await zkp();
  const key = Key.fromSecret('42'.repeat(32));
  const asset = randomBytes(32); // internal byte order, as in the output
  const value = '93500';
  const generator = z.generator.generate(asset);
  const valueBlinder = randomBytes(32);
  const commitment = Buffer.from(z.pedersen.commitment(value, generator, valueBlinder));
  const ephemeral = randomBytes(32);
  const nonce = Buffer.from(ecc.pointFromScalar(ephemeral, true)!);
  const script = key.scriptPubkey();
  const shared = conf.nonceHash(key.blindingPublicKey(), ephemeral);
  const rangeProof = Buffer.from(z.rangeproof.sign(value, commitment, generator, valueBlinder, shared, '1', '0', '52', new Uint8Array(64), script));
  const output = { asset: Buffer.concat([Buffer.from([1]), asset]), value: commitment, nonce, script, rangeProof };

  const opened = unblindValueWithKey(conf, z, output, key.blindingKey());
  assert.equal(opened.value, 93500);
  assert.deepEqual(opened.valueBlinder, valueBlinder);
  assert.throws(() => unblindValueWithKey(conf, z, output, Key.fromSecret('43'.repeat(32)).blindingKey()));
});
