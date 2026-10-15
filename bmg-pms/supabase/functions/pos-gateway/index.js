// Tenda ICO (and other POS) gateway. Routes and rules: ../_shared/posgateway.js
// Prefer calling this server-to-server (from Tenda ICO's own Edge Function) so the key never sits in a browser.
// For a direct browser call, list the allowed origins in POS_ALLOWED_ORIGINS (comma-separated).
import { env, rpc } from '../_shared/deno.js';
import { handlePosRequest } from '../_shared/posgateway.js';

const allowed = (env.POS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const cors = (origin) => (origin && allowed.includes(origin) ? {
  'access-control-allow-origin': origin, 'vary': 'origin',
  'access-control-allow-headers': 'authorization, x-api-key, content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS',
} : {});

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/pos-gateway/, '') || '/';
  let body = null;
  if (req.method === 'POST') {
    try { body = await req.json(); } catch { return respond(400, { error: 'Body must be JSON' }, origin); }
  }
  try {
    const out = await handlePosRequest({ method: req.method, path, query: Object.fromEntries(url.searchParams), headers: req.headers, body, rpc });
    return respond(out.status, out.body, origin);
  } catch (e) {
    console.error(e);
    return respond(500, { error: 'Server error' }, origin);
  }
});

function respond(status, data, origin) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...cors(origin) } });
}
