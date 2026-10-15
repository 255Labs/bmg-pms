# BMG PMS: integrate, finalise and host — step by step

This takes BMG PMS from this folder to a live system at your own address, e.g. `https://pms.bmggroup.co.tz`.
Work through it in order and tick each step. Allow one working day for steps 1–12 and a week of side-by-side
running with eZee before you switch over (step 17).

Keys and passwords go in exactly three places, each with its own template file. Never put them in the code, in
GitHub, in the database tables or in the app's screens. The `service_role` key never goes into the web app.

| File (template) | Where it lives | What is in it |
|---|---|---|
| `.env.example` → Netlify environment variables (and `.env.local` on your own computer for `npm run dev`) | Netlify → Site configuration → Environment variables | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` only. Both are public by design |
| `supabase/secrets.env.example` → `supabase/secrets.env` | Supabase → Edge Functions → Secrets (sent with `supabase secrets set --env-file`) | Provider keys: ClickPesa, Beem, Channex, TTLock, VFD, QuickBooks, `CRON_SECRET`, `APP_ORIGINS` |
| `tools/hikvision-relay/relay.env.example` → `relay.env` | On each hotel's relay PC only | `PMS_URL`, the property's `RELAY_KEY`, camera addresses and the relay's camera user and password |

Delete your filled-in copies of `secrets.env` once Supabase has them (or keep them only in a password manager).
`.gitignore` keeps `.env*`, `supabase/secrets.env` and `relay.env` out of GitHub.

---

## What you need first

| Account | For | Notes |
|---|---|---|
| GitHub (organisation `bmggroup` or similar) | Holds the code; runs the tests | Private repository |
| Supabase (Pro plan recommended) | Database, sign-in, files, Edge Functions | Pro gives daily backups and point-in-time recovery |
| Netlify | Hosts the web app | Free plan is enough to start |
| Your domain's DNS (e.g. `bmggroup.co.tz`) | `pms.` address | Whoever manages your DNS |
| An email sender (SMTP), e.g. Zoho, Google Workspace, Brevo | Invites and password resets | Supabase's built-in email is only for testing |
| ClickPesa — **BMG's own account** | Monthly subscription payments from properties | Separate from any hotel's own account |
| ClickPesa — hotel account(s) | Guests paying by mobile money | Optional; can be the same as BMG's if BMG collects for the hotels |
| Beem Africa | SMS (door codes, booking texts) | Register a sender name early; approval takes days |
| Channex, TTLock, VFD provider | Channel manager, door locks, fiscal receipts | Only when each property is ready |
| Intuit developer account | QuickBooks Online link | Only for hotels that keep their books in QuickBooks |
| At each hotel: an always-on PC or mini PC (Windows or Linux, Node.js 18+) | The camera relay | Same network as the cameras and NVR; on a UPS if possible |

Install on the computer you will work from: **Node.js 22**, **Git**, the **Supabase CLI** (`npm i -g supabase`)
and **psql** (PostgreSQL client).

---

## 1. Put the code on GitHub

```bash
unzip bmg-pms.zip && cd bmg-pms
git init && git add . && git commit -m "BMG PMS"
git branch -M main
git remote add origin git@github.com:bmggroup/bmg-pms.git
git push -u origin main
```

`.gitignore` already keeps `.env`, `node_modules` and `dist` out. The **CI** workflow runs all 971 checks on
every push; check the Actions tab shows green.

## 2. Create the Supabase project

1. supabase.com → New project. Region: the closest to Tanzania that is offered (e.g. `eu-central-1`).
   Save the **database password** in your password manager.
2. **Project Settings → API**: copy the **Project URL** and the **anon public** key (for step 5).
3. **Project Settings → Database → Connection string → URI** (session pooler, port 5432): copy it and put
   the database password in. This is your `DATABASE_URL`.
4. **Database → Extensions**: switch on `pg_cron` and `pg_net`.

## 3. Load the database

From the project folder:

```bash
DATABASE_URL='postgresql://postgres.<ref>:<password>@<host>:5432/postgres' bash scripts/db-push.sh
```

All twenty-six migrations run in one transaction: either everything lands or nothing does. The files are safe to
re-run, so the same command is also how you upgrade later. (Without psql: run each file in
`supabase/migrations/` in order in the SQL Editor.)

Check in the SQL Editor:

```sql
select count(*) from pms_privilege_catalog;   -- 82
select name, base_monthly, per_room, vat_pct, trial_days from pms_plans;   -- Standard
```

**Storage → Buckets** should show `property-media` (public) and `pms-files` (private). If not, create them with
those names and run `15_operations.sql` again.

## 4. Sign-in settings

**Authentication → URL configuration**
- Site URL: `https://pms.bmggroup.co.tz` (use the Netlify address until the domain is ready, then change it).
- Redirect URLs: add the same address and the Netlify address.

