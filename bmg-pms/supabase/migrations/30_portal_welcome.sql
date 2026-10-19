-- module: guest-portal
-- also: core
-- 30 · Guest portal welcome: the guest's own welcome page with their booking, the hotel guide, documents and offers
--
--  - Welcome page (the first thing a guest sees after signing in): "Karibu <name>", the welcome letter written by the
--    hotel, the booking (reservation number, room and type, dates and nights, guests, rate plan, check-in and
--    check-out times), Wi-Fi, and a printable copy.
--  - Hotel guide: sections the hotel writes (breakfast hours, pool, house rules, emergency numbers…), with an
--    optional photo or PDF manual each.
--  - Offers and ads: spa deals, tours, airport transfers… with a photo, price and dates they run; the guest taps
--    "I'm interested" and staff get it like any other request.
--  - Only owners and managers change the content; links and files must be https. Guests see it only while
--    signed in to their own stay.
--  - The portal's look per hotel, set by BMG's platform administrators: a ready-made theme (BMG, Ocean, Safari,
--    Forest, Sunset, Midnight gold) or own colours, the heading style, a tagline and up to 8 hotel photos for the
--    slideshow at the top (the hotel's own gallery photos follow them).
-- Safe to re-run.

create table if not exists pms_portal_content (
  id           uuid primary key default gen_random_uuid(),
  property_id  uuid not null references pms_properties(id) on delete cascade,
  kind         text not null check (kind in ('guide','offer','document')),
  title        text not null check (length(trim(title)) between 1 and 120),
  body         text check (body is null or length(body) <= 4000),
  image_url    text check (image_url is null or image_url ~ '^https://[^\s<>"]+$'),
  file_url     text check (file_url is null or file_url ~ '^https://[^\s<>"]+$'),
  link_url     text check (link_url is null or link_url ~ '^https://[^\s<>"]+$'),
  price        numeric(14,2) check (price is null or price >= 0),
  starts_on    date,
  ends_on      date,
  sort_order   integer not null default 0,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);
create index if not exists ix_portal_content_property on pms_portal_content (property_id, kind, sort_order);

alter table pms_portal_content enable row level security;
revoke all on pms_portal_content from anon, authenticated;
grant select, insert, update, delete on pms_portal_content to authenticated;
drop policy if exists pms_portal_content_read on pms_portal_content;
create policy pms_portal_content_read on pms_portal_content for select using (property_id in (select pms_my_properties()));
drop policy if exists pms_portal_content_write on pms_portal_content;
create policy pms_portal_content_write on pms_portal_content for all
  using (property_id in (select pms_my_properties(array['owner','manager'])))
  with check (property_id in (select pms_my_properties(array['owner','manager'])));

-- An offer a guest is interested in arrives as a request like any other
alter table pms_guest_requests drop constraint if exists pms_guest_requests_kind_check;
alter table pms_guest_requests add constraint pms_guest_requests_kind_check
  check (kind in ('food','housekeeping','towels','amenities','maintenance','laundry','taxi','wakeup','late_checkout','other','offer'));

-- The welcome page: the guest, the booking, the hotel's letter, Wi-Fi, the guide, documents and offers
create or replace function pms_portal_welcome(p_session text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare gp pms_guest_portals; s pms_stays; pr pms_properties; cfg jsonb; g pms_guests; r pms_reservations; v_bd date;
begin
  gp := pms__portal_by_session(p_session);
  select * into s from pms_stays where id = gp.stay_id;
  select * into pr from pms_properties where id = gp.property_id;
  select * into r from pms_reservations where id = s.reservation_id;
  select * into g from pms_guests where id = r.guest_id;
  cfg := pms__portal_settings(gp.property_id);
  v_bd := pr.business_date;
  return jsonb_build_object(
    'theme', pms__portal_theme(gp.property_id),
    'property', jsonb_build_object('name', pr.name, 'logo_url', pr.logo_url, 'phone', coalesce(pr.reservation_phone, pr.phone),
      'email', pr.email, 'address', concat_ws(', ', nullif(pr.address, ''), nullif(pr.city, '')), 'website', case when pr.website ~ '^https?://' then pr.website end,
      'check_in_time', pr.check_in_time, 'check_out_time', pr.check_out_time, 'currency', pr.currency),
    'guest', jsonb_build_object('title', g.title, 'first_name', g.first_name, 'last_name', g.last_name),
    'booking', jsonb_build_object('res_no', r.res_no, 'room', (select number from pms_rooms where id = s.room_id),
      'room_type', (select name from pms_room_types where id = s.room_type_id),
      'arrival', s.arrival, 'departure', s.departure, 'nights', s.departure - s.arrival, 'adults', s.adults, 'children', s.children,
      'rate_plan', (select name from pms_rate_plans where id = r.rate_plan_id),
      'meal_plan', (select meal_plan from pms_rate_plans where id = r.rate_plan_id),
      'company', (select name from pms_companies where id = r.company_id),
      'checked_in_at', s.checked_in_at),
    'welcome', jsonb_build_object(
      'title', coalesce(nullif(trim(cfg->>'welcome_title'), ''), 'Karibu, ' || coalesce(g.first_name, 'guest') || '!'),
      'text', nullif(trim(coalesce(cfg->>'welcome_text', '')), ''),
      'signed', nullif(trim(coalesce(cfg->>'welcome_signed', '')), ''),
      'wifi_name', nullif(trim(coalesce(cfg->>'wifi_name', '')), ''),
      'wifi_password', nullif(trim(coalesce(cfg->>'wifi_password', '')), '')),
    'guide', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'body', c.body, 'image_url', c.image_url, 'file_url', c.file_url, 'link_url', c.link_url)
              order by c.sort_order, c.title), '[]') from pms_portal_content c where c.property_id = gp.property_id and c.kind = 'guide' and c.active),
    'documents', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'body', c.body, 'file_url', c.file_url)
              order by c.sort_order, c.title), '[]') from pms_portal_content c where c.property_id = gp.property_id and c.kind = 'document' and c.active and c.file_url is not null),
    'offers', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'body', c.body, 'image_url', c.image_url, 'link_url', c.link_url,
              'price', c.price, 'ends_on', c.ends_on, 'asked', exists (select 1 from pms_guest_requests q where q.stay_id = s.id and q.kind = 'offer'
                and q.items @> jsonb_build_array(jsonb_build_object('offer_id', c.id)) and q.status in ('new','accepted','done')))
              order by c.sort_order, c.title), '[]')
              from pms_portal_content c where c.property_id = gp.property_id and c.kind = 'offer' and c.active
                and (c.starts_on is null or c.starts_on <= v_bd) and (c.ends_on is null or c.ends_on >= v_bd)));
