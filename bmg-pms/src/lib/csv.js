// Small CSV reader (quotes, commas or semicolons, CRLF) and the field mapping for eZee exports.
export function parseCSV(text) {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows: rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()]))) };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
// eZee exports dates as 12/10/2026, 12-10-2026, 12-Oct-2026 or 2026-10-12. Day comes first.
export function toISODate(v) {
  const s = String(v ?? '').trim().split(/[ T]/)[0];
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if ((m = /^(\d{1,2})[ /-]([A-Za-z]{3})[a-z]*[ /-](\d{4})$/.exec(s))) {
    const mo = MONTHS.indexOf(m[2].toLowerCase());
    if (mo >= 0) return `${m[3]}-${String(mo + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return s;
}
export const toNumber = (v) => String(v ?? '').replace(/[^\d.-]/g, '');

// field → header names eZee and common spreadsheets use (lower-case, compared without spaces or punctuation)
export const FIELDS = {
  guests: [
    ['title', 'Title', ['title', 'salutation']],
    ['first_name', 'First name', ['firstname', 'first', 'givenname', 'guestfirstname']],
    ['last_name', 'Last name', ['lastname', 'last', 'surname', 'guestlastname']],
    ['phone', 'Phone', ['phone', 'mobile', 'mobileno', 'phoneno', 'contactno', 'telephone']],
    ['email', 'Email', ['email', 'emailid', 'emailaddress']],
    ['nationality', 'Nationality', ['nationality', 'country']],
    ['id_type', 'ID type', ['idtype', 'identitytype', 'documenttype']],
    ['id_number', 'ID number', ['idnumber', 'idno', 'identityno', 'passportno', 'documentno']],
  ],
  reservations: [
    ['ezee_no', 'eZee reservation no.', ['resno', 'reservationno', 'reservationnumber', 'folio', 'folioNo', 'bookingno', 'voucherno', 'resid']],
    ['first_name', 'First name', ['firstname', 'first', 'guestfirstname']],
    ['last_name', 'Last name', ['lastname', 'last', 'surname', 'guestlastname']],
    ['phone', 'Phone', ['phone', 'mobile', 'mobileno', 'contactno']],
    ['email', 'Email', ['email', 'emailid']],
    ['arrival', 'Arrival', ['arrival', 'arrivaldate', 'checkin', 'checkindate', 'from']],
    ['departure', 'Departure', ['departure', 'departuredate', 'checkout', 'checkoutdate', 'to']],
    ['room_type', 'Room type', ['roomtype', 'roomtypename', 'category']],
    ['room', 'Room', ['room', 'roomno', 'roomnumber']],
    ['adults', 'Adults', ['adults', 'adult', 'pax']],
    ['children', 'Children', ['children', 'child', 'kids']],
    ['rate', 'Nightly rate', ['rate', 'roomrate', 'nightlyrate', 'avgrate', 'averagerate', 'tariff']],
    ['source', 'Business source', ['source', 'businesssource', 'channel']],
    ['status', 'Status', ['status', 'reservationstatus', 'bookingstatus']],
    ['deposit', 'Deposit paid', ['deposit', 'advance', 'paid', 'amountpaid']],
    ['balance', 'Balance (in-house)', ['balance', 'due', 'balancedue', 'outstanding']],
    ['notes', 'Notes', ['notes', 'remarks', 'comments', 'specialrequest']],
  ],
};

const norm = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, '');
export function guessMapping(kind, headers) {
  const out = {};
  for (const [key, , names] of FIELDS[kind]) {
    const want = names.map((n) => n.toLowerCase());
    out[key] = headers.find((h) => want.includes(norm(h))) ?? '';
  }
  return out;
}

export function applyMapping(kind, rows, mapping) {
  return rows.map((r) => {
    const o = {};
    for (const [key] of FIELDS[kind]) {
      if (!mapping[key]) continue;
      let v = r[mapping[key]] ?? '';
      if (['arrival', 'departure'].includes(key)) v = toISODate(v);
      if (['rate', 'deposit', 'balance', 'adults', 'children'].includes(key)) v = toNumber(v);
      o[key] = v;
    }
    return o;
  });
}

export const TEMPLATES = {
  guests: 'first_name,last_name,phone,email,nationality,id_type,id_number\nAsha,Juma,+255713000111,asha@example.com,Tanzanian,Passport,TZ1234567\n',
  reservations: 'ezee_no,first_name,last_name,phone,arrival,departure,room_type,room,adults,rate,source,status,deposit,balance,notes\n'
    + '5001,Ritha,Ambonisye,+255754000333,09/10/2026,14/10/2026,Single,333,1,200000,Direct / Phone,In house,,350000,\n'
    + '5002,Joseph,Chitinka,,20/10/2026,23/10/2026,Double,,2,280000,Booking.com,Confirmed,100000,,Late arrival\n',
};
