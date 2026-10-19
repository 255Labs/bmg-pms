import { lazy, Suspense, useEffect, useRef, useState } from 'react';
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
import { GuestRequestsProvider, RequestsBell, useGuestRequests } from './components/GuestRequests.jsx';

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
const GuestPortal = lazy(() => import('./pages/GuestPortal.jsx'));
const HousekeepingBoard = lazy(() => import('./pages/HousekeepingBoard.jsx'));
const GuestRequestsPage = lazy(() => import('./pages/GuestRequests.jsx'));
const ReservationPage = lazy(() => import('./pages/ReservationPage.jsx'));
const NewReservation = lazy(() => import('./pages/NewReservation.jsx'));

// The menu: sections in the top bar, each opening a dropdown of its screens. "hint" is the one-line description
// shown in the dropdown. Security is in the person's own menu (top right).
export const SECTIONS = [
  { id: 'today', label: 'Today', icon: 'home', items: [
    { id: 'today', label: 'Today', icon: 'home', page: Today, perm: 'me', hint: 'Arrivals, departures and what needs attention' }] },
  { id: 'front', label: 'Front office', icon: 'desk', items: [
    { id: 'stay-view', label: 'Stay view', icon: 'stay', page: StayView, perm: 'frontoffice', hint: 'Tape chart: every room over the next two weeks' },
    { id: 'reservations', label: 'Reservations', icon: 'list', page: Reservations, perm: 'frontoffice', hint: 'Find, open and manage bookings' },
    { id: 'guest-requests', label: 'Guest requests', icon: 'bell', page: GuestRequestsPage, perm: 'requests', hint: 'Food orders and service requests from the guest portal' },
    { id: 'front-desk', label: 'Front desk', icon: 'desk', page: FrontDesk, perm: 'frontoffice', hint: 'Arrivals, in-house and due out' },
    { id: 'guests', label: 'Guest database', icon: 'guest', page: Guests, perm: 'frontoffice', hint: 'Profiles and stay history' },
    { id: 'messages', label: 'Guest messages', icon: 'message', page: Messages, perm: 'guestservice', hint: 'Messages taken for guests' },
    { id: 'lost-found', label: 'Lost and found', icon: 'box', page: LostFound, perm: 'guestservice', hint: 'Items found and handed back' }] },
  { id: 'cash', label: 'Cashiering', icon: 'drawer', items: [
    { id: 'cash-drawer', label: 'Cash drawer', icon: 'drawer', page: CashDrawer, perm: 'cashier', hint: 'Open with a float, close and count' },
    { id: 'city-ledger', label: 'City ledger', icon: 'ledger', page: CityLedger, perm: 'frontoffice', hint: 'Company accounts and receivables' },
    { id: 'expenses', label: 'Expense vouchers', icon: 'voucher', page: Expenses, perm: 'cashier', hint: 'Petty cash paid from the drawer' }] },
  { id: 'outlets', label: 'Outlets', icon: 'pos', items: [
    { id: 'pos', label: 'Point of sale', icon: 'pos', page: Pos, perm: 'guestservice', hint: 'Restaurant, bars and activities' },
    { id: 'kitchen', label: 'Kitchen and bar display', icon: 'receipt', page: Kitchen, perm: 'kitchen', hint: 'Orders for the kitchen and bar' }] },
  { id: 'stores', label: 'Stores', icon: 'stock', items: [
    { id: 'stock', label: 'Stock and stores', icon: 'stock', page: Stock, perm: 'stock', hint: 'Levels, recipes, counts and waste' },
    { id: 'procurement', label: 'Procurement', icon: 'box', page: Procurement, perm: 'procurement', hint: 'Requests, orders, deliveries, suppliers' }] },
  { id: 'housekeeping', label: 'Housekeeping', icon: 'broom', items: [
    { id: 'hk-board', label: 'Housekeeping board', icon: 'check', page: HousekeepingBoard, perm: 'hk.status', hint: 'Tick each room cleaned, not yet, or under maintenance' },
    { id: 'house-status', label: 'House status', icon: 'broom', page: HouseStatus, perm: 'rooms', hint: 'Clean, dirty, inspected, out of order' },
    { id: 'maintenance', label: 'Maintenance blocks', icon: 'wrench', page: Maintenance, perm: 'rooms', hint: 'Rooms taken out of sale' },
    { id: 'work-orders', label: 'Work orders', icon: 'check', page: WorkOrders, perm: 'workorders', hint: 'Repairs and their progress' },
    { id: 'assets', label: 'Room assets', icon: 'box', page: Assets, perm: 'inspect', hint: 'What belongs in each room; room checks' }] },
  { id: 'revenue', label: 'Revenue', icon: 'coin', items: [
    { id: 'rates', label: 'Rate calendar', icon: 'chart', page: RateCalendar, perm: 'rateview', hint: 'Prices and restrictions by date' },
    { id: 'packages', label: 'Packages and promotions', icon: 'gift', page: Packages, perm: 'backoffice', hint: 'Packages and promotion codes' },
    { id: 'agents', label: 'Agents and commission', icon: 'agent', page: Agents, perm: 'backoffice', hint: 'Travel agents and sales people' },
    { id: 'exchange-rates', label: 'Exchange rates', icon: 'fx', page: ExchangeRates, perm: 'backoffice', hint: 'Daily USD and EUR rates' }] },
  { id: 'close', label: 'Audit and reports', icon: 'chart', items: [
    { id: 'night-audit', label: 'Night audit', icon: 'moon', page: NightAudit, perm: 'audit', hint: 'Close the day and roll the date' },
    { id: 'reports', label: 'Reports', icon: 'chart', page: Reports, perm: 'reports', hint: 'Every report, to print or CSV' },
    { id: 'revenue-assurance', label: 'Occupancy audit', icon: 'shield', page: RevenueAssurance, perm: 'assurance', hint: 'Cameras and locks against bookings and payments' }] },
  { id: 'admin', label: 'Admin', icon: 'gear', items: [
    { id: 'setup', label: 'Setup', icon: 'gear', page: Setup, perm: 'setup', hint: 'Rooms, rates, taxes, team and policies' },
    { id: 'integrations', label: 'Integrations', icon: 'plug', page: Integrations, perm: 'integrations', hint: 'Channex, locks, cameras, SMS, payments' },
    { id: 'accounting', label: 'QuickBooks', icon: 'ledger', page: Accounting, perm: 'accounting', hint: 'Send the books to QuickBooks Online' },
    { id: 'import', label: 'Import from eZee', icon: 'upload', page: Import, perm: 'setup', hint: 'Guests and bookings from eZee files' },
    { id: 'group', label: 'Group overview', icon: 'group', page: Group, perm: 'me', hint: 'All your properties at a glance' },
    { id: 'control-panel', label: 'Control panel', icon: 'panel', page: ControlPanel, admin: true, hint: 'BMG platform: properties and billing' }] },
];
const SECURITY = { id: 'security', label: 'Sign-in security', icon: 'shield', page: Security, perm: 'me' };
export const NAV = [...SECTIONS.flatMap((x) => x.items), SECURITY];


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
  // Guest portal: the guest's own page for their stay, opened from the link sent at check-in
  const stay = window.location.hash.match(/^#\/stay\/([0-9a-f]{64})/);
  if (stay) return <ErrorBoundary><Suspense fallback={<div className="center-screen"><Loading /></div>}><GuestPortal token={stay[1]} /></Suspense></ErrorBoundary>;
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
  const visible = (n) => (!n.admin || isAdmin) && !off.has(n.id) && (!n.perm || can(role, n.perm));
  const sections = SECTIONS.map((x) => ({ ...x, items: x.items.filter(visible) })).filter((x) => x.items.length);
  const nav = [...sections.flatMap((x) => x.items), SECURITY];
  const isResPage = route.page === 'reservation' && route.params.id;
  const current = isResPage ? NAV.find((n) => n.id === 'reservations') : nav.find((n) => n.id === route.page) ?? nav[0];
  const Page = isResPage ? ReservationPage : current.page;
  const section = sections.find((x) => x.items.some((i) => i.id === current.id));
  const desk = {
    openReservation: (id) => setOpenRes(id),
    newReservation: (prefill = {}) => setNewRes(prefill),
    go: (page, params) => { window.location.hash = '/' + page + (params ? '?' + new URLSearchParams(params) : ''); },
  };

  return (
    <DeskCtx.Provider value={desk}>
     <GuestRequestsProvider>
      <div className="app">
        <header className="appbar">
          <div className="appbar-left">
          <button className="icon-btn appbar-menu" onClick={() => setNavOpen(true)} aria-label="Menu"><Icon name="menu" size={20} /></button>
          <a href="#/today" className="appbar-brand" aria-label="BMG PMS, Today"><BrandMark /><span>BMG PMS</span></a>
          <div className="appbar-prop">
            <label className="sr-only" htmlFor="prop">Property</label>
            <select id="prop" className="property-switch" value={property.id} onChange={(e) => {
              if (e.target.value === '__new') { if (isAdmin) desk.go('control-panel', { tab: 'new' }); else setAddingProperty(true); } else switchProperty(e.target.value);
            }}>
              {properties.map((p) => <option key={p.property_id} value={p.property_id}>{p.property}</option>)}
              <option value="__new">{isAdmin ? 'Open a new property…' : 'Add a property…'}</option>
            </select>
            <span className="bizday-chip" title="Business day. It moves forward only when the night audit runs.">
              {fmtDate(property.business_date, { weekday: 'short', day: 'numeric', month: 'short' })}
            </span>
          </div>
          </div>
          <div className="appbar-center">{can(role, 'frontoffice') && <QuickSearch />}</div>
          <div className="appbar-actions">
            {can(role, 'res.add') && (
              <button className="btn btn-primary" onClick={() => desk.newReservation({})} title="New reservation (n)" aria-label="New reservation"><Icon name="plus" size={16} /><span className="label-long">New reservation</span></button>
            )}
            <RequestsBell />
            <UserMenu user={user} role={role} nightMode={nightMode} locked={!isAdmin && billingBlocked.length > 0} onLocked={() => setPayLocked(true)} />
          </div>
        </header>
        <nav className="mainnav" aria-label="Sections">
          {sections.map((x) => x.items.length === 1
            ? <a key={x.id} href={'#/' + x.items[0].id} className={`mainnav-tab ${section?.id === x.id ? 'active' : ''}`}><Icon name={x.icon} size={16} />{x.label}</a>
            : <SectionMenu key={x.id} section={x} active={section?.id === x.id} current={current.id} />)}
        </nav>
        {section && section.items.length > 1 && (
          <nav className="subnav subnav-mobile" aria-label={section.label}>
            {section.items.map((n) => (
              <a key={n.id} href={'#/' + n.id} className={current.id === n.id ? 'active' : ''} aria-current={current.id === n.id ? 'page' : undefined}><Icon name={n.icon} size={15} />{n.label}</a>
            ))}
          </nav>
        )}
        <div className="night-band" role="status">
          <Icon name="moon" size={14} />
          {nightMode.reason === 'running' ? 'Night audit running: please wait before posting'
            : nightMode.reason === 'hours' ? `Night audit window is open · ${fmtDate(property.business_date, { weekday: 'long', day: 'numeric', month: 'long' })} still needs its night audit · back to day mode once it runs`
            : 'Night screen'}
        </div>
        <SubscriptionStrip propertyId={property.id} role={role} onOpen={() => desk.go('setup', { tab: 'subscription' })} />
        <div className="app-body">
          <SideNav section={section} nav={nav} current={current.id} />
          <main className="content">
            <ErrorBoundary key={property.id + current.id + (route.params.id ?? '')}>
              <Suspense fallback={<Loading />}>
                <Page params={route.params} />
              </Suspense>
            </ErrorBoundary>
          </main>
        </div>
        {navOpen && <NavSheet sections={sections} current={current.id} onClose={() => setNavOpen(false)} />}
      </div>
      {openRes && <ReservationDrawer reservationId={openRes} onClose={() => { setOpenRes(null); refresh(); }} />}
      {newRes && (
        <ErrorBoundary><Suspense fallback={null}>
          <NewReservation prefill={newRes} onClose={() => setNewRes(null)}
            onCreated={(id) => { setNewRes(null); refresh(); desk.go('reservation', { id }); }} />
        </Suspense></ErrorBoundary>
      )}
     </GuestRequestsProvider>
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

// A section in the top bar: opens a dropdown of its screens with a line on each
// Left side: the open section's screens (with what each is for), then everyday shortcuts from other sections.
// The top bar picks the section; the side bar moves between its screens. Collapses to an icon rail.
const SHORTCUTS = ['stay-view', 'reservations', 'front-desk', 'guest-requests', 'cash-drawer', 'hk-board', 'pos', 'night-audit'];
const SIDE_KEY = 'bmg.sidenav';
// screens with their own list down the left (Setup, Reports) get the icon rail, so two lists never sit side by side
const OWN_LIST = ['setup', 'reports'];
function SideNav({ section, nav, current }) {
  const { fresh, open } = useGuestRequests();
  // remembered per person; first time, narrow on smaller laptop screens so the work area keeps its room
  const [slim, setSlim] = useState(() => { let v = null; try { v = localStorage.getItem(SIDE_KEY); } catch { /* storage off */ } return v ? v === 'slim' : window.innerWidth < 1280; });
  const toggle = () => setSlim((v) => { try { localStorage.setItem(SIDE_KEY, v ? 'wide' : 'slim'); } catch { /* storage off */ } return !v; });
  const rail = slim || OWN_LIST.includes(current);
  const mine = section?.items ?? [];
  const quick = SHORTCUTS.map((id) => nav.find((n) => n.id === id)).filter((n) => n && !mine.some((m) => m.id === n.id));
  const badge = (id) => (id === 'guest-requests' && open.length ? <span className={`sidenav-badge ${fresh ? 'new' : ''}`}>{open.length}</span> : null);
  const link = (n, hint) => (
    <a key={n.id} href={'#/' + n.id} className={`sidenav-link ${current === n.id ? 'active' : ''}`} aria-current={current === n.id ? 'page' : undefined} title={rail ? n.label : n.hint}>
      <Icon name={n.icon} size={18} />
      <span className="sidenav-text"><strong>{n.label}</strong>{hint && n.hint && <small>{n.hint}</small>}</span>
      {badge(n.id)}
    </a>
  );
  return (
    <aside className={`sidenav ${rail ? 'slim' : ''}`} aria-label="Screens">
      <div className="sidenav-scroll">
        {section && (
          <div className="sidenav-group">
            <div className="sidenav-title"><Icon name={section.icon} size={14} /><span>{section.label}</span></div>
            {mine.map((n) => link(n, true))}
          </div>
        )}
        {quick.length > 0 && (
          <div className="sidenav-group">
            <div className="sidenav-title"><span>Shortcuts</span></div>
            {quick.map((n) => link(n, false))}
          </div>
        )}
      </div>
      {!OWN_LIST.includes(current) && (
        <button className="sidenav-toggle" onClick={toggle} aria-label={slim ? 'Widen the side menu' : 'Narrow the side menu'} title={slim ? 'Widen' : 'Narrow'}>
          <span aria-hidden="true">{slim ? '»' : '«'}</span>{!slim && <span>Narrow menu</span>}
        </button>
      )}
    </aside>
  );
}

function SectionMenu({ section, active, current }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc); window.addEventListener('hashchange', () => setOpen(false), { once: true });
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className={`mainnav-group ${open ? 'open' : ''}`} ref={ref}>
      <button type="button" className={`mainnav-tab ${active ? 'active' : ''}`} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((o) => !o)}>
        <Icon name={section.icon} size={16} />{section.label}<span className="caret" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="mainnav-drop" role="menu">
          {section.items.map((n) => (
            <a key={n.id} role="menuitem" href={'#/' + n.id} className={current === n.id ? 'active' : ''} onClick={() => setOpen(false)}>
              <Icon name={n.icon} size={18} />
              <span><strong>{n.label}</strong><small>{n.hint}</small></span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// The person's own menu: who they are, sign-in security, day or night screen, sign out
function UserMenu({ user, role, nightMode, locked, onLocked }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <div className="usermenu" ref={ref}>
      <button type="button" className="usermenu-btn" aria-expanded={open} aria-label="Your account" onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden>{(user.email ?? '?').slice(0, 2).toUpperCase()}</span>
        {locked && <span className="usermenu-dot" aria-label="A property is locked" />}
      </button>
      {open && (
        <div className="usermenu-drop" role="menu">
          <div className="usermenu-who"><strong>{user.email}</strong><span>{label(role)}</span></div>
          {locked && <button type="button" className="usermenu-item danger" onClick={() => { setOpen(false); onLocked(); }}><Icon name="lock" size={16} />Locked: subscription unpaid</button>}
          <a className="usermenu-item" href="#/security" onClick={() => setOpen(false)}><Icon name="shield" size={16} />Sign-in security</a>
          <div className="usermenu-item mode">
            <span><Icon name="sun" size={16} />Screen</span>
            <div className="mode-toggle" role="radiogroup" aria-label="Day or night screen">
              {[['day', 'sun', 'Day'], ['auto', 'sparkle', 'Automatic: dark from the night audit window until the audit runs'], ['night', 'moon', 'Night']].map(([m, i, t]) => (
                <button key={m} type="button" role="radio" aria-checked={nightMode.mode === m} className={nightMode.mode === m ? 'on' : ''} title={t} aria-label={t} onClick={() => nightMode.setMode(m)}><Icon name={i} size={14} /></button>
              ))}
            </div>
          </div>
          <button type="button" className="usermenu-item" onClick={() => supabase.auth.signOut()}><Icon name="out" size={16} />Sign out</button>
        </div>
      )}
    </div>
  );
}

// Phones and small tablets: the whole menu as a sheet, section by section
function NavSheet({ sections, current, onClose }) {
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="navsheet-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="navsheet" aria-label="Menu">
        <div className="navsheet-head"><span className="appbar-brand"><BrandMark /><span>BMG PMS</span></span><button className="icon-btn" onClick={onClose} aria-label="Close menu">✕</button></div>
        {sections.map((x) => (
          <div key={x.id} className="navsheet-group">
            <div className="navsheet-title">{x.label}</div>
            {x.items.map((n) => <a key={n.id} href={'#/' + n.id} className={current === n.id ? 'active' : ''} onClick={onClose}><Icon name={n.icon} size={17} />{n.label}</a>)}
          </div>
        ))}
      </aside>
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
