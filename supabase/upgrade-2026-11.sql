-- Only for a database created from the first OpenMarkup schema (October 2026). New installs: run schema.sql only.
-- Adds pictures (click screenshots and attachments) and removes the proxy, which OpenMarkup no longer uses.
alter table public.review_threads add column if not exists snapshot_path text;
alter table public.review_comments add column if not exists attachments text[] not null default '{}';
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('review-snapshots', 'review-snapshots', false, 1048576, array['image/jpeg']),
       ('review-attachments', 'review-attachments', false, 2097152, array['image/jpeg'])
on conflict (id) do nothing;
drop function if exists public.resolve_review_target(text);
create or replace function private.reviews_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.id <> old.id or new.created_by <> old.created_by or new.created_at <> old.created_at) then
    raise exception 'A review''s author cannot change' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;
alter table public.reviews drop column if exists proxy_token, drop column if exists proxy_enabled, drop column if exists load_mode;