**Authentication → Providers → Email**: Confirm email **on**. **Authentication → Policies / Passwords**:
minimum length 10. **Authentication → Multi-Factor**: TOTP **on**.

**Authentication → SMTP settings**: enter your mail server (host, port 587, user, password, sender
`PMS <pms@bmggroup.co.tz>`). Without this, invites and password resets stop after a few emails an hour.
**Authentication → Email templates**: put BMG wording into Invite, Confirm signup and Reset password.

## 5. Host the web app on Netlify

1. Netlify → Add new site → Import from GitHub → `bmg-pms`. Build settings come from `netlify.toml`
   (`npm ci && npm run build`, publish `dist`, Node 22).
2. **Site configuration → Environment variables**:
   - `VITE_SUPABASE_URL` = the Project URL
   - `VITE_SUPABASE_ANON_KEY` = the anon public key
3. Deploy. Open the Netlify address and check the sign-in page shows.
4. **Domain management → Add domain** `pms.bmggroup.co.tz`. At your DNS provider add
   `CNAME pms → <your-site>.netlify.app`. Netlify issues the HTTPS certificate by itself (minutes to an hour).
5. Back in Supabase step 4, set the Site URL to the final address.

For `npm run dev` on your own computer, copy `.env.example` to `.env.local` and use your **staging** project's
URL and anon key. Vite reads only these two; everything else lives in Supabase secrets.

`public/_headers` sets the security headers and `public/_redirects` sends every path to the app (needed for
the booking page links).

## 6. Become the platform administrator

1. On the live site, **Sign up** with your own email and confirm it.
2. Supabase **SQL Editor**:
   ```sql
   select pms_bootstrap_super_admin('you@bmggroup.co.tz');
   ```
3. Sign out and in again. **Control panel** appears. Go to **Sign-in security** and turn on two-step sign-in now: this
   account can change every property.
4. Control panel → **Administrators**: add a second administrator (and have them turn on two-step too).

From now on only administrators open properties.

## 7. Deploy the Edge Functions (integrations and payments)

```bash
supabase login
supabase link --project-ref <ref>
SUPABASE_PROJECT_REF=<ref> bash scripts/deploy-functions.sh
```

Then set the secrets. Every name, where to get each value and its format are in `supabase/secrets.env.example`:

```bash
cp supabase/secrets.env.example supabase/secrets.env      # fill it in (blank = not used yet)
supabase secrets set --env-file supabase/secrets.env --project-ref <ref>
supabase secrets list --project-ref <ref>                 # check
```

Or one at a time in Supabase → **Edge Functions → Secrets**. Make
`CRON_SECRET` and every `*_TOKEN` long random strings, e.g. `openssl rand -hex 32`.

| Group | Secrets | Needed for |
|---|---|---|
| Always | `CRON_SECRET`, `APP_ORIGINS=https://pms.bmggroup.co.tz` | Schedules; browser calls |
| BMG subscriptions | `CLICKPESA_CLIENT_ID_PLATFORM`, `CLICKPESA_API_KEY_PLATFORM` (+ `CLICKPESA_CHECKSUM_KEY_PLATFORM` if checksums are on in that account) | Owners paying BMG by phone |
| Guest mobile money | `CLICKPESA_CLIENT_ID`, `CLICKPESA_API_KEY`, `CLICKPESA_WEBHOOK_TOKEN` (+ `CLICKPESA_CHECKSUM_KEY`) | Desk and booking-page payments |
| SMS | `BEEM_API_KEY`, `BEEM_SECRET_KEY` | Door codes and guest texts |
| Channex | `CHANNEX_API_KEY`, `CHANNEX_BASE_URL=https://app.channex.io/api/v1`, `CHANNEX_WEBHOOK_TOKEN` | OTAs |
| TTLock | `TTLOCK_CLIENT_ID`, `TTLOCK_CLIENT_SECRET`, `TTLOCK_USERNAME`, `TTLOCK_PASSWORD` | Door codes |
| Fiscal | `VFD_API_KEY`, `VFD_ALLOWED_HOSTS` | TRA receipts |
| QuickBooks Online | `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI=https://<ref>.supabase.co/functions/v1/quickbooks-oauth`, `QBO_ENVIRONMENT=production` (or `sandbox`) | Sending suppliers, bills, payments and the daily journal |

