import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error plain browser module without types
import { decode, encode, spell, timeline, unitMs, CODE, SOS } from '../public/js/morse.js';

describe('Morse code', () => {
  it('encodes text the international way', () => {
    assert.equal(encode('SOS'), '... --- ...');
    assert.equal(encode('Help me'), '.... . .-.. .--. / -- .');
    assert.equal(encode('Café 42!'), '-.-. .- ..-. . / ....- ..--- -.-.--', 'accents dropped, digits and punctuation kept');
    assert.equal(encode('a # b'), '.- / -...', 'characters without Morse are skipped');
    assert.equal(Object.keys(CODE).length, 52, '26 letters, 10 digits, 16 punctuation marks');
  });

  it('decodes dots and dashes, including the single SOS run and look-alike symbols', () => {
    assert.equal(decode('.... . .-.. .--. / -- .'), 'HELP ME');
    assert.equal(decode(SOS), 'SOS');
    assert.equal(decode('•••   ———   •••'), 'S O S', 'three spaces split words');
    assert.equal(decode('... ---- ...'), 'S?S', 'unknown groups show as ?');
    assert.equal(decode(encode('The quick brown fox 1234567890')), 'THE QUICK BROWN FOX 1234567890');
  });

  it('uses standard timing: dot 1, dash 3, gaps 1 / 3 / 7 units, PARIS is 50 units', () => {
    assert.deepEqual(timeline('.-'), [[true, 1], [false, 1], [true, 3]]);
    assert.deepEqual(timeline('. / .'), [[true, 1], [false, 7], [true, 1]]);
    assert.deepEqual(timeline('. .'), [[true, 1], [false, 3], [true, 1]]);
    // PARIS plus the gap before the next word is the 50-unit standard word.
    const units = timeline(encode('PARIS')).reduce((n: number, [, u]: [boolean, number]) => n + u, 0) + 7;
    assert.equal(units, 50);
    assert.equal(unitMs(20), 60);
  });

  it('spells with the NATO alphabet and ICAO digits', () => {
    assert.equal(spell('Beirut 9'), 'Bravo Echo India Romeo Uniform Tango / Niner');
    assert.equal(spell('x-1'), 'X-ray - One');
  });
});

describe('first-aid cards', () => {
  it('every card names a government source and has steps in plain words', async () => {
    // @ts-expect-error plain browser module without types
    const { CARDS, CHECKED } = await import('../public/js/firstaid.js').catch(() => ({ CARDS: null, CHECKED: null }));
    assert.ok(Array.isArray(CARDS) && CARDS.length >= 5, 'cards load');
    assert.match(CHECKED, /^\d{4}-\d{2}-\d{2}$/);
    for (const c of CARDS) {
      assert.match(c.source[1], /^https:\/\/([a-z0-9-]+\.)*(cdc|seattle)\.gov\//, `${c.id} cites a .gov page`);
      assert.ok(c.steps.length >= 3 && c.steps.every((s: string) => s.length > 10 && s.length < 220), `${c.id} steps`);
      assert.ok(c.when && c.title && c.search, c.id);
    }
    const cpr = CARDS.find((c: any) => c.id === 'cpr');
    assert.ok(cpr.steps.some((s: string) => /100 to 120/.test(s) && /5 cm \(2 inches\)/.test(s)), 'CPR rate and depth as the source gives them');
  });
});
