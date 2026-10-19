import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { rpc } from '../lib/supabase';
import { can, fmtDateTime, money } from '../lib/format';
import { useProperty } from '../lib/property.jsx';
import { useDesk } from '../lib/desk';
import { Badge, Modal, useAction } from './ui.jsx';
import Icon from './icons.jsx';

// Guest portal requests, live for staff: one poll per open app (every 10 seconds) feeds the bell in the top bar,
// the pop-ups, the bell on each guest's bar in Stay view, the reservation and the Guest requests page.
const Ctx = createContext({ list: [], open: [], byStay: {}, reload: () => {}, enabled: false });
export const useGuestRequests = () => useContext(Ctx);
export const KIND_ICON = { food: '🍽️', housekeeping: '🧹', towels: '🛁', amenities: '🧴', maintenance: '🔧', laundry: '👕', taxi: '🚕', wakeup: '⏰', late_checkout: '🕑', other: '💬', offer: '🎁' };
const STATUS = { new: ['New', 'red'], accepted: ['Accepted', 'amber'], done: ['Done', 'teal'], declined: ['Declined', 'grey'], cancelled: ['Cancelled by guest', 'grey'] };
const ago = (ts) => {
  const m = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`;
};

function chime() {
  try {
    const A = window.AudioContext || window.webkitAudioContext;
    const ctx = new A();
    [0, 0.18].forEach((t, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = i ? 1046 : 784; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.35);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.4);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch { /* no sound available */ }
}

export function GuestRequestsProvider({ children }) {
  const { property, role } = useProperty();
  const enabled = !!property && property.features?.guest_portal !== false && can(role, 'fo.requests');
  const [list, setList] = useState([]);
  const [popups, setPopups] = useState([]);
  const seen = useRef(null);
  const reload = useCallback(async () => {
    if (!enabled) { setList([]); return; }
    const rows = await rpc('pms_guest_requests_live', { p_property: property.id }).catch(() => null);
    if (!rows) return;
    setList(rows);
    const fresh = rows.filter((r) => r.status === 'new' && seen.current && !seen.current.has(r.id));
    if (seen.current === null) seen.current = new Set();
    rows.forEach((r) => seen.current.add(r.id));
    if (fresh.length) { setPopups((p) => [...fresh, ...p].slice(0, 4)); chime(); }
  }, [enabled, property?.id]);
  useEffect(() => { seen.current = null; setPopups([]); }, [property?.id]);
  useEffect(() => {
    reload();
    if (!enabled) return undefined;
    const t = setInterval(reload, 10000);
    const f = () => reload();
    window.addEventListener('focus', f);
    return () => { clearInterval(t); window.removeEventListener('focus', f); };
  }, [reload, enabled]);
  const open = useMemo(() => list.filter((r) => ['new', 'accepted'].includes(r.status)), [list]);
  const byStay = useMemo(() => open.reduce((m, r) => { (m[r.stay_id] ??= []).push(r); return m; }, {}), [open]);
  const fresh = open.filter((r) => r.status === 'new').length;
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s*/, '');
    document.title = fresh ? `(${fresh}) ${base}` : base;
  }, [fresh]);
  const value = useMemo(() => ({ list, open, byStay, reload, enabled, fresh }), [list, open, byStay, reload, enabled, fresh]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {popups.length > 0 && (
        <div className="gr-popups" role="status" aria-live="polite">
          {popups.map((r) => <Popup key={r.id} r={r} onClose={() => setPopups((p) => p.filter((x) => x.id !== r.id))} />)}
        </div>
      )}
    </Ctx.Provider>
  );
}

function Popup({ r, onClose }) {
  const desk = useDesk();
  useEffect(() => { const t = setTimeout(onClose, 45000); return () => clearTimeout(t); }, [onClose]);
  return (
    <div className={`gr-popup kind-${r.kind}`}>
      <span className="gr-emoji" aria-hidden="true">{KIND_ICON[r.kind]}</span>
      <div className="gr-popup-body">
        <div className="gr-popup-title">Room {r.room ?? '–'} · {r.guest}</div>
        <div>{r.title}{r.total > 0 ? ` · ${money(r.total)}` : ''}</div>
        {r.details && <div className="small muted">“{r.details}”</div>}
        <div className="gr-popup-actions">
          <button className="btn btn-primary btn-small" onClick={() => { desk?.openReservation(r.reservation_id); onClose(); }}>Open booking</button>
          <button className="btn btn-small" onClick={() => { desk?.go('guest-requests'); onClose(); }}>All requests</button>
        </div>
      </div>
      <button className="icon-btn gr-x" onClick={onClose} aria-label="Dismiss">×</button>
    </div>
  );
}

// Top bar: a bell with the number of new requests and a drop-down of everything open
export function RequestsBell() {
  const { open, enabled, fresh } = useGuestRequests();
  const [show, setShow] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!show) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) setShow(false); };
    const esc = (e) => { if (e.key === 'Escape') setShow(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [show]);
  if (!enabled) return null;
  return (
    <div className="gr-bell-wrap" ref={ref}>
      <button className={`icon-btn gr-bell ${fresh ? 'ring' : ''}`} onClick={() => setShow(!show)} aria-expanded={show}
        aria-label={`Guest requests${open.length ? `, ${fresh} new, ${open.length} open` : ''}`} title="Guest requests from the portal">
        <Icon name="bell" size={20} />
        {open.length > 0 && <span className={`gr-count ${fresh ? 'new' : ''}`}>{open.length}</span>}
      </button>
      {show && (
        <div className="gr-drop" role="dialog" aria-label="Guest requests">
          <div className="gr-drop-head"><strong>Guest requests</strong><a href="#/guest-requests" onClick={() => setShow(false)}>See all</a></div>
          {open.length === 0 ? <p className="muted small gr-empty">Nothing waiting. New requests from the guest portal appear here.</p>
            : open.map((r) => <RequestCard key={r.id} r={r} compact onOpen={() => setShow(false)} />)}
        </div>
      )}
    </div>
  );
}

// One request with what the person may do next
export function RequestCard({ r, compact, onOpen, showGuest = true }) {
  const { reload } = useGuestRequests();
  const { role } = useProperty();
  const desk = useDesk();
  const [run, busy] = useAction();
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  const act = (status, n) => run(() => rpc('pms_guest_request_update', { p_request: r.id, p_status: status, p_note: n ?? null }),
    status === 'accepted' ? (r.kind === 'food' ? 'Accepted: sent to the kitchen and charged to the room' : 'Accepted') : status === 'done' ? 'Marked done' : 'Declined')
    .then(() => { setDeclining(false); reload(); }).catch(() => {});
  const [word, kind] = STATUS[r.status] ?? [r.status, 'grey'];
  const live = ['new', 'accepted'].includes(r.status);
  const foodBlocked = r.kind === 'food' && !r.pos_bill_id && !can(role, 'pos.sell');
  return (
    <div className={`gr-card ${r.status} ${compact ? 'compact' : ''}`}>
      <span className="gr-emoji" aria-hidden="true">{KIND_ICON[r.kind]}</span>
      <div className="gr-body">
        <div className="gr-top">
          <strong>{r.title}</strong>
          <Badge kind={kind}>{word}</Badge>
          <span className="small muted gr-ago" title={fmtDateTime(r.created_at)}>{ago(r.created_at)}</span>
        </div>
        {showGuest && (
          <button className="link small" onClick={() => { desk?.openReservation(r.reservation_id); onOpen?.(); }}>
            Room {r.room ?? '–'} · {r.guest} · #{r.res_no}
          </button>
        )}
        {r.kind === 'food' && r.items?.length > 0 && <div className="small">{r.items.map((i) => `${i.qty} × ${i.name}${i.note ? ` (${i.note})` : ''}`).join(', ')} · <strong>{money(r.total)}</strong></div>}
        {r.kind === 'offer' && Number(r.items?.[0]?.price) > 0 && <div className="small">Offer price <strong>{money(r.items[0].price)}</strong> · charge it on the folio when confirmed</div>}
        {r.details && <div className="small gr-details">“{r.details}”</div>}
        {r.wanted_at && <div className="small"><strong>For {fmtDateTime(r.wanted_at)}</strong></div>}
        {r.staff_note && <div className="small muted">Note to guest: {r.staff_note}</div>}
        {r.handled_by && !live && <div className="small muted">{word} by {r.handled_by}</div>}
        {live && (
          <div className="gr-actions">
            {r.status === 'new' && <button className="btn btn-primary btn-small" disabled={busy || foodBlocked} title={foodBlocked ? 'Needs someone who can charge outlet bills to rooms' : undefined}
              onClick={() => act('accepted')}>{r.kind === 'food' ? 'Accept and send to kitchen' : 'Accept'}</button>}
            <button className="btn btn-small" disabled={busy || foodBlocked} onClick={() => act('done')}>Done</button>
            {!r.pos_bill_id && <button className="btn btn-small btn-danger-ghost" disabled={busy} onClick={() => setDeclining(true)}>Decline</button>}
          </div>
        )}
      </div>
      {declining && (
        <Modal title={`Decline: ${r.title}`} onClose={() => setDeclining(false)}
          footer={<><button className="btn" onClick={() => setDeclining(false)}>Back</button>
            <button className="btn btn-primary" disabled={busy || !note.trim()} onClick={() => act('declined', note)}>Decline</button></>}>
          <label className="field"><span className="field-label">Message to the guest</span>
            <textarea rows={3} maxLength={300} value={note} autoFocus onChange={(e) => setNote(e.target.value)} placeholder="Sorry, the kitchen closes at 22:00. Breakfast starts at 06:30." /></label>
        </Modal>
      )}
    </div>
  );
}

// Reservation: the portal for each checked-in room, and its requests
export function ReservationPortal({ stays }) {
  const { list, enabled } = useGuestRequests();
  const ids = new Set(stays.map((s) => s.id));
  const mine = list.filter((r) => ids.has(r.stay_id));
  const inHouse = stays.filter((s) => s.status === 'checked_in');
  if (!enabled || (!inHouse.length && !mine.length)) return null;
  return (
    <section className="card gr-res">
      <div className="gr-res-head"><h3 className="first"><Icon name="phone" size={17} /> Guest portal</h3>
        {mine.some((r) => r.status === 'new') && <Badge kind="red">{mine.filter((r) => r.status === 'new').length} new</Badge>}</div>
      {inHouse.map((s) => <PortalLink key={s.id} stay={s} multi={inHouse.length > 1} />)}
      {mine.length > 0 && <div className="gr-list">{mine.map((r) => <RequestCard key={r.id} r={r} showGuest={false} />)}</div>}
    </section>
  );
}

function PortalLink({ stay, multi }) {
  const [st, setSt] = useState(null);
  const [run, busy] = useAction();
  const [shown, setShown] = useState(null);
  const [key, setKey] = useState(null);
  const load = useCallback(() => rpc('pms_portal_status', { p_stay: stay.id }).then(setSt).catch(() => setSt(null)), [stay.id]);
  useEffect(() => { load(); }, [load]);
  if (!st || !st.available) return null;
  const appUrl = `${window.location.origin}${window.location.pathname}`;
  const send = (sms, email, whatsapp) => run(() => rpc('pms_portal_send', { p_stay: stay.id, p_sms: sms, p_email: email, p_app_url: appUrl }),
    sms || email ? 'Portal link sent' : null).then((r) => {
    setShown(r); load();
    if (whatsapp && r.phone) window.open(`https://wa.me/${r.phone}?text=${encodeURIComponent(r.message)}`, '_blank', 'noopener');
  }).catch(() => {});
  const via = (st.sent_via ?? []).map((v) => (v === 'sms' ? 'text' : v)).join(' and ');
  return (
    <div className="gr-link">
      {multi && <div className="small"><strong>Room {stay.pms_rooms?.number ?? ''}</strong></div>}
      <p className="small">
        {st.active ? <>Link {via ? `sent by ${via}` : 'made'} {st.sent_at ? fmtDateTime(st.sent_at) : ''}.{' '}
          {st.signed_in ? <strong>Guest signed in{st.signed_in > 1 ? ` on ${st.signed_in} devices` : ''}.</strong> : 'Not signed in yet.'}</>
          : st.issued ? 'The link was stopped.' : 'No link sent yet.'}
        {' '}The key goes only to {[st.phone, st.email].filter(Boolean).join(' or ') || 'the phone or email on the booking'}.
      </p>
      {st.can_send && (
        <div className="gr-actions">
          <button className="btn btn-small btn-primary" disabled={busy} onClick={() => send(true, true, false)}>{st.active ? 'Send again' : 'Send link'} by text and email</button>
          <button className="btn btn-small gr-wa" disabled={busy} onClick={() => send(false, false, true)}>Send on WhatsApp</button>
          {st.active && <button className="btn btn-small" disabled={busy} onClick={() => run(() => rpc('pms_portal_desk_key', { p_stay: stay.id })).then(setKey).catch(() => {})}>Key for the guest</button>}
          {st.active && <button className="btn btn-small btn-danger-ghost" disabled={busy} onClick={() => run(() => rpc('pms_portal_revoke', { p_stay: stay.id }), 'Link stopped').then(load).catch(() => {})}>Stop link</button>}
        </div>
      )}
      {shown && !shown.sent_via?.length && shown.phone === null && <p className="small danger">No mobile number on the booking for WhatsApp. Copy the link instead: <code className="gr-url">{shown.link}</code></p>}
      {key && <p className="gr-key">Key for the guest: <strong>{key}</strong> <span className="small muted">Read it out in person. It works for 15 minutes.</span></p>}
    </div>
  );
}
