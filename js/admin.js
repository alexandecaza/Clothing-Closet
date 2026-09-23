// Coordinator admin: sign-in, inventory CRUD, request queue, settings.
import { SIZES, CATEGORIES, GENDERS, CONDITIONS, PHOTO_BUCKET, REQUEST_STATUSES, DEFAULT_SETTINGS } from './constants.js';
import {
  isConfigured, showSetupNotice, photoUrl, escapeHtml, compareItems, formatRef, pluralize, formatDate,
  relativeTime, contactHref, friendlyError, debounce, preserveFocus, toast, fillSelect,
} from './shared.js';
import { preparePhoto, formatBytes } from './image.js';

const $ = (id) => document.getElementById(id);

// Read before the Supabase client consumes the URL fragment.
const arrivedFromResetLink = /type=recovery/.test(location.hash);

const VIEWS = ['inventory', 'requests', 'settings'];

const state = {
  user: null,
  items: [],
  byId: new Map(),
  requests: [],
  settings: { ...DEFAULT_SETTINGS },
  view: 'inventory',
  reqStatus: 'pending',
  inv: { q: '', category: '', size: '', stock: '', sort: 'size' },
  editing: null, // { item, photo: { full, thumb, previewUrl } | null, removePhoto }
  loadedAt: 0,
};

let supabase;

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

function showScreen(name) {
  $('view-login').hidden = name !== 'login';
  $('view-recovery').hidden = name !== 'recovery';
  $('view-denied').hidden = true;
  const inApp = VIEWS.includes(name);
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  $('admin-nav').hidden = !inApp;
  $('header-actions').hidden = !inApp;
  for (const link of $('admin-nav').querySelectorAll('a')) {
    if (link.dataset.view === name) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function showLogin(message = '') {
  state.user = null;
  showScreen('login');
  $('login-error').textContent = message;
  $('login-form').email.focus();
}

function route() {
  if (!state.user) return;
  const hash = location.hash.slice(1);
  state.view = VIEWS.includes(hash) ? hash : 'inventory';
  showScreen(state.view);
  if (state.view === 'inventory') renderInventory();
  if (state.view === 'requests') renderRequests();
  if (state.view === 'settings') renderSettings();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function enterApp(user) {
  state.user = user;
  const { data: isAdmin, error } = await supabase.rpc('is_admin');
  if (error) {
    showLogin(friendlyError(error));
    return;
  }
  if (!isAdmin) {
    await supabase.auth.signOut();
    showLogin("That account isn't set up as a coordinator. Ask whoever runs the closet to add you (README, step 5).");
    return;
  }
  state.user = user;
  $('account-email').textContent = user.email;
  try {
    await loadAll();
  } catch (err) {
    toast(friendlyError(err), { tone: 'error' });
  }
  route();
}

function wireAuth() {
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const errorEl = $('login-error');
    errorEl.textContent = '';
    if (!supabase) return; // still starting up
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) {
      errorEl.textContent = 'Enter your email and password.';
      return;
    }
    const button = form.querySelector('[type=submit]');
    button.disabled = true;
    button.textContent = 'Signing in…';
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    button.disabled = false;
    button.textContent = 'Sign in';
    if (error) {
      errorEl.textContent = /invalid login/i.test(error.message)
        ? "That email and password don't match an account."
        : friendlyError(error);
      return;
    }
    form.password.value = '';
    await enterApp(data.user);
  });

  $('forgot').addEventListener('click', async () => {
    const email = $('login-form').email.value.trim();
    const errorEl = $('login-error');
    if (!email) {
      errorEl.textContent = 'Type your email above first, then choose “Forgot password?”.';
      $('login-form').email.focus();
      return;
    }
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname,
    });
    errorEl.textContent = error
      ? friendlyError(error)
      : 'If that address has an account, a reset link is on its way. Check your inbox.';
  });

  $('recovery-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = e.target.password.value;
    const errorEl = $('recovery-error');
    if (password.length < 8) {
      errorEl.textContent = 'Use at least 8 characters.';
      return;
    }
    const { data, error } = await supabase.auth.updateUser({ password });
    if (error) {
      errorEl.textContent = friendlyError(error);
      return;
    }
    history.replaceState(null, '', location.pathname);
    toast('Password saved.');
    await enterApp(data.user);
  });

  $('sign-out').addEventListener('click', async () => {
    await supabase.auth.signOut();
    showLogin();
  });
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function setItems(items) {
  state.items = items;
  state.byId = new Map(items.map((i) => [i.id, i]));
}

