-- Preserve reviewed canonical functions and modify only their blocking predicate.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $rewrite$
DECLARE fn regprocedure; definition text; rewritten text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.assignment_collision_project()'::regprocedure,
    'public.assignment_collision_sync_parent_state()'::regprocedure,
    'public.assignment_collision_consistency_check()'::regprocedure
  ] LOOP
    SELECT pg_get_functiondef(fn) INTO definition;
    rewritten := replace(definition, 'IN (''pending'',''confirmed'') AND', 'IN (''pending'',''confirmed'',''arrived'',''in_service'') AND');
    IF rewritten = definition THEN RAISE EXCEPTION 'blocking predicate not found in %',fn; END IF;
    EXECUTE rewritten;
  END LOOP;
END $rewrite$;
COMMIT;
