import { $, esc, store, toast } from './core.js';
import { CalcError, evaluate, format } from './calc-engine.js';
import { CATEGORIES, convert, formatAmount } from './units.js';

/* The Calculator (standard and scientific) and the Unit converter on the Tools page. Both work offline in the page. */

// [label, what it types or does, spoken name]
const STANDARD = [
  ['AC', { act: 'clear' }, 'Clear'], ['⌫', { act: 'back' }, 'Delete'], ['%', '%', 'Percent'], ['÷', '÷', 'Divide'],
  ['7', '7'], ['8', '8'], ['9', '9'], ['×', '×', 'Times'],
  ['4', '4'], ['5', '5'], ['6', '6'], ['−', '−', 'Minus'],
  ['1', '1'], ['2', '2'], ['3', '3'], ['+', '+', 'Plus'],
  ['±', { act: 'neg' }, 'Change sign'], ['0', '0'], ['.', '.', 'Point'], ['=', { act: 'eq' }, 'Equals'],
];
const SCIENTIFIC = [
  ['(', '('], [')', ')'], ['x²', '²', 'Squared'], ['xʸ', '^', 'To the power of'], ['√', '√(', 'Square root'],
  ['sin', 'sin('], ['cos', 'cos('], ['tan', 'tan('], ['ln', 'ln(', 'Natural log'], ['log', 'log(', 'Log base 10'],
  ['sin⁻¹', 'sin⁻¹(', 'Inverse sine'], ['cos⁻¹', 'cos⁻¹(', 'Inverse cosine'], ['tan⁻¹', 'tan⁻¹(', 'Inverse tangent'], ['eˣ', 'e^(', 'e to the power of'], ['10ˣ', '10^(', '10 to the power of'],
  ['π', 'π', 'Pi'], ['e', 'e'], ['n!', '!', 'Factorial'], ['1/x', '^(−1)', 'One over'], ['Ans', 'Ans', 'Previous answer'],
];
const OPERATOR = /^[+−×÷^%!²)]/;

const key = ([label, does, name]) => {
  const attrs = typeof does === 'string' ? `data-ins="${esc(does)}"` : `data-act="${does.act}"`;
  const cls = /^[0-9.]$/.test(label) ? 'digit' : does.act === 'eq' ? 'eq' : does.act === 'clear' || does.act === 'back' ? 'fn' : 'op';
  return `<button type="button" class="ck ${cls}" ${attrs}${name ? ` aria-label="${esc(name)}"` : ''}>${esc(label)}</button>`;
};

