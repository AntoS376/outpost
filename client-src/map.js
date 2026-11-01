// Bundled by esbuild into public/vendor/map.js (+ map.css). Runs fully offline.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { PMTiles, Protocol } from 'pmtiles';
import { layers, namedFlavor } from '@protomaps/basemaps';

maplibregl.setWorkerUrl(new URL('./maplibre-gl-worker.mjs', import.meta.url).href);
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

/**
 * Mounts an offline map for one .pmtiles file.
 * options.fonts: true when glyph PBFs are installed (labels on); otherwise text layers are dropped.
 * options.colours: 'light' | 'dark' | 'white' | 'grayscale' | 'black'; anything else follows Light/Dark.
 */
export function mountMap(el, fileUrl, options = {}) {
  const chosen = document.documentElement.dataset.theme;
  const dark = chosen ? chosen === 'dark' : !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const fixed = ['light', 'dark', 'white', 'grayscale', 'black'].includes(options.colours);
  const flavor = namedFlavor(fixed ? options.colours : dark ? 'dark' : 'light');
  let styleLayers = layers('protomaps', flavor, { lang: options.lang || 'en' });
  if (options.fonts) {
    styleLayers = styleLayers.map((l) => {
      if (l.type === 'symbol' && l.layout && 'icon-image' in l.layout) {
        const layout = { ...l.layout };
        delete layout['icon-image'];
        return { ...l, layout };
      }
      return l;
    });
  } else {
    styleLayers = styleLayers.filter((l) => l.type !== 'symbol');
  }
  const absolute = new URL(fileUrl, window.location.href).href;
  const archive = new PMTiles(absolute);
  protocol.add(archive);
  const style = {
    version: 8,
    ...(options.fonts ? { glyphs: `${window.location.origin}/assets/fonts/{fontstack}/{range}.pbf` } : {}),
    sources: {
      protomaps: {
        type: 'vector',
        url: `pmtiles://${absolute}`,
        attribution: '© OpenStreetMap contributors · Protomaps',
      },
    },
    layers: styleLayers,
  };
  const map = new maplibregl.Map({ container: el, style, center: [0, 20], zoom: 1.5, attributionControl: { compact: true } });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  // Open on the area the file covers, not a fixed world view (a city extract is invisible at zoom 1).
  archive
    .getHeader()
    .then((h) => {
      if (h.minLon < h.maxLon && h.minLat < h.maxLat) {
        map.fitBounds([[h.minLon, h.minLat], [h.maxLon, h.maxLat]], { padding: 24, animate: false, maxZoom: h.maxZoom });
      }
    })
    .catch(() => undefined);
  return map;
}

export function boundsOf(map) {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => Math.round(n * 10000) / 10000);
}

export { maplibregl };
