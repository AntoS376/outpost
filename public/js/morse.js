// International Morse code (ITU-R M.1677-1) and its timing. Pure functions, shared by the page and the tests.

export const CODE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--',
  N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-', '&': '.-...',
  ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', '"': '.-..-.', '@': '.--.-.',
};
const BACK = Object.fromEntries(Object.entries(CODE).map(([k, v]) => [v, k]));
/** SOS is sent as one run (...---...), not as three letters. */
export const SOS = '...---...';

/** Text to Morse: letters separated by spaces, words by " / ". Characters with no Morse equivalent are dropped. */
export function encode(text) {
  return String(text)
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/\s+/)
    .map((word) => [...word].map((c) => CODE[c]).filter(Boolean).join(' '))
    .filter(Boolean)
    .join(' / ');
}

/** Morse to text. Accepts . and - (also • · and _ –), letters split by spaces, words by "/" or 3+ spaces. Unknown groups become "?". */
export function decode(morse) {
  return String(morse)
    .replace(/[•·]/g, '.')
    .replace(/[_–—−]/g, '-')
    .trim()
    .split(/\s*\/\s*|\s{3,}/)
    .map((word) => word.split(/\s+/).filter(Boolean).map((g) => (g === SOS ? 'SOS' : BACK[g] ?? '?')).join(''))
    .filter(Boolean)
    .join(' ');
}

/** Length of one unit (a dot) in ms at a speed in words per minute, using the standard word "PARIS". */
export const unitMs = (wpm) => 1200 / wpm;

/**
 * The on/off pattern for a Morse string, in units: dot 1, dash 3, gap inside a letter 1, between letters 3,
 * between words 7. Returns [[on, units], …].
 */
export function timeline(morse) {
  const out = [];
  const gap = (n) => {
    if (out.length && !out[out.length - 1][0]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], n);
    else if (out.length) out.push([false, n]);
  };
  for (const word of morse.trim().split(/\s*\/\s*/)) {
    if (!word) continue;
    gap(7);
    for (const letter of word.split(/\s+/)) {
      gap(3);
      [...letter].forEach((sym, i) => {
        if (i) gap(1);
        out.push([true, sym === '-' ? 3 : 1]);
      });
    }
  }
  return out;
}

/** NATO / ICAO spelling alphabet, with ICAO's spoken digits. */
export const NATO = {
  A: 'Alfa', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel', I: 'India', J: 'Juliett', K: 'Kilo',
  L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango', U: 'Uniform',
  V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee', Z: 'Zulu',
  0: 'Zero', 1: 'One', 2: 'Two', 3: 'Tree', 4: 'Fower', 5: 'Fife', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Niner',
};

/** "Ab 1" → "Alfa Bravo / One". Other characters are passed through as they are. */
export function spell(text) {
  return String(text)
    .toUpperCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => [...w].map((c) => NATO[c] ?? c).join(' '))
    .join(' / ');
}
