// Cloudflare Turnstile robot check. Usually invisible: most visitors never see
// it, and it only shows a checkbox when Cloudflare isn't sure.
// The token it produces is verified by the server (Supabase), not here.
import * as config from './config.js';

const SITE_KEY = config.TURNSTILE_SITE_KEY || '';
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let loading = null;

export const turnstileConfigured = () => Boolean(SITE_KEY);

function loadScript() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve(window.turnstile);
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error(
        "The robot check couldn't load. Check your connection or pause any content blocker, then try again."
      ));
    };
    document.head.append(script);
  });
  return loading;
}

const DISABLED = { enabled: false, getToken: async () => '', reset() {}, remove() {} };

// Turnstile error codes that mean "this site is set up wrong", not "try again".
// https://developers.cloudflare.com/turnstile/troubleshooting/client-side-errors/error-codes/
function describeError(code) {
  const c = String(code || '');
  if (c.startsWith('110200')) {
    return `The robot check isn't set up for this web address (${location.hostname}). ` +
      'The site owner needs to add it to the Turnstile widget’s hostnames in Cloudflare.';
  }
  if (c.startsWith('1101') || c.startsWith('400020')) {
    return 'The robot check is misconfigured (invalid site key). The site owner needs to check TURNSTILE_SITE_KEY in js/config.js.';
  }
  if (c.startsWith('600') || c.startsWith('300')) {
    return 'The robot check couldn’t confirm this browser. Try reloading the page, or turn off VPNs / strict privacy extensions for this site.';
  }
  return `The robot check ran into a problem (Cloudflare error ${c || 'unknown'}). Please reload the page and try again.`;
}

// Renders a widget into `container`. Call getToken() when submitting, and
// reset() afterwards — every token works only once.
export function mountTurnstile(container, { action }) {
  if (!SITE_KEY || !container) return DISABLED;

  const state = { token: '', widgetId: null, loadError: '', errorCode: '' };

  const ready = loadScript()
    .then((turnstile) => {
      if (!container.isConnected) return;
      state.widgetId = turnstile.render(container, {
        sitekey: SITE_KEY,
        action,
        theme: 'auto',
        appearance: 'interaction-only',
        callback: (token) => {
          state.token = token;
          state.errorCode = '';
        },
        'expired-callback': () => { state.token = ''; },
        'error-callback': (code) => {
          state.token = '';
          state.errorCode = String(code || 'unknown');
          console.warn(`[Clothing Closet] Turnstile error ${state.errorCode}: ${describeError(code)}`);
        },
      });
    })
    .catch((err) => { state.loadError = err.message; });

  return {
    enabled: true,
    async getToken(timeoutMs = 10000) {
      await ready;
      if (state.loadError) throw new Error(state.loadError);
      const started = Date.now();
      while (!state.token) {
        if (state.errorCode) throw new Error(describeError(state.errorCode));
        if (Date.now() - started > timeoutMs) {
          throw new Error('Please complete the “I’m not a robot” check, then try again.');
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return state.token;
    },
    reset() {
      state.token = '';
      if (state.widgetId != null) window.turnstile?.reset(state.widgetId);
    },
    remove() {
      if (state.widgetId != null) window.turnstile?.remove(state.widgetId);
      state.widgetId = null;
    },
  };
}
