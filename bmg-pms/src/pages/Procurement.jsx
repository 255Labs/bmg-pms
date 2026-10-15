import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { can, fmtDate, label, money } from '../lib/format';
import { Badge, Field, Loading, Modal, PageHead, Table, Tabs, useAction } from '../components/ui.jsx';
import { EditableList } from './Setup.jsx';

// Stores, acquisition and procurement, shared by the restaurant, bars and activities:
// store requests → issues; purchase orders → approval → deliveries into stock → supplier invoices (checked) → payments.
const PO_STATUS = { draft: ['Draft', 'grey'], pending_approval: ['Waiting for approval', 'amber'], approved: ['Approved', 'blue'],
  partly_received: ['Part received', 'amber'], received: ['Received', 'teal'], closed: ['Closed', 'grey'], cancelled: ['Cancelled', 'grey'] };
const SR_STATUS = { submitted: ['Waiting', 'amber'], partly_issued: ['Part issued', 'blue'], issued: ['Issued', 'teal'], rejected: ['Rejected', 'red'], cancelled: ['Withdrawn', 'grey'] };
const MATCH = { matched: ['Matches order and delivery', 'teal'], variance: ['Differs', 'red'], not_linked: ['Not linked to a delivery', 'grey'] };
const PAY_METHODS = [['bank', 'Bank transfer'], ['mobile_money', 'Mobile money'], ['cash', 'Cash'], ['cheque', 'Cheque'], ['other', 'Other']];

function useLists() {
  const { property, version } = useProperty();
  const [d, setD] = useState({ locations: [], items: [], suppliers: [] });
  const load = useCallback(() => Promise.all([
    supabase.from('pms_stock_locations').select('id, name, kind').eq('property_id', property.id).eq('active', true).order('name'),
    supabase.from('pms_stock_items').select('id, name, unit, purchase_unit, units_per_purchase, last_cost, avg_cost, default_supplier_id').eq('property_id', property.id).eq('active', true).order('name'),
    supabase.from('pms_suppliers').select('*').eq('property_id', property.id).order('name'),
  ]).then(([l, i, s]) => setD({ locations: l.data ?? [], items: i.data ?? [], suppliers: s.data ?? [] })), [property.id]);
  useEffect(() => { load(); }, [load, version]);
  return { ...d, reload: load };
}

export default function Procurement({ params }) {
  const { role } = useProperty();
  const lists = useLists();
  const tabs = [
    (can(role, 'proc.request') || can(role, 'proc.issue')) && { value: 'requests', label: 'Store requests' },
    (can(role, 'proc.order') || can(role, 'proc.approve') || can(role, 'proc.receive')) && { value: 'orders', label: 'Purchase orders' },
    can(role, 'proc.receive') && { value: 'deliveries', label: 'Deliveries' },
    (can(role, 'proc.invoice') || can(role, 'proc.pay')) && { value: 'invoices', label: 'Supplier invoices' },
    can(role, 'proc.order') && { value: 'reorder', label: 'Reorder' },
    (can(role, 'proc.suppliers') || can(role, 'proc.order')) && { value: 'suppliers', label: 'Suppliers' },
  ].filter(Boolean);
  const [tab, setTab] = useState(params?.tab && tabs.some((t) => t.value === params.tab) ? params.tab : tabs[0]?.value);
  if (!tabs.length) return <><PageHead title="Procurement" /><p>Ask a manager for procurement abilities.</p></>;
  return (
    <>
      <PageHead title="Procurement and stores" sub="Ask the store for stock, order from suppliers, receive deliveries into stock, check supplier invoices against what came, and pay." />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'requests' && <Requests lists={lists} />}
      {tab === 'orders' && <Orders lists={lists} />}
      {tab === 'deliveries' && <Deliveries lists={lists} />}
      {tab === 'invoices' && <Invoices lists={lists} />}
      {tab === 'reorder' && <Reorder lists={lists} onOrder={() => setTab('orders')} />}
      {tab === 'suppliers' && <Suppliers lists={lists} />}
    </>
  );
}

