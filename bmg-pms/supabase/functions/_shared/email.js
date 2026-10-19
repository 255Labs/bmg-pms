// Guest emails (portal links and login keys) through Resend (resend.com).
//   POST https://api.resend.com/emails   Authorization: Bearer <RESEND_API_KEY>
//   { from, to: [..], subject, text, reply_to }  →  { id }
// One BMG sending account serves every hotel: the hotel's name is shown as the sender and replies go to the
// hotel's own email. A hotel can use its own account with RESEND_API_KEY_<CODE> and EMAIL_FROM_<CODE>.
import { http, runJobs, secret } from './util.js';

export const RESEND_URL = 'https://api.resend.com/emails';

// "BMG Hotels <stay@bmggroup.co.tz>" + "Pwani Lodge" → "Pwani Lodge <stay@bmggroup.co.tz>"
export function fromLine(from, hotel) {
  const addr = (from ?? '').match(/<([^>]+)>/)?.[1] ?? (from ?? '').trim();
  if (!addr) return null;
  const name = (hotel ?? '').replace(/[<>"\r\n]/g, '').trim();
  return name ? `${name} <${addr}>` : addr;
}

export async function resendSend({ fetchFn, apiKey, from, to, subject, text, replyTo, url = RESEND_URL }) {
  if (!apiKey) throw new Error('RESEND_API_KEY is not set');
  if (!from) throw new Error('EMAIL_FROM is not set');
  return http(fetchFn, url, {
    method: 'POST', headers: { authorization: `Bearer ${apiKey}` },
    json: { from, to: [to], subject, text, ...(replyTo ? { reply_to: replyTo } : {}) },
  });
}

export async function runEmail({ rpc, fetchFn, env, log = () => {} }) {
  return runJobs({ rpc, provider: 'email', log, handlers: {
    send_email: async (job) => {
      const m = await rpc('pms_svc_email', { p_email: job.payload.email_id });
      if (!m || m.status === 'sent') return { skipped: m ? 'Already sent' : 'Email not found' };
      const code = m.property_code;
      const res = await resendSend({ fetchFn, apiKey: secret(env, 'RESEND_API_KEY', code), from: fromLine(secret(env, 'EMAIL_FROM', code), m.property_name),
        to: m.to_email, subject: m.subject, text: m.body, replyTo: m.reply_to || undefined });
      const ok = res.ok && !!res.body?.id;
      await rpc('pms_svc_log', { p_property: m.property_id, p_provider: 'email', p_direction: 'out', p_action: `email_${m.kind}`, p_ok: ok,
        p_status: res.status, p_request: { to: m.to_email.replace(/^(.).*@/, '$1***@'), subject: m.subject }, p_response: res.body,
        p_error: ok ? null : JSON.stringify(res.body).slice(0, 500) });
      if (ok) { await rpc('pms_svc_email_result', { p_email: m.id, p_ok: true, p_ref: String(res.body.id), p_error: null }); return { sent: m.id }; }
      const why = res.body?.message ?? `HTTP ${res.status}`;
      await rpc('pms_svc_email_result', { p_email: m.id, p_ok: false, p_ref: null, p_error: String(why) });
      throw new Error(`Email not sent: ${why}`);
    },
  } });
}
