import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { here } from './helpers.js';

// Browsers compile a field's pattern with the v flag and silently skip the check when it's invalid there
// (an unescaped "-", "(" or ")" inside [...] is enough).
it('every form pattern is valid as browsers read it', () => {
  const dir = path.join(here, '..', 'public', 'js');
  let seen = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    for (const [, src] of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/pattern="([^"]+)"/g)) {
      const pattern = src!.replace(/\\\\/g, '\\'); // as the template literal writes it into the page
      assert.doesNotThrow(() => new RegExp(`^(?:${pattern})$`, 'v'), `${file}: ${pattern}`);
      seen++;
    }
  }
  assert.ok(seen >= 3);
});
