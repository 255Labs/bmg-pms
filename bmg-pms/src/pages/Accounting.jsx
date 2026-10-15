import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { can, fmtDate, fmtDateTime, money } from '../lib/format';
import { Badge, Field, Loading, Modal, PageHead, Table, useAction, useToast } from '../components/ui.jsx';

// QuickBooks Online: connect the company, map our accounts to theirs, then the night audit sends each day's journal and
// procurement sends suppliers, bills and bill payments by itself. Tokens never reach the browser.
const BACK = { connected: ['QuickBooks is connected. Map the accounts below.', 'ok'], cancelled: ['QuickBooks sign-in was cancelled.', 'error'],
  expired: ['That sign-in link expired. Try connecting again.', 'error'], failed: ['QuickBooks could not be connected. Try again, or check the app settings.', 'error'] };
const KIND = { journal: 'Day journal', vendor: 'Supplier', bill: 'Supplier invoice', bill_void: 'Voided invoice', bill_payment: 'Supplier payment' };
const JOB = { queued: ['Waiting', 'amber'], running: ['Sending', 'blue'], done: ['Sent', 'teal'], failed: ['Failed', 'red'] };
const GROUP = { income: 'Income', expense: 'Expenses', asset: 'Money, stock and balances' };

const invoke = async (body) => {
  const { data, error } = await supabase.functions.invoke('quickbooks-oauth', { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error ?? msg; } catch { /* plain error */ }
    throw new Error(msg);
  }
  return data;
};

