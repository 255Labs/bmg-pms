// Database modules: who owns each table and function, and a check that a migration only changes its own module
// unless it says otherwise. Runs every migration on an embedded Postgres, one file at a time.
//
//   node scripts/db-modules.mjs check     CI: headers, module boundaries, re-run safety, isolation, lock files up to date
//   node scripts/db-modules.mjs lock      rewrite supabase/schema/<module>.lock.json after an intended change (commit them)
//   node scripts/db-modules.mjs headers   fill in missing "-- also:" lines from what each file really changes
//
// A migration starts with:   -- module: stock
// and, if it changes tables or functions another module owns:   -- also: front-office, cashiering
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIG = join(root, 'supabase/migrations');
const LOCKS = join(root, 'supabase/schema');
const cfg = JSON.parse(readFileSync(join(root, 'supabase/modules.json'), 'utf8'));
const MODULES = Object.keys(cfg.modules);
const SKIP_COLS = new Set(cfg.platformManaged.columns);
const SKIP_TRG = new Set(cfg.platformManaged.triggers);
const cmd = process.argv[2] ?? 'check';
const problems = [];
const fail = (m) => problems.push(m);
const md5 = (s) => createHash('md5').update(s).digest('hex').slice(0, 12);

// ---------------------------------------------------------------- headers
const files = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
const header = (f) => {
  const lines = readFileSync(join(MIG, f), 'utf8').split('\n').slice(0, 3);
  const mod = lines[0].match(/^-- module:\s*([a-z-]+)\s*$/)?.[1];
  const also = (lines.find((l) => l.startsWith('-- also:')) ?? '').replace('-- also:', '').split(',').map((x) => x.trim()).filter(Boolean);
  return { mod, also };
};
for (const f of files) {
  const h = header(f);
  if (!/^\d{2,}_[a-z0-9_]+\.sql$/.test(f)) fail(`${f}: name it NN_short_description.sql`);
  if (!h.mod) fail(`${f}: first line must be "-- module: <one of ${MODULES.join(', ')}>"`);
  else if (!MODULES.includes(h.mod)) fail(`${f}: unknown module "${h.mod}" (add it to supabase/modules.json)`);
  for (const a of h.also) if (!MODULES.includes(a)) fail(`${f}: unknown module "${a}" in "-- also:"`);
}

// ---------------------------------------------------------------- database
const db = new PGlite({ extensions: { btree_gist } });
await db.exec(`
  do $$ begin create role authenticated; create role anon; create role service_role; exception when duplicate_object then null; end $$;
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key, email text unique);
  create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;`);

// Everything in public that a module can own, each with a fingerprint of its definition
async function snapshot() {
  const out = new Map();
  const fns = (await db.query(`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as k, pg_get_functiondef(p.oid) as d
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p')`)).rows;
  for (const r of fns) out.set('function ' + r.k, md5(r.d));
  const rels = (await db.query(`select c.oid, c.relname, c.relkind from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m')`)).rows;
  for (const r of rels) {
    const cols = (await db.query(`select a.attname, format_type(a.atttypid, a.atttypmod) t, a.attnotnull nn, pg_get_expr(d.adbin, d.adrelid) def
      from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attname`, [r.oid])).rows.filter((c) => !SKIP_COLS.has(c.attname));
    const cons = (await db.query(`select conname, pg_get_constraintdef(oid) d from pg_constraint where conrelid = $1 order by conname`, [r.oid])).rows;
    const idx = (await db.query(`select indexrelid::regclass::text n, pg_get_indexdef(indexrelid) d from pg_index where indrelid = $1 order by 1`, [r.oid])).rows;
    const pol = (await db.query(`select polname, polcmd, pg_get_expr(polqual, polrelid) q, pg_get_expr(polwithcheck, polrelid) w from pg_policy where polrelid = $1 order by polname`, [r.oid])).rows;
    const trg = (await db.query(`select tgname, tgfoid::regproc::text f, tgtype from pg_trigger where tgrelid = $1 and not tgisinternal order by tgname`, [r.oid])).rows.filter((t) => !SKIP_TRG.has(t.tgname));
    const view = r.relkind === 'r' ? '' : (await db.query(`select pg_get_viewdef($1::oid) d`, [r.oid])).rows[0].d;
    out.set((r.relkind === 'r' ? 'table ' : 'view ') + r.relname, md5(JSON.stringify({ cols, cons, idx, pol, trg, view })));
  }
  return out;
}

