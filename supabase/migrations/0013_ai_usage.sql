-- ---------------------------------------------------------------------------
-- ai_usage: the cost ceiling, and the only thing standing between a bug and a
-- bill.
--
-- WHY THIS IS A TABLE AND NOT A COUNTER IN THE FUNCTION
-- An edge function is stateless and horizontally scaled; a variable inside it
-- resets on every cold start and is not shared between instances. A limit that
-- can be reset by a redeploy is not a limit. So the count lives here, and the
-- function reads and writes it with the service role.
--
-- THE CLIENT IS GRANTED NOTHING ON THIS TABLE. Not select, not insert. RLS is
-- on with no policies at all, which denies everything by default to anon and
-- authenticated. If a student could read their own row they could not do much
-- with it, but if they could WRITE it the ceiling would be theirs to raise, and
-- the whole point is that it is not. The function tells the app how many calls
-- are left in its response; that is the read path.
--
-- One row per user per day. The day is UTC on purpose: the function runs in UTC,
-- and a limit that rolls over at a time the server does not agree with produces
-- an off-by-one-day argument nobody can debug from the outside.
-- ---------------------------------------------------------------------------

create table public.ai_usage (
  user_id  uuid not null references auth.users(id) on delete cascade,
  day      date not null,
  calls    integer not null default 0 check (calls >= 0),
  primary key (user_id, day)
);

alter table public.ai_usage enable row level security;
-- deliberately no policies and no grants: service role only.

-- Atomic increment that also enforces the ceiling, so two requests arriving
-- together cannot both read "19 used" and both proceed. Returns the new count,
-- or null when the caller is already at the limit.
create or replace function public.ai_usage_take(p_user uuid, p_limit integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  insert into public.ai_usage (user_id, day, calls)
  values (p_user, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update
    set calls = public.ai_usage.calls + 1
    where public.ai_usage.calls < p_limit
  returning calls into n;

  -- no row returned means the WHERE on the conflict path refused it: at the cap
  return n;
end;
$$;

revoke all on function public.ai_usage_take(uuid, integer) from public, anon, authenticated;
