// Payment destinations: addresses and hex scripts, never an empty script (a fee output).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Key, destination } from '../../src/index.js';

test('destination: addresses, hex scripts, and no empty script', () => {
  const key = Key.fromSecret('42'.repeat(32));
  const conf = destination(key.address());
  assert.ok(conf.blindingKey, 'a wfc1 address carries a blinding key');
  const expl = destination(key.explicitAddress());
  assert.deepEqual(Buffer.from(expl.script), Buffer.from(conf.script));
  assert.equal(expl.blindingKey, undefined);
  assert.deepEqual(Buffer.from(destination(Buffer.from(conf.script).toString('hex')).script), Buffer.from(conf.script));
  assert.throws(() => destination('not an address'));
  assert.throws(() => destination(''), 'an empty script is a fee output: never a destination');
});
