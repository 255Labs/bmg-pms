import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc, supabase } from '../lib/supabase';
import { fmtDate, fmtDateTime, money } from '../lib/format';
import { Badge, Field, Loading, Modal, useAction } from './ui.jsx';
import Icon from './icons.jsx';

// The property's BMG PMS subscription: plan, invoices, paying by mobile money. Owners pay; managers can look.
export const SUB_STATUS = {
  trial: ['Free trial', 'blue'], active: ['Up to date', 'teal'], past_due: ['Payment overdue', 'amber'],
  locked: ['Locked: unpaid', 'red'], cancelled: ['Cancelled', 'grey'], none: ['No subscription', 'grey'],
};
const INV_STATUS = { open: ['Open', 'amber'], paid: ['Paid', 'teal'], void: ['Voided', 'grey'] };
// 255713000111 → +255 713 000 111
const showPhone = (p) => (/^255\d{9}$/.test(p ?? '') ? `+255 ${p.slice(3, 6)} ${p.slice(6, 9)} ${p.slice(9)}` : p);
const PAY_STATUS = { queued: 'Sending to phone', sent: 'Waiting for PIN', paid: 'Paid', failed: 'Failed', expired: 'Not answered', cancelled: 'Cancelled' };

export function useSubscription(propertyId) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    if (!propertyId) return Promise.resolve();
    return rpc('pms_billing_status', { p_property: propertyId }).then((d) => { setData(d); setError(null); }).catch((e) => setError(e.message));
  }, [propertyId]);
  useEffect(() => { setData(null); load(); }, [load]);
  return { data, error, reload: load };
}

