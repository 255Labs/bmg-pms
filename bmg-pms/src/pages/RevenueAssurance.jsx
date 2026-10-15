import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { addDays, can, downloadCSV, fmtDate, money } from '../lib/format';
import { Badge, Drawer, Field, Loading, Modal, PageHead, Table, Tabs, useAction } from '../components/ui.jsx';
import { EditableList } from './Setup.jsx';
import { useDesk } from '../lib/desk';
import { AUDIT_KIND as KIND } from '../lib/audit';

// Occupancy audit: people the cameras saw and doors the locks opened, against check-ins, check-outs and payments.
const SEV = { high: ['High', 'red'], medium: ['Medium', 'amber'], low: ['Low', 'grey'] };
const OUTCOME = { open: ['Open', 'amber'], explained: ['Explained', 'blue'], charged: ['Charged', 'teal'], loss: ['Loss', 'red'], false_alarm: ['False alarm', 'grey'] };
const time = (t) => (t ? new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');

export default function RevenueAssurance() {
  const { role } = useProperty();
  const [tab, setTab] = useState('findings');
  if (!can(role, 'rpt.revenue_assurance')) return <><PageHead title="Occupancy audit" /><p>You do not have access to the occupancy audit.</p></>;
  return (
    <>
      <PageHead title="Occupancy audit" sub="People the cameras saw and doors the locks opened, checked against check-ins, check-outs and payments. Runs by itself every 30 minutes." />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'findings', label: 'Findings' }, { value: 'daily', label: 'Day by day' }, { value: 'rooms', label: 'Rooms by day' },
        { value: 'summary', label: 'Summary' }, can(role, 'config.integrations') && { value: 'setup', label: 'Cameras and rules' },
      ].filter(Boolean)} />
      {tab === 'findings' && <Findings />}
      {tab === 'daily' && <Daily />}
      {tab === 'rooms' && <Rooms />}
      {tab === 'summary' && <Summary />}
      {tab === 'setup' && <AuditSetup />}
    </>
  );
}

function useRange(days = 7) {
  const { property } = useProperty();
  const [from, setFrom] = useState(addDays(property.business_date, -days));
  const [to, setTo] = useState(property.business_date);
  const fields = <>
    <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
    <Field label="To"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
  </>;
  return { from, to, fields };
}

