import { $, esc } from './core.js';
import { GAMES, mountSolitaire } from './solitaire.js';
import { mountSudoku } from './sudoku.js';
import { mountMinesweeper } from './minesweeper.js';
import { mountMahjong } from './mahjong.js';
import { mountNonogram } from './nonogram.js';
import { mountWordSearch } from './wordsearch.js';

const back = '<a class="btn small" href="#games">← All games</a>';

export async function viewGames(root, sub) {
  if (GAMES[sub]) {
    root.innerHTML = `<div class="row gamehead">${back}<h1>${esc(GAMES[sub].title)}</h1></div><div id="sol"></div>`;
    return mountSolitaire($('#sol', root), sub);
  }
  if (sub === 'sudoku') {
    root.innerHTML = `<div class="row gamehead">${back}<h1>Sudoku</h1></div><div id="sdk"></div>`;
    return mountSudoku($('#sdk', root));
  }
  if (sub === 'minesweeper') {
    root.innerHTML = `<div class="row gamehead">${back}<h1>Minesweeper</h1></div><div id="msw"></div>`;
    return mountMinesweeper($('#msw', root));
  }
  if (sub === 'mahjong') {
    root.innerHTML = `<div class="row gamehead">${back}<h1>Mahjong tiles</h1></div><div id="mjg"></div>`;
    return mountMahjong($('#mjg', root));
  }
  if (sub === 'nonogram') {
    root.innerHTML = `<div class="row gamehead">${back}<h1>Nonograms</h1></div><div id="ngm"></div>`;
    return mountNonogram($('#ngm', root));
  }
  if (sub === 'wordsearch') {
    root.innerHTML = `<div class="row gamehead">${back}<h1>Word search</h1></div><div id="wsr"></div>`;
    return mountWordSearch($('#wsr', root));
  }

  root.innerHTML = `<h1>Games</h1><p class="lead">Card games and puzzles that run in this page, with no internet needed. Your games are saved in this browser.</p>
    <h2>Solitaire</h2>
    <div class="appgrid games">${Object.entries(GAMES).map(([id, g]) => `<a class="appcard gamecard" href="#games/${id}"><h3>${esc(g.title)}</h3><p class="muted">${esc(g.blurb)}</p></a>`).join('')}</div>
    <h2>Puzzles</h2>
    <div class="appgrid games"><a class="appcard gamecard" href="#games/sudoku"><h3>Sudoku</h3><p class="muted">Fill the grid so every row, column and 3×3 box has 1 to 9 once. Four levels, notes and hints.</p></a><a class="appcard gamecard" href="#games/minesweeper"><h3>Minesweeper</h3><p class="muted">Open every square without a mine. Numbers tell you how many mines touch a square. Three board sizes.</p></a><a class="appcard gamecard" href="#games/mahjong"><h3>Mahjong tiles</h3><p class="muted">Match pairs of free tiles to clear a stacked board. Three layouts, hints and shuffle.</p></a><a class="appcard gamecard" href="#games/nonogram"><h3>Nonograms</h3><p class="muted">Fill squares to match the number clues and reveal a hidden picture. Three grid sizes.</p></a><a class="appcard gamecard" href="#games/wordsearch"><h3>Word search</h3><p class="muted">Find themed words hidden in a grid of letters. Three levels, from across and down to any direction.</p></a></div>`;
}
