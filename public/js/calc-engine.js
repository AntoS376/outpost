/*
 * The calculator's arithmetic: reads an expression like "2×(3+4)^2 − sin(30) + 10%" and works it out, without
 * eval. Precedence from lowest: + −, × ÷ (and implied multiplication, "2π"), unary minus, ^ (right to left),
 * then ! and % after a value. "a + b%" and "a − b%" mean a plus or minus b percent of a, as on a pocket calculator.
 */

export class CalcError extends Error {}

const FUNCS = {
  sin: (x, deg) => trig(Math.sin, x, deg),
  cos: (x, deg) => trig(Math.cos, x, deg),
  tan: (x, deg) => {
    if (deg && ((((x % 180) + 180) % 180) === 90)) throw new CalcError(`tan(${x}°) has no value`);
    return trig(Math.tan, x, deg);
  },
  asin: (x, deg) => inverse(Math.asin, x, deg, true),
  acos: (x, deg) => inverse(Math.acos, x, deg, true),
  atan: (x, deg) => inverse(Math.atan, x, deg, false),
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  ln: (x) => {
    if (x <= 0) throw new CalcError('ln needs a number above 0');
    return Math.log(x);
  },
  log: (x) => {
    if (x <= 0) throw new CalcError('log needs a number above 0');
    return Math.log10(x);
  },
  sqrt: (x) => {
    if (x < 0) throw new CalcError('No square root of a negative number');
    return Math.sqrt(x);
  },
  cbrt: Math.cbrt,
  abs: Math.abs,
  exp: Math.exp,
};
const ALIASES = { '√': 'sqrt', '∛': 'cbrt', 'sin⁻¹': 'asin', 'cos⁻¹': 'acos', 'tan⁻¹': 'atan' };
const CONSTS = { π: Math.PI, pi: Math.PI, e: Math.E };

