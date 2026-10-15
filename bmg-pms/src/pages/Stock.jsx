import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { can, fmtDate, fmtDateTime, money } from '../lib/format';
import { Badge, Field, Loading, PageHead, Table, Tabs, useAction } from '../components/ui.jsx';
import { EditableList } from './Setup.jsx';

const qty = (n) => Number(n).toLocaleString('en-GB', { maximumFractionDigits: 3 });
const KIND = { opening: 'Opening stock', receive: 'Received', transfer_in: 'Issued in', transfer_out: 'Issued out', sale: 'Sold', sale_reversal: 'Sale voided', waste: 'Wasted', count: 'Count adjustment' };

// Shared lists: stock items and locations
function useStockLists() {
  const { property } = useProperty();
  const [items, setItems] = useState(null);
  const [locations, setLocations] = useState(null);
  const load = useCallback(async () => {
    const [i, l] = await Promise.all([
      supabase.from('pms_stock_items').select('*').eq('property_id', property.id).order('name'),
      supabase.from('pms_stock_locations').select('*').eq('property_id', property.id).order('name'),
    ]);
    setItems(i.data ?? []); setLocations(l.data ?? []);
  }, [property.id]);
  useEffect(() => { load(); }, [load]);
  return { items, locations, reload: load };
}

export default function Stock({ params }) {
  const { role } = useProperty();
  const [tab, setTab] = useState(params?.tab ?? 'levels');
  const lists = useStockLists();
  if (!can(role, 'stock') && !can(role, 'recipes')) return <><PageHead title="Kitchen and bar stock" /><p>Only managers, accountants and storekeepers use stock.</p></>;
  const ready = lists.items && lists.locations;
  const empty = ready && (!lists.items.length || !lists.locations.length);
  return (
    <>
      <PageHead title="Kitchen and bar stock" sub="Ingredients and drinks by store, kitchen and bar. Paid and room-charged POS bills take their recipe out of the outlet's stock by themselves." />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'levels', label: 'Stock levels' }, { value: 'receive', label: 'Receive' }, { value: 'issue', label: 'Issue' },
        { value: 'waste', label: 'Waste' }, { value: 'count', label: 'Stock count' }, { value: 'recipes', label: 'Recipes' },
        { value: 'moves', label: 'Movements' }, { value: 'setup', label: 'Items and locations' }]} />
      {!ready && <Loading />}
      {ready && empty && tab !== 'setup' && <div className="empty">Add stock items and locations first. <button className="link" onClick={() => setTab('setup')}>Items and locations</button></div>}
      {ready && !empty && tab === 'levels' && <Levels />}
      {ready && !empty && tab === 'receive' && <Receive {...lists} />}
      {ready && !empty && tab === 'issue' && <Issue {...lists} />}
      {ready && !empty && tab === 'waste' && <Waste {...lists} />}
      {ready && !empty && tab === 'count' && <Count {...lists} />}
      {ready && !empty && tab === 'recipes' && <Recipes {...lists} />}
      {ready && !empty && tab === 'moves' && <Moves {...lists} />}
      {ready && tab === 'setup' && <SetupLists {...lists} />}
    </>
  );
}

