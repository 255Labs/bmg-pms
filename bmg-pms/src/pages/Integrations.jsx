import { useCallback, useEffect, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { useDesk } from '../lib/desk';
import { can, fmtDateTime, label, money } from '../lib/format';
import { Badge, Field, PageHead, Table, Tabs, useAction } from '../components/ui.jsx';

const SERVICE = { channex: 'Channex', ttlock: 'TTLock', hikvision: 'Hikvision', fiscal: 'Fiscal receipts', tendaico: 'Tenda ICO', clickpesa: 'Mobile money', sms: 'SMS' };
const TASK = {
  ari_push: 'Send availability and rates', pull_bookings: 'Fetch channel bookings',
  issue_passcode: 'Give guest a door code', revoke_passcode: 'Remove guest door code', extend_passcode: 'Extend guest door code',
  issue_receipt: 'Issue fiscal receipt', ussd_push: 'Send payment request to phone', send_sms: 'Send SMS',
};

const PROVIDERS = {
  channex: { name: 'Channex', what: 'Sends availability and rates to Booking.com, Expedia, Airbnb and others; brings their bookings in as reservations.',
    secrets: ['CHANNEX_API_KEY', 'CHANNEX_BASE_URL (production URL from Channex)', 'CHANNEX_WEBHOOK_TOKEN'] },
  ttlock: { name: 'TTLock door locks', what: 'Gives each guest a door passcode at check-in, removes it at check-out, and records every door opening.',
    secrets: ['TTLOCK_CLIENT_ID', 'TTLOCK_CLIENT_SECRET', 'TTLOCK_USERNAME', 'TTLOCK_PASSWORD'] },
  hikvision: { name: 'Hikvision cameras', what: 'Motion and line-crossing events from the NVR, sent by the on-site relay, matched to rooms.',
    secrets: ['HIKVISION_RELAY_KEY'] },
  fiscal: { name: 'TRA fiscal receipts (VFD)', what: 'Issues a fiscal receipt from your VFD provider for every payment and walk-in POS bill.',
    secrets: ['VFD_API_KEY'] },
  clickpesa: { name: 'Mobile money (ClickPesa)', what: 'The desk sends a payment request to the guest’s phone; when they enter their PIN the payment lands on the folio by itself.',
    secrets: ['CLICKPESA_CLIENT_ID', 'CLICKPESA_API_KEY', 'CLICKPESA_CHECKSUM_KEY (only if checksums are on in your ClickPesa account)', 'CLICKPESA_WEBHOOK_TOKEN', 'CLICKPESA_BASE_URL (https://api-sandbox.clickpesa.com while testing)'] },
  sms: { name: 'Guest SMS (Beem)', what: 'Texts each guest their door code when it is issued, and lets the desk send short messages.',
    secrets: ['BEEM_API_KEY', 'BEEM_SECRET_KEY'] },
  tendaico: { name: 'Tenda ICO POS', what: 'Restaurant and bar tills on Tenda ICO charge bills straight to an in-house guest’s room folio.',
    secrets: ['POS_ALLOWED_ORIGINS (only for direct browser calls; leave unset when Tenda ICO uses its pms-proxy)'] },
};
const HEALTH = { ok: ['Working', 'teal'], warning: ['Check', 'amber'], error: ['Needs attention', 'red'], off: ['Off', 'grey'] };

export default function Integrations({ params }) {
  const { property, role } = useProperty();
  const [tab, setTab] = useState(params?.tab ?? 'overview');
  const [rows, setRows] = useState([]);
  const load = useCallback(() => supabase.from('pms_integrations').select('*').eq('property_id', property.id).then(({ data }) => setRows(data ?? [])), [property.id]);
  useEffect(() => { load(); }, [load]);
  if (!can(role, 'integrations')) return <><PageHead title="Integrations" /><p>Only owners and managers can manage integrations.</p></>;
  const cfg = (p) => rows.find((r) => r.provider === p) ?? { provider: p, enabled: false, config: {} };
  return (
    <>
      <PageHead title="Integrations" sub="Channel manager, door locks, cameras, fiscal receipts, Tenda ICO, mobile money and SMS. Passwords live in Supabase secrets, never on this screen." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'overview', label: 'Overview' }, { value: 'channex', label: 'Channex' }, { value: 'ttlock', label: 'TTLock' },
        { value: 'hikvision', label: 'Hikvision' }, { value: 'fiscal', label: 'Fiscal receipts' }, { value: 'tendaico', label: 'Tenda ICO' }, { value: 'clickpesa', label: 'Mobile money' }, { value: 'sms', label: 'SMS' }, { value: 'activity', label: 'Activity' }]} />
      {tab === 'overview' && <Overview go={setTab} />}
      {tab === 'channex' && <Channex row={cfg('channex')} reload={load} />}
      {tab === 'ttlock' && <TTLock row={cfg('ttlock')} reload={load} />}
      {tab === 'hikvision' && <Hikvision row={cfg('hikvision')} reload={load} />}
      {tab === 'fiscal' && <Fiscal row={cfg('fiscal')} reload={load} />}
      {tab === 'tendaico' && <TendaIco />}
      {tab === 'clickpesa' && <ClickPesa row={cfg('clickpesa')} reload={load} />}
      {tab === 'sms' && <Sms row={cfg('sms')} reload={load} />}
      {tab === 'activity' && <Activity />}
    </>
  );
}

