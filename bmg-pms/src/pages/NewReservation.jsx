import { useEffect, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { addDays, guestName, money, nightsBetween, safeTerm } from '../lib/format';
import { Field, Modal, useAction } from '../components/ui.jsx';

const TITLES = ['Mr.', 'Ms.', 'Mrs.', 'Dr.', 'Prof.', 'Eng.'];
const ID_TYPES = ['Passport', 'National ID (NIDA)', 'Driving Licence', 'Voter ID', 'Other'];

export default function NewReservation({ prefill = {}, onClose, onCreated }) {
  const { property, lookups } = useProperty();
  const [run, busy] = useAction();
  const bd = property.business_date;

  const [arrival, setArrival] = useState(prefill.arrival && prefill.arrival >= bd ? prefill.arrival : bd);
  const [departure, setDeparture] = useState(prefill.departure && prefill.departure > (prefill.arrival ?? bd) ? prefill.departure : addDays(prefill.arrival ?? bd, 1));
  const [ratePlan, setRatePlan] = useState(lookups.ratePlans.find((p) => p.active)?.id ?? '');
  const [source, setSource] = useState(lookups.sources.find((s) => s.kind === 'walk_in')?.id ?? '');
  const [company, setCompany] = useState('');
  const [status, setStatus] = useState('confirmed');
  const [notes, setNotes] = useState('');
  const [agent, setAgent] = useState('');
  const [sales, setSales] = useState('');
  const [promo, setPromo] = useState('');
  const [parties, setParties] = useState({ agents: [], sales: [] });
  useEffect(() => {
    Promise.all([
      supabase.from('pms_travel_agents').select('id,name').eq('property_id', property.id).eq('active', true).order('name'),
      supabase.from('pms_sales_persons').select('id,name').eq('property_id', property.id).eq('active', true).order('name'),
    ]).then(([a, b]) => setParties({ agents: a.data ?? [], sales: b.data ?? [] }));
  }, [property.id]);
  const [guest, setGuest] = useState({ title: 'Mr.', first_name: '', last_name: '', phone: '', email: '', nationality: 'Tanzanian', id_type: '', id_number: '' });
  const [existing, setExisting] = useState(null);
  const [guestHits, setGuestHits] = useState([]);
  const firstType = lookups.roomTypes.find((t) => t.active);
  const [lines, setLines] = useState([{
    room_type_id: prefill.room_type_id ?? firstType?.id ?? '', room_id: prefill.room_id ?? '',
    rate: '', adults: 1, children: 0,
  }]);
  const [freeRooms, setFreeRooms] = useState([]);

  const nights = Math.max(0, nightsBetween(arrival, departure));

  useEffect(() => {
    if (nights < 1) { setFreeRooms([]); return; }
    rpc('pms_free_rooms', { p_property: property.id, p_arrival: arrival, p_departure: departure })
      .then((r) => setFreeRooms(r ?? [])).catch(() => setFreeRooms([]));
  }, [property.id, arrival, departure, nights]);

  // Fill blank rates from the rate plan for the arrival date
  useEffect(() => {
    let live = true;
    Promise.all(lines.map((l) => (l.rateTouched || !l.room_type_id) ? Promise.resolve(l.rate)
      : rpc('pms_rate_for', { p_room_type: l.room_type_id, p_rate_plan: ratePlan || null, p_date: arrival, p_adults: Number(l.adults ?? 1), p_children: Number(l.children ?? 0) }).catch(() => l.rate)))
      .then((rates) => {
        if (!live) return;
        setLines((ls) => ls.map((l, i) => (l.rateTouched ? l : { ...l, rate: rates[i] ?? '' })));
      });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratePlan, arrival, lines.map((l) => `${l.room_type_id}:${l.adults}:${l.children}${l.rateTouched ? 't' : ''}`).join()]);

  // Guest lookup while typing a name or phone
  useEffect(() => {
    const term = (guest.phone || `${guest.first_name} ${guest.last_name}`).trim();
    if (existing || term.length < 3) { setGuestHits([]); return; }
    const t = setTimeout(async () => {
      const parts = [];
      const ph = safeTerm(guest.phone), fn = safeTerm(guest.first_name), ln = safeTerm(guest.last_name);
      if (ph.length >= 4) parts.push(`phone.ilike.%${ph}%`);
      if (fn.length >= 2) parts.push(`first_name.ilike.${fn}%`);
      if (ln.length >= 2) parts.push(`last_name.ilike.${ln}%`);
      if (!parts.length) return;
      const { data } = await supabase.from('pms_guests').select('*').eq('property_id', property.id).or(parts.join(',')).limit(5);
      setGuestHits(data ?? []);
    }, 300);
    return () => clearTimeout(t);
  }, [guest.first_name, guest.last_name, guest.phone, existing, property.id]);

  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const takenRoomIds = lines.map((l) => l.room_id).filter(Boolean);
  const total = lines.reduce((n, l) => n + Number(l.rate || 0) * nights, 0);

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const res = await rpc('pms_create_reservation', {
        p_property: property.id,
        p_guest: existing ? { id: existing.id } : guest,
        p_arrival: arrival, p_departure: departure,
        p_rooms: lines.map((l) => ({
          room_type_id: l.room_type_id || null, room_id: l.room_id || null,
          rate: l.rate === '' ? null : Number(l.rate), adults: Number(l.adults || 1), children: Number(l.children || 0),
        })),
        p_source_id: source || null, p_rate_plan_id: ratePlan || null, p_company_id: company || null,
        p_status: status, p_notes: notes || null,
      });
      if (agent || sales) {
        await rpc('pms_update_reservation', { p_reservation: res.reservation_id, p_source_id: source || null, p_company_id: company || null,
          p_travel_agent_id: agent || null, p_sales_person_id: sales || null, p_notes: notes || null });
      }
      if (promo.trim()) {
        try { await rpc('pms_apply_promotion', { p_reservation: res.reservation_id, p_code: promo.trim() }); }
        catch (e) { window.alert(`Reservation #${res.res_no} was created, but the promotion was not applied: ${e.message}`); }
      }
      onCreated(res.reservation_id);
    }, 'Reservation created');
  };

  return (
    <Modal title="New reservation" onClose={onClose} wide
      footer={<>
        <span className="muted">{nights} night{nights === 1 ? '' : 's'} · {lines.length} room{lines.length === 1 ? '' : 's'} · <strong>{property.currency} {money(total)}</strong></span>
        <div className="row-gap">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" form="new-res" disabled={busy || nights < 1}>{busy ? 'Saving…' : 'Create reservation'}</button>
        </div>
      </>}>
      <form id="new-res" onSubmit={submit}>
        <div className="grid-4">
          <Field label="Arrival"><input type="date" min={bd} required value={arrival} onChange={(e) => {
            setArrival(e.target.value); if (e.target.value >= departure) setDeparture(addDays(e.target.value, 1));
          }} /></Field>
          <Field label="Nights"><input type="number" min={1} value={nights} onChange={(e) => setDeparture(addDays(arrival, Math.max(1, Number(e.target.value || 1))))} /></Field>
          <Field label="Departure"><input type="date" min={addDays(arrival, 1)} required value={departure} onChange={(e) => setDeparture(e.target.value)} /></Field>
          <Field label="Status">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="confirmed">Confirmed</option><option value="tentative">Tentative</option>
            </select>
          </Field>
          <Field label="Rate plan">
            <select value={ratePlan} onChange={(e) => setRatePlan(e.target.value)}>
              {lookups.ratePlans.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.meal_plan})</option>)}
            </select>
          </Field>
          <Field label="Business source">
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">—</option>
              {lookups.sources.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Bill to company">
            <select value={company} onChange={(e) => setCompany(e.target.value)}>
              <option value="">— Guest pays —</option>
              {lookups.companies.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Promotion code"><input value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} placeholder="Optional" /></Field>
          {parties.agents.length > 0 && (
            <Field label="Travel agent"><select value={agent} onChange={(e) => setAgent(e.target.value)}><option value="">—</option>{parties.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          )}
          {parties.sales.length > 0 && (
            <Field label="Sales person"><select value={sales} onChange={(e) => setSales(e.target.value)}><option value="">—</option>{parties.sales.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
          )}
        </div>

        <h4>Rooms</h4>
        <div className="lines">
          {lines.map((l, i) => {
            const options = freeRooms.filter((r) => r.room_type_id === l.room_type_id && (!takenRoomIds.includes(r.room_id) || r.room_id === l.room_id));
            return (
              <div key={i} className="line-row">
                <Field label="Room type">
                  <select value={l.room_type_id} onChange={(e) => setLine(i, { room_type_id: e.target.value, room_id: '', rateTouched: false })}>
                    {lookups.roomTypes.filter((t) => t.active).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </Field>
                <Field label="Room">
                  <select value={l.room_id} onChange={(e) => setLine(i, { room_id: e.target.value })}>
                    <option value="">Assign later</option>
                    {options.map((r) => <option key={r.room_id} value={r.room_id}>{r.number}{r.hk_status !== 'clean' && r.hk_status !== 'inspected' ? ` (${r.hk_status})` : ''}</option>)}
                    {l.room_id && !options.some((r) => r.room_id === l.room_id) && <option value={l.room_id}>Not free on these dates</option>}
                  </select>
                </Field>
                <Field label="Rate / night">
                  <input inputMode="decimal" value={l.rate ?? ''} onChange={(e) => setLine(i, { rate: e.target.value.replace(/[^\d.]/g, ''), rateTouched: true })} />
                </Field>
                <Field label="Adults"><input type="number" min={1} value={l.adults} onChange={(e) => setLine(i, { adults: e.target.value })} /></Field>
                <Field label="Children"><input type="number" min={0} value={l.children} onChange={(e) => setLine(i, { children: e.target.value })} /></Field>
                <button type="button" className="icon-btn" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove room">✕</button>
              </div>
            );
          })}
          <button type="button" className="btn btn-ghost" onClick={() => setLines((ls) => [...ls, { room_type_id: firstType?.id ?? '', room_id: '', rate: '', adults: 1, children: 0 }])}>+ Add room</button>
        </div>

        <h4>Guest</h4>
        {existing ? (
          <div className="existing-guest">
            <div><strong>{guestName(existing)}</strong> <span className="muted">{existing.phone} {existing.email}</span></div>
            <button type="button" className="link" onClick={() => setExisting(null)}>Use a different guest</button>
          </div>
        ) : (
          <>
            <div className="grid-4">
              <Field label="Title">
                <select value={guest.title} onChange={(e) => setGuest({ ...guest, title: e.target.value })}>
                  <option value="">—</option>{TITLES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="First name"><input required value={guest.first_name} onChange={(e) => setGuest({ ...guest, first_name: e.target.value })} /></Field>
              <Field label="Last name"><input value={guest.last_name} onChange={(e) => setGuest({ ...guest, last_name: e.target.value })} /></Field>
              <Field label="Phone"><input type="tel" value={guest.phone} onChange={(e) => setGuest({ ...guest, phone: e.target.value })} placeholder="+255…" /></Field>
              <Field label="Email"><input type="email" value={guest.email} onChange={(e) => setGuest({ ...guest, email: e.target.value })} /></Field>
              <Field label="Nationality"><input value={guest.nationality} onChange={(e) => setGuest({ ...guest, nationality: e.target.value })} /></Field>
              <Field label="ID type">
                <select value={guest.id_type} onChange={(e) => setGuest({ ...guest, id_type: e.target.value })}>
                  <option value="">—</option>{ID_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="ID number"><input value={guest.id_number} onChange={(e) => setGuest({ ...guest, id_number: e.target.value })} /></Field>
            </div>
            {guestHits.length > 0 && (
              <div className="guest-hits">
                <span className="muted small">Returning guest?</span>
                {guestHits.map((g) => (
                  <button type="button" key={g.id} className="chip" onClick={() => setExisting(g)}>{guestName(g)} · {g.phone || g.email || 'no contact'}</button>
                ))}
              </div>
            )}
          </>
        )}
        <Field label="Notes / special requests"><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </form>
    </Modal>
  );
}
