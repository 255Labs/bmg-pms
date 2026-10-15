import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const configured = Boolean(url && key);
export const supabase = configured ? createClient(url, key) : null;

// Call a database function and throw a readable error
export async function rpc(fn, args = {}) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(cleanError(error.message));
  return data;
}

// Select helper that throws on error
export async function select(table, build) {
  let query = supabase.from(table).select(build?.columns ?? '*');
  if (build?.where) query = build.where(query);
  const { data, error } = await query;
  if (error) throw new Error(cleanError(error.message));
  return data;
}

export function cleanError(msg = '') {
  return msg.replace(/^.*?ERROR:\s*/, '').replace(/^P0001:\s*/, '');
}
