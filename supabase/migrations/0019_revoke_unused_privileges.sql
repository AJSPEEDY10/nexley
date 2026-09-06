-- ---------------------------------------------------------------------------
-- Take back three privileges nothing in Nexley has ever used.
--
-- FOUND while verifying 0016-0018 on dev, by listing role_table_grants rather
-- than trusting that "grant insert, select, update" was the whole story. It is
-- not: Supabase's default privileges hand every role a set of extras on any
-- new table in `public`, so every table in this database — including `notes`,
-- which holds the actual study notes — currently reads:
--
--   anon           REFERENCES, TRIGGER, TRUNCATE
--   authenticated  INSERT, SELECT, UPDATE, REFERENCES, TRIGGER, TRUNCATE
--
-- TRUNCATE is the one that matters, because **TRUNCATE is not subject to row
-- level security**. Every protection in this schema is written as an RLS
-- policy, and a policy has nothing to say about a statement that removes every
-- row in the table. DELETE is safe here — RLS applies to it, and no table has
-- a delete policy — but TRUNCATE walks straight past all of it.
--
-- HOW BAD IS IT, HONESTLY. Not very, today: the anon key reaches PostgREST,
-- and PostgREST does not expose TRUNCATE. There is no known path from an
-- API key to this privilege. It is a loaded gun in a locked room rather than
-- an open door, and it has been true of every table since 0001.
--
-- That is still the wrong shape. The privilege is not used by anything, cannot
-- be used correctly by anything, and its only possible effect is to make some
-- future mistake — a new RPC, an exposed schema, a misconfigured role —
-- unrecoverable instead of survivable. REFERENCES and TRIGGER go with it for
-- the same reason: nothing needs them, and a client role that can attach a
-- trigger to a table is a client role that can run code on every write to it.
--
-- Deliberately does NOT touch postgres or service_role, which are the roles
-- that legitimately administer these tables.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  tables text[] := array[
    'profiles', 'subjects', 'notes', 'syllabus', 'cards', 'papers',
    'commitments', 'events', 'feedback', 'bug_reports', 'ai_usage',
    'note_shares', 'comps', 'comp_entries'
  ];
begin
  foreach t in array tables loop
    -- to_regclass returns null rather than raising for a table that is not
    -- there, so this file stays runnable against a database that is missing
    -- one of them (dev and prod have drifted before).
    if to_regclass('public.' || t) is not null then
      execute format('revoke truncate, references, trigger on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

-- And stop the defaults handing them out again on the NEXT table somebody
-- creates. This only affects objects created by the role that runs it, which
-- for a dashboard migration is the same role that creates the tables.
alter default privileges in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;
