import { PRIVILEGES, PRIVILEGE_BY_KEY } from './privileges.js';
export const money = (n, currency = '') => {
  const v = Number(n ?? 0) || 0; // never show -0
  const s = v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return currency ? `${currency} ${s}` : s;
};

export const toISO = (d) => {
  const x = d instanceof Date ? d : new Date(d + 'T00:00:00');
  const y = x.getFullYear(), m = String(x.getMonth() + 1).padStart(2, '0'), day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toISO(d);
};

export const nightsBetween = (a, b) =>
  Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);

// Property display preferences (Setup → Formats): set once the property loads
const FMT = { date: 'DD Mon YYYY', hour12: false };
export const DATE_FORMATS = ['DD Mon YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];
export function setFormats({ date_format, time_format } = {}) {
  FMT.date = DATE_FORMATS.includes(date_format) ? date_format : 'DD Mon YYYY';
  FMT.hour12 = time_format === '12h';
}
const pad = (n) => String(n).padStart(2, '0');
export const fmtDate = (iso, opts) => {
  if (!iso) return '';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
  if (opts) return d.toLocaleDateString('en-GB', opts);
  const [y, m, day] = [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())];
  if (FMT.date === 'DD/MM/YYYY') return `${day}/${m}/${y}`;
  if (FMT.date === 'MM/DD/YYYY') return `${m}/${day}/${y}`;
  if (FMT.date === 'YYYY-MM-DD') return `${y}-${m}-${day}`;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const fmtDateTime = (ts) =>
  ts ? new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: FMT.hour12 }) : '';

export const guestName = (g) =>
  g ? [g.title, g.first_name, g.last_name].filter(Boolean).join(' ') : '';

export const label = (s) => { const t = (s ?? '').replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };

export const ROLES = ['owner', 'manager', 'front_desk', 'accountant', 'housekeeping', 'storekeeper'];

// What the signed-in person may do at the current property, from pms_my_privileges. Until it loads (and in
// tests) the built-in role defaults apply, which are the same list.
let PRIVS = null;
export const setPrivileges = (list) => { PRIVS = list ? new Set(list) : null; };
// Screen-level keys that stand for one or more abilities
const UI_PRIVS = {
  book: ['res.add'], cashier: ['cash.payment'], void: ['cash.void'], discount: ['cash.discount'], audit: ['fo.night_audit'],
  rates: ['rates.edit'], trail: ['rpt.audit_trail'], pos: ['pos.sell'], backoffice: ['cash.exchange'],
  integrations: ['config.integrations'], stock: ['stock.manage'], recipes: ['stock.recipes'], assets: ['hk.assets'],
  inspect: ['hk.inspect'], charge: ['fo.charge_damage'], door: ['pos.door'], block: ['hk.block'],
  reports: PRIVILEGES.filter((p) => p.group === 'rpt').map((p) => p.key),
  kitchen: ['pos.kitchen'], menu: ['pos.menu'],
  procurement: PRIVILEGES.filter((p) => p.group === 'proc').map((p) => p.key),
  accounting: ['acct.quickbooks'],
};

export const can = (role, action) => {
  if (!role) return false;
  if (action.includes('.')) {
    if (role === 'owner') return true;
    if (PRIVS) return PRIVS.has(action);
    return PRIVILEGE_BY_KEY[action]?.roles.includes(role) ?? false;
  }
  if (PRIVS && UI_PRIVS[action] && role !== 'owner') return UI_PRIVS[action].some((k) => PRIVS.has(k));
  const rules = {
    book: ['owner', 'manager', 'front_desk'],
    cashier: ['owner', 'manager', 'front_desk', 'accountant'],
    void: ['owner', 'manager'],
    discount: ['owner', 'manager'],
    audit: ['owner', 'manager', 'front_desk'],
    setup: ['owner', 'manager'],
    staff: ['owner'],
    block: ['owner', 'manager'],
    reports: ['owner', 'manager', 'front_desk', 'accountant'],
    trail: ['owner', 'manager', 'accountant'],
    pos: ['owner', 'manager', 'front_desk', 'accountant'],
    backoffice: ['owner', 'manager', 'accountant'],
    integrations: ['owner', 'manager'],
    stock: ['owner', 'manager', 'accountant', 'storekeeper'],
    recipes: ['owner', 'manager', 'storekeeper'],
    assets: ['owner', 'manager', 'storekeeper'],
    inspect: ['owner', 'manager', 'front_desk', 'housekeeping', 'storekeeper'],
    charge: ['owner', 'manager', 'front_desk'],
    door: ['owner', 'manager', 'front_desk', 'accountant', 'housekeeping'],
    // seeing guests, reservations, folios and money at all
    frontoffice: ['owner', 'manager', 'front_desk', 'accountant'],
    rooms: ['owner', 'manager', 'front_desk', 'accountant', 'housekeeping', 'storekeeper'],
    workorders: ['owner', 'manager', 'front_desk', 'accountant', 'housekeeping', 'storekeeper'],
    guestservice: ['owner', 'manager', 'front_desk', 'accountant', 'housekeeping'],
    rates: ['owner', 'manager'],
    rateview: ['owner', 'manager', 'front_desk', 'accountant'],
    assurance: ['owner', 'manager'],
    me: ['owner', 'manager', 'front_desk', 'accountant', 'housekeeping', 'storekeeper'],
    kitchen: ['owner', 'manager', 'accountant', 'storekeeper'],
    menu: ['owner', 'manager'],
    procurement: ['owner', 'manager', 'front_desk', 'accountant', 'housekeeping', 'storekeeper'],
    accounting: ['owner', 'manager', 'accountant'],
  };
  return (rules[action] ?? []).includes(role);
};

export function downloadCSV(filename, rows) {
  if (!rows?.length) return;
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    let s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    // Spreadsheet formula injection: a guest named "=HYPERLINK(...)" must stay text in Excel
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
  const a = document.createElement('a');
  const url = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Strip characters that would break a PostgREST or() filter
export const safeTerm = (s) => (s ?? '').replace(/[,()*%\\]/g, ' ').trim();
