-- Phase 5 hardening: immutable projection trigger does not need a mutable search_path.
create or replace function public.bridge_projection_snapshot_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'projection snapshot artifact rows are immutable (% blocked)', tg_op;
end
$$;
