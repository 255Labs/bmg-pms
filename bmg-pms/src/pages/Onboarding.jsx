import { useState } from 'react';
import { rpc } from '../lib/supabase';
import { useProperty } from '../lib/property.jsx';
import { Field, useAction } from '../components/ui.jsx';

const blankType = () => ({ name: '', code: '', base_rate: '', max_occupancy: 2, rooms: '' });

export default function Onboarding({ onCancel, onDone }) {
  const { reloadProperties, switchProperty } = useProperty();
  const [run, busy] = useAction();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [display, setDisplay] = useState('');
  const [taxInclusive, setTaxInclusive] = useState(true);
  const [types, setTypes] = useState([
    { name: 'Single', code: 'SGL', base_rate: '200000', max_occupancy: 1, rooms: '331-334, 336-339' },
    { name: 'Double', code: 'DBL', base_rate: '300000', max_occupancy: 2, rooms: '335, 340' },
  ]);

  const set = (i, k, v) => setTypes((t) => t.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  // "101-105, 201" → ["101","102",...,"201"]
  const expandRooms = (s) => s.split(',').map((p) => p.trim()).filter(Boolean).flatMap((p) => {
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (!m) return [p];
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (b < a || b - a > 500) return [p];
    return Array.from({ length: b - a + 1 }, (_, k) => String(a + k));
  });

  const totalRooms = types.reduce((n, t) => n + expandRooms(t.rooms).length, 0);

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      const setup = types.filter((t) => t.name.trim()).map((t) => ({
        name: t.name.trim(), code: t.code.trim(), base_rate: Number(t.base_rate || 0),
        max_occupancy: Number(t.max_occupancy || 2), rooms: expandRooms(t.rooms),
      }));
      const id = await rpc('pms_create_property', {
        p_name: name, p_code: code || null, p_display_name: display || null,
        p_room_setup: setup, p_tax_inclusive: taxInclusive,
      });
      await reloadProperties();
      switchProperty(id);
      onDone?.();
    }, 'Property created');
  };

  return (
    <div className="center-screen">
      <form className="card onboarding" onSubmit={submit}>
        <h2>Set up a property</h2>
        <p className="muted">You become the owner. You can add staff, rate plans and more rooms later under Setup.</p>
        <div className="grid-3">
          <Field label="Property name" span={2}><input required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Unreal Homes" /></Field>
          <Field label="Code"><input value={code} onChange={(e) => setCode(e.target.value)} placeholder="UH" maxLength={8} /></Field>
          <Field label="Your display name"><input value={display} onChange={(e) => setDisplay(e.target.value)} placeholder="e.g. Balati" /></Field>
          <Field label="Room rates are" span={2}>
            <select value={taxInclusive ? 'inc' : 'exc'} onChange={(e) => setTaxInclusive(e.target.value === 'inc')}>
              <option value="inc">VAT inclusive (18% included in the rate)</option>
              <option value="exc">VAT exclusive (18% added at night audit)</option>
            </select>
          </Field>
        </div>

        <h3>Room types and rooms</h3>
        <p className="muted small">Room numbers: comma-separated, ranges allowed (e.g. <code>101-110, 201</code>).</p>
        <div className="types-editor">
          <div className="types-row head"><span>Type</span><span>Code</span><span>Base rate</span><span>Max pax</span><span>Rooms</span><span /></div>
          {types.map((t, i) => (
            <div className="types-row" key={i}>
              <input aria-label="Room type name" value={t.name} onChange={(e) => set(i, 'name', e.target.value)} placeholder="Deluxe" />
              <input aria-label="Room type code" value={t.code} onChange={(e) => set(i, 'code', e.target.value)} placeholder="DLX" />
              <input aria-label="Base rate" inputMode="numeric" value={t.base_rate} onChange={(e) => set(i, 'base_rate', e.target.value.replace(/[^\d.]/g, ''))} />
              <input aria-label="Max occupancy" type="number" min={1} value={t.max_occupancy} onChange={(e) => set(i, 'max_occupancy', e.target.value)} />
              <input aria-label="Room numbers" value={t.rooms} onChange={(e) => set(i, 'rooms', e.target.value)} placeholder="101-110" />
              <button type="button" className="icon-btn" onClick={() => setTypes((x) => x.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
            </div>
          ))}
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => setTypes((x) => [...x, blankType()])}>+ Add room type</button>
        <div className="form-foot">
          <span className="muted">{totalRooms} rooms in {types.filter((t) => t.name.trim()).length} types</span>
          <div className="row-gap">
            {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
            <button className="btn btn-primary" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create property'}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
