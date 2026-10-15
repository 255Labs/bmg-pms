// QuickBooks Online (Intuit). Each property connects its own QuickBooks company with OAuth 2.0.
//   Sign-in page:  https://appcenter.intuit.com/connect/oauth2   scope com.intuit.quickbooks.accounting
//   Tokens:        POST https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer   (Basic client_id:client_secret, form body)
//                  access token ~1 hour; the refresh token changes as it is used, so the newest one is always saved
//   API:           https://quickbooks.api.intuit.com (or sandbox-quickbooks.api.intuit.com) /v3/company/{realm}/{entity}?minorversion=75
// Secrets: QBO_CLIENT_ID, QBO_CLIENT_SECRET, QBO_REDIRECT_URI (this function's /callback address), QBO_ENVIRONMENT (sandbox|production)
import { http, runJobs, secret } from './util.js';

export const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const API = { production: 'https://quickbooks.api.intuit.com', sandbox: 'https://sandbox-quickbooks.api.intuit.com' };
export const MINOR = 75;
const SCOPE = 'com.intuit.quickbooks.accounting';

const basic = (id, sec) => 'Basic ' + (typeof btoa === 'function' ? btoa(`${id}:${sec}`) : Buffer.from(`${id}:${sec}`).toString('base64'));
const settings = (env) => {
  const s = { clientId: secret(env, 'QBO_CLIENT_ID'), clientSecret: secret(env, 'QBO_CLIENT_SECRET'), redirectUri: secret(env, 'QBO_REDIRECT_URI'),
    environment: secret(env, 'QBO_ENVIRONMENT') === 'sandbox' ? 'sandbox' : 'production' };
  if (!s.clientId || !s.clientSecret || !s.redirectUri) throw new Error('QuickBooks is not set up on the server: QBO_CLIENT_ID, QBO_CLIENT_SECRET and QBO_REDIRECT_URI are needed');
  return s;
};

export function authorizeUrl(env, state) {
  const s = settings(env);
  const q = new URLSearchParams({ client_id: s.clientId, response_type: 'code', scope: SCOPE, redirect_uri: s.redirectUri, state });
  return `${AUTHORIZE_URL}?${q}`;
}

async function tokenCall(fetchFn, env, form) {
  const s = settings(env);
  const res = await http(fetchFn, TOKEN_URL, { method: 'POST', headers: { authorization: basic(s.clientId, s.clientSecret), accept: 'application/json' }, form });
  if (!res.ok || !res.body?.access_token) {
    const why = res.body?.error_description ?? res.body?.error ?? `HTTP ${res.status}`;
    const e = new Error(`QuickBooks sign-in failed: ${why}`); e.reconnect = res.body?.error === 'invalid_grant'; throw e;
  }
  const now = Date.now();
  return { access: res.body.access_token, refresh: res.body.refresh_token,
    accessExpires: new Date(now + (Number(res.body.expires_in ?? 3600) - 60) * 1000).toISOString(),
    refreshExpires: res.body.x_refresh_token_expires_in ? new Date(now + Number(res.body.x_refresh_token_expires_in) * 1000).toISOString() : null };
}
export const exchangeCode = (fetchFn, env, code) => tokenCall(fetchFn, env, { grant_type: 'authorization_code', code, redirect_uri: settings(env).redirectUri });
export const refreshTokens = (fetchFn, env, refresh) => tokenCall(fetchFn, env, { grant_type: 'refresh_token', refresh_token: refresh });

// A client for one connected company. Keeps the access token fresh and saves every new refresh token.
export function qboClient({ fetchFn, env, rpc, conn }) {
  const base = `${API[conn.environment] ?? API.production}/v3/company/${encodeURIComponent(conn.realm_id)}`;
  let access = conn.access_token, expires = conn.access_expires_at ? Date.parse(conn.access_expires_at) : 0;
  const ensure = async () => {
    if (access && expires - Date.now() > 120000) return access;
    try {
      const t = await refreshTokens(fetchFn, env, conn.refresh_token);
      await rpc('pms_svc_qbo_save', { p_property: conn.property_id, p_realm: conn.realm_id, p_env: conn.environment, p_access: t.access,
        p_access_expires: t.accessExpires, p_refresh: t.refresh, p_refresh_expires: t.refreshExpires, p_company: null, p_user: null });
      access = t.access; expires = Date.parse(t.accessExpires); conn.refresh_token = t.refresh ?? conn.refresh_token;
      return access;
    } catch (e) {
      if (e.reconnect) await rpc('pms_svc_qbo_broken', { p_property: conn.property_id, p_error: 'QuickBooks asked to be connected again' });
      throw e;
    }
  };
  const call = async (method, path, body) => {
    const url = `${base}/${path}${path.includes('?') ? '&' : '?'}minorversion=${MINOR}`;
    let res = await http(fetchFn, url, { method, headers: { authorization: `Bearer ${await ensure()}`, accept: 'application/json' }, json: body });
    if (res.status === 401) { expires = 0; res = await http(fetchFn, url, { method, headers: { authorization: `Bearer ${await ensure()}`, accept: 'application/json' }, json: body }); }
    return res;
  };
  return {
    call,
    query: (sql) => call('GET', `query?query=${encodeURIComponent(sql)}`),
    create: (entity, body) => call('POST', entity.toLowerCase(), body),
    remove: (entity, id, syncToken) => call('POST', `${entity.toLowerCase()}?operation=delete`, { Id: id, SyncToken: syncToken }),
  };
}

