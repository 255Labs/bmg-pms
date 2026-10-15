import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { can, fmtDate, fmtDateTime, guestName, label, money } from '../lib/format';
import { Badge, Field, Loading, PageHead, Table, Tabs, useAction } from '../components/ui.jsx';
import { EditableList } from './Setup.jsx';

const COND = { good: ['Good', 'teal'], fair: ['Fair', 'blue'], damaged: ['Damaged', 'amber'], missing: ['Missing', 'red'], retired: ['Retired', 'grey'] };
const CATS = [['furniture', 'Furniture'], ['electronics', 'Electronics'], ['linen', 'Linen'], ['fixture', 'Fixture'], ['amenity', 'Amenity'], ['other', 'Other']];

export default function Assets({ params }) {
  const { role } = useProperty();
  const [tab, setTab] = useState(params?.tab ?? (can(role, 'assets') ? 'register' : 'check'));
  if (!can(role, 'inspect')) return <><PageHead title="Room assets" /><p>Your role does not use room assets.</p></>;
  return (
    <>
      <PageHead title="Room assets" sub="What belongs in each room. Check rooms after guests leave; missing or damaged items open a work order and can be charged to the guest." />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'check', label: 'Check a room' }, { value: 'problems', label: 'Missing and damaged' },
        ...(can(role, 'assets') ? [{ value: 'register', label: 'Register' }, { value: 'add', label: 'Add items' }, { value: 'types', label: 'Item types' }] : [])]} />
      {tab === 'check' && <Check initialRoom={params?.room} />}
      {tab === 'problems' && <Problems />}
      {tab === 'register' && <Register />}
      {tab === 'add' && <Add done={() => setTab('register')} />}
      {tab === 'types' && <Types />}
    </>
  );
}

