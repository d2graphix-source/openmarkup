-- OpenMarkup database schema. Run the whole file once in the Supabase SQL Editor (or `supabase db push` with it as a migration).
--
-- Who is who:
--   * Members: anyone with a login in this project's Supabase Auth. Every member can see and work on every review.
--     Create logins in Supabase > Authentication > Users > Add user (or allow sign-ups, see README).
--   * Admins: members with profiles.is_admin = true. They can delete any review. Others can delete only reviews they started.
--   * Guests: people with a share link and no login. They never touch the database directly; the app's server checks the
--     link and acts for them on that one review, using the service role key.

create extension if not exists pgcrypto;
create schema if not exists private;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (length(btrim(display_name)) > 0 and length(display_name) <= 80),
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);

-- Every new login gets a profile, named from the part of the email before the @ (members can change it in the app).
create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(coalesce(new.email, 'Member'), '@', 1), 'Member'))
  on conflict (user_id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- Logins made before this file ran get a profile too.
insert into public.profiles (user_id, display_name)
select id, coalesce(nullif(split_part(email, '@', 1), ''), 'Member') from auth.users
on conflict (user_id) do nothing;

create function private.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.user_id = (select auth.uid()));
$$;
create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.user_id = (select auth.uid()) and p.is_admin);
$$;

-- ---------------------------------------------------------------- reviews
create table public.reviews (
  id              uuid primary key default gen_random_uuid(),
  title           text not null check (length(btrim(title)) > 0 and length(title) <= 200),
  -- Origin only (scheme and host, no path): the site that carries the OpenMarkup script.
  site_origin     text not null check (site_origin ~* '^https?://[^/?#\s]+$' and length(site_origin) <= 300),
  alias_hosts     text[] not null default '{}',          -- earlier addresses ("Change address"); their pins still count
  start_path      text not null default '/' check (start_path like '/%' and length(start_path) <= 1000),
  status          text not null default 'open' check (status in ('open', 'completed')),
  comments_paused boolean not null default false,
  created_by      uuid not null references auth.users (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index reviews_created_idx on public.reviews (created_at desc);

-- One pinned comment spot with its conversation. Numbered 1, 2, 3 per review and screen size.
create table public.review_threads (
  id          uuid primary key default gen_random_uuid(),
  review_id   uuid not null references public.reviews (id) on delete cascade,
  page_url    text not null check (page_url ~* '^https?://' and length(page_url) <= 2000),   -- the real page address
  page_key    text not null check (length(page_key) <= 2000),                                -- normalised path and query
  viewport    text not null default 'desktop' check (viewport in ('desktop', 'tablet', 'phone')),
  pin_number  int  not null default 0,
  anchor      jsonb not null check (jsonb_typeof(anchor) = 'object' and pg_column_size(anchor) < 8000),
  author_id   uuid references auth.users (id) on delete set null,
  guest_name  text check (length(guest_name) <= 80),
  resolved_at timestamptz,
  resolved_by uuid references auth.users (id) on delete set null,
  snapshot_path text,                                  -- picture of the screen around the click (storage: review-snapshots)
  created_at  timestamptz not null default now(),
  unique (id, review_id),
  unique (review_id, viewport, pin_number)
);
create index review_threads_page_idx on public.review_threads (review_id, page_key);

create table public.review_comments (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null,
  review_id  uuid not null references public.reviews (id) on delete cascade,
  author_id  uuid references auth.users (id) on delete set null,
  guest_name text check (length(guest_name) <= 80),
  body       text not null check (length(btrim(body)) > 0 and length(body) <= 5000),
  created_at timestamptz not null default now(),
  edited_at  timestamptz,
  attachments text[] not null default '{}',              -- pictures the commenter attached (storage: review-attachments)
  foreign key (thread_id, review_id) references public.review_threads (id, review_id) on delete cascade
);
create index review_comments_thread_idx on public.review_comments (thread_id, created_at);
create index review_comments_review_idx on public.review_comments (review_id);

-- The share link for people with no login. The token is long and random.
create table public.review_share_links (
  review_id   uuid primary key references public.reviews (id) on delete cascade,
  token       text not null unique check (length(token) >= 32),
  enabled     boolean not null default true,
  can_comment boolean not null default true,
  expires_at  timestamptz,
  created_by  uuid not null references auth.users (id),
  created_at  timestamptz not null default now()
);

-- "I've finished reviewing", from a guest or a member.
create table public.review_events (
  id         uuid primary key default gen_random_uuid(),
  review_id  uuid not null references public.reviews (id) on delete cascade,
  kind       text not null check (kind in ('finished')),
  actor_id   uuid references auth.users (id) on delete set null,
  actor_name text check (length(actor_name) <= 80),
  created_at timestamptz not null default now()
);
create index review_events_review_idx on public.review_events (review_id, created_at desc);

-- ---------------------------------------------------------------- row-level security
alter table public.profiles           enable row level security;
alter table public.reviews            enable row level security;
alter table public.review_threads     enable row level security;
alter table public.review_comments    enable row level security;
alter table public.review_share_links enable row level security;
alter table public.review_events      enable row level security;

create policy profiles_select on public.profiles for select to authenticated using (private.is_member());
-- Members may rename themselves. is_admin is not in the column grant below, so nobody can make themselves an admin.
create policy profiles_update on public.profiles for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy reviews_select on public.reviews for select to authenticated using (private.is_member());
create policy reviews_insert on public.reviews for insert to authenticated
  with check (private.is_member() and created_by = (select auth.uid()));
create policy reviews_update on public.reviews for update to authenticated
  using (private.is_member()) with check (private.is_member());

create policy review_threads_select on public.review_threads for select to authenticated using (private.is_member());
create policy review_threads_insert on public.review_threads for insert to authenticated
  with check (private.is_member() and author_id = (select auth.uid()));
create policy review_threads_update on public.review_threads for update to authenticated
  using (private.is_member()) with check (private.is_member());
create policy review_threads_delete on public.review_threads for delete to authenticated
  using (author_id = (select auth.uid()) or private.is_admin());

create policy review_comments_select on public.review_comments for select to authenticated using (private.is_member());
create policy review_comments_insert on public.review_comments for insert to authenticated
  with check (private.is_member() and author_id = (select auth.uid()));
create policy review_comments_update on public.review_comments for update to authenticated
  using (author_id = (select auth.uid())) with check (author_id = (select auth.uid()));
create policy review_comments_delete on public.review_comments for delete to authenticated
  using (author_id = (select auth.uid()) or private.is_admin());

create policy review_share_links_all on public.review_share_links for all to authenticated
  using (private.is_member()) with check (private.is_member() and created_by = (select auth.uid()));

create policy review_events_select on public.review_events for select to authenticated using (private.is_member());
create policy review_events_insert on public.review_events for insert to authenticated
  with check (private.is_member() and actor_id = (select auth.uid()));

-- ---------------------------------------------------------------- rules in the data
create function private.reviews_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.id <> old.id or new.created_by <> old.created_by or new.created_at <> old.created_at) then
    raise exception 'A review''s author cannot change' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger reviews_guard before insert or update on public.reviews
  for each row execute function private.reviews_guard();

create function private.review_threads_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.review_id::text || new.viewport, 0));
  select coalesce(max(pin_number), 0) + 1 into new.pin_number
    from public.review_threads where review_id = new.review_id and viewport = new.viewport;
  new.resolved_at := null; new.resolved_by := null;
  return new;
