// Guest SMS through Beem Africa (beem.africa).
//   POST https://apisms.beem.africa/v1/send   Basic auth api_key:secret_key
//   { source_addr, schedule_time: '', encoding: 0, message, recipients: [{ recipient_id, dest_addr }] }
//   → { successful: true, request_id, code: 100, message: 'Message Submitted Successfully', valid, invalid, duplicates }
import { http, runJobs, secret } from './util.js';

export const BEEM_URL = 'https://apisms.beem.africa/v1/send';
const b64 = (s) => (typeof btoa === 'function' ? btoa(s) : Buffer.from(s).toString('base64'));

export async function beemSend({ fetchFn, apiKey, secretKey, senderId = 'INFO', to, message, url = BEEM_URL }) {
  if (!apiKey || !secretKey) throw new Error('BEEM_API_KEY and BEEM_SECRET_KEY are not set');
  return http(fetchFn, url, {
    method: 'POST', headers: { authorization: `Basic ${b64(`${apiKey}:${secretKey}`)}` },
    json: { source_addr: senderId, schedule_time: '', encoding: 0, message, recipients: [{ recipient_id: 1, dest_addr: to }] },
  });
}

export async function runSms({ rpc, fetchFn, env, log = () => {} }) {
  const props = await rpc('pms_svc_enabled', { p_provider: 'sms' });
  const cfgOf = (id) => props.find((p) => p.property_id === id)?.config ?? {};
  return runJobs({ rpc, provider: 'sms', log, handlers: {
    send_sms: async (job) => {
      const m = await rpc('pms_svc_sms', { p_sms: job.payload.sms_id });
      if (!m || m.status === 'sent') return { skipped: m ? 'Already sent' : 'Message not found' };
      const cfg = cfgOf(m.property_id);
      const res = await beemSend({ fetchFn, apiKey: secret(env, 'BEEM_API_KEY', cfg.code), secretKey: secret(env, 'BEEM_SECRET_KEY', cfg.code),
        senderId: cfg.sender_id || 'INFO', to: m.to_phone, message: m.body });
      const ok = res.ok && res.body?.successful !== false && (res.body?.valid ?? 1) > 0;
      await rpc('pms_svc_log', { p_property: m.property_id, p_provider: 'sms', p_direction: 'out', p_action: `sms_${m.kind}`, p_ok: ok,
        p_status: res.status, p_request: { to: m.to_phone.replace(/\d{4}$/, '****'), length: m.body.length }, p_response: res.body,
        p_error: ok ? null : JSON.stringify(res.body).slice(0, 500) });
      if (ok) { await rpc('pms_svc_sms_result', { p_sms: m.id, p_ok: true, p_ref: res.body?.request_id != null ? String(res.body.request_id) : null, p_error: null }); return { sent: m.id }; }
      const why = res.body?.message ?? `HTTP ${res.status}`;
      await rpc('pms_svc_sms_result', { p_sms: m.id, p_ok: false, p_ref: null, p_error: String(why) });
      throw new Error(`SMS not sent: ${why}`);
    },
  } });
}
