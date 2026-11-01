import { esc, store, toast } from './core.js';

/*
 * Minesweeper written for Outpost. Open squares without hitting a mine; each number says how many mines touch that
 * square. The first square you open is always safe, and so are its neighbours. Right-click (or Flag mode on a touch
 * screen) marks a mine; clicking a number whose mines are all flagged opens the rest around it. Saved in this browser.
 */

export const LEVELS = {
  easy: { title: 'Easy', w: 9, h: 9, mines: 10 },
  medium: { title: 'Medium', w: 16, h: 16, mines: 40 },
  hard: { title: 'Hard', w: 30, h: 16, mines: 99 },
};

export function newBoard(level = 'easy') {
  const l = LEVELS[level] ?? LEVELS.easy;
  const n = l.w * l.h;
  return {
    level: LEVELS[level] ? level : 'easy',
    w: l.w,
    h: l.h,
    mines: l.mines,
    mine: null, // laid on the first open, so that one is always safe
    open: Array(n).fill(false),
    flag: Array(n).fill(false),
    state: 'ready', // ready, play, won, lost
    boom: -1,
    start: 0,
    time: 0,
  };
}

export function neighbours(st, i) {
  const x = i % st.w;
  const y = Math.floor(i / st.w);
  const out = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if ((dx || dy) && nx >= 0 && ny >= 0 && nx < st.w && ny < st.h) out.push(ny * st.w + nx);
    }
  return out;
}

export const count = (st, i) => neighbours(st, i).filter((j) => st.mine[j]).length;

// Places the mines anywhere except the first square and, when there is room, its neighbours.
export function layMines(st, safe, random = Math.random) {
  const n = st.w * st.h;
  const keepClear = new Set([safe, ...neighbours(st, safe)]);
  let spots = Array.from({ length: n }, (_, i) => i).filter((i) => !keepClear.has(i));
  if (spots.length < st.mines) spots = Array.from({ length: n }, (_, i) => i).filter((i) => i !== safe);
  for (let i = spots.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [spots[i], spots[j]] = [spots[j], spots[i]];
  }
  st.mine = Array(n).fill(false);
  for (const i of spots.slice(0, st.mines)) st.mine[i] = true;
}

const finished = (st) => st.state === 'won' || st.state === 'lost';

function checkWin(st) {
  if (st.open.every((o, i) => o || st.mine[i])) {
    st.state = 'won';
    st.time = Date.now() - st.start;
    st.mine.forEach((m, i) => m && (st.flag[i] = true));
  }
}

// Opens square i, spreading through squares with no mines around them. Returns false when nothing changed.
export function reveal(st, i) {
  if (finished(st) || st.open[i] || st.flag[i]) return false;
  if (!st.mine) {
    layMines(st, i);
    st.state = 'play';
    st.start = Date.now();
  }
  if (st.mine[i]) {
    st.state = 'lost';
    st.boom = i;
    st.time = Date.now() - st.start;
    return true;
  }
  const todo = [i];
  while (todo.length) {
    const j = todo.pop();
    if (st.open[j] || st.flag[j]) continue;
    st.open[j] = true;
    if (count(st, j) === 0) todo.push(...neighbours(st, j).filter((k) => !st.open[k]));
  }
  checkWin(st);
  return true;
}

// On an open number with that many flags around it, opens every other square around it.
export function chord(st, i) {
  if (finished(st) || !st.open[i] || !st.mine) return false;
  const around = neighbours(st, i);
  if (around.filter((j) => st.flag[j]).length !== count(st, i)) return false;
  let changed = false;
  for (const j of around) if (!st.open[j] && !st.flag[j]) changed = reveal(st, j) || changed;
  return changed;
}

export function toggleFlag(st, i) {
  if (finished(st) || st.open[i]) return false;
  st.flag[i] = !st.flag[i];
  return true;
}

const fmt = (ms) => String(Math.min(999, Math.floor(ms / 1000)));

