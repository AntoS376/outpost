import { esc, store, toast } from './core.js';

/*
 * Sudoku written for Outpost. Every puzzle is made here in the browser and has exactly one answer. Pick a square, then
 * a number (or type it); Notes mode pencils in small candidates instead. Arrow keys move, Backspace clears, N switches
 * notes. The game is saved in this browser, so leaving the page and coming back carries on where you were.
 */

export const LEVELS = {
  easy: { title: 'Easy', clues: 40 },
  medium: { title: 'Medium', clues: 32 },
  hard: { title: 'Hard', clues: 27 },
  expert: { title: 'Expert', clues: 22 },
};

const row = (i) => Math.floor(i / 9);
const col = (i) => i % 9;
const box = (i) => Math.floor(row(i) / 3) * 3 + Math.floor(col(i) / 3);
// The 20 squares that share a row, column or box with each square.
const PEERS = Array.from({ length: 81 }, (_, i) =>
  Array.from({ length: 81 }, (_, j) => j).filter((j) => j !== i && (row(j) === row(i) || col(j) === col(i) || box(j) === box(i))),
);

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Fills the empty squares (0) of grid in place, trying numbers in a random order. Counts answers up to limit and
// leaves the first one found in grid when keep is set.
function solve(grid, limit = 1, random = false, keep = true) {
  const g = grid.slice();
  let found = 0;
  let first = null;
  const free = (i) => {
    let used = 0;
    for (const p of PEERS[i]) used |= 1 << g[p];
    return used;
  };
  const step = () => {
    // Fill the square with the fewest options first; that keeps even hard grids quick.
    let best = -1;
    let bestUsed = 0;
    let bestCount = 10;
    for (let i = 0; i < 81; i++) {
      if (g[i]) continue;
      const used = free(i);
      let n = 0;
      for (let d = 1; d <= 9; d++) if (!(used & (1 << d))) n++;
      if (n < bestCount) [best, bestUsed, bestCount] = [i, used, n];
      if (n === 0) return false;
    }
    if (best < 0) {
      found++;
      if (!first) first = g.slice();
      return found >= limit;
    }
    const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => !(bestUsed & (1 << d)));
    for (const d of random ? shuffle(digits) : digits) {
      g[best] = d;
      if (step()) return true;
    }
    g[best] = 0;
    return false;
  };
  step();
  if (keep && first) grid.splice(0, 81, ...first);
  return found;
}

export const countSolutions = (grid, limit = 2) => solve(grid.slice(), limit, false, false);

// A new puzzle: a random full grid, then squares taken away one by one as long as the answer stays the only one.
export function generate(level = 'easy') {
  const target = (LEVELS[level] ?? LEVELS.easy).clues;
  const sol = Array(81).fill(0);
  solve(sol, 1, true);
  const puzzle = sol.slice();
  let clues = 81;
  for (const i of shuffle(Array.from({ length: 81 }, (_, j) => j))) {
    if (clues <= target) break;
    const keep = puzzle[i];
    puzzle[i] = 0;
    if (countSolutions(puzzle) === 1) clues--;
    else puzzle[i] = keep;
  }
  return { level, puzzle, sol, cells: puzzle.slice(), notes: Array(81).fill(0), sel: puzzle.indexOf(0), moves: 0, hints: 0 };
}

// Squares whose number repeats in a row, column or box.
export function conflicts(cells) {
  const bad = new Set();
  for (let i = 0; i < 81; i++) if (cells[i] && PEERS[i].some((p) => cells[p] === cells[i])) bad.add(i);
  return bad;
}

export const won = (st) => st.cells.every((v, i) => v === st.sol[i]);

// Puts d in square i (0 clears it) and takes d out of the notes of the squares it can see.
export function place(st, i, d) {
  if (st.puzzle[i]) return false;
  st.cells[i] = d;
  st.notes[i] = 0;
  if (d) for (const p of PEERS[i]) st.notes[p] &= ~(1 << d);
  st.moves++;
  return true;
}

export function toggleNote(st, i, d) {
  if (st.puzzle[i] || st.cells[i]) return false;
  st.notes[i] ^= 1 << d;
  return true;
}

