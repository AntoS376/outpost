import { api, store } from './core.js';

/**
 * An offline map for the Radio page's Planes and APRS views: the map chosen on Maps (or the first one), in the
 * colours chosen there. Resolves to { map, mod }, or null after showing `note` when there is no map yet.
 */
export async function mountRadioMap(el, note) {
  const data = await api('/maps').catch(() => ({ files: [], fonts: false }));
  const file = data.files.find((f) => f.name === store.get('outpost.map', ''))?.name ?? data.files[0]?.name;
  if (!file) {
    note.hidden = false;
    note.innerHTML = 'Add a map on the <a href="#maps">Maps</a> page to see them on it. The list works without one.';
    return null;
  }
  if (!document.querySelector('link[href="/vendor/map.css"]')) document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/vendor/map.css' }));
  const mod = await import('/vendor/map.js');
  return { mod, map: mod.mountMap(el, `/api/maps/files/${encodeURIComponent(file)}`, { fonts: data.fonts, colours: store.get('outpost.mapColours', 'auto') }) };
}