async function loadItems() {
  const { data, error } = await supabase.from('items').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  setItems(data);
}

async function loadRequests() {
  const { data, error } = await supabase.from('requests').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  state.requests = data;
  renderPendingBadge();
}

async function loadSettings() {
  const { data, error } = await supabase.from('settings').select('*').eq('id', 1).maybeSingle();
  if (error) throw error;
  if (data) state.settings = data;
  $('org-name').textContent = state.settings.org_name;
}

async function loadAll() {
  await Promise.all([loadItems(), loadRequests(), loadSettings()]);
  state.loadedAt = Date.now();
}

async function refreshQuietly() {
  try {
    await loadAll();
    if (state.view === 'requests') renderRequests();
    if (state.view === 'inventory') preserveFocus(renderInventoryRows);
  } catch {
    // Ignore — the next explicit action will surface any problem.
  }
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

function confirmDialog({ title, body, ok = 'OK', danger = false }) {
  const dialog = $('confirm-dialog');
  $('confirm-title').textContent = title;
  $('confirm-body').innerHTML = body;
  const okButton = $('confirm-ok');
  okButton.textContent = ok;
  okButton.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    const form = dialog.querySelector('form');
    const finish = (value) => {
      form.removeEventListener('submit', onSubmit);
      dialog.removeEventListener('close', onClose);
      resolve(value);
    };
    const onSubmit = (e) => finish(e.submitter?.value === 'ok');
    const onClose = () => finish(dialog.returnValue === 'ok'); // Esc key
    form.addEventListener('submit', onSubmit);
    dialog.addEventListener('close', onClose);
  });
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