end $$;

-- "I'm interested" on an offer
create or replace function pms_portal_offer(p_session text, p_offer uuid, p_details text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare gp pms_guest_portals; c pms_portal_content; v_id uuid; v_bd date;
begin
  gp := pms__portal_by_session(p_session);
  select business_date into v_bd from pms_properties where id = gp.property_id;
  select * into c from pms_portal_content where id = p_offer and property_id = gp.property_id and kind = 'offer' and active
    and (starts_on is null or starts_on <= v_bd) and (ends_on is null or ends_on >= v_bd);
  if not found then raise exception 'This offer has ended'; end if;
  if exists (select 1 from pms_guest_requests where stay_id = gp.stay_id and kind = 'offer' and status in ('new','accepted')
             and items @> jsonb_build_array(jsonb_build_object('offer_id', c.id))) then
    raise exception 'The team already has your interest in this offer';
  end if;
  if (select count(*) from pms_guest_requests where stay_id = gp.stay_id and status in ('new','accepted')) >= 10 then
    raise exception 'You have 10 requests waiting. Please wait for the team, or call reception.';
  end if;
  insert into pms_guest_requests(property_id, stay_id, portal_id, kind, title, details, items, total, created_by)
  values (gp.property_id, gp.stay_id, gp.id, 'offer', left('Offer: ' || c.title, 120), nullif(left(trim(coalesce(p_details, '')), 500), ''),
          jsonb_build_array(jsonb_build_object('offer_id', c.id, 'name', c.title, 'qty', 1, 'price', coalesce(c.price, 0))), 0, null)
  returning id into v_id;
  perform pms_log(gp.property_id, 'portal.request', 'stay', gp.stay_id, jsonb_build_object('request', v_id, 'kind', 'offer', 'offer', c.title));
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- The portal's look: platform administrators only
-- ---------------------------------------------------------------------
create table if not exists pms_portal_themes (
  property_id      uuid primary key references pms_properties(id) on delete cascade,
  preset           text not null default 'bmg' check (preset in ('bmg','ocean','safari','forest','sunset','midnight','custom')),
  primary_color    text check (primary_color is null or primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  accent_color     text check (accent_color is null or accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  background_color text check (background_color is null or background_color ~ '^#[0-9A-Fa-f]{6}$'),
  heading_font     text not null default 'rounded' check (heading_font in ('rounded','modern','classic')),
  tagline          text check (tagline is null or length(tagline) <= 120),
  hero_images      jsonb not null default '[]'::jsonb check (jsonb_typeof(hero_images) = 'array' and jsonb_array_length(hero_images) <= 8),
  updated_at       timestamptz,
  updated_by       uuid
);
alter table pms_portal_themes enable row level security;
revoke all on pms_portal_themes from anon, authenticated;
grant select on pms_portal_themes to authenticated;
drop policy if exists pms_portal_themes_read on pms_portal_themes;
create policy pms_portal_themes_read on pms_portal_themes for select using (property_id in (select pms_my_properties()) or pms_is_super_admin());

-- The theme with its colours filled in from the preset
create or replace function pms__portal_theme(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t pms_portal_themes; v_p text; v_a text; v_b text;
begin
  select * into t from pms_portal_themes where property_id = p_property;
  select x.p, x.a, x.b into v_p, v_a, v_b from (values
    ('bmg', '#1B2A5E', '#F5821F', '#F2F4F8'), ('ocean', '#0B4F6C', '#1FA2D8', '#EDF6FA'), ('safari', '#5A3E1B', '#D99A2B', '#F7F1E6'),
    ('forest', '#1F4D3A', '#7CB342', '#EFF5F0'), ('sunset', '#7A1F3D', '#FF7A45', '#FBF0EE'), ('midnight', '#111827', '#C9A227', '#F5F4F0')) x(k, p, a, b)
  where x.k = coalesce(nullif(t.preset, 'custom'), 'bmg');
  return jsonb_build_object('preset', coalesce(t.preset, 'bmg'),
    'primary', coalesce(t.primary_color, v_p), 'accent', coalesce(t.accent_color, v_a), 'background', coalesce(t.background_color, v_b),
    'heading_font', coalesce(t.heading_font, 'rounded'), 'tagline', t.tagline,
    -- the slideshow: the portal photos first, then the hotel's own gallery
    'photos', coalesce(t.hero_images, '[]'::jsonb) || coalesce((select jsonb_agg(jsonb_build_object('url', ph.url, 'caption', ph.caption) order by ph.sort_order)
                 from pms_property_photos ph where ph.property_id = p_property and ph.room_type_id is null and ph.url ~ '^https://'), '[]'::jsonb));
end $$;

create or replace function pms_admin_portal_theme(p_property uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform pms__require_admin();
  return pms__portal_theme(p_property) || jsonb_build_object('hero_images', coalesce((select hero_images from pms_portal_themes where property_id = p_property), '[]'::jsonb),
    'custom', exists (select 1 from pms_portal_themes where property_id = p_property and preset = 'custom'));
end $$;

create or replace function pms_admin_save_portal_theme(p_property uuid, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_imgs jsonb := coalesce(p->'hero_images', '[]'::jsonb); x jsonb;
begin
  perform pms__require_admin();
  if not exists (select 1 from pms_properties where id = p_property) then raise exception 'Property not found'; end if;
  if jsonb_typeof(v_imgs) <> 'array' then raise exception 'Photos must be a list'; end if;
  if jsonb_array_length(v_imgs) > 8 then raise exception 'At most 8 portal photos'; end if;
  for x in select * from jsonb_array_elements(v_imgs) loop
    if coalesce(x->>'url', '') !~ '^https://[^\s<>"]+$' then raise exception 'Photos must be https addresses'; end if;
    if length(coalesce(x->>'caption', '')) > 120 then raise exception 'Photo captions are at most 120 characters'; end if;
  end loop;
  insert into pms_portal_themes(property_id, preset, primary_color, accent_color, background_color, heading_font, tagline, hero_images, updated_at, updated_by)
  values (p_property, coalesce(nullif(p->>'preset', ''), 'bmg'),
    case when p->>'preset' = 'custom' then nullif(p->>'primary', '') end, case when p->>'preset' = 'custom' then nullif(p->>'accent', '') end,
    case when p->>'preset' = 'custom' then nullif(p->>'background', '') end,
    coalesce(nullif(p->>'heading_font', ''), 'rounded'), nullif(left(trim(coalesce(p->>'tagline', '')), 120), ''),
    (select coalesce(jsonb_agg(jsonb_build_object('url', e->>'url', 'caption', nullif(trim(coalesce(e->>'caption', '')), ''))), '[]') from jsonb_array_elements(v_imgs) e),
    now(), auth.uid())
  on conflict (property_id) do update set preset = excluded.preset, primary_color = excluded.primary_color, accent_color = excluded.accent_color,
    background_color = excluded.background_color, heading_font = excluded.heading_font, tagline = excluded.tagline,
    hero_images = excluded.hero_images, updated_at = now(), updated_by = auth.uid();
  perform pms_log(p_property, 'portal.theme', 'property', p_property, jsonb_build_object('preset', p->>'preset', 'photos', jsonb_array_length(v_imgs)));
end $$;

-- The sign-in page is branded too
create or replace function pms_portal_open(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p pms_guest_portals; pr pms_properties; g text;
begin
  p := pms__portal_by_token(p_token);
  select * into pr from pms_properties where id = p.property_id;
  select gg.first_name into g from pms_stays s join pms_reservations r on r.id = s.reservation_id join pms_guests gg on gg.id = r.guest_id where s.id = p.stay_id;
  return jsonb_build_object('property', pr.name, 'logo_url', pr.logo_url, 'phone', coalesce(pr.reservation_phone, pr.phone), 'guest', g,
    'by_sms', p.phone is not null and pms__integration_on(p.property_id, 'sms'), 'by_email', p.email is not null,
    'phone_hint', pms__mask_phone(p.phone), 'email_hint', pms__mask_email(p.email), 'theme', pms__portal_theme(p.property_id));
end $$;

-- Platform administrators may put portal photos into any hotel's media folder
do $$
begin
  if to_regclass('storage.objects') is null then return; end if;
  execute 'drop policy if exists pms_media_admin_write on storage.objects';
  execute $p$create policy pms_media_admin_write on storage.objects for insert to authenticated
    with check (bucket_id = 'property-media' and pms_is_super_admin())$p$;
  execute 'drop policy if exists pms_media_admin_delete on storage.objects';
  execute $p$create policy pms_media_admin_delete on storage.objects for delete to authenticated
    using (bucket_id = 'property-media' and pms_is_super_admin())$p$;
end $$;

revoke execute on function pms__portal_theme(uuid) from public, anon, authenticated;
revoke execute on function pms_admin_portal_theme(uuid), pms_admin_save_portal_theme(uuid, jsonb) from public, anon;
grant execute on function pms_admin_portal_theme(uuid), pms_admin_save_portal_theme(uuid, jsonb) to authenticated;
revoke execute on function pms_portal_open(text) from public;
grant execute on function pms_portal_open(text) to anon, authenticated;

revoke execute on function pms_portal_welcome(text), pms_portal_offer(text, uuid, text) from public;
grant execute on function pms_portal_welcome(text), pms_portal_offer(text, uuid, text) to anon, authenticated;
do $$ begin execute 'grant execute on all functions in schema public to service_role'; exception when undefined_object then null; end $$;

select pms__apply_platform_rules();
notify pgrst, 'reload schema';
