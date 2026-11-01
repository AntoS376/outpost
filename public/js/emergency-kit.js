import { $, api, esc, jsonBody, toast } from './core.js';

/** Kit lists based on Ready.gov (FEMA) "Build a Kit" and car safety guidance, which are public domain. */
const KITS = {
  gobag: {
    title: 'Go-bag (grab and leave)',
    items: [
      ['water', 'Water: about 3.8 litres (1 gallon) per person per day, for several days'],
      ['food', 'Food: several days of food that keeps without a fridge'],
      ['radio', 'Battery-powered or hand-crank radio'],
      ['flashlight', 'Flashlight'],
      ['firstaid', 'First aid kit'],
      ['batteries', 'Extra batteries'],
      ['whistle', 'Whistle to signal for help'],
      ['mask', 'Dust masks'],
      ['sheeting', 'Plastic sheeting and duct tape, to shelter in place'],
      ['sanitation', 'Moist towelettes, rubbish bags and plastic ties'],
      ['tools', 'Wrench or pliers to turn off utilities'],
      ['opener', 'Manual can opener'],
      ['maps', 'Local paper maps'],
      ['phone', 'Phone with charger and a backup battery'],
      ['meds', 'Prescription medicines'],
      ['glasses', 'Glasses and contact lens solution'],
      ['cash', 'Cash'],
      ['documents', 'Copies of ID, insurance and bank records in a waterproof bag'],
      ['blanket', 'Warm blanket or sleeping bag for each person'],
      ['clothes', 'A change of clothes and sturdy shoes'],
      ['matches', 'Matches in a waterproof container'],
      ['hygiene', 'Personal hygiene items'],
      ['paper', 'Paper and pencil'],
      ['extras', 'Baby, elderly or pet supplies, if needed'],
    ],
  },
  home: {
    title: 'At home (stay put)',
    items: [
      ['water2w', 'Water for two weeks for everyone in the home'],
      ['food2w', 'Food for two weeks that keeps without a fridge'],
      ['extinguisher', 'Fire extinguisher'],
      ['smoke', 'Working smoke alarms, tested every month'],
      ['shutoff', 'Know how and where to turn off gas, water and electricity'],
      ['lights', 'Flashlights where everyone can find them in the dark'],
      ['meds2', 'An extra supply of prescription medicines'],
      ['plan', 'A household plan: where to meet and who to call (see My card)'],
    ],
  },
  car: {
    title: 'In the car',
    items: [
      ['cables', 'Jumper cables'],
      ['triangle', 'Flares or a reflective warning triangle'],
      ['charger', 'Phone charger for the car'],
      ['carblanket', 'Blankets'],
      ['carmap', 'Paper map'],
      ['carwater', 'Water and snacks'],
      ['carfirstaid', 'First aid kit and flashlight'],
      ['scraper', 'Ice scraper, and sand or cat litter for grip, in winter'],
      ['fuel', 'Keep the tank at least half full'],
    ],
  },
};
const BLOOD = ['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown'];

async function load() {
  return api('/emergency');
}
async function save(data) {
  return api('/emergency', jsonBody(data, 'PUT'));
}

