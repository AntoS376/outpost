import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain browser modules, no type declarations
import { evaluate, format, tokenize } from '../public/js/calc-engine.js';
// @ts-expect-error plain browser modules, no type declarations
import { CATEGORIES, convert, formatAmount } from '../public/js/units.js';

const calc = (s: string, o = {}) => format(evaluate(s, o));

describe('calculator', () => {
  it('follows the usual order of operations', () => {
    assert.equal(calc('2+3×4'), '14');
    assert.equal(calc('(2+3)×4'), '20');
    assert.equal(calc('2*3-4/2'), '4', 'the keyboard’s * / - work too');
    assert.equal(calc('2^3^2'), '512', 'powers go right to left');
    assert.equal(calc('-2^2'), '-4');
    assert.equal(calc('(−2)^2'), '4');
    assert.equal(calc('3²'), '9');
    assert.equal(calc('10÷4'), '2.5');
  });

  it('hides floating-point noise and writes big and tiny numbers in E notation', () => {
    assert.equal(calc('0.1+0.2'), '0.3');
    assert.equal(calc('1/3'), '0.333333333333');
    assert.equal(calc('2^60'), '1.1529215046E18');
    assert.equal(calc('1E-12×3'), '3E-12');
    assert.equal(calc('1E3+1'), '1001');
  });

  it('treats percent like a pocket calculator', () => {
    assert.equal(calc('50+10%'), '55');
    assert.equal(calc('50−10%'), '45');
    assert.equal(calc('200×10%'), '20');
    assert.equal(calc('10%'), '0.1');
  });

  it('does scientific functions in degrees or radians', () => {
    assert.equal(calc('sin(30)'), '0.5');
    assert.equal(calc('cos(90)'), '0');
    assert.equal(calc('tan(45)'), '1');
    assert.equal(calc('sin⁻¹(1)'), '90');
    assert.equal(calc('sin(π/2)', { deg: false }), '1');
    assert.equal(calc('cos(π)', { deg: false }), '-1');
    assert.equal(calc('ln(e)'), '1');
    assert.equal(calc('log(1000)'), '3');
    assert.equal(calc('√16+∛27'), '7');
    assert.equal(calc('5!'), '120');
    assert.equal(calc('2^(−1)'), '0.5');
    assert.equal(calc('10^(2)'), '100');
  });

  it('understands shortcuts people type', () => {
    assert.equal(calc('2π'), calc('2×π'));
    assert.equal(calc('3(4+1)'), '15');
    assert.equal(calc('2sin30'), '1');
    assert.equal(calc('2×(3+4'), '14', 'a missing ")" at the end is fine');
    assert.equal(calc('Ans×2', { ans: 21 }), '42');
  });

  it('explains what went wrong in plain words', () => {
    const fails = (s: string, re: RegExp) => assert.throws(() => evaluate(s), re, s);
    fails('1÷0', /divide by zero/);
    fails('tan(90)', /no value/);
    fails('asin(2)', /from −1 to 1/);
    fails('ln(0)', /above 0/);
    fails('sqrt(-4)', /negative/);
    fails('(-8)^(1/3)', /No real answer/);
    fails('2.5!', /whole number/);
    fails('171!', /too large/);
    fails('1+2)', /no matching/);
    fails('foo(2)', /Unknown name/);
    fails('2+', /ends too soon/);
    fails('', /Nothing/);
    fails('3$', /Can't read/);
  });

  it('never runs code: only numbers, known names and symbols get through', () => {
    assert.throws(() => tokenize('alert(1)'), /Unknown name/);
    for (const s of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.throws(() => tokenize(s), /Unknown name|Can't read/, s);
    assert.throws(() => tokenize('1;2'), /Can't read/);
  });
});

describe('unit converter', () => {
  const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-9 + 1e-12, `${what}: ${a} ≠ ${b}`);

  it('uses exact definitions', () => {
    near(convert('length', 'mi', 'km', 1), 1.609344, 'mile');
    near(convert('length', 'in', 'cm', 1), 2.54, 'inch');
    near(convert('mass', 'lb', 'kg', 1), 0.45359237, 'pound');
    near(convert('volume', 'gal', 'l', 1), 3.785411784, 'US gallon');
    near(convert('area', 'dunam', 'm2', 2.5), 2500, 'dunam');
    near(convert('area', 'acre', 'm2', 1), 4046.8564224, 'acre');
    near(convert('speed', 'kn', 'kmh', 1), 1.852, 'knot');
    near(convert('pressure', 'atm', 'kpa', 1), 101.325, 'atmosphere');
    near(convert('energy', 'kwh', 'kcal', 1), 860.4206500956, 'kWh');
    near(convert('data', 'gib', 'gb', 1), 1.073741824, 'GiB');
    near(convert('angle', 'turn', 'deg', 1), 360, 'turn');
  });

  it('handles temperature and fuel economy, which aren’t simple multiples', () => {
    near(convert('temperature', 'c', 'f', 100), 212, 'boiling');
    near(convert('temperature', 'f', 'c', -40), -40, '−40');
    near(convert('temperature', 'c', 'k', 0), 273.15, 'freezing');
    near(convert('fuel', 'l100', 'mpg', 8), 29.40182292, 'L/100 km to mpg');
    near(convert('fuel', 'mpg', 'l100', convert('fuel', 'l100', 'mpg', 6.5)), 6.5, 'there and back');
  });

  it('goes there and back in every category without drift', () => {
    for (const c of CATEGORIES) {
      for (const a of c.units) for (const b of c.units) near(convert(c.id, b.id, a.id, convert(c.id, a.id, b.id, 7.25)), 7.25, `${c.id} ${a.id}↔${b.id}`);
    }
  });

  it('writes amounts for reading', () => {
    assert.equal(formatAmount(2500), '2,500');
    assert.equal(formatAmount(6.2137119223733), '6.213711922');
    assert.equal(formatAmount(0), '0');
    assert.equal(formatAmount(1.5e20), '1.5E20');
    assert.equal(formatAmount(Infinity), '–');
  });
});