function Check({ initialRoom }) {
  const { property, lookups, role } = useProperty();
  const [run, busy] = useAction();
  const [roomId, setRoomId] = useState(initialRoom ?? '');
  const [assets, setAssets] = useState(null);
  const [stays, setStays] = useState([]);
  const [stay, setStay] = useState('');
  const [marks, setMarks] = useState({});
  const [note, setNote] = useState('');
  const [result, setResult] = useState(null);
  useEffect(() => {
    setResult(null); setMarks({});
    if (!roomId) { setAssets(null); return; }
    supabase.from('pms_assets').select('*, pms_asset_types(name, category, replacement_cost)').eq('room_id', roomId).neq('condition', 'retired').order('created_at')
      .then(({ data }) => setAssets(data ?? []));
    rpc('pms_room_recent_stays', { p_room: roomId })
      .then((data) => { const rows = (data ?? []).map((x) => ({ id: x.stay_id, status: x.status, arrival: x.arrival, departure: x.departure, pms_reservations: { res_no: x.res_no, pms_guests: { first_name: x.guest } } })); setStays(rows); setStay(rows[0]?.id ?? ''); })
      .catch(() => { setStays([]); setStay(''); });
  }, [roomId]);
  const submit = () => run(async () => {
    const r = await rpc('pms_inspect_room', { p_room: roomId, p_items: assets.map((a) => ({ asset_id: a.id, condition: marks[a.id]?.c ?? 'good', note: marks[a.id]?.n || null })), p_stay: stay || null, p_note: note || null });
    setResult(r);
  }, 'Room check saved').catch(() => {});
  const rooms = lookups.rooms.filter((r) => r.active);
  const set = (id, patch) => setMarks({ ...marks, [id]: { ...(marks[id] ?? {}), ...patch } });
  return (
    <>
      <div className="grid-3">
        <Field label="Room"><select value={roomId} onChange={(e) => setRoomId(e.target.value)}><option value="">Choose a room…</option>{rooms.map((r) => <option key={r.id} value={r.id}>Room {r.number}</option>)}</select></Field>
        {stays.length > 0 && (
          <Field label="After which guest" hint="Issues can be charged to this stay.">
            <select value={stay} onChange={(e) => setStay(e.target.value)}><option value="">Routine check (no guest)</option>
              {stays.map((s) => <option key={s.id} value={s.id}>{guestName(s.pms_reservations?.pms_guests)} · #{s.pms_reservations?.res_no} · {s.status === 'checked_in' ? 'in house' : `left ${fmtDate(s.departure)}`}</option>)}</select>
          </Field>
        )}
      </div>
      {roomId && !assets && <Loading />}
      {assets && assets.length === 0 && <div className="empty">Nothing is registered in this room yet.{can(role, 'assets') ? ' Add items under Add items.' : ''}</div>}
      {assets && assets.length > 0 && !result && (
        <>
          <div className="check-list">
            {assets.map((a) => {
              const c = marks[a.id]?.c ?? 'good';
              return (
                <div key={a.id} className={`check-row ${c}`}>
                  <div><strong>{a.pms_asset_types?.name}</strong>{a.qty > 1 ? ` × ${a.qty}` : ''}<span className="muted small">{a.tag ? ` · ${a.tag}` : ''}{a.condition !== 'good' ? ` · was ${label(a.condition).toLowerCase()}` : ''}</span></div>
                  <div className="seg" role="group" aria-label={`Condition of ${a.pms_asset_types?.name}`}>
                    {['good', 'fair', 'damaged', 'missing'].map((k) => <button key={k} type="button" className={c === k ? 'on' : ''} onClick={() => set(a.id, { c: k })}>{COND[k][0]}</button>)}
                  </div>
                  {['damaged', 'missing'].includes(c) && <input placeholder="What happened? (optional)" value={marks[a.id]?.n ?? ''} onChange={(e) => set(a.id, { n: e.target.value })} />}
                </div>
              );
            })}
          </div>
          <Field label="Note for the check (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <button className="btn btn-primary" disabled={busy} onClick={submit} style={{ marginTop: 12 }}>Save room check</button>
        </>
      )}
      {result && (
        <div className="card">
          <h3 className="first">{result.issues.length ? `${result.issues.length} problem${result.issues.length > 1 ? 's' : ''} found` : 'All present and in order'}</h3>
          {result.issues.length > 0 && <p className="small muted">A work order was opened for each one.{stay && can(role, 'charge') ? ' Charge the guest if they agree.' : ''}</p>}
          {result.issues.map((i) => <Issue key={i.asset_id} issue={i} stay={stay} canCharge={can(role, 'charge') && !!stay} currency={property.currency} />)}
          <button className="btn" onClick={() => { setResult(null); setRoomId(''); }}>Check another room</button>
        </div>
      )}
    </>
  );
}

function Issue({ issue, stay, canCharge, currency }) {
  const [run, busy] = useAction();
  const [amount, setAmount] = useState(String(issue.replacement_cost ?? ''));
  const [done, setDone] = useState(false);
  return (
    <div className="issue-row">
      <Badge kind={COND[issue.condition][1]}>{COND[issue.condition][0]}</Badge>
      <strong>{issue.item}</strong>
      <span className="muted small">replacement {money(issue.replacement_cost)}</span>
      {canCharge && !done && <>
        <input className="num" style={{ width: 130 }} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} aria-label={`Charge for ${issue.item} (${currency})`} />
        <button className="btn btn-small" disabled={busy || !Number(amount)} onClick={() => run(() => rpc('pms_charge_asset', { p_asset: issue.asset_id, p_stay: stay, p_amount: Number(amount), p_note: null }), `${issue.item} charged to the guest`).then(() => setDone(true)).catch(() => {})}>Charge guest</button>
      </>}
      {done && <Badge kind="blue">Charged</Badge>}
    </div>
  );
}

function Problems() {
  const { property } = useProperty();
  const [rows, setRows] = useState(null);
  useEffect(() => {
    supabase.from('pms_assets').select('*, pms_asset_types(name, replacement_cost), pms_rooms(number)').eq('property_id', property.id).in('condition', ['damaged', 'missing'])
      .order('last_checked_at', { ascending: false }).then(({ data }) => setRows(data ?? []));
  }, [property.id]);
  const total = (rows ?? []).reduce((n, a) => n + Number(a.cost ?? a.pms_asset_types?.replacement_cost ?? 0) * a.qty, 0);
  return (
    <Table rows={rows} empty="Nothing missing or damaged." footer={{ item: 'Replacement value', value: money(total) }} columns={[
      { key: 'room', label: 'Room', render: (a) => a.pms_rooms?.number ?? a.location_note ?? '—' },
      { key: 'item', label: 'Item', render: (a) => <strong>{a.pms_asset_types?.name}</strong> },
      { key: 'tag', label: 'Tag' },
      { key: 'condition', label: 'State', render: (a) => <Badge kind={COND[a.condition][1]}>{COND[a.condition][0]}</Badge> },
      { key: 'checked', label: 'Last checked', render: (a) => (a.last_checked_at ? fmtDateTime(a.last_checked_at) : '—') },
      { key: 'value', label: 'Replacement', num: true, render: (a) => money(Number(a.cost ?? a.pms_asset_types?.replacement_cost ?? 0) * a.qty) },
    ]} />
  );
}

function Register() {
  const { property, lookups } = useProperty();
  const [run] = useAction();
  const [rows, setRows] = useState(null);
  const [room, setRoom] = useState('');
  const [showRetired, setShowRetired] = useState(false);
  const load = useCallback(() => {
    let q = supabase.from('pms_assets').select('*, pms_asset_types(name, category, replacement_cost), pms_rooms(number)').eq('property_id', property.id).order('created_at');
    if (room === 'none') q = q.is('room_id', null); else if (room) q = q.eq('room_id', room);
    if (!showRetired) q = q.neq('condition', 'retired');
    return q.then(({ data }) => setRows((data ?? []).sort((a, b) => (a.pms_rooms?.number ?? 'zzz').localeCompare(b.pms_rooms?.number ?? 'zzz'))));
  }, [property.id, room, showRetired]);
  useEffect(() => { load(); }, [load]);
  const value = useMemo(() => (rows ?? []).filter((a) => a.condition !== 'retired').reduce((n, a) => n + Number(a.cost ?? a.pms_asset_types?.replacement_cost ?? 0) * a.qty, 0), [rows]);
  const move = (a) => {
    const n = window.prompt(`Move ${a.pms_asset_types?.name} to which room number? (leave empty for store or public area)`, '');
    if (n === null) return;
    const target = n.trim() ? lookups.rooms.find((r) => r.number === n.trim()) : null;
    if (n.trim() && !target) { window.alert(`There is no room ${n}`); return; }
    run(() => rpc('pms_move_asset', { p_asset: a.id, p_room: target?.id ?? null, p_note: null }), 'Moved').then(load).catch(() => {});
  };
  const retire = (a) => {
    const why = window.prompt(`Why is ${a.pms_asset_types?.name} being retired?`);
    if (why) run(() => rpc('pms_retire_asset', { p_asset: a.id, p_reason: why }), 'Retired').then(load).catch(() => {});
  };
  return (
    <>
      <div className="row-gap" style={{ marginBottom: 12 }}>
        <select className="auto" value={room} onChange={(e) => setRoom(e.target.value)}>
          <option value="">All rooms</option><option value="none">Store and public areas</option>
          {lookups.rooms.filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>Room {r.number}</option>)}
        </select>
        <label className="check small"><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show retired</label>
        <span className="small muted">{rows?.length ?? 0} lines · replacement value {money(value)}</span>
      </div>
      <Table rows={rows} empty="Nothing registered yet." columns={[
        { key: 'room', label: 'Room', render: (a) => a.pms_rooms?.number ?? (a.location_note || 'Store') },
        { key: 'item', label: 'Item', render: (a) => <><strong>{a.pms_asset_types?.name}</strong>{a.qty > 1 ? ` × ${a.qty}` : ''}</> },
        { key: 'category', label: 'Type', render: (a) => label(a.pms_asset_types?.category ?? '') },
        { key: 'tag', label: 'Tag or serial' },
        { key: 'condition', label: 'State', render: (a) => <Badge kind={COND[a.condition][1]}>{COND[a.condition][0]}</Badge> },
        { key: 'checked', label: 'Last checked', render: (a) => (a.last_checked_at ? fmtDate(a.last_checked_at.slice(0, 10)) : 'Never') },
        { key: 'act', label: '', render: (a) => a.condition !== 'retired' && <span className="row-gap"><button className="link" onClick={() => move(a)}>Move</button><button className="link danger" onClick={() => retire(a)}>Retire</button></span> },
      ]} />
    </>
  );
}