function filteredItems() {
  const { q, category, size, stock, sort } = state.inv;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = state.items.filter((item) => {
    if (category && item.category !== category) return false;
    if (size && item.size !== size) return false;
    if (stock === 'in' && item.quantity <= 0) return false;
    if (stock === 'out' && item.quantity > 0) return false;
    if (words.length) {
      const hay = `${item.name} ${item.notes} ${item.category} ${item.size} ${item.gender} ${item.condition}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const sorters = {
    size: compareItems,
    name: (a, b) => a.name.localeCompare(b.name),
    stock: (a, b) => a.quantity - b.quantity || compareItems(a, b),
    recent: (a, b) => b.created_at.localeCompare(a.created_at),
  };
  return list.sort(sorters[sort] || compareItems);
}

function renderInventorySummary() {
  const pieces = state.items.reduce((sum, i) => sum + i.quantity, 0);
  const out = state.items.filter((i) => i.quantity <= 0).length;
  $('inv-summary').textContent =
    `${pluralize(state.items.length, 'item')} · ${pluralize(pieces, 'piece')} in stock` +
    (out ? ` · ${out} out of stock` : '');
}

function inventoryRow(item) {
  const name = escapeHtml(item.name);
  const thumb = item.thumb_path
    ? `<img src="${escapeHtml(photoUrl(item.thumb_path))}" alt="" loading="lazy" width="48" height="48">`
    : `<span class="thumb-empty" title="No photo"></span>`;
  const notes = item.notes ? `<span class="cell-notes">${escapeHtml(item.notes)}</span>` : '';
  return `
    <tr data-id="${item.id}" class="${item.quantity <= 0 ? 'is-out' : ''}">
      <td class="col-photo"><span class="thumb">${thumb}</span></td>
      <td class="col-name"><span class="cell-name">${name}</span>${notes}</td>
      <td data-label="Category">${escapeHtml(item.category)}</td>
      <td data-label="Size"><span class="size-chip">${escapeHtml(item.size)}</span></td>
      <td data-label="For">${escapeHtml(item.gender)}</td>
      <td data-label="Condition">${escapeHtml(item.condition)}</td>
      <td class="col-qty" data-label="In stock">
        <div class="stepper stepper-sm">
          <button type="button" class="stepper-btn" data-action="qty-dec" data-focus-key="qty-dec:${item.id}"
            aria-label="Decrease stock of ${name}" ${item.quantity <= 0 ? 'disabled' : ''}>−</button>
          <input class="qty-input" type="number" min="0" max="9999" inputmode="numeric" value="${item.quantity}"
            data-action="qty-input" data-focus-key="qty-input:${item.id}" aria-label="Stock of ${name}">
          <button type="button" class="stepper-btn" data-action="qty-inc" data-focus-key="qty-inc:${item.id}"
            aria-label="Increase stock of ${name}">+</button>
        </div>
        <span class="save-state" data-save-state aria-live="polite"></span>
      </td>
      <td class="col-actions">
        <button type="button" class="btn btn-small" data-action="edit" data-focus-key="edit:${item.id}">Edit<span class="visually-hidden"> ${name}</span></button>
        <button type="button" class="btn btn-small btn-quiet-danger" data-action="delete">Delete<span class="visually-hidden"> ${name}</span></button>
      </td>
    </tr>`;
}

function renderInventoryRows() {
  const rows = filteredItems();
  const body = $('inv-body');
  if (state.items.length === 0) {
    body.innerHTML = `<tr><td colspan="8" class="table-empty">No items yet. Choose “+ Add item” to put the first one on the rack.</td></tr>`;
  } else if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="8" class="table-empty">No items match these filters.</td></tr>`;
  } else {
    body.innerHTML = rows.map(inventoryRow).join('');
  }
  renderInventorySummary();
}

function renderInventory() {
  renderInventoryRows();
}

const saveTimers = new Map();

function setSaveState(id, text) {
  const el = document.querySelector(`tr[data-id="${id}"] [data-save-state]`);
  if (el) el.textContent = text;
}

function changeQuantity(id, value) {
  const item = state.byId.get(id);
  const qty = Math.max(0, Math.min(9999, Math.round(Number(value))));
  if (!item || Number.isNaN(qty)) return;
  item.quantity = qty;

  const row = document.querySelector(`tr[data-id="${id}"]`);
  if (row) {
    row.classList.toggle('is-out', qty <= 0);
    row.querySelector('.qty-input').value = qty;
    row.querySelector('[data-action="qty-dec"]').disabled = qty <= 0;
  }
  renderInventorySummary();
  setSaveState(id, '');
  clearTimeout(saveTimers.get(id));
  saveTimers.set(id, setTimeout(() => saveQuantity(id), 500));
}

async function saveQuantity(id) {
  const item = state.byId.get(id);
  if (!item) return;
  setSaveState(id, 'Saving…');
  const { data, error } = await supabase
    .from('items')
    .update({ quantity: item.quantity })
    .eq('id', id)
    .select()
    .single();
  if (error) {
    setSaveState(id, 'Not saved');
    toast(`Couldn't save stock for “${item.name}”: ${friendlyError(error)}`, { tone: 'error' });
    return;
  }
  Object.assign(item, data);
  setSaveState(id, 'Saved');
  setTimeout(() => setSaveState(id, ''), 1500);
}

function wireInventory() {
  fillSelect($('inv-category'), CATEGORIES, 'All');
  fillSelect($('inv-size'), SIZES, 'All');

  const bind = (id, key) =>
    $(id).addEventListener('change', (e) => {
      state.inv[key] = e.target.value;
      renderInventoryRows();
    });
  bind('inv-category', 'category');
  bind('inv-size', 'size');
  bind('inv-stock', 'stock');
  bind('inv-sort', 'sort');
  const onSearch = debounce((value) => {
    state.inv.q = value.trim();
    renderInventoryRows();
  }, 150);
  $('inv-q').addEventListener('input', (e) => onSearch(e.target.value));

  $('add-item').addEventListener('click', () => openItemDialog());

  const body = $('inv-body');
  body.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    const item = state.byId.get(id);
    if (!item) return;
    const { action } = btn.dataset;
    if (action === 'qty-inc') changeQuantity(id, item.quantity + 1);
    if (action === 'qty-dec') changeQuantity(id, item.quantity - 1);
    if (action === 'edit') openItemDialog(item);
    if (action === 'delete') deleteItem(item);
  });
  body.addEventListener('change', (e) => {
    if (e.target.dataset.action !== 'qty-input') return;
    changeQuantity(e.target.closest('tr').dataset.id, e.target.value);
  });
  body.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset.action === 'qty-input') e.target.blur();
  });
}