// ---------------------------------------------------------------- lines editor used by requests, orders, deliveries, invoices
function Lines({ lines, setLines, items, priced, vat, describe }) {
  const set = (n, k, v) => setLines(lines.map((l, i) => (i === n ? { ...l, [k]: v } : l)));
  return (
    <div className="table-wrap">
      <table className="table edit-table">
        <thead><tr><th>Item</th>{describe && <th>Or description</th>}<th className="num">Qty</th>{priced && <th className="num">Price</th>}{vat && <th className="num">VAT %</th>}<th /></tr></thead>
        <tbody>
          {lines.map((l, n) => {
            const it = items.find((i) => i.id === l.item_id);
            return (
              <tr key={n}>
                <td><select value={l.item_id ?? ''} aria-label="Item" onChange={(e) => {
                  const i = items.find((x) => x.id === e.target.value);
                  setLines(lines.map((x, k) => (k === n ? { ...x, item_id: e.target.value || null, unit_price: x.unit_price || (i ? String(Math.round(Number(i.last_cost ?? i.avg_cost ?? 0) * Number(i.units_per_purchase ?? 1))) : '') } : x)));
                }}>
                  <option value="">{describe ? '— not a stock item —' : 'Choose…'}</option>
                  {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                </select>{it && <div className="small muted">{priced ? `per ${it.purchase_unit ?? it.unit}` : it.unit}</div>}</td>
                {describe && <td><input value={l.description ?? ''} aria-label="Description" disabled={!!l.item_id} onChange={(e) => set(n, 'description', e.target.value)} /></td>}
                <td className="num"><input className="num" inputMode="decimal" value={l.qty ?? ''} aria-label="Quantity" onChange={(e) => set(n, 'qty', e.target.value.replace(/[^\d.]/g, ''))} /></td>
                {priced && <td className="num"><input className="num" inputMode="decimal" value={l.unit_price ?? ''} aria-label="Price" onChange={(e) => set(n, 'unit_price', e.target.value.replace(/[^\d.]/g, ''))} /></td>}
                {vat && <td className="num"><input className="num" inputMode="decimal" value={l.vat_pct ?? ''} aria-label="VAT" onChange={(e) => set(n, 'vat_pct', e.target.value.replace(/[^\d.]/g, ''))} /></td>}
                <td><button type="button" className="link danger" onClick={() => setLines(lines.filter((_, k) => k !== n))}>Remove</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button type="button" className="btn btn-ghost" onClick={() => setLines([...lines, { item_id: null, qty: '', unit_price: '', vat_pct: '0' }])}>+ Line</button>
    </div>
  );
}
const num = (v) => (v === '' || v == null ? null : Number(v));

// ---------------------------------------------------------------- store requests
function Requests({ lists }) {
  const { property, role, user } = useProperty();
  const [run, busy] = useAction();
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState(null);
  const load = useCallback(() => supabase.from('pms_store_requests').select('*, pms_store_request_lines(*)').eq('property_id', property.id).order('request_no', { ascending: false }).limit(200)
    .then(({ data }) => setRows(data ?? [])), [property.id]);
  useEffect(() => { load(); }, [load]);
  const loc = (id) => lists.locations.find((l) => l.id === id)?.name ?? '';
  const item = (id) => lists.items.find((i) => i.id === id);
  const stores = lists.locations.filter((l) => l.kind === 'store');
  return (
    <>
      {can(role, 'proc.request') && <div className="row-gap" style={{ marginBottom: 12 }}>
        <button className="btn btn-primary" onClick={() => setForm({ from_location_id: stores[0]?.id ?? lists.locations[0]?.id ?? '', to_location_id: '', needed_by: '', notes: '', lines: [{ item_id: null, qty: '' }] })}>Ask the store</button>
        <span className="small muted">The kitchen, bar, gym, spa or housekeeping asks; the store issues and the stock moves with its cost.</span></div>}
      {!rows ? <Loading /> : <Table rows={rows} onRow={setOpen} empty="No store requests yet." columns={[
        { key: 'request_no', label: 'No.', render: (r) => `SR-${String(r.request_no).padStart(5, '0')}` },
        { key: 'to', label: 'For', render: (r) => loc(r.to_location_id) }, { key: 'from', label: 'From', render: (r) => loc(r.from_location_id) },
        { key: 'items', label: 'Items', render: (r) => <span className="small">{r.pms_store_request_lines.map((l) => `${Number(l.qty)} ${item(l.item_id)?.unit ?? ''} ${item(l.item_id)?.name ?? ''}`).join(', ')}</span> },
        { key: 'needed_by', label: 'Needed', render: (r) => (r.needed_by ? fmtDate(r.needed_by) : '') },
        { key: 'status', label: '', render: (r) => <Badge kind={SR_STATUS[r.status][1]}>{SR_STATUS[r.status][0]}</Badge> },
      ]} />}
      {form && (
        <Modal title="Ask the store" wide onClose={() => setForm(null)} footer={<><button className="btn" onClick={() => setForm(null)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => run(() => rpc('pms_store_request', { p_property: property.id, p: { ...form, lines: form.lines.filter((l) => l.item_id && num(l.qty)).map((l) => ({ item_id: l.item_id, qty: num(l.qty) })) } }), 'Request sent to the store')
            .then(() => { setForm(null); load(); }).catch(() => {})}>Send request</button></>}>
          <div className="grid-3">
            <Field label="From"><select value={form.from_location_id} onChange={(e) => setForm({ ...form, from_location_id: e.target.value })}>{lists.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
            <Field label="For"><select value={form.to_location_id} onChange={(e) => setForm({ ...form, to_location_id: e.target.value })}><option value="">Choose…</option>{lists.locations.filter((l) => l.id !== form.from_location_id).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
            <Field label="Needed by"><input type="date" value={form.needed_by} onChange={(e) => setForm({ ...form, needed_by: e.target.value })} /></Field>
          </div>
          <Lines lines={form.lines} setLines={(lines) => setForm({ ...form, lines })} items={lists.items} />
          <Field label="Notes"><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </Modal>
      )}
      {open && <IssueDialog req={open} lists={lists} mine={open.requested_by === user.id} onClose={() => setOpen(null)} onDone={() => { setOpen(null); load(); }} />}
    </>
  );
}

function IssueDialog({ req, lists, mine, onClose, onDone }) {
  const { role } = useProperty();
  const [run, busy] = useAction();
  const [qty, setQty] = useState(Object.fromEntries(req.pms_store_request_lines.map((l) => [l.id, String(Number(l.qty) - Number(l.qty_issued))])));
  const [levels, setLevels] = useState({});
  useEffect(() => {
    supabase.from('pms_stock_levels').select('item_id, qty').eq('location_id', req.from_location_id).then(({ data }) => setLevels(Object.fromEntries((data ?? []).map((x) => [x.item_id, Number(x.qty)]))));
  }, [req.from_location_id]);
  const openReq = ['submitted', 'partly_issued'].includes(req.status);
  const item = (id) => lists.items.find((i) => i.id === id);
  return (
    <Modal title={`SR-${String(req.request_no).padStart(5, '0')}`} wide onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Close</button>
      <div className="row-gap">
        {openReq && (can(role, 'proc.issue') || (mine && req.status === 'submitted')) && <button className="btn btn-danger-ghost" disabled={busy} onClick={() => {
          const r = mine && !can(role, 'proc.issue') ? 'Withdrawn' : window.prompt('Why is it not being issued?');
          if (r) run(() => rpc('pms_store_reject', { p_request: req.id, p_reason: r }), mine ? 'Request withdrawn' : 'Request closed').then(onDone).catch(() => {});
        }}>{mine && !can(role, 'proc.issue') ? 'Withdraw' : 'Reject the rest'}</button>}
        {openReq && can(role, 'proc.issue') && <button className="btn btn-primary" disabled={busy} onClick={() => run(() => rpc('pms_store_issue', { p_request: req.id,
          p_lines: req.pms_store_request_lines.map((l) => ({ line_id: l.id, qty: num(qty[l.id]) ?? 0 })) }), 'Issued').then(onDone).catch(() => {})}>Issue</button>}
      </div></>}>
      {req.reject_reason && <p className="small">Reason: {req.reject_reason}</p>}
      <table className="table"><thead><tr><th>Item</th><th className="num">Asked</th><th className="num">Issued</th><th className="num">In the store</th>{openReq && can(role, 'proc.issue') && <th className="num">Issue now</th>}</tr></thead>
        <tbody>{req.pms_store_request_lines.map((l) => (
          <tr key={l.id}><td>{item(l.item_id)?.name}<span className="small muted"> {item(l.item_id)?.unit}</span>{l.note && <div className="small muted">{l.note}</div>}</td>
            <td className="num">{Number(l.qty)}</td><td className="num">{Number(l.qty_issued)}</td>
            <td className={`num ${(levels[l.item_id] ?? 0) < Number(l.qty) - Number(l.qty_issued) ? 'danger' : ''}`}>{levels[l.item_id] ?? 0}</td>
            {openReq && can(role, 'proc.issue') && <td className="num"><input className="num" inputMode="decimal" value={qty[l.id]} aria-label="Issue now" onChange={(e) => setQty({ ...qty, [l.id]: e.target.value.replace(/[^\d.]/g, '') })} /></td>}
          </tr>))}</tbody></table>
    </Modal>
  );
}

// ---------------------------------------------------------------- purchase orders
function Orders({ lists }) {
  const { property, role } = useProperty();
  const [rows, setRows] = useState(null);
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState(null);
  const [filter, setFilter] = useState('open');
  const load = useCallback(() => supabase.from('pms_purchase_orders').select('*, pms_po_lines(*)').eq('property_id', property.id).order('po_no', { ascending: false }).limit(300)
    .then(({ data }) => setRows(data ?? [])), [property.id]);
  useEffect(() => { load(); }, [load]);
  const sup = (id) => lists.suppliers.find((s) => s.id === id)?.name ?? '';
  const shown = (rows ?? []).filter((r) => filter === 'all' || (filter === 'open' ? !['received', 'closed', 'cancelled'].includes(r.status) : r.status === 'pending_approval'));
  return (
    <>
      <div className="row-gap" style={{ marginBottom: 12 }}>
        {can(role, 'proc.order') && <button className="btn btn-primary" onClick={() => setForm({ supplier_id: '', location_id: lists.locations.find((l) => l.kind === 'store')?.id ?? lists.locations[0]?.id ?? '', expected_date: '', notes: '', lines: [{ item_id: null, qty: '', unit_price: '', vat_pct: '18' }] })}>New order</button>}
        <div className="view-switch" role="radiogroup" aria-label="Show">
          {[['open', 'Open'], ['approval', 'Waiting for approval'], ['all', 'All']].map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={filter === v} className={filter === v ? 'on' : ''} onClick={() => setFilter(v)}>{l}</button>)}
        </div>
        <ApprovalLimit />
      </div>
      {!rows ? <Loading /> : <Table rows={shown} onRow={setOpen} empty="No purchase orders here." columns={[
        { key: 'po_no', label: 'Order', render: (r) => <strong>PO-{String(r.po_no).padStart(5, '0')}</strong> },
        { key: 'supplier', label: 'Supplier', render: (r) => sup(r.supplier_id) },
        { key: 'order_date', label: 'Date', render: (r) => fmtDate(r.order_date) },
        { key: 'expected_date', label: 'Expected', render: (r) => (r.expected_date ? fmtDate(r.expected_date) : '') },
        { key: 'total', label: 'Total', num: true, render: (r) => money(r.total, r.currency) },
        { key: 'status', label: '', render: (r) => <Badge kind={PO_STATUS[r.status][1]}>{PO_STATUS[r.status][0]}</Badge> },
      ]} />}
      {form && <OrderForm form={form} setForm={setForm} lists={lists} onDone={(id) => { setForm(null); load().then(() => id && supabase.from('pms_purchase_orders').select('*, pms_po_lines(*)').eq('id', id).single().then(({ data }) => setOpen(data))); }} />}
      {open && <OrderDialog po={open} lists={lists} onClose={() => setOpen(null)} onEdit={() => { setForm({ id: open.id, supplier_id: open.supplier_id, location_id: open.location_id, expected_date: open.expected_date ?? '', notes: open.notes ?? '',
        lines: open.pms_po_lines.map((l) => ({ item_id: l.item_id, description: l.item_id ? '' : l.description, qty: String(Number(l.qty)), unit_price: String(Number(l.unit_price)), vat_pct: String(Number(l.vat_pct)) })) }); setOpen(null); }}
        onDone={() => { setOpen(null); load(); }} />}
    </>
  );
}

export function OrderForm({ form, setForm, lists, onDone }) {
  const { property } = useProperty();
  const [run, busy] = useAction();
  const lines = form.lines.filter((l) => (l.item_id || l.description) && num(l.qty));
  const total = lines.reduce((n, l) => n + num(l.qty) * (num(l.unit_price) ?? 0) * (1 + (num(l.vat_pct) ?? 0) / 100), 0);
  return (
    <Modal title={form.id ? 'Change order' : 'New purchase order'} wide onClose={() => setForm(null)} footer={<><span className="muted">Total with VAT {money(total)}</span>
      <div className="row-gap"><button className="btn" onClick={() => setForm(null)}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !form.supplier_id || !lines.length} onClick={() => run(() => rpc('pms_po_save', { p_property: property.id,
          p: { ...form, lines: lines.map((l) => ({ item_id: l.item_id, description: l.description || null, qty: num(l.qty), unit_price: num(l.unit_price) ?? 0, vat_pct: num(l.vat_pct) ?? 0 })) } }), 'Order saved as a draft').then(onDone).catch(() => {})}>Save draft</button></div></>}>
      <div className="grid-3">
        <Field label="Supplier"><select value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value })}><option value="">Choose…</option>{lists.suppliers.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Deliver to"><select value={form.location_id} onChange={(e) => setForm({ ...form, location_id: e.target.value })}>{lists.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <Field label="Expected"><input type="date" value={form.expected_date} onChange={(e) => setForm({ ...form, expected_date: e.target.value })} /></Field>
      </div>
      <Lines lines={form.lines} setLines={(l) => setForm({ ...form, lines: l })} items={lists.items} priced vat describe />
      <Field label="Notes for the supplier"><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
      <p className="small muted">Prices are per purchase unit (a case, a bag), before VAT. Orders above the property's approval limit wait for a manager.</p>
    </Modal>
  );
}

function OrderDialog({ po, lists, onClose, onEdit, onDone }) {
  const { property, role, user } = useProperty();
  const [run, busy] = useAction();
  const [receiving, setReceiving] = useState(null);
  const sup = lists.suppliers.find((s) => s.id === po.supplier_id);
  const loc = lists.locations.find((l) => l.id === po.location_id);
  const no = `PO-${String(po.po_no).padStart(5, '0')}`;
  const act = (fn, msg) => run(fn, msg).then(onDone).catch(() => {});
  return (
    <Modal title={no} wide onClose={onClose} footer={<>
      <button className="btn" onClick={() => window.print()}>Print</button>
      <div className="row-gap">
        {po.status === 'draft' && can(role, 'proc.order') && <><button className="btn" onClick={onEdit}>Change</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => act(() => rpc('pms_po_submit', { p_po: po.id }), 'Order submitted')}>Submit</button></>}
        {po.status === 'pending_approval' && can(role, 'proc.approve') && (po.submitted_by !== user.id || role === 'owner') && <>
          <button className="btn" disabled={busy} onClick={() => { const r = window.prompt('What needs changing?'); if (r) act(() => rpc('pms_po_approve', { p_po: po.id, p_approve: false, p_reason: r }), 'Sent back'); }}>Send back</button>
          <button className="btn btn-primary" disabled={busy} onClick={() => act(() => rpc('pms_po_approve', { p_po: po.id, p_approve: true, p_reason: null }), 'Approved')}>Approve</button></>}
        {['approved', 'partly_received'].includes(po.status) && can(role, 'proc.receive') && <button className="btn btn-primary" onClick={() => setReceiving(po)}>Receive delivery</button>}
        {!['received', 'closed', 'cancelled'].includes(po.status) && can(role, 'proc.order') && <button className="btn btn-danger-ghost" disabled={busy} onClick={() => { const r = window.prompt(po.status === 'partly_received' ? 'Why close it without the rest?' : 'Why cancel this order?'); if (r) act(() => rpc('pms_po_cancel', { p_po: po.id, p_reason: r }), 'Order closed'); }}>{po.status === 'partly_received' ? 'Close' : 'Cancel order'}</button>}
      </div></>}>
      <div className="po-print">
        <div className="po-head">
          <div><strong>{property.name}</strong><div className="small muted">{property.address ?? ''}{property.tin ? ` · TIN ${property.tin}` : ''}</div></div>
          <div className="num"><strong>Purchase order {no}</strong><div className="small">{fmtDate(po.order_date)} · <Badge kind={PO_STATUS[po.status][1]}>{PO_STATUS[po.status][0]}</Badge></div></div>
        </div>
        <p className="small">To <strong>{sup?.name}</strong>{sup?.phone ? ` · ${sup.phone}` : ''} · deliver to {loc?.name}{po.expected_date ? ` by ${fmtDate(po.expected_date)}` : ''}</p>
        <table className="table"><thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Received</th><th className="num">Price</th><th className="num">VAT</th><th className="num">Amount</th></tr></thead>
          <tbody>{po.pms_po_lines.map((l) => <tr key={l.id}><td>{l.description}{l.unit ? <span className="small muted"> · {l.unit}</span> : ''}</td><td className="num">{Number(l.qty)}</td>
            <td className="num">{Number(l.qty_received)}</td><td className="num">{money(l.unit_price)}</td><td className="num">{Number(l.vat_pct)}%</td><td className="num">{money(l.amount)}</td></tr>)}</tbody>
          <tfoot><tr><td colSpan={5}>Subtotal</td><td className="num">{money(po.subtotal)}</td></tr><tr><td colSpan={5}>VAT</td><td className="num">{money(po.vat)}</td></tr>
            <tr><td colSpan={5}><strong>Total {po.currency}</strong></td><td className="num"><strong>{money(po.total)}</strong></td></tr></tfoot></table>
        {po.notes && <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{po.notes}</p>}
        {po.cancel_reason && <p className="small">Closed: {po.cancel_reason}</p>}
      </div>
      {receiving && <ReceiveDialog po={receiving} lists={lists} onClose={() => setReceiving(null)} onDone={() => { setReceiving(null); onDone(); }} />}
    </Modal>
  );
}

// ---------------------------------------------------------------- deliveries
function ReceiveDialog({ po, lists, onClose, onDone }) {
  const { property } = useProperty();
  const [run, busy] = useAction();
  const open = (po?.pms_po_lines ?? []).filter((l) => l.item_id && Number(l.qty_received) < Number(l.qty));
  const [f, setF] = useState({ delivery_note: '', supplier_id: '', location_id: lists.locations.find((l) => l.kind === 'store')?.id ?? lists.locations[0]?.id ?? '',
    rows: open.map((l) => ({ po_line_id: l.id, label: l.description, unit: l.unit, qty: String(Number(l.qty) - Number(l.qty_received)), unit_cost: String(Number(l.unit_price)), batch: '', expiry_date: '' })),
    lines: [{ item_id: null, qty: '', unit_price: '', vat_pct: '0' }] });
  const save = () => run(() => rpc('pms_grn_post', { p_property: property.id, p: po
    ? { po_id: po.id, delivery_note: f.delivery_note, lines: f.rows.filter((r) => num(r.qty)).map((r) => ({ po_line_id: r.po_line_id, qty: num(r.qty), unit_cost: num(r.unit_cost), batch: r.batch || null, expiry_date: r.expiry_date || null })) }
    : { supplier_id: f.supplier_id, location_id: f.location_id, delivery_note: f.delivery_note, lines: f.lines.filter((l) => l.item_id && num(l.qty)).map((l) => ({ item_id: l.item_id, qty: num(l.qty), unit_cost: num(l.unit_price), vat_pct: num(l.vat_pct) ?? 0 })) } }),
  'Delivery received into stock').then(onDone).catch(() => {});
  return (
    <Modal title={po ? `Receive against PO-${String(po.po_no).padStart(5, '0')}` : 'Delivery without an order'} wide onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || (!po && !f.supplier_id)} onClick={save}>Receive into stock</button></>}>
      <div className="grid-3">
        {!po && <Field label="Supplier"><select value={f.supplier_id} onChange={(e) => setF({ ...f, supplier_id: e.target.value })}><option value="">Choose…</option>{lists.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>}
        {!po && <Field label="Into"><select value={f.location_id} onChange={(e) => setF({ ...f, location_id: e.target.value })}>{lists.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>}
        <Field label="Delivery note no."><input value={f.delivery_note} onChange={(e) => setF({ ...f, delivery_note: e.target.value })} /></Field>
      </div>
      {po ? (
        <table className="table edit-table"><thead><tr><th>Item</th><th className="num">Received now</th><th className="num">Price each</th><th>Batch</th><th>Expiry</th></tr></thead>
          <tbody>{f.rows.map((r, n) => {
            const set = (k, v) => setF({ ...f, rows: f.rows.map((x, i) => (i === n ? { ...x, [k]: v } : x)) });
            return <tr key={r.po_line_id}><td>{r.label}<span className="small muted"> · {r.unit}</span></td>
              <td className="num"><input className="num" inputMode="decimal" value={r.qty} aria-label="Received" onChange={(e) => set('qty', e.target.value.replace(/[^\d.]/g, ''))} /></td>
              <td className="num"><input className="num" inputMode="decimal" value={r.unit_cost} aria-label="Price" onChange={(e) => set('unit_cost', e.target.value.replace(/[^\d.]/g, ''))} /></td>
              <td><input value={r.batch} aria-label="Batch" onChange={(e) => set('batch', e.target.value)} /></td>
              <td><input type="date" value={r.expiry_date} aria-label="Expiry" onChange={(e) => set('expiry_date', e.target.value)} /></td></tr>;
          })}</tbody></table>
      ) : <Lines lines={f.lines} setLines={(lines) => setF({ ...f, lines })} items={lists.items} priced vat />}
      <p className="small muted">Quantities are in purchase units; stock goes in at the stock unit (a case of 24 becomes 24 bottles) at the price paid.</p>
    </Modal>
  );
}

function Deliveries({ lists }) {
  const { property } = useProperty();
  const [rows, setRows] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => supabase.from('pms_goods_receipts').select('*, pms_grn_lines(*), pms_purchase_orders(po_no)').eq('property_id', property.id).order('grn_no', { ascending: false }).limit(300)
    .then(({ data }) => setRows(data ?? [])), [property.id]);
  useEffect(() => { load(); }, [load]);
  const sup = (id) => lists.suppliers.find((s) => s.id === id)?.name ?? '';
  const item = (id) => lists.items.find((i) => i.id === id);
  return (
    <>
      <div className="row-gap" style={{ marginBottom: 12 }}><button className="btn" onClick={() => setAdding(true)}>Delivery without an order</button>
        <span className="small muted">Deliveries against an order are received from the order.</span></div>
      {!rows ? <Loading /> : <Table rows={rows} empty="No deliveries yet." columns={[
        { key: 'grn_no', label: 'GRN', render: (r) => `GRN-${String(r.grn_no).padStart(5, '0')}` },
        { key: 'received_on', label: 'Date', render: (r) => fmtDate(r.received_on) },
        { key: 'supplier', label: 'Supplier', render: (r) => sup(r.supplier_id) },
        { key: 'po', label: 'Order', render: (r) => (r.pms_purchase_orders ? `PO-${String(r.pms_purchase_orders.po_no).padStart(5, '0')}` : 'None') },
        { key: 'items', label: 'Items', render: (r) => <span className="small">{r.pms_grn_lines.map((l) => `${Number(l.qty)} × ${item(l.item_id)?.name ?? ''}${Number(l.qty_invoiced) >= Number(l.qty) ? ' ✓' : ''}`).join(', ')}</span> },
        { key: 'delivery_note', label: 'Delivery note' },
        { key: 'total', label: 'Value', num: true, render: (r) => money(Number(r.total) + Number(r.vat)) },
      ]} />}
      {adding && <ReceiveDialog po={null} lists={lists} onClose={() => setAdding(false)} onDone={() => { setAdding(false); load(); }} />}
    </>
  );
}