/** Rounds away the last bits of floating-point noise, so sin(180°) is 0 and 0.1 + 0.2 is 0.3. */
const tidy = (v) => (Number.isFinite(v) ? Number(v.toPrecision(15)) : v);
function trig(f, x, deg) {
  const v = f(deg ? (x * Math.PI) / 180 : x);
  return Math.abs(v) < 1e-14 ? 0 : v;
}
function inverse(f, x, deg, bounded) {
  if (bounded && (x < -1 || x > 1)) throw new CalcError('Inverse sine and cosine need a number from −1 to 1');
  const v = f(x);
  return deg ? (v * 180) / Math.PI : v;
}
function factorial(n) {
  if (!Number.isInteger(n) || n < 0) throw new CalcError('! needs a whole number, 0 or more');
  if (n > 170) throw new CalcError('That factorial is too large');
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

/** Splits an expression into numbers, names and symbols. Accepts the keyboard's * / - as × ÷ −. */
export function tokenize(src) {
  const s = String(src).replace(/\*/g, '×').replace(/\//g, '÷').replace(/[−–]/g, '-').replace(/\s+/g, '');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    const num = rest.match(/^(\d+\.?\d*|\.\d+)(E[+-]?\d+)?/);
    if (num) {
      out.push({ t: 'num', v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const word = rest.match(/^(sin⁻¹|cos⁻¹|tan⁻¹|[a-zA-Z]+|π|√|∛)/);
    if (word) {
      let w = word[0];
      // Own names only: "constructor" or "toString" must not reach JavaScript's built-in object properties.
      const name = Object.hasOwn(ALIASES, w) ? ALIASES[w] : w.toLowerCase();
      if (Object.hasOwn(FUNCS, name)) out.push({ t: 'fn', v: name });
      else if (Object.hasOwn(CONSTS, name)) out.push({ t: 'num', v: CONSTS[name] });
      else if (name === 'ans') out.push({ t: 'ans' });
      else {
        // A run of letters like "pie": take known names from the front one by one.
        const known = Object.keys({ ...FUNCS, ...CONSTS, ans: 1 }).sort((a, b) => b.length - a.length).find((k) => name.startsWith(k));
        if (!known) throw new CalcError(`Unknown name "${w}"`);
        w = w.slice(0, known.length);
        out.push(Object.hasOwn(FUNCS, known) ? { t: 'fn', v: known } : known === 'ans' ? { t: 'ans' } : { t: 'num', v: CONSTS[known] });
      }
      i += w.length;
      continue;
    }
    const c = s[i];
    if ('+-×÷^!%()'.includes(c)) {
      out.push({ t: c });
      i++;
      continue;
    }
    if (c === '²' || c === '³') {
      out.push({ t: '^' }, { t: 'num', v: c === '²' ? 2 : 3 });
      i++;
      continue;
    }
    throw new CalcError(`Can't read "${c}"`);
  }
  return out;
}

/** Works out an expression. `deg`: angles in degrees. `ans`: the previous answer, for "Ans". */
export function evaluate(src, { deg = true, ans = 0 } = {}) {
  const toks = tokenize(src);
  if (!toks.length) throw new CalcError('Nothing to work out');
  let p = 0;
  const peek = () => toks[p];
  const take = (t) => {
    if (peek()?.t !== t) throw new CalcError(t === ')' ? 'A bracket is missing' : `Expected ${t}`);
    p++;
  };
  const startsValue = (k) => k && (k.t === 'num' || k.t === 'fn' || k.t === 'ans' || k.t === '(');

  // Each level returns { v, pct }: pct marks a value written with % (for "a + b%").
  function expr() {
    let left = term();
    while (peek()?.t === '+' || peek()?.t === '-') {
      const op = toks[p++].t;
      const right = term();
      const r = right.pct ? (left.v * right.v) : right.v;
      left = { v: op === '+' ? left.v + r : left.v - r, pct: false };
    }
    return left;
  }
  function term() {
    let left = unary();
    for (;;) {
      const k = peek();
      if (k?.t === '×' || k?.t === '÷') {
        p++;
        const right = unary();
        if (k.t === '÷' && right.v === 0) throw new CalcError("Can't divide by zero");
        left = { v: k.t === '×' ? left.v * right.v : left.v / right.v, pct: false };
      } else if (startsValue(k)) {
        left = { v: left.v * unary().v, pct: false }; // 2π, 3(4+1), 2sin(30)
      } else return left;
    }
  }
  function unary() {
    if (peek()?.t === '-') {
      p++;
      const v = unary();
      return { v: -v.v, pct: v.pct };
    }
    if (peek()?.t === '+') {
      p++;
      return unary();
    }
    return power();
  }
  function power() {
    const base = postfix();
    if (peek()?.t !== '^') return base;
    p++;
    const exp = unary(); // right to left: 2^3^2 = 2^9
    const v = Math.pow(base.v, exp.v);
    if (Number.isNaN(v)) throw new CalcError('No real answer (a negative number to a fractional power)');
    return { v, pct: false };
  }
  function postfix() {
    let x = primary();
    for (;;) {
      if (peek()?.t === '!') {
        p++;
        x = { v: factorial(x.v), pct: false };
      } else if (peek()?.t === '%') {
        p++;
        x = { v: x.v / 100, pct: true };
      } else return x;
    }
  }
  function primary() {
    const k = peek();
    if (!k) throw new CalcError('The expression ends too soon');
    if (k.t === 'num') {
      p++;
      return { v: k.v, pct: false };
    }
    if (k.t === 'ans') {
      p++;
      return { v: ans, pct: false };
    }
    if (k.t === '(') {
      p++;
      const v = expr();
      if (peek()) take(')'); // a missing ")" at the very end is fine, as on most calculators
      return { v: v.v, pct: false };
    }
    if (k.t === 'fn') {
      p++;
      // sin(30) or sin 30
      const arg = peek()?.t === '(' ? primary() : power();
      return { v: FUNCS[k.v](arg.v, deg), pct: false };
    }
    throw new CalcError(k.t === ')' ? 'A ")" has no matching "("' : `"${k.t}" is in the wrong place`);
  }

  const result = expr();
  if (p < toks.length) throw new CalcError(toks[p].t === ')' ? 'A ")" has no matching "("' : `"${toks[p].t}" is in the wrong place`);
  const v = tidy(result.v);
  if (!Number.isFinite(v)) throw new CalcError('The answer is too large');
  return v;
}

/** A result as people write it: up to 12 significant digits, E notation for very large or very small numbers. */
export function format(v) {
  if (Object.is(v, -0) || v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e15 || a < 1e-9) {
    const [m, e] = v.toExponential(10).split('e');
    return `${m.replace(/\.?0+$/, '')}E${e.replace('+', '')}`;
  }
  return String(Number(v.toPrecision(12)));
}
