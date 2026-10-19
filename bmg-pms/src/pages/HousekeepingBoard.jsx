import { useCallback, useEffect, useMemo, useState } from 'react';
import { rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { can, fmtDate } from '../lib/format';
import { floorOf } from '../components/FloorPlan.jsx';
import { Loading, Modal, useAction } from '../components/ui.jsx';

// The housekeeping manager's board: every room, ticked Cleaned, Not yet, or Under maintenance. Made for a phone or tablet.
const OCC = { occupied: ['Guest in', 'occ'], due_out: ['Due out', 'out'], arriving: ['Arriving today', 'arr'], vacant: ['Vacant', 'vac'], blocked: ['Blocked', 'blk'] };
const STATE = { clean: 'Cleaned', inspected: 'Inspected', dirty: 'Not yet', out_of_order: 'Maintenance' };
const time = (ts) => (ts ? new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
const FILTERS = [['all', 'All rooms'], ['dirty', 'To clean'], ['clean', 'Cleaned'], ['out_of_order', 'Maintenance'], ['priority', 'Due out and arriving']];

export default function HousekeepingBoard() {
  const { property, role } = useProperty();
  const [run, busy] = useAction();
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all');
  const [floor, setFloor] = useState('all');
  const [q, setQ] = useState('');
  const [fix, setFix] = useState(null);
  const [why, setWhy] = useState('');
  const load = useCallback(() => rpc('pms_hk_board', { p_property: property.id }).then(setData).catch(() => setData({ rooms: [], today: [] })), [property.id]);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);
  const rooms = data?.rooms ?? [];
  const floors = useMemo(() => [...new Set(rooms.map(floorOf))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [rooms]);
  if (!data) return <Loading />;
  const n = (f) => rooms.filter(f).length;
  const ready = n((r) => ['clean', 'inspected'].includes(r.hk_status));
  const pct = rooms.length ? Math.round((ready / rooms.length) * 100) : 0;
  const shown = rooms.filter((r) => (floor === 'all' || floorOf(r) === floor)
    && (!q || r.number.toLowerCase().includes(q.toLowerCase()))
    && (filter === 'all' || (filter === 'priority' ? ['due_out', 'arriving'].includes(r.occupancy)
      : filter === 'clean' ? ['clean', 'inspected'].includes(r.hk_status) : r.hk_status === filter)));
  const set = (r, status, note) => run(() => rpc('pms_hk_set', { p_room: r.id, p_status: status, p_note: note ?? null }),
    `Room ${r.number}: ${status === 'maintenance' ? 'under maintenance' : STATE[status]}`).then(load).catch(() => {});
  const canInspect = can(role, 'hk.inspect');
  return (
    <div className="hkb">
      <header className="hkb-head">
        <div>
          <h1>Housekeeping board</h1>
          <p className="muted">{property.name} · {fmtDate(data.business_date, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
        <div className="hkb-progress" role="img" aria-label={`${ready} of ${rooms.length} rooms ready`}>
          <svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15.5" className="track" /><circle cx="18" cy="18" r="15.5" className="bar" style={{ strokeDasharray: `${pct * 0.974} 100` }} /></svg>
          <div><strong>{ready}/{rooms.length}</strong><span>rooms ready</span></div>
        </div>
      </header>

      <div className="hkb-stats">
        <button className={`hkb-stat dirty ${filter === 'dirty' ? 'on' : ''}`} onClick={() => setFilter(filter === 'dirty' ? 'all' : 'dirty')}><strong>{n((r) => r.hk_status === 'dirty')}</strong>To clean</button>
        <button className={`hkb-stat clean ${filter === 'clean' ? 'on' : ''}`} onClick={() => setFilter(filter === 'clean' ? 'all' : 'clean')}><strong>{ready}</strong>Cleaned</button>
        <button className={`hkb-stat maint ${filter === 'out_of_order' ? 'on' : ''}`} onClick={() => setFilter(filter === 'out_of_order' ? 'all' : 'out_of_order')}><strong>{n((r) => r.hk_status === 'out_of_order')}</strong>Maintenance</button>
        <button className={`hkb-stat prio ${filter === 'priority' ? 'on' : ''}`} onClick={() => setFilter(filter === 'priority' ? 'all' : 'priority')}><strong>{n((r) => ['due_out', 'arriving'].includes(r.occupancy))}</strong>Due out / arriving</button>
      </div>

      <div className="hkb-filters">
        <input className="search" placeholder="Room number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a room" />
        <select value={floor} onChange={(e) => setFloor(e.target.value)} aria-label="Floor">
          <option value="all">All floors</option>
          {floors.map((f) => <option key={f} value={f}>Floor {f}</option>)}
        </select>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Show">{FILTERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
      </div>

      {shown.length === 0 ? <p className="muted hkb-empty">No rooms match.</p> : (
        <div className="hkb-grid">
          {shown.map((r) => {
            const [occ, occCls] = OCC[r.occupancy] ?? [r.occupancy, ''];
            const maint = r.hk_status === 'out_of_order';
            return (
              <article key={r.id} className={`hkb-room st-${r.hk_status}`}>
                <div className="hkb-room-top">
                  <span className="hkb-num">{r.number}</span>
                  <span className={`hkb-occ ${occCls}`}>{occ}</span>
                </div>
                <div className="hkb-type">{r.type}{r.occupancy === 'due_out' ? ' · leaving today' : r.departure ? ` · until ${fmtDate(r.departure, { day: 'numeric', month: 'short' })}` : ''}</div>
                <div className="hkb-state"><span className="dot" />{STATE[r.hk_status]}{r.updated_at && <span className="muted"> · {r.updated_by ?? 'system'} {time(r.updated_at)}</span>}</div>
                {(r.hk_note || r.block_reason) && <p className="hkb-note">{r.hk_note ?? r.block_reason}</p>}
                {r.work_orders > 0 && <p className="hkb-wo">🔧 {r.work_orders} open repair{r.work_orders === 1 ? '' : 's'}</p>}
                <div className="hkb-btns">
                  {maint ? (
                    data.can_maintain ? <>
                      <button className="hkb-btn fixed" disabled={busy} onClick={() => set(r, 'dirty')}>Fixed · needs cleaning</button>
                      <button className="hkb-btn clean" disabled={busy} onClick={() => set(r, 'clean')}>Fixed and clean</button>
                    </> : <p className="small muted">Only the housekeeping manager can take this room out of maintenance.</p>
                  ) : <>
                    <button className={`hkb-btn clean ${['clean', 'inspected'].includes(r.hk_status) ? 'on' : ''}`} disabled={busy} aria-pressed={['clean', 'inspected'].includes(r.hk_status)} onClick={() => set(r, 'clean')}>✓ Cleaned</button>
                    <button className={`hkb-btn dirty ${r.hk_status === 'dirty' ? 'on' : ''}`} disabled={busy} aria-pressed={r.hk_status === 'dirty'} onClick={() => set(r, 'dirty')}>Not yet</button>
                    {data.can_maintain && <button className="hkb-btn maint" disabled={busy} onClick={() => { setFix(r); setWhy(''); }}>🔧 Maintenance</button>}
                  </>}
                </div>
                {canInspect && r.hk_status === 'clean' && <button className="link small hkb-inspect" disabled={busy} onClick={() => set(r, 'inspected')}>Mark inspected</button>}
              </article>
            );
          })}
        </div>
      )}

      {data.today.length > 0 && (
        <section className="card hkb-log">
          <h3 className="first">Last 24 hours</h3>
          <ul>{data.today.map((x, i) => (
            <li key={i}><strong>Room {x.room}</strong> {STATE[x.to] ?? x.to}<span className="muted"> · {x.by ?? 'night audit'} · {time(x.at)}</span></li>
          ))}</ul>
        </section>
      )}

      {fix && (
        <Modal title={`Room ${fix.number}: under maintenance`} onClose={() => setFix(null)}
          footer={<><button className="btn" onClick={() => setFix(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !why.trim()} onClick={() => set(fix, 'maintenance', why).then(() => setFix(null))}>Put under maintenance</button></>}>
          <label className="field"><span className="field-label">What needs fixing?</span>
            <textarea rows={3} maxLength={300} autoFocus value={why} onChange={(e) => setWhy(e.target.value)} placeholder="AC not cooling, shower leaking…" /></label>
          <p className="small muted">The room turns out of order and a repair job opens under Work orders. Take it out of maintenance here when it is fixed.</p>
          {['occupied', 'due_out'].includes(fix.occupancy) && <p className="small danger">A guest is in this room. Tell the front desk.</p>}
        </Modal>
      )}
    </div>
  );
}