// ---------------------------------------------------------------- supplier invoices and payments
function Invoices({ lists }) {
  const { property, role } = useProperty();
  const [run, busy] = useAction();
  const [rows, setRows] = useState(null);
  const [form, setForm] = useState(null);
  const [pay, setPay] = useState(null);
  const [cred, setCred] = useState([]);
  const load = useCallback(() => Promise.all([
    supabase.from('pms_supplier_invoices').select('*').eq('property_id', property.id).order('internal_no', { ascending: false }).limit(300).then(({ data }) => setRows(data ?? [])),
    can(role, 'rpt.creditors') ? rpc('pms_rpt_creditors', { p_property: property.id, p_as_of: null }).then(setCred).catch(() => setCred([])) : null,
  ]), [property.id, role]);
  useEffect(() => { load(); }, [load]);
  const sup = (id) => lists.suppliers.find((s) => s.id === id)?.name ?? '';
  return (
    <>
      {cred.length > 0 && (
        <dl className="today-stats">
          <div><dt>Owed to suppliers</dt><dd className="money">{money(cred.reduce((n, c) => n + Number(c.balance), 0))}</dd></div>
          <div><dt>Overdue</dt><dd className="money danger">{money(cred.reduce((n, c) => n + Number(c.balance) - Number(c.not_due), 0))}</dd></div>
          <div><dt>Over 60 days</dt><dd className="money">{money(cred.reduce((n, c) => n + Number(c.d61_90) + Number(c.d90_plus), 0))}</dd></div>
        </dl>
      )}
      {can(role, 'proc.invoice') && <div className="row-gap" style={{ marginBottom: 12 }}><button className="btn btn-primary" onClick={() => setForm({ supplier_id: '', invoice_no: '', invoice_date: property.business_date, due_date: '', grn: {}, extra: [] })}>Enter a supplier invoice</button></div>}
      {!rows ? <Loading /> : <Table rows={rows} empty="No supplier invoices yet." columns={[
        { key: 'internal_no', label: 'No.', render: (r) => `SI-${String(r.internal_no).padStart(5, '0')}` },
        { key: 'supplier', label: 'Supplier', render: (r) => <>{sup(r.supplier_id)}<div className="small muted">{r.invoice_no}</div></> },
        { key: 'invoice_date', label: 'Date', render: (r) => fmtDate(r.invoice_date) },
        { key: 'due_date', label: 'Due', render: (r) => <span className={r.status === 'open' && r.due_date < property.business_date ? 'danger' : ''}>{fmtDate(r.due_date)}</span> },
        { key: 'match', label: 'Check', render: (r) => <><Badge kind={MATCH[r.match_status][1]}>{MATCH[r.match_status][0]}</Badge>{r.match_status === 'variance' && <div className="small">{r.approved_by ? 'Accepted' : r.match_notes}</div>}</> },
        { key: 'total', label: 'Total', num: true, render: (r) => money(r.total) },
        { key: 'owed', label: 'Owed', num: true, render: (r) => (r.status === 'open' ? money(Number(r.total) - Number(r.paid)) : <Badge kind={r.status === 'paid' ? 'teal' : 'grey'}>{label(r.status)}</Badge>) },
        { key: 'act', label: '', render: (r) => r.status === 'open' && <span className="row-gap">
          {r.match_status === 'variance' && !r.approved_by && can(role, 'proc.approve') && <button className="btn btn-small" disabled={busy} onClick={() => { const n = window.prompt(`Accept ${r.invoice_no} although it differs (${r.match_notes})? Say why.`); if (n) run(() => rpc('pms_supplier_invoice_approve', { p_invoice: r.id, p_note: n }), 'Accepted').then(load).catch(() => {}); }}>Accept</button>}
          {can(role, 'proc.pay') && <button className="btn btn-small" onClick={() => setPay(r)}>Pay</button>}
          {Number(r.paid) === 0 && can(role, 'proc.invoice') && <button className="link danger" onClick={() => { const n = window.prompt('Why void this invoice?'); if (n) run(() => rpc('pms_supplier_invoice_void', { p_invoice: r.id, p_reason: n }), 'Voided').then(load).catch(() => {}); }}>Void</button>}
        </span> },
      ]} />}
      {form && <InvoiceForm form={form} setForm={setForm} lists={lists} onDone={() => { setForm(null); load(); }} />}
      {pay && <PayDialog inv={pay} onClose={() => setPay(null)} onDone={() => { setPay(null); load(); }} />}
    </>
  );
}