export default function Accounting({ params }) {
  const { property, role } = useProperty();
  const toast = useToast();
  const [run, busy] = useAction();
  const [s, setS] = useState(null);
  const [accounts, setAccounts] = useState(null);
  const [preview, setPreview] = useState(null);
  const [day, setDay] = useState('');
  const load = useCallback(() => rpc('pms_qbo_status', { p_property: property.id }).then(setS).catch((e) => setS({ error: e.message })), [property.id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const b = BACK[params?.qbo];
    if (b) { toast(b[0], b[1]); window.history.replaceState(null, '', '#/accounting'); }
  }, [params?.qbo, toast]);
  useEffect(() => {
    if (!s?.connected) return;
    invoke({ action: 'accounts', property_id: property.id }).then((r) => setAccounts(r.accounts ?? [])).catch(() => setAccounts([]));
  }, [s?.connected, property.id]);
  useEffect(() => { if (property.business_date && !day) setDay(prevDay(property.business_date)); }, [property.business_date, day]);

  const groups = useMemo(() => {
    const g = {};
    for (const a of s?.accounts ?? []) (g[a.kind] ??= []).push(a);
    return g;
  }, [s]);

  if (!can(role, 'acct.quickbooks')) return <><PageHead title="QuickBooks" /><p>Ask the owner for the QuickBooks ability.</p></>;
  if (!s) return <Loading />;
  if (s.error) return <><PageHead title="QuickBooks" /><p className="danger">{s.error}</p></>;
  const unmapped = (s.accounts ?? []).filter((a) => !a.qbo_id);
  const connect = () => run(() => invoke({ action: 'start', property_id: property.id })).then((r) => { if (r?.url) window.location.href = r.url; }).catch(() => {});

  return (
    <>
      <PageHead title="QuickBooks Online" sub="Each day's takings, payments and stock costs go to QuickBooks as one journal after the night audit. Suppliers, their invoices and payments go as they happen.">
        {s.connected ? <button className="btn btn-danger-ghost" disabled={busy} onClick={() => window.confirm('Disconnect QuickBooks? Nothing more is sent until you connect again.') && run(() => rpc('pms_qbo_disconnect', { p_property: property.id }), 'Disconnected').then(load).catch(() => {})}>Disconnect</button>
          : <button className="btn btn-primary" disabled={busy} onClick={connect}>{s.status === 'broken' ? 'Reconnect QuickBooks' : 'Connect QuickBooks'}</button>}
      </PageHead>

      <dl className="today-stats">
        <div><dt>Connection</dt><dd>{s.connected ? <Badge kind="teal">Connected</Badge> : s.status === 'broken' ? <Badge kind="red">Needs reconnecting</Badge> : <Badge kind="grey">Not connected</Badge>}</dd></div>
        <div><dt>Company</dt><dd>{s.company ?? '—'}{s.environment === 'sandbox' && <span className="small muted"> (sandbox)</span>}</dd></div>
        <div><dt>Waiting to send</dt><dd>{s.jobs?.queued ?? 0}</dd></div>
        <div><dt>Failed</dt><dd className={s.jobs?.failed ? 'danger' : ''}>{s.jobs?.failed ?? 0}</dd></div>
      </dl>
      {s.last_error && <p className="note danger">QuickBooks said: {s.last_error}</p>}
      {!s.connected && s.status !== 'broken' && (
        <div className="card">
          <h4 className="first">Before you connect</h4>
          <ol className="small">
            <li>Sign in with a QuickBooks user who is an admin of the company.</li>
            <li>After connecting, match each line below to an account in your chart of accounts. Days are only sent once every account they use is matched.</li>
            <li>Choose the first day to send, so days already entered by hand in QuickBooks are not sent twice.</li>
          </ol>
        </div>
      )}

      <h3>Settings</h3>
      <div className="grid-3">
        <Field label="Send automatically" hint="After each night audit, and as supplier documents are saved">
          <select value={s.auto ? 'yes' : 'no'} onChange={(e) => run(() => rpc('pms_qbo_settings', { p_property: property.id, p_auto: e.target.value === 'yes', p_start_date: s.start_date || null }), 'Saved').then(load).catch(() => {})}>
            <option value="yes">Yes</option><option value="no">No, only when I send a day</option></select>
        </Field>
        <Field label="First day to send" hint="Earlier days are never sent">
          <input type="date" value={s.start_date ?? ''} onChange={(e) => run(() => rpc('pms_qbo_settings', { p_property: property.id, p_auto: s.auto, p_start_date: e.target.value || null }), 'Saved').then(load).catch(() => {})} />
        </Field>
      </div>

      <h3>Accounts {unmapped.length > 0 && <Badge kind="amber">{unmapped.length} not matched</Badge>}</h3>
      {!s.connected ? <p className="small muted">Connect first to choose from your QuickBooks chart of accounts.</p> : accounts === null ? <Loading /> : (
        Object.entries(GROUP).filter(([k]) => groups[k]).map(([k, title]) => (
          <div key={k} className="card" style={{ marginBottom: 12 }}>
            <h4 className="first">{title}</h4>
            <div className="qbo-map">
              {groups[k].map((a) => (
                <label key={a.key} className="qbo-row">
                  <span>{a.label}<span className="small muted"> · {a.used_for}</span></span>
                  <select value={a.qbo_id ?? ''} className={a.qbo_id ? '' : 'missing'} disabled={busy} onChange={(e) => {
                    const acc = accounts.find((x) => x.id === e.target.value);
                    run(() => rpc('pms_qbo_set_mapping', { p_property: property.id, p_key: a.key, p_qbo_id: acc?.id ?? null, p_qbo_name: acc?.name ?? null })).then(load).catch(() => {});
                  }}>
                    <option value="">Not matched</option>
                    {a.qbo_id && !accounts.some((x) => x.id === a.qbo_id) && <option value={a.qbo_id}>{a.qbo_name}</option>}
                    {accounts.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.type})</option>)}
                  </select>
                </label>
              ))}
            </div>
          </div>
        ))
      )}

      <h3>Send or check a day</h3>
      <div className="row-gap">
        <input type="date" className="auto" value={day} onChange={(e) => setDay(e.target.value)} aria-label="Day" />
        <button className="btn" disabled={busy || !day} onClick={() => run(() => rpc('pms_qbo_preview_day', { p_property: property.id, p_date: day })).then(setPreview).catch(() => {})}>Preview journal</button>
        {s.connected && <button className="btn btn-primary" disabled={busy || !day} onClick={() => run(() => rpc('pms_qbo_send_day', { p_property: property.id, p_date: day }), `${fmtDate(day)} queued for QuickBooks`).then(load).catch(() => {})}>Send this day</button>}
      </div>

      <h3>Recently sent {s.jobs?.failed > 0 && <button className="btn btn-small" disabled={busy} onClick={() => run(() => rpc('pms_qbo_retry', { p_property: property.id })).then((n) => { toast(`${n} queued again`); load(); }).catch(() => {})}>Retry failed</button>}</h3>
      <Table rows={s.recent ?? []} empty="Nothing sent yet." columns={[
        { key: 'at', label: 'When', render: (j) => fmtDateTime(j.at) },
        { key: 'kind', label: 'What', render: (j) => <>{KIND[j.kind] ?? j.kind}{j.payload?.date && <span className="small muted"> · {fmtDate(j.payload.date)}</span>}</> },
        { key: 'status', label: '', render: (j) => <Badge kind={(JOB[j.status] ?? ['', 'grey'])[1]}>{(JOB[j.status] ?? [j.status])[0]}</Badge> },
        { key: 'error', label: 'Detail', render: (j) => <span className="small">{j.error}</span> },
      ]} />

      {preview && (
        <Modal title={`Journal ${preview.doc_number}`} wide onClose={() => setPreview(null)} footer={<button className="btn" onClick={() => setPreview(null)}>Close</button>}>
          {preview.missing?.length > 0 && <p className="note danger">Not matched yet: {preview.missing.map((m) => (s.accounts.find((a) => a.key === m)?.label ?? m)).join(', ')}. This day cannot be sent until they are.</p>}
          {preview.lines.length === 0 ? <p className="muted">Nothing happened on this day.</p> : (
            <table className="table"><thead><tr><th>Line</th><th>QuickBooks account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
              <tbody>{preview.lines.map((l, i) => <tr key={i}><td>{l.description}</td><td className={l.account ? '' : 'danger'}>{s.accounts.find((a) => a.key === l.key)?.qbo_name ?? 'Not matched'}</td>
                <td className="num">{l.side === 'Debit' ? money(l.amount) : ''}</td><td className="num">{l.side === 'Credit' ? money(l.amount) : ''}</td></tr>)}</tbody>
              <tfoot><tr><td colSpan={2}><strong>Totals</strong></td>
                <td className="num"><strong>{money(preview.lines.filter((l) => l.side === 'Debit').reduce((n, l) => n + Number(l.amount), 0))}</strong></td>
                <td className="num"><strong>{money(preview.lines.filter((l) => l.side === 'Credit').reduce((n, l) => n + Number(l.amount), 0))}</strong></td></tr></tfoot></table>
          )}
        </Modal>
      )}
    </>
  );
}

function prevDay(d) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() - 1);
  return x.toISOString().slice(0, 10);
}
