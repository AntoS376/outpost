import { api, esc, fmtBytes } from './core.js';

/*
 * The live GPU gauge on the Assistant page: how busy the GPU is, the memory it uses, which model is loaded and how
 * much of it runs on the GPU, and the last minute as a line. Reads /api/ai/gpu once a second while visible.
 */

const HISTORY = 60;

export function mountGpuGauge(host) {
  const history = [];
  let timer = null;
  let stopped = false;

  function modelLine(loaded) {
    if (loaded === null) return '';
    if (!loaded.length) return '<p class="muted small">No model in memory. One loads when you ask something.</p>';
    return loaded
      .map((m) => {
        const share = m.size ? Math.round((m.onGpu / m.size) * 100) : 0;
        const where = share >= 99 ? 'all on the GPU' : share <= 0 ? 'on the processor only (slower)' : `${share}% on the GPU, the rest on the processor`;
        return `<p class="small"><b>${esc(m.name)}</b> in memory: ${fmtBytes(m.size)}, ${where}</p>`;
      })
      .join('');
  }

  function line() {
    if (history.length < 2) return '';
    const pts = history.map((v, i) => `${((i + HISTORY - history.length) / (HISTORY - 1)) * 200},${40 - (v / 100) * 38}`);
    return `<svg class="gpuhist" viewBox="0 0 200 42" preserveAspectRatio="none" aria-hidden="true">
      <polygon points="${pts[0].split(',')[0]},41 ${pts.join(' ')} 200,41" class="area"/><polyline points="${pts.join(' ')}"/></svg>`;
  }

  function paint(data) {
    const g = data.gpu;
    if (!g.available) {
      host.innerHTML = `<h3>GPU</h3><p class="muted small">This Mac doesn't report GPU use, so there is no live gauge.</p>${modelLine(data.loaded)}`;
      return;
    }
    const busy = g.busy ?? 0;
    history.push(busy);
    if (history.length > HISTORY) history.shift();
    host.innerHTML = `<div class="gputop"><h3>GPU</h3><span class="muted small">${esc(g.chip ?? '')}${g.cores ? ` · ${g.cores} cores` : ''}</span></div>
      <div class="gpumain">
        <svg class="gpudial" viewBox="0 0 120 68" role="meter" aria-label="GPU use" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${busy}" aria-valuetext="${busy}% busy">
          <path d="M10 60 A50 50 0 0 1 110 60" pathLength="100" class="track"/>
          <path d="M10 60 A50 50 0 0 1 110 60" pathLength="100" class="value" stroke-dasharray="${busy} 100"/>
          <text x="60" y="56" text-anchor="middle">${busy}%</text></svg>
        <div class="small"><p>Busy now, counting every app (not only the AI)</p>${g.memoryUsed != null ? `<p class="muted">GPU memory <b>${fmtBytes(g.memoryUsed)}</b> of the Mac's ${fmtBytes(g.memoryTotal)}</p>` : ''}</div>
      </div>
      ${line()}${history.length >= 2 ? '<p class="muted small gpucap">The last minute</p>' : ''}
      ${modelLine(data.loaded)}`;
  }

  async function tick() {
    if (stopped) return;
    if (document.visibilityState === 'visible') {
      try {
        paint(await api('/ai/gpu'));
      } catch {
        /* Outpost restarting: try again next second */
      }
    }
    if (!stopped) timer = setTimeout(tick, 1000);
  }

  host.innerHTML = '<h3>GPU</h3><p class="muted small">Reading…</p>';
  tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