While testing ClickPesa, also set `CLICKPESA_BASE_URL=https://api-sandbox.clickpesa.com` (and
`CLICKPESA_BASE_URL_PLATFORM` for BMG's account). Remove them to go live. A hotel with its own account for a
provider gets the property code as a suffix, e.g. `CLICKPESA_API_KEY_UH`.

## 8. Turn on the schedules

Open `supabase/schedules.sql`, replace the project URL and the cron secret (the same value as `CRON_SECRET`),
and run the whole file once in the SQL Editor. It schedules:

- payments (guests and BMG subscriptions), fiscal receipts and SMS every minute; Channex every 2 minutes;
  TTLock and QuickBooks every 5;
- the BMG billing run every hour inside the database (invoices, overdue, locks), so billing keeps going even if
  the functions are down;
- the **occupancy audit** every 30 minutes inside the database (yesterday and today, for every property with the
  Revenue assurance add-on and TTLock or Hikvision on);
- nightly clean-up of old logs.

Check after a few minutes: `select jobname, status, start_time from cron.job_run_details order by start_time desc limit 10;`

## 9. ClickPesa webhooks

In **each** ClickPesa account (BMG's and any hotel's), set the payment webhook to:

```
https://<ref>.supabase.co/functions/v1/clickpesa-webhook?token=<CLICKPESA_WEBHOOK_TOKEN>
```

The webhook only speeds things up: every payment is confirmed by asking ClickPesa directly, and the
minute-by-minute check catches anything the webhook misses. Subscription payments are recognised by their
`SUB…` reference and go to the subscription; guest payments (`BMG…`) go to the folio.

## 10. Set up billing (what properties pay BMG)

Control panel → **Billing**:

1. Click the **Standard** plan and set real prices: monthly fee, per active room, per active staff account,
   VAT % and free-trial days. Add other plans if you sell more than one (e.g. "Lodge", "Resort"), and tick the
   one that new properties start on.
2. Click each property: plan (or an **agreed monthly price**), **billing day** (1–28) and **free trial until**.
   Properties that existed before billing was switched on start with a 30-day trial.
3. How it runs, automatically:
   - On the billing day an invoice is issued for the month ahead, counting active rooms and staff that day.
   - Due 7 days later. From then owners and managers see a red strip on every screen.
   - 7 more days unpaid: the property **locks**. Staff cannot work in it; owners see only the bill and can pay.
   - Paid in full (by phone, or recorded by BMG) → unlocked at once.
4. Bank or cash payments: open the property → **Record payment** with the bank slip number.
   A promise to pay: set **Keep open until** to hold off the lock. A wrong invoice: **Void** (only while
   nothing is paid on it), then **Issue this month's invoice**.
5. Test once in the ClickPesa sandbox: give a test property a 1,000 TZS agreed price, issue its invoice, pay it
   from Setup → BMG PMS subscription with your own phone, and watch it turn Paid.
6. **Price list** (further down the Billing tab): click each module and integration and set its monthly price
   and, where it fits, a price per active room (Channex, TTLock). Untick "Switched on for new hotels" for anything
   sold separately. Only platform administrators can see or change these prices.
7. **Each hotel's package**: open the property → **Package**. Tick what the hotel bought; untick the rest (the
   screens disappear and the database refuses the work, e.g. no purchase orders without Procurement, no gym
   bills without Activities POS). **Price** sets an agreed price for that hotel or free months ("Free until"),
   with a note. Everything ticked is listed on the next monthly invoice; owners see it under Setup → BMG PMS
   subscription → Your package.

## 11. Open the properties

For each hotel, Control panel → **Open a property**: details, room types with number ranges
(`101-110, 112`), copy setup from a similar property, modules, and the owner's email. The owner gets an invite
and joins when they sign up with that email.

