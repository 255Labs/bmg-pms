import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { useDesk } from '../lib/desk';
import { addDays, fmtDate, guestName, label, nightsBetween } from '../lib/format';
import { Badge, Field, PageHead, Table, statusKind } from '../components/ui.jsx';

const STATUSES = ['', 'confirmed', 'tentative', 'checked_in', 'checked_out', 'cancelled', 'no_show', 'partial'];

export default function Reservations() {
  const { property, version } = useProperty();
  const desk = useDesk();
  const [from, setFrom] = useState(addDays(property.business_date, -7));
  const [to, setTo] = useState(addDays(property.business_date, 30));
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState(null);

  useEffect(() => {
    let live = true;
    setRows(null);
    let q = supabase.from('pms_reservations')
      .select('id,res_no,arrival,departure,status,created_at,pms_guests(title,first_name,last_name,phone),pms_business_sources(name),pms_companies(name),pms_stays(id,pms_rooms(number))')
      .eq('property_id', property.id).lte('arrival', to).gte('departure', from)
      .order('arrival').order('res_no').limit(500);
    if (status) q = q.eq('status', status);
    q.then(({ data }) => live && setRows(data ?? []));
    return () => { live = false; };
  }, [property.id, from, to, status, version]);

  return (
    <>
      <PageHead title="Reservations" sub="Bookings overlapping the selected dates">
        <button className="btn btn-primary" onClick={() => desk.newReservation({})}>New reservation</button>
      </PageHead>
      <div className="filters">
        <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => <option key={s} value={s}>{s ? label(s) : 'All'}</option>)}
          </select>
        </Field>
      </div>
      <Table rows={rows} onRow={(r) => desk.openReservation(r.id)} empty="No reservations in this range"
        columns={[
          { key: 'res_no', label: 'Res #', render: (r) => <strong>#{r.res_no}</strong> },
          { key: 'guest', label: 'Guest', render: (r) => <>{guestName(r.pms_guests)}<div className="small muted">{r.pms_guests?.phone}</div></> },
          { key: 'rooms', label: 'Rooms', render: (r) => r.pms_stays.map((s) => s.pms_rooms?.number ?? '—').join(', ') },
          { key: 'arrival', label: 'Arrival', render: (r) => fmtDate(r.arrival) },
          { key: 'departure', label: 'Departure', render: (r) => fmtDate(r.departure) },
          { key: 'nights', label: 'Nights', num: true, render: (r) => nightsBetween(r.arrival, r.departure) },
          { key: 'source', label: 'Source', render: (r) => r.pms_companies?.name ?? r.pms_business_sources?.name ?? '' },
          { key: 'status', label: 'Status', render: (r) => <Badge kind={statusKind(r.status)}>{label(r.status)}</Badge> },
        ]} />
    </>
  );
}
