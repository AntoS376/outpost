import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain browser modules, no type declarations
import { _test } from '../public/js/minesweeper.js';

const { newBoard, layMines, reveal, chord, toggleFlag, count, neighbours } = _test;

// A board with mines at fixed squares, already started.
function fixed(level: string, mines: number[]) {
  const st = newBoard(level);
  st.mine = Array(st.w * st.h).fill(false);
  for (const i of mines) st.mine[i] = true;
  st.mines = mines.length;
  st.state = 'play';
  st.start = Date.now();
  return st;
}

test('neighbours: 3 at a corner, 5 on an edge, 8 in the middle', () => {
  const st = newBoard('easy');
  assert.equal(neighbours(st, 0).length, 3);
  assert.equal(neighbours(st, 4).length, 5);
  assert.equal(neighbours(st, 40).length, 8);
});

test('the first square opened and its neighbours never hold a mine', () => {
  for (let n = 0; n < 50; n++) {
    const st = newBoard('hard');
    const first = Math.floor(Math.random() * st.w * st.h);
    reveal(st, first);
    assert.equal(st.mine.filter(Boolean).length, 99);
    for (const i of [first, ...neighbours(st, first)]) assert.equal(st.mine[i], false);
    assert.notEqual(st.state, 'lost');
  }
});

test('layMines still lays every mine when the board is too crowded to keep the neighbours clear', () => {
  const st = newBoard('easy');
  st.mines = 78;
  layMines(st, 40);
  assert.equal(st.mine.filter(Boolean).length, 78);
  assert.equal(st.mine[40], false);
});

test('opening an empty square spreads to the numbers around it', () => {
  const st = fixed('easy', [80]);
  reveal(st, 0);
  assert.equal(st.open.filter(Boolean).length, 80);
  assert.equal(st.state, 'won');
  assert.equal(st.flag[80], true);
  assert.equal(count(st, 70), 1);
});

test('opening a mine loses the game', () => {
  const st = fixed('easy', [0, 80]);
  assert.equal(reveal(st, 0), true);
  assert.equal(st.state, 'lost');
  assert.equal(st.boom, 0);
  assert.equal(reveal(st, 40), false);
});

test('a flag stops a square from opening', () => {
  const st = fixed('easy', [80]);
  toggleFlag(st, 0);
  assert.equal(reveal(st, 0), false);
  assert.equal(st.open[0], false);
  toggleFlag(st, 0);
  assert.equal(reveal(st, 0), true);
});

test('chord opens the rest only when the flags match the number', () => {
  // Mines at 0 and 2 on the top row; square 10 (row 2, column 2) touches both.
  const st = fixed('easy', [0, 2]);
  reveal(st, 10);
  assert.equal(count(st, 10), 2);
  toggleFlag(st, 0);
  assert.equal(chord(st, 10), false);
  toggleFlag(st, 2);
  assert.equal(chord(st, 10), true);
  for (const j of neighbours(st, 10)) assert.equal(st.open[j] || st.flag[j], true);
  assert.equal(st.state, 'won');
});

test('a wrong flag makes chord open a mine', () => {
  const st = fixed('easy', [0, 2]);
  reveal(st, 10);
  toggleFlag(st, 0);
  toggleFlag(st, 1);
  chord(st, 10);
  assert.equal(st.state, 'lost');
  assert.equal(st.boom, 2);
});
