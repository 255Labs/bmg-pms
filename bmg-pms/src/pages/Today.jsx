import { useCallback, useEffect, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { useDesk } from '../lib/desk';
import { can, fmtDate, label, money } from '../lib/format';
import { Loading, useAction } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';

const n = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
const INT_NAME = { channex: 'Channex', ttlock: 'TTLock door locks', hikvision: 'Hikvision cameras', fiscal: 'Fiscal receipts', tendaico: 'Tenda ICO', clickpesa: 'Mobile money', sms: 'Guest SMS' };

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

// The front desk's home: what needs doing today, with the action one click away
export default function Today() {
  const { property, role, user, version, refresh, lookups } = useProperty();
  const desk = useDesk();
  const [run, busy] = useAction();
  const [d, setD] = useState(null);
  const bd = property.business_date;

  const load = useCallback(async () => {
    const fo = can(role, 'frontoffice');
    const stays = (kind) => (fo ? rpc('pms_rpt_stays', { p_property: property.id, p_kind: kind, p_from: bd, p_to: bd }).catch(() => []) : Promise.resolve([]));
    const [arr, inh, dep, house, myDrawer, failed, msgs, flags, stock] = await Promise.all([
      stays('arrivals'), stays('in_house'), stays('departures'),
      rpc('pms_rpt_house_status', { p_property: property.id }).catch(() => []),
      can(role, 'cashier') ? supabase.from('pms_drawer_sessions').select('id').eq('property_id', property.id).eq('user_id', user.id).eq('status', 'open').maybeSingle() : Promise.resolve({ data: null }),
      can(role, 'integrations') ? rpc('pms_integration_health', { p_property: property.id }).catch(() => []) : Promise.resolve([]),
      supabase.from('pms_guest_messages').select('id, message, from_name, reservation_id, pms_reservations(res_no, pms_guests(first_name,last_name))').eq('property_id', property.id).eq('status', 'pending').limit(5),
      can(role, 'assurance') && can(role, 'rpt.revenue_assurance') ? supabase.from('pms_audit_findings').select('id, severity').eq('property_id', property.id).eq('status', 'open').then(({ data }) => (data ?? []).map((f) => ({ ...f, flag: f.severity }))) : Promise.resolve([]),
      can(role, 'rpt.stock') ? rpc('pms_rpt_stock_levels', { p_property: property.id }).catch(() => []) : Promise.resolve([]),
    ]);
    // airport runs today (pick-ups on arrival day, drop-offs on departure day)
    const runs = fo ? (await supabase.from('pms_reservations').select('id, res_no, arrival, departure, pickup, dropoff, pms_guests(first_name,last_name,phone)')
      .eq('property_id', property.id).in('status', ['confirmed', 'tentative', 'checked_in']).or(`arrival.eq.${bd},departure.eq.${bd}`)).data ?? [] : [];
    setD({
      arrivals: arr.filter((x) => ['confirmed', 'tentative'].includes(x.status)),
      arrivedToday: arr.filter((x) => x.status === 'checked_in').length,
      inHouse: inh, departures: dep.filter((x) => x.status === 'checked_in'),
      house, drawerOpen: !!myDrawer.data, sick: (failed ?? []).filter((h) => ['error', 'warning'].includes(h.status)), messages: msgs.data ?? [],
      flags: (flags ?? []).filter((f) => f.flag),
      lowStock: [...new Set((stock ?? []).filter((x) => x.low).map((x) => x.item))],
      runs: runs.flatMap((r) => [
        r.pickup?.type_id && r.arrival === bd && { id: r.id + 'p', res: r, leg: 'Pick-up', at: r.pickup.at, flight: r.pickup.flight, type: r.pickup.type_id },
        r.dropoff?.type_id && r.departure === bd && { id: r.id + 'd', res: r, leg: 'Drop-off', at: r.dropoff.at, flight: r.dropoff.flight, type: r.dropoff.type_id },
      ].filter(Boolean)).sort((a, b) => String(a.at).localeCompare(String(b.at))),
    });
  }, [property.id, bd, user.id, role]);
  useEffect(() => { load(); }, [load, version]);

  if (!d) return <Loading />;
  const rooms = lookups.rooms.filter((r) => r.active).length;
  const blocked = d.house.filter((h) => h.occupancy === 'blocked').length;
  const tonight = d.inHouse.filter((x) => x.departure > bd).length + d.arrivals.length;
  const dirty = d.house.filter((h) => h.hk_status === 'dirty');
  const arrivalsIntoDirty = d.arrivals.filter((a) => a.room && d.house.find((h) => h.number === a.room)?.hk_status === 'dirty');
  const owing = d.inHouse.reduce((n, x) => n + Math.max(0, Number(x.balance)), 0);
  const fo = can(role, 'frontoffice');

  const attention = [
    d.arrivals.some((a) => !a.room) && { text: `${n(d.arrivals.filter((a) => !a.room).length, 'arrival has', 'arrivals have')} no room yet`, action: 'Assign rooms', go: () => desk.go('front-desk', { tab: 'arrivals' }) },
    arrivalsIntoDirty.length > 0 && { text: `${n(arrivalsIntoDirty.length, 'arrival is', 'arrivals are')} assigned to a dirty room (${arrivalsIntoDirty.map((a) => a.room).join(', ')})`, action: 'House status', go: () => desk.go('house-status') },
    can(role, 'cashier') && !d.drawerOpen && { text: 'Your cash drawer is closed, so you cannot take cash yet', action: 'Open drawer', go: () => desk.go('cash-drawer') },
    d.messages.length > 0 && { text: `${n(d.messages.length, 'guest message')} waiting to be delivered`, action: 'Messages', go: () => desk.go('messages') },
    ...d.sick.map((h) => ({ text: `${INT_NAME[h.provider] ?? h.provider}: ${h.detail ?? 'needs a look'}`, action: 'Integrations', go: () => desk.go('integrations') })),
    d.lowStock.length > 0 && { text: `${n(d.lowStock.length, 'stock item')} at or below reorder level (${d.lowStock.slice(0, 3).join(', ')}${d.lowStock.length > 3 ? '…' : ''})`, action: 'Stock', go: () => desk.go('stock') },
    d.flags.length > 0 && { text: `${n(d.flags.length, 'open audit finding')}${d.flags.some((f) => f.severity === 'high') ? `, ${d.flags.filter((f) => f.severity === 'high').length} high` : ''}`, action: 'Review', go: () => desk.go('revenue-assurance') },
  ].filter(Boolean);

  const checkIn = (a) => run(() => rpc('pms_check_in', { p_stay: a.stay_id, p_allow_dirty: false }), `${a.guest} checked in to ${a.room}`)
    .then(() => { load(); refresh(); })
    .catch((e) => {
      if (String(e.message).includes('ROOM_DIRTY') && can(role, 'fo.checkin_dirty') && window.confirm(`Room ${a.room} is still dirty. Check ${a.guest} in anyway?`)) {
        run(() => rpc('pms_check_in', { p_stay: a.stay_id, p_allow_dirty: true }), `${a.guest} checked in to ${a.room}`).then(() => { load(); refresh(); }).catch(() => {});
      }
    });
  const checkOut = (x) => Number(x.balance) !== 0
    ? desk.go('reservation', { id: x.reservation_id })
    : run(() => rpc('pms_check_out', { p_stay: x.stay_id, p_transfer_to_company: false }), `${x.guest} checked out of ${x.room}`).then(() => { load(); refresh(); }).catch(() => {});
  const markClean = (h) => run(() => rpc('pms_set_room_status', { p_room: h.room_id, p_status: 'clean', p_note: null }), `Room ${h.number} is clean`).then(() => { load(); refresh(); }).catch(() => {});

  return (
    <div className="today">
      <header className="today-head">
        <div>
          <h1>{greeting()}, {user.email.split('@')[0]}</h1>
          <p className="muted">{property.name} · business day {fmtDate(bd, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
        <div className="row-gap today-actions">
          {can(role, 'book') && <button className="btn btn-primary" onClick={() => desk.newReservation({})}><Icon name="plus" size={16} />New reservation</button>}
          {fo && <button className="btn" onClick={() => desk.go('stay-view')}>Open stay view</button>}
          {!fo && can(role, 'rooms') && <button className="btn" onClick={() => desk.go('house-status')}>House status</button>}
        </div>
      </header>

      {fo && <dl className="today-stats">
        <div><dt>Arrivals to check in</dt><dd>{d.arrivals.length}</dd><span className="muted small">{d.arrivedToday} already arrived</span></div>
        <div><dt>Due out today</dt><dd>{d.departures.length}</dd></div>
        <div><dt>In house</dt><dd>{d.inHouse.length}</dd></div>
        <div><dt>Occupancy tonight</dt><dd>{rooms - blocked ? Math.round((tonight * 100) / (rooms - blocked)) : 0}%</dd><span className="muted small">{tonight} of {rooms - blocked} rooms</span></div>
        <div><dt>Rooms to clean</dt><dd>{dirty.length}</dd></div>
        <div><dt>Owed by in-house guests</dt><dd className="money">{money(owing)}</dd></div>
      </dl>}
      {!fo && <dl className="today-stats">
        <div><dt>Rooms to clean</dt><dd>{dirty.length}</dd></div>
        <div><dt>Out of order</dt><dd>{d.house.filter((h) => h.hk_status === 'out_of_order').length}</dd></div>
        <div><dt>Messages to deliver</dt><dd>{d.messages.length}</dd></div>
      </dl>}

      {attention.length > 0 && (
        <section className="attention">
          <h3 className="first">Needs attention</h3>
          <ul>
            {attention.map((a) => (
              <li key={a.text}><span>{a.text}</span><button className="link" onClick={a.go}>{a.action}</button></li>
            ))}
          </ul>
        </section>
      )}

      <div className="today-cols">
        {fo && <section className="today-list">
          <h3 className="first">Arrivals</h3>
          {d.arrivals.length === 0 && <p className="empty-line">Everyone due today has arrived.</p>}
          {d.arrivals.map((a) => (
            <div key={a.stay_id} className="tl-row">
              <button className="tl-main" onClick={() => desk.openReservation(a.reservation_id)}>
                <span className="tl-room">{a.room ?? '—'}</span>
                <span><strong>{a.guest}</strong><span className="muted small"> · {a.room_type}, {a.nights} night{a.nights === 1 ? '' : 's'}{a.source ? `, ${a.source}` : ''}</span></span>
              </button>
              {(a.room ? can(role, 'fo.checkin') : can(role, 'res.assign')) && (a.room
                ? <button className="btn btn-small btn-primary" disabled={busy} onClick={() => checkIn(a)}>Check in</button>
                : <button className="btn btn-small" onClick={() => desk.go('reservation', { id: a.reservation_id, tab: 'booking' })}>Assign room</button>)}
            </div>
          ))}
        </section>}

        {fo && <section className="today-list">
          <h3 className="first">Departures</h3>
          {d.departures.length === 0 && <p className="empty-line">No one is due out today.</p>}
          {d.departures.map((x) => (
            <div key={x.stay_id} className="tl-row">
              <button className="tl-main" onClick={() => desk.openReservation(x.reservation_id)}>
                <span className="tl-room">{x.room}</span>
                <span><strong>{x.guest}</strong>
                  <span className={`small ${Number(x.balance) > 0 ? 'danger' : 'muted'}`}> · {Number(x.balance) > 0 ? `owes ${money(x.balance)}` : Number(x.balance) < 0 ? `credit ${money(-x.balance)}` : 'settled'}</span></span>
              </button>
              {can(role, 'fo.checkout') && <button className="btn btn-small" disabled={busy} onClick={() => checkOut(x)}>{Number(x.balance) !== 0 ? 'Settle and check out' : 'Check out'}</button>}
            </div>
          ))}
        </section>}

        <section className="today-list">
          <h3 className="first">Rooms to clean</h3>
          {dirty.length === 0 && <p className="empty-line">All rooms are clean.</p>}
          {dirty.map((h) => (
            <div key={h.room_id} className="tl-row">
              <div className="tl-main static">
                <span className="tl-room">{h.number}</span>
                <span>{label(h.occupancy)}{h.guest ? <span className="muted small"> · {h.guest}</span> : null}
                  {d.arrivals.some((a) => a.room === h.number) && <span className="badge badge-amber">Arrival waiting</span>}</span>
              </div>
              {can(role, 'hk.status') && <button className="btn btn-small" disabled={busy} onClick={() => markClean(h)}>Mark clean</button>}
            </div>
          ))}
        </section>
      </div>

      {d.runs.length > 0 && (
        <section className="today-list wide">
          <h3 className="first">Transport today</h3>
          {d.runs.map((x) => (
            <div key={x.id} className="tl-row">
              <button className="tl-main" onClick={() => desk.openReservation(x.res.id)}>
                <span className="tl-room">{x.at ? x.at.slice(11, 16) : '—'}</span>
                <span><strong>{x.leg}: {[x.res.pms_guests?.first_name, x.res.pms_guests?.last_name].filter(Boolean).join(' ')}</strong>
                  <span className="muted small"> · {lookups.transportTypes.find((t) => t.id === x.type)?.name ?? ''}{x.flight ? ` · ${x.flight}` : ''}{x.res.pms_guests?.phone ? ` · ${x.res.pms_guests.phone}` : ''}</span></span>
              </button>
            </div>
          ))}
        </section>
      )}

      {d.messages.length > 0 && (
        <section className="today-list wide">
          <h3 className="first">Messages for guests</h3>
          {d.messages.map((m) => (
            <div key={m.id} className="tl-row">
              <div className="tl-main static"><span><strong>{[m.pms_reservations?.pms_guests?.first_name, m.pms_reservations?.pms_guests?.last_name].filter(Boolean).join(' ') || 'Guest'}</strong>
                <span className="muted small"> · from {m.from_name || 'unknown'}</span><div className="small">{m.message}</div></span></div>
              <button className="btn btn-small" onClick={() => desk.go('messages')}>Open</button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