// QuickBooks errors come as { Fault: { Error: [ { Message, Detail, code } ] } }
export const fault = (res) => {
  const e = res.body?.Fault?.Error?.[0];
  return e ? `${e.Message}${e.Detail ? ': ' + e.Detail : ''}` : `HTTP ${res.status}`;
};
const faultCode = (res) => String(res.body?.Fault?.Error?.[0]?.code ?? '');
const need = (missing) => {
  if (missing?.length) throw new Error(`Map these accounts under Accounting first: ${missing.join(', ')}`);
};
const qstr = (s) => String(s).replace(/'/g, "\\'");

// ---------------------------------------------------------------------------------------------------------------
// Job handlers
// ---------------------------------------------------------------------------------------------------------------
export function handlers({ rpc, client, log = () => {} }) {
  const save = (job, entity, local, obj) => rpc('pms_svc_qbo_link', { p_property: job.property_id, p_entity: entity, p_local: String(local), p_qbo_id: obj?.Id ?? null, p_sync: obj?.SyncToken ?? null });
  const logCall = (job, action, res, request) => rpc('pms_svc_log', { p_property: job.property_id, p_provider: 'quickbooks', p_direction: 'out', p_action: action,
    p_ok: res.ok, p_status: res.status, p_request: request ?? null, p_response: res.ok ? null : res.body, p_error: res.ok ? null : fault(res) });

  return {
    vendor: async (job) => {
      const p = await rpc('pms_svc_qbo_payload', { p_job: job.id });
      const body = { DisplayName: p.name.slice(0, 100), CompanyName: p.name.slice(0, 100),
        ...(p.phone ? { PrimaryPhone: { FreeFormNumber: p.phone } } : {}), ...(p.email ? { PrimaryEmailAddr: { Address: p.email } } : {}),
        ...(p.address ? { BillAddr: { Line1: p.address.slice(0, 500) } } : {}), ...(p.tin ? { AcctNum: p.tin } : {}) };
      let res;
      if (p.qbo_id) res = await client.create('Vendor', { ...body, Id: p.qbo_id, SyncToken: p.sync_token, sparse: true });
      else {
        res = await client.create('Vendor', body);
        if (!res.ok && faultCode(res) === '6240') {           // the name is already in QuickBooks: link to it
          const found = await client.query(`select * from Vendor where DisplayName = '${qstr(body.DisplayName)}'`);
          const v = found.body?.QueryResponse?.Vendor?.[0];
          if (v) { await save(job, 'vendor', p.local_id, v); return { linked: v.Id }; }
        }
      }
      await logCall(job, 'vendor', res, { name: p.name });
      if (!res.ok) throw new Error(`QuickBooks refused the vendor: ${fault(res)}`);
      await save(job, 'vendor', p.local_id, res.body.Vendor);
      return { vendor: res.body.Vendor.Id };
    },

    bill: async (job) => {
      const p = await rpc('pms_svc_qbo_payload', { p_job: job.id });
      if (p.status === 'void') return { skipped: 'void' };
      need(p.missing);
      if (!p.vendor_qbo_id) { await rpc('pms_svc_qbo_need_vendor', { p_property: job.property_id, p_supplier: p.supplier_id }); throw new Error('Waiting for the supplier to reach QuickBooks first'); }
      const body = { VendorRef: { value: p.vendor_qbo_id }, TxnDate: p.txn_date, DueDate: p.due_date, DocNumber: p.doc_number, PrivateNote: p.note,
        GlobalTaxCalculation: 'NotApplicable',
        Line: p.lines.map((l) => ({ DetailType: 'AccountBasedExpenseLineDetail', Amount: Number(l.amount), Description: l.description,
          AccountBasedExpenseLineDetail: { AccountRef: { value: l.account } } })) };
      const res = await client.create('Bill', p.qbo_id ? { ...body, Id: p.qbo_id, SyncToken: p.sync_token } : body);
      await logCall(job, 'bill', res, { doc: p.doc_number, total: p.total });
      if (!res.ok) throw new Error(`QuickBooks refused the bill: ${fault(res)}`);
      await save(job, 'bill', p.local_id, res.body.Bill);
      return { bill: res.body.Bill.Id };
    },

    bill_void: async (job) => {
      const p = await rpc('pms_svc_qbo_payload', { p_job: job.id });
      if (!p.qbo_id) return { skipped: 'not in QuickBooks' };
      const res = await client.remove('Bill', p.qbo_id, p.sync_token);
      await logCall(job, 'bill_delete', res, { doc: p.doc_number });
      if (!res.ok) throw new Error(`QuickBooks refused to delete the bill: ${fault(res)}`);
      await save(job, 'bill', p.local_id, null);
      return { deleted: p.qbo_id };
    },

    bill_payment: async (job) => {
      const p = await rpc('pms_svc_qbo_payload', { p_job: job.id });
      if (p.qbo_id) return { skipped: 'already in QuickBooks' };
      need(p.missing);
      if (!p.bill_qbo_id) { await rpc('pms_svc_qbo_need_vendor', { p_property: job.property_id, p_supplier: p.supplier_id }); throw new Error('Waiting for the bill to reach QuickBooks first'); }
      const body = { VendorRef: { value: p.vendor_qbo_id }, PayType: 'Check', TotalAmt: Number(p.amount), TxnDate: p.txn_date,
        CheckPayment: { BankAccountRef: { value: p.bank_account } }, PrivateNote: p.reference ? `Ref ${p.reference}` : undefined,
        Line: [{ Amount: Number(p.amount), LinkedTxn: [{ TxnId: p.bill_qbo_id, TxnType: 'Bill' }] }] };
      const res = await client.create('BillPayment', body);
      await logCall(job, 'bill_payment', res, { amount: p.amount, reference: p.reference });
      if (!res.ok) throw new Error(`QuickBooks refused the payment: ${fault(res)}`);
      await save(job, 'bill_payment', p.local_id, res.body.BillPayment);
      return { payment: res.body.BillPayment.Id };
    },

    journal: async (job) => {
      const p = await rpc('pms_svc_qbo_payload', { p_job: job.id });
      if (!p.lines?.length) return { skipped: 'nothing happened that day' };
      need(p.missing);
      const body = { TxnDate: p.date, DocNumber: p.doc_number, PrivateNote: `BMG PMS daily summary for ${p.date}`,
        Line: p.lines.map((l) => ({ DetailType: 'JournalEntryLineDetail', Amount: Number(l.amount), Description: l.description,
          JournalEntryLineDetail: { PostingType: l.side, AccountRef: { value: l.account } } })) };
      const res = await client.create('JournalEntry', p.qbo_id ? { ...body, Id: p.qbo_id, SyncToken: p.sync_token } : body);
      await logCall(job, 'journal', res, { date: p.date, lines: p.lines.length });
      if (!res.ok) throw new Error(`QuickBooks refused the journal: ${fault(res)}`);
      await save(job, 'journal', p.local_id, res.body.JournalEntry);
      return { journal: res.body.JournalEntry.Id };
    },
  };
}

// One worker pass: every connected company, its queued jobs, with fresh tokens
export async function runQuickBooks({ rpc, fetchFn, env, log = () => {} }) {
  const conns = (await rpc('pms_svc_qbo_connections', {})) ?? [];
  const clients = Object.fromEntries(conns.map((c) => [c.property_id, qboClient({ fetchFn, env, rpc, conn: c })]));
  const route = (kind) => async (job) => {
    const client = clients[job.property_id];
    if (!client) throw new Error('QuickBooks is not connected for this property');
    return handlers({ rpc, client, log })[kind](job);
  };
  return runJobs({ rpc, provider: 'quickbooks', log, limit: 40,
    handlers: Object.fromEntries(['vendor', 'bill', 'bill_void', 'bill_payment', 'journal'].map((k) => [k, route(k)])) });
}

// The accounts in the property's QuickBooks, for the mapping screen
export async function listAccounts({ rpc, fetchFn, env, conn }) {
  const client = qboClient({ fetchFn, env, rpc, conn });
  const res = await client.query("select Id, Name, FullyQualifiedName, AccountType, AccountSubType, Active from Account where Active = true maxresults 1000");
  if (!res.ok) throw new Error(`QuickBooks: ${fault(res)}`);
  return (res.body?.QueryResponse?.Account ?? []).map((a) => ({ id: a.Id, name: a.FullyQualifiedName ?? a.Name, type: a.AccountType, subtype: a.AccountSubType }));
}

export async function companyName({ rpc, fetchFn, env, conn }) {
  const client = qboClient({ fetchFn, env, rpc, conn });
  const res = await client.call('GET', `companyinfo/${encodeURIComponent(conn.realm_id)}`);
  return res.ok ? res.body?.CompanyInfo?.CompanyName ?? null : null;
}
