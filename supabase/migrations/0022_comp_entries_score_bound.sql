-- ---------------------------------------------------------------------------
-- comp_entries.score had no upper bound, and it should have had one.
--
-- FOUND while going through the RLS audit from the IG-reel research
-- (GROWTH_AND_LAUNCH.md §11 — "Supabase RLS controls which ROWS, not which
-- COLUMNS"). comp_entries_update_own (0018) correctly restricts a student to
-- their own row. It says nothing about the score column inside it, and
-- submitScore() in app/social.js writes a raw client-supplied number with
-- only the table's own `score >= 0` check behind it — no ceiling tied to the
-- comp it belongs to.
--
-- HOW THIS DIFFERS FROM THE ai_usage CASE THAT PROMPTED THE AUDIT.
-- ai_usage guards real money spent per request; getting it wrong is a bill.
-- A comp score guards nothing financial, and comps are self-marked by
-- design — "marked by each participant against their own copy" (0018) — so a
-- dishonest student could already misreport a mark through the ordinary UI by
-- lying at the marking step. This migration does not, and cannot, fix that;
-- self-marking without an answer key has no schema-level solution.
--
-- WHAT IT DOES FIX: an api-level write, or a client bug, that puts a score
-- with no relationship to the comp's own out_of in front of the other
-- participants — 4 friends compare results, and one shows "47/20" because of
-- a stray devtools call or a marking-math bug, not dishonesty at the
-- question level. That is a correctness bound, not an anti-cheat measure,
-- and it is worth having regardless of which one it turns out to be.
--
-- WHY A TRIGGER, NOT A CHECK CONSTRAINT.
-- A plain `check` cannot reference another table's column — out_of lives on
-- comps, score lives on comp_entries. A BEFORE INSERT OR UPDATE trigger is
-- the standard way to enforce a cross-table invariant in Postgres.
--
-- WHY SECURITY DEFINER. The trigger fires under whichever role performs the
-- write, and comps_select_member (0018) already lets any comp member read
-- the comp's out_of — so invoker rights would work here too. Definer rights
-- are used anyway to match this schema's existing pattern for enforcement
-- logic (join_comp, claim_username) rather than depending on the caller
-- happening to have read access for reasons unrelated to this check.
-- ---------------------------------------------------------------------------

create or replace function public.comp_entries_bound_score()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_out_of numeric;
begin
  if new.score is null then
    return new;
  end if;

  select out_of into v_out_of from public.comps where id = new.comp_id;

  -- A comp that no longer exists is a foreign-key violation elsewhere, not a
  -- thing this trigger needs to handle — but null-safety costs nothing here.
  if v_out_of is not null and new.score > v_out_of then
    raise exception 'score cannot exceed the comp''s out_of (%)', v_out_of;
  end if;

  return new;
end;
$$;

create trigger comp_entries_bound_score
  before insert or update on public.comp_entries
  for each row execute procedure public.comp_entries_bound_score();