// ---------------------------------------------------------------- findings
function Findings() {
  const { property, role } = useProperty();
  const [run, busy] = useAction();
  const { from, to, fields } = useRange(14);
  const [status, setStatus] = useState('open');
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  const load = useCallback(() => {
    let q = supabase.from('pms_audit_findings').select('*, pms_rooms(number), pms_stays(reservation_id, pms_reservations(res_no))').eq('property_id', property.id)
      .gte('day', from).lte('day', to).order('day', { ascending: false }).order('severity').limit(500);
    if (status !== 'all') q = q.eq('status', status);
    return q.then(({ data }) => setRows(data ?? []));
  }, [property.id, from, to, status]);
  useEffect(() => { load(); }, [load]);
  const totals = useMemo(() => (rows ?? []).reduce((m, r) => ({ n: m.n + 1, high: m.high + (r.severity === 'high' ? 1 : 0), amt: m.amt + Number(r.amount_at_risk) }), { n: 0, high: 0, amt: 0 }), [rows]);
  return (
    <>
      <div className="filters">
        {fields}
        <Field label="Showing"><select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="open">Open</option><option value="all">All</option>{Object.entries(OUTCOME).filter(([k]) => k !== 'open').map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</select></Field>
        <div className="row-gap" style={{ alignSelf: 'end' }}>
          <button className="btn" disabled={busy} onClick={() => run(() => rpc('pms_audit_run', { p_property: property.id, p_from: from, p_to: to }), 'Audit run for these days').then(load).catch(() => {})}>Check these days now</button>
          <button className="btn" disabled={!rows?.length} onClick={() => downloadCSV(`audit-findings-${from}-${to}.csv`, rows.map((r) => ({ day: r.day, room: r.pms_rooms?.number, finding: KIND[r.kind]?.[0], severity: r.severity, title: r.title,
            at_risk: r.amount_at_risk, outcome: r.status, note: r.resolution, evidence: JSON.stringify(r.evidence) })))}>Export CSV</button>
        </div>
      </div>
      {rows && (
        <dl className="today-stats compact">
          <div><dt>{status === 'open' ? 'Open findings' : 'Findings'}</dt><dd>{totals.n}</dd></div>
          <div><dt>High</dt><dd className={totals.high ? 'danger' : ''}>{totals.high}</dd></div>
          <div><dt>At risk</dt><dd className="money">{money(totals.amt)}</dd></div>
        </dl>
      )}
      {!rows ? <Loading /> : <Table rows={rows} onRow={setOpen} empty={status === 'open' ? 'Nothing open in these days.' : 'No findings.'} columns={[
        { key: 'day', label: 'Day', render: (r) => fmtDate(r.day, { weekday: 'short', day: '2-digit', month: 'short' }) },
        { key: 'room', label: 'Room', render: (r) => <span className="serif">{r.pms_rooms?.number ?? ''}</span> },
        { key: 'kind', label: 'Finding', render: (r) => <><Badge kind={SEV[r.severity][1]}>{KIND[r.kind]?.[0] ?? r.kind}</Badge><div className="small">{r.title}</div></> },
        { key: 'evidence', label: 'Seen', render: (r) => <span className="small"><Evidence f={r} /></span> },
        { key: 'amount_at_risk', label: 'At risk', num: true, render: (r) => (Number(r.amount_at_risk) ? money(r.amount_at_risk) : '') },
        { key: 'status', label: '', render: (r) => <Badge kind={OUTCOME[r.status][1]}>{OUTCOME[r.status][0]}</Badge> },
      ]} />}
      <p className="muted small">A finding is a prompt to check, not proof. Open one to see everything that happened in the room that day, then record what you found{can(role, 'rpt.audit_resolve') ? '' : ' (a manager clears findings)'}.</p>
      {open && <FindingDrawer f={open} onClose={() => setOpen(null)} onDone={() => { setOpen(null); load(); }} />}
    </>
  );
}

function Evidence({ f }) {
  const e = f.evidence ?? {};
  const parts = [];
  if (e.people_seen) parts.push(`${e.people_seen} ${e.people_seen === 1 ? 'person' : 'people'} on camera`);
  if (e.door_opens) parts.push(`${e.door_opens} door opening${e.door_opens === 1 ? '' : 's'}`);
  if (e.first) parts.push(e.first === e.last || !e.last ? `at ${time(e.first)}` : `${time(e.first)}–${time(e.last)}`);
  if (e.codes) parts.push(`code ${e.codes.join(', ')}`);
  if (e.opened_by?.length && !e.codes) parts.push(`by ${e.opened_by.filter(Boolean).join(', ')}`);
  if (f.kind === 'checked_out_unpaid' || f.kind === 'in_house_unpaid') parts.push(`charges ${money(e.charges)}, paid ${money(e.paid)}`);
  if (e.nights_so_far) parts.push(`${e.nights_so_far} nights so far`);
  return parts.join(' · ');
}

function FindingDrawer({ f, onClose, onDone }) {
  const { property, role } = useProperty();
  const desk = useDesk();
  const [run, busy] = useAction();
  const [tl, setTl] = useState(null);
  const [outcome, setOutcome] = useState(f.status === 'open' ? 'explained' : f.status);
  const [note, setNote] = useState(f.resolution ?? '');
  useEffect(() => {
    if (!f.room_id) { setTl([]); return; }
    rpc('pms_audit_timeline', { p_property: property.id, p_room: f.room_id, p_day: f.day }).then(setTl).catch(() => setTl([]));
  }, [property.id, f.room_id, f.day]);
  const resId = f.pms_stays?.reservation_id;
  return (
    <Drawer label={f.title} onClose={onClose}>
      <div className="stack pad">
        <h2 className="first">{f.title}</h2>
        <p className="small muted">{fmtDate(f.day, { weekday: 'long', day: 'numeric', month: 'long' })} · <Badge kind={SEV[f.severity][1]}>{SEV[f.severity][0]}</Badge> · {KIND[f.kind]?.[1]}</p>
        <p><Evidence f={f} />{Number(f.amount_at_risk) ? <> · at risk <strong>{money(f.amount_at_risk)}</strong></> : null}</p>
        {resId && desk?.openReservation && <button className="btn" onClick={() => desk.openReservation(resId)}>Open reservation {f.pms_stays?.pms_reservations?.res_no}</button>}
        <h3>What happened in the room</h3>
        <p className="small muted">From 6 pm the evening before to 6 am the morning after.</p>
        {!tl ? <Loading /> : tl.length === 0 ? <p className="muted small">No room events (money findings come from the folio).</p> : (
          <ol className="audit-tl">
            {tl.map((x, i) => (
              <li key={i} className={`src-${x.source}`}>
                <span className="audit-tl-time">{fmtDate(x.at.slice(0, 10), { day: '2-digit', month: 'short' })} {time(x.at)}</span>
                <span><strong>{x.what}</strong>{x.who ? ` · ${x.who}` : ''}{x.detail ? <span className="small muted"> · {x.detail}</span> : null}</span>
              </li>
            ))}
          </ol>
        )}
        <h3>Outcome</h3>
        {f.status !== 'open' && <p className="small">{OUTCOME[f.status][0]}: {f.resolution}</p>}
        {can(role, 'rpt.audit_resolve') ? <>
          <div>
            <Field label="What was it?"><select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="explained">Explained (no money lost)</option><option value="charged">Charged to the guest</option>
              <option value="loss">Confirmed loss</option><option value="false_alarm">False alarm (camera or lock)</option>
              {f.status !== 'open' && <option value="open">Open it again</option>}</select></Field>
          </div>
          <Field label="What you found" hint="e.g. Late check-in done on paper; posted 150,000 to folio 612; staff member's personal code"><textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <button className="btn btn-primary" disabled={busy} onClick={() => run(() => rpc('pms_audit_resolve', { p_finding: f.id, p_status: outcome, p_note: note }), 'Saved').then(onDone).catch(() => {})}>Save outcome</button>
        </> : <p className="small muted">A manager records the outcome.</p>}
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------- day by day
function Daily() {
  const { property } = useProperty();
  const { from, to, fields } = useRange(14);
  const [rows, setRows] = useState(null);
  useEffect(() => { setRows(null); rpc('pms_rpt_audit_daily', { p_property: property.id, p_from: from, p_to: to }).then(setRows).catch(() => setRows([])); }, [property.id, from, to]);
  return (
    <>
      <div className="filters">{fields}<button className="btn" style={{ alignSelf: 'end' }} disabled={!rows?.length} onClick={() => downloadCSV(`audit-daily-${from}-${to}.csv`, rows)}>Export CSV</button></div>
      {!rows ? <Loading /> : <Table rows={rows} empty="No days." columns={[
        { key: 'day', label: 'Day', render: (r) => <span style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.day, { weekday: 'short', day: '2-digit', month: 'short' })}</span> },
        { key: 'rooms_occupied', label: 'Rooms sold', num: true },
        { key: 'rooms_with_activity', label: 'Rooms used', num: true, render: (r) => <span className={r.rooms_with_activity > r.rooms_occupied ? 'danger' : ''}>{r.rooms_with_activity}</span> },
        { key: 'guests_in_house', label: 'Guests in house', num: true },
        { key: 'arrivals', label: 'Arrived', num: true },
        { key: 'entrance_people', label: 'People at entrance', num: true },
        { key: 'people_in_rooms', label: 'People at room doors', num: true },
        { key: 'guest_door_opens', label: 'Guest door openings', num: true },
        { key: 'findings', label: 'Findings', num: true, render: (r) => (r.findings ? <>{r.findings}{r.high ? <span className="danger"> ({r.high} high)</span> : null}</> : '') },
        { key: 'open_findings', label: 'Open', num: true, render: (r) => r.open_findings || '' },
        { key: 'amount_at_risk', label: 'At risk', num: true, render: (r) => (Number(r.amount_at_risk) ? money(r.amount_at_risk) : '') },
      ]} />}
      <p className="muted small">"Rooms used" counts rooms with a guest door opening or a person at the door (staff visits left out); more rooms used than sold is worth a look. "People at entrance" needs a camera zone of kind Entrance.</p>
    </>
  );
}

// ---------------------------------------------------------------- the room-by-day grid (door and camera counts per room)
function Rooms() {
  const { property } = useProperty();
  const { from, to, fields } = useRange(7);
  const [only, setOnly] = useState(true);
  const [rows, setRows] = useState(null);
  useEffect(() => { setRows(null); rpc('pms_rpt_revenue_assurance', { p_property: property.id, p_from: from, p_to: to }).then(setRows).catch(() => setRows([])); }, [property.id, from, to]);
  const shown = useMemo(() => (rows ?? []).filter((r) => !only || r.flag), [rows, only]);
  return (
    <>
      <div className="filters">
        {fields}
        <label className="check"><input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} /> Only rooms that need a look</label>
        <button className="btn" style={{ alignSelf: 'end' }} disabled={!rows?.length} onClick={() => downloadCSV(`audit-rooms-${from}-${to}.csv`, rows)}>Export CSV</button>
      </div>
      {!rows ? <Loading /> : <Table rows={shown} empty={only ? 'Nothing unusual in this period.' : 'No rooms'} columns={[
        { key: 'day', label: 'Day', render: (r) => fmtDate(r.day, { weekday: 'short', day: '2-digit', month: 'short' }) },
        { key: 'room', label: 'Room', render: (r) => <span className="serif">{r.room}</span> },
        { key: 'pms_status', label: 'PMS says', render: (r) => <>{r.pms_status}{r.guest ? <div className="small muted">{r.guest}</div> : null}</> },
        { key: 'door_opens', label: 'Door (guest)', num: true },
        { key: 'staff_opens', label: 'Door (staff)', num: true },
        { key: 'camera_events', label: 'Camera', num: true },
        { key: 'window', label: 'Activity', render: (r) => (r.first_activity ? `${time(r.first_activity)}–${time(r.last_activity)}` : '') },
        { key: 'flag', label: 'Note', render: (r) => (r.flag ? <Badge kind={r.flag.includes('vacant') ? 'red' : 'amber'}>{r.flag}</Badge> : <span className="muted">—</span>) },
      ]} />}
    </>
  );
}

