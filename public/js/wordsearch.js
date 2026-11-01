import { esc, store, toast } from './core.js';

/*
 * Word search written for Outpost. Each puzzle hides a themed list of words in a grid of letters. Words run across and
 * down; bigger grids add diagonals and words spelled backwards. Drag across a word, or click its first and then its last
 * letter, to circle it. Puzzles are made here in the browser from the word lists below. Saved in this browser.
 */

export const LEVELS = {
  easy: { title: 'Easy', w: 8, h: 8, count: 6, dirs: [[1, 0], [0, 1]] },
  medium: { title: 'Medium', w: 11, h: 11, count: 9, dirs: [[1, 0], [0, 1], [1, 1], [1, -1]] },
  hard: { title: 'Hard', w: 14, h: 14, count: 12, dirs: [[1, 0], [0, 1], [1, 1], [1, -1], [-1, 0], [0, -1], [-1, -1], [-1, 1]] },
};

export const THEMES = {
  Animals: 'OTTER BADGER RABBIT FALCON BEAVER MOOSE HERON LIZARD TURTLE SPARROW WALRUS FERRET PANDA CAMEL ZEBRA KOALA',
  Fruit: 'APPLE MANGO PEACH LEMON CHERRY BANANA GRAPE PAPAYA MELON APRICOT KIWI PLUM ORANGE LIME GUAVA FIG',
  Weather: 'RAIN CLOUD STORM THUNDER BREEZE SNOW FROST SUNNY MIST HAIL RAINBOW DRIZZLE WIND SLEET FOG HUMID',
  Kitchen: 'SPOON KETTLE OVEN LADLE WHISK PLATE BOWL GRATER TOASTER FORK KNIFE SKILLET APRON MUG SIEVE TONGS',
  Camping: 'TENT LANTERN COMPASS MAP CANOE TRAIL CAMPFIRE HAMMOCK BACKPACK STOVE ROPE KNOT RIVER FOREST CABIN PADDLE',
  Space: 'PLANET COMET ORBIT ROCKET GALAXY NEBULA METEOR SATURN MARS MOON STAR ASTEROID ECLIPSE VENUS COSMOS LUNAR',
  Music: 'PIANO GUITAR DRUM VIOLIN FLUTE CHORD MELODY RHYTHM TEMPO HARP CELLO BANJO TRUMPET OBOE CHORUS TUBA',
  Ocean: 'CORAL WAVE SHARK WHALE TIDE REEF SHELL CRAB SQUID DOLPHIN ANCHOR HARBOR SEAWEED LOBSTER SAND KELP',
};

const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function shuffle(a, random) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Hides each word (longest first) at a random spot and direction, sharing letters where they match. Words that will not
// fit are left out.
export function placeWords(words, w, h, dirs, random = Math.random) {
  const grid = Array(w * h).fill('');
  const placed = [];
  for (const word of [...words].sort((a, b) => b.length - a.length)) {
    for (let n = 0; n < 300; n++) {
      const [dx, dy] = dirs[Math.floor(random() * dirs.length)];
      const x = Math.floor(random() * w);
      const y = Math.floor(random() * h);
      const ex = x + dx * (word.length - 1);
      const ey = y + dy * (word.length - 1);
      if (ex < 0 || ey < 0 || ex >= w || ey >= h) continue;
      const cells = Array.from(word, (_, k) => (y + dy * k) * w + x + dx * k);
      if (!cells.every((c, k) => grid[c] === '' || grid[c] === word[k])) continue;
      cells.forEach((c, k) => (grid[c] = word[k]));
      placed.push({ word, cells });
      break;
    }
  }
  return { grid, placed };
}

export function generate(level = 'easy', random = Math.random) {
  const id = LEVELS[level] ? level : 'easy';
  const l = LEVELS[id];
  const names = Object.keys(THEMES);
  const theme = names[Math.floor(random() * names.length)];
  const pool = THEMES[theme].split(' ').filter((wd) => wd.length <= Math.min(l.w, l.h));
  let best = null;
  for (let n = 0; n < 20; n++) {
    const out = placeWords(shuffle([...pool], random).slice(0, l.count), l.w, l.h, l.dirs, random);
    if (!best || out.placed.length > best.placed.length) best = out;
    if (best.placed.length === l.count) break;
  }
  const grid = best.grid.map((c) => c || ABC[Math.floor(random() * 26)]).join('');
  const words = best.placed.map((p) => p.word).sort();
  return { level: id, theme, w: l.w, h: l.h, grid, words, found: {}, sel: 0, done: false };
}

// The squares on a straight line from a to b (across, down or a 45° diagonal), or null for any other shape.
export function lineCells(w, a, b) {
  const ax = a % w;
  const ay = Math.floor(a / w);
  const dx = (b % w) - ax;
  const dy = Math.floor(b / w) - ay;
  if (dx && dy && Math.abs(dx) !== Math.abs(dy)) return null;
  const n = Math.max(Math.abs(dx), Math.abs(dy));
  return Array.from({ length: n + 1 }, (_, k) => (ay + Math.sign(dy) * k) * w + ax + Math.sign(dx) * k);
}

// The word not yet found that the squares from a to b spell, either way round, or null.
export function matchSelection(st, a, b) {
  const cells = lineCells(st.w, a, b);
  if (!cells || cells.length < 2) return null;
  const s = cells.map((c) => st.grid[c]).join('');
  const r = [...s].reverse().join('');
  const word = st.words.find((wd) => !st.found[wd] && (wd === s || wd === r));
  return word ? { word, cells } : null;
}

export const won = (st) => st.words.every((wd) => st.found[wd]);

