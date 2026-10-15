import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { can, money } from '../lib/format';
import { PageHead, Table, Tabs } from '../components/ui.jsx';
import { EditableList } from './Setup.jsx';

export default function Packages() {
  const { property, role, lookups } = useProperty();
  const [tab, setTab] = useState('packages');
  const [packages, setPackages] = useState([]);
  const [promos, setPromos] = useState([]);
  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.from('pms_packages').select('*').eq('property_id', property.id).order('name'),
      supabase.from('pms_promotions').select('*').eq('property_id', property.id).order('code'),
    ]);
    setPackages(a.data ?? []); setPromos(b.data ?? []);
  }, [property.id]);
  useEffect(() => { load(); }, [load]);
  const types = [['', 'Any room type'], ...lookups.roomTypes.map((t) => [t.id, t.name])];
  const edit = can(role, 'setup');
  return (
    <>
      <PageHead title="Packages and promotions" sub="Apply them to a booking from its Booking details tab. Packages set the room price; promotions take a percentage off." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'packages', label: 'Packages' }, { value: 'promotions', label: 'Promotion codes' }]} />
      {tab === 'packages' && (edit
        ? <EditableList table="pms_packages" rows={packages} onSaved={load}
            blank={{ name: '', room_type_id: '', price_mode: 'per_night', price: '', min_nights: 1, inclusions: '', valid_from: '', valid_to: '', active: true }}
            fields={[{ key: 'name', label: 'Package' }, { key: 'room_type_id', label: 'Room type', options: types },
              { key: 'price_mode', label: 'Price is', options: [['per_night', 'Per night'], ['per_stay', 'For the whole stay']] },
              { key: 'price', label: 'Price', type: 'number' }, { key: 'min_nights', label: 'Min nights', type: 'number' },
              { key: 'inclusions', label: 'Includes' }, { key: 'valid_from', label: 'Valid from', type: 'date' }, { key: 'valid_to', label: 'Valid to', type: 'date' }, { key: 'active', label: 'Active', type: 'bool' }]} />
        : <Table rows={packages} columns={[{ key: 'name', label: 'Package' }, { key: 'price', label: 'Price', num: true, render: (p) => money(p.price) }, { key: 'inclusions', label: 'Includes' }]} />)}
      {tab === 'promotions' && (edit
        ? <EditableList table="pms_promotions" rows={promos} onSaved={load}
            blank={{ code: '', name: '', discount_pct: 10, min_nights: 1, valid_from: '', valid_to: '', active: true }}
            fields={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'discount_pct', label: '% off', type: 'number' },
              { key: 'min_nights', label: 'Min nights', type: 'number' }, { key: 'valid_from', label: 'Arrivals from', type: 'date' }, { key: 'valid_to', label: 'Arrivals to', type: 'date' }, { key: 'active', label: 'Active', type: 'bool' }]} />
        : <Table rows={promos} columns={[{ key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'discount_pct', label: '% off', num: true }]} />)}
    </>
  );
}
