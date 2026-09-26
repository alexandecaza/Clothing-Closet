// Small interaction touches shared by both pages: cards lean toward the mouse
// with a soft highlight, and the header gains a shadow once the page scrolls.
// Everything here is decorative; the pages work the same without it.

const CARDS = '.tag, .req-card, .panel, .auth-card';
const MAX_TILT = 4; // degrees

const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let active = null;

function reset(card) {
  card.style.removeProperty('--rx');
  card.style.removeProperty('--ry');
}

document.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse' || !finePointer.matches) return;
  const card = e.target.closest?.(CARDS);
  if (active && active !== card) reset(active);
  active = card;
  if (!card) return;

  const rect = card.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  card.style.setProperty('--mx', `${(x * 100).toFixed(1)}%`);
  card.style.setProperty('--my', `${(y * 100).toFixed(1)}%`);
  if (!reduceMotion.matches && card.classList.contains('tag')) {
    card.style.setProperty('--rx', `${((0.5 - y) * MAX_TILT).toFixed(2)}deg`);
    card.style.setProperty('--ry', `${((x - 0.5) * MAX_TILT).toFixed(2)}deg`);
  }
}, { passive: true });

document.documentElement.addEventListener('pointerleave', () => {
  if (active) reset(active);
  active = null;
});

const header = document.querySelector('.site-header');
if (header) {
  const update = () => header.classList.toggle('is-scrolled', window.scrollY > 4);
  window.addEventListener('scroll', update, { passive: true });
  update();
}