// ---------------------------------------------------------------------------
// Add / edit item
// ---------------------------------------------------------------------------

function openItemDialog(item = null, preset = null) {
  const form = $('item-form');
  form.reset();
  $('item-error').textContent = '';
  releasePreview();
  state.editing = { item, photo: null, removePhoto: false };

  const source = item || { quantity: 1, notes: '', ...preset };
  form.name.value = source.name || '';
  form.category.value = source.category || CATEGORIES[0];
  form.size.value = source.size || SIZES[0];
  form.gender.value = source.gender || 'Unisex';
  form.condition.value = source.condition || CONDITIONS[1];
  form.quantity.value = source.quantity ?? 1;
  form.notes.value = source.notes || '';

  $('item-dialog-title').textContent = item ? 'Edit item' : 'Add item';
  $('save-another').hidden = Boolean(item);
  $('save-item').textContent = item ? 'Save changes' : 'Save item';
  $('photo-hint').textContent = 'Resized in your browser before upload.';
  renderPhotoPreview();

  const dialog = $('item-dialog');
  if (!dialog.open) dialog.showModal();
  form.name.focus();
}

function releasePreview() {
  if (state.editing?.photo?.previewUrl) URL.revokeObjectURL(state.editing.photo.previewUrl);
}

function renderPhotoPreview() {
  const { item, photo, removePhoto } = state.editing;
  const src = photo?.previewUrl || (!removePhoto && item?.photo_path ? photoUrl(item.photo_path) : '');
  $('photo-preview').innerHTML = src
    ? `<img src="${escapeHtml(src)}" alt="Photo preview">`
    : `<span class="photo-empty">No photo</span>`;
  $('photo-remove').hidden = !src;
  $('photo-choose-label').textContent = src ? 'Replace photo' : 'Choose photo';
}

function wireItemDialog() {
  const form = $('item-form');
  const dialog = $('item-dialog');
  fillSelect(form.category, CATEGORIES);
  fillSelect(form.size, SIZES);
  fillSelect(form.gender, GENDERS);
  fillSelect(form.condition, CONDITIONS);

  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) dialog.close();
  });
  dialog.addEventListener('close', () => {
    releasePreview();
    state.editing = null;
  });

  $('photo-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const hint = $('photo-hint');
    hint.textContent = 'Processing photo…';
    try {
      const { full, thumb } = await preparePhoto(file);
      if (!state.editing) return;
      releasePreview();
      state.editing.photo = { full, thumb, previewUrl: URL.createObjectURL(full) };
      state.editing.removePhoto = false;
      hint.textContent = `Resized from ${formatBytes(file.size)} to ${formatBytes(full.size)}. Uploads when you save.`;
      renderPhotoPreview();
    } catch (err) {
      hint.textContent = err.message;
    }
  });

  $('photo-remove').addEventListener('click', () => {
    if (state.editing.photo) {
      releasePreview();
      state.editing.photo = null;
    } else {
      state.editing.removePhoto = true;
    }
    $('photo-hint').textContent = 'Resized in your browser before upload.';
    renderPhotoPreview();
  });

  form.addEventListener('submit', saveItem);
}

async function uploadPhoto(path, blob) {
  const { error } = await supabase.storage
    .from(PHOTO_BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false });
  if (error) throw error;
}

async function removePhotos(paths) {
  const list = paths.filter(Boolean);
  if (list.length) await supabase.storage.from(PHOTO_BUCKET).remove(list);
}

