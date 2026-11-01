/*
 * Units for the converter. Each unit is its size in the category's base unit (the SI unit where there is one),
 * using exact definitions (international inch, pound and gallon; NIST SP 811). Temperature and fuel economy aren't
 * simple multiples, so their units carry to/from functions instead.
 */

const u = (id, name, factor) => ({ id, name, factor });
const f = (id, name, toBase, fromBase) => ({ id, name, toBase, fromBase });

export const CATEGORIES = [
  {
    id: 'length', name: 'Length', units: [
      u('mm', 'millimetres', 1e-3), u('cm', 'centimetres', 1e-2), u('m', 'metres', 1), u('km', 'kilometres', 1e3),
      u('in', 'inches', 0.0254), u('ft', 'feet', 0.3048), u('yd', 'yards', 0.9144), u('mi', 'miles', 1609.344), u('nmi', 'nautical miles', 1852),
    ],
  },
  {
    id: 'area', name: 'Area', units: [
      u('cm2', 'square centimetres', 1e-4), u('m2', 'square metres', 1), u('dunam', 'dunams', 1000), u('ha', 'hectares', 1e4), u('km2', 'square kilometres', 1e6),
      u('in2', 'square inches', 0.00064516), u('ft2', 'square feet', 0.09290304), u('yd2', 'square yards', 0.83612736), u('acre', 'acres', 4046.8564224), u('mi2', 'square miles', 2589988.110336),
    ],
  },
  {
    id: 'volume', name: 'Volume', units: [
      u('ml', 'millilitres', 1e-6), u('l', 'litres', 1e-3), u('m3', 'cubic metres', 1),
      u('tsp', 'teaspoons (US)', 4.92892159375e-6), u('tbsp', 'tablespoons (US)', 1.478676478125e-5), u('floz', 'fluid ounces (US)', 2.95735295625e-5),
      u('cup', 'cups (US)', 2.365882365e-4), u('pt', 'pints (US)', 4.73176473e-4), u('qt', 'quarts (US)', 9.46352946e-4),
      u('gal', 'gallons (US)', 3.785411784e-3), u('galuk', 'gallons (UK)', 4.54609e-3), u('ft3', 'cubic feet', 0.028316846592),
    ],
  },
  {
    id: 'mass', name: 'Weight', units: [
      u('mg', 'milligrams', 1e-6), u('g', 'grams', 1e-3), u('kg', 'kilograms', 1), u('t', 'tonnes', 1000),
      u('oz', 'ounces', 0.028349523125), u('lb', 'pounds', 0.45359237), u('st', 'stone', 6.35029318), u('ton', 'short tons (US)', 907.18474), u('lton', 'long tons (UK)', 1016.0469088),
    ],
  },
  {
    id: 'temperature', name: 'Temperature', units: [
      f('c', 'degrees Celsius', (v) => v + 273.15, (k) => k - 273.15),
      f('f', 'degrees Fahrenheit', (v) => ((v - 32) * 5) / 9 + 273.15, (k) => ((k - 273.15) * 9) / 5 + 32),
      f('k', 'kelvin', (v) => v, (k) => k),
    ],
  },
  {
    id: 'speed', name: 'Speed', units: [
      u('ms', 'metres per second', 1), u('kmh', 'kilometres per hour', 1 / 3.6), u('mph', 'miles per hour', 0.44704), u('kn', 'knots', 1852 / 3600), u('fts', 'feet per second', 0.3048),
    ],
  },
  {
    id: 'time', name: 'Time', units: [
      u('ms', 'milliseconds', 1e-3), u('s', 'seconds', 1), u('min', 'minutes', 60), u('h', 'hours', 3600), u('d', 'days', 86400), u('wk', 'weeks', 604800), u('yr', 'years (365.25 days)', 31557600),
    ],
  },
  {
    id: 'pressure', name: 'Pressure', units: [
      u('pa', 'pascals', 1), u('kpa', 'kilopascals', 1e3), u('bar', 'bar', 1e5), u('atm', 'atmospheres', 101325), u('psi', 'pounds per square inch', 6894.757293168361),
      u('mmhg', 'millimetres of mercury', 133.322387415), u('inhg', 'inches of mercury', 3386.388640341),
    ],
  },
  {
    id: 'energy', name: 'Energy', units: [
      u('j', 'joules', 1), u('kj', 'kilojoules', 1e3), u('cal', 'calories', 4.184), u('kcal', 'kilocalories (food Calories)', 4184), u('wh', 'watt-hours', 3600), u('kwh', 'kilowatt-hours', 3.6e6), u('btu', 'BTU', 1055.05585262),
    ],
  },
  {
    id: 'power', name: 'Power', units: [
      u('w', 'watts', 1), u('kw', 'kilowatts', 1e3), u('hp', 'horsepower', 745.69987158227), u('ps', 'metric horsepower', 735.49875), u('btuh', 'BTU per hour', 1055.05585262 / 3600),
    ],
  },
  {
    id: 'data', name: 'Data', units: [
      u('bit', 'bits', 1 / 8), u('b', 'bytes', 1), u('kb', 'kilobytes (1000)', 1e3), u('mb', 'megabytes', 1e6), u('gb', 'gigabytes', 1e9), u('tb', 'terabytes', 1e12),
      u('kib', 'kibibytes (1024)', 1024), u('mib', 'mebibytes', 1024 ** 2), u('gib', 'gibibytes', 1024 ** 3), u('tib', 'tebibytes', 1024 ** 4),
    ],
  },
  {
    id: 'angle', name: 'Angle', units: [
      u('deg', 'degrees', Math.PI / 180), u('rad', 'radians', 1), u('grad', 'gradians', Math.PI / 200), u('turn', 'turns', 2 * Math.PI),
    ],
  },
  {
    // Base: kilometres per litre. Litres per 100 km runs the other way (more is worse).
    id: 'fuel', name: 'Fuel economy', units: [
      f('l100', 'litres per 100 km', (v) => 100 / v, (k) => 100 / k),
      u('kml', 'kilometres per litre', 1),
      u('mpg', 'miles per gallon (US)', 1.609344 / 3.785411784),
      u('mpguk', 'miles per gallon (UK)', 1.609344 / 4.54609),
    ],
  },
];

const find = (cat, id) => {
  const c = CATEGORIES.find((x) => x.id === cat);
  const unit = c?.units.find((x) => x.id === id);
  if (!unit) throw new Error(`Unknown unit ${cat}/${id}`);
  return unit;
};

/** value in one unit → the same amount in another unit of the same category. */
export function convert(cat, fromId, toId, value) {
  const from = find(cat, fromId);
  const to = find(cat, toId);
  const base = from.toBase ? from.toBase(value) : value * from.factor;
  return to.fromBase ? to.fromBase(base) : base / to.factor;
}

/** Up to 10 significant digits, grouped for reading; E notation when huge or tiny. */
export function formatAmount(v) {
  if (!Number.isFinite(v)) return '–';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 1e15 || a < 1e-7) {
    const [m, e] = v.toExponential(8).split('e');
    return `${m.replace(/\.?0+$/, '')}E${e.replace('+', '')}`;
  }
  return Number(v.toPrecision(10)).toLocaleString('en-US', { maximumFractionDigits: 10 });
}