end $$;
create trigger review_threads_before_insert before insert on public.review_threads
  for each row execute function private.review_threads_before_insert();

-- After it is placed, a thread can only be resolved or reopened. Where it points never moves.
create function private.review_threads_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid());
begin
  if new.id <> old.id or new.review_id <> old.review_id or new.page_url <> old.page_url
     or new.page_key <> old.page_key or new.viewport <> old.viewport or new.pin_number <> old.pin_number
     or new.anchor <> old.anchor or new.author_id is distinct from old.author_id
     or new.guest_name is distinct from old.guest_name or new.created_at <> old.created_at then
    raise exception 'Where a comment points cannot change' using errcode = '42501';
  end if;
  if new.resolved_at is distinct from old.resolved_at then
    new.resolved_by := case when new.resolved_at is null then null else coalesce(uid, new.resolved_by) end;
  end if;
  return new;
end $$;
create trigger review_threads_before_update before update on public.review_threads
  for each row execute function private.review_threads_before_update();

-- Only the words of a comment can change, and everyone can see that they were edited.
create function private.review_comments_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.id <> old.id or new.thread_id <> old.thread_id or new.review_id <> old.review_id
     or new.author_id is distinct from old.author_id or new.guest_name is distinct from old.guest_name
     or new.created_at <> old.created_at then
    raise exception 'Only the words of a comment can change' using errcode = '42501';
  end if;
  new.edited_at := case when new.body is distinct from old.body then now() else old.edited_at end;
  return new;
end $$;
create trigger review_comments_before_update before update on public.review_comments
  for each row execute function private.review_comments_before_update();

-- Deleting a review for good: the person who started it, or an admin. Its comments, link and events go with it.
create function public.delete_review(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.reviews r where r.id = p_id and (r.created_by = (select auth.uid()) or private.is_admin())) then
    raise exception 'Only the person who started a review, or an admin, can delete it' using errcode = '42501';
  end if;
  delete from public.reviews where id = p_id;
end $$;
revoke all on function public.delete_review(uuid) from public;
grant execute on function public.delete_review(uuid) to authenticated;

-- ---------------------------------------------------------------- grants
revoke all on public.profiles, public.reviews, public.review_threads, public.review_comments, public.review_share_links, public.review_events from anon;
grant usage on schema private to authenticated;
grant execute on all functions in schema private to authenticated;
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant select, insert, update on public.reviews to authenticated;
grant select, insert, update, delete on public.review_threads to authenticated;
grant select, insert, delete on public.review_comments to authenticated;
grant update (body) on public.review_comments to authenticated;
grant select, insert, update, delete on public.review_share_links to authenticated;
grant select, insert on public.review_events to authenticated;

-- ---------------------------------------------------------------- picture storage
-- Private buckets. Only the server (service role) reads and writes them; people get signed links that last a week.
-- Pictures are shrunk to JPEG in the browser before upload.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('review-snapshots', 'review-snapshots', false, 1048576, array['image/jpeg']),
       ('review-attachments', 'review-attachments', false, 2097152, array['image/jpeg'])
on conflict (id) do nothing;
