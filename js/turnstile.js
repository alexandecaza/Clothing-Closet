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

// Renders a widget into `container`. Call getToken() when submitting, and
// reset() afterwards — every token works only once.
export function mountTurnstile(container, { action }) {
  if (!SITE_KEY || !container) return DISABLED;

  const state = { token: '', widgetId: null, loadError: '' };

  const ready = loadScript()
    .then((turnstile) => {
      if (!container.isConnected) return;
      state.widgetId = turnstile.render(container, {
        sitekey: SITE_KEY,
        action,
        theme: 'auto',
        appearance: 'interaction-only',
        callback: (token) => { state.token = token; },
        'expired-callback': () => { state.token = ''; },
        'error-callback': () => { state.token = ''; },
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
