import { useCallback, useEffect, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { fmtDateTime, money } from '../lib/format';
import { Badge, Field, PageHead, Table, useAction } from '../components/ui.jsx';

export default function CashDrawer() {
  const { property, user, version } = useProperty();
  const [run, busy] = useAction();
  const [mine, setMine] = useState(undefined);
  const [expected, setExpected] = useState(0);
  const [moves, setMoves] = useState([]);
  const [history, setHistory] = useState(null);
  const [float, setFloat] = useState('');
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    const { data: open } = await supabase.from('pms_drawer_sessions').select('*')
      .eq('property_id', property.id).eq('user_id', user.id).eq('status', 'open').maybeSingle();
    setMine(open ?? null);
    if (open) {
      const [exp, lines, exps] = await Promise.all([
        rpc('pms_drawer_expected', { p_session: open.id }),
        supabase.from('pms_folio_lines').select('created_at,description,amount,reference,voided').eq('drawer_session_id', open.id).order('created_at'),
        supabase.from('pms_expense_vouchers').select('created_at,description,amount,paid_to').eq('drawer_session_id', open.id).order('created_at'),
      ]);
      setExpected(Number(exp ?? 0));
      setMoves([
        ...(lines.data ?? []).map((l) => ({ at: l.created_at, what: l.description + (l.voided ? ' (void)' : ''), ref: l.reference, amount: l.voided ? 0 : -Number(l.amount) })),
        ...(exps.data ?? []).map((e) => ({ at: e.created_at, what: 'Expense — ' + e.description, ref: e.paid_to, amount: -Number(e.amount) })),
      ].sort((a, b) => a.at.localeCompare(b.at)));
    }
    const { data: hist } = await supabase.from('pms_drawer_sessions').select('*')
      .eq('property_id', property.id).eq('status', 'closed').order('closed_at', { ascending: false }).limit(50);
    setHistory(hist ?? []);
  }, [property.id, user.id]);

  useEffect(() => { load(); }, [load, version]);

  return (
    <>
      <PageHead title="Cash drawer" sub="Open a drawer before taking cash. Close it at the end of your shift and count the cash." />
      {mine === null && (
        <form className="card narrow" onSubmit={(e) => { e.preventDefault(); run(() => rpc('pms_open_drawer', { p_property: property.id, p_float: Number(float || 0) }), 'Drawer opened').then(load).catch(() => {}); }}>
          <h3>Open drawer</h3>
          <Field label={`Opening float (${property.currency})`}><input inputMode="decimal" value={float} onChange={(e) => setFloat(e.target.value.replace(/[^\d.]/g, ''))} placeholder="0" /></Field>
          <button className="btn btn-primary" disabled={busy}>Open drawer</button>
          {result && <p className="note">Last close: expected {money(result.expected)}, counted {money(result.counted)}, variance <strong className={result.variance < 0 ? 'danger' : ''}>{money(result.variance)}</strong></p>}
        </form>
      )}
      {mine && (
        <div className="grid-2 align-start">
          <div className="card">
            <h3>Your open drawer</h3>
            <div className="kpis">
              <div className="kpi"><span>Opened</span><strong>{fmtDateTime(mine.opened_at)}</strong></div>
              <div className="kpi"><span>Float</span><strong>{money(mine.opening_float)}</strong></div>
              <div className="kpi"><span>Expected cash</span><strong>{money(expected)}</strong></div>
            </div>
            <form onSubmit={(e) => {
              e.preventDefault();
              if (!window.confirm('Close the drawer with this count? This cannot be reopened.')) return;
              run(() => rpc('pms_close_drawer', { p_session: mine.id, p_counted: Number(counted || 0), p_notes: notes || null }), 'Drawer closed')
                .then((r) => { setResult(r); setCounted(''); setNotes(''); load(); }).catch(() => {});
            }}>
              <Field label={`Counted cash (${property.currency})`}><input required inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
              {counted !== '' && <p className="small">Variance: <strong className={Number(counted) - expected < 0 ? 'danger' : ''}>{money(Number(counted) - expected)}</strong></p>}
              <Field label="Notes"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
              <button className="btn btn-primary" disabled={busy}>Close drawer</button>
            </form>
          </div>
          <div className="card">
            <h3>Cash movements</h3>
            <Table rows={moves} empty="No cash movements yet" columns={[
              { key: 'at', label: 'Time', render: (m) => fmtDateTime(m.at) },
              { key: 'what', label: 'Description' },
              { key: 'ref', label: 'Ref' },
              { key: 'amount', label: 'In / out', num: true, render: (m) => <span className={m.amount < 0 ? 'danger' : ''}>{money(m.amount)}</span> },
            ]} />
          </div>
        </div>
      )}
      <h3>Closed drawers</h3>
      <Table rows={history} empty="No closed drawers yet" columns={[
        { key: 'opened_at', label: 'Opened', render: (s) => fmtDateTime(s.opened_at) },
        { key: 'closed_at', label: 'Closed', render: (s) => fmtDateTime(s.closed_at) },
        { key: 'opening_float', label: 'Float', num: true, render: (s) => money(s.opening_float) },
        { key: 'expected_cash', label: 'Expected', num: true, render: (s) => money(s.expected_cash) },
        { key: 'counted_cash', label: 'Counted', num: true, render: (s) => money(s.counted_cash) },
        { key: 'variance', label: 'Variance', num: true, render: (s) => <Badge kind={Number(s.variance) === 0 ? 'green' : 'red'}>{money(s.variance)}</Badge> },
        { key: 'notes', label: 'Notes' },
      ]} />
    </>
  );
}
