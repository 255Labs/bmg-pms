import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { can, fmtDate, fmtDateTime, label, money, safeTerm } from '../lib/format';
import { Badge, Field, Loading, Modal, PageHead, Table, Tabs, useAction } from '../components/ui.jsx';
import { EditableList } from './Setup.jsx';
import PosArt from '../components/PosArt.jsx';
import Icon from '../components/icons.jsx';

const METHODS = [['cash', 'Cash'], ['mobile_money', 'Mobile money'], ['card', 'Card'], ['bank', 'Bank transfer'], ['other', 'Other']];
const STATUS = { open: ['Open', 'amber'], settled: ['Paid', 'teal'], room: ['Charged to room', 'blue'], void: ['Void', 'grey'] };
export const OUTLET_TYPES = [['restaurant', 'Restaurant'], ['bar', 'Bar'], ['cafe', 'Café'], ['room_service', 'Room service'], ['minibar', 'Minibar'],
  ['laundry', 'Laundry'], ['gym', 'Gym'], ['pool', 'Swimming pool'], ['games', 'Games room'], ['spa', 'Spa and salon'], ['tours', 'Tours and excursions'],
  ['events', 'Events and halls'], ['transport', 'Transport'], ['shop', 'Shop'], ['other', 'Other']];
const DEPARTMENTS = [['fnb', 'Food and beverage'], ['recreation', 'Recreation (gym, pool, games)'], ['spa', 'Spa'], ['tours', 'Tours'], ['events', 'Events'],
  ['laundry', 'Laundry'], ['minibar', 'Minibar'], ['transport', 'Transport'], ['other', 'Other']];
const ITEM_TYPES = [['product', 'Product'], ['service', 'Service'], ['timed', 'By the clock'], ['membership', 'Membership or pass']];
const ACTIVITY = new Set(['gym', 'pool', 'games', 'spa', 'tours', 'events']);
const KST = { new: 'Not sent', sent: 'Sent', preparing: 'Cooking', ready: 'Ready', served: 'Served', void: 'Void' };
const mins = (from) => Math.max(0, Math.floor((Date.now() - new Date(from).getTime()) / 60000));
const clock = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
const estimate = (line, item) => {
  if (!item) return Number(line.amount);
  const blocks = Math.max(Number(item.min_units), Math.ceil(Math.max(mins(line.started_at) - item.grace_minutes, 0) / item.duration_minutes));
  return blocks * Number(line.price);
};

export default function Pos() {
  const { role } = useProperty();
  const [tab, setTab] = useState(can(role, 'pos') ? 'sell' : 'door');
  return (
    <>
      <PageHead title="Point of sale" sub="Restaurant, bar, gym, pool, games room, spa and tours. Charge in-house guests to their room or take payment at the outlet." />
      <Tabs value={tab} onChange={setTab} tabs={[...(can(role, 'pos') ? [{ value: 'sell', label: 'Sell' }, { value: 'bills', label: "Today's bills" }] : []),
        ...(can(role, 'door') ? [{ value: 'door', label: 'Door and members' }] : []),
        ...(can(role, 'setup') || can(role, 'menu') ? [{ value: 'menu', label: 'Outlets and menu' }] : [])]} />
      {tab === 'sell' && can(role, 'pos') && <Sell />}
      {tab === 'bills' && can(role, 'pos') && <Bills />}
      {(tab === 'door' || (!can(role, 'pos') && tab !== 'menu')) && can(role, 'door') && <Door />}
      {tab === 'menu' && <MenuSetup />}
    </>
  );
}

