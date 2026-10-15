import os, json, sys
# Layout audit: signs in on the local stack and checks every screen, Setup section, the reservation page, dialogs
# and the booking page at 1440, 1280, 1024 and 390 px wide for anything cut off, spilling out or forcing sideways
# page scroll, and that the sidebar's account bar stays in view. Run: python3 tests/local-stack/layout-audit.py [widths]
from playwright.sync_api import sync_playwright
U = 'http://localhost:54321/'
OUT = os.path.join(os.path.dirname(__file__), 'audit'); os.makedirs(OUT, exist_ok=True)
ROUTES = 'today stay-view reservations front-desk guests cash-drawer pos kitchen procurement accounting city-ledger expenses stock rates agents exchange-rates packages messages lost-found house-status maintenance work-orders assets night-audit reports revenue-assurance integrations import setup group security'.split()
SETUP = 'profile showcase policies formats rooms plans taxes payments extras discounts payouts meals transport sources segments booktypes tags holidays remarks messages documents website staff roles access signins activity security subscription'.split()
VIEWS = [(1440, 900), (1280, 720), (1024, 768), (390, 844)]
only = sys.argv[1:] 
JS = r'''() => {
  const W = innerWidth, H = innerHeight, out = [];
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).slice(0, 3).join('.') : '');
  const path = (e) => { const p = []; for (let x = e; x && x !== document.body && p.length < 4; x = x.parentElement) p.unshift(name(x)); return p.join(' > '); };
  if (document.documentElement.scrollWidth > W + 1) out.push({ k: 'page-x', w: document.documentElement.scrollWidth });
  const scrollerAncestor = (e) => { for (let x = e.parentElement; x; x = x.parentElement) { const s = getComputedStyle(x); if (/(auto|scroll)/.test(s.overflowX + s.overflowY) || s.position === 'fixed') return true; } return false; };
  for (const e of document.querySelectorAll('body *')) {
    const s = getComputedStyle(e);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
    if (/(hidden|clip)/.test(s.overflowX + s.overflowY) && !e.matches('.sr-only, .bar, .bar *, .lt-bar, .occ-bar, .login-art, .photo, .brand-mark')) {
      const ell = s.textOverflow === 'ellipsis';
      if (!ell && (e.scrollWidth > e.clientWidth + 2 || (/(hidden|clip)/.test(s.overflowY) && e.scrollHeight > e.clientHeight + 2)))
        out.push({ k: 'clipped', el: path(e), sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight });
    }
    if (r.right > W + 1 && !scrollerAncestor(e) && s.position !== 'fixed') out.push({ k: 'off-right', el: path(e), right: Math.round(r.right) });
    // text that spills out of its own box (no wrapping)
    if (e.children.length === 0 && e.textContent.trim() && e.scrollWidth > e.clientWidth + 2 && s.overflowX === 'visible' && s.display !== 'inline' && !e.matches('input,select,textarea,option,svg *'))
      out.push({ k: 'spill', el: path(e), text: e.textContent.trim().slice(0, 40), sw: e.scrollWidth, cw: e.clientWidth });
  }
  const foot = document.querySelector('.sidebar-foot');
  if (foot && getComputedStyle(document.querySelector('.sidebar')).transform === 'none') { const r = foot.getBoundingClientRect(); if (r.bottom > H + 1) out.push({ k: 'sidebar-foot-hidden', bottom: r.bottom }); }
  const nav = document.querySelector('.sidebar nav');
  if (nav && nav.scrollHeight > nav.clientHeight + 2 && getComputedStyle(nav).overflowY !== 'auto') out.push({ k: 'nav-not-scrollable' });
  const hub = document.querySelector('.hub-nav');
  if (hub) { const r = hub.getBoundingClientRect(); const tb = document.querySelector('.topbar')?.getBoundingClientRect(); if (tb && r.top < tb.bottom - 1 && innerWidth > 900) out.push({ k: 'hub-under-topbar', top: r.top, tb: tb.bottom }); }
  return out;
}'''
issues = {}
def check(pg, tag, shot=False):
    pg.wait_for_timeout(900)
    res = pg.evaluate(JS)
    if res: issues[tag] = res
    if shot or res: pg.screenshot(path=f'{OUT}/{tag}.png')
