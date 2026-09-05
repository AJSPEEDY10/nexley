-- ---------------------------------------------------------------------------
-- A second ceiling: the shared account, not just the individual.
--
-- THE GAP THIS CLOSES. 0013 capped each user's calls per day, which stops one
-- person running away with the quota. It does not stop TWO people doing it
-- between them — and the free tier we are spending is per ACCOUNT, not per user
-- (Groq: ~100k tokens/day, roughly 45-50 marking requests). With a per-user cap
-- of 10, five users empty the shared allowance and the sixth gets a failure they
-- did nothing to cause.
--
-- WHY THE TWO LIMITS RETURN DIFFERENT ANSWERS. "You have used your 10 for today"
-- and "everyone's shared allowance is gone" are different facts and deserve
-- different sentences — the second is not the student's fault and telling them
-- it is would be a small lie. So this returns which ceiling was hit, and the app
-- can say the true thing.
--
-- CONCURRENCY. Both rows are created if missing and then locked FOR UPDATE
-- before either is read, so two requests arriving together cannot both see room
-- and both proceed. The locks are taken in a fixed order (account, then user)
-- because taking them in different orders in different code paths is how
-- deadlocks are made.
-- ---------------------------------------------------------------------------

create table if not exists public.ai_usage_total (
  day    date primary key,
  calls  integer not null default 0 check (calls >= 0)
);

alter table public.ai_usage_total enable row level security;
-- no policies, no grants: service role only, same as ai_usage.

-- The old two-argument version is replaced rather than kept, so there is no way
-- to call the one that ignores the account ceiling.
drop function if exists public.ai_usage_take(uuid, integer);

create or replace function public.ai_usage_take(
  p_user         uuid,
  p_limit        integer,
  p_global_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d date := (now() at time zone 'utc')::date;
  g integer;
  u integer;
begin
  -- make sure both rows exist, then lock them in a fixed order
  insert into public.ai_usage_total (day, calls) values (d, 0)
    on conflict (day) do nothing;
  insert into public.ai_usage (user_id, day, calls) values (p_user, d, 0)
    on conflict (user_id, day) do nothing;

  select calls into g from public.ai_usage_total
    where day = d for update;
  select calls into u from public.ai_usage
    where user_id = p_user and day = d for update;

  -- the personal ceiling first: it is the common case and the one the student
  -- can actually do something about (come back tomorrow, or use them on the
  -- questions that matter)
  if u >= p_limit then
    return jsonb_build_object('ok', false, 'reason', 'user',
                              'used', u, 'limit', p_limit);
  end if;

  if g >= p_global_limit then
    return jsonb_build_object('ok', false, 'reason', 'account',
                              'used', g, 'limit', p_global_limit);
  end if;

  update public.ai_usage_total set calls = calls + 1 where day = d;
  update public.ai_usage set calls = calls + 1 where user_id = p_user and day = d;

  return jsonb_build_object('ok', true, 'used', u + 1, 'limit', p_limit,
                            'account_used', g + 1, 'account_limit', p_global_limit);
end;
$$;

-- Same shape as 0014: revoke from everyone, then grant explicitly to the one
-- role that is supposed to call it. A signed-in student must not be able to
-- execute the function that decides their own ceiling.
revoke all on function public.ai_usage_take(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.ai_usage_take(uuid, integer, integer) to service_role;
