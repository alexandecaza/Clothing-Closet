// Connection details for Supabase and Cloudflare Turnstile.
// All of these are designed to be public: every visitor's browser needs them,
// and the security rules in supabase/schema.sql decide what they can do.
// Never put the "service_role" / secret key, or the Turnstile SECRET key, here.

// The live site (README → steps 4 and 9).
const LIVE = {
  SUPABASE_URL: 'https://fpvngrvybuglwxktwaej.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_lRw05_M2hposidaZLBGMBg_5Qd8pNM3',
  TURNSTILE_SITE_KEY: '0x4AAAAAAFBcY6G8UIm8nbSS',
};

// Optional: a separate Supabase project for testing on your own computer
// (README → "Testing changes locally"). When the site runs on localhost and
// this is filled in, it uses the test project, so live data is never touched.
const LOCAL_TEST = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
  // Cloudflare's official test key: always passes, works on localhost.
  TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
};

const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
const config = isLocal && LOCAL_TEST.SUPABASE_URL ? LOCAL_TEST : LIVE;

if (isLocal) {
  console.info(`[Clothing Closet] Using the ${config === LIVE ? 'LIVE' : 'local test'} database.`);
}

export const SUPABASE_URL = config.SUPABASE_URL;
export const SUPABASE_ANON_KEY = config.SUPABASE_ANON_KEY;
export const TURNSTILE_SITE_KEY = config.TURNSTILE_SITE_KEY;
export const USING_LIVE_DATA_LOCALLY = isLocal && config === LIVE;