/** "My card": details for whoever finds you or helps you, kept privately and printable. */
export async function cardView(body) {
  let data = await load();
  const c = data.card;
  const contacts = [...c.contacts, ...Array(Math.max(0, 3 - c.contacts.length)).fill({ name: '', relation: '', phone: '' })];
  const points = [c.meetingPoints[0] ?? '', c.meetingPoints[1] ?? ''];
  const field = (id, label, value, attrs = '') => `<div class="field"><label for="${id}">${label}</label><input id="${id}" value="${esc(value)}" ${attrs}></div>`;
  const area = (id, label, value, max) => `<div class="field"><label for="${id}">${label}</label><textarea id="${id}" rows="2" maxlength="${max}">${esc(value)}</textarea></div>`;

  function preview() {
    const v = (id) => $(`#${id}`, body).value.trim();
    const rows = [...body.querySelectorAll('.contact')].map((r) => [...r.querySelectorAll('input')].map((i) => i.value.trim())).filter((r) => r.some(Boolean));
    const line = (label, value) => (value ? `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>` : '');
    $('#ecard', body).innerHTML = `<h3>Emergency information</h3>
      <dl>${line('Name', v('ename'))}${line('Born', v('eborn'))}${line('Blood type', $('#eblood', body).value)}${line('Allergies', v('eallergies'))}${line('Conditions', v('econditions'))}${line('Medicines', v('emeds'))}</dl>
      ${rows.length ? `<h4>Call</h4><ul>${rows.map(([n, rel, ph]) => `<li><strong>${esc(n)}</strong>${rel ? ` (${esc(rel)})` : ''} ${esc(ph)}</li>`).join('')}</ul>` : ''}
      ${v('emeet1') || v('emeet2') ? `<h4>Meet at</h4><ol>${[v('emeet1'), v('emeet2')].filter(Boolean).map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
      ${v('enotes') ? `<p>${esc(v('enotes'))}</p>` : ''}`;
  }

  body.innerHTML = `<div class="cardgrid">
    <form id="cardform" class="noprint">
      <p class="muted" style="font-size:13px">Only you can see this card. It is stored on this Mac in a file only your Mac account can read. Print it for your wallet, bag or fridge.</p>
      ${field('ename', 'Full name', c.name, 'maxlength="80" autocomplete="name"')}
      <div class="row">${field('eborn', 'Date of birth', c.born, 'maxlength="40" placeholder="e.g. 1985-03-14"')}
        <div class="field"><label for="eblood">Blood type</label><select id="eblood">${BLOOD.map((b) => `<option ${b === c.bloodType ? 'selected' : ''} value="${b}">${b || 'Not set'}</option>`).join('')}</select></div></div>
      ${area('eallergies', 'Allergies', c.allergies, 500)}${area('econditions', 'Medical conditions', c.conditions, 500)}${area('emeds', 'Medicines and doses', c.medications, 800)}
      <h3 style="margin-top:6px">Who to call</h3>
      ${contacts.map((x, i) => `<div class="row contact"><input aria-label="Contact ${i + 1} name" placeholder="Name" maxlength="80" value="${esc(x.name)}"><input aria-label="Contact ${i + 1} relation" placeholder="Relation" maxlength="40" value="${esc(x.relation)}"><input aria-label="Contact ${i + 1} phone" placeholder="Phone" maxlength="40" inputmode="tel" value="${esc(x.phone)}"></div>`).join('')}
      <h3 style="margin-top:12px">Where to meet</h3>
      ${field('emeet1', 'Near home', points[0], 'maxlength="200" placeholder="e.g. the church steps on Main Street"')}
      ${field('emeet2', 'Away from the neighbourhood', points[1], 'maxlength="200" placeholder="e.g. Aunt Rita’s house in Jounieh"')}
      ${area('enotes', 'Anything else', c.notes, 1000)}
      <p class="row"><button class="btn primary" type="submit">Save</button><button class="btn" type="button" id="printcard">Print card</button></p>
    </form>
    <div class="ecard" id="ecard" aria-live="polite"></div></div>`;
  preview();

  body.addEventListener('input', preview);
  body.addEventListener('change', preview);
  body.addEventListener('click', (e) => e.target.id === 'printcard' && window.print());
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (id) => $(`#${id}`, body).value;
    try {
      data = await save({
        card: {
          name: v('ename'), born: v('eborn'), bloodType: v('eblood'), allergies: v('eallergies'), conditions: v('econditions'), medications: v('emeds'),
          contacts: [...body.querySelectorAll('.contact')].map((r) => {
            const [name, relation, phone] = [...r.querySelectorAll('input')].map((i) => i.value);
            return { name, relation, phone };
          }).filter((x) => x.name || x.phone),
          meetingPoints: [v('emeet1'), v('emeet2')].filter((x) => x.trim()),
          notes: v('enotes'),
        },
        kits: data.kits,
      });
      toast('Card saved');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/** Kits: checklists with your own additions, and a water and food calculator. */
export async function kitsView(body) {
  let data = await load();
  const saveKits = async () => {
    try {
      data = await save({ card: data.card, kits: data.kits });
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  function render() {
    const lists = Object.entries(KITS).map(([id, kit]) => {
      const checked = new Set(data.kits.checked[id] ?? []);
      const extra = data.kits.extra[id] ?? [];
      const all = [...kit.items, ...extra.map((t, i) => [`x${i}`, t, true])];
      const done = all.filter(([k]) => checked.has(k)).length;
      return `<section class="block kit"><div class="kithead"><h2>${kit.title}</h2><span class="muted">${done} of ${all.length} ready</span></div>
        <div class="bar noprint"><i style="width:${(done / all.length) * 100}%"></i></div>
        <ul class="checks">${all.map(([k, label, mine]) => `<li><label class="check"><input type="checkbox" data-list="${id}" data-item="${k}" ${checked.has(k) ? 'checked' : ''}><span>${esc(label)}</span></label>${mine ? `<button class="btn small noprint" type="button" data-rmx="${id}:${k.slice(1)}" aria-label="Remove ${esc(label)}">Remove</button>` : ''}</li>`).join('')}</ul>
        <form class="row noprint addx" data-list="${id}"><div class="grow"><input placeholder="Add your own item" maxlength="120" aria-label="Add an item to ${kit.title}"></div><button class="btn small" type="submit">Add</button></form></section>`;
    });
    body.innerHTML = `<p class="muted" style="max-width:70ch">Based on <a href="https://www.ready.gov/kit" target="_blank" rel="noopener">Ready.gov</a> (FEMA) kit lists. Tick what you have; your ticks and own items are saved for you only.</p>
      <section class="block calc"><h2>How much water and food?</h2>
        <div class="row"><div><label for="people">People</label><input id="people" type="number" min="1" max="50" value="${Number(sessionStorage.getItem('em.people')) || 2}"></div>
          <div><label for="days">Days</label><select id="days"><option value="3">3 days (go-bag)</option><option value="14">14 days (at home)</option><option value="7">7 days</option></select></div></div>
        <p class="calcout" id="calcout"></p>
        <p class="muted" style="font-size:13px">Water: at least 3.8 litres (1 gallon) per person per day, for drinking and hygiene. Store more in hot weather, and for anyone pregnant, nursing or ill. Food: about 2,000 calories per adult per day is a rough guide; children need less and hard physical work needs more. Store water for pets too.</p></section>
      ${lists.join('')}`;
    const days = body.querySelector('#days');
    days.value = sessionStorage.getItem('em.days') || '3';
    calc();
  }

  function calc() {
    const people = Math.min(50, Math.max(1, Number($('#people', body).value) || 1));
    const days = Number($('#days', body).value);
    sessionStorage.setItem('em.people', String(people));
    sessionStorage.setItem('em.days', String(days));
    const litres = people * days * 3.8;
    $('#calcout', body).innerHTML = `<strong>${Math.ceil(litres)} litres</strong> of water (${people * days} US gallons) and <strong>${people * days * 3} meals</strong>, roughly ${(people * days * 2000).toLocaleString()} calories, for ${people} ${people === 1 ? 'person' : 'people'} over ${days} days.`;
  }

  body.addEventListener('input', (e) => ['people'].includes(e.target.id) && calc());
  body.addEventListener('change', async (e) => {
    if (e.target.id === 'days') return calc();
    const { list, item } = e.target.dataset;
    if (!list) return;
    const set = new Set(data.kits.checked[list] ?? []);
    e.target.checked ? set.add(item) : set.delete(item);
    data.kits.checked[list] = [...set];
    await saveKits();
    render();
  });
  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    const list = e.target.dataset.list;
    const value = e.target.querySelector('input').value.trim();
    if (!list || !value) return;
    data.kits.extra[list] = [...(data.kits.extra[list] ?? []), value];
    await saveKits();
    render();
  });
  body.addEventListener('click', async (e) => {
    const rm = e.target.dataset?.rmx;
    if (!rm) return;
    const [list, idx] = rm.split(':');
    const extra = [...(data.kits.extra[list] ?? [])];
    extra.splice(Number(idx), 1);
    // Ticks on own items are by position, so re-number what follows the removed one.
    const checked = (data.kits.checked[list] ?? []).filter((k) => k !== `x${idx}`).map((k) => (k.startsWith('x') && Number(k.slice(1)) > Number(idx) ? `x${Number(k.slice(1)) - 1}` : k));
    data.kits.extra[list] = extra;
    data.kits.checked[list] = checked;
    await saveKits();
    render();
  });
  render();
}