function Add({ done }) {
  const { property, lookups } = useProperty();
  const [run, busy] = useAction();
  const [types, setTypes] = useState([]);
  const [f, setF] = useState({ type: '', where: 'room_type', room: '', roomType: lookups.roomTypes[0]?.id ?? '', qty: '1', tag: '', cost: '', note: '' });
  useEffect(() => { supabase.from('pms_asset_types').select('*').eq('property_id', property.id).eq('active', true).order('name').then(({ data }) => setTypes(data ?? [])); }, [property.id]);
  const t = types.find((x) => x.id === f.type);
  const count = f.where === 'room_type' ? lookups.rooms.filter((r) => r.active && r.room_type_id === f.roomType).length : 1;
  if (!types.length) return <div className="empty">Add item types first (TV, kettle, towel…) under Item types.</div>;
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); run(() => rpc('pms_add_assets', { p_property: property.id, p_asset_type: f.type, p_room: f.where === 'room' ? f.room : null,
      p_room_type: f.where === 'room_type' ? f.roomType : null, p_qty: Number(f.qty || 1), p_tag: f.where === 'room_type' ? null : f.tag || null, p_cost: f.cost ? Number(f.cost) : null, p_location_note: f.where === 'none' ? f.note || null : null }),
      `${t?.name} added`).then(done).catch(() => {}); }}>
      <div className="grid-3">
        <Field label="Item"><select required value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="">Choose…</option>{types.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        <Field label="Where">
          <select value={f.where} onChange={(e) => setF({ ...f, where: e.target.value })}>
            <option value="room_type">Every room of a type</option><option value="room">One room</option><option value="none">Store or public area</option>
          </select>
        </Field>
        {f.where === 'room_type' && <Field label="Room type" hint={`${count} room${count === 1 ? '' : 's'}`}><select value={f.roomType} onChange={(e) => setF({ ...f, roomType: e.target.value })}>{lookups.roomTypes.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>}
        {f.where === 'room' && <Field label="Room"><select required value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })}><option value="">Choose…</option>{lookups.rooms.filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>Room {r.number}</option>)}</select></Field>}
        {f.where === 'none' && <Field label="Place"><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. Lobby, linen store" /></Field>}
        <Field label="How many per room"><input inputMode="numeric" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value.replace(/\D/g, '') })} /></Field>
        {f.where !== 'room_type' && <Field label="Tag or serial (optional)"><input value={f.tag} onChange={(e) => setF({ ...f, tag: e.target.value })} /></Field>}
        <Field label={`Cost each (${property.currency}, optional)`} hint={t ? `Replacement cost on file ${money(t.replacement_cost)}` : undefined}><input inputMode="decimal" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
      </div>
      <button className="btn btn-primary" disabled={busy}>Add {count > 1 ? `to ${count} rooms` : ''}</button>
    </form>
  );
}

function Types() {
  const { property } = useProperty();
  const [rows, setRows] = useState([]);
  const load = useCallback(() => supabase.from('pms_asset_types').select('*').eq('property_id', property.id).order('name').then(({ data }) => setRows(data ?? [])), [property.id]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <p className="small muted">The replacement cost is what a guest is charged by default for a missing item.</p>
      <EditableList table="pms_asset_types" rows={rows} onSaved={load} blank={{ name: '', category: 'furniture', replacement_cost: 0, active: true }}
        fields={[{ key: 'name', label: 'Item' }, { key: 'category', label: 'Type', options: CATS }, { key: 'replacement_cost', label: `Replacement cost (${property.currency})`, type: 'number' }, { key: 'active', label: 'Active', type: 'bool' }]} />
    </>
  );
}
