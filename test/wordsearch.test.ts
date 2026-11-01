import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain browser modules, no type declarations
import { _test } from '../public/js/wordsearch.js';

const { placeWords, generate, lineCells, matchSelection, won } = _test;

test('lineCells follows straight lines and 45° diagonals only', () => {
  // On a 5-wide grid: 0 is the top left, 4 the top right, 24 the bottom right.
  assert.deepEqual(lineCells(5, 0, 4), [0, 1, 2, 3, 4]);
  assert.deepEqual(lineCells(5, 4, 0), [4, 3, 2, 1, 0]);
  assert.deepEqual(lineCells(5, 0, 20), [0, 5, 10, 15, 20]);
  assert.deepEqual(lineCells(5, 0, 24), [0, 6, 12, 18, 24]);
  assert.deepEqual(lineCells(5, 20, 4), [20, 16, 12, 8, 4]);
  assert.deepEqual(lineCells(5, 7, 7), [7]);
  assert.equal(lineCells(5, 0, 7), null);
});

test('placeWords keeps every word inside the grid with its letters in order', () => {
  const words = ['OTTER', 'MOOSE', 'HERON', 'PANDA'];
  const { grid, placed } = placeWords(words, 8, 8, [[1, 0], [0, 1], [1, 1]]);
  assert.equal(grid.length, 64);
  for (const p of placed) {
    assert.ok(p.cells.every((c: number) => c >= 0 && c < 64));
    assert.equal(p.cells.map((c: number) => grid[c]).join(''), p.word);
    assert.deepEqual(lineCells(8, p.cells[0], p.cells.at(-1)), p.cells);
  }
});

test('every new puzzle has its words and each one can be circled', () => {
  for (const level of ['easy', 'medium', 'hard']) {
    for (let n = 0; n < 20; n++) {
      const st = generate(level);
      assert.equal(st.grid.length, st.w * st.h);
      assert.match(st.grid, /^[A-Z]+$/);
      assert.ok(st.words.length >= 4);
      for (const word of st.words) assert.ok(word.length <= st.w);
    }
  }
  assert.equal(generate('nope').level, 'easy');
});

test('matchSelection finds a word either way round, once', () => {
  // A 4×1 grid that reads CRAB.
  const st = { w: 4, h: 1, grid: 'CRAB', words: ['CRAB'], found: {} as Record<string, number[]> };
  assert.equal(matchSelection(st, 0, 2), null);
  assert.deepEqual(matchSelection(st, 3, 0), { word: 'CRAB', cells: [3, 2, 1, 0] });
  const m = matchSelection(st, 0, 3);
  assert.equal(m.word, 'CRAB');
  st.found.CRAB = m.cells;
  assert.equal(matchSelection(st, 0, 3), null);
  assert.equal(matchSelection(st, 1, 1), null);
});

test('a generated puzzle is won once every word is circled', () => {
  const st = generate('hard');
  assert.equal(won(st), false);
  // Find each word by trying every start and end square, as a player would.
  for (const word of st.words) {
    let hit = null;
    for (let a = 0; a < st.grid.length && !hit; a++)
      for (let b = 0; b < st.grid.length && !hit; b++) {
        const m = matchSelection(st, a, b);
        if (m && m.word === word) hit = m;
      }
    assert.ok(hit, `${word} can be circled`);
    st.found[word] = hit.cells;
  }
  assert.equal(won(st), true);
});
