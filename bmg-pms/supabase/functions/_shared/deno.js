// Deno-only glue for the Edge Functions: service-role client and request guards.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { sameSecret } from './util.js';

export const env = Deno.env.toObject();

const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

export async function rpc(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
}

// Scheduled workers must be called with the CRON_SECRET header (pg_cron sends it)
export function cronAllowed(req) {
  return sameSecret(req.headers.get('x-cron-secret') ?? '', env.CRON_SECRET ?? '');
}