export function mountMinesweeper(host) {
  const key = 'outpost.mines';
  const saved = store.get(key, null);
  let st = saved?.open?.length === saved?.w * saved?.h && LEVELS[saved.level] ? saved : newBoard(store.get('outpost.mines.level', 'easy'));
  // Time spent before this visit carries on from where it stopped.
  if (st.state === 'play') st.start = Date.now() - (st.time || 0);
  let flagMode = false;
  let sel = 0;

  const save = () => {
    if (st.state === 'play') st.time = Date.now() - st.start;
    store.set(key, st);
  };

  const clock = setInterval(() => {
    if (!host.isConnected) return clearInterval(clock);
    const t = host.querySelector('#ms-time');
    if (t && st.state === 'play') t.textContent = fmt(Date.now() - st.start);
  }, 500);

  function label(i) {
    const where = `Row ${Math.floor(i / st.w) + 1}, column ${(i % st.w) + 1}`;
    if (st.open[i]) return `${where}, ${count(st, i) || 'empty'}`;
    if (finished(st) && st.mine[i]) return `${where}, mine`;
    return `${where}, ${st.flag[i] ? 'flagged' : 'closed'}`;
  }

  function render() {
    const flags = st.flag.filter(Boolean).length;
    const cells = st.open.map((o, i) => {
      const cls = ['ms'];
      let inner = '';
      if (o) {
        const c = count(st, i);
        cls.push('open');
        if (c) {
          cls.push(`n${c}`);
          inner = c;
        }
      } else if (st.state === 'lost' && st.mine[i]) {
        cls.push('open', 'mine');
        if (i === st.boom) cls.push('boom');
        inner = st.flag[i] ? '⚑' : '●';
      } else if (st.flag[i]) {
        cls.push('flag');
        if (st.state === 'lost') cls.push('wrong');
        inner = '⚑';
      }
      return `<button type="button" role="gridcell" class="${cls.join(' ')}" data-i="${i}" tabindex="${i === sel ? 0 : -1}" aria-label="${esc(label(i))}">${inner}</button>`;
    });
    const rows = Array.from({ length: st.h }, (_, r) => `<div role="row" class="ms-row">${cells.slice(r * st.w, r * st.w + st.w).join('')}</div>`);
    const levels = Object.entries(LEVELS)
      .map(([id, l]) => `<option value="${id}"${st.level === id ? ' selected' : ''}>${l.title} (${l.w}×${l.h}, ${l.mines} mines)</option>`)
      .join('');
    const status = st.state === 'won' ? `Cleared in ${fmt(st.time)} s!` : st.state === 'lost' ? 'Boom. Try again?' : st.state === 'ready' ? 'Open any square to start' : '';
    host.innerHTML = `<div class="row solbar"><button class="btn primary small" data-act="new">New game</button>
        <label class="small">Level <select id="ms-level">${levels}</select></label>
        <button type="button" class="btn small${flagMode ? ' primary' : ''}" data-act="flag" aria-pressed="${flagMode}">⚑ Flag mode ${flagMode ? 'on' : 'off'}</button>
        <span class="small ms-count">Mines left <b>${st.mines - flags}</b></span>
        <span class="small ms-count">Time <b id="ms-time">${fmt(st.state === 'play' ? Date.now() - st.start : st.time)}</b></span>
        <span class="muted small" aria-live="polite">${status}</span></div>
      <div class="ms-wrap"><div class="ms-grid" role="grid" aria-label="Minesweeper board" style="--cols:${st.w}">${rows.join('')}</div></div>
      <p class="muted small">Click to open a square, right-click to flag a mine (or switch on Flag mode). Click a number whose mines are all flagged to open the squares around it. Arrow keys move, Space or Enter opens, F flags. Your game is saved in this browser.</p>`;
  }

  function focusSel() {
    host.querySelector(`.ms[data-i="${sel}"]`)?.focus();
  }

  function after(changed) {
    if (!changed) return;
    save();
    render();
    focusSel();
    if (st.state === 'won') toast(`Minesweeper cleared in ${fmt(st.time)} seconds!`);
  }

  function act(i, flag) {
    sel = i;
    if (flag) return after(toggleFlag(st, i));
    if (st.open[i]) return after(chord(st, i));
    return after(reveal(st, i));
  }

  function newGame(level = st.level) {
    if (st.state === 'play' && !confirm('Start a new game? This one will be lost.')) return void render();
    store.set('outpost.mines.level', level);
    st = newBoard(level);
    sel = 0;
    save();
    render();
  }

  host.addEventListener('click', (e) => {
    const sq = e.target.closest('.ms');
    if (sq) return act(Number(sq.dataset.i), flagMode);
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'new') newGame();
    else if (a === 'flag') {
      flagMode = !flagMode;
      render();
    }
  });
  host.addEventListener('contextmenu', (e) => {
    const sq = e.target.closest('.ms');
    if (!sq) return;
    e.preventDefault();
    act(Number(sq.dataset.i), true);
  });
  host.addEventListener('change', (e) => {
    if (e.target.id === 'ms-level') newGame(e.target.value);
  });
  host.addEventListener('keydown', (e) => {
    if (!e.target.closest('.ms-grid') || e.metaKey || e.ctrlKey || e.altKey) return;
    const x = sel % st.w;
    const y = Math.floor(sel / st.w);
    const to = { ArrowUp: [x, y - 1], ArrowDown: [x, y + 1], ArrowLeft: [x - 1, y], ArrowRight: [x + 1, y] }[e.key];
    if (to) {
      e.preventDefault();
      sel = ((to[1] + st.h) % st.h) * st.w + ((to[0] + st.w) % st.w);
      render();
      return focusSel();
    }
    // Space and Enter press the square's button, which opens it like a click.
    if (e.key === 'f' || e.key === 'F') return void (e.preventDefault(), act(sel, true));
  });
  addEventListener('pagehide', save, { once: true });
  render();
}

export const _test = { newBoard, layMines, reveal, chord, toggleFlag, count, neighbours };