function Overview({ go }) {
  const { property } = useProperty();
  const [health, setHealth] = useState(null);
  useEffect(() => { rpc('pms_integration_health', { p_property: property.id }).then(setHealth).catch(() => setHealth([])); }, [property.id]);
  if (!health) return null;
  return (
    <div className="int-grid">
      {health.map((h) => {
        const p = PROVIDERS[h.provider];
        if (!p) return null;
        const [word, kind] = HEALTH[h.status] ?? HEALTH.off;
        return (
          <div key={h.provider} className="card int-card">
            <div className="int-card-head"><h3 className="first">{p.name}</h3><Badge kind={kind}>{word}</Badge></div>
            <p className="muted small">{p.what}</p>
            {h.detail && <p className={`small ${h.status === 'error' ? 'danger' : ''}`}>{h.detail}</p>}
            <dl className="facts small">
              <dt>Last worked</dt><dd>{h.last_ok_at ? fmtDateTime(h.last_ok_at) : '—'}</dd>
              <dt>Waiting</dt><dd>{h.queued_jobs} {h.queued_jobs === 1 ? 'task' : 'tasks'}</dd>
              <dt>Failed</dt><dd className={h.failed_jobs ? 'danger' : ''}>{h.failed_jobs} {h.failed_jobs === 1 ? 'task' : 'tasks'}</dd>
            </dl>
            <button className="btn" onClick={() => go(h.provider)}>Settings</button>
          </div>
        );
      })}
    </div>
  );
}

const REQ = { queued: ['Sending', 'blue'], sent: ['Waiting for guest', 'amber'], paid: ['Paid', 'teal'], failed: ['Not paid', 'red'], expired: ['No answer', 'grey'], cancelled: ['Cancelled', 'grey'] };

function ClickPesa({ row, reload }) {
  const { property } = useProperty();
  const desk = useDesk();
  const [rows, setRows] = useState(null);
  useEffect(() => {
    supabase.from('pms_payment_requests').select('*, pms_folios(folio_no, reservation_id)').eq('property_id', property.id).order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => setRows(data ?? []));
  }, [property.id]);
  const hook = `${import.meta.env.VITE_SUPABASE_URL ?? 'https://<project>.supabase.co'}/functions/v1/clickpesa-webhook?token=<CLICKPESA_WEBHOOK_TOKEN>`;
  return (
    <>
      <Settings row={row} provider="clickpesa" reload={reload} fields={[{ key: 'code', label: 'Secrets suffix (optional)', placeholder: property.code ?? '', hint: 'Only if this property has its own ClickPesa account' }]}>
        <p className="small muted">Webhook URL for ClickPesa (Dashboard → Settings → Webhooks): <code className="wrap">{hook}</code></p>
        <p className="small muted">Payments are confirmed by asking ClickPesa directly, every minute and whenever the webhook fires, so a payment is never posted on a webhook’s word alone. Requests with no answer stop after 30 minutes.</p>
      </Settings>
      <h3>Recent requests</h3>
      <Table rows={rows} empty="No requests yet. Send one from a folio: Add payment → Send request to guest’s phone." columns={[
        { key: 'created_at', label: 'Sent', render: (r) => fmtDateTime(r.created_at) },
        { key: 'folio', label: 'Folio', render: (r) => <button className="link" onClick={() => desk.openReservation(r.pms_folios?.reservation_id)}>#{r.pms_folios?.folio_no}</button> },
        { key: 'phone', label: 'Phone', render: (r) => r.phone.replace(/^255(\d{3})(\d{3})(\d{3})$/, '0$1 $2 $3') },
        { key: 'amount', label: 'Amount', num: true, render: (r) => money(r.amount) },
        { key: 'status', label: 'Status', render: (r) => <Badge kind={REQ[r.status]?.[1]}>{REQ[r.status]?.[0] ?? r.status}</Badge> },
        { key: 'error', label: '', render: (r) => <span className="small muted">{r.error ?? r.note}</span> },
      ]} />
    </>
  );
}