Then, signed in to the property (Setup):
1. Profile, logo and photos, policies, check-in/out times, formats and the night audit window.
2. Room types and rooms (check floors on the floor plan), rate plans, taxes.
3. Payment methods, extra charges, discounts, meal plans, transport.
4. Team → Roles (e.g. Front Office Associate) → People and access: invite staff with a role.
5. Team → Security rules: require two-step sign-in for everyone at the property.
6. Talking to guests → Online booking: switch on and share the link `https://pms.bmggroup.co.tz/#/book/<code>`.

**Import from eZee** (Administration → Import from eZee): export guests, future bookings and in-house guests from eZee as
CSV and import them. Re-running a file never duplicates.

## 12. Integrations, per property (when each is ready)

Administration → **Integrations**, one at a time:
- **Mobile money**: switch on; test with a small amount on a test folio.
- **SMS**: switch on once Beem approves the sender name; edit the messages.
- **Channex**: Load from Channex → map room types and rate plans; paste the webhook URL into Channex. Test on
  Channex staging first.
- **TTLock**: Load locks → map rooms. Check one real door with a guest code.
- **Hikvision** (cameras stay on the hotel network; a relay PC collects their movement and sends it on).
  Full notes, including what we learned on the first site test: `tools/hikvision-relay/README.md`.
  1. Control panel → property → Package: tick **Hikvision cameras**. In the hotel: Integrations → Hikvision →
     **Create relay key**.
  2. On each camera (or NVR) add a user for the relay, e.g. `pms-relay`, level Operator, a long unique password.
     Never use `admin`, and change any password that has been pasted into chats or messages.
  3. Camera detection: Configuration → Event → Basic Event → **Motion Detection**. Draw the grid over the whole
     doorway or walkway, sensitivity about **80**, target **Human**. (Narrow grids and sensitivity 50 missed most people.)
  4. Find each camera's address. Cameras with their own IP: use it. Cameras plugged into the NVR: NVR →
     Configuration → Network → Advanced Settings → **Virtual Host** → enable; each camera gets a port on the NVR's IP
     (e.g. `192.168.88.111:65001`).
  5. On the always-on PC (Node.js 18+): copy `tools/hikvision-relay` and `supabase/functions/_shared` keeping the
     layout (or unzip `bmg-relay-kit.zip`). In `tools/hikvision-relay`, copy `relay.env.example` to `relay.env` and
     fill in `PMS_URL`, `RELAY_KEY`, `PULL_HOSTS` (camera IPs or `IP:port`, comma-separated), `HIK_USER`, `HIK_PASS`,
     and `DEBUG=1` for now. Run `node relay.mjs` in that folder. The relay reads each camera's live event stream, so it
     works even when the NVR swallows smart events.
  6. Walk past a camera: the window shows `event vmd active ch 5 human`, then a `sighting` and `sent` line.
     Note each camera's channel number. Set `DEBUG=0`, then install it as a service and set the BIOS to power on
     after a power cut. Windows (NSSM, nssm.cc):
     `nssm install BMG-Relay "C:\Program Files\nodejs\node.exe" "C:\bmg\tools\hikvision-relay\relay.mjs"`, then
     `nssm set BMG-Relay AppDirectory C:\bmg\tools\hikvision-relay` and `nssm start BMG-Relay`.
     Linux: `pm2 start relay.mjs --name bmg-relay && pm2 save && pm2 startup`.
  7. Occupancy audit → **Cameras and rules**: one line per camera channel, saying what it watches (a room door and
     which room, the entrance, reception…). Recent camera events under Integrations → Hikvision show "Not matched"
     for any channel without a room.
  8. NVR and cameras: time zone GMT+3 with NTP on, so sightings land on the right stay.
  (If the NVR does forward events, push mode still works: NVR → HTTP Listening → this PC, port 8090, and run the
  relay with `PUSH=on ALLOWED_IPS=<NVR IP>`.)
- **VFD**: fill in the provider's endpoint and mapping; until then type EFD numbers by hand.
- **Tenda ICO**: only if a hotel keeps its existing Tenda ICO tills. Make a key per till; follow
  `integrations/tendaico/README.md`. New hotels use the built-in POS below instead.