function InvoiceForm({ form, setForm, lists, onDone }) {
  const { property } = useProperty();
  const [run, busy] = useAction();
  const [grn, setGrn] = useState([]);
  useEffect(() => {
    if (!form.supplier_id) { setGrn([]); return; }
    supabase.from('pms_grn_lines').select('*, pms_goods_receipts!inner(grn_no, supplier_id, received_on, po_id), pms_po_lines(unit_price)').eq('pms_goods_receipts.supplier_id', form.supplier_id)
      .then(({ data }) => setGrn((data ?? []).filter((l) => Number(l.qty_invoiced) < Number(l.qty))));
  }, [form.supplier_id]);
  const item = (id) => lists.items.find((i) => i.id === id);
  const g = form.grn;
  const setG = (id, k, v) => setForm({ ...form, grn: { ...g, [id]: { ...(g[id] ?? {}), [k]: v } } });
  const picked = grn.filter((l) => g[l.id]?.on);
  const lines = [
    ...picked.map((l) => ({ grn_line_id: l.id, qty: num(g[l.id].qty ?? (Number(l.qty) - Number(l.qty_invoiced))), unit_price: num(g[l.id].price ?? l.pms_po_lines?.unit_price ?? l.unit_cost), vat_pct: num(g[l.id].vat ?? l.vat_pct) ?? 0 })),
    ...form.extra.filter((l) => (l.item_id || l.description) && num(l.qty)).map((l) => ({ item_id: l.item_id, description: l.description || null, qty: num(l.qty), unit_price: num(l.unit_price) ?? 0, vat_pct: num(l.vat_pct) ?? 0, expense_code: l.expense_code || null })),
  ];
  const total = lines.reduce((n, l) => n + l.qty * l.unit_price * (1 + l.vat_pct / 100), 0);
  return (
    <Modal title="Supplier invoice" wide onClose={() => setForm(null)} footer={<><span className="muted">Total {money(total)}</span><div className="row-gap"><button className="btn" onClick={() => setForm(null)}>Cancel</button>
      <button className="btn btn-primary" disabled={busy || !form.supplier_id || !form.invoice_no || !lines.length} onClick={() => run(() => rpc('pms_supplier_invoice_save', { p_property: property.id,
        p: { supplier_id: form.supplier_id, invoice_no: form.invoice_no, invoice_date: form.invoice_date, due_date: form.due_date || null, lines } }), 'Invoice entered').then(onDone).catch(() => {})}>Save</button></div></>}>
      <div className="grid-4">
        <Field label="Supplier"><select value={form.supplier_id} onChange={(e) => setForm({ ...form, supplier_id: e.target.value, grn: {} })}><option value="">Choose…</option>{lists.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="Their invoice no."><input value={form.invoice_no} onChange={(e) => setForm({ ...form, invoice_no: e.target.value })} /></Field>
        <Field label="Invoice date"><input type="date" value={form.invoice_date} onChange={(e) => setForm({ ...form, invoice_date: e.target.value })} /></Field>
        <Field label="Due" hint="Empty: their payment terms"><input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} /></Field>
      </div>
      {form.supplier_id && <>
        <h4>Delivered and not yet invoiced</h4>
        {grn.length === 0 ? <p className="small muted">Nothing waiting from this supplier.</p> : (
          <table className="table edit-table"><thead><tr><th /><th>Delivery</th><th>Item</th><th className="num">Qty</th><th className="num">Price (ordered)</th><th className="num">VAT %</th></tr></thead>
            <tbody>{grn.map((l) => (
              <tr key={l.id}><td><input type="checkbox" checked={!!g[l.id]?.on} onChange={(e) => setG(l.id, 'on', e.target.checked)} aria-label="On this invoice" /></td>
                <td className="small">GRN-{String(l.pms_goods_receipts.grn_no).padStart(5, '0')} · {fmtDate(l.pms_goods_receipts.received_on)}</td>
                <td>{item(l.item_id)?.name}</td>
                <td className="num"><input className="num" disabled={!g[l.id]?.on} value={g[l.id]?.qty ?? String(Number(l.qty) - Number(l.qty_invoiced))} aria-label="Qty" onChange={(e) => setG(l.id, 'qty', e.target.value.replace(/[^\d.]/g, ''))} /></td>
                <td className="num"><input className="num" disabled={!g[l.id]?.on} value={g[l.id]?.price ?? String(Number(l.pms_po_lines?.unit_price ?? l.unit_cost))} aria-label="Price" onChange={(e) => setG(l.id, 'price', e.target.value.replace(/[^\d.]/g, ''))} /></td>
                <td className="num"><input className="num" disabled={!g[l.id]?.on} value={g[l.id]?.vat ?? String(Number(l.vat_pct))} aria-label="VAT" onChange={(e) => setG(l.id, 'vat', e.target.value.replace(/[^\d.]/g, ''))} /></td></tr>))}</tbody></table>
        )}
        <h4>Other lines (services, repairs, items not received through the store)</h4>
        <Lines lines={form.extra} setLines={(extra) => setForm({ ...form, extra })} items={lists.items} priced vat describe />
        <p className="small muted">Quantities and prices that differ from the order and delivery are flagged, and a manager must accept the invoice before it is paid.</p>
      </>}
    </Modal>
  );
}

