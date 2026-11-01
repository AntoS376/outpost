import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain browser modules, no type declarations
import { _test } from '../public/js/nonogram.js';

const { runs, clues, settleLine, lineSolvable, generate, won } = _test;

test('runs counts each block of filled squares in order', () => {
  assert.deepEqual(runs([1, 1, 0, 1]), [2, 1]);
  assert.deepEqual(runs([0, 0, 0]), []);
  assert.deepEqual(runs([1, 1, 1]), [3]);
});

test('clues read the rows and columns of a picture', () => {
  // 1 1 0
  // 0 1 1
  const c = clues([1, 1, 0, 0, 1, 1], 3, 2);
  assert.deepEqual(c.rows, [[2], [2]]);
  assert.deepEqual(c.cols, [[1], [2], [1]]);
});

test('settleLine: a full clue fills the line, a short one only the middle', () => {
  assert.deepEqual(settleLine([5], Array(5).fill(-1)), [1, 1, 1, 1, 1]);
  assert.deepEqual(settleLine([3], Array(5).fill(-1)), [-1, -1, 1, -1, -1]);
  assert.deepEqual(settleLine([], Array(4).fill(-1)), [0, 0, 0, 0]);
});

test('settleLine uses what is already known and spots a line that cannot fit', () => {
  assert.deepEqual(settleLine([1], [1, -1, -1]), [1, 0, 0]);
  assert.equal(settleLine([2], [1, 0, 1]), null);
});

test('lineSolvable says no when two pictures share the same clues', () => {
  assert.equal(lineSolvable(2, 2, [[1], [1]], [[1], [1]]), false);
  assert.equal(lineSolvable(2, 2, [[2], [1]], [[2], [1]]), true);
});

test('every new puzzle has the right size and solves line by line', () => {
  for (const level of ['small', 'medium', 'large']) {
    const st = generate(level);
    const c = clues(st.sol, st.w, st.h);
    assert.equal(st.cells.length, st.w * st.h);
    assert.equal(lineSolvable(st.w, st.h, c.rows, c.cols), true);
  }
  assert.equal(generate('nope').level, 'small');
});

test('won ignores crossed squares and needs every filled one', () => {
  const st = generate('small');
  st.cells = st.sol.map((v: number) => (v ? 1 : 2));
  assert.equal(won(st), true);
  const i = st.sol.indexOf(1);
  st.cells[i] = 0;
  assert.equal(won(st), false);
});