export function mountSudoku(host) {
  const key = 'outpost.sudoku';
  const saved = store.get(key, null);
  let st = saved?.sol?.length === 81 ? saved : generate(store.get('outpost.sudoku.level', 'easy'));
  let undo = [];
  let noteMode = false;
  let showMistakes = store.get('outpost.sudoku.mistakes', false);

  const save = () => store.set(key, st);
  const snapshot = () => {
    undo.push(JSON.stringify({ cells: st.cells, notes: st.notes }));
    if (undo.length > 200) undo.shift();
  };

  function label(i, v) {
    const where = `Row ${row(i) + 1}, column ${col(i) + 1}`;
    if (v) return `${where}, ${v}${st.puzzle[i] ? ', given' : ''}`;
    const notes = [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((d) => st.notes[i] & (1 << d));
    return `${where}, empty${notes.length ? `, notes ${notes.join(' ')}` : ''}`;
  }

  function render() {
    const bad = conflicts(st.cells);
    const sel = st.sel;
    const selVal = sel >= 0 ? st.cells[sel] : 0;
    const done = won(st);
    const counts = Array(10).fill(0);
    for (const v of st.cells) counts[v]++;

    const squares = st.cells.map((v, i) => {
      const cls = ['sq'];
      if (st.puzzle[i]) cls.push('given');
      if (i === sel) cls.push('sel');
      else if (sel >= 0 && (row(i) === row(sel) || col(i) === col(sel) || box(i) === box(sel))) cls.push('near');
      if (v && v === selVal) cls.push('same');
      if (bad.has(i) || (showMistakes && v && v !== st.sol[i])) cls.push('bad');
      if (col(i) % 3 === 2 && col(i) < 8) cls.push('br');
      if (row(i) % 3 === 2 && row(i) < 8) cls.push('bb');
      const inner = v
        ? v
        : `<span class="sq-notes">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<span>${st.notes[i] & (1 << d) ? d : ''}</span>`).join('')}</span>`;
      return `<button type="button" role="gridcell" class="${cls.join(' ')}" data-i="${i}" tabindex="${i === sel ? 0 : -1}" aria-label="${esc(label(i, v))}"${i === sel ? ' aria-selected="true"' : ''}>${inner}</button>`;
    });
    const rows = Array.from({ length: 9 }, (_, r) => `<div role="row" class="sq-row">${squares.slice(r * 9, r * 9 + 9).join('')}</div>`);

    const levels = Object.entries(LEVELS).map(([id, l]) => `<option value="${id}"${st.level === id ? ' selected' : ''}>${l.title}</option>`).join('');
    host.innerHTML = `<div class="row solbar"><button class="btn primary small" data-act="new">New game</button>
        <label class="small">Level <select id="sd-level">${levels}</select></label>
        <button class="btn small" data-act="undo"${undo.length ? '' : ' disabled'}>Undo</button>
        <button class="btn small" data-act="hint"${done || sel < 0 || st.puzzle[sel] ? ' disabled' : ''}>Hint</button>
        <label class="small"><input type="checkbox" id="sd-mistakes"${showMistakes ? ' checked' : ''}> Show mistakes</label>
        <span class="muted small" aria-live="polite">${done ? `Solved! ${st.hints ? `(${st.hints} hint${st.hints > 1 ? 's' : ''})` : ''}` : `${counts[0]} squares left`}</span></div>
      <div class="sudoku">
        <div class="sd-grid" role="grid" aria-label="Sudoku grid">${rows.join('')}</div>
        <div class="sd-pad">
          ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `<button type="button" class="btn" data-num="${d}"${counts[d] >= 9 ? ' disabled' : ''} aria-label="${noteMode ? 'Note' : 'Put'} ${d}">${d}</button>`).join('')}
          <button type="button" class="btn" data-num="0" aria-label="Clear the square">⌫</button>
          <button type="button" class="btn${noteMode ? ' primary' : ''}" data-act="notes" aria-pressed="${noteMode}">Notes ${noteMode ? 'on' : 'off'}</button>
        </div>
      </div>
      <p class="muted small">Pick a square, then a number, or type it. Arrow keys move, Backspace clears, N switches notes. Your game is saved in this browser.</p>`;
  }

  function focusSel() {
    host.querySelector(`.sq[data-i="${st.sel}"]`)?.focus();
  }

  function enter(d) {
    const i = st.sel;
    if (i < 0 || st.puzzle[i] || won(st)) return;
    snapshot();
    const changed = noteMode && d ? toggleNote(st, i, d) : place(st, i, d);
    if (!changed) undo.pop();
    save();
    render();
    focusSel();
    if (won(st)) toast(`Sudoku solved${st.hints ? '' : ' with no hints'}!`);
  }

  function newGame(level = st.level) {
    if (st.moves && !won(st) && !confirm('Start a new Sudoku? This one will be lost.')) return void render();
    store.set('outpost.sudoku.level', level);
    st = generate(level);
    undo = [];
    save();
    render();
  }

  function onClick(e) {
    const sq = e.target.closest('.sq');
    if (sq) {
      st.sel = Number(sq.dataset.i);
      render();
      return focusSel();
    }
    const num = e.target.closest('[data-num]');
    if (num) return enter(Number(num.dataset.num));
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'new') newGame();
    else if (act === 'undo' && undo.length) {
      Object.assign(st, JSON.parse(undo.pop()));
      save();
      render();
    } else if (act === 'notes') {
      noteMode = !noteMode;
      render();
    } else if (act === 'hint' && st.sel >= 0 && !st.puzzle[st.sel]) {
      snapshot();
      place(st, st.sel, st.sol[st.sel]);
      st.hints++;
      save();
      render();
      if (won(st)) toast('Sudoku solved!');
    }
  }

  function onChange(e) {
    if (e.target.id === 'sd-level') newGame(e.target.value);
    else if (e.target.id === 'sd-mistakes') {
      showMistakes = e.target.checked;
      store.set('outpost.sudoku.mistakes', showMistakes);
      render();
    }
  }

  function onKey(e) {
    if (!e.target.closest('.sd-grid') || e.metaKey || e.ctrlKey || e.altKey) return;
    const moves = { ArrowUp: -9, ArrowDown: 9, ArrowLeft: -1, ArrowRight: 1 };
    if (moves[e.key]) {
      e.preventDefault();
      const i = Math.max(0, st.sel);
      const r = (row(i) + (moves[e.key] === -9 ? 8 : moves[e.key] === 9 ? 1 : 0)) % 9;
      const c = (col(i) + (moves[e.key] === -1 ? 8 : moves[e.key] === 1 ? 1 : 0)) % 9;
      st.sel = r * 9 + c;
      render();
      return focusSel();
    }
    if (/^[1-9]$/.test(e.key)) return void (e.preventDefault(), enter(Number(e.key)));
    if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') return void (e.preventDefault(), enter(0));
    if (e.key === 'n' || e.key === 'N') {
      noteMode = !noteMode;
      render();
      focusSel();
    }
  }

  host.addEventListener('click', onClick);
  host.addEventListener('change', onChange);
  host.addEventListener('keydown', onKey);
  render();
}

export const _test = { generate, solve, countSolutions, conflicts, place, toggleNote, won, PEERS };