// ---------------------------------------------------------------- summary by kind and outcome
function Summary() {
  const { property } = useProperty();
  const { from, to, fields } = useRange(30);
  const [rows, setRows] = useState(null);
  useEffect(() => { setRows(null); rpc('pms_rpt_audit_summary', { p_property: property.id, p_from: from, p_to: to }).then(setRows).catch(() => setRows([])); }, [property.id, from, to]);
  return (
    <>
      <div className="filters">{fields}<button className="btn" style={{ alignSelf: 'end' }} disabled={!rows?.length} onClick={() => downloadCSV(`audit-summary-${from}-${to}.csv`, rows)}>Export CSV</button></div>
      {!rows ? <Loading /> : <Table rows={rows} empty="Nothing found in this period." columns={[
        { key: 'kind', label: 'Finding', render: (r) => <><Badge kind={SEV[r.severity]?.[1] ?? 'grey'}>{KIND[r.kind]?.[0] ?? r.kind}</Badge><div className="small muted">{KIND[r.kind]?.[1]}</div></> },
        { key: 'found', label: 'Found', num: true }, { key: 'open', label: 'Open', num: true },
        { key: 'explained', label: 'Explained', num: true }, { key: 'charged', label: 'Charged', num: true },
        { key: 'loss', label: 'Loss', num: true }, { key: 'false_alarm', label: 'False alarm', num: true },
        { key: 'amount_open', label: 'Open at risk', num: true, render: (r) => money(r.amount_open) },
        { key: 'amount_lost', label: 'Lost', num: true, render: (r) => money(r.amount_lost) },
      ]} />}
    </>
  );
}

