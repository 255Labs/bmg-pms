import { announceAudit } from '../lib/nightmode.js';
import { useCallback, useEffect, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { useDesk } from '../lib/desk';
import { can, fmtDate, fmtDateTime, money } from '../lib/format';
import { Loading, PageHead, Table, useAction } from '../components/ui.jsx';

export default function NightAudit() {
  const { property, role, refresh, reloadProperties } = useProperty();
  const desk = useDesk();
  const [run, busy] = useAction();
  const [check, setCheck] = useState(null);
  const [history, setHistory] = useState(null);
  const [noShows, setNoShows] = useState(false);
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    const [c, h] = await Promise.all([
      rpc('pms_night_audit_check', { p_property: property.id }),
      supabase.from('pms_night_audits').select('*').eq('property_id', property.id).order('business_date', { ascending: false }).limit(60),
    ]);
    setCheck(c);
    setHistory(h.data ?? []);
  }, [property.id]);
  useEffect(() => { load(); }, [load, property.business_date]);

  if (!check) return <Loading />;
  const blocked = check.pending_departures.length > 0;
  const needsNoShow = check.pending_arrivals.length > 0;

  const go = () => {
    if (!window.confirm(`Close ${fmtDate(check.business_date)}? Room charges will post to ${check.in_house} in-house guest(s) and the business date moves to the next day.`)) return;
    run(async () => { announceAudit(true); try { return await rpc('pms_run_night_audit', { p_property: property.id, p_mark_no_shows: noShows }); } finally { announceAudit(false); } }, 'Night audit complete')
      .then((r) => { setResult(r); refresh(); reloadProperties(); load(); }).catch(() => {});
  };

  const List = ({ items, field }) => (
    <ul className="plain-list">
      {items.map((x) => (
        <li key={x.stay_id}>
          <button className="link" onClick={async () => {
            const { data } = await supabase.from('pms_stays').select('reservation_id').eq('id', x.stay_id).single();
            if (data) desk.openReservation(data.reservation_id);
          }}>#{x.res_no} {x.guest}</button>
          <span className="muted small"> · room {x.room ?? 'unassigned'} · {field === 'arrival' ? 'arriving' : 'due out'} {fmtDate(x[field])}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <PageHead title="Night audit" sub={`Closing business date ${fmtDate(check.business_date)}`} />
      {result && (
        <div className="card success-card">
          <h3>{fmtDate(result.closed_date)} closed — business date is now {fmtDate(result.new_business_date)}</h3>
          <div className="kpis">
            <div className="kpi"><span>Rooms sold</span><strong>{result.rooms_sold} / {result.rooms_available}</strong></div>
            <div className="kpi"><span>Room revenue</span><strong>{money(result.room_revenue)}</strong></div>
            <div className="kpi"><span>Tax</span><strong>{money(result.tax_revenue)}</strong></div>
            <div className="kpi"><span>Other revenue</span><strong>{money(result.other_revenue)}</strong></div>
            <div className="kpi"><span>Payments</span><strong>{money(result.payments)}</strong></div>
            <div className="kpi"><span>No-shows</span><strong>{result.no_shows}</strong></div>
          </div>
        </div>
      )}
      <div className="audit-steps">
        <div className={`step ${blocked ? 'bad' : 'good'}`}>
          <h4>1. Departures</h4>
          {blocked ? <><p>These guests are due out but still checked in. Check them out or extend their stay.</p><List items={check.pending_departures} field="departure" /></>
            : <p>All departures handled.</p>}
        </div>
        <div className={`step ${needsNoShow && !noShows ? 'bad' : 'good'}`}>
          <h4>2. Arrivals</h4>
          {needsNoShow ? <>
            <p>These arrivals have not checked in. Check them in, cancel them, or mark them as no-shows.</p>
            <List items={check.pending_arrivals} field="arrival" />
            <label className="check"><input type="checkbox" checked={noShows} onChange={(e) => setNoShows(e.target.checked)} /> Mark all {check.pending_arrivals.length} as no-show</label>
          </> : <p>All arrivals handled.</p>}
        </div>
        <div className={`step ${check.open_drawers ? 'warn' : 'good'}`}>
          <h4>3. Cash drawers</h4>
          <p>{check.open_drawers ? `${check.open_drawers} drawer(s) still open. Closing them first is recommended, but not required.` : 'No open drawers.'}</p>
        </div>
        <div className="step">
          <h4>4. Post and roll</h4>
          <p>Posts tonight's room charge{property.tax_inclusive ? '' : ` and ${property.tax_rate}% VAT`} to {check.in_house} in-house guest(s), marks occupied rooms dirty, saves the day's statistics and moves the business date.</p>
          {can(role, 'audit')
            ? <button className="btn btn-primary" disabled={busy || blocked || (needsNoShow && !noShows)} onClick={go}>{busy ? 'Running…' : `Run night audit for ${fmtDate(check.business_date)}`}</button>
            : <p className="muted">Your role cannot run the night audit.</p>}
        </div>
      </div>

      <h3>Audit history</h3>
      <Table rows={history} empty="No audits yet" columns={[
        { key: 'business_date', label: 'Date', render: (a) => <strong>{fmtDate(a.business_date)}</strong> },
        { key: 'occ', label: 'Occupancy', num: true, render: (a) => `${a.rooms_sold}/${a.rooms_available} · ${a.occupancy_pct}%` },
        { key: 'room_revenue', label: 'Room', num: true, render: (a) => money(a.room_revenue) },
        { key: 'tax_revenue', label: 'Tax', num: true, render: (a) => money(a.tax_revenue) },
        { key: 'other_revenue', label: 'Other', num: true, render: (a) => money(a.other_revenue) },
        { key: 'adr', label: 'ADR', num: true, render: (a) => money(a.summary?.adr) },
        { key: 'revpar', label: 'RevPAR', num: true, render: (a) => money(a.summary?.revpar) },
        { key: 'payments', label: 'Payments', num: true, render: (a) => money(a.payments) },
        { key: 'no_shows', label: 'No-shows', num: true },
        { key: 'run_at', label: 'Run at', render: (a) => fmtDateTime(a.run_at) },
      ]} />
    </>
  );
}
