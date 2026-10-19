# Local demo stack (optional)

Runs the whole PMS on your machine with no Supabase account: an embedded Postgres
(PGlite) loaded with the real migrations and demo data, the real PostgREST API
server, and a minimal sign-in endpoint. Used to test the app end to end.

```bash
cd tests/local-stack
npm init -y && npm i @electric-sql/pglite @electric-sql/pglite-socket jsonwebtoken
curl -L -o pgrst.tar.xz https://github.com/PostgREST/postgrest/releases/download/v12.2.3/postgrest-v12.2.3-linux-static-x64.tar.xz
tar xf pgrst.tar.xz            # gives ./postgrest (use the macOS/Windows build on those systems)
cd ../.. && VITE_SUPABASE_URL=http://localhost:54321 VITE_SUPABASE_ANON_KEY=demo npm run build
node tests/local-stack/server.mjs
```

Open http://localhost:54321 and sign in as `bbalati@bmggroup.co.tz` / `demo1234`
(owner) or `frontdesk@bmggroup.co.tz` / `demo1234` (front desk).
Data lives in memory and resets on restart. Never use this for production.

Also seeded: `housekeeping@bmggroup.co.tz` / `demo1234`, two custom roles (Front Office Associate, Revenue Manager),
with the front desk user on Front Office Associate plus voids switched on.

Subscriptions: Unreal Homes paid last month and has this month's invoice due in two days (the strip at the top).
Upanga Lodge is locked for an unpaid invoice: sign in as `owner@upanga.co.tz` / `demo1234` to see the lock screen and
pay. `bbalati@` is a platform administrator (never locked out): Control panel → Billing shows every property.

Guest portal: Lulu Kayanda (room 334) is signed in to her portal and has asked for towels and dinner. The server
prints her link at start-up and writes it to `tests/local-stack/.portal-link`. Open it in another browser (or a
private window): ask for a key with `lulu.kayanda@example.com`, or press **Key for the guest** on her reservation
and choose "Reception gave me a key". Send a request from the portal and watch it pop up on the staff screen within
ten seconds.

**Layout check.** With the stack running, `pip install playwright` and run
`python3 tests/local-stack/layout-audit.py` (optionally with widths, e.g. `1440 390`). It visits every screen, every
Setup section, the reservation tabs, the payment and access dialogs, the booking page and the guest portal at 1440, 1280, 1024 and
390 px, and lists anything cut off, spilling out of its box or forcing the page to scroll sideways. It should print
`PAGES WITH ISSUES: 0`.
