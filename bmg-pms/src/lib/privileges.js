// The list of abilities a person can be given. Each built-in role starts with the roles listed here;
// owners can build their own roles from these and adjust them per person. The database holds the same
// list (supabase/migrations/17_privileges.sql) and checks it on every request; tests/privileges.test.mjs
// fails if the two ever differ.
const O = 'owner', M = 'manager', F = 'front_desk', A = 'accountant', H = 'housekeeping', S = 'storekeeper';
const FO = [O, M, F], FOA = [O, M, F, A], MGR = [O, M], STK = [O, M, A, S];

export const PRIVILEGE_GROUPS = [
  { id: 'res', label: 'Reservations' },
  { id: 'fo', label: 'Front office' },
  { id: 'cash', label: 'Cashiering' },
  { id: 'pos', label: 'Outlets and activities' },
  { id: 'hk', label: 'Housekeeping and rooms' },
  { id: 'rates', label: 'Rates and channels' },
  { id: 'stock', label: 'Stock' },
  { id: 'proc', label: 'Procurement and stores' },
  { id: 'acct', label: 'Accounting' },
  { id: 'config', label: 'Configuration' },
  { id: 'rpt', label: 'Reports' },
];

export const PRIVILEGES = [
  { key: 'res.add', label: 'Make new bookings', roles: FO },
  { key: 'res.edit', label: 'Change booking details, packages and promotions', roles: FO },
  { key: 'res.amend', label: 'Extend, shorten or change dates, guests and rate', roles: FO },
  { key: 'res.cancel', label: 'Cancel bookings and mark no-shows', roles: FO },
  { key: 'res.assign', label: 'Assign and move rooms', roles: FO },
  { key: 'res.blacklisted', label: 'Book a blacklisted guest', roles: MGR },
  { key: 'res.import', label: 'Import guests and bookings', roles: MGR },
  { key: 'res.merge_guests', label: 'Merge duplicate guest profiles', roles: MGR },

  { key: 'fo.checkin', label: 'Check guests in', roles: FO },
  { key: 'fo.checkin_dirty', label: 'Check in to a dirty room', roles: FO },
  { key: 'fo.checkout', label: 'Check guests out', roles: FO },
  { key: 'fo.undo_checkin', label: 'Undo a check-in (same day)', roles: MGR },
  { key: 'fo.undo_checkout', label: 'Undo a check-out (same day)', roles: MGR },
  { key: 'fo.night_audit', label: 'Run the night audit', roles: FO },
  { key: 'fo.sms', label: 'Text guests and resend door codes', roles: FO },
  { key: 'fo.files', label: 'Add files to a booking', roles: FOA },
  { key: 'fo.files_delete', label: 'Delete files from a booking', roles: MGR },
  { key: 'fo.charge_damage', label: 'Charge a guest for damage or missing items', roles: FO },
  { key: 'fo.credit_limit', label: 'Set credit limits and stop outlet charges', roles: MGR },
  { key: 'fo.blacklist', label: 'Blacklist a guest', roles: MGR },

  { key: 'cash.payment', label: 'Take payments and mobile-money requests', roles: FOA },
  { key: 'cash.charge', label: 'Post charges', roles: FOA },
  { key: 'cash.room_charge', label: 'Post room charges (day use, late check-out, no-show)', roles: FO },
  { key: 'cash.paid_out', label: 'Pay out cash for a guest', roles: FOA },
  { key: 'cash.discount', label: 'Give discounts', roles: MGR },
  { key: 'cash.adjustment', label: 'Post adjustments', roles: MGR },
  { key: 'cash.void', label: 'Void postings', roles: MGR },
  { key: 'cash.transfer', label: 'Move charges between folios', roles: FO },
  { key: 'cash.folio', label: 'Open, split and cut folios', roles: FO },
  { key: 'cash.drawer', label: 'Open a cash drawer', roles: FOA },
  { key: 'cash.drawer_any', label: "Close someone else's cash drawer", roles: MGR },
  { key: 'cash.expense', label: 'Expense vouchers', roles: FOA },
  { key: 'cash.city_ledger', label: 'City ledger payments', roles: FOA },
  { key: 'cash.fiscal', label: 'Enter fiscal receipt numbers by hand', roles: [O, M, A] },
  { key: 'cash.exchange', label: 'Set exchange rates', roles: [O, M, A] },

  { key: 'pos.sell', label: 'Sell at outlets and charge bills to rooms', roles: FOA },
  { key: 'pos.discount', label: 'Discount outlet bills', roles: MGR },
  { key: 'pos.void', label: 'Void outlet bills', roles: MGR },
  { key: 'pos.door', label: 'Check people in at the gym, pool or spa', roles: [O, M, F, A, H] },
  { key: 'pos.cancel_membership', label: 'Cancel memberships and passes', roles: MGR },

  { key: 'hk.status', label: 'Change room cleaning status', roles: [O, M, F, H] },
  { key: 'hk.block', label: 'Take rooms out of order and back', roles: MGR },
  { key: 'hk.inspect', label: 'Room checks', roles: [O, M, F, H, S] },
  { key: 'hk.assets', label: 'Add and retire room assets', roles: [O, M, S] },
  { key: 'hk.asset_move', label: 'Move room assets', roles: [O, M, S, H] },

  { key: 'rates.edit', label: 'Change rates, minimum and maximum nights and closures', roles: MGR },

  { key: 'stock.manage', label: 'Receive, move, waste and count stock', roles: STK },
  { key: 'stock.recipes', label: 'Edit recipes', roles: [O, M, S] },

  { key: 'config.integrations', label: 'Integrations, till keys and channel sync', roles: MGR },
  { key: 'config.user_activity', label: 'See staff, devices and activity', roles: MGR },

  { key: 'rpt.stays', label: 'Arrivals, departures, in-house, cancellations and no-shows', roles: FOA },
  { key: 'rpt.occupancy', label: 'Occupancy, ADR and RevPAR', roles: FOA },
  { key: 'rpt.daily_revenue', label: 'Daily revenue', roles: FOA },
  { key: 'rpt.payments', label: 'Receipts', roles: FOA },
  { key: 'rpt.payment_methods', label: 'Payments by method', roles: FOA },
  { key: 'rpt.cashier', label: 'Cashier sales', roles: FOA },
  { key: 'rpt.ageing', label: 'Ageing debtors', roles: FOA },
  { key: 'rpt.pos_sales', label: 'Outlet sales', roles: FOA },
  { key: 'rpt.activities', label: 'Activities and facilities', roles: FOA },
  { key: 'rpt.segments', label: 'Market segments', roles: FOA },
  { key: 'rpt.commission', label: 'Agent commission', roles: [O, M, A] },
  { key: 'rpt.voids', label: 'Voids', roles: [O, M, A] },
  { key: 'rpt.audit_trail', label: 'Audit trail', roles: [O, M, A] },
  { key: 'rpt.revenue_assurance', label: 'Revenue assurance', roles: [O, M, A] },
  { key: 'rpt.food_cost', label: 'Food cost', roles: STK },
  { key: 'rpt.stock', label: 'Stock levels and usage', roles: STK },

  { key: 'pos.kitchen', label: 'Kitchen and bar display: start, finish and take items off', roles: [O, M, A, S] },
  { key: 'pos.menu', label: 'Set up menus, options, tables and happy hours', roles: [O, M] },
  { key: 'pos.transfer', label: 'Move, merge and reassign outlet bills', roles: [O, M, F, A] },
  { key: 'proc.request', label: 'Ask the store for stock', roles: [O, M, F, A, H, S] },
  { key: 'proc.issue', label: 'Issue stock from the store', roles: [O, M, A, S] },
  { key: 'proc.order', label: 'Raise purchase orders', roles: [O, M, A, S] },
  { key: 'proc.approve', label: 'Approve purchase orders', roles: [O, M] },
  { key: 'proc.receive', label: 'Receive deliveries', roles: [O, M, A, S] },
  { key: 'proc.invoice', label: 'Enter supplier invoices', roles: [O, M, A] },
  { key: 'proc.pay', label: 'Record payments to suppliers', roles: [O, M, A] },
  { key: 'proc.suppliers', label: 'Add and change suppliers', roles: [O, M, A, S] },
  { key: 'acct.quickbooks', label: 'Connect and send to QuickBooks', roles: [O, M, A] },
  { key: 'rpt.pos_z', label: 'Outlet end of day', roles: [O, M, F, A] },
  { key: 'rpt.purchases', label: 'Purchases and goods received', roles: [O, M, A, S] },
  { key: 'rpt.creditors', label: 'Supplier balances (creditors)', roles: [O, M, A] },
  { key: 'rpt.audit_resolve', label: 'Clear occupancy audit findings', roles: [O, M] },
  { key: 'res.reinstate', label: 'Reinstate a no-show or cancelled booking', roles: [O, M] },
  { key: 'fo.portal', label: 'Send and stop guest portal links', roles: FO },
  { key: 'fo.requests', label: 'See and handle guest portal requests', roles: [O, M, F, H] },
  { key: 'hk.maintenance', label: 'Put rooms under maintenance and back (housekeeping board)', roles: [O, M, H] },
].map((p) => ({ ...p, group: p.key.split('.')[0] }));

export const PRIVILEGE_BY_KEY = Object.fromEntries(PRIVILEGES.map((p) => [p.key, p]));

// What each built-in role starts with
export const roleDefaults = (role) => (role === 'owner' ? PRIVILEGES.map((p) => p.key) : PRIVILEGES.filter((p) => p.roles.includes(role)).map((p) => p.key));
