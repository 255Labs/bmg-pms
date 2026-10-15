import { useEffect, useState } from 'react';
import { rpc } from '../lib/supabase';
import { can, fmtDate, money } from '../lib/format';
import { useProperty } from '../lib/property.jsx';
import { Field, Loading, Modal } from './ui.jsx';

// "Are you sure?" for room moves and amendments: shows what the change does to the nights still to charge
// and asks whether those nights keep the current rate or take the normal rate for the new room, dates or guests.
export default function ChangeConfirm({ stay, change, title, summary, onConfirm, onClose, busy, initialRate = null }) {
  const { role } = useProperty();
  const [p, setP] = useState(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState('keep');
  const [custom, setCustom] = useState(initialRate != null ? String(initialRate) : '');
  const [reason, setReason] = useState('');
  useEffect(() => {
    rpc('pms_change_preview', { p_stay: stay.id, p_room: change.room ?? null, p_arrival: change.arrival ?? null, p_departure: change.departure ?? null,
      p_adults: change.adults ?? null, p_children: change.children ?? null })
      .then((r) => { setP(r); setMode(initialRate != null ? 'custom' : Number(r.suggested_rate) !== Number(r.current_rate) && r.type_changed ? 'suggested' : 'keep'); })
      .catch((e) => setErr(e.message));
  }, [stay.id, change.room, change.arrival, change.departure, change.adults, change.children]);
  const canRate = can(role, 'res.amend');
  const rateFor = () => (mode === 'keep' ? Number(p.current_rate) : mode === 'suggested' ? Number(p.suggested_rate) : Number(custom || 0));
  const after = p ? rateFor() * p.to_post_after : 0;
  const diff = p ? after - Number(p.charges_before) : 0;
  const differs = p && Number(p.suggested_rate) !== Number(p.current_rate);
  return (
    <Modal title={title} onClose={onClose}
      footer={<><span className="muted small">Nights already charged by the night audit do not change.</span>
        <div className="row-gap"><button className="btn" onClick={onClose}>Go back</button>
          <button className="btn btn-primary" disabled={!p || busy || (mode === 'custom' && !custom)} onClick={() => onConfirm({ rate: mode === 'keep' ? null : rateFor(), reason })}>
            {busy ? 'Saving…' : 'Yes, make the change'}</button></div></>}>
      {err && <p className="danger">{err}</p>}
      {!p && !err && <Loading />}
      {p && <div className="stack">
        <div className="change-summary">{summary}</div>
        <table className="change-table">
          <thead><tr><th /><th>Now</th><th>After the change</th></tr></thead>
          <tbody>
            <tr><td>Room</td><td>{p.from_room ? `${p.from_room} · ` : ''}{p.from_type}</td><td>{p.to_room ? `${p.to_room} · ` : ''}{p.to_type}</td></tr>
            {change.arrival || change.departure ? <tr><td>Dates</td><td>{fmtDate(stay.arrival)} – {fmtDate(stay.departure)}</td><td>{fmtDate(change.arrival ?? stay.arrival)} – {fmtDate(change.departure ?? stay.departure)}</td></tr> : null}
            {change.adults != null && <tr><td>Guests</td><td>{stay.adults} adult{stay.adults === 1 ? '' : 's'}{stay.children ? `, ${stay.children} child` : ''}</td><td>{change.adults} adult{Number(change.adults) === 1 ? '' : 's'}{Number(change.children) ? `, ${change.children} child` : ''}</td></tr>}
            <tr><td>Nights still to charge</td><td>{p.to_post_before}</td><td>{p.to_post_after}</td></tr>
            <tr><td>Room charges still to come</td><td>{p.currency} {money(p.charges_before)}</td><td><strong>{p.currency} {money(after)}</strong></td></tr>
          </tbody>
        </table>
        <div className={`change-diff ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}`}>
          {diff > 0 ? `Charges go up by ${p.currency} ${money(diff)}` : diff < 0 ? `Charges go down by ${p.currency} ${money(-diff)}` : 'Charges stay the same'}
        </div>
        <fieldset className="change-choice">
          <legend>Rate for the nights still to charge</legend>
          <label className="check"><input type="radio" name="rate" checked={mode === 'keep'} onChange={() => setMode('keep')} /> Keep the current rate · {p.currency} {money(p.current_rate)} a night</label>
          {differs && <label className="check"><input type="radio" name="rate" disabled={!canRate} checked={mode === 'suggested'} onChange={() => setMode('suggested')} />
            Use the normal rate for {p.type_changed ? 'the new room type' : change.room ? 'this booking (rate calendar)' : 'the new dates and guests'} · {p.currency} {money(p.suggested_rate)} a night</label>}
          <label className="check"><input type="radio" name="rate" disabled={!canRate} checked={mode === 'custom'} onChange={() => setMode('custom')} /> Another rate</label>
          {mode === 'custom' && <Field label={`Rate a night (${p.currency})`}><input inputMode="decimal" autoFocus value={custom} onChange={(e) => setCustom(e.target.value.replace(/[^\d.]/g, ''))} /></Field>}
          {!canRate && <p className="small muted">Changing the rate needs "Extend, shorten or change dates, guests and rate"; ask a manager.</p>}
        </fieldset>
        <Field label="Reason (shown in the audit trail)"><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. guest asked for a bigger room, AC fault in 334" /></Field>
      </div>}
    </Modal>
  );
}
