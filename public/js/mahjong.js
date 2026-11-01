import { esc, store, toast } from './core.js';

/*
 * Mahjong tiles written for Outpost: a matching game played with a stack of tiles. Pick two matching tiles that are free
 * (nothing on top, and an open left or right side) to take them off. Clear the board to win. Every deal is made here in
 * the browser by taking the board apart in pairs first, so it can always be cleared. Saved in this browser.
 */

// Positions are in half-tile steps, so a tile at x spans x to x+2. Each layout is a set of stacked rectangles.
function rect(cols, rows, z, ox, oy) {
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ x: ox + 2 * c, y: oy + 2 * r, z });
  return out;
}

export const LAYOUTS = {
  pyramid: { title: 'Pyramid', build: () => [rect(8, 6, 0, 0, 0), rect(6, 4, 1, 2, 2), rect(4, 2, 2, 4, 4), rect(2, 1, 3, 6, 5)] },
  towers: {
    title: 'Twin towers',
    build: () => [rect(12, 4, 0, 0, 0), rect(3, 3, 1, 2, 1), rect(3, 3, 1, 16, 1), rect(2, 2, 2, 3, 2), rect(2, 2, 2, 17, 2), rect(1, 1, 3, 4, 3), rect(1, 1, 3, 18, 3)],
  },
  cross: { title: 'Cross', build: () => [rect(12, 4, 0, 0, 8), rect(4, 12, 0, 8, 0), rect(8, 2, 1, 4, 10), rect(2, 8, 1, 10, 4), rect(2, 2, 2, 10, 10)] },
};

const KINDS = [
  ...Array.from({ length: 9 }, (_, n) => ({ name: `Circles ${n + 1}`, face: String(n + 1), mark: '●', suit: 'c' })),
  ...Array.from({ length: 9 }, (_, n) => ({ name: `Bamboo ${n + 1}`, face: String(n + 1), mark: '|', suit: 'b' })),
  ...Array.from({ length: 9 }, (_, n) => ({ name: `Characters ${n + 1}`, face: String(n + 1), mark: '萬', suit: 'm' })),
  ...['East', 'South', 'West', 'North'].map((w) => ({ name: `${w} wind`, face: w[0], mark: '', suit: 'w' })),
  ...[['☀', 'Sun'], ['☾', 'Moon'], ['★', 'Star'], ['✿', 'Flower']].map(([face, name]) => ({ name, face, mark: '', suit: 'y' })),
];

