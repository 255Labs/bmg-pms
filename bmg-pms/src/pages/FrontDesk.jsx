import { useEffect, useState } from 'react';
import { rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { useDesk } from '../lib/desk';
import { fmtDate, label, money } from '../lib/format';
import { Badge, PageHead, Table, Tabs, statusKind } from '../components/ui.jsx';

export default function FrontDesk({ params }) {
  const { property, version } = useProperty();
  const desk = useDesk();
  const [tab, setTab] = useState(params?.tab ?? 'arrivals');
  const [rows, setRows] = useState(null);
  const bd = property.business_date;

  useEffect(() => {
    let live = true;
    setRows(null);
    rpc('pms_rpt_stays', { p_property: property.id, p_kind: tab, p_from: bd, p_to: bd })
      .then((r) => live && setRows(tab === 'departures' ? r.filter((x) => x.status === 'checked_in') : tab === 'arrivals' ? r.filter((x) => ['confirmed', 'tentative', 'checked_in'].includes(x.status)) : r))
      .catch(() => live && setRows([]));
    return () => { live = false; };
  }, [property.id, tab, bd, version]);

  return (
    <>
      <PageHead title="Front desk" sub={`Business date ${fmtDate(bd)}`} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'arrivals', label: 'Arrivals today' }, { value: 'in_house', label: 'In house' }, { value: 'departures', label: 'Due out today' },
      ]} />
      <Table rows={rows} onRow={(r) => desk.openReservation(r.reservation_id)}
        empty={tab === 'arrivals' ? 'No arrivals pending today' : tab === 'departures' ? 'Nobody due out' : 'No guests in house'}
        columns={[
          { key: 'room', label: 'Room', render: (r) => r.room ? <strong>{r.room}</strong> : <span className="danger">Unassigned</span> },
          { key: 'guest', label: 'Guest', render: (r) => <>{r.guest}<div className="small muted">#{r.res_no} {r.phone ?? ''}</div></> },
          { key: 'room_type', label: 'Type' },
          { key: 'arrival', label: 'Arrival', render: (r) => fmtDate(r.arrival) },
          { key: 'departure', label: 'Departure', render: (r) => fmtDate(r.departure) },
          { key: 'pax', label: 'Pax', render: (r) => `${r.adults}${r.children ? '+' + r.children : ''}` },
          { key: 'company', label: 'Company / source', render: (r) => r.company ?? r.source ?? '' },
          { key: 'balance', label: 'Balance', num: true, render: (r) => <span className={Number(r.balance) > 0 ? 'danger' : ''}>{money(r.balance)}</span> },
          { key: 'status', label: 'Status', render: (r) => <Badge kind={statusKind(r.status)}>{label(r.status)}</Badge> },
        ]} />
    </>
  );
}
