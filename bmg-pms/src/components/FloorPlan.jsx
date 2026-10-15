import Icon from './icons.jsx';

// Rooms laid out floor by floor along a corridor: even numbers on one side, odd on the other,
// the way most hotel floors are numbered. The floor comes from the room's own "floor" field, or
// from its number (331 → floor 3) when that is empty.
export const floorOf = (r) => {
  if (r.floor && String(r.floor).trim()) return String(r.floor).trim();
  const n = String(r.number ?? '').replace(/\D/g, '');
  if (n.length >= 3) return String(Number(n.slice(0, n.length - 2)));
  return 'Ground';
};
const floorName = (f) => (/^\d+$/.test(f) ? (f === '0' ? 'Ground floor' : `Floor ${f}`) : f);
const num = (r) => Number(String(r.number).replace(/\D/g, '')) || 0;

export default function FloorPlan({ rooms, tile, onPick, isEnabled = () => true, selected }) {
  const floors = {};
  for (const r of rooms) (floors[floorOf(r)] ??= []).push(r);
  const order = Object.keys(floors).sort((a, b) => (Number(b) || -1) - (Number(a) || -1)); // top floor first, like a building
  return (
    <div className="floors">
      {order.map((f) => {
        const list = floors[f].slice().sort((a, b) => num(a) - num(b) || String(a.number).localeCompare(String(b.number)));
        const sideA = list.filter((r) => num(r) % 2 === 1), sideB = list.filter((r) => num(r) % 2 === 0);
        const Row = ({ items }) => (
          <div className="fp-row">
            {items.map((r) => {
              const ok = isEnabled(r);
              return (
                <button key={r.id ?? r.room_id} type="button" disabled={!ok} aria-pressed={selected === (r.id ?? r.room_id)}
                  className={`fp-room ${ok ? '' : 'off'} ${selected === (r.id ?? r.room_id) ? 'sel' : ''}`} onClick={() => ok && onPick?.(r)}>
                  {tile(r)}
                </button>
              );
            })}
          </div>
        );
        return (
          <section key={f} className="fp-floor" aria-label={floorName(f)}>
            <header className="fp-head"><Icon name="floor" size={16} /> <strong>{floorName(f)}</strong><span className="muted small">{list.length} room{list.length === 1 ? '' : 's'}</span></header>
            <div className="fp-plan">
              <Row items={sideB} />
              <div className="fp-corridor"><span className="fp-lift" title="Stairs and lift">▲▼</span><span>Corridor</span></div>
              <Row items={sideA} />
            </div>
          </section>
        );
      })}
    </div>
  );
}
