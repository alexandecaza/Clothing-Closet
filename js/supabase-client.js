// Loads the Supabase JS client straight from a CDN — no build step needed.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export function makeClient({ persistSession }) {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession,
      autoRefreshToken: persistSession,
      detectSessionInUrl: persistSession,
    },
  });
}