async function persistItem(values) {
  const { item, photo, removePhoto } = state.editing;
  const id = item?.id ?? crypto.randomUUID();
  let photo_path = item?.photo_path ?? null;
  let thumb_path = item?.thumb_path ?? null;
  const uploaded = [];
  const stale = [];

  if (photo) {
    const stamp = Date.now();
    const full = `items/${id}/${stamp}.jpg`;
    const thumb = `items/${id}/${stamp}-thumb.jpg`;
    try {
      await uploadPhoto(full, photo.full);
      uploaded.push(full);
      await uploadPhoto(thumb, photo.thumb);
      uploaded.push(thumb);
    } catch (err) {
      await removePhotos(uploaded);
      throw new Error(`Photo upload failed: ${friendlyError(err)}`);
    }
    stale.push(photo_path, thumb_path);
    photo_path = full;
    thumb_path = thumb;
  } else if (removePhoto) {
    stale.push(photo_path, thumb_path);
    photo_path = null;
    thumb_path = null;
  }

  const record = { ...values, photo_path, thumb_path };
  const query = item
    ? supabase.from('items').update(record).eq('id', id)
    : supabase.from('items').insert({ id, ...record });
  const { data, error } = await query.select().single();
  if (error) {
    await removePhotos(uploaded);
    throw error;
  }
  removePhotos(stale).catch(() => {});
  return data;
}

async function saveItem(e) {
  e.preventDefault();
  const form = e.target;
  const errorEl = $('item-error');
  errorEl.textContent = '';
  const addAnother = e.submitter?.id === 'save-another';

  const values = {
    name: form.name.value.trim(),
    category: form.category.value,
    size: form.size.value,
    gender: form.gender.value,
    condition: form.condition.value,
    quantity: Number(form.quantity.value),
    notes: form.notes.value.trim(),
  };
  if (!values.name) {
    errorEl.textContent = 'Give the item a name.';
    form.name.focus();
    return;
  }
  if (!Number.isInteger(values.quantity) || values.quantity < 0) {
    errorEl.textContent = 'Quantity should be a whole number, 0 or more.';
    form.quantity.focus();
    return;
  }

  const buttons = form.querySelectorAll('.modal-actions button');
  buttons.forEach((b) => (b.disabled = true));
  const saveButton = addAnother ? $('save-another') : $('save-item');
  const saveLabel = saveButton.textContent;
  saveButton.textContent = 'Saving…';

  try {
    const isNew = !state.editing.item;
    const saved = await persistItem(values);
    setItems(isNew ? [saved, ...state.items] : state.items.map((i) => (i.id === saved.id ? saved : i)));
    renderInventoryRows();
    toast(isNew ? `Added “${saved.name}”.` : `Saved “${saved.name}”.`);
    if (addAnother) {
      const { category, size, gender, condition } = values;
      openItemDialog(null, { category, size, gender, condition });
    } else {
      $('item-dialog').close();
      document.querySelector(`[data-focus-key="edit:${saved.id}"]`)?.focus();
    }
  } catch (err) {
    errorEl.textContent = friendlyError(err);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    saveButton.textContent = saveLabel;
  }
}

