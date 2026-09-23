// Public catalog: browse, filter, build a request list, submit it.
import { SIZE_BANDS, SIZES, CATEGORIES, GENDERS, CONDITIONS, DEFAULT_SETTINGS } from './constants.js';
import {
  isConfigured, showSetupNotice, photoUrl, escapeHtml, compareItems, formatRef, pluralize,
  isValidContact, friendlyError, debounce, preserveFocus, toast, fillSelect,
} from './shared.js';
import { mountTurnstile } from './turnstile.js';

// Internal notes are deliberately not requested (and not readable by the public).
const PUBLIC_COLUMNS = 'id,name,category,size,gender,condition,quantity,photo_path,thumb_path';
const LIST_KEY = 'closet.requestList.v1';
const LAST_REF_KEY = 'closet.lastRef.v1';

const $ = (id) => document.getElementById(id);

const state = {
  items: [],
  byId: new Map(),
  settings: { ...DEFAULT_SETTINGS },
  filters: { sizes: new Set(), category: '', gender: '', condition: '', q: '', showOut: false },
  list: readStored(LIST_KEY, []), // [{ id, qty }]
  sheetView: 'list', // 'list' | 'sent'
  lastRef: readStored(LAST_REF_KEY, ''),
  sentContact: '',
  submitting: false,
};

let supabase;
let captcha = null; // robot check on the request form

// ---------------------------------------------------------------------------
// Storage helpers (per-browser conveniences only)
// ---------------------------------------------------------------------------

function readStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode / storage disabled: the list just won't survive a reload.
  }
}

// ---------------------------------------------------------------------------
// Request list
// ---------------------------------------------------------------------------

const maxItems = () => state.settings.max_items_per_request;
const listTotal = () => state.list.reduce((sum, line) => sum + line.qty, 0);
const listQty = (id) => state.list.find((l) => l.id === id)?.qty ?? 0;

function canAddOne(item) {
  return listTotal() < maxItems() && listQty(item.id) < item.quantity;
}

function setQty(id, qty) {
  const item = state.byId.get(id);
  const current = listQty(id);
  const room = maxItems() - (listTotal() - current);
  const next = Math.max(0, Math.min(qty, item ? item.quantity : 0, room));
  if (next === 0) {
    state.list = state.list.filter((l) => l.id !== id);
  } else if (current === 0) {
    state.list.push({ id, qty: next });
  } else {
    state.list = state.list.map((l) => (l.id === id ? { ...l, qty: next } : l));
  }
  writeStored(LIST_KEY, state.list);
  if (qty > next && next === current) {
    toast(listTotal() >= maxItems()
      ? `Requests are limited to ${pluralize(maxItems(), 'item')} at a time.`
      : `Only ${item?.quantity ?? 0} of that one available.`);
  }
  onListChanged();
}

// Drop anything that's gone or out of stock, clamp to what's available and to the cap.
function reconcileList() {
  let room = maxItems();
  const before = JSON.stringify(state.list);
  state.list = state.list
    .map((line) => {
      const item = state.byId.get(line.id);
      const qty = Math.min(line.qty, item ? item.quantity : 0, room);
      room -= Math.max(qty, 0);
      return { id: line.id, qty };
    })
    .filter((line) => line.qty > 0);
  writeStored(LIST_KEY, state.list);
  return before !== JSON.stringify(state.list);
}

function onListChanged() {
  renderListButtons();
  preserveFocus(renderCatalog, focusFallbacks);
  if ($('list-sheet').open && state.sheetView === 'list') renderSheetItems();
}

function focusFallbacks(key) {
  const [action, id] = key.split(':');
  if (action === 'add') return [`inc:${id}`, `dec:${id}`];
  if (action === 'dec' || action === 'inc') return [`inc:${id}`, `dec:${id}`, `add:${id}`];
  if (action === 'sheet-dec' || action === 'sheet-inc' || action === 'sheet-remove') {
    return [`sheet-inc:${id}`, `sheet-dec:${id}`, 'sheet-first'];
  }
  return [];
}

