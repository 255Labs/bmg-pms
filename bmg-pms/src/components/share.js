import { fmtDate, guestName, money, nightsBetween } from '../lib/format';

// Tanzanian numbers: 07xx / 06xx → 2557xx / 2556xx for wa.me links
export const waNumber = (phone) => {
  const d = (phone ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('0')) return '255' + d.slice(1);
  return d;
};

export function confirmationText({ property, res, totals }) {
  const g = res.pms_guests;
  const rooms = res.pms_stays.filter((s) => s.status !== 'cancelled')
    .map((s) => `${s.pms_room_types?.name}${s.pms_rooms ? ' (room ' + s.pms_rooms.number + ')' : ''} at ${property.currency} ${money(s.rate)} per night`).join('\n');
  return [
    `Dear ${guestName(g)},`,
    '',
    `Thank you for choosing ${property.name}. Your reservation #${res.res_no} is confirmed:`,
    '',
    `Arrival: ${fmtDate(res.arrival)} from ${property.check_in_time?.slice(0, 5)}`,
    `Departure: ${fmtDate(res.departure)} by ${property.check_out_time?.slice(0, 5)}`,
    `Nights: ${nightsBetween(res.arrival, res.departure)}`,
    rooms,
    '',
    `Total: ${property.currency} ${money(totals.total)}`,
    `Paid: ${property.currency} ${money(totals.credits)}`,
    `Balance: ${property.currency} ${money(totals.total - totals.credits)}`,
    '',
    `${property.name}${property.phone ? ' · ' + property.phone : ''}`,
  ].join('\n');
}

export const mailLink = (to, subject, body) =>
  `mailto:${encodeURIComponent(to ?? '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

export const waLink = (phone, body) => `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(body)}`;
