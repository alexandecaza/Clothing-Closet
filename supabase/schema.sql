-- =============================================================================
-- Clothing Closet — database schema, security rules, and storage policies
--
-- Run this whole file once in Supabase: Dashboard → SQL Editor → New query →
-- paste → Run. It is safe to re-run later (e.g. after pulling an update).
--
-- Security model
--   anon (the public, no login):
--     • read items (every column EXCEPT internal notes) and the settings row
--     • create requests ONLY through submit_request(), which validates the
--       item list, the per-request cap, and stock server-side
--     • look up the status (only the status) of a request by reference code
--     • cannot read requests, contact info, or write anything else
--   authenticated users listed in public.admins:
--     • full read/write on items, requests, settings, and item photos
--   authenticated users NOT in public.admins:
--     • nothing beyond what anon can do (sign-ups should also be disabled)
-- =============================================================================


-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Who counts as a coordinator. Managed by hand in the SQL editor (see README).
create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Single-row settings table (id is always 1).
create table if not exists public.settings (
  id                    int primary key default 1 check (id = 1),
  org_name              text not null default 'Clothing Closet'
                        check (char_length(btrim(org_name)) between 1 and 80),
  max_items_per_request int  not null default 5
                        check (max_items_per_request between 1 and 100),
  updated_at            timestamptz not null default now()
);

