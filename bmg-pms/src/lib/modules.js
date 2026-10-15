// Modules a platform admin can switch off per property (Control panel → property → Modules)
export const MODULES = {
  pos: { label: 'Point of sale', pages: ['pos', 'kitchen'] },
  procurement: { label: 'Procurement', pages: ['procurement'] },
  accounting: { label: 'QuickBooks', pages: ['accounting'] },
  stock: { label: 'Kitchen and bar stock', pages: ['stock'] },
  city_ledger: { label: 'City ledger', pages: ['city-ledger'] },
  expenses: { label: 'Expense vouchers', pages: ['expenses'] },
  back_office: { label: 'Agents, exchange rates, packages', pages: ['agents', 'exchange-rates', 'packages'] },
  guest_services: { label: 'Guest messages, lost and found', pages: ['messages', 'lost-found'] },
  assets: { label: 'Room assets', pages: ['assets'] },
  integrations: { label: 'Integrations and revenue assurance', pages: ['integrations', 'revenue-assurance'] },
  import: { label: 'Import from eZee', pages: ['import'] },
};

