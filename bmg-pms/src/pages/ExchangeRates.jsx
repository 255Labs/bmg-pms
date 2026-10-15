import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { can, fmtDate, fmtDateTime, money } from '../lib/format';
import { Field, PageHead, Table, useAction } from '../components/ui.jsx';

const COMMON = ['USD', 'EUR', 'GBP', 'KES', 'ZAR', 'AED', 'CNY'];

export default function ExchangeRates() {
  const { property, role } = useProperty();
  const [run, busy] = useAction();
  const [rows, setRows] = useState(null);
  const [f, setF] = useState({ currency: 'USD', rate: '' });
  const load = useCallback(() => supabase.from('pms_exchange_rates').select('*').eq('property_id', property.id)
    .order('effective_date', { ascending: false }).order('currency').limit(300).then(({ data }) => setRows(data ?? [])), [property.id]);
  useEffect(() => { load(); }, [load]);
  const latest = useMemo(() => {
    const m = {};
    for (const r of rows ?? []) if (!m[r.currency]) m[r.currency] = r;
    return Object.values(m);
  }, [rows]);
  const stale = (r) => r.effective_date < property.business_date;

  return (
    <>
      <PageHead title="Exchange rates" sub={`Guests can pay in foreign currency; folios stay in ${property.currency}. Set each day's rate before taking foreign cash.`} />
      {can(role, 'backoffice') && (
        <form className="card inline-form" onSubmit={(e) => {
          e.preventDefault();
          run(() => rpc('pms_set_exchange_rate', { p_property: property.id, p_currency: f.currency.toUpperCase(), p_rate: Number(f.rate), p_date: null }),
            `Rate for ${f.currency.toUpperCase()} set for ${fmtDate(property.business_date)}`).then(() => { setF({ ...f, rate: '' }); load(); }).catch(() => {});
        }}>
          <Field label="Currency">
            <input list="ccy" required maxLength={3} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })} />
            <datalist id="ccy">{COMMON.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label={`${property.currency} for 1 ${f.currency || '…'}`}><input required inputMode="decimal" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value.replace(/[^\d.]/g, '') })} placeholder="e.g. 2650" /></Field>
          <button className="btn btn-primary" disabled={busy}>Set today's rate</button>
        </form>
      )}
      <h3 className="first">Current rates</h3>
      <Table rows={latest} empty="No foreign currencies yet." columns={[
        { key: 'currency', label: 'Currency', render: (r) => <strong>{r.currency}</strong> },
        { key: 'rate', label: `${property.currency} per unit`, num: true, render: (r) => money(r.rate) },
        { key: 'effective_date', label: 'Set for', render: (r) => <>{fmtDate(r.effective_date)}{stale(r) && <span className="badge badge-amber">Not updated today</span>}</> },
      ]} />
      <h3>History</h3>
      <Table rows={rows} empty="No history" columns={[
        { key: 'effective_date', label: 'Date', render: (r) => fmtDate(r.effective_date) },
        { key: 'currency', label: 'Currency' },
        { key: 'rate', label: 'Rate', num: true, render: (r) => money(r.rate) },
        { key: 'created_at', label: 'Entered', render: (r) => fmtDateTime(r.created_at) },
      ]} />
    </>
  );
}