export default function Subscription({ propertyId, role, onPaid }) {
  const { data, error, reload } = useSubscription(propertyId);
  const [paying, setPaying] = useState(null);
  const [show, setShow] = useState(null);
  if (error) return <p className="muted">{error}</p>;
  if (!data) return <Loading />;
  const s = data.subscription;
  const [stLabel, stKind] = SUB_STATUS[s?.status ?? 'none'];
  const open = data.invoices.filter((i) => i.status === 'open');
  const overdue = open.filter((i) => i.due_on < data.today);
  const cur = data.invoices[0]?.currency ?? data.plan?.currency ?? 'TZS';
  return (
    <div className="sub-page">
      <div className={`sub-status st-${s?.status ?? 'none'}`}>
        <div>
          <div className="sub-label">BMG PMS subscription</div>
          <div className="sub-state"><Badge kind={stKind}>{stLabel}</Badge>{s?.plan && <span className="muted small"> · {s.plan} plan</span>}</div>
          <p className="small">
            {s?.status === 'trial' && <>Free until {fmtDate(s.trial_ends)}. The first invoice comes after that.</>}
            {s?.status === 'active' && !open.length && <>Nothing to pay now. Next invoice around {fmtDate(data.next_invoice_on)}.</>}
            {s?.status === 'active' && open.length > 0 && <>Invoice {open[0].invoice_no} is due by {fmtDate(open[0].due_on)}.</>}
            {s?.status === 'past_due' && <>Overdue since {fmtDate(overdue[0]?.due_on)}. The property locks for everyone on {fmtDate(overdue[0]?.lock_on)} unless it is paid in full.</>}
            {s?.status === 'locked' && <>Nobody can work in this property until the overdue amount is paid in full. Paying unlocks it straight away.</>}
            {!s && <>This property has no subscription set up yet. BMG will contact you.</>}
          </p>
        </div>
        <div className="sub-balance">
          <span className="sub-label">Still to pay</span>
          <strong className="money">{money(data.balance, cur)}</strong>
          {role === 'owner' && open.length > 0 && <button className="btn btn-primary" onClick={() => setPaying(overdue[0] ?? open[open.length - 1])}><Icon name="phone" size={16} /> Pay by mobile money</button>}
          {role !== 'owner' && open.length > 0 && <span className="small muted">Only an owner can pay.</span>}
        </div>
      </div>

      {data.plan && !s?.price_override && (
        <p className="small muted">
          How it is worked out: {[Number(data.plan.base_monthly) > 0 && `${money(data.plan.base_monthly, cur)} a month`,
            Number(data.plan.per_room) > 0 && `${money(data.plan.per_room, cur)} per active room`,
            Number(data.plan.per_user) > 0 && `${money(data.plan.per_user, cur)} per active staff account`].filter(Boolean).join(' + ')}
          {Number(data.plan.vat_pct) > 0 && `, plus VAT ${Number(data.plan.vat_pct)}%`}. Counted on the invoice day. Pay within {s?.due_days} days; after {s?.grace_days} more days unpaid the property locks.
        </p>
      )}
      {s?.price_override != null && <p className="small muted">Agreed monthly price: {money(s.price_override, cur)} before VAT.</p>}

      <MyPackage propertyId={propertyId} />

      <h3>Invoices</h3>
      {!data.invoices.length ? <p className="muted small">No invoices yet.</p> : (
        <div className="inv-list">
          {data.invoices.map((i) => (
            <button type="button" key={i.id} className={`inv-row ${i.status}`} onClick={() => setShow(i)}>
              <div>
                <strong>{i.invoice_no}</strong> <Badge kind={INV_STATUS[i.status][1]}>{INV_STATUS[i.status][0]}</Badge>
                <div className="small muted">{fmtDate(i.period_start)} – {fmtDate(i.period_end)}</div>
                <div className={`small ${i.status === 'open' && i.due_on < data.today ? 'danger' : 'muted'}`}>Due {fmtDate(i.due_on)}</div>
              </div>
              <div className="inv-money">
                <strong>{money(i.total, i.currency)}</strong>
                {i.status !== 'void' && <div className="small muted">paid {money(i.paid, i.currency)}</div>}
              </div>
            </button>
          ))}
        </div>
      )}

      {data.payments.length > 0 && (
        <>
          <h3>Payments</h3>
          <div className="inv-list">
            {data.payments.map((p) => (
              <div key={p.id} className="inv-row">
                <div>
                  <strong>{p.method === 'mobile_money' ? 'Mobile money' : p.method === 'bank' ? 'Bank transfer' : p.method === 'cash' ? 'Cash' : 'Other'}</strong>
                  {p.phone && <span className="small muted"> · {showPhone(p.phone)}</span>}
                  <div className="small muted">{fmtDateTime(p.paid_at ?? p.created_at)}{p.reference ? ` · ${p.reference}` : ''}</div>
                  <div className={`small ${p.status === 'failed' ? 'danger' : 'muted'}`}>{PAY_STATUS[p.status]}{p.error ? ` · ${p.error}` : ''}</div>
                </div>
                <div className="inv-money"><strong>{money(p.amount, cur)}</strong></div>
              </div>
            ))}
          </div>
        </>
      )}
      {show && <InvoiceView inv={show} onClose={() => setShow(null)} canPay={role === 'owner' && show.status === 'open'} onPay={() => { setPaying(show); setShow(null); }} />}
      {paying && <PayInvoice inv={paying} defaultPhone={s?.billing_phone} onClose={() => { setPaying(null); reload(); }} onPaid={() => { reload(); onPaid?.(); }} />}
    </div>
  );
}