async function deleteItem(item) {
  const onOpen = state.requests.filter(
    (r) => (r.status === 'pending' || r.status === 'approved') && r.items.some((l) => l.itemId === item.id)
  ).length;
  const ok = await confirmDialog({
    title: `Delete “${item.name}”?`,
    body: `<p>This removes it from the catalog for good. To just hide it, set its stock to 0 instead.</p>` +
      (onOpen
        ? `<p class="callout callout-warn">It's on ${pluralize(onOpen, 'open request')}. Those requests keep their record, but marking them picked up won't change stock for this item.</p>`
        : ''),
    ok: 'Delete item',
    danger: true,
  });
  if (!ok) return;
  const { error } = await supabase.from('items').delete().eq('id', item.id);
  if (error) {
    toast(`Couldn't delete: ${friendlyError(error)}`, { tone: 'error' });
    return;
  }
  removePhotos([item.photo_path, item.thumb_path]).catch(() => {});
  setItems(state.items.filter((i) => i.id !== item.id));
  renderInventoryRows();
  toast(`Deleted “${item.name}”.`);
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

const isOpen = (r) => r.status === 'pending' || r.status === 'approved';

function openDemand() {
  const demand = new Map();
  for (const r of state.requests) {
    if (!isOpen(r)) continue;
    for (const line of r.items) demand.set(line.itemId, (demand.get(line.itemId) || 0) + line.qty);
  }
  return demand;
}

function renderPendingBadge() {
  const n = state.requests.filter((r) => r.status === 'pending').length;
  const badge = $('pending-count');
  badge.hidden = n === 0;
  badge.textContent = String(n);
  badge.setAttribute('aria-label', `${n} pending`);
}

function requestLines(r, demand) {
  const open = isOpen(r);
  let level = '';
  const rows = r.items.map((line) => {
    const item = state.byId.get(line.itemId);
    let flag = '';
    if (open) {
      if (!item) {
        flag = `<span class="flag flag-warn">No longer in inventory</span>`;
        level = 'warn';
      } else if (line.qty > item.quantity) {
        flag = `<span class="flag flag-warn">Only ${item.quantity} in stock</span>`;
        level = 'warn';
      } else if ((demand.get(line.itemId) || 0) > item.quantity) {
        flag = `<span class="flag flag-soft">${demand.get(line.itemId)} wanted across open requests</span>`;
        level ||= 'soft';
      }
    }
    return `
      <tr>
        <td>${escapeHtml(line.name)}</td>
        <td><span class="size-chip">${escapeHtml(line.size)}</span></td>
        <td class="num">${line.qty}</td>
        ${open ? `<td class="num">${item ? item.quantity : '—'}</td>` : ''}
        ${open ? `<td>${flag}</td>` : ''}
      </tr>`;
  });
  const table = `
    <table class="table table-compact req-items">
      <thead>
        <tr>
          <th scope="col">Item</th><th scope="col">Size</th><th scope="col" class="num">Wants</th>
          ${open ? '<th scope="col" class="num">In stock</th><th scope="col"><span class="visually-hidden">Stock check</span></th>' : ''}
        </tr>
      </thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
  return { table, level };
}

function requestActions(r) {
  const b = (action, label, cls = 'btn') =>
    `<button type="button" class="${cls}" data-req-action="${action}" data-focus-key="${action}:${r.id}">${label}</button>`;
  switch (r.status) {
    case 'pending':
      return b('approve', 'Approve', 'btn btn-primary') + b('deny', 'Deny', 'btn btn-quiet-danger');
    case 'approved':
      return b('fulfill', 'Mark picked up', 'btn btn-primary') + b('unapprove', 'Back to pending') + b('deny', 'Deny', 'btn btn-quiet-danger');
    case 'denied':
      return b('reopen', 'Reopen') + b('delete', 'Delete record', 'btn btn-quiet-danger');
    default:
      return b('delete', 'Delete record', 'btn btn-quiet-danger');
  }
}

function requestCard(r, demand) {
  const { table, level } = requestLines(r, demand);
  const badge = level === 'warn'
    ? '<span class="flag flag-warn">Stock short</span>'
    : level === 'soft' ? '<span class="flag flag-soft">Competing requests</span>' : '';
  return `
    <article class="req-card${level ? ` is-${level}` : ''}" data-id="${r.id}">
      <header class="req-head">
        <div>
          <h2 class="req-name">${escapeHtml(r.family_name)}</h2>
          <p class="req-meta">
            <span class="ref-inline">${escapeHtml(formatRef(r.ref_code))}</span>
            · <time datetime="${escapeHtml(r.created_at)}" title="${escapeHtml(formatDate(r.created_at))}">${escapeHtml(relativeTime(r.created_at))}</time>
            · ${pluralize(r.total_qty, 'item')}
          </p>
        </div>
        ${badge}
      </header>
      <p class="req-contact"><a href="${escapeHtml(contactHref(r.contact))}">${escapeHtml(r.contact)}</a></p>
      ${r.note ? `<p class="req-note">${escapeHtml(r.note)}</p>` : ''}
      ${table}
      <div class="req-actions">${requestActions(r)}</div>
    </article>`;
}

const EMPTY_TEXT = {
  pending: 'No new requests. When a family sends one, it shows up here.',
  approved: 'Nothing waiting for pickup.',
  fulfilled: 'No picked-up requests yet.',
  denied: 'No denied requests.',
};

function renderRequests() {
  const counts = Object.fromEntries(REQUEST_STATUSES.map((s) => [s, 0]));
  for (const r of state.requests) counts[r.status] += 1;
  for (const tab of $('req-tabs').querySelectorAll('[role=tab]')) {
    const { status } = tab.dataset;
    const selected = status === state.reqStatus;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    tab.querySelector('.seg-count').textContent = counts[status] ? String(counts[status]) : '';
  }
  renderPendingBadge();

  const demand = openDemand();
  // Work the queue oldest-first; show history newest-first.
  const list = state.requests
    .filter((r) => r.status === state.reqStatus)
    .sort((a, b) =>
      isOpen(a) ? a.created_at.localeCompare(b.created_at) : b.updated_at.localeCompare(a.updated_at)
    );
  preserveFocus(() => {
    $('req-list').innerHTML = list.length
      ? `<div class="req-grid">${list.map((r) => requestCard(r, demand)).join('')}</div>`
      : `<p class="empty-state">${EMPTY_TEXT[state.reqStatus]}</p>`;
  });
}

async function updateStatus(r, status, message) {
  const { error } = await supabase.from('requests').update({ status }).eq('id', r.id).select('id').single();
  if (error) {
    toast(friendlyError(error), { tone: 'error' });
    await refreshQuietly();
    return;
  }
  await loadRequests();
  renderRequests();
  toast(message);
}

async function fulfillRequest(r) {
  const lines = r.items.map((line) => {
    const item = state.byId.get(line.itemId);
    if (!item) return `<li>${escapeHtml(line.name)} — <em>no longer in inventory, skipped</em></li>`;
    const after = Math.max(0, item.quantity - line.qty);
    const short = line.qty > item.quantity
      ? ` <span class="flag flag-warn">asks for ${line.qty}, only ${item.quantity} — stops at 0</span>`
      : '';
    return `<li>${escapeHtml(item.name)} <span class="muted">(${escapeHtml(item.size)})</span>: ${item.quantity} → <strong>${after}</strong>${short}</li>`;
  });
  const ok = await confirmDialog({
    title: `Mark ${r.family_name}'s request picked up?`,
    body: `<p>Stock will change like this:</p><ul class="change-list">${lines.join('')}</ul>`,
    ok: 'Mark picked up',
  });
  if (!ok) return;
  const { error } = await supabase.rpc('fulfill_request', { p_id: r.id });
  if (error) {
    toast(friendlyError(error), { tone: 'error' });
    await refreshQuietly();
    return;
  }
  await Promise.all([loadItems(), loadRequests()]);
  renderRequests();
  toast('Marked picked up. Stock updated.');
}

