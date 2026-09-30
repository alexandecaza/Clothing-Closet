-- =============================================================================
-- Clothing Closet — database schema, security rules, and storage policies
--
-- Run this whole file once in Supabase: Dashboard → SQL Editor → New query →
-- paste → Run. It is safe to re-run later (e.g. after pulling an update).
--
-- Security model
--   anon (the public, no login):
--     • read items (every column EXCEPT internal notes) and the settings row
--     • create requests ONLY through submit_request(), which checks a
--       Cloudflare Turnstile robot-check token, rate limits, the item list,
--       the per-request cap, and stock — all server-side
--     • look up the status (only the status) of a request by reference code
--     • cannot read requests, contact info, or write anything else
--   authenticated users listed in public.admins who passed two-step sign-in
--   (password + authenticator-app code, session "aal2"):
--     • full read/write on items, requests, settings, and item photos
--   everyone else signed in (not in public.admins, or password only):
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

-- True while an approved request is holding its items out of stock for pickup.
-- (Requests approved before this existed are false: stock comes off at pickup.)
alter table public.requests
  add column if not exists stock_reserved boolean not null default false;

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
--
-- Coordinators must use two-step sign-in: a password AND a 6-digit code from
-- an authenticator app (Supabase MFA). Supabase marks a session that passed
-- both as "aal2". A session that only used the password is "aal1" and gets
-- nothing beyond what the public gets, so a stolen or guessed password alone
-- can't open the admin, even by calling the API directly.
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
  )
  and coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2';
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- Is this account listed as a coordinator, whether or not it has finished
-- two-step sign-in yet? Used only by the sign-in screen to decide whether to
-- ask for a code. It grants no access by itself.
create or replace function public.is_admin_account()
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

revoke all on function public.is_admin_account() from public;
revoke all on function public.is_admin_account() from anon;
grant execute on function public.is_admin_account() to authenticated;


-- ---------------------------------------------------------------------------
-- Request status rules
--   pending  → approved (items set aside: stock goes down) | denied
--   approved → fulfilled (picked up) | pending or denied (items go back)
--   denied   → pending (reopen)
--   fulfilled is final
-- Every status change goes through change_request_status(), which moves stock
-- in the same transaction. Direct updates to status are refused.
-- ---------------------------------------------------------------------------

