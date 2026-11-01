import { $, api, esc, fmtBytes, jsonBody, onJobs, openTray, store, toast } from './core.js';
import { rememberPos } from './sos.js';
import { mountDirections } from './directions.js';

let cssLoaded = false;

export async function viewMaps(root) {
  root.innerHTML = `<h1>Maps</h1>
    <p class="lead">Street maps that work with no connection. Download a region once, then pan and zoom freely.</p>
    <div class="maps">
      <div class="mapwrap"><div id="map" role="region" aria-label="Map"></div><div class="mapmsg" id="mapmsg" hidden></div>
        <div class="mapsearch" id="mapsearch" hidden>
          <input id="placeq" type="search" autocomplete="off" aria-label="Search places" aria-controls="placeres" placeholder="Search places: cities, towns, neighbourhoods">
          <div class="placeres" id="placeres" role="listbox" hidden></div>
        </div>
        <button class="btn small locate" type="button" id="locate" hidden aria-pressed="false">Locate me</button>
        <button class="btn small share" type="button" id="share" hidden aria-pressed="false">Share with group</button>
        <div class="people" id="people" hidden></div>
        <div class="locmsg" id="locmsg" role="status" hidden></div></div>
      <aside class="side"><section class="dirs" id="dirs" hidden></section><div id="side"></div></aside></div>`;

  let data = { files: [], fonts: false };
  let current = store.get('outpost.map', '');
  let map = null;
  let mod = null;
  let toolsMissing = false;
  let marker = null;
  let results = [];
  let active = -1;
  let searchTimer = null;
  let searchSeq = 0;
  let watchId = null;
  let me = null;
  let firstFix = true;
  let lastPos = null;
  let sharing = false;
  let lastSent = 0;
  let others = new Map(); // name → marker
  let heartbeat = null;
  const dirs = mountDirections($('#dirs', root), {
    getMap: () => ({ map, mod }),
    getFile: () => current,
    getPos: () => lastPos,
    locate: () => {
      const can = window.isSecureContext && !!navigator.geolocation;
      if (!can || watchId == null) locate();
      return can;
    },
  });

  async function loadList() {
    data = await api('/maps');
    if (!data.files.some((f) => f.name === current)) current = data.files[0]?.name ?? '';
  }

  const fileInfo = () => data.files.find((f) => f.name === current);

  /** The search box reflects the current map's place index: ready, building, or missing. */
  function paintSearch() {
    const box = $('#mapsearch', root);
    const input = $('#placeq', root);
    const f = fileInfo();
    box.hidden = !f;
    if (!f) return;
    input.disabled = f.places === null;
    input.placeholder = f.indexing
      ? 'Preparing place search… (see Transfers)'
      : f.places === null
        ? 'Place search isn’t ready for this map'
        : 'Search places: cities, towns, neighbourhoods';
    $('#placeres', root).hidden = true;
    if (f.places === null && !f.indexing) {
      $('#placeres', root).hidden = false;
      $('#placeres', root).innerHTML = `<p class="muted">This map has no place index. <button class="btn small admin-only" type="button" id="buildidx">Build it</button></p>`;
    }
  }

  function paintResults(message) {
    const box = $('#placeres', root);
    box.hidden = false;
    if (message) {
      box.innerHTML = `<p class="muted">${message}</p>`;
      return;
    }
    box.innerHTML =
      results
        .map(
          (r, i) => `<button type="button" role="option" class="place ${i === active ? 'on' : ''}" aria-selected="${i === active}" data-i="${i}">
            <span>${r.en ? `${esc(r.en)} <span class="muted">· ${esc(r.name)}</span>` : esc(r.name)}</span><span class="muted">${esc(r.kind)}</span></button>`,
        )
        .join('') + '<p class="muted hint">Finds places (cities, towns, neighbourhoods), not street addresses.</p>';
  }

  async function runSearch(q) {
    const mine = ++searchSeq;
    if (!q.trim()) {
      $('#placeres', root).hidden = true;
      return;
    }
    try {
      const r = await api(`/maps/search?file=${encodeURIComponent(current)}&q=${encodeURIComponent(q)}`);
      if (mine !== searchSeq) return;
      results = r.results;
      active = results.length ? 0 : -1;
      results.length ? paintResults() : paintResults(`No places match “${esc(q)}”. This finds cities, towns and neighbourhoods on this map, not street addresses.`);
    } catch (e) {
      if (mine === searchSeq) paintResults(`<span class="error-text">${esc(e.message)}</span>`);
    }
  }

  function goTo(r) {
    if (!map || !mod) return;
    map.flyTo({ center: [r.lon, r.lat], zoom: r.zoom, essential: true });
    marker?.remove();
    marker = new mod.maplibregl.Marker({ color: '#c8743f' }).setLngLat([r.lon, r.lat]).addTo(map);
    $('#placeq', root).value = r.en || r.name;
    $('#placeres', root).hidden = true;
  }

  // Locate me: the device's own position (phone GPS works offline), shown as a dot with an accuracy circle.
  const locmsg = (html) => {
    const el = $('#locmsg', root);
    el.hidden = !html;
    el.innerHTML = html ? `${html} <button class="linkbtn" type="button" data-close>Close</button>` : '';
  };

  function accuracyRing(lon, lat, metres) {
    const pts = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * 2 * Math.PI;
      const dLat = (metres * Math.cos(a)) / 111_320;
      const dLon = (metres * Math.sin(a)) / (111_320 * Math.cos((lat * Math.PI) / 180));
      pts.push([lon + dLon, lat + dLat]);
    }
    return { type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] }, properties: {} };
  }

  function showMe(pos) {
    const { longitude: lon, latitude: lat, accuracy } = pos.coords;
    if (!me) {
      const dot = Object.assign(document.createElement('div'), { className: 'me-dot', title: 'You are here' });
      me = new mod.maplibregl.Marker({ element: dot }).setLngLat([lon, lat]).addTo(map);
    } else me.setLngLat([lon, lat]);
    const ring = accuracyRing(lon, lat, Math.max(accuracy, 5));
    if (map.getSource('me-acc')) map.getSource('me-acc').setData(ring);
    else if (map.isStyleLoaded()) {
      map.addSource('me-acc', { type: 'geojson', data: ring });
      map.addLayer({ id: 'me-acc', type: 'fill', source: 'me-acc', paint: { 'fill-color': '#2f7fd6', 'fill-opacity': 0.15 } });
    }
    if (firstFix) {
      firstFix = false;
      map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 15) });
    }
    locmsg(`You are here, give or take ${Math.round(accuracy)} m: <code>${lat.toFixed(5)}, ${lon.toFixed(5)}</code>`);
    lastPos = { lat, lon, accuracy };
    rememberPos(lastPos);
    if (sharing && Date.now() - lastSent > 10_000) sendPos();
  }

  // Group map: send my position while I share (at most every 10 s, and every minute when standing still).
  async function sendPos() {
    if (!sharing || !lastPos) return;
    lastSent = Date.now();
    try {
      await api('/positions/me', jsonBody(lastPos, 'PUT'));
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function setSharing(on) {
    const btn = $('#share', root);
    if (on && !confirm('Share your position with everyone signed in to this Outpost? It updates while Locate me is on, is kept in memory only, and disappears when you stop.')) return;
    sharing = on;
    if (btn) {
      btn.setAttribute('aria-pressed', String(on));
      btn.textContent = on ? 'Sharing with group' : 'Share with group';
    }
    clearInterval(heartbeat);
    heartbeat = null;
    if (on) {
      lastSent = 0;
      sendPos();
      heartbeat = setInterval(sendPos, 60_000);
    } else await api('/positions/me', { method: 'DELETE' }).catch(() => undefined);
    refreshPeople();
  }

  const ago = (ms) => {
    const m = Math.round((Date.now() - ms) / 60_000);
    return m < 1 ? 'just now' : `${m} min ago`;
  };
  const metres = (a, b) => {
    const rad = Math.PI / 180;
    const x = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lon - a.lon) * rad) / 2) ** 2;
    return 2 * 6_371_000 * Math.asin(Math.sqrt(x));
  };
  const far = (m) => (m < 1000 ? `${Math.round(m)} m away` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km away`);
  const hue = (name) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

  /** Shows everyone else who is sharing, as named dots, and lists them over the map. */
  async function refreshPeople() {
    if (!map) return;
    const res = await api('/positions').catch(() => null);
    if (!res) return;
    const list = res.positions.filter((p) => !p.me);
    for (const [name, m] of others) {
      if (!list.some((p) => p.name === name)) {
        m.remove();
        others.delete(name);
      }
    }
    for (const p of list) {
      let m = others.get(p.name);
      if (!m) {
        const el = document.createElement('div');
        el.className = 'person';
        el.style.setProperty('--h', hue(p.name));
        el.innerHTML = `<i></i><span>${esc(p.name)}</span>`;
        m = new mod.maplibregl.Marker({ element: el, anchor: 'left' }).setLngLat([p.lon, p.lat]).addTo(map);
        others.set(p.name, m);
      } else m.setLngLat([p.lon, p.lat]);
      m.getElement().title = `${p.name}, ${ago(p.at)}, give or take ${p.accuracy} m`;
    }
    const box = $('#people', root);
    if (!box) return;
    box.hidden = !list.length;
    box.innerHTML = list.length
      ? `<strong>On the group map</strong><ul>${list
          .map((p) => `<li><button class="linkbtn" type="button" data-person="${esc(p.name)}" data-lat="${p.lat}" data-lon="${p.lon}">${esc(p.name)}</button> <span class="muted">${ago(p.at)}${lastPos ? ` · ${far(metres(lastPos, p))}` : ''}</span> <button class="linkbtn" type="button" data-route-to="${esc(p.name)}" data-lat="${p.lat}" data-lon="${p.lon}">Directions</button></li>`)
          .join('')}</ul>`
      : '';
  }

  function stopLocate() {
    if (sharing) setSharing(false);
    lastPos = null;
    const sb = $('#share', root);
    if (sb) sb.hidden = true;
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    me?.remove();
    me = null;
    if (map?.getLayer('me-acc')) map.removeLayer('me-acc');
    if (map?.getSource('me-acc')) map.removeSource('me-acc');
    const btn = $('#locate', root);
    if (btn) {
      btn.setAttribute('aria-pressed', 'false');
      btn.textContent = 'Locate me';
    }
  }

  async function locate() {
    if (watchId != null) {
      stopLocate();
      locmsg('');
      return;
    }
    if (!window.isSecureContext || !navigator.geolocation) {
      // Browsers only share location with secure pages; point to Outpost's HTTPS address and the one-time setup.
      const st = await api('/status').catch(() => null);
      const port = st?.listen?.https?.port;
      locmsg(
        port
          ? `Your browser only shares your location over a secure connection. Open <a href="https://${esc(location.hostname)}:${port}/#maps">https://${esc(location.hostname)}:${port}</a>. First time on this device? <a href="/join">Set it up</a> (once per device).`
          : 'Your browser only shares your location over a secure connection, and HTTPS is off on this Outpost. It turns on when Outpost is shared on the network (see the <a href="#guide">Guide</a>).',
      );
      return;
    }
    firstFix = true;
    const btn = $('#locate', root);
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = 'Stop';
    $('#share', root).hidden = false;
    locmsg('Finding you… Outdoors with a view of the sky works best.');
    watchId = navigator.geolocation.watchPosition(showMe, (err) => {
      const why = {
        1: 'Location is blocked for this page. Allow it in the browser (on iPhone: Settings → Privacy &amp; Security → Location Services → Safari Websites).',
        2: "This device couldn't work out where it is. A Mac has no GPS and needs the internet for this; phones use GPS, which works best outdoors.",
        3: 'Still looking for a position. Outdoors with a view of the sky works best.',
      }[err.code] ?? esc(err.message);
      locmsg(why);
      if (err.code !== 3) stopLocate();
    }, { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 });
  }

  root.addEventListener('click', (e) => {
    if (e.target.id === 'locate') locate();
    if (e.target.id === 'share') setSharing(!sharing);
    const routeTo = e.target.closest('[data-route-to]');
    if (routeTo) dirs.goTo({ lat: Number(routeTo.dataset.lat), lon: Number(routeTo.dataset.lon), label: routeTo.dataset.routeTo });
    const who = e.target.closest('[data-person]');
    if (who && map) map.flyTo({ center: [Number(who.dataset.lon), Number(who.dataset.lat)], zoom: Math.max(map.getZoom(), 15) });
    if (e.target.closest('#locmsg [data-close]')) locmsg('');
  });

  /** Goes where another page asked (Emergency → Location, an SOS alert), with a pin and its label. */
  function goToTarget() {
    const raw = sessionStorage.getItem('outpost.flyTo');
    if (!raw || !map) return;
    sessionStorage.removeItem('outpost.flyTo');
    const t = JSON.parse(raw);
    map.jumpTo({ center: [t.lon, t.lat], zoom: Math.max(map.getZoom(), 13) });
    marker?.remove();
    marker = new mod.maplibregl.Marker({ color: '#c8743f' }).setLngLat([t.lon, t.lat]).addTo(map);
    if (t.label) marker.getElement().title = t.label;
  }

  async function showMap() {
    stopLocate();
    dirs.refresh();
    for (const m of others.values()) m.remove();
    others = new Map();
    marker = null;
    const msg = $('#mapmsg', root);
    if (map) {
      map.remove();
      map = null;
    }
    if (!current) {
      msg.hidden = false;
      msg.innerHTML = `<div class="empty" style="text-align:left"><h2>No maps yet</h2><p class="muted">Start with the world overview on the right. It is small, and lets you zoom to the area you want before downloading detailed street data.</p></div>`;
      return;
    }
    msg.hidden = true;
    try {
      if (!cssLoaded) {
        const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/vendor/map.css' });
        document.head.append(link);
        cssLoaded = true;
      }
      mod ??= await import('/vendor/map.js');
      map = mod.mountMap($('#map', root), `/api/maps/files/${encodeURIComponent(current)}`, { fonts: data.fonts, colours: store.get('outpost.mapColours', 'auto') });
      $('#locate', root).hidden = false;
      map.once('load', refreshPeople);
      map.once('load', () => {
        dirs.attach();
        const want = sessionStorage.getItem('outpost.directionsTo');
        if (want) {
          sessionStorage.removeItem('outpost.directionsTo');
          dirs.goTo(JSON.parse(want));
        }
      });
      paintSearch();
      // Remember where the map is, for Emergency → Location; and go where that page asked, if it did.
      map.on('moveend', () => {
        const c = map.getCenter();
        try {
          localStorage.setItem('outpost.mapCenter', JSON.stringify({ lat: c.lat, lon: c.lng }));
        } catch {
          /* private mode */
        }
      });
      if (sessionStorage.getItem('outpost.flyTo')) map.once('load', goToTarget);
    } catch (e) {
      msg.hidden = false;
      msg.innerHTML = `<div class="empty"><h2>The map viewer didn't load</h2><p class="muted">Run <code>npm run build:client</code> in the Outpost folder, then reload. (${esc(e.message)})</p></div>`;
    }
  }

  function paintSide() {
    const saved = store.get('outpost.extract', { source: '', maxzoom: '' });
    $('#side', root).innerHTML = `
      <section><h3>Your maps</h3>
        ${data.files.length ? `<select id="mapsel" aria-label="Map file">${data.files.map((f) => `<option value="${esc(f.name)}" ${f.name === current ? 'selected' : ''}>${esc(f.name)} (${fmtBytes(f.size)})</option>`).join('')}</select>
          <p style="margin-top:8px" class="admin-only"><button class="btn small danger" type="button" id="delmap">Remove this map</button></p>` : '<p class="muted">None yet.</p>'}
        ${data.files.length ? `<div class="field" style="margin-top:12px"><label for="mapcolours">Map colours</label><select id="mapcolours">${[['auto', 'Match Light/Dark'], ['light', 'Light'], ['dark', 'Dark'], ['white', 'White'], ['grayscale', 'Grayscale'], ['black', 'Black']].map(([v, t]) => `<option value="${v}" ${v === store.get('outpost.mapColours', 'auto') ? 'selected' : ''}>${t}</option>`).join('')}</select></div>` : ''}
        ${data.files.length && !data.fonts ? `<p class="muted" style="font-size:13px">Place names appear once map fonts are installed. See the README.</p>` : ''}
      </section>
      <section class="admin-only"><h3>Download a region</h3>
        ${toolsMissing ? `<p class="note-box">The map tool isn't installed. Run <code>brew install pmtiles</code> in Terminal, then restart Outpost.</p>` : ''}
        <form id="extract">
          <div class="field"><label for="preset">Start from</label><select id="preset"><option value="">My own area</option><option value="world">World overview (small)</option></select></div>
          <div class="field"><label for="source">Planet map link (.pmtiles)</label><input id="source" type="url" required placeholder="https://build.protomaps.com/YYYYMMDD.pmtiles" value="${esc(saved.source)}">
            <span class="muted" style="font-size:13px">Pick a recent build at <a href="https://maps.protomaps.com/builds" target="_blank" rel="noopener">maps.protomaps.com/builds</a>.</span></div>
          <div class="field"><label for="mname">Save as</label><input id="mname" required placeholder="my-region.pmtiles" pattern="[\\w][\\w.\\- ()]*\\.pmtiles"></div>
          <label>Area (degrees)</label>
          <div class="bbox"><input id="w" type="number" step="any" placeholder="West" aria-label="West" required><input id="s" type="number" step="any" placeholder="South" aria-label="South" required>
            <input id="e" type="number" step="any" placeholder="East" aria-label="East" required><input id="n" type="number" step="any" placeholder="North" aria-label="North" required></div>
          <p style="margin:8px 0 12px"><button class="btn small" type="button" id="useview" ${current ? '' : 'disabled'}>Use what the map shows now</button></p>
          <div class="field"><label for="maxzoom">Detail level (0 to 15)</label><input id="maxzoom" type="number" min="0" max="15" placeholder="Leave blank for full detail" value="${esc(saved.maxzoom)}">
            <span class="muted" style="font-size:13px">Lower is smaller. 5 gives a country overview; 15 shows every street and is large.</span></div>
          <button class="btn primary" type="submit" ${toolsMissing ? 'disabled' : ''}>Download region</button>
        </form></section>
      <section class="admin-only"><h3>Add a map file</h3><p class="muted" style="font-size:13px">Have a .pmtiles file already? Copy it in.</p>
        <input id="mapfile" type="file" accept=".pmtiles"><div id="mapup" class="bar" hidden style="margin-top:8px"><i style="width:0"></i></div></section>`;
  }

  const side = $('#side', root);
  side.addEventListener('change', async (e) => {
    if (e.target.id === 'mapsel') {
      current = e.target.value;
      store.set('outpost.map', current);
      showMap();
    }
    if (e.target.id === 'mapcolours') {
      store.set('outpost.mapColours', e.target.value);
      recolour();
    }
    if (e.target.id === 'preset') {
      const world = e.target.value === 'world';
      $('#w', root).value = world ? -180 : '';
      $('#s', root).value = world ? -85 : '';
      $('#e', root).value = world ? 180 : '';
      $('#n', root).value = world ? 85 : '';
      $('#maxzoom', root).value = world ? 5 : '';
      if (world && !$('#mname', root).value) $('#mname', root).value = 'world-overview.pmtiles';
    }
    if (e.target.id === 'mapfile' && e.target.files[0]) {
      const file = e.target.files[0];
      const bar = $('#mapup', root);
      bar.hidden = false;
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/maps/upload/${encodeURIComponent(file.name)}`);
      xhr.upload.onprogress = (ev) => ev.lengthComputable && (bar.firstElementChild.style.width = `${(ev.loaded / ev.total) * 100}%`);
      xhr.onload = async () => {
        if (xhr.status === 200) {
          toast(`${file.name} added`);
          current = file.name;
          await loadList();
          paintSide();
          showMap();
        } else toast(JSON.parse(xhr.responseText || '{}').error || 'Upload failed', 'error');
      };
      xhr.onerror = () => toast('Upload failed', 'error');
      xhr.send(file);
    }
  });
  side.addEventListener('click', async (e) => {
    if (e.target.id === 'useview') {
      if (!map || !mod) return toast('Open a map first', 'error');
      const [w, s, ea, n] = mod.boundsOf(map);
      $('#w', root).value = Math.max(-180, w);
      $('#s', root).value = Math.max(-90, s);
      $('#e', root).value = Math.min(180, ea);
      $('#n', root).value = Math.min(90, n);
    }
    if (e.target.id === 'delmap' && confirm(`Remove ${current} from this Mac?`)) {
      try {
        await api(`/maps/${encodeURIComponent(current)}`, { method: 'DELETE' });
        await loadList();
        paintSide();
        showMap();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });
  side.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id !== 'extract') return;
    const num = (id) => Number($(`#${id}`, root).value);
    const maxzoom = $('#maxzoom', root).value;
    const source = $('#source', root).value.trim();
    store.set('outpost.extract', { source, maxzoom });
    try {
      await api('/maps/extract', jsonBody({ source, name: $('#mname', root).value.trim(), bbox: [num('w'), num('s'), num('e'), num('n')], maxzoom: maxzoom === '' ? null : Number(maxzoom) }));
      toast('Download started. Follow it under Transfers.');
      openTray();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  try {
    const [, st] = await Promise.all([loadList(), api('/status')]);
    toolsMissing = !st.binaries.pmtiles;
  } catch (e) {
    toast(e.message, 'error');
  }
  const search = $('#mapsearch', root);
  search.addEventListener('input', (e) => {
    if (e.target.id !== 'placeq') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value), 180);
  });
  search.addEventListener('keydown', (e) => {
    if (e.target.id !== 'placeq') return;
    if (e.key === 'Escape') return void ($('#placeres', root).hidden = true);
    if (!results.length || $('#placeres', root).hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length;
      paintResults();
    }
    if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      goTo(results[active]);
    }
  });
  search.addEventListener('click', async (e) => {
    const opt = e.target.closest('[data-i]');
    if (opt) goTo(results[Number(opt.dataset.i)]);
    if (e.target.id === 'buildidx') {
      await api(`/maps/${encodeURIComponent(current)}/index`, { method: 'POST' }).catch((err) => toast(err.message, 'error'));
      await loadList();
      paintSearch();
      openTray();
    }
  });

  paintSide();
  await showMap();
  const off = onJobs(async (_j, finished) => {
    dirs.onJobs(finished);
    if (finished.some((j) => j.kind === 'place-index')) {
      await loadList();
      paintSearch();
    }
    if (finished.some((j) => j.kind === 'map-extract' && j.status === 'done')) {
      const hadNone = !current;
      await loadList();
      paintSide();
      if (hadNone) showMap();
    }
  });
  // Others on the group map, every 10 s while this page is open. Leaving the page stops my sharing.
  const peopleTimer = setInterval(refreshPeople, 10_000);
  const leave = () => {
    if (sharing) fetch('/api/positions/me', { method: 'DELETE', keepalive: true });
  };
  window.addEventListener('pagehide', leave);
  window.addEventListener('outpost:flyto', goToTarget);
  // "Directions" on an SOS alert while Maps is open.
  const directionsTo = () => {
    const want = sessionStorage.getItem('outpost.directionsTo');
    sessionStorage.removeItem('outpost.directionsTo');
    if (want && map) dirs.goTo(JSON.parse(want));
  };
  window.addEventListener('outpost:directions', directionsTo);
  // Light / Dark switched in the top bar: draw the map again in the matching colours.
  const recolour = async () => {
    const view = map && { center: map.getCenter(), zoom: map.getZoom() };
    await showMap();
    if (view && map) map.once('load', () => map.jumpTo(view));
  };
  window.addEventListener('outpost:theme', recolour);
  return () => {
    window.removeEventListener('outpost:flyto', goToTarget);
    window.removeEventListener('outpost:directions', directionsTo);
    window.removeEventListener('outpost:theme', recolour);
    off();
    clearInterval(peopleTimer);
    window.removeEventListener('pagehide', leave);
    stopLocate();
    map?.remove();
  };
}