function shuffle(a, random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Every square of a layout once, lowest layer first, then top to bottom and left to right.
export function positions(layout) {
  const seen = new Set();
  const out = [];
  for (const p of LAYOUTS[layout].build().flat()) {
    const id = `${p.x},${p.y},${p.z}`;
    if (!seen.has(id)) seen.add(id), out.push(p);
  }
  return out.sort((a, b) => a.z - b.z || a.y - b.y || a.x - b.x);
}

// A tile is free when nothing lies on top of it and at least one side (left or right) is open.
export function isFree(tiles, gone, i) {
  const t = tiles[i];
  let left = false;
  let right = false;
  for (let j = 0; j < tiles.length; j++) {
    if (j === i || gone[j]) continue;
    const u = tiles[j];
    const dx = u.x - t.x;
    const dy = Math.abs(u.y - t.y);
    if (u.z > t.z && Math.abs(dx) < 2 && dy < 2) return false;
    if (u.z === t.z && dy < 2) {
      if (dx === -2) left = true;
      if (dx === 2) right = true;
    }
  }
  return !left || !right;
}

// Takes the board apart two free tiles at a time and gives each pair a kind, so playing that order back clears it.
// Returns { kinds, order } or null when no such order turned up.
export function deal(pos, random = Math.random, pairKinds = null) {
  const n = pos.length;
  let ks = pairKinds;
  if (!ks) {
    const base = shuffle(KINDS.map((_, k) => k), random);
    ks = Array.from({ length: n / 2 }, (_, j) => base[j % base.length]);
  }
  for (let attempt = 0; attempt < 500; attempt++) {
    const gone = Array(n).fill(false);
    const order = [];
    for (;;) {
      const free = [];
      for (let i = 0; i < n; i++) if (!gone[i] && isFree(pos, gone, i)) free.push(i);
      if (free.length < 2) break;
      const a = free.splice(Math.floor(random() * free.length), 1)[0];
      const b = free[Math.floor(random() * free.length)];
      gone[a] = gone[b] = true;
      order.push([a, b]);
    }
    if (order.length * 2 === n) {
      const kinds = Array(n);
      order.forEach(([a, b], j) => (kinds[a] = kinds[b] = ks[j]));
      return { kinds, order };
    }
  }
  return null;
}

export function newGame(layout = 'pyramid', random = Math.random) {
  const id = LAYOUTS[layout] ? layout : 'pyramid';
  const pos = positions(id);
  let d = null;
  while (!d) d = deal(pos, random);
  return { layout: id, tiles: pos.map((p, i) => ({ ...p, k: d.kinds[i] })), gone: Array(pos.length).fill(false), sel: -1, history: [], done: false };
}

// The first two free tiles that match, or null when there are none.
export function moves(st) {
  const seen = new Map();
  for (let i = 0; i < st.tiles.length; i++) {
    if (st.gone[i] || !isFree(st.tiles, st.gone, i)) continue;
    const k = st.tiles[i].k;
    if (seen.has(k)) return [seen.get(k), i];
    seen.set(k, i);
  }
  return null;
}

// Deals the tiles still on the board again so they can be cleared. False when that can't be done.
export function reshuffle(st, random = Math.random) {
  const left = st.tiles.map((_, i) => i).filter((i) => !st.gone[i]);
  const sorted = left.map((i) => st.tiles[i].k).sort((a, b) => a - b);
  const pairs = shuffle(sorted.filter((_, m) => m % 2 === 0), random);
  const d = deal(left.map((i) => st.tiles[i]), random, pairs);
  if (!d) return false;
  left.forEach((i, m) => (st.tiles[i].k = d.kinds[m]));
  st.history = [];
  st.sel = -1;
  return true;
}

export function mountMahjong(host) {
  const key = 'outpost.mahjong';
  const saved = store.get(key, null);
  let st =
    saved?.tiles?.length && LAYOUTS[saved.layout] && saved.gone?.length === saved.tiles.length ? saved : newGame(store.get('outpost.mahjong.layout', 'pyramid'));
  let hint = [];
  const save = () => store.set(key, st);

  function render(focus = -1) {
    const left = st.gone.filter((g) => !g).length;
    const stuck = !st.done && !moves(st);
    let maxX = 0;
    let maxY = 0;
    let maxZ = 0;
    for (const t of st.tiles) (maxX = Math.max(maxX, t.x)), (maxY = Math.max(maxY, t.y)), (maxZ = Math.max(maxZ, t.z));
    const tiles = st.tiles
      .map((t, i) => {
        if (st.gone[i]) return '';
        const kind = KINDS[t.k];
        const free = isFree(st.tiles, st.gone, i);
        const cls = ['mj', `s-${kind.suit}`, free ? '' : 'blocked', st.sel === i ? 'sel' : '', hint.includes(i) ? 'hint' : ''].filter(Boolean).join(' ');
        return `<button type="button" class="${cls}" data-i="${i}" style="--x:${t.x};--y:${t.y};--z:${t.z}" aria-label="${esc(kind.name)}${free ? '' : ', blocked'}"${st.sel === i ? ' aria-pressed="true"' : ''} tabindex="${free ? 0 : -1}"><b>${esc(kind.face)}</b><i>${esc(kind.mark)}</i></button>`;
      })
      .join('');
    const layouts = Object.entries(LAYOUTS).map(([id, l]) => `<option value="${id}"${st.layout === id ? ' selected' : ''}>${l.title}</option>`).join('');
    const status = st.done ? 'Board cleared!' : stuck ? 'No moves left. Try Shuffle.' : `${left} tiles left`;
    host.innerHTML = `<div class="row solbar"><button class="btn primary small" data-act="new">New game</button>
        <label class="small">Layout <select id="mj-layout">${layouts}</select></label>
        <button class="btn small" data-act="hint"${st.done || stuck ? ' disabled' : ''}>Hint</button>
        <button class="btn small" data-act="shuffle"${st.done ? ' disabled' : ''}>Shuffle</button>
        <button class="btn small" data-act="undo"${st.history.length ? '' : ' disabled'}>Undo</button>
        <span class="muted small" aria-live="polite">${status}</span></div>
      <div class="ms-wrap"><div class="mj-board" role="group" aria-label="Mahjong tiles" style="--cols:${(maxX + 2) / 2};--rows:${(maxY + 2) / 2};--zs:${maxZ}">${tiles}</div></div>
      <p class="muted small">Pick two matching tiles to take them off. A tile can be picked when nothing is on top of it and its left or right side is open; blocked tiles are shaded. Shuffle mixes the tiles left when you get stuck. Your game is saved in this browser.</p>`;
    if (focus >= 0) (host.querySelector(`.mj[data-i="${focus}"]`) || host.querySelector('.mj:not(.blocked)'))?.focus();
  }

  function pick(i) {
    if (st.done || st.gone[i] || !isFree(st.tiles, st.gone, i)) return;
    hint = [];
    if (st.sel === i) st.sel = -1;
    else if (st.sel >= 0 && st.tiles[st.sel].k === st.tiles[i].k) {
      st.gone[st.sel] = st.gone[i] = true;
      st.history.push([st.sel, i]);
      st.sel = -1;
      if (st.gone.every(Boolean)) {
        st.done = true;
        toast('Board cleared!');
      }
    } else st.sel = i;
    save();
    render(i);
  }

  function start(layout = st.layout) {
    if (st.history.length && !st.done && !confirm('Start a new game? This one will be lost.')) return void render();
    store.set('outpost.mahjong.layout', layout);
    st = newGame(layout);
    hint = [];
    save();
    render();
  }

  host.addEventListener('click', (e) => {
    const tile = e.target.closest('.mj');
    if (tile) return pick(Number(tile.dataset.i));
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'new') start();
    else if (a === 'hint') {
      hint = moves(st) || [];
      render();
    } else if (a === 'shuffle') {
      if (!reshuffle(st)) return toast("These tiles can't be shuffled into a winnable board. Undo or start a new game.");
      hint = [];
      save();
      render();
    } else if (a === 'undo' && st.history.length) {
      const [x, y] = st.history.pop();
      st.gone[x] = st.gone[y] = false;
      st.done = false;
      st.sel = -1;
      hint = [];
      save();
      render();
    }
  });
  host.addEventListener('change', (e) => e.target.id === 'mj-layout' && start(e.target.value));
  render();
}

export const _test = { LAYOUTS, KINDS, positions, isFree, deal, moves, newGame, reshuffle };