function Sms({ row, reload }) {
  const { property } = useProperty();
  const [run, busy] = useAction();
  const [rows, setRows] = useState(null);
  const [test, setTest] = useState({ phone: '', body: '' });
  const load = useCallback(() => supabase.from('pms_sms_out').select('*').eq('property_id', property.id).order('created_at', { ascending: false }).limit(50)
    .then(({ data }) => setRows(data ?? [])), [property.id]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <Settings row={row} provider="sms" reload={reload} fields={[
        { key: 'sender_id', label: 'Sender name', placeholder: 'INFO', hint: 'Registered with Beem, up to 11 letters (e.g. UNREALHOMES). Until approved, use INFO.' },
        { key: 'send_door_codes', label: 'Text door codes at check-in', type: 'yesno', hint: 'On unless switched off here.' },
        { key: 'door_code_template', label: 'Door code message', placeholder: 'Karibu {guest}! Your door code for room {room} at {property} is {code}. It works until {until}.', hint: 'Use {guest}, {room}, {property}, {code} and {until}.' },
        { key: 'code', label: 'Secrets suffix (optional)', placeholder: property.code ?? '' },
      ]} />
      <h3>Send a message</h3>
      <form className="card inline-form" onSubmit={(e) => { e.preventDefault(); run(() => rpc('pms_send_sms', { p_property: property.id, p_phone: test.phone, p_body: test.body, p_stay: null }), 'Message queued; it goes out within a minute').then(() => { setTest({ phone: '', body: '' }); load(); }).catch(() => {}); }}>
        <Field label="Mobile number"><input required inputMode="tel" value={test.phone} onChange={(e) => setTest({ ...test, phone: e.target.value })} placeholder="0713 000 111" /></Field>
        <Field label="Message" hint={`${test.body.length} of 160 characters for one SMS`}><input required maxLength={640} value={test.body} onChange={(e) => setTest({ ...test, body: e.target.value })} /></Field>
        <button className="btn btn-primary" disabled={busy || !row.enabled}>Send</button>
      </form>
      <h3>Messages sent</h3>
      <Table rows={rows} empty="No messages yet." columns={[
        { key: 'created_at', label: 'When', render: (m) => fmtDateTime(m.created_at) },
        { key: 'kind', label: 'What', render: (m) => (m.kind === 'door_code' ? 'Door code' : 'Message') },
        { key: 'to_phone', label: 'To', render: (m) => m.to_phone.replace(/^255(\d{3})(\d{3})(\d{3})$/, '0$1 $2 $3') },
        { key: 'body', label: 'Text', render: (m) => <span className="small">{m.kind === 'door_code' ? m.body.replace(/\b\d{4,9}\b/g, '••••••') : m.body}</span> },
        { key: 'status', label: 'Status', render: (m) => <Badge kind={m.status === 'sent' ? 'teal' : m.status === 'failed' ? 'red' : 'blue'}>{m.status === 'sent' ? 'Sent' : m.status === 'failed' ? 'Failed, retrying' : 'Queued'}</Badge> },
      ]} />
    </>
  );
}

// Keys for machines that call the PMS (Tenda ICO tills, camera relays). Only a hash is stored.
function ApiKeys({ provider, title, intro, nameLabel, placeholder, revokeWarning, children }) {
  const { property } = useProperty();
  const [run, busy] = useAction();
  const [keys, setKeys] = useState(null);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState(null);
  const load = useCallback(async () => {
    const { data } = await supabase.from('pms_api_keys').select('id, name, prefix, created_at, last_used_at, revoked_at')
      .eq('property_id', property.id).eq('provider', provider).order('created_at', { ascending: false });
    setKeys(data ?? []);
  }, [property.id, provider]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <div className="card">
        <h3 className="first">{title}</h3>
        <p className="muted">{intro}</p>
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); run(async () => { const r = await rpc('pms_create_api_key', { p_property: property.id, p_name: name, p_provider: provider }); setFresh(r); setName(''); await load(); }, 'Key created').catch(() => {}); }}>
          <Field label={nameLabel}><input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} /></Field>
          <button className="btn btn-primary" disabled={busy}>Create key</button>
        </form>
        {fresh && (
          <div className="note">
            <strong>Copy this key now. It will not be shown again.</strong>
            <div className="row-gap" style={{ marginTop: 8 }}><code className="wrap">{fresh.key}</code>
              <button className="btn btn-small" onClick={() => navigator.clipboard?.writeText(fresh.key)}>Copy</button>
              <button className="btn btn-small" onClick={() => setFresh(null)}>Done</button></div>
          </div>
        )}
        {children}
      </div>
      <Table rows={keys} empty="No keys yet" columns={[
        { key: 'name', label: nameLabel },
        { key: 'prefix', label: 'Key starts', render: (k) => <code>{k.prefix}…</code> },
        { key: 'created_at', label: 'Created', render: (k) => fmtDateTime(k.created_at) },
        { key: 'last_used_at', label: 'Last used', render: (k) => (k.last_used_at ? fmtDateTime(k.last_used_at) : 'Never') },
        { key: 'state', label: '', render: (k) => (k.revoked_at ? <Badge kind="grey">Revoked</Badge>
          : <button className="link danger" onClick={() => window.confirm(`Revoke the key for ${k.name}? ${revokeWarning}`) && run(() => rpc('pms_revoke_api_key', { p_key: k.id }), 'Key revoked').then(load).catch(() => {})}>Revoke</button>) },
      ]} />
    </>
  );
}

