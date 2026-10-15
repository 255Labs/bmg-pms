import { useCallback, useEffect, useState } from 'react';
import { rpc } from '../lib/supabase';
import { fmtDate, fmtDateTime, money } from '../lib/format';
import { Badge, Drawer, Field, Loading, Modal, Table, useAction } from '../components/ui.jsx';
import { SUB_STATUS } from '../components/Subscription.jsx';

// Control panel → Billing: what each property pays BMG for the PMS, who is overdue or locked, plans, payments.
export default function ControlBilling() {
  const [rows, setRows] = useState(null);
  const [plans, setPlans] = useState([]);
  const [open, setOpen] = useState(null);
  const [plan, setPlan] = useState(null);
  const [run, busy] = useAction();
  const load = useCallback(() => Promise.all([
    rpc('pms_admin_billing_overview').then(setRows).catch(() => setRows([])),
    rpc('pms_admin_plans').then(setPlans).catch(() => setPlans([])),
  ]), []);
  useEffect(() => { load(); }, [load]);
  if (!rows) return <Loading />;
  const sum = (k, f = () => true) => rows.filter(f).reduce((n, r) => n + Number(r[k] ?? 0), 0);
  return (
    <>
      <dl className="today-stats">
        <div><dt>Paying or in trial</dt><dd>{rows.filter((r) => ['active', 'trial'].includes(r.status)).length}</dd><span className="muted small">{rows.filter((r) => r.status === 'trial').length} in trial</span></div>
        <div><dt>Overdue</dt><dd className={rows.some((r) => Number(r.overdue) > 0) ? 'danger' : ''}>{rows.filter((r) => Number(r.overdue) > 0).length}</dd><span className="muted small money">{money(sum('overdue'))}</span></div>
        <div><dt>Locked</dt><dd className={rows.some((r) => r.billing_locked) ? 'danger' : ''}>{rows.filter((r) => r.billing_locked).length}</dd></div>
        <div><dt>Outstanding</dt><dd className="money">{money(sum('balance'))}</dd></div>
      </dl>
      <div className="row-gap" style={{ marginBottom: 12 }}>
        <button className="btn" disabled={busy} onClick={() => run(() => rpc('pms_admin_billing_run'), 'Billing run done: invoices issued and standings updated').then(load).catch(() => {})}>Run billing now</button>
        <span className="small muted">Runs by itself every minute with the payments worker; invoices go out on each property's billing day.</span>
      </div>
      <Table rows={rows} onRow={setOpen} empty="No properties yet." columns={[
        { key: 'property', label: 'Property', render: (r) => <><strong>{r.property}</strong>{r.code ? <span className="muted small"> · {r.code}</span> : ''}</> },
        { key: 'status', label: 'Standing', render: (r) => { const [l, k] = SUB_STATUS[r.status] ?? SUB_STATUS.none; return <><Badge kind={k}>{l}</Badge>{r.hold_until ? <div className="small muted">Held open to {fmtDate(r.hold_until)}</div> : null}</>; } },
        { key: 'plan', label: 'Plan', render: (r) => <span className="small">{r.price_override != null ? `Agreed ${money(r.price_override)}` : r.plan ?? <span className="danger">None</span>}{r.status === 'trial' && r.trial_ends ? <div className="muted">Trial to {fmtDate(r.trial_ends)}</div> : null}</span> },
        { key: 'usage', label: 'Rooms · staff', render: (r) => <span className="small">{r.rooms} · {r.users}</span> },
        { key: 'billing_day', label: 'Bills on', render: (r) => (r.billing_day ? `Day ${r.billing_day}` : '') },
        { key: 'balance', label: 'Outstanding', num: true, render: (r) => <span className={Number(r.overdue) > 0 ? 'danger' : ''}>{money(r.balance)}</span> },
        { key: 'last_paid', label: 'Last paid', render: (r) => <span className="small muted">{r.last_paid ? fmtDateTime(r.last_paid) : 'Never'}</span> },
      ]} />

      <h3>Plans</h3>
      <Table rows={plans} onRow={setPlan} empty="No plans yet." columns={[
        { key: 'name', label: 'Plan', render: (p) => <><strong>{p.name}</strong>{p.is_default && <Badge kind="blue">Default for new properties</Badge>}{!p.active && <Badge kind="grey">Retired</Badge>}</> },
        { key: 'base_monthly', label: 'Monthly fee', num: true, render: (p) => money(p.base_monthly, p.currency) },
        { key: 'per_room', label: 'Per room', num: true, render: (p) => money(p.per_room, p.currency) },
        { key: 'per_user', label: 'Per staff', num: true, render: (p) => money(p.per_user, p.currency) },
        { key: 'vat_pct', label: 'VAT', num: true, render: (p) => `${Number(p.vat_pct)}%` },
        { key: 'trial_days', label: 'Trial', num: true, render: (p) => `${p.trial_days} days` },
      ]} />
      <button className="btn" style={{ marginTop: 8 }} onClick={() => setPlan({ name: '', currency: 'TZS', base_monthly: 0, per_room: 0, per_user: 0, vat_pct: 18, trial_days: 30, active: true })}>Add a plan</button>

      <PriceList />

      {open && <SubscriptionDrawer row={rows.find((r) => r.property_id === open.property_id) ?? open} plans={plans} onClose={() => setOpen(null)} onChanged={load} />}
      {plan && <PlanEditor plan={plan} onClose={() => setPlan(null)} onSaved={() => { setPlan(null); load(); }} />}
    </>
  );
}