function Levels() {
  const { property } = useProperty();
  const [rows, setRows] = useState(null);
  const [lowOnly, setLowOnly] = useState(false);
  useEffect(() => { rpc('pms_rpt_stock_levels', { p_property: property.id }).then(setRows).catch(() => setRows([])); }, [property.id]);
  const { locs, items } = useMemo(() => {
    const locs = [...new Map((rows ?? []).map((r) => [r.location_id, r.location])).entries()];
    const items = [...new Map((rows ?? []).map((r) => [r.item_id, r])).values()].filter((r) => !lowOnly || r.low);
    return { locs, items };
  }, [rows, lowOnly]);
  if (!rows) return <Loading />;
  const at = (item, loc) => rows.find((r) => r.item_id === item && r.location_id === loc)?.qty ?? 0;
  const value = rows.reduce((n, r) => n + Number(r.value), 0);
  const lowCount = new Set(rows.filter((r) => r.low).map((r) => r.item_id)).size;
  return (
    <>
      <dl className="today-stats compact">
        <div><dt>Stock value</dt><dd className="money">{money(value)}</dd></div>
        <div><dt>Items at or below reorder level</dt><dd className={lowCount ? 'danger' : ''}>{lowCount}</dd></div>
      </dl>
      <label className="check" style={{ margin: '0 0 12px' }}><input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} /> Only items to reorder</label>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Item</th>{locs.map(([id, name]) => <th key={id} className="num">{name}</th>)}<th className="num">Total</th><th className="num">Reorder at</th><th className="num">Value</th><th /></tr></thead>
          <tbody>
            {items.map((r) => (
              <tr key={r.item_id}>
                <td><strong>{r.item}</strong> <span className="muted small">{r.unit}{r.category ? ` · ${r.category}` : ''}</span></td>
                {locs.map(([id]) => { const q = Number(at(r.item_id, id)); return <td key={id} className={`num ${q < 0 ? 'danger' : q === 0 ? 'muted' : ''}`}>{qty(q)}</td>; })}
                <td className="num"><strong>{qty(r.total_qty)}</strong></td>
                <td className="num muted">{Number(r.reorder_level) ? qty(r.reorder_level) : '—'}</td>
                <td className="num">{money(rows.filter((x) => x.item_id === r.item_id).reduce((n, x) => n + Number(x.value), 0))}</td>
                <td>{r.low && <Badge kind="red">Reorder</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted">A figure below zero means sales used more than was issued to that location: issue stock or count it.</p>
    </>
  );
}

const ItemSelect = ({ items, value, onChange }) => (
  <select required value={value} onChange={onChange}><option value="">Choose…</option>{items.filter((i) => i.active).map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}</select>
);
const LocSelect = ({ locations, value, onChange, exclude }) => (
  <select required value={value} onChange={onChange}><option value="">Choose…</option>{locations.filter((l) => l.active && l.id !== exclude).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
);
const numIn = (setF, f, k) => (e) => setF({ ...f, [k]: e.target.value.replace(/[^\d.]/g, '') });

function Receive({ items, locations, reload }) {
  const { property } = useProperty();
  const [run, busy] = useAction();
  const blank = { location: locations.find((l) => l.kind === 'store')?.id ?? '', item: '', qty: '', cost: '', supplier: '', reference: '', opening: false };
  const [f, setF] = useState(blank);
  const it = items.find((i) => i.id === f.item);
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); run(() => rpc('pms_receive_stock', { p_location: f.location, p_item: f.item, p_qty: Number(f.qty), p_unit_cost: Number(f.cost), p_supplier: f.supplier || null, p_reference: f.reference || null, p_opening: f.opening }), `${f.qty} ${it?.unit} of ${it?.name} received`).then(() => { setF({ ...blank, location: f.location, supplier: f.supplier, reference: f.reference }); reload(); }).catch(() => {}); }}>
      <div className="grid-3">
        <Field label="Into"><LocSelect locations={locations} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
        <Field label="Item"><ItemSelect items={items} value={f.item} onChange={(e) => setF({ ...f, item: e.target.value })} /></Field>
        <Field label={`Quantity${it ? ` (${it.unit})` : ''}`}><input required inputMode="decimal" value={f.qty} onChange={numIn(setF, f, 'qty')} /></Field>
        <Field label={`Cost per ${it?.unit ?? 'unit'} (${property.currency})`} hint={it && f.qty && f.cost ? `Total ${money(Number(f.qty) * Number(f.cost))}. Average now ${money(it.avg_cost)}.` : undefined}>
          <input required inputMode="decimal" value={f.cost} onChange={numIn(setF, f, 'cost')} /></Field>
        <Field label="Supplier"><input value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })} /></Field>
        <Field label="Delivery note or invoice"><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
      </div>
      <div className="row-gap">
        <button className="btn btn-primary" disabled={busy}>Receive</button>
        <label className="check small"><input type="checkbox" checked={f.opening} onChange={(e) => setF({ ...f, opening: e.target.checked })} /> Opening stock (first day only)</label>
      </div>
    </form>
  );
}

