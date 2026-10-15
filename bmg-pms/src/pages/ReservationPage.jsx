import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { useDesk } from '../lib/desk';
import { useReservation, stayStatus, summarize, unpostedNights } from '../lib/reservation';
import { addDays, can, fmtDate, fmtDateTime, guestName, label, money, nightsBetween } from '../lib/format';
import { Badge, Field, Loading, Menu, Modal, Table, Tabs, statusKind, useAction } from '../components/ui.jsx';
import FloorPlan from '../components/FloorPlan.jsx';
import ChangeConfirm from '../components/ChangeConfirm.jsx';
import ActionDialog from '../components/ActionDialog.jsx';
import PhoneRequests from '../components/PhoneRequests.jsx';
import Icon from '../components/icons.jsx';
import { printFolio } from '../components/print.js';
import { confirmationText, mailLink, waLink } from '../components/share.js';

const PARTICULARS = {
  room: 'Room charge', tax: 'VAT', fnb: 'Food & beverage', laundry: 'Laundry', minibar: 'Minibar', transport: 'Transport',
  spa: 'Spa', extra_bed: 'Extra bed', damage: 'Damage', other: 'Other charge', discount: 'Discount',
  recreation: 'Recreation', tours: 'Tours', events: 'Events', adjustment: 'Adjustment', paid_out: 'Paid out',
};
const SUB = { day_use: 'Day use', late_checkout: 'Late check-out', early_checkin: 'Early check-in', no_show: 'No-show', cancellation: 'Cancellation' };
const METHOD = { cash: 'Cash', mobile_money: 'Mobile money', card: 'Card', bank: 'Bank transfer', city_ledger: 'City ledger', other: 'Other' };
const dayName = (iso) => fmtDate(iso, { weekday: 'long' });
const bal = (n) => (n < 0 ? `Cr ${money(-n)}` : money(n));

