-- subjects need a short code (e.g. "GEN", "MATH") to match the local schema — missed in 0001.
alter table public.subjects add column code text;
