-- Claude connection (MCP). Each member can have one connection key. Only its SHA-256 hash is stored; the key itself is shown
-- once in the app. Only the server (service role) reads this table.
create table if not exists public.mcp_keys (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  key_hash   text not null unique check (length(key_hash) = 64),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.mcp_keys enable row level security;
revoke all on public.mcp_keys from anon, authenticated;
