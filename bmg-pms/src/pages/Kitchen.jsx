import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { can } from '../lib/format';
import { Loading, PageHead, useAction } from '../components/ui.jsx';

// Kitchen and bar display: orders as tickets, oldest first. Start → Ready; the waiter marks them served.
// Refreshes itself; tickets turn amber after 10 minutes and red after 20.
const STATIONS = [['', 'All'], ['kitchen', 'Kitchen'], ['bar', 'Bar']];
const NEXT = { sent: ['preparing', 'Start'], preparing: ['ready', 'Ready'], ready: ['served', 'Served'] };

export default function Kitchen() {
  const { property, role } = useProperty();
  const [run, busy] = useAction();
  const [station, setStation] = useState(() => { try { return localStorage.getItem('pms.kds.station') ?? ''; } catch { return ''; } });
  const [lines, setLines] = useState(null);
  const [soldOut, setSoldOut] = useState([]);
  const [showOut, setShowOut] = useState(false);
  const load = useCallback(() => rpc('pms_pos_kitchen', { p_property: property.id, p_station: station || null }).then(setLines).catch(() => setLines([])), [property.id, station]);
  const loadOut = useCallback(() => supabase.from('pms_pos_items').select('id, name, available, outlet_id').eq('property_id', property.id).eq('active', true).order('name')
    .then(({ data }) => setSoldOut(data ?? [])), [property.id]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  useEffect(() => { loadOut(); }, [loadOut]);
  useEffect(() => { try { localStorage.setItem('pms.kds.station', station); } catch { /* storage unavailable */ } }, [station]);

  const tickets = useMemo(() => {
    const t = new Map();
    for (const l of lines ?? []) {
      const k = `${l.bill_id}:${l.ticket_no}:${l.station}`;
      if (!t.has(k)) t.set(k, { key: k, bill_no: l.bill_no, table: l.table_name, outlet: l.outlet, ticket: l.ticket_no, station: l.station, sent_at: l.sent_at, minutes: l.minutes, lines: [] });
      t.get(k).lines.push(l);
    }
    return [...t.values()];
  }, [lines]);
  const bump = (ids, status) => run(() => rpc('pms_pos_kitchen_bump', { p_lines: ids, p_status: status })).then(load).catch(() => {});

  if (!can(role, 'kitchen')) return <><PageHead title="Kitchen and bar display" /><p>Ask a manager for the kitchen display ability.</p></>;
  return (
    <>
      <PageHead title="Kitchen and bar display" sub="Orders from the tills, oldest first. Start a ticket when you begin; mark it ready when it can go out.">
        <div className="view-switch" role="radiogroup" aria-label="Station">
          {STATIONS.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={station === v} className={station === v ? 'on' : ''} onClick={() => setStation(v)}>{l}</button>)}
        </div>
        <button className="btn" onClick={() => setShowOut(!showOut)}>{showOut ? 'Hide' : 'Sold out items'}</button>
      </PageHead>
      {showOut && (
        <div className="card kds-out">
          <p className="small muted">Tap an item to take it off the menus while you have run out, and again to bring it back.</p>
          <div className="kds-tags">
            {soldOut.map((i) => (
              <button key={i.id} type="button" className={`kds-tag ${i.available ? "" : "off"}`} disabled={busy}
                onClick={() => run(() => rpc('pms_pos_set_available', { p_item: i.id, p_available: !i.available }), i.available ? `${i.name} is sold out` : `${i.name} is back`).then(loadOut).catch(() => {})}>
                {i.available ? i.name : `${i.name} · sold out`}
              </button>
            ))}
          </div>
        </div>
      )}
      {!lines ? <Loading /> : tickets.length === 0 ? <div className="empty">No orders waiting. New orders appear here by themselves.</div> : (
        <div className="kds">
          {tickets.map((t) => {
            const live = t.lines.filter((l) => l.status !== 'ready');
            const age = Math.max(...t.lines.map((l) => l.minutes));
            return (
              <article key={t.key} className={`kds-ticket ${age >= 20 ? 'late' : age >= 10 ? 'slow' : ''} ${live.length === 0 ? 'done' : ''}`}>
                <header>
                  <strong>{t.table}</strong>
                  <span className="small">#{t.bill_no} · round {t.ticket} · {t.station === 'bar' ? 'Bar' : 'Kitchen'}</span>
                  <span className="kds-age">{age} min</span>
                </header>
                <ul>
                  {t.lines.map((l) => (
                    <li key={l.line_id} className={`kds-line st-${l.status}`}>
                      <span className="kds-qty">{Number(l.qty)}×</span>
                      <span className="kds-item">
                        {l.item}
                        {(l.course > 1 || l.seat) && <span className="small muted"> · {l.course > 1 ? `course ${l.course}` : ''}{l.course > 1 && l.seat ? ', ' : ''}{l.seat ? `seat ${l.seat}` : ''}</span>}
                        {l.note && <span className="kds-note">{l.note}</span>}
                      </span>
                      {NEXT[l.status] && <button className="btn btn-small" disabled={busy} onClick={() => bump([l.line_id], NEXT[l.status][0])}>{NEXT[l.status][1]}</button>}
                    </li>
                  ))}
                </ul>
                <footer>
                  {t.lines.some((l) => l.status === 'sent') && <button className="btn" disabled={busy} onClick={() => bump(t.lines.filter((l) => l.status === 'sent').map((l) => l.line_id), 'preparing')}>Start all</button>}
                  {t.lines.some((l) => l.status !== 'ready') && <button className="btn btn-primary" disabled={busy} onClick={() => bump(t.lines.filter((l) => l.status !== 'ready').map((l) => l.line_id), 'ready')}>All ready</button>}
                  {t.lines.every((l) => l.status === 'ready') && <span className="small">Ready: waiting for the waiter</span>}
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
