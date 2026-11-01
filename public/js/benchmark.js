import { $, api, esc, fmtBytes, fmtDate, getJobs, jsonBody, onJobs, toast } from './core.js';

const speed = (mbps) => (mbps >= 1000 ? `${(mbps / 1000).toFixed(1)} GB/s` : `${Math.round(mbps)} MB/s`);
const CATS = [
  ['cpu', 'Processor'],
  ['disk', 'Disk'],
  ['memory', 'Memory'],
  ['ai', 'AI'],
];

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Draws a result as a 1200×630 PNG card in the browser. No network, no libraries. */
function drawCard(r) {
  const W = 1200;
  const H = 630;
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = c.getContext('2d');
  const font = (w, px) => `${w} ${px}px ui-rounded, "SF Pro Rounded", system-ui, -apple-system, sans-serif`;
  g.fillStyle = '#2c3118';
  g.fillRect(0, 0, W, H);
  // Contour lines, as in the app's sidebar.
  g.strokeStyle = 'rgba(242, 236, 220, 0.06)';
  g.lineWidth = 2;
  for (let i = 0; i < 9; i++) {
    g.beginPath();
    for (let x = 0; x <= W; x += 20) g.lineTo(x, 70 + i * 70 + Math.sin(x / 140 + i) * 26);
    g.stroke();
  }
  g.fillStyle = '#e3a072';
  g.fillRect(64, 64, 8, 54);
  g.fillStyle = '#f2ecdc';
  g.font = font(700, 30);
  g.fillText('Outpost Benchmark', 92, 92);
  g.fillStyle = '#cbc5a7';
  g.font = font(500, 22);
  g.fillText(r.quick ? `${day(r.at)} · quick run` : day(r.at), 92, 120);

  g.fillStyle = '#e3a072';
  g.font = font(800, 168);
  g.fillText(String(r.score), 60, 330);
  const tag = r.tag ?? { name: '', hardware: '' };
  g.fillStyle = '#f2ecdc';
  g.font = font(700, 36);
  g.fillText(tag.name || 'This Mac', 64, 400, 560);
  g.fillStyle = '#cbc5a7';
  g.font = font(500, 26);
  g.fillText(tag.hardware || r.hardware.cpu, 64, 440, 560);

  const cats = [['Processor', r.categories.cpu], ['Disk', r.categories.disk], ['Memory', r.categories.memory], ['AI', r.categories.ai]];
  cats.forEach(([label, v], i) => {
    const y = 210 + i * 66;
    g.fillStyle = '#f2ecdc';
    g.font = font(600, 26);
    g.fillText(label, 680, y);
    g.textAlign = 'right';
    g.fillText(v == null ? '–' : String(v), 1136, y);
    g.textAlign = 'left';
    g.fillStyle = '#454c2b';
    g.fillRect(680, y + 14, 456, 10);
    g.fillStyle = '#a9d47a';
    g.fillRect(680, y + 14, v == null ? 0 : Math.min(456, (v / 3000) * 456), 10);
  });
  g.fillStyle = '#cbc5a7';
  g.font = font(500, 22);
  const ai = r.ai ? `${r.ai.model}: ${r.ai.tokensPerSec} tokens/s` : 'AI not measured';
  g.fillText(`${ai} · ${r.hardware.os}`, 64, 560, 1072);
  g.fillText('Measured on this Mac with Outpost. 1000 = the reference figures.', 64, 592, 1072);
  return c;
}

