import { $, esc, store, toast } from './core.js';

/*
 * Card solitaire written for Outpost: Klondike, FreeCell and Spider. Click a card to pick it up (with the cards on top
 * of it), then click where it should go; double-click sends a card to the foundations. Each game is saved in this
 * browser, so leaving the page and coming back carries on where you were.
 */

const SUITS = ['♠', '♥', '♦', '♣'];
const SUIT_NAMES = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RANK_NAMES = ['', 'Ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'Jack', 'Queen', 'King'];
const red = (c) => c.s === 1 || c.s === 2;

export const GAMES = {
  klondike: { title: 'Klondike', blurb: 'The classic. Build down in alternating colours and move every card to the four foundations, ace to king.' },
  freecell: { title: 'FreeCell', blurb: 'Every card is face up. Use the four free cells to park cards; almost every deal can be won.' },
  spider: { title: 'Spider', blurb: 'Two decks, ten columns. Build runs from king down to ace in one suit to clear them away.' },
};

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function deck(suits = [0, 1, 2, 3], copies = 1) {
  const out = [];
  for (let n = 0; n < copies; n++) for (const s of suits) for (let r = 1; r <= 13; r++) out.push({ s, r, up: false });
  return shuffle(out);
}

function deal(game, opts = {}) {
  if (game === 'klondike') {
    const cards = deck();
    const tab = Array.from({ length: 7 }, (_, i) => cards.splice(0, i + 1));
    tab.forEach((col) => (col.at(-1).up = true));
    return { game, tab, stock: cards, waste: [], found: [[], [], [], []], moves: 0 };
  }
  if (game === 'freecell') {
    const cards = deck().map((c) => ({ ...c, up: true }));
    const tab = Array.from({ length: 8 }, () => []);
    cards.forEach((c, i) => tab[i % 8].push(c));
    return { game, tab, cells: [null, null, null, null], found: [[], [], [], []], moves: 0 };
  }
  // Spider: 104 cards in one, two or four suits; 54 dealt (six in the first four columns, five in the rest).
  const suits = opts.suits === 4 ? [0, 1, 2, 3] : opts.suits === 2 ? [0, 1] : [0];
  const cards = deck(suits, 8 / suits.length);
  const tab = Array.from({ length: 10 }, (_, i) => cards.splice(0, i < 4 ? 6 : 5));
  tab.forEach((col) => (col.at(-1).up = true));
  return { game, suits: suits.length, tab, stock: cards, done: [], moves: 0 };
}

// --- rules ---

/** Can cards[from..] be lifted off a tableau column as one run? */
function isRun(st, col, from) {
  for (let i = from; i < col.length; i++) {
    if (!col[i].up) return false;
    if (i === from) continue;
    const a = col[i - 1], b = col[i];
    if (a.r !== b.r + 1) return false;
    if (st.game === 'spider' ? a.s !== b.s : red(a) === red(b)) return false;
  }
  return true;
}

/** FreeCell moves a run one card at a time through empty cells and columns, so long runs need room. */
function freecellLimit(st, toEmptyColumn) {
  const cells = st.cells.filter((c) => !c).length;
  const cols = st.tab.filter((c) => !c.length).length - (toEmptyColumn ? 1 : 0);
  return (cells + 1) * 2 ** Math.max(0, cols);
}

function pile(st, id) {
  const k = id[0], n = Number(id.slice(1));
  if (id === 'stock') return st.stock;
  if (id === 'waste') return st.waste;
  if (k === 'f') return st.found[n];
  if (k === 't') return st.tab[n];
  return null;
}

/** The cards picked up from (pile, index), or null when they can't be moved together. */
function lift(st, from, i) {
  if (from[0] === 'c') return st.cells[Number(from.slice(1))] ? [st.cells[Number(from.slice(1))]] : null;
  const p = pile(st, from);
  if (!p || !p.length || from === 'stock') return null;
  if (from === 'waste' || from[0] === 'f') return [p.at(-1)];
  if (i < 0 || i >= p.length || !isRun(st, p, i)) return null;
  return p.slice(i);
}

function canDrop(st, cards, to) {
  const c = cards[0];
  const k = to[0], n = Number(to.slice(1));
  if (k === 'f') {
    if (cards.length !== 1 || st.game === 'spider') return false;
    const f = st.found[n];
    return f.length ? f.at(-1).s === c.s && f.at(-1).r === c.r - 1 : c.r === 1;
  }
  if (k === 'c') return cards.length === 1 && !st.cells[n];
  if (k !== 't') return false;
  const col = st.tab[n];
  if (st.game === 'freecell' && cards.length > freecellLimit(st, !col.length)) return false;
  if (!col.length) return st.game !== 'klondike' || c.r === 13;
  const top = col.at(-1);
  if (!top.up || top.r !== c.r + 1) return false;
  return st.game === 'spider' || red(top) !== red(c);
}

/** Moves cards from `from` (starting at index i) to `to`; returns false when the rules don't allow it. */
function move(st, from, i, to) {
  if (from === to) return false;
  const cards = lift(st, from, i);
  if (!cards || !canDrop(st, cards, to)) return false;
  if (from[0] === 'c') st.cells[Number(from.slice(1))] = null;
  else pile(st, from).splice(pile(st, from).length - cards.length);
  if (to[0] === 'c') st.cells[Number(to.slice(1))] = cards[0];
  else pile(st, to).push(...cards);
  st.moves++;
  settle(st);
  return true;
}

/** After a move: turn up uncovered cards, and in Spider clear any finished king-to-ace run. */
function settle(st) {
  for (const col of st.tab) {
    if (st.game === 'spider' && col.length >= 13) {
      const start = col.length - 13;
      if (col[start].r === 13 && isRun(st, col, start)) st.done.push(col.splice(start)[0].s);
    }
    if (col.length && !col.at(-1).up) col.at(-1).up = true;
  }
}

function won(st) {
  return st.game === 'spider' ? st.done.length === 8 : st.found.every((f) => f.length === 13);
}

/** A foundation that takes this one card, if any. */
function foundationFor(st, card) {
  if (st.game === 'spider') return null;
  for (let n = 0; n < 4; n++) if (canDrop(st, [card], `f${n}`)) return `f${n}`;
  return null;
}

/** Klondike: once nothing is hidden or left in the stock, the rest plays itself. */
function autoFinish(st) {
  if (st.game !== 'klondike' || st.stock.length || st.waste.length || st.tab.some((c) => c.some((x) => !x.up))) return false;
  let moved = false;
  for (let again = true; again; ) {
    again = false;
    st.tab.forEach((col, n) => {
      const f = col.length && foundationFor(st, col.at(-1));
      if (f && move(st, `t${n}`, col.length - 1, f)) again = moved = true;
    });
  }
  return moved;
}

// --- view ---

const label = (c) => `${RANK_NAMES[c.r]} of ${SUIT_NAMES[c.s]}`;

function face(c, attrs) {
  return `<button type="button" class="pcard${red(c) ? ' red' : ''}" aria-label="${label(c)}" ${attrs}><span class="pc-corner">${RANKS[c.r]}<br>${SUITS[c.s]}</span><span class="pc-pip" aria-hidden="true">${SUITS[c.s]}</span></button>`;
}

const back = (attrs = '') => `<div class="pcard back" ${attrs}></div>`;

export function mountSolitaire(host, game) {
  const key = `outpost.solitaire.${game}`;
  const saved = store.get(key, null);
  let st = saved?.game === game ? saved : deal(game, { suits: store.get('outpost.solitaire.spiderSuits', 1) });
  let undo = [];
  let pick = null; // { from, i }

  function save() {
    store.set(key, st);
  }

  function slot(id, inner, cls = '') {
    return `<div class="pslot ${cls}" data-pile="${id}">${inner}</div>`;
  }

  function topCard(id, cards, emptyLabel) {
    const c = cards.at(-1);
    if (!c) return `<button type="button" class="pcard empty" aria-label="${emptyLabel}" data-pile="${id}" data-i="-1">${id[0] === 'f' ? 'A' : ''}</button>`;
    const sel = pick && pick.from === id ? ' sel' : '';
    return face(c, `data-pile="${id}" data-i="${cards.length - 1}"`).replace('class="pcard', `class="pcard${sel}`);
  }

  function column(n) {
    const col = st.tab[n];
    const id = `t${n}`;
    if (!col.length) return slot(id, `<button type="button" class="pcard empty" aria-label="Empty column ${n + 1}" data-pile="${id}" data-i="-1"></button>`, 'col');
    let y = 0;
    const cards = col.map((c, i) => {
      const style = `style="top:calc(var(--cw) * ${y.toFixed(2)})"`;
      y += c.up ? 0.3 : 0.14;
      if (!c.up) return back(style);
      const sel = pick && pick.from === id && i >= pick.i ? ' sel' : '';
      return face(c, `data-pile="${id}" data-i="${i}" ${style}`).replace('class="pcard', `class="pcard${sel}`);
    });
    const h = `calc(var(--cw) * ${(y - (col.at(-1).up ? 0.3 : 0.14) + 1.4).toFixed(2)})`;
    return `<div class="pslot col" data-pile="${id}" style="height:${h}">${cards.join('')}</div>`;
  }

  function topRow() {
    if (st.game === 'klondike') {
      const stock = st.stock.length
        ? `<button type="button" class="pcard back" data-pile="stock" aria-label="Turn over a card (${st.stock.length} left)"></button>`
        : `<button type="button" class="pcard empty" data-pile="stock" aria-label="Turn the pile back over">↻</button>`;
      return `${slot('stock', stock)}${slot('waste', st.waste.length ? topCard('waste', st.waste, '') : '<div class="pcard empty"></div>')}<div></div>${st.found.map((f, n) => slot(`f${n}`, topCard(`f${n}`, f, 'Empty foundation'))).join('')}`;
    }
    if (st.game === 'freecell') {
      const cells = st.cells.map((c, n) => slot(`c${n}`, c ? topCard(`c${n}`, [c], '') : `<button type="button" class="pcard empty cell" aria-label="Empty free cell" data-pile="c${n}" data-i="-1"></button>`));
      return cells.join('') + st.found.map((f, n) => slot(`f${n}`, topCard(`f${n}`, f, 'Empty foundation'))).join('');
    }
    const deals = st.stock.length / 10;
    const stock = deals
      ? `<button type="button" class="pcard back" data-pile="stock" aria-label="Deal a card to every column (${deals} deals left)"><span class="pc-count">${deals}</span></button>`
      : '<div class="pcard empty"></div>';
    const done = st.done.map((s) => `<div class="pcard${s === 1 || s === 2 ? ' red' : ''}"><span class="pc-corner">K<br>${SUITS[s]}</span><span class="pc-pip">${SUITS[s]}</span></div>`);
    while (done.length < 8) done.push('<div class="pcard empty"></div>');
    return slot('stock', stock) + '<div></div>' + done.map((d) => `<div class="pslot">${d}</div>`).join('');
  }

  function render() {
    const cols = st.tab.length;
    const spiderPick = game === 'spider'
      ? `<label class="small">Suits <select id="ps-suits"><option value="1"${st.suits === 1 ? ' selected' : ''}>1 (easier)</option><option value="2"${st.suits === 2 ? ' selected' : ''}>2</option><option value="4"${st.suits === 4 ? ' selected' : ''}>4 (hard)</option></select></label>`
      : '';
    host.innerHTML = `<div class="row solbar"><button class="btn primary small" data-act="new">New game</button><button class="btn small" data-act="undo"${undo.length ? '' : ' disabled'}>Undo</button>${spiderPick}<span class="muted small" aria-live="polite">${won(st) ? 'You won!' : `Moves: ${st.moves}`}</span></div>
      <div class="solboard" style="--cols:${cols}">
        <div class="solrow">${topRow()}</div>
        <div class="solrow tab">${st.tab.map((_, n) => column(n)).join('')}</div>
      </div>`;
    size();
  }

  function size() {
    const board = $('.solboard', host);
    if (!board) return;
    const cols = st.tab.length;
    // The board's padding is one gap on each side, so the room for cards is the width less cols + 1 gaps.
    const gap = Math.min(12, board.clientWidth / cols / 8);
    board.style.setProperty('--gap', `${gap}px`);
    board.style.setProperty('--cw', `${Math.min(96, (board.clientWidth - gap * (cols + 1)) / cols)}px`);
  }

  function act(fn) {
    const before = JSON.stringify(st);
    if (!fn()) return false;
    undo.push(before);
    if (undo.length > 200) undo.shift();
    autoFinish(st);
    pick = null;
    save();
    render();
    if (won(st)) toast(`${GAMES[game].title}: you won in ${st.moves} moves!`);
    return true;
  }

  function newGame() {
    if (st.moves && !won(st) && !confirm('Start a new game? This one will be lost.')) return;
    st = deal(game, { suits: Number($('#ps-suits', host)?.value) || store.get('outpost.solitaire.spiderSuits', 1) });
    undo = [];
    pick = null;
    save();
    render();
  }

  function clickStock() {
    if (game === 'klondike') {
      act(() => {
        if (st.stock.length) {
          const c = st.stock.pop();
          c.up = true;
          st.waste.push(c);
        } else if (st.waste.length) {
          st.stock = st.waste.reverse().map((c) => ({ ...c, up: false }));
          st.waste = [];
        } else return false;
        st.moves++;
        return true;
      });
    } else if (game === 'spider' && st.stock.length) {
      if (st.tab.some((c) => !c.length)) return void toast('Fill every empty column before dealing.', 'error');
      act(() => {
        st.tab.forEach((col) => col.push({ ...st.stock.pop(), up: true }));
        st.moves++;
        settle(st);
        return true;
      });
    }
  }

  function onClick(e) {
    const btn = e.target.closest('[data-act]');
    if (btn) {
      if (btn.dataset.act === 'new') newGame();
      if (btn.dataset.act === 'undo' && undo.length) {
        st = JSON.parse(undo.pop());
        pick = null;
        save();
        render();
      }
      return;
    }
    const el = e.target.closest('[data-pile]');
    if (!el || !host.contains(el)) return;
    const id = el.dataset.pile;
    if (id === 'stock') return void clickStock();
    const i = el.dataset.i === undefined ? -1 : Number(el.dataset.i);
    if (pick) {
      const from = pick;
      pick = null;
      if (from.from === id && from.i === i) return void render();
      if (act(() => move(st, from.from, from.i, id))) return;
    }
    // Nothing picked up yet (or the move didn't fit): pick up this card if it can move.
    const cards = i >= 0 || id[0] === 'c' ? lift(st, id, i) : null;
    pick = cards ? { from: id, i } : null;
    render();
  }

  function onDouble(e) {
    const el = e.target.closest('.pcard[data-pile]');
    if (!el || game === 'spider') return;
    const id = el.dataset.pile;
    const i = Number(el.dataset.i);
    const cards = lift(st, id, i);
    if (!cards || cards.length !== 1) return;
    const f = foundationFor(st, cards[0]);
    if (f) act(() => move(st, id, i, f));
  }

  function onChange(e) {
    if (e.target.id !== 'ps-suits') return;
    store.set('outpost.solitaire.spiderSuits', Number(e.target.value));
    if (st.moves && !won(st) && !confirm('Start a new game with this many suits? This one will be lost.')) return void render();
    st = deal(game, { suits: Number(e.target.value) });
    undo = [];
    save();
    render();
  }

  host.addEventListener('click', onClick);
  host.addEventListener('dblclick', onDouble);
  host.addEventListener('change', onChange);
  const ro = new ResizeObserver(size);
  ro.observe(host);
  render();
  return () => ro.disconnect();
}

export const _test = { deal, move, lift, canDrop, isRun, won, settle, esc };
