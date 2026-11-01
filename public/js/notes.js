import { $, api, esc, fmtDate, jsonBody, toast } from './core.js';
import { md } from './md.js';

export async function viewNotes(root) {
  root.innerHTML = `<h1>Notes</h1>
    <p class="lead">Plans and checklists, saved as plain Markdown files on this Mac.</p>
    <div class="notes"><div class="notes-list"><div class="row" style="flex-wrap:nowrap"><input id="filter" type="search" placeholder="Filter notes" aria-label="Filter notes"><button class="btn primary" id="new" type="button">New</button></div><ul id="list"></ul></div>
    <div class="editor" id="editor"></div></div>`;

  let notes = [];
  let activeId = null;
  let mode = 'write';
  let saveTimer = null;
  let dirty = false;
  const listEl = $('#list', root);
  const editor = $('#editor', root);

  const paintList = () => {
    const q = $('#filter', root).value.trim().toLowerCase();
    const shown = notes.filter((n) => !q || n.title.toLowerCase().includes(q));
    listEl.innerHTML = shown.length
      ? shown.map((n) => `<li><button type="button" data-id="${n.id}" ${n.id === activeId ? 'aria-current="true"' : ''}>${esc(n.title)}<small>${fmtDate(n.updated)}</small></button></li>`).join('')
      : `<li class="muted" style="padding:10px">${notes.length ? 'No matches.' : 'No notes yet.'}</li>`;
  };
  async function refresh() {
    notes = (await api('/notes')).notes;
    paintList();
  }

  const setState = (html) => {
    const el = $('#state', root);
    if (el) el.innerHTML = html;
  };

  async function save() {
    if (!activeId || !dirty) return;
    const content = $('#text', root)?.value;
    if (content == null) return;
    dirty = false;
    setState('Saving…');
    try {
      await api(`/notes/${activeId}`, jsonBody({ content }, 'PUT'));
      setState('Saved');
      await refresh();
    } catch (e) {
      dirty = true;
      setState(`<span class="error-text">${esc(e.message)}</span>`);
    }
  }

  async function open(id) {
    await save();
    activeId = id;
    paintList();
    let note;
    try {
      note = await api(`/notes/${id}`);
    } catch (e) {
      return toast(e.message, 'error');
    }
    mode = 'write';
    editor.innerHTML = `<div class="editor-bar"><div class="seg" role="tablist"><a href="#notes" data-mode="write" aria-current="page">Write</a><a href="#notes" data-mode="preview">Preview</a></div>
      <div class="row"><span class="muted" id="state" aria-live="polite">Saved</span><button class="btn small danger" id="del" type="button">Delete</button></div></div>
      <textarea id="text" aria-label="Note text" spellcheck="true"></textarea><div class="preview" id="preview" hidden></div>`;
    $('#text', root).value = note.content;
    $('#text', root).focus();
  }

  editor.addEventListener('input', (e) => {
    if (e.target.id !== 'text') return;
    dirty = true;
    setState('Editing…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 700);
  });
  editor.addEventListener('click', async (e) => {
    const tab = e.target.closest('[data-mode]');
    if (tab) {
      e.preventDefault();
      mode = tab.dataset.mode;
      editor.querySelectorAll('[data-mode]').forEach((a) => (mode === a.dataset.mode ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
      $('#text', root).hidden = mode === 'preview';
      $('#preview', root).hidden = mode !== 'preview';
      if (mode === 'preview') $('#preview', root).innerHTML = md($('#text', root).value);
    }
    if (e.target.id === 'del' && confirm('Delete this note? This can’t be undone.')) {
      try {
        await api(`/notes/${activeId}`, { method: 'DELETE' });
        activeId = null;
        dirty = false;
        editor.innerHTML = '';
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });
  listEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b) open(b.dataset.id);
  });
  $('#filter', root).addEventListener('input', paintList);
  $('#new', root).addEventListener('click', async () => {
    const title = prompt('Name the note');
    if (title === null) return;
    try {
      const n = await api('/notes', jsonBody({ title }));
      await refresh();
      open(n.id);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  try {
    await refresh();
    if (notes[0]) open(notes[0].id);
    else editor.innerHTML = `<div class="empty"><h2>Write the first note</h2><p class="muted">Water plans, contact lists, route notes. Notes are saved as you type.</p></div>`;
  } catch (e) {
    toast(e.message, 'error');
  }
  const onLeave = () => {
    if (dirty) save();
  };
  window.addEventListener('beforeunload', onLeave);
  return async () => {
    clearTimeout(saveTimer);
    window.removeEventListener('beforeunload', onLeave);
    await save();
  };
}