insert into public.settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  category    text not null check (char_length(category) between 1 and 60),
  size        text not null check (char_length(size) between 1 and 30),
  gender      text not null check (gender in ('Boys', 'Girls', 'Unisex')),
  condition   text not null check (char_length(condition) between 1 and 40),
  quantity    int  not null default 0 check (quantity >= 0),
  notes       text not null default '' check (char_length(notes) <= 2000),
  photo_path  text,
  thumb_path  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.requests (
  id          uuid primary key default gen_random_uuid(),
  ref_code    text not null unique,
  family_name text not null,
  contact     text not null,
  note        text not null default '',
  -- Snapshot at submit time: [{ itemId, name, size, qty }]
  items       jsonb not null,
  total_qty   int  not null,
  status      text not null default 'pending'
              check (status in ('pending', 'approved', 'fulfilled', 'denied')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists requests_status_created_idx
  on public.requests (status, created_at desc);
create index if not exists requests_contact_created_idx
  on public.requests (lower(contact), created_at);


-- ---------------------------------------------------------------------------
-- updated_at bookkeeping
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists items_touch on public.items;
create trigger items_touch before update on public.items
  for each row execute function public.touch_updated_at();

drop trigger if exists settings_touch on public.settings;
create trigger settings_touch before update on public.settings
  for each row execute function public.touch_updated_at();

drop trigger if exists requests_touch on public.requests;
create trigger requests_touch before update on public.requests
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- Helper: is the current user a coordinator?
-- ---------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admins where user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;


-- ---------------------------------------------------------------------------
-- Request status rules
--   pending  → approved | denied
--   approved → pending (undo) | denied
--   denied   → pending (reopen)
--   anything → fulfilled ONLY via fulfill_request(), which adjusts stock
--   fulfilled is final (prevents decrementing stock twice)
-- ---------------------------------------------------------------------------

create or replace function public.guard_request_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if old.status = 'fulfilled' then
      raise exception 'This request was already picked up and can''t be changed.';
    end if;

    if new.status = 'fulfilled'
       and coalesce(current_setting('closet.fulfilling', true), '') <> 'on' then
      raise exception 'Use "Mark picked up" to fulfill a request so stock is updated.';
    end if;

    if not (
         (old.status = 'pending'  and new.status in ('approved', 'denied', 'fulfilled'))
      or (old.status = 'approved' and new.status in ('pending', 'denied', 'fulfilled'))
      or (old.status = 'denied'   and new.status = 'pending')
    ) then
      raise exception 'A request can''t go from % to %.', old.status, new.status;
    end if;
  end if;

  -- The family's submission itself is read-only; only status changes.
  if new.items is distinct from old.items
     or new.total_qty is distinct from old.total_qty
     or new.ref_code is distinct from old.ref_code then
    raise exception 'Request contents can''t be edited.';
  end if;

  return new;
end;
$$;

drop trigger if exists requests_guard_status on public.requests;
create trigger requests_guard_status before update on public.requests
  for each row execute function public.guard_request_status();


-- ---------------------------------------------------------------------------
-- Public: submit a request (the ONLY way a request row gets created)
-- ---------------------------------------------------------------------------

create or replace function public.submit_request(
  p_family_name text,
  p_contact     text,
  p_note        text,
  p_items       jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name     text := btrim(coalesce(p_family_name, ''));
  v_contact  text := btrim(coalesce(p_contact, ''));
  v_note     text := btrim(coalesce(p_note, ''));
  v_digits   text;
  v_max      int;
  v_total    int := 0;
  v_snapshot jsonb := '[]'::jsonb;
  v_ref      text;
  v_attempt  int := 0;
  v_line     record;
  v_item     public.items%rowtype;
begin
  -- Who's asking
  if char_length(v_name) < 1 or char_length(v_name) > 100 then
    raise exception 'Please enter your name (up to 100 characters).';
  end if;

  v_digits := regexp_replace(v_contact, '\D', '', 'g');
  if char_length(v_contact) > 200
     or not (v_contact ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
             or char_length(v_digits) between 7 and 15) then
    raise exception 'Please enter a phone number or email address we can reach you at.';
  end if;

  if char_length(v_note) > 1000 then
    raise exception 'Please keep the note under 1000 characters.';
  end if;

  -- Light abuse protection: a handful of requests per contact per day.
  if (select count(*) from public.requests
       where lower(contact) = lower(v_contact)
         and created_at > now() - interval '1 day') >= 3 then
    raise exception 'We already have several requests from this contact today. The coordinator will be in touch.';
  end if;

  -- What they're asking for
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'Your request list is empty.';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'That request list is too long.';
  end if;

  select max_items_per_request into v_max from public.settings where id = 1;

  begin
    for v_line in
      select (e ->> 'item_id')::uuid as item_id,
             sum((e ->> 'qty')::int)  as qty
        from jsonb_array_elements(p_items) as e
       group by 1
    loop
      if v_line.item_id is null or v_line.qty is null or v_line.qty < 1 then
        raise exception 'Each item needs a quantity of at least 1.';
      end if;

      select * into v_item from public.items where id = v_line.item_id;
      if not found then
        raise exception 'One of the items on your list is no longer available. Please refresh and try again.';
      end if;
      if v_line.qty > v_item.quantity then
        raise exception '"%" only has % available right now. Please adjust your list.',
          v_item.name, v_item.quantity;
      end if;

      v_total := v_total + v_line.qty;
      v_snapshot := v_snapshot || jsonb_build_array(jsonb_build_object(
        'itemId', v_item.id,
        'name',   v_item.name,
        'size',   v_item.size,
        'qty',    v_line.qty
      ));
    end loop;
  exception
    when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'That request list couldn''t be read. Please refresh and try again.';
  end;

  if v_total > v_max then
    raise exception 'Requests are limited to % items at a time.', v_max;
  end if;

  -- Short, unambiguous reference code (no 0/O, 1/I/L)
  loop
    v_attempt := v_attempt + 1;
    select string_agg(
             substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', (floor(random() * 31) + 1)::int, 1),
             '')
      into v_ref
      from generate_series(1, 6);

    begin
      insert into public.requests (ref_code, family_name, contact, note, items, total_qty)
      values (v_ref, v_name, v_contact, v_note, v_snapshot, v_total);
      exit;
    exception when unique_violation then
      if v_attempt >= 10 then
        raise exception 'Could not create a reference code. Please try again.';
      end if;
    end;
  end loop;

  return v_ref;
end;
$$;

revoke all on function public.submit_request(text, text, text, jsonb) from public;
grant execute on function public.submit_request(text, text, text, jsonb) to anon, authenticated;


-- ---------------------------------------------------------------------------
-- Public: look up ONLY the status of a request by its reference code
-- ---------------------------------------------------------------------------

create or replace function public.request_status(p_ref text)
returns table (status text, created_at timestamptz, updated_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select r.status, r.created_at, r.updated_at
    from public.requests r
   where r.ref_code = upper(regexp_replace(coalesce(p_ref, ''), '[^A-Za-z0-9]', '', 'g'));
$$;

revoke all on function public.request_status(text) from public;
grant execute on function public.request_status(text) to anon, authenticated;


-- ---------------------------------------------------------------------------
-- Admin: mark a request picked up — the one place stock is decremented
-- ---------------------------------------------------------------------------

create or replace function public.fulfill_request(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req  public.requests%rowtype;
  v_line jsonb;
begin
  if not public.is_admin() then
    raise exception 'Not authorized.' using errcode = '42501';
  end if;

  select * into v_req from public.requests where id = p_id for update;
  if not found then
    raise exception 'Request not found.';
  end if;
  if v_req.status not in ('pending', 'approved') then
    raise exception 'This request is already %.', v_req.status;
  end if;

  for v_line in select * from jsonb_array_elements(v_req.items) loop
    -- Items deleted since the request was made are simply skipped.
    update public.items
       set quantity = greatest(quantity - (v_line ->> 'qty')::int, 0)
     where id = (v_line ->> 'itemId')::uuid;
  end loop;

  perform set_config('closet.fulfilling', 'on', true);
  update public.requests set status = 'fulfilled' where id = p_id;
  perform set_config('closet.fulfilling', '', true);
end;
$$;

revoke all on function public.fulfill_request(uuid) from public;
revoke all on function public.fulfill_request(uuid) from anon;
grant execute on function public.fulfill_request(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.admins   enable row level security;
alter table public.settings enable row level security;
alter table public.items    enable row level security;
alter table public.requests enable row level security;

-- admins: a signed-in user may see only their own row (used to confirm access)
drop policy if exists "admins: read own row" on public.admins;
create policy "admins: read own row" on public.admins
  for select to authenticated
  using (user_id = (select auth.uid()));

-- settings: everyone reads; coordinators update
drop policy if exists "settings: anyone reads" on public.settings;
create policy "settings: anyone reads" on public.settings
  for select to anon, authenticated
  using (true);

drop policy if exists "settings: admins update" on public.settings;
create policy "settings: admins update" on public.settings
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- items: the public reads (minus notes — see column grants below);
-- coordinators do everything
drop policy if exists "items: public reads" on public.items;
create policy "items: public reads" on public.items
  for select to anon
  using (true);

drop policy if exists "items: admins read" on public.items;
create policy "items: admins read" on public.items
  for select to authenticated
  using (public.is_admin());

drop policy if exists "items: admins insert" on public.items;
create policy "items: admins insert" on public.items
  for insert to authenticated
  with check (public.is_admin());

drop policy if exists "items: admins update" on public.items;
create policy "items: admins update" on public.items
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "items: admins delete" on public.items;
create policy "items: admins delete" on public.items
  for delete to authenticated
  using (public.is_admin());

-- requests: coordinators only (families create them via submit_request)
drop policy if exists "requests: admins read" on public.requests;
create policy "requests: admins read" on public.requests
  for select to authenticated
  using (public.is_admin());

drop policy if exists "requests: admins update" on public.requests;
create policy "requests: admins update" on public.requests
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists "requests: admins delete" on public.requests;
create policy "requests: admins delete" on public.requests
  for delete to authenticated
  using (public.is_admin());


-- ---------------------------------------------------------------------------
-- Table privileges (defense in depth on top of RLS)
-- Grants are explicit so this works whether or not the project exposes new
-- tables to the API automatically; RLS policies above still apply on top.
-- ---------------------------------------------------------------------------

grant usage on schema public to anon, authenticated;

grant select on public.admins to authenticated;
grant select on public.settings to anon, authenticated;
grant update on public.settings to authenticated;
grant select, insert, update, delete on public.items to authenticated;
grant select, update, delete on public.requests to authenticated;

revoke all on public.admins from anon;
revoke insert, update, delete, truncate on public.admins from authenticated;

revoke insert, update, delete, truncate on public.settings from anon;
revoke insert, delete, truncate on public.settings from authenticated;

-- The public may read every item column except the internal notes.
revoke all on public.items from anon;
grant select (id, name, category, size, gender, condition, quantity,
              photo_path, thumb_path, created_at, updated_at)
  on public.items to anon;

revoke all on public.requests from anon;
revoke insert, truncate on public.requests from authenticated;


-- ---------------------------------------------------------------------------
-- Storage: public-read bucket for item photos; only coordinators write
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-photos', 'item-photos', true, 3145728,
        array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "item-photos: admins read" on storage.objects;
create policy "item-photos: admins read" on storage.objects
  for select to authenticated
  using (bucket_id = 'item-photos' and public.is_admin());

drop policy if exists "item-photos: admins upload" on storage.objects;
create policy "item-photos: admins upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'item-photos' and public.is_admin());

drop policy if exists "item-photos: admins update" on storage.objects;
create policy "item-photos: admins update" on storage.objects
  for update to authenticated
  using (bucket_id = 'item-photos' and public.is_admin())
  with check (bucket_id = 'item-photos' and public.is_admin());

drop policy if exists "item-photos: admins delete" on storage.objects;
create policy "item-photos: admins delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'item-photos' and public.is_admin());