function PayDialog({ inv, onClose, onDone }) {
  const { property } = useProperty();
  const [run, busy] = useAction();
  const owed = Number(inv.total) - Number(inv.paid);
  const [f, setF] = useState({ amount: String(owed), method: 'bank', reference: '', paid_on: property.business_date });
  return (
    <Modal title={`Pay ${inv.invoice_no}`} onClose={onClose} footer={<><span className="muted">Owed {money(owed)}</span><div className="row-gap"><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-primary" disabled={busy} onClick={() => run(() => rpc('pms_supplier_pay', { p_invoice: inv.id, p_amount: num(f.amount), p_method: f.method, p_reference: f.reference || null, p_paid_on: f.paid_on }), 'Payment recorded').then(onDone).catch(() => {})}>Record payment</button></div></>}>
      <div className="grid-2">
        <Field label="Amount"><input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
        <Field label="Paid on"><input type="date" value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} /></Field>
        <Field label="How"><select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{PAY_METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Reference" hint="Transfer, cheque or transaction number"><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- reorder and par levels
function Reorder({ lists, onOrder }) {
  const { property, role } = useProperty();
  const [run, busy] = useAction();
  const [rows, setRows] = useState(null);
  const [loc, setLoc] = useState('');
  const [par, setPar] = useState([]);
  const load = useCallback(() => Promise.all([
    rpc('pms_reorder_suggestions', { p_property: property.id, p_location: loc || null }).then(setRows).catch(() => setRows([])),
    supabase.from('pms_stock_par').select('*').eq('property_id', property.id).then(({ data }) => setPar(data ?? [])),
  ]), [property.id, loc]);
  useEffect(() => { load(); }, [load]);
  const bySupplier = useMemo(() => {
    const g = {};
    for (const r of rows ?? []) (g[r.supplier_id ?? ''] ??= []).push(r);
    return g;
  }, [rows]);
  const order = (supplierId, list) => run(() => rpc('pms_po_save', { p_property: property.id, p: { supplier_id: supplierId, location_id: list[0].location_id,
    lines: list.map((r) => ({ item_id: r.item_id, qty: Number(r.suggest_purchase_units), unit_price: Number(r.last_cost ?? 0), vat_pct: 18 })) } }), 'Draft order made: check prices and submit').then(onOrder).catch(() => {});
  return (
    <>
      <div className="row-gap" style={{ marginBottom: 12 }}>
        <select className="auto" value={loc} onChange={(e) => setLoc(e.target.value)} aria-label="Store"><option value="">Every store</option>{lists.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        <span className="small muted">Items at or below their reorder level, topped up to par, in purchase units.</span>
      </div>
      {!rows ? <Loading /> : rows.length === 0 ? <div className="empty">Nothing needs reordering.</div> : Object.entries(bySupplier).map(([sid, list]) => (
        <div key={sid} className="card" style={{ marginBottom: 12 }}>
          <div className="row-gap" style={{ justifyContent: 'space-between' }}>
            <h4 className="first">{list[0].supplier ?? 'No usual supplier set'}</h4>
            {sid && can(role, 'proc.order') && <button className="btn btn-primary btn-small" disabled={busy} onClick={() => order(sid, list)}>Make a draft order</button>}
          </div>
          <Table rows={list} columns={[{ key: 'item', label: 'Item' }, { key: 'location', label: 'Store' },
            { key: 'on_hand', label: 'In stock', num: true, render: (r) => `${Number(r.on_hand)} ${r.unit}` },
            { key: 'reorder_level', label: 'Reorder at', num: true, render: (r) => Number(r.reorder_level) }, { key: 'par_level', label: 'Par', num: true, render: (r) => Number(r.par_level) },
            { key: 'suggest', label: 'Order', num: true, render: (r) => <strong>{Number(r.suggest_purchase_units)} {r.purchase_unit}</strong> },
            { key: 'last_cost', label: 'Last price', num: true, render: (r) => (r.last_cost ? money(r.last_cost) : '') }]} />
        </div>
      ))}
      {can(role, 'stock') && <>
        <h3>Par levels</h3>
        <p className="small muted">How much each store should hold. Without a par, items use their own reorder level for the main store.</p>
        <EditableList table="pms_stock_par" rows={par} onSaved={load} blank={{ location_id: lists.locations[0]?.id ?? '', item_id: '', par_level: '', reorder_level: '' }}
          fields={[{ key: 'location_id', label: 'Store', options: lists.locations.map((l) => [l.id, l.name]) }, { key: 'item_id', label: 'Item', options: [['', 'Choose…'], ...lists.items.map((i) => [i.id, `${i.name} (${i.unit})`])] },
            { key: 'par_level', label: 'Par', type: 'number' }, { key: 'reorder_level', label: 'Reorder at', type: 'number' }]} />
      </>}
    </>
  );
}

function Suppliers({ lists }) {
  const { role } = useProperty();
  if (!can(role, 'proc.suppliers')) return <Table rows={lists.suppliers} columns={[{ key: 'name', label: 'Supplier' }, { key: 'phone', label: 'Phone' }, { key: 'payment_terms_days', label: 'Terms (days)', num: true }]} />;
  return (
    <>
      <EditableList table="pms_suppliers" rows={lists.suppliers} onSaved={lists.reload}
        blank={{ name: '', contact_name: '', phone: '', email: '', tin: '', vrn: '', payment_terms_days: 30, currency: 'TZS', active: true }}
        fields={[{ key: 'name', label: 'Supplier' }, { key: 'contact_name', label: 'Contact' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
          { key: 'tin', label: 'TIN' }, { key: 'vrn', label: 'VRN' }, { key: 'payment_terms_days', label: 'Terms (days)', type: 'number' }, { key: 'currency', label: 'Currency' },
          { key: 'active', label: 'Active', type: 'bool' }]} />
      <p className="small muted">Usual supplier, purchase unit (a case of 24) and units per purchase are set on each item under Stock and stores → Items.</p>
    </>
  );
}

// Orders up to this total (with VAT) are approved when submitted; above it a manager or owner other than the buyer approves.
function ApprovalLimit() {
  const { property, role, refresh } = useProperty();
  const [run, busy] = useAction();
  const limit = Number(property.settings?.procurement?.approval_limit ?? 0);
  if (!can(role, 'setup')) return <span className="small muted">{limit ? `Orders over ${money(limit)} need approval.` : 'Every order needs approval.'}</span>;
  const change = () => {
    const v = window.prompt('Orders up to what total (with VAT) are approved without a manager? 0 means every order needs approval.', String(limit));
    if (v == null || !/^\d+(\.\d+)?$/.test(v.trim())) return;
    const settings = { ...(property.settings ?? {}), procurement: { ...(property.settings?.procurement ?? {}), approval_limit: Number(v) } };
    run(async () => { const { error } = await supabase.from('pms_properties').update({ settings }).eq('id', property.id); if (error) throw error; refresh(); }, 'Approval limit saved').catch(() => {});
  };
  return <button type="button" className="link small" disabled={busy} onClick={change}>{limit ? `Orders over ${money(limit)} need approval` : 'Every order needs approval'} · change</button>;
}
