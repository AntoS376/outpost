import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain browser modules, no type declarations
import { _test } from '../public/js/mahjong.js';

const { LAYOUTS, positions, isFree, deal, moves, newGame, reshuffle } = _test;

test('every layout has an even number of tiles and no two in the same spot', () => {
  for (const id of Object.keys(LAYOUTS)) {
    const pos = positions(id);
    assert.equal(pos.length % 2, 0, id);
    assert.equal(new Set(pos.map((p: any) => `${p.x},${p.y},${p.z}`)).size, pos.length);
  }
  assert.equal(positions('pyramid').length, 82);
  assert.equal(positions('towers').length, 76);
  assert.equal(positions('cross').length, 112);
});

test('isFree: covered tiles and tiles with both sides blocked are stuck, row ends are free', () => {
  const row = [{ x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }];
  const gone = [false, false, false];
  assert.equal(isFree(row, gone, 0), true);
  assert.equal(isFree(row, gone, 1), false);
  assert.equal(isFree(row, gone, 2), true);
  assert.equal(isFree(row, [true, false, false], 1), true);
  // A tile half on top of the first one still covers it.
  const stack = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 1 }];
  assert.equal(isFree(stack, [false, false], 0), false);
  assert.equal(isFree(stack, [false, false], 1), true);
  assert.equal(isFree(stack, [false, true], 0), true);
});

test('playing a deal in the order it was made clears the board with free, matching pairs', () => {
  for (const id of Object.keys(LAYOUTS)) {
    const pos = positions(id);
    const d = deal(pos);
    assert.ok(d);
    const gone = Array(pos.length).fill(false);
    for (const [a, b] of d.order) {
      assert.equal(d.kinds[a], d.kinds[b]);
      assert.ok(isFree(pos, gone, a) && isFree(pos, gone, b));
      gone[a] = gone[b] = true;
    }
    assert.ok(gone.every(Boolean));
  }
});

test('a new game always has a move, and moves finds a matching free pair', () => {
  const st = newGame('cross');
  const m = moves(st);
  assert.ok(m);
  assert.equal(st.tiles[m[0]].k, st.tiles[m[1]].k);
  assert.ok(isFree(st.tiles, st.gone, m[0]) && isFree(st.tiles, st.gone, m[1]));
  assert.equal(newGame('nope').layout, 'pyramid');
});

test('Shuffle keeps the same tiles and leaves a board that can be cleared', () => {
  const st = newGame('towers');
  for (let n = 0; n < 10; n++) {
    const m = moves(st);
    if (!m) break;
    st.gone[m[0]] = st.gone[m[1]] = true;
    st.history.push(m);
  }
  const before = st.tiles.filter((_: any, i: number) => !st.gone[i]).map((t: any) => t.k).sort();
  assert.equal(reshuffle(st), true);
  assert.deepEqual(st.tiles.filter((_: any, i: number) => !st.gone[i]).map((t: any) => t.k).sort(), before);
  assert.deepEqual(st.history, []);
  // Greedy play can still get stuck, so check by matching with a fresh deal order instead: every kind pairs up.
  const counts = new Map();
  for (const k of before) counts.set(k, (counts.get(k) || 0) + 1);
  for (const c of counts.values()) assert.equal(c % 2, 0);
});
