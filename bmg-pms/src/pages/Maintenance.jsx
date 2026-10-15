import { useCallback, useEffect, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { addDays, can, fmtDate, label } from '../lib/format';
import { Badge, Field, PageHead, Table, useAction } from '../components/ui.jsx';

export default function Maintenance() {
  const { property, lookups, role, refresh } = useProperty();
  const [run, busy] = useAction();
  const [rows, setRows] = useState(null);
  const [f, setF] = useState({ room: '', from: property.business_date, to: addDays(property.business_date, 1), reason: '' });

  const load = useCallback(() => supabase.from('pms_maintenance_blocks').select('*, pms_rooms(number)')
    .eq('property_id', property.id).order('from_date', { ascending: false }).limit(200)
    .then(({ data }) => setRows(data ?? [])), [property.id]);
  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageHead title="Maintenance blocks" sub="Blocked rooms cannot be sold and are excluded from available inventory." />
      {can(role, 'block') && (
        <form className="card inline-form" onSubmit={(e) => {
          e.preventDefault();
          run(() => rpc('pms_block_room', { p_room: f.room, p_from: f.from, p_to: f.to, p_reason: f.reason }), 'Room blocked')
            .then(() => { setF({ ...f, reason: '' }); load(); refresh(); }).catch(() => {});
        }}>
          <Field label="Room">
            <select required value={f.room} onChange={(e) => setF({ ...f, room: e.target.value })}>
              <option value="">Select…</option>
              {lookups.rooms.filter((r) => r.active).map((r) => <option key={r.id} value={r.id}>{r.number}</option>)}
            </select>
          </Field>
          <Field label="From"><input type="date" required value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="Until (exclusive)"><input type="date" required min={addDays(f.from, 1)} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          <Field label="Reason"><input required value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. AC repair" /></Field>
          <button className="btn btn-primary" disabled={busy}>Block room</button>
        </form>
      )}
      <Table rows={rows} empty="No maintenance blocks" columns={[
        { key: 'room', label: 'Room', render: (b) => <strong>{b.pms_rooms?.number}</strong> },
        { key: 'from_date', label: 'From', render: (b) => fmtDate(b.from_date) },
        { key: 'to_date', label: 'Until', render: (b) => fmtDate(b.to_date) },
        { key: 'reason', label: 'Reason' },
        { key: 'status', label: 'Status', render: (b) => <Badge kind={b.status === 'active' ? 'red' : 'grey'}>{label(b.status)}</Badge> },
        { key: 'act', label: '', render: (b) => b.status === 'active' && can(role, 'block') && (
          <button className="link" onClick={() => run(() => rpc('pms_release_block', { p_block: b.id }), 'Block released').then(() => { load(); refresh(); }).catch(() => {})}>Release</button>
        ) },
      ]} />
    </>
  );
}

