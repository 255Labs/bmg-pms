import { fmtDate, guestName, money, nightsBetween } from '../lib/format';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Opens a printable guest folio / invoice. "Save as PDF" from the print dialog gives a PDF.
export function printFolio({ property, res, folio }) {
  const g = res.pms_guests;
  const stay = res.pms_stays.find((s) => s.id === folio.stay_id) ?? res.pms_stays[0];
  const lines = folio.pms_folio_lines.filter((l) => !l.voided);
  const debit = lines.filter((l) => l.amount > 0).reduce((n, l) => n + Number(l.amount), 0);
  const credit = -lines.filter((l) => l.amount < 0).reduce((n, l) => n + Number(l.amount), 0);
  const vatNote = property.tax_inclusive && property.tax_rate > 0
    ? `Room rates include VAT at ${property.tax_rate}%. VAT included: ${property.currency} ${money(lines.filter((l) => l.category === 'room').reduce((n, l) => n + Number(l.amount), 0) * property.tax_rate / (100 + Number(property.tax_rate)))}`
    : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Folio ${folio.folio_no} — ${esc(guestName(g))}</title>
<style>
  body{font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;margin:32px}
  h1{font-size:20px;margin:0}.muted{color:#64748b}.row{display:flex;justify-content:space-between;gap:24px}
  table{width:100%;border-collapse:collapse;margin-top:16px}th,td{padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:left}
  th{background:#f1f5f9;font-size:11px;text-transform:uppercase;letter-spacing:.04em}.num{text-align:right;font-variant-numeric:tabular-nums}
  tfoot td{font-weight:600;border-top:2px solid #0f172a}.box{border:1px solid #e2e8f0;border-radius:6px;padding:10px 12px;margin-top:16px}
  .sign{margin-top:48px;display:flex;gap:48px}.sign div{flex:1;border-top:1px solid #94a3b8;padding-top:6px}
  @media print{body{margin:12mm}}
</style></head><body>
<div class="row"><div><h1>${esc(property.name)}</h1><div class="muted">${esc([property.address, property.phone, property.email].filter(Boolean).join(' · '))}</div>
<div class="muted">${property.tin ? 'TIN ' + esc(property.tin) : ''} ${property.vrn ? ' · VRN ' + esc(property.vrn) : ''}</div>
<div class="muted">${esc(property.group_name)}</div></div>
<div style="text-align:right"><h1>${folio.balance > 0 ? 'INVOICE' : 'GUEST FOLIO'}</h1><div>Folio #${folio.folio_no} · Res #${res.res_no}</div><div class="muted">Printed ${new Date().toLocaleString('en-GB')}</div></div></div>
<div class="box row"><div><strong>${esc(guestName(g))}</strong><br>${esc([g.phone, g.email].filter(Boolean).join(' · '))}
${res.pms_companies ? '<br>Bill to: ' + esc(res.pms_companies.name) : ''}</div>
<div>Room ${esc(stay?.pms_rooms?.number ?? '—')} · ${esc(stay?.pms_room_types?.name ?? '')}<br>
${fmtDate(stay?.arrival)} → ${fmtDate(stay?.departure)} (${stay ? nightsBetween(stay.arrival, stay.departure) : 0} nights)</div></div>
<table><thead><tr><th>Date</th><th>Description</th><th>Reference</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>
${lines.map((l) => `<tr><td>${fmtDate(l.business_date)}</td><td>${esc(l.description)}</td><td>${esc(l.reference ?? '')}</td>
<td class="num">${l.amount > 0 ? money(l.amount) : ''}</td><td class="num">${l.amount < 0 ? money(-l.amount) : ''}</td></tr>`).join('')}
</tbody><tfoot><tr><td colspan="3">Totals</td><td class="num">${money(debit)}</td><td class="num">${money(credit)}</td></tr>
<tr><td colspan="3">Balance ${folio.balance >= 0 ? 'due' : 'in credit'}</td><td colspan="2" class="num">${esc(property.currency)} ${money(Math.abs(folio.balance))}</td></tr></tfoot></table>
${vatNote ? `<p class="muted">${esc(vatNote)}</p>` : ''}
<div class="sign"><div>Guest signature</div><div>Cashier</div></div>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) { alert('Allow pop-ups to print the folio.'); return; }
  w.opener = null;
  w.document.write(html);
  w.document.close();
  // printed from here rather than an inline script, so the page's Content-Security-Policy can forbid inline scripts
  setTimeout(() => { try { w.focus(); w.print(); } catch { /* window closed */ } }, 250);
}