function renderListButtons() {
  const label = `${listTotal()}/${maxItems()}`;
  $('list-count').textContent = label;
  $('list-count-mobile').textContent = label;
  $('open-list').setAttribute('aria-label', `Request list, ${listTotal()} of ${maxItems()} items`);
  $('mobile-bar').hidden = listTotal() === 0;
}

// ---------------------------------------------------------------------------
// Size ruler
// ---------------------------------------------------------------------------

function buildRuler() {
  const ruler = $('ruler');
  const ticks = [];
  const bands = [];
  for (const { band, sizes } of SIZE_BANDS) {
    sizes.forEach((size, i) => {
      ticks.push(`
        <button type="button" class="tick${i === 0 ? ' tick-band-start' : ''}" data-size="${escapeHtml(size)}"
          aria-pressed="false" tabindex="-1">
          <span class="tick-label">${escapeHtml(size)}</span>
          <span class="tick-count"></span>
        </button>`);
    });
    bands.push(`<span class="ruler-band" data-span="${sizes.length}">${escapeHtml(band)}</span>`);
  }
  ruler.innerHTML = `
    <div class="ruler-track" role="toolbar" aria-labelledby="size-heading" aria-describedby="size-summary">
      ${ticks.join('')}
      ${bands.join('')}
    </div>`;

  const track = ruler.querySelector('.ruler-track');
  track.style.setProperty('--ticks', SIZES.length);
  for (const band of track.querySelectorAll('.ruler-band')) {
    band.style.gridColumn = `span ${band.dataset.span}`;
  }
  track.querySelector('.tick').tabIndex = 0;

  track.addEventListener('click', (e) => {
    const tick = e.target.closest('.tick');
    if (!tick) return;
    const { size } = tick.dataset;
    if (state.filters.sizes.has(size)) state.filters.sizes.delete(size);
    else state.filters.sizes.add(size);
    setRovingFocus(tick, false);
    onFiltersChanged();
  });

  // Toolbar keyboard pattern: one tab stop, arrow keys move between sizes.
  track.addEventListener('keydown', (e) => {
    const tick = e.target.closest('.tick');
    if (!tick) return;
    const all = [...track.querySelectorAll('.tick')];
    const i = all.indexOf(tick);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    setRovingFocus(all[Math.max(0, Math.min(all.length - 1, next))], true);
  });
}

