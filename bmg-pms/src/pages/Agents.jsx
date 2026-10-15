import { useCallback, useEffect, useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { useDesk } from '../lib/desk';
import { addDays, can, downloadCSV, fmtDate, money } from '../lib/format';
import { Field, PageHead, Table, Tabs } from '../components/ui.jsx';
import { EditableList } from './Setup.jsx';

export default function Agents() {
  const { property, role } = useProperty();
  const desk = useDesk();
  const [tab, setTab] = useState('commission');
  const [agents, setAgents] = useState([]);
  const [sales, setSales] = useState([]);
  const [from, setFrom] = useState(property.business_date.slice(0, 8) + '01');
  const [to, setTo] = useState(addDays(property.business_date, -1) < property.business_date.slice(0, 8) + '01' ? property.business_date : addDays(property.business_date, -1));
  const [rows, setRows] = useState(null);

  const loadLists = useCallback(async () => {
    const [a, s] = await Promise.all([
      supabase.from('pms_travel_agents').select('*').eq('property_id', property.id).order('name'),
      supabase.from('pms_sales_persons').select('*').eq('property_id', property.id).order('name'),
    ]);
    setAgents(a.data ?? []); setSales(s.data ?? []);
  }, [property.id]);
  useEffect(() => { loadLists(); }, [loadLists]);
  useEffect(() => {
    if (tab !== 'commission') return;
    setRows(null);
    rpc('pms_rpt_commission', { p_property: property.id, p_from: from, p_to: to }).then(setRows).catch(() => setRows([]));
  }, [tab, property.id, from, to]);

  const sum = (k) => money((rows ?? []).reduce((n, r) => n + Number(r[k] ?? 0), 0));
  return (
    <>
      <PageHead title="Agents and commission" sub="Travel agents and sales people on bookings, and the commission owed on room revenue posted in the period." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'commission', label: 'Commission' }, { value: 'agents', label: 'Travel agents' }, { value: 'sales', label: 'Sales people' }]} />
      {tab === 'commission' && <>
        <div className="filters">
          <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
          <button className="btn" disabled={!rows?.length} onClick={() => downloadCSV(`commission-${from}-${to}.csv`, rows)}>Export CSV</button>
        </div>
        <Table rows={rows} empty="No commissionable bookings in this period. Add an agent to a booking under Booking details."
          footer={{ party: 'Total', room_revenue: sum('room_revenue'), commission: sum('commission') }}
          columns={[
            { key: 'party', label: 'Agent or source', render: (r) => <><strong>{r.party}</strong><div className="small muted">{r.party_type}</div></> },
            { key: 'res_no', label: 'Res #', render: (r) => <button className="link" onClick={async () => {
              const { data } = await supabase.from('pms_reservations').select('id').eq('property_id', property.id).eq('res_no', r.res_no).single();
              if (data) desk.openReservation(data.id);
            }}>#{r.res_no}</button> },
            { key: 'guest', label: 'Guest' },
            { key: 'dates', label: 'Stay', render: (r) => `${fmtDate(r.arrival)} – ${fmtDate(r.departure)}` },
            { key: 'sales_person', label: 'Sales person' },
            { key: 'room_revenue', label: 'Room revenue', num: true, render: (r) => money(r.room_revenue) },
            { key: 'commission_pct', label: 'Rate', num: true, render: (r) => `${Number(r.commission_pct)}%` },
            { key: 'commission', label: 'Commission', num: true, render: (r) => money(r.commission) },
          ]} />
      </>}
      {tab === 'agents' && (can(role, 'setup')
        ? <EditableList table="pms_travel_agents" rows={agents} onSaved={loadLists} blank={{ name: '', contact_name: '', phone: '', email: '', commission_pct: 10, active: true }}
            fields={[{ key: 'name', label: 'Agency' }, { key: 'contact_name', label: 'Contact' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
              { key: 'commission_pct', label: 'Commission %', type: 'number' }, { key: 'active', label: 'Active', type: 'bool' }]} />
        : <Table rows={agents} columns={[{ key: 'name', label: 'Agency' }, { key: 'phone', label: 'Phone' }, { key: 'commission_pct', label: 'Commission %', num: true }]} />)}
      {tab === 'sales' && (can(role, 'setup')
        ? <EditableList table="pms_sales_persons" rows={sales} onSaved={loadLists} blank={{ name: '', phone: '', email: '', active: true }}
            fields={[{ key: 'name', label: 'Name' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' }, { key: 'active', label: 'Active', type: 'bool' }]} />
        : <Table rows={sales} columns={[{ key: 'name', label: 'Name' }, { key: 'phone', label: 'Phone' }]} />)}
    </>
  );
}