- **POS, kitchen display and stores** (Point of sale → Outlets and menu, then Stock and stores, then Procurement):
  1. Outlets: one per restaurant, bar, room service, gym, spa, pool. Tick "Uses tables" and set the service charge
     for the restaurant; choose the stock location each outlet sells from.
  2. Menu: categories (each sent to the **kitchen** or the **bar**), items with recipes, option groups ("How cooked",
     "Sides" with prices), tables by zone, and happy hours.
  3. Kitchen and bar: open **Kitchen and bar display** on a screen or tablet at each station (choose Kitchen or Bar;
     it refreshes itself). Give cooks a role with the "Kitchen display" ability only.
  4. Stores: locations (main store, kitchen, bars, gym, spa, housekeeping), items with **Bought as** (crate of 25),
     **Units each** (25) and **Usual supplier**; set par levels under Procurement → Reorder.
  5. Procurement → Suppliers (TIN, VRN, payment terms). Purchase orders → **change** the approval limit: orders
     above it wait for a manager other than the buyer (0 = every order).
  6. Test: ask the store for stock from the kitchen and issue it; order from a supplier, approve, receive part
     of it, enter the supplier's invoice (try a different price: it is flagged), accept it and pay.
- **QuickBooks Online** (once per BMG, then per hotel):
  1. At developer.intuit.com, sign in with BMG's account → **Create an app** → QuickBooks Online and Payments →
     scope **com.intuit.quickbooks.accounting**.
  2. Keys and credentials → add the redirect URI `https://<ref>.supabase.co/functions/v1/quickbooks-oauth`
     (development keys for sandbox companies, production keys after Intuit's app assessment questionnaire).
  3. Put the client ID and secret into `QBO_CLIENT_ID` and `QBO_CLIENT_SECRET`, the URI into `QBO_REDIRECT_URI`,
     `QBO_ENVIRONMENT` = `sandbox` or `production`, and re-run `supabase secrets set` (step 7). `APP_ORIGINS` must
     hold the app address: QuickBooks sends people back there.
  4. In the hotel: **QuickBooks** in the menu (owner, manager or accountant) → **Connect QuickBooks**, sign in with
     an admin of that hotel's company, pick the company.
  5. Match every line to an account in their chart (revenue per department, VAT collected, cash, mobile money,
     card clearing, bank, guest ledger, inventory, cost of sales, waste, purchases, input VAT…).
  6. Set **First day to send** to the day after the last day entered by hand, so nothing is booked twice.
     **Preview journal** for yesterday: debits must equal credits, nothing "Not matched". Then **Send this day**
     and check it in QuickBooks under Journal entries (number `PMS-YYYYMMDD`).
  7. From then on it runs by itself: each night audit queues the day, suppliers, invoices and payments go as they
     are saved, every 5 minutes. Failed sends show with QuickBooks' reason and a **Retry failed** button.

## 12a. Occupancy audit (cameras + locks + PMS, per property)

Every 30 minutes the database compares, room by room, **people the cameras saw** and **doors the locks opened**
with **check-ins, check-outs and payments**, and records a finding for anything that does not add up:

| Finding | When | Severity |
|---|---|---|
| Used while vacant | A person or a guest code in a room with no guest booked in | High |
| Not checked in | Activity in a room whose booking is still not checked in | High |
| Unknown code | A door code the PMS never issued for that room (codes handed out off the system) | High |
| Left owing | Checked out with money still owed (company accounts excepted) | High |
| Before check-in / After check-out | Activity more than the allowed minutes before check-in or after check-out | Medium |
| Nothing paid | In house past the first night with no payment at all | Medium |
| No activity | Checked in, but no door or camera activity all day | Low |

Set it up once per property:

1. Control panel → property → Package: tick **Revenue assurance** (and TTLock and/or Hikvision cameras).
2. Integrations → TTLock → **Staff codes and cards**: every housekeeping, maintenance and manager code or card
   name as it appears in TTLock records. Their openings are staff; a person seen on that room's camera within
   the "staff visit" minutes after is staff too.
3. Occupancy audit → **Cameras and rules**:
   - one line per camera channel: what it watches (room door + room, entrance, reception, corridor, outlet);
   - allowances: minutes allowed before check-in (default 60) and after check-out (60), how long a staff visit
     lasts (30), and after how many nights "nothing paid" is flagged (1);
   - **Text high findings to**: up to five managers' phones (needs SMS switched on). Each new high finding is
     texted once.
4. Train the desk: every guest who gets a room is **checked in in the PMS** and gets a **PMS-issued door code**;
   every departure is **checked out** with the folio settled or moved to the company account.
5. Each morning a manager opens **Occupancy audit → Findings**, opens each one (a timeline shows check-ins,
   door openings and people seen, from 6 pm the evening before to 6 am the morning after) and records the outcome:
   **Explained**, **Charged** (posted to a folio), **Loss** or **False alarm**, with what was found. Only owners and
   managers clear findings (ability "Clear occupancy audit findings"); accountants can read everything.
6. Reports: **Day by day** (rooms sold against rooms used, people at the entrance against guests, findings and
   money at risk), **Rooms by day**, **Summary** (by kind and outcome over a period), all exportable to CSV, and the
   same two in Reports → Audit. Today shows the number of open findings.

A finding is a prompt to check, not proof. Cameras miss people and see staff; codes can be shared. The money
at risk is one night at the stay's rate (or the room type's rate) for occupancy findings, and the balance owed for
money findings.

