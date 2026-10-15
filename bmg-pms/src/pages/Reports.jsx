import { useEffect, useMemo, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { useDesk } from '../lib/desk';
import { addDays, can, downloadCSV, fmtDate, fmtDateTime, label, money } from '../lib/format';
import { Badge, Field, PageHead, Table, statusKind } from '../components/ui.jsx';
import { AUDIT_KIND } from '../lib/audit';

const m = (k, l) => ({ key: k, label: l ?? label(k), num: true, render: (r) => money(r[k]) });
const d = (k, l) => ({ key: k, label: l ?? label(k), render: (r) => fmtDate(r[k]) });
const stayCols = [
  { key: 'res_no', label: 'Res #', render: (r) => '#' + r.res_no },
  { key: 'guest', label: 'Guest' }, { key: 'phone', label: 'Phone' },
  { key: 'room', label: 'Room' }, { key: 'room_type', label: 'Type' },
  d('arrival'), d('departure'), { key: 'nights', label: 'Nights', num: true },
  { key: 'pax', label: 'Pax', render: (r) => `${r.adults}${r.children ? '+' + r.children : ''}` },
  { key: 'source', label: 'Source / company', render: (r) => r.company ?? r.source ?? '' },
  m('rate'),
  { key: 'status', label: 'Status', render: (r) => <Badge kind={statusKind(r.status)}>{label(r.status)}</Badge> },
];
const stays = (kind) => ({ p, from, to }) => rpc('pms_rpt_stays', { p_property: p, p_kind: kind, p_from: from, p_to: to });
const sumOf = (rows, keys) => Object.fromEntries(keys.map((k) => [k, money(rows.reduce((n, r) => n + Number(r[k] ?? 0), 0))]));

const REPORTS = [
  { group: 'Reservations', id: 'arrivals', priv: 'rpt.stays', label: 'Arrival list', range: true, load: stays('arrivals'), columns: stayCols, open: true },
  { group: 'Reservations', id: 'departures', priv: 'rpt.stays', label: 'Departure list', range: true, load: stays('departures'), columns: stayCols, open: true },
  { group: 'Reservations', id: 'cancelled', priv: 'rpt.stays', label: 'Cancelled reservations', range: true, load: stays('cancelled'), columns: stayCols, open: true },
  { group: 'Reservations', id: 'no_show', priv: 'rpt.stays', label: 'No-show reservations', range: true, load: stays('no_show'), columns: stayCols, open: true },
  { group: 'Reservations', id: 'activity', priv: 'rpt.stays', label: 'Reservation activity', range: true, load: stays('all'), columns: stayCols, open: true },
  { group: 'Front office', id: 'in_house', priv: 'rpt.stays', label: 'In-house guest list', load: stays('in_house'), open: true,
    columns: [...stayCols.slice(0, 11), { key: 'balance', label: 'Balance', num: true, render: (r) => money(r.balance) }],
    totals: (rows) => sumOf(rows, ['balance']) },
  { group: 'Front office', id: 'house_status', label: 'Room status', load: ({ p }) => rpc('pms_rpt_house_status', { p_property: p }),
    columns: [{ key: 'number', label: 'Room' }, { key: 'room_type', label: 'Type' },
      { key: 'hk_status', label: 'Housekeeping', render: (r) => <Badge kind={statusKind(r.hk_status)}>{label(r.hk_status)}</Badge> },
      { key: 'occupancy', label: 'Front office', render: (r) => label(r.occupancy) }, { key: 'guest', label: 'Guest' },
      d('departure'), { key: 'blocked_reason', label: 'Block' }] },
  { group: 'Back office', id: 'revenue', priv: 'rpt.daily_revenue', label: 'Daily revenue', range: true, money: true,
    load: ({ p, from, to }) => rpc('pms_rpt_daily_revenue', { p_property: p, p_from: from, p_to: to }),
    columns: [d('business_date', 'Date'), m('room'), m('tax'), m('fnb', 'Food & beverage'), m('other'), m('discounts'), m('total_revenue'), m('payments'), m('city_ledger'), m('expenses')],
    totals: (rows) => ({ business_date: 'Total', ...sumOf(rows, ['room', 'tax', 'fnb', 'other', 'discounts', 'total_revenue', 'payments', 'city_ledger', 'expenses']) }) },
  { group: 'Back office', id: 'receipts', priv: 'rpt.payments', label: 'Daily receipts', range: true, money: true,
    load: ({ p, from, to }) => rpc('pms_rpt_payments', { p_property: p, p_from: from, p_to: to }),
    columns: [{ key: 'posted_at', label: 'Time', render: (r) => fmtDateTime(r.posted_at) }, { key: 'folio_no', label: 'Folio' },
      { key: 'res_no', label: 'Res #' }, { key: 'guest', label: 'Guest' }, { key: 'method', label: 'Method', render: (r) => label(r.method) },
      { key: 'reference', label: 'Reference' }, { key: 'cashier', label: 'Cashier' },
      { key: 'amount', label: 'Amount', num: true, render: (r) => <span className={r.voided ? 'strike' : ''}>{money(r.amount)}</span> }],
    totals: (rows) => ({ posted_at: 'Total (excl. voids)', amount: money(rows.filter((r) => !r.voided).reduce((n, r) => n + Number(r.amount), 0)) }) },
  { group: 'Back office', id: 'cashier', priv: 'rpt.cashier', label: 'Cashier sales', range: true, money: true,
    load: ({ p, from, to }) => rpc('pms_rpt_cashier', { p_property: p, p_from: from, p_to: to }),
    columns: [{ key: 'cashier', label: 'Cashier' }, { key: 'method', label: 'Method', render: (r) => label(r.method) },
      { key: 'transactions', label: 'Txns', num: true }, m('receipts'), m('refunds'), m('net')],
    totals: (rows) => ({ cashier: 'Total', ...sumOf(rows, ['receipts', 'refunds', 'net']) }) },
  { group: 'Back office', id: 'ageing', priv: 'rpt.ageing', label: 'Ageing debtors', money: true,
    load: ({ p }) => rpc('pms_rpt_ageing', { p_property: p }),
    columns: [{ key: 'company', label: 'Company' }, { key: 'phone', label: 'Phone' }, m('balance'), m('d0_30', '0–30 days'), m('d31_60', '31–60'), m('d61_90', '61–90'), m('d90_plus', '90+'), m('credit_limit'), d('oldest_invoice')],
    totals: (rows) => ({ company: 'Total', ...sumOf(rows, ['balance', 'd0_30', 'd31_60', 'd61_90', 'd90_plus']) }) },
  { group: 'Back office', id: 'expenses', priv: 'frontoffice', label: 'Expense vouchers', range: true, money: true,
    load: async ({ p, from, to }) => (await supabase.from('pms_expense_vouchers').select('voucher_no,business_date,category,description,paid_to,payment_method,amount')
      .eq('property_id', p).gte('business_date', from).lte('business_date', to).order('business_date')).data ?? [],
    columns: [{ key: 'voucher_no', label: 'No.' }, d('business_date', 'Date'), { key: 'category', label: 'Category', render: (r) => label(r.category) },
      { key: 'description', label: 'Description' }, { key: 'paid_to', label: 'Paid to' }, { key: 'payment_method', label: 'Method', render: (r) => label(r.payment_method) }, m('amount')],
    totals: (rows) => ({ voucher_no: 'Total', ...sumOf(rows, ['amount']) }) },
  { group: 'Back office', id: 'pos', priv: 'rpt.pos_sales', label: 'POS sales by outlet', range: true, money: true,
    load: ({ p, from, to }) => rpc('pms_rpt_pos_sales', { p_property: p, p_from: from, p_to: to }),
    columns: [{ key: 'outlet', label: 'Outlet' }, { key: 'bills', label: 'Bills', num: true }, m('walk_in', 'Paid at outlet'), m('to_rooms', 'Charged to rooms'),
      m('discounts'), m('total'), m('cash', 'Cash taken'), { key: 'voided', label: 'Voided', num: true }],
    totals: (rows) => ({ outlet: 'Total', ...sumOf(rows, ['walk_in', 'to_rooms', 'discounts', 'total', 'cash']) }) },
  { group: 'Back office', id: 'activities', priv: 'rpt.activities', label: 'Activities and facilities', range: true, money: true,
    load: ({ p, from, to }) => rpc('pms_rpt_activities', { p_property: p, p_from: from, p_to: to }),
    columns: [{ key: 'outlet', label: 'Facility' }, { key: 'outlet_type', label: 'Type', render: (r) => label(r.outlet_type) },
      { key: 'bills', label: 'Bills', num: true }, m('revenue', 'Takings'), m('to_rooms', 'Charged to rooms'),
      { key: 'hours_sold', label: 'Hours sold', num: true }, { key: 'member_visits', label: 'Member visits', num: true },
      { key: 'resident_visits', label: 'Guest visits', num: true }, { key: 'walk_in_visits', label: 'Walk-ins', num: true },
      { key: 'new_memberships', label: 'New members', num: true }, { key: 'active_memberships', label: 'Active members', num: true }],
    totals: (rows) => ({ outlet: 'Total', ...sumOf(rows, ['revenue', 'to_rooms']) }) },
  { group: 'Back office', id: 'payment_methods', priv: 'rpt.payment_methods', label: 'Payments by method', range: true, money: true,
    load: ({ p, from, to }) => rpc('pms_rpt_payment_methods', { p_property: p, p_from: from, p_to: to }),
    columns: [{ key: 'method', label: 'Method' }, { key: 'kind', label: 'Kind', render: (r) => label(r.kind) }, { key: 'receipts', label: 'Receipts', num: true }, m('amount')],
    totals: (rows) => ({ method: 'Total', ...sumOf(rows, ['amount']) }) },
  { group: 'Back office', id: 'segments', priv: 'rpt.segments', label: 'Market segments', range: true, money: true,
    load: ({ p, from, to }) => rpc('pms_rpt_segments', { p_property: p, p_from: from, p_to: to }),
    columns: [{ key: 'segment', label: 'Segment' }, { key: 'bookings', label: 'Bookings', num: true }, { key: 'room_nights', label: 'Room nights', num: true }, m('room_revenue', 'Room revenue (booked rate)'), m('adr', 'Average rate')],
    totals: (rows) => ({ segment: 'Total', ...sumOf(rows, ['room_revenue']) }) },
  { group: 'Back office', id: 'commission', priv: 'rpt.commission', label: 'Agent commission', range: true, money: true,
    load: ({ p, from, to }) => rpc('pms_rpt_commission', { p_property: p, p_from: from, p_to: to }),
    columns: [{ key: 'party', label: 'Agent or source' }, { key: 'res_no', label: 'Res #' }, { key: 'guest', label: 'Guest' }, d('arrival'), d('departure'),
      m('room_revenue'), { key: 'commission_pct', label: '%', num: true }, m('commission'), { key: 'sales_person', label: 'Sales person' }],
    totals: (rows) => ({ party: 'Total', ...sumOf(rows, ['room_revenue', 'commission']) }) },
  { group: 'Stores', id: 'food_cost', priv: 'rpt.food_cost', label: 'Food and beverage cost', range: true, money: true,
    load: ({ p, from, to }) => rpc('pms_rpt_food_cost', { p_property: p, p_from: from, p_to: to }),
    columns: [{ key: 'outlet', label: 'Outlet' }, { key: 'menu_item', label: 'Menu item' }, { key: 'qty_sold', label: 'Sold', num: true },
      m('revenue', 'Sales'), m('recipe_cost', 'Recipe cost'), { key: 'cost_pct', label: 'Cost %', num: true, render: (r) => (r.cost_pct == null ? '' : `${r.cost_pct}%`) },
      { key: 'has_recipe', label: '', render: (r) => (r.has_recipe ? '' : 'No recipe') }],
    totals: (rows) => ({ outlet: 'Total', ...sumOf(rows, ['revenue', 'recipe_cost']) }) },
  { group: 'Stores', id: 'stock_usage', priv: 'rpt.stock', label: 'Stock usage and losses', range: true, money: true,
    load: ({ p, from, to }) => rpc('pms_rpt_stock_usage', { p_property: p, p_from: from, p_to: to }),
    columns: [{ key: 'item', label: 'Item' }, { key: 'unit', label: 'Unit' }, { key: 'opening', label: 'Opening', num: true }, { key: 'received', label: 'Received', num: true },
      { key: 'sold', label: 'Used by sales', num: true }, { key: 'wasted', label: 'Wasted', num: true }, { key: 'count_variance', label: 'Count difference', num: true },
      { key: 'closing', label: 'Closing', num: true }, m('loss_value', 'Losses')],
    totals: (rows) => ({ item: 'Total', ...sumOf(rows, ['loss_value']) }) },
  { group: 'Stores', id: 'purchases', priv: 'rpt.purchases', label: 'Purchases by supplier and item', range: true, money: true,
    load: ({ p, from, to }) => rpc('pms_rpt_purchases', { p_property: p, p_from: from, p_to: to }),
    columns: [{ key: 'supplier', label: 'Supplier' }, { key: 'item', label: 'Item' }, { key: 'unit', label: 'Unit' }, { key: 'qty', label: 'Quantity', num: true },
      { key: 'deliveries', label: 'Deliveries', num: true }, m('avg_unit_cost', 'Average cost'), m('value')],
    totals: (rows) => ({ supplier: 'Total', ...sumOf(rows, ['value']) }) },
  { group: 'Stores', id: 'creditors', priv: 'rpt.creditors', label: 'Ageing creditors (owed to suppliers)', money: true,
    load: ({ p }) => rpc('pms_rpt_creditors', { p_property: p, p_as_of: null }),
    columns: [{ key: 'supplier', label: 'Supplier' }, { key: 'invoices', label: 'Invoices', num: true }, m('balance'), m('not_due', 'Not due'), m('d1_30', '1–30 days'),
      m('d31_60', '31–60'), m('d61_90', '61–90'), m('d90_plus', '90+')],
    totals: (rows) => ({ supplier: 'Total', ...sumOf(rows, ['balance', 'not_due', 'd1_30', 'd31_60', 'd61_90', 'd90_plus']) }) },
  { group: 'Statistics', id: 'occupancy', priv: 'rpt.occupancy', label: 'Occupancy, ADR and RevPAR', range: true,
    load: ({ p, from, to }) => rpc('pms_rpt_occupancy', { p_property: p, p_from: from, p_to: to }),
    columns: [d('stay_date', 'Date'), { key: 'rooms_available', label: 'Available', num: true }, { key: 'rooms_sold', label: 'Sold', num: true },
      { key: 'occupancy_pct', label: 'Occupancy', num: true, render: (r) => <span className="occ-cell"><span className="occ-bar"><span style={{ width: r.occupancy_pct + '%' }} /></span>{r.occupancy_pct}%</span> },
      m('room_revenue'), m('adr', 'ADR'), m('revpar', 'RevPAR'), { key: 'is_forecast', label: '', render: (r) => (r.is_forecast ? <span className="muted small">forecast</span> : '') }],
    totals: (rows) => {
      const av = rows.reduce((n, r) => n + r.rooms_available, 0), so = rows.reduce((n, r) => n + r.rooms_sold, 0);
      const rev = rows.reduce((n, r) => n + Number(r.room_revenue), 0);
      return { stay_date: 'Period', rooms_available: av, rooms_sold: so, occupancy_pct: av ? (so * 100 / av).toFixed(1) + '%' : '0%',
        room_revenue: money(rev), adr: money(so ? rev / so : 0), revpar: money(av ? rev / av : 0) };
    } },
  { group: 'Statistics', id: 'sources', priv: 'rpt.stays', label: 'Business sources', range: true, money: true,
    load: async ({ p, from, to }) => {
      const rows = await rpc('pms_rpt_stays', { p_property: p, p_kind: 'all', p_from: from, p_to: to });
      const by = {};
      for (const r of rows.filter((x) => ['confirmed', 'tentative', 'checked_in', 'checked_out'].includes(x.status))) {
        const k = r.company ?? r.source ?? 'Unspecified';
        by[k] ??= { source: k, bookings: 0, room_nights: 0, revenue: 0 };
        by[k].bookings += 1; by[k].room_nights += r.nights; by[k].revenue += r.nights * Number(r.rate);
      }
      return Object.values(by).sort((a, b) => b.revenue - a.revenue);
    },
    columns: [{ key: 'source', label: 'Source / company' }, { key: 'bookings', label: 'Rooms', num: true }, { key: 'room_nights', label: 'Room nights', num: true },
      { key: 'revenue', label: 'Room revenue (at booked rate)', num: true, render: (r) => money(r.revenue) }],
    totals: (rows) => ({ source: 'Total', ...sumOf(rows, ['revenue']) }) },
  { group: 'Audit', id: 'occupancy_daily', priv: 'rpt.revenue_assurance', label: 'Occupancy audit: day by day', range: true, money: true,
    load: ({ p, from, to }) => rpc('pms_rpt_audit_daily', { p_property: p, p_from: from, p_to: to }),
    columns: [d('day', 'Day'), { key: 'rooms_occupied', label: 'Rooms sold', num: true }, { key: 'rooms_with_activity', label: 'Rooms used', num: true },
      { key: 'guests_in_house', label: 'Guests in house', num: true }, { key: 'arrivals', label: 'Arrived', num: true }, { key: 'entrance_people', label: 'People at entrance', num: true },
      { key: 'people_in_rooms', label: 'People at room doors', num: true }, { key: 'guest_door_opens', label: 'Guest door openings', num: true },
      { key: 'findings', label: 'Findings', num: true }, { key: 'high', label: 'High', num: true }, { key: 'open_findings', label: 'Open', num: true }, m('amount_at_risk', 'At risk')],
    totals: (rows) => ({ day: 'Total', ...sumOf(rows, ['findings', 'high', 'open_findings', 'amount_at_risk']) }) },
  { group: 'Audit', id: 'occupancy_summary', priv: 'rpt.revenue_assurance', label: 'Occupancy audit: findings and outcomes', range: true, money: true,
    load: ({ p, from, to }) => rpc('pms_rpt_audit_summary', { p_property: p, p_from: from, p_to: to }),
    columns: [{ key: 'kind', label: 'Finding', render: (r) => AUDIT_KIND[r.kind]?.[0] ?? r.kind }, { key: 'severity', label: 'Severity' }, { key: 'found', label: 'Found', num: true },
      { key: 'open', label: 'Open', num: true }, { key: 'explained', label: 'Explained', num: true }, { key: 'charged', label: 'Charged', num: true },
      { key: 'loss', label: 'Loss', num: true }, { key: 'false_alarm', label: 'False alarm', num: true }, m('amount_open', 'Open at risk'), m('amount_lost', 'Lost')],
    totals: (rows) => ({ kind: 'Total', ...sumOf(rows, ['found', 'open', 'explained', 'charged', 'loss', 'false_alarm', 'amount_open', 'amount_lost']) }) },
  { group: 'Audit', id: 'voids', priv: 'rpt.voids', label: 'Voids', range: true,
    load: ({ p, from, to }) => rpc('pms_rpt_voids', { p_property: p, p_from: from, p_to: to }),
    columns: [{ key: 'voided_at', label: 'When', render: (r) => fmtDateTime(r.voided_at) }, { key: 'folio_no', label: 'Folio' },
      { key: 'description', label: 'Posting' }, m('amount'), { key: 'reason', label: 'Reason' }, { key: 'voided_by', label: 'By' }] },
  { group: 'Audit', id: 'trail', priv: 'rpt.audit_trail', label: 'Audit trail', range: true,
    load: ({ p, from, to }) => rpc('pms_rpt_audit_trail', { p_property: p, p_from: from, p_to: to }),
    columns: [{ key: 'at', label: 'When', render: (r) => fmtDateTime(r.at) }, { key: 'user_name', label: 'User' },
      { key: 'action', label: 'Action' }, { key: 'details', label: 'Details', render: (r) => <code className="small">{r.details ? JSON.stringify(r.details) : ''}</code> }] },
];

export default function Reports({ params }) {
  const { property, role } = useProperty();
  const desk = useDesk();
  const available = REPORTS.filter((r) => !r.priv || can(role, r.priv)); // each report is its own ability (Setup → Team)
  const [id, setId] = useState(params?.r ?? available[0]?.id);
  const [from, setFrom] = useState(property.business_date);
  const [to, setTo] = useState(property.business_date);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const rep = available.find((r) => r.id === id) ?? available[0];

  useEffect(() => {
    if (!rep) return;
    let live = true;
    setRows(null); setError(null);
    rep.load({ p: property.id, from, to })
      .then((r) => live && setRows(r ?? []))
      .catch((e) => { if (live) { setError(e.message); setRows([]); } });
    return () => { live = false; };
  }, [rep, property.id, from, to]);

  const groups = useMemo(() => [...new Set(available.map((r) => r.group))], [available]);
  const preset = (a, b) => { setFrom(a); setTo(b); };
  const bd = property.business_date;
  const prev = addDays(bd, -1);

  if (!rep) return <p>No reports available for your role.</p>;
  return (
    <div className="reports">
      <aside className="report-list">
        {groups.map((g) => (
          <div key={g}>
            <div className="nav-group dark">{g}</div>
            {available.filter((r) => r.group === g).map((r) => (
              <button key={r.id} className={`report-link ${r.id === rep.id ? 'active' : ''}`} onClick={() => setId(r.id)}>{r.label}</button>
            ))}
          </div>
        ))}
      </aside>
      <section className="report-body">
        <PageHead title={rep.label} sub={rep.range ? `${fmtDate(from)} – ${fmtDate(to)}` : `As at ${fmtDate(bd)}`}>
          <button className="btn" onClick={() => downloadCSV(`${rep.id}-${from}-${to}.csv`, rows)} disabled={!rows?.length}>Export CSV</button>
          <button className="btn" onClick={() => window.print()}>Print</button>
        </PageHead>
        {rep.range && (
          <div className="filters">
            <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
            <div className="presets">
              <button className="chip" onClick={() => preset(bd, bd)}>Today</button>
              <button className="chip" onClick={() => preset(prev, prev)}>Yesterday</button>
              <button className="chip" onClick={() => preset(addDays(bd, -6), bd)}>Last 7 days</button>
              <button className="chip" onClick={() => preset(bd.slice(0, 8) + '01', bd)}>Month to date</button>
              <button className="chip" onClick={() => preset(bd, addDays(bd, 13))}>Next 14 days</button>
            </div>
          </div>
        )}
        {error && <div className="note danger">{error}</div>}
        <Table rows={rows} columns={rep.columns} empty="No data for this period"
          onRow={rep.open ? (r) => desk.openReservation(r.reservation_id) : undefined}
          footer={rows?.length && rep.totals ? rep.totals(rows) : undefined} />
        {rep.money && <p className="muted small">Amounts in {property.currency}. {property.tax_inclusive ? `Room revenue includes ${property.tax_rate}% VAT.` : ''}</p>}
      </section>
    </div>
  );
}