function InvoiceView({ inv, onClose, canPay, onPay }) {
  return (
    <Modal title={`Invoice ${inv.invoice_no}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Close</button>
      {canPay && <button className="btn btn-primary" onClick={onPay}>Pay by mobile money</button>}
    </>}>
      <p className="small muted">Period {fmtDate(inv.period_start)} – {fmtDate(inv.period_end)} · issued {fmtDate(inv.issued_on)} · due {fmtDate(inv.due_on)}</p>
      <table className="sub-lines">
        <tbody>
          {inv.lines.map((l, i) => (
            <tr key={i}><td>{l.label}{Number(l.qty) !== 1 ? <span className="muted small"> · {l.qty} × {money(l.unit, inv.currency)}</span> : ''}</td><td className="num">{money(l.amount, inv.currency)}</td></tr>
          ))}
          <tr className="sub-sum"><td>Subtotal</td><td className="num">{money(inv.subtotal, inv.currency)}</td></tr>
          {Number(inv.vat) > 0 && <tr><td>VAT</td><td className="num">{money(inv.vat, inv.currency)}</td></tr>}
          <tr className="sub-total"><td>Total</td><td className="num">{money(inv.total, inv.currency)}</td></tr>
          {Number(inv.paid) > 0 && <tr><td>Paid</td><td className="num">{money(inv.paid, inv.currency)}</td></tr>}
          {inv.status === 'open' && <tr className="sub-total"><td>Still to pay</td><td className="num">{money(inv.total - inv.paid, inv.currency)}</td></tr>}
        </tbody>
      </table>
      <p className="small muted">To pay by bank transfer, use the invoice number as the reference and send the slip to BMG; the payment is recorded by BMG.</p>
    </Modal>
  );
}

// Send the request to the owner's phone, then watch until ClickPesa confirms (the payments worker checks every minute)
function PayInvoice({ inv, defaultPhone, onClose, onPaid }) {
  const [run, busy] = useAction();
  const [phone, setPhone] = useState(defaultPhone ?? '');
  const [req, setReq] = useState(null);
  const [state, setState] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearInterval(timer.current), []);
  const watch = (id) => {
    let n = 0;
    timer.current = setInterval(async () => {
      n += 1;
      const { data } = await supabase.rpc('pms_billing_payment_state', { p_payment: id });
      if (data) setState(data);
      if (data === 'paid') { clearInterval(timer.current); onPaid?.(); }
      if (['failed', 'expired', 'cancelled'].includes(data) || n > 60) clearInterval(timer.current);
    }, 5000);
  };
  const send = () => run(() => rpc('pms_billing_pay', { p_invoice: inv.id, p_phone: phone })).then((r) => { setReq(r); setState('queued'); watch(r.id); }).catch(() => {});
  const due = Math.ceil(inv.total - inv.paid);
  return (
    <Modal title={`Pay ${inv.invoice_no}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{state === 'paid' ? 'Done' : 'Close'}</button>
      {!req && <button className="btn btn-primary" disabled={busy || !phone.trim()} onClick={send}>Send request to phone</button>}
      {req && ['failed', 'expired'].includes(state) && <button className="btn btn-primary" disabled={busy} onClick={() => { setReq(null); setState(null); }}>Try again</button>}
    </>}>
      {!req && (
        <>
          <p>A payment request for <strong>{money(due, inv.currency)}</strong> goes to the phone. Enter the PIN on the phone to approve it.</p>
          <Field label="Mobile money number" hint="M-Pesa, Tigo Pesa, Airtel Money or HaloPesa, e.g. 0713 000 111">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoFocus />
          </Field>
        </>
      )}
      {req && (
        <div className={`pay-wait ${state}`} role="status">
          {state === 'paid' ? <><Icon name="check" size={22} /> <strong>Paid. Thank you.</strong> The property is up to date.</>
            : state === 'failed' ? <>The request did not go through. Check the number and try again, or pay by bank transfer.</>
              : state === 'expired' ? <>The phone did not answer in time. Try again.</>
                : <><span className="spinner" /> Waiting for the PIN on {showPhone(req.phone)}. This page updates by itself.</>}
        </div>
      )}
    </Modal>
  );
}

