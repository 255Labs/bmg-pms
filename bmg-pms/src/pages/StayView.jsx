import { useEffect, useMemo, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { useDesk } from '../lib/desk';
import { addDays, fmtDate, guestName, money, nightsBetween, label } from '../lib/format';
import { Loading } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import StayKey from '../components/StayKey.jsx';
import { useGuestRequests } from '../components/GuestRequests.jsx';

const DAYS = 14;
const LIVE = ['tentative', 'confirmed', 'checked_in', 'checked_out'];

export default function StayView() {
  const { property, lookups, version } = useProperty();
  const desk = useDesk();
  const { byStay } = useGuestRequests();
  const [start, setStart] = useState(property.business_date);
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all');
  const [collapsed, setCollapsed] = useState({});
  const end = addDays(start, DAYS);
  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(start, i)), [start]);
  const bd = property.business_date;

  useEffect(() => {
    let live = true;
    (async () => {
      const [stays, blocks, avail, orders] = await Promise.all([
        supabase.from('pms_stays')
          .select('id,reservation_id,room_id,room_type_id,arrival,departure,status,rate,adults,children,pms_folios(id,status),pms_reservations(res_no,pms_guests(title,first_name,last_name,attributes,blacklisted),pms_business_sources(name))')
          .eq('property_id', property.id).in('status', LIVE).lt('arrival', end).gt('departure', start),
        supabase.from('pms_maintenance_blocks').select('*')
          .eq('property_id', property.id).eq('status', 'active').lt('from_date', end).gt('to_date', start),
        rpc('pms_availability', { p_property: property.id, p_from: start, p_to: end }),
        supabase.from('pms_work_orders').select('room_id').eq('property_id', property.id).in('status', ['open', 'in_progress']).not('room_id', 'is', null),
      ]);
      // what each stay still owes, for the coin flag on its bar
      const folios = (stays.data ?? []).flatMap((x) => (x.pms_folios ?? []).filter((f) => f.status === 'open').map((f) => f.id));
      const bal = folios.length ? (await supabase.from('pms_folio_balances').select('folio_id,balance').in('folio_id', folios)).data ?? [] : [];
      const owes = Object.fromEntries(bal.map((b) => [b.folio_id, Number(b.balance)]));
      const list = (stays.data ?? []).map((x) => ({ ...x, owing: (x.pms_folios ?? []).reduce((n, f) => n + (owes[f.id] ?? 0), 0) }));
      const perRes = list.reduce((m, x) => ({ ...m, [x.reservation_id]: (m[x.reservation_id] ?? 0) + 1 }), {});
      if (live) setData({ stays: list.map((x) => ({ ...x, group: perRes[x.reservation_id] > 1 })), blocks: blocks.data ?? [], avail: avail ?? [],
        workRooms: new Set((orders.data ?? []).map((o) => o.room_id)) });
    })().catch(() => live && setData({ stays: [], blocks: [], avail: [], workRooms: new Set() }));
    return () => { live = false; };
  }, [property.id, start, end, version]);

  // Status of each room on the business date, for the filter chips
  const roomState = useMemo(() => {
    const m = {};
    if (!data) return m;
    for (const r of lookups.rooms) {
      const s = data.stays.find((x) => x.room_id === r.id && x.arrival <= bd && x.departure > bd && x.status !== 'checked_out')
        ?? data.stays.find((x) => x.room_id === r.id && x.status === 'checked_in' && x.departure === bd);
      const b = data.blocks.find((x) => x.room_id === r.id && x.from_date <= bd && x.to_date > bd);
      m[r.id] = {
        occupied: s?.status === 'checked_in',
        reserved: s && ['confirmed', 'tentative'].includes(s.status),
        dueOut: s?.status === 'checked_in' && s.departure === bd,
        blocked: !!b || r.hk_status === 'out_of_order',
        dirty: r.hk_status === 'dirty',
      };
      m[r.id].vacant = !m[r.id].occupied && !m[r.id].reserved && !m[r.id].blocked;
    }
    return m;
  }, [data, lookups.rooms, bd]);

  if (!data) return <Loading />;

  const activeRooms = lookups.rooms.filter((r) => r.active);
  const count = (k) => activeRooms.filter((r) => roomState[r.id]?.[k]).length;
  const chips = [
    ['all', 'All', activeRooms.length], ['vacant', 'Vacant', count('vacant')], ['occupied', 'Occupied', count('occupied')],
    ['reserved', 'Reserved', count('reserved')], ['blocked', 'Blocked', count('blocked')],
    ['dueOut', 'Due out', count('dueOut')], ['dirty', 'Dirty', count('dirty')],
  ];
  const visible = (r) => filter === 'all' || roomState[r.id]?.[filter];

  const availFor = (typeId, d) => data.avail.find((a) => a.room_type_id === typeId && a.stay_date === d);
  const totalAvail = (d) => data.avail.filter((a) => a.stay_date === d).reduce((n, a) => n + Math.max(0, a.available), 0);
  const sellable = (d) => activeRooms.length - data.blocks.filter((b) => b.from_date <= d && b.to_date > d).length;
  const sold = (d) => data.stays.filter((s) => s.arrival <= d && s.departure > d).length;

  const bar = (s) => {
    const from = Math.max(0, nightsBetween(start, s.arrival));
    const to = Math.min(DAYS, nightsBetween(start, s.departure));
    const startsBefore = s.arrival < start, endsAfter = s.departure > end;
    const left = ((from + (startsBefore ? 0 : 0.5)) / DAYS) * 100;
    const right = ((to + (endsAfter ? 0 : 0.5)) / DAYS) * 100;
    return { left: left + '%', width: `calc(${right - left}% - 3px)` };
  };

  // Today's movement on top of the booking status: arriving today, due out today
  const phase = (s) => (s.status === 'checked_in' && s.departure === bd ? 'due_out'
    : ['confirmed', 'tentative'].includes(s.status) && s.arrival === bd ? 'arriving' : '');
  const StayBar = ({ s }) => {
    const g = s.pms_reservations?.pms_guests;
    const vip = (g?.attributes ?? []).some((t) => /vip/i.test(t));
    const asks = byStay[s.id] ?? [];
    const fresh = asks.filter((r) => r.status === 'new').length;
    const flags = [
      asks.length > 0 && ['bell', `${asks.length} guest request${asks.length === 1 ? '' : 's'} from the portal${fresh ? ` (${fresh} new)` : ''}: ${asks.map((r) => r.title).join(', ')}`],
      s.owing > 0 && ['checked_in', 'checked_out'].includes(s.status) && ['coin', `Owes ${money(s.owing)}`],
      vip && ['star', 'VIP'],
      s.group && ['people', 'Part of a group booking'],
      g?.blacklisted && ['flag', 'Blacklisted guest'],
    ].filter(Boolean);
    const tip = [`#${s.pms_reservations?.res_no} ${guestName(g)}`, `${fmtDate(s.arrival)} → ${fmtDate(s.departure)} · ${label(phase(s) || s.status)}`,
      `${money(s.rate)} / night`, ...flags.map((f) => f[1])].join('\n');
    return (
      <button className={`bar bar-${s.status} ${phase(s) ? 'bar-' + phase(s) : ''} ${fresh ? 'bar-ask' : ''}`} style={bar(s)} title={tip}
        onClick={(e) => { e.stopPropagation(); desk.openReservation(s.reservation_id); }}>
        {flags.length > 0 && <span className="bar-flags">{flags.map(([i, t]) => <span key={i} className={`bar-flag f-${i}`} aria-label={t}><Icon name={i} size={11} />{i === 'bell' && asks.length > 1 && <b>{asks.length}</b>}</span>)}</span>}
        <span className="bar-name">{(nightsBetween(s.arrival, s.departure) <= 1 ? g?.first_name : [g?.first_name, g?.last_name].filter(Boolean).join(' ')) || 'Guest'}</span>
      </button>
    );
  };

  const clickCell = (room, type, d) => {
    if (d < bd) return;
    desk.newReservation({ arrival: d, departure: addDays(d, 1), room_id: room?.id, room_type_id: type.id });
  };

  return (
    <div className="stayview">
      <div className="sv-toolbar">
        <div className="row-gap">
          <input type="date" value={start} onChange={(e) => e.target.value && setStart(e.target.value)} aria-label="Start date" />
          <button className="btn" onClick={() => setStart(addDays(start, -7))}>‹ Week</button>
          <button className="btn" onClick={() => setStart(bd)}>Today</button>
          <button className="btn" onClick={() => setStart(addDays(start, 7))}>Week ›</button>
        </div>
        <div className="sv-right">
        <div className="chips">
          {chips.map(([k, l, n]) => (
            <button key={k} className={`chip ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>
              {l} <span className="chip-n">{n}</span>
            </button>
          ))}
        </div>
        </div>
      </div>

      <div className="sv-scroll">
        <div className="sv-grid" style={{ '--days': DAYS }}>
          <div className="sv-row sv-head">
            <div className="sv-label sv-corner">{fmtDate(start, { month: 'long', year: 'numeric' })}</div>
            <div className="sv-days">
              {days.map((d) => (
                <div key={d} className={`sv-day ${d === bd ? 'today' : ''} ${[0, 6].includes(new Date(d + 'T00:00:00').getDay()) ? 'weekend' : ''}`}>
                  <span className="sv-dow">{fmtDate(d, { weekday: 'short' })}</span>
                  <strong className="sv-dnum">{fmtDate(d, { day: 'numeric' })}</strong><span className="sv-mon">{fmtDate(d, { month: 'short' })}</span>
                </div>
              ))}
            </div>
          </div>

          {lookups.roomTypes.filter((t) => t.active).map((type) => {
            const rooms = activeRooms.filter((r) => r.room_type_id === type.id);
            const unassigned = data.stays.filter((s) => s.room_type_id === type.id && !s.room_id);
            const shown = rooms.filter(visible);
            return (
              <div key={type.id} className="sv-type">
                <div className="sv-row sv-typehead">
                  <button className="sv-label sv-toggle" onClick={() => setCollapsed((c) => ({ ...c, [type.id]: !c[type.id] }))}>
                    {collapsed[type.id] ? '+' : '−'} {type.name}
                  </button>
                  <div className="sv-days">
                    {days.map((d) => {
                      const a = availFor(type.id, d);
                      return (
                        <div key={d} className={`sv-day sv-avail ${d === bd ? 'today' : ''}`}>
                          <span className={`avail-n ${a && a.available <= 0 ? 'zero' : ''}`}>{a?.available ?? '–'}</span>
                          <span className="sv-rate">{money(type.base_rate / 1000)}k</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
                {!collapsed[type.id] && shown.map((room) => (
                  <div key={room.id} className="sv-row">
                    <div className="sv-label sv-room">
                      <span>{room.number}</span>
                      <span className="sv-room-marks">
                        {data.workRooms.has(room.id) && <span className="room-mark wo" title="Open work order"><Icon name="wrench" size={12} /></span>}
                        <span className={`hk-dot hk-${room.hk_status}`} title={label(room.hk_status)} />
                      </span>
                    </div>
                    <div className="sv-days sv-track">
                      {days.map((d) => (
                        <div key={d} className={`sv-cell ${d < bd ? 'past' : ''} ${d === bd ? 'today' : ''}`}
                          onClick={() => clickCell(room, type, d)} title={d >= bd ? `Book ${room.number} from ${fmtDate(d)}` : ''} />
                      ))}
                      {data.blocks.filter((b) => b.room_id === room.id).map((b) => (
                        <div key={b.id} className="bar bar-block" style={bar({ arrival: b.from_date, departure: b.to_date })} title={b.reason}>
                          <span className="bar-name">{b.reason}</span>
                        </div>
                      ))}
                      {data.stays.filter((s) => s.room_id === room.id).map((s) => <StayBar key={s.id} s={s} />)}
                    </div>
                  </div>
                ))}
                {!collapsed[type.id] && unassigned.length > 0 && filter === 'all' && (
                  <div className="sv-row sv-unassigned">
                    <div className="sv-label sv-room"><span className="muted">Unassigned ({unassigned.length})</span></div>
                    <div className="sv-days sv-track stacked" style={{ '--stack': unassigned.length }}>
                      {unassigned.map((s, i) => (
                        <div key={s.id} className="stack-line" style={{ top: i * 30 + 'px' }}><StayBar s={s} /></div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <div className="sv-row sv-foot">
            <div className="sv-label small">Rooms left to sell</div>
            <div className="sv-days">{days.map((d) => <div key={d} className={`sv-day ${d === bd ? 'today' : ''}`}><strong>{totalAvail(d)}</strong></div>)}</div>
          </div>
          <div className="sv-row sv-foot">
            <div className="sv-label small">Occupancy</div>
            <div className="sv-days">
              {days.map((d) => {
                const pct = sellable(d) ? Math.round((sold(d) * 100) / sellable(d)) : 0;
                return (
                  <div key={d} className={`sv-day ${d === bd ? 'today' : ''}`}>
                    <div className="occ-bar"><span style={{ width: pct + '%' }} className={pct >= 80 ? 'hi' : ''} /></div>
                    <span className="small">{pct}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="sv-footbar">
        <StayKey up />
        <span className="small muted">Click an empty cell to book that room.</span>
      </div>
    </div>
  );
}