// ---------------------------------------------------------------- what each camera watches, and the rules
function AuditSetup() {
  const { property } = useProperty();
  const [run, busy] = useAction();
  const [zones, setZones] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [cfg, setCfg] = useState(null);
  const [phones, setPhones] = useState('');
  const load = useCallback(() => Promise.all([
    supabase.from('pms_camera_zones').select('*').eq('property_id', property.id).then(({ data }) => setZones((data ?? []).sort((a, b) => (Number(a.channel) || 1e9) - (Number(b.channel) || 1e9) || a.channel.localeCompare(b.channel)))),
    supabase.from('pms_rooms').select('id, number').eq('property_id', property.id).eq('active', true).order('number').then(({ data }) => setRooms(data ?? [])),
    rpc('pms_audit_settings', { p_property: property.id, p: {} }).then((c) => { setCfg(c); setPhones((c.alert_phones ?? []).join(', ')); }),
  ]), [property.id]);
  useEffect(() => { load(); }, [load]);
  const [help, setHelp] = useState(false);
  return (
    <>
      <h3 className="first">Cameras</h3>
      <p className="small muted">One line per camera channel. Room door cameras are compared with that room's stays; an Entrance camera counts people arriving at the property.
        Use the channel number shown in the relay window (<code>ch 5</code>). Fill in Device (the camera's MAC address) only when two devices use the same channel numbers. <button type="button" className="link small" onClick={() => setHelp(true)}>Where do I find these?</button></p>
      <EditableList table="pms_camera_zones" rows={zones} onSaved={load} blank={{ channel: '', name: '', kind: 'room', room_id: '', device: '', active: true }}
        fields={[{ key: 'channel', label: 'Channel' }, { key: 'name', label: 'Name' },
          { key: 'kind', label: 'Watches', options: [['room', 'A room door'], ['entrance', 'Entrance'], ['reception', 'Reception'], ['corridor', 'Corridor'], ['outlet', 'Restaurant or bar'], ['parking', 'Parking'], ['other', 'Other']] },
          { key: 'room_id', label: 'Room', options: [['', '—'], ...rooms.map((r) => [r.id, r.number])] }, { key: 'device', label: 'Device (MAC)' }, { key: 'active', label: 'Active', type: 'bool' }]} />
      <h3>Rules</h3>
      {!cfg ? <Loading /> : <>
        <div className="grid-4">
          <Field label="Allowed before check-in" hint="Minutes"><input type="number" min="0" max="1440" value={cfg.early_minutes} onChange={(e) => setCfg({ ...cfg, early_minutes: e.target.value })} /></Field>
          <Field label="Allowed after check-out" hint="Minutes"><input type="number" min="0" max="1440" value={cfg.late_minutes} onChange={(e) => setCfg({ ...cfg, late_minutes: e.target.value })} /></Field>
          <Field label="Staff visit lasts" hint="Minutes after a staff code; people seen then are staff"><input type="number" min="0" max="1440" value={cfg.staff_minutes} onChange={(e) => setCfg({ ...cfg, staff_minutes: e.target.value })} /></Field>
          <Field label="Nothing paid after" hint="Nights in house"><input type="number" min="0" max="30" value={cfg.unpaid_after_nights} onChange={(e) => setCfg({ ...cfg, unpaid_after_nights: e.target.value })} /></Field>
        </div>
        <Field label="Text high findings to" hint="Up to five phone numbers, comma-separated. Needs SMS switched on under Integrations.">
          <input value={phones} onChange={(e) => setPhones(e.target.value)} placeholder="0754 000 111, 0713 000 222" /></Field>
        <button className="btn btn-primary" disabled={busy} onClick={() => run(() => rpc('pms_audit_settings', { p_property: property.id, p: {
          early_minutes: String(cfg.early_minutes), late_minutes: String(cfg.late_minutes), staff_minutes: String(cfg.staff_minutes), unpaid_after_nights: String(cfg.unpaid_after_nights),
          alert_phones: phones.split(',').map((s) => s.trim()).filter(Boolean) } }), 'Rules saved').then(load).catch(() => {})}>Save rules</button>
        <p className="small muted">Staff door codes and cards are listed under Integrations → TTLock → Staff codes and cards.</p>
      </>}
      {help && (
        <Modal title="Finding channels and devices" onClose={() => setHelp(false)} footer={<button className="btn" onClick={() => setHelp(false)}>Close</button>}>
          <ol className="small">
            <li>Start the relay on the hotel PC with <code>DEBUG=1</code>.</li>
            <li>Walk past each camera. The window prints <code>event vmd active ch 5 human</code>: 5 is the channel.</li>
            <li>Recent camera events under Integrations → Hikvision show the device (MAC address) for each event.</li>
          </ol>
        </Modal>
      )}
    </>
  );
}