with sync_playwright() as p:
    b = p.chromium.launch()
    for (w, h) in VIEWS:
        if only and f'{w}' not in only: continue
        pg = b.new_page(viewport={'width': w, 'height': h}); pg.on('dialog', lambda d: d.accept())
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(U); pg.fill('input[type=email]', 'bbalati@bmggroup.co.tz'); pg.fill('input[type=password]', 'demo1234'); pg.click('button:has-text("Sign in")'); pg.wait_for_selector('.today', timeout=20000)
        for r in ROUTES:
            pg.goto(U + '#/' + r); check(pg, f'{w}-{r}')
        for sct in SETUP:
            pg.goto(U + '#/setup?tab=' + sct); pg.wait_for_selector('.hub'); check(pg, f'{w}-setup-{sct}')
        pg.goto(U + '#/control-panel?tab=billing'); pg.wait_for_selector('text=Run billing now'); check(pg, f'{w}-billing')
        pg.click('table tbody tr:has-text("Upanga")'); pg.wait_for_selector('.inv-row'); check(pg, f'{w}-billing-drawer')
        pg.click('.drawer button:has-text("Price") >> nth=0'); pg.wait_for_selector('.modal'); check(pg, f'{w}-addon-price'); pg.click('.modal button:has-text("Cancel")'); pg.keyboard.press('Escape')
        pg.goto(U + '#/control-panel?tab=billing'); pg.wait_for_selector('text=Price list'); pg.click('table tbody tr:has-text("Restaurant and bar POS")'); pg.wait_for_selector('.modal'); check(pg, f'{w}-catalog-edit'); pg.click('.modal button:has-text("Cancel")')
        for t in ['Store requests', 'Purchase orders', 'Deliveries', 'Supplier invoices', 'Reorder', 'Suppliers']:
            pg.goto(U + '#/procurement'); pg.wait_for_selector('.tabs'); pg.click(f'.tabs button:has-text("{t}")'); check(pg, f'{w}-proc-{t.split()[0].lower()}', shot=(w in (1440, 390)))
        pg.click('.tabs button:has-text("Purchase orders")'); pg.wait_for_timeout(600); pg.click('table tbody tr >> nth=0'); pg.wait_for_selector('.po-print'); check(pg, f'{w}-po', shot=(w in (1440, 390)))
        pg.click('.modal button:has-text("Close"), .modal .icon-btn >> nth=0')
        pg.click('.tabs button:has-text("Purchase orders")'); pg.click('button:has-text("New order")'); pg.wait_for_selector('.modal'); check(pg, f'{w}-po-new'); pg.click('.modal-foot button:has-text("Cancel")')
        pg.click('.tabs button:has-text("Supplier invoices")'); pg.click('button:has-text("Enter a supplier invoice")'); pg.wait_for_selector('.modal'); pg.select_option('.modal select >> nth=0', label='Kariakoo Traders'); check(pg, f'{w}-sinv-new'); pg.click('.modal-foot button:has-text("Cancel")')
        for t in ['Findings', 'Day by day', 'Rooms by day', 'Summary', 'Cameras and rules']:
            pg.goto(U + '#/revenue-assurance'); pg.wait_for_selector('.tabs'); pg.click(f'.tabs button:has-text("{t}")'); check(pg, f'{w}-audit-{t.split()[0].lower()}', shot=(w in (1440, 390)))
        pg.click('.tabs button:has-text("Findings")'); pg.wait_for_selector('table tbody tr'); pg.wait_for_timeout(800)
        if pg.locator('table tbody tr').count(): pg.click('table tbody tr >> nth=0'); pg.wait_for_selector('.drawer'); pg.wait_for_timeout(700); check(pg, f'{w}-audit-finding', shot=(w in (1440, 390))); pg.keyboard.press('Escape')
        pg.goto(U + '#/kitchen'); pg.wait_for_selector('.kds, .empty'); check(pg, f'{w}-kds', shot=(w in (1440, 390)))
        pg.goto(U + '#/accounting'); pg.wait_for_timeout(900); check(pg, f'{w}-qbo', shot=(w in (1440, 390)))
        pg.goto(U + '#/setup?tab=subscription'); pg.wait_for_selector('.pkg-list'); check(pg, f'{w}-my-package', shot=(w in (1440, 390)))
        pg.goto(U + '#/house-status'); pg.wait_for_timeout(900); pg.click('.view-switch button >> nth=1'); check(pg, f'{w}-floorplan')
        pg.goto(U + '#/stay-view'); pg.wait_for_timeout(900); pg.click('.key-btn'); check(pg, f'{w}-staykey'); pg.keyboard.press('Escape')
        pg.evaluate("localStorage.setItem('bmg.mode','night')"); pg.goto(U + '#/today'); pg.reload(); pg.wait_for_selector('.today'); check(pg, f'{w}-night-today')
        pg.evaluate("localStorage.setItem('bmg.mode','day')"); pg.reload(); pg.wait_for_selector('.today')
        pg.goto(U + '#/reservations'); pg.wait_for_timeout(1200); pg.click('table tbody tr >> nth=0'); pg.wait_for_timeout(700)
        check(pg, f'{w}-drawer')
        if pg.locator('button:has-text("Open reservation")').count(): pg.click('button:has-text("Open reservation")')
        pg.wait_for_selector('.folio-bar', timeout=10000); check(pg, f'{w}-folio')
        for t in ['Booking details', 'Guest details', 'Room charges', 'Tasks and messages', 'Audit trail']:
            pg.click(f'.tabs button:has-text("{t}")'); check(pg, f'{w}-res-{t.split()[0].lower()}')
        pg.click('.tabs button:has-text("Folio")'); pg.click('.folio-groups button:has-text("Add payment")'); pg.wait_for_selector('.modal'); check(pg, f'{w}-modal-payment')
        pg.keyboard.press('Escape'); pg.wait_for_timeout(200)
        if pg.locator('.modal').count(): pg.click('.modal button:has-text("Cancel")')
        pg.goto(U + '#/setup?tab=staff'); pg.wait_for_timeout(1500); pg.click('td button.link >> nth=0'); pg.wait_for_selector('.priv'); check(pg, f'{w}-modal-access')
        pg.close()
        pb = b.new_page(viewport={'width': w, 'height': h}); pb.goto(U + '#/book/uh'); pb.wait_for_selector('.bk-search'); check(pb, f'{w}-book')
        pb.close()
        if errs: issues[f'{w}-pageerrors'] = errs
from collections import defaultdict
agg=defaultdict(list)
for page,lst in issues.items():
    if page.endswith('pageerrors'): print('PAGEERRORS',page,lst); continue
    for i in lst: agg[(i['k'], i.get('el',''), i.get('text',''))].append(page)
for k,v in sorted(agg.items()): print(k, len(v), v[:4], [i for i in issues[v[0]] if (i['k'],i.get('el',''),i.get('text',''))==k][0])
print('PAGES WITH ISSUES:', len(issues))