function setRovingFocus(tick, focus) {
  for (const t of $('ruler').querySelectorAll('.tick')) t.tabIndex = t === tick ? 0 : -1;
  if (focus) {
    tick.focus();
    tick.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

function renderRuler() {
  const counts = new Map();
  for (const item of state.items) {
    if (item.quantity > 0) counts.set(item.size, (counts.get(item.size) || 0) + 1);
  }
  for (const tick of $('ruler').querySelectorAll('.tick')) {
    const { size } = tick.dataset;
    const n = counts.get(size) || 0;
    const selected = state.filters.sizes.has(size);
    tick.setAttribute('aria-pressed', String(selected));
    tick.classList.toggle('is-empty', n === 0);
    tick.querySelector('.tick-count').textContent = n ? String(n) : '';
    tick.setAttribute('aria-label', `${size}, ${n ? pluralize(n, 'item') : 'none in stock'}`);
  }
  const chosen = SIZES.filter((s) => state.filters.sizes.has(s));
  $('size-summary').textContent = chosen.length ? `Showing ${chosen.join(', ')}` : 'Any size — tap one or more';
  $('clear-sizes').hidden = chosen.length === 0;
}

// ---------------------------------------------------------------------------
// Catalog grid
// ---------------------------------------------------------------------------

function matches(item) {
  const f = state.filters;
  if (!f.showOut && item.quantity <= 0) return false;
  if (f.sizes.size && !f.sizes.has(item.size)) return false;
  if (f.category && item.category !== f.category) return false;
  if (f.gender && item.gender !== f.gender) return false;
  if (f.condition && item.condition !== f.condition) return false;
  if (f.q) {
    const hay = `${item.name} ${item.category} ${item.size} ${item.gender} ${item.condition}`.toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  return true;
}

function hasActiveFilters() {
  const f = state.filters;
  return f.sizes.size > 0 || f.category || f.gender || f.condition || f.q || f.showOut;
}

function cardAction(item) {
  const name = escapeHtml(item.name);
  if (item.quantity <= 0) {
    return `<p class="tag-out">Out of stock</p>`;
  }
  const qty = listQty(item.id);
  if (qty === 0) {
    const full = listTotal() >= maxItems();
    return `
      <button type="button" class="btn btn-add" data-action="add" data-id="${item.id}" data-focus-key="add:${item.id}"
        ${full ? `disabled title="Your list is full (${maxItems()} items)"` : ''}>
        ${full ? 'List is full' : 'Add to list'}
      </button>`;
  }
  return `
    <div class="stepper" role="group" aria-label="${name} on your list">
      <button type="button" class="stepper-btn" data-action="dec" data-id="${item.id}" data-focus-key="dec:${item.id}"
        aria-label="One fewer ${name}">−</button>
      <span class="stepper-value" aria-live="polite">${qty} on list</span>
      <button type="button" class="stepper-btn" data-action="inc" data-id="${item.id}" data-focus-key="inc:${item.id}"
        aria-label="One more ${name}" ${canAddOne(item) ? '' : 'disabled'}>+</button>
    </div>`;
}

function card(item) {
  const name = escapeHtml(item.name);
  const out = item.quantity <= 0;
  const photo = item.photo_path
    ? `<button type="button" class="tag-photo" data-action="zoom" data-id="${item.id}" aria-label="Larger photo of ${name}">
         <img src="${escapeHtml(photoUrl(item.photo_path))}" alt="" loading="lazy" decoding="async">
       </button>`
    : `<div class="tag-photo tag-photo-empty" aria-hidden="true"><span>No photo yet</span></div>`;
  return `
    <li class="tag${out ? ' is-out' : ''}">
      <div class="tag-top">
        <span class="tag-hole" aria-hidden="true"></span>
        <span class="tag-size"><span class="visually-hidden">Size </span>${escapeHtml(item.size)}</span>
      </div>
      ${photo}
      <div class="tag-body">
        <h3 class="tag-name">${name}</h3>
        <p class="tag-meta">${escapeHtml(item.category)} · ${escapeHtml(item.gender)}</p>
        <p class="tag-meta">${escapeHtml(item.condition)}</p>
        <p class="tag-stock">${out ? '' : `${item.quantity} available`}</p>
      </div>
      <div class="tag-action">${cardAction(item)}</div>
    </li>`;
}

function renderCatalog() {
  const list = $('catalog');
  const visible = state.items.filter(matches).sort(compareItems);
  list.removeAttribute('aria-busy');

  const count = $('result-count');
  count.textContent = state.items.length === 0
    ? ''
    : `${pluralize(visible.length, 'item')}${hasActiveFilters() ? ' match your filters' : ' available'}`;
  $('clear-all').hidden = !hasActiveFilters();

  if (state.items.length === 0) {
    list.innerHTML = `<li class="empty-state"><p>The rack is empty right now. Please check back soon.</p></li>`;
    return;
  }
  if (visible.length === 0) {
    list.innerHTML = `
      <li class="empty-state">
        <p>Nothing matches those filters.</p>
        <p class="muted">Try a neighbouring size, or turn on “Show out-of-stock” to see what's coming back.</p>
      </li>`;
    return;
  }
  list.innerHTML = visible.map(card).join('');
}

function onFiltersChanged() {
  renderRuler();
  renderCatalog();
}

function wireFilters() {
  fillSelect($('f-category'), CATEGORIES, 'Any category');
  fillSelect($('f-gender'), GENDERS, 'Anyone');
  fillSelect($('f-condition'), CONDITIONS, 'Any condition');

  const bind = (id, key, read = (el) => el.value) => {
    $(id).addEventListener('change', (e) => {
      state.filters[key] = read(e.target);
      onFiltersChanged();
    });
  };
  bind('f-category', 'category');
  bind('f-gender', 'gender');
  bind('f-condition', 'condition');
  bind('f-out', 'showOut', (el) => el.checked);

  const onSearch = debounce((value) => {
    state.filters.q = value.trim();
    onFiltersChanged();
  }, 150);
  $('f-q').addEventListener('input', (e) => onSearch(e.target.value));

  $('clear-sizes').addEventListener('click', () => {
    state.filters.sizes.clear();
    onFiltersChanged();
    $('ruler').querySelector('.tick[tabindex="0"]')?.focus();
  });

  $('clear-all').addEventListener('click', () => {
    state.filters = { sizes: new Set(), category: '', gender: '', condition: '', q: '', showOut: false };
    $('f-q').value = '';
    $('f-category').value = '';
    $('f-gender').value = '';
    $('f-condition').value = '';
    $('f-out').checked = false;
    onFiltersChanged();
    $('f-q').focus();
  });

  $('catalog').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    const item = state.byId.get(id);
    if (!item) return;
    if (action === 'add' || action === 'inc') setQty(id, listQty(id) + 1);
    else if (action === 'dec') setQty(id, listQty(id) - 1);
    else if (action === 'zoom') openPhoto(item);
  });
}

// ---------------------------------------------------------------------------
// Request list sheet
// ---------------------------------------------------------------------------

function openSheet() {
  if (state.sheetView === 'sent' && listTotal() > 0) state.sheetView = 'list';
  renderSheet();
  $('list-sheet').showModal();
}

function renderSheet() {
  const body = $('sheet-body');
  captcha?.remove();
  captcha = null;
  if (state.sheetView === 'sent') {
    body.innerHTML = `
      <div class="sheet-head">
        <h2 id="sheet-title">Request sent</h2>
        <button type="button" class="icon-button" data-close aria-label="Close">×</button>
      </div>
      <div class="sent">
        <p class="sent-lead">Thank you — your request is with the coordinator.</p>
        <p>They'll review it and reach out at <strong>${escapeHtml(state.sentContact)}</strong> to arrange a pickup time. Nothing is shipped automatically.</p>
        <div class="ref-stamp">
          <span class="ref-label">Your reference</span>
          <span class="ref-code">${escapeHtml(formatRef(state.lastRef))}</span>
        </div>
        <p class="muted">Keep this code if you'd like to check on your request later (“Check its status” at the bottom of the page).</p>
        <button type="button" class="btn btn-primary" data-close>Done</button>
      </div>`;
    return;
  }

  body.innerHTML = `
    <div class="sheet-head">
      <h2 id="sheet-title">Your request list</h2>
      <button type="button" class="icon-button" data-close aria-label="Close">×</button>
    </div>
    <div id="sheet-items"></div>
    <form class="request-form" id="request-form" novalidate>
      <h3>Your details</h3>
      <label class="field">
        <span class="field-label">Your name</span>
        <input name="family_name" autocomplete="name" maxlength="100" required>
      </label>
      <label class="field">
        <span class="field-label">Phone or email</span>
        <input name="contact" autocomplete="email" inputmode="email" maxlength="200" required
          aria-describedby="contact-hint">
        <span class="field-hint" id="contact-hint">So the coordinator can arrange pickup.</span>
      </label>
      <label class="field">
        <span class="field-label">Note <span class="optional">(optional)</span></span>
        <textarea name="note" rows="3" maxlength="1000" placeholder="Ages, anything specific you're looking for, best times to reach you…"></textarea>
      </label>
      <label class="hp" aria-hidden="true">Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label>
      <div class="captcha" id="request-captcha"></div>
      <p class="form-error" id="request-error" role="alert"></p>
      <button type="submit" class="btn btn-primary btn-block" id="request-submit">Send request</button>
      <p class="fine-print">Everything is free. Sending a request doesn't reserve items — the coordinator will confirm what's available when they contact you.</p>
    </form>`;
  renderSheetItems();
  $('request-form').addEventListener('submit', submitRequest);
  captcha = mountTurnstile($('request-captcha'), { action: 'submit-request' });
}

function renderSheetItems() {
  const wrap = $('sheet-items');
  if (!wrap) return;
  const total = listTotal();
  const submit = $('request-submit');
  if (submit) submit.disabled = total === 0 || state.submitting;

  if (total === 0) {
    wrap.innerHTML = `<p class="sheet-empty">Nothing here yet. Tap “Add to list” on anything that fits.</p>`;
    return;
  }
  preserveFocus(() => {
    wrap.innerHTML = `
      <p class="sheet-count"><strong>${total}</strong> of ${pluralize(maxItems(), 'item')} allowed per request</p>
      <ul class="sheet-list">
        ${state.list.map((line, index) => {
          const item = state.byId.get(line.id);
          if (!item) return '';
          const name = escapeHtml(item.name);
          const thumb = item.thumb_path
            ? `<img src="${escapeHtml(photoUrl(item.thumb_path))}" alt="" loading="lazy">`
            : `<span class="thumb-empty"></span>`;
          return `
            <li class="sheet-line">
              <span class="sheet-thumb">${thumb}</span>
              <span class="sheet-line-text">
                <span class="sheet-line-name">${name}</span>
                <span class="muted">Size ${escapeHtml(item.size)} · ${escapeHtml(item.gender)}</span>
              </span>
              <span class="stepper stepper-sm" role="group" aria-label="Quantity of ${name}">
                <button type="button" class="stepper-btn" data-sheet="dec" data-id="${item.id}" data-focus-key="sheet-dec:${item.id}" aria-label="One fewer ${name}">−</button>
                <span class="stepper-value">${line.qty}</span>
                <button type="button" class="stepper-btn" data-sheet="inc" data-id="${item.id}" data-focus-key="sheet-inc:${item.id}" aria-label="One more ${name}" ${canAddOne(item) ? '' : 'disabled'}>+</button>
              </span>
              <button type="button" class="link-button link-danger" data-sheet="remove" data-id="${item.id}"
                data-focus-key="${index === 0 ? 'sheet-first' : `sheet-remove:${item.id}`}">Remove<span class="visually-hidden"> ${name}</span></button>
            </li>`;
        }).join('')}
      </ul>`;
  }, focusFallbacks);
}

async function submitRequest(e) {
  e.preventDefault();
  const form = e.target;
  const errorEl = $('request-error');
  errorEl.textContent = '';

  const data = Object.fromEntries(new FormData(form));
  if (data.website) return; // bot filled the honeypot

  const name = data.family_name.trim();
  const contact = data.contact.trim();
  if (!name) {
    errorEl.textContent = 'Please enter your name.';
    form.family_name.focus();
    return;
  }
  if (!isValidContact(contact)) {
    errorEl.textContent = 'Please enter a phone number or email address we can reach you at.';
    form.contact.focus();
    return;
  }
  if (listTotal() === 0) {
    errorEl.textContent = 'Your list is empty.';
    return;
  }

  state.submitting = true;
  const submit = $('request-submit');
  submit.disabled = true;
  submit.textContent = 'Sending…';

  const done = (message) => {
    state.submitting = false;
    submit.textContent = 'Send request';
    submit.disabled = false;
    errorEl.textContent = message;
  };

  let token = '';
  try {
    token = await captcha?.getToken();
  } catch (err) {
    done(err.message);
    return;
  }

  const { data: result, error } = await supabase.rpc('submit_request', {
    p_family_name: name,
    p_contact: contact,
    p_note: data.note.trim(),
    p_items: state.list.map((l) => ({ item_id: l.id, qty: l.qty })),
    p_captcha_token: token || null,
  });
  captcha?.reset(); // tokens are single-use

  if (error || !result?.ok) {
    done(error ? friendlyError(error) : result?.error || 'Something went wrong. Please try again.');
    // Stock may have changed since the page loaded; refresh quietly.
    loadItems().then(() => {
      reconcileList();
      onListChanged();
    });
    return;
  }

  const ref = result.ref;
  state.submitting = false;
  submit.textContent = 'Send request';

  state.lastRef = ref;
  state.sentContact = contact;
  writeStored(LAST_REF_KEY, ref);
  state.list = [];
  writeStored(LIST_KEY, state.list);
  state.sheetView = 'sent';
  renderSheet();
  renderListButtons();
  renderCatalog();
  $('list-sheet').querySelector('.btn-primary')?.focus();
}

function wireSheet() {
  const sheet = $('list-sheet');
  $('open-list').addEventListener('click', openSheet);
  $('open-list-mobile').addEventListener('click', openSheet);
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet || e.target.closest('[data-close]')) {
      sheet.close();
      return;
    }
    const btn = e.target.closest('[data-sheet]');
    if (!btn) return;
    const { sheet: action, id } = btn.dataset;
    if (action === 'inc') setQty(id, listQty(id) + 1);
    if (action === 'dec') setQty(id, listQty(id) - 1);
    if (action === 'remove') setQty(id, 0);
  });
  sheet.addEventListener('close', () => {
    if (state.sheetView === 'sent') state.sheetView = 'list';
  });
}

