import { useEffect, useState } from 'react';
import { rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { fmtDate, label, money } from '../lib/format';
import { PageHead, Table } from '../components/ui.jsx';

export default function Group() {
  const { switchProperty, version } = useProperty();
  const [rows, setRows] = useState(null);
  useEffect(() => { rpc('pms_group_snapshot').then(setRows).catch(() => setRows([])); }, [version]);

  const seesMoney = (rows ?? []).some((r) => r.revenue_last_audit != null);
  const m = (v) => (v == null ? '—' : money(v));
  const t = (k) => (rows ?? []).reduce((n, r) => n + Number(r[k] ?? 0), 0);
  return (
    <>
      <PageHead title="Group overview" sub="BMG Group International Limited — every property you have access to. Click a row to switch." />
      {rows && rows.length > 0 && (
        <div className="kpis">
          <div className="kpi"><span>Properties</span><strong>{rows.length}</strong></div>
          <div className="kpi"><span>Rooms</span><strong>{t('rooms')}</strong></div>
          <div className="kpi"><span>In house</span><strong>{t('in_house')}</strong></div>
          <div className="kpi"><span>Arrivals pending</span><strong>{t('arrivals')}</strong></div>
          {seesMoney && <div className="kpi"><span>Revenue (last audits)</span><strong>{money(t('revenue_last_audit'))}</strong></div>}
          {seesMoney && <div className="kpi"><span>Open folio balances</span><strong>{money(t('open_balance'))}</strong></div>}
        </div>
      )}
      <Table rows={rows} onRow={(r) => { switchProperty(r.property_id); window.location.hash = '/today'; }}
        footer={rows?.length ? { property: 'Total', rooms: t('rooms'), in_house: t('in_house'), arrivals: t('arrivals'), departures: t('departures'), revenue_last_audit: seesMoney ? money(t('revenue_last_audit')) : '', open_balance: seesMoney ? money(t('open_balance')) : '', dirty_rooms: t('dirty_rooms') } : undefined}
        columns={[
          { key: 'property', label: 'Property', render: (r) => <strong>{r.property}</strong> },
          { key: 'role', label: 'Your role', render: (r) => label(r.role) },
          { key: 'business_date', label: 'Business date', render: (r) => fmtDate(r.business_date) },
          { key: 'rooms', label: 'Rooms', num: true },
          { key: 'in_house', label: 'In house', num: true },
          { key: 'arrivals', label: 'Arrivals', num: true },
          { key: 'departures', label: 'Due out', num: true },
          { key: 'occupancy_pct', label: 'Occ. (last audit)', num: true, render: (r) => r.occupancy_pct + '%' },
          ...(seesMoney ? [
            { key: 'revenue_last_audit', label: 'Revenue (last audit)', num: true, render: (r) => m(r.revenue_last_audit) },
            { key: 'open_balance', label: 'Open balances', num: true, render: (r) => m(r.open_balance) },
          ] : []),
          { key: 'dirty_rooms', label: 'Dirty', num: true },
        ]} />
    </>
  );
}