create or replace function public.guard_request_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.status is distinct from old.status
      or new.stock_reserved is distinct from old.stock_reserved)
     and coalesce(current_setting('closet.status_change', true), '') <> 'on' then
    raise exception 'Use the buttons in the admin to change a request''s status, so stock stays correct.';
  end if;

  if new.status is distinct from old.status then
    if old.status = 'fulfilled' then
      raise exception 'This request was already picked up and can''t be changed.';
    end if;

    if not (
         (old.status = 'pending'  and new.status in ('approved', 'denied'))
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

-- Deleting a request that's holding items would lose them from stock for good.
create or replace function public.guard_request_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'approved' and old.stock_reserved then
    raise exception 'This request is holding items for pickup. Deny it or move it back to pending first so they go back into stock.';
  end if;
  return old;
end;
$$;

drop trigger if exists requests_guard_delete on public.requests;
create trigger requests_guard_delete before delete on public.requests
  for each row execute function public.guard_request_delete();


-- ---------------------------------------------------------------------------
-- Bot protection
--   • Cloudflare Turnstile: every request submission must carry a token that
--     the database verifies with Cloudflare (secret stored in Supabase Vault
--     as 'turnstile_secret' — README step 9). Until that secret exists,
--     verification is skipped and the admin Settings page warns about it.
--   • Per-IP rate limits on submitting and on status lookups.
--   • A closet-wide ceiling on new requests per hour.
--   • Per-contact limit (3 per day) inside private.create_request().
-- Helpers live in the "private" schema, which the public API can't reach.
-- ---------------------------------------------------------------------------

create extension if not exists http with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
revoke all on schema private from anon, authenticated;

create table if not exists private.rate_events (
  id         bigint generated always as identity primary key,
  kind       text not null,
  ip_hash    text not null,
  created_at timestamptz not null default now()
);

create index if not exists rate_events_lookup_idx
  on private.rate_events (kind, ip_hash, created_at);

-- RLS on with no policies: nobody but the table owner (the functions below)
-- can touch it, even if the schema were ever exposed by mistake.
alter table private.rate_events enable row level security;

-- The visitor's IP as reported by Supabase's edge (null if unavailable).
create or replace function private.client_ip()
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(btrim(coalesce(
    nullif(current_setting('request.headers', true), '')::json ->> 'cf-connecting-ip',
    split_part(nullif(current_setting('request.headers', true), '')::json ->> 'x-forwarded-for', ',', 1)
  )), '');
$$;

-- Records one attempt of `p_kind` for this IP and says whether the IP is over
-- the limit. Only a pseudonymous hash is stored, and only for a day.
create or replace function private.hit_rate_limit(p_kind text, p_max int, p_window interval)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_ip   text := private.client_ip();
  v_hash text;
begin
  if v_ip is null then
    return false; -- no IP to go on; other limits still apply
  end if;
  v_hash := md5('clothing-closet:' || v_ip);

  delete from private.rate_events where created_at < now() - interval '1 day';

  if (select count(*) from private.rate_events
       where kind = p_kind and ip_hash = v_hash
         and created_at > now() - p_window) >= p_max then
    return true;
  end if;

  insert into private.rate_events (kind, ip_hash) values (p_kind, v_hash);
  return false;
end;
$$;

create or replace function private.turnstile_secret()
returns text
language sql
stable
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'turnstile_secret' limit 1;
$$;

-- Raises a friendly error unless Cloudflare confirms the token.
create or replace function private.verify_turnstile(p_token text, p_action text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_secret text := private.turnstile_secret();
  v_resp   extensions.http_response;
  v_body   jsonb;
begin
  if v_secret is null then
    return; -- not configured yet (admin Settings shows a warning)
  end if;

  if coalesce(p_token, '') = '' then
    raise exception 'Please complete the “I''m not a robot” check, then send again.';
  end if;

  begin
    v_resp := extensions.http_post(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      jsonb_strip_nulls(jsonb_build_object(
        'secret',   v_secret,
        'response', p_token,
        'remoteip', private.client_ip()
      ))::text,
      'application/json'
    );
    v_body := v_resp.content::jsonb;
  exception when others then
    raise exception 'We couldn''t run the robot check just now. Please try again in a moment.';
  end;

  if v_resp.status <> 200
     or coalesce((v_body ->> 'success')::boolean, false) is not true
     or (p_action is not null and v_body ->> 'action' is distinct from p_action) then
    raise exception 'The robot check didn''t go through. Please try again.';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- Public: submit a request (the ONLY way a request row gets created)
-- ---------------------------------------------------------------------------

-- Older versions of this file exposed a 4-argument submit_request directly.
drop function if exists public.submit_request(text, text, text, jsonb);

-- Validates and inserts; raises a readable error on any problem.
create or replace function private.create_request(
  p_family_name text,
  p_contact     text,
  p_note        text,
  p_items       jsonb
)
returns text
language plpgsql
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

-- The public entry point. Returns { ok: true, ref } or { ok: false, error }
-- instead of raising, so rate-limit bookkeeping for failed attempts (e.g. a
-- bot failing the robot check) is kept rather than rolled back.
create or replace function public.submit_request(
  p_family_name   text,
  p_contact       text,
  p_note          text,
  p_items         jsonb,
  p_captcha_token text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Tune these to your closet.
  c_per_ip_per_hour  constant int := 5;   -- attempts from one connection
  c_closet_per_hour  constant int := 40;  -- successful requests, everyone combined
  v_ref text;
begin
  if private.hit_rate_limit('submit', c_per_ip_per_hour, interval '1 hour') then
    return jsonb_build_object('ok', false, 'error',
      'Too many tries from your connection. Please wait an hour and try again.');
  end if;

  if (select count(*) from public.requests
       where created_at > now() - interval '1 hour') >= c_closet_per_hour then
    return jsonb_build_object('ok', false, 'error',
      'The closet is getting an unusual number of requests right now. Please try again later today.');
  end if;

  begin
    perform private.verify_turnstile(p_captcha_token, 'submit-request');
    v_ref := private.create_request(p_family_name, p_contact, p_note, p_items);
  exception
    when raise_exception then
      return jsonb_build_object('ok', false, 'error', sqlerrm);
    when others then
      return jsonb_build_object('ok', false, 'error',
        'Something went wrong sending your request. Please try again.');
  end;

  return jsonb_build_object('ok', true, 'ref', v_ref);
end;
$$;

revoke all on function public.submit_request(text, text, text, jsonb, text) from public;
grant execute on function public.submit_request(text, text, text, jsonb, text) to anon, authenticated;


-- ---------------------------------------------------------------------------
-- Public: look up ONLY the status of a request by its reference code
-- (rate-limited per IP so codes can't be guessed in bulk)
-- ---------------------------------------------------------------------------

drop function if exists public.request_status(text);

create function public.request_status(p_ref text)
returns table (status text, created_at timestamptz, updated_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if private.hit_rate_limit('status', 20, interval '1 hour') then
    raise exception 'Too many lookups from your connection. Please try again later.';
  end if;

  return query
    select r.status, r.created_at, r.updated_at
      from public.requests r
     where r.ref_code = upper(regexp_replace(coalesce(p_ref, ''), '[^A-Za-z0-9]', '', 'g'));
end;
$$;

revoke all on function public.request_status(text) from public;
grant execute on function public.request_status(text) to anon, authenticated;


-- ---------------------------------------------------------------------------
-- Admin: change a request's status — the only place stock moves for requests
--   approve              → items come OUT of stock right away (set aside), so
--                          no other family can request them. Refused if
--                          there isn't enough stock.
--   approved → pending / denied → the set-aside items go back INTO stock
--   approved → fulfilled (picked up) → no change; they're already out
-- ---------------------------------------------------------------------------

drop function if exists public.fulfill_request(uuid);

create or replace function public.change_request_status(p_id uuid, p_status text)
returns public.requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_req   public.requests%rowtype;
  v_line  jsonb;
  v_item  public.items%rowtype;
  v_short text := '';
begin
  if not public.is_admin() then
    raise exception 'Not authorized.' using errcode = '42501';
  end if;

  select * into v_req from public.requests where id = p_id for update;
  if not found then
    raise exception 'Request not found.';
  end if;
  if v_req.status = p_status then
    return v_req;
  end if;

  if p_status = 'approved' then
    if v_req.status <> 'pending' then
      raise exception 'Only pending requests can be approved.';
    end if;

    -- Lock the items (in a fixed order) and make sure everything is there.
    for v_line in
      select value from jsonb_array_elements(v_req.items) order by value ->> 'itemId'
    loop
      select * into v_item from public.items
       where id = (v_line ->> 'itemId')::uuid
         for update;
      if not found then
        v_short := v_short || format('%s (size %s) is no longer in inventory. ',
                                     v_line ->> 'name', v_line ->> 'size');
      elsif v_item.quantity < (v_line ->> 'qty')::int then
        v_short := v_short || format('%s (size %s): wants %s, only %s in stock. ',
                                     v_item.name, v_item.size, v_line ->> 'qty', v_item.quantity);
      end if;
    end loop;

    if v_short <> '' then
      raise exception 'Not enough stock to approve. %', btrim(v_short);
    end if;

    for v_line in select value from jsonb_array_elements(v_req.items) loop
      update public.items
         set quantity = quantity - (v_line ->> 'qty')::int
       where id = (v_line ->> 'itemId')::uuid;
    end loop;

    perform set_config('closet.status_change', 'on', true);
    update public.requests set status = 'approved', stock_reserved = true
     where id = p_id returning * into v_req;
    perform set_config('closet.status_change', '', true);
    return v_req;
  end if;

  if v_req.status = 'approved' and p_status in ('pending', 'denied') then
    if v_req.stock_reserved then
      for v_line in select value from jsonb_array_elements(v_req.items) loop
        -- Items deleted in the meantime are skipped.
        update public.items
           set quantity = quantity + (v_line ->> 'qty')::int
         where id = (v_line ->> 'itemId')::uuid;
      end loop;
    end if;

    perform set_config('closet.status_change', 'on', true);
    update public.requests set status = p_status, stock_reserved = false
     where id = p_id returning * into v_req;
    perform set_config('closet.status_change', '', true);
    return v_req;
  end if;

  if p_status = 'fulfilled' then
    if v_req.status <> 'approved' then
      raise exception 'Approve the request before marking it picked up.';
    end if;

    -- Approved before items were set aside at approval: take them out now.
    if not v_req.stock_reserved then
      for v_line in select value from jsonb_array_elements(v_req.items) loop
        update public.items
           set quantity = greatest(quantity - (v_line ->> 'qty')::int, 0)
         where id = (v_line ->> 'itemId')::uuid;
      end loop;
    end if;

    perform set_config('closet.status_change', 'on', true);
    update public.requests set status = 'fulfilled', stock_reserved = false
     where id = p_id returning * into v_req;
    perform set_config('closet.status_change', '', true);
    return v_req;
  end if;

  -- pending → denied, denied → pending: no stock involved.
  -- (The status trigger rejects any other transition.)
  perform set_config('closet.status_change', 'on', true);
  update public.requests set status = p_status where id = p_id returning * into v_req;
  perform set_config('closet.status_change', '', true);
  return v_req;
end;
$$;

revoke all on function public.change_request_status(uuid, text) from public;
revoke all on function public.change_request_status(uuid, text) from anon;
grant execute on function public.change_request_status(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- Admin: is bot protection fully set up? (shown on the Settings page)
-- ---------------------------------------------------------------------------

create or replace function public.bot_protection_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'Not authorized.' using errcode = '42501';
  end if;
  return jsonb_build_object('turnstile_secret', private.turnstile_secret() is not null);
end;
$$;

revoke all on function public.bot_protection_status() from public;
revoke all on function public.bot_protection_status() from anon;
grant execute on function public.bot_protection_status() to authenticated;

-- Nothing in the private schema is callable from the API.
revoke all on all functions in schema private from public;
revoke all on all functions in schema private from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated;


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
