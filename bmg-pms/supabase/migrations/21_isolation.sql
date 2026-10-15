-- module: platform
-- also: access, back-office
-- 21 · Property and user isolation, enforced by the database for every table, present and future
--
--  1. Every table that holds a property's data carries property_id (the two child tables that did not now do).
--  2. A row can never move to another property: property_id is fixed once written.
--  3. A row can never point at another property's row: the cross-property guard from 13 is rebuilt over every
--     table (tables added in 14–20 were not covered) and is rebuilt again by every later migration that runs this file.
--  4. Every property row records who created it and who last changed it, and when (created_by / updated_by are the
--     signed-in user's id; empty when the system itself did it, e.g. the night audit worker).
--  5. pms_isolation_report() lists any row that breaks 1–3, for the CI pipeline and administrators.
-- Safe to re-run.

-- ---------------------------------------------------------------------
-- 1. property_id on the remaining child tables
-- ---------------------------------------------------------------------
alter table pms_pos_bill_items add column if not exists property_id uuid references pms_properties(id) on delete cascade;
update pms_pos_bill_items i set property_id = b.property_id from pms_pos_bills b where b.id = i.bill_id and i.property_id is null;
alter table pms_pos_bill_items alter column property_id set not null;
create index if not exists ix_pos_bill_items_property on pms_pos_bill_items (property_id);

alter table pms_custom_role_privileges add column if not exists property_id uuid references pms_properties(id) on delete cascade;
update pms_custom_role_privileges x set property_id = r.property_id from pms_custom_roles r where r.id = x.role_id and x.property_id is null;
alter table pms_custom_role_privileges alter column property_id set not null;
create index if not exists ix_custom_role_privileges_property on pms_custom_role_privileges (property_id);

-- Filled from the parent row, so the code that inserts these rows does not have to change
create or replace function pms__inherit_property() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_col text := tg_argv[0]; v_tbl text := tg_argv[1]; v_prop uuid;
begin
  execute format('select property_id from %I where id = $1', v_tbl) into v_prop using (to_jsonb(new)->>v_col)::uuid;
  if new.property_id is null then new.property_id := v_prop; end if;
  return new;
end $$;
drop trigger if exists trg_inherit_property on pms_pos_bill_items;
create trigger trg_inherit_property before insert on pms_pos_bill_items for each row execute function pms__inherit_property('bill_id', 'pms_pos_bills');
drop trigger if exists trg_inherit_property on pms_custom_role_privileges;
create trigger trg_inherit_property before insert on pms_custom_role_privileges for each row execute function pms__inherit_property('role_id', 'pms_custom_roles');

-- ---------------------------------------------------------------------
-- 2. property_id never changes
-- ---------------------------------------------------------------------
create or replace function pms__fixed_property() returns trigger
language plpgsql as $$
begin
  if new.property_id is distinct from old.property_id then
    raise exception 'Records cannot be moved to another property';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 4. Who created and who last changed each row
-- ---------------------------------------------------------------------
create or replace function pms__stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.updated_at is not distinct from old.updated_at then new.updated_at := now(); end if;
  new.updated_by := auth.uid();
  if not pms__is_service() then        -- creation details cannot be rewritten from the app
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 3. No row points at another property's row (rebuilt over every table)
-- ---------------------------------------------------------------------
create or replace function pms__rebuild_isolation() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in
    select c.conrelid::regclass::text as tbl,
           array_agg(distinct a.attname || ':' || c.confrelid::regclass::text) as args
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1
      and c.confrelid <> 'pms_properties'::regclass
      and exists (select 1 from pg_attribute x where x.attrelid = c.conrelid and x.attname = 'property_id' and not x.attisdropped)
      and exists (select 1 from pg_attribute x where x.attrelid = c.confrelid and x.attname = 'property_id' and not x.attisdropped)
    group by c.conrelid
  loop
    execute format('drop trigger if exists trg_same_property on %s', r.tbl);
    execute format('create trigger trg_same_property before insert or update on %s for each row execute function pms__same_property(%s)',
      r.tbl, (select string_agg(quote_literal(x), ', ') from unnest(r.args) x));
    n := n + 1;
  end loop;
  return n;
end $$;

-- Everything the platform adds to every property table, in one call. Every later migration ends with
-- "select pms__apply_platform_rules();" so tables it creates get the same treatment.
create or replace function pms__apply_platform_rules() returns int
language plpgsql security definer set search_path = public as $$
declare t text; c text;
begin
  for t in
    select c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and (c.relname = 'pms_properties' or exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'property_id' and not a.attisdropped))
  loop
    execute format('alter table %I add column if not exists created_at timestamptz default now()', t);
    execute format('alter table %I add column if not exists created_by uuid default auth.uid()', t);
    execute format('alter table %I add column if not exists updated_at timestamptz', t);
    execute format('alter table %I add column if not exists updated_by uuid', t);
    execute format('drop trigger if exists zz_stamp on %I', t);
    execute format('create trigger zz_stamp before update on %I for each row execute function pms__stamp()', t);
    if t <> 'pms_properties' then
      execute format('drop trigger if exists trg_fixed_property on %I', t);
      execute format('create trigger trg_fixed_property before update of property_id on %I for each row execute function pms__fixed_property()', t);
    end if;
  end loop;
  -- every foreign key gets an index (same names as the clean-up in 13 and 15)
  for t, c in
    select c.conrelid::regclass::text, a.attname
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1
      and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1])
  loop
    execute format('create index if not exists %I on %s (%I)', left('ix_' || t || '_' || c, 63), t, c);
  end loop;
  return pms__rebuild_isolation();