## 13. CI/CD pipeline (recommended before go-live)

From here on, nobody deploys by hand. Follow `scripts/README-deploy.md` once (about 30 minutes):

1. A second Supabase project and Netlify site for **staging**; stop Netlify's own builds on both sites.
2. GitHub Environments `staging`, `production` (with required approvers) and `preview`, each with its values.
3. Branch protection on `main`: pull requests only, Code Owner review, `checks` and `tests` must pass.

Then: every pull request is linted, checked module by module, tested (21 suites) and tried in a browser, and gets
its own preview site. Merging to `main` deploys to staging automatically, then to production after approval, with
the isolation report and a smoke test after each. Releases are tagged; rolling back the app is one click.
If a property ever needs its own database, it becomes one more production target (same code, separate data).

## 14. Backups and monitoring

- Supabase **Database → Backups**: daily backups are on with Pro; add **Point in time recovery** for the money
  records.
- Once a month: `pg_dump "$DATABASE_URL" > bmg-pms-$(date +%F).sql` to BMG's own storage.
- Watch: Control panel (failed tasks per property, locked properties), Integrations health (green/amber/red),
  Supabase **Logs → Edge Functions**, and Netlify deploy emails.

## 15. Security check before go-live

- [ ] Every administrator and owner has two-step sign-in on.
- [ ] `service_role` key is not in Netlify, GitHub or any device; only Supabase has it.
- [ ] `APP_ORIGINS` is the live address; all `*_TOKEN` values are long and random.
- [ ] Sandbox `*_BASE_URL` secrets removed.
- [ ] SMTP works: invite a test address, reset a password.
- [ ] A front-desk test account cannot open Setup, Reports it is not given, or another property.
- [ ] Camera passwords: a separate `pms-relay` user on each camera and NVR; `admin` passwords changed if they were
      ever pasted into chats or messages; `relay.env` exists only on the relay PC.

## 16. Test day (one property, before real guests)

Walk through a full day on a test property, or the real one before opening: make a booking, check in
(dirty-room warning), move the room (the charge question appears), post a POS bill to the room, take a mobile
money payment, check out, close the drawer, run the night audit (dark screen from the audit window until it
runs), print a folio, run the daily revenue report. Then pay a test subscription invoice (step 10.5).

## 17. Switch over from eZee

1. Run both systems side by side for 5–7 days; compare the night audit totals each morning.
2. On the switch day: import in-house guests with balances from eZee, close eZee for new bookings, point
   Channex at BMG PMS, hand out the new sign-ins.
3. Keep eZee read-only for 3 months for look-ups.

## Upgrading later

Every release: `bash scripts/db-push.sh` → `bash scripts/deploy-functions.sh` → push to `main` (Netlify
rebuilds). Or let step 13 do all three. Migrations are safe to re-run; nothing is lost.

## Try it without any accounts

`tests/local-stack/` runs the whole app on your computer with demo data (see its README): owner
`bbalati@bmggroup.co.tz`, front desk `frontdesk@bmggroup.co.tz`, a locked property's owner
`owner@upanga.co.tz`, all with password `demo1234`.
