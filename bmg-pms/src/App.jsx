import { lazy, Suspense, useEffect, useState } from 'react';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { DeskCtx, useDesk } from './lib/desk';
import { supabase, configured } from './lib/supabase';
import { PropertyProvider, useProperty } from './lib/property.jsx';
import { can, fmtDate, label, safeTerm } from './lib/format';
import { Loading } from './components/ui.jsx';
import Icon from './components/icons.jsx';
import { useNightMode } from './lib/nightmode.js';
import Login from './pages/Login.jsx';
import Onboarding from './pages/Onboarding.jsx';
import Today from './pages/Today.jsx';
import { MODULES } from './lib/modules.js';
import ReservationDrawer from './components/ReservationDrawer.jsx';
import { MfaChallenge, SetPassword } from './components/AuthSteps.jsx';
import { BillingGate, SubscriptionStrip } from './components/Subscription.jsx';

// Screens load on first use, so the first visit downloads only what Today needs
const StayView = lazy(() => import('./pages/StayView.jsx'));
const Reservations = lazy(() => import('./pages/Reservations.jsx'));
const FrontDesk = lazy(() => import('./pages/FrontDesk.jsx'));
const Guests = lazy(() => import('./pages/Guests.jsx'));
const CashDrawer = lazy(() => import('./pages/CashDrawer.jsx'));
const Expenses = lazy(() => import('./pages/Expenses.jsx'));
const CityLedger = lazy(() => import('./pages/CityLedger.jsx'));
const HouseStatus = lazy(() => import('./pages/HouseStatus.jsx'));
const Maintenance = lazy(() => import('./pages/Maintenance.jsx'));
const WorkOrders = lazy(() => import('./pages/WorkOrders.jsx'));
const NightAudit = lazy(() => import('./pages/NightAudit.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Setup = lazy(() => import('./pages/Setup.jsx'));
const Group = lazy(() => import('./pages/Group.jsx'));
const Pos = lazy(() => import('./pages/Pos.jsx'));
const Agents = lazy(() => import('./pages/Agents.jsx'));
const ExchangeRates = lazy(() => import('./pages/ExchangeRates.jsx'));
const Packages = lazy(() => import('./pages/Packages.jsx'));
const Messages = lazy(() => import('./pages/Messages.jsx'));
const LostFound = lazy(() => import('./pages/LostFound.jsx'));
const RevenueAssurance = lazy(() => import('./pages/RevenueAssurance.jsx'));
const Integrations = lazy(() => import('./pages/Integrations.jsx'));
const Import = lazy(() => import('./pages/Import.jsx'));
const Stock = lazy(() => import('./pages/Stock.jsx'));
const Kitchen = lazy(() => import('./pages/Kitchen.jsx'));
const Procurement = lazy(() => import('./pages/Procurement.jsx'));
const Accounting = lazy(() => import('./pages/Accounting.jsx'));
const Assets = lazy(() => import('./pages/Assets.jsx'));
const ControlPanel = lazy(() => import('./pages/ControlPanel.jsx'));
const Security = lazy(() => import('./pages/Security.jsx'));
const RateCalendar = lazy(() => import('./pages/RateCalendar.jsx'));
const BookingPage = lazy(() => import('./pages/BookingPage.jsx'));
const ReservationPage = lazy(() => import('./pages/ReservationPage.jsx'));
const NewReservation = lazy(() => import('./pages/NewReservation.jsx'));

export const NAV = [
  { id: 'today', label: 'Today', icon: 'home', page: Today, perm: 'me' },
  { id: 'stay-view', label: 'Stay view', icon: 'stay', page: StayView, perm: 'frontoffice' },
  { id: 'reservations', label: 'Reservations', icon: 'list', page: Reservations, perm: 'frontoffice' },
  { id: 'front-desk', label: 'Front desk', icon: 'desk', page: FrontDesk, perm: 'frontoffice' },
  { id: 'guests', label: 'Guest database', icon: 'guest', page: Guests, perm: 'frontoffice' },
  { group: 'Cashiering' },
  { id: 'cash-drawer', label: 'Cash drawer', icon: 'drawer', page: CashDrawer, perm: 'cashier' },
  { id: 'pos', label: 'Point of sale', icon: 'pos', page: Pos, perm: 'guestservice' },
  { id: 'kitchen', label: 'Kitchen and bar display', icon: 'receipt', page: Kitchen, perm: 'kitchen' },
  { id: 'city-ledger', label: 'City ledger', icon: 'ledger', page: CityLedger, perm: 'frontoffice' },
  { id: 'expenses', label: 'Expense vouchers', icon: 'voucher', page: Expenses, perm: 'cashier' },
  { id: 'stock', label: 'Stock and stores', icon: 'stock', page: Stock, perm: 'stock' },
  { id: 'procurement', label: 'Procurement', icon: 'box', page: Procurement, perm: 'procurement' },
  { group: 'Back office' },
  { id: 'rates', label: 'Rate calendar', icon: 'chart', page: RateCalendar, perm: 'rateview' },
  { id: 'agents', label: 'Agents and commission', icon: 'agent', page: Agents, perm: 'backoffice' },
  { id: 'exchange-rates', label: 'Exchange rates', icon: 'fx', page: ExchangeRates, perm: 'backoffice' },
  { id: 'packages', label: 'Packages and promotions', icon: 'gift', page: Packages, perm: 'backoffice' },
  { group: 'Guest services' },
  { id: 'messages', label: 'Guest messages', icon: 'message', page: Messages, perm: 'guestservice' },
  { id: 'lost-found', label: 'Lost and found', icon: 'box', page: LostFound, perm: 'guestservice' },
  { group: 'Housekeeping' },
  { id: 'house-status', label: 'House status', icon: 'broom', page: HouseStatus, perm: 'rooms' },
  { id: 'maintenance', label: 'Maintenance blocks', icon: 'wrench', page: Maintenance, perm: 'rooms' },
  { id: 'work-orders', label: 'Work orders', icon: 'check', page: WorkOrders, perm: 'workorders' },
  { id: 'assets', label: 'Room assets', icon: 'box', page: Assets, perm: 'inspect' },
  { group: 'Close of day' },
  { id: 'night-audit', label: 'Night audit', icon: 'moon', page: NightAudit, perm: 'audit' },
  { id: 'reports', label: 'Reports', icon: 'chart', page: Reports, perm: 'reports' },
  { id: 'revenue-assurance', label: 'Occupancy audit', icon: 'shield', page: RevenueAssurance, perm: 'assurance' },
  { group: 'Administration' },
  { id: 'integrations', label: 'Integrations', icon: 'plug', page: Integrations, perm: 'integrations' },
  { id: 'accounting', label: 'QuickBooks', icon: 'ledger', page: Accounting, perm: 'accounting' },
  { id: 'import', label: 'Import from eZee', icon: 'upload', page: Import, perm: 'setup' },
  { id: 'setup', label: 'Setup', icon: 'gear', page: Setup, perm: 'setup' },
  { id: 'group', label: 'Group overview', icon: 'group', page: Group, perm: 'me' },
  { id: 'security', label: 'Sign-in security', icon: 'shield', page: Security, perm: 'me' },
  { group: 'Platform', admin: true },
  { id: 'control-panel', label: 'Control panel', icon: 'panel', page: ControlPanel, admin: true },
];

const routeFromHash = () => {
  const [page, query] = window.location.hash.replace(/^#\/?/, '').split('?');
  return { page: page || 'today', params: Object.fromEntries(new URLSearchParams(query || '')) };
};

export default function App() {
  const [session, setSession] = useState(undefined);
  const [recovery, setRecovery] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);

  useEffect(() => {
    if (!configured) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      setSession(s);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // Two-step sign-in: a password-only session is not enough once the person has an authenticator
  useEffect(() => {
    if (!session) { setNeedsCode(false); return; }
    supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      .then(({ data }) => setNeedsCode(data?.nextLevel === 'aal2' && data?.currentLevel !== 'aal2'))
      .catch(() => setNeedsCode(false));
  }, [session]);

  if (!configured) {
    return (
      <div className="center-screen">
        <div className="card narrow">
          <h2>Connect Supabase</h2>
          <p>Create a <code>.env</code> file with <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code>, then restart. See README.md.</p>
        </div>
      </div>
    );
  }
  // Public booking page: no sign-in needed
  const book = window.location.hash.match(/^#\/book\/([\w-]+)/);
  if (book) return <ErrorBoundary><Suspense fallback={<div className="center-screen"><Loading /></div>}><BookingPage code={book[1]} /></Suspense></ErrorBoundary>;
  if (session === undefined) return <div className="center-screen"><Loading /></div>;
  if (!session) return <Login />;
  if (recovery) return <SetPassword onDone={() => setRecovery(false)} />;
  if (needsCode) return <MfaChallenge onDone={() => setNeedsCode(false)} />;
  return (
    <PropertyProvider session={session}>
      <Shell />
    </PropertyProvider>
  );
}

function Shell() {
  const { properties, property, role, switchProperty, user, refresh, isAdmin, mfaBlocked, billingBlocked, reloadProperties } = useProperty();
  const [payLocked, setPayLocked] = useState(false);
  const [route, setRoute] = useState(routeFromHash);
  const [openRes, setOpenRes] = useState(null);
  const [newRes, setNewRes] = useState(null);
  const [navOpen, setNavOpen] = useState(false);
  const [addingProperty, setAddingProperty] = useState(false);

  // Keyboard: "/" jumps to search, "n" starts a booking
  useEffect(() => {
    const k = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || document.querySelector('.modal-back, .drawer-back')) return;
      if (e.key === '/') { e.preventDefault(); document.getElementById('qs')?.focus(); }
      if (e.key === 'n' && ['owner', 'manager', 'front_desk'].includes(role)) { e.preventDefault(); setNewRes({}); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [role]);

  useEffect(() => {
    const h = () => { setRoute(routeFromHash()); setNavOpen(false); };
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);

  const nightMode = useNightMode(property, route.page);
  if (properties === null) return <div className="center-screen"><Loading /></div>;
  if (!properties.length && mfaBlocked.length && !isAdmin) {
    return (
      <div className="center-screen mfa-gate">
        <div className="card narrow">
          <h2 className="first">Turn on two-step sign-in</h2>
          <p>{mfaBlocked.map((b) => b.name).join(', ')} asks everyone to use an authenticator app. Set it up below, then sign in again.</p>
        </div>
        <ErrorBoundary><Suspense fallback={<Loading />}><Security /></Suspense></ErrorBoundary>
        <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    );
  }
  // a property locked for an unpaid subscription: its owners see the bill and can pay; everyone else is told why
  if (!isAdmin && billingBlocked.length && (payLocked || !properties.length)) {
    return <BillingGate blocked={billingBlocked} onBack={properties.length ? () => setPayLocked(false) : null}
      onPaid={() => { setTimeout(() => { setPayLocked(false); reloadProperties(); }, 1500); }} />;
  }
  if (isAdmin && (!properties.length || addingProperty)) return <AdminOnly onBack={properties.length ? () => setAddingProperty(false) : null} />;
  if (!properties.length || addingProperty) {
    return <Onboarding onCancel={properties.length ? () => setAddingProperty(false) : null} onDone={() => setAddingProperty(false)} />;
  }
  if (!property) return <div className="center-screen"><Loading /></div>;

  const off = new Set(Object.entries(MODULES).filter(([k]) => property.features?.[k] === false).flatMap(([, m]) => m.pages));
  // each person sees the screens their role can use (the database enforces the same rules)
  const nav = NAV.filter((n) => (!n.admin || isAdmin) && !off.has(n.id) && (!n.perm || can(role, n.perm)))
    .filter((n, i, a) => !n.group || (a[i + 1] && !a[i + 1].group));
  const isResPage = route.page === 'reservation' && route.params.id;
  const current = isResPage ? NAV.find((n) => n.id === 'reservations') : nav.find((n) => n.id === route.page) ?? nav[0];
  const Page = isResPage ? ReservationPage : current.page;
  const desk = {
    openReservation: (id) => setOpenRes(id),
    newReservation: (prefill = {}) => setNewRes(prefill),
    go: (page, params) => { window.location.hash = '/' + page + (params ? '?' + new URLSearchParams(params) : ''); },
  };

  return (
    <DeskCtx.Provider value={desk}>
      <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
        <aside className="sidebar">
          <div className="brand">
            <BrandMark />
            <div>
              <div className="brand-name">BMG PMS</div>
              <div className="brand-sub">BMG Group International</div>
            </div>
          </div>
          <div className="house-card">
            <label className="sr-only" htmlFor="prop">Property</label>
            <select id="prop" className="property-switch" value={property.id} onChange={(e) => {
              if (e.target.value === '__new') { if (isAdmin) desk.go('control-panel', { tab: 'new' }); else setAddingProperty(true); } else switchProperty(e.target.value);
            }}>
              {properties.map((p) => <option key={p.property_id} value={p.property_id}>{p.property}</option>)}
              <option value="__new">{isAdmin ? 'Open a new property…' : 'Add a property…'}</option>
            </select>
            <div className="bizday" title="Business day. It moves forward only when the night audit runs.">
              <span className="bizday-dot" aria-hidden />
              <div>
                <div className="bizday-label">Business day</div>
                <div className="bizday-date">{fmtDate(property.business_date, { weekday: 'long', day: 'numeric', month: 'long' })}</div>
              </div>
            </div>
          </div>
          {billingBlocked.length > 0 && !isAdmin && (
            <button type="button" className="locked-note" onClick={() => setPayLocked(true)}>
              <Icon name="lock" size={14} /> {billingBlocked.length === 1 ? `${billingBlocked[0].name} is locked` : `${billingBlocked.length} properties locked`} · subscription unpaid
            </button>
          )}
          <nav>
            {nav.map((n, i) => n.group
              ? <div key={'g' + i} className="nav-group">{n.group}</div>
              : (
                <a key={n.id} href={'#/' + n.id} className={`nav-item ${current.id === n.id ? 'active' : ''}`} aria-current={current.id === n.id ? 'page' : undefined}>
                  <Icon name={n.icon} />{n.label}
                </a>
              ))}
          </nav>
          <div className="sidebar-foot">
            <span className="avatar" aria-hidden>{(user.email ?? '?').slice(0, 2).toUpperCase()}</span>
            <div className="who">
              <div className="who-mail">{user.email}</div>
              <div className="who-role">{label(role)}</div>
            </div>
            <button className="icon-btn" onClick={() => supabase.auth.signOut()} aria-label="Sign out" title="Sign out"><Icon name="out" /></button>
          </div>
          <div className="sidebar-mode">
            <span>Screen</span>
            <div className="mode-toggle" role="radiogroup" aria-label="Day or night screen">
              {[['day', 'sun', 'Day'], ['auto', 'sparkle', 'Automatic: dark from the night audit window until the audit runs'], ['night', 'moon', 'Night']].map(([m, i, t]) => (
                <button key={m} type="button" role="radio" aria-checked={nightMode.mode === m} className={nightMode.mode === m ? 'on' : ''} title={t} aria-label={t} onClick={() => nightMode.setMode(m)}><Icon name={i} size={14} /></button>
              ))}
            </div>
          </div>
        </aside>
        <div className="main">
          <div className="night-band" role="status">
            <Icon name="moon" size={14} />
            {nightMode.reason === 'running' ? 'Night audit running: please wait before posting'
              : nightMode.reason === 'hours' ? `Night audit window is open · ${fmtDate(property.business_date, { weekday: 'long', day: 'numeric', month: 'long' })} still needs its night audit · back to day mode once it runs`
              : 'Night screen'}
          </div>
          <header className="topbar">
            <button className="icon-btn menu-btn" onClick={() => setNavOpen((x) => !x)} aria-label="Menu"><Icon name="menu" size={20} /></button>
            <div className="topbar-title">
              <span className="topbar-prop">{property.group_name}</span>
              <span className="topbar-page">{property.name}</span>
            </div>
            <div className="topbar-actions">
              {can(role, 'frontoffice') && <QuickSearch />}
              {can(role, 'res.add') && (
                <button className="btn btn-primary" onClick={() => desk.newReservation({})} title="New reservation (n)" aria-label="New reservation"><Icon name="plus" size={16} /><span className="label-long">New reservation</span><span className="label-short">New</span></button>
              )}
            </div>
          </header>
          <SubscriptionStrip propertyId={property.id} role={role} onOpen={() => desk.go('setup', { tab: 'subscription' })} />
          <main className="content">
            <ErrorBoundary key={property.id + current.id + (route.params.id ?? '')}>
              <Suspense fallback={<Loading />}>
                <Page params={route.params} />
              </Suspense>
            </ErrorBoundary>
          </main>
        </div>
        {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} />}
      </div>
      {openRes && <ReservationDrawer reservationId={openRes} onClose={() => { setOpenRes(null); refresh(); }} />}
      {newRes && (
        <ErrorBoundary><Suspense fallback={null}>
          <NewReservation prefill={newRes} onClose={() => setNewRes(null)}
            onCreated={(id) => { setNewRes(null); refresh(); desk.go('reservation', { id }); }} />
        </Suspense></ErrorBoundary>
      )}
    </DeskCtx.Provider>
  );
}

function QuickSearch() {
  const { property } = useProperty();
  const desk = useDesk();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);

  useEffect(() => {
    const term = safeTerm(q);
    if (term.length < 2) { setHits([]); return; }
    const t = setTimeout(async () => {
      const like = `%${term}%`;
      const num = /^\d+$/.test(term) ? Number(term) : null;
      const { data: guests } = await supabase.from('pms_guests').select('id')
        .eq('property_id', property.id)
        .or(`first_name.ilike.${like},last_name.ilike.${like},phone.ilike.${like}`).limit(20);
      const ids = (guests ?? []).map((g) => g.id);
      let query = supabase.from('pms_reservations')
        .select('id,res_no,arrival,departure,status,pms_guests(title,first_name,last_name)')
        .eq('property_id', property.id).order('arrival', { ascending: false }).limit(8);
      if (num) query = query.or(`res_no.eq.${num}${ids.length ? `,guest_id.in.(${ids.join(',')})` : ''}`);
      else if (ids.length) query = query.in('guest_id', ids);
      else { setHits([]); return; }
      const { data } = await query;
      setHits(data ?? []);
    }, 250);
    return () => clearTimeout(t);
  }, [q, property.id]);

  return (
    <div className="quicksearch">
      <Icon name="search" size={16} className="qs-icon" />
      <input id="qs" aria-label="Search reservations" placeholder="Find a guest or booking" title="Press / to search from anywhere" value={q} onChange={(e) => setQ(e.target.value)} />
      {hits.length > 0 && (
        <div className="qs-results">
          {hits.map((h) => (
            <button key={h.id} onClick={() => { desk.openReservation(h.id); setQ(''); }}>
              <strong>#{h.res_no}</strong> {[h.pms_guests?.title, h.pms_guests?.first_name, h.pms_guests?.last_name].filter(Boolean).join(' ')}
              <span className="muted small"> · {fmtDate(h.arrival)} → {fmtDate(h.departure)} · {label(h.status)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Monogram
function BrandMark() {
  return <span className="brand-mark" aria-hidden="true">B</span>;
}

// A platform admin who belongs to no property yet sees the control panel on its own
function AdminOnly({ onBack }) {
  const { user } = useProperty();
  const [route, setRoute] = useState(routeFromHash);
  useEffect(() => {
    const h = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  const desk = { openReservation: () => {}, newReservation: () => {}, go: (page, params) => { window.location.hash = '/' + page + (params ? '?' + new URLSearchParams(params) : ''); } };
  return (
    <DeskCtx.Provider value={desk}>
      <div className="admin-only">
        <header className="admin-only-head">
          <div className="row-gap"><BrandMark /><div><div className="brand-name">BMG PMS</div><div className="brand-sub">Platform control panel</div></div></div>
          <div className="row-gap">
            {onBack && <button className="btn" onClick={onBack}>Back to my properties</button>}
            <span className="muted small">{user.email}</span>
            <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </div>
        </header>
        <main className="content"><ErrorBoundary key={route.page}><Suspense fallback={<Loading />}>
          {route.page === 'security' ? <Security /> : <ControlPanel params={route.params} standalone />}
        </Suspense></ErrorBoundary></main>
      </div>
    </DeskCtx.Provider>
  );
}
