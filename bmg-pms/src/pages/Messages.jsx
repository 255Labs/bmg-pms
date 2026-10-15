import { useCallback, useEffect, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { useDesk } from '../lib/desk';
import { fmtDateTime } from '../lib/format';
import { Badge, Field, PageHead, Table, Tabs, useAction } from '../components/ui.jsx';

export default function Messages() {
  const { property, user } = useProperty();
  const desk = useDesk();
  const [run, busy] = useAction();
  const [tab, setTab] = useState('pending');
  const [rows, setRows] = useState(null);
  const [guests, setGuests] = useState([]);
  const [f, setF] = useState({ reservation: '', from: '', message: '' });

  const load = useCallback(() => supabase.from('pms_guest_messages')
    .select('*, pms_reservations(id,res_no,pms_guests(title,first_name,last_name))').eq('property_id', property.id).eq('status', tab)
    .order('created_at', { ascending: false }).limit(200).then(({ data }) => setRows(data ?? [])), [property.id, tab]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    rpc('pms_inhouse_guests', { p_property: property.id })
      .then((r) => setGuests(r ?? [])).catch(() => {});
  }, [property]);

  const deliver = (m) => run(async () => {
    const { error } = await supabase.from('pms_guest_messages').update({ status: 'delivered', delivered_at: new Date().toISOString() }).eq('id', m.id);
    if (error) throw error; load();
  }, 'Marked as delivered').catch(() => {});

  return (
    <>
      <PageHead title="Guest messages" sub="Take a message for an in-house guest and mark it delivered when they have it." />
      <form className="card inline-form" onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const { error } = await supabase.from('pms_guest_messages').insert({ property_id: property.id, reservation_id: f.reservation, from_name: f.from || null, message: f.message, taken_by: user.id });
          if (error) throw error;
          setF({ reservation: '', from: '', message: '' }); setTab('pending'); load();
        }, 'Message saved').catch(() => {});
      }}>
        <Field label="For guest">
          <select required value={f.reservation} onChange={(e) => setF({ ...f, reservation: e.target.value })}>
            <option value="">Choose room…</option>
            {guests.map((g) => <option key={g.stay_id} value={g.reservation_id}>{g.room} · {g.guest}</option>)}
          </select>
        </Field>
        <Field label="From"><input value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} placeholder="Caller's name" /></Field>
        <Field label="Message"><input required value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></Field>
        <button className="btn btn-primary" disabled={busy}>Save message</button>
      </form>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'pending', label: 'Waiting' }, { value: 'delivered', label: 'Delivered' }]} />
      <Table rows={rows} empty={tab === 'pending' ? 'No messages waiting.' : 'Nothing delivered yet.'} columns={[
        { key: 'guest', label: 'Guest', render: (m) => <button className="link" onClick={() => desk.openReservation(m.reservation_id)}>
          {[m.pms_reservations?.pms_guests?.title, m.pms_reservations?.pms_guests?.first_name, m.pms_reservations?.pms_guests?.last_name].filter(Boolean).join(' ')}</button> },
        { key: 'from_name', label: 'From' },
        { key: 'message', label: 'Message' },
        { key: 'created_at', label: 'Taken', render: (m) => fmtDateTime(m.created_at) },
        { key: 'status', label: '', render: (m) => (m.status === 'pending' ? <button className="btn btn-small" onClick={() => deliver(m)}>Mark delivered</button>
          : <Badge kind="grey">Delivered {fmtDateTime(m.delivered_at)}</Badge>) },
      ]} />
    </>
  );
}