// Tenda ICO: keys per till, and the room charges that came in
function TendaIco() {
  const { property } = useProperty();
  const [charges, setCharges] = useState(null);
  useEffect(() => {
    supabase.from('pms_external_charges').select('*, pms_stays(pms_rooms(number))').eq('property_id', property.id).order('created_at', { ascending: false }).limit(50)
      .then(({ data }) => setCharges(data ?? []));
  }, [property.id]);
  const url = `${import.meta.env.VITE_SUPABASE_URL ?? 'https://<project>.supabase.co'}/functions/v1/pos-gateway`;
  return (
    <>
      <ApiKeys provider="tendaico" title="Keys for Tenda ICO tills" nameLabel="Outlet or till" placeholder="e.g. Restaurant till"
        revokeWarning="That till stops charging rooms at once."
        intro={<>Make one key per outlet. Tenda ICO stores it in its own Supabase secrets (<code>BMG_PMS_KEY</code>) and calls the PMS from its <code>pms-proxy</code> function, so the key never sits in a browser. The setup steps are in <code>integrations/tendaico/README.md</code>.</>}>
        <p className="small muted">Gateway address for <code>BMG_PMS_URL</code>: <code className="wrap">{url}</code></p>
      </ApiKeys>
      <h3>Room charges from Tenda ICO</h3>
      <Table rows={charges} empty="No room charges yet" columns={[
        { key: 'created_at', label: 'When', render: (c) => fmtDateTime(c.created_at) },
        { key: 'external_ref', label: 'Tenda ICO bill' },
        { key: 'outlet', label: 'Outlet' },
        { key: 'room', label: 'Room', render: (c) => c.pms_stays?.pms_rooms?.number },
        { key: 'amount', label: 'Amount', num: true, render: (c) => money(c.amount) },
        { key: 'status', label: 'Status', render: (c) => <Badge kind={c.status === 'voided' ? 'grey' : 'teal'}>{c.status === 'voided' ? `Voided: ${c.void_reason}` : 'Posted'}</Badge> },
      ]} />
    </>
  );
}

// Settings that choose whose credentials are used, or where keys are sent, are set by platform administrators
// (the database enforces this too)
const ADMIN_KEYS = { channex: ['property_id'], fiscal: ['url', 'key_header', 'key_prefix'] };
const adminOnly = (provider, key) => key === 'code' || (ADMIN_KEYS[provider] ?? []).includes(key);

