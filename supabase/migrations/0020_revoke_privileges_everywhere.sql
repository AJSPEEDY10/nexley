-- ---------------------------------------------------------------------------
-- Finish what 0019 started, without a hand-written list.
--
-- 0019 named its tables in an array. Verifying it against prod found one it
-- had missed — `ai_usage_total` — because that name is not in the array and a
-- human wrote the array. The lesson is not "add ai_usage_total"; it is that a
-- hardcoded list of every table in the database is a thing that goes stale the
-- next time somebody adds a table.
--
-- So this walks pg_class instead and revokes from everything in `public`,
-- tables and views alike. It is idempotent and safe to re-run: revoking a
-- privilege that is not held is not an error.
--
-- Why these three, again: TRUNCATE is not subject to row level security, so
-- it walks past every protection this schema has. REFERENCES and TRIGGER are
-- unused, and a client role that can attach a trigger to a table can run code
-- on every write to it.
--
-- postgres and service_role are deliberately untouched — they are the roles
-- that legitimately administer these objects.
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm')   -- table, partitioned, view, matview
  loop
    execute format(
      'revoke truncate, references, trigger on public.%I from anon, authenticated',
      r.relname
    );
  end loop;
end $$;

-- 0019 already reset the default privileges for tables created by the role
-- that ran it. Repeated here so a database that skipped 0019 still gets it.
alter default privileges in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;
