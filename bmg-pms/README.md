# BMG PMS

Multi-property hotel PMS for **BMG Group International Limited**. It follows the eZee Absolute workflow your front desk already knows, under BMG's own name and design.

**Stack:** React (Vite) + Supabase (Postgres, Auth, Row Level Security) + Netlify. This is the same stack as Tenda ICO.

## What is in this build

| Area | Screens |
|---|---|
| Front desk | Stay View tape chart (14 days, room-type availability, occupancy row, filter chips, click-to-book), New Reservation (multi-room, returning-guest lookup, rate plan pricing), Reservations list, Front Desk (arrivals / in-house / due out), Guest Database with booking history, quick search by name, phone or reservation number |
| Reservation quick view | Opens from any booking on Stay View: guest contact, status (arriving, stayover, due out…), arrival and departure times, room, rate plan, guests, average rate, and total / paid / balance. Actions menu (check in, check out, add payment or charge, amend, cancel) and print / send (folio, email confirmation, WhatsApp) |
| Reservation screen | Header with dates, nights, room and status. Tabs: **Folio** (rooms-and-folios tree, ledger with receipt numbers, particulars, posted-by, running balance, nights still to post shown in advance, void and move per line), **Booking details**, **Guest details**, **Room charges** (night by night, posted or to post), **Tasks** (linked to the reservation) and **Audit trail** |
| Folio actions | Assign or move room, check in (dirty-room guard with override), check out, amend dates/rate/pax, cancel or no-show, multiple folios, post charge, take payment, refund, discount, void, move a charge between folios, print folio / invoice to PDF |
| Cashiering | Cash drawer (open with float, expected vs counted, variance on close), Expense Vouchers, City Ledger (company accounts, transfer at check-out, receive payments) |
| Housekeeping | House Status board (clean / dirty / inspected / out of order), Maintenance Blocks, Work Orders |
| Night Audit | Pre-checks for departures, arrivals and drawers; posts room charges (and VAT when rates exclude it); marks occupied rooms dirty; stores the day's statistics; rolls the business date; keeps audit history |
| Reports | Arrival list, departure list, cancelled, no-show, reservation activity, in-house list, room status, daily revenue, daily receipt detail, cashier sales, ageing debtors (0–30 / 31–60 / 61–90 / 90+), expense vouchers, occupancy with ADR and RevPAR, business source summary, void report, audit trail. Every report exports to CSV and prints |
| Today | The home screen. Arrivals with one-click check-in, departures with check-out or "settle and check out", rooms to clean, guest messages, and a "Needs attention" list (unassigned arrivals, arrivals into dirty rooms, closed drawer, failed integration tasks, unexplained room activity). Press `/` to search and `n` for a new reservation from anywhere |
| Activities | Gym, swimming pool, games room, spa, tours and events on the same POS. Items sold by the clock (pool table per 30 minutes, with tables that can't be double-booked and grace minutes), services (massage, day pass, snorkelling trip) and memberships or passes (30-day gym, 10-swim pool pass). A door screen checks in members, hotel guests and walk-ins; charges post to the folio as Recreation, Spa, Tours or Events; an "Activities and facilities" report shows takings, hours sold, visits and members |
| Point of sale (restaurant and bar) | BMG's own POS, built on the Tenda ICO way of working: every outlet (restaurant, bars, room service, laundry) has its own menu in categories, each sent to the kitchen or the bar. Items with options (how cooked, sides at a price, each able to take its own stock), notes, courses and seats. A floor plan of tables by zone (free, busy, food ready), move a table, merge bills, change the waiter. Orders go to the **kitchen and bar display** as tickets that turn amber at 10 minutes and red at 20; the cooks start and bump them and mark items sold out. Happy hours and timed prices, service charge per outlet, split tender (cash, card, mobile money, room) with change, voids with reasons after an order went to the kitchen, printed kitchen tickets, and a **Z report** per outlet per day. Charge to an in-house room at any point |
| Stores, procurement and suppliers | One system for the restaurant, bars **and** the activities (gym, spa, pool, housekeeping stores). **Store requests:** the kitchen, bar or spa asks the main store, the storekeeper issues what is there and stock moves at its cost. **Purchase orders:** by supplier, in purchase units (a crate of 25 becomes 25 bottles), with VAT; orders above the property's approval limit wait for a manager other than the buyer. **Deliveries (GRN):** received against the order (part deliveries allowed) or without one, with batch and expiry; average cost updates. **Supplier invoices:** linked to deliveries and checked three ways (order, delivery, invoice); differences in price or quantity are flagged and need a manager to accept before paying. **Payments** by bank, mobile money, cash or cheque; **reorder** suggestions from par levels grouped by supplier into draft orders; creditor ageing and purchases reports |
| QuickBooks Online | Connect each property's QuickBooks company (OAuth, tokens kept in the database out of the API's reach). Suppliers become vendors, supplier invoices become bills (stock to inventory, the rest to expense accounts, input VAT apart), payments become bill payments, and after each night audit the day goes as one balanced journal (room and outlet revenue by department, VAT collected, payments by method, discounts, petty cash, cost of sales, waste and count differences, guest ledger). Map our lines to their chart of accounts once; preview any day before sending; failed sends retry and show why |
| Packages and pricing (sellable modules) | Every module and integration (POS, activities, stock, procurement, QuickBooks, Channex, TTLock, Hikvision, VFD, SMS, booking engine, city ledger…) has its own monthly price and optional per-room price on BMG's price list. Only BMG's platform administrators change the list, and per hotel they switch add-ons on or off, agree a different price or give free months. The database itself refuses what a hotel hasn't bought (a gym bill without Activities, a purchase order without Procurement), the screens follow, and the monthly invoice lists each add-on. Owners see their package and what else can be added |
| Back office | Travel agents and sales people on each booking, with a commission report on room revenue. Daily exchange rates; guests can pay in USD or EUR while the folio stays in TZS. Packages (fixed price per night or per stay) and promotion codes, applied from Booking details |
| Guest services | Guest messages (taken, then delivered), Lost and found (stored, handed back with the receiver's name, or disposed) |
| Integrations | Channex (availability, rates, restrictions and bookings), TTLock (a door passcode per stay, door records), Hikvision (camera events through an on-site relay), TRA VFD fiscal receipts, Tenda ICO (tills charge bills to a guest's room). Green / amber / red health per service, failed tasks with Retry, and a call log |
| Mobile money | From any folio, the desk sends a payment request to the guest's phone through ClickPesa (M-Pesa, Tigo Pesa, Airtel Money, Halopesa). When the guest enters their PIN the payment lands on the folio with a receipt number and a fiscal receipt. Payments are confirmed by asking ClickPesa directly, never on a webhook's word |
| Guest SMS | Door codes are texted to the guest through Beem when TTLock issues them, with an editable message. The desk can resend a code or send any short message |
| Kitchen and bar stock | Stores, kitchen and bars with an append-only stock ledger and weighted average cost. Each menu item has a recipe; when a POS bill is paid or charged to a room its ingredients leave the outlet's stock, and a void puts them back. Receiving, issuing, waste with reasons, stock counts with variances in shillings, low-stock alerts on Today, and food-cost and stock-usage reports |
| Room assets | What belongs in every room (TVs, kettles, towels, safes…), added per room or to every room of a type. Room checks by housekeeping after a guest leaves: missing or damaged items open a work order and the front desk can charge the guest's folio. Move, retire, register with replacement value |
| Import from eZee | Guests, future bookings and in-house guests with their balances, from eZee CSV exports. Columns are matched automatically, eZee date formats are understood, and re-running a file never duplicates |
| Occupancy audit | Every 30 minutes the database compares, room by room, people the cameras saw (one sighting per person passing, people only) and doors the locks opened with check-ins, check-outs and payments. Findings: used while vacant, in use but not checked in, before check-in, after check-out, a door code the PMS never issued, checked out owing, in house with nothing paid, checked in with no activity. Staff codes and the people seen just after them are left out. Each finding shows the room's timeline (check-ins, door openings, people seen) and money at risk; a manager records the outcome (explained, charged, loss, false alarm) with what was found. New high findings are texted to up to five managers. Reports: day by day (rooms sold against rooms used, people at the entrance against guests), rooms by day and a summary by kind and outcome, all to CSV |
| Setup | One searchable screen in six groups. **Your hotel:** profile (type, stars, contacts, registration numbers, address and map pin), logo, photos, highlights and amenities, policies (cancellation, house rules, child, pets, check-in and out times, early and late rules), date and time formats. **Rooms and pricing:** room types with base and maximum adults and children and extra-person rates, rate plans (including plans that follow another plan by a percentage or amount), taxes (VAT, service charge, levies, combined automatically). **Money:** payment methods with surcharges, extra charges, discounts, pay-out reasons, meal plans, transport types, currencies. **Bookings and guests:** business sources, market segments, booking types, holidays, remarks, guest tags. **Talking to guests:** booking, check-in and check-out SMS templates, document wording, the online booking page. **Team:** staff with titles, two-step status and last sign-in, what each role can do, sign-ins by device and IP, activity per person, and "require two-step sign-in" for the property |
| Rate calendar | Every room type and plan by date, with rooms still free on top. Switch between price, extra adult, extra child, minimum and maximum nights, closed, no arrivals and no departures. Edit cells, change a date range in one go, export CSV. Weekends and holidays are shaded |
| Online booking page | `https://<your app>/#/book/<code>` for each property once switched on: photos, highlights, search by dates and guests, prices per plan with "only 1 left", policies and terms, guest details, optional mobile-money payment, confirmation. Limited to 3 bookings per contact a day and 30 per property an hour |
| Folio tools | Take payment by any configured method (surcharges added), charges from the extra-charge list, room charges (day use, late check-out, early check-in, no-show, cancellation), adjustments (manager), paid-outs, meal plans, transport legs, split lines to a new folio, cut a folio by amount, files (ID scans, vouchers) |
| POS for in-house guests | Open a bill for a checked-in guest by room or name, split a bill, settle by any payment method, or charge it to the room. The desk can stop outlet charges for a stay or set a credit limit |
| Roles and access | Your own roles built from 63 single abilities in nine groups (reservations, front office, cashiering, outlets, housekeeping, rates, stock, configuration and each report on its own), e.g. "Front Office Associate" or "Revenue Manager". Each rests on a built-in role, which decides which records the person can see. Any one person can then have single abilities switched on or off, and one person's access can be copied to every other property you own. Owners always have everything; only owners change access, never their own |
| Undo and merge | Managers can undo a check-in or a check-out made today (door codes and early check-in charges follow), and merge duplicate guest profiles: bookings, folios and files move to the kept profile and missing details are filled in |
| Group | Group Overview across every property you belong to, plus a property switcher. Revenue and balances show only to roles that see reports |
| Sign-in security | Two-step sign-in with any authenticator app; once on, the database itself refuses the account's data until the code is entered. Password change, password-reset screen, and an administrator reset for a lost phone |
| BMG subscription | Each property pays BMG monthly for the PMS. Plans set a monthly fee plus an amount per active room and per active staff account, with VAT; a property can instead have an agreed price. New properties start with the plan's free trial. On the billing day an invoice is issued with the usage counted that day. Owners see it under Setup → BMG PMS subscription and pay by mobile money (ClickPesa push to BMG's own account); BMG records bank or cash payments in the control panel. Not paid by the due date (7 days) it is overdue and owners and managers see a strip on every screen; 7 more days and the property is **locked**: nobody can work in it, owners see the bill and can pay, and paying in full unlocks it at once. Administrators can keep a property open while a payment is sorted out, void a wrong invoice, change plans and stop billing |
| Control panel (super admin) | Every property on the platform with status, business day, rooms, in-house, owners and failed tasks. Open a property in one wizard (room number ranges, copy setup from another property, modules, owner invite). Suspend or reactivate, switch modules, set the first business day, manage people and invites anywhere, see activity across all properties, add or remove administrators |

## Look and layout

A clear, dense front-office layout in BMG's colours: a navy menu with an orange marker for the open screen, white panels with thin rules, underlined tabs and the folio's everyday actions as buttons (Add payment, Add charge, Apply discount, Room charges, Split folio, More). Navy for structure, orange for where you are and the next step, claret for guests in house. Flat: no shadows or raised buttons.

- **Stay view key.** Under the chart, "Key to colours and marks" explains every colour and mark, drawn with the same styles as the chart. Bars show today's movements (arriving: orange edge; due out: striped) and marks for money owed, VIP, group bookings and blacklisted guests; rooms show their cleaning status and open work orders.
- **Are you sure, with the money shown.** Room moves and amendments (dates, guests) open a confirmation that shows the room, dates and guests before and after, the nights still to charge and how much the charges go up or down. The desk chooses whether those nights keep the current rate, take the normal rate for the new room type or dates, or another rate, and can give a reason for the audit trail. Nights the night audit has already charged never change.
- **Folio as a receipt.** The ledger is a paper receipt with punched edges and a balance tag: claret while money is owed, green when settled or in credit.
- **Floor plan.** House status can show rooms floor by floor along the corridor (floor from the room's floor field, or from its number); room moves can be chosen on the plan, with only free rooms lit.
- **Night audit mode.** When the night audit window opens (Setup → Formats, default 22:00–06:00) and the day has not been closed, the screens turn dark navy; they go back to day as soon as the audit runs. Each person can force day or night at the bottom of the menu.
- **Outlet photos.** Menu items take a real photo (phone camera or file, resized in the browser, kept in the `property-media` bucket); items without one show a clean monogram tile.

The sidebar menu scrolls on its own so the account bar is always in view; Setup becomes a section picker on phones. `tests/local-stack/layout-audit.py` checks every screen at 1440, 1280, 1024 and 390 px for anything cut off or scrolling sideways.

## Rules the database enforces

These rules hold even if someone bypasses the app.

- **No double booking.** A Postgres exclusion constraint stops two live stays from sharing a room on the same night. Maintenance blocks get the same check.
- **No overselling.** Unassigned bookings are checked against the room-type availability for every night.
- **Money is append-only.** Folio lines cannot be edited or deleted, only voided with a reason. Voids need a manager.
- **Cash is accounted for.** Cash payments and expenses require an open drawer. Mobile money, card and bank payments require a reference.
- **Check-out needs a zero balance.** The alternative is transferring the balance to the reservation's company on the city ledger.
- **Night audit is idempotent.** Each stay is charged once per night.
- **Staff only see their own properties.** Row Level Security limits every table to members of that property. Role checks run inside each function: owner, manager, front_desk, accountant, housekeeping, storekeeper.
- **Integrations cannot lose work.** Every change that an outside system needs (availability, a door code, a fiscal receipt) is written to a job queue in the same transaction. Failed jobs retry with back-off and show on the Integrations screen. API keys never touch the database or the browser.
- **Everything is logged.** Every action is written to the audit trail with who did it, when, and from which IP address and browser.
- **Access is enforced by the database, not by hiding buttons.** Every action function asks for its ability (`pms_need`), whether the person has it from a built-in role, a custom role or a single switch. The table below is what the built-in roles start with; Setup → Team → "What each role can do" shows all 63 abilities including your own roles. `npm run test:permissions` signs in as every role and tries every action through the API; `npm run test:privileges` does the same for custom roles and single switches. Both fail if the database and the screens ever disagree. Removing someone or changing their access takes effect on their very next click.

| | Owner | Manager | Front desk | Accountant | Housekeeping | Storekeeper |
|---|---|---|---|---|---|---|
| Guests, bookings, folios, payments | ✓ | ✓ | ✓ | read and cashier | — | — |
| Make and change bookings, check in and out | ✓ | ✓ | ✓ | — | — | — |
| Discounts, adjustments, voids | ✓ | ✓ | — | — | — | — |
| Night audit | ✓ | ✓ | ✓ | — | — | — |
| Reports | ✓ | ✓ | ✓ | ✓ | — | — |
| Audit trail | ✓ | ✓ | — | ✓ | — | — |
| Point of sale | ✓ | ✓ | ✓ | ✓ | — | — |
| Gym, pool and spa door | ✓ | ✓ | ✓ | ✓ | ✓ (names only) | — |
| Stock and recipes | ✓ | ✓ | — | stock | — | ✓ |
| Room assets register | ✓ | ✓ | — | — | — | ✓ |
| Room checks and cleaning | ✓ | ✓ | ✓ | cleaning | ✓ | ✓ |
| See rate calendar / change rates | ✓ / ✓ | ✓ / ✓ | ✓ / — | ✓ / — | — | — |
| Setup, integrations, out of order | ✓ | ✓ | — | — | — | — |
| Add and remove people | ✓ | — | — | — | — | — |
| Blacklist a guest, set credit limits | ✓ | ✓ | — | — | — | — |

## Set up (about 15 minutes)

1. **Create a Supabase project.** Pick the region closest to Tanzania, e.g. eu-central or af-south if offered.
2. **Run the SQL.** In the SQL Editor, run the twenty-six files in `supabase/migrations/` in order: `01_schema` → `02_security` → `03_functions` → `04_night_audit` → `05_reports` → `06_folio_details` → `07_back_office` → `08_integrations` → `09_platform` → `10_payments_messaging` → `11_stock_assets` → `12_control_panel` → `13_security_hardening` → `14_activities` → `15_operations` → `16_permissions` → `17_privileges` → `18_review` → `19_change_preview` → `20_subscriptions` → `21_isolation` → `22_pos_service` → `23_procurement` → `24_quickbooks` → `25_packages` → `26_occupancy_audit`. Or run `DATABASE_URL=… bash scripts/db-push.sh`. Run each file as its own query; they are safe to re-run.
3. **Storage.** `15_operations` creates two buckets: `property-media` (public: logo and photos for the booking page) and `pms-files` (private: ID scans and vouchers, opened with short-lived links). If the SQL Editor reports it could not create them, add them under Storage with those names and run `15_operations` again.
4. **Configure auth.** Under Authentication → URL configuration, set the Site URL to your Netlify URL. Keep **Confirm email** on (invites are only claimed by a confirmed address), set the minimum password length to 10, and under Authentication → Multi-Factor turn on TOTP so people can use two-step sign-in.
5. **Connect the app locally.** Copy `.env.example` to `.env` and fill in the project URL and anon key from Settings → API.
6. **Run it.**
   ```bash
   npm install
   npm run dev          # local
   npm run build        # production build in dist/
   ```
7. **Deploy to Netlify.** Use build command `npm run build` and publish directory `dist`. Add the same two `VITE_` variables under Site settings → Environment variables. `public/_redirects` is already included.
8. **Make yourself super admin.** Sign up in the app, then in the SQL Editor run `select pms_bootstrap_super_admin('you@bmggroup.co.tz');`. Sign in again: **Control panel** appears under Platform. Add a second administrator there.
9. **Open properties.** Control panel → Open a property: details, room types with number ranges (`101-110, 112`), copy setup from an existing property, modules, and the owner's email. Once an administrator exists, only administrators can open properties.
10. **Add staff.** Invite by email with a role (control panel drawer → People, or the property's Setup → Staff). People without an account join automatically the first time they sign up with that email.
11. **Fill in Setup.** Profile, policies, payment methods, taxes and room types first; then switch on the booking page under Setup → Online booking page and share its link. Under Setup → Team → Roles, build roles that match your job titles and give them to people.

12. **Set up billing.** Control panel → Billing: edit the Standard plan's prices (monthly fee, per room, per staff account, VAT, trial days) or add plans and pick the default for new properties. Open each property to set its plan or agreed price, billing day and trial end. Properties that existed before billing was switched on get a 30-day trial, so nobody is locked on day one. Set the `_PLATFORM` ClickPesa secrets (below) so owners can pay by phone.

The control panel also suspends and reactivates properties (with a reason; staff are locked out and integrations stop, data stays), switches modules per property, sets the first business day before any posting, and shows people and activity across every property.

The full hosting and go-live guide, step by step, is `GO-LIVE.md` in this folder (and the "BMG PMS: setup and hosting guide" document).

## Integrations (when you are ready)

The PMS works fully without them. Each one is switched on per property under Administration → Integrations.

1. **Deploy the Edge Functions** with the Supabase CLI from this folder:
   ```bash
   supabase link --project-ref <ref>
   SUPABASE_PROJECT_REF=<ref> bash scripts/deploy-functions.sh
   ```
   That deploys all ten: `channex-sync`, `channex-webhook`, `ttlock-sync`, `hikvision-ingest`, `fiscal-sync`, `pos-gateway`, `payments-sync`, `clickpesa-webhook`, `sms-sync` and `integration-catalog`. `supabase/config.toml` turns off JWT checks for the ones called by machines (each has its own secret or API key); `integration-catalog` keeps the sign-in check because staff call it from the Integrations screen.
2. **Set the secrets** (Edge Functions → Secrets, or `supabase secrets set NAME=value`):

   | Service | Secrets |
   |---|---|
   | All | `CRON_SECRET` (a long random string) |
   | Channex | `CHANNEX_API_KEY`, `CHANNEX_BASE_URL` (production: `https://app.channex.io/api/v1`; leave unset to use staging), `CHANNEX_WEBHOOK_TOKEN` |
   | TTLock | `TTLOCK_CLIENT_ID`, `TTLOCK_CLIENT_SECRET`, `TTLOCK_USERNAME`, `TTLOCK_PASSWORD` |
   | Hikvision | none: make a relay key per property on Integrations → Hikvision (the old shared `HIKVISION_RELAY_KEY` still works) |
   | Browser calls | `APP_ORIGINS` = your app address, e.g. `https://pms.bmggroup.co.tz` (limits which site may call `integration-catalog`) |
   | Fiscal | `VFD_API_KEY`, `VFD_ALLOWED_HOSTS` (your VFD provider's host name, e.g. `api.vfdprovider.co.tz`; the key is only ever sent there, over https) |
   | Mobile money | `CLICKPESA_CLIENT_ID`, `CLICKPESA_API_KEY`, `CLICKPESA_WEBHOOK_TOKEN`; `CLICKPESA_CHECKSUM_KEY` if checksums are on; `CLICKPESA_BASE_URL=https://api-sandbox.clickpesa.com` while testing |
   | SMS | `BEEM_API_KEY`, `BEEM_SECRET_KEY` |
   | BMG subscriptions | `CLICKPESA_CLIENT_ID_PLATFORM`, `CLICKPESA_API_KEY_PLATFORM` (BMG's own ClickPesa account, which receives the monthly fees; `CLICKPESA_CHECKSUM_KEY_PLATFORM` and `CLICKPESA_BASE_URL_PLATFORM` if needed). Without them the hotels' account is used, so set them before the first invoice |
   | Tenda ICO | none in the PMS: keys are made per till under Integrations → Tenda ICO. `POS_ALLOWED_ORIGINS` only if a till calls from a browser |

   If one property uses a different account, add the property code as a suffix, e.g. `CHANNEX_API_KEY_UH`, and set that suffix on the Integrations screen.
3. **Schedule the sync.** Enable `pg_cron` and `pg_net`, put your project URL and the same `CRON_SECRET` into `supabase/schedules.sql`, and run it once. Channex syncs every 2 minutes, TTLock every 5; fiscal receipts, mobile money and SMS every minute.
4. **Map rooms.** On the Channex and TTLock tabs press **Load from Channex** / **Load locks from TTLock** and pick from the lists; enter each room's camera channel on the Hikvision tab.
5. **Channex webhook.** Paste the webhook URL shown on the Channex tab into Channex so new bookings arrive instantly; the 2-minute pull catches anything missed.
6. **Tenda ICO.** Make a key per till, then follow `integrations/tendaico/README.md` on the Tenda ICO side.
7. **Hikvision relay.** Cameras stay on the hotel LAN. Run `tools/hikvision-relay` on an always-on PC there with that property's relay key and `ALLOWED_IPS` set to the NVR; see its README.
8. **VFD.** Fill in the endpoint, request template and reply mapping from your VFD provider's documentation. Until then, staff can type the EFD receipt number by hand on the reservation.
9. **Mobile money.** In the ClickPesa dashboard, set the webhook to the URL shown on Integrations → Mobile money. Test in the sandbox with a small amount first.
10. **SMS.** Register a sender name with Beem (until it is approved, use INFO), then switch SMS on and adjust the door-code message.

Before going live, test each one on site: book through Channex staging, check a guest in and open the door with the code, walk past a camera, and issue one fiscal receipt. The TTLock calls follow the Cloud API v3 reference (euopen.sciener.com): snake_case login, GET for lists, form POST for passcode changes. Still confirm with one real lock and gateway.

## Separation between properties and people

Every property's data is kept apart by the database itself, not by the screens:

- **Every one of the 77 property tables carries a required `property_id`.** Row level security means a person only
  ever reads and changes rows of properties they belong to, with the role they hold there.
- **No row can point at another property's row** (a booking in another hotel's room, a bill line from another
  hotel's menu): a guard on every link refuses it, even for code running with full rights.
- **No row can be moved to another property** once written.
- **Every row records who created it and who last changed it** (`created_by`, `updated_by` = the person's user id,
  with `created_at`, `updated_at`); creation details cannot be rewritten from the app. Money and audit records
  keep their own posted-by and audit trail as before.
- **Each property runs its own processes:** its own business date and night audit, its own reservation, folio,
  receipt and bill numbers, its own integrations and keys (`_<CODE>` secrets), its own subscription and lock.
- **Future tables are checked.** `pms__isolation_problems()` lists any table without `property_id`, without row
  security, or with an unguarded link. CI runs it on every change and every deploy runs it on the live database;
  a non-empty report stops the release. Administrators can run `pms_admin_isolation_report()` any time.

A property that needs its own database entirely can be given its own Supabase project as another deploy target:
same code, separate data (see `scripts/README-deploy.md`).

## Database modules

The database is split into 14 modules (core, access, front office, night audit, reports, cashiering, back office,
integrations, payments, stock, platform, activities, operations, billing), listed in `supabase/modules.json`. Each
table and function belongs to the module that created it, and each module has a lock file in `supabase/schema/`
recording its objects. Every migration declares its module on its first line; `npm run db:check` refuses a
migration that changes another module without declaring it, and a pull request shows exactly which modules'
lock files changed, with `CODEOWNERS` deciding who approves each. So stock can change without touching
cashiering by accident, and anyone reviewing sees at once if it does.

## Security

An October 2026 audit found and fixed these; `npm run test:security` attacks the database the way a real API caller would (anonymous key, signed-in staff of another hotel, PostgREST's own roles) and checks each one stays fixed.

| Was possible | Now |
|---|---|
| The public (anon) key could call functions directly, e.g. write fake audit-trail entries | Anonymous callers can do nothing; internal and service functions are closed to signed-in users too |
| Owners and managers could edit any property column through the API, including the business date and receipt counters | Only the contact and tax details are editable; the date moves only through the night audit; currency is fixed after the first posting |
| A property manager could change the secrets suffix, Channex property or VFD endpoint, so the group's shared keys acted for another hotel or were sent to any server | Those settings are platform-administrator only; the VFD key goes only over https to `VFD_ALLOWED_HOSTS`; a Channex property or lock can't be connected to two hotels |
| Records could point at another hotel's company, room type, rate plan or room | Every reference is checked to stay inside the same property |
| Rates, exchange rates, availability and drawer totals answered for any property id | They answer only for the caller's own properties |
| An invite could be claimed by an account that never confirmed its email | Only confirmed addresses claim invites |
| Lines from a closed day could be voided; drawers closed with no count; negative room rates | Closed days stay closed (post a discount or refund); counts and rates are checked |
| The desk could send unlimited free-text SMS | 480 characters, 60 an hour per property, 5 an hour per number |
| Housekeeping could read guest door codes | Door codes and their SMS are front-office only |
| One camera relay key served every hotel; a power cut could corrupt the relay's queue and stop it | A key per property, an IP allow-list for the NVR, and a crash-proof queue |
| No security headers; folio print used an inline script; CSV exports could carry spreadsheet formulas | Strict Content-Security-Policy, HSTS and frame blocking in `public/_headers`; print without inline script; exports neutralise formulas |
| Password reset link signed people in without asking for a new password | A "Choose a new password" screen |
| One crashing screen blanked the whole app; one 660 KB download | Each screen has its own error boundary and loads on first use (first load ~70 KB of app code plus cached libraries) |
| Vite dev-server advisory | Vite 7; `npm audit` reports 0 |

Performance: row-level security now works out the caller's properties once per query instead of once per row, and every foreign key has an index.

Still on you: keep **Confirm email** on in Supabase Auth, turn on two-step sign-in for every owner and administrator, keep at least two administrators, and rotate keys when people leave.

### Schema review (second pass)

| Found | Fixed in `18_review` |
|---|---|
| "Today" defaults used the server's UTC date, a day behind in Dar es Salaam between 00:00 and 03:00 | Defaults and new properties use the property's own time zone |
| No range checks on base rates, credit limits, tax rate, commission, asset and stock costs, exchange rates | Checks added (old rows are never blocked; new and changed rows must pass) |
| Any change out of "in house" other than check-out left the door code working | Every move out of "in house" revokes the code |
| Early check-in charge could post twice if a check-in was redone | Charged once per stay |
| Maximum nights never reached Channex | Sent with the other restrictions (0 = no limit) |
| Sign-in records outlived the account | Removed with the account |
| No way to undo a same-day check-in or check-out, or to merge duplicate guests | Three manager abilities: undo check-in, undo check-out, merge guests |

## Daily flow

1. **Morning.** Open Today. Clear the "Needs attention" list, assign rooms to arrivals, and confirm Housekeeping has the rooms clean. Set today's USD and EUR rates.
2. **During the day.** Check guests in and out, post charges, and take payments into your drawer.
3. **End of shift.** Close the cash drawer and count the cash.
4. **Night.** Run Night Audit, which closes the day and moves the business date forward. Reports then show the closed day.
5. **Next morning (manager).** Check Revenue assurance for the day just closed.

## Tests

```bash
npm test               # all twenty-one suites
npm run test:db        # database scenario
npm run test:mw        # integrations
npm run test:platform  # Tenda ICO gateway, restrictions, health, eZee import
npm run test:payments  # ClickPesa mobile money, Beem SMS door codes, setup catalogues
npm run test:stock     # recipes and stock from POS sales, counts, food cost, room assets
npm run test:admin     # super admin control panel, invites, suspension, property wizard
npm run test:security  # attacks as anon, another hotel's staff and PostgREST's roles; MFA; every audit finding
npm run test:activities # pool table timers, gym and pool memberships, door check-ins, departments, Tenda ICO
npm run test:operations # setup lists, derived rates, rate calendar, folio tools, POS for in-house guests, booking page
npm run test:permissions # every role against every action, database against screens
npm run test:privileges # custom roles, single switches, per-report access, invites, copying to other properties
npm run test:review    # schema review fixes, undo check-in/out, merging guests, Channex max stay, move and amend previews
npm run test:nightmode # when night audit mode switches on and off
npm run test:billing   # BMG subscription: invoices, overdue, lock and unlock, paying by phone and by bank
npm run test:isolation # no data crosses between properties or people, in any of the property tables
npm run test:pos       # restaurant service: tables, options, kitchen display, happy hour, split tender, Z report
npm run test:procurement # store requests, purchase orders and approval, deliveries, three-way match, supplier payments
npm run test:quickbooks # QuickBooks connection, account mapping, vendors, bills, payments and the daily journal (fake Intuit)
npm run test:packages  # price list, per-hotel add-ons and prices, enforcement, add-ons on the monthly invoice
npm run test:relay     # Hikvision relay: camera stream with digest login, one sighting per person, push mode
npm run test:audit     # occupancy audit: cameras and locks against check-ins, check-outs and payments
npm run lint           # code checks
npm run db:check       # database modules: boundaries, re-run safety, isolation, lock files
```

`test:db` runs all the migrations on an embedded Postgres and plays three hotel days end to end. It covers:
- booking, double-booking refusal, overselling refusal and dirty-room check-in
- cash drawer rules, voids, append-only folios and maintenance blocks
- night audit with no-shows, check-out rules, city ledger and ageing
- amendments, room moves, cancellations and drawer variance
- every report and role isolation between properties
- POS bills (pay, charge to room, void), drawer totals with POS cash, foreign-currency payments, packages, promotions, commission

`test:mw` runs the real Edge Function code against fake Channex, TTLock and VFD servers on the same embedded Postgres: availability and rate pushes, booking import and cancellation, door codes issued and removed, door records, camera events, fiscal receipts with outage and retry, and the revenue assurance flags.

`test:platform` covers the Tenda ICO gateway and client (keys, idempotent charges, voids, closed days), Channex restrictions, integration health and the eZee import (dates, balances, deposits, re-runs).

`test:payments` runs ClickPesa and Beem fakes: phone requests, confirmation by status check, forged and repeated webhooks, partial and failed payments, retries, expiry, checksums, door-code SMS and retries.

`test:stock` sells dishes and drinks through the POS and checks what leaves the kitchen and bar, voids, receiving and average cost, transfers, waste, counts, reports, room checks, work orders and damage charges.

`test:admin` covers the super admin bootstrap, admin-only property creation, the property wizard (room ranges, copying setup), suspension, modules, business date rules, invites and their claim on sign-up, and administrator management.

`test:activities` runs a resort's games room, gym, pool, spa and tours: timers with grace and minimums, tables that can't be double-booked, memberships that start when paid and end on time, limited-visit passes, door check-ins for members, residents and walk-ins, room charges under the right department, voids, the report, copying a resort's setup and Tenda ICO activity charges.

`test:operations` covers the profile and lists, taxes, plans that follow another plan, extra adults and children, the rate calendar and its restrictions, every folio tool, POS bills for in-house guests (attach, split, credit limit, outlet charges switched off), sign-ins and audit IPs, the blacklist, guest SMS, the new reports and the online booking page with its limits.

`test:permissions` signs in as each of the six roles and tries 22 kinds of action through PostgREST's own roles, then checks that switching someone off or changing their role takes effect at once.

`test:privileges` checks that the app's list of abilities matches the database's, that every action function asks for an ability, that only owners build roles and change access (never their own), and that custom roles, single switches, per-report access, switched-off roles, invites and copying to other properties all behave.

`test:review` covers the schema review (migration 18): dates in the property's own time zone, range checks on rates, limits, tax and commission, undoing a check-in (door code revoked) and a check-out (booked departure restored, refused if the room was resold), merging duplicate guests, maximum nights sent to Channex, sign-in cleanup, https-only item photos, and the move and amendment previews (charges before and after, moving or amending with the chosen rate and reason).

`test:billing` covers the monthly subscription (migration 20): the default plan and trial for new properties, usage invoices (rooms, VAT, agreed prices), one invoice per month, overdue and lock after the grace days, staff and owners shut out while owners can still see and pay the bill, "keep open until", paying by ClickPesa on BMG's own account (confirmed by asking ClickPesa, never by the webhook), unlocking at once, part payments, bank payments, voids, failed and unconfigured phone requests, suspended and cancelled properties.

`test:isolation` creates two hotels with real activity, then signs in as each owner and clerk and reads every one of the 77 property tables for the other hotel's rows (none), tries to link a booking to the other hotel's room, a bill line to its menu, a bill to its outlet and to move a record across (all refused, even for the database owner), checks who-made-it and who-changed-it on every row, and shows that a future table without `property_id`, row security or a guarded link is caught by the database's own report.

`test:pos` runs a restaurant evening: categories and stations, required and paid options with their own stock, tables (one open bill each, move, merge), courses and seats, sending to the kitchen in rounds, the display and bumping, sold-out items, voids after sending (stock back, reason kept), a happy hour by time and day, service charge, split tender with change, the rest to a room, and the Z report.

`test:procurement` covers store requests and issues at cost, purchase units, approval limits (and that the buyer can't approve their own order), part deliveries, receiving without an order, average cost, service lines kept out of stock, the three-way match flagging a price difference that must be accepted before paying, duplicate supplier invoice numbers, payments, reorder suggestions from par levels, creditor ageing, the purchases report, who sees what (storekeeper, housekeeping) and closing a part-received order.

`test:quickbooks` runs the real worker against a fake QuickBooks: connecting, token refresh and rotation, account mapping, a vendor per supplier (and reuse on a duplicate name), bills with inventory, expense and VAT lines (waiting, with the reason, until accounts are mapped), bill payments, the balanced day journal (one per day, updated rather than duplicated when sent again, refused before the day is closed), a refused refresh marking the connection for reconnecting, and that tokens never reach the API.

`test:packages` checks that only administrators change prices and packages, agreed prices and free months, that the database refuses modules a hotel hasn't bought, that switching off an integration in the package switches it off at the hotel, and that the monthly invoice lists each add-on.

`test:relay` runs the on-site Hikvision relay against a fake camera with digest login and a fake PMS: one sighting per person instead of one row per second, several channels on one stream kept apart, heartbeats, video loss and vehicles left out, reconnecting when the stream drops, a wrong password reported, pushed events grouped the same way, and devices outside `ALLOWED_IPS` refused.

`test:audit` plays one Dar es Salaam day across seven rooms: a guest with the code the PMS issued (nothing found), a person and an unissued code in a vacant room, a booking never checked in, a door opened six hours before check-in, a person after check-out, a guest who left owing, a company stay (not flagged), housekeeping's visit (not flagged), a guest in house with nothing paid. Then re-running (no duplicates, no second text), late check-ins and payments clearing findings, who may clear them, the timeline, the daily and summary reports, the allowances and the package switch.

All 971 checks pass (113 + 34 + 56 + 39 + 40 + 38 + 63 + 42 + 64 + 142 + 41 + 35 + 7 + 53 + 28 + 45 + 37 + 20 + 21 + 14 + 39). The CI/CD pipeline in `.github/workflows/` runs them on every push, in parallel, with lint, the module check, a secret scan and a browser check; `scripts/README-deploy.md` explains the pipeline and its one-time setup. `tests/local-stack/` runs the full app against the real PostgREST server with demo data and no Supabase account; see its README.

## Next steps

1. **On-site integration tests** as listed above, starting with one TTLock door and Channex staging.
2. **Tenda ICO.** Add the "Room charge" payment method in Tenda ICO using `integrations/tendaico`.
3. **Backups.** Turn on Supabase PITR or schedule a nightly `pg_dump`. Running the night audit automatically is possible with pg_cron, but most hotels prefer a person to run it so arrivals and departures get handled.

## Limits worth knowing

- Room rate is one figure per night per stay, taken from the rate plan on the arrival date. Season changes inside a stay need **Amend**.
- Screens are in English only.
- Records a person can see (guests, folios, stock) follow the built-in role underneath their custom role; abilities only switch actions on and off. Setup itself, and managing people and access, stay with the built-in roles (owners and managers; owners only for access).
- City ledger ageing applies payments oldest invoice first.
- Folio PDFs come from the browser's print dialog ("Save as PDF").
- Channex bookings in a room type with no mapping, or that would overbook, still come in as reservations but are flagged on the Integrations screen for a person to sort out.
- Revenue assurance flags are prompts to check, not proof. A guest who stays out all night will show as "no activity".
- Deleting a property is blocked once folios exist. That is intentional, because money records never disappear.
