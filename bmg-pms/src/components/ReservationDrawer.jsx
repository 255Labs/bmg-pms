import { useState } from 'react';
import { rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { useDesk } from '../lib/desk';
import { useReservation, stayStatus, summarize } from '../lib/reservation';
import { can, fmtDate, guestName, money, nightsBetween } from '../lib/format';
import { Badge, Drawer, Loading, Menu, useAction } from './ui.jsx';
import ActionDialog from './ActionDialog.jsx';
import Icon from './icons.jsx';
import { printFolio } from './print.js';
import { confirmationText, mailLink, waLink } from './share.js';

const time = (ts, fallback) => (ts ? new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : fallback?.slice(0, 5));

// Quick view opened from Stay view and lists, like the front-desk side card
export default function ReservationDrawer({ reservationId, onClose }) {
  const { property, role } = useProperty();
  const desk = useDesk();
  const [run] = useAction();
  const { res, error, reload } = useReservation(reservationId, property.id);
  const [dialog, setDialog] = useState(null);
  const bd = property.business_date;

  if (error) return <Drawer onClose={onClose} label="Reservation"><p className="pad">This reservation could not be loaded.</p></Drawer>;
  if (!res) return <Drawer onClose={onClose} label="Reservation"><Loading /></Drawer>;

  const g = res.pms_guests;
  const t = summarize(res);
  const live = res.pms_stays.filter((s) => !['cancelled', 'no_show'].includes(s.status));
  const main = live[0] ?? res.pms_stays[0];
  const st = stayStatus(main, bd);
  const openFolio = res.pms_folios.find((f) => f.status === 'open') ?? res.pms_folios[0];
  const nights = nightsBetween(res.arrival, res.departure);
  const adr = live.length ? live.reduce((n, s) => n + Number(s.rate), 0) / live.length : 0;
  const pax = live.reduce((a, s) => [a[0] + s.adults, a[1] + s.children], [0, 0]);
  const book = can(role, 'book');
  const msg = confirmationText({ property, res, totals: t });

  const openPage = (tab) => { onClose(); desk.go('reservation', { id: res.id, ...(tab ? { tab } : {}) }); };
  const checkIn = (s) => run(() => rpc('pms_check_in', { p_stay: s.id, p_allow_dirty: false }), 'Checked in').then(reload)
    .catch((e) => {
      if (String(e.message).includes('ROOM_DIRTY') && window.confirm(`Room ${s.pms_rooms?.number} is marked dirty. Check the guest in anyway?`)) {
        run(() => rpc('pms_check_in', { p_stay: s.id, p_allow_dirty: true }), 'Checked in').then(reload).catch(() => {});
      }
    });

  return (
    <Drawer onClose={onClose} label={`Reservation ${res.res_no}`}
      footer={
        <dl className="totals">
          <dt>Total</dt><dd>{property.currency} {money(t.total)}</dd>
          <dt>Paid</dt><dd>{property.currency} {money(t.credits)}</dd>
          <dt className={t.total - t.credits > 0 ? 'owing' : ''}>Balance</dt>
          <dd className={t.total - t.credits > 0 ? 'owing' : ''}>{property.currency} {money(t.total - t.credits)}</dd>
        </dl>
      }>
      <header className="qv-head">
        <div className="qv-title">
          <span className="qv-icon"><Icon name="guest" size={20} /></span>
          <h2>{guestName(g)}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="qv-contact">
          {g.nationality && <span>{g.nationality}</span>}
          {g.phone && <a href={`tel:${g.phone}`}>{g.phone}</a>}
          {g.email && <a href={`mailto:${g.email}`}>{g.email}</a>}
        </div>
        <div className="qv-actions">
          <button className="btn btn-dark" onClick={() => openPage()}>Open reservation</button>
          <Menu label="Actions" items={[
            book && main && ['confirmed', 'tentative'].includes(main.status) && main.arrival === bd && main.room_id && { label: 'Check in', onClick: () => checkIn(main) },
            book && main && ['confirmed', 'tentative'].includes(main.status) && !main.room_id && { label: 'Assign a room', onClick: () => openPage('booking') },
            book && main?.status === 'checked_in' && { label: 'Check out', onClick: () => setDialog({ kind: 'checkout', stay: main }) },
            can(role, 'cashier') && openFolio?.status === 'open' && { label: 'Add payment', onClick: () => setDialog({ kind: 'payment', folio: openFolio }) },
            can(role, 'cash.charge') && openFolio?.status === 'open' && { label: 'Add charge', onClick: () => setDialog({ kind: 'charge', folio: openFolio }) },
            book && main && ['confirmed', 'tentative', 'checked_in'].includes(main.status) && { label: 'Amend stay', onClick: () => setDialog({ kind: 'amend', stay: main }) },
            book && main && ['confirmed', 'tentative'].includes(main.status) && '-',
            book && main && ['confirmed', 'tentative'].includes(main.status) && { label: 'Cancel or no-show', danger: true, onClick: () => setDialog({ kind: 'cancel', stay: main }) },
          ]} />
          <Menu label="Print / send" align="right" items={[
            openFolio && { label: 'Print folio', onClick: () => printFolio({ property, res, folio: openFolio }) },
            g.email && { label: 'Email confirmation', onClick: () => window.open(mailLink(g.email, `Reservation #${res.res_no} — ${property.name}`, msg)) },
            g.phone && { label: 'Send on WhatsApp', onClick: () => window.open(waLink(g.phone, msg), '_blank') },
          ]} />
        </div>
      </header>

      <dl className="qv-grid">
        <div><dt>Reservation number</dt><dd>{res.res_no}</dd></div>
        <div><dt>Status</dt><dd><Badge kind={st.kind}>{st.text}</Badge></dd></div>
        <div><dt>Arrival</dt><dd>{fmtDate(res.arrival)} <span className="muted">{time(main?.checked_in_at, property.check_in_time)}</span></dd></div>
        <div><dt>Departure</dt><dd>{fmtDate(res.departure)} <span className="muted">{time(main?.checked_out_at, property.check_out_time)}</span></dd></div>
        <div><dt>Booked</dt><dd>{fmtDate(res.created_at.slice(0, 10))} <span className="muted">{time(res.created_at)}</span></dd></div>
        <div><dt>Nights</dt><dd>{nights}</dd></div>
        <div><dt>Room type</dt><dd>{[...new Set(live.map((s) => s.pms_room_types?.name))].join(', ') || '—'}</dd></div>
        <div><dt>Room</dt><dd>{live.map((s) => s.pms_rooms?.number ?? 'Unassigned').join(', ') || '—'}</dd></div>
        <div><dt>Rate plan</dt><dd>{res.pms_rate_plans?.name ?? '—'}</dd></div>
        <div><dt>Source</dt><dd>{res.pms_companies?.name ?? res.pms_business_sources?.name ?? '—'}</dd></div>
        <div><dt>Guests</dt><dd>{pax[0]} adult{pax[0] === 1 ? '' : 's'}{pax[1] ? `, ${pax[1]} child${pax[1] === 1 ? '' : 'ren'}` : ''}</dd></div>
        <div><dt>Average nightly rate</dt><dd>{property.currency} {money(adr)}</dd></div>
      </dl>
      {res.notes && <p className="qv-note">{res.notes}</p>}

      {dialog && (
        <ActionDialog dialog={dialog} res={res} folio={dialog.folio ?? openFolio} property={property}
          onClose={() => setDialog(null)}
          onDone={async (fn, m) => { await run(fn, m); setDialog(null); reload(); }} />
      )}
    </Drawer>
  );
}