async function handleRequestAction(action, r) {
  if (action === 'approve') {
    await updateStatus(r, 'approved', `Approved. Contact ${r.family_name} to arrange pickup.`);
  } else if (action === 'unapprove') {
    await updateStatus(r, 'pending', 'Moved back to pending.');
  } else if (action === 'reopen') {
    await updateStatus(r, 'pending', 'Reopened.');
  } else if (action === 'deny') {
    const ok = await confirmDialog({
      title: `Deny ${r.family_name}'s request?`,
      body: `<p>No stock changes. The family isn't notified automatically — let them know at
        <a href="${escapeHtml(contactHref(r.contact))}">${escapeHtml(r.contact)}</a>.</p>`,
      ok: 'Deny request',
      danger: true,
    });
    if (ok) await updateStatus(r, 'denied', 'Request denied.');
  } else if (action === 'fulfill') {
    await fulfillRequest(r);
  } else if (action === 'delete') {
    const ok = await confirmDialog({
      title: 'Delete this request record?',
      body: `<p>This permanently removes ${escapeHtml(r.family_name)}'s contact details and request history. Stock isn't affected.</p>`,
      ok: 'Delete record',
      danger: true,
    });
    if (!ok) return;
    const { error } = await supabase.from('requests').delete().eq('id', r.id);
    if (error) {
      toast(friendlyError(error), { tone: 'error' });
      return;
    }
    state.requests = state.requests.filter((x) => x.id !== r.id);
    renderRequests();
    toast('Record deleted.');
  }
}

