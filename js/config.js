// Your Supabase project's connection details (README → step 4).
// Both values are designed to be public: every visitor's browser needs them,
// and the security rules in supabase/schema.sql decide what they can do.
// Never put the "service_role" / secret key here.

export const SUPABASE_URL = 'https://fpvngrvybuglwxktwaej.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_lRw05_M2hposidaZLBGMBg_5Qd8pNM3';

// Cloudflare Turnstile "site key" for the robot check (README → step 9).
// Public by design. The matching SECRET key goes in Supabase, never here.
export const TURNSTILE_SITE_KEY = '0x4AAAAAAFBcY6G8UIm8nbSS';
