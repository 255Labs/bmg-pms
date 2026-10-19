import { useEffect, useRef, useState } from 'react';
import Icon from './icons.jsx';

// The stay view key: every sample is drawn with the same classes the chart uses, so the key can never drift
// from what is on screen. Opens from the toolbar; can be pinned open.
const STAYS = [
  ['confirmed', '', 'Confirmed', 'Booked and expected'],
  ['tentative', '', 'Not yet confirmed', 'Held, waiting for confirmation'],
  ['confirmed', 'arriving', 'Arriving today', 'Check in when they arrive'],
  ['checked_in', '', 'In house', 'Guest is staying'],
  ['checked_in', 'due_out', 'Due out today', 'Settle and check out'],
  ['checked_out', '', 'Checked out', 'Left; folio may still be open'],
];
const FLAGS = [
  ['bell', 'Guest request', 'Asked for food or a service on the guest portal; the bar pulses while it is new'],
  ['coin', 'Money owed', 'Open balance on the folio'],
  ['star', 'VIP', 'Guest tagged VIP'],
  ['people', 'Group', 'More than one room on the booking'],
  ['flag', 'Blacklisted', 'Only managers may book them'],
];
const ROOMS = [
  ['clean', 'Clean'], ['dirty', 'Dirty'], ['inspected', 'Inspected'], ['out_of_order', 'Out of order'],
];

const read = () => { try { return localStorage.getItem('bmg.staykey') === 'pinned'; } catch { return false; } };

export default function StayKey({ up = false }) {
  const [pinned, setPinned] = useState(read);
  const [open, setOpen] = useState(pinned);
  const box = useRef(null);
  useEffect(() => {
    if (!open || pinned) return;
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close); window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('mousedown', close); window.removeEventListener('keydown', esc); };
  }, [open, pinned]);
  const pin = () => {
    const next = !pinned; setPinned(next); setOpen(true);
    try { localStorage.setItem('bmg.staykey', next ? 'pinned' : ''); } catch { /* storage unavailable */ }
  };
  return (
    <div className="staykey" ref={box}>
      <button type="button" className={`btn key-btn ${open ? 'on' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="info" size={16} /> Key to colours and marks
      </button>
      {open && (
        <div className={`key-panel ${up ? 'up' : ''} ${pinned ? 'pinned' : ''}`} role="dialog" aria-label="Stay view key">
          <div className="key-head">
            <strong>Reading the stay view</strong>
            <button type="button" className="link small" onClick={pin}>{pinned ? 'Unpin' : 'Keep open'}</button>
          </div>
          <div className="key-cols">
            <section>
              <h4>Stays</h4>
              {STAYS.map(([st, ph, name, hint]) => (
                <div key={name} className="key-row">
                  <span className={`key-bar bar bar-${st} ${ph ? 'bar-' + ph : ''}`}><span className="bar-name">Guest</span></span>
                  <span><strong>{name}</strong><span className="key-hint">{hint}</span></span>
                </div>
              ))}
              <div className="key-row">
                <span className="key-bar bar bar-block"><span className="bar-name">Repairs</span></span>
                <span><strong>Out of service</strong><span className="key-hint">Maintenance block, cannot be sold</span></span>
              </div>
            </section>
            <section>
              <h4>Marks on a stay</h4>
              {FLAGS.map(([i, name, hint]) => (
                <div key={i} className="key-row">
                  <span className={`bar-flag f-${i} big`}><Icon name={i} size={13} /></span>
                  <span><strong>{name}</strong><span className="key-hint">{hint}</span></span>
                </div>
              ))}
              <h4>Rooms</h4>
              <div className="key-rooms">
                {ROOMS.map(([s, name]) => <span key={s} className="key-room"><span className={`hk-dot hk-${s}`} /> {name}</span>)}
                <span className="key-room"><span className="room-mark wo"><Icon name="wrench" size={12} /></span> Work order open</span>
              </div>
              <h4>Columns</h4>
              <p className="key-hint">The shaded column is today's business date. Under each room type: rooms left to sell and the rate. Weekends are tinted.</p>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
