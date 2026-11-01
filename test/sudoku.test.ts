import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain browser modules, no type declarations
import { _test } from '../public/js/sudoku.js';

const { generate, countSolutions, conflicts, place, toggleNote, won, PEERS } = _test;

describe('sudoku', () => {
  it('every square sees 20 others', () => {
    assert.ok(PEERS.every((p: number[]) => p.length === 20));
  });

  for (const level of ['easy', 'medium', 'hard', 'expert']) {
    it(`makes a ${level} puzzle with exactly one answer`, () => {
      const st = generate(level);
      assert.equal(conflicts(st.sol).size, 0);
      assert.ok(st.sol.every((v: number) => v >= 1 && v <= 9));
      assert.ok(st.puzzle.every((v: number, i: number) => v === 0 || v === st.sol[i]));
      assert.equal(countSolutions(st.puzzle), 1);
    });
  }

  it('flags repeated numbers and clears notes when a number goes in', () => {
    const st = generate('easy');
    const i = st.puzzle.indexOf(0);
    const peer = PEERS[i].find((p: number) => !st.puzzle[p] && p !== i) ?? PEERS[i][0];
    if (!st.puzzle[peer]) toggleNote(st, peer, 5);
    place(st, i, 5);
    if (!st.puzzle[peer]) assert.equal(st.notes[peer] & (1 << 5), 0);
    const clash = st.cells.slice();
    clash[i] = st.cells[PEERS[i].find((p: number) => st.cells[p])];
    assert.ok(conflicts(clash).has(i));
    assert.equal(place(st, st.puzzle.findIndex((v: number) => v), 1), false);
  });

  it('is won only when every square matches the answer', () => {
    const st = generate('easy');
    assert.equal(won(st), false);
    st.cells = st.sol.slice();
    assert.equal(won(st), true);
  });
});