export function mountWordSearch(host) {
  const key = 'outpost.wordsearch';
  const saved = store.get(key, null);
  let st = saved?.grid?.length === saved?.w * saved?.h && LEVELS[saved.level] ? saved : generate(store.get('outpost.wordsearch.level', 'easy'));
  let anchor = null; // first letter of the word being picked
  let dragging = false;
  const save = () => store.set(key, st);

  function render(hover = null) {
    const foundAt = new Set(Object.values(st.found).flat());
    const pick = new Set(anchor === null ? [] : lineCells(st.w, anchor, hover ?? anchor) || [anchor]);
    const cells = Array.from(st.grid, (ch, i) => {
      const cls = ['ws', foundAt.has(i) ? 'found' : '', pick.has(i) ? 'pick' : ''].filter(Boolean).join(' ');
      const label = `${ch}, row ${Math.floor(i / st.w) + 1}, column ${(i % st.w) + 1}${foundAt.has(i) ? ', found' : ''}`;
      return `<button type="button" role="gridcell" class="${cls}" data-i="${i}" tabindex="${i === st.sel ? 0 : -1}" aria-label="${label}">${ch}</button>`;
    });
    const rows = Array.from({ length: st.h }, (_, r) => `<div role="row" class="ws-row">${cells.slice(r * st.w, r * st.w + st.w).join('')}</div>`);
    const list = st.words.map((wd) => `<li${st.found[wd] ? ' class="found"' : ''}>${esc(wd)}</li>`).join('');
    const left = st.words.filter((wd) => !st.found[wd]).length;
    const levels = Object.entries(LEVELS).map(([id, l]) => `<option value="${id}"${st.level === id ? ' selected' : ''}>${l.title} (${l.w}×${l.h})</option>`).join('');
    host.innerHTML = `<div class="row solbar"><button class="btn primary small" data-act="new">New puzzle</button>
        <label class="small">Level <select id="ws-level">${levels}</select></label>
        <span class="muted small" aria-live="polite">${st.done ? 'All words found!' : `${esc(st.theme)}: ${left} of ${st.words.length} words left`}</span></div>
      <div class="ws-layout"><div class="ms-wrap"><div class="ws-grid${st.done ? ' done' : ''}" role="grid" aria-label="Word search" style="--cols:${st.w}">${rows.join('')}</div></div>
        <ul class="ws-words" aria-label="Words to find">${list}</ul></div>
      <p class="muted small">Drag across a word, or click its first letter and then its last. ${st.level === 'easy' ? 'Words run across and down.' : st.level === 'medium' ? 'Words run across, down and diagonally.' : 'Words run in any direction, even backwards.'} Arrow keys move, Space or Enter picks a letter. Your puzzle is saved in this browser.</p>`;
  }

  function focusSel() {
    host.querySelector(`.ws[data-i="${st.sel}"]`)?.focus();
  }

  // Ends a pick at square b: circles the word if the line spells one.
  function pickTo(b) {
    const m = matchSelection(st, anchor, b);
    anchor = null;
    st.sel = b;
    if (m) {
      st.found[m.word] = m.cells;
      if (won(st)) {
        st.done = true;
        toast('Word search complete!');
      }
      save();
    }
    render();
    focusSel();
  }

  function newGame(level = st.level) {
    if (!st.done && Object.keys(st.found).length && !confirm('Start a new puzzle? This one will be lost.')) return void render();
    store.set('outpost.wordsearch.level', level);
    st = generate(level);
    anchor = null;
    save();
    render();
  }

  host.addEventListener('pointerdown', (e) => {
    const b = e.target.closest('.ws');
    if (!b || st.done || e.button !== 0) return;
    e.preventDefault();
    b.releasePointerCapture?.(e.pointerId);
    const i = Number(b.dataset.i);
    if (anchor !== null && anchor !== i) return pickTo(i);
    anchor = i;
    dragging = true;
    st.sel = i;
    render();
  });
  host.addEventListener('pointerover', (e) => {
    const b = e.target.closest('.ws');
    if (b && dragging) render(Number(b.dataset.i));
  });
  addEventListener('pointerup', (e) => {
    if (!dragging) return;
    dragging = false;
    const b = e.target.closest?.('.ws');
    const i = b && host.contains(b) ? Number(b.dataset.i) : anchor;
    // Letting go on the first letter keeps it picked, so a second click can finish the word.
    if (host.isConnected && i !== anchor) pickTo(i);
  });
  host.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]')?.dataset.act;
    if (a === 'new') newGame();
  });
  host.addEventListener('change', (e) => e.target.id === 'ws-level' && newGame(e.target.value));
  host.addEventListener('keydown', (e) => {
    if (!e.target.closest('.ws-grid') || e.metaKey || e.ctrlKey || e.altKey) return;
    const x = st.sel % st.w;
    const y = Math.floor(st.sel / st.w);
    const to = { ArrowUp: [x, y - 1], ArrowDown: [x, y + 1], ArrowLeft: [x - 1, y], ArrowRight: [x + 1, y] }[e.key];
    if (to) {
      e.preventDefault();
      st.sel = ((to[1] + st.h) % st.h) * st.w + ((to[0] + st.w) % st.w);
      render(st.sel);
      return focusSel();
    }
    if ((e.key === ' ' || e.key === 'Enter') && !st.done) {
      e.preventDefault();
      if (anchor === null || anchor === st.sel) {
        anchor = anchor === null ? st.sel : null;
        render();
        focusSel();
      } else pickTo(st.sel);
    } else if (e.key === 'Escape' && anchor !== null) {
      anchor = null;
      render();
      focusSel();
    }
  });
  render();
}

export const _test = { placeWords, generate, lineCells, matchSelection, won };
