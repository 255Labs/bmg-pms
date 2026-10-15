import { useCallback, useEffect, useState } from 'react';
import { rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { useDesk } from '../lib/desk';
import { can, fmtDate, label } from '../lib/format';
import { Badge, Loading, PageHead, statusKind, useAction } from '../components/ui.jsx';
import FloorPlan from '../components/FloorPlan.jsx';
import Icon from '../components/icons.jsx';

const savedView = () => { try { return localStorage.getItem('bmg.hkview') || 'board'; } catch { return 'board'; } };

const NEXT = ['clean', 'dirty', 'inspected', 'out_of_order'];

export default function HouseStatus() {
  const desk = useDesk();
  const { property, role, version, refresh, lookups } = useProperty();
  const [view, setViewState] = useState(savedView);
  const [sel, setSel] = useState(null);
  const setView = (v) => { setViewState(v); try { localStorage.setItem('bmg.hkview', v); } catch { /* storage unavailable */ } };
  const [run] = useAction();
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState('all');

  const load = useCallback(() => rpc('pms_rpt_house_status', { p_property: property.id }).then(setRows), [property.id]);
  useEffect(() => { load(); }, [load, version]);

  if (!rows) return <Loading />;
  const counts = NEXT.reduce((m, s) => ({ ...m, [s]: rows.filter((r) => r.hk_status === s).length }), {});
  const shown = rows.filter((r) => filter === 'all' || r.hk_status === filter || r.occupancy === filter);

  const setStatus = (r, s) => run(() => rpc('pms_set_room_status', { p_room: r.room_id, p_status: s, p_note: null }), `Room ${r.number}: ${label(s)}`)
    .then(() => { load(); refresh(); }).catch(() => {});

  return (
    <>
      <PageHead title="House status" sub="Tap a status to change it. Occupied rooms turn dirty at night audit; check-outs turn dirty immediately.">
        <div className="view-switch" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === 'board'} className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}><Icon name="grid" size={15} /> Board</button>
          <button role="tab" aria-selected={view === 'plan'} className={view === 'plan' ? 'on' : ''} onClick={() => setView('plan')}><Icon name="floor" size={15} /> Floor plan</button>
        </div>
      </PageHead>
      <div className="chips">
        <button className={`chip ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>All <span className="chip-n">{rows.length}</span></button>
        {NEXT.map((s) => <button key={s} className={`chip ${filter === s ? 'active' : ''}`} onClick={() => setFilter(s)}>{label(s)} <span className="chip-n">{counts[s]}</span></button>)}
        {['due_out', 'arriving', 'occupied', 'vacant'].map((s) => <button key={s} className={`chip ${filter === s ? 'active' : ''}`} onClick={() => setFilter(s)}>{label(s)}</button>)}
      </div>
      {view === 'plan' && (() => {
        const byId = Object.fromEntries(lookups.rooms.map((r) => [r.id, r]));
        const plan = shown.map((r) => ({ ...r, id: r.room_id, floor: byId[r.room_id]?.floor }));
        const cur = plan.find((r) => r.id === sel);
        return (
          <div className="fp-layout">
            <FloorPlan rooms={plan} selected={sel} onPick={(r) => setSel(r.id)} tile={(r) => (
              <span className={`fp-tile hk-bg-${r.hk_status} occ-${r.occupancy}`}>
                <strong>{r.number}</strong>
                <span className="fp-meta">{r.guest ? r.guest.split(' ').slice(-1)[0] : label(r.occupancy)}</span>
                <span className="fp-status">{r.hk_status === 'out_of_order' ? 'OOO' : label(r.hk_status)}</span>
              </span>
            )} />
            <aside className="fp-side card">
              {cur ? (
                <>
                  <div className="room-tile-head"><strong className="room-no">Room {cur.number}</strong><Badge kind={statusKind(cur.occupancy)}>{label(cur.occupancy)}</Badge></div>
                  <div className="small muted">{cur.room_type}{cur.floor ? ` · floor ${cur.floor}` : ''}</div>
                  {cur.guest && <div className="small">{cur.guest}{cur.departure ? ` · out ${fmtDate(cur.departure, { day: '2-digit', month: 'short' })}` : ''}</div>}
                  {cur.blocked_reason && <div className="small danger">⚒ {cur.blocked_reason}</div>}
                  {can(role, 'hk.status') && <div className="seg">{NEXT.map((st) => (
                    <button key={st} className={cur.hk_status === st ? 'on' : ''} onClick={() => cur.hk_status !== st && setStatus(cur, st)}>{st === 'out_of_order' ? 'OOO' : label(st)}</button>))}</div>}
                  {can(role, 'inspect') && <button className="btn btn-small" onClick={() => desk.go('assets', { tab: 'check', room: cur.id })}>Check room items</button>}
                </>
              ) : <p className="muted small">Choose a room on the plan to see who is in it and change its status.</p>}
              <div className="fp-legend">
                {NEXT.map((st) => <span key={st}><i className={`fp-swatch hk-bg-${st}`} /> {label(st)}</span>)}
                <span><i className="fp-swatch occ-ring" /> Guest in the room</span>
              </div>
            </aside>
          </div>
        );
      })()}
      {view === 'board' && <div className="room-grid">
        {shown.map((r) => (
          <div key={r.room_id} className={`room-tile hk-${r.hk_status}`}>
            <div className="room-tile-head">
              <strong className="room-no">{r.number}</strong>
              <Badge kind={statusKind(r.occupancy)}>{label(r.occupancy)}</Badge>
            </div>
            <div className="small muted">{r.room_type}</div>
            {r.guest && <div className="small">{r.guest}{r.departure ? ` · out ${fmtDate(r.departure, { day: '2-digit', month: 'short' })}` : ''}</div>}
            {r.blocked_reason && <div className="small danger">⚒ {r.blocked_reason}</div>}
            {can(role, 'hk.status') && <div className="seg">
              {NEXT.map((s) => (
                <button key={s} className={r.hk_status === s ? 'on' : ''} onClick={() => r.hk_status !== s && setStatus(r, s)} title={label(s)}>
                  {s === 'out_of_order' ? 'OOO' : label(s)}
                </button>
              ))}
            </div>}
            {can(role, 'inspect') && <button className="link small room-check" onClick={() => desk.go('assets', { tab: 'check', room: r.room_id })}>Check room items</button>}
          </div>
        ))}
      </div>}
    </>
  );
}