function PlanEditor({ plan, onClose, onSaved }) {
  const [run, busy] = useAction();
  const [f, setF] = useState(plan);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Modal title={plan.id ? `Plan: ${plan.name}` : 'New plan'} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={() => run(() => rpc('pms_admin_save_plan', { p: f }), 'Plan saved').then(onSaved).catch(() => {})}>Save plan</button>
    </>}>
      <div className="grid-2">
        <Field label="Name"><input value={f.name} onChange={set('name')} /></Field>
        <Field label="Currency"><input value={f.currency} onChange={set('currency')} maxLength={3} /></Field>
        <Field label="Monthly fee"><input type="number" min="0" value={f.base_monthly} onChange={set('base_monthly')} /></Field>
        <Field label="Per active room, monthly"><input type="number" min="0" value={f.per_room} onChange={set('per_room')} /></Field>
        <Field label="Per active staff account, monthly"><input type="number" min="0" value={f.per_user} onChange={set('per_user')} /></Field>
        <Field label="VAT %"><input type="number" min="0" max="100" value={f.vat_pct} onChange={set('vat_pct')} /></Field>
        <Field label="Free trial days" hint="For new properties on this plan"><input type="number" min="0" max="365" value={f.trial_days} onChange={set('trial_days')} /></Field>
        <Field label="Description" span={2}><input value={f.description ?? ''} onChange={set('description')} /></Field>
      </div>
      <label className="check"><input type="checkbox" checked={!!f.is_default} onChange={set('is_default')} /> Default plan for new properties</label>
      <label className="check"><input type="checkbox" checked={f.active !== false} onChange={set('active')} /> Available (untick to retire; properties already on it keep it)</label>
    </Modal>
  );
}