// Enable switch + non-secret settings + the secrets to set
function Settings({ row, provider, fields, reload, children }) {
  const { property, isAdmin } = useProperty();
  const [run, busy] = useAction();
  const [c, setC] = useState(row.config ?? {});
  useEffect(() => setC(row.config ?? {}), [row]);
  const save = (patch) => run(async () => {
    const { error } = await supabase.from('pms_integrations').upsert({ property_id: property.id, provider, enabled: patch.enabled ?? row.enabled, config: patch.config ?? c, updated_at: new Date().toISOString() });
    if (error) throw error;
    reload();
  }, 'Saved').catch(() => {});
  return (
    <div className="card">
      <div className="int-card-head">
        <h3 className="first">{PROVIDERS[provider].name}</h3>
        <label className="switch"><input type="checkbox" checked={!!row.enabled} onChange={(e) => save({ enabled: e.target.checked })} /> {row.enabled ? 'On' : 'Off'}</label>
      </div>
      <p className="muted">{PROVIDERS[provider].what}</p>
      {fields.length > 0 && (
        <form onSubmit={(e) => { e.preventDefault(); save({ config: c }); }}>
          <div className="grid-2">
            {fields.map((f) => (
              <Field key={f.key} label={f.label} hint={!isAdmin && adminOnly(provider, f.key) ? 'Set by a platform administrator' : f.hint}>
                {f.type === 'json'
                  ? <textarea rows={5} className="mono" value={typeof c[f.key] === 'string' ? c[f.key] : c[f.key] ? JSON.stringify(c[f.key], null, 2) : ''}
                      onChange={(e) => { let v = e.target.value; try { v = v.trim() ? JSON.parse(v) : undefined; } catch { /* keep text until valid */ } setC({ ...c, [f.key]: v }); }} />
                  : f.type === 'yesno'
                    ? <select value={c[f.key] === false ? 'no' : 'yes'} onChange={(e) => setC({ ...c, [f.key]: e.target.value === 'yes' })}><option value="yes">Yes</option><option value="no">No</option></select>
                  : f.type === 'list'
                    ? <input value={(c[f.key] ?? []).join(', ')} onChange={(e) => setC({ ...c, [f.key]: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
                    : <input value={c[f.key] ?? ''} disabled={!isAdmin && adminOnly(provider, f.key)} onChange={(e) => setC({ ...c, [f.key]: e.target.value })} placeholder={f.placeholder} />}
              </Field>
            ))}
          </div>
          <button className="btn btn-primary" disabled={busy}>Save settings</button>
        </form>
      )}
      <details className="secrets">
        <summary>Secrets to set in Supabase (Edge Functions → Secrets)</summary>
        <ul>{PROVIDERS[provider].secrets.map((s) => <li key={s}><code>{s.split(' ')[0]}</code>{s.includes(' ') ? ` ${s.slice(s.indexOf(' ') + 1)}` : ''}</li>)}</ul>
        <p className="small muted">For a property with its own account, add the property code: e.g. <code>TTLOCK_USERNAME_{(row.config?.code ?? 'UH').toUpperCase()}</code>.</p>
      </details>
      {children}
    </div>
  );
}

// Map PMS rooms or room types to provider ids
// Reads the provider's own list (Channex room types and rate plans, TTLock locks) through the integration-catalog function
function useCatalog(provider) {
  const { property } = useProperty();
  const [run, busy] = useAction();
  const [data, setData] = useState(null);
  const fetchIt = () => run(async () => {
    const { data: out, error } = await supabase.functions.invoke('integration-catalog', { body: { property_id: property.id, provider } });
    if (error) throw new Error((await error.context?.json?.().catch(() => null))?.error ?? error.message);
    setData(out);
  }, provider === 'channex' ? 'Loaded from Channex' : 'Loaded locks from TTLock').catch(() => {});
  return [data, fetchIt, busy];
}

function Mapping({ provider, entity, placeholder, options }) {
  const { property, lookups } = useProperty();
  const [run] = useAction();
  const [maps, setMaps] = useState([]);
  const load = useCallback(() => supabase.from('pms_external_ids').select('*').eq('property_id', property.id).eq('provider', provider).eq('entity', entity)
    .then(({ data }) => setMaps(data ?? [])), [property.id, provider, entity]);
  useEffect(() => { load(); }, [load]);
  const targets = entity === 'room' ? lookups.rooms.map((r) => [r.id, `Room ${r.number}`]) : lookups.roomTypes.map((t) => [t.id, t.name]);
  const save = (id, value) => run(async () => {
    const existing = maps.find((m) => m.entity_id === id);
    const { error } = !value
      ? (existing ? await supabase.from('pms_external_ids').delete().eq('id', existing.id) : { error: null })
      : await supabase.from('pms_external_ids').upsert({ property_id: property.id, provider, entity, entity_id: id, external_id: value }, { onConflict: 'provider,entity,entity_id' });
    if (error) throw error;
    load();
  }, 'Mapping saved').catch(() => {});
  return (
    <div className="map-grid">
      {targets.map(([id, name]) => {
        const current = maps.find((m) => m.entity_id === id)?.external_id ?? '';
        return (
          <Field key={id + current} label={name}>
            {options
              ? <select value={current} onChange={(e) => save(id, e.target.value)}>
                  <option value="">Not mapped</option>
                  {current && !options.some((o) => o.id === current) && <option value={current}>{current} (not found at provider)</option>}
                  {options.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                </select>
              : <input placeholder={placeholder} defaultValue={current} onBlur={(e) => e.target.value.trim() !== current && save(id, e.target.value.trim())} />}
          </Field>
        );
      })}
    </div>
  );
}

function Channex({ row, reload }) {
  const { property, lookups } = useProperty();
  const desk = useDesk();
  const [run, busy] = useAction();
  const [rateMap, setRateMap] = useState([]);
  const [revs, setRevs] = useState(null);
  const [typeMap, setTypeMap] = useState([]);
  const [cat, loadCat, catBusy] = useCatalog('channex');
  const load = useCallback(async () => {
    const [m, r] = await Promise.all([
      supabase.from('pms_channex_rate_map').select('*').eq('property_id', property.id),
      supabase.from('pms_channex_revisions').select('*').eq('property_id', property.id).order('received_at', { ascending: false }).limit(50),
    ]);
    setRateMap(m.data ?? []); setRevs(r.data ?? []);
    const t = await supabase.from('pms_external_ids').select('entity_id, external_id').eq('property_id', property.id).eq('provider', 'channex').eq('entity', 'room_type');
    setTypeMap(t.data ?? []);
  }, [property.id]);
  useEffect(() => { load(); }, [load]);
  const saveRate = (type, plan, value) => run(async () => {
    const { error } = !value
      ? await supabase.from('pms_channex_rate_map').delete().eq('room_type_id', type).eq('rate_plan_id', plan)
      : await supabase.from('pms_channex_rate_map').upsert({ property_id: property.id, room_type_id: type, rate_plan_id: plan, channex_rate_plan_id: value });
    if (error) throw error;
    load();
  }, 'Rate plan mapping saved').catch(() => {});
  useEffect(() => { if (cat) load(); }, [cat, load]);
  const hookUrl = `${import.meta.env.VITE_SUPABASE_URL ?? 'https://<project>.supabase.co'}/functions/v1/channex-webhook?token=<CHANNEX_WEBHOOK_TOKEN>&property=${property.id}`;
  return (
    <>
      <Settings row={row} provider="channex" reload={reload} fields={[
        { key: 'property_id', label: 'Channex property ID', placeholder: 'e.g. 716305c4-561a-…', hint: 'Channex → Properties → your property → ID' },
        { key: 'code', label: 'Secrets suffix (optional)', placeholder: property.code ?? '', hint: 'Only if this property uses its own Channex account' },
      ]}>
        <div className="row-gap" style={{ marginTop: 12 }}>
          <button className="btn" disabled={busy || !row.enabled} onClick={() => run(() => rpc('pms_channex_full_sync', { p_property: property.id }), 'Full sync queued; it runs within two minutes').catch(() => {})}>Send full availability and rates now</button>
        </div>
        <p className="small muted">Webhook URL for Channex (Settings → Webhooks, event "booking"): <code className="wrap">{hookUrl}</code></p>
      </Settings>
      <div className="row-gap" style={{ marginTop: 24 }}>
        <h3 className="first" style={{ margin: 0 }}>Room types</h3>
        <button className="btn btn-small" disabled={catBusy || !row.config?.property_id} onClick={loadCat}>{cat ? 'Reload from Channex' : 'Load from Channex'}</button>
        {!cat && <span className="small muted">Pick from Channex's own lists instead of typing IDs.</span>}
      </div>
      <Mapping key={cat ? 'cat' : 'typed'} provider="channex" entity="room_type" placeholder="Channex room type ID" options={cat?.roomTypes} />
      <h3>Rate plans</h3>
      <p className="small muted">In Channex each rate plan belongs to one room type, so map each room type and rate plan pair.</p>
      <div className="map-grid">
        {lookups.roomTypes.flatMap((t) => lookups.ratePlans.filter((p) => p.active).map((p) => {
          const current = rateMap.find((m) => m.room_type_id === t.id && m.rate_plan_id === p.id)?.channex_rate_plan_id ?? '';
          return (
            <Field key={t.id + p.id + current} label={`${t.name} · ${p.name}`}>
              {cat ? (() => {
                const cxType = typeMap.find((m) => m.entity_id === t.id)?.external_id;
                const plans = cat.ratePlans.filter((r) => !cxType || !r.room_type_id || r.room_type_id === cxType);
                return (
                  <select value={current} onChange={(e) => saveRate(t.id, p.id, e.target.value)}>
                    <option value="">Not mapped</option>
                    {current && !plans.some((o) => o.id === current) && <option value={current}>{current} (not found at Channex)</option>}
                    {plans.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
                  </select>
                );
              })() : <input placeholder="Channex rate plan ID" defaultValue={current} onBlur={(e) => e.target.value.trim() !== current && saveRate(t.id, p.id, e.target.value.trim())} />}
            </Field>
          );
        }))}
      </div>
      <h3>Bookings received</h3>
      <Table rows={revs} empty="No channel bookings yet." columns={[
        { key: 'received_at', label: 'Received', render: (r) => fmtDateTime(r.received_at) },
        { key: 'ota_name', label: 'Channel' },
        { key: 'ota_code', label: 'Channel ref' },
        { key: 'status', label: 'Type', render: (r) => <Badge kind={r.status === 'cancelled' ? 'red' : r.status === 'modified' ? 'amber' : 'blue'}>{r.status}</Badge> },
        { key: 'reservation_id', label: 'Reservation', render: (r) => (r.reservation_id ? <button className="link" onClick={() => desk.openReservation(r.reservation_id)}>Open</button> : '—') },
        { key: 'note', label: 'Note', render: (r) => <span className={r.note ? 'danger small' : ''}>{r.note}</span> },
      ]} />
    </>
  );
}

function TTLock({ row, reload }) {
  const { property } = useProperty();
  const [cat, loadCat, catBusy] = useCatalog('ttlock');
  const [events, setEvents] = useState(null);
  const [codes, setCodes] = useState(null);
  useEffect(() => {
    supabase.from('pms_door_events').select('*, pms_rooms(number)').eq('property_id', property.id).order('event_time', { ascending: false }).limit(100).then(({ data }) => setEvents(data ?? []));
    supabase.from('pms_stay_passcodes').select('*, pms_rooms(number)').eq('property_id', property.id).order('created_at', { ascending: false }).limit(50).then(({ data }) => setCodes(data ?? []));
  }, [property.id]);
  return (
    <>
      <Settings row={row} provider="ttlock" reload={reload} fields={[
        { key: 'staff_usernames', label: 'Staff codes and cards', type: 'list', hint: 'Names as they appear in TTLock records (comma-separated). Their entries are not flagged in revenue assurance.' },
        { key: 'code', label: 'Secrets suffix (optional)', placeholder: property.code ?? '' },
      ]}>
        <p className="small muted">Last record pull: {row.config?.last_sync ? fmtDateTime(row.config.last_sync) : 'not yet'}. Locks must be paired to a gateway for passcodes and records to sync.</p>
      </Settings>
      <div className="row-gap" style={{ marginTop: 24 }}>
        <h3 className="first" style={{ margin: 0 }}>Rooms to locks</h3>
        <button className="btn btn-small" disabled={catBusy || !row.enabled} onClick={loadCat}>{cat ? 'Reload locks' : 'Load locks from TTLock'}</button>
        {cat && <span className="small muted">{cat.locks.length} locks on the account{cat.locks.some((l) => l.gateway === false) ? '; some have no gateway and cannot take remote codes' : ''}.</span>}
      </div>
      <Mapping key={cat ? 'cat' : 'typed'} provider="ttlock" entity="room" placeholder="TTLock lockId"
        options={cat?.locks.map((l) => ({ id: l.id, title: `${l.title}${l.battery != null ? ` · battery ${l.battery}%` : ''}${l.gateway === false ? ' · no gateway' : ''}` }))} />
      <h3>Guest passcodes</h3>
      <Table rows={codes} empty="No passcodes issued yet." columns={[
        { key: 'room', label: 'Room', render: (c) => c.pms_rooms?.number },
        { key: 'passcode', label: 'Passcode', render: (c) => <strong className="mono">{c.passcode}</strong> },
        { key: 'valid', label: 'Valid', render: (c) => `${fmtDateTime(c.valid_from)} – ${fmtDateTime(c.valid_to)}` },
        { key: 'status', label: 'Status', render: (c) => <Badge kind={c.status === 'issued' ? 'teal' : c.status === 'failed' ? 'red' : 'grey'}>{c.status}</Badge> },
        { key: 'error', label: '', render: (c) => <span className="small danger">{c.error}</span> },
      ]} />
      <h3>Recent door activity</h3>
      <Table rows={events} empty="No door records yet." columns={[
        { key: 'event_time', label: 'When', render: (e) => fmtDateTime(e.event_time) },
        { key: 'room', label: 'Room', render: (e) => e.pms_rooms?.number ?? `Lock ${e.lock_id}` },
        { key: 'method', label: 'How' },
        { key: 'username', label: 'Who' },
        { key: 'success', label: '', render: (e) => (e.success ? '' : <Badge kind="red">Refused</Badge>) },
      ]} />
    </>
  );
}

const CAM_EVENT = { vmd: 'Motion', linedetection: 'Line crossing', fielddetection: 'Intrusion', regionentrance: 'Entered area', regionexiting: 'Left area', pir: 'PIR sensor' };

function Hikvision({ row, reload }) {
  const { property } = useProperty();
  const [events, setEvents] = useState(null);
  useEffect(() => {
    supabase.from('pms_camera_events').select('*, pms_rooms(number)').eq('property_id', property.id).order('event_time', { ascending: false }).limit(100).then(({ data }) => setEvents(data ?? []));
  }, [property.id]);
  return (
    <>
      <Settings row={row} provider="hikvision" reload={reload} fields={[]}>
        <p className="small">Cameras stay on the property network. Run the relay in <code>tools/hikvision-relay</code> on an always-on PC there with a relay key from below.
          Best: let it read each camera's event stream (<code>PULL_HOSTS</code> with a camera user and password kept on that PC). If the NVR only sends heartbeats, point it at the camera itself or the NVR's Virtual Host port.
          Few events? In the camera, widen the motion area, raise sensitivity to about 80 and set target Human.</p>
      </Settings>
      <ApiKeys provider="hikvision" title="Relay keys" nameLabel="Relay PC" placeholder="e.g. Reception mini PC"
        revokeWarning="That relay stops sending camera events at once."
        intro="Each key only sends events for this property. Put it in the relay's RELAY_KEY setting." />
      <h3>Rooms to camera channels</h3>
      <p className="small muted">Channel number as the camera reports it (e.g. 5), or device:channel (camera MAC address, then the channel) when two devices use the same numbers. Unmatched channels show below with no room.</p>
      <Mapping provider="hikvision" entity="room" placeholder="Channel" />
      <h3>Recent camera events</h3>
      <Table rows={events} empty="No events received yet." columns={[
        { key: 'event_time', label: 'When', render: (e) => fmtDateTime(e.event_time) },
        { key: 'room', label: 'Room', render: (e) => e.pms_rooms?.number ?? <Badge kind="amber">Not matched</Badge> },
        { key: 'channel', label: 'Channel' },
        { key: 'event_type', label: 'Event', render: (e) => <>{CAM_EVENT[e.event_type] ?? e.event_type}{e.raw?.target === 'human' && <span className="small muted"> · person</span>}</> },
        { key: 'length', label: 'Seen for', render: (e) => (e.raw?.seconds != null ? `${e.raw.seconds} s${e.raw.hits > 1 ? ` · ${e.raw.hits} hits` : ''}` : '') },
        { key: 'device', label: 'Device' },
      ]} />
    </>
  );
}

function Fiscal({ row, reload }) {
  const { property, role } = useProperty();
  const [run] = useAction();
  const [rows, setRows] = useState(null);
  const load = useCallback(() => supabase.from('pms_fiscal_receipts').select('*').eq('property_id', property.id).order('created_at', { ascending: false }).limit(200)
    .then(({ data }) => setRows(data ?? [])), [property.id]);
  useEffect(() => { load(); }, [load]);
  const manual = (r) => {
    const no = window.prompt('Receipt number printed by the EFD machine');
    if (!no) return;
    run(() => rpc('pms_fiscal_manual', { p_receipt: r.id, p_receipt_no: no, p_vcode: null }), 'Receipt recorded').then(load).catch(() => {});
  };
  return (
    <>
      <Settings row={row} provider="fiscal" reload={reload} fields={[
        { key: 'url', label: 'VFD provider endpoint', placeholder: 'https://…', hint: 'From your VFD provider (the company that registered you with TRA)' },
        { key: 'key_header', label: 'Key header', placeholder: 'authorization' },
        { key: 'key_prefix', label: 'Key prefix', placeholder: 'Bearer' },
        { key: 'request_template', label: 'Request body template (JSON)', type: 'json', hint: 'Use {{tin}}, {{amount}}, {{reference}}, {{items}}, {{customer}}, {{method}}' },
        { key: 'response_map', label: 'Where to read the reply (JSON)', type: 'json', hint: '{"receipt_no":"data.rctNum","verification_code":"data.rctvCode","verify_url":"data.qr"}' },
      ]}>
        <p className="small muted">Every provider's API differs. Fill these in from your provider's documentation; failed receipts retry automatically and can be entered by hand from the EFD machine.</p>
      </Settings>
      <h3>Receipts</h3>
      <Table rows={rows} empty="No receipts yet." columns={[
        { key: 'created_at', label: 'When', render: (r) => fmtDateTime(r.created_at) },
        { key: 'customer_name', label: 'Customer' },
        { key: 'amount', label: 'Amount', num: true, render: (r) => money(r.amount) },
        { key: 'status', label: 'Status', render: (r) => <Badge kind={r.status === 'issued' || r.status === 'manual' ? 'teal' : r.status === 'failed' ? 'red' : 'blue'}>{r.status}</Badge> },
        { key: 'receipt_no', label: 'Receipt', render: (r) => (/^https?:\/\//i.test(r.verify_url ?? '') ? <a href={r.verify_url} target="_blank" rel="noreferrer">{r.receipt_no}</a> : r.receipt_no) },
        { key: 'error', label: '', render: (r) => (['pending', 'failed'].includes(r.status) && can(role, 'backoffice')
          ? <span className="row-gap"><span className="small danger">{r.error}</span><button className="link" onClick={() => manual(r)}>Enter EFD number</button></span> : null) },
      ]} />
    </>
  );
}

function Activity() {
  const { property } = useProperty();
  const [run] = useAction();
  const [jobs, setJobs] = useState(null);
  const [log, setLog] = useState(null);
  const load = useCallback(async () => {
    const [j, l] = await Promise.all([
      supabase.from('pms_jobs').select('*').eq('property_id', property.id).neq('status', 'done').order('id', { ascending: false }).limit(100),
      supabase.from('pms_integration_log').select('*').eq('property_id', property.id).order('created_at', { ascending: false }).limit(150),
    ]);
    setJobs(j.data ?? []); setLog(l.data ?? []);
  }, [property.id]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <h3 className="first">Waiting and failed tasks</h3>
      <Table rows={jobs} empty="Nothing waiting. Everything has been sent." columns={[
        { key: 'created_at', label: 'Created', render: (j) => fmtDateTime(j.created_at) },
        { key: 'provider', label: 'Service', render: (j) => SERVICE[j.provider] ?? j.provider },
        { key: 'kind', label: 'Task', render: (j) => TASK[j.kind] ?? label(j.kind) },
        { key: 'status', label: 'Status', render: (j) => <Badge kind={j.status === 'failed' ? 'red' : 'blue'}>{label(j.status)}{j.attempts ? ` · ${j.attempts} ${j.attempts === 1 ? 'try' : 'tries'}` : ''}</Badge> },
        { key: 'last_error', label: 'Last error', render: (j) => <span className="small danger">{j.last_error}</span> },
        { key: 'act', label: '', render: (j) => j.status === 'failed' && <button className="link" onClick={() => run(() => rpc('pms_retry_job', { p_job: j.id }), 'Queued again').then(load).catch(() => {})}>Retry</button> },
      ]} />
      <h3>Log</h3>
      <Table rows={log} empty="No calls yet." columns={[
        { key: 'created_at', label: 'When', render: (l) => fmtDateTime(l.created_at) },
        { key: 'provider', label: 'Service', render: (l) => SERVICE[l.provider] ?? l.provider },
        { key: 'direction', label: '', render: (l) => (l.direction === 'out' ? 'Sent' : 'Received') },
        { key: 'action', label: 'What', render: (l) => label(l.action) },
        { key: 'ok', label: 'Result', render: (l) => <Badge kind={l.ok ? 'teal' : 'red'}>{l.ok ? 'OK' : `Failed${l.status_code ? ' ' + l.status_code : ''}`}</Badge> },
        { key: 'error', label: '', render: (l) => <span className="small danger">{l.error}</span> },
      ]} />
    </>
  );
}
