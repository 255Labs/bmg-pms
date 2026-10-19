import { useCallback, useEffect, useMemo, useState } from 'react';
import { rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { useDesk } from '../lib/desk';
import { fmtDate, fmtDateTime, label, money, ROLES } from '../lib/format';
import { Badge, Drawer, Field, Loading, PageHead, Table, Tabs, useAction } from '../components/ui.jsx';
import { MODULES } from '../lib/modules.js';
import ControlBilling from './ControlBilling.jsx';
import PortalLook from '../components/PortalLook.jsx';
import { SetupSection } from './Setup.jsx';
import { MenuSetup } from './Pos.jsx';

// Platform administrators only: every property, people across properties, activity, administrators.
export default function ControlPanel({ params, standalone }) {
  const { isAdmin } = useProperty();
  const [tab, setTab] = useState(params?.tab ?? 'properties');
  const [contentFor, setContentFor] = useState(params?.property ?? '');
  useEffect(() => { if (params?.tab) setTab(params.tab); if (params?.property) setContentFor(params.property); }, [params?.tab, params?.property]);
  const [mfaOn, setMfaOn] = useState(true);
  useEffect(() => { if (isAdmin) rpc('pms_my_mfa_on').then(setMfaOn).catch(() => {}); }, [isAdmin]);
  if (!isAdmin) return <><PageHead title="Control panel" /><p>Only platform administrators can open the control panel.</p></>;
  return (
    <>
      <PageHead title="Control panel" sub="Every property on the platform. Open new properties, switch modules, suspend or reactivate, and manage people anywhere." />
      {!mfaOn && (
        <div className="note warn" role="status" style={{ marginBottom: 16 }}>
          <strong>Turn on two-step sign-in.</strong> This account can open, suspend and change every property; a password alone is not enough protection.{' '}
          <a href="#/security">Set it up now</a>
        </div>
      )}
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'properties', label: 'Properties' }, { value: 'content', label: 'Content and portal look' }, { value: 'new', label: 'Open a property' },
        { value: 'billing', label: 'Billing' }, { value: 'people', label: 'People' }, { value: 'activity', label: 'Activity' }, { value: 'admins', label: 'Administrators' }]} />
      {tab === 'properties' && <Properties standalone={standalone} onContent={(id) => { setContentFor(id); setTab('content'); }} />}
      {tab === 'content' && <PropertyContent propertyId={contentFor} onPick={setContentFor} standalone={standalone} />}
      {tab === 'new' && <NewProperty done={() => setTab('properties')} />}
      {tab === 'billing' && <ControlBilling />}
      {tab === 'people' && <People />}
      {tab === 'activity' && <Activity />}
      {tab === 'admins' && <Admins />}
    </>
  );
}