// Shown instead of the PMS when every property this person can reach is locked for an unpaid subscription
export function BillingGate({ blocked, onBack, onPaid }) {
  const [sel, setSel] = useState(blocked[0]?.property_id);
  const cur = blocked.find((b) => b.property_id === sel) ?? blocked[0];
  return (
    <div className="center-screen billing-gate">
      <div className="card gate-card">
        <div className="gate-head">
          <Icon name="lock" size={22} />
          <div>
            <h2 className="first">{cur.name} is locked</h2>
            <p className="muted">The BMG PMS subscription has not been paid in full. Bookings, guests and the rest of the data are safe and come back as soon as it is paid.</p>
          </div>
        </div>
        {blocked.length > 1 && (
          <Field label="Property">
            <select value={sel} onChange={(e) => setSel(e.target.value)}>{blocked.map((b) => <option key={b.property_id} value={b.property_id}>{b.name}</option>)}</select>
          </Field>
        )}
        {['owner', 'manager'].includes(cur.role)
          ? <Subscription key={cur.property_id} propertyId={cur.property_id} role={cur.role} onPaid={onPaid} />
          : <p>Please ask the property's owner to pay the outstanding {money(cur.balance, cur.currency)}. You can sign in again as soon as it is paid.</p>}
        <div className="row-gap" style={{ marginTop: 16 }}>
          {onBack && <button className="btn" onClick={onBack}>Back</button>}
          <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>
    </div>
  );
}

// A strip at the top of the desk when the subscription needs attention (owners and managers only)
export function SubscriptionStrip({ propertyId, role, onOpen }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    setD(null);
    if (!propertyId || !['owner', 'manager'].includes(role)) return;
    rpc('pms_billing_status', { p_property: propertyId }).then(setD).catch(() => {});
  }, [propertyId, role]);
  if (!d?.subscription) return null;
  const open = d.invoices.filter((i) => i.status === 'open');
  if (!open.length) return null;
  const overdue = open.filter((i) => i.due_on < d.today);
  const first = overdue[0] ?? open[open.length - 1];
  const soon = !overdue.length && (new Date(first.due_on) - new Date(d.today)) / 86400000 <= 3;
  if (!overdue.length && !soon) return null;
  return (
    <div className={`sub-strip ${overdue.length ? 'late' : ''}`} role="status">
      <Icon name="receipt" size={15} />
      <span>{overdue.length
        ? d.subscription.status === 'locked'
          ? <>Subscription unpaid: {money(d.balance, first.currency)}. The property is locked for staff until it is paid in full.</>
          : <>Subscription overdue: {money(d.balance, first.currency)}. The property locks on {fmtDate(first.lock_on)} unless paid in full.</>
        : <>Subscription invoice {first.invoice_no} is due {fmtDate(first.due_on)}.</>}</span>
      <button className="link" onClick={onOpen}>{role === 'owner' ? 'Pay now' : 'View'}</button>
    </div>
  );
}

// What this property has, and what else BMG can switch on. Prices are set by BMG; ask them to change the package.
function MyPackage({ propertyId }) {
  const [rows, setRows] = useState(null);
  useEffect(() => { rpc('pms_my_package', { p_property: propertyId }).then(setRows).catch(() => setRows([])); }, [propertyId]);
  if (!rows?.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  const price = (r) => (r.included ? 'In your plan' : r.free_until && r.free_until >= today ? `Free to ${fmtDate(r.free_until)}`
    : !Number(r.monthly) && !Number(r.per_room) ? 'No extra charge'
    : `${money(r.monthly)}${Number(r.per_room) ? ` + ${money(r.per_room)} a room` : ''} a month`);
  const on = rows.filter((r) => r.enabled), off = rows.filter((r) => !r.enabled);
  return (
    <>
      <h3>Your package</h3>
      <div className="pkg-list">
        {on.map((r) => <div key={r.key} className="pkg-row on"><span><strong>{r.name}</strong>{r.description && <div className="small muted">{r.description}</div>}</span><span className="pkg-price">{price(r)}</span></div>)}
      </div>
      {off.length > 0 && <>
        <h4>Can be added</h4>
        <div className="pkg-list">
          {off.map((r) => <div key={r.key} className="pkg-row"><span>{r.name}{r.description && <div className="small muted">{r.description}</div>}</span><span className="pkg-price muted">{price(r)}</span></div>)}
        </div>
        <p className="small muted">To add or remove something, contact BMG; changes show on the next monthly invoice.</p>
      </>}
    </>
  );
}