function Sell() {
  const { property, role } = useProperty();
  const [run, busy] = useAction();
  const [outlets, setOutlets] = useState(null);
  const [outlet, setOutlet] = useState('');
  const [items, setItems] = useState([]);
  const [openBills, setOpenBills] = useState([]);
  const [billId, setBillId] = useState(null);
  const [bill, setBill] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [q, setQ] = useState('');
  const [running, setRunning] = useState([]);
  const [, tick] = useState(0);
  const [pick, setPick] = useState(null);      // { kind: 'timer' | 'member' | 'guest', item }
  const [splitting, setSplitting] = useState(false);
  const [splitIds, setSplitIds] = useState([]);
  const [cats, setCats] = useState([]);
  const [options, setOptions] = useState({});
  const [floor, setFloor] = useState([]);
  const [view, setView] = useState('menu');
  const [tickets, setTickets] = useState(null);
  const [payments, setPayments] = useState([]);

  useEffect(() => {
    supabase.from('pms_pos_outlets').select('*').eq('property_id', property.id).eq('active', true).order('name')
      .then(({ data }) => {
        setOutlets(data ?? []);
        if (!data?.length) return;
        // reopen the outlet this till used last, so a bar till stays on the bar
        let last = null;
        try { last = localStorage.getItem(`pms.pos.outlet.${property.id}`); } catch { /* storage unavailable */ }
        setOutlet((o) => o || (data.some((x) => x.id === last) ? last : data[0].id));
      });
  }, [property.id]);
  useEffect(() => {
    if (outlet) try { localStorage.setItem(`pms.pos.outlet.${property.id}`, outlet); } catch { /* storage unavailable */ }
  }, [outlet, property.id]);

  const here = outlets?.find((o) => o.id === outlet);
  useEffect(() => { setView(here?.uses_tables ? 'floor' : 'menu'); }, [here?.id, here?.uses_tables]);
  const loadOutlet = useCallback(async () => {
    if (!outlet) return;
    const [it, ob, cats, links, mgs] = await Promise.all([
      supabase.from('pms_pos_items').select('*').eq('outlet_id', outlet).eq('active', true).order('group_name').order('sort_order').order('name'),
      supabase.from('pms_pos_bills').select('*').eq('outlet_id', outlet).eq('status', 'open').order('bill_no'),
      supabase.from('pms_pos_categories').select('*').eq('outlet_id', outlet).eq('active', true).order('sort_order').order('name'),
      supabase.from('pms_pos_item_modifier_groups').select('item_id, group_id, sort_order').eq('property_id', property.id),
      supabase.from('pms_pos_modifier_groups').select('*, pms_pos_modifiers(*)').eq('outlet_id', outlet).eq('active', true),
    ]);
    setItems(it.data ?? []);
    setOpenBills(ob.data ?? []);
    setCats(cats.data ?? []);
    const groupsById = Object.fromEntries((mgs.data ?? []).map((g) => [g.id, { ...g, mods: (g.pms_pos_modifiers ?? []).filter((m) => m.active).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)) }]));
    const byItem = {};
    for (const l of (links.data ?? []).sort((a, b) => a.sort_order - b.sort_order)) if (groupsById[l.group_id]) (byItem[l.item_id] ??= []).push(groupsById[l.group_id]);
    setOptions(byItem);
    if (here?.uses_tables) rpc('pms_pos_floor', { p_outlet: outlet }).then(setFloor).catch(() => setFloor([]));
    rpc('pms_pos_running', { p_property: property.id }).then((r) => setRunning(r ?? [])).catch(() => setRunning([]));
  }, [outlet, property.id, here?.uses_tables]);
  useEffect(() => { loadOutlet(); }, [loadOutlet]);
  // clocks on screen move every 20 seconds
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 20000); return () => clearInterval(t); }, []);
  const itemById = useMemo(() => Object.fromEntries(items.map((i) => [i.id, i])), [items]);

  const loadBill = useCallback(async () => {
    if (!billId) { setBill(null); return; }
    const [{ data }, pays] = await Promise.all([
      supabase.from('pms_pos_bills').select('*, pms_pos_bill_items(*)').eq('id', billId).single(),
      supabase.from('pms_pos_payments').select('*').eq('bill_id', billId).eq('voided', false).order('created_at'),
    ]);
    if (data) data.pms_pos_bill_items.sort((a, b) => a.course - b.course || a.added_at.localeCompare(b.added_at));
    setBill(data);
    setPayments(pays.data ?? []);
  }, [billId]);
  useEffect(() => { loadBill(); }, [loadBill]);

  const groups = useMemo(() => {
    const g = {};
    const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));
    for (const c of cats) g[c.name] = [];
    for (const i of items.filter((x) => !q || x.name.toLowerCase().includes(q.toLowerCase()) || x.barcode === q.trim())) (g[catName[i.category_id] || i.group_name || 'Menu'] ??= []).push(i);
    for (const k of Object.keys(g)) if (!g[k].length) delete g[k];
    return g;
  }, [items, q, cats]);

  const newBill = (table) => run(async () => {
    const id = await rpc('pms_pos_open_bill', { p_outlet: outlet, p_table: table || null, p_covers: null });
    setBillId(id); await loadOutlet();
  }).catch(() => {});
  const add = (item, extra = {}) => run(async () => {
    let id = billId;
    if (!id || bill?.status !== 'open') { id = await rpc('pms_pos_open_bill', { p_outlet: outlet, p_table: null, p_covers: null }); setBillId(id); }
    await rpc('pms_pos_order', { p_bill: id, p_item: item.id, p_qty: extra.qty ?? 1, p_modifiers: extra.modifiers ?? [], p_note: extra.note ?? null,
      p_course: extra.course ?? 1, p_seat: extra.seat ?? null });
    setPick(null);
    if (id === billId) await loadBill();
    await loadOutlet();
  }).catch(() => {});
  const openTable = (t) => run(async () => {
    const id = t.bill_id ?? await rpc('pms_pos_open_table', { p_table: t.table_id, p_covers: null, p_guest: null });
    setBillId(id); setView('menu'); await loadOutlet();
  }).catch(() => {});
  const send = () => run(async () => {
    const t = await rpc('pms_pos_send', { p_bill: bill.id, p_course: null });
    setTickets(t); await loadBill(); await loadOutlet();
  }, 'Sent to the kitchen and bar').catch(() => {});
  const voidLine = (line) => {
    const r = window.prompt(`Why is ${line.name} being voided?`);
    if (r) run(() => rpc('pms_pos_void_item', { p_bill_item: line.id, p_reason: r }), `${line.name} voided`).then(async () => { await loadBill(); await loadOutlet(); }).catch(() => {});
  };
  const remove = (line) => run(async () => { await rpc('pms_pos_remove_item', { p_bill_item: line.id }); await loadBill(); await loadOutlet(); }).catch(() => {});
  const billFor = async () => {
    if (billId && bill?.status === 'open') return billId;
    const id = await rpc('pms_pos_open_bill', { p_outlet: outlet, p_table: null, p_covers: null });
    setBillId(id);
    return id;
  };
  const startTimer = (item, resource) => run(async () => {
    const id = await billFor();
    await rpc('pms_pos_start_timer', { p_bill: id, p_item: item.id, p_resource: resource ?? null });
    setPick(null); await loadBill(); await loadOutlet();
  }, `${resource ?? item.name}: clock started`).catch(() => {});
  const stopTimer = (line) => run(async () => {
    await rpc('pms_pos_stop_timer', { p_bill_item: line.id });
    await loadBill(); await loadOutlet();
  }, `${line.resource ?? line.name}: clock stopped`).catch(() => {});
  const tap = (item) => {
    if (item.item_type === 'timed') {
      if (item.resources?.length) setPick({ kind: 'timer', item });
      else startTimer(item, null);
    } else if (item.item_type === 'membership') setPick({ kind: 'member', item });
    else if (options[item.id]?.length) setPick({ kind: 'options', item });
    else add(item);
  };
  const busyResources = new Set(running.map((r) => `${r.item}|${r.resource}`));
  const runningHere = running.filter((r) => r.outlet === here?.name);
  const after = async () => { setDialog(null); await loadBill(); await loadOutlet(); };

  if (!outlets) return <Loading />;
  if (!outlets.length) return <div className="empty">No outlets yet. {can(role, 'setup') ? 'Add one under "Outlets and menu".' : 'Ask a manager to set up outlets.'}</div>;

  return (
    <div className="pos">
      <section className="pos-menu">
        <div className="pos-bar">
          <select value={outlet} onChange={(e) => { setOutlet(e.target.value); setBillId(null); }} aria-label="Outlet">
            {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <input placeholder="Find an item or scan a barcode" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find an item" />
          {here?.uses_tables && (
            <div className="view-switch" role="radiogroup" aria-label="Tables or menu">
              <button type="button" role="radio" aria-checked={view === 'floor'} className={view === 'floor' ? 'on' : ''} onClick={() => { setView('floor'); loadOutlet(); }}>Tables</button>
              <button type="button" role="radio" aria-checked={view === 'menu'} className={view === 'menu' ? 'on' : ''} onClick={() => setView('menu')}>Menu</button>
            </div>
          )}
        </div>
        {view === 'floor' && here?.uses_tables && (
          floor.length === 0 ? <div className="empty">No tables yet. {can(role, 'menu') ? 'Add them under "Outlets and menu" → Tables.' : ''}</div> : (
            Object.entries(floor.reduce((z, t) => { (z[t.zone || 'Tables'] ??= []).push(t); return z; }, {})).map(([zone, list]) => (
              <div key={zone} className="pos-group">
                <h4>{zone}</h4>
                <div className="pos-floor">
                  {list.map((t) => (
                    <button key={t.table_id} className={`pos-table ${t.bill_id ? 'busy' : 'free'} ${t.ready ? 'ready' : ''} ${t.bill_id && t.bill_id === billId ? 'active' : ''}`} disabled={busy} onClick={() => openTable(t)}>
                      <strong>{t.name}</strong>
                      <span className="small">{t.bill_id ? `#${t.bill_no} · ${money(t.total)}` : `${t.seats} seats · free`}</span>
                      {t.bill_id && <span className="small muted">{t.server ?? ''}{t.opened_at ? ` · ${clock(mins(t.opened_at))}` : ''}</span>}
                      {t.ready > 0 && <span className="pos-flag">{t.ready} ready</span>}
                      {!t.ready && t.waiting > 0 && <span className="pos-flag wait">{t.waiting} in kitchen</span>}
                    </button>
                  ))}
                </div>
              </div>
            )))
        )}
        {runningHere.length > 0 && (
          <div className="pos-running" aria-label="Running now">
            <h4>Running now</h4>
            <div className="pos-items">
              {runningHere.map((r) => (
                <button key={r.bill_item_id} className="pos-item pos-item-running" onClick={() => setBillId(r.bill_id)}>
                  <span>{r.resource ?? r.item}</span>
                  <span className="muted">{clock(mins(r.started_at))} · ~{money(estimate({ started_at: r.started_at, price: r.price, amount: r.estimate }, { min_units: r.min_units, grace_minutes: r.grace_minutes, duration_minutes: r.block_minutes }))}</span>
                  <span className="small">Bill #{r.bill_no}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {view === 'menu' && Object.keys(groups).length === 0 && <div className="empty">No menu items. {can(role, 'setup') ? 'Add them under "Outlets and menu", or add an open item on the bill.' : ''}</div>}
        {view === 'menu' && Object.entries(groups).map(([g, list]) => (
          <div key={g} className="pos-group">
            <h4>{g}</h4>
            <div className="pos-items">
              {list.map((i) => (
                <button key={i.id} className={`pos-item has-pic ${i.item_type !== 'product' ? 'pos-item-' + i.item_type : ''} ${i.available === false ? 'sold-out' : ''}`} disabled={busy || i.available === false} onClick={() => tap(i)}>
                  <span className="pos-pic">{i.image_url ? <img src={i.image_url} alt="" loading="lazy" /> : <PosArt item={i} outletType={outlets.find((o) => o.id === outlet)?.outlet_type} />}</span>
                  <span className="pos-name">{i.name}</span>
                  <span className="muted">{i.available === false ? 'Sold out' : <>{money(i.price)}{i.item_type === 'timed' ? ` / ${i.duration_minutes} min` : i.item_type === 'membership' ? ` · ${i.validity_days} days` : ''}{options[i.id]?.length ? ' · options' : ''}</>}</span>
                  {i.item_type === 'timed' && i.resources?.length > 0 && (
                    <span className="small pos-free">{i.resources.filter((r) => !busyResources.has(`${i.name}|${r}`)).length} of {i.resources.length} free</span>)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="pos-bill">
        <div className="pos-tickets">
          {openBills.map((b) => (
            <button key={b.id} className={`ticket ${b.id === billId ? 'active' : ''}`} onClick={() => setBillId(b.id)}>
              #{b.bill_no}{b.table_no ? ` · ${b.table_no}` : ''}<span>{money(b.total)}</span>
            </button>
          ))}
          <button className="ticket new" onClick={() => { const t = window.prompt('Table or name for the new bill (optional)'); if (t !== null) newBill(t); }}>+ New bill</button>
        </div>

        {!bill && <div className="empty">Tap a menu item to start a bill.</div>}
        {bill && (
          <div className="bill">
            <div className="bill-head">
              <h3 className="first">Bill #{bill.bill_no}{bill.table_no ? ` · ${bill.table_no}` : ''}{bill.covers ? <span className="small muted"> · {bill.covers} guests</span> : ''}</h3>
              <span className={`badge badge-${STATUS[bill.status][1]}`}>{STATUS[bill.status][0]}</span>
            </div>
            <table className="table bill-lines">
              <tbody>
                {bill.pms_pos_bill_items.length === 0 && <tr><td className="muted">No items yet.</td></tr>}
                {bill.pms_pos_bill_items.map((l) => {
                  const live = l.started_at && !l.ended_at;
                  return (
                    <tr key={l.id} className={live ? 'line-running' : ''}>
                      {splitting && <td><input type="checkbox" aria-label={`Move ${l.name}`} checked={splitIds.includes(l.id)} onChange={(e) => setSplitIds(e.target.checked ? [...splitIds, l.id] : splitIds.filter((x) => x !== l.id))} /></td>}
                      <td className={l.voided ? 'strike muted' : ''}>{live
                        ? <><span className="pulse" aria-hidden="true" /> {l.name} · {clock(mins(l.started_at))}</>
                        : l.started_at ? <>{l.name} · {Number(l.qty)} × {itemById[l.item_id]?.duration_minutes ?? ''} min</>
                          : <>{Number(l.qty)} × {l.name}</>}
                        {(l.note || l.course > 1 || l.seat || l.price_rule) && <div className="small muted">{[l.course > 1 && `Course ${l.course}`, l.seat && `Seat ${l.seat}`, l.note, l.price_rule && `${l.price_rule} price`].filter(Boolean).join(' · ')}</div>}
                        {l.voided && <div className="small">Voided: {l.void_reason}</div>}
                        {!l.voided && l.station && l.station !== 'none' && <span className={`kst kst-${l.kitchen_status}`}>{KST[l.kitchen_status]}</span>}</td>
                      <td className="num">{live ? <span title="So far">~{money(estimate(l, itemById[l.item_id]))}</span> : <span className={l.voided ? 'strike muted' : ''}>{money(l.amount)}</span>}</td>
                      <td className="row-actions">{bill.status === 'open' && !l.voided && (live
                        ? <button className="btn btn-small btn-primary" disabled={busy} onClick={() => stopTimer(l)}>Stop</button>
                        : l.kitchen_status === 'new' || !l.sent_at
                          ? <button className="link danger" onClick={() => remove(l)} aria-label={`Remove ${l.name}`}>Remove</button>
                          : <>{l.kitchen_status === 'ready' && <button className="btn btn-small" disabled={busy} onClick={() => run(() => rpc('pms_pos_kitchen_bump', { p_lines: [l.id], p_status: 'served' })).then(loadBill).catch(() => {})}>Served</button>}
                            {can(role, 'pos.void') && <button className="link danger" onClick={() => voidLine(l)}>Void</button>}</>)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                {(Number(bill.discount) > 0 || Number(bill.service_charge) > 0) && <tr className="small"><td>Items</td><td className="num">{money(bill.subtotal)}</td><td /></tr>}
                {Number(bill.discount) > 0 && <tr className="small"><td>Discount</td><td className="num">−{money(bill.discount)}</td><td /></tr>}
                {Number(bill.service_charge) > 0 && <tr className="small"><td>Service charge {Number(here?.service_charge_pct ?? 0)}%</td><td className="num">{money(bill.service_charge)}</td><td /></tr>}
                <tr><td>Total</td><td className="num">{property.currency} {money(bill.total)}</td><td /></tr>
                {payments.map((p) => (
                  <tr key={p.id} className="small"><td>Paid · {p.method_name ?? label(p.method)}{p.reference ? ` · ${p.reference}` : ''}{Number(p.change_given) > 0 ? ` · change ${money(p.change_given)}` : ''}</td>
                    <td className="num">−{money(p.amount)}</td>
                    <td className="row-actions">{bill.status === 'open' && can(role, 'pos.void') && <button className="link danger" onClick={() => { const r = window.prompt('Why is this payment being taken back?'); if (r) run(() => rpc('pms_pos_remove_payment', { p_payment: p.id, p_reason: r }), 'Payment taken back').then(loadBill).catch(() => {}); }}>Undo</button>}</td></tr>
                ))}
                {Number(bill.paid) > 0 && bill.status === 'open' && <tr><td><strong>Still to pay</strong></td><td className="num"><strong>{money(Number(bill.total) - Number(bill.paid))}</strong></td><td /></tr>}
                {bill.pms_pos_bill_items.some((l) => l.started_at && !l.ended_at) && (
                  <tr className="muted small"><td>So far, with the clock running</td>
                    <td className="num">~{money(Number(bill.total) + bill.pms_pos_bill_items.filter((l) => l.started_at && !l.ended_at).reduce((n, l) => n + estimate(l, itemById[l.item_id]) - Number(l.amount), 0))}</td><td /></tr>)}
              </tfoot>
            </table>
            {bill.status === 'open' && splitting && (
              <div className="bill-actions pick-bar">
                <span>{splitIds.length} item(s) to the new bill</span>
                <button className="btn btn-primary" disabled={!splitIds.length || busy} onClick={() => run(async () => {
                  const id = await rpc('pms_pos_split_bill', { p_bill: bill.id, p_items: splitIds }); setSplitting(false); setSplitIds([]); setBillId(id); await loadOutlet();
                }, 'Bill split').catch(() => {})}>Split</button>
                <button className="btn" onClick={() => { setSplitting(false); setSplitIds([]); }}>Cancel</button>
              </div>
            )}
            {bill.status === 'open' && !splitting && (
              <div className="bill-actions">
                {bill.pms_pos_bill_items.some((l) => l.started_at && !l.ended_at) && <span className="small muted" style={{ width: '100%' }}>Stop the clock before taking payment.</span>}
                {bill.pms_pos_bill_items.some((l) => l.kitchen_status === 'new' && !l.voided) && <button className="btn btn-primary" disabled={busy} onClick={send}>Send to kitchen</button>}
                <button className="btn btn-primary" disabled={!Number(bill.total) || bill.pms_pos_bill_items.some((l) => l.started_at && !l.ended_at)} onClick={() => setDialog('pay')}>Take payment</button>
                <button className="btn" disabled={!Number(bill.total) || bill.pms_pos_bill_items.some((l) => l.started_at && !l.ended_at)} onClick={() => setDialog('room')}>{Number(bill.paid) > 0 ? 'Rest to room' : 'Charge to room'}</button>
                {can(role, 'pos.transfer') && here?.uses_tables && <button className="btn" onClick={() => setDialog('move')}>Move or merge</button>}
                <button className="btn" onClick={() => setPick({ kind: 'guest' })}>{bill.stay_id ? 'Change guest' : 'For a room guest'}</button>
                {bill.pms_pos_bill_items.length > 1 && <button className="btn" onClick={() => setSplitting(true)}>Split</button>}
                <button className="btn" onClick={() => setDialog('open')}>Open item</button>
                {can(role, 'pos.discount') && <button className="btn" onClick={() => setDialog('discount')}>Discount</button>}
                {can(role, 'pos.void') && <button className="btn btn-danger-ghost" onClick={() => setDialog('void')}>Void</button>}
              </div>
            )}
            {bill.status !== 'open' && (
              <div className="bill-actions">
                <span className="muted small">This bill is closed. Tap a menu item to start the next one.</span>
                <button className="btn" onClick={() => setBillId(null)}>Clear</button>
              </div>
            )}
          </div>
        )}
      </section>
      {dialog === 'pay' && bill && <PayDialog bill={bill} onClose={() => setDialog(null)} onDone={async (keepOpen) => { if (!keepOpen) setDialog(null); await loadBill(); await loadOutlet(); }} />}
      {dialog === 'move' && bill && <MoveDialog bill={bill} floor={floor} openBills={openBills} onClose={() => setDialog(null)} onDone={async (id) => { setDialog(null); if (id) setBillId(id); await loadBill(); await loadOutlet(); }} />}
      {dialog && !['pay', 'move'].includes(dialog) && bill && <BillDialog kind={dialog} bill={bill} onClose={() => setDialog(null)} onDone={after} />}
      {pick?.kind === 'options' && <OptionsDialog item={pick.item} groups={options[pick.item.id] ?? []} busy={busy} onClose={() => setPick(null)} onAdd={(extra) => add(pick.item, extra)} />}
      {tickets && <TicketsDialog tickets={tickets} onClose={() => setTickets(null)} />}
      {pick?.kind === 'timer' && (
        <Modal title={`Start the clock: ${pick.item.name}`} onClose={() => setPick(null)}
          footer={<button className="btn" onClick={() => setPick(null)}>Cancel</button>}>
          <p className="muted">{money(pick.item.price)} per {pick.item.duration_minutes} min{Number(pick.item.min_units) > 1 ? `, at least ${Number(pick.item.min_units)} blocks` : ''}{pick.item.grace_minutes ? `, ${pick.item.grace_minutes} min grace` : ''}.</p>
          <div className="pos-items">
            {pick.item.resources.map((r) => {
              const taken = busyResources.has(`${pick.item.name}|${r}`);
              return <button key={r} className="pos-item" disabled={busy || taken} onClick={() => startTimer(pick.item, r)}><span>{r}</span><span className="muted">{taken ? 'In use' : 'Free'}</span></button>;
            })}
          </div>
        </Modal>
      )}
      {pick?.kind === 'guest' && bill && <GuestPick bill={bill} onClose={() => setPick(null)} onDone={async () => { setPick(null); await loadBill(); await loadOutlet(); }} />}
      {pick?.kind === 'member' && <MemberDialog item={pick.item} onClose={() => setPick(null)}
        onSave={(name, phone) => run(async () => {
          const id = await billFor();
          await rpc('pms_pos_add_membership', { p_bill: id, p_item: pick.item.id, p_name: name, p_phone: phone || null });
          setPick(null); await loadBill(); await loadOutlet();
        }, 'Membership added. It starts when the bill is paid.').catch(() => {})} busy={busy} />}
    </div>
  );
}

// Choose options (cooking, extras…), quantity, course, seat and a note for the kitchen
function OptionsDialog({ item, groups, busy, onClose, onAdd }) {
  const [sel, setSel] = useState({});
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState('');
  const [course, setCourse] = useState(1);
  const [seat, setSeat] = useState('');
  const toggle = (g, m) => {
    const cur = sel[g.id] ?? [];
    let next;
    if (g.max_choices === 1) next = cur.includes(m.id) ? [] : [m.id];
    else next = cur.includes(m.id) ? cur.filter((x) => x !== m.id) : cur.length < g.max_choices ? [...cur, m.id] : cur;
    setSel({ ...sel, [g.id]: next });
  };
  const missing = groups.filter((g) => (sel[g.id] ?? []).length < g.min_choices);
  const extra = groups.flatMap((g) => g.mods.filter((m) => (sel[g.id] ?? []).includes(m.id))).reduce((n, m) => n + Number(m.price), 0);
  return (
    <Modal title={item.name} onClose={onClose} footer={<>
      <span className="muted">{qty} × {money(Number(item.price) + extra)}</span>
      <div className="row-gap"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || missing.length > 0} onClick={() => onAdd({ qty, modifiers: Object.values(sel).flat(), note: note || null, course, seat: seat ? Number(seat) : null })}>
          {missing.length ? `Choose ${missing[0].name.toLowerCase()}` : 'Add to bill'}</button></div>
    </>}>
      {groups.map((g) => (
        <fieldset key={g.id} className="opt-group">
          <legend>{g.name} <span className="small muted">{g.min_choices > 0 ? (g.max_choices === 1 ? 'choose one' : `choose ${g.min_choices}–${g.max_choices}`) : `optional${g.max_choices > 1 ? `, up to ${g.max_choices}` : ''}`}</span></legend>
          <div className="opt-list">
            {g.mods.map((m) => {
              const on = (sel[g.id] ?? []).includes(m.id);
              return <button key={m.id} type="button" className={`opt ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => toggle(g, m)}>{m.name}{Number(m.price) > 0 && <span className="small"> +{money(m.price)}</span>}</button>;
            })}
          </div>
        </fieldset>
      ))}
      <div className="grid-3">
        <Field label="Quantity"><input type="number" min="1" value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))} /></Field>
        <Field label="Course"><select value={course} onChange={(e) => setCourse(Number(e.target.value))}><option value={1}>1 · Starters / now</option><option value={2}>2 · Mains</option><option value={3}>3 · Dessert</option></select></Field>
        <Field label="Seat"><input inputMode="numeric" value={seat} onChange={(e) => setSeat(e.target.value.replace(/\D/g, ''))} placeholder="Any" /></Field>
      </div>
      <Field label="Note for the kitchen"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="No onions, allergy, extra hot…" maxLength={140} /></Field>
    </Modal>
  );
}

// Split payment: any number of tenders; cash shows the change
function PayDialog({ bill, onClose, onDone }) {
  const { property, lookups } = useProperty();
  const [run, busy] = useAction();
  const methods = lookups.paymentMethods.filter((m) => m.active);
  const due = Number(bill.total) - Number(bill.paid);
  const [f, setF] = useState({ method: methods[0]?.id ?? '', amount: String(due), tendered: '', reference: '' });
  const m = methods.find((x) => x.id === f.method);
  const amt = Number(f.amount || 0), tendered = Number(f.tendered || 0);
  const change = m?.kind === 'cash' && tendered > Math.min(amt, due) ? tendered - Math.min(amt, due) : 0;
  const submit = (e) => {
    e.preventDefault();
    run(() => rpc('pms_pos_pay', { p_bill: bill.id, p_method: f.method, p_amount: amt, p_reference: f.reference || null, p_tendered: m?.kind === 'cash' && f.tendered ? tendered : null }))
      .then((r) => { if (r.settled) onDone(); else { setF({ ...f, amount: String(r.due), tendered: '', reference: '' }); onDone(true); } })
      .catch(() => {});
  };
  return (
    <Modal title={`Take payment · bill #${bill.bill_no}`} onClose={onClose}
      footer={<><span className="muted">To pay {property.currency} {money(due)}</span><div className="row-gap"><button className="btn" onClick={onClose}>Close</button><button className="btn btn-primary" form="paydlg" disabled={busy || !amt}>Take {money(Math.min(amt, due))}</button></div></>}>
      <form id="paydlg" className="stack" onSubmit={submit}>
        <div className="pay-methods">
          {methods.map((x) => <button type="button" key={x.id} className={`opt ${f.method === x.id ? 'on' : ''}`} aria-pressed={f.method === x.id} onClick={() => setF({ ...f, method: x.id })}>{x.name}</button>)}
        </div>
        <div className="grid-2">
          <Field label="Amount" hint="Pay part now and the rest another way, or charge the rest to a room."><input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
          {m?.kind === 'cash'
            ? <Field label="Cash given" hint={change > 0 ? `Change: ${property.currency} ${money(change)}` : 'Leave empty if exact'}><input inputMode="decimal" value={f.tendered} onChange={(e) => setF({ ...f, tendered: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
            : <Field label="Reference" hint="Transaction or slip number"><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} required={['mobile_money', 'card', 'bank'].includes(m?.kind)} /></Field>}
        </div>
        {change > 0 && <div className="pay-change">Give change: <strong>{property.currency} {money(change)}</strong></div>}
      </form>
    </Modal>
  );
}

function MoveDialog({ bill, floor, openBills, onClose, onDone }) {
  const [run, busy] = useAction();
  const free = floor.filter((t) => !t.bill_id);
  const others = openBills.filter((b) => b.id !== bill.id);
  return (
    <Modal title={`Move or merge bill #${bill.bill_no}`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <h4 className="first">Move to a free table</h4>
      <div className="pos-floor">{free.length ? free.map((t) => (
        <button key={t.table_id} className="pos-table free" disabled={busy} onClick={() => run(() => rpc('pms_pos_move_table', { p_bill: bill.id, p_table: t.table_id }), `Moved to ${t.name}`).then(() => onDone()).catch(() => {})}>
          <strong>{t.name}</strong><span className="small">{t.zone ?? ''} · {t.seats} seats</span></button>)) : <p className="muted small">No free tables.</p>}</div>
      <h4>Merge another bill into this one</h4>
      <div className="pos-floor">{others.length ? others.map((b) => (
        <button key={b.id} className="pos-table busy" disabled={busy} onClick={() => window.confirm(`Bring everything on bill #${b.bill_no} onto bill #${bill.bill_no}?`) && run(() => rpc('pms_pos_merge_bills', { p_keep: bill.id, p_drop: b.id }), 'Bills merged').then(() => onDone(bill.id)).catch(() => {})}>
          <strong>#{b.bill_no}{b.table_no ? ` · ${b.table_no}` : ''}</strong><span className="small">{money(b.total)}</span></button>)) : <p className="muted small">No other open bills.</p>}</div>
    </Modal>
  );
}

// Kitchen and bar tickets: shown on the kitchen display, and printable for a ticket printer
function TicketsDialog({ tickets, onClose }) {
  return (
    <Modal title="Sent" onClose={onClose} footer={<><button className="btn" onClick={() => window.print()}>Print tickets</button><button className="btn btn-primary" onClick={onClose}>Done</button></>}>
      <div className="kot-list">
        {tickets.map((t) => (
          <div key={t.station} className="kot">
            <div className="kot-head"><strong>{t.station === 'bar' ? 'BAR' : 'KITCHEN'}</strong><span>{t.table} · #{t.bill_no} · round {t.ticket}</span></div>
            <div className="small">{new Date(t.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{t.server ? ` · ${t.server}` : ''}{t.covers ? ` · ${t.covers} guests` : ''}</div>
            <ul>{t.items.map((i, n) => <li key={n}><strong>{Number(i.qty)}×</strong> {i.name}{i.seat ? ` (seat ${i.seat})` : ''}{i.note && <div className="kot-note">{i.note}</div>}</li>)}</ul>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function BillDialog({ kind, bill, onClose, onDone }) {
  const { property, lookups } = useProperty();
  const [run, busy] = useAction();
  const methods = lookups.paymentMethods.filter((m) => m.active);
  const [f, setF] = useState({ method: methods[0]?.id ?? 'cash', reference: '', stay: bill.stay_id ?? '', name: '', price: '', qty: '1', amount: '', reason: '' });
  const m = methods.find((x) => x.id === f.method);
  const kindOf = m?.kind ?? f.method;
  const [guests, setGuests] = useState([]);
  useEffect(() => {
    if (kind === 'room') rpc('pms_inhouse_guests', { p_property: property.id }).then(setGuests).catch(() => {});
  }, [kind, property]);
  const titles = { settle: 'Take payment', room: 'Charge to a room', open: 'Add an open item', discount: 'Discount', void: 'Void bill' };
  const submit = (e) => {
    e.preventDefault();
    const calls = {
      settle: () => (m ? rpc('pms_pos_settle_method', { p_bill: bill.id, p_method: m.id, p_reference: f.reference || null }) : rpc('pms_pos_settle', { p_bill: bill.id, p_method: f.method, p_reference: f.reference || null })),
      room: () => rpc('pms_pos_post_to_room', { p_bill: bill.id, p_stay: f.stay }),
      open: () => rpc('pms_pos_add_item', { p_bill: bill.id, p_item: null, p_qty: Number(f.qty || 1), p_name: f.name, p_price: Number(f.price) }),
      discount: () => rpc('pms_pos_discount', { p_bill: bill.id, p_amount: Number(f.amount), p_reason: f.reason }),
      void: () => rpc('pms_pos_void_bill', { p_bill: bill.id, p_reason: f.reason }),
    };
    const done = { settle: `Bill #${bill.bill_no} paid`, room: `Bill #${bill.bill_no} charged to the room`, open: 'Item added', discount: 'Discount applied', void: `Bill #${bill.bill_no} voided` };
    run(calls[kind], done[kind]).then(onDone).catch(() => {});
  };
  const num = (k) => (e) => setF({ ...f, [k]: e.target.value.replace(/[^\d.]/g, '') });
  return (
    <Modal title={titles[kind]} onClose={onClose}
      footer={<><span className="muted">Bill total {property.currency} {money(bill.total)}</span><div className="row-gap"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="billdlg" disabled={busy}>{titles[kind]}</button></div></>}>
      <form id="billdlg" className="stack" onSubmit={submit}>
        {kind === 'settle' && <>
          <Field label="Paid with"><select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            {methods.length ? methods.map((x) => <option key={x.id} value={x.id}>{x.name}</option>) : METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Reference" hint={kindOf === 'cash' ? 'Cash goes into your open drawer.' : 'Required for mobile money, card and bank.'}>
            <input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} required={['mobile_money', 'card', 'bank'].includes(kindOf)} />
          </Field>
        </>}
        {kind === 'room' && (
          <Field label="In-house guest">
            <select required value={f.stay} onChange={(e) => setF({ ...f, stay: e.target.value })}>
              <option value="">Choose room…</option>
              {guests.map((g) => <option key={g.stay_id} value={g.stay_id}>{g.room} · {g.guest}</option>)}
            </select>
          </Field>
        )}
        {kind === 'open' && <>
          <Field label="Item"><input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <div className="grid-2"><Field label="Price"><input required inputMode="decimal" value={f.price} onChange={num('price')} /></Field>
            <Field label="Quantity"><input required inputMode="decimal" value={f.qty} onChange={num('qty')} /></Field></div>
        </>}
        {kind === 'discount' && <>
          <Field label={`Amount off (${property.currency})`}><input required inputMode="decimal" value={f.amount} onChange={num('amount')} /></Field>
          <Field label="Reason"><input required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        </>}
        {kind === 'void' && <>
          <p>Void bill #{bill.bill_no}? It stays on record and shows in the POS report.</p>
          <Field label="Reason"><input required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        </>}
      </form>
    </Modal>
  );
}

// Attach a bill to an in-house guest (room service, pool bar tab); it can then be charged to the room
function GuestPick({ bill, onClose, onDone }) {
  const { property } = useProperty();
  const [run, busy] = useAction();
  const [guests, setGuests] = useState(null);
  const [q, setQ] = useState('');
  useEffect(() => { rpc('pms_inhouse_guests', { p_property: property.id }).then(setGuests).catch(() => setGuests([])); }, [property.id]);
  const list = (guests ?? []).filter((g) => !q || `${g.room} ${g.guest}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal title="Bill for a room guest" onClose={onClose} footer={<div className="row-gap">
      {bill.stay_id && <button className="btn" onClick={() => run(() => rpc('pms_pos_attach_guest', { p_bill: bill.id, p_stay: null }), 'Guest removed from the bill').then(onDone).catch(() => {})}>Not a room guest</button>}
      <button className="btn" onClick={onClose}>Close</button></div>}>
      <input className="search" autoFocus placeholder="Room number or name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a guest" />
      {guests === null ? <Loading /> : list.length === 0 ? <p className="muted">No checked-in guest matches.</p> : (
        <div className="pos-items guest-pick">
          {list.map((g) => (
            <button key={g.stay_id} className={`pos-item ${bill.stay_id === g.stay_id ? 'pos-item-running' : ''}`} disabled={busy}
              onClick={() => run(() => rpc('pms_pos_attach_guest', { p_bill: bill.id, p_stay: g.stay_id }), `Bill #${bill.bill_no} is for room ${g.room}`).then(onDone).catch(() => {})}>
              <span>Room {g.room}</span><span className="muted">{g.guest}</span>
            </button>
          ))}
        </div>
      )}
      <p className="small muted">Only checked-in guests are listed. The bill stays open here until you charge it to the room or take payment.</p>
    </Modal>
  );
}

function MemberDialog({ item, onClose, onSave, busy }) {
  const [f, setF] = useState({ name: '', phone: '' });
  return (
    <Modal title={`Sell: ${item.name}`} onClose={onClose}
      footer={<div className="row-gap"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" form="memdlg" disabled={busy}>Add to bill</button></div>}>
      <form id="memdlg" className="stack" onSubmit={(e) => { e.preventDefault(); onSave(f.name, f.phone); }}>
        <p className="muted">{money(item.price)} · {item.validity_days} days{item.visits_included ? ` · ${item.visits_included} visits` : ' · unlimited visits'}. Starts on the day it is paid.</p>
        <Field label="Member's name"><input required autoFocus maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Phone" hint="Used to find them at the door"><input inputMode="tel" maxLength={20} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
      </form>
    </Modal>
  );
}

// At the gym, pool or spa door: members, in-house guests and walk-ins are checked in, which gives usage per facility
function Door() {
  const { property, role } = useProperty();
  const [run, busy] = useAction();
  const [outlets, setOutlets] = useState(null);
  const [outlet, setOutlet] = useState('');
  const [q, setQ] = useState('');
  const [members, setMembers] = useState([]);
  const [visits, setVisits] = useState(null);
  const [guests, setGuests] = useState([]);
  const [stay, setStay] = useState('');
  const [walkIn, setWalkIn] = useState('');
  const [all, setAll] = useState(false);
  useEffect(() => {
    supabase.from('pms_pos_outlets').select('id, name, outlet_type').eq('property_id', property.id).eq('active', true).order('name').then(({ data }) => {
      const list = data ?? [];
      setOutlets(list);
      let last = null;
      try { last = localStorage.getItem(`pms.pos.outlet.${property.id}`); } catch { /* storage unavailable */ }
      const lastOutlet = list.find((x) => x.id === last && ACTIVITY.has(x.outlet_type));
      setOutlet((o) => o || (lastOutlet ?? list.find((x) => ['gym', 'pool'].includes(x.outlet_type)) ?? list.find((x) => ACTIVITY.has(x.outlet_type)) ?? list[0])?.id || '');
    });
    rpc('pms_inhouse_guests', { p_property: property.id }).then(setGuests).catch(() => setGuests([]));
  }, [property]);
  const load = useCallback(async () => {
    if (!outlet) return;
    let mq = supabase.from('pms_memberships').select('*').eq('outlet_id', outlet).order('ends_on', { ascending: false }).limit(50);
    if (!all) mq = mq.eq('status', 'active').gte('ends_on', property.business_date);
    const term = safeTerm(q);
    if (term) mq = mq.or(`member_name.ilike.%${term}%,phone.ilike.%${term}%`);
    const [m, v] = await Promise.all([mq, supabase.from('pms_activity_visits').select('*').eq('outlet_id', outlet).eq('business_date', property.business_date).order('visited_at', { ascending: false })]);
    setMembers(m.data ?? []); setVisits(v.data ?? []);
  }, [outlet, q, all, property.business_date]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);
  const checkIn = (args, done) => run(async () => {
    const r = await rpc('pms_activity_check_in', { p_outlet: outlet, p_membership: null, p_stay: null, p_name: null, p_note: null, ...args });
    await load();
    return r;
  }, done).catch(() => {});
  if (!outlets) return <Loading />;
  if (!outlets.length) return <div className="empty">No outlets yet.</div>;
  return (
    <div className="door">
      <div className="pos-bar">
        <select value={outlet} onChange={(e) => setOutlet(e.target.value)} aria-label="Facility">
          {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </div>
      <div className="grid-2">
        <div className="card">
          <h3 className="first">Members</h3>
          <div className="row-gap">
            <input className="search" placeholder="Name or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a member" />
            <label className="small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show ended and cancelled</label>
          </div>
          <Table rows={members} empty="No members found. Sell a membership on the Sell tab." columns={[
            { key: 'member_name', label: 'Member', render: (m) => <>{m.member_name}{m.phone ? <div className="small muted">{m.phone}</div> : null}</> },
            { key: 'plan', label: 'Plan' },
            { key: 'ends_on', label: 'Until', render: (m) => fmtDate(m.ends_on) },
            { key: 'visits', label: 'Visits', render: (m) => (m.visits_included ? `${m.visits_used} of ${m.visits_included}` : m.visits_used) },
            { key: 'act', label: '', render: (m) => (m.status !== 'active' ? <Badge kind="grey">Cancelled</Badge>
              : m.ends_on < property.business_date ? <Badge kind="grey">Ended</Badge>
              : <span className="row-gap">
                  <button className="btn btn-small btn-primary" disabled={busy} onClick={() => checkIn({ p_membership: m.id }, `${m.member_name} checked in`)}>Check in</button>
                  {can(role, 'pos.cancel_membership') && <button className="link danger" onClick={() => { const r = window.prompt(`Why cancel ${m.member_name}'s membership?`); if (r) run(() => rpc('pms_cancel_membership', { p_membership: m.id, p_reason: r }), 'Membership cancelled').then(load).catch(() => {}); }}>Cancel</button>}
                </span>) },
          ]} />
        </div>
        <div className="stack">
          <form className="card" onSubmit={(e) => { e.preventDefault(); checkIn({ p_stay: stay }, 'Guest checked in').then(() => setStay('')); }}>
            <h3 className="first">In-house guest</h3>
            <Field label="Room"><select required value={stay} onChange={(e) => setStay(e.target.value)}>
              <option value="">Choose room…</option>
              {guests.map((g) => <option key={g.stay_id} value={g.stay_id}>{g.room} · {g.guest}</option>)}
            </select></Field>
            <button className="btn btn-primary" disabled={busy}>Check in</button>
          </form>
          <form className="card" onSubmit={(e) => { e.preventDefault(); checkIn({ p_name: walkIn }, 'Visitor checked in').then(() => setWalkIn('')); }}>
            <h3 className="first">Walk-in visitor</h3>
            <Field label="Name" hint="Sell a day pass on the Sell tab if they pay"><input required maxLength={80} value={walkIn} onChange={(e) => setWalkIn(e.target.value)} /></Field>
            <button className="btn btn-primary" disabled={busy}>Check in</button>
          </form>
        </div>
      </div>
      <h3>Today at the door</h3>
      <Table rows={visits} empty="Nobody yet today." columns={[
        { key: 'visited_at', label: 'Time', render: (v) => fmtDateTime(v.visited_at) },
        { key: 'guest_name', label: 'Who' },
        { key: 'kind', label: 'As', render: (v) => ({ member: 'Member', resident: 'Hotel guest', walk_in: 'Walk-in' }[v.kind]) },
      ]} />
    </div>
  );
}

function Bills() {
  const { property, role } = useProperty();
  const [run] = useAction();
  const [rows, setRows] = useState(null);
  const load = useCallback(() => supabase.from('pms_pos_bills').select('*, pms_pos_outlets(name)').eq('property_id', property.id)
    .eq('business_date', property.business_date).order('bill_no', { ascending: false }).then(({ data }) => setRows(data ?? [])), [property]);
  useEffect(() => { load(); }, [load]);
  const total = (rows ?? []).filter((b) => ['settled', 'room'].includes(b.status)).reduce((n, b) => n + Number(b.total), 0);
  const [z, setZ] = useState(null);
  const [outs, setOuts] = useState([]);
  useEffect(() => { supabase.from('pms_pos_outlets').select('id, name').eq('property_id', property.id).eq('active', true).order('name').then(({ data }) => setOuts(data ?? [])); }, [property.id]);
  const showZ = (id) => run(() => rpc('pms_rpt_pos_z', { p_outlet: id, p_date: property.business_date })).then(setZ).catch(() => {});
  return (
    <>
    {can(role, 'rpt.pos_z') && outs.length > 0 && (
      <div className="row-gap" style={{ marginBottom: 12 }}>
        <span className="small muted">End of day (Z):</span>
        {outs.map((o) => <button key={o.id} className="btn btn-small" onClick={() => showZ(o.id)}>{o.name}</button>)}
      </div>
    )}
    {z && <ZReport z={z} onClose={() => setZ(null)} />}
    <Table rows={rows} empty="No bills today" footer={{ bill_no: 'Total sales', total: money(total) }} columns={[
      { key: 'bill_no', label: 'Bill', render: (b) => `#${b.bill_no}` },
      { key: 'outlet', label: 'Outlet', render: (b) => b.pms_pos_outlets?.name },
      { key: 'table_no', label: 'Table' },
      { key: 'status', label: 'Status', render: (b) => <Badge kind={STATUS[b.status][1]}>{STATUS[b.status][0]}</Badge> },
      { key: 'payment_method', label: 'Paid with', render: (b) => b.payment_method_name ?? (b.payment_method ? label(b.payment_method) : '') },
      { key: 'closed_at', label: 'Closed', render: (b) => fmtDateTime(b.closed_at) },
      { key: 'total', label: 'Total', num: true, render: (b) => money(b.total) },
      { key: 'act', label: '', render: (b) => can(role, 'pos.void') && ['settled', 'room'].includes(b.status) && (
        <button className="link danger" onClick={() => { const r = window.prompt(`Reason for voiding bill #${b.bill_no}`); if (r) run(() => rpc('pms_pos_void_bill', { p_bill: b.id, p_reason: r }), 'Bill voided').then(load).catch(() => {}); }}>Void</button>) },
    ]} />
    </>
  );
}

function ZReport({ z, onClose }) {
  const { property } = useProperty();
  const row = (l, v, strong) => <tr><td>{strong ? <strong>{l}</strong> : l}</td><td className="num">{strong ? <strong>{money(v)}</strong> : money(v)}</td></tr>;
  return (
    <Modal title={`End of day · ${z.outlet}`} onClose={onClose} footer={<><button className="btn" onClick={() => window.print()}>Print</button><button className="btn btn-primary" onClick={onClose}>Done</button></>}>
      <p className="small muted">{fmtDate(z.date)} · {z.bills} bills · {z.covers} guests{z.open_bills ? ` · ${z.open_bills} still open` : ''} · {property.currency}</p>
      <table className="table"><tbody>
        {row('Items sold', z.gross)}{Number(z.discounts) > 0 && row('Discounts', -z.discounts)}{Number(z.service_charge) > 0 && row('Service charge', z.service_charge)}
        {row('Net sales', z.net, true)}{Number(z.to_rooms) > 0 && row('Charged to rooms', z.to_rooms)}
        {z.tenders.map((t) => <tr key={t.method}><td>{t.method} <span className="small muted">× {t.count}</span></td><td className="num">{money(t.amount)}</td></tr>)}
      </tbody></table>
      {z.top_items.length > 0 && <><h4>Best sellers</h4><table className="table"><tbody>{z.top_items.map((t) => <tr key={t.item}><td>{Number(t.qty)} × {t.item}</td><td className="num">{money(t.amount)}</td></tr>)}</tbody></table></>}
      {z.servers.length > 0 && <><h4>By server</h4><table className="table"><tbody>{z.servers.map((t) => <tr key={t.server}><td>{t.server} <span className="small muted">× {t.bills}</span></td><td className="num">{money(t.amount)}</td></tr>)}</tbody></table></>}
      {(z.voided_bills.length > 0 || z.voided_items.length > 0) && <><h4>Voids</h4><table className="table"><tbody>
        {z.voided_bills.map((v) => <tr key={'b' + v.bill_no}><td>Bill #{v.bill_no} · {v.reason}</td><td className="num">{money(v.amount)}</td></tr>)}
        {z.voided_items.map((v, n) => <tr key={'i' + n}><td>#{v.bill_no} {v.item} · {v.reason}</td><td className="num">{money(v.amount)}</td></tr>)}</tbody></table></>}
    </Modal>
  );
}

export function MenuSetup() {
  const { property } = useProperty();
  const [outlets, setOutlets] = useState([]);
  const [items, setItems] = useState([]);
  const [outlet, setOutlet] = useState('');
  const [locs, setLocs] = useState([]);
  const [cats, setCats] = useState([]);
  const [groups, setGroups] = useState([]);
  const [mods, setMods] = useState([]);
  const [links, setLinks] = useState([]);
  const [tables, setTables] = useState([]);
  const [rules, setRules] = useState([]);
  const [stockItems, setStockItems] = useState([]);
  useEffect(() => { supabase.from('pms_stock_items').select('id, name, unit').eq('property_id', property.id).eq('active', true).order('name').then(({ data }) => setStockItems(data ?? [])); }, [property.id]);
  useEffect(() => { supabase.from('pms_stock_locations').select('id, name').eq('property_id', property.id).eq('active', true).order('name').then(({ data }) => setLocs(data ?? [])); }, [property.id]);
  const load = useCallback(async () => {
    const { data: o } = await supabase.from('pms_pos_outlets').select('*').eq('property_id', property.id).order('name');
    setOutlets(o ?? []);
    const first = outlet || o?.[0]?.id || '';
    setOutlet(first);
    if (first) {
      const [i, c, g, t, r] = await Promise.all([
        supabase.from('pms_pos_items').select('*').eq('outlet_id', first).order('group_name').order('sort_order').order('name'),
        supabase.from('pms_pos_categories').select('*').eq('outlet_id', first).order('sort_order').order('name'),
        supabase.from('pms_pos_modifier_groups').select('*').eq('outlet_id', first).order('name'),
        supabase.from('pms_pos_tables').select('*').eq('outlet_id', first).order('zone').order('sort_order').order('name'),
        supabase.from('pms_pos_price_rules').select('*').eq('outlet_id', first).order('starts'),
      ]);
      setItems(i.data ?? []); setCats(c.data ?? []); setGroups(g.data ?? []); setTables(t.data ?? []); setRules(r.data ?? []);
      const gids = (g.data ?? []).map((x) => x.id);
      const [m, l] = await Promise.all([
        gids.length ? supabase.from('pms_pos_modifiers').select('*').in('group_id', gids).order('sort_order').order('name') : { data: [] },
        gids.length ? supabase.from('pms_pos_item_modifier_groups').select('*').in('group_id', gids) : { data: [] },
      ]);
      setMods(m.data ?? []); setLinks(l.data ?? []);
    }
  }, [property.id, outlet]);
  useEffect(() => { load(); }, [load]);
  const activityOutlet = ACTIVITY.has(outlets.find((o) => o.id === outlet)?.outlet_type);
  const showActivity = activityOutlet || items.some((i) => i.item_type && i.item_type !== 'product');
  return (
    <>
      <h3 className="first">Outlets</h3>
      <EditableList table="pms_pos_outlets" rows={outlets} onSaved={load} blank={{ name: '', outlet_type: 'restaurant', charge_category: 'fnb', stock_location_id: '', service_charge_pct: 0, uses_tables: false, active: true }}
        fields={[{ key: 'name', label: 'Outlet' }, { key: 'outlet_type', label: 'Type', options: OUTLET_TYPES },
          { key: 'charge_category', label: 'Department (on the folio)', options: DEPARTMENTS },
          { key: 'stock_location_id', label: 'Takes stock from', options: [['', 'No stock tracking'], ...locs.map((l) => [l.id, l.name])] },
          { key: 'service_charge_pct', label: 'Service %', type: 'number' },
          { key: 'uses_tables', label: 'Tables', type: 'bool' },
          { key: 'active', label: 'Active', type: 'bool' }]} />
      <p className="small muted">Recipes for each menu item are set under Kitchen and bar stock → Recipes. Gyms, pools, games rooms and spas usually post to Recreation or Spa.</p>
      {outlets.length > 0 && <>
        <div className="row-gap"><h3>Menu for</h3>
          <select className="auto" value={outlet} onChange={(e) => setOutlet(e.target.value)}>{outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
        <EditableList table="pms_pos_items" rows={items} onSaved={load} extra={{ outlet_id: outlet }}
          blank={{ name: '', category_id: '', station: '', barcode: '', available: true, price: '', item_type: activityOutlet ? 'service' : 'product', duration_minutes: '', min_units: 1, grace_minutes: 0, resources: '', validity_days: '', visits_included: '', sort_order: 0, active: true }}
          fields={[{ key: 'name', label: 'Item' }, { key: 'category_id', label: 'Category', options: [['', '—'], ...cats.map((c) => [c.id, c.name])] },
            { key: 'price', label: 'Price', type: 'number' },
            { key: 'station', label: 'Goes to', options: [['', 'As category'], ['kitchen', 'Kitchen'], ['bar', 'Bar'], ['none', 'No station']] },
            { key: 'barcode', label: 'Barcode' }, { key: 'available', label: 'Available', type: 'bool' },
            ...(showActivity ? [
              { key: 'item_type', label: 'Sold as', options: ITEM_TYPES },
              { key: 'duration_minutes', label: 'Block (min)', type: 'optnumber', placeholder: '30', hidden: (r) => r.item_type !== 'timed' },
              { key: 'min_units', label: 'Min blocks', type: 'number', hidden: (r) => r.item_type !== 'timed' },
              { key: 'grace_minutes', label: 'Grace (min)', type: 'number', hidden: (r) => r.item_type !== 'timed' },
              { key: 'resources', label: 'Tables / courts', type: 'list', placeholder: 'Table 1, Table 2' },
              { key: 'validity_days', label: 'Days', type: 'optnumber', placeholder: '30', hidden: (r) => r.item_type !== 'membership' },
              { key: 'visits_included', label: 'Visits', type: 'optnumber', placeholder: 'Unlimited', hidden: (r) => r.item_type !== 'membership' },
            ] : []),
            { key: 'sort_order', label: 'Order', type: 'number' }, { key: 'active', label: 'Active', type: 'bool' }]} />
        <MenuPhotos items={items} outletType={outlets.find((o) => o.id === outlet)?.outlet_type} onSaved={load} />
        <h3>Categories</h3>
        <p className="small muted">Each category sends its items to the kitchen screen, the bar screen, or nowhere (drinks from the fridge, services).</p>
        <EditableList table="pms_pos_categories" rows={cats} onSaved={load} extra={{ outlet_id: outlet }} blank={{ name: '', station: 'kitchen', sort_order: 0, active: true }}
          fields={[{ key: 'name', label: 'Category' }, { key: 'station', label: 'Goes to', options: [['kitchen', 'Kitchen'], ['bar', 'Bar'], ['none', 'No station']] },
            { key: 'sort_order', label: 'Order', type: 'number' }, { key: 'active', label: 'Active', type: 'bool' }]} />
        <h3>Options</h3>
        <p className="small muted">Groups such as "Cooking" (choose 1, required) or "Extras" (up to 3). Options can cost extra and take stock (extra cheese uses 0.03 kg of cheese).</p>
        <EditableList table="pms_pos_modifier_groups" rows={groups} onSaved={load} extra={{ outlet_id: outlet }} blank={{ name: '', min_choices: 0, max_choices: 1, active: true }}
          fields={[{ key: 'name', label: 'Group' }, { key: 'min_choices', label: 'At least', type: 'number' }, { key: 'max_choices', label: 'At most', type: 'number' }, { key: 'active', label: 'Active', type: 'bool' }]} />
        {groups.length > 0 && <EditableList table="pms_pos_modifiers" rows={mods} onSaved={load} blank={{ group_id: groups[0].id, name: '', price: 0, stock_item_id: '', stock_qty: '', sort_order: 0, active: true }}
          fields={[{ key: 'group_id', label: 'Group', options: groups.map((g) => [g.id, g.name]) }, { key: 'name', label: 'Option' }, { key: 'price', label: 'Extra price', type: 'number' },
            { key: 'stock_item_id', label: 'Uses stock', options: [['', '—'], ...stockItems.map((x) => [x.id, `${x.name} (${x.unit})`])] },
            { key: 'stock_qty', label: 'Amount', type: 'optnumber' }, { key: 'sort_order', label: 'Order', type: 'number' }, { key: 'active', label: 'Active', type: 'bool' }]} />}
        {groups.length > 0 && <ItemOptions items={items} groups={groups} links={links} onSaved={load} />}
        {outlets.find((o) => o.id === outlet)?.uses_tables && <>
          <h3>Tables</h3>
          <EditableList table="pms_pos_tables" rows={tables} onSaved={load} extra={{ outlet_id: outlet }} blank={{ name: '', zone: '', seats: 4, sort_order: 0, active: true }}
            fields={[{ key: 'name', label: 'Table' }, { key: 'zone', label: 'Area' }, { key: 'seats', label: 'Seats', type: 'number' }, { key: 'sort_order', label: 'Order', type: 'number' }, { key: 'active', label: 'Active', type: 'bool' }]} />
        </>}
        <h3>Happy hours and time prices</h3>
        <p className="small muted">A percentage off, or a fixed price, for a category or one item, on chosen days between two times (can run past midnight).</p>
        <EditableList table="pms_pos_price_rules" rows={rules.map((r) => ({ ...r, days: (r.days ?? []).join(', ') }))} onSaved={load} extra={{ outlet_id: outlet }}
          blank={{ name: '', category_id: '', item_id: '', days: '0, 1, 2, 3, 4, 5, 6', starts: '17:00', ends: '19:00', kind: 'percent', value: 50, active: true }}
          fields={[{ key: 'name', label: 'Name' }, { key: 'category_id', label: 'Category', options: [['', 'All'], ...cats.map((c) => [c.id, c.name])] },
            { key: 'item_id', label: 'Or item', options: [['', '—'], ...items.map((i) => [i.id, i.name])] },
            { key: 'days', label: 'Days (0 = Sun)', type: 'list' }, { key: 'starts', label: 'From', type: 'time' }, { key: 'ends', label: 'To', type: 'time' },
            { key: 'kind', label: 'Kind', options: [['percent', '% off'], ['price', 'Price']] }, { key: 'value', label: 'Value', type: 'number' }, { key: 'active', label: 'On', type: 'bool' }]} />
        {showActivity && <p className="small muted">"By the clock" items start and stop on the till (e.g. pool table per 30 minutes; list the tables so two games can't share one).
          "Membership or pass" items ask for the member's name and start when paid; members are checked in under "Door and members".</p>}
      </>}
    </>
  );
}

// Which option groups each item asks for
function ItemOptions({ items, groups, links, onSaved }) {
  const { property } = useProperty();
  const [run, busy] = useAction();
  const has = (i, g) => links.some((l) => l.item_id === i && l.group_id === g);
  const toggle = (i, g) => run(async () => {
    const { error } = has(i, g)
      ? await supabase.from('pms_pos_item_modifier_groups').delete().eq('item_id', i).eq('group_id', g)
      : await supabase.from('pms_pos_item_modifier_groups').insert({ property_id: property.id, item_id: i, group_id: g });
    if (error) throw error;
  }).then(onSaved).catch(() => {});
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Item asks for</th>{groups.map((g) => <th key={g.id} className="num">{g.name}</th>)}</tr></thead>
        <tbody>{items.filter((i) => !i.item_type || i.item_type === 'product' || i.item_type === 'service').map((i) => (
          <tr key={i.id}><td>{i.name}</td>{groups.map((g) => <td key={g.id} className="num"><input type="checkbox" disabled={busy} checked={has(i.id, g.id)} onChange={() => toggle(i.id, g.id)} aria-label={`${i.name}: ${g.name}`} /></td>)}</tr>))}</tbody>
      </table>
    </div>
  );
}

// Photos for menu items: take one with the phone camera or choose a file. Resized in the browser
// (longest side 900 px, JPEG) and kept in the property's public media folder.
async function shrink(file) {
  const img = await new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = URL.createObjectURL(file); });
  const k = Math.min(1, 900 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  return new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.82));
}
function MenuPhotos({ items, outletType, onSaved }) {
  const { property } = useProperty();
  const [run, busy] = useAction();
  if (!items.length) return null;
  const upload = (item, file) => file && run(async () => {
    if (!/^image\//.test(file.type)) throw new Error('Choose a photo (JPEG, PNG or WebP)');
    if (file.size > 15 * 1024 * 1024) throw new Error('That photo is over 15 MB');
    const blob = await shrink(file);
    const path = `${property.id}/pos/${item.id}-${Date.now()}.jpg`;
    const { error } = await supabase.storage.from('property-media').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
    if (error) throw error;
    const url = supabase.storage.from('property-media').getPublicUrl(path).data.publicUrl;
    const { error: e2 } = await supabase.from('pms_pos_items').update({ image_url: url }).eq('id', item.id);
    if (e2) throw e2;
  }, 'Photo saved').then(onSaved).catch(() => {});
  const remove = (item) => run(async () => {
    const { error } = await supabase.from('pms_pos_items').update({ image_url: null }).eq('id', item.id);
    if (error) throw error;
  }, 'Photo removed').then(onSaved).catch(() => {});
  return (
    <div className="card menu-photos">
      <h3 className="first">Photos</h3>
      <p className="small muted">A real photo sells better and makes the till faster to read. Take it on a phone or choose a file; it is resized for you. Items without a photo show a drawing.</p>
      <div className="mp-grid">
        {items.filter((i) => i.active).map((i) => (
          <div key={i.id} className="mp-card">
            <span className="pos-pic">{i.image_url ? <img src={i.image_url} alt={i.name} loading="lazy" /> : <PosArt item={i} outletType={outletType} />}</span>
            <strong className="mp-name">{i.name}</strong>
            <div className="row-gap">
              <label className={`btn btn-small ${busy ? 'disabled' : ''}`}><Icon name="camera" size={14} /> {i.image_url ? 'Change' : 'Add photo'}
                <input type="file" accept="image/*" capture="environment" hidden disabled={busy} onChange={(e) => { upload(i, e.target.files?.[0]); e.target.value = ''; }} /></label>
              {i.image_url && <button className="link small danger" disabled={busy} onClick={() => remove(i)}>Remove</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
