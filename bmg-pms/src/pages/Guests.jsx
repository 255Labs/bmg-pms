import { useEffect, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { useDesk } from '../lib/desk';
import { can, fmtDate, guestName, label, safeTerm } from '../lib/format';
import { Badge, Field, Modal, PageHead, Table, statusKind, useAction } from '../components/ui.jsx';

export default function Guests() {
  const { property, role } = useProperty();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [edit, setEdit] = useState(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      let query = supabase.from('pms_guests').select('*, pms_reservations(id,res_no,arrival,status)')
        .eq('property_id', property.id).order('created_at', { ascending: false }).limit(200);
      const term = safeTerm(q);
      if (term) query = query.or(`first_name.ilike.%${term}%,last_name.ilike.%${term}%,phone.ilike.%${term}%,email.ilike.%${term}%,id_number.ilike.%${term}%`);
      const { data } = await query;
      if (live) setRows(data ?? []);
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [property.id, q, tick]);

  return (
    <>
      <PageHead title="Guest database" sub="Every guest who has booked at this property">
        <input className="search" placeholder="Search name, phone, email, ID" value={q} onChange={(e) => setQ(e.target.value)} />
      </PageHead>
      <Table rows={rows} onRow={(g) => setEdit(g)} empty="No guests found"
        columns={[
          { key: 'name', label: 'Guest', render: (g) => <strong>{guestName(g)}</strong> },
          { key: 'phone', label: 'Phone' },
          { key: 'email', label: 'Email' },
          { key: 'nationality', label: 'Nationality' },
          { key: 'id', label: 'ID', render: (g) => g.id_number ? `${g.id_type ?? ''} ${g.id_number}` : '' },
          { key: 'stays', label: 'Stays', num: true, render: (g) => g.pms_reservations.filter((r) => ['checked_in', 'checked_out'].includes(r.status)).length },
          { key: 'last', label: 'Last booking', render: (g) => fmtDate(g.pms_reservations.map((r) => r.arrival).sort().pop()) },
        ]} />
      {edit && <GuestEdit guest={edit} canEdit={['owner', 'manager', 'front_desk'].includes(role)} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); setTick((x) => x + 1); }} />}
    </>
  );
}

function GuestEdit({ guest, canEdit, onClose, onSaved }) {
  const desk = useDesk();
  const { role } = useProperty();
  const [run, busy] = useAction();
  const [g, setG] = useState(guest);
  const set = (k) => (e) => setG({ ...g, [k]: e.target.value });
  const save = (e) => {
    e.preventDefault();
    run(async () => {
      const { error } = await supabase.from('pms_guests').update({
        title: g.title, first_name: g.first_name, last_name: g.last_name, phone: g.phone, email: g.email,
        nationality: g.nationality, id_type: g.id_type, id_number: g.id_number, address: g.address, notes: g.notes,
      }).eq('id', g.id);
      if (error) throw error;
      onSaved();
    }, 'Guest saved');
  };
  return (
    <Modal title={guestName(guest)} onClose={onClose} wide
      footer={<><span /><div className="row-gap"><button className="btn" onClick={onClose}>Close</button>
        {canEdit && <button className="btn btn-primary" form="guest" disabled={busy}>Save</button>}</div></>}>
      <form id="guest" onSubmit={save}>
        <fieldset disabled={!canEdit} className="grid-4">
          <Field label="Title"><input value={g.title ?? ''} onChange={set('title')} /></Field>
          <Field label="First name"><input required value={g.first_name} onChange={set('first_name')} /></Field>
          <Field label="Last name"><input value={g.last_name ?? ''} onChange={set('last_name')} /></Field>
          <Field label="Phone"><input value={g.phone ?? ''} onChange={set('phone')} /></Field>
          <Field label="Email"><input type="email" value={g.email ?? ''} onChange={set('email')} /></Field>
          <Field label="Nationality"><input value={g.nationality ?? ''} onChange={set('nationality')} /></Field>
          <Field label="ID type"><input value={g.id_type ?? ''} onChange={set('id_type')} /></Field>
          <Field label="ID number"><input value={g.id_number ?? ''} onChange={set('id_number')} /></Field>
          <Field label="Address" span={2}><input value={g.address ?? ''} onChange={set('address')} /></Field>
          <Field label="Notes (preferences, VIP, etc.)" span={2}><input value={g.notes ?? ''} onChange={set('notes')} /></Field>
        </fieldset>
      </form>
      {can(role, 'res.merge_guests') && <MergeGuest guest={guest} onMerged={onSaved} />}
      <h4>Booking history</h4>
      <Table rows={[...guest.pms_reservations].sort((a, b) => b.arrival.localeCompare(a.arrival))}
        onRow={(r) => { onClose(); desk.openReservation(r.id); }} empty="No bookings"
        columns={[
          { key: 'res_no', label: 'Res #', render: (r) => '#' + r.res_no },
          { key: 'arrival', label: 'Arrival', render: (r) => fmtDate(r.arrival) },
          { key: 'status', label: 'Status', render: (r) => <Badge kind={statusKind(r.status)}>{label(r.status)}</Badge> },
        ]} />
    </Modal>
  );
}

// Duplicate profiles (same person typed in twice): their bookings, folios and files move here, gaps are filled in
function MergeGuest({ guest, onMerged }) {
  const { property } = useProperty();
  const [run, busy] = useAction();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setHits([]); return undefined; }
    const h = setTimeout(async () => {
      const like = `%${safeTerm(t)}%`;
      const { data } = await supabase.from('pms_guests').select('id,title,first_name,last_name,phone,email')
        .eq('property_id', property.id).neq('id', guest.id)
        .or(`first_name.ilike.${like},last_name.ilike.${like},phone.ilike.${like},email.ilike.${like}`).limit(8);
      setHits(data ?? []);
    }, 250);
    return () => clearTimeout(h);
  }, [q, guest.id, property.id]);
  const merge = (d) => window.confirm(`Merge ${guestName(d)} into ${guestName(guest)}? Their bookings move here and the duplicate is deleted.`)
    && run(() => rpc('pms_merge_guests', { p_keep: guest.id, p_drop: d.id }), 'Guests merged').then(onMerged).catch(() => {});
  return (
    <details className="merge-box">
      <summary>Same person entered twice? Merge a duplicate into this profile</summary>
      <input className="search" placeholder="Find the duplicate by name, phone or email" value={q} onChange={(e) => setQ(e.target.value)} />
      {hits.map((d) => (
        <div key={d.id} className="merge-hit">
          <span><strong>{guestName(d)}</strong> <span className="muted small">{[d.phone, d.email].filter(Boolean).join(' · ')}</span></span>
          <button className="btn btn-small" disabled={busy} onClick={() => merge(d)}>Merge into this guest</button>
        </div>
      ))}
    </details>
  );
}
