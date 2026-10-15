import { useEffect, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { addDays, fmtDate, label, money } from '../lib/format';
import { Field, Modal, PageHead, Table, useAction } from '../components/ui.jsx';

const CATS = ['supplies', 'repairs', 'utilities', 'transport', 'food_purchases', 'laundry', 'salaries', 'commission', 'marketing', 'petty', 'other'];

export default function Expenses() {
  const { property, version } = useProperty();
  const [from, setFrom] = useState(addDays(property.business_date, -30));
  const [to, setTo] = useState(property.business_date);
  const [rows, setRows] = useState(null);
  const [adding, setAdding] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    supabase.from('pms_expense_vouchers').select('*').eq('property_id', property.id)
      .gte('business_date', from).lte('business_date', to).order('created_at', { ascending: false })
      .then(({ data }) => setRows(data ?? []));
  }, [property.id, from, to, version, tick]);

  const total = (rows ?? []).reduce((n, r) => n + Number(r.amount), 0);
  return (
    <>
      <PageHead title="Expense vouchers" sub="Money paid out at the property. Cash vouchers come out of your open drawer.">
        <button className="btn btn-primary" onClick={() => setAdding(true)}>+ New voucher</button>
      </PageHead>
      <div className="filters">
        <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <Table rows={rows} empty="No vouchers in this range" footer={{ description: 'Total', amount: money(total) }} columns={[
        { key: 'voucher_no', label: 'No.' },
        { key: 'business_date', label: 'Date', render: (r) => fmtDate(r.business_date) },
        { key: 'category', label: 'Category', render: (r) => label(r.category) },
        { key: 'description', label: 'Description' },
        { key: 'paid_to', label: 'Paid to' },
        { key: 'payment_method', label: 'Method', render: (r) => label(r.payment_method) },
        { key: 'amount', label: 'Amount', num: true, render: (r) => money(r.amount) },
      ]} />
      {adding && <NewVoucher onClose={() => setAdding(false)} onSaved={() => { setAdding(false); setTick((x) => x + 1); }} />}
    </>
  );
}

function NewVoucher({ onClose, onSaved }) {
  const { property } = useProperty();
  const [run, busy] = useAction();
  const [f, setF] = useState({ category: 'supplies', description: '', amount: '', method: 'cash', paid_to: '', reference: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="New expense voucher" onClose={onClose}
      footer={<><span /><div className="row-gap"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="voucher" disabled={busy}>Save voucher</button></div></>}>
      <form id="voucher" className="stack" onSubmit={(e) => {
        e.preventDefault();
        run(() => rpc('pms_add_expense', {
          p_property: property.id, p_category: f.category, p_description: f.description, p_amount: Number(f.amount),
          p_method: f.method, p_paid_to: f.paid_to || null, p_reference: f.reference || null,
        }), 'Voucher saved').then(onSaved).catch(() => {});
      }}>
        <Field label="Category"><select value={f.category} onChange={set('category')}>{CATS.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
        <Field label="Description"><input required value={f.description} onChange={set('description')} /></Field>
        <Field label={`Amount (${property.currency})`}><input required inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
        <Field label="Paid with">
          <select value={f.method} onChange={set('method')}>
            {['cash', 'mobile_money', 'bank', 'card', 'other'].map((m) => <option key={m} value={m}>{label(m)}</option>)}
          </select>
        </Field>
        <Field label="Paid to"><input value={f.paid_to} onChange={set('paid_to')} /></Field>
        <Field label="Receipt / reference"><input value={f.reference} onChange={set('reference')} /></Field>
      </form>
    </Modal>
  );
}
