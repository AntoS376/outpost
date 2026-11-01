import { esc, store, toast } from './core.js';

/*
 * Nonograms written for Outpost. The numbers beside each row and above each column give the runs of filled squares in
 * that line, in order. Fill the right squares and a picture appears. Every puzzle is made here in the browser and can
 * be solved one line at a time, with no guessing. Cross out squares you know are empty. Saved in this browser.
 */

export const LEVELS = {
  small: { title: 'Small', w: 5, h: 5, fill: 0.6 },
  medium: { title: 'Medium', w: 10, h: 10, fill: 0.58 },
  large: { title: 'Large', w: 15, h: 15, fill: 0.56 },
};

// The runs of filled squares in a line, e.g. [1,1,0,1] gives [2,1].
export function runs(line) {
  const out = [];
  let n = 0;
  for (const v of line) {
    if (v === 1) n++;
    else if (n) out.push(n), (n = 0);
  }
  if (n) out.push(n);
  return out;
}

const rowOf = (g, w, r) => g.slice(r * w, r * w + w);
const colOf = (g, w, h, c) => Array.from({ length: h }, (_, r) => g[r * w + c]);

// What the clue settles in one line, given what is known (-1 unknown, 0 empty, 1 filled). Null when nothing fits.
function settleLine(clue, known) {
  const len = known.length;
  const canOne = Array(len).fill(false);
  const canZero = Array(len).fill(false);
  let any = false;
  const arr = Array(len).fill(0);
  const go = (b, pos) => {
    if (b === clue.length) {
      for (let i = pos; i < len; i++) if (known[i] === 1) return;
      for (let i = pos; i < len; i++) arr[i] = 0;
      any = true;
      arr.forEach((v, i) => (v ? (canOne[i] = true) : (canZero[i] = true)));
      return;
    }
    const rest = clue.slice(b + 1).reduce((s, x) => s + x + 1, 0);
    for (let s = pos; s + clue[b] + rest <= len; s++) {
      let ok = true;
      for (let i = s; i < s + clue[b]; i++) if (known[i] === 0) ok = false;
      if (known[s + clue[b]] === 1) ok = false;
      if (ok) {
        for (let i = pos; i < s; i++) arr[i] = 0;
        for (let i = s; i < s + clue[b]; i++) arr[i] = 1;
        if (s + clue[b] < len) arr[s + clue[b]] = 0;
        go(b + 1, Math.min(len, s + clue[b] + 1));
      }
      if (known[s] === 1) break; // a filled square can't be skipped over
    }
  };
  go(0, 0);
  if (!any) return null;
  return known.map((v, i) => (canOne[i] && !canZero[i] ? 1 : canZero[i] && !canOne[i] ? 0 : v));
}

// Solves line by line. True when every square gets settled that way (which also means there is only one answer).
export function lineSolvable(w, h, rowClues, colClues) {
  const g = Array(w * h).fill(-1);
  for (let changed = true; changed; ) {
    changed = false;
    for (let r = 0; r < h; r++) {
      const out = settleLine(rowClues[r], rowOf(g, w, r));
      if (!out) return false;
      out.forEach((v, c) => g[r * w + c] !== v && ((g[r * w + c] = v), (changed = true)));
    }
    for (let c = 0; c < w; c++) {
      const out = settleLine(colClues[c], colOf(g, w, h, c));
      if (!out) return false;
      out.forEach((v, r) => g[r * w + c] !== v && ((g[r * w + c] = v), (changed = true)));
    }
  }
  return !g.includes(-1);
}

export function clues(sol, w, h) {
  return {
    rows: Array.from({ length: h }, (_, r) => runs(rowOf(sol, w, r))),
    cols: Array.from({ length: w }, (_, c) => runs(colOf(sol, w, h, c))),
  };
}

export function generate(level = 'small', random = Math.random) {
  const l = LEVELS[level] ?? LEVELS.small;
  let sol;
  for (let n = 0; n < 300; n++) {
    sol = Array.from({ length: l.w * l.h }, () => (random() < l.fill ? 1 : 0));
    const c = clues(sol, l.w, l.h);
    if (lineSolvable(l.w, l.h, c.rows, c.cols)) break;
  }
  return { level: LEVELS[level] ? level : 'small', w: l.w, h: l.h, sol, cells: Array(l.w * l.h).fill(0), sel: 0, done: false };
}

export const won = (st) => st.sol.every((v, i) => (v === 1) === (st.cells[i] === 1));