function savePng(r) {
  drawCard(r).toBlob((blob) => {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `outpost-benchmark-${day(r.at)}-${r.score}.png` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
}

/** Local benchmark: runs as a job, shows the score, the figures behind it, and past runs. */
export async function viewBenchmark(root) {
  root.innerHTML = `<h1>Benchmark</h1>
    <p class="lead">How fast this Mac does the kinds of work Outpost does: hashing and compression, disk, memory and AI. It usually takes under a minute (longer with a large AI model), and the results stay on this Mac.</p>
    <div id="bench-body"><p class="muted">Loading…</p></div>`;
  const body = $('#bench-body', root);
  let data;
  let models = [];
  let tag = { name: '', hardware: '', detected: '' };

  async function load() {
    [data, models, tag] = await Promise.all([
      api('/benchmark'),
      api('/ai/models').then((m) => m.models.filter((x) => !x.embedding).map((x) => x.name), () => []),
      api('/benchmark/tag'),
    ]);
  }

  function resultView(r) {
    const m = r.metrics;
    const rows = [
      ['SHA-256 hashing, one core', speed(m.hashMBps)],
      ['Compression (zlib), one core', speed(m.compressMBps)],
      [`SHA-256 hashing, all ${r.cores} cores`, speed(m.multiHashMBps)],
      ['Memory copy', speed(m.memoryMBps)],
      ['Disk write', speed(m.diskWriteMBps)],
      [`Disk read${m.diskUncached ? '' : ' (may include memory cache)'}`, speed(m.diskReadMBps)],
      ...(r.ai ? [[`AI: ${esc(r.ai.model)}`, `${r.ai.tokensPerSec} tokens/s, first word after ${(r.ai.firstTokenMs / 1000).toFixed(1)} s`]] : []),
    ];
    return `<div class="score"><span class="big">${r.score}</span><span class="muted">${r.quick ? 'quick run · ' : ''}${fmtDate(r.at)}</span></div>
      ${r.tag ? `<p style="margin:-6px 0 14px">${r.tag.name ? `by <strong>${esc(r.tag.name)}</strong> · ` : ''}${esc(r.tag.hardware)}</p>` : ''}
      <ul class="catbars">${CATS.map(([k, label]) => {
        const v = r.categories[k];
        return `<li><span>${label}</span><span class="bar" title="${v ?? 'not measured'}"><i style="width:${v ? Math.min(100, v / 30) : 0}%"></i></span><strong>${v ?? '–'}</strong></li>`;
      }).join('')}</ul>
      <ul class="rows bench">${rows.map(([k, v]) => `<li><span class="grow">${k}</span><span>${v}</span></li>`).join('')}</ul>
      ${r.notes.length ? `<p class="note-box">${r.notes.map(esc).join('<br>')}</p>` : ''}
      <p class="row" style="margin-top:14px"><a class="btn" href="/api/benchmark/${encodeURIComponent(r.id)}/export.json" download>Export JSON</a>
        <button class="btn" type="button" data-png="${esc(r.id)}">Save image</button></p>`;
  }

  function render() {
    const h = data.hardware;
    const latest = data.history[0];
    const job = getJobs().find((j) => j.kind === 'benchmark' && j.status === 'running');
    body.innerHTML = `
      <section class="block" style="border-top:0;padding-top:0"><h2>This Mac</h2>
        <p>${esc(h.cpu)}${h.perfCores ? ` (${h.perfCores} performance + ${h.effCores} efficiency cores)` : `, ${h.cores} cores`} · ${fmtBytes(h.memoryBytes)} memory · ${esc(h.os)}${h.model ? ` · <span class="muted">${esc(h.model)}</span>` : ''}</p>
        <div class="row admin-only" style="margin-top:12px">
          ${models.length ? `<div><label for="bmodel">AI model to time</label><select id="bmodel">${models.map((m) => `<option>${esc(m)}</option>`).join('')}</select></div>` : '<p class="muted">No chat model, so the AI part will be skipped.</p>'}
          <button class="btn primary" type="button" id="run" ${job ? 'disabled' : ''}>${job ? 'Running…' : 'Run benchmark'}</button></div>
        ${job ? `<div style="margin-top:12px"><div class="bar"><i style="width:${job.total ? (job.received / job.total) * 100 : 5}%"></i></div><p class="muted">${esc(job.message)}</p></div>` : ''}
      </section>
      <section class="block admin-only"><h2>Builder Tag</h2>
        <p class="muted" style="max-width:70ch">A name and hardware label saved with each result and shown on exported cards. It stays on this Mac; nothing is uploaded.</p>
        <form id="tag" class="row"><div><label for="tname">Display name</label><input id="tname" maxlength="40" value="${esc(tag.name)}" placeholder="Optional"></div>
          <div class="grow"><label for="thw">Hardware label</label><input id="thw" maxlength="60" value="${esc(tag.hardware)}" placeholder="${esc(tag.detected)}"></div>
          <button class="btn" type="submit">Save</button></form></section>
      ${latest ? `<section class="block"><h2>Latest result</h2>${resultView(latest)}</section>` : ''}
      <section class="block"><h2>How the score works</h2>
        <p class="muted" style="max-width:70ch">Each figure is compared with a fixed reference (round numbers, not any particular Mac): matching it scores 1000 and twice as fast scores 2000. The four category scores are combined with a geometric mean, so no single part dominates. Disk figures are measured on the drive that holds your Outpost data, with the memory cache bypassed. AI speed depends on the model you pick.</p></section>
      ${data.history.length > 1 ? `<section class="block"><h2>Earlier runs</h2><ul class="rows">${data.history
        .slice(1)
        .map((r) => `<li><div class="grow"><strong>${r.score}</strong><span>${fmtDate(r.at)}${r.quick ? ' · quick' : ''}${r.ai ? ` · ${esc(r.ai.model)}` : ' · no AI'}${r.tag?.name ? ` · ${esc(r.tag.name)}` : ''}</span></div>
          <a class="btn small" href="/api/benchmark/${encodeURIComponent(r.id)}/export.json" download>JSON</a><button class="btn small" type="button" data-png="${esc(r.id)}">Image</button><button class="btn small danger admin-only" type="button" data-del="${esc(r.id)}">Remove</button></li>`)
        .join('')}</ul></section>` : ''}`;
  }

  body.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (e.target.id !== 'tag') return;
    try {
      tag = await api('/benchmark/tag', jsonBody({ name: $('#tname', body).value, hardware: $('#thw', body).value }, 'PUT'));
      toast('Builder Tag saved. New results will carry it.');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  body.addEventListener('click', async (e) => {
    const png = e.target.closest('[data-png]');
    if (png) savePng(data.history.find((r) => r.id === png.dataset.png));
    if (e.target.id === 'run') {
      e.target.disabled = true;
      try {
        await api('/benchmark/start', jsonBody({ model: $('#bmodel', body)?.value }));
      } catch (err) {
        toast(err.message, 'error');
      }
      setTimeout(render, 300);
    }
    const del = e.target.closest('[data-del]');
    if (del && confirm('Remove this result?')) {
      await api(`/benchmark/${encodeURIComponent(del.dataset.del)}`, { method: 'DELETE' }).catch((err) => toast(err.message, 'error'));
      await load();
      render();
    }
  });

  try {
    await load();
  } catch (e) {
    body.innerHTML = `<p class="error-text">${esc(e.message)}</p>`;
    return;
  }
  render();
  const off = onJobs(async (_jobs, finished) => {
    if (finished.some((j) => j.kind === 'benchmark')) await load();
    render();
  });
  return off;
}
