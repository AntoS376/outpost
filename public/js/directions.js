import { $, api, esc, fmtBytes, jsonBody, openTray, toast } from './core.js';

/*
 * Directions on Outpost's own map (OSRM on the Mac, see src/services/routing.ts). Lives in a section of the Maps
 * side panel; maps.js hands it the map, the chosen map file and this device's position.
 */

const MODES = [
  ['car', 'Car'],
  ['foot', 'Walk'],
  ['bike', 'Bike'],
];
const BY = { car: 'by car', foot: 'on foot', bike: 'by bike' };

const fmtDistance = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 100_000 ? 1 : 0)} km`);
const fmtDuration = (s) => {
  const min = Math.max(1, Math.round(s / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
};
const label = (p) => p?.label || (p ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : '');

/**
 * opts: getMap() → { map, mod } or nulls; getFile() → the map file; getPos() → { lat, lon } or null;
 * locate() turns on Locate me (false when this connection can't share a position).
 */
export function mountDirections(host, opts) {
  let status = null;
  let from = null;
  let to = null;
  let mode = 'car';
  let route = null;
  let picking = null; // 'from' | 'to' while waiting for a tap on the map
  let markers = {};
  let seq = 0;
  let searchTimer = null;
  let found = { from: [], to: [] };

  async function refresh() {
    const file = opts.getFile();
    if (!file) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    try {
      status = await api(`/routing/${encodeURIComponent(file)}`);
    } catch (e) {
      host.innerHTML = `<h3>Directions</h3><p class="error-text">${esc(e.message)}</p>`;
      return;
    }
    paint();
  }

  function setupHtml() {
    const t = status.tools;
    if (status.building) {
      return `<p class="muted">Getting directions ready for this map. Follow it under <button class="linkbtn" type="button" data-d="tray">Transfers</button>.</p>`;
    }
    if (status.outdated) {
      return `<p class="muted">The directions engine was updated, so this map's directions need preparing again (no download needed).</p>
        <p class="admin-only"><button class="btn small" type="button" data-d="rebuild">Prepare again</button></p>`;
    }
    if (!t.osrm || !t.osmium) {
      return `<p class="muted">Directions aren't set up on this Outpost.</p>
        <p class="note-box admin-only">Directions need two free tools. In Terminal, run <code>brew install osrm-backend osmium-tool</code>, then reload this page.</p>`;
    }
    return `<p class="muted">Turn-by-turn directions by car, on foot or by bike, worked out on this Mac with no internet.</p>
      <p class="admin-only"><button class="btn small primary" type="button" data-d="setup">Add directions for this map</button></p>
      <p class="muted small member-only">An admin can add them for this map.</p>`;
  }

  function pointHtml(which, p) {
    return `<div class="dirpoint">
        <label for="dir-${which}">${which === 'from' ? 'From' : 'To'}</label>
        <input id="dir-${which}" type="search" autocomplete="off" placeholder="Search a place, or use the buttons" value="${esc(label(p))}" data-which="${which}">
        <div class="dirbtns"><button class="btn small" type="button" data-d="me" data-which="${which}">My location</button>
          <button class="btn small" type="button" data-d="pick" data-which="${which}" aria-pressed="${picking === which}">${picking === which ? 'Tap the map…' : 'Pick on map'}</button></div>
        <div class="placeres dirres" id="dir-${which}-res" role="listbox" hidden></div></div>`;
  }

  function resultHtml() {
    if (!route) return '';
    return `<div class="dirresult" aria-live="polite"><p class="dirsum"><b>${fmtDistance(route.distance)}</b> · about ${fmtDuration(route.duration)} ${BY[route.mode]}</p>
      <ol class="dirsteps">${route.steps
        .map((s, i) => `<li><button class="linkbtn" type="button" data-step="${i}">${esc(s.text)}</button>${s.distance ? ` <span class="muted">${fmtDistance(s.distance)}</span>` : ''}</li>`)
        .join('')}</ol>
      <p class="muted small">Times are estimates with no traffic. Check the way with your own eyes.</p></div>`;
  }

  function paint() {
    if (!status) return;
    const data = status.ready
      ? `<p class="muted small">Road data: OpenStreetMap via Geofabrik (${esc(status.regions.map((r) => r.name).join(', '))})${status.dataDate ? `, ${new Date(status.dataDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}` : ''}${status.size ? `, ${fmtBytes(status.size)}` : ''}.</p>
        <p class="admin-only dirman"><button class="btn small" type="button" data-d="setup">Update road data</button> <button class="btn small danger" type="button" data-d="remove">Remove directions</button></p>`
      : '';
    host.innerHTML = `<h3>Directions</h3>${
      status.ready
        ? `<form id="dirform">${pointHtml('from', from)}
            <p class="dirswap"><button class="linkbtn" type="button" data-d="swap">Swap ↑↓</button></p>
            ${pointHtml('to', to)}
            <div class="seg dirmodes" role="group" aria-label="Travel by">${MODES.map(([m, l]) => `<button type="button" data-mode="${m}" aria-pressed="${m === mode}">${l}</button>`).join('')}</div>
            <div class="row dirgo"><button class="btn primary" type="submit" ${from && to ? '' : 'disabled'}>Get directions</button>${from || to || route ? '<button class="btn" type="button" data-d="clear">Clear</button>' : ''}</div></form>
          ${resultHtml()}${data}`
        : setupHtml()
    }`;
  }

  /* ---------- on the map: start and end pins, and the route line ---------- */
  function drawPins() {
    const { map, mod } = opts.getMap();
    for (const k of ['from', 'to']) {
      markers[k]?.remove();
      markers[k] = null;
      const p = k === 'from' ? from : to;
      if (!p || !map) continue;
      const el = Object.assign(document.createElement('div'), { className: `dirpin ${k}`, title: `${k === 'from' ? 'From' : 'To'}: ${label(p)}` });
      el.textContent = k === 'from' ? 'A' : 'B';
      markers[k] = new mod.maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
    }
  }

  function drawRoute() {
    const { map } = opts.getMap();
    if (!map || !map.isStyleLoaded()) return;
    const data = route ? { type: 'Feature', geometry: route.geometry, properties: {} } : { type: 'FeatureCollection', features: [] };
    if (map.getSource('route')) map.getSource('route').setData(data);
    else {
      map.addSource('route', { type: 'geojson', data });
      map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 9, 'line-opacity': 0.9 } });
      map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1d6fd1', 'line-width': 5 } });
    }
  }

  function fit() {
    const { map, mod } = opts.getMap();
    if (!map || !route) return;
    const c = route.geometry.coordinates;
    const b = c.reduce((acc, p) => acc.extend(p), new mod.maplibregl.LngLatBounds(c[0], c[0]));
    map.fitBounds(b, { padding: 50, maxZoom: 16 });
  }

  async function go() {
    if (!from || !to) return;
    const mine = ++seq;
    const btn = $('#dirform [type=submit]', host);
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Working it out…';
    }
    try {
      const r = await api(`/routing/${encodeURIComponent(opts.getFile())}/route?mode=${mode}&from=${from.lon},${from.lat}&to=${to.lon},${to.lat}`);
      if (mine !== seq) return;
      route = r;
      paint();
      drawRoute();
      fit();
    } catch (e) {
      if (mine !== seq) return;
      route = null;
      paint();
      drawRoute();
      toast(e.message, 'error');
    }
  }

  function set(which, p) {
    if (which === 'from') from = p;
    else to = p;
    route = null;
    drawPins();
    drawRoute();
    paint();
    if (from && to) go();
  }

  /** My location: Locate me's latest fix, turning it on and waiting for one if needed. */
  async function useMine(which) {
    let p = opts.getPos();
    if (!p) {
      if (!opts.locate()) return toast('Your position needs the secure (https) address. See the note on the map.', 'error');
      toast('Finding where you are…');
      const end = Date.now() + 30_000;
      while (!(p = opts.getPos()) && Date.now() < end) await new Promise((r) => setTimeout(r, 500));
    }
    if (!p) return toast("Couldn't find your position. Use Pick on map instead.", 'error');
    set(which, { lat: p.lat, lon: p.lon, label: 'My location' });
  }

  function onMapClick(e) {
    if (!picking) return;
    const which = picking;
    picking = null;
    opts.getMap().map.getCanvas().style.cursor = '';
    set(which, { lat: Number(e.lngLat.lat.toFixed(6)), lon: Number(e.lngLat.lng.toFixed(6)), label: 'Point on the map' });
  }

  function startPick(which) {
    const { map } = opts.getMap();
    if (!map) return;
    picking = picking === which ? null : which;
    map.getCanvas().style.cursor = picking ? 'crosshair' : '';
    map.off('click', onMapClick);
    if (picking) map.on('click', onMapClick);
    paint();
  }

  async function search(which, q) {
    const box = $(`#dir-${which}-res`, host);
    if (!box) return;
    if (!q.trim()) return void (box.hidden = true);
    try {
      found[which] = (await api(`/maps/search?file=${encodeURIComponent(opts.getFile())}&q=${encodeURIComponent(q)}`)).results.slice(0, 6);
    } catch (e) {
      box.hidden = false;
      box.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
      return;
    }
    box.hidden = false;
    box.innerHTML = found[which].length
      ? found[which].map((r, i) => `<button type="button" role="option" class="place" data-pick="${which}" data-i="${i}"><span>${esc(r.en || r.name)}</span><span class="muted">${esc(r.kind)}</span></button>`).join('')
      : `<p class="muted">No places match. Try Pick on map.</p>`;
  }

  function setupDialog() {
    const file = opts.getFile();
    const dlg = document.createElement('dialog');
    dlg.className = 'cmd-dialog';
    dlg.innerHTML = `<form method="dialog"><h2>Add directions for ${esc(file)}</h2>
      <p>Outpost downloads OpenStreetMap's road data for this map's area from Geofabrik, then prepares directions for driving, walking and cycling on this Mac. After that, no internet is needed.</p>
      <div id="dregions"><p class="muted">Looking up which regions cover this map…</p></div>
      <p class="muted small">Road data © OpenStreetMap contributors (ODbL). The downloads are cut to this map’s area and then deleted. Preparing takes a few minutes for a small country.</p>
      <div class="row"><button class="btn" value="no">Cancel</button><button class="btn primary" value="yes" id="dgo" disabled>Download and prepare</button></div></form>`;
    document.body.append(dlg);
    let regions = [];
    const total = () => {
      const picked = regions.filter((r) => $(`#dr-${r.id}`, dlg)?.checked);
      $('#dgo', dlg).disabled = !picked.length;
      const known = picked.every((r) => r.size);
      $('#dtotal', dlg).textContent = picked.length ? `${known ? '' : 'at least '}${fmtBytes(picked.reduce((a, r) => a + (r.size || 0), 0))} to download` : 'Choose at least one region';
    };
    api(`/routing/${encodeURIComponent(file)}/regions`)
      .then((res) => {
        regions = res.regions;
        $('#dregions', dlg).innerHTML = regions.length
          ? `<fieldset class="dregions"><legend>Regions to download (ticked: what covers this map best)</legend>${regions
              .map((r) => `<label class="check"><input type="checkbox" id="dr-${esc(r.id)}" ${r.suggested ? 'checked' : ''}><span>${esc(r.name)} <span class="muted">· covers ${r.cover}% of this map${r.size ? ` · ${fmtBytes(r.size)}` : ''}</span></span></label>`)
              .join('')}</fieldset><p><b id="dtotal"></b></p>`
          : '<p class="error-text">Geofabrik has no region covering this map.</p>';
        if (regions.length) total();
      })
      .catch((e) => ($('#dregions', dlg).innerHTML = `<p class="error-text">${esc(e.message)}</p>`));
    dlg.addEventListener('change', total);
    dlg.addEventListener('close', async () => {
      const ids = regions.filter((r) => $(`#dr-${r.id}`, dlg)?.checked).map((r) => r.id);
      const yes = dlg.returnValue === 'yes';
      dlg.remove();
      if (!yes || !ids.length) return;
      try {
        await api(`/routing/${encodeURIComponent(file)}`, jsonBody({ regions: ids }));
        toast('Getting directions ready. Follow it under Transfers.');
        openTray();
      } catch (e) {
        toast(e.message, 'error');
      }
      refresh();
    });
    dlg.showModal();
  }

  host.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const d = t.dataset.d;
    if (t.dataset.mode) {
      mode = t.dataset.mode;
      route = null;
      paint();
      drawRoute();
      if (from && to) go();
    }
    if (t.dataset.pick) {
      const r = found[t.dataset.pick][Number(t.dataset.i)];
      if (r) set(t.dataset.pick, { lat: r.lat, lon: r.lon, label: r.en || r.name });
    }
    if (t.dataset.step != null && route) {
      const s = route.steps[Number(t.dataset.step)];
      opts.getMap().map?.flyTo({ center: [s.lon, s.lat], zoom: Math.max(opts.getMap().map.getZoom(), 16) });
    }
    if (d === 'me') useMine(t.dataset.which);
    if (d === 'pick') startPick(t.dataset.which);
    if (d === 'swap') {
      [from, to] = [to, from];
      set('from', from);
    }
    if (d === 'clear') {
      from = to = route = null;
      drawPins();
      drawRoute();
      paint();
    }
    if (d === 'tray') openTray();
    if (d === 'setup') setupDialog();
    try {
      if (d === 'rebuild') {
        await api(`/routing/${encodeURIComponent(opts.getFile())}`, jsonBody({}));
        toast('Preparing directions again. Follow it under Transfers.');
        refresh();
      }
      if (d === 'remove' && confirm('Remove the directions for this map? You can add them again later (it downloads the road data again).')) {
        await api(`/routing/${encodeURIComponent(opts.getFile())}`, { method: 'DELETE' });
        from = to = route = null;
        drawPins();
        drawRoute();
        refresh();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  host.addEventListener('input', (e) => {
    const which = e.target.dataset.which;
    if (!which || e.target.tagName !== 'INPUT') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => search(which, e.target.value), 200);
  });
  host.addEventListener('submit', (e) => {
    e.preventDefault();
    go();
  });

  return {
    refresh,
    /** After the map was (re)drawn: put the pins and route back. */
    attach() {
      picking = null;
      drawPins();
      drawRoute();
    },
    /** Directions to a point from elsewhere (an SOS, someone on the group map), starting from my location. */
    async goTo(p) {
      if (!status) await refresh();
      if (!status?.ready) return toast("Directions aren't set up for this map yet.", 'error');
      to = p;
      drawPins();
      paint();
      if (!from) await useMine('from');
      else go();
      host.scrollIntoView({ block: 'nearest' });
    },
    /** Jobs finished: a map may have become ready. */
    onJobs(finished) {
      if (finished.some((j) => j.kind === 'routing')) refresh();
    },
  };
}
