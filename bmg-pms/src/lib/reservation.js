import { useCallback, useEffect, useState } from 'react';
import { supabase, rpc } from './supabase';
import { addDays, nightsBetween } from './format';

// Loads a reservation with its rooms, folios, lines, balances and staff names
export function useReservation(id, propertyId) {
  const [res, setRes] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!id) return;
    const { data, error: err } = await supabase.from('pms_reservations')
      .select(`*, pms_guests(*), pms_companies(id,name), pms_business_sources(name), pms_rate_plans(name,meal_plan),
               pms_stays(*, pms_rooms(number,hk_status), pms_room_types(name)),
               pms_folios(*, pms_folio_lines(*))`)
      .eq('id', id).single();
    if (err) { setError(err.message); return; }
    const [{ data: bals }, members] = await Promise.all([
      supabase.from('pms_folio_balances').select('*').in('folio_id', data.pms_folios.map((f) => f.id)),
      rpc('pms_list_members', { p_property: propertyId }).catch(() => []),
    ]);
    const names = Object.fromEntries((members ?? []).map((m) => [m.user_id, m.display_name || m.email]));
    data.pms_stays.sort((a, b) => a.created_at.localeCompare(b.created_at));
    data.pms_folios.sort((a, b) => a.folio_no - b.folio_no);
    for (const f of data.pms_folios) {
      f.balance = Number(bals?.find((b) => b.folio_id === f.id)?.balance ?? 0);
      f.pms_folio_lines.sort((a, b) => a.business_date.localeCompare(b.business_date) || a.created_at.localeCompare(b.created_at));
      for (const l of f.pms_folio_lines) l.user = names[l.posted_by] ?? (l.source === 'night_audit' ? 'Night audit' : '');
    }
    setRes(data);
    setError(null);
  }, [id, propertyId]);

  useEffect(() => { load(); }, [load]);
  return { res, error, reload: load };
}

// Front-desk wording for a stay on the business date
export function stayStatus(stay, bd) {
  if (!stay) return { text: '', kind: 'grey' };
  switch (stay.status) {
    case 'checked_in':
      return stay.departure <= bd ? { text: 'Due out', kind: 'amber' } : stay.arrival === bd ? { text: 'Arrived', kind: 'green' } : { text: 'Stayover', kind: 'green' };
    case 'confirmed':
    case 'tentative':
      if (stay.arrival === bd) return { text: 'Arriving today', kind: 'blue' };
      if (stay.arrival < bd) return { text: 'Late arrival', kind: 'red' };
      return { text: stay.status === 'tentative' ? 'Tentative' : 'Reserved', kind: stay.status === 'tentative' ? 'amber' : 'blue' };
    case 'checked_out': return { text: 'Checked out', kind: 'grey' };
    case 'cancelled': return { text: 'Cancelled', kind: 'red' };
    case 'no_show': return { text: 'No-show', kind: 'red' };
    default: return { text: stay.status, kind: 'grey' };
  }
}

// Money summary for a reservation: posted charges, paid, balance, and room nights still to post
export function summarize(res) {
  const lines = res.pms_folios.flatMap((f) => f.pms_folio_lines).filter((l) => !l.voided);
  const charges = lines.filter((l) => l.amount > 0).reduce((n, l) => n + Number(l.amount), 0);
  const credits = -lines.filter((l) => l.amount < 0).reduce((n, l) => n + Number(l.amount), 0);
  const unposted = res.pms_stays.flatMap((s) => unpostedNights(s, res)).reduce((n, u) => n + u.amount, 0);
  return { charges, credits, posted: charges - credits, unposted, total: charges + unposted, balance: charges - credits };
}

// Nights of a live stay whose room charge the night audit has not posted yet
export function unpostedNights(stay, res) {
  if (!['tentative', 'confirmed', 'checked_in'].includes(stay.status)) return [];
  const posted = new Set(res.pms_folios.flatMap((f) => f.pms_folio_lines)
    .filter((l) => l.stay_id === stay.id && l.source === 'night_audit' && l.category === 'room' && !l.voided)
    .map((l) => l.business_date));
  const out = [];
  for (let i = 0; i < nightsBetween(stay.arrival, stay.departure); i++) {
    const d = addDays(stay.arrival, i);
    if (!posted.has(d)) out.push({ date: d, amount: Number(stay.rate), stay_id: stay.id });
  }
  return out;
}