export const CALCULATOR = {
  id: 'calc',
  title: 'Calculator',
  desc: 'Standard and scientific, with history',
  html: `<div class="calc" data-mode="standard">
      <div class="calcbar"><div class="seg" role="group" aria-label="Calculator type"><button type="button" data-mode="standard" aria-pressed="true">Standard</button><button type="button" data-mode="scientific" aria-pressed="false">Scientific</button></div>
        <div class="seg calcangle" role="group" aria-label="Angles in"><button type="button" data-angle="deg" aria-pressed="true">Degrees</button><button type="button" data-angle="rad" aria-pressed="false">Radians</button></div></div>
      <div class="calcscreen"><input id="calc-in" class="calcexpr" autocomplete="off" spellcheck="false" autocapitalize="none" inputmode="none" aria-label="Calculation" placeholder="0">
        <output id="calc-out" class="calcres" aria-live="polite"></output></div>
      <div class="calckeys"><div class="ckgrid sci">${SCIENTIFIC.map(key).join('')}</div><div class="ckgrid std">${STANDARD.map(key).join('')}</div></div>
      <div class="calchist"><div class="row"><strong>History</strong><button type="button" class="btn small" data-act="copy">Copy answer</button><button type="button" class="btn small" data-act="forget">Clear history</button></div><ol id="calc-hist"></ol></div>
      <p class="muted small">Type with the keyboard too: Enter works it out, Esc clears. 50 + 10% means 50 plus 10% of 50.</p></div>`,
  wire(el) {
    const box = $('.calc', el);
    const input = $('#calc-in', el);
    const out = $('#calc-out', el);
    let ans = store.get('outpost.calcAns', 0);
    let deg = store.get('outpost.calcDeg', true);
    let history = store.get('outpost.calcHistory', []);
    let done = false; // the screen shows a finished answer
    let last = null; // that answer

    const setMode = (mode) => {
      box.dataset.mode = mode;
      for (const b of box.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
      store.set('outpost.calcMode', mode);
    };
    const setAngle = (isDeg) => {
      deg = isDeg;
      for (const b of box.querySelectorAll('[data-angle]')) b.setAttribute('aria-pressed', String((b.dataset.angle === 'deg') === deg));
      store.set('outpost.calcDeg', deg);
      preview();
    };
    const paintHistory = () => {
      $('#calc-hist', el).innerHTML = history.length
        ? history.map((h, i) => `<li><button type="button" class="linkbtn" data-hist="${i}">${esc(h.expr)} = <b>${esc(h.result)}</b></button></li>`).join('')
        : '<li class="muted">Your calculations appear here.</li>';
    };
    function preview() {
      out.classList.remove('err');
      if (done) return;
      const text = input.value.trim();
      if (!text) return void (out.textContent = '');
      try {
        out.textContent = `= ${format(evaluate(text, { deg, ans }))}`;
        out.classList.add('soft');
      } catch {
        out.textContent = '';
      }
    }
    function equals() {
      const text = input.value.trim();
      if (!text) return;
      try {
        const v = evaluate(text, { deg, ans });
        const result = format(v);
        ans = v;
        last = result;
        store.set('outpost.calcAns', ans);
        history = [{ expr: text, result }, ...history.filter((h) => h.expr !== text)].slice(0, 20);
        store.set('outpost.calcHistory', history);
        paintHistory();
        out.classList.remove('soft', 'err');
        out.textContent = result;
        done = true;
      } catch (e) {
        out.classList.remove('soft');
        out.classList.add('err');
        out.textContent = e instanceof CalcError ? e.message : 'That can’t be worked out';
      }
    }
    function insert(text) {
      if (done) {
        // After an answer: an operator carries on from it, anything else starts afresh.
        input.value = OPERATOR.test(text) ? last : '';
        done = false;
      }
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      input.value = input.value.slice(0, start) + text + input.value.slice(end);
      const at = start + text.length;
      input.setSelectionRange(at, at);
      preview();
    }
    function negate() {
      if (done) {
        input.value = last;
        done = false;
      }
      const v = input.value;
      const wrapped = v.match(/\(−([\d.]+(?:E[+-]?\d+)?)\)$/);
      const plain = v.match(/([\d.]+(?:E[+-]?\d+)?)$/);
      if (wrapped) input.value = v.slice(0, -wrapped[0].length) + wrapped[1];
      else if (plain) input.value = v.slice(0, -plain[1].length) + `(−${plain[1]})`;
      else input.value = `${v}(−`;
      preview();
    }

    box.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.mode) return setMode(b.dataset.mode);
      if (b.dataset.angle) return setAngle(b.dataset.angle === 'deg');
      if (b.dataset.hist != null) {
        input.value = history[Number(b.dataset.hist)].expr;
        done = false;
        preview();
        return input.focus();
      }
      if (b.dataset.ins != null) insert(b.dataset.ins);
      const act = b.dataset.act;
      if (act === 'clear') {
        input.value = '';
        done = false;
        out.textContent = '';
      }
      if (act === 'back') {
        if (done) done = false;
        input.value = input.value.replace(/(sin⁻¹\(|cos⁻¹\(|tan⁻¹\(|[a-z]+\(|Ans|.)$/u, '');
        preview();
      }
      if (act === 'neg') negate();
      if (act === 'eq') equals();
      if (act === 'forget') {
        history = [];
        store.set('outpost.calcHistory', history);
        paintHistory();
      }
      if (act === 'copy') {
        const text = done ? last : out.textContent.replace(/^= /, '');
        if (!text) return toast('Nothing to copy yet');
        try {
          await navigator.clipboard.writeText(text);
          toast('Copied');
        } catch {
          toast('Copying needs localhost or the secure (https) address', 'error');
        }
      }
      // Keep typing in the box on computers; phones keep their on-screen keypad hidden (inputmode="none").
      if (!b.closest('.calchist')) input.focus({ preventScroll: true });
    });
    input.addEventListener('input', () => {
      done = false;
      preview();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === '=') {
        e.preventDefault();
        equals();
      }
      if (e.key === 'Escape') {
        input.value = '';
        done = false;
        out.textContent = '';
      }
      if (done && e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
        // A key pressed after an answer: same rule as the buttons.
        e.preventDefault();
        insert(e.key === '*' ? '×' : e.key === '/' ? '÷' : e.key === '-' ? '−' : e.key);
      }
    });

    setMode(store.get('outpost.calcMode', 'standard'));
    setAngle(deg);
    paintHistory();
  },
};

export const CONVERTER = {
  id: 'convert',
  title: 'Unit converter',
  desc: 'Length, weight, temperature, volume, area, speed, fuel and more',
  html: `<div class="conv">
      <div class="field"><label for="cv-cat">Measure</label><select id="cv-cat">${CATEGORIES.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>
      <div class="convpair">
        <div class="convside"><label for="cv-a">From</label><input id="cv-a" inputmode="decimal" autocomplete="off" value="1"><select id="cv-ua" aria-label="From unit"></select></div>
        <button type="button" class="btn convswap" data-act="swap" aria-label="Swap the units">⇄</button>
        <div class="convside"><label for="cv-b">To</label><input id="cv-b" inputmode="decimal" autocomplete="off"><select id="cv-ub" aria-label="To unit"></select></div>
      </div>
      <p class="muted small" id="cv-note"></p>
      <h4 class="convall">In every unit</h4>
      <table class="convtable"><tbody id="cv-all"></tbody></table></div>`,
  wire(el) {
    const cat = $('#cv-cat', el);
    const a = $('#cv-a', el);
    const b = $('#cv-b', el);
    const ua = $('#cv-ua', el);
    const ub = $('#cv-ub', el);
    const saved = store.get('outpost.convert', { cat: 'length', a: 'km', b: 'mi' });

    // Amounts may be sums ("2×12") and may use thousands separators ("1,500").
    const read = (input) => {
      const text = input.value.replace(/,/g, '').trim();
      if (!text) return null;
      try {
        return evaluate(text, { deg: true });
      } catch {
        return NaN;
      }
    };
    const units = () => CATEGORIES.find((c) => c.id === cat.value).units;

    function fillUnits(first, second) {
      const opts = units().map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('');
      ua.innerHTML = opts;
      ub.innerHTML = opts;
      ua.value = units().some((u) => u.id === first) ? first : units()[0].id;
      ub.value = units().some((u) => u.id === second) ? second : units()[1].id;
    }
    function remember() {
      store.set('outpost.convert', { cat: cat.value, a: ua.value, b: ub.value });
    }
    function update(from) {
      const [src, dst, su, du] = from === 'b' ? [b, a, ub, ua] : [a, b, ua, ub];
      const v = read(src);
      src.classList.toggle('bad', Number.isNaN(v));
      if (v === null || Number.isNaN(v)) {
        dst.value = '';
        $('#cv-all', el).innerHTML = '';
        $('#cv-note', el).textContent = Number.isNaN(v) ? 'Type a number, for example 12.5 or 3×4.' : '';
        return;
      }
      dst.value = formatAmount(convert(cat.value, su.value, du.value, v)).replace(/,/g, '');
      const unitName = (id) => units().find((u) => u.id === id).name;
      const one = convert(cat.value, ua.value, ub.value, 1);
      $('#cv-note', el).textContent = cat.value === 'temperature' || ua.value === 'l100' || ub.value === 'l100'
        ? ''
        : `Multiply by ${formatAmount(one)} to go from ${unitName(ua.value)} to ${unitName(ub.value)}.`;
      const base = read(a);
      $('#cv-all', el).innerHTML = units()
        .map((u) => `<tr${u.id === ub.value ? ' class="on"' : ''}><td>${esc(formatAmount(convert(cat.value, ua.value, u.id, base)))}</td><td>${esc(u.name)}</td></tr>`)
        .join('');
    }

    cat.addEventListener('change', () => {
      fillUnits(null, null);
      remember();
      update('a');
    });
    for (const s of [ua, ub]) {
      s.addEventListener('change', () => {
        remember();
        update('a');
      });
    }
    a.addEventListener('input', () => update('a'));
    b.addEventListener('input', () => update('b'));
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="swap"]')) {
        [ua.value, ub.value] = [ub.value, ua.value];
        remember();
        update('a');
      }
    });

    cat.value = CATEGORIES.some((c) => c.id === saved.cat) ? saved.cat : 'length';
    fillUnits(saved.a, saved.b);
    update('a');
  },
};