export function mountNonogram(host) {
  const key = 'outpost.nonogram';
  const saved = store.get(key, null);
  let st = saved?.cells?.length === saved?.w * saved?.h && LEVELS[saved.level] ? saved : generate(store.get('outpost.nonogram.level', 'small'));
  let crossMode = false;
  let paint = null; // the value being painted while the pointer is held down
  const save = () => store.set(key, st);

  function lineDone(cells, clue) {
    return runs(cells).join() === clue.join();
  }

  function render() {
    const c = clues(st.sol, st.w, st.h);
    const filled = st.cells.map((v) => (v === 1 ? 1 : 0));
    const colHtml = c.cols
      .map((cl, i) => `<div class="ng-cc${lineDone(colOf(filled, st.w, st.h, i), cl) ? ' ok' : ''}">${(cl.length ? cl : [0]).map((n) => `<span>${n}</span>`).join('')}</div>`)
      .join('');
    const rowsHtml = c.rows
      .map((cl, r) => {
        const cells = Array.from({ length: st.w }, (_, x) => {
          const i = r * st.w + x;
          const v = st.cells[i];
          const cls = ['ng', v === 1 ? 'fill' : v === 2 ? 'cross' : ''];
          if (x % 5 === 4 && x < st.w - 1) cls.push('br');
          if (r % 5 === 4 && r < st.h - 1) cls.push('bb');
          const label = `Row ${r + 1}, column ${x + 1}, ${v === 1 ? 'filled' : v === 2 ? 'crossed out' : 'empty'}`;
          return `<button type="button" role="gridcell" class="${cls.join(' ')}" data-i="${i}" tabindex="${i === st.sel ? 0 : -1}" aria-label="${label}"></button>`;
        }).join('');
        return `<div class="ng-rc${lineDone(rowOf(filled, st.w, r), cl) ? ' ok' : ''}">${(cl.length ? cl : [0]).join(' ')}</div>${cells}`;
      })
      .join('');
    const levels = Object.entries(LEVELS).map(([id, l]) => `<option value="${id}"${st.level === id ? ' selected' : ''}>${l.title} (${l.w}×${l.h})</option>`).join('');
    host.innerHTML = `<div class="row solbar"><button class="btn primary small" data-act="new">New puzzle</button>
        <label class="small">Size <select id="ng-level">${levels}</select></label>
        <button type="button" class="btn small${crossMode ? ' primary' : ''}" data-act="mode" aria-pressed="${crossMode}">✕ Cross mode ${crossMode ? 'on' : 'off'}</button>
        <button class="btn small" data-act="check"${st.done ? ' disabled' : ''}>Check</button>
        <span class="muted small" aria-live="polite">${st.done ? 'Solved!' : ''}</span></div>
      <div class="ms-wrap"><div class="ng-grid${st.done ? ' done' : ''}" role="grid" aria-label="Nonogram" style="--cols:${st.w}"><div></div>${colHtml}${rowsHtml}</div></div>
      <p class="muted small">Numbers show the runs of filled squares in each line, in order, with at least one gap between runs. Click or drag to fill, right-click (or Cross mode) to mark a square empty. Arrow keys move, Space fills, X crosses. Your puzzle is saved in this browser.</p>`;
  }

  function set(i, v) {
    if (st.done || st.cells[i] === v) return;
    st.cells[i] = v;
    const b = host.querySelector(`.ng[data-i="${i}"]`);
    if (b) b.className = b.className.replace(/ ?(fill|cross)\b/g, '') + (v === 1 ? ' fill' : v === 2 ? ' cross' : '');
  }

  function finish() {
    if (!st.done && won(st)) {
      st.done = true;
      st.cells = st.cells.map((v) => (v === 1 ? 1 : 0));
      toast('Nonogram solved!');
    }
    save();
    render();
    host.querySelector(`.ng[data-i="${st.sel}"]`)?.focus();
  }

  function newGame(level = st.level) {
    if (!st.done && st.cells.some(Boolean) && !confirm('Start a new puzzle? This one will be lost.')) return void render();
    store.set('outpost.nonogram.level', level);
    st = generate(level);
    save();
    render();
  }

  host.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.ng');
    if (!b || st.done || e.button > 2) return;
    e.preventDefault();
    b.releasePointerCapture?.(e.pointerId);
    const i = Number(b.dataset.i);
    const want = e.button === 2 || crossMode ? 2 : 1;
    paint = st.cells[i] === want ? 0 : want;
    st.sel = i;
    set(i, paint);
  });
  host.addEventListener('pointerover', (e) => {
    const b = e.target.closest('.ng');
    if (b && paint !== null) set(Number(b.dataset.i), paint);
  });
  const stop = () => {
    if (paint === null) return;
    paint = null;
    if (host.isConnected) finish();
  };
  addEventListener('pointerup', stop);
  addEventListener('pointercancel', stop);
  host.addEventListener('contextmenu', (e) => e.target.closest('.ng') && e.preventDefault());
  host.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'new') newGame();
    else if (a === 'mode') (crossMode = !crossMode), render();
    else if (a === 'check') {
      const wrong = st.cells.filter((v, i) => v === 1 && !st.sol[i]).length;
      toast(wrong ? `${wrong} filled square${wrong > 1 ? 's are' : ' is'} wrong.` : 'No mistakes so far.');
    }
  });
  host.addEventListener('change', (e) => e.target.id === 'ng-level' && newGame(e.target.value));
  host.addEventListener('keydown', (e) => {
    if (!e.target.closest('.ng-grid') || e.metaKey || e.ctrlKey || e.altKey) return;
    const x = st.sel % st.w;
    const y = Math.floor(st.sel / st.w);
    const to = { ArrowUp: [x, y - 1], ArrowDown: [x, y + 1], ArrowLeft: [x - 1, y], ArrowRight: [x + 1, y] }[e.key];
    if (to) {
      e.preventDefault();
      st.sel = ((to[1] + st.h) % st.h) * st.w + ((to[0] + st.w) % st.w);
      render();
      return host.querySelector(`.ng[data-i="${st.sel}"]`)?.focus();
    }
    const want = e.key === ' ' || e.key === 'Enter' ? 1 : e.key === 'x' || e.key === 'X' ? 2 : 0;
    if (!want || st.done) return;
    e.preventDefault();
    set(st.sel, st.cells[st.sel] === want ? 0 : want);
    finish();
  });
  render();
}

export const _test = { runs, clues, settleLine, lineSolvable, generate, won, esc };