function wireRequests() {
  const tabs = $('req-tabs');
  tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('[role=tab]');
    if (!tab) return;
    state.reqStatus = tab.dataset.status;
    renderRequests();
  });
  tabs.addEventListener('keydown', (e) => {
    const all = [...tabs.querySelectorAll('[role=tab]')];
    const i = all.findIndex((t) => t.dataset.status === state.reqStatus);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const tab = all[(next + all.length) % all.length];
    state.reqStatus = tab.dataset.status;
    renderRequests();
    tab.focus();
  });

  $('req-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-req-action]');
    if (!btn) return;
    const r = state.requests.find((x) => x.id === btn.closest('.req-card').dataset.id);
    if (!r) return;
    const card = btn.closest('.req-card');
    card.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      await handleRequestAction(btn.dataset.reqAction, r);
    } finally {
      card.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  });

  $('refresh-requests').addEventListener('click', async () => {
    try {
      await loadAll();
      renderRequests();
      toast('Up to date.');
    } catch (err) {
      toast(friendlyError(err), { tone: 'error' });
    }
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function renderSettings() {
  const form = $('settings-form');
  form.org_name.value = state.settings.org_name;
  form.max_items_per_request.value = state.settings.max_items_per_request;
  $('settings-error').textContent = '';
}

function wireSettings() {
  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const errorEl = $('settings-error');
    const org_name = form.org_name.value.trim();
    const max = Number(form.max_items_per_request.value);
    if (!org_name) {
      errorEl.textContent = 'The closet needs a name.';
      return;
    }
    if (!Number.isInteger(max) || max < 1 || max > 100) {
      errorEl.textContent = 'Choose a whole number from 1 to 100.';
      return;
    }
    const { data, error } = await supabase
      .from('settings')
      .update({ org_name, max_items_per_request: max })
      .eq('id', 1)
      .select()
      .single();
    if (error) {
      errorEl.textContent = friendlyError(error);
      return;
    }
    errorEl.textContent = '';
    state.settings = data;
    $('org-name').textContent = data.org_name;
    toast('Settings saved.');
  });

  $('password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = e.target.password;
    const errorEl = $('password-error');
    if (input.value.length < 8) {
      errorEl.textContent = 'Use at least 8 characters.';
      return;
    }
    const { error } = await supabase.auth.updateUser({ password: input.value });
    if (error) {
      errorEl.textContent = friendlyError(error);
      return;
    }
    errorEl.textContent = '';
    input.value = '';
    toast('Password changed.');
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
  wireAuth();
  wireInventory();
  wireItemDialog();
  wireRequests();
  wireSettings();
  window.addEventListener('hashchange', route);

  if (!isConfigured()) {
    showSetupNotice($('setup'));
    return;
  }

  const { makeClient } = await import('./supabase-client.js');
  supabase = makeClient({ persistSession: true });

  // Don't await other Supabase calls inside this callback (it can deadlock).
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') showScreen('recovery');
    if (event === 'SIGNED_OUT' && state.user) showLogin();
  });

  const { data: { session } } = await supabase.auth.getSession();
  if (session && arrivedFromResetLink) {
    showScreen('recovery');
  } else if (session) {
    await enterApp(session.user);
  } else {
    showLogin();
  }

  // Pick up new requests when the coordinator comes back to the tab.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.user && Date.now() - state.loadedAt > 30_000) {
      refreshQuietly();
    }
  });
}

init();
