import { $, api, esc, fmtDate, jsonBody, toast } from './core.js';

/** Your account, and (for admins) everyone's. */
export async function viewAccount(root) {
  root.innerHTML = `<h1>Accounts</h1><p class="lead">Who can use this Outpost, and what they can change.</p><div id="acct"><p class="muted">Loading…</p></div>`;
  const box = $('#acct', root);
  let me;
  let all = null;

  async function load() {
    me = await api('/auth/me');
    all = me.user?.role === 'admin' ? await api('/users').catch(() => null) : null;
  }

  function addForm(first) {
    return `<form id="add" class="row" style="margin-top:12px">
      <div><label for="uname">Name</label><input id="uname" required maxlength="32" autocapitalize="none" spellcheck="false" placeholder="e.g. sam"></div>
      <div><label for="upass">Password</label><input id="upass" type="password" required minlength="8" autocomplete="new-password" placeholder="8 characters or more"></div>
      ${first ? '' : `<div><label for="urole">Role</label><select id="urole"><option value="member">Member</option><option value="admin">Admin</option></select></div>`}
      <button class="btn primary" type="submit">${first ? 'Create admin account' : 'Add'}</button></form>`;
  }

  function render() {
    const roles = `<ul class="tips"><li><b>Admins</b> manage books, maps, AI models, documents, Education and accounts.</li>
      <li><b>Members</b> read the library and maps, chat with the assistant, and keep their own notes and saved conversations. Nobody sees anyone else's notes or chats.</li></ul>`;
    if (me.mode === 'open') {
      box.innerHTML = `<section class="block" style="border-top:0;padding-top:0"><h2>Sign-in is off</h2>
        <p style="max-width:70ch">There is no password or account yet, so anyone who can open Outpost is an admin. That's fine while Outpost only listens on this Mac. Create the first account to turn sign-in on: it is an admin, and your notes and saved conversations move to it.</p>
        ${addForm(true)}</section><section class="block"><h2>Roles</h2>${roles}</section>`;
      return;
    }
    const u = me.user;
    box.innerHTML = `<section class="block" style="border-top:0;padding-top:0"><h2>You</h2>
        <p>Signed in as <strong>${esc(u.name)}</strong> (${u.role}). <button class="btn small" type="button" id="logout">Sign out</button></p>
        ${all && all.envAdmin === u.name ? `<p class="muted">You signed in with the admin password from <code>~/.config/outpost/env</code>; change it there.</p>` : `<form id="pw" class="row" style="margin-top:10px">
          <div><label for="cur">Current password</label><input id="cur" type="password" required autocomplete="current-password"></div>
          <div><label for="new">New password</label><input id="new" type="password" required minlength="8" autocomplete="new-password"></div>
          <button class="btn" type="submit">Change password</button></form>`}</section>
      ${all ? `<section class="block"><h2>Everyone</h2>
        ${all.envAdmin ? `<p class="muted" style="font-size:13px">Also: <strong>${esc(all.envAdmin)}</strong>, the admin from the settings file. It can always sign in.</p>` : ''}
        <ul class="rows">${all.users.map((x) => `<li><div class="grow"><strong>${esc(x.name)}</strong><span>added ${fmtDate(x.created)}</span></div>
          <select data-role="${esc(x.name)}" aria-label="Role for ${esc(x.name)}"><option value="member" ${x.role === 'member' ? 'selected' : ''}>Member</option><option value="admin" ${x.role === 'admin' ? 'selected' : ''}>Admin</option></select>
          <button class="btn small" type="button" data-reset="${esc(x.name)}">Reset password</button>
          <button class="btn small danger" type="button" data-remove="${esc(x.name)}">Remove</button></li>`).join('')}</ul>
        <h3 style="margin-top:18px">Add someone</h3>${addForm(false)}
        <p class="muted" style="font-size:13px;margin-top:10px">Removing an account keeps its notes and conversations on disk. Learners in Education have their own Kolibri accounts: add them in Kolibri under Facility → Users.</p></section>` : ''}
      <section class="block"><h2>Roles</h2>${roles}</section>`;
  }

  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (e.target.id === 'add') {
        const first = me.mode === 'open';
        await api('/users', jsonBody({ name: $('#uname', box).value, password: $('#upass', box).value, role: first ? 'admin' : $('#urole', box).value }));
        if (first) {
          toast('Account created. Sign in with it.');
          location.href = '/login.html?next=%2F%23account';
          return;
        }
        toast('Account added');
      }
      if (e.target.id === 'pw') {
        await api('/auth/password', jsonBody({ current: $('#cur', box).value, password: $('#new', box).value }, 'PUT'));
        toast('Password changed. Other devices were signed out.');
      }
      await load();
      render();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  box.addEventListener('change', async (e) => {
    const name = e.target.dataset.role;
    if (!name) return;
    try {
      await api(`/users/${encodeURIComponent(name)}`, jsonBody({ role: e.target.value }, 'PUT'));
      toast(`${name} is now ${e.target.value === 'admin' ? 'an admin' : 'a member'}`);
    } catch (err) {
      toast(err.message, 'error');
    }
    await load();
    render();
  });

  box.addEventListener('click', async (e) => {
    const t = e.target;
    try {
      if (t.id === 'logout') {
        await api('/auth/logout', { method: 'POST' });
        location.href = '/login.html';
        return;
      }
      if (t.dataset.reset) {
        const pw = prompt(`New password for ${t.dataset.reset} (8 characters or more). They will be signed out everywhere.`);
        if (!pw) return;
        await api(`/users/${encodeURIComponent(t.dataset.reset)}`, jsonBody({ password: pw }, 'PUT'));
        toast('Password reset');
      }
      if (t.dataset.remove && confirm(`Remove ${t.dataset.remove}'s account? Their notes and conversations stay on disk.`)) {
        await api(`/users/${encodeURIComponent(t.dataset.remove)}`, { method: 'DELETE' });
        toast('Account removed');
        await load();
        render();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  await load();
  render();
}
