import { useEffect, useState } from 'react';
import { rpc, supabase } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { label, money, nightsBetween } from '../lib/format';
import { Field, Modal } from './ui.jsx';
import ChangeConfirm from './ChangeConfirm.jsx';

const CHARGE_CATS = ['fnb', 'laundry', 'minibar', 'transport', 'spa', 'recreation', 'tours', 'events', 'extra_bed', 'damage', 'room', 'other'];
const METHODS = [['cash', 'Cash'], ['mobile_money', 'Mobile money'], ['card', 'Card'], ['bank', 'Bank transfer'], ['other', 'Other']];
const SUB_TYPES = [['room', 'Room charge'], ['day_use', 'Day use'], ['early_checkin', 'Early check-in'], ['late_checkout', 'Late check-out'],
  ['no_show', 'No-show revenue'], ['cancellation', 'Cancellation revenue']];

// Suggest reasons from Setup → Quick remarks
function Remarks({ id, kind }) {
  const { lookups } = useProperty();
  const list = lookups.remarks.filter((r) => r.active && (r.kind === kind || r.kind === 'general'));
  return <datalist id={id}>{list.map((r) => <option key={r.id} value={r.text} />)}</datalist>;
}

export default function ActionDialog({ dialog, res, folio, property, onClose, onDone }) {
  const { lookups } = useProperty();
  const methods = lookups.paymentMethods.filter((m) => m.active);
  const stay = dialog.stay ?? res?.pms_stays?.find((s) => s.id === folio?.stay_id);
  const roundTo = Number(property.settings?.round_to ?? 0);
  const suggest = (n) => (n > 0 ? String(roundTo ? Math.ceil(n / roundTo) * roundTo : Math.ceil(n)) : '');
  const [f, setF] = useState(() => {
    const k = dialog.kind;
    if (k === 'payment') return { amount: suggest(folio?.balance ?? 0), method: methods[0]?.id ?? 'cash', reference: '', currency: property.currency, phone: res?.pms_guests?.phone ?? '' };
    if (k === 'refund') return { amount: String(-folio.balance), method: methods.find((m) => m.kind === 'cash')?.id ?? 'cash', reference: '' };
    if (k === 'charge') return { mode: lookups.extraCharges.some((e) => e.active) ? 'list' : 'custom', extra: '', qty: '1', category: 'fnb', description: '', amount: '', reference: '' };
    if (k === 'roomcharge') return { sub: dialog.sub ?? 'room', amount: dialog.amount ? String(dialog.amount) : String(stay?.rate ?? ''), comment: '' };
    if (k === 'discount') return { mode: lookups.discountTypes.some((d) => d.active) ? 'list' : 'custom', type: '', amount: '', reason: '' };
    if (k === 'adjustment') return { direction: 'down', amount: '', reason: '' };
    if (k === 'paidout') return { reason: lookups.payoutTypes.find((p) => p.active)?.name ?? '', amount: '', paid_to: '' };
    if (k === 'mealplan') return { plan: lookups.mealPlans.find((m) => m.active && Number(m.adult_rate) > 0)?.id ?? '', days: '1' };
    if (k === 'cut') return { from: property.business_date };
    if (k === 'amend') return { arrival: dialog.stay.arrival, departure: dialog.stay.departure, rate: String(dialog.stay.rate), adults: dialog.stay.adults, children: dialog.stay.children };
    return { amount: '', reason: '', no_show: false, transfer: false };
  });
  const [busy, setBusy] = useState(false);
  const [rates, setRates] = useState([]);
  const [phonePay, setPhonePay] = useState(false);
  const [late, setLate] = useState(null);
  useEffect(() => {
    if (dialog.kind === 'checkout' && dialog.stay) rpc('pms_late_checkout_quote', { p_stay: dialog.stay.id }).then(setLate).catch(() => {});
    if (dialog.kind !== 'payment') return;
    supabase.from('pms_integrations').select('enabled').eq('property_id', property.id).eq('provider', 'clickpesa').maybeSingle()
      .then(({ data }) => setPhonePay(!!data?.enabled));
    supabase.from('pms_exchange_rates').select('currency, rate, effective_date').eq('property_id', property.id)
      .lte('effective_date', property.business_date).order('effective_date', { ascending: false })
      .then(({ data }) => {
        const m = {};
        for (const r of data ?? []) if (!m[r.currency]) m[r.currency] = r;
        setRates(Object.values(m));
      });
  }, [dialog, property]);
  const fxRate = rates.find((r) => r.currency === f.currency)?.rate;
  const foreign = dialog.kind === 'payment' && f.currency && f.currency !== property.currency;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const num = (k) => (e) => setF({ ...f, [k]: e.target.value.replace(/[^\d.]/g, '') });
  const method = methods.find((m) => m.id === f.method);
  const kindOf = method?.kind ?? f.method;
  const extra = lookups.extraCharges.find((e) => e.id === f.extra);
  const nights = stay ? nightsBetween(stay.arrival, stay.departure) : 1;
  const people = stay ? (stay.adults ?? 1) + (stay.children ?? 0) : 1;
  const pickExtra = (id) => {
    const e = lookups.extraCharges.find((x) => x.id === id);
    const q = !e ? 1 : e.charge_mode === 'per_night' ? nights : e.charge_mode === 'per_person' ? people : e.charge_mode === 'per_person_night' ? nights * people : 1;
    setF({ ...f, extra: id, qty: String(q) });
  };

  const [review, setReview] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (dialog.kind === 'amend' && !review) { setReview(true); return; }  // show what it does to the charges first
    setBusy(true);
    try {
      const k = dialog.kind;
      if (k === 'payment' && f.method === 'phone_request') {
        await onDone(() => rpc('pms_request_mobile_payment', { p_folio: folio.id, p_phone: f.phone, p_amount: Number(f.amount) }),
          'Request sent. The guest approves it on their phone with their PIN.');
      } else if (k === 'payment' && foreign) {
        await onDone(() => rpc('pms_post_payment_fx', { p_folio: folio.id, p_currency: f.currency, p_foreign_amount: Number(f.amount), p_method: kindOf, p_reference: f.reference || null }), `Payment of ${f.currency} ${f.amount} posted`);
      } else if ((k === 'payment' || k === 'refund') && method) {
        await onDone(() => rpc('pms_post_payment_method', { p_folio: folio.id, p_amount: Number(f.amount), p_method: method.id, p_reference: f.reference || null, p_refund: k === 'refund' }), k === 'refund' ? 'Refund posted' : `Payment by ${method.name} posted`);
      } else if (k === 'payment' || k === 'refund') {
        await onDone(() => rpc('pms_post_payment', { p_folio: folio.id, p_amount: Number(f.amount), p_method: f.method, p_reference: f.reference || null, p_refund: k === 'refund' }), k === 'refund' ? 'Refund posted' : 'Payment posted');
      } else if (k === 'charge' && f.mode === 'list') {
        await onDone(() => rpc('pms_post_extra_charge', { p_folio: folio.id, p_extra: f.extra, p_qty: Number(f.qty || 1), p_note: f.description || null }), 'Charge posted');
      } else if (k === 'charge') {
        await onDone(() => rpc('pms_post_charge', { p_folio: folio.id, p_category: f.category, p_description: f.description || label(f.category), p_amount: Number(f.amount), p_reference: f.reference || null }), 'Charge posted');
      } else if (k === 'roomcharge') {
        await onDone(() => rpc('pms_post_room_charge', { p_folio: folio.id, p_sub_type: f.sub, p_amount: Number(f.amount), p_comment: f.comment || null }), `${SUB_TYPES.find((x) => x[0] === f.sub)[1]} posted`);
      } else if (k === 'discount' && f.mode === 'list') {
        await onDone(() => rpc('pms_post_discount_type', { p_folio: folio.id, p_type: f.type, p_note: f.reason || null }), 'Discount posted');
      } else if (k === 'discount') {
        await onDone(() => rpc('pms_post_discount', { p_folio: folio.id, p_amount: Number(f.amount), p_reason: f.reason }), 'Discount posted');
      } else if (k === 'adjustment') {
        await onDone(() => rpc('pms_post_adjustment', { p_folio: folio.id, p_amount: (f.direction === 'down' ? -1 : 1) * Number(f.amount), p_reason: f.reason }), 'Adjustment posted');
      } else if (k === 'paidout') {
        await onDone(() => rpc('pms_post_paid_out', { p_folio: folio.id, p_amount: Number(f.amount), p_description: f.reason, p_paid_to: f.paid_to || null }), 'Paid out and added to the bill');
      } else if (k === 'mealplan') {
        await onDone(() => rpc('pms_post_meal_plan', { p_folio: folio.id, p_meal_plan: f.plan, p_days: Number(f.days || 1) }), 'Meal plan posted');
      } else if (k === 'cut') {
        await onDone(() => rpc('pms_cut_folio', { p_folio: folio.id, p_from: f.from }), 'Everything from that date moved to a new folio');
      } else if (k === 'void') {
        await onDone(() => rpc('pms_void_line', { p_line: dialog.line.id, p_reason: f.reason }), 'Line voided');
      } else if (k === 'cancel') {
        await onDone(() => rpc('pms_cancel_stay', { p_stay: dialog.stay.id, p_reason: f.reason, p_no_show: f.no_show }), f.no_show ? 'Marked no-show' : 'Cancelled');
      } else if (k === 'checkout') {
        await onDone(() => rpc('pms_check_out', { p_stay: dialog.stay.id, p_transfer_to_company: f.transfer }), 'Checked out');
      } else if (k === 'amend') {
        await onDone(() => rpc('pms_amend_stay', {
          p_stay: dialog.stay.id, p_arrival: f.arrival, p_departure: f.departure, p_rate: f.confirmedRate ?? null,
          p_adults: Number(f.adults), p_children: Number(f.children),
        }), 'Stay updated');
      }
    } catch { /* toast already shown */ } finally { setBusy(false); }
  };

  const titles = { payment: 'Take payment', refund: 'Refund', charge: 'Add a charge', roomcharge: 'Room charge', discount: 'Discount', adjustment: 'Adjustment',
    paidout: 'Pay out for the guest', mealplan: 'Meal plan', cut: 'Split from a date', void: 'Void posting', cancel: 'Cancel room', checkout: 'Check out', amend: 'Amend stay' };
  const stayFolios = dialog.stay ? res.pms_folios.filter((x) => x.stay_id === dialog.stay.id && x.status === 'open') : [];
  const stayBal = stayFolios.reduce((n, x) => n + x.balance, 0);
  const mealPlan = lookups.mealPlans.find((m) => m.id === f.plan);
  const discountType = lookups.discountTypes.find((d) => d.id === f.type);

  if (dialog.kind === 'amend' && review) {
    const st = dialog.stay;
    const nights = nightsBetween(f.arrival, f.departure), before = nightsBetween(st.arrival, st.departure);
    return (
      <ChangeConfirm stay={st} busy={busy} title="Confirm the change" onClose={() => setReview(false)}
        initialRate={Number(f.rate) !== Number(st.rate) ? Number(f.rate) : null}
        change={{ arrival: f.arrival, departure: f.departure, adults: Number(f.adults), children: Number(f.children) }}
        summary={nights === before ? 'Change this stay?' : nights > before ? `Extend the stay by ${nights - before} night${nights - before === 1 ? '' : 's'}?` : `Shorten the stay by ${before - nights} night${before - nights === 1 ? '' : 's'}?`}
        onConfirm={async ({ rate, reason }) => {
          setBusy(true);
          try {
            await onDone(() => rpc('pms_change_stay', { p_stay: st.id, p_arrival: f.arrival, p_departure: f.departure,
              p_adults: Number(f.adults), p_children: Number(f.children), p_rate: rate, p_reason: reason || null }), 'Stay updated');
          } catch { /* toast shown */ } finally { setBusy(false); }
        }} />
    );
  }

  return (
    <Modal title={titles[dialog.kind]} onClose={onClose}
      footer={<><span /><div className="row-gap"><button className="btn" onClick={onClose}>Close</button>
        <button className="btn btn-primary" form="act" disabled={busy}>{busy ? 'Saving…' : f.method === 'phone_request' ? 'Send request' : dialog.kind === 'amend' ? 'Review the change' : titles[dialog.kind]}</button></div></>}>
      <form id="act" onSubmit={submit} className="stack">
        {(dialog.kind === 'payment' || dialog.kind === 'refund') && <>
          <div className="grid-2">
            {dialog.kind === 'payment' && rates.length > 0 && f.method !== 'phone_request' && (
              <Field label="Currency">
                <select value={f.currency} onChange={(e) => {
                  const cur = e.target.value; const r = rates.find((x) => x.currency === cur)?.rate;
                  const due = Math.max(0, folio?.balance ?? 0);
                  setF({ ...f, currency: cur, amount: cur === property.currency ? suggest(due) : r && due ? String(Math.ceil((due / r) * 100) / 100) : '' });
                }}>
                  <option value={property.currency}>{property.currency}</option>
                  {rates.map((r) => <option key={r.currency} value={r.currency}>{r.currency}</option>)}
                </select>
              </Field>
            )}
            <Field label={`Amount (${foreign ? f.currency : property.currency})`}
              hint={foreign && fxRate ? `= ${property.currency} ${money(Number(f.amount || 0) * fxRate)} at ${money(fxRate)}` : undefined}>
              <input autoFocus required inputMode="decimal" value={f.amount} onChange={num('amount')} />
            </Field>
          </div>
          <Field label="Paid with" hint={method && (Number(method.surcharge_pct) > 0 || Number(method.surcharge_fixed) > 0) && dialog.kind === 'payment'
            ? `Adds a ${Number(method.surcharge_pct) ? `${Number(method.surcharge_pct)}%` : ''}${Number(method.surcharge_pct) && Number(method.surcharge_fixed) ? ' + ' : ''}${Number(method.surcharge_fixed) ? money(method.surcharge_fixed) : ''} charge to the bill` : undefined}>
            <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value, currency: e.target.value === 'phone_request' ? property.currency : f.currency })}>
              {dialog.kind === 'payment' && phonePay && <option value="phone_request">Send a request to the guest's phone (mobile money)</option>}
              {methods.length ? methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>) : METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          {f.method === 'phone_request' ? (
            <Field label="Guest's mobile number" hint="M-Pesa, Tigo Pesa, Airtel Money or Halopesa. The guest enters their PIN on the phone, and the payment appears on the folio by itself.">
              <input required inputMode="tel" value={f.phone} onChange={set('phone')} placeholder="0713 000 111" />
            </Field>
          ) : (
            <Field label="Reference" hint={kindOf === 'cash' ? 'Cash goes into your open drawer.' : 'Required: transaction code, card slip or bank reference.'}>
              <input value={f.reference} onChange={set('reference')} required={['mobile_money', 'card', 'bank'].includes(kindOf)} />
            </Field>
          )}
        </>}
        {dialog.kind === 'charge' && <>
          {lookups.extraCharges.some((e) => e.active) && (
            <div className="pills" role="tablist">
              <button type="button" className={f.mode === 'list' ? 'on' : ''} onClick={() => setF({ ...f, mode: 'list' })}>From the list</button>
              <button type="button" className={f.mode === 'custom' ? 'on' : ''} onClick={() => setF({ ...f, mode: 'custom' })}>Something else</button>
            </div>
          )}
          {f.mode === 'list' ? <>
            <Field label="Charge"><select required value={f.extra} onChange={(e) => pickExtra(e.target.value)}>
              <option value="">Choose…</option>{lookups.extraCharges.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.name} · {money(e.amount)}{e.charge_mode !== 'once' ? ` ${label(e.charge_mode).toLowerCase()}` : ''}</option>)}</select></Field>
            <div className="grid-2">
              <Field label="Quantity" hint={extra && extra.charge_mode !== 'once' ? `Suggested from ${nights} night(s), ${people} guest(s)` : undefined}><input required inputMode="decimal" value={f.qty} onChange={num('qty')} /></Field>
              <Field label="Total"><input disabled value={extra ? `${property.currency} ${money(Number(extra.amount) * Number(f.qty || 0))}` : ''} /></Field>
            </div>
            <Field label="Note (optional)"><input value={f.description} onChange={set('description')} /></Field>
          </> : <>
            <Field label="Department"><select value={f.category} onChange={set('category')}>{CHARGE_CATS.map((c) => <option key={c} value={c}>{c === 'fnb' ? 'Food & beverage' : label(c)}</option>)}</select></Field>
            <Field label="Description"><input value={f.description} onChange={set('description')} placeholder="e.g. Dinner — restaurant bill 0042" /></Field>
            <Field label={`Amount (${property.currency})`}><input required inputMode="decimal" value={f.amount} onChange={num('amount')} /></Field>
            <Field label="Reference"><input value={f.reference} onChange={set('reference')} placeholder="Bill or docket number" /></Field>
          </>}
        </>}
        {dialog.kind === 'roomcharge' && <>
          <Field label="Type"><select value={f.sub} onChange={set('sub')}>{SUB_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label={`Amount (${property.currency})`} hint={stay ? `The nightly rate is ${money(stay.rate)}` : undefined}><input required inputMode="decimal" value={f.amount} onChange={num('amount')} /></Field>
          <Field label="Comment"><input value={f.comment} onChange={set('comment')} placeholder="e.g. Left at 15:00" /></Field>
          <p className="small muted">Counts as room revenue. Regular nights are posted by the night audit, so use this for extras such as day use or a late check-out.</p>
        </>}
        {dialog.kind === 'discount' && <>
          {lookups.discountTypes.some((d) => d.active) && (
            <div className="pills">
              <button type="button" className={f.mode === 'list' ? 'on' : ''} onClick={() => setF({ ...f, mode: 'list' })}>From the list</button>
              <button type="button" className={f.mode === 'custom' ? 'on' : ''} onClick={() => setF({ ...f, mode: 'custom' })}>Any amount</button>
            </div>
          )}
          {f.mode === 'list'
            ? <Field label="Discount" hint={discountType ? `${discountType.kind === 'percent' ? `${Number(discountType.value)}% of ${discountType.applies_to === 'room' ? 'room charges' : 'all charges'} posted` : money(discountType.value)}` : undefined}>
                <select required value={f.type} onChange={set('type')}><option value="">Choose…</option>{lookups.discountTypes.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
            : <Field label={`Amount (${property.currency})`}><input autoFocus required inputMode="decimal" value={f.amount} onChange={num('amount')} /></Field>}
          <Field label={f.mode === 'list' ? 'Note (optional)' : 'Reason'}><input required={f.mode !== 'list'} list="rm-discount" value={f.reason} onChange={set('reason')} /></Field>
          <Remarks id="rm-discount" kind="discount" />
        </>}
        {dialog.kind === 'adjustment' && <>
          <div className="pills">
            <button type="button" className={f.direction === 'down' ? 'on' : ''} onClick={() => setF({ ...f, direction: 'down' })}>Reduce the bill</button>
            <button type="button" className={f.direction === 'up' ? 'on' : ''} onClick={() => setF({ ...f, direction: 'up' })}>Increase the bill</button>
          </div>
          <Field label={`Amount (${property.currency})`}><input autoFocus required inputMode="decimal" value={f.amount} onChange={num('amount')} /></Field>
          <Field label="Reason"><input required list="rm-adjust" value={f.reason} onChange={set('reason')} /></Field>
          <Remarks id="rm-adjust" kind="adjustment" />
          <p className="small muted">For corrections, such as a charge on a day that is already closed. Shown separately in reports.</p>
        </>}
        {dialog.kind === 'paidout' && <>
          <Field label="What for"><input required list="po-types" value={f.reason} onChange={set('reason')} placeholder="Taxi, pharmacy…" /></Field>
          <datalist id="po-types">{lookups.payoutTypes.filter((p) => p.active).map((p) => <option key={p.id} value={p.name} />)}</datalist>
          <div className="grid-2">
            <Field label={`Cash paid (${property.currency})`}><input required inputMode="decimal" value={f.amount} onChange={num('amount')} /></Field>
            <Field label="Paid to"><input value={f.paid_to} onChange={set('paid_to')} /></Field>
          </div>
          <p className="small muted">The cash leaves your drawer now and is added to the guest's bill. Not counted as revenue.</p>
        </>}
        {dialog.kind === 'mealplan' && <>
          <Field label="Meal plan"><select required value={f.plan} onChange={set('plan')}><option value="">Choose…</option>
            {lookups.mealPlans.filter((m) => m.active).map((m) => <option key={m.id} value={m.id}>{m.name} · {money(m.adult_rate)} adult / {money(m.child_rate)} child</option>)}</select></Field>
          <Field label="Days"><input required inputMode="numeric" value={f.days} onChange={num('days')} /></Field>
          {mealPlan && stay && <p className="small">{stay.adults} adult(s), {stay.children} child(ren): <strong>{property.currency} {money((mealPlan.adult_rate * stay.adults + mealPlan.child_rate * stay.children) * Number(f.days || 1))}</strong></p>}
        </>}
        {dialog.kind === 'cut' && <>
          <Field label="Move everything posted from"><input type="date" required value={f.from} onChange={set('from')} /></Field>
          <p className="small muted">Useful when a company starts paying part-way through a stay: everything from this date goes to a new folio.</p>
        </>}
        {dialog.kind === 'void' && <>
          <p>Void <strong>{dialog.line.description}</strong> ({money(Math.abs(dialog.line.amount))})? The line stays on record and appears in the void report.</p>
          <Field label="Reason"><input autoFocus required list="rm-void" value={f.reason} onChange={set('reason')} /></Field>
          <Remarks id="rm-void" kind="void" />
        </>}
        {dialog.kind === 'cancel' && <>
          <Field label="Reason"><input autoFocus required list="rm-cancel" value={f.reason} onChange={set('reason')} /></Field>
          <Remarks id="rm-cancel" kind="cancel" />
          <label className="check"><input type="checkbox" checked={f.no_show} onChange={set('no_show')} /> Record as no-show instead of cancellation</label>
        </>}
        {dialog.kind === 'checkout' && <>
          <p>Room {dialog.stay.pms_rooms?.number} · balance <strong>{property.currency} {money(stayBal)}</strong></p>
          {late?.late && Number(late.amount) > 0 && (
            <div className="note warn">It is past check-out time ({late.check_out_time}). A late check-out would be {property.currency} {money(late.amount)}.{' '}
              <button type="button" className="link" onClick={() => { onClose(); dialog.onLate?.(late.amount); }}>Post it first</button></div>
          )}
          {stayBal > 0 && !res.company_id && <p className="danger">Settle the balance first: take a payment on the folio.</p>}
          {stayBal > 0 && res.company_id && (
            <label className="check"><input type="checkbox" checked={f.transfer} onChange={set('transfer')} /> Transfer {money(stayBal)} to {res.pms_companies?.name} (city ledger)</label>
          )}
          {stayBal < 0 && <p className="danger">The guest has a credit of {money(-stayBal)}. Refund it before check-out.</p>}
          <p className="muted small">The room is marked dirty after check-out.</p>
        </>}
        {dialog.kind === 'amend' && <>
          <div className="grid-2">
            <Field label="Arrival"><input type="date" value={f.arrival} onChange={set('arrival')} disabled={dialog.stay.status === 'checked_in'} /></Field>
            <Field label="Departure"><input type="date" value={f.departure} onChange={set('departure')} /></Field>
            <Field label={`Rate / night (${property.currency})`}><input inputMode="decimal" value={f.rate} onChange={num('rate')} /></Field>
            <div className="grid-2">
              <Field label="Adults"><input type="number" min={1} value={f.adults} onChange={set('adults')} /></Field>
              <Field label="Children"><input type="number" min={0} value={f.children} onChange={set('children')} /></Field>
            </div>
          </div>
          <p className="muted small">Next you'll see what this does to the room charges and choose the rate for the nights still to charge.</p>
        </>}
      </form>
    </Modal>
  );
}
