import { useCallback, useEffect, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { can, DATE_FORMATS, fmtDate, fmtDateTime, label, ROLES } from '../lib/format';
import { Badge, Field, Modal, PageHead, Table, useAction } from '../components/ui.jsx';
import { PRIVILEGES, PRIVILEGE_GROUPS, roleDefaults } from '../lib/privileges.js';
import { NIGHT_DEFAULT } from '../lib/nightmode.js';
import Subscription from '../components/Subscription.jsx';

// Setup hub: one searchable list of everything that shapes how the property runs
const SECTIONS = [
  { group: 'Your hotel', items: [
    ['profile', 'Profile and contacts', 'Name, type, stars, registration numbers, address, map'],
    ['showcase', 'Logo, photos and highlights', 'What guests see on the website and printouts'],
    ['policies', 'Policies and stay times', 'House rules, cancellation, check-in and out, early and late'],
    ['formats', 'Formats and defaults', 'Dates, times, weekends, rounding, ID types, night mode'],
  ] },
  { group: 'Rooms and pricing', items: [
    ['rooms', 'Room types and rooms', 'Occupancy, extra adult and child rates, room numbers'],
    ['plans', 'Rate plans', 'Meal plans, derived plans, what is sold online'],
    ['taxes', 'Taxes', 'VAT, service charge and levies'],
  ] },
  { group: 'Money', items: [
    ['payments', 'Payment methods', 'Cash, M-Pesa, cards, banks, surcharges'],
    ['extras', 'Extra charges', 'Laundry, extra bed, late check-out…'],
    ['discounts', 'Discounts', 'Ready-made percentage or fixed discounts'],
    ['payouts', 'Pay-out reasons', 'Cash paid on a guest\'s behalf'],
    ['meals', 'Meal plans', 'Breakfast, half board and their prices'],
    ['transport', 'Transport', 'Airport pick-ups and drop-offs'],
  ] },
  { group: 'Bookings and guests', items: [
    ['sources', 'Sources and companies', 'Where bookings come from, city ledger accounts'],
    ['segments', 'Market segments', 'Leisure, corporate, government…'],
    ['booktypes', 'Booking types', 'Confirmed, on hold, complimentary…'],
    ['tags', 'Guest tags', 'VIP, repeat guest, special needs'],
    ['holidays', 'Holidays and events', 'Marked on the rate calendar'],
    ['remarks', 'Quick remarks', 'Reasons offered when voiding or discounting'],
  ] },
  { group: 'Talking to guests', items: [
    ['messages', 'Automatic texts', 'Booking, check-in and goodbye SMS'],
    ['documents', 'Printed documents', 'Footers on folios and confirmations'],
    ['website', 'Online booking', 'Your booking page, rules and payments'],
  ] },
  { group: 'Team', items: [
    ['staff', 'People and access', 'Invite, give roles, adjust one person, switch off'],
    ['roles', 'Roles', 'Your own roles built from single abilities'],
    ['access', 'What each role can do', 'Every ability, role by role'],
    ['signins', 'Sign-ins and devices', 'When and where people signed in'],
    ['activity', 'Who did what', 'Every action, by person, with IP address'],
    ['security', 'Security rules', 'Require two-step sign-in for everyone'],
  ] },
  { group: 'Account', items: [
    ['subscription', 'BMG PMS subscription', 'Monthly invoices, paying by mobile money'],
  ] },
];
const ALL = SECTIONS.flatMap((g) => g.items.map(([id, title, hint]) => ({ id, title, hint, group: g.group })));

export default function Setup({ params }) {
  const { role } = useProperty();
  const [sec, setSec] = useState(params?.tab && ALL.some((x) => x.id === params.tab) ? params.tab : 'profile');
  const [q, setQ] = useState('');
  // follow links like #/setup?tab=roles even when Setup is already open
  useEffect(() => { if (params?.tab && ALL.some((x) => x.id === params.tab)) setSec(params.tab); }, [params?.tab]);
  if (!can(role, 'setup')) return <><PageHead title="Setup" /><p>Only owners and managers can change setup.</p></>;
  const found = ALL.filter((x) => !q || `${x.title} ${x.hint} ${x.group}`.toLowerCase().includes(q.toLowerCase()));
  const current = ALL.find((x) => x.id === sec);
  return (
    <>
      <PageHead title="Setup" sub="Everything that shapes how this property runs. Changes apply at once." />
      <div className="hub">
        <label className="hub-select"><span className="field-label">Section</span>
          <select value={sec} onChange={(e) => setSec(e.target.value)}>
            {SECTIONS.map((g) => <optgroup key={g.group} label={g.group}>{g.items.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</optgroup>)}
          </select>
        </label>
        <nav className="hub-nav" aria-label="Setup sections">
          <input className="search" placeholder="Find a setting" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a setting" />
          {SECTIONS.map((g) => {
            const items = found.filter((x) => x.group === g.group);
            if (!items.length) return null;
            return (
              <div key={g.group} className="hub-group">
                <div className="hub-group-name">{g.group}</div>
                {items.map((x) => (
                  <button key={x.id} className={`hub-item ${x.id === sec ? 'active' : ''}`} onClick={() => setSec(x.id)}>
                    <span>{x.title}</span><span className="hub-hint">{x.hint}</span>
                  </button>
                ))}
              </div>
            );
          })}
        </nav>
        <section className="hub-body">
          <div className="hub-title"><span className="muted small">{current.group}</span><h2 className="first">{current.title}</h2></div>
          <Section id={sec} />
        </section>
      </div>
    </>
  );
}

function Section({ id }) {
  const { lookups, refresh, property, role, reloadProperties } = useProperty();
  switch (id) {
    case 'subscription': return <Subscription propertyId={property.id} role={role} onPaid={reloadProperties} />;
    case 'profile': return <ProfileForm />;
    case 'showcase': return <Showcase />;
    case 'policies': return <Policies />;
    case 'formats': return <Formats />;
    case 'rooms': return <Rooms />;
    case 'plans': return <Plans />;
    case 'taxes': return <ListSection table="pms_taxes" note="Taxes on rooms add up to the rate the night audit uses. When room rates exclude tax, each night's tax is posted with these names."
      blank={{ name: '', rate: '', applies_to: 'room', active: true, sort_order: 0 }}
      fields={[{ key: 'name', label: 'Tax' }, { key: 'rate', label: 'Rate %', type: 'number' }, { key: 'applies_to', label: 'Applies to', type: 'list', placeholder: 'room, fnb, spa' },
        { key: 'sort_order', label: 'Order', type: 'number' }, { key: 'active', label: 'Active', type: 'bool' }]} />;
    case 'payments': return <ListSection table="pms_payment_methods" rows={lookups.paymentMethods} onSaved={refresh}
      note="The kind decides how the drawer and reports treat it; the name is what prints on receipts. A surcharge (e.g. 3% on cards) is added to the guest's bill automatically."
      blank={{ name: '', kind: 'mobile_money', surcharge_pct: 0, surcharge_fixed: 0, sort_order: 10, active: true }}
      fields={[{ key: 'name', label: 'Shown as' }, { key: 'kind', label: 'Kind', options: [['cash', 'Cash'], ['mobile_money', 'Mobile money'], ['card', 'Card'], ['bank', 'Bank'], ['other', 'Other']] },
        { key: 'surcharge_pct', label: 'Surcharge %', type: 'number' }, { key: 'surcharge_fixed', label: 'Surcharge fixed', type: 'number' },
        { key: 'sort_order', label: 'Order', type: 'number' }, { key: 'active', label: 'On', type: 'bool' }]} />;
    case 'extras': return <ListSection table="pms_extra_charges" rows={lookups.extraCharges} onSaved={refresh}
      note="Offered when posting a charge. The quantity is suggested from nights and guests where it applies."
      blank={{ name: '', category: 'other', amount: '', charge_mode: 'once', active: true }}
      fields={[{ key: 'name', label: 'Charge' }, { key: 'category', label: 'Department', options: CATS }, { key: 'amount', label: 'Price', type: 'number' },
        { key: 'charge_mode', label: 'Counted', options: [['once', 'Once'], ['per_night', 'Per night'], ['per_person', 'Per person'], ['per_person_night', 'Per person per night']] },
        { key: 'active', label: 'On', type: 'bool' }]} />;
    case 'discounts': return <ListSection table="pms_discount_types" rows={lookups.discountTypes} onSaved={refresh}
      note="Managers pick these on the folio; the amount is worked out from the room charges (or all charges) already posted."
      blank={{ name: '', kind: 'percent', value: '', applies_to: 'room', active: true }}
      fields={[{ key: 'name', label: 'Discount' }, { key: 'kind', label: 'Kind', options: [['percent', 'Percentage'], ['fixed', 'Fixed amount']] },
        { key: 'value', label: 'Value', type: 'number' }, { key: 'applies_to', label: 'Of', options: [['room', 'Room charges'], ['all', 'All charges']] },
        { key: 'active', label: 'On', type: 'bool' }]} />;
    case 'payouts': return <ListSection table="pms_payout_types" rows={lookups.payoutTypes} onSaved={refresh}
      note="Reasons offered when the desk pays cash on a guest's behalf (taxi, pharmacy). The cash leaves the drawer and is added to the guest's bill."
      blank={{ name: '', active: true }} fields={[{ key: 'name', label: 'Reason' }, { key: 'active', label: 'On', type: 'bool' }]} />;
    case 'meals': return <ListSection table="pms_meal_plans" rows={lookups.mealPlans} onSaved={refresh}
      note="Prices per adult and child per day, posted from the folio (Charge → Meal plan)."
      blank={{ code: '', name: '', adult_rate: 0, child_rate: 0, active: true }}
      fields={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Meal plan' }, { key: 'adult_rate', label: 'Adult / day', type: 'number' },
        { key: 'child_rate', label: 'Child / day', type: 'number' }, { key: 'active', label: 'On', type: 'bool' }]} />;
    case 'transport': return <ListSection table="pms_transport_types" rows={lookups.transportTypes} onSaved={refresh}
      note="Choose on a booking's pick-up and drop-off; Today lists the day's runs; one tap posts the charge."
      blank={{ name: '', vehicle: '', rate: 0, active: true }}
      fields={[{ key: 'name', label: 'Service' }, { key: 'vehicle', label: 'Vehicle' }, { key: 'rate', label: 'Price', type: 'number' }, { key: 'active', label: 'On', type: 'bool' }]} />;
    case 'sources': return <Sources />;
    case 'segments': return <ListSection table="pms_market_segments" rows={lookups.marketSegments} onSaved={refresh}
      note="Set on each booking; the market segment report shows room nights and revenue for each."
      blank={{ name: '', active: true }} fields={[{ key: 'name', label: 'Segment' }, { key: 'active', label: 'On', type: 'bool' }]} />;
    case 'booktypes': return <ListSection table="pms_reservation_types" rows={lookups.reservationTypes} onSaved={refresh}
      note="On-hold types show how long the room is held; complimentary types are for zero-rate stays."
      blank={{ name: '', is_confirmed: true, complimentary: false, release_hours: '', active: true }}
      fields={[{ key: 'name', label: 'Booking type' }, { key: 'is_confirmed', label: 'Confirmed', type: 'bool' }, { key: 'complimentary', label: 'Free stay', type: 'bool' },
        { key: 'release_hours', label: 'Hold for (hours)', type: 'optnumber' }, { key: 'active', label: 'On', type: 'bool' }]} />;
    case 'tags': return <ListSection table="pms_guest_attributes" rows={lookups.guestAttributes} onSaved={refresh}
      note="Tags appear next to a guest's name everywhere. The blacklist is set on the guest's own page."
      blank={{ name: '', color: 'navy', active: true }}
      fields={[{ key: 'name', label: 'Tag' }, { key: 'color', label: 'Colour', options: [['navy', 'Navy'], ['orange', 'Orange'], ['claret', 'Red'], ['green', 'Green'], ['grey', 'Grey']] },
        { key: 'active', label: 'On', type: 'bool' }]} />;
    case 'holidays': return <ListSection table="pms_holidays" rows={lookups.holidays} onSaved={refresh}
      note="Public holidays and big events show on the rate calendar so pricing can follow demand."
      blank={{ holiday_date: '', name: '' }} fields={[{ key: 'holiday_date', label: 'Date', type: 'date' }, { key: 'name', label: 'Holiday or event' }]} />;
    case 'remarks': return <ListSection table="pms_remarks" rows={lookups.remarks} onSaved={refresh}
      note="Offered as suggestions in reason boxes so wording stays consistent in reports."
      blank={{ kind: 'void', text: '', active: true }}
      fields={[{ key: 'kind', label: 'Used for', options: [['void', 'Voids'], ['discount', 'Discounts'], ['cancel', 'Cancellations'], ['adjustment', 'Adjustments'], ['housekeeping', 'Housekeeping'], ['general', 'General']] },
        { key: 'text', label: 'Remark' }, { key: 'active', label: 'On', type: 'bool' }]} />;
    case 'messages': return <Messages />;
    case 'documents': return <Documents />;
    case 'website': return <Website />;
    case 'staff': return <Staff />;
    case 'access': return <Access />;
    case 'roles': return <Roles />;
    case 'signins': return <SignIns />;
    case 'activity': return <Activity />;
    case 'security': return <SecurityRules />;
    default: return null;
  }
}

const CATS = [['fnb', 'Food and beverage'], ['laundry', 'Laundry'], ['minibar', 'Minibar'], ['transport', 'Transport'], ['spa', 'Spa'], ['recreation', 'Recreation'],
  ['tours', 'Tours'], ['events', 'Events'], ['extra_bed', 'Extra bed'], ['damage', 'Damage'], ['other', 'Other']];

// Lists that live in their own table; reloads itself unless rows come from lookups
function ListSection({ table, rows: given, onSaved, note, blank, fields }) {
  const { property } = useProperty();
  const [rows, setRows] = useState(given ?? []);
  const load = useCallback(() => {
    if (given) { onSaved?.(); return; }
    supabase.from(table).select('*').eq('property_id', property.id).order(fields[0].key).then(({ data }) => setRows(data ?? []));
  }, [table, property.id, given, onSaved, fields]);
  useEffect(() => { if (!given) load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (given) setRows(given); }, [given]);
  return (
    <>
      {note && <p className="muted">{note}</p>}
      <EditableList table={table} rows={rows} onSaved={load} blank={blank} fields={fields} />
    </>
  );
}

// Settings live in pms_properties.settings (and policies); save merges a patch
function useSettings() {
  const { property, refresh } = useProperty();
  const [run, busy] = useAction();
  const merge = (a, b) => {
    const out = { ...(a ?? {}) };
    for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(out[k], v) : v;
    return out;
  };
  const save = (patch, msg = 'Saved', column = 'settings') => run(async () => {
    const { error } = await supabase.from('pms_properties').update({ [column]: merge(property[column], patch) }).eq('id', property.id);
    if (error) throw error;
    refresh();
  }, msg).catch(() => {});
  return [property.settings ?? {}, save, busy];
}

function ProfileForm() {
  const { property, refresh, reloadProperties } = useProperty();
  const [run, busy] = useAction();
  const [p, setP] = useState(property);
  const [regs, setRegs] = useState(Object.entries(property.reg_numbers ?? {}).map(([k, v]) => ({ k, v })));
  const set = (k) => (e) => setP({ ...p, [k]: e.target.value });
  const map = p.latitude && p.longitude ? `https://www.openstreetmap.org/?mlat=${p.latitude}&mlon=${p.longitude}#map=17/${p.latitude}/${p.longitude}` : null;
  return (
    <form onSubmit={(e) => {
      e.preventDefault();
      run(async () => {
        const reg_numbers = Object.fromEntries(regs.filter((r) => r.k.trim() && r.v.trim()).map((r) => [r.k.trim(), r.v.trim()]));
        const num = (x) => (x === '' || x === null || x === undefined ? null : Number(x));
        const { error } = await supabase.from('pms_properties').update({
          name: p.name, code: p.code || null, property_type: p.property_type || null, star_rating: p.star_rating || null,
          address: p.address, address_line2: p.address_line2 || null, city: p.city || null, region: p.region || null, postal_code: p.postal_code || null, country: p.country || 'Tanzania',
          latitude: num(p.latitude), longitude: num(p.longitude),
          phone: p.phone, reservation_phone: p.reservation_phone || null, email: p.email, website: p.website || null, fax: p.fax || null,
          tin: p.tin, vrn: p.vrn, reg_numbers, currency: p.currency, tax_inclusive: p.tax_inclusive, timezone: p.timezone,
        }).eq('id', p.id);
        if (error) throw error;
        refresh(); reloadProperties();
      }, 'Profile saved').catch(() => {});
    }}>
      <div className="card">
        <h3 className="first">The property</h3>
        <div className="grid-4">
          <Field label="Name" span={2}><input required value={p.name} onChange={set('name')} /></Field>
          <Field label="Short code" hint="Also your booking page address"><input value={p.code ?? ''} onChange={set('code')} /></Field>
          <Field label="Group"><input value={p.group_name} disabled /></Field>
          <Field label="Type"><select value={p.property_type ?? ''} onChange={set('property_type')}>
            <option value="">—</option>{['Hotel', 'Apartments', 'Lodge', 'Resort', 'Guest house', 'Camp', 'Villa', 'Hostel'].map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Star rating"><select value={p.star_rating ?? ''} onChange={set('star_rating')}>
            <option value="">Not rated</option>{['1 star', '2 stars', '3 stars', '4 stars', '5 stars'].map((x) => <option key={x}>{x}</option>)}</select></Field>
          <Field label="Currency"><input value={p.currency} onChange={set('currency')} maxLength={3} /></Field>
          <Field label="Time zone"><input value={p.timezone ?? 'Africa/Dar_es_Salaam'} onChange={set('timezone')} /></Field>
        </div>
      </div>
      <div className="card">
        <h3 className="first">Contacts</h3>
        <div className="grid-4">
          <Field label="Main phone"><input value={p.phone ?? ''} onChange={set('phone')} /></Field>
          <Field label="Reservations phone"><input value={p.reservation_phone ?? ''} onChange={set('reservation_phone')} /></Field>
          <Field label="Email"><input type="email" value={p.email ?? ''} onChange={set('email')} /></Field>
          <Field label="Website"><input value={p.website ?? ''} onChange={set('website')} placeholder="www.example.co.tz" /></Field>
          <Field label="Fax (optional)"><input value={p.fax ?? ''} onChange={set('fax')} /></Field>
        </div>
      </div>
      <div className="card">
        <h3 className="first">Registration</h3>
        <div className="grid-4">
          <Field label="TIN"><input value={p.tin ?? ''} onChange={set('tin')} /></Field>
          <Field label="VRN"><input value={p.vrn ?? ''} onChange={set('vrn')} /></Field>
        </div>
        <p className="small muted">Other numbers to print on documents (business licence, TTB licence, BRELA…)</p>
        {regs.map((r, i) => (
          <div key={i} className="inline-form">
            <Field label="Name"><input value={r.k} onChange={(e) => setRegs(regs.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} placeholder="TTB licence" /></Field>
            <Field label="Number"><input value={r.v} onChange={(e) => setRegs(regs.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} /></Field>
            <button type="button" className="link danger" onClick={() => setRegs(regs.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        {regs.length < 6 && <button type="button" className="btn btn-ghost" onClick={() => setRegs([...regs, { k: '', v: '' }])}>+ Add a number</button>}
      </div>
      <div className="card">
        <h3 className="first">Address</h3>
        <div className="grid-4">
          <Field label="Street" span={2}><input value={p.address ?? ''} onChange={set('address')} /></Field>
          <Field label="Street (line 2)" span={2}><input value={p.address_line2 ?? ''} onChange={set('address_line2')} /></Field>
          <Field label="City / town"><input value={p.city ?? ''} onChange={set('city')} /></Field>
          <Field label="Region"><input value={p.region ?? ''} onChange={set('region')} /></Field>
          <Field label="Postal code"><input value={p.postal_code ?? ''} onChange={set('postal_code')} /></Field>
          <Field label="Country"><input value={p.country ?? 'Tanzania'} onChange={set('country')} /></Field>
          <Field label="Latitude" hint="From Google Maps: right-click the building"><input inputMode="decimal" value={p.latitude ?? ''} onChange={set('latitude')} placeholder="-6.7735" /></Field>
          <Field label="Longitude"><input inputMode="decimal" value={p.longitude ?? ''} onChange={set('longitude')} placeholder="39.2421" /></Field>
        </div>
        {map && <p className="small"><a href={map} target="_blank" rel="noreferrer">Check the pin on the map ↗</a></p>}
      </div>
      <button className="btn btn-primary" disabled={busy}>Save profile</button>
    </form>
  );
}

const AMENITIES = ['Free Wi-Fi', 'Air conditioning', 'Parking', 'Swimming pool', 'Gym', 'Spa', 'Restaurant', 'Bar', 'Room service', '24-hour reception',
  'Airport shuttle', 'Laundry', 'Kitchenette', 'Safe', 'Generator back-up', 'Conference room', 'Garden', 'Beach access', 'Kids\' play area', 'Wheelchair access'];

function Showcase() {
  const { property, refresh } = useProperty();
  const [run, busy] = useAction();
  const [photos, setPhotos] = useState([]);
  const [hl, setHl] = useState((property.highlights ?? []).join('\n'));
  const [am, setAm] = useState(new Set(property.amenities ?? []));
  const load = useCallback(() => supabase.from('pms_property_photos').select('*').eq('property_id', property.id).order('sort_order').then(({ data }) => setPhotos(data ?? [])), [property.id]);
  useEffect(() => { load(); }, [load]);
  const upload = async (file, folder) => {
    if (!file) return null;
    if (!file.type.startsWith('image/')) throw new Error('Choose an image (JPG, PNG or WebP)');
    if (file.size > 5 * 1024 * 1024) throw new Error('Images must be under 5 MB');
    const path = `${property.id}/${folder}/${Date.now()}-${file.name.replace(/[^\w.-]/g, '_')}`;
    const { error } = await supabase.storage.from('property-media').upload(path, file, { contentType: file.type });
    if (error) throw error;
    return { path, url: supabase.storage.from('property-media').getPublicUrl(path).data.publicUrl };
  };
  const saveCols = (patch, msg) => run(async () => { const { error } = await supabase.from('pms_properties').update(patch).eq('id', property.id); if (error) throw error; refresh(); }, msg).catch(() => {});
  return (
    <>
      <div className="card showcase-logo">
        <h3 className="first">Logo</h3>
        <div className="row-gap">
          {property.logo_url ? <img src={property.logo_url} alt="Logo" className="logo-preview" /> : <div className="logo-preview empty">No logo</div>}
          <label className="btn">Upload logo<input type="file" accept="image/*" hidden onChange={(e) => run(async () => { const r = await upload(e.target.files[0], 'logo'); if (r) { const { error } = await supabase.from('pms_properties').update({ logo_url: r.url }).eq('id', property.id); if (error) throw error; refresh(); } }, 'Logo saved').catch(() => {})} /></label>
          {property.logo_url && <button className="link danger" onClick={() => saveCols({ logo_url: null }, 'Logo removed')}>Remove</button>}
        </div>
        <p className="small muted">Prints on folios and confirmations and shows on your booking page. Under 1 MB is best.</p>
      </div>
      <div className="card">
        <h3 className="first">Photos</h3>
        <div className="photo-grid">
          {photos.map((ph) => (
            <figure key={ph.id} className="photo">
              <img src={ph.url} alt={ph.caption ?? ''} loading="lazy" />
              <figcaption>
                <input defaultValue={ph.caption ?? ''} placeholder="Caption" aria-label="Caption" onBlur={(e) => e.target.value !== (ph.caption ?? '') && supabase.from('pms_property_photos').update({ caption: e.target.value }).eq('id', ph.id).then(load)} />
                <button className="link danger" onClick={() => run(async () => {
                  if (ph.path) await supabase.storage.from('property-media').remove([ph.path]);
                  const { error } = await supabase.from('pms_property_photos').delete().eq('id', ph.id); if (error) throw error; load();
                }, 'Photo removed').catch(() => {})}>Remove</button>
              </figcaption>
            </figure>
          ))}
          <label className="photo add">+ Add photos<input type="file" accept="image/*" multiple hidden disabled={busy} onChange={(e) => run(async () => {
            for (const [i, f] of [...e.target.files].entries()) {
              const r = await upload(f, 'photos');
              const { error } = await supabase.from('pms_property_photos').insert({ property_id: property.id, url: r.url, path: r.path, sort_order: photos.length + i });
              if (error) throw error;
            }
            load();
          }, 'Photos added').catch(() => {})} /></label>
        </div>
      </div>
      <div className="card">
        <h3 className="first">Highlights</h3>
        <p className="small muted">One per line: what makes a guest choose you.</p>
        <textarea rows={4} value={hl} onChange={(e) => setHl(e.target.value)} placeholder={'5 minutes from Mlimani City\nSecure parking\nFully equipped kitchens'} />
        <h3>Amenities</h3>
        <div className="check-grid">
          {[...new Set([...AMENITIES, ...am])].map((a) => (
            <label key={a} className="check"><input type="checkbox" checked={am.has(a)} onChange={(e) => { const n = new Set(am); e.target.checked ? n.add(a) : n.delete(a); setAm(n); }} /> {a}</label>
          ))}
        </div>
        <button className="btn btn-primary" disabled={busy} onClick={() => saveCols({ highlights: hl.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 20), amenities: [...am] }, 'Highlights and amenities saved')}>Save highlights and amenities</button>
      </div>
    </>
  );
}

const POLICY_KEYS = [['hotel', 'House rules'], ['cancellation', 'Cancellation'], ['checkin', 'Check-in guidelines'], ['parking', 'Parking and arrival'],
  ['family', 'Children and extra guests'], ['terms', 'Booking terms and conditions']];

function Policies() {
  const { property, refresh } = useProperty();
  const [run, busy] = useAction();
  const [pol, setPol] = useState(property.policies ?? {});
  const [t, setT] = useState({ in: property.check_in_time?.slice(0, 5), out: property.check_out_time?.slice(0, 5) });
  const s = property.settings ?? {};
  const [ec, setEc] = useState({ auto_post: false, mode: 'percent', value: 50, ...(s.early_checkin ?? {}) });
  const [lc, setLc] = useState({ mode: 'percent', value: 50, ...(s.late_checkout ?? {}) });
  const [h24, setH24] = useState(!!s.checkout_24h);
  const save = () => run(async () => {
    const { error } = await supabase.from('pms_properties').update({
      policies: pol, check_in_time: t.in, check_out_time: t.out,
      settings: { ...s, early_checkin: { ...ec, value: Number(ec.value) }, late_checkout: { ...lc, value: Number(lc.value) }, checkout_24h: h24 },
    }).eq('id', property.id);
    if (error) throw error;
    refresh();
  }, 'Policies saved').catch(() => {});
  return (
    <>
      <p className="muted">Guests accept these when they book online, and they print on confirmations. Plain text; keep each short.</p>
      <div className="policy-grid">
        {POLICY_KEYS.map(([k, l]) => (
          <Field key={k} label={l}><textarea rows={4} maxLength={4000} value={pol[k] ?? ''} onChange={(e) => setPol({ ...pol, [k]: e.target.value })} /></Field>
        ))}
      </div>
      <div className="card">
        <h3 className="first">Stay times</h3>
        <div className="inline-form">
          <Field label="Check-in from"><input type="time" value={t.in} onChange={(e) => setT({ ...t, in: e.target.value })} /></Field>
          <Field label="Check-out by"><input type="time" value={t.out} onChange={(e) => setT({ ...t, out: e.target.value })} /></Field>
          <label className="check"><input type="checkbox" checked={h24} onChange={(e) => setH24(e.target.checked)} /> 24-hour stays (check out at the hour you checked in)</label>
        </div>
        <div className="grid-2">
          <div>
            <h4>Early check-in</h4>
            <label className="check"><input type="checkbox" checked={!!ec.auto_post} onChange={(e) => setEc({ ...ec, auto_post: e.target.checked })} /> Post the charge automatically when a guest checks in before check-in time</label>
            <div className="inline-form">
              <Field label="Charge"><select value={ec.mode} onChange={(e) => setEc({ ...ec, mode: e.target.value })}><option value="percent">% of the night's rate</option><option value="fixed">Fixed amount</option></select></Field>
              <Field label={ec.mode === 'fixed' ? property.currency : '%'}><input inputMode="decimal" value={ec.value} onChange={(e) => setEc({ ...ec, value: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
            </div>
          </div>
          <div>
            <h4>Late check-out</h4>
            <p className="small muted">Suggested to the desk at check-out after check-out time; they decide whether to post it.</p>
            <div className="inline-form">
              <Field label="Charge"><select value={lc.mode} onChange={(e) => setLc({ ...lc, mode: e.target.value })}><option value="percent">% of the night's rate</option><option value="fixed">Fixed amount</option></select></Field>
              <Field label={lc.mode === 'fixed' ? property.currency : '%'}><input inputMode="decimal" value={lc.value} onChange={(e) => setLc({ ...lc, value: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
            </div>
          </div>
        </div>
      </div>
      <button className="btn btn-primary" disabled={busy} onClick={save}>Save policies and times</button>
    </>
  );
}

const WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function Formats() {
  const [s, save, busy] = useSettings();
  const [f, setF] = useState({
    date_format: s.date_format ?? 'DD Mon YYYY', time_format: s.time_format ?? '24h', weekend_days: s.weekend_days ?? [5, 6],
    round_to: s.round_to ?? 0, financial_year_start: s.financial_year_start ?? 1, default_salutation: s.default_salutation ?? 'Mr.',
    salutations: (s.salutations ?? ['Mr.', 'Mrs.', 'Ms.', 'Dr.', 'Prof.']).join(', '),
    id_types: (s.id_types ?? ['Passport', 'National ID (NIDA)', 'Driving licence', 'Voter ID']).join(', '),
    default_nationality: s.default_nationality ?? 'Tanzania',
    night_mode: { ...NIGHT_DEFAULT, ...(s.night_mode ?? {}) },
  });
  const list = (x) => x.split(',').map((y) => y.trim()).filter(Boolean);
  const today = new Date().toISOString().slice(0, 10);
  return (
    <form onSubmit={(e) => { e.preventDefault(); save({ ...f, round_to: Number(f.round_to), financial_year_start: Number(f.financial_year_start), salutations: list(f.salutations), id_types: list(f.id_types) }, 'Formats saved'); }}>
      <div className="card grid-3">
        <Field label="Dates look like"><select value={f.date_format} onChange={(e) => setF({ ...f, date_format: e.target.value })}>
          {DATE_FORMATS.map((d) => <option key={d} value={d}>{d}</option>)}</select></Field>
        <Field label="Times"><select value={f.time_format} onChange={(e) => setF({ ...f, time_format: e.target.value })}><option value="24h">24-hour (14:30)</option><option value="12h">12-hour (2:30 pm)</option></select></Field>
        <Field label="Financial year starts"><select value={f.financial_year_start} onChange={(e) => setF({ ...f, financial_year_start: e.target.value })}>
          {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{fmtDate(`2026-${String(i + 1).padStart(2, '0')}-01`, { month: 'long' })}</option>)}</select></Field>
        <Field label="Round payment suggestions to" hint="e.g. 100 so a balance of 199,950 suggests 200,000"><select value={f.round_to} onChange={(e) => setF({ ...f, round_to: e.target.value })}>
          {[0, 50, 100, 500, 1000].map((x) => <option key={x} value={x}>{x ? `Nearest ${x}` : 'No rounding'}</option>)}</select></Field>
        <Field label="Default title"><input value={f.default_salutation} onChange={(e) => setF({ ...f, default_salutation: e.target.value })} /></Field>
        <Field label="Default nationality"><input value={f.default_nationality} onChange={(e) => setF({ ...f, default_nationality: e.target.value })} /></Field>
        <Field label="Titles offered" span={2}><textarea className="grow" rows={2} value={f.salutations} onChange={(e) => setF({ ...f, salutations: e.target.value })} /></Field>
        <Field label="ID documents accepted" span="full"><textarea className="grow" rows={2} value={f.id_types} onChange={(e) => setF({ ...f, id_types: e.target.value })} /></Field>
      </div>
      <div className="card">
        <h3 className="first">Weekend nights</h3>
        <p className="small muted">Shaded on the rate calendar so weekend pricing is easy to spot.</p>
        <div className="row-gap">{WEEK.map((d, i) => (
          <label key={d} className="check"><input type="checkbox" checked={f.weekend_days.includes(i)} onChange={(e) => setF({ ...f, weekend_days: e.target.checked ? [...f.weekend_days, i] : f.weekend_days.filter((x) => x !== i) })} /> {d}</label>))}</div>
      </div>
      <div className="card">
        <h3 className="first">Night audit mode</h3>
        <p className="small muted">When the night audit window opens the screens turn dark navy, so the night shift can see the day still has to be closed. They go back to day as soon as the audit runs. Each person can still pick day or night for their own device at the bottom of the menu.</p>
        <div className="inline-form">
          <label className="check"><input type="checkbox" checked={f.night_mode.enabled} onChange={(e) => setF({ ...f, night_mode: { ...f.night_mode, enabled: e.target.checked } })} /> Switch automatically while the audit is due</label>
          <Field label="Window opens"><input type="time" value={f.night_mode.from} disabled={!f.night_mode.enabled} onChange={(e) => setF({ ...f, night_mode: { ...f.night_mode, from: e.target.value } })} /></Field>
          <Field label="Window closes"><input type="time" value={f.night_mode.to} disabled={!f.night_mode.enabled} onChange={(e) => setF({ ...f, night_mode: { ...f.night_mode, to: e.target.value } })} /></Field>
        </div>
      </div>
      <p className="small muted">Preview: today is {(() => { const [y, m, d] = today.split('-'); return { 'DD/MM/YYYY': `${d}/${m}/${y}`, 'MM/DD/YYYY': `${m}/${d}/${y}`, 'YYYY-MM-DD': today }[f.date_format] ?? fmtDate(today, { day: '2-digit', month: 'short', year: 'numeric' }); })()}</p>
      <button className="btn btn-primary" disabled={busy}>Save formats</button>
    </form>
  );
}

function Rooms() {
  const { lookups, refresh } = useProperty();
  const typeOpts = lookups.roomTypes.map((t) => [t.id, t.name]);
  return (
    <>
      <h3 className="first">Room types</h3>
      <p className="small muted">"Included adults" are in the base rate; each extra adult or child adds its own rate per night (the rate calendar can change it by date).</p>
      <EditableList table="pms_room_types" rows={lookups.roomTypes} onSaved={refresh}
        blank={{ name: '', code: '', base_rate: '', base_adults: 2, max_adults: 2, max_children: 1, max_occupancy: 3, extra_adult_rate: 0, extra_child_rate: 0, bed_type: '', size_sqm: '', sort_order: lookups.roomTypes.length + 1, active: true }}
        fields={[{ key: 'name', label: 'Name' }, { key: 'code', label: 'Code' }, { key: 'base_rate', label: 'Base rate', type: 'number' },
          { key: 'base_adults', label: 'Included adults', type: 'number' }, { key: 'max_adults', label: 'Max adults', type: 'optnumber' },
          { key: 'max_children', label: 'Max children', type: 'number' }, { key: 'max_occupancy', label: 'Max people', type: 'number' },
          { key: 'extra_adult_rate', label: 'Extra adult', type: 'number' }, { key: 'extra_child_rate', label: 'Extra child', type: 'number' },
          { key: 'bed_type', label: 'Beds' }, { key: 'size_sqm', label: 'm²', type: 'optnumber' },
          { key: 'sort_order', label: 'Order', type: 'number' }, { key: 'active', label: 'On', type: 'bool' }]} />
      <h3>Rooms</h3>
      {typeOpts.length ? (
        <EditableList table="pms_rooms" rows={lookups.rooms} onSaved={refresh}
          blank={{ number: '', room_type_id: typeOpts[0][0], floor: '', active: true }}
          fields={[{ key: 'number', label: 'Number' }, { key: 'room_type_id', label: 'Type', options: typeOpts },
            { key: 'floor', label: 'Floor' }, { key: 'active', label: 'In use', type: 'bool' }]} />
      ) : <p className="muted">Add a room type first.</p>}
    </>
  );
}

function Plans() {
  const { lookups, refresh } = useProperty();
  const parents = [['', 'Own rates'], ...lookups.ratePlans.map((p) => [p.id, `From ${p.name}`])];
  return (
    <>
      <p className="muted">A plan can follow another one: "From Room Only, +25,000" or "From Room Only, −10%". Its rates then move by themselves, unless you type an own rate on the rate calendar.</p>
      <EditableList table="pms_rate_plans" rows={lookups.ratePlans} onSaved={refresh}
        blank={{ name: '', meal_plan: 'RO', parent_id: '', derive_mode: 'amount', derive_value: '', on_booking_engine: true, cancellation_policy: '', active: true }}
        fields={[{ key: 'name', label: 'Plan' }, { key: 'meal_plan', label: 'Meals', options: [['RO', 'Room only'], ['BB', 'Breakfast'], ['HB', 'Half board'], ['FB', 'Full board'], ['AI', 'All inclusive']] },
          { key: 'parent_id', label: 'Priced', options: parents },
          { key: 'derive_mode', label: 'By', options: [['amount', 'Amount'], ['percent', 'Percent']], hidden: (r) => !r.parent_id },
          { key: 'derive_value', label: '+ / −', type: 'optnumber', placeholder: '25000 or -10', hidden: (r) => !r.parent_id },
          { key: 'cancellation_policy', label: 'Cancellation (shown online)' },
          { key: 'on_booking_engine', label: 'Online', type: 'bool' }, { key: 'active', label: 'On', type: 'bool' }]} />
      <p className="small muted">Prices by date, extra guests, minimum and maximum nights and closures are on the <a href="#/rates">rate calendar</a>.</p>
    </>
  );
}

function Sources() {
  const { lookups, refresh } = useProperty();
  return (
    <>
      <h3 className="first">Where bookings come from</h3>
      <EditableList table="pms_business_sources" rows={lookups.sources} onSaved={refresh} blank={{ name: '', kind: 'direct', commission_pct: 0, active: true }}
        fields={[{ key: 'name', label: 'Name' },
          { key: 'kind', label: 'Kind', options: ['direct', 'walk_in', 'ota', 'travel_agent', 'company', 'other'].map((k) => [k, label(k)]) },
          { key: 'commission_pct', label: 'Commission %', type: 'number' }, { key: 'active', label: 'On', type: 'bool' }]} />
      <h3>Companies (city ledger accounts)</h3>
      <EditableList table="pms_companies" rows={lookups.companies} onSaved={refresh} blank={{ name: '', contact_name: '', phone: '', email: '', tin: '', credit_limit: 0, active: true }}
        fields={[{ key: 'name', label: 'Company' }, { key: 'contact_name', label: 'Contact' }, { key: 'phone', label: 'Phone' },
          { key: 'email', label: 'Email' }, { key: 'tin', label: 'TIN' }, { key: 'credit_limit', label: 'Credit limit', type: 'number' }, { key: 'active', label: 'On', type: 'bool' }]} />
    </>
  );
}

const TEXT_EVENTS = [
  ['booking', 'When a booking is made', 'Dear {guest}, your booking #{res_no} at {property} for {arrival} to {departure} is {status}. Karibu!'],
  ['checkin', 'At check-in', 'Karibu {guest}! You are checked in to room {room} at {property}. Call reception on {phone} for anything you need.'],
  ['checkout', 'At check-out', 'Asante {guest} for staying at {property}. Safe travels, and see you again!'],
];
function Messages() {
  const [s, save, busy] = useSettings();
  const [n, setN] = useState(s.notifications ?? {});
  return (
    <>
      <p className="muted">Sent through Beem when Guest SMS is switched on under Integrations. Imported eZee bookings are never texted. Use {'{guest} {property} {res_no} {arrival} {departure} {room} {phone} {status}'}.</p>
      {TEXT_EVENTS.map(([k, l, d]) => (
        <div key={k} className="card">
          <label className="check"><input type="checkbox" checked={!!n[`${k}_sms`]} onChange={(e) => setN({ ...n, [`${k}_sms`]: e.target.checked })} /> <strong>{l}</strong></label>
          <textarea rows={2} maxLength={480} value={n[`${k}_template`] ?? ''} placeholder={d} onChange={(e) => setN({ ...n, [`${k}_template`]: e.target.value })} />
        </div>
      ))}
      <button className="btn btn-primary" disabled={busy} onClick={() => save({ notifications: n }, 'Texts saved')}>Save texts</button>
    </>
  );
}

function Documents() {
  const [s, save, busy] = useSettings();
  const [d, setD] = useState({ folio_footer: '', confirmation_footer: '', show_logo: true, show_reg_numbers: true, ...(s.documents ?? {}) });
  return (
    <form onSubmit={(e) => { e.preventDefault(); save({ documents: d }, 'Documents saved'); }}>
      <div className="card stack">
        <label className="check"><input type="checkbox" checked={d.show_logo} onChange={(e) => setD({ ...d, show_logo: e.target.checked })} /> Print the logo</label>
        <label className="check"><input type="checkbox" checked={d.show_reg_numbers} onChange={(e) => setD({ ...d, show_reg_numbers: e.target.checked })} /> Print registration numbers</label>
        <Field label="Folio and invoice footer" hint="Bank details, thank-you note, payment terms"><textarea rows={3} maxLength={1000} value={d.folio_footer} onChange={(e) => setD({ ...d, folio_footer: e.target.value })} /></Field>
        <Field label="Confirmation footer"><textarea rows={3} maxLength={1000} value={d.confirmation_footer} onChange={(e) => setD({ ...d, confirmation_footer: e.target.value })} /></Field>
      </div>
      <button className="btn btn-primary" disabled={busy}>Save documents</button>
    </form>
  );
}

function Website() {
  const { property } = useProperty();
  const [s, save, busy] = useSettings();
  const [b, setB] = useState({ enabled: false, default_status: 'confirmed', require_terms: true, max_rooms: 3, pay_now_mobile: false, deposit_pct: 100, intro: '', ...(s.booking_engine ?? {}) });
  const link = `${window.location.origin}/#/book/${(property.code ?? '').toLowerCase()}`;
  return (
    <form onSubmit={(e) => { e.preventDefault(); save({ booking_engine: { ...b, max_rooms: Number(b.max_rooms), deposit_pct: Number(b.deposit_pct) } }, 'Online booking saved'); }}>
      <div className="card stack">
        <label className="check big"><input type="checkbox" checked={b.enabled} onChange={(e) => setB({ ...b, enabled: e.target.checked })} /> <strong>Take bookings on your own booking page</strong></label>
        {!property.code && <p className="danger small">Give the property a short code under Profile first: it becomes the page address.</p>}
        {property.code && <p className="small">Your page: <a href={link} target="_blank" rel="noreferrer">{link}</a> (link it from your website and social media)</p>}
        <div className="grid-3">
          <Field label="New online bookings are"><select value={b.default_status} onChange={(e) => setB({ ...b, default_status: e.target.value })}><option value="confirmed">Confirmed</option><option value="tentative">On hold until we confirm</option></select></Field>
          <Field label="Most rooms per booking"><input type="number" min={1} max={10} value={b.max_rooms} onChange={(e) => setB({ ...b, max_rooms: e.target.value })} /></Field>
          <Field label="Welcome line"><input maxLength={160} value={b.intro} onChange={(e) => setB({ ...b, intro: e.target.value })} placeholder="Karibu! Book direct for our best rate." /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={b.require_terms} onChange={(e) => setB({ ...b, require_terms: e.target.checked })} /> Guests must accept your policies to book</label>
        <label className="check"><input type="checkbox" checked={b.pay_now_mobile} onChange={(e) => setB({ ...b, pay_now_mobile: e.target.checked })} /> Offer "pay now by mobile money" (needs Mobile money switched on under Integrations)</label>
        {b.pay_now_mobile && <Field label="Deposit asked online (%)"><input type="number" min={1} max={100} value={b.deposit_pct} onChange={(e) => setB({ ...b, deposit_pct: e.target.value })} /></Field>}
        <p className="small muted">Which rate plans appear online is set under Rate plans; prices, closures and minimum nights come from the rate calendar. A guest can make at most three online bookings a day.</p>
      </div>
      <button className="btn btn-primary" disabled={busy}>Save online booking</button>
    </form>
  );
}

function useRoles() {
  const { property } = useProperty();
  const [roles, setRoles] = useState(null);
  const load = useCallback(async () => {
    const [{ data: r }, { data: p }] = await Promise.all([
      supabase.from('pms_custom_roles').select('*').eq('property_id', property.id).order('name'),
      supabase.from('pms_custom_role_privileges').select('role_id, privilege'),
    ]);
    setRoles((r ?? []).map((x) => ({ ...x, privileges: (p ?? []).filter((y) => y.role_id === x.id).map((y) => y.privilege) })));
  }, [property.id]);
  useEffect(() => { load(); }, [load]);
  return [roles ?? [], load, roles !== null];
}

// "front_desk" or "custom:<id>" in one list
const roleOptions = (roles) => [
  ...ROLES.map((r) => [r, label(r)]),
  ...roles.filter((r) => r.active).map((r) => [`custom:${r.id}`, `${r.name} (${label(r.base_role)})`]),
];

function Staff() {
  const { property, role, user } = useProperty();
  const [run, busy] = useAction();
  const [rows, setRows] = useState(null);
  const [access, setAccess] = useState({});
  const [roles, , rolesReady] = useRoles();
  const [f, setF] = useState({ email: '', role: 'front_desk', name: '' });
  const [editing, setEditing] = useState(null);
  const owner = can(role, 'staff');
  const load = useCallback(() => Promise.all([
    rpc('pms_list_staff', { p_property: property.id }).then(setRows).catch(() => setRows([])),
    rpc('pms_staff_access', { p_property: property.id }).then((a) => setAccess(Object.fromEntries((a ?? []).map((x) => [x.user_id, x])))).catch(() => {}),
  ]), [property.id]);
  useEffect(() => { load(); }, [load]);
  const setMember = (email, r, name, active) => rpc('pms_add_or_invite_member', { p_property: property.id, p_email: email, p_role: r, p_display_name: name || null, p_active: active });
  // A custom role is the built-in base role plus the role's own list
  const add = () => run(async () => {
    const custom = f.role.startsWith('custom:') ? roles.find((r) => `custom:${r.id}` === f.role) : null;
    await setMember(f.email, custom ? custom.base_role : f.role, f.name, true);
    if (custom) {
      const list = await rpc('pms_list_staff', { p_property: property.id });
      const who = list.find((x) => x.email === f.email.trim().toLowerCase());
      if (who) await rpc('pms_set_member_access', { p_property: property.id, p_user: who.id, p_custom_role: custom.id, p_overrides: {} });
    }
  }, 'Saved').then(() => { setF({ email: '', role: 'front_desk', name: '' }); load(); }).catch(() => {});
  const accessLabel = (m) => {
    const a = access[m.id];
    const tweaks = a ? Object.keys(a.overrides ?? {}).length : 0;
    return <span className="access-cell"><span>{a?.custom_role ?? label(m.role)}</span>{tweaks > 0 && <span className="small muted">{tweaks} change{tweaks === 1 ? '' : 's'} from the role</span>}</span>;
  };
  return (
    <>
      {owner && (
        <form className="card inline-form" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Field label="Email" hint="People without an account are invited and join when they sign up"><input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Role"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roleOptions(roles).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <button className="btn btn-primary" disabled={busy || !rolesReady}>Add</button>
        </form>
      )}
      <Table rows={rows} empty="No one yet" columns={[
        { key: 'email', label: 'Person', render: (m) => <>{m.display_name || m.email}{m.display_name && <div className="small muted">{m.email}</div>}</> },
        { key: 'title', label: 'Job title', render: (m) => (m.kind === 'member' && owner
          ? <input className="mini" defaultValue={m.title ?? ''} placeholder={label(m.role)} aria-label="Job title" onBlur={(e) => e.target.value !== (m.title ?? '') && run(() => rpc('pms_set_member_title', { p_property: property.id, p_user: m.user_id, p_title: e.target.value }), 'Title saved').then(load).catch(() => {})} />
          : m.title ?? '') },
        { key: 'role', label: 'Access', render: (m) => (owner && m.user_id !== user.id && m.role !== 'owner'
          ? <button className="link access-link" onClick={() => setEditing(m)}>{accessLabel(m)}</button>
          : accessLabel(m)) },
        { key: 'mfa', label: 'Two-step', render: (m) => (m.kind === 'invite' ? '' : m.mfa ? <Badge kind="teal">On</Badge> : <Badge kind="grey">Off</Badge>) },
        { key: 'last_sign_in', label: 'Last sign-in', render: (m) => <span className="small muted">{m.last_sign_in ? [fmtDateTime(m.last_sign_in), m.last_ip].filter(Boolean).join(' · ') : '—'}</span> },
        { key: 'state', label: '', render: (m) => (m.kind === 'invite' ? <Badge kind="amber">Invited</Badge>
          : owner && m.user_id !== user.id ? <button className="link" onClick={() => run(() => setMember(m.email, m.role, m.display_name, !m.active), 'Saved').then(load).catch(() => {})}>{m.active ? 'Switch off' : 'Switch on'}</button>
          : <Badge kind={m.active ? 'teal' : 'grey'}>{m.active ? 'Active' : 'Off'}</Badge>) },
      ]} />
      <p className="small muted">Switching someone off or changing their access takes effect on their very next click. The job title is just a name; access decides what they can do. Owners always have full access and nobody can change their own.</p>
      {editing && <PersonAccess person={editing} access={access[editing.id]} roles={roles} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </>
  );
}

// One person's role and single-ability switches (eZee "Customize access")
function PersonAccess({ person, access, roles, onClose, onSaved }) {
  const { property } = useProperty();
  const [run, busy] = useAction();
  const invite = person.kind === 'invite';
  const [pick, setPick] = useState(access?.custom_role_id ? `custom:${access.custom_role_id}` : person.role);
  const [over, setOver] = useState(access?.overrides ?? {});
  const custom = pick.startsWith('custom:') ? roles.find((r) => `custom:${r.id}` === pick) : null;
  const base = new Set(custom ? custom.privileges : roleDefaults(pick));
  const isOn = (k) => (k in over ? over[k] : base.has(k));
  const toggle = (k) => {
    const next = { ...over };
    const want = !isOn(k);
    if (want === base.has(k)) delete next[k]; else next[k] = want;
    setOver(next);
  };
  const save = () => run(async () => {
    const builtIn = custom ? custom.base_role : pick;
    if (builtIn !== person.role) await rpc('pms_add_or_invite_member', { p_property: property.id, p_email: person.email, p_role: builtIn, p_display_name: person.display_name || null, p_active: person.active });
    await rpc('pms_set_member_access', { p_property: property.id, p_user: person.id, p_custom_role: custom?.id ?? null, p_overrides: invite ? {} : over });
  }, 'Access saved').then(onSaved).catch(() => {});
  const copy = () => run(() => rpc('pms_copy_access_to_all', { p_property: property.id, p_user: person.id }), null)
    .then((n) => window.alert(n ? `Copied to ${n} other propert${n === 1 ? 'y' : 'ies'}. Save first if you changed anything here.` : 'This person is not on the team at any other property you own.')).catch(() => {});
  return (
    <Modal wide title={`Access for ${person.display_name || person.email}`} onClose={onClose}
      footer={<><span className="muted small">{Object.keys(over).length ? `${Object.keys(over).length} change${Object.keys(over).length === 1 ? '' : 's'} from the role` : 'Follows the role exactly'}</span>
        <div className="row-gap">{!invite && <button className="btn" disabled={busy} onClick={copy}>Copy to all my properties</button>}<button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={save}>Save access</button></div></>}>
      <div className="inline-form">
        <Field label="Role" hint={custom ? `Rests on ${label(custom.base_role)}: that decides which records they can see.` : 'Built-in role'}>
          <select value={pick} onChange={(e) => { setPick(e.target.value); setOver({}); }}>{roleOptions(roles).filter(([v]) => v !== 'owner').map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </Field>
        {Object.keys(over).length > 0 && <button type="button" className="link" onClick={() => setOver({})}>Back to the role exactly</button>}
      </div>
      {invite
        ? <p className="muted">Single switches can be set once they have joined. Until then they get the role above.</p>
        : <PrivilegeList isOn={isOn} onToggle={toggle} changed={(k) => k in over} />}
    </Modal>
  );
}

// Grouped, searchable list of abilities with switches
function PrivilegeList({ isOn, onToggle, changed = () => false, readOnly }) {
  const [q, setQ] = useState('');
  const shown = PRIVILEGES.filter((p) => !q || p.label.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="priv">
      <input className="search" placeholder="Find an ability" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find an ability" />
      <div className="priv-groups">
        {PRIVILEGE_GROUPS.map((g) => {
          const items = shown.filter((p) => p.group === g.id);
          if (!items.length) return null;
          const on = items.filter((p) => isOn(p.key)).length;
          return (
            <fieldset key={g.id} className="priv-group">
              <legend>{g.label} <span className="muted small">{on} of {items.length}</span></legend>
              {items.map((p) => (
                <label key={p.key} className={`check priv-item ${changed(p.key) ? 'changed' : ''}`}>
                  <input type="checkbox" checked={isOn(p.key)} disabled={readOnly} onChange={() => onToggle(p.key)} /> {p.label}
                  {changed(p.key) && <span className="priv-flag">{isOn(p.key) ? 'added' : 'removed'}</span>}
                </label>
              ))}
            </fieldset>
          );
        })}
      </div>
    </div>
  );
}

// Custom roles built from the list of abilities
function Roles() {
  const { property, role } = useProperty();
  const [roles, load] = useRoles();
  const [run, busy] = useAction();
  const [edit, setEdit] = useState(null);
  const owner = can(role, 'staff');
  const start = (r) => setEdit(r ? { ...r, privileges: new Set(r.privileges) } : { id: null, name: '', base_role: 'front_desk', description: '', active: true, privileges: new Set(roleDefaults('front_desk')) });
  const save = () => run(() => rpc('pms_save_custom_role', { p_property: property.id, p_id: edit.id, p_name: edit.name, p_base_role: edit.base_role,
    p_description: edit.description || null, p_privileges: [...edit.privileges], p_active: edit.active }), 'Role saved').then(() => { setEdit(null); load(); }).catch(() => {});
  const remove = (r) => window.confirm(`Delete the role "${r.name}"?`) && run(() => rpc('pms_delete_custom_role', { p_role: r.id }), 'Role deleted').then(load).catch(() => {});
  return (
    <>
      <p className="muted">Make roles that match your job titles: start from a built-in role and switch abilities on or off. The built-in role underneath decides which records a person can see; the switches decide what they can do.</p>
      {owner && <button className="btn btn-primary" onClick={() => start(null)}>New role</button>}
      <div className="role-cards">
        {roles.map((r) => (
          <div key={r.id} className={`card role-card ${r.active ? '' : 'off'}`}>
            <div className="role-card-head"><strong>{r.name}</strong>{!r.active && <Badge kind="grey">Off</Badge>}</div>
            <div className="small muted">Rests on {label(r.base_role)} · {r.privileges.length} of {PRIVILEGES.length} abilities</div>
            {r.description && <p className="small">{r.description}</p>}
            <div className="row-gap">
              <button className="link" onClick={() => start(r)}>{owner ? 'Edit' : 'View'}</button>
              {owner && <button className="link danger" onClick={() => remove(r)}>Delete</button>}
            </div>
          </div>
        ))}
        {roles.length === 0 && <div className="empty">No custom roles yet. Everyone uses the six built-in roles.</div>}
      </div>
      {edit && (
        <Modal wide title={edit.id ? `Role: ${edit.name}` : 'New role'} onClose={() => setEdit(null)}
          footer={<><span className="muted small">{edit.privileges.size} of {PRIVILEGES.length} abilities</span>
            <div className="row-gap"><button className="btn" onClick={() => setEdit(null)}>Cancel</button>{owner && <button className="btn btn-primary" disabled={busy || !edit.name.trim()} onClick={save}>Save role</button>}</div></>}>
          <div className="inline-form">
            <Field label="Name"><input value={edit.name} disabled={!owner} placeholder="e.g. Front Office Associate" onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Rests on" hint="Which records they can see">
              <select value={edit.base_role} disabled={!owner} onChange={(e) => setEdit({ ...edit, base_role: e.target.value, ...(edit.id ? {} : { privileges: new Set(roleDefaults(e.target.value)) }) })}>
                {ROLES.filter((r) => r !== 'owner').map((r) => <option key={r} value={r}>{label(r)}</option>)}</select>
            </Field>
            <Field label="Description"><input value={edit.description ?? ''} disabled={!owner} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
            <label className="check"><input type="checkbox" checked={edit.active} disabled={!owner} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> In use</label>
            {owner && <button type="button" className="link" onClick={() => setEdit({ ...edit, privileges: new Set(roleDefaults(edit.base_role)) })}>Reset to {label(edit.base_role)}</button>}
          </div>
          <PrivilegeList readOnly={!owner} isOn={(k) => edit.privileges.has(k)} onToggle={(k) => { const n = new Set(edit.privileges); n.has(k) ? n.delete(k) : n.add(k); setEdit({ ...edit, privileges: n }); }} />
          {!edit.active && <p className="note warn small">People with a role that is switched off can do nothing until it is switched back on or they are given another role.</p>}
        </Modal>
      )}
    </>
  );
}

const ROLE_ONLY = [
  ['frontoffice', 'See guests, bookings, folios and payments'], ['rooms', 'See house status and work orders'], ['rateview', 'See the rate calendar'],
  ['setup', 'Setup and lists (this screen)'], ['staff', 'People, roles and access'],
];
function Access() {
  const [roles] = useRoles();
  const cols = [...ROLES.map((r) => ({ id: r, name: label(r), has: (k) => roleDefaults(r).includes(k) })),
    ...roles.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name, has: (k) => r.privileges.includes(k), custom: true }))];
  return (
    <>
      <p className="muted">Built-in roles and your own. The database checks every one of these on every request, and a test checks the list against the screens on every release, so hiding a button is never the only protection. Single people can differ from their role (People and roles).</p>
      <div className="table-wrap">
        <table className="table access-table">
          <thead><tr><th>Ability</th>{cols.map((c) => <th key={c.id} className={`center ${c.custom ? 'custom' : ''}`}>{c.name}</th>)}</tr></thead>
          <tbody>
            {PRIVILEGE_GROUPS.map((g) => [
              <tr key={g.id} className="access-group"><td colSpan={cols.length + 1}>{g.label}</td></tr>,
              ...PRIVILEGES.filter((p) => p.group === g.id).map((p) => (
                <tr key={p.key}><td>{p.label}</td>{cols.map((c) => <td key={c.id} className="center">{c.id === 'owner' || c.has(p.key) ? <span className="tick" aria-label="Yes">✓</span> : <span className="muted" aria-label="No">—</span>}</td>)}</tr>
              )),
            ])}
            <tr className="access-group"><td colSpan={cols.length + 1}>Set by the built-in role underneath</td></tr>
            {ROLE_ONLY.map(([k, l]) => (
              <tr key={k}><td>{l}</td>{cols.map((c) => <td key={c.id} className="center">{can(c.custom ? roles.find((r) => r.id === c.id).base_role : c.id, k) ? <span className="tick" aria-label="Yes">✓</span> : <span className="muted" aria-label="No">—</span>}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SignIns() {
  const { property } = useProperty();
  const [rows, setRows] = useState(null);
  useEffect(() => { rpc('pms_staff_devices', { p_property: property.id, p_user: null }).then(setRows).catch(() => setRows([])); }, [property.id]);
  const device = (ua = '') => (/iphone|ipad/i.test(ua) ? 'iPhone / iPad' : /android/i.test(ua) ? 'Android' : /windows/i.test(ua) ? 'Windows' : /mac os/i.test(ua) ? 'Mac' : /linux/i.test(ua) ? 'Linux' : 'Unknown')
    + (/edg\//i.test(ua) ? ' · Edge' : /chrome/i.test(ua) ? ' · Chrome' : /firefox/i.test(ua) ? ' · Firefox' : /safari/i.test(ua) ? ' · Safari' : '');
  return (
    <Table rows={rows} empty="No sign-ins recorded yet" columns={[
      { key: 'at', label: 'When', render: (r) => fmtDateTime(r.at) }, { key: 'email', label: 'Person' },
      { key: 'ip', label: 'IP address', render: (r) => <span className="mono">{r.ip ?? '—'}</span> }, { key: 'user_agent', label: 'Device', render: (r) => device(r.user_agent) },
    ]} />
  );
}

function Activity() {
  const { property } = useProperty();
  const [rows, setRows] = useState(null);
  const [who, setWho] = useState('');
  const [people, setPeople] = useState([]);
  useEffect(() => { rpc('pms_list_staff', { p_property: property.id }).then((r) => setPeople((r ?? []).filter((x) => x.kind === 'member'))).catch(() => {}); }, [property.id]);
  useEffect(() => { rpc('pms_staff_activity', { p_property: property.id, p_user: who || null, p_limit: 300 }).then(setRows).catch(() => setRows([])); }, [property.id, who]);
  const describe = (d) => (d ? Object.entries(d).filter(([, v]) => v !== null && typeof v !== 'object').slice(0, 4).map(([k, v]) => `${label(k)}: ${v}`).join(' · ') : '');
  return (
    <>
      <div className="inline-form"><Field label="Person"><select value={who} onChange={(e) => setWho(e.target.value)}><option value="">Everyone</option>{people.map((p) => <option key={p.user_id} value={p.user_id}>{p.display_name || p.email}</option>)}</select></Field></div>
      <Table rows={rows} empty="Nothing yet" columns={[
        { key: 'at', label: 'When', render: (r) => fmtDateTime(r.at) }, { key: 'user_name', label: 'Who' },
        { key: 'action', label: 'What', render: (r) => label(r.action.replace('.', ' ')) },
        { key: 'details', label: 'Details', render: (r) => <span className="small muted">{describe(r.details)}</span> },
        { key: 'ip', label: 'IP', render: (r) => <span className="mono small">{r.ip ?? ''}</span> },
      ]} />
    </>
  );
}

function SecurityRules() {
  const [s, save, busy] = useSettings();
  const [mfa, setMfa] = useState(!!s.require_mfa);
  return (
    <div className="card stack">
      <label className="check big"><input type="checkbox" checked={mfa} onChange={(e) => setMfa(e.target.checked)} /> <strong>Everyone at this property must use two-step sign-in</strong></label>
      <p className="small muted">People without an authenticator are sent to set one up before they can see anything. Turn yours on first (Sign-in security), or you will be asked too.</p>
      <div><button className="btn btn-primary" disabled={busy} onClick={() => save({ require_mfa: mfa }, 'Security rules saved')}>Save</button></div>
    </div>
  );
}

// ------------------------------------------------------------------ editable lists
function EditRow({ row, isNew, fields, busy, onSave, onCancel }) {
  const [r, setR] = useState(row);
  const dirty = JSON.stringify(r) !== JSON.stringify(row);
  return (
    <tr>
      {fields.map((f) => (
        <td key={f.key}>
          {f.hidden?.(r) ? <span className="muted small">—</span>
            : f.type === 'bool' ? <input type="checkbox" checked={!!r[f.key]} onChange={(e) => setR({ ...r, [f.key]: e.target.checked })} aria-label={f.label} />
            : f.options ? <select value={r[f.key] ?? ''} onChange={(e) => setR({ ...r, [f.key]: e.target.value })} aria-label={f.label}>
              {f.options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            : f.type === 'date' ? <input type="date" value={r[f.key] ?? ''} aria-label={f.label} onChange={(e) => setR({ ...r, [f.key]: e.target.value })} />
            : f.type === 'time' ? <input type="time" value={(r[f.key] ?? '').slice(0, 5)} aria-label={f.label} onChange={(e) => setR({ ...r, [f.key]: e.target.value })} />
            : f.type === 'list' ? <input value={Array.isArray(r[f.key]) ? r[f.key].join(', ') : r[f.key] ?? ''} aria-label={f.label} placeholder={f.placeholder}
              onChange={(e) => setR({ ...r, [f.key]: e.target.value })} />
            : <input className={f.type === 'number' || f.type === 'optnumber' ? 'num' : ''} inputMode={f.type === 'number' || f.type === 'optnumber' ? 'decimal' : undefined}
              value={r[f.key] ?? ''} aria-label={f.label} placeholder={f.placeholder}
              onChange={(e) => setR({ ...r, [f.key]: f.type === 'number' || f.type === 'optnumber' ? e.target.value.replace(/[^\d.]/g, '') : e.target.value })} />}
        </td>
      ))}
      <td className="row-actions">
        <button className="btn btn-small" disabled={busy || (!dirty && !isNew)} onClick={() => onSave(r)}>{isNew ? 'Add' : 'Save'}</button>
        {isNew && <button className="link" onClick={onCancel}>Cancel</button>}
      </td>
    </tr>
  );
}

// Generic editable list for simple setup tables
export function EditableList({ table, rows, fields, blank, onSaved, extra }) {
  const { property } = useProperty();
  const [run, busy] = useAction();
  const [draft, setDraft] = useState(null);
  const save = (row) => run(async () => {
    const payload = { property_id: property.id, ...(extra ?? {}) };
    for (const f of fields) {
      const v = row[f.key];
      payload[f.key] = f.type === 'number' ? Number(v || 0)
        : f.type === 'optnumber' ? (v === '' || v === null || v === undefined ? null : Number(v))
        : f.type === 'bool' ? !!v
        : f.type === 'list' ? (Array.isArray(v) ? v : String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean))
        : (v === '' ? null : v);
      if (f.type === 'list' && !payload[f.key].length) payload[f.key] = null;
    }
    const { error } = row.id ? await supabase.from(table).update(payload).eq('id', row.id) : await supabase.from(table).insert(payload);
    if (error) throw error;
    setDraft(null);
    onSaved();
  }, 'Saved').catch(() => {});

  return (
    <div className="table-wrap">
      <table className="table edit-table">
        <thead><tr>{fields.map((f) => <th key={f.key}>{f.label}</th>)}<th /></tr></thead>
        <tbody>
          {rows.map((r) => <EditRow key={r.id + JSON.stringify(r)} row={r} fields={fields} busy={busy} onSave={save} />)}
          {draft && <EditRow row={draft} isNew fields={fields} busy={busy} onSave={save} onCancel={() => setDraft(null)} />}
        </tbody>
      </table>
      {!draft && <button className="btn btn-ghost" onClick={() => setDraft({ ...blank })}>+ Add</button>}
    </div>
  );
}

