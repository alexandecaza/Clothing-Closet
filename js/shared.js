// Helpers used by both the public catalog and the admin.
import * as config from './config.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { PHOTO_BUCKET, SIZES } from './constants.js';

export function isConfigured() {
  return !SUPABASE_URL.includes('YOUR-PROJECT-REF') && !SUPABASE_ANON_KEY.startsWith('YOUR-');
}

export function showSetupNotice(container) {
  container.innerHTML = `
    <div class="notice notice-setup" role="status">
      <h2>Almost there</h2>
      <p>This closet isn't connected to its database yet. Add your Supabase
      project URL and key to <code>js/config.js</code> — see step 4 of the README.</p>
    </div>`;
}

// Local development only: label demo mode, and warn loudly when a localhost
// copy is pointed at the live database. Never shows on the live site.
export function showDevBanner() {
  let text = '';
  let tone = '';
  if (config.DEMO_MODE) {
    text = 'Demo mode: fake sample data, nothing online is touched. Coordinator password: demo';
    tone = 'demo';
  } else if (config.USING_LIVE_DATA_LOCALLY) {
    text = 'Local copy connected to the LIVE database: changes here affect real families. ' +
      'For safe testing, see README → “Testing changes locally”.';
    tone = 'live';
  }
  if (!text) return;
  const bar = document.createElement('div');
  bar.className = 'dev-banner';
  bar.dataset.tone = tone;
  bar.setAttribute('role', 'status');
  bar.textContent = text;
  document.body.prepend(bar);
}

export function photoUrl(path) {
  if (!path) return '';
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${encoded}`;
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function sizeRank(size) {
  const i = SIZES.indexOf(size);
  return i === -1 ? SIZES.length : i;
}

export function compareItems(a, b) {
  return sizeRank(a.size) - sizeRank(b.size) || a.name.localeCompare(b.name);
}

export function formatRef(code) {
  return code && code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code || '';
}

export function pluralize(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export function formatDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function relativeTime(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const steps = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.35, 'week'],
    [12, 'month'],
    [Infinity, 'year'],
  ];
  let value = seconds;
  for (const [size, unit] of steps) {
    if (Math.abs(value) < size) return rtf.format(-Math.round(value), unit);
    value /= size;
  }
  return '';
}

export function isValidContact(value) {
  const v = value.trim();
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return true;
  const digits = v.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

export function contactHref(contact) {
  const v = contact.trim();
  if (v.includes('@')) return `mailto:${v}`;
  return `tel:${v.replace(/[^\d+]/g, '')}`;
}

export function friendlyError(error) {
  const message = error?.message || String(error || '');
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return "Couldn't reach the server. Check your connection and try again.";
  }
  if (/captcha/i.test(message)) {
    return "The robot check didn't go through. Please try again.";
  }
  if (/rate limit|too many requests/i.test(message)) {
    return 'Too many attempts. Please wait a few minutes and try again.';
  }
  if (/jwt|token/i.test(message) && /expired|invalid/i.test(message)) {
    return 'Your session expired. Please sign in again.';
  }
  return message || 'Something went wrong. Please try again.';
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Re-render a region without losing keyboard focus: elements that should keep
// focus across renders carry a data-focus-key. `fallbacks` maps a key that may
// disappear to keys to try instead (e.g. "add:ID" becomes "inc:ID").
export function preserveFocus(render, fallbacks = () => []) {
  const key = document.activeElement?.dataset?.focusKey;
  render();
  if (!key) return;
  for (const k of [key, ...fallbacks(key)]) {
    const el = document.querySelector(`[data-focus-key="${CSS.escape(k)}"]`);
    if (el && !el.disabled) {
      el.focus();
      return;
    }
  }
}

let toastTimer;
export function toast(message, { tone = 'info' } = {}) {
  let region = document.getElementById('toast');
  if (!region) {
    region = document.createElement('div');
    region.id = 'toast';
    region.className = 'toast';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.append(region);
  }
  region.textContent = message;
  region.dataset.tone = tone;
  region.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => region.classList.remove('is-visible'), 3500);
}

export function fillSelect(select, values, placeholder) {
  select.innerHTML =
    (placeholder !== undefined ? `<option value="">${escapeHtml(placeholder)}</option>` : '') +
    values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
}
