// Database structure report: loads every migration into an embedded Postgres TWICE (re-run safety), then checks the
// structure the platform relies on and prints a summary. Exit code 1 if any check fails.
// Run: npm run db:report      (writes db-report.md too)
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const db = new PGlite({ extensions: { btree_gist } });
await db.exec(`
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text unique, created_at timestamptz default now(), last_sign_in_at timestamptz, email_confirmed_at timestamptz default now());
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;`);
const files = readdirSync(join(root, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
const t0 = Date.now();
for (const f of files) await db.exec(readFileSync(join(root, 'supabase/migrations', f), 'utf8'));
const firstMs = Date.now() - t0;
let rerun = 'ok';
try { for (const f of files) await db.exec(readFileSync(join(root, 'supabase/migrations', f), 'utf8')); } catch (e) { rerun = String(e.message); }

const q = async (sql) => (await db.query(sql)).rows;
const n = async (sql) => Number(Object.values((await q(sql))[0])[0]);
const names = async (sql) => (await q(sql)).map((r) => Object.values(r)[0]);
const PUB = `relnamespace = 'public'::regnamespace`;
const FN = `pronamespace = 'public'::regnamespace and proname like 'pms%'`;

const stats = {
  migrations: files.length,
  tables: await n(`select count(*) from pg_class where ${PUB} and relkind = 'r'`),
  propertyTables: await n(`select count(*) from pg_class c where ${PUB} and relkind = 'r' and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'property_id' and not a.attisdropped)`),
  views: await n(`select count(*) from pg_class where ${PUB} and relkind in ('v','m')`),
  functions: await n(`select count(*) from pg_proc where ${FN}`),
  definer: await n(`select count(*) from pg_proc where ${FN} and prosecdef`),
  triggers: await n(`select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where ${PUB} and not t.tgisinternal`),
  policies: await n(`select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid where ${PUB}`),
  indexes: await n(`select count(*) from pg_index i join pg_class c on c.oid = i.indrelid where ${PUB}`),
  foreignKeys: await n(`select count(*) from pg_constraint where connamespace = 'public'::regnamespace and contype = 'f'`),
  checks: await n(`select count(*) from pg_constraint where connamespace = 'public'::regnamespace and contype = 'c'`),
  abilities: await n(`select count(*) from pms_privilege_catalog`),
  addons: await n(`select count(*) from pms_catalog`),
};

const checks = [];
const check = async (name, sql, expectEmpty = true) => {
  const list = await names(sql);
  checks.push({ name, ok: expectEmpty ? list.length === 0 : list.length > 0, detail: list.slice(0, 8).join(', ') });
};
checks.push({ name: 'Every migration loads, then loads again over itself (re-run safe)', ok: rerun === 'ok', detail: rerun === 'ok' ? '' : rerun });
await check('Row security on every table', `select relname from pg_class where ${PUB} and relkind = 'r' and not relrowsecurity`);
// platform-wide tables (logs that can be about no property, the price list…) are listed by pms__global_tables()
await check('property_id is required wherever it exists (platform-wide tables excepted)', `select c.relname from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'property_id' where ${PUB.replace('relnamespace', 'c.relnamespace')} and c.relkind = 'r' and not a.attnotnull
  and c.relname <> all (pms__global_tables())`);
await check('Every foreign key has an index', `select c.conrelid::regclass::text || '.' || a.attname from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
  where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1
  and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])`);
await check('Every table has a primary key', `select relname from pg_class c where ${PUB} and relkind = 'r' and not exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p')`);
await check('Privileged functions pin their search_path', `select proname from pg_proc where ${FN} and prosecdef and not exists (select 1 from unnest(coalesce(proconfig, '{}')) x where x like 'search_path=%')`);
await check('Internal helpers (pms__*, pms_svc_*, triggers) not callable by signed-in users', `select proname from pg_proc where pronamespace = 'public'::regnamespace
  and (proname like 'pms\\_\\_%' or proname like 'pms\\_svc\\_%' or prorettype = 'trigger'::regtype) and has_function_privilege('authenticated', oid, 'execute')`);
await check('Anonymous callers reach only the booking page and the guest portal', `select proname from pg_proc where ${FN} and has_function_privilege('anon', oid, 'execute')
  and proname not like 'pms\\_public\\_%' and proname not like 'pms\\_portal\\_%'`);
await check('No table readable by anonymous callers', `select relname from pg_class where ${PUB} and relkind in ('r','v') and has_table_privilege('anon', oid, 'select')`);
await check('Property isolation report is empty', `select problem || ': ' || tbl from pms__isolation_problems()`);
await check('Every ability the app knows is in the database', `select k from unnest(array[${[...readFileSync(join(root, 'src/lib/privileges.js'), 'utf8').matchAll(/key: '([a-z_]+\.[a-z_]+)'/g)].map((m) => `'${m[1]}'`).join(',')}]) k
  where not exists (select 1 from pms_privilege_catalog c where c.key = k)`);
await check('Every add-on in the price list has a row at every property', `select p.name || ' / ' || c.key from pms_properties p cross join pms_catalog c
  where not exists (select 1 from pms_property_addons a where a.property_id = p.id and a.key = c.key)`);
await check('Money columns use exact numbers (no float)', `select c.relname || '.' || a.attname from pg_attribute a join pg_class c on c.oid = a.attrelid
  where ${PUB.replace('relnamespace', 'c.relnamespace')} and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped and a.atttypid in ('float4'::regtype, 'float8'::regtype)`);
// pms_channex_revisions.status records exactly what Channex sent (new, modified, cancelled…), so it stays open
await check('Status columns are limited to known values (copies of a partner\'s status excepted)', `select c.relname || '.' || a.attname from pg_attribute a join pg_class c on c.oid = a.attrelid
  where ${PUB.replace('relnamespace', 'c.relnamespace')} and c.relkind = 'r' and a.attname = 'status' and not a.attisdropped and c.relname <> 'pms_channex_revisions'
  and not exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'c' and pg_get_constraintdef(k.oid) ilike '%status%')`);
await check('A room can never hold two live stays the same night', `select 'missing' where not exists (select 1 from pg_constraint where conname = 'pms_stays_no_double_booking')`);

const ok = checks.every((c) => c.ok);
const lines = [
  `# Database structure report`, '',
  `${stats.migrations} migrations, loaded in ${(firstMs / 1000).toFixed(1)} s and again over themselves.`, '',
  '| Objects | Count |', '|---|---|',
  ...Object.entries({ Tables: stats.tables, 'Tables holding a property\'s data': stats.propertyTables, Views: stats.views, Functions: stats.functions,
    '…of which privileged (security definer)': stats.definer, Triggers: stats.triggers, 'Row-security policies': stats.policies, Indexes: stats.indexes,
    'Foreign keys': stats.foreignKeys, 'Check constraints': stats.checks, 'Abilities (privileges)': stats.abilities, 'Sellable modules and integrations': stats.addons })
    .map(([k, v]) => `| ${k} | ${v} |`),
  '', '| Check | Result |', '|---|---|',
  ...checks.map((c) => `| ${c.name} | ${c.ok ? 'Pass' : `**Fail**: ${c.detail}`} |`),
  '', ok ? 'All structure checks pass.' : 'Some checks failed.',
];
writeFileSync(join(root, 'db-report.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
process.exit(ok ? 0 : 1);