// ---------------------------------------------------------------------------
// Photo + status dialogs
// ---------------------------------------------------------------------------

function openPhoto(item) {
  $('photo-body').innerHTML = `
    <div class="modal-head">
      <h2>${escapeHtml(item.name)} <span class="muted">· Size ${escapeHtml(item.size)}</span></h2>
      <button type="button" class="icon-button" data-close aria-label="Close">×</button>
    </div>
    <img class="photo-full" src="${escapeHtml(photoUrl(item.photo_path))}" alt="${escapeHtml(item.name)}">`;
  $('photo-dialog').showModal();
}

const STATUS_TEXT = {
  pending: ['Received', "The coordinator hasn't reviewed it yet. They'll be in touch."],
  approved: ['Approved', 'The coordinator will contact you to arrange pickup.'],
  fulfilled: ['Picked up', 'This request has been picked up. We hope everything fits!'],
  denied: ['Not able to fill', "We couldn't fill this one. You're welcome to send a new request."],
};

function wireStatus() {
  const dialog = $('status-dialog');
  $('open-status').addEventListener('click', () => {
    $('status-ref').value = state.lastRef ? formatRef(state.lastRef) : '';
    $('status-result').innerHTML = '';
    dialog.showModal();
  });
  $('status-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('status-result');
    const ref = $('status-ref').value.replace(/[^a-z0-9]/gi, '');
    if (ref.length < 6) {
      out.innerHTML = `<p class="form-error">Reference codes are 6 letters and numbers, like ABC-D23.</p>`;
      return;
    }
    out.innerHTML = `<p class="muted">Checking…</p>`;
    const { data, error } = await supabase.rpc('request_status', { p_ref: ref });
    if (error) {
      out.innerHTML = `<p class="form-error">${escapeHtml(friendlyError(error))}</p>`;
      return;
    }
    const row = data?.[0];
    if (!row) {
      out.innerHTML = `<p class="form-error">We couldn't find a request with that code. Check for typos and try again.</p>`;
      return;
    }
    const [label, text] = STATUS_TEXT[row.status] || [row.status, ''];
    out.innerHTML = `
      <div class="status-card" data-status="${escapeHtml(row.status)}">
        <p class="status-label">${escapeHtml(label)}</p>
        <p>${escapeHtml(text)}</p>
      </div>`;
  });
}

