import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { addDays, can, downloadCSV, fmtDate } from '../lib/format';
import { Field, Loading, PageHead, useAction } from '../components/ui.jsx';

// Rate calendar: one grid, switch the layer you are editing. Changed cells glow until saved.
const LAYERS = [
  { key: 'amount', label: 'Price', kind: 'money' },
  { key: 'extra_adult', label: 'Extra adult', kind: 'money' },
  { key: 'extra_child', label: 'Extra child', kind: 'money' },
  { key: 'min_stay', label: 'Min nights', kind: 'int' },
  { key: 'max_stay', label: 'Max nights', kind: 'int' },
  { key: 'stop_sell', label: 'Closed', kind: 'bool' },
  { key: 'cta', label: 'No arrivals', kind: 'bool' },
  { key: 'ctd', label: 'No departures', kind: 'bool' },
];
const keyOf = (c) => `${c.room_type_id}|${c.rate_plan_id}|${c.rate_date}`;

export default function RateCalendar() {
  const { property, role, lookups } = useProperty();
  const [run, busy] = useAction();
  const [from, setFrom] = useState(property.business_date);
  const [days, setDays] = useState(14);
  const [layer, setLayer] = useState('amount');
  const [typeFilter, setTypeFilter] = useState('');
  const [showDerived, setShowDerived] = useState(true);
  const [cells, setCells] = useState(null);
  const [edits, setEdits] = useState({});
  const [bulk, setBulk] = useState(null);
  const editable = can(role, 'rates');
  const L = LAYERS.find((x) => x.key === layer);
  const weekend = new Set(property.settings?.weekend_days ?? [5, 6]);

  const load = useCallback(() => rpc('pms_rate_grid', { p_property: property.id, p_from: from, p_days: days }).then(setCells).catch(() => setCells([])), [property.id, from, days]);
  useEffect(() => { load(); }, [load]);

  const dates = useMemo(() => Array.from({ length: days }, (_, i) => addDays(from, i)), [from, days]);
  const byKey = useMemo(() => Object.fromEntries((cells ?? []).map((c) => [keyOf(c), c])), [cells]);
  const plans = lookups.ratePlans.filter((p) => p.active && (showDerived || !p.parent_id));
  const types = lookups.roomTypes.filter((t) => t.active && (!typeFilter || t.id === typeFilter));
  const dirty = Object.keys(edits).length;

  const value = (c) => {
    const e = edits[keyOf(c)];
    return e && layer in e ? e[layer] : c[layer];
  };
  const change = (c, v) => setEdits((x) => ({ ...x, [keyOf(c)]: { ...(x[keyOf(c)] ?? {}), [layer]: v } }));
  const save = () => run(async () => {
    const payload = Object.entries(edits).map(([k, e]) => {
      const [room_type_id, rate_plan_id, date] = k.split('|');
      const out = { room_type_id, rate_plan_id, date };
      for (const [f, v] of Object.entries(e)) out[f] = LAYERS.find((x) => x.key === f).kind === 'bool' ? !!v : v === '' ? (f === 'amount' ? null : f === 'min_stay' ? 1 : null) : Number(v);
      return out;
    });
    await rpc('pms_save_rate_grid', { p_property: property.id, p_cells: payload });
    setEdits({}); await load();
  }, `${dirty} change${dirty === 1 ? '' : 's'} saved and sent to the channels`).catch(() => {});

  const applyBulk = (b) => {
    const n = Math.round((new Date(b.to) - new Date(b.from)) / 86400000) + 1;
    if (n < 1 || n > 366) return;
    const next = { ...edits };
    for (let i = 0; i < n; i++) {
      const d = addDays(b.from, i);
      if (!b.days.includes(new Date(d + 'T00:00:00').getDay())) continue;
      for (const t of lookups.roomTypes.filter((x) => !b.type || x.id === b.type)) {
        for (const p of lookups.ratePlans.filter((x) => x.active && (!b.plan || x.id === b.plan))) {
          const k = `${t.id}|${p.id}|${d}`;
          next[k] = { ...(next[k] ?? {}), [b.layer]: LAYERS.find((x) => x.key === b.layer).kind === 'bool' ? b.value === 'yes' : b.value };
        }
      }
    }
    setEdits(next); setBulk(null);
  };

  const exportCsv = () => downloadCSV(`rates-${from}.csv`, (cells ?? []).map((c) => ({
    room_type: lookups.roomTypes.find((t) => t.id === c.room_type_id)?.name, rate_plan: lookups.ratePlans.find((p) => p.id === c.rate_plan_id)?.name,
    date: c.rate_date, price: c.amount, own_price: c.own_rate, extra_adult: c.extra_adult, extra_child: c.extra_child,
    min_nights: c.min_stay, max_nights: c.max_stay ?? '', closed: c.stop_sell, no_arrival: c.cta, no_departure: c.ctd, rooms_left: c.free,
  })));

  if (!cells) return <Loading />;
  return (
    <>
      <PageHead title="Rate calendar" sub="Prices, extra guests, minimum and maximum nights and closures, by date. Saved changes go to Booking.com and the other channels and to your booking page." />
      <div className="rc-bar">
        <div className="rc-nav">
          <button className="btn btn-small" onClick={() => setFrom(addDays(from, -days))} aria-label="Earlier">‹</button>
          <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label="First date" />
          <button className="btn btn-small" onClick={() => setFrom(addDays(from, days))} aria-label="Later">›</button>
          <button className="btn btn-small" onClick={() => setFrom(property.business_date)}>Today</button>
          <select className="auto" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Days shown">{[7, 14, 21, 28].map((d) => <option key={d} value={d}>{d} days</option>)}</select>
        </div>
        <div className="rc-layers" role="tablist" aria-label="What to show">
          {LAYERS.map((x) => <button key={x.key} role="tab" aria-selected={layer === x.key} className={layer === x.key ? 'on' : ''} onClick={() => setLayer(x.key)}>{x.label}</button>)}
        </div>
        <div className="rc-filters">
          <select className="auto" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Room type"><option value="">All room types</option>{lookups.roomTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          <label className="check small"><input type="checkbox" checked={showDerived} onChange={(e) => setShowDerived(e.target.checked)} /> Plans that follow another</label>
          <button className="btn btn-small" onClick={exportCsv}>Export</button>
          {editable && <button className="btn btn-small" onClick={() => setBulk({ from, to: addDays(from, 6), days: [0, 1, 2, 3, 4, 5, 6], type: '', plan: '', layer, value: L.kind === 'bool' ? 'yes' : '' })}>Change a date range…</button>}
        </div>
      </div>

      {bulk && (
        <form className="card rc-bulk" onSubmit={(e) => { e.preventDefault(); applyBulk(bulk); }}>
          <div className="inline-form">
            <Field label="From"><input type="date" value={bulk.from} onChange={(e) => setBulk({ ...bulk, from: e.target.value })} /></Field>
            <Field label="To"><input type="date" value={bulk.to} min={bulk.from} onChange={(e) => setBulk({ ...bulk, to: e.target.value })} /></Field>
            <Field label="Room type"><select value={bulk.type} onChange={(e) => setBulk({ ...bulk, type: e.target.value })}><option value="">All</option>{lookups.roomTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
            <Field label="Rate plan"><select value={bulk.plan} onChange={(e) => setBulk({ ...bulk, plan: e.target.value })}><option value="">All</option>{lookups.ratePlans.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
            <Field label="Change"><select value={bulk.layer} onChange={(e) => setBulk({ ...bulk, layer: e.target.value, value: LAYERS.find((x) => x.key === e.target.value).kind === 'bool' ? 'yes' : '' })}>{LAYERS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select></Field>
            <Field label="To"> {LAYERS.find((x) => x.key === bulk.layer).kind === 'bool'
              ? <select value={bulk.value} onChange={(e) => setBulk({ ...bulk, value: e.target.value })}><option value="yes">Yes</option><option value="no">No</option></select>
              : <input inputMode="decimal" value={bulk.value} onChange={(e) => setBulk({ ...bulk, value: e.target.value.replace(/[^\d.]/g, '') })} placeholder={bulk.layer === 'amount' ? 'empty = back to base' : ''} />}</Field>
          </div>
          <div className="row-gap">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
              <label key={d} className="check small"><input type="checkbox" checked={bulk.days.includes(i)} onChange={(e) => setBulk({ ...bulk, days: e.target.checked ? [...bulk.days, i] : bulk.days.filter((x) => x !== i) })} /> {d}</label>))}
            <button className="btn btn-primary">Apply to the grid</button><button type="button" className="btn" onClick={() => setBulk(null)}>Cancel</button>
          </div>
          <p className="small muted">Changes appear highlighted; nothing is sent until you press Save.</p>
        </form>
      )}

      <div className="table-wrap rc-wrap">
        <table className="rc">
          <thead>
            <tr>
              <th className="rc-corner">{L.label}</th>
              {dates.map((d) => {
                const dow = new Date(d + 'T00:00:00').getDay();
                const hol = lookups.holidays.find((h) => h.holiday_date === d);
                return <th key={d} className={`${weekend.has(dow) ? 'we' : ''} ${hol ? 'hol' : ''}`} title={hol?.name}>
                  <span className="rc-dow">{fmtDate(d, { weekday: 'short' })}</span><span className="rc-day">{fmtDate(d, { day: 'numeric' })}</span>
                  <span className="rc-mon">{fmtDate(d, { month: 'short' })}</span>{hol && <span className="rc-hol">●</span>}</th>;
              })}
            </tr>
          </thead>
          <tbody>
            {types.map((t) => {
              const first = plans[0];
              return (
                <Fragment key={t.id}>
                  <tr className="rc-type">
                    <th>{t.name}</th>
                    {dates.map((d) => {
                      const c = first && byKey[`${t.id}|${first.id}|${d}`];
                      const pct = c && c.total ? Math.round(((c.total - c.free) * 100) / c.total) : 0;
                      return <td key={d} title={c ? `${c.free} of ${c.total} free` : ''}><span className={`rc-left ${c?.free < 1 ? 'none' : c?.free <= 1 ? 'low' : ''}`}>{c?.free ?? ''}</span><span className="rc-bar-fill" style={{ width: `${pct}%` }} /></td>;
                    })}
                  </tr>
                  {plans.map((p) => (
                    <tr key={p.id} className="rc-plan">
                      <th>{p.parent_id && <span className="muted">↳ </span>}{p.name}</th>
                      {dates.map((d) => {
                        const c = byKey[`${t.id}|${p.id}|${d}`];
                        if (!c) return <td key={d} />;
                        const v = value(c);
                        const changed = edits[keyOf(c)] && layer in edits[keyOf(c)];
                        const inherited = layer === 'amount' && !c.own_rate && !changed;
                        return (
                          <td key={d} className={`${changed ? 'chg' : ''} ${c.stop_sell && layer !== 'stop_sell' ? 'closed' : ''}`}>
                            {L.kind === 'bool'
                              ? <button className={`rc-flag ${v ? 'on' : ''}`} disabled={!editable} onClick={() => change(c, !v)} aria-pressed={!!v} aria-label={`${L.label} ${d}`}>{v ? '✕' : ''}</button>
                              : <input className={`rc-in ${inherited ? 'inh' : ''}`} disabled={!editable} inputMode="decimal" aria-label={`${t.name} ${p.name} ${d}`}
                                  value={v ?? ''} placeholder={layer === 'max_stay' ? '–' : ''}
                                  onChange={(e) => change(c, e.target.value.replace(/[^\d.]/g, ''))} title={inherited ? (p.parent_id ? 'Follows its parent plan' : 'Base rate') : ''} />}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="small muted">Grey prices follow the base rate or the parent plan; typing one makes it an own rate for that day (clear it to go back). Weekend nights and holidays are shaded. The top line of each room type shows rooms still free.</p>
      {editable && dirty > 0 && (
        <div className="rc-save">
          <span>{dirty} change{dirty === 1 ? '' : 's'} not saved</span>
          <button className="btn" onClick={() => setEdits({})}>Discard</button>
          <button className="btn btn-primary" disabled={busy} onClick={save}>Save</button>
        </div>
      )}
      <p className="small muted">Prices in {property.currency}, {property.tax_inclusive ? 'including' : 'excluding'} tax.</p>
    </>
  );
}