export default function ReservationPage({ params }) {
  const { property, role, refresh } = useProperty();
  const desk = useDesk();
  const [run, busy] = useAction();
  const { res, error, reload } = useReservation(params.id, property.id);
  const [tab, setTab] = useState(params.tab ?? 'folio');
  const [folioId, setFolioId] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [codes, setCodes] = useState([]);
  const bd = property.business_date;
  useEffect(() => {
    if (!res) return;
    supabase.from('pms_stay_passcodes').select('passcode, valid_to, pms_rooms(number)').in('stay_id', res.pms_stays.map((x) => x.id)).eq('status', 'issued')
      .then(({ data }) => setCodes(data ?? []));
  }, [res]);

  useEffect(() => {
    if (res && !res.pms_folios.some((f) => f.id === folioId)) {
      setFolioId((res.pms_folios.find((f) => f.status === 'open') ?? res.pms_folios[0])?.id ?? null);
    }
  }, [res, folioId]);

  if (error) return <div className="empty">This reservation could not be loaded. It may belong to another property.</div>;
  if (!res) return <Loading />;

  const g = res.pms_guests;
  const t = summarize(res);
  const live = res.pms_stays.filter((s) => !['cancelled', 'no_show'].includes(s.status));
  const main = live[0] ?? res.pms_stays[0];
  const st = stayStatus(main, bd);
  const folio = res.pms_folios.find((f) => f.id === folioId);
  const pax = live.reduce((a, s) => [a[0] + s.adults, a[1] + s.children], [0, 0]);
  const done = async (fn, m) => { await run(fn, m); setDialog(null); reload(); refresh(); };
  const act = (fn, m) => run(fn, m).then(() => { reload(); refresh(); }).catch(() => {});
  const msg = confirmationText({ property, res, totals: t });

  return (
    <div className="resv">
      <header className="resv-strip">
        <button className="icon-btn" onClick={() => window.history.length > 1 ? window.history.back() : desk.go('stay-view')} aria-label="Back">‹</button>
        <div className="resv-guest">
          <h1>{guestName(g)}{(g.attributes ?? []).map((t) => <span key={t} className="tag on small-tag">{t}</span>)}{g.blacklisted && <span className="tag tag-claret on small-tag">Blacklisted</span>}</h1>
          <span className="muted small">{pax[0]} adult{pax[0] === 1 ? '' : 's'}{pax[1] ? ` · ${pax[1]} child${pax[1] === 1 ? '' : 'ren'}` : ''}</span>
        </div>
        <dl className="resv-facts">
          <div><dt>Arrival</dt><dd>{fmtDate(res.arrival)}</dd></div>
          <div><dt>Departure</dt><dd>
            {fmtDate(res.departure)}
            {can(role, 'res.amend') && main && ['confirmed', 'tentative', 'checked_in'].includes(main.status) && (
              <button className="link small-link" onClick={() => setDialog({ kind: 'amend', stay: main })}>Change</button>
            )}
          </dd></div>
          <div><dt>Nights</dt><dd>{nightsBetween(res.arrival, res.departure)}</dd></div>
          <div><dt>Room</dt><dd>{live.map((s) => `${s.pms_rooms?.number ?? '—'} ${s.pms_room_types?.name ?? ''}`).join(', ')}</dd></div>
          <div><dt>Reservation</dt><dd>#{res.res_no}</dd></div>
          {codes.length > 0 && <div><dt>Door code</dt><dd className="mono">{codes.map((c) => `${c.passcode}${codes.length > 1 ? ` (${c.pms_rooms?.number})` : ''}`).join(', ')}
            {can(role, 'fo.sms') && main?.status === 'checked_in' && <button className="link small-link" onClick={() => act(() => rpc('pms_send_door_code_sms', { p_stay: main.id, p_phone: null }), 'Door code sent by SMS')}>Send by SMS</button>}</dd></div>}
          <div><dt>Status</dt><dd><Badge kind={st.kind}>{st.text}</Badge></dd></div>
        </dl>
        <div className="resv-strip-actions">
          {can(role, 'fo.checkin') && main && ['confirmed', 'tentative'].includes(main.status) && main.arrival === bd && (
            <button className="btn btn-primary" disabled={busy || !main.room_id} title={main.room_id ? '' : 'Assign a room first'}
              onClick={() => run(() => rpc('pms_check_in', { p_stay: main.id, p_allow_dirty: false }), 'Checked in').then(() => { reload(); refresh(); })
                .catch((e) => { if (String(e.message).includes('ROOM_DIRTY') && can(role, 'fo.checkin_dirty') && window.confirm('This room is marked dirty. Check the guest in anyway?')) act(() => rpc('pms_check_in', { p_stay: main.id, p_allow_dirty: true }), 'Checked in'); })}>
              Check in
            </button>
          )}
          {can(role, 'fo.checkout') && main?.status === 'checked_in' && (
            <button className="btn btn-primary" onClick={() => setDialog({ kind: 'checkout', stay: main,
              onLate: (amount) => setDialog({ kind: 'roomcharge', sub: 'late_checkout', amount, folio: res.pms_folios.find((f) => f.stay_id === main.id && f.status === 'open') }) })}>Check out</button>
          )}
          {main && ((main.status === 'checked_in' && main.arrival === bd && can(role, 'fo.undo_checkin'))
            || (main.status === 'checked_out' && main.departure >= bd && can(role, 'fo.undo_checkout'))) && (
            <Menu label="More" align="right" items={[
              main.status === 'checked_in' && { label: 'Undo check-in', onClick: () => { const r = window.prompt('Why undo this check-in?'); if (r) act(() => rpc('pms_undo_check_in', { p_stay: main.id, p_reason: r }), 'Check-in undone'); } },
              main.status === 'checked_out' && { label: 'Undo check-out', onClick: () => { const r = window.prompt('Why undo this check-out?'); if (r) act(() => rpc('pms_undo_check_out', { p_stay: main.id, p_reason: r }), 'Guest is back in house'); } },
            ]} />
          )}
          <Menu label="Print / send" align="right" items={[
            folio && { label: `Print folio #${folio.folio_no}`, onClick: () => printFolio({ property, res, folio }) },
            g.email && { label: 'Email confirmation', onClick: () => window.open(mailLink(g.email, `Reservation #${res.res_no} — ${property.name}`, msg)) },
            g.phone && { label: 'Send on WhatsApp', onClick: () => window.open(waLink(g.phone, msg), '_blank') },
          ]} />
        </div>
      </header>

      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'folio', label: 'Folio' }, { value: 'booking', label: 'Booking details' }, { value: 'guest', label: 'Guest details' },
        { value: 'charges', label: 'Room charges' }, { value: 'tasks', label: 'Tasks and messages' }, { value: 'trail', label: 'Audit trail' },
      ]} />

      {tab === 'folio' && (
        <FolioTab res={res} folio={folio} setFolioId={setFolioId} totals={t} setDialog={setDialog} act={act} onPaid={() => { reload(); refresh(); }} />
      )}
      {tab === 'booking' && <BookingTab res={res} setDialog={setDialog} act={act} />}
      {tab === 'guest' && <GuestTab guest={g} onSaved={reload} />}
      {tab === 'charges' && <ChargesTab res={res} />}
      {tab === 'tasks' && <TasksTab res={res} main={main} />}
      {tab === 'trail' && <TrailTab id={res.id} version={res} />}

      {dialog && (
        <ActionDialog dialog={dialog} res={res} folio={dialog.folio ?? folio} property={property}
          onClose={() => setDialog(null)} onDone={done} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Folio
function FolioTab({ res, folio, setFolioId, totals, setDialog, act, onPaid }) {
  const { property, role, lookups } = useProperty();
  const [showVoid, setShowVoid] = useState(false);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState([]);
  const [showUnposted, setShowUnposted] = useState(true);
  const [fiscal, setFiscal] = useState({});
  useEffect(() => {
    const ids = (folio?.pms_folio_lines ?? []).filter((l) => l.line_type === 'payment').map((l) => l.id);
    if (!ids.length) { setFiscal({}); return; }
    supabase.from('pms_fiscal_receipts').select('folio_line_id, status, receipt_no, verify_url').in('folio_line_id', ids)
      .then(({ data }) => setFiscal(Object.fromEntries((data ?? []).map((r) => [r.folio_line_id, r]))));
  }, [folio]);
  const openFolios = res.pms_folios.filter((f) => f.status === 'open');

  // Folio tree: room type → room → folios
  const tree = useMemo(() => {
    const groups = {};
    for (const s of res.pms_stays) {
      const type = s.pms_room_types?.name ?? 'Room';
      groups[type] ??= [];
      groups[type].push({ stay: s, folios: res.pms_folios.filter((f) => f.stay_id === s.id) });
    }
    return groups;
  }, [res]);

  const rows = useMemo(() => {
    if (!folio) return [];
    let running = 0;
    const posted = folio.pms_folio_lines
      .filter((l) => showVoid || !l.voided)
      .map((l) => {
        if (!l.voided) running += Number(l.amount);
        return { ...l, running, posted: true };
      });
    if (!showUnposted || folio.status !== 'open') return posted;
    const isFirstFolioOfStay = res.pms_folios.filter((f) => f.stay_id === folio.stay_id)[0]?.id === folio.id;
    const stay = res.pms_stays.find((s) => s.id === folio.stay_id);
    const future = stay && isFirstFolioOfStay ? unpostedNights(stay, res) : [];
    return [...posted, ...future.map((u) => {
      running += u.amount;
      return { id: 'u' + u.date, business_date: u.date, category: 'room', line_type: 'charge', description: `Room ${stay.pms_rooms?.number ?? ''} — ${stay.pms_room_types?.name}`, amount: u.amount, running, posted: false };
    })];
  }, [folio, res, showVoid, showUnposted]);

  const cashier = folio?.status === 'open';

  return (
    <div className="folio-shell">
      <aside className="folio-tree">
        <div className="folio-tree-head">
          <span>Rooms and folios</span>
          {can(role, 'cash.folio') && res.pms_stays.some((s) => ['tentative', 'confirmed', 'checked_in'].includes(s.status)) && (
            <button className="icon-btn" title="Add a folio" aria-label="Add a folio" onClick={() => act(async () => {
              const s = res.pms_stays.find((x) => x.id === folio?.stay_id) ?? res.pms_stays[0];
              const id = await rpc('pms_add_folio', { p_stay: s.id, p_company: res.company_id });
              setFolioId(id);
            }, 'Folio added')}><Icon name="plus" size={16} /></button>
          )}
        </div>
        <div className="folio-tree-body">
          {Object.entries(tree).map(([type, stays]) => (
            <div key={type} className="ft-type">
              <div className="ft-type-name">{type}</div>
              {stays.map(({ stay, folios }) => (
                <div key={stay.id} className="ft-room">
                  <div className="ft-room-no">
                    <span>{stay.pms_rooms?.number ?? 'Unassigned'}</span>
                    <Badge kind={statusKind(stay.status)}>{label(stay.status)}</Badge>
                  </div>
                  {folios.map((f) => (
                    <button key={f.id} className={`ft-folio ${f.id === folio?.id ? 'active' : ''}`} onClick={() => setFolioId(f.id)}>
                      <span className="ft-folio-name">#{f.folio_no} · {f.company_id ? res.pms_companies?.name ?? 'Company' : guestName(res.pms_guests)}</span>
                      <span className="ft-folio-bal">{f.status === 'closed' ? 'Closed' : bal(f.balance)}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
        <dl className="totals tree-totals">
          <dt>Charges posted</dt><dd>{money(totals.charges)}</dd>
          <dt>Still to post</dt><dd>{money(totals.unposted)}</dd>
          <dt>Paid</dt><dd>{money(totals.credits)}</dd>
          <dt className={totals.total - totals.credits > 0 ? 'owing' : ''}>Due at check-out</dt>
          <dd className={totals.total - totals.credits > 0 ? 'owing' : ''}>{property.currency} {money(totals.total - totals.credits)}</dd>
        </dl>
      </aside>

      <section className="folio-main">
        {folio && (
          <>
            <div className="folio-bar">
              {picking ? (
                <div className="row-gap pick-bar">
                  <strong>{picked.length} line{picked.length === 1 ? '' : 's'} chosen</strong>
                  <button className="btn btn-primary" disabled={!picked.length} onClick={() => act(async () => {
                    const id = await rpc('pms_split_folio', { p_folio: folio.id, p_lines: picked }); setPicking(false); setPicked([]); setFolioId(id);
                  }, 'Moved to a new folio')}>Move to a new folio</button>
                  <button className="btn" onClick={() => { setPicking(false); setPicked([]); }}>Cancel</button>
                </div>
              ) : (
                <div className="row-gap folio-groups">
                  {cashier && can(role, 'cash.payment') && <button className="btn btn-primary" onClick={() => setDialog({ kind: 'payment', folio })}>Add payment</button>}
                  {cashier && can(role, 'cash.charge') && <button className="btn" onClick={() => setDialog({ kind: 'charge', folio })}>Add charge</button>}
                  {cashier && can(role, 'cash.discount') && <button className="btn" onClick={() => setDialog({ kind: 'discount', folio })}>Apply discount</button>}
                  {cashier && can(role, 'cash.room_charge') && <button className="btn" onClick={() => setDialog({ kind: 'roomcharge', folio })}>Room charges</button>}
                  {cashier && can(role, 'cash.folio') && <button className="btn" onClick={() => setPicking(true)}>Split folio</button>}
                  {cashier && <Menu label="More" items={[
                    can(role, 'cash.charge') && lookups.mealPlans.some((m) => m.active && Number(m.adult_rate) > 0) && { label: 'Meal plan…', onClick: () => setDialog({ kind: 'mealplan', folio }) },
                    can(role, 'cash.paid_out') && { label: 'Pay out cash for the guest…', onClick: () => setDialog({ kind: 'paidout', folio }) },
                    can(role, 'cash.adjustment') && { label: 'Adjustment…', onClick: () => setDialog({ kind: 'adjustment', folio }) },
                    can(role, 'cash.folio') && { label: 'Cut folio from a date…', onClick: () => setDialog({ kind: 'cut', folio }) },
                    folio.balance < 0 && can(role, 'cash.payment') && { label: 'Refund the credit…', onClick: () => setDialog({ kind: 'refund', folio }) },
                  ].filter(Boolean)} />}
                  {folio.status === 'closed' && <span className="muted">Folio #{folio.folio_no} is closed.</span>}
                </div>
              )}
              <div className="row-gap folio-toggles">
                <label className="check small"><input type="checkbox" checked={showUnposted} onChange={(e) => setShowUnposted(e.target.checked)} /><i className="key key-unposted" /> Nights still to post</label>
                <label className="check small"><input type="checkbox" checked={showVoid} onChange={(e) => setShowVoid(e.target.checked)} /> Voided lines</label>
              </div>
            </div>
            <PhoneRequests folio={folio} onPaid={onPaid} />
            <div className={`folio-receipt ${folio.balance > 0 ? 'owing' : 'settled'}`}>
              <div className="receipt-head">
                <div>
                  <div className="receipt-prop">{property.name}</div>
                  <div className="receipt-sub">Folio #{folio.folio_no} · {folio.company_id ? res.pms_companies?.name ?? 'Company' : guestName(res.pms_guests)}
                    {(() => { const st = res.pms_stays.find((x) => x.id === folio.stay_id); return st?.pms_rooms?.number ? ` · Room ${st.pms_rooms.number}` : ''; })()} · {fmtDate(res.arrival, { day: '2-digit', month: 'short' })} – {fmtDate(res.departure, { day: '2-digit', month: 'short', year: 'numeric' })}</div>
                </div>
                <div className="receipt-no">Reservation #{res.res_no}{folio.status === 'closed' && <span className="receipt-closed">Closed</span>}</div>
              </div>
              <div className="receipt-body">
              <table className="table folio-ledger">
                <thead>
                  <tr>{picking && <th />}<th>Day</th><th>Receipt</th><th>Particulars</th><th>Description</th><th>Posted by</th><th className="num">Amount</th><th className="num">Balance</th><th /></tr>
                </thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={picking ? 9 : 8} className="center muted">Nothing on this folio yet. Room charges post at night audit.</td></tr>}
                  {rows.map((l) => (
                    <tr key={l.id} className={`${l.voided ? 'voided' : ''} ${l.posted ? '' : 'unposted'}`}>
                      {picking && <td>{l.posted && !l.voided && <input type="checkbox" aria-label={`Choose ${l.description}`} checked={picked.includes(l.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, l.id] : picked.filter((x) => x !== l.id))} />}</td>}
                      <td className="nowrap">{fmtDate(l.business_date, { weekday: 'short', day: '2-digit', month: 'short' })}</td>
                      <td className="nowrap">{l.receipt_no ? <span className="receipt">R{String(l.receipt_no).padStart(5, '0')}</span> : ''}
                        {fiscal[l.id] && <div className={`small ${fiscal[l.id].status === 'failed' ? 'danger' : 'muted'}`} title="TRA fiscal receipt">
                          {['issued', 'manual'].includes(fiscal[l.id].status) ? `EFD ${fiscal[l.id].receipt_no}` : fiscal[l.id].status === 'failed' ? 'EFD failed' : 'EFD pending'}</div>}</td>
                      <td>{l.line_type === 'payment' ? l.payment_method_name ?? METHOD[l.payment_method] ?? 'Payment' : l.line_type === 'refund' ? `Refund · ${l.payment_method_name ?? METHOD[l.payment_method] ?? ''}` : SUB[l.sub_type] ?? PARTICULARS[l.category] ?? label(l.category)}</td>
                      <td className="desc">
                        {l.line_type === 'payment' || l.line_type === 'refund' ? (l.reference || <span className="muted">No reference</span>)
                          : l.source === 'night_audit' ? l.description.replace(/ — \d{2} \w{3} \d{4}$/, '') : l.description}
                        {l.voided && <div className="small danger">Voided: {l.void_reason}</div>}
                        {!l.posted && <div className="small muted">Posts at night audit</div>}
                      </td>
                      <td className="muted">{l.posted ? l.user : ''}</td>
                      <td className={`num ${l.amount < 0 ? 'credit' : ''}`}>{l.amount < 0 ? '−' : ''}{money(Math.abs(l.amount))}</td>
                      <td className="num muted">{l.voided ? '' : bal(l.running)}</td>
                      <td className="row-actions">
                        {l.posted && !l.voided && folio.status === 'open' && (
                          <Menu label="⋯" caret={false} align="right" items={[
                            can(role, 'cash.void') && l.payment_method !== 'city_ledger' && { label: 'Void…', danger: true, onClick: () => setDialog({ kind: 'void', line: l, folio }) },
                            l.line_type === 'charge' && can(role, 'cash.transfer') && openFolios.filter((f) => f.id !== folio.id).map((f) => (
                              { label: `Move to folio #${f.folio_no}`, onClick: () => act(() => rpc('pms_transfer_line', { p_line: l.id, p_to_folio: f.id }), `Moved to folio #${f.folio_no}`) }
                            )),
                          ].flat()} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <div className="receipt-foot">
                <dl className="receipt-sums">
                  <dt>Charges</dt><dd>{money(rows.filter((l) => !l.voided && l.posted && l.amount > 0).reduce((n, l) => n + Number(l.amount), 0))}</dd>
                  <dt>Payments and credits</dt><dd>−{money(Math.abs(rows.filter((l) => !l.voided && l.posted && l.amount < 0).reduce((n, l) => n + Number(l.amount), 0)))}</dd>
                </dl>
                <div className={`balance-tag ${folio.balance > 0 ? 'owing' : 'settled'}`} role="status">
                  <span className="bt-hole" aria-hidden="true" />
                  <span className="bt-label">{folio.balance > 0 ? 'Balance due' : folio.balance < 0 ? 'In credit' : 'Settled'}</span>
                  <strong className="bt-amount">{property.currency} {money(Math.abs(folio.balance))}</strong>
                </div>
                {folio.balance === 0 && rows.some((l) => l.posted && !l.voided) && <span className="paid-stamp" aria-hidden="true">Paid</span>}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ Booking
function BookingTab({ res, setDialog, act }) {
  const { property, role, lookups } = useProperty();
  const [free, setFree] = useState({});
  const [parties, setParties] = useState({ agents: [], sales: [], packages: [] });
  const [f, setF] = useState({ source: res.source_id ?? '', company: res.company_id ?? '', agent: res.travel_agent_id ?? '', sales: res.sales_person_id ?? '', notes: res.notes ?? '' });
  const [promo, setPromo] = useState('');
  const [pkg, setPkg] = useState('');
  useEffect(() => {
    Promise.all([
      supabase.from('pms_travel_agents').select('id,name,commission_pct').eq('property_id', property.id).eq('active', true).order('name'),
      supabase.from('pms_sales_persons').select('id,name').eq('property_id', property.id).eq('active', true).order('name'),
      supabase.from('pms_packages').select('id,name,price,price_mode,inclusions').eq('property_id', property.id).eq('active', true).order('name'),
    ]).then(([a, b, c]) => setParties({ agents: a.data ?? [], sales: b.data ?? [], packages: c.data ?? [] }));
  }, [property.id]);
  const loadFree = async (s) => {
    const r = await rpc('pms_free_rooms', { p_property: property.id, p_arrival: s.arrival, p_departure: s.departure, p_exclude_stay: s.id });
    setFree((m) => ({ ...m, [s.id]: r ?? [] }));
  };
  const editable = can(role, 'res.edit');
  const live = res.pms_stays.some((s) => ['tentative', 'confirmed', 'checked_in'].includes(s.status));
  const [planFor, setPlanFor] = useState(null);
  const [planPick, setPlanPick] = useState(null);
  const [moving, setMoving] = useState(null);
  const [movingBusy, setMovingBusy] = useState(false);
  return (
    <div className="two-col">
      {moving && (() => {
        const to = lookups.rooms.find((r) => r.id === moving.room);
        const st = moving.stay;
        return (
          <ChangeConfirm stay={st} busy={movingBusy} change={{ room: moving.room }} onClose={() => setMoving(null)}
            title={st.room_id ? `Move to room ${to?.number}?` : `Assign room ${to?.number}?`}
            summary={st.room_id ? `Move ${guestName(res.pms_guests)} from room ${st.pms_rooms?.number} to room ${to?.number}${st.status === 'checked_in' ? ' (the old room will be marked dirty)' : ''}.` : `Put ${guestName(res.pms_guests)} in room ${to?.number}.`}
            onConfirm={async ({ rate, reason }) => {
              setMovingBusy(true);
              try { await act(() => rpc('pms_move_room', { p_stay: st.id, p_room: moving.room, p_rate: rate, p_reason: reason || null }), st.room_id ? 'Room moved' : 'Room assigned'); setMoving(null); }
              finally { setMovingBusy(false); }
            }} />
        );
      })()}
      {planFor && (() => {
        const ok = new Map((free[planFor.id] ?? []).map((r) => [r.room_id, r]));
        return (
          <Modal wide title={`${planFor.room_id ? 'Move' : 'Assign'} a room · ${fmtDate(planFor.arrival)} to ${fmtDate(planFor.departure)}`} onClose={() => { setPlanFor(null); setPlanPick(null); }}
            footer={<><span className="muted small">{planPick ? `Room ${lookups.rooms.find((r) => r.id === planPick)?.number} · ${label(ok.get(planPick)?.hk_status ?? '')}` : 'Free rooms for these dates are lit; tap one.'}</span>
              <div className="row-gap"><button className="btn" onClick={() => { setPlanFor(null); setPlanPick(null); }}>Cancel</button>
                <button className="btn btn-primary" disabled={!planPick} onClick={() => { setMoving({ stay: planFor, room: planPick }); setPlanFor(null); setPlanPick(null); }}>
                  {planFor.room_id ? 'Move here' : 'Assign'}</button></div></>}>
            <FloorPlan rooms={lookups.rooms.filter((r) => r.active)} selected={planPick} onPick={(r) => setPlanPick(r.id)} isEnabled={(r) => ok.has(r.id) && r.id !== planFor.room_id}
              tile={(r) => {
                const f = ok.get(r.id);
                const type = lookups.roomTypes.find((t) => t.id === r.room_type_id);
                return (
                  <span className={`fp-tile ${f ? 'hk-bg-' + f.hk_status : 'fp-taken'} ${r.id === planFor.room_id ? 'fp-current' : ''}`}>
                    <strong>{r.number}</strong><span className="fp-meta">{type?.name}</span>
                    <span className="fp-status">{r.id === planFor.room_id ? 'Current' : f ? label(f.hk_status) : 'Taken'}</span>
                  </span>
                );
              }} />
          </Modal>
        );
      })()}
      <section>
        <h3 className="first">Rooms</h3>
        {res.pms_stays.map((s) => (
          <div key={s.id} className="stay-card">
            <div>
              <div><strong className="serif">{s.pms_rooms?.number ? `Room ${s.pms_rooms.number}` : 'No room yet'}</strong> <span className="muted">{s.pms_room_types?.name}</span> <Badge kind={statusKind(s.status)}>{label(s.status)}</Badge></div>
              <div className="small muted">{fmtDate(s.arrival)} to {fmtDate(s.departure)} · {s.adults} adult{s.adults === 1 ? '' : 's'}{s.children ? `, ${s.children} child` : ''} · {property.currency} {money(s.rate)} a night</div>
            </div>
            {['tentative', 'confirmed', 'checked_in'].includes(s.status) && (can(role, 'res.assign') || can(role, 'res.amend') || can(role, 'res.cancel')) && (
              <div className="stay-actions">
                {can(role, 'res.assign') && <>
                  <select aria-label="Assign or move room" value="" onFocus={() => loadFree(s)}
                    onChange={(e) => e.target.value && setMoving({ stay: s, room: e.target.value })}>
                    <option value="">{s.room_id ? 'Move to room…' : 'Assign room…'}</option>
                    {(free[s.id] ?? []).map((r) => <option key={r.room_id} value={r.room_id}>{r.number} · {r.room_type} ({label(r.hk_status)})</option>)}
                  </select>
                  <button className="btn" onClick={() => { loadFree(s); setPlanFor(s); }} title="Choose on the floor plan"><Icon name="floor" size={15} /> Plan</button>
                </>}
                {can(role, 'res.amend') && <button className="btn" onClick={() => setDialog({ kind: 'amend', stay: s })}>Amend</button>}
                {can(role, 'res.cancel') && ['tentative', 'confirmed'].includes(s.status) && <button className="btn btn-danger-ghost" onClick={() => setDialog({ kind: 'cancel', stay: s })}>Cancel</button>}
              </div>
            )}
          </div>
        ))}
        {editable && live && (
          <div className="card offers">
            <h3 className="first">Price offers</h3>
            <div className="inline-form">
              <Field label="Package">
                <select value={pkg} onChange={(e) => setPkg(e.target.value)}>
                  <option value="">Choose…</option>
                  {parties.packages.map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.price)} {p.price_mode === 'per_stay' ? 'per stay' : 'a night'}</option>)}
                </select>
              </Field>
              <button className="btn" disabled={!pkg} onClick={() => act(() => rpc('pms_apply_package', { p_reservation: res.id, p_package: pkg }), 'Package applied')}>Apply package</button>
            </div>
            <div className="inline-form">
              <Field label="Promotion code" hint={res.promotion_code ? `Applied: ${res.promotion_code}` : undefined}>
                <input value={promo} disabled={!!res.promotion_code} onChange={(e) => setPromo(e.target.value.toUpperCase())} placeholder="e.g. KARIBU10" />
              </Field>
              <button className="btn" disabled={!promo || !!res.promotion_code} onClick={() => act(() => rpc('pms_apply_promotion', { p_reservation: res.id, p_code: promo }), `Promotion ${promo} applied`)}>Apply code</button>
            </div>
            <p className="small muted">Offers change the nightly rate for nights not yet charged.</p>
          </div>
        )}
      </section>
      <section>
        <h3 className="first">Booking</h3>
        <form className="card" onSubmit={(e) => { e.preventDefault(); act(() => rpc('pms_update_reservation', {
          p_reservation: res.id, p_source_id: f.source || null, p_company_id: f.company || null, p_travel_agent_id: f.agent || null, p_sales_person_id: f.sales || null, p_notes: f.notes,
        }), 'Booking details saved'); }}>
          <dl className="facts plain">
            <dt>Reservation</dt><dd>#{res.res_no}{res.external_ref ? <span className="muted"> · channel ref {res.external_ref}</span> : null}</dd>
            <dt>Booked</dt><dd>{fmtDateTime(res.created_at)}</dd>
            <dt>Rate plan</dt><dd>{res.pms_rate_plans ? `${res.pms_rate_plans.name} (${res.pms_rate_plans.meal_plan})` : '—'}</dd>
          </dl>
          <fieldset disabled={!editable} className="stack">
            <Field label="Business source"><select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}><option value="">—</option>{lookups.sources.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field label="Bill to company" hint="Lets you move the balance to the company's account at check-out"><select value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })}><option value="">Guest pays</option>{lookups.companies.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field label="Travel agent"><select value={f.agent} onChange={(e) => setF({ ...f, agent: e.target.value })}><option value="">—</option>{parties.agents.map((x) => <option key={x.id} value={x.id}>{x.name} ({Number(x.commission_pct)}%)</option>)}</select></Field>
            <Field label="Sales person"><select value={f.sales} onChange={(e) => setF({ ...f, sales: e.target.value })}><option value="">—</option>{parties.sales.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
            <Field label="Notes and requests"><textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
            {editable && <button className="btn btn-primary">Save booking details</button>}
          </fieldset>
        </form>
        <BookingExtras res={res} act={act} editable={editable} />
        <Files res={res} />
      </section>
    </div>
  );
}

// Segment, booking type, transport, outlet charges and credit limit
function BookingExtras({ res, act, editable }) {
  const { property, role, lookups } = useProperty();
  const main = res.pms_stays.find((s) => !['cancelled', 'no_show'].includes(s.status)) ?? res.pms_stays[0];
  const [f, setF] = useState({
    market_segment_id: res.market_segment_id ?? '', reservation_type_id: res.reservation_type_id ?? '',
    pickup: res.pickup ?? null, dropoff: res.dropoff ?? null, allow_pos: main?.allow_pos ?? true, credit_limit: main?.credit_limit ?? '',
  });
  const [bills, setBills] = useState([]);
  useEffect(() => {
    supabase.from('pms_pos_bills').select('id, bill_no, status, total, table_no, created_at, pms_pos_outlets(name)').in('stay_id', res.pms_stays.map((x) => x.id)).order('created_at', { ascending: false })
      .then(({ data }) => setBills(data ?? []));
  }, [res]);
  const leg = (k, title) => {
    const v = f[k];
    const t = lookups.transportTypes.find((x) => x.id === v?.type_id);
    return (
      <div className="transport-leg">
        <div className="row-gap"><strong>{title}</strong>{v?.posted && <span className="badge badge-teal">Charged</span>}</div>
        <div className="grid-3">
          <Field label="Service"><select value={v?.type_id ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value ? { ...(v ?? {}), type_id: e.target.value } : null })}>
            <option value="">None</option>{lookups.transportTypes.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name} · {money(x.rate)}</option>)}</select></Field>
          {v && <Field label="When"><input type="datetime-local" value={v.at ?? ''} onChange={(e) => setF({ ...f, [k]: { ...v, at: e.target.value } })} /></Field>}
          {v && <Field label="Flight / notes"><input value={v.flight ?? ''} onChange={(e) => setF({ ...f, [k]: { ...v, flight: e.target.value } })} placeholder="TC 105, 2 bags" /></Field>}
        </div>
        {v && !v.posted && res.pickup?.type_id && k === 'pickup' && can(role, 'cash.charge') && <button type="button" className="link" onClick={() => act(() => rpc('pms_post_transport', { p_reservation: res.id, p_leg: k }), `${t?.name ?? 'Transport'} charged`)}>Charge it to the folio</button>}
        {v && !v.posted && res.dropoff?.type_id && k === 'dropoff' && can(role, 'cash.charge') && <button type="button" className="link" onClick={() => act(() => rpc('pms_post_transport', { p_reservation: res.id, p_leg: k }), `${t?.name ?? 'Transport'} charged`)}>Charge it to the folio</button>}
      </div>
    );
  };
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); act(() => rpc('pms_set_booking_details', { p_reservation: res.id, p: {
      market_segment_id: f.market_segment_id, reservation_type_id: f.reservation_type_id, pickup: f.pickup, dropoff: f.dropoff, allow_pos: f.allow_pos,
      ...(can(role, 'fo.credit_limit') ? { credit_limit: f.credit_limit === '' ? '' : String(f.credit_limit) } : {}),
    } }), 'Saved'); }}>
      <h3 className="first">Stay details</h3>
      <fieldset disabled={!editable} className="stack">
        <div className="grid-2">
          <Field label="Market segment"><select value={f.market_segment_id} onChange={(e) => setF({ ...f, market_segment_id: e.target.value })}><option value="">—</option>
            {lookups.marketSegments.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <Field label="Booking type"><select value={f.reservation_type_id} onChange={(e) => setF({ ...f, reservation_type_id: e.target.value })}><option value="">—</option>
            {lookups.reservationTypes.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        </div>
        {lookups.transportTypes.some((x) => x.active) && <>{leg('pickup', 'Pick-up')}{leg('dropoff', 'Drop-off')}</>}
        <h4>Restaurant, bar and activities</h4>
        <label className="check"><input type="checkbox" checked={f.allow_pos} onChange={(e) => setF({ ...f, allow_pos: e.target.checked })} /> Outlets may charge bills to this room</label>
        {can(role, 'fo.credit_limit') && <Field label={`Credit limit (${property.currency})`} hint="Room charges stop once the balance passes this. Empty = no limit."><input inputMode="decimal" value={f.credit_limit ?? ''} onChange={(e) => setF({ ...f, credit_limit: e.target.value.replace(/[^\d.]/g, '') })} /></Field>}
        {editable && <button className="btn btn-primary">Save stay details</button>}
      </fieldset>
      {bills.length > 0 && <>
        <h4>Outlet bills</h4>
        <Table rows={bills} columns={[
          { key: 'bill_no', label: 'Bill', render: (b) => `#${b.bill_no}` }, { key: 'outlet', label: 'Outlet', render: (b) => b.pms_pos_outlets?.name },
          { key: 'status', label: 'Status', render: (b) => <Badge kind={b.status === 'open' ? 'amber' : b.status === 'room' ? 'blue' : b.status === 'void' ? 'grey' : 'teal'}>{b.status === 'open' ? 'Open tab' : b.status === 'room' ? 'On the folio' : label(b.status)}</Badge> },
          { key: 'total', label: 'Total', num: true, render: (b) => money(b.total) },
        ]} />
      </>}
    </form>
  );
}

// Passport scans, contracts, vouchers: private files kept with the booking
function Files({ res }) {
  const { property, role } = useProperty();
  const [run, busy] = useAction();
  const [rows, setRows] = useState([]);
  const load = useCallback(() => supabase.from('pms_attachments').select('*').eq('reservation_id', res.id).order('created_at', { ascending: false }).then(({ data }) => setRows(data ?? [])), [res.id]);
  useEffect(() => { load(); }, [load]);
  if (!can(role, 'frontoffice')) return null;
  const upload = (file) => run(async () => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) throw new Error('Files must be under 10 MB');
    const path = `${property.id}/reservations/${res.id}/${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`;
    const { error } = await supabase.storage.from('pms-files').upload(path, file, { contentType: file.type });
    if (error) throw error;
    await rpc('pms_add_attachment', { p_reservation: res.id, p_path: path, p_name: file.name, p_size: file.size, p_type: file.type || 'application/octet-stream' });
    load();
  }, 'File added').catch(() => {});
  const open = async (a) => {
    const { data, error } = await supabase.storage.from('pms-files').createSignedUrl(a.path, 120);
    if (!error) window.open(data.signedUrl, '_blank', 'noopener');
  };
  return (
    <div className="card">
      <div className="row-gap"><h3 className="first">Files</h3>
        <label className="btn btn-small">Add a file<input type="file" hidden disabled={busy} onChange={(e) => upload(e.target.files[0])} /></label></div>
      {rows.length === 0 ? <p className="small muted">ID scans, company letters, vouchers. Private to front office staff.</p> : (
        <ul className="file-list">{rows.map((a) => (
          <li key={a.id}><button className="link" onClick={() => open(a)}>{a.file_name}</button> <span className="small muted">{Math.ceil((a.size_bytes ?? 0) / 1024)} KB · {fmtDateTime(a.created_at)}</span>
            {can(role, 'fo.files_delete') && <button className="link danger" onClick={() => run(async () => { const path = await rpc('pms_remove_attachment', { p_id: a.id }); await supabase.storage.from('pms-files').remove([path]); load(); }, 'File removed').catch(() => {})}>Remove</button>}</li>
        ))}</ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Guest
function GuestTab({ guest, onSaved }) {
  const { role, property, lookups } = useProperty();
  const [run, busy] = useAction();
  const [g, setG] = useState({ ...guest, attributes: guest.attributes ?? [] });
  const set = (k) => (e) => setG({ ...g, [k]: e.target.value });
  const editable = ['owner', 'manager', 'front_desk'].includes(role);
  const titles = property.settings?.salutations ?? ['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.'];
  const ids = property.settings?.id_types ?? ['Passport', 'National ID (NIDA)', 'Driving licence', 'Voter ID'];
  const tags = lookups.guestAttributes.filter((x) => x.active);
  return (
    <form className="card" onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        const patch = {
          title: g.title, first_name: g.first_name, last_name: g.last_name, phone: g.phone, email: g.email,
          nationality: g.nationality, id_type: g.id_type, id_number: g.id_number, address: g.address, notes: g.notes,
          date_of_birth: g.date_of_birth || null, gender: g.gender || null, attributes: g.attributes,
        };
        if (can(role, 'fo.blacklist')) Object.assign(patch, { blacklisted: !!g.blacklisted, blacklist_reason: g.blacklist_reason || null });
        const { error } = await supabase.from('pms_guests').update(patch).eq('id', g.id);
        if (error) throw error;
        onSaved();
      }, 'Guest details saved').catch(() => {});
    }}>
      {g.blacklisted && <div className="note warn"><strong>Blacklisted.</strong> {g.blacklist_reason}</div>}
      <fieldset disabled={!editable} className="grid-4">
        <Field label="Title"><select value={g.title ?? ''} onChange={set('title')}><option value="">—</option>{[...new Set([...titles, g.title].filter(Boolean))].map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="First name"><input required value={g.first_name} onChange={set('first_name')} /></Field>
        <Field label="Last name"><input value={g.last_name ?? ''} onChange={set('last_name')} /></Field>
        <Field label="Nationality"><input value={g.nationality ?? ''} onChange={set('nationality')} /></Field>
        <Field label="Phone"><input type="tel" value={g.phone ?? ''} onChange={set('phone')} /></Field>
        <Field label="Email"><input type="email" value={g.email ?? ''} onChange={set('email')} /></Field>
        <Field label="Date of birth"><input type="date" value={g.date_of_birth ?? ''} onChange={set('date_of_birth')} /></Field>
        <Field label="Gender"><select value={g.gender ?? ''} onChange={set('gender')}><option value="">—</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></Field>
        <Field label="ID document"><select value={g.id_type ?? ''} onChange={set('id_type')}><option value="">—</option>{[...new Set([...ids, g.id_type].filter(Boolean))].map((t) => <option key={t}>{t}</option>)}</select></Field>
        <Field label="ID number"><input value={g.id_number ?? ''} onChange={set('id_number')} /></Field>
        <Field label="Address" span={2}><input value={g.address ?? ''} onChange={set('address')} /></Field>
        <Field label="Preferences and notes" span={4}><input value={g.notes ?? ''} onChange={set('notes')} /></Field>
      </fieldset>
      {tags.length > 0 && (
        <div className="tag-pick">
          <span className="small muted">Tags</span>
          {tags.map((t) => {
            const on = g.attributes.includes(t.name);
            return <button type="button" key={t.id} disabled={!editable} className={`tag tag-${t.color} ${on ? 'on' : ''}`} aria-pressed={on}
              onClick={() => setG({ ...g, attributes: on ? g.attributes.filter((x) => x !== t.name) : [...g.attributes, t.name] })}>{t.name}</button>;
          })}
        </div>
      )}
      {can(role, 'fo.blacklist') && (
        <div className="inline-form">
          <label className="check"><input type="checkbox" checked={!!g.blacklisted} onChange={(e) => setG({ ...g, blacklisted: e.target.checked })} /> Blacklist (only people allowed to book blacklisted guests can book them)</label>
          {g.blacklisted && <Field label="Why"><input value={g.blacklist_reason ?? ''} onChange={set('blacklist_reason')} /></Field>}
        </div>
      )}
      {editable && <button className="btn btn-primary" disabled={busy}>Save guest details</button>}
    </form>
  );
}

// ------------------------------------------------------------------ Room charges
function ChargesTab({ res }) {
  const { property } = useProperty();
  const lines = res.pms_folios.flatMap((f) => f.pms_folio_lines);
  const rows = res.pms_stays.filter((s) => s.status !== 'cancelled').flatMap((s) =>
    Array.from({ length: nightsBetween(s.arrival, s.departure) }, (_, i) => {
      const iso = addDays(s.arrival, i);
      const line = lines.find((l) => l.stay_id === s.id && l.business_date === iso && l.category === 'room' && l.source === 'night_audit' && !l.voided);
      const status = line ? 'Posted' : s.status === 'no_show' ? 'Not charged' : s.status === 'checked_out' ? 'Not charged (left early)' : 'To post';
      return { id: s.id + iso, date: iso, room: s.pms_rooms?.number ?? '—', type: s.pms_room_types?.name, rate: line ? Number(line.amount) : Number(s.rate), status };
    }));
  const total = rows.filter((r) => !r.status.startsWith('Not')).reduce((n, r) => n + r.rate, 0);
  return (
    <Table rows={rows} empty="No nights on this reservation" footer={{ date: 'Total', rate: `${property.currency} ${money(total)}` }} columns={[
      { key: 'date', label: 'Night of', render: (r) => <>{fmtDate(r.date)} <span className="muted small">{dayName(r.date)}</span></> },
      { key: 'room', label: 'Room', render: (r) => <span className="serif">{r.room}</span> },
      { key: 'type', label: 'Type' },
      { key: 'status', label: 'Status', render: (r) => <Badge kind={r.status === 'Posted' ? 'green' : r.status === 'To post' ? 'amber' : 'grey'}>{r.status}</Badge> },
      { key: 'rate', label: 'Rate', num: true, render: (r) => money(r.rate) },
    ]} />
  );
}

// ------------------------------------------------------------------ Tasks
function TasksTab({ res, main }) {
  return <><TaskList res={res} main={main} /><MessageList res={res} /></>;
}

function TaskList({ res, main }) {
  const { property, user } = useProperty();
  const [run, busy] = useAction();
  const [rows, setRows] = useState(null);
  const [f, setF] = useState({ title: '', due_date: '', assigned_to: '' });
  const load = () => supabase.from('pms_work_orders').select('*').eq('reservation_id', res.id).order('created_at', { ascending: false })
    .then(({ data }) => setRows(data ?? []));
  useEffect(() => { load(); }, [res.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const setStatus = (w, status) => run(async () => {
    const { error } = await supabase.from('pms_work_orders').update({ status, completed_at: status === 'done' ? new Date().toISOString() : null }).eq('id', w.id);
    if (error) throw error; load();
  }).catch(() => {});
  return (
    <>
      <form className="card inline-form" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const { error } = await supabase.from('pms_work_orders').insert({
            property_id: property.id, reservation_id: res.id, room_id: main?.room_id ?? null, title: f.title,
            category: 'housekeeping', priority: 'normal', status: 'open', assigned_to: f.assigned_to || null, due_date: f.due_date || null, created_by: user.id,
          });
          if (error) throw error;
          setF({ title: '', due_date: '', assigned_to: '' }); load();
        }, 'Task added').catch(() => {});
      }}>
        <Field label="Task"><input required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Airport pickup at 18:00" /></Field>
        <Field label="Due"><input type="date" value={f.due_date} onChange={(e) => setF({ ...f, due_date: e.target.value })} /></Field>
        <Field label="Assigned to"><input value={f.assigned_to} onChange={(e) => setF({ ...f, assigned_to: e.target.value })} /></Field>
        <button className="btn btn-primary" disabled={busy}>Add task</button>
      </form>
      <Table rows={rows} empty="No tasks for this reservation" columns={[
        { key: 'title', label: 'Task' },
        { key: 'assigned_to', label: 'Assigned to' },
        { key: 'due_date', label: 'Due', render: (w) => fmtDate(w.due_date) },
        { key: 'status', label: 'Status', render: (w) => <Badge kind={statusKind(w.status)}>{label(w.status)}</Badge> },
        { key: 'act', label: '', render: (w) => w.status !== 'done' && <button className="link" onClick={() => setStatus(w, 'done')}>Mark done</button> },
      ]} />
    </>
  );
}

function MessageList({ res }) {
  const { property, user } = useProperty();
  const [run, busy] = useAction();
  const [rows, setRows] = useState(null);
  const [f, setF] = useState({ from: '', message: '' });
  const load = () => supabase.from('pms_guest_messages').select('*').eq('reservation_id', res.id).order('created_at', { ascending: false }).then(({ data }) => setRows(data ?? []));
  useEffect(() => { load(); }, [res.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <h3>Messages for the guest</h3>
      <form className="card inline-form" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const { error } = await supabase.from('pms_guest_messages').insert({ property_id: property.id, reservation_id: res.id, from_name: f.from || null, message: f.message, taken_by: user.id });
          if (error) throw error; setF({ from: '', message: '' }); load();
        }, 'Message saved').catch(() => {});
      }}>
        <Field label="From"><input value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="Message"><input required value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
        <button className="btn btn-primary" disabled={busy}>Save message</button>
      </form>
      <Table rows={rows} empty="No messages" columns={[
        { key: 'created_at', label: 'Taken', render: (m) => fmtDateTime(m.created_at) },
        { key: 'from_name', label: 'From' },
        { key: 'message', label: 'Message' },
        { key: 'status', label: '', render: (m) => (m.status === 'pending'
          ? <button className="link" onClick={() => run(async () => { const { error } = await supabase.from('pms_guest_messages').update({ status: 'delivered', delivered_at: new Date().toISOString() }).eq('id', m.id); if (error) throw error; load(); }, 'Delivered').catch(() => {})}>Mark delivered</button>
          : <Badge kind="grey">Delivered</Badge>) },
      ]} />
    </>
  );
}

// ------------------------------------------------------------------ Audit trail
const ACTIONS = {
  'reservation.create': 'Reservation created', 'stay.check_in': 'Checked in', 'stay.check_out': 'Checked out',
  'stay.assign_room': 'Room assigned', 'stay.amend': 'Stay amended', 'stay.cancel': 'Cancelled', 'stay.no_show': 'Marked no-show',
  'folio.charge': 'Charge posted', 'folio.payment': 'Payment received', 'folio.refund': 'Refund paid', 'folio.discount': 'Discount given',
  'folio.void': 'Line voided', 'folio.transfer': 'Line moved',
};
function TrailTab({ id, version }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { rpc('pms_reservation_trail', { p_reservation: id }).then(setRows).catch(() => setRows([])); }, [id, version]);
  const describe = (d) => {
    if (!d) return '';
    const parts = [];
    if (d.amount !== undefined) parts.push(money(Math.abs(d.amount)));
    if (d.method) parts.push(METHOD[d.method] ?? d.method);
    if (d.category) parts.push(PARTICULARS[d.category] ?? d.category);
    if (d.from && d.to) parts.push(`${d.from} → ${d.to}`);
    if (d.to && !d.from) parts.push(`to ${d.to}`);
    if (d.departure && d.old_departure && d.departure !== d.old_departure) parts.push(`departure ${fmtDate(d.old_departure)} → ${fmtDate(d.departure)}`);
    if (d.reason) parts.push(d.reason);
    if (d.folio_no) parts.push(`folio #${d.folio_no}`);
    return parts.join(' · ');
  };
  return (
    <Table rows={rows} empty="No activity recorded" columns={[
      { key: 'at', label: 'When', render: (r) => fmtDateTime(r.at) },
      { key: 'user_name', label: 'By' },
      { key: 'action', label: 'What', render: (r) => ACTIONS[r.action] ?? r.action },
      { key: 'details', label: 'Details', render: (r) => <span className="muted">{describe(r.details)}</span> },
      { key: 'ip', label: 'IP address', render: (r) => <span className="mono small">{r.ip ?? ''}</span> },
    ]} />
  );
}