function wireDialogs() {
  for (const dialog of document.querySelectorAll('dialog.modal')) {
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
    });
  }
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadItems() {
  const { data, error } = await supabase.from('items').select(PUBLIC_COLUMNS);
  if (error) throw error;
  state.items = data;
  state.byId = new Map(data.map((i) => [i.id, i]));
}

async function loadSettings() {
  const { data, error } = await supabase.from('settings').select('org_name,max_items_per_request').eq('id', 1).maybeSingle();
  if (error) throw error;
  if (data) state.settings = data;
  $('org-name').textContent = state.settings.org_name;
  document.title = state.settings.org_name;
}

async function init() {
  buildRuler();
  wireFilters();
  wireSheet();
  wireStatus();
  wireDialogs();
  renderListButtons();

  if (!isConfigured()) {
    showSetupNotice($('setup'));
    renderCatalog();
    renderRuler();
    return;
  }

  const { makeClient } = await import('./supabase-client.js');
  supabase = makeClient({ persistSession: false });

  try {
    await Promise.all([loadSettings(), loadItems()]);
  } catch (error) {
    $('catalog').removeAttribute('aria-busy');
    $('catalog').innerHTML = `
      <li class="empty-state">
        <p>We couldn't load the clothes right now.</p>
        <p class="muted">${escapeHtml(friendlyError(error))}</p>
      </li>`;
    return;
  }

  if (reconcileList() && listTotal() > 0) {
    toast('Some items on your saved list changed availability, so we updated it.');
  }
  renderListButtons();
  renderRuler();
  renderCatalog();
}

init();