function Issue({ items, locations, reload }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ from: locations.find((l) => l.kind === 'store')?.id ?? '', to: locations.find((l) => l.kind === 'kitchen')?.id ?? '', item: '', qty: '', note: '' });
  const [have, setHave] = useState(null);
  useEffect(() => {
    if (!f.item || !f.from) { setHave(null); return; }
    supabase.from('pms_stock_levels').select('qty').eq('item_id', f.item).eq('location_id', f.from).maybeSingle().then(({ data }) => setHave(Number(data?.qty ?? 0)));
  }, [f.item, f.from]);
  const it = items.find((i) => i.id === f.item);
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); run(() => rpc('pms_transfer_stock', { p_from: f.from, p_to: f.to, p_item: f.item, p_qty: Number(f.qty), p_note: f.note || null }), `${f.qty} ${it?.unit} of ${it?.name} issued`).then(() => { setF({ ...f, item: '', qty: '' }); reload(); }).catch(() => {}); }}>
      <div className="grid-3">
        <Field label="From"><LocSelect locations={locations} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="To"><LocSelect locations={locations} value={f.to} exclude={f.from} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <Field label="Item" hint={have !== null && it ? `${qty(have)} ${it.unit} there now` : undefined}><ItemSelect items={items} value={f.item} onChange={(e) => setF({ ...f, item: e.target.value })} /></Field>
        <Field label={`Quantity${it ? ` (${it.unit})` : ''}`}><input required inputMode="decimal" value={f.qty} onChange={numIn(setF, f, 'qty')} /></Field>
        <Field label="Note" span={2}><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. Requisition 112 from the chef" /></Field>
      </div>
      <button className="btn btn-primary" disabled={busy}>Issue</button>
    </form>
  );
}

function Waste({ items, locations, reload }) {
  const [run, busy] = useAction();
  const [f, setF] = useState({ location: locations.find((l) => l.kind === 'kitchen')?.id ?? '', item: '', qty: '', reason: '' });
  const it = items.find((i) => i.id === f.item);
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); run(() => rpc('pms_record_waste', { p_location: f.location, p_item: f.item, p_qty: Number(f.qty), p_reason: f.reason }), 'Waste recorded').then(() => { setF({ ...f, item: '', qty: '', reason: '' }); reload(); }).catch(() => {}); }}>
      <div className="grid-3">
        <Field label="Where"><LocSelect locations={locations} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} /></Field>
        <Field label="Item"><ItemSelect items={items} value={f.item} onChange={(e) => setF({ ...f, item: e.target.value })} /></Field>
        <Field label={`Quantity${it ? ` (${it.unit})` : ''}`} hint={it && f.qty ? `Worth ${money(Number(f.qty) * Number(it.avg_cost))}` : undefined}><input required inputMode="decimal" value={f.qty} onChange={numIn(setF, f, 'qty')} /></Field>
        <Field label="Why" span={3}><input required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Expired, burnt, dropped, returned by guest…" /></Field>
      </div>
      <button className="btn btn-primary" disabled={busy}>Record waste</button>
    </form>
  );
}