function Properties({ standalone, onContent }) {
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  const [q, setQ] = useState('');
  const load = useCallback(() => rpc('pms_admin_overview').then(setRows).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);
  if (!rows) return <Loading />;
  const shown = rows.filter((r) => !q || `${r.name} ${r.code ?? ''} ${r.group_name} ${r.owners ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const sum = (k) => rows.filter((r) => r.status === 'active').reduce((n, r) => n + Number(r[k] ?? 0), 0);
  return (
    <>
      <dl className="today-stats">
        <div><dt>Active properties</dt><dd>{rows.filter((r) => r.status === 'active').length}</dd><span className="muted small">{rows.filter((r) => r.status !== 'active').length} suspended</span></div>
        <div><dt>Rooms</dt><dd>{sum('rooms')}</dd></div>
        <div><dt>Guests in house</dt><dd>{sum('in_house')}</dd></div>
        <div><dt>People</dt><dd>{sum('members')}</dd><span className="muted small">{sum('pending_invites')} invites waiting</span></div>
        <div><dt>Guests owe (open folios)</dt><dd className="money">{money(sum('open_balance'))}</dd></div>
        <div><dt>Failed integration tasks</dt><dd className={sum('failed_jobs') ? 'danger' : ''}>{sum('failed_jobs')}</dd></div>
      </dl>
      <div className="row-gap" style={{ marginBottom: 12 }}>
        <input className="search" placeholder="Find a property, code or owner" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} />
      </div>
      <Table rows={shown} onRow={setOpen} empty="No properties yet. Open one under Open a property." columns={[
        { key: 'name', label: 'Property', render: (r) => <><strong>{r.name}</strong>{r.code ? <span className="muted small"> · {r.code}</span> : ''}<div className="small muted">{r.group_name}</div></> },
        { key: 'status', label: 'Status', render: (r) => <Badge kind={r.status === 'active' ? 'teal' : 'red'}>{r.status === 'active' ? 'Active' : 'Suspended'}</Badge> },
        { key: 'business_date', label: 'Business day', render: (r) => fmtDate(r.business_date) },
        { key: 'rooms', label: 'Rooms', num: true },
        { key: 'occupancy_pct', label: 'In house', num: true, render: (r) => `${r.in_house} · ${Number(r.occupancy_pct)}%` },
        { key: 'owners', label: 'Owners', render: (r) => <span className="small">{r.owners || <span className="danger">None yet</span>}{r.pending_invites ? <span className="muted"> · {r.pending_invites} invited</span> : ''}</span> },
        { key: 'last_activity', label: 'Last activity', render: (r) => <span className="small muted">{r.last_activity ? fmtDateTime(r.last_activity) : 'Never'}</span> },
        { key: 'failed_jobs', label: '', render: (r) => (r.failed_jobs ? <Badge kind="red">{r.failed_jobs} failed</Badge> : null) },
      ]} />
      {open && <PropertyDrawer row={open} onClose={() => setOpen(null)} onChanged={() => { load(); }} standalone={standalone} onContent={() => { setOpen(null); onContent(open.property_id); }} />}
    </>
  );
}

function PropertyDrawer({ row, onClose, onChanged, standalone, onContent }) {
  const { reloadProperties, switchProperty } = useProperty();
  const desk = useDesk();
  const [run, busy] = useAction();
  const [f, setF] = useState({ name: row.name, code: row.code ?? '', group_name: row.group_name, admin_notes: row.admin_notes ?? '' });
  const [features, setFeatures] = useState(row.features ?? {});
  const [bd, setBd] = useState(row.business_date);
  const [people, setPeople] = useState(null);
  const [inv, setInv] = useState({ email: '', role: 'manager', name: '' });
  const loadPeople = useCallback(() => rpc('pms_admin_people').then((r) => setPeople(r.filter((p) => p.property_id === row.property_id))).catch(() => setPeople([])), [row.property_id]);
  useEffect(() => { loadPeople(); }, [loadPeople]);
  const save = (patch, msg) => run(() => rpc('pms_admin_update_property', { p_property: row.property_id, p: patch }), msg).then(onChanged).catch(() => {});
  const enter = () => run(async () => {
    await rpc('pms_admin_join_property', { p_property: row.property_id });
    await reloadProperties();
    switchProperty(row.property_id);
  }, `Opening ${row.name}`).then(() => { if (standalone) window.location.hash = '/today'; else desk.go('today'); }).catch(() => {});
  return (
    <Drawer label={row.name} onClose={onClose}>
      <div className="stack pad">
        <div className="row-gap" style={{ justifyContent: 'space-between' }}>
          <h2 className="first" style={{ margin: 0 }}>{row.name}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="row-gap">
          <Badge kind={row.status === 'active' ? 'teal' : 'red'}>{row.status === 'active' ? 'Active' : `Suspended: ${row.status_reason ?? ''}`}</Badge>
          <span className="small muted">Opened {fmtDate(row.created_at.slice(0, 10))} · {row.rooms} rooms · {row.currency} · {row.timezone}</span>
        </div>
        <div className="row-gap">
          <button className="btn btn-primary" disabled={busy} onClick={enter}>Open this property</button>
          <button className="btn" disabled={busy} onClick={onContent}>Content and portal look</button>
          {row.status === 'active'
            ? <button className="btn btn-danger-ghost" disabled={busy} onClick={() => { const why = window.prompt(`Why suspend ${row.name}? Its staff lose access and its integrations stop until you reactivate it.`); if (why) save({ status: 'suspended', status_reason: why }, 'Property suspended'); }}>Suspend</button>
            : <button className="btn" disabled={busy} onClick={() => save({ status: 'active' }, 'Property reactivated')}>Reactivate</button>}
        </div>
        <p className="small muted">Opening a property adds you as its owner (it is logged) so you can work inside it.</p>

        <h3>Details</h3>
        <form className="stack" onSubmit={(e) => { e.preventDefault(); save(f, 'Details saved'); }}>
          <div className="grid-2">
            <Field label="Name"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Code"><input value={f.code} maxLength={8} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} /></Field>
            <Field label="Group" span={2}><input value={f.group_name} onChange={(e) => setF({ ...f, group_name: e.target.value })} /></Field>
            <Field label="Notes for administrators" span={2}><textarea rows={2} value={f.admin_notes} onChange={(e) => setF({ ...f, admin_notes: e.target.value })} placeholder="Contract, contacts, go-live plans…" /></Field>
          </div>
          <button className="btn" disabled={busy}>Save details</button>
        </form>

        <h3>Modules</h3>
        <p className="small muted">Switched-off modules disappear from that property's menu. Front desk, cashiering, housekeeping, night audit and reports are always on.</p>
        <div className="module-grid">
          {Object.entries(MODULES).map(([k, m]) => (
            <label key={k} className="check"><input type="checkbox" checked={features[k] !== false} onChange={(e) => setFeatures({ ...features, [k]: e.target.checked })} /> {m.label}</label>
          ))}
        </div>
        <button className="btn" disabled={busy} onClick={() => save({ features }, 'Modules saved')}>Save modules</button>

        <h3>Business date</h3>
        <p className="small muted">Set the go-live day before anything is posted. After the first posting only the night audit moves it.</p>
        <div className="row-gap">
          <input type="date" value={bd} onChange={(e) => setBd(e.target.value)} style={{ maxWidth: 200 }} />
          <button className="btn" disabled={busy || bd === row.business_date} onClick={() => run(() => rpc('pms_admin_set_business_date', { p_property: row.property_id, p_date: bd }), 'Business date set').then(onChanged).catch(() => {})}>Set</button>
        </div>

        <h3>People</h3>
        {!people ? <Loading /> : (
          <Table rows={people} empty="Nobody yet." columns={[
            { key: 'email', label: 'Email', render: (p) => <>{p.email}{p.display_name ? <div className="small muted">{p.display_name}</div> : null}</> },
            { key: 'role', label: 'Role', render: (p) => label(p.role) },
            { key: 'state', label: '', render: (p) => (p.kind === 'invite' ? <Badge kind="amber">Invited</Badge> : p.active ? <Badge kind="teal">Active</Badge> : <Badge kind="grey">Off</Badge>) },
          ]} />
        )}
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); run(() => rpc('pms_add_or_invite_member', { p_property: row.property_id, p_email: inv.email, p_role: inv.role, p_display_name: inv.name || null, p_active: true }),
          null).then((r) => { window.alert(r === 'invited' ? `${inv.email} has no account yet. They are invited and join ${row.name} when they first sign up.` : `${inv.email} added.`); setInv({ email: '', role: 'manager', name: '' }); loadPeople(); onChanged(); }).catch(() => {}); }}>
          <Field label="Email"><input type="email" required value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></Field>
          <Field label="Role"><select value={inv.role} onChange={(e) => setInv({ ...inv, role: e.target.value })}>{ROLES.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>
          <Field label="Name (optional)"><input value={inv.name} onChange={(e) => setInv({ ...inv, name: e.target.value })} /></Field>
          <button className="btn btn-primary" disabled={busy}>Add or invite</button>
        </form>
      </div>
    </Drawer>
  );
}

// "301-310, 312, 401A" → ['301', …, '310', '312', '401A']
export function expandRooms(text) {
  const out = [];
  for (const part of String(text ?? '').split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+)-(\d+)$/.exec(part);
    if (m && Number(m[2]) >= Number(m[1]) && Number(m[2]) - Number(m[1]) < 500) {
      for (let n = Number(m[1]); n <= Number(m[2]); n++) out.push(String(n).padStart(m[1].length, '0'));
    } else out.push(part);
  }
  return out;
}

function NewProperty({ done }) {
  const [run, busy] = useAction();
  const [list, setList] = useState([]);
  useEffect(() => { rpc('pms_admin_overview').then(setList).catch(() => {}); }, []);
  const [f, setF] = useState({
    name: '', code: '', group_name: 'BMG Group International Limited', currency: 'TZS', timezone: 'Africa/Dar_es_Salaam', tax_rate: '18', tax_inclusive: true,
    check_in_time: '14:00', check_out_time: '10:00', address: '', phone: '', email: '', tin: '', vrn: '', business_date: new Date().toISOString().slice(0, 10),
    copy_from: '', owner_email: '', owner_name: '', add_me: false, admin_notes: '',
  });
  const [types, setTypes] = useState([{ name: 'Standard', code: 'STD', base_rate: '', max_occupancy: '2', rooms: '' }]);
  const [features, setFeatures] = useState({});
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const totalRooms = useMemo(() => types.reduce((n, t) => n + expandRooms(t.rooms).length, 0), [types]);
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await rpc('pms_admin_create_property', { p: {
        ...f, tax_rate: Number(f.tax_rate), features, copy_from: f.copy_from || null,
        room_types: types.filter((t) => t.name.trim()).map((t) => ({ ...t, base_rate: Number(t.base_rate || 0), max_occupancy: Number(t.max_occupancy || 2), rooms: expandRooms(t.rooms) })),
      } });
      window.alert(`${f.name} is open with ${r.rooms} rooms.${r.owner === 'invited' ? ` ${f.owner_email} is invited as owner and joins when they first sign up.` : r.owner === 'added' ? ` ${f.owner_email} is its owner.` : ''}`);
      return r;
    }, null).then(done).catch(() => {});
  };
  return (
    <form onSubmit={submit} className="stack">
      <div className="card">
        <h3 className="first">The property</h3>
        <div className="grid-3">
          <Field label="Name"><input required value={f.name} onChange={set('name')} placeholder="e.g. Pumzika Beach Resort" /></Field>
          <Field label="Short code" hint="Used for secrets suffixes and reports"><input value={f.code} maxLength={8} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="PBR" /></Field>
          <Field label="Group"><input value={f.group_name} onChange={set('group_name')} /></Field>
          <Field label="Address" span={2}><input value={f.address} onChange={set('address')} /></Field>
          <Field label="Phone"><input value={f.phone} onChange={set('phone')} /></Field>
          <Field label="Email"><input type="email" value={f.email} onChange={set('email')} /></Field>
          <Field label="TIN"><input value={f.tin} onChange={set('tin')} /></Field>
          <Field label="VRN"><input value={f.vrn} onChange={set('vrn')} /></Field>
          <Field label="Currency"><input value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field>
          <Field label="Time zone"><select value={f.timezone} onChange={set('timezone')}>{['Africa/Dar_es_Salaam', 'Africa/Nairobi', 'Africa/Kampala', 'Africa/Kigali', 'Africa/Johannesburg', 'UTC'].map((z) => <option key={z}>{z}</option>)}</select></Field>
          <Field label="VAT %"><input inputMode="decimal" value={f.tax_rate} onChange={set('tax_rate')} /></Field>
          <Field label="Room rates"><select value={f.tax_inclusive ? 'inc' : 'exc'} onChange={(e) => setF({ ...f, tax_inclusive: e.target.value === 'inc' })}><option value="inc">Include VAT</option><option value="exc">Exclude VAT</option></select></Field>
          <Field label="Check-in"><input type="time" value={f.check_in_time} onChange={set('check_in_time')} /></Field>
          <Field label="Check-out"><input type="time" value={f.check_out_time} onChange={set('check_out_time')} /></Field>
          <Field label="First business day" hint="The go-live day; can be changed until the first posting"><input type="date" value={f.business_date} onChange={set('business_date')} /></Field>
        </div>
      </div>

      <div className="card">
        <h3 className="first">Rooms</h3>
        <p className="small muted">List room numbers with commas and ranges: <code>101-110, 112, 201A</code>. {totalRooms} room{totalRooms === 1 ? '' : 's'} so far.</p>
        {types.map((t, i) => (
          <div key={i} className="type-row">
            <Field label="Room type"><input value={t.name} onChange={(e) => setTypes(types.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></Field>
            <Field label="Code"><input value={t.code} maxLength={6} onChange={(e) => setTypes(types.map((x, j) => (j === i ? { ...x, code: e.target.value.toUpperCase() } : x)))} /></Field>
            <Field label={`Base rate (${f.currency})`}><input inputMode="decimal" value={t.base_rate} onChange={(e) => setTypes(types.map((x, j) => (j === i ? { ...x, base_rate: e.target.value.replace(/[^\d.]/g, '') } : x)))} /></Field>
            <Field label="Max guests"><input inputMode="numeric" value={t.max_occupancy} onChange={(e) => setTypes(types.map((x, j) => (j === i ? { ...x, max_occupancy: e.target.value.replace(/\D/g, '') } : x)))} /></Field>
            <Field label={`Room numbers (${expandRooms(t.rooms).length})`}><input value={t.rooms} onChange={(e) => setTypes(types.map((x, j) => (j === i ? { ...x, rooms: e.target.value } : x)))} placeholder="101-110, 112" /></Field>
            <button type="button" className="link danger" onClick={() => setTypes(types.filter((_, j) => j !== i))} disabled={types.length === 1}>Remove</button>
          </div>
        ))}
        <button type="button" className="btn btn-ghost" onClick={() => setTypes([...types, { name: '', code: '', base_rate: '', max_occupancy: '2', rooms: '' }])}>+ Room type</button>
      </div>

      <div className="card">
        <h3 className="first">Start from</h3>
        <div className="grid-2">
          <Field label="Copy setup from" hint="Rate plans, business sources, POS outlets and menus with recipes, stock items and locations, and room asset types. No guests, stock or money.">
            <select value={f.copy_from} onChange={set('copy_from')}><option value="">Nothing: start clean</option>{list.map((p) => <option key={p.property_id} value={p.property_id}>{p.name}</option>)}</select>
          </Field>
        </div>
        <h3>Modules</h3>
        <div className="module-grid">
          {Object.entries(MODULES).map(([k, m]) => <label key={k} className="check"><input type="checkbox" checked={features[k] !== false} onChange={(e) => setFeatures({ ...features, [k]: e.target.checked })} /> {m.label}</label>)}
        </div>
      </div>

      <div className="card">
        <h3 className="first">Owner</h3>
        <div className="grid-3">
          <Field label="Owner's email" hint="If they have no account yet they are invited and join when they sign up."><input type="email" value={f.owner_email} onChange={set('owner_email')} /></Field>
          <Field label="Owner's name"><input value={f.owner_name} onChange={set('owner_name')} /></Field>
          <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={f.add_me} onChange={set('add_me')} /> Also make me an owner</label>
        </div>
        <Field label="Notes for administrators"><input value={f.admin_notes} onChange={set('admin_notes')} placeholder="Contract, contacts, go-live plans…" /></Field>
      </div>
      <div><button className="btn btn-primary" disabled={busy || !f.name.trim()}>Open {f.name || 'the property'}{totalRooms ? ` with ${totalRooms} rooms` : ''}</button></div>
    </form>
  );
}

function People() {
  const [run] = useAction();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');
  const load = useCallback(() => rpc('pms_admin_people').then(setRows).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);
  const shown = (rows ?? []).filter((r) => !q || `${r.email} ${r.property} ${r.display_name ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const change = (p, role, active) => run(() => rpc('pms_add_or_invite_member', { p_property: p.property_id, p_email: p.email, p_role: role, p_display_name: null, p_active: active }), 'Saved').then(load).catch(() => {});
  return (
    <>
      <input className="search" placeholder="Find by email, name or property" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360, marginBottom: 12 }} />
      <Table rows={shown} empty="Nobody yet." columns={[
        { key: 'email', label: 'Person', render: (p) => <>{p.email}{p.display_name ? <div className="small muted">{p.display_name}</div> : null}</> },
        { key: 'property', label: 'Property' },
        { key: 'role', label: 'Role', render: (p) => (p.kind === 'invite' ? label(p.role)
          : <select className="mini" value={p.role} onChange={(e) => change(p, e.target.value, p.active)} aria-label={`Role of ${p.email} at ${p.property}`}>{ROLES.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select>) },
        { key: 'state', label: 'Status', render: (p) => (p.kind === 'invite' ? <Badge kind="amber">Invited</Badge> : p.active ? <Badge kind="teal">Active</Badge> : <Badge kind="grey">Off</Badge>) },
        { key: 'last_sign_in', label: 'Last sign-in', render: (p) => <span className="small muted">{p.last_sign_in ? fmtDateTime(p.last_sign_in) : '—'}</span> },
        { key: 'act', label: '', render: (p) => (p.kind === 'invite'
          ? <button className="link danger" onClick={() => run(() => rpc('pms_cancel_invite', { p_invite: p.id }), 'Invite cancelled').then(load).catch(() => {})}>Cancel invite</button>
          : <span className="row-gap">
              <button className="link" onClick={() => change(p, p.role, !p.active)}>{p.active ? 'Switch off' : 'Switch on'}</button>
              <button className="link" title="For a lost phone: removes their authenticator so they can sign in with the password and set it up again"
                onClick={() => window.confirm(`Reset two-step sign-in for ${p.email}? Only do this after confirming who is asking.`) && run(() => rpc('pms_admin_reset_mfa', { p_email: p.email }), 'Two-step sign-in reset').catch(() => {})}>Reset 2-step</button>
            </span>) },
      ]} />
    </>
  );
}

function Activity() {
  const [rows, setRows] = useState(null);
  const [names, setNames] = useState({});
  useEffect(() => {
    rpc('pms_admin_activity', { p_limit: 300, p_property: null }).then(setRows).catch(() => setRows([]));
    rpc('pms_admin_overview').then((ps) => setNames(Object.fromEntries((ps ?? []).map((x) => [x.property_id, x.name])))).catch(() => {});
  }, []);
  const show = (v) => names[v] ?? v;
  return (
    <Table rows={rows} empty="No activity yet." columns={[
      { key: 'created_at', label: 'When', render: (a) => fmtDateTime(a.created_at) },
      { key: 'property', label: 'Property', render: (a) => a.property ?? 'Platform' },
      { key: 'email', label: 'Who', render: (a) => a.email ?? 'System' },
      { key: 'action', label: 'What', render: (a) => label(a.action.replace('.', ' ')) },
      { key: 'details', label: 'Details', render: (a) => <span className="small muted">{a.details ? Object.entries(a.details).filter(([, v]) => v !== null && typeof v !== 'object').slice(0, 4).map(([k, v]) => `${label(k)}: ${show(v)}`).join(' · ') : ''}</span> },
    ]} />
  );
}

function Admins() {
  const { user } = useProperty();
  const [run, busy] = useAction();
  const [rows, setRows] = useState(null);
  const [email, setEmail] = useState('');
  const load = useCallback(() => rpc('pms_admin_list_admins').then(setRows).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <p className="small muted">Administrators see and manage every property. Keep this list short, and use two-factor sign-in on your email.</p>
      <Table rows={rows} empty="No administrators." columns={[
        { key: 'email', label: 'Administrator' },
        { key: 'added_at', label: 'Since', render: (a) => fmtDate(a.added_at.slice(0, 10)) },
        { key: 'act', label: '', render: (a) => (a.user_id === user.id ? <span className="small muted">You</span>
          : <button className="link danger" onClick={() => window.confirm(`Remove ${a.email} as administrator?`) && run(() => rpc('pms_admin_set_admin', { p_email: a.email, p_admin: false }), 'Removed').then(load).catch(() => {})}>Remove</button>) },
      ]} />
      <form className="card inline-form" onSubmit={(e) => { e.preventDefault(); run(() => rpc('pms_admin_set_admin', { p_email: email, p_admin: true }), `${email} is now an administrator`).then(() => { setEmail(''); load(); }).catch(() => {}); }}>
        <Field label="Email of someone who has signed up"><input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <button className="btn btn-primary" disabled={busy}>Make administrator</button>
      </form>
    </>
  );
}

// Edit any hotel's content from here: the guest portal's look (no need to join), and, after joining as owner
// (logged, as "Open this property"), its profile, photos, rooms, rates, menus and guest portal pages.
const CONTENT_TABS = [
  ['look', 'Portal look'], ['portal', 'Guest portal pages'], ['profile', 'Profile'], ['showcase', 'Logo and photos'], ['policies', 'Policies'],
  ['rooms', 'Rooms'], ['plans', 'Rate plans'], ['taxes', 'Taxes'], ['payments', 'Payment methods'], ['extras', 'Extra charges'], ['menus', 'Restaurant and bar menus'],
];
function PropertyContent({ propertyId, onPick, standalone }) {
  const { property, properties, reloadProperties, switchProperty } = useProperty();
  const [run, busy] = useAction();
  const [rows, setRows] = useState(null);
  const [tab, setTab] = useState('look');
  useEffect(() => { rpc('pms_admin_overview').then(setRows).catch(() => setRows([])); }, []);
  const row = rows?.find((r) => r.property_id === propertyId);
  const member = (properties ?? []).some((p) => p.property_id === propertyId);
  const ready = member && property?.id === propertyId;
  const join = () => run(async () => {
    if (!member) await rpc('pms_admin_join_property', { p_property: propertyId });
    await reloadProperties();
    switchProperty(propertyId);
  }, member ? null : `You are now an owner of ${row?.name} (logged)`).catch(() => {});
  if (!rows) return <Loading />;
  return (
    <div className="cp-content">
      <div className="row-gap cp-content-pick">
        <Field label="Property">
          <select value={propertyId} onChange={(e) => { onPick(e.target.value); setTab('look'); }}>
            <option value="">Choose a property…</option>
            {rows.map((r) => <option key={r.property_id} value={r.property_id}>{r.name}{r.code ? ` · ${r.code}` : ''}</option>)}
          </select>
        </Field>
        {row && <span className="small muted">{row.rooms} rooms · {row.currency} · {row.status === 'active' ? 'active' : 'suspended'}</span>}
      </div>
      {!row ? <p className="muted">Choose a property to change its guest portal look, photos, rooms, rates and menus.</p> : <>
        <div className="seg seg-inline cp-content-tabs" role="tablist">
          {CONTENT_TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        {tab === 'look' ? <div className="card"><PortalLook propertyId={propertyId} propertyName={row.name} /></div>
          : !ready ? (
            <div className="card stack">
              <p>{member ? `Switch to ${row.name} to edit its ${CONTENT_TABS.find((x) => x[0] === tab)[1].toLowerCase()} here.` : `To edit ${row.name}'s ${CONTENT_TABS.find((x) => x[0] === tab)[1].toLowerCase()}, you are added as an owner of the property. It is logged, the same as “Open this property”.`}</p>
              <div><button className="btn btn-primary" disabled={busy} onClick={join}>{member ? `Edit ${row.name}` : `Join ${row.name} and edit`}</button></div>
              {standalone && <p className="small muted">The property also appears in your property list at the top.</p>}
            </div>
          ) : <div className="cp-content-body">{tab === 'menus' ? <MenuSetup /> : <SetupSection id={tab} />}</div>}
      </>}
    </div>
  );
}
