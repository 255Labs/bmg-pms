// TRA fiscal receipts (VFD). Tanzanian VFD providers each expose their own API, so the
// request is built from a template in the property's fiscal settings and sent to the
// provider URL with the provider key from Edge Function secrets.
import { http, runJobs, secret } from './util.js';

// Replace {{path.to.value}} in a JSON template with values from the receipt context
export function fill(template, ctx) {
  const get = (path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
  const walk = (v) => {
    if (typeof v === 'string') {
      const whole = v.match(/^{{\s*([\w.]+)\s*}}$/);
      if (whole) return get(whole[1]);
      return v.replace(/{{\s*([\w.]+)\s*}}/g, (_, p) => String(get(p) ?? ''));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(template);
}

// Default request shape; providers differ, so set `request_template` in fiscal settings to match yours
export const DEFAULT_TEMPLATE = {
  tin: '{{tin}}', vrn: '{{vrn}}', reference: '{{reference}}', customer: '{{customer}}', currency: '{{currency}}',
  total: '{{amount}}', tax_rate: '{{tax_rate}}', payment_method: '{{method}}', items: '{{items}}',
};

export const pick = (obj, path) => (path ? path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj) : undefined);

// The VFD key is only ever sent over https to a host listed in VFD_ALLOWED_HOSTS (comma-separated)
export function vfdTarget(url, env) {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error('The VFD endpoint is not a valid URL'); }
  if (u.protocol !== 'https:') throw new Error('The VFD endpoint must use https');
  const allowed = String(env.VFD_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (!allowed.length) throw new Error('Set VFD_ALLOWED_HOSTS to your VFD provider\'s host name before sending receipts');
  if (!allowed.includes(u.hostname.toLowerCase())) throw new Error(`${u.hostname} is not in VFD_ALLOWED_HOSTS`);
  return u.toString();
}

export async function issueReceipt({ rpc, fetchFn, env, job, configFor }) {
  const ctx = await rpc('pms_svc_fiscal_context', { p_receipt: job.payload.receipt_id });
  if (!ctx) return { skipped: 'Receipt not found' };
  if (ctx.status === 'issued' || ctx.status === 'manual') return { skipped: `Already ${ctx.status}` };
  const cfg = configFor(ctx.property_id) ?? {};
  if (!cfg.url) throw new Error('No VFD provider URL in fiscal settings');
  const target = vfdTarget(cfg.url, env);
  const key = secret(env, 'VFD_API_KEY', cfg.code);
  const header = String(cfg.key_header ?? 'authorization');
  if (!/^[A-Za-z][A-Za-z0-9-]{0,39}$/.test(header) || /^(host|cookie|content-length|transfer-encoding)$/i.test(header)) throw new Error('Invalid key header name');
  const body = fill(cfg.request_template ?? DEFAULT_TEMPLATE, ctx);
  const res = await http(fetchFn, target, { method: 'POST', json: body, headers: key ? { [header]: cfg.key_prefix ? `${cfg.key_prefix} ${key}` : key } : {} });
  await rpc('pms_svc_log', { p_property: ctx.property_id, p_provider: 'fiscal', p_direction: 'out', p_action: 'issue_receipt', p_ok: res.ok,
    p_status: res.status, p_request: { reference: ctx.reference, amount: ctx.amount }, p_response: res.body, p_error: res.ok ? null : JSON.stringify(res.body).slice(0, 500) });
  const map = cfg.response_map ?? { receipt_no: 'receipt_number', verification_code: 'verification_code', verify_url: 'verification_url' };
  const receiptNo = pick(res.body, map.receipt_no);
  if (!res.ok || !receiptNo) {
    const err = res.ok ? 'Provider reply had no receipt number' : `VFD HTTP ${res.status}`;
    await rpc('pms_svc_fiscal_result', { p_receipt: ctx.receipt_id, p_ok: false, p_receipt_no: null, p_vcode: null, p_url: null, p_error: err, p_raw: res.body });
    throw new Error(err);
  }
  await rpc('pms_svc_fiscal_result', { p_receipt: ctx.receipt_id, p_ok: true, p_receipt_no: String(receiptNo),
    p_vcode: pick(res.body, map.verification_code) ?? null, p_url: pick(res.body, map.verify_url) ?? null, p_error: null, p_raw: res.body });
  return { receipt_no: receiptNo };
}

export async function runFiscal({ rpc, fetchFn, env, log = () => {} }) {
  const props = await rpc('pms_svc_enabled', { p_provider: 'fiscal' });
  const configFor = (id) => props.find((p) => p.property_id === id)?.config;
  return runJobs({ rpc, provider: 'fiscal', log, handlers: { issue_receipt: (job) => issueReceipt({ rpc, fetchFn, env, job, configFor }) } });
}