end $$;
select pms__apply_platform_rules();

-- ---------------------------------------------------------------------
-- 5. Report: anything that breaks the rules (empty = isolated)
-- ---------------------------------------------------------------------
create or replace function pms__isolation_problems() returns table(problem text, tbl text, detail text)
language plpgsql security definer set search_path = public as $$
declare r record; n bigint;
begin
  -- property data without property_id, or with it optional
  for r in
    select c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and c.relname not in (select unnest(pms__global_tables()))
      and not exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'property_id' and a.attnotnull and not a.attisdropped)
  loop
    return query select 'no property_id'::text, r.relname::text, 'every property table needs a required property_id, or must be listed in pms__global_tables()'::text;
  end loop;
  -- property tables without the who-and-when columns
  for r in
    select c.relname from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'property_id' and not a.attisdropped)
      and (select count(*) from pg_attribute a where a.attrelid = c.oid and not a.attisdropped
           and a.attname in ('created_at','created_by','updated_at','updated_by')) < 4
  loop
    return query select 'no audit columns'::text, r.relname::text, 'run pms__apply_platform_rules() at the end of the migration'::text;
  end loop;
  -- tables without row level security
  for r in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity loop
    return query select 'no row level security'::text, r.relname::text, ''::text;
  end loop;
  -- references between property tables without the same-property guard, and rows that already cross
  for r in
    select c.conrelid::regclass::text as child, a.attname::text as col, c.confrelid::regclass::text as parent
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace and array_length(c.conkey, 1) = 1
      and c.confrelid <> 'pms_properties'::regclass
      and exists (select 1 from pg_attribute x where x.attrelid = c.conrelid and x.attname = 'property_id' and not x.attisdropped)
      and exists (select 1 from pg_attribute x where x.attrelid = c.confrelid and x.attname = 'property_id' and not x.attisdropped)
  loop
    if not exists (select 1 from pg_trigger t where t.tgrelid = r.child::regclass and t.tgname = 'trg_same_property'
                   and encode(t.tgargs, 'escape') like '%' || r.col || ':' || r.parent || '%') then
      return query select 'unguarded reference'::text, r.child, r.col || ' → ' || r.parent;
    end if;
    execute format('select count(*) from %s c join %s p on p.id = c.%I where p.property_id is distinct from c.property_id', r.child, r.parent, r.col) into n;
    if n > 0 then return query select 'rows cross properties'::text, r.child, n || ' rows via ' || r.col; end if;
  end loop;
end $$;

-- The only tables that are not one property's data: the platform's own
create or replace function pms__global_tables() returns text[]
language sql immutable as $$
  select array['pms_properties','pms_platform_admins','pms_plans','pms_privilege_catalog','pms_sign_ins',
               'pms_audit_log','pms_integration_log']   -- the two logs also hold platform-wide entries with no property
$$;

create or replace function pms_admin_isolation_report() returns table(problem text, tbl text, detail text)
language plpgsql stable security definer set search_path = public as $$
begin perform pms__require_admin(); return query select * from pms__isolation_problems(); end $$;

do $$
declare r record;
begin
  for r in select p.oid::regprocedure as fn from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname not like 'pms\_public\_%' loop
    execute format('revoke execute on function %s from public, anon', r.fn);
  end loop;
end $$;
revoke execute on function pms__stamp(), pms__fixed_property(), pms__inherit_property(), pms__rebuild_isolation(), pms__apply_platform_rules(), pms__isolation_problems(), pms__global_tables() from authenticated;
grant execute on function pms_admin_isolation_report() to authenticated;
do $$ begin execute 'grant execute on all functions in schema public to service_role'; exception when undefined_object then null; end $$;
notify pgrst, 'reload schema';