function SubscriptionDrawer({ row, plans, onClose, onChanged }) {
  const [run, busy] = useAction();
  const [invoices, setInvoices] = useState(null);
  const [pay, setPay] = useState(null);
  const [voiding, setVoiding] = useState(null);
  const [f, setF] = useState(null);
  const loadInv = useCallback(() => rpc('pms_admin_invoices', { p_property: row.property_id }).then(setInvoices).catch(() => setInvoices([])), [row.property_id]);
  useEffect(() => { loadInv(); }, [loadInv]);
  useEffect(() => {
    setF({ plan_id: plans.find((p) => p.name === row.plan)?.id ?? '', price_override: row.price_override ?? '', billing_day: row.billing_day ?? 1,
      trial_ends: row.trial_ends ?? '', hold_until: row.hold_until ?? '', due_days: 7, grace_days: 7 });
  }, [row, plans]);
  if (!f) return null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = (patch, msg) => run(() => rpc('pms_admin_set_subscription', { p_property: row.property_id, p: patch }), msg).then(() => { onChanged(); loadInv(); }).catch(() => {});
  const { due_days: _d, grace_days: _g, ...basic } = f;
  return (
    <Drawer label={row.property} onClose={onClose}>
      <div className="stack pad">
      <h2 className="first">{row.property}</h2>
      <p className="small muted">{row.rooms} active rooms · {row.users} staff accounts · {SUB_STATUS[row.status]?.[0] ?? row.status}</p>
      <h3>Subscription</h3>
      <div className="grid-2">
        <Field label="Plan"><select value={f.plan_id} onChange={set('plan_id')}><option value="">No plan</option>{plans.filter((p) => p.active || p.id === f.plan_id).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Agreed monthly price" hint="Instead of the plan, before VAT. Leave empty to use the plan."><input type="number" min="0" value={f.price_override} onChange={set('price_override')} /></Field>
        <Field label="Billing day" hint="1 to 28"><input type="number" min="1" max="28" value={f.billing_day} onChange={set('billing_day')} /></Field>
        <Field label="Free trial until"><input type="date" value={f.trial_ends} onChange={set('trial_ends')} /></Field>
        <Field label="Keep open until" hint="Stops the lock while a payment is being sorted out"><input type="date" value={f.hold_until} onChange={set('hold_until')} /></Field>
      </div>
      <div className="row-gap">
        <button className="btn btn-primary" disabled={busy} onClick={() => save(basic, 'Subscription saved')}>Save</button>
        <button className="btn" disabled={busy} onClick={() => run(() => rpc('pms_admin_issue_invoice', { p_property: row.property_id }), 'Invoice issued').then(() => { onChanged(); loadInv(); }).catch(() => {})}>Issue this month's invoice</button>
        {row.status !== 'cancelled'
          ? <button className="btn btn-danger-ghost" disabled={busy} onClick={() => window.confirm(`Stop billing ${row.property}? No more invoices are issued; it is not locked.`) && save({ cancelled: true }, 'Billing stopped')}>Stop billing</button>
          : <button className="btn" disabled={busy} onClick={() => save({ cancelled: false }, 'Billing restarted')}>Restart billing</button>}
      </div>

      <PackageEditor propertyId={row.property_id} onChanged={onChanged} />

      <h3>Invoices</h3>
      {!invoices ? <Loading /> : !invoices.length ? <p className="muted small">No invoices yet.</p> : (
        <div className="inv-list">
          {invoices.map((i) => (
            <div key={i.id} className={`inv-row ${i.status}`}>
              <div>
                <strong>{i.invoice_no}</strong>
                <div className="small muted">{fmtDate(i.period_start)} – {fmtDate(i.period_end)} · due {fmtDate(i.due_on)}</div>
                {i.void_reason && <div className="small muted">Voided: {i.void_reason}</div>}
              </div>
              <div className="inv-money">
                <strong>{money(i.total, i.currency)}</strong>
                <div className="small muted">paid {money(i.paid, i.currency)}</div>
              </div>
              <div className="inv-act">
                {i.status === 'open'
                  ? <><button className="btn btn-small" onClick={() => setPay(i)}>Record payment</button>{Number(i.paid) === 0 && <button className="link small" onClick={() => setVoiding(i)}>Void</button>}</>
                  : <Badge kind={i.status === 'paid' ? 'teal' : 'grey'}>{i.status === 'paid' ? 'Paid' : 'Voided'}</Badge>}
              </div>
            </div>
          ))}
        </div>
      )}
      {pay && <RecordPayment inv={pay} onClose={() => setPay(null)} onDone={() => { setPay(null); onChanged(); loadInv(); }} />}
      {voiding && <VoidInvoice inv={voiding} onClose={() => setVoiding(null)} onDone={() => { setVoiding(null); onChanged(); loadInv(); }} />}
      </div>
    </Drawer>
  );
}

function RecordPayment({ inv, onClose, onDone }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ amount: Number(inv.total) - Number(inv.paid), method: 'bank', reference: '' });
  return (
    <Modal title={`Record a payment on ${inv.invoice_no}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={() => run(() => rpc('pms_admin_record_payment', { p_invoice: inv.id, p_amount: f.amount, p_method: f.method, p_reference: f.reference }), 'Payment recorded').then(onDone).catch(() => {})}>Record</button>
    </>}>
      <div className="grid-2">
        <Field label="Amount received"><input type="number" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="How"><select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="bank">Bank transfer</option><option value="mobile_money">Mobile money (outside the PMS)</option><option value="cash">Cash</option><option value="other">Other</option></select></Field>
        <Field label="Reference" hint="Bank slip, transaction or receipt number" span={2}><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      </div>
      <p className="small muted">A full payment of everything overdue unlocks the property straight away.</p>
    </Modal>
  );
}

function VoidInvoice({ inv, onClose, onDone }) {
  const [run, busy] = useAction();
  const [why, setWhy] = useState('');
  return (
    <Modal title={`Void ${inv.invoice_no}?`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Keep it</button>
      <button className="btn btn-danger-ghost" disabled={busy || !why.trim()} onClick={() => run(() => rpc('pms_admin_void_invoice', { p_invoice: inv.id, p_reason: why }), 'Invoice voided').then(onDone).catch(() => {})}>Void invoice</button>
    </>}>
      <p>{money(inv.total, inv.currency)} will no longer be owed. This cannot be undone; issue a new invoice if needed.</p>
      <Field label="Reason"><input value={why} onChange={(e) => setWhy(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}

// ---------------------------------------------------------------- price list: each module and integration, priced by BMG only
function PriceList() {
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = useCallback(() => rpc('pms_admin_catalog').then(setRows).catch(() => setRows([])), []);
  useEffect(() => { load(); }, [load]);
  if (!rows) return <Loading />;
  return (
    <>
      <h3>Price list</h3>
      <p className="small muted">What each module and integration costs a month, before VAT, on top of the plan. Change a hotel's own price or give it free months from that hotel's page above.</p>
      <Table rows={rows} onRow={(r) => !r.included && setEdit({ ...r })} columns={[
        { key: 'name', label: 'Add-on', render: (r) => <><strong>{r.name}</strong>{r.included && <Badge kind="blue">In every plan</Badge>}{!r.active && <Badge kind="grey">Not sold</Badge>}<div className="small muted">{r.description}</div></> },
        { key: 'kind', label: 'Kind', render: (r) => (r.kind === 'integration' ? 'Integration' : 'Module') },
        { key: 'monthly_price', label: 'Monthly', num: true, render: (r) => (r.included ? '' : money(r.monthly_price)) },
        { key: 'per_room_price', label: 'Per room', num: true, render: (r) => (r.included || !Number(r.per_room_price) ? '' : money(r.per_room_price)) },
        { key: 'default_on', label: 'New hotels', render: (r) => (r.included ? '' : r.default_on ? 'On' : 'Off') },
        { key: 'properties_on', label: 'Hotels using', num: true },
      ]} />
      {edit && <CatalogEditor item={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); load(); }} />}
    </>
  );
}

function CatalogEditor({ item, onClose, onSaved }) {
  const [run, busy] = useAction();
  const [f, setF] = useState(item);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Modal title={item.name} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={() => run(() => rpc('pms_admin_save_catalog', { p_key: item.key, p: {
        name: f.name, description: f.description ?? '', monthly_price: Number(f.monthly_price || 0), per_room_price: Number(f.per_room_price || 0), default_on: !!f.default_on, active: !!f.active } }), 'Price list saved').then(onSaved).catch(() => {})}>Save</button>
    </>}>
      <div className="grid-2">
        <Field label="Name" span={2}><input value={f.name} onChange={set('name')} /></Field>
        <Field label="Description" span={2}><textarea rows={2} value={f.description ?? ''} onChange={set('description')} /></Field>
        <Field label="Monthly price"><input type="number" min="0" value={f.monthly_price} onChange={set('monthly_price')} /></Field>
        <Field label="Per active room, monthly"><input type="number" min="0" value={f.per_room_price} onChange={set('per_room_price')} /></Field>
      </div>
      <label className="check"><input type="checkbox" checked={!!f.default_on} onChange={set('default_on')} /> Switched on for new hotels</label>
      <label className="check"><input type="checkbox" checked={!!f.active} onChange={set('active')} /> Still sold (untick to retire it; hotels that have it keep it)</label>
      <p className="small muted">New prices apply from the next monthly invoice. Hotels with their own agreed price are not affected.</p>
    </Modal>
  );
}

// ---------------------------------------------------------------- one hotel's package
function PackageEditor({ propertyId, onChanged }) {
  const [run, busy] = useAction();
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = useCallback(() => rpc('pms_admin_property_addons', { p_property: propertyId }).then(setRows).catch(() => setRows([])), [propertyId]);
  useEffect(() => { load(); }, [load]);
  const set = (key, p, msg) => run(() => rpc('pms_admin_set_addon', { p_property: propertyId, p_key: key, p }), msg).then(() => { load(); onChanged(); }).catch(() => {});
  if (!rows) return <Loading />;
  return (
    <>
      <h3>Package <span className="small muted">· add-ons {money(rows.reduce((n, r) => n + Number(r.monthly_now), 0))} a month before VAT</span></h3>
      <div className="pkg-list">
        {rows.map((r) => (
          <div key={r.key} className={`pkg-row ${r.enabled ? 'on' : ''}`}>
            <label className="check">
              <input type="checkbox" checked={r.enabled} disabled={r.included || busy} onChange={(e) => set(r.key, { enabled: e.target.checked }, `${r.name} ${e.target.checked ? 'switched on' : 'switched off'}`)} />
              <span><strong>{r.name}</strong>
                <span className="small muted"> · {r.included ? 'in every plan'
                  : <>list {money(r.list_monthly)}{Number(r.list_per_room) ? ` + ${money(r.list_per_room)}/room` : ''}</>}</span>
                {r.monthly_price_override != null && <Badge kind="blue">Agreed {money(r.monthly_price_override)}</Badge>}
                {r.free_until && <Badge kind="teal">Free to {fmtDate(r.free_until)}</Badge>}
                {r.note && <span className="small muted"> · {r.note}</span>}
              </span>
            </label>
            <span className="pkg-price">{r.enabled && !r.included ? money(r.monthly_now) : ''}</span>
            {!r.included && <button className="link small" onClick={() => setEdit({ ...r, monthly_price_override: r.monthly_price_override ?? '', per_room_price_override: r.per_room_price_override ?? '', free_until: r.free_until ?? '', note: r.note ?? '' })}>Price</button>}
          </div>
        ))}
      </div>
      {edit && (
        <Modal title={`${edit.name}: this hotel's price`} onClose={() => setEdit(null)} footer={<>
          <button className="btn" onClick={() => setEdit(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => set(edit.key, { monthly_price_override: String(edit.monthly_price_override), per_room_price_override: String(edit.per_room_price_override),
            free_until: edit.free_until, note: edit.note }, 'Price saved').then(() => setEdit(null))}>Save</button>
        </>}>
          <div className="grid-2">
            <Field label="Agreed monthly price" hint={`List ${money(edit.list_monthly)}. Empty: list price`}><input type="number" min="0" value={edit.monthly_price_override} onChange={(e) => setEdit({ ...edit, monthly_price_override: e.target.value })} /></Field>
            <Field label="Agreed per room" hint={`List ${money(edit.list_per_room)}. Empty: list price`}><input type="number" min="0" value={edit.per_room_price_override} onChange={(e) => setEdit({ ...edit, per_room_price_override: e.target.value })} /></Field>
            <Field label="Free until" hint="Not charged up to this day"><input type="date" value={edit.free_until} onChange={(e) => setEdit({ ...edit, free_until: e.target.value })} /></Field>
            <Field label="Note" hint="Why, for the record"><input value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </>
  );
}
