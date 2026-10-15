import { useCallback, useEffect, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { fmtDate, label, money } from '../lib/format';
import { Field, Modal, PageHead, Table, useAction } from '../components/ui.jsx';

export default function CityLedger() {
  const { property, version } = useProperty();
  const [rows, setRows] = useState(null);
  const [company, setCompany] = useState(null);

  const load = useCallback(() => rpc('pms_rpt_ageing', { p_property: property.id }).then(setRows).catch(() => setRows([])), [property.id]);
  useEffect(() => { load(); }, [load, version]);

  const sum = (k) => money((rows ?? []).reduce((n, r) => n + Number(r[k]), 0));
  return (
    <>
      <PageHead title="City ledger" sub="Company accounts: folios transferred at check-out and payments received. Add companies under Setup." />
      <Table rows={rows} onRow={setCompany} empty="No company balances yet"
        footer={{ company: 'Total', balance: sum('balance'), d0_30: sum('d0_30'), d31_60: sum('d31_60'), d61_90: sum('d61_90'), d90_plus: sum('d90_plus') }}
        columns={[
          { key: 'company', label: 'Company', render: (r) => <strong>{r.company}</strong> },
          { key: 'balance', label: 'Balance', num: true, render: (r) => <span className={Number(r.balance) > Number(r.credit_limit) && Number(r.credit_limit) > 0 ? 'danger' : ''}>{money(r.balance)}</span> },
          { key: 'd0_30', label: '0–30 days', num: true, render: (r) => money(r.d0_30) },
          { key: 'd31_60', label: '31–60', num: true, render: (r) => money(r.d31_60) },
          { key: 'd61_90', label: '61–90', num: true, render: (r) => money(r.d61_90) },
          { key: 'd90_plus', label: '90+', num: true, render: (r) => <span className={Number(r.d90_plus) > 0 ? 'danger' : ''}>{money(r.d90_plus)}</span> },
          { key: 'credit_limit', label: 'Credit limit', num: true, render: (r) => money(r.credit_limit) },
        ]} />
      {company && <Account company={company} onClose={() => { setCompany(null); load(); }} />}
    </>
  );
}

function Account({ company, onClose }) {
  const { property } = useProperty();
  const [run, busy] = useAction();
  const [entries, setEntries] = useState(null);
  const [f, setF] = useState({ amount: '', method: 'bank', reference: '' });
  const load = useCallback(() => supabase.from('pms_city_ledger').select('*').eq('company_id', company.company_id)
    .order('business_date', { ascending: false }).order('created_at', { ascending: false })
    .then(({ data }) => setEntries(data ?? [])), [company.company_id]);
  useEffect(() => { load(); }, [load]);
  const balance = (entries ?? []).reduce((n, e) => n + Number(e.amount), 0);

  return (
    <Modal wide title={company.company} onClose={onClose}>
      <div className="kpis">
        <div className="kpi"><span>Balance</span><strong>{property.currency} {money(balance)}</strong></div>
        <div className="kpi"><span>Credit limit</span><strong>{money(company.credit_limit)}</strong></div>
        <div className="kpi"><span>Oldest open invoice</span><strong>{fmtDate(company.oldest_invoice) || '—'}</strong></div>
      </div>
      <form className="inline-form" onSubmit={(e) => {
        e.preventDefault();
        run(() => rpc('pms_city_ledger_payment', { p_property: property.id, p_company: company.company_id, p_amount: Number(f.amount), p_method: f.method, p_reference: f.reference || null }), 'Payment recorded')
          .then(() => { setF({ amount: '', method: 'bank', reference: '' }); load(); }).catch(() => {});
      }}>
        <Field label="Receive payment"><input required inputMode="decimal" placeholder="Amount" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
        <Field label="Method">
          <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            {['bank', 'mobile_money', 'cash', 'card', 'other'].map((m) => <option key={m} value={m}>{label(m)}</option>)}
          </select>
        </Field>
        <Field label="Reference"><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        <button className="btn btn-primary" disabled={busy}>Record</button>
      </form>
      <Table rows={entries} empty="No entries" columns={[
        { key: 'business_date', label: 'Date', render: (e) => fmtDate(e.business_date) },
        { key: 'description', label: 'Description' },
        { key: 'reference', label: 'Ref', render: (e) => (e.reference ?? '').startsWith('drawer:') ? 'Cash drawer' : e.reference },
        { key: 'debit', label: 'Invoiced', num: true, render: (e) => (e.amount > 0 ? money(e.amount) : '') },
        { key: 'credit', label: 'Paid', num: true, render: (e) => (e.amount < 0 ? money(-e.amount) : '') },
      ]} />
    </Modal>
  );
}
