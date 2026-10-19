import { useEffect, useState } from 'react';
import { rpc } from '../lib/supabase';
import { Field } from '../components/ui.jsx';
import { GUEST_PAYMENTS } from '../lib/modules.js';

// The hotel's own public booking page: #/book/<property code>. No sign-in.
const iso = (d) => d.toISOString().slice(0, 10);
const plus = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return iso(d); };
const fmt = (n) => Number(n ?? 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const nice = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const POLICY_NAMES = { hotel: 'House rules', cancellation: 'Cancellation', checkin: 'Check-in', parking: 'Parking and arrival', family: 'Children and extra guests', terms: 'Terms and conditions' };

export default function BookingPage({ code }) {
  const [p, setP] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState(null);
  const [offers, setOffers] = useState(null);
  const [busy, setBusy] = useState(false);
  const [chosen, setChosen] = useState(null);
  const [g, setG] = useState({ first_name: '', last_name: '', email: '', phone: '', nationality: '', requests: '', arrival_time: '', rooms: 1, accept_terms: false, pay_now: false });
  const [done, setDone] = useState(null);
  const [photo, setPhoto] = useState(0);

  useEffect(() => {
    rpc('pms_public_property', { p_code: code }).then((r) => {
      setP(r);
      const a = r.business_date > iso(new Date()) ? r.business_date : iso(new Date());
      setQ({ arrival: a, departure: plus(a, 1), adults: 2, children: 0 });
      document.title = `Book ${r.name}`;
    }).catch((e) => setErr(e.message));
  }, [code]);

  const search = async (e) => {
    e?.preventDefault();
    setBusy(true); setErr(''); setChosen(null);
    try { setOffers(await rpc('pms_public_availability', { p_code: code, p_arrival: q.arrival, p_departure: q.departure, p_adults: Number(q.adults), p_children: Number(q.children) })); }
    catch (x) { setErr(x.message); setOffers(null); } finally { setBusy(false); }
  };
  const book = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      setDone(await rpc('pms_public_book', { p_code: code, p: { ...q, ...g, rooms: Number(g.rooms), room_type_id: chosen.room_type_id, rate_plan_id: chosen.rate_plan_id } }));
      window.scrollTo(0, 0);
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };

  if (err && !p) return <div className="bk"><div className="bk-card bk-center"><h1>Online booking</h1><p>{err}</p></div></div>;
  if (!p || !q) return <div className="bk"><div className="bk-card bk-center"><p>Loading…</p></div></div>;
  const be = p.booking ?? {};
  const photos = p.photos ?? [];
  const policies = Object.entries(p.policies ?? {}).filter(([, v]) => v);
  const nights = Math.max(1, Math.round((new Date(q.departure) - new Date(q.arrival)) / 86400000));

  return (
    <div className="bk">
      <header className="bk-head">
        {p.logo_url ? <img src={p.logo_url} alt="" className="bk-logo" /> : <span className="brand-mark light" aria-hidden="true">{p.name[0]}</span>}
        <div>
          <h1>{p.name}</h1>
          <p>{[p.property_type, p.star_rating, p.address].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="bk-contact">{p.phone && <a href={`tel:${p.phone}`}>{p.phone}</a>}{p.email && <a href={`mailto:${p.email}`}>{p.email}</a>}</div>
      </header>

      {done ? (
        <section className="bk-card bk-done">
          <h2>Asante! Your booking is {done.status === 'tentative' ? 'received' : 'confirmed'}.</h2>
          <p className="bk-big">Reservation <strong>#{done.res_no}</strong></p>
          <p>{done.rooms} × {done.room_type} · {nice(done.arrival)} to {nice(done.departure)}</p>
          <p>Total {done.currency} {fmt(done.total)}{p.tax_inclusive ? ' including tax' : ' plus tax'}, payable at the hotel unless paid below.</p>
          {done.status === 'tentative' && <p>The hotel will confirm by phone or email shortly.</p>}
          {done.payment_request && <p className="bk-pay">A payment request for {done.currency} {fmt(done.payment_request.amount)} was sent to {done.payment_request.phone}. Approve it with your mobile money PIN.</p>}
          <p>Check-in from {p.check_in_time}, check-out by {p.check_out_time}. We look forward to welcoming you.</p>
        </section>
      ) : <>
        {photos.length > 0 && (
          <section className="bk-photos">
            <img src={photos[photo].url} alt={photos[photo].caption ?? p.name} />
            {photos.length > 1 && <div className="bk-thumbs">{photos.map((ph, i) => (
              <button key={ph.url} className={i === photo ? 'on' : ''} onClick={() => setPhoto(i)} aria-label={`Photo ${i + 1}`}><img src={ph.url} alt="" /></button>))}</div>}
          </section>
        )}
        {be.intro && <p className="bk-intro">{be.intro}</p>}

        <form className="bk-card bk-search" onSubmit={search}>
          <Field label="Arrival"><input type="date" required min={p.business_date} value={q.arrival} onChange={(e) => setQ({ ...q, arrival: e.target.value, departure: q.departure <= e.target.value ? plus(e.target.value, 1) : q.departure })} /></Field>
          <Field label="Departure"><input type="date" required min={plus(q.arrival, 1)} value={q.departure} onChange={(e) => setQ({ ...q, departure: e.target.value })} /></Field>
          <Field label="Adults"><select value={q.adults} onChange={(e) => setQ({ ...q, adults: e.target.value })}>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n}>{n}</option>)}</select></Field>
          <Field label="Children"><select value={q.children} onChange={(e) => setQ({ ...q, children: e.target.value })}>{[0, 1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}</select></Field>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Checking…' : 'See rooms'}</button>
        </form>
        {err && <p className="bk-error" role="alert">{err}</p>}

        {offers && (
          <section className="bk-offers">
            {offers.length === 0 && <div className="bk-card">No rooms fit {q.adults} adult(s){Number(q.children) ? ` and ${q.children} child(ren)` : ''}. Try fewer guests per room or call us.</div>}
            {Object.values(offers.reduce((m, o) => { (m[o.room_type_id] ??= []).push(o); return m; }, {})).map((list) => {
              const t = p.room_types.find((x) => x.id === list[0].room_type_id) ?? {};
              const pic = photos.find((ph) => ph.room_type_id === t.id);
              return (
                <article key={t.id} className={`bk-card bk-room ${pic ? 'has-pic' : ''}`}>
                  {pic && <img src={pic.url} alt="" className="bk-room-pic" />}
                  <div className="bk-room-body">
                    <h3>{list[0].room_type}</h3>
                    <p className="bk-meta">{[t.bed_type, t.size_sqm && `${t.size_sqm} m²`, `up to ${t.max_adults} adults`].filter(Boolean).join(' · ')}</p>
                    {t.description && <p>{t.description}</p>}
                    {list.map((o) => (
                      <div key={o.rate_plan_id} className={`bk-plan ${o.available ? '' : 'off'} ${chosen?.rate_plan_id === o.rate_plan_id && chosen?.room_type_id === o.room_type_id ? 'chosen' : ''}`}>
                        <div><strong>{o.rate_plan}</strong>{o.description && <div className="bk-meta">{o.description}</div>}
                          {o.cancellation_policy && <div className="bk-meta">{o.cancellation_policy}</div>}
                          {o.available && o.rooms_left <= 2 && <div className="bk-hot">Only {o.rooms_left} left</div>}</div>
                        <div className="bk-price">{o.available ? <>
                          <span className="bk-total">{p.currency} {fmt(o.total)}</span><span className="bk-meta">{o.nights} night{o.nights === 1 ? '' : 's'} · {fmt(o.per_night)} a night</span>
                          <button className="btn btn-primary" onClick={() => { setChosen(o); setTimeout(() => document.getElementById('bk-guest')?.scrollIntoView({ behavior: 'smooth' }), 50); }}>Choose</button></>
                          : <span className="bk-meta">{o.reason}</span>}</div>
                      </div>
                    ))}
                  </div>
                </article>
              );
            })}
          </section>
        )}

        {chosen && (
          <form id="bk-guest" className="bk-card bk-form" onSubmit={book}>
            <h2>Your details</h2>
            <p>{chosen.room_type}, {chosen.rate_plan} · {nice(q.arrival)} to {nice(q.departure)} · {nights} night{nights === 1 ? '' : 's'}</p>
            <div className="bk-grid">
              <Field label="First name"><input required maxLength={60} autoComplete="given-name" value={g.first_name} onChange={(e) => setG({ ...g, first_name: e.target.value })} /></Field>
              <Field label="Last name"><input required maxLength={60} autoComplete="family-name" value={g.last_name} onChange={(e) => setG({ ...g, last_name: e.target.value })} /></Field>
              <Field label="Email"><input required type="email" maxLength={120} autoComplete="email" value={g.email} onChange={(e) => setG({ ...g, email: e.target.value })} /></Field>
              <Field label="Mobile number"><input required type="tel" maxLength={20} autoComplete="tel" placeholder="0713 000 111" value={g.phone} onChange={(e) => setG({ ...g, phone: e.target.value })} /></Field>
              <Field label="Nationality"><input maxLength={60} value={g.nationality} onChange={(e) => setG({ ...g, nationality: e.target.value })} /></Field>
              <Field label="Rooms"><select value={g.rooms} onChange={(e) => setG({ ...g, rooms: e.target.value })}>{Array.from({ length: Math.min(chosen.rooms_left, be.max_rooms ?? 3) }, (_, i) => <option key={i + 1}>{i + 1}</option>)}</select></Field>
              <Field label="Arriving around"><input maxLength={20} placeholder="e.g. 15:00" value={g.arrival_time} onChange={(e) => setG({ ...g, arrival_time: e.target.value })} /></Field>
              <Field label="Requests" span={2}><textarea rows={2} maxLength={500} value={g.requests} onChange={(e) => setG({ ...g, requests: e.target.value })} /></Field>
            </div>
            <p className="bk-total-line">Total {p.currency} {fmt(chosen.total * Number(g.rooms))}{p.tax_inclusive ? ' including tax' : ' plus tax'}</p>
            {GUEST_PAYMENTS && be.pay_now_mobile && p.currency === 'TZS' && <label className="check"><input type="checkbox" checked={g.pay_now} onChange={(e) => setG({ ...g, pay_now: e.target.checked })} /> Pay {Number(be.deposit_pct ?? 100) < 100 ? `a ${be.deposit_pct}% deposit` : 'now'} by M-Pesa, Tigo Pesa or Airtel Money (a request comes to your phone)</label>}
            {policies.length > 0 && (
              <details className="bk-policies"><summary>Hotel policies</summary>
                {policies.map(([k, v]) => <div key={k}><h4>{POLICY_NAMES[k] ?? k}</h4><p>{v}</p></div>)}
              </details>
            )}
            {(be.require_terms ?? true) && <label className="check"><input type="checkbox" required checked={g.accept_terms} onChange={(e) => setG({ ...g, accept_terms: e.target.checked })} /> I have read and accept the hotel policies</label>}
            {err && <p className="bk-error" role="alert">{err}</p>}
            <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Booking…' : 'Confirm booking'}</button>
          </form>
        )}

        {(p.highlights?.length > 0 || p.amenities?.length > 0) && (
          <section className="bk-card bk-about">
            {p.highlights?.length > 0 && <><h2>Why stay with us</h2><ul>{p.highlights.map((h) => <li key={h}>{h}</li>)}</ul></>}
            {p.amenities?.length > 0 && <><h3>Amenities</h3><div className="bk-amen">{p.amenities.map((a) => <span key={a}>{a}</span>)}</div></>}
            <p className="bk-meta">Check-in from {p.check_in_time} · check-out by {p.check_out_time}</p>
          </section>
        )}
      </>}
      <footer className="bk-foot">Booking directly with {p.name}{/^https?:\/\//i.test(p.website ?? '') ? <> · <a href={p.website} rel="noreferrer noopener" target="_blank">{p.website.replace(/^https?:\/\//, '')}</a></> : null}</footer>
    </div>
  );
}