const owner = new Map();          // object -> module that created it
const touched = new Map();        // file -> set of other modules it changed
let prev = await snapshot();
for (const f of files) {
  const { mod, also } = header(f);
  try { await db.exec(readFileSync(join(MIG, f), 'utf8')); } catch (e) { fail(`${f}: does not run: ${e.message}`); break; }
  const now = await snapshot();
  const others = new Set();
  for (const [k, h] of now) {
    if (!prev.has(k)) { if (!owner.has(k)) owner.set(k, mod); continue; }
    if (prev.get(k) !== h && owner.get(k) && owner.get(k) !== mod) others.add(owner.get(k));
  }
  for (const k of prev.keys()) if (!now.has(k) && owner.get(k) && owner.get(k) !== mod) others.add(owner.get(k));
  touched.set(f, others);
  const undeclared = [...others].filter((m) => !also.includes(m));
  if (undeclared.length && cmd === 'check') fail(`${f} (module ${mod}) changes ${undeclared.join(', ')} without declaring it: add "-- also: ${[...others].sort().join(', ')}" as its second line`);
  prev = now;
}

// Re-run safety: applying every file again must change nothing
if (!problems.length) {
  for (const f of files) { try { await db.exec(readFileSync(join(MIG, f), 'utf8')); } catch (e) { fail(`${f}: fails when run a second time: ${e.message}`); break; } }
  const again = await snapshot();
  for (const [k, h] of again) if (prev.get(k) !== h) fail(`re-running the migrations changes ${k}`);
  // Property isolation (migration 21's report): nothing may break it
  try {
    const iso = (await db.query(`select * from pms__isolation_problems()`)).rows;
    for (const r of iso) fail(`isolation: ${r.problem} on ${r.tbl} ${r.detail}`);
  } catch { /* before migration 21 */ }
}

// ---------------------------------------------------------------- lock files: one per module, reviewed in pull requests
const lockOf = (m) => {
  const o = {};
  for (const [k, h] of [...prev].sort(([a], [b]) => a.localeCompare(b))) if (owner.get(k) === m) o[k] = h;
  return o;
};
if (cmd === 'headers') {
  for (const f of files) {
    const others = [...(touched.get(f) ?? [])].sort();
    const p = join(MIG, f); const lines = readFileSync(p, 'utf8').split('\n');
    const i = lines.findIndex((l, n) => n < 3 && l.startsWith('-- also:'));
    if (i >= 0) lines.splice(i, 1);
    if (others.length) lines.splice(1, 0, `-- also: ${others.join(', ')}`);
    writeFileSync(p, lines.join('\n'));
  }
  console.log('Headers written.');
} else if (cmd === 'lock') {
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  if (!existsSync(LOCKS)) mkdirSync(LOCKS, { recursive: true });
  for (const m of MODULES) writeFileSync(join(LOCKS, `${m}.lock.json`), JSON.stringify(lockOf(m), null, 1) + '\n');
  console.log(`Lock files written for ${MODULES.length} modules (${prev.size} objects).`);
} else {
  const changed = [];
  for (const m of MODULES) {
    const p = join(LOCKS, `${m}.lock.json`);
    const want = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    const have = lockOf(m);
    if (!want) { fail(`supabase/schema/${m}.lock.json is missing: run npm run db:lock`); continue; }
    const diff = [...new Set([...Object.keys(want), ...Object.keys(have)])].filter((k) => want[k] !== have[k]);
    if (diff.length) { changed.push(m); fail(`module ${m}: ${diff.length} object(s) differ from its lock file (${diff.slice(0, 5).join('; ')}${diff.length > 5 ? '…' : ''}). If intended, run npm run db:lock and commit supabase/schema/`); }
  }
  const counts = MODULES.map((m) => `${m} ${Object.keys(lockOf(m)).length}`).join(' · ');
  console.log(`Modules: ${counts}`);
  if (problems.length) { console.error('\n✗ ' + problems.join('\n✗ ')); process.exit(1); }
  console.log(`✓ ${files.length} migrations: headers, module boundaries, re-run safety, property isolation and lock files all good.`);
}
