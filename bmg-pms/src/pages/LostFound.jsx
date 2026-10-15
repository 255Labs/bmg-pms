import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { fmtDate, label } from '../lib/format';
import { Badge, Field, PageHead, Table, Tabs, useAction } from '../components/ui.jsx';

export default function LostFound() {
  const { property, lookups, user } = useProperty();
  const [run, busy] = useAction();
  const [tab, setTab] = useState('stored');
  const [rows, setRows] = useState(null);
  const [f, setF] = useState({ description: '', location: '', room_id: '', found_by: '', found_on: property.business_date });
  const load = useCallback(() => supabase.from('pms_lost_found').select('*, pms_rooms(number)').eq('property_id', property.id).eq('status', tab)
    .order('found_on', { ascending: false }).limit(300).then(({ data }) => setRows(data ?? [])), [property.id, tab]);
  useEffect(() => { load(); }, [load]);
  const close = (item, status) => {
    const who = status === 'returned' ? window.prompt('Returned to (name and ID or phone)') : (window.confirm(`Dispose of ${item.description}? This cannot be undone.`) ? 'disposed' : null);
    if (!who) return;
    run(async () => {
      const { error } = await supabase.from('pms_lost_found').update({ status, returned_to: status === 'returned' ? who : null, returned_on: property.business_date }).eq('id', item.id);
      if (error) throw error; load();
    }, status === 'returned' ? 'Marked as returned' : 'Marked as disposed').catch(() => {});
  };
  return (
    <>
      <PageHead title="Lost and found" sub="Log anything left behind, then record who collected it." />
      <form className="card inline-form" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const { error } = await supabase.from('pms_lost_found').insert({ property_id: property.id, description: f.description, location: f.location || null,
            room_id: f.room_id || null, found_by: f.found_by || null, found_on: f.found_on, created_by: user.id });
          if (error) throw error;
          setF({ ...f, description: '', location: '', room_id: '' }); setTab('stored'); load();
        }, 'Item logged').catch(() => {});
      }}>
        <Field label="Item"><input required value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="e.g. Black sunglasses" /></Field>
        <Field label="Room"><select value={f.room_id} onChange={(e) => setF({ ...f, room_id: e.target.value })}><option value="">—</option>{lookups.rooms.map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}</select></Field>
        <Field label="Or place found"><input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="e.g. Pool deck" /></Field>
        <Field label="Found by"><input value={f.found_by} onChange={(e) => setF({ ...f, found_by: e.target.value })} /></Field>
        <Field label="Date"><input type="date" value={f.found_on} onChange={(e) => setF({ ...f, found_on: e.target.value })} /></Field>
        <button className="btn btn-primary" disabled={busy}>Log item</button>
      </form>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'stored', label: 'In store' }, { value: 'returned', label: 'Returned' }, { value: 'disposed', label: 'Disposed' }]} />
      <Table rows={rows} empty="Nothing here." columns={[
        { key: 'found_on', label: 'Found', render: (i) => fmtDate(i.found_on) },
        { key: 'description', label: 'Item', render: (i) => <strong>{i.description}</strong> },
        { key: 'where', label: 'Where', render: (i) => (i.pms_rooms?.number ? `Room ${i.pms_rooms.number}` : i.location) },
        { key: 'found_by', label: 'Found by' },
        { key: 'status', label: '', render: (i) => (i.status === 'stored'
          ? <span className="row-gap"><button className="btn btn-small" onClick={() => close(i, 'returned')}>Hand back to owner</button><button className="link" onClick={() => close(i, 'disposed')}>Dispose</button></span>
          : <Badge kind="grey">{label(i.status)}{i.returned_to && i.status === 'returned' ? ` to ${i.returned_to}` : ''}</Badge>) },
      ]} />
    </>
  );
}
