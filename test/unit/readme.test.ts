// The README's TypeScript snippets are the files in examples/ (which tsc type-checks).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../../', import.meta.url);

test('README code blocks equal examples/', () => {
  const readme = readFileSync(new URL('README.md', root), 'utf8');
  const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const shown = new Set<string>();
  for (const b of blocks) {
    const path = /^\/\/ (examples\/[\w-]+\.ts)\n/.exec(b)?.[1];
    assert.ok(path, `a README ts block does not start with its example path:\n${b.slice(0, 80)}`);
    assert.equal(b, readFileSync(new URL(path, root), 'utf8'), path);
    shown.add(path);
  }
  for (const f of readdirSync(new URL('examples/', root))) assert.ok(shown.has(`examples/${f}`), `examples/${f} is not in the README`);
});