function Count({ items, locations, reload }) {
  const [run, busy] = useAction();
  const [loc, setLoc] = useState(locations[0]?.id ?? '');
  const [levels, setLevels] = useState({});
  const [counts, setCounts] = useState({});
  const [result, setResult] = useState(null);
  useEffect(() => {
    setResult(null); setCounts({});
    if (loc) supabase.from('pms_stock_levels').select('item_id, qty').eq('location_id', loc).then(({ data }) => setLevels(Object.fromEntries((data ?? []).map((r) => [r.item_id, Number(r.qty)]))));
  }, [loc]);
  const active = items.filter((i) => i.active);
  const submit = () => run(async () => {
    const rows = await rpc('pms_stock_count', { p_location: loc, p_counts: Object.entries(counts).filter(([, v]) => v !== '').map(([item_id, counted]) => ({ item_id, counted: Number(counted) })), p_note: null });
    setResult(rows); reload();
  }, 'Count saved; stock now matches the shelf').catch(() => {});
  if (result) {
    const total = result.reduce((n, r) => n + Number(r.variance_value), 0);
    return (
      <>
        <Table rows={result} empty="Nothing counted." footer={{ item: 'Variance value', variance_value: money(total) }} columns={[
          { key: 'item', label: 'Item' }, { key: 'expected', label: 'System had', num: true, render: (r) => `${qty(r.expected)} ${r.unit}` },
          { key: 'counted', label: 'Counted', num: true, render: (r) => `${qty(r.counted)} ${r.unit}` },
          { key: 'variance', label: 'Difference', num: true, render: (r) => <span className={Number(r.variance) < 0 ? 'danger' : ''}>{Number(r.variance) > 0 ? '+' : ''}{qty(r.variance)}</span> },
          { key: 'variance_value', label: 'Value', num: true, render: (r) => money(r.variance_value) }]} />
        <button className="btn" onClick={() => setResult(null)}>Count again</button>
      </>
    );
  }
  return (
    <>
      <div className="row-gap" style={{ marginBottom: 12 }}>
        <Field label="Location"><LocSelect locations={locations} value={loc} onChange={(e) => setLoc(e.target.value)} /></Field>
        <p className="small muted" style={{ alignSelf: 'end' }}>Count what is on the shelf and type it in. Leave blank anything you did not count.</p>
      </div>
      <div className="table-wrap">
        <table className="table count-table">
          <thead><tr><th>Item</th><th className="num">System has</th><th className="num">Counted</th><th className="num">Difference</th></tr></thead>
          <tbody>{active.map((i) => {
            const c = counts[i.id] ?? ''; const sys = levels[i.id] ?? 0; const diff = c === '' ? null : Number(c) - sys;
            return (
              <tr key={i.id}>
                <td><strong>{i.name}</strong> <span className="muted small">{i.unit}</span></td>
                <td className="num">{qty(sys)}</td>
                <td className="num"><input className="num" inputMode="decimal" value={c} onChange={(e) => setCounts({ ...counts, [i.id]: e.target.value.replace(/[^\d.]/g, '') })} aria-label={`Counted ${i.name}`} /></td>
                <td className={`num ${diff < 0 ? 'danger' : ''}`}>{diff === null ? '' : `${diff > 0 ? '+' : ''}${qty(diff)} · ${money(diff * Number(i.avg_cost))}`}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      <button className="btn btn-primary" disabled={busy || !Object.values(counts).some((v) => v !== '')} onClick={submit}>Save count</button>
    </>
  );
}

function Recipes({ items }) {
  const { property, role } = useProperty();
  const [run, busy] = useAction();
  const [outlets, setOutlets] = useState([]);
  const [outlet, setOutlet] = useState('');
  const [menu, setMenu] = useState([]);
  const [lines, setLines] = useState([]);
  const [sel, setSel] = useState(null);
  const [draft, setDraft] = useState([]);
  useEffect(() => {
    supabase.from('pms_pos_outlets').select('id, name, stock_location_id, pms_stock_locations(name)').eq('property_id', property.id).eq('active', true).order('name')
      .then(({ data }) => { setOutlets(data ?? []); setOutlet((o) => o || data?.[0]?.id || ''); });
  }, [property.id]);
  const load = useCallback(async () => {
    if (!outlet) return;
    const { data: m } = await supabase.from('pms_pos_items').select('id, name, group_name, price').eq('outlet_id', outlet).eq('active', true).order('group_name').order('name');
    setMenu(m ?? []);
    const { data: l } = await supabase.from('pms_recipe_lines').select('*').in('pos_item_id', (m ?? []).map((x) => x.id));
    setLines(l ?? []);
  }, [outlet]);
  useEffect(() => { load(); }, [load]);
  const cost = (rows) => rows.reduce((n, r) => n + Number(r.qty || 0) * Number(items.find((i) => i.id === r.stock_item_id)?.avg_cost ?? 0), 0);
  const o = outlets.find((x) => x.id === outlet);
  const edit = (m) => { setSel(m); setDraft(lines.filter((l) => l.pos_item_id === m.id).map((l) => ({ stock_item_id: l.stock_item_id, qty: String(l.qty) }))); };
  const editable = can(role, 'recipes');
  return (
    <div className="two-col">
      <div>
        <div className="row-gap" style={{ marginBottom: 10 }}>
          <select className="auto" value={outlet} onChange={(e) => { setOutlet(e.target.value); setSel(null); }}>{outlets.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
          <span className="small muted">{o?.stock_location_id ? `Takes stock from ${o.pms_stock_locations?.name}` : 'No stock location: set one under Point of sale → Outlets and menu'}</span>
        </div>
        <Table rows={menu} empty="No menu items for this outlet." onRow={editable ? edit : undefined} columns={[
          { key: 'name', label: 'Menu item', render: (m) => <strong>{m.name}</strong> },
          { key: 'price', label: 'Price', num: true, render: (m) => money(m.price) },
          { key: 'cost', label: 'Recipe cost', num: true, render: (m) => { const r = lines.filter((l) => l.pos_item_id === m.id); return r.length ? money(cost(r)) : <Badge kind="amber">No recipe</Badge>; } },
          { key: 'pct', label: 'Cost %', num: true, render: (m) => { const r = lines.filter((l) => l.pos_item_id === m.id); return r.length && Number(m.price) ? `${Math.round((cost(r) * 100) / Number(m.price))}%` : ''; } },
        ]} />
      </div>
      {sel && (
        <div className="card">
          <h3 className="first">{sel.name}</h3>
          <p className="small muted">What one portion uses. It comes out of stock each time the dish is paid for or charged to a room.</p>
          {draft.map((d, i) => {
            const it = items.find((x) => x.id === d.stock_item_id);
            return (
              <div key={i} className="recipe-row">
                <ItemSelect items={items} value={d.stock_item_id} onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, stock_item_id: e.target.value } : x)))} />
                <input className="num" inputMode="decimal" value={d.qty} placeholder="Qty" onChange={(e) => setDraft(draft.map((x, j) => (j === i ? { ...x, qty: e.target.value.replace(/[^\d.]/g, '') } : x)))} aria-label="Quantity" />
                <span className="small muted">{it?.unit ?? ''}</span>
                <button className="link danger" onClick={() => setDraft(draft.filter((_, j) => j !== i))}>Remove</button>
              </div>
            );
          })}
          <button className="btn btn-ghost" onClick={() => setDraft([...draft, { stock_item_id: '', qty: '' }])}>+ Ingredient</button>
          <p className="small">Cost per portion <strong>{money(cost(draft))}</strong>{Number(sel.price) ? ` · ${Math.round((cost(draft) * 100) / Number(sel.price))}% of the ${money(sel.price)} price` : ''}</p>
          <div className="row-gap">
            <button className="btn btn-primary" disabled={busy} onClick={() => run(() => rpc('pms_set_recipe', { p_pos_item: sel.id, p_lines: draft.filter((d) => d.stock_item_id && Number(d.qty) > 0).map((d) => ({ stock_item_id: d.stock_item_id, qty: Number(d.qty) })) }), 'Recipe saved').then(() => { setSel(null); load(); }).catch(() => {})}>Save recipe</button>
            <button className="btn" onClick={() => setSel(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

function Moves({ items }) {
  const { property } = useProperty();
  const [item, setItem] = useState('');
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let q = supabase.from('pms_stock_moves').select('*, pms_stock_items(name, unit), pms_stock_locations(name)').eq('property_id', property.id).order('id', { ascending: false }).limit(300);
    if (item) q = q.eq('item_id', item);
    q.then(({ data }) => setRows(data ?? []));
  }, [property.id, item]);
  return (
    <>
      <div className="row-gap" style={{ marginBottom: 12 }}>
        <select className="auto" value={item} onChange={(e) => setItem(e.target.value)}><option value="">All items</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
      </div>
      <Table rows={rows} empty="No movements yet." columns={[
        { key: 'business_date', label: 'Day', render: (m) => fmtDate(m.business_date) },
        { key: 'kind', label: 'What', render: (m) => KIND[m.kind] ?? m.kind },
        { key: 'item', label: 'Item', render: (m) => m.pms_stock_items?.name },
        { key: 'loc', label: 'Where', render: (m) => m.pms_stock_locations?.name },
        { key: 'qty', label: 'Quantity', num: true, render: (m) => <span className={Number(m.qty) < 0 ? 'danger' : ''}>{Number(m.qty) > 0 ? '+' : ''}{qty(m.qty)} {m.pms_stock_items?.unit}</span> },
        { key: 'value', label: 'Value', num: true, render: (m) => money(m.value) },
        { key: 'ref', label: 'Details', render: (m) => <span className="small muted">{[m.reference, m.supplier, m.note].filter(Boolean).join(' · ')}</span> },
        { key: 'at', label: 'Entered', render: (m) => <span className="small muted">{fmtDateTime(m.created_at)}</span> },
      ]} />
    </>
  );
}

function SetupLists({ items, locations, reload }) {
  const { property } = useProperty();
  const [suppliers, setSuppliers] = useState([]);
  useEffect(() => { supabase.from('pms_suppliers').select('id, name').eq('property_id', property.id).eq('active', true).order('name').then(({ data }) => setSuppliers(data ?? [])); }, [property.id]);
  return (
    <>
      <h3 className="first">Locations</h3>
      <p className="small muted">Usually a main store, the kitchen and each bar. Tell each POS outlet which location it takes stock from under Point of sale → Outlets and menu.</p>
      <EditableList table="pms_stock_locations" rows={locations} onSaved={reload} blank={{ name: '', kind: 'kitchen', active: true }}
        fields={[{ key: 'name', label: 'Location' }, { key: 'kind', label: 'Kind', options: [['store', 'Store'], ['kitchen', 'Kitchen'], ['bar', 'Bar'], ['activity', 'Activity (gym, spa, pool)'], ['housekeeping', 'Housekeeping'], ['other', 'Other']] }, { key: 'active', label: 'Active', type: 'bool' }]} />
      <h3>Items</h3>
      <p className="small muted">Average cost is worked out from deliveries; it cannot be typed in. Purchase unit and units per purchase let you order by the case and count by the bottle.</p>
      <EditableList table="pms_stock_items" rows={items} onSaved={reload} blank={{ name: '', sku: '', unit: 'kg', category: '', reorder_level: 0, purchase_unit: '', units_per_purchase: 1, default_supplier_id: null, active: true }}
        fields={[{ key: 'name', label: 'Item' }, { key: 'unit', label: 'Unit', options: [['kg', 'kg'], ['g', 'g'], ['l', 'litre'], ['ml', 'ml'], ['pcs', 'piece'], ['btl', 'bottle'], ['can', 'can'], ['pkt', 'packet'], ['tray', 'tray']] },
          { key: 'sku', label: 'Code' }, { key: 'category', label: 'Category' }, { key: 'reorder_level', label: 'Reorder at', type: 'number' },
          { key: 'purchase_unit', label: 'Bought as' }, { key: 'units_per_purchase', label: 'Units each', type: 'number' },
          { key: 'default_supplier_id', label: 'Usual supplier', options: [['', '—'], ...suppliers.map((x) => [x.id, x.name])] }, { key: 'active', label: 'Active', type: 'bool' }]} />
    </>
  );
}
